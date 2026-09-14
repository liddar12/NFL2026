/* tests/feature/r72_review_ui.test.mjs — locks for the R72 review UI's pure helpers.
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. THE OVERVIEW STRIP reads right / wrong / tbd / brier from the week's
 *      summary.picks and nothing else: a TBD-only week paints "0 RIGHT ·
 *      0 WRONG · 16 TBD" (no Brier when null); an R71-shaped document keeps
 *      the R71 strip byte-for-byte.
 *   2. THE LEARNING LINE is worded from summary.learning (week) or the
 *      document's learning block (fallback): a refit on file names n, the
 *      verdict and the archive date; a null refit says "pending" with the
 *      note; a refit without a verdict and without adopted:true is HELD —
 *      adoption is never claimed from silence.
 *   3. BUCKETS: the label map is the five owner-named buckets; the card reads
 *      summary.parlays.buckets only (no buckets -> no card, never a 0); the
 *      per-parlay bucket comes from the row's own field.
 *   4. THE SEASON TALLY text is "3 MET · 1 OVER · 1 UNDER" from players_season
 *      (zero counts omitted; nothing graded -> '').
 *   5. THE REVIEW COMPARATOR: biggest over-performance first, null last either
 *      way, two nulls equal (a stable sort keeps their incoming order).
 *   6. The app layer stays honest: review.js still reads only via loadJson,
 *      the views import it lazily, the CSS block is .rv-* only (the R71 lock
 *      scans from its marker to end of file, so the R72 block is inside it),
 *      and no model id appears anywhere in the R72 files.
 *
 * Node built-ins only (fast gate). Fixture: tests/fixtures/r72/review.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const FIXTURE = JSON.parse(src('tests/fixtures/r72/review.json'));

/** Import app/review.js with fetch stubbed to the fixture (its module-load prime). */
async function loadReview(doc = FIXTURE) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => doc });
  try {
    const url = new URL(pathToFileURL(join(REPO_ROOT, 'app', 'review.js')).href);
    url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
    const mod = await import(url.href);
    await mod.primeReview();
    await new Promise((r) => setTimeout(r, 0));
    return mod;
  } finally {
    globalThis.fetch = real;
  }
}

/* --------------------------------------------------- 1. overview strip */

test('overview: right / wrong / tbd / Brier from summary.picks; TBD-only week; null Brier omitted', async () => {
  const m = await loadReview();
  const w1 = FIXTURE.weeks['1'].summary;
  assert.equal(m.overviewText(1, w1.picks), 'WK 1 · 9 RIGHT · 7 WRONG · 0 TBD · Brier 0.48');
  assert.equal(m.overviewText(3, FIXTURE.weeks['3'].summary.picks), 'WK 3 · 0 RIGHT · 0 WRONG · 16 TBD');
  assert.equal(m.overviewText(1, { n: 14, won: 9, brier: 0.21 }), '', 'R71 shape -> no overview text');
  const html = m.renderWeekOverview(3, FIXTURE.weeks['3'].summary, FIXTURE.learning);
  assert.match(html, /^<div class="rv-strip rv-strip--week" role="status" data-week="3">/);
  assert.match(html, /<span class="rv-ov">WK 3 · 0 RIGHT · 0 WRONG · 16 TBD<\/span>/);
  assert.match(html, /<span class="rv-learn">LEARNING: 0 graded locks → refit pending \(no FINAL yet\)<\/span>/);
});

test('overview: an R71-shaped week falls back to the R71 strip unchanged', async () => {
  const m = await loadReview();
  const legacy = { picks: { n: 14, won: 9, brier: 0.2123 } };
  assert.equal(m.renderWeekOverview(1, legacy, null),
    '<div class="rv-strip" role="status" data-week="1">WK 1 REVIEW: 9/14 picks, Brier 0.21</div>');
  assert.equal(m.renderWeekOverview(1, { picks: { n: 0, won: 0, brier: null } }, null), '');
  assert.equal(m.renderWeekOverview(1, null, FIXTURE.learning), '', 'no picks at all -> nothing, even with learning');
});

/* ---------------------------------------------------- 2. learning line */

