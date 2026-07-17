"""ESPN per-game team-stat fetchers (boxscore summary + quarter linescores).

Feeds the game-script analysis (scripts/build_gamescript.py): per-team rushing and
passing volume for FINAL games, plus per-quarter scoring so a "trailing entering Q4"
state can be reconstructed. Two endpoints:

  - the scoreboard (reused from scripts.scrape.espn — ids, finals gating, and each
    competitor's linescores come from there; nothing is re-derived here), and
  - the summary endpoint per game id:
      https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={id}
    whose boxscore.teams[].statistics carries rushingAttempts, completionAttempts
    ("21/34" -> 34 pass attempts), rushingYards, netPassingYards, possessionTime
    (value is already seconds).

Inherited invariants (same as espn.py):
  1. STATUS-GATING — only FINAL games are fetched; linescores of a live game are
     partial and must never enter the analysis.
  2. LOUD ON ZERO ROWS — an empty boxscore or an unparsable stat raises FeedError
     rather than yielding a hollow row (the silent-404 lesson).

`requests` stays inside espn._get_json (in-function, guarded) — this module adds no
gate-time dependency.
"""

import time as _time

from . import espn
from .espn import FeedError

# Per-game boxscore summary endpoint (NFL).
_SUMMARY_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary"

# Politeness between summary calls; a season is ~272 of them.
_SUMMARY_SLEEP_S = 0.15

# The boxscore stat names we need, mapped to our row keys.
_STAT_KEYS = ("rushingAttempts", "completionAttempts", "rushingYards",
              "netPassingYards", "possessionTime")


def _linescore_points(competitor):
    """Per-quarter points for one competitor from its scoreboard linescores.
    Returns list[int] ordered by period (OT periods included as extra entries).
    Loud if a FINAL game has no linescores — that is a feed gap, not 0-0 quarters."""
    lines = (competitor or {}).get("linescores") or []
    if not lines:
        raise FeedError(
            "ESPN scoreboard: FINAL game competitor has no linescores — feed gap, "
            "refusing to fabricate per-quarter scoring."
        )
    pts = []
    for ls in sorted(lines, key=lambda x: x.get("period") or 0):
        v = ls.get("value")
        if v is None:
            raise FeedError("ESPN linescore period missing a value on a FINAL game.")
        pts.append(int(v))
    return pts


def fetch_final_linescores(season, week, seasontype=2):
    """FINAL games for one week with scores and per-quarter linescores.

    Reuses the espn.py scoreboard fetch machinery (_get_json / _competitors /
    _team_abbrev / FINAL_STATUSES) rather than duplicating it. Loud if the week
    itself returns zero events. Returns list[dict]:
      {game_id, home, away, home_score, away_score,
       home_linescores: [q1..], away_linescores: [q1..]}
    """
    params = {"seasontype": seasontype, "dates": int(season), "week": int(week)}
    data = espn._get_json(espn._SCOREBOARD_URL, params)
    events = data.get("events") or []
    if not events:
        raise FeedError(
            f"ESPN scoreboard season={season} week={week} returned 0 events — outage "
            f"or bad query, not an empty week."
        )
    out = []
    for ev in events:
        status = (((ev.get("status") or {}).get("type")) or {}).get("name")
        if status not in espn.FINAL_STATUSES:
            continue  # STATUS-gated: live/scheduled games never enter the analysis.
        home, away = espn._competitors(ev)
        out.append(
            {
                "game_id": str(ev.get("id")),
                "home": espn._team_abbrev(home),
                "away": espn._team_abbrev(away),
                "home_score": espn._to_int((home or {}).get("score")),
                "away_score": espn._to_int((away or {}).get("score")),
                "home_linescores": _linescore_points(home),
                "away_linescores": _linescore_points(away),
            }
        )
    return out


def _parse_completion_attempts(display):
    """'21/34' -> (21, 34). Loud on any other shape."""
    parts = str(display or "").split("/")
    if len(parts) != 2:
        raise FeedError(f"completionAttempts {display!r} is not 'comp/att'.")
    try:
        return int(parts[0]), int(parts[1])
    except ValueError as exc:
        raise FeedError(f"completionAttempts {display!r} not integer/integer.") from exc


def _stat_number(stat):
    """Numeric value of a boxscore stat row; falls back to displayValue. Loud if
    neither parses — a hole here would silently zero a team's volume."""
    for key in ("value", "displayValue"):
        v = stat.get(key)
        if v is None or v == "-":
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    raise FeedError(f"boxscore stat {stat.get('name')!r} has no numeric value.")


def fetch_game_teamstats(game_id):
    """Team volume stats for one FINAL game from the summary boxscore.

    Returns {abbrev: {home_away, rush_att, pass_att, completions, rush_yds,
    pass_yds, possession_sec}}. Loud on an empty boxscore or a missing stat.
    """
    data = espn._get_json(_SUMMARY_URL, {"event": str(game_id)})
    teams = (data.get("boxscore") or {}).get("teams") or []
    if len(teams) != 2:
        raise FeedError(
            f"ESPN summary event={game_id}: boxscore has {len(teams)} teams "
            f"(expected 2) — empty or malformed boxscore, refusing to continue."
        )
    out = {}
    for t in teams:
        raw = (t.get("team") or {}).get("abbreviation")
        ab = espn.normalize_team(raw)
        if ab is None:
            raise FeedError(f"ESPN summary team '{raw}' unmapped — update renames.py.")
        stats = {s.get("name"): s for s in (t.get("statistics") or [])}
        missing = [k for k in _STAT_KEYS if k not in stats]
        if missing:
            raise FeedError(
                f"ESPN summary event={game_id} team={ab}: missing stats {missing}."
            )
        comp, att = _parse_completion_attempts(stats["completionAttempts"].get("displayValue"))
        out[ab] = {
            "home_away": t.get("homeAway"),
            "rush_att": int(_stat_number(stats["rushingAttempts"])),
            "pass_att": att,
            "completions": comp,
            "rush_yds": int(_stat_number(stats["rushingYards"])),
            "pass_yds": int(_stat_number(stats["netPassingYards"])),
            "possession_sec": int(_stat_number(stats["possessionTime"])),
        }
    return out


def fetch_season_gamestats(season, weeks=range(1, 19), seasontype=2,
                           sleep_s=_SUMMARY_SLEEP_S, log=None):
    """Every FINAL regular-season game of `season` with team volume stats and
    per-quarter linescores merged into one row per game. ~272 summary calls with a
    polite sleep between each. Returns list[dict] (see fetch_final_linescores plus
    a `teams` dict from fetch_game_teamstats, tagged with `week`)."""
    rows = []
    for wk in weeks:
        for g in fetch_final_linescores(season, week=wk, seasontype=seasontype):
            g["week"] = wk
            g["teams"] = fetch_game_teamstats(g["game_id"])
            for ab in (g["home"], g["away"]):
                if ab not in g["teams"]:
                    raise FeedError(
                        f"ESPN summary event={g['game_id']}: boxscore teams "
                        f"{sorted(g['teams'])} do not match scoreboard {ab}."
                    )
            rows.append(g)
            _time.sleep(sleep_s)
        if log:
            log(f"week {wk}: {len(rows)} games cumulative")
    if not rows:
        raise FeedError(
            f"season {season}: zero FINAL games with stats — outage or wrong season, "
            f"not an empty season."
        )
    return rows
