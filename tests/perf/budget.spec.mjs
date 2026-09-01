/* tests/perf/budget.spec.mjs — THE PERFORMANCE BUDGET. Part of the gate.
 *
 * WHY THIS FILE EXISTS
 * The R25 RCA found that the app's worst performance defects were all silent:
 * nothing in the suite noticed that '#/' — the home route — was fetching,
 * parsing and evaluating the entire 3.6k-line Team builder on every load, and
 * nothing would have noticed it coming back. A number nobody asserts is a
 * number that regresses. This file turns the RCA's wins into failing tests.
 *
 * THE MEASUREMENT RULE THIS FILE OBEYS
 * An absolute millisecond threshold tuned on one machine WILL go red on
 * another (R24 shipped exactly that mistake with pinned tab pixel widths). So,
 * in strict order of preference:
 *
 *   1. COUNTS — modules in the boot graph, requests per route, duplicate
 *      fetches, DOM nodes, leaked listeners. A count is a property of the
 *      code, not of the CPU it runs on. Every count budget below is exact and
 *      cannot flake.
 *   2. RATIOS measured inside one run. The only time budget here (the last
 *      test) is expressed as a multiple of a calibration workload timed in the
 *      SAME page on the SAME machine seconds earlier, so a slow CI box slows
 *      the numerator and the denominator together.
 *   3. GENEROUS ABSOLUTES. Used nowhere. See "WHAT THIS BUDGET DOES NOT CATCH".
 *
 * WHAT THIS BUDGET CATCHES
 *   - a heavy route-specific view being dragged back into the boot graph
 *     (the R25-F3 defect: players.js -> team.js);
 *   - the boot graph growing by a module or by ~44 kB;
 *   - any view fetching a pipeline-only artifact (game_context.json 3.1 MB,
 *     player_usage_weekly.json 2.2 MB, dvp_positional_history.json 4.2 MB, ...)
 *     or any /data/ file that is not on the reviewed contract allowlist;
 *   - a route fetching more contracts than it needs, incl. the R24 property
 *     that only #/team pulls kdst_projections.json;
 *   - app/data.js's promise cache breaking, i.e. a contract fetched twice;
 *   - a list losing its render cap and painting the whole 300-player pool;
 *   - the R25 listener leak returning (mount-time listeners on the permanent
 *     #view element with no teardown);
 *   - a >3x blow-up in the home route's cold boot, machine-speed-normalised.
 *
 * WHAT THIS BUDGET DOES NOT CATCH — stated plainly, so nobody trusts it for
 * more than it does:
 *   - MODEST CPU REGRESSIONS. The league.js clone storm (9.6 ms per repaint,
 *     ~325 redundant JSON deep clones) trips NO budget here: it changes no
 *     count, and it is far under the 3x boot ceiling. A 2x slowdown in any
 *     paint function passes this file green. Sub-3x CPU work is simply not
 *     assertable across machines without a calibrated micro-harness per hot
 *     path, which is a much bigger build than one budget spec.
 *   - INTERACTION LATENCY. Nothing here clicks ADD/REMOVE or types in the
 *     finder; the 14-20 ms paintAll is unbudgeted.
 *   - MEMORY IN BYTES. Listener COUNTS are asserted; the ~0.15 MiB/mount of
 *     retained closure state is not, because heap numbers vary with GC timing
 *     and Chromium build.
 *   - LONG TASKS. Deliberately omitted: the 50 ms long-task threshold is
 *     absolute, so on a 3x slower CI box work that is 20 ms here crosses it
 *     and the count changes. A long-task count is NOT machine-independent.
 *   - REAL NETWORK. Everything runs against a local http.server with no
 *     compression; the RTT-bound boot waterfall (finding 2) is invisible here.
 *     The static-graph tests below are the durable proxy for it: fewer modules
 *     and a shallower chain is fewer round trips on any network.
 *
 * WHEN A BUDGET GOES RED: do not raise the number to make it green. Either the
 * change is a regression, or the budget genuinely moved and you edit the
 * constant IN THE SAME COMMIT with the new measurement in the message.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, '../..');
// Matches tests/playwright.config.mjs webServer.url. Overridable so the file can
// be pointed at a deploy preview by hand.
const BASE = process.env.PERF_BASE_URL || 'http://127.0.0.1:4321';
const STORAGE = resolve(TESTS_DIR, '../gate-unlocked.storage.json');

/* ---------------------------------------------------------------- budgets --
 * Every constant is a MEASURED value plus stated headroom. Measured on the
 * R25 sandbox, Chromium 1194, iPad viewport 1024x1366, local http.server.
 */

