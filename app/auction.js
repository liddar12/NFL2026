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
 *   * marketDollars: the MARKET's dollars — what the ROOM will pay. Two
 *     sources, in priority order:
 *       1. OBSERVED PRICES. data/adp.json carries `auction_value` (ESPN kona
 *          ownership.auctionValueAverage — the average winning bid in real
 *          draft rooms) on ~205 of 211 rows. When the board carries them they
 *          ARE the market curve, renormalised so the draftable pool absorbs
 *          exactly this league's total budget: that moves ESPN's published
 *          denomination into ours and preserves every relative price.
 *       2. THE ADP DECAY CURVE. A board with no published price on ANY row
 *          (the pre-R23 case, and every synthetic fixture) falls back to the
 *          exponential decay over ADP rank, unchanged and byte-for-byte.
 *     HONESTY LABEL: (1) is observed market prices; (2) is a documented
 *     transform of real ADP data, NOT observed prices. In-room observed sales
 *     (tendencies + inflation) correct either one live.
 *     POLICY BOUNDARY — the line this module does not cross: a market dollar
 *     may never change what this app thinks a player is WORTH. fairDollars()
 *     is the whole of that opinion and it never sees a price — VOR from the fit
 *     engine's adjusted points, allocated over the league budget — and nothing
 *     downstream re-derives worth from the market either: myGuidance's `fair`
 *     is fairDollars, dollar for dollar, on any board.
 *
 *     WHAT MARKET DOLLARS *DO* REACH, stated exactly, because the shorter claim
 *     that used to sit here was false: they model OPPONENTS (opponentBid,
 *     autoNominate, threats) and flag value gaps (classifyNomination) — and
 *     since the room bids from the market, the PRICES THE ROOM ACTUALLY PAYS
 *     depend on the curve it was given. Those observed sales are what move
 *     liveInflation() and drain my budget, so myGuidance's `adjusted`
 *     (= fair x inflation), `bidTo` and `cap` DO differ between a room that bid
 *     a steep published curve and one that bid the ADP-decay fallback. That is
 *     the intended mechanism, not a leak: what a seat costs today has to reach
 *     the advice. What must never move is the opinion underneath it.
 *     tests/feature/auction.test.mjs drives two differently priced rooms
 *     through real nominations and sales and asserts exactly that split.
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
 *
 * ROOM MEMORY (cross-draft, auction-memory S2): when the caller hands
 *   createAuction the stored DRAFT HISTORY (app/mocks.js records), opponents
 *   open at a per-position prior seeded from the observed sale prices of past
 *   LIVE auctions at the same league size, shrunk toward 1.0 by sample size
 *   (seedTendencies below). LIVE evidence only — a SIM room's sales are this
 *   module's own opponentBid sampler talking to itself, and fitting a prior to
 *   them would measure our own RNG and report it back as your league.
 */

import {
  mulberry32, rosterShape, startersTotal, fillStarters, scoreVsRoom,
  canonicalizeBoardPositions,
} from './draft-sim.js';
import { rosterGeometry, positionDemand, replacementIndex } from './team-logic.js';

export const DEFAULT_BUDGET = 200;
export const BUDGET_CHOICES = Object.freeze([100, 200, 300]);
export const MIN_BID = 1;

/** Market price-decay shape: v(rank) ~ exp(-DECAY * (rank-1)). Fitted to the
 * classic 12-team/$200 AAV curve (top pick ~30% of budget, ~$1 by rank ~120). */
export const MARKET_DECAY = 0.028;

/** Tendency EW update rate: how fast the room model believes observed sales. */
const TENDENCY_ALPHA = 0.30;
const TENDENCY_CLAMP = Object.freeze([0.6, 1.6]);

/** Prior strength for seeding tendencies from stored LIVE auction history:
 * the seed is posterior = (n·observed + K·1.0) / (n + K), i.e. the market
 * prior counts as K virtual sales at ratio 1.0.
 *
 * WHY 16: chosen against the volumes one real draft produces, so that
 *   - a stray pair of sales barely moves the prior: n=2 of ratio 1.5 seeds
 *     1.056, not 1.5 — two observations of one league are not a tendency, and
 *     a confident wrong prior is worse than no prior;
 *   - one full LIVE 12-team draft earns real weight where it has real volume:
 *     RB/WR see ~45-60 opponent sales each, so their observed ratio carries
 *     ~75% of the seed after a single recorded draft;
 *   - thin positions stay majority-prior until a second draft corroborates:
 *     QB/TE see ~12-15 sales per draft, under the K=16 virtual sales.
 * The seed is only a STARTING point: in-room tendencyUpdate (alpha 0.30)
 * halves its influence roughly every two observed sales at that position, so
 * a seeded room that bids differently today re-teaches itself within rounds. */
export const TENDENCY_PRIOR_K = 16;

/** Max legal bid: must keep $1 for every other open slot. A team with NO open
 * slot has no legal bid at all — $0, not "the whole budget". (Before R23-E2
 * openSlots <= 0 returned the entire budget, so the clamp that is supposed to
 * stop a full roster buying one more player did nothing.) */
export function maxBid(budget, openSlots) {
  if (!(openSlots > 0)) return 0;
  return Math.max(0, budget - (openSlots - 1) * MIN_BID);
}

/** A row's PUBLISHED auction price, or null when the market does not price him.
 * Absent / null / non-positive is NOT a price — "$0" is a price and "unpriced"
 * is not one (data/contracts/adp.schema.json says the same thing). */
