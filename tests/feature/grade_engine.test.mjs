/* tests/feature/grade_engine.test.mjs — R41: the TEAM GRADE engine, locked.
 *
 * The paste parser's honesty contract (unmatched is listed, never guessed;
 * ambiguity never matches), the lineup grader's EMPTY-slot honesty, and the
 * Monte Carlo's invariants (deterministic under a seed; probability mass adds
 * up; a stronger team is never worse off).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normName, stripHtml, parseBlocks, cleanLine, buildIndex, matchLine,
  buildLeague, gradeTeam, percentile, letterFor, syntheticFieldTotals,
  simulateLeague, mulberry32, DEFAULT_SHAPE,
} from "../../app/grade.js";

const POOL = [
  { gsis_id: "1", name: "Josh Allen", position: "QB" },
  { gsis_id: "2", name: "Bijan Robinson", position: "RB" },
  { gsis_id: "3", name: "Kenneth Walker III", position: "RB" },
  { gsis_id: "4", name: "Puka Nacua", position: "WR" },
  { gsis_id: "5", name: "CeeDee Lamb", position: "WR" },
  { gsis_id: "6", name: "Sam LaPorta", position: "TE" },
  { gsis_id: "7", name: "Jaylen Warren", position: "RB" },
  { gsis_id: "8", name: "Michael Pittman Jr.", position: "WR" },
];
const PTS = { 1: 320, 2: 280, 3: 240, 4: 260, 5: 250, 6: 180, 7: 150, 8: 200 };
const projOf = (p) => PTS[p.gsis_id] || 0;

/* ------------------------------------------------------------- parsing */

test("plain lines with a header block become a named team; suffixes and noise match", () => {
  const text = "My Squad:\n1. Josh Allen QB BUF\nKenneth Walker - SEA\nPuka Nacua (Q)\nNobody Real";
  const { teams } = buildLeague(text, POOL);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].name, "My Squad:".replace(":", "") || "My Squad");
  assert.deepEqual(teams[0].players.map((p) => p.gsis_id), ["1", "3", "4"]);
  assert.deepEqual(teams[0].unmatched, ["Nobody Real"],
    "an unmatched line is LISTED, never guessed");
});

test("a headerless paste stays one full roster — the first player is not eaten as a name", () => {
  const { teams } = buildLeague("Josh Allen\nBijan Robinson", POOL);
  assert.equal(teams.length, 1);
  assert.deepEqual(teams[0].players.map((p) => p.gsis_id), ["1", "2"]);
});

test("blank-line blocks become separate teams", () => {
  const text = "Team A:\nJosh Allen\n\nTeam B:\nBijan Robinson\n\nTeam C:\nPuka Nacua";
  const { teams } = buildLeague(text, POOL);
  assert.deepEqual(teams.map((t) => t.players.length), [1, 1, 1]);
  assert.equal(teams[1].name.startsWith("Team B"), true);
});

test("JSON shapes: array of names, object map, and array of team objects", () => {
  assert.deepEqual(
    buildLeague('["Josh Allen", "Puka Nacua"]', POOL).teams[0].players.map((p) => p.gsis_id),
    ["1", "4"]);
  const map = buildLeague('{"Alpha": ["Josh Allen"], "Beta": ["CeeDee Lamb"]}', POOL);
  assert.deepEqual(map.teams.map((t) => t.name), ["Alpha", "Beta"]);
  const arr = buildLeague(
    '[{"team": "X", "players": [{"name": "Sam LaPorta"}]}]', POOL);
  assert.deepEqual(arr.teams[0].players.map((p) => p.gsis_id), ["6"]);
});

test("HTML is stripped to lines before parsing", () => {
  const html = "<table><tr><td>Josh Allen</td></tr><tr><td>Bijan Robinson</td></tr></table>";
  const { teams } = buildLeague(html, POOL);
  assert.deepEqual(teams[0].players.map((p) => p.gsis_id), ["1", "2"]);
});

test("an ambiguous pool name can never match (wrong beats missing, so neither)", () => {
  const pool = [...POOL,
    { gsis_id: "9a", name: "Lamar Jackson", position: "QB" },
    { gsis_id: "9b", name: "Lamar Jackson", position: "CB" }];
  const idx = buildIndex(pool);
  assert.equal(matchLine("Lamar Jackson", idx), null);
});

test("duplicate lines for one player fold to a single roster entry", () => {
  const { teams } = buildLeague("Josh Allen\nJosh Allen QB", POOL);
  assert.equal(teams[0].players.length, 1);
});

/* ------------------------------------------------------------- grading */

test("gradeTeam fills the shape optimally and reports EMPTY honestly", () => {
  const g = gradeTeam(POOL, projOf);
  // QB1=320, RB: 280+240, WR: 260+250, TE: 180, FLEX best leftover = WR 200
  assert.equal(g.total, 320 + 280 + 240 + 260 + 250 + 180 + 200);
  const flex = g.starters.find((s) => s.slot === "FLEX");
  assert.equal(flex.name, "Michael Pittman Jr.");
  const thin = gradeTeam([POOL[0]], projOf); // QB only
  assert.equal(thin.starters.filter((s) => s.empty).length,
    Object.entries(DEFAULT_SHAPE).reduce((a, [k, v]) => a + v, 0) - 1,
    "every unfillable slot is an explicit EMPTY, scored 0 — never invented");
});

