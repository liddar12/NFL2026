#!/usr/bin/env python3
"""R81 PARLAY REPLAY LAB (measure only) -> data/replay_lab.json.

WHAT THIS IS. A bench, not a builder. It takes the weeks that have already been
played and asks one question of each candidate parlay-improvement idea: on the
legs we actually locked, would this have been better or worse than what shipped?
It re-prices those legs, re-combines the archived parlays with the builder's own
arithmetic, and re-settles the $100 with build_review's own money. Then it writes
a document and stops. NOTHING HERE ADOPTS ANYTHING. There is no --gate, no
promotion path, no write to a calibration file, and no code path by which a
number produced here can reach a shipped leg. A variant is reported; the owner
decides, in chat, whether any of it ever becomes a build.

WHY IT IS SAFE TO RUN EVERY PIPELINE RUN. The only file it writes is
data/replay_lab.json. It reads the ledger, the resolver, the archive and the two
calibration records, and it never writes any of them.

THE INPUTS ARE A SNAPSHOT, AND THAT BOUNDS WHAT CAN BE REPLAYED.
data/estimates/parlays_<season>.json records, per leg, the pricing inputs as they
stood at lock time: mu, sd, z, line, p_team, side, market. That is enough to
RE-PRICE a leg and enough to RE-SELECT among the parlays that were built. It is
NOT enough to rebuild a slate: choosing a different player, a different line or a
different leg set needs the full weekly inputs as of that Tuesday, and the
pipeline does not keep a per-week snapshot of those. So this lab replays PRICING
and SELECTION, and says so in `limits` rather than implying more.

IDENTICAL LEGS, ALWAYS. Every variant prices the SAME resolved legs, so a
difference measured here is about the pricing rule and not about a different
population. Where a variant legitimately cannot price a leg (pool_calibration
outside the wide pool's measured support), that leg is SKIPPED FOR THAT VARIANT
AND COUNTED, and the paired comparison against `shipped` is run on exactly the
legs the variant did price -- never on shipped's larger set.

MARKET NUMBERS ARE THE TERMS OF THE BET, NEVER AN INPUT. implied_prob is read in
exactly two places: as the denominator of the archived parlay's EV (the price the
bet was offered at) and as the leg decimal of the $100 settlement (what the bet
pays). No variant function is given a book number at all -- the registry hands
each one (mu, sd, z, line, p_team, side, market) and nothing else.

ABSENT IS ABSENT. A locked leg with no outcome is counted under its reason and
never scored. A week the resolver has not reached is counted as
`week_not_resolved`, not as zero legs. With no resolved week at all, every metric
in the document is null -- never 0.0, which would read as a measurement.

  python3 scripts/replay_lab.py              write data/replay_lab.json
  python3 scripts/replay_lab.py --out P      write somewhere else (tests)
  python3 scripts/replay_lab.py --selftest   pure-core proofs, writes nothing
"""

import argparse
import datetime as _dt
import glob
import json
import math
import os
import random
import re
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import scripts.build_review as br                     # noqa: E402
import scripts.models.parlay_builder as pb            # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT = os.path.join(DATA, "replay_lab.json")
SCORES_PATH = os.path.join(DATA, "parlay_leg_scores.json")
ARCHIVE_GLOB = os.path.join(DATA, "parlays", "*_wk*.json")
POOL_PATH = os.path.join(DATA, "leg_pool_backtest.json")
SHIPPED_CAL_PATH = os.path.join(DATA, "parlay_backtest.json")
LEDGER_GLOB = os.path.join(DATA, "estimates", "parlays_*.json")

PROP_MARKETS = ("qb_pass_yds", "rb_rush_yds", "wr_rec_yds")
MARKET_POSITION = {"qb_pass_yds": "QB", "rb_rush_yds": "RB", "wr_rec_yds": "WR"}
GAME_MARKETS = ("moneyline", "spread")

# The margin sigma of the RETIRED pre-R51 spread rule (scripts/backtest_parlay.SIGMA
# = game_model._MARGIN_SIGMA). Re-measured here on live legs, never re-adopted.
MARGIN_SIGMA = 13.5

BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 8181          # fixed: the document must be byte-reproducible
CI_LEVEL = 0.90

SELECTION_RULES = ("all", "ev_gt_0", "ev_gt_0.05", "tier_high_only", "max_2_legs")

_EPS = 1e-9
_ARCHIVE_WEEK_RE = re.compile(r"(?P<season>\d{4})_wk(?P<week>\d{2})\.json$")


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


def _clamp(p, lo=_EPS, hi=1.0 - _EPS):
    return lo if p < lo else hi if p > hi else p


# ---------------------------------------------------------------------------
# Phi / Phi^-1 in stdlib math (documented approximations).
# ---------------------------------------------------------------------------
def phi(x):
    """Standard normal CDF via math.erf -- exact to double precision, no series."""
    return 0.5 * (1.0 + math.erf(float(x) / math.sqrt(2.0)))


# Peter Acklam's rational approximation to the normal quantile, |relative error|
# < 1.15e-9 over (0, 1), followed by ONE Halley refinement step against erfc,
# which takes it to ~1e-15. Documented here because the selftest pins it against
# statistics.NormalDist().inv_cdf and against the retired rule it reproduces.
_ACK_A = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
          1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
_ACK_B = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
          6.680131188771972e+01, -1.328068155288572e+01)
_ACK_C = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
          -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
_ACK_D = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
          3.754408661907416e+00)
_ACK_PLOW = 0.02425


def phi_inv(p):
    """Standard normal quantile. See _ACK_* above for the approximation used."""
    p = _clamp(float(p), 1e-12, 1.0 - 1e-12)
    if p < _ACK_PLOW:
        q = math.sqrt(-2.0 * math.log(p))
        x = (((((_ACK_C[0] * q + _ACK_C[1]) * q + _ACK_C[2]) * q + _ACK_C[3]) * q
              + _ACK_C[4]) * q + _ACK_C[5]) \
            / ((((_ACK_D[0] * q + _ACK_D[1]) * q + _ACK_D[2]) * q + _ACK_D[3]) * q + 1.0)
    elif p <= 1.0 - _ACK_PLOW:
        q = p - 0.5
        r = q * q
        x = (((((_ACK_A[0] * r + _ACK_A[1]) * r + _ACK_A[2]) * r + _ACK_A[3]) * r
              + _ACK_A[4]) * r + _ACK_A[5]) * q \
            / (((((_ACK_B[0] * r + _ACK_B[1]) * r + _ACK_B[2]) * r + _ACK_B[3]) * r
                + _ACK_B[4]) * r + 1.0)
    else:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        x = -(((((_ACK_C[0] * q + _ACK_C[1]) * q + _ACK_C[2]) * q + _ACK_C[3]) * q
               + _ACK_C[4]) * q + _ACK_C[5]) \
            / ((((_ACK_D[0] * q + _ACK_D[1]) * q + _ACK_D[2]) * q + _ACK_D[3]) * q + 1.0)
    # One Halley step on e(x) = Phi(x) - p.
    e = 0.5 * math.erfc(-x / math.sqrt(2.0)) - p
    u = e * math.sqrt(2.0 * math.pi) * math.exp(x * x / 2.0)
    return x - u / (1.0 + x * u / 2.0)


# ---------------------------------------------------------------------------
# Join: the ledger's LOCKED legs against the resolver's outcomes.
# ---------------------------------------------------------------------------
def leg_key(week, game_id, market, selection):
    """Leg identity, everywhere: (week, game_id, market, selection)."""
    return (int(week), str(game_id), str(market), str(selection))


def join_legs(ledger, scores):
    """(rows, unresolved_by_reason, counts) over the ledger's LOCKED legs.

    A row carries only what a variant is allowed to see (mu, sd, z, line, p_team,
    side, market, position) plus the shipped probability that was locked and the
    outcome. `implied_prob` is carried for the PARLAY settlement only and is never
    handed to a variant function.

    Every locked leg that does not resolve is counted under a reason:
      * the resolver's own reason (no_stat_line / push / tie / ...), or
      * `week_not_resolved` when the resolver has not reached that leg's week at
        all -- absence of a row is not a reason the resolver gave, and calling it
        one would be inventing provenance.
    """
    resolved = {}
    for r in (scores or {}).get("resolved") or []:
        resolved[leg_key(r["week"], r.get("game_id"), r["market"], r["selection"])] = r
    unresolved = {}
    for r in (scores or {}).get("unresolved") or []:
        unresolved[leg_key(r["week"], r.get("game_id"), r["market"], r["selection"])] = \
            str(r.get("reason") or "unstated")

    rows, reasons = [], {}
    locked = unlocked = 0
    for leg in (ledger or {}).get("legs") or []:
        if not leg.get("locked"):
            unlocked += 1
            continue
        locked += 1
        k = leg_key(leg["week"], leg.get("game_id"), leg["market"], leg["selection"])
        hit = resolved.get(k)
        if hit is None:
            reason = unresolved.get(k, "week_not_resolved")
            reasons[reason] = reasons.get(reason, 0) + 1
            continue
        pos = leg.get("position") or MARKET_POSITION.get(leg["market"])
        rows.append({
            "week": int(leg["week"]), "game_id": str(leg.get("game_id")),
            "market": leg["market"], "selection": leg["selection"],
            "position": pos, "side": leg.get("side"), "line": leg.get("line"),
            "mu": leg.get("mu"), "sd": leg.get("sd"), "z": leg.get("z"),
            "p_team": leg.get("p_team"), "shipped_prob": leg.get("model_prob"),
            "implied_prob": leg.get("implied_prob"),
            "y": 1 if hit.get("hit") else 0,
        })
    counts = {"on_file": len((ledger or {}).get("legs") or []),
              "locked": locked, "unlocked": unlocked, "resolved": len(rows)}
    return rows, reasons, counts


