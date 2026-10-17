// R133 — the BET TYPE selector, its − n + stepper, the confidence tags and the
// cards it builds from the leg pool (app/bet-types.js), plus the bucket counts
// that now count only what the viewer can see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BET_TYPES, confTag, confChip, normTypes, stepValues, stepValue, typeControls, typeTap,
  pickRung, typeLegs, weekTypeCards, gameTypeCards, typeTable, typesLabel, renderTypeCard,
  GAME_MAX_LEGS, MAX_LEGS,
} from '../../app/bet-types.js';

const pool = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const calib = JSON.parse(readFileSync(new URL('../../data/parlay_backtest.json', import.meta.url), 'utf8'));
const sched = JSON.parse(readFileSync(new URL('../../data/schedule_full.json', import.meta.url), 'utf8'));
const week = pool.week;
// Every game of the pool's week, treated as still to play, so the test does not
// depend on the clock.
const games = sched.games.filter((g) => Number(g.week) === Number(week))
  .map((g) => ({ ...g, status: 'STATUS_SCHEDULED', kickoff_utc: '2099-01-01T00:00Z' }));

// a minimal DOM stand-in for typeTap: closest() over a data attribute
const tap = (attrs) => ({
  closest(sel) {
    const key = sel.slice(1, -1).replace('data-', '');
    return key in attrs ? { dataset: attrs, disabled: !!attrs.disabled } : null;
  },
});

test('confidence tags cut at the MY dial lines: HIGH >= .65, MEDIUM >= .50, LOW below', () => {
  assert.equal(confTag(0.65), 'high');
  assert.equal(confTag(0.6499), 'medium');
  assert.equal(confTag(0.5), 'medium');
  assert.equal(confTag(0.4999), 'low');
  assert.equal(confTag(null), null);
  assert.match(confChip(0.7), /conf--high[^>]*>HIGH</);
  assert.match(confChip(0.55), /conf--medium[^>]*>MED</);
  assert.equal(confChip(undefined), '');
});

test('the type row offers exactly the modelled kinds; no O/U or spread', () => {
  assert.deepEqual(BET_TYPES.map(([k]) => k), ['atd', 'pass', 'rush', 'rec', 'ml']);
  const html = typeControls({ types: [], legs: 'all' }, 'week', [2, 3]);
  for (const label of ['ALL', 'ANYTIME TD', 'PASSING', 'RUSHING', 'RECEIVING', 'MONEYLINE']) {
    assert.ok(html.includes(`>${label}</button>`), label);
  }
  assert.doesNotMatch(html, /SPREAD|O\/U|TOTAL/);
  assert.deepEqual(normTypes(['ml', 'x', 'pass', 'ml']), ['pass', 'ml']);
});

test('published cards: the stepper walks ALL then the slate counts; built cards: 2..10, GAME pairs only', () => {
  assert.deepEqual(stepValues({ types: [], legs: 'all' }, 'week', [2, 3, 7]), ['all', 2, 3, 7]);
  assert.deepEqual(stepValues({ types: ['atd'], legs: 4 }, 'week', []).at(-1), MAX_LEGS);
  assert.deepEqual(stepValues({ types: ['atd'], legs: 4 }, 'game', []), [GAME_MAX_LEGS]);
  assert.equal(stepValue({ types: [], legs: 9 }, 'week', [2, 3, 7]), 7, 'nearest published count');
  const s0 = { types: [], legs: 'all' };
  const up = typeTap(s0, tap({ step: '1' }), 'week', [2, 3]);
  assert.deepEqual(up, { types: [], legs: 2 });
  assert.equal(typeTap(s0, tap({ step: '-1', disabled: true }), 'week', [2, 3]), null);
  const html = typeControls(s0, 'week', [2, 3]);
  assert.match(html, /data-step="-1"[^>]*disabled/, 'ALL is the bottom of the stepper');
  assert.match(html, /td-step-n[^>]*>ALL</);
});

test('type chips toggle; the last one off is ALL again; ALL clears', () => {
  let s = { types: [], legs: 'all' };
  s = typeTap(s, tap({ type: 'rush' }), 'week', [2]);
  assert.deepEqual(s.types, ['rush']);
  assert.equal(s.legs, 2, 'a built card has at least two legs');
  s = typeTap(s, tap({ type: 'atd' }), 'week', [2]);
  assert.deepEqual(s.types, ['atd', 'rush']);
  assert.equal(typesLabel(s.types), 'ANYTIME TD + RUSHING');
  s = typeTap(s, tap({ type: 'all' }), 'week', [2]);
  assert.deepEqual(s.types, []);
  assert.equal(typeTap(s, tap({ type: 'all' }), 'week', [2]), null);
  assert.equal(typesLabel(BET_TYPES.map(([k]) => k)), 'ALL KINDS');
});

