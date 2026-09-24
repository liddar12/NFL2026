"""R101b — measure the SAME-GAME joint pricer and decide what GAME may offer
-> data/joint_backtest.json.

For every past game (2022-25) this rebuilds the legs a same-game card could carry,
each at the probability the app would have priced it at the time, with its real
outcome:
  * anytime TD — scripts/backtest_atd.py walk-forward predictions;
  * yardage rungs — the leg pool calibration (per-fold coefficients where the
    pool backtest has them) on the wide corpus, in-support rungs only;
  * moneyline — the Elo win probability the slate uses.

FIT (seasons FIT_SEASONS). The two-factor loadings of scripts/models/joint.py are
fitted by maximum likelihood on sampled same-game cards: the likelihood of how
many legs of each card hit, plus extra weight on the all-hit event the card is
priced on. Warm-started from the last committed loadings.

MEASURE (seasons HELD_OUT, never fitted on), two card sets, each priced two
ways (the plain product, "independent", and the joint model):
  * `sampled` — CARDS_PER_GAME random cards of 2-10 legs per game for each mode
    (ALL TD, MAJORITY TD, 50%+ SCORERS, and MIXED as the control): breadth;
  * `sizes`   — the card scripts/build_atd_game_cards.py would build for each
    game (its strongest legs, its own pick_legs rule): the product GAME shows.

DECIDE.
  * pricer: "joint" only if its pooled all-hit log loss over `sampled` is LOWER
    than the product's (never-regress against the simpler baseline); otherwise
    GAME cards are priced as the product, and the document says so.
  * per mode and size of `sizes`: OFFERED only if, under the chosen pricer,
    neither the all-hit count nor the "all but one" count of the held-out cards
    is rejected by a two-sided Poisson test at 5 %. A size that fails is not
    offered and the reason is written; a size with too few cards to test (fewer
    than MIN_EXPECTED_TAIL expected all-but-one) is not offered either.

  python3 scripts/backtest_joint.py [--cache DIR]   runner (weekly)
  python3 scripts/backtest_joint.py --selftest      offline
"""

import argparse
import json
import math
import os
import random
import sys
from datetime import datetime, timezone

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models import joint as J                               # noqa: E402

OUT = os.path.join(_ROOT, "data", "joint_backtest.json")
FIT_SEASONS = (2022, 2023)
HELD_OUT = (2024, 2025)
MODES = ("all_td", "majority_td", "scorers_50", "mixed")
SIZES = tuple(range(2, 11))
CARDS_PER_GAME = 3
FIT_CARDS_PER_GAME = 2
ATD_MIN = 0.15
OTHER_BAND = (0.25, 0.95)
ALPHA = 0.05
MIN_EXPECTED_TAIL = 1.0
GH7 = ((-3.750439717725742, 0.000548268855972), (-2.366759410734541, 0.030757123967586),
       (-1.154405394739968, 0.240123178605013), (0.0, 0.457142857142857),
       (1.154405394739968, 0.240123178605013), (2.366759410734541, 0.030757123967586),
       (3.750439717725742, 0.000548268855972))


# ---------------------------------------------------------------------------
# corpus
# ---------------------------------------------------------------------------

