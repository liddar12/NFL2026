/* tests/feature/r53_ledger_live.test.mjs — R53/R54: the ledger goes live, provably.
 *
 * Week 1 of 2026 has not been played, so nflverse has no stats_player_week_2026
 * yet. This file proves the FIRST-WEEK PATH end to end in the sandbox instead:
 *   1. lock week 1 on a copy of the committed ledger through the production
 *      append (scripts/build_estimate_ledger.append with a post-kickoff as-of);
 *   2. run `scripts/resolve_estimates.py --dry-run-with` — the exact production
 *      resolve + score path — against tests/fixtures/r53/stats_player_week_2026_wk1.csv
 *      (40 ledger players, week 1, nflverse column names) and lock the document:
 *      weeks_resolved 1, players_scored == the matched count, numeric MAE for
 *      shipped / candidate / gated, a signed bias, every unmatched ledger player
 *      LISTED BY NAME, and nothing written to disk;
 *   3. a CSV carrying other weeks only resolves nothing and SAYS WHY;
 *   4. meta.learning_record mirrors the scores document on the same eleven keys;
 *   5. fit_player_signals refuses on one resolved week (no held-out fold) and
 *      records the refusal; on two weeks it proposes;
 *   6. backtest_weekly's live_2026 block: {weeks: 0, note} until a week resolves,
 *      the joined metrics after; the contract admits both shapes;
 *   7. the MODEL cards: LEARNING RECORD keeps the day-zero wording at 0 weeks and
 *      shows the three series once resolved; LIVE 2026 rows on both gate cards
 *      render nothing when the key is absent, the note at 0 weeks, the row after.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  learningCard, weeklyGateCard, parlayGateCard, liveWeeklyHtml, liveParlayHtml,
} from '../../app/views/model.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
const sha = (p) => createHash('sha256').update(read(p)).digest('hex');
const FIXTURE = 'tests/fixtures/r53/stats_player_week_2026_wk1.csv';
const WEEKLY_SAMPLE = JSON.parse(read('tests/fixtures/r51/weekly_backtest.sample.json'));
const PARLAY_SAMPLE = JSON.parse(read('tests/fixtures/r51/parlay_backtest.sample.json'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/** Week 1 locked on a COPY of the committed ledger, through the production append. */
const TMP = mkdtempSync(join(tmpdir(), 'r53-ledger-'));
const LOCKED = join(TMP, 'ledger_locked.json');
const lockInfo = py(`
from scripts import build_estimate_ledger as bl
L = json.load(open("data/estimates/2026.json"))
proj = json.load(open("data/player_projections.json"))
weekly = json.load(open("data/player_weekly.json"))
kick = bl.kickoffs_by_week(json.load(open("data/schedule_full.json"))["games"])
proj["updated_utc"] = "2026-09-11T06:00:00Z"        # the first append after week 1 kicked off
d = bl.append(L, proj, weekly, kick, json.load(open("data/meta.json"))["weights"], 2026, "2026-09-11T06:00:01Z")
bl.write(d, ${JSON.stringify(LOCKED)})
print(json.dumps({"kick1": kick[1], "players": len(d["players"]),
  "locked": sum(1 for p in d["players"].values() if p["locked"]),
  "eligible": sum(1 for p in d["players"].values() if p["first"]["as_of_utc"] < kick[1]),
  "weeks_locked": d["runs"][-1].get("weeks_locked")}))`);

