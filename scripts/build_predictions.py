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
from scripts import availability  # noqa: E402
from scripts import build_weekly  # noqa: E402
from scripts.models import elo as elo_mod  # noqa: E402
from scripts.models import game_model  # noqa: E402
from scripts.models import parlay_builder  # noqa: E402
from scripts.models.player_projection import project_players  # noqa: E402
from scripts.harness import snapshot as snap  # noqa: E402
from scripts.pipeline_status import read_schedules  # noqa: E402

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


def market_feed_record(src, now):
    """pipeline_status feed record for one market source (kalshi / polymarket),
    from the source block build_markets stamps into market_prices.json.

    R30: the old inline mapping collapsed the source's own three-state status to
    a binary and HARDCODED "ok" without ever reading the row count, so kalshi
    shipped {rows: 0, status: "ok"} and the MODEL tab's freshness card counted
    an empty feed among "feeds ok". House rule: a 0-row write is never silently
    ok. Now the builder's status is carried through verbatim, with a belt-and-
    braces guard for older market_prices documents that predate the builder fix:

      * "ok" with rows == 0  -> degraded (a configured feed delivered nothing);
      * "degraded"           -> degraded, keeping the real row count (a partial
                                 pull is still a pull — rows 15 is a fact);
      * "down" / absent      -> down, rows 0, no fabricated success timestamp.

    Kalshi and Polymarket are keyless, so "unconfigured" (odds_api's awaiting-
    config idiom for a missing API key) is deliberately NOT a state this
    function can produce: these feeds are always configured.
    """
    status = src.get("status") or "down"
    rows = int(src.get("rows") or 0)
    note = src.get("note")
    if status == "ok" and rows == 0:
        status = "degraded"
        # Belt-and-braces path (older market_prices doc, no builder note): the
        # downgrade must SAY WHY, or the MODEL tab shows a wordless red.
        note = note or ("0 rows from a configured feed downgraded to degraded — "
                        "a 0-row write is never ok (R30)")
    if status == "down":
        rec = {"rows": 0, "age_hours": 999.0,
               "last_success_utc": None, "status": "down"}
    else:
        rec = {"rows": rows, "age_hours": 0.0,
               "last_success_utc": now, "status": status}
    # The builder's own explanation (e.g. kalshi's "listed events matched none of
    # our markets") rides through to pipeline_status so the health card can show
    # the reason, not just the color. Optional in the contract; omitted when empty.
    if note:
        rec["note"] = str(note)
    return rec


def current_week(schedule):
    """The earliest week not entirely FINAL — the one to surface on the slate."""
    by_week = {}
    for g in schedule:
        by_week.setdefault(g["week"], []).append(g)
    for wk in sorted(by_week):
        if not all(g.get("status") in espn.FINAL_STATUSES for g in by_week[wk]):
            return wk
    return max(by_week)


def _stamp_rookies(projected, fetch=None):
    """Stamp `rookie` (nflverse roster years_exp == 0) onto projection records
    IN PLACE, joined by canonical name. R41 (owner ask): the PLAYERS/TEAM
    rookies-only filter needs an authoritative flag, and the pool's
    prior-production sort cannot supply one honestly.

    Honesty rules: an AMBIGUOUS name (two roster rows, different experience)
    is left unstamped — unknown, never guessed; on ANY feed failure every
    record stays unstamped (absent means "rookie status unknown", never
    false), and the UI hides the filter when no record carries the field.
    Returns (stamped, rookies) for the log line."""
    from scripts.scrape import nflverse  # noqa: PLC0415 (guarded feature import)
    from scripts.scrape.renames import canonical_player_name  # noqa: PLC0415
    fetch = fetch or (lambda: nflverse.fetch_roster_release(SEASON))
    try:
        rows = fetch()
    except Exception as exc:  # noqa: BLE001 — degrade to unstamped, loudly
        print(f"[warn] rookie stamp skipped — nflverse rosters unreachable: {exc}",
              file=sys.stderr)
        return 0, 0
    exp = {}
    ambiguous = set()
    for r in rows:
        n = canonical_player_name(r.get("full_name") or r.get("player_name") or "")
        if not n:
            continue
        try:
            ye = int(float(r.get("years_exp")))
        except (TypeError, ValueError):
            continue
        if n in exp and exp[n] != ye:
            ambiguous.add(n)
        exp[n] = ye
    stamped = rookies = 0
    for p in projected:
        n = canonical_player_name(p.get("name") or "")
        if n in exp and n not in ambiguous:
            p["rookie"] = exp[n] == 0
            stamped += 1
            rookies += int(p["rookie"])
    return stamped, rookies


