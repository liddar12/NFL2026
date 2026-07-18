/* app/auction.js — THE AUCTION ENGINE (pure).
 *
 * Auction-draft market math + room simulation for the TEAM tab draft room.
 * Every function is PURE and seeded like app/draft-sim.js: no DOM, no fetch,
 * no Date — same inputs, same outputs, unit-tested directly under node.
 *
 * MONEY MODEL
 *   * fairDollars: OUR dollars — VOR (value over replacement) from the fit
 *     engine's adjusted points, allocated over the league's total budget with
 *     a $1 floor. This is the independent model's price sheet.
 *   * marketDollars: the MARKET's dollars — derived from the FFC ADP consensus
 *     with an exponential price-decay curve calibrated so the draftable pool
 *     absorbs exactly the league's total budget. HONESTY LABEL: FFC publishes
 *     no auction values, so this is a documented transform of real ADP data,
 *     not observed prices; in-room observed sales (tendencies + inflation)
 *     correct it live. POLICY BOUNDARY: market dollars model OPPONENTS and
 *     flag value gaps — they are never blended into our own valuations.
 *   * inflation: remaining room budget / remaining fair value — recomputed
 *     after every sale; adjusted price = fair x inflation.
 *
 * NOMINATION STRATEGY (classifyNomination):
 *   BAIT    market prices the player >= ~15% above our value — nominate EARLY
 *           so opponents burn budget on a player we don't rate.
 *   TARGET  our value >= ~15% above market — hold LATE, buy the discount.
 *   NEUTRAL everything else.
 *
 * ROOM LEARNING (in-draft, chosen design "live tendencies + priors"):
 *   every opponent starts at the market prior (tendency 1.0 per position) and
 *   updates with an exponentially-weighted overpay ratio after each observed
 *   sale — the room model adapts to how THIS room actually bids.
 */

import { mulberry32, rosterShape, startersTotal, scoreVsRoom } from './draft-sim.js';

export const DEFAULT_BUDGET = 200;
export const BUDGET_CHOICES = Object.freeze([100, 200, 300]);
export const MIN_BID = 1;

/** Market price-decay shape: v(rank) ~ exp(-DECAY * (rank-1)). Fitted to the
 * classic 12-team/$200 AAV curve (top pick ~30% of budget, ~$1 by rank ~120). */
export const MARKET_DECAY = 0.028;

/** Tendency EW update rate: how fast the room model believes observed sales. */
export const TENDENCY_ALPHA = 0.30;
const TENDENCY_CLAMP = Object.freeze([0.6, 1.6]);

/** Max legal bid: must keep $1 for every other open slot. */
export function maxBid(budget, openSlots) {
  return Math.max(0, budget - Math.max(0, openSlots - 1) * MIN_BID);
}

/**
 * MARKET dollars from ADP rows (ascending adp). Returns Map(gsis_id|name -> $).
 * Exponential decay over ADP rank, calibrated so the top (teams x rosterSize)
 * players sum EXACTLY to teams x budget (every dollar in the room lands in the
 * draftable pool; everyone else is $1).
 */
export function marketDollars(adpRows, leagueSize, budget, rosterSize = 13) {
  const rows = Array.isArray(adpRows) ? adpRows : [];
  const poolN = Math.min(rows.length, leagueSize * rosterSize);
  const total = leagueSize * budget;
  const weights = [];
  for (let i = 0; i < poolN; i += 1) weights.push(Math.exp(-MARKET_DECAY * i));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const spread = total - poolN * MIN_BID;         // dollars above the $1 floors
  const out = new Map();
  let allocated = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const key = String(rows[i].gsis_id || `name:${rows[i].name}`);
    if (i < poolN) {
      const v = MIN_BID + Math.round(spread * (weights[i] / wSum));
      out.set(key, v);
      allocated += v;
    } else {
      out.set(key, MIN_BID);
    }
  }
  // Rounding drift lands on the #1 pick so the pool sums exactly.
  if (poolN > 0) {
    const key0 = String(rows[0].gsis_id || `name:${rows[0].name}`);
    out.set(key0, out.get(key0) + (total - allocated));
  }
  return out;
}

