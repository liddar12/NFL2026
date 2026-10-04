"""R110 -- the facts MY BETS grades with (data/bet_facts.json).

MY BETS (R99 E2, re-scoped 2026-10-04) keeps the owner's bets ON THE DEVICE, so
the pipeline can never see them and cannot grade them. It publishes the FACTS
instead, and the browser grades every leg with app/bets.js, a line-for-line
mirror of the graders the pipeline already trusts:

  * games: per week, every scheduled game's teams and, once it is FINAL, its
    score (scripts.resolve_parlay_legs.load_finals: lock receipts < review.json
    < ESPN, STATUS-gated). A game with no final carries no score: a bet on it is
    pending, never graded off a live or stub score.
  * players: per week, for every player the app can put on a bet (the projected
    universe plus this week's leg pool), keyed by the same espn id the legs
    carry:
      y  = [pass, rush, rec] yards from the nflverse stat line;  [0, 0, 0] when
           there is no stat line but the snap sheet shows the player played;  "dnp"
           when the team's snap sheet is published without the player (a void);
           null when there is no evidence either way (pending).
      td = rushing + receiving TDs, with the same three fallbacks (index_td /
           grade_atd's rule, which also covers TEs).
    Exactly the evidence resolve_my_cards.grade_prop and
    resolve_parlay_legs.grade_atd use, so a leg grades the same in both places.
  * excluded: the owner's excluded game ids (R108) -- their legs are void.

Facts only: no probability, no price, nothing the model is trained on.

  python3 scripts/build_bet_facts.py              runner: fetch stats + finals, write
  python3 scripts/build_bet_facts.py --offline    committed inputs only (no stats)
  python3 scripts/build_bet_facts.py --selftest   fixtures, writes nothing
"""
import argparse
import datetime as dt
import json
import os
import sys
import tempfile

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.excluded_games import excluded_ids  # noqa: E402
from scripts.resolve_estimates import fetch_csv, norm_name  # noqa: E402
from scripts.resolve_parlay_legs import (  # noqa: E402
    index_snaps, index_stats, index_td, load_finals, read_csv,
)
from scripts.resolve_my_cards import _snaps  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "bet_facts.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
PROJ_PATH = os.path.join(DATA, "player_projections.json")
POOL_PATH = os.path.join(DATA, "leg_pool.json")
YARD_POSITIONS = ("QB", "RB", "WR")          # y = [pass, rush, rec] -- index_stats' columns
RULE = ("facts only: a game's score appears once it is FINAL; a player's y = [pass, rush, rec] "
        "yards and td = rushing + receiving TDs come from the nflverse stat line, are 0 when "
        "there is none but the player played (snap sheet), 'dnp' when the team's sheet is published "
        "without the player (the leg is void), and null when there is no evidence (pending)")