def build_corpus(cache=None):
    """{game_key: [leg {type, side, p, y, pid}]} for 2022-25 REG games."""
    from scripts import backtest_atd as A                        # noqa: PLC0415
    from scripts import backtest_parlay as bp                     # noqa: PLC0415
    from scripts import backtest_leg_pool as blp                  # noqa: PLC0415
    uni, tg, _ = A.load_corpus(A.DEFAULT_SEASONS, cache)
    preds = A.walk_forward(uni, tg, (2022, 2023, 2024, 2025))
    pool_bt = bp._load(blp.OUT)
    shipped = bp._load(blp.SHIPPED)
    games = bp.load_games(bp._load(bp.GAMES_META_PATH))
    weekly = bp.load_weekly(bp._load(bp.WEEKLY_ACTUALS_PATH))
    params = bp.load_game_params()
    corpus = bp.PropCorpus(games, weekly, bp.preweek_ratings(games, params), params)
    sd = shipped["props"]["residual_sd"]
    support = {k: tuple(v) for k, v in pool_bt["support"].items()}
    final = {k: [v["a"], v["b"], v["c"]] for k, v in pool_bt["calibration"].items() if v}
    folds = pool_bt.get("per_fold_coefficients") or {}
    atd_by = {}
    for season, rows in preds.items():
        for r in rows:
            atd_by.setdefault((season, r["week"], r["team"]), []).append(r)
    out = {}
    for g in corpus.games:
        season, week = g["season"], g["week"]
        if season not in (2022, 2023, 2024, 2025):
            continue
        key = "%d|%d|%s|%s" % (season, week, g["home"], g["away"])
        p_home = bp.p_home_elo(corpus.pre[(season, week)], g, corpus.params)
        legs = []
        if g["home_score"] != g["away_score"]:
            hw = 1 if g["home_score"] > g["away_score"] else 0
            legs.append({"type": "ML", "side": "home", "p": p_home, "y": hw, "pid": "ML_H"})
            legs.append({"type": "ML", "side": "away", "p": 1 - p_home, "y": 1 - hw, "pid": "ML_A"})
        coef = folds.get(str(season)) or final
        for pos in bp.POSITIONS:
            if not coef.get(pos) or pos not in support:
                continue
            a, b, c = coef[pos]
            lo, hi = support[pos]
            for pid in corpus.by_pos[pos]:
                act = corpus.weekly[pid]["seasons"].get(season, {}).get(week)
                if act is None or act["team"] not in (g["home"], g["away"]):
                    continue
                mu = corpus._blend(pid, pos, season, week)
                if mu is None:
                    continue
                team = act["team"]
                opp = g["away"] if team == g["home"] else g["home"]
                mult = corpus.dvp_multiplier(season, week, opp, pos) or 1.0
                yards = float(act[bp.YARDS_FIELD[pos]] or 0.0)
                p_team = p_home if team == g["home"] else 1 - p_home
                for line in blp.LADDER[pos]:
                    z = (mu * mult - line) / sd[pos]
                    if not lo <= z <= hi:
                        continue
                    p = 1 / (1 + math.exp(-(a + b * z + c * (p_team - 0.5))))
                    legs.append({"type": {"QB": "QBY", "RB": "RBY", "WR": "WRY"}[pos],
                                 "side": "home" if team == g["home"] else "away", "pid": pid,
                                 "p": min(0.95, max(0.05, p)), "y": int(yards >= line)})
        for side, team in (("home", g["home"]), ("away", g["away"])):
            for r in atd_by.get((season, week, team), []):
                legs.append({"type": "ATD_" + r["pos"], "side": side, "pid": r["pid"],
                             "p": r["p_model"], "y": r["y"]})
        out[key] = legs
    return out


# ---------------------------------------------------------------------------
# cards
# ---------------------------------------------------------------------------

