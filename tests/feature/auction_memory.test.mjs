/* tests/feature/auction_memory.test.mjs — auction-memory S1 + S2, locked.
 *
 * S1: a finished LIVE auction persists the room's real sale log into DRAFT
 *     HISTORY — compact {gsis_id, position, team, price, fair} entries, my own
 *     buys included in the RECORD but never in the EVIDENCE. Round-trip:
 *     record -> stored shape -> reload, byte-honest.
 * S2: createAuction seeds opponent per-position tendencies from that stored
 *     LIVE history, shrunk toward the 1.0 market prior by sample size
 *     (posterior = (n·observed + K·1.0)/(n + K), K = TENDENCY_PRIOR_K).
 *
 * The honesty boundaries under test:
 *   - SIM history seeds NOTHING (a sim's sales are our own bidder);
 *   - ESPN market values seed NOTHING (display / opponent-model-only rule) —
 *     proven by seeding identical histories with and without market fields;
 *   - an OLD-shape history entry (pre-S1, no `observed`) loads cleanly and
 *     seeds nothing — no version bump, no migration loss;
 *   - empty memory reports itself in words (active:false + reason), never as
 *     a fabricated 1.0 "learned" tendency.
 *
 * Pure node:test against the pure modules — no DOM, no fetch, no Date.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAuction, sellTo, undoLastSale, myTeam, seedTendencies, tendencyUpdate,
  TENDENCY_PRIOR_K, MIN_BID,
} from '../../app/auction.js';
import {
  MOCKS_KEY, MOCKS_KEY_V1, HISTORY_VERSION, normalizeRecord, recordAuction,
  loadHistory, appendMock, historySummary,
} from '../../app/mocks.js';

const K = TENDENCY_PRIOR_K;

/* ---- fixtures (same idiom as auction.test.mjs) ------------------------------ */

function board(n = 80) {
  const positions = ['RB', 'WR', 'QB', 'TE'];
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      name: `P${i + 1}`, position: positions[i % 4], team: 'KC',
      adp: i + 1, gsis_id: `id-${i + 1}`,
    });
  }
  return rows;
}

const adjMap = (rows) => new Map(rows.map((r, i) => [String(r.gsis_id), 320 - i * 3.5]));

function newAuction(overrides = {}) {
  const rows = board();
  return createAuction({
    leagueSize: 4, mySlot: 2, budget: 200,
    rosterConfig: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 }, // 11 slots
    boardRows: rows, adjPointsById: adjMap(rows), seed: 11, ...overrides,
  });
}

function fakeStorage(seedData = {}) {
  const map = new Map(Object.entries(seedData));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A stored LIVE-auction history record (normalised, as loadHistory returns). */
function aucRecord(observed, over = {}) {
  return normalizeRecord({
    version: HISTORY_VERSION, created_utc: '2026-08-10T00:00:00.000Z',
    kind: 'auction', play: 'live', league_size: 4, my_slot: 2, budget: 200,
    roster_config: { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 4 },
    result: { margin: 1 }, my_players: [], observed, ...over,
  });
}

/** One observed sale. Buyer defaults to team 1 (an opponent of my_slot 2). */
const sale = (position, price, fair, team = 1, extra = {}) => ({
  gsis_id: `g-${position}-${price}-${fair}`, position, team, price, fair, ...extra,
});

const seeded = (n, observedRatio) => (n * observedRatio + K * 1.0) / (n + K);

/* ==========================================================================
 * S1 — persist the observed sale log (record -> stored shape -> reload)
 * ======================================================================== */

test('recordAuction(LIVE) persists the real sale log: gsis_id, position, buyer, price, fair-at-sale', () => {
  const a = newAuction();
  a.play = 'live';
  sellTo(a, 0, 47, 0);   // T1 buys RB id-1
  sellTo(a, 1, 30, 1);   // MY buy (slot 2), WR id-2 — stays in the record
  sellTo(a, 2, 12, 2);   // T3 buys QB id-3
  const rec = recordAuction(a, { margin: 1 }, myTeam(a).players, '2026-09-02T00:00:00.000Z');

  assert.equal(rec.kind, 'auction');
  assert.equal(rec.play, 'live');
  assert.equal(rec.observed.length, 3, 'one entry per sale, nothing thrown away');
  assert.deepEqual(rec.observed, [
    { gsis_id: 'id-1', position: 'RB', team: 1, price: 47, fair: a.fair.get('id-1') },
    { gsis_id: 'id-2', position: 'WR', team: 2, price: 30, fair: a.fair.get('id-2') },
    { gsis_id: 'id-3', position: 'QB', team: 3, price: 12, fair: a.fair.get('id-3') },
  ]);
});

test('recordAuction(SIM) stores NO sale log — a sim room is our own bidder', () => {
  const a = newAuction();
  a.play = 'sim';
  sellTo(a, 0, 47, 0);
  const rec = recordAuction(a, { margin: 1 }, [], 'x');
  assert.equal(rec.play, 'sim');
  assert.deepEqual(rec.observed, []);
});

test('round-trip: record -> appendMock -> loadHistory returns the identical sale log', () => {
  const a = newAuction();
  a.play = 'live';
  sellTo(a, 0, 47, 0);
  sellTo(a, 2, 12, 2);
  const rec = recordAuction(a, { margin: 1 }, [], '2026-09-02T00:00:00.000Z');
  const store = fakeStorage();
  appendMock(rec, store);
  const rows = loadHistory(store);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].observed, rec.observed);

  // Storage budget: the stored sale entries are the five essentials only —
  // no player names, no market dollars, no whole player objects.
  const raw = store.getItem(MOCKS_KEY);
  assert.ok(!raw.includes('"market"'), 'market dollars must not be stored');
  const storedSale = JSON.parse(raw)[0].observed[0];
  assert.deepEqual(Object.keys(storedSale).sort(),
    ['fair', 'gsis_id', 'position', 'price', 'team']);
});

