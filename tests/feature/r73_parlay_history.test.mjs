/* tests/feature/r73_parlay_history.test.mjs — locks for the R73 parlay history's pure helpers.
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. THE WEEK LIST merges the index's weeks with the current parlays.json
 *      week: ascending, de-duplicated, the current week flagged (and added
 *      when the index does not list it yet); no index -> [] (no chips).
 *   2. THE DEFAULT WEEK is parlays.json's own week — the pipeline rule — and
 *      the index's current_week is only a fallback: when both exist and
 *      differ, parlays.json wins (the index can lag a run behind).
 *   3. THE P&L LINE is worded from summary.parlays.stake_100[scope] and
 *      nothing else: "WEEK 1 · 1/2 hit · +$123 at $100 flat (book vig 2%/leg;
 *      fair +$141)"; pending excluded (hit/graded, never n); a push count
 *      only when there is one; the -110 note only when assumed_price_legs
 *      > 0; '' until the week has a graded parlay; money is whole dollars.
 *   4. THE ARCHIVE PATH: getParlayArchive (app/data.js, the fetch door)
 *      normalises an index entry's path to the site root and refuses anything
 *      outside /data/parlays/ before it ever calls fetch; the conventional
 *      (season, week) fallback path is 2026_wk01.json and lives in
 *      app/views/parlays.js (lazy: the boot graph sat 412 bytes under its
 *      byte ceiling, so data.js carries only the two getters).
 *   5. THE FIXTURES carry the contract partition P produces (index.json,
 *      2026_wkNN.json, stake_100) so the web spec and the pipeline agree.
 *   6. The app layer stays honest: archive files are reached only through
 *      data.js's getters (the view never fetches), the index joins the mount's
 *      allSettled while the archive getter appears only inside selectWeek,
 *      the .pw-* CSS sits BEFORE the R71 .rv-* lock marker, the legend says
 *      the money is display only, and no model id appears in any R73 file.
 *
 * Node built-ins only (fast gate). Fixtures: tests/fixtures/r73/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { mergeWeekList, chooseDefaultWeek, parlayArchivePathFor } from '../../app/views/parlays.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const INDEX = JSON.parse(src('tests/fixtures/r73/index.json'));
const ARCHIVE = JSON.parse(src('tests/fixtures/r73/2026_wk01.json'));
const SUMMARY = JSON.parse(src('tests/fixtures/r73/summary_parlays.json'));

/** Import app/review.js with fetch stubbed to a document (its module-load prime). */
async function loadReview(doc) {
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

/* ------------------------------------------------------- 1. the week list */

test('week list: index weeks + the current week, ascending, de-duplicated, current flagged', () => {
  // the fixture index lists 1 (closed) and 2 (open); parlays.json says 2
  const w = mergeWeekList(INDEX, 2);
  assert.deepEqual(w.map((x) => x.week), [1, 2]);
  assert.equal(w[0].closed, true);
  assert.equal(w[0].path, 'data/parlays/2026_wk01.json');
  assert.equal(w[0].current, false);
  assert.equal(w[1].current, true);
  assert.equal(w[1].closed, false);
  // the current week is added when the index has not caught up to it
  const w3 = mergeWeekList(INDEX, 3);
  assert.deepEqual(w3.map((x) => x.week), [1, 2, 3]);
  assert.deepEqual(w3[2], { week: 3, path: null, closed: false, current: true });
  assert.equal(w3[1].current, false);
  // unordered + duplicate index rows come out sorted and unique
  const messy = { weeks: [{ week: 3, path: 'data/parlays/2026_wk03.json', closed: true }, { week: 1 }, { week: 3 }, { week: 'x' }] };
  assert.deepEqual(mergeWeekList(messy, 2).map((x) => x.week), [1, 2, 3]);
  assert.equal(mergeWeekList(messy, 2)[2].path, 'data/parlays/2026_wk03.json', 'first row wins');
  // no index -> no chips
  assert.deepEqual(mergeWeekList(null, 2), []);
  assert.deepEqual(mergeWeekList({ season: 2026 }, 2), []);
});

/* ---------------------------------------------------- 2. the default week */

test('default week: parlays.json wins over a stale index current_week; index is the fallback only', () => {
  assert.equal(chooseDefaultWeek(2, 1), 2, 'index current_week lags a run behind — parlays.json wins');
  assert.equal(chooseDefaultWeek(1, 2), 1);
  assert.equal(chooseDefaultWeek('2', 1), 2);
  assert.equal(chooseDefaultWeek(undefined, 1), 1, 'no week on parlays.json -> the index');
  assert.equal(chooseDefaultWeek(null, null), null);
  assert.equal(chooseDefaultWeek(0, 'nope'), null);
});

/* -------------------------------------------------------- 3. the P&L line */

test('P&L line: hit/graded (pending excluded), money at $100 flat with the fair figure, -110 note only when assumed', async () => {
  const m = await loadReview({ weeks: { 1: { summary: { parlays: SUMMARY } } } });
  const week = m.parlayStake100(1, 'week');
  const game = m.parlayStake100(1, 'game');
  assert.equal(week.graded, 2);
  assert.equal(m.pnlLineText(1, week), 'WEEK 1 · 1/2 hit · +$144 at $100 flat (book vig 2%/leg; fair +$166)');
  assert.equal(m.pnlLineText(1, game), 'WEEK 1 · 1/2 hit · +$123 at $100 flat (book vig 2%/leg; fair +$141)');
  assert.equal(m.pnlAssumedText(week), '');
  assert.equal(m.pnlAssumedText(game), '2 legs priced at -110 (no book price)');
  assert.equal(m.pnlAssumedText({ assumed_price_legs: 1 }), '1 leg priced at -110 (no book price)');
  // pending excluded: n is 3 on the game side but the ratio reads graded (2)
  assert.equal(game.n, 3);
  assert.doesNotMatch(m.pnlLineText(1, game), /\/3 hit/);
  // a push shows only when there is one; a loss is a minus sign
  assert.equal(m.pnlLineText(4, { graded: 18, hit: 16, push: 1, net_fair: 11564, net_vig2: 10200 }),
    'WEEK 4 · 16/18 hit · 1 push · +$10,200 at $100 flat (book vig 2%/leg; fair +$11,564)');
  assert.equal(m.pnlLineText(2, { graded: 5, hit: 0, push: 0, net_fair: -500, net_vig2: -500 }),
    'WEEK 2 · 0/5 hit · −$500 at $100 flat (book vig 2%/leg; fair −$500)');
  // nothing graded -> nothing painted
  assert.equal(m.pnlLineText(2, { n: 5, graded: 0, hit: 0 }), '');
  assert.equal(m.pnlLineText(2, null), '');
  assert.equal(m.renderParlayPnl(2, 'game', { graded: 0 }), '');
  // money formatting
  assert.equal(m.fmtMoney(0), '$0');
  assert.equal(m.fmtMoney(1234567), '+$1,234,567');
  assert.equal(m.fmtMoney(-12.4), '−$12');
  // the rendered line: tone from the sign of net_vig2, the note as its own span
  const html = m.renderParlayPnl(1, 'game', game);
  assert.match(html, /^<div class="rv-pnl rv-pnl--pos" role="status" data-week="1" data-scope="game">/);
  assert.match(html, /<span class="rv-pnl-line">WEEK 1 · 1\/2 hit · \+\$123 at \$100 flat \(book vig 2%\/leg; fair \+\$141\)<\/span>/);
  assert.match(html, /<span class="rv-pnl-note">2 legs priced at -110 \(no book price\)<\/span>/);
  assert.doesNotMatch(m.renderParlayPnl(1, 'week', week), /rv-pnl-note/);
  assert.match(m.renderParlayPnl(2, 'game', { graded: 5, hit: 0, net_vig2: -500, net_fair: -500 }), /rv-pnl--neg/);
  // an unknown week / an R72-shaped document (no stake_100) reads null, never a 0
  assert.equal(m.parlayStake100(9, 'game'), null);
  // (the reader takes the document explicitly — data.js's promise cache is
  // module-wide, so a second stubbed import would still see the first file)
  const r72 = { weeks: { 1: { summary: { parlays: { n: 5, buckets: SUMMARY.buckets } } } } };
  assert.equal(m.parlayStake100(1, 'game', r72), null);
  assert.equal(m.renderParlayPnl(1, 'game', m.parlayStake100(1, 'game', r72)), '');
});

/* ------------------------------------------------------ 4. archive paths */

/** A fresh app/data.js (own cache) whose fetch records the path and answers `reply`. */
async function withStubbedData(reply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path) => { calls.push(path); return reply; };
  const url = new URL(pathToFileURL(join(REPO_ROOT, 'app', 'data.js')).href);
  url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  try {
    return await fn(await import(url.href), calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('archive path: getParlayArchive normalises index paths to the site root and refuses anything outside /data/parlays/', async () => {
  const ok = { ok: true, status: 200, json: async () => ARCHIVE };
  await withStubbedData(ok, async (data, calls) => {
    assert.deepEqual(await data.getParlayArchive('data/parlays/2026_wk01.json'), ARCHIVE);
    assert.deepEqual(calls, ['/data/parlays/2026_wk01.json'], 'the leading slash is added');
    await data.getParlayArchive('/data/parlays/2026_wk01.json');
    assert.equal(calls.length, 1, 'the same archive is served from the promise cache');
    for (const row of INDEX.weeks) await data.getParlayArchive(row.path);
    assert.deepEqual(calls, ['/data/parlays/2026_wk01.json', '/data/parlays/2026_wk02.json'], 'fixture paths accepted');
    // refused BEFORE fetch: the index is not an archive, nothing outside the prefix, no traversal, no query
    for (const bad of ['data/parlays/index.json', 'data/game_context.json', 'data/parlays/../game_context.json',
      'data/parlays/x/2026_wk01.json', 'data/parlays/2026_wk01.json?x', 'https://x/data/parlays/2026_wk01.json', '', null, undefined]) {
      await assert.rejects(data.getParlayArchive(bad), /not an archive/, `refused: ${bad}`);
    }
    assert.equal(calls.length, 2, 'a refused path never reaches fetch');
  });
  // a 404 rejects cleanly (the view says "not archived") and is retryable
  await withStubbedData({ ok: false, status: 404 }, async (data, calls) => {
    await assert.rejects(data.getParlayArchive('data/parlays/2026_wk03.json'), /HTTP 404/);
    await new Promise((r) => setTimeout(r, 0));
    await assert.rejects(data.getParlayArchive('data/parlays/2026_wk03.json'), /HTTP 404/);
    assert.equal(calls.length, 2, 'a rejected archive is evicted, so a later tap retries');
  });
  assert.equal(parlayArchivePathFor(2026, 1), '/data/parlays/2026_wk01.json');
  assert.equal(parlayArchivePathFor(2026, 12), '/data/parlays/2026_wk12.json');
  assert.equal(parlayArchivePathFor(undefined, 1), null);
  assert.equal(parlayArchivePathFor(2026, 0), null);
});

/* ---------------------------------------------------------- 5. fixtures */

test('fixtures carry the R73 contract: index rows, the archive document, stake_100 per scope', () => {
  for (const k of ['season', 'generated_utc', 'current_week', 'weeks']) assert.ok(k in INDEX, `index.${k}`);
  const weeks = INDEX.weeks.map((w) => w.week);
  assert.deepEqual(weeks, [...weeks].sort((a, b) => a - b), 'index sorted by week');
  for (const row of INDEX.weeks) {
    for (const k of ['week', 'path', 'updated_utc', 'archived_utc', 'closed', 'n_parlays', 'n_week_scope', 'n_game_scope']) {
      assert.ok(k in row, `index row ${row.week} carries ${k}`);
    }
    assert.match(row.path, /^data\/parlays\/\d{4}_wk\d{2}\.json$/);
    assert.equal(row.n_parlays, row.n_week_scope + row.n_game_scope);
  }
  for (const k of ['season', 'week', 'updated_utc', 'parlays', 'archived_utc', 'closed', 'history']) {
    assert.ok(k in ARCHIVE, `archive.${k}`);
  }
  assert.equal(ARCHIVE.closed, true);
  assert.ok(Array.isArray(ARCHIVE.history));
  const wk1 = INDEX.weeks.find((w) => w.week === ARCHIVE.week);
  assert.equal(ARCHIVE.parlays.length, wk1.n_parlays);
  assert.equal(ARCHIVE.parlays.filter((p) => p.scope === 'game').length, wk1.n_game_scope);
  assert.equal(ARCHIVE.parlays.filter((p) => p.scope === 'week').length, wk1.n_week_scope);
  for (const p of ARCHIVE.parlays) {
    for (const k of ['parlay_id', 'scope', 'legs', 'model_ev', 'confidence_tier', 'correlation_note']) assert.ok(k in p, `parlay ${k}`);
    for (const l of p.legs) for (const k of ['market', 'selection', 'implied_prob', 'model_prob']) assert.ok(k in l, `leg ${k}`);
  }
  for (const scope of ['week', 'game']) {
    const st = SUMMARY.stake_100[scope];
    for (const k of ['n', 'graded', 'hit', 'push', 'staked', 'net_fair', 'net_vig2', 'assumed_price_legs', 'note']) {
      assert.ok(k in st, `stake_100.${scope}.${k}`);
    }
    assert.ok(st.graded <= st.n, 'pending excluded from graded');
    assert.equal(st.staked, st.graded * 100, '$100 flat per graded parlay');
  }
  for (const k of ['all_hit', 'push', 'partial', 'all_missed', 'pending']) assert.ok(k in SUMMARY.buckets, 'R72 buckets unchanged');
  // JSON convention: ASCII-only on disk
  for (const f of ['index.json', '2026_wk01.json', 'summary_parlays.json']) {
    assert.doesNotMatch(src(`tests/fixtures/r73/${f}`), /[^\x00-\x7F]/, `${f} is ASCII-escaped`);
  }
});

/* ---------------------------------------------------------- 6. app layer */

test('app layer: index in the mount allSettled, archive only on tap via data.js, CSS placement, legend, no model ids', () => {
  const view = src('app/views/parlays.js');
  const data = src('app/data.js');
  assert.match(data, /parlaysIndex: '\/data\/parlays\/index\.json'/);
  assert.match(data, /export const getParlaysIndex/);
  assert.match(data, /export function getParlayArchive/);
  assert.match(view, /export function parlayArchivePathFor/, 'the (season, week) fallback path lives off the boot graph');
  assert.doesNotMatch(view, /\bfetch\s*\(/, 'the view never fetches');
  assert.match(view, /Promise\.allSettled\(\[\s*getParlays\(\), getScheduleFull\(\), getParlaysIndex\(\),?\s*\]\)/,
    'the index joins the mount allSettled (cold 5 -> 6, tests/perf/budget.spec.mjs)');
  // the archive getter is called exactly once, inside selectWeek, never at mount
  const calls = [...view.matchAll(/getParlayArchive\(/g)].length;
  assert.equal(calls, 1, 'one call site for the archive getter');
  const sel = view.indexOf('async function selectWeek');
  assert.ok(sel > 0 && view.indexOf('getParlayArchive(') > sel, 'the call site is inside selectWeek');
  assert.ok(view.indexOf('getParlayArchive(') < view.indexOf('el.innerHTML =\n    head +'), 'and before the mount paint');
  assert.match(view, /chooseDefaultWeek\(data\.week, index && index\.current_week\)/, 'default = parlays.json week');
  assert.match(view, /import\('\.\.\/review\.js'\)/, 'review stays lazy');
  assert.doesNotMatch(view, /^import .*review\.js/m);
  assert.match(view, /reviewMod\.renderParlayPnl\(/);
  assert.match(view, /reviewMod\.parlayStake100\(selWeek, active\)/, 'P&L follows the selected week + scope');
  assert.match(view, /not archived/, 'the missing-archive state message');
  // the legend labels the money display-only, in one line
  const legend = view.slice(view.indexOf('function legend()'), view.indexOf('/** Provenance line'));
  assert.match(legend, /<b>P&amp;L<\/b>[^<]*\$100 flat[^<]*Display only — never a model input/);
  // CSS: the .pw-* block sits BEFORE the R71 marker (whose lock scans to EOF for .rv-* only)
  for (const f of ['app/theme.css', 'app/theme-hig.css']) {
    const css = src(f);
    const pw = css.indexOf('.pw-wk--closed');
    const r71 = css.indexOf('R71 — POST-GAME REVIEW');
    assert.ok(pw > 0 && r71 > pw, `${f}: .pw-* rules precede the R71 marker`);
    assert.ok(css.indexOf('.rv-pnl') > r71, `${f}: .rv-pnl rules live in the .rv-* region`);
  }
  for (const f of ['app/views/parlays.js', 'app/review.js', 'app/data.js', 'app/theme.css', 'app/theme-hig.css',
    'tests/web/r73_parlay_history.spec.mjs', 'tests/fixtures/r73/index.json', 'tests/fixtures/r73/2026_wk01.json',
    'tests/fixtures/r73/summary_parlays.json']) {
    assert.doesNotMatch(src(f), /claude-[a-z]+-\d/i, `${f} names a model id`);
  }
});
