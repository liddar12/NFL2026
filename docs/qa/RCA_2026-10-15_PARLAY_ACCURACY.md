# RCA 2026-10-15: why parlay accuracy "fell every week" from week 1 to week 5

**Status:** RCA complete for weeks 1-5. Two week-6 fixes shipped (R125 injury feed, R126 game-card ranking). The rest is a reviewed roadmap.
**Author:** Claude Code, at the owner's request (2026-10-14). The same question went to Codex (Astra). Its independent RCA is on branch `build/week6-correctness-20261014` (`docs/reviews/2026-10-14-week6-rca/`); section 8 reconciles the two.
**Baseline:** `fb8830ae` (2026-10-14), read-only. Numbers come from the committed files and their git history.
**Method:** six independent investigator lenses: metrics, code changes, backtests, data pipeline, market base rates, and leg forensics. An adversarial verifier re-ran the metrics and changes lenses: 22 of 25 claims were confirmed and 3 were confirmed with corrected numbers. The other four lenses were cross-checked against each other and against Codex's independent numbers. A second verification round (2026-10-15, against `fb8830ae`/`279a06e5`) re-ran sections 1-10 and a completeness critic; its corrections are applied. Scripts are listed in section 10.

## 1. Summary

- **The decline is mostly a measurement artifact, not a model that got worse.** Reported curated all-hit went 48.5% (wk1) -> 30.8 -> 24.6 -> 25.4 -> 15.4% (wk5), a 33.1-point fall. Graded on what was actually offered before kickoff, the same weeks are flat:
  - game + week cards incl. push: 25.8, 19.7, 31.8, 33.8, 22.2% (chi2 = 4.9, df 4, p = 0.30; trend z = +0.43);
  - week-scope cards: **1/18, 1/18, 1/18, 8/18, 1/18**. Codex reproduced exactly this series independently.
- **Root cause 1: hindsight cards in the record (about 23-27 of the 33.1 points, 69-82%, depending on whether push winners count).**
  - **Week 1:** the record was first written on Monday 2026-09-14 at 21:45Z by R73 (`4cde7566`), after 15 of 16 games were FINAL. Result-updated ratings re-ranked the favourites before the cards were frozen, and 25 of week 1's 32 recorded all-hits were not on the slate at their own kickoff (24 first appeared after it).
  - **Weeks 2-3:** 175 cards built after kickoff were also graded. R90/R106 ended this from week 4.
- **Root cause 2: accounting depresses week 5 (about 5-10 points).**
  - The PHI @ JAX exclusion was entered 30 minutes after kickoff (`added_utc` 13:59:54Z; committed 14:10:26Z) and voided a winning JAX moneyline in 19 of 23 week cards. 15 of those had already lost on DAL, so it changed 3 week cards and 1 game card, cutting week 5 from 14/68 to 10/65.
  - "push" cards whose remaining legs all hit are not counted as wins (week 5: 16/65 = 24.6% counting them, not 10/65).
  - Void legs sit in the leg denominator (100/152 = 65.8%, not 100/177 = 56.5%).
- **What makes week cards swing: concentration.** Week cards are about 18 variants of one bet on 2-3 favourites. DAL was on 17 of 18 week-5 cards and lost; SF is on 18 of 18 week-6 cards. This drives 16/18 vs 1/23 headlines but not a trend.
- **Not the cause:**
  - The game model tracked the closing market every week: no weekly Brier2 gap is distinguishable from 0, and over weeks 1-5 model and market are level (0.4566 vs 0.4578).
  - Unique-leg accuracy did not fall: +4 points on the recorded legs (wk1 54.2% -> wk5 58.2%), 44.9% -> 57.6% on as-offered cards; both within noise.
  - The 2026 league was not less predictable: every week sits inside the 2019-25 bands.
  - R74 (one leg per side, 2026-09-16) lowered the model's own expected game-card all-hit from 34.5% (week 1, as offered) to 26-27% (weeks 2-5), but realised as-offered game-card all-hit did not fall (16/48 = 33.3% -> 59/188 = 31.4%). No other code change R75-R124 made curated cards harder.
