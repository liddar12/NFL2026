/* tests/feature/r72_review_summary.test.mjs — locks for the R72 review summary
 * (owner decisions, final): picks RIGHT / WRONG / TBD, week blocks through the
 * pipeline week, the five parlay buckets, the players_season tally, and THE
 * LEARNING LOCK — the proof that graded lock receipts feed scripts/refit.py,
 * derived from lock FILES and the refit archive, never pinned.
 *
 *   1. RIGHT / WRONG / TBD. right == won, wrong == n - won, tbd = games with no
 *      FINAL evidence; only FINAL grades a pick. A week with zero finals still
 *      gets a block: picks n=0 / tbd=<count>, every game result null, picked
 *      from the receipt when a lock row exists and null when it does not.
 *   2. BUCKETS. Every one of pending / push / all_hit / all_missed / partial is
 *      produced from a real leg pattern, and result <-> bucket is consistent:
 *      hit<->all_hit, void<->push, miss<->partial|all_missed, pending<->pending.
 *   3. PLAYERS_SEASON. Tallies over every week block; dnp is a graded row that
 *      reports null actual/delta; met_rate = met / weeks.
 *   4. THE LEARNING LOCK. On the r72 fixture (lock files + refit archive):
 *      graded_locks_total equals the receipts under snapshots/ by refit's exact
 *      rule (event_type game, resolved, estimate false — an estimate receipt
 *      grades the pick but is not a refit input; another season's file is
 *      ignored), the newest IN-SEASON pass wins regardless of list order, and
 *      consumed_all is true only when that pass's n_resolved matches. On the
 *      COMMITTED data: graded_locks_total equals the count derived from
 *      data/snapshots/*_games_open.json, and week 1 right + wrong equals the
 *      graded picks — nothing pinned.
 *   5. THE ARTIFACT. data/review.json validates against the inlined schema, is
 *      written in the repo's one JSON convention, and carries every contract
 *      key partition U renders.
 *
 * Node built-ins only; python3 is already a fast-gate dependency (the pattern
 * is tests/feature/r71_review.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = join(REPO_ROOT, 'data', 'review.json');
const SNAPSHOTS = join(REPO_ROOT, 'data', 'snapshots');
const FIXTURE_SNAPSHOTS = join(REPO_ROOT, 'tests', 'fixtures', 'r72', 'snapshots');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const PRELUDE = `
import json
from scripts import build_review as br
fx = br._fixture_inputs_r72()
doc = br.build(fx, "2026-09-14T12:00:00Z")
w1, w2 = doc["weeks"]["1"], doc["weeks"]["2"]
games = {g["game_id"]: g for g in w1["games"]}
parlays = {p["parlay_id"]: p for p in w1["parlays"]}
`;

/* The exact rule scripts/refit._collect_resolved_rows("game") applies — counted
 * here from the FILES, independently of build_review, so the artifact cannot
 * agree with itself by construction. */
function gradedReceipts(dir, season) {
  let n = 0;
  for (const name of readdirSync(dir).sort()) {
    const m = /^(\d{4})_wk(\d{2})_games_open\.json$/.exec(name);
    if (!m || Number(m[1]) !== season) continue;
    const rows = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    for (const r of rows) {
      if (r.event_type === 'game' && r.resolved === true && r.estimate === false) n += 1;
    }
  }
  return n;
}

/* --------------------------------------------------- 1. right / wrong / tbd */

