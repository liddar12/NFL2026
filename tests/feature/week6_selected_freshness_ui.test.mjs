import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { poolLearningStatus, learningEligibleLegs, learningCardRefusal, renderPoolLearning } from '../../app/pool-learning-status.js';
import { myCardRefusal, emptyReason } from '../../app/views/myparlays.js';
import { builderLegs, recommendationRefusal, openBetSheet } from '../../app/views/mybets.js';

// Saved display-policy fixtures only: these do not assert model adoption,
// authenticated owner intent, official inactive completeness or fitted quality.
const generated = '2026-10-18T14:00:00Z';
const initial = Date.parse('2026-10-18T15:00:00Z');
const due = '2026-10-18T15:30:00Z';
const laterDue = '2026-10-18T18:30:00Z';
const players = [
  { gsis_id: 'QB1', game_id: 'G1', market: 'qb_pass_yds', position: 'QB' },
  { gsis_id: 'WR1', game_id: 'G1', market: 'wr_rec_yds', position: 'WR' },
  { gsis_id: 'RB2', game_id: 'G2', market: 'rb_rush_yds', position: 'RB' },
];
const propLegs = players.map((p) => ({ ...p, owner: p.gsis_id, selection: `${p.gsis_id} 20+ yards`, model_prob: .6 }));
const separate = [{ game_id: 'G1', market: 'moneyline', selection: 'SEA ML', model_prob: .6 },
  { game_id: 'G1', market: 'anytime_td', selection: 'WR1 TD', model_prob: .4 }];
const legs = [...propLegs, ...separate];
const games = [{ game_id: 'G1', kickoff_utc: '2026-10-18T17:00:00Z', status: 'STATUS_SCHEDULED' },
  { game_id: 'G2', kickoff_utc: '2026-10-18T20:00:00Z', status: 'STATUS_SCHEDULED' }];
function pool() {
  return { generated_utc: generated, players: players.map((p) => ({ ...p, player: p.gsis_id,
    rungs: [{ selection: `${p.gsis_id} 20+ yards`, line: 20, model_prob: .6 }] })),
  game_legs: [separate[0]], atd_legs: [{ ...players[1], rungs: [{ selection: 'WR1 TD', model_prob: .4 }] }],
  freshness_policy: { version: 1, profile: 'provisional_before_90m_v1', policy_id: `sha256:${'a'.repeat(64)}`,
    generated_utc: generated, games: [
      { game_id: 'G1', check_due_utc: due, source_expires_utc: '2026-10-18T19:00:00Z',
        state: 'provisional', blocked_player_ids: [], player_source_expires: { QB1: '2026-10-18T15:10:00Z' } },
      { game_id: 'G2', check_due_utc: laterDue, source_expires_utc: '2026-10-18T19:00:00Z',
        state: 'provisional', blocked_player_ids: [], player_source_expires: {} },
    ] } };
}

test('selected policy labels provisional props and schedules earliest player/source/inactive deadline', () => {
  const p = pool(), before = JSON.stringify(p);
  const status = poolLearningStatus(p, initial);
  assert.equal(status.blockProps, false);
  assert.equal(status.freshnessSelected, true);
  assert.equal(status.nextCheckMs, Date.parse('2026-10-18T15:10:00Z'));
  assert.strictEqual(learningEligibleLegs(legs, status), legs);
  assert.match(renderPoolLearning(status), /Provisional MY props/);
  assert.match(renderPoolLearning(status), /not confirmed active/);
  assert.equal(JSON.stringify(p), before);
});

test('QB source expiry withholds that player only; WR/RB/later games/ML/TD remain', () => {
  const status = poolLearningStatus(pool(), Date.parse('2026-10-18T15:10:00Z'));
  assert.deepEqual(status.blockedPlayerIds, ['QB1']);
  assert.deepEqual(status.blockedGameIds, []);
  assert.deepEqual(learningEligibleLegs(legs, status), legs.slice(1));
  assert.equal(status.nextCheckMs, Date.parse(due));
});

test('90-minute cutoff is exclusive, team-local and never unheld by invented posted flags', () => {
  const p = pool();
  assert.equal(learningCardRefusal(p, [propLegs[1]], Date.parse(due) - 1), null);
  const status = poolLearningStatus(p, Date.parse(due));
  assert.deepEqual(status.blockedGameIds, ['G1']);
  assert.deepEqual(learningEligibleLegs(legs, status), [propLegs[2], ...separate]);
  assert.equal(status.nextCheckMs, Date.parse(laterDue));
  assert.match(learningCardRefusal(p, [propLegs[1]], Date.parse(due)), /inactive recheck/);
  assert.equal(learningCardRefusal(p, [propLegs[2], ...separate], Date.parse(due)), null);
  p.freshness_policy.games[0].posted = true;
  p.freshness_policy.games[0].complete = true;
  assert.equal(poolLearningStatus(p, initial).blockProps, true, 'unrecognized confirmation claims cannot relax policy');
});

test('global injury/source expiry holds all due game props, but never reprices or removes moneyline/TD', () => {
  const p = pool(), before = JSON.stringify(legs);
  p.freshness_policy.games[0].source_expires_utc = '2026-10-18T15:05:00Z';
  const status = poolLearningStatus(p, Date.parse('2026-10-18T15:05:00Z'));
  assert.deepEqual(learningEligibleLegs(legs, status), [propLegs[2], ...separate]);
  assert.equal(JSON.stringify(legs), before);
});

