"""Join Kalshi + Polymarket NFL prices onto OUR schedule -> data/market_prices.json.

DISPLAY ONLY (user policy): this file exists so the UI can show market prices
NEXT TO our probabilities — the scoreboard we measure ourselves against. It is
never an input: no model, optimizer, fit score, or parlay probability reads it
(enforced by validate_data.py's MARKET_DISPLAY_ONLY invariant).

Joining rules (never guess):
  * Kalshi game events carry a date + a concatenated team-code pair
    (KXNFLGAME-26SEP14DENKC). We split the pair at every point where BOTH
    halves are canonical abbrevs and accept only a split that matches a real
    schedule game on that date +/-1 day (TZ slop). No match -> dropped, counted.
  * Team names (Polymarket "Buffalo Bills", Kalshi "Kansas City") map to
    canonical abbrevs via data/fixtures/teams_espn.json identity (location /
    nickname / display) + scrape.renames. Unmappable rows are dropped, counted,
    and reported on stderr — never silently mis-attributed.

Safe-by-default (wc2026 pattern): one source failing loudly does not block the
other; BOTH failing raises. Emitted prices are only real prices (a dead book
emits nothing — most game markets are unpriced until game week).
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import kalshi_nfl, polymarket_nfl  # noqa: E402
from scripts.scrape.renames import normalize_team  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "market_prices.json")

DISPLAY_NOTE = ("DISPLAY ONLY - market prices are shown for comparison and are "
                "never weighted into predictions (user policy; enforced by "
                "validate_data.py MARKET_DISPLAY_ONLY).")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def name_map():
    """{lowercased identity string: abbrev} from the ESPN teams fixture.

    Covers location ("Buffalo"), nickname ("Bills"), and display
    ("Buffalo Bills") so both markets' naming styles resolve. Location
    collisions (New York, Los Angeles) are dropped from the map — an ambiguous
    key must never guess, callers fall back to other identity strings.
    """
    with open(os.path.join(DATA, "fixtures", "teams_espn.json"), encoding="utf-8") as fh:
        teams = json.load(fh)["teams"]
    keys = {}
    collided = set()
    for ab, t in teams.items():
        for raw in (t.get("location"), t.get("name"), t.get("display")):
            if not raw:
                continue
            k = str(raw).strip().lower()
            if k in keys and keys[k] != ab:
                collided.add(k)
            else:
                keys[k] = ab
    for k in collided:
        keys.pop(k, None)
    return keys


def to_abbrev(name, names):
    """Canonical abbrev for a market team name/code, or None (drop, never guess)."""
    if not name:
        return None
    ab = normalize_team(str(name))
    if ab:
        return ab
    return names.get(str(name).strip().lower())


def split_pair(pair, canonical):
    """All (a, b) splits of a concatenated code pair where both halves are
    canonical abbrevs. Usually exactly one; ambiguity is resolved by the
    schedule join, never here."""
    out = []
    for i in range(2, len(pair) - 1):
        a, b = pair[:i], pair[i:]
        if a in canonical and b in canonical:
            out.append((a, b))
    return out


def date_near(kick_iso, date_iso):
    """True when a kickoff (ISO UTC) lands on date_iso +/-1 day (TZ slop)."""
    kick = str(kick_iso or "")[:10]
    if not kick or not date_iso:
        return False
    if kick == date_iso:
        return True
    from datetime import date, timedelta  # noqa: PLC0415 (tiny, local)
    try:
        d = date.fromisoformat(date_iso)
        return kick in ((d - timedelta(days=1)).isoformat(), (d + timedelta(days=1)).isoformat())
    except ValueError:
        return False


def join_kalshi_games(events, schedule, canonical):
    """{game_id: {home_prob, away_prob, ticker}} for PRICED kalshi events that
    match exactly one schedule game. Unmatched/unpriced counted for the report."""
    out, unmatched = {}, 0
    for ev in events:
        if not ev["prices"]:
            continue  # listed but unpriced — nothing to show yet
        candidates = []
        for a, b in split_pair(ev["teams_pair"], canonical):
            for g in schedule:
                if {g["home"], g["away"]} == {a, b} and date_near(g["kickoff_utc"], ev["date"]):
                    candidates.append(g)
        if len({c["game_id"] for c in candidates}) != 1:
            unmatched += 1
            continue
        g = candidates[0]
        home_p = ev["prices"].get(g["home"])
        away_p = ev["prices"].get(g["away"])
        row = {"ticker": ev["event_ticker"]}
        if home_p is not None:
            row["home_prob"] = home_p
        if away_p is not None:
            row["away_prob"] = away_p
        if len(row) > 1:
            out[g["game_id"]] = row
    return out, unmatched


def main():
    with open(os.path.join(DATA, "schedule_full.json"), encoding="utf-8") as fh:
        schedule = json.load(fh)["games"]
    names = name_map()
    canonical = set()
    for g in schedule:
        canonical.add(g["home"])
        canonical.add(g["away"])

    sources = {}
    games = {}
    futures = {"kalshi": [], "polymarket": []}
    failures = []

    # --- Kalshi (games + SB futures) — one source down never blocks the other.
    try:
        events = kalshi_nfl.fetch_game_markets()
        games_k, unmatched = join_kalshi_games(events, schedule, canonical)
        for gid, row in games_k.items():
            games.setdefault(gid, {})["kalshi"] = row
        for r in kalshi_nfl.fetch_sb_futures():
            ab = to_abbrev(r["team_code"], names) or to_abbrev(r["name"], names)
            if ab is None:
                print(f"[warn] kalshi futures team unmapped: {r['team_code']}/{r['name']}",
                      file=sys.stderr)
                continue
            futures["kalshi"].append({"team": ab, "prob": r["prob"], "ticker": r["ticker"]})
        sources["kalshi"] = {"status": "ok",
                             "rows": len(games_k) + len(futures["kalshi"]),
                             "events_seen": len(events), "unmatched": unmatched}
    except Exception as exc:  # noqa: BLE001 — loud, isolated
        failures.append(f"kalshi: {exc}")
        sources["kalshi"] = {"status": "down", "rows": 0}
        print(f"[warn] kalshi markets failed: {exc}", file=sys.stderr)

    # --- Polymarket (champion futures + any listed game markets).
    try:
        rows = polymarket_nfl.fetch_champion_futures()
        dropped = 0
        for r in rows:
            ab = to_abbrev(r["name"], names)
            if ab is None:
                dropped += 1
                print(f"[warn] polymarket futures team unmapped: {r['name']}", file=sys.stderr)
                continue
            futures["polymarket"].append({"team": ab, "prob": r["prob"], "slug": r["slug"]})
        n_games = 0
        for gm in polymarket_nfl.fetch_game_markets():
            mapped = {}
            for nm, p in gm["prices"].items():
                ab = to_abbrev(nm, names)
                if ab:
                    mapped[ab] = p
            for g in schedule:
                if g["home"] in mapped and g["away"] in mapped:
                    games.setdefault(g["game_id"], {})["polymarket"] = {
                        "home_prob": mapped[g["home"]], "away_prob": mapped[g["away"]],
                        "slug": gm["title"],
                    }
                    n_games += 1
                    break
        sources["polymarket"] = {"status": "ok",
                                 "rows": len(futures["polymarket"]) + n_games,
                                 "dropped_unmapped": dropped}
    except Exception as exc:  # noqa: BLE001 — loud, isolated
        failures.append(f"polymarket: {exc}")
        sources["polymarket"] = {"status": "down", "rows": 0}
        print(f"[warn] polymarket markets failed: {exc}", file=sys.stderr)

    if len(failures) == 2:
        raise RuntimeError(f"both market sources failed: {failures}")

    futures["kalshi"] = sorted(futures["kalshi"], key=lambda r: (-r["prob"], r["team"]))[:40]
    futures["polymarket"] = sorted(futures["polymarket"], key=lambda r: (-r["prob"], r["team"]))[:40]

    import datetime as dt  # noqa: PLC0415 (single stamp, mirrors build_predictions)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "updated_utc": now,
        "display_only": True,
        "note": DISPLAY_NOTE,
        "sources": sources,
        "games": {gid: games[gid] for gid in sorted(games)},
        "futures": futures,
    }
    _write(OUT_PATH, doc)
    print(f"wrote {OUT_PATH}: {len(games)} priced games, "
          f"futures kalshi={len(futures['kalshi'])} polymarket={len(futures['polymarket'])}")
    return doc


if __name__ == "__main__":
    main()
