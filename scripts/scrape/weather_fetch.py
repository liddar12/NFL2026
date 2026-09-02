"""Open-Meteo weather fetch for a stadium lat/lon.

Open-Meteo is KEYLESS and free — no secret to manage. It feeds the `weather` player
signal and the `weather_game` game signal (wind/temp/precip), but ONLY for outdoor or
open-retractable venues; the weather signal itself zeroes out indoor games. Roof state
comes from data/fixtures/teams.json (owned by Agent 6), not from here — this module only
fetches the raw forecast for a coordinate + target hour.

`requests` is imported inside the fetch function, guarded — the gate runs with no pip
install. The forecast->number reduction is pure and safe to import anywhere.
"""

import datetime as _dt


class FeedError(RuntimeError):
    """Loud failure: missing dep, non-200, or a payload missing the requested hour."""


_OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
_HTTP_TIMEOUT = 20


def _require_requests():
    try:
        import requests  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover
        raise FeedError(
            "requests is not installed. Install in the pipeline runner only: "
            "`pip install requests`. Never a gate dependency."
        ) from exc
    return requests


def _parse_hour(iso):
    """Parse an ISO-8601 kickoff string to a UTC datetime truncated to the hour."""
    s = str(iso).strip().replace("Z", "+00:00")
    try:
        dt = _dt.datetime.fromisoformat(s)
    except ValueError as exc:
        raise FeedError(f"Unparseable kickoff_utc '{iso}'.") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    dt = dt.astimezone(_dt.timezone.utc)
    return dt.replace(minute=0, second=0, microsecond=0)


def _nearest_hour_index(times, target):
    """Index into Open-Meteo's `time` array whose hour is closest to `target`."""
    best_i, best_delta = 0, None
    for i, t in enumerate(times):
        try:
            dt = _dt.datetime.fromisoformat(t).replace(tzinfo=_dt.timezone.utc)
        except ValueError:
            continue
        delta = abs((dt - target).total_seconds())
        if best_delta is None or delta < best_delta:
            best_i, best_delta = i, delta
    return best_i


def _at(arr, idx):
    """Safe list index; returns None rather than raising on a short array."""
    if not arr or idx >= len(arr):
        return None
    return arr[idx]
