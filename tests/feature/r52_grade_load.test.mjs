/* tests/feature/r52_grade_load.test.mjs — R52: GRADE's LOAD is ONE pass.
 *
 * Owner RCA (desktop Safari, intermittent): LOAD LEAGUE sometimes painted the
 * league header and no cards; a refresh and a second press worked. Root cause:
 * the R47 two-pass LOAD (sync -> remount -> pendingAutoload -> load again)
 * left two async mounts of one element alive at once; the load result landed
 * in a panel the other mount had replaced. See docs/GRADE_LOAD.md.
 *
 * Locks:
 *   - deriveLeagueContext is pure: the same inputs at mount and after a sync
 *     give the same context;
 *   - the source carries no pendingAutoload and no remount call;
 *   - loadSleeperPlayerIndex is the ONLY player-dump path (no draft-live);
 *   - the mount guard: two mounts of one element paint the form ONCE — the
 *     superseded mount writes nothing after its await;
 *   - the card says what its number is (weekly-optimal), the season-optimal
 *     starters are folded and labelled NOT the standings number;
 *   - the per-week view renders STARTERS, BENCH, EMPTY, SUB and the total
 *     from a fixture week, and marks nothing when Sleeper's starters are
 *     unknown.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/* ------------------------------------------------- a browser-shaped node */

// The view module reads localStorage (league profile, scoring mode) and
// dispatches window events; none of that exists in node. A memory store and
// a no-op window are enough — nothing here asserts on either.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.window = globalThis;
globalThis.dispatchEvent = () => true;
globalThis.addEventListener = () => {};

