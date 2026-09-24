/* tests/feature/r101d_my_td_parity.test.mjs — R101d: MY PARLAYS same-game past two
 * legs in a TD mode, and the MY TD cards recorded for grading.
 *
 * Owner (2026-09-24) chose the HYBRID: two legs from one game keep the measured
 * pair adjustment; three or more are priced as the product — the GAME verdict
 * (data/joint_backtest.json) — and one game may supply up to the size GAME
 * validated for the mode, only while that verdict is the product. Locked here:
 *   app/parlay-math.js combinedGameProbs: a 3+ group still THROWS unless the
 *     caller opts into bigGroups 'product' (RCA F03 stays the default);
 *   tdMaxPerGame: 2 for ANY, no verdict, or a joint verdict; else the largest
 *     contiguous validated size — JS and Python agree;
 *   PARITY: the browser's TD-mode search and the Python twin
 *     (scripts/models/my_cards.py) offer the same cards, number for number, over
 *     the COMMITTED pool at its own generated_utc, with a product verdict;
 *   the recorder (scripts/build_my_td_cards.py) records the browser's top card;
 *   the MY card says when a game supplies 3+ legs and how that was priced;
 *   the pipeline records MY TD cards after the GAME cards, gameday scores skip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DIALS, atdPoolLegs, buildCards, dialLegs, mergedCalib, poolLegs, renderCard, seedOptions,
  tdLegsFor, tdMaxPerGame, upcomingLegs,
} from '../../app/views/myparlays.js';
import { combinedGameProbs, correlationTable } from '../../app/parlay-math.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const TOL = 1e-9;
const VERDICT = { pricer: 'independent',
  offered_sizes: { all_td: [2, 3, 4, 5, 6, 7], majority_td: [2, 3, 4, 5, 6, 7, 8, 9, 10], scorers_50: [2, 3] } };

function python(src, payload) {
  const path = join(tmpdir(), `r101d-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  const r = spawnSync('python3', ['-', path], { input: src, cwd: ROOT, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024 });
  try { unlinkSync(path); } catch { /* best effort */ }
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('R101d maths: a 3+ same-game group throws by default and is the product when opted in', () => {
  const legs = [0.6, 0.5, 0.4].map((p, i) => ({ model_prob: p, implied_prob: p, game_id: 'G',
    market: 'anytime_td', side: i % 2 ? 'away' : 'home' }));
  assert.throws(() => combinedGameProbs(legs, null), RangeError, 'RCA F03 stays the default');
  const [model] = combinedGameProbs([...legs, { model_prob: 0.9, implied_prob: 0.9, game_id: 'H' }],
    null, { bigGroups: 'product' });
  assert.ok(Math.abs(model - 0.6 * 0.5 * 0.4 * 0.9) < 1e-12);
  const py = python(`
import json, sys
sys.path.insert(0, ".")
from scripts.models.parlay_builder import combined_game_probs
from scripts.models.my_cards import td_max_per_game
legs = [{"model_prob": p, "implied_prob": p, "game_id": "G", "market": "anytime_td", "side": s}
        for p, s in ((0.6, "home"), (0.5, "away"), (0.4, "home"))]
try:
    combined_game_probs(legs); refused = False
except ValueError:
    refused = True
m = combined_game_probs(legs + [{"model_prob": 0.9, "implied_prob": 0.9, "game_id": "H"}], None, "product")[0]
v = json.load(open(sys.argv[1]))
print(json.dumps({"refused": refused, "model": m,
  "caps": [td_max_per_game(k, x) for k, x in v["cases"]]}))`, { cases: [
    ['any', VERDICT], ['all_td', VERDICT], ['majority_td', VERDICT], ['scorers_50', VERDICT],
    ['all_td', null], ['all_td', { ...VERDICT, pricer: 'joint' }],
    ['all_td', { pricer: 'independent', offered_sizes: { all_td: [3, 4] } }]] });
  assert.equal(py.refused, true);
  assert.ok(Math.abs(py.model - model) < 1e-15);
  const jsCaps = [['any', VERDICT], ['all_td', VERDICT], ['majority_td', VERDICT], ['scorers_50', VERDICT],
    ['all_td', null], ['all_td', { ...VERDICT, pricer: 'joint' }],
    ['all_td', { pricer: 'independent', offered_sizes: { all_td: [3, 4] } }]].map(([k, v]) => tdMaxPerGame(k, v));
  assert.deepEqual(jsCaps, [2, 7, 10, 3, 2, 2, 2]);
  assert.deepEqual(py.caps, jsCaps, 'the cap rule is the same in Python');
});

const hasPool = existsSync(join(ROOT, 'data/leg_pool.json'));
const pool = hasPool ? readJson('data/leg_pool.json') : null;
const hasAtd = Boolean(pool && (pool.atd_legs || []).length);

