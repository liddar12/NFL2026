"""BUILD data/fixtures/backtest_corpus/ — the EXPANDED backtest corpus.

WHY: every adoption decision (scripts/promote_signals.py's never-regress gate,
scripts/backtest.py's parameter grid) currently walks data/fixtures/finals_{yr}
.json, which is ESPN-derived and covers 2021-2025 only: 1,359 regular-season
games. The nflverse `nfldata` games.csv carries the same fact table back to
1999 — 7,276 COMPLETED games across 27 seasons once the unplayed rows are
dropped. Deciding on ~19% of the freely available evidence is the problem this
builder removes.

SHAPE: byte-for-byte the same record shape as finals_{yr}.json, so a consumer
only changes the DIRECTORY it reads, never its reader:

  {"season": 2005, "fetched_utc": ..., "games": [
     {"game_id", "home", "away", "kickoff_utc", "status", "final",
      "venue", "venue_city", "venue_country", "home_score", "away_score",
      "week", ...}]}

Three fields are ADDED (additive only — key-name readers are unaffected):
  game_type     REG | WC | DIV | CON | SB   (the ESPN fixtures are REG-only)
  gameday       local game date, always present even when the clock time isn't
  neutral_site  from games.csv `location` (Super Bowls, internationals)

HONESTY RULES:
  * COMPLETED GAMES ONLY. A row is kept only when BOTH scores parse as ints.
    Scheduled/unplayed rows (the entire 2026 season, today) are dropped and the
    season is reported as skipped with its reason. No score is ever invented.
  * MARKET COLUMNS ARE NEVER READ. games.csv ships spread_line, total_line,
    moneylines and odds; this builder never copies them into the corpus, so
    the corpus cannot become a back door around MARKET_DISPLAY_ONLY.
  * venue_city / venue_country are NOT carried by games.csv. They are emitted
    as null rather than guessed from the stadium name.
  * 1999 has NO kickoff clock time upstream (all 259 rows have an empty
    `gametime`). Those records carry kickoff_utc = null and the season is
    flagged `kickoff_times_known: false` in the file and in the manifest —
    a midnight placeholder would be a fabricated kickoff instant.
  * Team codes are reconciled against data/fixtures/teams.json. An unknown
    code after renaming is a HARD FAILURE, never a silently dropped game.
  * Any transport/parse failure leaves the committed corpus untouched.

LEGACY CLOCK QUIRK (verified against the whole file, asserted in code):
  `gametime` is Eastern. Seasons 2000-2005 store their 9pm night window as
  "09:00" (12-hour), 102 rows, every one of them Monday/Thursday/Saturday.
  "09:30" appears only on Sundays (the London window) and only from 2014.
  So hh==9 & mm==0 is 21:00 ET; anything else is read as 24-hour. If a
  "09:00" row ever shows up after 2005 or on a Sunday the builder FAILS
  rather than guess.

CROSS-CHECK (run at build time and in --selftest): for the 1,359 games the
corpus shares with the committed ESPN fixtures, every score and week must
agree exactly and every kickoff must land within 120 minutes of ESPN's
(scheduled-vs-actual kickoff differs by up to ~85 min on 6 games).

USAGE:
  python3 scripts/build_backtest_corpus.py                 # fetch + write
  python3 scripts/build_backtest_corpus.py --csv PATH      # build from a local CSV
  python3 scripts/build_backtest_corpus.py --selftest      # asserts only, writes nothing

Stdlib only (urllib + csv + zoneinfo). No pandas, no requests.
"""

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import sys
import urllib.request
from zoneinfo import ZoneInfo

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))

DATA = os.path.join(_ROOT, "data")
FIXTURES = os.path.join(DATA, "fixtures")
OUT_DIR = os.path.join(FIXTURES, "backtest_corpus")
MANIFEST = os.path.join(OUT_DIR, "manifest.json")
SAMPLE_CSV = os.path.join(FIXTURES, "nflverse_sample", "games_nfldata_sample.csv")
TEAMS_PATH = os.path.join(FIXTURES, "teams.json")

