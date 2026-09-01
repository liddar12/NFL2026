#!/usr/bin/env python3
"""BUILD data/kdst_projections.json — season projections for KICKERS and TEAM
DEFENSES, on their OWN contract.

WHY A SEPARATE FILE (measured, not a preference)
------------------------------------------------
build_predictions.py writes `projected[:300]` into data/player_projections.json
and the 300th offensive player scores 38.8 points. K/DST project far above that
cut, so merging them into that array would sort ~74 offensive players off the
bottom and silently EVICT them from Players, the draft board and every VOR pool.
The actual projected range is NOT hardcoded anywhere: notes[0] of the output
quotes it measured off the rows that build produced (see _proj_range).
K/DST therefore get their own contract file, read by the K and DEF
slots R19 shipped ("awaiting feed"). Nothing here touches player_projections.

WHY nflverse AND NOT ESPN
-------------------------
ESPN's kona endpoint does serve kickers (slot 17) and D/ST (slot 16), but a
careful decode of its kicker statIds reconciles only 33 of 42 kickers — nearly
right, which is the most dangerous kind of wrong. nflverse `stats_player_week`
carries NAMED columns fg_made_0_19 .. fg_made_60_ covering every FG bucket
exactly, plus pat_made / pat_missed / pat_blocked and the miss columns.
`stats_team_week` carries the team-defense counting stats, and the
points-allowed / yards-allowed TIERS are evaluated PER GAME and summed — which
is why weekly (not season-total) data is required: a season total cannot tell
you how many individual games were shutouts.

WHAT IS AND IS NOT MODELLED (the honesty requirement)
----------------------------------------------------
Three DEF scoring keys are genuinely unmodelable from this source and are
emitted in a machine-readable `unmodelled_keys` list so the UI can render a
PARTIAL SCORING marker. They are NOT quietly scored as zero and called a
complete total:

  def_4_and_stop   4th-down stops need play-by-play down/distance +
                   turnover-on-downs detection; no weekly column exists.
  def_st_ff        stats_team_week reports def_fumbles_forced for the whole
                   team; special-teams forced fumbles are not separable.
  def_st_fum_rec   likewise fumble_recovery_opp — special-teams recoveries are
                   not separable from defensive ones. NOTE the consequence:
                   the modelled `fum_rec` IS that whole-team column, so ST
                   recoveries are already COUNTED there. A league that scores
                   both keys is mis-attributed, never under-counted.

Everything else in app/league.js SCORING_FIELDS for K and DEF *is* modelled,
plus the Sleeper `yds_allow_*` tier family (an "unknown key" to league.js,
which keeps and applies unknown keys exactly like any other — so a Sleeper
league that scores yardage tiers scores correctly with no app change).

MARKET POLICY: nfldata games.csv is read for game_id / teams / SCORES ONLY.
Its spread_line, total_line, moneyline and odds columns are NEVER read here.

NETWORK: nflverse release assets 403 through some sandbox proxies but download
fine on GitHub Actions runners. On a feed error the existing output file is left
untouched and we exit 0 with a loud stderr warn. That degradation path is only
honest because a cron actually re-runs this: .github/workflows/backtest.yml
("Build K/DST projections"), alongside the other nflverse builders that read the
same release CSVs. If that step is ever removed, this file can never be
refreshed and the exit-0 path must go with it. `--selftest` drives the FULL
aggregation from
data/fixtures/kdst_sample/ and WRITES NOTHING.

Stdlib only (urllib + csv + json). No pandas, no requests, no nfl_data_py.
"""

import csv
import datetime as _dt
import io
import json
import os
import sys
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.renames import normalize_team  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "kdst_projections.json")
FIXTURE_DIR = os.path.join(DATA, "fixtures", "kdst_sample")

# Projection target season and the completed seasons it is built from
# (newest last). 2026 is upcoming; 2023-2025 are complete.
SEASON = 2026
SOURCE_SEASONS = (2023, 2024, 2025)

# Games in a projected season. Per-game rates are multiplied by this.
GAMES_PROJECTED = 17

