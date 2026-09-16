/* tests/feature/r55_kdst_weekly_split.test.mjs — R55 D/ST weekly split, locked.
 *
 * Before R55 every K/DEF week was the season projection divided by games: the
 * same number in week 1 and week 17, home or away, against the league's best
 * offence or its worst. app/grade-weekly.js said so in its own honesty rules.
 * R55 reshapes the D/ST week by what the opponent surrenders — and deliberately
 * does NOT reshape the kicker, because no kicker signal was measurable.
 *
 * What this file is here to prevent:
 *   1. the split INVENTING season points rather than moving them (the factors
 *      of a team must average 1.0 — that IS the conservation statement);
 *   2. a kicker quietly acquiring a split nobody measured;
 *   3. the app's SEASON AVG label disagreeing with the number beside it;
 *   4. a broken or absent `weekly` list degrading to a silent 1.0 that looks
 *      like a real split instead of falling back to the flat average;
 *   5. the gate passing on a corpus too short to answer, or on a tie;
 *   6. a later week leaking into an earlier walk-forward fold.
 *
 * Node built-ins only; the Python cores are driven through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { shapeKdst, hasWeeklySplit, weeklyPointsFor } from '../../app/kdst.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const KDST = readJson('data/kdst_projections.json');

function py(args) {
  const r = spawnSync('python3', args, { cwd: ROOT, encoding: 'utf8' });
  return r;
}

/* 1 — the shipped contract ---------------------------------------------------- */

test('every defense carries a split whose factors average 1.0', () => {
  const defs = KDST.defenses || [];
  assert.ok(defs.length >= 28, `expected a full league of defenses, saw ${defs.length}`);
  let split = 0;
  for (const d of defs) {
    if (d.weekly === null) continue;   // a team the schedule could not place
    split += 1;
    assert.ok(Array.isArray(d.weekly) && d.weekly.length > 0, d.team);
    const weeks = d.weekly.map((w) => w.week);
    assert.equal(new Set(weeks).size, weeks.length, `${d.team} repeats a week`);
    assert.deepEqual(weeks, [...weeks].sort((a, b) => a - b), `${d.team} weeks unsorted`);
    for (const w of d.weekly) {
      assert.ok(Number.isInteger(w.week) && w.week >= 1 && w.week <= 18);
      assert.ok(typeof w.home === 'boolean');
      assert.notEqual(w.opp, d.team, 'a team never plays itself');
      assert.ok(w.factor > 0, `${d.team} wk${w.week} factor ${w.factor}`);
    }
    // THE CONSERVATION INVARIANT: a shape, never a level.
    const mean = d.weekly.reduce((t, w) => t + w.factor, 0) / d.weekly.length;
    assert.ok(Math.abs(mean - 1) < 0.001,
      `${d.team} factors average ${mean} — the split moved the season total`);
  }
  assert.ok(split >= 28, `expected the league split, saw ${split}`);
  assert.equal(KDST.weekly_split.teams_split, split);
});

test('no kicker carries a split, and the contract says why', () => {
  for (const k of KDST.kickers || []) {
    assert.equal(k.weekly, null, `${k.name} acquired a split nobody measured`);
  }
  const reason = KDST.weekly_split.kicker_reason;
  assert.match(reason, /measured, not adopted/);
  assert.match(reason, /not significant/);
});

test('the split is clamped, so one blowout cannot own a week', () => {
  const [lo, hi] = KDST.weekly_split.clamp;
  const home = KDST.weekly_split.home_coef;
  // the widest a factor can be BEFORE normalising is clamp x home tilt; after
  // normalising it can only shrink toward 1, never widen.
  // max/min is invariant under the normalisation, so it is the clamp's own
  // ratio — plus a hair for the 4-decimal rounding the contract stores.
  const ceiling = (hi * (1 + home)) / (lo * (1 - home));
  const ROUNDING = 1e-3;
  for (const d of KDST.defenses || []) {
    if (!Array.isArray(d.weekly) || !d.weekly.length) continue;
    const fs = d.weekly.map((w) => w.factor);
    const spread = Math.max(...fs) / Math.min(...fs);
    assert.ok(spread <= ceiling * (1 + ROUNDING),
      `${d.team} spread ${spread.toFixed(4)} exceeds the clamp ceiling ${ceiling.toFixed(4)}`);
  }
});

