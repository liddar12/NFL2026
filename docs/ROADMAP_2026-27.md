# Roadmap 2026-27 — Self-Learning Platform (liddar12/SelfLearning) and NFL2026

**Author:** product management pass, 2026-09-02 · **Revised:** 2026-09-16 (bulleted, statuses
re-derived from shipped code and committed data) · **Horizon:** 2026 season + offseason, to Aug 2027
**Repos:** `liddar12/SelfLearning` (the domain-agnostic self-learning spine) · `liddar12/NFL2026`
(the NFL adapter and product) · `liddar12/wc2026-tracker` (prior work; second sports adapter candidate)
**Companion:** `docs/sports-roadmap.md` in SelfLearning carries the spine-side detail.

## 0. North star and operating rules

**North star.** One self-learning spine that logs every prediction before its event, resolves it
against the real outcome, scores it, and adjusts itself only when the adjustment is measurably
better on data it could not have seen — with sports prediction markets as the first family of
adapters and NFL2026 as the adapter that is live today.

**Rules that do not move** (all measured against shipped code):
1. Market prices (books, Kalshi, Polymarket, Sleeper's numbers) are display and yardstick only,
   never a projection input. Money on screen — including the $100 stake lines — is display only.
2. Every learned change ships behind never-regress: walk-forward, held-out, exit-code gated.
3. Absent data is absent, never 0; every estimate is labelled; every claim on screen is wired.
4. Autonomy is staged (SelfLearning L0 monitor → L1 calibration → L2 weights → L3/L4) and a task
   earns the next level only with `min_resolved` outcomes behind it.
5. No build step, stdlib pipelines, Apple HIG; the regression gate is 100% green before any deploy.

## 1. Where we start (measured 2026-09-16, two weeks into the season)

| Area | Today | Evidence |
|---|---|---|
| Weekly player split | `weekly_split_v2` adopted on the corpus: pooled MAE 6.0498→6.003, rank corr 0.3694→0.3814 (2023-25 walk-forward); held-out 2025 MAE 6.079 | `data/weekly_backtest.json` |
| Weekly split, **live** | week 1 resolved as made: 216 player-weeks, shipped MAE 6.1457 / rank corr 0.3664 / top-k 0.7525, bias −1.339, band coverage 45.8%; gated variant worse at 6.3775 | `weekly_backtest.json` → `live_2026` |
| Parlay props | calibrated player model on the corpus: 2025 fold log-loss 0.682→0.671, pick hit 55.8%→59.9%; spread legs NO EDGE (0.723 vs 0.693 flat) | `data/parlay_backtest.json` |
| Parlay legs, **live** | 37 locked prop legs resolved (week 1): seed log-loss 0.6914 → calibrated 0.6602, hit rate 40.5%; the weekly refit arms at 100 resolved legs | `parlay_backtest.json` → `live_2026` |
| Parlay slate | 66 parlays a week (18 week-scope, 48 game-scope); week 1 archived and frozen, week 2 open; 0 same-team ML+spread stacks since R74 | `data/parlays/index.json` |
| Moneyline | Elo log-loss 0.637 vs market 0.608 (yardstick); no feature family clears the gate | MODEL tab, `promote_signals` |
| Player signals | 32 named, all weight 0.0; 1 resolved week in the ledger (`signals_with_weight: []`) | `data/meta.json` → `learning_record` |
| Season level | SCENARIO candidate over-projects 2025 by ~9% (WR 16%); a fixed correction failed walk-forward | R51 analysis |
| K / DEF | still a flat per-game average, no weekly split | `kdst_projections.json`, `grade-weekly.js` |
| Weather | forecast for every non-dome home game with a climatology fallback beyond the horizon | R56, `player_weekly.json` |
| Line-injury cascade | measured and **not adopted**: 0 of 15 variants cleared never-regress; the LINE REPORT chips display, no factor prices | R70 phase 1 |
| QA coverage | 18 of 309 acceptance criteria asserted (6.1%) at last audit; QA-D1–D9 closed, D10 open | `docs/backlog/QA_COVERAGE.md` |
| Code health | 0 unimported exports, 0 unreferenced Python defs, 225 test-only exports pending a decision | `docs/qa/R52_DEAD_CODE_REPORT.md` |
| Boot budget | 359,967 bytes of a 360,000 ceiling — **33 bytes of headroom**; the next boot-graph addition of any size trips it and needs a written re-measure | `tests/perf/budget.spec.mjs` |
| SelfLearning spine | Prediction/Outcome/Score, walk-forward, SQLite + Postgres schema, scorer + calibration + registry + L1 policy merged; store swappable; no shared store provisioned | SelfLearning `docs/roadmap.md` |

## 2. The plan by quarter

Legend: **S** = SelfLearning release · **R** = NFL2026 release · 🔒 = needs an owner decision ·
✅ shipped or decided · ✂ dropped · ▢ not started. Every item names its **measure of success** (MoS);
nothing ships without one.

### Q3 2026 (Sep–Oct) — Learning turns on

#### ✅ R53 · Ledger live — *shipped 2026-09-13 (#73)*
- Week 1 actuals resolve `data/estimates/2026.json`; a dry-run resolver runs first so a bad match
  never writes.
- Players the resolver cannot match are **named**, not silently dropped (76 unmatched at week 1).
- `fit_player_signals --propose` archives its first walk-forward verdict.
- MODEL LEARNING RECORD renders resolved weeks, MAE, bias and band coverage for three lines at
  once: shipped, gated and candidate.
- **MoS:** ≥1 resolved week with a non-null MAE on prod by 09-16 → met (1 week, MAE 6.146). · **LOE** 0.5 d

#### ✅ R54 · Weekly harness on live weeks — *shipped with R53*
- `backtest_weekly.py` gained a `live_2026` fold that scores the shipped `player_weekly.json`
  **as made and locked before kickoff**, never a re-projection after the fact.
- Scored against nflverse actuals under the same never-regress rule as the corpus.
- The corpus fold stays the promotion authority; the live fold is measurement only, and says so in
  its own `note`.
- **MoS:** 2026 fold present in `weekly_backtest.json` from week 2 → met. · **LOE** 1 d

#### ✅ R55 · D/ST weekly split — *shipped 2026-09-16; the kicker half is a measured negative*
- **D/ST ships.** A defence's week is now its season average reshaped by what the opponent
  surrenders to opposing defences, plus home field — `kdst_split_v1`. Walk-forward 2023-25:
  **MAE 4.4418 → 4.3227**, 95% CI [−0.162, −0.076], and better in **each season independently**
  (2023 −0.080, 2024 −0.150, 2025 −0.127). Held out on 2025 with parameters fit only on 2023-24:
  still better.
- **Kickers do not, and that is the finding.** Over the same grid the best kicker configuration
  moved MAE by **−0.008 ± 0.014 — not significant** — and every stronger setting made it worse.
  Dome/outdoor added nothing. A kicker week stays season ÷ games and every surface says so.
- **A shape, never a level.** The contract ships a dimensionless factor per week, normalised so a
  team's factors average exactly 1.0. Season projections were byte-identical across the rebuild:
  0 of 74 rows moved. A factor rather than points because the split is computed under the default
  profile while `app/kdst.js` prices under the league's — only a multiplier survives that.
- New `data/kdst_weekly_history.json` (2,718 resolved team-weeks, 2021-25) so the gate runs
  **offline** in CI, the same arrangement `dvp_positional_history.json` gives the player gate.
- New gate step 6, `scripts/backtest_kdst.py --gate`: refuses a tie, refuses a corpus too short to
  answer, and its selftest plants a signal to prove the harness finds one and shuffles it to prove
  the harness refuses noise.
- **MoS:** met — not worse was the bar; measurably better in every season is the result. · **LOE** 1.5 d

#### ✅ R56 · Weather horizon — *shipped with R53*
- Open-Meteo forecast for every scheduled non-dome home game, refreshed daily.
- Beyond the forecast horizon, a **climatology fallback** (stadium/month normals) replaces the
  old roof-only blank, and is labelled as climatology wherever it is used.
- **MoS:** fallback count ≤ 1 week ahead → met. · **LOE** 0.5 d

#### ✂ R57 · Live scores edge (N6) — *dropped 2026-09-16, owner decision*
- Cut on the owner's call: real-time scores are not wanted, an interval refresh is.
- The git pipeline already refreshes scores on its schedule and is the durable record for scoring,
  the bracket and the ledger, so nothing is lost by not building a second path to the same numbers.
- Saves 2 d of build and a Vercel service to keep honest — and it was the main thing the store
  decision was blocking.
- Reopen only if the cron cadence turns out to annoy in-season; the WC2026 pattern is still the
  design if it ever comes back.

#### ✅ R58 · Parlay ledger — *shipped with R53*
- Every prop leg logged **as made**, priced at first sight before kickoff, into
  `data/estimates/parlays_2026.json` — append-only, keyed `(season, week, game_id, market, selection)`.
- Weekly resolver grades each leg; the calibration re-fit runs under the parlay never-regress gate.
- The refit is **armed but not fired**: 37 of the 100 resolved legs it needs.
- **MoS:** first re-fit with ≥100 resolved 2026 legs → pending, 37/100. · **LOE** 1 d

#### ✅ R70 phase 1 · Line-injury cascade — *shipped with R53, measured, not adopted*
- OL/DL availability cascades into a LINE REPORT with per-team chips on the GRADE tab.
- 15 pricing variants measured against never-regress; **0 cleared**, so no factor prices anything.
- Shipped as an honest negative result: the chips inform, the model does not move.
- **MoS:** every variant has a walk-forward row and the tab says which shipped → met. · **LOE** —

#### ✅ R71 · Post-game review — *shipped with R53*
- Slate pick circles drawn from the as-made locks, green when the predicted team won.
- Parlay leg and whole-parlay outcomes graded per week.
- Every player marked OVER / UNDER / MET against the calibrated band, with a **measured** why
  (usage, opponent, game script), plus an optional env-gated AI narrative on top.
- **MoS:** every circle traceable to a lock written before kickoff → met. · **LOE** —

#### ✅ R72 · Right/wrong overview and review sorting — *shipped 2026-09-14 (#74)*
- SLATE: a per-week header counting picks RIGHT / WRONG / TBD, plus a line proving the learning
  loop is real (which resolved weeks fed which fit).
- PLAYERS: sort and filter by met / over / under expectations alongside the trend and SoS filters,
  with a season tally per player.
- PARLAYS: outcome buckets — all-hit, push, partial, all-wrong — as filter chips.
- **MoS:** the counts reconcile to the ledger row-for-row → met. · **LOE** —

#### ✅ R73 · Parlay history and the $100 P&L line — *shipped 2026-09-15 (#75)*
- `data/parlays/` week archive: a file per week, written on first sight, refreshed while the week
  is open, and **frozen forever** once every game is FINAL.
- `index.json` with `current_week`; the PARLAYS week chips default to the live NFL week.
- Past weeks show their outcomes and a display-only `$100` flat-stake P&L per scope: fair and
  vig-adjusted, with legs that have no book price assumed at −110 and counted in the note.
- **MoS:** a closed week's file never changes again; the P&L reconciles to the graded buckets → met. · **LOE** —

#### ✅ R74 · One leg per game side — *shipped 2026-09-16 (#77)*
- A moneyline and that same team's spread are **one opinion, not two legs** — the builder now
  refuses the pair (it was being selected precisely because its ρ 0.71 ranked highest).
- `validate_data.py` gained a standalone `check_parlay_one_leg_per_side` so the rule is gated, not
  merely coded, with its own message and its own selftest.
- Week 2 rebuilt from the shipped document so real book prices survived the correction rather than
  degrading to model-seeded placeholders; week 1 verified unchanged.
- Archive idempotence fixed: an open week now refreshes on **content** change, not timestamp alone.
- **MoS:** 0 same-side stacks in `parlays.json` and in every open archived week → met. · **LOE** —

#### ✅ Red-main repair — *shipped 2026-09-15 (#76)*
- One live defect: a published upstream FTN release was read as permission to price a season the
  artifact does not carry (silent 0.0, bare KeyError, `applied: True`). Coverage is now
  authoritative and the probe may only veto; the history builder forces `dark` back on and the
  next cron self-heals.
- Six in-season test locks re-derived from committed data instead of preseason snapshots — the
  class of failure where a test goes red, or worse silently toothless, as the season moves.
- **MoS:** all three symptoms reproduced on a pristine checkout before and after → met. · **LOE** —

#### ✅ R75 · PARLAYS sorting, filtering and the $100 wager — *shipped 2026-09-16*
- **Confidence-tier chips** — ALL / HIGH / MEDIUM / LOW off each parlay's `confidence_tier`, built
  from the tiers **present in the active scope**, so the row never offers an empty bucket.
- **Sort control** — SLATE (the default), MODEL EV (desc), $100 (desc), LEGS (asc). SLATE is the
  document's own order: enabling a sort is not the same as reordering the page for a user who
  never asked, and the R73 lock caught the first attempt to make EV the default.
- **A $100 figure on every card** — the builder stamps `money` on every reviewed parlay row:
  `settled` (what the stake returned) on a graded parlay, `potential` (what it would return if
  every leg hit, `net_vig2` null — a quote is one price, not two) while it is pending.
- **One arithmetic, not two** — both the card and the R73 week footer come from
  `build_review.parlay_money`, so they cannot disagree. The gate asserts the invariant on real
  data: the settled cards of a scope **sum to that scope's footer** (week 1, week scope:
  $11,563.90 across 18 cards vs a footer of $11,563.91 — rounding to the cent, never a dollar).
