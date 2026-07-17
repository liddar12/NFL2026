"""Refit game-model parameters from resolved locks — NEVER-REGRESS gated.

The learning half of the loop. Inputs are the graded point-in-time lock rows produced
by scripts/resolve_locks.py — leak-safe by construction (locked before kickoff,
resolved only after FINAL). Over those rows we grid-search the two Elo game parameters
nothing has earned yet:

    hfa_elo  in 45..85  step 5     (prediction-time home-field advantage, Elo points)
    revert   in 0.20..0.45 step 0.05  (between-season reversion toward the mean)

Each candidate is scored by mean log-loss (scripts.harness.metrics — the exact
objective the harness reports, never re-derived) of its re-derived Elo home
probability over every resolved row. Adoption is decided ONLY by
scripts.optimize.never_regress.should_adopt: a candidate that does not beat the
incumbent by the margin changes nothing.

EVERY refit outcome (adopted or not) is appended to data/model_tuning.json under
"history" — additive: the file's top-level NEVER-REGRESS example entry is locked by
never_regress.test.mjs + smoke.sh and is never modified. ONLY on adoption are the live
params written to model_tuning.json:"game_params", where scripts/build_predictions.py
reads them (absent => the incumbent scripts/models/elo.py defaults, so probs stay
byte-identical). A run that grades zero rows appends nothing — a no-op is printed, not
archived, so daily crons never churn the file.

tilt_coef/home_coef (weekly player params) CANNOT be refit yet: tilt shapes PLAYER
weeklies, not game probs, and no resolved weekly player actuals exist. That path is
guarded with a loud skip line until the weekly-actuals feed lands (see
refit_player_params).

Pure core (unit-testable, no I/O, no network): score_game_params() +
refit_game_params(). Row contract for refit_game_params — each resolved row carries:

    home_elo_raw / away_elo_raw : UNREVERTED end-of-prior-season Elo ratings
                                  (elo.rate_season over the prior season's finals)
    actual                      : 0 = home won, 1 = away won  (the lock's outcome index)

The grid explores the prediction-time hfa and the between-season revert applied to
those raw ratings; the raw ratings themselves are held fixed (the hfa used INSIDE the
prior season's rating updates is second-order and stays at the incumbent — honest and
simple beats clever here).

Run in the pipeline runner (network + requests): python -m scripts.refit
The fast gate never runs this; it validates the committed model_tuning.json.
"""

import datetime as dt
import glob
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.harness import metrics  # noqa: E402
from scripts.harness import snapshot as snap  # noqa: E402
from scripts.models import elo as elo_mod  # noqa: E402
from scripts.optimize.never_regress import should_adopt  # noqa: E402
from scripts.resolve_locks import LOCK_GLOB  # noqa: E402
from scripts.scrape import espn  # noqa: E402

PRIOR_SEASON = 2025  # mirrors scripts/build_predictions.py
DATA = os.path.join(_ROOT, "data")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")

MARGIN = 0.0015  # the NEVER-REGRESS default, same units as the losses

# Fixed ascending grids -> deterministic sweep; ties keep the FIRST (lowest) point.
HFA_GRID = tuple(float(h) for h in range(45, 90, 5))            # 45, 50, ... 85
REVERT_GRID = tuple(round(0.20 + 0.05 * i, 2) for i in range(6))  # 0.20 ... 0.45


def _utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _prior(raw, revert):
    """Between-season reversion (mirrors elo.revert_to_mean, per single rating)."""
    return elo_mod.INIT + (float(raw) - elo_mod.INIT) * (1.0 - float(revert))


def score_game_params(resolved_rows, params):
    """Mean log-loss of {hfa_elo, revert} over resolved lock rows. Pure.

    For each row: revert both raw ratings by params["revert"], take the Elo home
    probability at params["hfa_elo"], and grade [p_home, p_away] against the row's
    realized outcome index via the shared harness metrics.
    """
    pairs = []
    for r in resolved_rows:
        p_home = elo_mod.expected_home(
            _prior(r["home_elo_raw"], params["revert"]),
            _prior(r["away_elo_raw"], params["revert"]),
            hfa=float(params["hfa_elo"]),
        )
        pairs.append((int(r["actual"]), [p_home, 1.0 - p_home]))
    return metrics.multiclass_log_loss(pairs)


