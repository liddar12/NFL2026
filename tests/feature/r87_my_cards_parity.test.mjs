/* tests/feature/r87_my_cards_parity.test.mjs — the MY card SELECTION must be the
 * same in Python as it is in the browser, card for card.
 *
 * R87 records what MY PARLAYS offered (scripts/build_my_cards.py) so the cards can
 * be graded like every other parlay. The record is only worth keeping if it is a
 * record of what a viewer was actually shown, and that claim rests entirely on
 * scripts/models/my_cards.py reproducing app/views/myparlays.js exactly — not
 * "equivalently". A selection is a chain of tie-breaks:
 *
 *   - dialLegs picks ONE rung per player by distance to the target, ties to the
 *     higher line, and admits a game leg only inside an INCLUSIVE 0.15 band
 *     (|0.65 - 0.50| is 0.15000000000000002, so the tolerance is load-bearing);
 *   - the beam sorts partial cards by conviction with a STABLE sort, so ties
 *     decide which of two equally-convicted cards is offered;
 *   - conviction multiplies per-GAME groups in insertion order, and
 *     floating-point multiplication is not associative;
 *   - legFromPool clamps without rounding, while parlay_builder.make_leg rounds
 *     to 4dp — using make_leg in the port would move numbers in the 5th decimal
 *     and, through the sort, sometimes swap a card.
 *
 * Any one of those drifting produces a plausible-looking card that nobody was
 * offered. So both sides run the WHOLE pipeline — poolLegs -> upcomingLegs ->
 * dialLegs -> buildCards — over the same pools and the same seeds, and every
 * number on every card must agree to 1e-9.
 *
 * Two pools: the toy pool from r76_myparlays_search (small, fully understood) and
 * the COMMITTED data/leg_pool.json with `now` pinned to the pool's own
 * generated_utc — the moment the cards were offered — against the committed
 * schedule. Every team seed is swept at EVEN; SAFE, LONGSHOT and the player seeds
 * are sampled, which is the shape the runtime budget allows without weakening the
 * sweep that matters.
 *
 * Python is spawned ONCE with a payload FILE (`python3 -` reads its program from
 * stdin, so a payload written there would be parsed as source — the R76 lesson).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DIALS, buildCards, dialLegs, poolLegs, seedOptions, upcomingLegs,
} from '../../app/views/myparlays.js';
import { correlationTable } from '../../app/parlay-math.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const hasPool = existsSync(join(ROOT, 'data/leg_pool.json'));
const hasSchedule = existsSync(join(ROOT, 'data/schedule_full.json'));
const TABLE = correlationTable(readJson('data/parlay_backtest.json'));
const TOL = 1e-9;

/* The toy pool from r76_myparlays_search.test.mjs, copied rather than imported:
 * the two files lock different properties of the same fixture and a shared
 * import would let a change made for one silently rewrite the other's oracle. */
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

/* The toy pool names no schedule, so it gets one: both games upcoming at `now`,
 * which is what upcomingLegs is asked about. A minute-precision kickoff, like
 * data/schedule_full.json's, so the Python parser is exercised on that shape. */
const TOY_GAMES = [
  { game_id: 'G1', status: 'STATUS_SCHEDULED', kickoff_utc: '2026-09-22T00:15Z' },
  { game_id: 'G2', status: 'STATUS_SCHEDULED', kickoff_utc: '2026-09-22T17:00:30Z' },
];
const TOY_NOW = '2026-09-20T09:00:00Z';

/** The view's own pipeline, in one place, so both sides run the same chain. */
function jsCards(pool, games, nowIso, dial, seeds) {
  const legs = upcomingLegs(poolLegs(pool), games, Date.parse(nowIso));
  return buildCards(dialLegs(legs, DIALS[dial]), seeds, TABLE);
}

/** Only what a record has to reproduce: the ordered legs and every number. */
function shape(cards) {
  return cards.map((c) => ({
    selections: c.legs.map((l) => l.selection),
    model: c.model,
    implied: c.implied,
    ev: c.ev,
    tier: c.tier,
    payout: c.payout,
    same_game: c.sameGame,
    mixed_game: c.mixedGame,
  }));
}

