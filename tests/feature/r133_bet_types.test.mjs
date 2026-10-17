// R133 — the BET TYPE selector, its − n + stepper, the confidence tags and
// outlines, and the cards it builds from the leg pool (app/bet-types.js), plus
// the bucket counts that now count only what the viewer can see.
//
// Owner, round 2 (2026-10-17): ALL and "+ MONEYLINE" read as moneyline-only
// cards; fix the mix. Each player now offers his most likely line, every card
// carries min(n, kinds) different kinds, the top two moneyline-only cards ride
// alongside whenever MONEYLINE is chosen, mixed cards sort by MOST LIKELY or
// BIGGEST PAYOUT, and GAME is one picked game at 2-7 legs, chance estimated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BET_TYPES, confTag, confChip, confClass, normTypes, stepValues, stepValue, typeControls, typeTap,
  pickRung, typeLegs, weekMixCards, moneylineCards, gameMixCards, estimateSameGame, typeTable,
  typesLabel, renderTypeCard, sortCards, openGames, mixTarget, GAME_MAX_LEGS, MAX_LEGS,
} from '../../app/bet-types.js';
import { combinedGameProbs } from '../../app/parlay-math.js';

const pool = JSON.parse(readFileSync(new URL('../../data/leg_pool.json', import.meta.url), 'utf8'));
const calib = JSON.parse(readFileSync(new URL('../../data/parlay_backtest.json', import.meta.url), 'utf8'));
const sched = JSON.parse(readFileSync(new URL('../../data/schedule_full.json', import.meta.url), 'utf8'));
const ALL = BET_TYPES.map(([k]) => k);
// Every game of the pool's week, treated as still to play, so the test does not
// depend on the clock.
const games = sched.games.filter((g) => Number(g.week) === Number(pool.week))
  .map((g) => ({ ...g, status: 'STATUS_SCHEDULED', kickoff_utc: '2099-01-01T00:00Z' }));
const table = typeTable(calib, pool);

// a minimal DOM stand-in for typeTap: closest() over a data attribute
const tap = (attrs) => ({
  closest(sel) {
    const key = sel.slice(1, -1).replace('data-', '');
    return key in attrs ? { dataset: attrs, disabled: !!attrs.disabled } : null;
  },
});
const S = (o) => ({ types: [], legs: 'all', sort: 'likely', ...o });

test('confidence tags and outlines cut at the MY dial lines: HIGH >= .65, MEDIUM >= .50, LOW below', () => {
  assert.equal(confTag(0.65), 'high');
  assert.equal(confTag(0.6499), 'medium');
  assert.equal(confTag(0.5), 'medium');
  assert.equal(confTag(0.4999), 'low');
  assert.equal(confTag(null), null);
  assert.match(confChip(0.7), /conf--high[^>]*>HIGH</);
  assert.match(confChip(0.55), /conf--medium[^>]*>MED</);
  assert.equal(confChip(undefined), '');
  assert.equal(confClass(0.9), 'leg--conf-high');
  assert.equal(confClass(0.55), 'leg--conf-medium');
  assert.equal(confClass(0.3), 'leg--conf-low');
  assert.equal(confClass(null), '');
});

test('the type row: PUBLISHED, ALL and the modelled kinds; no O/U or spread', () => {
  assert.deepEqual(ALL, ['atd', 'pass', 'rush', 'rec', 'ml']);
  const html = typeControls(S(), 'week', [2, 3]);
  for (const label of ['PUBLISHED', 'ALL', 'ANYTIME TD', 'PASSING', 'RUSHING', 'RECEIVING', 'MONEYLINE']) {
    assert.ok(html.includes(`>${label}</button>`), label);
  }
  assert.match(html, /data-type="published" aria-pressed="true"/);
  assert.doesNotMatch(html, /SPREAD|O\/U|TOTAL/);
  assert.doesNotMatch(html, /data-sort=/, 'published cards keep their own FILTERS sort');
  const built = typeControls(S({ types: ['rush'], legs: 3 }), 'week', []);
  assert.match(built, /data-sort="likely" aria-pressed="true"/);
  assert.match(built, />BIGGEST PAYOUT</);
  assert.deepEqual(normTypes(['ml', 'x', 'pass', 'ml']), ['pass', 'ml']);
});

