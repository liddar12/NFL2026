/* tests/feature/game_script.test.mjs — data locks for data/game_script.json
 * (game-script theory validation: winners run more, losers pass more, trailing
 * teams score garbage-time Q4 points).
 *
 * Locks:
 *   - season 2025, games_analyzed >= 250 (a full FINAL regular season);
 *   - EVERY split carries its sample size n, and low_n === (n < 8);
 *   - all reported values are finite numbers, shares/rates in [0, 1];
 *   - params are RECORDED, never applied (applied === false, weight === 0) —
 *     game probabilities are unchanged by this file existing.
 *
 * The THEORY DIRECTION is deliberately NOT hard-asserted (a future season may
 * legitimately flip a delta); the direction is printed as a report instead.
 *
 * Node built-ins only (fast gate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gs = JSON.parse(
  readFileSync(new URL('../../data/game_script.json', import.meta.url), 'utf8'),
);

const LOW_N = 8;

/** Assert a split object carries a sane n and an honest low_n flag. */
function assertSplit(label, split) {
  assert.ok(split && typeof split === 'object', `${label}: split missing`);
  assert.ok(
    Number.isInteger(split.n) && split.n >= 0,
    `${label}: n must be a non-negative integer, got ${JSON.stringify(split.n)}`,
  );
  assert.equal(
    split.low_n,
    split.n < LOW_N,
    `${label}: low_n must be ${split.n < LOW_N} for n=${split.n}`,
  );
}

/** Assert every named field on a split is a finite number. */
function assertFinite(label, split, fields) {
  for (const f of fields) {
    assert.ok(Number.isFinite(split[f]), `${label}.${f} must be finite, got ${split[f]}`);
  }
}

test('season 2025 with a full FINAL-game sample', () => {
  assert.equal(gs.season, 2025);
  assert.ok(
    gs.games_analyzed >= 250,
    `games_analyzed ${gs.games_analyzed} < 250 — partial season`,
  );
  assert.equal(typeof gs.updated_utc, 'string');
  assert.equal(gs.estimate, true, 'document must self-declare estimate:true');
  assert.ok(Array.isArray(gs.notes) && gs.notes.length >= 1, 'notes must explain provenance');
});

test('rush/pass attempt splits: n + honest low_n, finite winner/loser averages', () => {
  for (const key of ['rush_attempts', 'pass_attempts']) {
    const s = gs.splits[key];
    assertSplit(`splits.${key}`, s);
    assertFinite(`splits.${key}`, s, ['winner_avg', 'loser_avg', 'delta']);
    assert.ok(s.winner_avg >= 0 && s.loser_avg >= 0, `splits.${key}: negative attempts`);
    // delta must be internally consistent with the averages it summarizes.
    assert.ok(
      Math.abs(s.delta - (s.winner_avg - s.loser_avg)) < 0.02,
      `splits.${key}: delta ${s.delta} != winner_avg - loser_avg`,
    );
  }
});

test('rush_share: shares in [0,1], correlation in [-1,1], n carried', () => {
  const s = gs.splits.rush_share;
  assertSplit('splits.rush_share', s);
  assertFinite('splits.rush_share', s, ['winner_avg', 'loser_avg', 'delta', 'margin_correlation']);
  for (const f of ['winner_avg', 'loser_avg']) {
    assert.ok(s[f] >= 0 && s[f] <= 1, `splits.rush_share.${f} = ${s[f]}`);
  }
  assert.ok(
    s.margin_correlation >= -1 && s.margin_correlation <= 1,
    `margin_correlation ${s.margin_correlation} out of [-1, 1]`,
  );
  assert.ok(
    Math.abs(s.delta - (s.winner_avg - s.loser_avg)) < 0.002,
    `rush_share delta ${s.delta} != winner_avg - loser_avg`,
  );
});

test('blowout vs one-score winner rush share: both splits carry n', () => {
  for (const key of ['winner_rush_share_blowout', 'winner_rush_share_one_score']) {
    const s = gs.splits[key];
    assertSplit(`splits.${key}`, s);
    assertFinite(`splits.${key}`, s, ['avg']);
    assert.ok(s.avg >= 0 && s.avg <= 1, `splits.${key}.avg = ${s.avg}`);
  }
  // The two margin buckets partition a subset of decided games, never more.
  const total = gs.splits.winner_rush_share_blowout.n + gs.splits.winner_rush_share_one_score.n;
  assert.ok(
    total <= gs.splits.rush_share.n,
    `blowout + one-score n (${total}) exceeds decided games (${gs.splits.rush_share.n})`,
  );
});

test('garbage_time: Q4 vs Q1-Q3 pace, td rate in [0,1], n carried', () => {
  const s = gs.splits.garbage_time;
  assertSplit('splits.garbage_time', s);
  assertFinite('splits.garbage_time', s, [
    'trailing_q4_avg_points', 'trailing_q123_avg_points_per_quarter', 'delta', 'q4_td_rate',
  ]);
  assert.ok(s.q4_td_rate >= 0 && s.q4_td_rate <= 1, `q4_td_rate ${s.q4_td_rate}`);
  assert.ok(
    Math.abs(s.delta - (s.trailing_q4_avg_points - s.trailing_q123_avg_points_per_quarter)) < 0.02,
    `garbage_time delta ${s.delta} inconsistent with its components`,
  );
});

test('params are RECORDED, never applied — weight-0 discipline', () => {
  for (const key of ['rush_lean_when_leading', 'trailing_pass_boost']) {
    const p = gs.params[key];
    assert.ok(p && typeof p === 'object', `params.${key} missing`);
    assert.ok(Number.isFinite(p.value), `params.${key}.value must be a recorded number`);
    assert.equal(p.applied, false, `params.${key}.applied must be false (record, do not apply)`);
    assert.equal(p.weight, 0, `params.${key}.weight must be 0`);
  }
});

test('directional report (informational, not asserted)', () => {
  const s = gs.splits;
  // Print the theory verdict; assert only finiteness so a legitimate flip in a
  // future season never breaks the gate.
  const lines = [
    `winners rush att ${s.rush_attempts.winner_avg} vs losers ${s.rush_attempts.loser_avg} (delta ${s.rush_attempts.delta}, n=${s.rush_attempts.n})`,
    `winners pass att ${s.pass_attempts.winner_avg} vs losers ${s.pass_attempts.loser_avg} (delta ${s.pass_attempts.delta})`,
    `rush-share delta ${s.rush_share.delta}, corr with margin ${s.rush_share.margin_correlation}`,
    `winner rush share: blowouts ${s.winner_rush_share_blowout.avg} (n=${s.winner_rush_share_blowout.n}) vs one-score ${s.winner_rush_share_one_score.avg} (n=${s.winner_rush_share_one_score.n})`,
    `garbage time: Q4 ${s.garbage_time.trailing_q4_avg_points} vs Q1-3 pace ${s.garbage_time.trailing_q123_avg_points_per_quarter} (delta ${s.garbage_time.delta}, td rate ${s.garbage_time.q4_td_rate}, n=${s.garbage_time.n})`,
  ];
  for (const line of lines) console.log(`  [game-script] ${line}`);
  assert.ok(Number.isFinite(s.rush_share.delta) && Number.isFinite(s.garbage_time.delta));
});
