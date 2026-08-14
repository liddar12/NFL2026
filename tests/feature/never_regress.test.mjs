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
// corrected for the multiplicity of the search. These tests drive the real
// Python implementation, so they fail if the rule is ever loosened, if the
// hand-rolled t distribution drifts, or if the effect floor is dropped.
//
// PART 3 — the R24 corrections to that rule and to the run's side effects:
//   * the Bonferroni divisor is the number of runnable candidate FAMILIES
//     (distinct hypotheses), not the number of grid points — grid resolution is
//     an implementation constant and must not set the adoption bar, and a
//     family that loses must not tax the families that did not;
//   * a DRY RUN (no --auto-adopt) writes nothing at all;
//   * the archived entry states its multiplicity budget in both units, names
//     the families it actually tested, and records a machine-readable
//     adoption_blocked for an unwired winner;
//   * --referee-report exists and is a diagnostic, never a family.
//
// PART 4 — R26, who is allowed to APPLY the rule. The R24 divisor correction
// is statistically right and stays, but it lowered t_crit 12.42 -> 6.41, and
// the owner declined to let an unattended weekly cron apply a lowered bar to
// the shipped model. So there is now a third mode between "adopt" and "dry
// run": --propose archives history and calibration exactly as --auto-adopt
// does, and never writes game_params. The cron proposes; a human adopts.
//
// Node built-ins only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TUNING = join(REPO_ROOT, "data", "model_tuning.json");

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
  // R24: this used to be `if (!entry.significance) return;`. The SHIPPED artifact
  // still carried a pre-R18 entry, so every assertion below it was DARK against
  // the file the PWA actually fetches — the archive could rot indefinitely and
  // nothing went red. The newest entry is now required to carry its statistics;
  // if a stale artifact is committed again, this is the test that says so.
  assert.ok(entry.significance,
    "the newest format-2 entry must carry its significance block — a shipped "
    + "entry with no statistics means the artifact predates the gate that "
    + "decided it (re-run: python3 -m scripts.promote_signals --auto-adopt)");
  const s = entry.significance;
  assert.ok(s.trials > 0, "the grid-point count is archived for audit");
  assert.ok(s.alpha > 0 && s.alpha < 1);
  assert.equal(s.effect_floor, 0.0015, "the effect floor is recorded, not implied");
  // R24: the divisor is `tests` (runnable families), not `trials` (grid points).
  // The shipped entry is decided under the CURRENT rule, so `tests` is required
  // and the check is EXACT — no `?? s.trials` fallback to soften it. Entries
  // archived before R24 keep their own divisor in their own block; they are not
  // rewritten, which is the whole point of archiving both counts.
  assert.equal(typeof s.tests, "number",
    "the shipped entry records the family divisor it was decided under");
  assert.equal(s.tests, entry.families_runnable,
    "the Bonferroni divisor IS the runnable-family count, not a free parameter");
  assert.ok(
    Math.abs(s.alpha_bonferroni - s.alpha / s.tests) < 1e-7, // recorded at 8dp
    "alpha_bonferroni = alpha / tests (the runnable-family divisor)",
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
  // R24: `appliable` must be a real boolean on EVERY family of the shipped
  // entry. The MODEL tab's NO PATH chip (app/views/model.js) renders only on
  // `appliable === false`, so an entry carrying null/undefined renders the
  // distinction nowhere and a reader cannot tell a family that CANNOT earn
  // weight from one that merely did not — the exact state the artifact shipped
  // in before this run. null is not "unknown" here; the gate knows.
  for (const fam of entry.families || []) {
    assert.equal(typeof fam.appliable, "boolean",
      `${fam.family} must record whether a prediction-time reader can apply it`);
  }
  assert.ok((entry.families || []).some((f) => f.appliable === false),
    "the shipped entry has at least one non-appliable family, so the MODEL "
    + "tab's NO PATH chip is exercised by real data and not just by unit tests");
});

// --------------------------------------------------------------------------- //
// PART 3 — R24 corrections                                                     //
// --------------------------------------------------------------------------- //

const PROMOTE_SRC = readFileSync(
  new URL("../../scripts/promote_signals.py", import.meta.url), "utf8");

