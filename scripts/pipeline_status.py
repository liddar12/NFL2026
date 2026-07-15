"""Feed-health / pipeline status — the silent-scraper-404 alarm.

Writes `data/pipeline_status.json` (schema: data/contracts/pipeline_status.schema.json).
Per feed we record `rows`, `age_hours`, `last_success_utc`, and a `status` in
{ok, stale, degraded, down}; the top-level `health` is the WORST feed status.

The whole point (inherited from wc2026): a 0-row write is NEVER silently "ok". A feed
that returns nothing, or hasn't refreshed in too long, or came back short, is surfaced
loudly here so a human sees red instead of trusting stale/empty data.

STDLIB ONLY and DETERMINISTIC: every time calculation takes an injectable `as_of`, so
tests pin the clock and assert exact statuses. No wall-clock reads in the scored logic.
"""

import argparse
import datetime as _dt
import json
import os
import sys

# Repo root = parent of this file's directory (scripts/ -> repo).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_OUT = os.path.join(_REPO_ROOT, "data", "pipeline_status.json")

# Status severity ordering. Higher = worse. Used to roll up the overall health as the
# worst-of across feeds.
_SEVERITY = {"ok": 0, "stale": 1, "degraded": 2, "down": 3}
_BY_SEVERITY = {v: k for k, v in _SEVERITY.items()}

# ---------------------------------------------------------------------------
# Per-feed thresholds. `min_rows`  = fewer than this = a partial pull = DEGRADED.
#                       `stale_hours` = older than this = STALE.
#                       `down_hours`  = older than this = DOWN (feed effectively dead).
# These encode each feed's natural cadence: rosters change slowly (week), scores/odds
# fast (hours). Callers may override per-observation.
# ---------------------------------------------------------------------------
FEED_SPECS = {
    "nflverse_weekly":  {"min_rows": 200,  "stale_hours": 48,  "down_hours": 168},
    "nflverse_rosters": {"min_rows": 1500, "stale_hours": 192, "down_hours": 720},
    "espn_schedule":    {"min_rows": 10,   "stale_hours": 24,  "down_hours": 72},
    "espn_scores":      {"min_rows": 1,    "stale_hours": 24,  "down_hours": 72},
    "espn_injuries":    {"min_rows": 20,   "stale_hours": 48,  "down_hours": 168},
    "odds_api":         {"min_rows": 5,    "stale_hours": 24,  "down_hours": 72},
    "kalshi":           {"min_rows": 1,    "stale_hours": 24,  "down_hours": 72},
    "weather":          {"min_rows": 1,    "stale_hours": 12,  "down_hours": 48},
}

# Fallback thresholds for a feed name not in FEED_SPECS.
_DEFAULT_SPEC = {"min_rows": 1, "stale_hours": 24, "down_hours": 72}


def _parse_utc(iso):
    """Parse an ISO-8601 UTC string to an aware datetime, or None. Accepts a trailing Z."""
    if not iso:
        return None
    s = str(iso).strip().replace("Z", "+00:00")
    try:
        dt = _dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt.astimezone(_dt.timezone.utc)


def _iso_z(dt):
    """Format an aware datetime as 'YYYY-MM-DDTHH:MM:SSZ'."""
    return dt.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def evaluate_feed(name, rows, last_success_utc, as_of, spec=None):
    """Score a single feed. Returns the schema record:
    {rows, age_hours, last_success_utc, status}.

    Decision order (worst wins early — honesty first, never mask a zero):
      1. never succeeded (last_success None) OR rows == 0     -> down
      2. age > down_hours                                     -> down
      3. rows < min_rows (came back short / partial pull)     -> degraded
      4. age > stale_hours                                    -> stale
      5. otherwise                                            -> ok
    """
    spec = spec or FEED_SPECS.get(name, _DEFAULT_SPEC)
    rows = int(rows or 0)
    last_dt = _parse_utc(last_success_utc)

    if last_dt is None:
        # Never had a successful write. age is undefined -> report 0.0 but status down.
        return {"rows": rows, "age_hours": 0.0, "last_success_utc": None, "status": "down"}

    age_hours = round((as_of - last_dt).total_seconds() / 3600.0, 3)
    age_hours = max(0.0, age_hours)  # clamp tiny negative from clock skew

    if rows == 0:
        status = "down"                      # silent-zero: the cardinal sin, always down
    elif age_hours > spec["down_hours"]:
        status = "down"
    elif rows < spec["min_rows"]:
        status = "degraded"
    elif age_hours > spec["stale_hours"]:
        status = "stale"
    else:
        status = "ok"

    return {
        "rows": rows,
        "age_hours": age_hours,
        "last_success_utc": _iso_z(last_dt),
        "status": status,
    }


