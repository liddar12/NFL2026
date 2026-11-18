import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const workflow = read('.github/workflows/data-ci.yml');
const publisher = fileURLToPath(new URL('scripts/publish_data.sh', root));
const gitEnv = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'gc.autoDetach', GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'maintenance.auto', GIT_CONFIG_VALUE_2: 'false',
  GIT_CONFIG_KEY_3: 'receive.autogc', GIT_CONFIG_VALUE_3: 'false',
};

function command(cwd, executable, args, env = {}) {
  const result = spawnSync(executable, args, {
    cwd, env: {...process.env, ...gitEnv, ...env}, encoding: 'utf8', timeout: 20000,
  });
  if (result.error) throw result.error;
  return {...result, output: result.stdout + result.stderr};
}

function git(cwd, ...args) {
  const result = command(cwd, 'git', args);
  assert.equal(result.status, 0, result.output);
  return result.stdout.trim();
}

function withRepo(run) {
  const directory = mkdtempSync(join(tmpdir(), 'nfl-published-sha-'));
  try {
    const remote = join(directory, 'origin.git');
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    const receipt = join(directory, 'published-data.txt');
    git(directory, 'init', '-q', '--bare', '--initial-branch=main', remote);
    git(directory, 'clone', '-q', remote, first);
    mkdirSync(join(first, 'data'));
    commit(first, 'seed.json', 'base');
    git(first, 'push', '-q', 'origin', 'main');
    git(directory, 'clone', '-q', remote, second);
    run({directory, remote, first, second, receipt, seed: git(first, 'rev-parse', 'HEAD')});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

function commit(repo, path, content) {
  writeFileSync(join(repo, 'data', path), content + '\n');
  git(repo, 'add', 'data');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', content);
  return git(repo, 'rev-parse', 'HEAD');
}

function publish(repo, receipt, env = {}) {
  return command(repo, 'bash', [publisher, 'data: isolated publish [skip actions]'], {
    PUBLISH_BRANCH: 'main', PUBLISH_RECEIPT_PATH: receipt, PUBLISH_VALIDATE_CMD: 'true',
    PUBLISH_BACKOFF_S: '0', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '4', ...env,
  });
}

function workflowShell(step) {
  const section = workflow.split(`name: ${step}\n`)[1];
  assert.ok(section, step);
  const shell = section.match(/^        run: \|\n((?:^ {10}.*\n)+)/m)?.[1];
  assert.ok(shell, step);
  return shell.replace(/^ {10}/gm, '');
}

const resolveCandidate = workflowShell('Resolve the exact commit under test');

function resolve(repo, directory, receipt, env = {}) {
  const output = join(directory, 'step-outputs');
  rmSync(output, {force: true});
  const result = command(repo, 'bash', ['-c', resolveCandidate], {
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_SHA: git(repo, 'rev-parse', 'HEAD'),
    PUBLISH_RUN_ID: '123', PUBLISH_RUN_ATTEMPT: '4', RECEIPT_PATH: receipt,
    GITHUB_OUTPUT: output, DISPATCH_SHA: '', ...env,
  });
  return {...result, stepOutput: existsSync(output) ? readFileSync(output, 'utf8') : ''};
}

test('a publication receipt identifies the rebased commit even after main advances', () => withRepo(
  ({directory, remote, first, second, receipt, seed}) => {
    const racingWriter = commit(first, 'race.json', 'other pipeline published first');
    git(first, 'push', '-q', 'origin', 'main');
    writeFileSync(join(second, 'data/published.json'), 'candidate\n');
    const published = publish(second, receipt);
    assert.equal(published.status, 0, published.output);
    assert.match(published.output, /re-creating this run's data commit/);
    const exact = git(remote, 'rev-parse', 'main');
    assert.notEqual(exact, seed);
    assert.equal(git(remote, 'rev-parse', 'main^'), racingWriter);
    assert.equal(readFileSync(receipt, 'utf8'), `123 4 ${exact}\n`);

    git(first, 'pull', '-q', '--ff-only');
    const later = commit(first, 'later.json', 'main advances before data-ci');
    git(first, 'push', '-q', 'origin', 'main');
    const result = resolve(first, directory, receipt);
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stepOutput, `sha=${exact}\n`);
    assert.doesNotMatch(result.output, new RegExp(later));
  },
));

test('an exact-run no-op yields no candidate and a failed publish leaves no receipt', () => withRepo(
  ({directory, remote, first, receipt, seed}) => {
    const noChange = publish(first, receipt);
    assert.equal(noChange.status, 0, noChange.output);
    assert.equal(readFileSync(receipt, 'utf8'), '123 4 noop\n');
    const noCandidate = resolve(first, directory, receipt);
    assert.equal(noCandidate.status, 0, noCandidate.output);
    assert.match(noCandidate.output, /no new commit/);
    assert.equal(noCandidate.stepOutput, '');
    assert.equal(publish(first, receipt).status, 1, 'a preexisting receipt is never reused');
    rmSync(receipt);
    writeFileSync(join(first, 'data/bad.json'), 'refused\n');
    const tag = publish(first, receipt, {GITHUB_REF: 'refs/tags/main'});
    assert.equal(tag.status, 1, tag.output);
    assert.match(tag.output, /source ref must match the publish branch/);
    assert.equal(git(first, 'rev-parse', 'HEAD'), seed);
    assert.equal(existsSync(receipt), false);
    const failed = publish(first, receipt, {PUBLISH_VALIDATE_CMD: 'false'});
    assert.equal(failed.status, 1, failed.output);
    assert.equal(git(remote, 'rev-parse', 'main'), seed);
    assert.equal(existsSync(receipt), false);
  },
));

test('missing, wrong-run, wrong-attempt and malformed receipts cannot supply a SHA', () => withRepo(
  ({directory, first, receipt, seed}) => {
    const missing = resolve(first, directory, receipt);
    assert.equal(missing.status, 1, missing.output);
    assert.equal(missing.stepOutput, '');
    for (const record of [
      `124 4 ${seed}\n`, `123 3 ${seed}\n`, '123 3 noop\n', `123 4 ${seed} extra\n`,
      `123 4 ${seed}\n\n`, `123 4 ${seed}`, `123\t4 ${seed}\n`,
      '123 4 main\n', '123 4 0000000000000000000000000000000000000000\n',
    ]) {
      writeFileSync(receipt, record);
      const result = resolve(first, directory, receipt);
      assert.equal(result.status, 1, JSON.stringify({record, output: result.output}));
      assert.equal(result.stepOutput, '');
    }
    rmSync(receipt);
    const otherPath = join(directory, 'other.txt');
    writeFileSync(otherPath, `123 4 ${seed}\n`);
    symlinkSync(otherPath, receipt);
    const link = resolve(first, directory, receipt);
    assert.equal(link.status, 1, link.output);
    assert.equal(link.stepOutput, '');
  },
));

test('manual dispatch uses its immutable event SHA or a full explicitly selected main SHA', () => withRepo(
  ({directory, first, receipt, seed}) => {
    git(first, 'checkout', '-qb', 'unpublished');
    const unpublished = commit(first, 'local.json', 'not on main');
    git(first, 'checkout', '-q', 'main');
    const dispatched = commit(first, 'dispatch.json', 'main at dispatch');
    commit(first, 'later.json', 'main when worker starts');
    const manual = {GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: dispatched};
    const selected = resolve(first, directory, receipt, manual);
    assert.equal(selected.status, 0, selected.output);
    assert.equal(selected.stepOutput, `sha=${dispatched}\n`);
    const older = resolve(first, directory, receipt, {...manual, DISPATCH_SHA: seed});
    assert.equal(older.status, 0, older.output);
    assert.equal(older.stepOutput, `sha=${seed}\n`);
    const blob = git(first, 'rev-parse', 'HEAD:data/seed.json');
    for (const sha of [unpublished, blob, 'main', seed.slice(0, 7)]) {
      const rejected = resolve(first, directory, receipt, {...manual, DISPATCH_SHA: sha});
      assert.equal(rejected.status, 1, rejected.output);
      assert.equal(rejected.stepOutput, '');
    }
  },
));

test('producers and the downloader use the same attempt-scoped receipt contract', () => {
  for (const name of ['daily', 'gameday', 'backtest']) {
    const producer = read(`.github/workflows/${name}.yml`);
    const capture = producer.indexOf('bash scripts/capture_grading_inputs.sh');
    assert.ok(capture >= 0 && capture < producer.indexOf('python -m scripts.resolve_locks'), name);
    assert.ok(producer.includes('path: ${{ env.NFL_GRADING_CAPTURE_DIR }}'), name);
    assert.match(producer, /PUBLISH_RECEIPT_PATH: \$\{\{ runner.temp \}\}\/published-data.txt/);
    const upload = producer.split('Retain exact published commit for Data CI')[1];
    assert.match(upload, /github.ref == 'refs\/heads\/main'/);
    assert.match(upload, /name: published-data-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
    assert.match(upload, /path: \$\{\{ runner.temp \}\}\/published-data.txt/);
    assert.match(upload, /if-no-files-found: error/);
  }
  assert.match(workflow, /head_repository.id == github.event.repository.id/);
  assert.match(workflow, /name: published-data-\$\{\{ github.event.workflow_run.id \}\}-\$\{\{ github.event.workflow_run.run_attempt \}\}/);
  assert.match(workflow, /run-id: \$\{\{ github.event.workflow_run.id \}\}/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/data-ci-receipt/);
  assert.match(workflow, /RECEIPT_PATH: \$\{\{ runner.temp \}\}\/data-ci-receipt\/published-data.txt/);
});

test('issue reporting preserves test exit codes and only updates the issue for current main', () => withRepo(
  ({directory, seed}) => {
    const gh = join(directory, 'gh');
    const calls = join(directory, 'gh-calls');
    writeFileSync(gh, [
      '#!/bin/bash',
      'printf "%s %s\\n" "$1" "${2:-}" >> "$GH_CALLS"',
      'if [ "$1" = api ]; then printf "%s\\n" "$CURRENT_SHA"; fi',
      'if [ "$1" = issue ] && [ "$2" = list ]; then printf "%s\\n" "$OPEN_ISSUE"; fi',
      'exit 0',
    ].join('\n'), {mode: 0o700});
    const report = workflowShell('Open, update or close the data-ci issue');
    function run(overrides = {}) {
      rmSync(calls, {force: true});
      const result = command(directory, 'bash', ['-c', report], {
        PATH: directory + ':' + process.env.PATH, GH_CALLS: calls, CURRENT_SHA: seed, OPEN_ISSUE: '7',
        GH_REPO: 'owner/repo', DATA_CI_TITLE: 'test title', GATE: 'success', E2E: 'success',
        RESOLUTION: 'success', SHA: seed, SOURCE: 'test', SOURCE_URL: 'test', RUN_URL: 'test',
        ...overrides,
      });
      return {...result, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : ''};
    }
    for (const [overrides, status, issueCall] of [
      [{}, 0, /issue close/],
      [{GATE: 'failure'}, 1, /issue comment/],
      [{GATE: 'failure', OPEN_ISSUE: ''}, 1, /issue create/],
    ]) {
      const result = run(overrides);
      assert.equal(result.status, status, result.output);
      assert.match(result.calls, issueCall);
    }
    const historical = run({GATE: 'failure', CURRENT_SHA: 'b'.repeat(40)});
    assert.equal(historical.status, 1, historical.output);
    assert.match(historical.output, new RegExp(seed));
    assert.doesNotMatch(historical.calls, /issue /);
    for (const [overrides, status] of [
      [{SHA: '', GATE: 'skipped', E2E: 'skipped'}, 0],
      [{RESOLUTION: 'failure', SHA: '', GATE: 'skipped', E2E: 'skipped'}, 1],
      [{GATE: 'cancelled'}, 0],
    ]) {
      const result = run(overrides);
      assert.equal(result.status, status, result.output);
      assert.equal(result.calls, '');
    }
  },
));
