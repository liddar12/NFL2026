"""R101 — this week's anytime-TD (ATD) probabilities -> data/atd_week.json (E1-S5).

The model is scripts/backtest_atd.py, imported, not copied: the same history
aggregation, the same team lambda, the same share and R92 depth cascade, the same
parameters. A second implementation of a model is a liability; this file only
decides WHO is priced this week and writes what the model says about them.

WHO IS PRICED. Every QB/RB/WR/TE in this app's player universe whose team plays
this week and whose weekly row says he plays (parlay_builder.playable_this_week —
the gate every prop leg already passes: OUT / DOUBTFUL / IR / suspended / a QB
behind a healthy starter get nothing). The history those players are priced from
is nflverse: last season at weight PARAMS["prev_w"] plus every earlier week of
this one (stats_player, snap counts; ESPN ids -> gsis through the season rosters).

WHO ELSE COUNTS. A team's TDs are shared by everyone who plays, not only the
players this app lists. So an nflverse player who took snaps for the team in the
last cascade window and is NOT one of this app's non-playing players is presumed
active and keeps his share (he is not offered — this app has no row for him).
An app player who does not play this week is absent, and the R92 cascade hands
his share to his position room exactly as it does in the backtest.

GATED TWICE. Nothing is priced unless data/atd_backtest.json says adopted (the
held-out verdict, which the weekly run can also take away on this season's
record); and data/leg_pool.json offers an ATD leg only from a file for its own
week. The 2026 correction layer (atd_backtest.json in_season.live_2026) applies
only when it has earned it on held-out weeks — the R100 rule.

MARKET POLICY: no book number is read here or anywhere in the ATD path.

  python scripts/build_atd_week.py [--cache DIR]   runner: fetch, price, write
  python scripts/build_atd_week.py --selftest      offline
"""

import argparse
import csv
import io
import json
import math
import os
import sys
from datetime import datetime, timezone

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import backtest_atd as A                           # noqa: E402
from scripts.build_backtest_weekly_corpus import CorpusError, fetch_text  # noqa: E402
from scripts.models.parlay_builder import (                     # noqa: E402
    playable_this_week, questionable_label)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "atd_week.json")
BACKTEST_PATH = os.path.join(DATA, "atd_backtest.json")
MARKET = "anytime_td"


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def espn_to_gsis(roster_texts):
    """{"espn-<id>": gsis_id} from nflverse season rosters (latest season wins)."""
    out = {}
    for text in roster_texts:
        for raw in csv.DictReader(io.StringIO(text)):
            espn, gsis = (raw.get("espn_id") or "").strip(), (raw.get("gsis_id") or "").strip()
            if espn and gsis:
                out["espn-%s" % espn.split(".")[0]] = gsis
    return out


def _abbrev(name):
    parts = str(name or "").split()
    return ("%s. %s" % (parts[0][0], " ".join(parts[1:]))) if len(parts) > 1 else str(name)


def _logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def apply_live(p, adj):
    """The R100 layer sigmoid(a + b*logit(p)), or p when no layer is in force."""
    if not adj:
        return p
    return 1.0 / (1.0 + math.exp(-(adj["a"] + adj["b"] * _logit(p))))


