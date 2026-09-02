"""Per-position player projection engine.

Produces one record per player matching data/contracts/player_projections.schema.json:

    {gsis_id, name, team, position, proj_points, low, high, signals_used}

## The projection identity

    proj_points = baseline(prior_perf) * PRODUCT over signals of applied(signal)

where `baseline` is the player's recency-weighted prior production (the `prior_perf`
signal, which is the baseline itself), and each other player signal contributes a raw
multiplicative adjustment `adj` around 1.0.

## The "started at 0" gate (leak-safe influence)

Each signal computes an honest raw adjustment, but its INFLUENCE is gated by its fitted
weight from the registry (mirrored in data/meta.json):

    applied(signal) = 1 + weight * (adj - 1)

At weight 0 (day zero — nothing has earned weight yet) applied == 1.0, so every signal
is *computed but neutral*, and `proj_points` collapses to the pure prior-perf baseline
times the... nothing. That is deliberate: a signal earns influence only when the
walk-forward optimizer awards it weight against out-of-sample proof. `signals_used`
therefore lists only signals with non-zero weight that actually moved the projection —
which is [] on day zero, and that is the honest answer.

## The interval

`low`/`high` are a documented +/- band around the point projection, widened by
position volatility (RB/TE noisiest) and by player-specific uncertainty (injury,
extreme age). This is a transparent placeholder for the harness's split-conformal
"safe set" (scripts/harness/conformal.py): once enough resolved player-weeks exist the
optimizer can replace this band with a calibrated conformal interval. We never present
the band as a measured quantity — it is an estimate of spread, labelled as such upstream.

## R49 — the games-normalized baseline and the CANDIDATE estimate

`prior_season_points` is a raw season total, so a player who missed games carried a
shortened season into 2026 (Lamar Jackson, 13 games: 214.86; Brock Purdy, 9 games:
177.38). R49 adds the owner's rule, ONE rule for everyone:

    baseline = prior_ppg * projected_games
    prior_ppg       = recency-weighted (2:1) per-game PPR over the last two prior
                      seasons (games from player_history seasons.games / ESPN statId
                      210 — the same entry that carries the season total)
    projected_games = SEASON_GAMES (17) - absence_weeks, where absence_weeks is a
                      DOCUMENTED expected absence from the availability feed
                      (IR/PUP/NFI/suspension with a stated duration, or the league's
                      4-game IR floor; build_weekly.blocked_week_count is the single
                      definition). Unknown status is NOT a discount.

Every changed number is explainable from the fields carried on the record:
`prior_games`, `prior_ppg`, `projected_games`, `absence_weeks`, `baseline_rule`.

THE GATE MEASURED, THE OWNER DECIDED. scripts/backtest_player.py (walk-forward
2022-2025) measured the rule against the raw total: pooled rank-corr IMPROVES
(+0.019) but pooled MAE REGRESSES (+1.3 pts, every per-game variant tried), so the
never-regress gate did NOT adopt it for the shipped number (SHIPPED_BASELINE_RULE
stays the total for the GATED series). R49 OWNER OVERRIDE (recorded as such in
data/meta.json projection_baseline.shipped): from this release the SHIPPED
projection IS the scenario candidate — SHIPPED_ESTIMATE = "candidate" — and the
gate-conforming number rides on every record as `gated_points/low/high` so the
learning loop keeps scoring gated vs candidate on every resolved week. The
candidate itself:

    candidate_points = (prior_ppg * projected_games) * PRODUCT over raw signals of adj

i.e. every signal compute_raw_signals can compute from the feeds we have, applied
at FULL strength (weight 1), never gated, never adopted — labelled CANDIDATE, with
`candidate_signals` = {name: raw_adj} so each move is auditable, and a +/- one-band
interval (`candidate_low`/`candidate_high`) from the SAME position-volatility +
player-uncertainty machinery as `low`/`high`. The estimate ledger records shipped
and candidate per player-week and the resolver scores both against nflverse
actuals (scripts/build_estimate_ledger.py, scripts/resolve_estimates.py); a signal
earns weight on the shipped number only through the never-regress fit.

Deterministic, stdlib only, reads fixtures (never the network).
"""

