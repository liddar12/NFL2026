"""ONE canonical player-availability vocabulary for every feed and every consumer.

Rel17. Before this module the pipeline had three private, disagreeing vocabularies:
ESPN's site-API strings ("Active", "Injured Reserve", "Suspension"), ESPN's fantasy-API
strings ("injury_reserve", "day_to_day"), and nflverse's report statuses
("Out"/"Doubtful"/"Questionable") -- and the one consumer that mattered,
`build_weekly.INJURY_MULT`, silently multiplied everything it did not recognise by 1.0.
That is how 11 players who cannot take a snap in 2026 projected as fully healthy.

  ACTIVE  QUESTIONABLE  DOUBTFUL  OUT  IR  PUP  NFI  SUSPENDED

TWO MECHANIC CLASSES, deliberately separated -- conflating them was the defect:

  week   QUESTIONABLE / DOUBTFUL / OUT
         Short-term news. Shapes the near-term weeks and RENORMALIZES, so the season
         total is preserved exactly. This is the pre-Rel17 behaviour and it is CORRECT
         for its case: a questionable player is still going to play ~17 games.

  season IR / PUP / NFI / SUSPENDED, or ANY code carrying an unambiguous parsed
         duration. Long-term absence. The blocked weeks are zeroed and EXCLUDED from
         the renormalization, so the season total ACTUALLY DROPS. A player who will
         not play again this year must not carry 100% of his season points.

CLASS IS DATA, NOT A LOOKUP. An ESPN `Out` whose own report text says season-ending is
promoted to the season class -- that is not hypothetical, it fires on three real rows
in today's feed (ATL DeAngelo Malone, NO Keeshawn Silver, TB Chase Lucas).

`normalize_status` returns None for a spelling it does not know. NONE MEANS WE DO NOT
KNOW; callers MUST NOT read it as ACTIVE. Loudness is split on purpose:

  * LOUD at the scraper boundary -- `espn.fetch_injuries` raises FeedError naming the
    unmapped value, exactly as `_team_abbrev` does for a drifted team abbreviation. A
    drifted availability string mis-attributes a fact the same way.
  * LOUD at the gate -- tests/smoke.sh asserts every status in the committed
    data/injuries.json normalizes. This is the single check that stops the bug class.
  * GRACEFUL in the consumer -- `build_weekly` is graceful BY CONTRACT (a missing
    injuries feed means "shape nothing", never "everyone is healthy"), so None there
    means no shaping AND no unavailability. The degradation stays visible upstream.

Stdlib only, pure, no I/O, no network. `--selftest`.
"""

import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.injury_duration import parse_duration  # noqa: E402

VOCAB_VERSION = 1

ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED = (
    "ACTIVE", "QUESTIONABLE", "DOUBTFUL", "OUT", "IR", "PUP", "NFI", "SUSPENDED")
CODES = (ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED)

WEEK_CLASS = frozenset({QUESTIONABLE, DOUBTFUL, OUT})
SEASON_CLASS = frozenset({IR, PUP, NFI, SUSPENDED})

# The NFL's own floor, applied as a FLOOR and never as a measurement: a player placed
# on in-season injured reserve must miss at least four games before he is eligible to
# return, and regular-season PUP/NFI likewise requires missing the first four. It is an
# external, documented league rule -- so a row that falls to it is stamped
# confidence="rule" and the UI says "at least 4", never "4".
#
# SUSPENDED has no such rule minimum, so a suspension of unstated length blocks NOTHING
# and is flagged only. Honest data beats a convenient guess.
MIN_WEEKS_OUT = 4

# Severity, worst last. Used when one player carries several report rows.
_SEVERITY = {ACTIVE: 0, QUESTIONABLE: 1, DOUBTFUL: 2, OUT: 3,
             SUSPENDED: 4, NFI: 5, PUP: 6, IR: 7}