- **The client never prices a parlay** — `app/review.js` formats the builder's number and nothing
  else; a row with no `money` simply gets no cell, and the $100 sort chip stays hidden rather than
  sorting on nothing.
- **Display-only money**, per rule 1: no dollar figure, tier or EV reaches a projection input.
- **Zero boot bytes** — both modules are lazy, the chips reuse `.leg-chip` (HIG and AA contrast
  for free), and nothing was added to `app/data.js`; the 33-byte headroom is untouched.
- **MoS:** met — 8 feature tests, 4 browser tests on the committed slate (tier filter, EV and $100
  ordering, each card equal to the builder's to the cent, and the sum invariant), full gate green
  at 1,584 unit / 260 browser. · **LOE** 1 d

#### ✅ R77 · The this-week gate — *built 2026-09-17 (RCA: sitters priced as bets)*
- **RCA.** "Will he play this week?" was never a first-class fact: an OUT kept 55% of his week, a
  DOUBTFUL 70%, a suspension of unstated length 100%, no consumer read a depth chart, and the leg
  pool / slate props priced everyone with a weekly row (Josh Jacobs OUT at 36.5 rush yds, Sam
  Darnold DOUBTFUL at 168 pass yds, four IR players in the week-2 pool).
- **One predicate** — `availability.NOT_PLAYABLE` + `build_weekly.this_week_gate`: status first
  (D/OUT/IR/PUP/NFI/SUSP), then the QB depth chart (`data/depth_chart.json`, nflverse, fetched
  every run): a QB behind a healthy starter is zeroed, a QB2 behind an OUT QB1 is **promoted**.
  Owner rules: *zero unless QB1 is out*; *Q priced + labelled, D excluded*.
- **Written once, read everywhere** — `player_weekly.json players[].this_week` (+ the zeroed
  week row), `model.this_week`; prop legs name their `gsis_id` and carry a `Q` label; the pool
  counts `not_playable`. PLAYERS headline reads `WK n · OUT / D / SUSP / IR / QB2 / QB3`; PARLAYS
  and MY PARLAYS legs carry a `Q` chip.
- **Gated, not merely coded** — validator rules 6–8 (a gate agrees with its row, its source and
  the summary; **no silent sitter**) and `check_no_unplayable_legs` over the slate and the pool.
- **Cadence (R78)** — `daily.yml` carries the owner's schedule at off-the-hour minutes (06:07 /
  18:07 ET daily, 19:15 ET Mon/Thu, 12:03 / 15:15 / 19:20 ET Sunday), with Claude Routines
  dispatching the same workflow as a second layer. See `docs/PLAYABLE_GATE.md`.
- **Game-day inactives (R79)** — ESPN's posted lists (per-competition roster `didNotPlay`)
  become the gate's FIRST source for games inside the window (kickoff-3h until FINAL): a healthy
  scratch at any position is zeroed and loses its legs; the file is removed outside the window
  so a stale list can never gate a later game. Validator rule 9: no silent inactive.
- **MoS:** 0 not-playable players with a leg in `parlays.json` / `leg_pool.json`, 0 not-playable
  players carrying points on the current week — asserted by the gate on every run. · **LOE** 1 d
- **R81 · Replay lab — built 2026-09-17; measure-only.** `scripts/replay_lab.py` →
  `data/replay_lab.json` replays candidate parlay rules (`seed`, `pool_calibration`,
  `spread_margin_model`, `shrink_to_half`) against the weeks already played, on the legs that were
  actually locked, with a paired bootstrap CI per variant and the archived parlays re-combined by
  the builder's own arithmetic and re-settled by `build_review`'s own money. **A variant is
  reported, never adopted**: no gate, no promotion path, and the only file it writes is its own
  record. Runs every pipeline run after the leg resolver; shown on the MODEL tab as
  `REPLAY LAB · CANDIDATES vs SHIPPED`. Week 1 (69 legs): `spread_margin_model` is `worse`
  (the retired spread rule loses to shipped, CI excludes 0); every other candidate `same`.
  See `docs/REPLAY_LAB.md`. · **LOE** 1 d
- **R82 · MY PARLAYS card layout — built 2026-09-17 (RCA: the bet you could not read).** Three
  faults, all layout, none visible to a gate that had no reader of the declarations behind them.
  **(1)** `renderCard` emitted `<div class="leg">` without `leg--annot`, so the why-line
  (`.leg-prov`, `flex-basis:100%`) never wrapped to its own line and took the name's instead:
  `.leg-nm` measured **62px against a 155px name at 1280px** (40/40 names ellipsized) and **54px
  at 402px**, where "J. Gibbs 20+ rush yds" broke one word per line — 5 lines, a 106px leg.
  **(2)** `.card-list` is `align-items:start`, so a 2-leg card beside a 3-leg one ended **58px
  higher** (95px at 1440px) and no footer on a row lined up. **(3)** `minmax(300px,1fr)` fits four
  318px columns on the 1320px canvas and the `.p-foot` EV cell wrapped — `.legcount` **15.9px →
  31.9px** at 1440px and 1100px. Plus a header describing the wrong thing: MY mode kept the
  slate's `WEEK n · MODEL EV` line and the R71 review banner over ten cards that are on no slate
  and are ranked by conviction, not EV. **Changed:** `leg--annot` on every MY leg; MY leg names
  wrap rather than ellipsize (the slate keeps its own); `#mp-list` stretches its grid row with
  `.p-foot` on `margin-top:auto` (the `.corr` note rides down with it) and takes a **360px**
  minimum column at both desktop breakpoints, with the EV cell pinned `nowrap`; the subtitle reads
  **`MY PARLAYS · POOL WK n`** from the leg pool's own week, and `.rv-strip--parlay` joins the
  hidden chrome — `exitMyMode` restores the slate line through the same `archivedFor` test
  `selectWeek` uses, so the ARCHIVED pill returns exactly as it left. **After:** name 155px ==
  scrollWidth on one line at both viewports, why-line underneath, row-bottom spread **0px** at
  820/900/1100/1280/1440/1600, `.legcount` 15.9px everywhere, no horizontal scroll. **Locked by**
  `tests/feature/r82_myparlays_layout.test.mjs` (the wrap class on every leg, the exact subtitle
  strings, the CSS declarations read as text, and that the slate rules are untouched) and
  `tests/web/r82_myparlays_layout.spec.mjs` (the geometry at 402×874 and 1280×900, the width
  sweep, and the banner staying hidden when MY is opened before the lazy review module lands).
  · **LOE** 0.5 d
- **R86 · MY PARLAYS risk dial + leg-count rows — built 2026-09-17 (RCA: the cards that always
  paid $10).** **The selection was degenerate (RC-N1).** `buildCards` ranks by conviction and let
  EVERY rung of every player compete, but a ladder is a set of NESTED events — clearing 60 clears
  20 — so a player's most probable rung is always his lowest line. Measured on the committed pool:
  **1,280 of 1,280 prop legs across all 32 team seeds (100%) sat on the ladder floor**, mean prop
  model probability **0.906**, and the best 2-leg DET card read *J. Gibbs 20+ rush yds · J. Cook III
  30+ rush yds — 82% CONVICTION, −9.1% SIM EV, +$10 $100 SIM NET*. The maths reconciled with itself
  and answered a question nobody asked. **Changed:** a **RISK DIAL** — `dialLegs(legs, target)` keeps
  ONE rung per player before the search, the rung nearest the dial's target model probability
  (`DIALS = { safe: 0.65, even: 0.50, longshot: 0.35 }`, `DEFAULT_DIAL = 'even'`), ties to the higher
  line. **The dial applies to game legs too**, as a band rather than a pick: a moneyline or spread is
  one fixed number with no ladder to choose from, so it is offered only when its own model chance is
  within `GAME_LEG_BAND = 0.15` of the target. Without that band conviction ranking took the heaviest
  favourite in the league ahead of every leg the dial had just chosen — measured at EVEN, 905 of the
  1,280 legs on cards were game legs and MY stopped being about the players you typed; with it, 610
  (props 29.3% → **52.3%**). Nothing is re-priced, so market prices still never reach a model
  probability. Three `SAFE / EVEN / LONGSHOT` chips (`.mp-dial`, `aria-pressed`, the existing
  `.leg-chip` pill) sit below the seed chips and persist per viewer in
  `nfl2026.myparlays.dial.v1` (try/catch, default EVEN). Ranking WITHIN the dial stays conviction —
  now a comparison between legs of comparable difficulty rather than a race to the floor — and the
  legend says so. **After (32 seeds, 320 cards, all ten cards built at every dial):** prop legs on the
  ladder floor **100% → 6.9%** at EVEN (46 of 670, and every one of them is a ladder whose floor
  genuinely IS the rung nearest 0.50), mean prop model probability **0.906 → 0.684 SAFE / 0.530 EVEN /
  0.450 LONGSHOT**, player props **29.3% → 74.8 / 52.3 / 50.9%** of the legs on the cards, and the DET
  2-leg card reads *J. Goff 200+ pass yds · J. Williams 40+ rec yds — 36% CONVICTION, +$220* at EVEN
  (it read *J. Gibbs 20+ · J. Cook III 30+ — 82%, +$10* before). **Three layout faults (RC-L1..L3), measured at
  1395×704 dark:** an **83px void** between the last leg and the footer inside the shorter card of
  every mixed row (5 of 10 cards — R82 stretches the row and anchors `.p-foot`); **0px** between the
  seed chips and the legend and **0px** between the legend and the grid (`#myparlays-host` is one
  `.view` child, so the `.view` gap never reached its own children); and **three** auto-fill columns
  at 1395px, which split the five leg-count PAIRS the list is built as and made every row a mixed
  row. **Changed:** `#myparlays-host` is a flex column with a **12px** gap (`#mp-seeds:empty` hides,
  the one-sided 8px seed margin retired); `#mp-list` is **`repeat(2, minmax(0,1fr))`** at ≥820px with
  the ≥1200px auto-fill override removed, so a row IS a leg-count band; and a `.mp-band` eyebrow
  (`2 LEGS` … `6 LEGS`, the `.slate-day` style, `grid-column: 1 / -1`) opens each pair. **After:**
  void **12px on all ten cards** at 402, 1280 and 1395; every host-child gap **12px**; **2** columns;
  **5** eyebrows; row-bottom spread **0px**; no horizontal scroll. (One residual, named not hidden: at
  SAFE a card carrying R77's QUESTIONABLE chip is 5.4px taller than its row partner, so that partner
  shows **17.4px** of void — content variance inside a band, not the mixed-row fault.) **Locked by**
  `tests/feature/r86_my_dial.test.mjs` (dialLegs as a pure function, the 32-seed sweep over the
  committed pool, the invariant that a floor rung is only ever chosen when it IS the nearest rung,
  the legend, and the CSS read as text) and `tests/web/r86_my_dial.spec.mjs` (402×874, 1280×900 and
  1395×704: the default chip, ten cards, three different leg sets across the dials, the reload,
  the 12px rhythm, five eyebrows, two columns, equal row bottoms, the void, no console errors).
  `tests/feature/r76_myparlays_search.test.mjs` now runs its beam-vs-exhaustive oracle over the
  DIALLED pool, which is the universe the view actually searches, and `nfl2026.myparlays.dial.v1`
  joins `RESET_ALL_KEYS` so RESET ALL clears the dial. **Open, surfaced not introduced:** with the
  cards now on fair-line legs, the RCA's latent RC-N5 is visible — the highest SIM EV in the EVEN
  sweep is **+107.6%** on a 6-leg card. The chained same-game adjustment is bounded here (at most two
  legs per game, so it is only ever pairwise) but it is still unvalidated, and the RCA's proposed
  “no MY card prints EV > +100%” test is not written. · **LOE** 0.5 d