import json
import os
import sys

# Make repo-root-relative absolute imports work whether this module is imported as
# `scripts.models.player_projection` or run directly (mirrors the optimizer's pattern).
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from scripts import availability                           # noqa: E402
from scripts.signals.registry import SIGNALS               # noqa: E402
from scripts.signals.aging import age_multiplier           # noqa: E402
from scripts.signals.ol_dl import ol_dl_adjustment         # noqa: E402
from scripts.signals.targets import target_competition     # noqa: E402
from scripts.signals.weather import roof_for_team          # noqa: E402

# Default number of games projected for a fully-available player.
_DEFAULT_GAMES = 17
SEASON_GAMES = 17

# R49 — the two baseline rules (see the module docstring). SHIPPED_BASELINE_RULE is
# the one the GATED series (`gated_points`) uses; the candidate ALWAYS uses
# BASELINE_RULE_PPG. Flipping the gated rule is a never-regress decision:
# scripts/backtest_player.py must show the rule beating the incumbent on BOTH
# pooled MAE and pooled rank-corr first (it does not today — rank-corr up, MAE
# down — recorded in data/player_backtest.json `baseline_gate`).
BASELINE_RULE_TOTAL = "prior_season_points"
BASELINE_RULE_PPG = "prior_ppg_x_projected_games"
SHIPPED_BASELINE_RULE = BASELINE_RULE_TOTAL
# R49 OWNER OVERRIDE of that gate for what SHIPS: "gated" makes proj_points the
# gate-conforming number; "candidate" (the owner's decision, 2026-09-02) makes
# proj_points/low/high the scenario candidate and keeps the gated number on the
# record as gated_points/low/high (+ gated_rule) so nothing is lost and the loop
# keeps scoring both. Recorded in data/meta.json projection_baseline.shipped.
SHIPPED_ESTIMATE = "candidate"
SHIPPED_MODES = ("gated", "candidate")
OWNER_OVERRIDE_UTC = "2026-09-02T00:00:00Z"
OWNER_OVERRIDE_REASON = ("owner: ship the scenario estimate now; gate keeps scoring "
                         "gated vs candidate")
# The candidate band ships as the interval, so it was CALIBRATED before shipping:
# on the 2024 -> 2025 backtest (scripts/backtest_player.candidate_2025) the raw
# +/- one band covered 0.371 of actuals; multiplied by 2.25 it covers 0.6875
# (~0.68, the one-sd target). Measured 2026-09-02 over 240 player-seasons.
CANDIDATE_BAND_MULTIPLIER = 2.25
CANDIDATE_BAND_TARGET = 0.68
# Recency weights over prior seasons, most recent FIRST (2:1 over the last two).
RECENCY_WEIGHTS = (2.0, 1.0)
# The signals compute_raw_signals has a branch for (MEASURED by backtest_player's
# probe; listed here so meta.projection_baseline can name what the candidate could
# not compute without hardcoding it in a second place).
IMPLEMENTED_SIGNALS = ("age_curve", "ol_composite_vs_dl", "target_competition",
                       "injury_status", "injury_history", "indoor_outdoor")
CANDIDATE_SD_RULE = ("+/- %.2f x band around candidate_points, band = position "
                     "volatility (QB .14 / RB .22 / WR .20 / TE .24) + 0.06 for an "
                     "unresolved or long-term injury tag + 0.04 for a >25%% missed-games "
                     "history + half the age-curve move, clamped to [0.05, 0.60]; the "
                     "multiplier is calibrated so the 2024->2025 backtest band covers "
                     "~%.2f of actuals (one sd) — an estimate of spread, not a measurement"
                     % (CANDIDATE_BAND_MULTIPLIER, CANDIDATE_BAND_TARGET))

# Position-relative base interval half-width (fraction of the point projection). RB and
# TE are the noisiest fantasy positions week to week and season to season; QB the most
# stable. These are transparent priors, not fitted — see module docstring.
_POSITION_BAND = {"QB": 0.14, "RB": 0.22, "WR": 0.20, "TE": 0.24}

