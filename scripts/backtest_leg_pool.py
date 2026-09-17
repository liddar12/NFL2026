#!/usr/bin/env python3
"""R76 never-regress gate for the MY PARLAYS leg pool -> data/leg_pool_backtest.json.

WHY A SECOND CALIBRATION, AND WHY IT IS NOT A DUPLICATE
--------------------------------------------------------
The shipped slate prices ONE player per position per game (the highest projected)
at ONE fixed line: QB 224.5, RB 59.5, WR 59.5. scripts/backtest_parlay.py fits
its logistic on exactly that population, and that fit is what data/parlays.json
ships. My Parlays asks a different question -- price ANY player the user types,
at whatever line he is actually live at -- so it prices ~245 players across a
LADDER of rungs. Measured on the 2023-25 corpus, one coefficient set cannot serve
both populations:

    wide pool      shipped coefficients  skill +0.143  ECE 0.072
                   refit on the wide      skill +0.176  ECE 0.007
    narrow (slate) shipped coefficients  skill +0.036  ECE 0.031
                   refit on the wide      skill +0.022  ECE 0.050

The wide refit is 11x better calibrated where My Parlays lives and WORSE where the
slate lives. So the slate keeps its own fit, untouched, and the pool gets this one.
That separation is also what makes "My Parlays cannot move the shipped slate" a
structural fact rather than a promise: nothing here writes to props.calibration.

THE SUPPORT RULE (no extrapolation, by construction)
-----------------------------------------------------
A rung is offered ONLY when its z = (projected yards - line) / residual_sd falls
inside the z range the corpus actually covers for that position. Rungs outside it
are refused, and refusing them is not caution for its own sake -- measured, the
out-of-support rungs are where the model knows least (WR: skill +0.013, ECE 0.133
against +0.126 / 0.092 in support). Offering them would put confident-looking
numbers on the screen for questions the model has never been asked.

WALK-FORWARD, NO PEEKING. Fold season S fits on seasons < S only. The selftest
plants a signal to prove the harness finds one, shuffles the outcome to prove it
refuses noise, and tampers with a later season to prove none leaks into an
earlier fold.

  python3 scripts/backtest_leg_pool.py            write data/leg_pool_backtest.json
  python3 scripts/backtest_leg_pool.py --gate     exit non-zero on a regression
  python3 scripts/backtest_leg_pool.py --selftest planted-signal + refusal proofs
"""
import argparse
import datetime as _dt
import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import scripts.backtest_parlay as bp  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT = os.path.join(DATA, "leg_pool_backtest.json")
SHIPPED = os.path.join(DATA, "parlay_backtest.json")

# The rungs offered per position. Round, book-shaped numbers, dense enough at the
# low end that a role player has a rung he is genuinely live at: the median WR
# projects ~32 yards, so a ladder starting at 39.5 would leave half the league
# with nothing to bet. The SUPPORT RULE below, not this list, decides what ships.
LADDER = {
    "QB": [124.5, 149.5, 174.5, 199.5, 224.5, 249.5, 274.5],
    "RB": [19.5, 29.5, 39.5, 49.5, 59.5, 69.5, 79.5, 99.5],
    "WR": [19.5, 29.5, 39.5, 49.5, 59.5, 69.5, 79.5, 99.5],
}
MIN_ROWS = 5000        # below this the wide corpus cannot answer the question
MIN_FOLDS = 2
ECE_BINS = 10
# The refit must beat the shipped coefficients ON THE WIDE CORPUS by at least
# this much calibration error, and must not lose skill. A tie is a refusal.
ADOPT_ECE_MARGIN = 0.005
# ...and it must carry real information in absolute terms. A perfectly calibrated
# coin flip has ECE 0 and skill 0: honest, and useless for ranking legs. Without
# this floor the gate adopts noise the moment noise is better calibrated than an
# ill-fitting baseline, which the selftest demonstrates it would.
MIN_SKILL = 0.02


def _ll(pairs):
    if not pairs:
        return None
    t = 0.0
    for p, y in pairs:
        p = min(max(p, 1e-9), 1.0 - 1e-9)
        t += -(y * math.log(p) + (1 - y) * math.log(1 - p))
    return t / len(pairs)


