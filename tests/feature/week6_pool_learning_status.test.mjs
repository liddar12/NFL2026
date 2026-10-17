import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { poolLearningStatus, renderPoolLearning, learningEligibleLegs,
  PERIOD_SOURCE_MAX_AGE_MS } from '../../app/pool-learning-status.js';
import { renderSeedOption, emptyReason } from '../../app/views/myparlays.js';

// Original receipts are made by the actual Python producer, not JS-shaped
// hand-written probabilities. Additional v2 display pins below are SYNTHETIC
// unit fixtures only, never an owner approval or fitted-accuracy assertion.
const root = new URL('../..', import.meta.url);
const generated = '2026-10-16T20:00:00Z';
const now = Date.parse(generated) + 1000;
const H = (c) => `sha256:${c.repeat(64)}`;
const produced = JSON.parse(execFileSync('python3', ['-B', '-'], { cwd: root,
  encoding: 'utf8', input: `import json
from scripts import build_leg_pool as B
from tests.fixtures.period_return import inputs
i,_,_,_=inputs(6,'${generated}',n=4,tag='display')
base=B.build(i)
i['pool_backtest']['live_2026']={'applied':True,'adjustment':{'a':.3,'b':1.1},
 'receipt_policy':base['learning_receipt_policy'],'base_model_version':base['base_model_version']}
print(json.dumps({'base':base,'corrected':B.build(i)}))
` }));
const { base, corrected } = produced;
function pool(action = 'approve') {
  const p = structuredClone(action === 'revoke' ? base : corrected);
  p.calibration_return = { version: 2, action, scope_id: H('1'), candidate_id: H('2'),
    artifact_id: action === 'revoke' ? null : H('3'), owner_head_event_id: H('4'),
    application_context_id: H('5'), expires_utc: action === 'revoke' ? null : '2026-10-17T05:00:00Z',
    evidence_basis: 'retrospective_refitting_policy_not_fixed_artifact_prospective_validation' };
  const { action: _, ...context } = p.calibration_return;
  for (const player of p.players) for (const rung of player.rungs) {
    rung.learning_receipt.input_context.calibration_return = structuredClone(context);
    rung.learning_receipt.source_timestamps.return_schedule = generated;
  }
  return p;
}

test('actual ordinary producer remains base-only and does not emit period approval metadata', () => {
  assert.equal(Object.hasOwn(base, 'calibration_return'), false);
  const before = JSON.stringify(base);
  const s = poolLearningStatus(base, now);
  assert.equal(s.state, 'base_only');
  assert.equal(s.blockProps, false);
  assert.equal(s.baseVersion, base.players[0].rungs[0].learning_receipt.base_model_version);
  assert.equal(s.calibratorVersion, base.players[0].rungs[0].learning_receipt.calibrator_version);
  assert.equal(s.artifactId, null);
  assert.equal(JSON.stringify(base), before, 'status analysis is read-only');
});

test('an actual once-served legacy correction reports its receipt version without period approval claims', () => {
  const s = poolLearningStatus(corrected, now);
  assert.equal(s.state, 'saved_correction');
  assert.equal(s.calibratorVersion, corrected.players[0].rungs[0].learning_receipt.calibrator_version);
  assert.notEqual(s.calibratorVersion, poolLearningStatus(base, now).calibratorVersion);
  assert.equal(s.artifactId, null);
  assert.equal(s.ownerEventId, null);
});

test('missing old metadata is unknown, never invented learning adoption or global withholding', () => {
  for (const p of [null, {}, { players: [] }, JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url)))]) {
    const s = poolLearningStatus(p, now);
    assert.equal(s.blockProps, false);
    assert.equal(s.artifactId, null);
    assert.ok(['unknown', 'unavailable'].includes(s.state));
  }
});

test('a saved approve/rollback/revoke displays the actual rung version, not an unrelated proposal', () => {
  for (const action of ['approve', 'rollback', 'revoke']) {
    const p = pool(action);
    p.latest_candidate = { artifact_id: H('9'), approved: true, status: 'PASS' };
    const s = poolLearningStatus(p, now);
    assert.equal(s.state, action === 'revoke' ? 'revoked' : 'saved_period_return');
    assert.equal(s.blockProps, false);
    assert.equal(s.action, action);
    assert.equal(s.artifactId, action === 'revoke' ? null : H('3'));
    assert.equal(s.ownerEventId, H('4'));
    assert.equal(s.applicationContextId, H('5'));
    const html = renderPoolLearning(s);
    assert.match(html, /current owner authority and live pipeline health are not checked/);
    assert.match(html, /Retrospective evidence is not prospective proof/);
    assert.ok(!html.includes(H('9')));
  }
});

test('approval expiry is exclusive and withholds only yardage props without re-pricing', () => {
  const p = pool();
  const expires = Date.parse(p.calibration_return.expires_utc);
  assert.equal(poolLearningStatus(p, expires - 1).blockProps, false);
  const s = poolLearningStatus(p, expires);
  assert.equal(s.state, 'expired');
  assert.equal(s.blockProps, true);
  const legs = [{ market: 'qb_pass_yds', model_prob: .6 }, { market: 'rb_rush_yds' },
    { market: 'wr_rec_yds' }, { market: 'moneyline', model_prob: .7 },
    { market: 'spread' }, { market: 'anytime_td' }];
  const before = JSON.stringify(legs);
  assert.deepEqual(learningEligibleLegs(legs, s), legs.slice(3));
  assert.equal(JSON.stringify(legs), before);
  assert.strictEqual(learningEligibleLegs(legs, { blockProps: false }), legs);
});

