/* tests/feature/r86_my_dial.test.mjs — the MY PARLAYS risk dial.
 *
 * WHAT WAS WRONG. buildCards ranks by conviction and let EVERY rung of every
 * player compete. A player's rungs are nested events — clearing 60 clears 20 —
 * so his most probable rung is always his LOWEST line and the search had no
 * reason to take any other. Measured on the committed pool before R86: 1,280 of
 * 1,280 prop legs across all 32 team seeds sat at the player's lowest rung
 * (100%), the mean prop model probability was 0.906, and the best 2-leg card in
 * the product paid about +$10 on a $100 simulation. Every card was a near-lock
 * priced like a near-lock, which is arithmetically consistent and answers a
 * question nobody asked.
 *
 * THE FIX (R86). ONE RUNG PER PLAYER, chosen before the search by a risk dial
 * the viewer sets: SAFE 0.65, EVEN 0.50 (default), LONGSHOT 0.35 — the rung
 * whose model probability is nearest the target, ties to the higher line.
 * Ranking WITHIN the dial stays conviction, which is now a comparison between
 * legs of comparable difficulty rather than a race to the ladder floor. Market
 * prices still never reach a model probability, and no rung is re-priced: the
 * dial only decides which already-priced rung is eligible.
 *
 * WHAT THIS FILE LOCKS: dialLegs as a pure function (one rung per player,
 * nearest the target, game legs untouched), the sweep over the COMMITTED pool
 * that the fault was measured on, the markup renderCard still emits, the legend
 * that now has to name the dial, and — read as text, the way
 * r82_myparlays_layout.test.mjs reads them — the three CSS declarations the
 * layout half of R86 consists of. The geometry itself is measured in
 * tests/web/r86_my_dial.spec.mjs, which is where a layout claim can be proved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_DIAL, DIALS, GAME_LEG_BAND, buildCards, dialLegs, poolLegs, renderCard,
  seedOptions,
} from '../../app/views/myparlays.js';
import { correlationTable } from '../../app/parlay-math.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const CSS = readFileSync(join(ROOT, 'app/theme.css'), 'utf8');
const SRC = readFileSync(join(ROOT, 'app/views/myparlays.js'), 'utf8');
const hasPool = existsSync(join(ROOT, 'data/leg_pool.json'));
const TABLE = correlationTable(readJson('data/parlay_backtest.json'));

/** The same test dialLegs applies: a prop is an unpriced leg owned by a player. */
const isProp = (l) => !l.priced && l.owner && !String(l.owner).startsWith('team:');

/** A ladder of rungs for one player, as poolLegs would flatten it. */
function ladder(owner, probs, game = 'G1') {
  return probs.map(([line, p]) => ({
    owner, label: owner, selection: `${owner} ${line + 0.5}+`, market: 'wr_rec_yds',
    model_prob: p, implied_prob: Math.min(p * 1.045, 0.999), priced: false,
    line, mu: 70, game_id: game, side: 'home', team: 'AAA',
  }));
}

/* ==========================================================================
   1. THE DIAL ITSELF
   ========================================================================== */

test('DIALS are the three published targets and EVEN is the default', () => {
  assert.deepEqual(DIALS, { safe: 0.65, even: 0.50, longshot: 0.35 });
  assert.equal(GAME_LEG_BAND, 0.15);
  assert.equal(DEFAULT_DIAL, 'even');
  assert.ok(Object.prototype.hasOwnProperty.call(DIALS, DEFAULT_DIAL),
    'the default dial must name a real target');
});

test('dialLegs keeps exactly one rung per player — the one nearest the target', () => {
  const legs = ladder('p1', [[19.5, 0.88], [39.5, 0.61], [59.5, 0.44], [79.5, 0.21]]);
  for (const [target, line] of [[0.65, 39.5], [0.50, 59.5], [0.35, 59.5], [0.88, 19.5]]) {
    const kept = dialLegs(legs, target).filter(isProp);
    assert.equal(kept.length, 1, `dial ${target} kept ${kept.length} rungs for one player`);
    assert.equal(kept[0].line, line,
      `dial ${target} took line ${kept[0].line} (p=${kept[0].model_prob}) — nearest is ${line}`);
  }
});

