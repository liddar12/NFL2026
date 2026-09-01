/* tests/feature/r49_sleeper_display.test.mjs — R49: Sleeper's estimate (and
 * the SCENARIO candidate) beside OURS, display-only.
 *
 * NEVER TOUCHES THE NETWORK. The Sleeper projection doc is the committed
 * fixture (tests/fixtures/sleeper_proj/sleeper_projections.json, the exact
 * contract shape the daily runner produces) and the league is the real
 * P.T.I. payload (tests/fixtures/sleeper_pti).
 *
 * Load-bearing locks:
 *   - the OWNER'S NUMBERS: Lamar Jackson week 1 prices to 20.23 under P.T.I.
 *     scoring, and Devonta's Inferno's nine Sleeper starters sum to 137.79;
 *   - a week Sleeper does not project is NULL, never 0;
 *   - the reason line is '' inside 20% and an honest sentence outside;
 *   - the views render the new lines, and the fetch is LAZY (never inside a
 *     mount's Promise.allSettled) — the perf budget knows the module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizeProfile, applyScoring, DEFAULT_PROFILE } from '../../app/league.js';
import {
  shapeSleeper, rosSleeper, sleeperWeek, sumSleeper, gapReason, deltaPct, fmtDelta,
  scenarioOf, scenarioMoves, fmtMoves, __selftest, SLEEPER_PROJ_PATH, GAP_THRESHOLD,
} from '../../app/sleeper-proj.js';
import { renderEstimateRow, withEstimateRow } from '../../app/views/players.js';
import {
  scenarioTeamSum, sleeperTeamSummary, renderTeamEstimate,
} from '../../app/views/grade.js';
import { baselineCard, learningCard } from '../../app/views/model.js';
import * as sleeperProj from '../../app/sleeper-proj.js';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(here(rel), 'utf8'));
const readSrc = (rel) => readFileSync(here(rel), 'utf8');

const DOC = readJson('../fixtures/sleeper_proj/sleeper_projections.json');
const LEAGUE = readJson('../fixtures/sleeper_pti/league.json');
const ROSTERS = readJson('../fixtures/sleeper_pti/rosters.json');
const INDEX = readJson('../fixtures/sleeper_pti/player_index_trimmed.json');

/** The P.T.I. profile: its own scoring table over its own roster shape. */
const PTI = normalizeProfile({
  name: LEAGUE.name,
  scoring: LEAGUE.scoring_settings,
  shape: { teams: LEAGUE.total_rosters, roster_positions: LEAGUE.roster_positions },
});

const LAMAR_APP = 'espn-3916387';

/* ------------------------------------------------------------- shaping */

test('R49: the module self-test passes and the fetch path is the contract path', () => {
  assert.equal(__selftest().ok, true);
  assert.equal(SLEEPER_PROJ_PATH, '/data/sleeper_projections.json');
  assert.equal(GAP_THRESHOLD, 0.2);
});

test("R49: shapeSleeper prices Lamar Jackson week 1 to 20.23 under P.T.I. (the owner's number)", () => {
  const idx = shapeSleeper(DOC, PTI);
  assert.equal(idx.ok, true);
  assert.equal(idx.generated_utc, DOC.generated_utc);
  const lamar = idx.byAppId.get(LAMAR_APP);
  assert.ok(lamar, 'Lamar is addressable by his app id');
  assert.equal(lamar.name, 'Lamar Jackson');
  assert.equal(lamar.position, 'QB');
  assert.ok(Math.abs(lamar.weeks[0] - 20.23) <= 0.05, `week 1 = ${lamar.weeks[0]}`);
  // Exactly applyScoring's arithmetic — the fast path is not a second rule.
  const viaApply = applyScoring(DOC.players.find((p) => p.app_id === LAMAR_APP).weeks['1'], PTI);
  assert.ok(Math.abs(lamar.weeks[0] - viaApply) < 0.006);
  // The raw pts_ppr is kept for reference and is NOT the headline (22.64 vs 20.23).
  assert.equal(lamar.raw.pts_ppr[0], 22.64);
  assert.equal(sleeperWeek(lamar, 1), lamar.weeks[0]);
  assert.equal(lamar.weeks.length, 18);
  assert.equal(lamar.projectedWeeks, 18);
  assert.ok(Math.abs(lamar.season - lamar.weeks.reduce((s, v) => s + v, 0)) < 0.01);
});