_BONUS_THRESHOLDS = (
    # (weekly stat field, threshold, Sleeper bonus key). Thresholds are
    # CUMULATIVE, matching Sleeper's semantics: a 425-yard passing game counts
    # for both the 300 and the 400 bonus.
    ("passing_yards", 300.0, "bonus_pass_yd_300"),
    ("passing_yards", 400.0, "bonus_pass_yd_400"),
    ("rushing_yards", 100.0, "bonus_rush_yd_100"),
    ("rushing_yards", 200.0, "bonus_rush_yd_200"),
    ("receiving_yards", 100.0, "bonus_rec_yd_100"),
    ("receiving_yards", 200.0, "bonus_rec_yd_200"),
)


def _bonus_games_by_name(fetch=None):
    """{canonical player name: {sleeper bonus key: game count}} measured from
    PRIOR_SEASON regular-season weekly stat lines (nflverse). R44: a per-game
    yardage bonus cannot be priced from a season total — only from the games.

    Honesty rules match _stamp_rookies: an AMBIGUOUS name (two players) is
    dropped — never guessed; ANY feed failure returns {} so every player ships
    without bonus counts (absent = unmeasured, never zero games)."""
    from scripts.scrape import nflverse  # noqa: PLC0415 (guarded feature import)
    from scripts.scrape.renames import canonical_player_name  # noqa: PLC0415
    # R44b — the RELEASE CSV, not nfl_data_py: the daily runner installs only
    # requests, and run 81 proved the heavy path degrades every single run
    # ("nfl_data_py is not installed"), which made this counter dead code.
    fetch = fetch or (lambda: nflverse.fetch_player_stats_week_release(PRIOR_SEASON))
    try:
        rows = fetch()
    except Exception as exc:  # noqa: BLE001 — degrade to unmeasured, loudly
        print(f"[warn] bonus-game counts skipped — nflverse weekly stats "
              f"unreachable: {exc}", file=sys.stderr)
        return {}
    by_name = {}
    ids_by_name = {}
    ambiguous = set()
    for r in rows:
        if str(r.get("season_type") or "REG") != "REG":
            continue
        n = canonical_player_name(r.get("player_display_name")
                                  or r.get("player_name") or "")
        if not n:
            continue
        pid = str(r.get("player_id") or "")
        if n in ids_by_name and ids_by_name[n] != pid:
            ambiguous.add(n)
        ids_by_name[n] = pid
        counts = by_name.setdefault(n, {})
        for field, threshold, key in _BONUS_THRESHOLDS:
            try:
                v = float(r.get(field) or 0.0)
            except (TypeError, ValueError):
                continue
            if v >= threshold:
                counts[key] = counts.get(key, 0) + 1
    for n in ambiguous:
        by_name.pop(n, None)
    return {n: c for n, c in by_name.items() if c}


def _components_by_id(players_in, bonus_by_name=None):
    """{gsis_id: {components, base_applied_pts[, bonus_games]}} for the weekly
    feed. Only records whose kona entry passed extract_components() appear —
    a player without a verified component line ships NOTHING (the client falls
    back to the R29 pass_cmp path, which is honest but narrower)."""
    from scripts.scrape.renames import canonical_player_name  # noqa: PLC0415
    out = {}
    for r in players_in:
        comp = r.get("components")
        if not comp:
            continue
        entry = {"components": dict(comp["components"]),
                 "base_applied_pts": comp["base_applied_pts"]}
        if bonus_by_name:
            bg = bonus_by_name.get(canonical_player_name(r.get("name") or ""))
            if bg:
                entry["bonus_games"] = dict(bg)
        out[r["gsis_id"]] = entry
    return out


