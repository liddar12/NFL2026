/* tests/feature/r51_parlay.test.mjs — R51 parlay pricing, locked.
 *
 * scripts/backtest_parlay.py measured the two parlay pricing rules that had
 * never been scored and scripts/models/parlay_builder.py now prices from that
 * measurement (data/parlay_backtest.json). This file locks:
 *
 *   1. SPREAD legs: model_prob === 0.5 exactly at the book number, with an
 *      edge_note; the book's cover price still only reaches implied_prob.
 *   2. PROP legs (calibrated): probability is monotone increasing in mu, moves
 *      with p_team, is clamped to [0.05, 0.95], and carries pricing/mu/sd/z.
 *   3. A prop leg whose league_components key is missing is SKIPPED and
 *      counted on stderr — never seeded, never invented.
 *   4. Correlations come from the file; the module fallback table equals the
 *      measured numbers; opposing-side handling keeps the sign flip.
 *   5. data/parlay_backtest.json: the contract keys, props.verdict.adopted ===
 *      true and spread.verdict === "no_edge" on the committed fixtures.
 *   6. `python3 scripts/backtest_parlay.py --gate` exits 0 (and --selftest).
 *
 * Node built-ins only; the Python cores are driven through `python3 -` (the
 * parlay_props.test.mjs pattern); the gate through spawnSync (the
 * backtest_player.test.mjs pattern).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = resolve(REPO_ROOT, 'data/parlay_backtest.json');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    input: code,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

const PRELUDE = `
import io, json, sys, contextlib
sys.path.insert(0, ".")
from scripts.models import parlay_builder as pb
`;

/* ------------------------------------------------------------------------- */
/* 1. Spread legs are flat 0.5 with an edge_note.                             */
/* ------------------------------------------------------------------------- */
test('spread leg: model_prob is exactly 0.5 at the book number, edge_note present', () => {
  const r = runPy(`${PRELUDE}
game = {"game_id": "g1", "home": "KC", "away": "DEN", "probs": {"home": 0.406, "away": 0.594}}
market = {"moneyline": {"home_prob": 0.55, "away_prob": 0.45},
          "spread": {"home_cover_prob": 0.4892, "away_cover_prob": 0.5108, "home_point": -3.0,
                     "home_selection": "KC -3", "away_selection": "DEN +3"}}
home_fav = {"game_id": "g2", "home": "SEA", "away": "NE", "probs": {"home": 0.91, "away": 0.09}}
home_market = {"spread": {"home_cover_prob": 0.5, "away_cover_prob": 0.5, "home_point": -10.5,
                          "home_selection": "SEA -10.5", "away_selection": "NE +10.5"}}
legs = pb.derive_candidate_legs(game, market=market)
legs2 = pb.derive_candidate_legs(home_fav, market=home_market)
legs_nofile = pb.derive_candidate_legs(game, market=market, calibration_path="/nonexistent/x.json")
parlays = pb.build_game_parlays(game, market=market)
print(json.dumps({"away": legs, "home": legs2, "nofile": legs_nofile, "parlays": parlays,
                  "has_cover_fn": hasattr(pb, "model_cover_prob") or hasattr(pb, "model_home_margin")}))`);
  for (const [k, legs] of Object.entries({ away: r.away, home: r.home, nofile: r.nofile })) {
    const leg = legs.find((l) => l.market === 'spread');
    assert.ok(leg, `${k}: a priced handicap still yields a spread leg`);
    assert.equal(leg.model_prob, 0.5, `${k}: spread model_prob must be exactly 0.5`);
    assert.match(leg.edge_note, /^NO EDGE — cover model measured below coin-flip/);
    assert.match(leg.edge_note, /never-regress/);
  }
  // Side + label still follow OUR favourite; the book number reaches IMPL only.
  const away = r.away.find((l) => l.market === 'spread');
  assert.equal(away.selection, 'DEN +3');
  assert.equal(away._side, 'away');
  assert.equal(away.implied_prob, 0.5108);
  const home = r.home.find((l) => l.market === 'spread');
  assert.equal(home.selection, 'SEA -10.5');
  // A big favourite at a big number is STILL 0.5 — the handicap no longer moves it.
  assert.equal(home.model_prob, 0.5);
  // The retired pricing path is gone, not lurking.
  assert.equal(r.has_cover_fn, false, 'model_cover_prob / model_home_margin must be retired');
  // The output leg carries the note through _strip_leg (schema-declared field).
  const shipped = r.parlays.flatMap((p) => p.legs).find((l) => l.market === 'spread');
  assert.ok(shipped, 'a spread leg must reach a parlay');
  assert.equal(shipped.model_prob, 0.5);
  assert.match(shipped.edge_note, /NO EDGE/);
  for (const leg of r.parlays.flatMap((p) => p.legs)) {
    assert.ok(!Object.keys(leg).some((k) => k.startsWith('_')), 'no internal keys ship');
  }
});

