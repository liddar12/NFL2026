/* tests/feature/r71_review.test.mjs — locks for the R71 post-game review.
 *
 * What is locked, and why each is a lock rather than a description:
 *   1. STATUS GATING. Only a FINAL row with a score, or a graded lock receipt,
 *      produces a game result; a halftime row carrying a score and a 0-0
 *      scheduled stub grade nothing. The predicted team is the LOCK's probs.
 *   2. THE VERDICT RULE (owner decision): MET inside [low, high] inclusive,
 *      OVER above, UNDER below, DNP when no played row — and DNP reports null,
 *      never 0. A player-week without an estimate_scores row has no review row.
 *   3. ABSENT IS NULL. No finals -> scores null; no stat line -> the stat
 *      factors are omitted AND the row says so; nothing is guessed.
 *   4. THE ONE ADAPTER to partition C's R58 leg ledger reads exactly its
 *      resolved/unresolved shapes; hit/miss/pending/void follow the documented
 *      rules and the summary counts conserve.
 *   5. THE ARTIFACT. data/review.json validates against its inlined schema and
 *      is written in the repo's one JSON convention (smoke's QA-D9 check).
 *   6. THE APP LAYER. app/review.js is a lazy import from the views (never a
 *      static edge), reads only through loadJson, and renderPlayerReview emits
 *      the chip + measured why; the CSS is .rv-* only and the HIG block is scoped.
 *   7. NO MODEL IDS. The narrative layer takes its model name from the
 *      REVIEW_NARRATIVE_MODEL variable only, and skips loudly (exit 0) without it.
 *
 * Node built-ins only; python3 is already a fast-gate dependency (the pattern
 * is tests/feature/r51_weekly.test.mjs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACT = join(REPO_ROOT, 'data', 'review.json');

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
fx = br._fixture_inputs()
doc = br.build(fx, "2026-09-14T12:00:00Z")
wk = doc["weeks"]["1"]
games = {g["game_id"]: g for g in wk["games"]}
players = {p["gsis_id"]: p for p in wk["players"]}
parlays = {p["parlay_id"]: p for p in wk["parlays"]}
`;

/* ------------------------------------------------------------ 1. gating */

test('status gating: FINAL score or lock receipt grades; halftime and 0-0 stubs never', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps({k: {"result": g["result"], "final": g["final"], "src": g["final_source"],
                      "picked": g["picked"], "brier": g["brier"]} for k, g in games.items()}))`);
  assert.equal(r.G1.result, 'won');
  assert.deepEqual(r.G1.final, { home_score: 27, away_score: 7, winner: 'AAA' });
  assert.equal(r.G1.src, 'espn_final');
  assert.equal(r.G1.picked, 'AAA', 'the predicted team is argmax of the LOCK probs');
  assert.equal(r.G2.result, 'lost');
  assert.deepEqual(r.G2.final, { home_score: null, away_score: null, winner: 'DDD' },
    'a lock receipt knows the winner, not the score — score is null, never 0');
  assert.equal(r.G2.src, 'lock_receipt');
  // the finals fixture carries a 14-10 HALFTIME row and a 0-0 SCHEDULED row
  assert.equal(r.G3.result, null); assert.equal(r.G3.final, null); assert.equal(r.G3.brier, null);
  assert.equal(r.G4.result, null); assert.equal(r.G4.final, null);
});

test('finals_index drops every non-FINAL status and any row without both scores', () => {
  const r = runPy(`