SOURCE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
SOURCE_NAME = "nflverse/nfldata games.csv"
HTTP_TIMEOUT = 90

# nflverse relocation codes -> our canonical set (data/fixtures/teams.json).
RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}

ET = ZoneInfo("America/New_York")

# A full pull is 7k+ completed games; anything less is a truncated fetch.
MIN_GAMES = 7000
# Seasons whose ESPN fixtures we can cross-check the corpus against.
OVERLAP_SEASONS = (2021, 2022, 2023, 2024, 2025)
# ESPN publishes actual kickoff, nfldata the scheduled one; 6 of 1,359 differ.
KICKOFF_TOLERANCE_MIN = 120
# Earliest legitimate ET kickoff (the London window is 09:30 ET).
EARLIEST_ET_HOUR = 9


class CorpusError(RuntimeError):
    """Raised loudly. Never swallowed into a partial or fabricated corpus."""


def canonical_teams():
    with open(TEAMS_PATH, encoding="utf-8") as fh:
        return {t["abbrev"] for t in json.load(fh)["teams"]}


def normalize_team(code):
    code = (code or "").strip()
    return RENAMES.get(code, code)


def parse_kickoff_utc(gameday, gametime, weekday, season):
    """'YYYY-MM-DD' + ET 'HH:MM' -> 'YYYY-MM-DDTHH:MMZ', or None when unknown.

    Raises CorpusError on anything it cannot read honestly (see LEGACY CLOCK
    QUIRK in the module docstring)."""
    gameday = (gameday or "").strip()
    gametime = (gametime or "").strip()
    if not gameday:
        raise CorpusError("row has no gameday — refusing to guess a date")
    try:
        day = dt.date.fromisoformat(gameday)
    except ValueError as exc:
        raise CorpusError("unparseable gameday %r: %s" % (gameday, exc)) from exc
    if not gametime:
        return None
    try:
        hh_s, mm_s = gametime.split(":")[:2]
        hh, mm = int(hh_s), int(mm_s)
    except (ValueError, IndexError) as exc:
        raise CorpusError("unparseable gametime %r: %s" % (gametime, exc)) from exc
    if hh == 9 and mm == 0:
        # Legacy 12-hour night slot. Only ever 2000-2005 and never Sunday.
        if int(season) > 2005 or (weekday or "").strip() == "Sunday":
            raise CorpusError(
                "gametime '09:00' in season %s on %s — the 12-hour night-slot "
                "assumption (2000-2005, never Sunday) no longer holds; refusing "
                "to guess AM vs PM" % (season, weekday))
        hh = 21
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise CorpusError("gametime %r out of range" % gametime)
    if hh < EARLIEST_ET_HOUR:
        raise CorpusError(
            "gametime %r (season %s) is before %02d:00 ET — no NFL game kicks "
            "that early; the clock column changed format"
            % (gametime, season, EARLIEST_ET_HOUR))
    local = dt.datetime(day.year, day.month, day.day, hh, mm, tzinfo=ET)
    return local.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _int(value):
    value = (value or "").strip()
    if value == "":
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def build_records(rows, canon=None):
    """(seasons, stats) from games.csv dict rows. Pure; never touches disk
    beyond the canonical team list."""
    if canon is None:
        canon = canonical_teams()
    seasons = {}
    stats = {
        "source_rows": 0, "completed": 0, "incomplete": 0,
        "seen_codes": set(), "renamed": 0,
        "no_kickoff": 0, "seasons_incomplete_only": {},
    }
    for row in rows:
        stats["source_rows"] += 1
        season = _int(row.get("season"))
        if season is None:
            raise CorpusError("row %r has no season" % row.get("game_id"))
        home_raw = (row.get("home_team") or "").strip()
        away_raw = (row.get("away_team") or "").strip()
        home, away = normalize_team(home_raw), normalize_team(away_raw)
        stats["seen_codes"].update((home, away))
        if home_raw in RENAMES or away_raw in RENAMES:
            stats["renamed"] += 1
        unknown = {t for t in (home, away) if t not in canon}
        if unknown:
            raise CorpusError(
                "unknown team code(s) %s in %s (renames applied: %s). A silent "
                "drop here loses games — fix the rename map."
                % (sorted(unknown), row.get("game_id"), RENAMES))
        hs, as_ = _int(row.get("home_score")), _int(row.get("away_score"))
        if hs is None or as_ is None:
            stats["incomplete"] += 1
            stats["seasons_incomplete_only"].setdefault(season, 0)
            stats["seasons_incomplete_only"][season] += 1
            continue
        week = _int(row.get("week"))
        if week is None:
            raise CorpusError("completed game %s has no week" % row.get("game_id"))
        kickoff = parse_kickoff_utc(row.get("gameday"), row.get("gametime"),
                                    row.get("weekday"), season)
        if kickoff is None:
            stats["no_kickoff"] += 1
        stats["completed"] += 1
        seasons.setdefault(season, []).append({
            # --- the finals_{yr}.json record shape, in its original key order.
            "game_id": (row.get("game_id") or "").strip(),
            "home": home,
            "away": away,
            "kickoff_utc": kickoff,
            "status": "STATUS_FINAL",
            "final": True,
            "venue": (row.get("stadium") or "").strip() or None,
            "venue_city": None,      # not carried by games.csv — never guessed
            "venue_country": None,   # not carried by games.csv — never guessed
            "home_score": hs,
            "away_score": as_,
            "week": week,
            # --- additive fields (see module docstring).
            "game_type": (row.get("game_type") or "").strip(),
            "gameday": (row.get("gameday") or "").strip(),
            "neutral_site": (row.get("location") or "").strip() == "Neutral",
        })
    for games in seasons.values():
        games.sort(key=lambda g: (g["gameday"], g["kickoff_utc"] or "", g["game_id"]))
    # A season with rows but zero completed games (the in-progress season) is
    # reported, not silently missing.
    stats["skipped"] = [
        {"season": yr, "rows": n, "reason": "no completed games in source yet"}
        for yr, n in sorted(stats["seasons_incomplete_only"].items())
        if yr not in seasons
    ]
    return seasons, stats