// data.js fetches /data/*.json — serve them from disk, 404 when absent.
globalThis.fetch = async (path) => {
  const rel = String(path).replace(/^\//, "");
  try {
    const txt = readFileSync(join(REPO_ROOT, rel), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(txt) };
  } catch (err) {
    return { ok: false, status: 404, json: async () => null };
  }
};

const grade = await import("../../app/views/grade.js");
const { deriveLeagueContext, weekLineupHtml } = grade;
const mountGrade = grade.default;
const { normalizeProfile } = await import("../../app/league.js");
const { teamWeekPoints } = await import("../../app/grade-weekly.js");

const VIEW_SRC = readFileSync(join(REPO_ROOT, "app/views/grade.js"), "utf8");

/* ---------------------------------------------------- deriveLeagueContext */

const projections = readJson(join(REPO_ROOT, "data/player_projections.json"));
const weeklyDoc = readJson(join(REPO_ROOT, "data/player_weekly.json"));
const kdstDoc = readJson(join(REPO_ROOT, "data/kdst_projections.json"));
const offencePool = projections.players || [];
const weeklyRaw = new Map((weeklyDoc.players || []).map((p) => [String(p.gsis_id), p]));

const PTI = readJson(join(REPO_ROOT, "tests/fixtures/sleeper_pti/league.json"));
const LEAGUE_PROFILE = normalizeProfile({
  name: PTI.name,
  shape: { roster_positions: PTI.roster_positions },
  scoring: PTI.scoring_settings,
});

/** The comparable face of a context: everything but the function. */
function faceOf(ctx) {
  return {
    shape: ctx.shape,
    starterTokens: ctx.starterTokens,
    kdstRows: ctx.kdstRows.map((r) => [r.gsis_id, r.proj_points]),
    kdstNote: ctx.kdstNote,
    poolSize: ctx.pool.length,
    feeds: ctx.feeds,
    hasK: ctx.hasK,
    scoring: ctx.scoring,
    weeklySize: ctx.weeklyById.size,
    engine: Object.keys(ctx.engineCtx).sort(),
    sample: ctx.pool.slice(0, 25).map((p) => ctx.projOf(p)),
  };
}

test("deriveLeagueContext: the same inputs give the same context at mount and after a sync", () => {
  const inputs = { offencePool, weeklyRaw, kdstDoc, scoring: "ppr" };
  const atMount = deriveLeagueContext(LEAGUE_PROFILE, inputs);
  const afterSync = deriveLeagueContext(LEAGUE_PROFILE, inputs);
  assert.deepEqual(faceOf(afterSync), faceOf(atMount), "pure: no hidden state between calls");
  // The league's shape is the P.T.I. shape (DEF seated, no K) and the pool
  // carries DEF contract rows priced by kdst — never an offence conversion.
  assert.equal(atMount.shape.DEF, 1);
  assert.equal(atMount.hasK, false);
  assert.ok(atMount.kdstRows.length > 0, "DEF rows joined the pool");
  assert.ok(atMount.pool.length > offencePool.length);
  const def = atMount.kdstRows[0];
  assert.equal(atMount.projOf(def), Number(def.proj_points) || 0, "a kdst row is priced as itself");
  assert.deepEqual(atMount.engineCtx.feeds, atMount.feeds);
  assert.equal(atMount.engineCtx.profile, LEAGUE_PROFILE);
});

test("deriveLeagueContext: no saved league grades on the default offence shape", () => {
  const ctx = deriveLeagueContext(null, { offencePool, weeklyRaw, kdstDoc, scoring: "half" });
  assert.deepEqual(ctx.starterTokens, []);
  assert.deepEqual(ctx.shape, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
  assert.equal(ctx.scoring, "half");
  assert.equal(ctx.engineCtx.scoring, "half");
  assert.equal(ctx.hasK, false);
});

test("deriveLeagueContext: a K/DEF league with no kdst doc says so — EMPTY, never invented", () => {
  const ctx = deriveLeagueContext(LEAGUE_PROFILE, { offencePool, weeklyRaw, kdstDoc: null, scoring: "ppr" });
  assert.deepEqual(ctx.kdstRows, []);
  assert.match(ctx.kdstNote, /projection feed did not load/);
});

/* ------------------------------------------------------------ the source */

test("the LOAD is single-pass: no pendingAutoload, no remount, one dump path, a mount guard", () => {
  assert.ok(!/pendingAutoload/.test(VIEW_SRC), "the R47 cross-mount flag is gone");
  assert.ok(!/remount\(/.test(VIEW_SRC), "nothing remounts the view from inside a LOAD");
  assert.ok(!/=> mountGrade\(/.test(VIEW_SRC), "no self-call of the mount");
  assert.match(VIEW_SRC, /sleeper\.loadSleeperPlayerIndex\(\{/, "the memoised dump loader is the path");
  assert.ok(!/draft-live|draftLive|PLAYER_INDEX_URL|INDEX_TIMEOUT_MS/.test(VIEW_SRC),
    "the draft-live getJson dump path is retired");
  assert.match(VIEW_SRC, /onProgress/, "the dump reports progress");
  assert.match(VIEW_SRC, /Reading Sleeper\\'s player list…/, "the progress line");
  assert.match(VIEW_SRC, /dumpRes\.cached \? 'cached'/, "a memo hit says cached");
  // The guard: a module sequence bumped per mount, captured, and checked with
  // isConnected before every DOM write after an await.
  assert.match(VIEW_SRC, /let mountSeq = 0;/);
  assert.match(VIEW_SRC, /const seq = \+\+mountSeq;/);
  assert.match(VIEW_SRC, /seq !== mountSeq \|\| !el\.isConnected/);
  assert.match(VIEW_SRC, /console\.debug\('grade: stale LOAD dropped'\)/);
  assert.match(VIEW_SRC, /if \(synced\.changed\) await host\.rederive\(\);/,
    "a changed profile re-derives the context IN PLACE and the same load continues");
  assert.match(VIEW_SRC, /const \{ pool, projOf, shape, engineCtx: baseCtx \} = host\.ctx\(\);/,
    "grading reads the CURRENT context after the sync");
  assert.match(VIEW_SRC, /const \{ pool, projOf, shape \} = ctx;/,
    "the paste grader reads the CURRENT context too");
  assert.match(VIEW_SRC, /window\.dispatchEvent\(new Event\('nfl2026:league'\)\)/, "the LEAGUE chip event stays");
});

/* ------------------------------------------------------- the mount guard */

/** The smallest element the mount needs: innerHTML writes are recorded. */
class FakeEl {
  constructor() {
    this.writes = [];
    this.html = "";
    this.isConnected = true;
    this.value = "";
    this.disabled = false;
    this.kids = new Map();
  }
  set innerHTML(v) { this.html = v; this.writes.push(v); }
  get innerHTML() { return this.html; }
  querySelector(sel) {
    if (!this.kids.has(sel)) this.kids.set(sel, new FakeEl());
    return this.kids.get(sel);
  }
  addEventListener() { /* recorded nowhere: nothing here clicks */ }
}

test("mount guard: two mounts of one element paint the form once; the superseded mount writes nothing", async () => {
  const el = new FakeEl();
  const debug = [];
  const orig = console.debug;
  console.debug = (m) => { debug.push(String(m)); };
  try {
    await Promise.all([mountGrade(el), mountGrade(el)]);
  } finally {
    console.debug = orig;
  }
  const forms = el.writes.filter((w) => /id="gr-league-id"/.test(w));
  assert.equal(forms.length, 1, "exactly one mount painted the form");
  assert.equal(el.writes.length, 3, "two loading states, then ONE form — the stale mount was dropped");
  assert.ok(debug.some((m) => /superseded mount dropped/.test(m)), "the drop is a console.debug, not user text");
  // A detached element is dropped too, even by the current mount.
  const gone = new FakeEl();
  const p = mountGrade(gone);
  gone.isConnected = false;
  await p;
  assert.equal(gone.writes.length, 1, "only the synchronous loading state was written");
});

/* ------------------------------------------------------------ the labels */

test("the card says what its number is; the season-optimal starters are folded and labelled", () => {
  assert.match(VIEW_SRC, /WEEKLY-OPTIMAL TOTAL · best legal lineup each week, bench substituted/);
  assert.match(VIEW_SRC, /projected season pts from weekly optimal lineups/);
  assert.match(VIEW_SRC, /Week by week · starters, bench and SUBs · \$\{weekCount\} weeks/);
  assert.match(VIEW_SRC, /SEASON-OPTIMAL STARTERS · one fixed lineup all season · NOT what the standings use/);
  assert.match(VIEW_SRC, /<details class="gr-season"><summary>Season-optimal starters · \$\{starterCount\} slots · not the standings number<\/summary>/);
  // The season fold must not share the weekly fold's class: every spec that
  // clicks `details.gr-weeks summary` relies on exactly one such element per card.
  assert.equal((VIEW_SRC.match(/<details class="gr-weeks"/g) || []).length, 1);
  assert.match(VIEW_SRC, /SUB marks a seated player whom Sleeper lists on the bench/, "the SUB rule is in the notes");
  const css = readFileSync(join(REPO_ROOT, "app/theme.css"), "utf8");
  assert.match(css, /\.gr-week-sub \{/);
  assert.match(css, /\.gr-slot--bench \{/);
  assert.match(css, /\.gr-tag--sub \{/);
  assert.match(css, /\.gr-season summary \{/);
  assert.ok(!/style="/.test(VIEW_SRC), "no inline styles");
});

/* ------------------------------------------------------- per-week view */

const wk = (byeWk, pts = 10) => Array.from({ length: 18 }, (_, i) => ({
  wk: i + 1, bye: i + 1 === byeWk, pts: i + 1 === byeWk ? 0 : pts,
}));
const weeklyRow = (id, byeWk, pts) => [id, { gsis_id: id, receptions_prior: 0, weeks: wk(byeWk, pts) }];
const PROFILE = { shape: { roster_positions: ["QB", "RB", "WR", "TE", "FLEX", "DEF", "BN", "BN", "BN"] } };
const ROSTER = [
  { gsis_id: "qbA", name: "QB A", position: "QB", proj_points: 340 },
  { gsis_id: "qbB", name: "QB B", position: "QB", proj_points: 170 },
  { gsis_id: "rb1", name: "RB 1", position: "RB", proj_points: 170 },
  { gsis_id: "wr1", name: "WR 1", position: "WR", proj_points: 170 },
  { gsis_id: "wr2", name: "WR 2", position: "WR", proj_points: 120 },
  { gsis_id: "DST-DEN", name: "Denver D/ST", position: "DEF", proj_points: 999, kdst: {} },
];
const WEEKLY = new Map([
  weeklyRow("qbA", 2, 20), weeklyRow("qbB", 5, 10),
  weeklyRow("rb1", 7), weeklyRow("wr1", 7), weeklyRow("wr2", 7, 6),
]);
const KDST = {
  positions: ["DEF"],
  byId: new Map([["DST-DEN", { id: "DST-DEN", name: "Denver D/ST", team: "DEN", pos: "DEF", weeklyPoints: 7.2, unscored: false }]]),
};

test("per-week view: STARTERS, BENCH, EMPTY, SUB and the week total from a fixture week", () => {
  // Week 2: QB A is on bye, so QB B (whom Sleeper lists on the bench) starts.
  const d = teamWeekPoints({
    rosterPlayers: ROSTER, week: 2, profile: PROFILE, weeklyById: WEEKLY, kdstIndex: KDST,
    feeds: ["DEF", "DST"], byeByTeam: new Map(),
  });
  assert.equal(d.lineup.slots.QB1, "qbB");
  const sleeperStarters = new Set(["qbA", "rb1", "wr1", "DST-DEN"]);
  const html = weekLineupHtml(d, { teamIndex: 3, sleeperStarters });

  assert.match(html, /<div class="gr-week-head"><span>WK 2<\/span>/);
  assert.match(html, /class="gr-est-wk" data-team="3" data-wk="2" hidden/);
  assert.match(html, new RegExp(`<b>${d.total.toFixed(1)}</b>`), "the week total is the seated total");
  assert.match(html, /gr-week-sub">STARTERS</);
  assert.match(html, /gr-week-sub">BENCH</);
  // The seated bench QB carries SUB; a Sleeper starter does not.
  assert.match(html, /<span class="gr-pos">QB1<\/span><span>QB B <span class="gr-tag gr-tag--sub"[^>]*>SUB<\/span><\/span><span class="gr-pts">10\.0<\/span>/);
  assert.match(html, /<span class="gr-pos">RB1<\/span><span>RB 1<\/span><span class="gr-pts">10\.0<\/span>/);
  // FLEX seats WR 2 (bench on Sleeper) — SUB too.
  assert.match(html, /<span class="gr-pos">FLEX<\/span><span>WR 2 <span class="gr-tag gr-tag--sub"[^>]*>SUB<\/span><\/span><span class="gr-pts">6\.0<\/span>/);
  // K/DEF keeps its season-average flag.
  assert.match(html, /<span class="gr-pos">DEF1<\/span><span>Denver D\/ST <span class="gr-tag">SEASON AVG<\/span><\/span><span class="gr-pts">7\.2<\/span>/);
  // No TE on the roster: the slot is EMPTY, not 0.0.
  assert.match(html, /<span class="gr-pos">TE1<\/span><span class="gr-empty">EMPTY — nobody on the roster can fill this slot<\/span>/);
  assert.ok(!/gr-empty">[^<]*0\.0/.test(html));
  // The bench: the bye QB, listed with BYE and a dash-free 0.0 (a projected bye week).
  assert.match(html, /<div class="gr-slot gr-slot--bench"><span class="gr-pos">BN<\/span><span>QB A <span class="gr-tag">BYE<\/span><\/span><span class="gr-pts">0\.0<\/span><\/div>/);
  // Every roster row is either seated or on the bench, exactly once.
  const seatedCount = (html.match(/class="gr-slot"><span class="gr-pos">/g) || []).length;
  const benchCount = (html.match(/gr-slot gr-slot--bench"><span class="gr-pos">BN/g) || []).length;
  assert.equal(seatedCount + benchCount, ROSTER.length);
  assert.equal(benchCount, 1);
});

test("per-week view: without Sleeper's starters nothing is marked SUB; an empty bench says so", () => {
  const d = teamWeekPoints({
    rosterPlayers: ROSTER, week: 2, profile: PROFILE, weeklyById: WEEKLY, kdstIndex: KDST,
    feeds: ["DEF", "DST"], byeByTeam: new Map(),
  });
  const html = weekLineupHtml(d, { teamIndex: 0, sleeperStarters: null });
  assert.ok(!/gr-tag--sub/.test(html), "unknown starters -> no SUB claim");
  const seatedOnly = teamWeekPoints({
    rosterPlayers: ROSTER.filter((p) => p.gsis_id !== "qbA"), week: 1, profile: PROFILE,
    weeklyById: WEEKLY, kdstIndex: KDST, feeds: ["DEF", "DST"], byeByTeam: new Map(),
  });
  const h2 = weekLineupHtml(seatedOnly, {});
  assert.match(h2, /nobody on the bench/);
  assert.ok(!/gr-est-wk/.test(h2), "no team index -> no Sleeper cell");
});