test('a tie between two rungs goes to the HIGHER line', () => {
  // 0.55 and 0.45 are both 0.05 from EVEN. The higher line is the harder bet and
  // the one a viewer asking for an even-money leg means; an arbitrary tie-break
  // would make the selection depend on pool order.
  const legs = ladder('p1', [[19.5, 0.55], [39.5, 0.45]]);
  const kept = dialLegs(legs, 0.50).filter(isProp);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].line, 39.5, 'a tie must resolve to the higher line');
  // and the same pool in the other order resolves the same way
  const reversed = dialLegs(legs.slice().reverse(), 0.50).filter(isProp);
  assert.equal(reversed[0].line, 39.5, 'the tie-break must not depend on pool order');
});

test('every player keeps one rung, and players do not borrow each other\'s', () => {
  const legs = [
    ...ladder('p1', [[19.5, 0.90], [39.5, 0.52]]),
    ...ladder('p2', [[24.5, 0.71], [44.5, 0.33]], 'G2'),
  ];
  const kept = dialLegs(legs, 0.50).filter(isProp);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((l) => [l.owner, l.line]), [['p1', 39.5], ['p2', 44.5]]);
});

/** A game leg at a given model probability. */
const gameLeg = (p, extra = {}) => ({
  owner: 'team:AAA', selection: 'AAA ML', market: 'moneyline', model_prob: p,
  implied_prob: 0.68, priced: true, game_id: 'G1', side: 'home', team: 'AAA', ...extra,
});

test('a game leg is kept only inside the dial\'s band, never re-priced', () => {
  // A moneyline is ONE fixed number — there is no ladder to pick from — so the
  // dial asks the only question it can: is this the difficulty you asked for?
  // Without the band, conviction ranking took the heaviest favourite in the
  // league ahead of any leg the dial had just chosen and the cards filled with
  // moneylines instead of the players you typed (measured at EVEN: 905 of the
  // 1,280 legs on cards were game legs; with the band, 610).
  const ml77 = gameLeg(0.77);
  const ml52 = gameLeg(0.52, { selection: 'BBB ML', owner: 'team:BBB', team: 'BBB' });
  const pool = [...ladder('p1', [[19.5, 0.9], [39.5, 0.5]]), ml77, ml52];

  const even = dialLegs(pool, DIALS.even).filter((l) => !isProp(l));
  assert.deepEqual(even.map((l) => l.selection), ['BBB ML'],
    'at EVEN (0.50 ± 0.15 -> 0.35..0.65) a 0.77 moneyline is outside the band and '
    + 'a 0.52 one is inside it');

  const safe = dialLegs(pool, DIALS.safe).filter((l) => !isProp(l));
  assert.deepEqual(safe.map((l) => l.selection), ['AAA ML', 'BBB ML'],
    'at SAFE (0.65 ± 0.15 -> 0.50..0.80) the same 0.77 moneyline IS the difficulty '
    + 'asked for, and 0.52 is still inside the band at its lower edge');
  // the one that moves is the point: a 0.77 favourite is a SAFE leg and not an
  // EVEN one, which is the whole reason the band exists.
  assert.ok(!even.some((l) => l === ml77), 'the 0.77 favourite must not reach an EVEN card');
  assert.ok(safe.some((l) => l === ml77), 'and it must reach a SAFE one');

  // the legs that survive are the SAME OBJECTS: the dial filters, it never prices
  assert.equal(even[0], ml52);
  assert.equal(safe[0], ml77);
  assert.equal(safe[1], ml52);
  // a leg too easy even for SAFE is out: 0.85 is 0.20 above the SAFE target
  assert.equal(dialLegs([gameLeg(0.85)], DIALS.safe).length, 0,
    'no dial offers a 0.85 moneyline — every dial is a band, not a floor');

  // the band is inclusive at exactly GAME_LEG_BAND, and it is a two-sided band
  const edge = dialLegs([gameLeg(DIALS.even + GAME_LEG_BAND)], DIALS.even);
  assert.equal(edge.length, 1, 'a leg exactly at the band edge is inside it');
  assert.equal(dialLegs([gameLeg(DIALS.even - GAME_LEG_BAND - 1e-9)], DIALS.even).length, 0,
    'the band is two-sided: a leg too EASY is out as surely as one too hard');

  // two team legs on ONE team are the one-per-side rule's business, not the
  // dial's: the dial must never collapse them the way it collapses a ladder.
  const two = dialLegs([gameLeg(0.52), gameLeg(0.52, { selection: 'AAA -3', market: 'spread' })],
    DIALS.even);
  assert.equal(two.length, 2, 'the dial deduplicates ladders, not teams');
});

