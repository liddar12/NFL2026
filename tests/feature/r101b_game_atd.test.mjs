/* tests/feature/r101b_game_atd.test.mjs — R101b: the same-game joint pricer and
 * the GAME-scope anytime-TD cards.
 *
 * Owner (2026-09-24): GAME goes up to 10 legs with the ALL TD / MAJORITY TD /
 * 50%+ SCORERS selector, priced by a game simulator, each size validated and a
 * failing size not offered. Locked here:
 *   scripts/models/joint.py: zero loadings = the product, every marginal kept,
 *     the script factor lifts same-side legs and sinks opposite-side ones;
 *   scripts/backtest_joint.py: the product is kept when the model adds nothing,
 *     a planted shared factor is found and wins, every size decided with a reason;
 *   validator check_joint_backtest: pricer and offered sizes recomputed from the
 *     receipts — each lie refused on its own;
 *   builder (scripts/build_atd_game_cards.py) + validator check_atd_game_cards:
 *     one game per card, pool prices, re-priced under the chosen pricer, only
 *     validated sizes, no player twice, one moneyline — each violation refused;
 *   grader: GAME cards summarised apart from WEEK cards (game_<mode>);
 *   app/atd-cards.js: a GAME card names its game and says how it was priced;
 *   the pipeline: game cards after the week cards in daily and gameday (scores
 *     mode skips them), the joint backtest weekly after the ATD backtest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const run = (args) => execFileSync('python3', args, { cwd: REPO_ROOT, encoding: 'utf8' });
function py(body) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: REPO_ROOT },
    input: `import json, sys, copy, datetime as dt\nsys.path.insert(0, ".")\n`
      + `from scripts import build_atd_game_cards as G, validate_data as V\nfrom scripts.models import joint as J\n${body}\n`,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const FIX = `
now = dt.datetime(2026, 9, 27, 12, 0, tzinfo=dt.timezone.utc)
sched = {"games": [{"game_id": "G1", "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-28T17:00Z"},
                   {"game_id": "G2", "status": "STATUS_SCHEDULED", "kickoff_utc": "2026-09-28T20:25Z"}]}
atd, players = [], []
for gid in ("G1", "G2"):
    for j, p in enumerate((0.64, 0.56, 0.52, 0.41, 0.33, 0.27, 0.2)):
        atd.append({"gsis_id": "%s_%d" % (gid, j), "player": "P%d" % j, "team": "H" if j % 2 else "A",
                    "position": ("RB", "WR", "TE", "QB")[j % 4], "market": "anytime_td", "game_id": gid,
                    "side": "home" if j % 2 else "away", "pricing": "atd_model",
                    "rungs": [{"line": 0.5, "selection": "%s P%d anytime TD" % (gid, j), "model_prob": p}]})
    players.append({"gsis_id": "%s_y" % gid, "player": "Y", "team": "H", "position": "WR", "market": "wr_rec_yds",
                    "game_id": gid, "side": "home",
                    "rungs": [{"line": 29.5, "selection": "%s Y 30+ rec" % gid, "model_prob": 0.8}]})
game_legs = [{"game_id": g, "market": "moneyline", "side": s, "team": s[0].upper(), "selection": "%s %s ML" % (g, s),
              "model_prob": p} for g in ("G1", "G2") for s, p in (("home", 0.66), ("away", 0.34))]
pool = {"season": 2026, "week": 4, "generated_utc": "x", "atd_legs": atd, "players": players, "game_legs": game_legs}
L = {t: [0.2, 0.3] for t in J.TYPES}
jb = {"pricer": "joint", "generated_utc": "y", "loadings": L,
      "offered_sizes": {"all_td": [2, 3, 4], "majority_td": [3, 5], "scorers_50": [2]}, "sizes": {}}
doc = json.loads(json.dumps(G.build(pool, sched, {"adopted": True}, jb, now)))
def refused(d, p=pool, j=jb):
    try:
        V.check_atd_game_cards(d, p, j)
        return None
    except V.ValidationError as e:
        return str(e)
`;

test('R101b joint model, backtest, GAME builder and grader selftests pass', () => {
  assert.match(run(['scripts/models/joint.py']), /selftest ok/);
  assert.match(run(['scripts/backtest_joint.py', '--selftest']), /selftest ok/);
  assert.match(run(['scripts/build_atd_game_cards.py', '--selftest']), /selftest ok/);
  assert.match(run(['scripts/resolve_atd_cards.py', '--selftest']), /selftest ok/);
});

test('R101b builder: one game per card, validated sizes only, re-prices under the joint pricer', () => {
  const r = py(`${FIX}
at = doc["modes"]["all_td"]
c = at["cards"]["3"][0]
legs = [{"p": l["model_prob"], "side": l["side"], "type": J.leg_type(l)} for l in c["legs"]]
print(json.dumps({"sizes": sorted(at["cards"]), "games": sorted({l["game_id"] for l in c["legs"]}),
  "per_game": len(at["cards"]["3"]), "p": c["model_prob"], "joint": J.joint_prob(legs, L),
  "prod": J.independent_prob(legs), "why5": at["not_offered"]["5"],
  "s50": sorted(doc["modes"]["scorers_50"]["cards"]), "ok": refused(doc)}))`);
  assert.deepEqual(r.sizes, ['2', '3', '4']);
  assert.equal(r.games.length, 1, 'every leg from one game');
  assert.equal(r.per_game, 2, 'one card per open game');
  assert.ok(Math.abs(r.p - r.joint) < 1e-6 && r.p > r.prod, 'joint price, above the product');
  assert.match(r.why5, /^not validated on held-out games/);
  assert.deepEqual(r.s50, ['2'], 'the validated 50%+ size');
  assert.equal(r.ok, null, 'the built document passes the validator');
});

test('R101b validator: each GAME-card violation is refused on its own', () => {
  const r = py(`${FIX}
out = {}
d = copy.deepcopy(doc); d["modes"]["all_td"]["cards"]["3"][0]["model_prob"] = round(d["modes"]["all_td"]["cards"]["3"][0]["model_prob"] * 0.9, 8)
out["price"] = refused(d)
d = copy.deepcopy(doc); c = d["modes"]["all_td"]["cards"]["2"][0]; c["legs"][1] = copy.deepcopy(d["modes"]["all_td"]["cards"]["2"][1]["legs"][0])
out["two_games"] = refused(d)
d = copy.deepcopy(doc); d["modes"]["all_td"]["cards"]["3"][0]["legs"][0]["model_prob"] = 0.99
out["pool"] = refused(d)
out["size"] = refused(doc, pool, dict(jb, offered_sizes={"all_td": [2, 3], "majority_td": [3, 5], "scorers_50": [2]}))
out["pricer"] = refused(doc, pool, dict(jb, pricer="independent"))
d = copy.deepcopy(doc); c = d["modes"]["majority_td"]["cards"]["3"][0]; c["legs"][-1]["gsis_id"] = c["legs"][0]["gsis_id"]
out["player"] = refused(d)
print(json.dumps(out))`);
  assert.match(r.price, /pricer says/);
  assert.match(r.two_games, /more than one game/);
  assert.match(r.pool, /the pool says/);
  assert.match(r.size, /does not offer/);
  assert.match(r.pricer, /joint_backtest.json chose independent/);
  assert.match(r.player, /a player carries two legs/);
});

test('R101b validator: joint_backtest pricer and offered sizes follow from the receipts', () => {
  const r = py(`
row = lambda ok: {"n": 50, "hits": 3, "tail_hits": 12, "expected_independent": 2.5, "expected_joint": 3.1,
  "tail_expected_independent": 11.0, "tail_expected_joint": 12.4, "log_loss_independent": 0.2, "log_loss_joint": 0.19,
  "p_all": 0.8 if ok else 0.01, "p_tail": 0.9, "offered": ok, "reason": "x"}
base = {"pooled": {"cards": 100, "log_loss_independent": 0.2, "log_loss_joint": 0.19}, "pricer": "joint",
        "alpha": 0.05, "min_expected_tail": 1.0, "offered_sizes": {"all_td": [2], "majority_td": [], "scorers_50": []},
        "sizes": {"all_td": {"2": row(True), "3": row(False)}}}
def refused(d):
    try:
        V.check_joint_backtest(d)
        return None
    except V.ValidationError as e:
        return str(e)
out = {"ok": refused(base)}
out["pricer"] = refused(dict(base, pooled={"cards": 100, "log_loss_independent": 0.19, "log_loss_joint": 0.2}))
d = copy.deepcopy(base); d["sizes"]["all_td"]["3"]["offered"] = True; d["offered_sizes"]["all_td"] = [2, 3]
out["size"] = refused(d)
d = copy.deepcopy(base); d["offered_sizes"]["all_td"] = []
out["list"] = refused(d)
d = copy.deepcopy(base); d["sizes"]["all_td"]["2"]["tail_expected_joint"] = 0.4
out["thin"] = refused(d)
print(json.dumps(out))`);
  assert.equal(r.ok, null);
  assert.match(r.pricer, /pooled log loss says independent/);
  assert.match(r.size, /3-leg says offered=True/);
  assert.match(r.list, /offered_sizes \[\], the receipts earn \[2\]/);
  assert.match(r.thin, /2-leg says offered=True, its receipts say False/);
});

test('R101b app: a GAME card names its game and how it was priced', async () => {
  const { renderAtdCard } = await import(join(REPO_ROOT, 'app/atd-cards.js'));
  const card = { mode: 'all_td', label: 'ALL ANYTIME TD', n_legs: 2, n_atd: 2, model_prob: 0.21,
    legs: [{ selection: 'A anytime TD', model_prob: 0.5, team: 'SEA', market: 'anytime_td', game_id: '9' },
      { selection: 'B anytime TD', model_prob: 0.4, team: 'NE', market: 'anytime_td', game_id: '9' }] };
  const games = [{ game_id: '9', home: 'SEA', away: 'NE' }];
  const joint = renderAtdCard(card, { scope: 'game', pricer: 'joint', games });
  assert.match(joint, /data-scope="game"/);
  assert.match(joint, /NE @ SEA · ALL ANYTIME TD · 2 LEGS/);
  assert.match(joint, /same-game model, which beat the plain product/);
  const ind = renderAtdCard(card, { scope: 'game', pricer: 'independent', games });
  assert.match(ind, /did not beat the plain product/);
  const week = renderAtdCard(card);
  assert.match(week, /data-scope="week"/);
  assert.match(week, /One leg per game/);
});

test('R101b pipeline: game cards after week cards (daily + gameday), joint backtest weekly', () => {
  for (const wf of ['daily', 'gameday']) {
    const y = read(`.github/workflows/${wf}.yml`);
    const w = y.indexOf('python3 scripts/build_atd_cards.py');
    const g = y.indexOf('python3 scripts/build_atd_game_cards.py');
    assert.ok(w > 0 && g > w, `${wf}: game cards after week cards`);
  }
  assert.match(read('.github/workflows/gameday.yml'),
    /skip --workflow gameday --stage "Anytime-TD game cards \(first-sight record\)"/);
  const bt = read('.github/workflows/backtest.yml');
  const a = bt.indexOf('scripts/backtest_atd.py');
  const j = bt.indexOf('scripts/backtest_joint.py --cache "$RUNNER_TEMP/atd"');
  const v = bt.indexOf('python scripts/validate_data.py');
  assert.ok(a > 0 && j > a && v > j, 'joint backtest after the ATD backtest, before validation');
});
