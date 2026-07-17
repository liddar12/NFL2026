"""ESPN kona actuals for PAST seasons (2021-2024) — the 5-year-history feed.

Same backend, filter and stat-entry discipline as espn_players (the N2 feed): one
paginated `kona_player_info` query per season against `leaguedefaults/3` (ESPN
standard PPR), sorted by that season's REAL total, and an entry counts as the real
season line iff `statSourceId == 0` AND `statSplitTypeId == 0` AND
`seasonId == season`. See espn_players' docstring for why sourceId 1 (ESPN's own
projection) must never be read as an actual.

Probed live against seasons 2021-2024 (2026-07-16) before this module was written:

  * the paging pattern returns HTTP 200 with full pools for every past season
    (`filterIds` targeting returns HTTP 400 — pagination is the working path);
  * raw stat keys ride the actuals entry: receptions = statId "53",
    targets = statId "58" (Kupp 2021: 145 rec / 191 tgt — matches the record);
  * games played = statId "210" and is RELIABLE (spot-checked: Hurts 15 in 2022,
    CMC 16 in 2023, Hill 16 in 2023, Mahomes 17 in 2022 — all correct), so games
    is included; a value outside 1..18 is treated as absent rather than trusted.

QBs carry no "53"/"58" keys (they don't catch passes) — recorded as 0.0, not None,
so the season rows stay uniformly typed.

Past seasons are ranked by THAT season's total, so a player outside the top
`_MAX_PLAYERS` of a given year simply has no row for that year (they were
fantasy-irrelevant then). The per-season net is wider than the N2 pool's 400 to
catch current stars who were low-ranked back then.
"""

import time

from .espn import FeedError
from .espn_players import _PAGE, _POSITION_BY_ID, _kona_page, _real_season_entry

_MAX_PLAYERS = 600          # wider than the N2 pool: history wants late bloomers' pasts
_PAGE_SLEEP_S = 0.4         # politeness between pages; ~12 pages/season max
_STAT_RECEPTIONS = "53"
_STAT_TARGETS = "58"
_STAT_GAMES = "210"


def _games_or_none(stats):
    """statId 210 as an int game count, or None when absent/implausible (>18, <=0)."""
    raw = stats.get(_STAT_GAMES)
    if raw is None:
        return None
    g = int(float(raw))
    return g if 1 <= g <= 18 else None


def fetch_season_actuals(season, min_rows=150, max_players=_MAX_PLAYERS):
    """REAL `season` PPR actuals: {espn_id: {espn_id, name, position, pts,
    receptions, targets, games}}. games may be None (omitted downstream).

    Loud floor: a pool under `min_rows` for any season 2021+ means outage or
    filter drift, never "a quiet year" — raise, don't return a stump.
    """
    out, offset = {}, 0
    while offset < max_players:
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
            stats = entry.get("stats") or {}
            out[str(p.get("id"))] = {
                "espn_id": str(p.get("id")),
                "name": p.get("fullName") or str(p.get("id")),
                "position": pos,
                "pts": round(total, 2),
                "receptions": round(float(stats.get(_STAT_RECEPTIONS) or 0.0), 1),
                "targets": round(float(stats.get(_STAT_TARGETS) or 0.0), 1),
                "games": _games_or_none(stats),
            }
        if len(rows) < _PAGE:
            break
        offset += _PAGE
        time.sleep(_PAGE_SLEEP_S)
    if len(out) < min_rows:
        raise FeedError(
            f"history pool for {season} has {len(out)} players (< {min_rows}) — "
            f"outage or filter drift, failing loudly."
        )
    return out


def fetch_history(seasons=(2021, 2022, 2023, 2024)):
    """{season: fetch_season_actuals(season)} for every requested past season.
    Any single bad season fails the whole pull — a silently missing year would
    corrupt every trajectory computed from the gap."""
    return {int(s): fetch_season_actuals(s) for s in seasons}


if __name__ == "__main__":  # manual smoke: python -m scripts.scrape.espn_history
    hist = fetch_history()
    for season in sorted(hist):
        pool = hist[season]
        top = max(pool.values(), key=lambda r: r["pts"])
        print(f"{season}: {len(pool)} players; top {top['name']} pts={top['pts']} "
              f"rec={top['receptions']} tgt={top['targets']} g={top['games']}")
