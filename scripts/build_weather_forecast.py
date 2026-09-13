"""BUILD data/weather_forecast.json — kickoff-hour weather FORECAST for the
current season's upcoming NON-DOME home games (open + retractable roofs) from the
Open-Meteo FORECAST API (keyless, free; the archive's live sibling), plus a
CLIMATOLOGY fallback for the games beyond the forecast horizon (R56).

This is the PREDICTION-TIME source for two consumers:
  - scripts/promote_signals.wind_current (game model, adopted weather_wind
    family) reads `games` — FORECAST rows only, exactly as before R56.
  - scripts/build_weekly (weekly_split_v2 weather factor) reads `games` and
    `climatology` through ONE loader; a game takes its forecast row when one
    exists and its climatology row otherwise. Retractable homes are fetched so
    the cold/wind context exists, but build_weekly keeps retractable NEUTRAL
    (the game-day roof state is not knowable from a static table).

TWO ROW KINDS, same key format "season|week|HOME|AWAY", each labelled:
  games[key]       = {temp_c, wind_kph, precip_mm, source: "forecast",
                      fetched_utc}   — kickoff hour, FORECAST_DAYS horizon
  climatology[key] = {temp_c, wind_kph, source: "climatology", n, month,
                      rules}          — the stadium's (home team's) MEAN
                      kickoff-hour temperature and wind for that calendar
                      month over CLIMATOLOGY_SEASONS in data/weather_history.json,
                      only when n >= CLIMATOLOGY_MIN_N games. Fewer games -> NO
                      row (absent is absent, counted in `sources.counts`).
                      `rules` lists which of build_weekly's threshold rules
                      ("cold" <= 0 C, "wind" >= 24 km/h) this row may fire:
                      a rule that fires at the mean but was wrong for MORE THAN
                      HALF of the observed games of that stadium-month in
                      CLIMATOLOGY_EVAL_SEASONS is withheld — the measured guard
                      against a fallback that is worse than roof-only.
                      (docs/WEATHER_HORIZON.md carries the table.)

Unlike the archive, a forecast is NOT immutable: it is rebuilt fresh each run
(the daily cron), because tomorrow's wind estimate changes. The file is
naturally small in-week and EMPTY in the offseason (correctly dormant, no
fabricated values). Stdlib urllib only. Loud on failure, keeps the existing
file. --selftest never fetches, never writes. --climatology-table prints the
measured hit/miss table as markdown (no network).
"""

import datetime as dt
import json
import os
import sys
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.stadiums import STADIUMS  # noqa: E402
from scripts.build_weather_history import pick_hour, load_finals, SEASONS  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "weather_forecast.json")
SCHEDULE_PATH = os.path.join(DATA, "schedule_full.json")
HISTORY_PATH = os.path.join(DATA, "weather_history.json")

FORECAST_DAYS = 16                # Open-Meteo's free forecast horizon (days)
CLIMATOLOGY_MIN_N = 4             # fewer games in a stadium-month -> no row
CLIMATOLOGY_SEASONS = tuple(SEASONS)          # 2021-2025 (weather_history.json)
CLIMATOLOGY_EVAL_SEASONS = (2023, 2024, 2025)  # the hit/miss window for `rules`
# build_weekly's thresholds, mirrored here ONLY to measure the guard; the
# multipliers themselves live in scripts/build_weekly.WEATHER.
RULE_THRESHOLDS = {"cold": ("temp_c", "le", 0.0), "wind": ("wind_kph", "ge", 24.0)}
RULES = tuple(RULE_THRESHOLDS)

FORECAST_URL = ("https://api.open-meteo.com/v1/forecast?latitude={lat}"
                "&longitude={lon}&hourly=temperature_2m,wind_speed_10m,precipitation"
                f"&forecast_days={FORECAST_DAYS}&timezone=UTC")

NON_DOME_HOMES = {ab: s for ab, s in STADIUMS.items()
                  if s.get("roof") in ("open", "retractable")}


def _parse_utc(s):
    """datetime (UTC) from an ISO string like '2026-09-10T00:20Z' / '...:20:00Z'."""
    s = str(s).rstrip("Z")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def within_horizon(kickoff_utc, now_utc, days=FORECAST_DAYS):
    """True when the kickoff falls inside the forecast horizon: from now until
    the end of the day `days - 1` days ahead (Open-Meteo's forecast_days
    counts today as day 1)."""
    k = _parse_utc(kickoff_utc)
    if k is None or k < now_utc:
        return False
    end = (now_utc + dt.timedelta(days=days - 1)).replace(hour=23, minute=59, second=59,
                                                          microsecond=0)
    return k <= end


