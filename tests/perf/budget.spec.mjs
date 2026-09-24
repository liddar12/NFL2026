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

/* R78 — #/model is passphrase-gated (obscurity, not security: the feeds stay
 * public, only the VIEW hides). A LOCKED model route fetches NOTHING, so the
 * route waterfall below would silently measure a card instead of the dashboard
 * and its 8 contracts. Every context that walks the routes seeds the unlock
 * digest; the locked path is asserted in tests/web/r78_model_lock.spec.mjs. */
const unlockModel = (page) => page.addInitScript(() => {
  try {
    localStorage.setItem('nfl2026.model.unlock.v1', '4fed76b87cf8b056da33b210b23e8f4f93e9c955d56faf7e3ae3bbb57704f50b');
  } catch (_) { /* storage blocked — the model budget below would read as 0 */ }
});

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
const BOOT_MODULE_CEILING = 15; // measured 14 (R51: parlays view lazy); one module of headroom.
/* Re-measured 2026-08-15 after the R30/auction-memory releases: 325,257 bytes,
 * up from 275,856. The growth is legitimate boot-module content, not a leak —
 * the module-count and lazy-only guards above both still pass, and the bytes
 * are the auction-memory seeding engine plus the R30 incident commentary in
 * auction.js / team-logic.js (this repo deliberately writes the why into the
 * source, and this budget measures source bytes). Ceiling re-set with ~11%
 * headroom. If this trips again WITHOUT a lazy-leak, re-measure and decide
 * again in writing — never bump it to make a red bar green. */
/* R73 (2026-09-14): measured 359,967 — 33 bytes of headroom. The parlay
 * history put two getters on app/data.js (boot graph) and nothing else: the
 * week-list merge, the default-week rule and the (season, week) path builder
 * all live in the lazy app/views/parlays.js, and the P&L reader/renderer in
 * the lazy app/review.js. The NEXT boot-graph addition of any size trips this;
 * the honest move then is a re-measure and a written decision, as above. */
/* R77 (2026-09-17): measured 361,266, which trips the 360,000 ceiling R73 left
 * 33 bytes of headroom under — exactly the "NEXT addition of any size" that note
 * predicted. Re-measured and decided in writing, per the policy at the top of
 * this file. The growth is 1,299 bytes in app/views/players.js and nothing else:
 * R77's this-week gate (gateTag + the `gate` field on weekValue) tags the AI+
 * headline with WHY a player cannot play this week instead of printing his
 * pipeline 0.0 under "MATCHUP". It is legitimate boot-module content, not a lazy
 * leak — players.js was already on the boot graph, the module count is unchanged
 * at 14 and the lazy-only guard above still passes (the parlay Q chip landed in
 * the lazy app/views/parlays.js and app/views/myparlays.js, which are off it).
 * Ceiling re-set to the measurement plus ~2% headroom. */
/* R90 (2026-09-19): measured 369,024, which trips the 368,500 ceiling R77 set.
 * Re-measured and decided in writing. The growth is 2,082 bytes in two boot
 * modules and nothing else: app/views/slate.js +1,806 (the week bar became a
 * button group with aria-pressed and arrow keys, and reviewSlate now hands the
 * review layer the current week and each game's status so a PAST week can show
 * its LOCKED forecast instead of today's recomputation — F13) and app/render.js
 * +276 (the repeated WEEKS toggle carries a player-specific accessible name —
 * F20). Both are boot-module content, not lazy leaks: the module count is
 * unchanged, the lazy-only guard passes, and the parlays/MY work of the same
 * release landed in modules that are off the boot graph. Ceiling re-set to the
 * measurement plus ~2% headroom. */
