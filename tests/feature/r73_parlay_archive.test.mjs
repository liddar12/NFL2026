/* tests/feature/r73_parlay_archive.test.mjs — R73 week-to-week parlay history +
 * the display-only $100 flat-stake P&L, locked.
 *
 *   1. scripts/build_parlay_archive.py (fixture runs in a temp data dir): first
 *      sight creates the week file; the same as-of is byte-identical; a reprice
 *      while open refreshes the cards and grows history; a week closes when every
 *      game is FINAL and is NEVER rewritten after; index shape, ordering and
 *      current_week; --dry-run writes nothing.
 *   2. scripts/build_review.stake_100 on tests/fixtures/r73/stake_fixture.json:
 *      all_hit pays the decimal product, a push drops the pushed leg at 1.0, a
 *      partial / all_missed loses the stake, pending is excluded from staked/net,
 *      a prop leg is assumed -110 (1.9091) and counted, the 1.02 vig re-pricing
 *      caps at 0.99.
 *   3. Committed data: data/parlays/<season>_wk<NN>.json + index.json mirror
 *      data/parlays.json and validate; data/review.json week 1 stake_100.week.n
 *      equals the count of scope=week parlays and staked == 100 * graded.
 *   4. The three --selftest runs and validate_data.py exit 0.
 *
 * Node built-ins only; Python cores driven through `python3 -` (the r71 pattern),
 * CLIs through spawnSync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FX = 'tests/fixtures/r73';
const PY_ENV = { ...process.env, PYTHONPATH: REPO_ROOT };
const ASSUMED = 1.9091;

function runPy(code) {
  const out = execFileSync('python3', ['-'], { cwd: REPO_ROOT, env: PY_ENV, input: code, encoding: 'utf8' });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

function archive(dataDir, parlays, schedule, now, extra = []) {
  const r = spawnSync('python3', ['scripts/build_parlay_archive.py', '--data', dataDir, '--parlays', parlays,
    '--schedule', schedule, '--now', now, ...extra], { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const load = (p) => JSON.parse(readFileSync(resolve(REPO_ROOT, p), 'utf8'));

/** The repo's one on-disk convention, checked by the writer's own language. */
function canonical(paths) {
  return runPy(`
import json
out = {}
for p in ${JSON.stringify(paths)}:
    raw = open(p, "rb").read()
    out[p] = raw == (json.dumps(json.loads(raw), ensure_ascii=True, indent=2) + "\\n").encode("utf-8")
print(json.dumps(out))`);
}

/* ------------------------------------------------------- 1. the archive */

