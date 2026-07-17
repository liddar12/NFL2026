/* tests/feature/market_prices.test.mjs — the market scoreboard contract +
 * the DISPLAY-ONLY policy, locked.
 *
 * data/market_prices.json (scripts/build_markets.py): Kalshi + Polymarket
 * prices joined to OUR schedule. USER POLICY under test here:
 *   - display_only is pinned true and the note says never-weighted;
 *   - validate_data.check_meta_weights REJECTS any non-zero market-signal
 *     weight (the permanent MARKET_DISPLAY_ONLY pin);
 *   - pure joining helpers (ticker date parse, de-vig) behave exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const doc = JSON.parse(
  readFileSync(new URL('../../data/market_prices.json', import.meta.url), 'utf8'));

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

test('market_prices.json is pinned display-only with an explicit policy note', () => {
  assert.equal(doc.display_only, true);
  assert.match(doc.note, /DISPLAY ONLY/i);
  assert.match(doc.note, /never weighted/i);
});

test('sources carry honest statuses and row counts', () => {
  for (const src of ['kalshi', 'polymarket']) {
    assert.ok(doc.sources[src], `${src} source present`);
    assert.ok(['ok', 'down'].includes(doc.sources[src].status));
    assert.equal(typeof doc.sources[src].rows, 'number');
  }
});

test('every emitted price is a real probability in (0,1)', () => {
  for (const [gid, srcs] of Object.entries(doc.games)) {
    for (const row of Object.values(srcs)) {
      for (const key of ['home_prob', 'away_prob']) {
        if (row[key] != null) {
          assert.ok(row[key] > 0 && row[key] < 1, `${gid} ${key} in (0,1)`);
        }
      }
    }
  }
  for (const src of ['kalshi', 'polymarket']) {
    for (const r of doc.futures[src]) {
      assert.ok(r.prob > 0 && r.prob < 1, `${src} ${r.team} prob in (0,1)`);
      assert.equal(typeof r.team, 'string');
    }
  }
});

test('polymarket futures are de-vigged (sum ~1 when the full field is priced)', () => {
  const rows = doc.futures.polymarket;
  if (rows.length >= 30) {
    const sum = rows.reduce((a, r) => a + r.prob, 0);
    assert.ok(Math.abs(sum - 1) < 0.05, `de-vigged field sums to ${sum}`);
  }
});

test('kalshi ticker date parsing is exact (pure)', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.scrape.kalshi_nfl import parse_game_ticker
print(json.dumps({
  "ok": parse_game_ticker("KXNFLGAME-26SEP14DENKC"),
  "bad": parse_game_ticker("NOPE"),
}))
`);
  assert.deepEqual(r.ok, ['2026-09-14', 'DENKC']);
  assert.equal(r.bad, null);
});

test('polymarket de-vig normalizes and refuses zero-sum fields (pure)', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.scrape.polymarket_nfl import devig
rows = devig([{"name": "A", "prob": 0.2}, {"name": "B", "prob": 0.6}])
print(json.dumps({"rows": rows, "empty": devig([])}))
`);
  assert.equal(r.rows[0].prob + r.rows[1].prob, 1);
  assert.ok(Math.abs(r.rows[1].prob - 0.75) < 1e-9);
  assert.deepEqual(r.empty, []);
});

test('POLICY GATE: a non-zero market-signal weight fails validation', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import check_meta_weights, EXPECTED_SIGNALS, ValidationError
weights = {name: 0.0 for name in EXPECTED_SIGNALS}
ok_at_zero = True
try:
    check_meta_weights({"weights": dict(weights)})
except ValidationError:
    ok_at_zero = False
weights["kalshi"] = 0.1
rejected = False
msg = ""
try:
    check_meta_weights({"weights": weights})
except ValidationError as exc:
    rejected = True
    msg = str(exc)
print(json.dumps({"ok_at_zero": ok_at_zero, "rejected": rejected, "msg": msg}))
`);
  assert.equal(r.ok_at_zero, true, 'all-zero registry passes');
  assert.equal(r.rejected, true, 'non-zero market weight must be rejected');
  assert.match(r.msg, /DISPLAY-ONLY|display-only|day-zero/i);
});
