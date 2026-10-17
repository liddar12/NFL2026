import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertScheduledSeedCoverage } from '../fixtures/selected_seed_universe.mjs';

function fixture() {
  const generated = '2026-10-17T14:00:00Z';
  return {
    pool: { season: 2026, week: 6, generated_utc: generated, players: [],
      freshness_policy: { version: 1, profile: 'provisional_before_90m_v1',
        policy_id: `sha256:${'a'.repeat(64)}`, generated_utc: generated,
        games: [{ game_id: 'past', state: 'held', check_due_utc: '2026-10-15T22:45:00Z',
          source_expires_utc: '2026-10-17T20:00:00Z', blocked_player_ids: ['past-A', 'past-B'],
          player_source_expires: {} }, { game_id: 'future', state: 'provisional',
          check_due_utc: '2026-10-18T15:30:00Z', source_expires_utc: '2026-10-17T20:00:00Z',
          blocked_player_ids: [], player_source_expires: {} }] } },
    games: [{ game_id: 'past', week: 6, home: 'AAA', away: 'BBB', status: 'STATUS_FINAL',
      kickoff_utc: '2026-10-16T00:15:00Z' }, { game_id: 'future', week: 6, home: 'CCC', away: 'DDD',
      status: 'STATUS_SCHEDULED', kickoff_utc: '2026-10-18T17:00:00Z' }],
    projections: [{ gsis_id: 'past-A', team: 'AAA', position: 'WR' },
      { gsis_id: 'past-B', team: 'BBB', position: 'QB' }],
  };
}
const seeds = (...names) => names.map((name) => ({ kind: 'team', name }));
const check = (f, rows) => assertScheduledSeedCoverage(f.pool, f.games, [], f.projections, rows);

test('selected FINAL held sides can be absent while every future scheduled side remains required', () => {
  check(fixture(), seeds('CCC', 'DDD'));
  assert.throws(() => check(fixture(), seeds('CCC')), /every required scheduled team/);
});

test('legacy coverage keeps the full scheduled floor and cannot mask a missing future team', () => {
  const f = fixture(); delete f.pool.freshness_policy;
  assert.throws(() => check(f, seeds('CCC', 'DDD')), /every required scheduled team/);
  assert.throws(() => check(f, seeds('AAA', 'BBB', 'CCC')), /every required scheduled team/);
  check(f, seeds('AAA', 'BBB', 'CCC', 'DDD'));
});

test('a FINAL-game exception cannot erase a team also scheduled in a future game', () => {
  const f = fixture(); f.games[1].home = 'AAA';
  assert.throws(() => check(f, seeds('DDD')), /every required scheduled team/);
  check(f, seeds('AAA', 'DDD'));
});

for (const [label, mutate] of [
  ['claimed held future game', (f) => { f.pool.freshness_policy.games[1].state = 'held'; }],
  ['missing past roster identity', (f) => { f.pool.freshness_policy.games[0].blocked_player_ids.pop(); }],
  ['wrong past cutoff', (f) => { f.pool.freshness_policy.games[0].check_due_utc = '2026-10-15T22:46:00Z'; }],
  ['past game not FINAL', (f) => { f.games[0].status = 'STATUS_SCHEDULED'; }],
  ['unknown profile', (f) => { f.pool.freshness_policy.profile = 'posted_is_active'; }],
  ['held past yardage still offered', (f) => { f.pool.players.push({ gsis_id: 'past-A',
    market: 'wr_rec_yds', game_id: 'past', rungs: [] }); }],
]) test(`seed floor refuses ${label} as an exemption`, () => {
  const f = fixture(); mutate(f);
  const missing = label === 'claimed held future game' ? seeds('CCC') : seeds('CCC', 'DDD');
  assert.throws(() => check(f, missing), /every required scheduled team/);
});
