"""R101b — the SAME-GAME joint pricer: the chance that every leg of a same-game
card hits.

Legs from one game are not independent: a game that turns into a shootout lifts
every scorer and every passing yard in it; a lopsided one lifts the favourite's
legs and sinks the underdog's. Measured on 2024-25 same-game cards, multiplying
the legs' chances under-states how often whole cards hit (6-leg MAJORITY TD
0.13 % priced vs 0.18 % realised). This module prices them jointly.

THE MODEL (a two-factor Gaussian copula). Each leg i hits when a latent normal

    Z_i = s_i * a_t * D + b_t * S + sqrt(1 - a_t^2 - b_t^2) * e_i

clears the threshold that gives it EXACTLY its own probability p_i. D is the
game's script (home side up = +), S is its scoring level; s_i = +1 for a home
leg, -1 for an away leg; (a_t, b_t) are loadings per LEG TYPE t, fitted on
earlier seasons by scripts/backtest_joint.py and read from data/joint_backtest.json.
Given (D, S) the legs are independent, so

    P(all hit) = E_{D,S} [ prod_i Phi((Phi^-1(p_i) + s_i a_t D + b_t S) / r_t) ]

computed EXACTLY (no simulation, no seed) on a 10 x 10 Gauss-Hermite grid. Two
properties the tests lock: every leg's marginal stays p_i (the model moves only
how legs move together), and zero loadings reproduce the plain product.

The runner prices every GAME card with this module (scripts/build_atd_game_cards.py)
and validate_data.py re-prices each one with it, so there is one pricing path and
no browser twin. MARKET POLICY: no book number enters.
"""

import math

TYPES = ("ML", "ATD_QB", "ATD_RB", "ATD_WR", "ATD_TE", "QBY", "RBY", "WRY")
YARD_TYPE = {"qb_pass_yds": "QBY", "rb_rush_yds": "RBY", "wr_rec_yds": "WRY"}

# Probabilists' Gauss-Hermite, 10 nodes, weights normalised to sum 1 (N(0,1)).
GH = ((-4.859462828332312, 4.310652630718277e-06), (-3.581823483551927, 7.580709343122171e-04),
      (-2.484325841638955, 1.911158050077029e-02), (-1.465989094391158, 1.354837029802677e-01),
      (-0.4849357075154977, 3.446423349320192e-01), (0.4849357075154977, 3.446423349320192e-01),
      (1.465989094391158, 1.354837029802677e-01), (2.484325841638955, 1.911158050077029e-02),
      (3.581823483551927, 7.580709343122171e-04), (4.859462828332312, 4.310652630718277e-06))
P_EPS = 1e-9


def Phi(x):
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def Phinv(p):
    """Inverse standard normal CDF (Acklam, one Newton-Halley refinement)."""
    p = min(max(p, 1e-12), 1 - 1e-12)
    a = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00)
    lo = 0.02425
    if p < lo:
        q = math.sqrt(-2 * math.log(p))
        x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    elif p <= 1 - lo:
        q = p - 0.5
        r = q * q
        x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
            (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    else:
        q = math.sqrt(-2 * math.log(1 - p))
        x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    e = Phi(x) - p
    u = e * math.sqrt(2 * math.pi) * math.exp(x * x / 2)
    return x - u / (1 + x * u / 2)


def leg_type(leg):
    """The loading class of a leg; None for a market the model does not cover."""
    m = leg.get("market")
    if m in ("moneyline", "spread"):
        return "ML"
    if m == "anytime_td":
        pos = leg.get("position")
        return "ATD_" + pos if pos in ("QB", "RB", "WR", "TE") else "ATD_WR"
    return YARD_TYPE.get(m)


def joint_prob(legs, loadings):
    """P(every leg hits) for legs of ONE game. legs: [{p, side, type}]."""
    if not legs:
        return 0.0
    rows = []
    for leg in legs:
        a, b = (loadings.get(leg["type"]) or (0.0, 0.0))
        r = math.sqrt(max(1e-9, 1.0 - a * a - b * b))
        s = 1.0 if leg["side"] == "home" else -1.0
        rows.append((Phinv(min(max(leg["p"], P_EPS), 1 - P_EPS)), s * a, b, r))
    tot = 0.0
    for dnode, wd in GH:
        for snode, ws in GH:
            f = 1.0
            for t, sa, b, r in rows:
                f *= Phi((t + sa * dnode + b * snode) / r)
            tot += wd * ws * f
    return min(max(tot, 0.0), 1.0)


def independent_prob(legs):
    out = 1.0
    for leg in legs:
        out *= leg["p"]
    return out


def selftest():
    L0 = {t: (0.0, 0.0) for t in TYPES}
    legs = [{"p": 0.6, "side": "home", "type": "ATD_RB"}, {"p": 0.3, "side": "away", "type": "WRY"},
            {"p": 0.45, "side": "home", "type": "QBY"}]
    assert abs(joint_prob(legs, L0) - independent_prob(legs)) < 1e-9, "zero loadings = product"
    L = {t: (0.3, 0.4) for t in TYPES}
    for leg in legs:
        assert abs(joint_prob([leg], L) - leg["p"]) < 1e-6, "each marginal is kept"
    same = [{"p": 0.4, "side": "home", "type": "ATD_RB"}, {"p": 0.4, "side": "home", "type": "ATD_WR"}]
    opp = [{"p": 0.4, "side": "home", "type": "ATD_RB"}, {"p": 0.4, "side": "away", "type": "ATD_WR"}]
    Ls = {t: (0.4, 0.0) for t in TYPES}
    assert joint_prob(same, Ls) > 0.16 > joint_prob(opp, Ls), "script factor: same side up, opposite down"
    assert abs(Phinv(0.975) - 1.959964) < 1e-5
    print("selftest ok: zero loadings = product, marginals kept, script factor signs")


if __name__ == "__main__":
    selftest()