# Below this much WEIGHTED evidence (see RECENCY_WEIGHTS) a projection is a
# small-sample extrapolation and is flagged `low_sample: true`. It is still
# published with its honest arithmetic — a 3-game rookie kicker really does
# rate that high per game — but the UI must be able to say so rather than rank
# him second on a draft board without comment.
LOW_SAMPLE_WEIGHTED_GAMES = float(GAMES_PROJECTED)

# Recency weights by offset from the NEWEST season actually used: the latest
# season counts 3x, the one before 2x, the one before that 1x. Weights apply to
# BOTH the numerator (stat) and the denominator (games), so this is a weighted
# per-game rate, never a weighted sum of unequal sample sizes.
RECENCY_WEIGHTS = (3.0, 2.0, 1.0)

_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
PLAYER_WEEK_URL = _RELEASE_BASE + "/stats_player/stats_player_week_%d.csv"
TEAM_WEEK_URL = _RELEASE_BASE + "/stats_team/stats_team_week_%d.csv"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
HTTP_TIMEOUT = 120

KICKER_POSITIONS = frozenset(["K", "PK"])

# --- column contracts -------------------------------------------------------
# Asserted on every fetched/loaded table. A renamed upstream column must red
# loudly here, never silently read as 0.
PLAYER_WEEK_COLUMNS = (
    "player_id", "player_display_name", "position", "season", "week",
    "season_type", "team",
    "pat_made", "pat_missed", "pat_blocked",
    "fg_missed", "fg_blocked",
    "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49",
    "fg_made_50_59", "fg_made_60_",
)
TEAM_WEEK_COLUMNS = (
    "season", "week", "team", "season_type", "game_id", "opponent_team",
    "passing_yards", "rushing_yards", "sack_yards_lost",
    "special_teams_tds", "def_sacks", "def_interceptions", "def_tds",
    "def_safeties", "def_punt_blocks", "def_pat_blocks", "def_fg_blocks",
    "fumble_recovery_opp",
    # R46 (owner's pick: measure what the data supports) — three more
    # defensive counting columns stats_team_week actually carries.
    "def_tackles_for_loss", "def_fumbles_forced", "def_pass_defended",
)
GAMES_COLUMNS = ("game_id", "home_team", "away_team", "home_score", "away_score")

# --- scoring-key surfaces ---------------------------------------------------
# Mirrors app/league.js SCORING_FIELDS for the kicking group, in that file's
# order. tests/feature/kdst.test.mjs imports league.js and asserts this list
# equals the real 'kicking' group — the mirror cannot drift silently.
KICKER_KEYS = (
    "xpm", "xpmiss",
    "fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50p",
    "fgmiss",
)

# Mirrors app/league.js SCORING_FIELDS 'defense' group, in that file's order.
DEF_KEYS = (
    "def_td", "def_st_td", "sack", "int", "fum_rec", "safe", "blk_kick",
    "pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20",
    "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p",
)

# Sleeper's yardage-allowed tier family. Not in league.js SCORING_FIELDS —
# league.js keeps unknown scoring keys and applies them exactly like known
# ones, so a Sleeper league importing these scores correctly with no app change.
# A league that does NOT score them contributes nothing (missing key = no term).
YDS_ALLOW_KEYS = (
    "yds_allow_0_100", "yds_allow_100_199", "yds_allow_200_299",
    "yds_allow_300_349", "yds_allow_350_399", "yds_allow_400_449",
    "yds_allow_450_499", "yds_allow_500_549", "yds_allow_550p",
)

# R46 — Sleeper keys MEASURED from columns stats_team_week and games.csv
# really carry (owner's pick over estimation: measured beats estimated).
# Same contract note as YDS_ALLOW_KEYS: not in league.js SCORING_FIELDS;
# league.js applies unknown scoring keys exactly like known ones, so a
# Sleeper league importing them scores correctly with no app change.
#   pts_allow      LINEAR points allowed (Sleeper prices it per point) — the
#                  same per-game score the pts_allow_* tiers already bucket.
#   ff             whole-team forced fumbles (def_fumbles_forced) — the same
#                  whole-team attribution note as fum_rec: a league also
#                  scoring def_st_ff is mis-attributed, not under-counted.
#   tkl_loss       def_tackles_for_loss.
#   def_pass_def   def_pass_defended.
MEASURED_EXTRA_DEF_KEYS = ("pts_allow", "ff", "tkl_loss", "def_pass_def")

