"""PROMOTE game-level candidate signals into the game model — NEVER-REGRESS.

v2: the gate now tests candidate FAMILIES, each an additive per-game Elo delta
on top of the incumbent model, walk-forward on seasons 2022-2025:

  environment  venue-specific HFA + cold-weather (residual-fitted; the Rel6
               family, kept under test forever)
  rest         rest-day differential from kickoff dates (nfelo-style: byes and
               short weeks are real, ~0.5 pts documented) — runs offline from
               the committed finals fixtures
  epa_total    rolling EPA margin differential (off EPA/play - def EPA/play,
               shrunk + prev-season blended) — the industry-standard predictive
               core (nfelo/PFF/Sumer all price off EPA)
  epa_pass     pass-only EPA margin (QB-form proxy)

EPA families need data/epa_history.json (built by the weekly backtest workflow
on a GitHub runner — the sandbox proxy 403s nflverse). When the file is absent
those families are SKIPPED with a recorded notice, never faked.

LEAK-FREEDOM (the whole ballgame):
  * Every eval season Y prices games with priors from season Y-1 and features
    computed ONLY from information available before kickoff: residual features
    fit on seasons < Y; EPA features for a week-W game use weeks < W of season
    Y blended with season Y-1; rest days derive from the schedule itself.
  * Rating updates always use the FLAT incumbent hfa — candidate deltas shift
    PRICING only, never the rating trajectory.

ADOPTION (the discipline that makes it self-learning, not self-deluding):
  * Incumbent = flat params + families ALREADY adopted in game_params (their
    features recomputed leak-free at the adopted scales).
  * At most ONE family is adopted per run — the best scale of the best family,
    and only if it beats the incumbent by the same 0.0015 log-loss margin the
    parameter backtest uses. Sequential forward selection, one honest step per
    weekly cron run.
  * --auto-adopt actually writes game_params; without it the run is a dry run
    that records trials only. Every trial is archived either way.
  * The incumbent walk also emits CALIBRATION bins (predicted-prob buckets vs
    actual home-win rates) for the MODEL tab.
"""

import json
import math
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.models import elo as elo_mod  # noqa: E402
from scripts.scrape.stadiums import STADIUMS  # noqa: E402
from scripts.refit import MARGIN  # noqa: E402

DATA = os.path.join(_ROOT, "data")
TUNING_PATH = os.path.join(DATA, "model_tuning.json")
EPA_PATH = os.path.join(DATA, "epa_history.json")
SEASONS = [2021, 2022, 2023, 2024, 2025]
EVAL_SEASONS = [2022, 2023, 2024, 2025]

SHRINK_N = 16                      # residual shrinkage: n/(n+SHRINK_N)
VENUE_SCALES = [0.0, 150.0, 250.0, 350.0]   # Elo per unit mean residual (0 = off)
COLD_SCALES = [0.0, 150.0, 250.0, 350.0]
COLD_MONTHS = (11, 12, 1, 2)       # Nov-Feb kickoffs
COLD_HOMES = frozenset(ab for ab, s in STADIUMS.items()
                       if s.get("cold_region") and s.get("roof") == "open")

REST_SCALES = [0.0, 1.5, 3.0, 4.5, 6.0]     # Elo per day of rest advantage
REST_CLAMP = 7                     # |home_rest - away_rest| capped at a bye's worth
REST_BASELINE = 7                  # first game of a season counts as normal rest

EPA_SCALES = [0.0, 200.0, 350.0, 500.0]     # Elo per unit EPA-margin differential
EPA_N0 = 600                       # plays at which current season outweighs prior

CAL_BINS = 10
_EPS = 1e-12


def load_finals(year):
    with open(os.path.join(DATA, "fixtures", f"finals_{year}.json"), encoding="utf-8") as fh:
        games = json.load(fh)["games"]
    games.sort(key=lambda g: g.get("kickoff_utc") or "")
    return games


def is_cold_game(game):
    """Cold-region open-air home venue with a Nov-Feb kickoff."""
    if game["home"] not in COLD_HOMES:
        return False
    try:
        month = int(str(game["kickoff_utc"])[5:7])
    except (TypeError, ValueError):
        return False
    return month in COLD_MONTHS


