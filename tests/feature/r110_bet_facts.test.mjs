/* R110 (R99 E2) S1 — THE FACTS MY BETS GRADES WITH.
 *
 * The owner's bets live on the device (owner, 2026-10-04), so the pipeline cannot
 * grade them; it publishes data/bet_facts.json and the browser grades every leg
 * with app/bets.js. The record is only worth keeping if a leg grades the SAME in
 * the browser as in the pipeline's own record, so this file pins:
 *
 *   AC1  the document validates (schema + check_bet_facts) and the builder's
 *        selftest passes;
 *   AC2  status gating: only a FINAL game carries a score (a score is a pair,
 *        never beside a winner-only mark);
 *   AC3  parity: on one set of fixtures, Python's graders (grade_prop /
 *        grade_game / grade_atd) and the browser's gradeLeg over the facts agree
 *        leg for leg — and, once the runner has built the file, every graded
 *        MY and ATD leg on file regrades identically;
 *   wiring: daily and gameday build it right after the ATD resolver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { gradeLeg } from '../../app/bets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

test('AC1: the builder selftest passes and the contract is registered (optional, strict)', () => {
  execFileSync('python3', ['scripts/build_bet_facts.py', '--selftest'], { cwd: ROOT, stdio: 'pipe' });
  const r = py(`from scripts import validate_data as V
print(json.dumps({"reg": V.SCHEMA_TO_DATA.get("bet_facts.schema.json"), "opt": "bet_facts.json" in V.OPTIONAL_DATA}))`);
  assert.deepEqual(r, { reg: 'bet_facts.json', opt: true });
});

test('AC2: the validator reds on half a score, a score beside a winner, and a bad fact', () => {
  const r = py(`from scripts import validate_data as V
def red(doc):
    try:
        V.check_bet_facts(doc)
        return False
    except V.ValidationError:
        return True
ok = {"weeks": {"3": {"games": {"G": {"h": "A", "a": "B", "k": None, "hs": 1, "as": 0}},
                       "players": {"p": {"y": [1.0, 2.0, 3.0], "td": "dnp"}}}}}
print(json.dumps({
  "ok": red(ok),
  "half": red({"weeks": {"3": {"games": {"G": {"h": "A", "a": "B", "k": None, "hs": 1}}, "players": {}}}}),
  "both": red({"weeks": {"3": {"games": {"G": {"h": "A", "a": "B", "k": None, "hs": 1, "as": 0, "w": "home"}}, "players": {}}}}),
  "ystr": red({"weeks": {"3": {"games": {}, "players": {"p": {"y": "out", "td": None}}}}}),
  "ylen": red({"weeks": {"3": {"games": {}, "players": {"p": {"y": [1.0, 2.0], "td": None}}}}}),
  "wk": red({"weeks": {"30": {"games": {}, "players": {}}}}),
}))`);
  assert.deepEqual(r, { ok: false, half: true, both: true, ystr: true, ylen: true, wk: true });
});

/* One fixture, graded twice: by the pipeline's graders and by the browser over
 * the facts the builder writes from the same rows. */
