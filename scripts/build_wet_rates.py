"""Play-level RATE substrate for the R94 weather measurement (MEASURE ONLY).

The owner's question, recorded in the R94 brief (2026-09-20), is whether rain
makes it "harder to throw" and "harder to catch" - the 8% folklore that
scripts/signals/weather.py already carries as a dead constant.

WHY THIS FILE EXISTS. That question cannot be answered on the corpus the repo
already has. data/fixtures/backtest_weekly/weekly_actuals.json keeps six
numbers per player-week - team, opp, PPR points and three yardage totals - and
throws the MECHANISM away. Completions, attempts, targets and receptions are
the mechanism: they are what "harder to throw" and "harder to catch" mean.
Without them the only available outcome is fantasy points on 34 wet games,
where the minimum detectable effect is about 17% of a 16.47-point mean against
an 8% claim - the corpus can only see an effect more than twice the size of the
one asserted, so a "significant" result there would be evidence of noise.

The decisive number in the whole release is 2,380: the dropbacks those same 68
wet team-games carry. A completion rate is a binomial on thousands of attempts,
not on 34 games, which is why the unit of analysis here is an ATTEMPT and not a
GAME. This module builds that substrate and nothing else. It fits no model, it
scores nothing, it adopts nothing, and no shipped number reads it.

WHAT IT KEEPS, per player-week and per team-week (the sixteen counters in
COUNTER_FIELDS): completions, attempts, passing_yards, passing_interceptions,
sacks, carries, targets, receptions, receiving_yards, receiving_air_yards and
all six fumble / fumble-lost columns. Numerators and denominators are stored
SEPARATELY and never pre-divided: a rate pooled over a cell is
sum(numerators) / sum(denominators), which is not the mean of per-game rates,
and only the stored counts can produce the first form.

SOURCE. The same nflverse release asset scripts/build_backtest_weekly_corpus.py
already pulls - stats_player_week_{season}.csv, the `player_stats` release tag
first and `stats_player` second - for REG weeks only. No market number is read
anywhere: this feed carries none, and no other feed is opened.

NO MIN_PPR FILTER. The weekly-actuals builder drops a player below 20 PPR
points for the season, which is correct for a fantasy backtest and wrong here:
every attempt belongs in the denominator, including the ones thrown by a
third-string quarterback in a downpour. A row is kept when ANY of the sixteen
counters is non-zero, so the team aggregate over kept rows is EXACTLY the
aggregate over every row (a dropped row contributes zero to all sixteen sums).

TWO RULES THAT STOP A HOLE LOOKING LIKE A ZERO:

  * REQUIRED_RATE_COLUMNS is resolved against every fetched header. An upstream
    rename raises instead of reading as zeros - a renamed `receptions` column
    silently read as 0 would price rain as catastrophic for catching.
  * PAST SEASONS ARE IMMUTABLE. A season already in the document is carried
    forward verbatim and never refetched, and a non-200 on any requested season
    aborts the whole build before a single byte is written. A half-fetched
    season can therefore never commit a partial corpus that the next run
    measures on as if it were complete.

PROVENANCE IS A FIELD, NOT A GUESS. The committed fixture under
data/fixtures/wet_rates/ is SYNTHETIC - built by --fixture-from-csv from the
committed sample CSV, because this sandbox's proxy 403s the nflverse release
asset (the repo's own builders record the same). It is stamped
provenance="synthetic_fixture", and available() refuses it, so a consumer that
asks "may I measure on this?" is told no instead of measuring on invented
numbers. The runner's real pull overwrites the same paths with
provenance="nflverse_release".

Stdlib only (plus `requests` when importable, exactly as the weekly corpus
builder uses it). --selftest is offline, writes nothing under data/, and checks
its arithmetic against hand-worked answers on the committed sample CSV.
"""

import argparse
import contextlib
import csv
import io
import json
import os
import sys
import tempfile
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_weekly as bw   # noqa: E402  (norm_team / TEAM_RENAMES)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OUT_DIR = os.path.join(_ROOT, "data", "fixtures", "wet_rates")
PLAYER_NAME = "player_week_rates.json"
TEAM_NAME = "team_week_rates.json"
SAMPLE_CSV = os.path.join(_ROOT, "data", "fixtures", "nflverse_sample",
                          "player_week_rates.csv")
SCHEMA_PATH = os.path.join(_ROOT, "data", "contracts", "wet_rates.schema.json")

RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
STATS_URLS = (RELEASE_BASE + "/player_stats/stats_player_week_{season}.csv",
              RELEASE_BASE + "/stats_player/stats_player_week_{season}.csv")
HTTP_TIMEOUT = 180

# 2021 is where data/weather_history.json starts, and 2025 is the last complete
# season; the weather corpus cannot join a team-game outside that window.
DEFAULT_SEASONS = (2021, 2022, 2023, 2024, 2025)

UNIT_PLAYER = "player_week"
UNIT_TEAM = "team_week"
PROVENANCE_RELEASE = "nflverse_release"
PROVENANCE_SYNTHETIC = "synthetic_fixture"

# A real REG season is ~5,000 kept player-weeks. Anything under this from a
# LIVE pull is a truncated asset, not a quiet year, and is refused rather than
# written: the whole point of the immutability rule is that a thin season never
# becomes the thing the next run measures on. The synthetic fixture is exempt
# because it is stamped synthetic and available() already refuses it.
MIN_SEASON_ROWS = 1000