function publishedPrice(row) {
  const v = Number(row && row.auction_value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** True when at least one row on this board carries a published auction price. */
function hasPublishedPrices(adpRows) {
  const rows = Array.isArray(adpRows) ? adpRows : [];
  for (const r of rows) if (publishedPrice(r) != null) return true;
  return false;
}

/**
 * Relative market weights from the published prices, in board (ADP) order.
 *
 * DEGRADING HONESTLY — the ~6 of 211 rows ESPN does not price: an unpriced
 * player is NOT free and NOT a bargain. He is priced at the mean of his
 * nearest priced neighbours ON THE BOARD (one side only if he sits at an end),
 * i.e. the room pays for him roughly what it pays for the players it drafts
 * him among. We never invent a number below that neighbourhood, and we never
 * let "we have no price" read as "$0".
 */
function publishedWeights(rows) {
  const raw = rows.map(publishedPrice);
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    if (raw[i] != null) { out[i] = raw[i]; continue; }
    let prev = null;
    for (let j = i - 1; j >= 0; j -= 1) { if (raw[j] != null) { prev = raw[j]; break; } }
    let next = null;
    for (let j = i + 1; j < rows.length; j += 1) { if (raw[j] != null) { next = raw[j]; break; } }
    if (prev != null && next != null) out[i] = (prev + next) / 2;
    else out[i] = prev != null ? prev : (next != null ? next : MIN_BID);
  }
  return out;
}

/**
 * MARKET dollars from board rows (ascending adp). Returns Map(gsis_id|name -> $).
 *
 * The curve is the published `auction_value` when the board carries any, and
 * the exponential ADP-rank decay when it carries none (see the module header).
 * Either way it is calibrated so the top (teams x rosterSize) rows sum EXACTLY
 * to teams x budget — every dollar in the room lands in the draftable pool and
 * everyone past it is $1. That renormalisation is what makes ESPN's published
 * board comparable to THIS room's budget; it is a scalar, so the market's own
 * relative prices survive it intact.
 *
 * The pool is still the first (teams x rosterSize) rows BY ADP: ADP is the
 * model of who gets drafted at all, and price is the model of what they cost.
 *
 * WHY THE PUBLISHED PRICES NEED RENORMALISING AT ALL: ESPN's board prices ~211
 * offensive players, while an ESPN room rosters 16 including K/DST, so its
 * published averages sum to ~75% of a room's money — the rest is spent off
 * this board. Our room spends 100% of its money ON this board, so the curve is
 * stretched to fit it. Relative prices, which are the whole opponent model,
 * are untouched: doubling every published price changes nothing here.
 */
export function marketDollars(adpRows, leagueSize, budget, rosterSize = 13,
                              totalMoney = null) {
  const rows = Array.isArray(adpRows) ? adpRows : [];
  const poolN = Math.min(rows.length, leagueSize * rosterSize);
  // R27 — the room's money is a SUM, not a product. It was leagueSize * budget
  // because every team held the same budget; a league where preseason trades
  // left T3 with $215 and T7 with $185 has the same team count and a different
  // amount of money, and this curve must be calibrated to the money actually
  // in the room or every valuation on the board is wrong. Passing nothing
  // keeps the old arithmetic byte-for-byte.
  const total = Number.isFinite(totalMoney) ? totalMoney : leagueSize * budget;
  const priced = hasPublishedPrices(rows);
  const curve = priced ? publishedWeights(rows) : null;
  const weights = [];
  for (let i = 0; i < poolN; i += 1) {
    weights.push(priced ? curve[i] : Math.exp(-MARKET_DECAY * i));
  }
  const wSum = weights.reduce((a, b) => a + b, 0);
  /* R30b — MIN_BID IS THE LOWER BOUND OF EVERY PUBLISHED DOLLAR. At the $10
   * minimum league budget the room's money (teams x $10) is LESS than $1 per
   * draftable seat (teams x rosterSize), so the unfloored spread went negative
   * and was distributed as negative allocation on top of the $1 floor — the
   * highest-weighted player got the MOST negative price (measured: MARKET -$7).
   * An under-funded room prices everyone at the floor instead: the floor is
   * the honest bound, because no legal sale in this room can happen below $1.
   * `shortfall` records that state for the conservation step below. */
  const shortfall = total - poolN * MIN_BID < 0;
  const spread = Math.max(0, total - poolN * MIN_BID); // dollars above the $1 floors
  const out = new Map();
  let allocated = 0;
  let topIdx = 0;
  let topVal = -Infinity;
  for (let i = 0; i < rows.length; i += 1) {
    const key = String(rows[i].gsis_id || `name:${rows[i].name}`);
    if (i < poolN) {
      const v = MIN_BID + (wSum > 0 ? Math.round(spread * (weights[i] / wSum)) : 0);
      out.set(key, v);
      allocated += v;
      if (v > topVal) { topVal = v; topIdx = i; }
    } else {
      out.set(key, MIN_BID);
    }
  }
  // Rounding drift lands on the priciest player so the pool sums exactly. On
  // the decay curve that is always row 0 (weights are strictly decreasing), so
  // this is the same arithmetic it has always been.
  //
  // R30b — CONSERVATION YIELDS TO THE FLOOR when the two conflict, and only
  // then. In a shortfall room every pool row is already exactly MIN_BID, so
  // `total - allocated` is negative by construction; applying it here is what
  // used to turn the top player's $1 into negative dollars. The published pool
  // then sums to poolN x $1 (MORE than the room's money) — that overstatement
  // is deliberate and honest: $1 is the least any seat can legally cost, and
  // sellTo/maxBid still stop any team spending money it does not have. In every
  // adequately funded room (spread >= 0) the drift line runs unchanged and the
  // pool sums EXACTLY to the room's money, byte-for-byte as before.
  if (poolN > 0 && !shortfall) {
    const keyTop = String(rows[topIdx].gsis_id || `name:${rows[topIdx].name}`);
    out.set(keyTop, out.get(keyTop) + (total - allocated));
  }
  return out;
}

/**
 * OUR dollars from projections: VOR over the draftable pool. `pool` is an array
 * of {gsis_id, position}, adjOf(row) -> adjusted points. Replacement level per
 * position = the points of the last starter-demanded player league-wide.
 *
 * Starter demand and the replacement index are NOT computed here any more:
 * both come from app/team-logic.js (positionDemand + replacementIndex), which
 * is the same definition the fit engine's replacementLevel() uses when it is
 * given a shape. The classic W/R/T flex still spreads {RB .45, WR .45, TE .10}
 * — that spread now lives in team-logic's FLEX_WIN_SHARE, covering every flex
 * token instead of just this one. Returns Map(gsis_id -> $).
 */
export function fairDollars(pool, adjOf, leagueSize, budget, shape,
                            totalMoney = null) {
  const s = shape || rosterShape(null);
  const geo = rosterGeometry(s);
  const rosterSize = Number.isFinite(s.size) ? s.size : geo.all.length;
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of pool) {
    if (byPos[p.position]) byPos[p.position].push(p);
  }
  for (const pos of Object.keys(byPos)) {
    byPos[pos].sort((a, b) => adjOf(b) - adjOf(a));
  }
  const demandByPos = positionDemand(s);
  const repl = {};
  for (const pos of Object.keys(byPos)) {
    const idx = replacementIndex(demandByPos[pos] || 0, leagueSize);
    const arr = byPos[pos];
    repl[pos] = arr.length ? adjOf(arr[Math.min(idx, arr.length - 1)]) : 0;
  }
  const vor = new Map();
  let vorSum = 0;
  for (const p of pool) {
    // R27 — K and DEF are priced at the $1 TIER, deliberately.
    //
    // byPos above buckets only QB/RB/WR/TE, so repl['K'] is undefined and a
    // kicker's VOR would fall out as its FULL projection — around 140 points,
    // more than most running backs — handing kickers a large share of the
    // room's dollars. That is not a modelling subtlety, it is the well-known
    // fact that a kicker's replacement level is almost exactly the kicker
    // behind him: the position has real points and almost no VALUE OVER
    // REPLACEMENT, which is why real auctions buy them for $1 last.
    //
    // So they get zero VOR and land on the MIN_BID floor every other unpriced
    // player lands on. This is the owner's "late-round, $1 tier" call
    // (2026-08-14) and it is the honest model, not a shortcut: it says these
    // positions are worth the minimum, which is what the market says too.
    const v = repl[p.position] === undefined
      ? 0
      : Math.max(0, adjOf(p) - (repl[p.position] || 0));
    vor.set(String(p.gsis_id), v);
    if (v > 0) vorSum += v;
  }
  const poolN = Math.min(pool.length, leagueSize * rosterSize);
  // Same R27 note as marketDollars: OUR dollars are allocated over the money
  // actually in the room, so unequal team budgets price the board correctly.
  const money = Number.isFinite(totalMoney) ? totalMoney : leagueSize * budget;
  // R30b — same floor as marketDollars: a room whose money cannot cover $1 per
  // draftable seat used to distribute a NEGATIVE spread by VOR share, so the
  // BEST player carried the most negative price ('OURS $-1' on the block).
  // MIN_BID bounds every published dollar; an under-funded room prices the
  // whole board at the floor. fairDollars has never force-summed its pool
  // (rounding is per-row), so no conservation step needs a matching guard.
  const spread = Math.max(0, money - poolN * MIN_BID);
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

/**
 * ROOM MEMORY (auction-memory S2): per-position tendency priors seeded from
 * stored DRAFT HISTORY (app/mocks.js records), shrunk toward 1.0 by sample
 * size. Pure and deterministic — same records, same seeds; no Date, no rng.
 *
 * WHAT COUNTS AS EVIDENCE, exactly:
 *   - kind 'auction', play 'live', with a non-empty observed sale log. SIM
 *     rooms are excluded wholesale: their sales are this module's own
 *     opponentBid sampler, and a prior fitted to them measures our RNG, not
 *     your league (same circularity rule app/mocks.js roomCalibration
 *     enforces for snake drafts).
 *   - the same league size as the room being seeded. The overpay ratio is
 *     dimensionless (price and fair both scale with the room's money), so
 *     budget and roster differences do NOT disqualify a record — but a
 *     10-team room and a 14-team room are different scarcity regimes, and
 *     their prices are evidence about themselves.
 *   - opponent sales only. My own buys stay in the record (it is a
 *     transcript) but never in the evidence — measuring my own opinion back
 *     is not evidence, the same reason sellTo skips my tendency updates.
 *   - sales with a real price and a real fair value (>= MIN_BID each): a
 *     fair-less row is a player this app could not price, so its ratio would
 *     be a fabrication.
 *
 * THE RATIO IS price / OUR-fair-at-sale — observed dollars a real room paid
 * over this app's own opinion of worth. ESPN market values are display /
 * opponent-model-only (standing owner rule) and are not even PRESENT in the
 * stored shape (mocks.js strips them), so the seed is structurally incapable
 * of depending on them. Each ratio is clamped to TENDENCY_CLAMP before
 * averaging, the same bound the live update enforces, so one $40 sale on a $3
 * fair cannot own the whole seed.
 *
 * SHRINKAGE: seeded = (n·mean_ratio + K·1.0) / (n + K), K = TENDENCY_PRIOR_K
 * (see its comment for why 16). n=0 positions are simply absent — absent IS
 * the market prior (opponentBid treats a missing tendency as 1.0), and an
 * absent key is honest about "no evidence" in a way a stored 1.0 is not.
 *
 * SEEDING IS ROOM-WIDE PER POSITION, not per buyer slot — every opponent
 * opens at the same seeded prior. The stored log does carry the buyer slot,
 * so a per-manager seed ("T3 overpays RBs") is possible evidence-wise, but
 * slot identity across drafts is an assumption this app cannot verify (league
 * order changes year to year), and per-slot samples (~4 sales per slot per
 * position per draft) would be shrunk to nothing at any honest K. That
 * refinement is a stated REMAINDER of the epic, unlocked by this shape, not
 * shipped by it.
 *
 * RETURN — always the same shape, so the UI can be honest about whether
 * memory is active without special cases (surfacing it is S4, owned by the
 * caller; nothing here touches the DOM):
 *   { active, drafts, sales, tendencies: {POS: seeded}, byPosition:
 *     {POS: {n, observed, seeded}}, reason }
 * With no admissible history: active:false, tendencies:{} (every tendency
 * stays exactly the 1.0 market prior), and `reason` says why in words.
 */
export function seedTendencies(records, leagueSize) {
  const rows = Array.isArray(records) ? records : [];
  const byPos = new Map();
  let drafts = 0;          // records that contributed at least one sale
  let sales = 0;           // admissible opponent sales, all positions
  let liveHere = 0;        // LIVE auction records at THIS league size
  let liveElsewhere = 0;   // LIVE auction records at some other league size
  for (const r of rows) {
    if (!r || r.kind !== 'auction' || r.play !== 'live') continue;
    if (!Array.isArray(r.observed) || r.observed.length === 0) continue;
    if (Number(r.league_size) !== Number(leagueSize)) { liveElsewhere += 1; continue; }
    liveHere += 1;
    const mySlot = Number(r.my_slot);
    let counted = 0;
    for (const e of r.observed) {
      if (!e || !e.position) continue;
      if (Number.isFinite(mySlot) && Number(e.team) === mySlot) continue;
      const price = Number(e.price);
      const fair = Number(e.fair);
      if (!(price >= MIN_BID) || !(fair >= MIN_BID)) continue;
      const ratio = Math.min(TENDENCY_CLAMP[1],
        Math.max(TENDENCY_CLAMP[0], price / fair));
      const pos = String(e.position).toUpperCase();
      if (!byPos.has(pos)) byPos.set(pos, { n: 0, sum: 0 });
      const b = byPos.get(pos);
      b.n += 1;
      b.sum += ratio;
      counted += 1;
    }
    if (counted > 0) drafts += 1;
    sales += counted;
  }
  const out = {
    active: sales > 0,
    drafts,
    sales,
    tendencies: {},
    byPosition: {},
    reason: '',
  };
  if (sales === 0) {
    if (liveHere > 0) {
      out.reason = 'LIVE auction history at this league size holds no usable '
        + 'opponent sales (own buys and unpriced rows are not evidence) — '
        + 'every tendency starts at the market prior (1.0).';
    } else if (liveElsewhere > 0) {
      out.reason = `LIVE auction history exists only at other league sizes — a `
        + `${leagueSize}-team room seeds from ${leagueSize}-team evidence only, `
        + 'so every tendency starts at the market prior (1.0).';
    } else {
      out.reason = 'No LIVE auction recorded. Every tendency starts at the '
        + 'market prior (1.0). SIM rooms teach nothing about your league: '
        + 'their sales are this app’s own bidder talking to itself.';
    }
    return out;
  }
  // Sorted position keys so the same history always yields the same object,
  // key order included — determinism a caller can deepEqual.
  for (const pos of [...byPos.keys()].sort()) {
    const { n, sum } = byPos.get(pos);
    const observed = sum / n;
    const seeded = (n * observed + TENDENCY_PRIOR_K * 1.0) / (n + TENDENCY_PRIOR_K);
    out.tendencies[pos] = seeded;
    out.byPosition[pos] = { n, observed, seeded };
  }
  return out;
}

/** Positional slots a team still needs (mirror of draft-sim's opponentNeeds but
 * counting open capacity, since auctions fill rosters in any order).
 *
 * Capacity is read off the SHAPE, not off literal config fields: QB uses the
 * shape's derived cap (which is qb+1 for every shape the draft room can build,
 * and qb+2 for a SUPER_FLEX league), and RB/WR/TE get starters + flex + one
 * backup exactly as before. */
/* R30 — K/DEF/DST ARE POSITIONS THIS TABLE MUST NAME.
 *
 * The cap table below had four keys. R27 made K and DEF draftable and this was
 * not extended, so `caps[pos] || 0` read 0 for them and a kicker's entire
 * allowance collapsed to the bench-slack term, `max(0, bench - 4)`. At the
 * bench minimum of 4 that is ZERO, and the consequence was not a mispriced
 * kicker but a room that could never finish: for {qb1,rb2,wr2,te1,flex1,
 * bench4,k1,def1} the per-position capacity sums to 12 against a shape of 13,
 * so `total >= geo.all.length` is unreachable for EVERY team. autoNominate
 * eventually returns -1, team.js forces done, and the AUCTION RESULT card
 * scores a three-of-thirteen roster as if the draft had completed. 64 of the
 * 960 roster configs the settings grid can build were in this state — every
 * one of them a bench-4 config seating a K or a DEF.
 *
 * The bench-slack term is deliberately NOT applied to K/DEF/DST: it exists so
 * a deep bench can stockpile flex-eligible skill players, and nobody benches a
 * second kicker. Their cap is the shape's own derived cap, which is what
 * team-logic derivedCaps() has computed all along and this table simply never
 * read. DST is listed alongside DEF because the two spellings are both live —
 * a Sleeper league can seat either.
 */
function teamNeedsPos(team, pos, shape) {
  const counts = {};
  for (const p of team.players) counts[p.position] = (counts[p.position] || 0) + 1;
  const geo = rosterGeometry(shape);
  const nFlex = geo.flexSlots.length;
  const capFor = (k) => (geo.caps[k] != null ? geo.caps[k] : (geo.demand[k] || 0));
  const caps = {
    QB: geo.caps.QB != null ? geo.caps.QB : (geo.demand.QB || 0) + 1,
    RB: (geo.demand.RB || 0) + nFlex + 1,
    WR: (geo.demand.WR || 0) + nFlex + 1,
    TE: (geo.demand.TE || 0) + 1,
    K: capFor('K'),
    DEF: capFor('DEF'),
    DST: capFor('DST'),
  };
  const total = team.players.length;
  if (total >= geo.all.length) return false;
  // An UNFILLED STARTER SLOT is a need in its own right, ahead of any bench
  // arithmetic: a team that seats K1 and holds no kicker needs a kicker even
  // when every other cap says it is full. Without this the room treated a
  // kicker as generic bench slack — permitting two and demanding none.
  if ((counts[pos] || 0) < (geo.demand[pos] || 0)) return true;

  /* RESERVE THE LAST SEATS FOR THE STARTERS STILL OWED AT LATE POSITIONS.
   *
   * Gating only the NOMINATION was not enough, and the half-fix is instructive:
   * a team fills most of its roster by WINNING other teams' nominations, not by
   * nominating, so five of twelve teams still finished with a second tight end
   * where their DEF seat should have been. The refusal has to be here, in the
   * predicate both nomination and bidding consult.
   *
   * Once a team's open seats equal what it still owes at K/DEF/DST, nothing
   * else is a need. If the K/DST feed is missing entirely the board holds no
   * such player, the room runs out of legal nominations and stops — with every
   * other seat filled, and scoreAuction naming the holes. That is a worse
   * auction than one with a kicker feed, and an honest one; it is not the R30
   * deadlock, which stopped rooms at three of thirteen with a full board. */
  const isLate = LATE_POSITIONS.includes(pos);
  const lateOwed = LATE_POSITIONS.reduce(
    (s, k) => s + Math.max(0, (geo.demand[k] || 0) - (counts[k] || 0)), 0);
  if (lateOwed > 0 && (geo.all.length - total) <= lateOwed) return false;

  const benchSlack = isLate ? 0 : Math.max(0, geo.bench.length - 4);
  return (counts[pos] || 0) < (caps[pos] || 0) + benchSlack;
}

/**
 * An opponent's max willingness for the player on the block. Deterministic
 * given rng. Blends market price, that team's learned positional tendency, the
 * live inflation rate, and budget/need caps.
 */
function opponentBid(player, team, market, tendency, inflationRate, shape, rng) {
  if (!teamNeedsPos(team, player.position, shape)) return 0;
  const open = shape.size - team.players.length;
  const cap = maxBid(team.budget, open);
  if (cap < MIN_BID) return 0;
  const noise = 0.9 + rng() * 0.25;                  // 0.90 - 1.15
  const want = market * (tendency == null ? 1 : tendency) * inflationRate * noise;
  return Math.min(cap, Math.max(0, Math.round(want)));
}

/** Per-slot budget plan. 'stars' front-loads the top starters; 'balanced'
 * spreads evenly by slot value. Sums exactly to (budget - bench dollars) —
 * except in a budget too small to fund $1 per slot, where the $1 floor wins
 * over exact summation (see the R30b note below). */
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
  /* R30b — the drift lands on the top slot, and at the $10 minimum budget the
   * per-slot $1 floors alone can exceed the pool, making the drift negative
   * enough to push that slot below zero ('QB1 -$2 planned'). A planned price
   * can never be below the minimum legal bid: the floor wins, and a plan that
   * cannot fund $1 everywhere shows $1 everywhere rather than negative money.
   * For every budget that CAN fund the floors this clamp never engages and the
   * plan still sums exactly. */
  plan[0] = Math.max(MIN_BID, plan[0]);
  return { slots: shape.starters.map((name, i) => ({ slot: name, planned: plan[i] })),
           benchDollars };
}

