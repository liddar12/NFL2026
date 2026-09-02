# Parlay model v2 (R51) — measured, not assumed

Three things changed in `scripts/models/parlay_builder.py`, each one backed by a
number that `scripts/backtest_parlay.py` reproduces from committed fixtures
(`data/fixtures/backtest_weekly/`, nflverse 2019-2025 REG) and writes to
`data/parlay_backtest.json`. The builder reads that file; the gate re-runs the
measurement.

Owner policy, restated because every section below touches a book number: market /
Vegas / Sleeper numbers are never projection inputs. The book's spread is the
handicap a cover leg is evaluated at (the terms of the bet); the closing moneyline
is a yardstick the incumbent is measured beside. Neither reaches a shipped number.

## 1. Spread legs: priced flat at 0.5 (verdict `no_edge`)

**What shipped before.** The R30 cover rule inverted the Elo win probability
through the normal CDF and re-read it at the book's number:

    margin      = Φ⁻¹(p_elo) × 13.5
    P(home cov) = Φ((margin − spread_line_home) / 13.5)

**What the backtest measured (T2)**, walk-forward on 797 resolved 2023-25 games
(pushes excluded, pre-week Elo chained from 2019 with the fitted `game_params`
hfa 45 / k 25 / revert 0.45 from `data/model_tuning.json`):

| metric | shipped cover rule | flat 0.5 |
|---|---|---|
| log-loss | **0.7231** | 0.6931 |
| Brier | 0.2636 | 0.25 |

Pick hit rate by conviction bin (|p − 0.5|): 0.00-0.05 → 47.7% (n 310);
0.05-0.10 → 49.8% (239); 0.10-0.15 → 44.5% (146); 0.15-0.20 → 45.8% (59);
0.20-0.25 → 56.3% (32); bins above n ≤ 6. Break-even at −110 is 52.4%. The rule
carries no information the line does not.

**What the builder does now.** A spread leg is still emitted only when a real
handicap exists (no number, no leg), on the side our model favours, but at
`model_prob = 0.5` exactly. `implied_prob` stays the book's de-vigged cover price,
so the leg's edge is the negative hold and it falls out of the ranking by itself.
The leg carries

    edge_note: "NO EDGE — cover model measured below coin-flip (log-loss 0.7231 vs
                0.6931, 797 games 2023-25); priced flat until a margin model
                clears never-regress"

(the numbers are read from `data/parlay_backtest.json.spread`; the module constant
`_SPREAD_MEASURED` is the fallback when the file is absent). `model_home_margin` /
`model_cover_prob` and the `game_model` import they needed are retired — nothing
else called them. `game_model.prob_from_margin` is untouched.

## 2. Prop legs: calibrated on this week's projected yards (verdict `adopted`)

**What shipped before.** A documented seed, never measured:

    p_seed = clamp(0.5 + 0.4 × (p_team − 0.5), 0.35, 0.65)

**The candidate.** A per-position logistic on the player's projected yards against
the line, with the team win probability as a second feature:

    z = (mu × dvp − line) / sd_pos
    p = sigmoid(a + b·z + c·(p_team − 0.5))

Lines: QB 224.5 pass / RB 59.5 rush / WR 59.5 rec (the builder's seed thresholds).
Fit: Newton iterations, L2 = 0.1 on the two slopes, stdlib only.

**Backtest construction (T3).** Per game per position, the pick is the player on
either roster that week with the highest blended yards per game (prior season at
half weight + current-season weeks < w; ≥ 6 prior games or ≥ 4 current). `dvp` is
the opponent's blended yards allowed to that position ÷ league average, shrunk as
`clamp(1 + 0.5 × (dvp − 1), 0.8, 1.2)`. Residual sd per position is measured on
the fit seasons. Walk-forward folds:

| fold | fit on | seed log-loss | calibrated log-loss | seed hit (>0.5 picks) | calibrated hit (>0.5) | calibrated hit (>0.6) |
|---|---|---|---|---|---|---|
| 2024 | 2023 | 0.6920 | **0.6765** | 56.7% (503) | 62.2% (391) | 68.1% (163) |
| 2025 | 2023-24 | 0.6820 | **0.6705** | 55.8% (500) | 59.9% (491) | 65.3% (216) |

Never-regress rule: adopted iff calibrated log-loss ≤ seed log-loss on **every**
fold. Both folds clear it → `props.verdict.adopted = true`.

**Shipped coefficients** are re-fit on all fixture seasons (2023-2025) — the file
says so (`calibration_note`); that fit is not a measurement, the folds are:

| pos | a | b (z) | c (team) | residual sd |
|---|---|---|---|---|
| QB | −0.128 | +1.147 | +0.936 | 76.7 |
| RB | −0.236 | +1.126 | +1.002 | 38.9 |
| WR | −0.218 | +0.947 | +0.561 | 41.6 |

**Production wiring** (`build_props_by_game`, signature unchanged, new optional
`calibration_path` defaulting to `data/parlay_backtest.json`):

* player choice is unchanged (top `proj_points` per position among both teams, with
  a weekly record);
* `mu` = the player's projected yards THIS WEEK = `league_components[pass_yd |
  rush_yd | rec_yd]` × weekly share, where weekly share = this week's `pts` ÷ the sum
  of non-bye `pts` in the player's `weeks`. The week is `game_pred.week` when the
  record carries one, else the weekly row whose `opp` + `home` flag match the game
  (a divisional rematch differs on the home flag). `data/player_weekly.json` QBs DO
  carry `pass_yd` (verified: e.g. 3694.5 for the first QB record);
* the weekly share already carries the matchup (the weekly split is tilted by Elo
  matchup and home/away), so production uses **dvp = 1**. The backtest's z used an
  explicit 0.5-shrink defence-vs-position multiplier instead — an accepted mismatch,
  to be re-measured next season with a production-shaped feature;
* `model_prob = clamp(sigmoid(a + b·z + c·(p_team − 0.5)), 0.05, 0.95)`;
* the leg carries `pricing: "calibrated"`, `mu`, `sd`, `z`, `line`, `estimate: true`.

**Fallback rules (never silent).**

* Calibration file absent, or the position has no coefficients / residual sd → the
  old seed, `pricing: "seed"`, `estimate_note: "seed pricing — calibration file
  absent"`.
