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

SEASONTYPE PASS-THROUGH (Rel17 / F7). Every fetcher here takes `seasontype` and
threads it into the scoreboard query — `2` (regular season) is a DEFAULT, not a
hardcode, and `fetch_game_teamstats` / `fetch_game_playerstats` key on a game id
so they are seasontype-agnostic by construction. `seasontype=1` is the ESPN
preseason (week 1 = the Hall of Fame game, weeks 2-4 = PRE1-PRE3); it is consumed
by scripts/build_preseason.py and by NOTHING else. Preseason box scores are NOT
true performance — starters sit or play a series — so nothing in this module may
merge a seasontype=1 row into a regular-season aggregate; the caller keeps them in
a separate, capped, decaying document.

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


# ---------------------------------------------------------------------------
# Per-PLAYER offensive box scores (Rel17 / F7 — preseason form).
# ---------------------------------------------------------------------------
#
# boxscore.players[] is the athlete-level twin of boxscore.teams[]: one entry per
# team, each carrying `statistics` categories ("passing", "rushing", "receiving",
# "fumbles", plus defensive/special-teams categories we do not read). Every
# category exposes `keys` (stat names) aligned positionally with each athlete's
# `stats` array.
#
# There are NO snap counts anywhere in this payload — ESPN's summary endpoint does
# not carry participation. Callers that need a playing-time weight must say what
# they actually measured (see build_preseason.OPPORTUNITIES) rather than calling an
# opportunity count a snap count.

# The categories we read, and the ESPN key -> our field name map inside each.
# A category present on a team MUST carry all of its keys; a missing column is a
# feed drift, not a zero (the silent-404 lesson applied to columns).
_PLAYER_STAT_MAP = {
    "passing": {
        "completions/passingAttempts": ("completions", "pass_att"),  # "21/34" pair
        "passingYards": "pass_yds",
        "passingTouchdowns": "pass_td",
        "interceptions": "interceptions",
    },
    "rushing": {
        "rushingAttempts": "rush_att",
        "rushingYards": "rush_yds",
        "rushingTouchdowns": "rush_td",
    },
    "receiving": {
        "receptions": "receptions",
        "receivingYards": "rec_yds",
        "receivingTouchdowns": "rec_td",
        "receivingTargets": "targets",
    },
    "fumbles": {
        "fumblesLost": "fumbles_lost",
    },
}

# Every field a returned player line carries, always present, always numeric.
PLAYER_STAT_FIELDS = (
    "completions", "pass_att", "pass_yds", "pass_td", "interceptions",
    "rush_att", "rush_yds", "rush_td",
    "receptions", "rec_yds", "rec_td", "targets",
    "fumbles_lost",
)


def _stat_int(value, label):
    """'44' / '-' / '' -> int. Loud if it is neither blank nor a number: a stat we
    cannot read must not silently become 0 fantasy points."""
    text = str(value if value is not None else "").strip()
    if text in ("", "-", "--"):
        return 0
    try:
        return int(round(float(text.replace(",", ""))))
    except ValueError as exc:
        raise FeedError(
            f"ESPN player stat {label} = {value!r} is not numeric — refusing to "
            f"read it as zero."
        ) from exc


def fetch_game_playerstats(game_id):
    """Per-PLAYER offensive counting stats for ONE game, from the summary boxscore.

    Returns {"espn-<athlete id>": {name, team, <PLAYER_STAT_FIELDS>}} for every
    athlete appearing in a passing/rushing/receiving/fumbles category. Athletes who
    appear only in defensive or special-teams categories are not returned — this
    module has no business scoring them, and standard PPR does not.

    Loud (FeedError) on an empty boxscore, an unmapped team, a category missing one
    of its documented keys, or a non-numeric stat. Kick/punt return yardage is
    deliberately ignored (not scored in standard PPR).
    """
    data = espn._get_json(_SUMMARY_URL, {"event": str(game_id)})
    teams = (data.get("boxscore") or {}).get("players") or []
    if len(teams) != 2:
        raise FeedError(
            f"ESPN summary event={game_id}: boxscore.players has {len(teams)} teams "
            f"(expected 2) — empty or malformed boxscore, refusing to continue."
        )
    out = {}
    for team_block in teams:
        raw = (team_block.get("team") or {}).get("abbreviation")
        ab = espn.normalize_team(raw)
        if ab is None:
            raise FeedError(f"ESPN summary team '{raw}' unmapped — update renames.py.")
        for cat in team_block.get("statistics") or []:
            name = cat.get("name")
            wanted = _PLAYER_STAT_MAP.get(name)
            if wanted is None:
                continue
            keys = list(cat.get("keys") or [])
            missing = [k for k in wanted if k not in keys]
            if missing:
                raise FeedError(
                    f"ESPN summary event={game_id} team={ab} category={name}: "
                    f"missing keys {missing} — column drift, not empty data."
                )
            index = {k: i for i, k in enumerate(keys)}
            for entry in cat.get("athletes") or []:
                athlete = entry.get("athlete") or {}
                aid = athlete.get("id")
                if not aid:
                    raise FeedError(
                        f"ESPN summary event={game_id} team={ab} category={name}: "
                        f"athlete row with no id."
                    )
                stats = entry.get("stats") or []
                row = out.setdefault(
                    "espn-%s" % aid,
                    dict({f: 0 for f in PLAYER_STAT_FIELDS},
                         name=(athlete.get("displayName") or "").strip(), team=ab),
                )
                row["team"] = ab
                for key, field in wanted.items():
                    pos = index[key]
                    if pos >= len(stats):
                        raise FeedError(
                            f"ESPN summary event={game_id} team={ab} category={name}: "
                            f"athlete {row['name']!r} has {len(stats)} stats for "
                            f"{len(keys)} keys."
                        )
                    value = stats[pos]
                    if isinstance(field, tuple):
                        # "21/34" -> completions 21, attempts 34.
                        comp, att = _parse_completion_attempts(value)
                        row[field[0]] += comp
                        row[field[1]] += att
                    else:
                        row[field] += _stat_int(value, f"{name}.{key}")
    if not out:
        raise FeedError(
            f"ESPN summary event={game_id}: zero offensive athletes in the boxscore "
            f"— a FINAL game always has some; refusing to emit an empty game."
        )
    return out


def fetch_preseason_playerstats(season, weeks=range(1, 5), seasontype=1,
                                sleep_s=_SUMMARY_SLEEP_S, log=None):
    """Every FINAL PRESEASON game of `season` with per-player offensive box scores.

    weeks 1-4 of seasontype=1 are the Hall of Fame game plus PRE1-PRE3. STATUS-gated
    like everything else: an in-progress preseason game contributes nothing.

    Returns list[dict]: {game_id, week, home, away, players: {...}} — possibly EMPTY
    when the preseason window has not started (that is not an error; the caller
    writes an honest `available: false` document rather than inventing form).
    Loud (FeedError) only when the scoreboard itself is unusable.
    """
    rows = []
    for wk in weeks:
        games = espn.fetch_scores(season, week=wk, seasontype=seasontype,
                                  final_only=True)
        for g in games:
            rows.append({
                "game_id": g["game_id"],
                "week": wk,
                "home": g["home"],
                "away": g["away"],
                "players": fetch_game_playerstats(g["game_id"]),
            })
            _time.sleep(sleep_s)
        if log:
            log(f"preseason week {wk}: {len(games)} FINAL games "
                f"({len(rows)} cumulative)")
    return rows