const FIXTURE = `
from scripts import build_bet_facts as BF
from scripts import resolve_my_cards as RM, resolve_parlay_legs as RL
games = [{"game_id": "G1", "week": 3, "home": "AAA", "away": "BBB", "kickoff_utc": "2026-09-21T17:00Z"},
         {"game_id": "G2", "week": 3, "home": "CCC", "away": "DDD", "kickoff_utc": "2026-09-21T20:25Z"},
         {"game_id": "G3", "week": 3, "home": "EEE", "away": "FFF", "kickoff_utc": "2026-09-22T00:20Z"},
         {"game_id": "G4", "week": 3, "home": "GGG", "away": "HHH", "kickoff_utc": "2026-09-23T00:15Z"}]
finals = {"G1": {"home_score": 24, "away_score": 17}, "G2": {"winner": "away"},
          "G3": {"home_score": 20, "away_score": 20}}
idents = {"p1": {"name": "Al Pha", "team": "AAA", "position": "QB"},
          "p2": {"name": "Bo Ta", "team": "BBB", "position": "RB"},
          "p3": {"name": "Ce Da", "team": "AAA", "position": "WR"},
          "p4": {"name": "De Lt", "team": "CCC", "position": "TE"},
          "p5": {"name": "Ep Si", "team": "DDD", "position": "WR"},
          "p6": {"name": "Ze Ta", "team": "BBB", "position": "WR"}}
stats = {3: [{"name": "Al Pha", "norm": "al pha", "pos": "QB", "team": "AAA",
              "yards": {"QB": 251.0, "RB": 12.0, "WR": 0.0}},
             {"name": "Bo Ta", "norm": "bo ta", "pos": "RB", "team": "BBB",
              "yards": {"QB": 0.0, "RB": 88.0, "WR": 21.0}}]}
tds = {3: [{"norm": "al pha", "pos": "QB", "team": "AAA", "tds": 0},
           {"norm": "bo ta", "pos": "RB", "team": "BBB", "tds": 2},
           {"norm": "de lt", "pos": "TE", "team": "CCC", "tds": 1}]}
snaps = {3: {"teams": {"AAA", "BBB"},
             "rows": [{"norm": "al pha", "team": "AAA", "snaps": 60.0},
                      {"norm": "ce da", "team": "AAA", "snaps": 31.0},
                      {"norm": "bo ta", "team": "BBB", "snaps": 44.0}]}}
facts = BF.build(games, finals, idents, stats, tds, snaps, [], 2026, "t", "fixture")
def P(pid, market, line, pos):
    i = idents[pid]
    first, last = i["name"].split(" ", 1)
    kind = {"qb_pass_yds": "pass", "rb_rush_yds": "rush", "wr_rec_yds": "rec"}[market]
    return {"market": market, "selection": "%s. %s %d+ %s yds" % (first[0], last, int(line + 0.5), kind), "gsis_id": pid,
            "player": i["name"], "team": i["team"], "position": pos, "line": line}
def T(pid):
    i = idents[pid]
    return {"market": "anytime_td", "selection": i["name"] + " ATD", "gsis_id": pid,
            "player": i["name"], "team": i["team"], "position": i["position"]}
legs = [P("p1", "qb_pass_yds", 224.5, "QB"), P("p1", "qb_pass_yds", 274.5, "QB"),
        P("p2", "rb_rush_yds", 59.5, "RB"), P("p3", "wr_rec_yds", 19.5, "WR"),
        P("p5", "wr_rec_yds", 39.5, "WR"), P("p6", "wr_rec_yds", 29.5, "WR"),
        T("p1"), T("p2"), T("p4"), T("p5"), T("p6"),
        {"market": "moneyline", "selection": "AAA ML", "game_id": "G1", "team": "AAA", "side": "home"},
        {"market": "moneyline", "selection": "BBB ML", "game_id": "G1", "team": "BBB", "side": "away"},
        {"market": "spread", "selection": "AAA -7", "game_id": "G1", "team": "AAA", "side": "home"},
        {"market": "spread", "selection": "AAA -3.5", "game_id": "G1", "team": "AAA", "side": "home"},
        {"market": "spread", "selection": "BBB +6.5", "game_id": "G1", "team": "BBB", "side": "away"},
        {"market": "moneyline", "selection": "DDD ML", "game_id": "G2", "team": "DDD", "side": "away"},
        {"market": "spread", "selection": "DDD -2.5", "game_id": "G2", "team": "DDD", "side": "away"},
        {"market": "moneyline", "selection": "EEE ML", "game_id": "G3", "team": "EEE", "side": "home"},
        {"market": "moneyline", "selection": "GGG ML", "game_id": "G4", "team": "GGG", "side": "home"}]
out = []
for l in legs:
    m = l["market"]
    if m in RM.GAME_MARKETS:
        r = RM.grade_game(l, finals)
    elif m == RM.ATD_MARKET:
        r = RL.grade_atd(l, 3, tds, snaps)
    else:
        r = RM.grade_prop(l, 3, stats, snaps)
    out.append(r[0])
print(json.dumps({"facts": facts, "legs": legs, "py": out}))`;

