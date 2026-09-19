/* tests/feature/data_contract.test.mjs — R25-F2: the contract-loading path.
 *
 * app/data.js is the ONLY door between the app and data/. Two properties keep
 * that door honest, and neither was locked by a test before this file:
 *
 *   1. ALLOWLIST. data/ holds 36 JSON files totalling ~15 MB, but only 15 are
 *      app-reachable (~1.7 MB). The rest are PIPELINE artifacts — intermediate
 *      inputs for scripts/ and signals/ — and the four largest of them
 *      (dvp_positional_history 4.1 MB, game_context 3.1 MB,
 *      player_usage_weekly 2.2 MB, epa_history 1.3 MB) would each on their own
 *      dwarf everything the app legitimately loads. The R25 audit measured 0
 *      runtime requests to any of them across all 7 routes; these tests make
 *      that a locked property instead of a lucky observation, so a future view
 *      cannot quietly hardcode a path and put 3 MB on a mount.
 *
 *   2. PROMISE-CACHE SEMANTICS. loadJson caches the *promise*, which is what
 *      lets a route's Promise.allSettled fan-out de-dupe to one request per
 *      contract. Its failure path must evict (so a 404 is retryable) but must
 *      evict ONLY its own entry (so a force/clearCache refresh is not thrown
 *      away by a superseded request's later rejection). Before the identity
 *      guard, that race cost an extra network fetch of a contract already in
 *      hand: the repro below measured 3 requests where 2 is correct.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_DIR = join(REPO_ROOT, 'app');
const DATA_DIR = join(REPO_ROOT, 'data');

/* ------------------------------------------------------------------ helpers */

function appSources() {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) out.push([p.slice(REPO_ROOT.length + 1), readFileSync(p, 'utf8')]);
    }
  };
  walk(APP_DIR);
  return out;
}

