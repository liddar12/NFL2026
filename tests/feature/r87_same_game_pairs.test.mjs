/* tests/feature/r87_same_game_pairs.test.mjs — R87 SAME-GAME PAIRS, locked.
 *
 * RC-N5 of docs/RCA_MYPARLAYS_CARDS.md asked for the chained same-game joint to
 * be scored against resolved outcomes before it is trusted any further than the
 * 2-to-3-leg cards the slate builds today. `same_game_pairs` in
 * data/replay_lab.json is that score, and it is worth exactly as much as three
 * properties that a careless edit would quietly destroy:
 *
 *   1. IT MEASURES THE SHIPPED RULE. The key is the calibration's own key, the
 *      rho is the one parlay_builder._pair_rho returns, and the joint is
 *      parlay_builder._combine_two — imported, never re-implemented. A pair the
 *      one-leg-per-game-side rule refuses is not scored, because it is not
 *      offered; it is counted instead.
 *   2. IT ADOPTS NOTHING. No rho measured here is written anywhere, and no
 *      market number (implied_prob) is in scope in any of the pair code.
 *   3. A VERDICT NEEDS A CI AND A SAMPLE. Under min_n the numbers are printed
 *      and the verdict is 'insufficient'; above it a claim is made only when the
 *      90% paired-bootstrap CI excludes 0.
 *
 * Node built-ins only; the Python core is driven through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const PRELUDE = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
import scripts.replay_lab as rl
`;

/** Run a python snippet against the module; return the last stdout line as JSON. */
function py(body) {
  const r = spawnSync('python3', ['-'], {
    input: PRELUDE + body, cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const VERDICTS = ['insufficient', 'consistent', 'shipped_high', 'shipped_low'];
const ROW_KEYS = ['key', 'n', 'observed_joint', 'independent_joint', 'shipped_joint',
  'rho_shipped', 'rho_live', 'delta', 'ci90', 'verdict'];

/* 1 — the selftest ------------------------------------------------------------- */

test('the Python core selftests clean with the pair fixture in it', () => {
  const r = spawnSync('python3', [join('scripts', 'replay_lab.py'), '--selftest'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /same-game pair block/,
    'the selftest banner must name what it proved about the pair block');
});

/* 2 — the committed document carries the block, shaped ------------------------- */

test('the committed record carries a shaped same_game_pairs block', () => {
  const doc = readJson('data/replay_lab.json');
  const sgp = doc.same_game_pairs;
  assert.ok(sgp && typeof sgp === 'object', 'same_game_pairs is missing');
  assert.equal(typeof sgp.rule, 'string');
  assert.ok(sgp.rule.length > 20, 'the rule line must be checkable against the code');
  assert.equal(sgp.min_n, 20);
  assert.ok(Array.isArray(sgp.pairs));
  assert.ok(sgp.refused_by_reason && typeof sgp.refused_by_reason === 'object');
  assert.equal(typeof sgp.note, 'string');

  const checkRow = (row, label) => {
    assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort(), label);
    assert.ok(Number.isInteger(row.n) && row.n >= 0, `${label}: n`);
    assert.ok(VERDICTS.includes(row.verdict), `${label}: verdict ${row.verdict}`);
    if (row.n === 0) {
      for (const k of ROW_KEYS) {
        if (k === 'key' || k === 'n' || k === 'verdict') continue;
        assert.equal(row[k], null, `${label}.${k} must be null at n 0, never 0`);
      }
      assert.equal(row.verdict, 'insufficient', label);
      return;
    }
    for (const k of ['observed_joint', 'independent_joint', 'shipped_joint', 'delta']) {
      assert.equal(typeof row[k], 'number', `${label}.${k}`);
    }
    assert.ok(Array.isArray(row.ci90) && row.ci90.length === 2, `${label}: ci90`);
    assert.ok(row.ci90[0] <= row.ci90[1], `${label}: ci90 is not ordered`);
    // the verdict is exactly what the CI and the sample size say it is
    const want = row.n < sgp.min_n ? 'insufficient'
      : row.ci90[1] < 0 ? 'shipped_high'
        : row.ci90[0] > 0 ? 'shipped_low' : 'consistent';
    assert.equal(row.verdict, want, `${label}: verdict does not follow its own CI`);
    // and the delta is the difference it claims to be, to rounding
    assert.ok(Math.abs((row.observed_joint - row.shipped_joint) - row.delta) < 1e-3,
      `${label}: delta does not reconcile with observed - shipped`);
  };

  const keys = sgp.pairs.map((p) => p.key);
  assert.deepEqual(keys, [...keys].sort(), 'the pair rows must be sorted by key');
  assert.equal(new Set(keys).size, keys.length, 'a key is reported once');
  for (const row of sgp.pairs) {
    checkRow(row, row.key);
    // the key is the calibration's own key form: sorted tags, '|opposing' last
    const parts = row.key.split('|');
    assert.ok(parts.length === 2 || (parts.length === 3 && parts[2] === 'opposing'),
      `${row.key}: not the calibration's key form`);
    assert.deepEqual(parts.slice(0, 2), [...parts.slice(0, 2)].sort(),
      `${row.key}: the tags must be order-independent`);
    assert.equal(typeof row.rho_shipped, 'number', `${row.key}: rho_shipped`);
  }
  checkRow(sgp.pooled, 'pooled');
  assert.equal(sgp.pooled.key, 'all');
  assert.equal(sgp.pooled.n, sgp.pairs.reduce((a, p) => a + p.n, 0),
    'the pooled row must be every pair, and only the pairs');

  const cards = sgp.cards;
  assert.deepEqual(Object.keys(cards).sort(),
    ['all_hit_rate', 'ci90', 'delta', 'excluded_by_reason', 'mean_model_independent',
      'mean_model_shipped', 'n', 'verdict'].sort());
  assert.ok(Number.isInteger(cards.n) && cards.n >= 0);
  assert.ok(VERDICTS.includes(cards.verdict));
  if (cards.n === 0) {
    for (const k of ['all_hit_rate', 'mean_model_shipped', 'mean_model_independent',
      'delta', 'ci90']) {
      assert.equal(cards[k], null, `cards.${k} must be null at n 0, never 0`);
    }
  } else {
    assert.equal(typeof cards.all_hit_rate, 'number');
    assert.ok(cards.mean_model_shipped >= 0 && cards.mean_model_shipped <= 1);
    assert.ok(cards.mean_model_independent >= 0 && cards.mean_model_independent <= 1);
  }
});

test('the committed document validates against its contract, which requires the block', () => {
  const out = py(`
from scripts.validate_data import validate_against_schema, ValidationError
doc = json.load(open("data/replay_lab.json"))
schema = json.load(open("data/contracts/replay_lab.schema.json"))

def check(d, label):
    try:
        validate_against_schema(d, schema, label)
        return None
    except ValidationError as exc:
        return str(exc)

stripped = {k: v for k, v in doc.items() if k != "same_game_pairs"}
extra = json.loads(json.dumps(doc))
extra["same_game_pairs"]["invented_field"] = 1
bad = json.loads(json.dumps(doc))
bad["same_game_pairs"]["pooled"]["verdict"] = "adopted"
print(json.dumps({"ok": check(doc, "committed"),
                  "required": check(stripped, "no block"),
                  "strict": check(extra, "extra key"),
                  "enum": check(bad, "bad verdict")}))
`);
  assert.equal(out.ok, null, out.ok);
  assert.ok(out.required, 'the contract must REQUIRE same_game_pairs');
  assert.ok(out.strict, 'the block must be strict: an invented field must fail');
  assert.ok(out.enum, 'the verdict must be an enum — "adopted" is not a verdict here');
});

/* 3 — the verdict rule is a pure function, and it says what it means ----------- */

test('the verdict rule: a CI containing 0 is consistent, and min_n gates it', () => {
  const out = py(`
print(json.dumps({
  "min_n": rl.SAME_GAME_MIN_N,
  "contains_zero": rl.pair_verdict(rl.SAME_GAME_MIN_N, [-0.2, 0.2]),
  "touches_zero_lo": rl.pair_verdict(rl.SAME_GAME_MIN_N, [0.0, 0.3]),
  "touches_zero_hi": rl.pair_verdict(rl.SAME_GAME_MIN_N, [-0.3, 0.0]),
  "below_zero": rl.pair_verdict(rl.SAME_GAME_MIN_N, [-0.30, -0.01]),
  "above_zero": rl.pair_verdict(rl.SAME_GAME_MIN_N, [0.01, 0.30]),
  "under_min_n": rl.pair_verdict(rl.SAME_GAME_MIN_N - 1, [0.01, 0.30]),
  "no_ci": rl.pair_verdict(1000, None),
  "zero_n": rl.pair_verdict(0, None),
}))
`);
  assert.equal(out.min_n, 20);
  assert.equal(out.contains_zero, 'consistent',
    'a CI that contains 0 means the shipped joint is not contradicted');
  assert.equal(out.touches_zero_lo, 'consistent', 'a CI touching 0 does not exclude it');
  assert.equal(out.touches_zero_hi, 'consistent', 'a CI touching 0 does not exclude it');
  assert.equal(out.below_zero, 'shipped_high',
    'observed below shipped means the shipped joint overstates co-occurrence');
  assert.equal(out.above_zero, 'shipped_low');
  assert.equal(out.under_min_n, 'insufficient',
    'a decisive CI on too few pairs is still not a verdict');
  assert.equal(out.no_ci, 'insufficient');
  assert.equal(out.zero_n, 'insufficient');
});

test('a synthetic key measures the shipped rho, and the pairs it refuses are counted', () => {
  const out = py(`
import math
import scripts.models.parlay_builder as pb
corr = pb._correlation_table(pb.load_calibration())
rows = rl._pairs_fixture()
items, refused = rl.pair_items(rows, corr)
by = {}
for it in items:
    by.setdefault(it["key"], []).append(it)
big = rl.joint_block("moneyline|qb_pass_yds", by["moneyline|qb_pass_yds"])
small = rl.joint_block("qb_pass_yds|wr_rec_yds", by["qb_pass_yds|wr_rec_yds"])
root = math.sqrt(0.6 * 0.4 * 0.5 * 0.5)

# a team's moneyline plus that team's OWN spread: the slate refuses to build it,
# so there is no such card to score. Two games, one pair each, both refused.
same_side = [
  {"week": 3, "game_id": "S1", "market": "moneyline", "selection": "S1 ML",
   "side": "home", "shipped_prob": 0.6, "y": 1},
  {"week": 3, "game_id": "S1", "market": "spread", "selection": "S1 -3",
   "side": "home", "shipped_prob": 0.5, "y": 1},
  {"week": 3, "game_id": "S2", "market": "moneyline", "selection": "S2 ML",
   "side": "away", "shipped_prob": 0.6, "y": 0},
  {"week": 3, "game_id": "S2", "market": "spread", "selection": "S2 -3",
   "side": "away", "shipped_prob": 0.5, "y": 0},
]
ss_items, ss_refused = rl.pair_items(same_side, corr)
# opposing sides of the SAME game are two different opinions: scored, and keyed
# with the opposing suffix.
opposing = [
  dict(same_side[0]), dict(same_side[1], side="away", game_id="S1"),
]
op_items, _ = rl.pair_items(opposing, corr)
print(json.dumps({
  "refused": refused, "keys": sorted(by),
  "big": big, "small": small,
  "want_indep": 0.6 * 0.5,
  "want_shipped": 0.6 * 0.5 + 0.1 * root,
  "want_obs": 7.0 / 21.0,
  "want_rho_live": (7.0 / 21.0 - 0.3) / root,
  "small_want_shipped": 0.5 * 0.4 + 0.3146 * math.sqrt(0.5 * 0.5 * 0.4 * 0.6),
  "ss_items": len(ss_items), "ss_refused": ss_refused,
  "op_keys": [it["key"] for it in op_items], "op_rho": [it["rho"] for it in op_items],
}))
`);
  assert.deepEqual(out.keys, ['moneyline|qb_pass_yds', 'qb_pass_yds|wr_rec_yds']);
  assert.deepEqual(out.refused, {}, 'the fixture offers no refusable pair');
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 5e-5, `${msg}: ${a} vs ${b}`);
  // 21 pairs at pA 0.60 / pB 0.50 with default_rho 0.10 — hand-computable
  assert.equal(out.big.n, 21);
  assert.equal(out.big.rho_shipped, 0.1, 'an unmeasured pair takes default_rho');
  close(out.big.independent_joint, out.want_indep, 'independent = pA*pB');
  close(out.big.shipped_joint, out.want_shipped, 'shipped = pA*pB + rho*sqrt(...)');
  close(out.big.observed_joint, out.want_obs, 'observed = mean(yA*yB)');
  close(out.big.delta, out.want_obs - out.want_shipped, 'delta = observed - shipped');
  close(out.big.rho_live, out.want_rho_live, 'rho_live is the moment estimator');
  assert.equal(out.big.verdict, 'consistent',
    '21 pairs whose CI straddles 0 do not contradict the shipped rho');
  // under min_n the numbers are still reported — only the verdict is withheld
  assert.equal(out.small.n, 5);
  assert.equal(out.small.verdict, 'insufficient');
  assert.equal(out.small.rho_shipped, 0.3146, 'the MEASURED pair keeps its rho');
  close(out.small.shipped_joint, out.small_want_shipped, 'the measured rho is used');
  assert.equal(typeof out.small.observed_joint, 'number',
    'insufficient still reports its numbers');
  assert.ok(Array.isArray(out.small.ci90));
  // the one-leg-per-game-side refusal, counted and never scored
  assert.equal(out.ss_items, 0, 'a same-side ML+spread pair must never be scored');
  assert.deepEqual(out.ss_refused, { same_side_game_pair: 2 });
  assert.deepEqual(out.op_keys, ['moneyline|spread|opposing'],
    'opposite sides of one game are two opinions, and carry the opposing key');
  assert.ok(out.op_rho[0] < 0, 'the opposing rho of a same-side rule flips sign');
});

/* 4 — nothing adopts, and no market number is in scope ------------------------- */

test('no same-game pair function can see a book price', () => {
  const out = py(`
import inspect
src = {}
for name in ("pair_key", "corr_leg", "pair_verdict", "joint_block", "pair_items",
             "card_items", "same_game_pairs_block"):
    src[name] = inspect.getsource(getattr(rl, name))
print(json.dumps(src))
`);
  assert.equal(Object.keys(out).length, 7, 'a pair function went missing');
  for (const [name, src] of Object.entries(out)) {
    assert.ok(!src.includes('implied_prob'),
      `${name} names implied_prob — a market number may never price a model leg`);
  }
});

test('the pair block writes nothing and adopts nothing', () => {
  const src = readFileSync(join(ROOT, 'scripts/replay_lab.py'), 'utf8');
  const writes = [...src.matchAll(/open\(([^,]+),\s*["']w["']/g)].map((m) => m[1].trim());
  assert.deepEqual(writes, ['out_path'],
    'the lab may still only write its own record');
  assert.ok(!/parlay_backtest\.json["']?\s*,?\s*["']w/.test(src),
    'the measured correlation file must never be opened for writing here');
  const doc = readJson('data/replay_lab.json');
  assert.match(doc.same_game_pairs.note, /MEASURE ONLY/i);
  assert.ok(doc.policy.some((p) => /same-game correlation is scored, not trusted/i.test(p)),
    'the policy must say the correlation is scored and not adopted');
});

/* 5 — the MODEL tab renders it ------------------------------------------------- */

test('the MODEL tab renders the pairs under the replay lab card', async () => {
  const { replayLabCard } = await import(join(ROOT, 'app/views/model.js'));
  const doc = readJson('data/replay_lab.json');
  const html = replayLabCard(doc);
  assert.match(html, /SAME-GAME PAIRS/, 'the section is missing from the card');
  const sgp = doc.same_game_pairs;
  if (sgp.pairs.length) {
    assert.ok(html.includes(sgp.pairs[0].key.replace(/\|/g, ' · ')),
      'the first key is not rendered');
    assert.match(html, /OBS/);
    assert.match(html, /SHIPPED/);
    assert.match(html, /INDEP/);
  }
  // an empty pairs list says so in words, and never paints a 0
  const empty = JSON.parse(JSON.stringify(doc));
  empty.same_game_pairs.pairs = [];
  const emptyHtml = replayLabCard(empty);
  assert.match(emptyHtml, /no resolved same-game pair yet/);
  // and a record written before R87 must not throw the card over
  const older = JSON.parse(JSON.stringify(doc));
  delete older.same_game_pairs;
  assert.doesNotThrow(() => replayLabCard(older));
});
