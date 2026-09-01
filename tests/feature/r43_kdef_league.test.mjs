/* tests/feature/r43_kdef_league.test.mjs — R43 (owner RCA): K/DEF and the
 * league's real shape reach the GRADE tab, and TEAM names WHY a Sleeper K/DEF
 * cannot seat instead of letting the miss read as an unknown player.
 *
 * The honesty contract:
 *   - the lineup shape comes from the SAVED league profile (falls back to the
 *     default only when no league is saved, and says so);
 *   - a K/DEF contract row grades with the league's OWN kdst number, never
 *     the offence scoring conversion;
 *   - a pool without K rows grades a K slot EMPTY — never an invented player;
 *   - kdstRows-empty misses on TEAM's roster sync carry the cause + the fix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  shapeFromRoster, gradeTeam, syntheticFieldTotals, canonPos,
  FLEX_ACCEPTS, DEFAULT_SHAPE,
} from "../../app/grade.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/* ---------------------------------------------------------------- shapes */

test("shapeFromRoster: league tokens in, grading shape out", () => {
  const shape = shapeFromRoster(
    ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DST", "BN", "BN"],
  );
  assert.deepEqual(shape, {
    QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER_FLEX: 1, K: 1, DEF: 1,
  }, "BN is not a starter; DST folds into DEF; flex tokens keep identity");
  assert.deepEqual(shapeFromRoster([]), DEFAULT_SHAPE,
    "no saved league -> the default shape, exactly as before R43");
  assert.equal(canonPos("dst"), "DEF");
});

/* --------------------------------------------------------------- grading */

const POOL = [
  { gsis_id: "q1", name: "QB One", position: "QB" },
  { gsis_id: "q2", name: "QB Two", position: "QB" },
  { gsis_id: "r1", name: "RB One", position: "RB" },
  { gsis_id: "w1", name: "WR One", position: "WR" },
  { gsis_id: "t1", name: "TE One", position: "TE" },
  { gsis_id: "00-0099", name: "K One", position: "K", proj_points: 140, kdst: {} },
  { gsis_id: "DST-DEN", name: "Denver D/ST", position: "DEF", proj_points: 120, kdst: {} },
];
const PTS = { q1: 320, q2: 250, r1: 200, w1: 190, t1: 150 };
const projOf = (p) => (p.kdst ? p.proj_points : PTS[p.gsis_id] || 0);

test("gradeTeam seats K/DEF and SUPER_FLEX from a league shape", () => {
  const shape = { QB: 1, RB: 1, WR: 1, TE: 1, SUPER_FLEX: 1, K: 1, DEF: 1 };
  const g = gradeTeam(POOL, projOf, shape);
  assert.equal(g.total, 320 + 200 + 190 + 150 + 250 + 140 + 120);
  const bySlot = Object.fromEntries(g.starters.map((s) => [s.slot, s]));
  assert.equal(bySlot.K.name, "K One");
  assert.equal(bySlot.DEF.name, "Denver D/ST");
  assert.equal(bySlot.SUPER_FLEX.name, "QB Two",
    "the flex takes the best leftover its eligibility allows");
  assert.equal(g.starters.filter((s) => s.empty).length, 0);
});

test("a pool without K rows grades the K slot EMPTY — never invented", () => {
  const offenceOnly = POOL.filter((p) => !p.kdst);
  const g = gradeTeam(offenceOnly, projOf, { QB: 1, K: 1, DEF: 1 });
  const bySlot = Object.fromEntries(g.starters.map((s) => [s.slot, s]));
  assert.equal(bySlot.QB.empty, undefined);
  assert.equal(bySlot.K.empty, true);
  assert.equal(bySlot.DEF.empty, true);
  assert.equal(g.total, 320, "an EMPTY slot scores 0, never a made-up number");
});

test("every flex token's eligibility is canonical positions only", () => {
  for (const [token, poss] of Object.entries(FLEX_ACCEPTS)) {
    assert.ok(poss.length >= 2, `${token} accepts at least two positions`);
    poss.forEach((p) => assert.equal(p, canonPos(p), `${token}: ${p} is canonical`));
  }
});

test("syntheticFieldTotals derives caps from the shape and fields K/DEF seats", () => {
  const bigPool = [];
  for (let i = 0; i < 30; i++) {
    bigPool.push({ gsis_id: `p${i}`, name: `P ${i}`, position: ["QB", "RB", "WR", "TE"][i % 4] });
  }
  for (let i = 0; i < 12; i++) {
    bigPool.push({ gsis_id: `k${i}`, name: `K ${i}`, position: "K", proj_points: 150 - i, kdst: {} });
    bigPool.push({ gsis_id: `d${i}`, name: `D ${i}`, position: "DEF", proj_points: 130 - i, kdst: {} });
  }
  const pts = (p) => (p.kdst ? p.proj_points : 300 - Number(p.gsis_id.slice(1)) * 3);
  const shape = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 };
  const a = syntheticFieldTotals(bigPool, pts, 10, null, shape);
  const b = syntheticFieldTotals(bigPool, pts, 10, null, shape);
  assert.deepEqual(a, b, "deterministic");
  assert.equal(a.length, 10);
  assert.ok(a.every((t) => t > 0));
  // 12 K and 12 DEF rows over 10 seats with cap 1 each: every synthetic team
  // must actually field its K and DEF (total strictly above offence-only).
  const offenceShape = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 };
  const off = syntheticFieldTotals(bigPool, pts, 10, null, offenceShape);
  for (let i = 0; i < 10; i++) {
    assert.ok(a[i] > off[i], `seat ${i}: K+DEF seats add real points to the field`);
  }
});

/* ---------------------------------------------------------------- wiring */

test("the GRADE view reads the saved league: shape, kdst pool, honest projOf", () => {
  const view = readFileSync(join(REPO_ROOT, "app/views/grade.js"), "utf8");
  assert.match(view, /loadProfile\(\)/, "the saved league profile drives the shape");
  assert.match(view, /shapeFromRoster\(starterTokens\)/);
  assert.match(view, /shapeKdst\(kdstDoc, profile\)/,
    "K/DEF numbers come from app/kdst.js under the league's OWN scoring");
  assert.match(view, /if \(e\.unscored\) continue;/,
    "an unscored row is refused a seat — no invented number");
  assert.match(view, /p\.kdst\s*\n?\s*\? \(Number\(p\.proj_points\) \|\| 0\)/,
    "a kdst row must NOT ride the offence scoring conversion");
  assert.ok(!/separate contract\)\./.test(view),
    "the old 'K/DEF excluded — separate contract' framing is retired");
  assert.match(view, /gradeTeam\(t\.players, projOf, shape\)/,
    "the paste path grades with the league shape");
  assert.match(view, /gradeTeam\(players, projOf, shape\)/,
    "the Sleeper path grades with the league shape");
});

test("TEAM's roster sync names WHY a K/DEF cannot seat, with the one-step fix", () => {
  const src = readFileSync(join(REPO_ROOT, "app/views/team.js"), "utf8");
  assert.match(src, /if \(kdstRows\.length === 0\) \{[\s\S]{0,700}missedKdst/,
    "the diagnosis runs exactly when the page handed over no K/DEF rows");
  assert.match(src, /fields no K\/DEF slot/);
  assert.match(src, /prices no K\/DEF stat/);
  assert.match(src, /Import your league from Sleeper in the LEAGUE panel above, SAVE it/);
});