- **R87 · Parlay correctness — same-game pairs measured, MY cards recorded and graded, gameday
  rebuilds the pool — built 2026-09-19.** Three faults, one release. **(1) The same-game correlation
  was unvalidated on live legs (RC-N5).** `scripts/replay_lab.py` gains a `same_game_pairs` block:
  every unordered pair of RESOLVED locked legs in one game (the R74 refusal applied, so a team's ML +
  its own spread is counted under `refused_by_reason`, never scored) keyed the way `_pair_rho` keys
  it, with the observed joint hit rate against the SHIPPED joint (`_combine_two` at the shipped rho)
  and the independence product, a moment-estimator `rho_live`, and a paired bootstrap CI90 on
  observed − shipped; verdict `insufficient` below `min_n` 20, else `consistent` / `shipped_high` /
  `shipped_low`. Archived 2-leg same-game cards get the same comparison. **First reading (weeks 1–2,
  118 pairs over 18 keys, every key under 20):** pooled observed **0.2034** vs shipped **0.2570** vs
  independent **0.2484**, `rho_live` **−0.19**, CI90 [−0.110, 0.007] → `consistent`, but directionally
  the chained joint runs high; the 34 archived cards hit 32.4% against a 30.2% shipped mean. Measure
  only, as the lab's rule requires: no rho moved, and the clamp decision waits for a key to clear
  `min_n`. Rendered on the MODEL tab under the REPLAY LAB card. **(2) MY cards were never recorded.**
  `scripts/models/my_cards.py` is an exact stdlib mirror of the browser's selection (pool legs, the
  dial, the kickoff filter, the beam search, the scoring) — `parlay_builder.make_leg` is never used
  because it rounds — and `tests/feature/r87_my_cards_parity.test.mjs` proves JS == Python card for
  card (ordered selections and every number to 1e-9) over the toy pool and the committed pool: all
  32 team seeds at EVEN, six each at SAFE / LONGSHOT, six player seeds; 22.8 s. `scripts/
  build_my_cards.py` records, at the pool's own `generated_utc`, the ten cards every TEAM seed would
  have been offered at every dial into `data/my_cards/<season>_wk<NN>.json` under the R58 rule set
  (first sight locks the as-made numbers, `locked` iff first sight precedes the earliest kickoff on
  the card, idempotent per pool as-of, never rewritten). `scripts/resolve_my_cards.py` grades the
  locked cards against nflverse yards and FINAL scores through the leg resolver's own machinery
  (imported), settles $100 with `build_review.parlay_money`, and writes `data/my_card_scores.json`
  (per week and per dial / leg count: n, graded, all-hit rate, mean conviction, log-loss, Brier,
  net; graded cards only, pending counted). MY mode paints one RECORD line for the current dial once
  a week has graded cards. **Recorded today:** 900 cards (300 per dial, 30 of 32 seeds, 180 per
  leg count), 900 locked, earliest kickoff 2026-09-20T17:00Z; 2.08 MB per week at indent 2 —
  ~37 MB a season is an open sizing decision. Player-typed seeds are not recorded (limit, stated).
  **(3) Gameday published a different graph than daily (F17).** `gameday.yml`'s lock path now runs
  build_predictions → archive → `build_leg_pool` → `build_my_cards` → `build_parlay_ledger` →
  both resolvers (continue-on-error, every mode) → review → validate → commit, so GAME and MY move
  together under one generation and every offered leg and card has a pre-kickoff receipt when a
  window fires before kickoff; the absent `espn_scores_cli` placeholder is deleted and scores mode
  is stated honestly (resolve_locks → archive → resolvers → review). `docs/PIPELINE_GRAPH.md` is the
  table. F16 (the publish race) and per-stage watermarks remain open. **Locked by**
  `tests/feature/r87_same_game_pairs.test.mjs`, `r87_my_cards_parity.test.mjs`,
  `r87_my_cards_record.test.mjs`, `r87_gameday_graph.test.mjs` (step order read from the YAML,
  the placeholder's absence, every lock-path script present with stdlib-only module imports), the
  two new contracts, three new `--selftest`s in smoke. · **LOE** 2 d
- **R88 · Pipeline reliability — race-safe publish and per-stage status — built 2026-09-19 (F16,
  F17 remainder).** **The publish loop could not recover from divergence (F16).** Every workflow
  ended in `git pull --ff-only && git push`, retried five times; once another writer (gameday vs
  daily, or an owner code push) had landed from the common base, a fast-forward could never
  succeed and a whole valid generation was thrown away with exit 1 — and R87 had just made Sunday
  the first day two workflows do heavy work in one window. **Changed:** `scripts/publish_data.sh`
  commits the staged `data/` once, then re-creates that commit on the new head (`git fetch`, `git
  rebase`), resolving every conflict deterministically: an APPEND-ONLY ledger (`data/estimates/
  <season>.json`, `parlays_<season>.json`, `my_cards/*.json`, `parlays/*_wk*.json`,
  `model_tuning.json`) is merged **by identity** with `scripts/merge_ledgers.py` — union by key,
  the earlier first sight wins a same-key race, a side that changed an entry the other left alone
  wins that entry, runs/history unioned in their own order (model_tuning is newest-first and keyed
  by `(generated_utc, kind)`; the player ledger is written compact, and the merger matches each
  writer so a raced commit carries no churn) — every other `data/` path takes the replaying run's
  version, a conflict outside `data/` aborts loudly; `validate_data.py` must pass while the rebase
  can still be abandoned; five attempts, `::error::`, exit 1. Never a forced push, never a
  fast-forward-only pull. Proven in `tests/feature/r88_publish_race.test.mjs` on a real bare
  remote with two clones: two generations from one base keep both ledgers' entries and both
  `runs[]`; an owner code commit mid-run replays cleanly; the same leg key on both sides keeps the
  earlier `seen_utc`; a refusing validator aborts with main untouched; a rejecting remote fails
  after exactly five attempts. Merging each committed ledger with itself is byte-identical.
  **A step could fail and the run stay green with no trace in the product (F17).** `continue-on-
  error` resolvers, the replay lab and the narrative could fail silently; `pipeline_status.json`
  is written inside build_predictions and never sees the later steps. **Changed:** every pipeline
  step in daily, gameday and backtest runs through `bash scripts/stage.sh <workflow> "<step>" --
  <command>`, which records status / exit code / duration / `last_success_utc` per stage into
  `data/pipeline_stages.json` (`scripts/stage_status.py begin | record | skip`; gameday's scores
  mode records its skipped lock-mode stages with a reason) and exits with the command's own code,
  so every `if:`, `env:` and `continue-on-error:` keeps its meaning. The MODEL tab gains
  **PIPELINE STAGES · EVERY STEP, AS IT RAN** (MEASURED): per workflow, stage / chip / last
  success / duration, and one `degraded: <stage> failed at <utc>; last success <utc>` line.
  `last_success` cannot know about a stage that was green before R88, so the first documents read
  NEVER honestly. **Locked by** `tests/feature/r88_publish_race.test.mjs` (15),
  `r88_stage_status.test.mjs` (15: exit-code propagation, the carry, the skip verb, the contract,
  every workflow's `begin` step and wrapped command text, the exact publish messages, no
  `--ff-only` anywhere), `pipeline_stages.schema.json` in the validator, `stage_status --selftest`
  in smoke, `docs/PUBLISH.md` and the R88 section of `docs/PIPELINE_GRAPH.md`. · **LOE** 1.5 d
- **R89 · MY PARLAYS type-ahead and an honest empty state — built 2026-09-19 (owner report:
  "the player search does not function").** Reproduced on the exact prod code and data: the seed
  input accepted only an EXACT name chosen from the browser's native `<datalist>` — "goff",
  "aaron jones" or "j allen" + Enter did nothing, 16 pool names carry a suffix a person never types
  ("James Cook III", "Aaron Jones Sr."), iPhone Safari's native popup is unreliable, and the 17
  DET/BUF players whose game went FINAL on Thursday were still offered and then answered "No
  upcoming card is available for those names" without saying why. **Changed:** our own type-ahead
  — `matchSeeds(options, query)` normalises both sides (NFD, diacritics stripped, punctuation to
  spaces, suffix tokens dropped) and ranks exact → team abbreviation → prefix of the full name →
  a whole token (a surname typed in full beats a longer token that merely starts with it, so
  "cook" is James Cook III before Brandin Cooks) → every query token prefixes a name token with the
  first token first → any token prefix → substring, ties A→Z, top 8 — rendered as a `role=listbox`
  under a `role=combobox` input with 44px rows, arrow keys, Enter (first match by default), Escape,
  tap (pointerdown so iOS blur cannot swallow it), and a `GAME FINAL` tag on any seed with no
  upcoming leg. `emptyReason(seeds, legs, games, poolWeek)` replaces the fixed sentence: *"Josh
  Allen: DET @ BUF is final; cards are built only for games that have not kicked off, and BUF's
  next cards arrive with the week 3 pool."* **Also fixed under the same gate:** gameday now runs the
  player backtest after it rebuilds player_history.json (gameday 123 had left
  `player_backtest.json` reporting 0.6766 coverage against a history measuring 0.6910, reddening
  the r49 pin on a data commit), and the R88 test no longer forbids the runner-committed stage
  record. **Locked by** `tests/feature/r89_my_typeahead.test.mjs` (26: ranking, suffixes,
  diacritics, initial+surname, teams, limit, every empty-state sentence) and
  `tests/web/r89_my_typeahead.spec.mjs` (phone 402×874 and desktop: the FINAL row and its reason
  derived from the committed schedule, a lower-case surname → cards, arrow keys, tap, Escape, no
  overflow, no console errors). · **LOE** 0.5 d
- **R90 · Slate truth and Parlays first screen — built 2026-09-19 (F11, F12, F13, F18, F19, F20).**
  **F11** a successful gameday refit replaced the whole `game_params` object, silently dropping `k`,
  the applied `qb_out` family and anything else promoted. `refit.next_game_params` now deep-copies
  the current object and replaces only `hfa_elo`, `revert`, `adopted_utc`, `source` and a new
  `adopted_version`; the history entry carries the FULL effective object as the receipt build_
  predictions reads; refusal writes nothing (locked by `r90_refit_merge.test.mjs`, byte-for-byte on
  the committed params). **F12** an open week's archive replaced every card on any rebuild, so a
  Thursday card could change after Thursday's result and a rank-based `parlay_id` could name a
  different bet. Every archived card now carries a `card_id` (sha1 over scope, game and the SORTED
  legs — leg order and rank excluded) and FREEZES at its earliest relevant kickoff: the archived copy
  is kept verbatim with `frozen_utc`, a rebuild may neither replace nor remove it, a rank change
  appends a new card, and the week still closes when every game is FINAL; the committed week-2
  archive froze **19** cards on DET @ BUF (3 game cards + all 16 week cards carrying `BUF ML`), a
  second run writes zero bytes (`r90_card_freeze.test.mjs`, contract, `docs/PARLAY_HISTORY.md`).
  **F13** a past week's Slate showed probabilities recomputed by today's model while its dot graded
  the ORIGINAL pick (game 401872657: locked 62.67%, displayed 48.67% — the favourite flipped on
  screen). The review layer now paints the LOCKED forecast on every graded card, the final score,
  and one provenance line `LOCKED <utc> · recomputed with today's model: 49%`, so the recomputation is
  an explicit secondary figure; a past game with no lock on file reads `no pregame forecast on
  file` and no number (`r90_slate_truth.test.mjs`, `r90_slate_truth.spec.mjs`; the flipped-favourite
  fixture renders the locked favourite). **F20** the why-this-result expansion was a click on an
  article; it is a real `Why this result: NE at SEA` button with `aria-controls`, Enter/Space,
  Escape and focus retained across repaint; the Slate and Parlays week/scope controls are grouped
  buttons with `aria-pressed` and Left/Right arrow keys instead of tabs without tabpanels; the
  repeated WEEKS toggle carries `Weeks: <player>`. **F18** at 402×874 the first curated parlay
  started at **1,217px** with a 465px always-open glossary above it. The glossary is a collapsed
  `HOW THESE NUMBERS WORK` (62px), leg count / tier / sort live in one collapsed `FILTERS · 3 LEGS ·
  HIGH · SIM EV` panel (56px, state in the summary, persisted per viewer in
  `nfl2026.parlays.filters.v1`, cleared by RESET ALL), and the outcome buckets and P&L are hidden
  entirely on a week with no graded parlay. **After:** first card top **733px** against a tabbar at
  817px — a real bet is on the opening screen; 668px at 1280×900; no horizontal overflow
  (`r90_parlays_ux.spec.mjs` measures it). **F19** the placeholder example `J. Jefferson, KC` now
  works verbatim (typed text splits on commas, each part seeded in order); a name the pool does not
  price gets its reason in the row — position with no calibrated market, not playable this week
  with the status, no projection on file, or not priced in this week's pool — from a lazy join of
  player_weekly and player_projections fetched only on the first typed miss (zero fetches on a cold
  #/parlays load or the MY tap, asserted); the typed text is never cleared; the legend states that
  a card contains AT LEAST ONE seed, not all. Boot graph re-measured 369,024 (+2,082: slate.js and
  render.js), ceiling re-set with the written decision in `tests/perf/budget.spec.mjs`. · **LOE**
  2 d
- **R91 · The adopted QB-out signal fires in season — built 2026-09-20 (owner: "explain why the
  model likes the ATL money line").** CAR @ ATL priced Atlanta at **61.4%** against a fair-market
  41.7% with Michael Penix Jr. OUT (knee) and Tua Tagovailoa DOUBTFUL (oblique): the number was
  pure Elo (ATL 1475.8, CAR 1440.1) plus 45 home, 80.7 points, and carried NO quarterback
  adjustment. Two faults. **(1)** `data/injury_history.json` carried seasons 2021-2025 only: the
  nflverse release for a season in progress is ~600 rows at week 2 and the 2,000-row partial-pull
  floor refused it every day, so the game model's adopted `qb_out` family (75 Elo when the
  primary passer is Out/Doubtful) had fired **zero** times all season ("0 team-weeks with QB
  listings" on every build) while the player gate, reading the daily report, had already pulled
  every Atlanta quarterback's props. **(2)** the prediction-time "primary passer" was last season's
  dropback leader — for Atlanta, Kirk Cousins, who no longer plays there — so the signal could not
  have matched Penix even with the rows. **Changed:** `CURRENT_MIN_ROWS = 50` for the season in
  progress; a current-week OVERLAY from the daily ESPN report (`overlay_current_week`, ids by
  name from `data/depth_chart.json`, release team-weeks never overridden, the overlay fills what
  the release lacks); and `qb_out_current` takes the depth chart's rank-1 QB as the primary when
  the chart names one (the dropback leader remains the preseason fallback). The walk-forward
  measurement that adopted the family is untouched. **Measured locally on the committed inputs:**
  47 team-weeks with QB listings, fires for ATL (Penix), MIN (Murray) and SEA (Darnold): CAR @ ATL
  home **61.4% → 50.8%**, MIN @ CHI home 58.1% → 68.1%, SEA @ ARI home 33.4% → 43.5%. Locked by
  `tests/feature/r91_qb_out_live.test.mjs` (overlay shaping and precedence, the depth-chart
  primary over the stale leader, Questionable never fires, the fallback). Open, by owner order
  (R92): a DEPTH cascade — a further drop when QB2 is also out and the replacement's own
  capability, extended to every key position on offense and defense and carried into the
  player, game, week and MY parlay numbers — measured on the walk-forward before it ships. ·
  **LOE** 0.25 d
- **R92 · Availability depth cascade, phase 1 (measure only) — built 2026-09-20 (owner order: a drop
  when QB1 is out, another when QB2 is out, then the replacement's capability, for every key
  position, carried into the player, game, week and MY numbers).** Two walk-forward measurements,
  nothing adopted, no shipped number changed. **Game side, `qb_depth`** (`scripts/
  backtest_qb_depth.py` → `data/qb_depth_backtest.json`, 2022-2025, 2,174 team-games, every depth
  order known): QB1 listed Out/Doubtful **118** team-games; **QB2 also out: 2; a third-string or
  deeper start: 1** — the second and third terms of the order cannot be estimated on this corpus,
  and the grid's best value for the QB2 extra is 0 because it had nothing to learn from. Four
  candidates against the shipped `qb_out` 75 (held-out log-loss 0.63450 pooled): `qb1_out` 0.63547,
  `qb1_qb2` 0.63547, `capability` (300 × EPA-per-dropback gap, replacement level pooled by passer:
  −0.07 / −0.23 / −0.29 / −0.28) 0.63541, `combined` (qb1 50 + cap 200) 0.63491 — every CI spans
  zero, verdict **none**; the capability term is the one with a pulse (wins 2 of 4 folds). The
  family is registered PROPOSAL-ONLY in `promote_signals` (14 families; the weekly gate measures it
  beside `qb_out`, never double-counting QB1: the trial stacks on the incumbent minus `qb_out`,
  `build_predictions` prices `qb_depth` instead of `qb_out` when it is applied, adoption retires
  the `qb_out` block) and `game_params` is byte-unchanged. **Player side, `backup_qb`** (`scripts/
  backtest_backup_qb.py` → `data/backup_qb_backtest.json`, the R51 weekly substrate, 8,279
  player-weeks, 77 backup-start team-weeks): with a backup starting, actual over the shipped
  weekly number is **RB 0.928, WR 0.842, TE 0.873** (baselines 0.982 / 0.923 / 0.989), and at a
  capability gap above 0.15 EPA/dropback **RB 0.64, WR 0.77, TE 0.82**; the QB row reads 1.64
  because the replacement is playing a full game against his own low baseline. Ten candidate
  factors: `cap_gap_RB` and `backup_flat_WR` clear the weekly never-regress by one part in a
  thousand of pooled MAE, both bootstrap CIs cross zero and the fitted parameters flip sign
  between folds — measured, not adopted; no builder reads the file. Both backtests refresh in the
  weekly backtest workflow (continue-on-error, they need the nflverse depth-chart releases) so
  2026 adds the team-weeks history lacks. Contracts, `--selftest`s in smoke, `docs/
  QB_DEPTH_CASCADE.md`, `docs/BACKUP_QB_CASCADE.md`, `docs/SIGNAL_REGISTRY.md`. **Locked by**
  `tests/feature/r92_qb_depth.test.mjs` (12) and `r92_backup_qb.test.mjs` (7); `rel18_families`
  now locks 14. **Phase 2 waits on data**, not code: the capability term is the candidate to
  watch, and other units (line, edge, secondary) follow the same measure-first path. · **LOE**
  1.5 d
- **R93 · Independent review of R87…R91, P0/P1 fixes — built 2026-09-20 (owner order: A, an
  independent review of the five releases, run alongside B).** The review (`docs/qa/
  INDEPENDENT_REVIEW_R87_R91.md`, 17 findings G01–G17) found two P0s and five P1s; seven are
  fixed here, the rest are logged with their evidence. **G01 (P0) — the injury overlay is rebuilt,
  not filled.** `build_injury_history` made presence, not freshness, the precedence rule for the
  current week: the release, or yesterday's own overlay, owned a team-week and the daily report
  only filled gaps, so the week froze at its first run — typically Wednesday, when a quarterback
  is Questionable and the adopted signal is defined not to fire; Friday's Out never landed. The
  current week is now rebuilt from today's report on every run: report rows (stamped `as_of_utc`)
  replace every team the report covers, release rows stand for the teams it does not, rows from an
  earlier report are cleared first, and every week before the current one stays release-only —
  the walk-forward history the adoption was measured on is byte-identical. **G07 (P1) — one status
  vocabulary.** `STATUSES` knew three words, so 39–41 rows of every daily report — including a
  quarterback on injured reserve — were dropped silently. IR / PUP / NFI are admitted as the
  file's `Out` (the word `promote_signals` reads) with the report's own word kept in
  `designation`; an unknown spelling fails the builder loudly. The overlay keeps 109 rows, not 68,
  and a rank-1 QB on IR fires `qb_out`. **G02 / G05 / G06 (P0, P1, P1) — a raced publish keeps
  both writers' work.** `merge_ledgers.py` learned the three shapes it was silently clobbering:
  `data/parlays/*` (cards merged by `card_id`, frozen cards never dropped, the week never closed
  by the loser), `data/pipeline_stages.json` (per-workflow blocks, `last_success` carried as the
  max) and `data/snapshots/*_games_open.json` lock receipts (merged by `event_id`, `resolved`
  monotone, the earlier `locked_utc` kept); `publish_data.sh` routes receipts to the merger and
  dies on any other snapshot conflict instead of guessing. **G03 (P1) — `parlay_id` is unique
  again.** A post-kickoff rebuild appended a live card next to a frozen one wearing the same
  rank-derived name (17 pairs in one committed week) and every consumer joined on it. An incoming
  card whose id is taken is renamed `<parlay_id>~<first 6 of card_id>` (stable across re-runs),
  frozen cards are never touched, and `build_review` / `app/review.js` join on `card_id`. Ten
  rebuilds: the file settles, no new duplicates; the 13 legacy frozen/frozen pairs are left as
  the freeze contract requires. **G04 (P1) — locked truth on the current week.** F13's fix was
  gated per week, which excluded the pipeline's own week; DET @ BUF graded a 65% lock and printed
  69%. The whole-week guard is gone; historical truth is decided per card from the review row and
  the game's FINAL status. **Open (P1/P2):** G08 (`depth_chart.json` is QB-only, so overlay rows
  carry `id: null`), G09–G12, G13 (MY cards 3.49 MB / 1,456 cards on disk), G14 (boot budget has
  zero module headroom), G15 (pooled `same_game_pairs` verdict), G16 (text-pinned assertions),
  G17 (roadmap claims without a test). **Locked by** `r88_publish_race` (19), `r91_qb_out_live`,
  `r90_card_freeze`, `r90_slate_truth`, `tests/web/r90_slate_truth.spec.mjs`; the builders'
  `--selftest`s prove the Q→Out downgrade flips `qb_out_current`, that an earlier week is never
  rewritten, and that seasons 2021–2025 are byte-identical across a merge pass. · **LOE** 1.5 d
- **R93a · the overlay is filed under the week being played (G18, P1) — built 2026-09-20 (found
  verifying R93 on the runner, not in the review).** R93 shipped green and the first pipeline run
  after it filed all 131 report rows under week 1. `build_injury_history` took the current week
  from `data/game_predictions.json`, and in the daily workflow `scripts.build_all` rewrites that
  document to a week-1 FIXTURE placeholder two steps before this builder runs (`build_predictions`
  restores the real week four steps later). So the freshest report replaced the week-1 RELEASE
  rows of 30 of 31 teams — the walked-forward record of a week already played — while week 2, the
  week being priced, kept only the release rows the report was there to refresh. The live number
  was right anyway: the nflverse release already covered ATL week 2 with Penix listed Out, so
  `qb_out` fired and CAR @ ATL held 50.8%. What was lost is FRESHNESS — a Friday downgrade the
  release has not published yet could not reach the model, which is the whole of R91 — and the
  2026 week-1 record. The week now comes from `data/schedule_full.json` (the earliest week not
  entirely FINAL, the rule `build_predictions.current_week` already uses), which no step rewrites
  to a fixture; `game_predictions.json` is the fallback for when no schedule is on file. And
  `clear_current_week` now drops a report row set found on ANY week, not just the current one,
  since the daily report describes the week being played and nothing else. Replaying the runner’s
  own step order locally — `build_all`, then this builder — files 131 report rows under week 2 and
  leaves week 1 release-only. **Locked by** two tests in `r91_qb_out_live` (the placeholder is
  ignored, the fallback still works, a misfiled report row set is cleared while release rows stand
  on every week) plus the builder `--selftest`; all three go red on the old rule. **Lesson:** this
  file was verified locally, where the committed `game_predictions.json` already said week 2 and
  the defect could not reproduce. The runner’s step order is part of the contract. · **LOE** 0.25 d

- **R93b · the pricing gate and the validator agree on a game day (G19, P0) — built 2026-09-20
  (daily run 149 went red at its last step).** `this_week_gate` deliberately stops gating a team whose
  game has gone FINAL, because a played week is never retro-zeroed. So once the early window ended, a
  player listed out kept `avail: false` on his week row while `this_week.playable` went quiet — and
  `playable_this_week`, which the leg pool and the slate props both gate on, read only the second fact.
  `check_no_unplayable_legs` has always demanded BOTH, so the pool priced Jordan Mason and A.J. Brown,
  each on a team whose week-2 game had finished, and the pipeline red-lined AFTER every number had been
  rebuilt. The gameday workflow failed on the same fact minutes later, so both workflows were blocked.
  R93a is what surfaced it: filing the daily report under the week being played is what finally zeroed
  those week rows. `playable_this_week` now takes an optional week and refuses a row whose week carries
  `avail: false`; `build_leg_pool.prop_legs` passes the pool’s own week and `build_props_by_game` passes
  each game’s. Omit the week and the R77 behaviour is byte-identical, so no other caller moves. **Locked
  by** a new case in `r77_playable` that reproduces run 149’s exact row shape and asserts both halves:
  the pool refuses the sitter when told the week, would still have priced him without it, and the
  validator reds the same leg on the same words — red when the week check is removed. · **LOE** 0.25 d
- **R93c · the ghost click that ate the seed it had just made (P1) — built 2026-09-20 (found
  root-causing a red browser test, not reported by a user).** MY commits a type-ahead pick on
  POINTERDOWN, because on iOS the blur that follows a tap swallows the pick otherwise, and it repaints
  synchronously. So by the time the finger LIFTS, the page under it is a different page. Measured on a
  402px phone: suggestion row 0 spans y299-343, and the seed chip the repaint renders spans y306-350 —
  37 of that row’s 44 pixels — and that chip is itself a remove button. The tap’s own trailing click
  therefore deleted the seed it had just added: 4 of 4 seeds tried, leaving an empty box and no cards,
  which is the exact "the search reads as dead" symptom R89 was written to kill, reintroduced by R89’s
  own overlay. Tapping row 1 had a second victim: once the list closes the risk dial slides under the
  finger, and the ghost click flipped EVEN to SAFE — which is PERSISTED, so a sticky preference nobody
  asked for. Desktop escaped only by accident of width, which is why no desktop test caught it. The
  trailing click now belongs to no control and is eaten once, disarmed by the NEXT GESTURE rather than
  by a clock: a timer is wrong in both directions, letting the ghost through on a press held past the
  timeout and eating the viewer’s next real tap after a press that never became a click. **Locked by**
  three cases in `r89_my_typeahead`: the tap lands on the printed NAME (width-independent, so a kinder
  pool cannot mask it), a 1.2-second press still keeps its seed, and an abandoned press does not eat
  the next tap. All three go red on the timer form and on no guard at all. Also in this release, the
  MY list’s expected SHAPE is derived from the slate the way its seed already was: R83 caps a card at
  two legs from one game, so two unplayed games can only build a 4-leg card and MY correctly paints 6
  cards under 3 eyebrows. Seven assertions hard-coded to ten and five went red on committed data with
  no code change. Seeding one, two, three or all four upcoming teams gives the identical 6 cards — the
  seed was never the ceiling, the unplayed-game count is. On a full slate the assertions still demand
  exactly ten and five. And when a week is over, `_myseed` now reports that condition instead of
  throwing at import, so a finished slate skips the MY specs with a stated reason rather than failing
  fourteen tests with a module-load error. · **LOE** 0.5 d
- **R94 · Does rain matter? phase 1 (measure only) — built 2026-09-20 (owner order: "Rain has to
  matter. The ball is wet, the QB's numbers should be down and it's harder to catch. Call it 8% off
  in heavy rain. Is that in the model?").** It is not in the model: `scripts/signals/weather.py`
  carries the 8% haircut as a constant with **zero call sites**, the shipped player factor prices
  roof and cold and no precipitation, and `game_params` carries no weather key. One power-gated
  walk-forward measurement, nothing adopted, no shipped number changed, **no signal family
  registered** — the promotion gate's family set and its Bonferroni divisor are untouched, so
  `rel18_families` and `rel7_contracts` need no edit. `scripts/backtest_weather.py` → `data/weather_backtest.json` (runner-built, OPTIONAL),
  2021-2025 REG: `corpus_filter` reads **893 rows read, 893 joined, 19 dropped as relocations, 874
  kept**, and every survivor is independently confirmed `outdoors` by nflverse's own roof column
  (`roof_check_ok`) — **1,748 treated team-games**, 854 roofed placebo, 32 open retractables never
  pooled; the CONTROL arm re-prices **8,279** R51 rows. **The unit is the decision.** Every n below
  is the four SCORED folds, because the neutral first fold fits nothing: at the game level the
  stratified wet cell is **24 team-games** against an MDE of **4.87** QB points, when the owner's
  8% restates as 1.32 — a sample that can only see an effect nearly four times the claim cannot
  test it. The same wet games carry **786 wet attempts** against 3,235 dry, MDE **0.0581** modelled
  and **0.0964** realized against 0.052 — so the denominator move was necessary and still not
  sufficient, and the play level ends up much closer to answerable than the points level ever was.
  Ten pre-registered terms, the power table written before any coefficient is fitted and on the
  rows that coefficient is fitted on: **0 powered, 10 not**. `powered` requires BOTH minimum
  detectable effects — the modelled pooled-binomial one and the realized one built from the
  estimator's own binding clustered error (mde_z × max(se_fold, se_stadium)), which on this corpus
  runs 1.06x to 2.12x larger. The closest miss in the grid is `wind_epa_per_dropback` at 0.039903
  modelled / 0.040479 realized against 0.033, and it has the most convincing ladder in the file.
  Verdict **not_powered**, `adopted` false, `families_registered` empty — a harder answer than
  `none`: the corpus cannot test the claim that was made, rather than having tested it and come up
  short. **Rain costs about 3.5 percentage points of completion rate** held-out (marginal 3.4,
  stratified 4.7) — a BOUND, not a null, and a wide one: the point estimate is smaller than the 8%
  claimed, but this corpus could not have separated the 8% from zero either with **four folds**.
  The THRESHOLD would have refused all ten terms independently: three degrees of freedom put the
  primary's bar at **0.201** — twenty percentage points of completion rate. `not_powered` and
  `below_threshold` are the same shortage counted twice, and the shortage is folds. Two findings worth reading: the PLACEBO arm on roofed games that had no weather
  returns **−0.0502 with a CI excluding zero**, larger than the treated estimate and on 13 passer-
  weeks, so it is reported as a diagnostic and never a gate; and the CONTROL arm says the shipped
  weather factor DOES beat deleting it (6.003032 vs 6.008667 pooled MAE) while a FLAT split beats
  both at 5.999077 — something R51's gate, which only asks whether v2 beats v1, structurally cannot
  see. REACH on 2026 week 2: **0 of 1,229 rungs** move beyond the pool's own ECE and **0 games on
  the slate reach the threshold at all**. The shipped `rb_wind` 0.95 penalty was re-measured and its
  sign holds (−0.581 on 110 scored team-games, unpowered) — **the constant does not move on this
  evidence**. `data/weather_history.json` is never rewritten: the relocation filter lives in the
  reader and the file's sha256 is published in the artifact and asserted unchanged across a full
  run, so R56's exact-equality pins stay green untouched. Also ships
  `scripts/archive_weather_forecast.py`, an append-only pre-kickoff forecast archive — the only
  route to a leakage-free phase 2, since the repo holds zero archived forecasts for 2021-2025.
  Contracts, `--selftest`s in smoke, `docs/WEATHER_EFFECT.md`, corrections to
  `docs/WEATHER_HORIZON.md` and `docs/SIGNAL_REGISTRY.md`. **Locked by**
  `tests/feature/r94_weather.test.mjs`, which after the R94 adversarial audit also recounts the
  power n season by season, locks the two-MDE conjunction and forbids a `monotone: true` decided by
  a dose-response band under `adoption_rule.min_band_n` or by fewer than three voting bands. The
  ladder is tabulated on the SCORED rows too, so **no published quantity in the artifact is
  computed on data the estimator never used** — the lock holds that as an identity, each term's
  five band n's summing exactly to its own `n_treated_rows + n_control_rows`. All ten terms read
  `monotone: false`: five on genuine reversals across hundreds of rows, the primary and
  `rain_heavy_completion_rate` for having too little ladder to read at all (2 and 0 voting bands). The Tuesday cron builds the rate corpus
  into `$RUNNER_TEMP` and points the measurement at it with `--cache-dir`, so the 11.7 MB real pull
  never lands in `data/` and the committed `data/fixtures/wet_rates/` placeholder stays synthetic.
  **Phase 2 waits on folds, not code:** extending the corpus
  backwards is the single change that would most alter this document, and the forecast archive is
  what makes a leakage-free version possible at all. · **LOE** 1 d
- **R95 · main went red three times in one night, all from the calendar (P0/P1) — built 2026-09-21.**
  None of the three was a code regression. Week 2 became simultaneously the CURRENT week and a GRADED
  one, and three separate things that had only ever been exercised on a fresh slate broke at once.
  **(a) The replay lab went stale because gameday rebuilds its inputs and never rebuilds it.** `daily.yml`
  declares the lab; `gameday.yml` did not, while running the archive, the leg pool and both resolvers.
  Gameday froze one more card and `data/replay_lab.json` then described inputs that no longer existed —
  six count differences, nothing else. Proved by running the suite at `359a59c` (the last commit from a
  workflow that DOES run the lab), where it is green, against `845972d`, where it is not: one commit, one
  missing step. This is the THIRD instance of the class (R92’s `resolve_estimates`, this, and every count
  a test pins to one afternoon). The lab step is now in gameday between the MY-card resolver and the
  review build. **(b) Five tests pinned a number measured on one afternoon’s data**, and each was
  replaced by the property it stood in for, never by a looser bound: the replay oracle now replays one
  archived card at a time with that card’s own leg prices (R90 lets one rank id carry several archived
  probabilities — 22 of week 2’s 167 legs do — and a flat price map silently replayed a frozen card at a
  later card’s price); the leg-pool floor ceiling became "the search is not biased toward the floor
  RELATIVE to what the dial makes eligible" (14.96% against 47.46% eligible, with a live undialled sweep
  reproducing the pre-R86 fault at 99.84% as the non-vacuity proof); the MY parity bar became
  `liveTeamSeeds × 2 × min(2G−1,5)`, which demands 320 cards on a full slate where the old bar asked for
  200; the flipped-favourite fixture is derived from the feeds by the property that makes it the fixture
  (six games qualify today) rather than pinned to one game and its two numbers, one of which the daily
  refit owns; and R93’s duplicate-id count became the inequality it stood for (the old rule ADDS
  duplicate ids, the new one adds none), after the evening’s gameday run froze another card and moved 17
  to 16. **(c) F18 stopped being true.** "A real bet is on the first screen" is an owner requirement, and
  on a graded current week three retrospective blocks — the bucket chips (169px), the P&L line (76px) and
  the summary strip (39px) — stacked above the card list for the first time. The first card started at
  y=804 against a nav bar at 817: thirteen pixels of a bet, landing either side of the line between runs.
  The buckets and the P&L now collapse into one closed-by-default `<details>` built from R90’s own
  `.pfilters` vocabulary, remembered per viewer under its own key with the same guarded try/catch, while
  the one-line strip stays expanded as the headline — a collapsed block with nothing above it makes a
  graded week look ungraded. 262px of blocks became one 56px summary; the first card moved 785 → 579,
  clearing the bar by 238px. **Locked by** a test that asserts the promise against a rendered box rather
  than a remembered pixel count (the whole of the first card’s header clears the nav bar, plus
  `toBeInViewport`), one that proves the collapsed panel still carries every bucket count and still
  filters when opened, and one for the persistence. No assertion was weakened or deleted anywhere in this
  release. **Standing risk, not fixed here:** `[skip actions]` on every data commit means CI never runs
  against the data the pipeline actually ships, which is why main kept going red unobserved; and the R87
  graph test checks the relative ORDER of a named chain, so a whole missing step slips through. A gate
  asserting daily and gameday invoke the same set of document-writing scripts would have caught (a). ·
  **LOE** 1 d
- **R96 · the fantasy endpoints get the retry the scoreboard already had (P1) — built 2026-09-21
  (daily run 160 died on one connection reset, two hours before kickoff).** `fetch_current_pro_teams`
  raised `[Errno 104] Connection reset by peer` on its first page and the whole evening pipeline went
  with it; nothing was built until it was re-dispatched by hand. R86b had already learned this exact
  lesson on the other side of the same feed — run 129, one TLS alert, nothing built that day — and gave
  `espn._get_json` three bounded attempts with linear backoff. But the two fantasy pages reached the
  network directly: `_kona_market_page` called `urllib.request.urlopen` with no retry at all, and
  `_kona_page` had a requests/urllib fork that retried nothing either. One blip on either was fatal.
  Both now route through `_kona_fetch`, which IMPORTS `_TRANSPORT_ATTEMPTS` and `_TRANSPORT_BACKOFF_S`
  from `espn.py` rather than restating them, so the policy cannot drift between the two paths, and
  `_kona_once` is the single place in the module allowed to open a socket. A transport failure is a
  blip and is retried; a non-200 is the feed’s ANSWER and is not, on both the requests and the urllib
  path, because the silent-404 lesson stands; the final failure raises loudly rather than returning a
  thin page that would read as a shrinking player pool. `requests` stays optional and is still never a
  gate dependency. **Locked by** `tests/feature/r96_fantasy_retry.test.mjs` (5), which replays run 160’s
  own `ConnectionResetError(104)`: two resets then a 200 returns the page after three calls with
  [2, 4] second waits, three resets raise naming the url and the error class, a 500 is one call with no
  sleep, both page functions are proven to route through the helper, and the module is asserted to
  contain exactly one `urlopen` and to define neither constant itself. The first two go red on a
  single-attempt loop. **Lesson:** R86b fixed a class of bug in one function rather than at the
  boundary, and the same feed bit us from the other side three days later. **Also here:** the first weekly promotion after R92 ran that
  same night and took the Bonferroni divisor 13 → 14 with `qb_depth`, exactly as R92 designed, which
  reddened an R94 assertion that had pinned the divisor at 13. R94 adds no family — the 13 was a
  snapshot of the afternoon before `qb_depth` first ran. The assertion is now the property it stood
  for: the divisor equals the count of families that actually ran, and not one of the ten terms R94
  measures has become a family, derived from the artifact's own term names so a future term is covered
  without editing the test. `weather_wind` is a pre-R94 candidate and still runs every week, measured
  and never adopted. Worth knowing: `t_crit` rose 6.4102 → 6.5797, so every other family's adoption
  bar is now harder, which is correct Bonferroni behaviour and the price R92 knowingly paid. · **LOE**
  0.25 d
- **R97 · a season-ending injury, and an injuries outage, each stopped the pipeline publishing
  anything (P1) — built 2026-09-23 (daily run 166 failed on both at once).** Two separate defects with
  one shape: a condition the builder degrades around correctly turned into a total publish failure, so
  a run that should have shipped slightly-worse data shipped none. **(a) The out-for-the-season
  invariant read weeks that had already been played.** `build_weekly` is called with `first_week = wk`
  — *mandatory, not cosmetic*, per its own Rel17 note: an absence blocks weeks FORWARD from the current
  week, because a game already played is history and rewriting it would be a lie about the past. The
  validator's rule 2 nonetheless required EVERY non-bye week to score zero, and rule 2's twin required
  every one of them to carry `avail:false`. From week 2 onward the two are in flat contradiction: the
  moment a real player is ruled out for the year mid-season the producer writes the only document it
  can, and the gate reds it. That is what `espn-4259147` did on 2026-09-22; run 167 passed only because
  the report row churned away, so the landmine re-armed itself rather than being cleared. Both rules now
  read the non-bye weeks from `model.this_week.wk` on — the weeks the ruling can actually speak for —
  and are unchanged everywhere else, including the week-1 case where the two sets are the same thing.
  This is the *only* narrowing in the release, it is the producer's documented contract rather than a
  convenience, and the strict form is proven to red a correct document. **(b) An injuries outage wrote
  a null age.** The `except` path stamped `{"rows": 0, "age_hours": None, ...}` while
  `pipeline_status.schema.json` types `age_hours` as a required number — so the one document whose job
  is to SAY a feed is down could not be written, and a feed `build_predictions` is otherwise careful to
  degrade around took the run with it. `market_feed_record`, twelve hundred lines above, already had the
  convention right: `999.0`, older than any real feed. **Locked by** three new selftest cases in
  `validate_data.py` (an in-season out-for-the-year card passes; a REMAINING week that still scores
  reds; the gate week left playable reds — the first goes red under the pre-R97 predicate, which is how
  we know it was the bug and not the fix) and `tests/feature/r97_outage_publish.test.mjs` (2): the
  contract really does reject a null age, and an AST scan over `build_predictions.py` proves no feed
  record it writes carries one — 38 records seen, so it cannot pass vacuously, and it names line 1076 on
  the pre-fix source. The structural form covers a feed added tomorrow, not just this one. **Lesson:**
  an invariant written in preseason encoded "week 1" as "always", and nobody watched it meet week 3. A
  check that has only ever run against the first week of a season has not been tested against a season.
  **Standing risk, not fixed here:** both failures were found by reading a red run after the fact, because
  `[skip actions]` on every data commit means CI never runs against the data the pipeline ships (R95's
  standing risk, still open and still the top of the list). **Also here: main was already red, and for
  the same reason in a different costume.** Seven assertions across five files had encoded a moment as a
  law, and the midweek gap broke all of them at once — the pipeline has rolled to a week whose first
  game has not kicked off, so the current week carries no FINAL game, no graded parlays and no
  RETROSPECTIVE panel, all of which is correct. Fixed by deriving the week instead of assuming it:
  `r90_slate_truth` (feature + browser) makes its claim on the newest week that HAS a graded row and
  keeps the stricter "once the current week has kicked off, ITS finals are the ones under test" as its
  own assertion; `r90_parlays_ux` stands on the newest graded week through the product's own week chip;
  `r58_parlay_ledger` counts locked props only for the weeks its stats source actually covers, because
  a leg for an unplayed week is PENDING and the resolver counts it neither way (`if wk not in by_week:
  continue`) — week 3's 42 locked props were being demanded as unresolved. Two more were R93 catching
  up with its own migration: a re-run re-issues a card id (`401872933-g1` → `401872933-g1~e9d2a3`) and
  BOTH forms now sit in week 2's archive, so r75's independent oracle was joining by `parlay_id`,
  silently pricing the superseded card, and disagreeing with the page by $414.64 — it now joins
  card_id-first exactly as `app/review.js` does, the identity case keeps the row's own card_id instead
  of re-deriving it from an ambiguous lookup, and the parlay_id FALLBACK is exercised on the newest
  closed week still entirely in pre-R93 ids, which is what a document with no card_id would have been
  written against. Last, r86's 12.5px void bound now reads 18px only for a grid row carrying an R77
  status chip — the 5.4px the chip adds, inherited by its partner because a row's cards end level,
  measured and written down by this file's own SAFE-dial test months ago; every chipless row keeps the
  tight bound. Nothing was skipped, quarantined or deleted. · **LOE** 0.25 d
- **R98 · LINEUP showed players on the wrong team, and players who were not available (P1) — built
  2026-09-24.** Two defects behind one complaint, each measured before it was fixed. **(a) Wrong team,
  or no team at all.** Checked against all 32 official ESPN rosters on 2026-09-24, **24 of the 300 shipped
  players were on the wrong team**: 15 on no NFL roster at all (Russell Wilson "NYG", Nick Chubb "HOU",
  DeAndre Hopkins "BAL") and 9 who had moved (Ertz WAS→PHI, Cooks BUF→SF, Ford CLE→MIN). Every one came
  from R33's fallback — when the fantasy pool's current proTeamId reads 0 (cut) or is missing, the
  *prior-season* team was kept so a draftable player was not dropped mid-signing. Right in August; in
  week 3 it projects a released player into a lineup and offers him on waivers. The pipeline already read
  every official roster each run (`fetch_roster_ages`) and kept only the age. It now keeps the team too
  (`fetch_rosters`), and `assemble_records` lets it win: official roster → fantasy map → last season. A
  player no *answering* roster lists is dropped through the same `team is None` path a free agent already
  took; if the page of the team he would have been stamped on did not answer, nothing proves he left, so
  he keeps the old stamp and is named as unverified. IR players stay — they are on their team's page
  (Njoku/LAC verified live). Live on the full 395-player pool: 24 moved, 29 dropped, 0 unverified; Justin
  Jefferson stays MIN (the injury feed's name-joined "CLE" was the wrong row — why the fix is id-keyed).
  Standalone and backtest callers are byte-for-byte unchanged. **(b) "Available" players who were not.**
  The waiver wire is this app's pool minus every league roster *as read at the last SYNC NOW*, and that
  read only happened by hand. Owner's rule the same day: *"teams and waivers are updated multiple times a
  day, they should be re-synced automatically 4 times per day."* LINEUP now re-reads the league's rosters
  itself whenever they are over **6 hours** old (a failed attempt waits 30 minutes). An iPhone web app
  cannot run in the background, so this happens on opening LINEUP — the sync module is imported only when
  a refresh is due, so a fresh mount costs nothing. Translating Sleeper ids needs Sleeper's player dump,
  which is **14.7 MB**; the daily runner, which already fetches it once a day, now also writes
  `data/sleeper_index.json` — seatable positions on an NFL team, Sleeper's raw fields — at **148 KB (25 KB
  over the wire)**, and it resolves exactly the players the full dump does (127/127 on the P.T.I. league).
  The automatic path writes the league record only. It never seats, moves or drops a player on the
  viewer's own roster — TEAM's rule that a roster is never replaced without naming the losses stands, and
  `ROSTER_SYNC_MODE` is still `manual` because seating still is. When the viewer's Sleeper roster differs
  from the one seated here, LINEUP *names* who (on Sleeper, not here / here, no longer on Sleeper) with a
  link to seat it. IR-slot players count as rostered but are kept out of the seatable list, so an IR stash
  is never offered as a pickup and never shows as a false difference. When the refresh cannot run, the
  failure is said and the waiver card carries a warning *above* the list with its age — the as-of date
  was already in a footnote, and nobody read it. Found on the way: `normalizeLeagueRosters` stamped the
  clock on every READ, so a record with no timestamp always looked brand new, and marking a seat
  refreshed the age of rosters it had not re-read; both fixed. **Locked by**
  `r98_official_rosters.test.mjs` (7), `r98_league_sync.test.mjs` (8), `r98_roster_age.test.mjs` (6),
  `r98_waiver_freshness.spec.mjs` (6, through the real TEAM sync) and the Sleeper builder's selftest.
  **Not done, and next:** automatically *seating* the viewer's own Sleeper changes needs TEAM's seating
  logic (`planRosterSync`, in a 275 KB view) moved to a shared module so LINEUP can run it; until then the
  difference is named, one tap from being applied. · **LOE** 1 d
- **R100 · self-learning, switched on for the numbers that ship (P1) — built 2026-09-24.** Owner:
  *"enable the self learning ai based on the results of this season, so that the parlay accuracy
  continues to improve."* An inventory first, because "self-learning" was four loops in four states:
  **(1) game model** (Elo home edge / reversion) — already automatic weekly behind held-out never-regress;
  its recent candidates lost, so nothing moved. **(2) slate parlay calibration** (R58) — already
  automatic, arms at 100 graded legs; 81 after weeks 1–2, so week 3 arms it. **(3) player signals** —
  the 9/22 "proposal" read as an improvement waiting on a manual step. It was not: its learned weights
  were age_curve / injury_history / injury_status all at 1.0, exactly what already ships under the R49
  override, and its score (5.5005) *was* the shipped number's (5.5006). The real gap was that this loop
  **could not change what ships at all** — the shipped candidate hard-coded full strength and the loop
  compared itself to the gated series, which never ships. **(4) MY PARLAYS** — fit on 2023–25 only; the
  weekly grades of the cards it offers were recorded and never read back. Measured on week 2: **166
  distinct legs offered at 54.5 % hit 68.1 %**, every band 9–19 points low. **What R100 changes.**
  *Player signals:* the shipped projection reads learned weights (`model_tuning.json
  candidate_signal_weights`; absent = 1.0, byte-identical, proven on live-shaped players), and
  `fit_player_signals.py --adopt` (the weekly workflow now passes it) moves them only when a refit beats
  **what ships** on ≥ 2 held-out weeks by the 0.10 margin with no week worse — and reverts, with no
  margin, when full strength beats them. `validate_data.py` refuses a learned weight whose receipt does
  not support it. Today it holds: one held-out week, and the refit (age_curve 0.75) was slightly worse
  than what ships. *MY PARLAYS:* a plain refit cannot use a few hundred 2026 legs beside 41,314 corpus
  rows, so this season enters as a two-number layer `sigmoid(a + b·logit(p))` fit on 2026 graded legs
  alone, from the probability each leg was actually *offered* at. It applies only with ≥ 100 legs, ≥ 2
  held-out weeks each scored by a layer fit on earlier weeks, pooled held-out log-loss better, no week
  worse, and a positive slope. Simulated at the real weekly size (200 legs), it catches a genuine +14-pt
  underconfidence in **38/40** seasons, touches a calibrated season in **1/40**, and never adopts one that
  turns around (**0/40**). Today it holds (week 2 is the only graded week); **the first week it can switch
  on is after week 4's games.** **Locked by** `r100_self_learning.test.mjs` (6) and
  `r100_pool_learning.test.mjs` (4, rates over 40 seasons, not one seed). **Broken on the way, and
  fixed the same day:** the renamed workflow step read `(R100: auto-adopt …)`, and in a YAML plain value
  `: ` starts a mapping — `backtest.yml` stopped parsing, GitHub listed it by path, refused a manual run,
  and the weekly job that carries every learning loop would never have fired again. The gate was green
  because every workflow test reads the files as text. `r100_workflow_yaml.test.mjs` now refuses a
  plain-scalar `: ` in any workflow, proven on the line that broke. · **LOE** 1 d
- **R99 E1 · anytime-TD model, measured (P1) — S1–S4 built 2026-09-24.** Owner bets mostly anytime-TD
  parlays; the app had no ATD market. `scripts/backtest_atd.py`: P(ATD) = 1 − e^(−λ_team·share), λ from
  shrunk offence × opponent-allowed × home, share = TD share shrunk hard toward carries/targets
  opportunity share, R92 depth cascade (an OUT player's share goes to his position room), team shares
  ≤ 1. Walk-forward on 2021–25, parameters chosen on 2022 alone, universe from snap counts so the
  outcome cannot leak in. **Held-out 2023–25: beats the position base rate and opportunity-only share on
  log loss and Brier every season, calibration slope 1.06 / 1.03 / 1.00 → ADOPTED.** Team TDs pooled
  2024–25 within 2.8 %; 2024 alone ran 5.8 % low (league scoring jumped 7.8 % that year). Runs weekly in
  `backtest.yml`; `validate_data.py` recomputes `adopted` from the receipts. Measure-only: no ATD leg is
  offered yet — that is S5, which reads this flag. **Locked by** 13 tests across
  `r99_td_corpus` / `r99_team_td` / `r99_td_share` / `r99_atd_backtest`. · **LOE** 1 d
- **R101a · anytime-TD legs priced, graded and learning (P1) — built 2026-09-24.** Owner: GAME,
  WEEK and MY to 10 legs with ALL TD / MAJORITY TD / 50%+ SCORERS modes, "aligned to self learning
  AI and continuous improvement". This first slice is the pipeline: `build_atd_week.py` prices this
  week's playable players with the E1 model (imported, one implementation) into `atd_week.json`;
  the leg pool offers them only on an adopted model, for its own week, playable only; one shared
  grader settles them (the owner's 63 ATD player-games regrade, one named book void aside); the
  weekly run re-measures 2026 and can **demote** the model, with the R100 layer as its correction.
  Correlations measured for every same-game pair an ATD leg can sit in. The validator now refuses
  schema keywords it never implemented (R99's contract had two). No screen change yet. **Locked by**
  12 tests (`r101_atd_legs` / `r101_atd_grade` / `r101_atd_learning`). · **LOE** 1 d
- **R101c-1 · anytime-TD modes on WEEK and MY, 2–10 legs (P1) — built 2026-09-24.** Owner chose
  Gate 2 layout B (TD pills ANY / ALL TD / MAJORITY / 50%+ plus a − n + leg stepper, iPhone) and
  "WEEK + MY first". `build_atd_cards.py` builds this week's WEEK cards on the runner — one leg per
  game (so the chance is the product), the leg pool's own prices, only games not yet kicked off, an
  unfillable size refused with its reason — and records each card on first sight;
  `resolve_atd_cards.py` grades them per mode and size (hit rate vs mean model chance), the
  learning record for the card shapes. MY gets the same controls: ALL TD / 50%+ search only TD
  legs, MAJORITY caps the non-TD legs, ANY is untouched. Week 3: ALL TD and MAJORITY at every size
  2–10; 50%+ to 4 legs (four games have a 50%+ scorer). **GAME stays at today's cards** until the
  same-game pricer passes its test. **Locked by** `r101c_atd_cards` (7) and `r101c_td_modes` (3,
  browser, iPhone). · **LOE** 0.5 d
- **R101b · same-game pricer + GAME anytime-TD cards, 2–10 legs (P1) — built 2026-09-24.** The
  game simulator is a two-factor Gaussian copula (`scripts/models/joint.py`: a game-script factor
  signed by side and a scoring factor, loadings per leg type, exact Gauss-Hermite — no seed; every
  leg keeps its own probability). `backtest_joint.py` (weekly) fits it on 2022-23 same-game cards
  and measures 2024-25 two ways: 43,528 random cards decide the pricer (joint log loss 0.091287 vs
  product 0.091129 — **the product wins, so GAME is priced as the product** and the joint model is
  kept measured, not used), and the builder's own cards decide each size (two-sided Poisson on
  all-hit and all-but-one at 5 %, and enough cards to test). Verdict: ALL TD 2–7, MAJORITY 2–10,
  50%+ 2–3; ALL TD 8–10 not offered (too few held-out cards to test), 50%+ 4+ never filled.
  `build_atd_game_cards.py` builds one card per open game per validated size from the pool's own
  legs; the validator re-prices every card and recomputes the verdict; GAME cards are recorded and
  graded apart from WEEK (`game_<mode>`). GAME gets the same TD pills + stepper. **Locked by**
  `r101b_game_atd` (6) and `r101b_game_td` (3, browser, iPhone). · **LOE** 1 d
- **R101d · MY same-game past two legs, and MY TD cards graded (P1) — built 2026-09-24.** Owner chose
  the hybrid: two legs from one game keep the measured pair adjustment; in a TD mode one game may
  supply up to the size GAME validated for that mode (ALL TD 7, MAJORITY 10, 50%+ 3 today), and a
  3+-leg group is priced as the product — the GAME verdict — and says so on the card. A joint (or
  absent) verdict keeps the R83 cap of two: the browser carries no joint pricer. ANY is unchanged.
  `build_my_td_cards.py` records the top MY TD card for every team seed × mode × 2–10 legs (EVEN)
  on first sight in `data/atd_my_cards/`, graded by `resolve_atd_cards.py` as `my_<mode>`; the
  Python twin is parity-locked to the browser on the committed pool. **Locked by**
  `r101d_my_td_parity` (5). · **LOE** 0.5 d
- **R102 · CI runs against the data the pipeline ships (P1) — built 2026-09-25.** Owner's pick. New
  `.github/workflows/data-ci.yml` runs when `daily-pipeline`, `gameday` or `weekly-backtest` COMPLETES
  (workflow_run — not a push, so `[skip actions]` cannot skip it), checks out main as it stands (the
  data commit included) and runs exactly ci.yml's gate and browser E2E. Red opens one issue titled
  `[data-ci] main is red on pipeline data` (or comments on it) and fails; the next green run closes
  it; a superseded check reports nothing. **Locked by** `r102_data_ci` (3). · **LOE** 0.25 d
- **What is next for self-learning and parlays, in order** (owner asked, 2026-09-24):
  1. **R99 E2 — MY BETS ledger + exposure guard.** Your real tickets, graded, measured against the book
     and the model; the warning that would have saved three 9/20 tickets.
  2. **R99 E3 — delivered as R101b/R101d.** The game simulator is re-measured weekly; it becomes the
     GAME pricer (and needs a browser twin for MY) the week it beats the product on held-out games.
  3. **Show the learning.** The MODEL tab's LEARNING RECORD still shows only the old proposal line; it
     should show each loop's live state (held / adopted / reverted, and why) so the owner can see the
     system learning rather than take it on trust.
  4. **Red-zone share** (R99 E1-S7) from play-by-play — the strongest TD signal the free weekly feed lacks.
#### ▢ S1 · Sports task contract — *read side shipped in spirit by R58; the contract is not written*
- `task` values `nfl.game`, `nfl.player_week`, `nfl.parlay_leg` (and `wc.match`), each with a
  declared feature / prediction / outcome shape.
- A validator so NFL snapshots and ledger rows can be checked as Prediction/Outcome rows.
- **MoS:** NFL snapshots + ledger validate against the contract. · **LOE** 1 d

#### ▢ S2 · NFL adapter (read side)
- `SportsAdapter` ingests NFL2026 `data/snapshots/*` and `data/estimates/*` into the store.
- Nightly job, idempotent, `as_of` never later than kickoff.
- **MoS:** 100% of locked NFL rows in the store with `as_of` ≤ kickoff. · **LOE** 2 d

#### ▢ S3 · Scores for sports tasks
- A general scorer emitting per-task, per-cohort (position, week, tier) `Score` rows with Wilson CIs.
- The terminal Scores tab reads them; the MODEL tab keeps reading the repo feeds.
- **MoS:** MODEL tab and terminal show the same MAE for the same week. · **LOE** 1.5 d

#### ✅ Store — *decided 2026-09-16: git-backed, with a written trigger*
- **Git-backed store.** Spine rows ship as JSON committed by the pipeline: reviewable as a diff,
  validated by the gate, revertable with `git revert`.
- Graded against the owner's three criteria — performance **B**, self-learning discipline **A**,
  Claude Code + Codex automation **A** (overall **A**). Supabase graded **C+**: its query strengths
  do not match a workload that reads the whole corpus repeatedly, and it costs an agent the
  diff-shaped audit trail, offline gate validation and `git revert`.
- **The trigger that forces Postgres, written down so the migration has a plan:** a genuine second
  concurrent writer, or a write that must land between cron runs. Neither exists today.
- S2/S3 are unblocked. R57, the other thing this was blocking, is dropped above.

### Q4 2026 (Nov–Jan) — Learn from the record

#### ▢ R59 · Level-bias as a signal
- The regression-to-mean term enters the registry at weight 0 like every other signal.
- The ledger fit may award it weight **only** if it clears never-regress on resolved 2026 weeks.
- Adoption stays a human act; the proposal is archived either way.
- **MoS:** proposal archived with a CI; no silent adoption. · **LOE** 1 d

#### ▢ R60 · Signal proposals cadence
- A weekly `--propose` review page on MODEL: which of the 32 signals cleared, by how much, on how
  many resolved weeks.
- One-click adopt stays manual, and an empty week must render as an honest "none cleared".
- **MoS:** every Tuesday a proposal row exists. · **LOE** 1 d

#### ▢ R61 · Playoff mode
- GRADE: the league playoff bracket with weekly-optimal totals and conditioned title odds.
- LINEUP: playoff-week waiver handling.
- **MoS:** the bracket renders for P.T.I. weeks 15-17. · **LOE** 2 d

#### ▢ R62 · Test-only exports decision
- The 225 test-only exports are either kept deliberately as seams or the tests move to behavioural
  entry points — one written decision, not a drift.
- The dead-code scanner is promoted to a never-regress gate step.
- **MoS:** dead-export count gated at 0. · **LOE** 1 d

#### ▢ R63 · QA-D10
- Tests written alongside the still-unbuilt modules (P3 ensemble, N3 detail) instead of after.
- **MoS:** `QA_COVERAGE.md` ≥ 50%. · **LOE** 3 d

#### ▢ S4 · L1 calibration for sports
- Platt / isotonic calibration per task, applied only once `min_resolved` (default 30) is met.
- Proposed as a `Change` row with a rationale, never auto-applied.
- **MoS:** `Change` rows for `nfl.parlay_leg` and `nfl.game`. · **LOE** 1.5 d

#### ▢ S5 · Never-regress as a registry policy
- Port NFL2026's margin + significance gate into the spine as the promotion rule for any task.
- **MoS:** one policy, two adapters, identical verdicts on the NFL fixtures. · **LOE** 1.5 d

#### ▢ S6 · WC2026 corpus import
- Tournament predictions and results from `wc2026-tracker` imported as a resolved `wc.match`
  corpus — prior work reused as-is, no new data collection.
- **MoS:** the scorer produces Brier / log-loss for `wc.match` with CIs. · **LOE** 1.5 d

#### 🔒 Autonomy threshold
- Confirm `min_resolved` = 30 and which tasks may ever reach L2.

### Q1 2027 (Feb–Apr) — Extract the platform

#### ▢ S7 · Harness extraction
- `scripts/harness/*`, `never_regress`, the signal registry, conformal bands and the ledger
  objective move into `selflearn-core` as packages; NFL2026 pins the package.
- **MoS:** NFL2026 gate green with **byte-identical** `data/*.json` before and after. · **LOE** 4 d

#### ▢ S8 · Second live adapter
- WC2026 (or the next tournament) wired live: predictions logged before kickoff, resolved by the
  results pipeline.
- **MoS:** two adapters, one store, one Scores view. · **LOE** 3 d

#### ▢ S9 · Market yardstick service
- Kalshi / Polymarket / closing-line ingestion as **measurement only**, enforced by policy per task.
- **MoS:** market-vs-ours log-loss on MODEL and terminal, the same number in both places. · **LOE** 1.5 d

#### ▢ R64 · Offseason signals
- Draft, free-agency and coaching-change signals computed for 2027, entering at weight 0.
- Backtested on the 2023-26 corpus.
- **MoS:** each signal has a walk-forward row; none adopted by hand. · **LOE** 3 d

#### ▢ R65 · Rookie model
- The facts-only rookie cards (R45) become a measured projection with its own gate — no invented
  points, and a visible fallback when the facts run out.
- **MoS:** rookie MAE reported against the `prior_ppg` baseline. · **LOE** 2 d

#### ▢ R66 · Contract + boot budget review
- Re-measure the 360 KB boot ceiling and the route contracts after extraction — the honest
  re-measure the budget file already demands, not a bump to turn a red bar green.
- **MoS:** perf project green with reasoned numbers written down. · **LOE** 0.5 d

### Q2 2027 (May–Aug) — Second season ready

#### ▢ S10 · L2 weights across adapters
- The ensemble / weight updater proposes cross-adapter reweights under the registry policy.
- **MoS:** proposals carry CIs and stay human-applied. · **LOE** 2 d

#### ▢ S11 · Multi-sport scores
- Terminal and MODEL render per-adapter learning curves (resolved n, MAE, calibration) from one store.
- **MoS:** both sports on one page. · **LOE** 1.5 d

#### ▢ S12 · Packaging (M4)
- `selflearn-core` published as a zero-dependency package; adapters pin a version.
- **MoS:** NFL2026 and WC2026 both install from the package. · **LOE** 1 d

#### ▢ R67 · Draft room 2027
- Auction-memory epic: observed prices seed the opponent model.
- Sleeper full sync; ADP stays display-only (rule 1).
- **MoS:** the auction sim fills every roster, pricing from memory when present. · **LOE** 3 d

#### ▢ R68 · Pre-season gate
- 2027 corpus refresh; weekly, parlay and player gates re-baselined; the ledger reset for 2027.
- **MoS:** the full gate green on 2027 fixtures. · **LOE** 1 d

#### ▢ R69 · QA coverage ≥ 80%
- The remaining acceptance criteria asserted; self-referential ones retired rather than faked.
- **MoS:** `QA_COVERAGE.md` ≥ 80%. · **LOE** 4 d

## 3. KPIs the roadmap is judged on

| KPI | Now (2026-09-16) | Q4 2026 | Aug 2027 |
|---|---|---|---|
| Weekly MAE (pooled 2023-25 harness) | 6.003 | ≤ 5.95 | ≤ 5.85 |
| Weekly MAE (live 2026, as made) | 6.146 (1 week, n=216) | reported every week | ≤ corpus + 0.15 |
| Weekly rank corr (corpus / live) | 0.381 / 0.366 | ≥ 0.39 | ≥ 0.41 |
| Prop pick hit rate (held-out fold) | 59.9% | ≥ 60% on 2026 legs | ≥ 61% |
| Parlay leg log-loss (live, calibrated) | 0.660 over 37 legs | measured weekly | ≤ 0.650 |
| Moneyline log-loss gap to market | 0.029 | measured weekly | ≤ 0.025 |
| Ledger resolved weeks | 1 | 13 | 18 + WC corpus |
| Resolved parlay legs (refit arms at 100) | 37 | ≥ 400 | ≥ 900 |
| Signals with earned weight | 0 of 32 | first honest adoption or an honest "none" | reported per adapter |
| Adapters on the spine | 0 | 1 (NFL) | 2 (NFL + WC) |
| Acceptance-criteria coverage | 6.1% | ≥ 50% | ≥ 80% |
| Unimported exports / unreferenced defs | 0 / 0 | 0 / 0 (gated) | 0 / 0 |
| Boot bytes (ceiling 360,000) | 359,967 | re-measured, with a written decision | re-based after S7 |

## 4. Decisions the owner must make (🔒)

1. ~~**Shared store**~~ — **DECIDED 2026-09-16: git-backed, with a written trigger.** Graded A
   against performance / self-learning / agent-automation, versus C+ for Supabase. Postgres is
   revisited only on the written trigger: a second concurrent writer, or a write that must land
   between cron runs.
2. **`min_resolved` threshold** (default 30) and which sports tasks may advance past L1.
3. **Market yardstick sources** — which prices may be ingested for measurement only (policy
   stands: never an input).
4. **Second adapter** — WC2026 (prior work, zero new data) or a new sport; recommendation: WC2026.
5. **Extraction timing** — Q1 2027 offseason (recommended) versus in-season; in-season extraction
   risks the live ledger.
6. **2026 FTN charting ingest** — `LAST_FTN_SEASON` is pinned at 2025 and the scheme path is
   deliberately dark. Lighting it needs a never-regress run, not a flag flip.

## 5. Risks

- **Spend limits and runner throttling** interrupt long builds; every release keeps partitions small
  and worktree-resumable, and the branch is pushed after every merge (a container was reclaimed
  mid-release once already).
- **A weak-signal season**: it is possible no player signal clears the gate in 2026. That is an
  honest result and the MODEL tab must say so; the roadmap does not assume adoptions.
- **In-season data drift**: tests pinned to preseason snapshots go red — or worse, silently
  toothless — as the season moves. Six such locks were re-derived in the red-main repair; the class
  is not closed.
- **Boot headroom**: 33 bytes. The next boot-graph addition of any size trips the budget and forces
  a written re-measure. Lazy views are the escape hatch, not a ceiling bump.
- **Extraction parity**: moving the harness must not change a single shipped number; the
  byte-identical gate in S7 is the guard.
- **Policy drift**: any market number found on the input side of a projection is a P0 bug.
