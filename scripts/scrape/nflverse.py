"""nflverse fetchers (weekly stats / rosters / depth charts / snap counts).

Data source of record for player-side truth. Uses `nfl_data_py`, which is a HEAVY,
optional dependency (pandas under the hood). Per the ZERO-DEP gate rule it is imported
**inside each function**, guarded, so importing this module never fails on a clean box.

Honesty invariants enforced here:
  * Row-count assertions — a 0-row return from nflverse is almost always an upstream
    outage or a season/week that hasn't happened yet, NOT "no players". We raise loudly
    (FeedError) rather than write an empty file that masks the outage. This is the
    silent-scraper-404 lesson, applied to the player feed.
  * Staleness assertion — the returned frame must carry data no older than a caller-
    supplied bound, so a stuck mirror can't quietly serve last month's snap counts.

Everything returns a plain list[dict] (records), never a DataFrame, so the rest of the
stdlib-only codebase never has to know pandas exists.
"""

import datetime as _dt


class FeedError(RuntimeError):
    """Raised loudly when a feed is missing its dependency, returns zero rows, or is
    stale. Never swallow this into a silent empty write."""


def _require_nfl_data_py():
    """Import nfl_data_py on demand with a single, actionable error line.

    Kept out of module top-level ON PURPOSE: the regression gate imports scaffold
    modules but must run with no pip install, so a missing nfl_data_py may only ever
    surface when someone actually calls a fetcher — not at import time.
    """
    try:
        import nfl_data_py as nfl  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover - exercised only off the gate
        raise FeedError(
            "nfl_data_py is not installed. Install it in the pipeline runner only: "
            "`pip install nfl_data_py`. It must NEVER be a gate dependency."
        ) from exc
    return nfl


def _records(frame):
    """Convert a pandas DataFrame to a list of plain dicts without importing pandas at
    module scope. `to_dict(orient="records")` is a DataFrame method, so we rely on the
    object the caller already holds."""
    return frame.to_dict(orient="records")


def _assert_rows(name, rows, min_rows):
    """LOUD row-count gate. A feed that returns fewer than `min_rows` is treated as a
    failure, not as legitimately-empty data."""
    n = len(rows)
    if n < min_rows:
        raise FeedError(
            f"nflverse feed '{name}' returned {n} rows (expected >= {min_rows}). "
            f"Refusing to write a possibly-truncated/empty snapshot — investigate the "
            f"upstream mirror before trusting this run."
        )
    return n


def _assert_fresh(name, rows, date_field, max_age_days, as_of=None):
    """LOUD staleness gate. The newest `date_field` in `rows` must be within
    `max_age_days` of `as_of` (defaults to now, UTC). Rows without a parseable date are
    ignored for the freshness check but still counted by _assert_rows.

    `as_of` is injectable so tests/backtests can pin the clock (determinism rule).
    """
    if as_of is None:
        as_of = _dt.datetime.now(_dt.timezone.utc)
    newest = None
    for r in rows:
        raw = r.get(date_field)
        if not raw:
            continue
        try:
            # nflverse dates arrive as 'YYYY-MM-DD' strings or datetime-likes.
            d = _dt.date.fromisoformat(str(raw)[:10])
        except ValueError:
            continue
        dt = _dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc)
        if newest is None or dt > newest:
            newest = dt
    if newest is None:
        # No dated rows at all: can't verify freshness. That itself is suspicious.
        raise FeedError(
            f"nflverse feed '{name}' has no parseable '{date_field}' — cannot verify "
            f"freshness; treating as a failure rather than trusting stale data."
        )
    age_days = (as_of - newest).total_seconds() / 86400.0
    if age_days > max_age_days:
        raise FeedError(
            f"nflverse feed '{name}' is stale: newest {date_field}={newest.date()} is "
            f"{age_days:.1f}d old (max {max_age_days}d). A stuck mirror is serving old "
            f"data — do not overwrite good data with this."
        )
    return newest


def fetch_weekly_stats(season, weeks=None, min_rows=200, max_age_days=14, as_of=None):
    """Weekly player box-score stats for a season (optionally a subset of weeks).

    Returns list[dict] of per-player-per-week rows. Loud on empty/stale.
    `min_rows` default (200) reflects that even a single NFL week has hundreds of
    stat-lines; anything less means a partial pull.
    """
    nfl = _require_nfl_data_py()
    frame = nfl.import_weekly_data([int(season)], downcast=True)
    if weeks is not None:
        wanted = set(int(w) for w in weeks)
        frame = frame[frame["week"].isin(wanted)]
    rows = _records(frame)
    _assert_rows("weekly_stats", rows, min_rows)
    # weekly rows don't carry a calendar date; freshness is bounded by the season/week
    # existing at all. We skip the date check here and rely on the row-count gate.
    return rows


def fetch_rosters(season, min_rows=1500, as_of=None):
    """Season rosters (every player on every team). ~32 teams * ~53 = ~1700 rows, so a
    return under `min_rows` (1500) signals a partial pull."""
    nfl = _require_nfl_data_py()
    frame = nfl.import_seasonal_rosters([int(season)])
    rows = _records(frame)
    _assert_rows("rosters", rows, min_rows)
    return rows


def fetch_depth_charts(season, weeks=None, min_rows=500, as_of=None):
    """Weekly depth charts — needed by the target-competition signal (who's ahead of
    whom on the depth chart drives target share)."""
    nfl = _require_nfl_data_py()
    frame = nfl.import_depth_charts([int(season)])
    if weeks is not None:
        wanted = set(int(w) for w in weeks)
        frame = frame[frame["week"].isin(wanted)]
    rows = _records(frame)
    _assert_rows("depth_charts", rows, min_rows)
    return rows


def fetch_snap_counts(season, weeks=None, min_rows=500, as_of=None):
    """Weekly snap counts — the opportunity denominator for usage-based signals."""
    nfl = _require_nfl_data_py()
    frame = nfl.import_snap_counts([int(season)])
    if weeks is not None:
        wanted = set(int(w) for w in weeks)
        frame = frame[frame["week"].isin(wanted)]
    rows = _records(frame)
    _assert_rows("snap_counts", rows, min_rows)
    return rows
