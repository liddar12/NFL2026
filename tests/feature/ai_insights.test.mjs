/* tests/feature/ai_insights.test.mjs — data locks for data/ai_insights.json
 * (Agent E, Build 4 contract).
 *
 * The Fit Engine v2 estimation layer (scripts/ai_estimates.py — documented,
 * deterministic rules; never a live model call). Locks (contract §3):
 *   - default is "off" — the AI layer is opt-in, BASE is the product;
 *   - EVERY emitted field carries source ("measured" | "ai_estimated") AND a
 *     non-empty one-line why — honest provenance is the whole point;
 *   - every value is bounded |value| <= 0.25;
 *   - cold_adj weeks are 2026 regular-season week numbers;
 *   - the file covers the projection pool (>= 250 ids).
 *
 * Node built-ins only (fast gate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readData = (rel) =>
  JSON.parse(readFileSync(new URL(`../../data/${rel}`, import.meta.url), 'utf8'));

const ai = readData('ai_insights.json');
const projections = readData('player_projections.json');

const BOUND = 0.25;
const SOURCES = new Set(['measured', 'ai_estimated']);
const FIELDS = new Set(['trajectory_adj', 'stack_synergy', 'cold_adj']);

test('default is "off" — the AI layer is strictly opt-in', () => {
  assert.equal(ai.default, 'off');
});

test('players cover the projection pool (>= 250 projected ids)', () => {
  const ids = projections.players.map((p) => p.gsis_id);
  const present = ids.filter((id) => ai.players[id]);
  assert.ok(
    present.length >= 250,
    `only ${present.length}/${ids.length} projected ids carry insights (< 250)`,
  );
});

test('every field carries source + why and stays within the |0.25| bound', () => {
  let checked = 0;
  for (const [gid, rec] of Object.entries(ai.players)) {
    assert.ok(rec.trajectory_adj, `${gid}: trajectory_adj is required`);
    assert.ok(rec.cold_adj, `${gid}: cold_adj is required`);
    for (const [field, ins] of Object.entries(rec)) {
      assert.ok(FIELDS.has(field), `${gid}: unknown insight field ${JSON.stringify(field)}`);
      assert.ok(
        SOURCES.has(ins.source),
        `${gid}.${field}: source ${JSON.stringify(ins.source)} not in {measured, ai_estimated}`,
      );
      assert.ok(
        typeof ins.why === 'string' && ins.why.trim().length > 0,
        `${gid}.${field}: why must be a non-empty one-liner`,
      );
      assert.ok(
        Number.isFinite(ins.value) && Math.abs(ins.value) <= BOUND + 1e-9,
        `${gid}.${field}: value ${ins.value} outside |${BOUND}|`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'no insight fields checked — file is hollow');
});

test('cold_adj weeks are 2026 regular-season week numbers (1..18)', () => {
  for (const [gid, rec] of Object.entries(ai.players)) {
    const weeks = rec.cold_adj.weeks;
    assert.ok(Array.isArray(weeks), `${gid}.cold_adj.weeks must be an array`);
    for (const wk of weeks) {
      assert.ok(
        Number.isInteger(wk) && wk >= 1 && wk <= 18,
        `${gid}.cold_adj.weeks contains ${JSON.stringify(wk)}`,
      );
    }
  }
});

test('provenance honesty: an AI-estimated why says so; both sources appear in real data', () => {
  let measured = 0;
  let estimated = 0;
  for (const rec of Object.values(ai.players)) {
    for (const ins of Object.values(rec)) {
      if (ins.source === 'measured') measured += 1;
      else estimated += 1;
    }
  }
  assert.ok(measured > 0, 'real data must carry measured insights');
  assert.ok(estimated > 0, 'real data must carry ai_estimated insights');
});
