/* tests/feature/r76_myparlays_search.test.mjs — the MY PARLAYS card search.
 *
 * The search is where this feature can go quietly wrong: it builds cards from a
 * 1,400-leg pool, and a card that breaks one of the rules below is not obviously
 * broken on screen — it just quietly sells the same opinion twice and quotes a
 * payout for risk the bettor never took. So each rule is asserted directly:
 *
 *   1. EVERY card contains a seed. A card that does not is not the user's card.
 *   2. ONE LEG PER PLAYER. "40+ rec yds" and "20+ rec yds" on the same man is one
 *      opinion twice — clearing 40 clears 20. Same species of error as R74.
 *   3. R74 ITSELF. A team's moneyline and that team's spread cannot co-exist.
 *   4. CONVICTION FALLS AS LEGS ARE ADDED. Every leg is a further condition, so a
 *      longer card can never be more likely; if it ever is, the correlation fold
 *      has a sign error.
 *   5. THE CARDS ARE THE BEST AVAILABLE at their leg count — the beam search is
 *      checked against exhaustive enumeration on a small pool, so "it returned
 *      ten cards" is never mistaken for "it returned the right ten".
 *
 * Also asserted: a seed nobody can price comes back empty rather than inventing a
 * card, and the $100 figure is the payout at the prices shown.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  buildCards, conviction, matchesSeed, poolLegs, scoreCard, seedOptions, whyLine,
} from '../../app/views/myparlays.js';
import { correlationTable, violatesOnePerSide } from '../../app/parlay-math.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const hasPool = existsSync(join(ROOT, 'data/leg_pool.json'));
const TABLE = correlationTable(readJson('data/parlay_backtest.json'));

/** A tiny, fully-enumerable pool so the beam can be checked against the truth. */
function toyPool() {
  const rung = (line, p, name) => ({ line, z: 0, selection: `${name} ${line + 0.5}+`, model_prob: p });
  return {
    players: [
      { gsis_id: 'p1', player: 'Alpha One', team: 'AAA', position: 'WR',
        market: 'wr_rec_yds', game_id: 'G1', side: 'home', mu: 70, p_team: 0.6,
        pricing: 'pool_calibrated',
        rungs: [rung(39.5, 0.8, 'A. One'), rung(59.5, 0.65, 'A. One')] },
      { gsis_id: 'p2', player: 'Beta Two', team: 'AAA', position: 'RB',
        market: 'rb_rush_yds', game_id: 'G1', side: 'home', mu: 60, p_team: 0.6,
        pricing: 'pool_calibrated', rungs: [rung(39.5, 0.7, 'B. Two')] },
      { gsis_id: 'p3', player: 'Gamma Three', team: 'BBB', position: 'QB',
        market: 'qb_pass_yds', game_id: 'G1', side: 'away', mu: 240, p_team: 0.4,
        pricing: 'pool_calibrated', rungs: [rung(224.5, 0.55, 'G. Three')] },
      { gsis_id: 'p4', player: 'Delta Four', team: 'CCC', position: 'WR',
        market: 'wr_rec_yds', game_id: 'G2', side: 'home', mu: 80, p_team: 0.55,
        pricing: 'pool_calibrated', rungs: [rung(59.5, 0.6, 'D. Four')] },
    ],
    game_legs: [
      { market: 'moneyline', selection: 'AAA ML', model_prob: 0.6, implied_prob: 0.62,
        game_id: 'G1', team: 'AAA', side: 'home', source: 'parlays.json' },
      { market: 'spread', selection: 'AAA -3', model_prob: 0.5, implied_prob: 0.52,
        game_id: 'G1', team: 'AAA', side: 'home', source: 'parlays.json' },
    ],
  };
}

const TOY = toyPool();
const TOY_LEGS = poolLegs(TOY);

/* 1-3 — the rules a card must satisfy ------------------------------------- */

test('every card contains a seed, one leg per player, and obeys R74', () => {
  const seeds = [{ kind: 'player', id: 'p1', name: 'Alpha One' }];
  const cards = buildCards(TOY_LEGS, seeds, TABLE, { counts: [2, 3], perCount: 3 });
  assert.ok(cards.length > 0, 'the toy pool can build cards');
  for (const card of cards) {
    assert.ok(card.legs.some((l) => matchesSeed(l, seeds)), 'a card with no seed leg');
    const owners = card.legs.map((l) => l.owner);
    assert.equal(new Set(owners).size, owners.length,
      `two legs for one player: ${card.legs.map((l) => l.selection).join(' + ')}`);
    assert.equal(violatesOnePerSide(card.legs), false,
      `R74 violated: ${card.legs.map((l) => l.selection).join(' + ')}`);
  }
});

test('a team seed pulls in its players, not just its game legs', () => {
  const seeds = [{ kind: 'team', id: 'team:AAA', name: 'AAA' }];
  const matched = TOY_LEGS.filter((l) => matchesSeed(l, seeds));
  assert.ok(matched.some((l) => l.owner === 'p1'), 'a team seed reaches its players');
  assert.ok(matched.some((l) => l.market === 'moneyline'), 'and its moneyline');
  assert.ok(!matched.some((l) => l.owner === 'p4'), 'but not another team\'s player');
});

/* 4 — conviction behaves --------------------------------------------------- */

