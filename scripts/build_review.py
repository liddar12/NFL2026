#!/usr/bin/env python3
"""Post-game review -> data/review.json (R71).

For every week that has a point-in-time game lock file or a resolved player-week,
the review says WHAT the model predicted, WHAT happened, and — measured from the
model's own inputs and the actual stat line — WHY. Nothing here is a model call.

PROVENANCE (same contract as scripts/ai_estimates.py and data/ai_insights.json):
every `why` block carries source "measured" — a deterministic attribution over
committed inputs (the lock receipts, the calibrated week band, the season stat
components the weekly split was built from, the injury report, the forecast) and
the realized stat line. Re-running over identical inputs is byte-identical. The
product runtime never contacts an LLM (P10). The ONLY exception is the optional,
display-only `narrative` a separate opt-in runner step attaches
(scripts/build_review_narrative.py) — labeled AI NARRATIVE, restating the measured
facts and nothing else; the measured `why` stays the source of truth and renders
without it.

HONESTY RULES
  * Absent is null, never 0. A game without a FINAL is result null; a player
    without an actual row has no row at all; a leg nobody graded is "pending".
  * STATUS-GATED: a game produces a result only when (a) an ESPN row with a FINAL
    status (scripts.scrape.espn.FINAL_STATUSES) carries its score, or (b) the lock
    file holds a graded receipt (`resolved` + `actual`), which scripts/resolve_locks
    only writes for a FINAL game. Live / halftime / 0-0 scheduled stubs never grade.
  * The PREDICTED team is the lock's own probs (as-made, immutable) — never the
    live probs in game_predictions.json.
  * Player verdict (owner decision): MET when actual is inside the calibrated
    week band [low, high]; OVER when actual > high; UNDER when actual < low; DNP
    when the resolver flagged the row dnp (actual then reported null, never 0).
  * Where an expectation cannot be derived from committed data the factor is
    omitted and `notes` says so — never guessed.

WHAT THE PLAYER `why` MEASURES (top factors by |PPR points|):
  expected week components = the player's season stat components
  (player_weekly.json league_components + receptions_prior, the inputs the
  weekly split was built from) x (locked shipped estimate / season projection).
  Against the nflverse stat line:
    touchdowns   4 x (pass TD - exp) + 6 x (rush TD - exp) + 6 x (rec TD - exp)
    volume       (attempts - exp) x expected yardage pts per attempt, per unit
                 (pass attempts / carries / targets)
    efficiency   attempts x (actual pts per attempt - expected pts per attempt)
    turnovers    -2 x (INT - exp) - 2 x (fumbles lost - exp)
    two_point    2 x (2-pt conversions - exp)
    model_factor what the weekly split applied for this week vs an even split
                 (DvP x tilt x weather x venue combined — player_weekly.json does
                 not store the per-factor split, so it is reported combined)
    availability the injury-report status (injuries.json) / DNP
    game_script  the final margin when a score is known (context, no points)
  volume + efficiency is an exact decomposition of the yardage/reception delta;
  the remainder (actual - shipped - the shown numeric factors) is `unattributed`,
  so the reasons a reader sees always reconcile to the delta.

R72 (owner decisions, final) — the same document also carries:
  * picks RIGHT / WRONG / TBD per week (`summary.picks.right|wrong|tbd`), and a
    week block for EVERY week up to the pipeline week (review_weeks), even when
    nothing is FINAL: games then carry result null and picks n=0 / tbd=<count>.
  * five parlay outcome buckets (parlay_bucket): pending, push, all_hit,
    all_missed, partial — `bucket` on every parlay row, counted in
    `summary.parlays.buckets`; `result` stays hit/miss/pending/void and the two
    agree (hit<->all_hit, void<->push, miss<->partial|all_missed).
  * a season tally per player (`players_season`) over every week block.
  * PROOF of the self-learning loop from committed data (`summary.learning` per
    week, top-level `learning`): the graded lock receipts refit consumes
    (graded_lock_rows, the exact rule of scripts/refit._collect_resolved_rows)
    against the newest in-season refit pass archived in model_tuning.json
    (newest_refit, the exact rule of app/views/model.js resolvedLockCount). Never
    a claim the archive does not show.

R73 (owner decision 3) — `summary.parlays.stake_100`, a DISPLAY-ONLY $100
flat-stake P&L per scope ({week, game}), computed here from the as-made leg
prices of the R58 ledger (data/estimates/parlays_<season>.json, the row keyed
(week, game_id, market, selection)) and the graded buckets:
  * every parlay of the scope in the week is staked $100; a pending parlay is
    excluded from staked/net and counted in n only;
  * all_hit pays 100 x (product of leg decimals - 1); push pays the same with
    the pushed legs dropped out at 1.0; partial / all_missed lose 100;
  * leg decimal = 1 / implied_prob of the ledger row (moneyline / spread — the
    only legs that ever carry a book price); a prop leg, or a game leg with no
    ledger row, is priced at 1.9091 (-110), counted in assumed_price_legs and
    stated in the note;
  * net_vig2 re-prices every leg at implied_prob x 1.02 capped at 0.99;
  * money is never a model input: nothing downstream reads it.

R75 — the same money, per parlay, on every parlay row (`money`), so the PARLAYS
card can show what a $100 wager did or would do without pricing anything itself:
  * a GRADED parlay carries kind "settled": exactly its contribution to the
    footer above. Both come from parlay_money, and the selftest asserts that the
    settled rows of a scope sum to summary.parlays.stake_100[scope] — the card
    and the week footer can never disagree, because there is one arithmetic.
  * a PENDING parlay carries kind "potential": 100 x (product of ALL leg
    decimals - 1), what the stake would return if every leg hit. It is a price,
    not a result, quoted at one price only (net_vig2 null), and the card labels
    it so. A pending parlay is still never staked in the footer.
  * same leg-decimal rule, same -110 assumption, counted per parlay.

Pure core (no I/O): review_game, review_player, review_parlay, parlay_bucket,
leg_outcomes_from_ledger, ledger_price_index, leg_decimal, parlay_money,
potential_return, stamp_parlay_money, stake_100,
summarize, review_weeks, learning_block, players_season, build.
Thin shell: load_inputs + main.
  python3 scripts/build_review.py --selftest   fixture-driven, never writes data/
  python3 scripts/build_review.py --offline    committed inputs only (no network)
  python3 scripts/build_review.py              runner: ESPN finals + nflverse stats
"""

import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_parlay_archive import card_id as parlay_card_id  # noqa: E402
from scripts.harness import metrics  # noqa: E402
from scripts.resolve_estimates import norm_name  # noqa: E402
from scripts.scrape.espn import FINAL_STATUSES  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "review.json")
SNAPSHOT_DIR = os.path.join(DATA, "snapshots")
LOCK_GLOB = os.path.join(SNAPSHOT_DIR, "*_games_open.json")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
FIXTURE_DIR = os.path.join(_ROOT, "tests", "fixtures", "r71")
FIXTURE_DIR_R72 = os.path.join(_ROOT, "tests", "fixtures", "r72")
FIXTURE_DIR_R73 = os.path.join(_ROOT, "tests", "fixtures", "r73")

PARLAY_BUCKETS = ("all_hit", "push", "partial", "all_missed", "pending")
# result <-> bucket consistency (owner decision 3), locked by the selftest.
BUCKET_OF_RESULT = {"hit": ("all_hit",), "void": ("push",),
                    "miss": ("partial", "all_missed"), "pending": ("pending",)}

PROP_MARKETS = frozenset(["qb_pass_yds", "rb_rush_yds", "wr_rec_yds"])
GAME_MARKETS = frozenset(["moneyline", "spread"])
# R73 stake_100 (display-only money): flat stake, the -110 decimal a leg with no
# book price is assumed at, and the vig re-pricing of the net_vig2 column.
STAKE = 100.0
ASSUMED_DECIMAL = 1.9091
VIG2_FACTOR = 1.02
VIG2_CAP = 0.99
POSITIONS = ("QB", "RB", "WR", "TE")
_POS_ALIAS = {"FB": "RB", "HB": "RB"}
BLOWOUT_MARGIN = 17          # >= 17 points (three scores) is reported as a blowout
MAX_NUMERIC_REASONS = 3      # the "top 1-3 contributing factors"
VOID_REASONS = frozenset(["push", "tie"])

# PPR scoring the stat line and the expectations share (matches resolve_estimates).
PTS = {"pass_yd": 0.04, "pass_td": 4.0, "pass_int": -2.0, "pass_2pt": 2.0,
       "rush_yd": 0.1, "rush_td": 6.0, "rush_2pt": 2.0,
       "rec": 1.0, "rec_yd": 0.1, "rec_td": 6.0, "rec_2pt": 2.0, "fum_lost": -2.0}


def _r(v, nd=2):
    return None if v is None else round(float(v), nd)


def _num(row, *keys):
    """First present numeric column among `keys` (nflverse spellings vary); 0.0
    when every candidate is blank. Returns None only when NO key exists at all."""
    seen = False
    for k in keys:
        if k in row:
            seen = True
            v = row.get(k)
            if v in (None, "", "NA"):
                continue
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return 0.0 if seen else None


def why_hash(why):
    """Stable digest of a measured why — the narrative layer keys on it so a
    narrative is carried forward only while the facts it restates are unchanged."""
    blob = json.dumps(why, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# finals + locks                                                                #
# --------------------------------------------------------------------------- #

def finals_index(rows):
    """{game_id: {home_score, away_score, status}} — STATUS-GATED. A row counts
    only with a FINAL status (or espn's `final: True` flag) AND both scores."""
    out = {}
    for r in rows or []:
        status = r.get("status")
        is_final = status in FINAL_STATUSES or r.get("final") is True
        hs, as_ = r.get("home_score"), r.get("away_score")
        if not is_final or hs is None or as_ is None:
            continue
        out[str(r.get("game_id"))] = {"home_score": int(hs), "away_score": int(as_),
                                      "status": status or "STATUS_FINAL"}
    return out


def lock_index(lock_rows):
    """{event_id: lock row} for game rows carrying a 2-way probs vector."""
    out = {}
    for row in lock_rows or []:
        if row.get("event_type") != "game":
            continue
        probs = row.get("probs")
        if not isinstance(probs, list) or len(probs) != 2:
            continue
        out[str(row.get("event_id"))] = row
    return out


def week_of_lock_file(path):
    """2026_wk01_games_open.json -> (2026, 1); None when the name does not parse."""
    base = os.path.basename(path)
    parts = base.split("_")
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].startswith("wk") \
            and parts[1][2:].isdigit():
        return int(parts[0]), int(parts[1][2:])
    return None


# --------------------------------------------------------------------------- #
# games                                                                         #
# --------------------------------------------------------------------------- #

def _forecast_for(forecast_doc, season, week, home, away):
    games = (forecast_doc or {}).get("games") or {}
    for key in ("%s|%s|%s|%s" % (season, week, home, away),
                "%s|%s|%s|%s" % (season, week, away, home)):
        if key in games:
            return games[key]
    return None


def _qb1_status(team, qb1_by_team, injury_by_key):
    """{name, status, availability} for the team's QB1 (highest season projection).
    status None when the injury report carries no row for him — "no report row",
    which is NOT the same fact as "healthy"."""
    qb = (qb1_by_team or {}).get(team)
    if not qb:
        return None
    inj = (injury_by_key or {}).get((team, norm_name(qb["name"])))
    return {"name": qb["name"], "status": inj.get("status") if inj else None,
            "availability": inj.get("availability") if inj else None}