import json
from scripts import build_review as br
rows = [
  {"game_id": "a", "status": "STATUS_FINAL", "home_score": 1, "away_score": 0},
  {"game_id": "b", "status": "STATUS_FINAL_OVERTIME", "home_score": 3, "away_score": 6},
  {"game_id": "c", "status": "STATUS_IN_PROGRESS", "home_score": 7, "away_score": 0},
  {"game_id": "d", "status": "STATUS_HALFTIME", "home_score": 7, "away_score": 7},
  {"game_id": "e", "status": "STATUS_SCHEDULED", "home_score": 0, "away_score": 0},
  {"game_id": "f", "status": "STATUS_FINAL", "home_score": None, "away_score": 3},
  {"game_id": "g", "final": True, "home_score": 2, "away_score": 2},
]
print(json.dumps(sorted(br.finals_index(rows))))`);
  assert.deepEqual(r, ['a', 'b', 'g']);
});

/* ------------------------------------------------------------ 2. verdicts */

test('verdict rule: inclusive band, DNP is null not 0, no row without an actual row', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps({
  "rules": [br.verdict_for(a, 5.0, 10.0) for a in (4.99, 5.0, 7.5, 10.0, 10.01)] + [br.verdict_for(None, 5.0, 10.0), br.verdict_for(0.0, 5.0, 10.0, dnp=True)],
  "rb": [players["fx-rb"]["verdict"], players["fx-rb"]["actual"], players["fx-rb"]["delta"]],
  "wr": [players["fx-wr"]["verdict"], players["fx-wr"]["actual"]],
  "te": [players["fx-te"]["verdict"], players["fx-te"]["actual"]],
  "qb": [players["fx-qb"]["verdict"], players["fx-qb"]["actual"]],
  "dnp": [players["fx-dnp"]["verdict"], players["fx-dnp"]["actual"], players["fx-dnp"]["delta"],
          players["fx-dnp"]["why"]["reasons"][0]["factor"], players["fx-dnp"]["why"]["reasons"][0]["points"]],
  "ids": sorted(players)}))`);
  assert.deepEqual(r.rules, ['under', 'met', 'met', 'met', 'over', 'dnp', 'dnp']);
  assert.deepEqual(r.rb, ['over', 19.9, 9.9]);
  assert.deepEqual(r.wr, ['met', 6.0], 'actual == low is MET');
  assert.deepEqual(r.te, ['met', 12.0], 'actual == high is MET');
  assert.deepEqual(r.qb, ['under', 4.1]);
  assert.deepEqual(r.dnp, ['dnp', null, null, 'availability', -10.0]);
  assert.ok(!r.ids.includes('fx-nostats'), 'a player without an estimate_scores row has no review row');
});

/* ------------------------------------------------------ 3. measured why */

test('measured why: factors ranked by |points|, numbers in every line, reconciles to the delta', () => {
  const r = runPy(`${PRELUDE}
w = players["fx-rb"]["why"]
num = [x for x in w["reasons"] if x["points"] is not None and x["factor"] != "model_factor"]
print(json.dumps({"source": w["source"], "order": [x["factor"] for x in w["reasons"]],
  "tds": next(x for x in w["reasons"] if x["factor"] == "touchdowns"),
  "sum": round(sum(x["points"] for x in num) + (w["unattributed"] or 0), 2),
  "delta": players["fx-rb"]["delta"], "basis": w["expected_basis"],
  "qb_omitted": players["fx-qb"]["why"]["omitted"],
  "qb_factors": [x["factor"] for x in players["fx-qb"]["why"]["reasons"]],
  "mf": next(x for x in w["reasons"] if x["factor"] == "model_factor")["factor_value"]}))`);
  assert.equal(r.source, 'measured');
  assert.equal(r.order[0], 'touchdowns');
  assert.equal(r.tds.points, 8.4);
  assert.match(r.tds.text, /2 rushing TD vs 0\.6 expected \(\+8\.4\)/);
  assert.equal(r.sum, r.delta, 'shown factors + unattributed == actual - projected');
  assert.match(r.basis, /season components x 0\.0500/);
  assert.ok(r.qb_omitted.some((s) => /stat line absent for this player-week/.test(s)),
    'no stat line -> stat factors omitted and SAID SO, never guessed');
  assert.ok(!r.qb_factors.includes('touchdowns'));
  assert.ok(r.mf > 1.0);
});

