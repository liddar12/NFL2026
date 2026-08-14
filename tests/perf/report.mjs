/* tests/perf/report.mjs — pretty-print a mount-cost.mjs result file. */
import { readFileSync } from 'node:fs';

const f = process.argv[2];
const d = JSON.parse(readFileSync(f, 'utf8'));
const m = (x) => (x && x.med != null ? x.med : null);
const sp = (x) => (x ? `${String(x.med).padStart(7)} [${x.min}-${x.max}]`.padEnd(21) : ''.padEnd(21));

for (const [vp, agg] of Object.entries(d.report)) {
  console.log(`\n=========== ${vp}   n=${d.runs}  seeded=${d.seeded} ===========`);
  console.log('LOAD (ms unless noted)      median [min-max]');
  for (const k of Object.keys(agg.load)) console.log(`  ${k.padEnd(24)} ${sp(agg.load[k])}`);

  console.log('\nCOLD DEEP-LINK  (fresh context, empty cache, land directly on the route)');
  console.log('  route      done-ms              fcp     wall   LTtot LTmax  fetches  kB   modules  viewNodes  layout style');
  for (const [k, v] of Object.entries(agg.routes)) {
    const c = v.cold;
    console.log(`  ${k.padEnd(9)}${sp(c.doneMs)}${String(m(c.fcp)).padStart(6)}${String(m(c.wallMs)).padStart(8)}`
      + `${String(m(c.longTaskTotal)).padStart(7)}${String(m(c.longTaskMax)).padStart(6)}`
      + `${String(c.dataFetches).padStart(8)}${String(Math.round(c.dataBytes / 1024)).padStart(7)}`
      + `${String(m(c.moduleCount)).padStart(8)}${String(m(c.viewNodes)).padStart(10)}`
      + `${String(m(c.layoutMs)).padStart(8)}${String(m(c.styleMs)).padStart(7)}`);
  }

  console.log('\nIN-SESSION MOUNT  (first = module+contract fetch still paid; repeat = ZERO network, pure compute+paint)');
  console.log('  route      first-ms             LT   fetch |  repeat-ms            repeat2         LTtot LTmax script style layout task  nodes');
  for (const [k, v] of Object.entries(agg.routes)) {
    const a = v.first; const b = v.repeat;
    console.log(`  ${k.padEnd(9)}${sp(a.mountMs)}${String(m(a.longTaskTotal)).padStart(5)}${String(a.dataFetches).padStart(7)}`
      + ` |${sp(b.mountMs)}${sp(b.mountMs2)}`
      + `${String(m(b.longTaskTotal)).padStart(6)}${String(m(b.longTaskMax)).padStart(6)}`
      + `${String(m(b.scriptMs)).padStart(7)}${String(m(b.styleMs)).padStart(6)}${String(m(b.layoutMs)).padStart(7)}`
      + `${String(m(b.taskMs)).padStart(6)}${String(m(b.nodesDelta)).padStart(7)}`);
  }

  console.log('\nDETAIL');
  for (const [k, v] of Object.entries(agg.routes)) {
    console.log(`  ${k}:`);
    console.log(`    cold contracts (${v.cold.dataFetches}, ${Math.round(v.cold.dataBytes / 1024)} kB raw): ${v.cold.dataNames.join(' ')}`);
    console.log(`    cold modules: ${m(v.cold.moduleCount)} files, ${Math.round(v.cold.moduleBytes / 1024)} kB`);
    console.log(`    first-mount contracts: ${v.first.dataNames.join(' ')}`);
    console.log(`    first-mount modules: ${v.first.codeNames.join(',')}`);
    console.log(`    cold contract waterfall (mount-relative ms): ${JSON.stringify(v.cold.waterfall)}`);
    console.log(`    cold contract wall=${m(v.cold.contractWaitMs)} serial-sum=${m(v.cold.contractSerialMs)}  first-mount wall=${m(v.first.contractWaitMs)} serial-sum=${m(v.first.contractSerialMs)}`);
    console.log(`    repeat mutations by target: ${JSON.stringify(v.repeat.mutationsByTarget)}`);
    console.log(`    repeat timeline: ${JSON.stringify(v.repeat.timeline)}`);
    console.log(`    view size: ${m(v.cold.viewChars)} chars / ${m(v.cold.viewNodes)} nodes`);
  }
}
