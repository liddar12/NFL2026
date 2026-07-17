/* tests/feature/team_vor.test.mjs - VOR "BEST PICK NOW" acceptance criteria.
 *
 * Locks the pure VOR additions in app/team-logic.js:
 *   - replacementLevel(): the (starterDemand+1)th best available at a position,
 *     with the FLEX absorbed as +1 demand on the best of RB/WR/TE,
 *   - vorScore(): adjusted points minus own-position replacement level,
 *   - bestPickNow(): top-3 by VOR, excluding rostered + capped positions,
 *     re-ranking against a taken-filtered pool, with real reason sentences
 *     (the VOR line always, the scarcity line when supply <= 3),
 *   - determinism (two identical runs return identical output).
 *
 * Pure functions -> imported directly under node, no DOM. Deterministic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STARTER_DEMAND,
  VOR_SCARCITY_MAX,
  replacementLevel,
  vorScore,
  bestPickNow,
} from '../../app/team-logic.js';

const WEEKS = 18;

/* ---- fixtures (mirror team_rel2.test.mjs) ---------------------------------- */

function mkWeekly(id, byeWk, perWeekPts, rec = 0) {
  const weeks = [];
  for (let wk = 1; wk <= WEEKS; wk += 1) {
    const bye = wk === byeWk;
    weeks.push({ wk, opp: bye ? null : 'OPP', home: wk % 2 === 0, bye, pts: bye ? 0 : perWeekPts });
  }
  return { gsis_id: id, receptions_prior: rec, weeks };
}

function mkPlayer(id, name, team, position, proj) {
  return { gsis_id: id, name, team, position, proj_points: proj, low: proj * 0.7, high: proj * 1.3, signals_used: [] };
}

function lookup(entries) {
  const m = new Map(entries.map((e) => [String(e.gsis_id), e]));
  const o = Object.fromEntries(m);
  Object.defineProperty(o, 'get', { value: (k) => m.get(String(k)) });
  Object.defineProperty(o, 'has', { value: (k) => m.has(String(k)) });
  return o;
}

const SLOT_KEYS = ['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX', 'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6'];
function roster(fill = {}) {
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = null;
  return { slots: { ...slots, ...fill } };
}

/** A synthetic pool with known per-position point ladders. RBs top the board,
 * so the FLEX absorbs into RB (+1 demand there). */
function mkPool() {
  return [
    mkPlayer('qb1', 'QB One', 'KC', 'QB', 300),
    mkPlayer('qb2', 'QB Two', 'BUF', 'QB', 290),
    mkPlayer('qb3', 'QB Three', 'PHI', 'QB', 280),
    mkPlayer('rb1', 'RB One', 'SF', 'RB', 320),
    mkPlayer('rb2', 'RB Two', 'DAL', 'RB', 250),
    mkPlayer('rb3', 'RB Three', 'DET', 'RB', 240),
    mkPlayer('rb4', 'RB Four', 'NYG', 'RB', 220),
    mkPlayer('rb5', 'RB Five', 'CHI', 'RB', 210),
    mkPlayer('wr1', 'WR One', 'MIA', 'WR', 260),
    mkPlayer('wr2', 'WR Two', 'CIN', 'WR', 230),
    mkPlayer('wr3', 'WR Three', 'MIN', 'WR', 200),
    mkPlayer('wr4', 'WR Four', 'SEA', 'WR', 190),
    mkPlayer('te1', 'TE One', 'KC', 'TE', 180),
    mkPlayer('te2', 'TE Two', 'BAL', 'TE', 120),
    mkPlayer('te3', 'TE Three', 'LV', 'TE', 110),
  ];
}

function mkWeeklyMap(pool) {
  return lookup(pool.map((p) => mkWeekly(p.gsis_id, 0, p.proj_points / WEEKS)));
}

/* ---- replacementLevel ------------------------------------------------------- */

test('STARTER_DEMAND contract: QB 1, RB 2, WR 2, TE 1', () => {
  assert.deepEqual({ ...STARTER_DEMAND }, { QB: 1, RB: 2, WR: 2, TE: 1 });
});

test('replacementLevel: (demand+1)th best; FLEX adds +1 to the best RB/WR/TE position', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  // QB demand 1 -> replacement = 2nd best QB (290).
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'QB'), 290);
  // RB owns the best available player (rb1 320) so the FLEX absorbs into RB:
  // demand 2+1 -> replacement = 4th best RB (220).
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'RB'), 220);
  // WR demand 2 (no FLEX bump) -> replacement = 3rd best WR (200).
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'WR'), 200);
  // TE demand 1 -> replacement = 2nd best TE (120).
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'TE'), 120);
});

