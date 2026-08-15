/* app/draft-sim.js — THE DRAFT SIMULATOR (pure).
 *
 * Snake-draft engine for the TEAM tab. Every function is PURE and DETERMINISTIC
 * given a seed: no DOM, no fetch, no Date, no Math.random — node unit tests
 * (tests/feature/draft_sim.test.mjs) drive it directly.
 *
 * THE BENCHMARK DESIGN (user-approved): the default room drafts by ADP —
 * the market of real fantasy drafters — with documented per-round noise,
 * positional-need awareness, and run behavior. Our picks come from the VOR
 * fit engine. Beating that room, measured as our starters' projected points
 * minus the room average, IS the beat-ADP score. The opt-in "shark" room
 * (every opponent uses our VOR engine) is a stress test, kept out of the
 * market comparison so the ADP benchmark stays clean.
 *
 * WHAT A FINISHED ROOM TEACHES: nothing in this file. A completed room is
 * stored as DRAFT HISTORY by app/mocks.js — a point-in-time record, read back
 * for comparison, never fed back into these coefficients. The fit-engine
 * coefficients are the documented priors and no room refits them. SIM rooms
 * teach nothing at all: their opponents are this module's own sampler, so
 * grading them would only measure this file against itself. Only LIVE rooms —
 * where the manager taps what real opponents actually did — produce
 * opponent-model calibration, and that output is a PICK NUMBER (where this
 * room takes a given consensus ADP), never a coefficient, never a projection,
 * never a weight.
 *
 * ADP POLICY BOUNDARY: ADP models OPPONENTS and value flags only. It never
 * touches our projections — a player without a projection (gsis_id null) can
 * be drafted BY OPPONENTS but is never recommended to us and scores 0 toward
 * roster totals (never fabricated points).
 *
 * THE THIRD ROOM (R23-E1): 'aiplus' drafts to the SAVED LeagueProfile. ADP
 * drafts the consensus board and SHARK greedily takes the most adjusted points;
 * neither knows anything about the manager's league, so neither ever teaches a
 * superflex or TE-premium manager when players actually go in THEIR room. The
 * AI+ opponent values players under the league's own scoring table and derives
 * its needs and scarcity from the league's own shape (roster slots, flex
 * eligibility, position caps, team count) through the same team-logic geometry
 * the reco panel and the auction use. 'adp' and 'shark' are untouched.
 */

import {
  scoringAdjust, rosterGeometry, positionDemand, replacementIndex,
} from './team-logic.js';
import { normalizeProfile } from './league.js';

/* --------------------------------------------------------------------------
 * Roster configuration (Rel6: slot counts are configurable within sane bounds)
 * ------------------------------------------------------------------------ */

/** Bounds per configurable slot type. Defaults reproduce the classic shape. */
export const ROSTER_BOUNDS = Object.freeze({
  qb: [1, 2], rb: [2, 3], wr: [2, 3], te: [1, 2], flex: [0, 2], bench: [4, 8],
  // R27 — K and DEF become DRAFTABLE. They were absent from the sim shape
  // entirely ("its shape knows no K/DEF"), so a league whose roster carries a
  // K1 and a DEF1 could seat them on the Team page and find them in the finder
  // but could not draft them in the room: the board had no kickers on it. Both
  // default to ZERO, so any shape that does not ask for them is byte-for-byte
  // the pre-R27 shape and no existing sim, score or test moves.
  k: [0, 1], def: [0, 1],
});
export const DEFAULT_ROSTER = Object.freeze({
  qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6, k: 0, def: 0,
});

const _clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

/**
 * Normalize a roster config to bounds and derive the slot lists.
 * Returns { config, starters: ['QB1','RB1',...], bench: ['BN1',...],
 *           starterDemand: {QB,RB,WR,TE}, size }.
 */