test('R101d parity: MY TD cards are the same in the browser and the Python twin (committed pool)',
  { skip: !hasAtd && 'the committed pool offers no anytime-TD leg' }, () => {
    const games = readJson('data/schedule_full.json').games;
    const calib = readJson('data/parlay_backtest.json');
    const now = Date.parse(pool.generated_utc);
    const table = correlationTable(mergedCalib(calib, pool));
    const atd = upcomingLegs(atdPoolLegs(pool), games, now);
    const other = dialLegs(upcomingLegs(poolLegs(pool), games, now), DIALS.even);
    const teams = seedOptions(pool).filter((o) => o.kind === 'team');
    // Seeds with the most anytime-TD legs first (where 3+ per game can happen),
    // then a spread — sampled to keep the runtime inside the gate's budget.
    const atdCount = (t) => atd.filter((l) => l.team === t.name).length;
    const seeds = teams.slice().sort((a, b) => atdCount(b) - atdCount(a) || (a.name < b.name ? -1 : 1))
      .filter((_, i) => i < 4 || i % 8 === 0);
    const cases = [];
    const expected = [];
    let bigSeen = 0;
    for (const mode of ['all_td', 'majority_td', 'scorers_50']) {
      const cap = tdMaxPerGame(mode, VERDICT);
      for (const n of [3, 5, 8]) {
        const { legs, maxNonAtd } = tdLegsFor(mode, n, atd, other);
        for (const seed of seeds) {
          const cards = buildCards(legs, [seed], table, { counts: [n], perCount: 10, maxNonAtd, maxPerGame: cap });
          bigSeen += cards.filter((c) => c.bigGame).length;
          cases.push({ mode, n, cap, seed });
          expected.push(cards.map((c) => ({ sel: c.legs.map((l) => l.selection), model: c.model,
            implied: c.implied, big: c.bigGame })));
        }
      }
    }
    assert.ok(bigSeen > 0, 'the sweep exercises at least one 3+-legs-from-one-game card');
    const got = python(`
import json, sys
sys.path.insert(0, ".")
from scripts.models import my_cards as M
from scripts.models.parlay_builder import _correlation_table
pay = json.load(open(sys.argv[1]))
pool = json.load(open("data/leg_pool.json")); games = json.load(open("data/schedule_full.json"))["games"]
calib = json.load(open("data/parlay_backtest.json"))
corr = _correlation_table(M.merged_calib(calib, pool))
now = pool["generated_utc"]
atd = M.upcoming_legs(M.atd_pool_legs(pool), games, now)
other = M.dial_legs(M.upcoming_legs(M.pool_legs(pool), games, now), M.DIALS["even"])
out = []
for c in pay["cases"]:
    legs, max_non = M.td_legs_for(c["mode"], c["n"], atd, other)
    cards = M.build_cards(legs, [c["seed"]], corr, per_count=10, counts=(c["n"],),
                          max_non_atd=max_non, max_per_game=c["cap"])
    out.append([{"sel": [l["selection"] for l in k["legs"]], "model": k["model"],
                 "implied": k["implied"], "big": k["big_game"]} for k in cards])
print(json.dumps(out))`, { cases });
    assert.equal(got.length, expected.length);
    expected.forEach((js, i) => {
      const label = `${cases[i].mode} ${cases[i].n}-leg ${cases[i].seed.name}`;
      const py = got[i];
      assert.equal(py.length, js.length, `${label}: ${js.length} JS cards, ${py.length} Python`);
      js.forEach((c, j) => {
        assert.deepEqual(py[j].sel, c.sel, `${label} card ${j}: legs differ`);
        assert.ok(Math.abs(py[j].model - c.model) < TOL, `${label} card ${j} model`);
        assert.ok(Math.abs(py[j].implied - c.implied) < TOL, `${label} card ${j} implied`);
        assert.equal(py[j].big, c.big, `${label} card ${j} bigGame`);
      });
    });
  });

