"""Parlay builder: >=3 parlays per game and >=3 per week, correlation-aware.

Each parlay matches data/contracts/parlays.schema.json:

    {parlay_id, scope, game_id?, legs, model_ev, confidence_tier, correlation_note}

where a leg is {market, selection, implied_prob, model_prob} plus optional honesty
annotations (edge_note on spread legs; pricing / estimate / estimate_note / mu / sd /
z / line on prop legs).

## Edge

The edge of a leg is `model_prob - implied_prob`: our probability minus the
sportsbook-implied (vig-inclusive) probability. A parlay is worth listing when the
combined model probability exceeds what the combined price implies.

## Correlation (the invariant that separates this from a naive multiplier)

Legs within the SAME GAME are usually correlated. A QB throwing for a big game and his
WR going over on receiving yards are not independent events — they tend to happen
together (positive correlation). Naively multiplying leg probabilities (the independence
assumption) therefore MIS-states a same-game parlay's true probability: it understates
positively-correlated combos and overstates negatively-correlated ones. Sportsbooks
price (or block) same-game parlays precisely because of this. So:

  * Same-game parlays carry a non-trivial `correlation_note` and their combined
    probability is computed with a pairwise correlation adjustment (a Gaussian-copula-
    lite bump), NOT a bare product.
  * Cross-game ("week") parlays are treated as independent legs (rho = 0) and the note
    says so explicitly ("independent legs").

Since R51 the pairwise rhos are MEASURED (scripts/backtest_parlay.py, copula-lite rho on
resolved 2023-25 games) and read from data/parlay_backtest.json; the table in this
module is the fallback and carries the same measured numbers.

## Confidence tier (conformal-flavored)

`confidence_tier` (high/medium/low) is a proxy for the harness's split-conformal
coverage bands (scripts/harness/conformal.py): a large edge on few legs is "high"; a
thin edge or many legs is "low". Once enough parlays resolve, the optimizer can replace
this heuristic with a calibrated conformal tier. Until then it is an honest ordinal, not
a probability.

## Honesty on prices

When a leg is supplied with a real book `implied_prob`, we use it and a genuine edge can
appear. When no real line is available yet (scaffold / pre-odds-feed), we derive the
implied probability from the model probability plus a standard hold — which yields a
slightly NEGATIVE single-leg edge (you pay the vig). We never fabricate a positive edge
out of thin air; a positive edge requires a real, beatable line.

## MARKET INDEPENDENCE (permanent owner policy — the reason this module was rewritten)

"I don't want to use Vegas odds in my predictions. If I use them, I'd only want to show
them. I want to operate independently of Vegas."

A market price may be DISPLAYED; it may never be an INPUT to a number we produce. On a
leg that means: the book's de-vigged probability goes to `implied_prob` (the IMPL column)
and NOWHERE else. `model_prob` is ours or the leg does not ship.

Until R30 this was inverted for spread and total legs: the book's de-vigged cover price
was passed as make_leg's `model_prob`, and the IMPL column was fabricated back off it.
R30 replaced that with OUR margin model at the book's handicap (Elo win probability
inverted through the normal CDF, margin = PHI^-1(p) x 13.5, re-read at the number) and
dropped the total leg outright (no scoring model exists anywhere in this repo).

## R51 — what the backtest found, and what changed (scripts/backtest_parlay.py)

  * SPREAD — the R30 cover rule was MEASURED for the first time: walk-forward on 797
    resolved 2023-25 games it scores log-loss 0.7231 against 0.6931 for a flat 0.5, and
    its picks hit 44-56% in every conviction bin (break-even 52.4%). It has no edge. A
    spread leg is therefore priced at model_prob = 0.5 EXACTLY at the book's number and
    carries `edge_note` saying so; `implied_prob` stays the book's de-vigged cover
    price, so the leg's edge is the negative hold and it falls out of the ranking on
    its own. The margin-inversion pricing path (model_home_margin / model_cover_prob)
    is retired — nothing else called it. The handicap is still required: no number,
    no leg.
  * PROPS — the documented seed (0.5 shaded by team win probability, clamped to
    [0.35, 0.65]) was measured too: 2025 log-loss 0.6820. A calibrated per-position
    logistic on the player's projected yards against the line,
        p = sigmoid(a + b*z + c*(p_team - 0.5)),  z = (mu - line) / sd_pos,
    scores 0.6705 on the same fold (0.6920 -> 0.6765 on the 2024 fold) and is adopted
    under never-regress. Coefficients and residual sds are READ from
    data/parlay_backtest.json (props.calibration / props.residual_sd); production mu is
    the player's projected yards THIS WEEK (season component x weekly share, see
    build_props_by_game). If the file is absent or a position lacks coefficients the
    leg falls back to the seed and is stamped `estimate_note` — never silently.
  * TOTAL — still not emitted (no scoring model).

Deterministic, stdlib only, reads fixtures.
"""

import itertools
import json
import math
import os
import sys

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# The backtest artifact the builder prices from (prop calibration + correlations).
# Produced by scripts/backtest_parlay.py; verified by `--gate`.
DEFAULT_CALIBRATION_PATH = os.path.join(_REPO_ROOT, "data", "parlay_backtest.json")

