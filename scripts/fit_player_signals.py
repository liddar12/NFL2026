#!/usr/bin/env python3
"""Walk-forward player-signal fit on the resolved estimate ledger (R49, step 3).

Reads data/estimate_scores.json (scripts/resolve_estimates.py) through
scripts/harness/ledger_objective and, for every resolved week after the first,
fits candidate signal weights on the weeks BEFORE it and scores them on it —
leak-safe by construction. Candidate vs the GATED incumbent (the gate-conforming
series every ledger row carries; shipped == candidate under the R49 owner
override, so comparing shipped to itself would measure nothing) is decided by
scripts/optimize/never_regress.should_adopt with the objective's own margin
(ledger_objective.ADOPTION_MARGIN_MAE, 0.10 PPR points/player-week):

    adopt iff candidate_mae < gated_mae - 0.10     (held-out, all folds pooled)

Two candidate numbers are reported: the SHIPPED candidate as recorded on the
locked rows (full-strength signals) and the REFIT candidate (weights fitted on
earlier weeks); `would_adopt` refers to the refit, `shipped_vs_gated` to the
number that actually shipped.

WHAT THIS NEVER DOES: change data/meta.json weights. Like scripts/promote_signals.py
--propose (owner decision, R26), --propose ARCHIVES the run into
data/model_tuning.json `history` with `would_adopt`, and applying a weight stays a
deliberate human act.

R100 — AUTOMATIC ADOPTION FOR THE NUMBER THAT SHIPS (owner, 2026-09-24: "enable the
self learning ai based on the results of this season"). Under the R49 override the
shipped projection is the candidate, and until now it ran every signal at full
strength with no way for this season's results to change that: the loop above could
only write a proposal, and its incumbent was the gated series, which never ships.
--adopt closes the loop, against the number that DOES ship:

    incumbent  = the candidate under model_tuning.json:"candidate_signal_weights"
                 (absent = every signal at 1.0, the pre-R100 number)
    adopt   iff >= ADOPT_MIN_FOLDS held-out weeks, pooled held-out MAE beats the
                 incumbent by the margin, NO single held-out week is worse, and the
                 fitted weights differ from the incumbent's
    revert  iff learned weights are live and the full-strength default beats them
                 on the pooled held-out weeks — no margin: a learned change that
                 stops earning its place is undone first and argued about later

Every run archives the decision; adoption writes the weights with a receipt that
scripts/validate_data.py checks. meta.json is never touched. With 0 resolved weeks the objective refuses (LedgerNotReady)
and this script exits 0 after saying so — nothing is written, nothing is invented.
With ONE resolved week there is no held-out fold: the entry is archived with
`verdict: "refused"` and the reason (R53) — the MODEL tab's LEARNING RECORD shows
that verdict as the last proposal. Two or more weeks: "propose" when the refit
clears the margin, else "retain".

Grid: one coordinate pass over every signal the resolved rows carry, weights in
{0, 0.25, 0.5, 0.75, 1.0}, starting from the incumbent. Stdlib only.
"""

import argparse
import datetime as dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.harness import ledger_objective as lo  # noqa: E402
from scripts.optimize.never_regress import should_adopt  # noqa: E402

DATA = os.path.join(_ROOT, "data")
SCORES_PATH = os.path.join(DATA, "estimate_scores.json")
META_PATH = os.path.join(DATA, "meta.json")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
GRID = (0.0, 0.25, 0.5, 0.75, 1.0)
ADOPT_MIN_FOLDS = 2      # held-out weeks before the shipped number may move
TUNING_KEY = "candidate_signal_weights"


def fit_weights(rows, start):
    """One coordinate pass over the signals present in `rows`. Pure."""
    best = {k: float(v) for k, v in (start or {}).items()}
    names = lo.signal_names(rows)
    for name in names:
        best.setdefault(name, 0.0)
        scored = []
        for w in GRID:
            trial = dict(best)
            trial[name] = w
            scored.append((lo.objective(rows, trial), w))
        scored.sort()
        best[name] = scored[0][1]
    return {k: best[k] for k in names}


def walk_forward(rows, current):
    """Held-out MAE of the incumbent vs freshly fitted weights, pooled over folds."""
    folds = lo.walk_forward_folds(rows)
    if not folds:
        return {"folds": 0, "current_mae": None, "candidate_mae": None,
                "shipped_candidate_mae": None, "candidate_weights": {}, "held_out_rows": 0}
    cur_err, cand_err, ship_err, n = 0.0, 0.0, 0.0, 0
    last_weights = {}
    for fit_rows, held, _wk in folds:
        w = fit_weights(fit_rows, {k: current.get(k, 0.0) for k in lo.signal_names(rows)})
        last_weights = w
        for r in held:
            cur_err += abs(lo.gated_value(r) - float(r["actual"]))       # the incumbent
            cand_err += abs(lo.estimate(r, w) - float(r["actual"]))      # the refit
            ship_err += abs(float(r["candidate"]) - float(r["actual"]))  # as shipped
            n += 1
    return {"folds": len(folds), "current_mae": round(cur_err / n, 4),
            "candidate_mae": round(cand_err / n, 4),
            "shipped_candidate_mae": round(ship_err / n, 4),
            "candidate_weights": last_weights, "held_out_rows": n}


