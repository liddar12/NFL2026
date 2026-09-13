/* tests/feature/r58_parlay_ledger.test.mjs — R58 parlay-leg ledger, resolver and
 * the weekly refit under never-regress, locked.
 *
 *   1. scripts/build_parlay_ledger.py: a leg's as-made fields lock on first sight
 *      and never change; a second append on the same as-of changes nothing; a leg
 *      first seen after its kickoff is recorded `locked: false`.
 *   2. The committed data/estimates/parlays_2026.json: every leg locked before its
 *      kickoff, every prop leg identified (player, team, p_team), keys unique.
 *   3. scripts/resolve_parlay_legs.py --dry-run-with the r58 fixture: hit / miss /
 *      unresolved with reasons, seed and model scored on IDENTICAL legs, the
 *      nflverse LA -> LAR join; --offline writes the honest 0-resolved record.
 *   4. scripts/backtest_parlay.py: refit_decision blocks a regression on EITHER
 *      side; adversarial legs are never adopted; the zero block is exact.
 *   5. data/parlay_backtest.json carries the live_2026 contract keys.
 *   6. validate_data.py registers both feeds (OPTIONAL) and its selftest, the three
 *      --selftest runs and --gate all exit 0.
 *
 * Node built-ins only; Python cores driven through `python3 -` (the
 * r51_parlay.test.mjs pattern), CLIs through spawnSync.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LEDGER = resolve(REPO_ROOT, 'data/estimates/parlays_2026.json');
const SCORES = resolve(REPO_ROOT, 'data/parlay_leg_scores.json');
const BACKTEST = resolve(REPO_ROOT, 'data/parlay_backtest.json');
const FIXTURE = 'tests/fixtures/r58/stats_player_week_2026_wk1.csv';
const PY_ENV = { ...process.env, PYTHONPATH: REPO_ROOT };

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8', env: PY_ENV,
  });
  return JSON.parse(out);
}

function py(args) {
  return spawnSync('python3', args, { cwd: REPO_ROOT, encoding: 'utf8', env: PY_ENV });
}

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/* ------------------------------------------------------------------------- */
/* 1. Ledger: idempotent lock, post-kickoff exclusion.                        */
/* ------------------------------------------------------------------------- */
test('ledger: first sight locks the as-made fields; same as-of is a no-op; post-kickoff legs stay unlocked', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts import build_parlay_ledger as bl
p1, g, pr = bl._fixture("2026-09-08T10:39:10Z")
d1 = bl.append(None, p1, g, pr, "2026-09-08T10:40:00Z")
d1b = bl.append(d1, p1, g, pr, "2026-09-08T12:00:00Z")
d1b["generated_utc"] = d1["generated_utc"]
p2, _, _ = bl._fixture("2026-09-09T10:00:00Z", mu=70.0, prob=0.55)
d2 = bl.append(d1, p2, g, pr, "2026-09-09T10:00:01Z")
p3, _, _ = bl._fixture("2026-09-10T06:00:00Z")
p3["parlays"][1]["legs"].append({"market": "wr_rec_yds", "selection": "C. Kupp 60+ rec yds",
    "implied_prob": 0.4, "model_prob": 0.45, "pricing": "calibrated", "line": 59.5,
    "mu": 55.0, "sd": 41.58, "z": -0.1})
d3 = bl.append(d2, p3, g, pr, "2026-09-10T06:00:01Z")
hen = lambda d: next(l for l in d["legs"] if l["selection"].startswith("T. Henderson"))
print(json.dumps({
  "same_asof_identical": json.dumps(d1b, sort_keys=True) == json.dumps(d1, sort_keys=True),
  "runs_after_noop": len(d1b["runs"]),
  "hen1": hen(d1), "hen2": hen(d2), "hen3": hen(d3),
  "kupp": next(l for l in d3["legs"] if l["selection"].startswith("C. Kupp")),
  "n1": len(d1["legs"]), "n2": len(d2["legs"]), "n3": len(d3["legs"]),
  "skipped": d1["runs"][0]["skipped"],
}))`);
  assert.equal(r.same_asof_identical, true, 'a second append on the same as-of changes nothing');
  assert.equal(r.runs_after_noop, 1);
  assert.equal(r.hen1.locked, true);
  assert.equal(r.hen1.locked_utc, '2026-09-08T10:39:10Z');
  assert.equal(r.hen1.mu, 44.49);
  assert.equal(r.hen1.model_prob, 0.3142);
  assert.equal(r.hen1.p_team, 0.39);
  assert.equal(r.hen1.player, 'TreVeyon Henderson');
  assert.deepEqual(r.hen2, r.hen1, 'a later build with mu 70 / p 0.55 never rewrites the locked leg');
  assert.deepEqual(r.hen3, r.hen1);
  assert.equal(r.n2, r.n1, 'a later build with the same keys and moved numbers adds nothing');
  assert.equal(r.n3, r.n2 + 1);
  assert.equal(r.kupp.locked, false, 'first seen after the 2026-09-10T00:20Z kickoff');
  assert.equal(r.kupp.locked_utc, null);
  assert.equal(r.kupp.seen_utc, '2026-09-10T06:00:00Z');
  assert.equal(r.kupp.model_prob, 0.45, 'recorded for the record, just not locked');
  assert.equal(r.skipped.no_game, 1, 'a week-parlay team not on the slate is skipped and counted');
});

/* ------------------------------------------------------------------------- */
/* 2. The committed ledger.                                                   */
/* ------------------------------------------------------------------------- */
test('committed parlay ledger: every leg locked before kickoff, every prop leg identified, keys unique', () => {
  assert.ok(existsSync(LEDGER), 'data/estimates/parlays_2026.json must be committed');
  const doc = JSON.parse(readFileSync(LEDGER, 'utf8'));
  assert.equal(doc.season, 2026);
  assert.ok(doc.legs.length >= 60, `expected the week-1 slate's legs, got ${doc.legs.length}`);
  const keys = new Set();
  for (const l of doc.legs) {
    const k = [l.season, l.week, l.game_id, l.market, l.selection].join('|');
    assert.ok(!keys.has(k), `duplicate key ${k}`);
    keys.add(k);
    assert.ok(l.model_prob >= 0 && l.model_prob <= 1);
    assert.equal(typeof l.locked, 'boolean');
    if (l.locked) {
      assert.ok(l.locked_utc, 'a locked leg carries locked_utc');
      assert.ok(Date.parse(l.locked_utc) < Date.parse(l.kickoff_utc),
        `${l.selection}: locked ${l.locked_utc} is not before kickoff ${l.kickoff_utc}`);
    } else {
      assert.equal(l.locked_utc, null);
    }
    if (l.position) {
      assert.ok(['QB', 'RB', 'WR'].includes(l.position));
      assert.equal(typeof l.player, 'string', `${l.selection}: player must be identified from the pool`);
      assert.ok([l.home, l.away].includes(l.team));
      assert.equal(typeof l.p_team, 'number');
      assert.equal(typeof l.line, 'number');
      assert.equal(l.pricing, 'calibrated');
      assert.equal(typeof l.z, 'number');
    } else {
      assert.ok(['moneyline', 'spread'].includes(l.market));
      assert.ok([l.home, l.away].includes(l.team));
      if (l.market === 'spread') assert.equal(typeof l.line, 'number');
      else assert.equal(l.line, null);
    }
  }
  const markets = new Set(doc.legs.map((l) => l.market));
  for (const m of ['moneyline', 'spread', 'qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']) {
    assert.ok(markets.has(m), `no ${m} leg on file`);
  }
  assert.equal(doc.runs.length >= 1, true);
  assert.equal(doc.runs[0].legs_seen, doc.runs[0].legs_added);
});

