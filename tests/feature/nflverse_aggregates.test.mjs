/* tests/feature/nflverse_aggregates.test.mjs — the nflverse aggregation math,
 * locked via the selftest fixtures (the release host is runner-only; the MATH
 * must hold regardless of the network).
 *
 * Fixtures (data/fixtures/nflverse_sample/): known bench joins (KC 30+24 -> 27,
 * BUF 28+20 -> 24, join 4/5) and known score-state splits. Also locks the
 * o-line bench blend switch: aggregate absent -> the 3-term composite path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

test('combine bench join: exact team averages, suffix-tolerant names, honest join rate', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.build_nflverse_aggregates import build
d = build(selftest=True)
print(json.dumps({"combine": d["combine_oline"], "rate": d["combine_join_rate"]}))
`);
  assert.equal(r.combine.KC.avg_bench_press, 27.0);
  assert.equal(r.combine.KC.n_tested, 2);
  assert.equal(r.combine.KC.n_linemen, 3);
  assert.equal(r.combine.BUF.avg_bench_press, 24.0, '"Echo Guard Jr." joins despite the suffix');
  assert.equal(r.rate, 0.8, '4 of 5 linemen joined — reported, not hidden');
});

test('score-state splits: rush share by snap score state + Q4 garbage pass share', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.build_nflverse_aggregates import build
print(json.dumps(build(selftest=True)["score_state_rush"]))
`);
  assert.equal(r.leading_by_7plus.rush_share, 0.6667);
  assert.equal(r.leading_by_7plus.n_plays, 3);
  assert.equal(r.trailing_by_7plus.rush_share, 0.25);
  assert.equal(r.within_7.rush_share, 0.5);
  assert.equal(r.q4_trailing_14plus.pass_share, 0.6667);
});

test('oline bench blend: absent aggregate keeps the 3-term path; present switches to 4-term', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
import scripts.build_oline as bo
teams = {ab: {"avg_weight_lb": 315.0 + i, "avg_experience_yrs": 3.0,
              "continuity": 0.6, "n_linemen": 15, "avg_age": 26.0}
         for i, ab in enumerate(["KC", "BUF", "SF"])}
# Point the aggregate path at a nonexistent file -> must return the 3-term BLEND.
orig = bo.AGGREGATES_PATH
bo.AGGREGATES_PATH = orig + ".does-not-exist"
absent = bo.apply_bench_press(dict(teams)) is bo.BLEND
bo.AGGREGATES_PATH = orig
print(json.dumps({"absent_keeps_3term": absent,
                  "blend_bench_keys": sorted(bo.BLEND_BENCH.keys())}))
`);
  assert.equal(r.absent_keeps_3term, true);
  assert.deepEqual(r.blend_bench_keys,
    ['avg_bench_press', 'avg_experience_yrs', 'avg_weight_lb', 'continuity']);
});
