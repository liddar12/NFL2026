"""Build data/dvp_positional_history.json — per-week, per-position scrimmage PPR
that each team's OFFENSE produced and each team's DEFENSE allowed.

WHY THIS FILE EXISTS (and why it is not data/dvp_history.json)
-------------------------------------------------------------
The `dvp_mismatch` gate family (scripts/signals/dvp_mismatch.py) needs BOTH
sides of the ball: the defensive rates it scores the opponent on, and the
offensive positional profile it weights them by. SOLUTION_DESIGN R4 already
ruled that `player_usage_history.json` cannot supply the offensive half — it is
season-level and carries no `position` column — so DvP must emit its own
offensive mirror.

The app-facing `data/dvp_history.json` / `data/dvp.json` pair specified in
SOLUTION_DESIGN §5.1/§5.3 is a different artifact with a different owner and a
different source (streamed play-by-play, with `opp` denominators for the
start/sit UI). This file is deliberately named apart from it so the two can
land independently and neither silently overwrites the other. It carries only
what the family needs: PPR sums and a game count.

SOURCE
------
nflverse-data release `stats_player_week` — one row per player per week, with
`position`, `team` (the player's offense) and `opponent_team` (the defense he
faced). That is the whole join: no play-by-play stream, no roster join, no
`pid -> position` map to go stale. Coverage is 1999-2025 inclusive, which is
exactly the backtest corpus, so the family runs on every corpus fold instead of
being diluted by uncovered seasons.

SCORING
-------
    ppr_scrimmage = receptions * 1
                  + (receiving_yards + rushing_yards) * 0.1
                  + (receiving_tds + rushing_tds) * 6
                  + passing_yards * 0.04
                  + passing_tds * 4
                  - passing_interceptions * 2

Honest limitation, recorded in the artifact: it EXCLUDES 2-point conversions,
fumbles lost and return touchdowns. Those are either not attributable to the
defense faced or not part of scrimmage production. The field is named
`ppr_scrimmage`, never `ppr`, so nobody mistakes it for a full fantasy total.

REGULAR SEASON ONLY. Postseason weeks are dropped: only good teams play them,
so a prior-season rate that included January would be a survivorship-biased
estimate of a defense rather than a measurement of it.

POSITIONS
---------
QB / RB / WR / TE. `FB` and `HB` fold into RB. Every other position (K, and the
occasional defender or lineman credited with a carry or a reception) goes to a
`UNK` bucket that is WRITTEN OUT as a diagnostic and asserted small — an
unmapped-position blowout is a feed regression and must be visible, not
silently dropped.

Team codes are renamed to the corpus convention: LA->LAR, OAK->LV, SD->LAC,
STL->LAR. Byte-identical to scripts/build_backtest_corpus.py's map.

MARKET BOUNDARY: this builder reads a player-statistics feed. No betting column
exists in that source, none is read, and none is written. The family that
consumes this artifact operates independently of the sportsbooks by policy, and
`tests/feature/family_dvp.test.mjs` enforces the boundary by name against both
this file and the artifact it produces.

Stdlib only. `--selftest` runs on the committed fixture and never writes data/.
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "dvp_positional_history.json")
FIXTURE = os.path.join(DATA, "fixtures", "nflverse_sample",
                       "stats_player_week_dvp.csv")

RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
RELEASE_URL = RELEASE_BASE + "/stats_player/stats_player_week_{season}.csv"

FIRST_SEASON = 1999
LAST_SEASON = 2025

# Mirrors scripts/build_backtest_corpus.py exactly. A drift here would silently
# split one franchise into two teams and halve both their samples.
RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}

POSITIONS = ("QB", "RB", "WR", "TE")
_POS_ALIAS = {"FB": "RB", "HB": "RB"}

SCORING = ("ppr_scrimmage = rec*1 + (rec_yds + rush_yds)*0.1 "
           "+ (rec_td + rush_td)*6 + pass_yds*0.04 + pass_td*4 - int*2")
EXCLUDES = ("2-point conversions, fumbles lost, return touchdowns - not "
            "attributable to the defense faced, or not scrimmage production")

# An UNK share above this is a feed regression, not noise.
MAX_UNK_SHARE = 0.03

# Every column accumulate() reads, checked against the header BEFORE a single
# row is folded. _num() answers 0.0 for a missing key by design (nflverse leaves
# a passer's receiving columns empty rather than zero), which means an upstream
# RENAME would read as zero production for every player instead of raising —
# the exact is_screen_pass/is_screen_p failure mode build_scheme_history.py
# guards with REQUIRED_FTN_COLUMNS and build_game_context.py guards with its
# header check. Renaming receiving_yards alone silently drops ~24% of the
# league's scrimmage PPR; a builder that cannot tell that from a quiet year is
# not honest data.
REQUIRED_STAT_COLUMNS = (
    "season", "week", "season_type", "team", "opponent_team", "position",
    "receptions", "receiving_yards", "rushing_yards", "receiving_tds",
    "rushing_tds", "passing_yards", "passing_tds", "passing_interceptions",
)

_HTTP_TIMEOUT = 180


class BuildError(RuntimeError):
    """Raised instead of writing a file we cannot stand behind."""


# --------------------------------------------------------------------------- #
# parsing                                                                      #
# --------------------------------------------------------------------------- #

def _num(row, key):
    """A stats column as a float. Blank / NA / NaN are 0.0 — nflverse leaves a
    passer's receiving columns empty rather than zero, and an empty cell means
    'did not do this', which is exactly zero production."""
    v = row.get(key)
    if v is None:
        return 0.0
    v = v.strip()
    if not v or v in ("NA", "NaN", "nan", "NULL"):
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def ppr_scrimmage(row):
    """The scrimmage PPR core one player produced in one week."""
    return (_num(row, "receptions")
            + (_num(row, "receiving_yards") + _num(row, "rushing_yards")) * 0.1
            + (_num(row, "receiving_tds") + _num(row, "rushing_tds")) * 6.0
            + _num(row, "passing_yards") * 0.04
            + _num(row, "passing_tds") * 4.0
            - _num(row, "passing_interceptions") * 2.0)


def norm_team(code):
    code = (code or "").strip().upper()
    return RENAMES.get(code, code)


def norm_position(code):
    code = (code or "").strip().upper()
    code = _POS_ALIAS.get(code, code)
    return code if code in POSITIONS else "UNK"


def _blank_side():
    return {p: 0.0 for p in POSITIONS}


def accumulate(rows, seasons=None):
    """Fold player-week rows into `{season: {team: {week: row}}}`.

    Each week row is `{"g": games, "off": {pos: ppr}, "def": {pos: ppr}}`:
    `off` is what that team's offense produced, `def` is what its defense
    allowed. Sums, not means (the `epa_history` rule) so any window recomposes
    exactly by addition.

    Raises BuildError when the first row is missing any REQUIRED_STAT_COLUMNS
    key: `_num()` reads a missing column as 0.0, so an upstream rename would
    otherwise produce a complete, plausible, and wrong file rather than an
    error.

    Returns `(seasons_dict, diagnostics)`.
    """
    if rows:
        missing = [c for c in REQUIRED_STAT_COLUMNS if c not in rows[0]]
        if missing:
            raise BuildError(
                f"stats_player_week is missing required column(s) {missing}. "
                "_num() reads an absent column as 0.0, so an upstream rename "
                "must fail loud, never silently score zero production.")
    out = {}
    games_seen = {}                 # (season, team, week) -> set of game_id
    unk_ppr = 0.0
    total_ppr = 0.0
    dropped_no_team = 0
    post_rows = 0

    for row in rows:
        if (row.get("season_type") or "REG").strip().upper() != "REG":
            post_rows += 1
            continue
        try:
            season = int(row["season"])
            week = int(row["week"])
        except (KeyError, TypeError, ValueError):
            continue
        if seasons is not None and season not in seasons:
            continue
        off = norm_team(row.get("team"))
        dfn = norm_team(row.get("opponent_team"))
        if not off or not dfn:
            dropped_no_team += 1
            continue

        gid = (row.get("game_id") or "").strip() or f"{season}|{week}|{off}|{dfn}"
        for t in (off, dfn):
            games_seen.setdefault((season, t, week), set()).add(gid)

        pts = ppr_scrimmage(row)
        pos = norm_position(row.get("position"))
        total_ppr += abs(pts)
        if pos == "UNK":
            unk_ppr += abs(pts)
            continue

        for team, side in ((off, "off"), (dfn, "def")):
            wk = (out.setdefault(season, {}).setdefault(team, {})
                  .setdefault(week, {"g": 0, "off": _blank_side(),
                                     "def": _blank_side()}))
            wk[side][pos] += pts

    for (season, team, week), gids in games_seen.items():
        wk = (out.setdefault(season, {}).setdefault(team, {})
              .setdefault(week, {"g": 0, "off": _blank_side(),
                                 "def": _blank_side()}))
        wk["g"] = len(gids)

    for season in out.values():
        for team in season.values():
            for wk in team.values():
                for side in ("off", "def"):
                    wk[side] = {p: round(wk[side][p], 3) for p in POSITIONS}

    diagnostics = {
        "unk_position_ppr_share": round(unk_ppr / total_ppr, 6) if total_ppr else 0.0,
        "rows_without_team": dropped_no_team,
        "postseason_rows_dropped": post_rows,
    }
    return out, diagnostics


def league_balance(season_rows):
    """`{pos: (off_total, def_total)}` for one season.

    Every point one offense produces is a point some defense allowed, so the
    two totals must agree exactly. This is the artifact's own correctness
    proof and the selftest asserts it.
    """
    totals = {p: [0.0, 0.0] for p in POSITIONS}
    for weeks in season_rows.values():
        for wk in weeks.values():
            for p in POSITIONS:
                totals[p][0] += wk["off"][p]
                totals[p][1] += wk["def"][p]
    return {p: (round(v[0], 2), round(v[1], 2)) for p, v in totals.items()}


# --------------------------------------------------------------------------- #
# fetch                                                                        #
# --------------------------------------------------------------------------- #

def fetch_season(season, cache_dir=None):
    """Rows for one season from the nflverse release, as dicts.

    A non-200 raises. A season we cannot fetch is NEVER imputed or skipped
    silently — the caller aborts and the artifact is not written, because a
    hole in the middle of the walk would be scored as exact ties and read as
    'this family does not help here'.
    """
    url = RELEASE_URL.format(season=int(season))
    cached = (os.path.join(cache_dir, f"stats_player_week_{season}.csv")
              if cache_dir else None)
    if cached and os.path.exists(cached):
        with open(cached, encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh))

    try:
        import requests                                   # noqa: PLC0415
    except ImportError as exc:                            # pragma: no cover
        raise BuildError("requests is required to fetch nflverse releases") from exc
    resp = requests.get(url, timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise BuildError(f"GET {url} returned HTTP {resp.status_code}; refusing "
                         "to write a partial artifact")
    text = resp.content.decode("utf-8", errors="replace")
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cached, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    return list(csv.DictReader(io.StringIO(text)))


def build(seasons, cache_dir=None, progress=False):
    """Fetch + fold every season. Raises on any gap."""
    rows = []
    for yr in seasons:
        season_rows = fetch_season(yr, cache_dir=cache_dir)
        if not season_rows:
            raise BuildError(f"season {yr} returned zero rows")
        if progress:
            print(f"  {yr}: {len(season_rows)} player-weeks", flush=True)
        rows.extend(season_rows)
    return accumulate(rows, seasons=set(seasons))


def document(seasons_dict, diagnostics, seasons):
    return {
        "generated_utc": dt.datetime.now(dt.timezone.utc)
                           .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "nflverse-data release stats_player_week",
        "source_url": RELEASE_URL.format(season="{season}"),
        "scoring": SCORING,
        "excludes": EXCLUDES,
        "policy": ("regular season only; sums not means so any week window "
                   "recomposes by addition; `off` is production BY that team, "
                   "`def` is production ALLOWED by that team"),
        "positions": list(POSITIONS),
        "renames": dict(RENAMES),
        "season_range": [min(seasons), max(seasons)],
        "diagnostics": diagnostics,
        "seasons": {str(y): {t: {str(w): wk for w, wk in sorted(weeks.items())}
                             for t, weeks in sorted(teams.items())}
                    for y, teams in sorted(seasons_dict.items())},
    }


def write(doc, path=OUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=True)
        fh.write("\n")
    return path


# --------------------------------------------------------------------------- #
# selftest                                                                     #
# --------------------------------------------------------------------------- #

def selftest():
    """Hand-computed arithmetic on the committed fixture. Never writes data/."""
    # --- the scoring formula, by hand ---------------------------------------
    qb = {"receptions": "0", "receiving_yards": "0", "rushing_yards": "12",
          "receiving_tds": "0", "rushing_tds": "1", "passing_yards": "300",
          "passing_tds": "2", "passing_interceptions": "1"}
    # 0 + (0+12)*0.1 + (0+1)*6 + 300*0.04 + 2*4 - 1*2 = 1.2 + 6 + 12 + 8 - 2
    assert abs(ppr_scrimmage(qb) - 25.2) < 1e-9, ppr_scrimmage(qb)
    wr = {"receptions": "8", "receiving_yards": "110", "rushing_yards": "0",
          "receiving_tds": "1", "rushing_tds": "0", "passing_yards": "",
          "passing_tds": "NA", "passing_interceptions": None}
    # 8 + 11 + 6 = 25.0, and blank / NA / None are zero, not a crash
    assert abs(ppr_scrimmage(wr) - 25.0) < 1e-9, ppr_scrimmage(wr)
    # An all-blank row is exactly 0.0 — never NaN, never an exception.
    assert ppr_scrimmage({}) == 0.0

    # --- normalisation -------------------------------------------------------
    assert norm_team("STL") == "LAR" and norm_team("LA") == "LAR"
    assert norm_team("OAK") == "LV" and norm_team("SD") == "LAC"
    assert norm_team("KC") == "KC" and norm_team("") == ""
    assert norm_position("FB") == "RB" and norm_position("HB") == "RB"
    assert norm_position("K") == "UNK" and norm_position("CB") == "UNK"
    for p in POSITIONS:
        assert norm_position(p) == p

    # --- the fold, on the committed fixture ----------------------------------
    if not os.path.exists(FIXTURE):
        raise AssertionError(f"fixture missing: {FIXTURE}")
    with open(FIXTURE, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    seasons, diag = accumulate(rows)

    assert set(seasons) == {2099}, sorted(seasons)
    s = seasons[2099]
    # STL is renamed on the way in, so the fixture's STL rows land under LAR.
    assert "STL" not in s and "LAR" in s, sorted(s)

    # KC week 1 offense: QB 25.2 (above), WR 25.0 (above), RB 4-70-1 rushing
    # with 2 catches for 15 = 2 + (15+70)*0.1 + 6 = 16.5, TE 3 for 30 = 6.0.
    kc1 = s["KC"]["1"] if isinstance(next(iter(s["KC"])), str) else s["KC"][1]
    assert kc1["g"] == 1, kc1
    assert kc1["off"] == {"QB": 25.2, "RB": 16.5, "WR": 25.0, "TE": 6.0}, kc1["off"]
    # The kicker's 3 field goals are worth 0 scrimmage PPR but his row still
    # exists; UNK carries it and the share is reported, not hidden.
    assert diag["unk_position_ppr_share"] >= 0.0

    # LAR's DEFENSE in week 1 faced exactly KC's offense, so the mirror is exact.
    lar1 = s["LAR"]["1"] if isinstance(next(iter(s["LAR"])), str) else s["LAR"][1]
    assert lar1["def"] == kc1["off"], (lar1["def"], kc1["off"])
    # ...and KC's defense mirrors LAR's offense.
    assert kc1["def"] == lar1["off"], (kc1["def"], lar1["off"])

    # LEAGUE BALANCE: every point produced is a point allowed, per position.
    for pos, (o, d) in league_balance(s).items():
        assert abs(o - d) < 1e-6, (pos, o, d)

    # POSTSEASON IS DROPPED. The fixture carries a POST row for KC week 20 with
    # an absurd 500-yard line; if it were counted, KC would have a week 20.
    assert "20" not in {str(w) for w in s["KC"]}, sorted(s["KC"])
    assert diag["postseason_rows_dropped"] >= 1, diag

    # A team that played twice in the fixture's week 2 (a synthetic double
    # header) records g == 2, so a per-game rate divides by games and not by
    # weeks.
    buf2 = s["BUF"]["2"] if isinstance(next(iter(s["BUF"])), str) else s["BUF"][2]
    assert buf2["g"] == 2, buf2

    # A row with no opponent_team is dropped loudly, not folded into a phantom
    # defense.
    assert diag["rows_without_team"] >= 1, diag

    # AN UPSTREAM COLUMN RENAME RAISES. Renaming receiving_yards -> receiving_yds
    # (the is_screen_pass/is_screen_p failure mode) silently drops ~24% of the
    # fixture's scrimmage PPR through _num()'s 0.0-for-missing rule, so the
    # header must be checked before any row is folded.
    renamed = [{("receiving_yds" if k == "receiving_yards" else k): v
                for k, v in r.items()} for r in rows]
    try:
        accumulate(renamed)
    except BuildError as exc:
        assert "receiving_yards" in str(exc), str(exc)
    else:
        raise AssertionError("a renamed required column must raise BuildError, "
                             "never read as zero production")
    # ...and an empty feed is not a column error (it is caught downstream as a
    # zero-row build), so the guard must not fire on `rows == []`.
    assert accumulate([])[0] == {}

    print("selftest OK: ppr_scrimmage exact on hand-computed QB/WR/blank rows, "
          "team+position normalisation, off/def mirror identity, per-position "
          "league balance, REG-only filter, multi-game weeks, missing-opponent "
          "drop counted")
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true",
                    help="fixture-driven arithmetic checks; never writes data/")
    ap.add_argument("--seasons", default=f"{FIRST_SEASON}-{LAST_SEASON}",
                    help="inclusive season range, e.g. 2021-2025")
    ap.add_argument("--cache-dir", default=None,
                    help="reuse downloaded CSVs from this directory")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()
        return 0

    lo, _, hi = args.seasons.partition("-")
    seasons = list(range(int(lo), int(hi or lo) + 1))
    print(f"building dvp_positional_history for {seasons[0]}-{seasons[-1]}")
    rows, diag = build(seasons, cache_dir=args.cache_dir, progress=True)

    missing = [y for y in seasons if y not in rows]
    if missing:
        raise BuildError(f"seasons produced no rows: {missing}")
    if diag["unk_position_ppr_share"] > MAX_UNK_SHARE:
        raise BuildError("unmapped-position PPR share "
                         f"{diag['unk_position_ppr_share']:.4f} exceeds "
                         f"{MAX_UNK_SHARE} — roster/position feed regression")

    doc = document(rows, diag, seasons)
    path = write(doc, args.out)
    n_weeks = sum(len(w) for t in rows.values() for w in t.values())
    print(f"wrote {path}: {len(rows)} seasons, {n_weeks} team-weeks, "
          f"UNK share {diag['unk_position_ppr_share']:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