export function rosterShape(config) {
  const c = { ...DEFAULT_ROSTER, ...(config || {}) };
  for (const [k, [lo, hi]] of Object.entries(ROSTER_BOUNDS)) {
    c[k] = _clampInt(c[k], lo, hi);
  }
  const starters = [];
  const push = (pos, n) => {
    for (let i = 1; i <= n; i += 1) starters.push(`${pos}${i}`);
  };
  push('QB', c.qb); push('RB', c.rb); push('WR', c.wr); push('TE', c.te);
  for (let i = 1; i <= c.flex; i += 1) starters.push(c.flex === 1 ? 'FLEX' : `FLEX${i}`);
  // R27 — K and DEF sit AFTER the flex, which is both how every roster page in
  // this app orders them and the order they are actually drafted in. Zero
  // counts push nothing, so the classic shape is unchanged.
  push('K', c.k); push('DEF', c.def);
  const bench = [];
  for (let i = 1; i <= c.bench; i += 1) bench.push(`BN${i}`);
  const starterDemand = { QB: c.qb, RB: c.rb, WR: c.wr, TE: c.te };
  // Only ANNOUNCE a K/DEF demand when the league actually seats one. Writing
  // K: 0 would put the keys into every shape in the app and change what
  // positionDemand()/replacementLevel() iterate over for leagues that have no
  // kicker at all.
  if (c.k > 0) starterDemand.K = c.k;
  if (c.def > 0) starterDemand.DEF = c.def;
  return {
    config: c,
    starters,
    bench,
    starterDemand,
    size: starters.length + bench.length,
  };
}

/* --------------------------------------------------------------------------
 * Deterministic PRNG (mulberry32) — seeded, reproducible sims
 * ------------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approx standard normal via sum of uniforms (Irwin-Hall 6 — plenty here). */
function gauss(rng) {
  let s = 0;
  for (let i = 0; i < 6; i += 1) s += rng();
  return (s - 3) / Math.sqrt(0.5);
}

/* --------------------------------------------------------------------------
 * Snake order
 * ------------------------------------------------------------------------ */

/** Team index (0-based) on the clock for overall pick `p` (0-based). */
export function snakeTeam(p, leagueSize) {
  const round = Math.floor(p / leagueSize);
  const idx = p % leagueSize;
  return round % 2 === 0 ? idx : leagueSize - 1 - idx;
}

