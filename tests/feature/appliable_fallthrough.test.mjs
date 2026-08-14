/* tests/feature/appliable_fallthrough.test.mjs — a family the pipeline cannot
 * apply may be RECORDED as a run's winner. It may never VETO the adoption of a
 * family that IS wired.
 *
 * The defect this locks (R21 review, P1): promote_signals set adopt=False the
 * moment the best-loss family was absent from APPLIABLE, with no scan for the
 * next appliable candidate. Rel18 added four unwired families, so the veto had
 * four ways to fire, and it fires on real numbers — on the corpus the best
 * appliable (rest scale=3.0, 0.63032) and the best non-appliable (coach_regime
 * shrink=0.15, 0.63038) sit 0.00006 apart, well inside season-set noise. That
 * is the same "zero upside, real downside" asymmetry that got referee cut, and
 * the failure is SILENT: the archived entry looks like an honest retention.
 *
 * What must stay true:
 *   1. an appliable winner passes straight through, nothing pending;
 *   2. a non-appliable winner is recorded as pending AND the best appliable
 *      family becomes the candidate — re-tested on its OWN significance, never
 *      adopted on the winner's evidence;
 *   3. with no appliable family in the run there is nothing to fall through to,
 *      and the winner is still recorded rather than adopted;
 *   4. the run wires the guard to the helper (a second copy of the rule would
 *      drift), and every family carries an `appliable` flag on the entry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROMOTE = join(REPO_ROOT, 'scripts', 'promote_signals.py');

function py(script) {
  const out = execFileSync('python3', ['-c', script], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('fallthrough: a non-appliable winner is recorded, and never vetoes', () => {
  const got = py(`
import json
from scripts.promote_signals import fallthrough_candidate as fc

APPLIABLE = {"rest", "elo_epa"}
win_ok = ("rest", {"log_loss": 0.63032})
win_no = ("coach_regime", {"log_loss": 0.63038})
alt    = ("elo_epa", {"log_loss": 0.63045})

print(json.dumps({
  "appliable_winner": fc(win_ok, alt, APPLIABLE),
  "unwired_winner":   fc(win_no, alt, APPLIABLE),
  "no_alternative":   fc(win_no, None, APPLIABLE),
  "nothing_ran":      fc(None, None, APPLIABLE),
}))
`);
  assert.deepEqual(got.appliable_winner, [['rest', { log_loss: 0.63032 }], null],
    'an appliable winner is the candidate and nothing is pending');
  assert.deepEqual(got.unwired_winner,
    [['elo_epa', { log_loss: 0.63045 }], ['coach_regime', { log_loss: 0.63038 }]],
    'the unwired winner is recorded pending; the best APPLIABLE family becomes '
    + 'the candidate instead of the adoption being suppressed outright');
  assert.deepEqual(got.no_alternative,
    [null, ['coach_regime', { log_loss: 0.63038 }]],
    'no appliable family ran: nothing to adopt, winner still recorded');
  assert.deepEqual(got.nothing_ran, [null, null]);
});

test('fallthrough: the gate wires the guard to the helper and flags every family', () => {
  const src = readFileSync(PROMOTE, 'utf8');
  // The candidate is re-tested on its own numbers — the winner's t-stat is
  // never borrowed. `_evaluate` is called again immediately after the swap.
  assert.match(src,
    /best_overall, pending = fallthrough_candidate\([\s\S]{0,120}?_evaluate\(best_overall\)/,
    'the fallthrough must re-evaluate the new candidate, not reuse the winner\'s '
    + 'significance');
  // The old shape — adopt=False with no scan for an appliable candidate — must
  // not come back.
  assert.ok(!/adopt = False\n\s+pending = best_overall/.test(src),
    'a non-appliable winner must not set adopt=False without falling through');
  // Appliability is recorded per family so downstream readers (the MODEL tab)
  // can tell a family that could earn weight from one that cannot.
  assert.match(src, /fam\["appliable"\] = fam\["family"\] in APPLIABLE/);
});