def _load(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def identities(proj_doc, pool_doc, recorded=None):
    """{espn id: {"name", "team", "position"}} -- every player a bet can name: every
    player on a recorded leg (a player who has since left the projections still has
    bets to grade), the projected universe, and this week's leg pool last (its team
    is today's)."""
    out = {}
    for r in recorded or []:
        if r.get("gsis_id") and r.get("player"):
            out[str(r["gsis_id"])] = {"name": r["player"], "team": r.get("team"),
                                      "position": r.get("position")}
    for p in (proj_doc or {}).get("players") or []:
        if p.get("gsis_id") and p.get("name"):
            out[str(p["gsis_id"])] = {"name": p["name"], "team": p.get("team"),
                                      "position": p.get("position")}
    pool = pool_doc or {}
    for r in list(pool.get("players") or []) + list(pool.get("atd_legs") or []):
        if r.get("gsis_id") and r.get("player"):
            out[str(r["gsis_id"])] = {"name": r["player"], "team": r.get("team"),
                                      "position": r.get("position")}
    return out


RECORD_GLOBS = ("my_cards/*.json", "atd_cards/*.json", "atd_game_cards/*.json",
                "atd_my_cards/*.json")


def recorded_legs(data_dir=DATA):
    """Every leg the pipeline has recorded as offered (MY and every ATD scope, oldest
    week first) plus the parlay-leg ledger: the identities of every player a bet
    taken from a card can name."""
    import glob  # noqa: PLC0415
    rows = []
    for pattern in RECORD_GLOBS:
        for path in sorted(glob.glob(os.path.join(data_dir, pattern))):
            doc = _load(path, {}) or {}
            for c in doc.get("cards") or []:
                rows.extend(c.get("legs") or [])
    rows.extend((_load(os.path.join(data_dir, "estimates", "parlays_2026.json"), {}) or {})
                .get("legs") or [])
    return rows


def _snap_call(name, team, snaps_week):
    """True (on the team's sheet with >= 1 offensive snap), False (sheet published
    without the player), None (no sheet for the team)."""
    if not snaps_week or not team or team not in snaps_week["teams"]:
        return None
    return any(r["norm"] == name and r["team"] == team and r["snaps"] >= 1
               for r in snaps_week["rows"])


def player_facts(ident, stat_rows, td_rows, snaps_week):
    """{"y": ..., "td": ...} for one player-week, or None when there is nothing."""
    name, team, pos = norm_name(ident.get("name")), ident.get("team"), ident.get("position")
    if not name or not team:
        return None
    played = _snap_call(name, team, snaps_week)

    def fallback():
        return {True: 0, False: "dnp"}.get(played)

    y = None
    if pos in YARD_POSITIONS and stat_rows is not None:
        rows = [r for r in stat_rows if r["norm"] == name and r["team"] == team and r["pos"] == pos]
        if len(rows) == 1:
            yd = rows[0]["yards"]
            y = [yd["QB"], yd["RB"], yd["WR"]]
        elif not rows:
            f = fallback()
            y = [0, 0, 0] if f == 0 else f
    td = None
    if td_rows is not None:
        rows = [r for r in td_rows if r["norm"] == name and r["team"] == team]
        if len(rows) == 1:
            td = rows[0]["tds"]
        elif not rows:
            td = fallback()
    if y is None and td is None:
        return None
    return {"y": y, "td": td}


def game_facts(games, finals):
    """{week: {game_id: {"h", "a", "k"[, "hs", "as" | "w"]}}} -- every scheduled game
    and its kickoff, with a score only once it is FINAL (winner-only from a lock
    receipt)."""
    out = {}
    for g in games or []:
        try:
            wk = int(g.get("week"))
        except (TypeError, ValueError):
            continue
        gid = str(g.get("game_id"))
        row = {"h": g.get("home"), "a": g.get("away"), "k": g.get("kickoff_utc")}
        fin = (finals or {}).get(gid)
        if fin and "home_score" in fin:
            row["hs"], row["as"] = int(fin["home_score"]), int(fin["away_score"])
        elif fin and fin.get("winner") in ("home", "away"):
            row["w"] = fin["winner"]
        out.setdefault(wk, {})[gid] = row
    return out


def build(games, finals, idents, stats_by_week, td_by_week, snaps_by_week, excluded,
          season, generated_utc, source):
    gf = game_facts(games, finals)
    weeks = {}
    for wk in sorted(gf):
        started = any(("hs" in r or "w" in r) for r in gf[wk].values())
        if not started and wk not in (stats_by_week or {}):
            continue                                  # nothing to grade in that week yet
        players = {}
        for pid in sorted(idents):
            f = player_facts(idents[pid], (stats_by_week or {}).get(wk),
                             (td_by_week or {}).get(wk), (snaps_by_week or {}).get(wk))
            if f is not None:
                players[pid] = f
        weeks[str(wk)] = {"games": gf[wk], "players": players}
    return {"kind": "bet_facts", "season": int(season), "generated_utc": generated_utc,
            "rule": RULE, "source": source, "excluded": sorted(excluded or []),
            "weeks": weeks}


def write(doc, path=OUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        fh.write("\n")


def run(offline=False, cache_dir=None, out_path=OUT_PATH, now=None):
    sched = _load(SCHEDULE_PATH, {}) or {}
    games = sched.get("games") or []
    season = int(sched.get("season") or (games[0].get("season") if games else 0)
                 or dt.datetime.now(dt.timezone.utc).year)
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    weeks = sorted({int(g["week"]) for g in games if g.get("week") is not None})
    finals, finals_source = load_finals(None, season=season, weeks=weeks, offline=offline)
    idents = identities(_load(PROJ_PATH), _load(POOL_PATH), recorded_legs())
    stats_by_week = td_by_week = snaps_by_week = None
    stats_note = "offline: no stat lines (props and ATD pending)"
    if not offline:
        rows, why = fetch_csv(season, cache_dir)
        if rows is None:
            stats_note = "stat lines unavailable: %s" % why
        else:
            stats_by_week, td_by_week = index_stats(rows), index_td(rows)
            snaps_by_week = _snaps(season, cache_dir, None, False)
            stats_note = "nflverse stats_player_week (%d weeks)%s" % (
                len(stats_by_week), "" if snaps_by_week else "; snap counts unavailable")
    doc = build(games, finals, idents, stats_by_week, td_by_week, snaps_by_week,
                excluded_ids(), season, now, "finals: %s; stats: %s" % (finals_source, stats_note))
    write(doc, out_path)
    n_players = sum(len(w["players"]) for w in doc["weeks"].values())
    print("bet_facts: %d week(s), %d player-week fact(s), %d excluded game(s) -> %s"
          % (len(doc["weeks"]), n_players, len(doc["excluded"]), os.path.relpath(out_path, _ROOT)))
    return doc


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def selftest():
    games = [{"game_id": "G1", "week": 3, "home": "AAA", "away": "BBB", "kickoff_utc": "2026-09-21T17:00Z"},
             {"game_id": "G2", "week": 3, "home": "CCC", "away": "DDD"},
             {"game_id": "G3", "week": 4, "home": "AAA", "away": "CCC"},
             {"game_id": "G4", "week": 5, "home": "BBB", "away": "DDD"}]
    finals = {"G1": {"home_score": 24, "away_score": 17}, "G2": {"winner": "away"}}
    idents = {"p1": {"name": "Al Pha", "team": "AAA", "position": "QB"},
              "p2": {"name": "Bo Ta", "team": "BBB", "position": "RB"},
              "p3": {"name": "Ce Da", "team": "AAA", "position": "WR"},
              "p4": {"name": "De Lt", "team": "CCC", "position": "TE"},
              "p5": {"name": "Ep Si", "team": "DDD", "position": "WR"},
              "p6": {"name": "Ze Ta", "team": "BBB", "position": "WR"}}
    stats = {3: [{"norm": "al pha", "pos": "QB", "team": "AAA",
                  "yards": {"QB": 251.0, "RB": 12.0, "WR": 0.0}},
                 {"norm": "bo ta", "pos": "RB", "team": "BBB",
                  "yards": {"QB": 0.0, "RB": 88.0, "WR": 21.0}}]}
    tds = {3: [{"norm": "al pha", "pos": "QB", "team": "AAA", "tds": 0},
               {"norm": "bo ta", "pos": "RB", "team": "BBB", "tds": 2},
               {"norm": "de lt", "pos": "TE", "team": "CCC", "tds": 1}]}
    snaps = {3: {"teams": {"AAA", "BBB"},
                 "rows": [{"norm": "al pha", "team": "AAA", "snaps": 60.0},
                          {"norm": "ce da", "team": "AAA", "snaps": 31.0},
                          {"norm": "bo ta", "team": "BBB", "snaps": 44.0}]}}
    doc = build(games, finals, idents, stats, tds, snaps, {"G9"}, 2026, "t", "fixture")
    w3 = doc["weeks"]["3"]
    assert set(doc["weeks"]) == {"3"}, "week 4 has no final and no stats; week 5 neither"
    assert w3["games"]["G1"] == {"h": "AAA", "a": "BBB", "k": "2026-09-21T17:00Z", "hs": 24, "as": 17}
    assert w3["games"]["G2"] == {"h": "CCC", "a": "DDD", "k": None, "w": "away"}, "winner-only stays winner-only"
    assert w3["players"]["p1"] == {"y": [251.0, 12.0, 0.0], "td": 0}
    assert w3["players"]["p2"] == {"y": [0.0, 88.0, 21.0], "td": 2}
    assert w3["players"]["p3"] == {"y": [0, 0, 0], "td": 0}, "played, no stat line: zero, not pending"
    assert w3["players"]["p4"] == {"y": None, "td": 1}, "a TE has a TD line and no yards row"
    assert "p5" not in w3["players"], "no sheet for DDD and no line: no evidence -> absent (pending)"
    assert w3["players"]["p6"] == {"y": "dnp", "td": "dnp"}, "sheet published without the player: void"
    assert doc["excluded"] == ["G9"]
    # an in-progress / scheduled game never carries a score
    w = game_facts([{"game_id": "G7", "week": 6, "home": "X", "away": "Y"}], {})
    assert w == {6: {"G7": {"h": "X", "a": "Y", "k": None}}}
    d = tempfile.mkdtemp()
    p = os.path.join(d, "bf.json")
    write(doc, p)
    assert _load(p) == doc
    print("selftest OK: finals only once FINAL (winner-only kept as such); a stat line gives "
          "[pass, rush, rec] + TDs; played-without-a-line is zero, a published sheet without "
          "the player is dnp (void), no evidence is absent (pending); TEs carry TDs only; the excluded "
          "list rides along; weeks with neither a final nor stats are left out")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    run(offline=args.offline, cache_dir=args.cache_dir, out_path=args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