- **Real defects that hold the level down every week, though not the trend:**
  - spread legs priced at a flat 0.5 (a coin flip that lowers the joint probability of every card it joins);
  - game pairs ranked by |rho| instead of hit probability;
  - every curated prop is an over, shipped even below 50%;
  - production prop features differ from the training features;
  - a MY-card calibration layer that was evaluated twice and pushed week-5 MY dials onto harder lines;
  - the injury feed frozen from Oct 11 to 15.
- **Shipped for week 6:**
  - **R125:** the injury feed reads ESPN "Reserve-Ret" again; it had been frozen for 3 days. Status-gated players went 34 -> 18 on the first fresh report (17 at 02:03Z).
  - **R126:** game cards are the pairs most likely to hit, and the flat spread is now only a fallback. Replay on the frozen game cards of weeks 2-5: 59/188 -> 72/189, at least as many winners every week (within noise). On the deployed week-6 slate: 0 spread legs (was 12); negative-correlation cards 7 -> 11, because a negative-rho pair now stays when its legs are likely enough; on week 6, expected hits by the model's own prices go 13.0 -> 14.6 of 42. Week 6 starts the prospective record.
  - Everything else is on review branches or the roadmap (sections 8-9).

## 2. The measurement

### 2.1 Reported vs as-offered (curated cards)

| wk | reported all-hit (review.json) | reported legs | as offered pre-kickoff, incl. push | strict all-hit | game cards (incl. push) | week cards (pre-first-kickoff) |
|---|---|---|---|---|---|---|
| 1 | 32/66 = 48.5% [36.8, 60.3] | 132/177 = 74.6% | 17/66 = 25.8% [16.7, 37.4] | 14/66 | 16/48 | 1/18 |
| 2 | 56/182 = 30.8% [24.5, 37.8] | 388/579 = 67.0% | 13/66 = 19.7% [11.9, 30.8] | 11/66 | 12/48 | 1/18 |
| 3 | 34/138 = 24.6% [18.2, 32.4] | 258/381 = 67.7% | 21/66 = 31.8% [21.8, 43.8] | 19/66 | 20/48 | 1/18 |
| 4 | 16/63 = 25.4% [16.3, 37.3] | 112/171 = 65.5% | 22/65 = 33.8% [23.5, 46.0] | 18/65 | 14/47 | 8/18 |
| 5 | 10/65 = 15.4% [8.6, 26.1] | 100/177 = 56.5% | 14/63 = 22.2% [13.7, 33.9] | 11/63 (9/63 with JAX ML void) | 13/45 | 1/18 |
| test | chi2 = 20.05, trend z = -3.99 | | chi2 = 4.91, trend z = +0.43 | chi2 = 4.78 (6.34 with the void) | chi2 = 3.49 | |

- **Brackets:** Wilson 95% intervals.
- **Sharing:** cards share legs, so these tests overstate certainty. That makes the "no trend" reading stronger, not weaker.
- **Grading** (section 10): legs graded on the field result; void legs drop out. Week 4 voids R. Rice's two legs as the R58 ledger does (no stat line); graded a miss as `review.json` does, week 4 is 21/65 (game cards 13/47). The strict week-5 "with JAX ML void" variant applies the post-kickoff owner exclusion that root cause 2 criticises.
- **Strict game cards** (push winners not counted): 13, 10, 18, 10, 10.
- **Leg rates, as-offered leg instances** (decided legs, counted once per card): 56.6, 52.9, 67.2, 69.2, 68.5% (week 5 is 64.9% with the JAX ML void). **Unique legs:** 44.9, 50.0, 65.7, 53.0, 57.6%.
- **Game-winner picks:** 9/16, 9/16, 11/16, 9/16, 8/14 (Brier 0.491 -> 0.439, improving).

### 2.2 Against the model's own probabilities

The model expected 24-27% all-hit every week (27.2, 23.7, 25.8, 27.3, 26.6%). A Monte Carlo that shares legs between cards gives:
- **Week 1** (35/66 wins incl. push vs 18.3 expected) is the outlier, at P = 0.028.
- **Week 5** (16/65 vs 20.0 expected) is ordinary, at P = 0.40.
- The counts were re-verified; the expected values and P come from the metrics lens and were not re-run in the second round.
- Decomposed: the 33.8-point fall in graded all-hit (32/63 = 50.8% -> 10/59 = 16.9%) is 23.6 points of week-1 outperformance, plus 9.6 points of week-5 shortfall (within noise), plus 0.6 points of change in the model's own expectation.

