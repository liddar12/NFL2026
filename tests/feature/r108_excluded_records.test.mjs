/* R108 — THE OWNER'S EXCLUDED GAMES, RECORD SIDE (graders + UI).
 *
 * Owner, 2026-10-04: "Update all the parlays for week 4, so that the Colts vs
 * Washington game is not included in any bets." config/excluded_games.json lists
 * the game (401872965, IND @ WAS, the London game). Chosen rule, locked here:
 *
 *   1. In every RECORDED card a leg of an excluded game is VOID — decided before
 *      any other grading — and the card settles on its remaining legs: a void leg
 *      drops out at decimal 1.0, so hit + excluded = push (paid on the hit legs
 *      alone) and miss + excluded = loss.
 *   2. A card made ONLY of excluded legs is not a bet: no review row (listed in
 *      the week's `excluded_cards` instead), no MY / ATD graded row, no pending
 *      count, no bucket, no $100 — and the MY / ATD documents count them in a
 *      top-level `excluded`.
 *   3. The PARLAYS view leaves a listed card off the list (archived week and
 *      current week): app/review.js matches an archived card by its card_id and
 *      a parlays.json card (no stamp) by the archive writer's own id rule.
 *
 * The learning records (parlay_leg_scores.json, calibration, the estimate
 * ledger) are deliberately not touched: the game's outcomes are real data.
 * Synthetic inputs only; nothing under data/ is written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', input: `import json, sys\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

/* ------------------------------------------------------------ 1. the review */

test('review: an excluded leg is void before grading; hit+excluded = push, miss+excluded = loss', () => {
  const r = py(`
from scripts import build_review as br
# G1 = BBB @ AAA (AAA won 27-7, FINAL), G2 = DDD @ CCC (DDD won). G1 is excluded.
games = {"G1": {"final": {"winner": "AAA"}, "final_source": "espn_final"},
         "G2": {"final": {"winner": "DDD"}, "final_source": "lock_receipt"}}
by_team = {"AAA": {"game_id": "G1"}, "BBB": {"game_id": "G1"},
           "CCC": {"game_id": "G2"}, "DDD": {"game_id": "G2"}}
# the leg ledger GRADED the G1 leg a hit: the exclusion must win over it
oc = {(4, "G1", "moneyline", "AAA ML"): {"hit": True, "actual": "AAA", "reason": None}}
leg = lambda sel: {"market": "moneyline", "selection": sel}
def rv(legs, excluded):
    row = br.review_parlay({"parlay_id": "p", "scope": "week", "legs": legs}, 4, oc, {},
                           by_team, games, None, excluded)
    return {"legs": [[l["result"], l["actual"], l["why"]] for l in row["legs"]],
            "result": row["result"], "bucket": row["bucket"],
            "full": br.fully_excluded(row, excluded)}
print(json.dumps({
  "push": rv([leg("AAA ML"), leg("DDD ML")], {"G1"}),
  "loss": rv([leg("AAA ML"), leg("CCC ML")], {"G1"}),
  "full": rv([leg("AAA ML"), leg("BBB ML")], {"G1"}),
  "none": rv([leg("AAA ML"), leg("DDD ML")], set()),
  "why": br.EXCLUDED_WHY}))`);
  assert.deepEqual(r.push.legs[0], ['void', null, r.why], 'void, actual null, why says owner');
  assert.equal(r.why, 'excluded game (owner)');
  assert.deepEqual([r.push.result, r.push.bucket], ['void', 'push'], 'settles on the hit leg');
  assert.deepEqual([r.loss.result, r.loss.bucket], ['miss', 'all_missed'], 'the other leg missed: loss');
  assert.equal(r.full.full, true, 'every leg excluded -> the card is fully excluded');
  assert.equal(r.push.full, false, 'a card with a live leg is not');
  assert.deepEqual([r.none.result, r.none.legs[0][0]], ['hit', 'hit'], 'no list -> graded as before');
});

