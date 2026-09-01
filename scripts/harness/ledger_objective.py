"""The player-signal objective, sourced from the resolved estimate ledger (R49).

The game-level fit scores log-loss on resolved locks. Player signals had no
resolved substrate at all until the estimate ledger: scripts/build_estimate_ledger.py
freezes every (player, week) estimate before kickoff, scripts/resolve_estimates.py
joins the locked rows to actual PPR, and THIS module turns those rows into the
objective the walk-forward fit minimises:

    est(row, weights) = baseline * PRODUCT over signals of (1 + w[name] * (adj - 1))
    objective(rows, weights) = mean |est - actual|          (MAE, PPR points/week)

Rank correlation is reported beside it, never optimised (CLAUDE.md).

READINESS (N): the objective REFUSES to fit with fewer than MIN_RESOLVED_WEEKS = 1
resolved week — LedgerNotReady is raised, never a number from nothing. Walk-forward
adoption needs strictly MORE: each held-out week is scored with weights fitted on
the weeks before it, so with one resolved week there are zero folds and nothing can
be adopted (reported as such). ADOPTION_MARGIN_MAE = 0.10 PPR points/player-week is
the never-regress margin in this objective's units (the log-loss margin 0.0015 is
meaningless in points); the rule itself is scripts/optimize/never_regress.should_adopt,
unchanged. Adoption stays behind data/model_tuning.json — never applied by a cron.

Stdlib only, pure.
"""

import math

MIN_RESOLVED_WEEKS = 1
ADOPTION_MARGIN_MAE = 0.10
OBJECTIVE = "mae_ppr_per_player_week"


class LedgerNotReady(RuntimeError):
    """Raised when the resolved ledger cannot support a fit yet."""


def load_resolved(scores_doc, min_weeks=MIN_RESOLVED_WEEKS):
    """The resolved rows of an estimate_scores.json document, or LedgerNotReady."""
    weeks = int((scores_doc or {}).get("weeks_resolved") or 0)
    rows = list((scores_doc or {}).get("resolved") or [])
    if weeks < min_weeks or not rows:
        raise LedgerNotReady(
            "resolved ledger has %d week(s) (%d rows); the player objective needs "
            ">= %d resolved week(s) — refusing to fit on nothing%s"
            % (weeks, len(rows), min_weeks,
               (": " + scores_doc["skipped"]) if (scores_doc or {}).get("skipped") else ""))
    return rows


def estimate(row, weights):
    """The estimate implied by `weights` on one resolved row (row-level signals)."""
    est = float(row["baseline"])
    for name, adj in (row.get("signals") or {}).items():
        w = float((weights or {}).get(name, 0.0))
        est *= 1.0 + w * (float(adj) - 1.0)
    return est


def objective(rows, weights):
    """Mean absolute error of estimate(row, weights) vs actual. Refuses empty."""
    if not rows:
        raise LedgerNotReady("no resolved rows to score")
    return sum(abs(estimate(r, weights) - float(r["actual"])) for r in rows) / len(rows)


def rank_corr(rows, weights):
    """Spearman rho between estimates and actuals (reported, never optimised)."""
    if len(rows) < 3:
        return None
    xs = [estimate(r, weights) for r in rows]
    ys = [float(r["actual"]) for r in rows]

    def ranks(vals):
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        r = [0.0] * len(vals)
        i = 0
        while i < len(vals):
            j = i
            while j + 1 < len(vals) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1.0
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(rows)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((rx[i] - mx) * (ry[i] - my) for i in range(n))
    dx = math.sqrt(sum((rx[i] - mx) ** 2 for i in range(n)))
    dy = math.sqrt(sum((ry[i] - my) ** 2 for i in range(n)))
    return (num / (dx * dy)) if dx and dy else None


def signal_names(rows):
    names = set()
    for r in rows:
        names |= set((r.get("signals") or {}).keys())
    return sorted(names)


def walk_forward_folds(rows):
    """[(fit_rows, held_out_rows, held_out_week)] — each resolved week after the
    first, scored on weights fitted from strictly earlier weeks. Zero folds with
    one resolved week: nothing can be adopted on a single week."""
    weeks = sorted({int(r["week"]) for r in rows})
    folds = []
    for wk in weeks[1:]:
        fit = [r for r in rows if int(r["week"]) < wk]
        held = [r for r in rows if int(r["week"]) == wk]
        if fit and held:
            folds.append((fit, held, wk))
    return folds