test('a reloaded log seeds the next room: opponent sales count, my own buys never do', () => {
  const a = newAuction();
  a.play = 'live';
  sellTo(a, 0, 47, 0);   // T1, RB — evidence
  sellTo(a, 1, 30, 1);   // me, WR — record only
  sellTo(a, 2, 12, 2);   // T3, QB — evidence
  const store = fakeStorage();
  appendMock(recordAuction(a, { margin: 1 }, [], 't'), store);

  const seed = seedTendencies(loadHistory(store), 4);
  assert.equal(seed.active, true);
  assert.equal(seed.drafts, 1);
  assert.equal(seed.sales, 2, 'my WR buy is not evidence');
  assert.ok(!('WR' in seed.tendencies), 'nothing learned about WR from my own buy');
  assert.equal(seed.byPosition.RB.n, 1);
  assert.equal(seed.byPosition.QB.n, 1);
});

test('historySummary counts auction sales separately from snake picks', () => {
  const a = newAuction();
  a.play = 'live';
  sellTo(a, 0, 47, 0);
  sellTo(a, 2, 12, 2);
  const s = historySummary([recordAuction(a, {}, [], 't')]);
  assert.equal(s.auction, 1);
  assert.equal(s.observed_sales, 2);
  assert.equal(s.observed_picks, 0, 'a sale is not a pick');
});

/* ==========================================================================
 * S2 — shrinkage math: n = 0 / small / large, clamped ratios
 * ======================================================================== */

test('n=0: a position with no observed sales is ABSENT, i.e. exactly the 1.0 prior', () => {
  const seed = seedTendencies([aucRecord([sale('RB', 15, 10)])], 4);
  assert.equal(seed.active, true);
  assert.ok(!('TE' in seed.tendencies));
  assert.ok(!('TE' in seed.byPosition));
});

test('small n barely moves the prior: 2 sales at ratio 1.5 seed ~1.056, not 1.5', () => {
  const seed = seedTendencies(
    [aucRecord([sale('RB', 15, 10), sale('RB', 30, 20, 3)])], 4);
  assert.equal(seed.byPosition.RB.n, 2);
  assert.equal(seed.byPosition.RB.observed, 1.5);
  assert.equal(seed.tendencies.RB, seeded(2, 1.5));           // (2·1.5 + K)/(2+K)
  assert.ok(Math.abs(seed.tendencies.RB - 1) < 0.06,
    `two observations must barely move 1.0 (got ${seed.tendencies.RB})`);
});

test('large n earns real weight: 64 sales at ratio 1.4 seed ~1.32', () => {
  const sales = [];
  for (let i = 0; i < 64; i += 1) sales.push(sale('WR', 14, 10, 1 + (i % 2) * 2));
  const seed = seedTendencies([aucRecord(sales)], 4);
  assert.equal(seed.byPosition.WR.n, 64);
  assert.ok(Math.abs(seed.tendencies.WR - seeded(64, 1.4)) < 1e-9);
  assert.ok(Math.abs(seed.tendencies.WR - 1.32) < 1e-9);
  assert.ok(seed.tendencies.WR > seeded(2, 1.4),
    'more evidence, more movement toward the observed ratio');
});