# Points-allowed tier boundaries: (key, inclusive_max). Last is the open top.
_PTS_TIERS = (
    ("pts_allow_0", 0),
    ("pts_allow_1_6", 6),
    ("pts_allow_7_13", 13),
    ("pts_allow_14_20", 20),
    ("pts_allow_21_27", 27),
    ("pts_allow_28_34", 34),
    ("pts_allow_35p", None),
)

# Yards-allowed tier boundaries: (key, inclusive_max). Sleeper's buckets.
_YDS_TIERS = (
    ("yds_allow_0_100", 99),
    ("yds_allow_100_199", 199),
    ("yds_allow_200_299", 299),
    ("yds_allow_300_349", 349),
    ("yds_allow_350_399", 399),
    ("yds_allow_400_449", 449),
    ("yds_allow_450_499", 499),
    ("yds_allow_500_549", 549),
    ("yds_allow_550p", None),
)

# THE HONESTY LIST. Emitted verbatim into the contract so the UI can show a
# PARTIAL SCORING marker instead of presenting an incomplete total as complete.
UNMODELLED_KEYS = (
    {
        "key": "def_4_and_stop",
        "label": "4th-down stop",
        "position": "DEF",
        "reason": "Requires play-by-play down/distance and turnover-on-downs "
                  "detection; nflverse stats_team_week has no 4th-down-stop "
                  "column. Not estimated, not zeroed.",
    },
    {
        "key": "def_st_ff",
        "label": "Special-teams forced fumble",
        "position": "DEF",
        "reason": "stats_team_week reports def_fumbles_forced for the whole "
                  "team; special-teams forced fumbles are not separable from "
                  "defensive ones at weekly granularity. The modelled DEF "
                  "`ff` IS that whole-team column (R46), so special-teams "
                  "forced fumbles are already counted inside ff: a league "
                  "scoring both keys is mis-attributed, not under-counted.",
    },
    {
        "key": "def_st_fum_rec",
        "label": "Special-teams fumble recovery",
        "position": "DEF",
        "reason": "stats_team_week reports fumble_recovery_opp for the whole "
                  "team; special-teams recoveries are not separable from "
                  "defensive ones at weekly granularity. The modelled DEF "
                  "`fum_rec` IS that whole-team column, so special-teams "
                  "recoveries are already counted inside fum_rec: a league "
                  "scoring both keys is mis-attributed, not under-counted.",
    },
)

# Default full-PPR scoring, MIRRORED from app/league.js DEFAULT_SCORING (only
# the keys this file can produce). proj_points is computed with this table so
# the published number is meaningful without a saved LeagueProfile; the UI
# recomputes from `stats` with applyScoring(stats, profile) for a real league.
# tests/feature/kdst.test.mjs asserts these values equal league.js's.
DEFAULT_SCORING = {
    "xpm": 1, "xpmiss": -1,
    "fgm_0_19": 3, "fgm_20_29": 3, "fgm_30_39": 3, "fgm_40_49": 4,
    "fgm_50p": 5, "fgmiss": -1,
    "def_td": 6, "def_st_td": 6, "sack": 1, "int": 2, "fum_rec": 2,
    "safe": 2, "blk_kick": 2,
    "pts_allow_0": 10, "pts_allow_1_6": 7, "pts_allow_7_13": 4,
    "pts_allow_14_20": 1, "pts_allow_21_27": 0, "pts_allow_28_34": -1,
    "pts_allow_35p": -4,
}


class KdstFeedError(RuntimeError):
    """A feed is unreachable, non-200, empty, or missing a required column.
    Never swallowed into a partial write."""


# ---------------------------------------------------------------------------
# Fetch / load
# ---------------------------------------------------------------------------