test('learning line: refit on file names n, verdict and date; null refit says pending with the note', async () => {
  const m = await loadReview();
  assert.equal(m.renderLearningLine(FIXTURE.weeks['1'].summary.learning, FIXTURE.learning),
    'LEARNING: 16 graded locks → game-model refit (n=16, held, 2026-09-14)');
  assert.equal(m.renderLearningLine(FIXTURE.weeks['2'].summary.learning, FIXTURE.learning),
    'LEARNING: 14 graded locks → refit pending (below the 16-lock minimum)');
  assert.equal(m.renderLearningLine({ graded_locks: 3, refit: null, note: '' }, null),
    'LEARNING: 3 graded locks → refit pending');
});

test('learning line: the document block is the fallback; adoption only when the block shows it', async () => {
  const m = await loadReview();
  assert.equal(m.renderLearningLine(null, FIXTURE.learning),
    'LEARNING: 30 graded locks → game-model refit (n=30, held, 2026-09-14)');
  assert.equal(m.renderLearningLine({ graded_locks: 20, refit: { archived_utc: '2026-10-01T00:00:00Z', n_resolved: 20, adopted: true, verdict: 'adopted' } }, null),
    'LEARNING: 20 graded locks → game-model refit (n=20, adopted, 2026-10-01)');
  assert.equal(m.renderLearningLine({ graded_locks: 20, refit: { archived_utc: '2026-10-01T00:00:00Z', n_resolved: 20 } }, null),
    'LEARNING: 20 graded locks → game-model refit (n=20, held, 2026-10-01)', 'no verdict, no adopted:true -> HELD');
  assert.equal(m.renderLearningLine({ graded_locks: 20, refit: { adopted: true } }, null),
    'LEARNING: 20 graded locks → game-model refit (adopted)', 'adopted:true without a verdict string counts as shown');
  assert.equal(m.renderLearningLine(null, null), '');
  assert.equal(m.renderLearningLine({ note: 'x' }, { note: 'y' }), '', 'no graded count anywhere -> no line');
});

/* --------------------------------------------------------- 3. buckets */

test('buckets: label map, counts read from summary only, per-row bucket map', async () => {
  const m = await loadReview();
  assert.deepEqual(m.BUCKET_ORDER, ['all_hit', 'push', 'partial', 'all_missed', 'pending']);
  assert.deepEqual(m.BUCKET_LABEL,
    { all_hit: 'ALL HIT', push: 'PUSH', partial: 'PARTIAL', all_missed: 'ALL MISSED', pending: 'PENDING' });
  assert.deepEqual(m.parlayBucketCounts(1), { all_hit: 1, push: 1, partial: 1, all_missed: 1, pending: 1 });
  assert.equal(m.parlayBucketCounts(9), null);
  assert.equal(m.parlayBucketCounts(1, { weeks: { 1: { summary: { parlays: { n: 3 } } } } }), null, 'R71 shape -> null');
  const map = m.parlayBucketMap(1);
  assert.deepEqual([...map.entries()],
    [['p1', 'all_hit'], ['p2', 'push'], ['p3', 'partial'], ['p4', 'all_missed'], ['p5', 'pending']]);
  const html = m.renderParlayBuckets(1, m.parlayBucketCounts(1), 'partial');
  assert.match(html, /^<div class="rv-buckets" role="group" aria-label="Filter parlays by outcome" data-week="1">/);
  assert.match(html, /<button type="button" class="rv-bucket" data-bucket="all_hit" aria-pressed="false">ALL HIT <b class="rv-bucket-n">1<\/b><\/button>/);
  assert.match(html, /class="rv-bucket rv-bucket--active" data-bucket="partial" aria-pressed="true">PARTIAL /);
  assert.equal((html.match(/<button/g) || []).length, 5);
  assert.equal(m.renderParlayBuckets(1, null, null), '', 'no buckets -> no card, never a fabricated 0');
  assert.equal(m.renderParlayBuckets(1, { all_hit: 2 }, null).match(/<button/g).length, 1, 'only counts the document carries');
});

/* ---------------------------------------------------- 4. season tally */

