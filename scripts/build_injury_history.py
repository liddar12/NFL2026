"""BUILD data/injury_history.json — weekly PREGAME injury-report statuses for
skill players AND linemen, from the nflverse injuries releases. The qb_out
promotion family's availability signal: a team whose primary passer is listed
Out or Doubtful on the final report priced differently — walked forward
leak-free (report status is pregame information by construction).

R70 (line-injury cascade, phase 1) widens the position filter to the offensive
line and the defensive-line front so scripts/backtest_lines.py can MEASURE the
two cascades the owner named (own OL out -> RB/QB; opposing DL out -> RB/QB).
The skill-position rows are untouched: the same rows, in the same order, with
the same fields, so the committed file's QB/RB/WR/TE content stays
byte-identical when the file is regenerated (a test locks that). OLB is NOT
counted as defensive front — a 3-4 OLB is an edge rusher, a 4-3 OLB is a
coverage linebacker, and the depth-chart abbreviation cannot tell them apart;
"front" here means the hand-in-the-dirt positions only (DE/DT/NT/DL/EDGE and
the 2025+ depth-chart spellings LDE/RDE/LDT/RDT).

PRECEDENCE (R91/G01, and it is freshness, not presence). For the CURRENT
week the daily ESPN report (data/injuries.json) is the freshest designation
there is, so that week is REBUILT FROM SCRATCH on every run: the report
REPLACES the row set of every team it covers, the release's rows for that week
stand only for the teams the report does not cover, and rows written from an
earlier report (they carry that report's as_of_utc) are cleared first so
yesterday's designation can never survive today's. Every week strictly BEFORE
the current one is release-only and the report never touches it - that walked-
forward history is what the qb_out family's adoption was measured on. The rule
used to be "release wins, overlay fills", which froze the week at its first
run: Wednesday's practice report, when a QB is listed Questionable and the
signal is defined not to fire, beat Friday's final designation by construction.

Runner-built (sandbox proxy 403s nflverse releases); past seasons immutable
unless --rebuild; loud on failure keeps the existing file. --selftest checks
row shaping only.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import availability  # noqa: E402
from scripts.scrape.nflverse import FeedError, fetch_injuries_release  # noqa: E402
from scripts.scrape.espn import FINAL_STATUSES  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "injury_history.json")
INJURIES_PATH = os.path.join(DATA, "injuries.json")
DEPTH_PATH = os.path.join(DATA, "depth_chart.json")
GAME_PREDICTIONS_PATH = os.path.join(DATA, "game_predictions.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
HISTORY_SEASONS = [2021, 2022, 2023, 2024, 2025]
CURRENT_SEASON = 2026
# R91 — the nflverse release for a season IN PROGRESS is small by construction
# (two weeks of reports is ~600 rows), and the 2,000-row "partial pull" floor
# that protects a finished season refused it every day: the 2026 season never
# reached this file, the adopted qb_out signal fired 0 times (the build log said
# "0 team-weeks with QB listings" on every run), and CAR @ ATL priced Atlanta at
# 61% with Penix OUT and Tagovailoa DOUBTFUL. A partial in-season release is
# the honest state of the season, not a failed pull.
CURRENT_MIN_ROWS = 50
RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC"}
SKILL_POSITIONS = frozenset(["QB", "RB", "WR", "TE"])
# R70 — the offensive line as nflverse spells it: the injury releases and the
# legacy depth charts say T / G / C, the 2025+ depth charts LT / LG / C / RG / RT
# (verified on the releases, 2026-09-08); OL / OT / OG are admitted for safety.
OL_POSITIONS = frozenset(["T", "G", "C", "OL", "OT", "OG", "LT", "RT", "LG", "RG"])
# R70 — the defensive-line FRONT: hand-in-the-dirt positions only. OLB is
# deliberately absent (see the module docstring). The injury releases spell
# them DE / DT / NT; the 2025+ depth-chart release spells the same slots
# LDE / RDE / LDT / RDT / NT (verified on the release, 2026-09-08).
DL_FRONT_POSITIONS = frozenset(["DE", "DT", "NT", "DL", "EDGE", "LDE", "RDE", "LDT", "RDT"])
POSITIONS = SKILL_POSITIONS | OL_POSITIONS | DL_FRONT_POSITIONS
STATUSES = frozenset(["Out", "Doubtful", "Questionable"])
MIN_KEPT_PER_SEASON = 500
# R91/G07 — the DAILY ESPN report speaks a wider vocabulary than the nflverse
# release does, and the three-value STATUSES filter dropped everything else on
# the floor: 39 of today's 800 rows say "Injured Reserve" (the review counted
# 41, one of them a QB), and a player on IR is MORE certainly unavailable than
# one listed Doubtful, which does fire. Every report status is now read through
# the ONE canonical vocabulary (scripts/availability.py) and the season-class
# codes are admitted as this file's "Out" — "Out" is the word every consumer
# reads (promote_signals.qb_out_current takes Out/Doubtful), so an IR QB1 moves
# the number instead of being invisible. The row keeps the report's own word in
# `designation` so the file never claims IR and Out are the same fact.
# SUSPENDED is deliberately NOT admitted: it is not an injury designation, and
# the cascades this file feeds are measured on injuries.
REPORT_STATUS = {
    availability.OUT: "Out",
    availability.DOUBTFUL: "Doubtful",
    availability.QUESTIONABLE: "Questionable",
    availability.IR: "Out",
    availability.PUP: "Out",
    availability.NFI: "Out",
}
REPORT_IGNORED = frozenset([availability.ACTIVE, availability.SUSPENDED])
# The full status vocabulary of the committed data/injuries.json, pinned so a
# spelling ESPN has not used before reds the selftest here rather than being
# dropped silently by a filter (the G07 failure).
OBSERVED_REPORT_STATUSES = frozenset(
    ["Active", "Out", "Doubtful", "Questionable", "Injured Reserve"])


def _assert_canonical_vocab():
    """nflverse's three report statuses must be readable by the ONE vocabulary.

    Rel17 makes scripts/availability.py the single source of availability truth, and
    this file is the second feed that speaks about availability — so it has to agree.
    An ASSERTION ONLY: the emitted rows keep nflverse's verbatim spellings and the
    output stays byte-identical, because data/injury_history.json is a 553 KB
    committed artifact whose upstream (nflverse release CSVs) 403s through the
    sandbox proxy and therefore cannot be regenerated to match a re-keying. What this
    catches is the real risk — someone widening STATUSES with a spelling the shared
    vocabulary does not know.
    """
    for status in sorted(STATUSES):
        code = availability.normalize_status(status)
        assert code in availability.WEEK_CLASS, (
            f"nflverse report status {status!r} maps to {code!r}, which is not a "
            f"week-class code. Reconcile scripts/availability.py before shipping: an "
            f"unmapped status silently becomes 'healthy' downstream."
        )
    # G07 — every canonical code is either emitted by this file or deliberately
    # ignored. A code added to scripts/availability.py that is neither reds here,
    # instead of falling through report_status as a silent drop.
    unclassified = set(availability.CODES) - set(REPORT_STATUS) - REPORT_IGNORED
    assert not unclassified, (
        f"availability codes {sorted(unclassified)} are neither emitted by this "
        f"file (REPORT_STATUS) nor deliberately ignored (REPORT_IGNORED)."
    )
    for label in set(REPORT_STATUS.values()):
        assert label in STATUSES, label


def line_group(pos):
    """'ol' / 'dl' for a line position, None otherwise (shared with
    build_line_report.py and backtest_lines.py so the three agree)."""
    pos = (pos or "").strip().upper()
    if pos in OL_POSITIONS:
        return "ol"
    if pos in DL_FRONT_POSITIONS:
        return "dl"
    return None


def shape(rows):
    """seasons[team][week] = [{id, name, position, status}] for skill players
    and linemen carrying a real report status. Returns (teams dict, kept
    count). Row order is the release's order, so widening POSITIONS appends
    line rows around the skill rows without reordering or reshaping them."""
    _assert_canonical_vocab()
    teams = {}
    kept = 0
    for r in rows:
        pos = (r.get("position") or "").strip()
        status = (r.get("report_status") or "").strip()
        if pos not in POSITIONS or status not in STATUSES:
            continue
        team = RENAMES.get((r.get("team") or "").strip(), (r.get("team") or "").strip())
        try:
            week = int(float(r.get("week")))
        except (TypeError, ValueError):
            continue
        if not team:
            continue
        kept += 1
        teams.setdefault(team, {}).setdefault(str(week), []).append({
            "id": (r.get("gsis_id") or "").strip() or None,
            "name": (r.get("full_name") or "").strip(),
            "position": pos,
            "status": status,
        })
    return teams, kept


def report_status(raw):
    """The label this file emits for one DAILY-report status, or None when the
    report is saying nothing about a missed game (Active, Suspension).

    G07 — the ONE place ESPN's vocabulary is read, through
    scripts/availability.normalize_status. A spelling the shared vocabulary does
    not know RAISES: an ESPN word nobody has mapped must red the build, because
    the alternative is what this fixes — 41 rows, one of them a quarterback,
    dropped without a line of output.
    """
    code = availability.normalize_status(raw)
    if code is None:
        raise ValueError(
            "daily injury report status %r is not in the canonical vocabulary "
            "(scripts/availability.py). Map it there before shipping: an unmapped "
            "status silently drops a player who cannot take a snap." % (raw,))
    if code in REPORT_IGNORED:
        return None
    return REPORT_STATUS[code]


def _norm_name(name):
    """Lower-case, diacritics and punctuation stripped, suffix tokens dropped, so
    ESPN's "Michael Penix Jr." and the depth chart's "Michael Penix Jr." (or a
    release's "Michael Penix") meet on one key."""
    import re
    import unicodedata
    text = unicodedata.normalize("NFD", str(name or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    toks = [t for t in re.sub(r"[^a-z0-9]+", " ", text).split()
            if t not in ("jr", "sr", "ii", "iii", "iv", "v")]
    return " ".join(toks)


def depth_ids(depth_doc):
    """{team: {normalised name: gsis_id}} from data/depth_chart.json. The daily
    ESPN injury report carries names, not ids; the depth chart carries both, so
    it is the join that lets a report row name the same player the passer
    ledger names. A player absent from the chart resolves to no id (honest)."""
    out = {}
    for team, groups in ((depth_doc or {}).get("teams") or {}).items():
        by = out.setdefault(team, {})
        for pos, rows in (groups or {}).items():
            if not isinstance(rows, list):
                continue
            for r in rows:
                key = _norm_name(r.get("name"))
                if key and r.get("gsis_id") and key not in by:
                    by[key] = r["gsis_id"]
    return out


def overlay_current_week(injuries_doc, depth_doc, week):
    """R91 — the CURRENT week's report rows from the daily ESPN feed
    (data/injuries.json), in this file's row shape: seasons[team][week] =
    [{id, name, position, status, designation?, as_of_utc?}]. Same position
    filter as the release path; the status goes through report_status (G07), so
    an IR / PUP / NFI designation lands as this file's "Out" and keeps the
    report's own word in `designation`. The id comes from the depth chart by
    name, else None. `as_of_utc` is the report's own updated_utc, so a reader
    (and the next run) can see WHICH report a current-week row came from.
    Raises ValueError on a status spelling the canonical vocabulary does not
    know. Returns (teams dict, kept, unresolved)."""
    _assert_canonical_vocab()
    ids = depth_ids(depth_doc)
    as_of = ((injuries_doc or {}).get("updated_utc") or "").strip() or None
    teams, kept, unresolved = {}, 0, 0
    for r in (injuries_doc or {}).get("injuries") or []:
        pos = (r.get("position") or "").strip()
        raw = (r.get("status") or "").strip()
        team = RENAMES.get((r.get("team") or "").strip(), (r.get("team") or "").strip())
        if pos not in POSITIONS or not team or not raw:
            continue
        status = report_status(raw)
        if status is None:
            continue
        pid = ids.get(team, {}).get(_norm_name(r.get("player")))
        if pid is None:
            unresolved += 1
        kept += 1
        row = {
            "id": pid,
            "name": (r.get("player") or "").strip(),
            "position": pos,
            "status": status,
        }
        if raw != status:
            row["designation"] = raw
        if as_of:
            row["as_of_utc"] = as_of
        teams.setdefault(team, {}).setdefault(str(int(week)), []).append(row)
    return teams, kept, unresolved


def from_report(rows):
    """True when a row set was written from the daily report: a report row
    carries that report's as_of_utc, a release row never does."""
    return any(isinstance(r, dict) and r.get("as_of_utc") for r in rows or [])


def clear_current_week(season_rows, week):
    """The season with the CURRENT week's REPORT-derived rows removed.

    G01 — the current week is rebuilt from scratch on every run, so a row set
    written from an earlier report is dropped BEFORE today's report is merged.
    Without this, a team the report no longer lists (the player recovered, or
    today's feed simply does not name him) would keep yesterday's designation
    for the rest of the week. Release rows are NOT touched, on this week or any
    other - they are the fallback for the teams today's report does not cover,
    and on an earlier week they ARE the walked-forward record.

    G18 - a report row set on ANY other week is cleared too. The daily report
    describes the week being played and nothing else, so a report row filed on
    another week is a misfiling, never history. On the runner scripts.build_all
    rewrites data/game_predictions.json to a week-1 fixture placeholder before
    this builder runs, so every report row was filed under week 1: it replaced
    the week-1 RELEASE rows of 30 of 31 teams (the walked-forward record of a
    week already played) while week 2, the week being priced, kept only the
    release rows the report was meant to refresh.
    Returns (season, n_row_sets_cleared)."""
    out, cleared = {}, 0
    for team, weeks in (season_rows or {}).items():
        kept = {}
        for w, rows in (weeks or {}).items():
            if from_report(rows):
                cleared += 1
                continue
            kept[w] = rows
        if kept:
            out[team] = kept
    return out, cleared


def merge_overlay(season_rows, overlay, week):
    """FRESHNESS, not presence, for the CURRENT week (G01).

    For `week` the daily report REPLACES the row set of every team it covers;
    the release's rows stand only for the teams it does not cover. Every week
    strictly before `week` is release-only and is never touched by the report -
    that walked-forward history is what the qb_out family's adoption was
    measured on. The old rule ("release wins, overlay fills") meant Wednesday's
    practice report beat Friday's final designation by construction: the ATL
    QB-out never landed and CAR @ ATL kept 61.4%.
    Returns (merged, n_team_weeks_from_report)."""
    merged = {t: {w: list(rows) for w, rows in weeks.items()}
              for t, weeks in (season_rows or {}).items()}
    wk = str(int(week))
    replaced = 0
    for team, weeks in (overlay or {}).items():
        rows = (weeks or {}).get(wk)
        if not rows:
            continue
        merged.setdefault(team, {})[wk] = list(rows)
        replaced += 1
    return merged, replaced


def _load_opt(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def current_week(game_predictions, schedule=None):
    """The week today's report describes.

    G18 - the SCHEDULE decides: the earliest week not entirely FINAL, the rule
    build_predictions.current_week uses to pick the slate. data/
    game_predictions.json is only the fallback for when no schedule is on file,
    because in the daily workflow scripts.build_all rewrites it to a week-1
    FIXTURE placeholder before this builder runs and build_predictions restores
    the real week afterwards. Trusting it filed every current-week report row
    under week 1 on the runner while week 2 was being priced. Locally the
    committed document already said week 2, so the misfiling never reproduced
    outside the runner."""
    games = schedule.get("games") if isinstance(schedule, dict) else schedule
    by_week = {}
    for g in games or []:
        try:
            wk = int((g or {}).get("week"))
        except (TypeError, ValueError):
            continue
        by_week.setdefault(wk, []).append(g)
    for wk in sorted(by_week):
        if not all(g.get("status") in FINAL_STATUSES for g in by_week[wk]):
            return wk
    if by_week:
        return max(by_week)
    try:
        return int((game_predictions or {}).get("week"))
    except (TypeError, ValueError):
        return None


def selftest():
    rows = [
        {"position": "QB", "report_status": "Out", "team": "LA", "week": "10",
         "gsis_id": "00-1", "full_name": "Matthew Stafford"},
        {"position": "QB", "report_status": "", "team": "KC", "week": "10",
         "gsis_id": "00-2", "full_name": "Healthy Guy"},        # no status: dropped
        {"position": "K", "report_status": "Out", "team": "KC", "week": "10",
         "gsis_id": "00-3", "full_name": "A Kicker"},           # position: dropped
        {"position": "WR", "report_status": "Questionable", "team": "KC", "week": "11",
         "gsis_id": "00-4", "full_name": "Some Receiver"},
        # R70 — linemen pass the filter now; OLB and S still do not.
        {"position": "LT", "report_status": "Out", "team": "KC", "week": "11",
         "gsis_id": "00-5", "full_name": "A Tackle"},
        {"position": "DT", "report_status": "Doubtful", "team": "KC", "week": "11",
         "gsis_id": "00-6", "full_name": "A Nose"},
        {"position": "OLB", "report_status": "Out", "team": "KC", "week": "11",
         "gsis_id": "00-7", "full_name": "An Edge Backer"},   # not front: dropped
        {"position": "S", "report_status": "Out", "team": "KC", "week": "11",
         "gsis_id": "00-8", "full_name": "A Safety"},         # dropped
    ]
    teams, kept = shape(rows)
    assert kept == 4, kept
    assert teams["LAR"]["10"][0]["status"] == "Out"             # LA -> LAR rename
    assert teams["KC"]["11"][0]["position"] == "WR"
    assert [r["position"] for r in teams["KC"]["11"]] == ["WR", "LT", "DT"]
    assert line_group("LT") == "ol" and line_group("DT") == "dl" and line_group("RDE") == "dl"
    assert line_group("OLB") is None and line_group("QB") is None
    # The skill rows are shaped exactly as before the widening: same keys,
    # same values, same order — the byte-identity the committed file relies on.
    skill_only = [r for r in rows if r["position"] in SKILL_POSITIONS]
    t2, k2 = shape(skill_only)
    assert k2 == 2
    for team, weeks in t2.items():
        for wk, lst in weeks.items():
            got = [r for r in teams[team][wk] if r["position"] in SKILL_POSITIONS]
            assert got == lst, (team, wk)
    for pos in sorted(OL_POSITIONS | DL_FRONT_POSITIONS):
        assert pos in POSITIONS and pos not in SKILL_POSITIONS
    # The emitted status stays nflverse's verbatim spelling (byte-identical output),
    # but every one of them must be readable by the shared Rel17 vocabulary.
    _assert_canonical_vocab()
    assert {availability.normalize_status(s) for s in STATUSES} == {
        availability.OUT, availability.DOUBTFUL, availability.QUESTIONABLE}
    # R91 — the current-week overlay from the daily ESPN report, ids by name
    # from the depth chart; the release's team-weeks win, the overlay fills.
    depth = {"teams": {"ATL": {"QB": [
        {"rank": 1, "name": "Michael Penix Jr.", "gsis_id": "00-0039917"},
        {"rank": 2, "name": "Tua Tagovailoa", "gsis_id": "00-0036212"}]}}}
    feed = {"updated_utc": "2026-09-18T15:43:21Z", "injuries": [
        {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Out"},
        {"team": "ATL", "player": "Tua Tagovailoa", "position": "QB", "status": "Doubtful"},
        {"team": "ATL", "player": "Cooper Rush", "position": "QB", "status": "Active"},
        {"team": "ATL", "player": "Somebody Else", "position": "WR", "status": "Out"},
        # G07 — an IR quarterback: more certainly unavailable than a Doubtful,
        # and invisible to the signal until this run.
        {"team": "ATL", "player": "A Shelved Passer", "position": "QB",
         "status": "Injured Reserve"},
        {"team": "LA", "player": "A Kicker", "position": "K", "status": "Out"},
    ]}
    ov, kept3, unresolved = overlay_current_week(feed, depth, 2)
    assert kept3 == 4 and unresolved == 2, (kept3, unresolved)
    assert [r["id"] for r in ov["ATL"]["2"]] == ["00-0039917", "00-0036212", None, None]
    assert ov["ATL"]["2"][0]["status"] == "Out" and "LAR" not in ov
    assert _norm_name("Michael Penix Jr.") == _norm_name("michael penix")
    # G07 — the IR row is admitted as this file's Out (promote_signals reads
    # Out/Doubtful), and it says which word it came from.
    ir = ov["ATL"]["2"][3]
    assert ir["status"] == "Out" and ir["designation"] == "Injured Reserve", ir
    assert "designation" not in ov["ATL"]["2"][0], "Out is Out: no redundant word"
    # G01 — every current-week row names the report it came from.
    assert all(r["as_of_utc"] == "2026-09-18T15:43:21Z" for r in ov["ATL"]["2"])
    # G07 — an ESPN word the shared vocabulary does not know RAISES; it is never
    # dropped. This is the defect: 41 rows, one a quarterback, vanished silently.
    try:
        overlay_current_week({"injuries": [{"team": "ATL", "player": "X",
                                            "position": "QB", "status": "Banged Up"}]}, depth, 2)
    except ValueError as err:
        assert "Banged Up" in str(err), err
    else:
        raise AssertionError("an unknown report status must fail the builder loudly")
    # ... and the FULL vocabulary of the committed report is read, so a new ESPN
    # spelling reds here rather than costing a signal a week.
    committed = _load_opt(INJURIES_PATH)
    if committed:
        seen = {(r.get("status") or "").strip() for r in committed.get("injuries") or []}
        seen.discard("")
        assert seen and seen <= OBSERVED_REPORT_STATUSES, (
            "data/injuries.json carries status spellings this builder has not seen: "
            f"{sorted(seen - OBSERVED_REPORT_STATUSES)}")
        for raw in sorted(seen):
            report_status(raw)                       # raises on an unmapped word

    # G01 — FRESHNESS, not presence, on the CURRENT week. The lock that used to
    # stand here was `filled2 == 0`: the release (or, on the failure path,
    # yesterday's own overlay) owned the team-week, so Friday's designation
    # never landed, qb_out fired on whichever report happened to be on disk at
    # the first run of the week, and CAR @ ATL kept 61.4% with Penix OUT.
    merged, replaced = merge_overlay(
        {"ATL": {"1": [{"id": "wk1"}], "2": [{"id": "release-atl"}]},
         "KC": {"2": [{"id": "release-kc"}]}}, ov, 2)
    assert replaced == 1, replaced                          # only ATL is in the report
    assert merged["ATL"]["1"] == [{"id": "wk1"}]             # week < current: untouched
    assert merged["ATL"]["2"] == ov["ATL"]["2"]              # the report REPLACES
    assert merged["KC"]["2"] == [{"id": "release-kc"}]       # not covered: release stands

    # A Q -> Out downgrade between two runs changes the row AND flips qb_out.
    wed = {"updated_utc": "2026-09-16T15:00:00Z", "injuries": [
        {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB",
         "status": "Questionable"}]}
    fri = {"updated_utc": "2026-09-18T15:00:00Z", "injuries": [
        {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Out"}]}
    import tempfile
    from scripts.promote_signals import qb_out_current
    runs, fires = [], []
    season = {"ATL": {"1": [{"id": "wk1-release", "name": "Gone By Now",
                             "position": "QB", "status": "Out"}]}}
    with tempfile.TemporaryDirectory() as tmp:
        epa_path = os.path.join(tmp, "epa.json")
        inj_path = os.path.join(tmp, "inj.json")
        depth_path = os.path.join(tmp, "depth.json")
        for path, doc in ((epa_path, {"seasons": {"2025": {"ATL": {"1": {"passers": {
                "00-0039917": {"db": 100, "epa": 0.0, "name": "M.Penix"}}}}}}}),
                (depth_path, depth)):
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
        for report in (wed, fri):
            today, _, _ = overlay_current_week(report, depth, 2)
            season, _ = clear_current_week(season, 2)
            season, _ = merge_overlay(season, today, 2)
            runs.append(dict(season["ATL"]["2"][0]))
            with open(inj_path, "w", encoding="utf-8") as fh:
                json.dump({"seasons": {"2026": season}}, fh)
            primary, outs = qb_out_current(2026, epa_path=epa_path, injury_path=inj_path,
                                           depth_path=depth_path)
            fires.append(primary.get("ATL") in outs.get(("ATL", 2), set()))
    assert [r["status"] for r in runs] == ["Questionable", "Out"], runs
    assert [r["as_of_utc"] for r in runs] == ["2026-09-16T15:00:00Z", "2026-09-18T15:00:00Z"]
    assert fires == [False, True], fires
    # the week BEFORE the current one survived both runs untouched
    assert season["ATL"]["1"] == [{"id": "wk1-release", "name": "Gone By Now",
                                   "position": "QB", "status": "Out"}]
    # a team today's report no longer names loses yesterday's report rows rather
    # than carrying a designation the feed has withdrawn
    stale, cleared = clear_current_week({"ATL": {"2": list(ov["ATL"]["2"])}}, 2)
    assert cleared == 1 and stale == {}, (cleared, stale)

    # G18 - the week comes from the SCHEDULE (the earliest week not entirely
    # FINAL), never from a fixture placeholder in game_predictions.json.
    sched = {"games": [{"week": 1, "status": "STATUS_FINAL"},
                       {"week": 2, "status": "STATUS_FINAL"},
                       {"week": 2, "status": "STATUS_SCHEDULED"},
                       {"week": 3, "status": "STATUS_SCHEDULED"}]}
    assert current_week({"week": 1}, sched) == 2, "the placeholder's week is ignored"
    assert current_week({"week": 1}, {"games": [
        {"week": 1, "status": "STATUS_FINAL_OVERTIME"}]}) == 1, \
        "a schedule entirely FINAL settles on its last week"
    assert current_week({"week": 2}, None) == 2, "no schedule: the predictions week"
    assert current_week(None, None) is None and current_week({}, {"games": []}) is None

    # and a report row set misfiled on ANOTHER week is cleared, while the release
    # rows of every week - the walked-forward record - stand
    release = [{"id": "rel", "name": "Release Row", "position": "QB", "status": "Out"}]
    misfiled = {"ATL": {"1": [{"id": "x", "name": "Filed Wrong", "position": "QB",
                               "status": "Out", "as_of_utc": "2026-09-18T15:00:00Z"}],
                        "2": list(release)},
                "CAR": {"1": list(release)}}
    cur, cleared = clear_current_week(misfiled, 2)
    assert cleared == 1 and cur == {"ATL": {"2": release}, "CAR": {"1": release}}, cur

    # 2021-2025 are release-only and no current-week machinery can reach them:
    # the committed corpus is byte-identical across a full merge pass.
    corpus = _load_opt(OUT_PATH)
    if corpus:
        seasons = corpus.get("seasons") or {}
        before = {y: json.dumps(seasons[y], sort_keys=True)
                  for y in map(str, HISTORY_SEASONS) if y in seasons}
        after = dict(seasons)
        cur, _ = clear_current_week(after.get(str(CURRENT_SEASON)) or {}, 2)
        after[str(CURRENT_SEASON)], _ = merge_overlay(cur, ov, 2)
        assert before == {y: json.dumps(after[y], sort_keys=True) for y in before}, \
            "the current-week rebuild must not touch a walked-forward season"

    print("selftest OK: status filter + rename + shaping exact; OL/DL-front positions "
          "admitted, skill rows unchanged; nflverse statuses map to the canonical "
          "week-class vocabulary; the daily report's FULL vocabulary is read (IR/PUP/"
          "NFI admitted as Out, an unknown word raises); the current-week overlay "
          "resolves ids by name and is rebuilt from the freshest report every run, "
          "flipping qb_out on a Q -> Out downgrade and never touching an earlier week; "
          "the week comes from the schedule, not a fixture placeholder, and a report "
          "row misfiled on another week is cleared")


def main(rebuild=False):
    """Past seasons are immutable and kept from the committed file — unless
    `rebuild` (--rebuild) asks for a re-pull, which R70 needs ONCE on the runner
    so the 2021-2025 seasons pick up the line positions. A season whose release
    fails to fetch keeps its committed rows either way."""
    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = (json.load(fh)).get("seasons") or {}

    seasons_out = {}
    for season in HISTORY_SEASONS + [CURRENT_SEASON]:
        key = str(season)
        if key in existing and season in HISTORY_SEASONS and not rebuild:
            seasons_out[key] = existing[key]
            continue
        try:
            if season == CURRENT_SEASON:
                teams, kept = shape(fetch_injuries_release(season, min_rows=CURRENT_MIN_ROWS))
            else:
                teams, kept = shape(fetch_injuries_release(season))
        except FeedError as err:
            if season == CURRENT_SEASON:
                print(f"NOTICE: {season} injuries release not available ({err}); "
                      "the current week comes from the daily report below")
                seasons_out[key] = existing.get(key) or {}
                continue
            if key in existing:
                seasons_out[key] = existing[key]
                continue
            print(f"INJURY HISTORY FAILED for {season}: {err}", file=sys.stderr)
            return 0 if existing else 1
        if season in HISTORY_SEASONS and kept < MIN_KEPT_PER_SEASON:
            print(f"INJURY HISTORY FAILED: {season} kept {kept} (<{MIN_KEPT_PER_SEASON})",
                  file=sys.stderr)
            return 0 if existing else 1
        seasons_out[key] = teams

    # R91/G01 — the CURRENT week from the daily ESPN report (data/injuries.json),
    # ids by name from data/depth_chart.json. The nflverse release publishes
    # after the fact; the report the game is priced on is today's. So the week
    # is rebuilt from scratch every run: yesterday's report rows are cleared,
    # today's report replaces every team it covers, and the release's rows stand
    # for the teams it does not. Weeks before the current one are untouched, so
    # the walked-forward history and the live week are one file the signal reads.
    feed, depth, preds = _load_opt(INJURIES_PATH), _load_opt(DEPTH_PATH), _load_opt(GAME_PREDICTIONS_PATH)
    wk = current_week(preds, _load_opt(SCHEDULE_PATH))
    if feed and wk:
        overlay, kept_now, unresolved = overlay_current_week(feed, depth, wk)
        season, cleared = clear_current_week(seasons_out.get(str(CURRENT_SEASON)) or {}, wk)
        merged, replaced = merge_overlay(season, overlay, wk)
        seasons_out[str(CURRENT_SEASON)] = merged
        print(f"current week {wk}: {kept_now} report row(s) from data/injuries.json "
              f"as of {feed.get('updated_utc')}, {unresolved} without a depth-chart id, "
              f"{replaced} team-week(s) from the report, {cleared} stale report "
              f"team-week(s) cleared first (an earlier report's, or one misfiled "
              f"on another week)")
    else:
        print("NOTICE: no daily report / current week on file; no current-week overlay")

    if not seasons_out:
        print("INJURY HISTORY: nothing available; keeping existing.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": ("nflverse injuries releases (final report statuses, skill positions "
                   "+ OL + DL front); the CURRENT week is rebuilt every run from "
                   "data/injuries.json (ESPN daily report, ids by name from "
                   "data/depth_chart.json, as_of_utc on every row it wrote), which "
                   "replaces the release for every team it covers"),
        "seasons": seasons_out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote injury_history.json: seasons {sorted(seasons_out)}")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main(rebuild="--rebuild" in sys.argv))