test('review: a fully excluded card has no row, is listed in excluded_cards, and is in no count or stake', () => {
  const r = py(`
import json as _j
from scripts import build_review as br
fx = br._fixture_inputs()
fx["parlays"] = _j.loads(_j.dumps(fx["parlays"]))
leg = lambda sel: {"market": "moneyline", "selection": sel}
fx["parlays"]["parlays"] += [
  {"parlay_id": "x-hit", "scope": "week", "legs": [leg("AAA ML"), leg("DDD ML")]},
  {"parlay_id": "x-miss", "scope": "week", "legs": [leg("BBB ML"), leg("CCC ML")]}]
now = "2026-09-14T12:00:00Z"
base = br.build(fx, now)["weeks"]["1"]
fx["excluded_games"] = ["G1"]
doc = br.build(fx, now)
w = doc["weeks"]["1"]
ids = {p["parlay_id"]: p["card_id"] for p in base["parlays"]}
rows = {p["parlay_id"]: p for p in w["parlays"]}
print(json.dumps({
  "schema_errors": br._validate_against_schema(doc),
  "base_has_field": "excluded_cards" in base,
  "excluded_cards": w.get("excluded_cards"),
  "expect": sorted(ids[k] for k in ("G1-g1", "G1-g2", "week-2")),
  "row_ids": sorted(rows),
  "base_n": base["summary"]["parlays"]["n"], "n": w["summary"]["parlays"]["n"],
  "buckets": w["summary"]["parlays"]["buckets"],
  "base_game": base["summary"]["parlays"]["stake_100"]["game"],
  "game": w["summary"]["parlays"]["stake_100"]["game"],
  "week": w["summary"]["parlays"]["stake_100"]["week"],
  "x_hit": [rows["x-hit"]["bucket"], rows["x-hit"]["money"]],
  "x_miss": [rows["x-miss"]["bucket"], rows["x-miss"]["money"]["net_fair"]],
  "assumed": br.ASSUMED_DECIMAL,
  "note": [n for n in doc["notes"] if "R108" in n]}))`);
  assert.deepEqual(r.schema_errors, [], 'the R108 field is declared in review.schema.json');
  assert.equal(r.base_has_field, false, 'nothing excluded -> no field at all (no churn)');
  assert.deepEqual(r.excluded_cards, r.expect, 'game- AND week-scope cards of only G1, by card_id');
  for (const gone of ['G1-g1', 'G1-g2', 'week-2']) assert.ok(!r.row_ids.includes(gone), gone);
  assert.equal(r.n, r.base_n - 3, 'summary.parlays.n drops the three cards');
  assert.equal(Object.values(r.buckets).reduce((a, b) => a + b, 0), r.n, 'buckets sum to the kept rows');
  // both G1 game cards were GRADED (a hit and a partial) — staked before, gone now
  assert.equal(r.base_game.graded, 2);
  assert.deepEqual([r.game.n, r.game.graded, r.game.staked, r.game.net_fair], [1, 0, 0, null]);
  const pushPay = Math.round(100 * (r.assumed - 1) * 100) / 100;
  assert.deepEqual(r.x_hit, ['push', { kind: 'settled', net_fair: pushPay,
    net_vig2: r.x_hit[1].net_vig2, assumed_price_legs: 2 }], 'paid on the remaining leg at 1.0 for the void');
  assert.deepEqual(r.x_miss, ['all_missed', -100]);
  assert.deepEqual([r.week.graded, r.week.push], [2, 1]);
  assert.equal(r.week.net_fair, Math.round((pushPay - 100) * 100) / 100, 'the footer is the kept rows only');
  assert.equal(r.note.length, 1);
  assert.match(r.note[0], /3 card\(s\) made only of excluded legs dropped/);
});

