/* tests/perf/mount-cost.mjs — R25-M1 route mount cost measurement.
 *
 * Usage:
 *   node tests/perf/mount-cost.mjs [--runs 7] [--out results.json] [--empty]
 * Requires a static server on 127.0.0.1:4321 (python3 -m http.server 4321).
 *
 * THREE numbers per route, because they answer three different questions:
 *
 *  1. COLD DEEP-LINK  — fresh context, empty HTTP cache, navigate straight to
 *     the route's URL. What a user pays when this route is their entry point:
 *     shell + module graph + every contract + compute + paint.
 *  2. FIRST IN-SESSION MOUNT — fresh context, land on '#/', then tap this tab
 *     first. Module import + contract fetch still paid, shell already up.
 *  3. REPEAT MOUNT — second visit in the same page. ES module registry and
 *     app/data.js's promise cache are both warm, so this isolates pure
 *     COMPUTE + PAINT with zero network.
 *
 * (1) - (3) is the network/module component; (3) is the per-mount recompute the
 * app pays every single time the user taps the tab.
 *
 * localStorage is seeded with a realistic FULL 13-slot roster (tests/perf/seed.mjs)
 * unless --empty is passed: an untouched install short-circuits #/lineup to an
 * empty state and gives #/team nothing to seat, which would understate both.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { INIT_SCRIPT, BASE, ROUTES, VIEWPORTS, mountRoute, waitQuiet, stats } from './lib.mjs';
import { buildRoster } from './seed.mjs';

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1]) || 7;
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const EMPTY = args.includes('--empty');
// Roster fill: 0 = untouched install, 8 = mid-draft (the state that actually
// exercises the fit engine: open slots exist), 13 = complete.
const FILL = args.includes('--fill') ? Number(args[args.indexOf('--fill') + 1]) : 13;

const ROSTER = buildRoster(EMPTY ? 0 : FILL);
const SEED = (EMPTY || FILL === 0) ? '' : `
try { localStorage.setItem('nfl2026.team.v1', ${JSON.stringify(JSON.stringify(ROSTER))}); } catch (_) {}
`;

const METRIC_KEYS = ['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration',
  'JSHeapUsedSize', 'Nodes', 'LayoutCount', 'RecalcStyleCount'];

async function metrics(cdp) {
  const { metrics: ms } = await cdp.send('Performance.getMetrics');
  const out = {};
  for (const m of ms) if (METRIC_KEYS.includes(m.name)) out[m.name] = m.value;
  return out;
}
function delta(a, b) {
  const o = {};
  for (const k of METRIC_KEYS) {
    o[k] = +(((b[k] || 0) - (a[k] || 0)) * (k.endsWith('Duration') ? 1000 : 1)).toFixed(1);
  }
  return o;
}

async function newCtx(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  });
  await ctx.addInitScript(INIT_SCRIPT + SEED);
  return ctx;
}

function annotate(rec, met) {
  const dataRes = rec.resources.filter((r) => r.name.includes('/data/'));
  const codeRes = rec.resources.filter((r) => r.name.includes('/app/'));
  return {
    mountMs: rec.mountMs == null ? null : +rec.mountMs.toFixed(1),
    mutations: rec.mutationCount,
    mutationsByTarget: rec.mutationsByTarget,
    longTasks: rec.longTasks,
    longTaskTotal: +rec.longTasks.reduce((s, l) => s + l.dur, 0).toFixed(1),
    longTaskMax: rec.longTasks.length ? +Math.max(...rec.longTasks.map((l) => l.dur)).toFixed(1) : 0,
    dataFetches: dataRes.length,
    dataBytes: dataRes.reduce((s, r) => s + (r.dec || 0), 0),
    dataNames: dataRes.map((r) => `${r.name.split('/').pop()}:${((r.end - r.start) || 0).toFixed(0)}ms`),
    // Waterfall, mount-relative: proves whether the contracts overlap (parallel
    // Promise.allSettled) or step (sequential awaits).
    waterfall: dataRes.map((r) => ({
      f: r.name.split('/').pop(), s: +r.start.toFixed(1), e: +r.end.toFixed(1), kB: Math.round((r.dec || 0) / 1024),
    })).sort((a, b) => a.s - b.s),
    // Wall time from mount start to the LAST contract byte — the "awaiting
    // contracts" component, when there is any network at all.
    contractWaitMs: dataRes.length ? +(Math.max(...dataRes.map((r) => r.end)) - Math.min(...dataRes.map((r) => r.start))).toFixed(1) : 0,
    contractSerialMs: +dataRes.reduce((s, r) => s + (r.end - r.start), 0).toFixed(1),
    codeNames: codeRes.map((r) => r.name.split('/').pop().split('?')[0]),
    firstMutation: rec.firstMutation == null ? null : +rec.firstMutation.toFixed(1),
    timeline: rec.mutationTimeline.slice(0, 30),
    metrics: met,
  };
}

/* ---- (1) cold deep-link: one fresh context per route --------------------- */
async function coldDeepLink(browser, vp, hash) {
  const ctx = await newCtx(browser, vp);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const m0 = await metrics(cdp);
  const t = Date.now();
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'commit' });
  const rec = await waitQuiet(page, 0);
  const m1 = await metrics(cdp);
  const extra = await page.evaluate(() => {
    const p = {};
    performance.getEntriesByType('paint').forEach((e) => { p[e.name] = e.startTime; });
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    return {
      fp: p['first-paint'] || null,
      fcp: p['first-contentful-paint'] || null,
      dcl: nav ? nav.domContentLoadedEventEnd : null,
      transferAll: res.reduce((s, e) => s + (e.transferSize || 0), 0),
      decodedAll: res.reduce((s, e) => s + (e.decodedBodySize || 0), 0),
      moduleCount: res.filter((e) => e.name.includes('/app/') && e.name.endsWith('.js')).length,
      moduleBytes: res.filter((e) => e.name.includes('/app/') && e.name.endsWith('.js'))
        .reduce((s, e) => s + (e.decodedBodySize || 0), 0),
      viewChars: (document.getElementById('view') || { innerHTML: '' }).innerHTML.length,
      viewNodes: document.getElementById('view') ? document.getElementById('view').querySelectorAll('*').length : 0,
    };
  });
  const out = { ...annotate(rec, delta(m0, m1)), ...extra, wallMs: Date.now() - t };
  await ctx.close();
  return out;
}

