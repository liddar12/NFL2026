/* tests/feature/gate_config.test.mjs — QA-D8: the gate's own configuration is
 * asserted by a test that is NOT the artifact under test.
 *
 * Six acceptance criteria across two ✅ stories used to name tests/run_gate.sh
 * or .github/workflows/ci.yml as proof of properties OF THAT SAME FILE —
 * editing the file edited its own "test", and the coverage matrix counted the
 * file as testing itself. This file parses both artifacts from the outside, so
 * the four-step order, the exit-code discipline, the fast gate's zero-dependency
 * invariant, and the e2e split are pinned by something that can actually fail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

/* ==========================================================================
   tests/run_gate.sh — order + exit-code semantics (P8-S3-AC1/AC2, P1-S5-AC3)
   ========================================================================== */

test("run_gate.sh runs the four steps in the documented order", () => {
  const sh = read("tests/run_gate.sh");
  const steps = [
    /run_step "validate data contracts"\s+python3 scripts\/validate_data\.py/,
    /run_step "smoke tests"\s+bash tests\/smoke\.sh/,
    /run_step "feature tests \(incl\. AA contrast\)" node --test tests\/feature\/\*\.mjs/,
    /npx playwright test --config tests\/playwright\.config\.mjs/,
  ];
  let at = -1;
  for (const re of steps) {
    const m = sh.slice(at + 1).search(re);
    assert.ok(m >= 0, `gate step missing or out of order: ${re}`);
    at += 1 + m;
  }
});

test("run_gate.sh gates every step on its EXIT CODE, never by grepping output", () => {
  const sh = read("tests/run_gate.sh");
  // The pass/fail branch is the command's own exit status...
  assert.match(sh, /if "\$@"; then/,
    'run_step must branch on the command itself (`if "$@"`), not on parsed output');
  // ...and no non-comment line greps anything. ("grepping"/"grep colored" in
  // the header comments are the documentation OF this rule, so comments are
  // stripped before the assertion.)
  const code = sh.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/\bgrep\b/.test(code),
    "a grep in run_gate.sh means a step is being judged by its output again");
  // A red step must fail the whole gate with a non-zero exit.
  assert.match(sh, /fail=1/);
  assert.match(sh, /if \[ "\$fail" -ne 0 \]; then\s*\n\s*echo "GATE RESULT: FAIL[^"]*" >&2\s*\n\s*exit 1/,
    "the FAIL path must exit 1 — a red gate that exits 0 is a green gate");
  assert.match(sh, /set -uo pipefail/);
});

test("run_gate.sh step 4 skips LOUDLY without failing — the documented fast-gate semantics (P9-S4)", () => {
  // Deliberate, stated behaviour (QA-D8-AC3): on a clean box the fast gate
  // (steps 1-3) stays dependency-free and step 4 SKIPS with a shouting banner;
  // "GATE RESULT: PASS (green)" therefore means steps 1-3 locally, and CI is
  // where e2e is mandatory (the separate `e2e` job — merges wait for BOTH).
  // P9-S4 states this in prose; this case pins it.
  const sh = read("tests/run_gate.sh");
  const skip = sh.match(/else\n(\s*echo[^\n]*\n)+fi/);
  assert.ok(skip, "the playwright-absent branch must exist");
  assert.match(skip[0], /SKIPPED/, "the skip must shout, not whisper");
  assert.ok(!/fail=1/.test(skip[0]),
    "the skip branch must not fail the gate — the zero-dep fast-gate invariant");
  assert.match(sh, /\[ -d "node_modules\/@playwright\/test" \]/,
    "step 4 is gated on the package being installed");
});

/* ==========================================================================
   .github/workflows/ci.yml — the split-job invariant (P8-S3-AC3, P9-S4-AC1/AC2)
   ========================================================================== */

function ciJobs() {
  const yml = read(".github/workflows/ci.yml");
  const jobs = yml.slice(yml.search(/^jobs:/m));
  const gate = jobs.slice(jobs.search(/^ {2}gate:/m), jobs.search(/^ {2}e2e:/m));
  const e2e = jobs.slice(jobs.search(/^ {2}e2e:/m));
  assert.ok(gate.length > 0 && e2e.length > 0, "ci.yml must define gate and e2e jobs");
  return { gate, e2e };
}

test("ci.yml's gate job invokes run_gate.sh and installs NOTHING first", () => {
  const { gate } = ciJobs();
  assert.match(gate, /run: bash tests\/run_gate\.sh/,
    "the gate job must run the single source of truth, not re-list the steps");
  const code = gate.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!/npm (i|ci|install)|pip install|playwright install/.test(code),
    "a dependency install inside the gate job erodes the zero-dep fast-gate "
    + "invariant — if a fast-gate step needs a package, the step is wrong");
});

test("ci.yml's e2e job is the ONE place dependencies are installed, and it runs the browser suite", () => {
  const { e2e } = ciJobs();
  assert.match(e2e, /run: npm i\b/);
  assert.match(e2e, /run: npx playwright install --with-deps chromium/);
  assert.match(e2e, /run: npm run test:e2e/);
});

test("ci.yml runs on pushes to main and on pull requests (a merge cannot dodge the gate)", () => {
  const yml = read(".github/workflows/ci.yml");
  assert.match(yml, /on:\s*\n\s*push:\s*\n\s*branches: \[main\]/);
  assert.match(yml, /pull_request:\s*\n\s*branches: \[main\]/);
});
