#!/usr/bin/env bash
# run_gate.sh — the ordered regression gate. 100% green before any deploy.
#
# Gates on EXIT CODES, in order (never on grepping colored summaries):
#   1. python3 scripts/validate_data.py     — data contracts + cross-file invariants
#   2. bash tests/smoke.sh                   — files exist, JSON parses, core invariants
#   3. node --test tests/feature/*.mjs       — the locked feature tests
#                                              (INCLUDES contrast_aa.test.mjs — WCAG AA)
#   4. Playwright web + pwa E2E              — OPT-IN: skipped-with-loud-note when
#                                              @playwright/test is not installed.
#
# THE FAST GATE (steps 1-3) STAYS DEPENDENCY-FREE: python3 stdlib + node built-ins
# only, no npm install. Step 4 needs Playwright + a browser and is therefore a
# dev/CI-only step: on a clean box it SKIPS loudly (does NOT fail the gate) so the
# zero-dep invariant holds. CI installs Playwright and runs it for real.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

step=0
fail=0

run_step() {
  step=$((step + 1))
  local name="$1"; shift
  echo "=================================================================="
  echo "GATE STEP ${step}: ${name}"
  echo "  \$ $*"
  echo "------------------------------------------------------------------"
  if "$@"; then
    echo "GATE STEP ${step} PASS: ${name}"
  else
    echo "GATE STEP ${step} FAIL: ${name}" >&2
    fail=1
  fi
}

# ---- Fast gate (dependency-free) -----------------------------------------
run_step "validate data contracts" python3 scripts/validate_data.py
run_step "smoke tests"             bash tests/smoke.sh
run_step "feature tests (incl. AA contrast)" node --test tests/feature/*.mjs

# ---- Step 4: browser E2E (web + pwa), opt-in -----------------------------
# Gated on the presence of @playwright/test so a clean box (no npm install) still
# runs a fully green fast gate. Point Chromium at the pre-installed full browser
# when it exists (headless_shell can't emulate everything the PWA spec needs).
step=$((step + 1))
echo "=================================================================="
echo "GATE STEP ${step}: browser E2E (playwright web + pwa)"
if [ -d "node_modules/@playwright/test" ]; then
  PW_FULL="/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  echo "  \$ npx playwright test --config tests/playwright.config.mjs"
  echo "------------------------------------------------------------------"
  if [ -x "$PW_FULL" ]; then
    export PW_CHROMIUM="$PW_FULL"
    echo "  (using pre-installed Chromium: $PW_FULL)"
  fi
  if npx playwright test --config tests/playwright.config.mjs; then
    echo "GATE STEP ${step} PASS: browser E2E"
  else
    echo "GATE STEP ${step} FAIL: browser E2E" >&2
    fail=1
  fi
else
  echo "------------------------------------------------------------------"
  echo "############################################################"
  echo "## GATE STEP ${step} SKIPPED — @playwright/test not installed."
  echo "## The FAST gate stays dependency-free; run the browser E2E with:"
  echo "##     npm install && npx playwright install --with-deps chromium"
  echo "##     npm run test:e2e   (or: bash tests/run_gate.sh after install)"
  echo "############################################################"
fi

echo "=================================================================="
if [ "$fail" -ne 0 ]; then
  echo "GATE RESULT: FAIL (red — do NOT deploy)" >&2
  exit 1
fi
echo "GATE RESULT: PASS (green)"
exit 0