# Standard two-way sportsbook hold applied to derive a placeholder implied probability
# when no real line is supplied. ~4.5% is a typical NFL two-way hold.
_DEFAULT_HOLD = 0.045

# Pairwise correlation for same-game legs, keyed on an unordered pair of market tags.
# MEASURED 2023-25 (copula-lite rho on resolved games, scripts/backtest_parlay.py) and
# re-fit by that script into data/parlay_backtest.json, which is the live source; this
# table is the FALLBACK when the file is absent and carries the same measured numbers:
#   favorite ML & favorite cover     0.71 (n 796)   [pre-R51 prior 0.55]
#   QB 225+ & same-team WR 60+       0.32 (n 497)   [prior 0.45]
#   QB 225+ & same-team RB 60+       0.00 (n 404)   [prior 0.20 default; measured -0.02]
#   QB 225+ & OPPOSING WR 60+        0.10 (n 302)   [explicit opposing-sides measurement]
#   RB 60+ & his team wins           0.28 (n 814)   [prior 0.25]
# Pairs without a measurement take the same-game default. Pairs that had a prior but
# no measurement (qb_pass_yds|team_total, moneyline|total, spread|total) are dropped:
# no total leg exists to combine, so the rows were dead.
_SAME_GAME_DEFAULT_RHO = 0.10
_CORR_RULES = {
    frozenset(("moneyline", "spread")): 0.71,
    frozenset(("qb_pass_yds", "wr_rec_yds")): 0.32,
    frozenset(("qb_pass_yds", "rb_rush_yds")): 0.0,
    frozenset(("rb_rush_yds", "moneyline")): 0.28,
}
# Explicit OPPOSING-sides measurements (the two legs sit on different teams). When a
# pair has one, it is used as measured; otherwise the same-side rho flips sign.
_CORR_RULES_OPPOSING = {
    frozenset(("qb_pass_yds", "wr_rec_yds")): 0.10,
}

# Spread verdict (R51): the measured numbers behind the flat price, used for the leg's
# edge_note when the calibration file is absent. From scripts/backtest_parlay.py.
_SPREAD_MEASURED = (0.7231, 0.6931, 797)

# Confidence-tier thresholds on combined edge (model_prob - implied_prob of the parlay).
_TIER_HIGH_EDGE = 0.12
_TIER_MED_EDGE = 0.04

# Leg annotation keys that survive _strip_leg (all optional, all honesty markers).
_LEG_ANNOTATIONS = ("edge_note", "pricing", "estimate", "estimate_note",
                    "mu", "sd", "z", "line")


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _sigmoid(x):
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


# ---------------------------------------------------------------------------
# Calibration file (data/parlay_backtest.json) — loaded once per path, absent -> None.
# ---------------------------------------------------------------------------
_CALIBRATION_CACHE = {}


def load_calibration(path=DEFAULT_CALIBRATION_PATH):
    """The parlay backtest document, or None when the file is absent/unreadable.

    Absence is a legitimate state (a fresh checkout before the backtest ran); every
    consumer falls back to its documented default AND stamps the output so the
    fallback is visible, never silent.
    """
    if path is None:
        return None
    if path in _CALIBRATION_CACHE:
        return _CALIBRATION_CACHE[path]
    doc = None
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        doc = None
    _CALIBRATION_CACHE[path] = doc
    return doc


def _correlation_table(calib):
    """(same-side rules, opposing rules, default_rho) from the calibration doc.

    Falls back to the module tables (the same measured numbers) when the document
    carries no correlations block.
    """
    pairs = ((calib or {}).get("correlations") or {}).get("pairs") or []
    if not pairs:
        return dict(_CORR_RULES), dict(_CORR_RULES_OPPOSING), _SAME_GAME_DEFAULT_RHO
    same, opp = {}, {}
    for p in pairs:
        rho = p.get("rho")
        parts = str(p.get("key", "")).split("|")
        if rho is None:
            continue
        if len(parts) == 2:
            same[frozenset(parts)] = float(rho)
        elif len(parts) == 3 and parts[2] == "opposing":
            opp[frozenset(parts[:2])] = float(rho)
    default = calib["correlations"].get("default_rho", _SAME_GAME_DEFAULT_RHO)
    return same, opp, float(default)


def _spread_edge_note(calib):
    sp = (calib or {}).get("spread") or {}
    ll, flat, n = sp.get("model_cover_log_loss"), sp.get("flat_log_loss"), sp.get("n")
    if ll is None or flat is None or n is None:
        ll, flat, n = _SPREAD_MEASURED
    return ("NO EDGE — cover model measured below coin-flip (log-loss %.4f vs %.4f, "
            "%d games 2023-25); priced flat until a margin model clears never-regress"
            % (float(ll), float(flat), int(n)))


