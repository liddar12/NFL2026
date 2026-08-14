"""BUILD data/game_context.json — the PREGAME enrichment join that every
Rel22 signal family reads.

WHY: the backtest corpus (data/fixtures/backtest_corpus/, 7,276 completed games
over 1999-2025) is a bare fact table: teams, week, scores, kickoff. The nflverse
`nfldata` games.csv carries the *context* around each of those same games —
whether it was a divisional matchup, who the two head coaches were, how many
days of rest each side had, what the venue was. Five families need that context
and none of them should each re-parse a 2 MB CSV and each re-invent the join.
This builder does the join once and publishes it under ONE key.

THE JOIN KEY IS FLAT:  "{season}|{week}|{home}|{away}"

That is byte-for-byte the key data/market_baseline.json and
data/weather_history.json already use, so promote_signals' existing
`_load_json(path, "games")` + `f"{season}|{g['week']}|{g['home']}|{g['away']}"`
lookup works verbatim. A second key convention would be a bug farm.
Verified coverage at build time (and asserted, not assumed):
  * 7,276 / 7,276 backtest-corpus games join, zero misses
  * 1,359 / 1,359 ESPN fixture games (2021-2025) join, zero misses

MARKET COLUMNS ARE NEVER READ (permanent owner policy). games.csv ships eight
betting columns. This module does not filter them downstream — it never
CONSTRUCTS them. Every row is projected through the positive allow-list
ENRICHMENT_COLUMNS at the moment it leaves csv.DictReader, so a future caller
that reaches for a price gets a KeyError, not a number. No betting column name
appears anywhere in this file, by design: the denylist lives in the *checkers*
(scripts/validate_data.check_game_context_no_market_columns and
tests/feature/game_context.test.mjs), never in the producer. A checker that
imports the producer's constants grades the pipeline with the pipeline's own
marking scheme.

`temp` and `wind` are deliberately NOT carried even though they are
allow-listable: they are measured AT kickoff, not known before it, and
data/weather_history.json is the artifact that owns weather honestly.

LABEL-ONLY FIELDS — read this before wiring anything:

    referee, home_qb, away_qb

are POST-GAME in games.csv (0 of 272 populated for unplayed rows — verified in
docs/roadmap/rel18/FEASIBILITY.md). They are ground-truth LABELS. They may be
used to *build* or *score* a pregame estimator; they may NEVER be a live model
input, because a model that reads them knows the answer to the question it is
being asked. The emitted document declares them by name in
`label_only_fields` so the rule is machine-readable, not just prose.

Per the Rel18 SOLUTION_DESIGN R1 resolution, `referee` is a FIELD here and
nothing more. There is no referee family: a non-appliable family that wins a
promotion run suppresses adoption entirely, so referee carries zero upside and
real downside.

HONESTY RULES:
  * COMPLETED GAMES ONLY. A row is kept only when BOTH scores parse as ints.
    Unplayed rows (the whole 2026 season, today) are SKIPPED and COUNTED
    out loud in `diagnostics.unplayed_rows_skipped` — never carried with
    invented context. Consequence, stated plainly: this artifact has no live
    season in it, so a family built on it can be BACKTESTED but cannot yet be
    APPLIED to 2026. Say so in your family's data rather than pretending.
  * Team codes are renamed (LA->LAR, OAK->LV, SD->LAC, STL->LAR) and then
    reconciled against data/fixtures/teams.json. An unknown code is a HARD
    FAILURE, never a silently dropped game — a silent drop is how a join
    quietly loses a season.
  * Missing source values stay null. An empty referee stays null; it never
    becomes "" or "Unknown".
  * Any transport/parse failure leaves the committed artifact untouched.

DERIVED, NOT READ: `meeting_no` — within a season, each unordered team pair's
games sorted by date; the first is 1, the second 2, a postseason rematch 3.
It is pregame-known (the schedule is published preseason and the bracket is
known before kickoff), which is why it is allowed to be a feature.

USAGE:
  python3 scripts/build_game_context.py                  # fetch + write data/
  python3 scripts/build_game_context.py --csv PATH       # build from a local CSV
  python3 scripts/build_game_context.py --out PATH       # write elsewhere
  python3 scripts/build_game_context.py --selftest       # asserts only, writes nothing

Stdlib only (urllib + csv). No pandas, no requests, no numpy.
"""

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))