/** Every case in ONE spawn: 50+ builds, and a process launch each would dominate. */
function pythonCards(payload) {
  const path = join(tmpdir(), `r87-parity-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(payload));
  const src = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts.models.my_cards import (
    DIALS, build_cards, dial_legs, pool_legs, upcoming_legs,
)
from scripts.models.parlay_builder import _correlation_table

payload = json.load(open(sys.argv[1], encoding="utf-8"))
corr = _correlation_table(json.load(open(payload["calib"], encoding="utf-8")))
pools = {"toy": (payload["toy_pool"], payload["toy_games"], payload["toy_now"])}
if payload.get("committed"):
    pool = json.load(open(payload["committed"]["pool"], encoding="utf-8"))
    sched = json.load(open(payload["committed"]["schedule"], encoding="utf-8"))
    pools["committed"] = (pool, sched["games"], pool["generated_utc"])

# poolLegs -> upcomingLegs is per POOL, not per case: the dial and the seeds are
# what vary, so the flatten happens once and every case reads the same objects
# (dial_legs compares rungs by identity, exactly as the view does).
eligible = {k: upcoming_legs(pool_legs(p), g, n) for k, (p, g, n) in pools.items()}
dialled = {}
out = []
for case in payload["cases"]:
    key = (case["pool"], case["dial"])
    if key not in dialled:
        dialled[key] = dial_legs(eligible[case["pool"]], DIALS[case["dial"]])
    cards = build_cards(dialled[key], case["seeds"], corr)
    out.append([{ "selections": [l["selection"] for l in c["legs"]],
                  "model": c["model"], "implied": c["implied"], "ev": c["ev"],
                  "tier": c["tier"], "payout": c["payout"],
                  "same_game": c["same_game"], "mixed_game": c["mixed_game"] }
                for c in cards])
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-', path], {
    input: src, cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  try { unlinkSync(path); } catch { /* best effort */ }
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** Assert one case's cards agree, number for number. */
function assertSameCards(label, js, py) {
  assert.equal(py.length, js.length, `${label}: ${js.length} cards in JS, ${py.length} in Python`);
  js.forEach((card, i) => {
    const p = py[i];
    assert.deepEqual(p.selections, card.selections,
      `${label} card ${i}: the legs offered differ\n  js ${card.selections.join(' + ')}\n  py ${p.selections.join(' + ')}`);
    for (const k of ['model', 'implied', 'ev', 'payout']) {
      assert.ok(Math.abs(p[k] - card[k]) < TOL,
        `${label} card ${i} ${k}: js ${card[k]} py ${p[k]}`);
    }
    assert.equal(p.tier, card.tier, `${label} card ${i} tier`);
    assert.equal(p.same_game, card.same_game, `${label} card ${i} same_game`);
    assert.equal(p.mixed_game, card.mixed_game, `${label} card ${i} mixed_game`);
  });
}

test('the Python mirror offers the same cards as the browser, number for number', () => {
  const cases = [];
  const expected = [];

  // ---- the toy pool: every seed at every dial, small enough to reason about --
  const toy = toyPool();
  const toyOptions = seedOptions(toy);
  for (const dial of ['safe', 'even', 'longshot']) {
    for (const seed of toyOptions.filter((o) => o.kind === 'team')) {
      cases.push({ pool: 'toy', dial, seeds: [seed], label: `toy ${dial} ${seed.name}` });
      expected.push(shape(jsCards(toy, TOY_GAMES, TOY_NOW, dial, [seed])));
    }
  }
  for (const seed of toyOptions.filter((o) => o.kind === 'player')) {
    cases.push({ pool: 'toy', dial: 'even', seeds: [seed], label: `toy even ${seed.name}` });
    expected.push(shape(jsCards(toy, TOY_GAMES, TOY_NOW, 'even', [seed])));
  }

  // ---- the committed pool, at the moment it was offered ---------------------
  let committed = null;
  /* THE EXPECTED SIZE OF THE COMMITTED SWEEP IS DERIVED FROM THE SLATE.
   *
   * This guard used to be `cards > 200`, a count measured on a full Sunday
   * slate. MY offers only legs whose game has not kicked off (R84
   * `upcomingLegs`), and R83 caps a card at TWO legs from any one game, so a
   * seed can be offered at most min(2*G - 1, 5) leg-count bands and twice that
   * many cards, where G is the number of games still to be played at `now`. On
   * the evening of 2026-09-20 fourteen of week 2's sixteen games had kicked off
   * before the pool was generated: G was 2, every live seed built 6 cards
   * instead of 10, and 28 of the 32 team seeds had no upcoming leg at all and
   * correctly built none. 76 cards, the pinned bar 200, red on main with no code
   * change -- the same fault tests/web/_myseed.mjs records for the MY browser
   * specs: never pin a number the calendar decides.
   *
   * So the bar is computed the same way _myseed computes EXPECTED_CARDS, and it
   * is a stronger claim than the old one: the EVEN sweep must find EXACTLY the
   * cards this slate can build for every seed that still has a leg to build
   * from (on a full slate that is 32 x 10 = 320, not "more than 200"), and at
   * least one seed must still be playable. */
  let expectedEvenTeamCards = null;
  let liveTeamSeeds = 0;
  let cardsPerLiveSeed = 0;
  if (!hasPool || !hasSchedule) {
    console.log('[r87 parity] SKIPPING the committed-pool half: data/leg_pool.json '
      + 'and/or data/schedule_full.json is absent on this checkout. The toy-pool '
      + 'half still ran; the real sweep did NOT.');
  } else {
    const pool = readJson('data/leg_pool.json');
    const games = readJson('data/schedule_full.json').games;
    const now = pool.generated_utc;
    const options = seedOptions(pool);
    const teams = options.filter((o) => o.kind === 'team');
    const players = options.filter((o) => o.kind === 'player');
    assert.ok(teams.length >= 30, `${teams.length} team seeds — expected the full league`);
    committed = { pool: join(ROOT, 'data/leg_pool.json'),
      schedule: join(ROOT, 'data/schedule_full.json') };

    const add = (dial, seed) => {
      cases.push({ pool: 'committed', dial, seeds: [seed], label: `pool ${dial} ${seed.name}` });
      expected.push(shape(jsCards(pool, games, now, dial, [seed])));
    };
    // THE SWEEP THAT MATTERS: every team seed at the default dial.
    const evenFrom = cases.length;
    for (const seed of teams) add('even', seed);
    // What this slate can build, from the same committed data the sweep reads.
    const eligible = upcomingLegs(poolLegs(pool), games, Date.parse(now));
    const upcomingGames = new Set(eligible.map((l) => l.game_id)).size;
    const playable = new Set(eligible.map((l) => l.team));
    cardsPerLiveSeed = 2 * Math.min((2 * upcomingGames) - 1, 5);
    liveTeamSeeds = teams.filter((s) => playable.has(s.name)).length;
    expectedEvenTeamCards = { from: evenFrom, to: cases.length,
      total: liveTeamSeeds * cardsPerLiveSeed, upcomingGames };
    // Sampled, spread across the list rather than clustered at its head.
    const sample = (rows, n) => Array.from({ length: n },
      (_, i) => rows[Math.floor((i * rows.length) / n)]).filter(Boolean);
    for (const seed of sample(teams, 6)) add('safe', seed);
    for (const seed of sample(teams, 6)) add('longshot', seed);
    for (const seed of sample(players, 6)) add('even', seed);
  }

  const py = pythonCards({
    calib: join(ROOT, 'data/parlay_backtest.json'),
    toy_pool: toy, toy_games: TOY_GAMES, toy_now: TOY_NOW,
    committed,
    cases: cases.map(({ pool, dial, seeds }) => ({ pool, dial, seeds })),
  });

  assert.equal(py.length, cases.length);
  let cards = 0;
  cases.forEach((c, i) => {
    assertSameCards(c.label, expected[i], py[i]);
    cards += expected[i].length;
  });
  // The sweep has to have found cards, or "they agree" means "both found none".
  assert.ok(cards > 10, `${cards} cards compared across ${cases.length} cases — the `
    + 'sweep found too few to prove anything');
  if (expectedEvenTeamCards) {
    const { from, to, total, upcomingGames } = expectedEvenTeamCards;
    assert.ok(upcomingGames > 0 && liveTeamSeeds > 0,
      `no week-${readJson('data/leg_pool.json').week} game was still upcoming when the `
      + 'committed pool was generated, so MY could offer nothing and the committed half '
      + 'of this sweep proves nothing');
    const swept = expected.slice(from, to).reduce((n, c) => n + c.length, 0);
    assert.equal(swept, total,
      `the EVEN team sweep compared ${swept} cards; this slate (${upcomingGames} game(s) `
      + `still upcoming, ${liveTeamSeeds} seed(s) with a leg left) can build exactly `
      + `${total} — ${cardsPerLiveSeed} per playable seed`);
  }
});
