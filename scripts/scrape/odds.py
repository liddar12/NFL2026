"""Betting-market fetchers: The Odds API + Kalshi -> implied probabilities.

Markets are FIRST-CLASS models in this platform (see build spec), not just a benchmark:
the hybrid blender typically hands the market the largest weight. So this module's job
is to turn raw prices into clean implied win-probabilities the game model can ingest.

FREE-TIER BUDGET IS A FIRST-CLASS CONSTRAINT.
The Odds API free tier is metered (a fixed request quota per month, and practical
per-minute politeness). Blowing the quota silently degrades the whole pipeline the way a
404 does — so a `RequestBudget` gate is threaded through every call, decrements on use,
and refuses (loudly) rather than firing a request that would exceed the cap. Kalshi is
generously rate-limited but we budget it too so one runaway loop can't get us throttled.

`requests` is imported inside the fetchers, guarded — the gate runs with no pip install.
Implied-probability math (`american_to_prob`, `devig_two_way`) is PURE stdlib and safe to
import and unit-test anywhere.
"""

import datetime as _dt


class FeedError(RuntimeError):
    """Loud failure: missing dep, non-200, empty payload, or budget exhausted."""


class BudgetExceeded(FeedError):
    """Raised instead of firing a request that would breach the free-tier cap."""


# ---------------------------------------------------------------------------
# Free-tier budget tracker. Deterministic, stdlib-only, injectable clock so tests can
# assert the gating without real time passing.
# ---------------------------------------------------------------------------
class RequestBudget:
    """Tracks calls/day and calls/minute against free-tier limits.

    Defaults reflect a conservative reading of The Odds API free tier: a small daily
    request allowance and a gentle per-minute rate. Tune per provider by constructing
    with explicit caps. The tracker never blocks/sleeps — it *refuses* over-budget calls
    so the caller decides how to back off (the cron simply skips the update that run).
    """

    def __init__(self, per_day=100, per_minute=10, now=None):
        self.per_day = int(per_day)
        self.per_minute = int(per_minute)
        # timestamps (utc datetimes) of recent calls; pruned on each check.
        self._calls = []
        self._now = now or (lambda: _dt.datetime.now(_dt.timezone.utc))

    def _prune(self, now):
        day_ago = now - _dt.timedelta(days=1)
        self._calls = [t for t in self._calls if t > day_ago]

    def remaining_today(self):
        now = self._now()
        self._prune(now)
        return max(0, self.per_day - len(self._calls))

    def check(self, cost=1):
        """Raise BudgetExceeded if `cost` more calls would breach a cap; else OK."""
        now = self._now()
        self._prune(now)
        minute_ago = now - _dt.timedelta(minutes=1)
        in_last_minute = sum(1 for t in self._calls if t > minute_ago)
        if len(self._calls) + cost > self.per_day:
            raise BudgetExceeded(
                f"Odds free-tier DAILY cap would be exceeded: {len(self._calls)}+{cost} "
                f"> {self.per_day}. Skipping this fetch (better a stale market than a "
                f"blown quota that kills the whole day)."
            )
        if in_last_minute + cost > self.per_minute:
            raise BudgetExceeded(
                f"Odds free-tier PER-MINUTE cap would be exceeded: {in_last_minute}+"
                f"{cost} > {self.per_minute}. Back off and retry next cron tick."
            )

    def spend(self, cost=1):
        """Record `cost` calls as spent. Call AFTER a successful request."""
        now = self._now()
        for _ in range(cost):
            self._calls.append(now)


# ---------------------------------------------------------------------------
# Pure implied-probability math (no I/O — unit-testable, mirror-able in JS).
# ---------------------------------------------------------------------------
def american_to_prob(american):
    """Convert American odds to a vig-inclusive implied probability in (0,1).

    +150 -> 100/(150+100) = 0.40 ; -200 -> 200/(200+100) = 0.6667.
    """
    a = float(american)
    if a < 0:
        return (-a) / ((-a) + 100.0)
    return 100.0 / (a + 100.0)


def devig_two_way(p_home_raw, p_away_raw):
    """Remove the bookmaker's overround from a two-way market by normalizing the two
    vig-inclusive probabilities to sum to 1. Returns (p_home, p_away).

    The raw probabilities sum to >1 (the vig); proportional normalization is the
    standard, assumption-light de-vig for a two-outcome market.
    """
    total = p_home_raw + p_away_raw
    if total <= 0:
        raise FeedError("de-vig received non-positive total probability.")
    return p_home_raw / total, p_away_raw / total


