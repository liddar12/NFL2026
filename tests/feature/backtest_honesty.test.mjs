// backtest_honesty.test.mjs — an estimate is not a measurement.
//
// Mirrors scripts/harness/honesty.py. The one rule the UI may never break:
//   * estimate=true               => brier/log_loss ABSENT or null.
//   * estimate=false & resolved   => brier/log_loss BOTH present (non-null).
//   * estimate=false & !resolved  => scores absent (attaching them early = a leak).
//
// We lock the rule against inline snapshot fixtures AND assert the committed
// data/game_predictions.json (all day-zero estimates) never carries scores.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("every estimate row lacks brier and log_loss", () => {
  for (const row of HONEST.filter((r) => r.estimate)) {
    assert.ok(!hasScore(row, "brier") && !hasScore(row, "log_loss"));
  }
});

test("every measured+resolved row carries brier and log_loss", () => {
  for (const row of HONEST.filter((r) => !r.estimate && r.resolved)) {
    assert.ok(hasScore(row, "brier"), `${row.event_id} missing brier`);
    assert.ok(hasScore(row, "log_loss"), `${row.event_id} missing log_loss`);
  }
});

test("dishonest rows are rejected", () => {
  for (const row of DISHONEST) assert.throws(() => validateRow(row));
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