test('12-hour source-age boundary is inclusive, then stale, and schedules another check', () => {
  const p = pool('revoke');
  const earliest = Date.parse(p.players[0].rungs[0].learning_receipt.source_timestamps.player_weekly);
  const boundary = earliest + PERIOD_SOURCE_MAX_AGE_MS;
  const onEdge = poolLearningStatus(p, boundary);
  assert.equal(onEdge.state, 'revoked');
  assert.equal(onEdge.nextCheckMs, boundary + 1);
  assert.equal(poolLearningStatus(p, boundary + 1).state, 'stale');
  assert.equal(poolLearningStatus(p, boundary + 1).blockProps, true);
});

test('a page clock before generation cannot present a saved correction as currently usable', () => {
  for (const bad of [NaN, Infinity, Date.parse(generated) - 1]) {
    const s = poolLearningStatus(pool(), bad);
    assert.equal(s.state, 'unavailable');
    assert.equal(s.blockProps, true);
  }
});

const mutations = [
  ['root metadata absent', (p) => { delete p.calibration_return; }],
  ['root metadata null', (p) => { p.calibration_return = null; }],
  ['root arbitrary flag', (p) => { p.calibration_return.approved = true; }],
  ['a single missing receipt', (p) => { delete p.players.at(-1).rungs.at(-1).learning_receipt; }],
  ['a single missing context', (p) => { delete p.players.at(-1).rungs.at(-1).learning_receipt.input_context.calibration_return; }],
  ['new proposal cannot override receipt', (p) => { p.calibration_return.artifact_id = H('9'); }],
  ['wrong version', (p) => { p.calibration_return.version = 1; }],
  ['unknown action', (p) => { p.calibration_return.action = 'PASS'; }],
  ['pool clock missing', (p) => { delete p.generated_utc; }],
  ['pool base mismatch', (p) => { p.base_model_version = H('9'); }],
  ['pool coefficient mismatch', (p) => { p.live_adjustment = { a: .2, b: 1 }; }],
  ['served number mismatch', (p) => { p.players[0].rungs[0].model_prob += .01; }],
  ['receipt points at another player', (p) => { p.players[0].rungs[0].learning_receipt.player_id = 'other'; }],
  ['receipt points at another game', (p) => { p.players[0].rungs[0].learning_receipt.game_id = 'other'; }],
  ['receipt points at another line', (p) => { p.players[0].rungs[0].learning_receipt.line += 10; }],
  ['mixed calibration version', (p) => { p.players[0].rungs[0].learning_receipt.calibrator_version = H('9'); }],
  ['unknown schedule clock', (p) => { delete p.players[0].rungs[0].learning_receipt.source_timestamps.return_schedule; }],
  ['source clock after forecast', (p) => { p.players[0].rungs[0].learning_receipt.source_timestamps.return_schedule = '2026-10-16T21:00:00Z'; }],
];
for (const [name, mutate] of mutations) test(`period metadata refuses ${name}`, () => {
  const p = pool(); mutate(p);
  const s = poolLearningStatus(p, now);
  assert.equal(s.blockProps, true, name);
  assert.ok(['held', 'unavailable'].includes(s.state), name);
});

test('invalid approval expiry/artifact and invalid revoke claims are held even with matching rung metadata', () => {
  const cases = [ { expires_utc: 'yesterday' }, { expires_utc: generated }, { artifact_id: null },
    { scope_id: '<img src=x onerror=alert(1)>' }, { action: 'revoke' },
    { action: 'revoke', artifact_id: null, expires_utc: '2026-10-17T00:00:00Z' } ];
  for (const changes of cases) {
    const p = pool(); Object.assign(p.calibration_return, changes);
    const { action: _, ...context } = p.calibration_return;
    for (const player of p.players) for (const rung of player.rungs) {
      rung.learning_receipt.input_context.calibration_return = { ...context };
    }
    assert.equal(poolLearningStatus(p, now).blockProps, true, JSON.stringify(changes));
  }
});

test('a legacy period-return status string is not sufficient authority or version metadata', () => {
  const p = structuredClone(base);
  p.live_adjustment_status = 'period return v2: approve; artifact invented';
  const s = poolLearningStatus(p, now);
  assert.equal(s.state, 'held');
  assert.equal(s.blockProps, true);
});

test('display escapes every interpolated field and wraps full hashes at mobile widths', () => {
  const html = renderPoolLearning({ ...poolLearningStatus(pool(), now),
    label: '<script>alert(1)</script>', note: '<img src=x>', baseVersion: '" onmouseover="x' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&quot; onmouseover=&quot;x'));
  assert.match(html, /does not authenticate receipt hashes, an owner or publication/);
  const css = readFileSync(new URL('../../app/theme.css', import.meta.url), 'utf8');
  assert.match(css, /\.mp-learning dd\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('a held future prop is not called GAME FINAL or a risk-dial mismatch', () => {
  const option = { kind: 'player', id: 'p1', name: 'Future Player', team: 'SEA', position: 'WR' };
  const live = new Set(['p1']);
  const held = renderSeedOption(option, 0, 0, live, new Set(['p1']));
  assert.match(held, /PROP MODEL HELD/);
  assert.ok(!held.includes('GAME FINAL'));
  assert.ok(!renderSeedOption(option, 0, 0, live).includes('MODEL HELD'));
  assert.match(renderSeedOption(option, 0, 0, new Set()), /GAME FINAL/);
  const status = poolLearningStatus(pool(), Date.parse('2026-10-17T05:00:00Z'));
  const reason = emptyReason([option], [], [], 6, now, status);
  assert.match(reason, /Approval expired/);
  assert.match(reason, /changing the risk dial does not reactivate/);
  assert.ok(!reason.includes('try another risk'));
});
