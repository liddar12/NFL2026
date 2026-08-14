/* tests/feature/kdst.test.mjs — R20-A1: K/DST projections on their OWN contract.
 *
 * Three things are locked here:
 *
 *  1. THE MATH, from the committed selftest fixtures (the nflverse release host
 *     is runner-only; the arithmetic must hold with no network). The fixture
 *     numbers are hand-computable — see the comments on each assertion.
 *  2. THE MIRROR. scripts/build_kdst.py carries a Python copy of app/league.js's
 *     kicking/defense scoring keys and DEFAULT_PROFILE values. This test imports
 *     league.js and diffs them, so the mirror cannot drift silently.
 *  3. THE HONESTY CONTRACT. Unmodelled DEF keys are ABSENT from `stats`, not
 *     zeroed; the PARTIAL SCORING flag matches the list; skipped games are
 *     reported and their numbers really are excluded; and no K/DST row has crept
 *     into player_projections.json (which would evict ~74 offensive players from
 *     its projected[:300] cut).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  SCORING_FIELDS, DEFAULT_PROFILE, applyScoring,
} from '../../app/league.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out);
}

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, rel), 'utf8'));
}

const SELFTEST = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.build_kdst import build
print(json.dumps(build(selftest=True)))
`);

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.player_id, r]));

/* ---------------------------------------------------------------------------
 * 1. Kicker math
 * ------------------------------------------------------------------------- */

test('kicker projection: recency-weighted per-game rate x 17, 50+ buckets merged', () => {
  const k = byId(SELFTEST.kickers).K1;
  assert.ok(k, 'Alpha Kicker is projected');
  assert.equal(k.team, 'KC');
  assert.deepEqual(k.seasons_sample, [2024, 2025]);
  // 2 games in 2024 (weight 2) + 2 in 2025 (weight 3) => denominator 10.
  assert.equal(k.weighted_games, 10);
  assert.equal(k.games_sample, 4);
  // xpm: (3*6 + 2*4)/10 = 2.6 per game -> 44.2
  assert.equal(k.stats.xpm, 44.2);
  // fgm_20_29: (3*0 + 2*2)/10 = 0.4 -> 6.8
  assert.equal(k.stats.fgm_20_29, 6.8);
  // fgm_50p merges nflverse fg_made_50_59 + fg_made_60_: (3*2)/10 = 0.6 -> 10.2
  assert.equal(k.stats.fgm_50p, 10.2);
  // fgmiss counts BLOCKED field goals as misses: (3*(0+1) + 2*(1+0))/10 = 0.5 -> 8.5
  assert.equal(k.stats.fgmiss, 8.5);
  // 44.2*1 + 6.8*3 + 10.2*5 - 8.5*1
  assert.equal(k.proj_points, 107.1);
});

test('kicker eligibility: only the newest season population, REG only, K only', () => {
  const ids = SELFTEST.kickers.map((r) => r.player_id);
  assert.ok(!ids.includes('K2'),
    'a kicker whose last season is older than the newest is NOT projected — '
    + 'inventing a 2026 line for him would be fabrication');
  assert.ok(!ids.includes('Q1'), 'a QB row is not a kicker');
  // The POST row (9 of everything in week 19) must not touch the REG rate.
  assert.equal(byId(SELFTEST.kickers).K1.stats.fgm_30_39, 0);
});

test('kicker team names normalize: nflverse "LA" resolves to LAR', () => {
  assert.equal(byId(SELFTEST.kickers).K3.team, 'LAR');
});

test('low_sample flags a small-sample extrapolation instead of hiding it', () => {
  const k3 = byId(SELFTEST.kickers).K3;   // one game, weighted 3 < 17
  const k1 = byId(SELFTEST.kickers).K1;   // weighted 10 < 17 as well (fixture)
  assert.equal(k3.low_sample, true);
  assert.equal(k1.low_sample, true);
  // And the real file separates them.
  const real = readJson('data/kdst_projections.json');
  assert.ok(real.defenses.every((d) => d.low_sample === false),
    'a full-season defense is never low_sample');
  assert.ok(real.kickers.some((k) => k.low_sample === false),
    'established kickers are not flagged');
});