# Injury-status -> (availability, effectiveness) discount. Availability scales games
# played; effectiveness scales per-game output when they do play. ACTIVE == neutral.
#
# REL17 (F4/F6): keyed on the CANONICAL vocabulary (scripts/availability.CODES), not on
# whatever spelling a feed happened to hand us. The old table was keyed on lower-cased
# free text — "ir" and "pup" were dead keys no feed has ever emitted, while the real
# strings ("injury_reserve" from ESPN's fantasy API, "Injured Reserve" from its site
# API) fell through .get() to the neutral default. That is F6: bands that could never
# fire. Every lookup now goes through normalize_status, so a feed spelling is mapped
# once, in one module, and a spelling nobody mapped stays None.
#
# NFI and SUSPENDED complete the table — they were simply missing before.
#
# This is a RAW adjustment; its influence is gated by the registry weight like every
# other signal (0.0 today), so nothing here moves proj_points until the walk-forward
# optimizer awards weight. How long a player is actually out is a FACT from a feed and
# must not sit behind that gate — it lives in build_weekly's week zeroing instead.
_INJURY_STATUS = {
    availability.ACTIVE: (1.00, 1.00),
    availability.QUESTIONABLE: (0.85, 0.95),
    availability.DOUBTFUL: (0.35, 0.90),
    availability.OUT: (0.00, 1.00),
    availability.IR: (0.00, 1.00),
    availability.PUP: (0.00, 1.00),
    availability.NFI: (0.00, 1.00),
    availability.SUSPENDED: (0.00, 1.00),
}

# Codes whose uncertainty widens the projection interval: a short-term tag nobody has
# resolved yet, and every long-term absence (a return date is a guess until it happens).
_BAND_WIDENING = frozenset({availability.QUESTIONABLE, availability.DOUBTFUL}
                           | availability.SEASON_CLASS)

# indoor_outdoor: season-long production nudge from the player's home environment. Dome
# teams pass in controlled conditions all year; a small passing-game premium for
# QB/WR/TE, negligible for RB. Retractable treated as ~half a dome (often closed).
_INDOOR_BONUS = {"QB": 0.03, "WR": 0.03, "TE": 0.02, "RB": 0.00}


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _weight(name, weights):
    """Fitted weight for a signal: the override map if given, else the registry (0.0)."""
    if weights is not None and name in weights:
        return float(weights[name])
    rec = SIGNALS.get(name)
    return float(rec["weight"]) if rec else 0.0


def _baseline_points(player):
    """Season-long baseline from prior_perf, tolerant to a few fixture field spellings.

    Priority (the BASELINE_RULE_TOTAL rule — the shipped one):
      1. explicit season total: `prior_season_points` / `baseline_points`
      2. per-game * projected games: `prior_points_per_game` * `projected_games`
    Missing everything -> 0.0 (an unknown player projects to nothing, not to a guess).
    """
    for key in ("prior_season_points", "baseline_points"):
        if player.get(key) is not None:
            return float(player[key])
    ppg = player.get("prior_points_per_game")
    if ppg is None:
        ppg = player.get("prior_ppg")
    if ppg is not None:
        games = player.get("projected_games", _DEFAULT_GAMES) or _DEFAULT_GAMES
        return float(ppg) * float(games)
    return 0.0


