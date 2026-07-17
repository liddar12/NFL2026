"""Polymarket NFL market prices (free keyless Gamma API) — DISPLAY ONLY.

Ported from the wc2026-tracker Polymarket scraper pattern (safe-by-default,
de-vig, canonical name mapping). Two surfaces:

  fetch_champion_futures()  The "NFL Champion 2027" Gamma event (= the 2026
                            season's Super Bowl winner; Polymarket titles by
                            the February it resolves): 32+ per-team markets,
                            each groupItemTitle a full team name and
                            outcomePrices a JSON string '["yes","no"]'.
                            De-vigged so the field sums to 1.
  fetch_game_markets()      Per-game winner events under tag_slug=nfl whose
                            title looks like "X vs. Y" — usually absent until
                            game week; emits what exists, gracefully.

USER POLICY (hard rule): DISPLAY ONLY — never an input to predictions,
weights, or parlay probabilities (validate_data.py MARKET_DISPLAY_ONLY).
"""

import json
import urllib.parse
import urllib.request

BASE = "https://gamma-api.polymarket.com"
USER_AGENT = "nfl2026-tracker/1.0 (personal-project)"
_HTTP_TIMEOUT = 20
CHAMPION_TITLE = "NFL Champion 2027"


class PolymarketError(RuntimeError):
    """Loud failure: transport error, non-JSON, or a structurally empty payload."""


def _get_json(path, params=None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return json.load(resp)
    except Exception as exc:  # noqa: BLE001 — surfaced as one loud typed error
        raise PolymarketError(f"Polymarket GET {path} failed: {exc}") from exc


def _nfl_events():
    """Open events tagged nfl. Loud when the tag returns nothing at all."""
    data = _get_json("/events", {"tag_slug": "nfl", "closed": "false", "limit": 100})
    events = data if isinstance(data, list) else data.get("events") or []
    if not events:
        raise PolymarketError("Polymarket tag_slug=nfl returned 0 open events — outage "
                              "or a retagged league, not an empty market.")
    return events


def yes_price(market):
    """YES price [0,1] from a Gamma market's outcomePrices ('[\"0.075\",\"0.925\"]').
    None when absent/unparseable — no fabricated prices."""
    raw = market.get("outcomePrices")
    try:
        prices = json.loads(raw) if isinstance(raw, str) else raw
        p = float(prices[0])
        return p if 0.0 < p < 1.0 else None
    except (TypeError, ValueError, IndexError):
        return None


def devig(rows):
    """Proportionally normalize [{..., prob}] so probs sum to 1 (drops the vig).
    Empty/zero-sum input returns [] — never divides by zero."""
    total = sum(r["prob"] for r in rows)
    if total <= 0:
        return []
    return [{**r, "prob": round(r["prob"] / total, 4)} for r in rows]


def fetch_champion_futures():
    """De-vigged champion prices: list[{name, prob, slug}] sorted prob desc.
    `name` is Polymarket's full team name ("Buffalo Bills") — build_markets maps
    it to a canonical abbrev; unmappable rows are dropped there, loudly."""
    champ = None
    for ev in _nfl_events():
        if (ev.get("title") or "").strip() == CHAMPION_TITLE:
            champ = ev
            break
    if champ is None:
        raise PolymarketError(f"Polymarket event '{CHAMPION_TITLE}' not found under "
                              f"tag nfl — renamed or delisted, refusing to guess.")
    rows = []
    for m in champ.get("markets") or []:
        p = yes_price(m)
        name = (m.get("groupItemTitle") or "").strip()
        if p is None or not name:
            continue
        rows.append({"name": name, "prob": p, "slug": m.get("slug") or ""})
    rows = devig(rows)
    rows.sort(key=lambda r: (-r["prob"], r["name"]))
    return rows


def fetch_game_markets():
    """Per-game winner events (title \"X vs. Y\"), when listed. Best-effort:
    returns list[{title, prices: {name: prob}}]; [] preseason is normal."""
    out = []
    for ev in _nfl_events():
        title = (ev.get("title") or "")
        if " vs" not in title.lower():
            continue
        prices = {}
        for m in ev.get("markets") or []:
            p = yes_price(m)
            name = (m.get("groupItemTitle") or "").strip()
            if p is not None and name:
                prices[name] = p
        if prices:
            out.append({"title": title, "prices": prices})
    return out
