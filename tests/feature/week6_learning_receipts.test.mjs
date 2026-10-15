import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE = `
import copy, datetime as dt, json, math, random
from scripts import learning_receipts as lr, backtest_leg_pool as bt
BASE_VERSION = lr.base_version({"WR": {"a": 0, "b": 1, "c": 0}}, {"WR": 30})
def fixture(week=6, pid="player-A", gid=None, p=.374058, y=1, correction=None, card_id=None):
    gid = gid or ("game-%s" % week)
    created = (dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=7*week)).isoformat()
    kickoff = (dt.datetime.fromisoformat(created) + dt.timedelta(days=1)).isoformat()
    leg = {"game_id": gid, "gsis_id": pid, "market": "wr_rec_yds", "line": 59.5,
           "side": "home", "selection": "T. Johnson 60+ rec yds", "position": "WR"}
    context = {"season": 2026, "week": week, "base_model_version": BASE_VERSION,
               "forecast_created_utc": created, "source_snapshot_id": lr.fingerprint({"week":week}),
               "source_timestamps": {"fixture": created}, "generation_sha": "fixture"}
    z=math.log(p/(1-p))
    features={"market":leg["market"],"line":59.5,"mu":59.5+30*z,"sd":30,"z":z,
              "p_team":.5,"calibration":{"a":0,"b":1,"c":0},"correlation_tags":["game:"+gid]}
    # Freeze the generator's exact floating-point base, not an inverse-rounded approximation.
    p=lr.base_probability(features["calibration"],z,.5)
    receipt = lr.make_receipt(leg, p, correction, context, features=features)
    leg.update(model_prob=receipt["served_prob"], learning_receipt=receipt)
    card_id = card_id or ("card-%s-%s-%s" % (week, pid, gid))
    card = {"card_id": card_id, "locked": True, "first_seen_utc": created,
            "earliest_kickoff_utc": kickoff, "legs": [leg]}
    scored = {k:leg[k] for k in ("game_id", "gsis_id", "market", "line", "side", "selection")}
    scored.update(result="hit" if y else "miss", receipt_id=receipt["receipt_id"])
    return {"season":2026, "week":week, "cards":[card]}, {"season":2026, "cards":[{"card_id":card_id, "week":week, "legs":[scored]}]}
def combine(pairs):
    return [p[0] for p in pairs], {"season":2026, "cards":[c for p in pairs for c in p[1]["cards"]]}
`;
function py(body) {
  return JSON.parse(execFileSync('python3', ['-'], { cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: ROOT }, input: FIXTURE + '\n' + body,
  }).trim().split('\n').pop());
}

test('new immutable receipts learn from base, not served; legacy rows are quarantined', () => {
  const r = py(`
doc, scores = fixture(correction={"a":.580223,"b":.969067})
rows,audit = bt.live_rows([doc],scores,True)
receipt=doc["cards"][0]["legs"][0]["learning_receipt"]
legacy=copy.deepcopy(doc); del legacy["cards"][0]["legs"][0]["learning_receipt"]
old, quarantine=bt.live_rows([legacy],scores,True)
print(json.dumps({"rows":rows,"audit":audit,"receipt":receipt,"old":old,"quarantine":quarantine,
 "double":lr.serve_probability(receipt["served_prob"],receipt["calibrator"])}))
`);
  assert.equal(r.rows.length, 1);
  assert.ok(Math.abs(r.rows[0].p - .374058) < 1e-15);
  assert.equal(r.rows[0].served_prob, .5203);
  assert.equal(r.double, .659);
  assert.equal(r.receipt.comparison_operator, 'gte');
  assert.equal(r.receipt.line, 59.5);
  assert.equal(r.receipt.publication_status, 'generated_unverified');
  assert.match(r.audit.eligibility, /public availability unverified/);
  assert.deepEqual(r.old, []);
  assert.equal(r.quarantine.quarantine_reasons.missing_or_unsupported_receipt, 1);
});

test('canonical identity survives reordering, abbreviated-name collisions, and player trades', () => {
  const r = py(`
pairs=[fixture(pid="player-A",gid="game-A"), fixture(pid="player-B",gid="game-A"),
       fixture(pid="player-A",gid="game-B")]
docs,scores=combine(pairs)
rows=bt.live_rows(docs,scores)
docs.reverse(); scores["cards"].reverse()
reordered=bt.live_rows(docs+docs,scores)
renamed=copy.deepcopy(scores)
for card in renamed["cards"]: card["legs"][0]["selection"]="Different display spelling"
renamed_rows=bt.live_rows(docs,renamed)
leg=docs[0]["cards"][0]["legs"][0]
int_leg={**leg,"line":60}; float_leg={**leg,"line":60.0}
print(json.dumps({"rows":rows,"reordered":reordered,"renamed":renamed_rows,
 "numeric_same":lr.canonical_key(int_leg,2026)==lr.canonical_key(float_leg,2026)}))
`);
  assert.equal(r.rows.length, 3);
  assert.equal(new Set(r.rows.map(x => x.contract_id)).size, 3);
  assert.deepEqual(r.rows, r.reordered);
  assert.deepEqual(r.rows, r.renamed);
  assert.equal(r.numeric_same, true);
});