test('picks right/wrong/tbd: only FINAL grades; a zero-final week still gets its block', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps({"weeks": sorted(doc["weeks"]), "through": doc["review_through_week"],
  "p1": w1["summary"]["picks"], "p2": w2["summary"]["picks"],
  "graded1": sum(1 for g in w1["games"] if g["result"] in ("won", "lost")),
  "tie": [games["G8"]["result"], games["G8"]["final"]["winner"]],
  "g2": [(g["game_id"], g["picked"], g["result"], g["final"], g["status"]) for g in w2["games"]]}))`);
  assert.deepEqual(r.weeks, ['1', '2'], 'week 2 (on deck) is in; week 3 is beyond the pipeline week');
  assert.equal(r.through, 2);
  assert.deepEqual(r.p1, { n: 3, won: 2, pct: 0.6667, brier: r.p1.brier, right: 2, wrong: 1, tbd: 1 });
  assert.equal(r.p1.right + r.p1.wrong, r.graded1, 'right + wrong == graded picks');
  assert.equal(r.p1.right, r.p1.won, 'right is won');
  assert.deepEqual(r.tie, [null, null], 'a tie is FINAL but ungradable: not right, not wrong, not tbd');
  assert.deepEqual(r.p2, { n: 0, won: 0, pct: null, brier: null, right: 0, wrong: 0, tbd: 2 });
  assert.deepEqual(r.g2, [
    ['G5', 'AAA', null, null, 'STATUS_SCHEDULED'],
    ['G6', null, null, null, 'STATUS_SCHEDULED'],
  ], 'locked game keeps its as-made pick; no lock row -> picked null; both tbd');
});

test('pipeline week: current_week rule, +1 once underway, predictions week as a floor', () => {
  const r = runPy(`
import json
from scripts import build_review as br
sched = [{"game_id": "A", "week": 1, "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-13T17:00Z"},
         {"game_id": "B", "week": 2, "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-20T17:00Z"},
         {"game_id": "C", "week": 3, "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-27T17:00Z"}]
out = {
  "before_kickoff": br.pipeline_week(sched, None, "2026-09-10T12:00:00Z"),
  "after_kickoff": br.pipeline_week(sched, None, "2026-09-13T17:00:01Z"),
  "floor": br.pipeline_week(sched, 3, "2026-09-10T12:00:00Z"),
  "all_final": br.pipeline_week([dict(g, status="STATUS_FINAL") for g in sched], None, "2026-10-01T00:00:00Z"),
  "empty": br.pipeline_week([], None, "2026-09-10T12:00:00Z"),
  "weeks": br.review_weeks(sched, None, {}, [], "2026-09-13T17:00:01Z"),
}
print(json.dumps(out))`);
  assert.equal(r.before_kickoff, 1, 'nothing underway -> the current week only');
  assert.equal(r.after_kickoff, 2, 'week 1 kicked off -> week 2 is on deck');
  assert.equal(r.floor, 3, 'game_predictions.json week is a floor');
  assert.equal(r.all_final, 3, 'everything FINAL -> the last week');
  assert.equal(r.empty, null, 'no schedule, no predictions week -> null, never 0');
  assert.deepEqual(r.weeks, [1, 2]);
});

/* ---------------------------------------------------------- 2. buckets */

test('parlay buckets: every bucket from a real leg pattern; result <-> bucket consistent', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps({
  "rows": {k: [p["result"], p["bucket"], [l["result"] for l in p["legs"]]] for k, p in parlays.items()},
  "buckets": w1["summary"]["parlays"]["buckets"], "n": w1["summary"]["parlays"]["n"],
  "pure": [br.parlay_bucket(x) for x in ([], ["pending", "hit"], ["void", "void"], ["hit", "void"],
                                          ["hit", "hit"], ["miss", "miss"], ["miss", "void"],
                                          ["hit", "miss"], ["hit", "miss", "void"])],
  "table": br.BUCKET_OF_RESULT}))`);
  assert.deepEqual(r.rows, {
    'all-hit': ['hit', 'all_hit', ['hit', 'hit']],
    'partial': ['miss', 'partial', ['hit', 'miss']],
    'all-missed': ['miss', 'all_missed', ['miss', 'miss']],
    'push': ['void', 'push', ['hit', 'void']],
    'pending': ['pending', 'pending', ['hit', 'pending']],
    'missed-with-void': ['miss', 'all_missed', ['miss', 'void']],
  });
  assert.deepEqual(r.buckets, { all_hit: 1, push: 1, partial: 1, all_missed: 2, pending: 1 });
  assert.equal(Object.values(r.buckets).reduce((a, b) => a + b, 0), r.n, 'buckets sum to n');
  assert.deepEqual(r.pure, ['pending', 'pending', 'push', 'push', 'all_hit', 'all_missed',
    'all_missed', 'partial', 'partial']);
  assert.deepEqual(r.table, { hit: ['all_hit'], void: ['push'], miss: ['partial', 'all_missed'],
    pending: ['pending'] });
  for (const [, [result, bucket]] of Object.entries(r.rows)) {
    assert.ok(r.table[result].includes(bucket), `${result} <-> ${bucket}`);
  }
});