# ---------------------------------------------------------------------------
# VARIANTS. Each is a pure function row -> probability, or None to SKIP the leg
# for that variant (skips are counted, never zero-filled). `ctx` carries only
# model artifacts: the wide-pool coefficients and support. No book number is in
# scope in any of these functions -- that is the point of the signature.
# ---------------------------------------------------------------------------
def v_shipped(row, ctx):
    """The probability that was actually locked on the leg. The baseline."""
    return row["shipped_prob"]


def v_seed(row, ctx):
    """The pre-calibration pricing: props shaded off the team's win probability,
    moneyline = the team's win probability, spread flat at 0.5."""
    if row["market"] in PROP_MARKETS:
        if row.get("p_team") is None:
            return None
        return pb.seed_prop_prob(row["p_team"])
    if row["market"] == "moneyline":
        return row.get("p_team")
    if row["market"] == "spread":
        return 0.5
    return None


def v_pool_calibration(row, ctx):
    """Props re-priced with the WIDE-POOL coefficients (leg_pool_backtest.json):
    a genuinely different fit of the same form, made on ~245 players across a
    ladder instead of the slate's one player per position at one line.

    THE SUPPORT RULE IS KEPT. A leg whose z sits outside the z range the pool's
    corpus actually covers is SKIPPED, not extrapolated -- offering a number there
    is exactly what R76 refused to do on the live pool, and this bench does not
    get a private exemption. Game legs stay as shipped: the pool never fit them."""
    if row["market"] not in PROP_MARKETS:
        return row["shipped_prob"]
    pos = row.get("position")
    coef = (ctx.get("pool_calibration") or {}).get(pos)
    sup = (ctx.get("pool_support") or {}).get(pos)
    z, p_team = row.get("z"), row.get("p_team")
    if not coef or not sup or z is None or p_team is None:
        return None
    if not (float(sup[0]) <= float(z) <= float(sup[1])):
        return None
    p = pb._sigmoid(float(coef["a"]) + float(coef["b"]) * float(z)
                    + float(coef["c"]) * (float(p_team) - 0.5))
    return pb._clamp(p, pb._PROP_CAL_LO, pb._PROP_CAL_HI)


def v_spread_margin_model(row, ctx):
    """Spread legs priced by the RETIRED pre-R51 Elo margin rule:
        mu_margin = Phi^-1(p_team) * 13.5 ;  p_cover = Phi((mu_margin - h) / 13.5)
    where h is the handicap the team must beat (the ledger stores the bettor-side
    line, so h = -line: 'SEA -3' is line -3.0 and h = 3.0).

    scripts/backtest_parlay.py retired this rule on 2023-25 (cover log-loss 0.7231
    against a flat 0.6931 on 797 games) and the slate has priced spreads flat at
    0.5 ever since. Re-measuring it on live legs is the honest way to keep that
    decision under review; it is still not a path back in. Everything else is
    shipped."""
    if row["market"] != "spread":
        return row["shipped_prob"]
    p_team, line = row.get("p_team"), row.get("line")
    if p_team is None or line is None:
        return None
    mu_margin = phi_inv(_clamp(float(p_team), 1e-4, 1.0 - 1e-4)) * MARGIN_SIGMA
    return phi((mu_margin - (-float(line))) / MARGIN_SIGMA)


def v_shrink_to_half(row, ctx):
    """The simplest overconfidence check there is: halve every prop leg's distance
    from a coin flip. If this WINS, the shipped prop model is talking too loudly,
    and the finding is about confidence, not about direction."""
    if row["market"] not in PROP_MARKETS:
        return row["shipped_prob"]
    if row["shipped_prob"] is None:
        return None
    return 0.5 + 0.5 * (float(row["shipped_prob"]) - 0.5)


# A future variant is one function plus one entry here. Nothing else changes.
VARIANTS = {
    "shipped": {
        "fn": v_shipped,
        "description": "The probability locked on the leg at build time. The baseline "
                       "every other row is measured against; it is not a candidate.",
    },
    "seed": {
        "fn": v_seed,
        "description": "Pre-calibration pricing: props = seed_prop_prob(p_team), "
                       "moneyline = p_team, spread = 0.5. The floor the calibrated "
                       "model had to clear to ship.",
    },
    "pool_calibration": {
        "fn": v_pool_calibration,
        "description": "Props re-priced with the wide-pool coefficients from "
                       "leg_pool_backtest.json, the support rule kept: a leg whose z "
                       "is outside the pool's measured range is skipped, not "
                       "extrapolated. Game legs as shipped.",
    },
    "spread_margin_model": {
        "fn": v_spread_margin_model,
        "description": "Spread legs priced by the retired pre-R51 Elo margin rule "
                       "(p_cover = Phi((Phi^-1(p_team)*13.5 - handicap)/13.5)); "
                       "moneyline and props as shipped. A retired rule, re-measured "
                       "on live legs -- not a path back in.",
    },
    "shrink_to_half": {
        "fn": v_shrink_to_half,
        "description": "Props halved toward 0.5 (p = 0.5 + 0.5*(shipped - 0.5)); "
                       "game legs as shipped. The simplest test of whether the prop "
                       "model is overconfident rather than wrong.",
    },
}
BASELINE = "shipped"


def price_rows(rows, name, ctx):
    """[(row, p)] for every row the variant priced, plus the skip count."""
    out, skipped = [], 0
    fn = VARIANTS[name]["fn"]
    for row in rows:
        p = fn(row, ctx)
        if p is None:
            skipped += 1
            continue
        out.append((row, float(p)))
    return out, skipped


# ---------------------------------------------------------------------------
# Leg scoring.
# ---------------------------------------------------------------------------
def log_loss_one(p, y):
    p = _clamp(float(p))
    return -(math.log(p) if y else math.log(1.0 - p))


def metrics(pairs):
    """{n, hit_rate, log_loss, brier} over [(p, y)]. All null at n = 0 -- a zero
    here would read as a measurement of something."""
    n = len(pairs)
    if not n:
        return {"n": 0, "hit_rate": None, "log_loss": None, "brier": None}
    return {"n": n,
            "hit_rate": _r(sum(y for _, y in pairs) / n),
            "log_loss": _r(sum(log_loss_one(p, y) for p, y in pairs) / n),
            "brier": _r(sum((float(p) - y) ** 2 for p, y in pairs) / n)}


def paired_bootstrap(diffs, resamples=BOOTSTRAP_RESAMPLES, seed=BOOTSTRAP_SEED,
                     level=CI_LEVEL):
    """(mean difference, [lo, hi]) for a PAIRED bootstrap of per-leg log-loss
    differences (variant - shipped) on identical legs. Fixed seed, stdlib random,
    so the document is reproducible byte-for-byte from the same inputs."""
    n = len(diffs)
    if n == 0:
        return None, None
    mean = sum(diffs) / n
    rng = random.Random(seed)
    means = []
    for _ in range(resamples):
        means.append(sum(diffs[rng.randrange(n)] for _ in range(n)) / n)
    means.sort()
    tail = (1.0 - level) / 2.0
    lo = means[min(int(tail * resamples), resamples - 1)]
    hi = means[min(int((1.0 - tail) * resamples), resamples - 1)]
    return mean, [lo, hi]


def verdict_of(ci):
    """LOWER log-loss is better, so the difference (variant - shipped) is good when
    it is negative. A verdict is given ONLY when the 90% CI excludes 0; anything
    that straddles 0 is 'same', however pretty the point estimate looks."""
    if ci is None:
        return None
    lo, hi = ci
    if hi < 0:
        return "better"
    if lo > 0:
        return "worse"
    return "same"