test('review: load_inputs reads the owner list; validate_data contract accepts a listed week', () => {
  const r = py(`
from scripts import build_review as br, excluded_games
from scripts import validate_data as vd
inp = br.load_inputs(offline=True)
schema = json.load(open("data/contracts/review.schema.json"))
errs = []
vd._validate({"season": 2026, "generated_utc": "t", "review_through_week": 4, "sources": {},
              "notes": [], "players_season": {},
              "learning": {"graded_locks_total": 0, "refit": None, "consumed_all": None, "note": "n"},
              "weeks": {}}, schema, "review", errs)
blk = schema["properties"]["weeks"]["additionalProperties"]["properties"]["excluded_cards"]
bad = []
vd._validate([1], blk, "x", bad)
print(json.dumps({"inputs": inp["excluded_games"], "config": sorted(excluded_games.excluded_ids()),
                  "errs": errs, "bad": bool(bad)}))`);
  assert.deepEqual(r.inputs, r.config, 'the review grades against config/excluded_games.json');
  assert.ok(r.config.includes('401872965'), 'IND @ WAS, week 4');
  assert.deepEqual(r.errs, []);
  assert.equal(r.bad, true, 'excluded_cards holds card_id strings, nothing else');
});

/* -------------------------------------------------------------- 2. MY cards */

test('MY: grade_card voids the excluded leg before the graders; score drops an all-excluded card', () => {
  const r = py(`
from scripts import resolve_my_cards as R
from scripts.build_review import ASSUMED_DECIMAL
rows = R._fixture_rows()
by_week = R.index_stats(R._fixture_stats())
finals = {"g1": {"home_score": 24, "away_score": 17}}
xml = R._leg("moneyline", "XXX ML", game_id="gX", team="XXX", side="home", implied_prob=0.5,
             price_source="fair_market")
xsp = R._leg("spread", "YYY +3.5", game_id="gX", team="YYY", side="away", implied_prob=0.5,
             price_source="fair_market")
hen, low = rows[0][1]["legs"][0], rows[1][1]["legs"][1]
x = [(1, R._card("xhit00000001", "even", [hen, xml])),
     (1, R._card("xmis00000001", "even", [low, xml])),
     (1, R._card("xall00000001", "safe", [xml, xsp]))]
g = R.grade_card(x[0][1], 1, by_week, finals, excluded={"gX"})
w0, g0 = R.score(rows, by_week, finals, excluded={"gX"})
w1, g1 = R.score(rows + x, by_week, finals, excluded={"gX"})
by = {r["card_id"]: r for r in g1}
print(json.dumps({
  "legs": [[l["result"], l["actual"]] for l in g["legs"]], "res": [g["result"], g["bucket"]],
  "money": g["money"], "push_pay": round(100 * (ASSUMED_DECIMAL - 1), 2),
  "miss": [by["xmis00000001"]["result"], by["xmis00000001"]["bucket"], by["xmis00000001"]["money"]["net_fair"]],
  "all_in_rows": "xall00000001" in by,
  "w0": {k: w0[0][k] for k in ("n_cards", "locked", "graded", "pending")},
  "w1": {k: w1[0][k] for k in ("n_cards", "locked", "graded", "pending")},
  "safe0": w0[0]["by_dial"]["safe"]["n"], "safe1": w1[0]["by_dial"]["safe"]["n"],
  "buckets_sum": sum(w1[0]["buckets"].values()), "only": R.score(x[2:], by_week, finals, excluded={"gX"})}))`);
  assert.deepEqual(r.legs, [['hit', 74.0], ['void', null]], 'excluded leg void, actual null');
  assert.deepEqual(r.res, ['void', 'push'], 'hit + excluded = push');
  assert.equal(r.money.net_fair, r.push_pay, 'paid on the hit prop alone, the void leg at 1.0');
  assert.deepEqual(r.miss, ['miss', 'all_missed', -100], 'miss + excluded = loss');
  assert.equal(r.all_in_rows, false, 'an all-excluded card is never a graded row');
  assert.deepEqual(r.w1, { n_cards: r.w0.n_cards + 2, locked: r.w0.locked + 2,
    graded: r.w0.graded + 2, pending: r.w0.pending }, 'only the two partial cards join any count');
  assert.equal(r.safe1, r.safe0, 'the all-excluded safe card is in no dial block');
  assert.equal(r.buckets_sum, r.w1.locked, 'buckets still sum to the locked cards');
  assert.deepEqual(r.only, [[], []], 'a week of nothing but excluded cards has no block');
});

