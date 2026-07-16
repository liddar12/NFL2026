"""Generate REAL 2026 prediction data from ESPN + Elo priors.

Pipeline: ESPN 2025 FINAL results -> Elo priors (reverted to mean) -> attach ratings to
the real 2026 schedule -> game_model full-vector probabilities -> write the JSON
contracts the PWA reads. Market/composite sources join later (odds needs a key); until
then the game model is Elo-only and every row is honestly `estimate: true`.

Run in the pipeline runner (has network + `requests`): python -m scripts.build_predictions
The fast gate never runs this; it validates the committed output.
"""

import datetime as dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape import espn  # noqa: E402
from scripts.scrape import espn_players  # noqa: E402
from scripts import build_weekly  # noqa: E402
from scripts.models import elo as elo_mod  # noqa: E402
from scripts.models import game_model  # noqa: E402
from scripts.models import parlay_builder  # noqa: E402
from scripts.models.player_projection import project_players  # noqa: E402
from scripts.harness import snapshot as snap  # noqa: E402

SEASON = 2026
PRIOR_SEASON = 2025
DATA = os.path.join(_ROOT, "data")


def _utc_now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _hours_since(iso):
    if not iso:
        return None
    t = dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    return round((dt.datetime.now(dt.timezone.utc) - t).total_seconds() / 3600.0, 1)


def current_week(schedule):
    """The earliest week not entirely FINAL — the one to surface on the slate."""
    by_week = {}
    for g in schedule:
        by_week.setdefault(g["week"], []).append(g)
    for wk in sorted(by_week):
        if not all(g.get("status") in espn.FINAL_STATUSES for g in by_week[wk]):
            return wk
    return max(by_week)


