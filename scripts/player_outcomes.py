"""Event-bound player facts shared by Python settlement and the browser feed.

Recorded contracts are immutable. A player may switch sides in that fixture;
his performance in a different fixture cannot settle it. Positive conflicting
identity/event evidence is pending, never absence-based did-not-play.
"""
import csv
import json
import math
import os
import re

from scripts.capture_grading_inputs import SourceUnknown, read_rows
from scripts.resolve_estimates import captured_final_scores, grading_capture_dir, norm_name
from scripts.scrape.renames import normalize_team

_GAME = re.compile(r"^(\d{4})_(\d{2})_([A-Z0-9]+)_([A-Z0-9]+)$")
_POS = {"HB": "RB", "FB": "RB"}


def identity_maps(roster_rows=(), players=()):
    """Preserve conflicts rather than letting roster order choose an identity."""
    espn, pfr = {}, {}
    for r in roster_rows:
        gsis = str(r.get("gsis_id") or "").strip()
        if not gsis:
            continue
        eid = str(r.get("espn_id") or "").strip().removesuffix(".0")
        if eid:
            espn.setdefault("espn-" + eid, set()).add(gsis)
        if r.get("pfr_id"):
            pfr.setdefault(str(r["pfr_id"]), set()).add(gsis)
    for p in players:
        if p.get("gsis_id") and p.get("nflverse_id"):
            espn.setdefault(str(p["gsis_id"]), set()).add(str(p["nflverse_id"]))
    return {"espn": espn, "pfr": pfr}


def context(games, finals, season, ids=None):
    """Explicit schedule + finals authority, passed to pure graders, not global."""
    out = {}
    for g in games or []:
        try:
            wk = int(g["week"])
        except (KeyError, TypeError, ValueError):
            continue
        gid = str(g.get("game_id") or "")
        if not gid:
            continue
        key = (wk, gid)
        row = {"season": int(season), "week": wk, "game_id": gid,
               "home": normalize_team(g.get("home")),
               "away": normalize_team(g.get("away")),
               "final": gid in (finals or {})}
        # Duplicate contradictory schedule identities cannot be resolved by order.
        if key in out and out[key] != row:
            out[key] = None
        elif key not in out:
            out[key] = row
    return {"games": out, "ids": ids or identity_maps()}


def load_context(data_dir, season, finals, cache_dir=None, *, captured=None):
    if captured is None:
        captured = captured_final_scores(season, cache_dir)
    if captured is not None:
        schedule = captured["schedule"]
        finals = {row["game_id"]: row for row in captured["games"]}
    else:
        with open(os.path.join(data_dir, "schedule_full.json"), encoding="utf-8") as f:
            schedule = json.load(f)
    roster = []
    name = "roster_%d.csv" % int(season)
    capture_dir = grading_capture_dir(cache_dir)
    if capture_dir is not None:
        try:
            roster = read_rows(capture_dir, name)
        except SourceUnknown:
            pass  # No roster crosswalk was published in this generation.
    elif cache_dir:
        path = os.path.join(cache_dir, name)
        if os.path.isfile(path):
            with open(path, encoding="utf-8-sig", newline="") as f:
                roster = list(csv.DictReader(f))
    try:
        with open(os.path.join(data_dir, "atd_week.json"), encoding="utf-8") as f:
            players = json.load(f).get("players") or []
    except FileNotFoundError:
        players = []
    return context(schedule.get("games"), finals, season, identity_maps(roster, players))


def game_for(leg, week, ctx):
    games = ctx["games"]
    if leg.get("game_id") is not None:
        # An explicit missing ID must never silently retarget by today's team.
        return games.get((int(week), str(leg["game_id"])))
    team = normalize_team(leg.get("team"))
    if not team:
        return None
    matches = [g for (wk, _), g in games.items()
               if wk == int(week) and g and team in (g["home"], g["away"])]
    return matches[0] if len(matches) == 1 else None


def _row_id(row, ids):
    if row.get("player_id"):
        return {str(row["player_id"])}
    return ids.get("pfr", {}).get(str(row.get("pfr_player_id") or ""), set())


