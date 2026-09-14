"""BUILD data/line_report.json — the OL / DL-front LINE REPORT for the current
week (R70, line-injury cascade, phase 1).

The owner's ask: "if key offensive linemen are out, this could impact running
back and QB performance; if key defensive linemen are out on the team they play
against, it could help RB and QB." Phase 1 MEASURES (scripts/backtest_lines.py)
and ships this ANNOTATION ONLY: per team, the offensive-line starters and the
defensive-line-front starters from the latest nflverse depth-chart snapshot,
crossed with data/injuries.json (ESPN, live). The LINEUP / GRADE / PLAYERS
chips read it. IT CHANGES NO NUMBER — a projection moves on a line factor only
after the walk-forward harness clears never-regress (phase 2).

Starters: the latest depth-chart snapshot (`dt` max in the 2025+ release
shape; `week` max in the legacy shape build_oline.py reads), rows at pos_rank /
depth_team 1 whose position is an OL or DL-front spelling
(build_injury_history.OL_POSITIONS / DL_FRONT_POSITIONS — OLB is not front),
one entry per player. Verified on the 2026 release (2026-09-08): five OL per
team (LT/LG/C/RG/RT) and a three- or four-man front (LDE/RDE/NT or
LDE/LDT/RDT/RDE) by scheme. The join to the injury report is ESPN's athlete id
against the chart's espn_id when injuries.json carries `athlete_id` (R70+),
else (team, normalized name). A starter missing from the report is ACTIVE by
construction of the report (ESPN lists only injured players).

Honest when blind: when the nflverse release is unreachable the document says
`available: false` with the reason, `teams` is empty and the counts are zero —
NEVER invented starters. The views render nothing on an unavailable document
(no placeholder). --selftest runs a synthetic depth chart and injury report in
memory; --offline forces the unavailable path; --cache-dir DIR re-reads a
cached CSV (resolve_estimates.fetch_csv's pattern).
"""

import datetime as dt
import json
import os
import re
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import availability                                   # noqa: E402
from scripts.build_injury_history import (                          # noqa: E402
    DL_FRONT_POSITIONS, OL_POSITIONS, RENAMES, line_group)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "line_report.json")
INJURIES_PATH = os.path.join(DATA, "injuries.json")
PREDS_PATH = os.path.join(DATA, "game_predictions.json")
SEASON = 2026
SOURCE_LIVE = ("nflverse depth_charts_{season} (latest snapshot, pos_rank 1, OL + DL front) "
               "x ESPN injuries (data/injuries.json); annotation only, changes no number")
SOURCE_UNAVAILABLE = ("unavailable: depth chart not reachable; no starters invented "
                      "(annotation only, changes no number)")

# The availability codes that make a starter OUT for the week (every season-long
# absence is an absence this week too), and the two report designations that
# leave him in doubt. Read through the ONE vocabulary (scripts/availability.py).
OUT_CODES = frozenset({availability.OUT, availability.IR, availability.PUP,
                       availability.NFI, availability.SUSPENDED})
DOUBTFUL_CODES = frozenset({availability.DOUBTFUL})
QUESTIONABLE_CODES = frozenset({availability.QUESTIONABLE})

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b\.?$")
_NONALPHA = re.compile(r"[^a-z ]+")


def name_key(name):
    """Join key for a player name across feeds: lower-case, punctuation and
    generational suffix dropped, whitespace collapsed. 'T.J. Watt Jr.' ->
    'tj watt'. Never used to invent a match — an unmatched starter is ACTIVE
    only because ESPN lists injured players alone."""
    s = (name or "").lower().replace(".", "").replace("'", "").replace("-", " ")
    s = _NONALPHA.sub(" ", s)
    s = " ".join(s.split())
    s = _SUFFIX.sub("", s).strip()
    return s


def norm_team(code):
    code = (code or "").strip().upper()
    return RENAMES.get(code, code)