def review_game(game, lock, final, qb1_by_team=None, injury_by_key=None,
                forecast=None, injuries_as_of=None):
    """One review row for a scheduled game. Pure.

    `lock` is the as-made lock row (probs [home, away]); `final` is the gated
    finals_index entry, or None. A lock receipt (`resolved` + `actual`) also
    counts as FINAL evidence — resolve_locks writes it only for a FINAL game —
    but then the score is unknown (null), only the winner.
    """
    home, away = game.get("home"), game.get("away")
    row = {"game_id": str(game.get("game_id")), "home": home, "away": away,
           "kickoff_utc": game.get("kickoff_utc"), "picked": None, "pick_prob": None,
           "final": None, "status": game.get("status"), "final_source": None,
           "result": None, "brier": None, "why": None}
    if lock is None:
        row["why"] = {"source": "measured", "summary": "no pre-kickoff lock for this game",
                      "reasons": []}
        return row
    p_home, p_away = float(lock["probs"][0]), float(lock["probs"][1])
    picked_idx = 0 if p_home >= p_away else 1
    picked = home if picked_idx == 0 else away
    pick_prob = p_home if picked_idx == 0 else p_away
    row["picked"] = picked
    row["pick_prob"] = _r(pick_prob, 4)

    winner = None
    if final is not None:
        hs, as_ = final["home_score"], final["away_score"]
        row["final"] = {"home_score": hs, "away_score": as_,
                        "winner": home if hs > as_ else (away if as_ > hs else None)}
        row["status"] = final.get("status") or "STATUS_FINAL"
        row["final_source"] = "espn_final"
        winner = row["final"]["winner"]
    elif lock.get("resolved") and lock.get("actual") in (0, 1):
        winner = home if lock["actual"] == 0 else away
        row["final"] = {"home_score": None, "away_score": None, "winner": winner}
        row["status"] = "STATUS_FINAL"
        row["final_source"] = "lock_receipt"

    reasons = [{"factor": "confidence", "points": None,
                "text": "picked %s at %d%% (lock %s, model %s%s)" % (
                    picked, round(pick_prob * 100), lock.get("locked_utc"),
                    lock.get("model"), ", estimate" if lock.get("estimate") else "")}]
    if row["final"] is None:
        row["why"] = {"source": "measured", "summary": "not final — no result yet",
                      "reasons": reasons}
        return row
    if winner is None:
        # a tie: a 2-way vector has no tie index; graded by nobody, honestly
        row["why"] = {"source": "measured", "summary": "tie — ungradable against a 2-way pick",
                      "reasons": reasons}
        return row
    row["result"] = "won" if winner == picked else "lost"
    actual_idx = 0 if winner == home else 1
    brier = lock.get("brier")
    if not isinstance(brier, (int, float)):
        brier = metrics.brier(actual_idx, [p_home, p_away])
    row["brier"] = _r(brier, 4)

    if row["final"]["home_score"] is not None:
        margin = row["final"]["home_score"] - row["final"]["away_score"]
        blow = abs(margin) >= BLOWOUT_MARGIN
        reasons.append({"factor": "margin", "points": None,
                        "text": "%s won %d-%d (home margin %+d%s)" % (
                            winner, row["final"]["home_score"], row["final"]["away_score"],
                            margin, ", blowout" if blow else "")})
    else:
        reasons.append({"factor": "margin", "points": None,
                        "text": "%s won (lock receipt; score not on file)" % winner})
    if qb1_by_team:
        for side, team in (("home", home), ("away", away)):
            q = _qb1_status(team, qb1_by_team, injury_by_key)
            if q is None:
                continue
            st = q["status"] if q["status"] else "no injury-report row"
            reasons.append({"factor": "qb1_%s" % side, "points": None,
                            "text": "%s QB1 %s: %s (injuries.json as of %s)" % (
                                team, q["name"], st, injuries_as_of or "n/a")})
    roof = game.get("roof")
    if forecast is not None:
        reasons.append({"factor": "venue_weather", "points": None,
                        "text": "roof %s; forecast %s C, wind %s kph, precip %s mm" % (
                            roof, forecast.get("temp_c"), forecast.get("wind_kph"),
                            forecast.get("precip_mm"))})
    elif roof:
        reasons.append({"factor": "venue_weather", "points": None,
                        "text": "roof %s; no forecast row on file" % roof})
    row["why"] = {"source": "measured",
                  "summary": "%s: picked %s at %d%%, %s won" % (
                      row["result"].upper(), picked, round(pick_prob * 100), winner),
                  "reasons": reasons}
    return row


# --------------------------------------------------------------------------- #
# players                                                                       #
# --------------------------------------------------------------------------- #

def verdict_for(actual, low, high, dnp=False):
    """Owner decision 2: MET inside [low, high] (inclusive), OVER above, UNDER below,
    DNP when there is no played row."""
    if dnp or actual is None:
        return "dnp"
    if actual > high:
        return "over"
    if actual < low:
        return "under"
    return "met"


def index_stats(csv_rows):
    """{(norm_name, position): {week: row}} + {norm_name: set(positions)} — REG only,
    QB/RB/WR/TE only; the same join rule scripts/resolve_estimates.py uses."""
    by_np, names = {}, {}
    for r in csv_rows or []:
        if (r.get("season_type") or "REG") != "REG":
            continue
        try:
            wk = int(float(r.get("week") or 0))
        except ValueError:
            continue
        pos = (r.get("position") or "").upper()
        pos = _POS_ALIAS.get(pos, pos)
        if pos not in POSITIONS or wk < 1:
            continue
        n = norm_name(r.get("player_display_name") or r.get("player_name"))
        if not n:
            continue
        by_np.setdefault((n, pos), {})[wk] = r
        names.setdefault(n, set()).add(pos)
    return by_np, names


def lookup_stats(name, position, week, by_np, names):
    n = norm_name(name)
    hit = by_np.get((n, position))
    if hit is None:
        poss = names.get(n)
        if poss and len(poss) == 1:
            hit = by_np.get((n, next(iter(poss))))
    return (hit or {}).get(week)


def stat_line(row):
    """Normalized components from one nflverse stats_player_week row."""
    fum = _num(row, "fumbles_lost")
    if fum is None:
        parts = [_num(row, k) for k in ("rushing_fumbles_lost", "receiving_fumbles_lost",
                                        "sack_fumbles_lost")]
        fum = sum(p for p in parts if p is not None) if any(p is not None for p in parts) else 0.0
    two = [_num(row, k) for k in ("passing_2pt_conversions", "rushing_2pt_conversions",
                                  "receiving_2pt_conversions")]
    return {
        "pass_att": _num(row, "attempts", "passing_attempts") or 0.0,
        "pass_yd": _num(row, "passing_yards") or 0.0,
        "pass_td": _num(row, "passing_tds") or 0.0,
        "pass_int": _num(row, "passing_interceptions", "interceptions") or 0.0,
        "rush_att": _num(row, "carries", "rushing_attempts") or 0.0,
        "rush_yd": _num(row, "rushing_yards") or 0.0,
        "rush_td": _num(row, "rushing_tds") or 0.0,
        "rec_tgt": _num(row, "targets") or 0.0,
        "rec": _num(row, "receptions") or 0.0,
        "rec_yd": _num(row, "receiving_yards") or 0.0,
        "rec_td": _num(row, "receiving_tds") or 0.0,
        "fum_lost": fum or 0.0,
        "two_pt": sum(t for t in two if t is not None),
        "ppr": _num(row, "fantasy_points_ppr"),
    }


def expected_components(weekly, shipped):
    """The model's own week expectation per stat: season components x share, share =
    locked shipped week estimate / season projection (base_applied_pts +
    receptions_prior — receptions are carried outside the league components).
    None when the committed record has no components for this player."""
    comps = (weekly or {}).get("league_components") or {}
    base = (weekly or {}).get("base_applied_pts")
    if not comps or base is None:
        return None
    rec_prior = float((weekly or {}).get("receptions_prior") or 0.0)
    season = float(base) + rec_prior
    if season <= 0 or shipped is None:
        return None
    share = float(shipped) / season
    exp = {k: float(v) * share for k, v in comps.items()}
    exp["rec"] = rec_prior * share
    exp["two_pt"] = sum(exp.pop(k, 0.0) for k in ("pass_2pt", "rush_2pt", "rec_2pt"))
    for k in ("pass_att", "pass_yd", "pass_td", "pass_int", "rush_att", "rush_yd", "rush_td",
              "rec_tgt", "rec_yd", "rec_td", "fum_lost"):
        exp.setdefault(k, 0.0)
    exp["_share"] = share
    return exp


def _fmt(v, nd=1):
    v = float(v)
    return ("%d" % v) if abs(v - round(v)) < 1e-9 else ("%.*f" % (nd, v))


def stat_reasons(act, exp):
    """The measured stat-line attribution (touchdowns / volume / efficiency /
    turnovers / two_point) with the numbers in every line. Pure arithmetic."""
    out = []
    # touchdowns
    td_pts, td_txt = 0.0, []
    for k, w, label in (("pass_td", 4.0, "passing"), ("rush_td", 6.0, "rushing"),
                        ("rec_td", 6.0, "receiving")):
        d = (act[k] - exp[k]) * w
        if abs(d) >= 0.05 or act[k] > 0:
            td_pts += d
            td_txt.append("%s %s TD vs %.1f expected (%+.1f)" % (
                _fmt(act[k]), label, exp[k], d))
    if td_txt:
        out.append({"factor": "touchdowns", "points": _r(td_pts),
                    "text": "; ".join(td_txt)})
    # volume + efficiency, per unit, exact decomposition of the yardage/rec points
    vol_pts, eff_pts, vol_txt, eff_txt = 0.0, 0.0, [], []
    units = (("pass_att", "pass attempts", "attempt", lambda c: c["pass_yd"] * PTS["pass_yd"]),
             ("rush_att", "carries", "carry", lambda c: c["rush_yd"] * PTS["rush_yd"]),
             ("rec_tgt", "targets", "target",
              lambda c: c["rec"] * PTS["rec"] + c["rec_yd"] * PTS["rec_yd"]))
    for key, label, unit, ptsfn in units:
        e_n, a_n = exp[key], act[key]
        if e_n <= 0 and a_n <= 0:
            continue
        e_rate = ptsfn(exp) / e_n if e_n > 0 else None
        a_rate = ptsfn(act) / a_n if a_n > 0 else 0.0
        if e_rate is None:
            # no usage expectation for this unit: the whole thing is efficiency-less volume
            v = ptsfn(act)
            vol_pts += v
            vol_txt.append("%s %s vs none expected (%+.1f)" % (_fmt(a_n), label, v))
            continue
        v = (a_n - e_n) * e_rate
        e = a_n * (a_rate - e_rate)
        vol_pts += v
        eff_pts += e
        vol_txt.append("%s %s vs %.1f expected (%+.1f)" % (_fmt(a_n), label, e_n, v))
        eff_txt.append("%.2f vs %.2f pts per %s (%+.1f)" % (a_rate, e_rate, unit, e))
    if vol_txt:
        out.append({"factor": "volume", "points": _r(vol_pts), "text": "; ".join(vol_txt)})
    if eff_txt:
        out.append({"factor": "efficiency", "points": _r(eff_pts), "text": "; ".join(eff_txt)})
    # turnovers
    to = (act["pass_int"] - exp["pass_int"]) * PTS["pass_int"] \
        + (act["fum_lost"] - exp["fum_lost"]) * PTS["fum_lost"]
    if abs(to) >= 0.05 or act["pass_int"] > 0 or act["fum_lost"] > 0:
        out.append({"factor": "turnovers", "points": _r(to),
                    "text": "%s INT vs %.1f expected, %s fumbles lost vs %.1f expected (%+.1f)" % (
                        _fmt(act["pass_int"]), exp["pass_int"], _fmt(act["fum_lost"]),
                        exp["fum_lost"], to)})
    two = (act["two_pt"] - exp["two_pt"]) * 2.0
    if abs(two) >= 0.05:
        out.append({"factor": "two_point", "points": _r(two),
                    "text": "%s two-point conversions vs %.1f expected (%+.1f)" % (
                        _fmt(act["two_pt"]), exp["two_pt"], two)})
    return out


