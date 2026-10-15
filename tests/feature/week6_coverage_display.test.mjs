import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCandidateCoverage } from '../../app/views/parlays.js';

test('limited eligible offers explain missing cards without claiming duplicate chances', () => {
  const coverage = { version: 'distinct_cards_v1',
    game_shortfalls: [{ game_id: 'g1', target: 3, distinct_cards: 1 }],
    week_shortfall: { distinct_cards: 0, slate_games: 1 } };
  const game = renderCandidateCoverage(coverage, 'game', new Map([['g1', 'A @ B']]));
  assert.match(game, /A @ B: 1 of the usual 3 distinct picks available/);
  assert.match(game, /Eligible player props are unavailable/);
  assert.match(game, /Repeated picks are withheld/);
  const offline = structuredClone(coverage);
  offline.game_shortfalls[0].reason = 'prop_inputs_not_supplied';
  assert.match(renderCandidateCoverage(offline, 'game'), /Player-prop selections are not included/);
  assert.doesNotMatch(renderCandidateCoverage(offline, 'game'), /Eligible player props are unavailable/);
  assert.match(renderCandidateCoverage(coverage, 'week'), /0 distinct cross-game picks available from 1 game\./);
  assert.equal(renderCandidateCoverage(coverage, 'my'), '');
  assert.equal(renderCandidateCoverage(null, 'game'), '');
  assert.equal(renderCandidateCoverage({ version: 'unknown' }, 'game'), '');
  assert.equal(renderCandidateCoverage({ version: 'distinct_cards_v1', game_shortfalls: [], week_shortfall: null }, 'game'), '');
  assert.match(renderCandidateCoverage(coverage, 'game', new Map([['g1', '<b>A</b>']])), /&lt;b&gt;A&lt;\/b&gt;/);
});