def compare(priced, shipped_by_key):
    """One comparison block for a set of priced rows, paired against shipped on
    EXACTLY those rows (never on shipped's larger set).

    A leg the variant priced but the baseline did not is not a skip to swallow:
    it means the comparison has no baseline for part of its own population, and
    every delta below would be over a different set than the log-loss above it.
    The ledger contract makes `model_prob` required, so this cannot happen on a
    valid input — and if it ever does, it fails here by name rather than quietly
    producing a number that does not reconcile."""
    pairs = [(p, row["y"]) for row, p in priced]
    block = metrics(pairs)
    diffs, ship_losses = [], []
    for row, p in priced:
        k = leg_key(row["week"], row["game_id"], row["market"], row["selection"])
        sp = shipped_by_key.get(k)
        if sp is None:
            raise ValueError("no baseline probability for leg %s — the variant "
                             "priced a leg `%s` did not, so nothing here can be "
                             "compared on identical legs" % (k, BASELINE))
        ship_losses.append(log_loss_one(sp, row["y"]))
        diffs.append(log_loss_one(p, row["y"]) - ship_losses[-1])
    mean, ci = paired_bootstrap(diffs)
    block["shipped_log_loss_same_legs"] = (
        _r(sum(ship_losses) / len(ship_losses)) if ship_losses else None)
    block["delta_log_loss"] = _r(mean)
    block["ci90"] = None if ci is None else [_r(ci[0]), _r(ci[1])]
    block["verdict"] = verdict_of(ci)
    return block


def score_variant_legs(priced, shipped_by_key):
    """pooled / by_week / by_market comparison blocks for one variant."""
    pooled = compare(priced, shipped_by_key)
    by_week = []
    for wk in sorted({row["week"] for row, _ in priced}):
        blk = compare([(r, p) for r, p in priced if r["week"] == wk], shipped_by_key)
        blk["week"] = wk
        by_week.append(blk)
    by_market = {}
    for mk in sorted({row["market"] for row, _ in priced}):
        by_market[mk] = compare([(r, p) for r, p in priced if r["market"] == mk],
                                shipped_by_key)
    return {"pooled": pooled, "by_week": by_week, "by_market": by_market}


# ---------------------------------------------------------------------------
# Parlay replay.
# ---------------------------------------------------------------------------
def archive_weeks(paths):
    """[(week, document)] for the archived slates, oldest first."""
    out = []
    for path in sorted(paths):
        m = _ARCHIVE_WEEK_RE.search(os.path.basename(path))
        if not m:
            continue
        with open(path, "r", encoding="utf-8") as fh:
            out.append((int(m.group("week")), json.load(fh)))
    return sorted(out, key=lambda t: t[0])


def replay_parlays(archives, ledger_index, priced_by_key, outcome_by_key,
                   unresolved_by_key, price_index, corr, weeks):
    """Re-combine every archived parlay under ONE variant's leg probabilities.

    A parlay is eligible only when EVERY leg of it resolved and the variant priced
    every leg. Anything else is excluded and counted -- a parlay settled on a
    subset of its legs is not that parlay.

    The book's implied_prob stays exactly as archived: it is the price the bet was
    offered at (the EV denominator) and the price it pays (the leg decimal). The
    variant moves only our side of the comparison.

    Returns (rows, excluded_by_reason). Each row carries the recomputed model_ev,
    combined model probability and confidence tier under the variant, and the
    realised $100 settlement -- which does NOT depend on the variant, because what
    a bet paid is a fact. The variant moves WHICH parlays a rule selects.
    """
    rows, excluded = [], {}

    def drop(reason):
        excluded[reason] = excluded.get(reason, 0) + 1

    for week, doc in archives:
        if week not in weeks:
            # Count the PARLAYS, not the week: "1 week skipped" hides 66 cards.
            for _ in doc.get("parlays") or []:
                drop("week_not_replayed")
            continue
        for parlay in doc.get("parlays") or []:
            legs, results, ok = [], [], True
            for leg in parlay.get("legs") or []:
                led = ledger_index.get((week, leg["market"], leg["selection"]))
                if led is None:
                    drop("leg_not_in_ledger")
                    ok = False
                    break
                if not led.get("locked"):
                    drop("leg_not_locked")
                    ok = False
                    break
                k = leg_key(week, led.get("game_id"), leg["market"], leg["selection"])
                y = outcome_by_key.get(k)
                if y is None:
                    drop(unresolved_by_key.get(k, "week_not_resolved"))
                    ok = False
                    break
                p = priced_by_key.get(k)
                if p is None:
                    drop("leg_not_priced_by_variant")
                    ok = False
                    break
                legs.append(pb.make_leg(leg["market"], leg["selection"], p,
                                        implied_prob=leg.get("implied_prob"),
                                        corr_tag=leg["market"], side=led.get("side")))
                results.append({"market": leg["market"], "selection": leg["selection"],
                                "game_id": led.get("game_id"),
                                "result": "hit" if y else "miss"})
            if not ok or not legs:
                continue
            rebuilt = pb._make_parlay(parlay.get("parlay_id"), parlay.get("scope"),
                                      legs, game_id=parlay.get("game_id"), corr=corr)
            reviewed = {"parlay_id": parlay.get("parlay_id"),
                        "scope": parlay.get("scope"),
                        "bucket": br.parlay_bucket([r["result"] for r in results]),
                        "legs": results}
            fair, vig, assumed = br.parlay_money(reviewed, week, price_index)
            rows.append({"week": week, "parlay_id": parlay.get("parlay_id"),
                         "scope": parlay.get("scope"), "n_legs": len(legs),
                         "model_ev": rebuilt["model_ev"],
                         "tier": rebuilt["confidence_tier"],
                         "bucket": reviewed["bucket"],
                         "net_fair": fair, "net_vig2": vig,
                         "assumed_price_legs": assumed})
    return rows, excluded


def select(rows, rule):
    if rule == "all":
        return list(rows)
    if rule == "ev_gt_0":
        return [r for r in rows if r["model_ev"] > 0]
    if rule == "ev_gt_0.05":
        return [r for r in rows if r["model_ev"] > 0.05]
    if rule == "tier_high_only":
        return [r for r in rows if r["tier"] == "high"]
    if rule == "max_2_legs":
        return [r for r in rows if r["n_legs"] <= 2]
    raise ValueError("unknown selection rule %r" % (rule,))


def settle(rows):
    """$100 flat on every selected parlay, at build_review's own arithmetic."""
    n = len(rows)
    if not n:
        return {"n": 0, "hit": 0, "staked": None, "net_fair": None, "net_vig2": None,
                "roi_fair": None, "roi_vig2": None, "assumed_price_legs": 0}
    staked = br.STAKE * n
    fair = sum(r["net_fair"] for r in rows)
    vig = sum(r["net_vig2"] for r in rows)
    return {"n": n, "hit": sum(1 for r in rows if r["bucket"] == "all_hit"),
            "staked": _r(staked, 2), "net_fair": _r(fair, 2), "net_vig2": _r(vig, 2),
            "roi_fair": _r(fair / staked), "roi_vig2": _r(vig / staked),
            "assumed_price_legs": sum(r["assumed_price_legs"] for r in rows)}


# ---------------------------------------------------------------------------
# R87 SAME-GAME PAIRS. Does the shipped same-game correlation hold up on 2026?
#
# WHY THIS EXISTS. The builder combines two same-game legs with a Gaussian-
# copula-lite adjustment: joint = pA*pB + rho*sqrt(pA(1-pA)pB(1-pB)), where rho
# comes from the 5 pairs measured on 2023-25 in data/parlay_backtest.json
# (default 0.10 for a pair nobody measured). RC-N5 of docs/RCA_MYPARLAYS_CARDS.md
# asked for that chained joint to be SCORED against resolved outcomes before it is
# trusted any further than the 2-to-3-leg cards the slate builds today. This block
# is that score: on every unordered pair of resolved legs inside one game, how
# often did BOTH legs actually land, against what the shipped rho said, and
# against plain independence.
#
# IT ADOPTS NOTHING, like the rest of this file. It reports three numbers side by
# side and a verdict with a confidence interval; no rho measured here is written
# anywhere, and data/parlay_backtest.json is never opened for writing by this
# module. A pair the one-leg-per-game-side rule refuses (a team's moneyline and
# that team's own spread) is not measured here either -- it is not offered, so
# measuring its joint would be measuring a card the slate cannot build.
#
# NO BOOK NUMBER TOUCHES THIS. Every probability below is the model probability
# LOCKED on the leg; nothing here reads a price.
# ---------------------------------------------------------------------------
SAME_GAME_MIN_N = 20

SAME_GAME_RULE = (
    "pairs = every unordered pair of RESOLVED locked legs sharing a (week, game_id), "
    "minus the pairs parlay_builder.same_side_game_pair refuses; key = the two legs' "
    "correlation tags sorted and joined with '|', plus '|opposing' when their sides "
    "are {home, away}; observed_joint = mean(yA*yB), independent_joint = mean(pA*pB) "
    "and shipped_joint = mean(parlay_builder._combine_two(pA, pB, "
    "parlay_builder._pair_rho(legA, legB, corr))) on the LOCKED model probabilities; "
    "delta = observed_joint - shipped_joint, ci90 = the 90% paired bootstrap of the "
    "per-pair (yA*yB - shipped_joint_pair); verdict is 'insufficient' below min_n, "
    "else 'consistent' when the CI contains 0, 'shipped_high' when it is entirely "
    "below 0 and 'shipped_low' when it is entirely above."
)