def season_doc(season, games, fetched_utc):
    return {
        "season": season,
        "fetched_utc": fetched_utc,
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "kickoff_times_known": all(g["kickoff_utc"] for g in games),
        "games": games,
    }


def compare_with_espn_fixtures(seasons, fixtures_dir=FIXTURES):
    """Corpus vs the committed ESPN fixtures on their overlap. Returns a report
    dict; raises CorpusError on any disagreement of score/week/pairing."""
    report = {"seasons": {}, "compared": 0, "kickoff_shifted": 0}
    for yr in OVERLAP_SEASONS:
        path = os.path.join(fixtures_dir, "finals_%d.json" % yr)
        if not os.path.exists(path) or yr not in seasons:
            continue
        with open(path, encoding="utf-8") as fh:
            espn = {(g["home"], g["away"]): g for g in json.load(fh)["games"]}
        mine = {(g["home"], g["away"]): g for g in seasons[yr] if g["game_type"] == "REG"}
        missing = sorted(set(espn) - set(mine))
        extra = sorted(set(mine) - set(espn))
        if missing or extra:
            raise CorpusError(
                "season %d disagrees with finals_%d.json: %d game(s) only in "
                "ESPN %s, %d only in the corpus %s"
                % (yr, yr, len(missing), missing[:3], len(extra), extra[:3]))
        shifted = 0
        for key, g in mine.items():
            e = espn[key]
            if (g["home_score"], g["away_score"]) != (e["home_score"], e["away_score"]):
                raise CorpusError(
                    "score mismatch %s %s: corpus %s-%s vs ESPN %s-%s"
                    % (yr, key, g["home_score"], g["away_score"],
                       e["home_score"], e["away_score"]))
            if g["week"] != e["week"]:
                raise CorpusError("week mismatch %s %s: %s vs %s"
                                  % (yr, key, g["week"], e["week"]))
            delta = _kickoff_delta_minutes(g["kickoff_utc"], e["kickoff_utc"])
            if delta is None:
                continue
            if delta > KICKOFF_TOLERANCE_MIN:
                raise CorpusError(
                    "kickoff mismatch %s %s: corpus %s vs ESPN %s (%d min)"
                    % (yr, key, g["kickoff_utc"], e["kickoff_utc"], delta))
            if delta:
                shifted += 1
        report["seasons"][yr] = {"games": len(mine), "kickoff_shifted": shifted}
        report["compared"] += len(mine)
        report["kickoff_shifted"] += shifted
    return report


