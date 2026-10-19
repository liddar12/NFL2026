#!/usr/bin/env bash
# Run from the owner's normal terminal. No global Git/gh configuration changes.
# Default: prepare and verify the release. --publish-main also fast-forwards main
# to the exact verified SHA, only if main has not moved since preparation.
set -euo pipefail

REPO=liddar12/NFL2026
NETWORK_REMOTE=https://github.com/liddar12/NFL2026.git
BRANCH=release/selected-fixes-20261018
SOURCE_BASE=9a537b9fdf5776d280f22549b1cb4aceb0b45458
SOURCE_COMMIT=3de293f55d3d97f238c99436bb4ad62c0c48857c
SOURCE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE=
ARTIFACTS=
DISPATCH_RUN_ID=

fail() { echo "ERROR: $*" >&2; return 1; }
git_owner() { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
assert_main_unchanged() {
  git_owner -C "$WORKTREE" fetch --quiet "$NETWORK_REMOTE" main
  [ "$(git -C "$WORKTREE" rev-parse FETCH_HEAD)" = "$START_MAIN" ] || fail 'Main moved; stop and rebuild/revalidate against its new head.'
}
apply_selected_patch() {
  local source_repo="$1" base="$2" candidate="$3" destination="$4" patch="$5"
  # The reviewed source-only patch includes schemas under data/contracts/.
  git -C "$source_repo" diff --binary "$base" "$candidate" > "$patch"
  [ -s "$patch" ] || fail 'Selected patch is empty.'
  git -C "$destination" apply --3way --index "$patch"
}
validate_source_head() {
  local repository="$1" reviewed="$2" candidate="$3" path
  git -C "$repository" merge-base --is-ancestor "$reviewed" "$candidate" || fail 'Local HEAD does not contain the reviewed functional release.'
  while IFS= read -r path; do
    case "$path" in docs/*) ;; *) fail "Unreviewed functional change after the selected release: $path"; return 1;; esac
  done < <(git -C "$repository" diff --name-only "$reviewed" "$candidate")
}
validate_generated_delta() {
  local repository="$1" source="$2" generated="$3" path count=0
  git -C "$repository" merge-base --is-ancestor "$source" "$generated" || fail 'Generated head lost the reviewed source commit.'
  [ "$source" != "$generated" ] || fail 'Daily did not produce a new data commit; freshness is unverified.'
  while IFS= read -r path; do
    case "$path" in
      data/contracts/*) fail "Daily changed a reviewed source contract: $path"; return 1;;
      data/*) count=$((count + 1));;
      *) fail "Daily changed source outside data/: $path"; return 1;;
    esac
  done < <(git -C "$repository" diff --name-only "$source" "$generated")
  [ "$count" -gt 0 ] || fail 'Daily produced no data changes.'
}
require_no_fallback() {
  if grep -q "regenerable files lost to the other writer" "$1"; then
    fail 'Daily published fallback data; stop and inspect.'
    return 1
  fi
}
require_run_identity() {
  local run="$1" sha="$2" workflow="$3" identity
  identity="$(gh run view "$run" --repo "$REPO" --json headSha,headBranch,event,workflowName --jq '[.headSha,.headBranch,.event,.workflowName] | @tsv')"
  [ "$identity" = "$(printf '%s\t%s\tworkflow_dispatch\t%s' "$sha" "$BRANCH" "$workflow")" ] || fail "Run $run identity differs from the requested branch/SHA/workflow."
}
require_ci_jobs() {
  local run="$1" sha="$2" rows
  require_run_identity "$run" "$sha" ci
  [ "$(gh run view "$run" --repo "$REPO" --json conclusion --jq .conclusion)" = success ] || fail 'CI did not conclude success.'
  rows="$(gh run view "$run" --repo "$REPO" --json jobs --jq '.jobs[] | [.name,.conclusion] | @tsv' | LC_ALL=C sort)"
  [ "$rows" = "$(printf 'e2e\tsuccess\ngate\tsuccess\nregression (core)\tsuccess\nregression (features)\tsuccess')" ] || fail 'CI must contain exactly successful gate, e2e, core and features jobs; no skips count as acceptance.'
}
dispatch_and_watch() {
  local workflow="$1" sha="$2" label="$3" before ids id attempt
  before="$(gh run list --repo "$REPO" --workflow "$workflow" --branch "$BRANCH" --event workflow_dispatch --limit 100 --json databaseId --jq '.[].databaseId')"
  gh workflow run "$workflow" --repo "$REPO" --ref "$BRANCH" >&2
  for ((attempt=0; attempt<60; attempt++)); do
    ids="$(gh run list --repo "$REPO" --workflow "$workflow" --branch "$BRANCH" --event workflow_dispatch --limit 100 --json databaseId,headSha --jq ".[] | select(.headSha == \"$sha\") | .databaseId")"
    id=
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      if ! printf '%s\n' "$before" | grep -qx "$candidate"; then
        [ -z "$id" ] || fail 'Ambiguous simultaneous dispatches; inspect runs before continuing.'
        id="$candidate"
      fi
    done <<< "$ids"
    if [ -n "$id" ]; then
      require_run_identity "$id" "$sha" "$label"
      gh run watch "$id" --repo "$REPO" --exit-status >&2
      DISPATCH_RUN_ID="$id"
      return
    fi
    sleep 10
  done
  fail "No matching $workflow run appeared within ten minutes."
}
resume_verified() {
  ARTIFACTS="$1"
  WORKTREE="$ARTIFACTS/worktree"
  local source_sha generated_sha daily_run ci_run value
  IFS=$'\t' read -r START_MAIN source_sha generated_sha daily_run ci_run < "$ARTIFACTS/proof.tsv"
  for value in "$START_MAIN" "$source_sha" "$generated_sha"; do
    [ "${#value}" -eq 40 ] && [[ "$value" != *[!0-9a-f]* ]] || fail 'Invalid saved SHA.'
  done
  for value in "$daily_run" "$ci_run"; do case "$value" in ''|*[!0-9]*) fail 'Invalid saved run ID.'; return 1;; esac; done
  trap 'result=$?; echo "Preserved worktree: $WORKTREE; evidence: $ARTIFACTS (exit $result)" >&2' EXIT
  git_owner -C "$WORKTREE" fetch --quiet "$NETWORK_REMOTE" "$BRANCH"
  [ "$(git -C "$WORKTREE" rev-parse FETCH_HEAD)" = "$generated_sha" ] || fail 'Release moved since verification.'
  validate_generated_delta "$WORKTREE" "$source_sha" "$generated_sha"
  require_run_identity "$daily_run" "$source_sha" daily-pipeline
  [ "$(gh run view "$daily_run" --repo "$REPO" --json conclusion --jq .conclusion)" = success ] || fail 'Saved daily run is not successful.'
  gh run view "$daily_run" --repo "$REPO" --log > "$ARTIFACTS/daily-resume.log"
  require_no_fallback "$ARTIFACTS/daily-resume.log"
  require_ci_jobs "$ci_run" "$generated_sha"
  assert_main_unchanged
  git -C "$WORKTREE" merge-base --is-ancestor "$START_MAIN" "$generated_sha"
  git_owner -C "$WORKTREE" push "$NETWORK_REMOTE" "$generated_sha:refs/heads/main"
  printf 'Main fast-forwarded to tested SHA %s. Netlify production status: PENDING verification.\n' "$generated_sha" | tee -a "$ARTIFACTS/handoff.txt"
}

main() {
  local publish_main=no verified_artifacts= daily_run ci_run generated_sha source_sha remote_branch pr_url
  if [ "$#" -ge 1 ] && [ "$#" -le 2 ] && [ "$1" = --publish-main ]; then publish_main=yes; verified_artifacts="${2-}"
  elif [ "$#" -ne 0 ]; then fail 'Usage: bash publish-selected-fixes-20261018.sh [--publish-main [verified-artifact-directory]]'; return 2; fi
  command -v gh >/dev/null
  command -v git >/dev/null
  # Obtain the personal token for this process without switching global auth.
  GH_TOKEN="$(gh auth token --hostname github.com --user liddar12)"
  GH_HOST=github.com
  export GH_TOKEN GH_HOST
  [ "$(gh api user --jq .login)" = liddar12 ] || fail 'Personal GitHub identity is not liddar12.'
  if [ -n "$verified_artifacts" ]; then resume_verified "$verified_artifacts"; return; fi
  local reviewed_source="$SOURCE_COMMIT"
  SOURCE_COMMIT="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
  # Include final helper/evidence/handoff docs, without accepting later code.
  validate_source_head "$SOURCE_REPO" "$reviewed_source" "$SOURCE_COMMIT"
  # Explicit canonical URL also works in a bundle-restored checkout whose origin
  # points at a local bundle. Never rewrite the owner's remote configuration.
  git_owner -C "$SOURCE_REPO" fetch --quiet "$NETWORK_REMOTE" main
  START_MAIN="$(git -C "$SOURCE_REPO" rev-parse FETCH_HEAD)"
  git_owner -C "$SOURCE_REPO" fetch --quiet "$NETWORK_REMOTE" "$BRANCH"
  remote_branch="$(git -C "$SOURCE_REPO" rev-parse FETCH_HEAD)"
  git -C "$SOURCE_REPO" merge-base --is-ancestor "$remote_branch" "$START_MAIN" || fail 'Remote release branch contains independent changes; do not overwrite it.'
  ARTIFACTS="$(mktemp -d "${TMPDIR:-/tmp}/nfl-selected-release.XXXXXX")"
  WORKTREE="$ARTIFACTS/worktree"
  trap 'result=$?; echo "Preserved worktree: $WORKTREE; evidence: $ARTIFACTS (exit $result)" >&2' EXIT
  git -C "$SOURCE_REPO" worktree add --detach "$WORKTREE" "$START_MAIN"
  apply_selected_patch "$SOURCE_REPO" "$SOURCE_BASE" "$SOURCE_COMMIT" "$WORKTREE" "$ARTIFACTS/selected.patch"
  local personal_id
  personal_id="$(gh api user --jq .id)"
  case "$personal_id" in ''|*[!0-9]*) fail 'Invalid personal GitHub user ID.'; return 1;; esac
  git -C "$WORKTREE" -c user.name=liddar12 -c "user.email=$personal_id+liddar12@users.noreply.github.com" commit -m 'Deploy reviewed injury, scanner, telemetry, inactive, CI and weather fixes'
  source_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
  assert_main_unchanged
  git_owner -C "$WORKTREE" push "$NETWORK_REMOTE" "HEAD:refs/heads/$BRANCH"
  pr_url="$(gh pr list --repo "$REPO" --head "$BRANCH" --base main --state open --json url --jq '.[].url')"
  if [ -z "$pr_url" ]; then
    pr_url="$(gh pr create --repo "$REPO" --head "$BRANCH" --base main --draft --title 'Deploy selected NFL fixes' --body 'Selected source changes; data refresh and exact-SHA release CI evidence are retained by the operator helper. No production learning activation.')"
  fi
  dispatch_and_watch daily.yml "$source_sha" daily-pipeline
  daily_run="$DISPATCH_RUN_ID"
  gh run view "$daily_run" --repo "$REPO" --log > "$ARTIFACTS/daily.log"
  require_no_fallback "$ARTIFACTS/daily.log"
  git_owner -C "$WORKTREE" fetch --quiet "$NETWORK_REMOTE" "$BRANCH"
  generated_sha="$(git -C "$WORKTREE" rev-parse FETCH_HEAD)"
  validate_generated_delta "$WORKTREE" "$source_sha" "$generated_sha"
  # [skip actions] in generated commits can suppress PR CI. Dispatch explicitly.
  dispatch_and_watch ci.yml "$generated_sha" ci
  ci_run="$DISPATCH_RUN_ID"
  require_ci_jobs "$ci_run" "$generated_sha"
  gh run view "$ci_run" --repo "$REPO" --log > "$ARTIFACTS/ci.log"
  git_owner -C "$WORKTREE" fetch --quiet "$NETWORK_REMOTE" "$BRANCH"
  [ "$(git -C "$WORKTREE" rev-parse FETCH_HEAD)" = "$generated_sha" ] || fail 'Release moved after the tested SHA; stop and revalidate.'
  assert_main_unchanged
  git -C "$WORKTREE" merge-base --is-ancestor "$START_MAIN" "$generated_sha"
  printf '%s\t%s\t%s\t%s\t%s\n' "$START_MAIN" "$source_sha" "$generated_sha" "$daily_run" "$ci_run" > "$ARTIFACTS/proof.tsv"
  printf 'PR: %s\nDaily source SHA: %s (run %s)\nTested release SHA: %s (CI %s)\n' "$pr_url" "$source_sha" "$daily_run" "$generated_sha" "$ci_run" | tee "$ARTIFACTS/handoff.txt"
  if [ "$publish_main" = yes ]; then
    # Normal fast-forward push; protected-branch refusal is final, never bypassed.
    git_owner -C "$WORKTREE" push "$NETWORK_REMOTE" "$generated_sha:refs/heads/main"
    printf 'Main fast-forwarded to tested SHA. Netlify production status: PENDING verification.\n' | tee -a "$ARTIFACTS/handoff.txt"
  else
    echo 'Release verified and ready for review. Main has not been published.' | tee -a "$ARTIFACTS/handoff.txt"
    printf 'To recheck exact CI/release SHA and unchanged main, then publish:\n  bash %q --publish-main %q\n' "$SOURCE_REPO/docs/releases/publish-selected-fixes-20261018.sh" "$ARTIFACTS"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