def game_params():
    """The adopted incumbent params (backtest adoption) — the bar to beat."""
    with open(TUNING_PATH, encoding="utf-8") as fh:
        tuning = json.load(fh)
    gp = tuning.get("game_params") or {}
    return (float(gp.get("hfa_elo", elo_mod.HFA_ELO)),
            float(gp.get("revert", elo_mod.REVERT)),
            float(gp.get("k", elo_mod.K)),
            tuning)


# --------------------------------------------------------------------------- #
# per-game candidate features                                                 #
# --------------------------------------------------------------------------- #

def _date_ord(kickoff_utc):
    """Kickoff date as an ordinal day number (UTC date part), or None."""
    try:
        import datetime as dt
        return dt.date(int(kickoff_utc[0:4]), int(kickoff_utc[5:7]),
                       int(kickoff_utc[8:10])).toordinal()
    except (TypeError, ValueError):
        return None


def rest_diffs(games):
    """Per-game clamped (home_rest - away_rest) in days, from kickoff dates.

    A team's rest = days since its previous game this season; the season opener
    counts as REST_BASELINE (normal week) so openers contribute no signal.
    """
    last = {}
    diffs = []
    for g in games:
        d = _date_ord(g.get("kickoff_utc"))
        rests = {}
        for side in ("home", "away"):
            team = g[side]
            prev = last.get(team)
            rests[side] = (d - prev) if (d is not None and prev is not None) else REST_BASELINE
        diff = max(-REST_CLAMP, min(REST_CLAMP, rests["home"] - rests["away"]))
        diffs.append(float(diff))
        for side in ("home", "away"):
            if d is not None:
                last[g[side]] = d
    return diffs


class EpaFeatures:
    """Leak-free rolling EPA margins from data/epa_history.json.

    margin(team, season, week) blends this season's weeks < week with the full
    prior season: w = cur_plays/(cur_plays + EPA_N0). kind: 'total' or 'pass'.
    """

    def __init__(self, seasons_doc, kind):
        self.doc = seasons_doc
        self.pp = ("off_pass_plays", "off_pass_epa", "def_pass_plays", "def_pass_epa") \
            if kind == "pass" else ("off_plays", "off_epa", "def_plays", "def_epa")

    def _margin_and_plays(self, sums):
        op, oe, dp, de = sums
        off = (oe / op) if op else 0.0
        dfn = (de / dp) if dp else 0.0
        return off - dfn, op + dp

    def _season_sums(self, season, team, before_week=None):
        weeks = ((self.doc.get(str(season)) or {}).get(team)) or {}
        acc = [0.0, 0.0, 0.0, 0.0]
        kp, ke, kdp, kde = self.pp
        for wk, cell in weeks.items():
            if before_week is not None and int(wk) >= before_week:
                continue
            acc[0] += cell[kp]
            acc[1] += cell[ke]
            acc[2] += cell[kdp]
            acc[3] += cell[kde]
        return acc

    def margin(self, season, team, week):
        cur_m, cur_n = self._margin_and_plays(self._season_sums(season, team, week))
        prev_m, prev_n = self._margin_and_plays(self._season_sums(season - 1, team))
        if not prev_n:
            prev_m = 0.0
        w = cur_n / (cur_n + EPA_N0)
        return w * cur_m + (1.0 - w) * prev_m

    def diff(self, game, season):
        try:
            week = int(game.get("week"))
        except (TypeError, ValueError):
            return 0.0
        return (self.margin(season, game["home"], week)
                - self.margin(season, game["away"], week))

    def has_season(self, season):
        return str(season) in self.doc and len(self.doc[str(season)]) >= 30


def load_epa_features(kind):
    """EpaFeatures or None (file absent / seasons incomplete — SKIP, don't fake)."""
    if not os.path.exists(EPA_PATH):
        return None
    with open(EPA_PATH, encoding="utf-8") as fh:
        doc = (json.load(fh)).get("seasons") or {}
    feats = EpaFeatures(doc, kind)
    if not all(feats.has_season(y) for y in SEASONS):
        return None
    return feats


# --------------------------------------------------------------------------- #
# walk-forward machinery                                                      #
# --------------------------------------------------------------------------- #

