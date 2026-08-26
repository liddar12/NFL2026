// backtest_honesty.test.mjs — an estimate is not a measurement.
//
// The rule the UI may never break:
//   * estimate=true               => brier/log_loss ABSENT or null.
//   * estimate=false & resolved   => brier/log_loss BOTH present (non-null).
//   * estimate=false & !resolved  => scores absent (attaching them early = a leak).
//
// The ENFORCER is scripts/harness/honesty.py, and since QA-D4 (2026-08-26)
// this test drives that module directly over the fixtures, the committed
// game_predictions.json and the committed lock array — before that, only a JS
// re-implementation (validateRow below, kept for readability and asserted
// against the Python) ran in the gate, and honesty.py was imported by nothing
// outside its own package. Two earlier cases that filtered this file's own
// HONEST literal and asserted the keys it was written with (tautologies — they
// could not fail under any production change) were deleted in the same pass.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function py(body) {
  const out = execFileSync("python3", ["-"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const hasScore = (row, key) => key in row && row[key] !== null && row[key] !== undefined;

// Returns true if the row is honest; throws with a reason if not. Mirror of
// honesty.validate.
function validateRow(row) {
  const estimate = Boolean(row.estimate);
  const resolved = Boolean(row.resolved);
  const b = hasScore(row, "brier");
  const l = hasScore(row, "log_loss");
  if (estimate) {
    if (b || l) throw new Error(`estimate row ${row.event_id} must not carry scores`);
    return true;
  }
  if (resolved) {
    if (!(b && l)) throw new Error(`resolved measurement ${row.event_id} missing scores`);
    return true;
  }
  if (b || l) throw new Error(`unresolved row ${row.event_id} scored before resolution`);
  return true;
}

// Inline snapshot fixtures covering all three honest shapes.
const HONEST = [
  { event_id: "g_est", event_type: "game", model: "hybrid", estimate: true, resolved: false },
  { event_id: "g_pending", event_type: "game", model: "hybrid", estimate: false, resolved: false },
  {
    event_id: "g_measured",
    event_type: "game",
    model: "hybrid",
    estimate: false,
    resolved: true,
    actual: 0,
    brier: 0.18,
    log_loss: 0.3567,
  },
];

// Dishonest rows that MUST be rejected.
const DISHONEST = [
  // estimate carrying a measured score
  { event_id: "bad_est_scored", estimate: true, resolved: true, brier: 0.1, log_loss: 0.2 },
  // resolved measurement missing its scores
  { event_id: "bad_measured_unscored", estimate: false, resolved: true },
  // unresolved row already scored (a leak)
  { event_id: "bad_leak", estimate: false, resolved: false, brier: 0.1, log_loss: 0.2 },
];

test("every honest snapshot shape passes", () => {
  for (const row of HONEST) assert.doesNotThrow(() => validateRow(row));
});

test("dishonest rows are rejected", () => {
  for (const row of DISHONEST) assert.throws(() => validateRow(row));
});

// ---------------------------------------------------------------------------
// QA-D4 — scripts/harness/honesty.py is the enforcer the gate actually runs.
// ---------------------------------------------------------------------------

test("honesty.validate itself accepts HONEST and raises on DISHONEST (QA-D4-AC3)", () => {
  const out = py(`
from scripts.harness import honesty
honest = json.loads('''${JSON.stringify(HONEST)}''')
dishonest = json.loads('''${JSON.stringify(DISHONEST)}''')
accepted = [honesty.validate(r) for r in honest]
rejected = []
for r in dishonest:
    try:
        honesty.validate(r)
        rejected.append(False)
    except honesty.HonestyError:
        rejected.append(True)
print(json.dumps({"accepted": accepted, "rejected": rejected}))`);
  assert.deepEqual(out.accepted, HONEST.map(() => true),
    "every honest fixture must pass the Python enforcer");
  assert.deepEqual(out.rejected, DISHONEST.map(() => true),
    "every dishonest fixture must raise HonestyError in the Python enforcer");
});

test("JS mirror agrees with the Python verdict on every fixture (QA-D4-AC2)", () => {
  for (const row of [...HONEST, ...DISHONEST]) {
    let js = true;
    try { validateRow(row); } catch { js = false; }
    const out = py(`
from scripts.harness import honesty
row = json.loads('''${JSON.stringify(row)}''')
try:
    honesty.validate(row)
    print(json.dumps(True))
except honesty.HonestyError:
    print(json.dumps(False))`);
    assert.equal(js, out, `mirror and Python disagree on ${row.event_id}`);
  }
});

test("the committed lock array passes honesty.assert_measured_rows (P8-S5-AC2)", () => {
  // data/snapshots/2026_wk01_games_open.json is the one committed lock array;
  // this is the whole-file gate the module's docstring promises and nothing ran.
  const out = py(`
from scripts.harness import honesty
rows = json.load(open("data/snapshots/2026_wk01_games_open.json"))
print(json.dumps({"ok": honesty.assert_measured_rows(rows), "n": len(rows)}))`);
  assert.equal(out.ok, true);
  assert.ok(out.n >= 1, "the lock array must not be empty");
});

test("committed game_predictions.json are estimates with no scores attached", () => {
  const gp = JSON.parse(
    readFileSync(new URL("../../data/game_predictions.json", import.meta.url), "utf8"),
  );
  for (const g of gp.games) {
    assert.equal(g.estimate, true, `${g.game_id} should be a day-zero estimate`);
    assert.ok(!hasScore(g, "brier"), `${g.game_id} must not carry brier`);
    assert.ok(!hasScore(g, "log_loss"), `${g.game_id} must not carry log_loss`);
  }
});