const BOOT_BYTE_CEILING = 376_500; // measured 325,257 (2026-08-15); 359,967 (2026-09-14, R73); 361,266 (2026-09-17, R77); 369,024 (2026-09-19, R90).
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
  'app/views/league.js', // R48 — the LEAGUE tab, needed by #/league only
  'app/synclog.js', //       R48 — its sync log + diff engine, reachable only from the view
  'app/grade-weekly.js', // R48 — weekly-optimal season engine, reachable only from the grade view
  // R76 — MY PARLAYS. The view and the maths it uses load on the MY chip tap,
  // never on a cold mount: a static edge to either would put the seed search
  // (and, through it, a ~294 KB leg pool) on every boot of every route.
  'app/views/myparlays.js',
  'app/parlay-math.js',
  'app/sleeper-proj.js', // R49 — Sleeper's display-only estimate, lazy after first paint (players/grade)
  'app/waivers.js', //       R49 — waiver-wire engine (BEST FIT / BEST AVAILABLE), lineup view only
  'app/league-rosters.js', // R49 — league rosters + NFL week memory, reachable from team/lineup only
  'app/views/parlays.js', // R51 — parlay cards, needed by #/parlays only (moved off the boot graph)
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
  // R49 — Sleeper's display-only weekly projections (~1 MB), fetched in the
  // idle phase after first paint on PLAYERS/GRADE, never on a mount's critical path.
  'sleeper_projections.json',
  'team_strength.json',
  // R51 — the weekly-split and parlay never-regress backtest records (a few
  // KB each, no per-row arrays), fetched by #/model only; a 404 resolves to
  // null and the card is omitted, so the request is the whole cost.
  'weekly_backtest.json',
  'parlay_backtest.json',
  // R70 — the OL / DL-front LINE REPORT (~20 KB: 32 teams x starter names and
  // report lists, no per-player rows). Fetched by LINEUP (cold, 6 -> 7 below),
  // GRADE (mount) and PLAYERS only while AI+ is the persisted view; a 404
  // resolves to null and no chip renders, so the request is the whole cost.
  'line_report.json',
  // R71 — the post-game review (data/review.json, ~100 KB at one resolved
  // week: 16 games + 26 players + 66 parlays with their measured why). Fetched
  // by app/review.js, itself a LAZY import from the slate/parlays views after
  // paint; a 404 resolves to null once per session and nothing renders.
  'review.json',
  // R73 — the parlay HISTORY index (data/parlays/index.json, a few hundred
  // bytes: one row per archived week with its file path and counts). Joins
  // the parlays mount's allSettled (cold 5 -> 6 below) so the week chips can
  // render with the first paint; a 404 (no week archived yet) is one request
  // and no chips. The per-week ARCHIVE files it points at are allowed by
  // pattern (isAllowedContract) and are fetched ONLY on a week-chip tap —
  // never on a cold mount, which the per-route ceilings below enforce.
  'parlays/index.json',
  // R81 — the measure-only REPLAY LAB record (data/replay_lab.json, a few KB:
  // five variant blocks of scalars, no per-leg or per-parlay arrays). Fetched
  // by #/model only; a 404 resolves to null and the card paints its honest
  // NOT PRESENT line, so the request is the whole cost either way.
  'replay_lab.json',
  // R87 — the MY cards record scores (data/my_card_scores.json: per-week and
  // per-dial scalars plus GRADED cards only; ~4 KB with nothing graded). Fetched
  // by app/views/myparlays.js, itself a LAZY import taken only when the MY chip
  // is tapped — never on a cold route load; a 404 resolves to null and no
  // RECORD line renders, so the request is the whole cost.
  'my_card_scores.json',
  // R88 — the per-stage pipeline record (data/pipeline_stages.json: one row per
  // workflow step — status, exit code, duration, last success — for three
  // workflows, a few KB). Fetched by #/model only, inside the same mount
  // allSettled as the two R51 records and the replay lab; a 404 resolves to null
  // and the card paints its honest NOT PRESENT line, so the request is the whole
  // cost either way.
  'pipeline_stages.json',
  // R98 — the compact Sleeper player index (data/sleeper_index.json, ~148 KB,
  // ~25 KB brotli). Fetched by app/league-sync.js ONLY when LINEUP finds the
  // league's rosters over six hours old — never on a fresh mount, never on boot
  // (league-sync.js is a dynamic import off LINEUP). It replaces the 14.7 MB
  // Sleeper dump the manual sync reads, so on the one path that fetches it the
  // app downloads ~1% of what it otherwise would.
  'sleeper_index.json',
  // R101c — this week's WEEK anytime-TD cards (data/atd_cards.json, tens of KB),
  // fetched by PARLAYS only when a TD mode is chosen on WEEK; never on boot.
  'atd_cards.json',
  // R101b — this week's GAME (same-game) anytime-TD cards, fetched by PARLAYS
  // only when a TD mode is chosen on GAME; never on boot.
  'atd_game_cards.json',
]);

// R73 — data/parlays/2026_wkNN.json: one archived parlays document per week
// (the same size as parlays.json, ~60 KB). Reachable only through
// app/data.js getParlayArchive, which refuses any path outside /data/parlays/.
const PARLAY_ARCHIVE_RE = /^parlays\/\d{4}_wk\d{2}\.json$/;
const isAllowedContract = (f) => CONTRACT_ALLOWLIST.has(f) || PARLAY_ARCHIVE_RE.test(f);