/* ------------------------------------------------------------------------- */
/* 3. Resolver on the fixture: hit / miss / unresolved; identical legs.       */
/* ------------------------------------------------------------------------- */
test('resolver dry run: hit/miss/unresolved with reasons, seed and model on identical legs, LA -> LAR', () => {
  const printed = py(['scripts/resolve_parlay_legs.py', '--dry-run-with', FIXTURE]);
  assert.equal(printed.status, 0, printed.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'r58-'));
  const out = join(dir, 'dry.json');
  const r = py(['scripts/resolve_parlay_legs.py', '--dry-run-with', FIXTURE, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(JSON.parse(printed.stdout), doc, 'stdout in a dry run IS the document');
  assert.equal(doc.weeks_resolved, 1);
  assert.equal(doc.skipped, null);
  assert.match(doc.source, /dry run/);
  assert.equal(doc.legs.resolved, 30);
  assert.equal(doc.legs.unresolved, 10);
  assert.equal(doc.legs.locked, doc.legs.on_file);
  const p = doc.pooled.props;
  assert.equal(p.n, 30);
  assert.equal(p.hit_rate, 0.6667);
  assert.deepEqual(p.by_pricing, { calibrated: 30 });
  assert.equal(typeof p.model.log_loss, 'number');
  assert.equal(typeof p.seed.log_loss, 'number');
  assert.equal(typeof p.model.brier, 'number');
  // identical legs: every resolved prop row carries BOTH probabilities
  const props = doc.resolved.filter((x) => x.position);
  assert.equal(props.length, 30);
  for (const row of props) {
    assert.equal(typeof row.model_prob, 'number');
    assert.equal(typeof row.seed_prob, 'number');
    assert.ok(row.seed_prob >= 0.35 && row.seed_prob <= 0.65, 'seed clamps to [0.35, 0.65]');
    assert.equal(typeof row.hit, 'boolean');
    assert.equal(row.hit, row.actual >= row.line, 'hit = yards >= the locked line');
  }
  // seed log-loss recomputed here from the rows must match the block
  const ll = (k) => -props.reduce((s, x) => s + Math.log(x.hit ? x[k] : 1 - x[k]), 0) / props.length;
  assert.ok(Math.abs(ll('seed_prob') - p.seed.log_loss) < 1e-3);
  assert.ok(Math.abs(ll('model_prob') - p.model.log_loss) < 1e-3);
  // the fixture's LA row (nflverse's Rams abbreviation) joins the LAR leg
  const kw = props.find((x) => x.selection.startsWith('K. Williams'));
  assert.ok(kw, 'K. Williams (LAR) must resolve from a team=LA stats row');
  assert.equal(kw.team, 'LAR');
  assert.equal(kw.hit, true);
  // unresolved legs: the 10 players with no fixture row, never a miss
  assert.equal(doc.unresolved.length, 10);
  for (const u of doc.unresolved) {
    assert.equal(u.reason, 'no_stat_line');
    assert.ok(!doc.resolved.some((x) => x.selection === u.selection));
  }
  // counts conserve across weeks / positions
  assert.equal(doc.weeks.reduce((s, w) => s + w.props.n, 0), p.n);
  assert.equal(Object.values(doc.by_position).reduce((s, b) => s + b.n, 0), p.n);
  // no finals reachable offline: game legs are pending, and the doc says so
  assert.equal(doc.pooled.moneyline.n, 0);
  assert.equal(doc.pooled.spread.n, 0);
  assert.match(doc.finals_source, /none reachable offline/);
  // the dry-run document honours the contract
  const v = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import validate_against_schema
doc = json.load(open(${JSON.stringify(out)}))
validate_against_schema(doc, json.load(open("data/contracts/parlay_leg_scores.schema.json")), "dry")
print(json.dumps({"ok": True}))`);
  assert.equal(v.ok, true);
});

test('resolver --offline writes the honest 0-resolved record; the committed file is one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r58-'));
  const out = join(dir, 'scores.json');
  const r = py(['scripts/resolve_parlay_legs.py', '--offline', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SKIPPED \(0 weeks resolved\): offline run/);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.weeks_resolved, 0);
  assert.equal(doc.pooled.props.n, 0);
  assert.equal(doc.pooled.props.hit_rate, null);
  assert.equal(doc.pooled.props.model.log_loss, null);
  assert.equal(doc.pooled.props.seed.log_loss, null);
  assert.equal(doc.legs.resolved, 0);
  assert.ok(doc.legs.locked > 0, 'the ledger on file has locked legs');
  assert.deepEqual(doc.resolved, []);
  // the committed artifact is the same honest shape (no 2026 week has resolved)
  const committed = JSON.parse(readFileSync(SCORES, 'utf8'));
  assert.equal(committed.season, 2026);
  assert.equal(typeof committed.skipped, 'string');
  assert.equal(committed.weeks_resolved, 0);
  assert.equal(committed.pooled.props.model.log_loss, null);
  assert.equal(typeof committed.finals_source, 'string');
});

/* ------------------------------------------------------------------------- */
/* 4. Refit: never-regress both ways; zero block exact.                       */
/* ------------------------------------------------------------------------- */
test('refit_decision blocks a regression on EITHER the 2025 fold or the 2026 legs; adversarial legs never adopt', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts import backtest_parlay as bp
games, players = bp._synthetic()
params = {"hfa": 45.0, "k": 20.0, "revert": 0.45}
base = bp.run(games, players, params, seasons=(2023, 2024, 2025), folds=bp.FOLDS, live=[])
pre = bp.preweek_ratings(games, params)
corpus = bp.PropCorpus(games, players, pre, params, seasons=(2023, 2024, 2025))
sds, coefs = bp.fit_on(corpus.rows, (2023, 2024, 2025))
def live(flip):
    out = []
    for r in corpus.rows:
        if r["season"] != 2025 or coefs.get(r["pos"]) is None:
            continue
        z = bp._z(r, sds[r["pos"]]); p = bp.calibrated_prob(coefs[r["pos"]], z, r["p_team"])
        y = (1 if p < 0.5 else 0) if flip else r["y"]
        out.append({"week": r["week"], "pos": r["pos"], "z": z, "sd": sds[r["pos"]],
                    "p_team": r["p_team"], "pricing": "calibrated", "model_prob": p,
                    "seed_prob": bp.seed_prob(r["p_team"]), "y": y})
    return out
adv = live(True)
d_adv = bp.run(games, players, params, seasons=(2023, 2024, 2025), folds=bp.FOLDS, live=adv)
few = live(False)[:bp.REFIT_MIN_LEGS - 1]
d_few = bp.run(games, players, params, seasons=(2023, 2024, 2025), folds=bp.FOLDS, live=few)
print(json.dumps({
  "zero": base["live_2026"],
  "min_legs": bp.REFIT_MIN_LEGS,
  "dec": {
    "both_ok": bp.refit_decision(0.60, 0.59, 0.70, 0.69),
    "equal": bp.refit_decision(0.60, 0.60, 0.70, 0.70),
    "fold_worse": bp.refit_decision(0.60, 0.61, 0.70, 0.69),
    "live_worse": bp.refit_decision(0.60, 0.59, 0.70, 0.71),
    "unscorable": bp.refit_decision(0.60, 0.59, None, 0.69),
  },
  "adv": d_adv["live_2026"], "adv_n": len(adv),
  "adv_cal_same": d_adv["props"]["calibration"] == base["props"]["calibration"],
  "few": d_few["live_2026"],
  "few_cal_same": d_few["props"]["calibration"] == base["props"]["calibration"],
}))`);
  assert.deepEqual(r.zero, {
    weeks: 0, legs_resolved: 0, seed: null, calibrated: null, refit: null,
    note: 'no 2026 leg resolved yet',
  });
  assert.equal(r.min_legs, 100);
  assert.equal(r.dec.both_ok[0], true);
  assert.equal(r.dec.equal[0], true, 'not worse is not a regression');
  assert.equal(r.dec.fold_worse[0], false, 'a worse 2025 held-out fold blocks the refit');
  assert.match(r.dec.fold_worse[1], /2025 held-out fold: refit log-loss 0\.6100 > current 0\.6000/);
  assert.equal(r.dec.live_worse[0], false, 'worse on the 2026 legs blocks the refit');
  assert.match(r.dec.live_worse[1], /2026 legs walk-forward by week: refit log-loss 0\.7100 > current 0\.7000/);
  assert.equal(r.dec.unscorable[0], false);
  // adversarial: every outcome against the model -> the refit is never adopted
  assert.ok(r.adv_n >= 100);
  assert.equal(r.adv.legs_resolved, r.adv_n);
  assert.equal(r.adv.refit.applied, false);
  assert.match(r.adv.refit.reason, /never-regress/);
  assert.ok(r.adv.refit.fit_weeks.length === r.adv.weeks);
  assert.equal(r.adv_cal_same, true, 'a rejected refit leaves the shipped coefficients untouched');
  for (const side of ['seed', 'calibrated']) {
    assert.deepEqual(Object.keys(r.adv[side]).sort(), ['hit_rate', 'log_loss']);
  }
  assert.equal(r.adv.seed.hit_rate, r.adv.calibrated.hit_rate, 'identical legs, one hit rate');
  // below the arming threshold: measured, but no refit and nothing else changes
  assert.equal(r.few.legs_resolved, 99);
  assert.equal(r.few.refit, null);
  assert.match(r.few.note, /arms at 100/);
  assert.equal(typeof r.few.seed.log_loss, 'number');
  assert.equal(r.few_cal_same, true);
});

