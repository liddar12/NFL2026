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

MARKET BOUNDARY (R21-A3): the same kona payload carries
`ownership.auctionValueAverage` — the ESPN draft room's average winning bid.
That is a MARKET PRICE. It is fetched by `fetch_auction_values()` ONLY, which
is deliberately a SEPARATE function from `fetch_fantasy_pool()`/
`build_player_records()`: the projection-engine input record must never carry a
market field, so the price leaves this module through its own door and lands in
data/adp.json (display + value flags). See validate_data.MARKET_PRICE_FIELDS.
"""

import json
import sys
import urllib.request

from ..availability import normalize_status
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

    REL17 — NORMALIZATION BOUNDARY. `injury_status` leaves this function as a
    CANONICAL code (scripts/availability.CODES) or None, never as ESPN's own
    fantasy-API spelling. That spelling ("injury_reserve", "day_to_day") matched
    nothing downstream, so every consumer's lookup fell through to neutral — F6.
    One vocabulary, mapped once, at the edge. None means WE DO NOT KNOW: it is not
    ACTIVE, it is not a discount, and it is reported on stderr rather than absorbed.
    """
    unmapped = {}
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
            _stats = entry.get("stats") or {}
            receptions = float(_stats.get("53") or 0.0)
            # R28 — COMPLETIONS (statId "1") and ATTEMPTS (statId "0"), from the
            # SAME actuals entry.
            #
            # These were already arriving in every response and being discarded,
            # while the app told the user "pass_cmp is not a stat this app
            # computes". In a league scoring 0.5 a completion that is roughly
            # 150-200 points a season per starting quarterback going uncounted.
            #
            # VERIFIED, NOT ASSUMED. This repo has been burned by ESPN statIds
            # before — build_kdst rejected ESPN outright after a hand decode of
            # its kicker ids reconciled only 33/42 — so the pairing was checked
            # against reality: across the 2025 top-40, completions/attempts lands
            # between 0.58 and 0.72 for every quarterback, which is the plausible
            # NFL completion-rate band and could not hold if either id meant
            # something else. `pass_attempts` is carried precisely so that check
            # stays reproducible downstream instead of living only in a comment.
            completions = float(_stats.get("1") or 0.0)
            pass_attempts = float(_stats.get("0") or 0.0)
            raw_status = (p.get("injuryStatus") or "").strip() or None
            code = normalize_status(raw_status)
            if raw_status and code is None:
                unmapped[raw_status] = unmapped.get(raw_status, 0) + 1
            pool.append({
                "espn_id": str(p.get("id")),
                "name": p.get("fullName") or str(p.get("id")),
                "position": pos,
                "pro_team_id": p.get("proTeamId"),
                "injury_status": code,
                "prior_season_points": round(total, 2),
                "receptions": round(receptions, 1),
                "completions": round(completions, 1),
                "pass_attempts": round(pass_attempts, 1),
            })
        if len(rows) < _PAGE:
            break
        offset += _PAGE
    if unmapped:
        # Visible, not fatal. Unlike the injury REPORT (espn.fetch_injuries raises —
        # that feed is the one carrying long-term absence), an unrecognised fantasy
        # tag costs a band, not a season, and killing the whole player feed over one
        # new ESPN string would be a worse outage than the drift. Loud on stderr, and
        # tests/smoke.sh fails the gate on any unmapped status in committed data.
        print("[warn] unmapped ESPN fantasy injuryStatus (left as unknown, NOT "
              "treated as healthy): "
              + ", ".join(f"{k!r} x{v}" for k, v in sorted(unmapped.items())),
              file=sys.stderr)
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


