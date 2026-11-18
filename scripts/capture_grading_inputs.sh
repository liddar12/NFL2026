#!/usr/bin/env bash
# Run under stage.sh so capture failures remain visible in pipeline telemetry.
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
export NFL_GRADING_CAPTURE_DIR="$RUNNER_TEMP/grading-inputs-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
printf 'NFL_GRADING_CAPTURE_DIR=%s\n' "$NFL_GRADING_CAPTURE_DIR" >> "$GITHUB_ENV"
season="$(python3 -c 'import json; print(json.load(open("data/schedule_full.json"))["season"])')"
python3 scripts/capture_grading_inputs.py --season "$season" --output "$NFL_GRADING_CAPTURE_DIR"
