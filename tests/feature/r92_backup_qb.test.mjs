/* tests/feature/r92_backup_qb.test.mjs — locks for R92 part C: the BACKUP-QB
 * CASCADE measurement (scripts/backtest_backup_qb.py, phase 1, measure only).
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. THE SELFTEST RUNS. Its synthetic corpus carries a planted backup-QB dip
 *      with a known multiplier, so the whole walk-forward path — room,
 *      condition, cap_gap, fold fit, candidate scoring — is exercised offline
 *      on every gate run, not only on the runner.
 *   2. THE ROOM CANNOT LIE. The quarterback order comes from a snapshot
 *      STRICTLY BEFORE the week (week 1 therefore has none, and is counted as
 *      `unknown` rather than guessed); Out means Out or Doubtful and never
 *      Questionable; QB2 out behind a healthy QB1 is still the baseline.
 *   3. CAP_GAP IS WALK-FORWARD AND NEVER INVENTED. Capability reads only
 *      dropbacks before the week, a passer under the dropback floor takes the
 *      FOLD's replacement-level pool (itself built from earlier seasons only),
 *      and a team-week with nothing knowable yields None — not a zero.
 *   4. THE FIT IS THE FIT. On a toy fold whose answer is known to the digit the
 *      flat multiplier and the cap_gap slope come back exactly; a fold under
 *      the row minimum stays neutral; every applied factor is clamped.
 *   5. NOTHING IS ADOPTED. Every candidate carries a boolean would_adopt that
 *      follows its own pooled numbers, a candidate that moves no row is never
 *      adoptable, the artifact's verdict is adopted:false, and build_weekly —
 *      the file a phase-2 factor would enter — does not mention backup_qb.
 *
 * Node built-ins only; python3 is already a fast-gate dependency (the pattern
 * is tests/feature/r70_lines.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/backtest_backup_qb.py';
const ARTIFACT = 'data/backup_qb_backtest.json';
const CONTRACT = 'data/contracts/backup_qb_backtest.schema.json';
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/* ------------------------------------------------------- 1. the selftest */