DATA = os.path.join(_ROOT, "data")
FIXTURES = os.path.join(DATA, "fixtures")
CORPUS_DIR = os.path.join(FIXTURES, "backtest_corpus")
TEAMS_PATH = os.path.join(FIXTURES, "teams.json")
SAMPLE_CSV = os.path.join(FIXTURES, "nflverse_sample", "games_context_sample.csv")
OUT_PATH = os.path.join(DATA, "game_context.json")

SOURCE_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
SOURCE_NAME = ("nflverse nfldata games.csv, pregame enrichment allow-list "
               "(market columns are never read)")
HTTP_TIMEOUT = 90

# ESPN-era fixture seasons we can cross-check the join against.
ESPN_FIXTURE_SEASONS = (2021, 2022, 2023, 2024, 2025)

# nflverse relocation codes -> our canonical set (data/fixtures/teams.json).
# Duplicated deliberately rather than imported from build_market_baseline.py:
# keeping the two readers physically separate means the module the enrichment
# builders import has no code path to a price at all.
RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}

# THE POSITIVE ALLOW-LIST. A column not named here is never read, so it can
# never be emitted. This is the whole market guard at the code layer.
ENRICHMENT_COLUMNS = (
    "game_id", "season", "game_type", "week", "gameday",
    "away_team", "home_team", "away_score", "home_score",
    "location", "div_game", "roof", "surface",
    "away_rest", "home_rest",
    "away_coach", "home_coach", "referee",
    "away_qb_id", "home_qb_id", "away_qb_name", "home_qb_name",
)

# POST-GAME. Ground-truth labels only — never a live model input. Declared in
# the emitted document so downstream code can assert on it mechanically.
LABEL_ONLY_FIELDS = ("away_qb", "home_qb", "referee")

LABEL_ONLY_NOTE = (
    "POST-GAME, LABEL ONLY. referee and home_qb/away_qb are 0/272 populated for "
    "unplayed games upstream; they are ground truth for building and scoring a "
    "pregame estimator and may NEVER be read as a live model input."
)

POLICY = ("NO MARKET COLUMNS - betting columns are never read on this path "
          "(positive allow-list at ENRICHMENT_COLUMNS)")

JOIN_KEY = "{season}|{week}|{home}|{away}"

# A full pull is 7k+ completed games; anything less is a truncated fetch.
MIN_GAMES = 7000


class ContextError(RuntimeError):
    """Raised loudly. Never swallowed into a partial or fabricated artifact."""


# ---------------------------------------------------------------------------
# Parsing.
# ---------------------------------------------------------------------------

def canonical_teams():
    with open(TEAMS_PATH, encoding="utf-8") as fh:
        return {t["abbrev"] for t in json.load(fh)["teams"]}


def normalize_team(code):
    code = (code or "").strip()
    return RENAMES.get(code, code)


def context_key(season, week, home, away):
    """The ONE join key. Mirrors market_baseline.json / weather_history.json."""
    return "%d|%d|%s|%s" % (int(season), int(week), home, away)


def project(row):
    """Row -> a NEW dict built only from ENRICHMENT_COLUMNS.

    A column outside the allow-list is not filtered later; it is never carried.
    """
    return {k: row.get(k) for k in ENRICHMENT_COLUMNS}


def _text(value):
    """'' / None / whitespace -> None. Never invents a placeholder string."""
    value = (value or "").strip()
    return value or None


