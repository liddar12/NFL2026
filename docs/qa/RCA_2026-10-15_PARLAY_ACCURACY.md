# RCA 2026-10-15: why parlay accuracy "fell every week" from week 1 to week 5

**Status:** RCA complete for weeks 1-5. Two week-6 fixes shipped (R125 injury feed, R126 game-card ranking). The rest is a reviewed roadmap.
**Author:** Claude Code, at the owner's request (2026-10-14). The same question went to Codex (Astra). Its independent RCA is on branch `build/week6-correctness-20261014` (`docs/reviews/2026-10-14-week6-rca/`); section 8 reconciles the two.
**Baseline:** `fb8830ae` (2026-10-14), read-only. Numbers come from the committed files and their git history.
**Method:** six independent investigator lenses: metrics, code changes, backtests, data pipeline, market base rates, and leg forensics. An adversarial verifier re-ran the metrics and changes lenses: 22 of 25 claims were confirmed and 3 were confirmed with corrected numbers. The other four lenses were cross-checked against each other and against Codex's independent numbers. Scripts are listed in section 10.

## 1. Summary

- **The decline is mostly a measurement artifact, not a model that got worse.** Reported curated all-hit went 48.5% (wk1) -> 30.8 -> 24.6 -> 25.4 -> 15.4% (wk5), a 33.1-point fall. Graded on what was actually offered before kickoff, the same weeks are flat:
  - game + week cards incl. push: 25.8, 19.7, 31.8, 33.8, 22.2% (chi2 = 4.9, df 4, p > 0.25);
  - week-scope cards: **1/18, 1/18, 1/18, 8/18, 1/18**. Codex reproduced exactly this series independently.
- **Root cause 1: hindsight cards in the record (about 70-90% of the decline).**
  - **Week 1:** the record was first written on Monday 2026-09-14 21:46Z by R73, after 15 of 16 games were FINAL. Result-updated ratings re-ranked the favourites before the cards were frozen, and 25 of week 1's 32 recorded all-hits are cards first seen after their own kickoff.
  - **Weeks 2-3:** 175 cards built after kickoff were also graded. R90/R106 ended this from week 4.
- **Root cause 2: accounting depresses week 5 (about 5-10 points).**
  - The PHI @ JAX exclusion was added 30 minutes after kickoff and voided a winning JAX moneyline in 19 of 23 frozen week cards.
  - "push" cards whose remaining legs all hit are not counted as wins (week 5: 16/65 = 24.6% counting them, not 10/65).
  - Void legs sit in the leg denominator (100/152 = 65.8%, not 100/177 = 56.5%).
- **What makes week cards swing: concentration.** Week cards are about 18 variants of one bet on 2-3 favourites. DAL was on 17 of 18 week-5 cards and lost; SF is on 18 of 18 week-6 cards. This drives 16/18 vs 1/23 headlines but not a trend.
- **Not the cause:**
  - The game model tracked the market every week, and its edge over the market improved by about 0.08 Brier2.
  - Unique-leg accuracy moved +4 points (wk1 54.2% -> wk5 58.2%, within noise).
  - The 2026 league was not less predictable: every week sits inside the 2019-25 bands.
  - No code change made curated cards harder: same legs per card, same market mix, same stated probability.
- **Real defects that hold the level down every week, though not the trend:**
  - spread legs priced at a flat 0.5 that cover 40%;
  - game pairs ranked by |rho| instead of hit probability;
  - every curated prop is an over, shipped even below 50%;
  - production prop features differ from the training features;
  - a MY-card calibration layer that was evaluated twice and pushed week-5 MY dials onto harder lines;
  - the injury feed frozen from Oct 11 to 15.
- **Shipped for week 6:**
  - **R125:** the injury feed reads ESPN "Reserve-Ret" again; it had been frozen for 3 days and was gating 34 players on a stale report.
  - **R126:** game cards are the pairs most likely to hit, and the flat spread is now only a fallback. Replay: 74/235 -> 83/233; on week 6, expected hits by the model's own prices go 13.0 -> 14.2 of 42.
  - Everything else is on review branches or the roadmap (sections 8-9).

