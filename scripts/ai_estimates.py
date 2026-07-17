"""Documented, deterministic estimation rules -> data/ai_insights.json.

PROVENANCE — read this before trusting a number: the estimation rules in this
module were AUTHORED BY GENERATIVE AI (Claude, as part of this build). They are
committed, human-readable heuristics — NOT model calls: the runtime never
contacts an LLM, takes no randomness, and re-running over identical inputs
produces byte-identical output. The rules are REGENERABLE via the quarantined
P10 workflow (docs/backlog/epics/P10-llm-signal.md): propose better rules
offline in the P10 quarantine, backtest them, and only then replace the code
here — the product build itself stays deterministic and LLM-free.

Every emitted field carries {value, source, why}:

  source "measured"      the value is a passthrough/normalization of measured
                         2021-2025 history (player_history.json OLS trajectory,
                         environment_model.json per-team cold splits);
  source "ai_estimated"  the value comes from the documented rules below because
                         the measurement does not exist (fewer than 3 observed
                         seasons, no team cold sample, no measured stack data).

THE RULES (each bounded to |value| <= ADJ_BOUND = 0.25):

  1. trajectory_adj — per-year points-trend fraction.
     * >=3 observed seasons (measured): value = slope_pts_per_yr / 200 (200 PPR
       ~= a solid starter season) plus min(0, curve_residual_per_yr) — a player
       declining FASTER than their position age curve is penalized on top of the
       raw slope; outperforming the curve is already in the slope (never
       double-counted). Clamped to +/-0.25.
     * <3 observed seasons (ai_estimated): the position age curve supplies the
       prior. value = age_multiplier(pos, age+1) - age_multiplier(pos, age):
       on the rookie ramp this is POSITIVE and naturally scaled by the
       rookie-floor gap ((1 - rookie_floor) / ramp years); past peak_end it is
       NEGATIVE (the cliff); on the prime plateau, or with age unknown, it is 0
       (neutral — missing data is never a punishment). slope_pts_per_yr =
       value x baseline, where baseline = the latest observed season total,
       else the positional default in POS_BASELINE_PTS.

  2. stack_synergy — extra QB+receiver stack compounding beyond the flat v1
     STACK_BONUS, defaulted BY POSITION PAIR (no measured stack data this
     build, so every synergy is ai_estimated): QB+WR 0.06, QB+TE 0.04. A
     player's value is their best applicable pair (QB/WR -> 0.06, TE -> 0.04);
     RBs do not stack and carry no field.

  3. cold_adj — sub-32F win-percentage delta for the player's TEAM.
     * Team present in environment_model.cold.per_team: PASSTHROUGH of the
       measured delta (source "measured" — it IS measured), clamped to +/-0.25;
       low_n splits stay measured but say so in the why.
     * Dome/retractable home team with no cold sample: the measured
       dome-teams-outdoor-cold GROUP delta applied to the team (source
       "ai_estimated" — group-measured, team-estimated).
     * Anyone else: 0.0 neutral (ai_estimated).
     Each cold_adj also carries `weeks`: the 2026 weeks the team plays at an
     OPEN-AIR, cold-region venue in Nov-Jan (schedule_full.json joined to the
     curated stadium table; neutral/international venues excluded by venue-name
     mismatch) — the Fit Engine names these weeks in its reason line.

build_history.py hook: estimate_trajectory(position=, age=, seasons=) fills the
trajectory for <3-season players in player_history.json (source "ai_estimated").

Standalone: python -m scripts.ai_estimates  (reads committed data/*.json only —
no network). In-pipeline: build_predictions calls run() AFTER the history and
environment blocks so it reads their fresh outputs.
"""

import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.signals import aging  # noqa: E402

DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "ai_insights.json")

ADJ_BOUND = 0.25          # hard bound on every emitted value (contract)
SLOPE_NORM_PTS = 200.0    # PPR points ~= a solid starter season (measured norm)
COLD_MONTHS = (11, 12, 1)  # Nov-Jan — when sub-32F kickoffs actually happen
MIN_PLAYERS = 250         # fewer insights than this = broken join, fail loudly

# Positional season-total baselines (PPR) for players with NO observed season —
# deliberately mid-pool numbers, only used to convert a fractional age-curve
# slope into display pts/yr for rookies.
POS_BASELINE_PTS = {"QB": 250.0, "RB": 180.0, "WR": 170.0, "TE": 120.0}

# Position-pair stack-synergy defaults (rule 2). Value = extra fraction of the
# flat v1 STACK_BONUS a stack with this player is worth. No measured stack data
# exists this build, so these are ai_estimated by definition.
PAIR_SYNERGY = {
    "QB": ("QB+WR", 0.06),   # a QB's best stack pair is his WR1
    "WR": ("QB+WR", 0.06),
    "TE": ("QB+TE", 0.04),   # TE stacks compound less (lower target ceilings)
}


def _clamp(v, bound=ADJ_BOUND):
    return max(-bound, min(bound, float(v)))


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


