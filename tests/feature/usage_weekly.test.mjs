/* tests/feature/usage_weekly.test.mjs — WITHIN-SEASON through-week-N usage.
 *
 * data/player_usage_weekly.json is the in-season half of the usage story.
 * data/player_usage_history.json is SEASON-level and therefore cannot support a
 * within-season cut at all; that is the whole reason this artifact exists, and
 * the first test below pins the distinction so nobody "consolidates" them.
 *
 * What is locked here:
 *   1. GRAIN — weekly-derived cumulative cuts, a thing the season-level file
 *      structurally cannot express.
 *   2. MULTIPLE CUTS — the measurement behind this feature had ONE week-6 cut.
 *      The builder must produce several, across several seasons, and must
 *      RECORD which ones it produced.
 *   3. CUMULATIVE CORRECTNESS — counting stats are monotone across cuts, the
 *      player set only grows, and wopr is exactly its own definition.
 *   4. HONESTY — applied_weight pinned to 0, limits non-empty and still saying
 *      the wider cut grid is unmeasured, reconciliation MEASURED against
 *      nflverse's own columns, racr null (never 0) where the denominator is 0,
 *      and not one market column anywhere in the file.
 *   5. WIRING — schema registered in the validator, selftest wired into smoke.
 *
 * Node built-ins only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(REPO_ROOT, 'data');
const ARTIFACT = join(DATA, 'player_usage_weekly.json');
const BUILDER = join(REPO_ROOT, 'scripts', 'build_player_usage_weekly.py');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const doc = load(ARTIFACT);
const meta = doc.__meta__;
const seasons = doc.seasons;
const seasonKeys = Object.keys(seasons).sort();
const CANON = new Set(load(join(DATA, 'fixtures', 'teams.json')).teams.map((t) => t.abbrev));

/** every [season, cut, playerId, record] in the artifact */
const allRows = [];
for (const [s, block] of Object.entries(seasons)) {
  for (const [cut, cb] of Object.entries(block.cuts)) {
    for (const [pid, rec] of Object.entries(cb.players)) allRows.push([s, Number(cut), pid, rec]);
  }
}

test('grain: weekly-derived cuts, which the season-level usage file cannot express', () => {
  assert.equal(meta.grain, 'through_week_cumulative');
  assert.equal(meta.season_type, 'REG');
  assert.match(meta.source, /stats_player_week/);
  for (const block of Object.values(seasons)) {
    assert.ok(Array.isArray(block.weeks_available) && block.weeks_available.length >= 4);
    assert.equal(block.weeks_available[0], 1, 'weeks start at 1');
    // strictly increasing, no gaps invented
    for (let i = 1; i < block.weeks_available.length; i += 1) {
      assert.ok(block.weeks_available[i] > block.weeks_available[i - 1]);
    }
  }
  // The season-level file has no cut concept — this is not a duplicate of it.
  const hist = load(join(DATA, 'player_usage_history.json'));
  const someSeason = Object.values(hist.seasons)[0];
  const someRec = Object.values(someSeason)[0];
  assert.deepEqual(Object.keys(someRec).sort(), ['opp', 'share', 'team'],
    'player_usage_history is season-level {team,opp,share}: no week, no cut');
  assert.ok(!('cuts' in someSeason), 'season-level file cannot answer "through week 6"');
});

test('MULTIPLE cuts across MULTIPLE seasons, and the artifact records which', () => {
  assert.ok(seasonKeys.length >= 2, `only ${seasonKeys.length} season(s)`);
  assert.ok(meta.cuts_requested.length >= 2, 'the builder must request several cuts');
  assert.deepEqual(Object.keys(meta.cuts_produced).sort(), seasonKeys,
    'cuts_produced must cover exactly the seasons present');
  assert.deepEqual(meta.seasons_produced.map(String).sort(), seasonKeys);
  for (const s of seasonKeys) {
    const produced = meta.cuts_produced[s];
    assert.ok(produced.length >= 2,
      `season ${s} produced ${produced.length} cut(s) — the single-cut limit must be gone`);
    assert.deepEqual(Object.keys(seasons[s].cuts).map(Number).sort((a, b) => a - b), produced,
      `season ${s}: cuts block and cuts_produced disagree`);
    // Only cuts the season actually reached; the rest are recorded, not invented.
    const lastWeek = seasons[s].weeks_available.at(-1);
    for (const n of produced) assert.ok(n <= lastWeek, `season ${s} cut ${n} > week ${lastWeek}`);
    const missing = meta.cuts_requested.filter((n) => !produced.includes(n));
    const skipped = (meta.cuts_skipped[s] || []).map((x) => x.cut);
    assert.deepEqual(missing.sort(), skipped.sort(),
      `season ${s}: every unproduced cut must be recorded in cuts_skipped with a reason`);
  }
  // The measured week-6 cut is present, so the original result is reproducible.
  for (const s of seasonKeys) assert.ok(meta.cuts_produced[s].includes(6), `season ${s} week-6 cut`);
});