def price_week(universe, team_games, season, week, games, app_players, weekly_by_id,
               id_map, params=A.PARAMS, live=None):
    """(rows, counts). Pure.

    games: [{game_id, home, away}] this week. app_players: this app's player
    records ({gsis_id, name, team, position}). id_map: app id -> nflverse gsis."""
    counts = {"app_players": 0, "not_playable": 0, "no_game": 0, "no_history_id": 0,
              "presumed_active_non_app": 0, "priced": 0}
    slot = {}
    for g in games:
        slot[g["home"]] = (g, "home", g["away"], True)
        slot[g["away"]] = (g, "away", g["home"], False)
    app_nfl_ids = {}
    active, offered = [], {}
    absent_nfl = set()
    for p in app_players:
        pos = p.get("position")
        if pos not in A.SKILL:
            continue
        counts["app_players"] += 1
        team = p.get("team")
        if team not in slot:
            counts["no_game"] += 1
            continue
        nfl = id_map.get(p.get("gsis_id"))
        if nfl:
            app_nfl_ids[nfl] = p["gsis_id"]
        rec = weekly_by_id.get(p.get("gsis_id"))
        if rec is None or not playable_this_week(rec, week):
            counts["not_playable"] += 1
            if nfl:
                absent_nfl.add(nfl)
            continue
        if not nfl:
            counts["no_history_id"] += 1
        g, side, opp, home = slot[team]
        pid = nfl or "app:%s" % p["gsis_id"]
        active.append({"season": season, "week": week, "pid": pid, "name": p.get("name"),
                       "pos": pos, "team": team, "opp": opp, "home": home, "carries": 0.0,
                       "targets": 0.0, "rush_tds": 0, "rec_tds": 0})
        offered[pid] = (p, g, side, rec)
    # Everyone else who has been playing for these teams keeps his share.
    seen = {r["pid"] for r in active}
    for back in range(1, params["cascade_weeks"] + 1):
        for key, r in universe.items():
            if key[0] != season or key[1] != week - back or r["team"] not in slot:
                continue
            if r["pid"] in seen or r["pid"] in absent_nfl or r["pid"] in app_nfl_ids:
                continue
            seen.add(r["pid"])
            _, _, opp, home = slot[r["team"]]
            active.append({"season": season, "week": week, "pid": r["pid"], "name": r["name"],
                           "pos": r["pos"], "team": r["team"], "opp": opp, "home": home,
                           "carries": 0.0, "targets": 0.0, "rush_tds": 0, "rec_tds": 0})
            counts["presumed_active_non_app"] += 1
    by_week, tg_week = A._index(universe, team_games)
    by_week[(season, week)] = active
    tg_week[(season, week)] = {t: {"opp": v[2], "home": v[3], "tds": None, "carries": 0.0,
                                   "targets": 0.0} for t, v in slot.items()}
    preds = {r["pid"]: r for r in A.predict_week(season, week, by_week, tg_week, params)}
    rows = []
    for pid, (p, g, side, rec) in offered.items():
        pr = preds.get(pid)
        if pr is None:
            continue
        raw = pr["p_model"]
        prob = min(A.P_CEIL, max(A.P_FLOOR, apply_live(raw, live)))
        row = {"gsis_id": p["gsis_id"], "nflverse_id": None if pid.startswith("app:") else pid,
               "player": p.get("name"), "team": p.get("team"), "position": p.get("position"),
               "market": MARKET, "game_id": str(g.get("game_id")), "side": side,
               "selection": "%s anytime TD" % _abbrev(p.get("name")),
               "model_prob": round(prob, 4), "raw_prob": round(raw, 4),
               "lambda_team": round(pr["lam"], 4), "share": round(pr["share"], 4),
               "has_history": not pid.startswith("app:")}
        q = questionable_label(rec)
        if q:
            row["availability"] = q
        rows.append(row)
        counts["priced"] += 1
    rows.sort(key=lambda r: (r["game_id"], r["team"], -r["model_prob"], r["gsis_id"]))
    return rows, counts


def document(season, week, rows, counts, backtest, now=None):
    adopted = bool((backtest or {}).get("adopted"))
    live_blk = ((backtest or {}).get("in_season") or {}).get("live_2026") or {}
    live = live_blk.get("adjustment") if live_blk.get("applied") else None
    return {
        "kind": "atd_week",
        "season": season,
        "week": week,
        "generated_utc": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "adopted": adopted,
        "verdict": (backtest or {}).get("verdict") or "no atd_backtest.json — nothing is priced",
        "backtest_generated_utc": (backtest or {}).get("generated_utc"),
        "live_adjustment": live,
        "params": dict(A.PARAMS),
        "counts": counts,
        "players": rows if adopted else [],
        "notes": [
            "P(anytime TD) = 1 - exp(-lambda_team * share), scripts/backtest_atd.py's model "
            "on nflverse history before this week. No book price is an input.",
            "Only players whose weekly row says they play are priced; an absent player's "
            "share goes to his position room (R92 cascade).",
            "Empty while atd_backtest.json is not adopted — the held-out gate, re-run weekly "
            "with this season's record.",
        ],
    }


def write_json(path, doc):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def run(cache=None, out=OUT_PATH, now=None):
    parlays = _load(os.path.join(DATA, "parlays.json"))
    season, week = int(parlays["season"]), int(parlays["week"])
    try:
        backtest = _load(BACKTEST_PATH)
    except (OSError, ValueError):
        backtest = None
    games = [{"game_id": g.get("game_id"), "home": g.get("home"), "away": g.get("away")}
             for g in (_load(os.path.join(DATA, "game_predictions.json")).get("games") or [])
             if g.get("home") and g.get("away")]
    weekly_by_id = {r["gsis_id"]: r for r in _load(os.path.join(DATA, "player_weekly.json"))
                    .get("players", []) if r.get("gsis_id")}
    app_players = _load(os.path.join(DATA, "player_projections.json")).get("players", [])
    rows, counts = [], {}
    if backtest and backtest.get("adopted"):
        universe, team_games, _ = A.load_corpus((season - 1,), cache, optional=(season,))
        rosters = []
        for s in (season - 1, season):
            try:
                rosters.append(A._cached(cache, "roster_%d.csv" % s,
                                         lambda s=s: fetch_text(A.ROSTER_URL.format(season=s))))
            except CorpusError as exc:
                print("[warn] roster %d: %s" % (s, exc), file=sys.stderr)
        live_blk = (backtest.get("in_season") or {}).get("live_2026") or {}
        rows, counts = price_week(universe, team_games, season, week, games, app_players,
                                  weekly_by_id, espn_to_gsis(rosters),
                                  live=live_blk.get("adjustment") if live_blk.get("applied")
                                  else None)
    doc = document(season, week, rows, counts, backtest, now)
    write_json(out, doc)
    return doc