test('replacementLevel: fewer than demand+1 available -> 0; unmodeled -> 0', () => {
  const pool = [mkPlayer('qb1', 'QB One', 'KC', 'QB', 300)];
  const weekly = mkWeeklyMap(pool);
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'QB'), 0, 'no replacement exists');
  assert.equal(replacementLevel(pool, weekly, 'ppr', 'K'), 0, 'unmodeled position is 0');
});

/* ---- vorScore ---------------------------------------------------------------- */

test('vorScore: adjusted points minus own-position replacement level', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  const qb1 = pool.find((p) => p.gsis_id === 'qb1');
  const rb1 = pool.find((p) => p.gsis_id === 'rb1');
  const te1 = pool.find((p) => p.gsis_id === 'te1');
  assert.equal(vorScore(qb1, pool, weekly, 'ppr'), 10, '300 - 290');
  assert.equal(vorScore(rb1, pool, weekly, 'ppr'), 100, '320 - 220 (FLEX-bumped RB demand)');
  assert.equal(vorScore(te1, pool, weekly, 'ppr'), 60, '180 - 120');
});

test('vorScore: honors the scoring mode via receptions_prior', () => {
  const wr = mkPlayer('wr-a', 'WR A', 'MIA', 'WR', 200);
  const wrB = mkPlayer('wr-b', 'WR B', 'CIN', 'WR', 190);
  const wrC = mkPlayer('wr-c', 'WR C', 'MIN', 'WR', 150);
  const wrD = mkPlayer('wr-d', 'WR D', 'SEA', 'WR', 140);
  const rb = mkPlayer('rb-a', 'RB A', 'SF', 'RB', 210); // best player -> FLEX to RB
  const pool = [wr, wrB, wrC, wrD, rb];
  // wr-a caught 100 balls, everyone else 0 -> std drops wr-a by 100.
  const weekly = lookup([
    mkWeekly('wr-a', 0, 200 / WEEKS, 100), mkWeekly('wr-b', 0, 190 / WEEKS),
    mkWeekly('wr-c', 0, 150 / WEEKS), mkWeekly('wr-d', 0, 140 / WEEKS),
    mkWeekly('rb-a', 0, 210 / WEEKS),
  ]);
  // PPR: 200 - 150 (3rd WR at ppr) = 50. STD re-ranks the WRs too (wr-a drops
  // to 100): 190/150/140/100 -> 3rd WR is now 140, so (200-100) - 140 = -40.
  assert.equal(vorScore(wr, pool, weekly, 'ppr'), 50);
  assert.equal(vorScore(wr, pool, weekly, 'std'), -40);
});

/* ---- bestPickNow ------------------------------------------------------------- */

test('bestPickNow: top-3 by VOR desc with real reason sentences', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  const picks = bestPickNow(roster(), pool, weekly, 'ppr');
  assert.equal(picks.length, 3);
  // rb1 has the biggest VOR (100) and must lead the strip.
  assert.equal(picks[0].player.gsis_id, 'rb1');
  assert.equal(picks[0].vor, 100);
  assert.equal(picks[0].replacement, 220);
  // VOR desc across the strip.
  assert.ok(picks[0].vor >= picks[1].vor && picks[1].vor >= picks[2].vor);
  for (const r of picks) {
    assert.ok(Array.isArray(r.reasons) && r.reasons.length >= 1);
    assert.match(r.reasons[0],
      /^Best value over replacement: [+-]\d+\.\d pts vs the next-best available (QB|RB|WR|TE)$/);
  }
});

test('bestPickNow: excludes rostered players and replacement re-levels without them', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  const r = roster({ RB1: 'rb1' });
  const picks = bestPickNow(r, pool, weekly, 'ppr');
  const ids = picks.map((p) => String(p.player.gsis_id));
  assert.ok(!ids.includes('rb1'), 'rostered players never appear');
  // With rb1 gone the best available is wr1 (260) -> FLEX absorbs into WR:
  // WR replacement = 4th WR (190); RB replacement = 3rd remaining RB (220).
  const wrPick = picks.find((p) => p.player.gsis_id === 'wr1');
  assert.ok(wrPick, 'wr1 leads once rb1 is rostered');
  assert.equal(wrPick.replacement, 190, 'replacement recomputed from the available pool');
});