# ---------------------------------------------------------------------------
# Legs.
# ---------------------------------------------------------------------------
def make_leg(market, selection, model_prob, implied_prob=None, hold=_DEFAULT_HOLD,
             corr_tag=None, side=None):
    """Build a parlay leg.

    market      : market type, e.g. 'moneyline', 'spread', 'qb_pass_yds'.
    selection   : the specific pick, e.g. 'KC ML', 'KC -3.5'.
    model_prob  : our probability (0..1).
    implied_prob: real book-implied probability if known; else derived from model_prob
                  plus `hold` (a placeholder line — see module docstring on honesty).
    corr_tag    : correlation tag used by the correlation rules (defaults to `market`).
    side        : 'home'/'away' — used to detect same/opposing direction.
    """
    mp = _clamp(float(model_prob), 1e-4, 1.0 - 1e-4)
    if implied_prob is None:
        # Placeholder line: charge the vig, producing a slightly negative single-leg
        # edge. No real (beatable) line -> no claimed positive edge.
        ip = _clamp(mp * (1.0 + hold), 1e-4, 1.0 - 1e-4)
    else:
        ip = _clamp(float(implied_prob), 1e-4, 1.0 - 1e-4)
    return {
        "market": market,
        "selection": selection,
        "implied_prob": round(ip, 4),
        "model_prob": round(mp, 4),
        # Non-schema helper fields consumed internally then stripped before output.
        "_corr_tag": corr_tag or market,
        "_side": side,
    }


def _strip_leg(leg):
    """Return a schema-clean copy of a leg: the four contract fields plus any honesty
    annotations present (internal underscore helpers removed)."""
    out = {
        "market": leg["market"],
        "selection": leg["selection"],
        "implied_prob": leg["implied_prob"],
        "model_prob": leg["model_prob"],
    }
    for k in _LEG_ANNOTATIONS:
        if k in leg:
            out[k] = leg[k]
    return out


def _pair_rho(a, b, corr=None):
    """Measured correlation for a pair of same-game legs.

    `corr` is (same_rules, opposing_rules, default) from _correlation_table; None uses
    the module fallback tables. Looks the pair up on its correlation tags, falling back
    to the same-game default. If the two legs point in OPPOSING directions (a home leg
    and an away leg in the same game) the pair's explicit opposing-sides measurement is
    used when one exists; otherwise the same-side rho flips sign — betting both sides
    of one script are negatively related.
    """
    same, opp, default = corr if corr is not None else _correlation_table(None)
    key = frozenset((a.get("_corr_tag"), b.get("_corr_tag")))
    rho = same.get(key, default)
    sa, sb = a.get("_side"), b.get("_side")
    if sa and sb and {sa, sb} == {"home", "away"}:
        rho = opp[key] if key in opp else -abs(rho)
    return _clamp(rho, -0.95, 0.95)


def _combine_two(p_joint, p_next, rho):
    """Combine a running joint probability with the next leg under correlation `rho`.

    Gaussian-copula-lite: joint = p*q + rho * sqrt(p(1-p) q(1-q)). At rho=0 this is the
    independence product p*q. Positive rho lifts the joint toward min(p,q) (legs co-occur);
    negative rho pushes it down. Clamped to a valid probability that respects the
    Frechet bounds (can't exceed the smaller marginal, can't go below 0).
    """
    indep = p_joint * p_next
    adjust = rho * math.sqrt(p_joint * (1.0 - p_joint) * p_next * (1.0 - p_next))
    joint = indep + adjust
    return _clamp(joint, 0.0, min(p_joint, p_next))


def _combined_probs(legs, correlated, corr=None):
    """Return (combined_model_prob, combined_implied_prob).

    correlated=False -> pure independence product (cross-game / week parlays).
    correlated=True  -> sequential pairwise correlation adjustment on the MODEL side.

    The IMPLIED side is always the independence product: books price parlay legs by
    multiplying (or refuse to combine correlated legs at all), so the mispricing — and
    the whole reason correlated parlays are interesting — lives in the gap between the
    correlation-aware model prob and the independence-priced implied prob.
    """
    if not legs:
        return 0.0, 0.0

    # Implied: always the independent product.
    implied = 1.0
    for leg in legs:
        implied *= leg["implied_prob"]

    if not correlated or len(legs) == 1:
        model = 1.0
        for leg in legs:
            model *= leg["model_prob"]
        return model, implied

    # Model, correlation-aware: fold legs in one at a time, using the correlation of the
    # incoming leg against the previously-added leg (a tractable sequential approximation
    # to a full joint copula — good enough to get sign and magnitude directionally right).
    model = legs[0]["model_prob"]
    for i in range(1, len(legs)):
        rho = _pair_rho(legs[i - 1], legs[i], corr)
        model = _combine_two(model, legs[i]["model_prob"], rho)
    return model, implied


def _confidence_tier(model_prob, implied_prob, n_legs):
    """Ordinal confidence tier (conformal-flavored) from the parlay's combined edge."""
    edge = model_prob - implied_prob
    # More legs => more compounding uncertainty => demote a tier.
    leg_penalty = 0.01 * max(0, n_legs - 2)
    eff = edge - leg_penalty
    if eff >= _TIER_HIGH_EDGE:
        return "high"
    if eff >= _TIER_MED_EDGE:
        return "medium"
    return "low"


