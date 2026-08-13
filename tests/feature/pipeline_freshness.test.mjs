/* tests/feature/pipeline_freshness.test.mjs — the MODEL tab's freshness surface.
 *
 * Two things are locked here, both of which exist because a DEGRADED health chip
 * told the user something was wrong and gave them no way to find out what:
 *
 *   1. cronLabel() renders the cron shapes this repo actually schedules, and
 *      NEVER invents a gloss for a shape it does not understand.
 *   2. The committed pipeline_status.json publishes `schedules`, and every entry
 *      matches a real cron in .github/workflows — the displayed cadence is read
 *      from the YAML, so it cannot drift into a comfortable lie.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { cronLabel } from '../../app/views/model.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const status = JSON.parse(
  readFileSync(join(REPO_ROOT, 'data/pipeline_status.json'), 'utf8'),
);

test('cronLabel glosses the schedules this repo actually runs', () => {
  assert.equal(cronLabel('0 6 * * *'), 'daily 06:00 UTC');
  assert.equal(cronLabel('0 7 * * 2'), 'Tue 07:00 UTC');
  assert.equal(cronLabel('0 */2 * * 0'), 'Sun, every 2h');
  assert.equal(cronLabel('0 0,2 * * 1'), 'Mon 00:00 UTC & 02:00 UTC');
});

test('cronLabel falls back to the raw expression rather than guessing', () => {
  // A shape it cannot parse must surface verbatim. Showing a confident wrong
  // cadence is worse than showing the cron itself.
  for (const junk of ['', 'not a cron', '0 6 * *', '0 6 * * * *']) {
    assert.equal(cronLabel(junk), junk);
  }
  assert.equal(cronLabel(undefined), '');
});

test('pipeline_status publishes schedules for every scheduled workflow', () => {
  assert.ok(Array.isArray(status.schedules),
    'pipeline_status.json must carry a schedules array — the MODEL tab reads its '
    + 'cadence from the contract, not from hardcoded UI copy');

  const wfDir = join(REPO_ROOT, '.github/workflows');
  const scheduled = readdirSync(wfDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter((f) => /^\s*-\s*cron:/m.test(readFileSync(join(wfDir, f), 'utf8')));

  assert.deepEqual(
    status.schedules.map((s) => s.workflow).sort(),
    scheduled.sort(),
    'every workflow with a cron must appear in schedules, and nothing else may',
  );
});

test('every published cron is verbatim present in its workflow file', () => {
  for (const s of status.schedules) {
    const yaml = readFileSync(join(REPO_ROOT, '.github/workflows', s.workflow), 'utf8');
    assert.ok(s.crons.length > 0, `${s.workflow} published an empty cron list`);
    for (const c of s.crons) {
      assert.ok(yaml.includes(c),
        `${s.workflow} publishes cron ${c} that does not appear in the workflow — `
        + 'the displayed schedule has drifted from the one that runs');
    }
  }
});

test('committed feed health is internally consistent with the roll-up', () => {
  // Mirrors smoke.sh's invariant at the unit layer so a bad status doc is caught
  // without a shell run: health is the WORST configured feed, never rosier.
  const order = { ok: 0, stale: 1, degraded: 2, down: 3 };
  const configured = Object.values(status.feeds)
    .map((f) => f.status)
    .filter((s) => s !== 'unconfigured');
  const worst = configured.reduce((a, b) => (order[b] > order[a] ? b : a), 'ok');
  assert.equal(status.health, worst,
    'health must mirror the worst configured feed exactly');
});