## 3. Root causes, ranked by the share of the decline they explain

| # | Cause | Mechanism | Evidence | Share of the 33.1-pt fall |
|---|---|---|---|---|
| 1 | **Hindsight cards graded as forecasts** (weeks 1-3) | The week-1 archive was created after results by R73 (`4cde7566`, 2026-09-14T21:45Z). `game_predictions.json` re-predicted finished games with post-result Elo (CHI 0.517 -> 0.603 after winning, LAC 0.705 -> 0.604 after losing), and the live slate re-picked cards around them. Weeks 2-3 archives were closed before R106 (`1535e159`, 2026-10-01) and still hold 119 and 56 post-kickoff cards. | First sight over all 467 `parlays.json` versions: wk1 week cards 17 post-kickoff (15 hit) vs 1 pre (1 hit); 24 of 32 wk1 all-hits first appeared after kickoff (25 were not on the slate at kickoff). Codex: "Week 1 history was introduced September 14 after Sunday results." | about 23-27 pts (69-82%), depending on whether push winners count |
| 2 | **Week-5 accounting** | (a) PHI @ JAX added to `config/excluded_games.json` with `added_utc` 13:59:54Z (committed 14:10:26Z), 30-40 minutes after its 13:30Z kickoff; JAX won 19-17, so a winning leg was voided in 19 of 23 week cards. 15 of those had already lost on DAL; it turned 3 week cards and 1 game card from a win into a void or a drop. (b) `build_review.summarize` counts only `result == 'hit'`; push winners are excluded (`build_review.py:947-971, 996-1001`). (c) `legs_n` counts void legs. | Week 5: 16/65 with push winners vs 10/65; 100/152 vs 100/177 legs; 14/68 -> 10/65 from the exclusion. | about 5-10 pts on week 5 (5.2 from the exclusion, 9.2 from push winners, 9.6 for both) |
| 3 | **Concentration** (the size of every swing) | Week cards take the favourite moneyline from the top few games (`build_week_parlays_multi`); 17-18 of 18 cards share the top favourite. | wk5 DAL on 17/18 (model 0.748, lost 16-24); wk6 SF on 18/18 (0.841), so a 15.9% SF loss alone defeats all 18. Codex: model-implied P(zero week-6 winners) = 16.98%. | sets the variance; not a trend |

## 4. Defects that lower the level every week (not the trend)

