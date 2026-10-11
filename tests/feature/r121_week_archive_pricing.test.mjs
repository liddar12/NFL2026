/* tests/feature/r121_week_archive_pricing.test.mjs — R121: the current week's
 * $100 line prices a recorded card that left the slate.
 *
 * 2026-10-11: after R119 rebuilt the week cards without PHI @ JAX, 15 graded
 * week-5 rows (and, since Thursday's TB @ DAL re-pick, 2 game rows) had no card
 * on the painted slate. prepareParlaySimulation priced rows from the slate only,
 * left them null, and the line read "SIM NET unavailable".
 *
 * Locked here: with the week's archive registered (setWeekArchiveSources) a row
 * the slate cannot price is priced with its OWN archived card; a row the slate
 * prices keeps the slate's figure even when the archive quotes another price;
 * a rank id the slate re-used for a different bet never prices the row; and
 * unpricedGradedCount is what tells the view to fetch the archive at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const review = await import(pathToFileURL(join(ROOT, 'app', 'review.js')).href);

const leg = (selection, implied_prob) => ({ market: 'moneyline', selection, implied_prob });
const graded = (selection, result) => ({ market: 'moneyline', selection, result });

// A: still on the slate. B and C: rebuilt off it (their JAX ML is void); the
// slate re-used B's rank id for a different bet.
const slate = () => [
  { parlay_id: 'week-2leg-1', card_id: 'aaa', scope: 'week', legs: [leg('DAL ML', 0.5), leg('MIN ML', 0.5)] },
  { parlay_id: 'week-2leg-2', card_id: 'zzz', scope: 'week', legs: [leg('NE ML', 0.8), leg('DAL ML', 0.5)] },
];
const archive = [
  { parlay_id: 'week-2leg-1', card_id: 'aaa', scope: 'week', legs: [leg('DAL ML', 0.4), leg('MIN ML', 0.4)] },
  { parlay_id: 'week-2leg-2', card_id: 'bbb', scope: 'week', legs: [leg('JAX ML', 0.7), leg('NE ML', 0.8)] },
  { parlay_id: 'week-3leg-1~ccc', card_id: 'ccc', scope: 'week', legs: [leg('JAX ML', 0.7), leg('ATL ML', 0.6)] },
];
const doc = (week) => ({ weeks: { [week]: {
  summary: { parlays: {} },
  parlays: [
    { parlay_id: 'week-2leg-1', card_id: 'aaa', scope: 'week', bucket: 'all_hit', result: 'hit',
      legs: [graded('DAL ML', 'hit'), graded('MIN ML', 'hit')] },
    { parlay_id: 'week-2leg-2', card_id: 'bbb', scope: 'week', bucket: 'push', result: 'push',
      legs: [graded('JAX ML', 'void'), graded('NE ML', 'hit')] },
    { parlay_id: 'week-3leg-1~ccc', card_id: 'ccc', scope: 'week', bucket: 'partial', result: 'miss',
      legs: [graded('JAX ML', 'void'), graded('ATL ML', 'miss')] },
  ],
} } });
const money = (d, week) => d.weeks[week].parlays.map((r) => (r.money ? r.money.net_fair : null));

test('R121: without the archive, rows that left the slate stay unpriced and the line has no total', () => {
  const d = doc(41);
  review.prepareParlaySimulation(41, slate(), d);
  assert.deepEqual(money(d, 41), [300, null, null], 'A from the slate; B (rank re-used) and C refused');
  assert.equal(review.unpricedGradedCount(41, d), 2);
  assert.equal(d.weeks[41].summary.parlays.stake_100.week.net_fair, null, 'the "unavailable" line');
});

test('R121: with the archive, each row is priced by its own card and the total is whole', () => {
  const d = doc(42);
  review.setWeekArchiveSources(42, archive);
  review.prepareParlaySimulation(42, slate(), d);
  // A keeps the slate's price (0.5 legs: +$300), not the archive's (0.4: +$525);
  // B pays on NE ML alone at 0.8 (+$25), the void JAX leg out at 1.0; C lost.
  assert.deepEqual(money(d, 42), [300, 25, -100]);
  assert.equal(review.unpricedGradedCount(42, d), 0);
  assert.equal(d.weeks[42].summary.parlays.stake_100.week.net_fair, 225);
});

test('R121: an archive for another week, or a stamped slate, changes nothing it should not', () => {
  const d = doc(43);
  review.setWeekArchiveSources(44, archive);
  review.prepareParlaySimulation(43, slate(), d);
  assert.deepEqual(money(d, 43), [300, null, null], 'week 44\'s archive never prices week 43');
  review.setWeekArchiveSources(43, []);
  review.prepareParlaySimulation(43, slate(), d);
  assert.equal(review.unpricedGradedCount(43, d), 2, 'an empty archive prices nothing');
});

test('R121: the view prices off-slate rows only once the RETROSPECTIVE panel is open', () => {
  const src = readFileSync(join(ROOT, 'app', 'views', 'parlays.js'), 'utf8');
  const i = src.indexOf('function priceOffSlateRows()');
  assert.ok(i > 0, 'one function owns the R121 fetch');
  const block = src.slice(i, src.indexOf('\n  }\n', i));
  assert.match(block, /!box\.open \|\| selWeek !== curWeek/, 'panel open, current week only');
  assert.match(block, /reviewMod\.unpricedGradedCount\(selWeek\) === 0\) return/, 'and only when a graded row is unpriced');
  assert.match(block, /weekArchive\(week\)/);
  assert.match(block, /reviewMod\.setWeekArchiveSources\(week, doc\.parlays\)/);
  assert.match(block, /reviewMod\.prepareParlaySimulation\(week, parlays\)/);
  assert.match(block, /paintPnl\(\)/);
  assert.match(src, /writeRetroOpen\(retroBox\.open\);\s*priceOffSlateRows\(\);/, 'opening the panel triggers it');
});
