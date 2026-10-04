/* tests/feature/r108_excluded_offer.test.mjs — R108 OFFER SIDE: an owner-excluded
 * game is never offered in any bet.
 *
 * Owner, 2026-10-04: "Update all the parlays for week 4, so that the Colts vs
 * Washington game is not included in any bets." config/excluded_games.json lists
 * it (game 401872965, IND @ WAS); scripts/excluded_games.py is the one reader.
 * Two filter points carry the rule to every offer surface:
 *
 *   1. parlay_builder.build_parlays — the entry build_predictions and build_all
 *      both call: the game gets no game-scope card and supplies no week leg.
 *   2. build_leg_pool.build — props, copied game legs (game_id resolved from the
 *      team first) and ATD legs, filtered AFTER they are built, so a stale input
 *      written before the game was listed cannot carry one through. The ATD WEEK
 *      and GAME card builders, the MY card / MY TD card records and the browser's
 *      MY PARLAYS read ONLY leg_pool.json, so they inherit it — proven below by
 *      feeding them the rebuilt pool, with the schedule forced to "not kicked off"
 *      so the kickoff gate cannot be what keeps the game out.
 *
 * data/atd_week.json is pricing, not an offer (read only by the pool and the
 * validator), so the game's players stay priced there; the pool is the gate.
 * game_predictions.json is untouched: the game is still predicted and graded.
 *
 * Locked here:
 *   (1) on the COMMITTED data, rebuilding the slate, the pool and every card
 *       builder through their pure functions with the real config yields zero
 *       cards / legs for 401872965 — and (while it is on the slate) the same
 *       rebuild with NO exclusion list does offer it, so the filter is what
 *       removes it; the filtered outputs still pass their contracts;
 *   (2) a synthetic excluded id is dropped and every other game is kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const X = '401872965';
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: ROOT },
  stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  input: `import json, sys, os, tempfile, datetime as dt\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

// The committed-data rebuild, shared by the slate / pool / card tests. OPEN = the
// same pipeline with no exclusion list (an absent file excludes nothing).
const REBUILD = `
from scripts.models import parlay_builder as PB
from scripts import build_leg_pool as L, excluded_games as XG
X = "${X}"
NONE = os.path.join(tempfile.mkdtemp(), "absent.json")
def load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)
gpd = load("data/game_predictions.json")
games = gpd["games"]
on_slate = any(str(g["game_id"]) == X for g in games)
x_teams = {t for g in games if str(g["game_id"]) == X for t in (g["home"], g["away"])}
props = PB.build_props_by_game(games, load("data/player_weekly.json"),
                               load("data/player_projections.json"))
slate_open = PB.build_parlays_document(games, gpd["season"], gpd["week"], "t",
                                       props_by_game=props, excluded_path=NONE)
slate = PB.build_parlays_document(games, gpd["season"], gpd["week"], "t", props_by_game=props)
inputs = L.load_inputs()             # carries the real list as inputs["excluded_games"]
pool_open = L.build(dict(inputs, parlays=slate_open, excluded_games=set()))
pool = L.build(dict(inputs, parlays=slate))
pool_stale = L.build(inputs)          # committed parlays.json / atd_week.json as-is
def pool_x(p):
    return {k: sum(1 for r in p[k] if str(r.get("game_id")) == X)
            for k in ("players", "game_legs", "atd_legs")}
def slate_x(doc):
    n = 0
    for p in doc["parlays"]:
        if str(p.get("game_id")) == X:
            n += 1
            continue
        for l in p["legs"]:
            if l["market"] in ("moneyline", "spread") and \\
                    str(l.get("selection", "")).split(" ")[0] in x_teams:
                n += 1
                break
    return n
`;

test('R108: the config lists IND @ WAS (401872965) and the helper reads it', () => {
  const r = py(`
from scripts import excluded_games as XG
g = XG.load()["${X}"]
print(json.dumps({"x": XG.is_excluded("${X}"), "int": XG.is_excluded(${X}),
                  "other": XG.is_excluded("401872971"), "m": g["matchup"], "wk": g["week"]}))`);
  assert.deepEqual(r, { x: true, int: true, other: false, m: 'IND @ WAS', wk: 4 });
});

test('R108 (1): the committed slate rebuilt through build_parlays carries no card or leg for 401872965', () => {
  const r = py(`${REBUILD}
from scripts import validate_data as V
V.validate_against_schema(slate, load("data/contracts/parlays.schema.json"), "slate")
V.check_parlay_model_independence(slate, gpd)
V.check_parlay_one_leg_per_side(slate)
open_game = sum(1 for p in slate_open["parlays"] if p["scope"] == "game" and str(p.get("game_id")) == X)
per_game = {}
for p in slate["parlays"]:
    if p["scope"] == "game":
        per_game[str(p["game_id"])] = per_game.get(str(p["game_id"]), 0) + 1
others = [str(g["game_id"]) for g in games if str(g["game_id"]) != X]
print(json.dumps({"on_slate": on_slate, "open_x": slate_x(slate_open), "open_game": open_game,
                  "x": slate_x(slate), "others_short": [g for g in others if per_game.get(g, 0) < 3],
                  "week": sum(1 for p in slate["parlays"] if p["scope"] == "week"),
                  "week_open": sum(1 for p in slate_open["parlays"] if p["scope"] == "week"),
                  "lost": len(slate_open["parlays"]) - len(slate["parlays"])}))`);
  assert.equal(r.x, 0, 'no game card for the excluded game and no week leg naming its teams');
  assert.deepEqual(r.others_short, [], 'every other slate game keeps >=3 game cards');
  assert.ok(r.week >= 3, 'the week still offers >=3 cross-game parlays');
  if (r.on_slate) {
    assert.ok(r.open_game >= 3, 'precondition: with no list the game WOULD get its >=3 cards');
    // The game's own GAME cards are gone. A WEEK card that used its moneyline is
    // not deleted but REBUILT from the remaining games (2026-10-04: IND / WAS was
    // a top favourite and sat on 8 open-slate week cards), so the week keeps its
    // size and none of its legs names the excluded game (r.x above).
    assert.equal(r.lost, r.open_game, 'exactly the excluded game\'s GAME cards are gone');
    assert.equal(r.week, r.week_open, 'the WEEK set keeps its size, rebuilt over the remaining games');
  }
});

test('R108 (1): the committed leg pool offers no prop, game or ATD leg for 401872965', () => {
  const r = py(`${REBUILD}
from scripts import validate_data as V
for d, lbl in ((pool, "pool"), (pool_stale, "pool_stale")):
    V.validate_against_schema(d, load("data/contracts/leg_pool.schema.json"), lbl)
atd_week = load("data/atd_week.json")
atd_bt = load("data/atd_backtest.json")
V.check_atd_offered(pool, atd_week, atd_bt)
V.check_atd_offered(pool_stale, atd_week, atd_bt)
print(json.dumps({"on_slate": on_slate, "listed": X in inputs["excluded_games"],
                  "open": pool_x(pool_open), "x": pool_x(pool),
                  "stale": pool_x(pool_stale), "n": pool["counts"]["excluded_game"],
                  "n_open": pool_open["counts"]["excluded_game"],
                  "kept_games": len({str(r["game_id"]) for r in pool["game_legs"]}),
                  "status": pool["atd_status"]}))`);
  assert.equal(r.listed, true, 'load_inputs hands build() the owner\'s list');
  const zero = { players: 0, game_legs: 0, atd_legs: 0 };
  assert.deepEqual(r.x, zero, 'pool rebuilt from the R108 slate');
  assert.deepEqual(r.stale, zero, 'pool rebuilt from the committed (pre-R108) parlays.json / atd_week.json');
  assert.equal(r.n_open, 0, 'no list, nothing dropped');
  if (r.on_slate) {
    assert.ok(r.open.game_legs >= 1, 'precondition: with no list the pool WOULD offer its moneyline');
    // The R108 slate already carries no game leg for it, so the pool's own filter
    // removes exactly the prop and ATD rows the open pool offered.
    assert.equal(r.n, r.open.players + r.open.atd_legs,
      'counts.excluded_game is exactly the rows the filter removed');
    if (r.open.atd_legs) assert.match(r.status, /owner-excluded games not offered \(R108\)/);
  }
  assert.ok(r.kept_games >= 1, 'every other game keeps its game legs');
});

test('R108 (1): ATD WEEK/GAME cards and MY / MY TD records built from the rebuilt pool carry no 401872965 leg', () => {
  const r = py(`${REBUILD}
from scripts import build_atd_cards as W, build_atd_game_cards as G
from scripts import build_my_cards as MC, build_my_td_cards as MT
from scripts.models.parlay_builder import _correlation_table
sched = load("data/schedule_full.json")
wk = pool["week"]
week_games = sorted((g for g in sched["games"] if g.get("week") == wk), key=lambda g: g["kickoff_utc"])
# Force the pool's week to "scheduled, not kicked off" so the kickoff gate cannot be
# what keeps the (already played) game out: only the R108 filter can.
now = min(W._parse_utc(g["kickoff_utc"]) for g in week_games) - dt.timedelta(hours=1)
as_of = now.strftime("%Y-%m-%dT%H:%M:%SZ")
forced = {"games": [dict(g, status="STATUS_SCHEDULED") if g.get("week") == wk else g
                    for g in sched["games"]]}
atd_bt, jb = load("data/atd_backtest.json"), load("data/joint_backtest.json")
calib = load("data/parlay_backtest.json")
corr = _correlation_table(calib)
def doc_legs(doc):
    return [l for m in doc["modes"].values() for cs in m["cards"].values() for c in cs
            for l in c["legs"]]
def xn(legs):
    return sum(1 for l in legs if str(l.get("game_id")) == X)
# The MY searches run per team seed; a 3-game slice (the excluded game + the two
# earliest others) keeps them fast and still proves the builders consume only the pool.
keep = {X} | set([str(g["game_id"]) for g in week_games if str(g["game_id"]) != X][:2])
def sliced(p):
    return dict(p, **{k: [r for r in p[k] if str(r.get("game_id")) in keep]
                      for k in ("players", "game_legs", "atd_legs")})
out = {"on_slate": on_slate}
for name, p in (("open", pool_open), ("r108", pool)):
    s = sliced(p)
    my = MC.offered_cards(s, forced["games"], corr, as_of)[0]
    mt = MT.offered(s, forced["games"], calib, jb, as_of)
    out[name] = {
        "atd_week": xn(doc_legs(W.build(p, forced, atd_bt, now))),
        "atd_game": xn(doc_legs(G.build(p, forced, atd_bt, jb, now))),
        "my": xn([l for _, _, _, c in my for l in c["legs"]]),
        "my_td": xn([l for m in mt.values() for cs in m.values() for c in cs for l in c["legs"]]),
        "my_cards": len(my),
        "atd_x_legs": pool_x(p)["atd_legs"],
    }
print(json.dumps(out))`);
  assert.deepEqual(
    { atd_week: r.r108.atd_week, atd_game: r.r108.atd_game, my: r.r108.my, my_td: r.r108.my_td },
    { atd_week: 0, atd_game: 0, my: 0, my_td: 0 },
    'no card on any surface takes a leg from the excluded game');
  assert.ok(r.r108.my_cards > 0, 'the other games in the slice still get MY cards');
  if (r.on_slate) {
    assert.ok(r.open.my > 0, 'precondition: with no list MY cards WOULD use the game');
    if (r.open.atd_x_legs) {
      assert.ok(r.open.atd_week > 0 && r.open.my_td > 0,
        'precondition: with no list the ATD WEEK card and the MY TD record WOULD use it');
    }
  }
});

test('R108 (2): a synthetic excluded id is dropped from the slate; every other game is kept', () => {
  const r = py(`
from scripts.models import parlay_builder as PB
d = tempfile.mkdtemp()
xp, none = os.path.join(d, "x.json"), os.path.join(d, "absent.json")
with open(xp, "w") as fh:
    json.dump({"games": [{"game_id": "G2"}]}, fh)
games = [{"game_id": "G%d" % i, "home": "H%d" % i, "away": "A%d" % i,
          "probs": {"home": p, "away": round(1 - p, 4)}}
         for i, p in ((1, 0.62), (2, 0.91), (3, 0.70), (4, 0.58))]
def shape(ps):
    game = {}
    for p in ps:
        if p["scope"] == "game":
            game[p["game_id"]] = game.get(p["game_id"], 0) + 1
    teams = sorted({l["selection"].split(" ")[0] for p in ps for l in p["legs"]})
    return {"game": game, "teams": teams, "week": sum(1 for p in ps if p["scope"] == "week")}
print(json.dumps({"open": shape(PB.build_parlays(games, excluded_path=none)),
                  "x": shape(PB.build_parlays(games, excluded_path=xp))}))`);
  assert.ok(r.open.game.G2 >= 3 && r.open.teams.includes('H2'),
    'with no list the strongest favorite is on its game cards and in week legs');
  assert.equal(r.x.game.G2, undefined, 'the excluded game gets no game card');
  assert.ok(!r.x.teams.includes('H2') && !r.x.teams.includes('A2'), 'and supplies no leg anywhere');
  for (const g of ['G1', 'G3', 'G4']) assert.ok(r.x.game[g] >= 3, `${g} keeps its >=3 cards`);
  assert.ok(r.x.week >= 3, 'the week still offers >=3 cross-game parlays');
});

test('R108 (2): the pool drops a synthetic excluded game\'s rows, keeps the rest, and its selftest proves build() wiring', () => {
  const r = py(`
from scripts import build_leg_pool as L
rows = [{"game_id": "G1"}, {"game_id": "G2"}, {"game_id": 7}, {"game_id": None}]
kept, n = L.drop_excluded(rows, {"G2", "7"})
print(json.dumps({"kept": [r["game_id"] for r in kept], "n": n,
                  "empty": L.drop_excluded(rows, set())[1]}))`);
  assert.deepEqual(r, { kept: ['G1', null], n: 2, empty: 0 },
    'ids compare as strings (an int game_id 7 matches "7"); an unresolved leg cannot be matched');
  const out = execFileSync('python3', ['scripts/build_leg_pool.py', '--selftest'],
    { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /owner-excluded game \(R108\) offers no prop, game or ATD leg/);
});