test('R101d recorder: the recorded top card is the browser\'s top card, and it records once',
  { skip: !hasAtd && 'the committed pool offers no anytime-TD leg' }, () => {
    const games = readJson('data/schedule_full.json').games;
    const calib = readJson('data/parlay_backtest.json');
    const now = Date.parse(pool.generated_utc);
    const table = correlationTable(mergedCalib(calib, pool));
    const atd = upcomingLegs(atdPoolLegs(pool), games, now);
    const other = dialLegs(upcomingLegs(poolLegs(pool), games, now), DIALS.even);
    const seed = seedOptions(pool).filter((o) => o.kind === 'team')
      .sort((a, b) => atd.filter((l) => l.team === b.name).length - atd.filter((l) => l.team === a.name).length)[0];
    const want = {};
    for (const mode of ['all_td', 'majority_td']) {
      for (const n of [4, 6]) {
        const { legs, maxNonAtd } = tdLegsFor(mode, n, atd, other);
        const top = buildCards(legs, [seed], table, { counts: [n], perCount: 10, maxNonAtd,
          maxPerGame: tdMaxPerGame(mode, VERDICT) })[0];
        if (top) want[`${mode}|${n}`] = top.legs.map((l) => l.selection).sort();
      }
    }
    const got = python(`
import json, sys, tempfile
sys.path.insert(0, ".")
from scripts import build_my_td_cards as R, build_atd_cards as W
pay = json.load(open(sys.argv[1]))
pool = json.load(open("data/leg_pool.json")); games = json.load(open("data/schedule_full.json"))["games"]
calib = json.load(open("data/parlay_backtest.json"))
seeds = [s for s in R.M.seed_options(pool) if s.get("kind") == "team" and s["name"] == pay["seed"]]
out = {}
corr = R._correlation_table(R.M.merged_calib(calib, pool))
atd = R.M.upcoming_legs(R.M.atd_pool_legs(pool), games, pool["generated_utc"])
other = R.M.dial_legs(R.M.upcoming_legs(R.M.pool_legs(pool), games, pool["generated_utc"]), R.M.DIALS["even"])
for mode in ("all_td", "majority_td"):
    cap = R.M.td_max_per_game(mode, pay["verdict"])
    if mode == "all_td":
        legs, mx = R.M.td_legs_for(mode, 0, atd, other)
        cards = R.M.build_cards(legs, seeds, corr, per_count=R.RANK_KEEP, counts=R.SIZES, max_non_atd=mx, max_per_game=cap)
        for c in cards:
            out["%s|%d" % (mode, len(c["legs"]))] = sorted(l["selection"] for l in c["legs"])
    else:
        for n in (4, 6):
            legs, mx = R.M.td_legs_for(mode, n, atd, other)
            cards = R.M.build_cards(legs, seeds, corr, per_count=R.RANK_KEEP, counts=(n,), max_non_atd=mx, max_per_game=cap)
            if cards:
                out["%s|%d" % (mode, n)] = sorted(l["selection"] for l in cards[0]["legs"])
doc = {"adopted": True, "season": pool["season"], "week": pool["week"], "generated_utc": pool["generated_utc"],
       "modes": R.offered(pool, games, calib, pay["verdict"], pool["generated_utc"])}
doc["modes"] = {m: {"cards": c} for m, c in doc["modes"].items()}
with tempfile.TemporaryDirectory() as tmp:
    first, again = W.record(doc, tmp), W.record(doc, tmp)
print(json.dumps({"top": out, "first": first, "again": again}))`, { seed: seed.name, verdict: VERDICT });
    for (const [k, sel] of Object.entries(want)) {
      assert.deepEqual(got.top[k], sel, `${k}: the recorded top card is the one the browser shows first`);
    }
    assert.ok(got.first > 0 && got.again === 0, 'first sight recorded once');
  });

test('R101d view: a 3+-legs-from-one-game card says how it was priced; the legend states both caps', () => {
  const leg = (sel, gid, p) => ({ selection: sel, game_id: gid, model_prob: p, implied_prob: p * 1.045,
    market: 'anytime_td', priced: false, mu: null, line: 0.5 });
  const big = { legs: [leg('A anytime TD', 'G', 0.5), leg('B anytime TD', 'G', 0.4), leg('C anytime TD', 'G', 0.3)],
    model: 0.06, implied: 0.07, ev: -0.1, tier: 'low', sameGame: true, mixedGame: false, bigGame: true,
    payout: 1300, assumed: 3 };
  assert.match(renderCard(big, 0), /3\+ legs from one game: priced as the product/);
  assert.doesNotMatch(renderCard({ ...big, bigGame: false }, 0), /3\+ legs from one game/);
  const src = read('app/views/myparlays.js');
  assert.ok(src.includes('At most two legs per game are supported in ANY'), 'the R83 cap stays stated');
  assert.ok(src.includes('per-game size GAME validated'), 'and the TD-mode rule is stated');
});

test('R101d pipeline: MY TD cards recorded after the GAME cards; graded as my_<mode>', () => {
  for (const wf of ['daily', 'gameday']) {
    const y = read(`.github/workflows/${wf}.yml`);
    const g = y.indexOf('python3 scripts/build_atd_game_cards.py');
    const m = y.indexOf('python3 scripts/build_my_td_cards.py');
    assert.ok(g > 0 && m > g, `${wf}: MY TD cards after the GAME cards`);
  }
  assert.match(read('.github/workflows/gameday.yml'),
    /skip --workflow gameday --stage "Anytime-TD MY cards \(first-sight record\)"/);
  assert.match(read('scripts/resolve_atd_cards.py'), /MY_RECORD_GLOB/);
  assert.match(read('scripts/validate_data.py'), /ATD_MY_CARDS_DIR/);
  const r = spawnSync('python3', ['scripts/build_my_td_cards.py', '--selftest'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /selftest ok/);
});
