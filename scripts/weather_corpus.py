"""R94 weather corpus reader: venue filter, roof census, condition counts.

The owner's question (2026-09-20):

  "Does rain actually hurt QB and WR numbers, or is that just something people
   say?"

Everything downstream of that question needs one thing first: an honest answer
to "which games am I allowed to call outdoor games, and how many of each kind
of weather are there?" This module is that answer and nothing else. It reads,
it joins, it filters, it counts. It fits no coefficient, adopts nothing,
registers nothing, and writes nothing at all.

THE FILTER LIVES HERE, NOT ON DISK. data/weather_history.json is 893 rows of
kickoff-hour observation keyed to the home team's stadium. Nineteen of those
rows are relocations - games whose nominal home team did not play at its own
venue - and the worst of them is 2022|11|BUF|CLE, a Buffalo home game moved to
Ford Field ahead of a lake-effect storm and played INDOORS while the archive
faithfully records the 35.6 kph that was blowing outside. That is the fifth
windiest row in the whole file and it is pure noise: no wind touched the ball.

The tempting fix is to delete those rows from the file. That fix is forbidden
here, and deliberately so. data/weather_history.json is pinned by
tests/feature/r56_weather.test.mjs at exact equality (96 stadium-months, 9
skipped, 0 wind fires, 5 cold fires, withheld == ['CHI-12','GB-12'], 0
unjoined) and its schema is closed. Rewriting it to suit a measurement would
red a shipped contract to make an experiment convenient - the wrong way round.
So the filter is a READER concern: every consumer of the corpus comes through
venue_verified() and the file on disk is never touched. A test asserts the
file's sha256 is identical before and after a full run; corpus_sha256() is
what it calls.

HOW A ROW IS VERIFIED. The neutral flag comes from
data/fixtures/backtest_weekly/games_meta.json, the same nflverse games.csv
projection the weekly backtest reads. Nothing else in that file is consulted:
this module takes season, week, home, away, roof, neutral and stadium through a
POSITIVE allow-list and drops every other column on the floor, so the handicap
and price columns that also live in that fixture cannot reach anything built on
top of this. That is the repo's market boundary enforced in code rather than
asserted in prose.

WHY THE ROOF CHECK IS WORTH RUNNING. games_meta's neutral flag and
data/game_context.json's nflverse roof are two independent columns from the
same upstream release, and they are used here for two different jobs: neutral
does the FILTERING, roof does the CHECKING. On the committed corpus all 874
survivors read roof 'outdoors' and every one of the 19 dropped rows is a
relocation - the two columns agree completely, which is the only reason to
believe the filter is exactly right rather than approximately right. If a
future games_meta refresh breaks that agreement, roof_audit() names the
offending keys instead of quietly measuring an indoor game as a wet one.

THE THREE ROOF BUCKETS. roof_state() classifies every 2021-2025 REG game, not
just the ones the weather archive covers:

  treated  roof 'outdoors'        - the measurement sample
  placebo  roof 'dome' or 'closed' - a roofed game has no weather, so the same
                                     estimator run here must return nothing;
                                     it is the arm that catches an estimator
                                     finding weather in the absence of weather
  open     roof 'open'             - a retractable roof that was OPEN at
                                     kickoff. Physically outdoor, but the
                                     decision to open it is itself a weather
                                     decision (roofs close for rain), so
                                     pooling these with treated would import
                                     the selection this measurement is trying
                                     to avoid. Reported, never pooled.

WHY BANDS ARE PRE-SEEDED. condition_counts() emits every pre-registered band
for every requested season whether or not it fired, so a band that never
happened reads 0 instead of being absent. An absent key and a zero count read
identically to a careless reader and completely differently to an honest one:
zero is a measurement, absent is a gap. Heavy rain is the case that matters -
there are twelve such games in five seasons and five inside the primary
stratum - and a census that silently omitted an empty season would make a
thin cell look like a missing one.

Stdlib only. Nothing here reads a market number. Nothing here writes.
"""

import argparse
import hashlib
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
WEATHER_PATH = os.path.join(DATA, "weather_history.json")
GAMES_META_PATH = os.path.join(DATA, "fixtures", "backtest_weekly", "games_meta.json")
GAME_CONTEXT_PATH = os.path.join(DATA, "game_context.json")
FIXTURE_PATH = os.path.join(DATA, "fixtures", "weather", "corpus_selftest.json")

WEATHER_REL = "data/weather_history.json"
GAMES_META_REL = "data/fixtures/backtest_weekly/games_meta.json"
GAME_CONTEXT_REL = "data/game_context.json"

