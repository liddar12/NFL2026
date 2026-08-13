"""Conservative injury-DURATION parser: ESPN report free text -> structured absence.

Rel17 / F5. `scripts/scrape/espn.py:fetch_injuries` has always stored the report's
`longComment`/`shortComment` as `detail`, and NOTHING has ever read it. This module
reads it, and only ever emits a duration the report ACTUALLY STATED.

Pure, deterministic, stdlib-only (`re`). No network, no I/O. `--selftest`.

THE ACCEPTANCE BAR IS ZERO FALSE POSITIVES, NOT HIGH RECALL.
A fantasy manager who is told "out for the season" and then sees the player start in
week 3 has been lied to by his own tool. Recall is allowed to be low and is reported
honestly; a claimed duration that was never stated is a gate failure. So:

  * hedged text ("could miss", "no timetable", "reportedly", "6-12 months") -> None;
  * a RANGE is never averaged, never rounded, never taken at its low end -> None;
  * a sentence about last season, about a teammate, or about a parenthetical
    "(knee, ir)" third party -> None;
  * anything the rules do not recognise verbatim -> None.

None means WE DO NOT KNOW. Callers must not turn that into a number (see
scripts/availability.py: an IR player with no parsed duration falls to the
documented four-game league floor, stamped confidence="rule", never "explicit").

THE STATUS GATE IS LOAD-BEARING, not belt-and-braces. Run ungated over the real
800-row feed, `Active`/`Questionable` blurbs about LAST season or about a TEAMMATE
produce garbage durations (CeeDee Lamb "missing three games overall due to injury"
in 2025; Christian Kirk's blurb quoting "ricky pearsall (knee, ir) out for the
season"). Passing `status` kills all of them before a rule ever runs.
"""

import re
import sys

# Only these canonical statuses may carry a duration: the season classes plus OUT
# (an ESPN "Out" whose text says season-ending is promoted — that fires on three
# real rows today). Kept as raw strings so this module imports nothing.
PARSE_STATUSES = frozenset(["OUT", "IR", "PUP", "NFI", "SUSPENDED"])

MAX_WEEKS_OUT = 17   # an 18-week season with a bye; anything larger is a misparse
MIN_WEEKS_OUT_PARSED = 1

_WORD_NUM = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}
_NUM = r"(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})"

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_WS = re.compile(r"\s+")

# --- Veto 1: hedge. Any of these and the sentence states nothing. ------------------
_HEDGE = re.compile(
    r"\b(could|might|may|possibly|perhaps|likely|unlikely|hopes?|hoping|hopeful|"
    r"targeting|aiming|expects? to return|expected to return|report(?:s|ed|edly)?|"
    r"suggest\w*|estimate\w*|if he|questionable to|no timetable|timetable|unclear|"
    r"potentially|uncertain|believed|rumor\w*)\b"
)
# ...with ONE whitelist. An injury settlement is a release from the roster, not a
# return to it: "out for the season unless he reaches an injury settlement" is not a
# hedge about playing, it is a hedge about WHERE he is not playing. The conservative
# fantasy read is still "gone". Six real IR rows carry this clause.
_SETTLEMENT = re.compile(r"unless\b[^.]{0,80}?\bsettlement\b")

# --- Veto 2: range. "6-12 months", "2 to 4 weeks" -- never averaged, never taken. --
# SPELLED-OUT ranges count too: NFL beat reporting writes "two to four weeks" at
# least as often as "2-4 weeks", and a digits-only veto let those through R3, which
# then took the HIGH end of the range as if the report had stated one number.
_RANGE = re.compile(_NUM + r"\s*(?:-|–|to)\s*" + _NUM + r"\s*(?:week|month|game)s?")

# --- Veto 3a: a parenthetical injury tag means the sentence is about SOMEBODY ELSE.
_OTHER_SUBJECT = re.compile(
    r"\([a-z ]*?(?:knee|hamstring|ankle|shoulder|foot|calf|leg|arm|shin|back|hip|"
    r"groin|wrist|elbow|neck|concussion|toe|quad|illness|abdomen|ribs?|achilles|"
    r"acl|pup|ir)[a-z, ]*\)"
)
# --- Veto 3b: backward reference. NUMERIC rules only -- "out for the season" is a
# statement about now even in a sentence that mentions 2025, but "missed three games"
# in such a sentence is history, not a forecast.
_BACKWARD = re.compile(
    r"\b(?:last (?:year|season)|(?:20)(?:1\d|2[0-5])|to close out|final \d+|"
    r"the following|overall due to|previous(?:ly)? season|a year ago|career)\b"
)