/* ---------------------------------------------------------------------------
 * 2. Defense math — per-GAME tiers, opponent NET yards
 * ------------------------------------------------------------------------- */

test('defense projection: counting stats, blocked-kick family, per-game tiers', () => {
  const kc = byId(SELFTEST.defenses)['DST-KC'];
  assert.ok(kc);
  assert.equal(kc.name, 'Kansas City Chiefs Defense');
  assert.equal(kc.weighted_games, 5);   // one game per season: 3*1 + 2*1
  // sack (3*5 + 2*3)/5 = 4.2 -> 71.4 ; int (3*3 + 2*1)/5 = 2.2 -> 37.4
  assert.equal(kc.stats.sack, 71.4);
  assert.equal(kc.stats.int, 37.4);
  // blk_kick is punt + PAT + FG blocks summed: (3*1 + 2*1)/5 = 1.0 -> 17.0
  assert.equal(kc.stats.blk_kick, 17.0);
  // def_st_td comes from special_teams_tds: (3*1)/5 = 0.6 -> 10.2
  assert.equal(kc.stats.def_st_td, 10.2);
  // POINTS-ALLOWED TIERS ARE PER GAME — a season total could not produce a
  // shutout count. KC allowed 0 in 2025 and 20 in 2024.
  assert.equal(kc.stats.pts_allow_0, 10.2);       // (3*1)/5 * 17
  assert.equal(kc.stats.pts_allow_14_20, 6.8);    // (2*1)/5 * 17
  assert.equal(kc.stats.pts_allow_21_27, 0);
  // YARDS ALLOWED = opponent NET total (pass + sack_yards_lost + rush; nflverse
  // ships sack_yards_lost negative). 2025: 50-30+40 = 60. 2024: 180-10+80 = 250.
  assert.equal(kc.stats.yds_allow_0_100, 10.2);
  assert.equal(kc.stats.yds_allow_200_299, 6.8);
  assert.equal(kc.proj_points, 561.0);
});

test('defense points allowed reads the OPPONENT side of the game, not its own', () => {
  const buf = byId(SELFTEST.defenses)['DST-BUF'];
  // BUF allowed KC 27 (2024, KC = home) and 41 (2025, KC = away). Getting the
  // side wrong would put BUF in the shutout tier alongside KC.
  assert.equal(buf.stats.pts_allow_21_27, 6.8);
  assert.equal(buf.stats.pts_allow_35p, 10.2);
  assert.equal(buf.stats.pts_allow_0, 0);
  assert.equal(buf.stats.yds_allow_300_349, 6.8);
  assert.equal(buf.stats.yds_allow_550p, 10.2);
  assert.equal(buf.proj_points, 34.0);
});

/* ---------------------------------------------------------------------------
 * 3. Loud skips — never fabricate, never half-count
 * ------------------------------------------------------------------------- */

test('a game with no score row, or no final score, is skipped WHOLE and reported', () => {
  const kinds = SELFTEST.skipped.map((s) => s.kind).sort();
  assert.deepEqual(kinds,
    ['dst_game', 'dst_game', 'dst_game', 'dst_game', 'kicker_week']);
  const gids = SELFTEST.skipped.filter((s) => s.kind === 'dst_game')
    .map((s) => s.game_id).sort();
  assert.deepEqual(gids,
    ['2025_02_BUF_KC', '2025_02_BUF_KC', '2025_03_BUF_KC', '2025_03_BUF_KC']);
  assert.ok(SELFTEST.skipped.every((s) => typeof s.reason === 'string' && s.reason));
  // The dropped rows carried 99 and 77 sacks. If they had leaked in — even
  // partially, e.g. counted for sacks but not for points allowed — KC's sack
  // number would be nowhere near 71.4.
  assert.equal(byId(SELFTEST.defenses)['DST-KC'].stats.sack, 71.4);
  assert.equal(byId(SELFTEST.defenses)['DST-KC'].games_sample, 2);
});