test('season tally: "3 MET · 1 OVER · 1 UNDER" from players_season; zeros omitted; nothing graded -> none', async () => {
  const m = await loadReview();
  assert.equal(m.seasonTallyText({ weeks: 5, met: 3, over: 1, under: 1, dnp: 0 }), '3 MET · 1 OVER · 1 UNDER');
  assert.equal(m.seasonTallyText(FIXTURE.players_season['fx-qb']), '1 MET · 1 OVER');
  assert.equal(m.seasonTallyText(FIXTURE.players_season['fx-dnp']), '1 DNP');
  assert.equal(m.seasonTallyText({ weeks: 0, met: 0, over: 0, under: 0, dnp: 0 }), '');
  assert.equal(m.seasonTallyText(null), '');
  assert.equal(m.renderSeasonTally('fx-rb'),
    '<span class="rv-tally" data-gsis="fx-rb" title="2 graded weeks vs the calibrated week band">1 OVER · 1 UNDER</span>');
  assert.equal(m.renderSeasonTally('fx-none'), '');
  assert.equal(m.renderSeasonTally('fx-rb', { weeks: {} }), '', 'no players_season block -> no chip');
});

/* ------------------------------------------------ 5. sort + readers */

test('REVIEW comparator: delta descending, null last either way, nulls equal (stable)', async () => {
  const m = await loadReview();
  assert.ok(m.compareReviewDelta(9.9, 1.2) < 0);
  assert.ok(m.compareReviewDelta(1.2, 9.9) > 0);
  assert.ok(m.compareReviewDelta(9.9, 1.2, 'asc') > 0);
  assert.ok(m.compareReviewDelta(null, -50) > 0, 'null after any number on desc');
  assert.ok(m.compareReviewDelta(null, -50, 'asc') > 0, 'null after any number on asc too');
  assert.ok(m.compareReviewDelta(-50, null, 'asc') < 0);
  assert.equal(m.compareReviewDelta(null, null), 0);
  assert.equal(m.compareReviewDelta(undefined, null, 'asc'), 0);
  const rows = [{ id: 'a', d: null }, { id: 'b', d: 1.2 }, { id: 'c', d: null }, { id: 'd', d: 9.9 }, { id: 'e', d: -6 }];
  assert.deepEqual(rows.slice().sort((x, y) => m.compareReviewDelta(x.d, y.d)).map((r) => r.id), ['d', 'b', 'e', 'a', 'c']);
  assert.deepEqual(rows.slice().sort((x, y) => m.compareReviewDelta(x.d, y.d, 'asc')).map((r) => r.id), ['e', 'b', 'd', 'a', 'c']);
});

