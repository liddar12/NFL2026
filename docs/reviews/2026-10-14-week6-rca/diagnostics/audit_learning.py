"""Read-only learning RCA: committed artifacts and actual historical probability chain."""
import collections
import glob
import json
import math
import os
import subprocess
import sys

ROOT = os.path.abspath(sys.argv[1])
AUDIT_BASELINE = 'fb8830ae35f1e11d3f589b435e303b719886e3e7'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() == AUDIT_BASELINE, 'Use an isolated checkout at the pinned audit baseline.'
sys.path.insert(0, ROOT)
os.chdir(ROOT)
from scripts import backtest_leg_pool as bp
from scripts import build_learning_loops as loops


def read(path):
    with open(path) as fh:
        return json.load(fh)


def gitjson(commit, path):
    return json.loads(subprocess.check_output(["git", "show", commit + ":" + path]))


def sig(z):
    return 1 / (1 + math.exp(-z))


def logit(p):
    return math.log(p / (1-p))


def ll(rows):
    return sum(-(r["y"] * math.log(r["p"]) + (1-r["y"])*math.log(1-r["p"])) for r in rows) / len(rows)


report = {}
mt = read("data/model_tuning.json")
promos = [h for h in mt["history"] if h["kind"] == "signal_promotion"]
report["promotion_reporting"] = {
    "reported": loops.game_signals({"model_tuning.json": mt}),
    "latest_actual": {k: max(promos, key=lambda h:h["generated_utc"]).get(k) for k in ["generated_utc", "adopted", "write_mode", "reason", "would_adopt", "families_runnable", "market_baseline"]},
    "in_season_adoptions": [h for h in promos if h["generated_utc"] >= "2026-09-01" and h.get("adopted")],
}
report["historical_pool_layers"] = []
for commit in ["c4e308cd", "d0e2c88b", "b685eb40", "7d2c4fec"]:
    d = gitjson(commit, "data/leg_pool_backtest.json")
    report["historical_pool_layers"].append({"commit":commit, "generated_utc":d["generated_utc"], "live_2026":d.get("live_2026")})

# Oct6's first subsequent daily pipeline consumed the adopted correction.
commit = "7344a76d"
pool = gitjson(commit, "data/leg_pool.json")
cal = gitjson(commit, "data/leg_pool_backtest.json")
cards = read("data/my_cards/2026_wk05.json")
layer = cal["live_2026"]["adjustment"]
offered = {}
for card in cards["cards"]:
    for leg in card["legs"]:
        if leg.get("mu") is not None:
            offered.setdefault(leg["selection"], {**leg, "first_seen_utc":card["first_seen_utc"]})

pool_rows = pool.get("players", pool.get("legs", []))
if isinstance(pool_rows, dict):
    pool_rows = list(pool_rows.values())
examples = []
for player in pool_rows:
    coef = cal["calibration"][player["position"]]
    for rung in player["rungs"]:
        leg = offered.get(rung["selection"])
        if not leg or leg["first_seen_utc"] != cards["generated_utc"] and abs(leg["model_prob"]-rung["model_prob"]) > .00005:
            continue
        raw = sig(coef["a"] + coef["b"]*rung["z"] + coef["c"]*(player["p_team"]-.5))
        once = sig(layer["a"] + layer["b"]*logit(raw))
        twice = sig(layer["a"] + layer["b"]*logit(leg["model_prob"]))
        if abs(once-rung["model_prob"]) < .00015 and abs(raw-rung["model_prob"]) > .02:
            examples.append({"selection":leg["selection"], "first_seen_utc":leg["first_seen_utc"], "raw_base_reconstructed":round(raw,6), "pool_probability":rung["model_prob"], "ledger_probability":leg["model_prob"], "once_reconstructed":round(once,6), "gate_applies_second_layer":round(twice,6)})
report["real_probability_chain"] = {"commit":commit,"pool_generated":pool.get("generated_utc"),"pool_keys":list(pool),"live_adjustment":pool.get("live_adjustment"),"matching_examples":len(examples),"examples":examples[:12]}

live = bp.load_live_rows()
byweek = collections.defaultdict(list)
for row in live:
    byweek[row["week"]].append(row)
report["pool_observed_by_week"] = [{"week":w,"n":len(rows),"mean_p":round(sum(r["p"] for r in rows)/len(rows),6),"hits":sum(r["y"] for r in rows),"log_loss":round(ll(rows),6)} for w,rows in sorted(byweek.items())]
report["week5_first_recorded_unique_props"] = dict(collections.Counter("pre_layer" if r["first_seen_utc"] < cal["generated_utc"] else "after_layer_adoption" for r in offered.values()))

report["artifact_metrics"] = {f:read("data/"+f+".json").get("live_2026") for f in ["weekly_backtest","parlay_backtest"]}
report["pregame_slate_calibration"] = []
for week, before in [(1,"2026-09-10T00:00:00Z"),(2,"2026-09-18T00:00:00Z"),(3,"2026-09-25T00:00:00Z"),(4,"2026-10-02T00:00:00Z"),(5,"2026-10-09T00:00:00Z"),(6,"2026-10-14T23:00:00Z")]:
    c = subprocess.check_output(["git", "rev-list", "-1", "--before="+before, "HEAD"],text=True).strip()
    d = gitjson(c,"data/parlay_backtest.json")
    report["pregame_slate_calibration"].append({"week":week,"commit":c[:8],"generated_utc":d["generated_utc"],"live_refit":(d.get("live_2026") or {}).get("refit"),"calibration":d["props"]["calibration"]})
old = report["pregame_slate_calibration"][3]["calibration"]
new = report["pregame_slate_calibration"][4]["calibration"]
cf = []
for leg in read("data/parlay_leg_scores.json")["resolved"]:
    if leg["week"] != 5 or leg.get("z") is None:
        continue
    r={"selection":leg["selection"],"y":int(leg["hit"]),"served":leg["model_prob"]}
    for name, coefs in [("old",old),("new",new)]:
        c=coefs[leg["position"]]
        p=sig(c["a"]+c["b"]*leg["z"]+c["c"]*(leg["p_team"]-.5))
        r[name]=min(.95,max(.05,p))
    cf.append(r)
report["slate_week5_same_legs_coefficient_counterfactual"]={"n":len(cf),"hits":sum(r["y"] for r in cf),"probability_change_abs_max":max(abs(r["new"]-r["old"]) for r in cf),"probability_change_abs_mean":sum(abs(r["new"]-r["old"]) for r in cf)/len(cf),"sides_crossing_half":sum((r["old"]>.5)!=(r["new"]>.5) for r in cf),"log_loss":{name:ll([{"p":r[name],"y":r["y"]} for r in cf]) for name in ["old","new","served"]},"note":"Same locked W5 z/p_team and fixed offered legs; excludes selection changes and whole-card joint outcomes. Historic clamp checked separately."}
print(json.dumps(report, indent=2))