def _fetch_csv(url, label):
    """GET a CSV with the stdlib and parse it to list[dict].

    LOUD on everything: transport failure, non-200, zero bytes, zero rows. A
    failed fetch must never be mistaken for an empty table (the silent-404
    lesson)."""
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
            if resp.status != 200:
                raise KdstFeedError("GET %s returned HTTP %s" % (url, resp.status))
            raw = resp.read()
    except KdstFeedError:
        raise
    except Exception as exc:
        raise KdstFeedError("GET %s failed in transport: %s" % (url, exc)) from exc
    if not raw:
        raise KdstFeedError("GET %s returned 0 bytes" % url)
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    if not rows:
        raise KdstFeedError("%s (%s) parsed to 0 rows" % (label, url))
    return rows


def _require_columns(rows, columns, label):
    """Every column in `columns` must exist on the first row. An upstream rename
    reds here instead of being read as 0 for the rest of time."""
    have = set(rows[0].keys())
    missing = [c for c in columns if c not in have]
    if missing:
        raise KdstFeedError(
            "%s is missing required column(s): %s. Upstream renamed something — "
            "refusing to read them as zero." % (label, ", ".join(missing)))
    return rows


def _num(row, key):
    """A CSV cell as float. Blank / 'NA' / None -> 0.0. Non-numeric text raises,
    because a stat column full of words is a schema change, not a zero."""
    v = row.get(key)
    if v is None:
        return 0.0
    s = str(v).strip()
    if s == "" or s.upper() in ("NA", "NAN", "NULL"):
        return 0.0
    return float(s)


def _int_or_none(row, key):
    v = row.get(key)
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.upper() in ("NA", "NAN", "NULL"):
        return None
    return int(float(s))


# ---------------------------------------------------------------------------
# Pure aggregation
# ---------------------------------------------------------------------------

def _season_weights(seasons):
    """{season: weight} by recency. Newest season gets RECENCY_WEIGHTS[0]; any
    season older than the table gets the last (smallest) weight rather than 0,
    so an extra season of history never silently disappears."""
    ordered = sorted(set(int(s) for s in seasons), reverse=True)
    out = {}
    for i, s in enumerate(ordered):
        out[s] = RECENCY_WEIGHTS[i] if i < len(RECENCY_WEIGHTS) else RECENCY_WEIGHTS[-1]
    return out


def _project(per_season, weights, keys):
    """Weighted per-game rate x GAMES_PROJECTED, per key.

    per_season: {season: {"games": int, "totals": {key: float}}}
    Returns ({key: projected_count_rounded_2dp}, weighted_games_denominator).
    """
    denom = 0.0
    for season, rec in per_season.items():
        denom += weights.get(season, 0.0) * rec["games"]
    stats = {}
    for key in keys:
        num = 0.0
        for season, rec in per_season.items():
            num += weights.get(season, 0.0) * rec["totals"].get(key, 0.0)
        stats[key] = round((num / denom) * GAMES_PROJECTED, 2) if denom > 0 else 0.0
    return stats, denom


def _score(stats):
    """proj_points under the mirrored DEFAULT_SCORING. Exact per-stat
    arithmetic — sum(stat x points-per-stat) — identical in form to
    app/league.js applyScoring(). Keys the table does not score contribute
    nothing (that is how yds_allow_* stays inert by default)."""
    total = 0.0
    for key, value in stats.items():
        pts = DEFAULT_SCORING.get(key)
        if pts is None:
            continue
        total += value * pts
    return round(total, 2)


def _tier(value, tiers):
    """Bucket a per-game value into a (key, inclusive_max) tier table."""
    for key, hi in tiers:
        if hi is None or value <= hi:
            return key
    return tiers[-1][0]


