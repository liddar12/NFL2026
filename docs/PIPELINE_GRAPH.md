# Pipeline graph — daily vs gameday

One page answering one question: **which steps run, in what order, in each workflow
and each gameday mode, and what does that guarantee?**

Written for [F17](qa/CODEX_REVIEW_R82_FOR_CLAUDE.md) — *"Gameday and daily workflows
publish different dependency graphs."* Before R87 the gameday window rebuilt
`data/game_predictions.json` but never rebuilt `data/leg_pool.json`, never appended the
parlay-leg ledger and never resolved a leg. So on a Sunday the GAME cards moved on fresh
inactives and prices while the MY cards still came from Saturday's pool, and a leg first
offered inside a gameday window could reach kickoff with no pre-kickoff receipt. Its
score step also invoked an absent module under `|| true`, reporting success for a step
that executed nothing.

The graph below is locked mechanically by `tests/feature/r87_gameday_graph.test.mjs`
(order, existence on disk, and module-level import weight). If this table and the
workflows disagree, that test fails.

## gameday.yml

`mode` is the `workflow_dispatch` input (`lock | scores | both`). A `schedule:` run
leaves it **empty**, which matches neither exclusion guard, so every cron fires the full
graph. "Mode" below is where the step runs; "COE" is `continue-on-error: true`.

| # | Step | Mode | Network? | COE | Why it sits here |
|---|------|------|----------|-----|------------------|
| 1 | `scripts.resolve_locks` | both | yes (ESPN) | no | The real FINAL reader. STATUS-gated: only FINAL becomes an actual. |
| 2 | `scripts.refit` | both | yes (ESPN) | no | Grades before it fits; never-regress gated; no-op with nothing newly resolved. |
| 3 | `scripts.build_predictions` + snapshot copy | lock | yes (ESPN, odds) | no | The generation. Writes the leak-safe point-in-time snapshot under `data/snapshots/`. |
| 4 | `build_parlay_archive.py` | both | no (stdlib) | no | Lock mode archives what 3 just wrote; scores mode freezes the week that went FINAL. |
| 5 | `build_leg_pool.py` | lock | no (stdlib) | no | Copies the slate's game legs verbatim and prices props off the same weekly projections. Refuses to write while its calibration gate is red. |
| 6 | `build_my_cards.py` | lock | no (stdlib) | no | Records the cards actually offered, first-sight lock. Absent `leg_pool.json` = one-line skip, exit 0. |
| 7 | `build_parlay_ledger.py` | lock | no (stdlib) | no | As-made pricing for what 5/6 offered. Idempotent per `parlays.json` `updated_utc`. |
| 8 | `resolve_parlay_legs.py` | both | yes (nflverse) | **yes** | Grading is mode-independent — see below. |
| 9 | `resolve_my_cards.py` | both | yes (nflverse) | **yes** | Same. |
| 10 | `build_review.py` | both | yes, degrades | no | Consumes the resolved rows, so it must follow 8/9. |
| 11 | `validate_data.py` | both | no (stdlib) | no | Contracts gate the push. |
| 12 | Race-safe commit | both | — | no | Last. Nothing is generated after the tree is staged. |

**Why 8 and 9 carry no mode guard.** Thursday's legs go FINAL inside Sunday's *lock*
window and Sunday's inside Monday's. A `mode != 'lock'` guard would strand exactly
those. Both resolvers are idempotent and, while no week has resolved, skip loudly with
an honest 0-resolved record — they never invent a log-loss — so running them in every
mode costs a no-op.

**Why there is no "refresh scores" step.** There is nothing left for one. Scores mode is
steps 1, 2, 4, 8, 9, 10, 11, 12 — all unguarded above. The removed placeholder ran a
scores CLI module that has never existed in this repo, under `|| true`.

## daily.yml

Same shape, wider: it also rebuilds the slow-moving record (injuries, weather, corpora,
backtests, estimate ledger). The parlay spine is identical and in the same order.

| Step (in order) | Network? | COE |
|---|---|---|
| `scripts.resolve_locks` | yes | no |
| `scripts.build_all` (fixture players + parlays, stdlib only) | no | no |
| `build_injury_history.py` | yes | no |
| `build_weather_forecast.py` | yes | yes |
| `build_backtest_weekly_corpus.py` | yes | yes |
| `backtest_weekly.py` | no | no |
| `backtest_lines.py` (measure only) | no | yes |
| `backtest_parlay.py` | no | no |
| `scripts.build_predictions` | yes | no |
| `build_parlay_archive.py` | no | no |
| `build_leg_pool.py` | no | no |
| `build_my_cards.py` | no | no |
| `build_line_report.py` | yes | yes |
| `scripts.backtest_player` | yes, degrades | no |
| `build_sleeper_projections.py` (display only) | yes | yes |
| `build_estimate_ledger.py` | no | no |
| `resolve_estimates.py` | yes | yes |
| `build_parlay_ledger.py` | no | no |
| `resolve_parlay_legs.py` | yes | yes |
| `resolve_my_cards.py` | yes | yes |
| `replay_lab.py` (measure only, adopts nothing) | no | yes |
| `build_review.py` | yes, degrades | no |
| `build_review_narrative.py` (env-gated, optional) | yes | yes |
| `validate_data.py` | no | no |
| Race-safe commit | — | no |

The two `build_leg_pool -> build_my_cards` and `resolve_parlay_legs -> resolve_my_cards`
orderings are asserted in both files by the R87 test, so the workflows cannot drift
apart again without it failing.

## What each mode guarantees

- **Lock mode (and any cron run).** GAME and MY are rebuilt under **one generation**: the
  pool is priced from the same `build_predictions` output that wrote the slate, so an
  injury or price change moves both together. Every eligible leg and card offered by that
  generation gets a ledger row with as-made pricing, and that row is **locked** whenever
  the window fires before kickoff — which is what the wide Thu/Sun/Mon grid is for. A leg
  first offered after kickoff is recorded *unlocked*, never back-dated.
- **Scores mode.** Grades only. Nothing is re-priced and no new card is offered. Only
  FINAL games become actuals (`scripts/scrape/espn.py` status-gates; live, halftime and
  0-0 scheduled stubs are display-only). A resolver outage degrades the record, not the
  run — the step is `continue-on-error` and `build_review` reports on whatever resolved.
- **Both.** `validate_data.py` gates the commit, and the commit is the last step.

## Out of scope (still open from F17 and its neighbours)

- **F16 — the publish race.** Both workflows still commit locally then retry
  `git pull --ff-only && git push`. Once both sides have commits from a common base, a
  fast-forward pull cannot merge them and repeating it cannot change that. The push loop
  is untouched here.
- **Per-stage status watermarks.** `data/pipeline_status.json` is written *inside*
  `build_predictions`, so it describes the lock half of the graph only. The archive,
  pool, cards, ledger, resolver and review steps that follow it publish no last-success
  timestamp, no skipped-reason and no watermark, so a silent resolver outage is not
  visible in the shipped health document. F17's acceptance criterion "resolver outage is
  visible in final health" is therefore **not** met by R87 part C.
- Backfilling receipts for legs offered by past gameday windows. This changes the graph
  going forward only; nothing is back-dated.