/**
 * Run promote_signals.run() against a THROWAWAY copy of model_tuning.json and
 * return the entry plus what actually landed on disk. The shipped artifact is
 * never touched: TUNING_PATH is rebound before the call.
 */
function runGate({ autoAdopt, propose = false }) {
  return py(`
import contextlib, io, json as _json, os, shutil, tempfile
import scripts.promote_signals as ps
tmp = tempfile.mkdtemp()
path = os.path.join(tmp, "model_tuning.json")
shutil.copyfile(ps.TUNING_PATH, path)
before = os.path.getsize(path)
gp_before = _json.load(open(path)).get("game_params")
ps.TUNING_PATH = path
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    entry = ps.run(auto_adopt=${autoAdopt ? "True" : "False"}, propose=${propose ? "True" : "False"})
after = os.path.getsize(path)
doc = json.load(open(path))
print(json.dumps({
  "entry": entry,
  "wrote": after != before,
  "history_len": len(doc.get("history") or []),
  "newest_kind": (doc.get("history") or [{}])[0].get("kind"),
  "newest_stamp": (doc.get("history") or [{}])[0].get("generated_utc"),
  "game_params_unchanged": doc.get("game_params") == gp_before,
  "stdout": buf.getvalue(),
}))
`);
}

test("R24: the Bonferroni divisor is candidate FAMILIES, not grid points", () => {
  // THE DEFECT. R18 divided alpha by every trial in the run. That makes the
  // adoption bar a function of GRID RESOLUTION — divisional's signed 6x5 grid is
  // 30 trials for ONE hypothesis — and it cross-subsidises: adding five families
  // that all LOSE took the run from 45 to 89 trials and t_crit (df=3) from 9.85
  // to 12.42, a 26% higher bar for every family including the ones already
  // proposed. Merely proposing bad candidates made a good one harder to adopt.
  const { entry } = runGate({ autoAdopt: false });
  const s = entry.significance;

  assert.equal(s.multiplicity_unit, "candidate_families",
    "the entry names the unit its divisor was charged in");
  assert.equal(s.tests, Math.max(entry.families_runnable, 1),
    "the divisor IS the runnable-family count");
  assert.equal(s.tests, Object.keys(s.trials_by_family).length,
    "one test per family that produced trials — no more, no fewer");
  assert.ok(s.trials > s.tests,
    "grid points still outnumber hypotheses (89 vs 13 on the shipped run)");
  assert.equal(
    Object.values(s.trials_by_family).reduce((a, b) => a + b, 0), s.trials,
    "the grid-point count is still archived and still itemised, for audit",
  );
  assert.ok(Math.abs(s.alpha_bonferroni - s.alpha / s.tests) < 1e-7,
    "alpha is divided by the family count");

  // The critical value is EXACTLY the one-sided t quantile at alpha/families.
  // Pinning it here is what stops a future edit from quietly reverting the unit.
  const t = py(`
from scripts.promote_signals import student_t_ppf
print(json.dumps({"t": student_t_ppf(1 - ${s.alpha} / ${s.tests}, ${s.df})}))
`);
  assert.ok(Math.abs(t.t - s.t_crit) < 5e-4,
    `t_crit must be t(1 - alpha/families, df): got ${s.t_crit}, want ${t.t}`);

  // GRID RESOLUTION IS NOT A SIGNIFICANCE LEVEL. Doubling any family's grid
  // changes `trials` and must leave the divisor alone.
  const counts = Object.values(s.trials_by_family);
  assert.ok(counts.some((n) => n !== counts[0]),
    "families really do spend different numbers of grid points");
  assert.ok(!counts.includes(s.tests) || new Set(counts).size > 1,
    "the divisor is not simply one family's grid size");
});

