/* tests/feature/r51_model.test.mjs — R51: the MODEL tab's WEEKLY SPLIT GATE and
 * PARLAY GATE cards, their loaders, and the two backtest contracts.
 *
 * Owner policy, locked here:
 *   - a MISSING file renders NOTHING (the painter returns '' and the mount
 *     omits the card — no placeholder shell);
 *   - a PRESENT file with no verdict renders an AWAITING state, never a
 *     borrowed ADOPTED / RETAINED and never the metrics as if judged;
 *   - market numbers wear MEASUREMENT ONLY;
 *   - every string from the record is escaped; no inline styles.
 * The sample docs under tests/fixtures/r51/ carry the contract's expected
 * real values; the schemas are exercised through scripts/validate_data.py's
 * own validate_against_schema, exactly as the gate runs them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  weeklyGateCard, parlayGateCard, deltaText, verdictChip,
} from '../../app/views/model.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
const WEEKLY = JSON.parse(read('tests/fixtures/r51/weekly_backtest.sample.json'));
const PARLAY = JSON.parse(read('tests/fixtures/r51/parlay_backtest.sample.json'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/* --------------------------------------------------------- pure helpers */

test('deltaText marks the GOOD direction, not the sign', () => {
  assert.equal(deltaText(6.211, 6.035, { digits: 3, lowerIsBetter: true }), '−0.176 ▲');
  assert.equal(deltaText(6.035, 6.211, { digits: 3, lowerIsBetter: true }), '+0.176 ▼');
  assert.equal(deltaText(0.364, 0.389, { digits: 3 }), '+0.025 ▲');
  assert.equal(deltaText(0.389, 0.364, { digits: 3 }), '−0.025 ▼');
  assert.equal(deltaText(0.777, 0.788, { pct: true }), '+1.1 pp ▲');
  assert.equal(deltaText(0.5, 0.5, { digits: 3 }), '0.000 =');
  assert.equal(deltaText(null, 1), '—');
  assert.equal(deltaText(1, 'x'), '—');
});