/** All 0-based overall pick numbers belonging to `slot` (1-based). */
export function myPickNumbers(slot, leagueSize, rounds) {
  const out = [];
  for (let p = 0; p < leagueSize * rounds; p += 1) {
    if (snakeTeam(p, leagueSize) === slot - 1) out.push(p);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Opponent pick models
 * ------------------------------------------------------------------------ */

// ADP room noise: how far (in board positions) a manager reaches, by round.
// Early rounds are chalk (sigma ~2 board spots); late rounds are chaos. This
// is the DOCUMENTED market-behavior prior the benchmark is measured against.
export const ADP_NOISE_BASE = 2.0;
export const ADP_NOISE_PER_ROUND = 1.25;

/** Does `pos` still fill a need for this opponent roster (counts by position)?
 * Opponents respect starter demand + one backup each at RB/WR, plus the same
 * hard caps we use — and BOTH now come from the shape, so a 2-QB room drafts a
 * third QB (the frozen {QB:2} cap used to forbid it for every opponent). Pure. */
export function opponentNeeds(counts, pos, shape) {
  const geo = rosterGeometry(shape);
  const cap = geo.caps[pos] != null ? geo.caps[pos] : Infinity;
  const have = counts[pos] || 0;
  if (have >= cap) return false;
  const demand = geo.demand[pos] || 0;
  // "Flexible" = some flex slot on THIS roster accepts the position (a
  // SUPER_FLEX makes QB flexible; the classic FLEX does not).
  const flexible = geo.flexSlots.some((f) => f.positions.includes(pos));
  // Starter demand + FLEX share + one backup everywhere (real rooms draft a
  // backup QB late; the hard cap above still stops the over-cap one).
  const want = demand + (flexible ? geo.flexSlots.length + 1 : 1);
  return have < want;
}

/**
 * One ADP-room opponent pick: sample a target board position near the top of
 * the remaining ADP board (|gauss| keeps it top-biased), skip players whose
 * position the manager no longer needs. `board` is ADP-sorted remaining rows.
 * Returns the chosen index into `board`.
 */
export function adpOpponentPick(board, counts, shape, round, rng) {
  const sigma = ADP_NOISE_BASE + ADP_NOISE_PER_ROUND * round;
  const target = Math.min(board.length - 1, Math.floor(Math.abs(gauss(rng)) * sigma));
  for (let step = 0; step < board.length; step += 1) {
    const i = (target + step) % board.length;
    if (opponentNeeds(counts, board[i].position, shape)) return i;
  }
  return 0; // every position saturated (deep bench tail) — take the board top
}

/** Shark-room pick: best adjusted points among needed positions (our-model
 * greedy; the stress-test room). */
export function sharkOpponentPick(board, counts, shape, adjOf) {
  let best = -1;
  let bestPts = -Infinity;
  for (let i = 0; i < board.length; i += 1) {
    if (!opponentNeeds(counts, board[i].position, shape)) continue;
    const pts = adjOf(board[i]);
    if (pts > bestPts) { best = i; bestPts = pts; }
  }
  return best >= 0 ? best : 0;
}

/* --------------------------------------------------------------------------
 * AI+ ROOM (R23-E1) — the opponent that drafts to YOUR league profile
 * ------------------------------------------------------------------------ */

/** The room tokens createDraft understands, in menu order. */
export const ROOM_TYPES = Object.freeze(['adp', 'shark', 'aiplus']);

/** Display labels for the rooms (the view may show its own copy). */
export const ROOM_LABELS = Object.freeze({ adp: 'ADP', shark: 'SHARK', aiplus: 'AI+' });

/**
 * Canonical room token. 'adp' and 'shark' pass through UNCHANGED, and so does
 * anything unrecognised (an unknown token has always fallen through to the ADP
 * model, and still does). Only the AI+ spellings collapse to 'aiplus'.
 */
export function normalizeRoomType(roomType) {
  const t = String(roomType == null ? '' : roomType).trim().toLowerCase();
  if (t === 'aiplus' || t === 'ai+' || t === 'ai' || t === 'ai-plus') return 'aiplus';
  return roomType;
}

/** Fit points added to a candidate that still fills an UNFILLED STARTER seat on
 * this opponent's roster. A DOCUMENTED PRIOR (the STACK_BONUS magnitude in
 * app/team-logic.js), not a measurement: roughly the value gap of one round,
 * enough to make a needed starter beat a marginally better bench body. */
export const AI_STARTER_NEED_BONUS = 12;

/** Candidate-set width: how many of the top-scoring players the AI+ manager
 * will actually consider, widening as the draft goes on. */
export const AI_TOP_K_BASE = 3;
export const AI_TOP_K_PER_ROUND = 0.5;

/** Weight decay across that candidate set (w_i = AI_PICK_DECAY^i). */
export const AI_PICK_DECAY = 0.45;

/**
 * LEAGUE-SCORED season points for one board row — the AI+ room's valuation.
 *
 * HONESTY, EXACTLY: only two scoring keys can be fed here, because they are the
 * only ones this app has a projected stat to multiply.
 *   rec           `proj_points` is a FULL-PPR season total and player_weekly
 *                 carries prior-season receptions, so
 *                 ppr + (rec - 1) x receptions is the same EXACT conversion
 *                 scoringAdjust() already performs for half/std, generalised to
 *                 whatever per-reception value the league actually sets.
 *   bonus_rec_te  Sleeper's TE premium, a bonus PER TE RECEPTION (carried
 *                 through by the Sleeper import as an unknown-but-kept key).
 *                 Same arithmetic, TEs only.
 * EVERY OTHER KEY IS LEFT ALONE. There is no per-stat projection to multiply
 * and inventing one would be fabrication — validateProfile() already warns
 * exactly that about keys nothing feeds.
 *
 * When the ingredients are missing (no PPR total for the player, or a table
 * that needs a reception count we do not have) the ROOM'S OWN adjusted points
 * stand in. That is a real number the caller computed, never a guess.
 */
export function leagueSeasonPoints(row, profile, adjOf, pprPointsById, receptionsById) {
  const fallback = () => (typeof adjOf === 'function' ? adjOf(row) : 0);
  const id = row && row.gsis_id != null ? String(row.gsis_id) : null;
  if (id == null || !pprPointsById || !pprPointsById.has(id)) return fallback();
  const ppr = Number(pprPointsById.get(id));
  if (!Number.isFinite(ppr)) return fallback();
  const scoring = (profile && profile.scoring) || {};
  const perRec = Number.isFinite(scoring.rec) ? scoring.rec : 0;
  const pos = String((row && row.position) || '').toUpperCase();
  const teBonus = pos === 'TE' && Number.isFinite(scoring.bonus_rec_te)
    ? scoring.bonus_rec_te : 0;
  if (perRec === 1 && teBonus === 0) return Math.round(ppr * 100) / 100;
  // The table differs from full PPR, so a reception count is REQUIRED to
  // convert. Without one there is no honest number — use the room's.
  if (!receptionsById || !receptionsById.has(id)) return fallback();
  const rec = Number(receptionsById.get(id));
  if (!Number.isFinite(rec)) return fallback();
  return Math.round((ppr + (perRec - 1) * rec + teBonus * rec) * 100) / 100;
}

/**
 * Everything the AI+ opponent reads, built once per draft.
 *   profile     the SAVED LeagueProfile, normalised (null -> DEFAULT_PROFILE,
 *               so an unconfigured manager still gets a working AI+ room)
 *   geo         rosterGeometry(profile) — slots, flex eligibility, caps
 *   demand      positionDemand(profile) — fixed slots + each flex slot's share
 *   leagueSize  the ROOM's team count (real scarcity is the room you are in)
 *   valueOf     row -> league-scored season points (leagueSeasonPoints)
 *   replacement per-position replacement level, fixed ONCE off the FULL board
 *               (see aiReplacementLevels). Pass `board` to pin it up front;
 *               otherwise the first pick pins it off whatever board it sees.
 */
export function aiPlusContext({ profile = null, adjOf = null, pprPointsById = null,
                                receptionsById = null, leagueSize = null,
                                board = null } = {}) {
  const p = normalizeProfile(profile);
  const geo = rosterGeometry(p);
  const size = Number.isFinite(Number(leagueSize)) && Number(leagueSize) > 0
    ? Number(leagueSize) : geo.teams;
  // The valuation is a pure function of the row and a fixed profile/table, and
  // the survival lookahead asks for it thousands of times per turn — memoise it
  // by id. Rows without an id are never cached (they are never equal anyway).
  const cache = new Map();
  const ctx = {
    profile: p,
    geo,
    demand: positionDemand(p),
    leagueSize: size,
    replacement: null,
    valueOf: (row) => {
      const id = row && row.gsis_id != null ? String(row.gsis_id) : null;
      if (id !== null && cache.has(id)) return cache.get(id);
      const v = leagueSeasonPoints(row, p, adjOf, pprPointsById, receptionsById);
      if (id !== null) cache.set(id, v);
      return v;
    },
  };
  if (Array.isArray(board) && board.length > 0) {
    ctx.replacement = computeReplacementLevels(board, ctx);
  }
  return ctx;
}

/**
 * Does `pos` still fill an UNFILLED STARTING slot under this league's shape?
 * Fixed demand first; then a flex seat, which is open while the roster's
 * surplus (players beyond fixed demand at any flex-eligible position) has not
 * yet covered every flex slot. Pure.
 */
export function needsStarterSeat(counts, pos, geo) {
  const p = String(pos || '').toUpperCase();
  const fixed = geo.demand[p] || 0;
  if ((counts[p] || 0) < fixed) return true;
  const takesFlex = geo.flexSlots.some((f) => f.positions.includes(p));
  if (!takesFlex) return false;
  const flexPositions = new Set();
  geo.flexSlots.forEach((f) => f.positions.forEach((q) => flexPositions.add(q)));
  let surplus = 0;
  flexPositions.forEach((q) => {
    surplus += Math.max(0, (counts[q] || 0) - (geo.demand[q] || 0));
  });
  return surplus < geo.flexSlots.length;
}

/**
 * LEAGUE-WIDE replacement level per position: the value of the last player who
 * would fill a starting slot somewhere in the room, i.e. round(demand x teams)
 * - 1 into the ranked list — the same definition app/team-logic.js
 * replacementLevel() and app/auction.js fairDollars() use, so all three engines
 * agree on who the FLEX belongs to. A shallower board clamps to the worst
 * player at that position.
 *
 * OVER THE FULL BOARD, ONCE (R23-E1 fix). This used to rank the REMAINING rows
 * on every pick, which made the baseline chase the board down: drafting a QB
 * removed a QB from the ranking, the fixed index round(demand x teams) - 1 slid
 * onto a worse player, replacement FELL, and the VOR of the next QB ROSE. In a
 * superflex league (QB demand ~1.92, index 22) that is a runaway loop — the
 * room took 18 of its first 24 picks at QB, down to backups with ADP 170+,
 * because QB replacement had collapsed to the unprojected tail of the board.
 * Real VOR moves the other way as starters are consumed; a baseline that moves
 * with the board is not a baseline. app/auction.js fairDollars() has always
 * priced off the full board for exactly this reason, and now so does AI+.
 *
 * Rows with NO projection are excluded from the ranking. leagueSeasonPoints()
 * honestly returns 0 for a player this app cannot project (that is the
 * never-fabricate rule), but a 0 is a missing number, not a scouting opinion —
 * letting one become the replacement level would price every player at that
 * position against nothing.
 */
function computeReplacementLevels(board, ctx) {
  const byPos = new Map();
  for (let i = 0; i < board.length; i += 1) {
    const pos = String(board[i].position || '').toUpperCase();
    const v = ctx.valueOf(board[i]);
    if (!Number.isFinite(v) || v <= 0) continue; // unprojected: never the baseline
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(v);
  }
  const out = {};
  byPos.forEach((values, pos) => {
    const demand = ctx.demand[pos];
    if (!Number.isFinite(demand)) { out[pos] = 0; return; }
    values.sort((a, b) => b - a);
    const idx = Math.min(replacementIndex(demand, ctx.leagueSize), values.length - 1);
    out[pos] = values[idx];
  });
  return out;
}

/** The draft's replacement levels, pinned on first use and never recomputed. */
function aiReplacementLevels(board, ctx) {
  if (!ctx.replacement) ctx.replacement = computeReplacementLevels(board, ctx);
  return ctx.replacement;
}

/**
 * One AI+ opponent pick. `board` is the REMAINING rows (ADP-ordered); returns
 * the chosen index into it.
 *
 * Ranking: value over league-wide replacement, computed under the league's own
 * scoring table and its own demand, plus AI_STARTER_NEED_BONUS while the
 * position still has an open starting seat on that roster. In a superflex
 * league the SUPER_FLEX slot pushes QB demand to ~1.9 starters per team, so the
 * QB replacement level collapses and quarterbacks carry the biggest VOR in the
 * room — the AI+ opponents chase them, which the greedy SHARK never does.
 *
 * PLAUSIBLE IMPERFECTION: the pick is SAMPLED from the top few candidates, not
 * taken as the argmax. A room of perfect optimisers is not a useful practice
 * opponent — every player would go at exactly the same slot in every sim, the
 * survival lookahead would report 0% or 100% and nothing else, and the manager
 * would learn a board no real draft produces. The candidate set widens with the
 * round (AI_TOP_K_PER_ROUND) for the same reason the ADP room's noise does:
 * early rounds are near-consensus, late rounds are opinion. Weights decay
 * geometrically (AI_PICK_DECAY), so the best candidate still wins most of the
 * time. Deterministic given `rng` — one uniform draw per pick.
 */
export function aiPlusOpponentPick(board, counts, shape, ctx, round, rng) {
  if (board.length === 0) return 0;
  // 1. Candidates: a position this league can actually roster, that this
  //    roster still needs under the LEAGUE'S caps and flex eligibility.
  let cand = [];
  for (let i = 0; i < board.length; i += 1) {
    const pos = String(board[i].position || '').toUpperCase();
    if (!ctx.geo.positions.includes(pos)) continue;
    if (!opponentNeeds(counts, pos, ctx.profile)) continue;
    cand.push(i);
  }
  // 2. Profile saturated (the room drafts more rounds than the profile rosters)
  //    -> fall back to the ROOM's shape, then to the whole board. Never throws.
  if (cand.length === 0) {
    for (let i = 0; i < board.length; i += 1) {
      if (opponentNeeds(counts, board[i].position, shape)) cand.push(i);
    }
  }
  if (cand.length === 0) cand = board.map((_, i) => i);

  const repl = aiReplacementLevels(board, ctx);
  const scored = cand.map((i) => {
    const pos = String(board[i].position || '').toUpperCase();
    const vor = ctx.valueOf(board[i]) - (repl[pos] || 0);
    const need = needsStarterSeat(counts, pos, ctx.geo) ? AI_STARTER_NEED_BONUS : 0;
    return { i, score: vor + need };
  });
  // Ties break on board order (ADP), so the ranking is a total order.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  const k = Math.max(1, Math.min(
    scored.length, Math.round(AI_TOP_K_BASE + AI_TOP_K_PER_ROUND * (Number(round) || 0)),
  ));
  let total = 0;
  const weights = [];
  for (let i = 0; i < k; i += 1) {
    const w = AI_PICK_DECAY ** i;
    weights.push(w);
    total += w;
  }
  let r = (typeof rng === 'function' ? rng() : 0) * total;
  for (let i = 0; i < k; i += 1) {
    r -= weights[i];
    if (r <= 0) return scored[i].i;
  }
  return scored[k - 1].i;
}

