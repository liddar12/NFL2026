"""Point-in-time prediction snapshots.

The single most important discipline in this project: archive every prediction
BEFORE its event resolves, so no later information can leak into the recorded
number. A snapshot row is locked at `locked_utc` with an explicit `as_of_utc`
(the information cutoff — never later than kickoff). When the event finishes we
`resolve()` the row against the realized outcome and attach the measured scores.

Row schema (mirrors data/contracts/snapshot.schema.json):

  {
    "event_id":   str,                       # stable id of the game / player-week
    "event_type": "game" | "player_week",
    "model":      str,                        # which model produced this row
    "locked_utc": str,                        # when the prediction was frozen
    "as_of_utc":  str,                        # information cutoff (<= kickoff)
    "probs":      [float, ...],   (optional)  # probability vector (games)
    "point":      float,          (optional)  # point estimate (player points)
    "interval":   [low, high],    (optional)  # prediction interval
    "estimate":   bool,                        # true => NOT a measurement
    "resolved":   bool,
    "actual":     any,            (optional)  # realized outcome (idx or value)
    "brier":      float | null,   (optional)  # present iff measured & resolved
    "log_loss":   float | null    (optional)  # present iff measured & resolved
  }

Honesty invariant (enforced in honesty.py, produced correctly here):
  * estimate == true   -> brier & log_loss absent/null (a guess is not a score).
  * estimate == false & resolved == true -> brier & log_loss present (a measured,
    finished prediction MUST show its receipts).
"""

import json
import os

from . import metrics

# ---------------------------------------------------------------------------
# Snapshot storage location: <repo_root>/data/snapshots/
# This file lives at <repo_root>/scripts/harness/snapshot.py, so the repo root
# is two directories up. Resolved once at import for determinism.
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
SNAPSHOT_DIR = os.path.join(_REPO_ROOT, "data", "snapshots")

EVENT_TYPES = ("game", "player_week")


def make_row(event_id, event_type, model, locked_utc, as_of_utc,
             probs=None, point=None, interval=None, estimate=True):
    """Construct a snapshot row (unresolved).

    A freshly made row is always unresolved (`resolved: False`) and carries no
    `actual`/`brier`/`log_loss`. By default a row is an ESTIMATE — a caller must
    explicitly pass `estimate=False` to assert "this is a measurable prediction
    I will stand behind once it resolves". Measurable rows must carry a `probs`
    vector, because brier/log_loss are only defined over a probability vector;
    this is checked at resolve() time.

    Exactly one of `probs` or `point` should be supplied (a game uses probs, a
    player-week point projection uses point). This is validated loosely here and
    strictly by the JSON schema / validate_data.py.
    """
    if event_type not in EVENT_TYPES:
        raise ValueError("event_type must be one of %r, got %r"
                         % (EVENT_TYPES, event_type))
    if probs is None and point is None:
        raise ValueError("make_row requires either probs or point")
    if probs is not None and point is not None:
        raise ValueError("make_row takes probs OR point, not both")

    row = {
        "event_id": event_id,
        "event_type": event_type,
        "model": model,
        "locked_utc": locked_utc,
        "as_of_utc": as_of_utc,
        "estimate": bool(estimate),
        "resolved": False,
    }
    if probs is not None:
        # Store a plain list of floats (defensive copy).
        row["probs"] = [float(p) for p in probs]
    if point is not None:
        row["point"] = float(point)
    if interval is not None:
        low, high = interval
        row["interval"] = [float(low), float(high)]
    return row


def resolve(row, actual):
    """Resolve a snapshot row against its realized outcome.

    Mutates and returns the row with `resolved=True` and `actual` set. For a
    NON-estimate row it computes and attaches `brier` and `log_loss` from the
    stored probability vector via metrics.py — satisfying the honesty invariant
    that every measured, resolved row carries its scores.

    For an estimate row, no scores are attached (a flagged guess never earns a
    measurement), only `resolved`/`actual` are recorded so the row can later be
    upgraded to a real model once one exists.

    `actual` for a probs row is the integer index of the realized outcome within
    `probs` (e.g. 0 = home win). For a point row `actual` is the realized value.
    """
    row["resolved"] = True
    row["actual"] = actual

    if row.get("estimate", True):
        # Estimate: must NOT carry measured scores. Strip any stragglers so the
        # honesty validator always passes on our own output.
        row.pop("brier", None)
        row.pop("log_loss", None)
        return row

    # Measured, resolved row => scores are mandatory. brier/log_loss are only
    # defined over a probability vector, so a measured row without probs is a
    # contradiction we refuse rather than fudge.
    probs = row.get("probs")
    if probs is None:
        raise ValueError(
            "cannot measure a non-estimate row without a probs vector "
            "(event_id=%r); mark it estimate=True or supply probs"
            % row.get("event_id"))
    if not isinstance(actual, int):
        raise ValueError(
            "probs row actual must be an outcome index (int), got %r" % (actual,))

    row["brier"] = metrics.brier(actual, probs)
    row["log_loss"] = metrics.log_loss(actual, probs)
    return row


def _snapshot_path(name):
    """Absolute path of a snapshot file under SNAPSHOT_DIR (name may omit .json)."""
    if not name.endswith(".json"):
        name = name + ".json"
    return os.path.join(SNAPSHOT_DIR, name)


def write_snapshot(name, rows):
    """Write a list of snapshot rows to data/snapshots/<name>.json.

    JSON on disk follows the global rule: UTF-8, ensure_ascii=True, indent=2,
    sort_keys=True (keeps cron diffs minimal), trailing newline. Creates the
    snapshots directory if missing. Returns the path written.
    """
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    path = _snapshot_path(name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(list(rows), fh, ensure_ascii=True, indent=2, sort_keys=True)
        fh.write("\n")
    return path


def load_snapshot(name):
    """Load and return the list of rows from data/snapshots/<name>.json."""
    path = _snapshot_path(name)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)