def sample_cards(corpus, keys, n, mode, rnd, per_game):
    """Same-game cards of n legs following each mode's rule; one leg per player,
    at most one moneyline per game."""
    cards = []
    for key in keys:
        legs = corpus[key]
        atd = [l for l in legs if l["type"].startswith("ATD_")
               and l["p"] >= (0.5 if mode == "scorers_50" else ATD_MIN)]
        by_pid = {}
        for l in legs:
            if not l["type"].startswith("ATD_") and OTHER_BAND[0] <= l["p"] <= OTHER_BAND[1]:
                by_pid.setdefault(l["pid"], []).append(l)
        k = {"all_td": n, "scorers_50": n, "majority_td": n // 2 + 1, "mixed": 0}[mode]
        for _ in range(per_game):
            if len(atd) < k:
                break
            pick = rnd.sample(atd, k)
            used = {l["pid"] for l in pick}
            need = n - k
            if need:
                pids = [p for p in by_pid if p not in used]
                rnd.shuffle(pids)
                ml = False
                for pid in pids:
                    if need == 0:
                        break
                    if pid.startswith("ML_"):
                        if ml:
                            continue
                        ml = True
                    pick.append(rnd.choice(by_pid[pid]))
                    need -= 1
                if need:
                    continue
            cards.append(pick)
    return cards


def builder_cards(corpus, keys, n, mode):
    """The card scripts/build_atd_game_cards.py would build for each game: the
    game's strongest legs by its own rule (pick_legs), one card per game. This is
    the product GAME shows, so it is the product whose sizes are tested."""
    from scripts.build_atd_game_cards import pick_legs          # noqa: PLC0415
    cards = []
    for key in keys:
        legs = corpus[key]
        atd = sorted((dict(l, model_prob=l["p"], market="anytime_td", gsis_id=l["pid"])
                      for l in legs if l["type"].startswith("ATD_")),
                     key=lambda l: -l["p"])
        best = {}
        for l in legs:
            if not l["type"].startswith("ATD_") and l["p"] > best.get(l["pid"], {"p": -1})["p"]:
                best[l["pid"]] = l
        other = sorted((dict(l, model_prob=l["p"], gsis_id=None if l["type"] == "ML" else l["pid"],
                             market="moneyline" if l["type"] == "ML" else l["type"])
                        for l in best.values()), key=lambda l: -l["p"])
        picked = pick_legs(mode, n, atd, other)
        if picked:
            cards.append(picked)
    return cards


def _kdist(ps):
    d = [1.0]
    for p in ps:
        nd = [0.0] * (len(d) + 1)
        for i, v in enumerate(d):
            nd[i] += v * (1 - p)
            nd[i + 1] += v * p
        d = nd
    return d


def card_dist(legs, loadings, grid=J.GH):
    """Distribution of the number of legs hit under the joint model."""
    n = len(legs)
    rows = []
    for l in legs:
        a, b = loadings.get(l["type"], (0.0, 0.0))
        r = math.sqrt(max(1e-9, 1 - a * a - b * b))
        rows.append((J.Phinv(min(max(l["p"], 1e-9), 1 - 1e-9)),
                     (1.0 if l["side"] == "home" else -1.0) * a, b, r))
    tot = [0.0] * (n + 1)
    for d, wd in grid:
        for s, ws in grid:
            dist = _kdist([J.Phi((t + sa * d + b * s) / r) for t, sa, b, r in rows])
            for i, v in enumerate(dist):
                tot[i] += wd * ws * v
    return tot


def _nll(loadings, data):
    tot = 0.0
    for legs, k in data:
        dist = card_dist(legs, loadings, GH7)
        n = len(legs)
        tot -= math.log(max(dist[k], 1e-12))
        pa = min(max(dist[n], 1e-12), 1 - 1e-12)
        tot -= 3.0 * (math.log(pa) if k == n else math.log(1 - pa))
    return tot


def fit_loadings(corpus, keys, rnd, start=None, step=0.1, min_step=0.02):
    cards = []
    for mode in ("all_td", "majority_td", "mixed"):
        for n in (2, 3, 4, 5, 6):
            cards += sample_cards(corpus, keys, n, mode, rnd, FIT_CARDS_PER_GAME)
    data = [(c, sum(l["y"] for l in c)) for c in cards]
    L = {t: list((start or {}).get(t, (0.1, 0.1))) for t in J.TYPES}
    seen = {l["type"] for c in cards for l in c}
    cur = _nll(L, data)
    while step >= min_step:
        improved = False
        for t in (t for t in J.TYPES if t in seen):       # an absent type cannot move the fit
            for i in (0, 1):
                for dlt in (step, -step):
                    L[t][i] += dlt
                    if L[t][0] ** 2 + L[t][1] ** 2 > 0.97:
                        L[t][i] -= dlt
                        continue
                    new = _nll(L, data)
                    if new < cur - 1e-6:
                        cur, improved = new, True
                    else:
                        L[t][i] -= dlt
        if not improved:
            step /= 2
    return {t: [round(v[0], 4), round(v[1], 4)] for t, v in L.items()}, len(data), round(cur, 3)


# ---------------------------------------------------------------------------
# measure + decide
# ---------------------------------------------------------------------------

def poisson_two_sided(k, mu):
    """Two-sided exact Poisson p-value for observing k with mean mu."""
    if mu <= 0:
        return 1.0 if k == 0 else 0.0
    def pmf(i):
        return math.exp(-mu + i * math.log(mu) - math.lgamma(i + 1))
    pk = pmf(k)
    top = int(max(k, mu) * 4 + 50)
    return min(1.0, sum(pmf(i) for i in range(top) if pmf(i) <= pk * (1 + 1e-9)))


def measure(corpus, keys, loadings, rnd=None, per_game=CARDS_PER_GAME, modes=MODES):
    """Per mode and size, priced both ways. rnd=None measures the builder's own
    cards (one per game); otherwise per_game random cards per game."""
    rows = {}
    for mode in modes:
        for n in SIZES:
            cards = (builder_cards(corpus, keys, n, mode) if rnd is None
                     else sample_cards(corpus, keys, n, mode, rnd, per_game))
            if not cards:
                rows.setdefault(mode, {})[str(n)] = {"n": 0}
                continue
            hits = tail_hits = 0
            e_ind = e_jnt = tail_ind = tail_jnt = ll_ind = ll_jnt = 0.0
            for c in cards:
                k = sum(l["y"] for l in c)
                y = int(k == n)
                hits += y
                tail_hits += int(k >= n - 1)
                di = _kdist([l["p"] for l in c])
                dj = card_dist(c, loadings)
                pi, pj = min(max(di[n], 1e-12), 1 - 1e-12), min(max(dj[n], 1e-12), 1 - 1e-12)
                e_ind += pi
                e_jnt += pj
                tail_ind += di[n] + di[n - 1]
                tail_jnt += dj[n] + dj[n - 1]
                ll_ind -= math.log(pi) if y else math.log(1 - pi)
                ll_jnt -= math.log(pj) if y else math.log(1 - pj)
            rows.setdefault(mode, {})[str(n)] = {
                "n": len(cards), "hits": hits, "tail_hits": tail_hits,
                "expected_independent": round(e_ind, 4), "expected_joint": round(e_jnt, 4),
                "tail_expected_independent": round(tail_ind, 4),
                "tail_expected_joint": round(tail_jnt, 4),
                "log_loss_independent": round(ll_ind / len(cards), 6),
                "log_loss_joint": round(ll_jnt / len(cards), 6)}
    return rows


def decide(rows, pooled_rows=None):
    """pricer from the pooled log loss of `pooled_rows` (the random cards; `rows`
    when absent); each size of `rows` (the builder's cards) offered or not."""
    src = pooled_rows or rows
    ll_i = sum(r["log_loss_independent"] * r["n"] for m in src.values() for r in m.values() if r["n"])
    ll_j = sum(r["log_loss_joint"] * r["n"] for m in src.values() for r in m.values() if r["n"])
    n = sum(r["n"] for m in src.values() for r in m.values())
    pricer = "joint" if ll_j < ll_i else "independent"
    suffix = "joint" if pricer == "joint" else "independent"
    offered = {}
    for mode, sizes in rows.items():
        if mode == "mixed":
            continue
        for size, r in sizes.items():
            if not r["n"]:
                r["offered"], r["reason"] = False, "no held-out game could fill this card"
                continue
            e, et = r["expected_" + suffix], r["tail_expected_" + suffix]
            p_all = poisson_two_sided(r["hits"], e)
            p_tail = poisson_two_sided(r["tail_hits"], et)
            r["p_all"], r["p_tail"] = round(p_all, 4), round(p_tail, 4)
            if et < MIN_EXPECTED_TAIL:
                r["offered"], r["reason"] = False, ("too few held-out cards to test: %.2f expected "
                                                    "with all but one leg hit" % et)
            elif p_all < ALPHA or p_tail < ALPHA:
                r["offered"] = False
                r["reason"] = ("held-out calibration fails: %d all hit vs %.2f priced (p=%.3f), %d "
                               "all-but-one vs %.2f (p=%.3f)" % (r["hits"], e, p_all, r["tail_hits"],
                                                                 et, p_tail))
            else:
                r["offered"] = True
                r["reason"] = ("held-out: %d all hit vs %.2f priced, %d all-but-one vs %.2f"
                               % (r["hits"], e, r["tail_hits"], et))
            offered.setdefault(mode, [])
            if r["offered"]:
                offered[mode].append(int(size))
    return {"pricer": pricer, "pooled": {"cards": n, "log_loss_independent": round(ll_i / max(n, 1), 6),
                                         "log_loss_joint": round(ll_j / max(n, 1), 6)},
            "offered_sizes": offered}


def run(cache=None, out=OUT, seed=101):
    corpus = build_corpus(cache)
    fit_keys = sorted(k for k in corpus if int(k.split("|")[0]) in FIT_SEASONS)
    held = sorted(k for k in corpus if int(k.split("|")[0]) in HELD_OUT)
    try:
        with open(out, encoding="utf-8") as fh:
            start = json.load(fh).get("loadings")
    except (OSError, ValueError):
        start = None
    loadings, n_fit, nll = fit_loadings(corpus, fit_keys, random.Random(seed), start)
    print("fit: %d cards, nll %s, loadings %s" % (n_fit, nll, loadings), flush=True)
    sampled = measure(corpus, held, loadings, random.Random(seed + 1))
    rows = measure(corpus, held, loadings, None, modes=MODES[:3])
    verdict = decide(rows, sampled)
    doc = {"kind": "joint_backtest", "generated_utc": datetime.now(timezone.utc).strftime(
               "%Y-%m-%dT%H:%M:%SZ"),
           "model": "two-factor Gaussian copula (script D, scoring S), scripts/models/joint.py",
           "fit_seasons": list(FIT_SEASONS), "held_out_seasons": list(HELD_OUT),
           "fit": {"cards": n_fit, "neg_log_likelihood": nll}, "loadings": loadings,
           "alpha": ALPHA, "min_expected_tail": MIN_EXPECTED_TAIL,
           "pricer": verdict["pricer"], "pooled": verdict["pooled"],
           "offered_sizes": verdict["offered_sizes"], "sizes": rows, "sampled": sampled,
           "policy": ("GAME cards are priced by `pricer` and offered only at the sizes listed per "
                      "mode; no book price is an input.")}
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    os.replace(tmp, out)
    return doc


def selftest():
    rnd = random.Random(3)
    corpus = {}
    for gi in range(200):
        legs = []
        shoot = rnd.random() < 0.5                       # a shared game factor
        for pi in range(8):
            p = 0.3
            y = 1 if rnd.random() < (0.45 if shoot else 0.15) else 0
            legs.append({"type": "ATD_RB", "side": "home" if pi % 2 else "away",
                         "pid": "p%d" % pi, "p": p, "y": y})
        corpus["2024|1|G%d|H" % gi] = legs
    keys = sorted(corpus)
    L0 = {t: [0.0, 0.0] for t in J.TYPES}
    rows0 = measure(corpus, keys, L0, random.Random(1), per_game=4)
    d0 = decide(rows0)
    assert d0["pricer"] == "independent", "zero loadings tie the product; the simpler one is kept"
    Ls, _, _ = fit_loadings(corpus, keys, random.Random(2), step=0.2, min_step=0.05)
    assert Ls["ATD_RB"][1] > 0.2, ("a shared scoring factor is found", Ls["ATD_RB"])
    rows1 = measure(corpus, keys, Ls, random.Random(1), per_game=4)
    d1 = decide(rows1)
    assert d1["pricer"] == "joint", d1["pooled"]
    assert poisson_two_sided(5, 5.0) > 0.9 and poisson_two_sided(20, 5.0) < 0.001
    big = rows1["all_td"]["8"]
    assert big["n"] == 0 or "offered" in big
    print("selftest ok: product kept when the model adds nothing, a planted shared factor is "
          "found and wins, Poisson test, every size decided with a reason")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--cache")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = run(cache=args.cache)
    print("joint_backtest: pricer=%s pooled %s offered %s" % (doc["pricer"], doc["pooled"],
                                                               doc["offered_sizes"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
