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
  topTrials, fmtPct, marketBadge, MARKET_SIGNALS,
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