def pair_key(tag_a, tag_b, side_a, side_b):
    """The calibration's own key for a pair of same-game legs.

    Order-independent on the two correlation tags, exactly as _pair_rho's
    frozenset lookup is, with the '|opposing' suffix the calibration file uses
    when the two legs sit on different teams. The string form is the one
    data/parlay_backtest.json prints, so a row here can be read straight against
    the measured pair it is testing.
    """
    key = "|".join(sorted((str(tag_a), str(tag_b))))
    sides = {side_a, side_b}
    if side_a and side_b and sides == {"home", "away"}:
        key += "|opposing"
    return key


def corr_leg(row):
    """A joined row as the builder's own pair functions expect to see a leg.

    `market` is what same_side_game_pair reads, `_corr_tag` and `_side` are what
    _pair_rho reads -- and the slate tags a leg with its market (see
    replay_parlays' make_leg call), so the tag is the market here too.
    """
    return {"market": row["market"], "_corr_tag": row["market"],
            "_side": row.get("side")}


def pair_verdict(n, ci, min_n=SAME_GAME_MIN_N):
    """The verdict on one key's delta (observed - shipped joint).

    Below min_n pairs there is no verdict to give, however wide or narrow the
    interval looks: 'insufficient', with the numbers still printed. Above it, a
    claim is made only when the 90% CI excludes 0 -- the same bar the variant
    rows are held to. A CI entirely BELOW 0 means the pairs co-occurred less
    often than the shipped rho says they would, i.e. the shipped joint is too
    high.
    """
    if n < min_n or ci is None:
        return "insufficient"
    lo, hi = ci
    if hi < 0:
        return "shipped_high"
    if lo > 0:
        return "shipped_low"
    return "consistent"


def joint_block(key, items):
    """One reported row over a list of scored pairs.

    Each item is {"pa", "pb", "y", "joint", "rho"}: the two locked probabilities,
    the realised joint outcome (1 only when BOTH legs hit), the shipped combined
    probability for that pair and the rho that produced it.

    rho_live is the moment estimator the calibration itself used
    ((P(AB) - P(A)P(B)) / sqrt(P(A)(1-P(A))P(B)(1-P(B)))), so it is directly
    comparable with rho_shipped. rho_shipped is null on a row whose pairs do not
    share one rho (the pooled row) rather than an average of different rules.
    """
    n = len(items)
    if not n:
        return {"key": key, "n": 0, "observed_joint": None, "independent_joint": None,
                "shipped_joint": None, "rho_shipped": None, "rho_live": None,
                "delta": None, "ci90": None, "verdict": pair_verdict(0, None)}
    obs = sum(it["y"] for it in items) / n
    indep = sum(it["pa"] * it["pb"] for it in items) / n
    ship = sum(it["joint"] for it in items) / n
    sd = sum(math.sqrt(it["pa"] * (1.0 - it["pa"]) * it["pb"] * (1.0 - it["pb"]))
             for it in items) / n
    rhos = {round(it["rho"], 10) for it in items}
    _, ci = paired_bootstrap([it["y"] - it["joint"] for it in items])
    return {"key": key, "n": n,
            "observed_joint": _r(obs),
            "independent_joint": _r(indep),
            "shipped_joint": _r(ship),
            "rho_shipped": _r(items[0]["rho"]) if len(rhos) == 1 else None,
            "rho_live": _r((obs - indep) / sd) if sd > 0 else None,
            "delta": _r(obs - ship),
            "ci90": None if ci is None else [_r(ci[0]), _r(ci[1])],
            "verdict": pair_verdict(n, ci)}


def pair_items(rows, corr):
    """([scored pair, ...], refused_by_reason) over the joined rows.

    Pairs are formed inside a (week, game_id) group only -- the correlation table
    is a same-game table, and two legs in different games are combined as
    independent by the builder, so there is nothing of the table to test there.
    """
    groups, out, refused = {}, [], {}

    def drop(reason):
        refused[reason] = refused.get(reason, 0) + 1

    for row in rows:
        groups.setdefault((row["week"], row["game_id"]), []).append(row)
    for _, legs in sorted(groups.items()):
        for i in range(len(legs)):
            for j in range(i + 1, len(legs)):
                a, b = legs[i], legs[j]
                la, lb = corr_leg(a), corr_leg(b)
                if pb.same_side_game_pair(la, lb):
                    # One opinion sold as two: the slate refuses to build it, so
                    # the lab has no such card to score.
                    drop("same_side_game_pair")
                    continue
                pa, pbv = a.get("shipped_prob"), b.get("shipped_prob")
                if pa is None or pbv is None:
                    drop("no_locked_probability")
                    continue
                pa, pbv = float(pa), float(pbv)
                rho = pb._pair_rho(la, lb, corr)
                out.append({"key": pair_key(la["_corr_tag"], lb["_corr_tag"],
                                            la["_side"], lb["_side"]),
                            "pa": pa, "pb": pbv, "rho": rho,
                            "joint": pb._combine_two(pa, pbv, rho),
                            "y": 1 if (a["y"] and b["y"]) else 0})
    return out, refused


def card_items(archives, ledger_index, shipped_by_key, outcome_by_key, weeks, corr):
    """([scored card, ...], excluded_by_reason) over the ARCHIVED same-game cards.

    The 2-leg game cards are the pairs that were actually offered, which is a
    different (and much smaller) population than every pair the slate's legs could
    form. A card is scored only when both of its legs resolved: a card graded on
    one of its two legs is not that card.
    """
    out, excluded = [], {}

    def drop(reason):
        excluded[reason] = excluded.get(reason, 0) + 1

    for week, doc in archives:
        for parlay in doc.get("parlays") or []:
            if parlay.get("scope") != "game":
                continue
            if week not in weeks:
                drop("week_not_replayed")
                continue
            legs = parlay.get("legs") or []
            if len(legs) != 2:
                drop("not_two_legs")
                continue
            scored, ok = [], True
            for leg in legs:
                led = ledger_index.get((week, leg["market"], leg["selection"]))
                if led is None or not led.get("locked"):
                    drop("leg_not_in_ledger" if led is None else "leg_not_locked")
                    ok = False
                    break
                k = leg_key(week, led.get("game_id"), leg["market"], leg["selection"])
                y, p = outcome_by_key.get(k), shipped_by_key.get(k)
                if y is None or p is None:
                    drop("leg_not_resolved")
                    ok = False
                    break
                scored.append((float(p), int(y), led.get("side"), leg["market"]))
            if not ok:
                continue
            (pa, ya, sa, ma), (pbv, yb, sb, mb) = scored
            rho = pb._pair_rho({"market": ma, "_corr_tag": ma, "_side": sa},
                               {"market": mb, "_corr_tag": mb, "_side": sb}, corr)
            out.append({"pa": pa, "pb": pbv, "rho": rho,
                        "joint": pb._combine_two(pa, pbv, rho),
                        "y": 1 if (ya and yb) else 0})
    return out, excluded


def same_game_pairs_block(rows, archives, ledger_index, shipped_by_key,
                          outcome_by_key, weeks, corr):
    """The `same_game_pairs` document: per-key rows, a pooled row, and the cards.

    Nothing in here is adopted and nothing in here is written anywhere but this
    document -- it is RC-N5's requested measurement of the shipped chained joint,
    reported so the owner can decide in chat whether 4+ same-game legs ever
    become buildable.
    """
    items, refused = pair_items(rows, corr)
    by_key = {}
    for it in items:
        by_key.setdefault(it["key"], []).append(it)

    cards, card_excluded = card_items(archives, ledger_index, shipped_by_key,
                                      outcome_by_key, weeks, corr)
    n_cards = len(cards)
    _, card_ci = paired_bootstrap([c["y"] - c["joint"] for c in cards]) \
        if n_cards else (None, None)
    cards_block = {
        "n": n_cards,
        "all_hit_rate": _r(sum(c["y"] for c in cards) / n_cards) if n_cards else None,
        "mean_model_shipped": _r(sum(c["joint"] for c in cards) / n_cards) if n_cards else None,
        "mean_model_independent": _r(sum(c["pa"] * c["pb"] for c in cards) / n_cards)
                                  if n_cards else None,
        "delta": _r(sum(c["y"] - c["joint"] for c in cards) / n_cards) if n_cards else None,
        "ci90": None if card_ci is None else [_r(card_ci[0]), _r(card_ci[1])],
        "verdict": pair_verdict(n_cards, card_ci),
        "excluded_by_reason": card_excluded,
    }
    return {
        "rule": SAME_GAME_RULE,
        "min_n": SAME_GAME_MIN_N,
        "pairs": [joint_block(k, by_key[k]) for k in sorted(by_key)],
        "pooled": joint_block("all", items),
        "refused_by_reason": refused,
        "cards": cards_block,
        "note": "MEASURE ONLY, like every other block here. The shipped same-game "
                "rho (data/parlay_backtest.json, 2023-25) is scored against 2026 "
                "outcomes -- RC-N5's precondition for trusting the chained joint -- "
                "and no rho measured here is adopted, written back or allowed to "
                "reach a leg. A verdict needs the 90% CI to exclude 0 and at least "
                "min_n pairs; below that the numbers are printed and the verdict is "
                "'insufficient'.",
    }