def normalize_depth_rows(rows):
    """Depth-chart rows from EITHER nflverse release shape to one record:
    {team, name, gsis_id, espn_id, pos, slot, rank, snap} where `snap` orders
    snapshots (the 2025+ `dt` string, or the legacy integer `week`). Both
    shapes already have readers in this repo (build_predictions._rookie_starters:
    dt / pos_abb / pos_slot / pos_rank / player_name; build_oline: week /
    position / depth_team / club_code / full_name). Legacy playoff charts
    (game_type != REG) are dropped; rows with no team, name or position are
    dropped, never guessed."""
    out = []
    for r in rows or []:
        team = norm_team(r.get("team") or r.get("club_code"))
        name = (r.get("player_name") or r.get("full_name") or "").strip()
        if not name:
            first = (r.get("first_name") or "").strip()
            last = (r.get("last_name") or "").strip()
            name = (first + " " + last).strip()
        pos = (r.get("pos_abb") or r.get("position") or r.get("depth_position") or "").strip().upper()
        rank = r.get("pos_rank")
        if rank in (None, ""):
            rank = r.get("depth_team")
        try:
            rank = int(float(rank))
        except (TypeError, ValueError):
            continue
        snap = r.get("dt")
        if snap in (None, ""):
            try:
                snap = int(float(r.get("week")))
            except (TypeError, ValueError):
                snap = None
        if not team or not name or not pos or snap is None:
            continue
        game_type = (r.get("game_type") or "").strip().upper()
        if game_type and game_type != "REG":
            continue  # legacy shape carries playoff charts under weeks 19+
        out.append({
            "team": team, "name": name, "gsis_id": (r.get("gsis_id") or "").strip() or None,
            "espn_id": str(r.get("espn_id") or "").strip() or None,
            "pos": pos, "slot": str(r.get("pos_slot") or r.get("depth_position") or pos),
            "rank": rank, "snap": snap,
        })
    return out


def line_starters(depth_rows):
    """{team: {"ol": [starter], "dl": [starter]}} from the LATEST snapshot of
    normalized depth rows: rank-1 rows at an OL / DL-front position, one entry
    per PLAYER (gsis id, else name) — the legacy shape lists two DEs under the
    same depth_position, so a slot key would drop the second. Returns
    (starters, snapshot) with snapshot the `snap` value used, or ({}, None) on
    an empty chart."""
    if not depth_rows:
        return {}, None
    latest = max(r["snap"] for r in depth_rows)
    seen = set()
    teams = {}
    for r in depth_rows:
        if r["snap"] != latest or r["rank"] != 1:
            continue
        grp = line_group(r["pos"])
        if grp is None:
            continue
        key = (r["team"], grp, r["gsis_id"] or name_key(r["name"]))
        if key in seen:
            continue
        seen.add(key)
        teams.setdefault(r["team"], {"ol": [], "dl": []})[grp].append(
            {"name": r["name"], "gsis_id": r["gsis_id"], "espn_id": r["espn_id"],
             "pos": r["pos"]})
    return teams, latest


def index_injuries(injury_rows):
    """{(team, key): canonical availability code} for the report's rows, keyed
    by name key and, when the row carries one, by "espn:<athlete_id>". Rows are
    read through availability.normalize_status when the document predates the
    `availability` field. A duplicated key keeps the WORSE code (out > doubtful
    > questionable > active) — the honest reading of two designations for one
    man."""
    order = {}
    for i, c in enumerate((availability.ACTIVE, availability.QUESTIONABLE,
                           availability.DOUBTFUL, availability.OUT, availability.IR,
                           availability.PUP, availability.NFI, availability.SUSPENDED)):
        order[c] = i
    idx = {}

    def put(key, code):
        if key not in idx or order.get(code, -1) > order.get(idx[key], -1):
            idx[key] = code

    for r in injury_rows or []:
        code = r.get("availability") if "availability" in r else \
            availability.normalize_status(r.get("status"))
        if code is None:
            continue
        team = norm_team(r.get("team"))
        if not team:
            continue
        nk = name_key(r.get("player"))
        if nk:
            put((team, nk), code)
        # R70 — ESPN's athlete id, when the report carries it, is the exact
        # crosswalk to the depth chart's espn_id (no name fuzz at all).
        aid = r.get("athlete_id")
        if aid not in (None, ""):
            put((team, "espn:" + str(aid)), code)
    return idx