def _require_requests():
    try:
        import requests  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover
        raise FeedError(
            "requests is not installed. Install in the pipeline runner only: "
            "`pip install requests`. Never a gate dependency."
        ) from exc
    return requests


# ---------------------------------------------------------------------------
# The Odds API (https://the-odds-api.com) — h2h (moneyline) implied probs.
# ---------------------------------------------------------------------------
_ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds"


def fetch_odds_api(api_key, budget, regions="us", markets="h2h", timeout=20):
    """Fetch NFL moneyline odds and return per-game de-vigged implied probabilities.

    Returns list[dict]: {game_id, home, away, book, prob_home, prob_away, commence_utc}.
    Consumes exactly one budget unit (checked BEFORE, spent AFTER a 200). `api_key` is
    passed by the caller from the environment — this module holds no secret.
    """
    if not api_key:
        raise FeedError("fetch_odds_api called without an api_key (set ODDS_API_KEY).")
    budget.check(cost=1)  # refuse loudly before spending quota
    requests = _require_requests()
    params = {
        "apiKey": api_key,
        "regions": regions,
        "markets": markets,
        "oddsFormat": "american",
    }
    resp = requests.get(_ODDS_API_URL, params=params, timeout=timeout)
    if resp.status_code != 200:
        raise FeedError(
            f"Odds API returned HTTP {resp.status_code} "
            f"(remaining quota header: {resp.headers.get('x-requests-remaining')})."
        )
    budget.spend(cost=1)
    events = resp.json()
    if not events:
        raise FeedError("Odds API returned 0 events — outage or off-season, not empty.")
    out = []
    for ev in events:
        home_name, away_name = ev.get("home_team"), ev.get("away_team")
        for book in ev.get("bookmakers") or []:
            price = _first_h2h(book, home_name, away_name)
            if price is None:
                continue
            ph_raw, pa_raw = american_to_prob(price[0]), american_to_prob(price[1])
            ph, pa = devig_two_way(ph_raw, pa_raw)
            out.append(
                {
                    "game_id": ev.get("id"),
                    "home": home_name,
                    "away": away_name,
                    "book": book.get("key"),
                    "prob_home": round(ph, 6),
                    "prob_away": round(pa, 6),
                    "commence_utc": ev.get("commence_time"),
                }
            )
    if not out:
        raise FeedError("Odds API returned events but no parseable h2h prices.")
    return out


def _first_h2h(book, home_name, away_name):
    """Pull (home_american, away_american) from a bookmaker's h2h market, or None."""
    for market in book.get("markets") or []:
        if market.get("key") != "h2h":
            continue
        prices = {o.get("name"): o.get("price") for o in market.get("outcomes") or []}
        if home_name in prices and away_name in prices:
            return prices[home_name], prices[away_name]
    return None


# ---------------------------------------------------------------------------
# Kalshi (prediction market) — event contracts already price in [0,1] as cents.
# ---------------------------------------------------------------------------
_KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2/markets"


def fetch_kalshi(budget, series_ticker="KXNFLGAME", timeout=20):
    """Fetch Kalshi NFL game-winner contracts and return implied probabilities.

    Kalshi 'yes' prices are in cents (0..100) = an implied probability already, no de-vig
    needed (it's an exchange midpoint, not a book line). Returns list[dict]:
    {ticker, title, prob_yes}. Budgeted like the Odds API so a loop can't get us
    throttled. Public read endpoint — no key required for market listing.
    """
    budget.check(cost=1)
    requests = _require_requests()
    resp = requests.get(_KALSHI_URL, params={"series_ticker": series_ticker, "status": "open"}, timeout=timeout)
    if resp.status_code != 200:
        raise FeedError(f"Kalshi returned HTTP {resp.status_code}.")
    budget.spend(cost=1)
    markets = (resp.json() or {}).get("markets") or []
    if not markets:
        raise FeedError("Kalshi returned 0 markets — outage or no open NFL contracts.")
    out = []
    for m in markets:
        yes_cents = m.get("yes_bid") if m.get("yes_bid") is not None else m.get("last_price")
        if yes_cents is None:
            continue
        out.append(
            {
                "ticker": m.get("ticker"),
                "title": m.get("title"),
                "prob_yes": round(float(yes_cents) / 100.0, 6),  # cents -> probability
            }
        )
    if not out:
        raise FeedError("Kalshi returned markets but none carried a usable price.")
    return out
