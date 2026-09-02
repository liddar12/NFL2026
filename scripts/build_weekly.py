"""Weekly per-player projection split (weekly_split_v1) -> data/player_weekly.json.

Pure + deterministic + stdlib only: scripts.build_predictions feeds it the season
projections, the full 2026 schedule, the Elo priors, and prior-season receptions.
No network here, so the gate can drive the math offline with fixtures.

The model — a transparent prior, NOT fitted:
  bye   -> pts 0.0 (a team is on bye in week W iff it plays no game that week
           in schedule_full; 2026 byes fall in weeks 5-14)
  base  = season_proj / games_scheduled (the team's non-bye week count, usually 17)
  tilt  = 1 + TILT_COEF * (team_elo - opp_elo) / 400, clamped to [0.75, 1.25]
  venue = 1 +/- HOME_COEF (home 1.02, away 0.98)
  then the weeks the player CAN PLAY are renormalized to sum exactly to his
  availability-adjusted season target — the tilt REDISTRIBUTES points across
  those weeks, it never inflates them.

TILT_COEF is recorded in the output meta on purpose: it is the parameter the P2
optimizer refits in-season against resolved weekly snapshot locks (NEVER-REGRESS
gated). Every row stays estimate=true until the harness proves otherwise.

TWO DISTINCT INJURY MECHANICS, and conflating them was the Rel17 defect.
scripts/availability.py owns the vocabulary that tells them apart.

  (a) WEEK-SHAPING — short-term news (Questionable / Doubtful / Out this week).
      data/injuries.json statuses map to a multiplier on the FIRST 3 weeks the
      player can play (Out 0.55, Doubtful 0.7, Questionable 0.9). The split is
      then renormalized so the season total is preserved EXACTLY: a questionable
      player is still going to play a full season, so the injury shifts the SHAPE
      toward the healthy back weeks and nothing else. This is unchanged, and it is
      correct for its case.

  (b) UNAVAILABILITY — long-term absence (IR / PUP / NFI / suspension, or any
      status whose report text states an unambiguous duration). The blocked weeks
      are zeroed and EXCLUDED from the renormalization, so the season total
      ACTUALLY DROPS, pro-rata to the games the player can play. Before Rel17
      mechanic (a) was the only one that existed, which meant an injury merely
      RESHAPED the curve and a player who will not take a snap all year still
      carried 100% of his season points.

  A season-class player with no parsed duration falls to the documented four-game
  league floor (availability.MIN_WEEKS_OUT), stamped confidence="rule" so no
  surface can present a floor as a measurement. A suspension of unstated length
  blocks NOTHING and is flagged only — we do not know how long, and honest data
  beats a convenient guess.

When injuries.json is absent or empty the output is byte-identical to the
injury-free build, and the model meta records injury_shape / availability only
when at least one player was actually shaped / actually blocked.

INVARIANT: output player order mirrors data/player_projections.json exactly
(same ids, same order) — the app zips the two files by index.

R49 — ABSENCE ALREADY IN THE TOTAL. When a projection row was built under the
games-normalized baseline (`baseline_rule` == "prior_ppg_x_projected_games") with a
documented `absence_weeks` > 0, its proj_points ALREADY excludes the blocked games
(prior_ppg x (17 - absence)). Mechanic (b) then zeroes the same weeks but
renormalizes the playable weeks to the FULL season number instead of a pro-rata
share — otherwise the absence would be subtracted twice. `season_points_lost` on
such a row is the projection's own per-game rate times the weeks zeroed, so the
headline still says how many points the absence cost. Rows under the total rule
(the shipped rule today) are byte-identical to the pre-R49 split.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import availability  # noqa: E402

INJURIES_PATH = os.path.join(_ROOT, "data", "injuries.json")

WEEKS = 18
INJURY_WEEKS = 3    # injury shaping horizon: the FIRST 3 PLAYABLE non-bye weeks
# status -> near-term availability multiplier (documented prior, NOT fitted).
# Verbatim ESPN spellings, deliberately unchanged: the canonical reading is derived
# from this table below, never the other way round.
INJURY_MULT = {"Out": 0.55, "Doubtful": 0.7, "Questionable": 0.9}
# The same prior re-keyed onto the canonical vocabulary, DERIVED so the two can
# never drift. Anything outside it (ACTIVE, and every season-class code — those are
# handled by mechanic (b), not by a multiplier) multiplies by 1.0 and is dropped.
INJURY_MULT_CANON = {availability.normalize_status(k): v
                     for k, v in INJURY_MULT.items()}
# A None key here would be catastrophic and silent: injury_multipliers looks up an
# unrecognised status as None, so an unmappable INJURY_MULT key would hand EVERY
# unknown status that key's discount. Refuse to import instead.
assert None not in INJURY_MULT_CANON, (
    f"INJURY_MULT has a status scripts/availability.py cannot read: "
    f"{sorted(k for k in INJURY_MULT if availability.normalize_status(k) is None)}"
)
assert set(INJURY_MULT_CANON) <= availability.WEEK_CLASS, (
    "INJURY_MULT is mechanic (a) only — a season-class code must reduce the total "
    "via unavailability(), not merely reshape the curve via a multiplier."
)
TILT_COEF = 0.5     # Elo-tilt strength; the optimizer-refit parameter (see above)
HOME_COEF = 0.02    # home 1.02 / away 0.98
TILT_MIN = 0.75     # clamp so one lopsided matchup can't swallow the season
TILT_MAX = 1.25
ELO_INIT = 1500.0   # mirrors scripts.models.elo.INIT (league-average prior)
MODEL_NAME = "weekly_split_v1"
MODEL_NOTES = (
    "Season projection split evenly across scheduled weeks, tilted by Elo matchup "
    "and home/away, then renormalized so non-bye weeks sum exactly to the season "
    "projection. TILT_COEF is a transparent prior the optimizer refits in-season."
)


def load_injuries(path=INJURIES_PATH):
    """Injury rows from data/injuries.json; absent/unreadable/empty -> [].

    Graceful BY CONTRACT, unlike the feeds: a missing injuries file means
    "shape nothing" and the weekly output stays byte-identical to the
    injury-free build. Loudness lives upstream in espn.fetch_injuries.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return []
    return doc.get("injuries") or []


