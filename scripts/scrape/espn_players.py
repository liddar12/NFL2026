"""ESPN player season data -> fantasy-relevant player records (the N2 feed).

Source: ESPN's Fantasy API (`lm-api-reads.fantasy.espn.com`, keyless — the same
backend espn.com fantasy uses). One paginated query, sorted by real season fantasy
total, returns id/name/position/team/injuryStatus plus per-season stat entries.
League scoring context is `leaguedefaults/3` = ESPN's standard **PPR**, so the
season total is ESPN's own PPR number — no hand-rolled scoring to drift.

Stat-entry selection (the part that MUST NOT regress): an entry is the REAL season
total iff `statSourceId == 0` (actuals, not projections) AND `statSplitTypeId == 0`
(full season, not weekly) AND `seasonId == season`. `statSourceId == 1` is ESPN's
PROJECTION — reading it would silently swap measured reality for someone else's
model, the exact dishonesty this platform exists to avoid.

Ages come from the 32 team-roster calls (`site.api.espn.com .../teams/<id>/roster`),
which carry `age` per athlete; the fantasy payload does not.

WHY NOT the statistics/byathlete API: it has deterministic server-side holes — some
mid-pagination pages return an EMPTY athletes list at any page size (observed:
receiving ranks 26-40, season 2025), silently dropping top players. That is the
silent-data-loss failure mode the loud-feeds rule targets. Do not go back to it.

ID NOTE: canonical player key is nflverse `gsis_id`; ESPN doesn't expose it, so
records are keyed `espn-<id>` until the nflverse cron path lands the mapping.
"""

import json
import urllib.request

from .espn import FeedError, _get_json
from .renames import normalize_team

_KONA_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}"
    "/segments/0/leaguedefaults/3?view=kona_player_info"
)
_ROSTER_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{tid}/roster"
_UA = "nfl2026/1.0 (+https://nfl2026.j5lagenticstrategy.com)"

# ESPN fantasy conventions.
_POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE"}       # defaultPositionId
_SLOT_IDS = [0, 2, 4, 6]                                      # QB, RB, WR, TE slots
_PAGE = 50
_MAX_PLAYERS = 400


def _kona_page(season, offset, limit=_PAGE, timeout=30):
    """One page of the fantasy player pool, sorted by REAL season total desc.
    The filter rides in the X-Fantasy-Filter header (ESPN's own convention)."""
    filt = {
        "players": {
            "filterSlotIds": {"value": _SLOT_IDS},
            "limit": limit,
            "offset": offset,
            "sortAppliedStatTotal": {
                "sortAsc": False, "sortPriority": 1, "value": f"00{int(season)}",
            },
        }
    }
    req = urllib.request.Request(
        _KONA_URL.format(season=int(season)),
        headers={"User-Agent": _UA, "X-Fantasy-Filter": json.dumps(filt)},
    )
    try:
        import requests  # optional; keep parity with espn.py's guarded style
        resp = requests.get(
            _KONA_URL.format(season=int(season)),
            headers={"User-Agent": _UA, "X-Fantasy-Filter": json.dumps(filt)},
            timeout=timeout,
        )
        if resp.status_code != 200:
            raise FeedError(f"fantasy API HTTP {resp.status_code} at offset {offset}")
        return resp.json()
    except ImportError:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)


def _real_season_entry(player, season):
    """The measured full-season stat entry, or None if the player has no actuals.
    See the module docstring for why sourceId/splitType are checked explicitly."""
    for s in player.get("stats") or []:
        if (
            s.get("seasonId") == int(season)
            and s.get("statSourceId") == 0
            and s.get("statSplitTypeId") == 0
        ):
            return s
    return None


