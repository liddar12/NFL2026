# Parlay-leg ledger, resolver and weekly refit (R58)

R51 measured the parlay pricing rules on the 2023-25 corpus and shipped a
calibrated prop model behind never-regress (`docs/PARLAY_MODEL_V2.md`). R58 closes
the loop on the 2026 season: every leg the builder ships is locked before its
kickoff, scored against what actually happened, and — once enough legs have
resolved — the calibration is re-fit on the corpus plus the live legs and adopted
only if it does not regress. Three scripts, three artifacts, one rule set.

Owner policy, restated because every leg carries a book number: market / Vegas /
Sleeper numbers are never projection inputs. On a leg, `implied_prob` is the
yardstick the leg is measured beside and a spread's handicap is the terms of the
bet it is evaluated at. Neither reaches a number we fit or ship.

## 1. The ledger — `scripts/build_parlay_ledger.py`

Writes `data/estimates/parlays_<season>.json` (canonical JSON, one entry per leg).

| rule | what it means |
|---|---|
| key | `(season, week, game_id, market, selection)` |
| first sight locks | the first append that sees a key records its as-made fields — `mu`, `sd`, `z`, `model_prob`, `implied_prob`, `pricing`, `line`, `kickoff_utc`, `locked_utc` — and no later append ever touches that entry; later runs only add new keys |
| pre-kickoff only | `locked: true` only when the first sight (`parlays.json updated_utc`) precedes the game's `kickoff_utc` (from `game_predictions.json`). A leg first seen at or after kickoff is kept for the record with `locked: false`, `locked_utc: null` and is never scored — the player ledger's rule |
| idempotent per day | the as-of is `parlays.json updated_utc`; a second run on the same build changes no bytes (`runs` records each as-of once) |
| player identity | a prop selection ("T. Henderson 60+ rush yds") is joined to the pool (`player_projections.json`) on the builder's own abbreviation rule (`parlay_builder._abbrev_player`, imported) + the market's position + the game's two teams; unique match -> `player`, `team`, `gsis_id`, `side`, else all null (absent is absent — never a guess) |
| `p_team` | the side's win probability from `game_predictions.json` at lock time, so the seed pricing can be recomputed later on exactly the legs the calibrated model priced |
| game legs | moneyline / spread legs are appended for the record with `team`, `side` and (spread) the handicap in `line` |
| skipped | a leg that names no game on the slate (a week parlay's team missing from `game_predictions`), an unknown market or an unparseable selection is counted in `runs[].skipped`, never invented |

Committed today: the week-1 slate, 72 legs (16 moneyline, 16 spread, 40 props),
all locked at `2026-09-08T10:39:10Z` — every kickoff is later. All 40 prop legs
identified their player.

## 2. The resolver — `scripts/resolve_parlay_legs.py`

Writes `data/parlay_leg_scores.json` (OPTIONAL feed, contract
`data/contracts/parlay_leg_scores.schema.json`).

* **Prop legs** resolve against nflverse `stats_player_week_<season>.csv` — the
  release `scripts/resolve_estimates.py` reads; `fetch_csv` (with its cache) and
  `norm_name` are imported from it, not copied. `hit` = the market's yards
  (`passing_yards` / `rushing_yards` / `receiving_yards`) `>=` the locked line.
  Team abbreviations go through `scripts.scrape.renames.normalize_team` (nflverse
  `LA` -> `LAR`). Join order per leg, restricted to the market's position and the
  game's two teams: the locked full name (exact normalised name, unique), then the
  selection's abbreviation (initial + surname, unique). A week with no rows is
  pending (skipped loudly); a published week where the player has no row is
  `unresolved: no_stat_line`; two candidates is `ambiguous`; a leg with no pool
  identity is `player_unidentified`. **An unresolved leg is never a miss.**
* **Seed vs calibrated on identical legs**: for every resolved prop leg the seed
  (`parlay_builder.seed_prop_prob`, imported) is recomputed from the locked
  `p_team` and scored beside the as-made `model_prob` — same legs, same actuals.
* **Moneyline / spread legs** resolve against FINAL results when a source is
  reachable: a `--finals <json>` file in the shape `scripts.scrape.espn
  .fetch_final_results` returns (the game ledger's source: `game_id`,
  `home_score`, `away_score`), else the graded lock receipts in
  `data/snapshots/*_games_open.json` (winner only, so moneyline resolves and
  spread is `unresolved: no_final_score`), else nothing — `finals_source` says
  which every time. A tie or a push is unresolved.
* Output, per week and pooled: `n`, `hit_rate`, `model` {log_loss, brier}, `seed`
  {log_loss, brier}, `by_pricing`; moneyline / spread blocks; `by_position`;
  `unresolved` with reasons; `resolved` rows (the refit's input); `weeks_resolved`.
  `weeks_resolved: 0` with null metrics and a `skipped` reason is the honest
  document — a log-loss is never invented. That is what is committed today (no
  2026 week has been played; the sandbox does not fetch).

CLI: `--season`, `--cache-dir`, `--offline` (write the honest skip),
`--dry-run-with <csv>` (resolve against a local CSV and print the document;
`--out` to write it somewhere), `--finals <json>`, `--selftest`.
`tests/fixtures/r58/stats_player_week_2026_wk1.csv` is a **synthetic** stats
release covering 30 of the 40 committed prop legs (20 hits, 10 misses, one `LA`
row) with 10 players absent; it exists to exercise the join, never to fill data/.

## 3. The weekly refit — `scripts/backtest_parlay.py`

`data/parlay_backtest.json` gains an OPTIONAL top-level `live_2026` block
(rendered by the MODEL tab's PARLAY GATE card):

```
{"live_2026": {"weeks": int, "legs_resolved": int,
               "seed": {"log_loss": f, "hit_rate": f} | null,
               "calibrated": {"log_loss": f, "hit_rate": f} | null,
               "refit": {"applied": bool, "fit_weeks": [int], "reason": str} | null,
               "note": str}}
```

* `seed` / `calibrated` score the resolved, calibrated-priced legs as shipped
  (seed recomputed from the locked `p_team`; `hit_rate` = the share of those
  legs that hit — one number, identical legs).
* **Refit rule.** Once `>= 100` locked prop legs have resolved, the per-position
  logistic is re-fit on the 2023-25 corpus + the resolved 2026 legs (their `z`
  rescaled exactly to the fit's residual sd via `z * sd_locked`). It is adopted
  ONLY if it does not worsen log-loss on BOTH:
  1. the 2025 held-out fold — candidate fit on 2023-24 + the 2026 legs, scored on
     2025, against the fold's own 2023-24 fit;
  2. the 2026 legs, walk-forward by week — week *w* scored by a fit on the
     corpus + weeks `< w`, against the current shipped coefficients.

  Otherwise the current coefficients stay and `refit.reason` says which side
  regressed. Adopted: `props.calibration[pos].fit_seasons` becomes
  `[2023, 2024, 2025, 2026]` and `calibration_note` says so.
* With no resolved leg the block is exactly
  `{"weeks": 0, "legs_resolved": 0, "seed": null, "calibrated": null, "refit": null, "note": "no 2026 leg resolved yet"}`
  and nothing else in the file changes. Below 100 legs, `seed` / `calibrated`
  are measured and `refit` is null (the note names the threshold).
* `--gate` is unchanged in meaning: props adopted vs seed on every fold, spread
  `no_edge`, committed calibration == recomputed. The recompute reads the same
  `parlay_leg_scores.json` the committed file was built from, so a refit adopted
  on the runner is reproduced by the gate from the committed inputs.

## 4. Contracts and the gate

* `data/contracts/parlay_ledger.schema.json` — the ledger (strict: every leg field
  declared; `locked` a real boolean; markets and positions enumerated).
* `data/contracts/parlay_leg_scores.schema.json` — the scores (strict; `unresolved`
  reasons enumerated, so "miss" can never be one).
* `scripts/validate_data.py` registers `parlay_leg_scores.json` as OPTIONAL and
  routes `data/estimates/parlays_*.json` to the ledger contract (the player ledger
  keeps `estimate_ledger.schema.json`); its `--selftest` reds both contracts on a
  string flag, a > 1 probability, an off-enum market or reason, an undeclared leg
  field and a missing `finals_source`.
* `tests/feature/r58_parlay_ledger.test.mjs` locks the idempotent lock, the
  post-kickoff exclusion, hit / miss / unresolved, seed-vs-calibrated on identical
  legs, `refit_decision` both ways, the adversarial-legs rejection, the zero
  block, the contract keys and every `--selftest` / `--gate` / validate exit code.

## MY cards (R87)

The same three-part discipline now covers the cards MY PARLAYS builds in the
browser, which until R87 were the one surface that shipped a number and never had
to answer for it: they were built per viewer, from a seed typed a second earlier,
and then gone. `scripts/models/my_cards.py` is an exact Python mirror of the view's
selection (proved card-for-card against `app/views/myparlays.js` to 1e-9 by
`tests/feature/r87_my_cards_parity.test.mjs`), `scripts/build_my_cards.py` records
what was offered into `data/my_cards/<season>_wk<NN>.json` on the ledger rules
above — key `(dial, seed, sorted selections)`, first sight locks the as-made
numbers and never rewrites them, `locked` only when that first sight preceded the
earliest kickoff among the card's legs, idempotent per the pool's `generated_utc` —
and `scripts/resolve_my_cards.py` grades the locked ones into
`data/my_card_scores.json` against the same nflverse release and the same layered
finals this resolver uses, importing its `index_stats` / `find_player` /
`split_abbrev` / `load_finals` rather than copying them. The limits are stated, not
implied: **team seeds only** (a player-typed card is not recorded), and the stored
`model` is the browser's number rounded to 4dp. Full write-up:
[docs/MY_CARDS.md](MY_CARDS.md).

## 5. Daily pipeline order

```
resolve_locks -> ... -> backtest_parlay (reads parlay_leg_scores.json: live_2026 + refit)
  -> build_predictions (prices from parlay_backtest.json)
  -> build_estimate_ledger -> resolve_estimates
  -> build_parlay_ledger (append today's legs; idempotent)
  -> resolve_parlay_legs (score the locked legs; continue-on-error)
  -> validate_data -> commit
```

The refit therefore sees the legs resolved by the previous day's run — a one-day
lag by design: the day's build prices from a backtest whose inputs are already
committed, so the gate can reproduce it.