// Static import graph reachable from app/main.js — what the browser MUST have
// fetched, parsed and evaluated before the router can mount anything.
// Measured 2026-08-14 after the R25-F3 edge cut: 15 modules, 275,856 bytes,
// depth 2. Before the cut: 19 modules, 578,493 bytes, depth 3.
// These two carry the weight — verified by re-introducing the defect edge in a
// throwaway copy of app/: the boot graph goes 15 -> 19 modules and
// 275,856 -> 582,101 bytes, tripping both.
const BOOT_MODULE_CEILING = 16; // measured 15; one module of headroom.
/* Re-measured 2026-08-15 after the R30/auction-memory releases: 325,257 bytes,
 * up from 275,856. The growth is legitimate boot-module content, not a leak —
 * the module-count and lazy-only guards above both still pass, and the bytes
 * are the auction-memory seeding engine plus the R30 incident commentary in
 * auction.js / team-logic.js (this repo deliberately writes the why into the
 * source, and this budget measures source bytes). Ceiling re-set with ~11%
 * headroom. If this trips again WITHOUT a lazy-leak, re-measure and decide
 * again in writing — never bump it to make a red bar green. */
const BOOT_BYTE_CEILING = 360_000; // measured 325,257 (2026-08-15).
// Depth is a LOOSE guard, not a lock: each level is one serialized round trip,
// but the pre-fix graph was depth 3 too, so this ceiling would NOT have caught
// R25-F3 on its own. It only catches a NEW, deeper chain.
const BOOT_DEPTH_CEILING = 3; // measured 2.

// Heavy, route-specific modules that must stay OFF the boot path. Each is
// reachable only via a dynamic import() (main.js's lazy route mounts, or
// players.js's post-boot idle warm). A static edge to any of these is the
// R25-F3 defect, whatever the reason it was added.
const LAZY_ONLY_MODULES = [
  'app/views/team.js', // 175 kB, the draft builder — needed by #/team only
  'app/views/lineup.js',
  'app/views/model.js',
  'app/views/compare.js',
  'app/sleeper.js', // 85 kB, only reachable from team.js
  'app/kdst.js',
  'app/mocks.js',
  'app/views/grade.js', // R41 — paste grader, needed by #/grade only
  'app/grade.js', //       R41 — its pure engine, reachable only from the view
  'app/grade-league.js', // R42 — Sleeper league -> engine inputs, ditto
];

// PIPELINE-ONLY artifacts. These exist for scripts/ and tests/feature/ and must
// NEVER be fetched by the app. Sizes are today's, in bytes.
const FORBIDDEN_ARTIFACTS = [
  'dvp_positional_history.json', // 4,163,851
  'game_context.json', //          3,202,574
  'player_usage_weekly.json', //   2,285,010
  'epa_history.json', //           1,372,504
  'adp_history.json', //             600,939
  'injuries.json', //                558,097
  'injury_history.json', //          553,107
  'scheme_history.json', //          496,139
  'player_usage_history.json', //    235,522
  'weather_history.json',
];

// The reviewed contract allowlist: the 14 paths in app/data.js PATHS plus
// kdst_projections.json (app/kdst.js). The blocklist above names today's known
// offenders; THIS list is the one with teeth, because it also rejects an
// artifact nobody has thought of yet. Adding a contract is allowed — it just
// has to be a deliberate edit here, reviewed for size.
const CONTRACT_ALLOWLIST = new Set([
  'adp.json',
  'ai_insights.json',
  'game_predictions.json',
  'kdst_projections.json',
  'market_prices.json',
  'meta.json',
  'model_tuning.json',
  'parlays.json',
  'pipeline_status.json',
  'player_history.json',
  'player_projections.json',
  'player_weekly.json',
  'playoff_odds.json',
  // R45 — facts-only rookie starters, ~1 KB, fetched LAZILY on the first
  // ROOKIES ONLY toggle (never on a cold route load).
  'rookie_starters.json',
  'schedule_full.json',
  'team_strength.json',
]);

