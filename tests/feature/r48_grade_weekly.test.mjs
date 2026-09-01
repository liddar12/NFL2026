/* tests/feature/r48_grade_weekly.test.mjs — R48-C: the GRADE tab's Sleeper
 * loader seats the BENCH week by week and ends on projected final standings.
 *
 * The honesty contract under test:
 *   - the optimizer sees the FULL roster, so a bench player covers a
 *     starter's bye (or injury) and the bye player is counted, not started;
 *   - K/DEF points come from the kdst index (the league's own scoring on the
 *     contract's stat line), never from a proj_points conversion;
 *   - an unfillable slot is EMPTY: it holds nobody, adds nothing, is reported;
 *   - on the real P.T.I. schedule: wins sum to games played, PF equals PA
 *     across the league, playoff mass equals the slot count, best-record and
 *     title mass each equal 1, the run is deterministic for a seed, and a
 *     locked FINAL game is a fact in every simulated season;
 *   - the view renders the standings table and labels the engine honestly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  teamWeekPoints, seasonTable, simulateSeasonWeekly,
} from "../../app/grade-weekly.js";
import { buildWeeks, leagueMeta } from "../../app/grade-league.js";
import { mapMatchups } from "../../app/sleeper.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = join(REPO_ROOT, "tests/fixtures/sleeper_pti");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/* ------------------------------------------------------------- fixtures */

/** 18 weekly rows: 10 pts a week, hard 0 on the bye. */
const wk = (byeWk, pts = 10) => Array.from({ length: 18 }, (_, i) => ({
  wk: i + 1, bye: i + 1 === byeWk, pts: i + 1 === byeWk ? 0 : pts,
}));
const weeklyRow = (id, byeWk, pts) => [id, { gsis_id: id, receptions_prior: 0, weeks: wk(byeWk, pts) }];

