/* tests/feature/week6_retired_consumers.test.mjs — every consumer of the canonical
 * availability vocabulary classifies RETIRED explicitly.
 *
 * ESPN's "Reserve-Ret" froze data/injuries.json from 2026-10-11 to 2026-10-15
 * (R125 shipped it as IR to unfreeze the feed; the week-6 build makes it RETIRED).
 * A code a consumer does not list falls through to its neutral default, which for
 * a retired player means "healthy". Locked here: the R125 interim IR mapping is gone,
 * the line report counts a retired starter as out (and ranks it worst), the
 * projection model zeroes his availability without touching learned weights, and
 * the injury-history builder ignores him (a retirement is not an injury label).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gateTag, withWeekHeadline } from '../../app/views/players.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('RETIRED is classified by availability, line report, projection and injury history', () => {
  const out = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ".")
from scripts import availability as av
from scripts import build_line_report as lr
from scripts.models import player_projection as pp
from scripts import build_injury_history as ih
print(json.dumps({
  "code": av.normalize_status("Reserve-Ret"),
  "season": av.status_class(av.RETIRED),
  "playable": av.status_playable(av.RETIRED),
  "line_out": av.RETIRED in lr.OUT_CODES,
  "projection": list(pp._INJURY_STATUS[av.RETIRED]),
  "history": ih.report_status("Reserve-Ret"),
  "history_ignored": av.RETIRED in ih.REPORT_IGNORED,
}))
`], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(out.code, 'RETIRED', 'Reserve-Ret is RETIRED (the R125 IR interim is superseded)');
  assert.equal(out.season, 'season');
  assert.equal(out.playable, false);
  assert.equal(out.line_out, true, 'a retired starter is out on the line report');
  assert.deepEqual(out.projection, [0, 1], 'no snaps, no effectiveness change, explicit');
  assert.equal(out.history, null, 'a retirement is never an injury-training label');
  assert.equal(out.history_ignored, true);
});

test('RETIRED labels the gated player headline and explains the absence instead of calling zero a matchup projection', () => {
  const gate = { wk: 6, playable: false, reason: 'status', status: 'RETIRED' };
  assert.deepEqual(gateTag(gate), ['RETIRED', 'Not playable this week — retired']);
  const shell = '<div class="p-proj"><div class="p-num">170.0</div>'
    + '<div class="p-unit">PROJ PTS</div>';
  const headline = withWeekHeadline(shell, 6, { points: 0, bye: false, gate }, 170);
  assert.match(headline, /WK 6 · RETIRED/);
  assert.match(headline, /title="Not playable this week — retired"/);
  assert.match(headline, /class="p-num">0\.0<\/div>/);
  assert.ok(!headline.includes('MATCHUP'), 'a known retirement must not look like a zero-point matchup prediction');
  // The added label does not turn playable or unrelated-week rows into a gate.
  assert.equal(gateTag({ ...gate, playable: true }), null);
  assert.equal(gateTag({ ...gate, status: 'QUESTIONABLE', playable: true }), null);
  assert.equal(gateTag(null), null);
  assert.match(withWeekHeadline(shell, 5, { points: 12, bye: false, gate: null }, 170), /WK 5 · MATCHUP/);
});
