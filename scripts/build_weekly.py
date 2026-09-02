"""Weekly per-player projection split (weekly_split_v2) -> data/player_weekly.json.

Pure + deterministic + stdlib only: scripts.build_predictions feeds it the season
projections, the full 2026 schedule, the Elo priors, and prior-season receptions;
the three v2 factor feeds (DvP history, environment model, weather forecast) are
read here ONCE per document build through small loaders with explicit paths, so
the selftest and scripts/backtest_weekly.py can inject fixtures. No network here.

The model — a transparent prior, measured (data/weekly_backtest.json), NOT fitted:
  bye   -> pts 0.0 (a team is on bye in week W iff it plays no game that week
           in schedule_full; 2026 byes fall in weeks 5-14)
  base  = season_proj / games_scheduled (the team's non-bye week count, usually 17)
  pts_raw = base x D x T x W x V, per non-bye week, where
    D  opponent DvP (every position): F = the opponent's allowed PPR points per
       game to the player's position — prior season at HALF weight blended with
       the current season's weeks < wk — divided by the league average of the
       same blend; D = clamp(1 + DVP_SHRINK x (F - 1), 0.75, 1.25). Opponent or
       position absent from the feed -> F = 1.0, counted in meta.
    T  Elo tilt, QB ONLY: 1 + TILT_COEF x (team_elo - opp_elo) / 400 clamped to
       [TILT_MIN, TILT_MAX]. RB/WR/TE get T = 1 (measured: the tilt cost 0.14 MAE
       for RB/WR/TE and helped QB rank order).
    W  weather, from the HOME stadium's roof and the kickoff-hour forecast:
       QB/WR/TE dome|closed x1.03, outdoors|open x0.97 (and x0.97 again when the
       forecast is <= 0 C), retractable 1.0; RB x0.95 when outdoors and the
       forecast wind is >= 24 km/h. No forecast row -> the roof-only factor,
       never a guessed temperature, counted in meta.
    V  venue-specific home field (replaces the flat +/-0.02): rel = clamp(
       venue avg_home_margin / lam, -1.0, 2.5) with lam the games-weighted mean
       margin over all venues; rel = 1.0 (today's flat behaviour) when lam <= 0.3
       or the venue is missing / low_n. Home V = 1 + HOME_COEF x rel, away
       V = 1 - HOME_COEF x rel, both from the HOME team's venue.
  then the weeks the player CAN PLAY are renormalized to sum exactly to his
  availability-adjusted season target — the factors REDISTRIBUTE points across
  those weeks, they never inflate them.

TILT_COEF is recorded in the output meta on purpose: it is the parameter the P2
optimizer refits in-season against resolved weekly snapshot locks (NEVER-REGRESS
gated). Every row stays estimate=true until the harness proves otherwise.

TWO DISTINCT INJURY MECHANICS, and conflating them was the Rel17 defect.
scripts/availability.py owns the vocabulary that tells them apart.

  (a) WEEK-SHAPING — short-term news (Questionable / Doubtful / Out this week).
      data/injuries.json statuses map to a multiplier on the FIRST 3 weeks the
      player can play (Out 0.55, Doubtful 0.7, Questionable 0.9). The split is
      then renormalized so the season total is preserved EXACTLY: a questionable
      player is still going to play a full season, so the injury shifts the SHAPE
      toward the healthy back weeks and nothing else. This is unchanged, and it is
      correct for its case.

  (b) UNAVAILABILITY — long-term absence (IR / PUP / NFI / suspension, or any
      status whose report text states an unambiguous duration). The blocked weeks
      are zeroed and EXCLUDED from the renormalization, so the season total
      ACTUALLY DROPS, pro-rata to the games the player can play. Before Rel17
      mechanic (a) was the only one that existed, which meant an injury merely
      RESHAPED the curve and a player who will not take a snap all year still
      carried 100% of his season points.

  A season-class player with no parsed duration falls to the documented four-game
  league floor (availability.MIN_WEEKS_OUT), stamped confidence="rule" so no
  surface can present a floor as a measurement. A suspension of unstated length
  blocks NOTHING and is flagged only — we do not know how long, and honest data
  beats a convenient guess.

When injuries.json is absent or empty the output is byte-identical to the
injury-free build, and the model meta records injury_shape / availability only
when at least one player was actually shaped / actually blocked.

INVARIANT: output player order mirrors data/player_projections.json exactly
(same ids, same order) — the app zips the two files by index.

R49 — ABSENCE ALREADY IN THE TOTAL. When a projection row was built under the
games-normalized baseline (`baseline_rule` == "prior_ppg_x_projected_games") with a
documented `absence_weeks` > 0, its proj_points ALREADY excludes the blocked games
(prior_ppg x (17 - absence)). Mechanic (b) then zeroes the same weeks but
renormalizes the playable weeks to the FULL season number instead of a pro-rata
share — otherwise the absence would be subtracted twice. `season_points_lost` on
such a row is the projection's own per-game rate times the weeks zeroed, so the
headline still says how many points the absence cost. Rows under the total rule
(the shipped rule today) are byte-identical to the pre-R49 split.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import availability  # noqa: E402

INJURIES_PATH = os.path.join(_ROOT, "data", "injuries.json")

WEEKS = 18
INJURY_WEEKS = 3    # injury shaping horizon: the FIRST 3 PLAYABLE non-bye weeks
# status -> near-term availability multiplier (documented prior, NOT fitted).
# Verbatim ESPN spellings, deliberately unchanged: the canonical reading is derived
# from this table below, never the other way round.
INJURY_MULT = {"Out": 0.55, "Doubtful": 0.7, "Questionable": 0.9}
# The same prior re-keyed onto the canonical vocabulary, DERIVED so the two can
# never drift. Anything outside it (ACTIVE, and every season-class code — those are
# handled by mechanic (b), not by a multiplier) multiplies by 1.0 and is dropped.
INJURY_MULT_CANON = {availability.normalize_status(k): v
                     for k, v in INJURY_MULT.items()}
# A None key here would be catastrophic and silent: injury_multipliers looks up an
# unrecognised status as None, so an unmappable INJURY_MULT key would hand EVERY
# unknown status that key's discount. Refuse to import instead.
assert None not in INJURY_MULT_CANON, (
    f"INJURY_MULT has a status scripts/availability.py cannot read: "
    f"{sorted(k for k in INJURY_MULT if availability.normalize_status(k) is None)}"
)
assert set(INJURY_MULT_CANON) <= availability.WEEK_CLASS, (
    "INJURY_MULT is mechanic (a) only — a season-class code must reduce the total "
    "via unavailability(), not merely reshape the curve via a multiplier."
)
TILT_COEF = 0.5     # Elo-tilt strength; the optimizer-refit parameter (see above)
HOME_COEF = 0.02    # venue coefficient: home 1 + 0.02 x rel / away 1 - 0.02 x rel
TILT_MIN = 0.75     # clamp so one lopsided matchup can't swallow the season
TILT_MAX = 1.25
ELO_INIT = 1500.0   # mirrors scripts.models.elo.INIT (league-average prior)
MODEL_NAME = "weekly_split_v2"
MODEL_NOTES = (
    "Season projection split evenly across scheduled weeks, then multiplied per "
    "week by opponent DvP (all positions, shrink 0.25, prior season at half weight "
    "blended with the current season to date), Elo matchup tilt (QB only), "
    "roof/forecast weather and venue-specific home field, and renormalized so the "
    "playable non-bye weeks sum exactly to the season projection. Every factor is "
    "a transparent prior measured walk-forward in data/weekly_backtest.json; a "
    "missing feed row is neutral (1.0) and counted, never guessed."
)

# ---- weekly_split_v2 factor feeds + priors ---------------------------------------
DVP_PATH = os.path.join(_ROOT, "data", "dvp_positional_history.json")
ENV_PATH = os.path.join(_ROOT, "data", "environment_model.json")
FORECAST_PATH = os.path.join(_ROOT, "data", "weather_forecast.json")

POSITIONS = ("QB", "RB", "WR", "TE")
ELO_TILT_POSITIONS = ("QB",)          # T = 1 for every other position
PASS_POSITIONS = frozenset(("QB", "WR", "TE"))
DVP_SHRINK = 0.25                     # D = 1 + 0.25 x (F - 1)
DVP_PRIOR_WEIGHT = 0.5                # prior season at half weight in the blend
DVP_MIN, DVP_MAX = 0.75, 1.25
WEATHER = {                           # multipliers + thresholds, all documented priors
    "pass_dome": 1.03, "pass_outdoors": 0.97, "pass_cold_extra": 0.97,
    "rb_wind": 0.95, "cold_c": 0.0, "wind_kph": 24.0,
}
VENUE_REL_CLAMP = (-1.0, 2.5)
VENUE_LAM_MIN = 0.3                   # lam at or below this -> flat +/-HOME_COEF
ROOF_INDOOR = frozenset(("dome", "closed"))
ROOF_OUTDOOR = frozenset(("outdoors", "outdoor", "open"))
# The feed may spell a franchise by its old code; mirrors scripts/build_dvp_positional.py.
TEAM_RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}
NEUTRAL_KEYS = ("dvp_neutral_weeks", "weather_no_forecast_weeks", "venue_flat_weeks")


def _load_json(path):
    """A feed document, or None when the file is absent/unreadable. The absence is
    LOUD on stderr and shows up in the model meta as neutral weeks — a missing
    feed makes every factor 1.0, it never makes one up."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[warn] build_weekly: feed {os.path.basename(path)} unavailable "
              f"({exc}); its factor is neutral for every week", file=sys.stderr)
        return None