def model_factor_reason(weekly, week):
    """What the weekly split applied for this week vs an even split of the
    playable weeks — the combined DvP x tilt x weather x venue effect."""
    weeks = (weekly or {}).get("weeks") or []
    playable = [w for w in weeks if not w.get("bye") and w.get("avail") is not False
                and float(w.get("pts") or 0.0) > 0]
    row = next((w for w in weeks if int(w.get("wk", -1)) == int(week)), None)
    if row is None or not playable:
        return None
    total = sum(float(w["pts"]) for w in playable)
    even = total / len(playable)
    if even <= 0:
        return None
    pts = float(row.get("pts") or 0.0)
    factor = pts / even
    delta = pts - even
    where = ("home" if row.get("home") else "away")
    return {"factor": "model_factor", "points": _r(delta),
            "text": "weekly split applied x%.2f for wk %d (opp %s, %s): %+.1f pts vs an even "
                    "split — DvP, Elo tilt, weather and venue combined (per-factor split "
                    "not stored in player_weekly.json)" % (
                        factor, int(week), row.get("opp"), where, delta),
            "factor_value": _r(factor, 3)}


def review_player(score_row, identity, weekly=None, stats_row=None, injury=None,
                  game_final=None, injuries_as_of=None, stats_available=False):
    """One player row from an estimate_scores `resolved` row. Pure.

    `identity` = {name, team, position}; `weekly` = the player's player_weekly.json
    record; `stats_row` = his nflverse stat line for the week (None when absent or
    not fetched); `injury` = his injuries.json row; `game_final` = the finals_index
    entry for his team's game (context only).
    """
    wk = int(score_row["week"])
    dnp = bool(score_row.get("dnp"))
    actual = None if dnp else float(score_row["actual"])
    shipped = float(score_row["shipped"])
    low, high = float(score_row["low"]), float(score_row["high"])
    verdict = verdict_for(actual, low, high, dnp)
    delta = None if actual is None else _r(actual - shipped)
    row = {"gsis_id": score_row["gsis_id"], "name": identity.get("name"),
           "position": score_row.get("position") or identity.get("position"),
           "team": identity.get("team"), "week": wk, "projected": _r(shipped),
           "low": _r(low), "high": _r(high), "actual": _r(actual), "verdict": verdict,
           "delta": delta}
    reasons, omitted = [], []
    exp = expected_components(weekly, shipped)
    if verdict == "dnp":
        reasons.append({"factor": "availability", "points": _r(-shipped),
                        "text": "did not play: the whole %.1f projection is lost%s" % (
                            shipped, (" (injury report: %s)" % injury["status"]) if injury else "")})
    elif stats_row is not None and exp is not None:
        act = stat_line(stats_row)
        reasons.extend(stat_reasons(act, exp))
        if act["ppr"] is not None and abs(act["ppr"] - actual) > 0.05:
            omitted.append("stat-line PPR %.2f differs from the resolved actual %.2f" % (
                act["ppr"], actual))
    else:
        if stats_row is None:
            omitted.append("stat line %s: touchdowns/volume/efficiency/turnovers omitted" % (
                "not fetched" if not stats_available else "absent for this player-week"))
        if exp is None:
            omitted.append("no season components in player_weekly.json: expectations omitted")
    mf = model_factor_reason(weekly, wk)
    if mf is not None:
        reasons.append(mf)
    else:
        omitted.append("no week row in player_weekly.json: model factor omitted")
    if verdict != "dnp" and injury and str(injury.get("status", "")).lower() != "active":
        reasons.append({"factor": "availability", "points": None,
                        "text": "injury report %s (%s) as of %s" % (
                            injury.get("status"), injury.get("availability"),
                            injuries_as_of or "n/a")})
    if game_final is not None and game_final.get("home_score") is not None:
        m = game_final["home_score"] - game_final["away_score"]
        reasons.append({"factor": "game_script", "points": None,
                        "text": "final %d-%d (home margin %+d%s)" % (
                            game_final["home_score"], game_final["away_score"], m,
                            ", blowout" if abs(m) >= BLOWOUT_MARGIN else "")})
    numeric = [r for r in reasons if r["points"] is not None and r["factor"] != "model_factor"]
    numeric.sort(key=lambda r: -abs(r["points"]))
    context = [r for r in reasons if r["points"] is None or r["factor"] == "model_factor"]
    top = numeric[:MAX_NUMERIC_REASONS] + context
    unattributed = None
    if delta is not None and stats_row is not None and exp is not None:
        # reconciles against the reasons SHOWN: the smallest dropped factors (beyond
        # the top MAX_NUMERIC_REASONS) fold into it, so shown factors + unattributed
        # always equals the delta a reader sees.
        unattributed = _r(delta - sum(r["points"] for r in numeric[:MAX_NUMERIC_REASONS]))
    if verdict == "dnp":
        summary = "DNP: projected %.1f, no played row" % shipped
    else:
        summary = "%s by %.1f (actual %.1f vs %.1f projected, band %.1f-%.1f)" % (
            verdict.upper(), abs(delta), actual, shipped, low, high)
        if numeric:
            summary += "; " + ", ".join("%s %+.1f" % (r["factor"], r["points"]) for r in numeric[:3])
    why = {"source": "measured", "summary": summary, "reasons": top,
           "expected_basis": ("season components x %.4f (shipped / season projection)"
                              % exp["_share"]) if exp else None,
           "unattributed": unattributed, "omitted": omitted}
    row["why"] = why
    return row


# --------------------------------------------------------------------------- #
# parlays                                                                       #
# --------------------------------------------------------------------------- #

def leg_outcomes_from_ledger(scores_doc):
    """THE ONE ADAPTER between partition C's R58 leg ledger and this review.

    Reads data/parlay_leg_scores.json (scripts/resolve_parlay_legs.py):
      resolved[]   {week, game_id, market, selection, ..., actual, hit: bool}
      unresolved[] {week, game_id, market, selection, reason}
                   reason in no_stat_line | ambiguous | player_unidentified |
                   no_final_score | tie | push | no_line | no_model_prob
    -> {(week, game_id, market, selection): {hit: True|False|None, actual, reason}}
    hit None + reason "push"/"tie" is a VOID leg; any other None is PENDING.
    An unresolved leg is never a miss (the resolver's rule, kept here).
    """
    out = {}
    for r in (scores_doc or {}).get("resolved") or []:
        key = (int(r["week"]), str(r["game_id"]), r["market"], r["selection"])
        out[key] = {"hit": bool(r["hit"]), "actual": r.get("actual"), "reason": None}
    for u in (scores_doc or {}).get("unresolved") or []:
        key = (int(u["week"]), str(u["game_id"]), u["market"], u["selection"])
        out.setdefault(key, {"hit": None, "actual": None, "reason": u.get("reason")})
    return out


def _team_of_selection(selection):
    parts = str(selection or "").split()
    return parts[0] if parts else None


def leg_game_id(leg, parlay_game_id, week, ledger_legs, games_by_team):
    """The game a leg belongs to: the parlay's own game, else the ledger entry with
    the same (week, market, selection), else the team named by the selection."""
    if parlay_game_id:
        return str(parlay_game_id)
    hit = (ledger_legs or {}).get((int(week), leg.get("market"), leg.get("selection")))
    if hit:
        return str(hit)
    team = _team_of_selection(leg.get("selection"))
    g = (games_by_team or {}).get(team)
    return str(g["game_id"]) if g else None


def review_parlay(parlay, week, outcomes, ledger_legs=None, games_by_team=None,
                  game_reviews=None):
    """One parlay row. Moneyline legs also grade straight from the game review
    (lock receipts / finals) when the ledger has not resolved them yet; spread and
    prop legs grade only through the ledger adapter."""
    legs_out = []
    for leg in parlay.get("legs") or []:
        gid = leg_game_id(leg, parlay.get("game_id"), week, ledger_legs, games_by_team)
        key = (int(week), gid, leg.get("market"), leg.get("selection"))
        oc = outcomes.get(key) if gid else None
        result, actual, why = "pending", None, None
        if oc is not None and oc["hit"] is not None:
            result, actual = ("hit" if oc["hit"] else "miss"), oc.get("actual")
            why = "ledger: %s" % ("hit" if oc["hit"] else "miss")
        elif oc is not None and oc.get("reason") in VOID_REASONS:
            result, why = "void", "ledger: %s" % oc["reason"]
        elif leg.get("market") == "moneyline" and gid and game_reviews \
                and game_reviews.get(gid) and game_reviews[gid].get("final"):
            fin = game_reviews[gid]["final"]
            team = _team_of_selection(leg.get("selection"))
            if fin.get("winner") is None:
                result, why = "void", "tie"
            else:
                result = "hit" if fin["winner"] == team else "miss"
                actual = fin.get("winner")
                why = "winner %s (%s)" % (fin["winner"], game_reviews[gid].get("final_source"))
        elif oc is not None:
            why = "ledger: %s" % (oc.get("reason") or "unresolved")
        else:
            why = "not in the leg ledger yet" if gid else "game not identified"
        legs_out.append({"selection": leg.get("selection"), "market": leg.get("market"),
                         "game_id": gid, "result": result, "actual": actual, "why": why})
    results = [l["result"] for l in legs_out]
    if not results or "pending" in results:
        pres = "pending"
    elif "miss" in results:
        pres = "miss"
    elif "void" in results:
        pres = "void"        # every leg graded, none missed, a push/tie among them
    else:
        pres = "hit"
    bucket = parlay_bucket(results)
    assert bucket in BUCKET_OF_RESULT[pres], (pres, bucket)
    # G03 — the row carries the card's IDENTITY, not just its rank. parlay_id is
    # rank-derived, so after a post-kickoff rebuild two archived cards can share
    # one (the review counted 17 such pairs in a single week) and every Map built
    # on it applies one bet's grade and money to the other. card_id is the ONE
    # definition, imported from the archive writer rather than re-hashed here, so
    # the row and the archived card meet on the same key; an archive card already
    # stamped keeps its own id.
    return {"parlay_id": parlay.get("parlay_id"),
            "card_id": parlay.get("card_id") or parlay_card_id(parlay),
            "scope": parlay.get("scope"),
            "game_id": str(parlay["game_id"]) if parlay.get("game_id") else None,
            "result": pres, "bucket": bucket, "legs": legs_out}


def ledger_price_index(parlay_ledger):
    """{(week, game_id, market, selection): implied_prob} over the R58 leg ledger
    rows that carry a numeric price in (0, 1) — the as-made price locked on first
    sight. A row without one (the r71 fixture's bare game legs) is not a price."""
    out = {}
    for l in (parlay_ledger or {}).get("legs") or []:
        ip = l.get("implied_prob")
        if isinstance(ip, bool) or not isinstance(ip, (int, float)) or not 0 < ip < 1:
            continue
        out[(int(l["week"]), str(l.get("game_id")), l.get("market"), l.get("selection"))] = float(ip)
    return out