def _identity(leg, rows, ids, *, require_stable_id=False):
    """Return a unique week row, without filtering away contradictory fixtures."""
    pos = _POS.get(leg.get("position"), leg.get("position"))
    all_rows = rows or []
    rows = [r for r in all_rows if not pos or not r.get("pos") or r["pos"] == pos]
    explicit = leg.get("nflverse_id")
    app_id = str(leg.get("gsis_id") or "")
    mapped = ids.get("espn", {}).get(app_id, set())
    if app_id.startswith("00-"):
        mapped = mapped | {app_id}
    if explicit:
        if mapped and mapped != {str(explicit)}:
            return None, "identity_conflict"
        mapped = {str(explicit)}
    if len(mapped) > 1:
        return None, "identity_conflict"
    if require_stable_id and not mapped:
        return None, "identity_unverified"
    if mapped and any(_row_id(r, ids) == mapped and pos and r.get("pos")
                      and r["pos"] != pos for r in all_rows):
        return None, "identity_position_conflict"
    full = norm_name(leg.get("player") or leg.get("name"))
    exact = [r for r in rows if full and r.get("norm") == full]
    if mapped:
        hits = [r for r in rows if _row_id(r, ids) == mapped]
        if not hits and any(_row_id(r, ids) and _row_id(r, ids) != mapped for r in exact):
            return None, "identity_conflict"
        # A source without identifiers permits name fallback, never a conflicting ID.
        if not hits:
            hits = [r for r in exact if not _row_id(r, ids)]
            if hits and require_stable_id:
                return None, "identity_unverified"
    else:
        hits = exact
    if len(hits) > 1:
        return None, "ambiguous"
    if hits:
        return hits[0], None
    # Legacy nickname/abbreviation joins stay within the named team. Unresolved
    # alias evidence elsewhere must not be converted into an absence/DNP.
    if not full:
        sel = str(leg.get("selection") or "")
        m = re.match(r"^(.+?) \d+\+ (?:pass|rush|rec) yds$", sel)
        full = norm_name(m.group(1)) if m else ""
    parts = full.split(" ", 1)
    if len(parts) != 2 or not parts[0]:
        return None, "no_stat_line" if mapped else "player_unidentified"
    team = normalize_team(leg.get("team"))
    aliases = [r for r in rows if " " in r.get("norm", "")
            and r["norm"][0] == parts[0][0] and r["norm"].split(" ", 1)[1] == parts[1]]
    if mapped:
        # A unique different ID rules out a namesake. An alias with no unique
        # ID could still be this player, so it prevents an absence inference.
        if any(len(_row_id(r, ids)) != 1 for r in aliases):
            return None, "identity_unverified"
        return None, "no_stat_line"
    hits = [r for r in aliases if r.get("team") == team]
    if aliases and (not hits or len(aliases) > len(hits)):
        return None, "identity_unverified"
    if len(hits) > 1:
        return None, "ambiguous"
    return (hits[0], None) if hits else (None, "no_stat_line")


def event_reason(row, game):
    """Validate raw source fixture fields before comparing its event to the bet."""
    team = normalize_team(row.get("team"))
    opp = normalize_team(row.get("opponent"))
    if not team or (opp and opp == team):
        return "source_game_conflict"
    raw = row.get("source_game_id")
    if raw:
        m = _GAME.fullmatch(str(raw))
        if not m:
            return "source_game_invalid"
        season, week = int(m[1]), int(m[2])
        away, home = normalize_team(m[3]), normalize_team(m[4])
        if team not in (home, away) or (opp and {team, opp} != {home, away}):
            return "source_game_conflict"
        if (season != game["season"] or week != game["week"]
                or home != game["home"] or away != game["away"]):
            return "player_game_mismatch"
    elif team not in (game["home"], game["away"]) or (opp and {team, opp} != {game["home"], game["away"]}):
        return "player_game_mismatch"
    return None