test('bestPickNow: a capped position (2 QBs rostered) is never proposed', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  const r = roster({ QB1: 'qb1', BN1: 'qb2' });
  const picks = bestPickNow(r, pool, weekly, 'ppr');
  assert.ok(picks.length > 0);
  assert.ok(picks.every((p) => String(p.player.position).toUpperCase() !== 'QB'),
    'no 3rd QB once the QB cap is hit');
});

test('bestPickNow: respects a taken-filtered pool (re-ranks as players go)', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  const before = bestPickNow(roster(), pool, weekly, 'ppr');
  assert.equal(before[0].player.gsis_id, 'rb1');
  // Simulate the draft board: rb1 taken by another manager -> filtered pool.
  const filtered = pool.filter((p) => p.gsis_id !== 'rb1');
  const after = bestPickNow(roster(), filtered, weekly, 'ppr');
  assert.ok(!after.map((p) => String(p.player.gsis_id)).includes('rb1'),
    'a taken player never surfaces');
  assert.notEqual(after[0].player.gsis_id, 'rb1');
});

test('bestPickNow: scarcity reason fires when above-replacement supply <= 3', () => {
  assert.equal(VOR_SCARCITY_MAX, 3);
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  // TE startable supply (at or above the 120 replacement) is 2 (te1, te2) ->
  // scarce. TE is not in the top 3 by VOR, so widen the strip to find it.
  const wide = bestPickNow(roster(), pool, weekly, 'ppr', { limit: 15 });
  const te = wide.find((p) => p.player.gsis_id === 'te1');
  assert.ok(te, 'te1 present in the widened strip');
  assert.equal(te.reasons.length, 2);
  assert.equal(te.reasons[1], 'Only 2 startable TEs left - position is drying up');
  // Any scarcity line, wherever it fires, is the exact contract sentence.
  for (const p of wide) {
    if (p.reasons.length > 1) {
      assert.match(p.reasons[1], /^Only \d+ startable (QB|RB|WR|TE)s left - position is drying up$/);
    }
  }
});

test('bestPickNow: no scarcity line when a position is deep above replacement', () => {
  // RB is FLEX-bumped (demand 3): replacement = 4th RB (270); startable
  // supply at or above it = 4 (rbA..rbD) -> 4 > 3, no scarcity line.
  const pool = [
    mkPlayer('rbA', 'RB A', 'SF', 'RB', 300),
    mkPlayer('rbB', 'RB B', 'DAL', 'RB', 290),
    mkPlayer('rbC', 'RB C', 'DET', 'RB', 280),
    mkPlayer('rbD', 'RB D', 'NYG', 'RB', 270),
    mkPlayer('rbE', 'RB E', 'CHI', 'RB', 150),
    mkPlayer('rbF', 'RB F', 'GB', 'RB', 140),
    mkPlayer('qbA', 'QB A', 'KC', 'QB', 200),
    mkPlayer('qbB', 'QB B', 'BUF', 'QB', 190),
  ];
  const weekly = mkWeeklyMap(pool);
  const picks = bestPickNow(roster(), pool, weekly, 'ppr');
  const rbTop = picks.find((p) => p.player.gsis_id === 'rbA');
  assert.ok(rbTop, 'the deep position still leads by VOR');
  assert.equal(rbTop.reasons.length, 1, 'no scarcity line when supply exceeds the threshold');
});

test('bestPickNow: deterministic (two runs byte-identical) and pure (no pool mutation)', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  const snapshot = JSON.stringify(pool);
  const a = bestPickNow(roster({ QB1: 'qb1' }), pool, weekly, 'ppr');
  const b = bestPickNow(roster({ QB1: 'qb1' }), pool, weekly, 'ppr');
  assert.deepEqual(a, b, 'identical inputs -> identical output');
  assert.equal(JSON.stringify(pool), snapshot, 'input pool is not mutated');
});

test('bestPickNow: full roster -> no open slot -> empty strip', () => {
  const pool = mkPool();
  const weekly = mkWeeklyMap(pool);
  // Fill every slot with distinct ids (pool has 15 players, 13 slots).
  const distinct = {};
  SLOT_KEYS.forEach((k, i) => { distinct[k] = String(pool[i].gsis_id); });
  const picks = bestPickNow(roster(distinct), pool, weekly, 'ppr');
  assert.deepEqual(picks, []);
});