def refit_game_params(resolved_rows, current, margin=MARGIN):
    """Grid-search hfa_elo x revert on resolved-lock log-loss; NEVER-REGRESS gated.

    Parameters
    ----------
    resolved_rows : sequence of dict
        Resolved lock rows, each carrying home_elo_raw, away_elo_raw and an integer
        `actual` (0 = home won, 1 = away won). Rows missing any of those are
        ignored (they cannot be scored, and guessing would poison the fit).
    current : dict
        The incumbent live params: {"hfa_elo": float, "revert": float}.
    margin : float
        NEVER-REGRESS margin, passed straight through to should_adopt.

    Returns
    -------
    dict
        {"candidate": {"hfa_elo", "revert"} | None,
         "current_loss": float | None, "candidate_loss": float | None,
         "adopted": bool, "n_resolved": int, "margin": float}

    With zero usable rows nothing is fit and nothing is adopted (the honest
    default: no data, no change). Deterministic: fixed ascending grids, strict-<
    improvement, so ties keep the earliest (lowest) grid point. Adoption is
    should_adopt(current_loss, candidate_loss, margin) and nothing else.
    """
    rows = [r for r in resolved_rows
            if isinstance(r.get("actual"), int) and not isinstance(r.get("actual"), bool)
            and r.get("home_elo_raw") is not None
            and r.get("away_elo_raw") is not None]
    if not rows:
        return {"candidate": None, "current_loss": None, "candidate_loss": None,
                "adopted": False, "n_resolved": 0, "margin": margin}

    current_loss = score_game_params(rows, current)

    best_params = None
    best_loss = None
    for hfa in HFA_GRID:
        for revert in REVERT_GRID:
            cand = {"hfa_elo": hfa, "revert": revert}
            loss = score_game_params(rows, cand)
            if best_loss is None or loss < best_loss:
                best_loss, best_params = loss, cand

    adopted = should_adopt(current_loss, best_loss, margin=margin)
    return {
        "candidate": best_params,
        "current_loss": round(current_loss, 6),
        "candidate_loss": round(best_loss, 6),
        "adopted": adopted,
        "n_resolved": len(rows),
        "margin": margin,
    }


def refit_player_params(resolved_player_rows, current):
    """tilt_coef/home_coef refit — GUARDED until weekly player actuals exist.

    tilt/home shape the weekly PLAYER point split, so their refit target is realized
    weekly player points — a feed that does not exist yet. With no resolved
    player_week rows this returns a loud skip record (adopted=False, nothing
    changes). If resolved player rows ever arrive while this guard is still in
    place, we REFUSE loudly rather than silently ignore real data.
    """
    if not resolved_player_rows:
        return {"candidate": None, "current_loss": None, "candidate_loss": None,
                "adopted": False, "n_resolved": 0,
                "skipped": "no resolved weekly player actuals yet"}
    raise NotImplementedError(
        "resolved weekly player rows exist but the tilt_coef/home_coef refit is not "
        "implemented yet — implement it (against realized weekly player points) "
        "instead of letting real data rot unused.")


