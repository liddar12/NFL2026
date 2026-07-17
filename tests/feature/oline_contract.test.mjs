/* tests/feature/oline_contract.test.mjs - data locks for data/oline_composite.json
 * (Task E contract).
 *
 * Per-team O-line context built by scripts/build_oline.py from ESPN rosters
 * (continuity optionally refined with nflverse 2025 OL snap shares). Locks:
 *   - all 32 canonical teams present, every numeric field finite and in range;
 *   - composite is a mean-0 z-score blend (league sum ~ 0);
 *   - honesty markers: estimate === true and a non-empty source string;
 *   - weight-0 discipline: params.applied === false, params.weight === 0 -
 *     this file is context for the registered ol_composite_vs_dl signal and
 *     must not move a game probability by existing.
 *
 * Node built-ins only (fast gate). Committed-file contract test: it validates
 * data/oline_composite.json as checked in, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(
  readFileSync(new URL('../../data/oline_composite.json', import.meta.url), 'utf8'),
);

const CANONICAL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LV', 'LAC', 'LAR', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SF', 'SEA', 'TB', 'TEN', 'WAS',
];

test('document identity: season, timestamps, source, estimate flag', () => {
  assert.equal(doc.season, 2026);
  assert.equal(typeof doc.updated_utc, 'string');
  assert.match(doc.updated_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  // Honest provenance: the source string must exist and say what fed continuity.
  assert.equal(typeof doc.source, 'string');
  assert.ok(doc.source.length > 0, 'source must not be empty');
  assert.match(doc.source, /espn_roster/, 'source must name the ESPN roster feed');
  // Labeled estimate (composite weights are a documented blend, not fitted).
  assert.equal(doc.estimate, true);
});

test('all 32 canonical teams present, exactly', () => {
  const abbrs = Object.keys(doc.teams).sort();
  assert.deepEqual(abbrs, [...CANONICAL_TEAMS].sort());
});

test('every team: numeric fields finite and inside sane NFL ranges', () => {
  for (const [ab, t] of Object.entries(doc.teams)) {
    assert.ok(Number.isInteger(t.n_linemen), `${ab}: n_linemen integer`);
    assert.ok(t.n_linemen >= 5 && t.n_linemen <= 30, `${ab}: n_linemen ${t.n_linemen}`);
    for (const field of ['avg_weight_lb', 'avg_age', 'avg_experience_yrs', 'continuity', 'composite']) {
      assert.ok(Number.isFinite(t[field]), `${ab}: ${field} must be finite, got ${t[field]}`);
    }
    assert.ok(t.avg_weight_lb >= 250 && t.avg_weight_lb <= 380, `${ab}: avg_weight_lb ${t.avg_weight_lb}`);
    assert.ok(t.avg_age >= 20 && t.avg_age <= 40, `${ab}: avg_age ${t.avg_age}`);
    assert.ok(t.avg_experience_yrs >= 0 && t.avg_experience_yrs <= 15, `${ab}: avg_experience_yrs`);
    assert.ok(t.continuity >= 0 && t.continuity <= 1, `${ab}: continuity ${t.continuity}`);
    assert.ok(Math.abs(t.composite) <= 5, `${ab}: composite ${t.composite} out of z-range`);
  }
});

test('composite is a mean-0 blend across the league', () => {
  const composites = Object.values(doc.teams).map((t) => t.composite);
  const mean = composites.reduce((a, b) => a + b, 0) / composites.length;
  // Per-team values are rounded to 4 dp, so allow rounding slack only.
  assert.ok(Math.abs(mean) < 0.01, `league mean composite ${mean} not ~0`);
  // A real z-blend has spread; all-zeros would mean the blend silently collapsed.
  assert.ok(composites.some((c) => Math.abs(c) > 0.1), 'composite column is degenerate');
});

test('weight-0 discipline: recorded, never applied', () => {
  assert.equal(doc.params.applied, false, 'params.applied must be false');
  assert.equal(doc.params.weight, 0, 'params.weight must be 0');
  assert.equal(typeof doc.params.feeds, 'string');
  assert.match(doc.params.feeds, /ol_composite_vs_dl/, 'feeds must name the registered signal');
});
