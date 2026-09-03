# Roadmap 2026-27 — Self-Learning Platform (liddar12/SelfLearning) and NFL2026

**Author:** product management pass, 2026-09-02 · **Horizon:** 2026 season + offseason, to Aug 2027
**Repos:** `liddar12/SelfLearning` (the domain-agnostic self-learning spine) · `liddar12/NFL2026`
(the NFL adapter and product) · `liddar12/wc2026-tracker` (prior work; second sports adapter candidate)
**Companion:** `docs/sports-roadmap.md` in SelfLearning carries the spine-side detail.

## 0. North star and operating rules

**North star.** One self-learning spine that logs every prediction before its event, resolves it
against the real outcome, scores it, and adjusts itself only when the adjustment is measurably
better on data it could not have seen — with sports prediction markets as the first family of
adapters and NFL2026 as the adapter that is live today.

**Rules that do not move** (all measured against this session's shipped code):
1. Market prices (books, Kalshi, Polymarket, Sleeper's numbers) are display and yardstick only,
   never a projection input.
2. Every learned change ships behind never-regress: walk-forward, held-out, exit-code gated.
3. Absent data is absent, never 0; every estimate is labelled; every claim on screen is wired.
4. Autonomy is staged (SelfLearning L0 monitor → L1 calibration → L2 weights → L3/L4) and a task
   earns the next level only with `min_resolved` outcomes behind it.
5. No build step, stdlib pipelines, Apple HIG; the regression gate is 100% green before any deploy.

## 1. Where we start (measured, 2026-09-02)

| Area | Today | Evidence |
|---|---|---|
| Weekly player split | `weekly_split_v2` adopted: pooled MAE 6.050→6.003, rank corr 0.369→0.381 (2023-25 walk-forward) | `data/weekly_backtest.json` |
| Parlay props | calibrated player model: 2025 fold log-loss 0.682→0.671, pick hit 55.8%→59.9%; spread legs NO EDGE (0.723 vs 0.693 flat) | `data/parlay_backtest.json` |
| Moneyline | Elo log-loss 0.637 vs market 0.608 (yardstick); no feature family clears the gate | MODEL tab, `promote_signals` |
| Player signals | 32 named, all weight 0.0; ledger has 0 resolved weeks (week 1 kicks off ~09-10) | `data/meta.json` |
| Season level | SCENARIO candidate over-projects 2025 by ~9% (WR 16%); a fixed correction failed walk-forward | R51 analysis |
| K / DEF | flat per-game average, no weekly split | `grade-weekly.js` |
| Weather | forecast horizon covers week 1 only: 3,126 player-weeks fall back to roof-only | `player_weekly.json` meta |
| QA coverage | 18 of 309 acceptance criteria asserted (6.1%) at last audit; QA-D1–D9 closed, D10 open | `docs/backlog/QA_COVERAGE.md` |
| Code health | 0 unimported exports, 0 unreferenced Python defs, 225 test-only exports pending a decision | `docs/qa/R52_DEAD_CODE_REPORT.md` |
| SelfLearning spine | Prediction/Outcome/Score, walk-forward, SQLite + Postgres schema, scorer + calibration + registry + L1 policy merged; store swappable; Supabase not provisioned | SelfLearning `docs/roadmap.md` |

## 2. The plan by quarter

Legend: **S** = SelfLearning release · **R** = NFL2026 release · 🔒 = needs an owner decision ·
each item names its **measure of success** (MoS); nothing ships without one.

### Q3 2026 (Sep–Oct) — Learning turns on

| Item | What | MoS | LOE |
|---|---|---|---|
| R53 · Ledger live | Week 1 actuals resolve `data/estimates/2026.json`; `fit_player_signals --propose` archives its first walk-forward verdict; MODEL LEARNING RECORD shows resolved weeks, MAE, bias (shipped vs gated vs candidate) | ≥1 resolved week with a non-null MAE on prod by 09-16 | 0.5 d |
| R54 · Weekly harness on live weeks | `backtest_weekly.py` gains a 2026 fold that scores the shipped `player_weekly.json` as-made against nflverse actuals (same never-regress rule) | 2026 fold present in `weekly_backtest.json` from week 2 | 1 d |
| R55 · K/DEF weekly split | opponent-allowed K/DEF points, dome/outdoor, home field → weekly K/DEF numbers behind the weekly gate | K/DEF MAE not worse than flat average on 2023-25 | 1.5 d |
| R56 · Weather horizon | Open-Meteo 14-day forecast for every scheduled game, refreshed daily; `weather_no_forecast_weeks` → 0 for the next two weeks | fallback count ≤ 1 week ahead | 0.5 d |
| R57 · Live scores edge (N6) | Vercel `/api/nfl` with STATUS gating (FINAL only), RENAMES mirrored, poller + ESPN fallback (the WC2026 pattern) | live score ≤ 15 s on open app; only FINAL moves actuals | 2 d |
| R58 · Parlay ledger | every prop leg logged as made and resolved weekly; calibration re-fit each Tuesday under the parlay gate | first re-fit with ≥100 resolved 2026 legs | 1 d |
| S1 · Sports task contract | `task` values `nfl.game`, `nfl.player_week`, `nfl.parlay_leg` (and `wc.match`) with feature/prediction/outcome shapes; validator; docs | NFL snapshots + ledger rows validate as Prediction/Outcome | 1 d |
| S2 · NFL adapter (read side) | `SportsAdapter` ingests NFL2026 `data/snapshots/*` and `data/estimates/*` into the store; nightly job | 100% of locked NFL rows in the store with `as_of` ≤ kickoff | 2 d |
| S3 · Scores for sports tasks | general scorer emits per-task, per-cohort (position, week, tier) `Score` rows with Wilson CIs; terminal Scores tab reads them | MODEL tab and terminal show the same MAE for the same week | 1.5 d |
| 🔒 Store | Supabase Postgres for the shared store (schema variant merged in #4) | decision | — |

### Q4 2026 (Nov–Jan) — Learn from the record

| Item | What | MoS | LOE |
|---|---|---|---|
| R59 · Level-bias as a signal | regression-to-mean term enters the registry at weight 0; the ledger fit may award it weight only if it clears never-regress on resolved 2026 weeks | proposal archived with CI; adoption is a human act | 1 d |
| R60 · Signal proposals cadence | weekly `--propose` review page on MODEL: which of the 32 signals cleared, by how much, on how many weeks; one-click adopt stays manual | every Tuesday a proposal row exists | 1 d |
| R61 · Playoff mode | GRADE: league playoff bracket with weekly-optimal totals, conditioned title odds; LINEUP: playoff-week waivers | bracket renders for P.T.I. weeks 15-17 | 2 d |
| R62 · Test-only exports decision | 225 exports kept as seams or tests moved to behavioural entry points; scanner promoted to a never-regress gate step | dead-export count gated at 0 | 1 d |
| R63 · QA-D10 | tests written with the unbuilt modules (P3 ensemble, N3 detail) | AC coverage reported by `QA_COVERAGE.md` ≥ 50% | 3 d |
| S4 · L1 calibration for sports | Platt/isotonic calibration applied per task once `min_resolved` (30) is met; proposed as a `Change`, never auto-applied | `Change` rows for `nfl.parlay_leg` and `nfl.game` with rationale | 1.5 d |
| S5 · Never-regress as a registry policy | port NFL2026's margin + significance gate as the spine's promotion rule for any task | one policy, two adapters, identical verdicts on the NFL fixtures | 1.5 d |
| S6 · WC2026 corpus import | tournament predictions and results from wc2026-tracker as a resolved `wc.match` corpus (prior work reused as-is) | scorer produces Brier/log-loss for `wc.match` with CIs | 1.5 d |
| 🔒 Autonomy threshold | confirm `min_resolved` 30 and which tasks may reach L2 | decision | — |

### Q1 2027 (Feb–Apr) — Extract the platform

| Item | What | MoS | LOE |
|---|---|---|---|
| S7 · Harness extraction | NFL2026 `scripts/harness/*`, `never_regress`, signal registry, conformal, ledger objective move into `selflearn-core` as packages; NFL2026 pins the package | NFL2026 gate green with byte-identical `data/*.json` before and after | 4 d |
| S8 · Second live adapter | WC2026 (or the next tournament) wired to the spine live: predictions logged before kickoff, resolved by the results pipeline | two adapters, one store, one Scores view | 3 d |
| S9 · Market yardstick service | Kalshi/Polymarket/closing-line ingestion as **measurement only** (policy), per task | market vs ours log-loss on MODEL and terminal, same number both places | 1.5 d |
| R64 · Offseason signals | draft/free-agency/coaching-change signals computed for 2027, entering at weight 0; backtested on 2023-26 corpus | each signal has a walk-forward row, none adopted by hand | 3 d |
| R65 · Rookie model | facts-only rookie cards become a measured projection with its own gate (no invented points) | rookie MAE vs prior_ppg baseline reported | 2 d |
| R66 · Contract + boot budget review | re-measure the 360 KB boot ceiling and route contracts after extraction | perf project green with reasoned numbers | 0.5 d |

### Q2 2027 (May–Aug) — Second season ready

| Item | What | MoS | LOE |
|---|---|---|---|
| S10 · L2 weights across adapters | ensemble/weight updater proposes cross-adapter reweights under the registry policy | proposals with CIs; still human-applied | 2 d |
| S11 · Multi-sport scores | terminal and MODEL tab render per-adapter learning curves (resolved n, MAE, calibration) from one store | both sports on one page | 1.5 d |
| S12 · Packaging (M4) | `selflearn-core` published as a zero-dep package; adapters pin a version | NFL2026 and WC2026 install from the package | 1 d |
| R67 · Draft room 2027 | auction-memory epic (observed prices seed the opponent model), Sleeper full sync, ADP display-only | auction sim fills every roster, prices from memory when present | 3 d |
| R68 · Pre-season gate | 2027 corpus refresh, weekly + parlay + player gates re-baselined, ledger reset for 2027 | full gate green on 2027 fixtures | 1 d |
| R69 · QA coverage ≥ 80% | remaining acceptance criteria asserted, self-referential ones retired | `QA_COVERAGE.md` ≥ 80% | 4 d |

## 3. KPIs the roadmap is judged on

| KPI | Now | Q4 2026 | Aug 2027 |
|---|---|---|---|
| Weekly MAE (pooled 2023-25 harness) | 6.003 | ≤ 5.95 | ≤ 5.85 |
| Weekly rank corr | 0.381 | ≥ 0.39 | ≥ 0.41 |
| Prop pick hit rate (held-out fold) | 59.9% | ≥ 60% on 2026 legs | ≥ 61% |
| Moneyline log-loss gap to market | 0.029 | measured weekly | ≤ 0.025 |
| Ledger resolved weeks | 0 | 13 | 18 + WC corpus |
| Signals with earned weight | 0 of 32 | first honest adoption or an honest "none" | reported per adapter |
| Adapters on the spine | 0 | 1 (NFL) | 2 (NFL + WC) |
| Acceptance-criteria coverage | 6.1% | ≥ 50% | ≥ 80% |
| Unimported exports / unreferenced defs | 0 / 0 | 0 / 0 (gated) | 0 / 0 |

## 4. Decisions the owner must make (🔒)

1. **Supabase for the shared store** — unblocks S2/S3 live logging; SQLite cannot be shared by a Vercel writer and a Python reader.
2. **`min_resolved` threshold** (default 30) and which sports tasks may advance past L1.
3. **Market yardstick sources** — which prices may be ingested for measurement only (policy stands: never an input).
4. **Second adapter** — WC2026 (prior work, zero new data) or a new sport; recommendation: WC2026 first.
5. **Extraction timing** — Q1 2027 offseason (recommended) versus in-season; in-season extraction risks the live ledger.

## 5. Risks

- **Spend limits and runner throttling** interrupt long builds; every release keeps partitions small and worktree-resumable.
- **A weak-signal season**: it is possible no player signal clears the gate in 2026. That is an honest result and the MODEL tab must say so; the roadmap does not assume adoptions.
- **Extraction parity**: moving the harness must not change a single shipped number; the byte-identical gate in S7 is the guard.
- **Policy drift**: any market number found on the input side of a projection is a P0 bug.