# --- R1: season-ending. -> out_for_season, weeks_out stays None. ------------------
# The bounded [^.]{0,40}? / {0,30}? spans are what let "miss HIS ENTIRE ROOKIE season"
# and "miss THE ENTIRETY OF THE UPCOMING campaign" match. [^.] cannot cross a period,
# so the span can never stitch two clauses of different sentences together.
_SEASON_ENDING = [
    re.compile(
        r"\b(?:miss|missing|sit(?:ting)? out|spend|spending)\b[^.]{0,40}?"
        r"\b(?:entire|entirety of|rest of|remainder of|balance of|whole|duration of)\b"
        r"[^.]{0,30}?\b(?:season|campaign|year)\b"
    ),
    re.compile(r"\bseason is over\b"),
    re.compile(r"\bout for the (?:season|year)\b"),
    re.compile(r"\bseason[- ]ending\b"),
    re.compile(r"\bdone for the (?:season|year)\b"),
    re.compile(r"\bwill not play again (?:this|in) (?:season|year|\d{4})\b"),
]

# --- R2: explicit game count. --- R3: explicit week count. ------------------------
_GAME_COUNT = re.compile(
    r"\bmiss(?:ing|es)?\b[^.]{0,25}?\b(?:the\s+)?(?:first\s+)?" + _NUM +
    r"\s+(?:regular[- ]season\s+)?games?\b"
)
_WEEK_COUNT = re.compile(
    r"\b(?:out|sidelined|shelved|miss(?:ing|es)?)\b[^.]{0,25}?\b" + _NUM + r"[- ]weeks?\b"
)

# R4 (an explicit RETURN week / `returns_wk`) is deliberately NOT built: no mechanic
# and no surface consumes it, and emitting a field nothing backs and nothing reads is
# the exact shape of the F5 defect this module exists to fix.


def _to_int(token):
    """'three' | '3' -> 3, or None when out of the plausible 1..17 band."""
    n = _WORD_NUM.get(token)
    if n is None:
        try:
            n = int(token)
        except (TypeError, ValueError):
            return None
    if n < MIN_WEEKS_OUT_PARSED or n > MAX_WEEKS_OUT:
        return None
    return n


def sentences(detail):
    """Whitespace-collapsed sentences of `detail`, original case preserved.

    Case is preserved because the matched sentence is QUOTED verbatim to the user
    (Compare's evidence block); matching itself runs on the casefolded copy.
    """
    text = _WS.sub(" ", str(detail or "")).strip()
    if not text:
        return []
    return [s for s in _SENTENCE_SPLIT.split(text) if s]


def _hedged(low):
    """True if the sentence hedges, after stripping the settlement whitelist."""
    return bool(_HEDGE.search(_SETTLEMENT.sub(" ", low)))


def parse_duration(detail, status=None):
    """-> {"out_for_season", "weeks_out", "confidence", "evidence"} or None.

    `status` is a CANONICAL code (see scripts/availability.py). When given, the
    parser refuses to run outside PARSE_STATUSES — that gate is what keeps the
    real feed's Active/Questionable narrative blurbs from inventing durations.
    Passing status=None runs ungated and is for direct unit testing only.

    Sentences are evaluated independently and the FIRST match wins: R1
    (season-ending) then R2 (game count) then R3 (week count). `confidence` is
    always "explicit" — this function never returns a guessed number, so there is
    no other confidence it can report.
    """
    if status is not None and status not in PARSE_STATUSES:
        return None
    for raw in sentences(detail):
        low = raw.casefold()
        if _hedged(low) or _RANGE.search(low) or _OTHER_SUBJECT.search(low):
            continue
        for pat in _SEASON_ENDING:
            if pat.search(low):
                return {"out_for_season": True, "weeks_out": None,
                        "confidence": "explicit", "evidence": raw}
        if _BACKWARD.search(low):
            continue          # numeric rules only — R1 already had its chance
        for pat in (_GAME_COUNT, _WEEK_COUNT):
            m = pat.search(low)
            if m:
                n = _to_int(m.group(1))
                if n is not None:
                    return {"out_for_season": False, "weeks_out": n,
                            "confidence": "explicit", "evidence": raw}
    return None


# ----------------------------------------------------------------------------------
# selftest — fixtures are REAL sentences from the committed data/injuries.json.
# ----------------------------------------------------------------------------------