| Defect | Evidence | Status |
|---|---|---|
| **Spread legs priced at a flat 0.5 on the model favourite** (`parlay_builder.py` R51) | 48/119 ledger legs = 40.3% in 2026, from 68 games (game-level 29/68 = 42.6% [31.6, 54.5]); in 2023-25 the model favourite covered 402/797 = 50.4% [47.0, 53.9] (382/797 is the retired cover model's side). No side bug (0 grading inconsistencies) and no line-staleness effect. The 0.5 price is not shown to be wrong; the case for R126 is that a 0.5 leg lowers the joint probability against the available ML and prop legs. | **R126 shipped:** fallback-only on curated cards. MY spreads are confined to EVEN (R109). |
| **Game pairs ranked by \|rho\|, not hit probability** | After R74, opposite-side pairs (favourite ML + the underdog's back) filled the slot: 7/34 hit in weeks 2-5 vs 13/29 for same-side ML + back (19/45 if every side-less week-1 card counts as same-side). Codex reached the same "objective mismatch". | **R126 shipped:** rank by joint model probability. Replay on the frozen pre-kickoff game cards of weeks 2-5 (post-R74, same on-card legs, real results, push winners counted): 59/188 = 31.4% [25.2, 38.3] as built -> 72/189 = 38.1% [31.5, 45.2], at least as many winners every week (12->20, 20->21, 14->16, 13->15); within noise (z = 1.37). Week 1 is not comparable: its cards predate R74, and R126 scores 12/46 vs 15/47 as built (13/45 for the R74-consistent \|rho\| control). Week 6 starts the prospective record. |
| **Every curated prop is an over at a fixed seed line, shipped even below 0.5** | 218/218 overs; p < 0.5 hit 62/141 = 44.0%, p >= 0.5 hit 52/77 = 67.5%. | R126's ranking sends sub-0.5 props down the order. A hard floor (or offering unders) needs grader changes (R58 `hit = yards >= line`) and breaks the 3-cards-per-game invariant on 10 of 14 week-6 games. **Roadmap R128.** |
| **Prop train/serve skew** | Production `mu` is a frozen preseason prior (Prescott 265.98 from 09-08 to 10-11); calibration was fit on 0.5 x 2025 ypg + in-season weeks. On 212 live legs the training-shaped feature scores log loss 0.6293 vs production 0.6598 (bias +2.3 vs +12.8 yds). QB mu runs 28 yds low (CI -46.7 to -9.6, n=70). | **Roadmap R127** (shadow first, then promote on week-6 evidence). |
| **MY live calibration evaluated twice; MY dials moved to harder rungs in week 5** | The layer was adopted 2026-10-06 (13:14Z pool) and priced every later week-5 pool plus the first three week-6 pools (to 2026-10-13T10:55Z). `backtest_leg_pool` re-applies it to already-served probabilities (base 0.374058 -> served 0.5203 -> evaluated 0.659025, per Codex). SAFE mean rung z fell from about 0.52 to 0.297; MY prop legs fell 424/656 = 64.6% -> 155/318 = 48.7%. | Layer held from 2026-10-13T17:35Z (null on main and prod). 1,177 of the 2,871 recorded week-6 MY cards (318 of 735 SAFE) were built from the three layer-on pools, so week-6 MY results are reported with and without them. Codex's integration branch adds once-only receipts; **review pending** (section 8). |
| **Injury feed frozen 2026-10-11 20:10Z -> 2026-10-15 01:29Z** | One ESPN status, "Reserve-Ret" (PHI Lane Johnson), made `fetch_injuries` refuse all 800 rows; the stage table still said ok. It began at daily #288 (2026-10-11 22:04Z), after the week-5 afternoon kickoffs. Only the week-5 SNF and MNF cards were built on the frozen report (3.3 h and 27.2 h old), and none of their legs was affected, so it explains none of weeks 1-5. | **R125 shipped**, plus a follow-up (data-ci #168). Status-gated players 34 -> 18 on the first fresh report (17 at 02:03Z). RETIRED semantics on the integration branch supersede the interim IR mapping. |
| **Players who are out stay on cards** (ESPN report capped at 25 rows per team; a dropped row reads as playable) | Did-not-play voids 4, 14, 4, 3, 3 curated legs per week. J. Jacobs voided in weeks 1, 2, 4 and 5. Voids drop out (no losses) but waste slots. | Codex availability lane (quarantine/freshness) on the integration branch; **roadmap R129** for the cap. |

## 5. Ruled out (with reason)

- **League variance:**
  - every 2026 week's favourite win rate, cover rate and market log loss is inside the 2019-25 bands (week 5 at the 72nd percentile of market log loss);
  - upsets minus expected: week 1 at the 15th percentile (a chalky week, which flattered week 1), week 5 at the 55th.
- **Game model decay:** the model-minus-market Brier2 gap moved 0.079 in the model's favour from week 1 (+0.064) to week 5 (-0.015). That is within noise (bootstrap 95% CI -0.21 to +0.05); over weeks 1-5 model and market are level.
- **Leg-level model decay:** unique-leg hit rate +4 points; live prop log loss 0.6661 vs backtest 0.6705; moneyline legs calibrated and flat.
- **Card mix:** on the as-offered cohort the stated probability fell after R74 (0.345 -> 0.26-0.27 per game card), but realised game-card all-hit did not. On the recorded cohort, mix and price explain about 0.5 pts (2%) of the decline at model prices and 2.3 pts (7%) at market prices. It does not explain the reported decline, which is hindsight and accounting.
- **Code changes R75-R124:** none made curated cards harder (R74 is covered under card mix). R58 prop refits moved probabilities by at most 0.03. The anytime-TD model and cards did not decline.
- **The Netlify deploy pause (Oct 6-8), daily #288 and the TB @ DAL re-pick:** none changed a recorded card.
- **Grading errors:** at most 1 week-4 card differs between graders.

## 6. Why the backtests did not catch it

1. **No backtest gates slate all-hit.** `replay_lab` only measures it on cards already shipped (237 same-game cards: 28.3% vs model 27.2%), and `joint_backtest` covers anytime-TD cards only. The gates measure single-leg log loss, points MAE and calibration ECE. The metric that "fell" was never gated, and the record it was compared with was not a forecast.
2. **Pooled gates hide subgroups.** QB prop pricing is worse than the seed by 0.044 log loss (n = 70), inside a passing pooled gate.
3. **Train/serve skew.** The prop calibration is fit on a feature production does not compute (section 4).
4. **Double application.** The R100 hold decision was measured on probabilities that already contained the layer. Codex found the same thing from the producer side.
5. **The pair-ranking rule was never replayed:** |rho| ranking was never tested on frozen candidates. The 0.5 spread was replayed once (R109, 2026-10-04: removing spreads from slate game cards went 32/117 -> 31/114 and was rejected under never-regress). `replay_lab` re-prices locked legs; it does not reselect.

## 7. Week-6 changes and how they will be judged

- **R125 + follow-up (merged, prod-verified):**
  - `injuries.json` updated 2026-10-15T02:03Z, 800 rows, feed `ok`;
  - data-ci #169 is green.
- **R126 (main-merged `c2b272ac`, prod-verified):** game cards are the top-3 pairs by joint model probability, and the spread is a fallback only.
  - Daily #311 built the first R126 slate (`6e8cd143`, 2026-10-15T02:31:43Z). Prod `parlays.json` has 42 game cards, 0 spread legs and no ordering violation; expected hits are 14.6 of 42 by the model's prices; data-ci #170 is green.
  - Old-policy baseline slate: `bb6ae6ed` (`data/parlays.json` at 2026-10-15T02:07Z).
  - Validation runs are scheduled after TNF (2026-10-16 12:00Z, after nflverse stats land) and after MNF (2026-10-20 13:00Z). No coefficient is refit on one game.
  - **Control:** the old rule applied per game to the pre-kickoff candidate legs. Spreads come from `data/estimates/parlays_2026.json` (18 week-6 spread legs recorded before R126), with their seen time stated. The deployed R126 cards carry no spread, so re-ranking their own legs cannot reproduce the old slate.
  - **Power:** week 6 starts the prospective record. With 18 differing cards it cannot confirm or refute a 1.6-card lift (paired z of about 0.6 even at the model's own prices). Keep or revert is decided on the pooled paired difference over weeks 6+, with a game-clustered interval defined before the results are seen.
- **KPIs** (computed from the committed files):

| KPI | Definition |
|---|---|
| (a) as-offered game-card all-hit | pre-kickoff cards incl. push winners, paired against the old-policy control on the same candidate legs, game-clustered |
| (b) unique-leg hit rate | hit/(hit+miss) over unique (game, market, selection) legs on as-offered curated cards, voids excluded, Wilson 95%; weeks 1-5 reference 44.9-65.7% |
| (c) prop log loss vs seed | curated prop legs in `parlay_leg_scores.json`: model vs seed log loss, pooled and per position; pass = model < seed pooled and in QB, RB and WR |
| (d) week-scope outcome vs model-implied distribution | P(0 winners) = 16.98% for week 6 |
| (e) MY SAFE all-hit vs simulated band with shared legs | SAFE all-hit vs the 90% band of a shared-leg simulation at the cards' model probabilities, void cards excluded; reported with and without the 1,177 layer-on cards |
| (f) injury feed freshness | `feeds.injuries.status == ok`, age < 12 h at every pregame build, 0 unmapped statuses |

## 8. Reconciliation with Codex (Astra) and finding-by-finding status

**Status vocabulary:**
- **main-merged:** on `main`;
- **prod-verified:** checked on `nfl2026.netlify.app`;
- **integration-branch:** on the Claude integration branch, gated, not merged; needs review;
- **remaining:** not started;
- **insufficient evidence:** cannot be concluded yet.

| # | Finding (Codex handoff section 3 / RCA) | Claude RCA | Status |
|---|---|---|---|
| 1 | Week 1's 16/18 is not a prospective baseline; fixed cohorts 1/18, 1/18, 1/18, 8/18, 1/18 | Same series, independently (section 2.1) | **Agreed.** The record label/scoreboard fix (Codex lane C) is **remaining**. |
| 2 | One shared loss defeats many cards (DAL 17/18 wk5; SF 18/18 wk6) | Same (section 3 #3) | **Agreed.** Exposure warning and portfolio selector are **integration-branch** (shadow); the default objective is unchanged (owner: highest likelihood). |
| 3 | MY SAFE unchanged-contract 96/893 = 10.75% vs about 30.40% predicted | MY SAFE 96/1654 = 5.8% all cards; the clean cohort is Codex's | **Agreed** (overlapping cards, not independent trials). |
| 4 | MY evaluation double-applied calibration (0.374058 -> 0.5203 -> 0.659025) | Same (backtests lens) | **Agreed.** Once-only receipts on **integration-branch**; layer **held on main** since 2026-10-13T17:35Z (prod: `live_adjustment` null); 1,177 week-6 MY cards predate the hold. |
| 5 | Injury failure began after week-5 noon games; cannot explain earlier misses | Same | **Agreed.** R125 **main-merged, prod-verified.** RETIRED semantics, quarantine and freshness on **integration-branch**. |
| 6 | SelfLearning is not a live NFL feedback loop | Not in the Claude lenses' scope; confirmed read-only: `build/nfl-feedback-contracts-20261014` passes its full CI-equivalent suite (233 tests + walk-forward demo). No producer integration. | **Agreed. Remaining:** actual-producer parity, docs, persistence, candidate return. |
| 7 | No weather/equation change shown to produce 15/18; do not hindsight-fit | Same; the weather study stays measure-only | **Agreed.** |
| 8 | Same-game objective: \|rho\| then EV, not joint hit probability | Same, plus the weeks 2-5 replay (59/188 -> 72/189) | **R126 main-merged, prod-verified** (Codex lane D acceptance: "a lower-correlation pair with higher validated joint hit probability wins"). |
| 9 | Game-prop caller strips the event week (`build_predictions.py:871-879`) | Not separately measured | Fix on **integration-branch** (Codex lane A). |
| 10 | Live Elo k = 20 vs metadata 25 | Not measured | **Remaining** (report the truth; do not activate 25). |
| 11 | Prop train/serve feature skew | Measured on 212 live legs (section 4) | **Remaining**, roadmap R127 (shadow first). |
| 12 | Flat-0.5 spread legs (2026: 48/119 ledger legs, 29/68 games; 2023-25 favourite 402/797 = 50.4%) | Not in the Codex RCA. Not a demonstrated mispricing; a 0.5 leg lowers the card's joint probability | **R126 main-merged, prod-verified.** |
| 13 | Post-kickoff owner exclusions void winners; push winners uncounted | Codex: "1 all hit + 3 reduced-leg successes + 19 losses" | **Agreed. Remaining:** headline/settlement separation (Codex lane C; partly on integration-branch in `resolve_my_cards`). |

## 9. Roadmap

| ID | Item | Why | Acceptance | When |
|---|---|---|---|---|
| R125 | Injury feed reads Reserve-Ret (+ follow-up) | Feed frozen 3 days | `feeds.injuries.status == ok`, age < 12 h at every week-6 pregame build, 0 unmapped statuses (800 rows is the 25-per-team cap, so a row count cannot detect truncation); gate green | **done, prod-verified** |
| R126 | Game cards = top-3 pairs by joint probability; spread fallback | Section 4 | Never-regress per week on weeks 2-5 frozen candidates against the R74-consistent \|rho\| control (met: 12->20, 20->21, 14->16, 13->15); week 1 reported separately; week 6 starts the prospective record (section 7) | **main-merged, prod-verified before TNF** |
| — | Codex integration (availability quarantine/freshness, RETIRED, learning receipts, honest MY record, chronology display, exposure summary) | Codex RCA lanes A-D | Full gate + `week6_risk` browser spec on the exact SHA; owner/Codex review | **integration branch (draft PR), owner decides** |
| R127 | Prop `mu` from the training-shaped feature (0.5 x 2025 ypg + 2026 weeks) | Train/serve skew | Shadow both features from week 6; promote when the training-shaped feature has lower live prop log loss over at least 2 graded weeks, with a game-clustered 95% interval of the difference below 0 and no position worse | week 6 shadow -> week 8 at the earliest |
| R128 | Prop side/line: offer the model-favoured side (unders), or a lower rung where p >= 0.5 | 141/218 curated props shipped below 0.5. Those overs hit 62/141 = 44.0% against mean p 0.380, so unders would have hit 79/141 = 56.0% [47.8, 64.0] against the model's 0.62 | Grader support for unders (R58 rule) and parity tests; pass = replay on weeks 2-5 frozen candidates is not below R126 in any week, judged on realised hit rate, not model p | week 7 |
| R129 | Injury report beyond the 25-row cap; a "did not play last FINAL" eligibility guard | Out players stay on cards | No curated leg on a player who missed the last game unless a newer row clears him; fixture for a dropped IR row; target 0 curated did-not-play voids in weeks 7-8 unless the player was a post-build inactive (weeks 1-5: 4, 14, 4, 3, 3) | week 7, with Codex lane A |
| R130 | Honest record: pre-kickoff-only scoreboard; push winners counted; void legs out of the leg denominator; flag post-kickoff exclusions | Section 3 #1-2 | Headline = as-offered cohort (section 10 method: push winners counted, voids out of the denominator), weeks 1-5 = 17/66, 13/66, 21/66, 22/65, 14/63. A separate settlement view shows the archive's week 5 as 1 full + 3 reduced + 19 losses on 23 week cards (16/65 incl. push) | week 6 |
| R131 | Week-card portfolio: explicit choice of highest-hit vs diversified, with exposure shown | Concentration | The week-card panel shows expected winners and P(0 winners) at model prices for the shipped 18 (week 6: 6.33 and 16.98%); the owner records the objective in the roadmap; caps enforced or reported infeasible, never filler | owner decision |
| R132 | A slate-level backtest gate (frozen candidates -> reselect -> grade) | Section 6 | `replay_lab` reselection mode; the gate fails when replay all-hit incl. push on frozen candidates is lower than the control in any post-R74 week | week 7 |

## 9a. Rollback

- R126: revert its commit; the next pipeline run rebuilds the slate under the old ranking.
- R125: revert both R125 commits. Doing so re-freezes the feed while ESPN still sends Reserve-Ret, so do not do it without RETIRED in place.

## 10. Reproduce

Scripts written for this RCA (read-only on the repo) are summarized here. The scratch copies are ephemeral, so the key computations are restated:
- **As-offered series:** for each game, take the last `data/parlays.json` commit before its kickoff (`git log -- data/parlays.json`, all 467 versions to `fb8830ae`; `git show <sha>:data/parlays.json`) and select that game's cards. Grade moneyline/spread from `data/review.json` finals and props from `data/parlay_leg_scores.json`, falling back to the `data/review.json` card-leg grade when a prop has no ledger row (week 1, C. Williams); the ledger's void (no stat line) wins over `review.json`'s miss (week 4, R. Rice). Void legs drop out. Week cards use the last commit before the week's first kickoff.
- **R126 replay:** candidates per game = the union of legs on that game's frozen pre-kickoff cards, weeks 2-5 (week 1 predates R74). The control ranks pairs by (-|rho|, -EV) under R74 (one leg per side); R126 ranks by (-joint p, -EV) and adds the spread only if fewer than 3 non-spread pairs exist. Grade both on real results, push winners counted.
- **Spread legs:** use `data/parlay_leg_scores.json` resolved rows with `market == 'spread'`, and count games as well as legs (first leg per game). The 2023-25 comparator is the Elo favourite's cover rate (`elo.py` with `games_meta.json` closing lines), which is the side `parlay_builder.py` takes.
- **Props by price band:** the same file, `market` in the three prop markets, grouped at `model_prob >= 0.5`.
