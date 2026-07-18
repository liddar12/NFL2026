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
 * (every opponent uses our VOR engine) is a stress test and is explicitly
 * excluded from the learning record so the market benchmark stays clean.
 *
 * SELF-LEARNING HOOK: completed mocks are locked point-in-time (the view
 * appends them to localStorage nfl2026.mocklocks.v1). When the season
 * resolves, actual points grade those locks and the fit-engine coefficients
 * become refittable through the same NEVER-REGRESS gate as the game model.
 * Until then the coefficients are the documented priors — labeled, not
 * silently "learned".
 *
 * ADP POLICY BOUNDARY: ADP models OPPONENTS and value flags only. It never
 * touches our projections — a player without a projection (gsis_id null) can
 * be drafted BY OPPONENTS but is never recommended to us and scores 0 toward
 * roster totals (never fabricated points).
 */

import {
  scoringAdjust, POSITION_CAPS,
} from './team-logic.js';

/* --------------------------------------------------------------------------
 * Roster configuration (Rel6: slot counts are configurable within sane bounds)
 * ------------------------------------------------------------------------ */

/** Bounds per configurable slot type. Defaults reproduce the classic shape. */
export const ROSTER_BOUNDS = Object.freeze({
  qb: [1, 2], rb: [2, 3], wr: [2, 3], te: [1, 2], flex: [0, 2], bench: [4, 8],
});
export const DEFAULT_ROSTER = Object.freeze({ qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6 });

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
  const bench = [];
  for (let i = 1; i <= c.bench; i += 1) bench.push(`BN${i}`);
  return {
    config: c,
    starters,
    bench,
    starterDemand: { QB: c.qb, RB: c.rb, WR: c.wr, TE: c.te },
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
 * hard caps we use (no 3rd QB). Pure. */
export function opponentNeeds(counts, pos, shape) {
  const cap = POSITION_CAPS[pos] != null ? POSITION_CAPS[pos] : Infinity;
  const have = counts[pos] || 0;
  if (have >= cap) return false;
  const demand = shape.starterDemand[pos] || 0;
  const flexible = pos === 'RB' || pos === 'WR' || pos === 'TE';
  // Starter demand + FLEX share + one backup everywhere (real rooms draft a
  // backup QB late; the hard cap above still stops a 3rd).
  const want = demand + (flexible ? shape.config.flex + 1 : 1);
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
 * Simulation
 * ------------------------------------------------------------------------ */

/**
 * Simulate opponent picks from the current state until `nPicks` are made.
 * MUTATES nothing — returns the set of taken board indices. Used both to
 * advance the live draft and for the lookahead survival estimate.
 */
function simulatePicks(board, rosters, shape, roomType, adjOf, startPick, nPicks,
                       leagueSize, mySlotIdx, rng) {
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
    const ri = roomType === 'shark'
      ? sharkOpponentPick(remaining, counts, shape, adjOf)
      : adpOpponentPick(remaining, counts, shape, round, rng);
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
 */
export function survivalProbabilities(candidateIdxs, board, rosters, shape,
                                      roomType, adjOf, currentPick, picksUntilMine,
                                      leagueSize, mySlotIdx, seed, nSims = 200) {
  const survived = new Map(candidateIdxs.map((i) => [i, 0]));
  for (let s = 0; s < nSims; s += 1) {
    const rng = mulberry32(seed + s * 7919);
    const taken = simulatePicks(board, rosters, shape, roomType, adjOf,
                                currentPick, picksUntilMine, leagueSize, mySlotIdx, rng);
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
 * scoring `mode`. Greedy fill: positions by demand from the best-points-first
 * list, FLEX takes the best leftover RB/WR/TE. Unprojected players (no entry
 * in adjOf) contribute 0 — honest, never fabricated.
 */
export function startersTotal(players, shape, adjOf) {
  const sorted = players.slice().sort((a, b) => adjOf(b) - adjOf(a));
  const used = new Set();
  let total = 0;
  const fill = (pos, n) => {
    let left = n;
    for (const p of sorted) {
      if (left === 0) break;
      if (used.has(p) || p.position !== pos) continue;
      used.add(p); total += adjOf(p); left -= 1;
    }
  };
  fill('QB', shape.starterDemand.QB);
  fill('RB', shape.starterDemand.RB);
  fill('WR', shape.starterDemand.WR);
  fill('TE', shape.starterDemand.TE);
  let flexLeft = shape.config.flex;
  for (const p of sorted) {
    if (flexLeft === 0) break;
    if (used.has(p) || !['RB', 'WR', 'TE'].includes(p.position)) continue;
    used.add(p); total += adjOf(p); flexLeft -= 1;
  }
  return Math.round(total * 10) / 10;
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
 */
export function createDraft({ leagueSize = 12, mySlot = 1, roomType = 'adp',
                              rosterConfig = null, boardRows, adjPointsById,
                              seed = 20260901, excludedIds = [] }) {
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
  return {
    leagueSize, mySlot, roomType, shape, rounds, board, adjOf, rosters,
    seed, pick: 0, taken: new Set(), log: [],
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
                   position: row.position, adp: row.adp });
  state.pick += 1;
  if (state.pick >= state.totalPicks) state.done = true;
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
  const ri = state.roomType === 'shark'
    ? sharkOpponentPick(remaining, state.rosters[team].counts, state.shape, state.adjOf)
    : adpOpponentPick(remaining, state.rosters[team].counts, state.shape, round, state.rng);
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