test('dialLegs is pure — it mutates neither the array nor any leg', () => {
  const legs = ladder('p1', [[19.5, 0.9], [39.5, 0.5]]);
  const before = JSON.parse(JSON.stringify(legs));
  const n = legs.length;
  const out = dialLegs(legs, 0.50);
  assert.equal(legs.length, n, 'the input array was mutated');
  assert.deepEqual(JSON.parse(JSON.stringify(legs)), before, 'a leg was mutated');
  assert.notEqual(out, legs, 'dialLegs must return a new array');
});

/* ==========================================================================
   2. THE SWEEP OVER THE COMMITTED POOL — the fault, measured
   ========================================================================== */

/** Every card for every team seed at one dial, summarised.
 *
 * `pick` is the eligibility rule under test: the dial by default, and the
 * IDENTITY (every rung of every player competing) for the pre-R86 baseline the
 * fault was measured on. */
function sweep(legs, target, lowest, teams, pick = (ls) => dialLegs(ls, target)) {
  const dialled = pick(legs);
  // The floor share of the ELIGIBLE set — the population the search draws from.
  // The search may never park on the floor MORE often than its own eligible set
  // does; that bias is precisely the pre-R86 fault, and it is a property of the
  // rule rather than a number this pool happens to produce.
  let eligibleProps = 0;
  let eligibleAtLowest = 0;
  for (const l of dialled) {
    if (!isProp(l)) continue;
    eligibleProps += 1;
    if (Number(l.line) === lowest.get(l.owner)) eligibleAtLowest += 1;
  }
  let props = 0;
  let games = 0;
  let atLowest = 0;
  let sum = 0;
  let maxPerGame = 0;
  let cards = 0;
  const offenders = [];
  for (const seed of teams) {
    for (const card of buildCards(dialled, [seed], TABLE)) {
      cards += 1;
      const perGame = new Map();
      for (const l of card.legs) {
        if (l.game_id) perGame.set(l.game_id, (perGame.get(l.game_id) || 0) + 1);
      }
      maxPerGame = Math.max(maxPerGame, ...perGame.values());
      for (const l of card.legs) {
        if (!isProp(l)) { games += 1; continue; }
        props += 1;
        sum += l.model_prob;
        if (Number(l.line) === lowest.get(l.owner)) {
          atLowest += 1;
          // The floor is only allowed when it IS the rung nearest the dial.
          const rungs = legs.filter((x) => isProp(x) && x.owner === l.owner);
          const best = Math.min(...rungs.map((x) => Math.abs(x.model_prob - target)));
          if (Math.abs(l.model_prob - target) > best + 1e-12) offenders.push(l.selection);
        }
      }
    }
  }
  return { cards, props, games, atLowest, pctAtLowest: (100 * atLowest) / props,
    mean: sum / props, maxPerGame, offenders,
    eligibleProps, eligibleAtLowest,
    eligiblePctAtLowest: (100 * eligibleAtLowest) / eligibleProps };
}

