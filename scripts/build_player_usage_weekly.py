"""BUILD data/player_usage_weekly.json — WITHIN-SEASON, through-week-N usage
aggregates from nflverse stats_player_week.

WHY THIS EXISTS AND WHY IT IS IN-SEASON ONLY
--------------------------------------------
Season-to-season, usage is nearly collinear with fantasy points: regressing next
season's points on last season's usage adds only +0.005 R2 over last season's
points alone. It restates what the points already say, so it does not belong on
the pregame/preseason path. WITHIN a season it is a different variable: usage
through week 6 -> rest-of-season PPG (n=480) adds TE +0.044, WR +0.027,
RB +0.024 R2. Those are the measured numbers this artifact is built for, and the
only claim made anywhere in it.

data/player_usage_history.json cannot serve this: it is SEASON-level (one share
per player per season), so it has no within-season cut to take. This builder
therefore reads stats_player_week (per-player-per-week) and emits CUMULATIVE
through-week-N aggregates, so a consumer asks for "usage through week 6" by
lookup, and the player harness can walk cuts forward without recomputing.

WHAT IS EMITTED PER PLAYER PER CUT
----------------------------------
    targets, carries              summed over weeks 1..N
    receiving_epa                 summed over weeks 1..N
    target_share                  sum(targets) / sum(team targets)
    air_yards_share               sum(rec air yards) / sum(team PASSING air yards)
    wopr                          1.5 * target_share + 0.7 * air_yards_share
    racr                          sum(rec yards) / sum(rec air yards), null if 0

DENOMINATOR RULE (stated because it is a real modelling choice): a player's
share denominator accumulates only over the TEAM-WEEKS HE APPEARS IN. A player
who missed three games is not diluted by his team's volume in games he did not
play, and a mid-season trade is attributed to whichever team he was on that
week. `games` (his appearances) and the per-cut `team_games` map are both
emitted so a consumer who wants the availability-diluted variant can build it.

HONESTY
-------
  * Nothing here may be applied at non-zero weight. It is raw material; a signal
    built on it ships at WEIGHT 0 behind the never-regress gate. Enforced by
    contract: __meta__.applied_weight is pinned to 0 by enum.
  * The per-week recomputation is RECONCILED against nflverse's own
    target_share / air_yards_share / wopr columns and the measured max abs
    difference is written into __meta__.reconciliation. A claim of "our math
    matches upstream" is not made, it is measured.
  * A cut is emitted only when the season actually reached that week. Requested
    cuts that a season never reached are recorded in cuts_skipped with a reason,
    never quietly produced from a short season.
  * Seasons whose feed fails are skipped LOUDLY into seasons_skipped; a partial
    run never silently narrows the artifact.

Runner-built like the other nflverse builders. --selftest runs the full
aggregation over a committed fixture and never writes data/.
"""

import csv
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.nflverse import FeedError, fetch_release_csv  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "player_usage_weekly.json")
FIXTURE = os.path.join(DATA, "fixtures", "nflverse_sample", "stats_player_week.csv")

RELEASE_URL = ("https://github.com/nflverse/nflverse-data/releases/download/"
               "stats_player/stats_player_week_%d.csv")

# Seasons to build. Immutable once written (a completed season never changes),
# so a rerun only fills gaps — same contract as player_usage_history.
SEASONS = (2023, 2024, 2025)

# Through-week cuts. MULTIPLE cuts by construction: the measurement that
# justified this feature used a single week-6 cut, and the point of building it
# this way is that a consumer is no longer stuck with one. Which cuts a season
# actually produced is recorded in __meta__.cuts_produced.
CUTS = (4, 6, 8, 10, 12, 14)

# Only these positions have a MEASURED within-season R2 delta (TE/WR/RB above).
# QBs are deliberately absent rather than emitted with no measurement behind them.
POSITIONS = ("RB", "WR", "TE")

RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}

MIN_ROWS = 800              # even one live week is ~1k stat lines
MIN_PLAYERS_PER_CUT = 200   # a real cut has hundreds of skill players
RECONCILE_TOL = 1e-6

MEASURED = {
    "within_season": {
        "design": "usage through week 6 -> rest-of-season PPG",
        "n": 480,
        "r2_delta_over_points_only": {"TE": 0.044, "WR": 0.027, "RB": 0.024},
    },
    "season_to_season": {
        "design": "prior-season usage -> next-season points",
        "r2_delta_over_points_only": 0.005,
        "verdict": "nearly collinear with points; NOT a pregame feature",
    },
}

