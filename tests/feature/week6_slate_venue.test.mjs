import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderGameCard } from '../../app/render.js';
import { enrichSlateVenues } from '../../app/views/slate.js';

const frozen = JSON.parse(readFileSync(new URL('../fixtures/slate_venue_cf3213.json', import.meta.url), 'utf8'));
const copy = (value) => structuredClone(value);
const venue = (game) => renderGameCard(game).match(/<span class="g-venue">([^<]*)<\/span>/)[1];
const changedSchedule = (change) => ({ ...copy(frozen.schedule), games: [{
  ...copy(frozen.schedule.games[0]), ...change,
}] });

test('exact cf3213 Wembley event displays its actual venue, never Jacksonville home stadium', () => {
  const before = JSON.stringify(frozen);
  const [game] = enrichSlateVenues(frozen.predictions, frozen.schedule);
  assert.equal(game.venue, 'Wembley Stadium');
  assert.equal(venue(game), 'WEMBLEY STADIUM · OUTDOOR');
  assert.doesNotMatch(renderGameCard(game), /EVERBANK/);
  assert.equal(JSON.stringify(frozen), before, 'both source documents remain unchanged');
  assert.deepEqual(game.probs, frozen.predictions.games[0].probs);
});

test('only venue metadata is copied; source probabilities, status, roof and model never replace prediction fields', () => {
  const schedule = changedSchedule({ probs: { home: 0.01, away: 0.99 }, roof: 'indoor',
    status: 'STATUS_FINAL', model: 'different', estimate: false, extra: 'not copied' });
  const original = frozen.predictions.games[0];
  const [game] = enrichSlateVenues(frozen.predictions, schedule);
  assert.deepEqual(game, { ...original, venue: 'Wembley Stadium' });
  assert.strictEqual(game.probs, original.probs, 'same probability object, not a repriced copy');
});

test('missing or malformed schedule is optional and leaves a visible unknown rather than a home fallback', () => {
  for (const schedule of [null, undefined, {}, { season: 2026 }, { season: 2026, games: {} },
    { season: 2025, games: frozen.schedule.games }, { season: '2026', games: frozen.schedule.games }]) {
    const [game] = enrichSlateVenues(frozen.predictions, schedule);
    assert.equal(venue(game), 'VENUE UNKNOWN · OUTDOOR');
    assert.deepEqual(game, frozen.predictions.games[0]);
  }
});

test('ID, teams, literal kickoff and event week must all match the same season', () => {
  for (const change of [{ game_id: 'other' }, { game_id: 401872996 }, { home: 'HOU', away: 'JAX' },
    { home: 'KC' }, { away: 'DAL' }, { week: 7 }, { week: '6' }, { week: undefined },
    { kickoff_utc: '2026-10-18T14:30Z' }, { kickoff_utc: undefined }]) {
    const [game] = enrichSlateVenues(frozen.predictions, changedSchedule(change));
    assert.equal(venue(game), 'VENUE UNKNOWN · OUTDOOR', JSON.stringify(change));
  }
  const predictions = { ...copy(frozen.predictions), games: [{ ...frozen.predictions.games[0], week: 7 }] };
  assert.equal(venue(enrichSlateVenues(predictions, frozen.schedule)[0]), 'VENUE UNKNOWN · OUTDOOR');
});

test('duplicate IDs cannot arbitrarily choose a venue, even when one duplicate matches', () => {
  for (const second of [copy(frozen.schedule.games[0]), { ...copy(frozen.schedule.games[0]),
    home: 'KC', venue: 'Arrowhead Stadium' }]) {
    const schedule = { ...copy(frozen.schedule), games: [...frozen.schedule.games, second] };
    const [game] = enrichSlateVenues(frozen.predictions, schedule);
    assert.equal(venue(game), 'VENUE UNKNOWN · OUTDOOR');
  }
});

test('blank/missing venue and invalid prediction identity never invent physical location', () => {
  for (const value of ['', '  ', null, 0, {}, undefined]) {
    assert.equal(venue(enrichSlateVenues(frozen.predictions, changedSchedule({ venue: value }))[0]),
      'VENUE UNKNOWN · OUTDOOR');
  }
  for (const change of [{ game_id: undefined }, { home: '' }, { home: 'JAX', away: 'JAX' },
    { kickoff_utc: '' }]) {
    const predictions = { ...copy(frozen.predictions), games: [{ ...frozen.predictions.games[0], ...change }] };
    assert.equal(venue(enrichSlateVenues(predictions, frozen.schedule)[0]), 'VENUE UNKNOWN · OUTDOOR');
  }
});

test('document week may bind legacy rows without per-row week, but missing document identity cannot', () => {
  const predictions = copy(frozen.predictions);
  delete predictions.games[0].week;
  assert.equal(venue(enrichSlateVenues(predictions, frozen.schedule)[0]), 'WEMBLEY STADIUM · OUTDOOR');
  for (const change of [{ week: undefined }, { week: '6' }, { season: undefined }]) {
    const [game] = enrichSlateVenues({ ...predictions, ...change }, frozen.schedule);
    assert.equal(venue(game), 'VENUE UNKNOWN · OUTDOOR');
  }
});

test('explicit game venues are escaped and no known-home or closed-roof location is inferred when missing', () => {
  assert.equal(venue({ ...frozen.predictions.games[0], venue: 'Tottenham Hotspur Stadium', roof: 'retractable' }),
    'TOTTENHAM HOTSPUR STADIUM · RETRACTABLE');
  assert.equal(venue({ ...frozen.predictions.games[0], roof: '' }), 'VENUE UNKNOWN');
  const html = renderGameCard({ ...frozen.predictions.games[0], venue: '<img src=x onerror=alert(1)>' });
  assert.match(html, /&lt;IMG SRC=X ONERROR=ALERT\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/i);
});

test('current optional venue request is bounded and updates default display without changing pricing source', () => {
  const source = readFileSync(new URL('../../app/views/slate.js', import.meta.url), 'utf8');
  assert.match(source, /getScheduleFull\(\{ timeoutMs: 2000 \}\)\.catch\(\(\) => null\)/);
  assert.match(source, /defaultGames = enrichSlateVenues\(data, schedule\)/);
  assert.match(source, /if \(active === defaultWeek\) paintGames\(defaultGames\)/);
  assert.ok(source.indexOf('paintGames(defaultGames);\n  marketRequest.then') < source.indexOf('venueRequest.then'));
});
