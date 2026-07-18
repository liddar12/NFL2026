"""BUILD data/weather_history.json — kickoff-hour weather for every OPEN-ROOF
home game in the finals fixtures, from the Open-Meteo HISTORICAL ARCHIVE
(keyless, free). Raw material for the promotion gate's `weather` candidate
family: wind/cold/precip deltas earn pricing weight ONLY through NEVER-REGRESS.

Batched: ONE archive call per (stadium, season) covering that season's date
span, then kickoff hours are picked out locally — ~80 calls for five seasons.
Indoor/closed-roof venues are skipped entirely (weather cannot touch the game).
Stdlib urllib only. Loud on failure; keeps the existing file. --selftest checks
the hour-picking math on a fixture payload, never fetches, never writes.
"""

import json
import os
import sys
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.stadiums import STADIUMS  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "weather_history.json")
SEASONS = [2021, 2022, 2023, 2024, 2025]
ARCHIVE_URL = ("https://archive-api.open-meteo.com/v1/archive?latitude={lat}"
               "&longitude={lon}&start_date={start}&end_date={end}"
               "&hourly=temperature_2m,wind_speed_10m,precipitation&timezone=UTC")

OPEN_HOMES = {ab: s for ab, s in STADIUMS.items() if s.get("roof") == "open"}


def load_finals(year):
    with open(os.path.join(DATA, "fixtures", f"finals_{year}.json"), encoding="utf-8") as fh:
        return json.load(fh)["games"]


def pick_hour(payload_hourly, kickoff_utc):
    """{wind_kph, temp_c, precip_mm} for the hour nearest kickoff, or None."""
    want = kickoff_utc[:13]                      # "2024-12-01T18"
    times = payload_hourly.get("time") or []
    try:
        idx = times.index(want + ":00")
    except ValueError:
        return None
    def val(key):
        arr = payload_hourly.get(key) or []
        return arr[idx] if idx < len(arr) and arr[idx] is not None else None
    wind = val("wind_speed_10m")
    temp = val("temperature_2m")
    precip = val("precipitation")
    if wind is None or temp is None:
        return None
    return {"wind_kph": round(float(wind), 1), "temp_c": round(float(temp), 1),
            "precip_mm": round(float(precip or 0.0), 2)}


def selftest():
    payload = {"time": ["2024-12-01T17:00", "2024-12-01T18:00", "2024-12-01T19:00"],
               "temperature_2m": [3.0, 2.5, 2.0],
               "wind_speed_10m": [20.0, 32.5, 28.0],
               "precipitation": [0.0, 1.2, None]}
    got = pick_hour(payload, "2024-12-01T18:05:00Z")
    assert got == {"wind_kph": 32.5, "temp_c": 2.5, "precip_mm": 1.2}, got
    assert pick_hour(payload, "2024-12-02T18:00:00Z") is None, "missing day -> None"
    print("selftest OK: kickoff-hour picking exact")


def main():
    existing = {}
    if os.path.exists(OUT_PATH):
        with open(OUT_PATH, encoding="utf-8") as fh:
            existing = (json.load(fh)).get("games") or {}

    out = dict(existing)
    fetched_calls = 0
    for season in SEASONS:
        games = [g for g in load_finals(season) if g["home"] in OPEN_HOMES]
        # Group this season's open-air games by home stadium for batched calls.
        by_home = {}
        for g in games:
            key = f"{season}|{g['week']}|{g['home']}|{g['away']}"
            if key in out:
                continue                          # immutable history: no refetch
            by_home.setdefault(g["home"], []).append((key, g))
        for home, rows in by_home.items():
            st = OPEN_HOMES[home]
            dates = sorted(str(g["kickoff_utc"])[:10] for _, g in rows)
            url = ARCHIVE_URL.format(lat=st["lat"], lon=st["lon"],
                                     start=dates[0], end=dates[-1])
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    payload = json.load(resp)
                fetched_calls += 1
            except Exception as err:  # noqa: BLE001 — loud, keep existing
                print(f"WEATHER HISTORY: fetch failed for {home} {season}: {err}",
                      file=sys.stderr)
                continue
            hourly = payload.get("hourly") or {}
            for key, g in rows:
                w = pick_hour(hourly, str(g["kickoff_utc"]))
                if w is not None:
                    out[key] = w

    if not out:
        print("WEATHER HISTORY: nothing fetched; keeping existing file.", file=sys.stderr)
        return 0 if existing else 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "open-meteo historical archive (kickoff hour, open-roof homes only)",
        "games": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote weather_history.json: {len(out)} games ({fetched_calls} archive calls this run)")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