LIMITS = [
    "The measurement behind this artifact used TWO seasons, ONE week-6 cut, no "
    "walk-forward across multiple cuts, and no held-out season. This builder "
    "removes the single-cut limit (see cuts_produced) but does NOT itself "
    "re-run that measurement — the wider cut grid is UNMEASURED until a "
    "harness walks it.",
    "Regular season only (season_type == 'REG'). Postseason rows are dropped.",
    "Share denominators accumulate over the team-weeks the player APPEARS in, "
    "not every team-week through the cut; `games` and `team_games` are emitted "
    "so the availability-diluted variant is reconstructable.",
    "racr is null, never 0, when a player has no receiving air yards through "
    "the cut (RBs and blocking TEs); 0 would be a fabricated ratio.",
    "racr has an UNSTABLE denominator: a player with a couple of cumulative "
    "air yards and a long catch takes values in the hundreds, and negative "
    "cumulative air yards (screen-heavy usage) make air_yards_share and racr "
    "negative. Both are the true ratios, not errors. `receiving_air_yards` is "
    "emitted next to them so a consumer applies its own volume guard.",
    "RB/WR/TE only. QB usage has no measured within-season R2 delta here, so "
    "no QB rows are emitted rather than shipping an unjustified column.",
    "Nothing here is applied at any weight. A signal built on it must earn "
    "weight through the never-regress gate, starting at 0.",
]


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _num(value):
    """CSV cell -> float. nflverse writes '' and 'NA' for absent; both are 0.0
    for a SUMMABLE counting stat (a player with no targets truly had none)."""
    if value is None:
        return 0.0
    s = str(value).strip()
    if s == "" or s == "NA":
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _opt(value):
    """CSV cell -> float or None. For upstream columns used in RECONCILIATION,
    where absent must stay absent instead of becoming a comparable 0.0."""
    if value is None:
        return None
    s = str(value).strip()
    if s == "" or s == "NA":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _team(value):
    t = (value or "").strip().upper()
    return RENAMES.get(t, t)


def _int_or_none(value):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def reg_rows(rows):
    """Regular-season rows with a usable player id, team and week."""
    out = []
    for r in rows:
        if (r.get("season_type") or "").strip().upper() != "REG":
            continue
        pid = (r.get("player_id") or "").strip()
        wk = _int_or_none(r.get("week"))
        tm = _team(r.get("team"))
        if not pid or wk is None or not tm:
            continue
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def team_week_totals(rows):
    """{(team, week): {targets, pass_air}} — the share denominators, rebuilt
    from the same weekly rows (every position, not just POSITIONS, so the
    denominator is the team's real volume)."""
    totals = {}
    for r in rows:
        key = (_team(r.get("team")), _int_or_none(r.get("week")))
        t = totals.setdefault(key, {"targets": 0.0, "pass_air": 0.0})
        t["targets"] += _num(r.get("targets"))
        t["pass_air"] += _num(r.get("passing_air_yards"))
    return totals


def reconcile(rows, totals):
    """MEASURE our per-week recomputation against nflverse's own columns.

    Returns {checked, max_abs_target_share, max_abs_air_yards_share,
    max_abs_wopr, tolerance, holds}. Rows where upstream has no value are not
    compared (and are counted out), so this can never be made to pass by
    comparing nothing — `checked` is in the artifact.
    """
    worst = {"target_share": 0.0, "air_yards_share": 0.0, "wopr": 0.0}
    checked = 0
    for r in rows:
        key = (_team(r.get("team")), _int_or_none(r.get("week")))
        tot = totals.get(key)
        if not tot or not tot["targets"] or not tot["pass_air"]:
            continue
        up_ts = _opt(r.get("target_share"))
        up_ay = _opt(r.get("air_yards_share"))
        up_wo = _opt(r.get("wopr"))
        if up_ts is None or up_ay is None or up_wo is None:
            continue
        ts = _num(r.get("targets")) / tot["targets"]
        ay = _num(r.get("receiving_air_yards")) / tot["pass_air"]
        worst["target_share"] = max(worst["target_share"], abs(ts - up_ts))
        worst["air_yards_share"] = max(worst["air_yards_share"], abs(ay - up_ay))
        worst["wopr"] = max(worst["wopr"], abs(1.5 * ts + 0.7 * ay - up_wo))
        checked += 1
    return {
        "checked": checked,
        "max_abs_target_share": round(worst["target_share"], 12),
        "max_abs_air_yards_share": round(worst["air_yards_share"], 12),
        "max_abs_wopr": round(worst["wopr"], 12),
        "tolerance": RECONCILE_TOL,
        "holds": bool(checked) and max(worst.values()) <= RECONCILE_TOL,
    }


