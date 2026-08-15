"""Parlay builder: >=3 parlays per game and >=3 per week, correlation-aware.

Each parlay matches data/contracts/parlays.schema.json:

    {parlay_id, scope, game_id?, legs, model_ev, confidence_tier, correlation_note}

where a leg is {market, selection, implied_prob, model_prob}.

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

Until R30 this was inverted for spread and total legs: `market["spread"]["home_cover_prob"]`
— The Odds API's de-vigged cover price — was passed as make_leg's third POSITIONAL
argument, which is `model_prob`. `implied_prob=None` was passed alongside, so make_leg
then FABRICATED the IMPL column back off it (mp * (1 + hold)). Both columns on the card
were the same book number, one with the hold added on; the MODEL EV badge, the
HIGH/MEDIUM/LOW tier and the combined probability were all functions of the book's price.
All 16 spread legs in the shipped data/parlays.json were affected — three of them
(TEN -3 0.4783, NYG +2.5 0.4892, MIN -1.5 0.4826) sat below 0.5, which the old seed
formula could not produce, which is how it was caught.

What replaced it, per market:

  * SPREAD — priced by OUR margin model at the BOOK'S HANDICAP (`model_cover_prob`
    below). The handicap is the terms of the bet, not a price: without a number there
    is no cover bet to price at all. No line -> no spread leg.
  * TOTAL — DROPPED. No scoring/total model exists anywhere in this repo (nothing
    projects game or team points), so there is no honest way to produce P(over). The
    book's `over_prob` is not available to borrow and a seed is not a model.
  * The old `0.5 + (p_fav - 0.5) * 0.7` cover seed was DELETED, not kept as a fallback.
    It was a placeholder wearing a model's clothes: a fixed shrink of the win
    probability toward 0.5 that ignores the handicap entirely (it returns the same
    number for -1.5 and -10.5) and was never fitted or backtested. Keeping it as a
    fallback would have restored exactly the failure this fix exists to remove — a
    number in the MODEL column that no model produced. A real margin model exists
    (game_model.prob_from_margin); when it cannot be applied the leg is dropped.

Deterministic, stdlib only, reads fixtures.
"""

import itertools
import math
import os
import sys
from statistics import NormalDist

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# `_MARGIN_SIGMA` is imported (private) on purpose: the margin<->probability mapping and
# the sigma that defines it must be ONE constant. A local copy here would let the spread
# leg drift away from the game model that produced the win probability it starts from.
from scripts.models.game_model import (  # noqa: E402
    _MARGIN_SIGMA, prob_from_margin,
)

# Standard two-way sportsbook hold applied to derive a placeholder implied probability
# when no real line is supplied. ~4.5% is a typical NFL two-way hold.
_DEFAULT_HOLD = 0.045

# Pairwise correlation priors for same-game legs, keyed on an unordered pair of market
# tags plus whether the two legs point the SAME game-script direction. These are
# transparent priors (not fitted): the point is to STOP treating correlated legs as
# independent, and to get the sign right.
#   Positive: outcomes that tend to co-occur (favorite wins & game goes over when the
#             favorite is a high-scoring team; QB passing & his WR receiving).
#   Negative: outcomes that fight each other (favorite blowout & the game staying under
#             is possible, but a favorite ML & the underdog covering the spread oppose).
_SAME_GAME_DEFAULT_RHO = 0.20
_CORR_RULES = {
    frozenset(("qb_pass_yds", "wr_rec_yds")): 0.45,   # passer & his receiver
    frozenset(("qb_pass_yds", "team_total")): 0.35,
    frozenset(("moneyline", "spread")): 0.55,          # same-team ML & cover move together
    frozenset(("moneyline", "total")): 0.15,
    frozenset(("spread", "total")): 0.15,
    frozenset(("rb_rush_yds", "moneyline")): 0.25,     # lead back & his team winning
}

# Confidence-tier thresholds on combined edge (model_prob - implied_prob of the parlay).
_TIER_HIGH_EDGE = 0.12
_TIER_MED_EDGE = 0.04


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


# ---------------------------------------------------------------------------
# OUR spread-cover model (no market probability anywhere in it).
# ---------------------------------------------------------------------------
def model_home_margin(p_home):
    """OUR model's expected home margin, in points, from OUR home win probability.

    game_model maps a predicted margin to a win probability with the normal CDF of
    (margin / sigma), sigma = 13.5 points (the long-run NFL final-margin spread). This
    is that map run backwards: the margin whose normal CDF is our win probability. It
    introduces no new information and no market information — it re-expresses the Elo/
    composite blend in the units a handicap is quoted in, which is the only way to ask
    "does this side cover THIS number" of a model that emits a win probability.
    """
    p = _clamp(float(p_home), 1e-4, 1.0 - 1e-4)
    return NormalDist().inv_cdf(p) * _MARGIN_SIGMA