def _norm_name(name):
    """Casefold + strip periods so 'A.J. Brown' joins 'AJ Brown'.

    Delegates to scripts.availability so the join key has ONE definition.
    """
    return availability.norm_name(name)


def injury_multipliers(projections, injuries):
    """{gsis_id: multiplier} for projected players whose status shapes the split.

    Join on (team, normalized player name); a player with several report rows
    keeps the WORST (lowest) multiplier. Statuses outside INJURY_MULT map to
    1.0 and are dropped, so an all-Active report is a clean no-op and only the
    players actually shaped are returned (their count is statuses_used).

    Lookup runs through the canonical vocabulary, so an unrecognised spelling and
    a season-class status alike fall to 1.0 exactly as before — mechanic (b), not
    a multiplier, is what handles a long-term absence.
    """
    by_key = {}
    # R30c — the name-only fallback for offseason movers (the incident is
    # documented at availability.index_report_by_name: the pool's team column
    # lags the report's, so Mike Evans/Kirk/Waller were Questionable in a fresh
    # feed and rendered healthy). Same discipline as the view join: a report
    # name on more than one team is ambiguous and excluded; a pool-duplicated
    # name never falls back.
    by_name = {}
    name_teams = {}
    for row in injuries or []:
        code = availability.normalize_status(row.get("status"))
        mult = INJURY_MULT_CANON.get(code, 1.0)
        if mult >= 1.0:
            continue
        nm = _norm_name(row.get("player"))
        key = (row.get("team"), nm)
        by_key[key] = min(by_key.get(key, 1.0), mult)
        name_teams.setdefault(nm, set()).add(row.get("team"))
        by_name[nm] = min(by_name.get(nm, 1.0), mult)
    by_name = {n: m for n, m in by_name.items() if len(name_teams[n]) == 1}
    ambiguous = availability.dup_names(projections)
    out = {}
    for p in projections:
        nm = _norm_name(p.get("name"))
        mult = by_key.get((p.get("team"), nm))
        if mult is None and nm not in ambiguous:
            mult = by_name.get(nm)
        if mult is not None:
            out[p["gsis_id"]] = mult
    return out