test('saved held state stays held before cutoff and a source-withheld player cannot reappear', () => {
  const p = pool();
  p.freshness_policy.games[0].state = 'held';
  p.freshness_policy.games[1].blocked_player_ids = ['RB2'];
  const s = poolLearningStatus(p, initial);
  assert.deepEqual(learningEligibleLegs(legs, s), separate);
  assert.match(emptyReason([], [], [], 6, initial, s), /inactive recheck/);
  assert.match(emptyReason([], [], [], 6, initial, s), /changing the risk dial does not reactivate/);
});

test('malformed selected metadata fails closed while absent old policy remains unchanged', () => {
  const changes = [
    (p) => { p.freshness_policy = null; },
    (p) => { p.freshness_policy.generated_utc = '2026-10-18T14:01:00Z'; },
    (p) => { p.freshness_policy.policy_id = 'not-a-hash'; },
    (p) => { p.freshness_policy.profile = 'wait_for_confirmed_inactives_v1'; },
    (p) => { p.freshness_policy.games.pop(); },
    (p) => { p.freshness_policy.games.push(structuredClone(p.freshness_policy.games[0])); },
    (p) => { p.freshness_policy.games[0].check_due_utc = '2026-10-18'; },
    (p) => { p.freshness_policy.games[0].state = 'confirmed'; },
    (p) => { p.freshness_policy.games[0].blocked_player_ids = ['QB1', 'QB1']; },
    (p) => { delete p.freshness_policy.games[0].player_source_expires; },
    (p) => { p.freshness_policy.games[0].player_source_expires.QB1 = 'tomorrow'; },
  ];
  for (const change of changes) {
    const p = pool(); change(p);
    const status = poolLearningStatus(p, initial);
    assert.equal(status.blockProps, true);
    assert.deepEqual(learningEligibleLegs(legs, status), separate);
  }
  const old = pool(); delete old.freshness_policy;
  assert.strictEqual(learningEligibleLegs(legs, poolLearningStatus(old, initial)), legs);
});

test('MY pre-import, post-import and save guards recheck the original pool and game clocks', () => {
  const p = pool(), card = { legs: [propLegs[1], propLegs[2]] };
  assert.equal(myCardRefusal(card, p, games, initial), null);
  assert.match(myCardRefusal(card, p, games, Date.parse(due)), /inactive recheck/);
  assert.match(myCardRefusal({ legs: [separate[0]] }, p, games,
    Date.parse(games[0].kickoff_utc)), /has started/);
  const source = readFileSync(new URL('../../app/views/myparlays.js', import.meta.url), 'utf8');
  assert.match(source, /if \(refusal\(\)\) \{ paint\(el\); return; \}\s*mod\.openBetSheet/);
  assert.match(source, /recommendationGuard: refusal/);
  assert.match(source, /addEventListener\('visibilitychange', onResume\)/);
  assert.match(source, /addEventListener\('pageshow', onResume\)/);
  assert.match(source, /poolLearningStatus\(state\.pool\)\.nextCheckMs/);
});

test('built-from-pool route inherits player and game holds rather than bypassing MY', () => {
  const p = pool();
  assert.equal(builderLegs(p, initial).length, 5);
  const after = builderLegs(p, Date.parse(due));
  assert.deepEqual(after.map((l) => l.market).sort(), ['anytime_td', 'moneyline', 'rb_rush_yds'].sort());
});

test('save guard rejects exceptions/non-null non-reasons, and unguarded actual-ticket recording remains allowed', () => {
  assert.equal(recommendationRefusal(null), null);
  assert.equal(recommendationRefusal(() => null), null);
  assert.equal(recommendationRefusal(() => 'held'), 'held');
  for (const guard of [false, () => false, () => undefined, () => { throw new Error('offline'); }]) {
    assert.match(recommendationRefusal(guard), /could not be checked/);
  }
});

test('actual open sheet cannot save after cutoff; an independently recorded placed ticket can still be saved', () => {
  const savedWindow = globalThis.window, savedDocument = globalThis.document;
  let writes = 0, activeSheet;
  const storage = new Map();
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => { writes += 1; storage.set(key, value); } } };
  globalThis.document = { getElementById: () => null, querySelector: () => null,
    body: { appendChild: (node) => { activeSheet = node; } },
    createElement: () => {
      const fields = { '#mb-stake': { value: '10', focus() {} }, '#mb-odds': { value: '+250' },
        '#mb-ret': { textContent: '', classList: { add() {} } } };
      return { innerHTML: '', listeners: {}, fields, removed: false,
        querySelector: (key) => fields[key], addEventListener(name, fn) { this.listeners[name] = fn; },
        remove() { this.removed = true; } };
    } };
  try {
    let checked = initial;
    const p = pool();
    openBetSheet({ source: 'my', week: 6, legs: [propLegs[1]],
      recommendationGuard: () => learningCardRefusal(p, [propLegs[1]], checked) });
    checked = Date.parse(due);
    const save = { closest: () => ({ dataset: { mb: 'save' } }) };
    activeSheet.listeners.click({ target: save });
    assert.equal(writes, 0);
    assert.equal(activeSheet.removed, false);
    assert.match(activeSheet.fields['#mb-ret'].textContent, /inactive recheck/);
    openBetSheet({ source: 'manual', week: 6, legs: [propLegs[1]], title: 'already placed ticket' });
    activeSheet.listeners.click({ target: save });
    assert.equal(writes, 1);
    assert.equal(activeSheet.removed, true);
  } finally { globalThis.window = savedWindow; globalThis.document = savedDocument; }
});