def baseline_inputs(prior_seasons, absence_weeks=0, season_games=SEASON_GAMES):
    """R49 — the auditable inputs of the games-normalized rule from prior seasons.

    prior_seasons : [{yr, pts, games}] in any order (player_history shape). Only
                    the most recent season and the one before it are used, each
                    only when it carries a positive game count (absent games is
                    unknown, never 17 and never 0).
    absence_weeks : documented expected absence in weeks (0 when none documented).

    Returns {prior_games, prior_ppg, projected_games, prior_ppg_seasons,
             games_missed_rate}. prior_ppg is None (and projected_games None) when
    no usable season exists — the caller then keeps the total rule; unknown is
    not a discount. games_missed_rate is the candidate input of the
    injury_history signal: mean(1 - games/17) over every prior season with a
    game count (the same derivation backtest_player.build_rows uses).
    """
    seasons = sorted([s for s in (prior_seasons or []) if s.get("yr") is not None],
                     key=lambda s: -int(s["yr"]))
    if not seasons:
        return {"prior_games": None, "prior_ppg": None, "projected_games": None,
                "prior_ppg_seasons": [], "games_missed_rate": None}
    last_yr = int(seasons[0]["yr"])
    last = seasons[0]
    prior_games = int(last["games"]) if last.get("games") else None
    used, num, den = [], 0.0, 0.0
    for i, w in enumerate(RECENCY_WEIGHTS):
        yr = last_yr - i
        row = next((s for s in seasons if int(s["yr"]) == yr), None)
        if row is None or not row.get("games") or row.get("pts") is None:
            continue
        g = float(row["games"])
        if g <= 0:
            continue
        num += w * float(row["pts"]) / g
        den += w
        used.append(int(yr))
    played = [s for s in seasons if s.get("games")]
    missed = None
    if played:
        missed = round(sum(max(0.0, 1.0 - float(s["games"]) / season_games)
                           for s in played) / len(played), 4)
    if den <= 0:
        return {"prior_games": prior_games, "prior_ppg": None, "projected_games": None,
                "prior_ppg_seasons": [], "games_missed_rate": missed}
    absence = max(0, int(absence_weeks or 0))
    return {
        "prior_games": prior_games,
        "prior_ppg": round(num / den, 4),
        "projected_games": max(0, season_games - absence),
        "prior_ppg_seasons": used,
        "games_missed_rate": missed,
    }


def baseline_fields(player):
    """The R49 audit fields for one record, from whatever the record carries.

    Order of evidence: an explicit `prior_ppg` on the record; else `prior_seasons`
    ([{yr, pts, games}]); else the single-season pair `prior_season_points` +
    `prior_games`. A record with none of these has prior_ppg None and keeps the
    total rule. `absence_weeks` is read from the record (stamped by
    build_predictions from the availability report); absent means 0.
    """
    absence = max(0, int(player.get("absence_weeks") or 0))
    if player.get("prior_ppg") is not None:
        pg = player.get("prior_games")
        return {"prior_games": int(pg) if pg else None,
                "prior_ppg": round(float(player["prior_ppg"]), 4),
                "projected_games": max(0, SEASON_GAMES - absence),
                "absence_weeks": absence}
    seasons = player.get("prior_seasons")
    if not seasons and player.get("prior_games") and \
            player.get("prior_season_points") is not None:
        seasons = [{"yr": 0, "pts": float(player["prior_season_points"]),
                    "games": int(player["prior_games"])}]
    b = baseline_inputs(seasons, absence_weeks=absence)
    if b["prior_games"] is None and player.get("prior_games"):
        b["prior_games"] = int(player["prior_games"])
    return {"prior_games": b["prior_games"], "prior_ppg": b["prior_ppg"],
            "projected_games": b["projected_games"], "absence_weeks": absence}


def baseline_for_rule(player, rule, fields=None):
    """(baseline_points, rule_actually_applied). The PPG rule falls back to the
    total rule when the per-game rate is unknown — unknown is never a discount."""
    fields = fields or baseline_fields(player)
    if rule == BASELINE_RULE_PPG and fields["prior_ppg"] is not None:
        return float(fields["prior_ppg"]) * float(fields["projected_games"]), rule
    return _baseline_points(player), BASELINE_RULE_TOTAL