test("percentile + letter bands behave at the edges", () => {
  assert.equal(percentile(10, [1, 2, 3]), 100);
  assert.equal(percentile(0, [1, 2, 3]), 0);
  assert.equal(letterFor(95), "A+");
  assert.equal(letterFor(10), "F");
  assert.equal(letterFor(null), "—");
});

test("syntheticFieldTotals: deterministic, need-aware, and a BALANCED field", () => {
  const bigPool = Array.from({ length: 120 }, (_, i) => ({
    gsis_id: `p${i}`, name: `P ${i}`,
    position: ["QB", "RB", "WR", "TE"][i % 4],
  }));
  const pts = (p) => 300 - Number(p.gsis_id.slice(1));
  const a = syntheticFieldTotals(bigPool, pts);
  const b = syntheticFieldTotals(bigPool, pts);
  assert.deepEqual(a, b, "same pool, same field — no hidden randomness");
  assert.equal(a.length, 10);
  assert.ok(a.every((t) => t > 0), "every synthetic seat fields a real lineup");
  // Need-aware snake drafting must produce a competitive field, not a strawman
  // ladder: the spread stays tight relative to the mean. (A straight-down
  // snake overdrafted one position into unfillable lineups — the original bug
  // this fixture caught.)
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const spread = Math.max(...a) - Math.min(...a);
  assert.ok(spread < 0.1 * mean,
    `field spread ${spread} vs mean ${mean} — a lopsided synthetic league grades everyone wrong`);
});

/* ----------------------------------------------------------- simulation */

test("simulateLeague is deterministic under a seed and its probability mass adds up", () => {
  const teams = [
    { name: "A", weeklyMean: 120 }, { name: "B", weeklyMean: 110 },
    { name: "C", weeklyMean: 100 }, { name: "D", weeklyMean: 95 },
    { name: "E", weeklyMean: 90 }, { name: "F", weeklyMean: 85 },
    { name: "G", weeklyMean: 80 }, { name: "H", weeklyMean: 75 },
  ];
  const r1 = simulateLeague(teams, { sims: 500, seed: 7 });
  const r2 = simulateLeague(teams, { sims: 500, seed: 7 });
  assert.deepEqual(r1, r2, "same seed, same season");
  const playoffMass = r1.reduce((a, t) => a + t.playoff, 0);
  const titleMass = r1.reduce((a, t) => a + t.title, 0);
  assert.ok(Math.abs(playoffMass - 6) < 0.02, `playoff mass ${playoffMass} != 6 slots`);
  assert.ok(Math.abs(titleMass - 1) < 0.02, `title mass ${titleMass} != 1`);
});

test("a clearly stronger team gets clearly better odds", () => {
  const teams = [
    { name: "STRONG", weeklyMean: 140 }, { name: "MID1", weeklyMean: 100 },
    { name: "MID2", weeklyMean: 100 }, { name: "WEAK", weeklyMean: 70 },
  ];
  const r = simulateLeague(teams, { sims: 1000, seed: 3 });
  const by = Object.fromEntries(r.map((t) => [t.name, t]));
  assert.ok(by.STRONG.playoff > by.WEAK.playoff + 0.2);
  assert.ok(by.STRONG.title > by.WEAK.title);
});

test("fewer than two teams returns honest nulls, not fake certainty", () => {
  const r = simulateLeague([{ name: "SOLO", weeklyMean: 100 }]);
  assert.deepEqual(r, [{ name: "SOLO", playoff: null, title: null, avgWins: null }]);
});

test("mulberry32 stays in [0,1) and repeats under a seed", () => {
  const a = mulberry32(42); const b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.ok(x >= 0 && x < 1);
    assert.equal(x, b());
  }
});

/* ------------------------------------------------------------- wiring */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("the GRADE route, tab and lazy-load are wired (and stay off the boot path)", () => {
  const main = readFileSync(join(REPO_ROOT, "app/main.js"), "utf8");
  assert.match(main, /'#\/grade': \{ mount: mountGrade, tab: 'grade', name: 'Grade' \}/);
  assert.match(main, /import\('\.\/views\/grade\.js'\)/, "grade must be a LAZY import");
  const html = readFileSync(join(REPO_ROOT, "index.html"), "utf8");
  assert.match(html, /href="#\/grade" data-tab="grade">Grade</);
  const budget = readFileSync(join(REPO_ROOT, "tests/perf/budget.spec.mjs"), "utf8");
  assert.match(budget, /'app\/views\/grade\.js'/);
  assert.match(budget, /'app\/grade\.js'/);
});

test("rookies-only filters are wired on PLAYERS and TEAM, hidden when the flag is unknown", () => {
  const pl = readFileSync(join(REPO_ROOT, "app/views/players.js"), "utf8");
  assert.match(pl, /typeof p\.rookie === 'boolean'/,
    "PLAYERS must feature-detect the flag — a filter over unknowns lies");
  assert.match(pl, /p\.rookie === true/,
    "the filter must exclude unknowns, not just non-rookies");
  const tm = readFileSync(join(REPO_ROOT, "app/views/team.js"), "utf8");
  assert.match(tm, /typeof p\.rookie === 'boolean'/);
  assert.match(tm, /finderRookies && p\.rookie !== true/);
});
