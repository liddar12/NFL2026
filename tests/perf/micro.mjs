/* tests/perf/micro.mjs — micro-benchmarks for the hot leaves the CPU profile
 * named, measured in-page against the REAL shipped modules (no app edits).
 *
 * Each benchmark runs in a FRESH PAGE (own JS heap), because allocating
 * thousands of Intl.DateTimeFormat objects in one page poisons every later
 * benchmark in that page with GC pressure — an earlier single-page version of
 * this file reported dayGroupKey (1 Intl construction) as costing twice
 * formatKickoff (2 constructions), which is impossible and was pure GC drift.
 *
 * Reported: median of 7 batches, in ns/op.
 */
import { chromium } from 'playwright';
import { BASE, VIEWPORTS } from './lib.mjs';

const PRELUDE = `
  const render = await import('/app/render.js');
  const league = await import('/app/league.js');
  const teamLogic = await import('/app/team-logic.js');
  const preds = await (await fetch('/data/game_predictions.json')).json();
  const games = preds.games || [];
  const kicks = games.map((g) => g.kickoff_utc).filter(Boolean);
  const tz = 'America/New_York';
  const prof = league.loadProfile();
  const time = (fn, n) => {
    for (let i = 0; i < Math.min(n, 50); i++) fn(i);   // warm
    const runs = [];
    for (let b = 0; b < 7; b++) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn(i);
      runs.push((performance.now() - t0) * 1e6 / n);
    }
    runs.sort((a, b) => a - b);
    return { nsPerOp: +runs[3].toFixed(0), lo: +runs[0].toFixed(0), hi: +runs[6].toFixed(0) };
  };
`;

const CASES = [
  ['new Intl.DateTimeFormat(en-US weekday) [construct only]', `time(() => { new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }); }, 400)`],
  ['new Intl.DateTimeFormat(en-CA y/m/d)   [construct only]', `time(() => { new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }); }, 400)`],
  ['hoisted fmt.format(date)               [reuse, no construct]', `(() => { const f = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }); const d = new Date(kicks[0]); return time(() => { f.format(d); }, 20000); })()`],
  ['render.formatKickoff(utc)   [2 constructs/call, as shipped]', `time((i) => render.formatKickoff(kicks[i % kicks.length]), 400)`],
  ['render.dayGroupKey(utc)     [1 construct/call, as shipped]', `time((i) => render.dayGroupKey(kicks[i % kicks.length]), 400)`],
  ['render.dayGroupLabel(utc)   [2 constructs/call, as shipped]', `time((i) => render.dayGroupLabel(kicks[i % kicks.length]), 400)`],
  ['league.cloneProfile(profile)          [JSON round-trip]', `time(() => league.cloneProfile(prof), 20000)`],
  ['league.normalizeProfile(profile)      [-> cloneProfile]', `time(() => league.normalizeProfile(prof), 20000)`],
  ['league.rosterSlots(profile)           [-> normalizeProfile]', `time(() => league.rosterSlots(prof), 20000)`],
  ['league.slotEligiblePositions(BN1,prof)[-> normalize x2]', `time(() => league.slotEligiblePositions('BN1', prof), 10000)`],
  ['league.rosterPositionsInPlay(profile) [-> normalizeProfile]', `time(() => league.rosterPositionsInPlay(prof), 20000)`],
  ['teamLogic.rosterGeometry(profile)     [WeakMap-cached]', `time(() => teamLogic.rosterGeometry(prof), 50000)`],
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox'] });
  const vp = VIEWPORTS.phone;
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  console.log('micro-benchmarks — median of 7 batches, fresh page per case, real shipped modules\n');
  console.log('  case                                                          ns/op    [min-max]');
  for (const [label, expr] of CASES) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/tests/perf/blank.html`, { waitUntil: 'load' });
    const r = await page.evaluate(`(async () => { ${PRELUDE} return ${expr}; })()`);
    await page.close();
    console.log(`  ${label.padEnd(60)}${String(r.nsPerOp).padStart(8)}   [${r.lo}-${r.hi}]`);
  }
  // Call counts per slate paint.
  const page = await ctx.newPage();
  await page.goto(`${BASE}/tests/perf/blank.html`, { waitUntil: 'load' });
  const counts = await page.evaluate(`(async () => {
    const render = await import('/app/render.js');
    const preds = await (await fetch('/data/game_predictions.json')).json();
    const games = preds.games || [];
    const kicks = games.map((g) => g.kickoff_utc).filter(Boolean);
    const groups = new Set(kicks.map((k) => render.dayGroupKey(k))).size;
    return { games: games.length, groups,
      intlConstructions: games.length * 2 + games.length * 1 + groups * 2 };
  })()`);
  await browser.close();
  console.log(`\n  slate paint: ${counts.games} game cards, ${counts.groups} day groups`);
  console.log(`  => Intl.DateTimeFormat objects constructed per slate paint: ${counts.intlConstructions}`);
})();