def compute_raw_signals(player, ctx=None):
    """Compute each player signal's RAW multiplicative adjustment (around 1.0).

    Returns {signal_name: adj}. Only signals we can compute from the available fixture
    fields get a non-1.0 value; the rest are omitted (treated as neutral 1.0 by the
    caller). This is honest: a signal we lack the feed for contributes nothing rather
    than a fabricated number — and since its weight is 0 anyway, it is doubly neutral.

    ctx : optional context dict, e.g. {"teams": <teams fixture>} for roof lookups.
    """
    ctx = ctx or {}
    pos = str(player.get("position", "")).upper()
    adjustments = {}

    # age_curve -----------------------------------------------------------
    age = player.get("age")
    if age is not None:
        adjustments["age_curve"] = age_multiplier(pos, age)

    # ol_composite_vs_dl --------------------------------------------------
    ol = player.get("ol")  # {mass_lbs_avg, strength_grade, continuity_games}
    if ol:
        dl_faced = player.get("dl_faced")  # dict or list of {strength_grade, mass_lbs_avg}
        adjustments["ol_composite_vs_dl"] = ol_dl_adjustment(ol, dl_faced, position=pos)

    # target_competition (skill positions only) --------------------------
    if pos in ("RB", "WR", "TE"):
        own_share = player.get("team_target_share")
        teammate_shares = player.get("teammate_shares")
        if own_share is not None or teammate_shares:
            tc = target_competition(own_share, teammate_shares or [])
            adjustments["target_competition"] = tc["multiplier"]

    # injury_status -------------------------------------------------------
    # Normalize first: UNKNOWN IS NOT HEALTHY, but it is not a discount either — an
    # unmapped spelling leaves the signal unset (no claim), and the loud complaint
    # about the drift belongs at the scraper boundary and at the gate.
    code = availability.normalize_status(player.get("injury_status"))
    if code:
        avail, effect = _INJURY_STATUS.get(code, (1.0, 1.0))
        if baseline_fields(player)["prior_ppg"] is not None:
            # R49 — a games-normalized record already carries its DOCUMENTED
            # absence in projected_games (the same report, the same week rule as
            # build_weekly), so the availability half here would count it twice
            # — and at full strength (the candidate ships, owner override) an
            # IR tag or a one-week "Out" would zero a whole season. Only the
            # effectiveness half remains; an undocumented status is no discount.
            adjustments["injury_status"] = effect
        else:
            # Season projection scales by BOTH availability (games) and effectiveness.
            adjustments["injury_status"] = avail * effect

    # injury_history (durability prior) -----------------------------------
    missed_rate = player.get("games_missed_rate")  # fraction of games missed, trailing
    if missed_rate is not None:
        # A durable player (0 missed) is neutral; chronic absences discount the season.
        adjustments["injury_history"] = 1.0 - 0.5 * _clamp(float(missed_rate), 0.0, 1.0)

    # indoor_outdoor ------------------------------------------------------
    teams = ctx.get("teams")
    if teams is not None and player.get("team"):
        roof = roof_for_team(player["team"], teams)
        if roof == "indoor":
            adjustments["indoor_outdoor"] = 1.0 + _INDOOR_BONUS.get(pos, 0.0)
        elif roof == "retractable":
            adjustments["indoor_outdoor"] = 1.0 + 0.5 * _INDOOR_BONUS.get(pos, 0.0)

    return adjustments


def _interval_band(player, applied_signals):
    """Half-width of the projection interval as a fraction of the point estimate.

    Base = position volatility. Widened for known uncertainty drivers (injury flags,
    extreme age past the prime plateau). Transparent prior, not a measured quantity.
    """
    pos = str(player.get("position", "")).upper()
    band = _POSITION_BAND.get(pos, 0.20)

    # Injury uncertainty widens the interval. Canonical codes only (Rel17): an
    # unmapped or absent status is NEUTRAL — we do not widen on ignorance, and we
    # certainly do not narrow on it.
    if availability.normalize_status(player.get("injury_status")) in _BAND_WIDENING:
        band += 0.06
    if player.get("games_missed_rate", 0) and float(player["games_missed_rate"]) > 0.25:
        band += 0.04

    # Age uncertainty: a steep age adjustment (either way) means more spread.
    age_adj = applied_signals.get("age_curve", 1.0)
    band += 0.5 * abs(1.0 - age_adj)

    return _clamp(band, 0.05, 0.60)


