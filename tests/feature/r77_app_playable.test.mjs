/* tests/feature/r77_app_playable.test.mjs — R77 "is he playable this week?",
 * as the APP renders it. Node built-ins only; synthetic fixtures throughout, so
 * this suite is independent of whatever the pipeline happens to have committed.
 *
 * THE FACT. data/player_weekly.json rows gain an optional `this_week` block,
 * written ONLY when the player cannot play this week (status or depth chart) or
 * when a backup quarterback has been PROMOTED into the start. The week's own row
 * already carries `avail:false` / `pts:0.0`, so weekValue() already returns 0.0
 * — which is exactly the problem this release fixes: a 0.0 printed under
 * "WK 2 · MATCHUP" reads as a projection ("we think he scores nothing") rather
 * than as a benching ("he is not playing"). The headline must name the reason.
 *
 * WHAT IS LOCKED HERE:
 *   1. weekValue() gains `gate` and keeps every field it had — the return shape
 *      is additive, and the gate is attached ONLY to the week it is about;
 *   2. every tag string, for every reason the contract defines, plus the three
 *      pre-R77 tags (MATCHUP / BYE / NO WEEKLY ROW) which must not move;
 *   3. the spelled-out `title` — an abbreviation is never the only affordance,
 *      and it appears ONLY on a gated headline;
 *   4. QUESTIONABLE is NOT gated: Q is priced and labelled, never excluded;
 *   5. the Q chip on prop legs in both parlay surfaces — PARLAYS (annotateLegs,
 *      through its pure propQChip) and MY PARLAYS (poolLegs -> renderCard).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { gateTag, weekValue, withWeekHeadline } from '../../app/views/players.js';
import { propQChip } from '../../app/views/parlays.js';
import { poolLegs, renderCard, scoreCard } from '../../app/views/myparlays.js';
import { correlationTable } from '../../app/parlay-math.js';
import { renderPlayerCard } from '../../app/render.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PARLAYS_SRC = readFileSync(join(ROOT, 'app/views/parlays.js'), 'utf8');
const THEME_SRC = readFileSync(join(ROOT, 'app/theme.css'), 'utf8');

/* ---- synthetic weekly fixtures ------------------------------------------ */

const PLAYER = { gsis_id: 'p77', name: 'Test Back', team: 'AAA', position: 'RB',
  proj_points: 100, low: 80, high: 120 };

/** A weekly row whose week 2 is gated by `tw` (or ungated when tw is null). */
function weekly(tw) {
  return {
    gsis_id: 'p77',
    weeks: [
      { wk: 1, bye: false, pts: 10, opp: 'BUF' },
      tw && tw.playable === false
        ? { wk: 2, bye: false, pts: 0, avail: false, opp: 'KC' }
        : { wk: 2, bye: false, pts: 12, opp: 'KC' },
      { wk: 3, bye: true, pts: 0 },
    ],
    ...(tw ? { this_week: tw } : {}),
  };
}

const head = (w, wk) => {
  const html = withWeekHeadline(renderPlayerCard(PLAYER, {}), wk,
    weekValue(PLAYER, w, 'ppr', wk), PLAYER.proj_points);
  const m = html.match(/<div class="p-unit"([^>]*)>(WK [^<]*)<\/div>/);
  assert.ok(m, 'the headline paints a WK p-unit');
  const t = m[1].match(/ title="([^"]*)"/);
  return { tag: m[2], title: t ? t[1] : null, num: html.match(/<div class="p-num[^"]*">([^<]*)</)[1] };
};

/* ---- 1. weekValue: additive, and the gate belongs to ONE week ------------- */

test('R77: weekValue keeps its shape and attaches `gate` only to its own week', () => {
  const tw = { wk: 2, playable: false, reason: 'status', status: 'OUT', points_lost: 12.3 };
  const w = weekly(tw);
  const wk1 = weekValue(PLAYER, w, 'ppr', 1);
  const wk2 = weekValue(PLAYER, w, 'ppr', 2);
  // Pre-R77 fields, unchanged.
  assert.deepEqual(
    { points: wk1.points, bye: wk1.bye, opp: wk1.opp }, { points: 10, bye: false, opp: 'BUF' },
  );
  assert.equal(wk2.points, 0, 'the pipeline already zeroed the gated week');
  assert.equal(wk2.opp, 'KC');
  // The gate is a fact about week 2 and nothing else.
  assert.equal(wk1.gate, null, 'week 1 is not week 2');
  assert.equal(weekValue(PLAYER, w, 'ppr', 3).gate, null, 'the bye is not week 2');
  assert.equal(wk2.gate, tw, 'week 2 carries the block verbatim');
  // A row with no this_week at all is byte-identical to today, plus gate:null.
  const plain = weekValue(PLAYER, weekly(null), 'ppr', 2);
  assert.deepEqual(plain, { points: 12, bye: false, opp: 'KC', gate: null });
  // Purity: the fixture is not mutated by rendering it.
  assert.deepEqual(w.this_week, tw);
});

