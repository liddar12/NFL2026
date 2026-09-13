# WEATHER HORIZON (R56) — forecast inside 16 days, climatology beyond it

`data/weather_forecast.json` is the prediction-time weather feed for
`weekly_split_v2` (scripts/build_weekly.py) and, through `games` only, for the
game model's adopted `weather_wind` family (scripts/promote_signals.wind_current).
Before R56 it held kickoff-hour forecasts for OPEN-roof home games inside
Open-Meteo's free 16-day horizon and nothing else, so every game more than ~2
weeks out fell to the roof-only factor: 2,962 player-weeks were counted as
`weather_no_forecast_weeks` in the production file on 2026-09-08. R56 widens the
targets to every non-dome home, stamps every row with its source, and adds a
CLIMATOLOGY fallback beyond the horizon — measured against the observed archive
before it was allowed to fire anything.

## The document

Same key format for both row kinds — `"season|week|HOME|AWAY"` (the writer's
order; build_weekly also tolerates the reversed spelling).

| map | row | who reads it |
|---|---|---|
| `games[key]` | `{temp_c, wind_kph, precip_mm, source: "forecast", fetched_utc}` — the kickoff-hour Open-Meteo forecast | build_weekly (weather factor) and promote_signals.wind_current (game model), exactly as before R56 |
| `climatology[key]` | `{temp_c, wind_kph, source: "climatology", n, month, rules}` — the home stadium's mean kickoff-hour temperature and wind for the game's calendar month | build_weekly ONLY. The game model's wind nudge was gated on observed/forecast wind and never on a monthly mean, so climatology is kept out of `games` on purpose rather than fed to a family that never measured it |
| `sources` | `{forecast_days: 16, climatology_min_n: 4, climatology_seasons, climatology_eval_seasons, climatology_stadium_months, climatology_skipped_lt_min_n, counts: {scheduled, forecast, climatology, absent}}` | the labels for every derived number in the file |

A pre-R56 file (`games` only, no `source` stamp) still validates and reads as
forecast rows; the daily workflow (`.github/workflows/daily.yml`) regenerates the
file — it is never hand-edited.

## Rule 1 — the forecast horizon (16 days, every non-dome home)

* Targets: every `STATUS_SCHEDULED` home game of a stadium whose roof is `open`
  or `retractable` in scripts/scrape/stadiums.py (21 + 5 = 26 homes; the 6 domes
  are never a target). Retractable homes are fetched so the cold/wind context
  exists in the file, but **build_weekly keeps retractable neutral (W = 1.0)**:
  the game-day roof state is not knowable from a static table and R56 does not
  invent one.
* Horizon: `within_horizon(kickoff, now, 16)` — from now to the end of the day
  15 days ahead, matching Open-Meteo's `forecast_days=16` (today is day 1). A
  kickoff inside the horizon takes the hour nearest kickoff from one forecast
  call per home (`pick_hour`, shared with the archive builder). A game whose
  fetch failed falls through to Rule 2 like any other game without a row; when
  no fetch at all succeeded the builder exits 1 and keeps the existing file.
* Every forecast row is stamped `source: "forecast"` and `fetched_utc`.

## Rule 2 — climatology beyond the horizon (stadium x month, n >= 4)

* Source: `data/weather_history.json` (Open-Meteo archive, kickoff hour, open-roof
  home games 2021-2025), joined to `data/fixtures/finals_<season>.json` for the
  home team and the kickoff month (UTC). The join accepts either team order in
  the history key, so the climatology never trusts the key's spelling.
* Bucket: (home team, calendar month). Row = mean `temp_c` and mean `wind_kph`
  over the bucket's games, rounded to 0.1, with `n` (games behind the mean) and
  `month`. **A stadium-month with fewer than 4 games gets NO row** — the game is
  absent from both maps and counted in `sources.counts.absent`. Only open
  stadiums have history, so a retractable home never has a climatology row
  (and would be neutral in build_weekly anyway).
* Precedence in build_weekly: a forecast row always wins; a climatology row is
  used only where no forecast row exists (`build_factors` merges the two maps
  with `setdefault`).
* Thresholds are the SAME as for a forecast row — cold `<= 0 C`, wind
  `>= 24 km/h`, multipliers unchanged (`build_weekly.WEATHER`) — but a
  climatology row may only fire the rules its `rules` list admits (Rule 3).

## Rule 3 — the measured guard (what a climatology row may fire)

For every stadium-month with n >= 4 and each rule, the builder measures, on the
observed 2023-2025 games of that stadium-month, how often the rule would have
fired wrongly had the climatology mean been used:

