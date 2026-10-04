/* R107 — THE PARLAY GATE UNDERSTANDS ITS OWN ONE-DAY LAG.
 *
 * The daily runner writes data/parlay_backtest.json BEFORE
 * scripts/resolve_parlay_legs.py grades the newest legs, so the commit that grades
 * them carries a parlay_backtest.json computed on the legs before. Until
 * 2026-10-02 the refit verdict never changed between the two, so the gate's
 * "committed shipped numbers == recomputed" check never noticed. Thursday's three
 * graded legs flipped the 2026 refit to ADOPTED, and data-ci went red on a file
 * that was exactly right for the legs it saw.
 *
 * The gate now recomputes on the weeks the committed file fit and accepts the
 * difference ONLY when that reproduces the committed numbers exactly; a stale
 * file that the lag does not explain is still red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  input: `import json, os, sys, tempfile, contextlib, io\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

const CASES = `
from scripts import backtest_parlay as bp
def doc(cal, legs, weeks, fit_weeks):
    return {"props": {"verdict": {"adopted": True, "reason": "r"}, "calibration": cal,
                      "residual_sd": {"QB": 1.0}},
            "spread": {"verdict": "no_edge"}, "correlations": {"pairs": []},
            "live_2026": {"legs_resolved": legs, "weeks": weeks,
                          "refit": {"applied": False, "fit_weeks": fit_weeks, "reason": "kept"}}}
old = doc({"QB": {"a": 1}}, 128, 3, [1, 2, 3])          # what the committed file saw
now = doc({"QB": {"a": 2}}, 131, 4, [1, 2, 3, 4])       # one more week graded: refit adopts
d = tempfile.mkdtemp(); path = os.path.join(d, "pb.json"); json.dump(old, open(path, "w"))
def run(current, recompute_on):
    with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()) as out:
        rc = bp.gate(current, committed_path=path, recompute_on=recompute_on)
    return rc, out.getvalue()
r_lag, note = run(now, lambda w: old if w == [1, 2, 3] else None)
r_bad, _ = run(now, lambda w: doc({"QB": {"a": 9}}, 128, 3, [1, 2, 3]))
r_same, _ = run(doc({"QB": {"a": 2}}, 128, 3, [1, 2, 3]), lambda w: old)
r_none, _ = run(now, None)
print(json.dumps({"lag": r_lag, "note": note, "bad": r_bad, "same": r_same, "none": r_none}))`;

test('the lag passes only when the committed file reproduces from the legs it saw', () => {
  const r = py(CASES);
  assert.equal(r.lag, 0, 'new legs graded after the file was written: the lag explains it');
  assert.match(r.note, /one-day lag: the committed file reproduces from the 128 legs it saw \(weeks \[1, 2, 3\]\); 131 legs are graded now/);
  assert.equal(r.bad, 1, 'a file the lag does NOT reproduce is still stale: red');
  assert.equal(r.same, 1, 'same legs seen, different numbers: no lag to hide behind, red');
  assert.equal(r.none, 1, 'without the recompute hook the old strict rule stands');
});

/* R113 (data-ci #80) — the lag inside ONE week. Thursday's game was graded when the
 * file was written (fit_weeks [1..4], 131 legs); Sunday's games were graded after, in
 * the same week 4, so the week filter rebuilds 157 legs and could never reproduce the
 * file. The gate's recompute narrows the weeks to the kickoff-order prefix of exactly
 * the size the file saw; no prefix of that size -> None, and the gate stays strict. */
test('R113: the recompute rebuilds the kickoff-order prefix the committed file saw', () => {
  const r = py(`
from scripts import backtest_parlay as bp
k = {"g1": "2026-09-27T17:00Z", "thu": "2026-10-02T00:15Z", "sun": "2026-10-04T17:00Z"}
live = [{"week": 3, "game_id": "g1"}] * 2 + [{"week": 4, "game_id": "thu"}] * 3 \
     + [{"week": 4, "game_id": "sun"}] * 5
thu = bp._kickoff_prefix(live, 5, k)
print(json.dumps({"thu": [r["game_id"] for r in thu], "all": len(bp._kickoff_prefix(live, 10, k)),
                  "none": bp._kickoff_prefix(live, 6, k)}))`);
  assert.deepEqual(r.thu, ['g1', 'g1', 'thu', 'thu', 'thu']);
  assert.equal(r.all, 10);
  assert.equal(r.none, null, 'no game boundary gives 6 legs: nothing to reproduce from');
});

test('the committed data passes the gate (with the lag stated when it applies)', () => {
  const out = execFileSync('python3', ['scripts/backtest_parlay.py', '--gate'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /parlay backtest gate: PASS/);
});
