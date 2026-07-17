"""Environment model — MEASURED 2021-2025 venue/weather/travel history.

Answers "is there anything there?" with numbers, not vibes:
  - per-venue 5-yr home-field advantage (home win% + avg home margin),
  - turf/grass home splits,
  - cold-weather performance (< 32 F at kickoff, from Open-Meteo ARCHIVE reanalysis
    joined to each game's kickoff hour — measured, not modeled),
  - dome-teams-playing-outdoor-cold delta,
  - international-game designated-home bias (every intl game listed).

Everything here is MEASURED HISTORY (each split carries its sample size n and a
low_n flag when n < 8), but its use in prediction stays parameterized + gated: the
derived params are RECORDED in environment_model.json (params.applied=false), never
silently applied. Game probabilities do not change because this file exists.

Data sources (probed live before this was written):
  - ESPN scoreboard finals 2021-2025 via scripts.scrape.espn.fetch_final_results
    (STATUS-gated; rows carry optional venue/venue_city/venue_country).
  - Open-Meteo ARCHIVE (keyless ERA5 reanalysis): ONE call per (stadium, season
    Sep-Jan window) with hourly temperature_2m + wind_speed_10m in F/mph, then each
    game's kickoff hour is joined locally. Open-roof venues only — retractables are
    skipped because the per-game roof state is unknowable from a static table.

Run it for real (network + `requests`, a few minutes of polite API calls):
    python3 -m scripts.build_environment
The fast gate never runs this; it validates the committed environment_model.json.
"""

import datetime as dt
import json
import math
import os
import sys
import time

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import espn  # noqa: E402
from scripts.scrape.stadiums import STADIUMS, dome_teams  # noqa: E402

SEASON_RANGE = [2021, 2025]
SEASONS = tuple(range(SEASON_RANGE[0], SEASON_RANGE[1] + 1))
COLD_THRESHOLD_F = 32
LOW_N = 8            # a split with n < 8 is reported but flagged low_n:true
_SLEEP_S = 0.3       # politeness between archive calls (and between season sweeps)

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "environment_model.json")

_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
_HTTP_TIMEOUT = 30

# Weather is joined for kickoffs in these months (Oct-Jan); the archive window is
# fetched Sep-Jan in one call per (stadium, season) anyway — cheap and simple.
_WEATHER_MONTHS = (10, 11, 12, 1)


class FeedError(RuntimeError):
    """Loud failure: non-200 archive response or a structurally empty payload."""


def _utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _win_value(us, them):
    """1 win, 0 loss, 0.5 tie — NFL ties are real (rare) and must not be dropped."""
    if us > them:
        return 1.0
    if us < them:
        return 0.0
    return 0.5


def _pct(wins, n):
    return round(wins / n, 4) if n else 0.0


def _mean(xs):
    return round(sum(xs) / len(xs), 2) if xs else 0.0


def _kick_hour_key(kickoff_utc):
    """Round an ESPN kickoff ('2022-11-13T18:00Z') to the nearest UTC hour in
    Open-Meteo's hourly time format ('2022-11-13T18:00'). None if unparseable."""
    try:
        d = dt.datetime.fromisoformat(str(kickoff_utc).replace("Z", "+00:00"))
    except ValueError:
        return None
    d = d.astimezone(dt.timezone.utc)
    if d.minute >= 30:
        d += dt.timedelta(hours=1)
    return d.strftime("%Y-%m-%dT%H:00")


# ---------------------------------------------------------------------------
# Feeds.
# ---------------------------------------------------------------------------

