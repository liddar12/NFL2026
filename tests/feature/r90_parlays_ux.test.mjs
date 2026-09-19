/* tests/feature/r90_parlays_ux.test.mjs — R90 pure units behind F18/F19/F20.
 *
 * PURE node:test, no browser: every function under test here was written to be
 * pure precisely so the COPY on screen is checkable without a DOM.
 *
 * F18 — filtersSummary is what the collapsed FILTERS panel prints. Its whole
 *       job is that shutting the panel never hides what is filtering the list,
 *       so the test is about the sentence, not the CSS.
 * F19 — the seed box rejected the example its own placeholder prints, and a
 *       name the pool cannot price was cleared in silence. notOfferedReason and
 *       joinIdentity are the two pure halves of the answer; matchSeeds is
 *       re-asserted here for the exact strings the placeholder asks for.
 * F20 — the ARIA vocabulary lives in the view's markup and is proved in
 *       tests/web/r90_parlays_ux.spec.mjs, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { filtersSummary } from '../../app/views/parlays.js';
import {
  joinIdentity, matchSeeds, notOfferedReason, seedOptions,
} from '../../app/views/myparlays.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const POOL = read('../../data/leg_pool.json');
const WEEKLY = read('../../data/player_weekly.json');
const PROJ = read('../../data/player_projections.json');

const OPTIONS = seedOptions(POOL);
const IDENTITY = joinIdentity(WEEKLY, PROJ);

/* ==========================================================================
   F18 · the collapsed FILTERS summary carries the state
   ========================================================================== */

test('F18: a panel with nothing set says so, and never a bare "FILTERS"', () => {
  const s = filtersSummary('all', 'all', 'slate');
  assert.equal(s.n, 0);
  assert.equal(s.text, 'FILTERS · ALL');
});

test('F18: every active control is named in the summary, with its count', () => {
  const s = filtersSummary('3', 'high', 'ev');
  assert.equal(s.n, 3);
  assert.equal(s.text, 'FILTERS · 3 LEGS · HIGH · SIM EV');
  // the values are the CHIPS' OWN labels — what the summary says is what the
  // panel shows, so a chip renamed without renaming this would read as a lie
  assert.match(s.text, /SIM EV/);
});

test('F18: one control on counts one, and SLATE (the default sort) is not a filter', () => {
  assert.deepEqual(filtersSummary('all', 'low', 'slate'), { n: 1, text: 'FILTERS · LOW' });
  assert.deepEqual(filtersSummary('5', 'all', 'slate'), { n: 1, text: 'FILTERS · 5 LEGS' });
  assert.equal(filtersSummary('all', 'all', 'pay').n, 1);
  assert.equal(filtersSummary('all', 'all', 'pay').text, 'FILTERS · $100');
});

test('F18: a sort key the view does not know is never printed as one', () => {
  assert.deepEqual(filtersSummary('all', 'all', 'nonsense'), { n: 0, text: 'FILTERS · ALL' });
});

/* ==========================================================================
   F19 · the box accepts the example it prints
   ========================================================================== */

test('F19: "j. jefferson" ranks Justin Jefferson first', () => {
  const hits = matchSeeds(OPTIONS, 'j. jefferson');
  assert.ok(hits.length > 0, 'the abbreviated form must resolve at all');
  assert.equal(hits[0].name, 'Justin Jefferson');
});

test('F19: the first token of "J. Jefferson, KC" resolves, and so does the second', () => {
  // The view splits on commas and commits each part in order; this is the same
  // resolution, part by part, that makes the placeholder work verbatim.
  const parts = 'J. Jefferson, KC'.split(',').map((s) => s.trim());
  const picked = parts.map((p) => matchSeeds(OPTIONS, p, 1)[0]);
  assert.ok(picked.every(Boolean), 'both parts of the example must resolve');
  assert.equal(picked[0].name, 'Justin Jefferson');
  assert.equal(picked[1].kind, 'team');
  assert.equal(picked[1].name, 'KC');
  // ...and they are two DIFFERENT seeds, which is the whole point of the comma
  assert.notEqual(picked[0].id, picked[1].id);
});

test('F19: the shipped placeholder resolves part by part too', () => {
  const placeholder = 'goff, j allen, KC';
  const picked = placeholder.split(',').map((p) => matchSeeds(OPTIONS, p.trim(), 1)[0]);
  assert.ok(picked.every(Boolean),
    'every part of the example the field prints must add a seed');
});

test('F19: the whole comma string matched as ONE name still finds nothing', () => {
  // The regression this guards: before R90 the view passed the raw text to
  // matchSeeds, so the example it asks for resolved to zero and cleared itself.
  assert.deepEqual(matchSeeds(OPTIONS, 'J. Jefferson, KC'), []);
});

/* ==========================================================================
   F19 · a miss says why, from the season's own documents
   ========================================================================== */