/* 2 — the client reads it, and the label matches the number -------------------- */

test('weeklyPointsFor scales the flat average; a kicker keeps it', () => {
  const idx = shapeKdst(KDST, null);
  assert.ok(idx.ok, 'the shipped contract shapes');
  const def = idx.byPosition.DEF.find((e) => e.weekly instanceof Map && e.weekly.size > 0);
  assert.ok(def, 'at least one shaped defense carries factors');
  const row = (KDST.defenses || []).find((d) => d.player_id === def.id);
  const first = row.weekly[0];
  assert.ok(hasWeeklySplit(def, first.week));
  assert.equal(weeklyPointsFor(def, first.week),
    Math.round(def.weeklyPoints * first.factor * 100) / 100);
  // a week the team does not play (bye) falls back to the flat average
  const played = new Set(row.weekly.map((w) => w.week));
  const bye = [...Array(18).keys()].map((i) => i + 1).find((w) => !played.has(w));
  if (bye) {
    assert.equal(hasWeeklySplit(def, bye), false);
    assert.equal(weeklyPointsFor(def, bye), def.weeklyPoints);
  }
  const k = idx.byPosition.K[0];
  assert.equal(k.weekly.size, 0, 'a kicker carries no factors');
  assert.equal(hasWeeklySplit(k, 3), false);
  assert.equal(weeklyPointsFor(k, 3), k.weeklyPoints);
});

test('a malformed weekly list falls back to the flat average, never a silent 1.0', () => {
  const broken = JSON.parse(JSON.stringify(KDST));
  broken.defenses[0].weekly = [
    { week: 0, opp: 'XX', home: true, factor: 1.5 },      // week out of range
    { week: 3, opp: 'XX', home: true, factor: 0 },        // a zero is not a factor
    { week: 4, opp: 'XX', home: true, factor: 'nope' },   // not a number
  ];
  const e = shapeKdst(broken, null).byId.get(broken.defenses[0].player_id);
  assert.equal(e.weekly.size, 0, 'nothing malformed becomes a factor');
  assert.equal(hasWeeklySplit(e, 3), false, 'and the label says season average');
  assert.equal(weeklyPointsFor(e, 3), e.weeklyPoints);
  // an absent key is the same story
  const none = JSON.parse(JSON.stringify(KDST));
  delete none.defenses[0].weekly;
  const e2 = shapeKdst(none, null).byId.get(none.defenses[0].player_id);
  assert.equal(e2.weekly.size, 0);
  assert.equal(weeklyPointsFor(e2, 3), e2.weeklyPoints);
});

test('the split is league-agnostic: a different scoring profile rescales, never reshapes', () => {
  const plain = shapeKdst(KDST, null);
  const rich = shapeKdst(KDST, { scoring: { sack: 4, int: 8, def_td: 12, pts_allow_0: 20 } });
  const a = plain.byPosition.DEF.find((e) => e.weekly.size > 0);
  const b = rich.byId.get(a.id);
  assert.ok(b && b.weekly.size === a.weekly.size);
  // the FACTORS are identical under both profiles — that is the whole reason
  // the contract ships a multiplier instead of a points total.
  for (const [wk, f] of a.weekly) assert.equal(b.weekly.get(wk), f);
  // and each profile's weekly number is exactly ITS OWN flat average times the
  // shared factor — the rescale is total, the reshape is nil.
  for (const [wk, f] of a.weekly) {
    assert.equal(weeklyPointsFor(a, wk), Math.round(a.weeklyPoints * f * 100) / 100);
    assert.equal(weeklyPointsFor(b, wk), Math.round(b.weeklyPoints * f * 100) / 100);
  }
});