test('conviction falls as legs are added — a longer card is never more likely', () => {
  const seeds = [{ kind: 'player', id: 'p1', name: 'Alpha One' }];
  const cards = buildCards(TOY_LEGS, seeds, TABLE, { counts: [2, 3, 4], perCount: 1 });
  const byCount = new Map(cards.map((c) => [c.legs.length, c.model]));
  const sizes = [...byCount.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(byCount.get(sizes[i]) <= byCount.get(sizes[i - 1]),
      `${sizes[i]} legs (${byCount.get(sizes[i])}) beat ${sizes[i - 1]} (${byCount.get(sizes[i - 1])})`);
  }
});

/* 5 — the beam finds the best cards, not merely ten cards ------------------ */

test('the beam matches exhaustive enumeration on a pool small enough to enumerate', () => {
  const seeds = [{ kind: 'player', id: 'p1', name: 'Alpha One' }];
  const size = 3;
  // every legal 3-leg card containing a seed, by brute force
  const best = [];
  const n = TOY_LEGS.length;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      for (let c = b + 1; c < n; c += 1) {
        const legs = [TOY_LEGS[a], TOY_LEGS[b], TOY_LEGS[c]];
        const owners = legs.map((l) => l.owner);
        if (new Set(owners).size !== owners.length) continue;
        if (violatesOnePerSide(legs)) continue;
        if (!legs.some((l) => matchesSeed(l, seeds))) continue;
        best.push({ legs, model: conviction(legs, TABLE) });
      }
    }
  }
  best.sort((x, y) => y.model - x.model);
  assert.ok(best.length >= 2, 'the brute force found candidates');
  const beam = buildCards(TOY_LEGS, seeds, TABLE, { counts: [size], perCount: 2 });
  assert.equal(beam.length, 2);
  assert.ok(Math.abs(beam[0].model - best[0].model) < 1e-12,
    `beam best ${beam[0].model} vs true best ${best[0].model}`);
  assert.ok(Math.abs(beam[1].model - best[1].model) < 1e-12,
    `beam second ${beam[1].model} vs true second ${best[1].model}`);
});

/* honesty ------------------------------------------------------------------ */

test('an unpriceable seed returns nothing rather than inventing a card', () => {
  const cards = buildCards(TOY_LEGS, [{ kind: 'player', id: 'nobody', name: 'No One' }], TABLE);
  assert.deepEqual(cards, []);
});

test('the $100 figure is the payout at the prices shown, and props are flagged', () => {
  const legs = TOY_LEGS.filter((l) => l.owner === 'p2' || l.owner === 'p4');
  assert.equal(legs.length, 2);
  const card = scoreCard(legs, TABLE);
  const decimal = 1 / (legs[0].implied_prob * legs[1].implied_prob);
  assert.ok(Math.abs(card.payout - 100 * (decimal - 1)) < 1e-9);
  // both are props: no book price, so both are counted as assumed and EV is the vig
  assert.equal(card.assumed, 2);
  assert.ok(card.ev < 0, 'an all-prop card cannot show positive EV');
  // a real book price is the only way a positive edge appears
  const ml = TOY_LEGS.find((l) => l.market === 'moneyline');
  assert.equal(ml.priced, true);
});

test('the why-line states numbers, never adjectives', () => {
  const prop = TOY_LEGS.find((l) => l.owner === 'p1');
  const why = whyLine(prop);
  assert.match(why, /projects 70\.0 vs a 39\.5 line/);
  // the three numbers must RECONCILE on screen: 70.0 - 39.5 = 30.5, not "+31"
  assert.match(why, /\(\+30\.5\)/);
  const [, muS, lineS, gapS] = /projects ([\d.]+) vs a ([\d.]+) line \(([+\-][\d.]+)\)/.exec(why);
  assert.ok(Math.abs((Number(muS) - Number(lineS)) - Number(gapS)) < 0.05,
    `${muS} - ${lineS} does not equal ${gapS}`);
  const ml = TOY_LEGS.find((l) => l.market === 'moneyline');
  assert.match(whyLine(ml), /book price 62 vs our 60/);
});

/* the shipped pool --------------------------------------------------------- */

test('the committed pool builds real cards for a real player', () => {
  if (!hasPool) return;
  const pool = readJson('data/leg_pool.json');
  const legs = poolLegs(pool);
  const options = seedOptions(pool);
  assert.ok(options.length > 100, `${options.length} seed options`);
  assert.ok(options.some((o) => o.kind === 'team'), 'teams are seedable too');

  const player = options.find((o) => o.kind === 'player');
  const cards = buildCards(legs, [player], TABLE);
  assert.ok(cards.length > 0, `no card for ${player.name}`);
  assert.ok(cards.length <= 10, `${cards.length} cards — expected at most ten`);
  for (const card of cards) {
    assert.ok(card.legs.some((l) => matchesSeed(l, [player])));
    const owners = card.legs.map((l) => l.owner);
    assert.equal(new Set(owners).size, owners.length, 'one leg per player');
    assert.equal(violatesOnePerSide(card.legs), false);
    assert.ok(card.model > 0 && card.model <= 1);
    assert.ok(['high', 'medium', 'low'].includes(card.tier));
  }
  // the leg-count bands are what stop every card being a 2-leg card
  const counts = new Set(cards.map((c) => c.legs.length));
  assert.ok(counts.size >= 3, `only ${counts.size} distinct leg counts`);
});
