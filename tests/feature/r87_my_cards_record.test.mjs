/* tests/feature/r87_my_cards_record.test.mjs — the RECORD line on MY PARLAYS.
 *
 * MY PARLAYS shows ten cards and a conviction number for each. Until R87 nothing
 * recorded what was offered, so nothing graded it, and the only number on screen
 * was the view's opinion of its own opinion. renderRecord is the one line that
 * answers back: for the dial you are looking at, this is how the cards this dial
 * offered actually did.
 *
 * A line like that is worth more than the cards above it and is therefore the
 * easiest thing in the product to get quietly wrong. The properties locked here:
 *
 *   1. IT FOLLOWS THE DIAL. SAFE, EVEN and LONGSHOT are different populations of
 *      cards; showing EVEN's record under the LONGSHOT chip would be a lie with
 *      no visible symptom. paint() re-renders it whenever the dial changes.
 *   2. IT PICKS THE LATEST GRADED WEEK, not the latest week — a week that has not
 *      been played has nothing to say.
 *   3. NOTHING GRADED RENDERS NOTHING. Not "0 cards", not "0.0%". A hit rate of
 *      zero claims a measurement that was never made, and that is the exact shape
 *      of the committed feed today: 900 cards recorded, none graded.
 *   4. A MISSING OR BROKEN FEED RENDERS NOTHING. The mount loads it with
 *      allSettled and a rejection leaves it null.
 *   5. THE NUMBERS ARE THE FEED'S. The counts, the percentages and the $100 net
 *      are printed from the block, not recomputed, and the money is formatted the
 *      way every other money figure in this view is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DIALS, renderRecord } from '../../app/views/myparlays.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'app/views/myparlays.js'), 'utf8');
const SCORES_PATH = join(ROOT, 'data/my_card_scores.json');

/** A block in the shape scripts/resolve_my_cards.py writes. */
const block = (o = {}) => ({
  n: 300, graded: 0, all_hit: 0, hit_rate: null, mean_model: null, log_loss: null,
  brier: null, staked: null, net_fair: null, net_vig2: null, roi_fair: null, ...o,
});

const EMPTY_BLOCKS = { safe: block(), even: block(), longshot: block() };

const week = (n, byDial) => ({
  week: n,
  n_cards: 900,
  locked: 900,
  graded: Object.values(byDial).reduce((a, b) => a + b.graded, 0),
  pending: 0,
  buckets: { all_hit: 0, push: 0, partial: 0, all_missed: 0, pending: 0 },
  by_dial: { ...EMPTY_BLOCKS, ...byDial },
  by_legs: { 2: block(), 3: block(), 4: block(), 5: block(), 6: block() },
});

const GRADED = {
  even: block({ n: 300, graded: 320, all_hit: 41, hit_rate: 0.1281, mean_model: 0.1412,
    log_loss: 0.4521, brier: 0.1103, staked: 32000, net_fair: -1240.16,
    net_vig2: -1806.4, roi_fair: -0.0388 }),
  safe: block({ n: 300, graded: 300, all_hit: 96, hit_rate: 0.32, mean_model: 0.3004,
    log_loss: 0.6, brier: 0.2, staked: 30000, net_fair: 2450.5, net_vig2: 1900.1,
    roi_fair: 0.0817 }),
};

const FIXTURE = {
  season: 2026,
  generated_utc: '2026-10-01T09:00:00Z',
  source: 'https://example.invalid/stats.csv',
  finals_source: 'scores from data/review.json FINAL rows (16 games)',
  rule: 'r',
  weeks_resolved: 1,
  weeks: [
    week(2, GRADED),
    // A LATER week that has not been graded: it must not win the pick.
    week(3, {}),
  ],
  cards: [],
  skipped: null,
};

/* 1-2 — the dial, and the latest GRADED week ------------------------------- */

test('the record is the current dial\'s, from the latest week that has graded cards', () => {
  const even = renderRecord(FIXTURE, 'even');
  assert.match(even, /WK 2/, 'week 3 has nothing graded and must not be picked');
  assert.match(even, /EVEN/);
  assert.match(even, /320 cards graded/);
  assert.match(even, /41 all hit \(12\.8%\)/);
  assert.match(even, /mean conviction 14\.1%/);

  const safe = renderRecord(FIXTURE, 'safe');
  assert.match(safe, /SAFE/);
  assert.match(safe, /300 cards graded/);
  assert.match(safe, /96 all hit \(32\.0%\)/);
  assert.ok(!safe.includes('320 cards'), 'the SAFE line must not print EVEN\'s cards');

  // LONGSHOT has offered cards but none graded: nothing to say, so nothing said.
  assert.equal(renderRecord(FIXTURE, 'longshot'), '');
  // and a dial that does not exist cannot borrow another's record
  assert.equal(renderRecord(FIXTURE, 'nonsense'), '');
  for (const d of Object.keys(DIALS)) {
    assert.equal(typeof renderRecord(FIXTURE, d), 'string');
  }
});

test('the whole line reads as the product states it', () => {
  const html = renderRecord(FIXTURE, 'even');
  const text = html.replace(/<[^>]*>/g, '');
  assert.equal(text,
    'RECORD · WK 2 · EVEN · 320 cards graded · 41 all hit (12.8%) · '
    + 'mean conviction 14.1% · $100 flat net −$1,240MEASURED');
  // the money uses the view's own formatter: a real minus sign and thousands
  assert.match(html, /−\$1,240/);
  assert.ok(!/-\$1,240/.test(html), 'a hyphen is not a minus sign');
});