test('one rung per player: the hardest line still at 50%+, else his most likely', () => {
  const r = pickRung([{ line: 20, model_prob: 0.9 }, { line: 40, model_prob: 0.7 },
    { line: 60, model_prob: 0.52 }, { line: 80, model_prob: 0.3 }]);
  assert.equal(r.line, 60);
  assert.equal(pickRung([{ line: 60, model_prob: 0.3 }, { line: 80, model_prob: 0.2 }]).line, 60);
  assert.equal(pickRung([]), null);
});

test('typeLegs keeps only the chosen kinds, one leg per player, open games only', () => {
  const legs = typeLegs(pool, ['rush'], games, 0);
  assert.ok(legs.length > 0);
  assert.ok(legs.every((l) => l.market === 'rb_rush_yds'));
  assert.equal(new Set(legs.map((l) => l.owner)).size, legs.length, 'one leg per player');
  const ml = typeLegs(pool, ['ml'], games, 0);
  assert.ok(ml.every((l) => l.market === 'moneyline'));
  assert.ok(ml.length > 0);
  // a kicked-off game supplies nothing
  const started = games.map((g) => ({ ...g, status: 'STATUS_IN_PROGRESS' }));
  assert.equal(typeLegs(pool, ['rush', 'ml', 'atd'], started, 0).length, 0);
});

test('WEEK cards: n legs, one per game, product chance, most likely first, distinct sets', () => {
  const legs = typeLegs(pool, ['atd', 'rec'], games, 0);
  for (const n of [2, 4, 6]) {
    const { cards } = weekTypeCards(legs, n);
    assert.equal(cards.length, 3, `${n}-leg cards`);
    for (const c of cards) {
      assert.equal(c.legs.length, n);
      assert.equal(new Set(c.legs.map((l) => String(l.game_id))).size, n, 'one leg per game');
      const prod = c.legs.reduce((p, l) => p * l.model_prob, 1);
      assert.ok(Math.abs(prod - c.model_prob) < 1e-12);
    }
    assert.ok(cards[0].model_prob >= cards[1].model_prob && cards[1].model_prob >= cards[2].model_prob);
    const keys = cards.map((c) => c.legs.map((l) => l.selection).sort().join('|'));
    assert.equal(new Set(keys).size, 3);
    // the first card is the n most likely legs on distinct games: no better card exists
    const best = [];
    const used = new Set();
    for (const l of legs) {
      if (best.length === n) break;
      if (used.has(String(l.game_id))) continue;
      used.add(String(l.game_id)); best.push(l);
    }
    assert.ok(Math.abs(best.reduce((p, l) => p * l.model_prob, 1) - cards[0].model_prob) < 1e-12);
  }
  const few = weekTypeCards(legs.filter((l) => String(l.game_id) === String(legs[0].game_id)), 2);
  assert.equal(few.cards.length, 0);
  assert.match(few.reason, /one leg per game/);
});

test('GAME cards: same-game pairs, correlation-priced, never two moneylines or one player twice', () => {
  const legs = typeLegs(pool, ['ml', 'pass', 'rec'], games, 0);
  const { cards } = gameTypeCards(legs, typeTable(calib, pool), games);
  assert.ok(cards.length > 0);
  const perGame = new Map();
  for (const c of cards) {
    assert.equal(c.legs.length, 2);
    assert.equal(String(c.legs[0].game_id), String(c.legs[1].game_id));
    assert.ok(!(c.legs[0].market === 'moneyline' && c.legs[1].market === 'moneyline'));
    assert.notEqual(c.legs[0].owner, c.legs[1].owner);
    assert.ok(c.model_prob > 0 && c.model_prob < 1);
    perGame.set(c.game_id, (perGame.get(c.game_id) || 0) + 1);
  }
  assert.ok([...perGame.values()].every((n) => n <= 3));
});

test('a built card says what it is: model hit, break-even, tags, and not graded', () => {
  const legs = typeLegs(pool, ['atd'], games, 0);
  const { cards } = weekTypeCards(legs, 3);
  const html = renderTypeCard(cards[0], { scope: 'week', types: ['atd'], games });
  assert.match(html, /ANYTIME TD · 3 LEGS/);
  assert.match(html, /MODEL HIT/);
  assert.match(html, /BREAK-EVEN ODDS/);
  assert.match(html, /class="conf conf--/);
  assert.match(html, /not recorded or graded/);
});

test('bucket counts follow the scope and the slate shown (R133 RCA: ALL HIT 1, empty list)', () => {
  const view = readFileSync(new URL('../../app/views/parlays.js', import.meta.url), 'utf8');
  assert.match(view, /reviewMod\.parlayRowCount\(selWeek, active\)/);
  assert.match(view, /visible\(\)\.filter\(\(p\) => scopeOf\(p\) === active\)\.forEach/);
  assert.doesNotMatch(view, /renderParlayBuckets\(\s*selWeek, reviewMod\.parlayBucketCounts\(selWeek\)/,
    'the whole-week, all-scope counts are no longer painted as the chips');
});