def aggregate_kickers(player_rows_by_season):
    """{gsis_id: record} for every kicker who played in the NEWEST season given.

    A kicker who last appeared in an older season is deliberately NOT projected:
    he is not on the 2026 kicker population, and inventing a projection for him
    would be fabrication. Pure — no I/O.
    """
    seasons = sorted(player_rows_by_season)
    if not seasons:
        return [], []
    latest = seasons[-1]
    weights = _season_weights(seasons)

    # gsis_id -> {season -> {games, totals}} plus identity from the newest row.
    acc = {}
    skipped = []
    for season in seasons:
        for row in player_rows_by_season[season]:
            if str(row.get("season_type") or "").upper() != "REG":
                continue
            if str(row.get("position") or "").upper() not in KICKER_POSITIONS:
                continue
            pid = str(row.get("player_id") or "").strip()
            if not pid:
                continue
            team = normalize_team(row.get("team"))
            if team is None:
                skipped.append({
                    "kind": "kicker_week",
                    "season": season,
                    "player": str(row.get("player_display_name") or pid),
                    "team_raw": str(row.get("team")),
                    "reason": "team abbreviation does not normalize to a "
                              "canonical nflverse team",
                })
                continue
            rec = acc.setdefault(pid, {"per_season": {}, "last": None})
            per = rec["per_season"].setdefault(
                season, {"games": 0, "totals": dict.fromkeys(KICKER_KEYS, 0.0)})
            per["games"] += 1
            t = per["totals"]
            # xpmiss counts BLOCKED extra points as misses: an attempt that did
            # not go through is a miss in every fantasy scoring table we know.
            t["xpm"] += _num(row, "pat_made")
            t["xpmiss"] += _num(row, "pat_missed") + _num(row, "pat_blocked")
            t["fgm_0_19"] += _num(row, "fg_made_0_19")
            t["fgm_20_29"] += _num(row, "fg_made_20_29")
            t["fgm_30_39"] += _num(row, "fg_made_30_39")
            t["fgm_40_49"] += _num(row, "fg_made_40_49")
            # league.js has ONE 50+ bucket; nflverse splits 50-59 and 60+.
            t["fgm_50p"] += _num(row, "fg_made_50_59") + _num(row, "fg_made_60_")
            # Likewise fgmiss counts blocked field goals as misses.
            t["fgmiss"] += _num(row, "fg_missed") + _num(row, "fg_blocked")
            week = _int_or_none(row, "week") or 0
            stamp = (season, week)
            if rec["last"] is None or stamp >= rec["last"][0]:
                rec["last"] = (stamp, str(row.get("player_display_name") or pid), team)

    out = []
    for pid, rec in acc.items():
        if latest not in rec["per_season"]:
            continue  # did not play in the newest season — not projected
        stats, denom = _project(rec["per_season"], weights, KICKER_KEYS)
        _stamp, name, team = rec["last"]
        out.append({
            "player_id": pid,
            "name": name,
            "team": team,
            "position": "K",
            "games_sample": sum(v["games"] for v in rec["per_season"].values()),
            "seasons_sample": sorted(rec["per_season"]),
            "weighted_games": round(denom, 2),
            "low_sample": denom < LOW_SAMPLE_WEIGHTED_GAMES,
            "stats": stats,
            "proj_points": _score(stats),
        })
    out.sort(key=lambda r: (-r["proj_points"], r["name"], r["player_id"]))
    return out, skipped