test('ambiguous identities, receipt tampering, future sources, late issuance and contradictory outcomes fail closed', () => {
  const r = py(`
results={}
for kind in ("tamper","served","future","late","partial_identity","receipt_id","source_shape","bool_version","features"):
    doc,scores=fixture()
    leg=doc["cards"][0]["legs"][0]; receipt=leg["learning_receipt"]
    if kind=="tamper": receipt["base_prob"] = .7
    if kind=="served": leg["model_prob"] = .9
    if kind=="future": receipt["source_timestamps"]["fixture"]="2027-01-01T00:00:00Z"
    if kind=="late": doc["cards"][0]["first_seen_utc"]=doc["cards"][0]["earliest_kickoff_utc"]
    if kind=="partial_identity":
        scores["cards"][0]["legs"][0]["gsis_id"]="wrong-player"
        del scores["cards"][0]["legs"][0]["line"]
    if kind=="receipt_id": scores["cards"][0]["legs"][0]["receipt_id"]="wrong"
    if kind=="source_shape": receipt["source_timestamps"]=[]
    if kind=="bool_version": receipt["version"]=True
    if kind=="features": receipt["features"]["mu"]+=1
    if kind in ("future","source_shape","features"):
        receipt["receipt_id"]=lr.fingerprint({k:v for k,v in receipt.items() if k!="receipt_id"})
    rows,audit=bt.live_rows([doc],scores,True)
    results[kind]={"n":len(rows),"reasons":audit["quarantine_reasons"]}
pairs=[fixture(card_id="one",y=1),fixture(card_id="two",y=0)]
docs,scores=combine(pairs)
rows,audit=bt.live_rows(docs,scores,True)
results["conflicting_outcome"]={"n":len(rows),"reasons":audit["quarantine_reasons"]}
docs,scores=combine([fixture(card_id="one",p=.4),fixture(card_id="two",p=.6)])
rows,audit=bt.live_rows(docs,scores,True)
results["conflicting_first_forecast"]={"n":len(rows),"reasons":audit["quarantine_reasons"]}
print(json.dumps(results))
`);
  for (const [name, result] of Object.entries(r)) {
    assert.equal(result.n, 0, name);
    assert.ok(Object.keys(result.reasons).length, name);
  }
});

test('two learning cycles preserve immutable bases and evaluate exactly the deployed transform', () => {
  const r = py(`
rnd=random.Random(7); pairs=[]
for week in (2,3,4):
    for i in range(200):
        p=.3+.5*rnd.random(); y=int(rnd.random()<min(p+.14,.98))
        pairs.append(fixture(week=week,pid=str(i),p=p,y=y))
docs,scores=combine(pairs); first_rows=bt.live_rows(docs,scores)
first=bt.live_recalibration(first_rows,BASE_VERSION)
assert first["applied"], first
frozen=copy.deepcopy(docs)
for i in range(200):
    p=.3+.5*rnd.random(); y=int(rnd.random()<min(p+.14,.98))
    pairs.append(fixture(week=5,pid=str(i),p=p,y=y,correction=first["adjustment"]))
docs,scores=combine(pairs); rows=bt.live_rows(docs,scores)
second=bt.live_recalibration(rows,BASE_VERSION)
manual=[]
for fold in second["per_week"]:
    ab=bt.recal_fit([r for r in rows if r["week"]<fold["week"]])
    adjustment={"a":round(ab[0],6),"b":round(ab[1],6)}
    observed=[r for r in rows if r["week"]==fold["week"]]
    manual.append(round(bt._ll([(lr.serve_probability(r["p"],adjustment),r["y"]) for r in observed]),4)==fold["adjusted_log_loss"])
future=copy.deepcopy(rows)
for row in future:
    if row["week"]==5: row["y"]=1-row["y"]
changed=bt.live_recalibration(future,BASE_VERSION)
print(json.dumps({"first_applied":first["applied"],"second":second,
 "old_immutable":docs[:len(frozen)]==frozen,
 "cycle2_uses_base":all(r["p"]!=r["served_prob"] for r in rows if r["week"]==5),
 "count":len(rows),"manual":manual,
 "no_future_leak":changed["per_week"][:2]==second["per_week"][:2]}))
`);
  assert.equal(r.first_applied, true, 'new receipts can earn adoption');
  assert.equal(r.old_immutable, true);
  assert.equal(r.cycle2_uses_base, true);
  assert.equal(r.count, 800);
  assert.ok(r.manual.length >= 2 && r.manual.every(Boolean));
  assert.equal(r.no_future_leak, true);
  assert.equal(r.second.receipt_policy, 'base_receipt_v1');
});