def _int_or_none(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def _qb(pid, name):
    """{'id','name'} or None. Never half-populated, never fabricated."""
    pid, name = _text(pid), _text(name)
    if pid is None and name is None:
        return None
    return {"id": pid, "name": name}


def parse_rows(text, canon=None):
    """Parse games.csv text -> (entries, skipped_unplayed, renamed_games).

    `entries` is a list of (key, season, gameday, pair, record) tuples for
    COMPLETED games only. Raises ContextError on a missing header column or an
    unknown team code — both are silent-data-loss bugs if allowed through.
    """
    reader = csv.DictReader(io.StringIO(text))
    header = set(reader.fieldnames or [])
    missing = [c for c in ENRICHMENT_COLUMNS if c not in header]
    if missing:
        raise ContextError("games.csv header is missing allow-listed column(s): "
                           + ", ".join(missing))

    canon = canon if canon is not None else canonical_teams()
    entries = []
    skipped_unplayed = 0
    renamed = 0
    seen = {}

    for raw in reader:
        r = project(raw)
        season = _int_or_none(r["season"])
        week = _int_or_none(r["week"])
        if season is None or week is None:
            raise ContextError("row %r has an unreadable season/week"
                               % (r.get("game_id"),))

        home_raw, away_raw = (r["home_team"] or ""), (r["away_team"] or "")
        home, away = normalize_team(home_raw), normalize_team(away_raw)
        if home != home_raw.strip() or away != away_raw.strip():
            renamed += 1
        unknown = [c for c in (home, away) if c not in canon]
        if unknown:
            raise ContextError(
                "unknown team code(s) %s in %r after renames %r — refusing to "
                "drop the game silently" % (unknown, r.get("game_id"), RENAMES))

        hs, as_ = _int_or_none(r["home_score"]), _int_or_none(r["away_score"])
        if hs is None or as_ is None:
            # Unplayed. Skipped LOUDLY (counted and reported), never invented.
            skipped_unplayed += 1
            continue

        key = context_key(season, week, home, away)
        if key in seen:
            raise ContextError("duplicate join key %r (%s and %s) — the flat key "
                               "is not unique, the join would silently collide"
                               % (key, seen[key], r.get("game_id")))
        seen[key] = r.get("game_id")

        div = _int_or_none(r["div_game"])
        record = {
            "div_game": 1 if div == 1 else 0,
            "meeting_no": None,             # derived below
            "game_type": _text(r["game_type"]),
            "neutral_site": (_text(r["location"]) or "Home").lower() != "home",
            "home_coach": _text(r["home_coach"]),
            "away_coach": _text(r["away_coach"]),
            "home_rest": _int_or_none(r["home_rest"]),
            "away_rest": _int_or_none(r["away_rest"]),
            "roof": _text(r["roof"]),
            "surface": _text(r["surface"]),
            # --- LABEL ONLY below this line (see LABEL_ONLY_FIELDS) ---
            "referee": _text(r["referee"]),
            "home_qb": _qb(r["home_qb_id"], r["home_qb_name"]),
            "away_qb": _qb(r["away_qb_id"], r["away_qb_name"]),
        }
        pair = tuple(sorted((home, away)))
        entries.append((key, season, _text(r["gameday"]) or "", pair, record))

    return entries, skipped_unplayed, renamed


def assign_meeting_no(entries):
    """Derive meeting_no in place: nth time this pair met this season, by date.

    Pregame-known (the schedule is published preseason), so it is a legal
    feature. Ties on gameday fall back to the join key for determinism.
    """
    buckets = {}
    for key, season, gameday, pair, _rec in entries:
        buckets.setdefault((season, pair), []).append((gameday, key))
    order = {}
    for games in buckets.values():
        for n, (_gameday, key) in enumerate(sorted(games), start=1):
            order[key] = n
    for key, _season, _gameday, _pair, rec in entries:
        rec["meeting_no"] = order[key]


# ---------------------------------------------------------------------------
# Reconciliation — a join that loses games must fail, not shrug.
# ---------------------------------------------------------------------------

def _corpus_keys():
    """{season: [key, ...]} from data/fixtures/backtest_corpus/, or {}."""
    out = {}
    if not os.path.isdir(CORPUS_DIR):
        return out
    for fname in sorted(os.listdir(CORPUS_DIR)):
        if not (fname.startswith("finals_") and fname.endswith(".json")):
            continue
        with open(os.path.join(CORPUS_DIR, fname), encoding="utf-8") as fh:
            doc = json.load(fh)
        season = int(doc["season"])
        out[season] = [context_key(season, g["week"], g["home"], g["away"])
                       for g in doc["games"]]
    return out


def _espn_fixture_keys():
    out = {}
    for season in ESPN_FIXTURE_SEASONS:
        path = os.path.join(FIXTURES, "finals_%d.json" % season)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        out[season] = [context_key(season, g["week"], g["home"], g["away"])
                       for g in doc["games"]]
    return out


def reconcile(games, by_season_keys, label):
    """Every key in `by_season_keys` must exist in `games`. Loud on any miss.

    Only seasons the artifact actually covers are compared, so a fixture build
    (synthetic seasons) reports "no overlap" instead of failing spuriously.
    """
    covered = {int(k.split("|", 1)[0]) for k in games}
    overlap = sorted(s for s in by_season_keys if s in covered)
    if not overlap:
        print("  %-14s no overlapping seasons — nothing to reconcile" % (label + ":"))
        return {"seasons": 0, "compared": 0, "joined": 0, "missing": 0}
    compared = joined = 0
    missing = []
    for season in overlap:
        for key in by_season_keys[season]:
            compared += 1
            if key in games:
                joined += 1
            elif len(missing) < 10:
                missing.append(key)
    if joined != compared:
        raise ContextError(
            "%s join lost %d of %d games (e.g. %s) — a silent mismatch drops "
            "games; check RENAMES and the week/team normalisation"
            % (label, compared - joined, compared, ", ".join(missing)))
    print("  %-14s %d/%d joined across %d season(s), zero misses"
          % (label + ":", joined, compared, len(overlap)))
    return {"seasons": len(overlap), "compared": compared,
            "joined": joined, "missing": 0}


# ---------------------------------------------------------------------------
# Document.
# ---------------------------------------------------------------------------

def build_doc(text, canon=None, reconcile_against=True):
    entries, skipped, renamed = parse_rows(text, canon=canon)
    if not entries:
        raise ContextError("no completed games parsed — refusing to write an "
                           "empty context")
    assign_meeting_no(entries)
    games = {key: rec for key, _s, _d, _p, rec in entries}
    seasons = sorted({s for _k, s, _d, _p, _r in entries})

    per_season = {}
    for key, season, _d, _p, rec in entries:
        b = per_season.setdefault(str(season), {"games": 0, "div_games": 0})
        b["games"] += 1
        b["div_games"] += rec["div_game"]

    meetings = {}
    for rec in games.values():
        n = str(rec["meeting_no"])
        meetings[n] = meetings.get(n, 0) + 1

    diagnostics = {
        "games": len(games),
        "seasons": len(seasons),
        "unplayed_rows_skipped": skipped,
        "renamed_team_rows": renamed,
        "teams_normalised": len({k.split("|")[2] for k in games}
                                | {k.split("|")[3] for k in games}),
        "distinct_coaches": len({c for rec in games.values()
                                 for c in (rec["home_coach"], rec["away_coach"])
                                 if c}),
        "distinct_referees": len({rec["referee"] for rec in games.values()
                                  if rec["referee"]}),
        "meetings_by_number": meetings,
        "null_field_counts": {
            f: sum(1 for rec in games.values() if rec[f] is None)
            for f in ("home_coach", "away_coach", "home_rest", "away_rest",
                      "roof", "surface", "referee", "home_qb", "away_qb")
        },
        "by_season": per_season,
    }

    if reconcile_against:
        print("game context: reconciling the join")
        diagnostics["corpus_reconcile"] = reconcile(
            games, _corpus_keys(), "corpus")
        diagnostics["espn_fixture_reconcile"] = reconcile(
            games, _espn_fixture_keys(), "espn fixtures")

    return {
        "generated_utc": dt.datetime.now(dt.timezone.utc)
                           .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE_NAME,
        "source_url": SOURCE_URL,
        "policy": POLICY,
        "join_key": JOIN_KEY,
        "label_only_fields": list(LABEL_ONLY_FIELDS),
        "label_only_note": LABEL_ONLY_NOTE,
        "renames": dict(RENAMES),
        "seasons": seasons,
        "diagnostics": diagnostics,
        "games": games,
    }


def write_doc(doc, path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Selftest — no network, writes nothing.
# ---------------------------------------------------------------------------

_SELFTEST_CANON = {"LAR", "LV", "LAC", "KC", "SF", "DEN"}

# The selftest drives the COMMITTED fixture at SAMPLE_CSV rather than a literal
# in this file. Two reasons, both load-bearing:
#   1. This module must not contain a single betting-column NAME (that is the
#      grep layer of the market guard, and a poisoned literal here would defeat
#      it). The fixture carries the poison; this file never spells it.
#   2. The unit test and the .mjs feature test then grade the same bytes, so
#      they cannot drift apart.
# The fixture is 4 completed synthetic games + 1 unplayed row, every row
# carrying eight extra columns with absurd values. What those columns are called
# is deliberately not this module's business — the assertions below check that
# EXTRA columns exist and that their VALUES vanish, which is stronger than
# checking for names anyway (a computed column name defeats a name check).
_POISON_VALUES = ("99999", "999.5", "-999")


def _walk_keys(node):
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_keys(v)


def selftest():
    if not os.path.exists(SAMPLE_CSV):
        raise ContextError("missing fixture %s — the selftest grades the "
                           "committed bytes, it does not synthesise them"
                           % SAMPLE_CSV)
    with open(SAMPLE_CSV, encoding="utf-8") as fh:
        csv_text = fh.read()

    # 0. The fixture really is poisoned, or the guard below tests nothing.
    #    Checked WITHOUT naming a price: count the columns outside the
    #    allow-list, and confirm the absurd values are present in the source.
    header = csv_text.splitlines()[0].split(",")
    extras = [c for c in header if c not in ENRICHMENT_COLUMNS]
    assert len(extras) >= 8, (
        "fixture must carry at least the 8 non-allow-listed source columns so "
        "the projection is exercised, got %r" % (extras,))
    for value in _POISON_VALUES:
        assert value in csv_text, "fixture lost its poisoned value %r" % value

    doc = build_doc(csv_text, canon=_SELFTEST_CANON, reconcile_against=False)
    games = doc["games"]

    # 1. Completed games only; the unplayed row is skipped and COUNTED.
    assert len(games) == 4, games.keys()
    assert doc["diagnostics"]["unplayed_rows_skipped"] == 1
    assert not any(k.startswith("2100|") for k in games), "unplayed row leaked"

    # 2. RENAMES applied, and the key is the flat one.
    assert "2099|1|LAR|LV" in games, sorted(games)
    assert "2099|1|LAC|KC" in games, sorted(games)
    assert context_key(2099, 1, "LAR", "LV") == "2099|1|LAR|LV"

    # 3. meeting_no is derived by date: 1, then 2, then the postseason rematch 3.
    assert games["2099|1|LAR|LV"]["meeting_no"] == 1
    assert games["2099|9|LV|LAR"]["meeting_no"] == 2
    assert games["2099|20|LAR|LV"]["meeting_no"] == 3
    assert games["2099|1|LAC|KC"]["meeting_no"] == 1

    # 4. Pregame fields land as typed values, not strings.
    g1 = games["2099|1|LAR|LV"]
    assert g1["div_game"] == 1 and games["2099|1|LAC|KC"]["div_game"] == 0
    assert g1["home_coach"] == "Home Coach" and g1["away_coach"] == "Away Coach"
    assert g1["home_rest"] == 7 and g1["away_rest"] == 7
    assert g1["roof"] == "dome" and g1["surface"] == "turf"
    assert g1["neutral_site"] is False
    assert games["2099|20|LAR|LV"]["neutral_site"] is True

    # 5. Missing values stay NULL — never "", never a placeholder.
    assert games["2099|9|LV|LAR"]["referee"] is None
    assert games["2099|1|LAC|KC"]["surface"] is None
    assert games["2099|1|LAC|KC"]["home_qb"] is None
    assert games["2099|1|LAC|KC"]["away_qb"] is None
    assert g1["home_qb"] == {"id": "00-QBB", "name": "B.Home"}

    # 6. THE MARKET GUARD, behaviourally. Every source row carried the poisoned
    #    columns; neither their NAMES (taken from the fixture header, never
    #    spelled in this file) nor their absurd VALUES may reach the document.
    blob = json.dumps(doc)
    for poison in _POISON_VALUES:
        assert poison not in blob, \
            "a poisoned market VALUE (%s) reached the document" % poison
    emitted = set(_walk_keys(doc))
    leaked = sorted(set(extras) & emitted)
    assert not leaked, "non-allow-listed source column(s) reached the doc: %s" % leaked
    # The record's key set is exactly the published schema, nothing more.
    expected_fields = {
        "div_game", "meeting_no", "game_type", "neutral_site",
        "home_coach", "away_coach", "home_rest", "away_rest",
        "roof", "surface", "referee", "home_qb", "away_qb",
    }
    for key, rec in games.items():
        assert set(rec) == expected_fields, (key, sorted(set(rec) ^ expected_fields))

    # 7. Label-only fields are DECLARED, and the declaration matches reality.
    assert doc["label_only_fields"] == sorted(LABEL_ONLY_FIELDS)
    assert set(doc["label_only_fields"]) <= expected_fields

    # 8. A missing header column FAILS LOUDLY rather than emitting nulls.
    broken = csv_text.replace("referee,", "", 1)
    try:
        build_doc(broken, canon=_SELFTEST_CANON, reconcile_against=False)
    except ContextError as err:
        assert "referee" in str(err), err
    else:
        raise AssertionError("header guard did not fire on a missing column")

    # 9. An unknown team code is a HARD FAILURE, not a dropped game.
    try:
        build_doc(csv_text, canon={"KC"}, reconcile_against=False)
    except ContextError as err:
        assert "unknown team code" in str(err), err
    else:
        raise AssertionError("unknown team code was swallowed")

    # 10. Reconciliation catches a lost game (the failure mode it exists for).
    try:
        reconcile(games, {2099: ["2099|1|LAR|LV", "2099|3|KC|SF"]}, "probe")
    except ContextError as err:
        assert "lost 1 of 2" in str(err), err
    else:
        raise AssertionError("reconcile did not catch a missing game")
    assert reconcile(games, {1899: ["1899|1|KC|SF"]}, "probe")["compared"] == 0

    # 11. Counted-by-hand diagnostics.
    d = doc["diagnostics"]
    assert d["games"] == 4 and d["seasons"] == 1
    assert d["renamed_team_rows"] == 4          # every 2099 row carries STL/OAK/SD
    assert d["meetings_by_number"] == {"1": 2, "2": 1, "3": 1}
    assert d["by_season"] == {"2099": {"games": 4, "div_games": 3}}
    assert d["distinct_coaches"] == 4           # Home/Away/K/S
    assert d["distinct_referees"] == 2          # Ref One (x2) + Ref Two
    assert d["null_field_counts"]["referee"] == 1
    assert d["null_field_counts"]["home_qb"] == 1

    print("selftest OK: flat key + renames, meeting_no 1/2/3 by date, unplayed "
          "skipped and counted, nulls never fabricated, 8 poisoned market "
          "columns kept out by name AND by value, header/team/join guards loud")


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--csv", help="build from a local games.csv instead of fetching")
    ap.add_argument("--out", default=OUT_PATH, help="output path")
    ap.add_argument("--no-reconcile", action="store_true",
                    help="skip the corpus/fixture join reconciliation")
    args = ap.parse_args(argv)

    existing = os.path.exists(args.out)

    if args.csv:
        try:
            with open(args.csv, encoding="utf-8") as fh:
                text = fh.read()
        except OSError as err:
            print("GAME CONTEXT: cannot read %s: %s" % (args.csv, err), file=sys.stderr)
            return 1
        min_games = 0
    else:
        try:
            with urllib.request.urlopen(SOURCE_URL, timeout=HTTP_TIMEOUT) as resp:
                text = resp.read().decode("utf-8")
        except Exception as err:  # noqa: BLE001 — loud, keep the committed file
            print("GAME CONTEXT: fetch failed: %s" % err, file=sys.stderr)
            return 0 if existing else 1
        min_games = MIN_GAMES

    try:
        doc = build_doc(text, reconcile_against=not args.no_reconcile)
    except (ContextError, OSError, ValueError) as err:
        print("GAME CONTEXT: %s" % err, file=sys.stderr)
        return 1

    n = len(doc["games"])
    if n < min_games:
        print("GAME CONTEXT: only %d completed games (<%d) — refusing a partial "
              "write; the committed artifact is untouched" % (n, min_games),
              file=sys.stderr)
        return 1

    write_doc(doc, args.out)
    d = doc["diagnostics"]
    print("Wrote %s: %d games, seasons %d-%d, %d unplayed rows skipped, "
          "%d teams, %d coaches"
          % (os.path.relpath(args.out, _ROOT), n, doc["seasons"][0],
             doc["seasons"][-1], d["unplayed_rows_skipped"],
             d["teams_normalised"], d["distinct_coaches"]))
    print("LABEL ONLY (never a live input): %s" % ", ".join(LABEL_ONLY_FIELDS))
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