/**
 * OUR dollars from projections: VOR over the draftable pool. `pool` is an array
 * of {gsis_id, position}, adjOf(row) -> adjusted points. Replacement level per
 * position = the points of the last starter-demanded player league-wide (flex
 * demand spread over RB/WR/TE by count). Returns Map(gsis_id -> $).
 */
export function fairDollars(pool, adjOf, leagueSize, budget, shape) {
  const s = shape || rosterShape(null);
  const rosterSize = s.size;
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of pool) {
    if (byPos[p.position]) byPos[p.position].push(p);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => adjOf(b) - adjOf(a));
  }
  // Starter demand: fixed slots + flex spread over RB/WR/TE proportionally to
  // how often flex is actually won by each (approx: RB/WR heavy, TE light).
  const flexShare = { RB: 0.45, WR: 0.45, TE: 0.10 };
  const repl = {};
  for (const pos of Object.keys(byPos)) {
    const demand = (s.starterDemand[pos] || 0) + (s.config.flex || 0) * (flexShare[pos] || 0);
    const idx = Math.max(0, Math.round(demand * leagueSize) - 1);
    const arr = byPos[pos];
    repl[pos] = arr.length ? adjOf(arr[Math.min(idx, arr.length - 1)]) : 0;
  }
  const vor = new Map();
  let vorSum = 0;
  for (const p of pool) {
    const v = Math.max(0, adjOf(p) - (repl[p.position] || 0));
    vor.set(String(p.gsis_id), v);
    if (v > 0) vorSum += v;
  }
  const poolN = Math.min(pool.length, leagueSize * rosterSize);
  const spread = leagueSize * budget - poolN * MIN_BID;
  const out = new Map();
  for (const p of pool) {
    const v = vor.get(String(p.gsis_id)) || 0;
    out.set(String(p.gsis_id),
      MIN_BID + (vorSum > 0 ? Math.round(spread * (v / vorSum)) : 0));
  }
  return out;
}

/** Inflation rate: remaining room dollars chasing remaining fair value.
 * > 1 means players will sell above fair; < 1 means bargains ahead. */
export function inflation(remainingBudget, remainingFairSum) {
  if (remainingFairSum <= 0) return 1;
  return remainingBudget / remainingFairSum;
}

/** BAIT / TARGET / NEUTRAL for the nomination advisor (see module docstring).
 * Gap must clear both $3 and 15% of the larger price to matter. */
export function classifyNomination(ourDollar, marketDollar) {
  const gap = ourDollar - marketDollar;
  const thresh = Math.max(3, 0.15 * Math.max(ourDollar, marketDollar));
  if (-gap >= thresh) return 'BAIT';
  if (gap >= thresh) return 'TARGET';
  return 'NEUTRAL';
}

/** EW tendency update: how much this team overpays (paid/market) per position.
 * Returns the new clamped tendency. */
export function tendencyUpdate(current, paid, market) {
  const ratio = market > 0 ? paid / market : 1;
  const next = (1 - TENDENCY_ALPHA) * (current == null ? 1 : current)
    + TENDENCY_ALPHA * ratio;
  return Math.min(TENDENCY_CLAMP[1], Math.max(TENDENCY_CLAMP[0], next));
}

/** Positional slots a team still needs (mirror of draft-sim's opponentNeeds but
 * counting open capacity, since auctions fill rosters in any order). */
function teamNeedsPos(team, pos, shape) {
  const counts = {};
  for (const p of team.players) counts[p.position] = (counts[p.position] || 0) + 1;
  const caps = {
    QB: shape.config.qb + 1, RB: shape.config.rb + shape.config.flex + 1,
    WR: shape.config.wr + shape.config.flex + 1, TE: shape.config.te + 1,
  };
  const total = team.players.length;
  if (total >= shape.size) return false;
  return (counts[pos] || 0) < (caps[pos] || 0) + Math.max(0, shape.config.bench - 4);
}

