/* tests/perf/profile.mjs — CDP CPU-profile attribution for a route mount.
 *
 * Usage: node tests/perf/profile.mjs [--route team] [--reps 12] [--vp ipad]
 *
 * CDP's Performance.getMetrics ScriptDuration under-reports badly (it only
 * covers certain V8 execution scopes), so JS cost is attributed here with a real
 * sampled CPU profile instead: Profiler.setSamplingInterval(60us) around N
 * REPEAT mounts of the route (module registry + data.js promise cache already
 * warm, so nothing but compute + paint is inside the window). Self-time is then
 * summed per function and per source file.
 *
 * Reps are alternated route -> '#/' -> route so consecutive identical hashes
 * (which fire no hashchange) cannot silently skip a mount; the slate leg is
 * profiled too and reported separately so it can be subtracted mentally.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { INIT_SCRIPT, BASE, ROUTES, VIEWPORTS, mountRoute, waitQuiet } from './lib.mjs';
import { buildRoster } from './seed.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const REPS = Number(arg('--reps', 12));
const VP = VIEWPORTS[arg('--vp', 'ipad')];
const OUT = arg('--out', null);
const ONLY = arg('--route', null);

const FILL = Number(arg('--fill', 8));
const ROSTER = buildRoster(FILL);
const SEED = FILL === 0 ? '' : `try { localStorage.setItem('nfl2026.team.v1', ${JSON.stringify(JSON.stringify(ROSTER))}); } catch (_) {}`;

/** Fold a CDP CPU profile into self-time per node, per function, per file. */
function fold(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map(); // id -> ticks
  // timeDeltas[i] is the time BEFORE samples[i]; attribute it to samples[i].
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] || 0;
    const id = profile.samples[i];
    self.set(id, (self.get(id) || 0) + dt);
  }
  const fnKey = (n) => {
    const cf = n.callFrame;
    const file = (cf.url || '(vm)').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    return `${cf.functionName || '(anonymous)'} @ ${file}:${cf.lineNumber + 1}`;
  };
  const byFn = new Map();
  const byFile = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    total += us;
    const k = fnKey(n);
    byFn.set(k, (byFn.get(k) || 0) + us);
    const file = (n.callFrame.url || '(vm)').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    byFile.set(file, (byFile.get(file) || 0) + us);
  }
  const top = (mp, n) => [...mp.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, us]) => ({ k, ms: +(us / 1000).toFixed(2) }));
  // Ancestor attribution: total self-time under each distinct call chain, so a
  // hot leaf (cloneProfile) can be blamed on the caller that actually drives it.
  const parent = new Map();
  for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
  const chainOf = (id) => {
    const out = [];
    let cur = id;
    for (let i = 0; i < 12 && cur != null; i++) {
      const n = byId.get(cur);
      if (!n) break;
      out.push(`${n.callFrame.functionName || '(anon)'}@${(n.callFrame.url || '').split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`);
      cur = parent.get(cur);
    }
    return out.join(' <- ');
  };
  const byChain = new Map();
  for (const [id, us] of self) {
    if (!byId.has(id)) continue;
    const k = chainOf(id);
    byChain.set(k, (byChain.get(k) || 0) + us);
  }
  return {
    totalMs: +(total / 1000).toFixed(1), byFn: top(byFn, 30), byFile: top(byFile, 20),
    byChain: top(byChain, 40),
  };
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
  const out = {};
  for (const [hash, key] of ROUTES) {
    if (ONLY && key !== ONLY) continue;
    if (key === 'slate') continue; // slate is the alternation partner
    const ctx = await browser.newContext({
      viewport: { width: VP.width, height: VP.height },
      deviceScaleFactor: VP.deviceScaleFactor, isMobile: VP.isMobile, hasTouch: VP.hasTouch,
    });
    await ctx.addInitScript(INIT_SCRIPT + SEED);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await page.goto(`${BASE}/#/`, { waitUntil: 'commit' });
    await waitQuiet(page, 0);
    // Warm everything (modules + contracts) so the profiled reps are pure
    // compute + paint.
    await mountRoute(page, hash);
    await mountRoute(page, '#/');

    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 60 });

    // ---- profile the ROUTE legs only ----
    const routeMs = [];
    await cdp.send('Profiler.start');
    for (let i = 0; i < REPS; i++) {
      const r = await mountRoute(page, hash);
      routeMs.push(r.mountMs);
      await mountRoute(page, '#/'); // alternation partner, inside the profile
    }
    const { profile } = await cdp.send('Profiler.stop');

    // ---- profile the SLATE legs alone, so they can be subtracted ----
    await cdp.send('Profiler.start');
    for (let i = 0; i < REPS; i++) {
      await mountRoute(page, hash === '#/players' ? '#/parlays' : '#/players');
      await mountRoute(page, '#/');
    }
    const { profile: base } = await cdp.send('Profiler.stop');

    out[key] = {
      reps: REPS,
      routeMountMs: routeMs.map((x) => +x.toFixed(1)),
      profile: fold(profile),
      baselineProfile: fold(base),
    };
    process.stderr.write(`profiled ${key}: ${out[key].profile.totalMs} ms JS over ${REPS} reps\n`);
    await ctx.close();
  }
  await browser.close();
  const json = JSON.stringify({ viewport: VP.name, reps: REPS, out }, null, 1);
  if (OUT) writeFileSync(OUT, json);
  for (const [k, v] of Object.entries(out)) {
    console.log(`\n===== ${k}  (${REPS} reps, viewport ${VP.name}) =====`);
    const med = v.routeMountMs.slice().sort((a, b) => a - b)[v.routeMountMs.length >> 1];
    console.log(`mount ms per rep: median ${med}  all=${JSON.stringify(v.routeMountMs)}`);
    console.log(`JS self-time in profile window (route legs + slate legs): ${v.profile.totalMs} ms`);
    console.log('BY FILE (ms of JS self-time across all reps):');
    for (const r of v.profile.byFile) console.log(`   ${String(r.ms).padStart(8)}  ${r.k}`);
    console.log('TOP FUNCTIONS (self ms across all reps):');
    for (const r of v.profile.byFn) console.log(`   ${String(r.ms).padStart(8)}  ${r.k}`);
  }
})();