def _retry(label, fn, attempts=4):
    """Retry a flaky network call with linear backoff, loudly. The FINAL failure
    still raises — retries mask transient timeouts, never real outages."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — re-raised on the last attempt
            if i == attempts - 1:
                raise
            wait = 3.0 * (i + 1)
            print(f"  [retry] {label}: {exc.__class__.__name__} ({exc}); "
                  f"attempt {i + 2}/{attempts} in {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)


def fetch_all_finals(seasons=SEASONS):
    """All FINAL regular-season games for the window, each tagged with its season
    `yr` and `week`. STATUS-gated by espn.fetch_scores; loud on any zero-event week.
    Fetched week-by-week with retries — this sandbox shares its egress with sibling
    pipeline agents, so an occasional ESPN read timeout is expected, not fatal."""
    finals = []
    for yr in seasons:
        season_rows = []
        for wk in range(1, 19):
            rows = _retry(
                f"ESPN scores {yr} wk{wk}",
                lambda yr=yr, wk=wk: espn.fetch_scores(yr, week=wk, final_only=True),
            )
            for g in rows:
                g["yr"] = yr
                g["week"] = wk
                season_rows.append(g)
            time.sleep(0.2)  # polite: ~90 scoreboard calls total for the window
        if len(season_rows) < 250:  # a completed modern season has 271-272 finals
            raise FeedError(
                f"season {yr}: only {len(season_rows)} FINAL games (expected ~272) — "
                f"refusing to compute 5-yr splits on a partial season."
            )
        finals.extend(season_rows)
        print(f"  finals {yr}: {len(season_rows)} games")
    return finals


def fetch_weather_archive(lat, lon, season):
    """ONE Open-Meteo ARCHIVE call for a stadium's Sep-Jan season window. Returns
    {'YYYY-MM-DDTHH:00': (temp_f, wind_mph)} for every hour in the window. Loud on
    non-200 or an empty hourly block — never substitute zeros for missing weather."""
    try:
        import requests  # noqa: PLC0415 (pipeline-runner-only dep, never on the gate)
    except ImportError as exc:  # pragma: no cover
        raise FeedError("requests is not installed (pipeline runner only).") from exc
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": f"{season}-09-01",
        "end_date": f"{season + 1}-01-31",
        "hourly": "temperature_2m,wind_speed_10m",
        "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph",
        "timezone": "UTC",
    }
    resp = requests.get(_ARCHIVE_URL, params=params, timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise FeedError(
            f"Open-Meteo archive HTTP {resp.status_code} for ({lat},{lon}) {season} — "
            f"not treating a non-200 as clear skies."
        )
    hourly = (resp.json() or {}).get("hourly") or {}
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    winds = hourly.get("wind_speed_10m") or []
    if not times or len(times) != len(temps):
        raise FeedError(f"Open-Meteo archive empty/misaligned hourly for ({lat},{lon}) {season}.")
    return {t: (temps[i], winds[i] if i < len(winds) else None) for i, t in enumerate(times)}


# ---------------------------------------------------------------------------
# Pure split computations (unit-testable; no I/O).
# ---------------------------------------------------------------------------

def is_international(game):
    """Venue country present and not USA. Country is populated on past-season
    scoreboard events for domestic games too ('USA'), so None stays domestic."""
    return game.get("venue_country") not in (None, "USA")


def is_true_home(game):
    """The designated home team actually played at its own stadium: domestic AND the
    event's venue city equals the curated stadium city (catches relocations — e.g.
    BUF/CLE 2022 moved to Ford Field — and neutral sites; venue NAMES drift with
    naming rights, cities don't)."""
    if is_international(game):
        return False
    city = (game.get("venue_city") or "").strip().lower()
    return city == STADIUMS[game["home"]]["city"].strip().lower()


def team_records(finals):
    """Per-team overall and away-only 5-yr records (ties = 0.5) over ALL finals."""
    rec = {ab: {"n": 0, "w": 0.0, "away_n": 0, "away_w": 0.0} for ab in sorted(STADIUMS)}
    for g in finals:
        hw = _win_value(g["home_score"], g["away_score"])
        rec[g["home"]]["n"] += 1
        rec[g["home"]]["w"] += hw
        rec[g["away"]]["n"] += 1
        rec[g["away"]]["w"] += 1.0 - hw  # tie: both sides get 0.5
        rec[g["away"]]["away_n"] += 1
        rec[g["away"]]["away_w"] += 1.0 - hw
    return rec


