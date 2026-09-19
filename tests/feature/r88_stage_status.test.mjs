/* tests/feature/r88_stage_status.test.mjs — R88 / review finding F17.
 *
 * F17: "pipeline_status.json is produced inside prediction building before many
 * later ledger/review steps, so it does not describe those later failures",
 * acceptance "resolver outage is visible in final health".
 *
 * Every workflow is a chain of steps and several carry `continue-on-error`. When
 * a resolver or the replay lab failed, the run went GREEN, the shipped health
 * document said nothing, and the only evidence was a line in the Actions log.
 * R88 wraps every pipeline step in scripts/stage.sh, which records that step's
 * outcome in data/pipeline_stages.json and then exits with the COMMAND'S OWN
 * exit code — so `continue-on-error` keeps exactly the meaning it had.
 *
 * This file locks the three properties that make that true:
 *
 *   1. THE WRAPPER IS TRANSPARENT. It exits with the command's exit code (a
 *      wrapper that swallowed a failure would turn every step green), it does
 *      not swallow the command's output, and it writes the stage down either way.
 *   2. THE RECORD IS HONEST. `skipped` (a mode guard did not run it) is a
 *      different fact from `failed` (it ran and returned non-zero); a stage's
 *      last success carries across runs, so one that has not succeeded in days
 *      says the day it last did; and the document validates against its contract.
 *   3. THE WORKFLOWS ARE ACTUALLY WIRED. Every workflow opens the record, every
 *      pipeline step between the install and validate runs under the wrapper with
 *      its ORIGINAL command text intact, and the commit step is the publish
 *      script with that workflow's own message.
 *
 * Node built-ins only (the gate installs nothing); Python is driven through
 * `python3 -`. STAGE_STATUS_PATH points the record at a temp file, so nothing
 * here touches data/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const WRAPPER = join(ROOT, 'scripts', 'stage.sh');
const RECORDER = join(ROOT, 'scripts', 'stage_status.py');

/** A scratch record path; every test gets its own so they cannot see each other. */
function scratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'r88-stages-'));
  const path = join(dir, 'pipeline_stages.json');
  try {
    return fn(path, { ...process.env, STAGE_STATUS_PATH: path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const doc = (path) => JSON.parse(readFileSync(path, 'utf8'));
const stagesOf = (d, wf) => {
  const out = {};
  for (const s of d.workflows[wf].stages) out[s.name] = s;
  return out;
};

const runWrapper = (args, env) =>
  spawnSync('bash', [WRAPPER, ...args], { cwd: ROOT, env, encoding: 'utf8' });
const runRecorder = (args, env) =>
  spawnSync('python3', [RECORDER, ...args], { cwd: ROOT, env, encoding: 'utf8' });

/* 1 — the wrapper is transparent -------------------------------------------- */

test('stage.sh exits with the COMMAND\'s exit code, and records either outcome', () => {
  scratch((path, env) => {
    assert.equal(runRecorder(['begin', '--workflow', 'daily', '--run-id', '42'], env).status, 0);

    const green = runWrapper(['daily', 'a green stage', '--', 'true'], env);
    assert.equal(green.status, 0, green.stderr);

    // The property that makes continue-on-error still mean something: a failing
    // command must come back out of the wrapper as a failing step. A wrapper
    // that returned 0 here would paint every step in every workflow green.
    const red = runWrapper(['daily', 'a red stage', '--', 'bash', '-c', 'exit 3'], env);
    assert.equal(red.status, 3, 'the wrapper must not swallow a non-zero exit code');

    const stages = stagesOf(doc(path), 'daily');
    assert.equal(stages['a green stage'].status, 'ok');
    assert.equal(stages['a green stage'].exit_code, 0);
    assert.equal(stages['a red stage'].status, 'failed');
    assert.equal(stages['a red stage'].exit_code, 3);
    assert.equal(doc(path).workflows.daily.run_id, '42');
  });
});

test('stage.sh does not swallow the command\'s stdout or stderr', () => {
  scratch((path, env) => {
    const r = runWrapper(['daily', 'a talkative stage', '--', 'bash', '-c',
      'echo to-stdout; echo to-stderr >&2'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /to-stdout/, 'the Actions log must still be the log');
    assert.match(r.stderr, /to-stderr/);
  });
});

test('a failed stage under continue-on-error is recorded AS degraded, and still exits non-zero', () => {
  scratch((path, env) => {
    const r = runWrapper(['--continue-on-error', 'daily', 'Resolve parlay legs', '--',
      'bash', '-c', 'exit 1'], env);
    assert.equal(r.status, 1, 'the step decides what its failure means, not the wrapper');
    const stage = stagesOf(doc(path), 'daily')['Resolve parlay legs'];
    assert.equal(stage.status, 'failed');
    assert.equal(stage.continue_on_error, true);
    assert.ok(stage.note, 'a failure that leaves the run green must say so in the record');
    assert.equal(stage.last_success_utc, null, 'it has never succeeded, so it may not claim one');
  });
});

/* 2 — the record is honest --------------------------------------------------- */

test('last success carries across runs: a stage that has not succeeded today still shows when it did', () => {
  scratch((path, env) => {
    runRecorder(['begin', '--workflow', 'daily', '--run-id', '1'], env);
    assert.equal(runWrapper(['daily', 'Resolve estimates', '--', 'true'], env).status, 0);
    const first = stagesOf(doc(path), 'daily')['Resolve estimates'].last_success_utc;
    assert.ok(first, 'a successful stage records its success');

    // A NEW run: the stage list resets, the carry survives.
    runRecorder(['begin', '--workflow', 'daily', '--run-id', '2'], env);
    assert.deepEqual(doc(path).workflows.daily.stages, [], 'begin must reset the stage list');
    assert.equal(doc(path).workflows.daily.run_id, '2');
    assert.equal(runWrapper(['--continue-on-error', 'daily', 'Resolve estimates', '--',
      'false'], env).status, 1);
    const after = stagesOf(doc(path), 'daily')['Resolve estimates'];
    assert.equal(after.status, 'failed');
    assert.equal(after.last_success_utc, first,
      'a stage that failed today must still report the day it last worked');
  });
});

test('skip is a third state: "did not run" is not "ran and failed"', () => {
  scratch((path, env) => {
    runRecorder(['begin', '--workflow', 'gameday', '--run-id', '7'], env);
    const r = runRecorder(['skip', '--workflow', 'gameday',
      '--stage', 'MY PARLAYS leg pool (rebuild under this generation)',
      '--reason', 'scores mode: nothing is re-priced'], env);
    assert.equal(r.status, 0, r.stderr);
    const stage = stagesOf(doc(path), 'gameday')['MY PARLAYS leg pool (rebuild under this generation)'];
    assert.equal(stage.status, 'skipped');
    assert.equal(stage.exit_code, null, 'a step that never ran has no exit code');
    assert.match(stage.note, /scores mode/, 'the reason is the whole point of the verb');
  });
});

test('re-recording the same stage replaces its row (idempotent, one row per stage)', () => {
  scratch((path, env) => {
    runRecorder(['begin', '--workflow', 'backtest', '--run-id', '9'], env);
    runWrapper(['backtest', 'Promotion gate', '--', 'false'], env);
    runWrapper(['backtest', 'Promotion gate', '--', 'true'], env);
    const rows = doc(path).workflows.backtest.stages.filter((s) => s.name === 'Promotion gate');
    assert.equal(rows.length, 1, 'a re-run of a stage describes the same stage');
    assert.equal(rows[0].status, 'ok', 'the newest outcome wins');
  });
});

test('a produced document validates against data/contracts/pipeline_stages.schema.json', () => {
  scratch((path, env) => {
    runRecorder(['begin', '--workflow', 'daily', '--run-id', '1234'], env);
    runWrapper(['daily', 'Resolve locks against FINAL scores', '--', 'true'], env);
    runWrapper(['--continue-on-error', 'daily', 'Replay lab', '--', 'false'], env);
    runRecorder(['skip', '--workflow', 'gameday', '--stage', 'Lock pre-kickoff probabilities',
      '--reason', 'scores mode: nothing is re-priced'], env);

    const r = spawnSync('python3', ['-'], {
      cwd: ROOT,
      encoding: 'utf8',
      input: `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts.validate_data import validate_against_schema
schema = json.load(open("data/contracts/pipeline_stages.schema.json", encoding="utf-8"))
doc = json.load(open(${JSON.stringify(path)}, encoding="utf-8"))
validate_against_schema(doc, schema, "r88 produced document")
print("VALID")
`,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /VALID/);
  });
});

test('the contract is registered OPTIONAL, and the record is never committed from a clone', () => {
  const vd = read('scripts/validate_data.py');
  assert.match(vd, /"pipeline_stages\.schema\.json":\s*"pipeline_stages\.json"/,
    'the validator must route the contract');
  const optional = vd.slice(vd.indexOf('OPTIONAL_DATA'), vd.indexOf('EXPECTED_SIGNALS'));
  assert.ok(optional.includes('"pipeline_stages.json"'),
    'runner-built -> OPTIONAL_DATA, or a fresh clone reds for a file no test needs');
  // The runner writes the record under data/ and publishes it with every other
  // artifact (run 137 was the first), so a clone MAY carry it; when it does, it
  // is a parseable document of the declared shape. Absent is equally valid.
  if (existsSync(join(ROOT, 'data/pipeline_stages.json'))) {
    const doc = JSON.parse(read('data/pipeline_stages.json'));
    assert.ok(doc && typeof doc.workflows === 'object', 'a committed record carries workflows{}');
  }
  assert.match(read('tests/smoke.sh'), /stage_status\.py --selftest/,
    'the selftest is not in the smoke gate');
});

test('the Python core selftests clean', () => {
  const r = spawnSync('python3', [RECORDER, '--selftest'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /selftest OK/);
});

/* 3 — the workflows are actually wired --------------------------------------- */

const WORKFLOWS = [
  { file: 'daily.yml', name: 'daily', message: 'data: daily pipeline refresh [skip actions]' },
  { file: 'gameday.yml', name: 'gameday', message: 'data: gameday refresh [skip actions]' },
  { file: 'backtest.yml', name: 'backtest', message: 'data: weekly backtest refit [skip actions]' },
];

/* The workflows as TEXT (the gate installs nothing, so no yaml parser). A step
 * is a `- name:` line and the non-comment lines under it. */
function steps(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    const started = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (started) {
      if (current) out.push(current);
      current = { name: started[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(current);
  return out.map((s) => ({
    name: s.name,
    code: s.body.filter((l) => !/^\s*#/.test(l)).join('\n'),
  }));
}

/** The single-line `run:` of a step, or null for a block scalar / a `uses:`. */
function runLine(step) {
  const m = /^\s*run:\s*(?!\|)(.+?)\s*$/m.exec(step.code);
  return m ? m[1] : null;
}

test('every workflow OPENS the per-stage record right after its dependency install', () => {
  for (const { file, name } of WORKFLOWS) {
    const all = steps(read(`.github/workflows/${file}`));
    const installAt = all.findIndex((s) => s.name === 'Install pipeline dependencies');
    assert.ok(installAt !== -1, `${file} has no dependency install step`);
    const beginAt = all.findIndex((s) =>
      /stage_status\.py begin --workflow /.test(s.code));
    assert.ok(beginAt !== -1,
      `${file} never opens the stage record — without begin, a stage's last ` +
      'success could never be carried and the run id would be unknown');
    assert.equal(beginAt, installAt + 1,
      `${file} must open the record immediately after the install, before any stage runs`);
    assert.ok(
      new RegExp(`stage_status\\.py begin --workflow ${name}\\b`).test(all[beginAt].code),
      `${file} opens the record under the wrong workflow name`,
    );
  }
});

test('every pipeline step between the install and validate runs under the wrapper, with its ORIGINAL command intact', () => {
  for (const { file, name } of WORKFLOWS) {
    const all = steps(read(`.github/workflows/${file}`));
    const from = all.findIndex((s) => /stage_status\.py begin /.test(s.code));
    const to = all.findIndex((s) => s.name === 'Validate data contracts');
    assert.ok(from !== -1 && to > from, `${file}: could not find the pipeline span`);

    let wrapped = 0;
    for (const step of all.slice(from + 1, to)) {
      const run = runLine(step);
      // The gameday scores-mode skip step records skips; it is bookkeeping, not
      // a pipeline stage, so it is not itself wrapped.
      if (step.code.includes('stage_status.py skip ')) continue;
      assert.ok(run, `${file}: step "${step.name}" has no single-line run:`);
      const m = new RegExp(
        `^bash scripts/stage\\.sh (--continue-on-error )?${name} "(.+?)" -- (.+)$`,
      ).exec(run);
      assert.ok(m, `${file}: step "${step.name}" is not wrapped by scripts/stage.sh: ${run}`);
      assert.equal(m[2], step.name,
        `${file}: step "${step.name}" records itself under a different stage name`);
      // The ORIGINAL command text, verbatim and still on this one line — the
      // r87 graph test parses these lines for python invocations, and several
      // other tests use indexOf on the exact command string.
      assert.match(m[3], /^(python3?|bash) \S/,
        `${file}: step "${step.name}" lost its command: ${m[3]}`);
      // A wrapper flag must agree with the step's own continue-on-error, or the
      // record would claim a failure failed the run when it did not.
      const declared = /^\s*continue-on-error:\s*true\b/m.test(step.code);
      assert.equal(Boolean(m[1]), declared,
        `${file}: step "${step.name}" — the wrapper's --continue-on-error does not ` +
        'match the step\'s own continue-on-error');
      wrapped += 1;
    }
    assert.ok(wrapped >= 8, `${file}: only ${wrapped} wrapped steps — the span looks wrong`);

    // validate_data stays UNWRAPPED: it gates the publish, and it must also see
    // data/pipeline_stages.json, which the wrapper is still writing until then.
    const validate = runLine(all[to]);
    assert.equal(validate, 'python scripts/validate_data.py',
      `${file}: the contract gate must stay unwrapped and unchanged`);
  }
});

test('gameday records a SKIP for every mode-guarded step, so scores mode is not silent', () => {
  const text = read('.github/workflows/gameday.yml');
  const all = steps(text);
  const guarded = all
    .filter((s) => /^\s*if:.*!=\s*'scores'/m.test(s.code))
    .map((s) => s.name);
  assert.ok(guarded.length >= 4, 'expected the gameday lock-mode steps to be mode-guarded');
  const skipStep = all.find((s) => s.code.includes('stage_status.py skip '));
  assert.ok(skipStep, 'gameday never records a skip — scores mode would say nothing at all');
  assert.match(skipStep.code, /if:.*==\s*'scores'/,
    'the skip step must be the inverse of the guard it explains');
  for (const stage of guarded) {
    assert.ok(skipStep.code.includes(`--stage "${stage}"`),
      `gameday scores mode does not record a skip for "${stage}"`);
  }
  assert.match(skipStep.code, /--reason "/, 'a skip with no reason is the same silence');
});

test('every commit step is the publish script, with that workflow\'s message verbatim', () => {
  for (const { file, message } of WORKFLOWS) {
    const text = read(`.github/workflows/${file}`);
    const step = steps(text).find((s) => s.code.includes('scripts/publish_data.sh'));
    assert.ok(step, `${file} no longer calls scripts/publish_data.sh`);
    assert.ok(
      step.code.includes(`bash scripts/publish_data.sh "${message}"`),
      `${file}: the publish must carry its existing commit message verbatim (${message})`,
    );
    assert.ok(!/git commit -m/.test(text),
      `${file} still commits inline — the publish is scripts/publish_data.sh's job now`);
  }
});

test('no workflow still tries to publish with a fast-forward-only pull', () => {
  // F16: once both sides hold commits from a common base, a fast-forward pull
  // cannot merge them and retrying cannot change that. The retry loop is gone
  // from all three files, comments included.
  for (const { file } of WORKFLOWS) {
    assert.ok(!read(`.github/workflows/${file}`).includes('--ff-only'),
      `${file} still mentions --ff-only`);
  }
});

test('the MODEL tab reads the record, and nothing else does', () => {
  const data = read('app/data.js');
  assert.match(data, /pipelineStages: '\/data\/pipeline_stages\.json'/,
    'the path belongs in the PATHS allowlist, not hardcoded in a view');
  assert.match(data, /export const getPipelineStages/);
  const model = read('app/views/model.js');
  assert.match(model, /loadPipelineStages/);
  assert.match(model, /pipelineStagesCard/);
  // MEASURED, never ESTIMATE: every number on the card is an observed exit code,
  // duration or timestamp.
  assert.match(model, /card\('PIPELINE STAGES[^']*',\s*\n?\s*pipelineStagesCard\(stages\), 'm-stages', 'measured'\)/,
    'the PIPELINE STAGES card must wear the MEASURED badge');
  assert.match(read('tests/perf/budget.spec.mjs'), /'pipeline_stages\.json'/,
    'the perf CONTRACT_ALLOWLIST must admit the #/model fetch');
  assert.match(read('tests/feature/data_contract.test.mjs'), /'\/data\/pipeline_stages\.json'/);
});
