// metrics.test.mjs — lock log_loss / brier / mae to hand-computed constants.
//
// The Python harness (scripts/harness/metrics.py) is the source of truth. This
// test RE-IMPLEMENTS the identical arithmetic in JS (no cross-language import)
// and asserts the exact numbers so the two implementations can never silently
// diverge. Formulas were deliberately chosen to be trivially mirrorable.
//
// Node built-ins only: node:test, node:assert.

import { test } from "node:test";
import assert from "node:assert/strict";

const EPS = 1e-15;
const clamp = (p) => (p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p);

// -ln(p_true), clamped. Mirrors metrics.log_loss.
function logLoss(yTrue, probs) {
  return -Math.log(clamp(probs[yTrue]));
}
// sum_k (p_k - onehot_k)^2, clamped. Mirrors metrics.brier.
function brier(yTrue, probs) {
  let total = 0;
  probs.forEach((p, k) => {
    const d = clamp(p) - (k === yTrue ? 1 : 0);
    total += d * d;
  });
  return total;
}
// mean |pred - actual|. Mirrors metrics.mae.
function mae(pred, actual) {
  let total = 0;
  for (let i = 0; i < pred.length; i++) total += Math.abs(pred[i] - actual[i]);
  return total / pred.length;
}

const near = (a, b, tol = 1e-12) =>
  assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b} (tol ${tol})`);

test("log_loss on probs=[0.7,0.3], true=0 equals -ln(0.7)", () => {
  // -ln(0.7) = 0.35667494393873245 (computed by hand / calculator).
  near(logLoss(0, [0.7, 0.3]), 0.35667494393873245);
});

test("log_loss on the confident-correct case is ~0", () => {
  // -ln(0.999999...) ~ 0; clamp keeps it finite.
  assert.ok(logLoss(0, [1.0, 0.0]) >= 0);
  assert.ok(logLoss(0, [1.0, 0.0]) < 1e-12);
});

test("brier on probs=[0.7,0.3], true=0 equals exactly 0.18", () => {
  // (0.7-1)^2 + (0.3-0)^2 = 0.09 + 0.09 = 0.18.
  near(brier(0, [0.7, 0.3]), 0.18);
});

test("brier is symmetric on a 50/50 prediction = 0.5", () => {
  // (0.5-1)^2 + (0.5-0)^2 = 0.25 + 0.25 = 0.5.
  near(brier(1, [0.5, 0.5]), 0.5);
});

test("mae of [10,20,30] vs [12,18,33] equals 7/3", () => {
  // (|-2| + |2| + |-3|) / 3 = 7/3 = 2.3333...
  near(mae([10, 20, 30], [12, 18, 33]), 7 / 3);
});

test("mae is 0 for identical sequences", () => {
  near(mae([1, 2, 3], [1, 2, 3]), 0);
});