test('game why is measured: confidence, margin, QB1 status (no row != healthy), venue/forecast', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps({k: [x["factor"] + "|" + x["text"] for x in games[k]["why"]["reasons"]] for k in ("G1", "G2", "G3")}))`);
  assert.ok(r.G1.some((t) => t.startsWith('confidence|picked AAA at 60%')));
  assert.ok(r.G1.some((t) => /margin\|AAA won 27-7 \(home margin \+20, blowout\)/.test(t)));
  assert.ok(r.G1.some((t) => /qb1_home\|AAA QB1 Home Quarterback: Out/.test(t)));
  assert.ok(r.G1.some((t) => /qb1_away\|BBB QB1 Away Quarterback: no injury-report row/.test(t)));
  assert.ok(r.G1.some((t) => /venue_weather\|roof outdoor; forecast 10.0 C, wind 30.0 kph/.test(t)));
  assert.ok(r.G2.some((t) => /margin\|DDD won \(lock receipt; score not on file\)/.test(t)));
  assert.equal(r.G3.length, 1, 'an ungraded game carries only its confidence line');
});

/* --------------------------------------------------------- 4. parlays */

test('leg_outcomes_from_ledger reads C\'s resolved/unresolved shapes; parlay rules hold', () => {
  const r = runPy(`${PRELUDE}
oc = br.leg_outcomes_from_ledger(fx["leg_scores"])
print(json.dumps({
  "keys": sorted("|".join(map(str, k)) for k in oc),
  "spread": oc[(1, "G1", "spread", "AAA -3")], "prop": oc[(1, "G1", "rb_rush_yds", "R. Back 60+ rush yds")],
  "pend": oc[(1, "G2", "spread", "CCC -1")], "push": oc[(1, "G1", "spread", "BBB +20")],
  "empty": br.leg_outcomes_from_ledger(None),
  "res": {k: [p["result"], [l["result"] for l in p["legs"]]] for k, p in parlays.items()},
  "ml_why": parlays["week-1"]["legs"][0]["why"]}))`);
  assert.deepEqual(r.keys, ['1|G1|moneyline|AAA ML', '1|G1|rb_rush_yds|R. Back 60+ rush yds',
    '1|G1|spread|AAA -3', '1|G1|spread|BBB +20', '1|G2|spread|CCC -1']);
  assert.deepEqual(r.spread, { hit: true, actual: { home_score: 27, away_score: 7 }, reason: null });
  assert.deepEqual(r.prop, { hit: false, actual: 55.0, reason: null });
  assert.deepEqual(r.pend, { hit: null, actual: null, reason: 'no_final_score' });
  assert.deepEqual(r.push, { hit: null, actual: null, reason: 'push' });
  assert.deepEqual(r.empty, {});
  assert.deepEqual(r.res['G1-g1'], ['miss', ['hit', 'miss']]);
  assert.deepEqual(r.res['G1-g2'], ['hit', ['hit', 'hit']]);
  assert.deepEqual(r.res['week-1'], ['pending', ['hit', 'pending']], 'pending until every leg is graded');
  assert.deepEqual(r.res['week-2'], ['void', ['hit', 'void']], 'push/tie -> void once the rest graded');
  assert.deepEqual(r.res['G3-g1'], ['pending', ['pending', 'pending']]);
  assert.match(r.ml_why, /winner DDD \(lock_receipt\)/, 'a moneyline leg grades from the receipt directly');
});

/* ---------------------------------------------------------- 5. summary */

test('summary math conserves counts', () => {
  const r = runPy(`${PRELUDE}
print(json.dumps(wk["summary"]))`);
  // R72 added right/wrong/tbd to picks (right == won, wrong == n - won, tbd = no FINAL).
  assert.deepEqual(r.picks, { n: 2, won: 1, pct: 0.5, brier: r.picks.brier, right: 1, wrong: 1, tbd: 2 });
  const g2 = runPy(`${PRELUDE}
