// conformal.test.mjs — split-conformal coverage guarantee on a fixed set.
//
// Mirrors scripts/harness/conformal.py (LAC split-conformal):
//   * nonconformity(probs, true) = 1 - p(true)
//   * calibrate(scores, coverage): threshold = k-th smallest score,
//       k = ceil((n+1)*coverage); if k > n return 1.0 (include everything).
//   * safe_set(probs, thr): include class k iff (1 - p_k) <= thr.
// The safe set is built to CONTAIN the true outcome at ~coverage rate. This test
// fixes a calibration set and an evaluation set and asserts empirical coverage
// meets the target — the honest uncertainty guarantee, locked.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";

function calibrate(scores, coverage) {
  if (!(coverage > 0 && coverage < 1)) throw new Error("coverage in (0,1)");
  const s = [...scores].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new Error("need >=1 calibration score");
  const k = Math.ceil((n + 1) * coverage);
  if (k > n) return 1.0; // not enough data to certify -> include everything
  return s[k - 1]; // k is 1-based
}

function safeSet(probs, thr) {
  const included = [];
  probs.forEach((p, k) => {
    if (1 - p <= thr + 1e-12) included.push(k);
  });
  if (included.length === 0) {
    // never empty: fall back to argmax
    let best = 0;
    probs.forEach((p, k) => {
      if (p > probs[best]) best = k;
    });
    included.push(best);
  }
  return included;
}

// Fixed calibration nonconformity scores, n = 10.
const CAL = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

// Fixed evaluation events: {probs:[p0,p1], trueIdx}. Nine have p_true >= 0.1
// (will be covered at threshold 0.9), one has p_true = 0.05 (will be missed).
const EVAL = [
  { probs: [0.5, 0.5], trueIdx: 0 },
  { probs: [0.5, 0.5], trueIdx: 1 },
  { probs: [0.6, 0.4], trueIdx: 0 },
  { probs: [0.4, 0.6], trueIdx: 1 },
  { probs: [0.7, 0.3], trueIdx: 0 },
  { probs: [0.3, 0.7], trueIdx: 1 },
  { probs: [0.55, 0.45], trueIdx: 0 },
  { probs: [0.45, 0.55], trueIdx: 1 },
  { probs: [0.2, 0.8], trueIdx: 0 },
  { probs: [0.05, 0.95], trueIdx: 0 }, // p_true = 0.05 < 0.1 -> not covered
];

function empiricalCoverage(evalSet, thr) {
  let hits = 0;
  for (const e of evalSet) {
    if (safeSet(e.probs, thr).includes(e.trueIdx)) hits++;
  }
  return hits / evalSet.length;
}

test("calibrate at coverage 0.8 on n=10 picks the 9th smallest score (0.9)", () => {
  // k = ceil(11 * 0.8) = ceil(8.8) = 9 -> sorted[8] = 0.9
  assert.equal(calibrate(CAL, 0.8), 0.9);
});

test("empirical coverage meets the 0.8 target on the fixed eval set", () => {
  const thr = calibrate(CAL, 0.8); // 0.9
  const cov = empiricalCoverage(EVAL, thr); // 9/10 = 0.9
  assert.ok(cov >= 0.8, `empirical coverage ${cov} below target 0.8`);
  assert.equal(cov, 0.9);
});

test("higher target coverage yields a threshold that is at least as inclusive", () => {
  const t70 = calibrate(CAL, 0.7);
  const t85 = calibrate(CAL, 0.85);
  assert.ok(t85 >= t70, "higher coverage must not shrink the threshold");
});

test("too-few calibration points fall back to all-inclusive (threshold 1.0)", () => {
  // n=2, coverage 0.99 -> k = ceil(3*0.99)=3 > 2 -> 1.0
  assert.equal(calibrate([0.2, 0.4], 0.99), 1.0);
  // At threshold 1.0 every class is included -> the true outcome is always covered.
  assert.equal(empiricalCoverage(EVAL, 1.0), 1.0);
});