test('MY: run() applies the owner list and reports the dropped count in "excluded" (schema-valid)', () => {
  const r = py(`
import os, tempfile
from scripts import resolve_my_cards as R, excluded_games
from scripts import validate_data as vd
gid = sorted(excluded_games.excluded_ids())[0]
d = tempfile.mkdtemp()
xl = lambda sel, side: R._leg("moneyline", sel, game_id=gid, side=side, team=sel[:3])
cards = [R._card("aaaaaaaaaaa1", "even", [xl("IND ML", "away"), xl("WAS ML", "home")]),
         R._card("aaaaaaaaaaa2", "even", [xl("IND ML", "away"), R._fixture_rows()[0][1]["legs"][0]]),
         R._card("aaaaaaaaaaa3", "even", [xl("WAS ML", "home"), xl("IND ML", "away")], locked=False)]
json.dump({"season": 2026, "week": 4, "cards": cards}, open(os.path.join(d, "2026_wk04.json"), "w"))
out = os.path.join(d, "out.json")
doc = R.run(season=2026, cards_dir=d, out_path=out, offline=True, now="t")
schema = json.load(open("data/contracts/my_card_scores.schema.json"))
errs = []
vd._validate(doc, schema, "my_card_scores", errs)
print(json.dumps({"excluded": doc["excluded"], "weeks": doc["weeks"], "errs": errs,
                  "written": json.load(open(out))["excluded"]}))`);
  assert.equal(r.excluded, 2, 'both all-excluded cards (locked or not) are dropped and counted');
  assert.equal(r.written, 2);
  assert.equal(r.weeks.length, 1);
  assert.deepEqual([r.weeks[0].n_cards, r.weeks[0].locked], [1, 1], 'only the partial card is counted');
  assert.deepEqual(r.errs, [], 'my_card_scores.schema.json declares "excluded"');
});

/* -------------------------------------------------------------- 3. ATD cards */