/* ---- 2. every tag, for every reason -------------------------------------- */

const STATUS_TAGS = [
  ['OUT', 'OUT', 'Not playable this week — ruled out'],
  ['DOUBTFUL', 'D', 'Not playable this week — doubtful'],
  ['SUSPENDED', 'SUSP', 'Not playable this week — suspended'],
  ['IR', 'IR', 'Not playable this week — on injured reserve'],
  ['PUP', 'PUP', 'Not playable this week — on the PUP list'],
  ['NFI', 'NFI', 'Not playable this week — on the NFI list'],
];

test('R77: a status gate names the status, and the number stays 0.0', () => {
  for (const [status, tag, title] of STATUS_TAGS) {
    const w = weekly({ wk: 2, playable: false, reason: 'status', status, points_lost: 12.3 });
    const h = head(w, 2);
    assert.equal(h.tag, `WK 2 · ${tag}`, status);
    assert.equal(h.title, title, `${status} spells itself out`);
    assert.equal(h.num, '0.0', 'the gated week is the pipeline\'s 0.0, not a projection');
    // The abbreviation is never the only affordance.
    assert.notEqual(tag, title);
  }
});

test('R77: a depth gate names the rung, and a chartless QB says NOT STARTING', () => {
  const qb2 = head(weekly({
    wk: 2, playable: false, reason: 'depth', depth: 2, starter: 'Patrick Mahomes', points_lost: 9.8,
  }), 2);
  assert.equal(qb2.tag, 'WK 2 · QB2');
  assert.equal(qb2.title, 'Not playable this week — QB2 behind Patrick Mahomes');
  assert.equal(qb2.num, '0.0');

  const qb3 = head(weekly({
    wk: 2, playable: false, reason: 'depth', depth: 3, starter: 'Sam Darnold', points_lost: 9.8,
  }), 2);
  assert.equal(qb3.tag, 'WK 2 · QB3');
  assert.equal(qb3.title, 'Not playable this week — QB3 behind Sam Darnold');

  // `depth: null` means "not on his team's chart at all" — a rung would be a lie.
  const none = head(weekly({ wk: 2, playable: false, reason: 'depth', depth: null, points_lost: 9.8 }), 2);
  assert.equal(none.tag, 'WK 2 · NOT STARTING');
  assert.equal(none.title, 'Not playable this week — not on the depth chart');
  assert.doesNotMatch(none.title, /QB(null|NaN|undefined)/);

  // A rung with no named starter states the rung and claims no name.
  const bare = head(weekly({ wk: 2, playable: false, reason: 'depth', depth: 2 }), 2);
  assert.equal(bare.tag, 'WK 2 · QB2');
  assert.equal(bare.title, 'Not playable this week — QB2');
});

test('R77: a PROMOTED backup keeps MATCHUP and appends · STARTS', () => {
  const w = weekly({ wk: 2, playable: true, reason: 'depth_promoted', depth: 2, starter_out: 'Sam Darnold' });
  const h = head(w, 2);
  assert.equal(h.tag, 'WK 2 · MATCHUP · STARTS');
  assert.equal(h.title, null, 'he IS playable — there is nothing to spell out');
  assert.equal(h.num, '12.0', 'a promoted backup keeps his points');
});

/* ---- 3. the pre-R77 tags do not move -------------------------------------- */

test('R77: MATCHUP / BYE / NO WEEKLY ROW are untouched and carry no title', () => {
  const w = weekly(null);
  assert.deepEqual(head(w, 1), { tag: 'WK 1 · MATCHUP', title: null, num: '10.0' });
  assert.deepEqual(head(w, 3), { tag: 'WK 3 · BYE', title: null, num: '0.0' });
  const html = withWeekHeadline(renderPlayerCard(PLAYER, {}), 9, weekValue(PLAYER, w, 'ppr', 9), 100);
  assert.match(html, /<div class="p-unit">WK 9 · NO WEEKLY ROW<\/div>/);
  assert.match(html, /<div class="p-num pv-none">—<\/div>/, 'absent is never 0.0');
  // A gate for ANOTHER week never leaks onto this one's headline.
  const other = weekly({ wk: 2, playable: false, reason: 'status', status: 'OUT' });
  assert.equal(head(other, 1).tag, 'WK 1 · MATCHUP');
  assert.equal(head(other, 1).title, null);
  // Unknown card markup still passes through untouched (R51 contract).
  assert.equal(withWeekHeadline('<div>x</div>', 1, weekValue(PLAYER, w, 'ppr', 1), 100), '<div>x</div>');
});

test('R77: QUESTIONABLE is NOT gated — he keeps his points and his MATCHUP', () => {
  const w = weekly(null);
  w.availability = { status: 'QUESTIONABLE', class: 'week' };
  const h = head(w, 2);
  assert.deepEqual(h, { tag: 'WK 2 · MATCHUP', title: null, num: '12.0' });
});

/* ---- 4. gateTag itself, including the junk cases -------------------------- */