def _mae(rows, w):
    return sum(abs(lo.estimate(r, w) - float(r["actual"])) for r in rows) / len(rows)


def incumbent_weights(tuning, names):
    """The candidate weights shipping now: adopted ones, else full strength (1.0)."""
    adopted = ((tuning or {}).get(TUNING_KEY) or {}).get("weights") or {}
    return {n: float(adopted.get(n, 1.0)) for n in names}


def shipped_walk_forward(rows, incumbent):
    """Per held-out week: incumbent (what ships), refit, and full strength. Pure."""
    names = lo.signal_names(rows)
    ones = {n: 1.0 for n in names}
    per, n = [], 0
    tot = {"incumbent": 0.0, "candidate": 0.0, "full": 0.0}
    for fit_rows, held, wk in lo.walk_forward_folds(rows):
        w = fit_weights(fit_rows, dict(incumbent))
        row = {"week": wk, "n": len(held),
               "incumbent_mae": round(_mae(held, incumbent), 4),
               "candidate_mae": round(_mae(held, w), 4),
               "full_strength_mae": round(_mae(held, ones), 4),
               "weights": w}
        per.append(row)
        tot["incumbent"] += _mae(held, incumbent) * len(held)
        tot["candidate"] += _mae(held, w) * len(held)
        tot["full"] += _mae(held, ones) * len(held)
        n += len(held)
    if not n:
        return {"folds": 0, "per_fold": [], "incumbent_mae": None, "candidate_mae": None,
                "full_strength_mae": None, "held_out_rows": 0}
    return {"folds": len(per), "per_fold": per, "held_out_rows": n,
            "incumbent_mae": round(tot["incumbent"] / n, 4),
            "candidate_mae": round(tot["candidate"] / n, 4),
            "full_strength_mae": round(tot["full"] / n, 4)}


def adoption_decision(wf, incumbent, final_weights, margin):
    """('adopt'|'revert'|'hold', reason). Pure — the whole R100 rule in one place."""
    if wf["folds"] < ADOPT_MIN_FOLDS:
        return "hold", ("the shipped number moves only on >= %d held-out weeks; %d so far"
                        % (ADOPT_MIN_FOLDS, wf["folds"]))
    learned_live = any(v != 1.0 for v in incumbent.values())
    if learned_live and wf["full_strength_mae"] < wf["incumbent_mae"]:
        return "revert", ("the learned weights now lose to full strength on held-out "
                          "weeks (%.4f vs %.4f) — reverted" % (wf["full_strength_mae"],
                                                               wf["incumbent_mae"]))
    worse = [f["week"] for f in wf["per_fold"] if f["candidate_mae"] > f["incumbent_mae"]]
    gain = wf["incumbent_mae"] - wf["candidate_mae"]
    if worse:
        return "hold", "the refit is worse on held-out week(s) %s" % worse
    if gain < margin:
        return "hold", ("the refit beats what ships by %.4f, under the %.2f margin"
                        % (gain, margin))
    if final_weights == incumbent:
        return "hold", "the refit is the weights already shipping"
    return "adopt", ("the refit beats what ships by %.4f on %d held-out weeks, none worse"
                     % (gain, wf["folds"]))