# The seasons the weather archive covers. Extending this backwards is discussed
# in the R94 write-up and deliberately not attempted: the static stadium table
# cannot represent the relocations and roof changes of earlier decades, so a
# longer corpus would buy n at the price of exactly the venue error this module
# exists to remove.
SEASONS = (2021, 2022, 2023, 2024, 2025)
GAME_TYPE = "REG"

# nflverse roof vocabulary, split by what the estimator may do with it.
ROOF_TREATED = ("outdoors",)
ROOF_PLACEBO = ("dome", "closed")
ROOF_REPORTED_ONLY = ("open",)

# The only games_meta columns this module will surface. Everything else in that
# fixture - the handicap and price columns included - is dropped at the door.
META_ALLOW = ("season", "week", "home", "away", "roof", "neutral", "stadium")
ROW_FIELDS = ("key", "season", "week", "home", "away", "stadium", "neutral",
              "meta_roof", "precip_mm", "temp_c", "wind_kph")

# Pre-registered precipitation bands, in millimetres of liquid water at the
# kickoff hour. The edges are not arbitrary: 0.25 mm is the smallest amount
# Open-Meteo's archive resolves as more than a rounding artefact, 1.0 mm is the
# PRIMARY wet threshold the R94 hypothesis grid is written against, and 2.5 mm
# is the conventional "moderate rain" line. Five bands, because a dose-response
# with fewer cannot distinguish a monotone effect from a single noisy cell.
PRECIP_BAND_NAMES = ("precip_dry", "precip_trace", "precip_light",
                     "precip_moderate", "precip_heavy")
PRECIP_BAND_EDGES = {
    "precip_dry": "exactly 0.0 mm",
    "precip_trace": "0.0 < mm < 0.25",
    "precip_light": "0.25 <= mm < 1.0",
    "precip_moderate": "1.0 <= mm < 2.5",
    "precip_heavy": "mm >= 2.5",
}
PRECIP_THRESHOLDS = ((0.25, "precip_ge_0p25"), (1.0, "precip_ge_1p0"),
                     (2.5, "precip_ge_2p5"), (5.0, "precip_ge_5p0"))

# Wind bands in kph. 24 kph (~15 mph) is where the repo's own shipped rb_wind
# penalty already believes something happens, so the ladder is cut either side
# of it rather than on round numbers alone.
WIND_BAND_NAMES = ("wind_calm", "wind_light", "wind_moderate", "wind_strong",
                   "wind_extreme")
WIND_BAND_EDGES = {
    "wind_calm": "kph < 8",
    "wind_light": "8 <= kph < 16",
    "wind_moderate": "16 <= kph < 24",
    "wind_strong": "24 <= kph < 30",
    "wind_extreme": "kph >= 30",
}
WIND_THRESHOLDS = ((20.0, "wind_ge_20"), (24.0, "wind_ge_24"), (30.0, "wind_ge_30"))

# The primary stratum. Rain and wind travel together, so an unstratified rain
# coefficient is partly a wind coefficient wearing a different label; holding
# wind and temperature down is what stops that. The cost is severe and is the
# reason power must be computed on the stratified sample rather than the
# marginal one: on the committed corpus the stratum keeps 600 of 874 games and
# leaves 18 at the 1.0 mm threshold, not 34.
STRATUM_MAX_WIND_KPH = 20.0
STRATUM_MIN_TEMP_C = 5.0
STRATUM_NAME = "stratum"
STRATUM_RULE = ("wind < %g kph and temp > %g C" % (STRATUM_MAX_WIND_KPH,
                                                   STRATUM_MIN_TEMP_C))
STRATUM_THRESHOLDS = ((1.0, "stratum_precip_ge_1p0"), (2.5, "stratum_precip_ge_2p5"))

TOTAL_NAME = "total"

#: Every condition condition_counts() pre-seeds, in report order.
CONDITIONS = (
    (TOTAL_NAME,)
    + PRECIP_BAND_NAMES
    + tuple(name for _, name in PRECIP_THRESHOLDS)
    + WIND_BAND_NAMES
    + tuple(name for _, name in WIND_THRESHOLDS)
    + (STRATUM_NAME,)
    + tuple(name for _, name in STRATUM_THRESHOLDS)
)

ROOF_CHECK_NOTE = "all survivors outdoors"