/* 3-4 — nothing graded, and nothing at all ---------------------------------- */

test('nothing graded renders NOTHING — never a zero', () => {
  const none = { ...FIXTURE, weeks: [week(2, {}), week(3, {})], weeks_resolved: 0 };
  for (const dial of Object.keys(DIALS)) {
    assert.equal(renderRecord(none, dial), '',
      `${dial}: a week with 0 graded cards must render nothing, not "0 cards graded"`);
  }
  // an empty document, and the shapes a broken or absent feed can take
  assert.equal(renderRecord({ season: 2026, weeks: [], cards: [] }, 'even'), '');
  assert.equal(renderRecord({}, 'even'), '');
  assert.equal(renderRecord(null, 'even'), '');
  assert.equal(renderRecord(undefined, 'even'), '');
  assert.equal(renderRecord({ weeks: null }, 'even'), '');
  assert.equal(renderRecord({ weeks: [{ week: 2 }] }, 'even'), '');
  assert.equal(renderRecord({ weeks: [{ week: 2, by_dial: {} }] }, 'even'), '');
});

test('a null metric is dropped, never printed as a number', () => {
  // graded > 0 but a metric missing is not a shape the resolver writes; if it
  // ever appears, the line must lose that clause rather than print "NaN%".
  const partial = { ...FIXTURE, weeks: [week(2, {
    even: block({ graded: 10, all_hit: 2, hit_rate: 0.2, mean_model: null,
      net_fair: null }),
  })] };
  const html = renderRecord(partial, 'even');
  assert.match(html, /10 cards graded/);
  assert.match(html, /2 all hit \(20\.0%\)/);
  assert.ok(!/mean conviction/.test(html), 'a null mean must not be printed');
  assert.ok(!/flat net/.test(html), 'a null net must not be printed');
  assert.ok(!/NaN|null|undefined/.test(html), html);
});

/* 5 — markup and wiring ----------------------------------------------------- */

test('the line reuses the legend classes, so it costs no new CSS', () => {
  const html = renderRecord(FIXTURE, 'even');
  assert.match(html, /class="legend mp-record"/);
  assert.match(html, /class="legend-item"/);
  assert.match(html, /class="est"/);
  const classes = [...html.matchAll(/class="([^"]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/));
  const known = new Set(['legend', 'legend-item', 'est', 'mp-record']);
  for (const c of classes) assert.ok(known.has(c), `unexpected class ${c}`);
  // .mp-record is a HANDLE, not a style: it must not need a rule to look right.
  const css = readFileSync(join(ROOT, 'app/theme.css'), 'utf8');
  assert.ok(/\.legend\b/.test(css) && /\.legend-item\b/.test(css) && /\.est\s*\{/.test(css),
    'the classes the record reuses must already be styled');
});

test('the record is re-rendered when the dial changes, and removed when empty', () => {
  assert.match(SRC, /function paintRecord\(el\)/,
    'the record needs its own paint so the dial handler can re-run it');
  assert.match(SRC, /paintRecord\(el\);/, 'paint() must repaint the record');
  // paint() is what the dial handler calls, so the record follows the dial.
  const paintBody = /function paint\(el\) \{([\s\S]*?)\n\}/.exec(SRC)[1];
  assert.ok(paintBody.includes('paintRecord(el)'),
    'paintRecord must be called from paint(), which the dial handler calls');
  assert.match(SRC, /const prev = el\.querySelector\('\.mp-record'\);[\s\S]{0,80}prev\.remove\(\)/,
    'an empty record must be REMOVED, not left as an empty node taking a flex row');
});

test('the feed is loaded 404-gracefully and a failure renders nothing', () => {
  assert.match(SRC, /getMyCardScores/, 'the view must read the graded record');
  assert.match(SRC, /Promise\.allSettled\(\[[\s\S]*?getMyCardScores\(\)/,
    'the record must be loaded with allSettled — a 404 must not blank the view');
  assert.match(SRC, /state\.scores = scoresR\.status === 'fulfilled' \? scoresR\.value : null/,
    'a rejected feed must leave state.scores null');
  // and null is a state renderRecord already handles (asserted above)
  assert.equal(renderRecord(null, 'even'), '');
});

/* the committed feed -------------------------------------------------------- */

test('the committed feed is the shape renderRecord reads', () => {
  if (!existsSync(SCORES_PATH)) return;      // OPTIONAL feed, absent on a clone
  const doc = JSON.parse(readFileSync(SCORES_PATH, 'utf8'));
  assert.ok(Array.isArray(doc.weeks), 'weeks[] is what the record is picked from');
  for (const w of doc.weeks) {
    assert.ok(w.by_dial, `week ${w.week} carries no by_dial block`);
    for (const dial of Object.keys(DIALS)) {
      const b = w.by_dial[dial];
      assert.ok(b, `week ${w.week} has no ${dial} block`);
      if (!b.graded) {
        for (const k of ['hit_rate', 'mean_model', 'log_loss', 'brier', 'net_fair']) {
          assert.equal(b[k], null,
            `week ${w.week} ${dial}.${k} is ${b[k]} with 0 graded cards — a metric `
            + 'with nothing behind it must be null, never 0');
        }
      }
    }
    // and the line it would produce is a string, never a throw
    for (const dial of Object.keys(DIALS)) {
      assert.equal(typeof renderRecord(doc, dial), 'string');
    }
  }
});