def ece(pairs, bins=ECE_BINS):
    """Expected calibration error: when we say 60%, does it land 60% of the time?

    THE metric for a leg pool. Log-loss alone is useless across mixed line
    difficulty -- a deep player at a high rung is an easy 'no', so the loss falls
    without the model knowing anything. A parlay multiplies its legs, so a leg
    that is wrong by 10 points compounds; calibration is what must hold."""
    if not pairs:
        return None
    buckets = {}
    for p, y in pairs:
        buckets.setdefault(min(int(p * bins), bins - 1), []).append((p, y))
    n = len(pairs)
    return sum(
        (len(v) / n) * abs(sum(p for p, _ in v) / len(v) - sum(y for _, y in v) / len(v))
        for v in buckets.values())


def skill(pairs):
    """1 - loss / base-rate loss. Measured against the SAME set's own base rate,
    so an easier population cannot inflate it -- which raw log-loss can."""
    if not pairs:
        return None
    base = sum(y for _, y in pairs) / len(pairs)
    denom = _ll([(base, y) for _, y in pairs])
    return None if not denom else 1.0 - _ll(pairs) / denom


def reliability(pairs, bins=ECE_BINS):
    """The said-vs-happened table, so a miscalibration is visible as a shape and
    not just a scalar."""
    buckets = {}
    for p, y in pairs:
        buckets.setdefault(min(int(p * bins), bins - 1), []).append((p, y))
    out = []
    for k in sorted(buckets):
        v = buckets[k]
        said = sum(p for p, _ in v) / len(v)
        happened = sum(y for _, y in v) / len(v)
        out.append({"bin": [round(k / bins, 2), round((k + 1) / bins, 2)],
                    "n": len(v), "said": round(said, 4),
                    "happened": round(happened, 4), "gap": round(happened - said, 4)})
    return out


def support_from(corpus, sd):
    """The z range the NARROW corpus actually covers, per position. This is the
    calibration's real domain; everything outside it is extrapolation."""
    zs = {pos: [] for pos in bp.POSITIONS}
    for r in corpus.rows:
        pos = r["pos"]
        zs[pos].append((r["mu"] * r["mult"] - bp.LINES[pos]) / sd[pos])
    return {pos: (min(v), max(v)) for pos, v in zs.items() if v}


def wide_rows(corpus, sd, support, ladder=None):
    """One row per (game, player, in-support rung). Same blend, same DvP
    multiplier and same Elo team probability the narrow corpus uses -- only the
    player cut and the line move, so any difference measured is about THOSE."""
    ladder = ladder or LADDER
    rows, refused = [], 0
    for g in corpus.games:
        season, week = g["season"], g["week"]
        if season not in corpus.seasons:
            continue
        p_home = bp.p_home_elo(corpus.pre[(season, week)], g, corpus.params)
        for pos in bp.POSITIONS:
            s = sd.get(pos)
            if not s or pos not in support:
                continue
            lo, hi = support[pos]
            for pid in corpus.by_pos[pos]:
                actual = corpus.weekly[pid]["seasons"].get(season, {}).get(week)
                if actual is None or actual["team"] not in (g["home"], g["away"]):
                    continue
                mu = corpus._blend(pid, pos, season, week)
                if mu is None:
                    continue
                team = actual["team"]
                opp = g["away"] if team == g["home"] else g["home"]
                mult = corpus.dvp_multiplier(season, week, opp, pos) or 1.0
                yards = float(actual[bp.YARDS_FIELD[pos]] or 0.0)
                p_team = p_home if team == g["home"] else 1.0 - p_home
                for line in ladder[pos]:
                    z = (mu * mult - line) / s
                    if not (lo <= z <= hi):
                        refused += 1
                        continue
                    rows.append({"season": season, "pos": pos, "pid": pid,
                                 "line": line, "z": z, "p_team": p_team,
                                 "y": 1 if yards >= line else 0})
    return rows, refused


def fit_wide(rows, positions=None):
    """(a, b, c) per position on `rows`, using the shipped ridge logistic so the
    two calibrations differ only in the data they saw."""
    out = {}
    for pos in (positions or bp.POSITIONS):
        tri = [(r["z"], r["p_team"] - 0.5, r["y"]) for r in rows if r["pos"] == pos]
        out[pos] = bp.fit_logistic(tri) if tri else None
    return out