def _load(name):
    with open(os.path.join(DATA, name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def _baseline_pts(position, seasons):
    """Latest observed season total, else the positional default (rule 1)."""
    observed = [s["pts"] for s in (seasons or []) if s.get("pts", 0) > 0]
    if observed:
        return float(observed[-1])  # seasons are ascending by yr
    return POS_BASELINE_PTS.get(str(position or "").upper(), 150.0)


def estimate_trajectory(position=None, age=None, seasons=None):
    """RULE 1 (<3 seasons) — the build_history.py hook.

    The position age curve supplies the slope prior: value = next-year minus
    this-year age multiplier (rookie ramp => positive, scaled by the
    rookie-floor gap; past the cliff => negative; plateau/unknown age => 0).
    curve_residual_per_yr is 0.0 — the curve IS the estimate, so by definition
    there is no observed deviation from it.
    """
    frac = 0.0
    if age is not None:
        frac = _clamp(aging.age_multiplier(position, float(age) + 1.0)
                      - aging.age_multiplier(position, float(age)))
    base = _baseline_pts(position, seasons)
    return {"slope_pts_per_yr": frac * base, "curve_residual_per_yr": 0.0}


def estimate_stack_synergy(position):
    """RULE 2 — (pair_label, value) for a position, or None (RB: no stack)."""
    return PAIR_SYNERGY.get(str(position or "").upper())


def _trajectory_insight(position, hist_rec):
    """trajectory_adj for one player from their player_history.json record."""
    traj = (hist_rec or {}).get("trajectory") or {}
    seasons = (hist_rec or {}).get("seasons") or []
    n = traj.get("seasons_observed", len(seasons))
    slope = traj.get("slope_pts_per_yr")
    resid = traj.get("curve_residual_per_yr")
    source = traj.get("source")

    if source == "measured" and slope is not None:
        value = _clamp(slope / SLOPE_NORM_PTS + min(0.0, resid or 0.0))
        why = ("OLS slope %+.1f pts/yr over %d seasons; %s age-curve residual "
               "%+.4f/yr (measured 2021-2025)"
               % (slope, n, position, (resid or 0.0)))
        out = {"value": round(value, 4), "source": "measured", "why": why}
    elif source == "ai_estimated" and slope is not None:
        # Invert the rule-1 forward map exactly: frac = slope / baseline.
        value = _clamp(slope / _baseline_pts(position, seasons))
        why = ("fewer than 3 seasons observed (%d) - slope prior %+.1f pts/yr "
               "from the %s age-curve position (AI estimate)"
               % (n, slope, position))
        out = {"value": round(value, 4), "source": "ai_estimated", "why": why}
    else:
        # No history record / trajectory still pending: neutral, and honest.
        value, slope = 0.0, None
        why = ("no usable history trajectory (%d seasons observed) - neutral "
               "prior (AI estimate)" % n)
        out = {"value": 0.0, "source": "ai_estimated", "why": why}
    out["slope_pts_per_yr"] = round(slope, 2) if slope is not None else None
    out["seasons_observed"] = int(n)
    return out


def _cold_weeks_by_team(schedule_games, stadiums):
    """team -> sorted 2026 weeks played at an open-air cold-region venue, Nov-Jan.

    The venue is the HOME team's curated stadium — unless the schedule row's
    venue name disagrees (international/neutral site), in which case the game is
    excluded (we cannot claim a cold venue we did not curate). Retractable roofs
    are excluded too: they close in the cold.
    """
    weeks = {}
    for g in schedule_games:
        stadium = stadiums.get(g.get("home"))
        if not stadium:
            continue
        if g.get("venue") and g["venue"] != stadium.get("venue"):
            continue  # neutral/international site — not the home stadium
        if stadium.get("roof") != "open" or not stadium.get("cold_region"):
            continue
        kick = g.get("kickoff_utc") or ""
        try:
            month = int(kick[5:7])
        except ValueError:
            continue
        if month not in COLD_MONTHS:
            continue
        for team in (g.get("home"), g.get("away")):
            if team:
                weeks.setdefault(team, set()).add(int(g["week"]))
    return {t: sorted(w) for t, w in weeks.items()}


def _cold_insight(team, env, cold_weeks):
    """RULE 3 — cold_adj for one team from environment_model.json."""
    cold = (env or {}).get("cold") or {}
    per_team = cold.get("per_team") or {}
    stadiums = (env or {}).get("stadiums") or {}
    rec = per_team.get(team)
    if rec is not None:
        low = " - low sample, treat gently" if rec.get("low_n") else ""
        why = ("%s won %.0f%% of sub-32F games vs %.0f%% overall "
               "(%d cold game%s, measured 2021-2025)%s"
               % (team, rec["cold_win_pct"] * 100.0, rec["base_win_pct"] * 100.0,
                  rec["cold_games"], "" if rec["cold_games"] == 1 else "s", low))
        out = {"value": round(_clamp(rec["delta"]), 4), "source": "measured",
               "why": why, "n": int(rec["n"])}
    else:
        roof = (stadiums.get(team) or {}).get("roof")
        dome = cold.get("dome_teams_outdoor_cold") or {}
        if roof in ("dome", "retractable") and dome.get("delta") is not None:
            why = ("no team cold sample - dome-teams-outdoor-cold group delta "
                   "applied (%d games group-wide, 2021-2025) (AI estimate)"
                   % dome.get("games", 0))
            out = {"value": round(_clamp(dome["delta"]), 4),
                   "source": "ai_estimated", "why": why,
                   "n": int(dome.get("games", 0))}
        else:
            out = {"value": 0.0, "source": "ai_estimated",
                   "why": "no sub-32F sample for %s 2021-2025 - neutral "
                          "(AI estimate)" % team,
                   "n": 0}
    out["weeks"] = cold_weeks.get(team, [])
    return out


def build_insights_document(projections, history, environment, schedule, now):
    """Pure assembly: the four committed contracts -> ai_insights.json doc."""
    hist_players = (history or {}).get("players") or {}
    cold_weeks = _cold_weeks_by_team((schedule or {}).get("games") or [],
                                     (environment or {}).get("stadiums") or {})

    players = {}
    for proj in projections:
        gid = proj["gsis_id"]
        pos = str(proj.get("position") or "").upper()
        rec = {"trajectory_adj": _trajectory_insight(pos, hist_players.get(gid))}
        synergy = estimate_stack_synergy(pos)
        if synergy is not None:
            pair, value = synergy
            rec["stack_synergy"] = {
                "value": value, "source": "ai_estimated", "pair": pair,
                "why": ("%s stacks compound in spike weeks; position-pair "
                        "default, no measured stack data this build "
                        "(AI estimate)" % pair),
            }
        rec["cold_adj"] = _cold_insight(proj.get("team"), environment, cold_weeks)
        players[gid] = rec

    # Bound discipline: every emitted value must respect the contract bound.
    for gid, rec in players.items():
        for field, ins in rec.items():
            if abs(ins["value"]) > ADJ_BOUND + 1e-9:
                raise ValueError("ai_insights %s.%s value %r exceeds bound %r"
                                 % (gid, field, ins["value"], ADJ_BOUND))

    doc = {
        "updated_utc": now,
        "default": "off",
        "players": players,
        "method_notes": (
            "Estimation rules authored by generative AI (this build) and "
            "regenerable via the quarantined P10 workflow; runtime is "
            "deterministic committed code, never a live model call. "
            "trajectory_adj: measured = OLS slope / 200 PPR plus any negative "
            "age-curve residual; <3 seasons = position age-curve slope prior. "
            "stack_synergy: position-pair defaults (QB+WR 0.06, QB+TE 0.04), "
            "no measured stack data this build. cold_adj: passthrough of the "
            "measured environment_model per-team sub-32F win-pct delta; dome "
            "teams get the measured group delta as an ai_estimated value; "
            "weeks = 2026 Nov-Jan games at open-air cold-region venues. All "
            "values clamped to +/-0.25. Every field carries source "
            "('measured' | 'ai_estimated') and a one-line why. This file only "
            "feeds the TEAM tab's opt-in AI+ toggle (default off) - game "
            "probabilities and meta.json weights are untouched by it."
        ),
    }
    summary = {
        "players": len(players),
        "trajectory_measured": sum(
            1 for r in players.values() if r["trajectory_adj"]["source"] == "measured"),
        "trajectory_estimated": sum(
            1 for r in players.values() if r["trajectory_adj"]["source"] == "ai_estimated"),
        "cold_measured": sum(
            1 for r in players.values() if r["cold_adj"]["source"] == "measured"),
        "with_synergy": sum(1 for r in players.values() if "stack_synergy" in r),
        "teams_with_cold_weeks": len(cold_weeks),
    }
    return doc, summary


def run(now=None, out_path=OUT_PATH):
    """Load the committed inputs, build + write ai_insights.json, return summary.

    Loud by design: a missing/unreadable input raises (build_predictions guards
    the call site and marks the feed degraded); a thin join (< MIN_PLAYERS)
    raises rather than committing a quietly hollow file.
    """
    if now is None:
        import datetime as dt
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    projections = _load("player_projections.json")["players"]
    history = _load("player_history.json")
    environment = _load("environment_model.json")
    schedule = _load("schedule_full.json")

    doc, summary = build_insights_document(projections, history, environment,
                                           schedule, now)
    if summary["players"] < MIN_PLAYERS:
        raise ValueError("ai_insights built only %d players (< %d) - inputs "
                         "look broken, failing loudly" % (summary["players"],
                                                          MIN_PLAYERS))
    _write(out_path, doc)
    print("ai_insights: %(players)d players -> " % summary + out_path
          + " (trajectory measured: %(trajectory_measured)d, ai_estimated: "
            "%(trajectory_estimated)d; cold measured: %(cold_measured)d; "
            "synergy fields: %(with_synergy)d; teams with cold-venue weeks: "
            "%(teams_with_cold_weeks)d)" % summary)
    return summary


if __name__ == "__main__":  # standalone: python -m scripts.ai_estimates
    run()