// Contracts fetched on a COLD load of each route. Measured 3x per route, byte
// identical every time — these are exact, not sampled. Ceilings equal the
// measured value: fetching fewer is always fine, fetching more is a budget
// decision. Every route mounts from a single Promise.allSettled, so these
// counts are also the concurrency.
const ROUTES = [
  { hash: '#/', name: 'slate', contracts: 3 },
  { hash: '#/players', name: 'players', contracts: 8 },
  { hash: '#/parlays', name: 'parlays', contracts: 4 },
  { hash: '#/team', name: 'team', contracts: 9 },
  // R47 — the DEFAULT league now fields K and DEF (owner's pick: first-class
  // everywhere), so LINEUP's conditional second-wave kdst fetch is live on a
  // cold default load: 5 -> 6, measured 3x byte-identical. PLAYERS stays at 8
  // because its K/DST rows are fetched lazily on the first K/DEF chip tap.
  { hash: '#/lineup', name: 'lineup', contracts: 6 },
  { hash: '#/model', name: 'model', contracts: 6 },
  { hash: '#/compare?a=espn-3117251&b=espn-4426515', name: 'compare', contracts: 6 },
];

// DOM ceiling per route. Measured on the default profile: players 3,279
// elements inside #view (60 cards x ~55 nodes, shownCap), parlays 1,267,
// team 779, model 597, compare 108, lineup 26. One ceiling covers all routes;
// the property it protects is that every list is CAPPED. Dropping the cap and
// rendering the 300-player pool would land near 16,000.
const VIEW_NODE_CEILING = 5000;

// Listener growth per lap of (#/team -> #/). Measured +1.2 listeners/lap after
// the R25 teardown fix, dead flat across 3 independent runs. Before the fix it
// was +10.0 per Team mount, perfectly linear and unbounded. 3 leaves room for
// one or two more legitimately-permanent registrations without ever tolerating
// a per-mount leak.
//
// R47: the sample is taken AFTER a forced garbage collection. JSEventListeners
// counts listener wrappers still on the heap, and a listener unbound by its
// mount's AbortController lingers there until the next GC — so the raw metric
// is a sawtooth (18 -> 33 -> 48 -> 18 ...) whose final reading depends on
// where the collector happened to be, not on whether anything leaked. R47 made
// the Team mount heavier (K/DEF rows are seated by default), which shifted
// that cadence and read as +4.5/lap on a build with no leak at all: with the
// collector forced first the same build is flat at 18/18 for all ten laps.
// A real leak (a listener nothing ever unbinds) survives GC and still fails.
const LISTENER_GROWTH_PER_LAP_CEILING = 3;
const LISTENER_LAPS = 10;

// Cold boot of the home route, in CALIBRATION UNITS (see calibrate()). Measured
// median 15.0 units [14.1-16.5] over 7 cold loads. Ceiling is 3x the median,
// i.e. 2.7x the worst sample observed. This is the ONLY time-shaped budget in
// the file and it exists to catch a catastrophe (an accidental sync loop, a
// giant artifact, a fetch waterfall), not a regression of a few ms.
const BOOT_CALIB_UNITS_CEILING = 45;
const BOOT_REPS = 5;

/* ------------------------------------------------------- static graph walk --
 * Reads the source, not the browser: fully deterministic, no server, no timing.
 * Follows only STATIC `import ... from './x.js'` / `import './x.js'` edges,
 * which are exactly the ones the browser must resolve before evaluating a
 * module. Dynamic import() is intentionally NOT followed — being behind an
 * import() is the whole point.
 */