## 2. The measurement

### 2.1 Reported vs as-offered (curated cards)

| wk | reported all-hit (review.json) | reported legs | as offered pre-kickoff, incl. push | strict all-hit | game cards | week cards (pre-first-kickoff) |
|---|---|---|---|---|---|---|
| 1 | 32/66 = 48.5% [36.8, 60.3] | 132/177 = 74.6% | 17/66 = 25.8% [16.7, 37.4] | 14/66 | 16/48 | 1/18 |
| 2 | 56/182 = 30.8% [24.5, 37.8] | 388/579 = 67.0% | 13/66 = 19.7% [11.9, 30.8] | 11/66 | 12/48 | 1/18 |
| 3 | 34/138 = 24.6% [18.2, 32.4] | 258/381 = 67.7% | 21/66 = 31.8% [21.8, 43.8] | 19/66 | 20/48 | 1/18 |
| 4 | 16/63 = 25.4% [16.3, 37.3] | 112/171 = 65.5% | 22/65 = 33.8% [23.5, 46.0] | 18/65 | 14/47 | 8/18 |
| 5 | 10/65 = 15.4% [8.6, 26.1] | 100/177 = 56.5% | 14/63 = 22.2% [13.7, 33.9] | 9/63 | 13/45 | 1/18 |
| test | chi2 = 20.05, trend z = -3.99 | | chi2 = 4.91, trend z = +0.57 | chi2 = 6.34 | chi2 = 3.49 | |

- **Brackets:** Wilson 95% intervals.
- **Sharing:** cards share legs, so these tests overstate certainty. That makes the "no trend" reading stronger, not weaker.
- **Leg rates, as-offered unique legs:** 56.6, 52.9, 67.2, 69.2, 64.9%.
- **Game-winner picks:** 9/16, 9/16, 11/16, 9/16, 8/14 (Brier 0.491 -> 0.439, improving).

### 2.2 Against the model's own probabilities

The model expected about 27% all-hit every week (27.2, 23.7, 25.8, 27.3, 26.6%). A Monte Carlo that shares legs between cards gives:
- **Week 1** (35 wins incl. push vs 18.3 expected) is the outlier, at P = 0.028.
- **Week 5** (16 vs 20.0 expected) is ordinary, at P = 0.40.
- Decomposed: the 33.9-point fall in graded all-hit is 23.6 points of week-1 outperformance, plus 9.7 points of week-5 shortfall (within noise), plus 0.6 points of change in the model's own expectation.

## 3. Root causes, ranked by the share of the decline they explain

| # | Cause | Mechanism | Evidence | Share of the 33.1-pt fall |
|---|---|---|---|---|
| 1 | **Hindsight cards graded as forecasts** (weeks 1-3) | The week-1 archive was created after results by R73 (`4cde7566`, 2026-09-14T21:45Z). `game_predictions.json` re-predicted finished games with post-result Elo (CHI 0.517 -> 0.603 after winning, LAC 0.705 -> 0.604 after losing), and the live slate re-picked cards around them. Weeks 2-3 archives were closed before R106 (`1535e159`, 2026-10-01) and still hold 119 and 56 post-kickoff cards. | First sight over 271 `parlays.json` versions: wk1 week cards 17 post-kickoff (15 hit) vs 1 pre (1 hit); 25 of 32 wk1 all-hits are post-kickoff. Codex: "Week 1 history was introduced September 14 after Sunday results." | about 22-27 pts (70-82%), depending on the cohort rule |
| 2 | **Week-5 accounting** | (a) PHI @ JAX added to `config/excluded_games.json` at 13:59:54Z, 30 minutes after its 13:30Z kickoff; JAX won 19-17, so a winning leg was voided in 19 of 23 frozen week cards. (b) `build_review.summarize` counts only `result == 'hit'`; push winners are excluded (`build_review.py:947-971, 996-1001`). (c) `legs_n` counts void legs. | Week 5: 16/65 with push winners vs 10/65; 100/152 vs 100/177 legs; 14/68 -> 10/65 from the exclusion. | about 5-9 pts on week 5 |
| 3 | **Concentration** (the size of every swing) | Week cards take the favourite moneyline from the top few games (`build_week_parlays_multi`); 17-18 of 18 cards share the top favourite. | wk5 DAL on 17/18 (model 0.748, lost 16-24); wk6 SF on 18/18 (0.841), so a 15.9% SF loss alone defeats all 18. Codex: model-implied P(zero week-6 winners) = 16.98%. | sets the variance; not a trend |

