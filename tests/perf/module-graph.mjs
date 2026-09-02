/* tests/perf/module-graph.mjs — cost of the EAGER module graph.
 *
 * main.js dynamically imports views/team.js so the 3.6k-line Team builder and
 * its subgraph stay off the boot path. app/views/players.js line 53 statically
 * imports './team.js' (for cfgFromProfile), and main.js statically imports
 * players.js — so the whole subgraph loads on EVERY route including '#/'.
 * This measures what that costs, two ways:
 *
 *   NETWORK+PARSE : fresh context, empty HTTP cache, time an import() of the
 *                   entry module and everything it pulls.
 *   PARSE ONLY    : HTTP cache pre-warmed in the same context, then a NEW page
 *                   imports the same graph — network is a cache hit, so the
 *                   number is fetch-from-cache + parse + compile + evaluate.
 *                   This is the component brotli does NOT remove.
 *
 * Entry points compared:
 *   slate-only  = what '#/' genuinely needs (render/data/slate/parlays)
 *   as-shipped  = what main.js actually pulls today (adds players.js -> team.js)
 */
import { chromium } from 'playwright';
import { BASE, VIEWPORTS, stats } from './lib.mjs';

const REPS = Number(process.argv.includes('--reps') ? process.argv[process.argv.indexOf('--reps') + 1] : 7);

const GRAPHS = {
  'slate-only (render+data+slate)': ['/app/views/slate.js', '/app/render.js', '/app/data.js'],
  'as-shipped (main.js static graph)': ['/app/views/slate.js', '/app/views/players.js', '/app/render.js', '/app/data.js', '/app/gate.js'],
  'team subgraph alone': ['/app/views/team.js'],
  'lineup view': ['/app/views/lineup.js'],
  'model view': ['/app/views/model.js'],
  'compare view': ['/app/views/compare.js'],
};

const TIMER = (mods) => `(async () => {
  const t0 = performance.now();
  await Promise.all(${JSON.stringify(mods)}.map((m) => import(m)));
  const t1 = performance.now();
  const res = performance.getEntriesByType('resource').filter((e) => e.name.includes('/app/') && e.name.endsWith('.js'));
  return {
    ms: t1 - t0,
    files: res.length,
    decoded: res.reduce((s, e) => s + (e.decodedBodySize || 0), 0),
    transfer: res.reduce((s, e) => s + (e.transferSize || 0), 0),
    waves: [...new Set(res.map((e) => Math.round(e.startTime / 10) * 10))].length,
  };
})()`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ['--no-sandbox'] });
  const vp = VIEWPORTS.phone;
  const out = {};
  for (const [name, mods] of Object.entries(GRAPHS)) {
    const cold = []; const warm = []; let meta = null;
    for (let i = 0; i < REPS; i++) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const p = await ctx.newPage();
      await p.goto(`${BASE}/tests/perf/blank.html`, { waitUntil: 'load' });
      const c = await p.evaluate(TIMER(mods));
      cold.push(c.ms); meta = c;
      // Same context => HTTP cache primed. New page => empty module registry.
      const p2 = await ctx.newPage();
      await p2.goto(`${BASE}/tests/perf/blank.html`, { waitUntil: 'load' });
      const w = await p2.evaluate(TIMER(mods));
      warm.push(w.ms);
      await ctx.close();
    }
    out[name] = {
      files: meta.files, decodedKB: Math.round(meta.decoded / 1024), waves: meta.waves,
      coldMs: stats(cold), parseOnlyMs: stats(warm),
    };
  }
  await browser.close();
  console.log(`module graph cost, n=${REPS}, uncompressed local server\n`);
  console.log('graph                                          files   kB  waves   cold-ms(net+parse)      parse-only-ms');
  for (const [k, v] of Object.entries(out)) {
    console.log(`  ${k.padEnd(44)}${String(v.files).padStart(4)}${String(v.decodedKB).padStart(6)}`
      + `${String(v.waves).padStart(6)}   ${String(v.coldMs.med).padStart(7)} [${v.coldMs.min}-${v.coldMs.max}]`.padEnd(28)
      + `   ${String(v.parseOnlyMs.med).padStart(6)} [${v.parseOnlyMs.min}-${v.parseOnlyMs.max}]`);
  }
  console.log(`\nraw: ${JSON.stringify(out)}`);
})();