def model_cover_prob(p_home, home_point):
    """P(the HOME team covers `home_point`) under OUR margin model.

    home_point is the home side's handicap as the book quotes it: -3.5 means the home
    team lays 3.5, +2.5 means it receives 2.5. The home side covers when
    (final margin + home_point) > 0, so with margin ~ Normal(model margin, sigma) the
    cover probability is the same normal CDF game_model already uses, shifted by the
    handicap.

    Only the NUMBER comes from the book; the distribution is entirely ours. Pushes get
    zero mass (the margin model is continuous), which slightly overstates both sides on
    an integer line such as -3 — a known, documented approximation, not a hidden one.
    """
    margin = model_home_margin(p_home)
    return prob_from_margin(margin + float(home_point))["home"]


# ---------------------------------------------------------------------------
# Legs.
# ---------------------------------------------------------------------------
def make_leg(market, selection, model_prob, implied_prob=None, hold=_DEFAULT_HOLD,
             corr_tag=None, side=None):
    """Build a parlay leg.

    market      : market type, e.g. 'moneyline', 'spread', 'total', 'qb_pass_yds'.
    selection   : the specific pick, e.g. 'KC ML', 'KC -3.5', 'Over 47.5'.
    model_prob  : our probability (0..1).
    implied_prob: real book-implied probability if known; else derived from model_prob
                  plus `hold` (a placeholder line — see module docstring on honesty).
    corr_tag    : correlation tag used by the correlation rules (defaults to `market`).
    side        : 'home'/'away'/'over'/'under' — used to detect same/opposing direction.
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
    """Return a schema-clean copy of a leg (internal underscore fields removed)."""
    return {
        "market": leg["market"],
        "selection": leg["selection"],
        "implied_prob": leg["implied_prob"],
        "model_prob": leg["model_prob"],
    }


def _pair_rho(a, b):
    """Correlation prior for a pair of same-game legs.

    Uses the rule table on the two legs' correlation tags; falls back to the same-game
    default. If the two legs point in OPPOSING directions (e.g. a home leg and an away
    leg in the same game), the correlation flips sign — betting both sides of the same
    script are negatively related.
    """
    key = frozenset((a.get("_corr_tag"), b.get("_corr_tag")))
    rho = _CORR_RULES.get(key, _SAME_GAME_DEFAULT_RHO)
    sa, sb = a.get("_side"), b.get("_side")
    if sa and sb:
        opposing = {sa, sb} in ({"home", "away"}, {"over", "under"})
        if opposing:
            rho = -abs(rho)
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


def _combined_probs(legs, correlated):
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
        rho = _pair_rho(legs[i - 1], legs[i])
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


def _make_parlay(parlay_id, scope, legs, game_id=None):
    """Assemble a schema-valid parlay dict with EV, tier, and correlation note."""
    correlated = scope == "game"
    model_p, implied_p = _combined_probs(legs, correlated)

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
def derive_candidate_legs(game_pred, market=None, props=None):
    """Build a deterministic set of same-game candidate legs for one game.

    game_pred : a record from game_model.predict_game (has probs, home, away, game_id).
    market    : optional real lines (scrape/odds_api.fetch_markets shape), any of:
                  {"moneyline": {"home_prob":..,"away_prob":..},
                   "spread": {"home_cover_prob":..,"away_cover_prob":..,
                              "home_point":..,"home_selection":..,"away_selection":..},
                   "total":  {"over_prob":..,"line":..}}
                Every probability in here is a BOOK price: it may only ever reach
                `implied_prob` (the display-only IMPL column). `home_point` is the
                handicap — the terms of the bet — and OUR model prices it.
    props     : optional list of real prop legs already in make_leg shape (dicts with
                market/selection/model_prob and optionally implied_prob/_corr_tag/_side).

    Leg count is NOT fixed: a leg exists only where we have a model for it. Always at
    least the favorite moneyline; the spread leg needs a real handicap to price; the
    total leg is not emitted at all (no scoring model — see the module docstring).
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

    # 2) Spread cover on the side OUR model favors, priced by OUR margin model at the
    #    book's handicap.
    #
    #    THE SIDE IS CHOSEN ONCE (fav_side, above) and the label, the probability and
    #    the correlation side are all read off that one choice. Previously the label
    #    came unconditionally from the home team while the probability came from
    #    whichever side the model favored, so an away favorite produced a card that
    #    named one team and priced the other (wrong on 3 of 16 shipped games) and a
    #    `_side` that flipped the sign of the pair correlation as well.
    #
    #    No handicap -> NO LEG. The book's cover price is not a substitute for a model
    #    and neither is a seed; a cover bet without a number is not a bet.
    spread = (market or {}).get("spread") or {}
    home_point = spread.get("home_point")
    sel = spread.get("%s_selection" % fav_side)
    if home_point is not None and sel:
        p_cover_home = model_cover_prob(p_home, home_point)
        p_cover = p_cover_home if fav_is_home else 1.0 - p_cover_home
        # DISPLAY ONLY: the book's de-vigged cover probability for the SAME side, which
        # is what the IMPL column is supposed to show. It never touches model_prob.
        book_cover = (spread.get("home_cover_prob") if fav_is_home
                      else spread.get("away_cover_prob"))
        legs.append(make_leg("spread", sel, p_cover, implied_prob=book_cover,
                             corr_tag="spread", side=fav_side))

    # 3) Game total OVER — NOT EMITTED. There is no scoring/total model in this repo:
    #    nothing projects game or team points, so we cannot produce P(over) ourselves.
    #    The two numbers within reach were the book's `over_prob` (a market price — the
    #    exact thing that must never be a model input) and a flat 0.5 seed (not a
    #    model). Dropping the leg is the honest outcome and the owner's instruction.
    #    Emitting it again requires a real scoring model, not a fallback; the gate check
    #    validate_data.check_parlay_model_independence() reds if a total leg reappears.

    # 4+) Real prop legs (e.g. QB pass yards + his WR receiving yards) appended as-is.
    for prop in (props or []):
        legs.append(make_leg(
            prop["market"], prop["selection"], prop["model_prob"],
            implied_prob=prop.get("implied_prob"),
            corr_tag=prop.get("_corr_tag", prop["market"]),
            side=prop.get("_side"),
        ))

    return legs


