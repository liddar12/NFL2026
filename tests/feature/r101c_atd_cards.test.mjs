/* tests/feature/r101c_atd_cards.test.mjs — R101c: WEEK + MY anytime-TD modes.
 *
 * Owner (2026-09-24): each parlay section up to 10 legs, with ALL TD / MAJORITY
 * TD / 50%+ SCORERS; Gate 2 layout B (TD pills + a 2–10 leg stepper, iPhone).
 * Locked here:
 *   builder (scripts/build_atd_cards.py): one leg per game, games that have
 *     kicked off excluded, card chance = product of the pool's own leg prices,
 *     each mode's rule, an unfillable size REFUSED with its reason, nothing on a
 *     model that is not adopted, first sight recorded exactly once;
 *   validator (check_atd_cards): each violation refused on its own;
 *   grader (resolve_atd_cards.py): hit / miss / pending per card, summarised by
 *     mode and size — the learning record for the card shapes;
 *   app/atd-cards.js: stepper clamps 2..10, taps, break-even odds, kicked-off
 *     games drop their cards, the not-offered reason is shown;
 *   MY: the ANY mode never sees an ATD leg (unchanged, and what the Python
 *     recorder replays); ALL TD / 50%+ cards are all TD; MAJORITY cards are a
 *     strict majority TD; one leg per player keeps a player's TD and yardage
 *     legs off the same card;
 *   the pipeline builds the cards after the pool in BOTH daily and gameday (the
 *     validator checks them against it) and grades them continue-on-error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys, copy, datetime as dt, tempfile\nsys.path.insert(0, ".")\nfrom scripts import build_atd_cards as B, validate_data as V\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const POOL = `
now = dt.datetime(2026, 9, 27, 12, 0, tzinfo=dt.timezone.utc)
sched = {"games": [{"game_id": "G%d" % i, "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-28T17:00Z"} for i in range(1, 8)]
         + [{"game_id": "G9", "status": "STATUS_IN_PROGRESS", "kickoff_utc": "2026-09-27T11:00Z"}]}
atd, players = [], []
for i in range(1, 8):
    for j, p in enumerate((0.66 - i * 0.03, 0.25)):
        atd.append({"gsis_id": "a%d%d" % (i, j), "player": "Back %d%d" % (i, j), "team": "T%d" % i, "position": "RB",
                    "market": "anytime_td", "game_id": "G%d" % i, "side": "home", "pricing": "atd_model",
                    "rungs": [{"line": 0.5, "selection": "B. %d%d anytime TD" % (i, j), "model_prob": round(p, 4)}]})
    players.append({"gsis_id": "w%d" % i, "player": "Wide %d" % i, "team": "T%d" % i, "position": "WR",
                    "market": "wr_rec_yds", "game_id": "G%d" % i, "side": "away",
                    "rungs": [{"line": 19.5, "selection": "W. %d 20+ rec yds" % i, "model_prob": 0.91}]})
atd.append({"gsis_id": "late", "player": "Late Guy", "team": "T9", "position": "WR", "market": "anytime_td",
            "game_id": "G9", "side": "home", "pricing": "atd_model",
            "rungs": [{"line": 0.5, "selection": "L. Guy anytime TD", "model_prob": 0.9}]})
pool = {"season": 2026, "week": 4, "generated_utc": "x", "atd_legs": atd, "players": players, "game_legs": []}
doc = json.loads(json.dumps(B.build(pool, sched, {"adopted": True}, now)))
`;

test('R101c builder: one leg per game, open games only, product pricing, each mode rule', () => {
  const r = py(`${POOL}
out = {}
for mode, blk in doc["modes"].items():
    for size, cards in blk["cards"].items():
        for c in cards:
            p = 1.0
            for l in c["legs"]: p *= l["model_prob"]
            out.setdefault(mode, []).append({
                "n": int(size), "len": len(c["legs"]), "games": len({l["game_id"] for l in c["legs"]}),
                "late": any(l["game_id"] == "G9" for l in c["legs"]), "prod_ok": abs(p - c["model_prob"]) < 1e-6,
                "n_atd": c["n_atd"], "min_p": min(l["model_prob"] for l in c["legs"] if l["market"] == "anytime_td"),
                "be": c["break_even_american"]})
print(json.dumps({"out": out, "refused": {m: sorted(b["not_offered"]) for m, b in doc["modes"].items()},
                  "why": doc["modes"]["scorers_50"]["not_offered"].get("6")}))`);
  for (const [mode, cards] of Object.entries(r.out)) {
    for (const c of cards) {
      assert.equal(c.len, c.n, `${mode}: a ${c.n}-leg card has ${c.len} legs`);
      assert.equal(c.games, c.len, `${mode}: one leg per game`);
      assert.equal(c.late, false, `${mode}: a kicked-off game is never used`);
      assert.equal(c.prod_ok, true, `${mode}: the chance is the product`);
      if (mode !== 'majority_td') assert.equal(c.n_atd, c.len, `${mode}: every leg TD`);
      else assert.ok(c.n_atd * 2 > c.len, `majority: ${c.n_atd} of ${c.len}`);
      if (mode === 'scorers_50') assert.ok(c.min_p >= 0.5);
    }
  }
  assert.ok(r.out.all_td.some((c) => c.n === 7), 'seven open games fill a 7-leg ALL TD card');
  assert.deepEqual(r.refused.all_td, ['10', '8', '9'], 'sizes beyond the open games are refused');
  assert.match(r.why, /only 5 game\(s\) have an anytime-TD leg at 50%\+ this week/);
});

test('R101c builder: nothing on a model that is not adopted; first sight recorded once', () => {
  const r = py(`${POOL}
off = B.build(pool, sched, {"adopted": False}, now)
with tempfile.TemporaryDirectory() as tmp:
    a = B.record(doc, tmp); b = B.record(doc, tmp)
    rec = json.load(open(tmp + "/2026_wk04.json"))
V.validate_against_schema(doc, V._load("data/contracts/atd_cards.schema.json"), "atd_cards")
V.validate_against_schema(rec, V._load("data/contracts/atd_cards_record.schema.json"), "record")
print(json.dumps({"off": [off["adopted"], off["modes"]], "a": a, "b": b, "stamped": all("first_seen_utc" in c for c in rec["cards"])}))`);
  assert.deepEqual(r.off, [false, {}]);
  assert.ok(r.a > 0);
  assert.equal(r.b, 0, 'a second run on the same cards records nothing');
  assert.equal(r.stamped, true);
});

test('R101c validator: each violation refused on its own', () => {
  const r = py(`${POOL}
def run(d, p=pool):
    try:
        V.check_atd_cards(d, p); return "ok"
    except V.ValidationError as e:
        return str(e)
def mut(f):
    d = copy.deepcopy(doc); f(d); return d
c0 = lambda d: d["modes"]["all_td"]["cards"]["3"][0]
def same_game(d):
    c = c0(d); c["legs"][1] = dict(c["legs"][1], game_id=c["legs"][0]["game_id"])
def reprice(d):
    c0(d)["legs"][0]["model_prob"] = 0.99
def not_product(d):
    c0(d)["model_prob"] = 0.5
def non_td(d):
    c = c0(d); c["legs"][2] = {"market": "wr_rec_yds", "selection": "W. 1 20+ rec yds", "model_prob": 0.91,
        "line": 19.5, "player": "Wide 1", "team": "T1", "position": "WR", "gsis_id": "w1", "game_id": "G1", "side": "away"}
def minority(d):
    c = d["modes"]["majority_td"]["cards"]["4"][0]; c["n_atd"] = 2
    c["legs"] = [l for l in c["legs"] if l["market"] == "anytime_td"][:2] + [l for l in c["legs"] if l["market"] != "anytime_td"]
print(json.dumps({"honest": run(doc), "same_game": run(mut(same_game)), "reprice": run(mut(reprice)),
  "not_product": run(mut(not_product)), "non_td": run(mut(non_td)), "unadopted": run(dict(doc, adopted=False)),
  "other_week": run(doc, dict(pool, week=5))}))`);
  assert.equal(r.honest, 'ok');
  assert.match(r.same_game, /two legs share a game/);
  assert.match(r.reprice, /priced 0\.99, the pool says/);
  assert.match(r.not_product, /is not the product/);
  assert.match(r.non_td, /a non-TD leg on an all-TD card/);
  assert.match(r.unadopted, /says adopted: false/);
  assert.match(r.other_week, /is for 2026 wk 4, the pool for 2026 wk 5/);
});

test('R101c grader: hit / miss / pending per card, summarised by mode and size', () => {
  const r = py(`
from scripts import resolve_atd_cards as R
from scripts.resolve_parlay_legs import index_td
td = index_td([{"player_display_name": "Alpha Back", "position": "RB", "team": "LA", "week": "4", "season_type": "REG", "rushing_tds": "1", "receiving_tds": "0"},
               {"player_display_name": "Beta Back", "position": "RB", "team": "SF", "week": "4", "season_type": "REG", "rushing_tds": "0", "receiving_tds": "0"}])
L = lambda n, t, g: {"market": "anytime_td", "selection": n + " anytime TD", "player": n, "team": t, "game_id": g, "model_prob": 0.5, "position": "RB", "side": "home"}
rec = {"season": 2026, "week": 4, "cards": [
  {"card_id": "h", "mode": "all_td", "n_legs": 2, "model_prob": 0.25, "legs": [L("Alpha Back", "LAR", "g1"), L("Alpha Back", "LAR", "g1")]},
  {"card_id": "m", "mode": "all_td", "n_legs": 2, "model_prob": 0.25, "legs": [L("Alpha Back", "LAR", "g1"), L("Beta Back", "SF", "g2")]},
  {"card_id": "p", "mode": "majority_td", "n_legs": 2, "model_prob": 0.25, "legs": [L("Alpha Back", "LAR", "g1"), L("Ghost", "NE", "g3")]}]}
rows, pending = R.grade_records([rec], {}, {}, {"td": td, "snaps": None})
print(json.dumps({"res": {x["card_id"]: x["result"] for x in rows}, "pending": pending, "sum": R.summarize(rows)}))`);
  assert.deepEqual(r.res, { h: 'hit', m: 'miss' });
  assert.equal(r.pending, 1, 'an unresolved leg keeps the card pending, never a miss');
  assert.deepEqual(r.sum.all_td['2'], { hits: 1, graded: 2, hit_rate: 0.5, mean_model: 0.25, ratio: 2 });
});

test('R101c app/atd-cards.js: stepper, taps, odds, started games, reasons', async () => {
  const m = await import(join(REPO_ROOT, 'app/atd-cards.js'));
  assert.equal(m.clampLegs(1), 2);
  assert.equal(m.clampLegs(11), 10);
  assert.equal(m.clampLegs('x'), 4);
  const fake = (attrs) => ({ closest: (sel) => (sel === '[data-td]' && attrs.td ? { dataset: { td: attrs.td } } : sel === '[data-step]' && attrs.step ? { dataset: { step: attrs.step }, disabled: !!attrs.disabled } : null) });
  assert.deepEqual(m.tdTap({ mode: 'any', legs: 4 }, fake({ td: 'all_td' })), { mode: 'all_td', legs: 4 });
  assert.deepEqual(m.tdTap({ mode: 'all_td', legs: 10 }, fake({ step: '1' })), null, '+ at 10 does nothing');
  assert.deepEqual(m.tdTap({ mode: 'all_td', legs: 2 }, fake({ step: '-1' })), null, '− at 2 does nothing');
  assert.deepEqual(m.tdTap({ mode: 'all_td', legs: 4 }, fake({ step: '1' })), { mode: 'all_td', legs: 5 });
  assert.equal(m.breakEven(0.127279), '+686');
  assert.equal(m.breakEven(0.8), '−400');
  const html = m.tdControls({ mode: 'all_td', legs: 10 });
  assert.match(html, /data-step="1" aria-label="More legs" disabled/);
  assert.doesNotMatch(m.tdControls({ mode: 'any', legs: 4 }), /td-step/, 'no stepper in ANY');
  const card = (gid) => ({ legs: [{ game_id: gid }] });
  const doc = { adopted: true, modes: { all_td: { cards: { 3: [card('A'), card('B')] }, not_offered: { 9: 'only 8 game(s) …' } } } };
  const games = [{ game_id: 'A', status: 'STATUS_SCHEDULED', kickoff_utc: '2099-01-01T00:00Z' },
    { game_id: 'B', status: 'STATUS_IN_PROGRESS', kickoff_utc: '2020-01-01T00:00Z' }];
  assert.equal(m.atdCardsFor(doc, 'all_td', 3, games).cards.length, 1, 'a kicked-off game drops its card');
  assert.match(m.atdCardsFor(doc, 'all_td', 9, games).reason, /Not offered at 9 legs: only 8 game/);
  assert.match(m.atdCardsFor({ adopted: false }, 'all_td', 3, games).reason, /not adopted/);
});

test('R101c MY: ANY never sees an ATD leg; TD modes keep their rule; one leg per player', async () => {
  const my = await import(join(REPO_ROOT, 'app/views/myparlays.js'));
  const pool = JSON.parse(read('data/leg_pool.json'));
  const any = my.poolLegs(pool);
  assert.ok(any.every((l) => l.market !== 'anytime_td'), 'ANY mode is unchanged: no ATD leg');
  const synthPool = {
    players: [
      { gsis_id: 'p1', player: 'Alpha', team: 'AAA', position: 'RB', market: 'rb_rush_yds', game_id: 'G1', side: 'home', rungs: [{ line: 19.5, selection: 'A. 20+ rush yds', model_prob: 0.9 }] },
      { gsis_id: 'p2', player: 'Beta', team: 'BBB', position: 'WR', market: 'wr_rec_yds', game_id: 'G2', side: 'home', rungs: [{ line: 19.5, selection: 'B. 20+ rec yds', model_prob: 0.88 }] },
      { gsis_id: 'p3', player: 'Gamma', team: 'CCC', position: 'WR', market: 'wr_rec_yds', game_id: 'G3', side: 'home', rungs: [{ line: 19.5, selection: 'C. 20+ rec yds', model_prob: 0.87 }] },
    ],
    atd_legs: ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => ({ gsis_id: id, player: `P${i}`, team: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'][i], position: 'RB', market: 'anytime_td', game_id: `G${i + 1}`, side: 'home', rungs: [{ line: 0.5, selection: `P${i} anytime TD`, model_prob: 0.62 - i * 0.06 }] })),
    game_legs: [],
  };
  const atd = my.atdPoolLegs(synthPool);
  const other = my.poolLegs(synthPool);
  const table = null;
  const seeds = [{ kind: 'team', id: 'team:AAA', name: 'AAA' }];
  for (const [mode, n] of [['all_td', 4], ['scorers_50', 2], ['majority_td', 5], ['majority_td', 2]]) {
    const { legs, maxNonAtd } = my.tdLegsFor(mode, n, atd, other);
    const cards = my.buildCards(legs, seeds, table, { counts: [n], perCount: 10, maxNonAtd });
    assert.ok(cards.length > 0, `${mode} ${n}: cards`);
    for (const c of cards) {
      const td = c.legs.filter((l) => l.market === 'anytime_td');
      assert.equal(c.legs.length, n);
      if (mode === 'majority_td') assert.ok(td.length * 2 > n, `${mode}: ${td.length}/${n}`);
      else assert.equal(td.length, n);
      if (mode === 'scorers_50') assert.ok(td.every((l) => l.model_prob >= 0.5));
      const owners = c.legs.map((l) => l.owner);
      assert.equal(new Set(owners).size, owners.length, 'one leg per player');
    }
  }
  const merged = my.mergedCalib({ correlations: { default_rho: 0.1, pairs: [{ key: 'a|b', rho: 0.2 }] } },
    { atd_correlations: { pairs: [{ key: 'anytime_td|moneyline', rho: 0.13 }] } });
  assert.deepEqual(merged.correlations.pairs.map((p) => p.key), ['a|b', 'anytime_td|moneyline']);
  assert.equal(merged.correlations.default_rho, 0.1);
});

test('R101c pipeline: cards after the pool in daily AND gameday; grader continue-on-error; selftests', () => {
  for (const wf of ['.github/workflows/daily.yml', '.github/workflows/gameday.yml']) {
    const y = read(wf);
    const pool = y.indexOf('python3 scripts/build_leg_pool.py');
    const cards = y.indexOf('python3 scripts/build_atd_cards.py');
    const val = y.indexOf('scripts/validate_data.py');
    assert.ok(pool > 0 && cards > pool && val > cards, `${wf}: pool -> cards -> validate`);
    const grade = y.indexOf('python3 scripts/resolve_atd_cards.py');
    assert.ok(grade > 0, `${wf}: cards are graded`);
    assert.match(y.slice(grade, grade + 120), /continue-on-error: true/);
  }
  const smoke = read('tests/smoke.sh');
  assert.match(smoke, /build_atd_cards\.py --selftest/);
  assert.match(smoke, /resolve_atd_cards\.py --selftest/);
});
