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
HISTORY_SEASONS = [2021, 2022, 2023, 2024, 2025]
CURRENT_SEASON = 2026
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
    print("selftest OK: status filter + rename + shaping exact; OL/DL-front positions "
          "admitted, skill rows unchanged; nflverse statuses map to the canonical "
          "week-class vocabulary")


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
            teams, kept = shape(fetch_injuries_release(season))
        except FeedError as err:
            if season == CURRENT_SEASON:
                print(f"NOTICE: {season} injuries not available yet ({err}); skipping")
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

    if not seasons_out:
        print("INJURY HISTORY: nothing available; keeping existing.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": ("nflverse injuries releases (final report statuses, skill positions "
                   "+ OL + DL front)"),
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