CORPUS_LIMITS = (
    "precip_mm is ONE Open-Meteo hourly value at the kickoff hour and, by that "
    "API's convention, the sum over the PRECEDING hour - so it is roughly the "
    "rain before kickoff, not the rain during the game. A steady three-hour "
    "downpour and a wet hour that then cleared are indistinguishable here, and "
    "both attenuate a true effect toward zero.",
    "Snow is invisible. The builder never requests snowfall, so snow enters "
    "precip_mm only as liquid-water equivalent at roughly a tenth of its depth: "
    "the coldest and windiest game in the corpus, 2022|16|CLE|NO at -14.5 C and "
    "43.5 kph, records precip_mm 0.0. Any wet-game classifier built on this "
    "field silently excludes the games a fan would call the worst weather of "
    "the decade.",
    "The venue filter is the neutral flag, which marks a game played away from "
    "the nominal home stadium. It does not mark a game played at the right "
    "stadium under a roof that behaved unusually, and it cannot: the archive "
    "carries no roof STATE, only the venue's roof TYPE.",
    "Retractable roofs that were open at kickoff are reported in their own "
    "bucket and never pooled with outdoors, because the decision to open a roof "
    "is itself a weather decision and pooling would import that selection.",
    "The corpus is five seasons of open-roof home games. Nothing measured on it "
    "generalises to a venue it does not contain, and eight stadiums supply about "
    "three quarters of the windy games.",
)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def _load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def game_key(season, week, home, away):
    """The one join key the whole repo uses: "{season}|{week}|{home}|{away}"."""
    return "%d|%d|%s|%s" % (int(season), int(week), home, away)


def meta_index(games_meta_doc):
    """games_meta rows -> {key: {allow-listed column: value}}.

    Zipped by the document's own `fields` header, never by position, and
    projected through META_ALLOW. Team codes are taken as written: the corpus,
    games_meta and game_context all come from the same upstream release and
    join at 893/893 without normalisation, so a normaliser here would only be
    able to hide a real join failure. An unjoined row is reported instead.
    """
    fields = list(games_meta_doc["fields"])
    idx = {name: i for i, name in enumerate(fields)}
    for name in META_ALLOW:
        if name not in idx:
            raise KeyError("games_meta is missing the allow-listed column %r; "
                           "the corpus cannot be venue-verified without it" % name)
    out = {}
    for raw in games_meta_doc["games"]:
        rec = {name: raw[idx[name]] for name in META_ALLOW}
        rec["season"] = int(rec["season"])
        rec["week"] = int(rec["week"])
        rec["neutral"] = bool(rec["neutral"])
        out[game_key(rec["season"], rec["week"], rec["home"], rec["away"])] = rec
    return out


def load_corpus(weather_doc=None, games_meta_doc=None,
                weather_path=WEATHER_PATH, games_meta_path=GAMES_META_PATH):
    """Read data/weather_history.json and join every key to games_meta.

    Returns a corpus dict:

      rows          {key: row} for every JOINED row, relocations included -
                    filtering is venue_verified()'s job, not this one's
      rows_read     rows in the weather file
      rows_joined   rows that found a games_meta row
      unjoined      keys that did not, sorted (a join failure is reported, not
                    swallowed: a silently dropped row is a silently shrunk n)
      source        the weather file's own source string
      seasons       the seasons actually present, sorted

    Passing weather_doc / games_meta_doc in lets the selftest run on the
    committed fixture without touching data/.
    """
    if weather_doc is None:
        weather_doc = _load_json(weather_path)
    if games_meta_doc is None:
        games_meta_doc = _load_json(games_meta_path)
    meta = meta_index(games_meta_doc)
    games = weather_doc.get("games") or {}

    rows, unjoined = {}, []
    for key, obs in games.items():
        rec = meta.get(key)
        if rec is None:
            unjoined.append(key)
            continue
        rows[key] = {
            "key": key,
            "season": rec["season"],
            "week": rec["week"],
            "home": rec["home"],
            "away": rec["away"],
            "stadium": rec["stadium"],
            "neutral": rec["neutral"],
            "meta_roof": rec["roof"],
            "precip_mm": float(obs["precip_mm"]),
            "temp_c": float(obs["temp_c"]),
            "wind_kph": float(obs["wind_kph"]),
        }
    return {
        "rows": rows,
        "rows_read": len(games),
        "rows_joined": len(rows),
        "unjoined": tuple(sorted(unjoined)),
        "source": weather_doc.get("source", ""),
        "seasons": tuple(sorted({r["season"] for r in rows.values()})),
    }


# ---------------------------------------------------------------------------
# The venue filter - in the reader, never on disk
# ---------------------------------------------------------------------------

