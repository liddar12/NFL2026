/* tests/feature/r90_slate_truth.test.mjs — R90 locks for HISTORICAL TRUTH on the
 * slate (review F13) and the keyboard semantics of the review expansion (F20).
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. THE LOCK IS THE HEADLINE. A graded row's displayed pair is pick_prob and
 *      1 − pick_prob, rounded the way renderGameCard rounds. The committed
 *      flipped-favourite case (game 401872657: locked LAR 0.6267, schedule_full
 *      now 0.4867) must render LAR 63% and keep LAR emphasized — the number and
 *      the won/lost receipt describe the SAME prediction or the card lies.
 *   2. THE RECOMPUTATION IS A SECOND, NAMED FIGURE. It appears only inside
 *      "LOCKED <stamp> · recomputed with today's model: n%", never as a head.
 *   3. THE LOCK STAMP IS THE LOCK'S OWN. It is read out of the measured why's
 *      confidence line; with none on file the word is 'pregame', never a clock
 *      reading taken at render time.
 *   4. NO LOCK, NO NUMBER. A past game with no review row says "no pregame
 *      forecast on file" instead of borrowing today's recomputation.
 *   5. F20 SEMANTICS IN THE SOURCE. The expansion is a <button> with
 *      aria-expanded + aria-controls and a game-specific accessible name, the
 *      article no longer claims aria-expanded, and the slate week bar is a
 *      group of aria-pressed buttons rather than a tablist with no tabpanels.
 *
 * Helpers are exercised as pure functions (no DOM): the module is imported with
 * fetch stubbed, the way tests/feature/r71_review.test.mjs imports it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(src(rel));

/** Import app/review.js with a stubbed fetch, so primeReview resolves quietly. */
async function loadReview() {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null });
  try {
    const url = new URL(pathToFileURL(join(REPO_ROOT, 'app', 'review.js')).href);
    url.searchParams.set('t', String(Date.now()));
    const mod = await import(url.href);
    await mod.primeReview();
    return mod;
  } finally {
    globalThis.fetch = real;
  }
}

const REVIEW = json('data/review.json');
const SCHEDULE = json('data/schedule_full.json');
/** The committed flipped-favourite case named in the review's F13 evidence. */
const FLIPPED_ID = '401872657';
const flippedRow = Object.values(REVIEW.weeks)
  .flatMap((w) => w.games).find((g) => String(g.game_id) === FLIPPED_ID);
const flippedSchedule = SCHEDULE.games.find((g) => String(g.game_id) === FLIPPED_ID);

/* --------------------------------------------------- 1. the locked pair */

test('the committed flipped-favourite fixture renders the LOCKED favourite, not today\'s', async () => {
  const mod = await loadReview();
  assert.ok(flippedRow && flippedSchedule, 'game 401872657 is committed in both feeds');
  // The fault this locks: the two feeds disagree, and the receipt grades the lock.
  assert.equal(flippedRow.pick_prob, 0.6267);
  assert.equal(flippedSchedule.probs.home, 0.4867);
  assert.equal(flippedRow.picked, 'LAR');
  assert.equal(flippedRow.result, 'lost');

  const heads = mod.lockedHeads(flippedRow);
  assert.deepEqual(
    { homePct: heads.homePct, awayPct: heads.awayPct, fav: heads.fav },
    { homePct: 63, awayPct: 37, fav: 'home' },
    'LAR 63% / SF 37% with LAR emphasized — the pick the dot grades',
  );
  // Today's recomputation would have flipped the emphasis to SF.
  assert.ok(Math.round(flippedSchedule.probs.away * 100) > Math.round(flippedSchedule.probs.home * 100));
});

test('lockedHeads: pick_prob for the picked side, 1 - pick_prob for the other, rounded per side', async () => {
  const mod = await loadReview();
  const away = mod.lockedHeads({ home: 'SEA', away: 'NE', picked: 'NE', pick_prob: 0.6508 });
  assert.deepEqual({ h: away.homePct, a: away.awayPct, fav: away.fav }, { h: 35, a: 65, fav: 'away' });
  const home = mod.lockedHeads({ home: 'SEA', away: 'NE', picked: 'SEA', pick_prob: 0.6508 });
  assert.deepEqual({ h: home.homePct, a: home.awayPct, fav: home.fav }, { h: 65, a: 35, fav: 'home' });
  // A coin flip keeps the card's own tie rule: home carries the emphasis.
  assert.equal(mod.lockedHeads({ home: 'A', away: 'B', picked: 'A', pick_prob: 0.5 }).fav, 'home');
  for (const bad of [null, {}, { picked: 'A', pick_prob: null }, { picked: 'A', pick_prob: 1.4 }]) {
    assert.equal(mod.lockedHeads(bad), null, 'no lock on file -> no pair to paint');
  }
});

test('isGradedRow: a graded result, or a FINAL row carrying its lock; nothing live', async () => {
  const mod = await loadReview();
  assert.equal(mod.isGradedRow({ result: 'won' }), true);
  assert.equal(mod.isGradedRow({ result: 'lost' }), true);
  assert.equal(mod.isGradedRow({ result: null, pick_prob: 0.6, status: 'STATUS_FINAL' }), true);
  assert.equal(mod.isGradedRow({ result: null, pick_prob: 0.6, status: 'STATUS_FINAL_OVERTIME' }), true);
  assert.equal(mod.isGradedRow({ result: null, pick_prob: 0.6, status: 'STATUS_HALFTIME' }), false);
  assert.equal(mod.isGradedRow({ result: null, pick_prob: 0.6, status: 'STATUS_SCHEDULED' }), false);
  assert.equal(mod.isGradedRow({ result: null, pick_prob: null, status: 'STATUS_FINAL' }), false);
  assert.equal(mod.isGradedRow(null), false);
});