def player_index(rows):
    """{pid: {name, pos}} for every POSITIONS player in the season.

    Identity is season-stable, usage is not, so name/position live here ONCE
    instead of being repeated inside all six cuts. `team` stays on the cut
    record because a traded player's team is a function of the cut."""
    idx = {}
    for r in rows:
        pos = (r.get("position") or "").strip().upper()
        if pos not in POSITIONS:
            continue
        pid = (r.get("player_id") or "").strip()
        idx[pid] = {"name": (r.get("player_display_name") or "").strip(), "pos": pos}
    return idx


def cut_aggregate(rows, totals, through_week):
    """Through-week-N aggregate. Returns (players dict, team_games dict).

    players[pid] = {team, games, targets, carries, target_share,
                    air_yards_share, wopr, racr, receiving_epa}
    Name and position are NOT repeated here — see player_index().
    """
    acc = {}
    team_games = {}
    for r in rows:
        wk = _int_or_none(r.get("week"))
        if wk is None or wk > through_week:
            continue
        tm = _team(r.get("team"))
        team_games.setdefault(tm, set()).add(wk)
        if (r.get("position") or "").strip().upper() not in POSITIONS:
            continue
        pid = (r.get("player_id") or "").strip()
        tot = totals.get((tm, wk)) or {"targets": 0.0, "pass_air": 0.0}
        p = acc.get(pid)
        if p is None:
            p = acc[pid] = {
                "team": tm, "last_week": wk, "games": 0,
                "targets": 0.0, "carries": 0.0, "rec_air": 0.0,
                "rec_yards": 0.0, "receiving_epa": 0.0,
                "den_targets": 0.0, "den_pass_air": 0.0,
            }
        if wk >= p["last_week"]:
            p["last_week"] = wk
            p["team"] = tm            # trades: the team he is on at the cut
        p["games"] += 1
        p["targets"] += _num(r.get("targets"))
        p["carries"] += _num(r.get("carries"))
        p["rec_air"] += _num(r.get("receiving_air_yards"))
        p["rec_yards"] += _num(r.get("receiving_yards"))
        p["receiving_epa"] += _num(r.get("receiving_epa"))
        p["den_targets"] += tot["targets"]
        p["den_pass_air"] += tot["pass_air"]

    out = {}
    for pid, p in acc.items():
        if p["targets"] + p["carries"] <= 0:
            continue              # never touched the ball: nothing to aggregate
        ts = p["targets"] / p["den_targets"] if p["den_targets"] > 0 else 0.0
        ay = p["rec_air"] / p["den_pass_air"] if p["den_pass_air"] > 0 else 0.0
        # wopr is derived from the ROUNDED shares, not the full-precision ones,
        # so the emitted wopr is reproducible from the emitted target_share and
        # air_yards_share sitting next to it. Deriving it from full precision
        # left the three columns mutually inconsistent by up to 1.1e-4.
        ts, ay = round(ts, 4), round(ay, 4)
        out[pid] = {
            "team": p["team"],
            "games": p["games"],
            "targets": int(round(p["targets"])),
            "carries": int(round(p["carries"])),
            "receiving_air_yards": round(p["rec_air"], 1),
            "target_share": ts,
            "air_yards_share": ay,
            "wopr": round(1.5 * ts + 0.7 * ay, 4),
            # racr's denominator is emitted alongside it BECAUSE the ratio is
            # unstable at low volume (see LIMITS) — a consumer must be able to
            # guard it without refetching nflverse.
            "racr": round(p["rec_yards"] / p["rec_air"], 4) if p["rec_air"] > 0 else None,
            "receiving_epa": round(p["receiving_epa"], 3),
        }
    return out, {t: len(w) for t, w in sorted(team_games.items())}


def build_season(rows, cuts=CUTS):
    """Full per-season block. Returns (block, produced_cuts, skipped_cuts)."""
    rows = reg_rows(rows)
    weeks = sorted({_int_or_none(r.get("week")) for r in rows} - {None})
    totals = team_week_totals(rows)
    produced, skipped, cut_blocks = [], [], {}
    last_week = weeks[-1] if weeks else 0
    for n in cuts:
        if n > last_week:
            skipped.append({"cut": n, "reason":
                            "season reached week %d; through-week-%d does not exist yet"
                            % (last_week, n)})
            continue
        players, team_games = cut_aggregate(rows, totals, n)
        cut_blocks[str(n)] = {
            "n_players": len(players),
            "team_games": team_games,
            "players": players,
        }
        produced.append(n)
    block = {
        "weeks_available": weeks,
        "reconciliation": reconcile(rows, totals),
        "players": player_index(rows),
        "cuts": cut_blocks,
    }
    return block, produced, skipped


