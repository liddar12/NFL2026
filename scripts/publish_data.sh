#!/usr/bin/env bash
# publish_data.sh — commit data/ and get it onto main, whoever else is pushing.
#
# WHY THIS EXISTS (F16). Every pipeline workflow used to end with the same loop:
# commit locally, then retry `pull (fast-forward only) && push` five times. That
# loop can only ever succeed while WE are the only writer. The moment another
# writer has a commit from the same base — daily and gameday sit in different
# concurrency groups, and the owner can land code on main at any time — both
# sides have commits, a fast-forward pull is impossible by definition, and
# repeating it five times changes nothing. A successful, validated generation
# was then thrown away with exit 1.
#
# The fix is to stop trying to fast-forward and instead RE-CREATE this run's
# single data commit on top of whatever landed:
#
#   1. stage data/, commit once (nothing staged -> exit 0, there was no news);
#   2. fetch main. If it is an ancestor of HEAD, push and we are done;
#   3. otherwise rebase our one data commit onto the new head. Every conflicted
#      path is resolved DETERMINISTICALLY, never interactively:
#        * an append-only ledger is merged BY IDENTITY (scripts/merge_ledgers.py)
#          from the three stages, so neither writer's locks are lost;
#        * a snapshot under data/snapshots/ that is NOT a *_games_open.json lock
#          receipt aborts loudly: every other snapshot is a per-run immutable
#          file, so a conflict on one is an anomaly, not something to resolve;
#        * any other path under data/ takes OURS — this run just regenerated it
#          from the newest inputs, so its version is the newest valid one;
#        * a conflict outside data/ aborts loudly: a pipeline commit touches no
#          code, so a code conflict means something is wrong that no rule here
#          should paper over;
#   4. the merged tree must pass the data contracts before it can be pushed. It
#      fails -> the rebase is aborted and the run exits 1. A document that fails
#      validation is never published, no matter how much work produced it;
#   5. push. Rejected (someone landed between the fetch and the push)? Loop.
#
# Bounded at 5 attempts, then one ::error:: line and exit 1 — an explicit,
# visible failure, not a silent one. This never rewrites the remote (no forced
# push, with or without a lease) and never resets another writer's commit: the
# only history it ever rewrites is the local commit it created itself.
#
# Usage:  bash scripts/publish_data.sh "data: daily pipeline refresh [skip actions]"
#
# Env (test seams; the defaults are what production runs):
#   PUBLISH_VALIDATE_CMD  the contract gate            (default: python3 scripts/validate_data.py)
#   PUBLISH_BACKOFF_S     seconds between attempts     (default: 5)
#   PUBLISH_ATTEMPTS      how many attempts            (default: 5)
#
# Docs: docs/PUBLISH.md.
set -euo pipefail

BOT_NAME="nfl2026-bot"
BOT_EMAIL="bot@j5lagenticstrategy.com"

VALIDATE_CMD="${PUBLISH_VALIDATE_CMD:-python3 scripts/validate_data.py}"
BACKOFF_S="${PUBLISH_BACKOFF_S:-5}"
ATTEMPTS="${PUBLISH_ATTEMPTS:-5}"

# The ledger merger lives beside this script; git, however, always operates on
# the CHECKOUT WE WERE CALLED IN. Never cd anywhere: the repo being published is
# the current working directory, and nothing here may touch another one.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_LEDGERS="$HERE/merge_ledgers.py"

log()  { echo "publish: $*"; }

# Set by replay_onto when it had to resolve conflicts (and therefore already ran
# the contract gate on the merged tree). A CLEAN rebase is validated too: every
# file is then wholly one side's, but the contracts also check joins ACROSS
# files, and this run's documents have never been seen beside the other
# writer's.
REBASE_RESOLVED=0

# A hard stop: abort any rebase left in progress so the checkout is exactly as
# it was before this attempt, say why on one ::error:: line, and leave main
# untouched.
die() {
  if rebase_in_progress; then
    git rebase --abort || true
    log "rebase aborted; the checkout is back on this run's own commit"
  fi
  echo "::error::$*"
  exit 1
}

rebase_in_progress() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] ||
  [ -d "$(git rev-parse --git-path rebase-apply)" ]
}