function dryRun(csvPath, ledgerPath = LOCKED) {
  const stdout = execFileSync('python3', [
    'scripts/resolve_estimates.py', '--dry-run-with', csvPath, '--ledger', ledgerPath,
  ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(stdout);
}

test('the production append locks week 1 on the ledger copy from the last pre-kickoff as-of', () => {
  assert.equal(lockInfo.kick1, '2026-09-10T00:20Z');
  assert.ok(lockInfo.players >= 200);
  // Every player the ledger saw BEFORE the week-1 kickoff carries a locked week 1;
  // a player first appended after kickoff (the committed ledger grows in-season)
  // has no pre-kickoff estimate to lock — derived, never pinned to day zero.
  assert.ok(lockInfo.eligible >= 200);
  assert.equal(lockInfo.locked, lockInfo.eligible, 'every pre-kickoff player carries a locked week 1');
  // a fresh lock reports weeks_locked [1]; on a ledger already locked (committed
  // in-season state) the append has nothing new to lock and says so.
  assert.ok(lockInfo.weeks_locked == null || lockInfo.weeks_locked.length === 0
    || JSON.stringify(lockInfo.weeks_locked) === '[1]', String(lockInfo.weeks_locked));
});

test('the fixture is realistic: nflverse columns, week 1 REG, fantasy_points_ppr == the component formula', () => {
  const r = py(`
import csv
from scripts import resolve_estimates as re_
rows = list(csv.DictReader(open(${JSON.stringify(FIXTURE)}, newline="")))
cols = list(rows[0].keys())
bad = []
for row in rows:
    if row["position"] not in re_.POSITIONS:
        continue                       # the K row is outside the resolver's scope
    col = float(row["fantasy_points_ppr"])
    formula = re_.ppr_points({k: v for k, v in row.items() if k != "fantasy_points_ppr"})
    if abs(col - formula) > 0.011:
        bad.append((row["player_display_name"], col, formula))
print(json.dumps({"n": len(rows), "cols": cols, "bad": bad,
  "weeks": sorted({r["week"] for r in rows}), "types": sorted({r["season_type"] for r in rows}),
  "positions": sorted({r["position"] for r in rows})}))`);
  for (const c of ['player_display_name', 'player_name', 'position', 'team', 'week', 'season', 'season_type',
    'passing_yards', 'passing_tds', 'passing_interceptions', 'rushing_yards', 'rushing_tds',
    'receptions', 'receiving_yards', 'receiving_tds', 'fantasy_points_ppr']) {
    assert.ok(r.cols.includes(c), `fixture must carry nflverse column ${c}`);
  }
  assert.equal(r.n, 43, '40 ledger players + 3 non-ledger rows');
  assert.deepEqual(r.weeks, ['1']);
  assert.deepEqual(r.types, ['REG']);
  assert.deepEqual(r.positions, ['K', 'QB', 'RB', 'TE', 'WR']);
  assert.deepEqual(r.bad, [], 'every row is internally consistent (column == formula)');
});

test('--dry-run-with: week 1 resolves through the production path, numbers are real, nothing is written', () => {
  const before = { scores: sha('data/estimate_scores.json'), meta: sha('data/meta.json') };
  const doc = dryRun(FIXTURE);
  assert.equal(sha('data/estimate_scores.json'), before.scores, 'dry run must not write estimate_scores.json');
  assert.equal(sha('data/meta.json'), before.meta, 'dry run must not write meta.json');

  // the matched count, computed by the SAME join the resolver uses
  const expect = py(`
import csv
from scripts import resolve_estimates as re_
ledger = json.load(open(${JSON.stringify(LOCKED)}))
rows = list(csv.DictReader(open(${JSON.stringify(FIXTURE)}, newline="")))
by_np, names, weeks = re_.index_actuals(rows)
matched = [pid for pid, p in ledger["players"].items() if p["locked"] and re_.lookup_actuals(p["name"], p["position"], by_np, names) is not None]
print(json.dumps({"matched": len(matched), "locked": sum(1 for p in ledger["players"].values() if p["locked"]),
  "ppr_rows": len(by_np)}))`);
  assert.equal(doc.weeks_resolved, 1);
  assert.equal(doc.players_scored, expect.matched, 'players_scored == the matched count');
  assert.equal(doc.players_scored, 40, 'all 40 fixture ledger players join (normalised names: suffixes, dots, apostrophes)');
  assert.equal(doc.rows_resolved, 40);
  assert.equal(doc.skipped, null);
  assert.equal(doc.season, 2026);
  const t = doc.totals;
  assert.equal(t.n, 40);
  for (const k of ['mae_shipped', 'mae_candidate', 'mae_gated', 'mae_baseline']) {
    assert.equal(typeof t[k], 'number', `${k} is a number`);
    assert.ok(t[k] > 0 && t[k] < 30, `${k} is plausible PPR error: ${t[k]}`);
  }
  for (const k of ['bias_shipped', 'bias_candidate', 'bias_gated']) {
    assert.equal(typeof t[k], 'number');
    assert.notEqual(t[k], 0, `${k} has a sign`);
  }
  assert.ok(t.band_coverage > 0 && t.band_coverage <= 1);
  // counts conserve and the week row agrees with the totals
  assert.equal(Object.values(doc.by_position).reduce((a, b) => a + b.n, 0), 40);
  assert.deepEqual(Object.keys(doc.by_position).sort(), ['QB', 'RB', 'TE', 'WR']);
  assert.equal(doc.weeks.length, 1);
  assert.equal(doc.weeks[0].week, 1);
  assert.equal(doc.weeks[0].players_scored, 40);
  assert.equal(doc.weeks[0].rows_available, expect.ppr_rows, 'the K row is not a QB/RB/WR/TE row');
  assert.equal(doc.weeks[0].mae_shipped, t.mae_shipped);
  // unmatched: listed BY NAME, never dropped silently; disjoint from the scored set
  assert.equal(doc.unmatched_players, expect.locked - expect.matched);
  assert.equal(doc.unmatched.length, doc.unmatched_players);
  assert.ok(doc.unmatched.every((u) => typeof u.name === 'string' && u.name.length > 2 && u.gsis_id && u.position));
  const scored = new Set(doc.resolved.map((r) => r.gsis_id));
  assert.ok(doc.unmatched.every((u) => !scored.has(u.gsis_id)));
  assert.ok(doc.resolved.every((r) => r.week === 1 && typeof r.actual === 'number' && typeof r.gated === 'number'));
  assert.ok(!doc.resolved.some((r) => r.dnp), 'every joined player has a week-1 row here');
  // the per-row actual is the CSV's own number, not a rounding of it
  const allen = doc.resolved.find((r) => r.gsis_id === 'espn-3918298');
  assert.ok(allen, 'Josh Allen joins by name + position');
  assert.equal(allen.actual, 18.1);
});

test('a CSV carrying OTHER weeks only resolves nothing and says why', () => {
  const src = read(FIXTURE).split('\n');
  const head = src[0].split(',');
  const wi = head.indexOf('week');
  const other = [src[0], ...src.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(',');
    cells[wi] = '2';
    return cells.join(',');
  })].join('\n');
  const path = join(TMP, 'stats_week2_only.csv');
  writeFileSync(path, `${other}\n`);
  const doc = dryRun(path);
  assert.equal(doc.weeks_resolved, 0);
  assert.equal(doc.players_scored, 0);
  assert.equal(doc.resolved.length, 0);
  assert.equal(doc.totals.mae_shipped, null, 'never a number from nothing');
  assert.equal(typeof doc.skipped, 'string');
  assert.match(doc.skipped, /carries week\(s\) \[2\] only/);
  assert.match(doc.skipped, /locked ledger week\(s\) \[1\] have no stats rows yet/);
  // ...and an empty CSV names the other reason
  const emptyPath = join(TMP, 'stats_empty.csv');
  writeFileSync(emptyPath, `${src[0]}\n`);
  const empty = dryRun(emptyPath);
  assert.equal(empty.weeks_resolved, 0);
  assert.match(empty.skipped, /none is a regular-season QB\/RB\/WR\/TE row/);
  // ...and the COMMITTED ledger (nothing locked yet) says so through the same path
  const committed = dryRun(FIXTURE, 'data/estimates/2026.json');
  if (committed.weeks_resolved === 0) {
    assert.match(committed.skipped, /no locked \(pre-kickoff\) player-week yet|carries week|no ledger player joined/);
  }
});