def run(scores_path=SCORES_PATH, meta_path=META_PATH, tuning_path=TUNING_PATH,
        propose=False, now=None, adopt=False):
    with open(scores_path, encoding="utf-8") as fh:
        scores = json.load(fh)
    with open(meta_path, encoding="utf-8") as fh:
        current = {k: float(v) for k, v in json.load(fh).get("weights", {}).items()}
    try:
        rows = lo.load_resolved(scores)
    except lo.LedgerNotReady as exc:
        print("[fit_player_signals] not ready, nothing fitted, nothing written: %s" % exc,
              file=sys.stderr)
        return None
    wf = walk_forward(rows, current)
    margin = lo.ADOPTION_MARGIN_MAE
    would = (wf["folds"] > 0 and
             should_adopt(wf["current_mae"], wf["candidate_mae"], margin))
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "generated_utc": now,
        "kind": "player_signal_fit",
        "source": "scripts/fit_player_signals.py walk-forward over the resolved estimate "
                  "ledger (data/estimate_scores.json)",
        "objective": lo.OBJECTIVE,
        "margin": margin,
        "weeks_resolved": scores["weeks_resolved"],
        "rows_resolved": len(rows),
        "folds": wf["folds"],
        "held_out_rows": wf["held_out_rows"],
        "incumbent": "gated series (gate-conforming number on every ledger row)",
        "current_mae": wf["current_mae"],
        "gated_mae": wf["current_mae"],
        "candidate_mae": wf["candidate_mae"],
        "shipped_candidate_mae": wf["shipped_candidate_mae"],
        "shipped_vs_gated": (None if wf["folds"] == 0 else
                             round(wf["current_mae"] - wf["shipped_candidate_mae"], 4)),
        "improvement": (None if wf["folds"] == 0
                        else round(wf["current_mae"] - wf["candidate_mae"], 4)),
        "in_sample_rank_corr": lo.rank_corr(rows, current),
        "candidate_weights": wf["candidate_weights"],
        "would_adopt": bool(would),
        "adopted": False,
        "verdict": ("refused" if wf["folds"] == 0 else ("propose" if would else "retain")),
        "reason": ("walk-forward needs >= 2 resolved weeks for a held-out fold; "
                   "nothing can be adopted on one week" if wf["folds"] == 0 else
                   ("candidate clears the %.2f-point margin — adoption is a manual "
                    "act (apply the weights in data/meta.json after review)" % margin
                    if would else
                    "NEVER REGRESS: candidate does not beat the incumbent by the "
                    "%.2f-point margin; weights unchanged" % margin)),
    }
    # R100 — the same resolved rows, judged against the number that SHIPS.
    tuning = {}
    if os.path.exists(tuning_path):
        with open(tuning_path, encoding="utf-8") as fh:
            tuning = json.load(fh)
    names = lo.signal_names(rows)
    incumbent = incumbent_weights(tuning, names)
    swf = shipped_walk_forward(rows, incumbent)
    final = fit_weights(rows, dict(incumbent)) if swf["folds"] else dict(incumbent)
    action, why = adoption_decision(swf, incumbent, final, margin)
    entry["auto"] = {"action": action, "reason": why, "incumbent_weights": incumbent,
                     "fitted_weights": final, "folds": swf["folds"],
                     "held_out_rows": swf["held_out_rows"],
                     "incumbent_mae": swf["incumbent_mae"],
                     "candidate_mae": swf["candidate_mae"],
                     "full_strength_mae": swf["full_strength_mae"],
                     "per_fold": swf["per_fold"], "applied": False}
    print("fit_player_signals: weeks=%d rows=%d folds=%d current_mae=%s candidate_mae=%s "
          "would_adopt=%s verdict=%s" % (entry["weeks_resolved"], entry["rows_resolved"],
                                         entry["folds"], entry["current_mae"],
                                         entry["candidate_mae"], entry["would_adopt"],
                                         entry["verdict"]))
    print("fit_player_signals: vs what SHIPS -> %s: %s" % (action, why))
    if adopt and action in ("adopt", "revert"):
        new_w = final if action == "adopt" else {n: 1.0 for n in names}
        tuning[TUNING_KEY] = {
            "weights": new_w, "adopted_utc": now, "kind": action,
            "source": "scripts/fit_player_signals.py --adopt (R100)",
            "weeks_resolved": scores["weeks_resolved"], "folds": swf["folds"],
            "held_out_rows": swf["held_out_rows"], "margin": margin,
            "incumbent_mae": swf["incumbent_mae"], "candidate_mae": swf["candidate_mae"],
            "full_strength_mae": swf["full_strength_mae"], "per_fold": swf["per_fold"],
            "reason": why,
        }
        entry["auto"]["applied"] = True
        entry["adopted"] = action == "adopt"
        propose = True          # an applied change is always archived
    if propose:
        tuning.setdefault("history", []).append(entry)
        with open(tuning_path, "w", encoding="utf-8") as fh:
            json.dump(tuning, fh, ensure_ascii=True, indent=2, sort_keys=False)
            fh.write("\n")
        print("archived to %s history (adopted=false; would_adopt=%s)"
              % (tuning_path, entry["would_adopt"]))
    return entry


# --------------------------------------------------------------------------- #
# selftest — the refusal, the leak-safe folds, the margin                        #
# --------------------------------------------------------------------------- #

def _rows(weeks, adj=1.2, true_w=1.0):
    out = []
    for wk in weeks:
        for i in range(6):
            base = 8.0 + 2.0 * i
            out.append({"gsis_id": "p%d" % i, "week": wk, "position": "RB",
                        "baseline": base, "shipped": base * adj, "gated": base,
                        "candidate": base * adj, "low": base * 0.8, "high": base * 1.4,
                        "actual": base * (1.0 + true_w * (adj - 1.0)),
                        "signals": {"age_curve": adj}})
    return out