def aggregate_defenses(team_rows_by_season, scores_by_game, team_names=None):
    """[record] per team, projected from weekly team-defense rows.

    scores_by_game: {game_id: {"home": ABBR, "away": ABBR, "home_score": int,
    "away_score": int}} — from nfldata games.csv, SCORES ONLY.

    Points allowed and yards allowed are evaluated PER GAME and tallied into
    tiers; a season total could not produce a shutout count. Yards allowed is
    the opponent's NET total (passing_yards + sack_yards_lost + rushing_yards;
    nflverse ships sack_yards_lost negative), which reproduces official net
    total yards.

    A game with no score row, no opponent stat row, or an unmappable team is
    SKIPPED WHOLE and recorded — never half-counted. Pure — no I/O.
    """
    seasons = sorted(team_rows_by_season)
    if not seasons:
        return [], []
    weights = _season_weights(seasons)
    all_keys = DEF_KEYS + YDS_ALLOW_KEYS + MEASURED_EXTRA_DEF_KEYS

    acc = {}
    skipped = []
    for season in seasons:
        rows = [r for r in team_rows_by_season[season]
                if str(r.get("season_type") or "").upper() == "REG"]
        # (game_id, canonical team) -> row, for the opponent-yardage lookup.
        by_game = {}
        for r in rows:
            ab = normalize_team(r.get("team"))
            if ab is None:
                continue
            by_game[(str(r.get("game_id")), ab)] = r

        for r in rows:
            gid = str(r.get("game_id") or "")
            team = normalize_team(r.get("team"))
            opp = normalize_team(r.get("opponent_team"))
            if team is None or opp is None:
                skipped.append({
                    "kind": "dst_game", "season": season, "game_id": gid,
                    "team": str(r.get("team")),
                    "reason": "team or opponent abbreviation does not normalize "
                              "to a canonical nflverse team",
                })
                continue
            game = scores_by_game.get(gid)
            if game is None:
                skipped.append({
                    "kind": "dst_game", "season": season, "game_id": gid,
                    "team": team,
                    "reason": "no score row in nfldata games.csv — points "
                              "allowed is unknown, so the whole game is dropped",
                })
                continue
            if team == game["home"]:
                pts_allowed = game["away_score"]
            elif team == game["away"]:
                pts_allowed = game["home_score"]
            else:
                skipped.append({
                    "kind": "dst_game", "season": season, "game_id": gid,
                    "team": team,
                    "reason": "team is neither side of the games.csv row for "
                              "this game_id",
                })
                continue
            if pts_allowed is None:
                skipped.append({
                    "kind": "dst_game", "season": season, "game_id": gid,
                    "team": team,
                    "reason": "games.csv row has no final score (unplayed or "
                              "unresolved)",
                })
                continue
            opp_row = by_game.get((gid, opp))
            if opp_row is None:
                skipped.append({
                    "kind": "dst_game", "season": season, "game_id": gid,
                    "team": team,
                    "reason": "no opponent stat row for this game_id — yards "
                              "allowed is unknown, so the whole game is dropped",
                })
                continue

            per = acc.setdefault(team, {}).setdefault(
                season, {"games": 0, "totals": dict.fromkeys(all_keys, 0.0)})
            per["games"] += 1
            t = per["totals"]
            t["def_td"] += _num(r, "def_tds")
            t["def_st_td"] += _num(r, "special_teams_tds")
            t["sack"] += _num(r, "def_sacks")
            t["int"] += _num(r, "def_interceptions")
            t["fum_rec"] += _num(r, "fumble_recovery_opp")
            t["safe"] += _num(r, "def_safeties")
            t["blk_kick"] += (_num(r, "def_punt_blocks")
                              + _num(r, "def_pat_blocks")
                              + _num(r, "def_fg_blocks"))
            t[_tier(pts_allowed, _PTS_TIERS)] += 1.0
            # R46 — the measured extras. pts_allow is the LINEAR form of the
            # same number the tier above buckets; the other three are direct
            # stats_team_week columns (required by TEAM_WEEK_COLUMNS).
            t["pts_allow"] += float(pts_allowed)
            t["ff"] += _num(r, "def_fumbles_forced")
            t["tkl_loss"] += _num(r, "def_tackles_for_loss")
            t["def_pass_def"] += _num(r, "def_pass_defended")
            yds_allowed = (_num(opp_row, "passing_yards")
                           + _num(opp_row, "sack_yards_lost")
                           + _num(opp_row, "rushing_yards"))
            t[_tier(yds_allowed, _YDS_TIERS)] += 1.0

    names = team_names or {}
    out = []
    for team, per_season in acc.items():
        stats, denom = _project(per_season, weights, all_keys)
        out.append({
            "player_id": "DST-" + team,
            "name": (names.get(team) or team) + " Defense",
            "team": team,
            "position": "DEF",
            "games_sample": sum(v["games"] for v in per_season.values()),
            "seasons_sample": sorted(per_season),
            "weighted_games": round(denom, 2),
            "low_sample": denom < LOW_SAMPLE_WEIGHTED_GAMES,
            "stats": stats,
            "proj_points": _score(stats),
        })
    out.sort(key=lambda r: (-r["proj_points"], r["team"]))
    return out, skipped


