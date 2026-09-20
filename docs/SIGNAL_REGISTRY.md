# NFL2026 — Signal Registry

Every factor the platform considers is a **named signal**. The registry lives in
`scripts/signals/registry.py` as `SIGNALS` (name → `{group, weight, description}`) and is
mirrored — every name, all at weight 0.0 — into `data/meta.json`'s `weights` map. The Node
test `signal_registry.test.mjs` reads `data/meta.json` and asserts every name below is present
and set to exactly `0.0`.

## The "enters at weight 0, earns weight only via the optimizer" rule

**Nothing is hand-weighted.** A new idea enters the registry at `weight = 0.0` — it is
*named and computed* but contributes nothing to any projection until the walk-forward optimizer
(`scripts/optimize/optimize_weights.py`) awards it weight, and it is awarded weight only if
doing so beats the current weight vector on held-out log-loss by the NEVER-REGRESS margin
(0.0015). This is the "Dominance started at 0" discipline: no signal gets credit for being
plausible, only for measurably improving out-of-sample loss. On day zero (today) **every
weight is 0.0** — nothing has earned its place yet.

Weights below are the *current fitted* weights. All are `0.0` at scaffold time.

## Player signals

| Signal | Group | Weight | How it is computed |
|---|---|---:|---|
| `prior_perf` | player | 0.0 | Baseline: recent per-game production (points/yards/TDs), recency-weighted from prior seasons + current season to date. |
| `age_curve` | player | 0.0 | Position-specific aging multiplier from `scripts/signals/aging.py` (QB/RB/WR/TE each have their own curve). |
| `injury_status` | player | 0.0 | Current designation (OUT/DOUBTFUL/QUESTIONABLE/PROBABLE/healthy) mapped to an availability + effectiveness discount. |
| `injury_history` | player | 0.0 | Games-missed rate and recurring-injury flags over trailing seasons; a durability prior. |
| `ol_composite_vs_dl` | player | 0.0 | O-line mass/strength + continuity proxy vs the specific D-lines faced (`scripts/signals/ol_dl.py`); scales pass-pro / run-blocking. |
| `target_competition` | player | 0.0 | Teammates who draw targets/touches away from this player (`scripts/signals/targets.py`); a share-of-opportunity discount. |
| `qb_accuracy_delta` | player | 0.0 | Change in the passer's accuracy (CPOE-style proxy) vs the receiver's/back's prior QB — up-weights pass-catchers with better new QBs. |
| `qb_coaching` | player | 0.0 | QB-room / QB-coach quality change affecting passer development and protection reads. |
| `coordinator_change` | player | 0.0 | New OC/DC scheme discontinuity; dampens prior-perf reliability and shifts usage. |
| `head_coach_change` | player | 0.0 | New head coach; team-culture / usage-philosophy discontinuity applied to the whole roster. |
| `scheme_fit` | player | 0.0 | Fit between player archetype and the (possibly new) scheme's role demands. |
| `supporting_cast_delta` | player | 0.0 | Net change in surrounding talent (added/lost teammates) that raises or lowers this player's expected efficiency. |
| `one_on_one_matchup` | player | 0.0 | Projected individual matchup (e.g. WR vs shadow CB, RB vs front-seven) for the specific opponent. |
| `schedule_strength` | player | 0.0 | Strength of position-relevant opposing units across the slate/season. |
| `home_away` | player | 0.0 | Home vs road split adjustment. |
| `indoor_outdoor` | player | 0.0 | Dome/retractable-closed vs open-air baseline effect on production (esp. passing/kicking). |
| `weather` | player | 0.0 | Wind/temp/precip adjustment from `scripts/signals/weather.py`; applied only to outdoor / roof-open games. |
| `rest_days` | player | 0.0 | Days since last game (short week / bye / mini-bye) affecting freshness. |
| `off_field` | player | 0.0 | Suspensions, holdouts, personal-conduct availability risk not captured by injury status. |

## Game signals

| Signal | Group | Weight | How it is computed |
|---|---|---:|---|
| `elo` | game | 0.0 | Team Elo rating differential (with home adjustment) → baseline win probability. |
| `market_spread` | game | 0.0 | Consensus point spread converted to a cover/win probability. |
| `market_moneyline` | game | 0.0 | Consensus moneyline de-vigged to an implied win probability. |
| `market_total` | game | 0.0 | Consensus over/under; informs pace/scoring for parlays and player props. |
| `j5l_composite` | game | 0.0 | The fitted curated+Elo+signal composite score for the matchup. |
| `home_field` | game | 0.0 | Venue-specific home-field advantage (crowd, travel, altitude where relevant). |
| `rest_differential` | game | 0.0 | Difference in rest days between the two teams (e.g. off-bye vs short week). |
| `travel` | game | 0.0 | Distance / time-zone crossing / body-clock burden for the visiting team. |
| `weather_game` | game | 0.0 | Game-level wind/temp/precip effect on total scoring and variance. |
| `injury_impact` | game | 0.0 | Aggregate roster injury burden (weighted by player importance) per side. |

## Market signals (first-class models, not just benchmarks)

| Signal | Group | Weight | How it is computed |
|---|---|---:|---|
| `odds_api` | market | 0.0 | The Odds API consensus lines (spread/ML/total), de-vigged to probabilities. |
| `kalshi` | market | 0.0 | Kalshi event-contract prices → implied probabilities for NFL markets. |
| `polymarket` | market | 0.0 | Polymarket contract prices → implied probabilities where NFL markets exist. |

Markets are treated as **models** in their own right (the hybrid blend typically awards the
market the largest weight), *and* as the baseline every complex model must beat on held-out
log-loss. If nothing beats the market, the market is the model.

## Candidate game FAMILIES (the promotion gate)

Signals above are weighted by the optimizer. A **family** is a different thing: an additive
per-game Elo delta tested by `scripts/promote_signals.py` on the walk-forward gate, adopted
only when it beats the incumbent by more than its own cluster-robust significance threshold.
A family is listed in `APPLIABLE` if and only if `scripts/build_predictions.py` actually calls
its prediction-time reader.

| Family | Appliable | Applied today | What it prices |
|---|---|---|---|
| `qb_depth` | yes | **no (proposal only, R92)** | The owner's QB cascade as one family: a drop when the depth chart's QB1 is Out/Doubtful, a further drop when QB2 is out too, and a term scaled by the measured EPA-per-dropback gap to whoever is actually expected to start (QB3 when both are out). Measured walk-forward in `scripts/backtest_qb_depth.py` -> `data/qb_depth_backtest.json`; see `docs/QB_DEPTH_CASCADE.md`. It **generalises** `qb_out` — at `(scale, 0, 0)` it *is* `qb_out` — so the two are never applied together, and adopting it retires `qb_out`. Verdict on 2022-2025: **none** (QB2-also-out fired twice in four seasons, QB3-or-deeper once).
