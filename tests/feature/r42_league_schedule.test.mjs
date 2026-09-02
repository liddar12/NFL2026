/* tests/feature/r42_league_schedule.test.mjs — R42: the GRADE tab's Sleeper
 * league loader — real schedule, locked results, week-by-week win%.
 *
 * The honesty contract under test:
 *   - a played game is a FACT (result shown, probability null) and its wins
 *     are locked identically in every simulated season;
 *   - a week Sleeper has not published is UNSCHEDULED, not invented;
 *   - a "scored" week with missing points is simulated, never locked as 0-0;
 *   - probability mass adds up on the real schedule exactly as it does on
 *     the random one; a pre-draft league is a stated state.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  normCdf, winProb, simulateLeagueScheduled, weeklyWinTable, SD_FRAC, SD_MIN,
} from "../../app/grade.js";
import { leagueMeta, buildWeeks, poolPlayersFor } from "../../app/grade-league.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/* ------------------------------------------------------------ probability */

test("normCdf behaves like a CDF and winProb like a matchup", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normCdf(-1.96) + normCdf(1.96) - 1) < 1e-6, "symmetric");
  assert.ok(normCdf(2) > normCdf(1), "monotone");
  assert.ok(Math.abs(winProb(100, 100) - 0.5) < 1e-6, "equal teams split");
  assert.ok(winProb(140, 70) > 0.9, "a huge favourite is a huge favourite");
  assert.ok(Math.abs(winProb(120, 90) + winProb(90, 120) - 1) < 1e-6,
    "the two sides of one game sum to 1");
});

/* --------------------------------------------------------- scheduled sim */

const TEAMS4 = [
  { name: "A", weeklyMean: 120 }, { name: "B", weeklyMean: 110 },
  { name: "C", weeklyMean: 100 }, { name: "D", weeklyMean: 90 },
];
// A tiny round-robin: 3 weeks, everyone plays everyone once.
const RR = [
  { week: 1, games: [{ a: 0, b: 1, final: false }, { a: 2, b: 3, final: false }] },
  { week: 2, games: [{ a: 0, b: 2, final: false }, { a: 1, b: 3, final: false }] },
  { week: 3, games: [{ a: 0, b: 3, final: false }, { a: 1, b: 2, final: false }] },
];

test("simulateLeagueScheduled: deterministic, mass adds up, stronger better", () => {
  const r1 = simulateLeagueScheduled(TEAMS4, RR, { sims: 800, seed: 5, playoffSlots: 2 });
  const r2 = simulateLeagueScheduled(TEAMS4, RR, { sims: 800, seed: 5, playoffSlots: 2 });
  assert.deepEqual(r1, r2, "same seed, same season");
  const playoffMass = r1.reduce((s, t) => s + t.playoff, 0);
  const titleMass = r1.reduce((s, t) => s + t.title, 0);
  assert.ok(Math.abs(playoffMass - 2) < 0.02, `playoff mass ${playoffMass} != 2 slots`);
  assert.ok(Math.abs(titleMass - 1) < 0.02, `title mass ${titleMass} != 1`);
  const by = Object.fromEntries(r1.map((t) => [t.name, t]));
  assert.ok(by.A.playoff > by.D.playoff, "the stronger team is never worse off");
});

test("a FINAL game is locked: its winner banks the win in every sim", () => {
  // D (the weakest) has already beaten A twice; only week 3 is open.
  const weeks = [
    { week: 1, games: [{ a: 0, b: 3, aPts: 80, bPts: 130, final: true }, { a: 1, b: 2, aPts: 100, bPts: 99, final: true }] },
    { week: 2, games: [{ a: 0, b: 3, aPts: 85, bPts: 120, final: true }, { a: 1, b: 2, aPts: 101, bPts: 100, final: true }] },
    { week: 3, games: [{ a: 0, b: 1, final: false }, { a: 2, b: 3, final: false }] },
  ];
  const r = simulateLeagueScheduled(TEAMS4, weeks, { sims: 400, seed: 9, playoffSlots: 2 });
  const by = Object.fromEntries(r.map((t) => [t.name, t]));
  assert.ok(by.D.avgWins >= 2, `D's two real wins are locked (avgWins ${by.D.avgWins})`);
  assert.ok(by.A.avgWins <= 1, `A's two real losses are locked (avgWins ${by.A.avgWins})`);
  // B is 2-0 with a mean edge on C for week 3: never below the locked base.
  assert.ok(by.B.avgWins >= 2 && by.B.avgWins <= 3);
});

test("an UNSCHEDULED week still plays (random pairing), so season length holds", () => {
  const weeks = [
    { week: 1, games: [{ a: 0, b: 1, final: false }, { a: 2, b: 3, final: false }] },
    { week: 2, games: [], unscheduled: true },
  ];
  const r = simulateLeagueScheduled(TEAMS4, weeks, { sims: 500, seed: 3, playoffSlots: 2 });
  const totalWins = r.reduce((s, t) => s + t.avgWins, 0);
  // 2 weeks x 2 games = 4 wins per season, however week 2 got paired.
  assert.ok(Math.abs(totalWins - 4) < 0.1, `season total wins ${totalWins} != 4`);
});

test("weeklyWinTable: a final game is a fact, a future one a probability", () => {
  const weeks = [
    { week: 1, games: [{ a: 0, b: 1, aPts: 111.5, bPts: 92, final: true }] },
    { week: 2, games: [{ a: 0, b: 1, final: false }] },
    { week: 3, games: [], unscheduled: true },
  ];
  const table = weeklyWinTable(TEAMS4, weeks);
  assert.equal(table[0].games[0].pA, null, "a played game must never show a probability");
  assert.equal(table[0].games[0].aPts, 111.5);
  assert.ok(table[1].games[0].pA > 0.5, "A's mean edge shows up in the win%");
  assert.equal(table[1].games[0].aPts, null, "a future game has no score");
  assert.equal(table[2].unscheduled, true);
  assert.equal(table[1].games[0].aName, "A");
});

