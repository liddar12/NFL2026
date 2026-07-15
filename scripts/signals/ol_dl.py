"""O-line-vs-D-line signal: how the blocking matchup scales dependent production.

`ol_dl_adjustment(ol, dl_faced)` returns a per-game multiplicative adjustment around
1.0 that scales the production that DEPENDS on the offensive line — most of all a
running back's rushing yards, but also a quarterback's clean-pocket efficiency and
sack-avoidance.

## Why this matters most for running backs (the RB rationale)

A running back's box-score is arguably the *least* self-determined of the skill
positions. A large share of rushing yards are "yards before contact" — created by the
five linemen opening the hole, not by the back. Two facts drive this signal:

  1. **Mass + strength** win the line of scrimmage. A heavier, stronger O-line that
     out-leverages the D-lines it faces creates more push and more clean holes.
  2. **Continuity** compounds it. Run blocking is a *coordinated* act — combo blocks,
     zone-scheme timing, pass-pro communication. Five linemen who have started many
     games *together* execute far better than the same five talent-for-talent who were
     just thrown together. So we reward the number of games the current starting five
     has played as a unit.

The same adjustment lifts a QB's floor (a clean pocket) but with a smaller coefficient,
because QB production is more self-determined than RB production. Callers pass a
`position` so the engine can scale the effect appropriately.

Stdlib only, deterministic, no I/O.
"""

# How strongly each position's production tracks the O-line-vs-D-line edge.
# RB is the most line-dependent; QB benefits (protection) but less; WR/TE least.
# These are RESPONSIVENESS coefficients on the raw edge, NOT fitted signal weights —
# the fitted weight for `ol_composite_vs_dl` still lives in the registry at 0.0 and is
# applied downstream by player_projection. Here we just compute the raw factor.
_POSITION_SENSITIVITY = {
    "RB": 1.00,   # most line-dependent
    "QB": 0.55,   # protection / clean pocket
    "WR": 0.20,   # mostly downstream of QB time-to-throw
    "TE": 0.30,   # inline TEs also block; modest run-game tie
}

# League-average reference points used to turn raw inputs into z-like edges.
_REF_MASS_LBS = 315.0        # typical starting O-lineman average weight
_REF_STRENGTH = 50.0         # strength/grade proxy on a 0..100 scale, 50 == average
_MASS_SPAN = 15.0            # +/- lbs that maps to a meaningful edge
_STRENGTH_SPAN = 25.0        # +/- grade points that maps to a meaningful edge

# Continuity: games the same five have started together. Full continuity credit caps
# out at a season-ish sample; below that the unit is still "learning to play together".
_CONTINUITY_FULL_GAMES = 16.0

# Caps so a single game's blocking edge can't dominate a season projection.
_MAX_SWING = 0.18  # at most +/-18% before position sensitivity


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _avg(values, default):
    vals = [v for v in values if v is not None]
    if not vals:
        return default
    return sum(vals) / len(vals)


def ol_dl_adjustment(ol, dl_faced, position="RB"):
    """Compute the O-line-vs-D-line adjustment for a player of `position`.

    ol : dict describing the player's offensive line, tolerant of missing fields:
        {
          "mass_lbs_avg":   float,  # avg weight of the starting five (lbs)
          "strength_grade": float,  # 0..100 strength/win-rate proxy, 50 == average
          "continuity_games": int   # games the current five have started together
        }
    dl_faced : the defensive line(s) this player will face. Either
        - a dict {"strength_grade": float, "mass_lbs_avg": float}, or
        - a list of such dicts (a multi-game slate) -> averaged.
    position : "RB"/"QB"/"WR"/"TE"; scales how much the line edge matters.

    Returns a float multiplier around 1.0. Missing inputs degrade to neutral (1.0)
    rather than fabricating an edge.
    """
    if not ol:
        return 1.0

    # --- Offensive line inputs (tolerant to missing keys) ------------------
    ol_mass = ol.get("mass_lbs_avg")
    ol_strength = ol.get("strength_grade")
    continuity_games = ol.get("continuity_games", 0) or 0

    # --- Defensive line faced (normalize dict-or-list to averages) ---------
    if isinstance(dl_faced, dict):
        dl_list = [dl_faced]
    elif isinstance(dl_faced, (list, tuple)):
        dl_list = list(dl_faced)
    else:
        dl_list = []
    dl_strength = _avg([d.get("strength_grade") for d in dl_list], _REF_STRENGTH)
    dl_mass = _avg([d.get("mass_lbs_avg") for d in dl_list], _REF_MASS_LBS)

    # --- Strength edge: OL strength vs the DL strength it faces -------------
    # Positive when the OL is stronger than the fronts it lines up against.
    if ol_strength is None:
        strength_edge = 0.0
    else:
        strength_edge = (ol_strength - dl_strength) / _STRENGTH_SPAN

    # --- Mass edge: OL mass vs DL mass (leverage at the point of attack) ----
    if ol_mass is None:
        mass_edge = 0.0
    else:
        mass_edge = ((ol_mass - _REF_MASS_LBS) - (dl_mass - _REF_MASS_LBS)) / _MASS_SPAN

    # Combine mass + strength. Strength (technique/win-rate) is the better proxy, so it
    # carries more weight than raw mass.
    raw_edge = 0.65 * strength_edge + 0.35 * mass_edge

    # --- Continuity multiplier on the edge ---------------------------------
    # A real edge only fully materializes for a unit that has played together. A shuffled
    # line realizes only a fraction of its paper edge (and a paper DEFICIT is likewise
    # softened, since a bad-on-paper but cohesive unit overperforms). We scale the edge
    # toward its full value as continuity approaches a season of shared starts.
    continuity_frac = _clamp(continuity_games / _CONTINUITY_FULL_GAMES, 0.0, 1.0)
    # Even a brand-new line realizes some of the edge (0.5 floor) — talent still shows.
    continuity_scale = 0.5 + 0.5 * continuity_frac
    effective_edge = raw_edge * continuity_scale

    # --- Turn the edge into a bounded swing, then apply position sensitivity -
    swing = _clamp(effective_edge, -1.0, 1.0) * _MAX_SWING
    sensitivity = _POSITION_SENSITIVITY.get(str(position).upper(), 0.20)
    return 1.0 + swing * sensitivity