/* ------------------------------------------------------------------------- */
/* 5. The committed backtest artifact carries the live_2026 contract.         */
/* ------------------------------------------------------------------------- */
test('data/parlay_backtest.json: live_2026 contract keys, honest today', () => {
  const doc = JSON.parse(readFileSync(BACKTEST, 'utf8'));
  assert.ok('live_2026' in doc, 'live_2026 block missing');
  const lv = doc.live_2026;
  assert.deepEqual(Object.keys(lv).sort(),
    ['calibrated', 'legs_resolved', 'note', 'refit', 'seed', 'weeks']);
  assert.equal(typeof lv.weeks, 'number');
  assert.equal(typeof lv.legs_resolved, 'number');
  assert.equal(typeof lv.note, 'string');
  for (const side of ['seed', 'calibrated']) {
    if (lv[side] !== null) {
      assert.equal(typeof lv[side].log_loss, 'number');
      assert.equal(typeof lv[side].hit_rate, 'number');
    }
  }
  if (lv.refit !== null) {
    assert.equal(typeof lv.refit.applied, 'boolean');
    assert.ok(Array.isArray(lv.refit.fit_weeks));
    assert.equal(typeof lv.refit.reason, 'string');
  }
  if (lv.legs_resolved === 0) {
    assert.deepEqual(lv, { weeks: 0, legs_resolved: 0, seed: null, calibrated: null,
      refit: null, note: 'no 2026 leg resolved yet' });
  } else {
    assert.ok(lv.legs_resolved >= 100 || lv.refit === null, 'refit arms at 100 legs');
  }
  // schema declares the block as optional with the same keys
  const schema = JSON.parse(read('data/contracts/parlay_backtest.schema.json'));
  assert.ok(!schema.required.includes('live_2026'), 'live_2026 is OPTIONAL');
  assert.deepEqual(schema.properties.live_2026.required.sort(),
    ['calibrated', 'legs_resolved', 'note', 'refit', 'seed', 'weeks']);
});