test('cumulative correctness: counting stats monotone, player set only grows', () => {
  for (const s of seasonKeys) {
    const cuts = Object.keys(seasons[s].cuts).map(Number).sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i += 1) {
      const prev = seasons[s].cuts[String(cuts[i - 1])];
      const next = seasons[s].cuts[String(cuts[i])];
      assert.ok(next.n_players >= prev.n_players,
        `${s} cut ${cuts[i]} has fewer players than cut ${cuts[i - 1]}`);
      assert.equal(next.n_players, Object.keys(next.players).length, `${s} cut ${cuts[i]} n_players`);
      for (const [pid, p] of Object.entries(prev.players)) {
        const n = next.players[pid];
        assert.ok(n, `${s}: ${pid} present at cut ${cuts[i - 1]} vanished at ${cuts[i]}`);
        for (const k of ['targets', 'carries', 'games']) {
          assert.ok(n[k] >= p[k], `${s} ${pid} ${k} shrank ${p[k]} -> ${n[k]}`);
        }
      }
      // team_games grows with the cut and never exceeds it (byes lag by one).
      for (const [t, g] of Object.entries(next.team_games)) {
        assert.ok(g >= prev.team_games[t], `${s} ${t} team_games shrank`);
        assert.ok(g <= cuts[i] && g >= cuts[i] - 1, `${s} ${t} team_games ${g} vs cut ${cuts[i]}`);
      }
      assert.equal(Object.keys(next.team_games).length, 32, `${s} cut ${cuts[i]} team count`);
    }
    // Real within-season movement exists — otherwise the cuts carry no information.
    const [a, b] = [seasons[s].cuts[String(cuts[0])], seasons[s].cuts[String(cuts.at(-1))]];
    const moved = Object.keys(a.players)
      .filter((pid) => Math.abs(b.players[pid].target_share - a.players[pid].target_share) > 0.02);
    assert.ok(moved.length > 20,
      `${s}: only ${moved.length} players moved target share between cuts`);
  }
});

test('wopr is exactly its definition; shares and racr are consistent', () => {
  assert.ok(allRows.length > 1000, `only ${allRows.length} rows`);
  let nullRacr = 0;
  for (const [s, cut, pid, r] of allRows) {
    const where = `${s}/cut${cut}/${pid}`;
    assert.ok(r.target_share >= 0 && r.target_share <= 1, `${where} target_share`);
    assert.ok(r.air_yards_share >= -1 && r.air_yards_share <= 1, `${where} air_yards_share`);
    const wopr = 1.5 * r.target_share + 0.7 * r.air_yards_share;
    assert.ok(Math.abs(r.wopr - wopr) < 1e-4, `${where} wopr ${r.wopr} != ${wopr}`);
    assert.ok(Number.isInteger(r.targets) && r.targets >= 0, `${where} targets`);
    assert.ok(Number.isInteger(r.carries) && r.carries >= 0, `${where} carries`);
    assert.ok(Number.isInteger(r.games) && r.games >= 1 && r.games <= cut, `${where} games`);
    assert.ok(r.targets + r.carries > 0, `${where} touched the ball zero times`);
    assert.ok(CANON.has(r.team), `${where} team ${r.team}`);
    // racr is null EXACTLY when its denominator is non-positive — never 0.
    if (r.receiving_air_yards > 0) {
      assert.equal(typeof r.racr, 'number', `${where} racr should be a number`);
    } else {
      assert.equal(r.racr, null, `${where} racr must be null, not a fabricated 0`);
      nullRacr += 1;
    }
    // Zero targets cannot produce a share.
    if (r.targets === 0) assert.equal(r.target_share, 0, `${where}`);
  }
  assert.ok(nullRacr > 0, 'no null racr anywhere — the null path is untested by the data');
});

test('identity is stored once and every cut row resolves against it', () => {
  for (const s of seasonKeys) {
    const idx = seasons[s].players;
    assert.ok(Object.keys(idx).length > 200, `${s} player index`);
    for (const rec of Object.values(idx)) {
      assert.ok(['RB', 'WR', 'TE'].includes(rec.pos), `${s} pos ${rec.pos}`);
      assert.ok(rec.name.length > 0);
    }
    for (const cb of Object.values(seasons[s].cuts)) {
      for (const [pid, r] of Object.entries(cb.players)) {
        assert.ok(idx[pid], `${s}: ${pid} has no identity row`);
        assert.ok(!('name' in r) && !('pos' in r), `${s}: ${pid} duplicates identity into the cut`);
      }
    }
  }
});