# ---------------------------------------------------------------------------
# Selftest — fixture-driven, writes nothing.
# ---------------------------------------------------------------------------

def selftest():
    with open(FIXTURE, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    # POST rows must never reach the aggregate.
    assert any((r.get("season_type") or "").upper() == "POST" for r in rows), \
        "fixture must contain a POST row for the exclusion test to mean anything"
    reg = reg_rows(rows)
    assert all(r["season_type"] == "REG" for r in reg), "POST row leaked through"

    block, produced, skipped = build_season(rows, cuts=(1, 2, 3, 4))
    assert block["weeks_available"] == [1, 2, 3], block["weeks_available"]
    # Cut 4 does not exist in a 3-week fixture and is reported, not invented.
    assert produced == [1, 2, 3], produced
    assert [s["cut"] for s in skipped] == [4], skipped
    assert "4" not in block["cuts"]

    c1 = block["cuts"]["1"]["players"]
    c2 = block["cuts"]["2"]["players"]
    c3 = block["cuts"]["3"]["players"]

    # --- week 1: KC targets 10, KC passing air yards 100 -------------------
    w = c1["00-WR1"]
    assert w["targets"] == 6 and w["games"] == 1, w
    assert abs(w["target_share"] - 0.6) < 1e-9, w
    assert abs(w["air_yards_share"] - 0.6) < 1e-9, w
    assert abs(w["wopr"] - (1.5 * 0.6 + 0.7 * 0.6)) < 1e-9, w
    assert abs(w["racr"] - 50.0 / 60.0) < 1e-4, w
    assert abs(w["receiving_air_yards"] - 60.0) < 1e-9, w
    assert abs(w["receiving_epa"] - 4.0) < 1e-9, w
    # Shares are a real partition: WR1 + TE1 own every KC target in week 1.
    assert abs(c1["00-WR1"]["target_share"] + c1["00-TE1"]["target_share"] - 1.0) < 1e-9

    # --- cumulative through week 2 (8 targets of 20; 80 air of 200) --------
    w = c2["00-WR1"]
    assert w["targets"] == 8 and w["games"] == 2, w
    assert abs(w["target_share"] - 0.4) < 1e-9, w
    assert abs(w["air_yards_share"] - 0.4) < 1e-9, w
    assert abs(w["racr"] - 1.0) < 1e-9, w
    assert abs(w["receiving_epa"] - 6.0) < 1e-9, w

    # --- trade in week 3: denominator follows the player, team is the new one
    w = c3["00-WR1"]
    assert w["team"] == "SF", w                       # KC wk1-2, SF wk3
    assert w["targets"] == 13 and w["games"] == 3, w
    assert abs(w["target_share"] - 13.0 / 25.0) < 1e-9, w      # 10 + 10 + 5
    assert abs(w["air_yards_share"] - 130.0 / 250.0) < 1e-9, w  # 100 + 100 + 50
    assert abs(w["racr"] - 105.0 / 130.0) < 1e-4, w
    assert abs(c3["00-TE1"]["target_share"] - 22.0 / 30.0) < 1e-4, c3["00-TE1"]

    # --- an RB with no receiving air yards reports racr null, never 0 ------
    rb = c3["00-RB1"]
    assert rb["racr"] is None, rb
    assert rb["receiving_air_yards"] == 0.0, rb   # the null's denominator, emitted
    assert rb["carries"] == 30 and rb["targets"] == 0, rb
    assert rb["target_share"] == 0.0 and rb["air_yards_share"] == 0.0, rb

    # --- identity lives once, in the season index, not in every cut -------
    assert block["players"]["00-WR1"] == {"name": "W. One", "pos": "WR"}, block["players"]
    assert sorted(block["players"]) == ["00-RB1", "00-TE1", "00-WR1"], block["players"]
    for rec in list(c1.values()) + list(c3.values()):
        assert "name" not in rec and "pos" not in rec, rec
    assert set(c3) <= set(block["players"]), "every cut player resolves in the index"

    # --- QBs are excluded; team_games counts the team's weeks --------------
    assert "00-QB1" not in c3 and "00-QB2" not in c3
    assert "00-QB1" not in block["players"]
    assert block["cuts"]["3"]["team_games"] == {"KC": 3, "SF": 1}, \
        block["cuts"]["3"]["team_games"]

    # --- cumulative aggregates are monotone in the counting stats ---------
    for pid, rec in c3.items():
        for k in ("targets", "carries", "games"):
            assert rec[k] >= c1.get(pid, {k: 0})[k], (pid, k)

    # --- reconciliation actually compares, and agrees with upstream -------
    rec = block["reconciliation"]
    assert rec["checked"] >= 4, rec
    assert rec["holds"] is True, rec
    assert rec["max_abs_target_share"] <= RECONCILE_TOL, rec

    # --- a fabricated upstream column makes reconciliation FAIL -----------
    bad = [dict(r) for r in reg]
    for r in bad:
        if r["player_id"] == "00-WR1" and r["week"] == "1":
            r["target_share"] = "0.99"
    assert reconcile(bad, team_week_totals(bad))["holds"] is False, \
        "reconciliation must red when upstream and our math disagree"

    print("selftest OK: through-week-N usage aggregation exact, "
          "reconciled against upstream, multi-cut")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    import datetime as dt

    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = (json.load(fh)).get("seasons") or {}

    seasons = dict(existing)
    produced_map = {}
    skipped_seasons = []
    skipped_cuts = {}
    built = 0

    for season in SEASONS:
        key = str(season)
        if key in seasons and seasons[key].get("cuts"):
            produced_map[key] = sorted(int(c) for c in seasons[key]["cuts"])
            continue
        try:
            rows = fetch_release_csv(RELEASE_URL % season,
                                     "stats_player_week_%d" % season,
                                     min_rows=MIN_ROWS)
        except FeedError as err:
            print("USAGE WEEKLY: %d fetch failed: %s" % (season, err), file=sys.stderr)
            skipped_seasons.append({"season": season, "reason": str(err)[:300]})
            continue
        block, produced, cut_skips = build_season(rows)
        thin = [n for n in produced
                if block["cuts"][str(n)]["n_players"] < MIN_PLAYERS_PER_CUT]
        if thin:
            print("USAGE WEEKLY: %d cuts %s under %d players; season skipped"
                  % (season, thin, MIN_PLAYERS_PER_CUT), file=sys.stderr)
            skipped_seasons.append({"season": season, "reason":
                                    "cuts %s under %d players — partial pull"
                                    % (thin, MIN_PLAYERS_PER_CUT)})
            continue
        if not block["reconciliation"]["holds"]:
            print("USAGE WEEKLY: %d reconciliation FAILED: %s"
                  % (season, block["reconciliation"]), file=sys.stderr)
            skipped_seasons.append({"season": season, "reason":
                                    "recomputed shares disagree with upstream columns"})
            continue
        seasons[key] = block
        produced_map[key] = produced
        if cut_skips:
            skipped_cuts[key] = cut_skips
        built += 1

    if not seasons:
        print("USAGE WEEKLY: nothing built; keeping existing file.", file=sys.stderr)
        return 1

    doc = {
        "__meta__": {
            "generated_utc": dt.datetime.now(dt.timezone.utc)
                               .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "nflverse stats_player_week release CSV (per-player-per-week)",
            # A TEMPLATE, left UNSUBSTITUTED. Substituting season zero here
            # produced the literal ".../stats_player_week_0.csv" — a dead URL
            # that a consumer reading the artifact's declared source 404s on.
            "source_url_template": RELEASE_URL.replace("%d", "{season}"),
            "grain": "through_week_cumulative",
            "season_type": "REG",
            "positions": list(POSITIONS),
            "metrics": ["targets", "carries", "target_share", "air_yards_share",
                        "wopr", "racr", "receiving_epa"],
            "supporting_columns": ["team", "games", "receiving_air_yards"],
            "applied_weight": 0,
            "policy": "IN-SEASON raw material only. Never applied at non-zero "
                      "weight here; a signal built on it ships at weight 0 "
                      "behind the never-regress gate.",
            "share_denominator": "sum of team targets / team PASSING air yards "
                                 "over the team-weeks the player appears in",
            "cuts_requested": list(CUTS),
            "cuts_produced": {k: sorted(v) for k, v in sorted(produced_map.items())},
            "cuts_skipped": skipped_cuts,
            "seasons_requested": list(SEASONS),
            "seasons_produced": sorted(int(k) for k in seasons),
            "seasons_skipped": skipped_seasons,
            "measured": MEASURED,
            "limits": LIMITS,
        },
        "seasons": seasons,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    n_cuts = sum(len(v["cuts"]) for v in seasons.values())
    print("Wrote player_usage_weekly.json: %d seasons, %d cuts (%d seasons built "
          "this run)" % (len(seasons), n_cuts, built))
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