* Calibration present but the player's yards cannot be projected (`league_components`
  key missing, no weekly row for this game, zero season points) → the leg is
  **skipped and counted**; one stderr line per reason. A seed there would be a number
  no model produced.

## 3. Same-game correlations: measured (T4)

Copula-lite `rho = (P(AB) − P(A)P(B)) / sqrt(P(A)(1−P(A))P(B)(1−P(B)))` on resolved
2023-25 games; favourite = the Elo favourite (the side the builder's legs take);
ties and pushes excluded; prop events are the per-game pick's yards vs the line.

| pair | rho | n | pre-R51 prior |
|---|---|---|---|
| favorite ML & favorite cover | **0.71** | 796 | 0.55 |
| QB 225+ & same-team WR 60+ | **0.31** | 497 | 0.45 |
| QB 225+ & same-team RB 60+ | **−0.02** | 404 | 0.20 (default) |
| QB 225+ & opposing WR 60+ | **0.10** | 302 | 0.20 (default, sign-flipped) |
| RB 60+ & his team wins | **0.28** | 814 | 0.25 |

The builder reads `correlations.pairs` + `default_rho` (0.10) from the file. The
module table is the fallback and carries the same measured numbers (0.71 / 0.32 /
0.0 / 0.10 opposing / 0.28). Opposing-side legs: a pair with an explicit opposing
measurement uses it as measured; any other pair flips the sign of its same-side rho
(the R30 rule stays). Dead rows for total-leg pairs were removed — no total leg
exists to combine.

## Moneyline (T1, record only)

No candidate. Incumbent Elo on 815 games (ties excluded): log-loss **0.6368**,
Brier 0.2230 (2023 0.6653 / 2024 0.6108 / 2025 0.6344). The de-vigged closing
moneyline scores 0.6081 / 0.2103 — MEASUREMENT ONLY, labelled as such in the file,
never an input.

## The gate

`python3 scripts/backtest_parlay.py --gate` recomputes everything, writes nothing,
and exits 1 when any of these is true (the world changed and someone must look):

1. `props.verdict.adopted` is false (calibrated regressed against the seed on a fold);
2. `spread.verdict` is not `"no_edge"` (the flat-0.5 premise moved);
3. `data/parlay_backtest.json` is absent, or its `props.calibration`,
   `props.residual_sd` or `correlations.pairs` differ from the recomputed values
   (production would price from stale numbers).

`--selftest` runs a synthetic league (logistic recovery, helper math, contract keys,
a leak check that flips the held-out season's actuals and proves fold-2024 numbers
do not move). Locked by `tests/feature/r51_parlay.test.mjs` (which also runs
`--gate` and asserts exit 0) and `tests/web/r51_parlay.spec.mjs`.

## Known limits, stated plainly

* The fixture seasons are 2023-2025 (2022 feeds priors only). Three seasons is
  enough to show the cover rule has no edge and that the calibrated prop model beats
  the seed; it is not enough to claim the coefficients are stable to the third
  decimal.
* The production `mu` (weekly-share projection) is not the backtest `mu` (blended
  yards per game × explicit DvP). The calibration is adopted on the backtest feature
  and applied to the production one; re-measure with production-shaped features once
  a season of `player_weekly.json` snapshots exists.
* Prop lines are seed thresholds, not book lines; a real prop feed changes the line
  the leg is evaluated at and the calibration must be re-measured at those lines.
* `data/parlays.json` is regenerated by the daily workflow only; until it runs, the
  committed document is pre-R51 (no `edge_note` / `pricing` on its legs).