/* --------------------------------------------------------------------------
 * Simulation
 * ------------------------------------------------------------------------ */

/**
 * Simulate opponent picks from the current state until `nPicks` are made.
 * MUTATES nothing — returns the set of taken board indices. Used both to
 * advance the live draft and for the lookahead survival estimate.
 */
function simulatePicks(board, rosters, shape, roomType, adjOf, startPick, nPicks,
                       leagueSize, mySlotIdx, rng, ai) {
  const taken = new Set();
  let pick = startPick;
  let made = 0;
  while (made < nPicks && taken.size < board.length) {
    const team = snakeTeam(pick, leagueSize);
    pick += 1;
    if (team === mySlotIdx) continue; // my picks are decided by ME, not simulated
    const remaining = [];
    for (let i = 0; i < board.length; i += 1) {
      if (!taken.has(i)) remaining.push(board[i]);
    }
    if (remaining.length === 0) break;
    const counts = rosters[team].counts;
    const round = Math.floor((pick - 1) / leagueSize);
    let ri;
    if (roomType === 'shark') ri = sharkOpponentPick(remaining, counts, shape, adjOf);
    else if (roomType === 'aiplus') ri = aiPlusOpponentPick(remaining, counts, shape, ai, round, rng);
    else ri = adpOpponentPick(remaining, counts, shape, round, rng);
    const chosen = remaining[ri];
    const bi = board.indexOf(chosen);
    taken.add(bi);
    made += 1;
  }
  return taken;
}