print(json.dumps(games["G2"]["brier"]))`);
  assert.equal(r.picks.brier, Number(((0.16 + g2) / 2).toFixed(4)), 'mean Brier over the graded picks only');
  assert.deepEqual(r.players, { n: 5, over: 1, under: 1, met: 2, dnp: 1, band_coverage: 0.5 });
  assert.equal(r.players.over + r.players.under + r.players.met + r.players.dnp, r.players.n);
  // R72 added the five outcome buckets (locked in r72_review_summary.test.mjs);
  // R73 added stake_100 (locked in r73_parlay_archive.test.mjs).
  assert.deepEqual(r.parlays, { n: 5, hit: 1, miss: 1, pending: 2, legs_n: 10, legs_hit: 5,
    buckets: r.parlays.buckets, stake_100: r.parlays.stake_100 });
});

/* --------------------------------------------------------- 6. artifact */

test('data/review.json validates against its inlined schema and the JSON convention', () => {
  assert.ok(existsSync(ARTIFACT), 'data/review.json is committed (scripts/build_review.py --offline)');
  const raw = readFileSync(ARTIFACT, 'utf8');
  const doc = JSON.parse(raw);
  const r = runPy(`
import json
from scripts import build_review as br
doc = json.load(open("data/review.json", encoding="utf-8"))
errs = br._validate_against_schema(doc)
raw = open("data/review.json", "rb").read()
canon = (json.dumps(doc, ensure_ascii=True, indent=2) + "\\n").encode("utf-8")
print(json.dumps({"errs": errs[:5], "canonical": raw == canon, "season": doc["season"]}))`);
  assert.deepEqual(r.errs, []);
  assert.equal(r.canonical, true, 'ensure_ascii=True, indent=2, no sort_keys, trailing newline');
  assert.equal(doc.season, r.season);
  for (const blk of Object.values(doc.weeks)) {
    for (const g of blk.games) {
      if (g.result) assert.ok(g.final && g.final.winner, 'a result always names a winner');
      else assert.equal(g.brier, null, 'no result -> no brier');
      if (g.final && g.final.home_score == null) assert.equal(g.final_source, 'lock_receipt');
    }
    for (const p of blk.players) {
      assert.equal(p.why.source, 'measured');
      if (p.verdict === 'dnp') assert.equal(p.actual, null);
      if (p.narrative) assert.equal(p.narrative.source, 'ai_narrative');
    }
  }
});

/* ------------------------------------------------------- 7. app layer */

const src = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

test('app/review.js is a lazy import from the views, never a static edge; fetch only via loadJson', () => {
  const slate = src('app/views/slate.js');
  const parlays = src('app/views/parlays.js');
  assert.match(slate, /import\('\.\.\/review\.js'\)/);
  assert.match(parlays, /import\('\.\.\/review\.js'\)/);
  assert.doesNotMatch(slate, /^import .*review\.js/m);
  assert.doesNotMatch(parlays, /^import .*review\.js/m);
  assert.doesNotMatch(src('app/main.js'), /review\.js/);
  const review = src('app/review.js');
  assert.match(review, /import \{ loadJson \} from '\.\/data\.js'/);
  assert.doesNotMatch(review, /\bfetch\s*\(/);
  assert.doesNotMatch(src('app/data.js'), /review/, 'data.js is untouched (not this partition\'s file)');
});

test('renderPlayerReview emits the verdict chip + measured why; nothing before the doc resolves', async () => {
  const fixtureDoc = runPy(`${PRELUDE}
