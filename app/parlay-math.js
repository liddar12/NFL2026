/* app/parlay-math.js — the parlay combination maths, ported from Python.
 *
 * MY PARLAYS builds cards in the browser: the user types a player or a team and
 * the view searches the candidate leg pool for the best ten cards containing
 * them. Those combinations cannot be precomputed (any subset of ~245 players is
 * a valid seed), so the arithmetic that scripts/models/parlay_builder.py performs
 * on the runner has to exist here too.
 *
 * This module FETCHES NOTHING and names no contract: it is pure arithmetic over
 * legs the caller hands it. tests/feature/data_contract.test.mjs keeps pipeline
 * artifacts out of the client by refusing to let an app source so much as name
 * one, and it was right to catch an earlier draft of this comment doing so — the
 * view that does the loading is what earns the allowlist entry, not the maths.
 *
 * A SECOND IMPLEMENTATION OF A MODEL IS A LIABILITY unless something forces the
 * two to agree. tests/feature/r76_parlay_math_parity.test.mjs runs both over the
 * same randomised leg sets and fails on any disagreement beyond floating-point
 * noise, so a change to the Python that is not mirrored here turns the gate red
 * rather than quietly producing two different numbers for the same card.
 *
 * WHAT IS PORTED, and the reasoning behind each piece (the long form lives in the
 * Python module's docstring; this is the contract):
 *
 *   combineTwo      Gaussian-copula-lite. joint = p*q + rho*sqrt(p(1-p)q(1-q)),
 *                   clamped to the Frechet bound min(p, q). At rho = 0 it is the
 *                   independence product.
 *   combinedProbs   The MODEL side folds legs in one at a time with the pairwise
 *                   rho of each incoming leg against the previous one. The IMPLIED
 *                   side is ALWAYS the independence product, because that is how
 *                   books price a parlay — the gap between the two is the entire
 *                   reason a correlated card is interesting.
 *   pairRho         Measured rho by correlation tag. Opposing sides of one game
 *                   use their own measurement when one exists, otherwise the
 *                   same-side rho with its sign flipped: betting both sides of a
 *                   single script is negatively related.
 *   sameSideGamePair R74. A moneyline and that same team's spread are one opinion,
 *                   not two legs; winning outright guarantees the cover on any
 *                   non-negative handicap. The view must refuse the pair exactly
 *                   as the builder does.
 *   confidenceTier  The ordinal tier, demoted as legs compound.
 *   impliedFromModel No book price -> charge the vig. A prop leg has no book feed,
 *                   so it can never claim a positive single-leg edge.
 *
 * MARKET POLICY: an implied probability is display and the terms of the bet. No
 * function here lets one reach a model probability.
 */

/** The builder's constants, restated so a drift shows up as a parity failure. */
export const DEFAULT_HOLD = 0.045;
export const SAME_GAME_DEFAULT_RHO = 0.10;
export const TIER_HIGH_EDGE = 0.12;
export const TIER_MED_EDGE = 0.04;
const RHO_CLAMP = 0.95;
const PROB_EPS = 1e-4;
/** Markets that are bets on the SAME EVENT: which team wins, and by how much. */
const GAME_OUTCOME_MARKETS = new Set(['moneyline', 'spread']);

function clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

/** Order-independent key for a leg pair, standing in for Python's frozenset. */
function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

/**
 * (same, opposing, default) from a calibration document's correlations block.
 * An absent or empty block yields the module default rho for every pair — the
 * same fallback the Python takes, so an unbuilt calibration degrades identically
 * on both sides rather than diverging.
 */
export function correlationTable(calib) {
  const block = (calib && calib.correlations) || null;
  const pairs = (block && Array.isArray(block.pairs)) ? block.pairs : [];
  const same = new Map();
  const opposing = new Map();
  for (const p of pairs) {
    if (!p || typeof p.rho !== 'number') continue;
    const parts = String(p.key || '').split('|');
    if (parts.length === 2) same.set(pairKey(parts[0], parts[1]), p.rho);
    else if (parts.length === 3 && parts[2] === 'opposing') {
      opposing.set(pairKey(parts[0], parts[1]), p.rho);
    }
  }
  const dflt = block && typeof block.default_rho === 'number'
    ? block.default_rho : SAME_GAME_DEFAULT_RHO;
  return { same, opposing, default: dflt };
}

