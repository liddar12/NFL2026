/* tests/feature/r126_game_card_ranking.test.mjs — R126: a game card is the pair
 * most likely to hit, and the flat-priced spread is a fallback, not a filler.
 *
 * 2026-10-15 parlay-accuracy RCA, on the frozen pre-kickoff game cards of weeks 1-5
 * (same candidate legs, graded on the real results): the builder ranked pairs by
 * |rho| first, which after R74 filled the slot with opposite-side pairs (7/34 hit
 * against 19/45 for same-side ML + back), and it shipped the spread leg priced at
 * exactly 0.5 on the model's favourite, which covered 48/119 legs in 2026. As built
 * 74/235 = 0.315; ranked by joint probability with the spread as a fallback only,
 * 83/233 = 0.356.
 *
 * Locked here: the cards are the top three pairs by joint model probability (the
 * correlation included), in that order; a spread leg ships only when the game cannot
 * field three distinct pairs without it; R74's one-leg-per-side rule still holds; the
 * build is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PY = `
import json, sys, itertools
sys.path.insert(0, ".")
from scripts.models import parlay_builder as pb

corr = pb._correlation_table(pb.load_calibration(pb.DEFAULT_CALIBRATION_PATH))

def prop(market, sel, p, side):
    return {"market": market, "selection": sel, "model_prob": p,
            "_corr_tag": market, "_side": side}

game = {"game_id": "g1", "home": "KC", "away": "DEN", "probs": {"home": 0.80, "away": 0.20}}
market = {"spread": {"home_cover_prob": 0.5, "away_cover_prob": 0.5, "home_point": -7.5,
                     "home_selection": "KC -7.5", "away_selection": "DEN +7.5"}}
# The QB+WR pair carries the strongest prop correlation in the table but both legs
# are long shots; the away back is the likeliest prop on the board.
props = [prop("qb_pass_yds", "P. Mahomes 225+ pass yds", 0.40, "home"),
         prop("wr_rec_yds", "R. Rice 60+ rec yds", 0.45, "home"),
         prop("rb_rush_yds", "J. Williams 60+ rush yds", 0.70, "away")]

def joint(legs):
    return pb._combined_probs([dict(l, _corr_tag=l["market"], _side=l.get("side")) for l in legs],
                              correlated=True, corr=corr)[0]

cards = pb.build_game_parlays(game, market=market, props=props)
again = pb.build_game_parlays(game, market=market, props=props)

# every legal non-spread pair, by joint probability -- the oracle
cand = pb.derive_candidate_legs(game, market=market, props=props)
pool = [l for l in cand if l["market"] != "spread"]
pairs = []
for a, b in itertools.combinations(pool, 2):
    if pb.same_side_game_pair(a, b):
        continue
    pairs.append((pb._combined_probs([a, b], correlated=True, corr=corr)[0],
                  sorted([a["selection"], b["selection"]])))
pairs.sort(key=lambda t: -t[0])

# a game that cannot field three pairs without its spread: ML + one prop
thin = pb.build_game_parlays(game, market=market,
                             props=[prop("wr_rec_yds", "R. Rice 60+ rec yds", 0.55, "home")])

print(json.dumps({
    "cards": [{"sels": sorted(l["selection"] for l in c["legs"]),
               "markets": [l["market"] for l in c["legs"]],
               "joint": joint(c["legs"])} for c in cards],
    "oracle": [{"sels": s, "joint": p} for p, s in pairs[:3]],
    "deterministic": cards == again,
    "thin": [{"sels": sorted(l["selection"] for l in c["legs"]),
              "markets": [l["market"] for l in c["legs"]]} for c in thin],
}))
`;

const run = () => JSON.parse(execFileSync('python3', ['-c', PY], { cwd: ROOT, encoding: 'utf8' }));

test('R126: the game cards are the three pairs most likely to hit, in that order', () => {
  const r = run();
  assert.equal(r.cards.length, 3);
  assert.deepEqual(r.cards.map((c) => c.sels), r.oracle.map((o) => o.sels),
    'the cards are exactly the top three legal pairs by joint model probability');
  for (let k = 1; k < r.cards.length; k += 1) {
    assert.ok(r.cards[k - 1].joint >= r.cards[k].joint - 1e-12, 'most likely first');
  }
  // |rho| first would have opened with the correlated long shots (QB + WR).
  assert.notDeepEqual(r.cards[0].sels, ['P. Mahomes 225+ pass yds', 'R. Rice 60+ rec yds'].sort());
  assert.equal(r.deterministic, true);
});

test('R126: a spread leg ships only when the game cannot field three pairs without it', () => {
  const r = run();
  assert.ok(r.cards.every((c) => !c.markets.includes('spread')),
    'three legal non-spread pairs exist, so no card carries the 0.5-priced spread');
  // ML + one prop: one non-spread pair, so the spread comes back as the fallback.
  assert.equal(r.thin.length, 3, 'the >=3-per-game invariant holds');
  assert.ok(r.thin.some((c) => c.markets.includes('spread')), 'the fallback is used');
  for (const c of r.thin) {
    assert.ok(!(c.markets.includes('moneyline') && c.markets.includes('spread')),
      'R74: a moneyline and its own spread are never one card');
  }
});