def project_player(player, ctx=None, weights=None, baseline_rule=None, mode=None):
    """Project one player. Returns a record valid vs player_projections.schema.json.

    player  : a player fixture record (see field usage in compute_raw_signals /
              _baseline_points). Required for output: gsis_id, name, team, position.
    ctx     : optional context (e.g. {"teams": <teams fixture>}).
    weights : optional {signal_name: fitted_weight} override. Defaults to the registry
              weights (all 0.0 at day zero).
    baseline_rule : R49 — which baseline the GATED number uses. Defaults to
              SHIPPED_BASELINE_RULE (the total rule today); the candidate number
              below ALWAYS uses the games-normalized rule.
    mode    : R49 override — "gated" ships the gated number as proj_points,
              "candidate" ships the scenario candidate (default SHIPPED_ESTIMATE).
    """
    pos = str(player.get("position", "")).upper()
    mode = mode or SHIPPED_ESTIMATE
    if mode not in SHIPPED_MODES:
        raise ValueError("mode must be one of %r" % (SHIPPED_MODES,))
    rule = baseline_rule or SHIPPED_BASELINE_RULE
    fields = baseline_fields(player)
    baseline, rule_applied = baseline_for_rule(player, rule, fields)

    raw = compute_raw_signals(player, ctx)

    # Apply each raw adjustment gated by its fitted weight. At weight 0 the applied
    # factor is 1.0 (neutral) no matter how large the raw adjustment is.
    proj = baseline
    signals_used = []
    for name, adj in raw.items():
        w = _weight(name, weights)
        applied = 1.0 + w * (adj - 1.0)
        proj *= applied
        # A signal is "used" only if it carries weight AND actually moved the number.
        if w != 0.0 and applied != 1.0:
            signals_used.append(name)

    band = _interval_band(player, raw)
    low = proj * (1.0 - band)
    high = proj * (1.0 + band)

    # R49 CANDIDATE — the games-normalized baseline times EVERY raw adjustment at
    # full strength, +/- the CALIBRATED band (see CANDIDATE_BAND_MULTIPLIER).
    cand_base, cand_rule = baseline_for_rule(player, BASELINE_RULE_PPG, fields)
    cand = cand_base
    cand_used = []
    for name, adj in raw.items():
        cand *= adj
        if adj != 1.0:
            cand_used.append(name)
    cband = _clamp(band * CANDIDATE_BAND_MULTIPLIER, 0.0, 0.95)
    cand_low, cand_high = cand * (1.0 - cband), cand * (1.0 + cband)

    # What ships. In "candidate" mode (the owner override) the scenario number IS
    # proj_points and the gate-conforming number rides along as gated_*; in
    # "gated" mode the reverse. Both are always on the record.
    if mode == "candidate":
        ship = (cand, cand_low, cand_high, sorted(cand_used), cand_rule)
    else:
        ship = (proj, low, high, sorted(signals_used), rule_applied)

    return {
        "gsis_id": player.get("gsis_id", ""),
        "name": player.get("name", ""),
        "team": player.get("team", ""),
        "position": pos,
        "proj_points": round(ship[0], 2),
        "low": round(ship[1], 2),
        "high": round(ship[2], 2),
        # Sorted for stable, minimal-diff output.
        "signals_used": ship[3],
        "baseline_rule": ship[4],
        "shipped_estimate": mode,
        "gated_points": round(proj, 2),
        "gated_low": round(low, 2),
        "gated_high": round(high, 2),
        "gated_rule": rule_applied,
        "prior_games": fields["prior_games"],
        "prior_ppg": fields["prior_ppg"],
        "projected_games": fields["projected_games"],
        "absence_weeks": fields["absence_weeks"],
        "candidate_baseline": round(cand_base, 2),
        "candidate_points": round(cand, 2),
        "candidate_low": round(cand_low, 2),
        "candidate_high": round(cand_high, 2),
        "candidate_signals": {k: round(float(v), 4) for k, v in sorted(raw.items())},
    }


