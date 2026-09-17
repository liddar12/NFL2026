/* tests/feature/r76_parlay_math_parity.test.mjs — the JS parlay maths must agree
 * with the Python, leg for leg.
 *
 * MY PARLAYS searches for cards in the browser, so app/parlay-math.js is a SECOND
 * implementation of arithmetic that already exists in
 * scripts/models/parlay_builder.py. Two implementations of one model are a
 * liability unless something forces them to agree: without this file, a change to
 * the correlation fold or the tier thresholds on one side would quietly produce
 * two different numbers for the same card, and the first symptom would be a user
 * noticing that a card on MY PARLAYS disagrees with the same card on PARLAYS.
 *
 * So: both sides are run over the SAME randomised leg sets — deterministic seed,
 * so a failure is reproducible — and any disagreement beyond floating-point noise
 * fails the gate. The generator deliberately includes the awkward cases:
 * correlated same-game pairs, opposing sides, the R74 moneyline+spread stack,
 * single-leg cards, and probabilities pressed against the clamps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  correlationTable, pairRho, combineTwo, combinedProbs, confidenceTier,
  sameSideGamePair, violatesOnePerSide, impliedFromModel, modelEv,
  DEFAULT_HOLD, TIER_HIGH_EDGE, TIER_MED_EDGE, SAME_GAME_DEFAULT_RHO,
} from '../../app/parlay-math.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CALIB = JSON.parse(readFileSync(join(ROOT, 'data/parlay_backtest.json'), 'utf8'));
const TOL = 1e-9;

/** Deterministic LCG so a parity failure is reproducible from the seed alone. */
function rng(seed) {
  let s = seed;
  return () => { s = (1103515245 * s + 12345) % 2147483648; return s / 2147483648; };
}

const MARKETS = ['moneyline', 'spread', 'qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds'];
const SIDES = ['home', 'away'];

/** Random leg sets, including the awkward shapes the view will actually build. */
function cases(n = 240) {
  const r = rng(20260916);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const nLegs = 1 + Math.floor(r() * 6);
    const correlated = r() < 0.5;
    const legs = [];
    for (let k = 0; k < nLegs; k += 1) {
      const market = MARKETS[Math.floor(r() * MARKETS.length)];
      // probabilities across the whole range, including hard against the clamps
      const model = Math.min(0.9999, Math.max(0.0001, r()));
      const priced = r() < 0.5;
      legs.push({
        market,
        selection: `${market}-${k}`,
        model_prob: model,
        implied_prob: priced ? Math.min(0.9999, Math.max(0.0001, r()))
          : impliedFromModel(model),
        corr_tag: market,
        side: SIDES[Math.floor(r() * SIDES.length)],
        game_id: 'G1',
      });
    }
    out.push({ legs, correlated });
  }
  return out;
}

const CASES = cases();

