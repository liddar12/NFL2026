/* tests/feature/rel7_contracts.test.mjs — the family promotion gate, locked.
 *
 * These are INVARIANTS, not snapshots: the weekly cron rewrites the newest
 * format-2 entry, and one day a family may legitimately be adopted. Every
 * assertion here must stay true both before and after that day:
 *
 *   * the newest v2 entry covers all four families (environment 15-trial grid,
 *     rest 4 scales, epa_total + epa_pass trialed-or-skipped, never absent)
 *   * verdict consistency: adopted=false -> no family cleared the margin;
 *     adopted=true -> the adopted family cleared it AND game_params carries an
 *     applied block for it (the application path may not silently diverge)
 *   * calibration: bins partition the eval games (n sums to entry n) and each
 *     bin's expected prob sits inside its bounds
 *   * the epa_history file, WHEN present, matches its aggregate invariants
 *     (off totals mirror def totals league-wide — every play has both sides)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataPath = (rel) => fileURLToPath(new URL(`../../data/${rel}`, import.meta.url));
const read = (rel) => JSON.parse(readFileSync(dataPath(rel), 'utf8'));

const FAMILIES = ['environment', 'rest', 'epa_total', 'epa_pass'];

function latestV2() {
  const doc = read('model_tuning.json');
  const entry = (doc.history || []).find((h) => h.kind === 'signal_promotion' && h.format === 2);
  return { doc, entry };
}

test('family gate: newest v2 entry covers all four candidate families', () => {
  const { entry } = latestV2();
  assert.ok(entry, 'format-2 promotion entry recorded');
  const names = entry.families.map((f) => f.family);
  assert.deepEqual(names.sort(), [...FAMILIES].sort());
  const env = entry.families.find((f) => f.family === 'environment');
  assert.equal(env.trials.length, 15, 'venue x cold grid minus the zero combo');
  const rest = entry.families.find((f) => f.family === 'rest');
  assert.equal(rest.trials.length, 4, 'four non-zero rest scales');
  for (const fam of entry.families) {
    assert.ok(fam.skipped || fam.trials.length > 0,
      `${fam.family} must be trialed or explicitly skipped, never silent`);
    if (fam.skipped) assert.ok(fam.reason, 'a skip always carries its reason');
  }
});

test('family gate: verdict is consistent with the NEVER-REGRESS margin', () => {
  const { doc, entry } = latestV2();
  const margin = Number(entry.margin);
  assert.ok(margin > 0);
  const inc = Number(entry.incumbent_loss);
  for (const fam of entry.families) {
    if (fam.skipped) continue;
    const best = Math.min(...fam.trials.map((t) => t.log_loss));
    assert.equal(fam.best.log_loss, best, `${fam.family} best is the min trial`);
    if (!entry.adopted) {
      assert.ok(inc - best <= margin + 1e-12,
        `${fam.family} cleared the margin (${inc} -> ${best}) yet nothing was adopted`);
    }
  }
  if (entry.adopted) {
    const a = entry.adopted_family;
    assert.ok(a && FAMILIES.includes(a.family), 'adopted family named');
    assert.ok(inc - a.log_loss > margin, 'adoption implies the margin was cleared');
    // The application path must carry a matching applied block.
    const gp = doc.game_params || {};
    const block = {
      environment: gp.venue_hfa || gp.cold_hfa,
      rest: gp.rest_hfa,
      epa_total: gp.epa_hfa,
      epa_pass: gp.epa_hfa,
    }[a.family];
    assert.ok(block && block.applied, `game_params carries applied ${a.family} block`);
  }
});

test('family gate: calibration bins partition the eval games honestly', () => {
  const { entry } = latestV2();
  const cal = entry.calibration;
  assert.ok(cal && Array.isArray(cal.bins) && cal.bins.length === 10);
  const total = cal.bins.reduce((s, b) => s + b.n, 0);
  assert.equal(total, cal.n, 'bin counts sum to the graded-game count');
  assert.ok(cal.n >= 1000, `walk-forward covers 1000+ real games (got ${cal.n})`);
  for (const b of cal.bins) {
    if (b.n === 0) {
      assert.equal(b.expected, null);
      assert.equal(b.actual, null);
      continue;
    }
    assert.ok(b.expected >= b.p_lo - 1e-9 && b.expected <= b.p_hi + 1e-9,
      `bin ${b.p_lo}-${b.p_hi} mean prediction ${b.expected} inside its bounds`);
    assert.ok(b.actual >= 0 && b.actual <= 1);
  }
});

test('epa_history (when the runner has built it): league totals balance', () => {
  if (!existsSync(dataPath('epa_history.json'))) {
    // Runner-built; absence before the bootstrap dispatch is the documented state.
    return;
  }
  const doc = read('epa_history.json');
  for (const [season, teams] of Object.entries(doc.seasons)) {
    let off = 0;
    let def = 0;
    let offEpa = 0;
    let defEpa = 0;
    for (const weeks of Object.values(teams)) {
      for (const cell of Object.values(weeks)) {
        off += cell.off_plays;
        def += cell.def_plays;
        offEpa += cell.off_epa;
        defEpa += cell.def_epa;
      }
    }
    assert.equal(off, def, `season ${season}: every play has an offense AND a defense`);
    assert.ok(Math.abs(offEpa - defEpa) < 1.0,
      `season ${season}: EPA totals mirror across sides (${offEpa} vs ${defEpa})`);
    assert.ok(off >= 25000, `season ${season}: full-season play volume (got ${off})`);
  }
});