/* ------------------------------------------------------------------------- */
/* 2. Calibrated prop pricing: monotone in mu, moves with p_team, clamped.    */
/* ------------------------------------------------------------------------- */
const PROPS_PY = `${PRELUDE}
def weekly_rec(gsis, comps, pts_by_wk):
    weeks = [{"wk": w, "opp": "X", "home": True, "bye": False, "pts": p} for w, p in pts_by_wk]
    return {"gsis_id": gsis, "league_components": comps, "weeks": weeks}

def player(gsis, name, team, pos, pts):
    return {"gsis_id": gsis, "name": name, "team": team, "position": pos, "proj_points": pts}

projections = {"players": [
    player("q1", "Home Quarterback", "KC", "QB", 300.0),
    player("q2", "Away Quarterback", "BUF", "QB", 250.0),
    player("r1", "Home Back", "KC", "RB", 200.0),
    player("w1", "Away Wideout", "BUF", "WR", 240.0),
]}
def weekly(qb_yards, wr_comps=None):
    return {"players": [
        weekly_rec("q1", {"pass_yd": qb_yards}, [(1, 20.0), (2, 20.0), (3, 20.0), (4, 20.0)]),
        weekly_rec("q2", {"pass_yd": 3000.0}, [(1, 20.0), (2, 20.0)]),
        weekly_rec("r1", {"rush_yd": 1000.0}, [(1, 15.0), (2, 15.0)]),
        weekly_rec("w1", wr_comps if wr_comps is not None else {"rec_yd": 1200.0},
                   [(1, 18.0), (2, 18.0)]),
    ]}
def game(p_home, week=1):
    return {"game_id": "g1", "home": "KC", "away": "BUF", "week": week,
            "probs": {"home": p_home, "away": 1.0 - p_home}}

def probs(p_home, qb_yards):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        out = pb.build_props_by_game([game(p_home)], weekly(qb_yards), projections)
    return out["g1"], err.getvalue()

# mu sweep: season pass yards 600..1400 over 4 equal weeks (share 0.25) -> mu 150..350,
# i.e. z from about -1 to +1.6 — inside the clamps, so monotonicity is visible.
sweep = [probs(0.5, y)[0][0] for y in (600.0, 800.0, 1000.0, 1200.0, 1400.0)]
# season 1000 -> mu 250 (z ~ +0.33), well inside the clamps so p_team's effect shows
lo_team, _ = probs(0.2, 1000.0)
hi_team, _ = probs(0.8, 1000.0)
huge, _ = probs(0.99, 40000.0)
tiny, _ = probs(0.01, 100.0)
cal = pb.load_calibration()["props"]

# missing component key on the WR: calibration present -> skipped + counted, never seeded
err = io.StringIO()
with contextlib.redirect_stderr(err):
    missing = pb.build_props_by_game([game(0.6)], weekly(3600.0, wr_comps={"rec_tgt": 100.0}),
                                     projections)["g1"]
missing_err = err.getvalue()

# no week row for this game (week 9 requested, record has weeks 1-4) -> skipped + counted
err = io.StringIO()
with contextlib.redirect_stderr(err):
    noweek = pb.build_props_by_game([game(0.6, week=9)], weekly(3600.0), projections)["g1"]
noweek_err = err.getvalue()

# seed fallback: calibration file absent -> old seed math, stamped
err = io.StringIO()
with contextlib.redirect_stderr(err):
    seed = pb.build_props_by_game([game(0.95)], weekly(3600.0), projections,
                                  calibration_path="/nonexistent/parlay_backtest.json")["g1"]

print(json.dumps({"sweep": sweep, "lo_team": lo_team, "hi_team": hi_team, "huge": huge,
                  "tiny": tiny, "cal": cal, "missing": missing, "missing_err": missing_err,
                  "noweek": noweek, "noweek_err": noweek_err, "seed": seed}))
`;

