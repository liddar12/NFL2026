// never_regress.test.mjs — the adoption gate, in both of its forms.
//
// PART 1 — the FIXED-MARGIN rule (scripts/optimize/never_regress.py, used by
// scripts/refit.py and scripts/backtest.py for parameter fitting):
//     should_adopt(current, candidate, margin) == candidate < current - margin
// A newly-fitted parameter vector replaces the incumbent ONLY if it beats it by
// strictly more than `margin` (default 0.0015 nats of log-loss). Ties and
// sub-margin "improvements" keep current — that stops churn on noise.
//
// PART 2 — the SIGNIFICANCE rule (R18, scripts/promote_signals.py). A fixed
// margin is not a significance threshold: on the 2022-2025 fixtures 0.0015 nats
// is ~0.85 standard errors of the paired improvement, so the one family ever
// adopted through it (qb_out) had a 95% confidence interval straddling zero.
// The family gate now requires the improvement to beat max(effect floor,
// t_crit x its own fold-clustered standard error), with t_crit Bonferroni-
// corrected for every trial the run evaluated. These tests drive the real
// Python implementation, so they fail if the rule is ever loosened, if the
// hand-rolled t distribution drifts, or if the effect floor is dropped.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Run a snippet against the repo's Python and parse its JSON stdout. */
function py(body) {
  const out = execFileSync("python3", ["-"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

// --------------------------------------------------------------------------- //
// PART 1 — fixed margin (parameter refits)                                     //
// --------------------------------------------------------------------------- //

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

// --------------------------------------------------------------------------- //
// PART 2 — significance gate (candidate families)                              //
// --------------------------------------------------------------------------- //

test("t distribution: the hand-rolled quantiles match published tables", () => {
  // No scipy in this project, so the gate's own statistics are the only thing
  // standing between it and an arbitrary constant. Published values, 6dp.
  const want = {
    "0.95,1": 6.313752,
    "0.975,1": 12.706205,
    "0.95,3": 2.353363,
    "0.975,3": 3.182446,
    "0.995,3": 5.840909,
    "0.95,10": 1.812461,
    "0.975,10": 2.228139,
    "0.975,20": 2.085963,
    "0.95,25": 1.708141,
    "0.975,30": 2.042272,
  };
  const got = py(`
from scripts.promote_signals import student_t_ppf, student_t_sf, betainc
keys = ${JSON.stringify(Object.keys(want))}
out = {k: student_t_ppf(float(k.split(",")[0]), int(k.split(",")[1])) for k in keys}
out["cauchy_sf_1"] = student_t_sf(1.0, 1)      # t(1) is Cauchy: P(T>1) = 0.25
out["sf_zero"] = student_t_sf(0.0, 7)
out["betainc_1_1_at_0.3"] = betainc(1.0, 1.0, 0.3)   # I_x(1,1) = x
out["normal_limit"] = student_t_ppf(0.975, 2000000)
print(json.dumps(out))
`);
  for (const [k, v] of Object.entries(want)) {
    assert.ok(Math.abs(got[k] - v) < 5e-6, `t quantile ${k}: got ${got[k]}, want ${v}`);
  }
  assert.ok(Math.abs(got["cauchy_sf_1"] - 0.25) < 1e-12, "t(df=1) must be Cauchy");
  assert.ok(Math.abs(got["sf_zero"] - 0.5) < 1e-12);
  assert.ok(Math.abs(got["betainc_1_1_at_0.3"] - 0.3) < 1e-12);
  assert.ok(Math.abs(got["normal_limit"] - 1.959964) < 1e-4, "df -> inf gives z");
});

test("the standard error is clustered by fold, not pooled over games", () => {
  // Two folds, five games each: all the improvement sits in one fold. mean 0.1,
  // fold deviation sums -0.5 and +0.5 -> var = (2/1)*0.5/100 -> se = 0.1, t = 1.
  // The same total improvement spread evenly over both folds has zero
  // between-fold spread. A pooled i.i.d. formula cannot tell those apart; that
  // is exactly the difference between real evidence and one lucky season.
  const got = py(`
from scripts.promote_signals import paired_fold_stats
lumpy = paired_fold_stats({2023: [0.0]*5, 2024: [0.2]*5})
even  = paired_fold_stats({2023: [0.1]*5, 2024: [0.1]*5})
one   = paired_fold_stats({2024: [0.01]*10})
print(json.dumps({
  "lumpy": {k: lumpy[k] for k in ("n", "folds", "df", "mean", "se", "t", "folds_positive")},
  "even_se": even["se"], "even_mean": even["mean"], "even_folds_positive": even["folds_positive"],
  "one_se": one["se"], "one_t": one["t"], "one_folds": one["folds"],
}))
`);
  assert.equal(got.lumpy.n, 10);
  assert.equal(got.lumpy.folds, 2);
  assert.equal(got.lumpy.df, 1);
  assert.ok(Math.abs(got.lumpy.mean - 0.1) < 1e-12);
  assert.ok(Math.abs(got.lumpy.se - 0.1) < 1e-12, "CR1 cluster se");
  assert.ok(Math.abs(got.lumpy.t - 1.0) < 1e-12, "one-fold improvement is ~1 sigma");
  assert.equal(got.lumpy.folds_positive, 1);
  assert.ok(Math.abs(got.even_mean - 0.1) < 1e-12);
  assert.equal(got.even_se, 0, "an evenly-spread improvement has no fold spread");
  assert.equal(got.even_folds_positive, 2);
  // A single fold carries no between-fold evidence and must claim none.
  assert.equal(got.one_se, null);
  assert.equal(got.one_t, 0);
  assert.equal(got.one_folds, 1);
});

test("adoption needs BOTH the effect floor and Bonferroni-corrected significance", () => {
  const got = py(`
from scripts.promote_signals import adoption_threshold, should_adopt, MIN_EFFECT, SIG_ALPHA
cases = {
  "worse":            should_adopt(-0.01, 0.0005, 3, 44),
  "tied":             should_adopt(0.0, 0.0005, 3, 44),
  "on_the_floor":     should_adopt(MIN_EFFECT, 1e-9, 3, 44),
  "under_the_floor":  should_adopt(0.0014, 1e-9, 3, 44),
  "significant_but_tiny": should_adopt(0.0014, 1e-6, 3, 44),
  "big_but_noisy":    should_adopt(0.02, 0.01, 3, 44),
  "big_and_clean":    should_adopt(0.11, 0.01, 3, 44),
  "more_folds":       should_adopt(0.04, 0.01, 25, 44),
  "no_folds":         should_adopt(999.0, None, 0, 44),
  "qb_out_2026_07_18": should_adopt(0.0024, 0.002462, 3, 44),
}
print(json.dumps({
  "cases": cases,
  "floor": MIN_EFFECT,
  "alpha": SIG_ALPHA,
  "t_crit_4folds_44trials": adoption_threshold(0.001, 3, 44)["t_crit"],
  "t_crit_26folds_30trials": adoption_threshold(0.001, 25, 30)["t_crit"],
  "t_crit_one_trial": adoption_threshold(0.001, 3, 1)["t_crit"],
  "floor_binds": adoption_threshold(1e-9, 3, 44)["threshold"],
  "no_folds_threshold": adoption_threshold(None, 0, 44)["threshold"],
}))
`);
  const c = got.cases;
  assert.equal(c.worse, false, "a worse candidate can never be adopted");
  assert.equal(c.tied, false, "a tie can never be adopted");
  assert.equal(c.on_the_floor, false, "the floor comparison is strict");
  assert.equal(c.under_the_floor, false);
  assert.equal(
    c.significant_but_tiny,
    false,
    "statistical significance alone must not buy pricing weight — the effect floor survives",
  );
  assert.equal(c.big_but_noisy, false, "t = 2.0 is not enough after correcting for 44 trials");
  assert.equal(c.big_and_clean, true, "a genuinely large, clean improvement still adopts");
  assert.equal(c.more_folds, true, "more walk-forward folds buy real power");
  assert.equal(c.no_folds, false, "no uncertainty estimate means no adoption, ever");
  assert.equal(
    c.qb_out_2026_07_18,
    false,
    "the measured qb_out adoption (improvement 0.0024, clustered se 0.00246, t = 0.98) is a coin flip",
  );
  assert.equal(got.floor, 0.0015, "the effect floor is still the shared 0.0015");
  assert.equal(got.alpha, 0.05);
  assert.ok(got.t_crit_4folds_44trials > 9, "4 folds + 44 trials is a demanding critical value");
  assert.ok(
    got.t_crit_26folds_30trials < got.t_crit_4folds_44trials,
    "more folds must lower the bar, not raise it",
  );
  assert.ok(
    got.t_crit_one_trial < got.t_crit_4folds_44trials,
    "more trials must raise the bar (multiple comparisons are paid for)",
  );
  assert.equal(got.floor_binds, 0.0015, "a vanishing se falls back to the effect floor");
  assert.equal(got.no_folds_threshold, null);
});

test("the significance gate is strictly stricter than the old fixed margin", () => {
  // Property check over a grid: anything the new rule adopts, the old 0.0015
  // margin would also have adopted. The reverse is emphatically not true — that
  // asymmetry is the whole point of R18.
  const got = py(`
from scripts.promote_signals import should_adopt, MIN_EFFECT
viol = []
looser = 0
for i in range(1, 60):
    imp = i * 0.0002
    for j in range(1, 40):
        se = j * 0.0002
        for (df, k) in ((3, 44), (25, 30), (10, 12)):
            new = should_adopt(imp, se, df, k)
            old = imp > MIN_EFFECT
            if new and not old:
                viol.append([imp, se, df, k])
            if old and not new:
                looser += 1
print(json.dumps({"violations": viol[:5], "n_violations": len(viol), "old_only": looser}))
`);
  assert.equal(got.n_violations, 0, `new gate adopted where the old margin would not: ${JSON.stringify(got.violations)}`);
  assert.ok(got.old_only > 0, "the new gate must reject cases the old margin accepted");
});

test("the archived promotion entry records how its threshold was earned", () => {
  const doc = JSON.parse(
    readFileSync(new URL("../../data/model_tuning.json", import.meta.url), "utf8"),
  );
  const entry = (doc.history || []).find(
    (h) => h && h.kind === "signal_promotion" && h.format === 2,
  );
  assert.ok(entry, "a format-2 promotion entry is recorded");
  if (!entry.significance) return; // pre-R18 entry; the next cron run rewrites it
  const s = entry.significance;
  assert.ok(s.trials > 0, "the trial count backing the Bonferroni correction");
  assert.ok(s.alpha > 0 && s.alpha < 1);
  assert.equal(s.effect_floor, 0.0015, "the effect floor is recorded, not implied");
  assert.ok(
    Math.abs(s.alpha_bonferroni - s.alpha / s.trials) < 1e-7, // recorded at 8dp
    "alpha_bonferroni = alpha / trials",
  );
  assert.ok(s.threshold === null || s.threshold >= s.effect_floor,
    "the applied threshold can only ever be at or above the effect floor");
  assert.equal(entry.margin, s.threshold === null ? s.effect_floor : s.threshold,
    "entry.margin is the threshold actually applied");
  assert.equal(s.significant, Boolean(entry.adopted || entry.would_adopt),
    "a significant result is either adopted or explicitly recorded as pending");
  // Every trialed candidate carries its own uncertainty, not just the winner.
  for (const fam of entry.families || []) {
    if (fam.skipped) continue;
    for (const t of fam.trials) {
      assert.ok("se" in t && "t_stat" in t,
        `${fam.family} trial must record its standard error and t statistic`);
      assert.ok(t.folds >= 2, `${fam.family} trial must span at least two folds`);
    }
  }
});