/* --------------------------------------------------- 3. players_season */

test('players_season tallies every week block; dnp is a graded row reporting null', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps(doc["players_season"]))`);
  assert.deepEqual(Object.keys(r), ['P1', 'P2', 'P3']);
  assert.deepEqual(r.P1, { name: 'Wide Receiver', position: 'WR', team: 'AAA', weeks: 2,
    over: 0, met: 1, under: 1, dnp: 0, met_rate: 0.5,
    by_week: { 1: { verdict: 'met', delta: -1.0, actual: 9.0, projected: 10.0 },
               2: { verdict: 'under', delta: -8.0, actual: 3.0, projected: 11.0 } } });
  assert.deepEqual(r.P2, { name: 'Running Back', position: 'RB', team: 'CCC', weeks: 2,
    over: 1, met: 1, under: 0, dnp: 0, met_rate: 0.5,
    by_week: { 1: { verdict: 'over', delta: 8.0, actual: 20.0, projected: 12.0 },
               2: { verdict: 'met', delta: -3.0, actual: 10.0, projected: 13.0 } } });
  assert.deepEqual(r.P3, { name: 'Quarter Back', position: 'QB', team: 'EEE', weeks: 1,
    over: 0, met: 0, under: 0, dnp: 1, met_rate: 0.0,
    by_week: { 1: { verdict: 'dnp', delta: null, actual: null, projected: 15.0 } } });
  for (const e of Object.values(r)) {
    assert.equal(e.over + e.met + e.under + e.dnp, e.weeks, 'verdicts conserve');
  }
});

/* ------------------------------------------------- 4. THE LEARNING LOCK */

test('learning lock (fixture): receipts from the lock files, newest in-season pass, consumed_all', () => {
  const fromFiles = gradedReceipts(FIXTURE_SNAPSHOTS, 2026);
  assert.equal(fromFiles, 2, 'fixture: G1 + G2 graded; G3 is an estimate receipt; 2025 file ignored');
  const r = runPy(`${PRELUDE}