test('calibrated prop probability is monotone in mu and rises with p_team', () => {
  const r = runPy(PROPS_PY);
  const qb = r.sweep;
  assert.equal(qb.length, 5);
  for (const leg of qb) {
    assert.equal(leg.market, 'qb_pass_yds');
    assert.equal(leg.pricing, 'calibrated');
    assert.equal(leg.estimate, true);
    assert.ok(!('estimate_note' in leg), 'a calibrated leg carries no seed note');
    assert.equal(typeof leg.mu, 'number');
    assert.equal(typeof leg.sd, 'number');
    assert.equal(typeof leg.z, 'number');
    assert.equal(leg.line, 224.5);
  }
  // mu = season yards x this week's share (20 of 80 pts = 0.25).
  assert.equal(qb[1].mu, 200);
  // The leg carries sd rounded to 2 dp; the file holds 4.
  assert.ok(Math.abs(qb[0].sd - r.cal.residual_sd.QB) < 0.01, `${qb[0].sd} vs ${r.cal.residual_sd.QB}`);
  assert.ok(Math.abs(qb[1].z - (200 - 224.5) / r.cal.residual_sd.QB) < 1e-3);
  for (let i = 1; i < qb.length; i++) {
    assert.ok(qb[i].mu > qb[i - 1].mu);
    assert.ok(qb[i].model_prob > qb[i - 1].model_prob,
      `p must rise with mu: ${qb[i - 1].model_prob} -> ${qb[i].model_prob}`);
  }
  // Same mu, higher team win probability -> higher p (c > 0 for every position).
  const lo = r.lo_team.find((l) => l.market === 'qb_pass_yds');
  const hi = r.hi_team.find((l) => l.market === 'qb_pass_yds');
  assert.equal(lo.mu, hi.mu);
  assert.ok(hi.model_prob > lo.model_prob, 'p must move with p_team');
  // Exact formula, recomputed here from the file's coefficients.
  const c = r.cal.calibration.QB;
  const expected = 1 / (1 + Math.exp(-(c.a + c.b * hi.z + c.c * (0.8 - 0.5))));
  assert.ok(Math.abs(hi.model_prob - expected) < 2e-3, `${hi.model_prob} vs ${expected}`);
  // Clamped to [0.05, 0.95] at the extremes.
  assert.equal(r.huge.find((l) => l.market === 'qb_pass_yds').model_prob, 0.95);
  assert.equal(r.tiny.find((l) => l.market === 'qb_pass_yds').model_prob, 0.05);
  // Every position has coefficients with the expected signs.
  for (const pos of ['QB', 'RB', 'WR']) {
    assert.ok(r.cal.calibration[pos].b > 0, `${pos}: b (z slope) must be positive`);
    assert.ok(r.cal.calibration[pos].c > 0, `${pos}: c (team slope) must be positive`);
    assert.ok(r.cal.residual_sd[pos] > 0);
  }
});

test('a prop leg with no component key (or no week row) is skipped and counted, never seeded', () => {
  const r = runPy(PROPS_PY);
  assert.deepEqual(r.missing.map((l) => l.market), ['qb_pass_yds', 'rb_rush_yds'],
    'the WR with no rec_yd component must produce NO leg');
  assert.match(r.missing_err, /1 prop leg\(s\) skipped — no_component/);
  assert.ok(r.missing.every((l) => l.pricing === 'calibrated'));
  assert.equal(r.noweek.length, 0, 'no weekly row for the game week -> no prop legs');
  assert.match(r.noweek_err, /3 prop leg\(s\) skipped — no_week_row/);
});

test('seed fallback when the calibration file is absent: old math, clamps, stamped', () => {
  const r = runPy(PROPS_PY);
  const [qb, rb, wr] = r.seed;
  // p_home = 0.95: home shade 0.5 + 0.4*0.45 = 0.68 -> 0.65; away 0.32 -> 0.35.
  assert.equal(qb.model_prob, 0.65);
  assert.equal(rb.model_prob, 0.65);
  assert.equal(wr.model_prob, 0.35);
  for (const leg of r.seed) {
    assert.equal(leg.pricing, 'seed');
    assert.equal(leg.estimate_note, 'seed pricing — calibration file absent');
    assert.equal(leg.estimate, true);
  }
});