def starter_code(inj_idx, team, starter):
    """The starter's availability code from the index: by ESPN id first, then
    by name key; None when the report does not list him (ACTIVE by the
    report's construction)."""
    if starter.get("espn_id"):
        code = inj_idx.get((team, "espn:" + starter["espn_id"]))
        if code is not None:
            return code
    return inj_idx.get((team, name_key(starter["name"])))


def cross(starters, inj_idx):
    """teams block + counts: each team's OL / DL starters crossed with the
    injury index. Names are kept verbatim from the depth chart."""
    teams = {}
    counts = {"teams": 0, "ol_starters": 0, "dl_starters": 0, "ol_out": 0, "dl_out": 0,
              "ol_doubtful": 0, "dl_doubtful": 0, "ol_questionable": 0,
              "dl_questionable": 0, "starters_matched": 0}
    for team in sorted(starters):
        block = {}
        for grp in ("ol", "dl"):
            names, out, doubtful, questionable = [], [], [], []
            for st in starters[team][grp]:
                names.append(st["name"])
                code = starter_code(inj_idx, team, st)
                if code is None:
                    continue
                counts["starters_matched"] += 1
                if code in OUT_CODES:
                    out.append(st["name"])
                elif code in DOUBTFUL_CODES:
                    doubtful.append(st["name"])
                elif code in QUESTIONABLE_CODES:
                    questionable.append(st["name"])
            block[grp] = {"starters": len(names), "names": names, "out": out,
                          "doubtful": doubtful, "questionable": questionable}
            counts[grp + "_starters"] += len(names)
            counts[grp + "_out"] += len(out)
            counts[grp + "_doubtful"] += len(doubtful)
            counts[grp + "_questionable"] += len(questionable)
        teams[team] = block
        counts["teams"] += 1
    return teams, counts


def _now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build(season, week, depth_rows, injury_rows, snapshot_note=None):
    """The document from in-memory inputs. `depth_rows` None means the chart
    was unreachable -> the honest unavailable document."""
    if depth_rows is None:
        return unavailable(season, week, snapshot_note or "depth chart unreachable")
    starters, snap = line_starters(normalize_depth_rows(depth_rows))
    if not starters:
        return unavailable(season, week, "depth chart carried no OL / DL-front rank-1 rows")
    teams, counts = cross(starters, index_injuries(injury_rows))
    return {
        "season": int(season),
        "week": int(week) if week is not None else None,
        "generated_utc": _now(),
        "available": True,
        "reason": None,
        "source": SOURCE_LIVE.format(season=season),
        "snapshot": str(snap),
        "positions": {"ol": sorted(OL_POSITIONS), "dl": sorted(DL_FRONT_POSITIONS)},
        "teams": teams,
        "counts": counts,
    }


def unavailable(season, week, reason):
    return {
        "season": int(season),
        "week": int(week) if week is not None else None,
        "generated_utc": _now(),
        "available": False,
        "reason": str(reason),
        "source": SOURCE_UNAVAILABLE,
        "snapshot": None,
        "positions": {"ol": sorted(OL_POSITIONS), "dl": sorted(DL_FRONT_POSITIONS)},
        "teams": {},
        "counts": {"teams": 0, "ol_starters": 0, "dl_starters": 0, "ol_out": 0, "dl_out": 0,
                   "ol_doubtful": 0, "dl_doubtful": 0, "ol_questionable": 0,
                   "dl_questionable": 0, "starters_matched": 0},
    }