test("R49: Devonta's Inferno's nine Sleeper starters price to 137.79 in week 1 under P.T.I.", () => {
  const idx = shapeSleeper(DOC, PTI);
  const roster = ROSTERS.find((r) => r.roster_id === 1);
  assert.equal(roster.starters.length, 9);
  let sum = 0;
  let n = 0;
  for (const sid of roster.starters) {
    // Map through the Sleeper player index's espn id -> our app id; a starter
    // outside our 300-player pool carries no app_id in the contract (he is
    // counted in coverage only) and is reached by his Sleeper id here.
    const espn = INDEX[sid] && INDEX[sid].espn_id;
    const e = (espn && idx.byAppId.get(`espn-${espn}`)) || idx.bySleeperId.get(sid);
    assert.ok(e, `starter ${sid} is in the doc`);
    const wk = sleeperWeek(e, 1);
    assert.ok(Number.isFinite(wk), `starter ${sid} has a week-1 price`);
    sum += wk;
    n += 1;
  }
  assert.equal(n, 9);
  assert.ok(Math.abs(sum - 137.79) <= 0.1, `nine starters week 1 = ${sum.toFixed(2)}`);
  // Coverage is honest: rows without an app_id are counted but not addressable.
  assert.equal(idx.coverage.players, DOC.players.length);
  assert.equal(idx.coverage.matched, DOC.players.filter((p) => p.app_id).length);
  assert.ok(idx.coverage.matched < idx.coverage.players);
});

test('R49: a week Sleeper does not project is null — never 0', () => {
  const idx = shapeSleeper(DOC, PTI);
  const sf = idx.byAppId.get('DST-SF');
  assert.ok(sf, 'the 49ers defence is addressable by the kdst id');
  assert.equal(sf.weeks[7], null, 'week 8 (bye) is null');
  assert.notEqual(sf.weeks[7], 0);
  assert.equal(sf.projectedWeeks, 17);
  assert.equal(sleeperWeek(sf, 8), null);
  assert.equal(sleeperWeek(sf, 0), null);
  assert.equal(sleeperWeek(sf, 19), null);
  // A synthetic doc: two weeks projected, the rest null; season is their sum.
  const two = shapeSleeper({
    display_only: true,
    players: [{ sleeper_id: 'x', app_id: 'a', name: 'A', position: 'RB', team: 'SF',
      weeks: { 3: { rush_yd: 100 }, 5: { rush_yd: 50 } } }],
  }, normalizeProfile({ scoring: { rush_yd: 0.1 } }));
  const a = two.byAppId.get('a');
  assert.deepEqual(a.weeks.filter((v) => v !== null), [10, 5]);
  assert.equal(a.weeks[0], null);
  assert.equal(a.season, 15);
  // No weeks at all -> season null (not 0).
  const none = shapeSleeper({ display_only: true,
    players: [{ sleeper_id: 'y', app_id: 'b', name: 'B', weeks: {} }] }, DEFAULT_PROFILE);
  assert.equal(none.byAppId.get('b').season, null);
});

test('R49: shapeSleeper refuses a null / malformed / non-display-only doc with ok:false', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}, { players: 'no' }]) {
    const r = shapeSleeper(bad, PTI);
    assert.equal(r.ok, false);
    assert.equal(r.byAppId.size, 0);
  }
  const notDisplay = shapeSleeper({ ...DOC, display_only: false }, PTI);
  assert.equal(notDisplay.ok, false, 'a doc that does not declare display_only is not shown');
});

