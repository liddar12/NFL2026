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

**R88** adds the two things F17 asked for that R87 left open: per-stage status (below)
and a race-safe publish. The `git pull --ff-only && git push` retry loop is gone from all
three workflows; each commit step is now one call to `scripts/publish_data.sh` with that
workflow's own message. The publish race itself (F16) is documented in
[docs/PUBLISH.md](PUBLISH.md), not here.

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
| 12 | `scripts/publish_data.sh` (race-safe publish) | both | — | no | Last. Nothing is generated after the tree is staged. R88: the step body is now one call to the publish script — see [docs/PUBLISH.md](PUBLISH.md). |

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
| `scripts/publish_data.sh` (race-safe publish) | — | no |

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

## Stage status (R88)

`data/pipeline_status.json` is written *inside* `build_predictions`, so it describes the
lock half of the graph only: every archive, pool, card, ledger, resolver, replay-lab and
review step **after** it is invisible in it. Several of those carry
`continue-on-error`, so a failed resolver left the run GREEN, left the shipped health
document silent, and left the only evidence in the Actions log. That is F17's last open
criterion — *"resolver outage is visible in final health"* — and this is how it is met.

**The wrapper.** Every pipeline `run:` step between the dependency install and
`validate_data.py` now runs as:

```
bash scripts/stage.sh [--continue-on-error] <workflow> "<step name>" -- <original command>
```

`scripts/stage.sh` runs the real command with its stdout and stderr untouched, records
the outcome, and then **exits with the command's own exit code** — so a step's
`continue-on-error:` keeps exactly the meaning it had, and a step without one still reds
the run. The bookkeeping never fails a step: an unwritable record is a warning.

**The verbs** (`scripts/stage_status.py`, stdlib only):

| Verb | What it does |
|---|---|
| `begin --workflow W --run-id ID` | Opens a run: clears that workflow's `stages` and **carries each stage's last success forward**, so a stage that has not succeeded in days shows the day it last did. First step after the dependency install. |
| `record --workflow W --stage NAME --exit-code N --started U --finished U [--continue-on-error]` | Appends — or *replaces*, so a re-run of a stage is idempotent — that stage's row. Exit 0 → `ok`, anything else → `failed`. Called by the wrapper, not by hand. |
| `skip --workflow W --stage NAME --reason TEXT` | Records `skipped` for a step a mode guard did not run (gameday **scores mode**). "Did not run" and "ran and failed" are different facts and a reader must be able to tell them apart. |

**The document** — `data/pipeline_stages.json`, contract
`data/contracts/pipeline_stages.schema.json`, registered OPTIONAL in
`scripts/validate_data.py` because it is runner-built (absent on a fresh clone, strict
when present). It lives under `data/`, so the publish step picks it up like any other
generated artifact:

```
{generated_utc, workflows: {daily|gameday|backtest: {
    run_id, run_started_utc, run_finished_utc|null,
    last_success: {<stage>: <utc>},
    stages: [{name, status: ok|failed|skipped, exit_code, started_utc, finished_utc,
              duration_s, continue_on_error, last_success_utc, note}]}}}
```

`last_success` is the carry itself: `begin` wipes `stages`, so the map is where each
row's `last_success_utc` comes from on the next run.

**What "degraded" means.** A stage with `status: failed` **and**
`continue_on_error: true` — it failed and the run still went green. That is the exact
case this document exists to surface, and the MODEL tab's **PIPELINE STAGES** card
(`app/views/model.js`, wearing MEASURED) calls it out in one line per workflow:

```
degraded: <stage> failed at <utc>; last success <utc>
```

A `failed` stage **without** `continue_on_error` already redded the run, so it needs no
call-out. A `skipped` stage is neither: it prints its reason and keeps its last success.

Locked by `tests/feature/r88_stage_status.test.mjs` (exit-code propagation, the carry,
the skip verb, contract validity, and the workflow wiring) and
`python3 scripts/stage_status.py --selftest` in `tests/smoke.sh`.

## Out of scope (still open from F17 and its neighbours)

- Backfilling receipts for legs offered by past gameday windows. This changes the graph
  going forward only; nothing is back-dated.
- The per-stage record starts at the first run that writes it: `last_success` cannot know
  about a stage that succeeded before R88 shipped, so an early document honestly reads
  `NEVER` for a stage that has in fact been green for weeks.