test('meta.learning_record mirrors the scores document on the same eleven keys, resolved or not', () => {
  const r = py(`
from scripts import resolve_estimates as re_
import csv
ledger = json.load(open(${JSON.stringify(LOCKED)}))
rows = list(csv.DictReader(open(${JSON.stringify(FIXTURE)}, newline="")))
doc = re_.build_document(ledger, rows, 2026, "data/estimates/2026.json", "2026-09-15T00:00:00Z")
rec = re_.learning_record(doc, {"age_curve": 0.0, "injury_status": 0.25}, None,
                          tuning_history=[{"kind": "player_signal_fit", "folds": 0, "would_adopt": False,
                                           "verdict": "refused", "reason": "needs two", "generated_utc": "t"}])
print(json.dumps({"doc": {k: v for k, v in doc.items() if k != "resolved"}, "rec": rec}))`);
  const { doc, rec } = r;
  const MIRROR = [
    ['weeks_resolved', doc.weeks_resolved], ['players_scored', doc.players_scored],
    ['mae_ppr', doc.totals.mae_shipped], ['bias_ppr', doc.totals.bias_shipped],
    ['candidate_mae_ppr', doc.totals.mae_candidate], ['candidate_bias_ppr', doc.totals.bias_candidate],
    ['gated_mae_ppr', doc.totals.mae_gated], ['gated_bias_ppr', doc.totals.bias_gated],
    ['band_coverage', doc.totals.band_coverage], ['ledger', doc.ledger], ['updated_utc', doc.generated_utc],
  ];
  assert.equal(MIRROR.length, 11);
  for (const [k, v] of MIRROR) assert.equal(rec[k], v, `learning_record.${k} mirrors the document`);
  assert.equal(rec.weeks_resolved, 1);
  assert.equal(typeof rec.mae_ppr, 'number');
  assert.equal(rec.objective_ready, true);
  assert.deepEqual(rec.signals_with_weight, ['injury_status']);
  assert.equal(rec.note.length > 20, true);
  assert.equal(rec.last_proposal.verdict, 'refused');
  assert.equal(rec.last_proposal.reason, 'needs two');
  // the committed record obeys the same rule against the committed document
  const scores = JSON.parse(read('data/estimate_scores.json'));
  const lr = JSON.parse(read('data/meta.json')).learning_record;
  const committed = [
    ['weeks_resolved', scores.weeks_resolved], ['players_scored', scores.players_scored],
    ['mae_ppr', scores.totals.mae_shipped], ['bias_ppr', scores.totals.bias_shipped],
    ['candidate_mae_ppr', scores.totals.mae_candidate], ['candidate_bias_ppr', scores.totals.bias_candidate],
    ['gated_mae_ppr', scores.totals.mae_gated], ['gated_bias_ppr', scores.totals.bias_gated],
    ['band_coverage', scores.totals.band_coverage], ['ledger', scores.ledger], ['updated_utc', scores.generated_utc],
  ];
  for (const [k, v] of committed) assert.equal(lr[k], v, `committed learning_record.${k} mirrors estimate_scores.json`);
  assert.ok('last_proposal' in lr, 'the record carries last_proposal (null until a fit is archived)');
  assert.ok(Array.isArray(scores.unmatched));
  assert.equal(scores.unmatched.length, scores.unmatched_players);
});