def selftest():
    # 0 resolved weeks: the objective REFUSES, no number comes out.
    try:
        lo.load_resolved({"weeks_resolved": 0, "resolved": [], "skipped": "no rows"})
        raise AssertionError("must refuse with 0 resolved weeks")
    except lo.LedgerNotReady as exc:
        assert "0 week" in str(exc)
    # 1 resolved week: readable, but zero walk-forward folds -> nothing adoptable.
    one = _rows([1])
    assert lo.load_resolved({"weeks_resolved": 1, "resolved": one}) == one
    wf1 = walk_forward(one, {"age_curve": 0.0})
    assert wf1["folds"] == 0 and wf1["candidate_mae"] is None
    # 3 resolved weeks where the truth IS the signal at weight 1: the fit finds it
    # on earlier weeks and the held-out MAE beats the incumbent by > margin.
    three = _rows([1, 2, 3])
    wf = walk_forward(three, {"age_curve": 0.0})
    assert wf["folds"] == 2 and wf["candidate_weights"] == {"age_curve": 1.0}, wf
    assert wf["candidate_mae"] < wf["current_mae"] - lo.ADOPTION_MARGIN_MAE
    assert wf["current_mae"] == round(lo.gated_objective(
        [r for r in three if r["week"] > 1]), 4), "the incumbent IS the gated series"
    assert wf["shipped_candidate_mae"] < 1e-9, "the shipped candidate was exactly right here"
    assert should_adopt(wf["current_mae"], wf["candidate_mae"], lo.ADOPTION_MARGIN_MAE)
    # ...and when the truth is the baseline, weight 0 wins and nothing is adopted.
    flat = _rows([1, 2, 3], true_w=0.0)
    wf0 = walk_forward(flat, {"age_curve": 0.0})
    assert wf0["candidate_weights"] == {"age_curve": 0.0}
    assert not should_adopt(wf0["current_mae"], wf0["candidate_mae"], lo.ADOPTION_MARGIN_MAE)
    # folds never see their own week
    for fit, held, wk in lo.walk_forward_folds(three):
        assert all(r["week"] < wk for r in fit) and all(r["week"] == wk for r in held)
    # R53: the archived verdict — one week REFUSES with its reason, two weeks PROPOSE
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        paths = {k: os.path.join(tmp, k + ".json") for k in ("scores", "meta", "tuning")}
        with open(paths["meta"], "w") as fh:
            json.dump({"weights": {"age_curve": 0.0}}, fh)
        for weeks, want in (([1], "refused"), ([1, 2], "propose")):
            with open(paths["scores"], "w") as fh:
                json.dump({"weeks_resolved": len(weeks), "resolved": _rows(weeks)}, fh)
            with open(paths["tuning"], "w") as fh:
                json.dump({"history": []}, fh)
            e = run(paths["scores"], paths["meta"], paths["tuning"], propose=True, now="t")
            assert e["verdict"] == want and e["adopted"] is False, (weeks, e["verdict"])
            with open(paths["tuning"]) as fh:
                hist = json.load(fh)["history"]
            assert hist[-1]["verdict"] == want and hist[-1]["kind"] == "player_signal_fit"
        assert hist[-1]["would_adopt"] is True and hist[-1]["folds"] == 1
        with open(paths["scores"], "w") as fh:
            json.dump({"weeks_resolved": 1, "resolved": _rows([1])}, fh)
        r1 = run(paths["scores"], paths["meta"], paths["tuning"], propose=False, now="t")
        assert r1["folds"] == 0 and r1["would_adopt"] is False \
            and ">= 2 resolved weeks" in r1["reason"], r1["reason"]
        with open(paths["scores"], "w") as fh:
            json.dump({"weeks_resolved": 0, "resolved": [], "skipped": "no rows"}, fh)
        assert run(paths["scores"], paths["meta"], paths["tuning"], propose=True) is None, \
            "0 weeks: nothing fitted, nothing archived"
    print("selftest OK: refuses at 0 resolved weeks, 1 week gives no fold (verdict "
          "refused, reason archived), two weeks propose, walk-forward recovers a true "
          "signal, never-regress margin gates adoption")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--propose", action="store_true",
                    help="archive the run into data/model_tuning.json history "
                         "(never applies weights)")
    ap.add_argument("--adopt", action="store_true",
                    help="R100: apply the decision to the SHIPPED candidate weights "
                         "(model_tuning.json candidate_signal_weights) when it passes")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    if not os.path.exists(SCORES_PATH):
        print("[fit_player_signals] %s absent — run scripts/resolve_estimates.py first"
              % SCORES_PATH, file=sys.stderr)
        return 0
    run(propose=args.propose, adopt=args.adopt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
