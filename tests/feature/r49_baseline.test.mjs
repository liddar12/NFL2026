/* tests/feature/r49_baseline.test.mjs — R49 Deliverable A: the games-normalized
 * baseline (owner's pick, one rule for everyone) and where it applies.
 *
 *   baseline = prior_ppg x projected_games
 *   prior_ppg       = recency-weighted (2:1) PPR per game played over the last two
 *                     prior seasons (games = player_history seasons.games / ESPN
 *                     statId 210, the same entry that carries the season total)
 *   projected_games = 17 - DOCUMENTED expected absence; unknown is NOT a discount
 *
 * THE GATE DECIDED WHAT SHIPS. scripts/backtest_player.py measured the rule
 * against the raw total on the 2022-2025 walk-forward: pooled rank-corr up,
 * pooled MAE down (worse). Under never-regress the rule therefore does NOT
 * replace the shipped proj_points; it ships as the baseline of the CANDIDATE
 * estimate (candidate_points, every raw signal at full strength), which the
 * estimate ledger backtests weekly. These locks pin BOTH halves: the rule's
 * arithmetic (driven through the deployed engine under the rule explicitly),
 * and the shipped default staying the total rule until the gate flips.
 *
 * Node built-ins only; python3 is already a fast-gate dependency.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const PRELUDE = `
from scripts.models import player_projection as pp
def rec(**kw):
    base = {"gsis_id": "x", "name": "A Player", "team": "BAL", "position": "QB"}
    base.update(kw)
    return base
def under_rule(r):
    return pp.project_player(r, ctx=None, weights=None, baseline_rule=pp.BASELINE_RULE_PPG)
`;

test('a 13-game 300-point prior projects to 300/13*17 when no absence is documented', () => {
  const r = py(`${PRELUDE}
out = under_rule(rec(prior_season_points=300.0, prior_games=13))
print(json.dumps(out))`);
  assert.equal(r.baseline_rule, 'prior_ppg_x_projected_games');
  assert.equal(r.prior_games, 13);
  assert.equal(r.projected_games, 17);
  assert.equal(r.absence_weeks, 0);
  assert.ok(Math.abs(r.prior_ppg - 300 / 13) < 1e-3, `prior_ppg ${r.prior_ppg}`);
  assert.ok(Math.abs(r.proj_points - (300 / 13) * 17) < 0.02, `got ${r.proj_points}`);
  // auditable: the number IS the identity of the fields carried on the row
  assert.ok(Math.abs(r.prior_ppg * r.projected_games - r.proj_points) < 0.02);
});

test('a documented 4-week absence projects x13 (17 - 4), at the same per-game rate', () => {
  const r = py(`${PRELUDE}
out = under_rule(rec(prior_season_points=300.0, prior_games=13, absence_weeks=4))
print(json.dumps(out))`);
  assert.equal(r.projected_games, 13);
  assert.equal(r.absence_weeks, 4);
  assert.ok(Math.abs(r.proj_points - (300 / 13) * 13) < 0.02, `got ${r.proj_points}`);
  assert.ok(Math.abs(r.proj_points - 300) < 0.02);
});

test('a 17-game player is unchanged by the rule', () => {
  const r = py(`${PRELUDE}
a = under_rule(rec(prior_season_points=340.0, prior_games=17))
b = pp.project_player(rec(prior_season_points=340.0, prior_games=17))
print(json.dumps({"ppg_rule": a["proj_points"], "total_rule": b["proj_points"],
                  "cand": a["candidate_baseline"]}))`);
  assert.equal(r.ppg_rule, 340);
  assert.equal(r.total_rule, 340);
  assert.equal(r.cand, 340);
});

test('unknown status and unknown games are NOT a discount', () => {
  const r = py(`${PRELUDE}
no_games = under_rule(rec(prior_season_points=300.0))                      # no game count
unknown_status = under_rule(rec(prior_season_points=300.0, prior_games=13,
                                injury_status="some new espn spelling"))  # unmapped tag
ir_no_duration = under_rule(rec(prior_season_points=300.0, prior_games=13,
                                injury_status="IR"))                      # status alone
print(json.dumps({
  "no_games": no_games["proj_points"], "no_games_rule": no_games["baseline_rule"],
  "no_games_pg": no_games["projected_games"],
  "unknown_status": unknown_status["proj_points"], "unknown_pg": unknown_status["projected_games"],
  "ir_no_duration": ir_no_duration["proj_points"], "ir_pg": ir_no_duration["projected_games"],
}))`);
  // no game count -> the rule cannot apply; falls back to the total, says so
  assert.equal(r.no_games, 300);
  assert.equal(r.no_games_rule, 'prior_season_points');
  assert.equal(r.no_games_pg, null);
  // an unmapped status changes nothing about projected games
  assert.equal(r.unknown_pg, 17);
  assert.ok(Math.abs(r.unknown_status - (300 / 13) * 17) < 0.02);
  // a status WITHOUT a stamped absence (the absence comes from the injury
  // report through build_predictions._stamp_absence, never from the tag alone)
  assert.equal(r.ir_pg, 17);
  assert.ok(Math.abs(r.ir_no_duration - (300 / 13) * 17) < 0.02);
});

test('recency weighting: 2:1 over the last two prior seasons, per game played', () => {
  const r = py(`${PRELUDE}
out = under_rule(rec(prior_season_points=214.86, prior_games=13,
                     prior_seasons=[{"yr": 2025, "pts": 214.86, "games": 13},
                                    {"yr": 2024, "pts": 430.0, "games": 17},
                                    {"yr": 2023, "pts": 999.0, "games": 17}]))
print(json.dumps(out))`);
  const want = ((2 * 214.86) / 13 + (1 * 430) / 17) / 3;
  assert.ok(Math.abs(r.prior_ppg - want) < 1e-3, `prior_ppg ${r.prior_ppg} vs ${want}`);
  assert.ok(Math.abs(r.proj_points - want * 17) < 0.05);
  assert.equal(r.prior_games, 13, 'prior_games is the most recent season');
});

test('the SHIPPED default is the total rule until the gate flips; the candidate always uses the R49 rule', () => {
  const r = py(`${PRELUDE}
out = pp.project_player(rec(prior_season_points=300.0, prior_games=13, absence_weeks=4))
print(json.dumps({"shipped_rule": pp.SHIPPED_BASELINE_RULE, "row_rule": out["baseline_rule"],
                  "proj": out["proj_points"], "cand_base": out["candidate_baseline"],
                  "cand": out["candidate_points"], "pg": out["projected_games"],
                  "lo": out["candidate_low"], "hi": out["candidate_high"]}))`);
  const gate = JSON.parse(read('data/player_backtest.json')).baseline_gate;
  assert.ok(gate, 'data/player_backtest.json must carry the measured baseline_gate');
  if (gate.adopted_for_shipped) {
    assert.equal(r.shipped_rule, 'prior_ppg_x_projected_games');
  } else {
    assert.equal(r.shipped_rule, 'prior_season_points',
      'the rule may not ship for proj_points while the gate says NOT adopted');
    assert.equal(r.proj, 300, 'shipped number untouched');
  }
  assert.equal(r.row_rule, r.shipped_rule);
  // the candidate is the R49 baseline (x13 here) regardless of the shipped rule
  assert.equal(r.pg, 13);
  assert.ok(Math.abs(r.cand_base - (300 / 13) * 13) < 0.02);
  assert.ok(r.lo < r.cand && r.cand < r.hi, 'a +/- band around the candidate');
  // the gate is a measurement of BOTH objectives, never a claim
  for (const k of ['pooled_rho_total_rule', 'pooled_rho_ppg_rule',
    'pooled_mae_total_rule', 'pooled_mae_ppg_rule']) {
    assert.equal(typeof gate[k], 'number', `${k} must be measured`);
  }
  assert.equal(gate.adopted_for_shipped,
    gate.pooled_rho_ppg_rule > gate.pooled_rho_total_rule
      && gate.pooled_mae_ppg_rule < gate.pooled_mae_total_rule,
    'adoption follows from the numbers, not the other way round');
});

test('candidate_points = R49 baseline x every raw signal at full strength, auditable', () => {
  const r = py(`${PRELUDE}
out = pp.project_player(rec(prior_season_points=300.0, prior_games=15, age=36,
                            injury_status="Questionable", games_missed_rate=0.2),
                        ctx={"teams": {"teams": [{"abbrev": "BAL", "roof": "indoor"}]}})
prod = 1.0
for v in out["candidate_signals"].values():
    prod *= v
print(json.dumps({"out": out, "prod": prod}))`);
  const o = r.out;
  assert.deepEqual(Object.keys(o.candidate_signals).sort(),
    ['age_curve', 'indoor_outdoor', 'injury_history', 'injury_status']);
  assert.ok(Math.abs(o.candidate_baseline * r.prod - o.candidate_points) < 0.02,
    'candidate_points must equal candidate_baseline x product of candidate_signals');
  assert.deepEqual(o.signals_used, [], 'nothing has earned weight: shipped signals_used stays []');
  assert.equal(o.proj_points, 300, 'the shipped number is untouched by the candidate');
});

test('build_weekly does not subtract a documented absence twice when it is already in the total', () => {
  const r = py(`${PRELUDE}
from scripts import build_weekly as bw
sched = bw.team_schedule([{"week": w, "home": "AAA", "away": "BBB"} for w in range(1, 19) if w != 9])
in_total = bw.player_weeks(130.0, "AAA", sched, {}, unavailable_weeks=4, absence_in_total=True, round_dp=None)
pro_rata = bw.player_weeks(170.0, "AAA", sched, {}, unavailable_weeks=4, round_dp=None)
print(json.dumps({
  "in_total_sum": sum(w["pts"] for w in in_total), "in_total_blocked": [w["wk"] for w in in_total if w.get("avail") is False],
  "pro_rata_sum": sum(w["pts"] for w in pro_rata),
  "flag_total": bw.absence_in_total({"baseline_rule": "prior_ppg_x_projected_games", "absence_weeks": 4}),
  "flag_shipped": bw.absence_in_total({"baseline_rule": "prior_season_points", "absence_weeks": 4}),
}))`);
  assert.ok(Math.abs(r.in_total_sum - 130) < 1e-6, 'R49 row: playable weeks sum to the full (already reduced) total');
  assert.deepEqual(r.in_total_blocked, [1, 2, 3, 4]);
  assert.ok(Math.abs(r.pro_rata_sum - 170 * 13 / 17) < 1e-6, 'total-rule row: the pro-rata law is unchanged');
  assert.equal(r.flag_total, true);
  assert.equal(r.flag_shipped, false);
});

test('meta.projection_baseline is present, schema-valid, and consistent with the engine', () => {
  const meta = JSON.parse(read('data/meta.json'));
  const pb = meta.projection_baseline;
  assert.ok(pb, 'data/meta.json must carry projection_baseline');
  assert.equal(pb.rule, 'prior_ppg_x_projected_games');
  assert.equal(pb.season_games, 17);
  assert.match(pb.games_source, /player_history seasons\.games/);
  assert.match(pb.absence_source, /injuries\.json/);
  assert.match(pb.changed_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const engine = py(`${PRELUDE}
print(json.dumps({"shipped": pp.SHIPPED_BASELINE_RULE, "implemented": list(pp.IMPLEMENTED_SIGNALS),
                  "sd": pp.CANDIDATE_SD_RULE}))`);
  assert.equal(pb.shipped_rule, engine.shipped, 'meta must state the rule the engine actually ships');
  assert.ok(pb.applies_to.includes('candidate_points'));
  assert.equal(pb.applies_to.includes('proj_points'), engine.shipped === 'prior_ppg_x_projected_games');
  assert.equal(pb.gate.adopted_for_shipped, engine.shipped === 'prior_ppg_x_projected_games');
  assert.equal(pb.candidate.sd_rule, engine.sd);
  const all = new Set([...pb.candidate.signals_applied, ...pb.candidate.signals_not_computable]);
  assert.deepEqual([...all].sort(), engine.implemented.sort(),
    'applied + not-computable must partition the signals the engine implements');
  // every field is a documented contract property
  const schema = JSON.parse(read('data/contracts/meta.schema.json'));
  assert.ok(schema.properties.projection_baseline, 'meta.schema.json must declare projection_baseline');
  assert.ok(schema.properties.learning_record, 'meta.schema.json must declare learning_record');
});

test('the ESPN pool collects prior_games from the same actuals entry and delivers it', () => {
  const src = read('scripts/scrape/espn_players.py');
  assert.match(src, /_STAT_GAMES = "210"/);
  assert.match(src, /"prior_games": games_or_none\(_stats\)/);
  assert.match(src, /"prior_games": p\.get\("prior_games"\)/);
  const hist = read('scripts/scrape/espn_history.py');
  assert.match(hist, /return games_or_none\(stats\)/, 'history and pool share ONE games definition');
});
