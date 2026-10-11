/* tests/feature/r119_excluded_phi_jax.test.mjs — R119: PHI @ JAX is out of every
 * week-5 bet and prop.
 *
 * Owner, 2026-10-11: "Update the parlays and exclude the eagles and jaguars game
 * and props." config/excluded_games.json now lists 401872981 (PHI @ JAX, the
 * 09:30 ET week-5 game) beside R108's IND @ WAS; the R108 machinery does the rest
 * (scripts/excluded_games.py is the one reader, see r108_excluded_offer /
 * r108_excluded_records for the rule itself).
 *
 * Locked here, on the COMMITTED data with the real config:
 *   (1) the list carries 401872981 and the helper reads it, and IND @ WAS stays;
 *   (2) the slate rebuilt through build_parlays has no GAME card for it and no
 *       WEEK leg naming PHI or JAX — while it is on the slate the same rebuild
 *       with no list WOULD offer it, so the list is what removes it;
 *   (3) the leg pool (rebuilt slate, and the committed pre-R119 slate as-is)
 *       offers no prop, game or ATD leg for it;
 *   (4) the ATD WEEK / GAME cards and the MY / MY TD records built from that
 *       pool take no leg from it (schedule forced to "not kicked off" so the
 *       kickoff gate cannot be what keeps the game out).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const X = '401872981';
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: ROOT },
  stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  input: `import json, sys, os, tempfile, datetime as dt\nsys.path.insert(0, ".")\n${body}\n`,
}).trim().split('\n').pop());

const REBUILD = `
from scripts.models import parlay_builder as PB
from scripts import build_leg_pool as L
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
inputs = L.load_inputs()
pool_open = L.build(dict(inputs, parlays=slate_open, excluded_games=set()))
pool = L.build(dict(inputs, parlays=slate))
pool_stale = L.build(inputs)
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
            if str(l.get("game_id")) == X or (l["market"] in ("moneyline", "spread") and
                    str(l.get("selection", "")).split(" ")[0] in x_teams):
                n += 1
                break
    return n
`;

test('R119 (1): the config lists PHI @ JAX (401872981, week 5) and still lists IND @ WAS', () => {
  const r = py(`
from scripts import excluded_games as XG
g = XG.load()["${X}"]
print(json.dumps({"x": XG.is_excluded("${X}"), "int": XG.is_excluded(${X}),
                  "ind_was": XG.is_excluded("401872965"), "other": XG.is_excluded("401872980"),
                  "m": g["matchup"], "wk": g["week"], "season": g["season"]}))`);
  assert.deepEqual(r, { x: true, int: true, ind_was: true, other: false,
                        m: 'PHI @ JAX', wk: 5, season: 2026 });
});

test('R119 (2): the committed slate rebuilt through build_parlays has no card or leg for PHI @ JAX', () => {
  const r = py(`${REBUILD}
from scripts import validate_data as V
V.validate_against_schema(slate, load("data/contracts/parlays.schema.json"), "slate")
open_game = sum(1 for p in slate_open["parlays"] if p["scope"] == "game" and str(p.get("game_id")) == X)
per_game = {}
for p in slate["parlays"]:
    if p["scope"] == "game":
        per_game[str(p["game_id"])] = per_game.get(str(p["game_id"]), 0) + 1
others = [str(g["game_id"]) for g in games if str(g["game_id"]) != X and str(g["game_id"]) != "401872965"]
print(json.dumps({"on_slate": on_slate, "open_x": slate_x(slate_open), "open_game": open_game,
                  "x": slate_x(slate), "others_short": [g for g in others if per_game.get(g, 0) < 3],
                  "week": sum(1 for p in slate["parlays"] if p["scope"] == "week")}))`);
  assert.equal(r.x, 0, 'no game card for PHI @ JAX and no leg naming PHI or JAX');
  assert.deepEqual(r.others_short, [], 'every other slate game keeps >=3 game cards');
  assert.ok(r.week >= 3, 'the week still offers >=3 cross-game parlays');
  if (r.on_slate) {
    assert.ok(r.open_game >= 3, 'precondition: with no list the game WOULD get its >=3 cards');
    assert.ok(r.open_x > 0, 'precondition: with no list the slate WOULD use it');
  }
});

test('R119 (3): the leg pool offers no prop, game or ATD leg for PHI @ JAX', () => {
  const r = py(`${REBUILD}
from scripts import validate_data as V
for d, lbl in ((pool, "pool"), (pool_stale, "pool_stale")):
    V.validate_against_schema(d, load("data/contracts/leg_pool.schema.json"), lbl)
print(json.dumps({"on_slate": on_slate, "listed": X in inputs["excluded_games"],
                  "open": pool_x(pool_open), "x": pool_x(pool), "stale": pool_x(pool_stale)}))`);
  assert.equal(r.listed, true, 'load_inputs hands build() the owner\'s list');
  const zero = { players: 0, game_legs: 0, atd_legs: 0 };
  assert.deepEqual(r.x, zero, 'pool rebuilt from the R119 slate');
  assert.deepEqual(r.stale, zero, 'pool rebuilt from the committed (pre-R119) parlays.json / atd_week.json');
  if (r.on_slate) {
    assert.ok(r.open.players + r.open.game_legs > 0,
      'precondition: with no list the pool WOULD offer its props / game legs');
  }
});

test('R119 (4): ATD WEEK/GAME cards and MY / MY TD records built from the pool take no PHI @ JAX leg', () => {
  const r = py(`${REBUILD}
from scripts import build_atd_cards as W, build_atd_game_cards as G
from scripts import build_my_cards as MC, build_my_td_cards as MT
from scripts.models.parlay_builder import _correlation_table
sched = load("data/schedule_full.json")
wk = pool["week"]
week_games = sorted((g for g in sched["games"] if g.get("week") == wk), key=lambda g: g["kickoff_utc"])
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
keep = {X} | set([str(g["game_id"]) for g in week_games
                  if str(g["game_id"]) not in (X, "401872965")][:2])
def sliced(p):
    return dict(p, **{k: [r for r in p[k] if str(r.get("game_id")) in keep]
                      for k in ("players", "game_legs", "atd_legs")})
out = {"on_slate": on_slate}
for name, p in (("open", pool_open), ("r119", pool)):
    s = sliced(p)
    my = MC.offered_cards(s, forced["games"], corr, as_of)[0]
    mt = MT.offered(s, forced["games"], calib, jb, as_of)
    out[name] = {
        "atd_week": xn(doc_legs(W.build(p, forced, atd_bt, now))),
        "atd_game": xn(doc_legs(G.build(p, forced, atd_bt, jb, now))),
        "my": xn([l for _, _, _, c in my for l in c["legs"]]),
        "my_td": xn([l for m in mt.values() for cs in m.values() for c in cs for l in c["legs"]]),
        "my_cards": len(my),
    }
print(json.dumps(out))`);
  assert.deepEqual(
    { atd_week: r.r119.atd_week, atd_game: r.r119.atd_game, my: r.r119.my, my_td: r.r119.my_td },
    { atd_week: 0, atd_game: 0, my: 0, my_td: 0 },
    'no card on any surface takes a leg from PHI @ JAX');
  assert.ok(r.r119.my_cards > 0, 'the other games in the slice still get MY cards');
  if (r.on_slate) {
    assert.ok(r.open.my > 0, 'precondition: with no list MY cards WOULD use the game');
  }
});