test('R49: rosSleeper sums from a week; null when nothing remains', () => {
  const idx = shapeSleeper(DOC, PTI);
  const lamar = idx.byAppId.get(LAMAR_APP);
  const from10 = lamar.weeks.slice(9).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(rosSleeper(lamar, 10) - from10) < 0.01);
  assert.ok(Math.abs(rosSleeper(lamar, 1) - lamar.season) < 0.01);
  assert.ok(Math.abs(rosSleeper(lamar, 18) - lamar.weeks[17]) < 0.01);
  assert.equal(rosSleeper(lamar, 19), null);
  assert.equal(rosSleeper(null, 1), null);
  const sf = idx.byAppId.get('DST-SF');
  // From the bye week itself: the bye contributes nothing, later weeks do.
  assert.ok(Math.abs(rosSleeper(sf, 8) - sf.weeks.slice(8).reduce((s, v) => s + v, 0)) < 0.01);
});

test('R49: sumSleeper reports coverage — a missing player adds nothing and is counted', () => {
  const idx = shapeSleeper(DOC, PTI);
  const r = sumSleeper(idx.byAppId, [LAMAR_APP, 'espn-0000000', 'DST-SF'], 8);
  assert.equal(r.total, 3);
  assert.equal(r.covered, 1, 'the unknown id and the bye week both contribute nothing');
  assert.ok(Math.abs(r.points - idx.byAppId.get(LAMAR_APP).weeks[7]) < 0.01);
  const none = sumSleeper(idx.byAppId, ['nope'], null);
  assert.equal(none.points, null);
  assert.equal(none.covered, 0);
});

/* ----------------------------------------------------------- comparison */

test("R49: gapReason is '' inside 20% and an honest line outside (never an invented cause)", () => {
  assert.equal(gapReason(100, 110), '');
  assert.equal(gapReason(100, 119), '');
  assert.equal(gapReason(120, 100), '', 'exactly 20% is inside');
  // The owner's example (281.4 vs 344.9) is 18% of the Sleeper number — INSIDE
  // the band, so no reason is owed; 250 vs 344.9 (28%) is outside.
  assert.equal(gapReason(281.4, 344.9), '');
  const out = gapReason(250, 344.9);
  assert.ok(out.length > 0);
  assert.match(out, /28%/);
  assert.match(out, /no cause is recorded/i, 'without a documented baseline the cause is not guessed');
  const withRule = gapReason(250, 344.9, {
    baselineRule: '2025 points per game x projected games (17 minus documented absence)',
  });
  assert.match(withRule, /^Our baseline is 2025 points per game x projected games/);
  assert.match(withRule, /Sleeper projects forward stats/);
  assert.equal(gapReason(100, null), 'Sleeper does not project this player');
  assert.equal(gapReason(null, 100), 'No projection on our side');
  assert.equal(gapReason(null, null), 'Neither engine projects this player');
  // Tiny Sleeper numbers: the divisor floors at 1 so a 0.1 vs 0.3 gap is not 200%.
  assert.equal(gapReason(0.3, 0.1), '');
});

test('R49: deltas are vs OURS', () => {
  assert.equal(deltaPct(281.4, 344.9), 23);
  assert.equal(deltaPct(100, 80), -20);
  assert.equal(deltaPct(440, 275), -38, 'symmetric rounding of −37.5');
  assert.equal(deltaPct(0, 5), null);
  assert.equal(deltaPct(null, 5), null);
  assert.equal(fmtDelta(23), '+23%');
  assert.equal(fmtDelta(-18), '−18%');
  assert.equal(fmtDelta(0), '0%');
  assert.equal(fmtDelta(null), '');
});

/* ------------------------------------------------------------- scenario */

const CANDIDATE_REC = {
  gsis_id: 'espn-1', name: 'Test Back', position: 'RB', team: 'SF',
  proj_points: 200, low: 150, high: 250,
  candidate_points: 176, candidate_low: 150, candidate_high: 202,
  candidate_signals: { injury: -0.12, teammates: 0.06, weather: -0.01, schedule: 0.02, ol_vs_dl: 0 },
};