test('R77: gateTag is pure and claims nothing it cannot back', () => {
  assert.equal(gateTag(null), null);
  assert.equal(gateTag(undefined), null);
  assert.equal(gateTag({}), null, 'no playable:false is not a gate');
  assert.equal(gateTag({ playable: true, reason: 'status', status: 'OUT' }), null);
  // An unknown status is not invented into a label — the tag falls back to MATCHUP.
  assert.equal(gateTag({ playable: false, reason: 'status', status: 'HURT' }), null);
  assert.equal(gateTag({ playable: false, reason: 'status' }), null);
  // An unknown reason likewise says nothing.
  assert.equal(gateTag({ playable: false, reason: 'vibes' }), null);
  assert.deepEqual(gateTag({ playable: false, reason: 'status', status: 'out' }),
    ['OUT', 'Not playable this week — ruled out'], 'case-insensitive on the code');
  assert.deepEqual(gateTag({ playable: true, reason: 'depth_promoted' }), ['MATCHUP · STARTS', '']);
});

/* ---- 5. the Q chip, both parlay surfaces --------------------------------- */

const Q_TITLE = 'Questionable — game-time decision';

test('R77: PARLAYS prices a QUESTIONABLE prop and labels it with a Q chip', () => {
  assert.equal(propQChip({ market: 'wr_rec_yds' }), null);
  assert.equal(propQChip({ market: 'wr_rec_yds', availability: 'ACTIVE' }), null);
  assert.equal(propQChip(null), null);
  assert.deepEqual(propQChip({ market: 'qb_pass_yds', availability: 'QUESTIONABLE' }),
    { cls: 'est leg-q', text: 'Q', title: Q_TITLE });
  // The insertion itself is DOM work (no jsdom in this gate): pin the wiring —
  // the chip goes at the FRONT of .leg-od, exactly where NO EDGE goes.
  assert.match(PARLAYS_SRC, /const q = propQChip\(leg\);/);
  assert.match(PARLAYS_SRC, /chip\.className = q\.cls;/);
  assert.match(PARLAYS_SRC, /if \(od\) od\.insertBefore\(chip, od\.firstChild\);/);
  // The chip reuses the .est pill in the availability "watch" tone — no new colour.
  assert.match(THEME_SRC, /\.leg-q \{[^}]*color: var\(--warn\);[^}]*\}/);
  assert.match(THEME_SRC, /\.leg-q \{[^}]*border-color: var\(--warn\);[^}]*\}/);
});

/** A one-player, one-rung leg pool. */
function pool(availability) {
  return {
    players: [{
      gsis_id: 'q1', player: 'Quest Ionable', team: 'AAA', position: 'WR',
      market: 'wr_rec_yds', game_id: 'G1', side: 'home', mu: 70, p_team: 0.6,
      pricing: 'pool_calibrated',
      ...(availability ? { availability } : {}),
      rungs: [{ line: 39.5, z: 0, selection: 'Q. Ionable 40+ rec yds', model_prob: 0.8 }],
    }],
    game_legs: [{ market: 'moneyline', selection: 'AAA ML', team: 'AAA', game_id: 'G1',
      model_prob: 0.6, implied_prob: 0.62, priced: true }],
  };
}

test('R77: MY PARLAYS carries availability from the pool row onto the leg', () => {
  const q = poolLegs(pool('QUESTIONABLE'));
  assert.equal(q.length, 2, 'one prop rung + one game leg');
  assert.equal(q[0].availability, 'QUESTIONABLE');
  assert.equal(q[1].availability, undefined, 'a game leg has no player availability');
  // Absent stays absent — the key is not invented as null/undefined/ACTIVE.
  const plain = poolLegs(pool(null));
  assert.equal('availability' in plain[0], false);
  // Nothing about the maths moved.
  assert.deepEqual(
    { s: q[0].selection, p: q[0].model_prob, o: q[0].owner, l: q[0].line },
    { s: plain[0].selection, p: plain[0].model_prob, o: plain[0].owner, l: plain[0].line },
  );
});

test('R77: MY PARLAYS renders the same Q chip, and only for a Q leg', () => {
  const table = correlationTable(null);
  const chip = `<span class="est leg-q" title="${Q_TITLE}">Q</span>`;
  const card = (avail) => renderCard(scoreCard(poolLegs(pool(avail)), table), 0);

  const withQ = card('QUESTIONABLE');
  assert.ok(withQ.includes(chip), 'the Q leg carries the chip');
  assert.equal(withQ.split(chip).length - 1, 1, 'exactly one chip — the game leg has none');
  // At the FRONT of .leg-od, the same place PARLAYS puts it.
  assert.match(withQ, new RegExp(`<div class="leg-od">${chip.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<span class="mo">`));
  assert.ok(!card(null).includes('leg-q'), 'no chip without the flag');
  // The card's numbers are identical with and without the chip: a label, not an input.
  assert.equal(card('QUESTIONABLE').replace(chip, ''), card(null));
});
