#!/usr/bin/env bash
# stage.sh — run one pipeline step and write down what happened (R88, F17).
#
# Usage:
#   bash scripts/stage.sh [--continue-on-error] <workflow> <stage name> -- <command...>
#
# WHY. Several pipeline steps are `continue-on-error`, so a failed resolver or a
# failed replay lab leaves the run GREEN and the only evidence in the Actions
# log. This wrapper runs the real command, records the stage's outcome in
# data/pipeline_stages.json (scripts/stage_status.py) and then EXITS WITH THE
# COMMAND'S OWN EXIT CODE — so the step's `continue-on-error:` keeps exactly the
# meaning it had before, and a step without one still reds the run.
#
# Two things it deliberately does NOT do: it does not capture or buffer the
# command's stdout/stderr (the Actions log stays the log), and it never fails a
# step because the bookkeeping failed — an unwritable record is a warning, not a
# new way to break the pipeline.
#
# STAGE_STATUS_PATH points the record elsewhere (tests use a temp file).

# NOT `set -e`: the whole point is to survive the command's failure and report
# it. `pipefail` is off for the same reason — the command's own status is what
# we propagate, unmodified.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "stage.sh: $*" >&2; exit 64; }

continue_on_error=""
if [ "${1:-}" = "--continue-on-error" ]; then
  continue_on_error="--continue-on-error"
  shift
fi

[ $# -ge 4 ] || die "usage: stage.sh [--continue-on-error] <workflow> <stage name> -- <command...>"
workflow="$1"; shift
stage="$1"; shift
[ "$1" = "--" ] || die "expected -- before the command, got: $1"
shift
[ $# -ge 1 ] || die "no command after --"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

started="$(stamp)"
# The command runs in THIS shell's stdout/stderr: nothing is swallowed.
"$@"
code=$?
finished="$(stamp)"

python3 "$HERE/stage_status.py" record \
  --workflow "$workflow" \
  --stage "$stage" \
  --exit-code "$code" \
  --started "$started" \
  --finished "$finished" \
  ${GITHUB_RUN_ID:+--run-id "$GITHUB_RUN_ID"} \
  ${continue_on_error:+$continue_on_error} \
  || echo "stage.sh: WARNING could not record stage '$stage' (the step's own result stands)" >&2

exit "$code"