/* --------------------------------------------------------------------------
 * Auction room state machine (sim AND live share it; live skips the opponent
 * model and applies observed sales via sellTo).
 * ------------------------------------------------------------------------ */

/**
 * Per-team starting budgets, normalised to exactly `leagueSize` finite dollar
 * amounts. Anything missing, non-numeric or negative falls back to the league
 * default — a typo in one team's box must not silently mint or destroy money
 * in the room, and it must never produce a NaN that would poison every
 * downstream price.
 *
 * R27: a league's teams do NOT necessarily start level. Preseason trades of
 * auction dollars are a common house rule, and until now the room could not
 * express one — every team was constructed with the same scalar, so a team you
 * knew had $185 was modelled at $200 and every threat estimate built from its
 * maxBid was wrong for the rest of the draft.
 */
export function normalizeTeamBudgets(teamBudgets, leagueSize, budget) {
  const fallback = Number.isFinite(budget) && budget >= 0 ? Math.round(budget) : DEFAULT_BUDGET;
  const src = Array.isArray(teamBudgets) ? teamBudgets : [];
  const out = [];
  for (let i = 0; i < leagueSize; i += 1) {
    const raw = src[i];
    // null / undefined / '' mean NOT STATED, and must fall back to the league
    // default — Number(null) is 0, which is finite and non-negative, so a bare
    // isFinite check silently seats a team with NO MONEY AT ALL and no way to
    // bid. "I have not said" and "this team has zero dollars" are different
    // claims and only one of them is ever what a blank box means.
    if (raw === null || raw === undefined || raw === '') { out.push(fallback); continue; }
    const v = Math.round(Number(raw));
    out.push(Number.isFinite(v) && v >= 0 ? v : fallback);
  }
  return out;
}