/**
 * SURVIVAL LOOKAHEAD: for each candidate board index, the probability it is
 * still available at my next pick, from `nSims` seeded simulations of the
 * opponents' picks in between. This is the "plan 2-3 rounds ahead" number:
 * "78% gone by your next turn" is computed, not vibes.
 *
 * Trailing `ai` (optional) is the draft's AI+ context (state.ai) — pass it for
 * an AI+ room so the lookahead simulates the SAME opponents the room drafts
 * with. Omitted for an AI+ room, the default profile stands in rather than
 * throwing; 'adp' and 'shark' never read it.
 */
export function survivalProbabilities(candidateIdxs, board, rosters, shape,
                                      roomType, adjOf, currentPick, picksUntilMine,
                                      leagueSize, mySlotIdx, seed, nSims = 200,
                                      ai = null) {
  const ctx = roomType === 'aiplus'
    ? (ai || aiPlusContext({ adjOf, leagueSize, board })) : null;
  const survived = new Map(candidateIdxs.map((i) => [i, 0]));
  for (let s = 0; s < nSims; s += 1) {
    const rng = mulberry32(seed + s * 7919);
    const taken = simulatePicks(board, rosters, shape, roomType, adjOf,
                                currentPick, picksUntilMine, leagueSize, mySlotIdx, rng, ctx);
    for (const i of candidateIdxs) {
      if (!taken.has(i)) survived.set(i, survived.get(i) + 1);
    }
  }
  const out = new Map();
  for (const [i, n] of survived) out.set(i, n / nSims);
  return out;
}

