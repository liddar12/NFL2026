"""BUILD data/weather_forecast.json — kickoff-hour wind FORECAST for the current
season's UPCOMING open-roof home games, from the Open-Meteo FORECAST API
(keyless, free; the archive's live sibling). This is the PREDICTION-TIME source
for the adopted weather_wind family: the promotion gate earns the wind edge on
the historical archive (build_weather_history.py), and the pipeline applies it
to upcoming games from THIS forecast — exactly the qb_out pattern (gate learns
on history, build_predictions applies from a daily-refreshed current file).

Unlike the archive, a forecast is NOT immutable: it is rebuilt fresh each run
(the daily cron), because tomorrow's wind estimate changes. Games outside the
~16-day forecast horizon simply aren't covered yet — so the file is naturally
small in-week and EMPTY in the offseason (correctly dormant, no fabricated
values). Open roofs only; indoor/retractable venues skip. Stdlib urllib only.
Loud on failure, keeps the existing file. --selftest checks the hour-picking on
a fixture payload, never fetches, never writes.
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
from scripts.build_weather_history import pick_hour  # noqa: E402  (shared hour math)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "weather_forecast.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
# forecast_days=16 is Open-Meteo's free horizon; past games return no hour and
# are silently dropped by pick_hour (fine — they score off actual results).
FORECAST_URL = ("https://api.open-meteo.com/v1/forecast?latitude={lat}"
                "&longitude={lon}&hourly=temperature_2m,wind_speed_10m,precipitation"
                "&forecast_days=16&timezone=UTC")

OPEN_HOMES = {ab: s for ab, s in STADIUMS.items() if s.get("roof") == "open"}


def upcoming_open_home_games():
    """[(key, game)] for the current season's SCHEDULED open-roof home games,
    from schedule_full.json. Empty when the schedule is absent (day zero)."""
    if not os.path.exists(SCHEDULE_PATH):
        return []
    with open(SCHEDULE_PATH, encoding="utf-8") as fh:
        doc = json.load(fh)
    season = doc.get("season")
    games = doc.get("games") or []
    out = []
    for g in games:
        if g.get("home") not in OPEN_HOMES:
            continue
        if g.get("status") not in (None, "STATUS_SCHEDULED"):
            continue                              # final/in-progress: not a forecast target
        key = f"{season}|{g.get('week')}|{g['home']}|{g['away']}"
        out.append((key, g))
    return out


def selftest():
    payload = {"time": ["2026-09-10T00:00", "2026-09-11T00:00"],
               "temperature_2m": [21.0, 19.0],
               "wind_speed_10m": [33.0, 12.0],
               "precipitation": [0.0, 0.4]}
    got = pick_hour(payload, "2026-09-10T00:20:00Z")
    assert got == {"wind_kph": 33.0, "temp_c": 21.0, "precip_mm": 0.0}, got
    assert pick_hour(payload, "2026-09-12T00:00:00Z") is None, "outside horizon -> None"
    print("selftest OK: forecast kickoff-hour picking exact")


def main():
    rows = upcoming_open_home_games()
    if not rows:
        # Offseason / no schedule yet: dormant by design. Do not clobber an
        # existing file with an empty one mid-season if the schedule vanished.
        print("WEATHER FORECAST: no upcoming open-roof home games; nothing to do.")
        return 0

    # A forecast is fresh each run — rebuild from scratch (unlike the archive).
    by_home = {}
    for key, g in rows:
        by_home.setdefault(g["home"], []).append((key, g))

    out = {}
    fetched_calls = 0
    for home, games in by_home.items():
        st = OPEN_HOMES[home]
        url = FORECAST_URL.format(lat=st["lat"], lon=st["lon"])
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                payload = json.load(resp)
            fetched_calls += 1
        except Exception as err:  # noqa: BLE001 — loud, keep going for other homes
            print(f"WEATHER FORECAST: fetch failed for {home}: {err}", file=sys.stderr)
            continue
        hourly = payload.get("hourly") or {}
        for key, g in games:
            w = pick_hour(hourly, str(g["kickoff_utc"]))
            if w is not None:
                out[key] = w

    if not out:
        print("WEATHER FORECAST: no kickoff hours within the forecast horizon yet.",
              file=sys.stderr)
        # Write an explicit empty forecast so the pipeline reads 'no wind data'
        # rather than a stale one — but only if we actually reached the API.
        if fetched_calls == 0:
            return 1

    import datetime as dt
    doc = {
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "open-meteo forecast (kickoff hour, upcoming open-roof homes only)",
        "games": out,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote weather_forecast.json: {len(out)} upcoming games "
          f"({fetched_calls} forecast calls this run)")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    sys.exit(main())