const fixtureIdentity = {
  players: [
    { gsis_id: 'p-out', name: 'Nico Fixture', team: 'HOU', position: 'WR', projected: 210.5,
      this_week: { wk: 2, playable: false, reason: 'status', status: 'OUT' } },
    { gsis_id: 'p-depth', name: 'Second Stringer', team: 'KC', position: 'QB', projected: 180,
      this_week: { wk: 2, playable: false, reason: 'depth', depth: 2, starter: 'Patrick Mahomes' } },
    { gsis_id: 'p-te', name: 'Tight Fixture', team: 'SF', position: 'TE', projected: 150,
      this_week: { wk: 2, playable: true } },
    { gsis_id: 'p-k', name: 'Kicker Fixture', team: 'NE', position: 'K', projected: 120, this_week: null },
    { gsis_id: 'p-noproj', name: 'Unprojected Fixture', team: 'NYJ', position: 'RB',
      projected: null, this_week: null },
    { gsis_id: 'p-unpriced', name: 'Healthy Fixture', team: 'DAL', position: 'RB',
      projected: 95.5, this_week: { wk: 2, playable: true } },
    { gsis_id: 'p-pooled', name: 'Pooled Fixture', team: 'DEN', position: 'WR', projected: 200,
      this_week: { wk: 2, playable: true } },
  ],
};
const fixtureOptions = [
  { kind: 'player', id: 'p-pooled', name: 'Pooled Fixture', team: 'DEN', position: 'WR' },
  { kind: 'team', id: 'team:DEN', name: 'DEN' },
];

test('F19: a name the pool DOES price gets no "not offered" sentence', () => {
  assert.equal(notOfferedReason('Pooled Fixture', fixtureIdentity, fixtureOptions), '');
  assert.equal(notOfferedReason('DEN', fixtureIdentity, fixtureOptions), '');
});

test('F19: an injured player is named with his status, not with silence', () => {
  assert.equal(
    notOfferedReason('nico fixture', fixtureIdentity, fixtureOptions),
    'Nico Fixture (HOU · WR) is not offered: not playable this week (OUT)');
});

test('F19: a backup is named with the depth reading the weekly feed carries', () => {
  assert.equal(
    notOfferedReason('second stringer', fixtureIdentity, fixtureOptions),
    'Second Stringer (KC · QB) is not offered: not playable this week '
    + '(depth 2 behind Patrick Mahomes)');
});

test('F19: an excluded position says which position, for TE and for K alike', () => {
  assert.equal(
    notOfferedReason('Tight Fixture', fixtureIdentity, fixtureOptions),
    'Tight Fixture (SF · TE) is not offered: no calibrated market for TE');
  assert.equal(
    notOfferedReason('Kicker Fixture', fixtureIdentity, fixtureOptions),
    'Kicker Fixture (NE · K) is not offered: no calibrated market for K');
});

test('F19: no projection on file is its own reason, and a priced-but-unpooled player is not called injured', () => {
  assert.equal(
    notOfferedReason('Unprojected Fixture', fixtureIdentity, fixtureOptions),
    'Unprojected Fixture (NYJ · RB) is not offered: no projection on file');
  assert.equal(
    notOfferedReason('Healthy Fixture', fixtureIdentity, fixtureOptions),
    'Healthy Fixture (DAL · RB) is not offered: not priced in this week’s pool');
});

test('F19: a name nowhere on file says exactly that, and keeps the typed text', () => {
  assert.equal(
    notOfferedReason('Nobody Whatsoever', fixtureIdentity, fixtureOptions),
    'Nobody Whatsoever: no player or team by that name');
  assert.equal(notOfferedReason('   ', fixtureIdentity, fixtureOptions), '');
  assert.equal(notOfferedReason(null, fixtureIdentity, fixtureOptions), '');
});

test('F19: notOfferedReason is total — a missing or empty document never throws', () => {
  assert.equal(notOfferedReason('anyone', null, null), 'anyone: no player or team by that name');
  assert.equal(notOfferedReason('anyone', {}, []), 'anyone: no player or team by that name');
});

/* ==========================================================================
   F19 · the identity join, over the COMMITTED documents
   ========================================================================== */

test('F19: joinIdentity carries the names weekly has none of, and this_week where there is one', () => {
  assert.ok(IDENTITY.players.length > 0);
  assert.ok(IDENTITY.players.every((p) => p.name), 'every joined row is nameable');
  const weeklyIds = new Set(WEEKLY.players.filter((p) => p.this_week).map((p) => String(p.gsis_id)));
  const joined = IDENTITY.players.filter((p) => p.this_week);
  assert.ok(joined.length > 0, 'the committed weekly feed carries this_week rows');
  assert.ok(joined.every((p) => weeklyIds.has(String(p.gsis_id))),
    'this_week is never invented for a player the weekly feed does not carry');
});

test('F19: a weekly row the projections cannot name is dropped, never printed as an id', () => {
  const doc = joinIdentity({ players: [{ gsis_id: 'ghost', this_week: { playable: false } }] },
    { players: [] });
  assert.deepEqual(doc.players, []);
});

test('F19: on the COMMITTED data a not-playable player who is not in the pool gets a reason', () => {
  const pooled = new Set(POOL.players.map((p) => String(p.gsis_id)));
  const row = IDENTITY.players.find((p) => p.this_week && p.this_week.playable === false
    && !pooled.has(String(p.gsis_id)));
  assert.ok(row, 'the committed weekly feed has a not-playable player outside the pool');
  const why = notOfferedReason(row.name, IDENTITY, OPTIONS);
  assert.match(why, /is not offered: /);
  assert.ok(why.startsWith(row.name), 'the sentence names the player it is about');
});

test('F19: on the COMMITTED data a TE is refused for the market, not for an injury', () => {
  const te = PROJ.players.find((p) => p.position === 'TE');
  assert.ok(te, 'the committed projections carry a TE');
  assert.equal(notOfferedReason(te.name, IDENTITY, OPTIONS),
    `${te.name} (${te.team} · TE) is not offered: no calibrated market for TE`);
});
