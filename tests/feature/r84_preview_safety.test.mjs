import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { simulateMoney, matchingLegs } from '../../app/parlay-simulation.js';
import { prepareParlaySimulation, parlayMoneyMap, parlayStake100 } from '../../app/review.js';
import { loadJson, clearCache } from '../../app/data.js';
import { scoreCard, upcomingLegs } from '../../app/views/myparlays.js';
import { combinedProbs } from '../../app/parlay-math.js';
import { renderParlayCard } from '../../app/render.js';

const legs = [
  { market: 'moneyline', selection: 'BUF ML', game_id: 'g1', side: 'home', implied_prob: .5, model_prob: .6 },
  { market: 'qb_pass_yds', selection: 'Q 200+', game_id: 'g2', side: 'away', implied_prob: .25, model_prob: .3 },
];
const outcomes = (results) => legs.map((l, i) => ({ ...l, result: results[i] }));

test('R84: moneyline display does not duplicate an existing ML suffix', () => {
  for (const selection of ['BUF ML', 'BUF']) {
    const html = renderParlayCard({ parlay_id: 'test', legs: [{ ...legs[0], selection }], model_ev: 0 });
    assert.match(html, /class="leg-nm">BUF ML<\/div>/);
    assert.doesNotMatch(html, /BUF ML ML/);
  }
});

test('R84: one simulation prices MY, published cards and graded review; net excludes stake', () => {
  assert.equal(simulateMoney(legs).net_fair, 700);
  assert.equal(scoreCard(legs, null).payout, 700);
  assert.equal(simulateMoney(legs, outcomes(['hit', 'hit'])).net_fair, 700);
  assert.equal(simulateMoney(legs, outcomes(['hit', 'void'])).net_fair, 100);
  assert.equal(simulateMoney(legs, outcomes(['void', 'void'])).net_fair, 0);
  assert.equal(simulateMoney(legs, outcomes(['hit', 'miss'])).net_fair, -100);
  assert.equal(simulateMoney(legs, outcomes(['hit', 'pending'])).kind, 'potential');
  for (const invalid of [null, undefined, 0, -1, 1.1, NaN, '0.5']) {
    assert.equal(simulateMoney([{ ...legs[0], implied_prob: invalid }]).net_fair, null);
  }
});

test('R84: review matches leg identity, not rank ID or array position; no partial total', () => {
  const source = { parlay_id: 'p1', scope: 'game', legs };
  const row = { ...source, bucket: 'all_hit', legs: outcomes(['hit', 'hit']).reverse(),
    money: { kind: 'settled', net_fair: 264.46 } }; // legacy -110 money must not survive
  const doc = { weeks: { 1: { parlays: [row], summary: { parlays: {} } } } };
  assert.equal(matchingLegs(source, row)[0].selection, 'BUF ML');
  prepareParlaySimulation(1, [source], doc);
  assert.equal(parlayMoneyMap(1, doc).get('p1').net_fair, 700);
  assert.equal(parlayStake100(1, 'game', doc).net_fair, 700);
  row.legs[0].selection = 'A different player';
  assert.equal(matchingLegs(source, row), null);
  prepareParlaySimulation(1, [source], doc);
  assert.equal(parlayMoneyMap(1, doc).size, 0);
  assert.equal(parlayStake100(1, 'game', doc).net_fair, null);
});

test('R84: three same-event legs are explicitly refused, not order-folded', () => {
  assert.throws(() => combinedProbs([...legs, legs[0]], true, null), RangeError);
});

test('R84: MY excludes kicked-off, finished and unidentified events without changing probabilities', () => {
  const start = Date.parse('2026-09-18T00:00:00Z');
  const games = [{ game_id: 'g1', kickoff_utc: '2026-09-18T00:00:00Z', status: 'STATUS_SCHEDULED' }];
  assert.deepEqual(upcomingLegs(legs, games, start - 1), [legs[0]]);
  assert.deepEqual(upcomingLegs(legs, games, start), []);
  assert.deepEqual(upcomingLegs(legs, [{ ...games[0], status: 'STATUS_FINAL' }], start - 1), []);
});

test('R84: cached data expires, requests time out, and failures can retry', async () => {
  const real = globalThis.fetch;
  clearCache();
  let calls = 0;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ n: ++calls }) });
  try {
    assert.deepEqual(await loadJson('/test-r84'), { n: 1 });
    assert.deepEqual(await loadJson('/test-r84'), { n: 1 });
    assert.deepEqual(await loadJson('/test-r84', { ttlMs: 0 }), { n: 2 });
    globalThis.fetch = () => new Promise(() => {});
    await assert.rejects(loadJson('/test-timeout-r84', { timeoutMs: 10 }), /timed out/);
    globalThis.fetch = async () => ({ ok: true, json: async () => 'recovered' });
    assert.equal(await loadJson('/test-timeout-r84'), 'recovered');
  } finally { globalThis.fetch = real; clearCache(); }
});

test('R84: future locks append per event; cutoff boundary and FINAL status are strict', () => {
  const r = spawnSync('python3', ['-'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8', input: `
import copy
from scripts.harness.snapshot import append_game_locks, pregame_lock
from scripts.resolve_locks import resolve_rows
now = '2026-09-17T20:00:00Z'
game = dict(game_id='g1', model='test', probs=dict(home=.6, away=.4), status='STATUS_SCHEDULED', kickoff_utc='2026-09-18T00:00:00Z')
rows, skipped = append_game_locks([], [game], now)
assert len(rows) == 1 and not skipped
original = copy.deepcopy(rows[0])
more = dict(game, game_id='g2')
rows, skipped = append_game_locks(rows, [game, more], now)
assert len(rows) == 2 and rows[0] == original
assert append_game_locks(rows, [game, more], now)[0] == rows
assert not pregame_lock(dict(as_of_utc=now, locked_utc=game['kickoff_utc']), game['kickoff_utc'])
assert not pregame_lock(dict(as_of_utc='2026-09-17T20:00:00', locked_utc=now), game['kickoff_utc'])
assert pregame_lock(dict(as_of_utc='2026-09-17T15:00:00-05:00', locked_utc=now), game['kickoff_utc'])
assert not append_game_locks([], [game], game['kickoff_utc'])[0]
final = dict(game, status='STATUS_IN_PROGRESS', home_score=21, away_score=7)
assert resolve_rows(rows, {'g1': final})['resolved_now'] == 0
assert rows[0] == original
final['status'] = 'STATUS_FINAL'
assert resolve_rows(rows, {'g1': final})['resolved_now'] == 1
assert rows[0]['resolved'] and not rows[1]['resolved']
late = dict(original, locked_utc=game['kickoff_utc'])
before = copy.deepcopy(late)
assert resolve_rows([late], {'g1': final})['invalid_locks'] == 1
assert late == before
` });
  assert.equal(r.status, 0, r.stderr);
});
