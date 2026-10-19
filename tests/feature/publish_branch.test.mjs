import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = new URL('../../', import.meta.url);
const script = fileURLToPath(new URL('scripts/publish_data.sh', root));
const branch = 'release/candidate';
function git(cwd, ...args) {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
function publish(cwd, target) {
  const env = {...process.env, PUBLISH_VALIDATE_CMD: 'true', PUBLISH_BACKOFF_S: '0'};
  delete env.PUBLISH_BRANCH;
  if (target !== undefined) env.PUBLISH_BRANCH = target;
  const result = spawnSync('/bin/bash', [script, 'data: isolated publish'], {cwd, env, encoding: 'utf8', timeout: 20000});
  return {...result, output: result.stdout + result.stderr};
}
function world(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'nfl-publish-branch-'));
  try {
    const remote = join(directory, 'remote.git'), a = join(directory, 'a'), b = join(directory, 'b');
    git(directory, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    git(directory, 'init', '--quiet', '--initial-branch=main', a);
    git(a, 'config', 'user.name', 'fixture');
    git(a, 'config', 'user.email', 'fixture@example.invalid');
    for (const repo of [remote, a]) {
      git(repo, 'config', 'gc.auto', '0');
      git(repo, 'config', 'maintenance.auto', 'false');
      git(repo, 'config', 'gc.autoDetach', 'false');
      git(repo, 'config', 'receive.autogc', 'false');
    }
    mkdirSync(join(a, 'data'));
    writeFileSync(join(a, 'data/probe.json'), '{"generation":0}\n');
    git(a, 'add', '.');
    git(a, 'commit', '--quiet', '-m', 'seed');
    git(a, 'remote', 'add', 'origin', remote);
    git(a, 'push', '--quiet', 'origin', 'main', `main:refs/heads/${branch}`);
    git(directory, 'clone', '--quiet', '--branch', branch, remote, b);
    git(b, 'config', 'gc.auto', '0');
    git(b, 'config', 'maintenance.auto', 'false');
    git(b, 'config', 'gc.autoDetach', 'false');
    callback({remote, a, b});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}
const change = repo => writeFileSync(join(repo, 'data/probe.json'), '{"generation":1}\n');
const head = (repo, name = 'main') => git(repo, 'rev-parse', `refs/heads/${name}`);

test('release publish advances only the chosen release branch, including a concurrent code commit', () => world(({remote, a, b}) => {
  const mainBefore = head(remote);
  git(a, 'checkout', '--quiet', branch);
  writeFileSync(join(a, 'owner.txt'), 'concurrent owner change\n');
  git(a, 'add', '.');
  git(a, 'commit', '--quiet', '-m', 'owner release change');
  git(a, 'push', '--quiet', 'origin', branch);
  const owner = head(remote, branch);
  change(b);
  const result = publish(b, branch);
  assert.equal(result.status, 0, result.output);
  assert.equal(head(remote), mainBefore, 'release rehearsal must not change main');
  assert.equal(git(remote, 'rev-parse', `${branch}~1`), owner);
  assert.match(result.output, /release\/candidate moved to/);
  assert.match(result.output, /to release\/candidate/);
  assert.equal(git(remote, 'show', `${branch}:data/probe.json`), '{"generation":1}');
  assert.equal(git(remote, 'show', `${branch}:owner.txt`), 'concurrent owner change');
}));

test('unset target preserves default main publication and leaves release unchanged', () => world(({remote, a}) => {
  const releaseBefore = head(remote, branch);
  change(a);
  const result = publish(a);
  assert.equal(result.status, 0, result.output);
  assert.notEqual(head(remote), releaseBefore);
  assert.equal(head(remote, branch), releaseBefore);
  assert.match(result.output, /to main/);
}));

test('deleted remote release branch rejects stale local tracking and never falls back to main', () => world(({remote, b}) => {
  const mainBefore = head(remote);
  git(b, 'rev-parse', `refs/remotes/origin/${branch}`);
  git(remote, 'update-ref', '-d', `refs/heads/${branch}`);
  change(b);
  const result = publish(b, branch);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /could not fetch origin\/release\/candidate/);
  assert.equal(head(remote), mainBefore);
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/release/'), '');
}));

test('invalid or explicitly empty targets reject before config, staging, commit or remote changes', () => world(({remote, b}) => {
  change(b);
  const configPath = join(b, '.git/config');
  const configBefore = readFileSync(configPath, 'utf8');
  const headBefore = git(b, 'rev-parse', 'HEAD');
  const refsBefore = git(remote, 'show-ref');
  const statusBefore = git(b, 'status', '--porcelain');
  for (const target of ['', 'other', 'main:other', '-main', 'refs/heads/main', 'release/', 'release/../main', 'release/a b', 'release/a\nb', 'release/a.lock', 'release/a:main', 'release/a@{b']) {
    const result = publish(b, target);
    assert.equal(result.status, 2, JSON.stringify({target, output: result.output}));
    assert.match(result.output, /invalid publish branch/);
    assert.equal(readFileSync(configPath, 'utf8'), configBefore);
    assert.equal(git(b, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(b, 'status', '--porcelain'), statusBefore);
    assert.equal(git(b, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(remote, 'show-ref'), refsBefore);
  }
}));

test('daily and gameday scope their ref-name target to the publish step only', () => {
  for (const name of ['daily', 'gameday']) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}.yml`, root), 'utf8');
    assert.equal((workflow.match(/PUBLISH_BRANCH:/g) ?? []).length, 1);
    assert.match(workflow, /      - name: Commit [^\n]+\n        env:\n          PUBLISH_BRANCH: \$\{\{ github.ref_name \}\}\n        run: 'bash scripts\/publish_data.sh /);
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /schedule:/);
  }
});
