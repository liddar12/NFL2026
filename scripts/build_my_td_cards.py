"""R101d — record the MY PARLAYS anytime-TD cards -> data/atd_my_cards/{season}_wk{NN}.json.

R87 records what MY offers in the ANY mode (scripts/build_my_cards.py); the TD
modes (ALL TD / MAJORITY TD / 50%+ SCORERS, 2-10 legs, R101c) were built in the
browser and never written down, so nothing graded them. This rebuilds them with
the Python twin of the browser's search (scripts/models/my_cards.py — parity is
locked by tests/feature/r101d_my_td_parity.test.mjs) and appends each card the
first time it is seen, in the SAME record format as the WEEK and GAME ATD cards,
so scripts/resolve_atd_cards.py grades all three (this one under "my_<mode>").

THE RECORDED UNIVERSE (declared, not "everything"): every TEAM seed, every TD
mode, every size 2..10, at the default EVEN dial (it only moves MAJORITY's
non-TD legs), the top-ranked card of each (RANK_KEEP) — the card a viewer sees
first; ~500 cards a week. A card reached from two seeds is one card (its id is
the mode plus its sorted selections).

R101d — ONE GAME MAY SUPPLY MORE THAN TWO LEGS in a TD mode, up to the size
data/joint_backtest.json validated for that mode, and only when it priced
same-game cards as the product; the view and this record apply the same rule
(my_cards.td_max_per_game), so what is graded is what was shown.

PRE-KICKOFF: legs come only from games scheduled and not kicked off at the
pool's generated_utc, and that instant is each card's first_seen_utc.

  python3 scripts/build_my_td_cards.py            write (+ record)
  python3 scripts/build_my_td_cards.py --selftest offline
"""

import argparse
import hashlib
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_atd_cards as W                            # noqa: E402
from scripts.models import my_cards as M                            # noqa: E402
from scripts.models.parlay_builder import _correlation_table        # noqa: E402

DATA = os.path.join(_ROOT, "data")
RECORD_DIR = os.path.join(DATA, "atd_my_cards")
DIAL = "even"
RANK_KEEP = 1
MODES = W.MODES
SIZES = W.SIZES
LEG_FIELDS = ("market", "selection", "model_prob", "line", "player", "team", "position",
              "gsis_id", "game_id", "side")


def _leg(l):
    out = {k: l.get(k) for k in LEG_FIELDS}
    out["model_prob"] = round(float(l["model_prob"]), 4)
    out["game_id"] = str(l.get("game_id"))
    return out


def _card(mode, card):
    legs = [_leg(l) for l in card["legs"]]
    key = "my|" + mode + "|" + "|".join(sorted("%s@%s" % (l["selection"], l["game_id"])
                                               for l in legs))
    p = card["model"]
    return {"card_id": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16], "mode": mode,
            "label": W.MODE_LABEL[mode], "n_legs": len(legs), "legs": legs,
            "model_prob": round(p, 8), "break_even_american": W.break_even_american(p),
            "n_atd": sum(1 for l in legs if l["market"] == W.ATD)}


def offered(pool, games, calib, verdict, as_of):
    """{mode: {size: [card]}} — the TD cards MY would show for every team seed."""
    corr = _correlation_table(M.merged_calib(calib, pool))
    atd = M.upcoming_legs(M.atd_pool_legs(pool), games, as_of)
    other = M.dial_legs(M.upcoming_legs(M.pool_legs(pool), games, as_of), M.DIALS[DIAL])
    seeds = [s for s in M.seed_options(pool) if s.get("kind") == "team"]
    out = {}
    for mode in MODES:
        cap = M.td_max_per_game(mode, verdict)
        seen = set()
        by_size = out.setdefault(mode, {})
        runs = [(None, SIZES)] if mode != "majority_td" else [(n, (n,)) for n in SIZES]
        for n, counts in runs:
            legs, max_non = M.td_legs_for(mode, n or 0, atd, other)
            for seed in seeds:
                cards = M.build_cards(legs, [seed], corr, per_count=RANK_KEEP, counts=counts,
                                      max_non_atd=max_non, max_per_game=cap)
                for c in cards:
                    rec = _card(mode, c)
                    if rec["card_id"] in seen:
                        continue
                    seen.add(rec["card_id"])
                    by_size.setdefault(str(rec["n_legs"]), []).append(rec)
    return out


