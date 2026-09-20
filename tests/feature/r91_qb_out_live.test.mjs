/* tests/feature/r91_qb_out_live.test.mjs — the adopted qb_out signal must be
 * able to FIRE in season.
 *
 * WHAT WAS WRONG (found on CAR @ ATL, 2026-09-20). data/injury_history.json
 * carried seasons 2021-2025 only: the nflverse release for a season in
 * progress is small (two weeks of reports is ~600 rows) and the 2,000-row
 * "partial pull" floor refused it every day, so the game model's QB-out
 * adjustment had fired zero times all season ("0 team-weeks with QB listings"
 * on every build) while the player gate, reading the same daily report, had
 * already pulled every Atlanta quarterback's props. And the "primary passer"
 * was last season's dropback leader, which for a team that changed
 * quarterbacks is a player who no longer plays for it.
 *
 * WHAT THIS LOCKS: the current-week overlay from the daily ESPN report (ids by
 * name from the depth chart, release team-weeks never overridden, the release
 * floor lowered for the current season), and the prediction-time primary
 * being the depth chart's rank-1 QB, so a listed-Out QB1 moves the number.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

function py(code) {
  const r = spawnSync('python3', ['-c', code], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const DEPTH = { teams: { ATL: { QB: [
  { rank: 1, name: 'Michael Penix Jr.', gsis_id: '00-0039917', espn_id: '1' },
  { rank: 2, name: 'Tua Tagovailoa', gsis_id: '00-0036212', espn_id: '2' },
  { rank: 3, name: 'Cooper Rush', gsis_id: '00-0033662', espn_id: '3' },
] }, CAR: { QB: [{ rank: 1, name: 'Bryce Young', gsis_id: '00-0039150', espn_id: '4' }] } } };

test('R91: the current-week overlay shapes the daily report into the ledger rows, ids by depth-chart name', () => {
  const out = py(`
import json, sys
sys.path.insert(0, '.')
from scripts.build_injury_history import overlay_current_week, merge_overlay, _norm_name
depth = ${JSON.stringify(DEPTH)}
feed = {"injuries": [
  {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Out"},
  {"team": "ATL", "player": "Tua Tagovailoa", "position": "QB", "status": "Doubtful"},
  {"team": "ATL", "player": "Cooper Rush", "position": "QB", "status": "Active"},
  {"team": "ATL", "player": "Drake London", "position": "WR", "status": "Questionable"},
  {"team": "LA", "player": "Puka Nacua", "position": "WR", "status": "Out"},
  {"team": "KC", "player": "Harrison Butker", "position": "K", "status": "Out"},
]}
teams, kept, unresolved = overlay_current_week(feed, depth, 2)
merged, filled = merge_overlay({"ATL": {"1": [{"id": "wk1"}]}}, teams)
merged2, filled2 = merge_overlay({"ATL": {"2": [{"id": "release"}]}}, teams)
print(json.dumps({"kept": kept, "unresolved": unresolved, "teams": teams,
  "filled": filled, "atl1": merged["ATL"]["1"], "atl2": merged["ATL"]["2"],
  "filled2": filled2, "atl2b": merged2["ATL"]["2"],
  "norm": [_norm_name("Michael Penix Jr."), _norm_name("MICHAEL PENIX"), _norm_name("Amon-Ra St. Brown")]}))
`);
  // Active is not a report status; K is not a tracked position; both dropped.
  assert.equal(out.kept, 4);
  // London and Nacua are not on a depth chart that only carries QBs: honest None.
  assert.equal(out.unresolved, 2);
  assert.deepEqual(out.teams.ATL['2'].map((r) => [r.id, r.status]), [
    ['00-0039917', 'Out'], ['00-0036212', 'Doubtful'], [null, 'Questionable']]);
  assert.ok(out.teams.LAR, 'LA renames to LAR like the release path');
  assert.equal(out.norm[0], out.norm[1]);
  assert.equal(out.norm[2], 'amon ra st brown');
  // the overlay FILLS a team-week the release lacks and never overrides one it has
  assert.equal(out.filled, 2);
  assert.deepEqual(out.atl1, [{ id: 'wk1' }]);
  assert.equal(out.atl2.length, 3);
  assert.equal(out.filled2, 1, 'LAR filled, ATL week 2 kept');
  assert.deepEqual(out.atl2b, [{ id: 'release' }]);
});

test('R91: the prediction-time primary passer is the depth chart QB1, and a listed-Out QB1 fires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r91-'));
  try {
    // last season's dropback leader for ATL is Cousins, who no longer plays there
    writeFileSync(join(dir, 'epa.json'), JSON.stringify({ seasons: { '2025': {
      ATL: { '8': { passers: { '00-0029604': { db: 400, epa: 1, name: 'K.Cousins' } } },
             '9': { passers: { '00-0039917': { db: 300, epa: 1, name: 'M.Penix' } } } },
      CAR: { '1': { passers: { '00-0039150': { db: 500, epa: 0, name: 'B.Young' } } } },
    } } }));
    writeFileSync(join(dir, 'inj.json'), JSON.stringify({ seasons: { '2026': {
      ATL: { '2': [{ id: '00-0039917', name: 'Michael Penix Jr.', position: 'QB', status: 'Out' },
                   { id: '00-0036212', name: 'Tua Tagovailoa', position: 'QB', status: 'Doubtful' }] },
      CAR: { '2': [{ id: '00-0039150', name: 'Bryce Young', position: 'QB', status: 'Questionable' }] },
    } } }));
    writeFileSync(join(dir, 'depth.json'), JSON.stringify(DEPTH));
    const out = py(`
import json, sys
sys.path.insert(0, '.')
from scripts.promote_signals import qb_out_current
p, o = qb_out_current(2026, epa_path=${JSON.stringify(join(dir, 'epa.json'))},
                      injury_path=${JSON.stringify(join(dir, 'inj.json'))},
                      depth_path=${JSON.stringify(join(dir, 'depth.json'))})
p2, o2 = qb_out_current(2026, epa_path=${JSON.stringify(join(dir, 'epa.json'))},
                        injury_path=${JSON.stringify(join(dir, 'inj.json'))},
                        depth_path=${JSON.stringify(join(dir, 'missing.json'))})
fires = sorted(t for (t, wk), ids in o.items() if p.get(t) in ids and wk == 2)
print(json.dumps({"primary": p, "fires": fires, "fallback": p2,
  "outs": {t + "|" + str(wk): sorted(ids) for (t, wk), ids in o.items()}}))
`);
    assert.equal(out.primary.ATL, '00-0039917', 'depth chart QB1 (Penix), not the 2025 leader (Cousins)');
    assert.equal(out.primary.CAR, '00-0039150');
    assert.deepEqual(out.fires, ['ATL'], 'Penix Out fires; Young Questionable does not');
    assert.deepEqual(out.outs['ATL|2'], ['00-0036212', '00-0039917']);
    // no depth chart on file -> the honest preseason fallback stands
    assert.equal(out.fallback.ATL, '00-0029604');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R91: the current-season release floor is a partial-season floor, and the builder selftests', () => {
  const src = readFileSync(join(ROOT, 'scripts/build_injury_history.py'), 'utf8');
  assert.match(src, /CURRENT_MIN_ROWS = 50/);
  assert.match(src, /fetch_injuries_release\(season, min_rows=CURRENT_MIN_ROWS\)/);
  const r = spawnSync('python3', ['scripts/build_injury_history.py', '--selftest'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /current-week overlay/);
});
