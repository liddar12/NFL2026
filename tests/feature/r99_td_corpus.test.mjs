/* tests/feature/r99_td_corpus.test.mjs — R99 E1-S1: the anytime-TD corpus.
 *
 * scripts/backtest_atd.py parse_td_stats reads nflverse stats_player_week CSV
 * text. Locked here (docs/backlog/epics/R99-anytime-td-and-2-to-10-leg-parlays.md):
 *   AC1 every kept player-week carries carries, targets, rush_tds, rec_tds, and a
 *       blank cell stays absent (null), never zero;
 *   AC2 a season with zero REG offence rows raises — never an empty season;
 *   AC3 each team-week's TDs equal the sum of its kept rows' TDs exactly (a
 *       defender's receiving TD counts; a kicker with no offence is dropped).
 * Plus the outcome-leak guard: the universe comes from offensive snaps too, so a
 * snap-only player-week enters with zero counts rather than being left out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\nfrom scripts import backtest_atd as A\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const CSV = `player_id,player_display_name,position,team,opponent_team,season,week,season_type,game_id,carries,targets,rushing_tds,receiving_tds
a,Back A,RB,LA,SF,2024,1,REG,2024_01_SF_LA,20,3,1,0
b,Wide B,WR,LA,SF,2024,1,REG,2024_01_SF_LA,0,9,,1
c,Back C,RB,SF,LA,2024,1,REG,2024_01_SF_LA,15,2,0,0
d,Line D,DE,SF,LA,2024,1,REG,2024_01_SF_LA,,,0,1
e,Kick E,K,SF,LA,2024,1,REG,2024_01_SF_LA,,,,
a,Back A,RB,LA,SF,2024,19,POST,2024_19_SF_LA,20,3,1,0
x,Old Year,RB,LA,SF,2023,1,REG,2023_01_SF_LA,20,3,1,0`;

test('R99 S1 AC1: four TD fields on every kept row, blank stays absent', () => {
  const r = py(`
rows, tg, st = A.parse_td_stats(${JSON.stringify(CSV)}, 2024)
print(json.dumps({"rows": [{k: r[k] for k in ("pid", "team", "home", "carries", "targets", "rush_tds", "rec_tds")} for r in rows], "st": st}))`);
  assert.equal(r.rows.length, 4, 'REG 2024 rows with offence or a skill position');
  for (const row of r.rows) {
    for (const f of ['carries', 'targets', 'rush_tds', 'rec_tds']) assert.ok(f in row, `${row.pid} lacks ${f}`);
  }
  const b = r.rows.find((x) => x.pid === 'b');
  assert.equal(b.rush_tds, null, 'a blank rushing_tds cell is absent, not 0');
  assert.equal(b.carries, 0, 'a written 0 stays 0');
  assert.equal(b.team, 'LAR', 'team codes normalise (LA -> LAR)');
  assert.equal(b.home, true, 'home side read from the game id');
  assert.equal(r.st.not_reg, 1);
  assert.equal(r.st.no_offense, 1, 'the kicker with no offence is dropped');
  assert.equal(r.st.other_season, 1);
});

test('R99 S1 AC2: a season with zero rows raises, never measures an empty season', () => {
  const r = py(`
out = {}
for label, text in (("header_only", ${JSON.stringify(CSV.split('\n')[0])}), ("other_season", ${JSON.stringify(CSV)})):
    try:
        A.parse_td_stats(text, 2022)
        out[label] = "no error"
    except A.CorpusError as exc:
        out[label] = str(exc)
print(json.dumps(out))`);
  assert.match(r.header_only, /0 REG offence rows/);
  assert.match(r.other_season, /0 REG offence rows/);
});

test('R99 S1 AC3: team TDs reconcile to the sum of player TDs per team-week', () => {
  const r = py(`
rows, tg, st = A.parse_td_stats(${JSON.stringify(CSV)}, 2024)
out = {}
for (s, w, team), g in tg.items():
    out[team] = [g["tds"], sum((r["rush_tds"] or 0) + (r["rec_tds"] or 0) for r in rows if r["team"] == team and r["week"] == w)]
print(json.dumps(out))`);
  assert.deepEqual(r.LAR, [2, 2]);
  assert.deepEqual(r.SF, [1, 1], "the defender's receiving TD counts for his team");
});

test('R99 S1: a snap-only player-week enters the universe with zero counts', () => {
  const r = py(`
rows, tg, st = A.parse_td_stats(${JSON.stringify(CSV)}, 2024)
snaps = {(2024, 1, "z"): ("LAR", "WR"), (2024, 1, "a"): ("LAR", "RB")}
uni = A.build_universe(rows, snaps)
z = uni[(2024, 1, "z")]
print(json.dumps({"keys": sorted(k[2] for k in uni), "z": [z["pos"], z["carries"], z["targets"], z["rush_tds"], z["rec_tds"]]}))`);
  assert.deepEqual(r.keys, ['a', 'b', 'c', 'z'], 'the DE (no skill position) is not a candidate; the snap-only WR is');
  assert.deepEqual(r.z, ['WR', 0, 0, 0, 0]);
});