* a rule that does **not** fire at the mean is admitted (it cannot misfire);
* a rule that fires at the mean is admitted only when it was wrong for **at most
  half** of the 2023-2025 games (`wrong * 2 <= n_eval`); wrong more than half the
  time, or fires with no measured games at all, is **withheld**;
* a withheld rule leaves the roof-only factor and is NOT a missing forecast —
  the week still counts as `weather_climatology_weeks`.

Measured on the committed `weather_history.json` (893 games, 105 stadium-months,
**96 stadium-months with n >= 4**, 9 skipped for n < 4, 0 history rows unjoined;
`python3 scripts/build_weather_forecast.py --climatology-table` regenerates the
full table in the appendix):

* **Wind never fires on climatology.** The highest stadium-month mean wind with
  n >= 4 is CLE December at 22.8 km/h, below the 24 km/h threshold, so the
  monthly mean cannot reach the RB wind rule anywhere today. The brief's
  guard ("wrong more than half the time -> cold only") therefore has nothing to
  act on for wind; the threshold is kept at 24 km/h, identical to a forecast
  row, and the guard stays in the builder for the day a refreshed history moves
  a mean over it. Windy games are a per-game phenomenon — 36 of the 530 eval
  games hit 24 km/h in stadium-months whose mean never does — and no monthly
  mean recovers them; that is the honest limit of a climatology.
* **Cold fires for five stadium-months** (mean <= 0 C): BUF-1 (-1.0 C, n=4, wrong 0/1), CHI-12 (-0.3 C, n=12, wrong 5/7), GB-1 (-4.2 C, n=5, wrong 1/2), GB-12 (-1.5 C, n=8, wrong 3/5), PIT-1 (-2.8 C, n=4, wrong 0/2).
  Wrong more than half the time: **CHI-12 (5/7) and GB-12 (3/5) — cold withheld**
  (`rules: ["wind"]`, which never fires, so those rows are roof-only in effect).
  GB-1 at exactly 1/2 is not more than half and stays admitted. Before the
  guard the cold rule on climatology would have fired wrongly 9 times against 8
  cold games it caught on 2023-2025 — a coin flip against roof-only. After the
  guard the admitted rows (BUF-1, GB-1, PIT-1) catch 4 cold games for 1 wrong
  fire, and the 31 other cold games in that window are missed by climatology
  and roof-only alike. Caveats stated plainly: the evaluation window overlaps
  the mean's window (in-sample), and the January buckets rest on 1-2 measured
  games each — the r56 test pins these numbers so a refreshed history forces
  this section to be re-measured, not assumed.

## What build_weekly reports

`data/player_weekly.json` `model.neutral_counts` splits the weather story into
three counts of OUTDOOR player-weeks for the positions the factor reads
(QB/WR/TE/RB): `weather_forecast_weeks` (served from a forecast row),
`weather_climatology_weeks` (served from a climatology row) and the pre-existing
`weather_no_forecast_weeks` (no row: roof-only). Dome and retractable weeks count
in none of them. `model.weather_sources = {"forecast_days": 16,
"climatology_min_n": 4}` labels where the rows came from.

Expected coverage, measured on 2026-09-09 from `data/schedule_full.json` and the
committed history (the daily run will produce the real numbers): of
220 scheduled non-dome home games (43 at retractable homes), 25
are inside the 16-day horizon, 149 beyond it have a climatology row
(149 of the 158 open-roof games beyond the horizon), and
46 are absent (retractable homes with no history, or an open stadium-month
with n < 4 — mostly January and early-September buckets).

## Files

* scripts/build_weather_forecast.py — targets, horizon, climatology table + guard,
  `--selftest` (never fetches), `--climatology-table`
* scripts/build_weekly.py — `load_forecast` / `build_factors` merge, `weather_factor(..., rules=)`,
  the three counts, `WEATHER_SOURCES`
* data/contracts/weather_forecast.schema.json, data/contracts/player_weekly.schema.json
* tests/feature/r56_weather.test.mjs (locks), tests/feature/r51_weekly.test.mjs (moved pin)

## Appendix — climatology hit/miss table (2021-2025 means; 2023-2025 evaluation)

Columns: n = games behind the mean; "fires" = the rule fires at the mean; eval
games = 2023-2025 games in the bucket; obs = eval games that actually met the
threshold; wrong = eval games the rule would have fired on wrongly (shown only
where it fires); rules admitted = what the climatology row may fire.

