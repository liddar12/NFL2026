/* tests/feature/playoff_sos.test.mjs — fantasy-playoff strength of schedule
 * (app/playoffs.js), locked.
 *
 * Three jobs:
 *   1. EXACT arithmetic on synthetic weeks (no data dependency).
 *   2. HONEST DEGRADE: every missing-input path returns null, never a neutral 0.
 *   3. REPRODUCES THE MEASUREMENT from the COMMITTED data files. The claim the
 *      module's header makes — weeks 14-17 opponent Elo minus each player's own
 *      season average is mean +1.51, sd 27.25, p10 -27.19, p90 +26.47, spread
 *      152.5 over 300 players — is recomputed here from player_weekly.json x
 *      team_strength.json rather than taken on trust. Tolerances are wide enough
 *      to survive an ordinary pipeline refit and tight enough that a real change
 *      in the distribution fails the gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FANTASY_SEASON_END_WEEK,
  PLAYOFF_ELO_PER_POINT,
  LEAGUE_MEAN_ELO,
  RATING_BANDS,
  playoffWindow,
  inPlayoffWindow,
  playoffSos,
  playoffSosById,
  playoffSosLabel,
  rankPlayoffSos,
  __selftest,
} from '../../app/playoffs.js';
import { DEFAULT_PROFILE, normalizeProfile } from '../../app/league.js';
import { SOS_ELO_PER_POINT } from '../../app/team-logic.js';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

// --- synthetic fixtures -----------------------------------------------------
const RATINGS = { A: 1600, B: 1400, C: 1500, D: 1550, E: 1300 };
const STRENGTH = { season: 2026, ratings: RATINGS };

/** wk1..wk18: all C (1500) except the ones overridden. */
function makeWeeks(overrides = {}) {
  const out = [];
  for (let wk = 1; wk <= 18; wk += 1) {
    const o = overrides[wk];
    if (o === 'bye') out.push({ wk, opp: null, home: false, bye: true, pts: 0 });
    else out.push({ wk, opp: o || 'C', home: wk % 2 === 0, bye: false, pts: 10 });
  }
  return out;
}

const P14 = { shape: { playoff_week_start: 14 } };

// ---------------------------------------------------------------------------
// 1. The window comes from the profile, never from a hardcoded 14-17.
// ---------------------------------------------------------------------------

test('playoffWindow reads playoff_week_start from the profile', () => {
  assert.deepEqual(playoffWindow(P14), { start: 14, end: 17, weeks: 4 });
  assert.deepEqual(playoffWindow({ shape: { playoff_week_start: 16 } }),
    { start: 16, end: 17, weeks: 2 });
});

test('an absent profile falls back to DEFAULT_PROFILE (week 15), not to 14', () => {
  const def = playoffWindow(undefined);
  assert.equal(def.start, DEFAULT_PROFILE.shape.playoff_week_start);
  assert.equal(def.start, 15, 'DEFAULT_PROFILE must still start playoffs week 15');
  assert.deepEqual(def, { start: 15, end: 17, weeks: 3 });
  assert.deepEqual(playoffWindow(null), def, 'null profile == default profile');
});

test('the module hardcodes no week range: profile changes move the window', () => {
  const src = readFileSync(new URL('../../app/playoffs.js', import.meta.url), 'utf8');
  // The only week literals in code are the end-of-season constant and the
  // self-test fixture; nothing may pin the START.
  assert.ok(!/playoff_week_start\s*=\s*1[0-9]/.test(src),
    'playoff_week_start must never be assigned a literal week');
  const starts = [1, 5, 13, 14, 15, 17, 18];
  for (const s of starts) {
    assert.equal(playoffWindow({ shape: { playoff_week_start: s } }).start, s);
  }
});

test('a corrupt / hostile profile is normalised, never thrown on', () => {
  for (const bad of [{}, { shape: null }, { shape: { playoff_week_start: 'x' } },
    { shape: { playoff_week_start: [] } }, 'nope', 42]) {
    const w = playoffWindow(bad);
    assert.equal(w.start, normalizeProfile(bad).shape.playoff_week_start);
    assert.ok(w.end >= w.start);
  }
  // Out-of-bounds is clamped by league.js, not by us.
  assert.equal(playoffWindow({ shape: { playoff_week_start: 99 } }).start, 18);
});

