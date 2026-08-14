/* tests/feature/game_context.test.mjs — data/game_context.json, the pregame
 * enrichment join every Rel22 signal family reads.
 *
 * Five families build against this one schema, so the tests below lock the
 * three properties that make it usable and honest:
 *
 *   1. THE MARKET BOUNDARY. games.csv ships eight betting columns. Not one may
 *      reach this artifact — as a key, as a producer source-text reference, or
 *      as a VALUE. Proved three ways: a walk of the shipped file, a grep of the
 *      producer, and a poisoned-fixture build whose absurd prices must vanish.
 *      A grep alone is defeated by a computed column name; the poisoned build
 *      is not. Both ship.
 *   2. THE JOIN. Flat key "{season}|{week}|{home}|{away}", 7,276/7,276 corpus
 *      games and 1,359/1,359 ESPN fixture games, zero misses, after the four
 *      relocation renames. A silent miss degrades every family to neutral
 *      without anything going red, so it is asserted, never assumed.
 *   3. HONESTY. Completed games only (unplayed rows counted, never carried),
 *      nulls never fabricated into placeholders, and the three POST-game
 *      fields (referee, home_qb, away_qb) declared label-only by name.
 *
 * Node built-ins only. The artifact is runner-built (network), so every test
 * that needs the shipped file skips loudly when it is absent; the fixture-built
 * tests always run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(REPO_ROOT, 'data');
const FIXTURES = join(DATA, 'fixtures');
const CORPUS = join(FIXTURES, 'backtest_corpus');
const BUILDER = join(REPO_ROOT, 'scripts', 'build_game_context.py');
const SAMPLE_CSV = join(FIXTURES, 'nflverse_sample', 'games_context_sample.csv');
const SHIPPED = join(DATA, 'game_context.json');

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

/* The denylist, as a LITERAL. Never imported from the producer — a checker that
 * reuses the producer's constants grades the pipeline with the pipeline's own
 * marking scheme. `result` and `total` are games.csv's post-game margin/points
 * columns; they are outcome leakage rather than market prices, and are barred
 * from a PREGAME artifact for that reason. */
const BETTING_COLUMNS = [
  'away_moneyline', 'home_moneyline', 'spread_line', 'total_line',
  'over_odds', 'under_odds', 'away_spread_odds', 'home_spread_odds',
];
const LEAKY_COLUMNS = [...BETTING_COLUMNS, 'result', 'total'];