def unavailability(projections, injuries):
    """{gsis_id: availability view} for projected players who are NOT active.

    Sibling to injury_multipliers and joined the same way (team + normalized name,
    worst report row wins). The view carries the canonical status, its mechanic
    class, and — for a season-class absence — the parsed duration and the sentence
    that stated it:

        {"status", "class", "weeks_out", "out_for_season", "confidence", "evidence"}

    Rows whose status does not normalize are dropped by index_report: unknown is
    not a discount, and the loud complaint about the drift belongs at the scraper
    and at the gate, never in a silent consumer.
    """
    index = availability.index_report(injuries)
    # R30c — offseason movers: exact (team, name) first, unique name second.
    by_name = availability.index_report_by_name(injuries)
    ambiguous = availability.dup_names(projections)
    out = {}
    for p in projections:
        view = availability.lookup_report(index, by_name, p.get("team"),
                                          p.get("name"), ambiguous)
        if not view or view["availability"] == availability.ACTIVE:
            continue
        cls = view.get("availability_class")
        if cls is None:
            continue
        out[p["gsis_id"]] = {
            "status": view["availability"],
            "class": cls,
            "weeks_out": view.get("weeks_out"),
            "out_for_season": bool(view.get("out_for_season")),
            "confidence": view.get("confidence"),
            "evidence": view.get("evidence"),
        }
    return out


def blocked_week_count(view):
    """(weeks_to_block, confidence) for one availability view. Never a guess.

    out_for_season          -> every remaining non-bye week      ("explicit")
    weeks_out: N            -> N                                 ("explicit")
    IR / PUP / NFI, no text -> availability.MIN_WEEKS_OUT        ("rule")
    SUSPENDED, no text      -> 0, flagged only                   (None)
    class "week"            -> 0 (shaping only)                  (None)
    """
    if view is None or view.get("class") != "season":
        return 0, None
    if view.get("out_for_season"):
        return WEEKS, "explicit"          # truncated to the real non-bye count
    if view.get("weeks_out"):
        return int(view["weeks_out"]), "explicit"
    if view.get("status") in (availability.IR, availability.PUP, availability.NFI):
        return availability.MIN_WEEKS_OUT, "rule"
    return 0, None                        # SUSPENDED of unstated length


def team_schedule(schedule_games):
    """{team: {week: (opp, home_bool)}} from schedule_full-shaped game rows.

    Bye detection falls out of this map: a team is on bye in week W iff W is
    absent from its entry (it appears in no game that week).
    """
    sched = {}
    for g in schedule_games:
        wk = g["week"]
        sched.setdefault(g["home"], {})[wk] = (g["away"], True)
        sched.setdefault(g["away"], {})[wk] = (g["home"], False)
    return sched


# R49 — the projection rule whose season total already excludes documented absence.
ABSENCE_IN_TOTAL_RULE = "prior_ppg_x_projected_games"


def absence_in_total(projection_row):
    """True iff this projection row's proj_points already excludes its blocked
    games (R49 games-normalized rule with a documented absence). Pure."""
    return (projection_row.get("baseline_rule") == ABSENCE_IN_TOTAL_RULE
            and int(projection_row.get("absence_weeks") or 0) > 0)


def shipped_ratio(projection_row, prior_season_points):
    """R49 override — proj_points_new / prior_season_points for one player: the
    games normalization + full-strength signals the shipped number now carries
    relative to the prior-season total the component line was measured on.
    1.0 when the prior total is unknown or zero (nothing to scale by)."""
    try:
        prior = float(prior_season_points or 0.0)
        shipped = float(projection_row.get("proj_points") or 0.0)
    except (TypeError, ValueError):
        return 1.0
    if prior <= 0 or shipped <= 0:
        return 1.0
    return shipped / prior