def walk_season(games, priors, hfa, k, delta_fn=None, collect_residuals=False,
                calibration=None):
    """Predict-then-update one season. Returns (log_loss_sum, n, residuals).

    delta_fn(game, idx) -> Elo added to hfa for pricing THAT game.
    Rating updates always use the FLAT hfa (see module docstring).
    calibration: optional [n, sum_expected, sum_actual] x CAL_BINS accumulator.
    """
    ratings = dict(priors)
    ll = 0.0
    n = 0
    residuals = []
    for idx, g in enumerate(games):
        h, a = g["home"], g["away"]
        rh = ratings.setdefault(h, elo_mod.INIT)
        ra = ratings.setdefault(a, elo_mod.INIT)
        hfa_eff = hfa + (delta_fn(g, idx) if delta_fn else 0.0)
        p = elo_mod.expected_home(rh, ra, hfa_eff)
        hs, as_ = g["home_score"], g["away_score"]
        if hs != as_:
            actual = 1.0 if hs > as_ else 0.0
            p_c = min(max(p, _EPS), 1.0 - _EPS)
            ll += -(actual * math.log(p_c) + (1.0 - actual) * math.log(1.0 - p_c))
            n += 1
            if collect_residuals:
                p_flat = elo_mod.expected_home(rh, ra, hfa)
                residuals.append((h, actual - p_flat, is_cold_game(g)))
            if calibration is not None:
                b = min(CAL_BINS - 1, int(p_c * CAL_BINS))
                calibration[b][0] += 1
                calibration[b][1] += p_c
                calibration[b][2] += actual
        exp_h = elo_mod.expected_home(rh, ra, hfa)
        if hs > as_:
            actual_h, margin, dw = 1.0, hs - as_, (rh + hfa) - ra
        elif hs < as_:
            actual_h, margin, dw = 0.0, as_ - hs, ra - (rh + hfa)
        else:
            actual_h, margin, dw = 0.5, 1, 0.0
        mult = elo_mod._mov_multiplier(margin, dw)
        delta = k * mult * (actual_h - exp_h)
        ratings[h] = rh + delta
        ratings[a] = ra - delta
    return ll, n, residuals


def features_from_residuals(residual_rows, venue_scale, cold_scale):
    """(venue_delta map, cold_delta) from accumulated training residuals."""
    per_team = {}
    cold_rs = []
    for team, r, cold in residual_rows:
        per_team.setdefault(team, []).append(r)
        if cold:
            cold_rs.append(r)
    venue_delta = {}
    for team, rs in per_team.items():
        m = sum(rs) / len(rs)
        shrink = len(rs) / (len(rs) + SHRINK_N)
        venue_delta[team] = venue_scale * m * shrink
    cold_delta = 0.0
    if cold_rs and cold_scale:
        shrink = len(cold_rs) / (len(cold_rs) + SHRINK_N)
        cold_delta = cold_scale * (sum(cold_rs) / len(cold_rs)) * shrink
    return venue_delta, cold_delta


def _incumbent_family_fns(tuning):
    """Delta builders for families ALREADY adopted in game_params — they are part
    of the incumbent every candidate must now beat. Returns a list of builder
    functions with the same signature as candidate builders."""
    gp = tuning.get("game_params") or {}
    fns = []
    vh = gp.get("venue_hfa") or {}
    ch = gp.get("cold_hfa") or {}
    if vh.get("applied") or ch.get("applied"):
        fns.append(lambda: environment_builder(float(vh.get("scale") or 0.0),
                                               float(ch.get("scale") or 0.0)))
    rh = gp.get("rest_hfa") or {}
    if rh.get("applied"):
        fns.append(lambda: rest_builder(float(rh["scale_per_day"])))
    eh = gp.get("epa_hfa") or {}
    if eh.get("applied"):
        feats = load_epa_features(eh.get("kind") or "total")
        if feats is not None:
            fns.append(lambda: epa_builder(float(eh["scale"]), feats))
    return fns


