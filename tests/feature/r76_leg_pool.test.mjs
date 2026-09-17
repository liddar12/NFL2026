/* tests/feature/r76_leg_pool.test.mjs — R76 MY PARLAYS candidate leg pool, locked.
 *
 * The shipped slate prices 48 prop legs: the top QB, RB and WR in each game at
 * one fixed line. My Parlays has to answer for ANY player the user types, so it
 * prices ~245 across a ladder. Two things make that safe, and this file exists to
 * keep them true:
 *
 *   1. THE SHIPPED SLATE CANNOT MOVE. The pool has its own calibration, its own
 *      artifact and its own gate. data/parlays.json and its calibration are never
 *      written by the pool path, so week-to-week EV on the slate is structurally
 *      unaffected — not merely unaffected today.
 *   2. NOTHING IS PRICED BY EXTRAPOLATION. A rung ships only when its z sits
 *      inside the z range the corpus actually covers. Measured, the rungs outside
 *      it are where the model knows least (WR: skill +0.013, ECE 0.133 against
 *      +0.126 / 0.092 inside), so offering them would mean confident numbers for
 *      questions the model has never been asked.
 *
 * Also locked: probabilities fall as the line rises (a longer line can never be
 * MORE likely), no market number reaches model_prob, game legs are verbatim
 * copies of the slate's, and the calibration gate refuses a well-calibrated coin
 * flip — the case that broke its first draft.
 *
 * Node built-ins only; the Python cores are driven through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const has = (p) => existsSync(join(ROOT, p));

const OPTIONAL = ['data/leg_pool.json', 'data/leg_pool_backtest.json'];
const present = OPTIONAL.every(has);

/* 1 — the guarantee that the shipped slate cannot move ------------------------ */

test('the pool has its OWN calibration; the slate keeps its own', () => {
  if (!present) return;
  const pool = readJson('data/leg_pool_backtest.json');
  const slate = readJson('data/parlay_backtest.json').props;
  for (const pos of ['QB', 'RB', 'WR']) {
    const a = pool.calibration[pos];
    const b = slate.calibration[pos];
    assert.ok(a && b, pos);
    // genuinely different fits — if these ever coincide, one of the two gates is
    // reading the other's corpus and the separation has quietly collapsed.
    assert.notDeepEqual(
      [a.a, a.b, a.c].map((x) => Math.round(x * 1e4)),
      [b.a, b.b, b.c].map((x) => Math.round(x * 1e4)),
      `${pos}: pool and slate calibrations are identical`);
  }
  assert.match(pool.note, /parlays\.json/);
});

