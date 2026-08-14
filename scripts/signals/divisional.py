"""`divisional` — the game-level candidate family for divisional matchups.

## What it prices

Two teams in the same division play twice every regular season. The claim the
family tests is that this changes the home team's win probability by a fixed
Elo amount, over and above whatever the ratings already say — familiarity,
travel that is usually short, and the fact that both staffs have a full film
library on each other. A separate term prices the SECOND meeting, on the theory
that whatever divisional familiarity does, it does more the second time.

    delta(g) = 0.0                              when the game is not divisional
             = scale                            divisional, first meeting
             = scale + rematch_extra            divisional, second meeting

`meeting_no` counts meetings within one season, so a divisional playoff game is
`meeting_no == 3` and takes `scale` alone — the rematch term is specifically
about the in-season return fixture, and a January game between two teams that
already played twice is not that. A game whose context row is missing scores
0.0 and never raises.

## Why the grid is signed, and 2-D

Direction is unknown a priori. "Divisional games are closer" is folklore, not a
measurement, and it can only be true of the home edge if familiarity COMPRESSES
it — so `DIV_SCALES` spans both signs exactly the way `WIND_SCALES` does. The
rematch term is a second axis rather than a second family: a rematch is by
construction a divisional game, so `div_rematch` would be a strict subset of
`div_game` and the two would be near-perfectly correlated competitors for the
one adoption slot the gate grants per run, doubling the multiplicity exposure
of a single hypothesis. `environment` (venue x cold) is the precedent for
carrying two correlated axes inside one family; this mirrors it. 6 x 5 = 30
trials, every one non-degenerate (`scale` is never 0, so no combination is
silently the incumbent).

## Inputs

`data/game_context.json` (built by `scripts/build_game_context.py` from
nflverse `games.csv`), flat join key `"{season}|{week}|{home}|{away}"`. Both
fields this module reads — `div_game` and `meeting_no` — are properties of the
SCHEDULE, known the moment the season is released, so nothing here is
post-game. No market column is read, or exists in that artifact to read.

Prediction-time application does not depend on that artifact at all:
`divisional_current` derives both fields from the live schedule when the season
is not in the file, which is the normal case for the season being played.

Stdlib only, deterministic, no I/O outside the two documented reads.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

CONTEXT_PATH = os.path.join(_ROOT, "data", "game_context.json")

# Signed: familiarity could plausibly compress or extend the home edge, and the
# gate is not entitled to assume which. Zero is excluded because a zero base
# scale makes the whole family the incumbent regardless of `rematch_extra`.
DIV_SCALES = [-30.0, -20.0, -10.0, 10.0, 20.0, 30.0]
# Extra Elo applied ONLY to the in-season second meeting. 0.0 is kept: it is
# the honest "the rematch is nothing special" hypothesis, and the family still
# has a live base term, so the trial is not degenerate.
DIV_REMATCH_EXTRA = [-20.0, -10.0, 0.0, 10.0, 20.0]

# The in-season return fixture. Playoff rematches are meeting_no 3 and are NOT
# what `rematch_extra` prices.
REMATCH_MEETING_NO = 2


def context_key(season, game):
    """The flat join key `game_context.json` publishes. Mirrors the key format
    used by `market_baseline.json` and `weather_history.json` byte for byte."""
    return f"{season}|{game.get('week')}|{game['home']}|{game['away']}"


def divisional_delta(rec, scale, rematch_extra):
    """The family's per-game Elo delta from one context record.

    `rec` is a `game_context.games` value, or None/{} for a game the join did
    not cover. A missing or non-divisional record is exactly 0.0 — the family
    is a no-op there, never a guess.
    """
    if not rec or not rec.get("div_game"):
        return 0.0
    if rec.get("meeting_no") == REMATCH_MEETING_NO:
        return float(scale) + float(rematch_extra)
    return float(scale)


def context_map(seasons, path=CONTEXT_PATH):
    """`{join_key: {div_game, meeting_no}}`, or None when unusable.

    Returns None when the artifact is absent, or when its games do not span
    every season in `seasons`. That second condition is not fussiness: a family
    whose inputs cover part of the walk is still scored on every fold, and the
    folds it cannot see score EXACT TIES with the incumbent. Ties are counted
    in n and in the cluster-robust variance, so partial coverage dilutes the
    measured improvement toward zero and makes `folds_positive` conflate "no
    data here" with "no help here". Under `--corpus` (1999-2025) a 2021-2025
    input is a ~12x dilution. Skip loudly instead.
    """
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    games = doc.get("games") or None
    if not games:
        return None
    covered = {str(k).split("|", 1)[0] for k in games}
    if not all(str(y) in covered for y in seasons):
        return None
    return {k: {"div_game": int(v.get("div_game") or 0),
                "meeting_no": (int(v["meeting_no"])
                               if v.get("meeting_no") is not None else None)}
            for k, v in games.items()}


def divisional_builder(scale, rematch_extra, ctx):
    """`(setup, factory)` — the promote_signals family-builder contract.

    setup(season, games, training_residuals) -> ctx handed to factory
    factory(ctx) -> (game, idx) -> elo_delta

    Nothing is fitted, so `training_residuals` is unused and there is no leak
    surface: `div_game` and `meeting_no` are schedule facts, fixed before a
    down is played.
    """
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        def fn(g, i):
            return divisional_delta(ctx.get(context_key(season, g)),
                                    scale, rematch_extra)
        return fn
    return setup, factory


def adoption_block(best, now):
    """The `game_params.divisional` record written when the family is adopted."""
    return {"applied": True,
            "scale": best["scale"],
            "rematch_extra": best["rematch_extra"],
            "rematch_meeting_no": REMATCH_MEETING_NO,
            "adopted_utc": now}


# --------------------------------------------------------------------------- #
# Prediction-time application
# --------------------------------------------------------------------------- #

def _divisions():
    """The current division map, borrowed from the playoff simulator so there
    is exactly one copy of it in the repo. Lazy so this module imports with
    nothing but the stdlib."""
    from scripts.simulate_season import DIVISIONS      # noqa: PLC0415
    return {team: name for name, teams in DIVISIONS.items() for team in teams}


def derive_from_schedule(season, schedule):
    """`{join_key: {div_game, meeting_no}}` computed from the season schedule.

    Both fields are pure schedule arithmetic: `div_game` from the division map,
    `meeting_no` by counting how many times the unordered pair has already been
    scheduled earlier in the season. Games are ordered by kickoff, falling back
    to week, so a slate with missing kickoff times still orders correctly.
    """
    div_of = _divisions()
    seen = {}
    out = {}
    ordered = sorted(schedule, key=lambda g: (g.get("kickoff_utc") or "",
                                              int(g.get("week") or 0)))
    for g in ordered:
        h, a = g["home"], g["away"]
        pair = tuple(sorted((h, a)))
        seen[pair] = seen.get(pair, 0) + 1
        dh, da = div_of.get(h), div_of.get(a)
        out[context_key(season, g)] = {
            "div_game": 1 if (dh is not None and dh == da) else 0,
            "meeting_no": seen[pair],
        }
    return out


def divisional_current(season, schedule=None, path=CONTEXT_PATH):
    """`{join_key: {div_game, meeting_no}}` for PREDICTION-TIME application.

    Prefers `game_context.json` where it carries a row, and fills every game it
    does NOT carry from `schedule` — both fields are pure schedule arithmetic,
    so the derived value is the same information a week earlier.

    THE ARTIFACT IS PARTIAL MID-SEASON, WHICH IS THE CASE TO GET RIGHT.
    game_context.json holds COMPLETED games only, so the moment it is rebuilt
    after week 1 it carries some of the live season, not none of it. Returning
    those rows alone (the old behaviour) priced every UPCOMING game at 0.0 —
    silently, because a non-empty map is truthy and build_predictions' "not
    applied" warning could never fire. A merge is the only shape that is
    correct in all three regimes: artifact absent, artifact partial, artifact
    complete.

    Returns None only when neither source can supply the season, so an adopted
    family can say "not applied" rather than silently pricing every game at
    zero.
    """
    rows = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            games = (json.load(fh)).get("games") or {}
        pre = f"{season}|"
        rows = {k: {"div_game": int(v.get("div_game") or 0),
                    "meeting_no": (int(v["meeting_no"])
                                   if v.get("meeting_no") is not None else None)}
                for k, v in games.items() if str(k).startswith(pre)}
    if schedule:
        merged = derive_from_schedule(season, schedule)
        # The artifact is nflverse ground truth where it exists; the derived
        # rows only cover what it has not recorded yet. Artifact rows for games
        # NOT on the supplied slate are kept too — dropping them would make a
        # complete-artifact season narrower than it used to be.
        merged.update(rows)
        return merged
    return rows or None


# --------------------------------------------------------------------------- #

def selftest():
    """Family math on hand-computed values — asserts, never touches data/."""
    ctx = {
        "2024|3|KC|DEN": {"div_game": 1, "meeting_no": 1},    # div, first
        "2024|14|DEN|KC": {"div_game": 1, "meeting_no": 2},   # div, rematch
        "2024|5|KC|NO": {"div_game": 0, "meeting_no": 1},     # non-div
        "2024|21|KC|DEN": {"div_game": 1, "meeting_no": 3},   # div playoff
        "2024|8|KC|BUF": {"div_game": 0, "meeting_no": 2},    # non-div rematch
    }
    _, factory = divisional_builder(20.0, -30.0, ctx)
    fn = factory(2024)
    # first meeting -> base only
    assert fn({"home": "KC", "away": "DEN", "week": 3}, 0) == 20.0
    # rematch -> base + extra = 20 + (-30) = -10
    assert fn({"home": "DEN", "away": "KC", "week": 14}, 1) == -10.0
    # non-divisional -> exactly zero, both meetings
    assert fn({"home": "KC", "away": "NO", "week": 5}, 2) == 0.0
    assert fn({"home": "KC", "away": "BUF", "week": 8}, 3) == 0.0
    # divisional playoff rematch is meeting 3 -> base only, NOT base + extra
    assert fn({"home": "KC", "away": "DEN", "week": 21}, 4) == 20.0
    # a game the join does not cover is a no-op, never a crash
    assert fn({"home": "SEA", "away": "SF", "week": 9}, 5) == 0.0
    # a context row with a null meeting_no is still divisional at the base rate
    _, f2 = divisional_builder(10.0, 5.0, {"2024|1|A|B": {"div_game": 1,
                                                          "meeting_no": None}})
    assert f2(2024)({"home": "A", "away": "B", "week": 1}, 0) == 10.0
    # rematch_extra = 0 must be identical to the base scale on both meetings
    _, f3 = divisional_builder(-10.0, 0.0, ctx)
    g3 = f3(2024)
    assert g3({"home": "KC", "away": "DEN", "week": 3}, 0) == -10.0
    assert g3({"home": "DEN", "away": "KC", "week": 14}, 1) == -10.0

    # The grid is the shape the design fixed: 6 x 5 = 30 non-degenerate trials.
    assert len(DIV_SCALES) == 6 and 0.0 not in DIV_SCALES
    assert len(DIV_REMATCH_EXTRA) == 5
    assert len(DIV_SCALES) * len(DIV_REMATCH_EXTRA) == 30
    assert DIV_SCALES == sorted(DIV_SCALES) and DIV_SCALES[0] < 0 < DIV_SCALES[-1]

    # context_map: absent file and unspanned seasons both yield None (skip
    # loudly), never a partially covered map that scores ties as evidence.
    assert context_map([2024], path=os.path.join(_ROOT, "no_such_file.json")) is None
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "ctx.json")
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"games": {"2024|1|KC|DEN": {"div_game": 1, "meeting_no": 1}}}, fh)
        assert context_map([2024], path=p) is not None
        assert context_map([2023, 2024], path=p) is None      # 2023 uncovered
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"games": {}}, fh)
        assert context_map([2024], path=p) is None
        # divisional_current falls through to the schedule when the artifact
        # has no row for the season being played.
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"games": {"2024|1|KC|DEN": {"div_game": 1, "meeting_no": 1}}}, fh)
        sched = [
            {"home": "KC", "away": "DEN", "week": 2, "kickoff_utc": "2026-09-13T17:00:00Z"},
            {"home": "DEN", "away": "KC", "week": 15, "kickoff_utc": "2026-12-13T18:00:00Z"},
            {"home": "KC", "away": "NO", "week": 3, "kickoff_utc": "2026-09-20T17:00:00Z"},
        ]
        cur = divisional_current(2026, schedule=sched, path=p)
        assert cur["2026|2|KC|DEN"] == {"div_game": 1, "meeting_no": 1}, cur
        assert cur["2026|15|DEN|KC"] == {"div_game": 1, "meeting_no": 2}, cur
        assert cur["2026|3|KC|NO"] == {"div_game": 0, "meeting_no": 1}, cur

        # PARTIAL ARTIFACT COVERAGE — the mid-season regime, and the one the
        # old "any row wins" rule got wrong. game_context.json holds COMPLETED
        # games only, so after week 1 it carries part of the live season. Every
        # game on the slate must still resolve; a schedule game the artifact has
        # not recorded yet may never fall through to a silent 0.0.
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"games": {"2026|2|KC|DEN": {"div_game": 1, "meeting_no": 1}}}, fh)
        part = divisional_current(2026, schedule=sched, path=p)
        assert set(part) == {"2026|2|KC|DEN", "2026|15|DEN|KC", "2026|3|KC|NO"}, part
        assert divisional_delta(part["2026|15|DEN|KC"], 30.0, 10.0) == 40.0, part
        assert divisional_delta(part["2026|3|KC|NO"], 30.0, 10.0) == 0.0, part
        # ...and where BOTH sources have the game, the artifact (nflverse ground
        # truth) is the one that wins.
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"games": {"2026|3|KC|NO": {"div_game": 1, "meeting_no": 2}}}, fh)
        won = divisional_current(2026, schedule=sched, path=p)
        assert won["2026|3|KC|NO"] == {"div_game": 1, "meeting_no": 2}, won

        # neither source -> None, so an adopted family reports "not applied"
        with open(p, "w", encoding="utf-8") as fh:
            json.dump({"games": {"2024|1|KC|DEN": {"div_game": 1, "meeting_no": 1}}}, fh)
        assert divisional_current(2026, schedule=None, path=p) is None
        # artifact-only (no slate supplied) still returns what it has
        assert divisional_current(2024, schedule=None, path=p) == {
            "2024|1|KC|DEN": {"div_game": 1, "meeting_no": 1}}

    # The shipped fixture must agree with the same hand-computed expectations.
    fx = os.path.join(_ROOT, "data", "fixtures", "divisional_context_sample.json")
    if os.path.exists(fx):
        m = context_map([2024], path=fx)
        assert m is not None, fx
        _, f4 = divisional_builder(30.0, 10.0, m)
        g4 = f4(2024)
        assert g4({"home": "BUF", "away": "MIA", "week": 3}, 0) == 30.0
        assert g4({"home": "MIA", "away": "BUF", "week": 12}, 1) == 40.0
        assert g4({"home": "BUF", "away": "SF", "week": 7}, 2) == 0.0

    print("selftest OK: divisional delta exact on all four record shapes "
          "(non-div / first / rematch / playoff-third), missing-join no-op, "
          "30-trial signed grid, span-or-skip loader, schedule-derived "
          "prediction-time fallback")


if __name__ == "__main__":
    selftest()          # the only mode; `--selftest` is accepted for symmetry