test('AC3: the browser grades every fixture leg exactly as the pipeline does', () => {
  const r = py(FIXTURE);
  const js = r.legs.map((l) => gradeLeg({ week: 3, ...l }, r.facts).result);
  assert.deepEqual(js, r.py);
  // and the fixture really spans every outcome, so the agreement means something
  for (const want of ['hit', 'miss', 'void', 'pending']) assert.ok(r.py.includes(want), want);
});

test('AC3: an excluded game voids its legs; a week with no facts is pending', () => {
  const facts = { excluded: ['G1'], weeks: { 3: { games: { G1: { h: 'AAA', a: 'BBB', k: null, hs: 3, as: 0 } }, players: {} } } };
  assert.equal(gradeLeg({ week: 3, market: 'moneyline', selection: 'AAA ML', game_id: 'G1', side: 'home' }, facts).result, 'void');
  assert.equal(gradeLeg({ week: 3, market: 'moneyline', selection: 'AAA ML', side: 'home' }, facts).result, 'void',
    'a week leg with no game id is matched to its game by team, then voided');
  assert.equal(gradeLeg({ week: 5, market: 'moneyline', selection: 'AAA ML', side: 'home' }, facts).result, 'pending');
  assert.equal(gradeLeg({ week: 3, market: 'moneyline', selection: 'AAA ML', side: 'home' }, null).result, 'pending');
});

const HAS_FACTS = existsSync(join(ROOT, 'data/bet_facts.json'));

test('AC3: every graded MY and ATD leg on file regrades identically from data/bet_facts.json', { skip: !HAS_FACTS && 'first runner build pending' }, () => {
  const facts = read('data/bet_facts.json');
  const weeksWithFacts = new Set(Object.keys(facts.weeks));
  const check = (scoreDoc, recordPath) => {
    let n = 0;
    const bad = [];
    const recs = new Map();
    for (const g of scoreDoc.cards || []) {
      if (!weeksWithFacts.has(String(g.week))) continue;
      const path = recordPath(g);
      if (!recs.has(path)) recs.set(path, existsSync(join(ROOT, path)) ? new Map(read(path).cards.map((c) => [c.card_id, c])) : new Map());
      const rec = recs.get(path).get(g.card_id);
      if (!rec) continue;
      for (const sl of g.legs) {
        const leg = rec.legs.find((l) => l.selection === sl.selection && l.market === sl.market);
        if (!leg) continue;
        n += 1;
        const got = gradeLeg({ week: g.week, ...leg }, facts).result;
        // the facts may be NEWER than the score file (a later stat line), never older
        if (got !== sl.result && !(sl.result === 'pending')) bad.push(`${g.week} ${sl.selection}: py ${sl.result} js ${got}`);
      }
    }
    return { n, bad };
  };
  const wk = (w) => `2026_wk${String(w).padStart(2, '0')}.json`;
  const my = check(read('data/my_card_scores.json'), (g) => `data/my_cards/${wk(g.week)}`);
  const dirs = { week: 'atd_cards', game: 'atd_game_cards', my: 'atd_my_cards' };
  const atd = check(read('data/atd_card_scores.json'), (g) => `data/${dirs[g.scope]}/${wk(g.week)}`);
  assert.ok(my.n > 0, 'graded MY legs exist to compare');
  assert.deepEqual(my.bad.slice(0, 10), [], `MY legs disagree (${my.bad.length})`);
  assert.deepEqual(atd.bad.slice(0, 10), [], `ATD legs disagree (${atd.bad.length})`);
});

test('wiring: daily and gameday build the facts right after the ATD resolver, continue-on-error', () => {
  for (const wf of ['daily', 'gameday']) {
    const y = readFileSync(join(ROOT, `.github/workflows/${wf}.yml`), 'utf8');
    const atd = y.indexOf('scripts/resolve_atd_cards.py');
    const bf = y.indexOf('python3 scripts/build_bet_facts.py');
    assert.ok(atd > 0 && bf > atd, `${wf}: build_bet_facts runs after the ATD resolver`);
    assert.match(y.slice(bf, bf + 200), /continue-on-error: true/, `${wf}: a stats outage never fails the run`);
  }
});
