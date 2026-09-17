import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { combineTwo, correlationTable, legFromGame, pairRho } from '../../app/parlay-math.js';
import { conviction, poolLegs, renderCard, scoreCard } from '../../app/views/myparlays.js';

const ROOT = new URL('../../', import.meta.url);
const TABLE = correlationTable({ correlations: { pairs: [], default_rho: 0.1 } });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${actual} != ${expected}`);
const py = (source) => {
  const result = spawnSync('python3', ['-'], { cwd: ROOT, input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const leg = (game_id, side, model_prob, market = 'wr_rec_yds') => ({
  game_id, side, model_prob, market, corr_tag: market, implied_prob: 0.7,
  selection: `${game_id} ${side} ${market}`, priced: false,
});

test('R83: the producer → serialized slate → pool → JS round trip preserves game side', () => {
  const result = py(`
import json
from scripts.models.parlay_builder import make_leg, _strip_leg
from scripts.build_leg_pool import game_legs_from_slate
from scripts.validate_data import validate_against_schema
made = make_leg('moneyline', 'BUF ML', .6, .62, side='home')
clean = json.loads(json.dumps(_strip_leg(made)))
for path in ('parlays', 'parlays_archive'):
    with open('data/contracts/' + path + '.schema.json') as fh:
        schema = json.load(fh)['properties']['parlays']['items']['properties']['legs']['items']
    validate_against_schema(clean, schema, path + ' leg')
doc = {'parlays': [{'game_id': 'BUF-DET', 'legs': [clean]}]}
pool = game_legs_from_slate(doc, {'BUF': 'BUF-DET'})
print(json.dumps({'clean': clean, 'pool': pool}))
`);
  assert.equal(result.clean.side, 'home');
  assert.equal('_side' in result.clean, false);
  const ml = legFromGame(result.pool[0]);
  assert.equal(ml.side, 'home');
  assert.equal(ml.team, 'BUF');
  assert.equal(ml.game_id, 'BUF-DET');
  const goff = leg('BUF-DET', 'away', 0.8, 'qb_pass_yds');
  near(pairRho(ml, goff, TABLE), -0.1);
  near(conviction([ml, goff], TABLE), 0.48 - 0.1 * Math.sqrt(0.6 * 0.4 * 0.8 * 0.2));
});

test('R83: old game legs resolve side from a player with the same team AND event', () => {
  const player = { gsis_id: 'p1', player: 'A Player', team: 'BUF', game_id: 'g1',
    side: 'home', market: 'wr_rec_yds', rungs: [] };
  const old = { market: 'moneyline', selection: 'BUF ML', team: 'BUF',
    game_id: 'g1', model_prob: 0.6, implied_prob: 0.62 };
  const resolved = poolLegs({ players: [player], game_legs: [old] });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].side, 'home');
  assert.deepEqual(poolLegs({ players: [{ ...player, game_id: 'other' }], game_legs: [old] }), []);
  assert.deepEqual(poolLegs({ players: [player, { ...player, side: 'away' }], game_legs: [old] }), []);
  assert.deepEqual(poolLegs({ players: [], game_legs: [{ ...old, side: 'home', game_id: null }] }), []);
  assert.deepEqual(poolLegs({ players: [player], game_legs: [{ ...old, side: 'away' }] }), []);
});

test('R83: pool generation recovers legacy side only from the matching event and rejects conflicts', () => {
  const result = py(`
import json
from scripts.build_leg_pool import build, load_inputs, game_legs_from_slate
from scripts.validate_data import validate_against_schema
old = {'market': 'moneyline', 'selection': 'BUF ML', 'model_prob': .6, 'implied_prob': .62}
doc = {'parlays': [{'game_id': 'g1', 'legs': [old]}]}
recovered = game_legs_from_slate(doc, {'BUF': 'g1'}, {'BUF': 'home'})
wrong_event = game_legs_from_slate(doc, {'BUF': 'g2'}, {'BUF': 'away'})
new = dict(old, side='home')
both = {'parlays': doc['parlays'] + [{'game_id': 'g1', 'legs': [new]}]}
preferred = game_legs_from_slate(both)
try:
    game_legs_from_slate(both, {'BUF': 'g1'}, {'BUF': 'away'})
    conflict = False