test('ATD: an excluded leg voids like a did-not-play in every mode; an all-excluded card is dropped and counted', () => {
  const r = py(`
import os, tempfile
from scripts import resolve_atd_cards as A, excluded_games
from scripts.resolve_parlay_legs import index_td
from scripts import validate_data as vd
td = index_td([{"player_display_name": "Alpha Back", "position": "RB", "team": "LA", "week": "3",
                "season_type": "REG", "rushing_tds": "1", "receiving_tds": "0"},
               {"player_display_name": "Beta Wide", "position": "WR", "team": "SF", "week": "3",
                "season_type": "REG", "rushing_tds": "0", "receiving_tds": "0"}])
leg = lambda name, team, gid: {"market": "anytime_td", "selection": name + " anytime TD",
    "player": name, "team": team, "game_id": gid, "model_prob": 0.5, "position": "RB", "side": "home"}
card = lambda cid, mode, legs: {"card_id": cid, "mode": mode, "n_legs": len(legs),
                                "model_prob": 0.5 ** len(legs), "legs": legs}
rec = {"season": 2026, "week": 3, "cards": [
  card("hitx", "all_td", [leg("Alpha Back", "LAR", "g1"), leg("Gone", "IND", "gX")]),
  card("misx", "majority_td", [leg("Beta Wide", "SF", "g2"), leg("Gone", "IND", "gX")]),
  card("s50x", "scorers_50", [leg("Alpha Back", "LAR", "g1"), leg("Gone", "IND", "gX")]),
  card("allx", "all_td", [leg("Gone", "IND", "gX"), leg("Also Gone", "WAS", "gX")])]}
rows, pending = A.grade_records([rec], {}, {}, {"td": td, "snaps": None}, excluded={"gX"})
# the did-not-play void, for comparison: Alpha Back's partner on a published snap
# sheet he is absent from
snaps = {3: {"teams": {"NE"}, "rows": [{"norm": "someone else", "team": "NE", "snaps": 50.0}]}}
dnp_rec = {"season": 2026, "week": 3, "cards": [
  card("hitd", "all_td", [leg("Alpha Back", "LAR", "g1"), leg("Gone Player", "NE", "g3")])]}
dnp_rows, _ = A.grade_records([dnp_rec], {}, {}, {"td": td, "snaps": snaps}, excluded=set())
# run(): every recorded directory, the owner list, the count, the contract
gid = sorted(excluded_games.excluded_ids())[0]
d = tempfile.mkdtemp()
for sub in ("w", "g", "m"):
    os.makedirs(os.path.join(d, sub))
own = {"season": 2026, "week": 4, "cards": [
  card("o1", "all_td", [leg("Jonathan Taylor", "IND", gid), leg("Terry McLaurin", "WAS", gid)]),
  card("o2", "all_td", [leg("Jonathan Taylor", "IND", gid), leg("Derrick Henry", "BAL", "g9")])]}
json.dump(own, open(os.path.join(d, "w", "2026_wk04.json"), "w"))
json.dump(dict(own, cards=own["cards"][:1]), open(os.path.join(d, "g", "2026_wk04.json"), "w"))
A.RECORD_GLOB = os.path.join(d, "w", "*_wk*.json")
A.GAME_RECORD_GLOB = os.path.join(d, "g", "*_wk*.json")
A.MY_RECORD_GLOB = os.path.join(d, "m", "*_wk*.json")
doc = A.run(out_path=os.path.join(d, "out.json"), now="t", offline=True)
errs = []
vd._validate(doc, json.load(open("data/contracts/atd_card_scores.schema.json")), "atd", errs)
print(json.dumps({"rows": {r["card_id"]: [r["result"], [l["result"] for l in r["legs"]]] for r in rows},
                  "pending": pending, "summary": A.summarize(rows),
                  "dnp": [[r["result"], [l["result"] for l in r["legs"]]] for r in dnp_rows],
                  "doc": {k: doc[k] for k in ("excluded", "pending", "graded")}, "errs": errs}))`);
  // every mode: the excluded leg is void, the card settles on the rest
  assert.deepEqual(r.rows.hitx, ['void', ['hit', 'void']], 'all_td: hit + excluded = void, never a hit');
  assert.deepEqual(r.rows.misx, ['miss', ['miss', 'void']], 'majority_td: miss + excluded = miss');
  assert.deepEqual(r.rows.s50x, ['void', ['hit', 'void']], 'scorers_50: same rule');
  assert.equal(r.rows.allx, undefined, 'the all-excluded card has no row');
  assert.equal(r.pending, 0, '... and is not pending either');
  assert.deepEqual(r.dnp, [['void', ['hit', 'void']]], 'exactly what a did-not-play void yields');
  assert.equal(r.summary.all_td['2'].hits, 0, 'a void card is graded but never counted a hit');
  // run(): two week cards + one game card are all-excluded; o2 stays (pending offline)
  assert.deepEqual(r.doc, { excluded: 2, pending: 1, graded: 0 });
  assert.deepEqual(r.errs, [], 'atd_card_scores.schema.json declares "excluded"');
});

/* ------------------------------------------------------------------ 4. UI */

async function loadReview(doc) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => doc });
  try {
    const url = new URL(pathToFileURL(join(ROOT, 'app', 'review.js')).href);
    url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
    const mod = await import(url.href);
    await mod.primeReview();
    return mod;
  } finally {
    globalThis.fetch = real;
  }
}