def walk_forward(rows, shipped_coef):
    """Score every fold season with coefficients fit only on the seasons before
    it. Returns (refit pairs, shipped pairs, per-fold coefficients)."""
    seasons = sorted({r["season"] for r in rows})
    refit_pairs, shipped_pairs, per_fold = [], [], {}
    for s in seasons[1:]:
        fit = [r for r in rows if r["season"] < s]
        score = [r for r in rows if r["season"] == s]
        coefs = fit_wide(fit)
        per_fold[str(s)] = {p: (None if c is None else [round(x, 6) for x in c])
                            for p, c in coefs.items()}
        for r in score:
            c = coefs.get(r["pos"]) or shipped_coef.get(r["pos"])
            if c:
                refit_pairs.append((bp.calibrated_prob(c, r["z"], r["p_team"]), r["y"]))
            sc = shipped_coef.get(r["pos"])
            if sc:
                shipped_pairs.append((bp.calibrated_prob(sc, r["z"], r["p_team"]), r["y"]))
    return refit_pairs, shipped_pairs, per_fold


def _arm(tag, pairs):
    return {"arm": tag, "n": len(pairs),
            "skill": None if not pairs else round(skill(pairs), 4),
            "ece": None if not pairs else round(ece(pairs), 4),
            "log_loss": None if not pairs else round(_ll(pairs), 4)}


def verdict(refit, shipped, margin=ADOPT_ECE_MARGIN):
    """Adopt only when the refit is BETTER CALIBRATED by more than the margin and
    does not lose skill. Calibration leads because a parlay multiplies its legs."""
    a, b = _arm("refit", refit), _arm("shipped", shipped)
    if not refit or not shipped:
        return {"refit": a, "shipped": b, "adopt": False,
                "why": "no rows scored — nothing to compare"}
    better_ece = (b["ece"] - a["ece"]) > margin
    kept_skill = a["skill"] >= b["skill"]
    has_information = a["skill"] > MIN_SKILL
    adopt = bool(better_ece and kept_skill and has_information)
    if adopt:
        why = ("wide refit is better calibrated (ECE %.4f vs %.4f, margin %.3f), keeps "
               "skill (%.4f vs %.4f) and carries information (skill > %.2f)"
               % (a["ece"], b["ece"], margin, a["skill"], b["skill"], MIN_SKILL))
    elif not has_information:
        why = ("REFUSED: skill %.4f does not clear %.2f — a well-calibrated number "
               "with no information cannot rank legs" % (a["skill"], MIN_SKILL))
    else:
        why = ("REFUSED: ECE %.4f vs %.4f (margin %.3f), skill %.4f vs %.4f"
               % (a["ece"], b["ece"], margin, a["skill"], b["skill"]))
    return {"refit": a, "shipped": b, "ece_margin": margin, "min_skill": MIN_SKILL,
            "adopt": adopt, "why": why}


def narrow_guard(corpus, sd, coefs, shipped_coef):
    """The shipped slate's own population, scored under BOTH fits. This never
    gates adoption — the slate does not read these coefficients — it is recorded
    so the trade being made is on the record and not a surprise later."""
    pairs_new, pairs_old = [], []
    for r in corpus.rows:
        pos = r["pos"]
        if pos not in sd:
            continue
        z = (r["mu"] * r["mult"] - bp.LINES[pos]) / sd[pos]
        if coefs.get(pos):
            pairs_new.append((bp.calibrated_prob(coefs[pos], z, r["p_team"]), r["y"]))
        if shipped_coef.get(pos):
            pairs_old.append((bp.calibrated_prob(shipped_coef[pos], z, r["p_team"]), r["y"]))
    return {"pool_fit": _arm("pool_fit", pairs_new),
            "shipped_fit": _arm("shipped_fit", pairs_old),
            "note": "the shipped slate keeps shipped_fit; pool_fit is shown only to "
                    "record that one coefficient set cannot serve both populations"}


