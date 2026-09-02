# weekly_split_v2 — the per-week projection split and its never-regress gate (R51)

`scripts/build_weekly.py` turns each player's season projection into 18 week rows
(`data/player_weekly.json`). v1 split the season evenly, tilted every position by
the Elo matchup and a flat ±0.02 home/away edge, and renormalized. v2 keeps every
v1 invariant and replaces the per-week multiplier with four measured factors.

## The equation

For every non-bye week `wk` of the player's team:

```
base    = season_proj / games_scheduled            (unchanged; usually /17)
pts_raw = base × D × T × W × V
```

then the weeks the player CAN play are renormalized so they sum **exactly** to the
availability-adjusted season target (1e-6). The factors redistribute points across
weeks; they never inflate a season. Bye rows stay `pts 0.0`; injury mechanic (a)
(week-shaping), mechanic (b) (unavailability), `absence_in_total`, `round_dp` and the
row schema `{wk, opp, home, bye, pts, avail?}` are untouched.

| factor | rule | source feed | neutral rule (counted in `model.neutral_counts`) |
|---|---|---|---|
| **D** — opponent DvP, all positions | `F` = opponent's allowed PPR points per game to the player's position: prior season at **half weight** blended (games-weighted) with the current season's weeks `< wk`, divided by the league mean of the same blend. `D = clamp(1 + 0.25 × (F − 1), 0.75, 1.25)` | `data/dvp_positional_history.json` — `seasons[season][team][week] = {"def": {QB,RB,WR,TE}, "g", "off"}`; prior = `season−1`, current = whatever weeks exist for `season`. `LA` → `LAR` via the feed's `renames` | opponent or position absent → `F = 1.0` → `dvp_neutral_weeks` |
| **T** — Elo tilt, **QB only** | `1 + 0.5 × (team_elo − opp_elo) / 400` clamped `[0.75, 1.25]`; RB/WR/TE get `T = 1` | the same preseason/in-season Elo the game model uses | unknown position → `T = 1` |
| **W** — weather | QB/WR/TE: roof `dome`/`closed` ×1.03; `outdoors`/`open` ×0.97, and ×0.97 again when the forecast is ≤ 0 °C; `retractable` 1.0. RB: ×0.95 when outdoors and forecast wind ≥ 24 km/h, else 1.0 | roof: `data/environment_model.json` `stadiums[HOME].roof`; forecast: `data/weather_forecast.json` `games["season|week|HOME|AWAY"] = {temp_c, wind_kph, precip_mm}` (the writer's key order; the reversed spelling is tolerated) | no forecast row on an open-roof game → roof-only factor, never a guessed temperature → `weather_no_forecast_weeks` |
| **V** — venue home field | `m = venue_hfa[HOME].avg_home_margin`, `lam` = games-weighted mean of `avg_home_margin` over all venues, `rel = clamp(m / lam, −1.0, 2.5)`. Home `V = 1 + 0.02 × rel`, away `V = 1 − 0.02 × rel`, both from the **home** team's venue | `data/environment_model.json` `venue_hfa` | `lam ≤ 0.3`, venue missing, or `low_n` → `rel = 1.0` (exactly the old flat ±0.02) → `venue_flat_weeks` |

The three feeds are read **once per document build** through `load_dvp`,
`load_environment`, `load_forecast` (explicit path parameters) and folded into
`build_factors(season, …)`; `player_weeks(…, position=, factors=)` consumes that.
A missing feed is loud on stderr and neutral everywhere — absent data is absent,
never 0. `factors=None` is the feed-free split (D = W = 1, flat venue, tilt for the
tilt positions only), which is what callers without feeds get.

Model meta: `name = "weekly_split_v2"`, `tilt_coef` / `home_coef` kept for
compatibility, plus `dvp_shrink`, `elo_tilt_positions`, `weather`, `venue`,
`neutral_counts`, `backtest`. In preseason `weather_no_forecast_weeks` is large by
construction: the forecast only covers the imminent open-roof games.

## The backtest — `scripts/backtest_weekly.py`

Walk-forward, player-week granularity, on the committed fixtures
`data/fixtures/backtest_weekly/weekly_actuals.json` (nflverse REG weekly actuals
2022-2025, QB/RB/WR/TE ≥ 20 PPR pts in the season) and `games_meta.json` (REG games
2019-2025). Seasons scored 2023-2025; 2025 is the held-out season.

* **Season number, fixed across variants**: recency-weighted prior PPG (weights 1:2
  over S−2, S−1; ≥ 6 stat lines in S−1 required; S−1 alone when S−2 is absent) × 17.
  Pool = top N per position per season by that number among players with a stat
  line in S (QB 32 / RB 60 / WR 80 / TE 32). Rows = the weeks a pooled player has a
  stat line on the team he played most for that season (a traded player's other
  weeks are skipped and counted: `meta.rows_skipped`).
* **v1** = base × Elo tilt (all positions) × flat venue ±0.02, renormalized.
  **v2** = the equation above through the deployed `build_weekly.player_weeks`.
* **Leakage guards** (everything is as-of the week being predicted):
  * Elo: `scripts.models.elo` chained from 2019 with `data/model_tuning.json`
    `game_params` (hfa 45 / k 25 / revert 0.45 as committed), `revert_to_mean`
    between seasons, `rate_season` game by game, snapshotted **before** each week.
  * DvP: prior season at half weight plus the current season's weeks `< wk`; the
    normalizer's other weeks see the same as-of table.
  * Venue: from `games_meta` seasons `< Y` only — per venue mean home margin over
    true home games, shrunk to the league mean with `n0 = 16`. The committed
    `environment_model` numbers (2021-2025) are never read.
  * Weather: the roof/temperature/wind nflverse recorded for the game stand in for
    the unarchived forecast (32 °F / 15 mph → 0 °C / 24 km/h), for the predicted
    week only; the other weeks of the normalizer are roof-only, as in production.
  * The book's spread and moneylines in `games_meta` are never read.
* **Metrics**: MAE; within-(season, week, position) Spearman, n-weighted over groups
  ≥ 5; top-K start efficiency (actual points of the top-K by projection ÷ by actual,
  K = QB 12 / RB 24 / WR 36 / TE 12 capped at half the group); per position; a
  split-conformal 68% band (per-position |residual| quantile from 2023-24, coverage
  and mean half-width on 2025); a paired (season, week) block bootstrap of
  MAE(v2) − MAE(v1) on 2025, B = 400, fixed seed (deterministic artifact).

### Measured (data/weekly_backtest.json, 8,279 rows)

| | v1 MAE / rank_corr / topk | v2 MAE / rank_corr / topk |
|---|---|---|
| pooled 2023-2025 | 6.050 / 0.369 / 0.778 | **6.003 / 0.381 / 0.784** |
| held-out 2025 | 6.111 / 0.341 / 0.761 | **6.079 / 0.352 / 0.769** |
| QB (MAE / rank) | 6.706 / 0.243 | 6.701 / 0.258 |
| RB | 5.932 / 0.423 | 5.892 / 0.429 |
| WR | 6.295 / 0.401 | 6.223 / 0.417 |
| TE | 5.099 / 0.304 | 5.065 / 0.314 |
| 68% band on 2025 (coverage / half-width) | 0.671 / 7.19 | 0.661 / 7.10 |

Bootstrap ΔMAE(v2 − v1) on 2025: mean −0.033, 95% interval [−0.077, +0.015] —
the sign is consistent but the interval spans zero.

Against the offline reference run (pooled v1 6.211 / 0.364 / 0.777, v2 ≈ 6.035 /
0.389 / 0.788): sign and ordering agree on every metric; the effect is smaller here.
Ablation on this harness: the all-position tilt costs ≈ 0.06 MAE (RB 0.02, WR 0.08,
TE 0.03), not the 0.14 the reference measured, and an un-renormalized v1 tilt would
score 6.132 — the reference's v1 was most likely a stronger or un-renormalized tilt.
Also measured and **not** tuned away: a flat split scores 5.994 pooled MAE and
D × W × V without any Elo tilt scores 5.983 / 0.382 (QB rank 0.263 vs 0.258 with the
tilt) — the QB tilt does not help rank order on this corpus. v2 as specified is still
strictly better than v1 on all three pooled metrics, so it ships; dropping the QB
tilt is the next candidate for the gate, not a change made here.

## Never-regress and the gate step

`verdict.adopted` is true iff v2 is not worse than v1 on **pooled MAE and pooled
rank_corr** (`verdict.rule`). `python3 scripts/backtest_weekly.py --gate` recomputes
from the fixtures (writes nothing, ~1.5 s) and exits 1 on a regression, else 0; the
default run writes `data/weekly_backtest.json` in the canonical JSON style;
`--selftest` is synthetic and offline. `tests/feature/r51_weekly.test.mjs` locks every
factor and neutral rule, the renormalization invariant, the artifact contract, that
the committed pooled block reproduces from a fresh run, and the gate's exit code.
`tests/web/r51_weekly.spec.mjs` proves `#/lineup` and `#/grade` still render numeric
weekly cells from the committed data.

Fixtures are refreshed on the runner by `scripts/build_backtest_weekly_corpus.py`
(nflverse `player_stats/stats_player_week_{season}.csv`, `schedules/games.csv`;
REG only; the exact committed formats; loud on any fetch or header drift).
