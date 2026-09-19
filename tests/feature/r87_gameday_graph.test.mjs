/* tests/feature/r87_gameday_graph.test.mjs — R87 / review finding F17.
 *
 * F17: "Gameday and daily workflows publish different dependency graphs."
 * gameday.yml rebuilt game_predictions.json but never rebuilt the MY PARLAYS
 * leg pool, never appended the parlay-leg ledger and never resolved a leg. So a
 * Sunday window shipped GAME cards priced off fresh inactives next to MY cards
 * still priced off the previous daily run's pool, and a leg first offered inside
 * a gameday window could reach kickoff with no pre-kickoff receipt. Its score
 * step also invoked `scripts.scrape.espn_scores_cli` — a module that does not
 * exist in this repo — under `|| true`, so the step reported success for work it
 * never executed.
 *
 * This file locks the graph itself, not the outputs. It reads the workflows as
 * TEXT (no yaml dependency — the gate installs nothing) and asserts:
 *
 *   (i)   the gameday LOCK path runs the R87 chain in dependency order;
 *   (ii)  gameday.yml no longer mentions the absent scores CLI;
 *   (iii) daily.yml keeps the same two orderings, so the two files cannot drift
 *         apart again without one of them failing here;
 *   (iv)  every script the gameday lock path invokes exists on disk (the whole
 *         point of F17's "absent module under || true");
 *   (v)   every script gameday invokes WITHOUT continue-on-error imports only
 *         stdlib or repo-local modules at module level. A required step that
 *         needs a third-party package is a step that fails the whole window on a
 *         runner where the install degraded; heavy libs belong behind a guarded
 *         import inside a function, which is the repo's standing rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');

function workflowText(name) {
  return readFileSync(join(WORKFLOWS, name), 'utf8');
}

/* Split a workflow into its steps by the `- name:` lines, as text. Comment
 * lines are stripped from each step's commands: this repo explains WHY a step
 * exists in prose above it, and that prose names scripts. */