/* ------------------------------ 2 + 3. the recomputation and the stamp */

test('provenance names the lock and demotes the recomputation to a second figure', async () => {
  const mod = await loadReview();
  const line = mod.provenanceText(flippedRow, Math.round(flippedSchedule.probs.home * 100));
  assert.equal(line, 'LOCKED 2026-07-16T16:37:02Z · recomputed with today\'s model: 49%');
  // The recomputed number never appears without the word that says what it is.
  assert.ok(/recomputed with today's model/.test(line));
  assert.ok(line.startsWith('LOCKED '), 'the lock leads; the recomputation follows');
  assert.equal(mod.provenanceText(flippedRow, null), 'LOCKED 2026-07-16T16:37:02Z',
    'no recomputed number on the card -> the stamp alone, never an invented %');
});

test('the lock stamp is the receipt\'s own; absent it is the word pregame, not a clock', async () => {
  const mod = await loadReview();
  assert.equal(mod.lockStamp(flippedRow), '2026-07-16T16:37:02Z');
  assert.equal(mod.lockStamp({ why: { reasons: [{ factor: 'margin', text: 'SF won 7-27' }] } }), 'pregame');
  assert.equal(mod.lockStamp({ why: { reasons: [{ factor: 'confidence', text: 'picked LAR at 63%' }] } }), 'pregame');
  assert.equal(mod.lockStamp(null), 'pregame');
  assert.equal(mod.provenanceText({}, 49), 'LOCKED pregame · recomputed with today\'s model: 49%');
});

test('the final score is the receipt\'s, home first; a score-less receipt shows none', async () => {
  const mod = await loadReview();
  assert.equal(mod.finalScoreText(flippedRow), 'FINAL · LAR 7–SF 27');
  assert.equal(mod.finalScoreText({ home: 'A', away: 'B', final: { home_score: null, away_score: null } }), '',
    'a lock-receipt row knows the winner, not the score — it shows no score at all');
  assert.equal(mod.finalScoreText({ home: 'A', away: 'B', final: null }), '');
  assert.equal(mod.finalScoreText(null), '');
});

/* ------------------------------------------------------- 4. no lock on file */

test('no lock on file says so, and the words never contain a number', async () => {
  const mod = await loadReview();
  assert.equal(mod.NO_LOCK_TEXT, 'no pregame forecast on file');
  assert.ok(!/\d/.test(mod.NO_LOCK_TEXT), 'the branch exists so no recomputed % is shown');
  assert.equal(mod.lockedHeads(undefined), null);
  assert.equal(mod.isGradedRow(undefined), false, 'a missing row is never graded, so the card takes this branch');
});

/* ----------------------------------------------- 5. F20 source semantics */

test('the why expansion is a real button: aria-controls, per-game name, no aria-expanded on the article', () => {
  const review = src('app/review.js');
  assert.match(review, /<button type="button" class="rv-why-btn leg-chip" aria-expanded="false" /,
    'a native button gives Enter/Space and the focus ring for free');
  assert.match(review, /aria-controls="\$\{esc\(whyId\)\}"/, 'the button names the panel it owns');
  assert.match(review, /aria-label="Why this result: \$\{esc\(g\.away\)\} at \$\{esc\(g\.home\)\}"/,
    'sixteen identical "Why this result" names are unusable — each is the game\'s own');
  assert.ok(!/card\.setAttribute\('aria-expanded'/.test(review),
    'the ARTICLE must not claim aria-expanded: it is not the control');
  assert.match(review, /closest\('\.rv-why-btn'\)/, 'the delegated listener targets the button, not the card');
  assert.match(review, /e\.key !== 'Escape'/, 'Escape closes the panel the keyboard is standing in');
  assert.match(review, /id=\\"\$\{esc\(id\)\}\\"|id="\$\{esc\(id\)\}"/,
    'renderWhy emits the id the button controls');
});

test('the slate week bar is a group of pressed buttons, not a tablist without tabpanels', () => {
  const slate = src('app/views/slate.js');
  assert.match(slate, /<div class="wkbar" role="group" aria-label="Week">/);
  assert.ok(!slate.includes('role="tablist"') && !slate.includes('role="tab"'),
    'the tab roles promised tabpanel association and roving arrow keys that never existed');
  assert.ok(!slate.includes('aria-selected'),
    'aria-selected is only valid on widget roles this bar no longer claims');
  assert.match(slate, /aria-pressed="\$\{on \? 'true' : 'false'\}"/, 'the chip carries its own pressed state');
  assert.match(slate, /setAttribute\('aria-pressed', on \? 'true' : 'false'\)/,
    'selectWeek must move the pressed state, not a stale selected state');
  assert.match(slate, /e\.key !== 'ArrowLeft' && e\.key !== 'ArrowRight'/,
    'Left/Right move focus and select — the convenience the tab roles only promised');
  assert.match(slate, /\.wk-chip/, 'the class names stay so theme.css and the specs hold');
});

test('the view hands review.js the week context historical truth needs', () => {
  const slate = src('app/views/slate.js');
  assert.match(slate, /applySlateReview\(target, week, \{ currentWeek: defaultWeek, statuses \}\)/);
  assert.match(slate, /import\('\.\.\/review\.js'\)/, 'still a LAZY import — never a boot-graph edge');
  const review = src('app/review.js');
  assert.match(review, /const historical = currentWeek != null && Number\(week\) !== currentWeek;/,
    'the pipeline\'s current week keeps today\'s forecast — it is the right one for an unplayed game');
});