test('archive: first sight creates, same as-of is byte-identical, reprice refreshes, close freezes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r73-'));
  try {
    const wk1 = join(tmp, 'parlays', '2026_wk01.json');
    const idx = join(tmp, 'parlays', 'index.json');
    // dry-run first: nothing on disk
    const dry = archive(tmp, `${FX}/parlays_wk1_a.json`, `${FX}/schedule_open.json`, '2026-09-13T11:00:00Z', ['--dry-run']);
    assert.match(dry, /--dry-run, 2 file\(s\) would be written, nothing written/);
    assert.ok(!existsSync(join(tmp, 'parlays')), 'dry-run creates nothing');
    // first sight
    const out1 = archive(tmp, `${FX}/parlays_wk1_a.json`, `${FX}/schedule_open.json`, '2026-09-13T11:00:00Z');
    assert.match(out1, /wk 1 created data\/parlays\/2026_wk01\.json \(open, 3 parlays/);
    const a = JSON.parse(readFileSync(wk1, 'utf8'));
    const src = load(`${FX}/parlays_wk1_a.json`);
    assert.deepEqual({ season: a.season, week: a.week, updated_utc: a.updated_utc, parlays: a.parlays }, src, 'verbatim');
    assert.equal(a.closed, false);
    assert.deepEqual(a.history, [{ updated_utc: '2026-09-13T10:00:00Z', archived_utc: '2026-09-13T11:00:00Z' }]);
    assert.deepEqual(Object.keys(a), ['season', 'week', 'updated_utc', 'parlays', 'archived_utc', 'closed', 'history']);
    assert.deepEqual(JSON.parse(readFileSync(idx, 'utf8')), {
      season: 2026, generated_utc: '2026-09-13T11:00:00Z', current_week: 1,
      weeks: [{ week: 1, path: 'data/parlays/2026_wk01.json', updated_utc: '2026-09-13T10:00:00Z',
        archived_utc: '2026-09-13T11:00:00Z', closed: false, n_parlays: 3, n_week_scope: 1, n_game_scope: 2 }],
    });
    assert.deepEqual(canonical([wk1, idx]), { [wk1]: true, [idx]: true }, 'ensure_ascii, indent=2, trailing newline');
    // same as-of again: unchanged, byte-identical, index untouched
    const raw1 = readFileSync(wk1);
    const rawIdx = readFileSync(idx);
    const out2 = archive(tmp, `${FX}/parlays_wk1_a.json`, `${FX}/schedule_open.json`, '2026-09-13T15:00:00Z');
    assert.match(out2, /wk 1 unchanged/);
    assert.match(out2, /index unchanged/);
    assert.ok(readFileSync(wk1).equals(raw1) && readFileSync(idx).equals(rawIdx));
    // reprice while open: refreshed to the last state, history grows
    const out3 = archive(tmp, `${FX}/parlays_wk1_b.json`, `${FX}/schedule_open.json`, '2026-09-14T17:00:00Z');
    assert.match(out3, /wk 1 refreshed/);
    const b = JSON.parse(readFileSync(wk1, 'utf8'));
    assert.equal(b.updated_utc, '2026-09-14T16:44:00Z');
    assert.equal(b.parlays[0].legs[0].implied_prob, 0.57, 'the repriced state replaces the old');
    assert.deepEqual(b.history.map((h) => h.updated_utc), ['2026-09-13T10:00:00Z', '2026-09-14T16:44:00Z']);
    assert.equal(b.history[0].archived_utc, '2026-09-13T11:00:00Z');
    assert.equal(b.closed, false);
    // parlays.json moves to week 2 while week 1 goes entirely FINAL
    const out4 = archive(tmp, `${FX}/parlays_wk2.json`, `${FX}/schedule_closed.json`, '2026-09-15T11:00:00Z');
    assert.match(out4, /wk 2 created/);
    assert.match(out4, /wk 1 closed data\/parlays\/2026_wk01\.json \(every game FINAL; content kept/);
    const c = JSON.parse(readFileSync(wk1, 'utf8'));
    assert.equal(c.closed, true);
    assert.equal(c.archived_utc, '2026-09-15T11:00:00Z');
    assert.deepEqual(c.parlays, b.parlays, 'closing changes the flag, never the cards');
    assert.deepEqual(c.history, b.history);
    const i4 = JSON.parse(readFileSync(idx, 'utf8'));
    assert.equal(i4.current_week, 2);
    assert.deepEqual(i4.weeks.map((w) => [w.week, w.closed, w.n_parlays]), [[1, true, 3], [2, false, 2]]);
    // a post-close reprice of week 1: frozen, byte-identical
    const rawC = readFileSync(wk1);
    const late = load(`${FX}/parlays_wk1_b.json`);
    late.updated_utc = '2026-09-16T09:00:00Z';
    late.parlays[0].model_ev = 9.9;
    const latePath = join(tmp, 'late.json');
    writeFileSync(latePath, `${JSON.stringify(late, null, 2)}\n`);
    const out5 = archive(tmp, latePath, `${FX}/schedule_closed.json`, '2026-09-16T10:00:00Z');
    assert.match(out5, /wk 1 is closed .* data\/parlays\/2026_wk01\.json not rewritten/);
    assert.ok(readFileSync(wk1).equals(rawC), 'a closed week is never rewritten');
    // every written file validates against its contract
    const r = runPy(`
import json, os
from scripts import validate_data as vd
errs = {}
for name, schema in (("2026_wk01.json", "parlays_archive.schema.json"), ("2026_wk02.json", "parlays_archive.schema.json"), ("index.json", "parlays_index.schema.json")):
    doc = json.load(open(os.path.join(${JSON.stringify(tmp)}, "parlays", name)))
    e = []
    vd._validate(doc, json.load(open(os.path.join("data", "contracts", schema))), name, e)
    errs[name] = e[:3]
print(json.dumps(errs))`);
    assert.deepEqual(r, { '2026_wk01.json': [], '2026_wk02.json': [], 'index.json': [] });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('archive pure core: closed only when the week has rows and every one is FINAL; index sorted by week', () => {
  const r = runPy(`
import json
from scripts import build_parlay_archive as pa
o = json.load(open("${FX}/schedule_open.json"))["games"]
c = json.load(open("${FX}/schedule_closed.json"))["games"]
d1 = {"season": 2026, "week": 2, "updated_utc": "u", "parlays": [{"scope": "week"}], "archived_utc": "a", "closed": False, "history": []}
d2 = dict(d1, week=1, closed=True, parlays=[{"scope": "game"}, {"scope": "game"}])
ix = pa.index_doc(2026, [(d1, "p2"), (d2, "p1")], 2, "t")
print(json.dumps({"open1": pa.week_closed(o, 1), "closed1": pa.week_closed(c, 1), "closed2": pa.week_closed(c, 2),
  "none": pa.week_closed(c, 9), "empty": pa.week_closed([], 1),
  "weeks": [w["week"] for w in ix["weeks"]], "scopes": [[w["n_week_scope"], w["n_game_scope"]] for w in ix["weeks"]],
  "gen_only": pa.index_changed(dict(ix, generated_utc="u"), ix), "names": [pa.archive_name(2026, 3), pa.parse_archive_name("2026_wk12.json"), pa.parse_archive_name("index.json")]}))`);
  assert.deepEqual(r, { open1: false, closed1: true, closed2: false, none: false, empty: false,
    weeks: [1, 2], scopes: [[0, 2], [1, 0]], gen_only: false, names: ['2026_wk03.json', [2026, 12], null] });
});

/* ----------------------------------------------------------- 2. the P&L */

test('stake_100: all_hit product, push drop-out, loss, pending excluded, assumed -110 prop, vig cap', () => {
  const r = runPy(`
import json
from scripts import build_review as br
fx = json.load(open("${FX}/stake_fixture.json"))
idx = br.ledger_price_index(fx["parlay_ledger"])
s = br.stake_100(fx["parlays"], fx["week"], idx)
only_pending = br.stake_100([fx["parlays"][3]], 1, idx)["week"]
print(json.dumps({"s": s, "idx_n": len(idx), "z": only_pending, "consts": [br.STAKE, br.ASSUMED_DECIMAL, br.VIG2_FACTOR, br.VIG2_CAP]}))`);
  assert.deepEqual(r.consts, [100, ASSUMED, 1.02, 0.99]);
  assert.equal(r.idx_n, 8);
  const v = (ip) => 1 / Math.min(0.99, ip * 1.02);
  const r2 = (x) => Number(x.toFixed(2));
  const w = r.s.week;
  // week: all_hit 2.0 x 4.0 = +700; push (spread void at 1.0, ML 2.0) = +100; partial -100; pending excluded
  assert.deepEqual([w.n, w.graded, w.hit, w.push, w.staked, w.net_fair, w.assumed_price_legs], [4, 3, 1, 1, 300, 700, 0]);
  assert.equal(w.net_vig2, r2(100 * (v(0.5) * v(0.25) - 1) + 100 * (v(0.5) - 1) - 100));
  assert.equal(w.net_vig2, 665.01);
  assert.match(w.note, /\$100 flat on each of the 4 week-scope parlays: 3 graded \(1 all_hit paid, 1 push with pushed legs at 1.0, 1 lost -100\), 1 pending excluded/);
  assert.match(w.note, /Display-only money, never a model input/);
  const g = r.s.game;
  // game: ML 2.0 x prop assumed 1.9091 = +281.82; all_missed -100; 0.995 favourite +0.5 fair / +1.01 at the 0.99 cap;
  // an ML leg the ledger never saw is assumed too (2 assumed legs)
  assert.deepEqual([g.n, g.graded, g.hit, g.push, g.staked, g.assumed_price_legs], [4, 4, 3, 0, 400, 2]);
  assert.equal(g.net_fair, r2(100 * (2 * ASSUMED - 1) - 100 + 100 * (1 / 0.995 - 1) + 100 * (ASSUMED - 1)));
  assert.equal(g.net_fair, 273.23);
  assert.equal(r2(100 * (2 * ASSUMED - 1)), 281.82);
  assert.equal(g.net_vig2, r2(100 * (v(0.5) * v(1 / ASSUMED) - 1) - 100 + 100 * (1 / 0.99 - 1) + 100 * (v(1 / ASSUMED) - 1)));
  assert.equal(g.net_vig2, 255.17);
  assert.ok(g.net_vig2 < g.net_fair, 'the vig can only cost');
  assert.match(g.note, /2 leg\(s\) with no book price/);
  // nothing graded -> staked 0, net null (never 0)
  assert.deepEqual(r.z, { n: 1, graded: 0, hit: 0, push: 0, staked: 0, net_fair: null, net_vig2: null,
    assumed_price_legs: 0, note: r.z.note });
});

/* --------------------------------------------------- 3. committed data */

test('committed archive: the open week mirrors data/parlays.json, index consistent, contracts green', () => {
  const parlays = load('data/parlays.json');
  const name = `data/parlays/${parlays.season}_wk${String(parlays.week).padStart(2, '0')}.json`;
  const arch = load(name);
  if (!arch.closed) {
    assert.deepEqual({ season: arch.season, week: arch.week, updated_utc: arch.updated_utc, parlays: arch.parlays }, parlays,
      'an open week mirrors parlays.json (refreshed on every run while open)');
  }
  assert.equal(typeof arch.closed, 'boolean');
  assert.ok(arch.history.length >= 1 && arch.history.some((h) => h.updated_utc === arch.updated_utc));
  const idx = load('data/parlays/index.json');
  assert.equal(idx.season, parlays.season);
  assert.equal(idx.current_week, parlays.week, 'current_week follows parlays.json (the pipeline default week)');
  const weeks = idx.weeks.map((w) => w.week);
  assert.deepEqual(weeks, [...weeks].sort((a, b) => a - b), 'sorted by week');
  assert.equal(new Set(weeks).size, weeks.length, 'one entry per week');
  const e = idx.weeks.find((w) => w.week === parlays.week);
  assert.deepEqual([e.path, e.updated_utc, e.archived_utc, e.closed, e.n_parlays, e.n_week_scope, e.n_game_scope], [
    name, arch.updated_utc, arch.archived_utc, arch.closed,
    arch.parlays.length, arch.parlays.filter((p) => p.scope === 'week').length,
    arch.parlays.filter((p) => p.scope === 'game').length]);
  for (const w of idx.weeks) assert.ok(existsSync(resolve(REPO_ROOT, w.path)), `${w.path} exists`);
  const paths = ['data/parlays/index.json', ...idx.weeks.map((w) => w.path)];
  const canon = canonical(paths);
  for (const p of paths) assert.equal(canon[p], true, `${p} canonical JSON`);
});

test('committed review.json: week 1 stake_100.week.n == scope=week parlays, staked == 100 * graded, both scopes typed', () => {
  const review = load('data/review.json');
  const wk = review.weeks['1'];
  assert.ok(wk, 'week 1 block');
  const st = wk.summary.parlays.stake_100;
  assert.deepEqual(Object.keys(st), ['week', 'game']);
  const nWeek = wk.parlays.filter((p) => p.scope === 'week').length;
  const nGame = wk.parlays.filter((p) => p.scope === 'game').length;
  assert.equal(st.week.n, nWeek);
  assert.equal(st.game.n, nGame);
  for (const scope of ['week', 'game']) {
    const b = st[scope];
    assert.deepEqual(Object.keys(b), ['n', 'graded', 'hit', 'push', 'staked', 'net_fair', 'net_vig2', 'assumed_price_legs', 'note']);
    const pending = wk.parlays.filter((p) => p.scope === scope && p.bucket === 'pending').length;
    assert.equal(b.graded, b.n - pending, `${scope}: graded = n - pending`);
    assert.equal(b.staked, 100 * b.graded, `${scope}: staked == 100 * graded`);
    assert.equal(b.hit, wk.parlays.filter((p) => p.scope === scope && p.bucket === 'all_hit').length);
    assert.equal(b.push, wk.parlays.filter((p) => p.scope === scope && p.bucket === 'push').length);
    if (b.graded === 0) {
      assert.equal(b.net_fair, null);
      assert.equal(b.net_vig2, null);
    } else {
      assert.equal(typeof b.net_fair, 'number');
      assert.equal(typeof b.net_vig2, 'number');
      assert.ok(b.net_vig2 <= b.net_fair + 1e-9, `${scope}: the vig never helps`);
      assert.ok(b.net_fair >= -b.staked, `${scope}: cannot lose more than the stake`);
    }
    assert.ok(Number.isInteger(b.assumed_price_legs) && b.assumed_price_legs >= 0);
    assert.match(b.note, new RegExp(`\\$100 flat on each of the ${b.n} ${scope}-scope parlays`));
    assert.match(b.note, /Display-only money, never a model input/);
  }
});

/* ----------------------------------------------------------- 4. gates */

test('build_parlay_archive / build_review / validate_data selftests and the validator exit 0', () => {
  for (const args of [['scripts/build_parlay_archive.py', '--selftest'], ['scripts/build_review.py', '--selftest'],
    ['scripts/validate_data.py', '--selftest']]) {
    const r = spawnSync('python3', args, { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}\n${r.stdout.slice(-800)}`);
  }
  const r = spawnSync('python3', ['scripts/validate_data.py'], { cwd: REPO_ROOT, env: PY_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok\s+parlays\/index\.json/, 'index registered');
  assert.match(r.stdout, /ok\s+parlays\/\d{4}_wk\d{2}\.json\s+vs parlays_archive\.schema\.json/, 'archive walked');
});

test('validate_data.py registers the archive directory and the index as optional', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'validate_data.py'), 'utf8');
  assert.ok(src.includes('"parlays_index.schema.json": "parlays/index.json"'));
  assert.ok(src.includes('PARLAY_ARCHIVE_SCHEMA = "parlays_archive.schema.json"'));
  assert.match(src, /OPTIONAL_DATA = frozenset\(\[[\s\S]*"parlays\/index\.json",[\s\S]*\]\)/);
});