def load_dvp(path=DVP_PATH):
    """data/dvp_positional_history.json (seasons[season][team][week] =
    {"def": {pos: pts}, "g": games, "off": {...}}) or None."""
    return _load_json(path)


def load_environment(path=ENV_PATH):
    """data/environment_model.json (stadiums[team].roof, venue_hfa[team]) or None."""
    return _load_json(path)


def load_forecast(path=FORECAST_PATH):
    """data/weather_forecast.json (games["season|week|HOME|AWAY"] =
    {temp_c, wind_kph, precip_mm}) or None."""
    return _load_json(path)


def norm_team(code, renames=None):
    """Canonical nflverse team code (LA -> LAR, OAK -> LV, ...)."""
    if code is None:
        return None
    c = str(code).upper()
    return (renames or TEAM_RENAMES).get(c, c)


def _clamp(x, lo, hi):
    return min(hi, max(lo, x))


def tilt_factor(team_elo, opp_elo):
    """Elo matchup tilt, clamped to [TILT_MIN, TILT_MAX]."""
    return _clamp(1.0 + TILT_COEF * (team_elo - opp_elo) / 400.0, TILT_MIN, TILT_MAX)


def dvp_rates(dvp_doc, season, wk):
    """{team: {pos: F}} for the games of week `wk` of `season`.

    F = the team's allowed PPR points per game to `pos` — prior season (season-1)
    at DVP_PRIOR_WEIGHT plus the current season's weeks < wk at full weight, a
    games-weighted blend — divided by the league mean of that blend over every
    team with data. A team/position with no data is simply absent (F = 1.0 and a
    neutral count at the caller), never zero.
    """
    seasons = (dvp_doc or {}).get("seasons") or {}
    renames = (dvp_doc or {}).get("renames") or TEAM_RENAMES
    prior = seasons.get(str(season - 1)) or {}
    cur = seasons.get(str(season)) or {}
    acc = {}
    for src, weight, is_cur in ((prior, DVP_PRIOR_WEIGHT, False), (cur, 1.0, True)):
        for team, weeks in src.items():
            t = norm_team(team, renames)
            for w, rec in (weeks or {}).items():
                try:
                    if is_cur and int(w) >= int(wk):
                        continue
                    g = float(rec.get("g") or 0)
                except (TypeError, ValueError):
                    continue
                if g <= 0:
                    continue
                allowed = rec.get("def") or {}
                for pos in POSITIONS:
                    if pos not in allowed or allowed[pos] is None:
                        continue
                    cell = acc.setdefault(t, {}).setdefault(pos, [0.0, 0.0])
                    cell[0] += weight * float(allowed[pos])
                    cell[1] += weight * g
    rates = {}
    for pos in POSITIONS:
        per_team = {t: c[pos][0] / c[pos][1] for t, c in acc.items()
                    if pos in c and c[pos][1] > 0}
        if not per_team:
            continue
        league = sum(per_team.values()) / len(per_team)
        if league <= 0:
            continue
        for t, r in per_team.items():
            rates.setdefault(t, {})[pos] = r / league
    return rates


def dvp_factor(F):
    """D = clamp(1 + DVP_SHRINK x (F - 1), DVP_MIN, DVP_MAX)."""
    return _clamp(1.0 + DVP_SHRINK * (float(F) - 1.0), DVP_MIN, DVP_MAX)


def roof_class(roof):
    """'indoor' | 'outdoor' | None (retractable / unknown: no claim)."""
    r = str(roof or "").strip().lower()
    if r in ROOF_INDOOR:
        return "indoor"
    if r in ROOF_OUTDOOR:
        return "outdoor"
    return None


def weather_factor(position, roof, temp_c=None, wind_kph=None):
    """(W, forecast_missing) for one player-week.

    QB/WR/TE: indoor x pass_dome, outdoor x pass_outdoors (x pass_cold_extra when
    the forecast temperature is <= cold_c), retractable/unknown 1.0.
    RB: outdoor and forecast wind >= wind_kph -> x rb_wind, else 1.0.
    A None temperature/wind on an outdoor game is "no forecast": the roof-only
    factor applies and forecast_missing is True so the caller can count it.
    """
    rc = roof_class(roof)
    pos = str(position or "").upper()
    if pos in PASS_POSITIONS:
        if rc == "indoor":
            return WEATHER["pass_dome"], False
        if rc == "outdoor":
            f = WEATHER["pass_outdoors"]
            if temp_c is None:
                return f, True
            if float(temp_c) <= WEATHER["cold_c"]:
                f *= WEATHER["pass_cold_extra"]
            return f, False
        return 1.0, False
    if pos == "RB":
        if rc == "outdoor":
            if wind_kph is None:
                return 1.0, True
            return (WEATHER["rb_wind"] if float(wind_kph) >= WEATHER["wind_kph"]
                    else 1.0), False
        return 1.0, False
    return 1.0, False


