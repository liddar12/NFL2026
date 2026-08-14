"""Build data/scheme_history.json — per-season, per-team, per-week FTN charting
sums that describe HOW a team plays, for the `scheme_matchup` gate family
(scripts/signals/scheme_matchup.py).

THE APPLICATION PATH IS DARK, AND THIS FILE SAYS SO IN THE DATA
---------------------------------------------------------------
FTN charting exists from 2022. It does NOT exist for the live 2026 season: the
release URL 404s. So this feed can support a BACKTEST of `scheme_matchup` and
it can NOT support applying that family to a live 2026 game. A family that
silently prices every 2026 game at a neutral 0.0 is indistinguishable from a
family that is working, so the artifact carries an explicit `application`
block, probed at build time rather than asserted:

    "application": {"live_season": 2026, "applied": false, "dark": true,
                    "http_status": 404, "reason": "...", "checked_utc": "..."}

`scheme_matchup.delta_from_params` RAISES on a season this block calls dark; it
never returns a neutral number for it. See that module's docstring.

THE JOIN (the thing that has broken every previous attempt)
-----------------------------------------------------------
The FTN charting release carries NO posteam/defteam column. There is no way to
attribute a charted play to a team from the FTN file alone. So the builder
streams the nflverse play-by-play release for the same season, indexes
`(game_id, play_id) -> (posteam, defteam, week, season_type)`, and joins FTN on
`(nflverse_game_id, nflverse_play_id)`. Unjoined FTN rows are COUNTED and
reported; above MAX_UNJOINED_SHARE the build raises rather than writing an
artifact built on a join that quietly half-works.

Measured 2022-2025: 185,215 FTN rows, 0 unjoined.

THE SENTINEL (mandatory filter)
-------------------------------
About 23.7% of FTN rows carry a literal 0 in `n_defense_box` (and, from 2023,
in `qb_location`; 2022 leaves `qb_location` BLANK instead). Those are uncharted
plays and special teams. Their boolean columns are all FALSE by default, so
keeping them would not add noise — it would add a systematic downward bias to
every rate, proportional to how much special teams a game had. Dropping them is
mandatory, the count is recorded per season, and `--selftest` asserts the filter
fires on a fixture row that carries the sentinel.

COLUMN NAMES ARE ASSERTED, NOT ASSUMED
--------------------------------------
REQUIRED_FTN_COLUMNS is checked against the header before a single row is
parsed. The screen column is `is_screen_pass`; a rename upstream (e.g. to
`is_screen_p`) must fail loud, not quietly zero the feature.

WHAT IS EMITTED: SUMS, NEVER RATES
----------------------------------
    off_plays, pa, screen, motion, no_huddle    (credited to posteam)
    def_plays, box_sum, box_plays               (credited to defteam)

Sums recompose exactly over any window: `pa/off_plays` over weeks 1..W-1 is the
sum of the numerators over the sum of the denominators. A stored rate could
not be re-windowed without re-weighting, and the family's whole leak-freedom
argument is about which weeks are in the window.

`box_plays == def_plays` by construction after the sentinel filter (every kept
row has a charted box). Both are emitted anyway: the day the filter changes,
the two diverge and the divergence is visible in the artifact instead of being
an invisible assumption inside the family.

REGULAR SEASON ONLY. Postseason plays are dropped from the aggregation for the
same reason `build_dvp_positional.py` drops them: only good teams play in
January, so a prior-season rate that included it would be a survivorship-biased
description of a team rather than a measurement of one. Postseason GAMES are
still priced by the family — a week-19 game simply reads the complete weeks-1-18
window.

Team codes are renamed to the corpus convention: LA->LAR, OAK->LV, SD->LAC,
STL->LAR. Byte-identical to scripts/build_backtest_corpus.py's map.

ATTRIBUTION: FTN Data via nflverse, licensed CC-BY-SA 4.0. The credit is
carried IN the artifact (`attribution` / `license`) so that anything rendering
a scheme-derived number reads the credit from the data. Removing the feed
removes the credit; it cannot go stale.

MARKET BOUNDARY: this builder reads a play-charting feed and a play-by-play
feed. It never reads, derives or writes a spread, total or moneyline. None of
the eight betting columns exist in either source.

Stdlib only. `--selftest` runs on the committed fixtures and never writes data/.
"""

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "scheme_history.json")
FIXTURE_DIR = os.path.join(DATA, "fixtures", "nflverse_sample")
FTN_FIXTURE = os.path.join(FIXTURE_DIR, "ftn_sample.csv")
PBP_FIXTURE = os.path.join(FIXTURE_DIR, "pbp_scheme.csv")

RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
FTN_URL = RELEASE_BASE + "/ftn_charting/ftn_charting_{season}.csv"
PBP_URL = RELEASE_BASE + "/pbp/play_by_play_{season}.csv.gz"

# FTN charting begins in 2022. Earlier seasons are ABSENT from the artifact,
# never zero — "we do not know" and "there was none" are different claims.
FIRST_FTN_SEASON = 2022
LAST_FTN_SEASON = 2025

# The season the model would apply to if it could. Probed, not assumed.
LIVE_SEASON = 2026

RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}

# Asserted against the header before parsing. `is_screen_pass` is the real
# column name; the assertion is the only thing standing between an upstream
# rename and a feature that silently reads zero forever.
REQUIRED_FTN_COLUMNS = (
    "nflverse_game_id", "nflverse_play_id", "season", "week",
    "is_play_action", "is_screen_pass", "is_motion", "is_no_huddle",
    "n_defense_box", "n_offense_backfield", "qb_location",
)
REQUIRED_PBP_COLUMNS = ("game_id", "play_id", "posteam", "defteam",
                        "week", "season_type")

# A join that half-works is worse than no feed: it would look like a real
# measurement on half the plays. Measured share 2022-2025 is 0.0.
MAX_UNJOINED_SHARE = 0.02

# Charted-play flags credited to the offense, and the artifact key each lands in.
OFF_FLAGS = (("is_play_action", "pa"), ("is_screen_pass", "screen"),
             ("is_motion", "motion"), ("is_no_huddle", "no_huddle"))

SENTINEL_RULE = ("a row is UNCHARTED and dropped when n_defense_box is 0 or "
                 "blank, or qb_location is '0' or blank (2022 uses blank where "
                 "2023+ uses 0); these are uncharted plays and special teams")

ATTRIBUTION = "FTN Data via nflverse"
LICENSE = "CC-BY-SA 4.0"

_HTTP_TIMEOUT = 300


class BuildError(RuntimeError):
    """Raised instead of writing a file we cannot stand behind."""


# --------------------------------------------------------------------------- #
# parsing                                                                      #
# --------------------------------------------------------------------------- #

def norm_team(code):
    """Corpus team code. Blank stays blank so the caller can drop the row."""
    c = (code or "").strip().upper()
    return RENAMES.get(c, c)


def _flag(value):
    """An FTN boolean column as 0/1. Blank, NA and anything unrecognised are 0
    — the columns are written TRUE/FALSE and a blank means 'not charted as
    this', which is exactly zero."""
    v = (value or "").strip().upper()
    return 1 if v in ("TRUE", "T", "1") else 0


def _int_or_none(value):
    v = (value or "").strip()
    if not v or v in ("NA", "NaN", "nan", "NULL"):
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def is_uncharted(row):
    """The MANDATORY sentinel filter (see module docstring).

    True when the row carries the uncharted marker in either charted-numeric
    column. ~23.7% of the release is this shape; keeping it would bias every
    rate downward in proportion to a game's special-teams volume.
    """
    box = _int_or_none(row.get("n_defense_box"))
    if box is None or box == 0:
        return True
    qb = (row.get("qb_location") or "").strip()
    if qb == "" or qb == "0":
        return True
    return False