| Home | Month | n (21-25) | mean temp C | mean wind km/h | cold fires | wind fires | eval games (23-25) | obs <= 0 C | obs >= 24 km/h | cold wrong | wind wrong | rules admitted |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BAL | 1 | 5 | 6.4 | 18.7 | no | no | 2 | 1 | 0 | - | - | cold, wind |
| BAL | 9 | 8 | 22.4 | 9.3 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| BAL | 10 | 11 | 17.3 | 13.6 | no | no | 5 | 0 | 1 | - | - | cold, wind |
| BAL | 11 | 10 | 10.5 | 10.7 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| BAL | 12 | 9 | 4.2 | 13.0 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| BUF | 1 | 4 | -1.0 | 17.2 | yes | no | 1 | 1 | 0 | 0/1 | - | cold, wind |
| BUF | 9 | 9 | 19.4 | 16.3 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| BUF | 10 | 10 | 15.2 | 16.6 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| BUF | 11 | 9 | 7.1 | 16.5 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| BUF | 12 | 11 | 1.6 | 18.3 | no | no | 7 | 3 | 1 | - | - | cold, wind |
| CAR | 9 | 8 | 26.4 | 11.4 | no | no | 4 | 0 | 1 | - | - | cold, wind |
| CAR | 10 | 11 | 21.7 | 14.5 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| CAR | 11 | 11 | 16.2 | 12.5 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| CAR | 12 | 11 | 9.2 | 10.7 | no | no | 7 | 0 | 1 | - | - | cold, wind |
| CHI | 9 | 8 | 21.4 | 14.8 | no | no | 5 | 0 | 1 | - | - | cold, wind |
| CHI | 10 | 10 | 15.3 | 17.0 | no | no | 6 | 0 | 2 | - | - | cold, wind |
| CHI | 11 | 9 | 9.2 | 18.9 | no | no | 6 | 0 | 2 | - | - | cold, wind |
| CHI | 12 | 12 | -0.3 | 20.0 | yes | no | 7 | 2 | 0 | 5/7 | - | wind |
| CIN | 1 | 4 | 2.5 | 12.4 | no | no | 2 | 0 | 1 | - | - | cold, wind |
| CIN | 9 | 8 | 22.8 | 8.5 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| CIN | 10 | 9 | 20.1 | 12.0 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| CIN | 11 | 9 | 12.1 | 9.5 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| CIN | 12 | 12 | 6.6 | 10.2 | no | no | 7 | 3 | 0 | - | - | cold, wind |
| CLE | 9 | 10 | 20.9 | 17.4 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| CLE | 10 | 11 | 15.2 | 20.5 | no | no | 6 | 0 | 2 | - | - | cold, wind |
| CLE | 11 | 9 | 8.7 | 22.1 | no | no | 6 | 0 | 2 | - | - | cold, wind |
| CLE | 12 | 12 | 2.9 | 22.8 | no | no | 8 | 1 | 4 | - | - | cold, wind |
| DEN | 1 | 4 | 6.2 | 6.3 | no | no | 2 | 1 | 0 | - | - | cold, wind |
| DEN | 9 | 8 | 26.1 | 7.7 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| DEN | 10 | 13 | 18.8 | 9.6 | no | no | 8 | 1 | 0 | - | - | cold, wind |
| DEN | 11 | 8 | 13.2 | 9.0 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| DEN | 12 | 10 | 8.8 | 6.8 | no | no | 6 | 1 | 0 | - | - | cold, wind |
| GB | 1 | 5 | -4.2 | 13.5 | yes | no | 2 | 1 | 0 | 1/2 | - | cold, wind |
| GB | 9 | 8 | 21.1 | 12.4 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| GB | 10 | 9 | 12.8 | 12.5 | no | no | 4 | 0 | 0 | - | - | cold, wind |
| GB | 11 | 12 | 3.7 | 13.9 | no | no | 8 | 2 | 0 | - | - | cold, wind |
| GB | 12 | 8 | -1.5 | 11.7 | yes | no | 5 | 2 | 0 | 3/5 | - | wind |
| JAX | 9 | 8 | 27.7 | 11.5 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| JAX | 10 | 13 | 22.7 | 13.5 | no | no | 8 | 0 | 0 | - | - | cold, wind |
| JAX | 11 | 9 | 22.4 | 17.2 | no | no | 4 | 0 | 0 | - | - | cold, wind |
| JAX | 12 | 10 | 18.0 | 13.1 | no | no | 8 | 0 | 0 | - | - | cold, wind |
| KC | 9 | 9 | 28.8 | 13.2 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| KC | 10 | 9 | 19.0 | 13.8 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| KC | 11 | 12 | 9.7 | 12.6 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| KC | 12 | 12 | 4.5 | 15.4 | no | no | 8 | 3 | 0 | - | - | cold, wind |
| MIA | 9 | 9 | 30.0 | 7.8 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| MIA | 10 | 10 | 27.4 | 11.8 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| MIA | 11 | 11 | 25.3 | 9.3 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| MIA | 12 | 10 | 22.6 | 12.5 | no | no | 7 | 0 | 1 | - | - | cold, wind |
| NE | 1 | 5 | 3.6 | 16.3 | no | no | 3 | 2 | 1 | - | - | cold, wind |
| NE | 9 | 9 | 21.5 | 11.6 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| NE | 10 | 11 | 14.2 | 12.1 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| NE | 11 | 9 | 9.7 | 15.2 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| NE | 12 | 9 | 2.3 | 15.2 | no | no | 6 | 2 | 0 | - | - | cold, wind |
| NYG | 1 | 4 | 4.2 | 15.0 | no | no | 2 | 0 | 0 | - | - | cold, wind |
| NYG | 9 | 9 | 22.3 | 12.7 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| NYG | 10 | 10 | 15.9 | 13.7 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| NYG | 11 | 9 | 9.6 | 14.8 | no | no | 5 | 0 | 1 | - | - | cold, wind |
| NYG | 12 | 10 | 6.0 | 15.4 | no | no | 7 | 1 | 0 | - | - | cold, wind |
| NYJ | 9 | 9 | 21.7 | 11.4 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| NYJ | 10 | 10 | 18.3 | 14.9 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| NYJ | 11 | 10 | 12.9 | 13.6 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| NYJ | 12 | 12 | 5.2 | 14.7 | no | no | 7 | 2 | 0 | - | - | cold, wind |
| PHI | 1 | 5 | 3.1 | 11.5 | no | no | 2 | 1 | 0 | - | - | cold, wind |
| PHI | 9 | 7 | 22.5 | 11.2 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| PHI | 10 | 10 | 19.5 | 10.1 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| PHI | 11 | 10 | 10.2 | 14.0 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| PHI | 12 | 10 | 8.4 | 12.1 | no | no | 7 | 1 | 1 | - | - | cold, wind |
| PIT | 1 | 4 | -2.8 | 7.0 | yes | no | 2 | 2 | 0 | 0/2 | - | cold, wind |
| PIT | 9 | 8 | 22.3 | 10.1 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| PIT | 10 | 11 | 14.7 | 11.9 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| PIT | 11 | 10 | 6.2 | 13.9 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| PIT | 12 | 10 | 3.5 | 12.5 | no | no | 6 | 1 | 0 | - | - | cold, wind |
| SEA | 9 | 9 | 19.9 | 10.1 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| SEA | 10 | 12 | 13.9 | 15.6 | no | no | 7 | 0 | 1 | - | - | cold, wind |
| SEA | 11 | 8 | 9.2 | 8.8 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| SEA | 12 | 10 | 6.7 | 15.1 | no | no | 6 | 0 | 1 | - | - | cold, wind |
| SF | 1 | 4 | 13.9 | 13.6 | no | no | 2 | 0 | 0 | - | - | cold, wind |
| SF | 9 | 7 | 23.7 | 16.1 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| SF | 10 | 11 | 24.2 | 13.5 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| SF | 11 | 9 | 16.1 | 7.8 | no | no | 4 | 0 | 0 | - | - | cold, wind |
| SF | 12 | 11 | 12.9 | 7.6 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| TB | 1 | 4 | 22.7 | 9.1 | no | no | 2 | 0 | 0 | - | - | cold, wind |
| TB | 9 | 10 | 29.2 | 8.2 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| TB | 10 | 10 | 26.0 | 11.7 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| TB | 11 | 7 | 25.7 | 11.3 | no | no | 4 | 0 | 0 | - | - | cold, wind |
| TB | 12 | 11 | 20.9 | 11.4 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| TEN | 9 | 9 | 25.8 | 10.8 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| TEN | 10 | 8 | 21.4 | 14.2 | no | no | 5 | 0 | 1 | - | - | cold, wind |
| TEN | 11 | 11 | 13.3 | 14.2 | no | no | 7 | 0 | 0 | - | - | cold, wind |
| TEN | 12 | 12 | 11.4 | 14.0 | no | no | 7 | 0 | 1 | - | - | cold, wind |
| WAS | 1 | 4 | 11.7 | 12.1 | no | no | 1 | 0 | 0 | - | - | cold, wind |
| WAS | 9 | 9 | 23.3 | 8.8 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| WAS | 10 | 10 | 18.5 | 11.0 | no | no | 6 | 0 | 0 | - | - | cold, wind |
| WAS | 11 | 9 | 12.9 | 12.5 | no | no | 5 | 0 | 0 | - | - | cold, wind |
| WAS | 12 | 10 | 7.1 | 12.9 | no | no | 8 | 1 | 0 | - | - | cold, wind |