test('fit_player_signals: one resolved week REFUSES (no held-out fold) and records why; two weeks PROPOSE', () => {
  const r = py(`
import os, tempfile, csv
from scripts import fit_player_signals as fps
from scripts import resolve_estimates as re_
ledger = json.load(open(${JSON.stringify(LOCKED)}))
rows = list(csv.DictReader(open(${JSON.stringify(FIXTURE)}, newline="")))
real = re_.build_document(ledger, rows, 2026, "x", "t")       # the REAL one-week document
out = {}
with tempfile.TemporaryDirectory() as tmp:
    sp, mp, tp = (os.path.join(tmp, n) for n in ("scores.json", "meta.json", "tuning.json"))
    json.dump({"weights": {k: 0.0 for k in ("age_curve", "injury_history", "injury_status")}}, open(mp, "w"))
    json.dump({"history": []}, open(tp, "w"))
    json.dump(real, open(sp, "w"))
    e1 = fps.run(sp, mp, tp, propose=True, now="t1")
    out["one"] = {k: e1[k] for k in ("verdict", "would_adopt", "adopted", "folds", "reason", "weeks_resolved", "rows_resolved", "candidate_mae")}
    json.dump({"weeks_resolved": 2, "resolved": fps._rows([1, 2])}, open(sp, "w"))
    e2 = fps.run(sp, mp, tp, propose=True, now="t2")
    out["two"] = {k: e2[k] for k in ("verdict", "would_adopt", "adopted", "folds", "reason")}
    hist = json.load(open(tp))["history"]
    out["archived"] = [(h["kind"], h["verdict"], h["generated_utc"]) for h in hist]
    out["record"] = re_.last_proposal(hist)
    json.dump({"weeks_resolved": 0, "resolved": [], "skipped": "nothing"}, open(sp, "w"))
    out["zero"] = fps.run(sp, mp, tp, propose=True) is None
    out["archived_after_zero"] = len(json.load(open(tp))["history"])
print(json.dumps(out))`);
  assert.equal(r.one.weeks_resolved, 1);
  assert.equal(r.one.rows_resolved, 40);
  assert.equal(r.one.folds, 0, 'one week: no held-out fold');
  assert.equal(r.one.verdict, 'refused');
  assert.equal(r.one.would_adopt, false);
  assert.equal(r.one.adopted, false);
  assert.equal(r.one.candidate_mae, null, 'no number from a fit that did not happen');
  assert.match(r.one.reason, />= 2 resolved weeks/);
  assert.equal(r.two.verdict, 'propose');
  assert.equal(r.two.would_adopt, true);
  assert.equal(r.two.adopted, false, 'a proposal never applies a weight');
  assert.equal(r.two.folds, 1);
  assert.match(r.two.reason, /manual act/);
  assert.deepEqual(r.archived, [['player_signal_fit', 'refused', 't1'], ['player_signal_fit', 'propose', 't2']]);
  assert.equal(r.record.verdict, 'propose', 'the record shows the LATEST archived verdict');
  assert.equal(r.zero, true);
  assert.equal(r.archived_after_zero, 2, '0 weeks archives nothing');
});

