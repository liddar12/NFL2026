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

    # === LEARNING LOOP (scripts/resolve_locks.py + scripts/refit.py) — two hooks ==
    # 1) ADOPTED GAME PARAMS. refit.py writes model_tuning.json:"game_params" ONLY
    #    when a candidate clears the NEVER-REGRESS margin on resolved locks. Absent
    #    (day zero, today) => the incumbent elo.py defaults and every prob below is
    #    byte-identical. This is the single read-point of the live game params.
    try:
        with open(os.path.join(DATA, "model_tuning.json"), encoding="utf-8") as fh:
            _adopted = json.load(fh).get("game_params") or {}
    except (OSError, ValueError):
        _adopted = {}
    hfa_live = float(_adopted.get("hfa_elo", elo_mod.HFA_ELO))
    revert_live = float(_adopted.get("revert", elo_mod.REVERT))
    if _adopted and priors_src:
        # Re-derive the priors under the adopted params (rate at the adopted hfa,
        # revert by the adopted fraction) — the only path that moves game probs,
        # and it is NEVER-REGRESS gated upstream in refit.py.
        ratings = elo_mod.revert_to_mean(
            elo_mod.rate_season(priors_src, hfa=hfa_live), revert=revert_live)
        print(f"adopted game params in effect: hfa_elo={hfa_live} revert={revert_live}")

    # 2) IN-SEASON ELO CHAINING. FINAL 2026 games to date move the ratings
    #    game-by-game, STARTING FROM the 2025 priors (rate_season's initial_ratings).
    #    STATUS-gated by the scraper, so a live/0-0 stub can never move a rating.
    #    Zero finals (preseason, today) => ratings unchanged, output identical.
    finals_cur = espn.fetch_final_results(SEASON)
    if finals_cur:
        ratings = elo_mod.rate_season(finals_cur, hfa=hfa_live, initial_ratings=ratings)
        print(f"in-season Elo chain: {len(finals_cur)} FINAL {SEASON} games applied "
              f"on top of the {PRIOR_SEASON} priors")
    else:
        print(f"in-season Elo chain: no FINAL {SEASON} games yet -> "
              f"ratings = {PRIOR_SEASON} priors (no-op)")
    feeds[f"espn_results_{SEASON}"] = {
        # rows=0 before kickoff is reality, not an outage (outages raise upstream).
        "rows": len(finals_cur), "age_hours": 0.0, "last_success_utc": now,
        "status": "ok",
    }
    # === end LEARNING LOOP hooks ==================================================

    schedule = espn.fetch_season_schedule(SEASON)
    feeds["espn_schedule"] = {"rows": len(schedule), "age_hours": 0.0, "last_success_utc": now, "status": "ok"}

    # PROMOTED SIGNAL APPLICATION (scripts/promote_signals.py). A venue/cold
    # signal that cleared the NEVER-REGRESS promotion backtest lands in
    # game_params.venue_hfa / cold_hfa with applied=true and per-team Elo
    # deltas; unadopted (today: the 2025 promotion run RETAINED the incumbent —
    # every candidate scale was worse out-of-sample) means both blocks are
    # absent and hfa_eff == hfa_live for every game, byte-identical output.
    _venue_hfa = _adopted.get("venue_hfa") or {}
    _venue_deltas = _venue_hfa.get("deltas") or {} if _venue_hfa.get("applied") else {}
    _cold_hfa = _adopted.get("cold_hfa") or {}
    _cold_delta = float(_cold_hfa.get("delta_elo", 0.0)) if _cold_hfa.get("applied") else 0.0
    if _venue_deltas or _cold_delta:
        from scripts.promote_signals import is_cold_game  # noqa: PLC0415 (guarded)
        print(f"promoted signals in effect: venue deltas for {len(_venue_deltas)} teams, "
              f"cold delta {_cold_delta:+.1f}")
    # rest_hfa (Elo per day of clamped rest advantage) — schedule order gives
    # each team's previous kickoff, exactly like the promotion walk.
    _rest_hfa = _adopted.get("rest_hfa") or {}
    _rest_scale = float(_rest_hfa.get("scale_per_day", 0.0)) if _rest_hfa.get("applied") else 0.0
    _rest_diff_by_gid = {}
    if _rest_scale:
        from scripts.promote_signals import rest_diffs  # noqa: PLC0415 (guarded)
        _sched_sorted = sorted(schedule, key=lambda g: g.get("kickoff_utc") or "")
        for _g, _d in zip(_sched_sorted, rest_diffs(_sched_sorted)):
            _rest_diff_by_gid[_g["game_id"]] = _d
        print(f"promoted rest signal in effect: {_rest_scale} Elo/day")
    # epa_hfa (Elo per unit rolling EPA-margin differential) — needs the
    # runner-built epa_history.json; absent data means no delta, loudly.
    _epa_hfa = _adopted.get("epa_hfa") or {}
    _epa_feats = None
    if _epa_hfa.get("applied"):
        from scripts.promote_signals import load_epa_features  # noqa: PLC0415 (guarded)
        _epa_feats = load_epa_features(_epa_hfa.get("kind") or "total")
        if _epa_feats is None:
            print("WARNING: epa_hfa adopted but epa_history.json absent/incomplete — "
                  "EPA delta not applied this run")
        else:
            print(f"promoted EPA signal in effect: kind={_epa_hfa.get('kind')} "
                  f"scale={_epa_hfa.get('scale')}")

    # Attach Elo priors and predict every game with the full-vector game model.
    predicted = []
    for g in schedule:
        row = dict(g)
        row["home_elo"] = ratings.get(g["home"], elo_mod.INIT)
        row["away_elo"] = ratings.get(g["away"], elo_mod.INIT)
        # Learning-loop hook: prediction-time HFA = adopted flat params plus any
        # PROMOTED family deltas (all no-ops until the gate adopts them).
        hfa_eff = hfa_live + float(_venue_deltas.get(g["home"], 0.0))
        if _cold_delta and is_cold_game(g):
            hfa_eff += _cold_delta
        if _rest_scale:
            hfa_eff += _rest_scale * _rest_diff_by_gid.get(g["game_id"], 0.0)
        if _epa_feats is not None:
            hfa_eff += float(_epa_hfa["scale"]) * _epa_feats.diff(g, SEASON)
        row["hfa_elo"] = hfa_eff
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

    # TEAM STRENGTH — per-team Elo (the SAME ratings that drove every game prob
    # above), published so the client can compute a per-player strength-of-
    # schedule (mean opponent Elo -> a 1.0=easiest .. 5.0=hardest scale). This is
    # the measured 2025-reverted prior (plus any in-season chaining), NOT a new
    # model: it is exactly `ratings`, so SoS can never disagree with the game
    # predictions. min/max are emitted so the client's 1-5 normalization is stable
    # across deploys (it maps the observed rating span, not a hard-coded range).
    rating_vals = sorted(ratings.values())
    _write(os.path.join(DATA, "team_strength.json"), {
        "season": SEASON, "updated_utc": now,
        "source": "elo_prior_2025_reverted", "estimate": True,
        "elo_min": round(rating_vals[0], 2) if rating_vals else elo_mod.INIT,
        "elo_max": round(rating_vals[-1], 2) if rating_vals else elo_mod.INIT,
        "ratings": {t: round(r, 2) for t, r in sorted(ratings.items())},
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

    # N4 (real-slate wiring) — parlays are built at the END of this run (see the
    # PARLAYS block below): the prop legs need player_weekly + player_projections
    # in hand, and real odds (when ODDS_API_KEY is set) need the slate. Moving the
    # write does not change the contract — every run still writes parlays.json.

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

    # 5-year history (2021-2025) -> player_history.json (trajectory / regression
    # detection for the Fit Engine and future signals). GUARDED: a history failure
    # degrades loudly — stderr + a degraded feed row — but must never kill the core
    # pipeline; games/players/parlays above are already written by this point.
    try:
        from scripts import build_history  # noqa: PLC0415 (guarded feature import)
        hist_summary = build_history.run(projected[:300], players_in, now)
        feeds["espn_history"] = {"rows": hist_summary["players"], "age_hours": 0.0,
                                 "last_success_utc": now, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["espn_history"] = {"rows": 0, "age_hours": 999.0,
                                 "last_success_utc": None, "status": "degraded"}
        print(f"[warn] player history build failed (core pipeline continues): {exc}",
              file=sys.stderr)

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

    # === ENVIRONMENT MODEL (separate block from the history one above) ===========
    # Measured 2021-2025 venue/cold/international splits -> environment_model.json.
    # GUARDED: an environment build failure must never kill the core pipeline — loud
    # stderr, feed marked degraded, core contracts already written by this point.
    # refresh=False reuses the committed file when it already covers the CLOSED
    # 2021-2025 window (a rebuild is ~190 identical API calls for identical history);
    # a missing/invalid file triggers a real build.
    try:
        from scripts import build_environment  # noqa: PLC0415 (guarded feature import)
        env = build_environment.build(refresh=False)
        env_age = _hours_since(env.get("updated_utc")) if env.get("reused") else 0.0
        feeds["environment"] = {
            "rows": env["rows"],
            "age_hours": env_age if env_age is not None else 0.0,
            "last_success_utc": env.get("updated_utc") or now,
            "status": "ok",
        }
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["environment"] = {"rows": 0, "age_hours": 999.0,
                                "last_success_utc": None, "status": "degraded"}
        print(f"[warn] environment model build failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end ENVIRONMENT MODEL block ==============================================

    # === AI INSIGHTS (Fit Engine v2 estimation layer — scripts/ai_estimates.py) ==
    # Deterministic, DOCUMENTED estimation rules (authored by generative AI this
    # build; regenerable via the quarantined P10 workflow — see the module
    # docstring) join the fresh history + environment outputs above into
    # data/ai_insights.json for the TEAM tab's opt-in AI+ toggle (default off;
    # game probabilities and meta.json weights untouched). Runs AFTER both blocks
    # on purpose: it reads player_history.json and environment_model.json from
    # disk. GUARDED like them: a failure degrades loudly, never kills the core.
    try:
        from scripts import ai_estimates  # noqa: PLC0415 (guarded feature import)
        ai_summary = ai_estimates.run(now)
        feeds["ai_insights"] = {"rows": ai_summary["players"], "age_hours": 0.0,
                                "last_success_utc": now, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["ai_insights"] = {"rows": 0, "age_hours": 999.0,
                                "last_success_utc": None, "status": "degraded"}
        print(f"[warn] ai insights build failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end AI INSIGHTS block ====================================================

    # === GAME SCRIPT (measured run/pass splits — scripts/build_gamescript.py) ====
    # Winner/loser rush-pass volume, blowout vs one-score rush share, and the
    # trailing-team Q4 (garbage-time) uplift, measured from FINAL 2025 boxscores.
    # DESCRIPTIVE, weight-0 / applied=false — game probabilities untouched. The
    # raw rows are cached (data/fixtures/gamestats_2025.json), so this is a cheap
    # re-analysis per run, not a 272-call refetch. GUARDED like the blocks above.
    try:
        from scripts import build_gamescript  # noqa: PLC0415 (guarded feature import)
        build_gamescript.main()
        with open(os.path.join(DATA, "game_script.json"), encoding="utf-8") as fh:
            gs_rows = json.load(fh)["games_analyzed"]
        feeds["game_script"] = {"rows": gs_rows, "age_hours": 0.0,
                                "last_success_utc": now, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["game_script"] = {"rows": 0, "age_hours": 999.0,
                                "last_success_utc": None, "status": "degraded"}
        print(f"[warn] game-script build failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end GAME SCRIPT block ====================================================

    # === NFLVERSE AGGREGATES (combine bench, pbp score-state) =====================
    # Release CSVs 403 through some sandbox proxies but fetch fine on the GH
    # runner; the builder leaves any existing file untouched on failure and the
    # o-line composite below consumes the combine bench when the file exists.
    try:
        from scripts import build_nflverse_aggregates  # noqa: PLC0415 (guarded)
        build_nflverse_aggregates.main()
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        print(f"[warn] nflverse aggregates failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end NFLVERSE AGGREGATES block ============================================

    # === O-LINE COMPOSITE (scripts/build_oline.py) ================================
    # Per-team OL weight/age/experience/continuity from live ESPN rosters (32
    # calls), refined with nflverse snap counts when that host is reachable.
    # Context for the registered weight-0 ol_composite_vs_dl signal — weekly
    # refresh matters here (personnel churn), so it runs every pipeline pass.
    try:
        from scripts import build_oline  # noqa: PLC0415 (guarded feature import)
        build_oline.main()
        with open(os.path.join(DATA, "oline_composite.json"), encoding="utf-8") as fh:
            ol_rows = len(json.load(fh)["teams"])
        feeds["oline"] = {"rows": ol_rows, "age_hours": 0.0,
                          "last_success_utc": now, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["oline"] = {"rows": 0, "age_hours": 999.0,
                          "last_success_utc": None, "status": "degraded"}
        print(f"[warn] o-line composite build failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # nflverse feed row mirrors what the o-line build ACTUALLY reached: its
    # `source` field says whether snap counts refined continuity or the build
    # fell back to ESPN-only (proxy-blocked here; reachable on the GH runner).
    try:
        with open(os.path.join(DATA, "oline_composite.json"), encoding="utf-8") as fh:
            ol_src = json.load(fh).get("source", "")
        nv_ok = "nflverse" in ol_src and "unreachable" not in ol_src
        feeds["nflverse"] = (
            {"rows": 32, "age_hours": 0.0, "last_success_utc": now, "status": "ok"}
            if nv_ok else
            {"rows": 0, "age_hours": 999.0, "last_success_utc": None, "status": "degraded"})
    except (OSError, ValueError):
        feeds["nflverse"] = {"rows": 0, "age_hours": 999.0,
                             "last_success_utc": None, "status": "degraded"}
    # === end O-LINE COMPOSITE block ===============================================

    # === ADP (drafter consensus — draft-simulator opponent model ONLY) ===========
    # POLICY: models the simulated draft room + value flags; never blended into
    # projections or probabilities. Keyless FantasyFootballCalculator API.
    try:
        from scripts.scrape import adp as adp_mod  # noqa: PLC0415 (guarded)
        adp_rows, adp_join = adp_mod.join_to_pool(
            adp_mod.fetch_adp(SEASON), projected[:300])
        _write(os.path.join(DATA, "adp.json"), {
            "updated_utc": now,
            "source": "fantasyfootballcalculator ppr 12-team",
            "format": "ppr", "league_size": 12, "join_rate": adp_join,
            "players": adp_rows,
        })
        feeds["adp"] = {"rows": len(adp_rows), "age_hours": 0.0,
                        "last_success_utc": now, "status": "ok"}
        print(f"adp: {len(adp_rows)} players, join rate {adp_join}")
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["adp"] = {"rows": 0, "age_hours": 999.0,
                        "last_success_utc": None, "status": "degraded"}
        print(f"[warn] adp feed failed (core pipeline continues): {exc}", file=sys.stderr)
    # === end ADP block ============================================================

    # === DEFENSIVE COMPOSITE (scripts/build_defense.py) ===========================
    # The OL-vs-DL signal's defensive half — weight-0 context, weekly refresh
    # (roster churn matters). GUARDED like the o-line block above.
    try:
        from scripts import build_defense  # noqa: PLC0415 (guarded feature import)
        build_defense.main()
        with open(os.path.join(DATA, "defense_composite.json"), encoding="utf-8") as fh:
            def_rows = len(json.load(fh)["teams"])
        feeds["defense"] = {"rows": def_rows, "age_hours": 0.0,
                            "last_success_utc": now, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["defense"] = {"rows": 0, "age_hours": 999.0,
                            "last_success_utc": None, "status": "degraded"}
        print(f"[warn] defense composite failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end DEFENSIVE COMPOSITE block ============================================

    # === MARKET PRICES (Kalshi + Polymarket — DISPLAY ONLY) =======================
    # The scoreboard we measure ourselves against: keyless public prices joined
    # to OUR schedule. USER POLICY: never an input — no model, optimizer, or
    # parlay probability reads this file (validate_data MARKET_DISPLAY_ONLY).
    try:
        from scripts import build_markets  # noqa: PLC0415 (guarded feature import)
        mdoc = build_markets.main()
        for src_name in ("kalshi", "polymarket"):
            src = mdoc["sources"].get(src_name, {})
            ok = src.get("status") == "ok"
            feeds[src_name] = (
                {"rows": src.get("rows", 0), "age_hours": 0.0,
                 "last_success_utc": now, "status": "ok"}
                if ok else
                {"rows": 0, "age_hours": 999.0, "last_success_utc": None,
                 "status": "degraded"})
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        for src_name in ("kalshi", "polymarket"):
            feeds[src_name] = {"rows": 0, "age_hours": 999.0,
                               "last_success_utc": None, "status": "degraded"}
        print(f"[warn] market prices build failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end MARKET PRICES block ==================================================

    # === PLAYOFF ODDS (season simulator — OUR MODEL ONLY) =========================
    # Deterministic Monte Carlo from the schedule probs + Elo written above.
    # No market input anywhere; the MODEL tab shows markets NEXT TO these odds.
    try:
        from scripts import simulate_season  # noqa: PLC0415 (guarded feature import)
        podds = simulate_season.main()
        feeds["playoff_sim"] = {"rows": len(podds["teams"]), "age_hours": 0.0,
                                "last_success_utc": now, "status": "ok"}
    except Exception as exc:  # noqa: BLE001 — degrade, never mask (stderr is loud)
        feeds["playoff_sim"] = {"rows": 0, "age_hours": 999.0,
                                "last_success_utc": None, "status": "degraded"}
        print(f"[warn] playoff simulation failed (core pipeline continues): {exc}",
              file=sys.stderr)
    # === end PLAYOFF ODDS block ===================================================

    # Weekly split (weekly_split_v1) — pure math lives in scripts.build_weekly;
    # this call just feeds it the artifacts already in hand. Player order mirrors
    # player_projections.json (same projected[:300] slice), elos are the SAME
    # priors the game model used, receptions ride the N2 feed (kona statId 53).
    # Injury-aware since Rel4: build_weekly reads data/injuries.json (written
    # fresh above) and shapes the first weeks of injured players' splits.
    receptions_by_id = {r["gsis_id"]: r.get("receptions", 0.0) for r in players_in}
    weekly_doc = build_weekly.build_weekly_document(
        projected[:300], predicted, ratings, receptions_by_id, SEASON, now)
    _write(os.path.join(DATA, "player_weekly.json"), weekly_doc)

    # === PARLAYS (moved from the early slot — needs weekly + projections) ========
    # Real odds when ODDS_API_KEY is set; graceful model-seeded fallback when not.
    markets_by_game = None
    try:
        from scripts.scrape import odds_api  # noqa: PLC0415 (guarded feature import)
        try:
            markets_by_game = odds_api.fetch_markets(week_games)
            feeds["odds_api"] = {"rows": len(markets_by_game), "age_hours": 0.0,
                                 "last_success_utc": now, "status": "ok"}
            print(f"odds: real lines for {len(markets_by_game)} slate games")
        except odds_api.OddsKeyMissing as exc:
            # No key = the owner hasn't turned this feed on. A fact, not a
            # failure: 'unconfigured' is excluded from the health roll-up and
            # surfaced as "awaiting config" instead of dragging DEGRADED.
            feeds["odds_api"] = {"rows": 0, "age_hours": 999.0,
                                 "last_success_utc": None, "status": "unconfigured"}
            print(f"[info] odds feed unconfigured: {exc}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001 — a real failure degrades, loudly
        feeds["odds_api"] = {"rows": 0, "age_hours": 999.0,
                             "last_success_utc": None, "status": "degraded"}
        print(f"[warn] odds feed unavailable (model-seeded lines in use): {exc}",
              file=sys.stderr)

    # Player-prop legs (top QB/RB/WR per game, seeded lines, labeled estimates)
    # diversify the same-game parlay candidate pool. Pure function, no network.
    props_by_game = parlay_builder.build_props_by_game(
        week_games,
        weekly_doc,
        {"season": SEASON, "updated_utc": now, "players": projected[:300]},
    )
    _write(os.path.join(DATA, "parlays.json"),
           parlay_builder.build_parlays_document(
               week_games, SEASON, wk, now,
               markets_by_game=markets_by_game,
               props_by_game=props_by_game))

    # Overall health mirrors the WORST CONFIGURED feed — never rosier than
    # reality; 'unconfigured' feeds are excluded (not turned on ≠ broken) and
    # surfaced separately by the UI as "awaiting config". Written LAST so every
    # feed above (odds, markets, game-script, o-line, sim) is in.
    order = {"ok": 0, "stale": 1, "degraded": 2, "down": 3}
    configured = [f["status"] for f in feeds.values() if f["status"] != "unconfigured"]
    health = max(configured, key=lambda s: order[s]) if configured else "degraded"
    _write(os.path.join(DATA, "pipeline_status.json"), {
        "generated_utc": now, "health": health, "feeds": feeds,
    })

    print(f"OK  teams={len(teams)} elo_teams={len(ratings)} schedule={len(schedule)} "
          f"week={wk} week_games={len(week_games)} "
          f"weekly_players={len(weekly_doc['players'])} health={health}")


if __name__ == "__main__":
    main()