# ---------------------------------------------------------------------------
# model_tuning.json — additive history (the top-level example entry is locked
# by never_regress.test.mjs + smoke.sh and must never be touched).
# ---------------------------------------------------------------------------
def _load_tuning():
    with open(TUNING_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _write_tuning(doc):
    with open(TUNING_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def append_history(doc, entry):
    """Append one refit outcome to the document's "history" list (created on first
    use). Purely additive — every other key keeps its committed value."""
    doc.setdefault("history", []).append(entry)
    return doc


def live_game_params(doc):
    """The params production currently runs on: an adopted game_params entry if one
    exists, else the incumbent scripts/models/elo.py defaults."""
    gp = doc.get("game_params") or {}
    return {"hfa_elo": float(gp.get("hfa_elo", elo_mod.HFA_ELO)),
            "revert": float(gp.get("revert", elo_mod.REVERT))}


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------
def _collect_resolved_rows(event_type):
    """All resolved, measured rows of `event_type` across data/snapshots/*_games_open.json."""
    rows = []
    for path in sorted(glob.glob(os.path.join(snap.SNAPSHOT_DIR, LOCK_GLOB))):
        for r in snap.load_snapshot(os.path.basename(path)):
            if (r.get("event_type") == event_type and r.get("resolved")
                    and not r.get("estimate", True)):
                rows.append(r)
    return rows


def _enrich_with_raw_elo(rows):
    """Attach home_elo_raw/away_elo_raw (unreverted end-of-2025 ratings) to each row.

    Teams come from data/schedule_full.json (game_id -> home/away); ratings from
    elo.rate_season over the prior season's FINAL results (network). Rows whose
    game_id is missing from the schedule are dropped loudly — grading a game we
    cannot identify would be a silent mis-attribution.
    """
    with open(SCHEDULE_PATH, encoding="utf-8") as fh:
        by_id = {str(g["game_id"]): g for g in json.load(fh)["games"]}
    finals_prior = espn.fetch_final_results(PRIOR_SEASON)
    print(f"espn finals {PRIOR_SEASON}: {len(finals_prior)} FINAL games "
          f"-> raw (unreverted) Elo ratings")
    raw = elo_mod.rate_season(finals_prior)
    enriched, dropped = [], 0
    for r in rows:
        g = by_id.get(str(r.get("event_id")))
        if g is None:
            dropped += 1
            print(f"[warn] resolved lock row {r.get('event_id')!r} not in "
                  f"schedule_full.json — dropped from the refit set", file=sys.stderr)
            continue
        r2 = dict(r)
        r2["home_elo_raw"] = raw.get(g["home"], elo_mod.INIT)
        r2["away_elo_raw"] = raw.get(g["away"], elo_mod.INIT)
        enriched.append(r2)
    if dropped:
        print(f"[warn] refit: {dropped} resolved rows dropped (no schedule match)",
              file=sys.stderr)
    return enriched


def _reason(result, current):
    """A one-paragraph honest explanation, in the file's example tone."""
    if result["adopted"]:
        return ("ADOPTED: candidate hfa_elo=%(h).0f revert=%(r).2f improves "
                "resolved-lock log-loss %(cl).4f -> %(nl).4f, clearing the %(m).4f "
                "margin over n=%(n)d resolved locks. should_adopt == true."
                % {"h": result["candidate"]["hfa_elo"],
                   "r": result["candidate"]["revert"],
                   "cl": result["current_loss"], "nl": result["candidate_loss"],
                   "m": result["margin"], "n": result["n_resolved"]})
    return ("NEVER REGRESS: best grid candidate scores %(nl).4f vs incumbent "
            "(hfa_elo=%(h).0f revert=%(r).2f) at %(cl).4f over n=%(n)d resolved "
            "locks; the %(m).4f margin is not cleared, so the incumbent params are "
            "kept unchanged. should_adopt == false."
            % {"nl": result["candidate_loss"], "h": current["hfa_elo"],
               "r": current["revert"], "cl": result["current_loss"],
               "m": result["margin"], "n": result["n_resolved"]})


def _player_refit_guard():
    """Run the guarded tilt/home path and print its (loud) outcome."""
    doc = _load_tuning()
    player_rows = _collect_resolved_rows("player_week")
    skip = refit_player_params(player_rows, live_game_params(doc))
    print(f"refit: tilt_coef/home_coef skipped: {skip['skipped']}")


def main():
    now = _utc_now()
    resolved = _collect_resolved_rows("game")
    print(f"refit: {len(resolved)} resolved game lock rows under data/snapshots/")

    if not resolved:
        # No graded record yet -> nothing to fit, nothing to archive (a no-op is
        # printed, not written, so daily crons never churn model_tuning.json).
        print("refit: no resolved lock rows yet - nothing to refit (clean no-op).")
        _player_refit_guard()
        return 0

    doc = _load_tuning()
    current = live_game_params(doc)
    rows = _enrich_with_raw_elo(resolved)
    result = refit_game_params(rows, current)

    entry = {
        "generated_utc": now,
        "kind": "game_params",
        "objective": "log_loss",
        "margin": result["margin"],
        "n_resolved": result["n_resolved"],
        "current": current,
        "candidate": result["candidate"],
        "current_loss": result["current_loss"],
        "candidate_loss": result["candidate_loss"],
        "improvement": (round(result["current_loss"] - result["candidate_loss"], 6)
                        if result["current_loss"] is not None else None),
        "adopted": result["adopted"],
        "reason": _reason(result, current),
    }
    append_history(doc, entry)

    if result["adopted"]:
        # The ONE place live game params are updated — build_predictions reads them
        # from here. Only an adoption that cleared the margin lands.
        doc["game_params"] = {
            "hfa_elo": result["candidate"]["hfa_elo"],
            "revert": result["candidate"]["revert"],
            "adopted_utc": now,
            "source": "scripts/refit.py grid on resolved locks (never-regress gated)",
        }
        print(f"refit: ADOPTED hfa_elo={result['candidate']['hfa_elo']} "
              f"revert={result['candidate']['revert']} "
              f"({result['current_loss']} -> {result['candidate_loss']}, "
              f"n={result['n_resolved']})")
    else:
        print(f"refit: kept incumbent hfa_elo={current['hfa_elo']} "
              f"revert={current['revert']} — candidate {result['candidate']} "
              f"scored {result['candidate_loss']} vs {result['current_loss']} "
              f"(margin {result['margin']}, n={result['n_resolved']}); outcome archived.")

    _write_tuning(doc)
    print(f"refit: outcome appended to data/model_tuning.json "
          f"(history now {len(doc['history'])} entries)")
    _player_refit_guard()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