test('backtest_weekly live_2026: honest zero until a week resolves, the joined metrics after; contract admits both', () => {
  const r = py(`
import csv
from scripts import backtest_weekly as bw
from scripts import resolve_estimates as re_
from scripts import validate_data as vd
schema = json.load(open("data/contracts/weekly_backtest.schema.json"))
def validate_against_schema(data, schema, label):
    try:
        vd.validate_against_schema(data, schema, label)
        return []
    except vd.ValidationError as exc:
        return [str(exc)]
ledger = json.load(open(${JSON.stringify(LOCKED)}))
rows = list(csv.DictReader(open(${JSON.stringify(FIXTURE)}, newline="")))
doc = re_.build_document(ledger, rows, 2026, "x", "t")
live = bw.live_block(ledger, doc)
zero = bw.live_block(json.load(open("data/estimates/2026.json")), re_.document(2026, "x", [], [], {}, "no 2026 week has resolved yet", "t"))
committed = json.load(open("data/weekly_backtest.json"))
full = dict(committed); full["live_2026"] = bw._round(live)
errs_full = validate_against_schema(full, schema, "weekly_backtest.json")
errs_zero = validate_against_schema(dict(committed, live_2026=zero), schema, "weekly_backtest.json")
bad = dict(committed, live_2026={"weeks": 1, "note": "x", "shipped": {"mae": "6", "rank_corr": 0.1, "topk": 0.5}})
errs_bad = validate_against_schema(bad, schema, "weekly_backtest.json")
print(json.dumps({"live": live, "zero": zero, "mae_doc": doc["totals"]["mae_shipped"], "mae_gated_doc": doc["totals"]["mae_gated"],
  "committed_live": committed.get("live_2026"), "errs_full": list(errs_full or []), "errs_zero": list(errs_zero or []),
  "errs_bad": list(errs_bad or []), "has_gate_read": "live_2026" in open("scripts/backtest_weekly.py").read().split("def main(argv)")[1].split('if "--gate" in argv')[0]}))`);
  // the block on a resolved week
  const live = r.live;
  assert.equal(live.weeks, 1);
  assert.deepEqual(live.weeks_resolved, [1]);
  assert.equal(live.rows, 40);
  assert.equal(live.season, 2026);
  assert.equal(live.ledger, 'data/estimates/2026.json');
  assert.equal(live.scores, 'data/estimate_scores.json');
  for (const series of ['shipped', 'gated', 'candidate']) {
    assert.equal(typeof live[series].mae, 'number', `${series} MAE`);
    assert.equal(typeof live[series].rank_corr, 'number', `${series} rank corr`);
    assert.equal(typeof live[series].topk, 'number', `${series} top-K`);
    assert.ok(live[series].rank_corr >= -1 && live[series].rank_corr <= 1);
    assert.ok(live[series].topk > 0 && live[series].topk <= 1);
  }
  assert.ok(Math.abs(live.shipped.mae - r.mae_doc) < 0.001, 'the live shipped MAE IS the resolver\'s shipped MAE');
  assert.ok(Math.abs(live.gated.mae - r.mae_gated_doc) < 0.001);
  assert.deepEqual(live.per_week.map((w) => [w.week, w.n]), [[1, 40]]);
  assert.equal(live.per_week[0].shipped.mae, live.shipped.mae);
  assert.match(live.note, /never-regress verdict above stays on the corpus/);
  // the honest zero: weeks + note and NOTHING else
  assert.deepEqual(Object.keys(r.zero).sort(), ['note', 'weeks']);
  assert.equal(r.zero.weeks, 0);
  assert.match(r.zero.note, /no locked \(pre-kickoff\) player-week yet|no 2026 week has resolved yet/);
  // the committed artifact carries the block, in whichever honest state the data is in
  assert.ok(r.committed_live, 'data/weekly_backtest.json carries live_2026');
  if (r.committed_live.weeks === 0) assert.deepEqual(Object.keys(r.committed_live).sort(), ['note', 'weeks']);
  else assert.equal(typeof r.committed_live.shipped.mae, 'number');
  // contract: both shapes valid, a string MAE is not
  assert.deepEqual(r.errs_full, []);
  assert.deepEqual(r.errs_zero, []);
  assert.ok(r.errs_bad.length > 0, 'a string where a number belongs must fail the contract');
  // the gate branch never reads the live block (verdict stays on the corpus)
  assert.equal(r.has_gate_read, false);
});

