// Local Git and stub-only proof. Never calls GitHub or pushes external refs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const script = fileURLToPath(new URL('./publish-selected-fixes-20261018.sh', import.meta.url));
function shell(code, env = {}) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"\n' + code, 'operator-test', script], {
    encoding: 'utf8', timeout: 10000, env: {...process.env, ...env},
  });
}
function git(cwd, ...args) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('actual three-way patch preserves newer main UI/data and only conflicts stop application', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nfl-operator-proof-'));
  try {
    const repo = join(directory, 'source'), destination = join(directory, 'prepared');
    git(directory, 'init', '--quiet', '--initial-branch=main', repo);
    git(repo, 'config', 'user.name', 'local fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'config', 'gc.auto', '0');
    mkdirSync(join(repo, 'app/views'), {recursive: true});
    mkdirSync(join(repo, 'data/contracts'), {recursive: true});
    writeFileSync(join(repo, 'app/main.js'), 'old selected code\n');
    writeFileSync(join(repo, 'app/views/parlays.js'), 'old public UX\n');
    writeFileSync(join(repo, 'data/current.json'), '{"public":1}\n');
    writeFileSync(join(repo, 'data/contracts/test.schema.json'), '{"version":1}\n');
    git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '--quiet', '-b', 'candidate');
    writeFileSync(join(repo, 'app/main.js'), 'selected code fix\n');
    writeFileSync(join(repo, 'data/contracts/test.schema.json'), '{"version":2}\n');
    git(repo, 'commit', '--quiet', '-am', 'selected source');
    const candidate = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(repo, 'docs/releases'), {recursive: true});
    writeFileSync(join(repo, 'docs/releases/handoff.md'), 'Final operator handoff\n');
    git(repo, 'add', '.'); git(repo, 'commit', '--quiet', '-m', 'final docs');
    const documented = git(repo, 'rev-parse', 'HEAD');
    const validateHead = head => shell('validate_source_head "$TEST_REPO" "$TEST_REVIEWED" "$TEST_HEAD"', {TEST_REPO: repo, TEST_REVIEWED: candidate, TEST_HEAD: head});
    assert.equal(validateHead(documented).status, 0, 'final docs/helper commits are accepted');
    assert.notEqual(validateHead(base).status, 0, 'reviewed functional ancestor is required');
    writeFileSync(join(repo, 'app/main.js'), 'unreviewed functional change\n');
    git(repo, 'commit', '--quiet', '-am', 'unreviewed source');
    assert.notEqual(validateHead(git(repo, 'rev-parse', 'HEAD')).status, 0, 'later functional changes are rejected');
    git(repo, 'checkout', '--quiet', 'main');
    writeFileSync(join(repo, 'app/views/parlays.js'), 'new public PR181 UX\n');
    writeFileSync(join(repo, 'data/current.json'), '{"public":2}\n');
    git(repo, 'commit', '--quiet', '-am', 'new public code and data');
    const publicHead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'remote', 'add', 'origin', repo); // local-only remote for main guard
    git(repo, 'worktree', 'add', '--quiet', '--detach', destination, publicHead);
    const env = {TEST_REPO: repo, TEST_DEST: destination, TEST_BASE: base, TEST_CANDIDATE: documented, TEST_PATCH: join(directory, 'selected.patch')};
    const applied = shell('apply_selected_patch "$TEST_REPO" "$TEST_BASE" "$TEST_CANDIDATE" "$TEST_DEST" "$TEST_PATCH"', env);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(destination, 'app/views/parlays.js'), 'utf8'), 'new public PR181 UX\n');
    assert.equal(readFileSync(join(destination, 'data/current.json'), 'utf8'), '{"public":2}\n');
    assert.equal(readFileSync(join(destination, 'app/main.js'), 'utf8'), 'selected code fix\n');
    assert.equal(readFileSync(join(destination, 'data/contracts/test.schema.json'), 'utf8'), '{"version":2}\n');
    assert.equal(readFileSync(join(destination, 'docs/releases/handoff.md'), 'utf8'), 'Final operator handoff\n');
    git(destination, 'commit', '--quiet', '-m', 'prepared source');
    const source = git(destination, 'rev-parse', 'HEAD');
    const guard = () => shell('WORKTREE="$TEST_DEST"; START_MAIN="$TEST_BASE_MAIN"; NETWORK_REMOTE="$TEST_REPO"; git_owner() { git "$@"; }; assert_main_unchanged', {...env, TEST_BASE_MAIN: publicHead});
    assert.equal(guard().status, 0, 'unchanged remote main is accepted');
    writeFileSync(join(destination, 'data/current.json'), '{"generated":3}\n');
    git(destination, 'commit', '--quiet', '-am', 'generated data');
    const generated = git(destination, 'rev-parse', 'HEAD');
    const validate = (a, b) => shell('validate_generated_delta "$TEST_DEST" "$TEST_SOURCE" "$TEST_GENERATED"', {...env, TEST_SOURCE: a, TEST_GENERATED: b});
    assert.equal(validate(source, generated).status, 0);
    assert.notEqual(validate(source, source).status, 0, 'unchanged data is not fresh acceptance');
    assert.notEqual(validate(candidate, generated).status, 0, 'unrelated source identity is rejected');
    writeFileSync(join(destination, 'data/contracts/test.schema.json'), '{"version":3}\n');
    git(destination, 'commit', '--quiet', '-am', 'bad generated contract');
    assert.notEqual(validate(source, git(destination, 'rev-parse', 'HEAD')).status, 0, 'daily cannot rewrite reviewed source contracts');
    writeFileSync(join(destination, 'app/main.js'), 'unexpected generated code\n');
    git(destination, 'commit', '--quiet', '-am', 'bad generation');
    assert.notEqual(validate(source, git(destination, 'rev-parse', 'HEAD')).status, 0);
    assert.equal(git(repo, 'rev-parse', 'main'), publicHead, 'proof never mutates public main');
    writeFileSync(join(repo, 'app/main.js'), 'conflicting newer main code\n');
    git(repo, 'commit', '--quiet', '-am', 'conflict');
    assert.notEqual(guard().status, 0, 'new remote main requires rebuild and revalidation');
    const conflicting = join(directory, 'conflicting');
    git(repo, 'worktree', 'add', '--quiet', '--detach', conflicting, 'main');
    assert.notEqual(shell('apply_selected_patch "$TEST_REPO" "$TEST_BASE" "$TEST_CANDIDATE" "$TEST_DEST" "$TEST_PATCH"', {...env, TEST_DEST: conflicting}).status, 0);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('fallback-published data cannot become release acceptance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nfl-operator-log-'));
  try {
    const log = join(directory, 'daily.log');
    writeFileSync(log, 'pipeline completed normally\n');
    assert.equal(shell('require_no_fallback "$TEST_LOG"', {TEST_LOG: log}).status, 0);
    writeFileSync(log, '::warning::published this run\'s ledger entries and snapshots, but its regenerable files lost to the other writer\'s\n');
    assert.notEqual(shell('require_no_fallback "$TEST_LOG"', {TEST_LOG: log}).status, 0);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

const stub = `
gh() {
  case "$*" in
    *'--json headSha,headBranch,event,workflowName'*) printf '%s\\t%s\\t%s\\t%s\\n' "$TEST_SHA" "$TEST_BRANCH" "$TEST_EVENT" "$TEST_WORKFLOW" ;;
    *'--json conclusion'*) printf '%s\\n' "$TEST_CONCLUSION" ;;
    *'--json jobs'*) printf '%b\\n' "$TEST_JOBS" ;;
    *) echo 'Unexpected stub gh invocation' >&2; return 99 ;;
  esac
}
require_ci_jobs 123 "$EXPECTED_SHA"
echo VERIFIED
`;
const ciEnv = {
  TEST_SHA: 'a'.repeat(40), EXPECTED_SHA: 'a'.repeat(40), TEST_BRANCH: 'release/selected-fixes-20261018',
  TEST_EVENT: 'workflow_dispatch', TEST_WORKFLOW: 'ci', TEST_CONCLUSION: 'success',
  TEST_JOBS: 'gate\tsuccess\ne2e\tsuccess\nregression (features)\tsuccess\nregression (core)\tsuccess',
};
test('exact-SHA CI proof rejects skipped/missing/failed jobs, wrong SHA/ref/event and overall failure', () => {
  assert.equal(shell(stub, ciEnv).status, 0);
  for (const delta of [
    {TEST_SHA: 'b'.repeat(40)}, {TEST_BRANCH: 'main'}, {TEST_EVENT: 'pull_request'},
    {TEST_CONCLUSION: 'failure'}, {TEST_WORKFLOW: 'data-ci'},
    {TEST_JOBS: ciEnv.TEST_JOBS.replace('e2e\tsuccess', 'e2e\tskipped')},
    {TEST_JOBS: ciEnv.TEST_JOBS.replace('regression (core)\tsuccess', 'regression (core)\tfailure')},
    {TEST_JOBS: 'gate\tsuccess'},
  ]) {
    const result = shell(stub, {...ciEnv, ...delta});
    assert.notEqual(result.status, 0, JSON.stringify(delta));
    assert.doesNotMatch(result.stdout, /VERIFIED/);
  }
});

test('dispatch watch failure stops before any acceptance handoff', () => {
  const result = shell(`
gh() {
  case "$*" in
    *'--json databaseId --jq'*) echo 1 ;;
    *'--json databaseId,headSha'*) echo 2 ;;
    *'workflow run'*) return 0 ;;
    *'--json headSha,headBranch,event,workflowName'*) printf '%s\\t%s\\tworkflow_dispatch\\tci\\n' "$EXPECTED_SHA" "$BRANCH" ;;
    *'run watch'*) return 1 ;;
    *) return 99 ;;
  esac
}
dispatch_and_watch ci.yml "$EXPECTED_SHA" ci
echo UNSAFE_CONTINUATION
`, {EXPECTED_SHA: 'a'.repeat(40)});
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /UNSAFE_CONTINUATION/);
});