/* ------------------------------------------------------------------------- */
/* 4. Correlations from the file; fallback table = measured numbers.          */
/* ------------------------------------------------------------------------- */
test('correlation values come from the file; the fallback table equals the measured numbers', () => {
  const r = runPy(`${PRELUDE}
doc = pb.load_calibration()
same, opp, default = pb._correlation_table(doc)
fsame, fopp, fdefault = pb._correlation_table(None)
leg = lambda tag, side: {"_corr_tag": tag, "_side": side}
file_corr = (same, opp, default)
print(json.dumps({
  "file_pairs": {p["key"]: p["rho"] for p in doc["correlations"]["pairs"]},
  "file_default": default,
  "fallback": {"|".join(sorted(k)): v for k, v in fsame.items()},
  "fallback_opp": {"|".join(sorted(k)): v for k, v in fopp.items()},
  "fallback_default": fdefault,
  "ml_spread_same": pb._pair_rho(leg("moneyline", "home"), leg("spread", "home"), file_corr),
  "ml_spread_opp": pb._pair_rho(leg("moneyline", "home"), leg("spread", "away"), file_corr),
  "qb_wr_same": pb._pair_rho(leg("qb_pass_yds", "home"), leg("wr_rec_yds", "home"), file_corr),
  "qb_wr_opp": pb._pair_rho(leg("qb_pass_yds", "home"), leg("wr_rec_yds", "away"), file_corr),
  "rb_ml_opp": pb._pair_rho(leg("rb_rush_yds", "away"), leg("moneyline", "home"), file_corr),
  "unknown_same": pb._pair_rho(leg("moneyline", "home"), leg("wr_rec_yds", "home"), file_corr),
  "fb_ml_spread": pb._pair_rho(leg("moneyline", "home"), leg("spread", "home")),
  "fb_qb_wr_opp": pb._pair_rho(leg("qb_pass_yds", "home"), leg("wr_rec_yds", "away")),
}))`);
  // The file's measured numbers drive the builder.
  assert.equal(r.ml_spread_same, r.file_pairs['moneyline|spread']);
  assert.equal(r.qb_wr_same, r.file_pairs['qb_pass_yds|wr_rec_yds']);
  assert.equal(r.qb_wr_opp, r.file_pairs['qb_pass_yds|wr_rec_yds|opposing'],
    'an explicit opposing measurement is used as measured');
  assert.equal(r.ml_spread_opp, -Math.abs(r.file_pairs['moneyline|spread']),
    'opposing sides without an explicit measurement flip sign');
  assert.equal(r.rb_ml_opp, -Math.abs(r.file_pairs['rb_rush_yds|moneyline']));
  assert.equal(r.unknown_same, r.file_default);
  // Measured magnitudes (the numbers in docs/PARLAY_MODEL_V2.md), to 2 dp.
  assert.ok(Math.abs(r.file_pairs['moneyline|spread'] - 0.71) < 0.01);
  assert.ok(Math.abs(r.file_pairs['qb_pass_yds|wr_rec_yds'] - 0.32) < 0.01);
  assert.ok(Math.abs(r.file_pairs['qb_pass_yds|rb_rush_yds'] - 0.0) < 0.03);
  assert.ok(Math.abs(r.file_pairs['qb_pass_yds|wr_rec_yds|opposing'] - 0.10) < 0.01);
  assert.ok(Math.abs(r.file_pairs['rb_rush_yds|moneyline'] - 0.28) < 0.01);
  // The fallback table IS the measured table, not the pre-R51 priors.
  assert.deepEqual(r.fallback, {
    'moneyline|spread': 0.71,
    'qb_pass_yds|wr_rec_yds': 0.32,
    'qb_pass_yds|rb_rush_yds': 0.0,
    'moneyline|rb_rush_yds': 0.28,
  });
  assert.deepEqual(r.fallback_opp, { 'qb_pass_yds|wr_rec_yds': 0.10 });
  assert.equal(r.fallback_default, 0.10);
  assert.equal(r.fb_ml_spread, 0.71);
  assert.equal(r.fb_qb_wr_opp, 0.10);
});

