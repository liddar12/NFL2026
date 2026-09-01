#!/usr/bin/env python3
"""Sleeper's weekly projections -> data/sleeper_projections.json (R49).

DISPLAY-ONLY. This file exists so the app can show Sleeper's number BESIDE ours
(and so a league's own scoring table can price each Sleeper week exactly through
app/league.js applyScoring). It is NEVER a model input: not a projection, not a
weight, not a ranking, not a parlay probability. `display_only: true` is pinned by
the contract's enum and scripts/validate_data.py scans the file for price fields
like every other document.

Source (weeks 1..18, regular season):
  https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular
      &position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=DEF&position[]=K
plus the Sleeper player dump, fetched ONCE per run (several MB):
  https://api.sleeper.app/v1/players/nfl

THE CROSSWALK (mirrors app/sleeper.js — every method is an EXACT match, no edit
distance, no "closest"; a miss is null, never a guess):
  offence  : dump espn_id == this app's espn-<id>            ("espn_id")
             else normalised name + team + position, unique  ("name_team_position")
             else normalised name + position, unique         ("name_position")
  kickers  : dump gsis_id == data/kdst_projections.json kicker player_id ("gsis_id")
             else the same name fallbacks against the kicker rows
  defenses : DST-<TEAM> always                                ("team_def")
The fixture (tests/fixtures/sleeper_proj/) matched 158/300 pool players by espn
id ALONE; this builder measures and reports its own rate under `match`.

ROW RULE: a Sleeper row is kept iff at least one week carries pts_ppr — whether
the player is rostered somewhere is not knowable here, so nothing is dropped for
being obscure, and every week kept is reduced to STAT_KEYS (the scoring universe).
Counts of kept/dropped rows are reported and written.

Runs on the daily runner (network + requests) AFTER the pool is built. Missing
`requests` or a failed fetch is LOUD (non-zero exit, nothing written); the daily
workflow marks the step continue-on-error because a missing display feed must not
block projections. Pure functions (`map_row`, `build_document`) carry no I/O so
tests/feature/r49_sleeper_projections.test.mjs can drive them on fixture rows.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import unicodedata

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "sleeper_projections.json")
PROJECTIONS_PATH = os.path.join(DATA, "player_projections.json")
KDST_PATH = os.path.join(DATA, "kdst_projections.json")

API = "https://api.sleeper.app"
PROJ_URL = (API + "/projections/nfl/{season}/{week}?season_type=regular"
            "&position[]=QB&position[]=RB&position[]=WR&position[]=TE"
            "&position[]=DEF&position[]=K")
DUMP_URL = API + "/v1/players/nfl"
WEEKS = tuple(range(1, 19))
_HTTP_TIMEOUT = 60

# The scoring universe: exactly the allowlist the reference fixture carries
# (tests/fixtures/sleeper_proj/sleeper_projections.json stat_keys) — the keys a
# Sleeper league's scoring_settings can price, plus pts_ppr/pts_half_ppr/pts_std/gp.
STAT_KEYS = (
    "blk_kick", "bonus_pass_yd_300", "bonus_pass_yd_400", "bonus_rec_te",
    "bonus_rec_yd_200", "bonus_rush_rec_yd_100", "bonus_rush_rec_yd_200",
    "bonus_rush_yd_200", "def_2pt", "def_3_and_out", "def_4_and_stop",
    "def_forced_punts", "def_pass_def", "def_st_ff", "def_st_fum_rec", "def_st_td",
    "def_td", "ff", "fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50p",
    "fgm_yds", "fgmiss", "fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fum",
    "fum_lost", "fum_rec", "fum_rec_td", "gp", "int", "pass_2pt", "pass_att",
    "pass_cmp", "pass_cmp_40p", "pass_int", "pass_td", "pass_td_40p", "pass_yd",
    "pts_allow", "pts_allow_0", "pts_allow_14_20", "pts_allow_1_6", "pts_allow_21_27",
    "pts_allow_28_34", "pts_allow_35p", "pts_allow_7_13", "pts_half_ppr", "pts_ppr",
    "pts_std", "qb_hit", "rec", "rec_2pt", "rec_40p", "rec_td", "rec_td_40p",
    "rec_tgt", "rec_yd", "rush_2pt", "rush_40p", "rush_att", "rush_td", "rush_td_40p",
    "rush_yd", "sack", "safe", "st_ff", "st_fum_rec", "st_td", "tkl_loss", "xpm",
    "xpmiss", "yds_allow", "yds_allow_0_100", "yds_allow_100_199", "yds_allow_200_299",
    "yds_allow_300_349", "yds_allow_350_399", "yds_allow_400_449", "yds_allow_450_499",
    "yds_allow_500_549", "yds_allow_550p",
)
_STAT_SET = frozenset(STAT_KEYS)

TEAMS = frozenset(
    "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LV LAC LAR MIA "
    "MIN NE NO NYG NYJ PHI PIT SF SEA TB TEN WAS".split())
# Mirrors app/sleeper.js SLEEPER_TEAM_ALIASES — renames of the same franchise.
TEAM_ALIASES = {"ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU", "JAC": "JAX",
                "LA": "LAR", "OAK": "LV", "SD": "LAC", "SL": "LAR", "STL": "LAR",
                "WSH": "WAS"}
POSITIONS = ("QB", "RB", "WR", "TE", "K", "DEF", "FB")
_POS_ORDER = {p: i for i, p in enumerate(POSITIONS)}


class FeedError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# normalisation (mirrors app/sleeper.js normalizePlayerName / canonicalTeam)     #
# --------------------------------------------------------------------------- #

def norm_name(name):
    text = unicodedata.normalize("NFD", str(name or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[.'’`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    parts = [p for p in text.split(" ") if p]
    while len(parts) > 1 and re.match(r"^(jr|sr|ii|iii|iv|v)$", parts[-1]):
        parts.pop()
    return " ".join(parts)


def canonical_team(value):
    raw = str(value or "").upper()
    if not raw:
        return None
    raw = TEAM_ALIASES.get(raw, raw)
    return raw if raw in TEAMS else None


def canonical_position(value):
    pos = str(value or "").upper()
    return "DEF" if pos == "DST" else pos


# --------------------------------------------------------------------------- #
# indexes                                                                       #
# --------------------------------------------------------------------------- #

def build_dump_index(dump):
    """{sleeper_id: {espn_id, gsis_id, name, team, position}} from /v1/players/nfl."""
    out = {}
    for key, raw in (dump or {}).items():
        if not isinstance(raw, dict):
            continue
        sid = str(raw.get("player_id") or key)
        full = (raw.get("full_name") or "").strip() or \
            ("%s %s" % (raw.get("first_name") or "", raw.get("last_name") or "")).strip()
        espn = raw.get("espn_id")
        out[sid] = {
            "espn_id": str(int(espn)) if isinstance(espn, (int, float)) else
            (str(espn).strip() if espn else None),
            "gsis_id": (raw.get("gsis_id") or "").strip() or None,
            "name": full or None,
            "team": canonical_team(raw.get("team")),
            "position": canonical_position(raw.get("position")),
        }
    return out


def build_pool_index(projection_rows, kicker_rows, defense_rows=None):
    """The app's pool, indexed every way the crosswalk looks it up. `ids` is the
    whole pool (offence + kickers + DST-<TEAM> defenses) the match rate is over."""
    idx = {"by_espn": {}, "by_gsis": {}, "by_ntp": {}, "by_np": {}, "ids": set()}
    for r in defense_rows or []:
        pid = str(r.get("player_id") or "")
        if pid.startswith("DST-"):
            idx["ids"].add(pid)
    dup_ntp, dup_np = set(), set()

    def add(pid, name, team, pos):
        idx["ids"].add(pid)
        n = norm_name(name)
        if not n:
            return
        k1 = (n, team, pos)
        if k1 in idx["by_ntp"] and idx["by_ntp"][k1] != pid:
            dup_ntp.add(k1)
        idx["by_ntp"].setdefault(k1, pid)
        k2 = (n, pos)
        if k2 in idx["by_np"] and idx["by_np"][k2] != pid:
            dup_np.add(k2)
        idx["by_np"].setdefault(k2, pid)

    for r in projection_rows or []:
        pid = str(r.get("gsis_id") or "")
        if not pid:
            continue
        if pid.startswith("espn-"):
            idx["by_espn"][pid[5:]] = pid
        add(pid, r.get("name"), canonical_team(r.get("team")),
            canonical_position(r.get("position")))
    for r in kicker_rows or []:
        pid = str(r.get("player_id") or "")
        if not pid:
            continue
        idx["by_gsis"][pid] = pid
        add(pid, r.get("name"), canonical_team(r.get("team")), "K")
    for k in dup_ntp:
        idx["by_ntp"].pop(k, None)   # ambiguous: never matched by name
    for k in dup_np:
        idx["by_np"].pop(k, None)
    return idx


# --------------------------------------------------------------------------- #
# the pure core                                                                 #
# --------------------------------------------------------------------------- #

def match_app_id(sleeper_id, name, team, position, dump_index, pool_index):
    """(app_id or None, method or None). Exact matches only — see module docstring."""
    pos = canonical_position(position)
    if pos == "DEF":
        t = canonical_team(team) or canonical_team(sleeper_id)
        return ("DST-%s" % t, "team_def") if t else (None, None)
    d = dump_index.get(str(sleeper_id)) or {}
    if pos == "K":
        g = d.get("gsis_id")
        if g and g in pool_index["by_gsis"]:
            return g, "gsis_id"
    else:
        e = d.get("espn_id")
        if e and e in pool_index["by_espn"]:
            return pool_index["by_espn"][e], "espn_id"
    n = norm_name(name or d.get("name"))
    t = canonical_team(team) or d.get("team")
    hit = pool_index["by_ntp"].get((n, t, pos)) if n and t else None
    if hit:
        return hit, "name_team_position"
    hit = pool_index["by_np"].get((n, pos)) if n else None
    if hit:
        return hit, "name_position"
    return None, None


def reduce_stats(stats):
    """Keep STAT_KEYS only, numbers only. None when pts_ppr is absent (row not kept)."""
    stats = stats or {}
    if stats.get("pts_ppr") is None:
        return None
    return {k: float(v) for k, v in stats.items()
            if k in _STAT_SET and isinstance(v, (int, float)) and not isinstance(v, bool)}


def map_row(raw, dump_index, pool_index):
    """One raw Sleeper projection row -> (key, identity, week, reduced stats) or None."""
    player = raw.get("player") or {}
    pos = canonical_position(player.get("position") or "")
    if pos not in POSITIONS:
        return None
    week = raw.get("week")
    try:
        week = int(week)
    except (TypeError, ValueError):
        return None
    if week < 1 or week > 18:
        return None
    stats = reduce_stats(raw.get("stats"))
    if stats is None:
        return None
    sid = str(raw.get("player_id") or "")
    if not sid:
        return None
    first = (player.get("first_name") or "").strip()
    last = (player.get("last_name") or "").strip()
    name = ("%s %s" % (first, last)).strip() or (dump_index.get(sid) or {}).get("name") or sid
    team = canonical_team(raw.get("team") or player.get("team"))
    app_id, method = match_app_id(sid, name, team, pos, dump_index, pool_index)
    return sid, {"sleeper_id": sid, "app_id": app_id, "name": name,
                 "position": pos, "team": team, "_method": method}, week, stats


def build_document(rows_by_week, dump_index, pool_index, season, generated_utc):
    """Pure: {week: [raw rows]} -> the contract document (+ the match report)."""
    players = {}
    dropped = 0
    for week in sorted(rows_by_week):
        for raw in rows_by_week[week]:
            mapped = map_row(raw, dump_index, pool_index)
            if mapped is None:
                dropped += 1
                continue
            sid, ident, wk, stats = mapped
            entry = players.setdefault(sid, dict(ident, weeks={}))
            if entry["app_id"] is None and ident["app_id"] is not None:
                entry.update(ident)          # a later week resolved the identity
            entry["weeks"][str(wk)] = stats
    by_method = {}
    matched_pool = set()
    for e in players.values():
        m = e.pop("_method", None)
        if e["app_id"] is not None:
            by_method[m] = by_method.get(m, 0) + 1
            if e["app_id"] in pool_index["ids"]:
                matched_pool.add(e["app_id"])
    unmatched_pool = sorted(pool_index["ids"] - matched_pool)
    ordered = sorted(players.values(),
                     key=lambda e: (e["app_id"] is None, _POS_ORDER.get(e["position"], 9),
                                    e["name"], e["sleeper_id"]))
    return {
        "generated_utc": generated_utc,
        "season": int(season),
        "source": "sleeper",
        "source_url": PROJ_URL.format(season=season, week="{week}"),
        "display_only": True,
        "weeks_fetched": sorted(int(w) for w in rows_by_week),
        "stat_keys": list(STAT_KEYS),
        "match": {
            "pool_players": len(pool_index["ids"]),
            "pool_matched": len(matched_pool),
            "rows_kept": len(ordered),
            "rows_dropped_no_pts_ppr": dropped,
            "by_method": dict(sorted(by_method.items())),
            "unmatched_pool_sample": unmatched_pool[:25],
        },
        "players": ordered,
    }


def season_totals(doc):
    """{app_id: sum of pts_ppr over the weeks kept} for mapped rows — the
    display-only reference scripts/backtest_player.py compares last year against."""
    out = {}
    for e in doc.get("players") or []:
        if not e.get("app_id"):
            continue
        out[e["app_id"]] = round(sum(float(w.get("pts_ppr") or 0.0)
                                     for w in e["weeks"].values()), 2)
    return out


# --------------------------------------------------------------------------- #
# I/O                                                                           #
# --------------------------------------------------------------------------- #

def _get_json(url):
    try:
        import requests  # noqa: PLC0415 — pipeline-runner dependency, guarded
    except ImportError as exc:
        raise FeedError("requests is not installed — the daily runner installs it; "
                        "this builder is skipped here, loudly") from exc
    resp = requests.get(url, timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise FeedError("GET %s -> HTTP %s" % (url, resp.status_code))
    return resp.json()


def fetch_rows_by_week(season, weeks=WEEKS, get_json=_get_json):
    out = {}
    for wk in weeks:
        rows = get_json(PROJ_URL.format(season=season, week=wk))
        if not isinstance(rows, list):
            raise FeedError("week %d: expected a JSON array" % wk)
        out[wk] = rows
    return out


def fetch_dump(get_json=_get_json):
    dump = get_json(DUMP_URL)
    if not isinstance(dump, dict) or len(dump) < 1000:
        raise FeedError("player dump is not the ~12k-entry object expected")
    return dump


def load_pool():
    with open(PROJECTIONS_PATH, encoding="utf-8") as fh:
        proj = json.load(fh).get("players") or []
    kickers, defenses = [], []
    if os.path.exists(KDST_PATH):
        with open(KDST_PATH, encoding="utf-8") as fh:
            kd = json.load(fh)
        kickers = kd.get("kickers") or []
        defenses = kd.get("defenses") or []
    return proj, kickers, defenses


def write(doc, path=OUT_PATH):
    # COMPACT writer (tests/smoke.sh allowlist, reasoned): 539 players x 18 weeks
    # x ~20 stats measured 3.97 MB at indent=2 and ~2.3 MB compact. ensure_ascii,
    # no sort_keys, trailing newline — the rest of the repo convention holds.
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"), sort_keys=False)
        fh.write("\n")


def build(season, get_json=_get_json, out_path=OUT_PATH, now=None):
    proj, kickers, defenses = load_pool()
    pool_index = build_pool_index(proj, kickers, defenses)
    dump_index = build_dump_index(fetch_dump(get_json))
    rows_by_week = fetch_rows_by_week(season, get_json=get_json)
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = build_document(rows_by_week, dump_index, pool_index, season, now)
    m = doc["match"]
    if m["rows_kept"] < 100:
        raise FeedError("only %d Sleeper rows carry pts_ppr — outage or filter drift, "
                        "refusing to write" % m["rows_kept"])
    write(doc, out_path)
    print("sleeper projections: %d rows kept (>=1 week with pts_ppr), %d dropped; "
          "pool %d/%d matched (%.1f%%) by %s; unmatched sample: %s -> %s"
          % (m["rows_kept"], m["rows_dropped_no_pts_ppr"], m["pool_matched"],
             m["pool_players"], 100.0 * m["pool_matched"] / max(1, m["pool_players"]),
             m["by_method"], ", ".join(m["unmatched_pool_sample"][:6]), out_path))
    return doc


# --------------------------------------------------------------------------- #
# selftest — pure core on synthetic rows, never writes                          #
# --------------------------------------------------------------------------- #

def _synthetic():
    dump = {"96": {"player_id": "96", "espn_id": 8439, "gsis_id": "00-0023459",
                   "full_name": "Aaron Rodgers", "team": "PIT", "position": "QB"},
            "1433": {"player_id": "1433", "espn_id": 14993, "gsis_id": "00-0029822",
                     "full_name": "Brandon McManus", "team": None, "position": "K"},
            "777": {"player_id": "777", "espn_id": None, "gsis_id": None,
                    "full_name": "Odell Beckham Jr.", "team": "LA", "position": "WR"},
            "888": {"player_id": "888", "espn_id": 42, "full_name": "Nobody Here",
                    "team": "SEA", "position": "RB"}}
    proj = [{"gsis_id": "espn-8439", "name": "Aaron Rodgers", "team": "PIT", "position": "QB"},
            {"gsis_id": "espn-1", "name": "Odell Beckham", "team": "LAR", "position": "WR"}]
    kickers = [{"player_id": "00-0029822", "name": "Brandon McManus", "team": "GB",
                "position": "K"}]

    def row(sid, first, last, pos, team, week, stats):
        return {"player_id": sid, "week": week, "team": team,
                "player": {"first_name": first, "last_name": last, "position": pos,
                           "team": team}, "stats": stats}
    rows = {
        1: [row("96", "Aaron", "Rodgers", "QB", "PIT", 1,
                {"pts_ppr": 17.6, "pass_yd": 218.3, "adp_dd_ppr": 103.0, "gp": 1.0}),
            row("1433", "Brandon", "McManus", "K", "GB", 1, {"pts_ppr": 7.1, "fgm_yds": 40.0}),
            row("777", "Odell", "Beckham", "WR", "LA", 1, {"pts_ppr": 9.0, "rec": 4.0}),
            row("888", "Nobody", "Here", "RB", "SEA", 1, {"pts_ppr": 1.0}),
            row("SF", "San Francisco", "49ers", "DEF", "SF", 1, {"pts_ppr": 6.0, "sack": 2.0}),
            row("999", "Empty", "Stats", "WR", "SEA", 1, {"gp": 1.0}),
            row("998", "Punter", "Guy", "P", "SEA", 1, {"pts_ppr": 1.0})],
        2: [row("96", "Aaron", "Rodgers", "QB", "PIT", 2, {"pts_ppr": 18.0})],
    }
    return dump, proj, kickers, rows


def selftest():
    dump, proj, kickers, rows = _synthetic()
    doc = build_document(rows, build_dump_index(dump), build_pool_index(proj, kickers),
                         2026, "2026-09-01T00:00:00Z")
    by_sid = {p["sleeper_id"]: p for p in doc["players"]}
    assert by_sid["96"]["app_id"] == "espn-8439", by_sid["96"]
    assert by_sid["1433"]["app_id"] == "00-0029822", "kickers match by gsis id"
    assert by_sid["777"]["app_id"] == "espn-1", "name fallback strips Jr., maps LA->LAR"
    assert by_sid["888"]["app_id"] is None, "no exact match -> null, never a guess"
    assert by_sid["SF"]["app_id"] == "DST-SF"
    assert "999" not in by_sid, "a row with no pts_ppr in any week is dropped"
    assert "998" not in by_sid, "a punter is outside the scoring universe"
    assert set(by_sid["96"]["weeks"]) == {"1", "2"}
    assert "adp_dd_ppr" not in by_sid["96"]["weeks"]["1"], "only stat_keys survive"
    assert by_sid["96"]["weeks"]["1"]["pass_yd"] == 218.3
    m = doc["match"]
    assert m["rows_kept"] == 5 and m["rows_dropped_no_pts_ppr"] == 2, m
    assert m["pool_players"] == 3 and m["pool_matched"] == 3, m
    assert m["by_method"] == {"espn_id": 1, "gsis_id": 1, "name_team_position": 1,
                              "team_def": 1}, m
    with_def = build_document(rows, build_dump_index(dump),
                              build_pool_index(proj, kickers, [{"player_id": "DST-SF"}]),
                              2026, "2026-09-01T00:00:00Z")["match"]
    assert with_def["pool_players"] == 4 and with_def["pool_matched"] == 4, with_def
    assert doc["display_only"] is True and doc["stat_keys"] == list(STAT_KEYS)
    assert season_totals(doc)["espn-8439"] == 35.6
    # deterministic: same inputs, same bytes
    doc2 = build_document(rows, build_dump_index(dump), build_pool_index(proj, kickers),
                          2026, "2026-09-01T00:00:00Z")
    assert json.dumps(doc, sort_keys=True) == json.dumps(doc2, sort_keys=True)
    print("selftest OK: exact-match crosswalk (espn/gsis/name/team_def), pts_ppr row "
          "rule, stat_keys reduction, match report, determinism")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=None,
                    help="default: data/player_projections.json season")
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    season = args.season
    if season is None:
        with open(PROJECTIONS_PATH, encoding="utf-8") as fh:
            season = int(json.load(fh)["season"])
    try:
        build(season, out_path=args.out)
    except FeedError as exc:
        print("[sleeper_projections] SKIPPED, nothing written: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