def _make_parlay(parlay_id, scope, legs, game_id=None, corr=None):
    """Assemble a schema-valid parlay dict with EV, tier, and correlation note."""
    correlated = scope == "game"
    model_p, implied_p = _combined_probs(legs, correlated, corr)

    # EV of a $1 stake at fair decimal odds implied by the book price (1/implied): you
    # win (1/implied - 1) with prob model_p, lose 1 otherwise. EV = model_p/implied - 1.
    ev = (model_p / implied_p - 1.0) if implied_p > 0 else -1.0

    tier = _confidence_tier(model_p, implied_p, len(legs))

    if correlated:
        note = (
            "Same-game legs are correlated; combined probability uses a pairwise "
            "correlation adjustment (not the independence product). Book prices legs "
            "independently, so the edge lives in that gap."
        )
    else:
        note = "Cross-game legs treated as independent (rho=0)."

    parlay = {
        "parlay_id": parlay_id,
        "scope": scope,
        "legs": [_strip_leg(l) for l in legs],
        "model_ev": round(ev, 4),
        "confidence_tier": tier,
        "correlation_note": note,
    }
    if game_id is not None:
        parlay["game_id"] = game_id
    return parlay


# ---------------------------------------------------------------------------
# Candidate leg derivation from a game prediction (+ optional real market / props).
# ---------------------------------------------------------------------------
def derive_candidate_legs(game_pred, market=None, props=None,
                          calibration_path=DEFAULT_CALIBRATION_PATH):
    """Build a deterministic set of same-game candidate legs for one game.

    game_pred : a record from game_model.predict_game (has probs, home, away, game_id).
    market    : optional real lines (scrape/odds_api.fetch_markets shape), any of:
                  {"moneyline": {"home_prob":..,"away_prob":..},
                   "spread": {"home_cover_prob":..,"away_cover_prob":..,
                              "home_point":..,"home_selection":..,"away_selection":..},
                   "total":  {"over_prob":..,"line":..}}
                Every probability in here is a BOOK price: it may only ever reach
                `implied_prob` (the display-only IMPL column). `home_point` is the
                handicap — the terms of the bet.
    props     : optional list of prop legs already in make_leg shape (dicts with
                market/selection/model_prob and optionally implied_prob/_corr_tag/_side
                plus honesty annotations, see build_props_by_game).

    Leg count is NOT fixed: a leg exists only where we have a model for it. Always at
    least the favorite moneyline; the spread leg needs a real handicap; the total leg
    is not emitted at all (no scoring model — see the module docstring).
    """
    probs = game_pred.get("probs", {"home": 0.5, "away": 0.5})
    home, away = game_pred.get("home", "HOME"), game_pred.get("away", "AWAY")
    p_home = float(probs.get("home", 0.5))
    p_away = float(probs.get("away", 0.5))

    fav_is_home = p_home >= p_away
    fav = home if fav_is_home else away
    fav_side = "home" if fav_is_home else "away"
    p_fav = max(p_home, p_away)

    legs = []

    # 1) Moneyline on the favorite. Use a real implied prob if supplied.
    ml = (market or {}).get("moneyline") or {}
    ml_implied = ml.get("home_prob") if fav_is_home else ml.get("away_prob")
    legs.append(make_leg("moneyline", "%s ML" % fav, p_fav, implied_prob=ml_implied,
                         corr_tag="moneyline", side=fav_side))

    # 2) Spread cover on the side OUR model favors, at the book's handicap, priced at
    #    EXACTLY 0.5 (R51: the cover model measured below coin-flip — module docstring).
    #
    #    THE SIDE IS CHOSEN ONCE (fav_side, above) and the label, the probability and
    #    the correlation side are all read off that one choice (R30 F2: an away
    #    favorite once produced a card naming one team and pricing the other).
    #
    #    No handicap -> NO LEG. A cover bet without a number is not a bet, and the
    #    book's cover price is not a substitute for a model.
    spread = (market or {}).get("spread") or {}
    home_point = spread.get("home_point")
    sel = spread.get("%s_selection" % fav_side)
    if home_point is not None and sel:
        # DISPLAY ONLY: the book's de-vigged cover probability for the SAME side, which
        # is what the IMPL column is supposed to show. It never touches model_prob.
        book_cover = (spread.get("home_cover_prob") if fav_is_home
                      else spread.get("away_cover_prob"))
        leg = make_leg("spread", sel, 0.5, implied_prob=book_cover,
                       corr_tag="spread", side=fav_side)
        leg["edge_note"] = _spread_edge_note(load_calibration(calibration_path))
        legs.append(leg)

    # 3) Game total OVER — NOT EMITTED. There is no scoring/total model in this repo:
    #    nothing projects game or team points, so we cannot produce P(over) ourselves.
    #    The two numbers within reach were the book's `over_prob` (a market price — the
    #    exact thing that must never be a model input) and a flat 0.5 seed (not a
    #    model). Dropping the leg is the honest outcome and the owner's instruction.
    #    Emitting it again requires a real scoring model, not a fallback; the gate check
    #    validate_data.check_parlay_model_independence() reds if a total leg reappears.

    # 4+) Prop legs (e.g. QB pass yards + his WR receiving yards) appended with their
    #     honesty annotations carried through to the output.
    for prop in (props or []):
        leg = make_leg(
            prop["market"], prop["selection"], prop["model_prob"],
            implied_prob=prop.get("implied_prob"),
            corr_tag=prop.get("_corr_tag", prop["market"]),
            side=prop.get("_side"),
        )
        for k in _LEG_ANNOTATIONS:
            if k in prop:
                leg[k] = prop[k]
        legs.append(leg)

    return legs