def main():
    now = _utc_now()
    feeds = {}

    teams = espn.fetch_teams()
    feeds["espn_teams"] = {"rows": len(teams), "age_hours": 0.0, "last_success_utc": now, "status": "ok"}

    priors_src = espn.fetch_final_results(PRIOR_SEASON)
    ratings = elo_mod.preseason_priors(priors_src) if priors_src else {}
    feeds["espn_results_2025"] = {
        "rows": len(priors_src), "age_hours": 0.0, "last_success_utc": now,
        "status": "ok" if priors_src else "down",
    }

    schedule = espn.fetch_season_schedule(SEASON)
    feeds["espn_schedule"] = {"rows": len(schedule), "age_hours": 0.0, "last_success_utc": now, "status": "ok"}

    # Attach Elo priors and predict every game with the full-vector game model.
    predicted = []
    for g in schedule:
        row = dict(g)
        row["home_elo"] = ratings.get(g["home"], elo_mod.INIT)
        row["away_elo"] = ratings.get(g["away"], elo_mod.INIT)
        pred = game_model.predict_game(row, teams=None, model="elo_prior")
        pred["week"] = g["week"]
        pred["venue"] = g.get("venue")
        pred["status"] = g.get("status")
        predicted.append(pred)

    # Full season (all weeks) for later use.
    _write(os.path.join(DATA, "schedule_full.json"), {
        "season": SEASON, "updated_utc": now, "source": "espn", "model": "elo_prior",
        "games": predicted,
    })

    # The single-week contract the slate reads = the current (upcoming) week.
    wk = current_week(schedule)
    week_games = [
        {
            "game_id": p["game_id"], "home": p["home"], "away": p["away"],
            "kickoff_utc": p["kickoff_utc"], "roof": p["roof"],
            "probs": p["probs"], "model": p["model"], "estimate": p["estimate"],
        }
        for p in predicted if p["week"] == wk
    ]
    _write(os.path.join(DATA, "game_predictions.json"), {
        "season": SEASON, "week": wk, "updated_utc": now, "games": week_games,
    })

    # P1 — POINT-IN-TIME SNAPSHOT LOCK. The week's predictions are archived as
    # measurable (estimate=False) snapshot rows the harness later resolves against
    # FINAL scores. A lock is immutable: if this week's opening lock already exists
    # we do NOT rewrite it — re-running the pipeline must never launder a newer
    # prediction into an older lock (the whole point of point-in-time archiving).
    lock_name = f"{SEASON}_wk{wk:02d}_games_open"
    lock_path = os.path.join(DATA, "snapshots", lock_name + ".json")
    if os.path.exists(lock_path):
        print(f"lock exists, untouched: {lock_path}")
    else:
        rows = [
            snap.make_row(
                event_id=g["game_id"], event_type="game", model=g["model"],
                locked_utc=now, as_of_utc=now,
                probs=[g["probs"]["home"], g["probs"]["away"]],
                estimate=False,  # a lock is a measurable prediction we stand behind
            )
            for g in week_games
        ]
        snap.write_snapshot(lock_name, rows)
        print(f"locked {len(rows)} game rows -> {lock_path}")

    # N4 (real-slate wiring) — rebuild parlays from the REAL week's games via the
    # correlation-aware builder, so parlay game_ids always reference games that
    # exist in game_predictions.json. Edges remain model-vs-hold placeholders until
    # the odds feed carries real lines (ODDS_API_KEY).
    _write(os.path.join(DATA, "parlays.json"),
           parlay_builder.build_parlays_document(week_games, SEASON, wk, now))

    # N2 — REAL player projections. ESPN fantasy pool (real prior-season PPR totals)
    # + roster ages -> the projection engine. At day-zero weights every signal is
    # neutral, so proj == prior-season production: the honest baseline every future
    # signal must beat through the optimizer.
    players_in = espn_players.build_player_records(PRIOR_SEASON, teams)
    feeds["espn_fantasy"] = {"rows": len(players_in), "age_hours": 0.0,
                             "last_success_utc": now, "status": "ok"}
    try:
        with open(os.path.join(DATA, "fixtures", "teams.json"), encoding="utf-8") as fh:
            teams_fixture = json.load(fh)
    except (OSError, ValueError):
        teams_fixture = None
    projected = project_players(players_in, ctx={"teams": teams_fixture})
    projected = [p for p in projected if p["proj_points"] > 0]
    projected.sort(key=lambda p: (-p["proj_points"], p["gsis_id"]))
    _write(os.path.join(DATA, "player_projections.json"), {
        "season": SEASON, "updated_utc": now, "players": projected[:300],
    })

    # Refresh the teams fixture with real ESPN identity (name/location/colors).
    teams_fixture = {
        ab: {
            "abbrev": ab, "name": t["name"], "location": t["location"],
            "display": t["display"], "color": t["color"], "alt_color": t["alt_color"],
        }
        for ab, t in sorted(teams.items())
    }
    _write(os.path.join(DATA, "fixtures", "teams_espn.json"), {
        "season": SEASON, "updated_utc": now, "source": "espn", "teams": teams_fixture,
    })

    # Injuries (display + future signal). Best-effort — don't fail the whole run.
    try:
        inj = espn.fetch_injuries()
        feeds["injuries"] = {"rows": len(inj), "age_hours": 0.0, "last_success_utc": now, "status": "ok"}
        _write(os.path.join(DATA, "injuries.json"), {"updated_utc": now, "source": "espn", "injuries": inj})
    except Exception as exc:  # noqa: BLE001
        feeds["injuries"] = {"rows": 0, "age_hours": None, "last_success_utc": None, "status": "down"}
        print(f"[warn] injuries feed failed: {exc}", file=sys.stderr)

    # Feeds that need a key (odds/kalshi) or are proxy-blocked in this sandbox
    # (nflverse) are DEGRADED, not down — unconfigured/unavailable, not broken. The
    # cron runner with keys + open network populates them. age_hours is a large
    # sentinel (never succeeded here) so the schema's numeric contract holds.
    for name in ("odds_api", "kalshi", "polymarket", "nflverse"):
        feeds[name] = {"rows": 0, "age_hours": 999.0, "last_success_utc": None, "status": "degraded"}

    # Overall health mirrors the WORST feed exactly — never rosier than reality.
    order = {"ok": 0, "stale": 1, "degraded": 2, "down": 3}
    health = max((f["status"] for f in feeds.values()), key=lambda s: order[s])
    _write(os.path.join(DATA, "pipeline_status.json"), {
        "generated_utc": now, "health": health, "feeds": feeds,
    })

    # Weekly split (weekly_split_v1) — pure math lives in scripts.build_weekly;
    # this call just feeds it the artifacts already in hand. Player order mirrors
    # player_projections.json (same projected[:300] slice), elos are the SAME
    # priors the game model used, receptions ride the N2 feed (kona statId 53).
    receptions_by_id = {r["gsis_id"]: r.get("receptions", 0.0) for r in players_in}
    weekly_doc = build_weekly.build_weekly_document(
        projected[:300], predicted, ratings, receptions_by_id, SEASON, now)
    _write(os.path.join(DATA, "player_weekly.json"), weekly_doc)

    print(f"OK  teams={len(teams)} elo_teams={len(ratings)} schedule={len(schedule)} "
          f"week={wk} week_games={len(week_games)} "
          f"weekly_players={len(weekly_doc['players'])} health={health}")


if __name__ == "__main__":
    main()
