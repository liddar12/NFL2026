# LEDGER LIVE — R53 / R54

The R49 learning loop (ledger → resolve → fit) was built before a 2026 week
could resolve, so every committed number was an honest zero. R53 proves the
first-week path in the sandbox before nflverse publishes
`stats_player_week_2026.csv`; R54 scores the live 2026 weeks in the weekly
harness beside — never inside — the corpus verdict.

## What runs, in order

| Step | Script | Cadence | Writes |
|---|---|---|---|
| 1 | `scripts/build_estimate_ledger.py` | daily (`daily.yml`) | `data/estimates/2026.json` — per player `first`, `latest`, and `locked[week]` = the estimate frozen at the last as-of before that week's first kickoff |
| 2 | `scripts/resolve_estimates.py` | daily, continue-on-error | `data/estimate_scores.json` + `data/meta.json` `learning_record` |
| 3 | `scripts/fit_player_signals.py --propose` | weekly (`backtest.yml`) | one `player_signal_fit` entry in `data/model_tuning.json` `history` (never a weight) |
| 4 | `scripts/backtest_weekly.py` | weekly | `data/weekly_backtest.json`, now with `live_2026` |

Week 1 kicks off 2026-09-10 00:20Z. The first daily append after that locks
week 1 for all 300 ledger players from the 2026-09-09 estimate; the resolver
then scores week 1 the day nflverse publishes its rows.

## R53 — proving the resolve path before the data exists

### `--dry-run-with <csv> [--ledger <path>]`

```
python3 scripts/resolve_estimates.py --dry-run-with tests/fixtures/r53/stats_player_week_2026_wk1.csv
python3 scripts/resolve_estimates.py --dry-run-with some.csv --ledger /tmp/ledger_locked.json
```

Runs `build_document` — the SAME function `run()` uses on the runner — against
a stats CSV on disk and prints the scores document to stdout. Nothing is
written: not `estimate_scores.json`, not `meta.json`. `--ledger` points the run
at a ledger other than `data/estimates/<season>.json` (the tests lock week 1 on
a copy through the production `append`; the committed ledger has nothing locked
until kickoff and the dry run says so).

### The fixture

`tests/fixtures/r53/stats_player_week_2026_wk1.csv`: 40 committed-ledger
players (8 QB, 12 RB, 14 WR, 6 TE), week 1, `season_type` REG, with the
nflverse column names the resolver reads (`player_display_name`, `position`,
`team`, `week`, `season_type`, `fantasy_points_ppr` and the yard / TD /
reception / fumble / 2-pt component columns) plus three non-ledger rows (a
kicker, a backup, a slot receiver). Every row's `fantasy_points_ppr` equals the
component formula, and a few names use nflverse spellings (`James Cook`,
`Kyle Pitts`) to exercise the normaliser. It is a test fixture, labelled as
such; it never enters `data/`.

### What the document now says

* `unmatched` — every locked ledger player whose name + position joined no
  stats row, listed by `{gsis_id, name, team, position}`; `unmatched_players`
  is its length. A player is never dropped silently.
* `skipped` — when rows exist but nothing resolved, the exact reason: the CSV
  carries other weeks than the locked ones (both lists named), no row is a
  regular-season QB/RB/WR/TE row, or no ledger player joined.
* `meta.learning_record` mirrors the document on the same eleven keys as
  before (`weeks_resolved`, `players_scored`, `mae_ppr`, `bias_ppr`,
  `candidate_mae_ppr`, `candidate_bias_ppr`, `gated_mae_ppr`, `gated_bias_ppr`,
  `band_coverage`, `ledger`, `updated_utc`) and adds `last_proposal`: the latest
  archived fit verdict (`refused` / `propose` / `retain`, folds, reason, run
  date), null until one is archived.

### The fit on one week

`scripts/fit_player_signals.py` needs two resolved weeks for a held-out fold.
With one it still runs, archives `verdict: "refused"` with the reason
("walk-forward needs >= 2 resolved weeks for a held-out fold") and no MAE; with
two (the synthetic in its selftest) it proposes. Nothing ever applies a weight.

### MODEL tab — LEARNING RECORD

At 0 resolved weeks the card keeps its day-zero wording. Once
`weeks_resolved >= 1` it shows weeks resolved, players scored, a SERIES table
(SHIPPED / CANDIDATE / GATED: MAE and bias, the lowest MAE marked ▲), band
coverage, and LAST PROPOSAL with the archived verdict and reason. Every value
comes from `learning_record`'s real keys; a null stays "—".

## R54 — the weekly harness scores live 2026 weeks

`scripts/backtest_weekly.py` writes `live_2026` into `data/weekly_backtest.json`:
the ledger's LOCKED per-player-week estimates (as made, before kickoff) joined
by `(gsis_id, week)` to the resolved actuals in `data/estimate_scores.json`.
Pooled MAE, within-(week, position) rank correlation and top-K for the shipped
series, per week with `n`, plus the same three metrics for `gated` and
`candidate` when every locked row carries them (null otherwise).

Until a week has resolved the block is exactly `{"weeks": 0, "note": ...}` —
no other key, never a fabricated number. The contract
(`data/contracts/weekly_backtest.schema.json`) declares `live_2026` as
OPTIONAL with typed fields and both shapes valid.

**The never-regress verdict stays on the 2023-25 corpus.** `--gate` neither
reads nor is affected by the live block; the live numbers are measured, not
judged. Runtime is unchanged (the corpus run is ~1 s; the join reads two
committed JSON files).

### MODEL tab — LIVE 2026 rows

* WEEKLY SPLIT GATE: a `LIVE 2026` row after the metric table — n weeks and
  rows, shipped MAE and rank corr — with a bench line for shipped / gated /
  candidate and per-week n, or the honest "no week resolved yet — …" line at 0.
  No `live_2026` key (an older file) renders nothing.
* PARLAY GATE: the same, coded to the contract partition C writes into
  `data/parlay_backtest.json`:
  `{"live_2026": {"weeks", "legs_resolved", "seed": {"log_loss", "hit_rate"} | null,
  "calibrated": {...} | null, "refit": {"applied", "fit_weeks", "reason"} | null, "note"}}`
  — weeks, legs, seed → calibrated log-loss, hit rates, a REFIT / NO REFIT chip
  from `refit.applied`, the reason and note; nothing when the key is absent,
  the note when `weeks == 0`.

## Tests

* `tests/feature/r53_ledger_live.test.mjs` — locks week 1 on a ledger copy,
  dry-runs the fixture, and pins every claim above (document, mirror, fit
  refusal / proposal, live block, contracts, card copy).
* `tests/web/r53_model.spec.mjs` — `#/model` with the committed data, and with
  a routed `weekly_backtest.json` / `parlay_backtest.json` carrying `live_2026`.
* Selftests: `resolve_estimates.py`, `build_estimate_ledger.py`,
  `fit_player_signals.py`, `backtest_weekly.py` (`--selftest`).