def project_players(players, ctx=None, weights=None, baseline_rule=None, mode=None):
    """Project a list of player records. Deterministic, order-preserving."""
    return [project_player(p, ctx=ctx, weights=weights, baseline_rule=baseline_rule,
                           mode=mode)
            for p in players]


def load_players(path):
    """Load a players fixture. Accepts {"players": [...]} or a bare list."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        return data.get("players", [])
    return data


def projection_baseline_record(projected, changed_utc, gate=None, fed_default=(),
                               backtest_2025=None):
    """R49 — the data/meta.json `projection_baseline` record (meta.schema.json).

    projected : projection rows (project_player output); the candidate signal
                names are the union actually observed on them, else `fed_default`
                (what the live pipeline declares it feeds) when no row carries any.
    gate      : data/player_backtest.json `baseline_gate` (or None before the
                walk-forward has measured the rule).
    backtest_2025 : data/player_backtest.json `candidate_2025` (gated vs candidate
                MAE and the calibrated band coverage), or None.
    Pure; the caller writes it through scripts/meta_record.
    """
    applied = set()
    for row in projected or []:
        applied |= set((row.get("candidate_signals") or {}).keys())
    if not applied:
        applied = set(fed_default)
    gate = gate or {}
    return {
        "rule": BASELINE_RULE_PPG,
        "season_games": SEASON_GAMES,
        "games_source": "player_history seasons.games (ESPN kona statId 210, the "
                        "same actuals entry as prior_season_points)",
        "absence_source": "data/injuries.json (ESPN injury report, "
                          "scripts/availability.py canonical codes; blocked weeks per "
                          "scripts/build_weekly.blocked_week_count: stated duration, "
                          "out-for-season, or the 4-game IR/PUP/NFI floor)",
        "changed_utc": changed_utc,
        "shipped_rule": SHIPPED_BASELINE_RULE,
        "applies_to": (["proj_points", "candidate_points"]
                       if (SHIPPED_ESTIMATE == "candidate"
                           or SHIPPED_BASELINE_RULE == BASELINE_RULE_PPG)
                       else ["candidate_points"]),
        # R49 OWNER OVERRIDE — recorded as such. The gate verdict above is what
        # the walk-forward measured; this block is what the owner decided ships.
        "shipped": {
            "mode": SHIPPED_ESTIMATE,
            "owner_override": SHIPPED_ESTIMATE == "candidate",
            "decided_utc": OWNER_OVERRIDE_UTC,
            "reason": OWNER_OVERRIDE_REASON,
            "gated_series": "gated_points/gated_low/gated_high (+ gated_rule) on every "
                            "record; the ledger scores shipped, candidate and gated",
            "band_multiplier": CANDIDATE_BAND_MULTIPLIER,
            "backtest_2025": {
                "gated_mae": (backtest_2025 or {}).get("gated_mae"),
                "candidate_mae": (backtest_2025 or {}).get("candidate_mae"),
                "band_coverage_after_calibration": (backtest_2025 or {}).get("band_coverage"),
            },
        },
        "recency_weights": list(RECENCY_WEIGHTS),
        "gate": {
            "adopted_for_shipped": bool(gate.get("adopted_for_shipped", False)),
            "reason": gate.get("reason") or (
                "not yet measured by scripts/backtest_player.py; the shipped rule "
                "stays the total until the walk-forward shows the per-game rule "
                "beating it on BOTH pooled MAE and pooled rank-corr"),
            "pooled_rho_total_rule": gate.get("pooled_rho_total_rule"),
            "pooled_rho_ppg_rule": gate.get("pooled_rho_ppg_rule"),
            "pooled_mae_total_rule": gate.get("pooled_mae_total_rule"),
            "pooled_mae_ppg_rule": gate.get("pooled_mae_ppg_rule"),
            "measured_utc": gate.get("measured_utc") or changed_utc,
        },
        "candidate": {
            "signals_applied": sorted(applied),
            "signals_not_computable": sorted(set(IMPLEMENTED_SIGNALS) - applied),
            "sd_rule": CANDIDATE_SD_RULE,
        },
    }