# ---------------------------------------------------------------------------
# selftest — offline, synthetic
# ---------------------------------------------------------------------------

def selftest():
    uni, tg = {}, {}
    for w in range(1, 4):
        for team, opp, home in (("AAA", "BBB", True), ("BBB", "AAA", False)):
            g = {"opp": opp, "home": home, "tds": 0, "carries": 0.0, "targets": 0.0}
            for pid, pos, c, t, td in (("n1", "RB", 18, 3, 1), ("n2", "RB", 4, 1, 0),
                                       ("n3", "WR", 0, 8, 1)):
                pid = team + pid
                uni[(2026, w, pid)] = {"season": 2026, "week": w, "pid": pid, "name": pid,
                                       "pos": pos, "team": team, "opp": opp, "home": home,
                                       "carries": float(c), "targets": float(t),
                                       "rush_tds": td if pos == "RB" else 0,
                                       "rec_tds": td if pos == "WR" else 0}
                g["tds"] += td
                g["carries"] += c
                g["targets"] += t
            tg[(2026, w, team)] = g
    games = [{"game_id": "G1", "home": "AAA", "away": "BBB"}]
    app = [{"gsis_id": "espn-1", "name": "Alpha Back", "team": "AAA", "position": "RB"},
           {"gsis_id": "espn-2", "name": "Beta Back", "team": "AAA", "position": "RB"},
           {"gsis_id": "espn-3", "name": "Gamma Wide", "team": "AAA", "position": "WR"},
           {"gsis_id": "espn-9", "name": "Rookie Wide", "team": "AAA", "position": "WR"},
           {"gsis_id": "espn-7", "name": "Bye Guy", "team": "ZZZ", "position": "WR"}]
    ids = {"espn-1": "AAAn1", "espn-2": "AAAn2", "espn-3": "AAAn3"}
    ok = {"this_week": {"playable": True}}
    weekly = {"espn-1": ok, "espn-2": ok, "espn-3": ok, "espn-9": ok, "espn-7": ok}
    both, _ = price_week(uni, tg, 2026, 4, games, app, weekly, ids)
    p = {r["gsis_id"]: r for r in both}
    assert set(p) == {"espn-1", "espn-2", "espn-3", "espn-9"}, p.keys()   # bye team: no game
    assert all(0 < r["model_prob"] < 1 and r["market"] == MARKET for r in both)
    assert p["espn-9"]["has_history"] is False and p["espn-9"]["model_prob"] > 0.001
    assert p["espn-1"]["selection"] == "A. Back anytime TD"
    # the starter OUT: he is not priced, and his backup's price rises (R92 cascade)
    out = dict(weekly, **{"espn-1": {"this_week": {"playable": False}}})
    rows2, c2 = price_week(uni, tg, 2026, 4, games, app, out, ids)
    p2 = {r["gsis_id"]: r for r in rows2}
    assert "espn-1" not in p2 and c2["not_playable"] == 1
    assert p2["espn-2"]["model_prob"] > p["espn-2"]["model_prob"], (p2["espn-2"], p["espn-2"])
    # the live layer moves the number only when handed one
    assert apply_live(0.3, None) == 0.3 and apply_live(0.3, {"a": 0.0, "b": 1.0}) - 0.3 < 1e-9
    # not adopted -> nothing offered, whatever was priced
    doc = document(2026, 4, both, {}, {"adopted": False, "verdict": "NOT ADOPTED — x"})
    assert doc["players"] == [] and doc["adopted"] is False
    print("selftest ok: playable-only, bye team skipped, rookie on the prior, OUT starter's "
          "share cascades to his backup, not adopted = nothing offered")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--cache", help="directory to read/save the nflverse CSVs")
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = run(cache=args.cache, out=args.out)
    print("atd_week %s wk %s: adopted=%s, %d player(s) priced; counts %s"
          % (doc["season"], doc["week"], doc["adopted"], len(doc["players"]), doc["counts"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CorpusError as exc:
        print("ATD WEEK ERROR: %s" % exc, file=sys.stderr)
        sys.exit(1)