def venue_rel_table(venue_hfa):
    """({team: rel}, lam) from an environment_model venue_hfa map.

    lam = games-weighted mean of avg_home_margin over every venue with a margin.
    rel = clamp(margin / lam, VENUE_REL_CLAMP) for a venue that is not low_n.
    lam <= VENUE_LAM_MIN -> {} (every venue falls to the flat rel = 1.0).
    """
    rows = []
    for team, v in (venue_hfa or {}).items():
        if not isinstance(v, dict) or v.get("avg_home_margin") is None:
            continue
        g = float(v.get("games") or v.get("n") or 0)
        rows.append((norm_team(team), float(v["avg_home_margin"]), g, bool(v.get("low_n"))))
    total_g = sum(g for _, _, g, _ in rows)
    lam = (sum(m * g for _, m, g, _ in rows) / total_g) if total_g > 0 else 0.0
    if lam <= VENUE_LAM_MIN:
        return {}, lam
    lo, hi = VENUE_REL_CLAMP
    return {t: _clamp(m / lam, lo, hi) for t, m, _, low_n in rows if not low_n}, lam


def venue_factor(rel, home):
    """V for the home (1 + c x rel) or away (1 - c x rel) player."""
    return 1.0 + HOME_COEF * rel if home else 1.0 - HOME_COEF * rel


def build_factors(season, dvp_doc=None, env_doc=None, forecast_doc=None,
                  roof_by_game=None):
    """The per-document factor context player_weeks reads: feeds parsed ONCE.

    roof_by_game ({"season|wk|HOME|AWAY": roof}) overrides the static stadium
    roof for a specific game — the backtest passes the roof state nflverse
    recorded for that game; production leaves it None and uses the stadium table.
    """
    stadiums = (env_doc or {}).get("stadiums") or {}
    venue_rel, lam = venue_rel_table((env_doc or {}).get("venue_hfa"))
    return {
        "season": int(season),
        "dvp_doc": dvp_doc,
        "dvp_by_week": {},                     # wk -> dvp_rates(...), filled lazily
        "roof": {norm_team(t): (v or {}).get("roof") for t, v in stadiums.items()},
        "roof_by_game": dict(roof_by_game or {}),
        "forecast": (forecast_doc or {}).get("games") or {},
        "venue_rel": venue_rel,
        "venue_lam": lam,
        "counts": {k: 0 for k in NEUTRAL_KEYS},
    }


def week_multiplier(factors, wk, team, opp, home, position, elos):
    """D x T x W x V for one non-bye player-week; the neutral counters live on
    `factors["counts"]`. factors=None is the feed-free split: D = W = 1, flat
    venue, and the Elo tilt for the tilt positions only."""
    team_elo = elos.get(team, ELO_INIT)
    opp_elo = elos.get(opp, ELO_INIT)
    pos = str(position or "").upper()
    T = tilt_factor(team_elo, opp_elo) if pos in ELO_TILT_POSITIONS else 1.0
    if factors is None:
        return T * venue_factor(1.0, home)
    counts = factors["counts"]
    home_team, away_team = (team, opp) if home else (opp, team)

    rates = factors["dvp_by_week"].get(wk)
    if rates is None:
        rates = dvp_rates(factors["dvp_doc"], factors["season"], wk)
        factors["dvp_by_week"][wk] = rates
    F = (rates.get(norm_team(opp)) or {}).get(pos)
    if F is None:
        counts["dvp_neutral_weeks"] += 1
        D = 1.0
    else:
        D = dvp_factor(F)

    key = f"{factors['season']}|{wk}|{home_team}|{away_team}"
    roof = factors["roof_by_game"].get(key, factors["roof"].get(home_team))
    fc = factors["forecast"].get(key)
    if fc is None:   # tolerate the reversed spelling of the same game
        fc = factors["forecast"].get(f"{factors['season']}|{wk}|{away_team}|{home_team}")
    fc = fc or {}
    W, missing = weather_factor(pos, roof, fc.get("temp_c"), fc.get("wind_kph"))
    if missing:
        counts["weather_no_forecast_weeks"] += 1

    rel = factors["venue_rel"].get(home_team)
    if rel is None:
        counts["venue_flat_weeks"] += 1
        rel = 1.0
    V = venue_factor(rel, home)
    return D * T * W * V