# ---------------------------------------------------------------------------
# Player-prop leg derivation (feeds the props= path of build_game_parlays).
# ---------------------------------------------------------------------------
# Prop lines per position: (market/corr tag, yardage line, selection label, the
# player_weekly league_components key that carries the season yards).
# The lines are DOCUMENTED SEEDS, not book lines: round league-typical thresholds
# (a mid-tier starter's over/under) — the same lines scripts/backtest_parlay.py
# calibrates against. When a real prop feed lands, its line/implied_prob replaces
# these via make_leg and the calibration must be re-measured at the feed's lines.
_PROP_SEEDS = {
    "QB": ("qb_pass_yds", 224.5, "pass yds", "pass_yd"),
    "RB": ("rb_rush_yds", 59.5, "rush yds", "rush_yd"),
    "WR": ("wr_rec_yds", 59.5, "rec yds", "rec_yd"),
}

# FALLBACK prop model_prob (pre-R51 seed, used only when the calibration file is
# absent or the position has no coefficients — and then stamped `estimate_note`):
# start at the fair-line 0.5 and shade by the player's TEAM win probability, clamped
# so a seeded prop never claims strong conviction either way:
#   model_prob = clamp(0.5 + _PROP_WIN_SHADE * (p_team_win - 0.5), 0.35, 0.65)
_PROP_WIN_SHADE = 0.4
_PROP_CLAMP_LO = 0.35
_PROP_CLAMP_HI = 0.65
_SEED_NOTE = "seed pricing — calibration file absent"

# Calibrated prop probabilities are clamped here: the logistic is fit on a bounded
# feature range and a leg should never claim near-certainty on a yardage line.
_PROP_CAL_LO = 0.05
_PROP_CAL_HI = 0.95


def _abbrev_player(name):
    """'Patrick Mahomes' -> 'P. Mahomes' for compact selection strings."""
    tokens = str(name).split()
    if len(tokens) < 2:
        return str(name)
    return "%s. %s" % (tokens[0][0], " ".join(tokens[1:]))


def _week_row(weeks, game_pred, side):
    """The player's weekly row for THIS game.

    Matched on game_pred['week'] when the record carries one; otherwise on the
    opponent + home flag from the weekly record (a divisional rematch differs on
    the home flag, so the pair is unique). None when no row matches.
    """
    opp = game_pred.get("away") if side == "home" else game_pred.get("home")
    wk = game_pred.get("week")
    for w in weeks or []:
        if w.get("bye"):
            continue
        if wk is not None:
            if int(w.get("wk", -1)) == int(wk):
                return w
        elif w.get("opp") == opp and bool(w.get("home")) == (side == "home"):
            return w
    return None


def project_prop_yards(pos, weekly_rec, game_pred, side):
    """The player's projected yards THIS WEEK, or (None, reason).

    mu = season component yards x weekly share, where the season component is the
    player_weekly `league_components` entry for the position (pass_yd / rush_yd /
    rec_yd) and the weekly share is this week's pts / the sum of non-bye pts across
    the player's weeks. The weekly split (build_weekly) already tilts each week by
    the Elo matchup and home/away, so the share CARRIES the matchup: production uses
    dvp = 1. The backtest's z used an explicit 0.5-shrink defence-vs-position
    multiplier instead — an accepted mismatch, to be re-measured next season with a
    production-shaped feature.

    Returns (mu, None) or (None, reason) with reason in
    {"no_component", "no_week_row", "zero_season_pts"} — every reason is counted by
    the caller and reported, never zero-filled.
    """
    comp_key = _PROP_SEEDS[pos][3]
    comps = (weekly_rec or {}).get("league_components") or {}
    season_yards = comps.get(comp_key)
    if season_yards is None:
        return None, "no_component"
    weeks = (weekly_rec or {}).get("weeks") or []
    row = _week_row(weeks, game_pred, side)
    if row is None:
        return None, "no_week_row"
    total = sum(float(w.get("pts") or 0.0) for w in weeks if not w.get("bye"))
    if total <= 0:
        return None, "zero_season_pts"
    share = float(row.get("pts") or 0.0) / total
    return float(season_yards) * share, None


def calibrated_prop_prob(pos, mu, p_team, calib):
    """(model_prob, sd, z) from the calibration doc, or None when the position has no
    coefficients / residual sd there."""
    props = (calib or {}).get("props") or {}
    cal = (props.get("calibration") or {}).get(pos)
    sd = (props.get("residual_sd") or {}).get(pos)
    if not cal or not sd or float(sd) <= 0:
        return None
    line = _PROP_SEEDS[pos][1]
    z = (float(mu) - line) / float(sd)
    p = _sigmoid(float(cal["a"]) + float(cal["b"]) * z
                 + float(cal["c"]) * (float(p_team) - 0.5))
    return _clamp(p, _PROP_CAL_LO, _PROP_CAL_HI), float(sd), z


def seed_prop_prob(p_team):
    return _clamp(0.5 + _PROP_WIN_SHADE * (float(p_team) - 0.5),
                  _PROP_CLAMP_LO, _PROP_CLAMP_HI)


def _calibration_covers(calib, pos):
    props = (calib or {}).get("props") or {}
    return bool((props.get("calibration") or {}).get(pos)
                and (props.get("residual_sd") or {}).get(pos))