def compute_venue_hfa(true_home_games):
    """Per-team 5-yr HFA at their OWN venue: home win% + avg home margin."""
    by_team = {}
    for g in true_home_games:
        by_team.setdefault(g["home"], []).append(g)
    out = {}
    for ab in sorted(STADIUMS):
        games = by_team.get(ab, [])
        n = len(games)
        wins = sum(_win_value(g["home_score"], g["away_score"]) for g in games)
        margins = [g["home_score"] - g["away_score"] for g in games]
        out[ab] = {
            "n": n, "games": n,
            "home_win_pct": _pct(wins, n),
            "avg_home_margin": _mean(margins),
            "low_n": n < LOW_N,
        }
    return out


def compute_surface_splits(true_home_games, venue_hfa):
    """Home splits by playing surface. Attribution is by the CURRENT curated surface
    (TEN switched grass->turf in 2023 mid-window — noted in the doc's notes)."""
    per_team = {}
    agg = {"grass": {"n": 0, "w": 0.0, "margins": []},
           "turf": {"n": 0, "w": 0.0, "margins": []}}
    by_team = {}
    for g in true_home_games:
        by_team.setdefault(g["home"], []).append(g)
    for ab in sorted(STADIUMS):
        surf = STADIUMS[ab]["surface"]
        v = venue_hfa[ab]
        per_team[ab] = {
            "surface": surf, "n": v["n"], "games": v["n"],
            "home_win_pct": v["home_win_pct"],
            "avg_home_margin": v["avg_home_margin"],
            "low_n": v["low_n"],
        }
        for g in by_team.get(ab, []):
            agg[surf]["n"] += 1
            agg[surf]["w"] += _win_value(g["home_score"], g["away_score"])
            agg[surf]["margins"].append(g["home_score"] - g["away_score"])
    by_surface = {
        surf: {
            "n": a["n"],
            "home_win_pct": _pct(a["w"], a["n"]),
            "avg_home_margin": _mean(a["margins"]),
            "low_n": a["n"] < LOW_N,
        }
        for surf, a in agg.items()
    }
    return {"per_team_home": per_team, "by_surface": by_surface}


def compute_cold_splits(cold_games, records):
    """Per-team cold delta + the dome-teams-outdoor-cold split.

    A cold game (kickoff temp < 32 F at an open venue) contributes ONE appearance per
    team. Per team: cold win% vs their overall 5-yr base win%. Dome teams (fixed-roof
    homes) appearing in cold games are necessarily on the road; their expectation
    baseline is each team's own 5-yr AWAY win% (cold appearances are away games —
    comparing to the overall base would smuggle in ordinary road disadvantage)."""
    per_team_raw = {}
    for g in cold_games:
        hw = _win_value(g["home_score"], g["away_score"])
        for ab, w in ((g["home"], hw), (g["away"], 1.0 - hw)):
            slot = per_team_raw.setdefault(ab, {"n": 0, "w": 0.0})
            slot["n"] += 1
            slot["w"] += w
    per_team = {}
    for ab in sorted(per_team_raw):
        slot = per_team_raw[ab]
        base = _pct(records[ab]["w"], records[ab]["n"])
        cold_pct = _pct(slot["w"], slot["n"])
        per_team[ab] = {
            "n": slot["n"], "cold_games": slot["n"],
            "cold_win_pct": cold_pct,
            "base_win_pct": base,
            "delta": round(cold_pct - base, 4),
            "low_n": slot["n"] < LOW_N,
        }

    domes = set(dome_teams())
    dn, dw, expected = 0, 0.0, []
    for g in cold_games:
        hw = _win_value(g["home_score"], g["away_score"])
        for ab, w in ((g["home"], hw), (g["away"], 1.0 - hw)):
            if ab not in domes:
                continue
            dn += 1
            dw += w
            expected.append(records[ab]["away_w"] / records[ab]["away_n"]
                            if records[ab]["away_n"] else 0.0)
    dome_split = {
        "n": dn, "games": dn,
        "win_pct": _pct(dw, dn),
        "expected_pct": round(sum(expected) / len(expected), 4) if expected else 0.0,
        "low_n": dn < LOW_N,
    }
    dome_split["delta"] = round(dome_split["win_pct"] - dome_split["expected_pct"], 4)
    return per_team, dome_split