test('HONESTY: weight pinned to 0, limits intact, nothing claimed that was not measured', () => {
  assert.equal(meta.applied_weight, 0, 'this artifact may never be applied at weight');
  assert.match(meta.policy, /weight 0|never-regress/i);
  assert.ok(meta.limits.length >= 6, `only ${meta.limits.length} limits`);
  // The stated limits of the original measurement survive in the artifact.
  const limits = meta.limits.join(' ');
  assert.match(limits, /TWO seasons/);
  assert.match(limits, /week-6 cut/);
  assert.match(limits, /no held-out season/);
  assert.match(limits, /UNMEASURED/,
    'the wider cut grid is not measured and the artifact must say so');
  // The measured deltas are the real ones, not rounded up.
  assert.deepEqual(meta.measured.within_season.r2_delta_over_points_only,
    { TE: 0.044, WR: 0.027, RB: 0.024 });
  assert.equal(meta.measured.within_season.n, 480);
  assert.equal(meta.measured.season_to_season.r2_delta_over_points_only, 0.005);
  assert.match(meta.measured.season_to_season.verdict, /NOT a pregame feature/);
  // Failures are recorded, never silently dropped.
  assert.ok(Array.isArray(meta.seasons_skipped));
  const requested = new Set(meta.seasons_requested);
  for (const s of meta.seasons_produced) assert.ok(requested.has(s), `${s} not requested`);
  const accountedFor = new Set([...meta.seasons_produced, ...meta.seasons_skipped.map((x) => x.season)]);
  for (const s of meta.seasons_requested) {
    assert.ok(accountedFor.has(s), `season ${s} requested but neither produced nor skipped`);
  }
});

test('reconciliation is MEASURED against nflverse own columns, not asserted', () => {
  for (const s of seasonKeys) {
    const rec = seasons[s].reconciliation;
    assert.ok(rec.checked > 1000, `${s} reconciled only ${rec.checked} rows`);
    assert.equal(rec.holds, true, `${s} reconciliation`);
    for (const k of ['max_abs_target_share', 'max_abs_air_yards_share', 'max_abs_wopr']) {
      assert.ok(rec[k] <= rec.tolerance, `${s} ${k}=${rec[k]} > tol ${rec.tolerance}`);
    }
  }
});

test('MARKET_DISPLAY_ONLY: no market column reaches this artifact', () => {
  const raw = readFileSync(ARTIFACT, 'utf8');
  for (const col of ['adp', 'auction', 'moneyline', 'spread', 'odds', 'kalshi',
    'polymarket', 'total_line', 'implied']) {
    assert.ok(!raw.includes(`"${col}"`), `market column ${col} leaked into the artifact`);
  }
});

test('wiring: schema registered, file optional-until-built, selftest in the gate', () => {
  const validator = readFileSync(join(REPO_ROOT, 'scripts', 'validate_data.py'), 'utf8');
  assert.match(validator,
    /"player_usage_weekly\.schema\.json": "player_usage_weekly\.json"/,
    'schema not registered in SCHEMA_TO_DATA');
  const optional = validator.slice(validator.indexOf('OPTIONAL_DATA'),
    validator.indexOf('OPTIONAL_DATA') + 500);
  assert.match(optional, /player_usage_weekly\.json/, 'not in OPTIONAL_DATA (runner-built)');
  const smoke = readFileSync(join(REPO_ROOT, 'tests', 'smoke.sh'), 'utf8');
  assert.match(smoke, /build_player_usage_weekly\.py --selftest/, 'selftest not in smoke.sh');

  const schema = load(join(DATA, 'contracts', 'player_usage_weekly.schema.json'));
  // The honesty pins live in the CONTRACT, so a future writer cannot drop them.
  assert.deepEqual(schema.properties.__meta__.properties.applied_weight.enum, [0]);
  assert.ok(schema.properties.__meta__.properties.limits.minItems >= 6);
  assert.equal(schema.properties.seasons.additionalProperties.properties
    .reconciliation.properties.holds.enum[0], true);
  assert.ok(!JSON.stringify(schema).includes('"$ref"'),
    'validate_data.py silently skips $ref — a $ref here is an unvalidated hole');
});

test('builder selftest passes on the committed fixture and writes nothing', () => {
  const before = { hash: createHash('sha256').update(readFileSync(ARTIFACT)).digest('hex'),
    mtime: statSync(ARTIFACT).mtimeMs };
  const fixture = join(DATA, 'fixtures', 'nflverse_sample', 'stats_player_week.csv');
  const fixtureHash = createHash('sha256').update(readFileSync(fixture)).digest('hex');
  const out = execFileSync('python3', [BUILDER, '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /selftest OK/);
  assert.equal(createHash('sha256').update(readFileSync(ARTIFACT)).digest('hex'), before.hash,
    'selftest rewrote data/player_usage_weekly.json');
  assert.equal(statSync(ARTIFACT).mtimeMs, before.mtime);
  assert.equal(createHash('sha256').update(readFileSync(fixture)).digest('hex'), fixtureHash,
    'selftest rewrote its own fixture');
});

test('builder is stdlib-only and imports no heavy dependency at module scope', () => {
  const src = readFileSync(BUILDER, 'utf8');
  for (const dep of ['numpy', 'pandas', 'scipy', 'nfl_data_py']) {
    assert.ok(!src.includes(dep), `${dep} may not appear in the builder`);
  }
  // Importing the module must not reach the network or need a pip install.
  const probe = execFileSync('python3', ['-c',
    'import scripts.build_player_usage_weekly as m; print(len(m.CUTS), len(m.LIMITS))'],
  { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT } });
  const [nCuts, nLimits] = probe.trim().split(' ').map(Number);
  assert.ok(nCuts >= 2 && nLimits >= 6, probe);
});