test("R24: the smaller divisor does NOT weaken never-regress", () => {
  // The divisor shrank (89 -> 13), so the significance TERM shrank. Everything
  // that made the rule a rule is unchanged: strict comparison, effect floor,
  // one-sided t, no-uncertainty-means-no-adoption. Checked AT THE NEW DIVISOR.
  const got = py(`
from scripts.promote_signals import adoption_threshold, should_adopt, MIN_EFFECT
F = 13                      # runnable families on the shipped run
cases = {
  "worse":             should_adopt(-0.01, 0.0005, 3, F),
  "tied":              should_adopt(0.0, 0.0005, 3, F),
  "on_the_floor":      should_adopt(MIN_EFFECT, 1e-9, 3, F),
  "under_the_floor":   should_adopt(0.0014, 1e-9, 3, F),
  "significant_tiny":  should_adopt(0.0014, 1e-9, 25, F),
  "big_but_noisy":     should_adopt(0.02, 0.01, 3, F),
  "no_folds":          should_adopt(999.0, None, 0, F),
  "qb_out_2026_07_18": should_adopt(0.0024, 0.002462, 3, F),
  "best_ever_measured": should_adopt(0.00076, 0.00101, 3, F),
}
print(json.dumps({
  "cases": cases,
  "t_crit_13": adoption_threshold(0.001, 3, F)["t_crit"],
  "t_crit_1":  adoption_threshold(0.001, 3, 1)["t_crit"],
  "t_crit_89": adoption_threshold(0.001, 3, 89)["t_crit"],
  "threshold_13": adoption_threshold(0.00101, 3, F)["threshold"],
}))
`);
  const c = got.cases;
  assert.equal(c.worse, false, "a worse candidate is still never adopted");
  assert.equal(c.tied, false, "a tie is still never adopted");
  assert.equal(c.on_the_floor, false, "the floor comparison is still strict");
  assert.equal(c.under_the_floor, false);
  assert.equal(c.significant_tiny, false,
    "significance alone still cannot buy pricing weight — the floor survives");
  assert.equal(c.big_but_noisy, false, "t = 2.0 is still not evidence");
  assert.equal(c.no_folds, false, "no uncertainty estimate still means no adoption");
  assert.equal(c.qb_out_2026_07_18, false,
    "the one family ever adopted under the old fixed margin (t = 0.98) still fails");
  assert.equal(c.best_ever_measured, false,
    "the best improvement the gate has ever measured (elo_epa, t = 0.75) still fails");
  // Multiplicity is still PAID FOR: searching 13 hypotheses costs more than 1.
  assert.ok(got.t_crit_13 > got.t_crit_1,
    "correcting for 13 hypotheses must still be stricter than correcting for 1");
  assert.ok(got.t_crit_13 < got.t_crit_89,
    "the family divisor is the smaller of the two, as designed");
  // ...and the bar is still multiples of the effect floor on the 4-fold window.
  assert.ok(got.threshold_13 > 4 * 0.0015,
    `the applied threshold is still ~4x the effect floor (got ${got.threshold_13})`);
});