const SEVEN = { shape: { roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "BN", "BN", "BN"] } };
const WITH_KD = {
  shape: { roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN"] },
};

const ROSTER = [
  { gsis_id: "qbA", name: "QB A", position: "QB", proj_points: 340 },
  { gsis_id: "qbB", name: "QB B", position: "QB", proj_points: 170 },
  { gsis_id: "rb1", name: "RB 1", position: "RB", proj_points: 170 },
  { gsis_id: "wr1", name: "WR 1", position: "WR", proj_points: 170 },
  { gsis_id: "te1", name: "TE 1", position: "TE", proj_points: 170 },
];
const WEEKLY = new Map([
  weeklyRow("qbA", 2, 20), weeklyRow("qbB", 5, 10),
  weeklyRow("rb1", 7), weeklyRow("wr1", 7), weeklyRow("te1", 7),
]);

/* --------------------------------------------------------- teamWeekPoints */

test("the bench covers a starter's bye: the bench QB starts, the bye QB is counted", () => {
  const r = teamWeekPoints({
    rosterPlayers: ROSTER, week: 2, profile: SEVEN, weeklyById: WEEKLY, kdstIndex: null, feeds: [],
  });
  assert.equal(r.lineup.slots.QB1, "qbB", "the bench QB is seated over the bye starter");
  assert.equal(r.byeCount, 1);
  assert.deepEqual(r.byes, ["qbA"]);
  assert.equal(r.total, 10 + 10 + 10 + 10, "total is exactly the seated points");
  // In a non-bye week the better QB starts again — the swap is per week.
  const r1 = teamWeekPoints({
    rosterPlayers: ROSTER, week: 1, profile: SEVEN, weeklyById: WEEKLY, kdstIndex: null, feeds: [],
  });
  assert.equal(r1.lineup.slots.QB1, "qbA");
  assert.equal(r1.total, 20 + 30);
  assert.equal(r1.byeCount, 0);
});

test("an unavailable starter is benched for the week and named", () => {
  const weekly = new Map(WEEKLY);
  const hurt = { ...weekly.get("qbA"), weeks: wk(2, 20).map((w) => (w.wk === 1 ? { ...w, avail: false } : w)) };
  weekly.set("qbA", hurt);
  const r = teamWeekPoints({
    rosterPlayers: ROSTER, week: 1, profile: SEVEN, weeklyById: weekly, kdstIndex: null, feeds: [],
  });
  assert.equal(r.lineup.slots.QB1, "qbB");
  assert.deepEqual(r.unavailable, ["qbA"]);
  assert.equal(r.rows.find((x) => x.id === "qbA").pts, 0, "an unavailable week is 0 for display");
});

test("K/DEF points come from the kdst index, never from proj_points", () => {
  const kdstIndex = {
    positions: ["K", "DEF"],
    byId: new Map([
      ["00-0001", { id: "00-0001", name: "K One", team: "HOU", pos: "K", weeklyPoints: 8.5, unscored: false }],
      ["DST-DEN", { id: "DST-DEN", name: "Denver D/ST", team: "DEN", pos: "DEF", weeklyPoints: 7.2, unscored: false }],
    ]),
  };
  const roster = [
    ...ROSTER,
    // proj_points is a deliberately absurd number: it must never be read.
    { gsis_id: "00-0001", name: "K One", position: "K", proj_points: 999, kdst: {} },
    { gsis_id: "DST-DEN", name: "Denver D/ST", position: "DEF", proj_points: 999, kdst: {} },
  ];
  const byeByTeam = new Map([["DEN", 9]]);
  const feeds = ["K", "DEF", "DST"];
  const r = teamWeekPoints({
    rosterPlayers: roster, week: 1, profile: WITH_KD, weeklyById: WEEKLY, kdstIndex, feeds, byeByTeam,
  });
  assert.equal(r.lineup.slots.K1, "00-0001");
  assert.equal(r.lineup.slots.DEF1, "DST-DEN");
  assert.equal(r.rows.find((x) => x.id === "00-0001").pts, 8.5);
  assert.equal(r.rows.find((x) => x.id === "DST-DEN").pts, 7.2);
  assert.equal(r.total, 20 + 30 + 8.5 + 7.2);
  assert.ok(r.rows.find((x) => x.id === "00-0001").seasonAvg, "a kdst week is flagged as a season average");
  // The defence's bye comes from the schedule map, not from a weekly row it does not have.
  const bye = teamWeekPoints({
    rosterPlayers: roster, week: 9, profile: WITH_KD, weeklyById: WEEKLY, kdstIndex, feeds, byeByTeam,
  });
  assert.ok(bye.byes.includes("DST-DEN"));
  assert.equal(bye.rows.find((x) => x.id === "DST-DEN").pts, 0);
  // A K/DEF id the index does not carry has NO projection — never a converted number.
  const orphan = teamWeekPoints({
    rosterPlayers: [...ROSTER, { gsis_id: "00-9999", name: "K Nobody", position: "K", proj_points: 999 }],
    week: 1, profile: WITH_KD, weeklyById: WEEKLY, kdstIndex, feeds, byeByTeam,
  });
  assert.deepEqual(orphan.noProjection, ["00-9999"]);
  assert.equal(orphan.rows.find((x) => x.id === "00-9999").pts, 0);
  assert.equal(orphan.total, 20 + 30, "an unpriced kicker adds nothing");
});

test("an empty slot contributes nothing and is reported as EMPTY, never 0.0", () => {
  const noTe = ROSTER.filter((p) => p.position !== "TE");
  const r = teamWeekPoints({
    rosterPlayers: noTe, week: 1, profile: SEVEN, weeklyById: WEEKLY, kdstIndex: null, feeds: [],
  });
  assert.equal(r.lineup.slots.TE1, null);
  assert.ok(r.empty.includes("TE1"), "the unfillable slot is named");
  assert.ok(r.empty.includes("FLEX"), "with four players the flex is empty too");
  assert.equal(r.total, 20 + 10 + 10, "the empty slots add nothing");
});

test("seasonTable: one weekly total per regular-season week, per team", () => {
  const weeks = [1, 2, 3].map((week) => ({ week, games: [], unscheduled: true }));
  const table = seasonTable(
    [{ name: "T1", players: ROSTER }, { name: "T2", players: ROSTER.slice(1) }],
    weeks, { profile: SEVEN, weeklyById: WEEKLY, kdstIndex: null, feeds: [] },
  );
  assert.equal(table.length, 2);
  assert.deepEqual(table[0].totals, [50, 40, 50], "week 2 is the bye-covered week");
  assert.equal(table[0].seasonTotal, 140);
  assert.equal(table[0].weeks[1].byeCount, 1);
  assert.deepEqual(table[1].totals, [40, 40, 40], "T2 has only the backup QB");
});

/* ---------------------------------------------- the P.T.I. league, for real */

function ptiWeeks(lastScoredLeg, mutate) {
  const league = readJson(join(FIX, "league.json"));
  const rosters = readJson(join(FIX, "rosters.json"));
  const meta = leagueMeta(league);
  const endWeek = (meta.playoffWeekStart || 14) - 1;
  const rosterIds = rosters.map((r) => r.roster_id).sort((a, b) => a - b);
  const matchupWeeks = [];
  for (let w = 1; w <= endWeek; w++) {
    const payload = readJson(join(FIX, `matchups_${w}.json`));
    if (mutate) mutate(w, payload);
    matchupWeeks.push({ week: w, matchups: mapMatchups(payload, w).matchups });
  }
  return { meta, rosterIds, ...buildWeeks(matchupWeeks, rosterIds, lastScoredLeg) };
}

/** Deterministic synthetic weekly means: 10 teams x 14 weeks, no two alike. */
const ptiTotals = (n, W) => Array.from({ length: n }, (_, i) => Array.from(
  { length: W }, (_, w) => 95 + i * 4 + ((i + w) % 3) * 5,
));

test("P.T.I.: 10 teams, 14 real weeks, nothing final yet", () => {
  const { meta, weeks, unscheduledWeeks, problems } = ptiWeeks(null);
  assert.equal(meta.totalRosters, 10);
  assert.equal(meta.lastScoredLeg, null, "the fixture is captured before week 1 scored");
  assert.equal(weeks.length, 14);
  assert.deepEqual(unscheduledWeeks, []);
  assert.deepEqual(problems, []);
  assert.ok(weeks.every((wk) => wk.games.length === 5 && wk.games.every((g) => !g.final)));
});

test("simulateSeasonWeekly on P.T.I.: conservation, mass, ordering, determinism", () => {
  const { weeks, rosterIds } = ptiWeeks(null);
  const teams = rosterIds.map((id) => ({ name: `Roster ${id}` }));
  const totals = ptiTotals(teams.length, weeks.length);
  const opts = { sims: 1500, seed: 48, playoffSlots: 6 };
  const r = simulateSeasonWeekly(teams, weeks, totals, opts);
  assert.equal(r.teams.length, 10);
  assert.equal(r.seed, 48, "the seed is exposed");
  assert.equal(r.playoffSlots, 6);

  const gamesPlayed = weeks.reduce((s, wk) => s + wk.games.length, 0);
  const wins = r.teams.reduce((s, t) => s + t.wins, 0);
  const losses = r.teams.reduce((s, t) => s + t.losses, 0);
  assert.ok(Math.abs(wins - gamesPlayed) < 0.06, `wins ${wins} != games ${gamesPlayed}`);
  assert.ok(Math.abs(losses - gamesPlayed) < 0.06, `losses ${losses} != games ${gamesPlayed}`);
  for (const t of r.teams) {
    assert.ok(Math.abs(t.wins + t.losses - 14) < 0.02, `${t.name} plays 14 games`);
  }
  const pf = r.teams.reduce((s, t) => s + t.pf, 0);
  const pa = r.teams.reduce((s, t) => s + t.pa, 0);
  assert.ok(Math.abs(pf - pa) < 1, `PF ${pf} must equal PA ${pa} across the league`);
  const playoffMass = r.teams.reduce((s, t) => s + t.playoff, 0);
  const regMass = r.teams.reduce((s, t) => s + t.regSeasonTitle, 0);
  const titleMass = r.teams.reduce((s, t) => s + t.title, 0);
  assert.ok(Math.abs(playoffMass - 6) < 0.01, `playoff mass ${playoffMass}`);
  assert.ok(Math.abs(regMass - 1) < 0.01, `best-record mass ${regMass}`);
  assert.ok(Math.abs(titleMass - 1) < 0.01, `title mass ${titleMass}`);

  // The strongest projected team is never worse off than the weakest.
  assert.ok(r.teams[9].playoff > r.teams[0].playoff);
  assert.ok(r.teams[9].wins > r.teams[0].wins);
  // Standings are ordered by wins, then points, and ranked 1..10.
  assert.deepEqual(r.standings.map((s) => s.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (let i = 1; i < r.standings.length; i++) {
    const a = r.standings[i - 1]; const b = r.standings[i];
    assert.ok(a.wins > b.wins || (a.wins === b.wins && a.pf >= b.pf), "ordered by wins then PF");
  }
  // Same seed, same season — byte for byte.
  assert.deepEqual(simulateSeasonWeekly(teams, weeks, totals, opts), r);
  assert.notDeepEqual(simulateSeasonWeekly(teams, weeks, totals, { ...opts, seed: 49 }).teams, r.teams,
    "a different seed is a different draw");
});

test("a locked FINAL game is counted as real in every simulated season", () => {
  // Week 1 scored: roster 1 beat its opponent 150-50; everyone else 100-90 by roster order.
  const { weeks, rosterIds } = ptiWeeks(1, (w, payload) => {
    if (w !== 1) return;
    const seen = new Map();
    for (const row of payload) {
      const first = !seen.has(row.matchup_id);
      seen.set(row.matchup_id, true);
      row.points = row.roster_id === 1 ? 150 : (first ? 100 : (row.matchup_id === payload.find((x) => x.roster_id === 1).matchup_id ? 50 : 90));
    }
  });
  assert.ok(weeks[0].games.every((g) => g.final), "week 1 is locked");
  assert.ok(weeks.slice(1).every((wk) => wk.games.every((g) => !g.final)));
  const teams = rosterIds.map((id) => ({ name: `Roster ${id}` }));
  const r = simulateSeasonWeekly(teams, weeks, ptiTotals(10, 14), { sims: 300, seed: 7, playoffSlots: 6 });
  const g = weeks[0].games.find((x) => x.a === 0 || x.b === 0);
  const me = r.teams[0];
  const opp = r.teams[g.a === 0 ? g.b : g.a];
  assert.ok(me.wins >= 1, `roster 1's real win is banked (wins ${me.wins})`);
  assert.ok(opp.losses >= 1, `its opponent's real loss is banked (losses ${opp.losses})`);
  assert.ok(me.pf >= 150 && opp.pa >= 150, "the real points are in PF/PA");
  // Locked results never change between sims: rerun with more sims, same base.
  const r2 = simulateSeasonWeekly(teams, weeks, ptiTotals(10, 14), { sims: 900, seed: 7, playoffSlots: 6 });
  assert.ok(r2.teams[0].wins >= 1 && r2.teams[0].pf >= 150);
});

/* ---------------------------------------------------------------- wiring */

test("the GRADE view runs the weekly engine, renders the standings and labels the engine", () => {
  const view = readFileSync(join(REPO_ROOT, "app/views/grade.js"), "utf8");
  assert.match(view, /seasonTable\(/, "the loader builds weekly-optimal totals from the FULL roster");
  assert.match(view, /simulateSeasonWeekly\(/, "the season sim uses each week's own mean");
  assert.match(view, /PROJECTED FINAL STANDINGS · ESTIMATE/);
  assert.match(view, /gr-standings/);
  assert.match(view, /Most likely regular-season winner: /);
  assert.match(view, /Most likely champion: /);
  assert.match(view, /<details/, "weekly lineups sit behind a disclosure");
  assert.match(view, /projected season pts from weekly optimal lineups/);
  assert.match(view, /AI = our projections; AI\+ = priced under your league's scoring table; self-learning signals are at weight 0 until they clear never-regress, so they move nothing here yet\./);
  assert.match(view, /This league fields no K slot, so no kicker is graded\./);
  assert.match(view, /gr-empty">EMPTY/, "an unfillable slot reads EMPTY");
  assert.ok(!/gr-empty">[^<]*0\.0/.test(view),
    "no rendered EMPTY slot carries a fabricated 0.0 (league card or paste card)");
  assert.match(view, /spread evenly/, "the K/DEF season-average spread is said out loud");
  const budget = readFileSync(join(REPO_ROOT, "tests/perf/budget.spec.mjs"), "utf8");
  assert.match(budget, /'app\/grade-weekly\.js'/, "the new module is lazy-only");
  const css = readFileSync(join(REPO_ROOT, "app/theme.css"), "utf8");
  assert.match(css, /\.gr-standings\b/, "the standings table is styled");
});