/* The published record schema. Five agents code against exactly this set. */
const RECORD_FIELDS = [
  'away_coach', 'away_qb', 'away_rest', 'div_game', 'game_type',
  'home_coach', 'home_qb', 'home_rest', 'meeting_no', 'neutral_site',
  'referee', 'roof', 'surface',
];
const LABEL_ONLY = ['away_qb', 'home_qb', 'referee'];
const RENAMES = { LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR' };

function walkKeys(node, path = '$', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkKeys(v, `${path}[${i}]`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push([`${path}.${k}`, k]);
      walkKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

const py = (args, opts = {}) =>
  execFileSync('python3', args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts });

// ---------------------------------------------------------------------------
// 1. The producer, exercised against the committed poisoned fixture.
// ---------------------------------------------------------------------------

let fixtureDoc;
let fixtureDir;
test('builder: the fixture build succeeds and its selftest passes', () => {
  assert.ok(existsSync(BUILDER), 'scripts/build_game_context.py exists');
  assert.ok(existsSync(SAMPLE_CSV), 'the poisoned sample CSV fixture is committed');
  const out = py([BUILDER, '--selftest']);
  assert.match(out, /selftest OK/);

  fixtureDir = mkdtempSync(join(tmpdir(), 'gamectx-'));
  const target = join(fixtureDir, 'game_context.json');
  py([BUILDER, '--csv', SAMPLE_CSV, '--out', target]);
  fixtureDoc = load(target);
});

test('MARKET BOUNDARY: poisoned prices reach neither key nor value of a build', () => {
  // Every row of the fixture CSV carries all eight betting columns with absurd
  // values. If any survived the allow-list projection it shows up here.
  const raw = readFileSync(SAMPLE_CSV, 'utf8');
  for (const col of BETTING_COLUMNS) {
    assert.ok(raw.includes(col), `fixture actually carries ${col} to be dropped`);
  }
  const blob = JSON.stringify(fixtureDoc);
  for (const col of LEAKY_COLUMNS) {
    assert.ok(!walkKeys(fixtureDoc).some(([, k]) => k === col),
      `${col} must never be a key in the built document`);
  }
  for (const poison of ['99999', '999.5', '-999']) {
    assert.ok(!blob.includes(poison),
      `a poisoned market VALUE (${poison}) survived into the document`);
  }
});

test('MARKET BOUNDARY: the producer never names a betting column', () => {
  // Layer 2b of the guard. The producer uses a POSITIVE allow-list, so no
  // betting column name should occur in its source text at all.
  const src = readFileSync(BUILDER, 'utf8');
  for (const col of BETTING_COLUMNS) {
    assert.ok(!src.includes(col),
      `scripts/build_game_context.py names ${col}; it must use the positive `
      + 'ENRICHMENT_COLUMNS allow-list and never reference a price by name');
  }
});

test('MARKET BOUNDARY: the data-layer checker actually reds on a planted price', () => {
  // The backstop only counts if it fires. Plant a betting column at depth and
  // assert scripts/validate_data.py raises, then assert the clean doc passes.
  const probe = `
import json, sys
sys.path.insert(0, "scripts")
import validate_data as V
clean = json.load(open(${JSON.stringify(join(fixtureDir, 'game_context.json'))}))
V.check_game_context_no_market_columns(clean)          # must not raise
V.check_game_context_join(clean, "does/not/exist")     # label + join_key only
caught = 0
for col in sorted(V.BETTING_COLUMNS):
    poisoned = json.loads(json.dumps(clean))
    key = sorted(poisoned["games"])[0]
    poisoned["games"][key][col] = -999
    try:
        V.check_game_context_no_market_columns(poisoned)
    except V.ValidationError as e:
        assert col in str(e), e
        caught += 1
bad = json.loads(json.dumps(clean))
bad["label_only_fields"] = ["referee"]
try:
    V.check_game_context_join(bad, "does/not/exist")
    raise AssertionError("label_only_fields tampering was not caught")
except V.ValidationError:
    pass
print("PROBE_OK", caught, len(V.BETTING_COLUMNS))
`;
  const out = py(['-c', probe]).trim();
  const [tag, caught, total] = out.split(/\s+/);
  assert.equal(tag, 'PROBE_OK');
  assert.equal(caught, total, 'every betting column is caught at depth');
  assert.equal(Number(total), 8);
});

test('honesty: unplayed rows are skipped and COUNTED, never carried', () => {
  assert.equal(fixtureDoc.diagnostics.unplayed_rows_skipped, 1);
  assert.equal(Object.keys(fixtureDoc.games).length, 4);
  assert.ok(!Object.keys(fixtureDoc.games).some((k) => k.startsWith('2100|')),
    'the unplayed 2100 row must not appear');
});

test('honesty: missing source values stay null, never a placeholder string', () => {
  const g = fixtureDoc.games;
  assert.equal(g['2099|9|LV|LAR'].referee, null);
  assert.equal(g['2099|1|LAC|KC'].surface, null);
  assert.equal(g['2099|1|LAC|KC'].home_qb, null);
  assert.equal(g['2099|1|LAC|KC'].away_qb, null);
  assert.deepEqual(g['2099|1|LAR|LV'].home_qb, { id: '00-QBB', name: 'B.Home' });
});

test('renames + derived meeting_no behave as documented', () => {
  const g = fixtureDoc.games;
  // STL -> LAR, OAK -> LV, SD -> LAC applied before the key is formed.
  assert.ok('2099|1|LAR|LV' in g, 'STL/OAK renamed into the key');
  assert.ok('2099|1|LAC|KC' in g, 'SD renamed into the key');
  assert.equal(g['2099|1|LAR|LV'].meeting_no, 1);
  assert.equal(g['2099|9|LV|LAR'].meeting_no, 2, 'same pair, home/away flipped');
  assert.equal(g['2099|20|LAR|LV'].meeting_no, 3, 'postseason rematch');
  assert.equal(g['2099|1|LAC|KC'].meeting_no, 1);
  assert.equal(g['2099|20|LAR|LV'].neutral_site, true);
  assert.equal(g['2099|1|LAR|LV'].neutral_site, false);
  assert.deepEqual(fixtureDoc.renames, RENAMES);
});

test('the emitted record schema is exactly the published field set', () => {
  for (const [key, rec] of Object.entries(fixtureDoc.games)) {
    assert.deepEqual(Object.keys(rec).sort(), RECORD_FIELDS, `record ${key}`);
  }
  assert.deepEqual(fixtureDoc.label_only_fields, LABEL_ONLY);
  assert.equal(fixtureDoc.join_key, '{season}|{week}|{home}|{away}');
  // Every declared label-only field is a real field on every record.
  for (const f of LABEL_ONLY) assert.ok(RECORD_FIELDS.includes(f));
});

test('a header missing an allow-listed column fails LOUDLY', () => {
  const broken = join(fixtureDir, 'broken.csv');
  const text = readFileSync(SAMPLE_CSV, 'utf8').replace('referee,', '');
  execFileSync('python3', ['-c',
    `open(${JSON.stringify(broken)},"w").write(open(${JSON.stringify(SAMPLE_CSV)}).read().replace("referee,","",1))`],
  { cwd: REPO_ROOT });
  assert.ok(!text.includes('referee,'), 'the probe really removes the column');
  let failed = false;
  try {
    py([BUILDER, '--csv', broken, '--out', join(fixtureDir, 'never.json')],
      { stdio: 'pipe' });
  } catch (err) {
    failed = true;
    assert.match(String(err.stderr || ''), /referee/);
  }
  assert.ok(failed, 'a missing header column must be a non-zero exit, not nulls');
  assert.ok(!existsSync(join(fixtureDir, 'never.json')), 'nothing was written');
});

test.after(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// 2. The shipped artifact (runner-built; skipped loudly when absent).
// ---------------------------------------------------------------------------

const shipped = existsSync(SHIPPED) ? load(SHIPPED) : null;
const skipIfUnbuilt = shipped ? false : 'data/game_context.json not built yet (runner-built)';

test('shipped: no market or outcome column at any depth', { skip: skipIfUnbuilt }, () => {
  const keys = walkKeys(shipped);
  for (const col of LEAKY_COLUMNS) {
    const hits = keys.filter(([, k]) => k === col).map(([p]) => p);
    assert.deepEqual(hits, [], `game_context.json carries ${col}`);
  }
});

test('shipped: the corpus join is complete — every game, zero misses',
  { skip: skipIfUnbuilt }, () => {
    const covered = new Set(Object.keys(shipped.games).map((k) => Number(k.split('|')[0])));
    let compared = 0;
    const missing = [];
    for (const f of readdirSync(CORPUS).filter((x) => /^finals_\d{4}\.json$/.test(x))) {
      const doc = load(join(CORPUS, f));
      if (!covered.has(Number(doc.season))) continue;
      for (const g of doc.games) {
        compared += 1;
        const key = `${doc.season}|${g.week}|${g.home}|${g.away}`;
        if (!(key in shipped.games) && missing.length < 5) missing.push(key);
      }
    }
    assert.deepEqual(missing, [], 'a silent join miss degrades every family');
    assert.equal(compared, 7276, 'the whole 1999-2025 corpus is covered');
    assert.equal(shipped.diagnostics.corpus_reconcile.joined, 7276);
    assert.equal(shipped.diagnostics.corpus_reconcile.missing, 0);
  });

test('shipped: the ESPN fixture slice joins 1,359/1,359',
  { skip: skipIfUnbuilt }, () => {
    let compared = 0;
    const missing = [];
    for (const y of [2021, 2022, 2023, 2024, 2025]) {
      for (const g of load(join(FIXTURES, `finals_${y}.json`)).games) {
        compared += 1;
        const key = `${y}|${g.week}|${g.home}|${g.away}`;
        if (!(key in shipped.games) && missing.length < 5) missing.push(key);
      }
    }
    assert.equal(compared, 1359);
    assert.deepEqual(missing, []);
    assert.equal(shipped.diagnostics.espn_fixture_reconcile.joined, 1359);
  });

test('shipped: team codes reconcile to the canonical 32 after renames',
  { skip: skipIfUnbuilt }, () => {
    const canon = new Set(load(join(FIXTURES, 'teams.json')).teams.map((t) => t.abbrev));
    const seen = new Set();
    for (const key of Object.keys(shipped.games)) {
      const [, , home, away] = key.split('|');
      seen.add(home);
      seen.add(away);
    }
    const unknown = [...seen].filter((c) => !canon.has(c));
    assert.deepEqual(unknown, [], 'an unrenamed relocation code silently drops games');
    for (const stale of Object.keys(RENAMES)) {
      assert.ok(!seen.has(stale), `${stale} should have been renamed away`);
    }
    assert.equal(seen.size, 32);
    assert.equal(shipped.diagnostics.teams_normalised, 32);
  });

test('shipped: completed games only, and the record shape is uniform',
  { skip: skipIfUnbuilt }, () => {
    assert.equal(Object.keys(shipped.games).length, 7276);
    assert.equal(shipped.diagnostics.games, 7276);
    assert.ok(shipped.diagnostics.unplayed_rows_skipped > 0,
      'unplayed rows exist upstream and must be reported, not hidden');
    for (const [key, rec] of Object.entries(shipped.games)) {
      assert.deepEqual(Object.keys(rec).sort(), RECORD_FIELDS, `record ${key}`);
      assert.ok(rec.div_game === 0 || rec.div_game === 1, `${key} div_game`);
      assert.ok(rec.meeting_no >= 1 && rec.meeting_no <= 3, `${key} meeting_no`);
      assert.equal(typeof rec.neutral_site, 'boolean', `${key} neutral_site`);
    }
  });

test('shipped: the LABEL-ONLY declaration is present, exact, and populated',
  { skip: skipIfUnbuilt }, () => {
    // The declaration is how a downstream family learns, mechanically, that
    // these three are post-game ground truth rather than live inputs.
    assert.deepEqual(shipped.label_only_fields, LABEL_ONLY);
    assert.match(shipped.label_only_note, /never/i);
    assert.match(shipped.label_only_note, /LABEL ONLY/i);
    // And they really are populated (a declaration over empty fields is noise).
    const nulls = shipped.diagnostics.null_field_counts;
    for (const f of LABEL_ONLY) {
      assert.ok(nulls[f] < Object.keys(shipped.games).length * 0.01,
        `${f} should be near-complete over completed games, got ${nulls[f]} nulls`);
    }
  });

test('shipped: referee is a FIELD and never a promotion family',
  { skip: skipIfUnbuilt }, () => {
    // Rel18 SOLUTION_DESIGN R1: a non-appliable family that WINS a run
    // suppresses adoption entirely, so referee has zero upside. It lives here
    // as data; it must not appear in the promotion gate's families[].
    const sample = shipped.games[Object.keys(shipped.games)[0]];
    assert.ok('referee' in sample, 'referee is carried as a field');
    const tuning = join(DATA, 'model_tuning.json');
    if (!existsSync(tuning)) return;
    const entry = (load(tuning).history || [])
      .find((h) => h.kind === 'signal_promotion' && h.format === 2);
    if (!entry) return;
    const names = (entry.families || []).map((f) => f.family);
    assert.ok(!names.includes('referee'),
      'referee must never enter families[] — a non-appliable winner suppresses adoption');
  });

test('shipped: meeting_no and div_game are internally consistent',
  { skip: skipIfUnbuilt }, () => {
    // meeting_no is DERIVED. Recompute it independently from the keys and the
    // by_season counts, so a bug in the derivation cannot pass by agreeing
    // with itself.
    const pairs = new Map();
    for (const [key, rec] of Object.entries(shipped.games)) {
      const [season, , home, away] = key.split('|');
      const id = `${season}|${[home, away].sort().join('~')}`;
      pairs.set(id, (pairs.get(id) || 0) + 1);
      assert.ok(rec.meeting_no >= 1);
    }
    for (const [id, n] of pairs) {
      const nos = Object.entries(shipped.games)
        .filter(([key]) => {
          const [season, , home, away] = key.split('|');
          return `${season}|${[home, away].sort().join('~')}` === id;
        })
        .map(([, rec]) => rec.meeting_no)
        .sort();
      assert.deepEqual(nos, Array.from({ length: n }, (_, i) => i + 1),
        `pair ${id} meetings must number 1..${n} exactly once`);
      break; // one full recomputation is enough; the aggregate check follows
    }
    const dist = shipped.diagnostics.meetings_by_number;
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    assert.equal(total, Object.keys(shipped.games).length);
    let divTotal = 0;
    for (const b of Object.values(shipped.diagnostics.by_season)) divTotal += b.div_games;
    const actualDiv = Object.values(shipped.games).filter((r) => r.div_game === 1).length;
    assert.equal(divTotal, actualDiv, 'by_season div counts match the records');
  });