/** Total dollars in the room at kickoff — the SUM of the starting budgets. */
export function totalRoomMoney(a) {
  return (a.teamBudgets || []).reduce((s, b) => s + b, 0);
}

export function createAuction({
  leagueSize = 12, mySlot = 5, budget = DEFAULT_BUDGET, rosterConfig = null,
  boardRows = [], adjPointsById = new Map(), adpDollars = null, seed = 1,
  teamBudgets = null, history = null,
} = {}) {
  const shape = rosterShape(rosterConfig);
  // R30b — fold any DST-spelled rows to the engine's canonical DEF before the
  // board exists. rosterShape() only ever emits DEF slots, so a DST-spelled row
  // could be bought but never seated — fillStarters dropped its points and
  // reported DEF1 empty (see draft-sim.js canonicalizeBoardPositions). A board
  // with nothing to fold comes back as the same array, untouched.
  boardRows = canonicalizeBoardPositions(boardRows);
  const budgets = normalizeTeamBudgets(teamBudgets, leagueSize, budget);
  const money = budgets.reduce((s, b) => s + b, 0);
  const adjOf = (r) => {
    const v = r && r.gsis_id != null ? adjPointsById.get(String(r.gsis_id)) : null;
    return Number.isFinite(v) ? v : 0;
  };
  const fair = fairDollars(boardRows.filter((r) => r.gsis_id), adjOf,
    leagueSize, budget, shape, money);
  const market = adpDollars
    || marketDollars(boardRows, leagueSize, budget, shape.size, money);
  // Which market model the room is bidding off, so the UI can label it honestly
  // ('auction' = observed ESPN winning bids, 'adp' = the ADP decay transform).
  const marketSource = adpDollars ? 'given'
    : (hasPublishedPrices(boardRows) ? 'auction' : 'adp');
  let remainingFair = 0;
  for (const r of boardRows.filter((x) => x.gsis_id)) {
    remainingFair += fair.get(String(r.gsis_id)) || 0;
  }
  // ROOM MEMORY (auction-memory S2). `history` is the caller's stored DRAFT
  // HISTORY (app/mocks.js loadHistory()); seedTendencies decides for itself
  // what in it is admissible (LIVE auctions at this league size, opponent
  // sales only) and how hard to believe it (shrunk toward 1.0 by sample
  // size). Opponents open at the seeded prior; MY tendencies stay {} exactly
  // as before — the room never models me, live or seeded. Passing no history
  // is byte-identical to the pre-memory construction: memory.active is false
  // and every team opens at {}. `memory` rides on the room state so the UI
  // can say whether memory is active and on how many sales (S4 — surfacing
  // it is the caller's, nothing here renders).
  const memory = seedTendencies(history, leagueSize);
  return {
    kind: 'auction',
    leagueSize,
    mySlot,
    budget,          // the league default — what a team holds unless told otherwise
    teamBudgets: budgets,   // STARTING dollars per team; teams[i].budget is what is LEFT
    shape,
    adjOf,
    board: boardRows,
    taken: new Set(),
    fair,
    market,
    marketSource,
    remainingFair,
    teams: budgets.map((b, i) => ({
      budget: b,
      players: [],
      // Each opponent gets its OWN copy of the seed: tendencies mutate
      // per-team as sellTo learns, and a shared object would alias them all.
      tendencies: memory.active && i !== mySlot - 1 ? { ...memory.tendencies } : {},
    })),
    memory,
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

/* R30 — positions a real room defers to the very end of the draft. */
const LATE_POSITIONS = ['K', 'DEF', 'DST'];

/**
 * Opponent nomination model: best available by MARKET price among needs —
 * the consensus-driven room nominates the shiniest name it can roster.
 *
 * R30 — WITH ONE EXCEPTION, OR THE KICKER SEAT IS NEVER FILLED. Ranking purely
 * by market price cannot ever reach a kicker: K and DST carry no value over
 * replacement by design, so marketDollars floors them at $1, and the 182
 * nominatable offensive rows on the board cover all 180 roster slots before a
 * $1 row is ever the highest-priced thing available. Measured across seeds
 * 1/7/42/101/999/20260901 in a league seating K1 and DEF1: my team drafted a
 * kicker or a defence exactly ZERO times, the whole 12-team room took 2 kickers
 * and 0-2 defences of the 24 it owed, and the result card still announced
 * "BEAT THE ROOM BY 235.3 PTS · rank 1/12" for a roster that cannot legally be
 * started — because startersTotal() adds 0 for a slot it could not fill and
 * says nothing about it.
 *
 * So once a team's remaining roster space has shrunk to exactly the starters it
 * still owes at those positions, it stops deferring and nominates one. That is
 * how the seat actually gets filled, and it is also how humans draft: last,
 * but not never.
 *
 * The preference is deliberately NOT a hard restriction in teamNeedsPos. If the
 * K/DST feed is missing the board carries no kickers at all, and a hard rule
 * would leave every team unable to nominate anything — reintroducing the very
 * deadlock this release removes. Preferring-if-available degrades to the old
 * behaviour instead, and the unfilled slot is then reported rather than hidden.
 */
export function autoNominate(a) {
  const geo = rosterGeometry(a.shape);

  const forTeam = (team) => {
    const counts = {};
    for (const p of team.players) counts[p.position] = (counts[p.position] || 0) + 1;
    const lateOwed = LATE_POSITIONS.reduce(
      (s, k) => s + Math.max(0, (geo.demand[k] || 0) - (counts[k] || 0)), 0);
    const mustGoLate = lateOwed > 0
      && (geo.all.length - team.players.length) <= lateOwed;

    /* lateOnly restricts to a late position this team still OWES A STARTER at,
     * not merely to a late position. Ranking the late branch by market price
     * alone bought a second kicker (K prices above DST) and left the DEF seat
     * empty — the same hole in a different slot. */
    const pick = (lateOnly) => {
      let best = -1;
      let bestVal = -1;
      for (let i = 0; i < a.board.length; i += 1) {
        if (a.taken.has(i) || !a.board[i].gsis_id) continue;
        const pos = a.board[i].position;
        if (lateOnly) {
          if (!LATE_POSITIONS.includes(pos)) continue;
          if ((counts[pos] || 0) >= (geo.demand[pos] || 0)) continue;
        }
        if (!teamNeedsPos(team, pos, a.shape)) continue;
        const m = a.market.get(String(a.board[i].gsis_id)) || MIN_BID;
        if (m > bestVal) { bestVal = m; best = i; }
      }
      return best;
    };

    if (mustGoLate) {
      const late = pick(true);
      if (late !== -1) return late;
    }
    return pick(false);
  };

  /* ROTATE PAST A TEAM THAT CANNOT NOMINATE ANYTHING.
   *
   * onTheNomination() skips teams whose rosters are FULL; it cannot know that a
   * team with seats left has nothing legal to bid on. That case is real: with
   * the K/DST feed missing, a team holding its last two seats for an owed K and
   * DEF finds no such player on the board. Returning -1 from the team on the
   * clock stopped the ENTIRE room — measured at rosters of 2, 6 and 11 of 13
   * while the offensive board was still deep. Nobody else was blocked; one team
   * was. So the clock moves on, the rest of the room finishes, and -1 is
   * reserved for what it should always have meant: nobody can nominate
   * anything. The blocked seats are then reported by scoreAuction rather than
   * scored as a silent zero.
   *
   * When the board is complete the first hop always succeeds, so this is
   * identical to the previous behaviour for every healthy auction. */
  const start = onTheNomination(a);
  for (let hop = 0; hop < a.leagueSize; hop += 1) {
    const t = a.teams[(start + hop) % a.leagueSize];
    if (t.players.length >= a.shape.size) continue;
    const idx = forTeam(t);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function nominate(a, boardIdx) {
  a.block = { boardIdx };
}

/** Live inflation right now: every remaining room dollar vs remaining fair
 * value ($1-floor players carry ~$1 of fair value, so no reserve adjustment).
 *
 * R30b — A ROOM WITH NO SALES IS NEUTRAL, BY DEFINITION. Inflation is a claim
 * about how this room's money is chasing value, and before a single dollar has
 * moved there is no observation to base it on — the only honest prior is 1.00.
 * The raw ratio disagreed at kickoff because the denominator sums fair value
 * over the WHOLE board while the room's money only ever chases the draftable
 * pool: every $1-floor row past the pool cut inflates the denominator, so a
 * fresh 8-team room opened at -4% ("bargains ahead — money is scarce") and a
 * 2-team room at -28%, before anything had happened. The denominator itself is
 * left alone on purpose: the R30 verifier measured that re-seeding it from the
 * top-of-board pool cut lands at +2% (unpriced pool rows hold no fair entry),
 * i.e. it swaps a false "bargains ahead" for a false "selling rich" — and the
 * ratio converges anyway as sales drain both sides. undoLastSale pops the log,
 * so undoing the only sale honestly returns the room to neutral. */
export function liveInflation(a) {
  if (!a.log || a.log.length === 0) return 1;
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
  if (top < MIN_BID) {
    // Nobody bid: the player goes to the first rotation team that can still
    // afford the minimum AND has roster room; a fully drained room resolves
    // at $0 (sellTo clamps) so no phantom dollar is ever minted.
    for (let hop = 0; hop < a.leagueSize; hop += 1) {
      const t = (a.nomIdx + hop) % a.leagueSize;
      if (a.teams[t].budget >= MIN_BID
          && a.teams[t].players.length < a.shape.size) {
        return { winnerIdx: t, price: MIN_BID };
      }
    }
    return { winnerIdx: onTheNomination(a), price: 0 };
  }
  return { winnerIdx: winner, price: Math.max(MIN_BID, Math.min(top, second + 1)) };
}

/** Can this team still be sold a player? Roster room is the whole test: a team
 * at shape.size has nowhere to put him. Budget is NOT a test — a broke team can
 * still be handed a $0/$1 player, and sellTo clamps the price. */
export function canBuy(a, teamIdx) {
  const t = a.teams[teamIdx];
  return !!t && t.players.length < a.shape.size;
}

/** The teams a LIVE sale may legally be recorded against, as 0-based indices —
 * the buyer picker must be built from this, never from every team. */
export function buyerOptions(a) {
  const out = [];
  for (let t = 0; t < a.teams.length; t += 1) if (canBuy(a, t)) out.push(t);
  return out;
}

/** Apply a sale (sim resolution or LIVE observed sale). Updates budgets, the
 * winner's roster, room tendencies (the learning step), inflation base.
 *
 * REFUSES and returns null when the buyer's roster is already full (or the
 * team index is not real): a mis-tapped LIVE sale must not push a team past
 * shape.size, because every downstream number — needs, caps, inflation, the
 * final score — assumes a roster no bigger than the shape. Returns the auction
 * on success, as before. */
export function sellTo(a, teamIdx, price, boardIdx) {
  const row = a.board[boardIdx];
  const key = String(row.gsis_id || `name:${row.name}`);
  if (!canBuy(a, teamIdx)) return null;
  a.taken.add(boardIdx);
  const team = a.teams[teamIdx];
  // Money conservation is inviolable, and the clamp is the LEGAL one: a
  // recorded price can never exceed maxBid(), which reserves $1 for every
  // OTHER slot this team still has to fill (a bad LIVE entry clamps rather
  // than minting phantom dollars). Clamping to the whole budget — what this
  // did before R24-D — conserved money but produced a room no legal auction
  // can reach: a team at $0 with a dozen empty slots, which then skewed
  // liveInflation and every threat list built from maxBid. openSlots is read
  // BEFORE the push, so it counts the slot this sale fills. The clamped price
  // is what lands in the log, so undo and the spent/remaining invariant stay
  // exact.
  price = Math.max(0, Math.min(Math.round(price),
    maxBid(team.budget, a.shape.size - team.players.length)));
  team.budget = team.budget - price;
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
 * threats (teams that can and would go near that number).
 *
 * POLICY: `fair` is OUR opinion of worth and is MARKET-INVARIANT — pure VOR,
 * the same dollars on any board, whatever the room is paying.
 *
 * `adjusted` (= fair x inflation), `bidTo` and `cap` are ours too, but they are
 * LIVE: inflation is the room's remaining money over remaining fair value, and
 * `cap` comes off MY remaining budget. Both answer to what the room has
 * actually SPENT, and the room spends from the market — so two rooms handed
 * different market curves agree on `fair` and can legitimately differ on these
 * three. Saying otherwise (an earlier version of this comment claimed "no
 * market term anywhere in them") overstates the boundary: the boundary is that
 * the market cannot change what a player is WORTH, not that it cannot change
 * what a seat COSTS.
 *
 * `market` and `threats` are the ROOM, and `gap` (ours minus theirs) is the
 * actionable spread between the two: negative = the room is paying more than he
 * is worth to us, let him go. */
export function myGuidance(a, boardIdx, strategy = {}) {
  const row = a.board[boardIdx];
  const key = String(row.gsis_id || `name:${row.name}`);
  const me = myTeam(a);
  const open = a.shape.size - me.players.length;
  const cap = maxBid(me.budget, open);
  const needIt = teamNeedsPos(me, row.position, a.shape);
  const market = a.market.get(key) || MIN_BID;
  /* R30b — NO PROJECTION, NO PRICE. `fair` is built only from rows that carry a
   * gsis_id (createAuction), so a missing entry means this app holds NO opinion
   * of the player's worth — and `|| MIN_BID` used to turn "we have no opinion"
   * into "we say $1". That fabricated dollar flowed into `adjusted`, `bidTo`,
   * `gap` and classifyNomination, where any real market price cleared the BAIT
   * threshold: the block told the user 'MARKET OVERPRICES · LET THEM SPEND'
   * about a top-30 ADP player the app simply cannot value, while
   * nominationAdvice (below) correctly refuses to classify the same row. This
   * is the same honest degraded state, on the block: fair/adjusted/gap are
   * null (absent, not $0 and not $1), no classification, no advised bid, and
   * `reason` says why in words the UI can print. `market`, `cap` and `needIt`
   * remain — they are facts about the room and my roster, not about his worth. */
  if (!a.fair.has(key)) {
    return { fair: null, adjusted: null, bidTo: 0, cap, needIt, market,
             threats: [], class: null, gap: null, unpriced: true,
             reason: 'no projection — we cannot price this player',
             marketSource: a.marketSource };
  }
  const fair = a.fair.get(key) || MIN_BID;
  const infl = liveInflation(a);
  const adjusted = Math.round(fair * infl);
  const tempo = strategy.tempo === 'aggressive' ? 1.08 : 1.0;
  const bidTo = needIt ? Math.min(cap, Math.round(adjusted * tempo)) : 0;
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
  return { fair, adjusted, bidTo, cap, needIt, market, threats, class: cls,
           gap: fair - market, unpriced: false, marketSource: a.marketSource };
}

/** Nomination advice: my BAIT and TARGET lists among available players, plus a
 * concrete suggestion (bait early / neutral-big to drain, guided by strategy). */
export function nominationAdvice(a, strategy = {}, topN = 3) {
  const bait = [];
  const targets = [];
  for (let i = 0; i < a.board.length; i += 1) {
    if (a.taken.has(i)) continue;
    const row = a.board[i];
    // No projection -> no honest value gap. Unprojected players are neither
    // BAIT nor TARGET; they are unknowns and stay out of the advisor.
    if (!row.gsis_id) continue;
    const key = String(row.gsis_id);
    const fair = a.fair.get(key) || MIN_BID;
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
  // MY starting budget, not the league default — R27 lets them differ, and
  // spending $150 of $185 is not the same efficiency as $150 of $200.
  const myStart = (a.teamBudgets || [])[a.mySlot - 1];
  const spent = (Number.isFinite(myStart) ? myStart : a.budget) - myTeam(a).budget;
  // R30 — the starting slots I finished the auction unable to fill. `mine` adds
  // a silent 0 for each of them, so without this the sheet reads like a clean
  // win for a lineup that cannot legally be started.
  const emptySlots = fillStarters(mine, a.shape, a.adjOf).empty;
  return { ...sheet, spent, emptySlots,
    ptsPerDollar: spent > 0 ? Math.round((sheet.mine / spent) * 10) / 10 : 0 };
}