test('an unmappable team abbreviation is skipped loudly, not silently dropped', () => {
  const s = SELFTEST.skipped.find((x) => x.kind === 'kicker_week');
  assert.equal(s.player, 'Delta Kicker');
  assert.equal(s.team_raw, 'XXX');
  assert.ok(!SELFTEST.kickers.some((k) => k.player_id === 'K4'));
});

test('--selftest writes nothing (fixture numbers may never pose as real data)', () => {
  const before = readFileSync(resolve(REPO_ROOT, 'data/kdst_projections.json'), 'utf8');
  execFileSync('python3', ['scripts/build_kdst.py', '--selftest'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  const after = readFileSync(resolve(REPO_ROOT, 'data/kdst_projections.json'), 'utf8');
  assert.equal(after, before);
});

/* ---------------------------------------------------------------------------
 * 4. The league.js mirror
 * ------------------------------------------------------------------------- */

test('build_kdst mirrors app/league.js scoring keys exactly', () => {
  const mirror = runPy(`
import json, sys
sys.path.insert(0, ".")
import scripts.build_kdst as b
print(json.dumps({"k": list(b.KICKER_KEYS), "d": list(b.DEF_KEYS),
                  "scoring": b.DEFAULT_SCORING}))
`);
  const group = (g) => SCORING_FIELDS.filter((f) => f.group === g).map((f) => f.key);
  assert.deepEqual(mirror.k, group('kicking'));
  assert.deepEqual(mirror.d, group('defense'));
  Object.entries(mirror.scoring).forEach(([key, pts]) => {
    assert.equal(pts, DEFAULT_PROFILE.scoring[key],
      `DEFAULT_SCORING mirror drifted on ${key}`);
  });
});

test('proj_points equals applyScoring(stats, DEFAULT_PROFILE) on every row', () => {
  const rows = [
    ...SELFTEST.kickers, ...SELFTEST.defenses,
    ...readJson('data/kdst_projections.json').kickers,
    ...readJson('data/kdst_projections.json').defenses,
  ];
  assert.ok(rows.length > 70);
  rows.forEach((r) => {
    const js = applyScoring(r.stats, DEFAULT_PROFILE);
    assert.ok(Math.abs(js - r.proj_points) < 0.005,
      `${r.player_id}: python ${r.proj_points} vs league.js ${js}`);
  });
});

test('yds_allow_* is inert under a profile that does not score it', () => {
  // league.js keeps unknown scoring keys, so a Sleeper league that scores
  // yardage tiers works with no app change — but DEFAULT_PROFILE does not, and
  // a stat the table does not score must contribute exactly nothing.
  const d = readJson('data/kdst_projections.json').defenses[0];
  const stripped = Object.fromEntries(
    Object.entries(d.stats).filter(([k]) => !k.startsWith('yds_allow_')));
  assert.ok(Object.keys(d.stats).length > Object.keys(stripped).length);
  assert.equal(applyScoring(stripped, DEFAULT_PROFILE),
    applyScoring(d.stats, DEFAULT_PROFILE));
});

/* ---------------------------------------------------------------------------
 * 5. The honesty contract
 * ------------------------------------------------------------------------- */

test('unmodelled DEF keys are ABSENT from stats, never emitted as zero', () => {
  const doc = readJson('data/kdst_projections.json');
  assert.deepEqual(doc.unmodelled_keys.map((u) => u.key).sort(),
    ['def_4_and_stop', 'def_st_ff', 'def_st_fum_rec']);
  doc.unmodelled_keys.forEach((u) => {
    assert.equal(u.position, 'DEF');
    assert.ok(u.reason.length > 40, 'a reason must name the missing source');
  });
  const keys = new Set(doc.unmodelled_keys.map((u) => u.key));
  [...doc.kickers, ...doc.defenses].forEach((r) => {
    Object.keys(r.stats).forEach((k) => assert.ok(!keys.has(k),
      `${r.player_id} scores unmodelable key ${k}`));
  });
  assert.equal(doc.partial_scoring.DEF, true);
  assert.equal(doc.partial_scoring.K, false);
});

test('the validator REDS if an unmodelable key is quietly scored as zero', () => {
  const r = runPy(`
import json, sys
sys.path.insert(0, ".")
from scripts.validate_data import check_kdst_honesty, ValidationError
doc = json.load(open("data/kdst_projections.json", encoding="utf-8"))
proj = json.load(open("data/player_projections.json", encoding="utf-8"))
out = {}
check_kdst_honesty(doc, proj)          # clean file passes
out["clean"] = True
bad = json.loads(json.dumps(doc))
bad["defenses"][0]["stats"]["def_4_and_stop"] = 0.0
bad["modelled_keys"]["DEF"].append("def_4_and_stop")
try:
    check_kdst_honesty(bad, proj)
    out["zeroed"] = False
except ValidationError:
    out["zeroed"] = True
lied = json.loads(json.dumps(doc))
lied["partial_scoring"]["DEF"] = False
try:
    check_kdst_honesty(lied, proj)
    out["flag"] = False
except ValidationError:
    out["flag"] = True
merged = json.loads(json.dumps(proj))
merged["players"].append({"gsis_id": "x", "name": "A Kicker", "team": "KC",
                          "position": "K", "proj_points": 180.0, "low": 1.0,
                          "high": 2.0, "signals_used": []})
try:
    check_kdst_honesty(doc, merged)
    out["merged"] = False
except ValidationError:
    out["merged"] = True
print(json.dumps(out))
`);
  assert.equal(r.clean, true);
  assert.equal(r.zeroed, true, 'a zeroed unmodelable key must red the gate');
  assert.equal(r.flag, true, 'partial_scoring may not disagree with the list');
  assert.equal(r.merged, true, 'a K row in player_projections.json must red the gate');
});

test('K/DST stay OUT of player_projections.json (the eviction rule, mechanised)', () => {
  const proj = readJson('data/player_projections.json');
  const doc = readJson('data/kdst_projections.json');
  assert.ok(proj.players.every((p) => !['K', 'DEF', 'DST'].includes(p.position)));
  const ids = new Set([...doc.kickers, ...doc.defenses].map((r) => r.player_id));
  assert.ok(proj.players.every((p) => !ids.has(p.gsis_id)));
  // WHY the separation exists, measured: the K/DST numbers really would
  // outrank the bottom of the projected[:300] cut.
  const cut = Math.min(...proj.players.map((p) => p.proj_points));
  assert.ok(doc.kickers[0].proj_points > cut,
    'the top kicker outscores the 300th offensive player — merging evicts him');
  assert.ok(doc.defenses[0].proj_points > cut);
});

test('the real file covers 32 defenses and a full kicker population', () => {
  const doc = readJson('data/kdst_projections.json');
  assert.equal(doc.season, 2026);
  assert.deepEqual(doc.seasons_used, [2023, 2024, 2025]);
  assert.equal(doc.games_projected, 17);
  assert.equal(new Set(doc.defenses.map((d) => d.team)).size, 32);
  assert.equal(doc.defenses.length, 32);
  assert.ok(doc.kickers.length >= 32, `only ${doc.kickers.length} kickers`);
  assert.equal(doc.skipped.length, 0, 'a real skip must be investigated, not ignored');
  doc.defenses.forEach((d) => assert.equal(d.games_sample, 51));
});