def build(rows=None, corpus=None, sd=None, support=None):
    shipped_doc = bp._load(SHIPPED)
    shipped_coef = {p: (v["a"], v["b"], v["c"])
                    for p, v in shipped_doc["props"]["calibration"].items()}
    if rows is None:
        games = bp.load_games(bp._load(bp.GAMES_META_PATH))
        weekly = bp.load_weekly(bp._load(bp.WEEKLY_ACTUALS_PATH))
        params = bp.load_game_params()
        corpus = bp.PropCorpus(games, weekly, bp.preweek_ratings(games, params), params)
        sd = shipped_doc["props"]["residual_sd"]
        support = support_from(corpus, sd)
        rows, refused = wide_rows(corpus, sd, support)
    else:
        refused = 0
    refit, shipped, per_fold = walk_forward(rows, shipped_coef)
    v = verdict(refit, shipped)
    final = fit_wide(rows)
    return {
        "generated_utc": _dt.datetime.now(_dt.timezone.utc)
                            .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model": "leg_pool_v1",
        "ladder": {k: list(v2) for k, v2 in LADDER.items()},
        "support": {k: [round(a, 4), round(b, 4)] for k, (a, b) in (support or {}).items()},
        "residual_sd": sd or {},
        "corpus": {"rows": len(rows), "refused_out_of_support": refused,
                   "seasons": sorted({r["season"] for r in rows}),
                   "players": len({(r["pos"], r["pid"]) for r in rows})},
        "verdict": v,
        "per_fold_coefficients": per_fold,
        "calibration": {p: (None if c is None else
                            {"a": round(c[0], 6), "b": round(c[1], 6), "c": round(c[2], 6)})
                        for p, c in final.items()},
        "reliability": reliability(refit),
        "narrow_guard": (narrow_guard(corpus, sd, final, shipped_coef)
                         if corpus is not None else None),
        "note": "The MY PARLAYS leg pool only. data/parlays.json keeps the shipped "
                "calibration in data/parlay_backtest.json and is untouched by this "
                "file. A rung is offered only when its z is inside `support`, so no "
                "leg is ever priced by extrapolation. No market number is read here.",
    }


def gate(doc):
    c, v = doc["corpus"], doc["verdict"]
    if len(c["seasons"]) < MIN_FOLDS + 1 or c["rows"] < MIN_ROWS:
        print("[gate] REFUSED: wide corpus too small to answer — %d row(s) over %d "
              "season(s), need >= %d over >= %d"
              % (c["rows"], len(c["seasons"]), MIN_ROWS, MIN_FOLDS + 1), file=sys.stderr)
        return 1
    if not v["adopt"]:
        print("[gate] REFUSED: %s" % v["why"], file=sys.stderr)
        return 1
    print("[gate] leg pool calibration PASS: %s" % v["why"])
    return 0


def _synthetic(signal, seasons=(2021, 2022, 2023), n_players=40, weeks=12):
    """A toy league whose outcome depends on z by `signal`. At 0.0 the y column is
    a coin flip and there is nothing for a refit to find."""
    rows, seed = [], 11
    for season in seasons:
        for week in range(1, weeks + 1):
            for pid in range(n_players):
                for pos in ("QB", "RB", "WR"):
                    for line in (-1.0, -0.5, 0.0, 0.5, 1.0):
                        seed = (1103515245 * seed + 12345) % (1 << 31)
                        u = seed / (1 << 31)
                        z = line + ((pid % 7) - 3) * 0.1
                        p = 1.0 / (1.0 + math.exp(-(signal * 1.5 * z)))
                        rows.append({"season": season, "pos": pos, "pid": str(pid),
                                     "line": line, "z": z, "p_team": 0.5,
                                     "y": 1 if u < p else 0})
    return rows