/* --------------------------------------------------------------------------
 * Scoring: did we beat the room?
 * ------------------------------------------------------------------------ */

/**
 * Optimal starters total for a drafted list of players under `shape`, at
 * scoring `mode`. Greedy fill driven by the SHAPE'S SLOTS: every fixed slot
 * takes the best unused player it accepts, in slot order, then every flex slot
 * takes the best leftover it accepts. For the classic shape that is exactly
 * QB, RB, RB, WR, WR, TE, then FLEX from the leftover RB/WR/TE — unchanged;
 * for a SUPER_FLEX league the flex can now be won by a QB, which the hardcoded
 * RB/WR/TE list made impossible. Unprojected players (no entry in adjOf)
 * contribute 0 — honest, never fabricated.
 */
export function startersTotal(players, shape, adjOf) {
  return fillStarters(players, shape, adjOf).total;
}

/**
 * R30 — THE SAME FILL, PLUS THE SLOTS IT COULD NOT FILL.
 *
 * startersTotal() adds nothing for a slot with no eligible player and returns a
 * bare number, so an incomplete roster is indistinguishable from a complete
 * one. That is how a team holding no kicker and no defence came to be told it
 * had "BEAT THE ROOM BY 235.3 PTS · rank 1/12": the two seats it never filled
 * scored zero silently, and the sheet read like a win.
 *
 * A zero that means "nobody is in this slot" has to be reportable as such.
 * This returns both halves; startersTotal keeps its signature and delegates,
 * so every existing caller is untouched.
 */