# Keys are lower-cased and whitespace-collapsed. Every spelling below is either
# OBSERVED in a real feed or is that feed's documented value.
_MAP = {
    # --- espn_injuries (ESPN site API -> data/injuries.json). The first five are the
    #     only spellings present in today's 800 rows; PUP/NFI are ESPN's documented
    #     designations, mapped and ready but so far unfired.
    "active": ACTIVE,
    "questionable": QUESTIONABLE,
    "doubtful": DOUBTFUL,
    "out": OUT,
    "injured reserve": IR,
    "suspension": SUSPENDED,
    "physically unable to perform": PUP,
    "non-football injury": NFI,
    # --- espn_kona (fantasy API -> espn_players.injury_status, already lower-cased)
    "injury_reserve": IR,
    "day_to_day": QUESTIONABLE,
    "probable": ACTIVE,
    # --- nflverse injuries release (report_status) emits Out/Doubtful/Questionable
    #     only -- already covered above.
    # --- forward-compatible short spellings
    "ir": IR,
    "pup": PUP,
    "nfi": NFI,
    "suspended": SUSPENDED,
}


def normalize_status(raw):
    """Canonical code for a raw feed status, or None when the spelling is unknown.

    None means WE DO NOT KNOW. It is NOT ACTIVE and must never be treated as such.
    """
    if raw is None:
        return None
    key = " ".join(str(raw).strip().lower().split())
    if not key:
        return None
    if key in CODES or key.upper() in CODES:
        return key.upper()
    return _MAP.get(key)


def status_class(code):
    """'week' | 'season' | None for a canonical code (ACTIVE is a no-op -> None)."""
    if code in SEASON_CLASS:
        return "season"
    if code in WEEK_CLASS:
        return "week"
    return None


def norm_name(name):
    """Casefold + strip periods so 'A.J. Brown' joins 'AJ Brown'.

    Identical semantics to build_weekly._norm_name, which imports this so the join key
    has exactly one definition.
    """
    return " ".join(str(name or "").replace(".", "").lower().split())


def enrich(row):
    """One data/injuries.json row -> the same row plus the Rel17 availability fields.

    `status` is carried through BYTE-IDENTICALLY on purpose: injuries.json records what
    the report SAID, and build_weekly.INJURY_MULT's three verbatim keys (and the test
    that locks that table exactly) must survive untouched. The canonical reading rides
    alongside it in `availability`.

    `confidence` here is "explicit" or None ONLY. The MIN_WEEKS_OUT floor is applied by
    build_weekly, not by the feed, because how many weeks it blocks depends on the
    schedule -- so the "rule" confidence surfaces on player_weekly.json. injuries.json
    records what the report said; player_weekly.json records what we did about it.
    """
    code = normalize_status(row.get("status"))
    cls = status_class(code)
    dur = parse_duration(row.get("detail"), status=code)
    if dur and cls != "season":
        # PROMOTION: an OUT whose own text states a season-ending or N-week absence is
        # a long-term absence wearing a short-term label. Fires on 3 real rows today.
        cls = "season"
    return {
        "team": row.get("team"),
        "player": row.get("player"),
        "status": row.get("status"),
        "availability": code,
        "availability_class": cls,
        "weeks_out": dur["weeks_out"] if dur else None,
        "out_for_season": bool(dur["out_for_season"]) if dur else False,
        "confidence": dur["confidence"] if dur else None,
        "evidence": dur["evidence"] if dur else None,
        "detail": row.get("detail"),
    }


def counts(rows):
    """{canonical code: n} over enriched-or-raw rows, in CODES order. Unmapped rows
    are counted under the key "UNMAPPED" so a drift is visible in the document, never
    silently folded into ACTIVE."""
    tally = {}
    for row in rows or []:
        code = row.get("availability") if "availability" in row else \
            normalize_status(row.get("status"))
        tally[code or "UNMAPPED"] = tally.get(code or "UNMAPPED", 0) + 1
    ordered = {c: tally[c] for c in CODES if c in tally}
    if "UNMAPPED" in tally:
        ordered["UNMAPPED"] = tally["UNMAPPED"]
    return ordered


def enrich_document(doc):
    """A whole data/injuries.json document -> the Rel17 shape. Pure, offline.

    Key order matches the contract: updated_utc, source, vocab_version, counts,
    injuries.
    """
    rows = [enrich(r) for r in (doc.get("injuries") or [])]
    return {
        "updated_utc": doc.get("updated_utc"),
        "source": doc.get("source"),
        "vocab_version": VOCAB_VERSION,
        "counts": counts(rows),
        "injuries": rows,
    }


def _avail_fields(row):
    """The availability view of a row, enriching on the fly if the file predates it.

    A row that already carries the fields is TRUSTED (the file is the record); a row
    that does not is enriched deterministically, so build_weekly keeps working against
    an injuries.json written by an older pipeline.
    """
    return row if "availability" in row else enrich(row)