def scale_prior_lines(ratio, receptions=None, completions=None, components=None):
    """R49 override — scale a player's prior-season pricing lines by `ratio` so
    the league extras move WITH the shipped number: receptions_prior,
    completions_prior, every league_components quantity and base_applied_pts
    (all linear in quantity, so sum(base_rate x qty) still reproduces
    base_applied_pts within the client's 1.0 check — app/team-logic.js
    componentDelta). `bonus_games` is a COUNT and is left untouched. Pure;
    returns (receptions, completions, components) with the same absence
    semantics as the inputs (None stays None)."""
    r = float(ratio)
    rec = None if receptions is None else round(float(receptions) * r, 1)
    cmp = None if completions is None else round(float(completions) * r, 1)
    comp = None
    if components:
        comp = dict(components)
        if comp.get("components"):
            comp["components"] = {k: round(float(v) * r, 1)
                                  for k, v in comp["components"].items()}
        if comp.get("base_applied_pts") is not None:
            comp["base_applied_pts"] = round(float(comp["base_applied_pts"]) * r, 2)
    return rec, cmp, comp


def player_weeks(season_proj, team, sched_by_team, elos, injury_mult=1.0,
                 unavailable_weeks=0, first_week=1, round_dp=2,
                 absence_in_total=False):
    """18 week rows {wk, opp, home, bye, pts} for one player.

    Pass round_dp=None to skip the final rounding (the injury test asserts the
    exact-preservation invariant to 1e-6 on the unrounded split).

    injury_mult (< 1.0) is mechanic (a): it discounts the first INJURY_WEEKS weeks
    the player CAN PLAY, before the renormalization, so the injury shifts the SHAPE
    toward the later weeks while the season target stays law.

    unavailable_weeks (> 0) is mechanic (b): the first `unavailable_weeks` non-bye
    weeks with wk >= first_week are BLOCKED — set to pts 0.0, marked
    "avail": False, and excluded from the renormalization entirely. The remaining
    weeks are renormalized to a PRO-RATA target, so the season total actually
    drops. A player out four of seventeen games carries 13/17 of his projection,
    not all of it.

    Step order matters: the partition happens BEFORE the week-shaping, so a player
    out four weeks and questionable after does not have his ding applied to weeks
    he was never going to play.

    At unavailable_weeks=0 this is numerically identical to the pre-Rel17 split,
    path for path, and emits no `avail` key at all.

    absence_in_total (R49): the caller states that `season_proj` ALREADY excludes
    the blocked games (games-normalized baseline). The blocked weeks are still
    zeroed, but the playable weeks renormalize to the FULL season_proj rather than
    a pro-rata share, so the absence is not subtracted twice. Ignored when nothing
    is blocked.
    """
    sched = sched_by_team.get(team, {})
    team_elo = elos.get(team, ELO_INIT)
    base = season_proj / len(sched) if sched else 0.0

    raw = []  # indices of non-bye weeks, in week order
    rows = []
    for wk in range(1, WEEKS + 1):
        game = sched.get(wk)
        if game is None:
            rows.append({"wk": wk, "opp": None, "home": False, "bye": True, "pts": 0.0})
            continue
        opp, home = game
        tilt = 1.0 + TILT_COEF * (team_elo - elos.get(opp, ELO_INIT)) / 400.0
        tilt = min(TILT_MAX, max(TILT_MIN, tilt))
        venue = 1.0 + HOME_COEF if home else 1.0 - HOME_COEF
        rows.append({"wk": wk, "opp": opp, "home": home, "bye": False,
                     "pts": base * tilt * venue})
        raw.append(len(rows) - 1)

    # PARTITION — blocked weeks are the player's absence; available weeks are the
    # only ones that carry points or get renormalized.
    n_total = len(raw)
    n_block = max(0, int(unavailable_weeks or 0))
    blocked = [i for i in raw if rows[i]["wk"] >= first_week][:n_block]
    blocked_set = set(blocked)
    available = [i for i in raw if i not in blocked_set]

    # Mechanic (a): shape the first INJURY_WEEKS PLAYABLE weeks only.
    if injury_mult != 1.0:
        for i in available[:INJURY_WEEKS]:
            rows[i]["pts"] *= injury_mult

    # Renormalize the playable weeks to the availability-adjusted target. With no
    # blocked weeks the target IS the season projection and this is the old law.
    if absence_in_total and blocked:
        target = season_proj
    else:
        target = (season_proj * len(available) / n_total) if n_total else 0.0
    total = sum(rows[i]["pts"] for i in available)
    scale = (target / total) if total > 0 else 0.0
    for i in available:
        pts = rows[i]["pts"] * scale
        rows[i]["pts"] = round(pts, round_dp) if round_dp is not None else pts
    for i in blocked:
        rows[i]["pts"] = 0.0
        rows[i]["avail"] = False   # emitted ONLY when false; absent means available
    return rows