export function fillStarters(players, shape, adjOf) {
  const geo = rosterGeometry(shape);
  const sorted = players.slice().sort((a, b) => adjOf(b) - adjOf(a));
  const used = new Set();
  const empty = [];
  let total = 0;
  const fill = (slot, accepts) => {
    for (const p of sorted) {
      if (used.has(p) || !accepts.includes(p.position)) continue;
      used.add(p); total += adjOf(p);
      return;
    }
    empty.push(slot);
  };
  const flexSlots = new Set(geo.flexSlots.map((f) => f.slot));
  // Fixed slots first — a flex slot must never steal a player its fixed
  // neighbours still need.
  geo.starters.forEach((slot) => {
    if (!flexSlots.has(slot)) fill(slot, geo.eligibility[slot] || []);
  });
  geo.starters.forEach((slot) => {
    if (flexSlots.has(slot)) fill(slot, geo.eligibility[slot] || []);
  });
  return { total: Math.round(total * 10) / 10, empty };
}

/**
 * The BEAT-THE-ROOM score sheet: my starters total, every opponent's, the room
 * average, my margin over it, and my rank (1 = best). Pure.
 */
export function scoreVsRoom(myPlayers, opponentRosters, shape, adjOf) {
  const mine = startersTotal(myPlayers, shape, adjOf);
  const opp = opponentRosters.map((r) => startersTotal(r, shape, adjOf));
  const avg = opp.length ? opp.reduce((a, b) => a + b, 0) / opp.length : 0;
  const rank = 1 + opp.filter((o) => o > mine).length;
  return {
    mine,
    roomAvg: Math.round(avg * 10) / 10,
    margin: Math.round((mine - avg) * 10) / 10,
    rank,
    teams: opp.length + 1,
  };
}

/* --------------------------------------------------------------------------
 * Draft state factory (the view drives picks; this owns the bookkeeping)
 * ------------------------------------------------------------------------ */

/**
 * Create a draft. `boardRows` = data/adp.json players (ADP-sorted market
 * board); `adjPointsById` = Map gsis_id -> adjusted season points (our model).
 * Returns a state object the view advances via takeOpponentPick/takeMyPick.
 *
 * AI+ ROOM INPUTS (all optional; ignored by the 'adp' and 'shark' rooms):
 *   profile         the SAVED LeagueProfile (app/league.js loadProfile()).
 *                   Absent -> DEFAULT_PROFILE, so the room still works.
 *   pprPointsById   Map gsis_id -> FULL-PPR season points (proj_points).
 *   receptionsById  Map gsis_id -> prior-season receptions (receptions_prior).
 * The last two are what let the opponents value players under the league's own
 * scoring table (see leagueSeasonPoints); without them they fall back to the
 * room's adjusted points and the shape still drives every need and cap.
 */
export function createDraft({ leagueSize = 12, mySlot = 1, roomType = 'adp',
                              rosterConfig = null, boardRows, adjPointsById,
                              seed = 20260901, excludedIds = [],
                              profile = null, pprPointsById = null,
                              receptionsById = null }) {
  const room = normalizeRoomType(roomType);
  const shape = rosterShape(rosterConfig);
  const rounds = shape.size;
  const excluded = new Set(excludedIds.map(String));
  const board = boardRows.filter((r) => !(r.gsis_id && excluded.has(String(r.gsis_id))));
  const adjOf = (row) => (row.gsis_id != null && adjPointsById.has(String(row.gsis_id))
    ? adjPointsById.get(String(row.gsis_id)) : 0);
  const rosters = [];
  for (let t = 0; t < leagueSize; t += 1) {
    rosters.push({ players: [], counts: {} });
  }
  // `board` pins the replacement baseline to the FULL board once, up front —
  // the reference pool the whole draft is priced against.
  const ai = room === 'aiplus'
    ? aiPlusContext({ profile, adjOf, pprPointsById, receptionsById, leagueSize, board })
    : null;
  return {
    leagueSize, mySlot, roomType: room, shape, rounds, board, adjOf, rosters,
    seed, pick: 0, taken: new Set(), log: [], ai,
    rng: mulberry32(seed),
    totalPicks: leagueSize * rounds,
    done: false,
  };
}