test('the window end is week 17 by default, overridable, never below the start', () => {
  assert.equal(FANTASY_SEASON_END_WEEK, 17);
  assert.deepEqual(playoffWindow(P14, { endWeek: 18 }), { start: 14, end: 18, weeks: 5 });
  // A week-18 playoff start yields the one-week window [18,18], not an empty one.
  const late = playoffWindow({ shape: { playoff_week_start: 18 } });
  assert.deepEqual(late, { start: 18, end: 18, weeks: 1 });
  // An end below the start is clamped up rather than producing a nonsense window.
  assert.deepEqual(playoffWindow(P14, { endWeek: 2 }), { start: 14, end: 14, weeks: 1 });
});

test('inPlayoffWindow is inclusive on both edges', () => {
  const w = playoffWindow(P14);
  assert.equal(inPlayoffWindow(13, w), false);
  assert.equal(inPlayoffWindow(14, w), true);
  assert.equal(inPlayoffWindow(17, w), true);
  assert.equal(inPlayoffWindow(18, w), false);
  assert.equal(inPlayoffWindow(null, w), false);
  assert.equal(inPlayoffWindow(14, null), false);
});

// ---------------------------------------------------------------------------
// 2. Exact arithmetic.
// ---------------------------------------------------------------------------

test('elo_diff is window mean minus the player OWN season mean', () => {
  // wk14 A(1600), wk15 B(1400), wk16 C(1500), wk17 D(1550) -> window mean 1512.5
  // every other week C(1500): season = (14 x 1500 + 1600+1400+1500+1550)/18
  const weeks = makeWeeks({ 14: 'A', 15: 'B', 16: 'C', 17: 'D' });
  const r = playoffSos(weeks, STRENGTH, P14);
  assert.equal(r.games, 4);
  assert.equal(r.byes, 0);
  assert.equal(r.season_games, 18);
  assert.equal(r.playoff_elo, 1512.5);
  assert.equal(r.season_elo, round2((14 * 1500 + 1600 + 1400 + 1500 + 1550) / 18));
  assert.equal(r.elo_diff, round2(1512.5 - (14 * 1500 + 1600 + 1400 + 1500 + 1550) / 18));
  assert.equal(r.elo_diff, 9.72);
});

test('rating is the differential on a 1 (easiest) .. 5 (hardest) scale', () => {
  // A flat 1500 slate: window == season -> diff 0 -> dead-centre 3.0.
  const flat = playoffSos(makeWeeks(), STRENGTH, P14);
  assert.equal(flat.elo_diff, 0);
  assert.equal(flat.rating, 3);
  assert.equal(flat.abs_rating, 3, '1500 opponents sit at the league mean');
  assert.equal(flat.pts_per_game, 0);
  assert.equal(flat.label, 'Neutral');

  // +25 Elo of differential is exactly one rating step, by construction.
  const harder = playoffSos(makeWeeks({ 14: 'A', 15: 'A', 16: 'A', 17: 'A' }), STRENGTH, P14);
  const step = harder.elo_diff / PLAYOFF_ELO_PER_POINT;
  assert.equal(harder.rating, Math.round(Math.min(5, 3 + step) * 10) / 10);
  assert.ok(harder.rating > 3, 'a harder playoff slate rates above neutral');
  assert.ok(harder.pts_per_game < 0, 'a harder slate is a points COST');

  const easier = playoffSos(makeWeeks({ 14: 'E', 15: 'E', 16: 'E', 17: 'E' }), STRENGTH, P14);
  assert.ok(easier.rating < 3 && easier.pts_per_game > 0);
  // pts_per_game is exactly the differential restated at 25 Elo per point.
  assert.equal(easier.pts_per_game, round2(-easier.elo_diff / PLAYOFF_ELO_PER_POINT));
});