# ---------------------------------------------------------------------------
# Build.
# ---------------------------------------------------------------------------
POLICY = [
    "MEASURE ONLY. This document reports; it never adopts. No variant here can "
    "reach a shipped leg, a calibration file or a slate — there is no code path, "
    "not merely no intention.",
    "IDENTICAL LEGS. Every variant re-prices the SAME resolved legs from the "
    "inputs the ledger locked (mu, sd, z, line, p_team, side, market), and each "
    "paired comparison runs on exactly the legs that variant priced.",
    "MARKET NUMBERS ARE THE TERMS OF THE BET, NEVER AN INPUT. implied_prob is "
    "read only as the EV denominator and the leg decimal; no variant function is "
    "handed a book number at all.",
    "ABSENT IS ABSENT. A locked leg with no outcome is counted under its reason "
    "and never scored; a parlay with any unresolved leg is excluded and counted. "
    "With no resolved week every metric is null, never 0.",
    "A VERDICT NEEDS A CONFIDENCE INTERVAL. 'better' or 'worse' is claimed only "
    "when the 90% paired-bootstrap CI of the log-loss difference excludes 0; "
    "everything else is 'same', however good the point estimate looks.",
    "THE SAME-GAME CORRELATION IS SCORED, NOT TRUSTED. `same_game_pairs` measures "
    "the shipped rho (measured 2023-25) against 2026 outcomes on every pair of "
    "resolved legs inside one game; a pair the one-leg-per-game-side rule refuses "
    "is not measured, because it is not offered. No rho measured there is adopted, "
    "written back, or allowed to reach a leg.",
    "SELECTION REPLAYS CHOOSE AMONG THE PARLAYS THAT WERE ACTUALLY BUILT. They "
    "cannot invent a parlay that was never on the slate, and a rule that looks "
    "good on one week of 2 to 7-leg cards has proved almost nothing.",
]

LIMITS = [
    "The inputs snapshot is the ledger's locked pricing inputs, so only PRICING "
    "and SELECTION variants can be replayed; full slate rebuilds (a different "
    "player, a different line, a different leg set) need a per-week input "
    "snapshot the pipeline does not yet keep.",
    "The realised $100 settlement is a fact about the legs and the book's prices, "
    "so it is identical across variants for the same parlay; a variant moves ROI "
    "only by moving WHICH parlays a selection rule takes.",
    "The `shipped` baseline is the price LOCKED ON FIRST SIGHT in "
    "data/estimates/parlays_<season>.json — the price the resolver grades and the "
    "price a bet placed pre-kickoff would have carried. The archived card may hold "
    "a LATER pre-kickoff refresh of the same leg, so a replayed parlay's model_ev "
    "is the parlay at its locked price and will not always equal the model_ev "
    "printed on the archived card. Both are ours; they are different snapshots.",
    "Prop legs and game legs with no ledger price settle at an assumed -110 "
    "(build_review's rule); assumed_price_legs counts them on every row.",
    "Eligibility is not random: a parlay is replayed only when EVERY leg of it "
    "resolved, so while spreads are ungraded every card carrying one drops out. "
    "The comparison between variants is still like-for-like (they all see the "
    "same eligible set), but an absolute ROI here is over a subset of the slate.",
    "One or two weeks of a 2026 season is a small sample. A CI that excludes 0 "
    "here is a reason to look again next week, not a reason to change a build.",
    "The same-game pair rows are pairs of legs that RESOLVED in one game, not "
    "parlays that were offered: most of them were never on a card together. The "
    "`cards` sub-block is the offered population (archived 2-leg same-game cards) "
    "and is much smaller. Both are reported because they answer different "
    "questions: whether the rho is right, and whether the cards it priced landed.",
]


def build(ledger=None, scores=None, archives=None, pool=None, calibration_path=None,
          generated_utc=None):
    ledger = ledger or {}
    scores = scores or {}
    archives = archives or []
    rows, reasons, counts = join_legs(ledger, scores)
    weeks = sorted({row["week"] for row in rows})

    ctx = {"pool_calibration": (pool or {}).get("calibration") or {},
           "pool_support": (pool or {}).get("support") or {}}
    corr = pb._correlation_table(
        pb.load_calibration(calibration_path or pb.DEFAULT_CALIBRATION_PATH))
    price_index = br.ledger_price_index(ledger)
    ledger_index = {(int(l["week"]), l["market"], l["selection"]): l
                    for l in (ledger.get("legs") or [])}
    outcome_by_key = {leg_key(r["week"], r["game_id"], r["market"], r["selection"]): r["y"]
                      for r in rows}
    unresolved_by_key = {}
    for r in (scores.get("unresolved") or []):
        unresolved_by_key[leg_key(r["week"], r.get("game_id"), r["market"],
                                  r["selection"])] = str(r.get("reason") or "unstated")

    shipped_priced, _ = price_rows(rows, BASELINE, ctx)
    shipped_by_key = {leg_key(r["week"], r["game_id"], r["market"], r["selection"]): p
                      for r, p in shipped_priced}

    variants = {}
    for name, spec in VARIANTS.items():
        priced, skipped = price_rows(rows, name, ctx)
        priced_by_key = {leg_key(r["week"], r["game_id"], r["market"], r["selection"]): p
                         for r, p in priced}
        changed = sum(1 for r, p in priced
                      if r["shipped_prob"] is None
                      or abs(p - float(r["shipped_prob"])) > 1e-9)
        legs_block = score_variant_legs(priced, shipped_by_key)
        legs_block["skipped_legs"] = skipped
        legs_block["changed_legs"] = changed
        prows, excluded = replay_parlays(archives, ledger_index, priced_by_key,
                                         outcome_by_key, unresolved_by_key,
                                         price_index, corr, set(weeks))
        rules = {rule: settle(select(prows, rule)) for rule in SELECTION_RULES}
        pooled = legs_block["pooled"]
        if name == BASELINE:
            verdict = None
            note = ("The baseline. Every other variant's delta and CI is measured "
                    "against these exact legs.")
        else:
            verdict = pooled["verdict"]
            note = ("%d of %d resolved leg(s) re-priced, %d changed, %d skipped by "
                    "this variant (skipped legs are never scored and never zero-filled). "
                    "%s" % (pooled["n"], len(rows), changed, skipped,
                            "No leg changed, so this variant is the baseline on the legs "
                            "resolved so far — the verdict below says 'same' because "
                            "nothing was measured, not because a difference was ruled out."
                            if changed == 0 else
                            "Reported, never adopted."))
        variants[name] = {
            "description": spec["description"],
            "legs": legs_block,
            "parlays": {"eligible": len(prows), "excluded_by_reason": excluded,
                        "rules": rules},
            "verdict": verdict,
            "note": note,
        }

    return {
        "season": ledger.get("season"),
        "generated_utc": generated_utc or _dt.datetime.now(_dt.timezone.utc)
                                             .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "weeks_replayed": weeks,
        "legs": {"on_file": counts["on_file"], "locked": counts["locked"],
                 "unlocked": counts["unlocked"], "resolved": counts["resolved"],
                 "unresolved_by_reason": reasons},
        "baseline": BASELINE,
        "variants": variants,
        "same_game_pairs": same_game_pairs_block(rows, archives, ledger_index,
                                                 shipped_by_key, outcome_by_key,
                                                 set(weeks), corr),
        "selection_rules": list(SELECTION_RULES),
        "bootstrap": {"resamples": BOOTSTRAP_RESAMPLES, "seed": BOOTSTRAP_SEED,
                      "ci_level": CI_LEVEL,
                      "statistic": "mean per-leg log-loss difference (variant - "
                                   "shipped) on identical legs; lower is better"},
        "policy": POLICY,
        "limits": LIMITS,
        "note": "R81 REPLAY LAB. Candidate parlay-improvement rules replayed against "
                "the weeks already played, on the legs that were actually locked. "
                "Nothing here is adopted, and nothing here changes a shipped number.",
    }


