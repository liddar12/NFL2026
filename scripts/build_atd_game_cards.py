"""R101b — this week's SAME-GAME anytime-TD cards for the GAME scope
-> data/atd_game_cards.json.

The GAME twin of scripts/build_atd_cards.py (WEEK). Owner (2026-09-24): GAME goes
up to 10 legs too, with the same ALL TD / MAJORITY TD / 50%+ SCORERS selector.

EVERY LEG OF A CARD IS FROM ONE GAME, so its legs are NOT independent. The card
is priced by the pricer data/joint_backtest.json chose on held-out seasons:
"joint" (the two-factor model of scripts/models/joint.py with its fitted
loadings) only if it beat the plain product there, else "independent" (the
product). A (mode, size) is built ONLY if that backtest offered it — its
held-out all-hit and all-but-one counts were not rejected at 5 % — so a size
the model cannot price honestly is not shown, and the reason is written.
No joint_backtest.json = nothing validated = no card.

SELECTION, per open game, one card per (mode, size), strongest legs first:
  all_td      the game's n best anytime-TD legs (both teams);
  scorers_50  the same, every leg rated 50 % or better;
  majority_td n//2 + 1 best anytime-TD legs, the rest the game's strongest other
              legs (each yardage player's best rung, at most one moneyline),
              never a second leg on a player already on the card.
Legs are data/leg_pool.json legs at the pool's own number (validate_data.py
re-checks every one and re-prices every card). Recorded on first sight in
data/atd_game_cards/{season}_wk{NN}.json and graded by resolve_atd_cards.py.

MARKET POLICY: no book number is read; a card shows the model's hit chance and
the break-even odds it implies.

  python3 scripts/build_atd_game_cards.py            write (+ record)
  python3 scripts/build_atd_game_cards.py --selftest offline
"""

import argparse
import datetime as _dt
import hashlib
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_atd_cards as W                            # noqa: E402
from scripts.models import joint as J                               # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT = os.path.join(DATA, "atd_game_cards.json")
RECORD_DIR = os.path.join(DATA, "atd_game_cards")
MODES = W.MODES
SIZES = W.SIZES


def card_prob(legs, pricer, loadings):
    """The card's model chance under the adopted pricer."""
    if pricer == "joint":
        return J.joint_prob([{"p": l["model_prob"], "side": l["side"], "type": J.leg_type(l)}
                             for l in legs], loadings or {})
    return W._prod(legs)


def pick_legs(mode, n, atd, other):
    """The strongest n legs of ONE game for `mode`, or None if it cannot fill."""
    if mode in ("all_td", "scorers_50"):
        floor = W.SCORER_MIN if mode == "scorers_50" else 0.0
        legs = [l for l in atd if l["model_prob"] >= floor]
        return legs[:n] if len(legs) >= n else None
    m = n // 2 + 1
    if len(atd) < m:
        return None
    legs = list(atd[:m])
    used = {l["gsis_id"] for l in legs}
    ml = False
    for l in other:
        if len(legs) == n:
            break
        if l["gsis_id"] is not None and l["gsis_id"] in used:
            continue
        if l["market"] == "moneyline":
            if ml:
                continue
            ml = True
        used.add(l["gsis_id"])
        legs.append(l)
    return legs if len(legs) == n else None


def _card(mode, legs, pricer, loadings):
    legs = sorted(legs, key=lambda l: (-l["model_prob"], l["selection"]))
    key = "game|" + mode + "|" + "|".join(sorted("%s@%s" % (l["selection"], l["game_id"])
                                                for l in legs))
    p = card_prob(legs, pricer, loadings)
    return {"card_id": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16], "mode": mode,
            "label": W.MODE_LABEL[mode], "n_legs": len(legs), "legs": legs,
            "model_prob": round(p, 8), "break_even_american": W.break_even_american(p),
            "n_atd": sum(1 for l in legs if l["market"] == W.ATD)}


