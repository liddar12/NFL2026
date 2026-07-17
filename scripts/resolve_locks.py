"""Resolve point-in-time game locks against FINAL scores — the grading half of the loop.

For every lock file data/snapshots/*_games_open.json, any row whose game is now FINAL
(per scripts.scrape.espn fetch, STATUS-gated — a live/halftime/0-0 stub can never grade
a lock) is resolved IN PLACE via scripts.harness.snapshot.resolve: `actual`, `brier`
and `log_loss` are filled. `probs`, `locked_utc` and `as_of_utc` are NEVER touched —
a lock is immutable; resolution attaches the receipt, it does not edit the prediction.

Idempotent: already-resolved rows are skipped, so this is safe on every cron window.
When nothing is FINAL yet (preseason — today's reality) it prints a clear no-op line
and exits 0. A lock file is rewritten only when this pass actually resolved a row.

Pure core (unit-testable, no I/O, no network): outcome_index() + resolve_rows().
resolve_all_locks(schedule_finals) adds the file walk; __main__ adds the ESPN fetch.

Run in the pipeline runner (network + requests): python -m scripts.resolve_locks
The fast gate never runs this; it validates the committed snapshots.
"""

import glob
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.harness import snapshot as snap  # noqa: E402
from scripts.scrape import espn  # noqa: E402

# Only opening game locks are graded here; the timestamped game_predictions.*.json
# copies gameday.yml archives are display documents, not snapshot-row arrays.
LOCK_GLOB = "*_games_open.json"


def outcome_index(final_game):
    """Outcome index of a FINAL game within a [home, away] probs vector.

    0 = home win, 1 = away win (locks store probs as [home, away] — see the lock
    writer in scripts/build_predictions.py). Returns None for a missing score or a
    tie: a 2-way vector has no tie index, so a tied game cannot honestly be graded
    against it — the caller skips it loudly rather than force-fitting an outcome.
    """
    hs = final_game.get("home_score")
    as_ = final_game.get("away_score")
    if hs is None or as_ is None:
        return None
    if hs > as_:
        return 0
    if as_ > hs:
        return 1
    return None  # tie


def resolve_rows(rows, finals_by_id):
    """Resolve every resolvable game row in `rows` against `finals_by_id`. Pure.

    Mutates rows in place (the harness's designed resolve flow — snapshot.resolve
    fills resolved/actual and, for measured rows, brier/log_loss; nothing else) and
    returns a summary dict:

        {rows, resolved_now, already_resolved, pending, ties_skipped,
         scored_rows, brier_mean, log_loss_mean}

    brier_mean / log_loss_mean are over ALL resolved measured rows after the pass
    (the cumulative grade of the file, not just this pass); None when there are none.
    Rows that are not game rows, are already resolved, or whose game is not FINAL
    are left byte-identical — idempotence is the contract.
    """
    resolved_now = already = pending = ties = 0
    for row in rows:
        if row.get("resolved"):
            already += 1
            continue
        if row.get("event_type") != "game":
            pending += 1  # player_week rows wait for the weekly-actuals feed
            continue
        final = finals_by_id.get(str(row.get("event_id")))
        if final is None:
            pending += 1  # not FINAL yet — display-only statuses never grade a lock
            continue
        idx = outcome_index(final)
        if idx is None:
            ties += 1  # tie (or scoreless payload): ungradable vs a 2-way vector
            continue
        snap.resolve(row, idx)
        resolved_now += 1

    scored = [r for r in rows
              if r.get("resolved") and not r.get("estimate", True)
              and isinstance(r.get("brier"), (int, float))]
    n = len(scored)
    return {
        "rows": len(rows),
        "resolved_now": resolved_now,
        "already_resolved": already,
        "pending": pending,
        "ties_skipped": ties,
        "scored_rows": n,
        "brier_mean": round(sum(r["brier"] for r in scored) / n, 6) if n else None,
        "log_loss_mean": round(sum(r["log_loss"] for r in scored) / n, 6) if n else None,
    }


def resolve_all_locks(schedule_finals):
    """Resolve every data/snapshots/*_games_open.json against `schedule_finals`.

    `schedule_finals` is a list of STATUS-gated FINAL rows (game_id, home_score,
    away_score, ...) — the shape espn.fetch_final_results / fetch_scores
    (final_only=True) returns. Each lock file is rewritten ONLY when this pass
    resolved at least one of its rows, so re-runs leave everything byte-identical.
    Prints a grading summary (or the clear no-op line) and returns the aggregate
    summary dict.
    """
    finals_by_id = {str(g["game_id"]): g for g in schedule_finals}
    paths = sorted(glob.glob(os.path.join(snap.SNAPSHOT_DIR, LOCK_GLOB)))

    total = {"files": len(paths), "rows": 0, "resolved_now": 0,
             "already_resolved": 0, "pending": 0, "ties_skipped": 0,
             "scored_rows": 0, "brier_mean": None, "log_loss_mean": None}
    briers, losses = [], []

    for path in paths:
        name = os.path.basename(path)
        rows = snap.load_snapshot(name)
        s = resolve_rows(rows, finals_by_id)
        if s["resolved_now"]:
            snap.write_snapshot(name, rows)
        print(f"  {name}: rows={s['rows']} resolved_now={s['resolved_now']} "
              f"already={s['already_resolved']} pending={s['pending']} "
              f"ties_skipped={s['ties_skipped']}")
        for key in ("rows", "resolved_now", "already_resolved", "pending",
                    "ties_skipped", "scored_rows"):
            total[key] += s[key]
        for r in rows:
            if (r.get("resolved") and not r.get("estimate", True)
                    and isinstance(r.get("brier"), (int, float))):
                briers.append(r["brier"])
                losses.append(r["log_loss"])

    if briers:
        total["brier_mean"] = round(sum(briers) / len(briers), 6)
        total["log_loss_mean"] = round(sum(losses) / len(losses), 6)

    if total["scored_rows"] == 0:
        print(f"resolve_locks: no lock rows are FINAL yet "
              f"({total['rows']} rows across {total['files']} lock files, all pending) "
              f"— nothing to resolve (clean no-op).")
    else:
        print(f"resolve_locks: grading summary — {total['scored_rows']} resolved lock "
              f"rows ({total['resolved_now']} newly resolved this pass), "
              f"mean brier={total['brier_mean']} mean log_loss={total['log_loss_mean']}, "
              f"{total['pending']} still pending, {total['ties_skipped']} ties skipped.")
    return total


def _seasons_in_locks():
    """Distinct seasons named by the lock files (e.g. 2026_wk01_games_open.json)."""
    seasons = set()
    for path in sorted(glob.glob(os.path.join(snap.SNAPSHOT_DIR, LOCK_GLOB))):
        head = os.path.basename(path).split("_", 1)[0]
        if head.isdigit():
            seasons.add(int(head))
        else:
            print(f"[warn] cannot parse a season from lock file "
                  f"{os.path.basename(path)!r}; its rows can only resolve against "
                  f"finals fetched for other locks", file=sys.stderr)
    return sorted(seasons)


def main():
    seasons = _seasons_in_locks()
    if not seasons:
        print("resolve_locks: no *_games_open.json lock files under data/snapshots/ "
              "— nothing to do (clean no-op).")
        return 0
    finals = []
    for season in seasons:
        # STATUS-gated: only FINAL rows come back. A season with nothing played yet
        # legitimately returns [] — that is reality, not an outage (outages raise).
        rows = espn.fetch_final_results(season)
        print(f"espn finals {season}: {len(rows)} FINAL games")
        finals.extend(rows)
    resolve_all_locks(finals)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
