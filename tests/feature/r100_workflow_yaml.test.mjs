/* tests/feature/r100_workflow_yaml.test.mjs — R100 fix: a workflow file must PARSE.
 *
 * R100 renamed a backtest.yml step to "Player-signal walk-forward fit (R100:
 * auto-adopt ...)". In a YAML plain scalar ": " starts a mapping, so the whole file
 * stopped parsing: GitHub listed the workflow by its path instead of its name,
 * refused workflow_dispatch, and the weekly run that carries every learning loop
 * would never have fired again. The gate stayed green because every workflow test
 * reads the files as TEXT (the gate installs nothing, so no YAML parser).
 *
 * This is the missing check, stdlib only: in every workflow, a key's value that is
 * a PLAIN scalar (not quoted, not a block, not a flow collection) may not contain
 * ": " — the exact rule that broke. It is proved on the line that broke it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WF = join(REPO_ROOT, '.github', 'workflows');

/** [line number, text] for every plain-scalar value that contains ": ". */
export function plainScalarColons(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*(?:-\s+)?[A-Za-z0-9_.-]+:\s+(.+?)\s*$/.exec(line);
    if (!m) return;
    const v = m[1];
    if (/^["'|>{[&*!]/.test(v)) return;              // quoted, block, flow, anchor, tag
    const body = v.replace(/\s+#.*$/, '');            // a trailing comment is not the value
    if (/: /.test(body)) out.push([i + 1, line.trim()]);
  });
  return out;
}

test('R100: the check catches the exact line that broke backtest.yml', () => {
  const broken = [
    '      - name: Player-signal walk-forward fit (R100: auto-adopt behind never-regress vs what ships)',
    '        run: bash scripts/stage.sh backtest "Player-signal walk-forward fit (R100: auto-adopt)" -- python x.py',
    // quotes in the MIDDLE of a plain value do not protect it (PyYAML: invalid)
    "        run: echo 'a: b'",
  ].join('\n');
  assert.equal(plainScalarColons(broken).length, 3);
  // and it does not cry wolf on the legal shapes
  const fine = [
    '      - name: Validate data contracts',
    '        run: python3 scripts/validate_data.py',
    '    - cron: "0 7 * * 2"   # Tuesdays 07:00 UTC',
    '        run: echo "key"',
    '      - name: R55 gate — the split must still beat the flat season average',
    '        run: |',
    '          echo "key: value"',
  ].join('\n');
  assert.deepEqual(plainScalarColons(fine), []);
});

test('R100: no workflow carries a plain-scalar value with ": " (it would not parse)', () => {
  const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 4, 'daily, gameday, backtest and ci are all checked');
  for (const f of files) {
    const bad = plainScalarColons(readFileSync(join(WF, f), 'utf8'));
    assert.deepEqual(bad, [], `${f} would not parse as YAML — quote these values or drop the ": ": `
      + bad.map(([n, l]) => `line ${n}: ${l}`).join(' | '));
  }
});