# ----------------------------------------------------------------------------------
# FIXTURES. Every string below is quoted VERBATIM from the committed
# data/injuries.json (whitespace-collapsed by `sentences`). Nothing here is invented:
# an acceptance bar of "zero false positives on the real corpus" is only meaningful
# if the corpus is the fixture. Regenerate with:
#   python3 -c "import json,sys; sys.path.insert(0,'.'); ..."  (see git history)
# ----------------------------------------------------------------------------------

# ALL 12 real positives in today's feed: 11 season-ending (R1) + 1 game count (R2).
# 8 are `Injured Reserve`, 3 are ESPN `Out` PROMOTED to the season class by their own
# text, 1 is the `Suspension`. Six of them carry the "unless ... injury settlement"
# clause that the hedge whitelist has to survive.
_POSITIVES = [
    ('OUT', 'ATL DeAngelo Malone',
     "Now that he's on the reserve/PUP, Malone will be required to miss the entire "
     "2026 season unless he reaches an injury settlement with the Falcons.",
     True, None),
    ('IR', 'CAR Chris Brazzell II',
     "Brazzell will officially miss his entire rookie season due to the LCL tear he "
     "suffered during Wednesday's training camp practice.",
     True, None),
    ('SUSPENDED', 'CHI Beanie Bishop Jr.',
     "The cornerback is set to miss the first three games of the 2026 regular season "
     "for a violation of the NFL's substance abuse policy back in March.",
     False, 3),
    ('IR', 'KC Ethan Downs',
     "Downs' season is over after he tore his ACL during Tuesday's practice session.",
     True, None),
    ('IR', 'LV Chris Collier',
     'Collier will return to the Raiders after being waived/injured by the team '
     'Friday, and he is now set to spend the entirety of the 2026 campaign on IR '
     'unless the two sides reach an injury settlement down the road.',
     True, None),
    ('IR', 'LAR Eddie Walls III',
     "Walls went down with an injury during OTAs and was carted off the practice "
     "field, and now he'll have to sit out the rest of the year unless he works out "
     "an injury settlement with the team.",
     True, None),
    ('IR', 'NE Jimmy Kibble',
     "The rookie undrafted free agent will now be forced to miss the entirety of the "
     "upcoming campaign unless he's waived with an injury settlement.",
     True, None),
    ('IR', 'NE Jeremiah Webb',
     "He now will be forced to miss the entirety of the upcoming campaign unless he's "
     "waived with an injury settlement.",
     True, None),
    ('OUT', 'NO Keeshawn Silver',
     "Regardless, since he went unclaimed off waivers he's landed on IR, which means "
     "Silver will need to sit out the entire 2026 campaign unless he reaches an "
     "injury settlement with New Orleans.",
     True, None),
    ('IR', 'SF Mikail Kamara',
     'The undrafted free agent out of Indiana will now spend the duration of the 2026 '
     'season on IR unless he and the 49ers reach an injury settlement.',
     True, None),
    ('OUT', 'TB Chase Lucas',
     'The cornerback will now spend the entirety of the 2026 season on injured '
     'reserve unless he is waived with an injury settlement.',
     True, None),
    ('IR', 'TEN Sanoussi Kane',
     "Now that he's on IR, the 2024 seventh-rounder will be forced to miss the entire "
     "2026 season unless he reaches an injury settlement with Tennessee.",
     True, None),
]

# REAL rows that DO parse ungated and MUST be silent under their real status. This is
# the evidence that the status gate is load-bearing: Robinson's blurb is about
# PEARSALL, Watson/Turner/McCoy are about a season that is already over, and Blount is
# an `Available to play`-flavoured row whose narrative describes an IR stint.
# Ungated they would each stamp a false "out for the season" on a healthy starter.
_NEGATIVES_GATED = [
    ('ACTIVE', 'SF Demarcus Robinson',
     'Ricky Pearsall will miss the entire 2026 season due to a PCL injury that '
     'requires surgery.'),
    ('QUESTIONABLE', 'CLE Nathaniel Watson',
     'Watson has now fully recovered from the biceps injury that forced him to miss '
     'the entirety of the 2025 campaign.'),
    ('ACTIVE', 'DET Payton Turner',
     'Turner signed with the Lions in late March after missing the entire 2025 season '
     'due to a rib injury.'),
    ('QUESTIONABLE', 'LV Jermod McCoy',
     'The rookie fourth-rounder is working his way back from a torn ACL that caused '
     'him to miss the entire 2025 college season at Tennessee.'),
    ('QUESTIONABLE', 'ARI Joey Blount',
     "He'll need to sit out the entire 2026 campaign unless he reaches an injury "
     "settlement with Arizona at some point."),
]

