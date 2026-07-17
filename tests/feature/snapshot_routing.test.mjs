/* tests/feature/snapshot_routing.test.mjs — locks the validator's snapshot
 * schema ROUTING (regression for the gameday-cron failure).
 *
 * The gameday workflow archives a byte copy of game_predictions.json into
 * data/snapshots/game_predictions.<ts>.json (a dict). The validator used to
 * point EVERY file in data/snapshots/ at snapshot.schema.json (a lock ARRAY),
 * so the cron died every run with "expected type array, got dict" and never
 * committed a score refresh. The fix routes each snapshot family to the schema
 * that matches its shape.
 *
 * validate_data.py is a fast-gate (python3, no deps) module, so this drives its
 * pure `snapshot_schema_for` helper AND validates the two REAL families end to
 * end (a game_predictions-shaped dict, an actual lock array) through the same
 * validate_against_schema the validator uses — without touching data/snapshots/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

test('archived game_predictions.<ts>.json routes to the game_predictions schema', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import snapshot_schema_for
print(json.dumps({
  "archive": snapshot_schema_for("game_predictions.20260917T045106Z.json"),
  "archive_plain": snapshot_schema_for("game_predictions.json"),
}))
`);
  assert.equal(r.archive, 'game_predictions.schema.json');
  assert.equal(r.archive_plain, 'game_predictions.schema.json');
});

test('point-in-time lock files route to the snapshot (lock array) schema', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import snapshot_schema_for
print(json.dumps({
  "lock": snapshot_schema_for("2026_wk01_games_open.json"),
  "other": snapshot_schema_for("2026_wk05_final.json"),
}))
`);
  assert.equal(r.lock, 'snapshot.schema.json');
  assert.equal(r.other, 'snapshot.schema.json');
});

test('a game_predictions-shaped DICT validates under the routed schema (the cron case)', () => {
  // Exactly the regression: feed the live game_predictions.json (a dict) to the
  // schema the router now picks for an archived copy. Must NOT raise.
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import (
    snapshot_schema_for, validate_against_schema, _load, CONTRACTS, DATA
)
import os
gp = _load(os.path.join(DATA, "game_predictions.json"))
schema = _load(os.path.join(CONTRACTS, snapshot_schema_for("game_predictions.20260101T000000Z.json")))
ok = True
err = ""
try:
    validate_against_schema(gp, schema, "snapshots/game_predictions.20260101T000000Z.json")
except Exception as exc:  # noqa: BLE001 — surfacing the failure to the test
    ok = False
    err = str(exc)
print(json.dumps({"ok": ok, "err": err, "is_dict": isinstance(gp, dict)}))
`);
  assert.equal(r.is_dict, true, 'game_predictions.json is a dict, not an array');
  assert.equal(r.ok, true, `dict copy failed routed validation: ${r.err}`);
});