# The committed fixture is hand-made, so "when it was generated" is the release
# it belongs to, not the clock. Pinning it keeps a regeneration byte-identical
# and the diff empty.
SYNTHETIC_STAMP = "2026-09-20T00:00:00Z"

# The sixteen mechanism counters, in the order they are written to a row.
COUNTER_FIELDS = (
    "completions", "attempts", "passing_yards", "passing_interceptions",
    "sacks", "carries", "targets", "receptions", "receiving_yards",
    "receiving_air_yards",
    "sack_fumbles", "sack_fumbles_lost",
    "rushing_fumbles", "rushing_fumbles_lost",
    "receiving_fumbles", "receiving_fumbles_lost",
)
# Yardage is a signed total (a sack-adjusted passing total and an air-yards
# total can both be negative); everything else is a whole-number count.
YARD_FIELDS = ("passing_yards", "receiving_yards", "receiving_air_yards")

# {logical field: the column names nflverse has used for it across releases}.
# The identity block joins the corpus; the counter block IS the mechanism.
RATE_COLUMNS = {
    "pid": ("player_id",),
    "name": ("player_display_name", "player_name"),
    "pos": ("position",),
    "team": ("team", "recent_team"),
    "opp": ("opponent_team",),
    "season": ("season",),
    "week": ("week",),
    "season_type": ("season_type",),
    "completions": ("completions",),
    "attempts": ("attempts",),
    "passing_yards": ("passing_yards",),
    "passing_interceptions": ("passing_interceptions", "interceptions"),
    "sacks": ("sacks", "sacks_suffered"),
    "carries": ("carries",),
    "targets": ("targets",),
    "receptions": ("receptions",),
    "receiving_yards": ("receiving_yards",),
    "receiving_air_yards": ("receiving_air_yards",),
    "sack_fumbles": ("sack_fumbles",),
    "sack_fumbles_lost": ("sack_fumbles_lost",),
    "rushing_fumbles": ("rushing_fumbles",),
    "rushing_fumbles_lost": ("rushing_fumbles_lost",),
    "receiving_fumbles": ("receiving_fumbles",),
    "receiving_fumbles_lost": ("receiving_fumbles_lost",),
}
# Every logical field above must resolve to a real column on every fetched
# header. There is no optional column: a mechanism column that went missing is
# a red, never a zero.
REQUIRED_RATE_COLUMNS = tuple(sorted(RATE_COLUMNS))

PLAYER_SOURCE = ("nflverse stats_player_week_{season}.csv (REG only), one row per "
                 "player-week with at least one non-zero mechanism counter")
TEAM_SOURCE = ("nflverse stats_player_week_{season}.csv (REG only), summed to one "
               "row per team-week over every player row")
SYNTHETIC_SOURCE = ("SYNTHETIC - data/fixtures/nflverse_sample/player_week_rates.csv, "
                    "hand-made; no nflverse data was fetched")
POLICY = ("R94 MEASURE ONLY. Play-level numerators and denominators for the weather "
          "measurement: the unit of analysis is an attempt or a target, never a game. "
          "Nothing that ships reads this document - no projection, no rating, no leg "
          "pool - and no market number appears in it. A row stamped "
          "provenance=synthetic_fixture is a placeholder: available() refuses it and "
          "no measurement may be taken on it.")

REMEDY = ("re-run where the nflverse release is reachable (the GitHub runner): "
          "python3 scripts/build_wet_rates.py --seasons %s")


class WetRatesError(RuntimeError):
    """Loud, never masked: a fetch, a header or a count the builder cannot trust."""


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_text(url, timeout=HTTP_TIMEOUT):
    """GET one asset as text. requests if importable, else urllib. Raises
    WetRatesError on any transport failure, a non-200, or an empty body."""
    try:
        import requests                                    # noqa: PLC0415
    except ImportError:
        requests = None
    try:
        if requests is not None:
            resp = requests.get(url, timeout=timeout)
            if resp.status_code != 200:
                raise WetRatesError("GET %s returned HTTP %s" % (url, resp.status_code))
            raw = resp.content
        else:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                if resp.status != 200:
                    raise WetRatesError("GET %s returned HTTP %s" % (url, resp.status))
                raw = resp.read()
    except WetRatesError:
        raise
    except Exception as exc:                               # noqa: BLE001
        raise WetRatesError("GET %s failed in transport: %s" % (url, exc)) from exc
    if not raw:
        raise WetRatesError("GET %s returned 0 bytes" % url)
    return raw.decode("utf-8", errors="replace")


def fetch_stats(season, urls=STATS_URLS):
    """The season's stats CSV text from the first release tag that serves it;
    every failure is reported when none does."""
    errors = []
    for tpl in urls:
        url = tpl.format(season=int(season))
        try:
            return fetch_text(url)
        except WetRatesError as exc:
            errors.append(str(exc))
            print("[warn] %s" % exc, file=sys.stderr)
    raise WetRatesError("stats_player_week_%d unavailable from every release tag: %s"
                        % (season, " | ".join(errors)))


# ---------------------------------------------------------------------------
# Parse (pure)
# ---------------------------------------------------------------------------

