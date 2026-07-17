/* tests/feature/playoff_odds.test.mjs — the season simulator's contract +
 * probability accounting, locked.
 *
 * data/playoff_odds.json (scripts/simulate_season.py): deterministic Monte
 * Carlo from OUR schedule probs + Elo — no market input (the source string
 * says so and this test pins it). Accounting invariants: exactly one champion
 * per sim, 14 playoff teams, 8 division winners, 2 conference champs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const doc = JSON.parse(
  readFileSync(new URL('../../data/playoff_odds.json', import.meta.url), 'utf8'));

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

test('contract shape: 32 teams, estimate pinned, our-model-only source', () => {
  assert.equal(doc.estimate, true);
  assert.ok(doc.sims >= 1000);
  assert.match(doc.source, /OUR MODEL ONLY/);
  assert.match(doc.source, /no market input/i);
  assert.equal(Object.keys(doc.teams).length, 32);
});

test('probability accounting: champions sum 1, playoff 14, division 8, conference 2', () => {
  const sum = (k) => Object.values(doc.teams).reduce((a, t) => a + t[k], 0);
  assert.ok(Math.abs(sum('champion') - 1) < 0.02, `champion sum ${sum('champion')}`);
  assert.ok(Math.abs(sum('playoff') - 14) < 0.5, `playoff sum ${sum('playoff')}`);
  assert.ok(Math.abs(sum('division') - 8) < 0.3, `division sum ${sum('division')}`);
  assert.ok(Math.abs(sum('conference') - 2) < 0.1, `conference sum ${sum('conference')}`);
});

test('per-team ordering is coherent (champion <= conference <= playoff)', () => {
  for (const [ab, t] of Object.entries(doc.teams)) {
    assert.ok(t.champion <= t.conference + 1e-9, `${ab} champ <= conf`);
    assert.ok(t.conference <= t.playoff + 1e-9, `${ab} conf <= playoff`);
    assert.ok(t.division <= t.playoff + 1e-9, `${ab} div <= playoff`);
  }
});

test('simplified tiebreakers are documented in the notes', () => {
  assert.ok(doc.notes.some((n) => /tiebreaker/i.test(n) && /simplified/i.test(n)));
});

test('rank_group tiebreak ladder: h2h beats division record beats conference (pure)', () => {
  const r = runPy(`
import json, random, sys
sys.path.insert(0, ".")
from scripts.simulate_season import rank_group
rng = random.Random(1)
wins = {"A": 10, "B": 10, "C": 8}
h2h = {("B", "A"): 1}                      # B beat A head-to-head
div = {"A": 4.0, "B": 2.0, "C": 1.0}
conf = {"A": 7.0, "B": 6.0, "C": 5.0}
order = rank_group(["A", "B", "C"], wins, h2h, div, conf, rng)
# No h2h between tied teams -> division record decides
h2h2 = {}
order2 = rank_group(["A", "B"], wins, h2h2, div, conf, random.Random(1))
print(json.dumps({"h2h_wins": order, "div_decides": order2}))
`);
  assert.deepEqual(r.h2h_wins, ['B', 'A', 'C'], 'head-to-head outranks division record');
  assert.deepEqual(r.div_decides, ['A', 'B'], 'division record breaks the tie without h2h');
});

test('determinism: the simulator is seeded (rerunning yields identical teams block)', () => {
  // 300-sim rerun twice via the module with the same fixed seed must match
  // byte-for-byte — the production 10k doc is the same machinery.
  const r = runPy(`
import json, random, sys
sys.path.insert(0, ".")
import scripts.simulate_season as sim
def run():
    games, ratings, hfa = sim.load_inputs()
    rng = random.Random(sim.SEED)
    team_div = {t: d for d, ts in sim.DIVISIONS.items() for t in ts}
    team_conf = {t: c for c, ts in sim.CONFERENCES.items() for t in ts}
    tallies = {t: 0 for t in team_div}
    for _ in range(300):
        _, _, _, champ = sim.simulate_once(games, ratings, hfa, rng, team_div, team_conf)
        tallies[champ] += 1
    return tallies
print(json.dumps({"same": run() == run()}))
`);
  assert.equal(r.same, true);
});