test('the committed pool no longer parks every prop leg on the ladder floor', () => {
  if (!hasPool) return;
  const pool = readJson('data/leg_pool.json');
  const legs = poolLegs(pool);
  const teams = seedOptions(pool).filter((s) => s.kind === 'team');
  assert.ok(teams.length >= 30, `${teams.length} team seeds — expected the full league`);
  const lowest = new Map();
  for (const l of legs) {
    if (!isProp(l)) continue;
    lowest.set(l.owner, Math.min(lowest.get(l.owner) ?? Infinity, Number(l.line)));
  }

  const even = sweep(legs, DIALS.even, lowest, teams);
  assert.equal(even.cards, teams.length * 10, `${even.cards} cards for ${teams.length} seeds`);
  assert.ok(even.props > 0, 'no prop legs reached the cards at all');

  // THE PRIMARY PROPERTY. Before R86 this was 100% and every one of those legs
  // was a floor the dial would not have chosen. What survives is the floor of a
  // ladder whose floor genuinely IS the rung nearest 0.50 — eight players on
  // this pool (K. Allen 19.5 at 0.537 with 29.5 at 0.422 next, K. Murray,
  // J. Brissett, A. Iosivas, M. Sanders, T. Franklin, J. Reed, K. Boutte).
  // Those are correct selections, so the invariant below is the real lock and
  // the percentage is the headline number.
  assert.deepEqual(even.offenders, [],
    'a prop leg sits on the player\'s lowest rung although a nearer rung to the '
    + 'dial exists — the selection rule has regressed');
  // THE CEILING IS DERIVED, NOT PINNED (2026-09-20).
  //
  // This was `pctAtLowest < 10`, a measurement taken on one afternoon's pool
  // (6.87%, 46 of 670). Nothing in the product decides that number: WHICH
  // players are pooled decides it, and the pool is rebuilt every pipeline run.
  // Through the Sunday of week 2 it drifted 7.47% -> 13.08% -> 14.96% without a
  // line of code changing — one newly pooled RB (Z. Charbonnet, floor rung 19.5
  // at 0.5324, genuinely the rung nearest EVEN) contributed 42 of the 104 legs
  // on his own. Raising the bar to make it green would have been exactly the
  // "never move it to make a bar green" this comment used to warn against, so
  // the bar is replaced by the property it was standing in for.
  //
  // THE PROPERTY: the search must not be BIASED toward the floor relative to the
  // set it draws from. dialLegs leaves one rung per player, and on this pool
  // that rung is the player's floor for a large minority of them — those are
  // correct selections (the invariant above proves each one). What would be a
  // regression is the CARDS preferring floors more often than the dialled pool
  // offers them, which is what the pre-R86 search did: it drew from every rung
  // of every ladder and still put a floor on 99.8% of card legs. That comparison
  // is measured live below rather than remembered as a number.
  assert.ok(even.pctAtLowest <= even.eligiblePctAtLowest + 1e-9,
    `${even.pctAtLowest.toFixed(2)}% of prop legs on cards sit at the player's lowest `
    + `rung (${even.atLowest} of ${even.props}), but only `
    + `${even.eligiblePctAtLowest.toFixed(2)}% of the legs the dial made eligible are `
    + 'floors — the search is biased toward the ladder floor, which is the R86 fault');

  // ...and the fault is still reachable on THIS pool, so the line above is not
  // vacuous: with every rung eligible (the pre-R86 rule) the cards park on the
  // floor almost every time and the mean prop probability runs away to a lock.
  const undialled = sweep(legs, DIALS.even, lowest, teams, (ls) => ls);
  assert.ok(undialled.pctAtLowest > 95,
    `with every rung eligible only ${undialled.pctAtLowest.toFixed(2)}% of card legs `
    + 'are floors — the pre-R86 fault is no longer reproducible on this pool, so the '
    + 'comparison above measures nothing and this file needs rewriting');
  assert.ok(undialled.mean > 0.85,
    `the undialled mean prop probability is ${undialled.mean.toFixed(4)} — R86 was `
    + 'measured against 0.906 near-locks');
  assert.ok(even.pctAtLowest < undialled.pctAtLowest,
    'the dial must reduce the floor share it was introduced to remove');

  // The dial is the difficulty of the legs it admits, so the mean has to land
  // near the target rather than near the ceiling (0.906 before R86).
  assert.ok(even.mean >= 0.40 && even.mean <= 0.62,
    `mean prop model probability at EVEN is ${even.mean.toFixed(4)}, outside [0.40, 0.62]`);

  // R83 — at most two legs from any one game, unchanged by the dial.
  assert.ok(even.maxPerGame <= 2, `a card carries ${even.maxPerGame} legs from one game`);

  // THE BAND'S OWN PROPERTY. MY is about the players you typed, and a moneyline
  // is not one. Without the band on game legs, conviction ranking preferred a
  // 0.77 favourite to every leg the dial had just chosen: 375 props against 905
  // game legs at EVEN, 29.3% props. With it: 670 against 610, 52.3%.
  const pctProps = (100 * even.props) / (even.props + even.games);
  assert.ok(pctProps >= 45,
    `only ${pctProps.toFixed(1)}% of the legs on the cards are player props `
    + `(${even.props} props, ${even.games} game legs) — game legs are crowding out `
    + 'the players the seeds name, which is what GAME_LEG_BAND exists to stop');
});

