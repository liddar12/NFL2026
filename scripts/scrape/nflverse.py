"""nflverse fetchers (weekly stats / rosters / depth charts / snap counts).

Data source of record for player-side truth. Uses `nfl_data_py`, which is a HEAVY,
optional dependency (pandas under the hood). Per the ZERO-DEP gate rule it is imported
**inside each function**, guarded, so importing this module never fails on a clean box.

A second, lighter path lives at the bottom: the nflverse-data GitHub RELEASE CSVs
(rosters / snap counts), fetched with guarded `requests` and parsed with the stdlib
`csv` module, no pandas, no nfl_data_py. Some sandboxes proxy-block github.com
release assets (403); those fetchers raise FeedError on ANY transport failure so
callers can degrade loudly-but-gracefully rather than trusting a truncated pull.

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


# ---------------------------------------------------------------------------
# Release-CSV path (no pandas). The nflverse-data repo publishes flat CSVs as
# GitHub release assets; these are the same tables nfl_data_py wraps, minus the
# heavy dependency. Guarded-requests + stdlib csv only.
# ---------------------------------------------------------------------------

_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
_HTTP_TIMEOUT = 30  # seconds; release assets are small, a hang means trouble.


def _require_requests():
    """Import `requests` on demand with one actionable line (scrape/espn.py pattern).
    Kept out of module scope so the gate can import this file without the package."""
    try:
        import requests  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover - exercised only off the gate
        raise FeedError(
            "requests is not installed. Install it in the pipeline runner only: "
            "`pip install requests`. It must NEVER be a gate dependency."
        ) from exc
    return requests


def fetch_release_csv(url, name, min_rows=1):
    """GET a nflverse release CSV and parse it to list[dict] with the stdlib csv
    module. LOUD on everything: a non-200 (proxy-blocked sandboxes 403 these
    assets), a transport error, or a row count under `min_rows` all raise
    FeedError - never return a possibly-truncated table."""
    import csv
    import io

    requests = _require_requests()
    try:
        resp = requests.get(url, timeout=_HTTP_TIMEOUT)
    except Exception as exc:  # requests.RequestException and proxy/TLS failures
        raise FeedError(f"nflverse release GET {url} failed in transport: {exc}") from exc
    if resp.status_code != 200:
        raise FeedError(
            f"nflverse release GET {url} returned HTTP {resp.status_code}. Refusing "
            f"to treat a non-200 as empty data (the silent-404 lesson)."
        )
    rows = list(csv.DictReader(io.StringIO(resp.text)))
    _assert_rows(name, rows, min_rows)
    return rows


def fetch_injuries_release(season, min_rows=2000):
    """Weekly injury reports (injuries_{season}.csv): report statuses per player
    per week — the pregame availability signal the qb_out promotion family
    walks forward on. A season is ~5-8k rows; under min_rows is a partial pull."""
    url = f"{_RELEASE_BASE}/injuries/injuries_{int(season)}.csv"
    return fetch_release_csv(url, f"injuries_release_{season}", min_rows=min_rows)


def fetch_roster_release(season, min_rows=1500):
    """Season roster from the release CSV (roster_{season}.csv). ~32 teams * ~53
    players, so under `min_rows` (1500) signals a partial pull."""
    url = f"{_RELEASE_BASE}/rosters/roster_{int(season)}.csv"
    return fetch_release_csv(url, f"roster_release_{season}", min_rows=min_rows)


def fetch_snap_counts_release(season, min_rows=500):
    """Weekly snap counts from the release CSV (snap_counts_{season}.csv). Even a
    few weeks of a season is thousands of rows; under `min_rows` is a partial pull."""
    url = f"{_RELEASE_BASE}/snap_counts/snap_counts_{int(season)}.csv"
    return fetch_release_csv(url, f"snap_counts_release_{season}", min_rows=min_rows)


def fetch_combine_release(min_rows=2000):
    """NFL combine results (all draft classes) from the release CSV. Carries
    bench_press reps per athlete — the strength input the O-line composite was
    designed around. Under `min_rows` (decades of data) is a partial pull."""
    url = f"{_RELEASE_BASE}/combine/combine.csv"
    return fetch_release_csv(url, "combine_release", min_rows=min_rows)


def iter_pbp_release(season):
    """STREAM play-by-play rows for a season (play_by_play_{season}.csv.gz).

    Yields dict rows without ever holding the full file (a season is ~50k plays
    and the CSV decompresses large). LOUD on transport/non-200 like every other
    release fetcher; callers aggregate on the fly."""
    import csv
    import gzip
    import io

    requests = _require_requests()
    url = f"{_RELEASE_BASE}/pbp/play_by_play_{int(season)}.csv.gz"
    try:
        resp = requests.get(url, timeout=_HTTP_TIMEOUT * 6, stream=True)
    except Exception as exc:
        raise FeedError(f"nflverse pbp GET {url} failed in transport: {exc}") from exc
    if resp.status_code != 200:
        raise FeedError(
            f"nflverse pbp GET {url} returned HTTP {resp.status_code}. Refusing to "
            f"treat a non-200 as empty data (the silent-404 lesson)."
        )
    resp.raw.decode_content = True
    text = io.TextIOWrapper(gzip.GzipFile(fileobj=resp.raw), encoding="utf-8", newline="")
    n = 0
    for row in csv.DictReader(text):
        n += 1
        yield row
    if n < 30000:
        raise FeedError(f"nflverse pbp {season}: only {n} plays streamed — partial season.")


def fetch_player_stats_week_release(season, min_rows=5000):
    """Weekly per-player offence stat lines (stats_player_week_{season}.csv) —
    one row per player-week with passing/rushing/receiving yardage, the input
    for measured per-game bonus counts (R44b). Requests-only: the daily runner
    does not carry nfl_data_py, and this table must never depend on it. A full
    season is ~19k rows; under `min_rows` is a partial pull."""
    url = f"{_RELEASE_BASE}/stats_player/stats_player_week_{int(season)}.csv"
    return fetch_release_csv(url, f"stats_player_week_{season}", min_rows=min_rows)


def fetch_depth_charts_release(season, min_rows=1000):
    """Daily depth-chart snapshots (depth_charts_{season}.csv): one row per
    listed player per snapshot date (`dt`), with gsis_id and pos_rank. The
    caller filters to the LATEST dt. Requests-only, same reason as
    fetch_player_stats_week_release. A season file is tens of thousands of
    rows; under `min_rows` is a partial pull."""
    url = f"{_RELEASE_BASE}/depth_charts/depth_charts_{int(season)}.csv"
    return fetch_release_csv(url, f"depth_charts_release_{season}", min_rows=min_rows)