# ---------------------------------------------------------------------------
# Player-prop leg derivation (feeds the props= path of build_game_parlays).
# ---------------------------------------------------------------------------
# Seed prop lines per position: (market/corr tag, yardage line, selection label).
# The lines are DOCUMENTED SEEDS, not book lines: round league-typical thresholds
# (a mid-tier starter's over/under) so a 0.5-ish model prob is honest. When a real
# prop feed lands, its line/implied_prob replaces these seeds via make_leg.
_PROP_SEEDS = {
    "QB": ("qb_pass_yds", 224.5, "pass yds"),
    "RB": ("rb_rush_yds", 59.5, "rush yds"),
    "WR": ("wr_rec_yds", 59.5, "rec yds"),
}

# Prop model_prob seed: start at the fair-line 0.5 and shade by the player's TEAM win
# probability (volume follows game script: winning teams sustain drives), clamped so a
# seeded prop never claims strong conviction either way:
#   model_prob = clamp(0.5 + _PROP_WIN_SHADE * (p_team_win - 0.5), 0.35, 0.65)
_PROP_WIN_SHADE = 0.4
_PROP_CLAMP_LO = 0.35
_PROP_CLAMP_HI = 0.65


def _abbrev_player(name):
    """'Patrick Mahomes' -> 'P. Mahomes' for compact selection strings."""
    tokens = str(name).split()
    if len(tokens) < 2:
        return str(name)
    return "%s. %s" % (tokens[0][0], " ".join(tokens[1:]))