def upcoming_non_dome_home_games(doc):
    """[(key, game)] for the season's SCHEDULED non-dome (open + retractable)
    home games from a schedule_full document."""
    season = doc.get("season")
    out = []
    for g in doc.get("games") or []:
        if g.get("home") not in NON_DOME_HOMES:
            continue
        if g.get("status") not in (None, "STATUS_SCHEDULED"):
            continue                              # final/in-progress: not a forecast target
        key = f"{season}|{g.get('week')}|{g['home']}|{g['away']}"
        out.append((key, g))
    return out


def _rule_fires(value, rule):
    field, op, thr = RULE_THRESHOLDS[rule]
    return value <= thr if op == "le" else value >= thr


# ----------------------------------------------------------------------------------
# climatology — stadium x calendar month means from the observed archive
# ----------------------------------------------------------------------------------

def climatology_table(history_games, finals_by_season, min_n=CLIMATOLOGY_MIN_N,
                      eval_seasons=CLIMATOLOGY_EVAL_SEASONS):
    """{(home, month): row} for every stadium-month with n >= min_n games, plus the
    measured guard. history_games is weather_history.json's `games`
    ("season|week|HOME|AWAY" -> {temp_c, wind_kph, ...}); finals_by_season is
    {season: [finals game rows]} — the join gives the home team and the kickoff
    month (UTC) without trusting the key's team order (both spellings are joined).

    Each row: {temp_c, wind_kph, n, month, rules, eval: {n, cold_obs, wind_obs,
    cold_fires, cold_wrong, wind_fires, wind_wrong}}. `rules` admits a threshold
    rule unless it fires at the mean AND was wrong for more than half of the
    eval-season games; a rule that fires with NO eval games is withheld too
    (unmeasured is not admitted). Stadium-months below min_n are returned under
    `skipped` instead; history rows that join no finals row under `unjoined`."""
    finals = {}
    for season, games in finals_by_season.items():
        for g in games:
            finals[f"{season}|{g['week']}|{g['home']}|{g['away']}"] = g
            finals[f"{season}|{g['week']}|{g['away']}|{g['home']}"] = g
    buckets = {}
    unjoined = 0
    for key, w in history_games.items():
        g = finals.get(key)
        k = _parse_utc(g["kickoff_utc"]) if g else None
        if g is None or k is None or w.get("temp_c") is None or w.get("wind_kph") is None:
            unjoined += 1
            continue
        season = int(str(key).split("|")[0])
        buckets.setdefault((g["home"], k.month), []).append(
            (season, float(w["temp_c"]), float(w["wind_kph"])))
    rows, skipped = {}, {}
    for (home, month), obs in buckets.items():
        n = len(obs)
        if n < min_n:
            skipped[(home, month)] = n
            continue
        mean_t = sum(t for _, t, _ in obs) / n
        mean_w = sum(w for _, _, w in obs) / n
        ev = [(t, w) for s, t, w in obs if s in eval_seasons]
        means = {"cold": mean_t, "wind": mean_w}
        stats = {"n": len(ev),
                 "cold_obs": sum(1 for t, _ in ev if _rule_fires(t, "cold")),
                 "wind_obs": sum(1 for _, w in ev if _rule_fires(w, "wind"))}
        admitted = []
        for rule in RULES:
            fires = _rule_fires(means[rule], rule)
            wrong = (len(ev) - stats[f"{rule}_obs"]) if fires else 0
            stats[f"{rule}_fires"] = fires
            stats[f"{rule}_wrong"] = wrong
            if not fires:
                admitted.append(rule)          # nothing to guard: cannot misfire
            elif ev and wrong * 2 <= len(ev):
                admitted.append(rule)          # measured, wrong at most half the time
        rows[(home, month)] = {"temp_c": round(mean_t, 1), "wind_kph": round(mean_w, 1),
                               "n": n, "month": month, "rules": admitted, "eval": stats}
    return {"rows": rows, "skipped": skipped, "unjoined": unjoined}


def climatology_row(table_row):
    """The on-disk climatology row (the eval block stays in the doc/table)."""
    return {"temp_c": table_row["temp_c"], "wind_kph": table_row["wind_kph"],
            "source": "climatology", "n": table_row["n"], "month": table_row["month"],
            "rules": list(table_row["rules"])}


