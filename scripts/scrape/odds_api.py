"""The Odds API v4 -> per-game market probabilities for the parlay builder.

Fetches h2h (moneyline), spreads, and totals for the NFL slate and returns them keyed
by OUR schedule game_id, in the exact shape parlay_builder.derive_candidate_legs eats:

    {game_id: {"moneyline": {"home_prob":.., "away_prob":..},
               "spread":    {"home_cover_prob":.., "selection":..},
               "total":     {"over_prob":.., "line":..}}}

Matching is done on (home, away) canonical team abbreviations via renames.normalize_team
(the Odds API uses full "City Nickname" strings, which the RENAMES map already covers).

De-vig is pairwise proportional normalization of the two American-odds implied
probabilities (same math as scrape/odds.py american_to_prob + devig_two_way): for a
two-way market the raw probs sum to >1 by the hold; dividing each by the sum is the
standard assumption-light de-vig.

`parse_event` is PURE (no I/O) so tests can drive it offline with synthetic events.
`requests` is imported inside fetch_markets, guarded — the gate runs with no pip
install. The API key comes from env ODDS_API_KEY; with no key we raise OddsKeyMissing
so the caller degrades loudly-but-gracefully to model-seeded lines.
"""

import os
import sys


class OddsApiError(RuntimeError):
    """Loud failure: missing dep, non-200, or zero usable rows (the silent-404 lesson)."""


class OddsKeyMissing(OddsApiError):
    """No ODDS_API_KEY in the environment. Callers catch this and skip real odds."""


_ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds"


def _require_requests():
    """Import `requests` on demand with one actionable line. Kept out of module scope
    so the gate can import this file without the package present."""
    try:
        import requests  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover - exercised only off the gate
        raise OddsApiError(
            "requests is not installed. Install it in the pipeline runner only: "
            "`pip install requests`. It must NEVER be a gate dependency."
        ) from exc
    return requests


# ---------------------------------------------------------------------------
# Pure odds math (mirrors scrape/odds.py; kept local so this module has no
# import-time coupling and parse_event stays unit-testable in isolation).
# ---------------------------------------------------------------------------
def _american_to_prob(american):
    """American odds -> vig-inclusive implied probability in (0,1).

    +150 -> 100/(150+100) = 0.40 ; -200 -> 200/(200+100) = 0.6667.
    """
    a = float(american)
    if a < 0:
        return (-a) / ((-a) + 100.0)
    return 100.0 / (a + 100.0)


def _devig_pair(p_a_raw, p_b_raw):
    """Pairwise proportional de-vig: normalize the two raw probs to sum to 1."""
    total = p_a_raw + p_b_raw
    if total <= 0:
        raise OddsApiError("de-vig received non-positive total probability.")
    return p_a_raw / total, p_b_raw / total


def _first_market(bookmakers, key):
    """First bookmaker market with `key` that carries outcomes, or None.

    Book order is whatever the API sent; taking the first parseable market keeps the
    result deterministic for a fixed payload without preferring any one book.
    """
    for book in bookmakers or []:
        for market in book.get("markets") or []:
            if market.get("key") == key and market.get("outcomes"):
                return market
    return None


