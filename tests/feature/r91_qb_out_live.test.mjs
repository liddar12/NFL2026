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
 * name from the depth chart, the release floor lowered for the current season),
 * and the prediction-time primary being the depth chart's rank-1 QB, so a
 * listed-Out QB1 moves the number.
 *
 * G01 (R87-R91 review) — FRESHNESS, NOT PRESENCE, on the current week. The rule
 * was "release wins, overlay fills", so the first run of the week owned it:
 * Wednesday's practice report (Questionable, which is defined not to fire) beat
 * Friday's final designation by construction and the ATL QB-out never landed.
 * The current week is now rebuilt from today's report on every run; every week
 * strictly before it stays release-only, which is the walked-forward history the
 * adoption was measured on.
 *
 * G07 — ONE STATUS VOCABULARY. STATUSES was {Out, Doubtful, Questionable}, so
 * 41 rows of the committed daily report — including a quarterback — were dropped
 * on the floor for saying "Injured Reserve". Every report status now goes
 * through scripts/availability.normalize_status; IR/PUP/NFI land as this file's
 * Out (the word promote_signals reads) and an unmapped word raises.
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
feed = {"updated_utc": "2026-09-18T15:43:21Z", "injuries": [
  {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Out"},
  {"team": "ATL", "player": "Tua Tagovailoa", "position": "QB", "status": "Doubtful"},
  {"team": "ATL", "player": "Cooper Rush", "position": "QB", "status": "Active"},
  {"team": "ATL", "player": "Drake London", "position": "WR", "status": "Questionable"},
  {"team": "LA", "player": "Puka Nacua", "position": "WR", "status": "Out"},
  {"team": "KC", "player": "Harrison Butker", "position": "K", "status": "Out"},
]}
teams, kept, unresolved = overlay_current_week(feed, depth, 2)
merged, replaced = merge_overlay({"ATL": {"1": [{"id": "wk1"}]}}, teams, 2)
merged2, replaced2 = merge_overlay(
  {"ATL": {"2": [{"id": "release"}]}, "SEA": {"2": [{"id": "release-sea"}]}}, teams, 2)
print(json.dumps({"kept": kept, "unresolved": unresolved, "teams": teams,
  "replaced": replaced, "atl1": merged["ATL"]["1"], "atl2": merged["ATL"]["2"],
  "replaced2": replaced2, "atl2b": merged2["ATL"]["2"], "sea2b": merged2["SEA"]["2"],
  "norm": [_norm_name("Michael Penix Jr."), _norm_name("MICHAEL PENIX"), _norm_name("Amon-Ra St. Brown")]}))
`);
  // Active says nothing about a missed game; K is not a tracked position; both dropped.
  assert.equal(out.kept, 4);
  // London and Nacua are not on a depth chart that only carries QBs: honest None.
  assert.equal(out.unresolved, 2);
  assert.deepEqual(out.teams.ATL['2'].map((r) => [r.id, r.status]), [
    ['00-0039917', 'Out'], ['00-0036212', 'Doubtful'], [null, 'Questionable']]);
  assert.ok(out.teams.LAR, 'LA renames to LAR like the release path');
  // G01 — every current-week row names the report it came from.
  assert.ok(out.teams.ATL['2'].every((r) => r.as_of_utc === '2026-09-18T15:43:21Z'));
  assert.equal(out.norm[0], out.norm[1]);
  assert.equal(out.norm[2], 'amon ra st brown');
  // G01 — the report REPLACES the current week for every team it covers, and
  // never reaches a week before the current one.
  assert.equal(out.replaced, 2, 'ATL and LAR come from the report');
  assert.deepEqual(out.atl1, [{ id: 'wk1' }], 'week 1 is release-only, untouched');
  assert.equal(out.atl2.length, 3);
  assert.equal(out.replaced2, 2);
  assert.deepEqual(out.atl2b, out.teams.ATL['2'],
    "the report replaces the release's own current-week rows — it is the fresher designation");
  assert.deepEqual(out.sea2b, [{ id: 'release-sea' }],
    'a team the report does not cover keeps the release rows');
});

test('G01: the current week is rebuilt every run — a Q -> Out downgrade lands and flips qb_out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r91-fresh-'));
  try {
    writeFileSync(join(dir, 'epa.json'), JSON.stringify({ seasons: { 2025: {
      ATL: { 1: { passers: { '00-0039917': { db: 400, epa: 1, name: 'M.Penix' } } } } } } }));
    writeFileSync(join(dir, 'depth.json'), JSON.stringify(DEPTH));
    const out = py(`
import json, sys
sys.path.insert(0, '.')
from scripts.build_injury_history import overlay_current_week, merge_overlay, clear_current_week
from scripts.promote_signals import qb_out_current
depth = ${JSON.stringify(DEPTH)}
wed = {"updated_utc": "2026-09-16T15:00:00Z", "injuries": [
  {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Questionable"},
  {"team": "ATL", "player": "Drake London", "position": "WR", "status": "Out"}]}
fri = {"updated_utc": "2026-09-18T15:00:00Z", "injuries": [
  {"team": "ATL", "player": "Michael Penix Jr.", "position": "QB", "status": "Out"}]}
# week 1 is walked-forward release history; week 2 is the current week
season = {"ATL": {"1": [{"id": "00-0039917", "name": "Michael Penix Jr.",
                          "position": "QB", "status": "Doubtful"}]}}
rows, fires, wk1 = [], [], []
inj = ${JSON.stringify(join(dir, 'inj.json'))}
for report in (wed, fri):
    today, _, _ = overlay_current_week(report, depth, 2)
    season, cleared = clear_current_week(season, 2)
    season, _ = merge_overlay(season, today, 2)
    with open(inj, "w", encoding="utf-8") as fh:
        json.dump({"seasons": {"2026": season}}, fh)
    primary, outs = qb_out_current(2026, epa_path=${JSON.stringify(join(dir, 'epa.json'))},
                                   injury_path=inj,
                                   depth_path=${JSON.stringify(join(dir, 'depth.json'))})
    rows.append([[r["status"], r["as_of_utc"]] for r in season["ATL"]["2"]])
    fires.append(primary.get("ATL") in outs.get(("ATL", 2), set()))
    wk1.append(season["ATL"]["1"])
print(json.dumps({"rows": rows, "fires": fires, "wk1": wk1}))
`);
    // Wednesday: Penix Questionable (+ a WR Out). Friday: the downgrade lands and
    // the Wednesday WR row, which Friday's report no longer names, is gone.
    assert.deepEqual(out.rows[0], [['Questionable', '2026-09-16T15:00:00Z'],
      ['Out', '2026-09-16T15:00:00Z']]);
    assert.deepEqual(out.rows[1], [['Out', '2026-09-18T15:00:00Z']],
      "the week is rebuilt from Friday's report, not filled around Wednesday's");
    assert.deepEqual(out.fires, [false, true],
      'Questionable does not fire; the Friday Out does — this is the signal G01 restores');
    // and the walked-forward week before the current one never moved
    assert.deepEqual(out.wk1[0], out.wk1[1]);
    assert.equal(out.wk1[1][0].status, 'Doubtful');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G07: the committed daily report is read through the ONE vocabulary — IR is Out, an unknown word raises', () => {
  const out = py(`
import json, sys
sys.path.insert(0, '.')
from scripts.build_injury_history import (overlay_current_week, report_status, POSITIONS,
                                          STATUSES, OBSERVED_REPORT_STATUSES)
feed = json.load(open("data/injuries.json"))
depth = json.load(open("data/depth_chart.json"))
# what the three-value filter kept, and what the vocabulary keeps
old = sum(1 for r in feed["injuries"]
          if (r.get("position") or "").strip() in POSITIONS
          and (r.get("status") or "").strip() in STATUSES
          and (r.get("team") or "").strip())
season_class = sum(1 for r in feed["injuries"]
                   if (r.get("position") or "").strip() in POSITIONS
                   and (r.get("team") or "").strip()
                   and (r.get("status") or "").strip() not in STATUSES
                   and report_status((r.get("status") or "").strip()) is not None)
teams, kept, unresolved = overlay_current_week(feed, depth, 2)
rows = [r for w in teams.values() for rs in w.values() for r in rs]
try:
    report_status("Banged Up")
    raised = ""
except ValueError as err:
    raised = str(err)
print(json.dumps({
  "old": old, "kept": kept, "season_class": season_class,
  "vocab": sorted({(r.get("status") or "").strip() for r in feed["injuries"]} - {""}),
  "pinned": sorted(OBSERVED_REPORT_STATUSES),
  "designated": sorted({r["designation"] for r in rows if r.get("designation")}),
  "designated_all_out": all(r["status"] == "Out" for r in rows if r.get("designation")),
  "raised": raised}))
`);
  // The count the review's acceptance names: every tracked row the report carries,
  // not just the three words the old filter knew.
  assert.equal(out.kept, out.old + out.season_class,
    'the overlay keeps the season-class rows the three-value filter dropped');
  assert.ok(out.season_class > 0, 'the committed report really does carry IR rows');
  assert.deepEqual(out.designated, ['Injured Reserve']);
  assert.equal(out.designated_all_out, true, 'IR lands as Out — the word the signal reads');
  // the FULL observed vocabulary is accounted for, so a new ESPN word reds here
  for (const word of out.vocab) assert.ok(out.pinned.includes(word), `unpinned status ${word}`);
  assert.match(out.raised, /Banged Up/);
  assert.match(out.raised, /canonical vocabulary/);
});

test('G07: a rank-1 QB on IR fires qb_out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r91-ir-'));
  try {
    writeFileSync(join(dir, 'epa.json'), JSON.stringify({ seasons: { 2025: {
      CLE: { 1: { passers: { '00-0034855': { db: 400, epa: 0, name: 'D.Watson' } } } } } } }));
    // CLE's rank-1 QB is the one the report puts on IR.
    writeFileSync(join(dir, 'depth.json'), JSON.stringify({ teams: { CLE: { QB: [
      { rank: 1, name: 'Dillon Gabriel', gsis_id: '00-0039920' },
      { rank: 2, name: 'Deshaun Watson', gsis_id: '00-0034855' }] } } }));
    const out = py(`
import json, sys
sys.path.insert(0, '.')
from scripts.build_injury_history import overlay_current_week
from scripts.promote_signals import qb_out_current
depth = json.load(open(${JSON.stringify(join(dir, 'depth.json'))}))
feed = {"updated_utc": "2026-09-20T15:43:21Z", "injuries": [
  {"team": "CLE", "player": "Dillon Gabriel", "position": "QB", "status": "Injured Reserve"}]}
season, kept, _ = overlay_current_week(feed, depth, 2)
inj = ${JSON.stringify(join(dir, 'inj.json'))}
with open(inj, "w", encoding="utf-8") as fh:
    json.dump({"seasons": {"2026": season}}, fh)
primary, outs = qb_out_current(2026, epa_path=${JSON.stringify(join(dir, 'epa.json'))},
                               injury_path=inj,
                               depth_path=${JSON.stringify(join(dir, 'depth.json'))})
print(json.dumps({"row": season["CLE"]["2"][0], "kept": kept,
                  "fires": primary.get("CLE") in outs.get(("CLE", 2), set())}))
`);
    assert.equal(out.kept, 1);
    assert.equal(out.row.status, 'Out', 'IR is at least as unavailable as Doubtful, which fires');
    assert.equal(out.row.designation, 'Injured Reserve', 'the report\'s own word is kept');
    assert.equal(out.fires, true, 'the QB the depth chart ranks first cannot play — the signal fires');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