test('pool→MY archive preserves receipts; legacy/mismatched decisions cannot authorize a layer', () => {
  const r = py(`
from scripts import build_leg_pool as pool, build_my_cards as cards
from scripts.validate_data import validate_against_schema, ValidationError
inputs=pool.load_inputs(); inputs["generated_utc"]="2026-10-14T12:00:00Z"
baseline=pool.build(inputs)
version=baseline["base_model_version"]
for source in ("player_weekly","player_projections","game_predictions","pool_backtest"):
    inputs[source]=copy.deepcopy(inputs[source])
    inputs[source]["generated_utc"]="2026-10-14T11:00:00Z"
def decision(policy,ver):
    inputs["pool_backtest"]["live_2026"]={"applied":True,"adjustment":{"a":.4,"b":1.1},
      "receipt_policy":policy,"base_model_version":ver}
    return pool.build(inputs)
legacy=decision(None,version); mismatch=decision(lr.POLICY,"different-base")
modern=decision(lr.POLICY,version)
modern_schema=json.load(open("data/contracts/leg_pool.schema.json"))
validate_against_schema(modern,modern_schema,"modern")
validate_against_schema(json.load(open("data/leg_pool.json")),modern_schema,"legacy")
games=json.load(open("data/schedule_full.json"))["games"]
offered,_=cards.offered_cards(modern,games,None,modern["generated_utc"])
records=[cards.card_record(d,s,r,c,cards.kickoff_index(games)) for d,s,r,c in offered]
archive=cards.append(None,records,modern["season"],modern["week"],modern["generated_utc"],modern["generated_utc"])
validate_against_schema(archive,json.load(open("data/contracts/my_cards.schema.json")),"archive")
recorded=[leg for card in archive["cards"] for leg in card["legs"] if leg.get("learning_receipt")]
source_receipts={r["learning_receipt"]["receipt_id"]:r["learning_receipt"] for p in modern["players"] for r in p["rungs"]}
inputs["generated_utc"]="2026-10-15T12:00:00Z"; later=pool.build(inputs)
broken=copy.deepcopy(modern)
del broken["players"][0]["rungs"][0]["learning_receipt"]["base_prob"]
try: validate_against_schema(broken,modern_schema,"broken"); rejected=False
except ValidationError: rejected=True
print(json.dumps({"legacy":legacy["live_adjustment"],"mismatch":mismatch["live_adjustment"],
 "modern":modern["live_adjustment"],"stable_base":version==modern["base_model_version"]==later["base_model_version"],
 "recorded":len(recorded),"preserved":all(l["learning_receipt"]==source_receipts[l["learning_receipt"]["receipt_id"]] for l in recorded),
 "features_preserved":all(l["learning_receipt"]["features"]==source_receipts[l["learning_receipt"]["receipt_id"]]["features"] for l in recorded),
 "rejected":rejected}))
`);
  assert.equal(r.legacy, null);
  assert.equal(r.mismatch, null);
  assert.deepEqual(r.modern, { a: .4, b: 1.1 });
  assert.equal(r.stable_base, true);
  assert.ok(r.recorded > 0);
  assert.equal(r.preserved, true);
  assert.equal(r.features_preserved, true);
  assert.equal(r.rejected, true);
});

test('production backtest admits new same-base receipts and reports incompatible bases without inventing them', () => {
  const r = py(`
from scripts.validate_data import validate_against_schema
historic=bt._synthetic(signal=1,n_players=10,weeks=4)
empty=bt.build(rows=historic,live=[])
BASE_VERSION=empty["live_2026"]["base_model_version"]
rnd=random.Random(7); pairs=[]
for week in (2,3,4):
    for i in range(200):
        p=.3+.5*rnd.random(); y=int(rnd.random()<min(p+.14,.98))
        pairs.append(fixture(week=week,pid=str(i),p=p,y=y))
docs,scores=combine(pairs); rows=bt.live_rows(docs,scores)
rows.append({**rows[0],"base_model_version":"other-base"})
result=bt.build(rows=historic,live=rows)
validate_against_schema(result,json.load(open("data/contracts/leg_pool_backtest.schema.json")),"result")
print(json.dumps({"live":result["live_2026"],"coef_version_changes":
 lr.base_version({"WR":{"a":0,"b":1,"c":0}},{"WR":30}) !=
 lr.base_version({"WR":{"a":.1,"b":1,"c":0}},{"WR":30})}))
`);
  assert.equal(r.live.applied, true);
  assert.equal(r.live.legs, 600);
  assert.equal(r.live.lineage.eligible_unique_legs, 600);
  assert.equal(r.live.lineage.quarantine_reasons.different_base_version, 1);
  assert.equal(r.live.lineage.quarantined_records, 1);
  assert.equal(r.coef_version_changes, true);
});

test('one leg graded on several cards is one observation', () => {
  const r = py(`
docs,scores=combine([fixture(card_id="one",y=1),fixture(card_id="two",y=1)])
rows,audit=bt.live_rows(docs,scores,True)
print(json.dumps({"rows":rows}))
`);
  assert.equal(r.rows.length, 1, 'the repeated leg counts once');
  assert.equal(r.rows[0].y, 1);
});