def _kona_market_page(season, offset, limit=_PAGE, timeout=30):
    """One page of the DRAFT-season player pool sorted by percent-owned desc.

    Deliberately not `_kona_page`: that one sorts by a REALISED season stat total
    (`sortAppliedStatTotal` on `00<season>`), which does not exist for a season
    that has not been played, and whose stat path must not regress. Draft-market
    ordering is ownership, which is populated the moment ESPN opens drafts.
    """
    filt = {
        "players": {
            "filterSlotIds": {"value": _SLOT_IDS},
            "limit": limit,
            "offset": offset,
            "sortPercOwned": {"sortAsc": False, "sortPriority": 1},
        }
    }
    req = urllib.request.Request(
        _KONA_URL.format(season=int(season)),
        headers={"User-Agent": _UA, "X-Fantasy-Filter": json.dumps(filt)},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def fetch_auction_values(season, min_rows=100):
    """ESPN draft-room auction values for `season` — A MARKET PRICE, DISPLAY ONLY.

    Returns list of {espn_id, name, position, auction_value} for players ESPN
    actually prices, sorted by auction_value desc. `auction_value` is
    `ownership.auctionValueAverage`: the average winning bid across ESPN's
    standard-PPR auction leagues, on their default $200 budget.

    HONEST DATA: a player ESPN does not price carries `auctionValueAverage ==
    0.0`, which means UNPRICED, not "worth $0" — those rows are dropped rather
    than shipped as a fabricated free player. The whole PRIOR season reads 0.0
    (ESPN zeroes the field once a season is played), so this MUST be called with
    the upcoming draft season, never with PRIOR_SEASON; a pull that comes back
    all-zero raises rather than silently writing an empty market.

    POLICY: the returned prices may drive display and value flags only. They are
    never a projection input, a fitted weight, or a parlay probability
    (validate_data.MARKET_PRICE_FIELDS pins this mechanically).
    """
    rows_out, offset = [], 0
    while offset < _MAX_PLAYERS:
        payload = _kona_market_page(season, offset)
        rows = payload.get("players") or []
        if not rows:
            break
        for row in rows:
            p = row.get("player") or {}
            pos = _POSITION_BY_ID.get(p.get("defaultPositionId"))
            if not pos:
                continue
            val = (p.get("ownership") or {}).get("auctionValueAverage")
            try:
                val = round(float(val), 2)   # round FIRST: a value that rounds to
            except (TypeError, ValueError):  # $0.00 is unpriced noise, not a price
                continue
            if val <= 0:
                continue  # UNPRICED by ESPN — skipped, never shipped as $0
            rows_out.append({
                "espn_id": str(p.get("id")),
                "name": p.get("fullName") or str(p.get("id")),
                "position": pos,
                "auction_value": val,
            })
        if len(rows) < _PAGE:
            break
        offset += _PAGE
    if len(rows_out) < min_rows:
        raise FeedError(
            f"ESPN auction values for {season}: only {len(rows_out)} priced "
            f"players (< {min_rows}) — wrong season (ESPN zeroes played seasons) "
            f"or an outage. Failing loudly rather than shipping an empty market."
        )
    rows_out.sort(key=lambda r: (-r["auction_value"], r["espn_id"]))
    return rows_out


# Paged deeper than _MAX_PLAYERS on purpose: the current-season pool is sorted by
# OWNERSHIP, the prior-season pool by REALISED points, and the two orders disagree —
# a 2025 producer can sit deeper than rank 400 in 2026 ownership. Paging further
# shrinks the loud fallback count below; it costs 4 extra keyless requests.
_CURRENT_TEAM_MAX = 600


def fetch_current_pro_teams(season, min_rows=150):
    """{espn_id: proTeamId} AS OF TODAY, from the CURRENT (draft) season's pool.

    R33 — THE ROOT CAUSE BEHIND THE R32 INJURY-JOIN INCIDENT. The kona endpoint
    freezes each player object at its OWN season's rosters, so the prior-season
    pull that carries the measured totals also carries LAST season's proTeamId.
    Verified live 2026-08-15: seasons/2025 returns Mike Evans proTeamId 27 (TB),
    Christian Kirk 34 (HOU), Darren Waller 15 (MIA); seasons/2026 returns 25 (SF),
    25 (SF), 29 (CAR) — their real current teams. So the stats MUST keep coming
    from the prior season and the team MUST NOT. This fetch pages the draft
    season's pool sorted by ownership (the only sort that exists before a season
    is played — same convention as fetch_auction_values) and returns the current
    id -> proTeamId map. Loud if the pull is implausibly small: a thin map would
    silently push most of the pool onto the stale-team fallback.
    """
    out, offset = {}, 0
    while offset < _CURRENT_TEAM_MAX:
        payload = _kona_market_page(season, offset)
        rows = payload.get("players") or []
        if not rows:
            break
        for row in rows:
            p = row.get("player") or {}
            if p.get("id") is None:
                continue
            out.setdefault(str(p["id"]), p.get("proTeamId"))
        if len(rows) < _PAGE:
            break
        offset += _PAGE
    if len(out) < min_rows:
        raise FeedError(
            f"current-season ({season}) pro-team map has {len(out)} players "
            f"(< {min_rows}) — outage or filter drift. Failing loudly rather than "
            f"stamping the whole pool with last season's teams."
        )
    return out


def assemble_records(pool, ages, teams, current_pro_teams=None):
    """Pure record assembly (no I/O): fantasy pool + ages (+ current-team map).

    TEAM STAMPING (R33): with `current_pro_teams` (fetch_current_pro_teams output),
    `team` is the player's CURRENT proTeamId; the pool's own prior-season
    pro_team_id is a FALLBACK only — used when the player is absent from the
    current-season pool or his current id does not map (e.g. 0 = free agent
    today, kept on last season's team exactly as the pre-R33 behaviour did
    rather than dropping a draftable player mid-signing). Every fallback is
    counted and reported on stderr so a mapping drift is LOUD, never silent.
    Without the map, behaviour is byte-for-byte the old prior-season stamping
    (standalone/backtest callers unchanged — the R32 apply_to_records discipline).
    """
    by_pro_id = {int(t["espn_id"]): ab for ab, t in teams.items()}

    records, fallbacks = [], []
    for p in pool:
        team = None
        if current_pro_teams is not None:
            team = by_pro_id.get(current_pro_teams.get(p["espn_id"]))
            if team is None and by_pro_id.get(p["pro_team_id"]) is not None:
                fallbacks.append(p["name"])
        if team is None:
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
            # R29 — completions must survive THIS mapping too.
            #
            # R28 read statId 1 in fetch_fantasy_pool and consumed it in
            # build_predictions, and shipped green — because this function
            # rebuilds the record field by field and silently dropped it in
            # between. Nothing failed: build_predictions' .get(..., 0.0) read a
            # missing key as zero, build_weekly omits a zero by design, and the
            # feed came out byte-identical. A no-op that looks exactly like a
            # working feature is the worst shape a bug can take, which is why
            # tests/feature/espn_record_fields.test.mjs now asserts that every
            # stat fetch_fantasy_pool collects reaches the record.
            "completions": p["completions"],
            "pass_attempts": p["pass_attempts"],
        })
    if fallbacks:
        # LOUD, not fatal: each name here still carries a canonical team (last
        # season's), so the pool ships — but a GROWING count means the current-
        # season map is drifting away from the pool and the R32 name-fallback in
        # the injury join is back to doing primary duty. Visible > comfortable.
        shown = ", ".join(sorted(fallbacks)[:15])
        more = "" if len(fallbacks) <= 15 else f", +{len(fallbacks) - 15} more"
        print(f"[warn] current-team stamp fell back to the PRIOR-season team for "
              f"{len(fallbacks)} player(s) (absent from the current-season pool, "
              f"or current proTeamId unmapped — e.g. 0 = free agent): {shown}{more}",
              file=sys.stderr)
    return records