/** Whose turn (0-based team index); -1 when the draft is complete. */
export function onTheClock(state) {
  return state.pick >= state.totalPicks ? -1 : snakeTeam(state.pick, state.leagueSize);
}

function _take(state, boardIdx, teamIdx) {
  const row = state.board[boardIdx];
  state.taken.add(boardIdx);
  const roster = state.rosters[teamIdx];
  roster.players.push(row);
  roster.counts[row.position] = (roster.counts[row.position] || 0) + 1;
  state.log.push({ pick: state.pick + 1, team: teamIdx + 1, name: row.name,
                   position: row.position, adp: row.adp, boardIdx });
  state.pick += 1;
  if (state.pick >= state.totalPicks) state.done = true;
}

/** Undo the most recent pick (mis-tap forgiveness in LIVE mode). Exact
 * reversal of _take; returns the undone log entry or null. */
export function undoLastPick(state) {
  const last = state.log.pop();
  if (!last) return null;
  state.taken.delete(last.boardIdx);
  const roster = state.rosters[last.team - 1];
  roster.players.pop();
  roster.counts[last.position] -= 1;
  state.pick -= 1;
  state.done = false;
  return last;
}

/** Advance ONE opponent pick (view calls repeatedly until it's my turn). */
export function takeOpponentPick(state) {
  const team = onTheClock(state);
  if (team < 0 || team === state.mySlot - 1) return null;
  const remaining = [];
  for (let i = 0; i < state.board.length; i += 1) {
    if (!state.taken.has(i)) remaining.push(state.board[i]);
  }
  if (remaining.length === 0) { state.done = true; return null; }
  const round = Math.floor(state.pick / state.leagueSize);
  const counts = state.rosters[team].counts;
  let ri;
  if (state.roomType === 'shark') {
    ri = sharkOpponentPick(remaining, counts, state.shape, state.adjOf);
  } else if (state.roomType === 'aiplus') {
    // createDraft always builds the context; a hand-assembled state gets the
    // default profile once (cached, so the room never re-derives it per pick).
    if (!state.ai) {
      state.ai = aiPlusContext({
        adjOf: state.adjOf, leagueSize: state.leagueSize, board: state.board,
      });
    }
    ri = aiPlusOpponentPick(remaining, counts, state.shape, state.ai, round, state.rng);
  } else {
    ri = adpOpponentPick(remaining, counts, state.shape, round, state.rng);
  }
  const bi = state.board.indexOf(remaining[ri]);
  _take(state, bi, team);
  return state.log[state.log.length - 1];
}

/** Record MY pick of board index `boardIdx`. */
export function takeMyPick(state, boardIdx) {
  if (onTheClock(state) !== state.mySlot - 1 || state.taken.has(boardIdx)) return null;
  _take(state, boardIdx, state.mySlot - 1);
  return state.log[state.log.length - 1];
}

/** LIVE mode: record the OBSERVED pick of the team on the clock (the user taps
 * what actually happened in their real draft — no opponent model involved). */
export function takeOpponentPickAt(state, boardIdx) {
  const team = onTheClock(state);
  if (team < 0 || team === state.mySlot - 1 || state.taken.has(boardIdx)) return null;
  _take(state, boardIdx, team);
  return state.log[state.log.length - 1];
}

/** Picks remaining until my next turn (for the survival lookahead); 0 if the
 * draft is over or it is my turn now. */
export function picksUntilMyNext(state) {
  if (state.done) return 0;
  let n = 0;
  for (let p = state.pick; p < state.totalPicks; p += 1) {
    if (snakeTeam(p, state.leagueSize) === state.mySlot - 1) return n;
    n += 1;
  }
  return 0;
}
