/* tests/feature/r70_lines.test.mjs — locks for R70 phase 1: the LINE-INJURY
 * CASCADE measurement and the OL / DL-front LINE REPORT annotation.
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. POSITION ADMISSION. build_injury_history admits the OL and the DL
 *      FRONT (not OLB, not K/S/CB) and keeps the skill rows byte-identical in
 *      shape and order — the committed file's QB/RB/WR/TE content is what the
 *      qb_out family reads, so widening the filter must never touch it.
 *   2. THE FEED CARRIES POSITIONS HONESTLY. espn.fetch_injuries carries
 *      `position` / `athlete_id` ONLY when asked (build_predictions) and only
 *      when the payload has them (null otherwise); the default row shape the
 *      Rel17 contract locks is unchanged.
 *   3. THE LINE REPORT CANNOT LIE. Starters come from the latest snapshot at
 *      rank 1, one entry per player, both release shapes; an unreachable chart
 *      yields available:false with empty teams and zero counts, never invented
 *      starters. The committed document validates against its contract.
 *   4. THE MEASUREMENT EMITS A VERDICT AND ADOPTS NOTHING. backtest_lines runs
 *      the walk-forward experiment on a synthetic corpus with a planted OL
 *      effect (the ratio table must show it), emits 15 variants each with a
 *      never-regress verdict, and the committed artifact's verdicts follow
 *      from its own pooled numbers.
 *   5. THE CHIPS ARE ONE COMPONENT. players.js and lineup.js carry the same
 *      two helpers (lineup must stay off players.js's graph); they must render
 *      identically, render nothing on absent / unavailable / other-week docs,
 *      and the PLAYERS splice leaves the r51-pinned .p-unit order intact.
 *
 * Node built-ins only; python3 is already a fast-gate dependency (the pattern
 * is tests/feature/r51_weekly.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  lineReportTeams as playersTeams, lineChipsHtml as playersChips, withLineChips, withWeekHeadline,
  LINE_LEGEND,
} from '../../app/views/players.js';
import {
  lineReportTeams as lineupTeams, lineChipsHtml as lineupChips,
} from '../../app/views/lineup.js';
import { weekLineupHtml } from '../../app/views/grade.js';
import { renderPlayerCard } from '../../app/render.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

/** Run a python3 snippet from the repo root; parse the single JSON line it prints. */
function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function selftest(script) {
  return spawnSync('python3', [script, '--selftest'], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/* ------------------------------------------------ 1. position admission */

test('R70: build_injury_history admits OL and DL-front spellings, not OLB / K / S, and shapes skill rows unchanged', () => {
  const r = runPy(`
import json
from scripts import build_injury_history as bih
rows = [
  {"position": "QB", "report_status": "Out", "team": "LA", "week": "10", "gsis_id": "00-1", "full_name": "A Passer"},
  {"position": "T", "report_status": "Out", "team": "LA", "week": "10", "gsis_id": "00-2", "full_name": "A Tackle"},
  {"position": "WR", "report_status": "Questionable", "team": "LA", "week": "10", "gsis_id": "00-3", "full_name": "A Wideout"},
  {"position": "NT", "report_status": "Doubtful", "team": "LA", "week": "10", "gsis_id": "00-4", "full_name": "A Nose"},
  {"position": "OLB", "report_status": "Out", "team": "LA", "week": "10", "gsis_id": "00-5", "full_name": "An Edge"},
  {"position": "K", "report_status": "Out", "team": "LA", "week": "10", "gsis_id": "00-6", "full_name": "A Kicker"},
  {"position": "S", "report_status": "Out", "team": "LA", "week": "10", "gsis_id": "00-7", "full_name": "A Safety"},
]
mixed, kept = bih.shape(rows)
skill, kept_skill = bih.shape([r for r in rows if r["position"] in bih.SKILL_POSITIONS])
print(json.dumps({
  "kept": kept, "kept_skill": kept_skill,
  "mixed": mixed["LAR"]["10"], "skill": skill["LAR"]["10"],
  "positions": sorted(bih.POSITIONS), "skill_positions": sorted(bih.SKILL_POSITIONS),
  "ol": sorted(bih.OL_POSITIONS), "dl": sorted(bih.DL_FRONT_POSITIONS),
  "groups": {p: bih.line_group(p) for p in ("LT", "T", "C", "RDE", "DT", "NT", "OLB", "QB", "K")},
}))`);
  assert.equal(r.kept, 4, 'QB + T + WR + NT pass; OLB / K / S do not');
  assert.equal(r.kept_skill, 2);
  assert.deepEqual(r.mixed.map((x) => x.position), ['QB', 'T', 'WR', 'NT'], 'release order kept');
  assert.deepEqual(r.mixed.filter((x) => ['QB', 'RB', 'WR', 'TE'].includes(x.position)), r.skill,
    'the skill rows are identical whether or not linemen are in the pull');
  for (const row of r.mixed) assert.deepEqual(Object.keys(row), ['id', 'name', 'position', 'status']);
  assert.deepEqual(r.skill_positions, ['QB', 'RB', 'TE', 'WR']);
  for (const p of ['T', 'G', 'C', 'LT', 'RT', 'LG', 'RG', 'OL', 'OT', 'OG']) assert.ok(r.ol.includes(p), p);
  for (const p of ['DE', 'DT', 'NT', 'DL', 'EDGE', 'LDE', 'RDE', 'LDT', 'RDT']) assert.ok(r.dl.includes(p), p);
  for (const p of ['OLB', 'ILB', 'LB', 'S', 'CB', 'K']) assert.ok(!r.positions.includes(p), `${p} must not be admitted`);
  assert.deepEqual(r.groups, { LT: 'ol', T: 'ol', C: 'ol', RDE: 'dl', DT: 'dl', NT: 'dl', OLB: null, QB: null, K: null });
  const st = selftest('scripts/build_injury_history.py');
  assert.equal(st.status, 0, st.stderr);
});

test('R70: the committed injury_history carries line rows for every scored season and only contract positions', () => {
  const doc = readJson('data/injury_history.json');
  const schema = readJson('data/contracts/injury_history.schema.json');
  const allowed = new Set(schema.properties.seasons.additionalProperties.additionalProperties
    .additionalProperties.items.properties.position.enum);
  for (const season of ['2023', '2024', '2025']) {
    let skill = 0; let line = 0;
    for (const weeks of Object.values(doc.seasons[season])) {
      for (const rows of Object.values(weeks)) {
        for (const r of rows) {
          assert.ok(allowed.has(r.position), `${season}: position ${r.position} not in the contract`);
          if (['QB', 'RB', 'WR', 'TE'].includes(r.position)) skill += 1; else line += 1;
        }
      }
    }
    assert.ok(skill > 500 && line > 500, `${season}: skill ${skill} / line ${line} rows`);
  }
  assert.match(doc.source, /OL \+ DL front/);
});

/* ------------------------------------------ 2. the feed carries positions */

test('R70: espn.fetch_injuries carries position / athlete_id only on request and only when present', () => {
  const r = runPy(`
import json
from scripts.scrape import espn
payload = {"injuries": [{"team": {"abbreviation": "SF"}, "injuries": [
  {"athlete": {"id": 4040715, "displayName": "Trent Williams", "position": {"abbreviation": "OT"}},
   "status": {"name": "Out"}, "longComment": "Rested."},
  {"athlete": {"displayName": "No Position Given"}, "status": {"name": "Questionable"}},
  {"athlete": {"id": "", "displayName": "Bare String Pos", "position": "de"}, "status": {"name": "Doubtful"}},
]}]}
espn._get_json = lambda url, params=None: payload
plain = espn.fetch_injuries()
rich = espn.fetch_injuries(carry_positions=True)
print(json.dumps({"plain_keys": list(plain[0]), "rich": [(r["player"], r["position"], r["athlete_id"], r["availability"]) for r in rich]}))`);
  assert.deepEqual(r.plain_keys, ['team', 'player', 'status', 'availability', 'availability_class',
    'weeks_out', 'out_for_season', 'confidence', 'evidence', 'detail'], 'default shape unchanged');
  assert.deepEqual(r.rich, [
    ['Trent Williams', 'OT', '4040715', 'OUT'],
    ['No Position Given', null, null, 'QUESTIONABLE'],
    ['Bare String Pos', 'DE', null, 'DOUBTFUL'],
  ]);
  const bp = read('scripts/build_predictions.py');
  assert.match(bp, /espn\.fetch_injuries\(carry_positions=True\)/, 'build_predictions asks for them');
  assert.match(bp, /_dst\["position"\] = _src\.get\("position"\)/, 'and writes them through enrich_document');
  const schema = readJson('data/contracts/injuries.schema.json');
  const props = schema.properties.injuries.items.properties;
  assert.deepEqual(props.position.type, ['string', 'null']);
  assert.deepEqual(props.athlete_id.type, ['string', 'null']);
  assert.ok(!schema.properties.injuries.items.required.includes('position'), 'optional: older docs have no key');
});

/* ------------------------------------------------------ 3. the line report */

test('R70: build_line_report — latest snapshot, rank-1 OL / DL-front starters, ESPN-id join, unavailable path', () => {
  const st = selftest('scripts/build_line_report.py');
  assert.equal(st.status, 0, st.stderr);
  const r = runPy(`
import json
from scripts import build_line_report as blr
depth = [
  {"dt": "2026-09-07", "team": "KC", "player_name": "Left Tackle", "gsis_id": "00-1", "espn_id": "4001", "pos_abb": "LT", "pos_slot": "3", "pos_rank": "1"},
  {"dt": "2026-09-07", "team": "KC", "player_name": "Right Tackle", "gsis_id": "00-2", "pos_abb": "RT", "pos_slot": "7", "pos_rank": "1"},
  {"dt": "2026-09-07", "team": "KC", "player_name": "Backup", "gsis_id": "00-3", "pos_abb": "RT", "pos_slot": "7", "pos_rank": "2"},
  {"dt": "2026-09-07", "team": "KC", "player_name": "Left End", "gsis_id": "00-4", "pos_abb": "LDE", "pos_slot": "1", "pos_rank": "1"},
  {"dt": "2026-09-07", "team": "KC", "player_name": "Will Backer", "gsis_id": "00-5", "pos_abb": "WLB", "pos_slot": "5", "pos_rank": "1"},
  {"dt": "2026-08-01", "team": "KC", "player_name": "Old Tackle", "gsis_id": "00-6", "pos_abb": "LT", "pos_slot": "3", "pos_rank": "1"},
]
inj = [
  {"team": "KC", "player": "Some Other Spelling", "status": "Out", "availability": "OUT", "athlete_id": "4001"},
  {"team": "KC", "player": "Right Tackle", "status": "Questionable", "availability": "QUESTIONABLE"},
  {"team": "KC", "player": "Left End", "status": "Injured Reserve", "availability": "IR"},
  {"team": "KC", "player": "Old Tackle", "status": "Out", "availability": "OUT"},
]
doc = blr.build(2026, 3, depth, inj)
off = blr.build(2026, 3, None, inj, snapshot_note="proxy 403")
print(json.dumps({"doc": doc, "off": off}))`);
  const kc = r.doc.teams.KC;
  assert.equal(r.doc.available, true);
  assert.equal(r.doc.week, 3);
  assert.deepEqual(kc.ol, { starters: 2, names: ['Left Tackle', 'Right Tackle'], out: ['Left Tackle'],
    doubtful: [], questionable: ['Right Tackle'] }, 'ESPN id joins across spellings; rank 2 and old snapshot ignored');
  assert.deepEqual(kc.dl, { starters: 1, names: ['Left End'], out: ['Left End'], doubtful: [], questionable: [] },
    'WLB is not front; IR is out');
  assert.equal(r.doc.counts.starters_matched, 3);
  assert.equal(r.off.available, false);
  assert.equal(r.off.reason, 'proxy 403');
  assert.deepEqual(r.off.teams, {});
  for (const v of Object.values(r.off.counts)) assert.equal(v, 0);
});

test('R70: the committed data/line_report.json validates against its contract and matches the pipeline week', () => {
  const r = runPy(`
import json
import scripts.validate_data as vd
from scripts import build_line_report as blr
schema = json.load(open("data/contracts/line_report.schema.json"))
doc = json.load(open("data/line_report.json"))
vd.validate_against_schema(doc, schema, "line_report")
vd.validate_against_schema(blr.unavailable(2026, 1, "x"), schema, "unavailable")
print(json.dumps({"available": doc["available"], "week": doc["week"], "teams": len(doc["teams"]), "counts": doc["counts"]}))`);
  assert.equal(typeof r.available, 'boolean');
  const preds = readJson('data/game_predictions.json');
  assert.equal(r.week, preds.week);
  if (r.available) {
    assert.equal(r.teams, 32);
    assert.equal(r.counts.ol_starters, 160, 'five OL per team');
    assert.ok(r.counts.dl_starters >= 96 && r.counts.dl_starters <= 128, '3- or 4-man fronts');
  } else {
    assert.equal(r.teams, 0);
    assert.equal(r.counts.ol_starters, 0);
  }
  const schema = readJson('data/contracts/line_report.schema.json');
  assert.ok(!JSON.stringify(schema).includes('"$ref":'), 'the validator has no $ref (definitions inlined)');
});

/* ----------------------------------------------- 4. the measurement */

test('R70: backtest_lines emits 15 variants with a never-regress verdict each and adopts nothing', () => {
  const st = selftest('scripts/backtest_lines.py');
  assert.equal(st.status, 0, st.stderr);
  const r = runPy(`
import json
from scripts import backtest_lines as bl
actuals, games_doc, dvp_doc, hist, depth = bl._synthetic()
res = bl.artifact(bl.run(actuals, games_doc, dvp_doc, hist, depth))
print(json.dumps({"n_variants": len(res["variants"]), "adopted": res["verdict"]["adopted"],
  "keys": sorted(res["variants"]), "rb": res["ratio_by_own_ol_out"]["RB"],
  "sample": res["variants"]["ol0.04_dl0.02"], "inc": res["incumbent"]["pooled"],
  "coverage": res["coverage"], "rule": res["verdict"]["rule"]}))`);
  assert.equal(r.n_variants, 15);
  assert.equal(r.adopted, false, 'phase 1 adopts nothing');
  assert.ok(r.keys.includes('ol0.06_dl0.00') && r.keys.includes('ol0.00_dl0.06') && !r.keys.includes('ol0.00_dl0.00'));
  assert.ok(r.rb['1'].ratio < r.rb['0'].ratio, 'the planted OL dip is visible in the ratio table');
  assert.deepEqual(Object.keys(r.sample.verdict).sort(), ['adopted', 'reason']);
  assert.deepEqual(Object.keys(r.sample.pooled).sort(), ['mae', 'rank_corr', 'topk']);
  assert.ok('bootstrap_delta_mae_held_out' in r.sample && 'per_position' in r.sample);
  assert.ok(r.coverage.ol_known > 0 && r.coverage.ol_known < r.coverage.rows, 'week 1 is neutral under lag 1');
  assert.match(r.rule, /never-regress/);
});

test('R70: the committed lines_backtest artifact, when present, is measure-only and its verdicts follow its numbers', () => {
  const path = 'data/lines_backtest.json';
  if (!existsSync(join(REPO_ROOT, path))) return; // runner-built; absence is honest
  const doc = readJson(path);
  assert.equal(doc.verdict.adopted, false);
  assert.equal(doc.model_incumbent, 'weekly_split_v2');
  assert.equal(Object.keys(doc.variants).length, 15);
  const inc = doc.incumbent.pooled;
  for (const [key, v] of Object.entries(doc.variants)) {
    const expect = v.pooled.mae <= inc.mae && v.pooled.rank_corr >= inc.rank_corr;
    assert.equal(v.verdict.adopted, expect, `${key}: verdict must follow the pooled numbers`);
  }
  assert.deepEqual(doc.verdict.adoptable_variants,
    Object.keys(doc.variants).filter((k) => doc.variants[k].verdict.adopted).sort());
  assert.ok(!('_rows' in doc));
  assert.match(doc.policy, /MEASUREMENT ONLY/);
});

/* ------------------------------------------------------- 5. the chips */

const REPORT = {
  season: 2026, week: 4, available: true, reason: null, source: 't', snapshot: 's',
  positions: { ol: [], dl: [] }, counts: {},
  teams: {
    KC: { ol: { starters: 5, names: [], out: ['Trey Smith', 'Josh Simmons'], doubtful: [], questionable: ['Creed Humphrey'] },
          dl: { starters: 4, names: [], out: [], doubtful: [], questionable: [] } },
    BUF: { ol: { starters: 5, names: [], out: [], doubtful: ['Some Guard'], questionable: [] },
           dl: { starters: 4, names: [], out: ['Ed Oliver'], doubtful: [], questionable: [] } },
    DEN: { ol: { starters: 5, names: [], out: [], doubtful: [], questionable: [] },
           dl: { starters: 3, names: [], out: [], doubtful: [], questionable: [] } },
  },
};

test('R70: lineReportTeams gates on available:true and the week; players.js and lineup.js copies agree exactly', () => {
  for (const [teams, chips] of [[playersTeams, playersChips], [lineupTeams, lineupChips]]) {
    assert.equal(teams(null, 4), null);
    assert.equal(teams({ ...REPORT, available: false, teams: {} }, 4), null, 'unavailable -> nothing');
    assert.equal(teams(REPORT, 5), null, 'another week -> nothing');
    assert.equal(teams(REPORT, 4), REPORT.teams);
    assert.equal(teams({ ...REPORT, week: null }, 9), REPORT.teams, 'a weekless doc is not week-gated');
    assert.equal(chips(null, 'KC', 'BUF'), '');
    assert.equal(chips(REPORT.teams, 'DEN', 'DEN'), '', 'healthy lines render no chip at all');
  }
  const cases = [['KC', 'BUF'], ['BUF', 'KC'], ['den', 'buf'], ['KC', null], [null, 'BUF'], ['ZZZ', 'ZZZ']];
  for (const [team, opp] of cases) {
    assert.equal(playersChips(REPORT.teams, team, opp), lineupChips(REPORT.teams, team, opp), `${team} vs ${opp}`);
  }
  const html = playersChips(REPORT.teams, 'KC', 'BUF');
  assert.match(html, /<span class="line-chip line-chip--out" title="Own offensive line out: Trey Smith, Josh Simmons · questionable: Creed Humphrey">OL: 2 out<\/span>/);
  assert.match(html, /<span class="line-chip line-chip--out" title="Opposing defensive front out: Ed Oliver">vs DL: 1 out<\/span>/);
  const q = playersChips(REPORT.teams, 'BUF', 'DEN');
  assert.equal(q, '<span class="line-chip" title="Own offensive line questionable: Some Guard">OL: 1 Q</span>',
    'doubtful/questionable without an out reads as Q; a healthy opponent adds nothing');
  assert.equal(playersChips(REPORT.teams, 'KC', null), playersChips(REPORT.teams, 'KC', 'DEN'));
});

test('R70: the PLAYERS splice sits after the BASE line and leaves the r51 .p-unit order intact', () => {
  const p = { gsis_id: 'x1', name: 'A Player', position: 'RB', team: 'KC', proj_points: 200,
    low: 150, high: 250, rank: 1, pos_rank: 1 };
  const card = withWeekHeadline(renderPlayerCard(p, {}), 4, { points: 12.3, bye: false, opp: 'BUF' }, 200);
  const chips = playersChips(REPORT.teams, 'KC', 'BUF');
  const out = withLineChips(card, chips);
  const units = [...out.matchAll(/<div class="p-unit">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.equal(units[0], 'WK 4 · MATCHUP');
  assert.equal(units[1], 'BASE 200.0 · SEASON');
  assert.ok(out.indexOf('<div class="p-line">') > out.indexOf('BASE 200.0 · SEASON'), 'chips follow BASE');
  assert.ok(out.includes(`<div class="p-line">${chips}</div>`));
  assert.equal(withLineChips(card, ''), card, 'no chips -> untouched');
  assert.equal(withLineChips('<div>x</div>', chips), '<div>x</div>', 'no headline -> untouched');
  assert.match(LINE_LEGEND, /change no number/);
});

test('R70: GRADE week folds carry the chip through lineOf and render exactly as before without it', () => {
  const d = {
    week: 4, total: 30, rows: [{ id: 'a', name: 'A Back', pos: 'RB', pts: 20, onBye: false, playable: true, projected: true },
      { id: 'b', name: 'B End', pos: 'TE', pts: 10, onBye: false, playable: true, projected: true }],
    lineup: { geometry: [{ slot: 'RB', positions: ['RB'], projected: true }, { slot: 'TE', positions: ['TE'], projected: true }],
      slots: { RB: 'a', TE: 'b' }, total: 30 },
  };
  const plain = weekLineupHtml(d, {});
  assert.ok(!plain.includes('line-chip'));
  const withChips = weekLineupHtml(d, { lineOf: (id, wk) => (id === 'a' && wk === 4 ? playersChips(REPORT.teams, 'KC', 'BUF') : '') });
  assert.match(withChips, /A Back <span class="line-chip line-chip--out"[^>]*>OL: 2 out<\/span>/);
  assert.equal((withChips.match(/line-chip--out/g) || []).length, 2, 'own OL + vs DL on the one row');
  assert.equal(withChips.replace(/ <span class="line-chip[^]*?vs DL: 1 out<\/span>/, ''), plain,
    'the chip is the only difference');
});

test('R70: wiring — one allSettled on LINEUP, AI+-gated fetch on PLAYERS, optional fetch on GRADE, additive CSS', () => {
  const lineup = read('app/views/lineup.js');
  const mount = lineup.slice(lineup.indexOf('export default async function mountLineup'));
  assert.equal((mount.match(/Promise\.allSettled\(/g) || []).length, 1);
  assert.match(mount, /getLineReport\(\),\n\s+\]\);/);
  assert.match(mount, /const line = r\.kdst \? '' : lineChipsHtml\(lineTeams, r\.team, r\.opp\);/);
  assert.match(mount, /lu-linenote/);
  assert.match(mount, /change no number here/);
  const players = read('app/views/players.js');
  assert.match(players, /const wantsLine = loadAiPref\(\);/);
  assert.match(players, /wantsLine \? getLineReport\(\) : Promise\.resolve\(null\),/);
  assert.match(players, /withWeekHeadline\(card, currentWk, weekOf\(id\), m\.player\.proj_points\)/, 'r51 call kept');
  assert.match(players, /<div class="ai-note">\$\{esc\(aiCopy\)\}<\/div>\$\{lineLegendHtml\(\)\}/, 'legend is a sibling, not inside .ai-note');
  const grade = read('app/views/grade.js');
  assert.match(grade, /getLineReport\(\), \/\/ R70/);
  assert.match(grade, /lineOf: lineOfFor\(g\.players\),/);
  const data = read('app/data.js');
  assert.match(data, /lineReport: '\/data\/line_report\.json',/);
  assert.match(data, /export const getLineReport = \(opts\) => loadJson\(PATHS\.lineReport, opts\);/);
  const css = read('app/theme.css');
  assert.match(css, /\.line-chip \{/);
  assert.match(css, /\.line-chip--out \{/);
  assert.match(css, /\.gr-slot \.line-chip \{/);
  assert.match(css, /\.p-line \{/);
  // The chip carries meaning in TEXT: no colour-only variant exists.
  assert.ok(!/\.line-chip--q\b/.test(css));
});