# Family builders. Each returns (season_setup, delta_fn_factory):
#   season_setup(season, games, training_residuals) -> ctx
#   delta_fn_factory(ctx) -> (game, idx) -> elo_delta
def environment_builder(venue_scale, cold_scale):
    def setup(season, games, training_residuals):
        return features_from_residuals(training_residuals, venue_scale, cold_scale)

    def factory(ctx):
        vd, cd = ctx
        return lambda g, i: vd.get(g["home"], 0.0) + (cd if cd and is_cold_game(g) else 0.0)
    return setup, factory


def rest_builder(scale_per_day):
    def setup(season, games, training_residuals):
        return rest_diffs(games)

    def factory(diffs):
        return lambda g, i: scale_per_day * diffs[i]
    return setup, factory


def epa_builder(scale, feats):
    def setup(season, games, training_residuals):
        return season

    def factory(season):
        return lambda g, i: scale * feats.diff(g, season)
    return setup, factory


def evaluate(builders, hfa, revert, k, finals_by_year, calibration=None):
    """Walk-forward mean log-loss with the given family builders combined
    (their per-game deltas add). Leak-free per the module docstring."""
    total_ll = 0.0
    total_n = 0
    training_residuals = []
    priors = {}
    for yr in SEASONS:
        games = finals_by_year[yr]
        if yr in EVAL_SEASONS:
            fns = []
            for setup, factory in builders:
                fns.append(factory(setup(yr, games, training_residuals)))
            delta_fn = (lambda g, i: sum(fn(g, i) for fn in fns)) if fns else None
            ll, n, res = walk_season(games, priors, hfa, k, delta_fn,
                                     collect_residuals=True, calibration=calibration)
            total_ll += ll
            total_n += n
        else:
            _, _, res = walk_season(games, priors, hfa, k, collect_residuals=True)
        training_residuals.extend(res)
        rated = elo_mod.rate_season(games, hfa=hfa, k=k, initial_ratings=priors)
        priors = elo_mod.revert_to_mean(rated, revert=revert)
    return total_ll / total_n, total_n


# --------------------------------------------------------------------------- #
# main gate run                                                               #
# --------------------------------------------------------------------------- #