def build_player_records(season, teams, current_season=None):
    """End-to-end N2 feed: fantasy pool + roster ages -> projection-engine inputs.

    Returns list of player dicts shaped for scripts.models.player_projection
    (gsis_id/name/team/position/age/injury_status/prior_season_points), filtered to
    players with a canonical current team.

    `current_season` (R33): the draft season whose rosters stamp `team`. Pass it
    from the live pipeline so offseason movers carry the team they play for NOW
    (measured stats still come from `season`); omit it to keep the old
    prior-season stamping byte-for-byte (standalone history/backtest callers).
    A failed current-team pull raises — same unguarded loudness as the pool
    fetch itself, because silently reverting to last season's teams would
    re-open the exact wrong-team defect this parameter exists to close.
    """
    pool = fetch_fantasy_pool(season)
    ages = fetch_roster_ages(teams)
    current = fetch_current_pro_teams(current_season) if current_season else None
    return assemble_records(pool, ages, teams, current)


if __name__ == "__main__":  # manual smoke: python -m scripts.scrape.espn_players
    from . import espn
    teams = espn.fetch_teams()
    recs = build_player_records(2025, teams, current_season=2026)
    print(f"records={len(recs)}")
    for r in recs[:8]:
        print(f"  {r['name']:<24} {r['position']:<3} {r['team']:<4} age={r['age']} "
              f"prior={r['prior_season_points']} inj={r['injury_status']}")