/* ------------------------------------------------------------------------- */
/* 5. The committed artifact: contract + verdicts.                            */
/* ------------------------------------------------------------------------- */
test('data/parlay_backtest.json honours the contract; verdicts adopted / no_edge', () => {
  const doc = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  for (const k of ['generated_utc', 'fixture', 'moneyline', 'spread', 'props', 'correlations', 'policy']) {
    assert.ok(k in doc, `missing top-level key ${k}`);
  }
  assert.deepEqual(doc.fixture, {
    games_meta: 'data/fixtures/backtest_weekly/games_meta.json',
    weekly_actuals: 'data/fixtures/backtest_weekly/weekly_actuals.json',
    seasons: [2023, 2024, 2025],
  });
  const ml = doc.moneyline;
  for (const k of ['n', 'incumbent_log_loss', 'incumbent_brier', 'market_log_loss', 'market_brier', 'per_season', 'note']) {
    assert.ok(k in ml, `moneyline.${k}`);
  }
  assert.match(ml.note, /MEASUREMENT ONLY, never an input/);
  for (const s of ['2023', '2024', '2025']) {
    assert.equal(typeof ml.per_season[s].incumbent_log_loss, 'number');
    assert.equal(typeof ml.per_season[s].market_log_loss, 'number');
  }
  assert.ok(ml.n > 700);
  const sp = doc.spread;
  for (const k of ['n', 'sigma', 'model_cover_log_loss', 'flat_log_loss', 'model_brier', 'pick_hit_rate_by_conviction', 'verdict', 'reason']) {
    assert.ok(k in sp, `spread.${k}`);
  }
  assert.equal(sp.sigma, 13.5);
  assert.equal(sp.verdict, 'no_edge');
  assert.ok(sp.model_cover_log_loss >= sp.flat_log_loss, 'no_edge means the model did not beat flat');
  assert.ok(Math.abs(sp.flat_log_loss - Math.LN2) < 1e-3);
  assert.ok(sp.n > 700);
  for (const b of sp.pick_hit_rate_by_conviction) {
    assert.match(b.bin, /^\d\.\d\d-\d\.\d\d$/);
    assert.equal(typeof b.n, 'number');
    assert.ok(b.hit === null || (b.hit >= 0 && b.hit <= 1));
  }
  const pr = doc.props;
  assert.deepEqual(pr.lines, { QB: 224.5, RB: 59.5, WR: 59.5 });
  assert.equal(pr.dvp_shrink, 0.5);
  for (const pos of ['QB', 'RB', 'WR']) {
    assert.ok(pr.residual_sd[pos] > 0);
    for (const k of ['a', 'b', 'c']) assert.equal(typeof pr.calibration[pos][k], 'number');
    assert.deepEqual(pr.calibration[pos].fit_seasons, [2023, 2024, 2025]);
  }
  assert.equal(pr.folds.length, 2);
  assert.deepEqual(pr.folds.map((f) => [f.season, f.fit_seasons]), [[2024, [2023]], [2025, [2023, 2024]]]);
  for (const f of pr.folds) {
    for (const side of ['seed', 'calibrated']) {
      for (const k of ['log_loss', 'brier', 'hit_rate', 'picks', 'hit_rate_60', 'picks_60']) {
        assert.ok(k in f[side], `fold ${f.season}.${side}.${k}`);
      }
    }
    assert.ok(f.calibrated.log_loss <= f.seed.log_loss,
      `fold ${f.season}: calibrated ${f.calibrated.log_loss} must not regress seed ${f.seed.log_loss}`);
  }
  assert.equal(pr.verdict.adopted, true);
  assert.equal(pr.verdict.rule,
    'never-regress: calibrated log-loss <= seed log-loss on every walk-forward fold');
  const co = doc.correlations;
  assert.deepEqual(co.pairs.map((p) => p.key), [
    'moneyline|spread', 'qb_pass_yds|wr_rec_yds', 'qb_pass_yds|rb_rush_yds',
    'qb_pass_yds|wr_rec_yds|opposing', 'rb_rush_yds|moneyline',
  ]);
  for (const p of co.pairs) {
    assert.equal(typeof p.rho, 'number');
    assert.ok(p.n > 100, `${p.key} n=${p.n}`);
    assert.equal(typeof p.prior, 'number');
  }
  assert.equal(co.default_rho, 0.10);
  assert.equal(typeof co.method, 'string');
  assert.match(doc.policy, /never projection inputs/);
});

/* ------------------------------------------------------------------------- */
/* 6. The gate + selftest exit 0.                                             */
/* ------------------------------------------------------------------------- */
test('python3 scripts/backtest_parlay.py --gate exits 0 on the committed fixtures', () => {
  const r = spawnSync('python3', ['scripts/backtest_parlay.py', '--gate'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  assert.equal(r.status, 0, `gate failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /parlay backtest gate: PASS/);
});

test('python3 scripts/backtest_parlay.py --selftest exits 0', () => {
  const r = spawnSync('python3', ['scripts/backtest_parlay.py', '--selftest'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  assert.equal(r.status, 0, `selftest failed:\n${r.stdout}\n${r.stderr}`);
});