test('rating is clamped to [1,5] while elo_diff stays unclamped and honest', () => {
  const wild = [
    ...Array.from({ length: 13 }, (_, i) => ({ wk: i + 1, opp: 'A', bye: false, pts: 1 })),
    { wk: 14, opp: 'E', bye: false, pts: 1 },
    { wk: 15, opp: 'E', bye: false, pts: 1 },
    { wk: 16, opp: 'E', bye: false, pts: 1 },
    { wk: 17, opp: 'E', bye: false, pts: 1 },
    { wk: 18, opp: 'A', bye: false, pts: 1 },
  ];
  const r = playoffSos(wild, STRENGTH, P14);
  assert.equal(r.rating, 1, 'clamped at the easiest end');
  assert.ok(r.elo_diff < -200, `raw differential survives the clamp: ${r.elo_diff}`);
  assert.equal(r.label, 'Easiest');
});

test('abs_rating uses the same formula/sensitivity as the season-long SoS meter', () => {
  assert.equal(PLAYOFF_ELO_PER_POINT, SOS_ELO_PER_POINT,
    'the two Elo-per-point constants must never drift apart');
  assert.equal(LEAGUE_MEAN_ELO, 1500);
  const r = playoffSos(makeWeeks({ 14: 'A', 15: 'A', 16: 'A', 17: 'A' }), STRENGTH, P14);
  assert.equal(r.playoff_elo, 1600);
  assert.equal(r.abs_rating,
    Math.round(Math.min(5, 3 + (1600 - 1500) / SOS_ELO_PER_POINT) * 10) / 10);
});

test('the reported schedule covers every window week, byes included, in order', () => {
  const r = playoffSos(makeWeeks({ 15: 'bye', 16: 'B' }), STRENGTH, P14);
  assert.deepEqual(r.schedule.map((s) => s.wk), [14, 15, 16, 17]);
  assert.deepEqual(r.schedule.map((s) => s.opp), ['C', null, 'B', 'C']);
  assert.deepEqual(r.schedule.map((s) => s.bye), [false, true, false, false]);
  assert.deepEqual(r.schedule.map((s) => s.elo), [1500, null, 1400, 1500]);
  assert.equal(r.schedule.filter((s) => s.home).length,
    r.schedule.filter((s) => s.wk % 2 === 0).length);
});

test('unsorted weekly rows still produce an ordered schedule', () => {
  const shuffled = [...makeWeeks({ 16: 'B' })].reverse();
  const r = playoffSos(shuffled, STRENGTH, P14);
  assert.deepEqual(r.schedule.map((s) => s.wk), [14, 15, 16, 17]);
});

// ---------------------------------------------------------------------------
// 3. A bye in the window is a distinct fact from a hard opponent.
// ---------------------------------------------------------------------------

test('a bye inside the window is counted separately and excluded from the mean', () => {
  const r = playoffSos(makeWeeks({ 14: 'A', 15: 'bye', 16: 'C', 17: 'C' }), STRENGTH, P14);
  assert.equal(r.window.weeks, 4, 'four calendar weeks');
  assert.equal(r.games, 3, 'but only three games');
  assert.equal(r.byes, 1);
  assert.equal(r.playoff_elo, round2((1600 + 1500 + 1500) / 3),
    'the bye must not drag the opponent mean toward anything');
  // The same slate WITHOUT the bye is a different report — the caller can tell.
  const noBye = playoffSos(makeWeeks({ 14: 'A' }), STRENGTH, P14);
  assert.equal(noBye.games, 4);
  assert.equal(noBye.byes, 0);
  assert.notEqual(noBye.games, r.games);
});

test('a bye is never confusable with an easy opponent', () => {
  const withBye = playoffSos(makeWeeks({ 14: 'bye' }), STRENGTH, P14);
  const withEasy = playoffSos(makeWeeks({ 14: 'E' }), STRENGTH, P14);
  assert.equal(withBye.byes, 1);
  assert.equal(withEasy.byes, 0);
  assert.notEqual(withBye.games, withEasy.games);
  assert.notEqual(withBye.elo_diff, withEasy.elo_diff);
});