def _kickoff_delta_minutes(a, b):
    if not a or not b:
        return None
    fmt = "%Y-%m-%dT%H:%MZ"
    try:
        da = dt.datetime.strptime(a, fmt)
        db = dt.datetime.strptime(b, fmt)
    except ValueError:
        return None
    return int(abs((da - db).total_seconds()) // 60)


def fetch_source_csv(url=SOURCE_URL):
    """GET games.csv with the stdlib. LOUD on any transport/non-200 — a failed
    fetch must never be mistaken for an empty table (the silent-404 lesson)."""
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as resp:
            if resp.status != 200:
                raise CorpusError("GET %s returned HTTP %s" % (url, resp.status))
            raw = resp.read()
    except CorpusError:
        raise
    except Exception as exc:
        raise CorpusError("GET %s failed in transport: %s" % (url, exc)) from exc
    if not raw:
        raise CorpusError("GET %s returned 0 bytes" % url)
    return raw


def read_rows(raw):
    text = raw.decode("utf-8")
    return list(csv.DictReader(io.StringIO(text)))


def write_corpus(seasons, stats, source_sha256, fetched_utc, out_dir=OUT_DIR,
                 overlap=None):
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for season in sorted(seasons):
        games = seasons[season]
        doc = season_doc(season, games, fetched_utc)
        path = os.path.join(out_dir, "finals_%d.json" % season)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=True, indent=2)
            fh.write("\n")
        written.append({
            "season": season,
            "games": len(games),
            "reg": sum(1 for g in games if g["game_type"] == "REG"),
            "post": sum(1 for g in games if g["game_type"] != "REG"),
            "neutral_site": sum(1 for g in games if g["neutral_site"]),
            "kickoff_times_known": doc["kickoff_times_known"],
        })
    manifest = {
        "generated_utc": fetched_utc,
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "source_sha256": source_sha256,
        "source_rows": stats["source_rows"],
        "record_shape": "data/fixtures/finals_{yr}.json (+ game_type, gameday, "
                        "neutral_site); market columns are never copied",
        "renames": dict(sorted(RENAMES.items())),
        "renamed_games": stats["renamed"],
        "total_games": stats["completed"],
        "incomplete_rows_dropped": stats["incomplete"],
        "games_without_kickoff_time": stats["no_kickoff"],
        "seasons": written,
        "kickoff_complete_seasons": [w["season"] for w in written
                                     if w["kickoff_times_known"]],
        "skipped_seasons": stats["skipped"],
        "espn_overlap_check": overlap or {},
    }
    with open(MANIFEST if out_dir == OUT_DIR else os.path.join(out_dir, "manifest.json"),
              "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=True, indent=2, sort_keys=True)
        fh.write("\n")
    return manifest


# --------------------------------------------------------------------------- #
# selftest — committed fixtures only, writes NOTHING.
# --------------------------------------------------------------------------- #

def selftest():
    canon = canonical_teams()

    # 1) Transform math on the committed sample of REAL games.csv rows.
    with open(SAMPLE_CSV, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    seasons, stats = build_records(rows, canon)
    by_id = {g["game_id"]: g for games in seasons.values() for g in games}

    assert stats["source_rows"] == 9, stats["source_rows"]
    assert stats["completed"] == 8, stats["completed"]
    assert stats["incomplete"] == 1, "the unplayed 2026 row must be dropped"
    assert "2026_01_NE_SEA" not in by_id, "an unplayed game leaked into the corpus"
    assert stats["skipped"] == [{"season": 2026, "rows": 1,
                                 "reason": "no completed games in source yet"}], stats["skipped"]

    # Relocation renames (a silent mismatch here quietly drops games).
    assert by_id["2000_01_DEN_STL"]["home"] == "LAR"   # STL -> LAR
    assert by_id["2002_02_OAK_PIT"]["away"] == "LV"    # OAK -> LV
    assert by_id["2010_02_JAX_SD"]["home"] == "LAC"    # SD  -> LAC
    assert by_id["2024_03_SF_LA"]["home"] == "LAR"     # LA  -> LAR
    assert stats["renamed"] == 4, stats["renamed"]
    assert not (stats["seen_codes"] - canon), stats["seen_codes"] - canon

    # ET -> UTC, both DST states, plus the legacy 12-hour night slot.
    assert by_id["2023_01_CAR_ATL"]["kickoff_utc"] == "2023-09-10T17:00Z"   # 13:00 EDT
    assert by_id["2010_02_JAX_SD"]["kickoff_utc"] == "2010-09-19T20:15Z"    # 16:15 EDT
    assert by_id["2022_20_NYG_PHI"]["kickoff_utc"] == "2023-01-22T01:15Z"   # 20:15 EST, day rolls
    assert by_id["2024_22_KC_PHI"]["kickoff_utc"] == "2025-02-09T23:30Z"    # 18:30 EST
    assert by_id["2000_01_DEN_STL"]["kickoff_utc"] == "2000-09-05T01:00Z"   # '09:00' = 21:00 ET
    # 1999 has no clock time upstream: null, never a fabricated midnight.
    assert by_id["1999_01_MIN_ATL"]["kickoff_utc"] is None
    assert by_id["1999_01_MIN_ATL"]["gameday"] == "1999-09-12"
    assert stats["no_kickoff"] == 1

    # The 12-hour assumption is asserted, not assumed.
    for bad_season, bad_weekday in ((2019, "Monday"), (2003, "Sunday")):
        try:
            parse_kickoff_utc("2003-09-08", "09:00", bad_weekday, bad_season)
        except CorpusError:
            pass
        else:                                                   # pragma: no cover
            raise AssertionError("'09:00' outside 2000-2005/non-Sunday must fail loudly")

    # Postseason + neutral site are carried; scores are ints.
    sb = by_id["2024_22_KC_PHI"]
    assert sb["game_type"] == "SB" and sb["neutral_site"] is True
    assert sb["home_score"] == 40 and sb["away_score"] == 22
    assert all(isinstance(g["home_score"], int) and isinstance(g["away_score"], int)
               for g in by_id.values())
    assert all(g["status"] == "STATUS_FINAL" and g["final"] is True
               for g in by_id.values())

    # MARKET_DISPLAY_ONLY: not one market column may reach a record.
    market_cols = {"spread_line", "total_line", "away_moneyline", "home_moneyline",
                   "away_spread_odds", "home_spread_odds", "under_odds", "over_odds",
                   "result", "total"}
    for g in by_id.values():
        leaked = market_cols & set(g)
        assert not leaked, "market column(s) %s leaked into the corpus" % sorted(leaked)

    # 2) The committed corpus itself (when present): shape + reconciliation.
    corpus_seasons = {}
    if os.path.isdir(OUT_DIR):
        for name in sorted(os.listdir(OUT_DIR)):
            if not (name.startswith("finals_") and name.endswith(".json")):
                continue
            with open(os.path.join(OUT_DIR, name), encoding="utf-8") as fh:
                doc = json.load(fh)
            games = doc["games"]
            assert games, "%s is empty" % name
            corpus_seasons[int(doc["season"])] = games
            for g in games:
                assert g["home"] in canon and g["away"] in canon, (name, g["game_id"])
                assert g["home"] != g["away"], g["game_id"]
                assert g["status"] == "STATUS_FINAL" and g["final"] is True
                assert isinstance(g["home_score"], int)
                assert isinstance(g["away_score"], int)
                assert not (market_cols & set(g))
            ids = [g["game_id"] for g in games]
            assert len(set(ids)) == len(ids), "%s has duplicate game_ids" % name
            assert doc["kickoff_times_known"] == all(g["kickoff_utc"] for g in games)

    if corpus_seasons:
        with open(MANIFEST, encoding="utf-8") as fh:
            man = json.load(fh)
        counts = {int(s["season"]): s["games"] for s in man["seasons"]}
        assert counts == {yr: len(g) for yr, g in corpus_seasons.items()}, \
            "manifest counts disagree with the committed season files"
        assert man["total_games"] == sum(counts.values())
        # 3) Corpus vs the ESPN fixtures on the 2021-2025 overlap.
        overlap = compare_with_espn_fixtures(corpus_seasons)
        assert overlap["compared"] == 1359, overlap["compared"]
        print("selftest OK: sample transform exact (8 of 9 rows kept, 4 renames, "
              "1999 kickoff null), %d corpus games across %d seasons, %d overlap "
              "games agree with the ESPN fixtures"
              % (sum(counts.values()), len(counts), overlap["compared"]))
    else:                                                       # pragma: no cover
        print("selftest OK: sample transform exact (no committed corpus to check)")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--csv", help="build from a local games.csv instead of fetching")
    ap.add_argument("--out", default=OUT_DIR, help="output directory")
    ap.add_argument("--min-games", type=int, default=MIN_GAMES,
                    help="refuse to write fewer completed games than this")
    ap.add_argument("--selftest", action="store_true",
                    help="assert on committed fixtures; write nothing")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    try:
        if args.csv:
            with open(args.csv, "rb") as fh:
                raw = fh.read()
        else:
            raw = fetch_source_csv()
        rows = read_rows(raw)
        seasons, stats = build_records(rows)
    except (CorpusError, OSError) as exc:
        print("BACKTEST CORPUS FAILED: %s" % exc, file=sys.stderr)
        print("Committed corpus left untouched.", file=sys.stderr)
        return 1

    if stats["completed"] < args.min_games:
        print("BACKTEST CORPUS FAILED: only %d completed games (< %d) — refusing "
              "a truncated corpus." % (stats["completed"], args.min_games),
              file=sys.stderr)
        return 1
    canon = canonical_teams()
    if stats["completed"] >= MIN_GAMES and stats["seen_codes"] != canon:
        print("BACKTEST CORPUS FAILED: team codes do not reconcile — missing %s, "
              "unexpected %s" % (sorted(canon - stats["seen_codes"]),
                                 sorted(stats["seen_codes"] - canon)), file=sys.stderr)
        return 1

    try:
        overlap = compare_with_espn_fixtures(seasons)
    except CorpusError as exc:
        print("BACKTEST CORPUS FAILED: %s" % exc, file=sys.stderr)
        return 1

    fetched_utc = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = write_corpus(seasons, stats, hashlib.sha256(raw).hexdigest(),
                            fetched_utc, out_dir=args.out, overlap=overlap)
    print("Wrote %d season files to %s: %d completed games (%d REG, %d post), "
          "%d unplayed rows dropped."
          % (len(manifest["seasons"]), args.out, manifest["total_games"],
             sum(s["reg"] for s in manifest["seasons"]),
             sum(s["post"] for s in manifest["seasons"]),
             manifest["incomplete_rows_dropped"]))
    for s in manifest["seasons"]:
        print("  %d: %d games (%d REG, %d post)%s"
              % (s["season"], s["games"], s["reg"], s["post"],
                 "" if s["kickoff_times_known"] else "  [no kickoff times upstream]"))
    for s in manifest["skipped_seasons"]:
        print("  SKIPPED %d: %s (%d row(s))" % (s["season"], s["reason"], s["rows"]))
    print("  ESPN overlap: %d games agree (%d kickoffs differ within %d min)"
          % (overlap["compared"], overlap["kickoff_shifted"], KICKOFF_TOLERANCE_MIN))
    return 0


if __name__ == "__main__":
    sys.exit(main())