def build_props_by_game(game_preds, player_weekly_doc, player_projections_doc):
    """Derive seeded player-prop legs per game: top QB, top RB, top WR on the slate.

    game_preds             : list of game_model.predict_game records (game_id, home,
                             away, probs).
    player_weekly_doc      : data/player_weekly.json shape ({"players": [{gsis_id,..}]}).
                             Used as a roster sanity filter: only players with weekly
                             data are eligible (a projection with no weekly record is
                             stale or unrostered — skip, never guess).
    player_projections_doc : data/player_projections.json shape ({"players": [
                             {gsis_id, name, team, position, proj_points, ...}]}).

    For each game, picks the top-projected QB (market qb_pass_yds), RB (rb_rush_yds),
    and WR (wr_rec_yds) among the two teams' players by proj_points desc, ties broken
    by gsis_id asc (deterministic). Each leg is a dict the props= path of
    build_game_parlays consumes: {market, selection, model_prob, _corr_tag, _side}
    plus provenance fields (gsis_id, line, estimate). model_prob is the documented
    seed above — no implied_prob is attached, so make_leg charges the standard hold
    (no fabricated positive edge). Returns {game_id: [prop leg dicts]}.
    """
    weekly_ids = set()
    for rec in (player_weekly_doc or {}).get("players", []) or []:
        if rec.get("gsis_id"):
            weekly_ids.add(rec["gsis_id"])
    players = (player_projections_doc or {}).get("players", []) or []

    out = {}
    for gp in game_preds:
        gid = str(gp.get("game_id", "GAME"))
        home, away = gp.get("home", "HOME"), gp.get("away", "AWAY")
        p_home = float(gp.get("probs", {}).get("home", 0.5))

        legs = []
        for pos in ("QB", "RB", "WR"):
            market, line, label = _PROP_SEEDS[pos]
            cands = [
                p for p in players
                if p.get("position") == pos
                and p.get("team") in (home, away)
                and p.get("gsis_id") in weekly_ids
            ]
            # Stable rank: proj_points desc, tie by gsis_id asc (deterministic).
            cands.sort(key=lambda p: (-float(p.get("proj_points", 0.0)),
                                      str(p.get("gsis_id"))))
            if not cands:
                continue  # no eligible player at this position; honest omission
            top = cands[0]
            side = "home" if top.get("team") == home else "away"
            p_team = p_home if side == "home" else 1.0 - p_home
            model_prob = _clamp(
                0.5 + _PROP_WIN_SHADE * (p_team - 0.5),
                _PROP_CLAMP_LO, _PROP_CLAMP_HI,
            )
            legs.append({
                "market": market,
                "selection": "%s %d+ %s" % (
                    _abbrev_player(top.get("name", "?")),
                    int(math.ceil(line)), label,
                ),
                "model_prob": round(model_prob, 4),
                "_corr_tag": market,
                "_side": side,
                # Provenance (ignored by make_leg; kept for audit/debug honesty).
                "gsis_id": top.get("gsis_id"),
                "line": line,
                "estimate": True,
            })
        out[gid] = legs
    return out


def build_game_parlays(game_pred, market=None, props=None):
    """Build >=3 correlation-aware parlays for a single game.

    Uses distinct 2-leg combinations of the candidate legs, favoring pairs with the
    strongest (signed) correlation first so the flagship same-game parlays are the most
    correlation-sensitive ones. Deterministic (stable ordering).
    """
    game_id = game_pred.get("game_id", "GAME")
    legs = derive_candidate_legs(game_pred, market=market, props=props)

    # Enumerate all unordered 2-leg combinations, rank by |rho| desc (most correlated
    # first) then by combined EV desc, both deterministic tie-breaks by index.
    combos = []
    for i in range(len(legs)):
        for j in range(i + 1, len(legs)):
            pair = [legs[i], legs[j]]
            rho = _pair_rho(legs[i], legs[j])
            model_p, implied_p = _combined_probs(pair, correlated=True)
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
        parlays.append(_make_parlay(pid, "game", pair, game_id=game_id))

    # If fewer than 3 combos existed, top up with single-leg parlays so the >=3 invariant
    # still holds. (Only reached when a game has fewer than 3 candidate legs.)
    idx = len(parlays)
    while len(parlays) < 3 and legs:
        pid = "%s-g%d" % (game_id, idx + 1)
        parlays.append(_make_parlay(pid, "game", [legs[idx % len(legs)]], game_id=game_id))
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


def build_parlays(game_preds, markets_by_game=None, props_by_game=None):
    """Build the full parlay list for a slate: >=3 per game AND >=3 for the week.

    game_preds      : list of records from game_model.predict_game.
    markets_by_game : optional {game_id: market dict} of real lines.
    props_by_game   : optional {game_id: [prop leg dicts]} of real prop candidates.

    Week parlays are bucketed by leg count (2..7) via build_week_parlays_multi so the
    UI can offer a leg-count selector. If a (tiny) slate cannot yield >=3 week parlays
    that way, fall back to the 2-leg week builder so the >=3/week invariant still holds.

    Returns a flat list of schema-valid parlays. Deterministic.
    """
    markets_by_game = markets_by_game or {}
    props_by_game = props_by_game or {}
    _report_unmodeled_markets(markets_by_game)

    parlays = []
    for gp in game_preds:
        gid = gp.get("game_id", "GAME")
        parlays.extend(build_game_parlays(
            gp,
            market=markets_by_game.get(gid),
            props=props_by_game.get(gid),
        ))
    week = build_week_parlays_multi(game_preds, markets_by_game=markets_by_game)
    if sum(1 for p in week if p.get("scope") == "week") < 3:
        week = build_week_parlays(game_preds, markets_by_game=markets_by_game)
    parlays.extend(week)
    return parlays


def build_parlays_document(game_preds, season, week, as_of_utc,
                           markets_by_game=None, props_by_game=None):
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
        ),
    }