/** The Python side, over the identical cases. */
function pythonResults(payload) {
  // The payload goes via a FILE, not stdin: `python3 -` already reads the program
  // from stdin, so a payload written there is parsed as source.
  const path = join(tmpdir(), `r76-parity-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(payload));
  const src = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts.models.parlay_builder import (
    _combined_probs, _confidence_tier, _pair_rho, _combine_two,
    _correlation_table, same_side_game_pair, make_leg, _DEFAULT_HOLD,
)
payload = json.load(open(sys.argv[1], encoding="utf-8"))
calib = payload["calib"]
corr = _correlation_table(calib)
out = []
for case in payload["cases"]:
    legs = [{"market": l["market"], "selection": l["selection"],
             "model_prob": l["model_prob"], "implied_prob": l["implied_prob"],
             "_corr_tag": l["corr_tag"], "_side": l["side"]} for l in case["legs"]]
    if case["correlated"] and len(legs) > 2:
        try:
            _combined_probs(legs, True, corr)
        except ValueError:
            out.append({"unsupported": True})
            continue
        raise AssertionError("3+ same-event legs must be refused")
    model, implied = _combined_probs(legs, case["correlated"], corr)
    out.append({
        "model": model, "implied": implied,
        "tier": _confidence_tier(model, implied, len(legs)),
        "rhos": [_pair_rho(legs[i - 1], legs[i], corr) for i in range(1, len(legs))],
        "same_side": [same_side_game_pair(legs[i], legs[j])
                      for i in range(len(legs)) for j in range(i + 1, len(legs))],
    })
holds = [make_leg("qb_pass_yds", "x", p)["implied_prob"] for p in payload["holds"]]
combos = [_combine_two(a, b, r) for a, b, r in payload["combos"]]
print(json.dumps({"cases": out, "holds": holds, "combos": combos,
                  "hold_const": _DEFAULT_HOLD}))
`;
  const r = spawnSync('python3', ['-', path], {
    input: src, cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  try { unlinkSync(path); } catch { /* best effort */ }
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('the JS combination maths match the Python on every randomised case', () => {
  const r = rng(7);
  const holds = Array.from({ length: 40 }, () => Math.min(0.9999, Math.max(0.0001, r())));
  const combos = Array.from({ length: 60 }, () => [
    Math.min(0.999, Math.max(0.001, r())),
    Math.min(0.999, Math.max(0.001, r())),
    r() * 2 - 1,
  ]);
  const py = pythonResults({ calib: CALIB, cases: CASES, holds, combos });
  const table = correlationTable(CALIB);

  assert.equal(py.hold_const, DEFAULT_HOLD, 'the hold constant drifted apart');

  // combineTwo, in isolation, across positive and negative rho
  combos.forEach(([a, b, rho], i) => {
    assert.ok(Math.abs(combineTwo(a, b, rho) - py.combos[i]) < TOL,
      `combineTwo(${a}, ${b}, ${rho}): js ${combineTwo(a, b, rho)} py ${py.combos[i]}`);
  });

  // the vig charged to a leg with no book price (rounded to 4dp by make_leg)
  holds.forEach((p, i) => {
    assert.ok(Math.abs(Math.round(impliedFromModel(p) * 1e4) / 1e4 - py.holds[i]) < TOL,
      `implied from model ${p}`);
  });

  // and the whole fold, per case
  CASES.forEach((c, i) => {
    if (c.correlated && c.legs.length > 2) {
      assert.equal(py.cases[i].unsupported, true);
      assert.throws(() => combinedProbs(c.legs, true, table), RangeError);
      return;
    }
    const [model, implied] = combinedProbs(c.legs, c.correlated, table);
    const exp = py.cases[i];
    assert.ok(Math.abs(model - exp.model) < TOL,
      `case ${i} model: js ${model} py ${exp.model} (${c.legs.length} legs, correlated=${c.correlated})`);
    assert.ok(Math.abs(implied - exp.implied) < TOL, `case ${i} implied`);
    assert.equal(confidenceTier(model, implied, c.legs.length), exp.tier, `case ${i} tier`);

    for (let k = 1; k < c.legs.length; k += 1) {
      const js = pairRho(c.legs[k - 1], c.legs[k], table);
      assert.ok(Math.abs(js - exp.rhos[k - 1]) < TOL,
        `case ${i} rho ${k}: js ${js} py ${exp.rhos[k - 1]}`);
    }
    const jsSame = [];
    for (let a = 0; a < c.legs.length; a += 1) {
      for (let b = a + 1; b < c.legs.length; b += 1) {
        jsSame.push(sameSideGamePair(c.legs[a], c.legs[b]));
      }
    }
    assert.deepEqual(jsSame, exp.same_side, `case ${i} one-leg-per-side`);
  });
});

test('the ported constants are the builder\'s, not a copy that drifted', () => {
  const src = readFileSync(join(ROOT, 'scripts/models/parlay_builder.py'), 'utf8');
  const num = (name) => Number(new RegExp(`^${name} = ([\\d.]+)`, 'm').exec(src)[1]);
  assert.equal(DEFAULT_HOLD, num('_DEFAULT_HOLD'));
  assert.equal(TIER_HIGH_EDGE, num('_TIER_HIGH_EDGE'));
  assert.equal(TIER_MED_EDGE, num('_TIER_MED_EDGE'));
  assert.equal(SAME_GAME_DEFAULT_RHO, num('_SAME_GAME_DEFAULT_RHO'));
});

test('R74 holds in the browser: a card may not stack a team\'s ML and its spread', () => {
  const ml = { market: 'moneyline', side: 'home', game_id: 'G1', model_prob: 0.6, implied_prob: 0.62 };
  const sp = { market: 'spread', side: 'home', game_id: 'G1', model_prob: 0.5, implied_prob: 0.52 };
  const opp = { market: 'spread', side: 'away', game_id: 'G1', model_prob: 0.5, implied_prob: 0.52 };
  const prop = { market: 'wr_rec_yds', side: 'home', game_id: 'G1', model_prob: 0.5, implied_prob: 0.52 };
  assert.equal(sameSideGamePair(ml, sp), true);
  assert.equal(sameSideGamePair(ml, opp), false, 'opposite sides are two opinions');
  assert.equal(sameSideGamePair(ml, prop), false, 'a prop is not a game-outcome bet');
  assert.equal(violatesOnePerSide([ml, sp]), true);
  assert.equal(violatesOnePerSide([ml, prop]), false);
  // the rule is per GAME: the same side of a DIFFERENT game is fine
  assert.equal(violatesOnePerSide([ml, { ...sp, game_id: 'G2' }]), false);
});

test('an unpriced leg can never claim a positive single-leg edge', () => {
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    assert.ok(impliedFromModel(p) > p, `model ${p} must be charged the vig`);
    assert.ok(modelEv(p, impliedFromModel(p)) < 0, `model ${p} shows positive EV unpriced`);
  }
  // a REAL book price is the only way a positive edge appears
  assert.ok(modelEv(0.6, 0.55) > 0);
});

test('the implied side is always the independence product, correlated or not', () => {
  const table = correlationTable(CALIB);
  const legs = [
    { market: 'moneyline', side: 'home', model_prob: 0.6, implied_prob: 0.62, corr_tag: 'moneyline' },
    { market: 'rb_rush_yds', side: 'home', model_prob: 0.55, implied_prob: 0.58, corr_tag: 'rb_rush_yds' },
  ];
  const [mc, ic] = combinedProbs(legs, true, table);
  const [mu, iu] = combinedProbs(legs, false, table);
  assert.ok(Math.abs(ic - 0.62 * 0.58) < TOL, 'correlated: implied is still the product');
  assert.ok(Math.abs(iu - 0.62 * 0.58) < TOL, 'independent: implied is the product');
  // rb_rush_yds|moneyline is measured at +0.279, so correlating LIFTS the model
  assert.ok(mc > mu, `correlated ${mc} should exceed independent ${mu}`);
});