## 4. Defects that lower the level every week (not the trend)

| Defect | Evidence | Status |
|---|---|---|
| **Spread legs priced at a flat 0.5 on the model favourite** (`parlay_builder.py` R51) | 48/119 legs = 40.3% [32.0, 49.3] in 2026; 382/797 games in 2023-25; home favourites 24/67. No side bug (0 grading inconsistencies) and no line-staleness effect. | **R126 shipped:** fallback-only on curated cards. MY spreads are confined to EVEN (R109). |
| **Game pairs ranked by \|rho\|, not hit probability** | After R74, opposite-side pairs (favourite ML + the underdog's back) filled the slot: 7/34 hit vs 19/45 same-side. Codex reached the same "objective mismatch". | **R126 shipped:** rank by joint model probability. Replay 74/235 -> 83/233 (within noise; week 6 is the prospective test). |
| **Every curated prop is an over at a fixed seed line, shipped even below 0.5** | 218/218 overs; p < 0.5 hit 62/141 = 44.0%, p >= 0.5 hit 52/77 = 67.5%. | R126's ranking sends sub-0.5 props down the order. A hard floor (or offering unders) needs grader changes (R58 `hit = yards >= line`) and breaks the 3-cards-per-game invariant on 10 of 14 week-6 games. **Roadmap R128.** |
| **Prop train/serve skew** | Production `mu` is a frozen preseason prior (Prescott 265.98 from 09-08 to 10-11); calibration was fit on 0.5 x 2025 ypg + in-season weeks. On 212 live legs the training-shaped feature scores log loss 0.6293 vs production 0.6598 (bias +2.3 vs +12.8 yds). QB mu runs 28 yds low (CI -46.7 to -9.6, n=70). | **Roadmap R127** (shadow first, then promote on week-6 evidence). |
| **MY live calibration evaluated twice; MY dials moved to harder rungs in week 5** | The layer was adopted 2026-10-06 for week 5 only. `backtest_leg_pool` re-applies it to already-served probabilities (base 0.374058 -> served 0.5203 -> evaluated 0.659025, per Codex). SAFE mean rung z fell from about 0.52 to 0.297; MY prop legs fell 424/656 = 64.6% -> 155/318 = 48.7%. | Layer already held (null for week 6). Codex's integration branch adds once-only receipts; **review pending** (section 8). |
| **Injury feed frozen 2026-10-11 20:10Z -> 2026-10-15 01:29Z** | One ESPN status, "Reserve-Ret" (PHI Lane Johnson), made `fetch_injuries` refuse all 800 rows; the stage table still said ok. It began after the week-5 noon games, so it explains none of weeks 1-5. | **R125 shipped**, plus a follow-up (data-ci #168). Fresh report: status-gated players 34 -> 18. RETIRED semantics on the integration branch supersede the interim IR mapping. |
| **Players who are out stay on cards** (ESPN report capped at 25 rows per team; a dropped row reads as playable) | Did-not-play voids 4, 14, 4, 3, 3 curated legs per week. J. Jacobs voided in weeks 1, 2, 4 and 5. Voids drop out (no losses) but waste slots. | Codex availability lane (quarantine/freshness) on the integration branch; **roadmap R129** for the cap. |

## 5. Ruled out (with reason)

- **League variance:**
  - every 2026 week's favourite win rate, cover rate and market log loss is inside the 2019-25 bands (week 5 at the 72nd percentile of market log loss);
  - upsets minus expected: week 1 at the 15th percentile (a chalky week, which flattered week 1), week 5 at the 55th.
- **Game model decay:** the model-minus-market Brier2 gap moved -0.079 from week 1 to week 5 (better).
- **Leg-level model decay:** unique-leg hit rate +4 points; live prop log loss 0.6661 vs backtest 0.6705; moneyline legs calibrated and flat.
- **Card mix:** same legs per card, same market mix, same stated probability; mix explains about 0 points.
- **Code changes R74-R124:** none made curated cards harder. R58 prop refits moved probabilities by at most 0.03. The anytime-TD model and cards did not decline.
- **The Netlify deploy pause (Oct 6-8), daily #288 and the TB @ DAL re-pick:** none changed a recorded card.
- **Grading errors:** at most 1 week-4 card differs between graders.

## 6. Why the backtests did not catch it

1. **No backtest measures slate all-hit.** The gates measure single-leg log loss, points MAE and calibration ECE. The metric that "fell" was never gated, and the record it was compared with was not a forecast.
2. **Pooled gates hide subgroups.** QB prop pricing is worse than the seed by 0.044 log loss (n = 70), inside a passing pooled gate.
3. **Train/serve skew.** The prop calibration is fit on a feature production does not compute (section 4).
4. **Double application.** The R100 hold decision was measured on probabilities that already contained the layer. Codex found the same thing from the producer side.
5. **The card-construction rule was never replayed.** No replay ran on frozen candidates, so |rho| ranking and the 0.5 spread were never tested. `replay_lab` re-prices locked legs; it does not reselect.

## 7. Week-6 changes and how they will be judged

- **R125 + follow-up (merged, prod-verified):**
  - `injuries.json` updated 2026-10-15T02:03Z, 800 rows, feed `ok`;
  - data-ci #169 is green.
- **R126 (merged after CI; prod verification after the next pipeline build):** game cards are the top-3 pairs by joint model probability, and the spread is a fallback only.
  - Old-policy baseline slate: `bb6ae6ed` (`data/parlays.json` at 2026-10-15T02:07Z).
  - Validation runs are scheduled after TNF (2026-10-16 12:00Z, after nflverse stats land) and after MNF (2026-10-20 13:00Z). Each compares the frozen R126 cards with an old-policy control rebuilt from the same frozen legs, reports per-game Wilson intervals, and refits no coefficient on one game.
- **KPIs** (computed from the committed files):

| KPI | Definition |
|---|---|
| (a) as-offered game-card all-hit | pre-kickoff cards incl. push winners, vs the old-policy control on the same legs |
| (b) unique-leg hit rate | — |
| (c) prop log loss vs seed | — |
| (d) week-scope outcome vs model-implied distribution | P(0 winners) = 16.98% for week 6 |
| (e) MY SAFE all-hit vs simulated band with shared legs | — |
| (f) injury feed freshness | `feeds.injuries.status == ok` and age < 12 h at every pregame build |

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
| 4 | MY evaluation double-applied calibration (0.374058 -> 0.5203 -> 0.659025) | Same (backtests lens) | **Agreed.** Once-only receipts on **integration-branch**; layer **held on main** (prod: `live_adjustment` null for week 6). |
| 5 | Injury failure began after week-5 noon games; cannot explain earlier misses | Same | **Agreed.** R125 **main-merged, prod-verified.** RETIRED semantics, quarantine and freshness on **integration-branch**. |
| 6 | SelfLearning is not a live NFL feedback loop | Not in the Claude lenses' scope; confirmed read-only: `build/nfl-feedback-contracts-20261014` passes its full CI-equivalent suite (233 tests + walk-forward demo). No producer integration. | **Agreed. Remaining:** actual-producer parity, docs, persistence, candidate return. |
| 7 | No weather/equation change shown to produce 15/18; do not hindsight-fit | Same; the weather study stays measure-only | **Agreed.** |
| 8 | Same-game objective: \|rho\| then EV, not joint hit probability | Same, plus the replay (74/235 -> 83/233) and the 0.5 spread | **R126 main-merged** (Codex lane D acceptance: "a lower-correlation pair with higher validated joint hit probability wins"). |
| 9 | Game-prop caller strips the event week (`build_predictions.py:871-879`) | Not separately measured | Fix on **integration-branch** (Codex lane A). |
| 10 | Live Elo k = 20 vs metadata 25 | Not measured | **Remaining** (report the truth; do not activate 25). |
| 11 | Prop train/serve feature skew | Measured on 212 live legs (section 4) | **Remaining**, roadmap R127 (shadow first). |
| 12 | Flat-0.5 spread legs cover about 40% | Not in the Codex RCA | **R126 main-merged.** |
| 13 | Post-kickoff owner exclusions void winners; push winners uncounted | Codex: "1 all hit + 3 reduced-leg successes + 19 losses" | **Agreed. Remaining:** headline/settlement separation (Codex lane C; partly on integration-branch in `resolve_my_cards`). |

## 9. Roadmap

| ID | Item | Why | Acceptance | When |
|---|---|---|---|---|
| R125 | Injury feed reads Reserve-Ret (+ follow-up) | Feed frozen 3 days | feed ok, 800 rows; gate green | **done, prod-verified** |
| R126 | Game cards = top-3 pairs by joint probability; spread fallback | Section 4 | Never-regress replay; prospective week-6 comparison vs control | **merged, before TNF** |
| — | Codex integration (availability quarantine/freshness, RETIRED, learning receipts, honest MY record, chronology display, exposure summary) | Codex RCA lanes A-D | Full gate + `week6_risk` browser spec on the exact SHA; owner/Codex review | **review branch, owner decides before TNF** |
| R127 | Prop `mu` from the training-shaped feature (0.5 x 2025 ypg + 2026 weeks) | Train/serve skew | Shadow both features on week 6; promote only if live log loss improves without a per-position regression | week 6 shadow -> week 7 |
| R128 | Prop side/line: offer the model-favoured side (unders), or a lower rung where p >= 0.5 | 141/218 curated props shipped below 0.5 | Grader support for unders (R58 rule) and parity tests; replay on frozen candidates | week 7 |
| R129 | Injury report beyond the 25-row cap; a "did not play last FINAL" eligibility guard | Out players stay on cards | No curated leg on a player who missed the last game unless a newer row clears him; fixture for a dropped IR row | with Codex lane A |
| R130 | Honest record: pre-kickoff-only scoreboard; push winners counted; void legs out of the leg denominator; flag post-kickoff exclusions | Section 3 #1-2 | Review headline equals the as-offered replay within 1 card | week 6 |
| R131 | Week-card portfolio: explicit choice of highest-hit vs diversified, with exposure shown | Concentration | Owner picks the objective; caps enforced or reported infeasible, never filler | owner decision |
| R132 | A slate-level backtest gate (frozen candidates -> reselect -> grade) | Section 6 | `replay_lab` reselection mode; gate fails a ranking change that lowers replay all-hit | week 7 |

## 9a. Rollback

- R126: revert its commit; the next pipeline run rebuilds the slate under the old ranking.
- R125: revert both R125 commits. Doing so re-freezes the feed while ESPN still sends Reserve-Ret, so do not do it without RETIRED in place.

## 10. Reproduce

Scripts written for this RCA (read-only on the repo) are summarized here. The scratch copies are ephemeral, so the key computations are restated:
- **As-offered series:** for each game, take the last `data/parlays.json` commit before its kickoff (`git log -- data/parlays.json`, `git show <sha>:data/parlays.json`), select that game's cards, and grade the legs from `data/review.json` finals and `data/parlay_leg_scores.json`. Week cards use the last commit before the week's first kickoff.
- **R126 replay:** take the same frozen candidate legs per game. The old policy ranks pairs by (-|rho|, -EV); the new one ranks by (-joint p, -EV) and adds the spread only if fewer than 3 non-spread pairs exist. Grade both on real results.
- **Spread legs:** use `data/parlay_leg_scores.json` resolved rows with `market == 'spread'`.
- **Props by price band:** the same file, `market` in the three prop markets, grouped at `model_prob >= 0.5`.
