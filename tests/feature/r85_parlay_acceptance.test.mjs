import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simulateMoney, simulationBreakdown } from '../../app/parlay-simulation.js';
import { buildCards, renderCard } from '../../app/views/myparlays.js';
import { renderParlayCard } from '../../app/render.js';
import { renderPay } from '../../app/review.js';

test('R85: independent stake/gross examples distinguish potential, loss, void and unavailable', () => {
  assert.equal(simulationBreakdown({ kind: 'potential', net_fair: 30.56 }), '$100 stake → $130.56 simulated gross if hit');
  assert.equal(simulationBreakdown({ kind: 'settled', net_fair: -100 }), '$100 stake → $0.00 simulated gross');
  assert.equal(simulationBreakdown({ kind: 'settled', net_fair: 0 }), '$100 stake → $100.00 simulated gross');
  for (const net_fair of [null, undefined, NaN, Infinity]) assert.match(simulationBreakdown({ net_fair }), /unavailable/);
});

test('R85: initial public card, graded review and MY disclose the same stake/gross meaning', () => {
  const legs = [0.5, 0.25].map((implied_prob, i) => ({ market: 'moneyline', selection: `T${i} ML`, model_prob: .6, implied_prob }));
  const sim = simulateMoney(legs);
  for (const html of [renderParlayCard({ legs, model_ev: 0 }), renderPay(sim),
    renderCard({ legs, model: .36, ev: 0, tier: 'low', payout: 700 }, 0)]) {
    assert.match(html, /pay-detail/);
    assert.match(html, /\$100 stake → \$800.00 simulated gross if hit/);
  }
});

test('R85: incident DET fixture explains the $31; no fabricated payout uplift', () => {
  // Pin the reported card itself so future generated pools do not invalidate the oracle.
  const incident = JSON.parse(readFileSync(new URL('../../docs/qa/RCA_R84_EVIDENCE.json', import.meta.url))).money[8];
  const legs = incident.legs.map(l => ({ ...l, implied_prob: l.implied, model_prob: l.model }));
  assert.equal(simulateMoney(legs).net_fair, 30.56);
  assert.equal(simulationBreakdown(simulateMoney(legs)), '$100 stake → $130.56 simulated gross if hit');
  const html = renderCard({ legs, model: incident.model, ev: incident.ev, tier: 'low', payout: incident.net }, 0);
  assert.match(html, /model probability × 1.045/);
  assert.match(html, /not a book price/);
  assert.match(html, /Higher hit-probability lines produce lower simulated returns/);
  assert.match(html, /59%<span class="k">CONVICTION/);
  assert.doesNotMatch(html, /class="ev ev--neg"/, 'negative simulated EV must not color the model hit probability');
});

test('R85: MY prioritizes model hit chance; repricing cannot change selections or ranking', () => {
  const legs = [.95, .85, .75, .65, .55, .45, .35].map((p, i) => ({
    owner: `p${i}`, player: `Player ${i}`, selection: `Player ${i} 20+`,
    game_id: `g${i}`, market: 'wr_rec_yds', model_prob: p, implied_prob: p * 1.045,
  }));
  const seeds = [{ kind: 'player', id: 'p0', name: 'Player 0' }];
  const before = buildCards(legs, seeds, null);
  const after = buildCards(legs.map((l, i) => ({ ...l, implied_prob: .1 + i * .1 })), seeds, null);
  const ranking = cards => cards.map(c => ({ model: c.model, selections: c.legs.map(l => l.selection) }));
  assert.deepEqual(ranking(before), ranking(after));
  assert.equal(before[0].model, .95 * .85);
  assert.notEqual(before[0].payout, after[0].payout, 'money is display-only, not silently ignored or fed into ranking');
  for (let n = 2; n <= 6; n++) {
    const cards = before.filter(c => c.legs.length === n);
    assert.ok(cards.length);
    assert.ok(cards.every((c, i) => i === 0 || cards[i - 1].model >= c.model));
  }
});