def venue_verified(corpus):
    """Drop the rows whose games_meta neutral flag is set.

    A neutral-site game was not played at the venue whose weather the archive
    recorded, so its observation describes a stadium nobody was in. Returns a
    corpus-shaped dict with `rows` narrowed, `dropped` naming exactly what went
    and why, and the read/joined counts carried through unchanged so the
    arithmetic stays auditable end to end.
    """
    kept, dropped = {}, []
    for key, row in corpus["rows"].items():
        if row["neutral"]:
            dropped.append(key)
        else:
            kept[key] = row
    return {
        "rows": kept,
        "rows_read": corpus["rows_read"],
        "rows_joined": corpus["rows_joined"],
        "unjoined": corpus["unjoined"],
        "dropped": tuple(sorted(dropped)),
        "rows_kept": len(kept),
        "source": corpus.get("source", ""),
        "seasons": tuple(sorted({r["season"] for r in kept.values()})),
    }


def corpus_sha256(path=WEATHER_PATH):
    """sha256 of the weather archive as it sits on disk.

    Exists so a caller can prove the claim this module makes about itself: the
    filter is a reader concern and the file is never rewritten. Same value
    before and after a full measurement run, or the claim is false.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Roof state - the independent check, and the placebo sample
# ---------------------------------------------------------------------------

def load_game_context(path=GAME_CONTEXT_PATH, doc=None):
    """{key: {roof, game_type, neutral_site}} from data/game_context.json."""
    if doc is None:
        doc = _load_json(path)
    out = {}
    for key, rec in (doc.get("games") or {}).items():
        out[key] = {"roof": rec.get("roof"),
                    "game_type": rec.get("game_type"),
                    "neutral_site": bool(rec.get("neutral_site"))}
    return out


def roof_state(context=None, context_doc=None, meta=None, seasons=SEASONS,
               game_type=GAME_TYPE, context_path=GAME_CONTEXT_PATH,
               games_meta_path=GAMES_META_PATH):
    """Classify every venue-verified REG game of `seasons` by nflverse roof.

    `context` is a {key: {...}} mapping from load_game_context, `context_doc` a
    raw game_context document, `meta` a {key: {...}} mapping from meta_index -
    all three optional, all three there so the selftest can run on the fixture.
    The neutral flag still comes from games_meta, so the same row is excluded
    here and by venue_verified() - two filters that disagreed would put a
    relocation in the treated set on one path and out of it on the other.

    Returns the classification. Key sets are tuples of game keys; counts are
    reported in games AND in team-games, because the analysis unit downstream
    is the team-game and a census in the wrong unit is the easiest way to
    quote a number that is off by exactly two.
    """
    if context is None:
        context = load_game_context(path=context_path, doc=context_doc)
    if meta is None:
        meta = meta_index(_load_json(games_meta_path))

    wanted = set(int(s) for s in seasons)
    buckets = {"treated": [], "placebo": [], "open": [], "unknown": []}
    dropped_neutral = []
    for key, rec in context.items():
        season = int(key.split("|", 1)[0])
        if season not in wanted or rec.get("game_type") != game_type:
            continue
        m = meta.get(key)
        neutral = m["neutral"] if m is not None else rec.get("neutral_site", False)
        if neutral:
            dropped_neutral.append(key)
            continue
        roof = rec.get("roof")
        if roof in ROOF_TREATED:
            buckets["treated"].append(key)
        elif roof in ROOF_PLACEBO:
            buckets["placebo"].append(key)
        elif roof in ROOF_REPORTED_ONLY:
            buckets["open"].append(key)
        else:
            buckets["unknown"].append(key)

    state = {name: tuple(sorted(keys)) for name, keys in buckets.items()}
    state["dropped_neutral"] = tuple(sorted(dropped_neutral))
    state["seasons"] = tuple(sorted(wanted))
    state["game_type"] = game_type
    state["games"] = {name: len(state[name])
                      for name in ("treated", "placebo", "open", "unknown")}
    state["team_games"] = {name: 2 * n for name, n in state["games"].items()}
    return state


def roof_census(state=None, **kwargs):
    """The JSON-safe roof block for the artifact: counts, no key lists."""
    if state is None:
        state = roof_state(**kwargs)
    return {
        "seasons": list(state["seasons"]),
        "game_type": state["game_type"],
        "vocabulary": {"treated": list(ROOF_TREATED),
                       "placebo": list(ROOF_PLACEBO),
                       "reported_only": list(ROOF_REPORTED_ONLY)},
        "games": dict(state["games"]),
        "team_games": dict(state["team_games"]),
        "dropped_neutral": len(state["dropped_neutral"]),
        "pooling_rule": ("'open' is a retractable roof that was open at kickoff: "
                         "reported in its own bucket and never pooled with "
                         "outdoors, because opening a roof is itself a weather "
                         "decision"),
    }


def roof_audit(keys, context=None, context_doc=None, expected=ROOF_TREATED,
               context_path=GAME_CONTEXT_PATH):
    """Check that every key in `keys` reads an expected roof in game_context.

    The filter is the neutral flag; this is the SECOND, independent column
    saying the filter was right. Offenders are named (key -> the roof actually
    found, or None when the key is absent) rather than counted, because the
    only useful response to a disagreement is to go and look at the game.
    """
    if context is None:
        context = load_game_context(path=context_path, doc=context_doc)
    # Materialised up front: callers hand this a dict_keys view or a generator,
    # and `checked` has to count what was actually looked at.
    keys = list(keys)
    offenders = {}
    for key in keys:
        rec = context.get(key)
        roof = rec.get("roof") if rec is not None else None
        if roof not in expected:
            offenders[key] = roof
    return {
        "checked": len(keys),
        "expected": list(expected),
        "offenders": offenders,
        "ok": not offenders,
        "note": ROOF_CHECK_NOTE if not offenders else
                "%d survivor(s) are not %s" % (len(offenders), "/".join(expected)),
    }


# ---------------------------------------------------------------------------
# Conditions
# ---------------------------------------------------------------------------

def precip_band(mm):
    """Which of the five pre-registered precipitation bands `mm` falls in.

    `mm <= 0.0` rather than `== 0.0` so a float that round-trips through JSON
    as a negative zero still reads dry; the archive's schema floors it at 0.
    """
    if mm <= 0.0:
        return "precip_dry"
    if mm < 0.25:
        return "precip_trace"
    if mm < 1.0:
        return "precip_light"
    if mm < 2.5:
        return "precip_moderate"
    return "precip_heavy"


def wind_band(kph):
    """Which of the five pre-registered wind bands `kph` falls in."""
    if kph < 8.0:
        return "wind_calm"
    if kph < 16.0:
        return "wind_light"
    if kph < 24.0:
        return "wind_moderate"
    if kph < 30.0:
        return "wind_strong"
    return "wind_extreme"


def in_stratum(row):
    """The primary stratum: low wind and not cold, so a rain coefficient is
    not a wind coefficient under another name."""
    return (row["wind_kph"] < STRATUM_MAX_WIND_KPH
            and row["temp_c"] > STRATUM_MIN_TEMP_C)


def conditions_for(row):
    """Every pre-registered condition `row` satisfies, TOTAL_NAME included."""
    fired = [TOTAL_NAME, precip_band(row["precip_mm"]), wind_band(row["wind_kph"])]
    for cut, name in PRECIP_THRESHOLDS:
        if row["precip_mm"] >= cut:
            fired.append(name)
    for cut, name in WIND_THRESHOLDS:
        if row["wind_kph"] >= cut:
            fired.append(name)
    if in_stratum(row):
        fired.append(STRATUM_NAME)
        for cut, name in STRATUM_THRESHOLDS:
            if row["precip_mm"] >= cut:
                fired.append(name)
    return tuple(fired)


def condition_counts(rows, seasons=SEASONS, unit="game"):
    """{condition: {season: n}} over the SCORED units.

    `rows` is a venue-verified {key: row} mapping (or any iterable of rows).
    Every condition in CONDITIONS is pre-seeded for every season in `seasons`
    at 0, so a band that never fired reads 0 rather than being absent - the
    difference between "measured, none" and "not looked at".

    `unit` is 'game' (one corpus row is one game) or 'team_game' (each game
    contributes its two teams). Season keys are strings because this block goes
    straight into a JSON artifact.
    """
    if unit not in ("game", "team_game"):
        raise ValueError("unit must be 'game' or 'team_game', not %r" % (unit,))
    per_row = 1 if unit == "game" else 2
    values = rows.values() if hasattr(rows, "values") else rows

    out = {cond: {str(int(s)): 0 for s in seasons} for cond in CONDITIONS}
    for row in values:
        season = str(int(row["season"]))
        for cond in conditions_for(row):
            bucket = out[cond]
            if season not in bucket:
                # A season outside the pre-seeded list is COUNTED, never
                # dropped: an unexpected season is news, not noise.
                bucket[season] = 0
            bucket[season] += per_row
    return out


def condition_totals(counts):
    """{condition: n} summed across seasons - the headline row of a census."""
    return {cond: sum(by_season.values()) for cond, by_season in counts.items()}


# ---------------------------------------------------------------------------
# The artifact block
# ---------------------------------------------------------------------------

def corpus_filter_report(verified, audit):
    """The `corpus_filter` block: read, joined, dropped, kept, roof check.

    Five numbers that have to add up in public. rows_read - unjoined =
    rows_joined; rows_joined - dropped_relocations = rows_kept. A reader who
    cannot reproduce that arithmetic from the block alone should not trust
    anything built on it.
    """
    return {
        "source": verified.get("source", ""),
        "rows_read": verified["rows_read"],
        "rows_joined": verified["rows_joined"],
        "rows_unjoined": len(verified["unjoined"]),
        "dropped_relocations": len(verified["dropped"]),
        "rows_kept": verified["rows_kept"],
        "roof_check": audit["note"],
        "roof_check_ok": bool(audit["ok"]),
        "rule": ("the neutral flag in %s drops relocations; %s is never "
                 "rewritten, refiltered or refetched" % (GAMES_META_REL, WEATHER_REL)),
    }


def report(weather_path=WEATHER_PATH, games_meta_path=GAMES_META_PATH,
           context_path=GAME_CONTEXT_PATH, unit="game"):
    """Everything this module knows about the committed corpus, read-only."""
    games_meta_doc = _load_json(games_meta_path)
    meta = meta_index(games_meta_doc)
    corpus = load_corpus(weather_path=weather_path, games_meta_doc=games_meta_doc)
    verified = venue_verified(corpus)
    context = load_game_context(context_path)
    audit = roof_audit(verified["rows"].keys(), context=context)
    state = roof_state(context=context, meta=meta)
    return {
        "corpus_filter": corpus_filter_report(verified, audit),
        "roof_census": roof_census(state),
        "conditions": condition_counts(verified["rows"], unit=unit),
        "conditions_unit": unit,
        "stratum_rule": STRATUM_RULE,
        "weather_history_sha256": corpus_sha256(weather_path),
        "limits": list(CORPUS_LIMITS),
    }


# ---------------------------------------------------------------------------
# Selftest
# ---------------------------------------------------------------------------

def _fixture(path=FIXTURE_PATH):
    doc = _load_json(path)
    return doc["weather_history"], doc["games_meta"], doc["game_context"]


def selftest():
    weather, games_meta, context_doc = _fixture()

    # --- the join reports what it could not do ------------------------------
    corpus = load_corpus(weather_doc=weather, games_meta_doc=games_meta)
    assert corpus["rows_read"] == 10, corpus["rows_read"]
    assert corpus["rows_joined"] == 9, corpus["rows_joined"]
    assert corpus["unjoined"] == ("2025|9|ZZZ|AAA",), corpus["unjoined"]
    assert "2025|9|ZZZ|AAA" not in corpus["rows"], "an unjoined row must not be measured"

    # --- the allow-list is a wall, not a preference -------------------------
    # The fixture's games_meta carries a column outside META_ALLOW and lists its
    # columns in an order unlike the real file: a row that came back with the
    # extra column would mean the reader copies whatever it is handed, and a
    # row with the wrong season would mean it zips by position.
    row = corpus["rows"]["2024|4|BBB|CCC"]
    assert set(row) == set(ROW_FIELDS), sorted(set(row) ^ set(ROW_FIELDS))
    assert (row["season"], row["week"], row["home"], row["away"]) == (2024, 4, "BBB", "CCC"), row
    assert row["stadium"] == "Bravo Field" and row["meta_roof"] == "outdoors", row
    assert (row["precip_mm"], row["temp_c"], row["wind_kph"]) == (1.5, 6.0, 22.0), row

    # --- the venue filter ---------------------------------------------------
    verified = venue_verified(corpus)
    assert verified["dropped"] == ("2024|5|CCC|AAA",), verified["dropped"]
    assert verified["rows_kept"] == 8, verified["rows_kept"]
    # The arithmetic the report has to be able to show in public.
    assert verified["rows_read"] - len(verified["unjoined"]) == verified["rows_joined"]
    assert verified["rows_joined"] - len(verified["dropped"]) == verified["rows_kept"]
    # The planted relocation is the wettest and windiest row in the fixture, so
    # keeping it would move every condition count that matters. It is gone.
    assert "2024|5|CCC|AAA" not in verified["rows"]
    assert max(r["wind_kph"] for r in verified["rows"].values()) == 31.0

    # --- roof state ---------------------------------------------------------
    meta = meta_index(games_meta)
    state = roof_state(context_doc=context_doc, meta=meta, seasons=(2024, 2025))
    assert state["games"] == {"treated": 8, "placebo": 3, "open": 1, "unknown": 0}, state["games"]
    assert state["team_games"]["placebo"] == 6, state["team_games"]
    # The playoff game and the 2020 game are outside the census by construction.
    assert "2025|19|AAA|BBB" not in state["treated"], "REG only"
    assert "2020|1|AAA|BBB" not in state["treated"], "seasons only"
    # 'open' is never pooled with either arm.
    pooled = set(state["treated"]) | set(state["placebo"])
    assert not pooled & set(state["open"]), "an open retractable roof was pooled"
    assert set(state["placebo"]) == {"2025|3|DDD|AAA", "2025|4|EEE|AAA",
                                     "2025|6|GGG|AAA"}, state["placebo"]
    # Both filters agree: the treated set IS the venue-verified corpus.
    assert set(state["treated"]) == set(verified["rows"]), (
        sorted(set(state["treated"]) ^ set(verified["rows"])))

    # --- the roof check is a real check, not a formality --------------------
    audit = roof_audit(verified["rows"].keys(), context_doc=context_doc)
    assert audit["ok"] and audit["note"] == ROOF_CHECK_NOTE, audit
    poisoned = roof_audit(list(verified["rows"]) + ["2025|3|DDD|AAA"],
                          context_doc=context_doc)
    assert not poisoned["ok"] and poisoned["offenders"] == {"2025|3|DDD|AAA": "dome"}, poisoned
    absent = roof_audit(["2025|9|ZZZ|AAA"], context_doc=context_doc)
    assert absent["offenders"] == {"2025|9|ZZZ|AAA": None}, absent

    # --- bands: hand-worked, edge by edge -----------------------------------
    assert precip_band(0.0) == "precip_dry" and precip_band(0.0001) == "precip_trace"
    assert precip_band(0.25) == "precip_light", "0.25 is the light band's floor"
    assert precip_band(0.9999) == "precip_light" and precip_band(1.0) == "precip_moderate"
    assert precip_band(2.4999) == "precip_moderate" and precip_band(2.5) == "precip_heavy"
    assert wind_band(7.9) == "wind_calm" and wind_band(8.0) == "wind_light"
    assert wind_band(15.9) == "wind_light" and wind_band(16.0) == "wind_moderate"
    assert wind_band(23.9) == "wind_moderate" and wind_band(24.0) == "wind_strong"
    assert wind_band(29.9) == "wind_strong" and wind_band(30.0) == "wind_extreme"

    # --- the census, every number worked by hand from the fixture -----------
    counts = condition_counts(verified["rows"], seasons=(2024, 2025))
    expect = {
        "total": {"2024": 6, "2025": 2},
        "precip_dry": {"2024": 1, "2025": 1},
        "precip_trace": {"2024": 1, "2025": 0},
        "precip_light": {"2024": 1, "2025": 0},
        "precip_moderate": {"2024": 2, "2025": 0},
        "precip_heavy": {"2024": 1, "2025": 1},
        "precip_ge_0p25": {"2024": 4, "2025": 1},
        "precip_ge_1p0": {"2024": 3, "2025": 1},
        "precip_ge_2p5": {"2024": 1, "2025": 1},
        "precip_ge_5p0": {"2024": 0, "2025": 1},
        "wind_calm": {"2024": 1, "2025": 1},
        "wind_light": {"2024": 2, "2025": 0},
        "wind_moderate": {"2024": 2, "2025": 0},
        "wind_strong": {"2024": 1, "2025": 0},
        "wind_extreme": {"2024": 0, "2025": 1},
        "wind_ge_20": {"2024": 2, "2025": 1},
        "wind_ge_24": {"2024": 1, "2025": 1},
        "wind_ge_30": {"2024": 0, "2025": 1},
        "stratum": {"2024": 4, "2025": 1},
        "stratum_precip_ge_1p0": {"2024": 1, "2025": 0},
        "stratum_precip_ge_2p5": {"2024": 0, "2025": 0},
    }
    assert set(counts) == set(CONDITIONS), sorted(set(counts) ^ set(CONDITIONS))
    assert counts == expect, {k: (counts[k], expect[k])
                              for k in expect if counts[k] != expect[k]}
    # The five precip bands and the five wind bands each partition the sample.
    for family in (PRECIP_BAND_NAMES, WIND_BAND_NAMES):
        for season in ("2024", "2025"):
            assert sum(counts[b][season] for b in family) == counts["total"][season], \
                (family, season)
    # Zero PRESENT, not missing: heavy rain inside the stratum never happens in
    # the fixture and must still read 0 for both seasons.
    assert counts["stratum_precip_ge_2p5"] == {"2024": 0, "2025": 0}

    # A season with no rows at all is pre-seeded at 0 across every condition.
    seeded = condition_counts(verified["rows"])
    assert set(seeded["total"]) == {str(s) for s in SEASONS}, sorted(seeded["total"])
    assert seeded["total"]["2021"] == 0 and seeded["precip_heavy"]["2021"] == 0, seeded["total"]
    # A season outside the pre-seeded list is counted, never dropped.
    narrow = condition_counts(verified["rows"], seasons=(2024,))
    assert narrow["total"] == {"2024": 6, "2025": 2}, narrow["total"]

    # --- the unit really is a unit -----------------------------------------
    tg = condition_counts(verified["rows"], seasons=(2024, 2025), unit="team_game")
    assert tg["total"] == {"2024": 12, "2025": 4}, tg["total"]
    assert condition_totals(tg)["precip_ge_1p0"] == 8, condition_totals(tg)

    # --- the artifact block -------------------------------------------------
    block = corpus_filter_report(verified, audit)
    assert block["rows_read"] == 10 and block["rows_joined"] == 9, block
    assert block["dropped_relocations"] == 1 and block["rows_kept"] == 8, block
    assert block["roof_check"] == ROOF_CHECK_NOTE and block["roof_check_ok"] is True, block

    # --- nothing here writes; the archive is byte-identical -----------------
    disk = os.path.exists(WEATHER_PATH)
    before = corpus_sha256(WEATHER_PATH) if disk else None

    real_note = "fixture only (data/ not present)"
    if disk and os.path.exists(GAMES_META_PATH) and os.path.exists(GAME_CONTEXT_PATH):
        # PROPERTIES on the committed corpus, never literal counts: a games_meta
        # refresh from daily.yml may legitimately move every one of these
        # numbers, and a test that pinned 874 would red on a correct refresh.
        real = load_corpus()
        real_v = venue_verified(real)
        assert real["unjoined"] == (), real["unjoined"][:5]
        assert real_v["rows_kept"] < real["rows_read"], "the filter dropped nothing"
        assert len(real_v["dropped"]) >= 1, "no relocation found - filter is inert"
        real_audit = roof_audit(real_v["rows"].keys())
        assert real_audit["ok"], sorted(real_audit["offenders"].items())[:5]
        real_state = roof_state()
        assert set(real_state["treated"]) == set(real_v["rows"]), (
            sorted(set(real_state["treated"]) ^ set(real_v["rows"]))[:5])
        assert real_state["team_games"]["placebo"] > 800, real_state["team_games"]
        placebo_audit = roof_audit(real_state["placebo"], expected=ROOF_PLACEBO)
        assert placebo_audit["ok"], sorted(placebo_audit["offenders"].items())[:5]
        real_counts = condition_counts(real_v["rows"])
        assert set(real_counts) == set(CONDITIONS)
        assert sum(real_counts["total"].values()) == real_v["rows_kept"]
        for family in (PRECIP_BAND_NAMES, WIND_BAND_NAMES):
            assert (sum(condition_totals(real_counts)[b] for b in family)
                    == real_v["rows_kept"]), family
        real_note = ("committed corpus: %d read, %d joined, %d relocations "
                     "dropped, %d kept, every survivor outdoors"
                     % (real["rows_read"], real["rows_joined"],
                        len(real_v["dropped"]), real_v["rows_kept"]))
        assert corpus_sha256(WEATHER_PATH) == before, (
            "data/weather_history.json changed during a read-only run")

    print("selftest OK: the venue filter lives in the reader - an unjoined row "
          "is reported not swallowed, the planted relocation is dropped while "
          "the archive's sha256 is unchanged, both roof columns agree that the "
          "treated set is exactly the venue-verified corpus, an open "
          "retractable roof is reported and never pooled, the five precip and "
          "five wind bands each partition the sample at hand-worked edges, and "
          "a band that never fired reads 0 rather than being absent (%s)"
          % real_note)


# ---------------------------------------------------------------------------
# CLI - read-only. This module has no build path and writes nothing, ever.
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--selftest", action="store_true",
                        help="offline, fixture-driven; writes nothing")
    parser.add_argument("--report", action="store_true",
                        help="print the committed corpus's filter block, roof "
                             "census and condition counts as one JSON line")
    parser.add_argument("--unit", choices=("game", "team_game"), default="game")
    args = parser.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    if args.report:
        print(json.dumps(report(unit=args.unit), ensure_ascii=True, sort_keys=True))
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
