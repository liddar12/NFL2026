#!/usr/bin/env python3
"""Walk-forward player-signal fit on the resolved estimate ledger (R49, step 3).

Reads data/estimate_scores.json (scripts/resolve_estimates.py) through
scripts/harness/ledger_objective and, for every resolved week after the first,
fits candidate signal weights on the weeks BEFORE it and scores them on it —
leak-safe by construction. Candidate vs incumbent (data/meta.json weights) is
decided by scripts/optimize/never_regress.should_adopt with the objective's own
margin (ledger_objective.ADOPTION_MARGIN_MAE, 0.10 PPR points/player-week):

    adopt iff candidate_mae < current_mae - 0.10   (held-out, all folds pooled)

WHAT THIS NEVER DOES: change data/meta.json weights. Like scripts/promote_signals.py
--propose (owner decision, R26), --propose ARCHIVES the run into
data/model_tuning.json `history` with `would_adopt`, and applying a weight stays a
deliberate human act. With 0 resolved weeks the objective refuses (LedgerNotReady)
and this script exits 0 after saying so — nothing is written, nothing is invented.

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
                "candidate_weights": {}, "held_out_rows": 0}
    cur_err, cand_err, n = 0.0, 0.0, 0
    last_weights = {}
    for fit_rows, held, _wk in folds:
        w = fit_weights(fit_rows, {k: current.get(k, 0.0) for k in lo.signal_names(rows)})
        last_weights = w
        for r in held:
            cur_err += abs(lo.estimate(r, current) - float(r["actual"]))
            cand_err += abs(lo.estimate(r, w) - float(r["actual"]))
            n += 1
    return {"folds": len(folds), "current_mae": round(cur_err / n, 4),
            "candidate_mae": round(cand_err / n, 4), "candidate_weights": last_weights,
            "held_out_rows": n}


def run(scores_path=SCORES_PATH, meta_path=META_PATH, tuning_path=TUNING_PATH,
        propose=False, now=None):
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
        "current_mae": wf["current_mae"],
        "candidate_mae": wf["candidate_mae"],
        "improvement": (None if wf["folds"] == 0
                        else round(wf["current_mae"] - wf["candidate_mae"], 4)),
        "in_sample_rank_corr": lo.rank_corr(rows, current),
        "candidate_weights": wf["candidate_weights"],
        "would_adopt": bool(would),
        "adopted": False,
        "reason": ("walk-forward needs >= 2 resolved weeks for a held-out fold; "
                   "nothing can be adopted on one week" if wf["folds"] == 0 else
                   ("candidate clears the %.2f-point margin — adoption is a manual "
                    "act (apply the weights in data/meta.json after review)" % margin
                    if would else
                    "NEVER REGRESS: candidate does not beat the incumbent by the "
                    "%.2f-point margin; weights unchanged" % margin)),
    }
    print("fit_player_signals: weeks=%d rows=%d folds=%d current_mae=%s candidate_mae=%s "
          "would_adopt=%s" % (entry["weeks_resolved"], entry["rows_resolved"],
                              entry["folds"], entry["current_mae"],
                              entry["candidate_mae"], entry["would_adopt"]))
    if propose:
        with open(tuning_path, encoding="utf-8") as fh:
            tuning = json.load(fh)
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
                        "baseline": base, "shipped": base,
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
    assert should_adopt(wf["current_mae"], wf["candidate_mae"], lo.ADOPTION_MARGIN_MAE)
    # ...and when the truth is the baseline, weight 0 wins and nothing is adopted.
    flat = _rows([1, 2, 3], true_w=0.0)
    wf0 = walk_forward(flat, {"age_curve": 0.0})
    assert wf0["candidate_weights"] == {"age_curve": 0.0}
    assert not should_adopt(wf0["current_mae"], wf0["candidate_mae"], lo.ADOPTION_MARGIN_MAE)
    # folds never see their own week
    for fit, held, wk in lo.walk_forward_folds(three):
        assert all(r["week"] < wk for r in fit) and all(r["week"] == wk for r in held)
    print("selftest OK: refuses at 0 resolved weeks, 1 week gives no fold, "
          "walk-forward recovers a true signal, never-regress margin gates adoption")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--propose", action="store_true",
                    help="archive the run into data/model_tuning.json history "
                         "(never applies weights)")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    if not os.path.exists(SCORES_PATH):
        print("[fit_player_signals] %s absent — run scripts/resolve_estimates.py first"
              % SCORES_PATH, file=sys.stderr)
        return 0
    run(propose=args.propose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