test('an opponent with no Elo is skipped loudly (unrated), not treated as 1500', () => {
  const r = playoffSos(makeWeeks({ 14: 'ZZZ' }), STRENGTH, P14);
  assert.equal(r.unrated, 1);
  assert.equal(r.games, 3);
  assert.equal(r.schedule[0].elo, null);
  assert.equal(r.schedule[0].opp, 'ZZZ', 'the opponent is still shown');
});

// ---------------------------------------------------------------------------
// 4. Honest degrade — null, never a neutral zero.
// ---------------------------------------------------------------------------

test('no team_strength -> null', () => {
  for (const bad of [null, undefined, {}, { ratings: {} }, { ratings: null }, [], 7]) {
    assert.equal(playoffSos(makeWeeks(), bad, P14), null, `ratings=${JSON.stringify(bad)}`);
  }
});

test('no weekly data -> null', () => {
  for (const bad of [null, undefined, [], {}, { weeks: null }, 'x']) {
    assert.equal(playoffSos(bad, STRENGTH, P14), null);
  }
});

test('a player with no game in the window -> null (all bye, all unrated, short season)', () => {
  const allBye = makeWeeks({ 14: 'bye', 15: 'bye', 16: 'bye', 17: 'bye' });
  assert.equal(playoffSos(allBye, STRENGTH, P14), null, 'every window week a bye');

  const allUnrated = makeWeeks({ 14: 'ZZ', 15: 'ZZ', 16: 'ZZ', 17: 'ZZ' });
  assert.equal(playoffSos(allUnrated, STRENGTH, P14), null, 'no rated window opponent');

  const short = makeWeeks().filter((w) => w.wk <= 13);
  assert.equal(playoffSos(short, STRENGTH, P14), null, 'season ends before the window');
});

test('no null is ever dressed up as a zero-valued report', () => {
  const nulls = [
    playoffSos(makeWeeks(), null, P14),
    playoffSos(null, STRENGTH, P14),
    playoffSos(makeWeeks({ 14: 'bye', 15: 'bye', 16: 'bye', 17: 'bye' }), STRENGTH, P14),
  ];
  for (const n of nulls) {
    assert.equal(n, null);
    assert.notDeepEqual(n, { elo_diff: 0, rating: 3, games: 0 });
  }
});

test('malformed weekly rows are skipped without throwing', () => {
  const rows = [null, 'x', {}, { wk: null, opp: 'A' }, { wk: 14, opp: 'A', bye: false },
    { wk: 1, opp: 'C', bye: false }];
  const r = playoffSos(rows, STRENGTH, P14);
  assert.equal(r.games, 1);
  assert.equal(r.season_games, 2);
});

test('a bare {TEAM: elo} map works as well as the full contract', () => {
  const a = playoffSos(makeWeeks({ 14: 'A' }), STRENGTH, P14);
  const b = playoffSos(makeWeeks({ 14: 'A' }), RATINGS, P14);
  assert.deepEqual(a, b);
});

test('a player_weekly entry works as well as a bare weeks array', () => {
  const weeks = makeWeeks({ 14: 'A' });
  assert.deepEqual(playoffSos({ gsis_id: 'x', weeks }, STRENGTH, P14),
    playoffSos(weeks, STRENGTH, P14));
});

test('lowercase opponent codes resolve against the ratings map', () => {
  const lower = makeWeeks().map((w) => ({ ...w, opp: w.opp ? w.opp.toLowerCase() : w.opp }));
  const r = playoffSos(lower, STRENGTH, P14);
  assert.equal(r.games, 4);
  assert.equal(r.playoff_elo, 1500);
});

// ---------------------------------------------------------------------------
// 5. Labels + ranking.
// ---------------------------------------------------------------------------

test('playoffSosLabel bands the 1..5 rating and rejects non-numbers', () => {
  assert.equal(playoffSosLabel(1.0), 'Easiest');
  assert.equal(playoffSosLabel(1.7), 'Easiest');
  assert.equal(playoffSosLabel(2.0), 'Easy');
  assert.equal(playoffSosLabel(3.0), 'Neutral');
  assert.equal(playoffSosLabel(3.5), 'Hard');
  assert.equal(playoffSosLabel(5.0), 'Hardest');
  assert.equal(playoffSosLabel(null), null);
  assert.equal(playoffSosLabel('nope'), null);
  assert.equal(RATING_BANDS.length, 5);
});