def fetch_depth_chart(season, cache_dir=None):
    """The season's depth-chart release, through a CSV cache when `cache_dir`
    is given (resolve_estimates.fetch_csv's pattern) so a daily run re-reads a
    fresh pull once. Returns (rows, None) or (None, reason)."""
    import csv
    cached = os.path.join(cache_dir, "depth_charts_%d.csv" % season) if cache_dir else None
    if cached and os.path.exists(cached):
        with open(cached, encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh)), None
    try:
        from scripts.scrape import nflverse  # noqa: PLC0415 (guarded feature import)
        rows = nflverse.fetch_depth_charts_release(season)
    except Exception as exc:  # noqa: BLE001 — degrade, never fabricate
        return None, "nflverse depth_charts_%d unreachable: %s" % (season, exc)
    if cached:
        os.makedirs(cache_dir, exist_ok=True)
        keys = sorted({k for r in rows for k in r})
        with open(cached, "w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)
    return rows, None


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def write(doc, out_path=OUT_PATH):
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def main(argv):
    offline = "--offline" in argv
    cache_dir = None
    if "--cache-dir" in argv:
        cache_dir = argv[argv.index("--cache-dir") + 1]
    season, week = SEASON, None
    if os.path.exists(PREDS_PATH):
        preds = _load(PREDS_PATH)
        season = int(preds.get("season") or SEASON)
        week = preds.get("week")
    injuries = _load(INJURIES_PATH).get("injuries") if os.path.exists(INJURIES_PATH) else []
    if offline:
        rows, why = None, "offline run (--offline)"
    else:
        rows, why = fetch_depth_chart(season, cache_dir)
    doc = build(season, week, rows, injuries, snapshot_note=why)
    write(doc)
    if doc["available"]:
        c = doc["counts"]
        print("line_report: wk %s, %d teams, OL %d starters / %d out, DL %d starters / %d out"
              % (doc["week"], c["teams"], c["ol_starters"], c["ol_out"], c["dl_starters"],
                 c["dl_out"]))
    else:
        print("line_report: UNAVAILABLE (%s) — wrote the honest empty document"
              % doc["reason"], file=sys.stderr)
    return 0


def _synthetic():
    depth = [
        # 2025+ shape: five OL starters, one at rank 2, a DL front of four, an OLB.
        {"dt": "2026-09-07", "team": "KC", "player_name": "Left Tackle", "gsis_id": "00-1",
         "espn_id": "4001", "pos_abb": "LT", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Left Guard", "gsis_id": "00-2",
         "pos_abb": "LG", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "The Center Jr.", "gsis_id": "00-3",
         "pos_abb": "C", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Right Guard", "gsis_id": "00-4",
         "pos_abb": "RG", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Right Tackle", "gsis_id": "00-5",
         "pos_abb": "RT", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Backup Tackle", "gsis_id": "00-6",
         "pos_abb": "RT", "pos_slot": "1", "pos_rank": "2"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Nose Man", "gsis_id": "00-7",
         "pos_abb": "NT", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Edge One", "gsis_id": "00-8",
         "pos_abb": "DE", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Edge Two", "gsis_id": "00-9",
         "pos_abb": "RDE", "pos_slot": "4", "pos_rank": "1"},
        # The same man listed twice (two slots) counts once.
        {"dt": "2026-09-07", "team": "KC", "player_name": "Edge Two", "gsis_id": "00-9",
         "pos_abb": "DE", "pos_slot": "5", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Three Tech", "gsis_id": "00-10",
         "pos_abb": "DT", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "Not Front", "gsis_id": "00-11",
         "pos_abb": "OLB", "pos_slot": "1", "pos_rank": "1"},
        {"dt": "2026-09-07", "team": "KC", "player_name": "The Passer", "gsis_id": "00-12",
         "pos_abb": "QB", "pos_slot": "1", "pos_rank": "1"},
        # An OLDER snapshot: must be ignored entirely.
        {"dt": "2026-08-01", "team": "KC", "player_name": "Old Tackle", "gsis_id": "00-13",
         "pos_abb": "LT", "pos_slot": "1", "pos_rank": "1"},
        # Legacy-shape rows for a second team (club_code / depth_team / week):
        # two DEs share depth_position, both are starters; a playoff chart is not.
        {"week": "1", "game_type": "REG", "club_code": "LA", "full_name": "Ram Tackle",
         "gsis_id": "00-20", "position": "T", "depth_position": "LT", "depth_team": "1"},
        {"week": "1", "game_type": "REG", "club_code": "LA", "full_name": "Ram End",
         "gsis_id": "00-21", "position": "DE", "depth_position": "DE", "depth_team": "1"},
        {"week": "1", "game_type": "REG", "club_code": "LA", "full_name": "Ram End Two",
         "gsis_id": "00-22", "position": "DE", "depth_position": "DE", "depth_team": "1"},
        {"week": "19", "game_type": "WC", "club_code": "LA", "full_name": "Playoff Guy",
         "gsis_id": "00-23", "position": "G", "depth_position": "LG", "depth_team": "1"},
    ]
    injuries = [
        # Listed under a DIFFERENT spelling but the same ESPN id: the id wins.
        {"team": "KC", "player": "L. Tackle", "status": "Out", "availability": "OUT",
         "athlete_id": "4001"},
        {"team": "KC", "player": "The Center, Jr.", "status": "Questionable",
         "availability": "QUESTIONABLE"},
        {"team": "KC", "player": "Nose Man", "status": "Injured Reserve", "availability": "IR"},
        {"team": "KC", "player": "Edge One", "status": "Doubtful", "availability": "DOUBTFUL"},
        {"team": "KC", "player": "Backup Tackle", "status": "Out", "availability": "OUT"},
        {"team": "KC", "player": "The Passer", "status": "Out", "availability": "OUT"},
        {"team": "LAR", "player": "Ram Tackle", "status": "Out"},   # no availability field
    ]
    return depth, injuries


def selftest():
    assert name_key("T.J. Watt Jr.") == "tj watt" and name_key("De'Von Achane") == "devon achane"
    assert name_key("Odell Beckham Jr") == name_key("Odell Beckham")
    depth, injuries = _synthetic()
    # The two shapes cannot share a "latest" snapshot (a string dt and an int
    # week do not compare); a real release is one shape. Build each on its own.
    modern = [r for r in depth if "dt" in r]
    legacy = [r for r in depth if "week" in r]
    doc = build(2026, 1, modern, injuries)
    assert doc["available"] is True and doc["week"] == 1 and doc["snapshot"] == "2026-09-07"
    kc = doc["teams"]["KC"]
    assert kc["ol"]["starters"] == 5, kc["ol"]
    assert kc["ol"]["out"] == ["Left Tackle"], kc["ol"]           # rank-2 backup not counted
    assert kc["ol"]["questionable"] == ["The Center Jr."], kc["ol"]  # suffix / comma tolerant
    assert kc["dl"]["starters"] == 4, kc["dl"]                    # NT + DE + DE(RDE) + DT; OLB no
    assert kc["dl"]["out"] == ["Nose Man"] and kc["dl"]["doubtful"] == ["Edge One"]
    assert "Old Tackle" not in kc["ol"]["names"]
    c = doc["counts"]
    assert c["teams"] == 1 and c["ol_out"] == 1 and c["dl_out"] == 1 and c["dl_doubtful"] == 1
    assert c["starters_matched"] == 4, c
    doc2 = build(2025, 18, legacy, injuries)
    assert doc2["teams"]["LAR"]["ol"] == {"starters": 1, "names": ["Ram Tackle"],
                                          "out": ["Ram Tackle"], "doubtful": [],
                                          "questionable": []}, doc2["teams"]
    assert doc2["teams"]["LAR"]["dl"]["starters"] == 2, doc2["teams"]["LAR"]
    # The unavailable path: no starters, honest counts, the reason on the doc.
    off = build(2026, 1, None, injuries, snapshot_note="proxy 403")
    assert off["available"] is False and off["teams"] == {} and off["reason"] == "proxy 403"
    assert off["counts"]["ol_starters"] == 0 and off["counts"]["teams"] == 0
    empty = build(2026, 1, [{"dt": "x", "team": "KC", "player_name": "QB Only", "pos_abb": "QB",
                             "pos_rank": "1"}], injuries)
    assert empty["available"] is False
    # JSON-clean and ASCII-clean.
    json.dumps(doc, ensure_ascii=True)
    print("selftest OK: latest snapshot, rank-1 OL/DL-front starters (OLB excluded), "
          "ESPN-id + name-key join, both release shapes, honest unavailable document")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))