def build_weekly_document(projections, schedule_games, elos, receptions_by_id,
                          season, updated_utc, injuries=None,
                          injuries_path=INJURIES_PATH, first_week=1,
                          completions_by_id=None, components_by_id=None):
    """The full player_weekly.json document. Pure given its inputs.

    projections: player_projections.json's `players` list (order is preserved).
    schedule_games: schedule_full.json's `games` list (all 272 rows, all weeks).
    elos: {team: rating} — the SAME preseason priors the game model used.
    receptions_by_id: {gsis_id: prior-season receptions} (0.0 when absent).
    injuries: injury rows (see load_injuries); None -> read injuries_path from
    disk (absent/empty file -> no shaping, byte-identical output). Tests pass
    the list directly so the function stays pure under test.
    first_week: the first week an absence can block (1 preseason; the current
    week in-season, so a player's past weeks are never retro-zeroed).

    Every availability shape is emitted ONLY when non-empty, so an all-healthy
    build is byte-identical to the pre-Rel17 document.
    """
    if injuries is None:
        injuries = load_injuries(injuries_path)
    mults = injury_multipliers(projections, injuries)
    unavail = unavailability(projections, injuries)
    sched_by_team = team_schedule(schedule_games)

    players = []
    n_blocked_players = 0
    n_season_ending = 0
    points_removed = 0.0
    for p in projections:
        pid = p["gsis_id"]
        view = unavail.get(pid)
        n_block, confidence = blocked_week_count(view)
        in_total = absence_in_total(p)
        weeks = player_weeks(p["proj_points"], p["team"], sched_by_team, elos,
                             injury_mult=mults.get(pid, 1.0),
                             unavailable_weeks=n_block, first_week=first_week,
                             absence_in_total=in_total)
        row = {
            "gsis_id": pid,
            "receptions_prior": round(float(receptions_by_id.get(pid, 0.0) or 0.0), 1),
        }
        # R28 — COMPLETIONS, on the same row and by the same route as receptions.
        #
        # receptions_prior exists so the client can convert PPR <-> Half <->
        # Standard exactly rather than scaling a total; completions_prior exists
        # for the same reason and for the same kind of rule (Sleeper's
        # `pass_cmp`), which real leagues score and this app has been silently
        # dropping. Emitted ONLY when a completion count is actually known and
        # non-zero, so every non-passer and every build without the feed is
        # byte-identical to the pre-R28 document — a zero here would be a claim
        # ("this quarterback completed no passes") rather than a silence.
        _cmp = float((completions_by_id or {}).get(pid, 0.0) or 0.0)
        if _cmp > 0:
            row["completions_prior"] = round(_cmp, 1)
        # R44 — the verified component stat line, by the same emit-only-when-
        # known rule: a player whose kona entry failed self-verification (or a
        # build without the feed) ships NO component fields and is byte-
        # identical to the pre-R44 document. league_components and
        # base_applied_pts travel TOGETHER — the client's delta needs both,
        # and one without the other would be an unusable half-claim.
        _comp = (components_by_id or {}).get(pid)
        if _comp and _comp.get("components") and _comp.get("base_applied_pts") is not None:
            row["league_components"] = dict(_comp["components"])
            row["base_applied_pts"] = _comp["base_applied_pts"]
            if _comp.get("bonus_games"):
                row["bonus_games"] = dict(_comp["bonus_games"])
        if view is not None:
            block = {"status": view["status"], "class": view["class"]}
            actually_blocked = sum(1 for w in weeks if w.get("avail") is False)
            if actually_blocked:
                # The five season keys ride ONLY on a player whose weeks really were
                # zeroed. A flagged-but-unblocked row (a suspension of unstated
                # length) states nothing about duration, so it claims nothing.
                if in_total:
                    # R49: the total already excludes these games, so the loss
                    # is stated at the projection's own per-game rate (or the
                    # prior rate when every game is gone), never re-subtracted.
                    pg = p.get("projected_games") or 0
                    per_game = (p["proj_points"] / pg) if pg else \
                        float(p.get("prior_ppg") or 0.0)
                    lost = round(per_game * actually_blocked, 2)
                else:
                    lost = round(p["proj_points"] - sum(w["pts"] for w in weeks), 2)
                # weeks_out here is what we DID (the count of weeks actually
                # zeroed), not what the report said — injuries.json records the
                # report. That keeps the duration statement and its applied
                # consequence in agreement by construction, which is what lets
                # weeks[].avail stay the single carrier for blocked weeks. It is
                # also what truncates a stated duration that runs past week 18.
                block["weeks_out"] = None if view["out_for_season"] else actually_blocked
                block["out_for_season"] = view["out_for_season"]
                block["confidence"] = confidence
                block["evidence"] = view["evidence"]
                block["season_points_lost"] = lost
                n_blocked_players += 1
                n_season_ending += 1 if view["out_for_season"] else 0
                points_removed += lost
            row["availability"] = block
        row["weeks"] = weeks
        players.append(row)

    model = {"name": MODEL_NAME, "tilt_coef": TILT_COEF, "home_coef": HOME_COEF,
             "estimate": True, "notes": MODEL_NOTES}
    if mults:
        # statuses_used = projected players whose split was actually shaped.
        model["injury_shape"] = {"applied": True, "statuses_used": len(mults)}
    if n_blocked_players:
        model["availability"] = {
            "applied": True,
            "vocab_version": availability.VOCAB_VERSION,
            "unavailable": n_blocked_players,
            "season_ending": n_season_ending,
            "min_weeks_rule": availability.MIN_WEEKS_OUT,
            "season_points_removed": round(points_removed, 2),
        }
    return {
        "season": season,
        "updated_utc": updated_utc,
        "model": model,
        "players": players,
    }