test('verdictChip: boolean adopted only — a string "true" is not a verdict', () => {
  assert.match(verdictChip({ adopted: true }), /gate-chip--adopted">ADOPTED</);
  assert.equal(verdictChip({ adopted: false }), '<span class="gate-chip">RETAINED</span>');
  assert.equal(verdictChip({ adopted: 'true' }), '');
  assert.equal(verdictChip(null), '');
});

/* ------------------------------------------------------ WEEKLY SPLIT GATE */

test('weeklyGateCard renders the sample: header, verdict, pooled + 2025 table with marked deltas', () => {
  const html = weeklyGateCard(WEEKLY);
  const t = text(html);
  assert.match(html, /gate-name">weekly_split_v2 vs weekly_split_v1</);
  assert.match(html, /gate-chip gate-chip--adopted">ADOPTED</);
  assert.match(t, /2023\/2024\/2025/);
  assert.match(t, /9714 rows/);
  // pooled + held-out rows, v1 / v2 / delta, good direction marked
  assert.match(t, /POOLED MAE 6\.211 6\.035 −0\.176 ▲/);
  assert.match(t, /POOLED RANK CORR 0\.364 0\.389 \+0\.025 ▲/);
  assert.match(t, /POOLED TOP-K 77\.7% 78\.8% \+1\.1 pp ▲/);
  assert.match(t, /2025 HELD OUT MAE 6\.309 6\.160 −0\.149 ▲/);
  assert.match(t, /2025 HELD OUT RANK CORR 0\.357 0\.377 \+0\.020 ▲/);
  assert.match(t, /2025 HELD OUT TOP-K 76\.6% 77\.4% \+0\.8 pp ▲/);
  assert.match(html, /<th>Δ V2−V1<\/th>/);
});

test('weeklyGateCard: per-position rows, band, bootstrap, factors, rule and reason', () => {
  const t = text(weeklyGateCard(WEEKLY));
  assert.match(t, /QB 7\.902 → 7\.611 ▲ 0\.312 → 0\.341 ▲/);
  assert.match(t, /RB 6\.418 → 6\.230 ▲ 0\.377 → 0\.398 ▲/);
  assert.match(t, /WR 5\.874 → 5\.712 ▲/);
  assert.match(t, /TE 4\.651 → 4\.577 ▲/);
  assert.match(t, /BAND · 2025 coverage v1 66\.8% → v2 67\.0% · half-width v1 7\.45 → v2 7\.30/);
  assert.match(t, /BOOTSTRAP ΔMAE 2025 \(v2 − v1\) · mean −0\.150 · 95% \[−0\.200, −0\.100\] · season-week blocks · B=400/);
  assert.match(t, /FACTORS · DvP shrink 0\.25 \(data\/dvp_positional_history\.json\) · Elo tilt QB · weather × pass dome 1\.03 \/ outdoors 0\.97 \/ cold extra 0\.97 at 32°F \/ RB wind 0\.95 at 15 mph · venue coef 0\.020 \(rel clamp −1\.0\.\.2\.5, shrink n0 16\)/);
  assert.match(t, /NEVER-REGRESS RULE · never-regress: the candidate must not be worse/);
  assert.match(t, /v2 improves every pooled and 2025 held-out metric/);
  assert.match(t, /Season numbering: Each scored season/);
  assert.match(t, /Run 2026-09-02 · pool QB 32 · RB 60 · WR 80 · TE 32/);
});

test('weeklyGateCard: a RETAINED verdict wears the plain chip and never ADOPTED', () => {
  const d = clone(WEEKLY);
  d.verdict.adopted = false;
  const html = weeklyGateCard(d);
  assert.match(html, /<span class="gate-chip">RETAINED<\/span>/);
  assert.ok(!/ADOPTED/.test(html));
});

test('weeklyGateCard: a MISSING file renders NOTHING — no placeholder', () => {
  assert.equal(weeklyGateCard(null), '');
  assert.equal(weeklyGateCard(undefined), '');
  assert.equal(weeklyGateCard([]), '');
  assert.equal(weeklyGateCard('nope'), '');
});

test('weeklyGateCard: a PRESENT file without a verdict renders AWAITING, not the metrics', () => {
  for (const mutate of [
    (d) => { delete d.verdict; },
    (d) => { d.verdict = {}; },
    (d) => { d.verdict.adopted = 'true'; },
    (d) => { d.verdict = null; },
  ]) {
    const d = clone(WEEKLY);
    mutate(d);
    const html = weeklyGateCard(d);
    assert.match(html, /gate-chip gate-chip--skipped[^>]*>AWAITING</);
    assert.match(html, /class="state">AWAITING VERDICT/);
    assert.match(html, /weekly_split_v2 vs weekly_split_v1/);
    assert.ok(!/6\.211/.test(html), 'no metric is shown as judged without a verdict');
    assert.ok(!/ADOPTED|RETAINED/.test(html));
  }
});

test('weeklyGateCard escapes a hostile reason / rule / candidate name', () => {
  const d = clone(WEEKLY);
  d.verdict.reason = '<img src=x onerror=alert(1)>';
  d.verdict.rule = '"quoted" & <b>bold</b>';
  d.model_candidate = 'weekly_split_v2<script>';
  d.band.rule = '<svg onload=1>';
  const html = weeklyGateCard(d);
  assert.ok(!/<img|<script|<svg|<b>/.test(html));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; &lt;b&gt;/);
  assert.match(html, /weekly_split_v2&lt;script&gt;/);
  assert.ok(!/style=/.test(weeklyGateCard(WEEKLY)), 'no inline styles');
});

/* ------------------------------------------------------------ PARLAY GATE */

test('parlayGateCard: MONEYLINE row is a yardstick with the MEASUREMENT ONLY badge', () => {
  const html = parlayGateCard(PARLAY);
  const t = text(html);
  assert.match(t, /MONEYLINE ours LL 0\.6362 · Brier 0\.2231 market LL 0\.6081 · Brier 0\.2104 MEASUREMENT ONLY/);
  assert.match(html, /<span class="ms-badge"[^>]*>MEASUREMENT ONLY<\/span>/);
  assert.match(t, /n 804 · 2023 ours 0\.6401 \/ market 0\.6112 · 2024 ours 0\.6355 \/ market 0\.6070 · 2025 ours 0\.6331 \/ market 0\.6062/);
  assert.match(t, /never an input/);
});

test('parlayGateCard: SPREAD row carries the NO EDGE chip, its reason and the conviction bins', () => {
  const html = parlayGateCard(PARLAY);
  const t = text(html);
  assert.match(t, /SPREAD cover LL 0\.7196 · Brier 0\.2612 flat LL 0\.6931 · σ 13\.5 NO EDGE/);
  assert.match(html, /gate-chip gate-chip--nopath" title="Cover log-loss 0\.7196 is worse/);
  assert.match(t, /HIT RATE BY CONVICTION \(n 796\) · 0\.00-0\.05 45\.7% \(n 262\) · 0\.05-0\.10 47\.8% \(n 231\) · 0\.10-0\.15 44\.2% \(n 158\) · 0\.15-0\.20 54\.2% \(n 96\) · 0\.20\+ 48\.4% \(n 49\)/);
  assert.match(t, /spread legs stay display-priced from OUR margin/);

  const d = clone(PARLAY);
  d.spread.verdict = 'edge';
  assert.match(parlayGateCard(d), /gate-chip gate-chip--adopted">EDGE</);
  assert.ok(!/NO EDGE/.test(parlayGateCard(d)));
});

test('parlayGateCard: PROPS block — folds seed → calibrated, the >0.6 bucket, lines, sd, calibration, verdict', () => {
  const html = parlayGateCard(PARLAY);
  const t = text(html);
  assert.match(t, /PROPS lines QB 224\.5 · RB 59\.5 · WR 59\.5 residual sd QB 76\.8 · RB 37\.6 · WR 43\.2 ADOPTED/);
  assert.match(t, /2024 · fit 2023 0\.6912 → 0\.6778 ▲ 56\.5% \(1180\) → 62\.1% \(1180\) 61\.2% \(88\) → 64\.1% \(197\)/);
  assert.match(t, /2025 · fit 2023\/2024 0\.6815 → 0\.6694 ▲ 56\.5% \(1212\) → 60\.4% \(1212\) 63\.0% \(100\) → 65\.6% \(221\)/);
  assert.match(html, /<th>&gt;0\.6 HIT \(PICKS\)<\/th>/);
  assert.match(t, /CALIBRATION · QB a 0\.012 b 1\.140 c −0\.031 \(fit 2023\/2024\/2025\) · RB a −0\.008 b 1\.090 c 0\.004/);
  assert.match(t, /DvP shrink 0\.50/);
  assert.match(t, /NEVER-REGRESS RULE · never-regress: calibrated must beat seed log-loss on every walk-forward fold/);
  assert.match(t, /Calibrated beats seed on both folds/);
});

test('parlayGateCard: CORRELATIONS table — label, measured rho, n, prior; default and method', () => {
  const html = parlayGateCard(PARLAY);
  const t = text(html);
  assert.match(html, /<th>LEG PAIR<\/th><th>ρ<\/th><th>N<\/th><th>PRIOR<\/th>/);
  assert.match(t, /Moneyline x spread, same game 0\.71 796 0\.55/);
  assert.match(t, /Moneyline x QB pass-yards over, same team 0\.32 742 0\.45/);
  assert.match(t, /Spread x RB rush-yards over, same team −0\.02 655 0\.20/);
  assert.match(t, /QB pass-yards over x WR rec-yards over, same team 0\.10 611 0\.20/);
  assert.match(t, /RB rush-yards over x opposing RB rush-yards over 0\.28 540 0\.25/);
  assert.match(t, /CORRELATIONS · default ρ 0\.10 · Pearson rho on leg-outcome indicators/);
  assert.match(t, /Run 2026-09-02 · seasons 2023\/2024\/2025/);
  assert.match(t, /Market numbers on this record are a measurement yardstick only/);
});

test('parlayGateCard: a MISSING file renders NOTHING; a missing verdict renders AWAITING', () => {
  assert.equal(parlayGateCard(null), '');
  assert.equal(parlayGateCard(undefined), '');
  assert.equal(parlayGateCard([]), '');
  for (const mutate of [
    (d) => { delete d.props.verdict; },
    (d) => { d.props.verdict.adopted = 'yes'; },
    (d) => { delete d.spread.verdict; },
    (d) => { d.spread.verdict = 'maybe'; },
    (d) => { delete d.spread; },
    (d) => { delete d.props; },
  ]) {
    const d = clone(PARLAY);
    mutate(d);
    const html = parlayGateCard(d);
    assert.match(html, /gate-chip gate-chip--skipped[^>]*>AWAITING</);
    assert.match(html, /class="state">AWAITING VERDICT/);
    assert.ok(!/0\.6362|0\.7196|MEASUREMENT ONLY|NO EDGE|ADOPTED|RETAINED/.test(html),
      'nothing on an unjudged record is shown as judged');
  }
});

test('parlayGateCard escapes hostile strings in every free-text field it renders', () => {
  const d = clone(PARLAY);
  d.spread.reason = '<img src=x onerror=alert(1)>';
  d.props.verdict.reason = '"x" & <script>y</script>';
  d.props.verdict.rule = '<b>rule</b>';
  d.moneyline.note = '<i>note</i>';
  d.correlations.pairs[0].label = '<a href=x>pair</a>';
  d.correlations.method = '<u>m</u>';
  d.policy = '<em>p</em>';
  const html = parlayGateCard(d);
  assert.ok(!/<img|<script|<b>|<i>|<a |<u>|<em>/.test(html), 'no raw tag from the record survives');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;x&quot; &amp; &lt;script&gt;/);
  assert.match(html, /&lt;a href=x&gt;pair&lt;\/a&gt;/);
  assert.ok(!/style=/.test(parlayGateCard(PARLAY)), 'no inline styles');
});

/* --------------------------------------------------- the two loaders */

// app/data.js against a stubbed fetch — the same harness data_contract.test.mjs uses.
async function withStubbedFetch(fn) {
  const real = globalThis.fetch;
  const calls = [];
  const responses = new Map();
  globalThis.fetch = async (path) => {
    calls.push(path);
    const r = responses.get(path);
    if (!r) throw new Error(`unstubbed ${path}`);
    return r;
  };
  const url = new URL(pathToFileURL(join(REPO_ROOT, 'app', 'data.js')).href);
  url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  try {
    return await fn(await import(url.href), { calls, responses });
  } finally {
    globalThis.fetch = real;
  }
}

test('loadWeeklyBacktest / loadParlayBacktest: the doc on 200, NULL on 404, NULL on a parse error', async () => {
  await withStubbedFetch(async (data, { calls, responses }) => {
    responses.set('/data/weekly_backtest.json', { ok: true, status: 200, json: async () => WEEKLY });
    responses.set('/data/parlay_backtest.json', { ok: false, status: 404 });
    assert.deepEqual(await data.loadWeeklyBacktest(), WEEKLY);
    assert.equal(await data.loadParlayBacktest(), null, 'a 404 resolves to null, never rejects');
    // a 404 is evicted, so the next call retries and can succeed
    responses.set('/data/parlay_backtest.json', { ok: true, status: 200, json: async () => PARLAY });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(await data.loadParlayBacktest(), PARLAY);
    assert.equal(calls.filter((p) => p.endsWith('parlay_backtest.json')).length, 2);
  });
  await withStubbedFetch(async (data, { responses }) => {
    responses.set('/data/weekly_backtest.json', {
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); },
    });
    assert.equal(await data.loadWeeklyBacktest(), null, 'a parse error resolves to null');
  });
});