// Contracts fetched on a COLD load of each route. Measured 3x per route, byte
// identical every time — these are exact, not sampled. Ceilings equal the
// measured value: fetching fewer is always fine, fetching more is a budget
// decision. Every route mounts from a single Promise.allSettled, so these
// counts are also the concurrency.
const ROUTES = [
  // R71 — 3 -> 4: data/review.json joins the slate after first paint (lazy
  // app/review.js), so the won/lost circles and the review strip can land
  // without a user gesture. Measured 3x, byte-identical: 4.
  { hash: '#/', name: 'slate', contracts: 4 },
  // R49 — 8 -> 10: Sleeper's display-only estimate (sleeper_projections.json,
  // ~1 MB) and meta.json (the baseline rule the gap reason cites) are fetched
  // AFTER the first paint via requestIdleCallback, never inside the mount's
  // allSettled, so first paint is unchanged; they still land inside this
  // test's 2.5 s window. Owner's decision: Sleeper's number beside OURS on
  // every card, so there is no user gesture to hang the fetch on.
  // R71 — 10 -> 11: data/review.json joins the players mount's allSettled so
  // the OVER / UNDER / MET chip rides the first paint on every card (the same
  // document the slate and parlays read; one request, cached across routes).
  { hash: '#/players', name: 'players', contracts: 11 },
  // R71 — 4 -> 5: the same review.json (cached across routes by data.js's
  // promise cache — the de-dupe test below still holds) for the leg marks.
  // R73 — 5 -> 6: data/parlays/index.json (the history index, a few hundred
  // bytes) joins the parlays mount's allSettled so the week chips paint with
  // the cards; a 404 is still one request. The per-week archive files are
  // NOT in this count: they are fetched only when a past week's chip is
  // tapped, so a cold load never requests one (asserted below).
  { hash: '#/parlays', name: 'parlays', contracts: 6 },
  { hash: '#/team', name: 'team', contracts: 9 },
  // R47 — the DEFAULT league now fields K and DEF (owner's pick: first-class
  // everywhere), so LINEUP's conditional second-wave kdst fetch is live on a
  // cold default load: 5 -> 6, measured 3x byte-identical. PLAYERS stays at 8
  // because its K/DST rows are fetched lazily on the first K/DEF chip tap.
  // R70 — 6 -> 7: data/line_report.json (the OL / DL-front LINE REPORT chips
  // on every starter row) joins the lineup mount's allSettled; a 404 is still
  // one request. PLAYERS fetches the report only when AI+ is on (its 11 is R71's).
  { hash: '#/lineup', name: 'lineup', contracts: 7 },
  // R51 — 6 -> 8: the two backtest records join the model mount's allSettled
  // (a 404 is still one request, so the count holds with the files absent).
  // R81 — 8 -> 9: data/replay_lab.json joins the same allSettled; same shape,
  // same cost, and the card renders its honest state line on a 404.
  // R88 — 9 -> 10: data/pipeline_stages.json joins it too, for the PIPELINE
  // STAGES card. Same shape, same cost: one request, null on a 404.
  { hash: '#/model', name: 'model', contracts: 10 },
  { hash: '#/compare?a=espn-3117251&b=espn-4426515', name: 'compare', contracts: 6 },
  // R48 — '#/league' is deliberately NOT listed: it fetches zero contracts. The
  // LEAGUE tab reads the saved profile, the league id and the sync log from
  // localStorage and nothing else, so a per-route count here would be 0 and
  // the allowlist walk below already fails any /data/ request it ever makes.
];

// DOM ceiling per route. Measured on the default profile: players 3,279
// elements inside #view (60 cards x ~55 nodes, shownCap), parlays 1,267,
// team 779, model 597, compare 108, lineup 26. One ceiling covers all routes;
// the property it protects is that every list is CAPPED. Dropping the cap and
// rendering the 300-player pool would land near 16,000.
// R71/R72 — 5,000 -> 5,600: the post-game review adds a hidden measured-why
// panel to every graded player card (week 1: 53 graded cards x ~6 reasons =
// ~300 nodes, 5,018 at the 2026-09-14 baseline) plus R72's season tally chip
// and review controls (~+70). Measured on data, not code; the cap still holds
// (an uncapped pool would be ~3x the ceiling).
const VIEW_NODE_CEILING = 5600;

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
    // R73 — the character class admits '/' so data/parlays/index.json is checked too.
    const declared = [...src.matchAll(/'\/data\/([A-Za-z0-9_./-]+\.json)'/g)].map((m) => m[1]);
    expect(declared.length, 'app/data.js declares at least one contract path')
      .toBeGreaterThan(0);
    for (const f of declared) {
      expect(isAllowedContract(f), `app/data.js declares /data/${f}, which is `
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
    await unlockModel(page);
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
    const unknown = [...new Set(walk.dataRequests)].filter((f) => !isAllowedContract(f));
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
      await unlockModel(page);
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
      // R73 — a parlay ARCHIVE file is fetched only on a week-chip tap, never
      // on a cold load of any route (the index alone joins the parlays mount).
      expect(got.filter((f) => PARLAY_ARCHIVE_RE.test(f)),
        `#/${r.name} fetched a parlay archive file on a cold load`).toEqual([]);
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