test("R24: a DRY RUN mutates nothing on disk", () => {
  // The defect: `python3 -m scripts.promote_signals` — a command with no side
  // effect in its name — rewrote the shipped, committed data/model_tuning.json
  // on every invocation, adding ~48KB of history the PWA then fetches on
  // #/model. Locked two ways: the real CLI against the real artifact, and
  // run(auto_adopt=False) against a throwaway copy.
  const before = readFileSync(TUNING, "utf8");
  const beforeStat = statSync(TUNING);
  const out = execFileSync("python3", ["-m", "scripts.promote_signals"], {
    cwd: REPO_ROOT, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  assert.match(out, /DRY RUN: data\/model_tuning\.json NOT written/);
  assert.equal(readFileSync(TUNING, "utf8"), before,
    "a dry run rewrote the shipped model_tuning.json");
  assert.equal(statSync(TUNING).mtimeMs, beforeStat.mtimeMs,
    "a dry run touched the shipped model_tuning.json");

  const dry = runGate({ autoAdopt: false });
  assert.equal(dry.wrote, false, "run(auto_adopt=False) wrote to disk");
  assert.ok(dry.entry, "the dry run still RETURNS its entry — it reports, it just does not write");
  assert.match(dry.stdout, /NOT written/);
});

test("R26: the weekly cron PROPOSES, it does not adopt", () => {
  // OWNER DECISION 2026-08-14, and the reason this is a test and not a comment.
  //
  // R24 corrected the Bonferroni divisor from grid points to candidate families.
  // That correction is right and stays — but it dropped t_crit from 12.42 to
  // 6.41, which LOWERED the bar at which an unattended weekly job may rewrite
  // the shipped model. The owner kept the statistics and removed the unattended
  // application: the cron measures and archives, a human adopts.
  //
  // The failure mode this guards against is not a bug, it is a well-meaning
  // future edit. `--propose` looks like a weaker `--auto-adopt` to anyone who
  // does not know why it is there, and "the self-learning cron stopped
  // self-learning" is exactly the kind of thing someone helpfully "fixes". So
  // the workflow's flag is asserted, with the reason attached.
  const WORKFLOW_SRC = readFileSync(
    new URL("../../.github/workflows/backtest.yml", import.meta.url), "utf8",
  );
  const runLines = WORKFLOW_SRC.split("\n")
    .filter((l) => l.includes("promote_signals") && !l.trim().startsWith("#"));
  assert.ok(runLines.length > 0, "backtest.yml must still run the promotion gate");
  for (const line of runLines) {
    assert.ok(!/--auto-adopt/.test(line),
      "the weekly cron must NOT run --auto-adopt: it would apply a lowered "
      + "adoption bar to the shipped model with no human in the loop "
      + "(owner decision 2026-08-14). Adoption is a deliberate manual run.");
    assert.ok(/--propose/.test(line),
      "the weekly cron must run --propose so history and calibration keep "
      + "flowing to the MODEL tab — a plain dry run would freeze them, which "
      + "is what makes an unadopted proposal visible in the first place");
  }
});

test("R26: --propose archives the run but never writes game_params", () => {
  // The whole point of the third mode. A dry run would also stop archiving —
  // freezing the MODEL tab's calibration and gate history — so `--propose` has
  // to write the file while leaving the adopted parameters untouched. Both
  // halves are asserted, because either one alone is a different feature.
  const prop = runGate({ autoAdopt: false, propose: true });
  assert.equal(prop.wrote, true, "--propose must archive the run");
  assert.equal(prop.newest_kind, "signal_promotion");
  assert.equal(prop.game_params_unchanged, true,
    "--propose wrote game_params — it must only ever archive");
  assert.equal(prop.entry.adopted, false, "--propose must never mark an entry adopted");
  assert.equal(prop.entry.write_mode, "propose",
    "the archived entry must record which authority wrote it");
  assert.equal(prop.entry.auto_adopt, false);
  // A clearing family is RECORDED so a human can see it and act. Today nothing
  // clears (the best family sits far below its threshold), so this only asserts
  // the shape when it happens rather than asserting a proposal exists.
  if (prop.entry.would_adopt) {
    assert.ok(prop.entry.would_adopt.family, "a proposal must name its family");
    assert.ok(prop.entry.proposed_utc, "a proposal must be stamped");
    assert.equal(prop.entry.adopted_family, null);
  }
});

test("R24: --auto-adopt still archives the run (the cron's durable record)", () => {
  // The dry-run fix must not silently stop the archive. NOTE (R26): the weekly
  // cron now runs --propose, not --auto-adopt, so this no longer describes the
  // cron — it locks the behaviour of the MANUAL adoption command a human runs
  // to apply a proposal. The archive requirement is identical either way.
  const wet = runGate({ autoAdopt: true });
  assert.equal(wet.wrote, true, "--auto-adopt must write");
  assert.equal(wet.newest_kind, "signal_promotion");
  assert.equal(wet.newest_stamp, wet.entry.generated_utc,
    "the entry that was returned is the entry that was archived");
  const shipped = JSON.parse(readFileSync(TUNING, "utf8"));
  assert.equal(wet.history_len, (shipped.history || []).length + 1,
    "exactly one entry is added per run");
});

test("R24: the entry names the families it tested, and cannot go stale", () => {
  const { entry } = runGate({ autoAdopt: false });
  const names = entry.families.map((f) => f.family);
  assert.equal(entry.families_tested, names.length,
    "families_tested is the registered-family count (SOLUTION_DESIGN 9.7 brake 4)");
  assert.ok(entry.families_runnable > 0 && entry.families_runnable <= entry.families_tested,
    "families_runnable counts the families that actually produced trials");
  // The `source` string is GENERATED from families[], so it can never drift the
  // way the hand-written "(environment + rest + epa families)" literal did —
  // that text survived ten new families.
  assert.ok(!/environment \+ rest \+ epa families/.test(entry.source),
    "the stale hand-written family list is gone");
  assert.ok(!/environment \+ rest \+ epa families/.test(PROMOTE_SRC),
    "and the literal is gone from the source, so it cannot come back");
  // R24: this assertion scanned promote_signals.py ONLY, so the SAME stale
  // family list survived in .github/workflows/backtest.yml — the workflow that
  // actually RUNS this gate. Two copies of the claim, one guarded; the
  // unguarded one still told a reader the gate trials "environment, rest, EPA
  // total/pass" while it was running thirteen families. The workflow must stay
  // family-agnostic: the archived entry is the only place families get named.
  const WORKFLOW_SRC = readFileSync(
    new URL("../../.github/workflows/backtest.yml", import.meta.url), "utf8",
  );
  assert.ok(!/environment,\s*rest/i.test(WORKFLOW_SRC.replace(/\n\s*#/g, "")),
    "backtest.yml must not hand-list the candidate families — that list goes stale");
  assert.ok(!/EPA total\/pass/i.test(WORKFLOW_SRC.replace(/\n\s*#/g, "")),
    "backtest.yml must not hand-list the candidate families — that list goes stale");
  for (const n of names) {
    assert.ok(entry.source.includes(n), `source must name ${n}`);
  }
  assert.ok(entry.source.includes(`${names.length} candidate families`),
    "source states how many families the run put up");
});

test("R24: a blocked adoption is machine-readable in BOTH blocked cases", () => {
  // The degraded-incumbent block already wrote adoption_blocked; the
  // unwired-application-path (`pending`) block wrote only English prose, so a
  // consumer could not tell "the winner has no application path" from "nothing
  // was good enough" without parsing a sentence.
  const rules = [...PROMOTE_SRC.matchAll(/"rule":\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(rules.includes("degraded_incumbent"), "the degraded block is unchanged");
  assert.ok(rules.includes("unwired_application_path"),
    "the pending block records a machine-readable adoption_blocked too");
  // Both live inside an entry["adoption_blocked"] assignment, not in a comment.
  const assigns = (PROMOTE_SRC.match(/entry\["adoption_blocked"\] = \{/g) || []).length;
  assert.equal(assigns, 2, "exactly two adoption_blocked assignments: degraded + pending");
});

test("R24: is_cold_game reads the corpus gameday fallback, and invents nothing", () => {
  // The defect: load_finals() documents a `gameday` fallback for seasons with no
  // kickoff clock time, but is_cold_game read kickoff_utc only. All 259 games of
  // the 1999 corpus season were therefore classified not-cold — 61 of them are
  // cold-venue Nov-Feb dates — so the oldest end of the corpus contributed zero
  // cold residuals to the cold-HFA feature it is supposed to inform.
  const got = py(`
from scripts.promote_signals import is_cold_game, COLD_HOMES
corpus = json.load(open("data/fixtures/backtest_corpus/finals_1999.json"))["games"]
modern = json.load(open("data/fixtures/finals_2024.json"))["games"]
print(json.dumps({
  "corpus_1999_cold": sum(1 for g in corpus if is_cold_game(g)),
  "corpus_1999_kickoffs": sum(1 for g in corpus if g.get("kickoff_utc")),
  "modern_2024_cold": sum(1 for g in modern if is_cold_game(g)),
  "modern_2024_missing_kickoff": sum(1 for g in modern if not g.get("kickoff_utc")),
  "cold_home": is_cold_game({"home": "GB", "kickoff_utc": None, "gameday": "1999-12-05"}),
  "warm_month": is_cold_game({"home": "GB", "kickoff_utc": None, "gameday": "1999-09-05"}),
  "warm_venue": is_cold_game({"home": "MIA", "kickoff_utc": None, "gameday": "1999-12-05"}),
  "no_date_at_all": is_cold_game({"home": "GB", "kickoff_utc": None, "gameday": None}),
  "no_keys": is_cold_game({"home": "GB"}),
  "kickoff_wins": is_cold_game({"home": "GB", "kickoff_utc": "1999-09-05T17:00:00Z",
                                "gameday": "1999-12-05"}),
}))
`);
  assert.equal(got.corpus_1999_kickoffs, 0, "1999 really does carry no kickoff times");
  assert.equal(got.corpus_1999_cold, 61,
    "the 1999 corpus season contributes its cold games, read from `gameday`");
  assert.equal(got.cold_home, true, "a cold venue on a December gameday is cold");
  assert.equal(got.warm_month, false, "September is not cold");
  assert.equal(got.warm_venue, false, "Miami is never a cold venue");
  // HONEST DATA: no date at all is NOT cold. The fallback reads a date the
  // record already carries; it never invents one.
  assert.equal(got.no_date_at_all, false, "no date must never be treated as cold");
  assert.equal(got.no_keys, false, "a record with neither key must never crash or guess");
  assert.equal(got.kickoff_wins, false, "kickoff_utc wins when both are present");
  // BACKWARD COMPATIBILITY: the shipped 2021-2025 fixtures all carry kickoff_utc,
  // so the default (non-corpus) gate is byte-identical to before the fix.
  assert.equal(got.modern_2024_missing_kickoff, 0);
  assert.ok(got.modern_2024_cold > 0, "modern seasons still read their kickoffs");
});

test("R24: --referee-report exists, and is a diagnostic — never a family", () => {
  // SOLUTION_DESIGN R1 / 9.1 cut the referee FAMILY (the crew chief is 0/272 on
  // unplayed games, so it could never be applied) and paid for the cut with this
  // diagnostic. The safety half shipped; the payment did not, so the design and
  // the repo disagreed. This locks both halves.
  const tmp = mkdtempSync(join(tmpdir(), "refrep-"));
  const path = join(tmp, "model_tuning.json");
  copyFileSync(TUNING, path);
  const before = readFileSync(TUNING, "utf8");
  try {
    const got = py(`
import contextlib, io
import scripts.promote_signals as ps
ps.TUNING_PATH = ${JSON.stringify(path)}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    entry = ps.referee_report()
print(json.dumps({"entry": entry, "stdout": buf.getvalue()}))
`);
    const e = got.entry;
    assert.equal(e.kind, "referee_diagnostic");
    assert.equal(e.format, 1);
    assert.ok(!("families" in e), "the diagnostic never enters families[]");
    assert.ok(!("adopted" in e) && !("adopted_family" in e),
      "the diagnostic is not an adoption decision and must not look like one");
    assert.ok(/DIAGNOSTIC ONLY/.test(e.policy) && /never/.test(e.policy),
      "the entry states its own policy");
    assert.ok(e.crews > 0 && e.by_crew.length === e.crews);
    assert.ok(e.games_scored > 0);
    assert.equal(typeof e.games_without_crew_on_file, "number",
      "games with no crew on file are COUNTED, never imputed");
    assert.equal(e.shrink_n, 16, "the shrinkage is the module's shared SHRINK_N");
    for (const r of e.by_crew) {
      assert.ok(r.games > 0 && r.crew, "every row names a crew and its sample");
      // Shrinkage pulls toward zero, always.
      assert.ok(Math.abs(r.shrunk_home_residual) <= Math.abs(r.mean_home_residual) + 1e-9,
        `${r.crew}: the shrunk residual must not exceed the raw mean`);
    }
    // Ordered by |effect|, so the reader sees the case for a pregame feed first.
    for (let i = 1; i < e.by_crew.length; i += 1) {
      assert.ok(
        Math.abs(e.by_crew[i - 1].shrunk_home_residual)
          >= Math.abs(e.by_crew[i].shrunk_home_residual),
        "by_crew is ordered by absolute shrunk residual",
      );
    }
    // It wrote to the throwaway copy, not the shipped artifact.
    assert.equal(readFileSync(TUNING, "utf8"), before);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(doc.history[0].kind, "referee_diagnostic");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ...and referee is STILL not a family, in the gate or in the archive.
  const { entry } = runGate({ autoAdopt: false });
  assert.ok(!entry.families.some((f) => f.family === "referee"),
    "referee must never be registered as a candidate family");
});