test('readers: graded weeks, per-week delta / verdict, selected-week chip', async () => {
  const m = await loadReview();
  assert.deepEqual(m.gradedPlayerWeeks(), [1, 2], 'week 3 has no player rows -> not graded');
  assert.deepEqual(m.gradedPlayerWeeks(null), []);
  assert.equal(m.playerReviewDelta('fx-qb', 1), 9.9);
  assert.equal(m.playerReviewDelta('fx-qb', 2), -2.0);
  assert.equal(m.playerReviewDelta('fx-dnp', 1), null, 'DNP has no delta');
  assert.equal(m.playerReviewDelta('fx-none', 1), null);
  assert.equal(m.playerReviewVerdict('fx-rb', 2), 'over');
  assert.equal(m.playerReviewVerdict('fx-rb', 3), null);
  assert.match(m.renderPlayerReview('fx-rb', 1), /rv-chip--under">WK 1 UNDER −6\.0</);
  assert.equal(m.renderPlayerReview('fx-dnp', 2), '', 'the selected week only — no fallback to another week');
  assert.match(m.renderPlayerReview('fx-dnp'), /WK 1 DNP/, 'no week -> latest graded row (R71)');
});

test('players view: the REVIEW state / filter / controls live in the lazy module; the chip is gated', async () => {
  const m = await loadReview();
  const rv = m.reviewState();
  assert.deepEqual({ weeks: rv.weeks, week: rv.week, on: [...rv.on] }, { weeks: [1, 2], week: 2, on: ['over', 'met', 'under'] });
  assert.equal(m.reviewState({ weeks: { 3: { players: [] } } }), null, 'no graded week -> no state -> no chip');
  // verdict filter: all on passes everything; a graded row needs its chip on; ungraded / DNP always pass
  assert.equal(m.verdictPasses('fx-rb', rv), true);
  rv.on.delete('over');
  assert.equal(m.verdictPasses('fx-rb', rv), false, 'week 2 OVER with OVER off');
  assert.equal(m.verdictPasses('fx-qb', rv), true, 'week 2 MET');
  assert.equal(m.verdictPasses('fx-none', rv), true, 'no row');
  rv.week = 1; rv.on = new Set(['under']);
  assert.equal(m.verdictPasses('fx-dnp', rv), true, 'DNP is never filtered');
  assert.equal(m.verdictPasses('fx-wr', rv), false, 'week 1 MET with only UNDER on');
  const html = m.renderReviewControls({ weeks: [1, 2], week: 2, on: new Set(['over', 'met']) });
  assert.match(html, /^<div class="rv-pfilter" role="group" aria-label="Review week and verdict">/);
  assert.match(html, /class="rv-wk" data-rv-week="1" aria-pressed="false">WK 1</);
  assert.match(html, /class="rv-wk rv-wk--active" data-rv-week="2" aria-pressed="true">WK 2</);
  assert.match(html, /class="rv-vchip rv-vchip--over rv-vchip--active" data-rv-verdict="over" aria-pressed="true">OVER</);
  assert.match(html, /class="rv-vchip rv-vchip--under" data-rv-verdict="under" aria-pressed="false">UNDER</);
  assert.equal(m.renderReviewControls(null), '');
  assert.equal(typeof m.bindReviewControls, 'function');
  const s = src('app/views/players.js');
  assert.match(s, /\{ key: 'review', label: 'REVIEW' \}/);
  assert.match(s, /s\.key !== 'review' \|\| reviewSortAvailable/, 'the chip is feature-detected');
  assert.match(s, /reviewMod\.renderReviewControls\(rv\)/, 'the controls markup stays off the boot graph');
  assert.match(s, /reviewMod\.bindReviewControls\(rvHost, rv,/, 'and so does their click parsing');
  assert.doesNotMatch(s, /sessionStorage/, 'no sessionStorage pattern in this view — selections stay in memory');
});

/* ------------------------------------------------------ 6. app layer */

test('app layer: lazy imports only, loadJson only, R72 CSS is .rv-* and HIG-scoped, no model ids', () => {
  const parlays = src('app/views/parlays.js');
  const players = src('app/views/players.js');
  assert.match(parlays, /import\('\.\.\/review\.js'\)/);
  assert.match(players, /import\('\.\.\/review\.js'\)/);
  assert.doesNotMatch(parlays, /^import .*review\.js/m);
  assert.doesNotMatch(players, /^import .*review\.js/m);
  assert.doesNotMatch(src('app/review.js'), /\bfetch\s*\(/);
  assert.match(parlays, /parlayBucketMap|parlayBucketCounts/, 'the view reads buckets, never derives them');
  assert.doesNotMatch(parlays, /legs\.(every|some|filter)\([^)]*result/, 'no bucket recomputed from legs in the view');
  const block = (css) => {
    const i = css.indexOf('R72 — REVIEW UI');
    return i < 0 ? '' : css.slice(css.lastIndexOf('/*', i)).replace(/\/\*[\s\S]*?\*\//g, '');
  };
  const base = block(src('app/theme.css'));
  const hig = block(src('app/theme-hig.css'));
  assert.ok(base && hig, 'both R72 blocks present');
  for (const m of base.matchAll(/^([^\n{}/*][^{}]*)\{/gm)) {
    for (const part of m[1].split(',')) assert.match(part.trim(), /\.rv-/, `theme.css rule not .rv-*: ${part}`);
  }
  for (const m of hig.matchAll(/^([^\n{}/*][^{}]*)\{/gm)) {
    for (const part of m[1].split(',')) {
      assert.match(part.trim(), /^\[data-theme="hig"\]/, `unscoped HIG rule: ${part}`);
      assert.match(part.trim(), /\.rv-/, `theme-hig.css rule not .rv-*: ${part}`);
    }
  }
  for (const f of ['app/review.js', 'app/views/players.js', 'app/views/parlays.js', 'app/views/slate.js',
    'tests/web/r72_review_ui.spec.mjs', 'tests/fixtures/r72/review.json']) {
    assert.doesNotMatch(src(f), /claude-[a-z]+-\d/i, `${f} names a model id`);
  }
});