/* ------------------------------------------------------------------------- */
/* 6. Registration + the exit codes.                                          */
/* ------------------------------------------------------------------------- */
test('validate_data registers both feeds as OPTIONAL and routes the parlay ledger to its own schema', () => {
  const vd = read('scripts/validate_data.py');
  assert.match(vd, /"parlay_leg_scores\.schema\.json":\s*"parlay_leg_scores\.json"/);
  assert.match(vd, /PARLAY_LEDGER_SCHEMA = "parlay_ledger\.schema\.json"/);
  assert.match(vd, /PARLAY_LEDGER_PREFIX = "parlays_"/);
  const optional = vd.slice(vd.indexOf('OPTIONAL_DATA = frozenset(['), vd.indexOf('])', vd.indexOf('OPTIONAL_DATA = frozenset([')));
  assert.ok(optional.includes('"parlay_leg_scores.json"'), 'parlay_leg_scores.json must be OPTIONAL');
  for (const c of ['parlay_ledger', 'parlay_leg_scores']) {
    assert.ok(existsSync(join(REPO_ROOT, `data/contracts/${c}.schema.json`)));
  }
  assert.ok(existsSync(join(REPO_ROOT, FIXTURE)));
});

for (const args of [
  ['scripts/build_parlay_ledger.py', '--selftest'],
  ['scripts/resolve_parlay_legs.py', '--selftest'],
  ['scripts/backtest_parlay.py', '--selftest'],
  ['scripts/backtest_parlay.py', '--gate'],
  ['scripts/validate_data.py', '--selftest'],
  ['scripts/validate_data.py'],
]) {
  test(`python3 ${args.join(' ')} exits 0`, () => {
    const r = py(args);
    assert.equal(r.status, 0, `${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  });
}