def climatology_markdown(table):
    """The measured hit/miss table (docs/WEATHER_HORIZON.md) as markdown lines."""
    lines = ["| Home | Month | n (21-25) | mean temp C | mean wind km/h | cold fires | "
             "wind fires | eval games (23-25) | obs <= 0 C | obs >= 24 km/h | cold wrong | "
             "wind wrong | rules admitted |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for (home, month), r in sorted(table["rows"].items()):
        e = r["eval"]

        def wrong(rule):
            if not e[f"{rule}_fires"]:
                return "-"
            return f"{e[f'{rule}_wrong']}/{e['n']}"
        lines.append(f"| {home} | {month} | {r['n']} | {r['temp_c']} | {r['wind_kph']} | "
                     f"{'yes' if e['cold_fires'] else 'no'} | "
                     f"{'yes' if e['wind_fires'] else 'no'} | "
                     f"{e['n']} | {e['cold_obs']} | {e['wind_obs']} | {wrong('cold')} | "
                     f"{wrong('wind')} | {', '.join(r['rules']) or '(none)'} |")
    return lines


# ----------------------------------------------------------------------------------
# the document — pure given its inputs; main() only supplies I/O
# ----------------------------------------------------------------------------------

def build_document(schedule_doc, now_utc, fetch_hourly, history_games=None,
                   finals_by_season=None, generated_utc=None):
    """(doc, stats). fetch_hourly(home) -> Open-Meteo `hourly` payload or None on
    failure (main passes the network fetcher; the selftest a fixture).
    A game inside the horizon takes its kickoff-hour forecast; a game with no
    forecast row (beyond the horizon, or its fetch failed) takes the home
    stadium's climatology row for its kickoff month when one exists; otherwise it
    is absent and counted."""
    rows = upcoming_non_dome_home_games(schedule_doc)
    stamp = generated_utc or now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
    stats = {"scheduled": len(rows), "forecast": 0, "climatology": 0, "absent": 0,
             "fetch_calls": 0, "fetch_failed": 0, "beyond_horizon": 0}
    games = {}
    by_home = {}
    for key, g in rows:
        if within_horizon(g.get("kickoff_utc"), now_utc):
            by_home.setdefault(g["home"], []).append((key, g))
        else:
            stats["beyond_horizon"] += 1
    for home, hg in by_home.items():
        hourly = fetch_hourly(home)
        if hourly is None:
            stats["fetch_failed"] += 1
            continue
        stats["fetch_calls"] += 1
        for key, g in hg:
            w = pick_hour(hourly, str(g["kickoff_utc"]))
            if w is not None:
                w["source"] = "forecast"
                w["fetched_utc"] = stamp
                games[key] = w
    stats["forecast"] = len(games)

    table = climatology_table(history_games or {}, finals_by_season or {})
    climatology = {}
    for key, g in rows:
        if key in games:
            continue
        k = _parse_utc(g.get("kickoff_utc"))
        row = table["rows"].get((g["home"], k.month)) if k else None
        if row is None:
            stats["absent"] += 1
            continue
        climatology[key] = climatology_row(row)
    stats["climatology"] = len(climatology)

    doc = {
        "generated_utc": stamp,
        "source": ("open-meteo forecast (kickoff hour, upcoming non-dome homes) + "
                   "weather_history.json climatology (stadium x month means) beyond "
                   "the horizon"),
        "games": games,
        "climatology": climatology,
        "sources": {
            "forecast_days": FORECAST_DAYS,
            "climatology_min_n": CLIMATOLOGY_MIN_N,
            "climatology_seasons": list(CLIMATOLOGY_SEASONS),
            "climatology_eval_seasons": list(CLIMATOLOGY_EVAL_SEASONS),
            "climatology_stadium_months": len(table["rows"]),
            "climatology_skipped_lt_min_n": len(table["skipped"]),
            "counts": {"scheduled": stats["scheduled"], "forecast": stats["forecast"],
                       "climatology": stats["climatology"], "absent": stats["absent"]},
        },
    }
    return doc, stats


def _load_history_games():
    if not os.path.exists(HISTORY_PATH):
        return {}
    with open(HISTORY_PATH, encoding="utf-8") as fh:
        return json.load(fh).get("games") or {}


def _load_finals_by_season():
    out = {}
    for season in CLIMATOLOGY_SEASONS:
        try:
            out[season] = load_finals(season)
        except (OSError, ValueError, KeyError):
            continue
    return out


def _network_fetch(home):
    st = NON_DOME_HOMES[home]
    url = FORECAST_URL.format(lat=st["lat"], lon=st["lon"])
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            payload = json.load(resp)
    except Exception as err:  # noqa: BLE001 — loud, keep going for other homes
        print(f"WEATHER FORECAST: fetch failed for {home}: {err}", file=sys.stderr)
        return None
    return payload.get("hourly") or {}


# ----------------------------------------------------------------------------------
# selftest — horizon pick, retractable included, climatology from a fixture,
# n < min_n excluded, key formats. Never fetches, never writes.
# ----------------------------------------------------------------------------------

def selftest():
    # kickoff-hour picking (shared with the archive builder)
    payload = {"time": ["2026-09-10T00:00", "2026-09-11T00:00"],
               "temperature_2m": [21.0, 19.0],
               "wind_speed_10m": [33.0, 12.0],
               "precipitation": [0.0, 0.4]}
    got = pick_hour(payload, "2026-09-10T00:20:00Z")
    assert got == {"wind_kph": 33.0, "temp_c": 21.0, "precip_mm": 0.0}, got
    assert pick_hour(payload, "2026-09-12T00:00:00Z") is None, "outside payload -> None"

    # horizon: day 1 is today; day 16 is the last covered day; day 17 is out
    now = dt.datetime(2026, 9, 8, 12, 0, tzinfo=dt.timezone.utc)
    assert within_horizon("2026-09-08T20:00Z", now)
    assert within_horizon("2026-09-23T23:00Z", now), "day 16 is inside"
    assert not within_horizon("2026-09-24T00:20Z", now), "day 17 is beyond"
    assert not within_horizon("2026-09-08T11:00Z", now), "the past is not a target"
    assert not within_horizon(None, now)

    # non-dome selection: open + retractable in, dome out (the real stadium table)
    roofs = {s["roof"] for s in NON_DOME_HOMES.values()}
    assert roofs == {"open", "retractable"}, roofs
    assert "ARI" in NON_DOME_HOMES and "DAL" in NON_DOME_HOMES, "retractable homes fetched"
    assert "DET" not in NON_DOME_HOMES and "LV" not in NON_DOME_HOMES, "domes never"
    sched = {"season": 2026, "games": [
        {"week": 1, "home": "GB", "away": "CHI", "kickoff_utc": "2026-09-10T00:20Z",
         "status": "STATUS_SCHEDULED"},                       # open, in horizon
        {"week": 1, "home": "DAL", "away": "NYG", "kickoff_utc": "2026-09-13T20:25Z",
         "status": "STATUS_SCHEDULED"},                       # retractable, in horizon
        {"week": 1, "home": "DET", "away": "MIN", "kickoff_utc": "2026-09-13T17:00Z",
         "status": "STATUS_SCHEDULED"},                       # dome: never a row
        {"week": 13, "home": "GB", "away": "DET", "kickoff_utc": "2026-12-06T18:00Z",
         "status": "STATUS_SCHEDULED"},                       # beyond -> climatology
        {"week": 14, "home": "CLE", "away": "PIT", "kickoff_utc": "2026-12-13T18:00Z",
         "status": "STATUS_SCHEDULED"},                       # beyond, n < 4 -> absent
        {"week": 2, "home": "GB", "away": "DET", "kickoff_utc": "2026-09-01T00:00Z",
         "status": "STATUS_FINAL"},                           # played: not a target
    ]}
    picks = upcoming_non_dome_home_games(sched)
    assert [k for k, _ in picks] == ["2026|1|GB|CHI", "2026|1|DAL|NYG", "2026|13|GB|DET",
                                     "2026|14|CLE|PIT"], picks

    def hourly_for(home):
        if home == "GB":
            return {"time": ["2026-09-10T00:00"], "temperature_2m": [18.0],
                    "wind_speed_10m": [26.0], "precipitation": [0.0]}
        if home == "DAL":
            return {"time": ["2026-09-13T20:00"], "temperature_2m": [31.0],
                    "wind_speed_10m": [9.0], "precipitation": [0.0]}
        raise AssertionError(f"unexpected fetch for {home}")

    # a small history fixture: GB December 5 games (mean -1.0 C, 12 km/h; the
    # 2023-25 games are 2 of 3 at/below 0 C -> cold admitted), CLE December 3
    # games (n < 4 -> no row), GB January 4 games with a windy mean (24.0)
    # whose 2023-25 games were calm 3 of 3 -> wind withheld.
    finals = {}
    hist = {}

    def add(season, week, home, away, kickoff, temp, wind):
        finals.setdefault(season, []).append({"week": week, "home": home, "away": away,
                                              "kickoff_utc": kickoff})
        # write the history key in BOTH orders across the fixture to prove the
        # join does not trust the key's team order
        key = (f"{season}|{week}|{home}|{away}" if week % 2 else
               f"{season}|{week}|{away}|{home}")
        hist[key] = {"temp_c": temp, "wind_kph": wind, "precip_mm": 0.0}
    add(2021, 13, "GB", "CHI", "2021-12-12T18:00Z", -3.0, 10.0)
    add(2022, 14, "GB", "MIN", "2022-12-11T18:00Z", 1.0, 14.0)
    add(2023, 13, "GB", "DET", "2023-12-03T18:00Z", -2.0, 10.0)
    add(2024, 14, "GB", "SEA", "2024-12-15T18:00Z", 1.0, 12.0)
    add(2025, 15, "GB", "CHI", "2025-12-14T18:00Z", -2.0, 14.0)
    add(2023, 14, "CLE", "PIT", "2023-12-10T18:00Z", 1.0, 30.0)
    add(2024, 15, "CLE", "KC", "2024-12-15T18:00Z", 3.0, 25.0)
    add(2025, 16, "CLE", "BUF", "2025-12-21T18:00Z", -1.0, 28.0)
    add(2021, 18, "GB", "DET", "2022-01-09T18:00Z", 4.0, 60.0)
    add(2023, 18, "GB", "CHI", "2024-01-07T18:00Z", 5.0, 10.0)
    add(2024, 18, "GB", "CHI", "2025-01-05T18:00Z", 6.0, 12.0)
    add(2025, 18, "GB", "MIN", "2026-01-04T18:00Z", 3.0, 14.0)
    table = climatology_table(hist, finals)
    assert table["unjoined"] == 0
    assert set(table["rows"]) == {("GB", 12), ("GB", 1)}, set(table["rows"])
    assert table["skipped"] == {("CLE", 12): 3}, "n < 4 is skipped and counted"
    gb_dec = table["rows"][("GB", 12)]
    assert gb_dec["n"] == 5 and gb_dec["temp_c"] == -1.0 and gb_dec["wind_kph"] == 12.0
    assert gb_dec["eval"]["cold_fires"] and gb_dec["eval"]["cold_wrong"] == 1
    assert gb_dec["rules"] == ["cold", "wind"], gb_dec["rules"]
    gb_jan = table["rows"][("GB", 1)]
    assert gb_jan["wind_kph"] == 24.0 and gb_jan["eval"]["wind_fires"]
    assert gb_jan["eval"]["wind_wrong"] == 3 and gb_jan["rules"] == ["cold"], \
        "a rule wrong more than half the time is withheld"
    # unmeasured (fires, no eval games) is withheld too
    old_only = {k: v for k, v in hist.items() if k.split("|")[0] in ("2021", "2022")}
    t2 = climatology_table(old_only | {"2020|13|GB|CHI": {"temp_c": -5.0, "wind_kph": 8.0},
                                       "2019|13|GB|CHI": {"temp_c": -5.0, "wind_kph": 8.0}},
                           finals | {2020: [{"week": 13, "home": "GB", "away": "CHI",
                                             "kickoff_utc": "2020-12-06T18:00Z"}],
                                     2019: [{"week": 13, "home": "GB", "away": "CHI",
                                             "kickoff_utc": "2019-12-08T18:00Z"}]})
    assert t2["rows"][("GB", 12)]["rules"] == ["wind"], t2["rows"][("GB", 12)]

    doc, stats = build_document(sched, now, hourly_for, hist, finals,
                                generated_utc="2026-09-08T12:00:00Z")
    assert set(doc) == {"generated_utc", "source", "games", "climatology", "sources"}
    assert doc["games"] == {
        "2026|1|GB|CHI": {"wind_kph": 26.0, "temp_c": 18.0, "precip_mm": 0.0,
                          "source": "forecast", "fetched_utc": "2026-09-08T12:00:00Z"},
        "2026|1|DAL|NYG": {"wind_kph": 9.0, "temp_c": 31.0, "precip_mm": 0.0,
                           "source": "forecast", "fetched_utc": "2026-09-08T12:00:00Z"},
    }, doc["games"]
    assert doc["climatology"] == {
        "2026|13|GB|DET": {"temp_c": -1.0, "wind_kph": 12.0, "source": "climatology",
                           "n": 5, "month": 12, "rules": ["cold", "wind"]},
    }, doc["climatology"]
    assert stats == {"scheduled": 4, "forecast": 2, "climatology": 1, "absent": 1,
                     "fetch_calls": 2, "fetch_failed": 0, "beyond_horizon": 2}, stats
    assert doc["sources"]["counts"] == {"scheduled": 4, "forecast": 2, "climatology": 1,
                                        "absent": 1}
    assert doc["sources"]["forecast_days"] == 16 and doc["sources"]["climatology_min_n"] == 4
    for key in list(doc["games"]) + list(doc["climatology"]):
        season, week, home, away = key.split("|")
        assert season == "2026" and week.isdigit() and home in NON_DOME_HOMES and away
    # a fetch failure inside the horizon falls to climatology when one exists
    doc2, stats2 = build_document(
        {"season": 2026, "games": [{"week": 13, "home": "GB", "away": "DET",
                                    "kickoff_utc": "2026-12-06T18:00Z"}]},
        dt.datetime(2026, 12, 1, tzinfo=dt.timezone.utc), lambda home: None, hist, finals)
    assert stats2["fetch_failed"] == 1 and list(doc2["climatology"]) == ["2026|13|GB|DET"]
    # the meta constants build_weekly stamps into player_weekly.json mirror these
    from scripts import build_weekly as bw
    assert bw.WEATHER_SOURCES == {"forecast_days": FORECAST_DAYS,
                                  "climatology_min_n": CLIMATOLOGY_MIN_N}
    assert bw.WEATHER["cold_c"] == RULE_THRESHOLDS["cold"][2]
    assert bw.WEATHER["wind_kph"] == RULE_THRESHOLDS["wind"][2]
    assert tuple(bw.WEATHER_RULES) == RULES
    assert climatology_markdown(table)[2].startswith("| GB | 1 | 4 | 4.5 | 24.0 | no | yes | 3 |")
    print("selftest OK: horizon pick, non-dome (open + retractable) targets, climatology "
          "means with the n >= 4 floor and the measured rule guard, key formats")


def main():
    if not os.path.exists(SCHEDULE_PATH):
        print("WEATHER FORECAST: no schedule yet; nothing to do.")
        return 0
    with open(SCHEDULE_PATH, encoding="utf-8") as fh:
        schedule_doc = json.load(fh)
    if not upcoming_non_dome_home_games(schedule_doc):
        # Offseason / no schedule yet: dormant by design. Do not clobber an
        # existing file with an empty one mid-season if the schedule vanished.
        print("WEATHER FORECAST: no upcoming non-dome home games; nothing to do.")
        return 0

    now = dt.datetime.now(dt.timezone.utc)
    doc, stats = build_document(schedule_doc, now, _network_fetch,
                                _load_history_games(), _load_finals_by_season())
    if stats["fetch_calls"] == 0 and stats["fetch_failed"]:
        # Never reached the API: keep the existing file rather than replacing
        # live forecast rows with climatology alone.
        print("WEATHER FORECAST: every forecast fetch failed; keeping the existing file.",
              file=sys.stderr)
        return 1
    if not doc["games"]:
        print("WEATHER FORECAST: no kickoff hours within the forecast horizon yet.",
              file=sys.stderr)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=1, sort_keys=True)
        fh.write("\n")
    print(f"Wrote weather_forecast.json: {stats['forecast']} forecast rows, "
          f"{stats['climatology']} climatology rows, {stats['absent']} absent "
          f"of {stats['scheduled']} scheduled non-dome home games "
          f"({stats['fetch_calls']} forecast calls, {stats['fetch_failed']} failed)")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    if "--climatology-table" in sys.argv:
        table = climatology_table(_load_history_games(), _load_finals_by_season())
        print("\n".join(climatology_markdown(table)))
        print(f"\nstadium-months: {len(table['rows'])} with n >= {CLIMATOLOGY_MIN_N}, "
              f"{len(table['skipped'])} skipped (n < {CLIMATOLOGY_MIN_N}), "
              f"{table['unjoined']} history rows unjoined")
        sys.exit(0)
    sys.exit(main())