test('R92: backtest_backup_qb --selftest passes (planted dip, known fit, offline)', () => {
  const st = spawnSync('python3', [SCRIPT, '--selftest'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /selftest OK/);
});

/* --------------------------------------------------------- 2. the room */

test('R92: the quarterback room is read strictly before the week, and Questionable is not an absence', () => {
  const r = runPy(`
import json
from scripts import backtest_backup_qb as bq
from scripts.build_line_report import normalize_depth_rows
rows = [{"week": w, "club_code": "KC", "full_name": n, "gsis_id": n, "position": "QB",
         "depth_position": "QB", "depth_team": str(i + 1), "game_type": "REG"}
        for w in (1, 2) for i, n in enumerate(("A", "B", "C"))]
rows.append({"week": 2, "club_code": "KC", "full_name": "W", "gsis_id": "W", "position": "WR",
             "depth_position": "WR", "depth_team": "1", "game_type": "REG"})
depth = normalize_depth_rows(rows)
lag1 = bq.qb_depth_by_week(depth, {}, weeks=4, lag=1)
lag0 = bq.qb_depth_by_week(depth, {}, weeks=4, lag=0)
room = lag1[("KC", 2)]
hist = {"seasons": {"2024": {"LA": {"3": [
  {"id": "q1", "name": "q1", "position": "QB", "status": "Out"},
  {"id": "q2", "name": "q2", "position": "QB", "status": "Doubtful"},
  {"id": "q3", "name": "q3", "position": "QB", "status": "Questionable"},
  {"id": "w1", "name": "w1", "position": "WR", "status": "Out"}]}}}}
def cond(outs):
    c, qb1, exp = bq.room_condition(room, set(outs))
    return [c, qb1[1] if qb1 else None, exp[1] if exp else None]
print(json.dumps({
  "week1_lag1": ("KC", 1) in lag1, "week1_lag0": lag0[("KC", 1)][0][1],
  "room": room, "carried": lag1[("KC", 4)] == room,
  "healthy": cond([]), "qb1_out": cond(["A"]), "both_out": cond(["A", "B"]),
  "all_out": cond(["A", "B", "C"]), "qb2_out": cond(["B"]),
  "no_room": list(bq.room_condition(None, set())[:1]),
  "outs": {"|".join(map(str, k)): sorted(v) for k, v in bq.qb_outs_by_team_week(hist, 2024).items()},
  "conditions": list(bq.CONDITIONS), "statuses": list(bq.OUT_STATUSES),
}))`);
  assert.equal(r.week1_lag1, false, 'week 1 has no snapshot strictly before it');
  assert.equal(r.week1_lag0, 'A', 'lag 0 admits the same-week chart');
  assert.deepEqual(r.room, [[1, 'A', 'A'], [2, 'B', 'B'], [3, 'C', 'C']], 'rank order, QBs only');
  assert.equal(r.carried, true, 'the latest usable snapshot carries forward');
  assert.deepEqual(r.healthy, ['qb1', 'A', 'A']);
  assert.deepEqual(r.qb1_out, ['backup', 'A', 'B'], 'QB1 out -> QB2 is the expected starter');
  assert.deepEqual(r.both_out, ['qb3_plus', 'A', 'C']);
  assert.deepEqual(r.all_out, ['qb3_plus', 'A', null], 'a whole room out has no expected starter');
  assert.deepEqual(r.qb2_out, ['qb1', 'A', 'A'], 'QB2 out behind a healthy QB1 is the baseline');
  assert.deepEqual(r.no_room, ['unknown']);
  assert.deepEqual(r.outs, { 'LAR|3': ['q1', 'q2'] }, 'Out and Doubtful only, QBs only, team normalized');
  assert.deepEqual(r.conditions, ['qb1', 'backup', 'qb3_plus', 'unknown']);
  assert.deepEqual(r.statuses, ['Out', 'Doubtful']);
});

/* ------------------------------------------- 3. capability and cap_gap */

test('R92: capability is trailing and walk-forward; a thin passer takes the fold replacement pool', () => {
  const r = runPy(`
import json
from scripts import backtest_backup_qb as bq
epa = {"seasons": {"2022": {"KC": {str(w): {"passers": {
  "A": {"db": 60.0, "epa": 12.0, "name": "A"},
  "B": {"db": 30.0, "epa": 0.0, "name": "B"},
  "C": {"db": 1.0, "epa": -0.5, "name": "C"}}} for w in range(1, 7)}}}}
idx = bq.passer_index(epa)
rep = bq.replacement_level(epa, 2023)
A, B, C = (1, "A", "A"), (2, "B", "B"), (3, "C", "C")
print(json.dumps({
  "a": bq.trailing_capability(idx, "A", 2023, 1),
  "a_midseason": bq.trailing_capability(idx, "A", 2022, 5),
  "a_week1": bq.trailing_capability(idx, "A", 2022, 1),
  "c_thin": bq.trailing_capability(idx, "C", 2023, 1),
  "rep": rep, "rep_no_prior": bq.replacement_level(epa, 2022),
  "gap_measured": bq.cap_gap_for(idx, 2023, 1, A, B, rep),
  "gap_pooled": bq.cap_gap_for(idx, 2023, 1, A, C, rep),
  "gap_starts": bq.cap_gap_for(idx, 2023, 1, A, A, rep),
  "gap_absent": bq.cap_gap_for(idx, 2023, 1, A, None, None),
  "buckets": [bq.cap_gap_bucket("qb1", 0.0), bq.cap_gap_bucket("backup", None),
              bq.cap_gap_bucket("backup", -0.01), bq.cap_gap_bucket("backup", 0.0),
              bq.cap_gap_bucket("backup", 0.05), bq.cap_gap_bucket("backup", 0.2)],
  "min_db": bq.MIN_DB, "window": bq.TRAILING_DB, "season_db": bq.REPLACEMENT_SEASON_DB,
}))`);
  assert.deepEqual(r.a, [0.2, 360], 'EPA per dropback over every prior dropback');
  assert.deepEqual(r.a_midseason, [0.2, 240], 'strictly before the week');
  assert.deepEqual(r.a_week1, [null, 0], 'nothing before the first week is not a capability');
  assert.deepEqual(r.c_thin, [null, 6], 'under the dropback floor there is no measured number');
  // A threw 360 dropbacks in 2022 and is not replacement level; B (180) and C (6) are.
  assert.ok(Math.abs(r.rep - (-3 / 186)) < 1e-12, `replacement pool ${r.rep}`);
  assert.equal(r.rep_no_prior, null, 'no earlier season -> no pool, not a zero');
  assert.deepEqual(r.gap_measured, [0.2, 'measured/measured']);
  assert.ok(Math.abs(r.gap_pooled[0] - (0.2 - r.rep)) < 1e-12);
  assert.equal(r.gap_pooled[1], 'measured/replacement');
  assert.deepEqual(r.gap_starts, [0, 'qb1_starts'], 'QB1 starting is a zero gap by definition');
  assert.deepEqual(r.gap_absent, [null, 'absent'], 'absent is counted, never invented');
  assert.deepEqual(r.buckets, ['none', 'unknown', 'neg', '0.00-0.05', '0.05-0.15', '0.15+']);
  assert.equal(r.min_db, 100);
  assert.ok(r.window >= r.min_db && r.season_db > 0);
});

/* --------------------------------------------------- 4. the fold fit */

test('R92: the fold fit recovers a known toy answer, stays neutral when thin, and is clamped', () => {
  const r = runPy(`
import json
from scripts import backtest_backup_qb as bq
M, GAP = 0.8, 0.25
toy = [{"pos": "WR", "cond": "qb1", "v2": 10.0 + i, "actual": 10.0 + i, "cap_gap": 0.0}
       for i in range(40)]
toy += [{"pos": "WR", "cond": "backup", "v2": 10.0 + i, "actual": M * (10.0 + i),
         "cap_gap": GAP} for i in range(40)]
fit = bq.fit_position(toy, "WR")
thin = bq.fit_position(toy[:40] + toy[40:45], "WR")
wild = {"base": 1.0, "m": 9.0, "beta": -99.0, "n_backup": 99, "n_baseline": 99, "note": "fitted"}
biased = [dict(r, actual=r["actual"] * 0.5) for r in toy]   # v2 low by half everywhere
rows = [dict(r, season=s) for s in (2023, 2024, 2025) for r in toy]
folds = bq.fit_folds(rows, (2023, 2024, 2025), min_n=5)
print(json.dumps({
  "base": fit["base"], "m": fit["m"], "beta": fit["beta"],
  "n": [fit["n_baseline"], fit["n_backup"]], "note": fit["note"],
  "thin": [thin["m"], thin["beta"], thin["note"]],
  "empty": bq.fit_position([], "WR")["note"],
  "biased_m": bq.fit_position(biased, "WR")["m"], "biased_base": bq.fit_position(biased, "WR")["base"],
  "f_backup": bq.row_factor("backup_flat", {"cond": "backup", "cap_gap": GAP}, fit),
  "f_cap": bq.row_factor("cap_gap", {"cond": "backup", "cap_gap": GAP}, fit),
  "f_qb1": bq.row_factor("cap_gap", {"cond": "qb1", "cap_gap": 0.0}, fit),
  "f_unknown": bq.row_factor("cap_gap", {"cond": "unknown", "cap_gap": None}, fit),
  "f_no_gap": bq.row_factor("cap_gap", {"cond": "backup", "cap_gap": None}, fit),
  "clamp_hi": bq.row_factor("backup_flat", {"cond": "backup", "cap_gap": GAP}, wild),
  "clamp_lo": bq.row_factor("cap_gap", {"cond": "backup", "cap_gap": GAP}, wild),
  "clamp": list(bq.FACTOR_CLAMP),
  "fold_notes": [folds[s]["WR"]["note"] for s in (2023, 2024, 2025)],
  "fold_m": [folds[s]["WR"]["m"] for s in (2023, 2024, 2025)],
}))`);
  assert.ok(Math.abs(r.base - 1) < 1e-12, 'a fold with no level bias has base 1');
  assert.ok(Math.abs(r.m - 0.8) < 1e-9, `flat multiplier ${r.m}`);
  assert.ok(Math.abs(r.beta - (-0.8)) < 1e-9, `slope ${r.beta}`);  // (0.8 - 1) / 0.25
  assert.deepEqual(r.n, [40, 40]);
  assert.equal(r.note, 'fitted');
  assert.deepEqual(r.thin.slice(0, 2), [1, 0], 'a fold under the minimum fits nothing');
  assert.match(r.thin[2], /^neutral: only 5 backup rows/);
  assert.match(r.empty, /^neutral: no baseline rows/);
  assert.ok(Math.abs(r.biased_base - 0.5) < 1e-12, 'the fold level bias is measured');
  assert.ok(Math.abs(r.biased_m - 0.8) < 1e-9,
    'halving every actual changes base, not the cascade the candidate would apply');
  assert.ok(Math.abs(r.f_backup - 0.8) < 1e-9 && Math.abs(r.f_cap - 0.8) < 1e-9);
  assert.equal(r.f_qb1, 1, 'a QB1 week is untouched');
  assert.equal(r.f_unknown, 1, 'an unknown week is untouched');
  assert.equal(r.f_no_gap, 1, 'no cap_gap -> no factor');
  assert.deepEqual([r.clamp_lo, r.clamp_hi], r.clamp, 'a wild fit is clamped both ways');
  assert.deepEqual(r.fold_notes.slice(0, 1), ['neutral: no fold before 2023'],
    'the earliest scored season has no prior fold and stays neutral');
  assert.equal(r.fold_m[0], 1);
  assert.ok(Math.abs(r.fold_m[2] - 0.8) < 1e-9, 'later folds fit on the seasons before them');
});

/* ------------------------------------------- 5. the artifact adopts nothing */

test('R92: the synthetic run emits one boolean would_adopt per candidate and adopts nothing', () => {
  const r = runPy(`
import json
from scripts import backtest_backup_qb as bq
res = bq.run(*bq._synthetic(), min_fit_n=5)
doc = bq.artifact(res)
print(json.dumps({
  "names": [c["name"] for c in doc["candidates"]],
  "flags": [c["would_adopt"] for c in doc["candidates"]],
  "positions": sorted({c["position"] for c in doc["candidates"]}),
  "families": sorted({c["family"] for c in doc["candidates"]}),
  "adopted": doc["verdict"]["adopted"],
  "has_rows": "_rows" in doc,
  "keys": sorted(doc),
  "wr_backup_ratio": doc["residuals"]["WR"]["backup"]["ratio"],
  "wr_qb1_ratio": doc["residuals"]["WR"]["qb1"]["ratio"],
  "coverage": doc["coverage"],
}))`);
  assert.equal(r.names.length, 10, 'two families x four positions + ALL');
  assert.deepEqual(r.families, ['backup_flat', 'cap_gap']);
  assert.deepEqual(r.positions, ['ALL', 'QB', 'RB', 'TE', 'WR']);
  for (const f of r.flags) assert.equal(typeof f, 'boolean', 'would_adopt is a boolean per candidate');
  assert.equal(r.adopted, false, 'phase 1 adopts nothing');
  assert.equal(r.has_rows, false, 'the row dump never reaches the artifact');
  for (const key of ['generated_utc', 'seasons_scored', 'substrate', 'conditions', 'residuals',
    'candidates', 'verdict', 'policy', 'limits']) assert.ok(r.keys.includes(key), key);
  assert.ok(r.wr_backup_ratio < r.wr_qb1_ratio, 'the planted dip is visible in the residual table');
  assert.ok(r.coverage.chart_known > 0 && r.coverage.chart_known < r.coverage.rows,
    'week 1 has no chart and is counted');
});

test('R92: the committed artifact, when present, validates against its contract and its verdicts follow its numbers', () => {
  const contract = readJson(CONTRACT);
  assert.ok(!JSON.stringify(contract).includes('"$ref":'), 'the validator has no $ref (definitions inlined)');
  assert.equal(contract.additionalProperties, false, 'the contract is strict');
  if (!existsSync(join(REPO_ROOT, ARTIFACT))) return; // runner-built; absence is honest
  const r = runPy(`
import json
import scripts.validate_data as vd
schema = json.load(open("${CONTRACT}"))
doc = json.load(open("${ARTIFACT}"))
vd.validate_against_schema(doc, schema, "backup_qb_backtest")
print(json.dumps({"ok": True}))`);
  assert.equal(r.ok, true);
  const doc = readJson(ARTIFACT);
  assert.equal(doc.verdict.adopted, false);
  assert.equal(doc.model_incumbent, 'weekly_split_v2');
  assert.match(doc.policy, /MEASUREMENT ONLY/);
  assert.ok(doc.limits.length > 0, 'the limits are stated, not implied');
  const shipped = doc.shipped.pooled;
  for (const c of doc.candidates) {
    assert.equal(typeof c.would_adopt, 'boolean');
    const beats = c.pooled.mae <= shipped.mae && c.pooled.rank_corr >= shipped.rank_corr;
    assert.equal(c.would_adopt, beats && c.rows_moved > 0,
      `${c.name}: would_adopt must follow the pooled numbers, and a no-op is never adoptable`);
    for (const fold of c.fold_results) {
      assert.ok(fold.fit_seasons.every((s) => s < fold.season),
        `${c.name}: a fold may only fit on seasons before the one it scores`);
    }
    assert.ok(Math.abs(c.pooled.mae - shipped.mae) < 1, 'a measure-only factor cannot move the pool far');
  }
  assert.deepEqual(doc.verdict.adoptable_candidates,
    doc.candidates.filter((c) => c.would_adopt).map((c) => c.name).sort());
  assert.ok(!('_rows' in doc));
});

test('R92: nothing applies the cascade — build_weekly does not mention backup_qb, and neither does the app', () => {
  assert.ok(!read('scripts/build_weekly.py').includes('backup_qb'),
    'a phase-2 factor would enter build_weekly; phase 1 must leave no trace there');
  assert.ok(!read('scripts/build_weekly.py').includes('cap_gap'));
  const appFiles = readdirSync(join(REPO_ROOT, 'app'), { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.js'));
  assert.ok(appFiles.length > 20, 'the app tree was actually walked');
  for (const f of appFiles) {
    assert.ok(!read(join('app', f)).includes('backup_qb'), `${f} must not read the measurement`);
  }
  const script = read(SCRIPT);
  assert.match(script, /MEASUREMENT ONLY/);
  assert.ok(!/\bimport\s+(numpy|pandas|scipy)\b/.test(script), 'stdlib only');
});
