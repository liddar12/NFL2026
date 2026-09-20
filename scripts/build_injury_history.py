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

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "injury_history.json")
INJURIES_PATH = os.path.join(DATA, "injuries.json")
DEPTH_PATH = os.path.join(DATA, "depth_chart.json")
GAME_PREDICTIONS_PATH = os.path.join(DATA, "game_predictions.json")
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
    [{id, name, position, status}]. Same position and status filters as the
    release path; the id comes from the depth chart by name, else None.
    Returns (teams dict, kept, unresolved)."""
    _assert_canonical_vocab()
    ids = depth_ids(depth_doc)
    teams, kept, unresolved = {}, 0, 0
    for r in (injuries_doc or {}).get("injuries") or []:
        pos = (r.get("position") or "").strip()
        status = (r.get("status") or "").strip()
        team = RENAMES.get((r.get("team") or "").strip(), (r.get("team") or "").strip())
        if pos not in POSITIONS or status not in STATUSES or not team:
            continue
        pid = ids.get(team, {}).get(_norm_name(r.get("player")))
        if pid is None:
            unresolved += 1
        kept += 1
        teams.setdefault(team, {}).setdefault(str(int(week)), []).append({
            "id": pid,
            "name": (r.get("player") or "").strip(),
            "position": pos,
            "status": status,
        })
    return teams, kept, unresolved


def merge_overlay(season_rows, overlay):
    """The release's rows stand wherever it has a team-week; the overlay fills
    the team-weeks it does not have. Returns (merged, filled_team_weeks)."""
    merged = {t: {w: list(rows) for w, rows in weeks.items()}
              for t, weeks in (season_rows or {}).items()}
    filled = 0
    for team, weeks in overlay.items():
        for wk, rows in weeks.items():
            if merged.get(team, {}).get(wk):
                continue
            merged.setdefault(team, {})[wk] = rows
            filled += 1
    return merged, filled


def _load_opt(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def current_week(game_predictions):
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
    feed = {"injuries": [
        {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Out"},
        {"team": "ATL", "player": "Tua Tagovailoa", "position": "QB", "status": "Doubtful"},
        {"team": "ATL", "player": "Cooper Rush", "position": "QB", "status": "Active"},
        {"team": "ATL", "player": "Somebody Else", "position": "WR", "status": "Out"},
        {"team": "LA", "player": "A Kicker", "position": "K", "status": "Out"},
    ]}
    ov, kept3, unresolved = overlay_current_week(feed, depth, 2)
    assert kept3 == 3 and unresolved == 1, (kept3, unresolved)
    assert [r["id"] for r in ov["ATL"]["2"]] == ["00-0039917", "00-0036212", None]
    assert ov["ATL"]["2"][0]["status"] == "Out" and "LAR" not in ov
    assert _norm_name("Michael Penix Jr.") == _norm_name("michael penix")
    merged, filled = merge_overlay({"ATL": {"1": [{"id": "x"}]}, "KC": {"2": [{"id": "k"}]}}, ov)
    assert filled == 1 and merged["ATL"]["1"] == [{"id": "x"}] and merged["ATL"]["2"] == ov["ATL"]["2"]
    merged2, filled2 = merge_overlay({"ATL": {"2": [{"id": "release"}]}}, ov)
    assert filled2 == 0 and merged2["ATL"]["2"] == [{"id": "release"}]
    print("selftest OK: status filter + rename + shaping exact; OL/DL-front positions "
          "admitted, skill rows unchanged; nflverse statuses map to the canonical "
          "week-class vocabulary; current-week overlay resolves ids by name and "
          "never overrides a release team-week")


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

    # R91 — the CURRENT week from the daily ESPN report (data/injuries.json),
    # ids by name from data/depth_chart.json. The nflverse release publishes
    # after the fact; the report the game is priced on is today's. The release
    # keeps every team-week it has; the overlay fills the rest, so the walked-
    # forward history and the live week are one file the signal reads.
    feed, depth, preds = _load_opt(INJURIES_PATH), _load_opt(DEPTH_PATH), _load_opt(GAME_PREDICTIONS_PATH)
    wk = current_week(preds)
    if feed and wk:
        overlay, kept_now, unresolved = overlay_current_week(feed, depth, wk)
        merged, filled = merge_overlay(seasons_out.get(str(CURRENT_SEASON)) or {}, overlay)
        seasons_out[str(CURRENT_SEASON)] = merged
        print(f"current week {wk}: {kept_now} report row(s) from data/injuries.json, "
              f"{unresolved} without a depth-chart id, {filled} team-week(s) filled")
    else:
        print("NOTICE: no daily report / current week on file; no current-week overlay")

    if not seasons_out:
        print("INJURY HISTORY: nothing available; keeping existing.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": ("nflverse injuries releases (final report statuses, skill positions "
                   "+ OL + DL front); current week overlaid from data/injuries.json "
                   "(ESPN daily report, ids by name from data/depth_chart.json)"),
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