function staticGraph(entryRel) {
  const depth = new Map();
  const size = new Map();
  const STATIC_FROM = /^[ \t]*(?:import|export)[\s{][^;]*?from\s*['"](\.[^'"]+)['"]/gm;
  const STATIC_BARE = /^[ \t]*import\s*['"](\.[^'"]+)['"]/gm;

  const visit = (abs, d) => {
    const rel = relative(REPO_ROOT, abs);
    if (depth.has(rel) && depth.get(rel) <= d) return;
    depth.set(rel, Math.min(depth.has(rel) ? depth.get(rel) : Infinity, d));
    const src = readFileSync(abs, 'utf8');
    size.set(rel, Buffer.byteLength(src));
    const kids = new Set();
    for (const re of [STATIC_FROM, STATIC_BARE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) kids.add(resolve(dirname(abs), m[1]));
    }
    for (const k of kids) visit(k, d + 1);
  };
  visit(resolve(REPO_ROOT, entryRel), 0);

  return {
    modules: [...depth.keys()].sort(),
    depth,
    maxDepth: Math.max(...depth.values()),
    bytes: [...size.values()].reduce((a, b) => a + b, 0),
  };
}

test.describe('R25 performance budget — static boot graph', () => {
  test('no heavy route-specific view is reachable from the boot graph', () => {
    const g = staticGraph('app/main.js');
    const offenders = LAZY_ONLY_MODULES.filter((m) => g.modules.includes(m));
    expect(
      offenders,
      'These modules must be reached only through a dynamic import(). A static '
      + 'edge puts them on the critical path of EVERY route — that is the R25-F3 '
      + 'defect (app/views/players.js imported ./team.js for one pure function, '
      + 'costing every route 4 modules / 301 kB and a whole extra RTT wave). '
      + `Boot graph is currently: ${g.modules.join(', ')}`,
    ).toEqual([]);
  });

  test('the boot graph stays within its module, byte and depth budget', () => {
    const g = staticGraph('app/main.js');
    expect(g.modules.length, `boot modules: ${g.modules.join(', ')}`)
      .toBeLessThanOrEqual(BOOT_MODULE_CEILING);
    expect(g.bytes, 'boot graph bytes (uncompressed source; brotli shrinks the '
      + 'wire cost but NOT the parse/compile/evaluate cost this measures)')
      .toBeLessThanOrEqual(BOOT_BYTE_CEILING);
    // Depth is round trips: the browser cannot discover a module's imports
    // until its parent has arrived, so each level is one serialized RTT on a
    // real network (measured slope: 5.43 RTT to the first data byte).
    expect(g.maxDepth, `deepest static chain from app/main.js (${
      [...g.depth.entries()].filter(([, d]) => d === g.maxDepth).map(([p]) => p).join(', ')})`)
      .toBeLessThanOrEqual(BOOT_DEPTH_CEILING);
  });

  test('app/data.js declares no contract that is outside the reviewed allowlist', () => {
    // Keeps the allowlist honest: adding a PATHS entry reds this until the
    // budget is updated, which is the review checkpoint for a new artifact.
    const src = readFileSync(resolve(REPO_ROOT, 'app/data.js'), 'utf8');
    const declared = [...src.matchAll(/'\/data\/([A-Za-z0-9_.-]+\.json)'/g)].map((m) => m[1]);
    expect(declared.length, 'app/data.js declares at least one contract path')
      .toBeGreaterThan(0);
    for (const f of declared) {
      expect(CONTRACT_ALLOWLIST.has(f), `app/data.js declares /data/${f}, which is `
        + 'not on the reviewed contract allowlist in tests/perf/budget.spec.mjs')
        .toBe(true);
    }
  });
});

/* --------------------------------------------------- one-session route walk --
 * All the request-shaped budgets share ONE browser session (7 routes, in the
 * order a person would tab through them) so the suite pays for it once and so
 * the duplicate-fetch assertion sees a realistic session rather than a single
 * route.
 */
test.describe('R25 performance budget — runtime request counts', () => {
  test.describe.configure({ mode: 'serial' });

  /** @type {{dataRequests: string[], nodes: Record<string, number>}} */
  let walk;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1024, height: 1366 },
      storageState: STORAGE,
    });
    const page = await ctx.newPage();
    const dataRequests = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/data/')) dataRequests.push(u.split('/data/')[1].split('?')[0]);
    });
    const nodes = {};
    await page.goto(`${BASE}/${ROUTES[0].hash}`, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    nodes[ROUTES[0].name] = await page.evaluate(
      () => document.getElementById('view').querySelectorAll('*').length,
    );
    for (const r of ROUTES.slice(1)) {
      await page.evaluate((h) => { window.location.hash = h; }, r.hash);
      // Generous: this is not a timing measurement, it just has to be long
      // enough that the mount has certainly finished on any machine.
      await page.waitForTimeout(2500);
      nodes[r.name] = await page.evaluate(
        () => document.getElementById('view').querySelectorAll('*').length,
      );
    }
    walk = { dataRequests, nodes };
    await ctx.close();
  });

  test('no view ever requests a pipeline-only artifact', () => {
    // THE assertion this file exists for. game_context.json alone is 3.1 MB —
    // more than the entire app plus every contract it legitimately loads.
    const hits = walk.dataRequests.filter((f) => FORBIDDEN_ARTIFACTS.includes(f));
    expect(hits, 'a view fetched a pipeline-only artifact; these belong to '
      + 'scripts/ and tests/feature/ and must never reach a browser').toEqual([]);
  });

  test('every contract a route fetches is on the reviewed allowlist', () => {
    const unknown = [...new Set(walk.dataRequests)].filter((f) => !CONTRACT_ALLOWLIST.has(f));
    expect(unknown, 'a route fetched a /data/ file that is not on the reviewed '
      + 'contract allowlist — add it to CONTRACT_ALLOWLIST only after checking '
      + 'its size').toEqual([]);
    expect(walk.dataRequests.length, 'the session fetched something').toBeGreaterThan(0);
  });

  test('app/data.js de-dupes: no contract is fetched twice in one session', () => {
    const seen = new Map();
    for (const f of walk.dataRequests) seen.set(f, (seen.get(f) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes, "app/data.js caches the PROMISE per path, so a 7-route session "
      + 'must issue exactly one network request per contract. A duplicate means '
      + 'the cache was bypassed or a fetch escaped the getters').toEqual([]);
    // Measured: 15 distinct contracts over the full walk.
    expect(seen.size).toBeLessThanOrEqual(CONTRACT_ALLOWLIST.size);
  });

  test('every route keeps its rendered DOM bounded', () => {
    for (const [name, n] of Object.entries(walk.nodes)) {
      expect(n, `#/${name} rendered ${n} elements inside #view. Lists are capped `
        + '(players shownCap=60, team FINDER_CAP=25); this many elements means a '
        + 'cap was removed and the whole ~300-player pool is being painted')
        .toBeLessThanOrEqual(VIEW_NODE_CEILING);
    }
  });
});

