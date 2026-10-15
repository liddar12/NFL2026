import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { summarizePortfolio, renderPortfolioRisk } from '../../app/portfolio-risk.js';
import { availabilityOf, renderAvailChip } from '../../app/availability.js';
import { teamWeekPoints } from '../../app/grade-weekly.js';

const root = new URL('../../', import.meta.url);
const py = (code) => JSON.parse(execFileSync('python3', ['-c', code], { cwd: root, encoding: 'utf8' }));
const leg = (team, p, game = 'g1') => ({ market: 'moneyline', selection: `${team} ML`, model_prob: p, game_id: game });
const schedule = [{ game_id: 'g1', home: 'A', away: 'B', week: 6 }, { game_id: 'g2', home: 'C', away: 'D', week: 6 }];

test('identical shared outcome is one risk event, not independent cards', () => {
  const cards = Array.from({ length: 18 }, () => ({ legs: [leg('A', .8)] }));
  const risk = summarizePortfolio(cards, schedule, 6);
  assert.ok(Math.abs(risk.pZeroWinners - .2) < 1e-12);
  assert.equal(risk.maxExposure, 18);
  assert.match(renderPortfolioRisk(risk), /defeats every shown card/);
  assert.match(renderPortfolioRisk(risk), /selection has not been diversified/);
});

test('mixed vintages, opposite sides, invalid p and same-game props never fake independence', () => {
  for (const other of [leg('A', .7), leg('B', .2), leg('A', null), leg('A', NaN),
    { ...leg('A', .8), market: 'qb_pass_yds', selection: 'QB 200+' }]) {
    const risk = summarizePortfolio([{ legs: [leg('A', .8)] }, { legs: [other] }], schedule, 6);
    assert.equal(risk.pZeroWinners, null);
    assert.equal(risk.maxExposure, 2);
  }
  const mismatch = summarizePortfolio([{ legs: [leg('C', .8)] }], schedule, 6);
  assert.equal(mismatch.reason, 'selection_event_mismatch');
});

test('shared selection text does not claim a verified shared game when event evidence is missing', () => {
  const risk = summarizePortfolio([{ legs: [leg('A', .8)] }, { legs: [leg('A', .8)] }], [], 6);
  assert.equal(risk.pZeroWinners, null);
  assert.equal(risk.reason, 'event_identity_unverified');
  assert.match(renderPortfolioRisk(risk), /2\/2 share one selection/);
  assert.doesNotMatch(renderPortfolioRisk(risk), /share one game/);
});

test('Python and browser agree on the committed offered Week set without changing it', () => {
  const doc = JSON.parse(readFileSync(new URL('../../data/parlays.json', import.meta.url), 'utf8'));
  const sched = JSON.parse(readFileSync(new URL('../../data/schedule_full.json', import.meta.url), 'utf8'));
  const risk = summarizePortfolio(doc.parlays.filter((c) => c.scope === 'week'), sched.games, doc.week);
  const result = py("import json; from scripts.evaluate_week_portfolio import compare_week_portfolios; print(json.dumps(compare_week_portfolios(json.load(open('data/game_predictions.json')),json.load(open('data/parlays.json')))))");
  assert.ok(Math.abs(risk.pZeroWinners - result.active.p_zero_winners) < 1e-10);
  assert.ok(Math.abs(risk.expectedWinners - result.active.expected_winners) < 1e-10);
  assert.equal(result.state, 'shadow_only_not_served');
});

test('constrained selector enforces cap, quotas, uniqueness and deterministic input ordering', () => {
  const result = py(`import json
from scripts.models.portfolio import select_constrained
events=[dict(event_id=str(i),selection=str(i),probability=.9-i*.02) for i in range(14)]
a=select_constrained(events)
b=select_constrained(list(reversed(events)))
print(json.dumps(dict(a=a,same=a==b)))`);
  assert.equal(result.same, true);
  assert.equal(result.a.complete, true);
  assert.equal(result.a.offered_cards.length, 18);
  assert.ok(result.a.risk.max_cards_lost_from_one_selection <= 9);
  const combos = result.a.offered_cards.map((c) => [...c.event_ids].sort().join('|'));
  assert.equal(new Set(combos).size, 18);
  for (const size of [2, 3, 4, 5, 6, 7]) assert.equal(result.a.offered_cards.filter((c) => c.event_ids.length === size).length, 3);
});