def _report_skipped_props(skipped):
    """ONE stderr line per skip reason (house rule: skipped loudly, counted)."""
    for reason, n in sorted(skipped.items()):
        if n:
            print("parlay_builder: %d prop leg(s) skipped — %s (no yards projection "
                  "to price from; nothing invented)" % (n, reason), file=sys.stderr)


def build_props_by_game(game_preds, player_weekly_doc, player_projections_doc,
                        calibration_path=DEFAULT_CALIBRATION_PATH):
    """Derive player-prop legs per game: top QB, top RB, top WR on the slate.

    game_preds             : list of game_model.predict_game records (game_id, home,
                             away, probs; `week` when present).
    player_weekly_doc      : data/player_weekly.json shape ({"players": [{gsis_id,
                             league_components, weeks, ..}]}). Roster sanity filter
                             (only players with weekly data are eligible — a projection
                             with no weekly record is stale or unrostered — skip, never
                             guess) AND the source of this week's projected yards.
    player_projections_doc : data/player_projections.json shape ({"players": [
                             {gsis_id, name, team, position, proj_points, ...}]}).
    calibration_path       : data/parlay_backtest.json (props.calibration,
                             props.residual_sd). Absent -> seed fallback, stamped.

    Player choice is unchanged: the top-projected QB (market qb_pass_yds), RB
    (rb_rush_yds) and WR (wr_rec_yds) among the two teams' players by proj_points desc,
    ties broken by gsis_id asc (deterministic).

    Pricing (R51): mu = project_prop_yards (season component x weekly share);
    model_prob = clamp(sigmoid(a + b*z + c*(p_team - 0.5)), 0.05, 0.95) with
    z = (mu - line) / sd_pos and a, b, c, sd_pos from the calibration file —
    `pricing: "calibrated"`. A leg whose yards cannot be projected (component key
    missing, no weekly row for this game, zero season points) is SKIPPED and COUNTED,
    never invented. When the calibration file is absent or the position lacks
    coefficients: the pre-R51 seed, `pricing: "seed"`, `estimate_note` set.

    Each leg is a dict the props= path of build_game_parlays consumes:
    {market, selection, model_prob, _corr_tag, _side} plus provenance (gsis_id, line,
    estimate, pricing, mu, sd, z, estimate_note?). No implied_prob is attached, so
    make_leg charges the standard hold (no fabricated positive edge).
    Returns {game_id: [prop leg dicts]}.
    """
    calib = load_calibration(calibration_path)
    weekly_by_id = {}
    for rec in (player_weekly_doc or {}).get("players", []) or []:
        if rec.get("gsis_id"):
            weekly_by_id[rec["gsis_id"]] = rec
    players = (player_projections_doc or {}).get("players", []) or []
    skipped = {"no_component": 0, "no_week_row": 0, "zero_season_pts": 0}

    out = {}
    for gp in game_preds:
        gid = str(gp.get("game_id", "GAME"))
        home, away = gp.get("home", "HOME"), gp.get("away", "AWAY")
        p_home = float(gp.get("probs", {}).get("home", 0.5))

        legs = []
        for pos in ("QB", "RB", "WR"):
            market, line, label, _comp = _PROP_SEEDS[pos]
            cands = [
                p for p in players
                if p.get("position") == pos
                and p.get("team") in (home, away)
                and p.get("gsis_id") in weekly_by_id
            ]
            # Stable rank: proj_points desc, tie by gsis_id asc (deterministic).
            cands.sort(key=lambda p: (-float(p.get("proj_points", 0.0)),
                                      str(p.get("gsis_id"))))
            if not cands:
                continue  # no eligible player at this position; honest omission
            top = cands[0]
            side = "home" if top.get("team") == home else "away"
            p_team = p_home if side == "home" else 1.0 - p_home

            mu, reason = project_prop_yards(pos, weekly_by_id.get(top.get("gsis_id")),
                                            gp, side)
            leg = {
                "market": market,
                "selection": "%s %d+ %s" % (
                    _abbrev_player(top.get("name", "?")),
                    int(math.ceil(line)), label,
                ),
                "_corr_tag": market,
                "_side": side,
                # Provenance (ignored by make_leg; carried to the output leg).
                "gsis_id": top.get("gsis_id"),
                "line": line,
                "estimate": True,
            }
            if _calibration_covers(calib, pos):
                if mu is None:
                    # Calibration exists but this player's yards cannot be projected:
                    # skip loudly. A seed here would be a number no model produced.
                    skipped[reason] += 1
                    continue
                p, sd, z = calibrated_prop_prob(pos, mu, p_team, calib)
                leg.update({
                    "model_prob": round(p, 4),
                    "pricing": "calibrated",
                    "mu": round(mu, 2), "sd": round(sd, 2), "z": round(z, 4),
                })
            else:
                leg.update({
                    "model_prob": round(seed_prop_prob(p_team), 4),
                    "pricing": "seed",
                    "estimate_note": _SEED_NOTE,
                })
                if mu is not None:
                    leg["mu"] = round(mu, 2)
            legs.append(leg)
        out[gid] = legs
    _report_skipped_props(skipped)
    return out


