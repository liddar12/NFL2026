/* tests/feature/rel6_contracts.test.mjs — Rel6 data contracts + the promotion
 * gate's honesty, locked.
 *
 *   defense_composite.json  32 teams, weight-0 pinned, z-mean ~0
 *   adp.json                joined market board (opponent model only)
 *   model_tuning.json       the signal-promotion entry: 16 trials recorded and
 *                           the incumbent HONESTLY retained (no candidate
 *                           cleared the margin on 2022-2025) — the gate must
 *                           never adopt on a tie.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

test('defense_composite: 32 teams, weight-0 pinned, composites centered', () => {
  const doc = read('defense_composite.json');
  assert.equal(Object.keys(doc.teams).length, 32);
  assert.equal(doc.params.applied, false);
  assert.equal(doc.params.weight, 0.0);
  const comps = Object.values(doc.teams).map((t) => t.composite);
  const mean = comps.reduce((a, b) => a + b, 0) / comps.length;
  assert.ok(Math.abs(mean) < 0.01, `z-blend mean ${mean} should be ~0`);
  for (const [ab, t] of Object.entries(doc.teams)) {
    assert.ok(t.front_weight_lb > 240 && t.front_weight_lb < 320, `${ab} front weight sane`);
  }
});

test('adp: sorted market board, join rate recorded, no fabricated ids', () => {
  const doc = read('adp.json');
  assert.equal(doc.format, 'ppr');
  assert.ok(doc.players.length >= 100);
  assert.ok(doc.join_rate > 0.5, `join rate ${doc.join_rate} suspiciously low`);
  for (let i = 1; i < doc.players.length; i += 1) {
    assert.ok(doc.players[i].adp >= doc.players[i - 1].adp, 'ADP ascending');
  }
  // Unjoined rows are allowed (rookies we don't project) but must be explicit nulls.
  for (const p of doc.players) {
    assert.ok(p.gsis_id === null || typeof p.gsis_id === 'string');
  }
});

test('signal promotion: the original Rel6 run stays archived, honestly retained', () => {
  const doc = read('model_tuning.json');
  // The Rel6 (format-1) entry: 16-trial venue x cold grid, retained. Rel7's
  // family-gate invariants live in rel7_contracts.test.mjs.
  const entry = (doc.history || []).find((h) => h.kind === 'signal_promotion' && !h.format);
  assert.ok(entry, 'legacy promotion entry still in history');
  assert.equal(entry.trials.length, 16, '4x4 scale grid fully archived');
  assert.equal(entry.adopted, false, 'no candidate cleared the margin — retained');
  const incumbent = entry.trials.find((t) => t.venue_scale === 0 && t.cold_scale === 0);
  for (const t of entry.trials) {
    assert.ok(t.log_loss >= incumbent.log_loss - 1e-9,
      `candidate v${t.venue_scale}/c${t.cold_scale} (${t.log_loss}) beat the incumbent yet was retained?`);
  }
});
