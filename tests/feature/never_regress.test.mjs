// never_regress.test.mjs — lock the margin-gated adoption rule.
//
// The rule (scripts/optimize/never_regress.py):
//     should_adopt(current, candidate, margin) == candidate < current - margin
// A newly-fitted parameter vector replaces the incumbent ONLY if it beats it by
// strictly more than `margin` (default 0.0015 nats of log-loss). Ties and
// sub-margin "improvements" keep current — that stops churn on noise.
//
// This test re-implements the rule in JS and also asserts data/model_tuning.json
// (the committed NEVER-REGRESS example) is internally consistent with it.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Mirror of never_regress.should_adopt. Lower loss is better.
function shouldAdopt(currentLoss, candidateLoss, margin = 0.0015) {
  if (margin < 0) throw new Error("margin must be >= 0");
  return candidateLoss < currentLoss - margin;
}

test("a candidate below current-margin is adopted", () => {
  // 0.8300 < 0.8329 - 0.0015 = 0.8314  -> true
  assert.equal(shouldAdopt(0.8329, 0.83, 0.0015), true);
});

test("a candidate within the margin is NOT adopted", () => {
  // 0.8320 < 0.8314 ? no -> false (improvement 0.0009 < margin 0.0015)
  assert.equal(shouldAdopt(0.8329, 0.832, 0.0015), false);
});

test("an exact tie is NOT adopted (no free lunch for noise)", () => {
  assert.equal(shouldAdopt(0.8329, 0.8329, 0.0015), false);
});

test("a worse candidate is NOT adopted", () => {
  assert.equal(shouldAdopt(0.8329, 0.84, 0.0015), false);
});

test("the boundary is strict: candidate == current-margin is NOT adopted", () => {
  // candidate exactly on the threshold must fail (strict <).
  assert.equal(shouldAdopt(0.8329, 0.8329 - 0.0015, 0.0015), false);
});

test("negative margin is rejected (would admit regressions)", () => {
  assert.throws(() => shouldAdopt(0.8, 0.9, -0.001));
});

test("data/model_tuning.json is consistent with should_adopt and NOT adopted", () => {
  const tuning = JSON.parse(
    readFileSync(new URL("../../data/model_tuning.json", import.meta.url), "utf8"),
  );
  const expected = shouldAdopt(
    tuning.current_loss,
    tuning.candidate_loss,
    tuning.margin,
  );
  assert.equal(
    tuning.adopted,
    expected,
    "model_tuning.adopted must equal should_adopt(current, candidate, margin)",
  );
  // The committed example is deliberately a sub-margin improvement: not adopted.
  assert.equal(tuning.adopted, false, "the example must demonstrate a NON-adoption");
  assert.ok(
    tuning.candidate_loss < tuning.current_loss,
    "example candidate should be a (small) improvement, just not enough",
  );
  assert.ok(
    tuning.current_loss - tuning.candidate_loss < tuning.margin,
    "example improvement must be smaller than the margin",
  );
});