def compute_status(observations, as_of=None):
    """Roll up per-feed observations into the full pipeline_status document.

    `observations` = dict feed_name -> {rows, last_success_utc, [spec overrides]}.
    `as_of` = aware datetime OR ISO string; defaults to now (UTC). Injectable so tests
    are deterministic.

    Overall `health` = worst-of every feed status. With no feeds at all we report
    'down' — an empty monitor is itself a failure, not a clean bill of health.
    """
    if as_of is None:
        as_of = _dt.datetime.now(_dt.timezone.utc)
    elif isinstance(as_of, str):
        as_of = _parse_utc(as_of)
    if as_of is None:
        raise ValueError("compute_status: unparseable as_of")

    feeds = {}
    worst = 0  # ok
    for name, obs in observations.items():
        obs = obs or {}
        # Allow per-observation threshold overrides while keeping FEED_SPECS defaults.
        spec = dict(FEED_SPECS.get(name, _DEFAULT_SPEC))
        for k in ("min_rows", "stale_hours", "down_hours"):
            if k in obs:
                spec[k] = obs[k]
        rec = evaluate_feed(name, obs.get("rows", 0), obs.get("last_success_utc"), as_of, spec)
        feeds[name] = rec
        worst = max(worst, _SEVERITY[rec["status"]])

    health = _BY_SEVERITY[worst] if feeds else "down"
    return {
        "generated_utc": _iso_z(as_of),
        "health": health,
        # sort_keys keeps feed order stable -> minimal diffs across runs.
        "feeds": dict(sorted(feeds.items())),
    }


def write_status(status, out_path=_DEFAULT_OUT):
    """Write the status doc to disk in the repo's canonical JSON style
    (UTF-8, ensure_ascii, indent=2, trailing newline)."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(status, fh, ensure_ascii=True, indent=2, sort_keys=True)
        fh.write("\n")
    return out_path


def _load_observations(path):
    """Load a feed-observations JSON produced by the cron after the scrapers run:
    {feed_name: {rows, last_success_utc, ...}, ...}."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: observations must be a JSON object of feed->record")
    return data


def main(argv=None):
    """CLI. In the cron, scrapers write an observations file; we score it and emit
    data/pipeline_status.json. `--as-of` pins the clock for reproducible runs/tests.

    If NO observations file is given, every known feed is reported 'down' with 0 rows —
    an honest "we have no evidence any feed ran" rather than a fake green.
    """
    ap = argparse.ArgumentParser(description="Compute data/pipeline_status.json")
    ap.add_argument("--observations", help="JSON file: feed_name -> {rows,last_success_utc}")
    ap.add_argument("--out", default=_DEFAULT_OUT, help="output path")
    ap.add_argument("--as-of", help="ISO-8601 UTC timestamp to score against (default: now)")
    args = ap.parse_args(argv)

    if args.observations:
        observations = _load_observations(args.observations)
    else:
        # No evidence of any run -> every feed down. Never fabricate ok.
        observations = {name: {"rows": 0, "last_success_utc": None} for name in FEED_SPECS}

    status = compute_status(observations, as_of=args.as_of)
    out = write_status(status, args.out)
    # Loud, human-readable summary to stderr so a red run is obvious in cron logs.
    print(f"pipeline health = {status['health'].upper()} -> {out}", file=sys.stderr)
    for name, rec in status["feeds"].items():
        print(f"  {name:18s} {rec['status']:8s} rows={rec['rows']} age_h={rec['age_hours']}", file=sys.stderr)
    # Exit non-zero on a fully-down pipeline so the cron surfaces it (but 'degraded'
    # /'stale' exit 0 — those are warnings, not a reason to fail the whole job).
    return 2 if status["health"] == "down" else 0


if __name__ == "__main__":
    raise SystemExit(main())