def fetch_fantasy_pool(season, min_rows=150):
    """Fantasy-relevant players with REAL `season` PPR totals, sorted desc.

    Returns list of {espn_id, name, position, pro_team_id, injury_status,
    prior_season_points}. Loud if the pool is implausibly small.
    """
    pool, offset = [], 0
    while offset < _MAX_PLAYERS:
        payload = _kona_page(season, offset)
        rows = payload.get("players") or []
        if not rows:
            break
        for row in rows:
            p = row.get("player") or {}
            pos = _POSITION_BY_ID.get(p.get("defaultPositionId"))
            entry = _real_season_entry(p, season)
            total = float(entry.get("appliedTotal") or 0.0) if entry else None
            if not pos or total is None or total <= 0:
                continue
            # Raw receptions ride the SAME actuals entry under statId "53" —
            # exact PPR<->Half<->Standard conversion downstream, never a guess.
            receptions = float((entry.get("stats") or {}).get("53") or 0.0)
            pool.append({
                "espn_id": str(p.get("id")),
                "name": p.get("fullName") or str(p.get("id")),
                "position": pos,
                "pro_team_id": p.get("proTeamId"),
                "injury_status": (p.get("injuryStatus") or "").lower() or None,
                "prior_season_points": round(total, 2),
                "receptions": round(receptions, 1),
            })
        if len(rows) < _PAGE:
            break
        offset += _PAGE
    if len(pool) < min_rows:
        raise FeedError(
            f"fantasy pool for {season} has {len(pool)} players (< {min_rows}) — "
            f"outage or filter drift, failing loudly."
        )
    pool.sort(key=lambda r: (-r["prior_season_points"], r["espn_id"]))
    return pool


def fetch_roster_ages(teams):
    """{espn_athlete_id: age} across all 32 rosters.

    `teams` is espn.fetch_teams()'s output (carries each team's espn_id). A single
    failed roster page fails the whole pull loudly — a partial age map would silently
    disable the age signal for some teams only, which is worse than failing.
    """
    ages = {}
    for ab, t in sorted(teams.items()):
        data = _get_json(_ROSTER_URL.format(tid=t["espn_id"]))
        groups = data.get("athletes") or []
        if not groups:
            raise FeedError(f"roster for {ab} returned no athlete groups")
        for grp in groups:
            for item in grp.get("items") or []:
                if item.get("age") is not None:
                    ages[str(item.get("id"))] = int(item["age"])
    if len(ages) < 800:  # 32 teams x ~53 rostered, most carry an age
        raise FeedError(f"roster ages: only {len(ages)} entries — pull looks broken.")
    return ages


def build_player_records(season, teams):
    """End-to-end N2 feed: fantasy pool + roster ages -> projection-engine inputs.

    Returns list of player dicts shaped for scripts.models.player_projection
    (gsis_id/name/team/position/age/injury_status/prior_season_points), filtered to
    players with a canonical current team.
    """
    pool = fetch_fantasy_pool(season)
    ages = fetch_roster_ages(teams)
    by_pro_id = {int(t["espn_id"]): ab for ab, t in teams.items()}

    records = []
    for p in pool:
        team = by_pro_id.get(p["pro_team_id"])
        if team is None:
            continue  # free agent / no current team -> not projectable to a 2026 role
        records.append({
            "gsis_id": f"espn-{p['espn_id']}",  # interim key; see module docstring
            "name": p["name"],
            "team": team,
            "position": p["position"],
            "age": ages.get(p["espn_id"]),
            "injury_status": p["injury_status"],
            "prior_season_points": p["prior_season_points"],
            "receptions": p["receptions"],
        })
    return records


if __name__ == "__main__":  # manual smoke: python -m scripts.scrape.espn_players
    from . import espn
    teams = espn.fetch_teams()
    recs = build_player_records(2025, teams)
    print(f"records={len(recs)}")
    for r in recs[:8]:
        print(f"  {r['name']:<24} {r['position']:<3} {r['team']:<4} age={r['age']} "
              f"prior={r['prior_season_points']} inj={r['injury_status']}")