def run(auto_adopt=False):
    hfa, revert, k, tuning = game_params()
    finals_by_year = {yr: load_finals(yr) for yr in SEASONS}
    incumbent_builders = [mk() for mk in _incumbent_family_fns(tuning)]

    # Incumbent walk also produces the calibration record for the MODEL tab.
    cal = [[0, 0.0, 0.0] for _ in range(CAL_BINS)]
    inc_loss, inc_n = evaluate(incumbent_builders, hfa, revert, k,
                               finals_by_year, calibration=cal)
    calibration = {
        "seasons": f"{EVAL_SEASONS[0]}-{EVAL_SEASONS[-1]}",
        "n": inc_n,
        "bins": [{"p_lo": round(i / CAL_BINS, 2), "p_hi": round((i + 1) / CAL_BINS, 2),
                  "n": c[0],
                  "expected": round(c[1] / c[0], 4) if c[0] else None,
                  "actual": round(c[2] / c[0], 4) if c[0] else None}
                 for i, c in enumerate(cal)],
    }
    print(f"incumbent log-loss {inc_loss:.5f} over {inc_n} games "
          f"({len(incumbent_builders)} adopted famil{'ies' if len(incumbent_builders) != 1 else 'y'})")

    families = []

    def try_candidate(family, label, params, builder):
        ll, n = evaluate(incumbent_builders + [builder], hfa, revert, k, finals_by_year)
        trial = dict(params)
        trial.update({"log_loss": round(ll, 5), "n": n})
        print(f"  {family:12s} {label:24s} -> log-loss {ll:.5f}")
        return trial

    # environment (venue x cold grid, zero-combo excluded: that IS the incumbent)
    env_trials = []
    for vs in VENUE_SCALES:
        for cs in COLD_SCALES:
            if vs == 0 and cs == 0:
                continue
            env_trials.append(try_candidate(
                "environment", f"venue={vs:.0f} cold={cs:.0f}",
                {"venue_scale": vs, "cold_scale": cs},
                environment_builder(vs, cs)))
    families.append({"family": "environment", "trials": env_trials})

    # rest differential
    rest_trials = [try_candidate("rest", f"scale={s}", {"scale_per_day": s},
                                 rest_builder(s))
                   for s in REST_SCALES if s]
    families.append({"family": "rest", "trials": rest_trials})

    # EPA families (skip loudly when the runner hasn't built the data yet)
    for kind, fam in (("total", "epa_total"), ("pass", "epa_pass")):
        feats = load_epa_features(kind)
        if feats is None:
            print(f"  {fam:12s} SKIPPED: data/epa_history.json absent/incomplete "
                  "(runner-built)")
            families.append({"family": fam, "skipped": True,
                             "reason": "epa_history.json absent or incomplete — "
                                       "built by the weekly backtest workflow"})
            continue
        fam_trials = [try_candidate(fam, f"scale={s:.0f}", {"scale": s},
                                    epa_builder(s, feats))
                      for s in EPA_SCALES if s]
        families.append({"family": fam, "trials": fam_trials})

    # Verdict: best scale per family; adopt at most the single best family.
    best_overall = None
    for fam in families:
        if fam.get("skipped"):
            continue
        best = min(fam["trials"], key=lambda t: t["log_loss"])
        fam["best"] = best
        fam["improvement"] = round(inc_loss - best["log_loss"], 5)
        if best_overall is None or best["log_loss"] < best_overall[1]["log_loss"]:
            best_overall = (fam["family"], best)
    adopt = (best_overall is not None
             and inc_loss - best_overall[1]["log_loss"] > MARGIN)

    import datetime as dt
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {
        "generated_utc": now,
        "kind": "signal_promotion",
        "format": 2,
        "source": "scripts/promote_signals.py walk-forward 2022-2025 "
                  "(environment + rest + epa families)",
        "objective": "log_loss",
        "margin": MARGIN,
        "incumbent_loss": round(inc_loss, 5),
        "incumbent_families": sorted(
            name for name, blk in (tuning.get("game_params") or {}).items()
            if isinstance(blk, dict) and blk.get("applied")),
        "families": families,
        "adopted": bool(adopt),
        "adopted_family": ({"family": best_overall[0], **best_overall[1]}
                           if adopt else None),
        "auto_adopt": bool(auto_adopt),
        "reason": ("cleared never-regress margin" if adopt else
                   "incumbent retained: no family cleared the margin"),
        "calibration": calibration,
    }
    tuning.setdefault("history", []).insert(0, entry)

    if adopt and auto_adopt:
        _write_adoption(tuning, best_overall, hfa, revert, k, finals_by_year, now)
    elif adopt:
        print(f"DRY RUN: {best_overall[0]} would be adopted "
              f"({inc_loss:.5f} -> {best_overall[1]['log_loss']:.5f}) — "
              "run with --auto-adopt to write game_params")
        entry["reason"] = "cleared margin but dry run — game_params unchanged"
        entry["adopted"] = False
        entry["would_adopt"] = {"family": best_overall[0], **best_overall[1]}
        entry["adopted_family"] = None
    else:
        best_txt = (f"best {best_overall[0]} {best_overall[1]['log_loss']:.5f}"
                    if best_overall else "no runnable candidates")
        print(f"RETAINED incumbent ({inc_loss:.5f}); {best_txt} "
              f"(margin {MARGIN})")

    with open(TUNING_PATH, "w", encoding="utf-8") as fh:
        json.dump(tuning, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")
    return entry


def _write_adoption(tuning, best_overall, hfa, revert, k, finals_by_year, now):
    """Write the adopted family's production params into game_params. Production
    features use ALL resolved seasons (training-only fitting is for honest EVAL;
    the shipped prior uses every season, standard walk-forward practice)."""
    family, best = best_overall
    gp = tuning.setdefault("game_params", {})
    if family == "environment":
        all_res = []
        priors = {}
        for yr in SEASONS:
            _, _, res = walk_season(finals_by_year[yr], priors, hfa, k,
                                    collect_residuals=True)
            all_res.extend(res)
            rated = elo_mod.rate_season(finals_by_year[yr], hfa=hfa, k=k,
                                        initial_ratings=priors)
            priors = elo_mod.revert_to_mean(rated, revert=revert)
        vd, cd = features_from_residuals(all_res, best["venue_scale"], best["cold_scale"])
        gp["venue_hfa"] = {"applied": bool(best["venue_scale"]),
                           "scale": best["venue_scale"], "shrink_n": SHRINK_N,
                           "adopted_utc": now,
                           "deltas": {t: round(v, 2) for t, v in sorted(vd.items())}}
        gp["cold_hfa"] = {"applied": bool(best["cold_scale"]),
                          "scale": best["cold_scale"],
                          "delta_elo": round(cd, 2), "adopted_utc": now}
    elif family == "rest":
        gp["rest_hfa"] = {"applied": True, "scale_per_day": best["scale_per_day"],
                          "clamp_days": REST_CLAMP, "baseline_days": REST_BASELINE,
                          "adopted_utc": now}
    elif family in ("epa_total", "epa_pass"):
        gp["epa_hfa"] = {"applied": True,
                         "kind": "pass" if family == "epa_pass" else "total",
                         "scale": best["scale"], "n0_plays": EPA_N0,
                         "adopted_utc": now}
    print(f"ADOPTED {family} {best} into game_params")


def selftest():
    """Feature math on synthetic data — asserts, never touches data/."""
    # rest_diffs: B rests 14 days (bye) into game 3 while A played 7 days ago.
    games = [
        {"home": "A", "away": "B", "kickoff_utc": "2025-09-07T17:00:00Z"},
        {"home": "A", "away": "C", "kickoff_utc": "2025-09-14T17:00:00Z"},
        {"home": "B", "away": "A", "kickoff_utc": "2025-09-21T17:00:00Z"},
        {"home": "C", "away": "A", "kickoff_utc": "2025-09-24T17:00:00Z"},
    ]
    d = rest_diffs(games)
    assert d[0] == 0.0, d          # opener: both at baseline
    assert d[1] == 0.0, d          # A rested 7, C opener-baseline 7
    assert d[2] == 7.0, d          # home B off a bye (14) vs A's 7 -> +7
    assert d[3] == 7.0, d          # home C rested 10 vs A's short-week 3 -> +7 (clamped)

    # EpaFeatures: week-3 margin uses only weeks 1-2 blended with prior season.
    doc = {
        "2024": {"KC": {"18": {"off_plays": 500, "off_epa": 50.0, "off_pass_plays": 300,
                               "off_pass_epa": 45.0, "off_rush_plays": 200, "off_rush_epa": 5.0,
                               "def_plays": 500, "def_epa": -25.0, "def_pass_plays": 300,
                               "def_pass_epa": -20.0, "def_rush_plays": 200, "def_rush_epa": -5.0}}},
        "2025": {"KC": {"1": {"off_plays": 60, "off_epa": 12.0, "off_pass_plays": 40,
                              "off_pass_epa": 10.0, "off_rush_plays": 20, "off_rush_epa": 2.0,
                              "def_plays": 60, "def_epa": 0.0, "def_pass_plays": 40,
                              "def_pass_epa": 0.0, "def_rush_plays": 20, "def_rush_epa": 0.0},
                        "3": {"off_plays": 60, "off_epa": -12.0, "off_pass_plays": 40,
                              "off_pass_epa": -10.0, "off_rush_plays": 20, "off_rush_epa": -2.0,
                              "def_plays": 60, "def_epa": 0.0, "def_pass_plays": 40,
                              "def_pass_epa": 0.0, "def_rush_plays": 20, "def_rush_epa": 0.0}}},
    }
    feats = EpaFeatures(doc, "total")
    # Before week 3: cur = week 1 only (120 plays, margin (12/60 - 0/60)=0.2);
    # prev 2024 full: off 50/500=0.1, def -25/500=-0.05 -> margin 0.15.
    # w = 120/720; margin = w*0.2 + (1-w)*0.15 = 0.15833...
    m = feats.margin(2025, "KC", 3)
    assert abs(m - (120 / 720 * 0.2 + 600 / 720 * 0.15)) < 1e-9, m
    # Leak check: week-3's own plays are EXCLUDED (else margin would drop).
    m_leaky_would_be = feats.margin(2025, "KC", 4)
    assert m_leaky_would_be < m, (m_leaky_would_be, m)
    print("selftest OK: rest clamp + EPA leak-free blending exact")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return None
    return run(auto_adopt="--auto-adopt" in sys.argv)


if __name__ == "__main__":
    main()