def _worse(a, b):
    """The worse of two availability views. out_for_season beats any count; then the
    larger weeks_out; then the more severe status."""
    if a is None:
        return b
    for x, y in ((a, b), (b, a)):
        if x["out_for_season"] and not y["out_for_season"]:
            return x
    ax, bx = a.get("weeks_out") or 0, b.get("weeks_out") or 0
    if ax != bx:
        return a if ax > bx else b
    return a if _SEVERITY.get(a["availability"], -1) >= \
        _SEVERITY.get(b["availability"], -1) else b


def index_report(injuries):
    """{(team, norm_name(player)): availability view} over injury rows.

    Rows whose status does not normalize are DROPPED -- unknown is not a discount, and
    the loud complaint about the drift belongs at the scraper and at the gate, not in a
    silent consumer. On duplicate rows the WORST wins.
    """
    out = {}
    for row in injuries or []:
        view = _avail_fields(row)
        if not view.get("availability"):
            continue
        key = (view.get("team"), norm_name(view.get("player")))
        out[key] = _worse(out.get(key), view)
    return out


def apply_to_records(records, index):
    """Stamp the canonical `injury_status` onto player records IN PLACE.

    `records` are espn_players.build_player_records rows ({team, name, ...}); they
    already carry ESPN's *fantasy*-API injury_status, which is a different vocabulary
    with different coverage. The site-API injury report is the feed that has the free
    text, so where it has an opinion it wins.

    Returns the number of records overridden. A record with no matching report row is
    left exactly as it was -- absence of a report is not evidence of health, and
    fabricating ACTIVE here would be the honest-data violation this release removes.
    """
    n = 0
    for rec in records or []:
        view = index.get((rec.get("team"), norm_name(rec.get("name"))))
        if not view:
            continue
        code = view["availability"]
        if rec.get("injury_status") != code:
            rec["injury_status"] = code
            n += 1
    return n


# ----------------------------------------------------------------------------------
# selftest
# ----------------------------------------------------------------------------------