/**
 * An opponent's max willingness for the player on the block. Deterministic
 * given rng. Blends market price, that team's learned positional tendency, the
 * live inflation rate, and budget/need caps.
 */
export function opponentBid(player, team, market, tendency, inflationRate, shape, rng) {
  if (!teamNeedsPos(team, player.position, shape)) return 0;
  const open = shape.size - team.players.length;
  const cap = maxBid(team.budget, open);
  if (cap < MIN_BID) return 0;
  const noise = 0.9 + rng() * 0.25;                  // 0.90 - 1.15
  const want = market * (tendency == null ? 1 : tendency) * inflationRate * noise;
  return Math.min(cap, Math.max(0, Math.round(want)));
}

/** Per-slot budget plan. 'stars' front-loads the top starters; 'balanced'
 * spreads evenly by slot value. Sums exactly to (budget - bench dollars). */
export function planBudget(shape, budget, style) {
  const starters = shape.starters.length;
  const benchDollars = shape.bench.length * MIN_BID;
  const pool = budget - benchDollars;
  const weights = [];
  for (let i = 0; i < starters; i += 1) {
    weights.push(style === 'stars' ? Math.exp(-0.75 * i) : Math.exp(-0.18 * i));
  }
  const wSum = weights.reduce((a, b) => a + b, 0);
  const plan = weights.map((w) => Math.max(MIN_BID, Math.round(pool * (w / wSum))));
  let drift = pool - plan.reduce((a, b) => a + b, 0);
  plan[0] += drift;
  return { slots: shape.starters.map((name, i) => ({ slot: name, planned: plan[i] })),
           benchDollars };
}

/* --------------------------------------------------------------------------
 * Auction room state machine (sim AND live share it; live skips the opponent
 * model and applies observed sales via sellTo).
 * ------------------------------------------------------------------------ */

export function createAuction({
  leagueSize = 12, mySlot = 5, budget = DEFAULT_BUDGET, rosterConfig = null,
  boardRows = [], adjPointsById = new Map(), adpDollars = null, seed = 1,
} = {}) {
  const shape = rosterShape(rosterConfig);
  const adjOf = (r) => {
    const v = r && r.gsis_id != null ? adjPointsById.get(String(r.gsis_id)) : null;
    return Number.isFinite(v) ? v : 0;
  };
  const fair = fairDollars(boardRows.filter((r) => r.gsis_id), adjOf,
    leagueSize, budget, shape);
  const market = adpDollars || marketDollars(boardRows, leagueSize, budget, shape.size);
  let remainingFair = 0;
  for (const r of boardRows.filter((x) => x.gsis_id)) {
    remainingFair += fair.get(String(r.gsis_id)) || 0;
  }
  return {
    kind: 'auction',
    leagueSize,
    mySlot,
    budget,
    shape,
    adjOf,
    board: boardRows,
    taken: new Set(),
    fair,
    market,
    remainingFair,
    teams: Array.from({ length: leagueSize }, () => ({
      budget, players: [], tendencies: {},
    })),
    nomIdx: 0,                       // whose nomination it is (rotates)
    block: null,                     // {boardIdx} while a player is up
    log: [],
    rng: mulberry32(seed),
    done: false,
  };
}

export function myTeam(a) { return a.teams[a.mySlot - 1]; }

export function onTheNomination(a) {
  // Rotation skips teams whose rosters are already full — they have nothing
  // left to nominate for.
  for (let hop = 0; hop < a.leagueSize; hop += 1) {
    const t = (a.nomIdx + hop) % a.leagueSize;
    if (a.teams[t].players.length < a.shape.size) return t;
  }
  return a.nomIdx % a.leagueSize;
}

