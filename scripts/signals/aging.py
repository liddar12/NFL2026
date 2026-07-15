"""Position-specific age curves for QB / RB / WR / TE.

`age_multiplier(position, age)` returns a factor around 1.0 that scales a player's
prior-perf baseline for the effect of aging. 1.0 == the player's positional prime;
< 1.0 == past prime (decline) OR not yet developed (rookie ramp); the curve is highest
across the prime plateau.

## Curve shape (piecewise-linear, deterministic)

Each position gets four knots:

    ramp_start .. peak_start .. peak_end .. (decline)

  * Below `ramp_start`: hard rookie floor — very young players haven't developed.
  * `ramp_start -> peak_start`: linear rise from the rookie floor up to 1.0.
  * `peak_start -> peak_end`: the prime plateau, multiplier == 1.0.
  * Above `peak_end`: linear decline at `decline_per_yr`, clamped at a floor.

The knots encode well-known NFL aging facts:

  * **RB declines earliest and steepest.** Running backs peak young (their bodies take
    the most punishment) and fall off a cliff after ~28 — the "RB cliff". Steepest
    decline rate, earliest peak_end.
  * **QB peaks latest and ages most gracefully.** Quarterbacks rely on processing and
    accuracy, not explosiveness; primes stretch into the early 30s with a gentle
    decline. Latest peak_end, smallest decline rate, but the slowest rookie ramp
    (young QBs are often not ready).
  * **WR** peaks mid-20s with a moderate, later decline than RB.
  * **TE** develops slowest (a big rookie discount — TEs are notoriously slow to
    contribute) and holds a broad, forgiving prime.

All curves are continuous and monotone within each segment, so the function is stable
and easy for the optimizer to reason about. Stdlib only, no randomness.
"""

# Curve knots per position.
#   ramp_start     : age below which the rookie floor applies (still developing)
#   peak_start     : age at which the player reaches full prime (multiplier 1.0)
#   peak_end       : last age of the prime plateau
#   rookie_floor   : multiplier at/below ramp_start (fraction of prime)
#   decline_per_yr : fractional loss per year of age beyond peak_end
#   decline_floor  : lower clamp so ancient players never project to ~0
_CURVES = {
    # RB: earliest peak, steepest decline. The classic RB cliff after 28.
    "RB": {
        "ramp_start": 21,
        "peak_start": 23,
        "peak_end": 27,
        "rookie_floor": 0.90,   # RBs can contribute immediately, small rookie penalty
        "decline_per_yr": 0.06,  # steepest of the four positions
        "decline_floor": 0.45,
    },
    # WR: mid-20s peak, moderate, later decline than RB.
    "WR": {
        "ramp_start": 21,
        "peak_start": 24,
        "peak_end": 29,
        "rookie_floor": 0.82,   # WRs often need a year to develop
        "decline_per_yr": 0.04,
        "decline_floor": 0.50,
    },
    # TE: slowest to develop (largest rookie discount), broad forgiving prime.
    "TE": {
        "ramp_start": 22,
        "peak_start": 26,
        "peak_end": 30,
        "rookie_floor": 0.70,   # TEs are notoriously slow to break out
        "decline_per_yr": 0.035,
        "decline_floor": 0.50,
    },
    # QB: latest peak, gentlest decline, slowest ramp (young QBs often not ready).
    "QB": {
        "ramp_start": 22,
        "peak_start": 27,
        "peak_end": 33,
        "rookie_floor": 0.78,
        "decline_per_yr": 0.025,  # ages most gracefully
        "decline_floor": 0.55,
    },
}


def supported_positions():
    """Positions with a defined age curve."""
    return sorted(_CURVES.keys())


def age_multiplier(position, age):
    """Return the aging multiplier (around 1.0) for `position` at `age`.

    position : one of "QB", "RB", "WR", "TE" (case-insensitive).
    age      : player age in years (int or float). None -> 1.0 (unknown age is neutral,
               never a penalty — we do not punish missing data).

    Unknown positions return 1.0 (neutral) rather than raising: a projection for a
    position we don't yet model should degrade to "no age adjustment", not crash the
    whole pipeline.
    """
    if age is None:
        return 1.0
    if position is None:
        return 1.0

    pos = str(position).upper()
    curve = _CURVES.get(pos)
    if curve is None:
        # Position not modeled (e.g. K, DEF) -> neutral.
        return 1.0

    a = float(age)
    ramp_start = curve["ramp_start"]
    peak_start = curve["peak_start"]
    peak_end = curve["peak_end"]
    floor = curve["rookie_floor"]

    if a <= ramp_start:
        # Very young: flat rookie floor.
        return floor
    if a < peak_start:
        # Rising: linear from rookie_floor (at ramp_start) up to 1.0 (at peak_start).
        frac = (a - ramp_start) / (peak_start - ramp_start)
        return floor + (1.0 - floor) * frac
    if a <= peak_end:
        # Prime plateau.
        return 1.0

    # Declining: lose decline_per_yr for each year past peak_end, clamped at the floor.
    years_past = a - peak_end
    mult = 1.0 - curve["decline_per_yr"] * years_past
    if mult < curve["decline_floor"]:
        mult = curve["decline_floor"]
    return mult