/** Every '/data/<name>.json' literal that appears anywhere in app/. */
function referencedDataPaths() {
  const hits = new Map(); // file -> Set(path)
  for (const [rel, src] of appSources()) {
    // R73 — '/' admitted so /data/parlays/index.json is caught by the allowlist.
    for (const m of src.matchAll(/['"`](\/data\/[A-Za-z0-9_./-]+\.json)['"`]/g)) {
      if (!hits.has(m[1])) hits.set(m[1], new Set());
      hits.get(m[1]).add(rel);
    }
  }
  return hits;
}

/* -------------------------------------------------------- 1. the allowlist */

// R73 — the parlay HISTORY lives under data/parlays/: index.json (the week
// list) plus one archived parlays document per week (2026_wk01.json ...).
// app/data.js is the only reader (getParlaysIndex / getParlayArchive, the
// latter refusing any path outside the prefix); archives are fetched only on
// a past-week chip tap. Both are allowed here by prefix + pattern.
const PARLAY_HISTORY_PREFIX = '/data/parlays/';
const PARLAY_ARCHIVE_RE = /^\/data\/parlays\/\d{4}_wk\d{2}\.json$/;

test('app/data.js PATHS is the app-reachable contract allowlist, and every entry exists', () => {
  const src = readFileSync(join(APP_DIR, 'data.js'), 'utf8');
  // R73 — the character class admits '/' so the parlays/ history paths are counted.
  const paths = [...src.matchAll(/'(\/data\/[A-Za-z0-9_./-]+\.json)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 14, `expected the frozen PATHS allowlist, found ${paths.length} entries`);
  assert.equal(new Set(paths).size, paths.length, 'PATHS has a duplicate contract path');
  for (const p of paths) {
    // R73 — data/parlays/ is written by the parlay ledger only once a week has
    // been archived, so on a checkout that predates the first archive the
    // index is legitimately absent (the app treats its 404 as "no history").
    // Its presence is asserted by the ledger's own tests, not here.
    if (p.startsWith(PARLAY_HISTORY_PREFIX)) continue;
    assert.ok(
      statSync(join(REPO_ROOT, p.slice(1)), { throwIfNoEntry: false }),
      `app/data.js promises ${p} but the file does not exist`,
    );
  }
});

// The named artifacts from the R25 brief plus the general rule that produced
// them: anything in data/ that the app's allowlist does not name is a pipeline
// artifact and must be unreachable from app/.
const NAMED_PIPELINE_ARTIFACTS = [
  'game_context.json',
  'player_usage_weekly.json',
  'dvp_positional_history.json',
  'epa_history.json',
  'adp_history.json',
  'scheme_history.json',
  'injury_history.json',
  'player_usage_history.json',
  'weather_history.json',
];

test('no view can reach a pipeline artifact: every /data/ path in app/ is on the allowlist', () => {
  const referenced = referencedDataPaths();
  const allowed = new Set([
    // app/data.js PATHS
    '/data/player_projections.json', '/data/game_predictions.json', '/data/parlays.json',
    '/data/meta.json', '/data/pipeline_status.json', '/data/schedule_full.json',
    '/data/player_weekly.json', '/data/ai_insights.json', '/data/player_history.json',
    '/data/team_strength.json', '/data/market_prices.json', '/data/playoff_odds.json',
    '/data/model_tuning.json', '/data/adp.json',
    // R45 — facts-only rookie starters (schema'd, validated; no projection
    // field by contract), read by the PLAYERS rookies-only strip.
    '/data/rookie_starters.json',
    // app/kdst.js — the one contract loaded outside data.js, same cache pattern
    '/data/kdst_projections.json',
    // R49 — app/sleeper-proj.js: Sleeper's own projections, DISPLAY ONLY
    // (the doc declares display_only:true and the reader refuses one that
    // does not). Fetched lazily after first paint by PLAYERS/GRADE; 404 is a
    // normal state. Same promise-cache pattern as kdst.js.
    '/data/sleeper_projections.json',
    '/data/weekly_backtest.json',
    '/data/parlay_backtest.json',
    // R70 — the LINE REPORT (OL / DL-front starters x injury report), read by
    // LINEUP / GRADE / PLAYERS chips. Annotation only; changes no number.
    '/data/line_report.json',
    // R71 — app/review.js: the post-game review, read through loadJson (same
    // promise cache), lazily imported by the slate/parlays views after paint.
    '/data/review.json',
    // R73 — the parlay history index (see PARLAY_HISTORY_PREFIX above); the
    // per-week archives it names match PARLAY_ARCHIVE_RE and are never literal.
    '/data/parlays/index.json',
    // R76 — app/views/myparlays.js: the MY PARLAYS candidate leg pool, read
    // through loadJson (same promise cache) ONLY when the MY chip is tapped.
    // It is the one pipeline-sized artifact the app may load, and it earns that
    // because the feature IS searching it; app/parlay-math.js, which only does
    // arithmetic over legs handed to it, deliberately names no contract at all.
    '/data/leg_pool.json',
    // R81 — app/views/model.js: the measure-only REPLAY LAB record, read
    // through the same resolve-to-null-on-404 loader as the two R51 backtest
    // records. Reporting only; nothing it carries is ever adopted.
    '/data/replay_lab.json',
    // R87 — app/views/myparlays.js: how the MY cards we offered actually did,
    // read through loadJson (same promise cache) for the one RECORD line under
    // the legend. Small by construction — it carries the GRADED cards and the
    // per-week blocks, never the ~900 offered cards a week, which stay in the
    // pipeline-only data/my_cards/ directory.
    '/data/my_card_scores.json',
  ]);
  const isAllowed = (p) => allowed.has(p) || PARLAY_ARCHIVE_RE.test(p);
  for (const [p, files] of referenced) {
    assert.ok(isAllowed(p), `app/ references non-allowlisted contract ${p} in ${[...files].join(', ')}`);
  }
  // and specifically: none of the heavy pipeline artifacts, by name
  for (const name of NAMED_PIPELINE_ARTIFACTS) {
    for (const [p, files] of referenced) {
      assert.ok(!p.endsWith(`/${name}`), `PIPELINE ARTIFACT ${name} is reachable from ${[...files].join(', ')}`);
    }
  }
});

test('every data/ file outside the allowlist is a pipeline artifact — unmentioned anywhere in app/', () => {
  const referenced = new Set(referencedDataPaths().keys());
  const onDisk = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const unreachable = onDisk.filter((f) => !referenced.has(`/data/${f}`));
  // Sanity: the split is real, not vacuous.
  assert.ok(unreachable.length > 0, 'expected pipeline-only artifacts to exist in data/');
  assert.ok(onDisk.length - unreachable.length >= 14, 'expected >=14 app-reachable contracts');
  for (const f of unreachable) {
    const bare = new RegExp(`\\b${f.replace(/[.]/g, '\\.')}`);
    for (const [rel, src] of appSources()) {
      assert.ok(!bare.test(src), `pipeline artifact ${f} is named in ${rel} — the app must never load it`);
    }
  }
});

test('fetch() happens only in app/data.js, app/kdst.js and app/sleeper-proj.js', () => {
  // If a view could call fetch directly, the allowlist above would not bind it.
  // R49 — sleeper-proj.js is the third contract reader (one path, lazy, 404-graceful).
  const READERS = ['app/data.js', 'app/kdst.js', 'app/sleeper-proj.js'];
  const offenders = appSources()
    .filter(([rel, src]) => /\bfetch\s*\(/.test(src) && !READERS.includes(rel))
    .map(([rel]) => rel);
  assert.deepEqual(offenders, [], `fetch() outside the contract readers: ${offenders.join(', ')}`);
});

/* ------------------------------------------- 2. promise-cache semantics */

// Load app/data.js against a stubbed fetch. A query string gives each test a
// module instance with its own empty cache Map.
async function withStubbedFetch(fn) {
  const real = globalThis.fetch;
  const calls = [];
  const pending = new Map(); // path -> [{resolve}]
  globalThis.fetch = (path) => {
    calls.push(path);
    let d;
    const p = new Promise((res) => { d = { resolve: res }; });
    if (!pending.has(path)) pending.set(path, []);
    pending.get(path).push(d);
    return p;
  };
  const url = new URL(pathToFileURL(join(APP_DIR, 'data.js')).href);
  url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  try {
    return await fn(await import(url.href), { calls, pending });
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const http = (status) => ({ ok: false, status });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('concurrent callers share ONE request per contract (the de-dupe the routes rely on)', async () => {
  await withStubbedFetch(async (data, { calls, pending }) => {
    const ps = [data.getPlayerProjections(), data.getPlayerProjections(), data.getPlayerProjections()];
    pending.get('/data/player_projections.json')[0].resolve(ok([{ id: 'a' }]));
    const vals = await Promise.all(ps);
    await data.getPlayerProjections(); // a later, separate mount
    assert.equal(calls.length, 1, 'four getter calls must issue exactly one fetch');
    for (const v of vals) assert.deepEqual(v, [{ id: 'a' }]);
  });
});

test('a 404 rejects cleanly AND evicts, so an optional contract stays retryable', async () => {
  await withStubbedFetch(async (data, { calls, pending }) => {
    const p1 = data.getAiInsights();
    pending.get('/data/ai_insights.json')[0].resolve(http(404));
    await assert.rejects(p1, /ai_insights\.json -> HTTP 404/);
    await tick();
    const p2 = data.getAiInsights();
    assert.equal(calls.length, 2, 'a rejected contract must not be cached — the retry must hit the network');
    pending.get('/data/ai_insights.json')[1].resolve(ok({ v: 1 }));
    assert.deepEqual(await p2, { v: 1 });
  });
});

test('a superseded request rejecting must NOT evict the refresh that replaced it', async () => {
  // Regression lock. Before the identity guard in loadJson this scenario cost
  // 3 fetches: the force refresh resolved and was cached, then the original
  // in-flight request failed and deleted the healthy entry, so the next getter
  // re-fetched a contract the app already had.
  await withStubbedFetch(async (data, { calls, pending }) => {
    const stale = data.getAdp();                 // fetch #1 — will fail
    const fresh = data.getAdp({ force: true });  // fetch #2 — will succeed
    const d = pending.get('/data/adp.json');
    d[1].resolve(ok([1, 2, 3]));
    assert.deepEqual(await fresh, [1, 2, 3]);
    d[0].resolve(http(500));                     // the superseded one now fails
    await assert.rejects(stale, /adp\.json -> HTTP 500/);
    await tick();

    const after = data.getAdp();
    assert.equal(calls.length, 2, 'the surviving cache entry must serve the next getter — no third fetch');
    assert.deepEqual(await after, [1, 2, 3], 'and it must still return the fresh contract');
  });
});

test('clearCache() mid-flight: the post-clear request survives the pre-clear failure', async () => {
  await withStubbedFetch(async (data, { calls, pending }) => {
    const stale = data.getMeta();
    data.clearCache();
    const fresh = data.getMeta();
    const d = pending.get('/data/meta.json');
    d[1].resolve(ok({ v: 2 }));
    assert.deepEqual(await fresh, { v: 2 });
    d[0].resolve(http(500));
    await assert.rejects(stale, /meta\.json -> HTTP 500/);
    await tick();

    const after = data.getMeta();
    assert.equal(calls.length, 2, 'no third fetch after a clearCache race');
    assert.deepEqual(await after, { v: 2 });
  });
});

test('getAll degrades per-contract (allSettled, never all) and is off the boot path', async () => {
  await withStubbedFetch(async (data, { pending }) => {
    const p = data.getAll();
    await tick();
    pending.get('/data/player_projections.json')[0].resolve(ok([{ id: 'a' }]));
    pending.get('/data/game_predictions.json')[0].resolve(http(500));
    pending.get('/data/parlays.json')[0].resolve(ok([]));
    pending.get('/data/meta.json')[0].resolve(ok({ v: 1 }));
    pending.get('/data/pipeline_status.json')[0].resolve(ok({ feeds: [] }));
    const out = await p;
    assert.deepEqual(out.playerProjections, [{ id: 'a' }]);
    assert.deepEqual(out.meta, { v: 1 });
    assert.match(out.gamePredictions.__error, /HTTP 500/, 'one bad feed must not blank the others');
  });

  // main.js must not pull five contracts on every boot.
  const main = readFileSync(join(APP_DIR, 'main.js'), 'utf8');
  assert.ok(!/\bgetAll\b/.test(main), 'main.js must not call getAll — it would fetch 5 contracts on every route');
});