# Is this path one of the append-only ledgers? The patterns mirror the shape
# registry in scripts/merge_ledgers.py; that script refuses anything it does not
# recognise, so a drift between the two fails loudly instead of merging badly.
# data/parlays/index.json is deliberately NOT here: it is rebuilt from the
# per-week archives every run, so it is regenerable like everything else.
is_ledger() {
  case "$1" in
    data/estimates/*.json)          return 0 ;;
    data/my_cards/*.json)           return 0 ;;
    data/parlays/*_wk*.json)        return 0 ;;
    data/model_tuning.json)         return 0 ;;
    # One block per WORKFLOW, and both workflows commit it: taking either whole
    # side erased the other workflow's entire per-stage record (G05).
    data/pipeline_stages.json)      return 0 ;;
    # The lock receipts are the ONE snapshot two writers legitimately both edit
    # -- one grades a row from a FINAL score while the other appends a new lock
    # -- so they are merged by event_id, never resolved to a side (G06). Every
    # other snapshot is refused below.
    data/snapshots/*_games_open.json) return 0 ;;
    *)                              return 1 ;;
  esac
}

# What the merge of this path actually did, for the log. One line per shape,
# because "both writers' entries kept" is not true of every shape: the week
# archive keeps both sides' FROZEN cards but takes the live week from the newer
# generation, and pipeline_stages is keyed per workflow, not per entry.
ledger_rule() {
  case "$1" in
    data/parlays/*_wk*.json)
      echo "merged by identity (both sides' frozen cards kept; the live week from the newer generation)" ;;
    data/pipeline_stages.json)
      echo "merged per workflow (each workflow's own block and last_success kept)" ;;
    data/snapshots/*_games_open.json)
      echo "merged by event_id (both writers' lock rows kept; a graded row stays graded)" ;;
    *)
      echo "merged by identity (both writers' entries kept)" ;;
  esac
}

# Write one conflict stage to a file. Prints the file's path, or "-" when that
# stage does not exist (one side added or deleted the file), which is exactly
# what merge_ledgers.py reads as "this stage is absent".
stage_file() {
  local stage="$1" path="$2" dest="$3"
  if git ls-files -u -- "$path" | awk '{print $3}' | grep -qx "$stage"; then
    git show ":${stage}:${path}" > "$dest"
    echo "$dest"
  else
    echo "-"
  fi
}

resolve_conflicts() {
  local tmp path base theirs ours
  tmp="$(mktemp -d)"
  # No pipeline: `while read` must run in THIS shell so a die() inside it exits
  # the script rather than a subshell.
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in
      data/*) ;;
      *) die "conflict outside data/ on '$path'. A pipeline commit changes only data/, so this is a code collision no automatic rule should resolve. Re-run the workflow once main is settled, or resolve it by hand." ;;
    esac

    if is_ledger "$path"; then
      base="$(stage_file 1 "$path" "$tmp/base.json")"
      theirs="$(stage_file 2 "$path" "$tmp/theirs.json")"
      ours="$(stage_file 3 "$path" "$tmp/ours.json")"
      # Stage 2 is the head we are replaying ONTO (the other writer's version)
      # and stage 3 is the commit being replayed (ours). That is the opposite of
      # the everyday merge sense of the words, and getting it backwards would
      # publish the other run's regenerable data as if it were ours.
      if ! python3 "$MERGE_LEDGERS" "$base" "$theirs" "$ours" \
             --path "$path" --out "$path"; then
        die "could not merge the append-only ledger '$path' by identity. Nothing was published; the generation is intact in the run's checkout."
      fi
      log "  $path: $(ledger_rule "$path")"
    elif [ "${path#data/snapshots/}" != "$path" ]; then
      # The lock receipts were merged above. Everything else under data/snapshots/
      # is a per-run immutable file whose name is unique to its run
      # (game_predictions.<ts>.json), so two writers cannot legitimately both
      # write one and there is no rule that could resolve it. Taking a side here
      # used to log "taking this run's grading" for a run that had graded nothing
      # (G06); this is the same rule merge_ledgers.py states, stated once.
      die "conflict on the snapshot '$path'. Only the lock receipts (data/snapshots/*_games_open.json) are merged, by event_id; every other snapshot is a per-run immutable file, so a conflict on one means something else is wrong. Nothing was published; this run's generation is intact in its checkout."
    else
      take_ours "$path"
      log "  $path: regenerable, taking this run's version"
    fi
    git add -A -- "$path"
  done <<< "$(git diff --name-only --diff-filter=U)"
  rm -rf "$tmp"
}

# OURS during a rebase is stage 3: the commit being replayed, i.e. this run.
take_ours() {
  local path="$1" tmp src
  tmp="$(mktemp)"
  src="$(stage_file 3 "$path" "$tmp")"
  if [ "$src" = "-" ]; then
    rm -f "$tmp"
    git rm --quiet -- "$path"          # this run deleted it; keep that deletion
  else
    mkdir -p "$(dirname "$path")"
    mv "$tmp" "$path"
  fi
}

replay_onto() {
  local onto="$1"
  REBASE_RESOLVED=0
  if git -c core.editor=true rebase "$onto"; then
    return 0
  fi
  rebase_in_progress || die "rebase onto $onto failed before it reached a conflict. The checkout is unchanged and nothing was published."

  while rebase_in_progress; do
    REBASE_RESOLVED=1
    resolve_conflicts

    # Validate the MERGED tree while the rebase can still be abandoned. This is
    # the only moment where both are true: the tree is what would be published,
    # and abandoning it costs nothing.
    if ! eval "$VALIDATE_CMD"; then
      die "the merged tree fails the data contracts, so it is not published. This run's generation and the other writer's commit are both intact; re-run the pipeline against the new head."
    fi

    if git diff --cached --quiet; then
      # Everything we generated is already on the new head: our commit is empty
      # now, so there is nothing to replay.
      log "  this run's changes are already on the new head; dropping the empty commit"
      git -c core.editor=true rebase --skip || die "could not drop the empty commit during the rebase."
    else
      git -c core.editor=true rebase --continue || die "could not continue the rebase after resolving every conflicted path."
    fi
  done
  return 0
}

main() {
  if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    echo "usage: bash scripts/publish_data.sh \"<commit message>\"" >&2
    exit 2
  fi
  local message="$1" attempt remote

  git config user.name  "$BOT_NAME"
  git config user.email "$BOT_EMAIL"

  git add data/
  if git diff --cached --quiet; then
    echo "No data changes to commit."
    exit 0
  fi
  git commit -q -m "$message"
  log "committed $(git rev-parse --short HEAD): $message"

  for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
    if ! git fetch --quiet origin main; then
      die "could not fetch origin/main (attempt $attempt). Nothing was published; this run's generation is committed locally."
    fi
    remote="$(git rev-parse FETCH_HEAD)"

    if ! git merge-base --is-ancestor "$remote" HEAD; then
      log "attempt $attempt: main moved to $(git rev-parse --short "$remote") while this run was working; re-creating this run's data commit on top of it"
      replay_onto "$remote"
      log "attempt $attempt: replayed onto $(git rev-parse --short "$remote"); head is now $(git rev-parse --short HEAD)"
      if [ "$REBASE_RESOLVED" -eq 0 ] && ! eval "$VALIDATE_CMD"; then
        die "the tree replayed onto $(git rev-parse --short "$remote") fails the data contracts, so it is not published. Nothing on main changed; re-run the pipeline against the new head."
      fi
      if git merge-base --is-ancestor "$remote" HEAD; then
        :
      else
        die "after the rebase, $(git rev-parse --short "$remote") is still not an ancestor of HEAD. Refusing to push a head that would not fast-forward."
      fi
    fi

    if git push origin HEAD:main; then
      log "attempt $attempt: published $(git rev-parse --short HEAD) to main"
      exit 0
    fi
    log "attempt $attempt: push rejected -- another writer landed between the fetch and the push; retrying"
    if [ "$attempt" -lt "$ATTEMPTS" ]; then
      sleep "$BACKOFF_S"
    fi
  done

  echo "::error::could not publish data after $ATTEMPTS attempts: main is being written faster than this run can rebase onto it. The generation is committed locally in the runner's checkout and nothing was lost on main; re-run the workflow."
  exit 1
}

main "$@"