/* 3 — the Python cores and the gate -------------------------------------------- */

test('build_kdst, build_kdst_history and backtest_kdst selftests exit 0', () => {
  for (const script of ['build_kdst.py', 'build_kdst_history.py', 'backtest_kdst.py']) {
    const r = py([join('scripts', script), '--selftest']);
    assert.equal(r.status, 0, `${script} --selftest: ${r.stderr || r.stdout}`);
  }
});

test('the R55 gate passes on the committed corpus and reports a paired interval', () => {
  if (!existsSync(join(ROOT, 'data/kdst_weekly_history.json'))) {
    // OPTIONAL feed: a clone that has never run the runner build has no corpus.
    return;
  }
  const r = py([join('scripts', 'backtest_kdst.py'), '--gate']);
  assert.equal(r.status, 0, `gate refused: ${r.stderr}`);
  assert.match(r.stdout, /PASS/);

  const bt = readJson('data/kdst_backtest.json');
  assert.equal(bt.kicker.split, false, 'the kicker arm is a measured negative');
  const p = bt.pooled;
  assert.ok(p.beats_flat, p.why);
  assert.ok(p.split_mae < p.flat_mae, `${p.split_mae} vs ${p.flat_mae}`);
  assert.ok(p.ci95[1] < 0, 'the 95% interval excludes zero');
  assert.ok(p.n >= 800, `${p.n} rows is too few to answer`);
  // and it is not one season carrying the other two
  for (const [season, v] of Object.entries(bt.per_season)) {
    assert.ok(v.split_mae < v.flat_mae,
      `${season}: split ${v.split_mae} vs flat ${v.flat_mae}`);
  }
});

test('the corpus is regular-season only and pairs every team-week', () => {
  if (!existsSync(join(ROOT, 'data/kdst_weekly_history.json'))) return;
  const h = readJson('data/kdst_weekly_history.json');
  assert.ok(h.rows.length >= 2000, `${h.rows.length} rows`);
  const seen = new Set();
  for (const r of h.rows) {
    assert.ok(r.week >= 1 && r.week <= 18, `week ${r.week} is not regular season`);
    const key = `${r.season}|${r.week}|${r.team}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
  // every row's opponent has the mirror row, with exactly one side at home
  const byKey = new Map(h.rows.map((r) => [`${r.season}|${r.week}|${r.team}`, r]));
  for (const r of h.rows) {
    const mate = byKey.get(`${r.season}|${r.week}|${r.opp}`);
    assert.ok(mate, `${r.team} wk${r.week} ${r.season} has no opponent row`);
    assert.equal(mate.opp, r.team);
    assert.notEqual(mate.home, r.home, 'exactly one side is home');
  }
});

test('the gate refuses a short corpus and refuses a tie', () => {
  const src = `
import json, sys
sys.path.insert(0, ${JSON.stringify(ROOT)})
from scripts.backtest_kdst import build, gate, verdict, _synthetic
short = build(_synthetic(signal=1.0)[:50])
tie = verdict([(2023, 1.0, 1.0)] * 500)
noise = build(_synthetic(signal=0.0))
print(json.dumps({
  "short_gate": gate(short),
  "tie_beats": tie["beats_flat"],
  "noise_beats": noise["pooled"]["beats_flat"],
  "signal_beats": build(_synthetic(signal=1.0))["pooled"]["beats_flat"],
}))
`;
  const r = spawnSync('python3', ['-'], { input: src, cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.short_gate, 1, 'a 50-row corpus must not pass');
  assert.equal(out.tie_beats, false, 'a tie is a refusal, not a pass');
  assert.equal(out.noise_beats, false, 'pure noise must not be adopted');
  assert.equal(out.signal_beats, true, 'a planted signal must be found');
});