test('published: the stepper walks ALL then the slate counts; built: 2..10 on WEEK, 2..7 on GAME', () => {
  assert.deepEqual(stepValues(S(), 'week', [2, 3, 7]), ['all', 2, 3, 7]);
  assert.equal(stepValues(S({ types: ['atd'], legs: 4 }), 'week', []).at(-1), MAX_LEGS);
  assert.deepEqual(stepValues(S({ types: ['atd'], legs: 4 }), 'game', []), [2, 3, 4, 5, 6, GAME_MAX_LEGS]);
  assert.equal(GAME_MAX_LEGS, 7);
  assert.equal(stepValue(S({ legs: 9 }), 'week', [2, 3, 7]), 7, 'nearest published count');
  const up = typeTap(S(), tap({ step: '1' }), 'week', [2, 3]);
  assert.deepEqual(up, S({ legs: 2 }));
  assert.equal(typeTap(S(), tap({ step: '-1', disabled: true }), 'week', [2, 3]), null);
  const html = typeControls(S(), 'week', [2, 3]);
  assert.match(html, /data-step="-1"[^>]*disabled/, 'ALL is the bottom of the stepper');
  assert.match(html, /td-step-n[^>]*>ALL</);
});

test('chips: ALL picks every kind, a kind from ALL starts fresh, the last kind off is PUBLISHED; sort toggles', () => {
  let s = typeTap(S(), tap({ type: 'all' }), 'week', [2]);
  assert.deepEqual(s.types, ALL);
  assert.equal(s.legs, 2, 'a built card has at least two legs');
  assert.match(typeControls(s, 'week', []), /data-type="all" aria-pressed="true"/);
  assert.equal(typesLabel(s.types), 'ALL KINDS');
  s = typeTap(s, tap({ type: 'rush' }), 'week', [2]);
  assert.deepEqual(s.types, ['rush']);
  s = typeTap(s, tap({ type: 'atd' }), 'week', [2]);
  assert.deepEqual(s.types, ['atd', 'rush']);
  assert.equal(typesLabel(s.types), 'ANYTIME TD + RUSHING');
  s = typeTap(s, tap({ sort: 'payout' }), 'week', [2]);
  assert.equal(s.sort, 'payout');
  assert.equal(typeTap(s, tap({ sort: 'payout' }), 'week', [2]), null);
  s = typeTap(s, tap({ type: 'published' }), 'week', [2]);
  assert.deepEqual(s.types, []);
  assert.equal(typeTap(s, tap({ type: 'published' }), 'week', [2]), null);
});

test('one rung per player: his MOST LIKELY line (highest win chance)', () => {
  const r = pickRung([{ line: 20, model_prob: 0.9 }, { line: 40, model_prob: 0.7 }, { line: 60, model_prob: 0.52 }]);
  assert.equal(r.line, 20);
  assert.equal(pickRung([]), null);
});

test('typeLegs keeps only the chosen kinds, one leg per player, open games only', () => {
  const legs = typeLegs(pool, ['rush'], games, 0);
  assert.ok(legs.length > 0);
  assert.ok(legs.every((l) => l.market === 'rb_rush_yds' && l.kind === 'rush'));
  assert.equal(new Set(legs.map((l) => l.owner)).size, legs.length, 'one leg per player');
  const ml = typeLegs(pool, ['ml'], games, 0);
  assert.ok(ml.length > 0 && ml.every((l) => l.kind === 'ml'));
  const started = games.map((g) => ({ ...g, status: 'STATUS_IN_PROGRESS' }));
  assert.equal(typeLegs(pool, ALL, started, 0).length, 0);
  assert.equal(openGames(started, 0).length, 0);
});

test('RCA round 2: ALL and RUSHING + MONEYLINE are MIXED, and beat the moneyline-only card', () => {
  const legs = typeLegs(pool, ALL, games, 0);
  for (const n of [2, 4, 7]) {
    const { cards } = weekMixCards(legs, n);
    assert.ok(cards.length >= 3, `${n}-leg cards`);
    const target = mixTarget(n, legs);
    for (const c of cards) {
      assert.equal(c.legs.length, n);
      assert.equal(new Set(c.legs.map((l) => String(l.game_id))).size, n, 'one leg per game');
      assert.ok(new Set(c.legs.map((l) => l.kind)).size >= target, 'forced mix');
      assert.ok(Math.abs(c.legs.reduce((p, l) => p * l.model_prob, 1) - c.model_prob) < 1e-12);
    }
    for (let i = 1; i < cards.length; i += 1) assert.ok(cards[i - 1].model_prob >= cards[i].model_prob);
    assert.equal(new Set(cards.map((c) => c.legs.map((l) => l.selection).sort().join('|'))).size, cards.length);
    const ml = moneylineCards(legs, n);
    assert.equal(ml.length, 2, 'the two most likely moneyline-only cards');
    for (const c of ml) assert.ok(c.legs.every((l) => l.kind === 'ml'));
    assert.ok(cards[0].model_prob >= ml[0].model_prob, 'the mix is at least as likely as moneylines alone');
  }
  const rm = typeLegs(pool, ['rush', 'ml'], games, 0);
  const { cards } = weekMixCards(rm, 4);
  for (const c of cards) {
    const kinds = new Set(c.legs.map((l) => l.kind));
    assert.ok(kinds.has('rush') && kinds.has('ml'), 'both chosen kinds on every card');
  }
});