def games_index(game_rows):
    """{game_id: {home, away, home_score, away_score}} from nfldata games.csv.

    MARKET POLICY: only these five columns are read. spread_line, total_line,
    the moneylines and every odds column are NEVER touched by this file.
    """
    out = {}
    for r in game_rows:
        gid = str(r.get("game_id") or "").strip()
        if not gid:
            continue
        home = normalize_team(r.get("home_team"))
        away = normalize_team(r.get("away_team"))
        if home is None or away is None:
            continue
        out[gid] = {
            "home": home,
            "away": away,
            "home_score": _int_or_none(r, "home_score"),
            "away_score": _int_or_none(r, "away_score"),
        }
    return out


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def _fixture_rows(name):
    with open(os.path.join(FIXTURE_DIR, name), encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def team_names():
    """{abbrev: 'City Nickname'} from the committed data/fixtures/teams.json, for
    D/ST display names. No network. An unreadable file degrades to abbreviations
    rather than failing the build."""
    try:
        with open(os.path.join(DATA, "fixtures", "teams.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    out = {}
    for t in doc.get("teams", []):
        ab = normalize_team(t.get("abbrev"))
        if ab and t.get("name"):
            out[ab] = str(t["name"])
    return out


def build(selftest=False):
    """Assemble the whole document. selftest=True reads the committed fixtures
    and never touches the network."""
    player_by_season = {}
    team_by_season = {}
    skipped = []

    if selftest:
        pw = _require_columns(_fixture_rows("player_week.csv"),
                              PLAYER_WEEK_COLUMNS, "fixture player_week.csv")
        tw = _require_columns(_fixture_rows("team_week.csv"),
                              TEAM_WEEK_COLUMNS, "fixture team_week.csv")
        gm = _require_columns(_fixture_rows("games.csv"),
                              GAMES_COLUMNS, "fixture games.csv")
        for r in pw:
            player_by_season.setdefault(int(r["season"]), []).append(r)
        for r in tw:
            team_by_season.setdefault(int(r["season"]), []).append(r)
        source = "selftest fixtures (data/fixtures/kdst_sample)"
    else:
        gm = _require_columns(_fetch_csv(GAMES_URL, "nfldata games.csv"),
                              GAMES_COLUMNS, "nfldata games.csv")
        for season in SOURCE_SEASONS:
            # A season that 404s or comes back short is SKIPPED LOUDLY and the
            # rest of the build proceeds on the seasons that did arrive. It is
            # never silently replaced with zeros.
            try:
                rows = _require_columns(
                    _fetch_csv(PLAYER_WEEK_URL % season,
                               "stats_player_week_%d" % season),
                    PLAYER_WEEK_COLUMNS, "stats_player_week_%d" % season)
                player_by_season[season] = rows
            except KdstFeedError as exc:
                skipped.append({"kind": "player_season", "season": season,
                                "reason": str(exc)})
                print("[warn] kicker season %d skipped: %s" % (season, exc),
                      file=sys.stderr)
            try:
                rows = _require_columns(
                    _fetch_csv(TEAM_WEEK_URL % season,
                               "stats_team_week_%d" % season),
                    TEAM_WEEK_COLUMNS, "stats_team_week_%d" % season)
                team_by_season[season] = rows
            except KdstFeedError as exc:
                skipped.append({"kind": "team_season", "season": season,
                                "reason": str(exc)})
                print("[warn] defense season %d skipped: %s" % (season, exc),
                      file=sys.stderr)
        if not player_by_season and not team_by_season:
            raise KdstFeedError(
                "every source season failed — refusing to write an empty "
                "projection file over a good one")
        source = ("nflverse release CSVs (stats_player_week / stats_team_week) "
                  "+ nfldata games.csv scores")

    scores = games_index(gm)
    kickers, k_skipped = aggregate_kickers(player_by_season)
    defenses, d_skipped = aggregate_defenses(team_by_season, scores, team_names())
    skipped.extend(k_skipped)
    skipped.extend(d_skipped)

    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "season": SEASON,
        "updated_utc": now,
        "source": source,
        "seasons_used": sorted(set(player_by_season) | set(team_by_season)),
        "games_projected": GAMES_PROJECTED,
        "recency_weights": {str(s): w for s, w in
                            _season_weights(set(player_by_season)
                                            | set(team_by_season)).items()},
        "scoring_basis": "app/league.js DEFAULT_PROFILE (mirrored). Recompute "
                         "from `stats` with applyScoring(stats, profile) for a "
                         "real league profile.",
        "modelled_keys": {
            "K": list(KICKER_KEYS),
            "DEF": list(DEF_KEYS) + list(YDS_ALLOW_KEYS)
                   + list(MEASURED_EXTRA_DEF_KEYS),
        },
        "unmodelled_keys": [dict(k) for k in UNMODELLED_KEYS],
        "partial_scoring": {"K": False, "DEF": True},
        "skipped": skipped,
        "kickers": kickers,
        "defenses": defenses,
        "notes": [
            "SEPARATE CONTRACT ON PURPOSE: merging K/DST into "
            "player_projections.json would evict ~74 offensive players from the "
            "projected[:300] cut (300th offensive player = 38.8 pts; this "
            "build's kickers project %s, D/ST %s). Measured off these rows, not "
            "assumed." % (_proj_range(kickers), _proj_range(defenses)),
            "Source is nflverse, NOT ESPN: ESPN kona's kicker statIds reconcile "
            "only 33 of 42 kickers. nflverse ships named fg_made_0_19.."
            "fg_made_60_ buckets that cover every attempt exactly.",
            "Points-allowed and yards-allowed tiers are evaluated PER GAME and "
            "summed, which is why weekly (not season-total) data is required.",
            "Yards allowed = opponent NET total yards (passing_yards + "
            "sack_yards_lost + rushing_yards; nflverse ships sack_yards_lost "
            "negative).",
            "PARTIAL SCORING for DEF: see unmodelled_keys. Those keys are "
            "absent from `stats` — they are NOT scored as zero and presented as "
            "a complete total.",
            "fgmiss counts blocked field goals and xpmiss counts blocked extra "
            "points: an attempt that did not go through is a miss.",
            "low_sample=true marks a projection built on less than one full "
            "projected season of WEIGHTED evidence (weighted_games < %d). The "
            "arithmetic is unchanged and honest; the flag exists so a 3-game "
            "kicker is not ranked silently." % GAMES_PROJECTED,
            "Only kickers who played in the newest season used are projected; a "
            "kicker who last appeared earlier is not on the population and is "
            "not invented.",
            "MARKET POLICY: nfldata games.csv is read for game_id / teams / "
            "scores only. No spread, total, moneyline or odds column is read.",
            "No low/high interval is published — none is modelled yet, and a "
            "fabricated one would be worse than none.",
        ],
    }


def _proj_range(rows):
    """Range of proj_points across `rows`, as "lo-hi" with one decimal place.

    The eviction note quotes this range, so it is MEASURED off the rows this
    build actually produced instead of hardcoded. A hardcoded range labelled
    "Measured" goes stale the moment the population or the scoring moves, and a
    false range in a shipped note is worse than publishing no range at all.
    """
    vals = [r["proj_points"] for r in rows if r.get("proj_points") is not None]
    if not vals:
        return "none projected"
    return "%.1f-%.1f" % (min(vals), max(vals))


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def main():
    selftest = "--selftest" in sys.argv
    if selftest:
        # The selftest reads COMMITTED fixtures, so a KdstFeedError here is a
        # broken fixture, not an unreachable host. It must propagate and red the
        # gate — never be swallowed by the network-degradation path below.
        doc = build(selftest=True)
    else:
        try:
            doc = build(selftest=False)
        except KdstFeedError as exc:
            # Unreachable host (sandbox proxy) — keep any existing file, exit 0
            # loudly. The cron on the GH runner (open network) fills this in.
            print("[warn] kdst projections unavailable, existing file untouched: %s"
                  "\n[warn] refresh runs on the GH runner: "
                  ".github/workflows/backtest.yml -> "
                  "'Build K/DST projections'"
                  % exc, file=sys.stderr)
            return None
    if selftest:
        # Fixture-derived numbers must never masquerade as real data, so the
        # selftest writes NOTHING.
        print("selftest ok (no file written): %d kickers, %d defenses, "
              "%d skipped, %d unmodelled DEF keys"
              % (len(doc["kickers"]), len(doc["defenses"]),
                 len(doc["skipped"]), len(doc["unmodelled_keys"])))
        return doc
    _write(OUT_PATH, doc)
    print("wrote %s: %d kickers, %d defenses, seasons %s, %d skipped"
          % (OUT_PATH, len(doc["kickers"]), len(doc["defenses"]),
             doc["seasons_used"], len(doc["skipped"])))
    return doc


if __name__ == "__main__":
    main()