/** Measured correlation for a pair of same-game legs. */
export function pairRho(a, b, table) {
  const t = table || correlationTable(null);
  const key = pairKey(a.corr_tag || a.market, b.corr_tag || b.market);
  let rho = t.same.has(key) ? t.same.get(key) : t.default;
  const sa = a.side;
  const sb = b.side;
  if (sa && sb && sa !== sb && (sa === 'home' || sa === 'away')
      && (sb === 'home' || sb === 'away')) {
    rho = t.opposing.has(key) ? t.opposing.get(key) : -Math.abs(rho);
  }
  return clamp(rho, -RHO_CLAMP, RHO_CLAMP);
}

/** Fold one more leg into a running joint probability under correlation `rho`. */
export function combineTwo(pJoint, pNext, rho) {
  const indep = pJoint * pNext;
  const adjust = rho * Math.sqrt(pJoint * (1 - pJoint) * pNext * (1 - pNext));
  return clamp(indep + adjust, 0, Math.min(pJoint, pNext));
}

/**
 * [combinedModelProb, combinedImpliedProb].
 *
 * `correlated` is true for a same-game card and false for a cross-game one,
 * matching the builder: cross-game legs are combined as independent because that
 * is what the measurement supports, not because it is convenient.
 */
export function combinedProbs(legs, correlated, table) {
  if (!legs || legs.length === 0) return [0, 0];
  let implied = 1;
  for (const leg of legs) implied *= leg.implied_prob;

  if (!correlated || legs.length === 1) {
    let model = 1;
    for (const leg of legs) model *= leg.model_prob;
    return [model, implied];
  }
  let model = legs[0].model_prob;
  for (let i = 1; i < legs.length; i += 1) {
    model = combineTwo(model, legs[i].model_prob, pairRho(legs[i - 1], legs[i], table));
  }
  return [model, implied];
}

/** R74 — two bets on the SAME TEAM'S OUTCOME in one game are one opinion. */
export function sameSideGamePair(a, b) {
  if (!GAME_OUTCOME_MARKETS.has(a.market) || !GAME_OUTCOME_MARKETS.has(b.market)) {
    return false;
  }
  return Boolean(a.side) && a.side === b.side;
}

/** True when any pair in `legs` violates the one-leg-per-game-side rule. */
export function violatesOnePerSide(legs) {
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      if (legs[i].game_id && legs[i].game_id === legs[j].game_id
          && sameSideGamePair(legs[i], legs[j])) return true;
    }
  }
  return false;
}

/** The ordinal confidence tier, demoted as legs compound. */
export function confidenceTier(modelProb, impliedProb, nLegs) {
  const eff = (modelProb - impliedProb) - 0.01 * Math.max(0, nLegs - 2);
  if (eff >= TIER_HIGH_EDGE) return 'high';
  if (eff >= TIER_MED_EDGE) return 'medium';
  return 'low';
}

/**
 * The implied probability for a leg with no book price: our number plus the
 * standard hold. A prop leg has no book feed, so this is the honest ceiling —
 * it can never produce a positive single-leg edge out of nothing.
 */
export function impliedFromModel(modelProb, hold = DEFAULT_HOLD) {
  return clamp(clamp(modelProb, PROB_EPS, 1 - PROB_EPS) * (1 + hold),
    PROB_EPS, 1 - PROB_EPS);
}

/** A pool row -> a leg the maths above accepts. `rung` is one of its lines. */
export function legFromPool(row, rung) {
  const model = clamp(rung.model_prob, PROB_EPS, 1 - PROB_EPS);
  return {
    market: row.market,
    selection: rung.selection,
    model_prob: model,
    implied_prob: impliedFromModel(model),
    corr_tag: row.market,
    side: row.side,
    game_id: row.game_id,
    player: row.player,
    team: row.team,
    line: rung.line,
    priced: false,          // no book feed for props — the vig is charged above
  };
}

/** A copied game leg -> the same shape. Its implied_prob is a REAL book price. */
export function legFromGame(leg) {
  return {
    market: leg.market,
    selection: leg.selection,
    model_prob: leg.model_prob,
    implied_prob: typeof leg.implied_prob === 'number'
      ? leg.implied_prob : impliedFromModel(leg.model_prob),
    corr_tag: leg.market,
    side: leg.side || null,
    game_id: leg.game_id,
    team: leg.team,
    priced: typeof leg.implied_prob === 'number',
  };
}

/** Model EV: combined model probability against the combined price. */
export function modelEv(modelProb, impliedProb) {
  return impliedProb > 0 ? (modelProb / impliedProb) - 1 : 0;
}
