/* R109 — A SPREAD FILLS ONLY AN EVEN CARD.
 *
 * Owner, 2026-10-04: "Improve the accuracy of all the parlays that will win" —
 * measure first, ship only a rule that raises the all-hit rate and calibration
 * and never regresses on a held-out week.
 *
 * A spread leg is priced at exactly 0.50 by policy (R51: the model holds no
 * opinion on a cover) and hit 42-45 % in every graded source. The risk dial
 * admitted it on SAFE (0.65) and LONGSHOT (0.35) from the band's INCLUSIVE edge,
 * and the conviction search filled LONGSHOT cards with it. Replayed over every
 * week-2/3 leg pool the pipeline committed (the recorded MY cards reproduce
 * exactly; the rule has no fitted parameter, so both weeks are held out):
 *
 *   LONGSHOT  wk2 43/1420 = 3.0 % -> 25/531 = 4.7 %   ratio 0.42 -> 0.63
 *             wk3  2/1851 = 0.1 % -> 26/1073 = 2.4 %  ratio 0.01 -> 0.29
 *   SAFE      identical both weeks;  EVEN  untouched (it keeps the spread)
 *
 * So the dial keeps a spread only where 0.50 IS the difficulty asked for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DIALS, GAME_LEG_BAND, SPREAD_DIAL_TARGET, buildCards, dialLegs, poolLegs, seedOptions,
  upcomingLegs,
} from '../../app/views/myparlays.js';
import { correlationTable } from '../../app/parlay-math.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const leg = (market, selection, p, extra = {}) => ({
  owner: `team:${selection.split(' ')[0]}`, selection, market, model_prob: p,
  implied_prob: 0.52, priced: true, game_id: 'G1', side: 'home',
  team: selection.split(' ')[0], ...extra,
});
const POOL = [
  leg('spread', 'AAA -3.5', 0.5),
  leg('moneyline', 'BBB ML', 0.5, { game_id: 'G2' }),
  leg('moneyline', 'CCC ML', 0.36, { game_id: 'G3' }),
];
const kept = (target) => dialLegs(POOL, target).map((l) => l.selection);

test('the rule: a 0.50 spread reaches EVEN only; a 0.50 moneyline keeps the band', () => {
  assert.equal(SPREAD_DIAL_TARGET, 0.5);
  assert.equal(GAME_LEG_BAND, 0.15, 'the band itself is unchanged');
  assert.deepEqual(kept(DIALS.even), ['AAA -3.5', 'BBB ML', 'CCC ML']);
  assert.deepEqual(kept(DIALS.longshot), ['BBB ML', 'CCC ML'],
    'LONGSHOT: the spread sat on the band edge and filled the cards; the 0.50 ML stays');
  assert.deepEqual(kept(DIALS.safe), ['BBB ML'],
    'SAFE: no spread; the 0.50 moneyline is still inside the inclusive edge');
});

test('Python records exactly what the browser offers (dial_legs parity, every dial)', () => {
  const out = execFileSync('python3', ['-'], {
    cwd: ROOT, encoding: 'utf8',
    input: `import json, sys\nsys.path.insert(0, ".")
from scripts.models import my_cards as M
pool = json.loads(${JSON.stringify(JSON.stringify(POOL))})
print(json.dumps({k: [l["selection"] for l in M.dial_legs(pool, t)] for k, t in M.DIALS.items()}))`,
  });
  const py = JSON.parse(out.trim().split('\n').pop());
  for (const [k, t] of Object.entries(DIALS)) assert.deepEqual(py[k], kept(t), k);
});

const hasData = existsSync(join(ROOT, 'data/leg_pool.json')) && existsSync(join(ROOT, 'data/schedule_full.json'));

test('on the committed pool: no SAFE or LONGSHOT card carries a spread', { skip: !hasData }, () => {
  const pool = readJson('data/leg_pool.json');
  const games = readJson('data/schedule_full.json').games;
  const table = correlationTable(readJson('data/parlay_backtest.json'));
  // the moment the pool was offered: every game not yet kicked off is in play
  const live = games.map((g) => ({ ...g, status: 'STATUS_SCHEDULED' }));
  const eligible = upcomingLegs(poolLegs(pool), live, pool.generated_utc);
  const seeds = seedOptions(pool).filter((s) => s.kind === 'team');
  let cards = 0;
  for (const dial of ['safe', 'longshot']) {
    const dialled = dialLegs(eligible, DIALS[dial]);
    assert.ok(!dialled.some((l) => l.market === 'spread'), `${dial}: a spread passed the dial`);
    for (const seed of seeds) {
      for (const card of buildCards(dialled, [seed], table)) {
        cards += 1;
        assert.ok(!card.legs.some((l) => l.market === 'spread'), `${dial} ${seed.name}: spread on a card`);
      }
    }
  }
  if (eligible.length) assert.ok(cards > 0, 'the sweep built cards — the property is exercised');
});