test('the pool builder never writes the slate or its calibration', () => {
  const src = readFileSync(join(ROOT, 'scripts/build_leg_pool.py'), 'utf8');
  // it may READ parlays.json (game legs are copied from it) but must not open it
  // for writing, and must never touch the slate's calibration artifact.
  assert.ok(!/parlay_backtest\.json["']?\s*,?\s*["']w/.test(src));
  const writes = [...src.matchAll(/open\(([^)]*?),\s*["']w["']/g)].map((m) => m[1]);
  for (const w of writes) {
    assert.ok(/OUT/.test(w), `writes to something other than OUT: ${w}`);
  }
  assert.equal(writes.length, 1, 'exactly one write target');
});

/* 2 — nothing is priced by extrapolation ------------------------------------- */

test('every shipped rung sits inside the fitted support', () => {
  if (!present) return;
  const pool = readJson('data/leg_pool.json');
  assert.ok(pool.players.length > 100, `${pool.players.length} players`);
  for (const p of pool.players) {
    const [lo, hi] = pool.support[p.position];
    const sd = pool.residual_sd[p.position];
    assert.ok(sd > 0);
    for (const r of p.rungs) {
      assert.ok(r.z >= lo - 1e-6 && r.z <= hi + 1e-6,
        `${p.player} ${r.selection}: z ${r.z} outside [${lo}, ${hi}]`);
      // z is not decoration — it must reproduce from mu, line and sd
      assert.ok(Math.abs((p.mu - r.line) / sd - r.z) < 1e-3,
        `${p.player} ${r.selection}: z does not reproduce from mu/line/sd`);
    }
  }
  // refusals are counted, not hidden
  assert.ok(pool.counts.refused_out_of_support > 0,
    'a ladder that never refuses a rung is not being filtered');
});

test('a player with no in-support rung is absent and counted, never invented', () => {
  if (!present) return;
  const pool = readJson('data/leg_pool.json');
  assert.equal(pool.counts.players_with_a_leg, pool.players.length);
  assert.ok(Number.isInteger(pool.counts.players_with_no_leg));
  for (const p of pool.players) assert.ok(p.rungs.length >= 1, p.player);
});

/* 3 — the probabilities behave --------------------------------------------- */

test('a longer line is never more likely than a shorter one', () => {
  if (!present) return;
  const pool = readJson('data/leg_pool.json');
  for (const p of pool.players) {
    const seq = [...p.rungs].sort((a, b) => a.line - b.line).map((r) => r.model_prob);
    for (let i = 1; i < seq.length; i += 1) {
      assert.ok(seq[i] <= seq[i - 1],
        `${p.player}: ${seq[i - 1]} at a shorter line, ${seq[i]} at a longer one`);
    }
  }
});

test('no market number reaches a prop probability', () => {
  if (!present) return;
  const pool = readJson('data/leg_pool.json');
  for (const p of pool.players) {
    assert.equal(p.pricing, 'pool_calibrated');
    for (const r of p.rungs) {
      assert.ok(!('implied_prob' in r), `${p.player}: the pool quotes a price`);
      assert.ok(r.model_prob >= 0.05 && r.model_prob <= 0.95);
    }
  }
  // game legs MAY carry a book price — it is the terms of the bet, display only
  for (const g of pool.game_legs) {
    assert.ok(['moneyline', 'spread'].includes(g.market));
    assert.match(g.source, /parlays\.json/);
  }
});

test('game legs are verbatim copies of the shipped slate, de-duped', () => {
  if (!present) return;
  const pool = readJson('data/leg_pool.json');
  const slate = readJson('data/parlays.json');
  const slateLegs = new Map();
  for (const parlay of slate.parlays) {
    for (const leg of parlay.legs) {
      if (leg.market !== 'moneyline' && leg.market !== 'spread') continue;
      slateLegs.set(`${parlay.game_id}|${leg.market}|${leg.selection}`, leg);
    }
  }
  assert.ok(pool.game_legs.length > 0);
  const seen = new Set();
  for (const g of pool.game_legs) {
    const key = `${g.game_id}|${g.market}|${g.selection}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    const orig = slateLegs.get(key);
    assert.ok(orig, `${key} is not a slate leg`);
    assert.equal(g.model_prob, orig.model_prob, `${key}: re-priced, not copied`);
    if ('implied_prob' in orig) assert.equal(g.implied_prob, orig.implied_prob);
  }
});

/* 4 — the calibration gate -------------------------------------------------- */

test('the pool calibration cleared its gate on the committed corpus', () => {
  if (!present) return;
  const bt = readJson('data/leg_pool_backtest.json');
  const v = bt.verdict;
  assert.ok(v.adopt, v.why);
  assert.ok(v.refit.ece < v.shipped.ece, `${v.refit.ece} vs ${v.shipped.ece}`);
  assert.ok(v.refit.skill >= v.shipped.skill);
  assert.ok(v.refit.skill > v.min_skill, 'the refit must carry information');
  assert.ok(bt.corpus.rows > 5000 && bt.corpus.seasons.length >= 3);
  assert.ok(bt.corpus.refused_out_of_support > 0);
  assert.equal(readJson('data/leg_pool.json').calibration_adopted, true);
  // the reliability table is the shape of the calibration, not just a scalar
  assert.ok(bt.reliability.length >= 5);
  const worst = Math.max(...bt.reliability.map((b) => Math.abs(b.gap)));
  assert.ok(worst < 0.25, `a bin is off by ${worst}`);
});

test('the gate refuses noise, a tie and a well-calibrated coin flip', () => {
  const src = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts.backtest_leg_pool import build, gate, verdict, _synthetic
flip = verdict([(0.5, i % 2) for i in range(4000)], [(0.9, i % 2) for i in range(4000)])
print(json.dumps({
  "signal": build(rows=_synthetic(signal=1.0))["verdict"]["adopt"],
  "noise": build(rows=_synthetic(signal=0.0))["verdict"]["adopt"],
  "tie": verdict([(0.5, 1)] * 1000, [(0.5, 1)] * 1000)["adopt"],
  "flip": flip["adopt"], "flip_ece": flip["refit"]["ece"], "flip_why": flip["why"],
  "small_gate": gate(build(rows=_synthetic(signal=1.0)[:200])),
}))
`;
  const r = spawnSync('python3', ['-'], { input: src, cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.signal, true, 'a planted signal must be found');
  assert.equal(out.noise, false, 'pure noise must not be adopted');
  assert.equal(out.tie, false, 'a tie is a refusal');
  // the coin flip is BETTER calibrated than the baseline and still refused,
  // because being well calibrated about nothing cannot rank legs.
  assert.ok(out.flip_ece < 0.01, `flip ece ${out.flip_ece}`);
  assert.equal(out.flip, false, 'a well-calibrated coin flip must be refused');
  assert.match(out.flip_why, /no information/);
  assert.equal(out.small_gate, 1, 'a 200-row corpus must not pass');
});

test('both Python cores selftest clean', () => {
  for (const s of ['backtest_leg_pool.py', 'build_leg_pool.py']) {
    const r = spawnSync('python3', [join('scripts', s), '--selftest'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `${s}: ${r.stderr || r.stdout}`);
  }
});
