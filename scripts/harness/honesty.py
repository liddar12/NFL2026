"""Backtest-honesty enforcement.

This module encodes the one rule the UI can never be allowed to violate:

    An ESTIMATE is not a MEASUREMENT.

Concretely, for every snapshot row:
  * estimate == True   => `brier` and `log_loss` must be absent or null. A row
    flagged as a guess may NEVER carry measured scores — otherwise the frontend
    could dress an unvalidated number up as a backtested result.
  * estimate == False & resolved == True => `brier` and `log_loss` MUST both be
    present (non-null numbers). A finished, non-estimate prediction has to show
    its receipts; a measured row without scores is a silent regression.
  * estimate == False & resolved == False => allowed and unscored (the event
    simply hasn't happened yet); scores must still be absent/null.

A dedicated Node test (tests/feature/backtest_honesty.test.mjs, Agent 6) mirrors
this contract so it is locked from both languages.
"""


class HonestyError(ValueError):
    """Raised when a snapshot row violates the estimate-vs-measured contract."""


def _has_score(row, key):
    """True iff `row[key]` is present AND non-null.

    Absent and explicit null are treated identically: both mean "no score".
    """
    return key in row and row[key] is not None


def validate(row):
    """Validate a single snapshot row against the honesty contract.

    Returns True on success; raises HonestyError with a specific message on any
    violation. Kept boolean-returning (not just void) so callers can also use it
    in an assertion or filter without catching.
    """
    event_id = row.get("event_id", "<unknown>")
    estimate = bool(row.get("estimate", True))
    resolved = bool(row.get("resolved", False))
    has_brier = _has_score(row, "brier")
    has_log_loss = _has_score(row, "log_loss")

    if estimate:
        # A flagged estimate must never carry measured scores.
        if has_brier or has_log_loss:
            raise HonestyError(
                "row %r is estimate=True but carries measured scores "
                "(brier=%r, log_loss=%r); estimates must not be scored"
                % (event_id, row.get("brier"), row.get("log_loss")))
        return True

    # Non-estimate rows.
    if resolved:
        # Measured + finished => both scores mandatory.
        if not (has_brier and has_log_loss):
            raise HonestyError(
                "row %r is a resolved measurement (estimate=False, "
                "resolved=True) but is missing scores "
                "(brier present=%s, log_loss present=%s); measured rows must "
                "carry both" % (event_id, has_brier, has_log_loss))
        return True

    # Non-estimate but not yet resolved: legitimately unscored. Scores must not
    # have been attached prematurely (that would imply peeking at the outcome).
    if has_brier or has_log_loss:
        raise HonestyError(
            "row %r is unresolved (resolved=False) yet already carries scores "
            "(brier=%r, log_loss=%r); scores before resolution imply a leak"
            % (event_id, row.get("brier"), row.get("log_loss")))
    return True


def assert_measured_rows(rows):
    """Validate every row in an iterable.

    Runs `validate` over all rows and raises the FIRST HonestyError encountered,
    with the row's index prepended for locatability. Returns True if all rows
    pass. Use this as the gate over a whole snapshot file before it ships.
    """
    for i, row in enumerate(rows):
        try:
            validate(row)
        except HonestyError as exc:
            raise HonestyError("row index %d: %s" % (i, exc)) from exc
    return True