def parse_event(event, matcher):
    """Parse one Odds API event into (game_id, markets_dict), or None if unmatchable.

    event   : one element of the v4 /odds response (home_team, away_team, bookmakers).
    matcher : callable (home_abbr, away_abbr) -> game_id or None. Team names are
              canonicalized with renames.normalize_team before matching; an unmappable
              name or an unmatched pairing returns None (the CALLER counts misses and
              fails loudly on zero matches — this function stays pure).

    Returns markets in parlay_builder shape; each of moneyline/spread/total is included
    only when the event carries a parseable two-sided market for it.
    """
    from scripts.scrape.renames import normalize_team

    home = normalize_team(event.get("home_team"))
    away = normalize_team(event.get("away_team"))
    if home is None or away is None:
        return None
    game_id = matcher(home, away)
    if game_id is None:
        return None

    home_name, away_name = event.get("home_team"), event.get("away_team")
    books = event.get("bookmakers") or []
    markets = {}

    # Moneyline: de-vig the two h2h prices into win probabilities.
    m = _first_market(books, "h2h")
    if m is not None:
        prices = {o.get("name"): o.get("price") for o in m["outcomes"]}
        if prices.get(home_name) is not None and prices.get(away_name) is not None:
            ph, pa = _devig_pair(
                _american_to_prob(prices[home_name]),
                _american_to_prob(prices[away_name]),
            )
            markets["moneyline"] = {
                "home_prob": round(ph, 4),
                "away_prob": round(pa, 4),
            }

    # Spread: de-vig the two cover prices; selection names the home line, e.g. "KC -3.5".
    m = _first_market(books, "spreads")
    if m is not None:
        by_name = {o.get("name"): o for o in m["outcomes"]}
        oh, oa = by_name.get(home_name), by_name.get(away_name)
        if (oh and oa and oh.get("price") is not None and oa.get("price") is not None
                and oh.get("point") is not None):
            ph, pa = _devig_pair(
                _american_to_prob(oh["price"]),
                _american_to_prob(oa["price"]),
            )
            point = float(oh["point"])
            markets["spread"] = {
                "home_cover_prob": round(ph, 4),
                "away_cover_prob": round(pa, 4),
                "selection": "%s %s%g" % (home, "+" if point > 0 else "", point),
            }

    # Total: de-vig Over/Under prices; line is the posted total.
    m = _first_market(books, "totals")
    if m is not None:
        by_name = {o.get("name"): o for o in m["outcomes"]}
        over, under = by_name.get("Over"), by_name.get("Under")
        if (over and under and over.get("price") is not None
                and under.get("price") is not None and over.get("point") is not None):
            po, pu = _devig_pair(
                _american_to_prob(over["price"]),
                _american_to_prob(under["price"]),
            )
            markets["total"] = {
                "over_prob": round(po, 4),
                "line": float(over["point"]),
            }

    if not markets:
        return None
    return game_id, markets


def _build_matcher(schedule_games):
    """(home_abbr, away_abbr) -> game_id lookup from our schedule records.

    schedule_games carry canonical abbrevs already (game_predictions/schedule_full),
    but we still normalize defensively so a legacy spelling can't silently miss.
    """
    from scripts.scrape.renames import normalize_team

    index = {}
    for g in schedule_games:
        home = normalize_team(g.get("home"))
        away = normalize_team(g.get("away"))
        gid = g.get("game_id")
        if home is None or away is None or gid is None:
            raise OddsApiError(
                "schedule game with unmappable team or missing game_id: %r" % (g,)
            )
        index[(home, away)] = str(gid)

    def matcher(home, away):
        return index.get((home, away))

    return matcher


def fetch_markets(schedule_games, api_key=None, regions="us",
                  markets="h2h,spreads,totals", timeout=20):
    """Fetch real NFL lines and key them by OUR schedule game_id.

    schedule_games : list of dicts with game_id/home/away (e.g. game_predictions games).
    api_key        : explicit key, else env ODDS_API_KEY. Missing -> OddsKeyMissing so
                     the caller degrades to model-seeded lines instead of fabricating.

    Returns {game_id: markets_dict} (see module docstring for the shape). Raises
    OddsApiError on non-200, zero events, or zero matched games — an empty result is
    an outage or a matcher drift, never a silent no-op.
    """
    key = api_key if api_key is not None else os.environ.get("ODDS_API_KEY")
    if not key:
        raise OddsKeyMissing(
            "ODDS_API_KEY is not set; real odds unavailable. Callers should catch "
            "OddsKeyMissing and fall back to model-seeded lines."
        )
    if not schedule_games:
        raise OddsApiError("fetch_markets called with an empty schedule slate.")

    matcher = _build_matcher(schedule_games)
    requests = _require_requests()
    resp = requests.get(
        _ODDS_API_URL,
        params={
            "apiKey": key,
            "regions": regions,
            "markets": markets,
            "oddsFormat": "american",
        },
        timeout=timeout,
    )
    if resp.status_code != 200:
        raise OddsApiError(
            "Odds API returned HTTP %s (remaining quota header: %s)."
            % (resp.status_code, resp.headers.get("x-requests-remaining"))
        )
    events = resp.json()
    if not events:
        raise OddsApiError("Odds API returned 0 events — outage or off-season, not empty.")

    out = {}
    unmatched = 0
    for ev in events:
        parsed = parse_event(ev, matcher)
        if parsed is None:
            unmatched += 1
            continue
        gid, mkts = parsed
        if gid not in out:  # first (deterministic) parse per game wins
            out[gid] = mkts
    if unmatched:
        # Loud but non-fatal: the Odds API lists games beyond our slate week.
        print(
            "odds_api: %d of %d events did not match the slate (extra weeks or "
            "name drift)." % (unmatched, len(events)),
            file=sys.stderr,
        )
    if not out:
        raise OddsApiError(
            "Odds API returned %d events but ZERO matched the slate — matcher drift "
            "or wrong week. Refusing to return an empty market map." % len(events)
        )
    return out
