/* tests/feature/model_view.test.mjs — the MODEL tab's pure helpers, locked.
 *
 * app/views/model.js exports pure functions (no DOM at import time):
 *   topTrials(history, n)  best-first distinct trials by log-loss
 *   fmtPct(p)              one-decimal percent, em-dash for non-finite
 *   marketBadge(signal)    the DISPLAY-ONLY badge for market signals only
 * MARKET_SIGNALS must mirror validate_data.py's MARKET_DISPLAY_ONLY exactly —
 * the UI badge and the gate policy can never diverge silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  topTrials, fmtPct, marketBadge, MARKET_SIGNALS, latestPromotion, familyRows,
  marketTrend,
} from '../../app/views/model.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('topTrials ranks by log-loss, dedupes param triples, caps at n', () => {
  const history = [{
    trials: [
      { hfa_elo: 65, revert: 0.33, k: 20, log_loss: 0.641 },
      { hfa_elo: 45, revert: 0.45, k: 25, log_loss: 0.637 },
      { hfa_elo: 45, revert: 0.45, k: 25, log_loss: 0.637 },  // dupe
      { hfa_elo: 55, revert: 0.2, k: 15, log_loss: 0.644 },
      { hfa_elo: 85, revert: 0.2, k: 15, log_loss: 'bad' },   // dropped
    ],
  }];
  const top = topTrials(history, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].hfa, 45);
  assert.equal(top[0].log_loss, 0.637);
  assert.equal(top[1].hfa, 65);
  assert.deepEqual(topTrials([], 5), []);
  assert.deepEqual(topTrials(null, 5), []);
});

test('fmtPct formats one decimal and dashes non-finite', () => {
  assert.equal(fmtPct(0.15), '15.0%');
  assert.equal(fmtPct(0.0726), '7.3%');
  assert.equal(fmtPct(undefined), '—');
  assert.equal(fmtPct('x'), '—');
});

test('marketBadge fires only for market signals', () => {
  assert.match(marketBadge('kalshi'), /DISPLAY ONLY/);
  assert.match(marketBadge('market_spread'), /DISPLAY ONLY/);
  assert.equal(marketBadge('elo'), '');
  assert.equal(marketBadge('prior_perf'), '');
});

test('MARKET_SIGNALS mirrors the validator MARKET_DISPLAY_ONLY set exactly', () => {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: 'import json, sys\nsys.path.insert(0, ".")\n'
      + 'from scripts.validate_data import MARKET_DISPLAY_ONLY\n'
      + 'print(json.dumps(sorted(MARKET_DISPLAY_ONLY)))\n',
  });
  assert.deepEqual([...MARKET_SIGNALS].sort(), JSON.parse(out));
});

test('latestPromotion picks the newest format-2 entry only', () => {
  const history = [
    { kind: 'signal_promotion', format: 2, generated_utc: 'B' },
    { kind: 'signal_promotion', generated_utc: 'A' },          // legacy: skipped
    { kind: 'signal_promotion', format: 2, generated_utc: 'older' },
  ];
  assert.equal(latestPromotion(history).generated_utc, 'B');
  assert.equal(latestPromotion([{ kind: 'signal_promotion' }]), null);
  assert.equal(latestPromotion(null), null);
});

test('marketTrend: oldest-first points from format-2 entries with a baseline', () => {
  const history = [
    // newest-first in the file; only format-2 + market_baseline count
    { kind: 'signal_promotion', format: 2, generated_utc: '2026-07-19T00:00:00Z',
      market_baseline: { our_log_loss: 0.6345, market_log_loss: 0.6082, gap: 0.0263 } },
    { kind: 'signal_promotion', format: 2, generated_utc: '2026-07-12T00:00:00Z' }, // no baseline
    { kind: 'signal_promotion', format: 2, generated_utc: '2026-07-05T00:00:00Z',
      market_baseline: { our_log_loss: 0.6369, market_log_loss: 0.6082, gap: 0.0287 } },
    { kind: 'other' },
  ];
  const pts = marketTrend(history);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].date, '2026-07-05');      // oldest first (chart reads L→R)
  assert.equal(pts[1].date, '2026-07-19');
  assert.equal(pts[0].ours, 0.6369);
  assert.ok(pts[1].gap < pts[0].gap, 'gap shrinks over time in this fixture');
  assert.deepEqual(marketTrend([]), []);
  assert.deepEqual(marketTrend(null), []);
});

test('familyRows: adopted/retained/skipped statuses with best losses', () => {
  const entry = {
    adopted_family: { family: 'rest', scale_per_day: 4.5, log_loss: 0.6 },
    families: [
      { family: 'environment', best: { log_loss: 0.64 }, improvement: -0.001, trials: [{}] },
      { family: 'rest', best: { log_loss: 0.6 }, improvement: 0.03, trials: [{}] },
      { family: 'epa_total', skipped: true, reason: 'awaiting runner data' },
    ],
  };
  const rows = familyRows(entry);
  assert.deepEqual(rows.map((r) => r.status), ['retained', 'adopted', 'skipped']);
  assert.equal(rows[0].bestLoss, 0.64);
  assert.equal(rows[2].bestLoss, null);
  assert.equal(rows[2].reason, 'awaiting runner data');
  assert.deepEqual(familyRows(null), []);
});