test('SAFE admits easier legs than EVEN, and LONGSHOT harder ones', () => {
  if (!hasPool) return;
  const pool = readJson('data/leg_pool.json');
  const legs = poolLegs(pool);
  const teams = seedOptions(pool).filter((s) => s.kind === 'team');
  const lowest = new Map();
  for (const l of legs) {
    if (!isProp(l)) continue;
    lowest.set(l.owner, Math.min(lowest.get(l.owner) ?? Infinity, Number(l.line)));
  }
  const safe = sweep(legs, DIALS.safe, lowest, teams);
  const even = sweep(legs, DIALS.even, lowest, teams);
  const longshot = sweep(legs, DIALS.longshot, lowest, teams);
  assert.ok(safe.mean > even.mean,
    `SAFE mean ${safe.mean.toFixed(4)} is not above EVEN ${even.mean.toFixed(4)}`);
  assert.ok(longshot.mean < even.mean,
    `LONGSHOT mean ${longshot.mean.toFixed(4)} is not below EVEN ${even.mean.toFixed(4)}`);
  for (const s of [safe, even, longshot]) {
    assert.deepEqual(s.offenders, [], 'a dial chose a floor over a nearer rung');
    assert.ok(s.maxPerGame <= 2, 'more than two legs from one game');
  }
});

/* ==========================================================================
   3. THE MARKUP AND THE LEGEND
   ========================================================================== */

const CARD = {
  tier: 'medium', sameGame: false, model: 0.31, ev: -0.092, payout: 322, assumed: 2,
  legs: [
    { selection: 'J. Smith-Njigba 60+ receiving yards', market: 'wr_rec_yds',
      model_prob: 0.52, implied_prob: 0.54, priced: false, mu: 71.4, line: 59.5 },
    { selection: 'DET ML', market: 'moneyline', model_prob: 0.69, implied_prob: 0.66,
      priced: true, price_source: 'fair_market' },
  ],
};

test('renderCard still emits leg--annot on every leg (R82 stays intact)', () => {
  const html = renderCard(CARD, 0);
  const attrs = [...html.matchAll(/class="(leg(?:\s[^"]*)?)"/g)].map((m) => m[1]);
  assert.equal(attrs.length, CARD.legs.length);
  for (const cls of attrs) {
    assert.ok(cls.split(/\s+/).includes('leg--annot'),
      `a MY leg rendered class="${cls}" — without leg--annot the why-line takes `
      + 'the name\'s flex line and squeezes it. R82.');
  }
  assert.ok(html.includes('class="leg leg--annot"'), 'the exact class pair R82 locked');
});

test('the legend names all three dial labels and what the dial does', () => {
  const m = /id="mp-note"([\s\S]*?)ESTIMATE/.exec(SRC);
  assert.ok(m, 'the #mp-note legend was not found in app/views/myparlays.js');
  const legend = m[1];
  for (const label of ['SAFE', 'EVEN', 'LONGSHOT']) {
    assert.ok(legend.includes(label),
      `the legend must name the ${label} dial — it is what chose the lines on screen`);
  }
  assert.match(legend, /ONE line per player/,
    'the legend must say a card carries one line per player, which is the whole '
    + 'of R86 stated in one clause');
  assert.match(legend, /EVERY leg/,
    'the legend must say the dial applies to every leg, not only to the props: a '
    + 'moneyline outside the band is not offered, and the viewer is owed that');
  assert.match(legend, /within 15 points/,
    'and it must state the band in the units the chips are labelled in');
  assert.match(legend, /65%/);
  assert.match(legend, /50%/);
  assert.match(legend, /35%/);
  // R85 locks this phrase in tests/web/r85_parlay_acceptance.spec.mjs: cards are
  // ranked by model hit chance, never by payout. R86 changes what is eligible,
  // not what the ranking is.
  assert.ok(legend.includes('never by payout'), 'the ranking claim must survive R86');
  assert.ok(legend.includes('At most two legs per game'), 'the R83 cap must stay stated');
});