test('UI: excludedCardIds / withoutExcludedCards / excludedCards hide exactly the listed cards', async () => {
  const cards = [
    { parlay_id: '401872965-g1', scope: 'game', game_id: '401872965',
      legs: [{ market: 'moneyline', selection: 'IND ML' }, { market: 'rb_rush_yds', selection: 'J. Taylor 60+ rush yds' }] },
    { parlay_id: 'week-2leg-1', scope: 'week',
      legs: [{ market: 'moneyline', selection: 'MIN ML' }, { market: 'moneyline', selection: 'IND ML' }] },
    { parlay_id: '401872966-g1', card_id: 'feedfacecafe', scope: 'game', game_id: '401872966',
      legs: [{ market: 'moneyline', selection: 'ARI ML' }, { market: 'spread', selection: 'SEA -3.5' }] },
  ];
  // the Python archive writer's ids for the two unstamped cards (the rule the
  // client must reproduce for a parlays.json card)
  const ids = py(`
from scripts.build_parlay_archive import card_id, card_identity
cards = json.loads(${JSON.stringify(JSON.stringify(cards))})
print(json.dumps({"ids": [card_id(c) for c in cards[:2]], "identity": card_identity(cards[0])}))`);
  const doc = { weeks: { 4: { parlays: [], excluded_cards: [ids.ids[0], 'feedfacecafe'] }, 3: { parlays: [] } } };
  const m = await loadReview(doc);
  assert.deepEqual([...m.excludedCardIds(4)].sort(), [ids.ids[0], 'feedfacecafe'].sort());
  assert.equal(m.excludedCardIds(3).size, 0, 'a week listing none hides nothing');
  assert.equal(m.excludedCardIds(9).size, 0, 'an unknown week hides nothing');
  assert.equal(m.excludedCardIds(4, null).size, 0, 'no document hides nothing');
  assert.equal(m.cardIdentity(cards[0]), ids.identity, 'identity mirrors build_parlay_archive');
  assert.equal(await m.cardIdOf(cards[0]), ids.ids[0], 'an unstamped card is hashed the archive way');
  assert.equal(await m.cardIdOf(cards[1]), ids.ids[1]);
  assert.equal(await m.cardIdOf(cards[2]), 'feedfacecafe', 'a stamped card keeps its own id');
  // pure filter by the card's own stamp (an archived week)
  assert.deepEqual(m.withoutExcludedCards(cards, m.excludedCardIds(4)).map((c) => c.parlay_id),
    ['401872965-g1', 'week-2leg-1'], 'the stamped excluded card is gone; unstamped ones need the hash');
  assert.equal(m.withoutExcludedCards(cards, new Set()), cards, 'nothing listed -> the same array');
  // async, as the view calls it: stamped AND unstamped cards matched
  const gone = await m.excludedCards(cards, 4);
  assert.deepEqual(gone.map((c) => c.parlay_id), ['401872965-g1', '401872966-g1']);
  assert.deepEqual(await m.excludedCards(cards, 3), []);
});

test('UI: the PARLAYS view filters the painted list, leg chips and tier chips through the hidden set', () => {
  const view = src('app/views/parlays.js');
  assert.match(view, /mod\.excludedCards\(list, week\)/, 'paintReview asks review.js for the week');
  assert.match(view, /const visible = \(\) => parlays\.filter\(\(p\) => !hiddenCards\.has\(p\)\)/);
  for (const fn of ['legCountsForScope', 'tiersForScope', 'paintList']) {
    const body = view.slice(view.indexOf(`function ${fn}(`), view.indexOf(`function ${fn}(`) + 400);
    assert.match(body, /visible\(\)\.filter\(/, `${fn} reads the visible cards`);
  }
  assert.doesNotMatch(view, /^import .*review\.js/m, 'review.js stays a lazy import');
});