/* ---- (2)+(3) in-session sweeps ------------------------------------------- */
async function sessionRun(browser, vp) {
  const ctx = await newCtx(browser, vp);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const routes = {};

  await page.goto(`${BASE}/#/`, { waitUntil: 'commit' });
  await waitQuiet(page, 0);

  for (const [hash, key] of ROUTES.slice(1)) { // '#/' already mounted
    const a = await metrics(cdp);
    const rec = await mountRoute(page, hash);
    const b = await metrics(cdp);
    routes[key] = { first: annotate(rec, delta(a, b)) };
  }
  { // slate first-visit-in-session, measured after the sweep returns to it
    const a = await metrics(cdp);
    const rec = await mountRoute(page, '#/');
    const b = await metrics(cdp);
    routes.slate = { first: annotate(rec, delta(a, b)) };
  }
  for (const [hash, key] of [...ROUTES.slice(1), ROUTES[0]]) {
    const a = await metrics(cdp);
    const rec = await mountRoute(page, hash);
    const b = await metrics(cdp);
    routes[key].repeat = annotate(rec, delta(a, b));
  }
  // second repeat pass — proves the repeat number is stable, not a one-off
  for (const [hash, key] of [...ROUTES.slice(1), ROUTES[0]]) {
    const rec = await mountRoute(page, hash);
    routes[key].repeat2 = { mountMs: rec.mountMs == null ? null : +rec.mountMs.toFixed(1) };
  }

  /* WARM LOAD: a second visit — new page in the same context, so the HTTP
   * cache (and the /data must-revalidate 304 path) are primed like a returning
   * user's, but the JS VM and module registry start empty. */
  const p2 = await ctx.newPage();
  const cdp2 = await ctx.newCDPSession(p2);
  await cdp2.send('Performance.enable');
  const w0 = await metrics(cdp2);
  const t = Date.now();
  await p2.goto(`${BASE}/#/`, { waitUntil: 'commit' });
  const warmRec = await waitQuiet(p2, 0);
  const w1 = await metrics(cdp2);
  const wp = await p2.evaluate(() => {
    const p = {};
    performance.getEntriesByType('paint').forEach((e) => { p[e.name] = e.startTime; });
    return {
      fp: p['first-paint'] || null,
      fcp: p['first-contentful-paint'] || null,
      transferAll: performance.getEntriesByType('resource').reduce((s, e) => s + (e.transferSize || 0), 0),
    };
  });
  const warm = { ...annotate(warmRec, delta(w0, w1)), ...wp, wallMs: Date.now() - t };
  await ctx.close();
  return { routes, warm };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
  const raw = [];
  for (const vp of [VIEWPORTS.phone, VIEWPORTS.ipad]) {
    for (let i = 0; i < RUNS; i++) {
      process.stderr.write(`  ${vp.name} run ${i + 1}/${RUNS} …`);
      const cold = {};
      for (const [hash, key] of ROUTES) cold[key] = await coldDeepLink(browser, vp, hash);
      const sess = await sessionRun(browser, vp);
      raw.push({ viewport: vp.name, run: i, cold, ...sess });
      process.stderr.write(' done\n');
    }
  }
  await browser.close();

  const report = {};
  for (const vp of [VIEWPORTS.phone.name, VIEWPORTS.ipad.name]) {
    const runs = raw.filter((r) => r.viewport === vp);
    const agg = { load: {}, routes: {} };
    agg.load.coldFcp = stats(runs.map((r) => r.cold.slate.fcp));
    agg.load.coldFirstPaintToDone = stats(runs.map((r) => r.cold.slate.mountMs));
    agg.load.coldWall = stats(runs.map((r) => r.cold.slate.wallMs));
    agg.load.warmFcp = stats(runs.map((r) => r.warm.fcp));
    agg.load.warmDone = stats(runs.map((r) => r.warm.mountMs));
    agg.load.warmWall = stats(runs.map((r) => r.warm.wallMs));
    agg.load.coldTransferBytes = stats(runs.map((r) => r.cold.slate.transferAll));
    agg.load.warmTransferBytes = stats(runs.map((r) => r.warm.transferAll));
    for (const [, key] of ROUTES) {
      const c = runs.map((r) => r.cold[key]);
      const f = runs.map((r) => r.routes[key].first);
      const p = runs.map((r) => r.routes[key].repeat);
      const p2 = runs.map((r) => r.routes[key].repeat2);
      agg.routes[key] = {
        cold: {
          doneMs: stats(c.map((x) => x.mountMs)),
          fcp: stats(c.map((x) => x.fcp)),
          wallMs: stats(c.map((x) => x.wallMs)),
          longTaskTotal: stats(c.map((x) => x.longTaskTotal)),
          longTaskMax: stats(c.map((x) => x.longTaskMax)),
          dataFetches: c[0].dataFetches,
          dataNames: c[0].dataNames,
          dataBytes: c[0].dataBytes,
          waterfall: c[0].waterfall,
          contractWaitMs: stats(c.map((x) => x.contractWaitMs)),
          contractSerialMs: stats(c.map((x) => x.contractSerialMs)),
          moduleCount: stats(c.map((x) => x.moduleCount)),
          moduleBytes: c[0].moduleBytes,
          viewChars: stats(c.map((x) => x.viewChars)),
          viewNodes: stats(c.map((x) => x.viewNodes)),
          layoutMs: stats(c.map((x) => x.metrics.LayoutDuration)),
          styleMs: stats(c.map((x) => x.metrics.RecalcStyleDuration)),
          scriptMs: stats(c.map((x) => x.metrics.ScriptDuration)),
        },
        first: {
          mountMs: stats(f.map((x) => x.mountMs)),
          longTaskTotal: stats(f.map((x) => x.longTaskTotal)),
          dataFetches: f[0].dataFetches,
          dataNames: f[0].dataNames,
          dataBytes: f[0].dataBytes,
          codeNames: f[0].codeNames,
          waterfall: f[0].waterfall,
          contractWaitMs: stats(f.map((x) => x.contractWaitMs)),
          contractSerialMs: stats(f.map((x) => x.contractSerialMs)),
        },
        repeat: {
          mountMs: stats(p.map((x) => x.mountMs)),
          mountMs2: stats(p2.map((x) => x.mountMs)),
          longTaskTotal: stats(p.map((x) => x.longTaskTotal)),
          longTaskMax: stats(p.map((x) => x.longTaskMax)),
          scriptMs: stats(p.map((x) => x.metrics.ScriptDuration)),
          styleMs: stats(p.map((x) => x.metrics.RecalcStyleDuration)),
          layoutMs: stats(p.map((x) => x.metrics.LayoutDuration)),
          taskMs: stats(p.map((x) => x.metrics.TaskDuration)),
          nodesDelta: stats(p.map((x) => x.metrics.Nodes)),
          dataFetches: p[0].dataFetches,
          mutationsByTarget: p[0].mutationsByTarget,
          timeline: p[0].timeline,
        },
      };
    }
    report[vp] = agg;
  }
  const payload = { runs: RUNS, seeded: !EMPTY, fill: EMPTY ? 0 : FILL, rosterSlots: Object.keys(ROSTER.slots).length, report, raw };
  if (OUT) writeFileSync(OUT, JSON.stringify(payload, null, 1));
  process.stdout.write(JSON.stringify({ runs: RUNS, seeded: !EMPTY, fill: EMPTY ? 0 : FILL, report }, null, 1));
})();