function steps(text) {
  const lines = text.split('\n');
  const out = [];
  let current = null;
  for (const line of lines) {
    const started = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (started) {
      if (current) out.push(current);
      current = { name: started[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) out.push(current);
  return out.map((s) => {
    // Only non-comment lines count as "what this step runs", so a script named
    // in a WHY comment is never mistaken for an invocation.
    const code = s.body.filter((l) => !/^\s*#/.test(l)).join('\n');
    const guard = /^\s*if:\s*(.+?)\s*$/m.exec(code);
    return {
      name: s.name,
      code,
      guard: guard ? guard[1] : null,
      continueOnError: /^\s*continue-on-error:\s*true\s*$/m.test(code),
    };
  });
}

/* A step runs in LOCK mode when it has no mode guard, or a guard that excludes
 * only the scores mode. (`github.event.inputs.mode` is empty on a `schedule:`
 * run, so a cron matches neither exclusion and fires everything.) */
function lockPath(all) {
  return all.filter((s) => !s.guard || !/!=\s*'lock'/.test(s.guard));
}

/* Every `python`/`python3` invocation in a step's commands, as a repo-relative
 * script path. Handles both spellings this repo uses: `python -m scripts.foo`
 * and `python3 scripts/foo.py`. */
const INVOKE_RE = /\bpython3?\s+(?:-m\s+([A-Za-z_][\w.]*)|([\w./-]+\.py))/g;

function invokedScripts(code) {
  const found = [];
  for (const m of code.matchAll(INVOKE_RE)) {
    found.push(m[1] ? `${m[1].split('.').join('/')}.py` : m[2]);
  }
  return found;
}

function orderedInvocations(stepList) {
  return stepList.flatMap((s) => invokedScripts(s.code).map((script) => ({ script, step: s })));
}

const GAMEDAY = workflowText('gameday.yml');
const DAILY = workflowText('daily.yml');

/* (i) The R87 chain, in dependency order, inside the lock path. Each arrow is a
 * real dependency: the pool copies the slate build_predictions just wrote, the
 * cards record what the pool offered, the ledger prices what the cards offered,
 * the resolvers grade the ledger, and build_review consumes the resolved rows. */
const LOCK_CHAIN = [
  'scripts/build_predictions.py',
  'scripts/build_leg_pool.py',
  'scripts/build_my_cards.py',
  'scripts/build_parlay_ledger.py',
  'scripts/resolve_parlay_legs.py',
  'scripts/resolve_my_cards.py',
  'scripts/build_review.py',
  'scripts/validate_data.py',
];

test('F17 (i) — gameday lock path runs the full chain in dependency order', () => {
  const lock = lockPath(steps(GAMEDAY));
  const order = orderedInvocations(lock).map((x) => x.script);

  let previous = -1;
  let previousName = '(start of job)';
  for (const script of LOCK_CHAIN) {
    const at = order.indexOf(script);
    assert.ok(
      at !== -1,
      `gameday.yml lock path never invokes ${script} — F17: the gameday window must ` +
        `rebuild and grade the same artifacts daily.yml does, under one generation.`,
    );
    assert.ok(
      at > previous,
      `gameday.yml runs ${script} before ${previousName}; required order is ` +
        LOCK_CHAIN.join(' -> '),
    );
    previous = at;
    previousName = script;
  }

  // ...and the race-safe commit is last: nothing may be generated after the
  // contracts are validated and the tree is staged.
  const commitAt = lock.findIndex((s) => /git commit /.test(s.code));
  assert.ok(commitAt !== -1, 'gameday.yml has no commit step');
  const validateAt = lock.findIndex((s) => invokedScripts(s.code).includes('scripts/validate_data.py'));
  assert.ok(
    commitAt > validateAt,
    'gameday.yml commits before validate_data.py — the contracts must gate the push',
  );
  assert.equal(
    commitAt,
    lock.length - 1,
    'the commit step is no longer the last step of the gameday lock path',
  );
});

test('F17 (ii) — gameday.yml no longer invokes the absent scores CLI', () => {
  assert.ok(
    !GAMEDAY.includes('espn_scores_cli'),
    'gameday.yml still mentions espn_scores_cli: that module does not exist, and ' +
      'running it under `|| true` reported success for a step that executed nothing.',
  );
  // The honest score reader is resolve_locks, and it runs in every mode.
  const scoresPath = steps(GAMEDAY).filter((s) => !s.guard || !/!=\s*'scores'/.test(s.guard));
  const scoresScripts = orderedInvocations(scoresPath).map((x) => x.script);
  for (const required of [
    'scripts/resolve_locks.py',
    'scripts/resolve_parlay_legs.py',
    'scripts/resolve_my_cards.py',
    'scripts/build_review.py',
  ]) {
    assert.ok(
      scoresScripts.includes(required),
      `scores mode must still run ${required}: grading is mode-independent (Thursday's ` +
        `games go FINAL inside the Sunday window).`,
    );
  }
});

test('F17 (iii) — daily.yml keeps the same two orderings', () => {
  const order = orderedInvocations(steps(DAILY)).map((x) => x.script);
  const pairs = [
    ['scripts/build_leg_pool.py', 'scripts/build_my_cards.py'],
    ['scripts/resolve_parlay_legs.py', 'scripts/resolve_my_cards.py'],
  ];
  for (const [first, second] of pairs) {
    const a = order.indexOf(first);
    const b = order.indexOf(second);
    assert.ok(a !== -1, `daily.yml never runs ${first}`);
    assert.ok(b !== -1, `daily.yml never runs ${second}`);
    assert.ok(a < b, `daily.yml runs ${second} before ${first}`);
  }
});

test('F17 (iv) — every script the gameday lock path invokes exists on disk', () => {
  const missing = [];
  for (const { script, step } of orderedInvocations(lockPath(steps(GAMEDAY)))) {
    if (!existsSync(join(REPO_ROOT, script))) missing.push(`${script} (step: ${step.name})`);
  }
  assert.deepEqual(
    missing,
    [],
    `gameday.yml invokes scripts that are not in the repo: ${missing.join(', ')}`,
  );
});

/* (v) A module-level AST scan, spawned as python3 with stdlib only. It reads
 * each file's TOP-LEVEL import statements and checks the root module name
 * against sys.stdlib_module_names plus the repo's own top-level packages. An
 * import guarded inside a function is invisible to it on purpose: that is how
 * this repo carries heavy libs (requests, the nflverse readers) in steps that
 * are allowed to degrade. A step with no continue-on-error fails the window, so
 * it must not need anything pip could fail to install. */
const AST_SCAN = `
import ast, json, os, sys
repo = sys.argv[1]
def local(name):
    # A repo-local top-level package or module. scripts/ is a NAMESPACE package
    # (no __init__.py at its root), so a bare isdir is the honest test here.
    return os.path.isdir(os.path.join(repo, name)) or \\
           os.path.exists(os.path.join(repo, name + '.py'))
bad = {}
for rel in sys.argv[2:]:
    path = os.path.join(repo, rel)
    if not os.path.exists(path):
        bad[rel] = ['<file missing>']
        continue
    tree = ast.parse(open(path, encoding='utf-8').read(), filename=path)
    offenders = []
    for node in tree.body:
        names = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:          # relative import: repo-local by definition
                continue
            names = [node.module or '']
        for name in names:
            root = name.split('.')[0]
            if not root:
                continue
            if root in sys.stdlib_module_names or local(root):
                continue
            offenders.append(name)
    if offenders:
        bad[rel] = sorted(set(offenders))
print(json.dumps(bad))
`;

test('F17 (v) — required gameday steps import only stdlib or repo-local modules', () => {
  const required = steps(GAMEDAY).filter((s) => !s.continueOnError);
  const scripts = [...new Set(required.flatMap((s) => invokedScripts(s.code)))];
  assert.ok(scripts.length > 0, 'parsed no python invocations out of gameday.yml');

  const raw = execFileSync('python3', ['-c', AST_SCAN, REPO_ROOT, ...scripts], {
    encoding: 'utf8',
  });
  const offenders = JSON.parse(raw);
  assert.deepEqual(
    offenders,
    {},
    'a gameday step without continue-on-error imports a non-stdlib, non-repo module ' +
      `at module level: ${JSON.stringify(offenders)}. Move it inside the function that ` +
      'needs it, or give the step continue-on-error.',
  );
});