def leg_decimal(leg, week, price_index):
    """(decimal odds, assumed) for one reviewed leg. The book price exists only for
    a moneyline / spread leg with a ledger row; everything else (a prop, a game
    leg the ledger never saw, a leg whose game is unidentified) is assumed at
    -110 = 1.9091 and flagged so the note can say how many were."""
    if leg.get("market") in GAME_MARKETS and leg.get("game_id"):
        ip = price_index.get((int(week), str(leg["game_id"]), leg.get("market"),
                              leg.get("selection")))
        if ip is not None:
            return 1.0 / ip, False
    return ASSUMED_DECIMAL, True


def _vig2(decimal):
    """The same leg re-priced at implied_prob x 1.02, capped at 0.99."""
    return 1.0 / min(VIG2_CAP, (1.0 / decimal) * VIG2_FACTOR)


def parlay_money(parlay, week, price_index):
    """R75 — the $100 flat stake settled on ONE reviewed parlay, or None while it
    is pending (a pending parlay is never staked). Returns raw floats
    (net_fair, net_vig2, assumed_price_legs) under exactly the R73 rule:
      all_hit / push   100 x (prod of the hit legs' decimals - 1); a void leg
                       drops out at 1.0, which is what makes a push a push
      anything else    -100, the stake
    stake_100 below is the sum of this over a scope, so the number on a card and
    the number in the week footer come from one function and cannot disagree —
    the selftest asserts the sum. Display-only money, never a model input."""
    if parlay.get("bucket") == "pending":
        return None
    fair = vig = 1.0
    assumed = 0
    for leg in parlay.get("legs") or []:
        dec, is_assumed = leg_decimal(leg, week, price_index)
        assumed += 1 if is_assumed else 0
        if leg.get("result") == "hit":
            fair *= dec
            vig *= _vig2(dec)
        # a void leg drops out at 1.0; a missed leg is settled below
    if parlay.get("bucket") in ("all_hit", "push"):
        return STAKE * (fair - 1.0), STAKE * (vig - 1.0), assumed
    return -STAKE, -STAKE, assumed


def potential_return(parlay, week, price_index):
    """R75 — what a $100 stake WOULD return if every leg of this parlay hit, at
    the same prices: 100 x (prod of all leg decimals - 1). This is the only
    figure an ungraded parlay can honestly carry — it is a price, not a result,
    and the card labels it so. (net, assumed_price_legs)."""
    dec = 1.0
    assumed = 0
    for leg in parlay.get("legs") or []:
        d, is_assumed = leg_decimal(leg, week, price_index)
        assumed += 1 if is_assumed else 0
        dec *= d
    return STAKE * (dec - 1.0), assumed


def stamp_parlay_money(parlays, week, price_index):
    """R75 — attach `money` to every reviewed parlay row, in place, so a card
    never has to price a parlay itself:
      settled    a graded parlay: what the $100 stake actually returned
                 (net_fair, net_vig2), the R73 arithmetic per parlay
      potential  an ungraded parlay: what $100 WOULD return if every leg hit,
                 at the same prices — a price, not a result, and the card says so
    The settled rows of a scope sum to summary.parlays.stake_100[scope] because
    both come from parlay_money; the selftest asserts that sum."""
    for parlay in parlays or []:
        settled = parlay_money(parlay, week, price_index)
        if settled is None:
            net, assumed = potential_return(parlay, week, price_index)
            parlay["money"] = {"kind": "potential", "net_fair": _r(net),
                               "net_vig2": None, "assumed_price_legs": assumed}
        else:
            fair, vig, assumed = settled
            parlay["money"] = {"kind": "settled", "net_fair": _r(fair),
                               "net_vig2": _r(vig), "assumed_price_legs": assumed}


def stake_100(parlays, week, price_index):
    """Owner decision 3 (R73): a $100 flat stake on every parlay of each scope,
    display-only. One block per scope {week, game}:
      n            parlays of the scope in the week
      graded       n minus the pending ones (only these are staked)
      hit / push   all_hit / push buckets among the graded
      staked       100 x graded
      net_fair     sum over graded of: all_hit 100 x (prod decimals - 1);
                   push the same with pushed (void) legs at 1.0; else -100
      net_vig2     the same with every leg re-priced at implied x 1.02 (cap 0.99)
      assumed_price_legs  legs of the graded parlays priced at 1.9091 (-110)
                   because no book price exists (props, no ledger row)
      note         the rule, with the counts, in one sentence
    net_* are null (never 0) when nothing is graded. Money never feeds a model."""
    out = {}
    for scope in ("week", "game"):
        rows = [p for p in parlays if p.get("scope") == scope]
        graded = [p for p in rows if p.get("bucket") != "pending"]
        hit = sum(1 for p in graded if p.get("bucket") == "all_hit")
        push = sum(1 for p in graded if p.get("bucket") == "push")
        lost = len(graded) - hit - push
        net_fair = net_vig2 = 0.0
        assumed = 0
        for p in graded:
            # R75: one function settles a parlay, here and on its card.
            f, v, a = parlay_money(p, week, price_index)
            net_fair += f
            net_vig2 += v
            assumed += a
        note = ("$100 flat on each of the %d %s-scope parlays: %d graded (%d all_hit paid, "
                "%d push with pushed legs at 1.0, %d lost -100), %d pending excluded; leg "
                "decimal = 1/implied_prob of the as-made R58 ledger row (moneyline/spread), "
                "%d leg(s) with no book price (props, or no ledger row) assumed at -110 "
                "(1.9091); net_vig2 re-prices every leg at implied x 1.02 capped at 0.99. "
                "Display-only money, never a model input."
                % (len(rows), scope, len(graded), hit, push, lost, len(rows) - len(graded),
                   assumed))
        out[scope] = {"n": len(rows), "graded": len(graded), "hit": hit, "push": push,
                      "staked": _r(STAKE * len(graded)),
                      "net_fair": _r(net_fair) if graded else None,
                      "net_vig2": _r(net_vig2) if graded else None,
                      "assumed_price_legs": assumed, "note": note}
    return out


def parlay_bucket(leg_results):
    """Owner decision 3 — the five outcome buckets, decided in this order:
      pending     any leg still pending (or no legs at all)
      push        at least one leg push/void and EVERY other leg hit
      all_hit     every leg hit
      all_missed  no leg hit (misses, or misses among voids)
      partial     some hit, some missed
    Pure over the leg result strings (hit | miss | pending | void)."""
    results = list(leg_results or [])
    if not results or "pending" in results:
        return "pending"
    hits = sum(1 for r in results if r == "hit")
    voids = sum(1 for r in results if r == "void")
    if voids and hits + voids == len(results):
        return "push"
    if hits == len(results):
        return "all_hit"
    if hits == 0:
        return "all_missed"
    return "partial"


# --------------------------------------------------------------------------- #
# summary + document                                                            #
# --------------------------------------------------------------------------- #

def summarize(games, parlays, players, learning=None, week=None, price_index=None):
    """Week summary. picks: n/won/pct/brier over the graded picks, plus (R72)
    right (== won), wrong (n - won) and tbd — games with NO FINAL evidence yet
    (final null). A tie is FINAL but ungradable against a 2-way pick: it is in
    none of right / wrong / tbd. `learning` is the week's learning block (see
    learning_for_week); None -> the honest "no lock file" block. parlays.stake_100
    (R73) is the display-only flat-stake P&L over the reviewed parlays priced from
    `price_index` (ledger_price_index); `week` keys the price lookup."""
    graded = [g for g in games if g.get("result") in ("won", "lost")]
    won = sum(1 for g in graded if g["result"] == "won")
    briers = [g["brier"] for g in graded if isinstance(g.get("brier"), (int, float))]
    legs = [l for p in parlays for l in p.get("legs") or []]
    band = [p for p in players if p["verdict"] != "dnp"]
    return {
        "picks": {"n": len(graded), "won": won,
                  "pct": _r(won / len(graded), 4) if graded else None,
                  "brier": _r(sum(briers) / len(briers), 4) if briers else None,
                  "right": won, "wrong": len(graded) - won,
                  "tbd": sum(1 for g in games if g.get("final") is None)},
        "parlays": {"n": len(parlays),
                    "hit": sum(1 for p in parlays if p["result"] == "hit"),
                    "miss": sum(1 for p in parlays if p["result"] == "miss"),
                    "pending": sum(1 for p in parlays if p["result"] == "pending"),
                    "legs_n": len(legs),
                    "legs_hit": sum(1 for l in legs if l["result"] == "hit"),
                    "buckets": {b: sum(1 for p in parlays if p.get("bucket") == b)
                                for b in PARLAY_BUCKETS},
                    "stake_100": stake_100(parlays, week if week is not None else -1,
                                           price_index or {})},
        "learning": learning if learning is not None else learning_for_week([], None),
        "players": {"n": len(players),
                    "over": sum(1 for p in players if p["verdict"] == "over"),
                    "under": sum(1 for p in players if p["verdict"] == "under"),
                    "met": sum(1 for p in players if p["verdict"] == "met"),
                    "dnp": sum(1 for p in players if p["verdict"] == "dnp"),
                    "band_coverage": _r(sum(1 for p in band if p["verdict"] == "met")
                                        / len(band), 4) if band else None},
    }


# --------------------------------------------------------------------------- #
# R72: weeks in scope, the learning proof, the season tally                     #
# --------------------------------------------------------------------------- #