def selftest():
    # --- vocabulary ---------------------------------------------------------------
    assert len(CODES) == 8 and len(set(CODES)) == 8, CODES
    assert WEEK_CLASS | SEASON_CLASS | {ACTIVE} == set(CODES)
    assert not (WEEK_CLASS & SEASON_CLASS), "a code cannot be both mechanics"
    for code in CODES:
        assert normalize_status(code) == code, code
        assert normalize_status(code.lower()) == code, code

    # Every real spelling in every real feed.
    assert normalize_status("Active") == ACTIVE
    assert normalize_status("Questionable") == QUESTIONABLE
    assert normalize_status("Doubtful") == DOUBTFUL
    assert normalize_status("Out") == OUT
    assert normalize_status("Injured Reserve") == IR
    assert normalize_status("  injured   reserve ") == IR      # whitespace-collapsed
    assert normalize_status("Suspension") == SUSPENDED
    assert normalize_status("Physically Unable to Perform") == PUP
    assert normalize_status("Non-Football Injury") == NFI
    assert normalize_status("injury_reserve") == IR            # espn kona
    assert normalize_status("day_to_day") == QUESTIONABLE
    assert normalize_status("probable") == ACTIVE

    # UNKNOWN IS NOT ACTIVE. This assertion is the whole point of the module.
    for junk in (None, "", "   ", "Probable-ish", "Day-To-Day-ish", "PUPPY"):
        assert normalize_status(junk) is None, junk

    assert status_class(IR) == "season" and status_class(SUSPENDED) == "season"
    assert status_class(OUT) == "week" and status_class(QUESTIONABLE) == "week"
    assert status_class(ACTIVE) is None and status_class(None) is None

    assert norm_name("A.J. Brown") == norm_name("AJ  brown") == "aj brown"

    # --- enrich: the three real behaviours ----------------------------------------
    ir_null = enrich({"team": "SF", "player": "Ricky Pearsall",
                      "status": "Injured Reserve", "detail": "No timetable."})
    assert ir_null["status"] == "Injured Reserve", "raw status must ride through verbatim"
    assert ir_null["availability"] == IR
    assert ir_null["availability_class"] == "season"
    assert ir_null["weeks_out"] is None and ir_null["out_for_season"] is False
    assert ir_null["confidence"] is None and ir_null["evidence"] is None
    assert list(ir_null) == ["team", "player", "status", "availability",
                            "availability_class", "weeks_out", "out_for_season",
                            "confidence", "evidence", "detail"], list(ir_null)

    promoted = enrich({"team": "TB", "player": "Chase Lucas", "status": "Out",
                       "detail": "The cornerback will now spend the entirety of the "
                                 "2026 season on injured reserve unless he is waived "
                                 "with an injury settlement."})
    assert promoted["availability"] == OUT, "the raw code is still OUT"
    assert promoted["availability_class"] == "season", "text promotes the MECHANIC"
    assert promoted["out_for_season"] is True and promoted["confidence"] == "explicit"
    assert promoted["evidence"], "a promotion must be able to quote its source"

    week_only = enrich({"team": "KC", "player": "Some Guy", "status": "Questionable",
                        "detail": "He is out for the season."})
    assert week_only["availability_class"] == "week", "the status gate must hold"
    assert week_only["out_for_season"] is False and week_only["evidence"] is None

    unmapped = enrich({"team": "KC", "player": "X", "status": "Wobbly", "detail": None})
    assert unmapped["availability"] is None and unmapped["availability_class"] is None

    active = enrich({"team": "KC", "player": "Y", "status": "Active", "detail": None})
    assert active["availability"] == ACTIVE and active["availability_class"] is None

    # --- counts / document --------------------------------------------------------
    doc = enrich_document({"updated_utc": "T", "source": "espn", "injuries": [
        {"team": "KC", "player": "a", "status": "Active", "detail": None},
        {"team": "KC", "player": "b", "status": "Injured Reserve", "detail": None},
        {"team": "KC", "player": "c", "status": "Wobbly", "detail": None},
    ]})
    assert list(doc) == ["updated_utc", "source", "vocab_version", "counts", "injuries"]
    assert doc["vocab_version"] == VOCAB_VERSION
    assert doc["counts"] == {"ACTIVE": 1, "IR": 1, "UNMAPPED": 1}, doc["counts"]
    assert list(doc["counts"])[:2] == ["ACTIVE", "IR"], "counts follow CODES order"

    # --- index_report: worst wins, unmapped dropped -------------------------------
    idx = index_report([
        {"team": "SF", "player": "hurt guy", "status": "Questionable", "detail": None},
        {"team": "SF", "player": "Hurt Guy", "status": "Injured Reserve", "detail": None},
        {"team": "SF", "player": "Ghost", "status": "Wobbly", "detail": None},
    ])
    assert set(idx) == {("SF", "hurt guy")}, idx
    assert idx[("SF", "hurt guy")]["availability"] == IR, "worst status must win"

    idx2 = index_report([
        {"team": "NE", "player": "P", "status": "Out",
         "detail": "He is sidelined 3 weeks."},
        {"team": "NE", "player": "P", "status": "Out",
         "detail": "He will miss the rest of the season."},
    ])
    assert idx2[("NE", "p")]["out_for_season"] is True, "season-ending beats a count"

    idx3 = index_report([
        {"team": "NE", "player": "P", "status": "Out", "detail": "He is sidelined 2 weeks."},
        {"team": "NE", "player": "P", "status": "Out", "detail": "He is sidelined 6 weeks."},
    ])
    assert idx3[("NE", "p")]["weeks_out"] == 6, "the larger count must win"

    # --- apply_to_records ---------------------------------------------------------
    recs = [{"team": "SF", "name": "Hurt Guy", "injury_status": None},
            {"team": "SF", "name": "Fine Guy", "injury_status": "questionable"},
            {"team": "DAL", "name": "Hurt Guy", "injury_status": None}]
    n = apply_to_records(recs, idx)
    assert n == 1, n
    assert recs[0]["injury_status"] == IR
    assert recs[1]["injury_status"] == "questionable", "no report row => untouched"
    assert recs[2]["injury_status"] is None, "wrong team must not join"
    assert apply_to_records(recs, idx) == 0, "second pass is a no-op (idempotent)"

    print(f"selftest OK: {len(CODES)} canonical codes, {len(_MAP)} feed spellings "
          f"mapped, unknown stays unknown, MIN_WEEKS_OUT={MIN_WEEKS_OUT}")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    print(__doc__)
    sys.exit(0)