test.describe('R25 performance budget — per-route cold contract counts', () => {
  for (const r of ROUTES) {
    test(`#/${r.name} fetches at most ${r.contracts} contracts on a cold load`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: 1024, height: 1366 },
        storageState: STORAGE,
      });
      const page = await ctx.newPage();
      const got = [];
      page.on('request', (req) => {
        const u = req.url();
        if (u.includes('/data/')) got.push(u.split('/data/')[1].split('?')[0]);
      });
      await page.goto(`${BASE}/${r.hash}`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      await ctx.close();

      expect(got.length, `#/${r.name} cold contracts: ${got.sort().join(', ')}`)
        .toBeLessThanOrEqual(r.contracts);
      // R24's win, re-scoped by R47: the K/DST projections (74 rows, 58 kB)
      // are pulled only by routes that SEAT K/DEF — the draft builder and,
      // now that the default league fields K and DEF, the lineup card. The
      // slate/players/parlays/model/compare routes still never pull them
      // (PLAYERS fetches them lazily on a K/DEF chip tap, never on cold load).
      if (r.name !== 'team' && r.name !== 'lineup') {
        expect(got, `#/${r.name} must not fetch kdst_projections.json`)
          .not.toContain('kdst_projections.json');
      }
    });
  }
});

/* ----------------------------------------------------------- listener leak --
 * A count, and the cleanest signal in the whole RCA: before the R25 teardown,
 * every Team mount added exactly 10 live listeners to the permanent #view
 * element, each closure retaining that mount's derived state (~0.15 MiB).
 * Growth per lap is a property of the code, so this cannot flake on a slower
 * box — only the dwell times below are timing-dependent, and they are generous.
 */