test('LEARNING RECORD card: day-zero wording at 0 weeks; the three series, the best marked and the last verdict once resolved', () => {
  const zero = learningCard({ learning_record: JSON.parse(read('data/meta.json')).learning_record });
  const lr = JSON.parse(read('data/meta.json')).learning_record;
  if (lr.weeks_resolved === 0) {
    assert.match(zero, /WEEKS RESOLVED<\/span><span class="mp-val">0</);
    assert.match(zero, /No 2026 week has resolved yet — nothing has been scored, so no signal has earned weight/);
    assert.doesNotMatch(zero, /LAST PROPOSAL|SERIES/);
  }
  const resolved = {
    weeks_resolved: 1, players_scored: 40, mae_ppr: 5.941, bias_ppr: -1.941,
    candidate_mae_ppr: 5.941, candidate_bias_ppr: -1.941, gated_mae_ppr: 6.487, gated_bias_ppr: -1.923,
    band_coverage: 0.675, signals_with_weight: [], ledger: 'data/estimates/2026.json', objective_ready: true,
    adoption_margin_mae: 0.1, note: 'scored', updated_utc: '2026-09-15T00:00:00Z',
    last_proposal: {
      generated_utc: '2026-09-16T00:00:00Z', verdict: 'refused', would_adopt: false, folds: 0, weeks_resolved: 1,
      candidate_mae: null, gated_mae: null,
      reason: 'walk-forward needs >= 2 resolved weeks for a held-out fold; nothing can be adopted on one week',
    },
  };
  const html = learningCard({ learning_record: resolved });
  const t = text(html);
  assert.match(t, /WEEKS RESOLVED 1/);
  assert.match(t, /PLAYERS SCORED 40/);
  assert.match(t, /MAE \(PPR\) 5\.94/);
  assert.match(t, /BIAS \(PPR\) -1\.94/);
  assert.match(t, /SERIES MAE \(PPR\) BIAS/);
  assert.match(t, /SHIPPED 5\.941 ▲ −1\.941/, 'the lowest MAE is marked');
  assert.match(t, /CANDIDATE 5\.941 ▲ −1\.941/, 'a tie is marked on both');
  assert.match(t, /GATED 6\.487 −1\.923/);
  assert.doesNotMatch(t, /GATED 6\.487 ▲/);
  assert.match(t, /BAND COVERAGE 67\.5% · objective ready · adoption margin 0\.10 PPR/);
  assert.match(t, /LAST PROPOSAL REFUSED/);
  assert.match(t, /walk-forward needs &gt;= 2 resolved weeks for a held-out fold; nothing can be adopted on one week · folds 0 · candidate MAE — vs gated — · Run 2026-09-16/);
  assert.doesNotMatch(t, /No 2026 week has resolved yet/);
  assert.match(t, /negative means under-projected/);
  // a proposal, and the gated series winning
  const d = clone(resolved);
  d.gated_mae_ppr = 5.5;
  d.last_proposal = { verdict: 'propose', would_adopt: true, folds: 1, reason: 'clears the margin', candidate_mae: 5.1, gated_mae: 5.5, generated_utc: '2026-09-23T00:00:00Z' };
  const t2 = text(learningCard({ learning_record: d }));
  assert.match(t2, /GATED 5\.500 ▲/);
  assert.doesNotMatch(t2, /SHIPPED 5\.941 ▲/);
  assert.match(t2, /LAST PROPOSAL PROPOSE/);
  assert.match(t2, /clears the margin · folds 1 · candidate MAE 5\.100 vs gated 5\.500/);
  // resolved but no fit archived yet: said plainly, no borrowed verdict
  const e = clone(resolved);
  e.last_proposal = null;
  const t3 = text(learningCard({ learning_record: e }));
  assert.match(t3, /LAST PROPOSAL none archived yet/);
  assert.match(t3, /has not archived a run on the resolved weeks yet/);
  // a null series stays a dash, never 0.000
  const n = clone(resolved);
  n.gated_mae_ppr = null; n.gated_bias_ppr = null;
  assert.match(text(learningCard({ learning_record: n })), /GATED — —/);
});