# ----------------------------------------------------------------------------------
# selftest — the two mechanics, their separation, and the no-op guarantee.
# ----------------------------------------------------------------------------------

def _fixture():
    def g(wk, home, away):
        return {"week": wk, "home": home, "away": away}
    # SFX plays weeks 1, 3, 4, 5, 6 — week 2 is a bye, so the "first 3 playable
    # weeks" window has to skip it.
    sched = [g(1, "SFX", "DAL"), g(2, "DAL", "GBX"), g(3, "DAL", "SFX"),
             g(4, "SFX", "GBX"), g(5, "GBX", "SFX"), g(6, "SFX", "DAL")]
    elos = {"SFX": 1580.0, "DAL": 1470.0, "GBX": 1500.0}
    return team_schedule(sched), elos, sched


def selftest():
    sched_by_team, elos, sched = _fixture()
    base = player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None)
    non_bye = [w for w in base if not w["bye"]]
    assert len(non_bye) == 5, len(non_bye)
    assert abs(sum(w["pts"] for w in non_bye) - 200.0) < 1e-9

    # --- unavailable_weeks=0 is the OLD path, exactly -----------------------------
    same = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=0,
                        round_dp=None)
    assert same == base, "unavailable_weeks=0 must be numerically identical"
    assert all("avail" not in w for w in same), "no avail key on a healthy player"

    # --- mechanic (a): shape preserved, total preserved ---------------------------
    shaped = player_weeks(200.0, "SFX", sched_by_team, elos, injury_mult=0.55,
                          round_dp=None)
    assert abs(sum(w["pts"] for w in shaped if not w["bye"]) - 200.0) < 1e-9, \
        "week-shaping must PRESERVE the season total"

    # --- mechanic (b): total REALLY drops, pro-rata -------------------------------
    blocked = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                           round_dp=None)
    got = sum(w["pts"] for w in blocked if not w["bye"])
    assert abs(got - 200.0 * 3 / 5) < 1e-9, f"pro-rata target missed: {got}"
    assert [w["wk"] for w in blocked if w.get("avail") is False] == [1, 3], \
        "the bye must not absorb a blocked week"
    assert blocked[0]["pts"] == 0.0 and blocked[2]["pts"] == 0.0
    assert blocked[1]["bye"] is True and "avail" not in blocked[1], \
        "a bye is NOT an availability block — the app must tell them apart"

    # --- first_week: an absence never retro-zeroes a week already played ----------
    late = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                        first_week=4, round_dp=None)
    assert [w["wk"] for w in late if w.get("avail") is False] == [4, 5], \
        "blocked weeks must start at first_week"

    # --- out for the season -------------------------------------------------------
    gone = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=WEEKS,
                        round_dp=None)
    assert sum(w["pts"] for w in gone) == 0.0, "an out-for-season player scores 0"
    assert sum(1 for w in gone if w.get("avail") is False) == 5

    # --- the partition happens BEFORE the shaping ---------------------------------
    both = player_weeks(200.0, "SFX", sched_by_team, elos, injury_mult=0.55,
                        unavailable_weeks=2, round_dp=None)
    # Playable weeks are 4, 5, 6; all three are inside the INJURY_WEEKS window, so
    # a uniform multiplier cancels in the renormalization and the shape matches the
    # pro-rata baseline exactly. The ding was NOT spent on weeks 1 and 3.
    plain = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                         round_dp=None)
    assert all(abs(a["pts"] - b["pts"]) < 1e-9 for a, b in zip(both, plain)), \
        "the injury multiplier must not be spent on weeks the player cannot play"

    # --- R49: absence already in the total is NOT subtracted twice ---------------
    in_total = player_weeks(130.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                            round_dp=None, absence_in_total=True)
    assert abs(sum(w["pts"] for w in in_total if not w["bye"]) - 130.0) < 1e-6, \
        "absence_in_total must renormalize the playable weeks to the FULL total"
    assert [w["wk"] for w in in_total if w.get("avail") is False] == [1, 3]
    same_as_old = player_weeks(130.0, "SFX", sched_by_team, elos, round_dp=None,
                               absence_in_total=True)
    plain = player_weeks(130.0, "SFX", sched_by_team, elos, round_dp=None)
    assert same_as_old == plain, "with nothing blocked the flag must be a no-op"
    assert absence_in_total({"baseline_rule": "prior_ppg_x_projected_games",
                             "absence_weeks": 4}) is True
    assert absence_in_total({"baseline_rule": "prior_season_points",
                             "absence_weeks": 4}) is False, \
        "the total rule still takes the pro-rata law"
    assert absence_in_total({"baseline_rule": "prior_ppg_x_projected_games"}) is False

    # --- R49 override: prior pricing lines scale with the shipped number ---------
    comp_in = {"components": {"pass_yd": 4000.0, "pass_td": 30.0, "pass_int": 10.0,
                              "rec_tgt": 5.0},
               "base_applied_pts": round(4000 * 0.04 + 30 * 4 - 10 * 2, 2),
               "bonus_games": {"bonus_pass_yd_300": 4}}
    rec, cmp, comp = scale_prior_lines(1.25, 80.0, 300.0, comp_in)
    assert rec == 100.0 and cmp == 375.0
    assert comp["components"]["pass_yd"] == 5000.0 and comp["components"]["pass_td"] == 37.5
    assert comp["bonus_games"] == {"bonus_pass_yd_300": 4}, "a count never scales"
    recomputed = comp["components"]["pass_yd"] * 0.04 + comp["components"]["pass_td"] * 4 \
        - comp["components"]["pass_int"] * 2
    assert abs(recomputed - comp["base_applied_pts"]) <= 1.0, "integrity check holds"
    assert scale_prior_lines(1.25, None, None, None) == (None, None, None)
    assert shipped_ratio({"proj_points": 250.0}, 200.0) == 1.25
    assert shipped_ratio({"proj_points": 250.0}, 0.0) == 1.0
    assert shipped_ratio({"proj_points": 250.0}, None) == 1.0

    # --- blocked_week_count -------------------------------------------------------
    assert blocked_week_count(None) == (0, None)
    assert blocked_week_count({"class": "week", "status": "OUT"}) == (0, None)
    assert blocked_week_count({"class": "season", "status": "IR",
                               "out_for_season": True, "weeks_out": None}) \
        == (WEEKS, "explicit")
    assert blocked_week_count({"class": "season", "status": "SUSPENDED",
                               "out_for_season": False, "weeks_out": 3}) \
        == (3, "explicit")
    assert blocked_week_count({"class": "season", "status": "IR",
                               "out_for_season": False, "weeks_out": None}) \
        == (availability.MIN_WEEKS_OUT, "rule"), "IR with no text falls to the floor"
    assert blocked_week_count({"class": "season", "status": "SUSPENDED",
                               "out_for_season": False, "weeks_out": None}) \
        == (0, None), "a suspension of unknown length must block NOTHING"

    # --- document: emitted only when non-empty ------------------------------------
    proj = [{"gsis_id": "p1", "name": "Hurt Guy", "team": "SFX", "proj_points": 200.0},
            {"gsis_id": "p2", "name": "Fine Guy", "team": "DAL", "proj_points": 150.0}]
    kw = dict(receptions_by_id={}, season=2026, updated_utc="2026-07-17T00:00:00Z")
    clean = build_weekly_document(proj, sched, elos, injuries=[], **kw)
    assert "availability" not in clean["model"]
    assert all("availability" not in p for p in clean["players"])

    ir_doc = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Injured Reserve",
                   "detail": "No timetable has been set."}], **kw)
    a = ir_doc["players"][0]["availability"]
    assert a["status"] == "IR" and a["class"] == "season"
    assert a["confidence"] == "rule" and a["evidence"] is None
    assert a["weeks_out"] == availability.MIN_WEEKS_OUT
    assert a["out_for_season"] is False
    assert ir_doc["model"]["availability"] == {
        "applied": True, "vocab_version": availability.VOCAB_VERSION,
        "unavailable": 1, "season_ending": 0,
        "min_weeks_rule": availability.MIN_WEEKS_OUT,
        "season_points_removed": a["season_points_lost"]}
    assert "injury_shape" not in ir_doc["model"], "IR is not a multiplier status"
    assert ir_doc["players"][1] == clean["players"][1], "healthy player untouched"

    wk_doc = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Questionable",
                   "detail": None}], **kw)
    a = wk_doc["players"][0]["availability"]
    assert a == {"status": "QUESTIONABLE", "class": "week"}, a
    assert "availability" not in wk_doc["model"], "week shaping blocks nothing"
    assert wk_doc["model"]["injury_shape"] == {"applied": True, "statuses_used": 1}

    susp = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Suspension",
                   "detail": "No length was announced."}], **kw)
    a = susp["players"][0]["availability"]
    assert a == {"status": "SUSPENDED", "class": "season"}, a
    assert "availability" not in susp["model"], "unknown length must claim nothing"
    assert all("avail" not in w for w in susp["players"][0]["weeks"])

    gone_doc = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Out",
                   "detail": "He will miss the rest of the season."}], **kw)
    a = gone_doc["players"][0]["availability"]
    assert a["status"] == "OUT" and a["class"] == "season", "text promotes the mechanic"
    assert a["out_for_season"] is True and a["weeks_out"] is None
    assert a["confidence"] == "explicit" and a["evidence"]
    assert a["season_points_lost"] == 200.0
    assert sum(w["pts"] for w in gone_doc["players"][0]["weeks"]) == 0.0
    assert gone_doc["model"]["availability"]["season_ending"] == 1

    print("selftest OK: week-shaping preserves the season total, unavailability "
          "reduces it pro-rata, the two never mix, and a healthy build is unchanged")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    print(__doc__)
    sys.exit(0)
