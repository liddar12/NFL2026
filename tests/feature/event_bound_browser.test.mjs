import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLeg } from '../../app/bets.js';

const week = {
  games: { G: { h: 'BUF', a: 'KC', hs: 24, as: 20 }, live: { h: 'BUF', a: 'KC' } },
  players: { p: { y: [300, 20, 0], td: 1 } },
};
const leg = { week: 4, season: 2026, game_id: 'G', team: 'BUF', gsis_id: 'p',
  market: 'qb_pass_yds', line: 249.5 };

test('cached legacy player facts cannot settle an explicit unknown or unfinished fixture', () => {
  const facts = { season: 2026, weeks: { 4: week } };
  for (const market of ['qb_pass_yds', 'anytime_td']) {
    const receipt = { ...leg, market };
    assert.equal(gradeLeg(receipt, facts).result, 'hit');
    assert.equal(gradeLeg({ ...receipt, game_id: 'unknown' }, facts).reason, 'game_unknown');
    assert.equal(gradeLeg({ ...receipt, game_id: 'live' }, facts).reason, 'no_final');
    assert.equal(gradeLeg({ ...receipt, team: 'NO' }, facts).reason, 'receipt_team_mismatch');
  }
});

test('an event-bound document with its scoped facts missing never falls back to weekly facts', () => {
  const facts = { season: 2026, grading_policy: 'event_bound_v1', weeks: { 4: week } };
  for (const market of ['qb_pass_yds', 'anytime_td']) {
    assert.deepEqual(gradeLeg({ ...leg, market }, facts), {
      result: 'pending', actual: null, reason: 'player_game_facts_missing',
    });
  }
  const complete = { ...facts, weeks: { 4: { ...week, players_by_game: { G: week.players } } } };
  assert.equal(gradeLeg(leg, complete).result, 'hit');
});
