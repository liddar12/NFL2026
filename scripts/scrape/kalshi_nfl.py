"""Kalshi NFL market prices (anonymous public API) — DISPLAY ONLY.

Ported from the battle-tested wc2026-tracker scraper pattern. Anonymous
endpoints only — no API key, User-Agent set, >=0.5s between calls. Two surfaces:

  fetch_game_markets()  KXNFLGAME series: one event per game (ticker like
                        KXNFLGAME-26SEP14DENKC), one market per team (ticker
                        suffix -DEN / -KC = the team code). Returns rows keyed
                        for build_markets to join onto OUR schedule.
  fetch_sb_futures()    KXSB-27 = the 2026 season's Pro Football Champion
                        event (Kalshi numbers it by the February it resolves).

PRICING HONESTY: a market with no last trade and no bid/ask has NO price — we
emit nothing for it rather than fabricating 50/50. In July most game markets
are listed but unpriced; they fill in as liquidity arrives and the cron then
picks them up automatically.

USER POLICY (hard rule): these prices are DISPLAY ONLY. Nothing in the model,
the optimizer, or the parlay probabilities may ever read this module's output
as an input. See validate_data.py's MARKET_DISPLAY_ONLY invariant.
"""

import json
import time
import urllib.parse
import urllib.request

BASE = "https://api.elections.kalshi.com/trade-api/v2"
GAME_SERIES = "KXNFLGAME"
SB_EVENT = "KXSB-27"  # resolves Feb 2027 = champion of the 2026 season
USER_AGENT = "nfl2026-tracker/1.0 (personal-project)"
MIN_INTERVAL = 0.5
_HTTP_TIMEOUT = 20

_last_request = 0.0


class KalshiError(RuntimeError):
    """Loud failure: transport error, non-JSON, or a structurally empty payload."""


def _get_json(path, params=None):
    """Rate-limited anonymous GET against the Kalshi public API."""
    global _last_request
    wait = MIN_INTERVAL - (time.monotonic() - _last_request)
    if wait > 0:
        time.sleep(wait)
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            _last_request = time.monotonic()
            return json.load(resp)
    except Exception as exc:  # noqa: BLE001 — surfaced as one loud typed error
        raise KalshiError(f"Kalshi GET {path} failed: {exc}") from exc


def price_of(market):
    """Probability [0,1] for a market's YES side, or None when unpriced.

    Preference order: last trade, else bid/ask midpoint (both sides needed).
    Kalshi prices are integer cents. Never invents a price for a dead book.
    """
    last = market.get("last_price")
    if isinstance(last, (int, float)) and last > 0:
        return round(float(last) / 100.0, 4)
    bid, ask = market.get("yes_bid"), market.get("yes_ask")
    if (isinstance(bid, (int, float)) and isinstance(ask, (int, float))
            and bid > 0 and ask > 0):
        return round((float(bid) + float(ask)) / 200.0, 4)
    return None


def _paged_events(series_ticker, status="open"):
    """All events of a series, following the cursor. Loud on a totally empty first page."""
    events, cursor = [], None
    while True:
        params = {"series_ticker": series_ticker, "status": status, "limit": 200}
        if cursor:
            params["cursor"] = cursor
        data = _get_json("/events", params)
        page = data.get("events") or []
        events.extend(page)
        cursor = data.get("cursor")
        if not cursor or not page:
            break
    if not events:
        raise KalshiError(
            f"Kalshi series {series_ticker} returned 0 open events — outage or a "
            f"renamed series, not an empty league."
        )
    return events


def parse_game_ticker(event_ticker):
    """(date_iso, teamcode_pair) from e.g. KXNFLGAME-26SEP14DENKC.

    Returns (\"2026-09-14\", \"DENKC\") or None if the shape is unexpected.
    The pair is ambiguous to split (DEN+KC vs DE+NKC) — build_markets resolves
    it against OUR schedule's team abbrevs, never by guessing here.
    """
    parts = str(event_ticker or "").split("-")
    if len(parts) != 2 or len(parts[1]) < 8:
        return None
    body = parts[1]
    yy, mon, rest = body[:2], body[2:5], body[5:]
    day = rest[:2]
    teams = rest[2:]
    months = {"JAN": "01", "FEB": "02", "MAR": "03", "APR": "04", "MAY": "05",
              "JUN": "06", "JUL": "07", "AUG": "08", "SEP": "09", "OCT": "10",
              "NOV": "11", "DEC": "12"}
    if mon not in months or not (yy.isdigit() and day.isdigit()) or not teams:
        return None
    return (f"20{yy}-{months[mon]}-{day}", teams)


def fetch_game_markets():
    """All open KXNFLGAME events with their per-team YES prices.

    Returns list[{event_ticker, date, teams_pair, prices: {TEAMCODE: prob}}]
    — prices holds ONLY priced sides (may be empty preseason).
    """
    out = []
    for ev in _paged_events(GAME_SERIES):
        parsed = parse_game_ticker(ev.get("event_ticker"))
        if parsed is None:
            continue
        date_iso, pair = parsed
        markets = _get_json("/markets", {"event_ticker": ev["event_ticker"],
                                         "limit": 20}).get("markets") or []
        prices = {}
        for m in markets:
            code = str(m.get("ticker", "")).rsplit("-", 1)[-1]
            p = price_of(m)
            if code and p is not None:
                prices[code] = p
        out.append({"event_ticker": ev["event_ticker"], "date": date_iso,
                    "teams_pair": pair, "prices": prices})
    return out


def fetch_sb_futures():
    """The 32 champion markets from KXSB-27 — priced rows only.

    Returns list[{team_code, name, prob, ticker}] sorted prob desc. May be []
    while the book is dead (honest: no price is no price).
    """
    markets = _get_json("/markets", {"event_ticker": SB_EVENT,
                                     "limit": 200}).get("markets") or []
    if not markets:
        raise KalshiError(f"Kalshi {SB_EVENT} returned 0 markets — outage or wrong event.")
    rows = []
    for m in markets:
        p = price_of(m)
        if p is None:
            continue
        rows.append({
            "team_code": str(m.get("ticker", "")).rsplit("-", 1)[-1],
            "name": m.get("yes_sub_title") or "",
            "prob": p,
            "ticker": m.get("ticker"),
        })
    rows.sort(key=lambda r: (-r["prob"], r["team_code"]))
    return rows