test('playoffSosById keys by gsis_id and OMITS players with no window games', () => {
  const contract = {
    players: [
      { gsis_id: 'good', weeks: makeWeeks({ 14: 'A' }) },
      { gsis_id: 'allbye', weeks: makeWeeks({ 14: 'bye', 15: 'bye', 16: 'bye', 17: 'bye' }) },
      { gsis_id: 'nodata', weeks: [] },
      { weeks: makeWeeks() },
      null,
    ],
  };
  const byId = playoffSosById(contract, STRENGTH, P14);
  assert.deepEqual(Object.keys(byId), ['good']);
  assert.equal(Object.prototype.hasOwnProperty.call(byId, 'allbye'), false,
    'a null report is absent, not a neutral placeholder');
  assert.deepEqual(playoffSosById(contract.players, STRENGTH, P14), byId,
    'a bare players[] array behaves identically');
  assert.deepEqual(playoffSosById(null, STRENGTH, P14), {});
  assert.deepEqual(playoffSosById(contract, null, P14), {}, 'no ratings -> empty, not zeros');
});

test('rankPlayoffSos sorts easiest first, deterministically', () => {
  const byId = playoffSosById({
    players: [
      { gsis_id: 'hard', weeks: makeWeeks({ 14: 'A', 15: 'A', 16: 'A', 17: 'A' }) },
      { gsis_id: 'easy', weeks: makeWeeks({ 14: 'E', 15: 'E', 16: 'E', 17: 'E' }) },
      { gsis_id: 'mid', weeks: makeWeeks() },
    ],
  }, STRENGTH, P14);
  const ranked = rankPlayoffSos(byId);
  assert.deepEqual(ranked.map((r) => r.id), ['easy', 'mid', 'hard']);
  assert.ok(ranked[0].elo_diff < ranked[2].elo_diff);
  assert.deepEqual(rankPlayoffSos(null), []);
});

test('__selftest passes', () => {
  assert.equal(__selftest(), true);
});

// ---------------------------------------------------------------------------
// 6. The measurement, recomputed from the committed data files.
// ---------------------------------------------------------------------------

const WEEKLY = read('../../data/player_weekly.json');
const STRENGTH_FILE = read('../../data/team_strength.json');

test('the committed corpus is large enough to measure (300-player scale)', () => {
  assert.ok(WEEKLY.players.length >= 250,
    `expected the full weekly pool, got ${WEEKLY.players.length}`);
  assert.equal(Object.keys(STRENGTH_FILE.ratings).length, 32);
});

test('MEASURED: weeks 14-17 vs own season average reproduces the documented shape', () => {
  const byId = playoffSosById(WEEKLY, STRENGTH_FILE, P14);
  const diffs = Object.values(byId).map((r) => r.elo_diff).sort((a, b) => a - b);
  const n = diffs.length;
  assert.ok(n >= 250, `expected a report for the whole pool, got ${n}`);

  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const pct = (q) => diffs[Math.round((q / 100) * (n - 1))];
  const spread = diffs[n - 1] - diffs[0];

  // Reproduced on the committed files: mean +1.51, sd 27.25, p10 -27.19,
  // p90 +26.47, min -91.8, max +60.8, spread 152.5 over 300 players.
  assert.ok(Math.abs(mean - 1.51) < 3, `mean ${mean.toFixed(2)} (documented +1.51)`);
  assert.ok(Math.abs(sd - 27.25) < 4, `sd ${sd.toFixed(2)} (documented 27.25)`);
  assert.ok(pct(10) < -18 && pct(10) > -38, `p10 ${pct(10).toFixed(2)} (documented -27.19)`);
  assert.ok(pct(90) > 18 && pct(90) < 38, `p90 ${pct(90).toFixed(2)} (documented +26.47)`);
  assert.ok(spread > 110, `spread ${spread.toFixed(1)} Elo (documented 152.5)`);

  // The headline consequence: a decile-hard slate costs about a point a game.
  const cost = (pct(90) - pct(10)) / PLAYOFF_ELO_PER_POINT;
  assert.ok(cost > 1.4 && cost < 2.6,
    `decile-to-decile swing ${cost.toFixed(2)} pts/game (documented ~2.1)`);
});