test('saved green handoff rechecks all guards before exactly one normal main push', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nfl-operator-resume-'));
  try {
    mkdirSync(join(directory, 'worktree'));
    const main = 'c'.repeat(40), source = 'b'.repeat(40), generated = 'a'.repeat(40);
    writeFileSync(join(directory, 'proof.tsv'), [main, source, generated, '123', '456'].join('\t') + '\n');
    const code = `
git_owner() {
  case "$*" in
    *' fetch '*) for target do :; done; printf '%s' "$target" > "$TEST_ARTIFACTS/fetched" ;;
    *' push '*) printf '%s\\n' "$*" >> "$TEST_ARTIFACTS/pushed" ;;
    *) return 99 ;;
  esac
}
git() {
  case "$*" in
    *'rev-parse FETCH_HEAD'*) if [ "$(< "$TEST_ARTIFACTS/fetched")" = main ]; then echo "$TEST_MAIN"; else echo "$TEST_RELEASE"; fi ;;
    *'merge-base --is-ancestor'*) return "$TEST_ANCESTRY_FAIL" ;;
    *'diff --name-only'*) echo data/current.json ;;
    *) return 99 ;;
  esac
}
gh() {
  case "$*" in
    *'--json headSha,headBranch,event,workflowName'*)
      if [ "$3" = 123 ]; then printf '%s\\t%s\\tworkflow_dispatch\\tdaily-pipeline\\n' "$TEST_SOURCE" "$BRANCH"
      else printf '%s\\t%s\\tworkflow_dispatch\\tci\\n' "$TEST_RELEASE" "$BRANCH"; fi ;;
    *'--json conclusion'*) echo "$TEST_CONCLUSION" ;;
    *'--json jobs'*) printf '%b\\n' "$TEST_JOBS" ;;
    *'--log'*) echo "$TEST_LOG" ;;
    *) return 99 ;;
  esac
}
resume_verified "$TEST_ARTIFACTS"
`;
    const env = {...ciEnv, TEST_ARTIFACTS: directory, TEST_MAIN: main, TEST_SOURCE: source, TEST_RELEASE: generated, TEST_LOG: 'normal generation', TEST_ANCESTRY_FAIL: '0'};
    for (const delta of [
      {TEST_MAIN: 'd'.repeat(40)}, {TEST_RELEASE: 'e'.repeat(40)}, {TEST_CONCLUSION: 'failure'},
      {TEST_JOBS: ciEnv.TEST_JOBS.replace('e2e\tsuccess', 'e2e\tskipped')},
      {TEST_LOG: 'regenerable files lost to the other writer'}, {TEST_ANCESTRY_FAIL: '1'},
    ]) {
      const result = shell(code, {...env, ...delta});
      assert.notEqual(result.status, 0, JSON.stringify(delta));
      assert.throws(() => readFileSync(join(directory, 'pushed')), 'no push may precede failed guards');
    }
    const result = shell(code, env);
    assert.equal(result.status, 0, result.stderr);
    const pushed = readFileSync(join(directory, 'pushed'), 'utf8');
    assert.equal(pushed.trim().split('\n').length, 1);
    assert.ok(pushed.includes(`${generated}:refs/heads/main`));
    assert.doesNotMatch(pushed, /--force|--admin/);
    assert.match(result.stdout, /Netlify production status: PENDING verification/);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