def build(pool, schedule, atd_backtest, joint_backtest, now=None):
    now = now or _dt.datetime.now(_dt.timezone.utc)
    jb = joint_backtest or {}
    pricer = jb.get("pricer")
    adopted = bool((atd_backtest or {}).get("adopted")) and bool((pool or {}).get("atd_legs"))
    doc = {"kind": "atd_game_cards", "season": (pool or {}).get("season"),
           "week": (pool or {}).get("week"), "generated_utc": W._iso(now),
           "pool_generated_utc": (pool or {}).get("generated_utc"), "adopted": adopted,
           "scope": "game", "pricer": pricer if pricer in ("joint", "independent") else None,
           "joint_backtest_utc": jb.get("generated_utc"), "modes": {}, "notes": [
               "Every leg of a card is from one game; the card is priced by the pricer "
               "data/joint_backtest.json chose on held-out seasons.",
               "A size is offered only where the held-out hit counts agreed with the price.",
               "Legs are this week's leg_pool.json legs at the pool's own probability; only "
               "games not yet kicked off are used. No book price is read."]}
    if not adopted:
        doc["notes"].append("No card: the anytime-TD model is not adopted.")
        return doc
    if doc["pricer"] is None:
        doc["notes"].append("No card: the same-game pricer has no held-out verdict yet "
                            "(data/joint_backtest.json).")
        return doc
    atd, other = W.pool_legs(pool, W.upcoming_games(schedule, now))
    loadings = {t: tuple(v) for t, v in (jb.get("loadings") or {}).items()}
    offered = jb.get("offered_sizes") or {}
    for mode in MODES:
        cards, refused = {}, {}
        for n in SIZES:
            if n not in (offered.get(mode) or []):
                why = (((jb.get("sizes") or {}).get(mode) or {}).get(str(n)) or {}).get("reason")
                refused[str(n)] = "not validated on held-out games" + (": " + why if why else "")
                continue
            got = []
            for gid in sorted(atd):
                legs = pick_legs(mode, n, atd[gid], other.get(gid, []))
                if legs:
                    got.append(_card(mode, legs, pricer, loadings))
            if got:
                cards[str(n)] = sorted(got, key=lambda c: (-c["model_prob"], c["card_id"]))
            else:
                refused[str(n)] = ("no open game has %s" % (
                    "%d anytime-TD legs%s" % (n, " at 50%+" if mode == "scorers_50" else "")
                    if mode != "majority_td" else
                    "%d anytime-TD legs and %d other legs" % (n // 2 + 1, n - n // 2 - 1)))
        doc["modes"][mode] = {"cards": cards, "not_offered": refused}
    return doc


def selftest():
    now = _dt.datetime(2026, 9, 27, 12, 0, tzinfo=_dt.timezone.utc)
    sched = {"games": [{"game_id": "G1", "status": "STATUS_SCHEDULED",
                        "kickoff_utc": "2026-09-28T17:00Z"},
                       {"game_id": "G9", "status": "STATUS_FINAL",
                        "kickoff_utc": "2026-09-25T00:15Z"}]}
    atd_legs, players = [], []
    for gid in ("G1", "G9"):
        for j, p in enumerate((0.62, 0.55, 0.51, 0.40, 0.30, 0.22)):
            atd_legs.append({"gsis_id": "%s_a%d" % (gid, j), "player": "Back %d" % j,
                             "team": "HOM" if j % 2 else "AWY", "position": "RB" if j < 3 else "WR",
                             "market": W.ATD, "game_id": gid, "side": "home" if j % 2 else "away",
                             "pricing": "atd_model",
                             "rungs": [{"line": 0.5, "selection": "%s B%d anytime TD" % (gid, j),
                                        "model_prob": p}]})
        players.append({"gsis_id": "%s_a0" % gid, "player": "Back 0", "team": "AWY",
                        "position": "RB", "market": "rb_rush_yds", "game_id": gid, "side": "away",
                        "rungs": [{"line": 29.5, "selection": "%s B0 30+ rush" % gid,
                                   "model_prob": 0.93}]})
        players.append({"gsis_id": "%s_w" % gid, "player": "Wide", "team": "HOM",
                        "position": "WR", "market": "wr_rec_yds", "game_id": gid, "side": "home",
                        "rungs": [{"line": 19.5, "selection": "%s W 20+ rec" % gid,
                                   "model_prob": 0.88}]})
    game_legs = [{"game_id": "G1", "market": "moneyline", "side": s, "team": t,
                  "selection": "%s ML" % t, "model_prob": p}
                 for s, t, p in (("home", "HOM", 0.7), ("away", "AWY", 0.3))]
    pool = {"season": 2026, "week": 3, "generated_utc": "x", "atd_legs": atd_legs,
            "players": players, "game_legs": game_legs}
    jb = {"pricer": "independent", "generated_utc": "y",
          "offered_sizes": {"all_td": [2, 3, 4, 7], "majority_td": [3, 5], "scorers_50": [2, 4]},
          "sizes": {"all_td": {"5": {"reason": "held-out calibration fails"}}}}
    doc = build(pool, sched, {"adopted": True}, jb, now)
    at = doc["modes"]["all_td"]
    assert set(at["cards"]) == {"2", "3", "4"}, at["cards"].keys()
    c3 = at["cards"]["3"][0]
    assert {l["game_id"] for l in c3["legs"]} == {"G1"}, "one game; a kicked-off game never used"
    assert abs(c3["model_prob"] - 0.62 * 0.55 * 0.51) < 1e-9
    assert "held-out calibration fails" in at["not_offered"]["5"], at["not_offered"]
    assert at["not_offered"]["7"].startswith("no open game"), "validated but unfillable"
    assert set(doc["modes"]["scorers_50"]["cards"]) == {"2"}, "only 3 legs at 50%+"
    maj = doc["modes"]["majority_td"]["cards"]["5"][0]
    sels = [l["selection"] for l in maj["legs"]]
    assert maj["n_atd"] == 3 and "G1 B0 30+ rush" not in sels, "no second leg on a player"
    assert sum(1 for l in maj["legs"] if l["market"] == "moneyline") == 1, sels
    jj = dict(jb, pricer="joint", loadings={t: [0.0, 0.5] for t in J.TYPES})
    cj = build(pool, sched, {"adopted": True}, jj, now)["modes"]["all_td"]["cards"]["3"][0]
    assert cj["model_prob"] > c3["model_prob"], "a shared scoring factor lifts an all-TD card"
    assert build(pool, sched, {"adopted": True}, None, now)["modes"] == {}, "no verdict: no card"
    assert build(pool, sched, {"adopted": False}, jb, now)["modes"] == {}
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        assert W.record(doc, tmp) > 0 and W.record(doc, tmp) == 0
    print("selftest ok: one game per card, only validated sizes, unfillable sizes say why, "
          "50%+ floor, majority without a second leg on a player and one moneyline, joint "
          "pricer used when adopted, no verdict = no card, first sight recorded once")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = build(W._optional(os.path.join(DATA, "leg_pool.json")),
                W._optional(os.path.join(DATA, "schedule_full.json")),
                W._optional(os.path.join(DATA, "atd_backtest.json")),
                W._optional(os.path.join(DATA, "joint_backtest.json")))
    W._write(OUT, doc)
    added = W.record(doc, RECORD_DIR)
    counts = {m: {s: len(c) for s, c in b["cards"].items()} for m, b in doc["modes"].items()}
    print("atd_game_cards %s wk %s: adopted=%s pricer=%s, cards %s; %d new card(s) recorded"
          % (doc["season"], doc["week"], doc["adopted"], doc["pricer"], counts, added))
    return 0


if __name__ == "__main__":
    sys.exit(main())