def compute_international(finals):
    """Every international game listed, plus the designated-home bias headline."""
    games = []
    for g in sorted((g for g in finals if is_international(g)),
                    key=lambda g: (g["yr"], g["kickoff_utc"], g["game_id"])):
        games.append({
            "yr": g["yr"],
            "venue": g.get("venue"),
            "city": g.get("venue_city"),
            "country": g.get("venue_country"),
            "home": g["home"], "away": g["away"],
            "home_score": g["home_score"], "away_score": g["away_score"],
            "designated_home_won": g["home_score"] > g["away_score"],
        })
    n = len(games)
    wins = sum(_win_value(g["home_score"], g["away_score"]) for g in games)
    margins = [g["home_score"] - g["away_score"] for g in games]
    return {
        "games": games,
        "designated_home_win_pct": _pct(wins, n),
        "avg_margin": _mean(margins),
        "n": n,
        "low_n": n < LOW_N,
    }


def _elo_from_pct(p):
    """Win probability -> Elo rating difference (the standard logistic inversion)."""
    p = min(max(p, 0.01), 0.99)
    return -400.0 * math.log10(1.0 / p - 1.0)


# ---------------------------------------------------------------------------
# Assembly.
# ---------------------------------------------------------------------------

def build(refresh=True):
    """Build (or reuse) data/environment_model.json. Returns a feed summary dict:
    {rows, path, reused}.

    refresh=False (the build_predictions call path): the 2021-2025 window is CLOSED
    history — if the committed file already covers it, reuse it instead of re-running
    ~185 API calls on every pipeline run. A missing/invalid file forces a real build.
    refresh=True (__main__): always re-measure from the live feeds.
    """
    if not refresh:
        try:
            with open(OUT_PATH, encoding="utf-8") as fh:
                doc = json.load(fh)
            if doc.get("season_range") == SEASON_RANGE and len(doc.get("stadiums", {})) == 32:
                print(f"environment model reused (closed {SEASON_RANGE} window): {OUT_PATH}")
                return {"rows": doc.get("games_analyzed", 0), "path": OUT_PATH,
                        "reused": True, "updated_utc": doc.get("updated_utc")}
            print("[warn] environment_model.json present but stale/invalid — rebuilding.",
                  file=sys.stderr)
        except (OSError, ValueError):
            print("[warn] environment_model.json missing/unreadable — rebuilding.",
                  file=sys.stderr)

    now = _utc_now()
    print(f"environment model: fetching {SEASONS[0]}-{SEASONS[-1]} finals from ESPN...")
    finals = fetch_all_finals()

    true_home = [g for g in finals if is_true_home(g)]
    displaced = [g for g in finals if not is_international(g) and not is_true_home(g)]
    for g in displaced:
        print(f"  [note] {g['yr']} {g['away']}@{g['home']} played at "
              f"'{g.get('venue')}' ({g.get('venue_city')}) — not the home stadium; "
              f"excluded from venue HFA / weather joins.")

    # --- Weather backfill: ONE archive call per (open-air stadium, season). --------
    open_coords = sorted({(STADIUMS[ab]["lat"], STADIUMS[ab]["lon"])
                          for ab in STADIUMS if STADIUMS[ab]["roof"] == "open"})
    print(f"environment model: weather backfill — {len(open_coords)} open-air venues "
          f"x {len(SEASONS)} seasons ({len(open_coords) * len(SEASONS)} archive calls)...")
    wx = {}
    for lat, lon in open_coords:
        for yr in SEASONS:
            wx[(lat, lon, yr)] = _retry(
                f"Open-Meteo archive ({lat},{lon}) {yr}",
                lambda lat=lat, lon=lon, yr=yr: fetch_weather_archive(lat, lon, yr),
            )
            time.sleep(_SLEEP_S)
        print(f"  archive ok ({lat},{lon}) x {len(SEASONS)} seasons")

    joined, cold_games = 0, []
    for g in true_home:
        st = STADIUMS[g["home"]]
        if st["roof"] != "open":
            continue
        key = _kick_hour_key(g["kickoff_utc"])
        if key is None:
            print(f"  [warn] unparseable kickoff {g['kickoff_utc']} ({g['game_id']}) — skipped.",
                  file=sys.stderr)
            continue
        month = int(key[5:7])
        if month not in _WEATHER_MONTHS:
            continue  # weather joined for Oct-Jan kickoffs only (cold season)
        window = wx[(st["lat"], st["lon"], g["yr"])]
        if key not in window:
            print(f"  [warn] no archive hour {key} for {g['home']} — skipped.", file=sys.stderr)
            continue
        temp_f, wind_mph = window[key]
        g["wx_temp_f"], g["wx_wind_mph"] = temp_f, wind_mph
        joined += 1
        if temp_f is not None and temp_f < COLD_THRESHOLD_F:
            cold_games.append(g)
    print(f"environment model: weather joined {joined} Oct-Jan open-air games; "
          f"{len(cold_games)} cold (<{COLD_THRESHOLD_F}F) games.")

    # --- Splits (all measured; every split carries n + low_n). ---------------------
    records = team_records(finals)
    venue_hfa = compute_venue_hfa(true_home)
    surface = compute_surface_splits(true_home, venue_hfa)
    cold_per_team, dome_split = compute_cold_splits(cold_games, records)
    international = compute_international(finals)

    # Recorded (NOT applied) parameters. intl_hfa_elo_delta = how much weaker the
    # designated-home edge is at international venues than at true home venues, in
    # Elo points; negative means "worth less than a real home game".
    league_home_n = sum(v["n"] for v in venue_hfa.values())
    league_home_w = sum(v["home_win_pct"] * v["n"] for v in venue_hfa.values())
    base_home_pct = league_home_w / league_home_n if league_home_n else 0.5
    intl_delta = _elo_from_pct(international["designated_home_win_pct"]) - _elo_from_pct(base_home_pct)
    params = {
        "intl_hfa_elo_delta": round(intl_delta, 1),
        "base_home_win_pct": round(base_home_pct, 4),
        "cold_team_coefs_registered": True,
        "applied": False,  # record, don't silently apply — game probs unchanged
    }

    doc = {
        "updated_utc": now,
        "season_range": SEASON_RANGE,
        "games_analyzed": len(finals),
        "weather_joined_games": joined,
        "stadiums": {
            ab: {k: STADIUMS[ab][k] for k in
                 ("venue", "city", "surface", "roof", "lat", "lon", "cold_region")}
            | ({"altitude_ft": STADIUMS[ab]["altitude_ft"]} if "altitude_ft" in STADIUMS[ab] else {})
            for ab in sorted(STADIUMS)
        },
        "venue_hfa": venue_hfa,
        "cold": {
            "threshold_f": COLD_THRESHOLD_F,
            "per_team": cold_per_team,
            "dome_teams_outdoor_cold": dome_split,
        },
        "surface": surface,
        "international": international,
        "params": params,
        # estimate:true at the DOCUMENT level = "not yet a validated predictor";
        # the splits themselves are measured history (real finals, real reanalysis
        # weather), each carrying its own n + low_n honesty flags.
        "estimate": True,
        "notes": [
            f"Measured from {len(finals)} FINAL regular-season games {SEASONS[0]}-{SEASONS[-1]} "
            f"(ESPN scoreboard, STATUS-gated) + Open-Meteo ERA5 archive kickoff-hour weather.",
            "Ties count 0.5 in every win%.",
            "venue_hfa/surface use TRUE home games only: domestic AND venue city == curated "
            "stadium city (relocations and neutral-site games excluded).",
            "Weather joined only for open-roof venues, Oct-Jan kickoffs; retractable roofs "
            "skipped (per-game roof state unknowable from a static table).",
            "Surface attribution is by CURRENT surface; TEN switched grass->turf in 2023 "
            "mid-window (its 2021-22 home games are attributed to turf here).",
            "dome_teams_outdoor_cold expected_pct = each dome team's own 5-yr AWAY win% "
            "averaged over its cold appearances (cold games are road games for dome teams).",
            "cold.per_team lists only teams with >=1 cold appearance.",
            "params are RECORDED for the optimizer (weight-0 discipline), never applied here; "
            "game probabilities are unchanged by this file.",
        ],
    }
    _write(OUT_PATH, doc)
    print(f"wrote {OUT_PATH} ({len(finals)} games analyzed)")
    return {"rows": len(finals), "path": OUT_PATH, "reused": False, "updated_utc": now}