test('R49: scenarioOf prices the candidate by the shipped ratio; absent fields -> null', () => {
  // PPR, no extras: shipped == base, the candidate passes through exactly.
  const exact = scenarioOf(CANDIDATE_REC, { shipped: 200, extra: 0 });
  assert.equal(exact.points, 176);
  assert.equal(exact.sd, 26);
  assert.equal(exact.approx, false);
  // STD conversion (shipped 160 of a 200 base): the same ratio, still exact
  // in the sense that nothing beyond the reception conversion moved.
  const std = scenarioOf(CANDIDATE_REC, { shipped: 160, extra: 0 });
  assert.equal(std.points, 140.8);
  assert.equal(std.sd, 20.8);
  assert.equal(std.approx, false);
  // League-rule extras in the shipped number: the ratio is an approximation, flagged.
  const ex = scenarioOf(CANDIDATE_REC, { shipped: 210, extra: 10 });
  assert.equal(ex.approx, true);
  assert.ok(Math.abs(ex.points - 184.8) < 0.01);
  // Absent candidate -> null; a half-formed band -> sd null, never NaN.
  assert.equal(scenarioOf({ proj_points: 200 }, { shipped: 200 }), null);
  assert.equal(scenarioOf(null, { shipped: 200 }), null);
  const noBand = scenarioOf({ proj_points: 200, candidate_points: 150 }, { shipped: 200 });
  assert.equal(noBand.points, 150);
  assert.equal(noBand.sd, null);
});

test('R49: scenarioMoves lists the biggest moves (capped to three, zeros dropped) and formats them', () => {
  const moves = scenarioMoves(CANDIDATE_REC, 3);
  assert.deepEqual(moves.map((m) => m.name), ['injury', 'teammates', 'schedule']);
  assert.equal(fmtMoves(moves), 'injury −12% · teammates +6% · schedule +2%');
  assert.deepEqual(scenarioMoves({ proj_points: 1 }), []);
  assert.equal(fmtMoves([]), '');
  assert.equal(fmtMoves(scenarioMoves({ candidate_signals: { target_competition: -0.05 } })),
    'target competition −5%');
});

/* ------------------------------------------------------- PLAYERS render */

test('R49: renderEstimateRow — OURS · SCENARIO · SLEEPER with deltas vs OURS, the week line, moves and reason', () => {
  const html = renderEstimateRow({
    ours: 281.4,
    scenario: { points: 301.2, sd: 24, approx: false },
    sleeperLoaded: true,
    sleeper: 344.9,
    week: 3,
    oursWk: 17.2,
    scenarioWk: 18.4,
    sleeperWk: 20.2,
    moves: 'injury −12% · teammates +6%',
    reason: 'Our baseline is X; Sleeper projects forward stats (23% apart)',
  });
  assert.match(html, /<span class="pe-lbl">OURS<\/span><b class="pe-us">281\.4<\/b>/);
  assert.match(html, /SCENARIO<\/span><b class="pe-sc">301\.2<\/b><span class="pe-meta">±24\.0 · \+7%<\/span>/);
  assert.match(html, /SLEEPER<\/span><b class="pe-sl">344\.9<\/b><span class="pe-meta">\+23%<\/span>/);
  assert.match(html, /WK 3 · OURS 17\.2 · SCENARIO 18\.4 · SLEEPER 20\.2/);
  assert.match(html, /SCENARIO moves: injury −12% · teammates \+6%/);
  assert.match(html, /class="pe-reason">Our baseline is X; Sleeper projects forward stats/);
  assert.match(html, /never an input/);
  // The DOM stays small: at most ~14 nodes per card for all four lines.
  assert.ok((html.match(/<(div|span|b)\b/g) || []).length <= 14);
});

