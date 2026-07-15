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


def fetch_weather(lat, lon, kickoff_utc, timeout=_HTTP_TIMEOUT):
    """Hourly forecast for (lat, lon) at the kickoff hour.

    Returns dict: {kickoff_utc, temp_c, wind_kph, precip_mm, source}. Selects the hourly
    bucket nearest the kickoff hour. Loud if the requested day isn't in the forecast
    window (Open-Meteo only forecasts ~16 days out — a request for a far-future Week 18
    game legitimately has no forecast yet; callers should treat that as "no weather
    signal available", not as zeros).

    `kickoff_utc` is an ISO-8601 string ('YYYY-MM-DDTHH:MM' or with 'Z'). We match on the
    UTC hour, so we request the API in UTC (timezone=UTC) for a clean join.
    """
    requests = _require_requests()
    target = _parse_hour(kickoff_utc)
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "temperature_2m,precipitation,wind_speed_10m",
        "wind_speed_unit": "kmh",
        "timezone": "UTC",
        # Bound the window to the kickoff day so the payload is small.
        "start_date": target.date().isoformat(),
        "end_date": target.date().isoformat(),
    }
    resp = requests.get(_OPEN_METEO_URL, params=params, timeout=timeout)
    if resp.status_code != 200:
        raise FeedError(
            f"Open-Meteo returned HTTP {resp.status_code} for ({lat},{lon}). Not treating "
            f"a non-200 as clear skies."
        )
    hourly = (resp.json() or {}).get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise FeedError(
            f"Open-Meteo has no hourly forecast for {target.date()} at ({lat},{lon}) — "
            f"likely beyond the forecast horizon. No weather signal available; do NOT "
            f"substitute zeros."
        )
    idx = _nearest_hour_index(times, target)
    return {
        "kickoff_utc": kickoff_utc,
        "temp_c": _at(hourly.get("temperature_2m"), idx),
        "wind_kph": _at(hourly.get("wind_speed_10m"), idx),
        "precip_mm": _at(hourly.get("precipitation"), idx),
        "source": "open-meteo",
    }


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