# The two REAL season-class rows that parse to NOTHING even when fully gated in. They
# are the whole reason scripts/availability.py needs a documented league floor: the
# honest answer here is "we do not know", and it must stay that way.
_NEGATIVES_UNGATED = [
    ('IR', 'SF Ricky Pearsall',
     'Orthopedic surgeon Dr. Prem Ramkumar told the San Francisco Chronicle that '
     "there's not enough data on similar surgeries to confidently predict whether "
     'Pearsall will regain his pre-injury form in 2027. That also explains why rehab '
     'estimates have been so broad, with one report suggesting "6-12 months" as the '
     "timeline for Pearsall's return. Having undergone surgery in early August, the "
     "wideout has 13 months to prepare for Week 1 of 2027 -- right around the time "
     "he'll celebrate his 27th birthday."),
    ('IR', 'KC John Michael Gyllenborg',
     'Gyllenborg sprained his knee in late July and will need to miss some time. The '
     'tight end was moved to IR alongside defensive end Ethan Downs (knee), so the '
     'Chiefs now have two roster spots available for the start of training camp '
     'Wednesday morning.'),
    ('OUT', 'synthetic: hedged season-ending is still nothing',
     'He could miss the entire season.'),
    ('OUT', 'synthetic: no timetable', 'There is no timetable for his return.'),
    ('OUT', 'synthetic: a range is never averaged or taken at its low end',
     'He is expected to be sidelined 2 to 4 weeks.'),
    ('OUT', 'synthetic: a SPELLED-OUT range is still a range',
     'He is sidelined two to four weeks.'),
    ('OUT', 'synthetic: a spelled-out game range is still a range',
     'He will miss two to four games.'),
    ('OUT', 'synthetic: mixed-notation range',
     'He is out 2 to four weeks.'),
    ('OUT', 'synthetic: out of the 1..17 band',
     'He will miss 40 games under the terms of the ruling.'),
    ('OUT', 'synthetic: empty detail', ''),
    ('OUT', 'synthetic: null detail', None),
]


def selftest():
    for status, who, detail, want_season, want_weeks in _POSITIVES:
        got = parse_duration(detail, status=status)
        assert got is not None, f"missed a real positive: {who}"
        assert got["out_for_season"] is want_season, (who, got)
        assert got["weeks_out"] == want_weeks, (who, got)
        assert got["confidence"] == "explicit", (who, got)
        assert got["evidence"] in _WS.sub(" ", detail), (who, got)
    n_season = sum(1 for r in _POSITIVES if r[3])
    n_count = sum(1 for r in _POSITIVES if r[4] is not None)
    assert (n_season, n_count) == (11, 1), (n_season, n_count)

    for status, who, detail in _NEGATIVES_GATED:
        # Ungated these DO parse — that is precisely why the gate exists.
        assert parse_duration(detail, status=None) is not None, \
            f"{who}: fixture no longer proves the gate is load-bearing"
        # Gated by their REAL status they are silent.
        assert parse_duration(detail, status=status) is None, (who, status)

    for status, who, detail in _NEGATIVES_UNGATED:
        assert parse_duration(detail, status=status) is None, \
            f"{who}: invented a duration the report never stated"

    # A range is rejected even where the same shape without one would parse.
    assert parse_duration("He is sidelined 3 weeks.", status="OUT")["weeks_out"] == 3
    assert parse_duration("He is sidelined 3 to 5 weeks.", status="OUT") is None
    # ...in EITHER notation. A word range used to slip the digits-only veto and get
    # taken at its HIGH end, stamped confidence="explicit" over a number no report
    # ever stated.
    assert parse_duration("He is sidelined three weeks.", status="OUT")["weeks_out"] == 3
    assert parse_duration("He is sidelined three to five weeks.", status="OUT") is None
    # Evidence is the verbatim sentence, original case, whitespace-collapsed.
    got = parse_duration("Filler line here.  Walls is OUT for the season.", status="IR")
    assert got["evidence"] == "Walls is OUT for the season.", got
    # A status outside PARSE_STATUSES can never produce a duration.
    for code in ("ACTIVE", "QUESTIONABLE", "DOUBTFUL"):
        assert parse_duration("He is out for the season.", status=code) is None, code

    print(f"selftest OK: {len(_POSITIVES)} real positives ({n_season} season-ending, "
          f"{n_count} counted), {len(_NEGATIVES_GATED)} real rows killed by the status "
          f"gate, {len(_NEGATIVES_UNGATED)} nulls stayed null")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    print(__doc__)
    sys.exit(0)