test('R49: renderEstimateRow — Sleeper lacks the player -> em dash (not 0.0); ≈ marks an approximate scenario', () => {
  const html = renderEstimateRow({
    ours: 100, scenario: { points: 90, sd: 5, approx: true }, sleeperLoaded: true, sleeper: null,
    week: 1, oursWk: 6, scenarioWk: 5.4, sleeperWk: null, reason: 'Sleeper does not project this player',
  });
  assert.match(html, /SLEEPER<\/span><b class="pe-sl pe-none">—<\/b>/);
  assert.doesNotMatch(html, /SLEEPER<\/span><b class="pe-sl">0\.0/);
  assert.match(html, /WK 1 · OURS 6\.0 · SCENARIO 5\.4 · SLEEPER —/);
  assert.match(html, /<b class="pe-sc">≈90\.0<\/b>/);
  assert.match(html, /pe-reason">Sleeper does not project this player/);
});

test('R49: renderEstimateRow — nothing to say renders nothing (no doc, no candidate)', () => {
  assert.equal(renderEstimateRow({ ours: 100, scenario: null, sleeperLoaded: false }), '');
  assert.equal(renderEstimateRow({}), '');
  // Candidate only (older Sleeper state, newer projections): no Sleeper cell at all.
  const sc = renderEstimateRow({ ours: 100, scenario: { points: 110, sd: 8 }, sleeperLoaded: false, week: 2, oursWk: 5 });
  assert.match(sc, /SCENARIO/);
  assert.doesNotMatch(sc, /pe-sl|SLEEPER —|SLEEPER \d/, 'no Sleeper cell before the doc lands');
});

test('R49: withEstimateRow splices before the signals block and leaves an anchorless card untouched', () => {
  const card = '<article class="card player"><div class="interval">x</div><div class="sigs">s</div></article>';
  const out = withEstimateRow(card, '<div class="p-est">E</div>');
  assert.equal(out, '<article class="card player"><div class="interval">x</div><div class="p-est">E</div><div class="sigs">s</div></article>');
  assert.equal(withEstimateRow(card, ''), card);
  assert.equal(withEstimateRow('<article>no anchor</article>', '<div>E</div>'), '<article>no anchor</article>');
});

/* --------------------------------------------------------- GRADE render */

test('R49: scenarioTeamSum sums the candidates for the same starters; coverage honest; null when none', () => {
  const players = [
    CANDIDATE_REC,
    { gsis_id: 'espn-2', name: 'No Cand', position: 'WR', proj_points: 150 },
    { gsis_id: 'espn-3', name: 'Other', position: 'TE', proj_points: 90, candidate_points: 99 },
  ];
  const starters = [
    { slot: 'RB', id: 'espn-1', name: 'Test Back', pts: 200 },
    { slot: 'WR', id: 'espn-2', name: 'No Cand', pts: 150 },
    { slot: 'TE', id: 'espn-3', name: 'Other', pts: 90 },
    { slot: 'FLEX', id: null, name: null, pts: 0, empty: true },
  ];
  const r = scenarioTeamSum(players, starters, sleeperProj, new Map());
  assert.equal(r.points, 275); // 176 + 99
  assert.equal(r.covered, 2);
  assert.equal(r.total, 3, 'the EMPTY slot is not a starter');
  assert.equal(r.approx, false);
  assert.equal(scenarioTeamSum(players.slice(1, 2), starters.slice(1, 2), sleeperProj, new Map()), null);
  const html = renderTeamEstimate({ ours: 440, scenario: r, teamIndex: 4 });
  assert.match(html, /OURS <b>440\.0<\/b> · SCENARIO <b>275\.0<\/b> −38% · 2\/3 candidates/);
  assert.match(html, /<span class="gr-est-sl" data-team="4" hidden><\/span>/);
  assert.match(renderTeamEstimate({ ours: 10, scenario: null, teamIndex: 0 }), /^<div class="gr-est">OURS <b>10\.0<\/b><span/);
});

test('R49: sleeperTeamSummary — season for the starters, every week, regular-season PF, n/N coverage', () => {
  const idx = shapeSleeper(DOC, PTI);
  const starters = [
    { slot: 'QB', id: LAMAR_APP, name: 'Lamar Jackson', pts: 300 },
    { slot: 'DEF', id: 'DST-SF', name: '49ers', pts: 100 },
    { slot: 'WR', id: 'espn-0', name: 'Not in Sleeper', pts: 50 },
    { slot: 'FLEX', id: null, name: null, pts: 0, empty: true },
  ];
  const geometry = [{ slot: 'QB' }, { slot: 'DEF' }, { slot: 'WR' }];
  const weeks = [7, 8].map((week) => ({
    week, lineup: { geometry, slots: { QB: LAMAR_APP, DEF: 'DST-SF', WR: 'espn-0' } },
  }));
  const s = sleeperTeamSummary(sleeperProj, idx, starters, weeks);
  const lamar = idx.byAppId.get(LAMAR_APP);
  const sf = idx.byAppId.get('DST-SF');
  assert.equal(s.season.total, 3);
  assert.equal(s.season.covered, 2);
  assert.ok(Math.abs(s.season.points - (lamar.season + sf.season)) < 0.02);
  assert.equal(s.weeks.length, 2);
  assert.equal(s.weeks[0].covered, 2);
  assert.equal(s.weeks[1].covered, 1, 'the defence is on bye in week 8 — null, adds nothing');
  assert.ok(Math.abs(s.weeks[1].points - lamar.weeks[7]) < 0.01);
  assert.equal(s.pf.total, 6);
  assert.equal(s.pf.covered, 3);
  assert.ok(Math.abs(s.pf.points - (s.weeks[0].points + s.weeks[1].points)) < 0.06);
});

/* ---------------------------------------------------------- MODEL render */

test('R49: baselineCard / learningCard render the meta keys, and nothing on an older meta', () => {
  assert.equal(baselineCard({}), '');
  assert.equal(baselineCard(null), '');
  assert.equal(learningCard({ weights: {} }), '');
  const meta = {
    projection_baseline: {
      rule: '2025 points per game x projected games (17 minus documented absence)',
      season_games: 17, games_source: 'nflverse', absence_source: 'injuries.json',
      changed_utc: '2026-09-01T00:00:00Z',
      candidate: { signals_applied: ['age', 'injury', 'teammates'], sd_rule: 'one sd of the 2025 residuals' },
    },
    learning_record: {
      weeks_resolved: 0, players_scored: 0, mae_ppr: null, bias_ppr: null, signals_with_weight: [],
      backtest_2025: { baseline_mae: 4.21, candidate_mae: 4.02, band_coverage: 0.68, players: 288 },
    },
  };
  const b = baselineCard(meta);
  assert.match(b, /PROJECTION BASELINE/);
  assert.match(b, /2025 points per game x projected games \(17 minus documented absence\)/);
  assert.match(b, /17 season games · games from nflverse · absence from injuries\.json · changed 2026-09-01/);
  assert.match(b, /SCENARIO CANDIDATE.*age, injury, teammates/);
  assert.match(b, /band: one sd of the 2025 residuals/);
  const l = learningCard(meta);
  assert.match(l, /WEEKS RESOLVED<\/span><span class="mp-val">0</);
  assert.match(l, /MAE \(PPR\)<\/span><span class="mp-val">—</);
  assert.match(l, /BIAS \(PPR\)<\/span><span class="mp-val">—</);
  assert.match(l, /SIGNALS WITH WEIGHT<\/span><span class="mp-val">none yet</);
  assert.match(l, /No 2026 week has resolved yet — nothing has been scored, so no signal has earned weight/);
  assert.match(l, /BACKTEST 2025 · baseline MAE 4\.21 · candidate MAE 4\.02 · band coverage 68\.0% · 288 players/);
  assert.match(l, /SCENARIO is the candidate the self-learning loop backtests; it moves the shipped number only after it clears never-regress\./);
  // Resolved weeks: the numbers show and the day-zero sentence is gone.
  const l2 = learningCard({ learning_record: {
    weeks_resolved: 3, players_scored: 412, mae_ppr: 5.12, bias_ppr: -0.4, signals_with_weight: ['injury_status'],
  } });
  assert.match(l2, /MAE \(PPR\)<\/span><span class="mp-val">5\.12</);
  assert.match(l2, /BIAS \(PPR\)<\/span><span class="mp-val">-0\.40</);
  assert.match(l2, /SIGNALS WITH WEIGHT<\/span><span class="mp-val">injury_status</);
  assert.doesNotMatch(l2, /No 2026 week has resolved yet/);
});

/* ------------------------------------------------------------ source pins */

test('R49: PLAYERS renders the estimate row and fetches Sleeper LAZILY after the first paint', () => {
  const src = readSrc('../../app/views/players.js');
  assert.match(src, /import\('\.\.\/sleeper-proj\.js'\)/, 'lazy import');
  assert.doesNotMatch(src, /^import[^;]*sleeper-proj/m, 'no static edge to the module');
  // The mount's allSettled fan-out is unchanged: no Sleeper / meta getter inside it.
  const fan = src.slice(src.indexOf('await Promise.allSettled(['), src.indexOf('teamModule(),'));
  assert.doesNotMatch(fan, /getSleeperProjections|sleeper-proj|getMeta/);
  assert.match(src, /requestIdleCallback\(\(\) => \{ ensureSleeper\(\); \}/, 'after first paint, idle');
  assert.match(src, /withEstimateRow\(withExtraRow\(renderPlayerCard/, 'the row is on every card');
  assert.match(src, /export function renderEstimateRow/);
  assert.match(src, /OURS · SCENARIO · SLEEPER/, 'the legend explains the three engines');
});

test('R49: GRADE cards, weekly headers and standings carry the Sleeper cells; the fill is lazy', () => {
  const src = readSrc('../../app/views/grade.js');
  assert.match(src, /import\('\.\.\/sleeper-proj\.js'\)/);
  assert.match(src, /class="gr-est-sl" data-team=/, 'season cell on the card');
  assert.match(src, /class="gr-est-wk" data-team=.*data-wk=/, 'weekly header cell');
  assert.match(src, /SLEEPER PF/, 'standings column');
  assert.match(src, /<tr data-team="\$\{s\.index\}">/, 'standings rows are addressable by team');
  assert.match(src, /Sleeper's numbers are Sleeper's own projections priced under this league's/);
  assert.match(src, /shown for comparison, never an input/);
  assert.match(src, /n\/N projected/);
  assert.match(src, /requestIdleCallback\(fill/, 'the doc lands after the league paints');
  const mount = src.slice(src.indexOf('export default async function mountGrade'));
  assert.doesNotMatch(mount, /sleeper-proj|getSleeperProjections/, 'nothing Sleeper on the cold mount');
  // The engine's starters carry the id the display layer addresses them by.
  assert.match(readSrc('../../app/grade.js'), /starters\.push\(\{ slot, id: r\.p\.gsis_id, name: r\.p\.name/);
});

test('R49: MODEL mounts the two new cards; the perf budget knows the lazy module', () => {
  const model = readSrc('../../app/views/model.js');
  assert.match(model, /card\('PROJECTION BASELINE', baselineCard\(meta\)/);
  assert.match(model, /card\('LEARNING RECORD', learningCard\(meta\)/);
  const budget = readSrc('../perf/budget.spec.mjs');
  assert.match(budget, /'app\/sleeper-proj\.js'/, 'lazy-only module');
  assert.match(budget, /R49 — 8 -> 10/, 'the players cold count change is explained in place');
  const css = readSrc('../../app/theme.css');
  assert.match(css, /R49 sleeper estimate/);
  assert.match(css, /\.p-est \{/);
  assert.match(css, /\.gr-est-sl\[hidden\], \.gr-est-wk\[hidden\] \{ display: none; \}/);
});
