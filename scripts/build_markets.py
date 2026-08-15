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


def source_record(rows, parts_failed=0, parts_total=1, note=None, extra=None):
    """The health record for one market source — the ONLY place its status is set.

    HOUSE RULE (inherited from wc2026, and the reason pipeline_status.py exists):
    every feed asserts its row count and fails LOUDLY — a 0-row write is never
    silently "ok". R30 caught this file stamping kalshi "ok" with rows 0, which
    rolled all the way up to a green MODEL-tab freshness card over an empty feed.

    Kalshi and Polymarket are KEYLESS public APIs, so the "unconfigured" /
    "awaiting config" idiom (what build_predictions writes for odds_api when no
    ODDS_API_KEY is set) can never apply here: these sources are always
    configured, and zero rows from a configured, reachable feed is a
    degradation to surface — not a fact of life and not a crash.

    Decision order (worst wins):
      parts_failed == parts_total -> down      (nothing was reachable)
      parts_failed > 0            -> degraded  (a sub-source broke; note says which)
      rows == 0                   -> degraded  (reachable but delivered NOTHING)
      otherwise                   -> ok

    `extra` merges source-specific counters (events_seen, unmatched,
    dropped_unmapped) into the record; `note` explains any non-ok state.
    """
    rows = int(rows or 0)
    if parts_failed >= parts_total:
        status = "down"
    elif parts_failed > 0:
        status = "degraded"
    elif rows == 0:
        status = "degraded"
        note = note or ("0 rows from a reachable feed - listed events matched "
                        "no schedule game or carried no price")
    else:
        status = "ok"
    rec = {"status": status, "rows": rows}
    rec.update(extra or {})
    if note:
        rec["note"] = note
    return rec


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
        # R30: status comes from source_record, which refuses to say "ok" for a
        # feed that delivered zero rows (26 events seen, 0 rows shipped green).
        sources["kalshi"] = source_record(
            len(games_k) + len(futures["kalshi"]),
            extra={"events_seen": len(events), "unmatched": unmatched})
        if sources["kalshi"]["status"] != "ok":
            print(f"[warn] kalshi reachable but delivered 0 rows "
                  f"({len(events)} events seen) -> degraded", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001 — loud, isolated
        failures.append(f"kalshi: {exc}")
        sources["kalshi"] = source_record(0, parts_failed=1, note=str(exc))
        print(f"[warn] kalshi markets failed: {exc}", file=sys.stderr)

    # --- Polymarket (champion futures + any listed game markets).
    # The two sub-sources get SEPARATE try blocks on purpose. They shared one,
    # and when Polymarket renamed the champion event the futures call threw
    # before the game-market loop ever ran — taking down 15 perfectly good game
    # markets and reporting the whole feed as down. One sub-source failing must
    # cost exactly that sub-source.
    poly_notes = []
    dropped = 0
    n_games = 0
    poly_ok = 0
    try:
        rows = polymarket_nfl.fetch_champion_futures()
        for r in rows:
            ab = to_abbrev(r["name"], names)
            if ab is None:
                dropped += 1
                print(f"[warn] polymarket futures team unmapped: {r['name']}", file=sys.stderr)
                continue
            futures["polymarket"].append({"team": ab, "prob": r["prob"], "slug": r["slug"]})
        poly_ok += 1
    except Exception as exc:  # noqa: BLE001 — loud, isolated
        poly_notes.append(f"futures: {exc}")
        print(f"[warn] polymarket champion futures failed: {exc}", file=sys.stderr)

    try:
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
        poly_ok += 1
    except Exception as exc:  # noqa: BLE001 — loud, isolated
        poly_notes.append(f"games: {exc}")
        print(f"[warn] polymarket game markets failed: {exc}", file=sys.stderr)

    # Honest three-state roll-up via source_record: both halves up = ok (but
    # never with 0 rows — R30), one up = degraded (and it says which half
    # broke), neither = down and it counts as a source failure.
    sources["polymarket"] = source_record(
        len(futures["polymarket"]) + n_games,
        parts_failed=2 - poly_ok, parts_total=2,
        note="; ".join(poly_notes) if poly_notes else None,
        extra={"dropped_unmapped": dropped})
    if poly_ok == 0:
        failures.append(f"polymarket: {'; '.join(poly_notes)}")

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