def selftest():
    shipped_doc = bp._load(SHIPPED)
    shipped_coef = {p: (v["a"], v["b"], v["c"])
                    for p, v in shipped_doc["props"]["calibration"].items()}

    # 1. ECE and skill behave: a perfectly calibrated set has ~0 ECE; a constant
    #    prediction has ~0 skill however confident it sounds.
    perfect = [(0.5, 1)] * 500 + [(0.5, 0)] * 500
    assert ece(perfect) < 0.01, ece(perfect)
    assert abs(skill(perfect)) < 1e-9, skill(perfect)
    lying = [(0.9, 1)] * 500 + [(0.9, 0)] * 500
    assert ece(lying) > 0.35, ece(lying)

    # 2. a planted z->outcome signal is FOUND and adopted
    strong = build(rows=_synthetic(signal=1.0))
    assert strong["verdict"]["adopt"], strong["verdict"]

    # 3. pure noise is REFUSED — a refit on coin flips must not be adopted
    noise = build(rows=_synthetic(signal=0.0))
    assert not noise["verdict"]["adopt"], noise["verdict"]

    # 4. no peeking: a fold's coefficients cannot move when a LATER season changes
    rows = _synthetic(signal=1.0)
    base = walk_forward(rows, shipped_coef)[2]["2022"]
    tampered = [dict(r) for r in rows]
    for r in tampered:
        if r["season"] == 2023:
            r["y"] = 1 - r["y"]
    assert walk_forward(tampered, shipped_coef)[2]["2022"] == base, \
        "a later season leaked into an earlier fold"

    # 5. the gate refuses a corpus too small, however good it looks
    small = build(rows=_synthetic(signal=1.0)[:200])
    assert gate(small) == 1, "a 200-row corpus must not pass"

    # 6. a well-calibrated coin flip is REFUSED for having no information — the
    #    case that broke the first version of this gate.
    flip = verdict([(0.5, i % 2) for i in range(4000)],
                   [(0.9, i % 2) for i in range(4000)])
    assert flip["refit"]["ece"] < 0.01 and abs(flip["refit"]["skill"]) < 0.01, flip
    assert not flip["adopt"] and "no information" in flip["why"], flip

    # 7. a tie is a refusal: identical arms must not adopt
    tie = verdict([(0.5, 1)] * 1000, [(0.5, 1)] * 1000)
    assert not tie["adopt"], tie

    # 8. the support rule really refuses: tightening the window drops rungs.
    class _Corpus:
        """Two players, one game, so the only thing under test is the window."""
        seasons = (2021,)
        games = [{"season": 2021, "week": 1, "home": "AAA", "away": "BBB"}]
        pre = {(2021, 1): {}}
        params = {}
        by_pos = {"QB": ["q1"], "RB": [], "WR": []}
        weekly = {"q1": {"pos": "QB", "seasons": {2021: {1: {"team": "AAA",
                                                            "pass_yds": 300.0}}}}}
        def _blend(self, pid, pos, season, week):
            return 250.0
        def dvp_multiplier(self, season, week, opp, pos):
            return 1.0
    saved = bp.p_home_elo
    bp.p_home_elo = lambda *a, **k: 0.5
    try:
        c = _Corpus()
        sd = {"QB": 75.0}
        wide_all, ref_all = wide_rows(c, sd, {"QB": (-5.0, 5.0)})
        wide_tight, ref_tight = wide_rows(c, sd, {"QB": (-0.1, 0.1)})
        assert len(wide_all) > len(wide_tight), (len(wide_all), len(wide_tight))
        assert ref_tight > ref_all, "a tighter window must refuse more rungs"
        assert all(-0.1 <= r["z"] <= 0.1 for r in wide_tight), wide_tight
    finally:
        bp.p_home_elo = saved

    print("selftest OK: ECE/skill behave on known inputs, a planted signal is "
          "adopted, noise / a tie / a well-calibrated coin flip are all refused, "
          "no later season leaks into an earlier fold, a small corpus is refused, "
          "and a tighter support window refuses more rungs")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gate", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    doc = build()
    if args.gate:
        return gate(doc)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    v = doc["verdict"]
    print("wrote %s" % os.path.relpath(OUT, _ROOT))
    print("  corpus %d rows, %d players, refused %d out-of-support"
          % (doc["corpus"]["rows"], doc["corpus"]["players"],
             doc["corpus"]["refused_out_of_support"]))
    print("  refit  skill %+.4f ece %.4f | shipped skill %+.4f ece %.4f -> %s"
          % (v["refit"]["skill"], v["refit"]["ece"], v["shipped"]["skill"],
             v["shipped"]["ece"], "ADOPT" if v["adopt"] else "REFUSE"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
