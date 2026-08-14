/* tests/perf/paint-cost.mjs — the number the DOM-mutation clock misses.
 *
 * mount-cost.mjs stops the clock at the LAST DOM mutation. But assigning
 * innerHTML returns before the browser has done style recalc, layout and paint
 * for that markup — so a view that writes 173 kB of HTML in 18 ms can still cost
 * far more main-thread time than one that writes 52 kB in 24 ms. This script
 * closes that gap two ways:
 *
 *   toFrameMs      — time from the hash change to the first animation frame that
 *                    runs AFTER the view's last DOM write, i.e. the frame that
 *                    actually renders it. "When the user sees the route."
 *   mainThreadMs   — CDP Performance TaskDuration delta over an identical fixed
 *                    window for every route, so the harness floor cancels.
 *                    Report it relative to the cheapest route.
 *
 * All measurements are REPEAT mounts (modules + contracts already in memory), so
 * nothing here is network.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { INIT_SCRIPT, BASE, ROUTES, VIEWPORTS, waitQuiet, stats } from './lib.mjs';
import { buildRoster } from './seed.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REPS = Number(arg('--reps', 9));
const FILL = Number(arg('--fill', 8));
const OUT = arg('--out', null);

const ROSTER = buildRoster(FILL);
const SEED = FILL === 0 ? '' : `try { localStorage.setItem('nfl2026.team.v1', ${JSON.stringify(JSON.stringify(ROSTER))}); } catch (_) {}`;

const WINDOW_MS = 600; // identical for every route so the floor cancels

async function mountWithFrames(page, hash) {
  const t0 = await page.evaluate((h) => {
    if ((window.location.hash || '#/') === h) throw new Error(`same hash ${h}`);
    const R = window.__perf;
    R.reset();
    R.frames = [];
    const tick = (ts) => { R.frames.push(ts); if (R.frames.length < 200) requestAnimationFrame(tick); };
    const t = performance.now();
    requestAnimationFrame(tick);
    window.location.hash = h;
    return t;
  }, hash);
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  return page.evaluate((t0v) => {
    const R = window.__perf;
    const muts = R.mutations.filter((m) => m.t >= t0v);
    const last = muts.length ? muts[muts.length - 1].t : null;
    const frame = last == null ? null : (R.frames.find((f) => f >= last) ?? null);
    return {
      lastMutationMs: last == null ? null : last - t0v,
      toFrameMs: frame == null ? null : frame - t0v,
      frames: R.frames.length,
      longTasks: R.longTasks.filter((l) => l.start >= t0v).map((l) => +(l.dur).toFixed(1)),
    };
  }, t0);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox'] });
  const result = {};
  for (const vp of [VIEWPORTS.phone, VIEWPORTS.ipad]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch,
    });
    await ctx.addInitScript(INIT_SCRIPT + SEED);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(`${BASE}/#/`, { waitUntil: 'commit' });
    await waitQuiet(page, 0);
    // Warm every module + contract so nothing below touches the network.
    for (const [hash] of ROUTES.slice(1)) { await mountWithFrames(page, hash); }
    await mountWithFrames(page, '#/');

    const acc = {};
    for (const [, key] of ROUTES) acc[key] = { toFrame: [], lastMut: [], task: [], layout: [], style: [], lt: [] };
    for (let i = 0; i < REPS; i++) {
      for (const [hash, key] of [...ROUTES.slice(1), ROUTES[0]]) {
        const a = (await cdp.send('Performance.getMetrics')).metrics;
        const r = await mountWithFrames(page, hash);
        const b = (await cdp.send('Performance.getMetrics')).metrics;
        const g = (ms, n) => (ms.find((m) => m.name === n) || {}).value || 0;
        acc[key].toFrame.push(r.toFrameMs);
        acc[key].lastMut.push(r.lastMutationMs);
        acc[key].task.push((g(b, 'TaskDuration') - g(a, 'TaskDuration')) * 1000);
        acc[key].layout.push((g(b, 'LayoutDuration') - g(a, 'LayoutDuration')) * 1000);
        acc[key].style.push((g(b, 'RecalcStyleDuration') - g(a, 'RecalcStyleDuration')) * 1000);
        acc[key].lt.push(r.longTasks.reduce((s, x) => s + x, 0));
      }
    }
    result[vp.name] = {};
    for (const k of Object.keys(acc)) {
      result[vp.name][k] = {
        toFrameMs: stats(acc[k].toFrame),
        lastMutationMs: stats(acc[k].lastMut),
        mainThreadMs: stats(acc[k].task),
        layoutMs: stats(acc[k].layout),
        styleMs: stats(acc[k].style),
        longTaskMs: stats(acc[k].lt),
      };
    }
    await ctx.close();
  }
  await browser.close();
  if (OUT) writeFileSync(OUT, JSON.stringify({ reps: REPS, fill: FILL, result }, null, 1));
  for (const [vp, rs] of Object.entries(result)) {
    const floor = Math.min(...Object.values(rs).map((r) => r.mainThreadMs.med));
    console.log(`\n===== ${vp}  reps=${REPS}  rosterFill=${FILL}  (repeat mounts, ZERO network) =====`);
    console.log('route      lastMutation-ms       toFrame-ms            mainThread-ms         -floor  layout  style  longTask');
    for (const [k, r] of Object.entries(rs)) {
      const f = (x) => `${String(x.med).padStart(7)} [${x.min}-${x.max}]`.padEnd(22);
      console.log(`  ${k.padEnd(9)}${f(r.lastMutationMs)}${f(r.toFrameMs)}${f(r.mainThreadMs)}`
        + `${String((r.mainThreadMs.med - floor).toFixed(1)).padStart(7)}`
        + `${String(r.layoutMs.med).padStart(8)}${String(r.styleMs.med).padStart(7)}${String(r.longTaskMs.med).padStart(10)}`);
    }
    console.log(`  (harness floor = cheapest route's mainThread = ${floor} ms over a ${WINDOW_MS} ms window)`);
  }
})();