def _num(value):
    """float or None for blank / NA."""
    if value is None:
        return None
    v = str(value).strip()
    if v == "" or v.upper() in ("NA", "NAN", "NULL", "NONE"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _int(value):
    f = _num(value)
    return None if f is None else int(round(f))


def _count(value, field, where):
    """A whole-number counter. A blank cell means the player had none of it, so
    it reads 0; a FRACTIONAL value means the column is not the thing we think it
    is (half-sacks are a defensive credit and never appear on an offensive row),
    so it raises rather than rounding a wrong number into the corpus."""
    f = _num(value)
    if f is None:
        return 0
    if abs(f - round(f)) > 1e-9:
        raise WetRatesError("%s: %s is fractional (%r) - that column is not the "
                            "per-player count this substrate assumes" % (where, field, f))
    return int(round(f))


def _yards(value):
    """A signed yardage total; blank reads 0.0."""
    f = _num(value)
    return 0.0 if f is None else round(f, 2)


def resolve_columns(header, spec=RATE_COLUMNS):
    """{logical field: actual column} or WetRatesError naming every field with
    no column in the header. This is the contract check: a rename reds LOUD
    instead of reading as zeros."""
    out, missing = {}, []
    for field in sorted(spec):
        col = next((c for c in spec[field] if c in header), None)
        if col is None:
            missing.append("%s (%s)" % (field, "/".join(spec[field])))
        else:
            out[field] = col
    if missing:
        raise WetRatesError("stats_player_week header is missing %d required rate "
                            "column(s): %s" % (len(missing), ", ".join(missing)))
    return out


def _blank_row(team, opp, week):
    row = {"team": team, "opp": opp, "week": int(week)}
    for f in COUNTER_FIELDS:
        row[f] = 0.0 if f in YARD_FIELDS else 0
    return row


def _has_action(row):
    """True when ANY of the sixteen counters is non-zero. A row that fails this
    contributes exactly 0 to every team sum, which is what makes the team
    aggregate over kept rows identical to the aggregate over every row."""
    return any(row[f] for f in COUNTER_FIELDS)


def parse_rates(text, season, source_label="stats_player_week"):
    """(player_rows, team_rows, stats) for one season's CSV text.

    player_rows: {"{week}|{team}|{pid}": row} - REG rows of the requested
    season with at least one non-zero counter, carrying name/pos/team/opp/week
    plus the sixteen counters.
    team_rows:   {"{week}|{team}": row} - the same counters summed over EVERY
    parsed row for that team-week, plus `players` (how many kept player rows
    fed it). Team codes go through build_weekly.norm_team, so OAK is LV.
    """
    reader = csv.DictReader(io.StringIO(text))
    cols = resolve_columns(reader.fieldnames or [])
    stats = {"rows": 0, "kept_rows": 0, "not_reg": 0, "other_season": 0,
             "no_week": 0, "duplicate_player_week": 0, "no_action": 0,
             "players": 0, "team_weeks": 0}
    parsed = {}
    for raw in reader:
        stats["rows"] += 1
        if (raw.get(cols["season_type"]) or "").strip().upper() != "REG":
            stats["not_reg"] += 1
            continue
        if _int(raw.get(cols["season"])) != int(season):
            stats["other_season"] += 1
            continue
        week = _int(raw.get(cols["week"]))
        pid = (raw.get(cols["pid"]) or "").strip()
        if week is None or not pid:
            stats["no_week"] += 1
            continue
        team = bw.norm_team(raw.get(cols["team"]))
        opp_raw = (raw.get(cols["opp"]) or "").strip()
        opp = bw.norm_team(opp_raw) if opp_raw else None
        key = "%d|%s|%s" % (week, team, pid)
        if key in parsed:
            # Two rows for one player-week cannot both be real; taking the
            # first and counting the second is the weekly corpus builder's rule.
            stats["duplicate_player_week"] += 1
            continue
        where = "%s %s row %s" % (source_label, season, key)
        row = {"name": (raw.get(cols["name"]) or "").strip(),
               "pos": (raw.get(cols["pos"]) or "").strip().upper() or "UNK"}
        row.update(_blank_row(team, opp, week))
        for f in COUNTER_FIELDS:
            cell = raw.get(cols[f])
            row[f] = _yards(cell) if f in YARD_FIELDS else _count(cell, f, where)
        parsed[key] = row

    # The team aggregate runs over EVERY parsed row, not just the kept ones, so
    # it does not depend on the keep rule being harmless; the selftest then
    # proves the two agree.
    team_rows = aggregate_team(parsed.values())
    players = {}
    for key in sorted(parsed):
        row = parsed[key]
        if not _has_action(row):
            stats["no_action"] += 1
            continue
        players[key] = row
        stats["kept_rows"] += 1
    attach_players_witness(team_rows, players)
    stats["players"] = len(players)
    stats["team_weeks"] = len(team_rows)
    return players, team_rows, stats


def attach_players_witness(team_rows, player_rows):
    """Stamp each team-week with how many KEPT player rows fed it, and drop the
    team-weeks that no kept row fed at all.

    The stamp is a completeness witness: a team-week built from three rows did
    not have a roster, it had a truncated pull. The drop is the same rule one
    level up - a team-week whose every row was all-zero is an empty cell with
    no observation in it, and carrying it would put a row of sixteen zeros into
    a denominator as though a team had played and done nothing.
    """
    seen = {}
    for key in player_rows:
        wk, team, _pid = key.split("|", 2)
        seen["%s|%s" % (wk, team)] = seen.get("%s|%s" % (wk, team), 0) + 1
    for key in list(team_rows):
        n = seen.get(key, 0)
        if not n:
            del team_rows[key]
            continue
        team_rows[key]["players"] = n
    return team_rows


def aggregate_team(rows):
    """Player rows -> {"{week}|{team}": summed row}. The opponent is carried
    through; two different opponents for one team-week means the substrate is
    not what it claims to be, so it raises instead of picking one."""
    out = {}
    for row in rows:
        key = "%d|%s" % (row["week"], row["team"])
        agg = out.get(key)
        if agg is None:
            agg = out[key] = _blank_row(row["team"], row["opp"], row["week"])
        if row["opp"]:
            if agg["opp"] and agg["opp"] != row["opp"]:
                raise WetRatesError("team-week %s has two opponents (%s and %s) - a "
                                    "team plays one game a week" %
                                    (key, agg["opp"], row["opp"]))
            agg["opp"] = row["opp"]
        for f in COUNTER_FIELDS:
            agg[f] = round(agg[f] + row[f], 2) if f in YARD_FIELDS else agg[f] + row[f]
    return {k: out[k] for k in sorted(out)}


# ---------------------------------------------------------------------------
# Rates (the only division in the module, done at read time and never stored)
# ---------------------------------------------------------------------------

def pool_counters(rows):
    """Sum the sixteen counters over any iterable of rows. Pooling then dividing
    is a binomial on the pooled denominator; dividing then averaging is a mean of
    per-game rates and a different, noisier estimand. Only the first is used."""
    agg = {f: (0.0 if f in YARD_FIELDS else 0) for f in COUNTER_FIELDS}
    for row in rows:
        for f in COUNTER_FIELDS:
            agg[f] = round(agg[f] + row[f], 2) if f in YARD_FIELDS else agg[f] + row[f]
    return agg


def _ratio(num, den):
    return None if not den else num / float(den)


def completion_rate(row):
    """completions / attempts, or None when nobody dropped back to throw."""
    return _ratio(row["completions"], row["attempts"])


def catch_rate(row):
    """receptions / targets - the owner's "harder to catch", as a binomial."""
    return _ratio(row["receptions"], row["targets"])


def sack_rate(row):
    """sacks / dropbacks, where a dropback is an attempt or a sack. Scrambles
    are not separable from carries in this feed, so they sit in the rushing
    columns and outside this denominator; the LIMITS section says so."""
    return _ratio(row["sacks"], row["attempts"] + row["sacks"])


def yards_per_attempt(row):
    return _ratio(row["passing_yards"], row["attempts"])


def adot(row):
    """Average depth of target: air yards per target. Falls where a passer
    checks down in bad weather, which is a coaching response and not a
    difficulty of throwing - reported separately for exactly that reason."""
    return _ratio(row["receiving_air_yards"], row["targets"])


def yards_per_target(row):
    return _ratio(row["receiving_yards"], row["targets"])


def interception_rate(row):
    return _ratio(row["passing_interceptions"], row["attempts"])


def fumble_rate(row):
    """Fumbles per play with the ball in hand: sacks taken, carries and
    receptions. A wet ball is dropped as well as missed, and this is the only
    place the six fumble columns become a rate."""
    fumbles = (row["sack_fumbles"] + row["rushing_fumbles"] + row["receiving_fumbles"])
    return _ratio(fumbles, row["sacks"] + row["carries"] + row["receptions"])


RATE_FUNCTIONS = {
    "completion_rate": completion_rate,
    "catch_rate": catch_rate,
    "sack_rate": sack_rate,
    "yards_per_attempt": yards_per_attempt,
    "yards_per_target": yards_per_target,
    "adot": adot,
    "interception_rate": interception_rate,
    "fumble_rate": fumble_rate,
}


def rates(row):
    """{rate name: value or None}. None is an ABSENT denominator, never 0.0 -
    a team that never threw has no completion rate, and averaging a 0.0 in its
    place would be a fabricated observation."""
    return {name: fn(row) for name, fn in sorted(RATE_FUNCTIONS.items())}


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------

def _ordered_row(row):
    """A row in the committed field order: identity, then the sixteen counters,
    then the team-only witness."""
    out = {}
    for f in ("name", "pos"):
        if f in row:
            out[f] = row[f]
    out["team"] = row["team"]
    out["opp"] = row["opp"]
    out["week"] = row["week"]
    for f in COUNTER_FIELDS:
        out[f] = row[f]
    if "players" in row:
        out["players"] = row["players"]
    return out


def document(unit, per_season, seasons_requested, unavailable, provenance, stamp):
    """The wet_rates document for one unit. A season with zero rows is NOT
    written as an empty object: it is a hole, it belongs in seasons_unavailable,
    and the contract's per-season minProperties reds it if it ever appears."""
    if unit not in (UNIT_PLAYER, UNIT_TEAM):
        raise WetRatesError("unknown unit %r" % (unit,))
    rows = {}
    for season in sorted(per_season):
        season_rows = per_season[season]
        if not season_rows:
            raise WetRatesError("season %s produced 0 %s rows - a hole is named in "
                                "seasons_unavailable, never written as an empty "
                                "season" % (season, unit))
        rows[str(season)] = {k: _ordered_row(season_rows[k])
                             for k in sorted(season_rows)}
    if provenance == PROVENANCE_SYNTHETIC:
        source = SYNTHETIC_SOURCE
    else:
        tpl = PLAYER_SOURCE if unit == UNIT_PLAYER else TEAM_SOURCE
        source = tpl.format(season="{season}")
    return {
        "kind": "wet_rates",
        "unit": unit,
        "provenance": provenance,
        "source": source,
        "policy": POLICY,
        "generated_utc": stamp,
        "seasons_requested": [int(s) for s in sorted(seasons_requested)],
        "seasons_fetched": [int(s) for s in sorted(per_season)],
        "seasons_unavailable": {str(k): unavailable[k] for k in sorted(unavailable)},
        "required_columns": list(REQUIRED_RATE_COLUMNS),
        "rows": rows,
    }


def write_json(path, doc):
    """Exactly the committed fixture encoding: compact separators,
    ASCII-escaped, no trailing newline (see data/fixtures/backtest_weekly/)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"))


def load(path):
    """One wet_rates document, or None when it is not there yet."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_player_rates(out_dir=OUT_DIR):
    return load(os.path.join(out_dir, PLAYER_NAME))


def load_team_rates(out_dir=OUT_DIR):
    return load(os.path.join(out_dir, TEAM_NAME))


def available(doc):
    """(True, "") when this document may be measured on; (False, reason)
    otherwise. A consumer asks before measuring, so an absent or synthetic
    corpus becomes an honest available:false instead of a silent empty arm."""
    if doc is None:
        return False, ("data/fixtures/wet_rates is absent - " +
                       REMEDY % _season_text(DEFAULT_SEASONS))
    if doc.get("kind") != "wet_rates":
        return False, "not a wet_rates document (kind=%r)" % (doc.get("kind"),)
    if doc.get("provenance") != PROVENANCE_RELEASE:
        return False, ("provenance is %r, not %r - the committed fixture is a "
                       "hand-made placeholder and no measurement may be taken on it"
                       % (doc.get("provenance"), PROVENANCE_RELEASE))
    if not doc.get("rows"):
        return False, "the corpus holds no seasons"
    return True, ""


def season_rows(doc, season):
    """{key: row} for one season, or {} when that season is not in the corpus."""
    return (doc or {}).get("rows", {}).get(str(season), {})


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def _season_text(seasons):
    seasons = sorted(int(s) for s in seasons)
    if not seasons:
        return ""
    if seasons == list(range(seasons[0], seasons[-1] + 1)):
        return "%d-%d" % (seasons[0], seasons[-1])
    return ",".join(str(s) for s in seasons)


def build(seasons, out_dir=OUT_DIR, fetch=None, refetch=(), stamp=None, verbose=True):
    """Fetch what is missing, carry forward what is already there, and return
    (player_doc, team_doc, stats). Raises WetRatesError - before any write -
    when a requested season cannot be fetched or comes back too thin.

    IMMUTABILITY: a season already present in the committed player document is
    reused verbatim and never refetched, unless it is named in `refetch`. That
    is what makes the corpus reproducible: last year's numbers cannot change
    under a measurement that was taken on them.
    """
    seasons = [int(s) for s in seasons]
    refetch = {int(s) for s in refetch}
    existing = load(os.path.join(out_dir, PLAYER_NAME))
    carried = {}
    if existing is not None and existing.get("provenance") == PROVENANCE_RELEASE:
        for season in seasons:
            rows = season_rows(existing, season)
            if rows and season not in refetch:
                carried[season] = {k: dict(v) for k, v in rows.items()}

    fetch = fetch or fetch_stats
    per_player, stats = dict(carried), {}
    for season in seasons:
        if season in per_player:
            if verbose:
                print("season %d: carried forward, %d rows (immutable, not refetched)"
                      % (season, len(per_player[season])))
            continue
        players, _teams, st = parse_rates(fetch(season), season)
        if len(players) < MIN_SEASON_ROWS:
            raise WetRatesError("season %d returned only %d kept player-weeks (floor "
                                "%d) - refusing to write a truncated season"
                                % (season, len(players), MIN_SEASON_ROWS))
        per_player[season] = players
        stats[season] = st
        if verbose:
            print("season %d: %s" % (season, st))

    per_team = {s: attach_players_witness(aggregate_team(per_player[s].values()),
                                          per_player[s])
                for s in per_player}
    stamp = stamp or _utc_now()
    player_doc = document(UNIT_PLAYER, per_player, seasons, {}, PROVENANCE_RELEASE, stamp)
    team_doc = document(UNIT_TEAM, per_team, seasons, {}, PROVENANCE_RELEASE, stamp)
    return player_doc, team_doc, stats


def _utc_now():
    import datetime                                        # noqa: PLC0415
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# The corpus proper: what a measurement is taken on. generated_utc is a clock
# and seasons_requested is what was ASKED for on one invocation - neither is a
# number anybody measures, and rewriting the file because they moved would churn
# the diff and restamp a corpus nothing changed.
CORPUS_FIELDS = ("kind", "unit", "provenance", "required_columns",
                 "seasons_fetched", "seasons_unavailable", "rows")


def _same_corpus(old, new):
    """True when the two documents hold the same corpus."""
    if old is None:
        return False
    return all(old.get(f) == new.get(f) for f in CORPUS_FIELDS)


def write_documents(player_doc, team_doc, out_dir=OUT_DIR, verbose=True):
    """Write both documents, skipping either one whose corpus is unchanged.
    Returns the list of paths actually written."""
    written = []
    for name, doc in ((PLAYER_NAME, player_doc), (TEAM_NAME, team_doc)):
        path = os.path.join(out_dir, name)
        if _same_corpus(load(path), doc):
            if verbose:
                print("%s: unchanged, not rewritten" % name)
            continue
        write_json(path, doc)
        written.append(path)
        if verbose:
            print("wrote %s (%d seasons, %d rows)"
                  % (os.path.relpath(path, _ROOT), len(doc["rows"]),
                     sum(len(v) for v in doc["rows"].values())))
    return written


def build_fixture_from_csv(csv_path=SAMPLE_CSV, out_dir=OUT_DIR, verbose=True):
    """The committed SYNTHETIC fixture, from the committed sample CSV. Every
    season in the file is parsed, the documents are stamped
    provenance=synthetic_fixture, and available() therefore refuses them."""
    with open(csv_path, encoding="utf-8") as fh:
        text = fh.read()
    cols = resolve_columns(csv.DictReader(io.StringIO(text)).fieldnames or [])
    seasons = sorted({_int(r.get(cols["season"])) for r in
                      csv.DictReader(io.StringIO(text))
                      if _int(r.get(cols["season"])) is not None})
    per_player, per_team, unavailable = {}, {}, {}
    for season in seasons:
        players, teams, _st = parse_rates(text, season, source_label=csv_path)
        if not players:
            # Named, never silently dropped: an absent season and an empty one
            # read the same to a consumer, and only one of them is honest.
            unavailable[season] = "no rows for this season in the sample CSV"
            continue
        per_player[season], per_team[season] = players, teams
    player_doc = document(UNIT_PLAYER, per_player, seasons, unavailable,
                          PROVENANCE_SYNTHETIC, SYNTHETIC_STAMP)
    team_doc = document(UNIT_TEAM, per_team, seasons, unavailable,
                        PROVENANCE_SYNTHETIC, SYNTHETIC_STAMP)
    return write_documents(player_doc, team_doc, out_dir, verbose), player_doc, team_doc


# ---------------------------------------------------------------------------
# selftest - offline, hand-worked, writes nothing under data/
# ---------------------------------------------------------------------------

def _sample_text():
    with open(SAMPLE_CSV, encoding="utf-8") as fh:
        return fh.read()


def selftest():
    text = _sample_text()

    # --- parse: the filters, counted rather than silent ---------------------
    players, teams, st = parse_rates(text, 2099)
    assert st["rows"] == 13, st
    assert st["not_reg"] == 1 and st["other_season"] == 1, st
    assert st["duplicate_player_week"] == 1, st
    assert st["no_action"] == 1, "the all-zero kicker row is not a unit of analysis"
    assert st["kept_rows"] == len(players) == 9, (st, sorted(players))

    # --- hand-worked player rates -------------------------------------------
    qb = players["1|AAA|00-0000001"]
    assert (qb["completions"], qb["attempts"]) == (20, 32), qb
    assert completion_rate(qb) == 0.625, "20/32 = 0.625"
    assert abs(sack_rate(qb) - 3.0 / 35.0) < 1e-12, "3 sacks / (32 attempts + 3)"
    assert abs(yards_per_attempt(qb) - 210.0 / 32.0) < 1e-12
    assert completion_rate(_blank_row("AAA", "BBB", 1)) is None, \
        "no attempts is an ABSENT rate, never 0.0"
    wr = players["1|AAA|00-0000002"]
    assert (wr["receptions"], wr["targets"]) == (6, 10), wr
    assert catch_rate(wr) == 0.6, "6/10 = 0.6"
    assert adot(wr) == 9.5, "95 air yards / 10 targets"
    assert wr["attempts"] == 1 and wr["completions"] == 1, \
        "a trick-play throw by a receiver is still an attempt"
    te = players["1|AAA|00-0000003"]
    assert catch_rate(te) == 0.8, "4/5"
    blank = players["2|BBB|00-0000007"]
    assert (blank["targets"], blank["receptions"]) == (4, 3), blank
    assert blank["attempts"] == 0 and blank["passing_yards"] == 0.0, \
        "a blank cell is none of it, which is 0 - the only place a blank reads as zero"
    raider = players["2|LV|00-0000008"]
    assert raider["team"] == "LV", "OAK normalises through build_weekly.norm_team"

    # --- hand-worked team rates ---------------------------------------------
    aaa1 = teams["1|AAA"]
    assert (aaa1["completions"], aaa1["attempts"]) == (21, 33), aaa1
    assert abs(completion_rate(aaa1) - 21.0 / 33.0) < 1e-12, "the WR's throw is in it"
    assert (aaa1["receptions"], aaa1["targets"]) == (12, 18), aaa1
    assert abs(catch_rate(aaa1) - 2.0 / 3.0) < 1e-12, "12/18"
    assert aaa1["players"] == 4, "four kept rows fed it; the kicker is not one"
    assert aaa1["opp"] == "BBB" and aaa1["week"] == 1
    bbb1 = teams["1|BBB"]
    assert completion_rate(bbb1) == 25.0 / 30.0 and catch_rate(bbb1) == 0.75
    assert aaa1["sack_fumbles"] == 1 and aaa1["rushing_fumbles"] == 1 \
        and aaa1["receiving_fumbles"] == 1, "all six fumble columns survive"
    assert abs(fumble_rate(aaa1) - 3.0 / (3 + 21 + 12)) < 1e-12

    # --- pooling is a binomial on the pooled denominator, not a mean of rates
    pooled = pool_counters([teams["1|AAA"], teams["2|AAA"]])
    assert (pooled["completions"], pooled["attempts"]) == (36, 58), pooled
    assert abs(completion_rate(pooled) - 36.0 / 58.0) < 1e-12, "36/58, not (0.636+0.6)/2"
    mean_of_rates = (completion_rate(teams["1|AAA"]) + completion_rate(teams["2|AAA"])) / 2
    assert abs(completion_rate(pooled) - mean_of_rates) > 1e-4, \
        "the two estimands really do differ - the stored counts are what make the " \
        "binomial reachable"

    assert all(t["players"] >= 1 for t in teams.values()), \
        "every team-week carries at least one kept row"
    # A team-week that no kept row fed is an empty cell, not a team-game: a row
    # of sixteen zeros in a denominator would be a team that played and did
    # nothing, which never happened.
    ghost = aggregate_team([dict(_blank_row("ZZZ", "YYY", 3), name="Ghost", pos="K")])
    assert "3|ZZZ" in ghost, "it aggregates before it judges"
    assert attach_players_witness(ghost, {}) == {}, \
        "a team-week with no kept row carries no observation and is dropped"

    # --- dropping zero rows cannot move a team total ------------------------
    every_row = dict(players)
    every_row["1|AAA|00-0000009"] = dict(_blank_row("AAA", "BBB", 1),
                                         name="Toe Punter", pos="K")
    assert aggregate_team(every_row.values())["1|AAA"] == \
        {k: v for k, v in teams["1|AAA"].items() if k != "players"}, \
        "aggregate over kept rows == aggregate over every row"

    # --- the column contract reds LOUD --------------------------------------
    for original, renamed in (("receiving_yards", "rec_yds"),
                              ("receptions", "catches"),
                              ("attempts", "pass_att")):
        try:
            parse_rates(text.replace(original, renamed, 1), 2099)
        except WetRatesError as exc:
            assert original in str(exc), (original, str(exc))
        else:
            raise AssertionError("a renamed %s must raise, never read as zeros"
                                 % original)
    # ...and the documented alternates still resolve.
    alt = (text.replace("player_display_name", "player_name", 1)
               .replace(",team,", ",recent_team,", 1)
               .replace("passing_interceptions", "interceptions", 1)
               .replace(",sacks,", ",sacks_suffered,", 1))
    alt_players, _t, _s = parse_rates(alt, 2099)
    assert alt_players["1|AAA|00-0000001"]["name"] == "Rain Arm"
    assert alt_players["1|AAA|00-0000001"]["sacks"] == 3
    assert alt_players["1|AAA|00-0000001"]["passing_interceptions"] == 2

    # --- a fractional counter is a wrong column, not a rounding job ----------
    try:
        parse_rates(text.replace(",20,32,210,2,3,", ",20,32,210,2,2.5,", 1), 2099)
    except WetRatesError as exc:
        assert "fractional" in str(exc), str(exc)
    else:
        raise AssertionError("a half-sack on an offensive row must raise")

    # --- two opponents for one team-week is not a substrate -----------------
    try:
        aggregate_team([dict(_blank_row("AAA", "BBB", 1), attempts=1),
                        dict(_blank_row("AAA", "CCC", 1), attempts=1)])
    except WetRatesError as exc:
        assert "two opponents" in str(exc), str(exc)
    else:
        raise AssertionError("a team plays one game a week")

    # --- documents, immutability and the 403 --------------------------------
    with tempfile.TemporaryDirectory() as tmp:
        calls = []

        def fake_fetch(season):
            calls.append(season)
            if season == 2099:
                raise WetRatesError("GET stats_player_week_2099.csv returned HTTP 403")
            return text.replace(",2098,", ",%d," % season) if season != 2098 else text

        # A thin season is refused before anything is written.
        try:
            build([2098], out_dir=tmp, fetch=fake_fetch, verbose=False)
        except WetRatesError as exc:
            assert "floor" in str(exc) and "truncated" in str(exc), str(exc)
        else:
            raise AssertionError("a 1-row season must not be written as a season")
        assert os.listdir(tmp) == [], "nothing is written on a refusal"

        # Seasons 1-2 on disk, written through the real document path.
        seeded = {2096: dict(players), 2097: dict(players)}
        pdoc = document(UNIT_PLAYER, seeded, [2096, 2097, 2099], {},
                        PROVENANCE_RELEASE, "2026-01-01T00:00:00Z")
        tdoc = document(UNIT_TEAM,
                        {s: attach_players_witness(
                            aggregate_team(seeded[s].values()), seeded[s])
                         for s in seeded},
                        [2096, 2097, 2099], {}, PROVENANCE_RELEASE,
                        "2026-01-01T00:00:00Z")
        write_documents(pdoc, tdoc, tmp, verbose=False)
        before = {n: (os.stat(os.path.join(tmp, n)).st_mtime_ns,
                      open(os.path.join(tmp, n), "rb").read())
                  for n in (PLAYER_NAME, TEAM_NAME)}

        # A 403 on the third season leaves the first two untouched, returns
        # non-zero, and names the remedy command.
        calls.clear()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = main(["--seasons", "2096,2097,2099", "--out-dir", tmp, "--quiet"],
                      fetch=fake_fetch)
        assert rc != 0, "a 403 must not exit 0"
        said = err.getvalue()
        assert "403" in said and "nothing was written" in said, said
        assert "REMEDY: " in said and "build_wet_rates.py --seasons 2096,2097,2099" \
            in said, "the failure must name the command that fixes it: %s" % said
        assert calls == [2099], "the two committed seasons were never refetched: %r" % calls
        after = {n: (os.stat(os.path.join(tmp, n)).st_mtime_ns,
                     open(os.path.join(tmp, n), "rb").read())
                 for n in (PLAYER_NAME, TEAM_NAME)}
        assert after == before, "seasons 1-2 must be byte- and mtime-untouched"

        # The same two seasons, no failure: nothing new to fetch, nothing rewritten.
        calls.clear()
        rc = main(["--seasons", "2096,2097", "--out-dir", tmp, "--quiet"],
                  fetch=fake_fetch)
        assert rc == 0 and calls == [], calls
        assert {n: (os.stat(os.path.join(tmp, n)).st_mtime_ns,
                    open(os.path.join(tmp, n), "rb").read())
                for n in (PLAYER_NAME, TEAM_NAME)} == before, \
            "an unchanged corpus is not rewritten"

        # Encoding matches the committed fixtures: compact, ASCII, no newline.
        raw = before[PLAYER_NAME][1]
        assert raw.startswith(b'{"kind":"wet_rates"') and not raw.endswith(b"\n")
        assert b"\xe2" not in raw, "ASCII-escaped like every committed fixture"
        assert json.loads(raw)["unit"] == UNIT_PLAYER

        # available() gates the consumer: absent, synthetic and real all differ.
        assert available(None)[0] is False
        assert available(json.loads(raw))[0] is True
        synth = document(UNIT_PLAYER, seeded, [2096, 2097], {},
                         PROVENANCE_SYNTHETIC, SYNTHETIC_STAMP)
        ok, why = available(synth)
        assert ok is False and "placeholder" in why, why
        # An empty season can never be written as an empty season.
        try:
            document(UNIT_PLAYER, {2096: {}}, [2096], {}, PROVENANCE_RELEASE, "x")
        except WetRatesError as exc:
            assert "seasons_unavailable" in str(exc), str(exc)
        else:
            raise AssertionError("an empty season is a hole, not a season")

    # --- the committed fixtures are exactly what this code produces ---------
    committed_player = load_player_rates()
    committed_team = load_team_rates()
    with tempfile.TemporaryDirectory() as tmp:
        _paths, fresh_player, fresh_team = build_fixture_from_csv(out_dir=tmp,
                                                                  verbose=False)
    assert committed_player == fresh_player, \
        "data/fixtures/wet_rates/%s is stale - regenerate with --fixture-from-csv" % PLAYER_NAME
    assert committed_team == fresh_team, \
        "data/fixtures/wet_rates/%s is stale - regenerate with --fixture-from-csv" % TEAM_NAME
    assert available(committed_player)[0] is False, \
        "the committed fixture is synthetic and must never be measured on"

    # --- and they satisfy the contract --------------------------------------
    from scripts.validate_data import validate_against_schema   # noqa: PLC0415
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        schema = json.load(fh)
    validate_against_schema(committed_player, schema, PLAYER_NAME)
    validate_against_schema(committed_team, schema, TEAM_NAME)
    bad = json.loads(json.dumps(committed_player))
    bad["rows"][sorted(bad["rows"])[0]] = {}
    try:
        validate_against_schema(bad, schema, "empty-season")
    except Exception as exc:                               # noqa: BLE001
        assert "minProperties" in str(exc), str(exc)
    else:
        raise AssertionError("an empty season must fail the contract")

    print("selftest OK: mechanism counters survive the pull (20/32 completions is a "
          "0.625 completion rate, 6/10 targets a 0.6 catch rate, 21/33 and 12/18 the "
          "team-week totals including a receiver's trick-play throw); an absent "
          "denominator reads None and never 0.0; pooled counts give 36/58 rather than "
          "the mean of two game rates; dropping all-zero rows cannot move a team total; "
          "a renamed receiving_yards/receptions/attempts column and a fractional sack "
          "both raise instead of reading as zeros; a 403 on one season leaves the "
          "committed seasons byte- and mtime-identical, refetches nothing and exits "
          "non-zero naming the remedy; and both committed fixtures are synthetic, "
          "refused by available(), and valid against wet_rates.schema.json")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_seasons(text):
    if "-" in text:
        a, b = text.split("-", 1)
        return tuple(range(int(a), int(b) + 1))
    return tuple(int(s) for s in text.split(","))


def main(argv=None, fetch=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--seasons", default=_season_text(DEFAULT_SEASONS),
                    help="seasons to hold, e.g. 2021-2025 or 2023,2024")
    ap.add_argument("--refetch", default="",
                    help="seasons to refetch even though they are already held "
                         "(the immutability rule's only escape hatch)")
    ap.add_argument("--out-dir", default=OUT_DIR)
    ap.add_argument("--fixture-from-csv", action="store_true",
                    help="rebuild the committed SYNTHETIC fixture from "
                         "data/fixtures/nflverse_sample/player_week_rates.csv; "
                         "fetches nothing and stamps provenance=synthetic_fixture")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    verbose = not args.quiet
    if args.fixture_from_csv:
        build_fixture_from_csv(out_dir=args.out_dir, verbose=verbose)
        return 0
    seasons = _parse_seasons(args.seasons)
    try:
        player_doc, team_doc, _stats = build(
            seasons, out_dir=args.out_dir, fetch=fetch,
            refetch=_parse_seasons(args.refetch) if args.refetch else (),
            verbose=verbose)
    except WetRatesError as exc:
        print("WET RATES ERROR: %s" % exc, file=sys.stderr)
        print("nothing was written; every season already held is untouched.",
              file=sys.stderr)
        print("REMEDY: %s" % (REMEDY % _season_text(seasons)), file=sys.stderr)
        return 1
    write_documents(player_doc, team_doc, args.out_dir, verbose=verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