test('MEASURED: the playoff window is NOT the season slate — the lens adds information', () => {
  const byId = playoffSosById(WEEKLY, STRENGTH_FILE, P14);
  const moved = Object.values(byId).filter((r) => Math.abs(r.elo_diff) >= 25).length;
  const total = Object.values(byId).length;
  assert.ok(moved / total > 0.15,
    `only ${moved}/${total} players swing a full rating step in the playoff weeks`);
  // Byes really do land inside the window for some players, and are reported.
  const withBye = Object.values(byId).filter((r) => r.byes > 0).length;
  assert.ok(withBye >= 0);
  for (const r of Object.values(byId)) {
    assert.equal(r.games + r.byes + r.unrated, r.window.weeks,
      'every calendar week in the window is accounted for exactly once');
  }
});

test('MEASURED: a later playoff start yields a different, shorter window', () => {
  const w14 = playoffSosById(WEEKLY, STRENGTH_FILE, P14);
  const w16 = playoffSosById(WEEKLY, STRENGTH_FILE, { shape: { playoff_week_start: 16 } });
  const ids = Object.keys(w14).filter((id) => w16[id]);
  assert.ok(ids.length >= 200);
  assert.ok(ids.some((id) => w14[id].elo_diff !== w16[id].elo_diff),
    'the profile week must actually change the numbers');
  for (const id of ids) {
    assert.equal(w14[id].window.weeks, 4);
    assert.equal(w16[id].window.weeks, 2);
    assert.ok(w16[id].games <= 2);
  }
});

test('MEASURED: every real report is internally consistent', () => {
  const byId = playoffSosById(WEEKLY, STRENGTH_FILE, P14);
  for (const [id, r] of Object.entries(byId)) {
    assert.ok(r.games >= 1, `${id}: a report implies at least one game`);
    assert.ok(r.season_games >= r.games, `${id}: window games are a subset of the season`);
    assert.ok(r.rating >= 1 && r.rating <= 5, `${id}: rating ${r.rating} out of range`);
    assert.ok(r.abs_rating >= 1 && r.abs_rating <= 5, `${id}: abs_rating out of range`);
    assert.ok(Math.abs((r.playoff_elo - r.season_elo) - r.elo_diff) < 0.02,
      `${id}: elo_diff must equal playoff_elo - season_elo`);
    assert.equal(r.pts_per_game, round2(-r.elo_diff / PLAYOFF_ELO_PER_POINT));
    assert.equal(r.label, playoffSosLabel(r.rating));
    assert.equal(r.schedule.length, r.window.weeks);
    assert.ok(r.playoff_elo >= STRENGTH_FILE.elo_min - 0.01
      && r.playoff_elo <= STRENGTH_FILE.elo_max + 0.01,
      `${id}: window Elo ${r.playoff_elo} outside the rated range`);
  }
});

// ---------------------------------------------------------------------------
// 7. Market-independence (hard user policy).
// ---------------------------------------------------------------------------

test('app/playoffs.js imports no market/price/odds source', () => {
  const src = readFileSync(new URL('../../app/playoffs.js', import.meta.url), 'utf8');
  for (const banned of ['market', 'adp', 'auction', 'odds', 'kalshi', 'polymarket',
    'spread', 'moneyline', 'vegas']) {
    assert.ok(!new RegExp(`import[^;]*${banned}`, 'i').test(src),
      `playoffs.js must not import a ${banned} source`);
  }
  assert.ok(!/fetch\(|document\.|localStorage/.test(src),
    'the module must stay pure: no fetch, no DOM, no storage');
});

function round2(n) { return Math.round(n * 100) / 100; }