/* ------------------------------------------------ mount wiring + placement */

test('mount: both cards are omitted when the painter returns "", and sit after CALIBRATION, before SEASON LOCKS', () => {
  const src = read('app/views/model.js');
  const mount = src.slice(src.indexOf('export default async function mountModel'));
  assert.match(mount, /loadWeeklyBacktest\(\), loadParlayBacktest\(\)/, 'both loaders ride the mount allSettled');
  assert.match(mount, /\(weeklyHtml \? card\('WEEKLY SPLIT GATE[^']*', weeklyHtml, 'm-weekly-gate', 'measured'\) : ''\)/);
  assert.match(mount, /\(parlayHtml \? card\('PARLAY GATE[^']*', parlayHtml, 'm-parlay-gate', 'measured'\) : ''\)/);
  const cal = mount.indexOf("'m-cal'");
  const weekly = mount.indexOf("'m-weekly-gate'");
  const parlay = mount.indexOf("'m-parlay-gate'");
  const locks = mount.indexOf("'m-locks'");
  const baseline = mount.indexOf("'m-baseline'");
  assert.ok(cal > 0 && cal < weekly && weekly < parlay && parlay < locks && locks < baseline,
    'reading order: CALIBRATION → WEEKLY SPLIT GATE → PARLAY GATE → SEASON LOCKS → … → PROJECTION BASELINE');
});

/* ------------------------------------------------------- the contracts */

function validate(schemaName, doc) {
  // Runs the gate's own validator on the doc; returns '' when valid, else the message.
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: 'import json, sys\nsys.path.insert(0, ".")\n'
      + 'from scripts.validate_data import validate_against_schema, ValidationError, _load, CONTRACTS, OPTIONAL_DATA, SCHEMA_TO_DATA\n'
      + 'import os\n'
      + `schema = _load(os.path.join(CONTRACTS, ${JSON.stringify(schemaName)}))\n`
      + 'doc = json.loads(sys.stdin.read()) if False else json.loads(' + JSON.stringify(JSON.stringify(doc)) + ')\n'
      + 'try:\n'
      + `    validate_against_schema(doc, schema, ${JSON.stringify(schemaName.replace('.schema', ''))})\n`
      + '    print(json.dumps(""))\n'
      + 'except ValidationError as e:\n'
      + '    print(json.dumps(str(e)))\n',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('both feeds are registered OPTIONAL in validate_data.py with their schemas', () => {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: 'import json, sys\nsys.path.insert(0, ".")\n'
      + 'from scripts.validate_data import OPTIONAL_DATA, SCHEMA_TO_DATA\n'
      + 'print(json.dumps({"opt": sorted(OPTIONAL_DATA), "map": SCHEMA_TO_DATA}))\n',
  });
  const { opt, map } = JSON.parse(out.trim().split('\n').pop());
  assert.ok(opt.includes('weekly_backtest.json') && opt.includes('parlay_backtest.json'));
  assert.equal(map['weekly_backtest.schema.json'], 'weekly_backtest.json');
  assert.equal(map['parlay_backtest.schema.json'], 'parlay_backtest.json');
});

test('weekly_backtest.schema.json accepts the sample and pins the contract', () => {
  assert.equal(validate('weekly_backtest.schema.json', WEEKLY), '');
  const bad = [
    [(d) => { d.verdict.adopted = 'true'; }, /verdict\.adopted: expected type boolean/],
    [(d) => { delete d.bootstrap.delta_mae_2025.B; }, /missing required property 'B'/],
    [(d) => { d.per_position.QB.v2.rank_corr = 'x'; }, /per_position\.QB\.v2\.rank_corr: expected type number/],
    [(d) => { d.model_candidate = 'other_model'; }, /model_candidate/],
    [(d) => { d.band.v1.coverage_2025 = 1.5; }, /coverage_2025: 1\.5 > maximum 1/],
    [(d) => { delete d.factors.weather; }, /missing required property 'weather'/],
    [(d) => { d.fixture.pool.TE = 'many'; }, /fixture\.pool\.TE: expected type integer/],
  ];
  for (const [mutate, re] of bad) {
    const d = clone(WEEKLY);
    mutate(d);
    assert.match(validate('weekly_backtest.schema.json', d), re);
  }
});

test('parlay_backtest.schema.json accepts the sample and pins the contract', () => {
  assert.equal(validate('parlay_backtest.schema.json', PARLAY), '');
  const bad = [
    [(d) => { d.spread.verdict = 'maybe'; }, /spread\.verdict: .*not in enum/],
    [(d) => { d.props.verdict.adopted = 1; }, /props\.verdict\.adopted: expected type boolean/],
    [(d) => { d.props.calibration.QB.a = 'x'; }, /props\.calibration\.QB\.a: expected type number/],
    [(d) => { delete d.props.calibration.WR.c; }, /calibration\.WR: missing required property 'c'/],
    [(d) => { delete d.correlations.pairs[0].prior; }, /correlations\.pairs\[0\]: missing required property 'prior'/],
    [(d) => { d.correlations.pairs[1].rho = 1.2; }, /rho: 1\.2 > maximum 1/],
    [(d) => { delete d.moneyline.market_log_loss; }, /moneyline: missing required property 'market_log_loss'/],
    [(d) => { d.spread.pick_hit_rate_by_conviction[0].n = -1; }, /n: -1 < minimum 0/],
    [(d) => { d.props.folds[0].seed.picks_60 = 1.5; }, /picks_60: expected type integer/],
  ];
  for (const [mutate, re] of bad) {
    const d = clone(PARLAY);
    mutate(d);
    assert.match(validate('parlay_backtest.schema.json', d), re);
  }
});
