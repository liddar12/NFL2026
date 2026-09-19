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