import copy
lb = doc["learning"]
# a receipt graded after the last refit pass
fx2 = copy.deepcopy(fx); fx2["locks"][2][0].update({"resolved": True, "actual": 0, "brier": 0.2304, "log_loss": 0.6539})
lb2 = br.build(fx2, "2026-09-14T12:00:00Z")["learning"]
# the archive says adopted -> verdict adopted (and only then)
fx3 = copy.deepcopy(fx); fx3["tuning"]["history"][0]["adopted"] = True
lb3 = br.build(fx3, "2026-09-14T12:00:00Z")["learning"]
# no archive -> nothing claimed
fx4 = copy.deepcopy(fx); fx4["tuning"] = None
lb4 = br.build(fx4, "2026-09-14T12:00:00Z")["learning"]
# list order is not recency: move the newest pass to the end, same answer
fx5 = copy.deepcopy(fx); fx5["tuning"]["history"].append(fx5["tuning"]["history"].pop(0))
lb5 = br.build(fx5, "2026-09-14T12:00:00Z")["learning"]
print(json.dumps({"lb": lb, "lb2": lb2, "lb3": lb3["refit"], "lb4": lb4, "lb5": lb5["refit"],
  "wk1": w1["summary"]["learning"], "wk2": w2["summary"]["learning"],
  "receipts": [r["event_id"] for r in br.graded_lock_rows(fx["locks"][1])]}))`);
  assert.equal(r.lb.graded_locks_total, fromFiles, 'graded_locks_total == receipts counted from the files');
  assert.deepEqual(r.receipts, ['G1', 'G2'], 'refit rule: resolved AND estimate false');
  assert.deepEqual(r.lb.refit, { archived_utc: '2026-09-14T04:00:00Z', n_resolved: 2, adopted: false, verdict: 'held' },
    'newest in-season pass: not the backtest entry, not signal_promotion, not the n_resolved=0 pass');
  assert.equal(r.lb.consumed_all, true);
  assert.match(r.lb.note, /all 2 graded lock receipts were consumed/);
  assert.equal(r.lb2.graded_locks_total, 3);
  assert.equal(r.lb2.consumed_all, false, 'a receipt graded after the last pass -> not consumed');
  assert.match(r.lb2.note, /1 receipt\(s\) graded after the last refit pass/);
  assert.deepEqual(r.lb3, { archived_utc: '2026-09-14T04:00:00Z', n_resolved: 2, adopted: true, verdict: 'adopted' });
  assert.deepEqual(r.lb4, { graded_locks_total: 2, refit: null, consumed_all: null, note: r.lb4.note });
  assert.match(r.lb4.note, /no in-season refit pass yet/);
  assert.deepEqual(r.lb5, r.lb.refit, 'newest by generated_utc, not by position');
  assert.equal(r.wk1.graded_locks, 2);
  assert.deepEqual(r.wk1.refit, r.lb.refit);
  assert.deepEqual(r.wk2, { graded_locks: 0, refit: null,
    note: "no graded receipts in this week's lock file yet (1 rows pending)" });
});

test('learning lock (committed data): graded_locks_total derived from data/snapshots, never pinned', () => {
  assert.ok(existsSync(ARTIFACT), 'data/review.json is committed');
  const doc = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const fromFiles = gradedReceipts(SNAPSHOTS, doc.season);
  assert.equal(doc.learning.graded_locks_total, fromFiles,
    'graded_locks_total == resolved measured game rows under data/snapshots/*_games_open.json');
  const perWeek = Object.values(doc.weeks).reduce((a, b) => a + b.summary.learning.graded_locks, 0);
  assert.equal(perWeek, fromFiles, 'the per-week counts sum to the total');
  if (doc.learning.refit) {
    assert.equal(doc.learning.consumed_all, doc.learning.refit.n_resolved === fromFiles);
    assert.equal(doc.learning.refit.verdict, doc.learning.refit.adopted ? 'adopted' : 'held');
    // the refit line is the archive's newest in-season pass, re-derived here
    const tuning = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'model_tuning.json'), 'utf8'));
    let best = null;
    for (const h of tuning.history || []) {
      if (h && h.kind === 'game_params' && h.search != null && !('eval_seasons' in h)) {
        const n = Number(h.n_resolved);
        if (!Number.isFinite(n) || n <= 0) continue;
        if (!best || String(h.generated_utc || '') >= String(best.generated_utc || '')) best = h;
      }
    }
    assert.ok(best, 'a refit line in the artifact means the archive holds an in-season pass');
    assert.deepEqual(doc.learning.refit, { archived_utc: best.generated_utc, n_resolved: Number(best.n_resolved),
      adopted: best.adopted === true, verdict: best.adopted === true ? 'adopted' : 'held' });
  } else {
    assert.equal(doc.learning.consumed_all, null, 'no pass -> nothing claimed');
  }
  const w1 = doc.weeks['1'];
  assert.ok(w1, 'week 1 block exists');
  const graded = w1.games.filter((g) => g.result === 'won' || g.result === 'lost').length;
  assert.equal(w1.summary.picks.right + w1.summary.picks.wrong, graded, 'week 1: right + wrong == graded picks');
  assert.equal(w1.summary.picks.right, w1.summary.picks.won);
  assert.equal(w1.summary.picks.tbd, w1.games.filter((g) => g.final == null).length);
});

/* ---------------------------------------------------------- 5. artifact */

test('data/review.json: schema, JSON convention, week blocks through the pipeline week, buckets on every row', () => {
  const raw = readFileSync(ARTIFACT, 'utf8');
  const doc = JSON.parse(raw);
  const r = runPy(`