test('the chosen dial is persisted per viewer, in a try/catch', () => {
  assert.ok(SRC.includes("'nfl2026.myparlays.dial.v1'"),
    'the dial must persist under nfl2026.myparlays.dial.v1');
  assert.match(SRC, /localStorage\.getItem\(\s*(DIAL_KEY|'nfl2026\.myparlays\.dial\.v1')\s*\)/,
    'the dial must be READ back on mount, not only written');
  assert.match(SRC, /localStorage\.setItem\(\s*(DIAL_KEY|'nfl2026\.myparlays\.dial\.v1')/,
    'the dial must be written when the viewer taps a chip');
  // Safari private mode throws on both getItem and setItem; an unguarded call
  // would take the whole view down with it.
  for (const m of SRC.matchAll(/localStorage\.(getItem|setItem)/g)) {
    const before = SRC.slice(Math.max(0, m.index - 260), m.index);
    assert.ok(/try\s*\{/.test(before),
      `localStorage.${m[1]} is not inside a try block — storage throws in private mode`);
  }
});

/* ==========================================================================
   4. THE CSS THE LAYOUT HALF CONSISTS OF
   ========================================================================== */

/** The body of the FIRST rule whose selector list matches `selector`. */
function ruleBody(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

test('the MY grid is exactly two columns on desktop, and there is only one rule', () => {
  const rules = [...CSS.matchAll(/#mp-list\.card-list\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rules.length, 1,
    `expected ONE #mp-list.card-list rule after R86, found ${rules.length}. The `
    + 'R82 1200px auto-fill override is gone: auto-fill put three columns on a '
    + '1395px canvas and split the leg-count PAIRS the list is built as, so every '
    + 'row mixed a 2-leg card with a 3-leg one and the shorter card grew an 83px '
    + 'void under its legs.');
  assert.match(rules[0], /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    'the MY grid must be repeat(2, minmax(0,1fr)): two cards per row is one '
    + 'leg-count band per row, which makes the equal heights free');
  assert.ok(!/auto-fill/.test(rules[0]), 'auto-fill cannot come back on #mp-list');
  assert.match(rules[0], /align-items:\s*stretch/, 'R82 row alignment must survive');
  const foot = ruleBody(CSS, '.mp-card .p-foot');
  assert.match(foot, /margin-top:\s*auto/, 'R82 foot anchoring must survive');
});

test('the MY host has its own 12px vertical rhythm', () => {
  // the selector, not the comment above it that names the same id
  const body = ruleBody(CSS, '\n#myparlays-host {');
  assert.ok(body, '#myparlays-host rule missing from app/theme.css');
  assert.match(body, /display:\s*flex/);
  assert.match(body, /flex-direction:\s*column/);
  assert.match(body, /gap:\s*12px/,
    'the .view gap only reaches direct children, so the MY host\'s own children '
    + '(input, seeds, dial, legend, grid) sat at 0px. R86.');
  assert.match(CSS, /#mp-seeds:empty\s*\{[^}]*display:\s*none/,
    'an EMPTY seed box must not occupy a row of the host flex column, or the '
    + 'gap above the dial doubles before any seed is typed');
  assert.ok(!/\.mp-seeds:not\(:empty\)\s*\{[^}]*margin-top/.test(CSS),
    'the one-sided 8px margin on .mp-seeds is retired — it double-spaces the '
    + 'host gap (measured 20px against the 12px rhythm)');
});

test('the band eyebrow reuses the slate day-group style and spans the row', () => {
  assert.ok(/\.mp-band/.test(CSS), '.mp-band is not styled in app/theme.css');
  const body = ruleBody(CSS, '.slate-day');
  assert.ok(body, '.slate-day rule missing');
  const shared = /\.slate-day,\s*\n?\.mp-band\s*\{/.test(CSS)
    || /\.mp-band,\s*\n?\.slate-day\s*\{/.test(CSS);
  const own = ruleBody(CSS, '.mp-band');
  assert.ok(shared || (own && /grid-column:\s*1 \/ -1/.test(own)),
    '.mp-band must span every column (grid-column: 1 / -1) so the eyebrow opens '
    + 'the row its pair sits on rather than becoming a third card');
  assert.match(body, /grid-column:\s*1 \/ -1/);
});

test('paint emits one band eyebrow per leg-count pair, as a heading', () => {
  assert.match(SRC, /class="mp-band" role="heading" aria-level="3"/,
    'the band eyebrow must be a real heading: it is the only thing on screen '
    + 'that names what a row of cards has in common');
  assert.match(SRC, /LEGS/, 'the eyebrow text states the leg count');
});
