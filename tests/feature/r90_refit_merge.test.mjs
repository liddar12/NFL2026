/* tests/feature/r90_refit_merge.test.mjs — R90/F11: a successful gameday refit
 * MERGES the two fitted Elo parameters into the live game_params; it never
 * replaces the object.
 *
 * game_params is shared state: scripts/build_predictions.py reads `k` and the
 * promoted qb_out family out of the same object the refit adopts into. The
 * adoption branch used to assign a fresh four-key dict, so fitting home-field
 * advantage silently switched those families off. Locked here:
 *
 *   1. adoption over a seeded fixture (k + qb_out + a nested made-up family):
 *      the untouched families survive BYTE-FOR-BYTE, only hfa_elo, revert,
 *      adopted_utc, source and adopted_version change, and the document handed in
 *      is not mutated.
 *   2. adoption over the COMMITTED data/model_tuning.json game_params: same rule
 *      against the real object, k and qb_out included.
 *   3. adopted_version is previous + 1, or 1 when there is none.
 *   4. the receipt archived on adoption is the FULL effective object.
 *   5. the refusal branch returns nothing and changes nothing.
 *   6. scripts/refit.py --selftest exits 0.
 *
 * Node built-ins only. The pure function is called through a spawned python3
 * reading a payload FILE (no data/ write, no network).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PY_ENV = { ...process.env, PYTHONPATH: REPO_ROOT };

/* The payload file carries {doc, result, now}; the driver prints the merge, the
 * receipt and the document as it stands AFTER the call. */
const DRIVER = `
import json, sys
from scripts import refit
payload = json.load(open(sys.argv[1], encoding="utf-8"))
doc, result, now = payload["doc"], payload["result"], payload["now"]
before = json.dumps(doc, ensure_ascii=True, sort_keys=True)
effective = refit.next_game_params(doc, result, now)
out = {"effective": effective,
       "doc_after": doc,
       "doc_unchanged": json.dumps(doc, ensure_ascii=True, sort_keys=True) == before,
       "source_const": refit.ADOPTION_SOURCE,
       "adopted_keys": list(refit.ADOPTED_KEYS)}
out["receipt"] = refit.adoption_receipt(effective) if effective is not None else None
print(json.dumps(out))
`;

function merge(doc, result, now = '2026-09-19T00:00:00Z') {
  const tmp = mkdtempSync(join(tmpdir(), 'r90-refit-'));
  try {
    const payload = join(tmp, 'payload.json');
    writeFileSync(payload, `${JSON.stringify({ doc, result, now }, null, 2)}\n`);
    const r = spawnSync('python3', ['-', payload], {
      cwd: REPO_ROOT, env: PY_ENV, input: DRIVER, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const SEEDED = {
  hfa_elo: 45.0,
  revert: 0.45,
  k: 25.0,
  adopted_utc: '2026-07-17T17:16:18Z',
  source: 'scripts/backtest.py walk-forward grid (never-regress gated)',
  qb_out: {
    applied: true, scale: 75.0, adopted_under: 'fixed_margin_0.0015',
    significance: null, note: 'adopted family, unrelated to hfa/revert',
  },
  made_up_family: { applied: false, nested: { deep: [1, 2, { x: null }], tail: 'plain' } },
};
const ADOPTED = { adopted: true, candidate: { hfa_elo: 62.5, revert: 0.315 } };
const canon = (v) => JSON.stringify(v);

test('F11 adoption merges: k, qb_out and a nested family survive byte-for-byte', () => {
  const r = merge({ game_params: SEEDED }, ADOPTED);
  const eff = r.effective;
  assert.equal(eff.hfa_elo, 62.5);
  assert.equal(eff.revert, 0.315);
  assert.equal(eff.adopted_utc, '2026-09-19T00:00:00Z');
  assert.equal(eff.source, r.source_const);
  assert.equal(eff.adopted_version, 1, 'a first adoption is version 1');
  for (const family of ['k', 'qb_out', 'made_up_family']) {
    assert.equal(canon(eff[family]), canon(SEEDED[family]), `${family} survives untouched`);
  }
  assert.deepEqual(Object.keys(eff).sort(),
    [...new Set([...Object.keys(SEEDED), 'adopted_version'])].sort(),
    'the merge drops no key and invents only adopted_version');
  const changed = Object.keys(eff).filter((k) => canon(eff[k]) !== canon(SEEDED[k]));
  assert.deepEqual(changed.sort(), [...r.adopted_keys].sort(),
    'exactly the fitted fields, the stamp, the source and the version changed');
  assert.equal(r.doc_unchanged, true, 'the incoming document is never mutated');
});

test('F11 adoption over the COMMITTED game_params keeps k and the promoted qb_out family', () => {
  const tuning = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'model_tuning.json'), 'utf8'));
  const gp = tuning.game_params;
  assert.ok(gp && 'k' in gp && 'qb_out' in gp,
    'the committed object carries families this refit does not fit');
  const r = merge({ game_params: gp }, ADOPTED);
  assert.equal(canon(r.effective.k), canon(gp.k));
  assert.equal(canon(r.effective.qb_out), canon(gp.qb_out));
  assert.equal(r.effective.hfa_elo, 62.5);
  assert.equal(r.effective.revert, 0.315);
  assert.equal(r.doc_unchanged, true);
});

test('F11 adopted_version is previous + 1, and the receipt is the FULL effective object', () => {
  const first = merge({ game_params: SEEDED }, ADOPTED).effective;
  const second = merge({ game_params: first },
    { adopted: true, candidate: { hfa_elo: 70.0, revert: 0.2 } }, '2026-09-26T00:00:00Z');
  assert.equal(second.effective.adopted_version, 2);
  assert.equal(canon(second.effective.qb_out), canon(SEEDED.qb_out));
  assert.deepEqual(second.receipt, { adopted_version: 2, effective: second.effective },
    'the archived receipt repeats the whole object, not the two fitted fields');
  // A version that is not an integer (hand-edited, or a bool) restarts at 1.
  for (const bad of [null, 'two', true, 1.5]) {
    const r = merge({ game_params: { ...SEEDED, adopted_version: bad } }, ADOPTED);
    assert.equal(r.effective.adopted_version, 1, `adopted_version ${canon(bad)} -> 1`);
  }
});

test('F11 the refusal branch changes nothing at all', () => {
  for (const result of [{ adopted: false, candidate: { hfa_elo: 99.0, revert: 0.9 } },
    { candidate: { hfa_elo: 99.0, revert: 0.9 } }]) {
    const r = merge({ game_params: SEEDED }, result);
    assert.equal(r.effective, null, 'no candidate object is built');
    assert.equal(r.receipt, null, 'nothing is archived as effective');
    assert.equal(canon(r.doc_after.game_params), canon(SEEDED),
      'the refused document is byte-for-byte what it was');
    assert.equal(r.doc_unchanged, true);
  }
});

test('scripts/refit.py --selftest exits 0', () => {
  const r = spawnSync('python3', ['scripts/refit.py', '--selftest'],
    { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /selftest OK: adoption merges/);
});