test('impossible cap never returns a completed diversified set or duplicated filler', () => {
  const result = py(`import json
from scripts.models.portfolio import select_constrained
events=[dict(event_id=str(i),probability=.8) for i in range(9)]
print(json.dumps(select_constrained(events,max_event_share=.4)))`);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'insufficient_event_capacity');
  assert.deepEqual(result.offered_cards, []);
});

test('portfolio diagnostics refuse mixed events and do not invent exact risk past the bound', () => {
  const result = py(`import json
from scripts.models.portfolio import portfolio_risk
bad=False
try: portfolio_risk([dict(event_id='a',probability=.8),dict(event_id='a',probability=.7)],[])
except ValueError: bad=True
events=[dict(event_id=str(i),probability=.8) for i in range(17)]
cards=[dict(card_id=str(i),event_ids=[str(i)]) for i in range(17)]
print(json.dumps(dict(bad=bad,risk=portfolio_risk(events,cards))))`);
  assert.equal(result.bad, true);
  assert.equal(result.risk.p_zero_winners, null);
  assert.equal(result.risk.reason, 'event_limit_exceeded');
});

test('stale-source eligibility is visible and does not claim zero points or alter another week', () => {
  const row = { availability: { status: 'OUT', class: 'week' }, weeks: [{ wk: 6, pts: 17 }],
    eligibility: { eligible: false, reason: 'source_unverified', week: 6, detail: 'stale_report' } };
  const av = availabilityOf(row, 6, 6);
  // Withholding offers is not benching: LINEUP and GRADE read playable:false as 0 points.
  assert.equal(av.playable, true);
  assert.equal(av.unverified, true);
  assert.equal(av.label, 'STATUS UNVERIFIED');
  assert.match(renderAvailChip(av), /not a prediction of zero points/);
  assert.equal(row.weeks[0].pts, 17);
  assert.equal(availabilityOf(row, 5, 6).playable, true);
});

test('shared prop eligibility refuses source uncertainty for only the applicable week', () => {
  const result = py(`import json
from scripts.models.parlay_builder import playable_this_week
r={'eligibility':{'eligible':False,'week':6},'weeks':[{'wk':5,'pts':20},{'wk':6,'pts':17}]}
print(json.dumps([playable_this_week(r,6),playable_this_week(r,5),playable_this_week(r)]))`);
  assert.deepEqual(result, [false, true, false]);
});

test('retirement renders without an invented IR floor', () => {
  const av = availabilityOf({ availability: { status: 'RETIRED', class: 'season' }, weeks: [] }, 6, 6);
  assert.equal(av.playable, false);
  assert.equal(av.label, 'RETIRED');
  assert.equal(av.durText, '');
  assert.doesNotMatch(renderAvailChip(av), /LEAGUE MIN|4.*WKS/);
});

test('an unverified starter keeps his projection and his slot over a bye-week player', () => {
  const weeks = (byeWk) => Array.from({ length: 18 }, (_, i) => ({
    wk: i + 1, bye: i + 1 === byeWk, pts: i + 1 === byeWk ? 0 : 10 }));
  const weekly = new Map([
    ['wrA', { gsis_id: 'wrA', receptions_prior: 0, weeks: weeks(9),
      eligibility: { eligible: false, reason: 'source_unverified', week: 6, detail: 'stale_report' } }],
    ['wrB', { gsis_id: 'wrB', receptions_prior: 0, weeks: weeks(6) }],
  ]);
  const r = teamWeekPoints({
    rosterPlayers: [{ gsis_id: 'wrA', name: 'WR A', position: 'WR', proj_points: 170 },
      { gsis_id: 'wrB', name: 'WR B', position: 'WR', proj_points: 170 }],
    week: 6, profile: { shape: { roster_positions: ['WR', 'BN'] } }, weeklyById: weekly,
    kdstIndex: null, feeds: [], currentWk: 6,
  });
  assert.equal(r.lineup.slots.WR1, 'wrA', 'the bye-week player never takes the slot');
  assert.deepEqual(r.unavailable, []);
  assert.ok(r.rows.find((x) => x.id === 'wrA').pts > 0, 'an unverified source is not a zero projection');
});

test('cards that share no selection are not described as shared risk', () => {
  const risk = summarizePortfolio([{ legs: [leg('A', .6, 'g1')] }, { legs: [leg('C', .7, 'g2')] }], schedule, 6);
  assert.equal(renderPortfolioRisk(risk), '');
});
