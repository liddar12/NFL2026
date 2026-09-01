/* tests/feature/r40_hardening.test.mjs — R40: the composite builders survive
 * one dead roster page, and honest absence is visible on PLAYERS.
 *
 * Context: ESPN 404'd one team's roster page (2026-09-01) and while R39 had
 * already saved the CORE build, build_oline/build_defense — separate code on
 * the same endpoint — still failed wholesale and shipped `degraded, rows 0`
 * with the last-good composites. Their skip cap is 2, TIGHTER than roster
 * ages' 4, because the composite contracts carry `teams.minProperties: 30`:
 * more skips could not write a valid document honestly.
 *
 * And: a top-100-ADP skill player with no prior-season production carries no
 * projection — correct — but was silently invisible on PLAYERS, which reads
 * as "not draft-relevant". The UNRANKED strip names the absence and says why.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { unrankedHighAdp, renderUnranked } from "../../app/views/players.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function py(body) {
  const out = execFileSync("python3", ["-"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

/* ==========================================================================
   1. Builder source pins — the per-team skip, its cap, and the loud name
   ========================================================================== */

for (const rel of ["scripts/build_oline.py", "scripts/build_defense.py"]) {
  test(`${rel}: one dead roster page skips ONE team, capped at the contract floor`, () => {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.match(src, /except FeedError as exc:\s*\n\s*skipped\.append\(ab\)/,
      "a single team's FeedError must be caught per-team, not kill the build");
    assert.match(src, /\[warn\].*skipped/,
      "a skipped team must be named loudly on stderr");
    assert.match(src, /if len\(skipped\) > 2:/,
      "the cap is 2 — teams.minProperties is 30, so a 3rd skip cannot write "
      + "a valid document and must raise");
    assert.match(src, /skipped.*roster page unreachable/s,
      "the written doc's source must name the skipped team(s)");
  });
}

test("the composite schemas' floor (30) is what the cap encodes", () => {
  for (const f of ["oline_composite", "defense_composite"]) {
    const s = JSON.parse(
      readFileSync(join(REPO_ROOT, `data/contracts/${f}.schema.json`), "utf8"),
    );
    assert.equal(s.properties.teams.minProperties, 30,
      `${f}: if this floor moves, the builders' skip cap (32 - floor) must move with it`);
  }
});

/* ==========================================================================
   2. UNRANKED strip — honest absence, driven by the pure function
   ========================================================================== */

const ADP = [
  { name: "Jeremiyah Love", position: "RB", team: "ARI", adp: 27.4 },
  { name: "Kenneth Walker", position: "RB", team: "SEA", adp: 21.3 },
  { name: "David Sills", position: "WR", team: "TB", adp: 88.0 },
  { name: "Somebody Deep", position: "WR", team: "GB", adp: 180.0 },
  { name: "A Kicker", position: "K", team: "KC", adp: 90.0 },
];
const POOL = [
  { name: "Kenneth Walker III" },  // suffix must not defeat the join
  { name: "David Sills V" },
];

test("unrankedHighAdp finds only genuinely missing top-100 skill players", () => {
  const rows = unrankedHighAdp(ADP, POOL, 100);
  assert.deepEqual(rows.map((r) => r.name), ["Jeremiyah Love"],
    "suffix variants must match the pool; K and deep-ADP players are out of scope");
  assert.equal(rows[0].adp, 27.4);
});

test("the strip renders the absence with the WHY, and never a fabricated number", () => {
  const html = renderUnranked(unrankedHighAdp(ADP, POOL, 100));
  assert.match(html, /NOT IN RANKINGS/);
  assert.match(html, /Jeremiyah Love/);
  assert.match(html, /MARKET · DISPLAY ONLY/,
    "ADP shown under the one app-wide display-only convention");
  assert.match(html, /Absent is not zero/);
  assert.ok(!/\d+\.\d+ pts|proj_points/i.test(html),
    "the strip must never carry an invented projection number");
  assert.equal(renderUnranked([]), "", "nothing missing -> no strip at all");
});

test("the strip is wired into the PLAYERS mount and styled in both themes", () => {
  const src = readFileSync(join(REPO_ROOT, "app/views/players.js"), "utf8");
  assert.match(src, /renderUnranked\(unrankedRows\)/);
  assert.match(readFileSync(join(REPO_ROOT, "app/theme.css"), "utf8"), /\.unranked\b/);
  assert.match(readFileSync(join(REPO_ROOT, "app/theme-hig.css"), "utf8"),
    /\[data-theme="hig"\] \.unranked\b/);
});

/* ==========================================================================
   3. Committed-data invariant: nothing in the ADP top-100 skill rows is
      silently missing — every absence is one the strip would show
   ========================================================================== */

test("every top-100-ADP skill player is either ranked or visibly UNRANKED", () => {
  const adp = JSON.parse(readFileSync(join(REPO_ROOT, "data/adp.json"), "utf8"));
  const proj = JSON.parse(
    readFileSync(join(REPO_ROOT, "data/player_projections.json"), "utf8"),
  );
  const rows = unrankedHighAdp(adp.players || [], proj.players || [], 100);
  // Invariant, not a pin: the list may be empty (all ranked) or carry rookies,
  // but it must never be large — a double-digit gap means the pool build broke.
  assert.ok(rows.length <= 8,
    `unranked top-100 count ${rows.length} — the pool is missing too much of the draft market`);
});