test('each ratio is clamped before averaging: one $40 sale on a $2 fair cannot own the seed', () => {
  const seed = seedTendencies([aucRecord([sale('QB', 40, 2)])], 4);
  // ratio 20 clamps to 1.6 (the live TENDENCY_CLAMP ceiling), then shrinks.
  assert.equal(seed.byPosition.QB.observed, 1.6);
  assert.equal(seed.tendencies.QB, seeded(1, 1.6));
});

test('evidence floors: $0 handouts and fair-less rows are recorded but never evidence', () => {
  const rec = aucRecord([
    sale('RB', 0, 10),            // a $0 allocation is not a bid
    { gsis_id: 'g-x', position: 'RB', team: 1, price: 20, fair: null }, // unpriced by us
    sale('RB', 12, 10),           // the one real observation
  ]);
  assert.equal(rec.observed.length, 3, 'the record keeps all three — it is a transcript');
  const seed = seedTendencies([rec], 4);
  assert.equal(seed.sales, 1);
  assert.equal(seed.byPosition.RB.n, 1);
  assert.equal(seed.byPosition.RB.observed, 1.2);
});

test('determinism: same stored history, same seeds — deepEqual, key order included', () => {
  const hist = [aucRecord([sale('RB', 15, 10), sale('QB', 8, 10, 3), sale('WR', 22, 20, 4)])];
  assert.deepEqual(seedTendencies(hist, 4), seedTendencies(hist, 4));
});

/* ==========================================================================
 * S2 — the SIM exclusion and the league-shape gate
 * ======================================================================== */

test('SIM history seeds NOTHING, and the empty return says so in words', () => {
  // Through the normalizer a sim record cannot even carry a log…
  const simRec = aucRecord([sale('RB', 15, 10)], { play: 'sim' });
  assert.deepEqual(simRec.observed, []);
  const seed = seedTendencies([simRec], 4);
  assert.equal(seed.active, false);
  assert.deepEqual(seed.tendencies, {});
  assert.match(seed.reason, /SIM|no live/i);

  // …and even a raw un-normalized sim row (defensive path) is refused.
  const rawSim = { kind: 'auction', play: 'sim', league_size: 4, my_slot: 2,
    observed: [sale('RB', 15, 10)] };
  assert.equal(seedTendencies([rawSim], 4).active, false);
});

test('mixed history: only the LIVE records are evidence', () => {
  const live = aucRecord([sale('RB', 15, 10)]);
  const rawSim = { kind: 'auction', play: 'sim', league_size: 4, my_slot: 2,
    observed: [sale('RB', 60, 10), sale('RB', 60, 10), sale('RB', 60, 10)] };
  assert.deepEqual(seedTendencies([rawSim, live, rawSim], 4),
    seedTendencies([live], 4));
});

test('no history at all: tendencies stay exactly 1.0 and the return is honest about it', () => {
  for (const hist of [null, undefined, [], 'garbage']) {
    const seed = seedTendencies(hist, 4);
    assert.equal(seed.active, false);
    assert.equal(seed.drafts, 0);
    assert.equal(seed.sales, 0);
    assert.deepEqual(seed.tendencies, {});
    assert.deepEqual(seed.byPosition, {});
    assert.ok(seed.reason.length > 0, 'empty memory must explain itself');
  }
});

test('a different league size is a different room: its prices do not seed this one', () => {
  const seed = seedTendencies([aucRecord([sale('RB', 15, 10)])], 12);
  assert.equal(seed.active, false);
  assert.match(seed.reason, /league size/i);
});

/* ==========================================================================
 * S2 — the market-price exclusion, proven structurally
 * ======================================================================== */

test('a seeded tendency is IDENTICAL whether or not market values are present in history', () => {
  const clean = [aucRecord([sale('RB', 15, 10), sale('WR', 22, 20, 3)])];
  // Same sales, but smuggling market fields into the raw (un-normalized)
  // entries — a hostile / future shape the seeding path must never read.
  const smuggled = [{
    version: HISTORY_VERSION, kind: 'auction', play: 'live',
    league_size: 4, my_slot: 2,
    observed: [
      sale('RB', 15, 10, 1, { market: 99, auction_value: 99 }),
      sale('WR', 22, 20, 3, { market: 1, auction_value: 1 }),
    ],
  }];
  assert.deepEqual(seedTendencies(smuggled, 4), seedTendencies(clean, 4));
});

test('the normalizer strips market fields, so they cannot even reach storage', () => {
  const rec = aucRecord([sale('RB', 15, 10, 1, { market: 99, auction_value: 99, name: 'P1' })]);
  assert.deepEqual(Object.keys(rec.observed[0]).sort(),
    ['fair', 'gsis_id', 'position', 'price', 'team']);
  assert.ok(!JSON.stringify(rec).includes('99'));
});