test('LIVE 2026 on WEEKLY SPLIT GATE: nothing when absent, the note at 0 weeks, the row after', () => {
  assert.equal(liveWeeklyHtml(undefined), '');
  assert.equal(liveWeeklyHtml(null), '');
  assert.equal(liveWeeklyHtml('x'), '');
  const zero = liveWeeklyHtml({ weeks: 0, note: 'ledger has no locked player-week yet' });
  assert.match(zero, /class="gate-note">LIVE 2026 · no week resolved yet — ledger has no locked player-week yet</);
  assert.ok(!/gate-row/.test(zero));
  const live = {
    season: 2026, weeks: 1, weeks_resolved: [1], rows: 40, ledger: 'data/estimates/2026.json', scores: 'data/estimate_scores.json',
    shipped: { mae: 5.9408, rank_corr: 0.2201, topk: 0.8195 },
    gated: { mae: 6.487, rank_corr: 0.2333, topk: 0.8149 },
    candidate: null,
    per_week: [{ week: 1, n: 40, shipped: { mae: 5.9408, rank_corr: 0.2201, topk: 0.8195 }, gated: { mae: 6.487, rank_corr: 0.2333, topk: 0.8149 }, candidate: null }],
    note: 'measured only',
  };
  const t = text(liveWeeklyHtml(live));
  assert.match(t, /LIVE 2026 1 week · 40 rows MAE 5\.941 · rank corr 0\.220/);
  assert.match(t, /SHIPPED MAE 5\.941 · rank corr 0\.220 · top-K 82\.0% · GATED MAE 6\.487 · rank corr 0\.233 · top-K 81\.5% · wk 1 n 40 MAE 5\.941/);
  assert.doesNotMatch(t, /CANDIDATE/, 'a null series is not rendered');
  assert.match(t, /measured only/);
  // absent key on the sample: the card renders exactly as before; present: the row sits after the metric table
  assert.ok(!/LIVE 2026/.test(weeklyGateCard(WEEKLY_SAMPLE)));
  const withLive = clone(WEEKLY_SAMPLE);
  withLive.live_2026 = live;
  const html = weeklyGateCard(withLive);
  assert.match(html, /gate-name">LIVE 2026</);
  assert.ok(html.indexOf('LIVE 2026') > html.indexOf('Δ V2−V1'), 'after the metric table');
  assert.ok(html.indexOf('LIVE 2026') < html.indexOf('BAND · 2025'), 'before the band line');
  assert.match(html, /gate-chip--adopted">ADOPTED</, 'the corpus verdict is unchanged');
  const zeroDoc = clone(WEEKLY_SAMPLE);
  zeroDoc.live_2026 = { weeks: 0, note: 'no 2026 week has resolved yet' };
  assert.match(weeklyGateCard(zeroDoc), /LIVE 2026 · no week resolved yet — no 2026 week has resolved yet/);
  // escaping: the note is text, never markup
  const evil = liveWeeklyHtml({ weeks: 0, note: '<img src=x onerror=1>' });
  assert.ok(!/<img/.test(evil));
});

test('LIVE 2026 on PARLAY GATE: codes to partition C\'s contract — absent renders nothing, weeks 0 the note', () => {
  assert.equal(liveParlayHtml(undefined), '');
  assert.equal(liveParlayHtml([]), '');
  assert.match(liveParlayHtml({ weeks: 0, legs_resolved: 0, seed: null, calibrated: null, refit: null, note: 'no leg resolved' }),
    /LIVE 2026 · no week resolved yet — no leg resolved/);
  const live = {
    weeks: 2, legs_resolved: 118,
    seed: { log_loss: 0.6912, hit_rate: 0.576 },
    calibrated: { log_loss: 0.6778, hit_rate: 0.601 },
    refit: { applied: true, fit_weeks: [1, 2], reason: 'calibrated clears never-regress on both weeks' },
    note: 'legs scored on FINAL 2026 games',
  };
  const html = liveParlayHtml(live);
  const t = text(html);
  assert.match(t, /LIVE 2026 2 weeks · 118 legs seed LL 0\.6912 → cal 0\.6778 REFIT/);
  assert.match(html, /gate-chip gate-chip--adopted">REFIT</);
  assert.match(t, /HIT RATE seed 57\.6% → calibrated 60\.1% · fit weeks 1\/2/);
  assert.match(t, /calibrated clears never-regress on both weeks · legs scored on FINAL 2026 games/);
  const noRefit = clone(live);
  noRefit.refit = { applied: false, fit_weeks: [], reason: 'seed retained' };
  assert.match(liveParlayHtml(noRefit), /<span class="gate-chip">NO REFIT<\/span>/);
  const nulls = clone(live);
  nulls.seed = null; nulls.calibrated = null; nulls.refit = null;
  const tn = text(liveParlayHtml(nulls));
  assert.match(tn, /seed LL — → cal —/);
  assert.match(tn, /HIT RATE seed — → calibrated —/);
  assert.doesNotMatch(tn, /REFIT/);
  // on the card: absent = unchanged; present = after PROPS, before CORRELATIONS
  assert.ok(!/LIVE 2026/.test(parlayGateCard(PARLAY_SAMPLE)));
  const withLive = clone(PARLAY_SAMPLE);
  withLive.live_2026 = live;
  const card = parlayGateCard(withLive);
  assert.ok(card.indexOf('LIVE 2026') > card.indexOf('CALIBRATION ·'));
  assert.ok(card.indexOf('LIVE 2026') < card.indexOf('CORRELATIONS ·'));
  assert.match(card, /gate-chip--nopath"[^>]*>NO EDGE</, 'the spread verdict is unchanged');
});

test('wiring pins: the dry-run flag, the honest live note, the doc, and the fit verdict', () => {
  const res = read('scripts/resolve_estimates.py');
  assert.match(res, /"--dry-run-with"/);
  assert.match(res, /"--ledger"/);
  assert.match(res, /def build_document\(ledger, rows, season, ledger_rel, now\)/);
  assert.ok(res.indexOf('doc = build_document(') < res.indexOf('def dry_run('), 'run() uses the shared path');
  assert.match(res, /"unmatched": list\(unmatched\)/);
  const bw = read('scripts/backtest_weekly.py');
  assert.match(bw, /doc\["live_%d" % LIVE_SEASON\] = _round\(load_live\(\)\)/);
  assert.match(bw, /return \{"weeks": 0, "note":/);
  const fit = read('scripts/fit_player_signals.py');
  assert.match(fit, /"verdict": \("refused" if wf\["folds"\] == 0 else \("propose" if would else "retain"\)\)/);
  assert.match(fit, /"adopted": False/);
  const doc = read('docs/LEDGER_LIVE.md');
  assert.match(doc, /--dry-run-with/);
  assert.match(doc, /never-regress verdict stays on the 2023-25 corpus/i);
  const schema = JSON.parse(read('data/contracts/weekly_backtest.schema.json'));
  assert.ok(schema.properties.live_2026, 'the contract declares live_2026');
  assert.ok(!schema.required.includes('live_2026'), 'OPTIONAL');
  assert.deepEqual(schema.properties.live_2026.required, ['weeks', 'note']);
  const meta = JSON.parse(read('data/contracts/meta.schema.json'));
  assert.ok(meta.properties.learning_record.properties.last_proposal, 'meta admits last_proposal');
  const es = JSON.parse(read('data/contracts/estimate_scores.schema.json'));
  assert.ok(es.required.includes('unmatched'));
});
