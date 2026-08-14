/* tests/feature/backtest_corpus.test.mjs — the EXPANDED backtest corpus.
 *
 * data/fixtures/backtest_corpus/ is the 27-season (1999-2025) fact table the
 * never-regress promotion gate can walk instead of the 1,359-game ESPN slice.
 * The tests below lock the three things that make it usable and honest:
 *
 *   1. SHAPE PARITY — every corpus record carries the full finals_{yr}.json
 *      key set, so a consumer changes only the directory it reads.
 *   2. AGREEMENT — on the 2021-2025 overlap the corpus reproduces the ESPN
 *      fixtures game-for-game, score-for-score.
 *   3. HONESTY — completed games only, integer scores, no market column ever
 *      copied in, no team code outside the canonical 32, and the season with
 *      no upstream kickoff times (1999) says so instead of inventing one.
 *
 * Node built-ins only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(REPO_ROOT, 'data', 'fixtures');
const CORPUS = join(FIXTURES, 'backtest_corpus');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const manifest = load(join(CORPUS, 'manifest.json'));
const seasonFiles = readdirSync(CORPUS)
  .filter((f) => /^finals_\d{4}\.json$/.test(f))
  .sort();
const corpus = new Map(
  seasonFiles.map((f) => {
    const doc = load(join(CORPUS, f));
    return [Number(doc.season), doc];
  }),
);
const allGames = [...corpus.values()].flatMap((d) => d.games);

const CANON = new Set(load(join(FIXTURES, 'teams.json')).teams.map((t) => t.abbrev));
const ESPN_KEYS = Object.keys(load(join(FIXTURES, 'finals_2021.json')).games[0]);
const EXTRA_KEYS = ['game_type', 'gameday', 'neutral_site'];
// games.csv ships these; a projection input may never reach the corpus.
const MARKET_COLS = [
  'spread_line', 'total_line', 'away_moneyline', 'home_moneyline',
  'away_spread_odds', 'home_spread_odds', 'under_odds', 'over_odds',
  'result', 'total',
];

test('corpus covers 27 completed seasons and 5x the ESPN baseline', () => {
  assert.equal(corpus.size, 27, '1999-2025 inclusive');
  assert.deepEqual([...corpus.keys()].sort((a, b) => a - b),
    Array.from({ length: 27 }, (_, i) => 1999 + i));
  assert.equal(allGames.length, 7276);
  assert.equal(manifest.total_games, allGames.length);
  const baseline = [2021, 2022, 2023, 2024, 2025]
    .reduce((n, y) => n + load(join(FIXTURES, `finals_${y}.json`)).games.length, 0);
  assert.equal(baseline, 1359, 'the old corpus, for the record');
  assert.ok(allGames.length > 5 * baseline,
    `corpus ${allGames.length} must be >5x the ${baseline}-game ESPN slice`);
  // Per-season counts are the manifest's, not a recount that could drift.
  for (const s of manifest.seasons) {
    assert.equal(corpus.get(s.season).games.length, s.games, `season ${s.season}`);
    assert.equal(s.reg + s.post, s.games);
  }
  // The in-progress season is reported as skipped, not silently absent.
  assert.deepEqual(manifest.skipped_seasons.map((s) => s.season), [2026]);
  assert.match(manifest.skipped_seasons[0].reason, /no completed games/);
});

test('record shape parity with finals_{yr}.json (consumer reader unchanged)', () => {
  assert.ok(ESPN_KEYS.length === 12, ESPN_KEYS.join(','));
  for (const [season, doc] of corpus) {
    assert.deepEqual(Object.keys(doc).slice(0, 2), ['season', 'fetched_utc'],
      `season ${season} top-level shape`);
    assert.ok(Array.isArray(doc.games));
    for (const g of doc.games) {
      for (const k of ESPN_KEYS) {
        assert.ok(k in g, `season ${season} game ${g.game_id} missing ${k}`);
      }
      const extras = Object.keys(g).filter((k) => !ESPN_KEYS.includes(k));
      assert.deepEqual(extras.sort(), [...EXTRA_KEYS].sort(),
        `season ${season} game ${g.game_id} has undocumented extra keys`);
    }
  }
});

test('completed games only: FINAL status, integer scores, no fabricated result', () => {
  for (const g of allGames) {
    assert.equal(g.status, 'STATUS_FINAL', g.game_id);
    assert.equal(g.final, true, g.game_id);
    assert.ok(Number.isInteger(g.home_score) && Number.isInteger(g.away_score), g.game_id);
    assert.ok(g.home_score >= 0 && g.away_score >= 0, g.game_id);
    assert.ok(Number.isInteger(g.week) && g.week >= 1 && g.week <= 22, g.game_id);
    assert.match(g.gameday, /^\d{4}-\d{2}-\d{2}$/, g.game_id);
  }
  const ids = allGames.map((g) => g.game_id);
  assert.equal(new Set(ids).size, ids.length, 'game_ids must be unique corpus-wide');
});

test('MARKET_DISPLAY_ONLY: not one market column reaches the corpus', () => {
  for (const g of allGames) {
    for (const col of MARKET_COLS) {
      assert.ok(!(col in g), `market column ${col} leaked into ${g.game_id}`);
    }
  }
  const raw = readFileSync(join(CORPUS, 'finals_2024.json'), 'utf8');
  for (const col of MARKET_COLS) {
    assert.ok(!raw.includes(`"${col}"`), `${col} present in the season file text`);
  }
});

test('team codes reconcile: canonical 32, all present, no relocation code left', () => {
  const seen = new Set();
  for (const g of allGames) {
    assert.ok(CANON.has(g.home), `${g.game_id} home ${g.home}`);
    assert.ok(CANON.has(g.away), `${g.game_id} away ${g.away}`);
    assert.notEqual(g.home, g.away, g.game_id);
    seen.add(g.home); seen.add(g.away);
  }
  assert.equal(seen.size, 32, [...seen].sort().join(','));
  for (const legacy of ['LA', 'OAK', 'SD', 'STL']) {
    assert.ok(!seen.has(legacy), `un-normalised relocation code ${legacy}`);
  }
  // The renames are live, not decorative: the pre-move seasons exist.
  const preMove = corpus.get(2005).games;
  assert.ok(preMove.some((g) => g.home === 'LAR' || g.away === 'LAR'), '2005 STL -> LAR');
  assert.ok(preMove.some((g) => g.home === 'LV' || g.away === 'LV'), '2005 OAK -> LV');
  assert.ok(preMove.some((g) => g.home === 'LAC' || g.away === 'LAC'), '2005 SD -> LAC');
});

test('kickoff honesty: real ET->UTC conversion, null where upstream has none', () => {
  assert.equal(corpus.get(1999).kickoff_times_known, false);
  assert.ok(corpus.get(1999).games.every((g) => g.kickoff_utc === null),
    '1999 carries no clock time upstream — nulls, never a placeholder');
  assert.equal(manifest.games_without_kickoff_time, 259);
  assert.deepEqual(manifest.kickoff_complete_seasons,
    Array.from({ length: 26 }, (_, i) => 2000 + i));
  for (const [season, doc] of corpus) {
    if (season === 1999) continue;
    for (const g of doc.games) {
      assert.match(g.kickoff_utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/, g.game_id);
      // The UTC instant is within a day of the local gameday (DST + rollover).
      const drift = Math.abs(Date.parse(`${g.kickoff_utc.slice(0, 10)}T00:00Z`)
        - Date.parse(`${g.gameday}T00:00Z`));
      assert.ok(drift <= 86400000, `${g.game_id} kickoff/gameday drift`);
    }
  }
  // DST both ways, and the 2000-2005 legacy 12-hour night slot.
  const byId = new Map(allGames.map((g) => [g.game_id, g]));
  assert.equal(byId.get('2023_01_CAR_ATL').kickoff_utc, '2023-09-10T17:00Z'); // 13:00 EDT
  assert.equal(byId.get('2022_20_NYG_PHI').kickoff_utc, '2023-01-22T01:15Z'); // 20:15 EST
  assert.equal(byId.get('2000_01_DEN_STL').kickoff_utc, '2000-09-05T01:00Z'); // '09:00' = 21:00 ET
});

test('postseason is included and labelled (the ESPN fixtures are REG-only)', () => {
  const post = allGames.filter((g) => g.game_type !== 'REG');
  assert.equal(post.length, 309);
  const types = new Set(post.map((g) => g.game_type));
  assert.deepEqual([...types].sort(), ['CON', 'DIV', 'SB', 'WC']);
  assert.equal(post.filter((g) => g.game_type === 'SB').length, 27, 'one Super Bowl a season');
  assert.ok(allGames.filter((g) => g.game_type === 'REG').length === 6967);
  // Neutral-site flag is carried; every Super Bowl is one.
  assert.ok(post.filter((g) => g.game_type === 'SB').every((g) => g.neutral_site === true));
});

test('2021-2025 overlap reproduces the ESPN fixtures game-for-game', () => {
  let compared = 0;
  for (const year of [2021, 2022, 2023, 2024, 2025]) {
    const espn = load(join(FIXTURES, `finals_${year}.json`)).games;
    const mine = new Map(corpus.get(year).games
      .filter((g) => g.game_type === 'REG')
      .map((g) => [`${g.home}|${g.away}`, g]));
    assert.equal(mine.size, espn.length, `${year} regular-season game count`);
    for (const e of espn) {
      const g = mine.get(`${e.home}|${e.away}`);
      assert.ok(g, `${year} ${e.home} v ${e.away} missing from the corpus`);
      assert.equal(g.home_score, e.home_score, `${year} ${e.home} v ${e.away} home score`);
      assert.equal(g.away_score, e.away_score, `${year} ${e.home} v ${e.away} away score`);
      assert.equal(g.week, e.week, `${year} ${e.home} v ${e.away} week`);
      const delta = Math.abs(Date.parse(g.kickoff_utc.replace('Z', ':00Z'))
        - Date.parse(e.kickoff_utc.replace('Z', ':00Z'))) / 60000;
      assert.ok(delta <= 120, `${year} ${e.home} v ${e.away} kickoff off by ${delta} min`);
      compared += 1;
    }
  }
  assert.equal(compared, 1359);
});

test('promote_signals consumes corpus records unchanged (reader compatibility)', () => {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `
import json, sys
sys.path.insert(0, ".")
from scripts.promote_signals import rest_diffs, is_cold_game

out = {}
for yr in (1999, 2015):
    games = json.load(open(f"data/fixtures/backtest_corpus/finals_{yr}.json"))["games"]
    games.sort(key=lambda g: g.get("kickoff_utc") or "")   # the load_finals sort
    diffs = rest_diffs(games)
    out[yr] = {
        "n": len(games),
        "diffs": len(diffs),
        "nonzero": sum(1 for d in diffs if d),
        "cold": sum(1 for g in games if is_cold_game(g)),
    }
print(json.dumps(out))
`,
  });
  const r = JSON.parse(out);
  assert.equal(r['2015'].diffs, r['2015'].n);
  assert.ok(r['2015'].nonzero > 50, 'rest differentials compute off corpus kickoffs');
  assert.ok(r['2015'].cold > 0, 'cold-weather gating reads corpus kickoffs');
  // 1999 has no kickoff CLOCK times: the features degrade honestly, they do NOT
  // crash and they do NOT invent dates.
  assert.equal(r['1999'].diffs, r['1999'].n);
  // rest_diffs() reads `kickoff_utc` only, so with no kickoff stamp every rest
  // differential is neutral. Unchanged since this test was written.
  assert.equal(r['1999'].nonzero, 0);
  // EXISTING ASSERTION MODIFIED IN R24 — stated reason, because a bug-fix
  // release is changing a number this test had locked. It asserted 0 while
  // is_cold_game() read `kickoff_utc` only. R24 gave is_cold_game() the SAME
  // `gameday` fallback that load_finals() already sorts by and documents, so
  // the 1999 season now contributes the 61 of its 259 games played at a
  // cold-region open-air venue in Nov-Feb. That is not inventing a date:
  // `gameday` is a date the corpus record already carries. A record with NO
  // date at all is still not-cold, and `kickoff_utc` still wins when both are
  // present — both locked in never_regress.test.mjs ("R24: is_cold_game reads
  // the corpus gameday fallback, and invents nothing"), which is the assertion
  // this line used to contradict.
  //
  // Scope: the shipped 2021-2025 fixtures all carry kickoff_utc, so the default
  // (non-corpus) gate is byte-for-byte unchanged. Only --corpus runs reaching
  // the pre-2000 seasons see a different cold count.
  assert.equal(r['1999'].cold, 61);
});

test('builder selftest passes on committed fixtures and writes nothing', () => {
  const before = readdirSync(CORPUS).sort().join(',');
  const stamps = seasonFiles.map((f) => load(join(CORPUS, f)).fetched_utc).join(',');
  const out = execFileSync('python3', ['scripts/build_backtest_corpus.py', '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.match(out, /selftest OK/);
  assert.equal(readdirSync(CORPUS).sort().join(','), before, 'selftest added/removed files');
  assert.equal(seasonFiles.map((f) => load(join(CORPUS, f)).fetched_utc).join(','), stamps,
    'selftest rewrote committed fixtures');
});