def _blank_team():
    return {"off_plays": 0, "pa": 0, "screen": 0, "motion": 0, "no_huddle": 0,
            "def_plays": 0, "box_sum": 0, "box_plays": 0}


# --------------------------------------------------------------------------- #
# the join                                                                     #
# --------------------------------------------------------------------------- #

def index_pbp(pbp_rows):
    """`{(game_id, play_id): (posteam, defteam, week, season_type)}`.

    Consumes an ITERATOR of dict rows and keeps only the five fields, so a
    ~50k-play season costs five small strings per play and the full row is
    discarded immediately.
    """
    idx = {}
    first = True
    for row in pbp_rows:
        if first:
            missing = [c for c in REQUIRED_PBP_COLUMNS if c not in row]
            if missing:
                raise BuildError(
                    f"nflverse pbp is missing required column(s) {missing}; "
                    "refusing to guess team attribution")
            first = False
        idx[(row["game_id"], row["play_id"])] = (
            norm_team(row.get("posteam")), norm_team(row.get("defteam")),
            (row.get("week") or "").strip(), (row.get("season_type") or "").strip())
    if first:
        raise BuildError("nflverse pbp returned zero rows")
    return idx


def accumulate_season(season, ftn_rows, pbp_index,
                      max_unjoined_share=MAX_UNJOINED_SHARE):
    """Fold one season's charted plays into `{team: {week: sums}}` + diagnostics.

    `ftn_rows` is a list of dicts (the FTN release is ~48k rows, small enough to
    hold; the pbp side is the one that is streamed).

    `max_unjoined_share` is a parameter only so the 13-row selftest fixture can
    carry a deliberately unjoinable row without tripping a ceiling written for
    48,000-row seasons. The build path never passes it; the selftest asserts
    the DEFAULT ceiling still raises on that same fixture.
    """
    if not ftn_rows:
        raise BuildError(f"FTN season {season} returned zero rows")
    missing = [c for c in REQUIRED_FTN_COLUMNS if c not in ftn_rows[0]]
    if missing:
        raise BuildError(
            f"FTN charting {season} is missing required column(s) {missing}. "
            "The column is `is_screen_pass`, not `is_screen_p` — an upstream "
            "rename must fail loud, never silently read zero.")

    teams = {}
    diag = {"ftn_rows": len(ftn_rows), "unjoined": 0, "uncharted_dropped": 0,
            "postseason_dropped": 0, "no_team_dropped": 0, "kept": 0}

    for row in ftn_rows:
        key = (row["nflverse_game_id"], row["nflverse_play_id"])
        hit = pbp_index.get(key)
        if hit is None:
            diag["unjoined"] += 1
            continue
        posteam, defteam, week, season_type = hit
        if season_type != "REG":
            diag["postseason_dropped"] += 1
            continue
        if is_uncharted(row):
            diag["uncharted_dropped"] += 1
            continue
        if not posteam or not defteam or not week:
            diag["no_team_dropped"] += 1
            continue

        box = _int_or_none(row.get("n_defense_box"))
        off = teams.setdefault(posteam, {}).setdefault(week, _blank_team())
        off["off_plays"] += 1
        for col, key_name in OFF_FLAGS:
            off[key_name] += _flag(row.get(col))
        dfn = teams.setdefault(defteam, {}).setdefault(week, _blank_team())
        dfn["def_plays"] += 1
        dfn["box_sum"] += box
        dfn["box_plays"] += 1
        diag["kept"] += 1

    share = diag["unjoined"] / float(diag["ftn_rows"])
    diag["unjoined_share"] = round(share, 6)
    if share > max_unjoined_share:
        raise BuildError(
            f"FTN {season}: {diag['unjoined']} of {diag['ftn_rows']} rows "
            f"({share:.2%}) did not join to play-by-play, above the "
            f"{max_unjoined_share:.0%} ceiling. A join that half-works would be "
            "recorded as a measurement. Refusing to write.")
    if not diag["kept"]:
        raise BuildError(f"FTN {season}: every row was dropped — nothing to write")
    return teams, diag