/** Opponent nomination model: best available by MARKET price among needs —
 * the consensus-driven room nominates the shiniest name it can roster. */
export function autoNominate(a) {
  const team = a.teams[onTheNomination(a)];
  let best = -1;
  let bestVal = -1;
  for (let i = 0; i < a.board.length; i += 1) {
    if (a.taken.has(i) || !a.board[i].gsis_id) continue;
    if (!teamNeedsPos(team, a.board[i].position, a.shape)) continue;
    const m = a.market.get(String(a.board[i].gsis_id)) || MIN_BID;
    if (m > bestVal) { bestVal = m; best = i; }
  }
  return best;
}

export function nominate(a, boardIdx) {
  a.block = { boardIdx };
}

/** Live inflation right now: every remaining room dollar vs remaining fair
 * value ($1-floor players carry ~$1 of fair value, so no reserve adjustment). */
export function liveInflation(a) {
  const remBudget = a.teams.reduce((s, t) => s + t.budget, 0);
  return inflation(remBudget, a.remainingFair);
}

/**
 * Resolve the block via the opponent model + my ceiling. English-auction
 * approximation: winner = highest willingness, price = second-highest + 1
 * (floored at MIN_BID). Returns {winnerIdx, price} without applying it.
 */
export function resolveBids(a, myMaxBid) {
  const row = a.board[a.block.boardIdx];
  const infl = liveInflation(a);
  const market = a.market.get(String(row.gsis_id || `name:${row.name}`)) || MIN_BID;
  const bids = [];
  for (let t = 0; t < a.leagueSize; t += 1) {
    if (t === a.mySlot - 1) {
      bids.push(Math.max(0, Math.round(myMaxBid || 0)));
    } else {
      bids.push(opponentBid(row, a.teams[t],
        market, a.teams[t].tendencies[row.position], infl, a.shape, a.rng));
    }
  }
  let winner = -1;
  let top = 0;
  let second = 0;
  for (let t = 0; t < a.leagueSize; t += 1) {
    if (bids[t] > top || (bids[t] === top && winner === -1)) {
      second = top; top = bids[t]; winner = t;
    } else if (bids[t] > second) {
      second = bids[t];
    }
  }
  if (top < MIN_BID) return { winnerIdx: onTheNomination(a), price: MIN_BID };
  return { winnerIdx: winner, price: Math.max(MIN_BID, Math.min(top, second + 1)) };
}

/** Apply a sale (sim resolution or LIVE observed sale). Updates budgets, the
 * winner's roster, room tendencies (the learning step), inflation base. */
export function sellTo(a, teamIdx, price, boardIdx) {
  const row = a.board[boardIdx];
  const key = String(row.gsis_id || `name:${row.name}`);
  a.taken.add(boardIdx);
  const team = a.teams[teamIdx];
  team.budget = Math.max(0, team.budget - price);
  team.players.push(row);
  const market = a.market.get(key) || MIN_BID;
  const prevTendency = team.tendencies[row.position];
  if (teamIdx !== a.mySlot - 1) {
    team.tendencies[row.position] =
      tendencyUpdate(team.tendencies[row.position], price, market);
  }
  if (row.gsis_id) a.remainingFair -= (a.fair.get(String(row.gsis_id)) || 0);
  a.log.push({ name: row.name, position: row.position, team: teamIdx + 1, price,
               boardIdx, prevTendency });
  a.block = null;
  a.nomIdx += 1;
  a.done = a.teams.every((t) => t.players.length >= a.shape.size)
    || a.board.length - a.taken.size === 0;
  return a;
}

/** Undo the most recent sale (mis-entry forgiveness, esp. LIVE mode). Exact
 * reversal of sellTo — including the learned tendency, restored from the log
 * entry's snapshot. Returns the undone entry or null. */
