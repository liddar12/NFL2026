/* tests/feature/pipeline_wiring.test.mjs — a builder that nothing runs is a
 * dead artifact, and a shipped note that its own rows contradict is a lie.
 *
 * Two defects locked here, both found in the R20 review:
 *
 *   1. scripts/build_kdst.py and scripts/build_player_usage_weekly.py were
 *      wired to NO cron and to no build_all.py step, so data/kdst_projections
 *      .json and data/player_usage_weekly.json could never be refreshed by the
 *      pipeline. build_kdst.py's degradation path ("existing file untouched,
 *      exit 0") explicitly deferred to a cron that did not exist, which makes a
 *      stale file indistinguishable from a fresh one. Both now run in
 *      .github/workflows/backtest.yml next to the sibling nflverse builders
 *      that read the same release CSVs.
 *
 *   2. data/kdst_projections.json notes[0] claimed "kickers project 130-195,
 *      D/ST 100-185. Measured, not assumed." while its own rows spanned
 *      53.4-188.7 and 71.0-145.5. The range is now interpolated from the built
 *      rows (build_kdst._proj_range) instead of hardcoded. validate_data.py
 *      rule 5 enforces it mechanically; this is the second, independent voice.
 *      The eviction figures in the same sentence (38.8 / ~74) were correct and
 *      are still asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function workflowText() {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

// Every nflverse-fed builder that writes a committed data/ artifact. The three
// at the top were already wired; the two after them are the R20 orphans; the
// last three are the Rel18 family inputs, which shipped unwired — same defect,
// third time. build_scheme_history.py is the sharpest case: it claims a rebuild
// re-probes the FTN release and flips application.dark on its own, which is only
// true while a cron actually re-runs it.
const WIRED_BUILDERS = [
  'build_epa_history.py',
  'build_player_usage.py',
  'build_player_usage_history.py',
  'build_player_usage_weekly.py',
  'build_kdst.py',
  'build_game_context.py',
  'build_dvp_positional.py',
  'build_scheme_history.py',
  // R49 — the display-only Sleeper feed and the learning ledger's three steps.
  'build_sleeper_projections.py',
  'build_estimate_ledger.py',
  'resolve_estimates.py',
  'fit_player_signals.py',
];

test('every nflverse builder is run by some workflow', () => {
  const yml = workflowText();
  for (const script of WIRED_BUILDERS) {
    assert.ok(
      yml.includes(`scripts/${script}`),
      `scripts/${script} is not invoked by any .github/workflows file — its ` +
        'output can never be refreshed, so a stale artifact is ' +
        'indistinguishable from a fresh one',
    );
  }
});

test('build_kdst exit-0-on-feed-error defers to a cron that exists', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'build_kdst.py'), 'utf8');
  // The builder keeps the existing file and exits 0 when the feed 403s. That is
  // only honest while something else re-runs it.
  assert.ok(
    /existing output file is left\s*\n?untouched and we exit 0/.test(src),
    'degradation path text moved — re-check that it still names a real cron',
  );
  assert.ok(
    src.includes('.github/workflows/backtest.yml'),
    'build_kdst.py exits 0 on feed error but no longer names the workflow ' +
      'that refreshes it',
  );
  const yml = readFileSync(
    join(REPO_ROOT, '.github', 'workflows', 'backtest.yml'),
    'utf8',
  );
  assert.ok(
    yml.includes('scripts/build_kdst.py'),
    'backtest.yml no longer runs build_kdst.py',
  );
});

test('build_kdst does not hardcode a projection range in the note', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'build_kdst.py'), 'utf8');
  assert.ok(
    src.includes('_proj_range(kickers)') && src.includes('_proj_range(defenses)'),
    'notes[0] must interpolate the range measured off the built rows',
  );
  assert.ok(
    !/kickers project 130-195/.test(src),
    'the hardcoded 130-195 / 100-185 range is back — it was never measured',
  );
});

test('kdst_projections notes quote the range its own rows span', () => {
  const doc = JSON.parse(
    readFileSync(join(REPO_ROOT, 'data', 'kdst_projections.json'), 'utf8'),
  );
  const span = (rows) => {
    const v = rows.map((r) => r.proj_points).filter((x) => x != null);
    assert.ok(v.length > 0, 'no projected rows to measure');
    return [Math.min(...v), Math.max(...v)];
  };
  const checks = [
    [/kickers project ([\d.]+)-([\d.]+)/i, doc.kickers, 'kickers'],
    [/D\/ST ([\d.]+)-([\d.]+)/i, doc.defenses, 'defenses'],
  ];
  for (const note of doc.notes || []) {
    for (const [re, rows, label] of checks) {
      const m = re.exec(String(note));
      if (!m) continue;
      const [lo, hi] = span(rows);
      assert.ok(
        Math.abs(Number(m[1]) - lo) <= 0.05 && Math.abs(Number(m[2]) - hi) <= 0.05,
        `note quotes ${label} ${m[1]}-${m[2]} but rows span ` +
          `${lo.toFixed(1)}-${hi.toFixed(1)}`,
      );
    }
  }
});

test('the eviction figures in notes[0] are still the true ones', () => {
  const doc = JSON.parse(
    readFileSync(join(REPO_ROOT, 'data', 'kdst_projections.json'), 'utf8'),
  );
  const note = String((doc.notes || [])[0] || '');
  // These two WERE verified: re-cutting a merged pool at 300 moves the
  // threshold 38.8 -> 70.34 and drops exactly 74 offensive players.
  assert.match(note, /38\.8/);
  assert.match(note, /~74 offensive players/);
  assert.match(note, /projected\[:300\]/);
});
