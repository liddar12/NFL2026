/* Week 6: settlement is not an unchanged-contract calibration outcome, and
 * history order is not time. These fixtures assert independent numeric oracles. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const py = (body) => JSON.parse(execFileSync('python3', ['-'], {
  cwd: ROOT, encoding: 'utf8', input: `import json, math\n${body}\n`,
}).trim().split('\n').at(-1));

test('Week 6: void successes and void losses retain settlement but cannot score the original contract', () => {
  const b = py(`from scripts.resolve_my_cards import _block
def row(cid, p, results, bucket, net):
    return {"card_id": cid, "model": p, "n_legs": len(results), "bucket": bucket,
            "legs": [{"result": r} for r in results],
            "money": {"net_fair": net, "net_vig2": net}}
graded = [row("hit", .4, ["hit", "hit"], "all_hit", 200),
          row("miss", .7, ["hit", "miss"], "partial", -100),
          row("reduced", .99, ["hit", "void"], "push", 80),
          row("voidloss", .9, ["miss", "void"], "all_missed", -100),
          row("refund", .1, ["void", "void"], "push", 0)]
cards = [{"card_id": r["card_id"], "locked": True} for r in graded]
cards += [{"card_id": "pending", "locked": True}, {"card_id": "unlocked", "locked": False}]
print(json.dumps(_block(cards, graded)))`);
  assert.equal(b.graded, 5);
  assert.equal(b.all_hit, 1);
  assert.equal(b.hit_rate, .2);
  assert.equal(b.staked, 500);
  assert.equal(b.net_fair, 80);
  assert.deepEqual(b.settlements, { all_hit: 1, reduced_hit: 1, void: 1, loss: 2, pending: 1 });
  assert.equal(b.calibration.version, 'original_contract_v1');
  assert.equal(b.calibration.n, 2);
  assert.equal(b.calibration.all_hit, 1);
  assert.equal(b.calibration.hit_rate, .5);
  assert.equal(b.calibration.mean_model, .55);
  assert.equal(b.calibration.expected_hits, 1.1);
  assert.equal(b.calibration.log_loss, +((-Math.log(.4) - Math.log(.3)) / 2).toFixed(4));
  assert.equal(b.calibration.brier, +((.6 ** 2 + .7 ** 2) / 2).toFixed(4));
  assert.equal(b.calibration.excluded.changed_contract, 3);
  assert.equal(b.mean_model, b.calibration.mean_model);
  assert.equal(b.log_loss, b.calibration.log_loss);
});

test('Week 6: no usable original contracts means null calibration, not a measured zero', () => {
  const b = py(`from scripts.resolve_my_cards import _block
graded = [
 {"n_legs": 2, "model": .3, "bucket": "push", "legs": [{"result": "hit"}, {"result": "void"}]},
 {"n_legs": 2, "model": .3, "bucket": "all_hit", "legs": [{"result": "hit"}]},
 {"n_legs": 2, "model": True, "bucket": "all_hit", "legs": [{"result": "hit"}, {"result": "hit"}]},
 {"n_legs": 2, "model": float("nan"), "bucket": "all_hit", "legs": [{"result": "hit"}, {"result": "hit"}]},
 {"n_legs": 2, "model": .3, "bucket": "all_hit", "legs": [{"result": "hit"}, {"result": "miss"}]}]
for r in graded: r["money"] = None
print(json.dumps(_block([], graded)))`);
  assert.equal(b.calibration.n, 0);
  assert.deepEqual(b.calibration.excluded, {
    changed_contract: 1, incomplete_contract: 1, invalid_probability: 2, inconsistent_result: 1,
  });
  for (const key of ['hit_rate', 'mean_model', 'expected_hits', 'log_loss', 'brier']) {
    assert.equal(b.calibration[key], null, key);
  }
  for (const key of ['mean_model', 'log_loss', 'brier']) assert.equal(b[key], null, key);
});

test('Week 6: grading copies available canonical leg identity without inventing missing fields', () => {
  const r = py(`from scripts.resolve_my_cards import grade_card
legs = [{"market": "moneyline", "selection": "SEA ML", "game_id": "g1",
         "side": "home", "team": "SEA", "model_prob": .6, "implied_prob": .5,
         "gsis_id": "espn-1", "line": None, "direction": "over", "season": 2026,
         "comparison_operator": "gte",
         "learning_receipt": {"receipt_id": "receipt-one"}},
        {"market": "moneyline", "selection": "NE ML", "game_id": "g2",
         "side": "home", "team": "NE", "model_prob": .6, "implied_prob": .5}]
card = {"card_id": "identity", "dial": "safe", "seed": "SEA", "n_legs": 2,
        "model": .36, "locked": True, "legs": legs}
print(json.dumps(grade_card(card, 1, {}, {"g1": {"home_score": 7, "away_score": 0},
                                      "g2": {"home_score": 0, "away_score": 7}})))`);
  assert.equal(r.legs[0].game_id, 'g1');
  assert.equal(r.legs[0].gsis_id, 'espn-1');
  assert.equal(r.legs[0].receipt_id, 'receipt-one');
  assert.equal(r.legs[0].season, 2026);
  assert.equal(r.legs[0].line, null);
  assert.equal(r.legs[0].direction, 'over');
  assert.equal(r.legs[0].comparison_operator, 'gte');
  assert.equal(r.legs[1].game_id, 'g2');
  assert.ok(!Object.hasOwn(r.legs[1], 'receipt_id'));
  assert.ok(!Object.hasOwn(r.legs[1], 'gsis_id'));
});

test('Week 6: recorded Week 5 calibration has the same eligible cohort as an independent leg-results oracle', () => {
  const doc = JSON.parse(readFileSync(resolve(ROOT, 'data/my_card_scores.json'), 'utf8'));
  const all = doc.cards.filter(c => c.week === 5 && c.dial === 'safe');
  const clean = all.filter(c => c.legs.length === c.n_legs
    && c.legs.every(l => l.result === 'hit' || l.result === 'miss'));
  assert.ok(clean.length > 0, 'the recorded Week 5 population is available');
  const b = py(`from scripts.resolve_my_cards import _block
doc = json.load(open("data/my_card_scores.json"))
cards = [c for c in doc["cards"] if c["week"] == 5 and c["dial"] == "safe"]
print(json.dumps(_block(cards, cards)))`);
  assert.equal(b.calibration.n, clean.length);
  assert.equal(b.calibration.all_hit, clean.filter(c => c.legs.every(l => l.result === 'hit')).length);
  assert.equal(b.calibration.mean_model, +(clean.reduce((s, c) => s + c.model, 0) / clean.length).toFixed(4));
  assert.equal(b.calibration.excluded.changed_contract, all.length - clean.length);
  assert.equal(b.graded, all.length, 'settlement denominator remains unchanged');
});

test('Week 6: latest timestamp wins across prepend/append histories while a held proposal retains active parameters', () => {
  const out = py(`from scripts.build_learning_loops import game_signals, player_signals
history = [{"kind": "signal_promotion", "generated_utc": "2026-10-13T12:00:00Z", "adopted": False, "reason": "latest hold"},
           {"kind": "signal_promotion", "generated_utc": "2026-07-18T12:00:00Z", "adopted": True, "reason": "old adoption"},
           {"kind": "signal_promotion", "generated_utc": "2026-10-12T08:00:00-05:00", "adopted": False, "reason": "older hold"}]
mt = {"history": history, "game_params": {"qb_out": {"applied": True, "scale": 75, "adopted_utc": "2026-07-18T12:00:00Z"}}}
orders = [history, list(reversed(history)), [history[1], history[0], history[2]]]
results = [game_signals({"model_tuning.json": {**mt, "history": h}}) for h in orders]
print(json.dumps(results))`);
  assert.deepEqual(out[0], out[1]);
  assert.deepEqual(out[0], out[2]);
  assert.equal(out[0].state, 'held');
  assert.equal(out[0].last_run_utc, '2026-10-13T12:00:00Z');
  assert.equal(out[0].why, 'latest hold');
  assert.equal(out[0].effective.state, 'active');
  assert.equal(out[0].effective.since_utc, '2026-07-18T12:00:00Z');
});

test('Week 6: effective reverted player weights remain baseline through a subsequent held proposal', () => {
  const rows = py(`from scripts.build_learning_loops import player_signals
h = [{"kind": "player_signal_fit", "generated_utc": "2026-10-13T00:00:00Z", "auto": {"action": "hold", "reason": "held latest"}},
     {"kind": "player_signal_fit", "generated_utc": "2026-10-06T00:00:00Z", "auto": {"action": "adopt", "applied": True, "reason": "adopted before"}},
     {"kind": "player_signal_fit", "generated_utc": "2026-10-12T00:00:00Z", "auto": {"action": "revert", "applied": True, "reason": "reverted before"}}]
base = {"kind": "revert", "weights": {"age_curve": 1.0}, "adopted_utc": "2026-10-12T00:00:00Z"}
active = {"kind": "adopt", "weights": {"age_curve": .5}, "adopted_utc": "2026-10-06T00:00:00Z"}
print(json.dumps([player_signals({"model_tuning.json": {"history": h, "candidate_signal_weights": p}}) for p in [base, active]]))`);
  assert.equal(rows[0].state, 'held');
  assert.equal(rows[0].effective.state, 'baseline');
  assert.equal(rows[0].effective.since_utc, '2026-10-12T00:00:00Z');
  assert.equal(rows[1].state, 'held');
  assert.equal(rows[1].effective.state, 'active');
  assert.notEqual(rows[0].effective.version, rows[1].effective.version);
});

test('Week 6: undated or conflicting newest decisions cannot silently choose an array-order winner', () => {
  const out = py(`from scripts.build_learning_loops import game_signals
a = {"kind": "signal_promotion", "generated_utc": "2026-10-13T12:00:00Z", "adopted": False, "reason": "held"}
b = {**a, "adopted": True, "reason": "adopted"}
bad = {**a, "generated_utc": "t99"}
print(json.dumps([game_signals({"model_tuning.json": {"history": h, "game_params": {}}}) for h in [[a,b], [b,a], [bad], [bad,a]]]))`);
  assert.deepEqual(out[0], out[1]);
  assert.equal(out[0].last_run_utc, null);
  assert.equal(out[0].chronology.latest_conflict, true);
  assert.equal(out[2].last_run_utc, null);
  assert.equal(out[2].chronology.invalid_timestamps, 1);
  assert.equal(out[3].last_run_utc, '2026-10-13T12:00:00Z');
  assert.equal(out[3].chronology.invalid_timestamps, 1);
});

test('Week 6: current disabled MY correction reports effective disabled independently of latest held decision', () => {
  const row = py(`from scripts.build_learning_loops import leg_pool_live
print(json.dumps(leg_pool_live({"leg_pool_backtest.json": {"generated_utc": "2026-10-13T12:00:00Z", "live_2026": {"applied": False, "adjustment": None, "reason": "held"}}})))`);
  assert.equal(row.state, 'held');
  assert.equal(row.effective.state, 'disabled');
  assert.equal(row.last_run_utc, '2026-10-13T12:00:00Z');
});

test('Week 6: proposed adoption is not executed; executed adoption, hold, revert and hold remain distinguishable', () => {
  const rows = py(`from scripts.build_learning_loops import player_signals, build
history = []
out = []
previous = None
for day, action, applied, configured in [(1, "adopt", False, None),
        (2, "adopt", True, "adopt"), (3, "hold", False, "adopt"),
        (4, "revert", True, "revert"), (5, "hold", False, "revert")]:
    now = "2026-10-%02dT12:00:00Z" % day
    record = {"kind": "player_signal_fit", "generated_utc": now,
              "auto": {"action": action, "applied": applied, "reason": action}}
    history = [record] + history if day % 2 else history + [record]
    mt = {"history": history}
    if configured:
        mt["candidate_signal_weights"] = {"kind": configured, "weights": {"age_curve": .5 if configured == "adopt" else 1.0},
            "adopted_utc": "2026-10-02T12:00:00Z" if configured == "adopt" else "2026-10-04T12:00:00Z"}
    previous, _ = build({"model_tuning.json": mt}, previous, now)
    row = next(l for l in previous["loops"] if l["id"] == "player_signals")
    out.append({"decision": row["state"], "effective": row["effective"]["state"],
                "transitions": [t for t in previous["transitions"] if t["loop"] == "player_signals"]})
print(json.dumps(out))`);
  assert.deepEqual(rows.map(r => r.decision), ['held', 'adopted', 'held', 'reverted', 'held']);
  assert.deepEqual(rows.map(r => r.effective), ['baseline', 'active', 'active', 'baseline', 'baseline']);
  assert.deepEqual(rows[4].transitions.map(t => [t.from, t.to]), [
    ['held', 'adopted'], ['adopted', 'held'], ['held', 'reverted'], ['reverted', 'held'],
  ]);
  assert.deepEqual(rows[4].transitions.slice(0, 2), rows[2].transitions, 'prior transitions are retained');
});

test('Week 6: current history latest timestamp and active family are derived independently', () => {
  const mt = JSON.parse(readFileSync(resolve(ROOT, 'data/model_tuning.json'), 'utf8'));
  const latest = mt.history.filter(h => h.kind === 'signal_promotion' && Number.isFinite(Date.parse(h.generated_utc)))
    .sort((a, b) => Date.parse(b.generated_utc) - Date.parse(a.generated_utc))[0];
  const active = Object.values(mt.game_params).some(v => v && typeof v === 'object' && v.applied === true);
  const row = py(`from scripts.build_learning_loops import game_signals
print(json.dumps(game_signals({"model_tuning.json": json.load(open("data/model_tuning.json"))})))`);
  assert.equal(row.last_run_utc, latest.generated_utc);
  assert.equal(row.state, latest.adopted ? 'adopted' : 'held');
  assert.equal(row.effective.state, active ? 'active' : 'baseline');
});

test('Week 6: updated contracts validate legacy data and fresh reporting, and reject missing nested denominators', () => {
  const result = py(`import copy
from scripts.validate_data import validate_against_schema, ValidationError
from scripts.resolve_my_cards import _fixture_rows, _fixture_stats, index_stats, score, document
from scripts.build_learning_loops import build, load_sources
schemas = {name: json.load(open("data/contracts/" + name + ".schema.json")) for name in ["my_card_scores", "learning_loops"]}
for name, schema in schemas.items():
    validate_against_schema(json.load(open("data/" + name + ".json")), schema, "legacy " + name)
rows = _fixture_rows()
for i, (_, card) in enumerate(rows):
    card["card_id"] = "%012x" % (i + 1)
    for leg in card["legs"]:
        leg.update({"direction": "over", "comparison_operator": "gte", "season": 2026,
                    "learning_receipt": {"receipt_id": "receipt-example"}})
weeks, graded = score(rows, index_stats(_fixture_stats()), {"g1": {"home_score": 24, "away_score": 17}}, excluded=set())
fresh_scores = document(2026, weeks, graded, "test", None, "2026-10-14T12:00:00Z")
fresh_loops, _ = build(load_sources(), None, "2026-10-14T12:00:00Z")
validate_against_schema(fresh_scores, schemas["my_card_scores"], "fresh scores")
validate_against_schema(fresh_loops, schemas["learning_loops"], "fresh loops")
bad = copy.deepcopy(fresh_scores)
del bad["weeks"][0]["by_dial"]["safe"]["calibration"]["n"]
rejected = False
try:
    validate_against_schema(bad, schemas["my_card_scores"], "missing denominator")
except ValidationError:
    rejected = True
print(json.dumps({"legacy": True, "fresh": True, "missing_n_rejected": rejected}))`);
  assert.deepEqual(result, { legacy: true, fresh: true, missing_n_rejected: true });
});