def run(record_dir=RECORD_DIR):
    pool = W._optional(os.path.join(DATA, "leg_pool.json"))
    atd_bt = W._optional(os.path.join(DATA, "atd_backtest.json"))
    if not pool or not pool.get("atd_legs") or not (atd_bt or {}).get("adopted"):
        return None, 0
    sched = W._optional(os.path.join(DATA, "schedule_full.json")) or {}
    calib = W._optional(os.path.join(DATA, "parlay_backtest.json"))
    verdict = W._optional(os.path.join(DATA, "joint_backtest.json"))
    as_of = pool["generated_utc"]
    modes = offered(pool, sched.get("games") or [], calib, verdict, as_of)
    doc = {"adopted": True, "season": pool["season"], "week": pool["week"],
           "generated_utc": as_of,
           "modes": {m: {"cards": c} for m, c in modes.items()}}
    return doc, W.record(doc, record_dir)


def selftest():
    import tempfile
    games = [{"game_id": "G1", "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-28T17:00Z"},
             {"game_id": "G2", "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-28T20:00Z"},
             {"game_id": "G9", "status": "STATUS_FINAL", "kickoff_utc": "2026-09-20T17:00Z"}]
    atd, players = [], []
    for gid, teams in (("G1", ("AAA", "BBB")), ("G2", ("CCC", "DDD")), ("G9", ("EEE", "FFF"))):
        for j, p in enumerate((0.62, 0.55, 0.51, 0.44, 0.35)):
            team = teams[j % 2]
            atd.append({"gsis_id": "%s%d" % (gid, j), "player": "P %s%d" % (gid, j), "team": team,
                        "position": "RB", "market": "anytime_td", "game_id": gid,
                        "side": "home" if j % 2 == 0 else "away",
                        "rungs": [{"line": 0.5, "selection": "%s%d anytime TD" % (gid, j),
                                   "model_prob": p}]})
        players.append({"gsis_id": "%sy" % gid, "player": "Y %s" % gid, "team": teams[0],
                        "position": "WR", "market": "wr_rec_yds", "game_id": gid, "side": "home",
                        "rungs": [{"line": 39.5, "selection": "%s Y 40+" % gid, "model_prob": 0.5}]})
    pool = {"season": 2026, "week": 4, "generated_utc": "2026-09-25T10:00:00Z",
            "atd_legs": atd, "players": players, "game_legs": []}
    v_prod = {"pricer": "independent", "offered_sizes": {"all_td": [2, 3, 4], "majority_td": [2, 3],
                                                         "scorers_50": [2]}}
    two = offered(pool, games, None, None, pool["generated_utc"])
    wide = offered(pool, games, None, v_prod, pool["generated_utc"])
    per_game = lambda c: max(sum(1 for l in c["legs"] if l["game_id"] == g)  # noqa: E731
                             for g in {l["game_id"] for l in c["legs"]})
    assert all(per_game(c) <= 2 for cs in two["all_td"].values() for c in cs), "no verdict: 2 per game"
    assert any(per_game(c) == 4 for cs in wide["all_td"].values() for c in cs), "verdict: up to 4"
    assert all(per_game(c) <= 4 for cs in wide["all_td"].values() for c in cs)
    assert all(l["game_id"] != "G9" for m in wide.values() for cs in m.values() for c in cs
               for l in c["legs"]), "a finished game is never offered"
    def shape(c):
        return sorted(sum(1 for l in c["legs"] if l["game_id"] == g)
                      for g in {l["game_id"] for l in c["legs"]})
    big = [c for cs in wide["all_td"].values() for c in cs if min(shape(c)) >= 3][0]
    prod = 1.0
    for l in big["legs"]:
        prod *= l["model_prob"]
    assert abs(big["model_prob"] - prod) < 1e-4, "every game 3+ legs: the card is the product"
    assert all(l["model_prob"] >= 0.5 for cs in wide["scorers_50"].values() for c in cs
               for l in c["legs"])
    for cs in wide["majority_td"].values():
        for c in cs:
            assert c["n_atd"] * 2 > c["n_legs"], c
    with tempfile.TemporaryDirectory() as tmp:
        doc = {"adopted": True, "season": 2026, "week": 4, "generated_utc": pool["generated_utc"],
               "modes": {m: {"cards": c} for m, c in wide.items()}}
        assert W.record(doc, tmp) > 0 and W.record(doc, tmp) == 0, "first sight recorded once"
    print("selftest ok: 2 per game without a product verdict, up to the validated size with one, "
          "3+ from one game priced as the product, finished games excluded, mode rules, "
          "first sight recorded once")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc, added = run()
    if doc is None:
        print("my td cards: nothing to record (no adopted anytime-TD legs in the pool)")
        return 0
    counts = {m: {s: len(c) for s, c in b["cards"].items()} for m, b in doc["modes"].items()}
    print("my td cards %s wk %s: %s; %d new card(s) recorded" % (doc["season"], doc["week"],
                                                                counts, added))
    return 0


if __name__ == "__main__":
    sys.exit(main())