def player_event_facts(leg, week, stat_rows, td_rows, snaps_week, ctx, *, require_stable_id=False):
    """Facts for exactly this player and fixture; unknown evidence stays unknown."""
    def pending(reason):
        return {"y": None, "td": None, "reason": reason}
    game = game_for(leg, week, ctx)
    if game is None or not game.get("home") or not game.get("away") or game["home"] == game["away"]:
        return pending("game_unknown")
    if leg.get("season") is not None:
        try:
            if int(leg["season"]) != game["season"]:
                return pending("season_mismatch")
        except (TypeError, ValueError):
            return pending("season_mismatch")
    if leg.get("team") is not None and normalize_team(leg["team"]) not in (game["home"], game["away"]):
        return pending("receipt_team_mismatch")
    if not game["final"]:
        return pending("no_final")
    if stat_rows is None and td_rows is None:
        return pending("week_not_published")
    ids = ctx.get("ids") or identity_maps()
    stat, sy = _identity(leg, stat_rows, ids, require_stable_id=require_stable_id)
    td, st = _identity(leg, td_rows, ids, require_stable_id=require_stable_id)
    snap, ss = _identity(leg, (snaps_week or {}).get("rows"), ids,
                         require_stable_id=require_stable_id)
    for why in (sy, st, ss):
        if why not in (None, "no_stat_line"):
            return pending(why)
    for row in (stat, td, snap):
        if row:
            why = event_reason(row, game)
            if why:
                return pending(why)
    # Conflicting teams in positive rows are source conflict, not a tie-break.
    teams = {r["team"] for r in (stat, td, snap) if r and r.get("team")}
    if len(teams) > 1:
        return pending("source_team_conflict")
    if snap and (not snap.get("snaps_valid", True) or isinstance(snap.get("snaps"), bool)
                 or not isinstance(snap.get("snaps"), (int, float))
                 or not math.isfinite(snap["snaps"]) or snap["snaps"] < 0):
        return pending("snap_count_unknown")
    if teams and normalize_team(leg.get("team")) not in teams:
        expected = ids.get("espn", {}).get(str(leg.get("gsis_id") or ""), set())
        if leg.get("nflverse_id"):
            expected = {str(leg["nflverse_id"])}
        if str(leg.get("gsis_id") or "").startswith("00-"):
            expected = {str(leg["gsis_id"])}
        if len(expected) != 1 or not any(_row_id(r, ids) == expected for r in (stat, td, snap) if r):
            return pending("identity_unverified_team_change")
    if stat or td or (snap and snap["snaps"] >= 1):
        touchdowns = td["tds"] if td else (0 if td_rows is not None else None)
        if stat and not stat.get("primary_yards_known", True):
            # A matched row proves presence, but its missing measurement
            # cannot become zero by using the no-stat snap fallback.
            if touchdowns is None:
                return pending("missing_stat_value")
            return {"y": None, "td": touchdowns}
        yards = ([stat["yards"][p] for p in ("QB", "RB", "WR")] if stat
                 else [0, 0, 0] if stat_rows is not None else None)
        return {"y": yards, "td": touchdowns}
    # Absence proves DNP only on the specific named team's published event sheet.
    team = normalize_team(leg.get("team"))
    sheet = [r for r in (snaps_week or {}).get("rows", []) if event_reason(r, game) is None]
    published = {r.get("team") for r in sheet if r.get("source_game_id")}
    if any(not r.get("snaps_valid", True) for r in sheet):
        return pending("snap_count_unknown")
    if team in (game["home"], game["away"]) and published == {game["home"], game["away"]}:
        return {"y": "dnp" if stat_rows is not None else None,
                "td": "dnp" if td_rows is not None else None}
    return pending("no_stat_line")


def grade_fact(fact, market, line=None):
    """Shared settlement transform; browser mirrors this over published facts."""
    if market == "anytime_td":
        value = fact.get("td")
        actual = {"tds": value}
        threshold = 1
    else:
        col = {"qb_pass_yds": 0, "rb_rush_yds": 1, "wr_rec_yds": 2}.get(market)
        if col is None or line is None:
            return "pending", None, "no_line"
        value = fact.get("y")
        value = value[col] if isinstance(value, list) else value
        actual, threshold = value, float(line)
    if value == "dnp":
        return "void", None, "did_not_play"
    if value is None:
        return "pending", None, fact.get("reason", "no_stat_line")
    return ("hit" if value >= threshold else "miss"), actual, None