import json
from scripts import build_review as br
doc = json.load(open("data/review.json", encoding="utf-8"))
errs = br._validate_against_schema(doc)
raw = open("data/review.json", "rb").read()
canon = (json.dumps(doc, ensure_ascii=True, indent=2) + "\\n").encode("utf-8")
sched = json.load(open("data/schedule_full.json", encoding="utf-8"))["games"]
sched_weeks = sorted(set(int(g["week"]) for g in sched if int(g["week"]) <= (doc["review_through_week"] or 0)))
print(json.dumps({"errs": errs[:5], "canonical": raw == canon, "sched_weeks": sched_weeks}))`);
  assert.deepEqual(r.errs, []);
  assert.equal(r.canonical, true, 'ensure_ascii=True, indent=2, no sort_keys, trailing newline');
  for (const k of ['review_through_week', 'learning', 'players_season']) assert.ok(k in doc, k);
  assert.ok(Number.isInteger(doc.review_through_week) && doc.review_through_week >= 1);
  for (const wk of r.sched_weeks) {
    assert.ok(doc.weeks[String(wk)], `week ${wk} has a block (through ${doc.review_through_week})`);
  }
  for (const [wk, blk] of Object.entries(doc.weeks)) {
    const s = blk.summary;
    assert.deepEqual(Object.keys(s.picks), ['n', 'won', 'pct', 'brier', 'right', 'wrong', 'tbd']);
    assert.equal(s.picks.right, s.picks.won);
    assert.equal(s.picks.wrong, s.picks.n - s.picks.won);
    assert.deepEqual(Object.keys(s.parlays.buckets), ['all_hit', 'push', 'partial', 'all_missed', 'pending']);
    assert.equal(Object.values(s.parlays.buckets).reduce((a, b) => a + b, 0), s.parlays.n, `wk ${wk} buckets sum to n`);
    assert.ok('graded_locks' in s.learning && 'refit' in s.learning && 'note' in s.learning);
    for (const p of blk.parlays) {
      assert.ok(['all_hit', 'push', 'partial', 'all_missed', 'pending'].includes(p.bucket), p.parlay_id);
      const ok = { hit: ['all_hit'], void: ['push'], miss: ['partial', 'all_missed'], pending: ['pending'] };
      assert.ok(ok[p.result].includes(p.bucket), `${p.parlay_id}: ${p.result} <-> ${p.bucket}`);
      const legs = p.legs.map((l) => l.result);
      if (legs.length === 0 || legs.includes('pending')) assert.equal(p.bucket, 'pending');
    }
    for (const g of blk.games) {
      if (g.result == null) assert.equal(g.brier, null, 'no result -> no brier');
      if (g.picked == null) assert.equal(g.result, null, 'no lock row -> no result');
    }
    for (const p of blk.players) {
      const e = doc.players_season[p.gsis_id];
      assert.ok(e, `${p.gsis_id} in players_season`);
      assert.deepEqual(e.by_week[String(p.week)], { verdict: p.verdict, delta: p.delta, actual: p.actual, projected: p.projected });
    }
  }
  for (const e of Object.values(doc.players_season)) {
    assert.equal(e.over + e.met + e.under + e.dnp, e.weeks);
    assert.equal(e.weeks, Object.keys(e.by_week).length);
    assert.equal(e.met_rate, e.weeks ? Number((e.met / e.weeks).toFixed(4)) : null);
  }
});