test('navigating away and back does not leak event listeners', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 1366 },
    storageState: STORAGE,
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  const listeners = async () => {
    // Count what SURVIVES a collection: unbound-but-uncollected wrappers are
    // garbage, not a leak (see LISTENER_GROWTH_PER_LAP_CEILING).
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'JSEventListeners').value;
  };

  await page.goto(`${BASE}/#/`, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const before = await listeners();
  for (let i = 0; i < LISTENER_LAPS; i += 1) {
    await page.evaluate(() => { window.location.hash = '#/team'; });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.location.hash = '#/'; });
    await page.waitForTimeout(700);
  }
  const after = await listeners();
  await ctx.close();

  const perLap = (after - before) / LISTENER_LAPS;
  expect(perLap, `live JSEventListeners went ${before} -> ${after} over `
    + `${LISTENER_LAPS} laps of #/team -> #/ (${perLap.toFixed(2)}/lap). Views `
    + 'register delegated listeners on the PERMANENT #view element; without a '
    + 'per-mount AbortController teardown they accumulate forever, and every '
    + 'dead handler still runs on every click and retains its whole mount scope')
    .toBeLessThanOrEqual(LISTENER_GROWTH_PER_LAP_CEILING);
});

/* ------------------------------------------------- calibrated boot ceiling --
 * The one time-shaped budget. calibrate() times a fixed, deterministic JS
 * workload (4,000 JSON deep clones — the same shape of work app/league.js does
 * on every repaint) in the page that just booted. Dividing the boot time by it
 * cancels most of the machine-speed difference between this sandbox and CI:
 * a box half as fast produces roughly double both numbers.
 *
 * Measured here: calib 9.8 ms [7.3-16.5]; '#/' cold mount 147.1 ms
 * [128.3-157.0] = 15.0 calibration units [14.1-16.5]. Ceiling 45 = 3x median.
 */
const CALIBRATION = `(() => {
  const obj = { a: 1, b: 'two', c: [1,2,3,4,5], d: { e: { f: [6,7,8], g: 'h' } },
                i: [{ j: 1 }, { k: 2 }, { l: 3 }] };
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < 4000; i += 1) { sink += JSON.parse(JSON.stringify(obj)).c[i % 5]; }
  return { ms: performance.now() - t0, sink };
})()`;

test('the home route boots within 3x its calibrated budget', async ({ browser }) => {
  const units = [];
  for (let i = 0; i < BOOT_REPS; i += 1) {
    const ctx = await browser.newContext({
      viewport: { width: 1024, height: 1366 },
      storageState: STORAGE,
    });
    const page = await ctx.newPage();
    // Mount-complete = the last #view mutation before 250 ms of DOM silence.
    // Every view paints by assigning innerHTML, so the mutation stream is a
    // faithful proxy for "the route finished putting pixels on the page".
    await page.addInitScript(() => {
      window.__budget = [];
      const attach = () => {
        const v = document.getElementById('view');
        if (!v) return;
        new MutationObserver(() => window.__budget.push(performance.now()))
          .observe(v, { childList: true, subtree: true, characterData: true });
      };
      document.addEventListener('DOMContentLoaded', attach);
      if (document.readyState !== 'loading') attach();
    });
    await page.goto(`${BASE}/#/`, { waitUntil: 'load' });
    const mountMs = await page.evaluate(async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 25));
        const now = performance.now();
        const last = window.__budget[window.__budget.length - 1];
        if (last != null && now - last >= 250) return last; // from navigationStart
        if (now > 25000) return null;
      }
    });
    const calib = await page.evaluate(CALIBRATION);
    await ctx.close();
    expect(mountMs, '#/ never reached a quiet DOM').not.toBeNull();
    units.push(mountMs / calib.ms);
  }
  const sorted = units.slice().sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[sorted.length >> 1]
    : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;

  expect(median, `#/ cold boot = ${median.toFixed(1)} calibration units `
    + `(samples ${sorted.map((u) => u.toFixed(1)).join(', ')}; measured baseline `
    + '15.0). One unit = 4,000 JSON deep clones timed in the same page, so this '
    + 'ratio is machine-speed-normalised. A 3x blow-up means a catastrophe — a '
    + 'sync loop, a giant artifact, or a new serialized fetch wave — not a few '
    + 'ms of drift')
    .toBeLessThanOrEqual(BOOT_CALIB_UNITS_CEILING);
});