test('sort: MOST LIKELY first or BIGGEST PAYOUT (least likely) first', () => {
  const cs = [{ model_prob: 0.2 }, { model_prob: 0.5 }, { model_prob: 0.3 }];
  assert.deepEqual(sortCards(cs, 'likely').map((c) => c.model_prob), [0.5, 0.3, 0.2]);
  assert.deepEqual(sortCards(cs, 'payout').map((c) => c.model_prob), [0.2, 0.3, 0.5]);
});

test('GAME: one picked game, 2-7 legs, one per player, never both moneylines, mixed; chance estimated', () => {
  const legs = typeLegs(pool, ALL, games, 0);
  const gid = String(openGames(games, 0)[0].game_id);
  for (const n of [2, 4, 7]) {
    const { cards, reason } = gameMixCards(legs, n, table, gid);
    assert.ok(cards.length > 0, `${n} legs: ${reason}`);
    const mine = legs.filter((l) => String(l.game_id) === gid);
    for (const c of cards) {
      assert.equal(c.legs.length, n);
      assert.ok(c.legs.every((l) => String(l.game_id) === gid));
      assert.equal(new Set(c.legs.map((l) => l.owner)).size, n);
      assert.ok(c.legs.filter((l) => l.kind === 'ml').length <= 1);
      assert.ok(new Set(c.legs.map((l) => l.kind)).size >= mixTarget(n, mine));
      assert.ok(c.model_prob > 0 && c.model_prob < 1);
      assert.ok(Math.abs(estimateSameGame(c.legs, table) - c.model_prob) < 1e-12);
    }
  }
  // a pair is priced exactly as the same-game model does (combinedProbs' rule)
  const pair = gameMixCards(legs, 2, table, gid).cards[0];
  assert.ok(Math.abs(combinedGameProbs(pair.legs, table)[0] - pair.model_prob) < 1e-12);
  const tooMany = gameMixCards(typeLegs(pool, ['ml'], games, 0), 3, table, gid);
  assert.equal(tooMany.cards.length, 0);
  assert.match(tooMany.reason, /This game has/);
});

test('cards say what they are: tags, outlines, model hit, ESTIMATED for 3+ same-game legs, not graded', () => {
  const legs = typeLegs(pool, ['atd', 'rush'], games, 0);
  const { cards } = weekMixCards(legs, 3);
  const html = renderTypeCard(cards[0], { scope: 'week', types: ['atd', 'rush'], games });
  assert.match(html, /ANYTIME TD \+ RUSHING · 3 LEGS/);
  assert.match(html, />MODEL HIT</);
  assert.match(html, /class="conf conf--/);
  assert.match(html, /class="leg leg--annot leg--conf-(high|medium|low)"/);
  assert.match(html, /not recorded or graded/);
  const gid = String(openGames(games, 0)[0].game_id);
  const g4 = gameMixCards(typeLegs(pool, ALL, games, 0), 4, table, gid).cards[0];
  const gh = renderTypeCard(g4, { scope: 'game', types: ALL, games });
  assert.match(gh, /EST\. MODEL HIT/);
  assert.match(gh, /ESTIMATED by chaining the measured pair correlations/);
  const ml = renderTypeCard(moneylineCards(typeLegs(pool, ALL, games, 0), 2)[0], { scope: 'week', types: ALL, games, label: 'MONEYLINE ONLY' });
  assert.match(ml, /MONEYLINE ONLY · 2 LEGS/);
  assert.match(ml, /data-ml-only="1"/);
});

test('GAME controls: a game picker of open games, the picked one selected', () => {
  const open = openGames(games, 0);
  const html = typeControls(S({ types: ALL, legs: 3 }), 'game', [], { games: open, gameId: open[1].game_id });
  assert.match(html, /<select id="game-pick"/);
  assert.equal((html.match(/<option /g) || []).length, open.length);
  assert.match(html, new RegExp(`value="${open[1].game_id}" selected`));
  assert.doesNotMatch(typeControls(S({ types: ALL, legs: 3 }), 'week', [], { games: open }), /game-pick/);
});

test('bucket counts follow the scope and the slate shown (R133 RCA: ALL HIT 1, empty list)', () => {
  const view = readFileSync(new URL('../../app/views/parlays.js', import.meta.url), 'utf8');
  assert.match(view, /reviewMod\.parlayRowCount\(selWeek, active\)/);
  assert.match(view, /visible\(\)\.filter\(\(p\) => scopeOf\(p\) === active\)\.forEach/);
  assert.doesNotMatch(view, /renderParlayBuckets\(\s*selWeek, reviewMod\.parlayBucketCounts\(selWeek\)/,
    'the whole-week, all-scope counts are no longer painted as the chips');
});