def build_game_parlays(game_pred, market=None, props=None,
                       calibration_path=DEFAULT_CALIBRATION_PATH):
    """Build >=3 correlation-aware parlays for a single game.

    Uses distinct 2-leg combinations of the candidate legs, favoring pairs with the
    strongest (signed) correlation first so the flagship same-game parlays are the most
    correlation-sensitive ones. Deterministic (stable ordering).
    """
    game_id = game_pred.get("game_id", "GAME")
    corr = _correlation_table(load_calibration(calibration_path))
    legs = derive_candidate_legs(game_pred, market=market, props=props,
                                 calibration_path=calibration_path)

    # Enumerate all unordered 2-leg combinations, rank by |rho| desc (most correlated
    # first) then by combined EV desc, both deterministic tie-breaks by index.
    combos = []
    for i in range(len(legs)):
        for j in range(i + 1, len(legs)):
            pair = [legs[i], legs[j]]
            rho = _pair_rho(legs[i], legs[j], corr)
            model_p, implied_p = _combined_probs(pair, correlated=True, corr=corr)
            ev = (model_p / implied_p - 1.0) if implied_p > 0 else -1.0
            combos.append((-abs(rho), -ev, i, j, pair))
    combos.sort()

    parlays = []
    # Take the top distinct combos; guarantee at least 3. With a real slate the candidate
    # set is the favorite ML + a priced spread + three prop legs, so there are plenty of
    # pairs; a game with no handicap and no eligible props yields only the ML leg and the
    # top-up loop below carries the >=3 invariant instead.
    for k, (_, _, i, j, pair) in enumerate(combos[:max(3, 3)]):
        pid = "%s-g%d" % (game_id, k + 1)
        parlays.append(_make_parlay(pid, "game", pair, game_id=game_id, corr=corr))

    # If fewer than 3 combos existed, top up with single-leg parlays so the >=3 invariant
    # still holds. (Only reached when a game has fewer than 3 candidate legs.)
    idx = len(parlays)
    while len(parlays) < 3 and legs:
        pid = "%s-g%d" % (game_id, idx + 1)
        parlays.append(_make_parlay(pid, "game", [legs[idx % len(legs)]],
                                    game_id=game_id, corr=corr))
        idx += 1

    return parlays


def build_week_parlays(game_preds, markets_by_game=None, max_parlays=6):
    """Build >=3 cross-game ("week") parlays from the slate's best single legs.

    Takes the favorite moneyline leg from each game and combines legs from DIFFERENT
    games (independent, rho=0). Produces distinct 2-leg cross-game combinations.
    Deterministic. Requires >=2 games for genuine cross-game parlays; with a 1-game
    slate it degrades to same-game week parlays so the >=3 count still holds.
    """
    markets_by_game = markets_by_game or {}
    # One representative (favorite moneyline) leg per game, in slate order.
    game_legs = []
    for gp in game_preds:
        gid = gp.get("game_id", "GAME")
        legs = derive_candidate_legs(gp, market=markets_by_game.get(gid))
        game_legs.append((gid, legs[0]))  # legs[0] is the favorite ML by construction

    parlays = []
    n = len(game_legs)
    if n >= 2:
        combos = []
        for i in range(n):
            for j in range(i + 1, n):
                combos.append((i, j))
        for k, (i, j) in enumerate(combos[:max_parlays]):
            pair = [game_legs[i][1], game_legs[j][1]]
            pid = "week-%d" % (k + 1)
            parlays.append(_make_parlay(pid, "week", pair))
        # Ensure at least 3: if only 2 games (1 combo), add 3-leg / repeat-safe combos.
        idx = len(parlays)
        while len(parlays) < 3 and n >= 2:
            # Rotate a 2-leg combo across available games deterministically.
            i = idx % n
            j = (idx + 1) % n
            if i == j:
                j = (j + 1) % n
            pair = [game_legs[i][1], game_legs[j][1]]
            parlays.append(_make_parlay("week-%d" % (idx + 1), "week", pair))
            idx += 1
    else:
        # Single-game slate: fall back to that game's same-game parlays labeled 'week'
        # so the >=3/week invariant is still met (with an honest independence note that
        # will not apply — kept minimal; a real slate has many games).
        if game_legs:
            gp = game_preds[0]
            for k, p in enumerate(build_game_parlays(gp)[:3]):
                p = dict(p)
                p["parlay_id"] = "week-%d" % (k + 1)
                parlays.append(p)

    return parlays


# Week ("cross-game") parlays are offered at these leg counts, a few per count, so
# the UI can present a 2..7-leg selector. Same-game parlays stay 2-leg (a single
# game only fields ~3 correlated markets); reaching 4..7 legs REQUIRES combining
# one leg from that many DIFFERENT games — which is exactly what these buckets do.
WEEK_LEG_COUNTS = (2, 3, 4, 5, 6, 7)
WEEK_PER_COUNT = 3