print(json.dumps(doc))`);
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => fixtureDoc });
  try {
    const url = new URL(pathToFileURL(join(REPO_ROOT, 'app', 'review.js')).href);
    url.searchParams.set('t', String(Date.now()));
    const mod = await import(url.href);
    await mod.primeReview();
    await new Promise((r) => setTimeout(r, 0));
    const html = mod.renderPlayerReview('fx-rb', 1);
    assert.match(html, /class="rv-chip rv-chip--over">WK 1 OVER \+9\.9</);
    assert.match(html, /WHY · MEASURED/);
    assert.match(html, /2 rushing TD vs 0\.6 expected/);
    assert.doesNotMatch(html, /AI NARRATIVE/, 'no narrative on file -> no label, why still renders');
    assert.match(mod.renderPlayerReview('fx-dnp'), /rv-chip--dnp">WK 1 DNP</, 'week defaults to the latest reviewed week');
    assert.equal(mod.renderPlayerReview('fx-nostats', 1), '');
    const withNarr = mod.renderWhy({ source: 'measured', summary: 's', reasons: [] },
      { text: 'restated', source: 'ai_narrative', generated_utc: 't' }, { hidden: false });
    assert.match(withNarr, /<span class="rv-narr-label">AI NARRATIVE<\/span> <span class="rv-narr-text">restated<\/span>/);
    assert.equal(mod.renderReviewStrip(1, { picks: { n: 14, won: 9, brier: 0.2123 } }),
      '<div class="rv-strip" role="status" data-week="1">WK 1 REVIEW: 9/14 picks, Brier 0.21</div>');
    assert.equal(mod.renderReviewStrip(1, { picks: { n: 0, won: 0, brier: null } }), '', 'no result -> no strip');
    assert.equal(mod.playerReviewRow('fx-rb', 1, null), null, 'no document -> no row -> empty markup');
  } finally {
    globalThis.fetch = real;
  }
});

test('CSS: only .rv-* rules were added, and every HIG rule is scoped', () => {
  // the R71 block starts at the comment that carries the marker; drop every comment
  const block = (css) => {
    const i = css.indexOf('R71 — POST-GAME REVIEW');
    return i < 0 ? '' : css.slice(css.lastIndexOf('/*', i)).replace(/\/\*[\s\S]*?\*\//g, '');
  };
  const base = block(src('app/theme.css'));
  const hig = block(src('app/theme-hig.css'));
  assert.ok(base && hig, 'both additive blocks present');
  for (const m of base.matchAll(/^([^\n{}/*][^{}]*)\{/gm)) {
    for (const part of m[1].split(',')) assert.match(part.trim(), /\.rv-/, `theme.css rule not .rv-*: ${part}`);
  }
  for (const m of hig.matchAll(/^([^\n{}/*][^{}]*)\{/gm)) {
    for (const part of m[1].split(',')) {
      assert.match(part.trim(), /^\[data-theme="hig"\]/, `unscoped HIG rule: ${part}`);
      assert.match(part.trim(), /\.rv-/, `theme-hig.css rule not .rv-*: ${part}`);
    }
  }
  assert.doesNotMatch(base, /\.line-chip|\.p-unit/);
});

/* ---------------------------------------------------- 8. narrative layer */

test('narrative layer: no model id anywhere in R71 code, and it skips loudly without its env', () => {
  const files = ['scripts/build_review.py', 'scripts/build_review_narrative.py', 'app/review.js',
    'docs/POST_GAME_REVIEW.md', 'data/contracts/review.schema.json', 'tests/web/r71_review.spec.mjs'];
  for (const f of files) {
    assert.doesNotMatch(src(f), /claude-[a-z]+-\d/i, `${f} names a model id`);
  }
  assert.match(src('scripts/build_review_narrative.py'), /REVIEW_NARRATIVE_MODEL/);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.REVIEW_NARRATIVE_MODEL;
  const r = spawnSync('python3', ['scripts/build_review_narrative.py'], { cwd: REPO_ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SKIPPED/);
  assert.match(r.stdout, /ANTHROPIC_API_KEY/);
  // the committed artifact carries no narrative the runner never produced
  const doc = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  for (const blk of Object.values(doc.weeks)) {
    for (const row of [...blk.games, ...blk.players]) {
      if (row.narrative) assert.equal(row.narrative.source, 'ai_narrative');
    }
  }
});