def _parse_utc(s):
    """'2026-09-15T00:15Z' / '2026-09-14T11:56:07Z' -> aware datetime; None otherwise."""
    if not isinstance(s, str) or not s:
        return None
    txt = s[:-1] if s.endswith("Z") else s
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return dt.datetime.strptime(txt, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def pipeline_week(schedule_games, predictions_week, now):
    """The current pipeline week — the last week the review must carry a block for.

    Starts from scripts/build_predictions.current_week's rule (the earliest week
    on the schedule not entirely FINAL). Once that week is UNDERWAY (any of its
    games FINAL or kicked off by `now`) the on-deck week is in the pipeline too
    (its slate, forecast and parlays are being built while the last game of the
    current week is still to be played), so the review moves one week on — as
    far as the schedule reaches. game_predictions.json's own `week` is a floor.
    None when there is no schedule and no predictions week (nothing to review).
    """
    by_week = {}
    for g in schedule_games or []:
        try:
            by_week.setdefault(int(g.get("week")), []).append(g)
        except (TypeError, ValueError):
            continue
    cur = None
    if by_week:
        cur = max(by_week)
        for wk in sorted(by_week):
            if not all(g.get("status") in FINAL_STATUSES for g in by_week[wk]):
                cur = wk
                break
        t_now = _parse_utc(now)
        underway = any(
            g.get("status") in FINAL_STATUSES
            or (t_now is not None and _parse_utc(g.get("kickoff_utc")) is not None
                and _parse_utc(g.get("kickoff_utc")) <= t_now)
            for g in by_week[cur])
        if underway and (cur + 1) in by_week:
            cur += 1
    if isinstance(predictions_week, int) and predictions_week >= 1:
        cur = predictions_week if cur is None else max(cur, predictions_week)
    return cur


def review_weeks(schedule_games, predictions_week, locks, scores, now):
    """Sorted weeks the document carries: every week with a lock file or a
    resolved player-week (R71), plus (R72) every week 1..pipeline_week that has
    games on the schedule — so a week with nothing FINAL still gets its block."""
    weeks = set(int(w) for w in (locks or {})) | set(int(r["week"]) for r in (scores or []))
    through = pipeline_week(schedule_games, predictions_week, now)
    if through is not None:
        sched_weeks = set()
        for g in schedule_games or []:
            try:
                sched_weeks.add(int(g.get("week")))
            except (TypeError, ValueError):
                continue
        weeks |= set(w for w in sched_weeks if w <= through)
        if isinstance(predictions_week, int) and predictions_week >= 1:
            weeks.add(predictions_week)
    return sorted(weeks)


def graded_lock_rows(lock_rows):
    """The lock rows scripts/refit.py consumes — the EXACT rule of
    refit._collect_resolved_rows("game"): event_type "game", resolved true, and a
    measured (estimate false) row. scripts/resolve_locks.resolve_rows writes
    `resolved` only for a FINAL game (snapshot.resolve attaches actual/brier/
    log_loss), so every row here is a graded receipt."""
    return [r for r in lock_rows or []
            if r.get("event_type") == "game" and r.get("resolved")
            and not r.get("estimate", True)]


def newest_refit(tuning):
    """The newest IN-SEASON game_params refit pass in model_tuning.json history —
    the exact rule of app/views/model.js resolvedLockCount: kind "game_params",
    search != null, no eval_seasons key (a backtest entry has one), n_resolved a
    finite number > 0; newest by generated_utc, a tie falling to the later entry.
    Returns {archived_utc, n_resolved, adopted, verdict} or None."""
    best = None
    for h in (tuning or {}).get("history") or []:
        if not isinstance(h, dict) or h.get("kind") != "game_params" \
                or h.get("search") is None or "eval_seasons" in h:
            continue
        n = h.get("n_resolved")
        if isinstance(n, bool) or not isinstance(n, (int, float)) or n <= 0:
            continue
        if best is None or str(h.get("generated_utc") or "") >= str(best.get("generated_utc") or ""):
            best = h
    if best is None:
        return None
    adopted = best.get("adopted") is True
    return {"archived_utc": best.get("generated_utc"), "n_resolved": int(best["n_resolved"]),
            "adopted": adopted, "verdict": "adopted" if adopted else "held"}


def learning_for_week(lock_rows, refit):
    """One week's learning block: how many of this week's lock receipts are graded
    (refit's rule) and the refit pass they fed. The archive records n_resolved
    across ALL lock files, never per week, so `refit` is the newest pass (the
    same one the top-level block names) and is null when this week fed nothing."""
    graded = len(graded_lock_rows(lock_rows))
    if lock_rows is None:
        return {"graded_locks": 0, "refit": None,
                "note": "no lock file for this week yet — nothing graded, nothing fed to refit"}
    if graded == 0:
        return {"graded_locks": 0, "refit": None,
                "note": "no graded receipts in this week's lock file yet (%d rows pending)"
                        % len([r for r in lock_rows if r.get("event_type") == "game"])}
    if refit is None:
        return {"graded_locks": graded, "refit": None,
                "note": "%d graded receipts, but model_tuning.json history holds no in-season "
                        "refit pass yet — not consumed" % graded}
    return {"graded_locks": graded, "refit": dict(refit),
            "note": "%d graded receipts feed scripts/refit.py; newest pass %s consumed "
                    "n_resolved=%d across all lock files and was %s" % (
                        graded, refit["archived_utc"], refit["n_resolved"], refit["verdict"])}


def learning_block(locks, tuning):
    """Top-level proof of the loop from committed data ONLY. graded_locks_total =
    the receipts under data/snapshots/*_games_open.json that refit consumes;
    refit = the newest in-season pass in model_tuning.json; consumed_all =
    (refit.n_resolved == graded_locks_total) when a pass exists, else null with
    the reason. Adoption is reported exactly as archived — never inferred."""
    total = sum(len(graded_lock_rows(rows)) for rows in (locks or {}).values())
    refit = newest_refit(tuning)
    if refit is None:
        if total == 0:
            note = "no graded lock receipts yet and no in-season refit pass archived"
        else:
            note = ("%d graded lock receipts on file, but model_tuning.json history holds "
                    "no in-season refit pass yet (receipts graded after the last refit "
                    "pass, or refit has not run)" % total)
        return {"graded_locks_total": total, "refit": None, "consumed_all": None, "note": note}
    consumed = refit["n_resolved"] == total
    if consumed:
        note = ("all %d graded lock receipts were consumed by the refit pass archived %s "
                "(n_resolved=%d); verdict %s" % (total, refit["archived_utc"],
                                                 refit["n_resolved"], refit["verdict"]))
    elif refit["n_resolved"] < total:
        note = ("%d graded lock receipts on file but the newest refit pass (%s) consumed "
                "n_resolved=%d — %d receipt(s) graded after the last refit pass" % (
                    total, refit["archived_utc"], refit["n_resolved"],
                    total - refit["n_resolved"]))
    else:
        note = ("the newest refit pass (%s) archived n_resolved=%d but only %d graded lock "
                "receipts are on file — the archive and the lock files disagree" % (
                    refit["archived_utc"], refit["n_resolved"], total))
    return {"graded_locks_total": total, "refit": refit, "consumed_all": consumed, "note": note}


def players_season(weeks):
    """{gsis_id: {name, position, team, weeks, over, met, under, dnp, met_rate,
    by_week: {"<wk>": {verdict, delta, actual, projected}}}} over every week block,
    for every player with at least one review row. weeks = graded rows (dnp is a
    resolved row); met_rate = met / weeks, null at 0. Sorted by gsis_id."""
    out = {}
    for wk in sorted(weeks, key=lambda w: int(w)):
        for p in (weeks[wk].get("players") or []):
            e = out.setdefault(p["gsis_id"], {
                "name": p.get("name"), "position": p.get("position"), "team": p.get("team"),
                "weeks": 0, "over": 0, "met": 0, "under": 0, "dnp": 0, "met_rate": None,
                "by_week": {}})
            e["weeks"] += 1
            e[p["verdict"]] += 1
            e["by_week"][str(int(p["week"]))] = {"verdict": p["verdict"], "delta": p.get("delta"),
                                                 "actual": p.get("actual"),
                                                 "projected": p.get("projected")}
    for e in out.values():
        e["met_rate"] = _r(e["met"] / e["weeks"], 4) if e["weeks"] else None
    return {k: out[k] for k in sorted(out)}


def load_locks(snapshot_dir, season):
    """{week: rows} + [relative paths] for <season>_wkNN_games_open.json under
    `snapshot_dir` — the same walk scripts/refit.py and resolve_locks.py do."""
    locks, files = {}, []
    for path in sorted(glob.glob(os.path.join(snapshot_dir, "*_games_open.json"))):
        sw = week_of_lock_file(path)
        if sw is None or sw[0] != int(season):
            continue
        locks[sw[1]] = _load(path)
        files.append(path)
    return locks, files


def carry_narratives(doc, previous):
    """Re-attach the optional narratives from the previous review.json wherever the
    measured why is byte-identical (why_hash); a changed why drops its narrative so
    the display can never restate stale facts."""
    if not previous:
        return 0
    prev_idx = {}
    for wk, blk in (previous.get("weeks") or {}).items():
        for g in blk.get("games") or []:
            if g.get("narrative"):
                prev_idx[("game", wk, g["game_id"])] = g["narrative"]
        for p in blk.get("players") or []:
            if p.get("narrative"):
                prev_idx[("player", wk, p["gsis_id"])] = p["narrative"]
    kept = 0
    for wk, blk in doc["weeks"].items():
        for kind, rows, key in (("game", blk["games"], "game_id"),
                                ("player", blk["players"], "gsis_id")):
            for r in rows:
                n = prev_idx.get((kind, wk, r[key]))
                if n and n.get("why_hash") == why_hash(r.get("why")):
                    r["narrative"] = n
                    kept += 1
    return kept


def build(inputs, now):
    """The whole document from an `inputs` dict (see load_inputs / _fixture_inputs).
    Pure: no I/O, no clock beyond `now`."""
    season = int(inputs["season"])
    notes = list(inputs.get("notes") or [])
    sched = {str(g["game_id"]): g for g in (inputs.get("schedule") or {}).get("games") or []}
    finals = finals_index(inputs.get("finals") or [])
    injuries = inputs.get("injuries") or {}
    injury_by_key = {}
    for i in injuries.get("injuries") or []:
        injury_by_key[(i.get("team"), norm_name(i.get("player")))] = i
    injuries_as_of = injuries.get("updated_utc")
    identity = {}
    qb1 = {}
    for p in (inputs.get("projections") or {}).get("players") or []:
        identity[p["gsis_id"]] = {"name": p.get("name"), "team": p.get("team"),
                                  "position": p.get("position")}
        if p.get("position") == "QB" and p.get("team"):
            cur = qb1.get(p["team"])
            if cur is None or float(p.get("proj_points") or 0) > float(cur.get("proj_points") or 0):
                qb1[p["team"]] = {"name": p.get("name"), "proj_points": p.get("proj_points")}
    for pid, p in ((inputs.get("ledger") or {}).get("players") or {}).items():
        identity.setdefault(pid, {"name": p.get("name"), "team": p.get("team"),
                                  "position": p.get("position")})
    weekly_by_id = {p["gsis_id"]: p for p in (inputs.get("weekly") or {}).get("players") or []}
    by_np, names = index_stats(inputs.get("stats_rows") or [])
    stats_available = bool(inputs.get("stats_rows"))
    outcomes = leg_outcomes_from_ledger(inputs.get("leg_scores"))
    price_index = ledger_price_index(inputs.get("parlay_ledger"))
    ledger_legs = {}
    for l in (inputs.get("parlay_ledger") or {}).get("legs") or []:
        ledger_legs.setdefault((int(l["week"]), l.get("market"), l.get("selection")),
                               str(l.get("game_id")))
    locks = inputs.get("locks") or {}          # {week: [rows]}
    scores = (inputs.get("estimate_scores") or {}).get("resolved") or []
    parlays_doc = inputs.get("parlays") or {}
    previous = inputs.get("previous") or {}

    tuning = inputs.get("tuning") or {}
    refit = newest_refit(tuning)
    pred_week = (inputs.get("predictions") or {}).get("week")
    pred_week = int(pred_week) if isinstance(pred_week, int) and not isinstance(pred_week, bool) else None
    weeks = review_weeks(list(sched.values()), pred_week, locks, scores, now)
    through = pipeline_week(list(sched.values()), pred_week, now)
    out_weeks = {}
    for wk in weeks:
        wk_games = [g for g in sched.values() if int(g.get("week", -1)) == wk]
        lock_rows = locks.get(wk) if wk in locks else locks.get(str(wk))
        lidx = lock_index(lock_rows or [])
        # a lock without a schedule row still reviews (the lock is the record)
        for eid, lock in lidx.items():
            if eid not in sched:
                wk_games.append({"game_id": eid, "home": None, "away": None, "week": wk})
        games = []
        for g in sorted(wk_games, key=lambda x: (str(x.get("kickoff_utc") or ""), str(x["game_id"]))):
            gid = str(g["game_id"])
            fc = _forecast_for(inputs.get("forecast"), season, wk, g.get("home"), g.get("away"))
            games.append(review_game(g, lidx.get(gid), finals.get(gid), qb1, injury_by_key,
                                     fc, injuries_as_of))
        game_by_id = {g["game_id"]: g for g in games}
        games_by_team = {}
        for g in wk_games:
            for t in (g.get("home"), g.get("away")):
                if t:
                    games_by_team[t] = g
        final_by_team = {}
        for g in games:
            if g.get("final"):
                for t in (g["home"], g["away"]):
                    final_by_team[t] = finals.get(g["game_id"])
        players = []
        for r in sorted((x for x in scores if int(x["week"]) == wk),
                        key=lambda x: str(x["gsis_id"])):
            ident = identity.get(r["gsis_id"]) or {}
            if not ident.get("name"):
                notes.append("wk %d: %s has no identity row (player_projections/ledger); "
                             "reviewed without a name" % (wk, r["gsis_id"]))
            weekly = weekly_by_id.get(r["gsis_id"])
            srow = lookup_stats(ident.get("name"), r.get("position"), wk, by_np, names) \
                if ident.get("name") else None
            inj = injury_by_key.get((ident.get("team"), norm_name(ident.get("name"))))
            players.append(review_player(r, ident, weekly, srow, inj,
                                         final_by_team.get(ident.get("team")),
                                         injuries_as_of, stats_available))
        parlays = []
        if int(parlays_doc.get("week", -1)) == wk:
            for p in parlays_doc.get("parlays") or []:
                parlays.append(review_parlay(p, wk, outcomes, ledger_legs, games_by_team,
                                             game_by_id))
        else:
            prev_p = ((previous.get("weeks") or {}).get(str(wk)) or {}).get("parlays") or []
            for p in prev_p:
                parlays.append(review_parlay(p, wk, outcomes, ledger_legs, games_by_team,
                                             game_by_id))
            if prev_p:
                notes.append("wk %d parlays carried forward from the previous review "
                             "(parlays.json now holds week %s)" % (wk, parlays_doc.get("week")))
            elif parlays_doc:
                notes.append("wk %d: no parlays on file (parlays.json holds week %s)"
                             % (wk, parlays_doc.get("week")))
        # R75 — each row carries its own $100 figure, from the same price index
        # the footer sums, so the card and the footer cannot disagree.
        stamp_parlay_money(parlays, wk, price_index)
        out_weeks[str(wk)] = {"games": games, "parlays": parlays, "players": players,
                              "summary": summarize(games, parlays, players,
                                                   learning_for_week(lock_rows, refit),
                                                   wk, price_index)}
    if not stats_available:
        notes.append("stats: no nflverse stat line loaded — player touchdowns/volume/"
                     "efficiency/turnovers factors omitted on every row (%s)"
                     % (inputs.get("stats_reason") or "offline"))
    if not finals:
        notes.append("finals: no FINAL scores on file — game results come from lock "
                     "receipts only (winner known, score null) (%s)"
                     % (inputs.get("finals_reason") or "offline"))
    if not inputs.get("leg_scores"):
        notes.append("parlays: data/parlay_leg_scores.json absent — spread/prop legs "
                     "pending; moneyline legs graded from the lock receipts")
    if not tuning:
        notes.append("learning: data/model_tuning.json not loaded — refit archive unknown, "
                     "consumed_all null")
    doc = {"season": season, "generated_utc": now, "review_through_week": through,
           "weeks": out_weeks, "learning": learning_block(locks, tuning),
           "players_season": players_season(out_weeks),
           "sources": inputs.get("sources") or {}, "notes": notes}
    kept = carry_narratives(doc, previous)
    if kept:
        doc["notes"].append("narratives: %d carried forward (why unchanged)" % kept)
    return doc


# --------------------------------------------------------------------------- #
# I/O shell                                                                     #
# --------------------------------------------------------------------------- #

def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_opt(path):
    return _load(path) if os.path.exists(path) else None


def _stamp(doc, *keys):
    for k in keys:
        if doc and doc.get(k):
            return doc[k]
    return None


def load_inputs(root=_ROOT, offline=False, finals_path=None, stats_csv=None, season=None):
    """Committed inputs (+ optional finals file / stats CSV; + ESPN / nflverse on the
    runner when not offline). Every skip is recorded in notes and sources."""
    data = os.path.join(root, "data")
    sched = _load(os.path.join(data, "schedule_full.json"))
    gp = _load_opt(os.path.join(data, "game_predictions.json"))
    season = int(season or sched.get("season") or (gp or {}).get("season"))
    locks, lock_paths = load_locks(os.path.join(data, "snapshots"), season)
    lock_files = [os.path.relpath(p, root) for p in lock_paths]
    notes, sources = [], {}
    sources["schedule_full"] = _stamp(sched, "updated_utc")
    sources["game_predictions"] = _stamp(gp, "updated_utc")
    sources["locks"] = lock_files
    tuning = _load_opt(os.path.join(data, "model_tuning.json"))
    sources["model_tuning"] = _stamp(tuning, "generated_utc")
    es = _load_opt(os.path.join(data, "estimate_scores.json"))
    sources["estimate_scores"] = _stamp(es, "generated_utc")
    weekly = _load_opt(os.path.join(data, "player_weekly.json"))
    sources["player_weekly"] = _stamp(weekly, "updated_utc")
    proj = _load_opt(os.path.join(data, "player_projections.json"))
    sources["player_projections"] = _stamp(proj, "updated_utc")
    inj = _load_opt(os.path.join(data, "injuries.json"))
    sources["injuries"] = _stamp(inj, "updated_utc")
    fc = _load_opt(os.path.join(data, "weather_forecast.json"))
    sources["weather_forecast"] = _stamp(fc, "generated_utc")
    parlays = _load_opt(os.path.join(data, "parlays.json"))
    sources["parlays"] = _stamp(parlays, "updated_utc")
    ledger = _load_opt(os.path.join(data, "estimates", "%d.json" % season))
    sources["estimate_ledger"] = _stamp(ledger, "generated_utc")
    pledger = _load_opt(os.path.join(data, "estimates", "parlays_%d.json" % season))
    sources["parlay_ledger"] = _stamp(pledger, "generated_utc")
    legs = _load_opt(os.path.join(data, "parlay_leg_scores.json"))
    sources["parlay_leg_scores"] = _stamp(legs, "generated_utc")
    previous = _load_opt(OUT_PATH if root == _ROOT else os.path.join(data, "review.json"))

    finals, finals_reason = [], None
    if finals_path:
        finals = _load(finals_path)
        sources["finals"] = "file:%s" % os.path.relpath(finals_path, root)
    elif offline:
        finals_reason = "offline run: ESPN not fetched"
        sources["finals"] = "lock receipts only (offline)"
    else:
        from scripts.scrape import espn  # noqa: PLC0415 — runner only
        fetched = 0
        for wk in sorted(locks):
            try:
                rows = espn.fetch_scores(season, week=wk, final_only=True)
            except Exception as exc:  # noqa: BLE001 — a feed fault is a loud skip
                notes.append("finals wk %d: ESPN fetch failed (%s: %s)" % (
                    wk, exc.__class__.__name__, exc))
                continue
            for r in rows:
                r["week"] = wk
            finals.extend(rows)
            fetched += 1
        sources["finals"] = "espn (%d week(s) fetched)" % fetched
        if not finals:
            finals_reason = "ESPN returned no FINAL rows for the locked weeks"

    stats_rows, stats_reason = [], None
    if stats_csv:
        import csv  # noqa: PLC0415
        with open(stats_csv, encoding="utf-8", newline="") as fh:
            stats_rows = list(csv.DictReader(fh))
        sources["stats"] = "file:%s" % os.path.relpath(stats_csv, root)
    elif offline:
        stats_reason = "offline run: stats not fetched"
        sources["stats"] = None
    else:
        from scripts.resolve_estimates import RELEASE_URL, fetch_csv  # noqa: PLC0415
        rows, why = fetch_csv(season, None)
        if rows is None:
            stats_reason = why
            sources["stats"] = None
        else:
            stats_rows = rows
            sources["stats"] = RELEASE_URL.format(season=season)

    return {"season": season, "schedule": sched, "predictions": gp, "tuning": tuning,
            "locks": locks, "finals": finals,
            "finals_reason": finals_reason, "estimate_scores": es, "weekly": weekly,
            "projections": proj, "injuries": inj, "forecast": fc, "parlays": parlays,
            "ledger": ledger, "parlay_ledger": pledger, "leg_scores": legs,
            "stats_rows": stats_rows, "stats_reason": stats_reason,
            "previous": previous, "sources": sources, "notes": notes}


def write(doc, path=OUT_PATH):
    """data/*.json convention: ensure_ascii=True, indent=2, no sort_keys, newline."""
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")


def run(offline=False, finals_path=None, stats_csv=None, out_path=OUT_PATH, now=None,
        season=None):
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    inputs = load_inputs(offline=offline, finals_path=finals_path, stats_csv=stats_csv,
                         season=season)
    doc = build(inputs, now)
    write(doc, out_path)
    for wk, blk in doc["weeks"].items():
        s = blk["summary"]
        print("build_review: wk %s — picks right %d / wrong %d / tbd %d (brier %s), parlays %d "
              "(%d hit, %d pending; buckets %s), players %d (over %d / under %d / met %d / "
              "dnp %d), graded locks %d" % (
                  wk, s["picks"]["right"], s["picks"]["wrong"], s["picks"]["tbd"],
                  s["picks"]["brier"], s["parlays"]["n"], s["parlays"]["hit"],
                  s["parlays"]["pending"], s["parlays"]["buckets"],
                  s["players"]["n"], s["players"]["over"], s["players"]["under"],
                  s["players"]["met"], s["players"]["dnp"], s["learning"]["graded_locks"]))
    lb = doc["learning"]
    print("build_review: learning — graded locks %d, refit %s, consumed_all %s" % (
        lb["graded_locks_total"], lb["refit"], lb["consumed_all"]))
    if not doc["weeks"]:
        print("build_review: no schedule weeks, lock files or resolved player-weeks yet — "
              "empty weeks (clean no-op document)")
    for n in doc["notes"]:
        print("  note: " + n)
    return doc


# --------------------------------------------------------------------------- #
# selftest (fixture-driven, never writes data/)                                 #
# --------------------------------------------------------------------------- #

def _fixture_inputs():
    import csv  # noqa: PLC0415
    fx = _load(os.path.join(FIXTURE_DIR, "review_inputs.json"))
    with open(os.path.join(FIXTURE_DIR, "stats_player_week.sample.csv"),
              encoding="utf-8", newline="") as fh:
        fx["stats_rows"] = list(csv.DictReader(fh))
    fx["locks"] = {int(k): v for k, v in fx["locks"].items()}
    return fx


def _fixture_inputs_r72():
    """The R72 fixture: inputs JSON + lock FILES under tests/fixtures/r72/snapshots
    (walked by load_locks, the same walk the runner does) + a refit archive."""
    fx = _load(os.path.join(FIXTURE_DIR_R72, "review_inputs.json"))
    fx["locks"], _ = load_locks(os.path.join(FIXTURE_DIR_R72, "snapshots"), fx["season"])
    fx["tuning"] = _load(os.path.join(FIXTURE_DIR_R72, "model_tuning.json"))
    return fx


def _validate_against_schema(doc):
    """Validate a document against data/contracts/review.schema.json with the
    repo's own stdlib validator (scripts/validate_data._validate)."""
    from scripts import validate_data as vd  # noqa: PLC0415
    schema = _load(os.path.join(DATA, "contracts", "review.schema.json"))
    errors = []
    vd._validate(doc, schema, "review", errors)
    return errors


def selftest():
    fx = _fixture_inputs()
    doc = build(fx, "2026-09-14T12:00:00Z")
    wk = doc["weeks"]["1"]
    g = {x["game_id"]: x for x in wk["games"]}
    # status gating: FINAL with score -> result; lock receipt only -> result, score null;
    # HALFTIME / SCHEDULED 0-0 stubs -> null
    assert g["G1"]["result"] == "won" and g["G1"]["final"]["home_score"] == 27 \
        and g["G1"]["final_source"] == "espn_final" and g["G1"]["picked"] == "AAA"
    assert g["G2"]["result"] == "lost" and g["G2"]["final"]["home_score"] is None \
        and g["G2"]["final"]["winner"] == "DDD" and g["G2"]["final_source"] == "lock_receipt"
    assert g["G3"]["result"] is None and g["G3"]["final"] is None \
        and g["G3"]["brier"] is None, "a halftime stub never grades"
    assert g["G4"]["result"] is None and g["G4"]["final"] is None, "a 0-0 scheduled stub never grades"
    assert g["G1"]["brier"] == 0.16, "brier from the lock receipt when present"
    assert abs(g["G2"]["brier"] - metrics.brier(1, [0.7, 0.3])) < 1e-9, "computed when absent"
    assert g["G1"]["why"]["source"] == "measured" and any(
        r["factor"] == "qb1_away" and "no injury-report row" in r["text"] for r in g["G1"]["why"]["reasons"])
    assert any(r["factor"] == "qb1_home" and "Out" in r["text"] for r in g["G1"]["why"]["reasons"])
    assert any(r["factor"] == "venue_weather" and "wind 30.0" in r["text"] for r in g["G1"]["why"]["reasons"])
    assert any("blowout" in r["text"] for r in g["G1"]["why"]["reasons"])
    # players: verdict rule + measured why
    p = {x["gsis_id"]: x for x in wk["players"]}
    assert p["fx-rb"]["verdict"] == "over" and p["fx-rb"]["delta"] == 9.9
    tds = next(r for r in p["fx-rb"]["why"]["reasons"] if r["factor"] == "touchdowns")
    assert tds["points"] == 8.4 and "2 rushing TD vs 0.6 expected" in tds["text"], tds
    assert p["fx-rb"]["why"]["reasons"][0]["factor"] == "touchdowns", "ranked by |points|"
    num = [r for r in p["fx-rb"]["why"]["reasons"] if r["points"] is not None
           and r["factor"] != "model_factor"]
    assert abs(sum(r["points"] for r in num) + p["fx-rb"]["why"]["unattributed"]
               - p["fx-rb"]["delta"]) < 0.02, "factors + unattributed == delta"
    assert p["fx-wr"]["verdict"] == "met" and p["fx-wr"]["actual"] == 6.0, "actual == low is MET"
    assert p["fx-te"]["verdict"] == "met" and p["fx-te"]["actual"] == 12.0, "actual == high is MET"
    assert p["fx-qb"]["verdict"] == "under" and p["fx-qb"]["actual"] == 4.1
    assert p["fx-dnp"]["verdict"] == "dnp" and p["fx-dnp"]["actual"] is None \
        and p["fx-dnp"]["delta"] is None, "DNP reports null, never 0"
    assert p["fx-dnp"]["why"]["reasons"][0]["factor"] == "availability" \
        and p["fx-dnp"]["why"]["reasons"][0]["points"] == -10.0
    assert p["fx-qb"]["why"]["omitted"] and "absent for this player-week" in p["fx-qb"]["why"]["omitted"][0], \
        "no stat line -> stat factors omitted and said so"
    assert any(r["factor"] == "model_factor" and r["factor_value"] > 1.0
               for r in p["fx-rb"]["why"]["reasons"])
    assert any(r["factor"] == "game_script" for r in p["fx-rb"]["why"]["reasons"])
    assert "fx-nostats" not in p, "a player-week without an estimate_scores row has no review row"
    # parlays: adapter + rules
    oc = leg_outcomes_from_ledger(fx["leg_scores"])
    assert oc[(1, "G1", "spread", "AAA -3")]["hit"] is True
    assert oc[(1, "G1", "rb_rush_yds", "R. Back 60+ rush yds")]["hit"] is False
    assert oc[(1, "G2", "spread", "CCC -1")]["hit"] is None \
        and oc[(1, "G2", "spread", "CCC -1")]["reason"] == "no_final_score"
    # G03 — the consumers join on card_id (the identity), parlay_id only for a
    # pre-R90 archive that has none.
    pr = {x["parlay_id"]: x for x in wk["parlays"]}
    assert len({x["card_id"] for x in wk["parlays"]}) == len(wk["parlays"]), \
        "one review row per card identity"
    assert all(len(x["card_id"]) == 12 for x in wk["parlays"]), "the archive's own id"
    assert pr["G1-g1"]["result"] == "miss" and [l["result"] for l in pr["G1-g1"]["legs"]] == ["hit", "miss"]
    assert pr["G1-g2"]["result"] == "hit", "moneyline from finals + spread from ledger"
    assert pr["week-1"]["result"] == "pending" and [l["result"] for l in pr["week-1"]["legs"]] == ["hit", "pending"], \
        "pending until every leg is graded; the ML leg graded from the lock receipt"
    assert pr["week-2"]["result"] == "void" and [l["result"] for l in pr["week-2"]["legs"]] == ["hit", "void"]
    assert pr["G3-g1"]["result"] == "pending", "a halftime game grades nothing"
    # summary math
    s = wk["summary"]
    assert s["picks"] == {"n": 2, "won": 1, "pct": 0.5, "brier": round((0.16 + g["G2"]["brier"]) / 2, 4),
                          "right": 1, "wrong": 1, "tbd": 2}, s["picks"]
    assert sorted(doc["weeks"]) == ["1", "2"], "week 2 (on deck, nothing FINAL) gets a block"
    assert doc["weeks"]["2"]["summary"]["picks"] == {"n": 0, "won": 0, "pct": None, "brier": None,
                                                     "right": 0, "wrong": 0, "tbd": 1}
    assert doc["weeks"]["2"]["games"][0]["picked"] is None and doc["weeks"]["2"]["games"][0]["result"] is None
    assert doc["review_through_week"] == 2
    assert doc["learning"]["refit"] is None and doc["learning"]["consumed_all"] is None, \
        "no archive in the r71 fixture -> nothing claimed"
    assert s["players"]["n"] == 5 and s["players"]["over"] == 1 and s["players"]["under"] == 1 \
        and s["players"]["met"] == 2 and s["players"]["dnp"] == 1 and s["players"]["band_coverage"] == 0.5
    assert s["parlays"]["n"] == 5 and s["parlays"]["hit"] == 1 and s["parlays"]["legs_hit"] == 5
    # narratives carry forward only while the why is unchanged
    fx2 = dict(fx)
    prev = json.loads(json.dumps(doc))
    prev["weeks"]["1"]["games"][0]["narrative"] = {
        "text": "x", "source": "ai_narrative", "generated_utc": "t",
        "why_hash": why_hash(prev["weeks"]["1"]["games"][0]["why"])}
    prev["weeks"]["1"]["players"][0]["narrative"] = {
        "text": "y", "source": "ai_narrative", "generated_utc": "t", "why_hash": "stale"}
    fx2["previous"] = prev
    doc2 = build(fx2, "2026-09-15T12:00:00Z")
    assert doc2["weeks"]["1"]["games"][0].get("narrative", {}).get("text") == "x"
    assert "narrative" not in doc2["weeks"]["1"]["players"][0], "a stale why drops its narrative"
    # week parlays carried forward when parlays.json moved on
    fx3 = dict(fx)
    fx3["parlays"] = {"season": 2026, "week": 2, "parlays": []}
    fx3["previous"] = prev
    doc3 = build(fx3, "2026-09-16T12:00:00Z")
    assert {x["parlay_id"] for x in doc3["weeks"]["1"]["parlays"]} == set(pr)
    # contract + on-disk convention
    errs = _validate_against_schema(doc)
    assert not errs, "schema: " + "; ".join(errs[:5])
    blob = json.dumps(doc, ensure_ascii=True, indent=2) + "\n"
    assert json.loads(blob) == doc
    # empty inputs -> honest empty document
    empty = build({"season": 2026, "schedule": {"games": []}, "locks": {}, "finals": [],
                   "estimate_scores": {"resolved": []}, "sources": {}}, "2026-09-01T00:00:00Z")
    assert empty["weeks"] == {} and empty["players_season"] == {} \
        and empty["learning"] == {"graded_locks_total": 0, "refit": None, "consumed_all": None,
                                  "note": "no graded lock receipts yet and no in-season refit pass archived"} \
        and not _validate_against_schema(empty)
    _selftest_r72()
    _selftest_r73()
    print("selftest OK: status gating (FINAL/receipt grade, halftime and 0-0 stubs never), "
          "band verdicts incl. boundaries, DNP null not 0, measured why sums to delta, "
          "adapter on C's ledger shapes, parlay hit/miss/pending/void, summary math, "
          "narrative carry-forward, schema + JSON convention; R72 right/wrong/tbd, "
          "week blocks through the pipeline week, five parlay buckets <-> result, "
          "players_season tally, the learning proof from lock files + refit archive; "
          "R75 per-parlay money (settled rows sum to the footer, a pending parlay is quoted not settled, schema); R73 stake_100 P&L (all_hit / push drop-out / loss / pending excluded / "
          "assumed -110 / vig re-pricing)")


def _selftest_r72():
    """R72 owner decisions on the r72 fixture (lock FILES + refit archive)."""
    fx = _fixture_inputs_r72()
    doc = build(fx, "2026-09-14T12:00:00Z")
    errs = _validate_against_schema(doc)
    assert not errs, "schema (r72): " + "; ".join(errs[:5])
    # weeks: 1 (underway) and 2 (on deck) — never week 3
    assert sorted(doc["weeks"]) == ["1", "2"] and doc["review_through_week"] == 2, sorted(doc["weeks"])
    w1, w2 = doc["weeks"]["1"], doc["weeks"]["2"]
    g1 = {g["game_id"]: g for g in w1["games"]}
    assert g1["G3"]["result"] == "won", "an estimate lock still grades the PICK"
    assert g1["G8"]["result"] is None and g1["G8"]["final"]["winner"] is None, "tie: FINAL, ungradable"
    assert w1["summary"]["picks"] == {"n": 3, "won": 2, "pct": 0.6667,
                                      "brier": w1["summary"]["picks"]["brier"],
                                      "right": 2, "wrong": 1, "tbd": 1}, w1["summary"]["picks"]
    assert w1["summary"]["picks"]["right"] + w1["summary"]["picks"]["wrong"] == \
        sum(1 for g in w1["games"] if g["result"] in ("won", "lost"))
    assert w2["summary"]["picks"] == {"n": 0, "won": 0, "pct": None, "brier": None,
                                      "right": 0, "wrong": 0, "tbd": 2}
    assert [(g["game_id"], g["picked"], g["result"], g["status"]) for g in w2["games"]] == \
        [("G5", "AAA", None, "STATUS_SCHEDULED"), ("G6", None, None, "STATUS_SCHEDULED")], \
        "week 2: the locked game carries its as-made pick, the unlocked one picked null"
    # parlays: every bucket, and result <-> bucket
    pr = {p["parlay_id"]: (p["result"], p["bucket"]) for p in w1["parlays"]}
    assert pr == {"all-hit": ("hit", "all_hit"), "partial": ("miss", "partial"),
                  "all-missed": ("miss", "all_missed"), "push": ("void", "push"),
                  "pending": ("pending", "pending"), "missed-with-void": ("miss", "all_missed")}, pr
    assert w1["summary"]["parlays"]["buckets"] == {"all_hit": 1, "push": 1, "partial": 1,
                                                   "all_missed": 2, "pending": 1}
    assert sum(w1["summary"]["parlays"]["buckets"].values()) == w1["summary"]["parlays"]["n"]
    assert parlay_bucket([]) == "pending" and parlay_bucket(["void", "void"]) == "push" \
        and parlay_bucket(["miss", "void"]) == "all_missed" and parlay_bucket(["hit", "miss", "void"]) == "partial"
    # players_season across the two week blocks
    ps = doc["players_season"]
    assert ps["P1"]["weeks"] == 2 and ps["P1"]["met"] == 1 and ps["P1"]["under"] == 1 \
        and ps["P1"]["met_rate"] == 0.5 and ps["P1"]["by_week"]["2"] == {
            "verdict": "under", "delta": -8.0, "actual": 3.0, "projected": 11.0}, ps["P1"]
    assert ps["P2"]["over"] == 1 and ps["P2"]["met"] == 1 and ps["P2"]["met_rate"] == 0.5
    assert ps["P3"] == {"name": "Quarter Back", "position": "QB", "team": "EEE", "weeks": 1,
                        "over": 0, "met": 0, "under": 0, "dnp": 1, "met_rate": 0.0,
                        "by_week": {"1": {"verdict": "dnp", "delta": None, "actual": None,
                                          "projected": 15.0}}}, ps["P3"]
    # THE LEARNING LOCK: receipts counted from the lock FILES by refit's rule
    # (G3 is an estimate row -> graded pick, NOT a refit input; 2025 file ignored)
    lb = doc["learning"]
    assert lb["graded_locks_total"] == 2, lb
    assert lb["refit"] == {"archived_utc": "2026-09-14T04:00:00Z", "n_resolved": 2,
                           "adopted": False, "verdict": "held"}, lb
    assert lb["consumed_all"] is True
    assert w1["summary"]["learning"]["graded_locks"] == 2 and w1["summary"]["learning"]["refit"] == lb["refit"]
    assert w2["summary"]["learning"] == {"graded_locks": 0, "refit": None,
                                         "note": "no graded receipts in this week's lock file yet (1 rows pending)"}
    # a receipt graded after the last refit pass -> consumed_all false, said plainly
    fx2 = json.loads(json.dumps(fx))
    fx2["locks"] = {int(k): v for k, v in fx2["locks"].items()}
    fx2["locks"][2][0].update({"resolved": True, "actual": 0, "brier": 0.2304, "log_loss": 0.6539})
    lb2 = build(fx2, "2026-09-14T12:00:00Z")["learning"]
    assert lb2["graded_locks_total"] == 3 and lb2["consumed_all"] is False \
        and "1 receipt(s) graded after the last refit pass" in lb2["note"], lb2
    # adoption is reported only as archived
    fx3 = json.loads(json.dumps(fx))
    fx3["locks"] = {int(k): v for k, v in fx3["locks"].items()}
    fx3["tuning"]["history"][0]["adopted"] = True
    lb3 = build(fx3, "2026-09-14T12:00:00Z")["learning"]
    assert lb3["refit"]["verdict"] == "adopted" and lb3["refit"]["adopted"] is True
    # no archive -> nothing claimed
    fx4 = json.loads(json.dumps(fx))
    fx4["locks"] = {int(k): v for k, v in fx4["locks"].items()}
    fx4["tuning"] = None
    lb4 = build(fx4, "2026-09-14T12:00:00Z")["learning"]
    assert lb4["refit"] is None and lb4["consumed_all"] is None and lb4["graded_locks_total"] == 2
    assert newest_refit({"history": [{"kind": "game_params", "search": None, "eval_seasons": [2025],
                                      "n_resolved": 999, "adopted": True}]}) is None, \
        "a backtest entry is never the in-season pass"
    # on-disk convention
    blob = json.dumps(doc, ensure_ascii=True, indent=2) + "\n"
    assert json.loads(blob) == doc


def _selftest_r73():
    """R73 owner decision 3 on the stake fixture: reviewed parlay rows + the R58
    ledger rows that price them. Every number below is the rule applied by hand."""
    fx = _load(os.path.join(FIXTURE_DIR_R73, "stake_fixture.json"))
    idx = ledger_price_index(fx["parlay_ledger"])
    assert idx[(1, "G1", "moneyline", "AAA ML")] == 0.5 and len(idx) == 8
    assert ledger_price_index({"legs": [{"week": 1, "game_id": "G", "market": "moneyline",
                                         "selection": "X ML"}]}) == {}, "no price is no price"
    s = stake_100(fx["parlays"], fx["week"], idx)
    w, g = s["week"], s["game"]
    # week scope: all_hit 2.0 x 4.0 -> +700; push (void at 1.0) 2.0 -> +100; partial -100;
    # pending excluded from staked / net, counted in n
    assert (w["n"], w["graded"], w["hit"], w["push"], w["staked"]) == (4, 3, 1, 1, 300.0), w
    assert w["net_fair"] == 700.0 + 100.0 - 100.0 == 700.0, w["net_fair"]
    assert w["assumed_price_legs"] == 0, w
    v = lambda ip: 1.0 / min(VIG2_CAP, ip * VIG2_FACTOR)  # noqa: E731
    exp_w = STAKE * (v(0.5) * v(0.25) - 1) + STAKE * (v(0.5) - 1) - STAKE
    assert w["net_vig2"] == round(exp_w, 2) == 665.01, (w["net_vig2"], exp_w)
    # game scope: ML 2.0 x prop assumed 1.9091 -> +281.82; all_missed -100; a 0.995
    # favourite +0.5 fair but its vig price caps at 0.99 -> +1.01; a hit ML leg the
    # ledger never saw is assumed too
    assert (g["n"], g["graded"], g["hit"], g["push"], g["staked"]) == (4, 4, 3, 0, 400.0), g
    exp_g = STAKE * (2.0 * ASSUMED_DECIMAL - 1) - STAKE + STAKE * (1 / 0.995 - 1) \
        + STAKE * (ASSUMED_DECIMAL - 1)
    assert g["net_fair"] == round(exp_g, 2) == 273.23, (g["net_fair"], exp_g)
    assert round(STAKE * (2.0 * ASSUMED_DECIMAL - 1), 2) == 281.82, "ML 2.0 x prop -110 by hand"
    ip_a = 1.0 / ASSUMED_DECIMAL
    exp_gv = STAKE * (v(0.5) * v(ip_a) - 1) - STAKE + STAKE * (1 / VIG2_CAP - 1) \
        + STAKE * (v(ip_a) - 1)
    assert g["net_vig2"] == round(exp_gv, 2) == 255.17, (g["net_vig2"], exp_gv)
    assert round(1 / VIG2_CAP - 1, 4) == 0.0101, "the cap binds at 0.99"
    assert g["assumed_price_legs"] == 2 and "2 leg(s) with no book price" in g["note"], g["note"]
    assert "Display-only" in w["note"] and "4 week-scope parlays: 3 graded" in w["note"], w["note"]
    # nothing graded -> staked 0, net null (never 0); no rows -> the same
    z = stake_100([fx["parlays"][3]], 1, idx)["week"]
    assert z == {"n": 1, "graded": 0, "hit": 0, "push": 0, "staked": 0.0, "net_fair": None,
                 "net_vig2": None, "assumed_price_legs": 0, "note": z["note"]}, z
    assert stake_100([], 1, {})["game"]["n"] == 0 and stake_100([], 1, {})["game"]["net_fair"] is None
    # wired into the document (r71 fixture: its ledger rows carry no price, so every
    # graded leg is assumed) and the schema
    doc = build(_fixture_inputs(), "2026-09-14T12:00:00Z")
    st = doc["weeks"]["1"]["summary"]["parlays"]["stake_100"]
    assert set(st) == {"week", "game"} and st["week"]["n"] == 2 and st["game"]["n"] == 3
    assert st["game"]["graded"] == 2 and st["game"]["staked"] == 200.0 \
        and st["game"]["net_fair"] == round(STAKE * (ASSUMED_DECIMAL ** 2 - 1) - STAKE, 2), st["game"]
    assert st["week"]["graded"] == 1 and st["week"]["push"] == 1 \
        and st["week"]["net_fair"] == round(STAKE * (ASSUMED_DECIMAL - 1), 2), st["week"]
    assert not _validate_against_schema(doc)
    bad = json.loads(json.dumps(doc))
    bad["weeks"]["1"]["summary"]["parlays"]["stake_100"]["week"]["net_fair"] = "700"
    assert _validate_against_schema(bad), "a string net is red"
    del bad["weeks"]["1"]["summary"]["parlays"]["stake_100"]
    assert _validate_against_schema(bad), "stake_100 is required on every week block"

    # R75 — every row carries its own $100 figure, and the SETTLED rows of a
    # scope sum to that scope's footer. This is the whole point of routing both
    # through parlay_money: a card and the week footer cannot disagree.
    rows = fx["parlays"]
    stamp_parlay_money(rows, fx["week"], idx)
    assert all("money" in r for r in rows), "every row is stamped, pending included"
    for scope in ("week", "game"):
        settled = [r["money"] for r in rows
                   if r.get("scope") == scope and r["money"]["kind"] == "settled"]
        foot = s[scope]
        assert len(settled) == foot["graded"], (scope, len(settled), foot["graded"])
        assert abs(sum(m["net_fair"] for m in settled) - foot["net_fair"]) <= 0.01 * len(settled)
        assert abs(sum(m["net_vig2"] for m in settled) - foot["net_vig2"]) <= 0.01 * len(settled)
        assert sum(m["assumed_price_legs"] for m in settled) == foot["assumed_price_legs"]
    # a pending row is quoted, never settled: the return if every leg hits, at one
    # price (net_vig2 null). The week fixture's pending parlay is AAA ML (0.5) x
    # EEE ML (0.6) -> 2.0 x 1.6667, quoted even though one leg has not kicked off.
    pend = [r for r in rows if r["money"]["kind"] == "potential"]
    assert len(pend) == 1 and pend[0]["bucket"] == "pending", pend
    assert [l["result"] for l in pend[0]["legs"]] == ["hit", "pending"], "a live parlay"
    assert pend[0]["money"]["net_fair"] \
        == round(STAKE * ((1 / 0.5) * (1 / 0.6) - 1), 2) == 233.33, pend[0]["money"]
    assert pend[0]["money"]["net_vig2"] is None, "a quote is one price, not two"
    # a potential quote prices EVERY leg; a settled one only the legs that hit.
    one = [r for r in rows if r.get("scope") == "week" and r["bucket"] == "partial"][0]
    assert one["money"]["kind"] == "settled" and one["money"]["net_fair"] == -100.0
    assert potential_return(one, fx["week"], idx)[0] > 0, "the same parlay quotes positive"
    # and in the built document, where the r71 fixture's legs are all assumed
    prow = {r["parlay_id"]: r for r in doc["weeks"]["1"]["parlays"]}
    assert all("money" in r for r in prow.values()) and not _validate_against_schema(doc)
    bad2 = json.loads(json.dumps(doc))
    del bad2["weeks"]["1"]["parlays"][0]["money"]
    assert _validate_against_schema(bad2), "money is required on every parlay row"
    bad2 = json.loads(json.dumps(doc))
    bad2["weeks"]["1"]["parlays"][0]["money"]["kind"] = "guess"
    assert _validate_against_schema(bad2), "kind is settled or potential, nothing else"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true", help="committed inputs only; no network")
    ap.add_argument("--finals", default=None, help="JSON list of ESPN-shaped FINAL rows")
    ap.add_argument("--stats-csv", default=None, help="nflverse stats_player_week CSV path")
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--season", type=int, default=None)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    run(offline=args.offline, finals_path=args.finals, stats_csv=args.stats_csv,
        out_path=args.out, season=args.season)
    return 0


if __name__ == "__main__":
    sys.exit(main())