def _print_findings(path=OUT_PATH):
    """Human digest of the headline numbers — what the user asked 'is there anything
    there' about. Reads the file just written; pure formatting, no recomputation."""
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    intl = doc["international"]
    print("\nFINDINGS")
    print(f"  international: designated home won {intl['designated_home_win_pct']:.1%} "
          f"of n={intl['n']} games, avg margin {intl['avg_margin']:+.2f}")
    print(f"  intl_hfa_elo_delta (recorded, not applied): "
          f"{doc['params']['intl_hfa_elo_delta']:+.1f} Elo vs base home "
          f"{doc['params']['base_home_win_pct']:.1%}")
    per = doc["cold"]["per_team"]
    ranked = sorted(per.items(), key=lambda kv: kv[1]["delta"], reverse=True)
    print("  cold overperformers:  " + "; ".join(
        f"{ab} {v['delta']:+.3f} (cold {v['cold_win_pct']:.1%} vs base {v['base_win_pct']:.1%}, "
        f"n={v['n']}{', LOW N' if v['low_n'] else ''})" for ab, v in ranked[:3]))
    print("  cold underperformers: " + "; ".join(
        f"{ab} {v['delta']:+.3f} (cold {v['cold_win_pct']:.1%} vs base {v['base_win_pct']:.1%}, "
        f"n={v['n']}{', LOW N' if v['low_n'] else ''})" for ab, v in ranked[-3:]))
    d = doc["cold"]["dome_teams_outdoor_cold"]
    print(f"  dome teams in outdoor cold: {d['win_pct']:.1%} vs expected {d['expected_pct']:.1%} "
          f"(delta {d['delta']:+.3f}, n={d['n']}{', LOW N' if d['low_n'] else ''})")
    hfa = sorted(doc["venue_hfa"].items(), key=lambda kv: kv[1]["home_win_pct"], reverse=True)
    print("  venue HFA best:  " + "; ".join(
        f"{ab} {v['home_win_pct']:.1%} ({v['avg_home_margin']:+.1f}/gm, n={v['n']})"
        for ab, v in hfa[:3]))
    print("  venue HFA worst: " + "; ".join(
        f"{ab} {v['home_win_pct']:.1%} ({v['avg_home_margin']:+.1f}/gm, n={v['n']})"
        for ab, v in hfa[-3:]))
    bys = doc["surface"]["by_surface"]
    print("  home splits by surface: " + "; ".join(
        f"{s} {v['home_win_pct']:.1%} ({v['avg_home_margin']:+.2f}/gm, n={v['n']})"
        for s, v in sorted(bys.items())))


if __name__ == "__main__":
    build(refresh=True)
    _print_findings()