except ValueError:
    conflict = True
inputs = load_inputs()
pool = build(inputs)
with open('data/contracts/leg_pool.schema.json') as fh:
    validate_against_schema(pool, json.load(fh), 'new pool')
print(json.dumps({'recovered': recovered, 'wrong_event': wrong_event,
                  'preferred': preferred, 'conflict': conflict,
                  'games': pool['game_legs']}))
`);
  assert.equal(result.recovered[0].side, 'home');
  assert.equal(result.wrong_event[0].side, null);
  assert.equal(result.preferred.length, 1);
  assert.equal(result.preferred[0].side, 'home');
  assert.equal(result.conflict, true);
  assert.ok(result.games.length > 0);
  for (const g of result.games) {
    assert.ok(g.game_id && g.team, g.selection);
    assert.ok(['home', 'away'].includes(g.side), g.selection);
  }
});

test('R83: an unrelated game cannot erase correlation inside an existing pair', () => {
  for (const side of ['home', 'away']) {
    const a = leg('g1', 'home', 0.8);
    const b = leg('g1', side, 0.6, 'qb_pass_yds');
    const c = leg('g2', 'home', 0.7);
    const rho = side === 'home' ? 0.1 : -0.1;
    const expected = (0.8 * 0.6 + rho * Math.sqrt(0.8 * 0.2 * 0.6 * 0.4)) * 0.7;
    for (const legs of [[a, b, c], [c, b, a], [b, c, a]]) {
      near(conviction(legs, TABLE), expected);
      const card = scoreCard(legs, TABLE);
      near(card.model, expected);
      near(card.implied, 0.7 ** 3);
      assert.equal(card.sameGame, false);
      assert.equal(card.mixedGame, true);
      assert.match(renderCard(card, 0), /MIXED GAMES/);
    }
  }
});

test('R83: two same-game pairs are combined as independent event groups', () => {
  const a = leg('g1', 'home', 0.8);
  const b = leg('g1', 'away', 0.6, 'qb_pass_yds');
  const c = leg('g2', 'home', 0.7);
  const d = leg('g2', 'home', 0.5, 'rb_rush_yds');
  near(conviction([a, c, b, d], TABLE),
    combineTwo(0.8, 0.6, -0.1) * combineTwo(0.7, 0.5, 0.1));
  const independent = [a, { ...b, game_id: 'g3' }, c];
  near(conviction(independent, TABLE), 0.8 * 0.6 * 0.7);
  assert.equal(scoreCard(independent, TABLE).mixedGame, false);
  assert.equal(scoreCard([a, b], TABLE).sameGame, true);
  assert.equal(conviction([], TABLE), 0);
});

test('R83: Python and JS respect BOTH two-event Frechet bounds, including certainty', () => {
  const cases = [];
  for (const p of [0, 0.05, 0.5, 0.9, 1]) {
    for (const q of [0, 0.1, 0.6, 0.9, 1]) {
      for (const rho of [-0.95, 0, 0.95]) cases.push([p, q, rho]);
    }
  }
  const python = py(`
import json
from scripts.models.parlay_builder import _combine_two
print(json.dumps([_combine_two(*c) for c in ${JSON.stringify(cases)}]))
`);
  cases.forEach(([p, q, rho], i) => {
    const got = combineTwo(p, q, rho);
    assert.ok(got >= Math.max(0, p + q - 1) - 1e-12);
    assert.ok(got <= Math.min(p, q) + 1e-12);
    near(got, combineTwo(q, p, rho));
    near(got, python[i]);
    if (rho === 0) near(got, p * q);
  });
  near(combineTwo(0.9, 0.9, -0.95), 0.8);
});