def build_week_parlays_multi(game_preds, markets_by_game=None,
                             leg_counts=WEEK_LEG_COUNTS, per_count=WEEK_PER_COUNT):
    """Cross-game week parlays bucketed by LEG COUNT (2..7), a few per count.

    For each k in `leg_counts`, build up to `per_count` distinct k-leg parlays, each
    combining the favorite-moneyline leg from k DIFFERENT games (independent, rho=0).
    Games are ranked by model win probability (strongest favorites first); the
    candidate pool for each k is the top (k + per_count - 1) games so a few distinct
    combinations exist. Parlays are ranked by combined model probability desc (the
    most-likely-to-hit build first). Deterministic. A slate with fewer than k games
    simply yields no k-leg parlays (the client hides that leg count).
    """
    markets_by_game = markets_by_game or {}
    game_legs = []
    for gp in game_preds:
        gid = gp.get("game_id", "GAME")
        legs = derive_candidate_legs(gp, market=markets_by_game.get(gid))
        fav = legs[0]  # favorite moneyline by construction
        game_legs.append((str(gid), fav, float(fav["model_prob"])))
    # Rank games by favorite model prob desc; deterministic tie-break on game_id.
    game_legs.sort(key=lambda t: (-t[2], t[0]))

    out = []
    n = len(game_legs)
    for k in leg_counts:
        if n < k:
            continue  # not enough distinct games for a k-leg cross-game parlay
        pool = game_legs[: min(n, k + per_count - 1)]
        scored = []
        for combo in itertools.combinations(range(len(pool)), k):
            legs = [pool[i][1] for i in combo]
            model_p, implied_p = _combined_probs(legs, correlated=False)
            ev = (model_p / implied_p - 1.0) if implied_p > 0 else -1.0
            # Rank most-likely-to-hit first; EV + combo index are stable tie-breaks.
            scored.append((-model_p, -ev, combo, legs))
        scored.sort(key=lambda t: (t[0], t[1], t[2]))
        for rank, (_, _, _combo, legs) in enumerate(scored[:per_count]):
            out.append(_make_parlay("week-%dleg-%d" % (k, rank + 1), "week", legs))
    return out


def _report_unmodeled_markets(markets_by_game):
    """Print ONE stderr line per market we were handed and did not price.

    A missing model is skipped LOUDLY, never silently defaulted (house rule). The
    pipeline log therefore says out loud, every run, that N total lines arrived and
    produced no leg because no scoring model exists — so nobody re-discovers the gap by
    noticing an absence.
    """
    totals = sum(1 for m in (markets_by_game or {}).values() if (m or {}).get("total"))
    if totals:
        print(
            "parlay_builder: %d total (over/under) market(s) received and DROPPED — no "
            "scoring model exists, and a book price is not a model probability." % totals,
            file=sys.stderr,
        )
    unpriceable = sum(
        1 for m in (markets_by_game or {}).values()
        if (m or {}).get("spread") and (m or {})["spread"].get("home_point") is None
    )
    if unpriceable:
        print(
            "parlay_builder: %d spread market(s) carried no handicap (home_point) and "
            "produced no leg — nothing to price against." % unpriceable,
            file=sys.stderr,
        )


def build_parlays(game_preds, markets_by_game=None, props_by_game=None,
                  calibration_path=DEFAULT_CALIBRATION_PATH):
    """Build the full parlay list for a slate: >=3 per game AND >=3 for the week.

    game_preds      : list of records from game_model.predict_game.
    markets_by_game : optional {game_id: market dict} of real lines.
    props_by_game   : optional {game_id: [prop leg dicts]} of real prop candidates.
    calibration_path: data/parlay_backtest.json (correlations + spread note).

    Week parlays are bucketed by leg count (2..7) via build_week_parlays_multi so the
    UI can offer a leg-count selector. If a (tiny) slate cannot yield >=3 week parlays
    that way, fall back to the 2-leg week builder so the >=3/week invariant still holds.

    Returns a flat list of schema-valid parlays. Deterministic.
    """
    markets_by_game = markets_by_game or {}
    props_by_game = props_by_game or {}
    _report_unmodeled_markets(markets_by_game)
    if load_calibration(calibration_path) is None:
        print("parlay_builder: calibration file %s absent — correlations from the "
              "module fallback table (same measured numbers); prop legs seed-priced "
              "and stamped." % calibration_path, file=sys.stderr)

    parlays = []
    for gp in game_preds:
        gid = gp.get("game_id", "GAME")
        parlays.extend(build_game_parlays(
            gp,
            market=markets_by_game.get(gid),
            props=props_by_game.get(gid),
            calibration_path=calibration_path,
        ))
    week = build_week_parlays_multi(game_preds, markets_by_game=markets_by_game)
    if sum(1 for p in week if p.get("scope") == "week") < 3:
        week = build_week_parlays(game_preds, markets_by_game=markets_by_game)
    parlays.extend(week)
    return parlays


def build_parlays_document(game_preds, season, week, as_of_utc,
                           markets_by_game=None, props_by_game=None,
                           calibration_path=DEFAULT_CALIBRATION_PATH):
    """Wrap build_parlays in the parlays.json top-level shape.

    as_of_utc : caller-supplied fixed ISO-8601 timestamp (NO wall-clock here — the
                pipeline passes a deterministic value so outputs are reproducible).
    """
    return {
        "season": int(season),
        "week": int(week),
        "updated_utc": as_of_utc,
        "parlays": build_parlays(
            game_preds,
            markets_by_game=markets_by_game,
            props_by_game=props_by_game,
            calibration_path=calibration_path,
        ),
    }
