import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('malformed weather rows cannot abort healthy games or turn unknown rain into dry observations', () => {
  const result = spawnSync('python3', ['-B', 'tests/fixtures/weather_row_hardening_cases.py'], {
    cwd: root, encoding: 'utf8', timeout: 45000,
    env: { ...process.env, PYTHONPATH: root, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 13 tests/);
});