# ---------------------------------------------------------------------------
# Thin I/O.
# ---------------------------------------------------------------------------
def _load(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def load_inputs(season=None):
    paths = sorted(glob.glob(LEDGER_GLOB))
    if season is not None:
        want = os.path.join(DATA, "estimates", "parlays_%s.json" % season)
        paths = [p for p in paths if p == want]
    ledger = _load(paths[-1], {}) if paths else {}
    return {"ledger": ledger,
            "scores": _load(SCORES_PATH, {}) or {},
            "archives": archive_weeks(glob.glob(ARCHIVE_GLOB)),
            "pool": _load(POOL_PATH, {}) or {}}


# ---------------------------------------------------------------------------
# Selftest (pure core; writes nothing).
# ---------------------------------------------------------------------------
def _fixture():
    """Two weeks of a toy ledger: one game leg pair and two prop legs a week."""
    legs, arch1 = [], []

    def leg(week, gid, market, sel, **kw):
        row = {"season": 2026, "week": week, "market": market, "selection": sel,
               "position": MARKET_POSITION.get(market), "team": "AAA",
               "side": kw.get("side", "home"), "line": kw.get("line"),
               "mu": kw.get("mu"), "sd": kw.get("sd"), "z": kw.get("z"),
               "game_id": gid, "home": "AAA", "away": "BBB",
               "p_team": kw.get("p_team", 0.6), "model_prob": kw["model_prob"],
               "implied_prob": kw.get("implied_prob"), "pricing": kw.get("pricing"),
               "locked": kw.get("locked", True)}
        legs.append(row)
        return row

    leg(1, "G1", "moneyline", "AAA ML", model_prob=0.6, implied_prob=0.58, p_team=0.6)
    leg(1, "G1", "spread", "AAA -3", model_prob=0.5, implied_prob=0.52, line=-3.0,
        p_team=0.6)
    leg(1, "G1", "qb_pass_yds", "A. One 225+ pass yds", model_prob=0.62,
        line=224.5, mu=250.0, sd=76.66, z=0.33, p_team=0.6, pricing="calibrated")
    leg(1, "G1", "wr_rec_yds", "B. Two 60+ rec yds", model_prob=0.44,
        line=59.5, mu=48.0, sd=41.58, z=-0.28, p_team=0.6, pricing="calibrated")
    leg(1, "G2", "moneyline", "CCC ML", model_prob=0.55, implied_prob=0.54,
        p_team=0.55)
    leg(1, "G2", "rb_rush_yds", "C. Three 60+ rush yds", model_prob=0.51,
        line=59.5, mu=61.0, sd=38.87, z=0.04, p_team=0.55, pricing="calibrated")
    # an UNLOCKED leg (post-kickoff): never scored, counted as unlocked
    leg(1, "G2", "spread", "CCC -1", model_prob=0.5, implied_prob=0.51, line=-1.0,
        p_team=0.55, locked=False)
    # a week the resolver has not reached at all
    leg(2, "G9", "moneyline", "DDD ML", model_prob=0.7, implied_prob=0.68, p_team=0.7)

    resolved = [
        {"week": 1, "game_id": "G1", "market": "moneyline", "selection": "AAA ML",
         "model_prob": 0.6, "hit": True},
        {"week": 1, "game_id": "G1", "market": "spread", "selection": "AAA -3",
         "model_prob": 0.5, "hit": True},
        {"week": 1, "game_id": "G1", "market": "qb_pass_yds",
         "selection": "A. One 225+ pass yds", "model_prob": 0.62, "hit": True},
        {"week": 1, "game_id": "G1", "market": "wr_rec_yds",
         "selection": "B. Two 60+ rec yds", "model_prob": 0.44, "hit": False},
        {"week": 1, "game_id": "G2", "market": "moneyline", "selection": "CCC ML",
         "model_prob": 0.55, "hit": False},
    ]
    unresolved = [{"week": 1, "game_id": "G2", "market": "rb_rush_yds",
                   "selection": "C. Three 60+ rush yds", "reason": "no_stat_line"}]

    arch1 = {"season": 2026, "week": 1, "parlays": [
        {"parlay_id": "G1-g1", "scope": "game", "game_id": "G1",
         "legs": [{"market": "moneyline", "selection": "AAA ML", "implied_prob": 0.58,
                   "model_prob": 0.6},
                  {"market": "qb_pass_yds", "selection": "A. One 225+ pass yds",
                   "implied_prob": 0.6479, "model_prob": 0.62}],
         "model_ev": 0.0, "confidence_tier": "low"},
        {"parlay_id": "G1-g2", "scope": "game", "game_id": "G1",
         "legs": [{"market": "moneyline", "selection": "AAA ML", "implied_prob": 0.58,
                   "model_prob": 0.6},
                  {"market": "wr_rec_yds", "selection": "B. Two 60+ rec yds",
                   "implied_prob": 0.4598, "model_prob": 0.44}],
         "model_ev": 0.0, "confidence_tier": "low"},
        {"parlay_id": "wk1-w1", "scope": "week",
         "legs": [{"market": "moneyline", "selection": "AAA ML", "implied_prob": 0.58,
                   "model_prob": 0.6},
                  {"market": "moneyline", "selection": "CCC ML", "implied_prob": 0.54,
                   "model_prob": 0.55}],
         "model_ev": 0.0, "confidence_tier": "low"},
        # excluded: one leg never resolved
        {"parlay_id": "G2-g1", "scope": "game", "game_id": "G2",
         "legs": [{"market": "moneyline", "selection": "CCC ML", "implied_prob": 0.54,
                   "model_prob": 0.55},
                  {"market": "rb_rush_yds", "selection": "C. Three 60+ rush yds",
                   "implied_prob": 0.5331, "model_prob": 0.51}],
         "model_ev": 0.0, "confidence_tier": "low"},
    ]}
    pool = {"calibration": {"QB": {"a": 0.13, "b": 1.29, "c": 0.54},
                            "RB": {"a": -0.34, "b": 1.94, "c": 0.30},
                            "WR": {"a": -0.41, "b": 1.92, "c": 0.11}},
            "support": {"QB": [-2.12, 1.43], "RB": [-0.96, 1.66], "WR": [-0.95, 1.56]}}
    return ({"season": 2026, "legs": legs},
            {"season": 2026, "weeks_resolved": 1, "resolved": resolved,
             "unresolved": unresolved},
            [(1, arch1)], pool)


def _pairs_fixture():
    """Joined rows (the shape join_legs returns) for the R87 same-game pair block.

    Hand-computable on purpose, and deliberately NOT a change to _fixture(): the
    pair block needs a key with more than min_n pairs, which is more games than
    the leg/parlay fixture wants to carry.

      * 21 games, each one moneyline (home, p 0.60) + one QB prop (home, p 0.50).
        That pair is not in the measured table, so it takes default_rho = 0.10:
        independent 0.3000, shipped 0.3000 + 0.10*sqrt(0.06) = 0.3245. Both legs
        land in 7 of the 21, so observed = 7/21 = 0.3333 and the key clears min_n.
      * 5 games, each one QB prop (home, p 0.50) + one WR prop (home, p 0.40) --
        the MEASURED pair (rho 0.3146). Both land in 2 of the 5, so the numbers
        are real but n is under min_n and the verdict must say so.
    """
    rows = []

    def row(week, gid, market, sel, p, y, side="home"):
        rows.append({"week": week, "game_id": gid, "market": market,
                     "selection": sel, "position": MARKET_POSITION.get(market),
                     "side": side, "line": None, "mu": None, "sd": None, "z": None,
                     "p_team": 0.6, "shipped_prob": p, "implied_prob": None, "y": y})

    for i in range(21):
        both = 1 if i < 7 else 0
        row(1, "P%02d" % i, "moneyline", "P%02d ML" % i, 0.60, 1)
        row(1, "P%02d" % i, "qb_pass_yds", "P%02d QB 225+" % i, 0.50, both)
    for i in range(5):
        both = 1 if i < 2 else 0
        row(1, "Q%02d" % i, "qb_pass_yds", "Q%02d QB 225+" % i, 0.50, 1)
        row(1, "Q%02d" % i, "wr_rec_yds", "Q%02d WR 60+" % i, 0.40, both)
    return rows


def selftest():
    from statistics import NormalDist
    nd = NormalDist()

    # 1. Phi / Phi^-1 reproduce the stdlib to double precision, and the retired
    #    spread rule reproduces scripts/backtest_parlay.shipped_home_cover_prob
    #    exactly — the variant re-measures THAT rule, not a lookalike.
    for p in (0.0001, 0.01, 0.2, 0.5, 0.61, 0.9, 0.999, 0.9999):
        assert abs(phi_inv(p) - nd.inv_cdf(p)) < 1e-9, p
        assert abs(phi(nd.inv_cdf(p)) - p) < 1e-12, p
    import scripts.backtest_parlay as bp_
    for p_team, line in ((0.61, -3.0), (0.5, 0.0), (0.72, -7.5), (0.4, 2.5)):
        mine = v_spread_margin_model(
            {"market": "spread", "p_team": p_team, "line": line,
             "shipped_prob": 0.5}, {})
        theirs = bp_.shipped_home_cover_prob(p_team, -line)
        assert abs(mine - theirs) < 1e-9, (p_team, line, mine, theirs)
    assert abs(v_spread_margin_model(
        {"market": "spread", "p_team": 0.5, "line": 0.0, "shipped_prob": 0.5}, {})
        - 0.5) < 1e-12

    ledger, scores, archives, pool = _fixture()
    rows, reasons, counts = join_legs(ledger, scores)

    # 2. the join: locked + resolved only; everything else counted, never scored.
    assert counts == {"on_file": 8, "locked": 7, "unlocked": 1, "resolved": 5}, counts
    assert reasons == {"no_stat_line": 1, "week_not_resolved": 1}, reasons
    assert all(r["week"] == 1 for r in rows)

    ctx = {"pool_calibration": pool["calibration"], "pool_support": pool["support"]}

    # 3. every variant prices the SAME rows (bar its own counted skips).
    counts_by_variant = {}
    for name in VARIANTS:
        priced, skipped = price_rows(rows, name, ctx)
        counts_by_variant[name] = (len(priced), skipped)
        assert len(priced) + skipped == len(rows), name
    assert counts_by_variant["shipped"] == (5, 0), counts_by_variant

    # 4. the numbers each variant produces, on the fixture.
    qb = [r for r in rows if r["market"] == "qb_pass_yds"][0]
    wr = [r for r in rows if r["market"] == "wr_rec_yds"][0]
    ml = [r for r in rows if r["market"] == "moneyline"][0]
    sp = [r for r in rows if r["market"] == "spread"][0]
    assert abs(v_seed(qb, ctx) - pb.seed_prop_prob(0.6)) < 1e-12
    assert abs(v_seed(ml, ctx) - 0.6) < 1e-12
    assert v_seed(sp, ctx) == 0.5
    assert abs(v_shrink_to_half(qb, ctx) - (0.5 + 0.5 * (0.62 - 0.5))) < 1e-12
    assert v_shrink_to_half(ml, ctx) == ml["shipped_prob"], "game legs untouched"
    pool_qb = v_pool_calibration(qb, ctx)
    assert abs(pool_qb - pb._clamp(pb._sigmoid(0.13 + 1.29 * 0.33 + 0.54 * 0.1),
                                   0.05, 0.95)) < 1e-12, pool_qb
    assert v_pool_calibration(ml, ctx) == ml["shipped_prob"]
    # the SUPPORT RULE bites: a z outside the pool's range is skipped, not priced.
    out_of_support = dict(qb, z=3.0)
    assert v_pool_calibration(out_of_support, ctx) is None
    tight = {"pool_calibration": pool["calibration"],
             "pool_support": {"QB": [0.0, 0.1], "RB": [0.0, 0.1], "WR": [0.0, 0.1]}}
    priced_tight, skipped_tight = price_rows(rows, "pool_calibration", tight)
    assert skipped_tight > counts_by_variant["pool_calibration"][1], \
        "a tighter support window must skip more legs"

    # 5. the bootstrap verdict logic, on synthetic outcomes where the answer is
    #    known: a variant that is right every time is BETTER, its mirror is WORSE,
    #    and a variant identical to shipped is SAME.
    n = 400
    ship = [(0.5, i % 2) for i in range(n)]
    good = [(0.9 if y else 0.1, y) for _, y in ship]
    bad = [(0.1 if y else 0.9, y) for _, y in ship]
    d_good = [log_loss_one(p, y) - log_loss_one(0.5, y) for p, y in good]
    d_bad = [log_loss_one(p, y) - log_loss_one(0.5, y) for p, y in bad]
    assert verdict_of(paired_bootstrap(d_good)[1]) == "better"
    assert verdict_of(paired_bootstrap(d_bad)[1]) == "worse"
    assert verdict_of(paired_bootstrap([0.0] * n)[1]) == "same"
    assert verdict_of(None) is None
    # and it is deterministic: same input, same CI, every run.
    assert paired_bootstrap(d_good) == paired_bootstrap(d_good)

    doc = build(ledger=ledger, scores=scores, archives=archives, pool=pool,
                generated_utc="2026-01-01T00:00:00Z")

    # 6. the parlay replay: a parlay with an unresolved leg is EXCLUDED, counted.
    sh = doc["variants"]["shipped"]["parlays"]
    assert sh["eligible"] == 3, sh
    assert sh["excluded_by_reason"] == {"no_stat_line": 1}, sh
    assert sh["rules"]["all"]["n"] == 3
    assert sh["rules"]["max_2_legs"]["n"] == 3
    assert sh["rules"]["all"]["staked"] == 300.0
    # the settlement is a FACT: identical across variants for the same parlay set.
    for name in VARIANTS:
        rules = doc["variants"][name]["parlays"]["rules"]
        if rules["all"]["n"] == sh["rules"]["all"]["n"]:
            assert rules["all"]["net_fair"] == sh["rules"]["all"]["net_fair"], name

    # 7. the recomputed EV is the BUILDER's, not a local copy: rebuilding the
    #    archived parlay under `shipped` reproduces the archive's own arithmetic.
    corr = pb._correlation_table(pb.load_calibration())
    legs = [pb.make_leg("moneyline", "AAA ML", 0.6, implied_prob=0.58,
                        corr_tag="moneyline", side="home"),
            pb.make_leg("qb_pass_yds", "A. One 225+ pass yds", 0.62,
                        implied_prob=0.6479, corr_tag="qb_pass_yds", side="home")]
    want = pb._make_parlay("G1-g1", "game", legs, game_id="G1", corr=corr)["model_ev"]
    got = [r for r in
           replay_parlays(archives,
                          {(int(l["week"]), l["market"], l["selection"]): l
                           for l in ledger["legs"]},
                          {leg_key(r["week"], r["game_id"], r["market"], r["selection"]):
                           r["shipped_prob"] for r in rows},
                          {leg_key(r["week"], r["game_id"], r["market"], r["selection"]):
                           r["y"] for r in rows},
                          {}, br.ledger_price_index(ledger), corr, {1})[0]
           if r["parlay_id"] == "G1-g1"][0]["model_ev"]
    assert abs(got - want) < 1e-12, (got, want)

    # 8. selection rules count what they say they count.
    ev_rows = [{"week": 1, "parlay_id": "a", "scope": "game", "n_legs": 2,
                "model_ev": 0.10, "tier": "high", "bucket": "all_hit",
                "net_fair": 200.0, "net_vig2": 180.0, "assumed_price_legs": 0},
               {"week": 1, "parlay_id": "b", "scope": "game", "n_legs": 3,
                "model_ev": 0.02, "tier": "low", "bucket": "all_missed",
                "net_fair": -100.0, "net_vig2": -100.0, "assumed_price_legs": 1},
               {"week": 1, "parlay_id": "c", "scope": "week", "n_legs": 2,
                "model_ev": -0.30, "tier": "low", "bucket": "partial",
                "net_fair": -100.0, "net_vig2": -100.0, "assumed_price_legs": 2}]
    assert [r["parlay_id"] for r in select(ev_rows, "all")] == ["a", "b", "c"]
    assert [r["parlay_id"] for r in select(ev_rows, "ev_gt_0")] == ["a", "b"]
    assert [r["parlay_id"] for r in select(ev_rows, "ev_gt_0.05")] == ["a"]
    assert [r["parlay_id"] for r in select(ev_rows, "tier_high_only")] == ["a"]
    assert [r["parlay_id"] for r in select(ev_rows, "max_2_legs")] == ["a", "c"]
    s = settle(select(ev_rows, "ev_gt_0"))
    assert s == {"n": 2, "hit": 1, "staked": 200.0, "net_fair": 100.0,
                 "net_vig2": 80.0, "roi_fair": 0.5, "roi_vig2": 0.4,
                 "assumed_price_legs": 1}, s
    assert settle([])["roi_fair"] is None, "an empty selection has no ROI, not 0"

    # 9. a document with NOTHING resolved validates with nulls, never zeros.
    empty = build(ledger={"season": 2026, "legs": ledger["legs"]},
                  scores={"resolved": [], "unresolved": []},
                  archives=archives, pool=pool,
                  generated_utc="2026-01-01T00:00:00Z")
    assert empty["weeks_replayed"] == []
    assert empty["legs"]["resolved"] == 0
    assert empty["legs"]["unresolved_by_reason"] == {"week_not_resolved": 7}
    for name, v in empty["variants"].items():
        p = v["legs"]["pooled"]
        assert p["n"] == 0 and p["log_loss"] is None and p["brier"] is None, name
        assert p["hit_rate"] is None and p["ci90"] is None and p["verdict"] is None, name
        assert v["legs"]["by_week"] == [] and v["legs"]["by_market"] == {}, name
        assert v["parlays"]["eligible"] == 0, name
        assert v["parlays"]["rules"]["all"]["roi_fair"] is None, name

    # 10. nothing here can adopt: this module names no writable artifact but OUT,
    #     and no variant function is given a book price.
    src = open(os.path.abspath(__file__), "r", encoding="utf-8").read()
    writes = re.findall(r"open\(([^,]+),\s*[\"']w[\"']", src)
    assert writes == ["out_path"], writes
    for name, spec in VARIANTS.items():
        code = spec["fn"].__code__
        assert "implied_prob" not in code.co_names + code.co_consts, name

    # 11. R87 SAME-GAME PAIRS: the shipped rho scored against resolved outcomes.
    #     The key is the calibration's own key, the numbers are hand-computable,
    #     and a key under min_n prints its numbers but refuses a verdict.
    import inspect
    assert pair_key("spread", "moneyline", "home", "home") == "moneyline|spread"
    assert pair_key("moneyline", "spread", "home", "away") == "moneyline|spread|opposing"
    assert pair_key("wr_rec_yds", "qb_pass_yds", None, "home") == "qb_pass_yds|wr_rec_yds"
    assert pair_verdict(SAME_GAME_MIN_N, [-0.2, 0.2]) == "consistent"
    assert pair_verdict(SAME_GAME_MIN_N, [-0.3, -0.1]) == "shipped_high"
    assert pair_verdict(SAME_GAME_MIN_N, [0.1, 0.3]) == "shipped_low"
    assert pair_verdict(SAME_GAME_MIN_N - 1, [0.1, 0.3]) == "insufficient"
    assert pair_verdict(SAME_GAME_MIN_N, None) == "insufficient"

    corr_ship = pb._correlation_table(pb.load_calibration())
    # a team's moneyline and that team's own spread is one opinion: the slate
    # refuses to build it, so the lab refuses to score it -- and counts it.
    main_items, main_refused = pair_items(rows, corr_ship)
    assert main_refused == {"same_side_game_pair": 1}, main_refused
    assert len(main_items) == 5, len(main_items)

    by_key = {}
    for it in pair_items(_pairs_fixture(), corr_ship)[0]:
        by_key.setdefault(it["key"], []).append(it)
    assert set(by_key) == {"moneyline|qb_pass_yds", "qb_pass_yds|wr_rec_yds"}, sorted(by_key)
    # sqrt(pA(1-pA) pB(1-pB)) is sqrt(0.06) at BOTH fixture pairs (0.60, 0.50)
    # and (0.50, 0.40) -- the same denominator, by construction.
    root = math.sqrt(0.06)
    big = joint_block("moneyline|qb_pass_yds", by_key["moneyline|qb_pass_yds"])
    assert big["n"] == 21 >= SAME_GAME_MIN_N, big
    assert big["rho_shipped"] == 0.1, ("unmeasured pair -> default_rho", big)
    assert big["independent_joint"] == round(0.60 * 0.50, 4), big
    assert big["shipped_joint"] == round(0.30 + 0.1 * root, 4), big
    assert big["observed_joint"] == round(7.0 / 21.0, 4), big
    assert big["delta"] == round(7.0 / 21.0 - (0.30 + 0.1 * root), 4), big
    assert big["rho_live"] == round((7.0 / 21.0 - 0.30) / root, 4), big
    assert big["verdict"] == "consistent", ("the CI straddles 0", big)
    small = joint_block("qb_pass_yds|wr_rec_yds", by_key["qb_pass_yds|wr_rec_yds"])
    assert small["n"] == 5 and small["verdict"] == "insufficient", small
    assert small["rho_shipped"] == 0.3146, ("the measured pair", small)
    assert small["independent_joint"] == round(0.50 * 0.40, 4), small
    assert small["shipped_joint"] == round(0.20 + 0.3146 * root, 4), small
    assert small["observed_joint"] == 0.4, small
    assert small["ci90"] is not None, "numbers are still reported under min_n"
    assert joint_block("all", [])["n"] == 0
    assert joint_block("all", [])["observed_joint"] is None

    sgp = doc["same_game_pairs"]
    assert sgp["min_n"] == SAME_GAME_MIN_N
    assert [p["key"] for p in sgp["pairs"]] == sorted(p["key"] for p in sgp["pairs"])
    assert sgp["pooled"]["n"] == len(main_items) == 5, sgp["pooled"]
    assert sgp["pooled"]["rho_shipped"] is None, "pooled mixes rules: no single rho"
    assert sgp["refused_by_reason"] == {"same_side_game_pair": 1}, sgp
    cards = sgp["cards"]
    # the two archived 2-leg game cards whose legs BOTH resolved; the third is
    # excluded and counted because one of its legs never graded.
    assert cards["n"] == 2, cards
    assert cards["all_hit_rate"] == 0.5, cards
    assert cards["mean_model_independent"] == round((0.6 * 0.62 + 0.6 * 0.44) / 2, 4), cards
    j_qb = 0.6 * 0.62 + 0.1 * math.sqrt(0.6 * 0.4 * 0.62 * 0.38)
    j_wr = 0.6 * 0.44 + 0.1 * math.sqrt(0.6 * 0.4 * 0.44 * 0.56)
    assert cards["mean_model_shipped"] == round((j_qb + j_wr) / 2, 4), cards
    assert cards["verdict"] == "insufficient", cards
    assert cards["excluded_by_reason"] == {"leg_not_resolved": 1}, cards

    # with nothing resolved: no keys, and every pooled/card number null, never 0.
    esgp = empty["same_game_pairs"]
    assert esgp["pairs"] == [], esgp
    assert esgp["pooled"]["n"] == 0 and esgp["pooled"]["verdict"] == "insufficient"
    for k in ("observed_joint", "independent_joint", "shipped_joint", "rho_shipped",
              "rho_live", "delta", "ci90"):
        assert esgp["pooled"][k] is None, (k, esgp["pooled"])
    assert esgp["cards"]["n"] == 0, esgp["cards"]
    for k in ("all_hit_rate", "mean_model_shipped", "mean_model_independent",
              "delta", "ci90"):
        assert esgp["cards"][k] is None, (k, esgp["cards"])

    # and no market number is in scope anywhere in the pair code.
    for fn in (pair_key, corr_leg, pair_verdict, joint_block, pair_items,
               card_items, same_game_pairs_block):
        assert "implied_prob" not in inspect.getsource(fn), fn.__name__

    print("selftest OK: Phi/Phi^-1 match the stdlib and reproduce the retired "
          "spread rule exactly; the join scores only locked+resolved legs and "
          "counts every other one by reason; each variant prices identical legs "
          "with its skips counted; the support rule bites; the bootstrap calls "
          "better/worse/same correctly and reproducibly; a parlay with an "
          "unresolved leg is excluded; the EV comes from the builder; the "
          "selection rules count what they say; a 0-week document is all nulls; "
          "the same-game pair block keys pairs the way the calibration does, "
          "refuses the pairs the one-leg-per-game-side rule refuses, reproduces "
          "the shipped joint by hand, withholds a verdict under min_n and stays "
          "null with nothing resolved; "
          "and the only file this module can write is its own output")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=OUT, help="output path (default data/replay_lab.json)")
    ap.add_argument("--season", default=None, help="restrict to one season's ledger")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0

    inputs = load_inputs(args.season)
    doc = build(**inputs)
    out_path = args.out
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
    print("wrote %s" % os.path.relpath(out_path, _ROOT))
    print("  weeks replayed %s · %d resolved leg(s), %d unresolved (%s)"
          % (doc["weeks_replayed"] or "none", doc["legs"]["resolved"],
             sum(doc["legs"]["unresolved_by_reason"].values()) or 0,
             ", ".join("%s %d" % kv for kv in
                       sorted(doc["legs"]["unresolved_by_reason"].items())) or "none"))
    for name, v in doc["variants"].items():
        p = v["legs"]["pooled"]
        if name == BASELINE:
            print("  %-20s n %-4s log-loss %-8s (baseline)"
                  % (name, p["n"], p["log_loss"]))
            continue
        ci = v["legs"]["pooled"]["ci90"]
        print("  %-20s n %-4s log-loss %-8s delta %-9s ci90 %s -> %s"
              % (name, p["n"], p["log_loss"], p["delta_log_loss"],
                 "[%s, %s]" % (ci[0], ci[1]) if ci else "[—]", v["verdict"]))
    sgp = doc["same_game_pairs"]
    print("  same-game pairs   %d key(s) · pooled n %s obs %s vs shipped %s -> %s · "
          "cards n %s -> %s"
          % (len(sgp["pairs"]), sgp["pooled"]["n"], sgp["pooled"]["observed_joint"],
             sgp["pooled"]["shipped_joint"], sgp["pooled"]["verdict"],
             sgp["cards"]["n"], sgp["cards"]["verdict"]))
    print("  measure only — nothing in this document is adopted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