# --------------------------------------------------------------------------- #
# fetch                                                                        #
# --------------------------------------------------------------------------- #

def _requests():
    try:
        import requests                                   # noqa: PLC0415
    except ImportError as exc:                            # pragma: no cover
        raise BuildError("requests is required to fetch nflverse releases") from exc
    return requests


def fetch_ftn(season, cache_dir=None):
    """FTN charting rows for one season. A non-200 raises — a 404 is never
    treated as an empty season."""
    url = FTN_URL.format(season=int(season))
    cached = (os.path.join(cache_dir, f"ftn_charting_{season}.csv")
              if cache_dir else None)
    if cached and os.path.exists(cached):
        with open(cached, encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh))
    resp = _requests().get(url, timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise BuildError(f"GET {url} returned HTTP {resp.status_code}; refusing "
                         "to treat a non-200 as an empty season")
    text = resp.content.decode("utf-8", errors="replace")
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cached, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
    return list(csv.DictReader(io.StringIO(text)))


def iter_pbp(season, cache_dir=None):
    """STREAM play-by-play dict rows for one season. Never held whole."""
    url = PBP_URL.format(season=int(season))
    cached = (os.path.join(cache_dir, f"play_by_play_{season}.csv.gz")
              if cache_dir else None)
    if cached and os.path.exists(cached):
        with gzip.open(cached, "rt", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                yield row
        return
    resp = _requests().get(url, timeout=_HTTP_TIMEOUT, stream=True)
    if resp.status_code != 200:
        raise BuildError(f"GET {url} returned HTTP {resp.status_code}; refusing "
                         "to treat a non-200 as an empty season")
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        with open(cached, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
        with gzip.open(cached, "rt", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                yield row
        return
    resp.raw.decode_content = True
    text = io.TextIOWrapper(gzip.GzipFile(fileobj=resp.raw), encoding="utf-8",
                            newline="")
    for row in csv.DictReader(text):
        yield row


def probe_live_season(season=LIVE_SEASON):
    """Ask the release host whether the LIVE season has an FTN file yet.

    The `application` block is derived from this answer, never asserted. If FTN
    ever publishes 2026 mid-season, a rebuild flips `dark` to false on its own
    and nobody has to remember to edit a constant.
    """
    url = FTN_URL.format(season=int(season))
    checked = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        resp = _requests().head(url, timeout=60, allow_redirects=True)
        status = int(resp.status_code)
    except Exception as exc:                              # pragma: no cover
        return {"live_season": int(season), "applied": False, "dark": True,
                "http_status": None, "checked_utc": checked,
                "url": url,
                "reason": f"probe of {url} failed in transport: {exc}. The "
                          "application path stays DARK until a probe succeeds."}
    dark = status != 200
    return {
        "live_season": int(season),
        "applied": False,
        "dark": dark,
        "http_status": status,
        "checked_utc": checked,
        "url": url,
        "reason": (
            f"FTN charting has no {season} release (HTTP {status} at {url}), so "
            "scheme_matchup CANNOT be applied to the live season. It is a "
            "BACKTEST-ONLY family: scripts/signals/scheme_matchup.py raises on "
            "a dark season rather than pricing it at a neutral 0.0, because a "
            "family that silently no-ops is indistinguishable from one that "
            "works."
            if dark else
            f"FTN charting {season} is published (HTTP 200 at {url}); the input "
            "exists, but `applied` stays false until a prediction-time reader "
            "is wired into scripts/build_predictions.py."),
    }


# --------------------------------------------------------------------------- #
# document                                                                     #
# --------------------------------------------------------------------------- #

def document(seasons_map, diagnostics, application):
    covered = sorted(int(y) for y in seasons_map)
    return {
        "generated_utc": dt.datetime.now(dt.timezone.utc)
                           .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": "scheme_history",
        "source": ("nflverse FTN charting release joined to the nflverse "
                   "play-by-play release on (nflverse_game_id, nflverse_play_id) "
                   "— the FTN file carries no posteam/defteam column"),
        "source_url": FTN_URL.format(season="{season}"),
        "pbp_url": PBP_URL.format(season="{season}"),
        "attribution": ATTRIBUTION,
        "license": LICENSE,
        "attribution_note": ("render this credit FROM this field, never as a "
                             "literal, so removing the feed removes the credit"),
        "policy": ("market prices are never read, derived or written; none of "
                   "the eight betting columns exist in either source"),
        "season_type": "REG",
        "coverage_note": (f"FTN charting begins in {FIRST_FTN_SEASON}. Seasons "
                          "before it are ABSENT from `seasons`, never zero — "
                          "'we do not know' and 'there was none' are different "
                          "claims."),
        "first_ftn_season": FIRST_FTN_SEASON,
        "seasons_covered": covered,
        "application": application,
        "sentinel_rule": SENTINEL_RULE,
        "units": ("counts of charted plays; sums not rates, so any week window "
                  "recomposes exactly as sum(numerator)/sum(denominator)"),
        "fields": {
            "off_plays": "charted offensive plays credited to this team",
            "pa": "is_play_action count", "screen": "is_screen_pass count",
            "motion": "is_motion count", "no_huddle": "is_no_huddle count",
            "def_plays": "charted plays this team defended",
            "box_sum": "sum of n_defense_box over those plays",
            "box_plays": "plays contributing to box_sum (== def_plays after the "
                         "sentinel filter; both emitted so a filter change is "
                         "visible in the data)",
        },
        "renames": dict(sorted(RENAMES.items())),
        "diagnostics": diagnostics,
        "seasons": {str(y): {t: {w: seasons_map[y][t][w]
                                 for w in sorted(seasons_map[y][t],
                                                 key=lambda x: int(x))}
                             for t in sorted(seasons_map[y])}
                    for y in covered},
    }


def build(seasons, cache_dir=None, progress=False, probe=True):
    """Fetch + join + fold every season. Raises on any gap."""
    seasons_map = {}
    diagnostics = {}
    for yr in seasons:
        pbp_index = index_pbp(iter_pbp(yr, cache_dir=cache_dir))
        ftn_rows = fetch_ftn(yr, cache_dir=cache_dir)
        teams, diag = accumulate_season(yr, ftn_rows, pbp_index)
        diag["pbp_plays_indexed"] = len(pbp_index)
        diag["teams"] = len(teams)
        seasons_map[yr] = teams
        diagnostics[str(yr)] = diag
        if progress:
            print(f"  {yr}: {diag['ftn_rows']} charted rows, "
                  f"{diag['unjoined']} unjoined, "
                  f"{diag['uncharted_dropped']} uncharted, "
                  f"{diag['postseason_dropped']} postseason, "
                  f"{diag['kept']} kept across {diag['teams']} teams",
                  flush=True)
    application = (probe_live_season() if probe else
                   {"live_season": LIVE_SEASON, "applied": False, "dark": True,
                    "http_status": None, "checked_utc": None,
                    "url": FTN_URL.format(season=LIVE_SEASON),
                    "reason": "live-season probe was skipped; the application "
                              "path stays DARK by default"})
    return document(seasons_map, diagnostics, application)


# --------------------------------------------------------------------------- #
# selftest                                                                     #
# --------------------------------------------------------------------------- #

def _fixture_rows():
    with open(PBP_FIXTURE, encoding="utf-8", newline="") as fh:
        pbp = list(csv.DictReader(fh))
    with open(FTN_FIXTURE, encoding="utf-8", newline="") as fh:
        ftn = list(csv.DictReader(fh))
    return pbp, ftn


def selftest():
    """Join, filter and arithmetic pinned on the committed fixtures. Asserts,
    never writes data/, never touches the network."""
    pbp, ftn = _fixture_rows()

    # --- the join gives the FTN row a team, which it does not carry itself ---
    assert "posteam" not in ftn[0] and "defteam" not in ftn[0], (
        "the FTN release has no team column — if it grows one, the join "
        "rationale in this module needs rewriting, not silently bypassing")
    idx = index_pbp(iter(pbp))
    # The fixture is 13 rows and one of them is deliberately unjoinable, which
    # is 7.7% — far above a ceiling written for 48,000-row seasons. The ceiling
    # is relaxed for the arithmetic assertions and then proven live below.
    teams, diag = accumulate_season(2099, ftn, idx, max_unjoined_share=0.10)

    # Fixture shape (data/fixtures/nflverse_sample/ftn_sample.csv):
    #   AAA @ BBB, week 1, REG   -> 6 charted + 2 sentinel + 1 no-team
    #   AAA @ CCC, week 2, REG   -> 2 charted
    #   playoff game, week 19    -> 1 charted, dropped as postseason
    #   one row whose play_id is absent from pbp -> unjoined
    assert diag["ftn_rows"] == 13, diag
    assert diag["unjoined"] == 1, diag
    assert diag["uncharted_dropped"] == 2, diag
    assert diag["postseason_dropped"] == 1, diag
    assert diag["no_team_dropped"] == 1, diag
    assert diag["kept"] == 8, diag
    # The sentinel filter FIRED. This assertion is the point of the fixture: a
    # build where it silently stopped firing looks identical without it.
    assert diag["uncharted_dropped"] > 0, "sentinel filter did not fire"

    # --- offence is credited to posteam, defence to defteam -----------------
    # Week 1: AAA has 4 charted offensive plays (3 PA, 1 screen, 2 motion,
    # 1 no-huddle); BBB has 2 (0 PA, 0 screen, 1 motion, 0 no-huddle).
    aaa1 = teams["AAA"]["1"]
    assert aaa1["off_plays"] == 4, aaa1
    assert aaa1["pa"] == 3 and aaa1["screen"] == 1, aaa1
    assert aaa1["motion"] == 2 and aaa1["no_huddle"] == 1, aaa1
    bbb1 = teams["BBB"]["1"]
    assert bbb1["off_plays"] == 2 and bbb1["pa"] == 0, bbb1
    # BBB defended AAA's 4 plays; boxes 6,7,8,7 -> sum 28 over 4 plays.
    assert bbb1["def_plays"] == 4 and bbb1["box_sum"] == 28, bbb1
    assert bbb1["box_plays"] == bbb1["def_plays"], bbb1
    # AAA defended BBB's 2 plays; boxes 5,5 -> 10.
    assert aaa1["def_plays"] == 2 and aaa1["box_sum"] == 10, aaa1

    # --- weeks stay separate, because the family windows on them ------------
    assert set(teams["AAA"]) == {"1", "2"}, teams["AAA"]
    assert teams["AAA"]["2"]["off_plays"] == 2, teams["AAA"]["2"]
    # The renamed code is the corpus code, not the source code: the fixture
    # charts "SD", which must land under LAC.
    assert "LAC" in teams and "SD" not in teams, sorted(teams)

    # --- sums recompose into the rate the family actually reads -------------
    # AAA weeks 1-2 combined: 6 off plays, 4 PA -> 2/3.
    pa = aaa1["pa"] + teams["AAA"]["2"]["pa"]
    plays = aaa1["off_plays"] + teams["AAA"]["2"]["off_plays"]
    assert (pa, plays) == (4, 6), (pa, plays)
    assert abs(pa / plays - 2.0 / 3.0) < 1e-12

    # --- a renamed column must RAISE, not read zero --------------------------
    # --- the PRODUCTION ceiling is live: 1-in-13 unjoined must raise ---------
    try:
        accumulate_season(2099, ftn, idx)
    except BuildError as exc:
        assert "did not join" in str(exc) and "ceiling" in str(exc), exc
    else:                                                  # pragma: no cover
        raise AssertionError("the default unjoined ceiling is not enforced")

    renamed = [dict(r) for r in ftn]
    for r in renamed:
        r["is_screen_p"] = r.pop("is_screen_pass")
    try:
        accumulate_season(2099, renamed, idx, max_unjoined_share=0.10)
    except BuildError as exc:
        assert "is_screen_pass" in str(exc), exc
    else:                                                  # pragma: no cover
        raise AssertionError("a renamed screen column must raise, not zero out")

    # --- a join that half-works must raise, not be recorded -----------------
    try:
        accumulate_season(2099, ftn, {})
    except BuildError as exc:
        assert "did not join" in str(exc), exc
    else:                                                  # pragma: no cover
        raise AssertionError("a 100% unjoined season must raise")

    # --- the sentinel predicate, stated directly ----------------------------
    assert is_uncharted({"n_defense_box": "0", "qb_location": "S"})
    assert is_uncharted({"n_defense_box": "6", "qb_location": "0"})
    assert is_uncharted({"n_defense_box": "6", "qb_location": ""})   # 2022 shape
    assert is_uncharted({"n_defense_box": "", "qb_location": "S"})
    assert not is_uncharted({"n_defense_box": "6", "qb_location": "S"})

    # --- pbp missing a required column raises -------------------------------
    try:
        index_pbp(iter([{"game_id": "g", "play_id": "1"}]))
    except BuildError as exc:
        assert "posteam" in str(exc), exc
    else:                                                  # pragma: no cover
        raise AssertionError("a pbp feed without posteam must raise")

    # --- the document says DARK without touching the network ----------------
    doc = document({2099: teams}, {"2099": diag},
                   {"live_season": LIVE_SEASON, "applied": False, "dark": True,
                    "http_status": 404, "checked_utc": None,
                    "url": FTN_URL.format(season=LIVE_SEASON),
                    "reason": "no 2026 release"})
    assert doc["attribution"] == ATTRIBUTION and doc["license"] == LICENSE
    assert doc["application"]["dark"] is True
    assert doc["application"]["applied"] is False
    assert doc["seasons_covered"] == [2099]
    assert doc["season_type"] == "REG"
    # Weeks are emitted in numeric order, not lexical: "10" must not sort
    # before "2" or a reader walking the artifact sees a scrambled season.
    many = {2099: {"AAA": {str(w): _blank_team() for w in (1, 2, 10, 11)}}}
    order = list(document(many, {}, doc["application"])["seasons"]["2099"]["AAA"])
    assert order == ["1", "2", "10", "11"], order

    print("selftest OK: FTN joins to pbp for team attribution, sentinel filter "
          "fires on uncharted rows, postseason and teamless rows dropped, "
          "offence/defence credited to the right side, sums recompose, a "
          "column rename raises, a broken join raises, application path DARK")
    return True


# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true",
                    help="run the fixture selftest; never writes data/")
    ap.add_argument("--seasons", default=None,
                    help=f"comma list (default {FIRST_FTN_SEASON}-{LAST_FTN_SEASON})")
    ap.add_argument("--cache-dir", default=None,
                    help="reuse downloaded release files from here")
    ap.add_argument("--no-probe", action="store_true",
                    help="skip the live-season probe (application stays DARK)")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()
        return 0

    seasons = ([int(s) for s in args.seasons.split(",") if s.strip()]
               if args.seasons else
               list(range(FIRST_FTN_SEASON, LAST_FTN_SEASON + 1)))
    print(f"building scheme history for {seasons[0]}-{seasons[-1]}", flush=True)
    doc = build(seasons, cache_dir=args.cache_dir, progress=True,
                probe=not args.no_probe)
    app = doc["application"]
    print(f"application path: dark={app['dark']} "
          f"(HTTP {app['http_status']} for {app['live_season']})")
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        # NOT sort_keys: `document` already emits seasons and teams sorted and
        # weeks in NUMERIC order, and sort_keys would re-sort the weeks
        # lexically ("10" before "2"), scrambling every season for a reader.
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    os.replace(tmp, args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