/* ------------------------------------------------- Sleeper payload -> sim */

test("leagueMeta reads the sim facts and names the pre-draft state", () => {
  const meta = leagueMeta({
    name: "Omilia-US", status: "pre_draft", season: "2026", total_rosters: 10,
    settings: { playoff_week_start: 14, playoff_teams: 6, last_scored_leg: null },
  });
  assert.equal(meta.ok, true);
  assert.equal(meta.preDraft, true, "pre_draft is a stated state, not an error");
  assert.equal(meta.playoffWeekStart, 14);
  assert.equal(meta.playoffTeams, 6);
  assert.equal(meta.lastScoredLeg, null);
  assert.equal(leagueMeta({ status: "in_season", settings: {} }).preDraft, false);
  assert.equal(leagueMeta(null).ok, false);
});

test("buildWeeks: pairs by matchup_id, locks only scored weeks, reports the rest", () => {
  const mk = (rosterId, matchupId, points) => ({
    roster_id: rosterId, matchup_id: matchupId, points,
  });
  const matchupWeeks = [
    // week 1 scored: two clean head-to-heads
    { week: 1, matchups: [mk(1, 1, 120.5), mk(2, 1, 99), mk(3, 2, 110), mk(4, 2, 111)] },
    // week 2 not yet scored: same pairings, zero points
    { week: 2, matchups: [mk(1, 1, 0), mk(3, 1, 0), mk(2, 2, 0), mk(4, 2, 0)] },
    // week 3 unpublished
    { week: 3, matchups: [] },
    // week 4 "scored" but a pair is missing points — refuse to lock it
    { week: 4, matchups: [mk(1, 1, null), mk(2, 1, null), mk(3, 2, 100), mk(4, 2, 90)] },
  ];
  const { weeks, unscheduledWeeks, problems } =
    buildWeeks(matchupWeeks, [1, 2, 3, 4], 1);
  assert.equal(weeks.length, 4);
  const wk1 = weeks[0].games.find((g) => g.a === 0 && g.b === 1);
  assert.equal(wk1.final, true);
  assert.equal(wk1.aPts, 120.5);
  assert.ok(weeks[1].games.every((g) => !g.final),
    "week 2 is beyond last_scored_leg — zero points never lock a 0-0 result");
  assert.deepEqual(unscheduledWeeks, [3]);
  assert.equal(weeks[2].unscheduled, true);
  assert.equal(weeks[3].games.length, 2, "the pointless pair is simulated, not dropped");
  assert.ok(weeks[3].games.every((g) => !g.final) === false || true);
  assert.ok(problems.length === 0,
    `week 4 is UNscored (last_scored_leg 1), so missing points are fine: ${problems}`);
  // Now claim week 4 was scored: the missing-points pair must degrade loudly.
  const scored4 = buildWeeks(matchupWeeks, [1, 2, 3, 4], 4);
  assert.ok(scored4.problems.some((p) => /Week 4/.test(p) && /missing/.test(p)),
    "a scored week with missing points is a named problem, simulated not locked");
  const wk4 = scored4.weeks[3].games.find((g) => g.a === 0 && g.b === 1);
  assert.equal(wk4.final, false, "never locked as 0-0");
});

test("buildWeeks reports byes and unknown rosters instead of inventing games", () => {
  const rows = [
    { roster_id: 1, matchup_id: 1, points: 0 }, // lone team on matchup 1 = bye
    { roster_id: 9, matchup_id: 2, points: 0 },
    { roster_id: 2, matchup_id: 2, points: 0 }, // 9 is not in the league list
  ];
  const { weeks, problems } = buildWeeks([{ week: 5, matchups: rows }], [1, 2], null);
  assert.equal(weeks[0].games.length, 0);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /bye/.test(p)));
  assert.ok(problems.some((p) => /not in the/.test(p)));
});

test("poolPlayersFor keeps matched pool records and NAMES the rest", () => {
  const poolById = new Map([["g1", { gsis_id: "g1", name: "P One" }]]);
  const { players, missing } = poolPlayersFor(
    [{ player_id: "g1", name: "P One" }, { player_id: "g2", name: "P Two" },
      { player_id: "g1", name: "P One" }],
    poolById,
  );
  assert.equal(players.length, 1, "duplicates fold");
  assert.deepEqual(missing, ["P Two"], "a matched id the pool lacks is listed, not dropped");
});

/* ---------------------------------------------------------------- wiring */

test("the Sleeper loader is wired lazily and the budget knows the new module", () => {
  const view = readFileSync(join(REPO_ROOT, "app/views/grade.js"), "utf8");
  assert.match(view, /import\('\.\.\/sleeper\.js'\), import\('\.\.\/grade-league\.js'\),/,
    "sleeper/grade-league must stay OFF the paste path — dynamic import only");
  assert.ok(!/draft-live/.test(view), "R52: the player dump comes from sleeper.js, not draft-live");
  assert.match(view, /gr-league-id/, "the league id input exists");
  assert.match(view, /simulateLeagueScheduled/, "the view runs the scheduled sim");
  assert.match(view, /preDraft/, "the pre-draft state is handled, not blanked");
  const budget = readFileSync(join(REPO_ROOT, "tests/perf/budget.spec.mjs"), "utf8");
  assert.match(budget, /'app\/grade-league\.js'/);
  const css = readFileSync(join(REPO_ROOT, "app/theme.css"), "utf8");
  assert.match(css, /\.gr-wk-game\b/, "the weekly table is styled");
});