/* ==========================================================================
 * Storage-shape migration — old histories load cleanly and seed nothing
 * ======================================================================== */

test('an OLD-shape v2 auction record (pre-S1, no `observed`) loads cleanly and seeds nothing', () => {
  const oldShape = {
    version: HISTORY_VERSION, created_utc: '2026-08-01T00:00:00.000Z',
    kind: 'auction', play: 'live', league_size: 4, my_slot: 2, budget: 200,
    roster_config: {}, result: { margin: 3, spent: 198 },
    my_players: [{ gsis_id: '00-2', name: 'B Wide', position: 'WR' }],
    // no `observed` key at all — exactly what recordAuction wrote before S1
  };
  const store = fakeStorage({ [MOCKS_KEY]: JSON.stringify([oldShape]) });
  const rows = loadHistory(store);
  assert.equal(rows.length, 1, 'the old record is never dropped');
  assert.deepEqual(rows[0].observed, []);
  assert.equal(rows[0].result.spent, 198, 'nothing else about the record changes');
  const seed = seedTendencies(rows, 4);
  assert.equal(seed.active, false);
  assert.deepEqual(seed.tendencies, {});
});

test('a legacy v1 auction row still migrates with an empty log and seeds nothing', () => {
  const v1 = {
    created_utc: '2026-08-02T00:00:00.000Z', kind: 'auction', play: 'live',
    league_size: 4, budget: 200, result: { margin: 1 }, my_players: [],
  };
  const store = fakeStorage({ [MOCKS_KEY_V1]: JSON.stringify([v1]) });
  const rows = loadHistory(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].migrated_from, MOCKS_KEY_V1);
  assert.deepEqual(rows[0].observed, []);
  assert.equal(seedTendencies(rows, 4).active, false);
});

/* ==========================================================================
 * createAuction wiring — the seed lands where the room actually learns
 * ======================================================================== */

test('createAuction(history): opponents open at the seeded prior, I stay unmodelled', () => {
  const sales = [];
  for (let i = 0; i < 8; i += 1) sales.push(sale('RB', 15, 10, 1 + (i % 2) * 2));
  const hist = [aucRecord(sales)];
  const want = seeded(8, 1.5);                       // (8·1.5 + K)/(8 + K)

  const a = newAuction({ history: hist });
  assert.equal(a.memory.active, true);
  assert.equal(a.memory.byPosition.RB.n, 8);
  for (const t of [0, 2, 3]) {
    assert.equal(a.teams[t].tendencies.RB, want, `opponent T${t + 1} seeded`);
  }
  assert.deepEqual(myTeam(a).tendencies, {}, 'the room never models me');
  // Per-team copies, not one aliased object: learning about T1 is not
  // learning about T3.
  a.teams[0].tendencies.RB = 9;
  assert.equal(a.teams[2].tendencies.RB, want);
});

test('createAuction without history is the pre-memory room: {} tendencies, inactive memory', () => {
  const a = newAuction();
  assert.equal(a.memory.active, false);
  assert.ok(a.memory.reason.length > 0);
  for (const t of a.teams) assert.deepEqual(t.tendencies, {});
});

test('createAuction seeding is deterministic across constructions', () => {
  const hist = [aucRecord([sale('RB', 15, 10), sale('QB', 8, 10, 3)])];
  const a1 = newAuction({ history: hist });
  const a2 = newAuction({ history: hist });
  assert.deepEqual(a1.memory, a2.memory);
  assert.deepEqual(a1.teams.map((t) => t.tendencies), a2.teams.map((t) => t.tendencies));
});

test('in-room learning continues FROM the seed, and undo restores it exactly', () => {
  const sales = [];
  for (let i = 0; i < 8; i += 1) sales.push(sale('RB', 15, 10));
  const a = newAuction({ history: [aucRecord(sales)] });
  const seedVal = a.teams[0].tendencies.RB;
  assert.ok(seedVal > 1 && seedVal >= MIN_BID / 100); // sanity: a real prior

  sellTo(a, 0, 60, 0);                                // T1 buys RB id-1 at $60
  const market = a.market.get('id-1');
  assert.equal(a.teams[0].tendencies.RB, tendencyUpdate(seedVal, 60, market),
    'the live EW update starts from the seeded prior, not from 1.0');

  undoLastSale(a);
  assert.equal(a.teams[0].tendencies.RB, seedVal,
    'undo restores the seeded prior, not a deleted key');
});
