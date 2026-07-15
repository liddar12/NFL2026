#!/usr/bin/env bash
# run_gate.sh — the ordered regression gate. 100% green before any deploy.
#
# Gates on EXIT CODES, in order (never on grepping colored summaries):
#   1. python3 scripts/validate_data.py     — data contracts + cross-file invariants
#   2. bash tests/smoke.sh                   — files exist, JSON parses, core invariants
#   3. node --test tests/feature/*.mjs       — the locked feature tests
#
# TODO(Gate 2): once the frontend lands (Agent 7's index.html grows into the real
# UI), append a fourth step:
#     npx playwright test --config tests/playwright.config.mjs tests/ux
# Playwright is intentionally NOT part of the gate yet — there is no UI to drive,
# and the scaffold must stay dependency-free (no npm install to run the gate).
#
# Zero external deps: python3 stdlib + node built-ins only.
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

run_step "validate data contracts" python3 scripts/validate_data.py
run_step "smoke tests"             bash tests/smoke.sh
run_step "feature tests"           node --test tests/feature/*.mjs

echo "=================================================================="
if [ "$fail" -ne 0 ]; then
  echo "GATE RESULT: FAIL (red — do NOT deploy)" >&2
  exit 1
fi
echo "GATE RESULT: PASS (green)"
exit 0
