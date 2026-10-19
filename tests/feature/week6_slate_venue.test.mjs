import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderGameCard } from '../../app/render.js';
import { enrichSlateVenues } from '../../app/views/slate.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
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

test('cold slate reads the venue off game_predictions and never fetches schedule_full to name it (R25 budget)', () => {
  const source = readFileSync(new URL('../../app/views/slate.js', import.meta.url), 'utf8');
  // The only schedule_full request is the non-default-week one, after a click.
  assert.equal((source.match(/getScheduleFull\(/g) || []).length, 1);
  assert.doesNotMatch(source, /venueRequest/);
  // A cached predictions file without venues borrows them, by exact identity,
  // only once the schedule is loaded for another week anyway.
  assert.match(source, /if \(defaultGames\.some\(\(g\) => g && !g\.venue\)\) defaultGames = enrichSlateVenues\(data, full\);/);
});

test('the pipeline carries each game\'s own schedule venue onto the week rows, only when it names one', () => {
  const out = execFileSync('python3', ['-c', `
import json
from scripts import build_predictions as bp
base = {'game_id': 'G', 'home': 'JAX', 'away': 'NO', 'week': 6, 'kickoff_utc': 'K', 'roof': 'outdoor',
        'probs': {'home': .5, 'away': .5}, 'model': 'elo_prior', 'estimate': True}
rows = bp.week_game_rows([dict(base, venue='Wembley Stadium'), dict(base, game_id='H', venue=''),
                          dict(base, game_id='I', venue=None), dict(base, game_id='J'),
                          dict(base, game_id='W5', week=5, venue='Elsewhere')], 6)
print(json.dumps([r.get('venue', '<absent>') for r in rows]))`], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()), ['Wembley Stadium', '<absent>', '<absent>', '<absent>']);
  const committed = JSON.parse(readFileSync(new URL('../../data/game_predictions.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(readFileSync(new URL('../../data/contracts/game_predictions.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.games.items.properties.venue.type, 'string');
  for (const g of committed.games) {
    if ('venue' in g) assert.ok(typeof g.venue === 'string' && g.venue.trim(), g.game_id);
  }
});