def load_injuries(path=INJURIES_PATH):
    """Injury rows from data/injuries.json; absent/unreadable/empty -> [].

    Graceful BY CONTRACT, unlike the feeds: a missing injuries file means
    "shape nothing" and the weekly output stays byte-identical to the
    injury-free build. Loudness lives upstream in espn.fetch_injuries.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return []
    return doc.get("injuries") or []


def _norm_name(name):
    """Casefold + strip periods so 'A.J. Brown' joins 'AJ Brown'.

    Delegates to scripts.availability so the join key has ONE definition.
    """
    return availability.norm_name(name)


def injury_multipliers(projections, injuries):
    """{gsis_id: multiplier} for projected players whose status shapes the split.

    Join on (team, normalized player name); a player with several report rows
    keeps the WORST (lowest) multiplier. Statuses outside INJURY_MULT map to
    1.0 and are dropped, so an all-Active report is a clean no-op and only the
    players actually shaped are returned (their count is statuses_used).

    Lookup runs through the canonical vocabulary, so an unrecognised spelling and
    a season-class status alike fall to 1.0 exactly as before — mechanic (b), not
    a multiplier, is what handles a long-term absence.
    """
    by_key = {}
    # R30c — the name-only fallback for offseason movers (the incident is
    # documented at availability.index_report_by_name: the pool's team column
    # lags the report's, so Mike Evans/Kirk/Waller were Questionable in a fresh
    # feed and rendered healthy). Same discipline as the view join: a report
    # name on more than one team is ambiguous and excluded; a pool-duplicated
    # name never falls back.
    by_name = {}
    name_teams = {}
    for row in injuries or []:
        code = availability.normalize_status(row.get("status"))
        mult = INJURY_MULT_CANON.get(code, 1.0)
        if mult >= 1.0:
            continue
        nm = _norm_name(row.get("player"))
        key = (row.get("team"), nm)
        by_key[key] = min(by_key.get(key, 1.0), mult)
        name_teams.setdefault(nm, set()).add(row.get("team"))
        by_name[nm] = min(by_name.get(nm, 1.0), mult)
    by_name = {n: m for n, m in by_name.items() if len(name_teams[n]) == 1}
    ambiguous = availability.dup_names(projections)
    out = {}
    for p in projections:
        nm = _norm_name(p.get("name"))
        mult = by_key.get((p.get("team"), nm))
        if mult is None and nm not in ambiguous:
            mult = by_name.get(nm)
        if mult is not None:
            out[p["gsis_id"]] = mult
    return out


def unavailability(projections, injuries):
    """{gsis_id: availability view} for projected players who are NOT active.

    Sibling to injury_multipliers and joined the same way (team + normalized name,
    worst report row wins). The view carries the canonical status, its mechanic
    class, and — for a season-class absence — the parsed duration and the sentence
    that stated it:

        {"status", "class", "weeks_out", "out_for_season", "confidence", "evidence"}

    Rows whose status does not normalize are dropped by index_report: unknown is
    not a discount, and the loud complaint about the drift belongs at the scraper
    and at the gate, never in a silent consumer.
    """
    index = availability.index_report(injuries)
    # R30c — offseason movers: exact (team, name) first, unique name second.
    by_name = availability.index_report_by_name(injuries)
    ambiguous = availability.dup_names(projections)
    out = {}
    for p in projections:
        view = availability.lookup_report(index, by_name, p.get("team"),
                                          p.get("name"), ambiguous)
        if not view or view["availability"] == availability.ACTIVE:
            continue
        cls = view.get("availability_class")
        if cls is None:
            continue
        out[p["gsis_id"]] = {
            "status": view["availability"],
            "class": cls,
            "weeks_out": view.get("weeks_out"),
            "out_for_season": bool(view.get("out_for_season")),
            "confidence": view.get("confidence"),
            "evidence": view.get("evidence"),
        }
    return out


def blocked_week_count(view):
    """(weeks_to_block, confidence) for one availability view. Never a guess.

    out_for_season          -> every remaining non-bye week      ("explicit")
    weeks_out: N            -> N                                 ("explicit")
    IR / PUP / NFI, no text -> availability.MIN_WEEKS_OUT        ("rule")
    SUSPENDED, no text      -> 0, flagged only                   (None)
    class "week"            -> 0 (shaping only)                  (None)
    """
    if view is None or view.get("class") != "season":
        return 0, None
    if view.get("out_for_season"):
        return WEEKS, "explicit"          # truncated to the real non-bye count
    if view.get("weeks_out"):
        return int(view["weeks_out"]), "explicit"
    if view.get("status") in (availability.IR, availability.PUP, availability.NFI):
        return availability.MIN_WEEKS_OUT, "rule"
    return 0, None                        # SUSPENDED of unstated length


def team_schedule(schedule_games):
    """{team: {week: (opp, home_bool)}} from schedule_full-shaped game rows.

    Bye detection falls out of this map: a team is on bye in week W iff W is
    absent from its entry (it appears in no game that week).
    """
    sched = {}
    for g in schedule_games:
        wk = g["week"]
        sched.setdefault(g["home"], {})[wk] = (g["away"], True)
        sched.setdefault(g["away"], {})[wk] = (g["home"], False)
    return sched


# R49 — the projection rule whose season total already excludes documented absence.
ABSENCE_IN_TOTAL_RULE = "prior_ppg_x_projected_games"


def absence_in_total(projection_row):
    """True iff this projection row's proj_points already excludes its blocked
    games (R49 games-normalized rule with a documented absence). Pure."""
    return (projection_row.get("baseline_rule") == ABSENCE_IN_TOTAL_RULE
            and int(projection_row.get("absence_weeks") or 0) > 0)


def shipped_ratio(projection_row, prior_season_points):
    """R49 override — proj_points_new / prior_season_points for one player: the
    games normalization + full-strength signals the shipped number now carries
    relative to the prior-season total the component line was measured on.
    1.0 when the prior total is unknown or zero (nothing to scale by)."""
    try:
        prior = float(prior_season_points or 0.0)
        shipped = float(projection_row.get("proj_points") or 0.0)
    except (TypeError, ValueError):
        return 1.0
    if prior <= 0 or shipped <= 0:
        return 1.0
    return shipped / prior


def scale_prior_lines(ratio, receptions=None, completions=None, components=None):
    """R49 override — scale a player's prior-season pricing lines by `ratio` so
    the league extras move WITH the shipped number: receptions_prior,
    completions_prior, every league_components quantity and base_applied_pts
    (all linear in quantity, so sum(base_rate x qty) still reproduces
    base_applied_pts within the client's 1.0 check — app/team-logic.js
    componentDelta). `bonus_games` is a COUNT and is left untouched. Pure;
    returns (receptions, completions, components) with the same absence
    semantics as the inputs (None stays None)."""
    r = float(ratio)
    rec = None if receptions is None else round(float(receptions) * r, 1)
    cmp = None if completions is None else round(float(completions) * r, 1)
    comp = None
    if components:
        comp = dict(components)
        if comp.get("components"):
            comp["components"] = {k: round(float(v) * r, 1)
                                  for k, v in comp["components"].items()}
        if comp.get("base_applied_pts") is not None:
            comp["base_applied_pts"] = round(float(comp["base_applied_pts"]) * r, 2)
    return rec, cmp, comp


def player_weeks(season_proj, team, sched_by_team, elos, injury_mult=1.0,
                 unavailable_weeks=0, first_week=1, round_dp=2,
                 absence_in_total=False, position=None, factors=None):
    """18 week rows {wk, opp, home, bye, pts} for one player.

    position / factors (weekly_split_v2): the player's position selects the Elo
    tilt (QB only) and the weather rule; `factors` is build_factors(...) — the
    DvP, roof, forecast and venue tables parsed once per document. factors=None
    is the feed-free split (D = W = 1, flat venue), which is what the offline
    callers without feeds get and what an unknown position falls to.

    Pass round_dp=None to skip the final rounding (the injury test asserts the
    exact-preservation invariant to 1e-6 on the unrounded split).

    injury_mult (< 1.0) is mechanic (a): it discounts the first INJURY_WEEKS weeks
    the player CAN PLAY, before the renormalization, so the injury shifts the SHAPE
    toward the later weeks while the season target stays law.

    unavailable_weeks (> 0) is mechanic (b): the first `unavailable_weeks` non-bye
    weeks with wk >= first_week are BLOCKED — set to pts 0.0, marked
    "avail": False, and excluded from the renormalization entirely. The remaining
    weeks are renormalized to a PRO-RATA target, so the season total actually
    drops. A player out four of seventeen games carries 13/17 of his projection,
    not all of it.

    Step order matters: the partition happens BEFORE the week-shaping, so a player
    out four weeks and questionable after does not have his ding applied to weeks
    he was never going to play.

    At unavailable_weeks=0 this is numerically identical to the pre-Rel17 split,
    path for path, and emits no `avail` key at all.

    absence_in_total (R49): the caller states that `season_proj` ALREADY excludes
    the blocked games (games-normalized baseline). The blocked weeks are still
    zeroed, but the playable weeks renormalize to the FULL season_proj rather than
    a pro-rata share, so the absence is not subtracted twice. Ignored when nothing
    is blocked.
    """
    sched = sched_by_team.get(team, {})
    base = season_proj / len(sched) if sched else 0.0

    raw = []  # indices of non-bye weeks, in week order
    rows = []
    for wk in range(1, WEEKS + 1):
        game = sched.get(wk)
        if game is None:
            rows.append({"wk": wk, "opp": None, "home": False, "bye": True, "pts": 0.0})
            continue
        opp, home = game
        mult = week_multiplier(factors, wk, team, opp, home, position, elos)
        rows.append({"wk": wk, "opp": opp, "home": home, "bye": False,
                     "pts": base * mult})
        raw.append(len(rows) - 1)

    # PARTITION — blocked weeks are the player's absence; available weeks are the
    # only ones that carry points or get renormalized.
    n_total = len(raw)
    n_block = max(0, int(unavailable_weeks or 0))
    blocked = [i for i in raw if rows[i]["wk"] >= first_week][:n_block]
    blocked_set = set(blocked)
    available = [i for i in raw if i not in blocked_set]

    # Mechanic (a): shape the first INJURY_WEEKS PLAYABLE weeks only.
    if injury_mult != 1.0:
        for i in available[:INJURY_WEEKS]:
            rows[i]["pts"] *= injury_mult

    # Renormalize the playable weeks to the availability-adjusted target. With no
    # blocked weeks the target IS the season projection and this is the old law.
    if absence_in_total and blocked:
        target = season_proj
    else:
        target = (season_proj * len(available) / n_total) if n_total else 0.0
    total = sum(rows[i]["pts"] for i in available)
    scale = (target / total) if total > 0 else 0.0
    for i in available:
        pts = rows[i]["pts"] * scale
        rows[i]["pts"] = round(pts, round_dp) if round_dp is not None else pts
    for i in blocked:
        rows[i]["pts"] = 0.0
        rows[i]["avail"] = False   # emitted ONLY when false; absent means available
    return rows


def build_weekly_document(projections, schedule_games, elos, receptions_by_id,
                          season, updated_utc, injuries=None,
                          injuries_path=INJURIES_PATH, first_week=1,
                          completions_by_id=None, components_by_id=None,
                          factors=None, dvp_path=DVP_PATH, env_path=ENV_PATH,
                          forecast_path=FORECAST_PATH):
    """The full player_weekly.json document. Pure given its inputs.

    factors: build_factors(...) for the v2 multipliers; None -> the three feeds
    are loaded ONCE from dvp_path / env_path / forecast_path (tests and the
    backtest pass fixture documents through build_factors instead).

    projections: player_projections.json's `players` list (order is preserved).
    schedule_games: schedule_full.json's `games` list (all 272 rows, all weeks).
    elos: {team: rating} — the SAME preseason priors the game model used.
    receptions_by_id: {gsis_id: prior-season receptions} (0.0 when absent).
    injuries: injury rows (see load_injuries); None -> read injuries_path from
    disk (absent/empty file -> no shaping, byte-identical output). Tests pass
    the list directly so the function stays pure under test.
    first_week: the first week an absence can block (1 preseason; the current
    week in-season, so a player's past weeks are never retro-zeroed).

    Every availability shape is emitted ONLY when non-empty, so an all-healthy
    build is byte-identical to the pre-Rel17 document.
    """
    if injuries is None:
        injuries = load_injuries(injuries_path)
    if factors is None:
        factors = build_factors(season, load_dvp(dvp_path), load_environment(env_path),
                                load_forecast(forecast_path))
    mults = injury_multipliers(projections, injuries)
    unavail = unavailability(projections, injuries)
    sched_by_team = team_schedule(schedule_games)

    players = []
    n_blocked_players = 0
    n_season_ending = 0
    points_removed = 0.0
    for p in projections:
        pid = p["gsis_id"]
        view = unavail.get(pid)
        n_block, confidence = blocked_week_count(view)
        in_total = absence_in_total(p)
        weeks = player_weeks(p["proj_points"], p["team"], sched_by_team, elos,
                             injury_mult=mults.get(pid, 1.0),
                             unavailable_weeks=n_block, first_week=first_week,
                             absence_in_total=in_total,
                             position=p.get("position"), factors=factors)
        row = {
            "gsis_id": pid,
            "receptions_prior": round(float(receptions_by_id.get(pid, 0.0) or 0.0), 1),
        }
        # R28 — COMPLETIONS, on the same row and by the same route as receptions.
        #
        # receptions_prior exists so the client can convert PPR <-> Half <->
        # Standard exactly rather than scaling a total; completions_prior exists
        # for the same reason and for the same kind of rule (Sleeper's
        # `pass_cmp`), which real leagues score and this app has been silently
        # dropping. Emitted ONLY when a completion count is actually known and
        # non-zero, so every non-passer and every build without the feed is
        # byte-identical to the pre-R28 document — a zero here would be a claim
        # ("this quarterback completed no passes") rather than a silence.
        _cmp = float((completions_by_id or {}).get(pid, 0.0) or 0.0)
        if _cmp > 0:
            row["completions_prior"] = round(_cmp, 1)
        # R44 — the verified component stat line, by the same emit-only-when-
        # known rule: a player whose kona entry failed self-verification (or a
        # build without the feed) ships NO component fields and is byte-
        # identical to the pre-R44 document. league_components and
        # base_applied_pts travel TOGETHER — the client's delta needs both,
        # and one without the other would be an unusable half-claim.
        _comp = (components_by_id or {}).get(pid)
        if _comp and _comp.get("components") and _comp.get("base_applied_pts") is not None:
            row["league_components"] = dict(_comp["components"])
            row["base_applied_pts"] = _comp["base_applied_pts"]
            if _comp.get("bonus_games"):
                row["bonus_games"] = dict(_comp["bonus_games"])
        if view is not None:
            block = {"status": view["status"], "class": view["class"]}
            actually_blocked = sum(1 for w in weeks if w.get("avail") is False)
            if actually_blocked:
                # The five season keys ride ONLY on a player whose weeks really were
                # zeroed. A flagged-but-unblocked row (a suspension of unstated
                # length) states nothing about duration, so it claims nothing.
                if in_total:
                    # R49: the total already excludes these games, so the loss
                    # is stated at the projection's own per-game rate (or the
                    # prior rate when every game is gone), never re-subtracted.
                    pg = p.get("projected_games") or 0
                    per_game = (p["proj_points"] / pg) if pg else \
                        float(p.get("prior_ppg") or 0.0)
                    lost = round(per_game * actually_blocked, 2)
                else:
                    lost = round(p["proj_points"] - sum(w["pts"] for w in weeks), 2)
                # weeks_out here is what we DID (the count of weeks actually
                # zeroed), not what the report said — injuries.json records the
                # report. That keeps the duration statement and its applied
                # consequence in agreement by construction, which is what lets
                # weeks[].avail stay the single carrier for blocked weeks. It is
                # also what truncates a stated duration that runs past week 18.
                block["weeks_out"] = None if view["out_for_season"] else actually_blocked
                block["out_for_season"] = view["out_for_season"]
                block["confidence"] = confidence
                block["evidence"] = view["evidence"]
                block["season_points_lost"] = lost
                n_blocked_players += 1
                n_season_ending += 1 if view["out_for_season"] else 0
                points_removed += lost
            row["availability"] = block
        row["weeks"] = weeks
        players.append(row)

    model = {"name": MODEL_NAME, "tilt_coef": TILT_COEF, "home_coef": HOME_COEF,
             "estimate": True, "notes": MODEL_NOTES,
             "dvp_shrink": DVP_SHRINK,
             "elo_tilt_positions": list(ELO_TILT_POSITIONS),
             "weather": dict(WEATHER),
             "venue": {"coef": HOME_COEF, "rel_clamp": list(VENUE_REL_CLAMP)},
             "neutral_counts": dict(factors["counts"]),
             "backtest": "data/weekly_backtest.json"}
    if mults:
        # statuses_used = projected players whose split was actually shaped.
        model["injury_shape"] = {"applied": True, "statuses_used": len(mults)}
    if n_blocked_players:
        model["availability"] = {
            "applied": True,
            "vocab_version": availability.VOCAB_VERSION,
            "unavailable": n_blocked_players,
            "season_ending": n_season_ending,
            "min_weeks_rule": availability.MIN_WEEKS_OUT,
            "season_points_removed": round(points_removed, 2),
        }
    return {
        "season": season,
        "updated_utc": updated_utc,
        "model": model,
        "players": players,
    }


# ----------------------------------------------------------------------------------
# selftest — the two mechanics, their separation, and the no-op guarantee.
# ----------------------------------------------------------------------------------

def _fixture():
    def g(wk, home, away):
        return {"week": wk, "home": home, "away": away}
    # SFX plays weeks 1, 3, 4, 5, 6 — week 2 is a bye, so the "first 3 playable
    # weeks" window has to skip it.
    sched = [g(1, "SFX", "DAL"), g(2, "DAL", "GBX"), g(3, "DAL", "SFX"),
             g(4, "SFX", "GBX"), g(5, "GBX", "SFX"), g(6, "SFX", "DAL")]
    elos = {"SFX": 1580.0, "DAL": 1470.0, "GBX": 1500.0}
    return team_schedule(sched), elos, sched


def _fixture_feeds():
    """Tiny v2 feeds keyed on the _fixture teams. DAL allows a lot to QBs and
    little to RBs; SFX's venue is a fortress, GBX's a neutral one."""
    def wk(qb, rb, wr, te, g=1):
        return {"def": {"QB": qb, "RB": rb, "WR": wr, "TE": te}, "g": g,
                "off": {"QB": 0.0, "RB": 0.0, "WR": 0.0, "TE": 0.0}}
    dvp = {"renames": {"LA": "LAR"}, "seasons": {
        "2025": {"DAL": {"1": wk(30.0, 10.0, 30.0, 10.0), "2": wk(30.0, 10.0, 30.0, 10.0)},
                 "SFX": {"1": wk(10.0, 30.0, 30.0, 10.0), "2": wk(10.0, 30.0, 30.0, 10.0)},
                 "GBX": {"1": wk(20.0, 20.0, 30.0, 10.0), "2": wk(20.0, 20.0, 30.0, 10.0)}},
        "2026": {"DAL": {"1": wk(60.0, 10.0, 30.0, 10.0)},
                 "SFX": {"1": wk(10.0, 30.0, 30.0, 10.0)},
                 "GBX": {"1": wk(20.0, 20.0, 30.0, 10.0)}}}}
    env = {"stadiums": {"SFX": {"roof": "open"}, "DAL": {"roof": "retractable"},
                        "GBX": {"roof": "dome"}},
           "venue_hfa": {"SFX": {"games": 40, "avg_home_margin": 6.0, "low_n": False},
                         "DAL": {"games": 40, "avg_home_margin": 2.0, "low_n": False},
                         "GBX": {"games": 4, "avg_home_margin": 4.0, "low_n": True}}}
    forecast = {"games": {"2026|1|SFX|DAL": {"temp_c": -3.0, "wind_kph": 30.0, "precip_mm": 0.0},
                          "2026|4|SFX|GBX": {"temp_c": 12.0, "wind_kph": 10.0, "precip_mm": 0.0}}}
    return dvp, env, forecast


def selftest():
    sched_by_team, elos, sched = _fixture()
    base = player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None)
    non_bye = [w for w in base if not w["bye"]]
    assert len(non_bye) == 5, len(non_bye)
    assert abs(sum(w["pts"] for w in non_bye) - 200.0) < 1e-9

    # --- unavailable_weeks=0 is the OLD path, exactly -----------------------------
    same = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=0,
                        round_dp=None)
    assert same == base, "unavailable_weeks=0 must be numerically identical"
    assert all("avail" not in w for w in same), "no avail key on a healthy player"

    # --- mechanic (a): shape preserved, total preserved ---------------------------
    shaped = player_weeks(200.0, "SFX", sched_by_team, elos, injury_mult=0.55,
                          round_dp=None)
    assert abs(sum(w["pts"] for w in shaped if not w["bye"]) - 200.0) < 1e-9, \
        "week-shaping must PRESERVE the season total"

    # --- mechanic (b): total REALLY drops, pro-rata -------------------------------
    blocked = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                           round_dp=None)
    got = sum(w["pts"] for w in blocked if not w["bye"])
    assert abs(got - 200.0 * 3 / 5) < 1e-9, f"pro-rata target missed: {got}"
    assert [w["wk"] for w in blocked if w.get("avail") is False] == [1, 3], \
        "the bye must not absorb a blocked week"
    assert blocked[0]["pts"] == 0.0 and blocked[2]["pts"] == 0.0
    assert blocked[1]["bye"] is True and "avail" not in blocked[1], \
        "a bye is NOT an availability block — the app must tell them apart"

    # --- first_week: an absence never retro-zeroes a week already played ----------
    late = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                        first_week=4, round_dp=None)
    assert [w["wk"] for w in late if w.get("avail") is False] == [4, 5], \
        "blocked weeks must start at first_week"

    # --- out for the season -------------------------------------------------------
    gone = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=WEEKS,
                        round_dp=None)
    assert sum(w["pts"] for w in gone) == 0.0, "an out-for-season player scores 0"
    assert sum(1 for w in gone if w.get("avail") is False) == 5

    # --- the partition happens BEFORE the shaping ---------------------------------
    both = player_weeks(200.0, "SFX", sched_by_team, elos, injury_mult=0.55,
                        unavailable_weeks=2, round_dp=None)
    # Playable weeks are 4, 5, 6; all three are inside the INJURY_WEEKS window, so
    # a uniform multiplier cancels in the renormalization and the shape matches the
    # pro-rata baseline exactly. The ding was NOT spent on weeks 1 and 3.
    plain = player_weeks(200.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                         round_dp=None)
    assert all(abs(a["pts"] - b["pts"]) < 1e-9 for a, b in zip(both, plain)), \
        "the injury multiplier must not be spent on weeks the player cannot play"

    # --- R49: absence already in the total is NOT subtracted twice ---------------
    in_total = player_weeks(130.0, "SFX", sched_by_team, elos, unavailable_weeks=2,
                            round_dp=None, absence_in_total=True)
    assert abs(sum(w["pts"] for w in in_total if not w["bye"]) - 130.0) < 1e-6, \
        "absence_in_total must renormalize the playable weeks to the FULL total"
    assert [w["wk"] for w in in_total if w.get("avail") is False] == [1, 3]
    same_as_old = player_weeks(130.0, "SFX", sched_by_team, elos, round_dp=None,
                               absence_in_total=True)
    plain = player_weeks(130.0, "SFX", sched_by_team, elos, round_dp=None)
    assert same_as_old == plain, "with nothing blocked the flag must be a no-op"
    assert absence_in_total({"baseline_rule": "prior_ppg_x_projected_games",
                             "absence_weeks": 4}) is True
    assert absence_in_total({"baseline_rule": "prior_season_points",
                             "absence_weeks": 4}) is False, \
        "the total rule still takes the pro-rata law"
    assert absence_in_total({"baseline_rule": "prior_ppg_x_projected_games"}) is False

    # --- R49 override: prior pricing lines scale with the shipped number ---------
    comp_in = {"components": {"pass_yd": 4000.0, "pass_td": 30.0, "pass_int": 10.0,
                              "rec_tgt": 5.0},
               "base_applied_pts": round(4000 * 0.04 + 30 * 4 - 10 * 2, 2),
               "bonus_games": {"bonus_pass_yd_300": 4}}
    rec, cmp, comp = scale_prior_lines(1.25, 80.0, 300.0, comp_in)
    assert rec == 100.0 and cmp == 375.0
    assert comp["components"]["pass_yd"] == 5000.0 and comp["components"]["pass_td"] == 37.5
    assert comp["bonus_games"] == {"bonus_pass_yd_300": 4}, "a count never scales"
    recomputed = comp["components"]["pass_yd"] * 0.04 + comp["components"]["pass_td"] * 4 \
        - comp["components"]["pass_int"] * 2
    assert abs(recomputed - comp["base_applied_pts"]) <= 1.0, "integrity check holds"
    assert scale_prior_lines(1.25, None, None, None) == (None, None, None)
    assert shipped_ratio({"proj_points": 250.0}, 200.0) == 1.25
    assert shipped_ratio({"proj_points": 250.0}, 0.0) == 1.0
    assert shipped_ratio({"proj_points": 250.0}, None) == 1.0

    # --- blocked_week_count -------------------------------------------------------
    assert blocked_week_count(None) == (0, None)
    assert blocked_week_count({"class": "week", "status": "OUT"}) == (0, None)
    assert blocked_week_count({"class": "season", "status": "IR",
                               "out_for_season": True, "weeks_out": None}) \
        == (WEEKS, "explicit")
    assert blocked_week_count({"class": "season", "status": "SUSPENDED",
                               "out_for_season": False, "weeks_out": 3}) \
        == (3, "explicit")
    assert blocked_week_count({"class": "season", "status": "IR",
                               "out_for_season": False, "weeks_out": None}) \
        == (availability.MIN_WEEKS_OUT, "rule"), "IR with no text falls to the floor"
    assert blocked_week_count({"class": "season", "status": "SUSPENDED",
                               "out_for_season": False, "weeks_out": None}) \
        == (0, None), "a suspension of unknown length must block NOTHING"

    # --- document: emitted only when non-empty ------------------------------------
    proj = [{"gsis_id": "p1", "name": "Hurt Guy", "team": "SFX", "proj_points": 200.0},
            {"gsis_id": "p2", "name": "Fine Guy", "team": "DAL", "proj_points": 150.0}]
    dvp_fx, env_fx, fc_fx = _fixture_feeds()
    kw = dict(receptions_by_id={}, season=2026, updated_utc="2026-07-17T00:00:00Z",
              factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
    clean = build_weekly_document(proj, sched, elos, injuries=[], **kw)
    assert "availability" not in clean["model"]
    assert all("availability" not in p for p in clean["players"])

    kw["factors"] = build_factors(2026, dvp_fx, env_fx, fc_fx)
    ir_doc = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Injured Reserve",
                   "detail": "No timetable has been set."}], **kw)
    a = ir_doc["players"][0]["availability"]
    assert a["status"] == "IR" and a["class"] == "season"
    assert a["confidence"] == "rule" and a["evidence"] is None
    assert a["weeks_out"] == availability.MIN_WEEKS_OUT
    assert a["out_for_season"] is False
    assert ir_doc["model"]["availability"] == {
        "applied": True, "vocab_version": availability.VOCAB_VERSION,
        "unavailable": 1, "season_ending": 0,
        "min_weeks_rule": availability.MIN_WEEKS_OUT,
        "season_points_removed": a["season_points_lost"]}
    assert "injury_shape" not in ir_doc["model"], "IR is not a multiplier status"
    assert ir_doc["players"][1] == clean["players"][1], "healthy player untouched"

    kw["factors"] = build_factors(2026, dvp_fx, env_fx, fc_fx)
    wk_doc = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Questionable",
                   "detail": None}], **kw)
    a = wk_doc["players"][0]["availability"]
    assert a == {"status": "QUESTIONABLE", "class": "week"}, a
    assert "availability" not in wk_doc["model"], "week shaping blocks nothing"
    assert wk_doc["model"]["injury_shape"] == {"applied": True, "statuses_used": 1}

    kw["factors"] = build_factors(2026, dvp_fx, env_fx, fc_fx)
    susp = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Suspension",
                   "detail": "No length was announced."}], **kw)
    a = susp["players"][0]["availability"]
    assert a == {"status": "SUSPENDED", "class": "season"}, a
    assert "availability" not in susp["model"], "unknown length must claim nothing"
    assert all("avail" not in w for w in susp["players"][0]["weeks"])

    kw["factors"] = build_factors(2026, dvp_fx, env_fx, fc_fx)
    gone_doc = build_weekly_document(
        proj, sched, elos,
        injuries=[{"team": "SFX", "player": "Hurt Guy", "status": "Out",
                   "detail": "He will miss the rest of the season."}], **kw)
    a = gone_doc["players"][0]["availability"]
    assert a["status"] == "OUT" and a["class"] == "season", "text promotes the mechanic"
    assert a["out_for_season"] is True and a["weeks_out"] is None
    assert a["confidence"] == "explicit" and a["evidence"]
    assert a["season_points_lost"] == 200.0
    assert sum(w["pts"] for w in gone_doc["players"][0]["weeks"]) == 0.0
    assert gone_doc["model"]["availability"]["season_ending"] == 1

    # =============================================================================
    # weekly_split_v2 — every factor, its neutral rule, and the invariants.
    # =============================================================================
    # --- model meta ---------------------------------------------------------------
    m = clean["model"]
    assert m["name"] == "weekly_split_v2" and m["tilt_coef"] == TILT_COEF
    assert m["home_coef"] == HOME_COEF and m["estimate"] is True
    assert m["dvp_shrink"] == 0.25 and m["elo_tilt_positions"] == ["QB"]
    assert m["weather"]["pass_dome"] == 1.03 and m["weather"]["rb_wind"] == 0.95
    assert m["venue"] == {"coef": 0.02, "rel_clamp": [-1.0, 2.5]}
    assert m["backtest"] == "data/weekly_backtest.json"
    assert set(m["neutral_counts"]) == set(NEUTRAL_KEYS)

    # --- T: QB only -------------------------------------------------------------
    fx = build_factors(2026, dvp_fx, env_fx, fc_fx)
    flat_elo = {"SFX": 1500.0, "DAL": 1500.0, "GBX": 1500.0}
    for pos in ("RB", "WR", "TE"):
        a = player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None,
                         position=pos, factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
        b = player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None,
                         position=pos, factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
        assert all(abs(x["pts"] - y["pts"]) < 1e-9 for x, y in zip(a, b)), \
            f"{pos} must be untouched by Elo"
    qa = player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None,
                      position="QB", factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
    qb = player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None,
                      position="QB", factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
    assert any(abs(x["pts"] - y["pts"]) > 1e-6 for x, y in zip(qa, qb)), "a QB week moves"
    assert abs(tilt_factor(1580.0, 1470.0) - (1 + 0.5 * 110 / 400)) < 1e-12
    assert tilt_factor(1900.0, 1400.0) == TILT_MAX and tilt_factor(1400.0, 1900.0) == TILT_MIN

    # --- D: half-weight prior blend, shrink 0.25, clamp, neutral -----------------
    r1 = dvp_rates(dvp_fx, 2026, 1)          # nothing of 2026 yet: prior only
    # prior QB allowed per game: DAL 30, SFX 10, GBX 20 -> league 20
    assert abs(r1["DAL"]["QB"] - 1.5) < 1e-9 and abs(r1["SFX"]["QB"] - 0.5) < 1e-9
    r2 = dvp_rates(dvp_fx, 2026, 2)          # week 1 of 2026 now counts at full weight
    # DAL QB: (0.5*60 + 60) / (0.5*2 + 1) = 45; SFX 10; GBX 20 -> league 25
    assert abs(r2["DAL"]["QB"] - 45.0 / 25.0) < 1e-9, r2["DAL"]
    assert abs(dvp_factor(1.5) - 1.125) < 1e-12 and abs(dvp_factor(0.5) - 0.875) < 1e-12
    assert dvp_factor(3.0) == DVP_MAX and dvp_factor(-2.0) == DVP_MIN
    assert dvp_rates(dvp_fx, 2026, 1).get("NOPE") is None
    assert dvp_rates({"seasons": {}}, 2026, 1) == {}
    assert dvp_rates({"seasons": {"2025": {"LA": {"1": {"def": {"QB": 5.0}, "g": 1}}}},
                      "renames": {"LA": "LAR"}}, 2026, 3) == {"LAR": {"QB": 1.0}}, \
        "the feed's LA must read as LAR"
    # the neutral counter: an opponent outside the feed is 1.0 and counted
    fx_n = build_factors(2026, dvp_fx, env_fx, fc_fx)
    sched_n = team_schedule(sched + [{"week": 7, "home": "SFX", "away": "ZZZ"}])
    player_weeks(200.0, "SFX", sched_n, elos, round_dp=None, position="WR", factors=fx_n)
    assert fx_n["counts"]["dvp_neutral_weeks"] == 1, fx_n["counts"]
    assert fx_n["counts"]["venue_flat_weeks"] == 1, "the @GBX week (low_n venue) only"

    # --- W: every multiplier + the neutral rules ----------------------------------
    assert weather_factor("QB", "dome") == (1.03, False)
    assert weather_factor("WR", "closed") == (1.03, False)
    assert weather_factor("TE", "outdoors", 10.0, 5.0) == (0.97, False)
    assert weather_factor("QB", "open", 0.0, 5.0) == (0.97 * 0.97, False), "<= 0 C is cold"
    assert weather_factor("QB", "outdoors", 0.1, 5.0) == (0.97, False)
    assert weather_factor("QB", "outdoors") == (0.97, True), "no forecast: roof only, counted"
    assert weather_factor("QB", "retractable", -10.0, 40.0) == (1.0, False)
    assert weather_factor("QB", None, -10.0, 40.0) == (1.0, False)
    assert weather_factor("RB", "outdoors", -10.0, 24.0) == (0.95, False)
    assert weather_factor("RB", "outdoors", -10.0, 23.9) == (1.0, False)
    assert weather_factor("RB", "outdoors") == (1.0, True)
    assert weather_factor("RB", "dome", 0.0, 50.0) == (1.0, False)
    assert weather_factor("K", "outdoors", -10.0, 40.0) == (1.0, False)
    # through the split: SFX home wk1 (open roof, forecast -3 C, 30 kph)
    fx_w = build_factors(2026, dvp_fx, env_fx, fc_fx)
    player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="WR",
                 factors=fx_w)
    # SFX weeks: 1 home(open, forecast) 3 @DAL(retractable) 4 home(open, forecast)
    # 5 @GBX(dome) 6 home(open, NO forecast) -> exactly one no-forecast week
    assert fx_w["counts"]["weather_no_forecast_weeks"] == 1, fx_w["counts"]
    # the same week for an RB counts the missing forecast too (wind rule needs it)
    fx_r = build_factors(2026, dvp_fx, env_fx, fc_fx)
    player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="RB",
                 factors=fx_r)
    assert fx_r["counts"]["weather_no_forecast_weeks"] == 1
    # the reversed key spelling of the same game is tolerated
    fx_rev = build_factors(2026, dvp_fx, env_fx,
                           {"games": {"2026|1|DAL|SFX": {"temp_c": -3.0, "wind_kph": 30.0}}})
    player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="WR",
                 factors=fx_rev)
    assert fx_rev["counts"]["weather_no_forecast_weeks"] == 2   # wk 4 and wk 6 now

    # --- V: venue rel, clamp, flat fallbacks ------------------------------------
    rel, lam = venue_rel_table(env_fx["venue_hfa"])
    # lam = (40*6 + 40*2 + 4*4) / 84 = 4.0
    assert abs(lam - 4.0) < 1e-9, lam
    assert abs(rel["SFX"] - 1.5) < 1e-9 and abs(rel["DAL"] - 0.5) < 1e-9
    assert "GBX" not in rel, "low_n venue falls to the flat rel = 1.0 at the caller"
    rel2, _ = venue_rel_table({"A": {"games": 10, "avg_home_margin": 40.0},
                               "B": {"games": 10, "avg_home_margin": -30.0}})
    assert rel2["A"] == 2.5 and rel2["B"] == -1.0, "rel clamp [-1.0, 2.5]"
    rel3, lam3 = venue_rel_table({"A": {"games": 10, "avg_home_margin": 0.3},
                                  "B": {"games": 10, "avg_home_margin": 0.3}})
    assert rel3 == {} and lam3 <= VENUE_LAM_MIN, "lam <= 0.3 -> flat everywhere"
    assert venue_rel_table(None) == ({}, 0.0)
    assert abs(venue_factor(1.5, True) - 1.03) < 1e-12
    assert abs(venue_factor(1.5, False) - 0.97) < 1e-12
    assert venue_factor(1.0, True) == 1.0 + HOME_COEF, "rel 1.0 IS the old flat edge"
    fx_v = build_factors(2026, dvp_fx, env_fx, fc_fx)
    player_weeks(200.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="WR",
                 factors=fx_v)
    assert fx_v["counts"]["venue_flat_weeks"] == 1, "the @GBX week (low_n venue)"
    # factors=None is the feed-free split: flat venue, no DvP, no weather
    ff = player_weeks(170.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="WR")
    non_bye_ff = [w["pts"] for w in ff if not w["bye"]]
    assert abs(sum(non_bye_ff) - 170.0) < 1e-9
    assert abs(non_bye_ff[0] / non_bye_ff[1] - 1.02 / 0.98) < 1e-9, "home/away 1.02/0.98"

    # --- the renormalization invariant survives v2 ------------------------------
    for pos in POSITIONS:
        for target in (200.0, 33.3, 0.0):
            v2 = player_weeks(target, "SFX", sched_by_team, elos, round_dp=None,
                              position=pos, factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
            assert abs(sum(w["pts"] for w in v2 if not w["bye"]) - target) < 1e-6
            assert all(w["pts"] == 0.0 for w in v2 if w["bye"])
            assert [set(w) for w in v2] == [{"wk", "opp", "home", "bye", "pts"}] * WEEKS
    v2b = player_weeks(200.0, "SFX", sched_by_team, elos, round_dp=None, position="QB",
                       unavailable_weeks=2, injury_mult=0.55,
                       factors=build_factors(2026, dvp_fx, env_fx, fc_fx))
    assert abs(sum(w["pts"] for w in v2b if not w["bye"]) - 200.0 * 3 / 5) < 1e-9
    assert [w["wk"] for w in v2b if w.get("avail") is False] == [1, 3]
    # loaders: a missing file is neutral, loudly, never an exception
    assert load_dvp("/nonexistent/dvp.json") is None
    assert load_environment("/nonexistent/env.json") is None
    assert load_forecast("/nonexistent/fc.json") is None
    empty = build_factors(2026, None, None, None)
    e = player_weeks(100.0, "SFX", sched_by_team, flat_elo, round_dp=None, position="WR",
                     factors=empty)
    assert empty["counts"] == {"dvp_neutral_weeks": 5, "weather_no_forecast_weeks": 0,
                               "venue_flat_weeks": 5}, empty["counts"]
    assert abs(sum(w["pts"] for w in e if not w["bye"]) - 100.0) < 1e-9

    print("selftest OK: week-shaping preserves the season total, unavailability "
          "reduces it pro-rata, the two never mix, a healthy build is unchanged, "
          "and every weekly_split_v2 factor (DvP, QB-only tilt, weather, venue) "
          "is neutral-by-default and renormalization-safe")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    print(__doc__)
    sys.exit(0)