export function undoLastSale(a) {
  const last = a.log.pop();
  if (!last) return null;
  const row = a.board[last.boardIdx];
  const team = a.teams[last.team - 1];
  a.taken.delete(last.boardIdx);
  team.budget += last.price;
  team.players.pop();
  if (last.team - 1 !== a.mySlot - 1) {
    if (last.prevTendency == null) delete team.tendencies[row.position];
    else team.tendencies[row.position] = last.prevTendency;
  }
  if (row.gsis_id) a.remainingFair += (a.fair.get(String(row.gsis_id)) || 0);
  a.nomIdx -= 1;
  a.block = null;
  a.done = false;
  return last;
}

/** Bid guidance for the player on the block: our price, inflation-adjusted
 * price, the number to bid to under the current strategy, and the credible
 * threats (teams that can and would go near that number). */
export function myGuidance(a, boardIdx, strategy = {}) {
  const row = a.board[boardIdx];
  const key = String(row.gsis_id || `name:${row.name}`);
  const fair = a.fair.get(key) || MIN_BID;
  const infl = liveInflation(a);
  const adjusted = Math.round(fair * infl);
  const tempo = strategy.tempo === 'aggressive' ? 1.08 : 1.0;
  const me = myTeam(a);
  const open = a.shape.size - me.players.length;
  const cap = maxBid(me.budget, open);
  const needIt = teamNeedsPos(me, row.position, a.shape);
  const bidTo = needIt ? Math.min(cap, Math.round(adjusted * tempo)) : 0;
  const market = a.market.get(key) || MIN_BID;
  const threats = [];
  for (let t = 0; t < a.leagueSize; t += 1) {
    if (t === a.mySlot - 1) continue;
    const team = a.teams[t];
    const tCap = maxBid(team.budget, a.shape.size - team.players.length);
    const tend = team.tendencies[row.position];
    const est = Math.round(market * (tend == null ? 1 : tend) * infl);
    if (tCap >= bidTo && est >= Math.round(0.8 * bidTo) && bidTo > 0) {
      threats.push({ team: t + 1, maxBid: tCap, estWill: Math.min(tCap, est) });
    }
  }
  const cls = classifyNomination(fair, market);
  return { fair, adjusted, bidTo, cap, needIt, market, threats, class: cls };
}

/** Nomination advice: my BAIT and TARGET lists among available players, plus a
 * concrete suggestion (bait early / neutral-big to drain, guided by strategy). */
export function nominationAdvice(a, strategy = {}, topN = 3) {
  const bait = [];
  const targets = [];
  for (let i = 0; i < a.board.length; i += 1) {
    if (a.taken.has(i)) continue;
    const row = a.board[i];
    const key = String(row.gsis_id || `name:${row.name}`);
    const fair = row.gsis_id ? (a.fair.get(key) || MIN_BID) : MIN_BID;
    const market = a.market.get(key) || MIN_BID;
    const cls = classifyNomination(fair, market);
    const entry = { boardIdx: i, name: row.name, position: row.position,
      fair, market, gap: fair - market };
    if (cls === 'BAIT') bait.push(entry);
    else if (cls === 'TARGET') targets.push(entry);
  }
  bait.sort((x, y) => (x.gap - y.gap));            // most overpriced first
  targets.sort((x, y) => (y.gap - x.gap));         // most underpriced first
  const suggestion = bait.length
    ? { ...bait[0], why: 'market prices this well above our value — let the room spend' }
    : null;
  return { bait: bait.slice(0, topN), targets: targets.slice(0, topN), suggestion };
}

/** Final score: starters margin vs the room + points-per-dollar efficiency. */
export function scoreAuction(a) {
  const mine = myTeam(a).players;
  const opp = a.teams.filter((_, i) => i !== a.mySlot - 1).map((t) => t.players);
  const sheet = scoreVsRoom(mine, opp, a.shape, a.adjOf);
  const spent = a.budget - myTeam(a).budget;
  return { ...sheet, spent,
    ptsPerDollar: spent > 0 ? Math.round((sheet.mine / spent) * 10) / 10 : 0 };
}

export { startersTotal };
