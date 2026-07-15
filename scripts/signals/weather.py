"""Stadium roof lookup + weather adjustment.

Two responsibilities:

  1. `roof_for_team(team, teams)` — resolve a team's home-stadium roof state
     (indoor / outdoor / retractable) from the teams fixture (data/fixtures/teams.json,
     owned by Agent 6).
  2. `weather_adjustment(roof, wx, roof_open=None)` — turn a roof state + a weather
     observation into per-facet multiplicative adjustments (passing / kicking / rushing)
     around 1.0.

## The roof gate (why weather is often a no-op)

Weather only matters when the game is actually played in it. A closed dome or a
retractable roof that is CLOSED nullifies wind, cold, and precipitation — the field is
climate-controlled. So:

  * roof == "indoor"      -> always neutral (no weather effect, ever).
  * roof == "retractable" -> neutral UNLESS we know the roof is open (roof_open=True).
                             Absent info, we assume closed (teams close them in bad
                             weather), i.e. neutral — the conservative default.
  * roof == "outdoor"     -> apply the weather adjustment.

## Weather effects (outdoor / roof-open only)

  * **Wind** is the single biggest factor: it degrades the passing game and, above all,
    field-goal / kicking accuracy. Rushing is barely affected (arguably helped as teams
    lean run).
  * **Cold** slightly depresses passing and kicking (ball handling, grip, distance).
  * **Precipitation** (rain/snow) hurts passing and ball security; nudges toward rushing.

Keyed by team via the teams fixture's `roof` field. Stdlib only, deterministic.
"""

# Recognized roof states. Anything unknown is treated as outdoor (the honest worst case:
# don't silently neutralize weather for a stadium we can't classify).
_ROOF_STATES = ("indoor", "outdoor", "retractable")

# Wind thresholds (mph). Below `_WIND_CALM` there is no effect; effect scales up to a cap.
_WIND_CALM = 8.0
_WIND_CAP = 30.0          # winds beyond this are clamped for adjustment purposes
_WIND_PASS_MAX = 0.12     # up to -12% passing at cap wind
_WIND_KICK_MAX = 0.25     # up to -25% kicking at cap wind (kicking is most wind-sensitive)

# Cold thresholds (deg F). Effects start below `_COLD_START`.
_COLD_START = 32.0
_COLD_FLOOR = -5.0        # clamp extreme cold
_COLD_PASS_MAX = 0.06     # up to -6% passing in brutal cold
_COLD_KICK_MAX = 0.08     # up to -8% kicking

# Precipitation: treated as a boolean-ish intensity in [0,1] (0 dry, 1 heavy).
_PRECIP_PASS_MAX = 0.08   # up to -8% passing in heavy precip
_PRECIP_RUSH_MAX = 0.03   # up to +3% rushing (game-script shift toward the run)


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _teams_index(teams):
    """Normalize the teams fixture into an {abbrev: record} dict.

    Tolerant to the two most likely shapes Agent 6 might emit:
      * {"teams": [ {"abbrev": "ARI", "roof": ...}, ... ]}
      * {"ARI": {"roof": ...}, ...}  (already keyed by abbrev)
    Returns {} for anything unrecognized rather than raising.
    """
    if not teams:
        return {}
    if isinstance(teams, dict) and "teams" in teams and isinstance(teams["teams"], list):
        idx = {}
        for rec in teams["teams"]:
            ab = rec.get("abbrev") or rec.get("team") or rec.get("abbreviation")
            if ab:
                idx[str(ab).upper()] = rec
        return idx
    if isinstance(teams, dict):
        # Assume already keyed by abbreviation.
        return {str(k).upper(): v for k, v in teams.items()}
    if isinstance(teams, list):
        idx = {}
        for rec in teams:
            ab = rec.get("abbrev") or rec.get("team") or rec.get("abbreviation")
            if ab:
                idx[str(ab).upper()] = rec
        return idx
    return {}


def roof_for_team(team, teams):
    """Return the roof state ('indoor'|'outdoor'|'retractable') for `team`.

    team  : nflverse team abbreviation (e.g. 'ARI').
    teams : the parsed teams fixture (see _teams_index for accepted shapes).

    Unknown team or missing roof field -> 'outdoor' (conservative: apply weather rather
    than silently ignore it).
    """
    idx = _teams_index(teams)
    rec = idx.get(str(team).upper()) if team else None
    if not rec:
        return "outdoor"
    roof = rec.get("roof")
    if roof in _ROOF_STATES:
        return roof
    return "outdoor"


def weather_adjustment(roof, wx, roof_open=None):
    """Return per-facet weather multipliers around 1.0.

    roof      : 'indoor' | 'outdoor' | 'retractable' (from roof_for_team).
    wx        : dict weather observation, tolerant of missing keys:
                  {"wind_mph": float, "temp_f": float, "precip": float(0..1) or bool}
    roof_open : for retractable roofs, True/False if known; None -> assume closed.

    Returns {"passing": m, "kicking": m, "rushing": m, "applied": bool}. `applied` is
    False when the roof gates out weather entirely (dome / closed retractable).
    """
    neutral = {"passing": 1.0, "kicking": 1.0, "rushing": 1.0, "applied": False}

    # --- Roof gate ---------------------------------------------------------
    if roof == "indoor":
        return neutral
    if roof == "retractable" and not roof_open:
        # Unknown or explicitly closed -> climate controlled -> neutral.
        return neutral
    # outdoor, or retractable known-open: weather applies.

    if not wx:
        # Outdoor but no observation -> neutral, but flag that weather WOULD apply.
        n = dict(neutral)
        n["applied"] = True
        return n

    wind = wx.get("wind_mph")
    temp = wx.get("temp_f")
    precip = wx.get("precip")

    pass_mult = 1.0
    kick_mult = 1.0
    rush_mult = 1.0

    # --- Wind (dominant factor, worst for kicking) -------------------------
    if wind is not None and wind > _WIND_CALM:
        span = _WIND_CAP - _WIND_CALM
        frac = _clamp((float(wind) - _WIND_CALM) / span, 0.0, 1.0)
        pass_mult *= (1.0 - _WIND_PASS_MAX * frac)
        kick_mult *= (1.0 - _WIND_KICK_MAX * frac)

    # --- Cold --------------------------------------------------------------
    if temp is not None and temp < _COLD_START:
        span = _COLD_START - _COLD_FLOOR
        frac = _clamp((_COLD_START - float(temp)) / span, 0.0, 1.0)
        pass_mult *= (1.0 - _COLD_PASS_MAX * frac)
        kick_mult *= (1.0 - _COLD_KICK_MAX * frac)

    # --- Precipitation -----------------------------------------------------
    if precip is not None:
        # Accept bool or [0,1] intensity.
        intensity = 1.0 if precip is True else (0.0 if precip is False else _clamp(float(precip), 0.0, 1.0))
        if intensity > 0.0:
            pass_mult *= (1.0 - _PRECIP_PASS_MAX * intensity)
            rush_mult *= (1.0 + _PRECIP_RUSH_MAX * intensity)

    return {
        "passing": pass_mult,
        "kicking": kick_mult,
        "rushing": rush_mult,
        "applied": True,
    }
