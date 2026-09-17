// Read-only, offline review reproductions. Run from any cwd with Node >= 22.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { poolLegs, buildCards, scoreCard, seedOptions } from '../../../app/views/myparlays.js';
import { correlationTable, combinedProbs, combineTwo, pairRho, legFromGame,
  impliedFromModel, confidenceTier } from '../../../app/parlay-math.js';
import { renderParlayCard } from '../../../app/render.js';
import { loadJson, clearCache } from '../../../app/data.js';
const read = (name) => JSON.parse(fs.readFileSync(new URL(`../../../data/${name}`, import.meta.url)));
const pool = read('leg_pool.json');
const legs = poolLegs(pool);
const table = correlationTable(read('parlay_backtest.json'));
const schedule = read('schedule_full.json');
const games = new Map(schedule.games.map((g) => [String(g.game_id), g]));
const findings = {};

const ml = legs.find((l) => l.selection === 'BUF ML');
const side = games.get(ml.game_id).home === ml.team ? 'home' : 'away';
const opposing = legs.find((l) => !l.priced && l.game_id === ml.game_id && l.side !== side);
assert.equal(ml.side, null);
findings.game_side_loss = {
  selection: ml.selection, actual_side: ml.side, expected_side: side,
  opposing_prop: opposing.selection, current_rho: pairRho(ml, opposing, table),
  corrected_rho: pairRho({ ...ml, side }, opposing, table),
  current_joint: scoreCard([ml, opposing], table).model,
  corrected_joint: scoreCard([{ ...ml, side }, opposing], table).model,
  affected_game_legs: legs.filter((l) => l.priced && l.side === null).length,
};

const cards = buildCards(legs, [seedOptions(pool)[0]], table);
const mixed = cards.find((c) => {
  const groups = new Set(c.legs.map((l) => l.game_id));
  return groups.size > 1 && groups.size < c.legs.length;
});
assert.ok(mixed);
const groups = Map.groupBy(mixed.legs, (l) => l.game_id);
findings.mixed_game_correlation = {
  legs: mixed.legs.map((l) => ({ selection: l.selection, game_id: l.game_id })),
  current: mixed.model,
  grouped_using_existing_pair_math: [...groups.values()].reduce((p, g) => p * combinedProbs(g, true, table)[0], 1),
};

const a = { model_prob: .8, implied_prob: .84, corr_tag: 'a', side: 'home', game_id: 'g1' };
const b = { ...a, model_prob: .6, implied_prob: .63, corr_tag: 'b' };
const c = { ...a, model_prob: .7, implied_prob: .735, corr_tag: 'c' };
findings.order_dependence = [[a,b,c], [b,c,a], [c,a,b]].map((ls) => combinedProbs(ls, true, table)[0]);
assert.ok(new Set(findings.order_dependence).size > 1);
findings.frechet_violation = { current: combineTwo(.9,.9,-.95), required_minimum: .8 };
assert.ok(findings.frechet_violation.current < .8);

const synthetic = legFromGame({market:'moneyline',selection:'TEST ML',model_prob:.6,implied_prob:impliedFromModel(.6)});
findings.synthetic_price_claimed_real = { supplied: 'model * 1.045', priced: synthetic.priced };
assert.equal(synthetic.priced, true);
findings.tier_changes_without_model_change = [.3,.47,.55].map((price) => ({ model:.6, price, tier:confidenceTier(.6,price,3) }));

const names = new Map(seedOptions(pool).map((s) => [s.name.toLowerCase(),s]));
findings.placeholder_rejected = { placeholder:'J. Jefferson', accepted:names.has('j. jefferson'), full_name_accepted:names.has('justin jefferson') };
assert.equal(findings.placeholder_rejected.accepted,false);
assert.equal(findings.placeholder_rejected.full_name_accepted,true);
const doc = read('parlays.json');
findings.moneyline_label = renderParlayCard(doc.parlays.find((p) => p.legs.some((l) => l.market === 'moneyline'))).match(/[^<>]*ML ML[^<>]*/g);
assert.ok(findings.moneyline_label);

let calls = 0;
const originalFetch = globalThis.fetch;
try {
  clearCache();
  globalThis.fetch = async () => ({ ok:true, json:async () => ({ version:++calls }) });
  const first = await loadJson('/review-only-fixture');
  const second = await loadJson('/review-only-fixture');
  findings.session_cache = { first, second, fetch_calls:calls };
  assert.equal(calls,1);
} finally { globalThis.fetch = originalFetch; clearCache(); }

let lockCount = 0; const late = [], changed = [];
for (const name of fs.readdirSync(new URL('../../../data/snapshots/',import.meta.url)).filter((f) => f.endsWith('_games_open.json'))) {
  for (const row of read(`snapshots/${name}`)) {
    lockCount++;
    const g = games.get(String(row.event_id));
    if (!g) continue;
    if (row.locked_utc >= g.kickoff_utc) late.push(row.event_id);
    if (row.resolved && Math.abs(row.probs[0]-g.probs.home)>.001) changed.push({game_id:g.game_id,home:g.home,away:g.away,locked:row.probs[0],display:g.probs.home});
  }
}
findings.historical_slate = { lock_count:lockCount, late_committed_locks:late, changed_resolved_probabilities:changed };
console.log(JSON.stringify(findings,null,2));