def _carry_rookie_flags(src_records, dst_records):
    """Copy `rookie` flags from one record list onto another, by gsis_id, IN
    PLACE on dst. R41b (2026-09-01 incident): the injury re-projection pass
    rebuilds every record through project_players — fresh dicts with no
    `rookie` key — and rewrites player_projections.json, so the run whose log
    said "349 of 395 stamped" shipped a file with ZERO flags. The rewrite's
    order guard already proves the two lists carry identical gsis_ids, so
    carrying the same run's stamp across is honest and costs no second fetch.
    A dst record whose id has no flag in src stays unstamped (unknown, never
    false). Returns how many flags were carried."""
    flags = {p["gsis_id"]: p["rookie"] for p in src_records if "rookie" in p}
    carried = 0
    for p in dst_records:
        if p["gsis_id"] in flags:
            p["rookie"] = flags[p["gsis_id"]]
            carried += 1
    return carried


def _nflverse_reached(ol_src):
    """Did the o-line build actually reach nflverse snap counts? Keyed on the
    PRECISE writer token, not bare substrings. R41 (2026-09-01): the old check
    ("nflverse" in src and "unreachable" not in src) broke the moment R40's
    per-team skip note added "roster page unreachable" to a source whose snap
    counts had refined FINE — nflverse reported degraded on a healthy run.
    The refined path always carries "nflverse_snap_counts_2025"; the ESPN-only
    fallback never does (it reads "espn_roster only (nflverse snap counts
    unreachable ...)")."""
    return "nflverse_snap_counts_2025" in (ol_src or "")


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
    if not finals_cur:
        # A bare ok/0 during August reads as silence — say WHY it is zero. This
        # feed counts REGULAR-SEASON finals only (fetch_final_results pages
        # seasontype=2, weeks 1-18): preseason games are excluded BY DESIGN and
        # must never feed Elo, actuals, or scoring (the status-gating rule).
        feeds[f"espn_results_{SEASON}"]["note"] = (
            "0 regular-season finals: the %d season has not started. Preseason "
            "games are excluded by design (seasontype=2 only) and never feed "
            "Elo or scoring." % SEASON)
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
    # epa_blend (adopted elo_epa family): per-team additive deltas from the
    # EPA-driven parallel rating track, replayed over all resolved seasons.
    _epa_blend = _adopted.get("epa_blend") or {}
    _blend_deltas = {}
    if _epa_blend.get("applied"):
        from scripts.promote_signals import epa_blend_deltas  # noqa: PLC0415 (guarded)
        _blend_deltas = epa_blend_deltas(float(_epa_blend["weight"])) or {}
        if _blend_deltas:
            print(f"promoted epa_blend in effect: w={_epa_blend['weight']} "
                  f"({len(_blend_deltas)} team deltas)")
        else:
            print("WARNING: epa_blend adopted but epa_history unavailable — not applied")
    # qb_out (adopted family): expected primary passer listed Out/Doubtful on
    # the current week's report — pregame availability, refreshed daily.
    _qb_out = _adopted.get("qb_out") or {}
    _qb_primary, _qb_outs, _qb_scale = {}, {}, 0.0
    if _qb_out.get("applied"):
        from scripts.promote_signals import qb_out_current  # noqa: PLC0415 (guarded)
        _cur = qb_out_current(SEASON)
        if _cur is None:
            print("WARNING: qb_out adopted but passer data unavailable — not applied")
        else:
            _qb_primary, _qb_outs = _cur
            _qb_scale = float(_qb_out["scale"])
            _listed = sum(1 for k in _qb_outs)
            print(f"promoted qb_out in effect: scale={_qb_scale} "
                  f"({len(_qb_primary)} primaries, {_listed} team-weeks with QB listings)")
    # skill_out (adopted family): RB/WR/TE starters listed Out/Doubtful, weighted
    # by their prior-season within-team opportunity share (pregame, refreshed
    # daily via injury_history). Dormant until usage history is bootstrapped.
    _skill = _adopted.get("skill_out") or {}
    _skill_share, _skill_outs, _skill_scale = {}, {}, 0.0
    if _skill.get("applied"):
        from scripts.promote_signals import skill_out_current  # noqa: PLC0415 (guarded)
        _sc = skill_out_current(SEASON)
        if _sc is None:
            print("WARNING: skill_out adopted but usage history unavailable — not applied")
        else:
            _skill_share, _skill_outs = _sc
            _skill_scale = float(_skill["scale"])
            print(f"promoted skill_out in effect: scale={_skill_scale} "
                  f"({len(_skill_share)} usage shares, {len(_skill_outs)} team-weeks listed)")
    # weather_wind (adopted family): windy open-roof games get an Elo nudge in
    # the adopted direction. Prediction-time wind comes from weather_forecast.json
    # (upcoming open-roof homes, refreshed daily) — dormant offseason, no
    # fabricated wind for games outside the forecast horizon.
    _wind = _adopted.get("wind_hfa") or {}
    _wind_map, _wind_scale, _wind_thr = {}, 0.0, 30.0
    if _wind.get("applied"):
        from scripts.promote_signals import wind_current  # noqa: PLC0415 (guarded)
        _wm = wind_current(SEASON)
        if not _wm:
            print("WARNING: weather_wind adopted but no forecast wind available — not applied"
                  if _wm is None else
                  "weather_wind adopted; no upcoming windy games in forecast horizon yet")
        else:
            _wind_map = _wm
            _wind_scale = float(_wind["scale"])
            _wind_thr = float(_wind.get("threshold_kph", 30.0))
            _windy = sum(1 for v in _wind_map.values() if v >= _wind_thr)
            print(f"promoted weather_wind in effect: scale={_wind_scale:+g} "
                  f"threshold={_wind_thr}kph ({_windy}/{len(_wind_map)} upcoming games windy)")
    # divisional (adopted family): same-division matchups take a fixed Elo
    # delta, with an extra term on the in-season rematch. Both fields are
    # SCHEDULE facts, so they are derived straight from this season's slate
    # when game_context.json does not yet carry the season being played.
    _div = _adopted.get("divisional") or {}
    _div_ctx, _div_scale, _div_extra = {}, 0.0, 0.0
    if _div.get("applied"):
        from scripts.promote_signals import divisional_current  # noqa: PLC0415 (guarded)
        _dc = divisional_current(SEASON, schedule=schedule)
        if not _dc:
            print("WARNING: divisional adopted but neither game_context.json nor the "
                  "schedule could supply div_game/meeting_no — not applied")
        else:
            _div_ctx = _dc
            _div_scale = float(_div.get("scale") or 0.0)
            _div_extra = float(_div.get("rematch_extra") or 0.0)
            _ndiv = sum(1 for v in _div_ctx.values() if v.get("div_game"))
            # COVERAGE, not just presence. A non-empty map is truthy, so the
            # "not applied" warning above can never fire for a PARTIAL map —
            # and a game with no row prices at exactly 0.0, indistinguishable
            # from a non-divisional game. Count the misses out loud.
            _dmiss = sum(1 for g in schedule
                         if f"{SEASON}|{g.get('week')}|{g['home']}|{g['away']}"
                         not in _div_ctx)
            if _dmiss:
                print(f"WARNING: divisional context covers only "
                      f"{len(schedule) - _dmiss}/{len(schedule)} scheduled games "
                      f"— {_dmiss} game(s) will price at 0.0 (not applied there)")
            print(f"promoted divisional in effect: base={_div_scale:+g} "
                  f"rematch={_div_extra:+g} ({_ndiv}/{len(_div_ctx)} games divisional)")
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
        if _blend_deltas:
            hfa_eff += _blend_deltas.get(g["home"], 0.0) - _blend_deltas.get(g["away"], 0.0)
        if _qb_scale:
            _wk = int(g.get("week") or 0)
            _hp = _qb_primary.get(g["home"])
            if _hp and _hp in _qb_outs.get((g["home"], _wk), ()):
                hfa_eff -= _qb_scale
            _ap = _qb_primary.get(g["away"])
            if _ap and _ap in _qb_outs.get((g["away"], _wk), ()):
                hfa_eff += _qb_scale
        if _wind_scale:
            _w = _wind_map.get(f"{SEASON}|{g.get('week')}|{g['home']}|{g['away']}")
            if _w is not None and _w >= _wind_thr:
                hfa_eff += _wind_scale
        if _skill_scale:
            _wk2 = int(g.get("week") or 0)
            _lost_h = sum(_skill_share.get(pid, 0.0)
                          for pid in _skill_outs.get((g["home"], _wk2), ()))
            _lost_a = sum(_skill_share.get(pid, 0.0)
                          for pid in _skill_outs.get((g["away"], _wk2), ()))
            hfa_eff += _skill_scale * (_lost_a - _lost_h)
        if _div_ctx:
            from scripts.signals.divisional import (  # noqa: PLC0415 (guarded)
                divisional_delta, context_key)
            hfa_eff += divisional_delta(_div_ctx.get(context_key(SEASON, g)),
                                        _div_scale, _div_extra)
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
    # R33 — current_season=SEASON stamps each record's `team` from the DRAFT
    # season's rosters (measured stats still come from PRIOR_SEASON). This is the
    # root cause behind R32: the prior-season kona freezes proTeamId at last
    # season's rosters, so every offseason mover showed his old team in the app,
    # got the wrong 2026 bye/schedule split, seeded props for the wrong slate —
    # and broke the (team, name) injury join that R32's name fallback papers
    # over. With teams current, that fallback is a safety net again, not the join.
    players_in = espn_players.build_player_records(PRIOR_SEASON, teams,
                                                   current_season=SEASON)
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
    n_stamped, n_rookies = _stamp_rookies(projected)
    print(f"rookie flags: {n_stamped} of {len(projected)} stamped from nflverse "
          f"rosters ({n_rookies} rookies); unstamped = unknown, never false")
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

    # Injuries (display + availability + future signal). Best-effort — don't fail the
    # whole run. NOT HOISTED, deliberately (Rel17 C1): this is a guarded feed, and
    # build_weekly already runs after it (see the WEEKLY block below), so the weekly
    # split — where the season-total reduction actually happens — has always seen the
    # fresh file. Hoisting the fetch above the N2 block would buy only the projection
    # band below and would cost the whole run's degrade-don't-die semantics.
    try:
        inj = espn.fetch_injuries()
        feeds["injuries"] = {"rows": len(inj), "age_hours": 0.0, "last_success_utc": now, "status": "ok"}
        _write(os.path.join(DATA, "injuries.json"),
               availability.enrich_document({"updated_utc": now, "source": "espn",
                                             "injuries": inj}))

        # REL17 (F6) — SECOND, BAND-ONLY PROJECTION PASS. The first pass at the N2
        # block above ran before this feed existed, so `injury_status` was whatever
        # ESPN's FANTASY api said (a different vocabulary with different coverage) and
        # the site-API injury REPORT — the only feed carrying free-text duration — had
        # no say at all. Re-stamp the canonical status from the report and re-project.
        #
        # Nothing here can move proj_points while every signal weight is 0.0; what
        # changes is `low`/`high` widening for genuinely uncertain players. That is the
        # honest, weight-0-safe half of the fix, and exactly why the season-total
        # reduction lives in build_weekly instead: how many weeks a player misses is a
        # FACT from a feed, not a learned effect, so it must not sit behind the
        # promotion gate.
        #
        # Guarded separately from the fetch ON PURPOSE: by this line the feed has
        # already succeeded and been written, so a fault in OUR re-projection is a
        # code bug, not an outage. Rolling it into the outer handler would stamp
        # feeds["injuries"] = "down" for a feed that is demonstrably up — a false
        # statement about a feed, which is the one thing pipeline_status may never be.
        try:
            # R30c — by_name switches on the offseason-mover fallback (see
            # availability.index_report_by_name: the pool's team column lags the
            # report's every August, so the (team, name) join dropped exactly
            # the players who changed teams — Questionable stars rendered
            # healthy five days before the owner's draft).
            n_overridden = availability.apply_to_records(
                players_in, availability.index_report(inj),
                by_name=availability.index_report_by_name(inj))
            if n_overridden:
                reprojected = [p for p in project_players(players_in,
                                                          ctx={"teams": teams_fixture})
                               if p["proj_points"] > 0]
                reprojected.sort(key=lambda p: (-p["proj_points"], p["gsis_id"]))
                # ORDER GUARD, mandatory. weekly_contract.test.mjs locks that
                # player_weekly.json mirrors player_projections.json id-for-id AND in
                # order, and build_weekly runs later off projected[:300]. At weight 0
                # the order CANNOT change (proj_points is untouched; only low/high
                # move), so this guard should never fire — and if it ever does, that
                # is a real regression and refusing the rewrite is the honest response.
                if [p["gsis_id"] for p in reprojected[:300]] == \
                        [p["gsis_id"] for p in projected[:300]]:
                    # R41b — project_players built these records fresh, so the
                    # rookie stamp from the N2 block is not on them; without
                    # this carry the rewrite below ships a flagless file.
                    _carry_rookie_flags(projected, reprojected)
                    projected = reprojected
                    _write(os.path.join(DATA, "player_projections.json"), {
                        "season": SEASON, "updated_utc": now,
                        "players": projected[:300],
                    })
                    print(f"injury re-projection (interval bands only): "
                          f"{n_overridden} records overridden")
                else:
                    print("[warn] injury re-projection changed the top-300 ordering "
                          "— skipped (player_projections.json left as first-pass)",
                          file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 — degrade, never mask
            print(f"[warn] injury re-projection failed (projections left as "
                  f"first-pass; the injuries feed itself is fine): {exc}",
                  file=sys.stderr)
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
        # Age here is REAL and can be weeks (refresh=False reuses the committed
        # file, see the block comment above) — that is by design, not staleness:
        # the artifact measures the CLOSED 2021-2025 window, so its content
        # cannot go stale until the window definition changes. "ok" is honest
        # only because of that; a zero-row build is still degraded, per the
        # 0-row-is-never-ok house rule.
        feeds["environment"] = {
            "rows": env["rows"],
            "age_hours": env_age if env_age is not None else 0.0,
            "last_success_utc": env.get("updated_utc") or now,
            "status": "ok" if int(env.get("rows") or 0) > 0 else "degraded",
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
        nv_ok = _nflverse_reached(ol_src)
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
        # AUCTION VALUE (ESPN kona ownership.auctionValueAverage) — the room's
        # observed price, joined onto the same rows. SAME POLICY AS ADP: display
        # + value flags only, never an input (validate_data MARKET_PRICE_FIELDS).
        # It needs its OWN pull: the pool request above is for PRIOR_SEASON, and
        # ESPN zeroes auctionValueAverage for a season already played, so the
        # draft season (SEASON) is the only place the price exists. Guarded on its
        # own so a dead auction feed costs the auction field, not the ADP board.
        auction_join = None
        try:
            _auc = espn_players.fetch_auction_values(SEASON)
            _by_gid = {f"espn-{r['espn_id']}": r["auction_value"] for r in _auc}
            _by_name = {}
            for r in _auc:                      # secondary key for board rows we
                _by_name.setdefault(              # do not project (gsis_id None)
                    (adp_mod.norm_name(r["name"]), r["position"]), r["auction_value"])
            _hit = 0
            for r in adp_rows:
                val = _by_gid.get(r.get("gsis_id")) if r.get("gsis_id") else None
                if val is None:
                    val = _by_name.get((adp_mod.norm_name(r["name"]), r["position"]))
                # Absent stays ABSENT: ESPN not pricing a player is not a $0 price.
                r["auction_value"] = val
                if val is not None:
                    _hit += 1
            auction_join = round(_hit / len(adp_rows), 3) if adp_rows else 0.0
            print(f"auction: {len(_auc)} priced by ESPN, {_hit} joined onto the "
                  f"ADP board (join rate {auction_join})")
        except Exception as exc:  # noqa: BLE001 — loud, and the ADP board still ships
            for r in adp_rows:
                r.pop("auction_value", None)
            print(f"[warn] ESPN auction values unavailable (ADP board still ships "
                  f"WITHOUT prices, not with fabricated ones): {exc}", file=sys.stderr)
        _write(os.path.join(DATA, "adp.json"), {
            "updated_utc": now,
            "source": "fantasyfootballcalculator ppr 12-team",
            "format": "ppr", "league_size": 12, "join_rate": adp_join,
            "auction_source": ("espn kona ownership.auctionValueAverage"
                               if auction_join is not None else None),
            "auction_budget": 200 if auction_join is not None else None,
            "auction_join_rate": auction_join,
            "players": adp_rows,
        })
        feeds["adp"] = {"rows": len(adp_rows), "age_hours": 0.0,
                        "last_success_utc": now, "status": "ok"}
        print(f"adp: {len(adp_rows)} players, join rate {adp_join}")
        # ADP TIME-SERIES: one bounded snapshot per calendar day — market
        # movement (risers/fallers) + a moving benchmark for beat-ADP grading.
        _hist_path = os.path.join(DATA, "adp_history.json")
        _today = now[:10]
        _hist = {"snapshots": []}
        if os.path.exists(_hist_path):
            with open(_hist_path, encoding="utf-8") as fh:
                _hist = json.load(fh)
        _snaps = _hist.get("snapshots") or []
        if not _snaps or _snaps[-1].get("date") != _today:
            _snaps.append({"date": _today,
                           "players": [{"gsis_id": r.get("gsis_id"),
                                        "name": r["name"], "adp": r["adp"]}
                                       for r in adp_rows[:200]]})
            _write(_hist_path, {"updated_utc": now,
                                "source": "daily FFC ADP snapshots",
                                "snapshots": _snaps[-150:]})
            print(f"adp_history: snapshot {_today} appended ({len(_snaps[-150:])} kept)")
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
        # R30: the source's own honest status (ok/degraded/down) carries through
        # — see market_feed_record. Never "ok" off a zero-row write.
        for src_name in ("kalshi", "polymarket"):
            feeds[src_name] = market_feed_record(
                mdoc["sources"].get(src_name, {}), now)
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
    # first_week=wk is MANDATORY, not cosmetic (Rel17): an absence blocks weeks
    # forward from the current week. Left at its default of 1, an in-season IR
    # placement would zero weeks 1-4 — games already played, which no surface
    # reads — and leave the weeks he will actually miss fully projected, so the
    # season-total reduction and the Lineup demotion would both silently no-op
    # from Week 2 onward. In preseason current_week() is 1, so this is a no-op
    # today and correct the moment real football starts.
    receptions_by_id = {r["gsis_id"]: r.get("receptions", 0.0) for r in players_in}
    # R28 — completions ride the SAME N2 feed (kona statId 1, beside the statId
    # 53 receptions read just above), so a league scoring Sleeper's `pass_cmp`
    # can be priced exactly instead of having ~0.5 x 350 points a season quietly
    # omitted from every starting quarterback.
    completions_by_id = {r["gsis_id"]: r.get("completions", 0.0) for r in players_in}
    # R44 — the FULL component stat line (kona, self-verified against ESPN's
    # own appliedStats arithmetic) plus measured per-game yardage-bonus counts
    # (nflverse weekly lines), so the client can price EVERY league scoring
    # rule a component feeds instead of receptions + pass_cmp alone. Both
    # halves degrade to absence, never to zero-filled claims.
    bonus_by_name = _bonus_games_by_name()
    components_by_id = _components_by_id(players_in, bonus_by_name)
    n_bonus = sum(1 for v in components_by_id.values() if v.get("bonus_games"))
    print(f"league components: {len(components_by_id)} of {len(players_in)} "
          f"players carry a verified stat line ({n_bonus} with measured "
          f"bonus-game counts); absent = unverified, never zero")
    weekly_doc = build_weekly.build_weekly_document(
        projected[:300], predicted, ratings, receptions_by_id, SEASON, now,
        first_week=wk, completions_by_id=completions_by_id,
        components_by_id=components_by_id)
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
    # `schedules` is parsed from .github/workflows/*.yml so the cadence the MODEL
    # tab shows is the cadence that actually runs — it cannot drift from the YAML.
    _write(os.path.join(DATA, "pipeline_status.json"), {
        "generated_utc": now, "health": health, "feeds": feeds,
        "schedules": read_schedules(),
    })

    print(f"OK  teams={len(teams)} elo_teams={len(ratings)} schedule={len(schedule)} "
          f"week={wk} week_games={len(week_games)} "
          f"weekly_players={len(weekly_doc['players'])} health={health}")


if __name__ == "__main__":
    main()
