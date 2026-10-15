# NFL2026: Weeks 1–5 parlay RCA and Week 6 corrective roadmap

Revision 1 — October 14, 2026, 2:10 p.m. CDT (America/Chicago). Investigation and recommendations, **not an implemented release**.

Audited Git baseline: [`fb8830ae35f1e11d3f589b435e303b719886e3e7`](https://github.com/liddar12/NFL2026/tree/fb8830ae35f1e11d3f589b435e303b719886e3e7), including R124. This was fetched and reviewed in an isolated worktree; the owner's local NFL checkout is an older audit branch and was not reset or fast-forwarded. Source locations in this report refer to the pinned baseline, not that older checkout. Existing NFL and SelfLearning work was preserved.

## Executive finding

**There is a real Week 5 MY-parlay shortfall and several engineering defects, but not evidence of a steady model collapse from a valid 16/18 Week 1 baseline.** The apparent trend combines retrospective early history, changed settlement/population rules, and highly overlapping cards. Week 4 rebounded; Game-card and individual recorded-leg hit rates improved slightly from Week 4 to Week 5.

The most consequential findings are:

1. **The original baseline is not prospective.** The current Week 1 archive says 16/18, but its exact archived probability/price vectors were not committed before the games. A consistent reconstruction using the last committed slate before each week's first kickoff grades **1/18, 1/18, 1/18, 8/18, 1/18** against original game outcomes.
2. **Repeated favorites amplify losses.** Dallas appeared in 17 of the original 18 Week 5 cards. Its loss alone defeated those 17. In the later 23-card archive, Dallas and Atlanta account for all 19 losing cards. Week 6 currently repeats the problem: **SF appears in all 18 Week cards**.
3. **MY learning has a confirmed evaluation/serving mismatch.** Once the live calibration layer is adopted, the evaluator treats already-adjusted probabilities as raw and adjusts them again. The October 13 rollback comparison therefore cannot establish whether applying the layer once helped or hurt Week 5. It is already disabled; keep it held until the evaluation is repaired.
4. **A new parser failure is currently corrupting Week 6 eligibility.** One ESPN `Reserve-Ret` row rejects an otherwise healthy 800-row injury response. October 11 statuses have continued gating Week 6. This incident began after the Week 5 noon window, so it cannot explain those earlier misses.
5. **The separate SelfLearning engine is not integrated into NFL production.** NFL has its own learning scripts and committed artifacts. Several loops run or deliberately hold candidates, but this is not a single end-to-end shared engine.

Recommended sequence: source/eligibility containment before Thursday kickoff; probability receipts, evaluation and exposure safeguards before Sunday where verified; full train/serve parity and shared-engine integration after trustworthy measurement is established. See [the implementation handoff](WEEK6_ROADMAP.md).

## 1. What actually fell?

### Current displayed history — descriptive, not a uniform prospective experiment

| Week | Week cards: all hit | Game cards: all hit | Combined all hit | Recorded pregame-lock leg rows: hit |
|---|---:|---:|---:|---:|
| 1 | 16/18 (88.9%) | 16/48 (33.3%) | 32/66 (48.5%) | 30/69 (43.5%) |
| 2 | 34/73 (46.6%) | 22/109 (20.2%) | 56/182 (30.8%) | 44/90 (48.9%) |
| 3 | 3/37 (8.1%) | 31/101 (30.7%) | 34/138 (24.6%) | 54/90 (60.0%) |
| 4 | 8/18 (44.4%) | 8/45 (17.8%) | 16/63 (25.4%) | 37/77 (48.1%) |
| 5 | 1/23 (4.3%) | 9/42 (21.4%) | 10/65 (15.4%) | 46/93 (49.5%) |

The denominators include reviewed void/reduced-leg cards. Some entirely excluded Game cards have been removed by owner policy. Leg rows can contain several markets/lines/sides in the same game and are not independent observations. Their recorded lock timestamps alone are not proof of publication; the Git publication audit below was conducted on cards.

### A consistent decision-time comparison

For each week, recover the **last committed `data/parlays.json` before the first kickoff**. Each has 18 Week cards and all were still future at commit time. Grade the original selections against current FINAL game scores, separately from later administrative exclusions.

| Week | Pregame snapshot | Commit time, UTC | Original-contract all hit |
|---|---|---|---:|
| 1 | `7dcbc868` | Sep 9, 18:25:52 | 1/18 |
| 2 | `d1cf5a0b` | Sep 18, 00:07:27 | 1/18 |
| 3 | `67e40053` | Sep 24, 23:24:04 | 1/18 |
| 4 | `7815098e` | Oct 1, 23:27:33 | 8/18 |
| 5 | `be5e4643` | Oct 8, 23:25:35 | 1/18 |

Week 5 under the later owner exclusion becomes **zero full-contract all-hit cards, one successful reduced-leg settlement, and 17 losses**. That is a settlement-policy difference, not a changed original prediction. This fixed-time cohort is not every offer throughout a week and does not identify the user's actual bets. Git proves committed availability, not that a specific browser received that version before kickoff.

Full available Git history also shows:

| Week | Currently archived Week cards | Combination existed in Git pre-kickoff | Exact archived leg probability/price vector existed pre-kickoff |
|---|---:|---:|---:|
| 1 | 18 | 1 | 0 |
| 2 | 73 | 8 | 2 |
| 3 | 37 | 26 | 24 |
| 4 | 18 | 18 | 18 |
| 5 | 23 | 23 | 23 |

Week 1 history was introduced September 14 after Sunday results. The later archive cannot be used to claim 16/18 pregame predictive accuracy. **R106 already prevents new post-kickoff combinations from being appended** (`build_parlay_archive.py:298–347`); preserve that fix and label older history instead of deleting or rewriting it.

Evidence: [metrics](evidence/metrics.json), [full card provenance and fixed cohorts](evidence/provenance.json).

## 2. Concentration, not 19 independent surprises

In the original Week 5 18-card slate, Dallas was in 17 cards at an archived probability of 74.83%. Dallas lost 16–24 to Tampa Bay. The other seven underlying selections won; just one card survived. The later 23-card archive additionally includes losing Atlanta selections: Dallas defeats 17 cards, Atlanta the other two. Its unique nonvoid Week selections went **6/8**, the same fraction as Week 4.

There are two additional distinctions:

- An earlier game-lock Dallas probability was 65.87%; it is a different forecast vintage, not interchangeable with 74.83% when evaluating calibration.
- JAX appeared in 19 of the later 23 cards and was voided by the owner's PHI–JAX exclusion. Of those 19, sixteen lost another leg and three succeeded on the remaining legs. The final 23-card breakdown is **1 all hit + 3 successful reduced-leg settlements + 19 losses**. A reduced-leg success is neither a full-contract all-hit result nor necessarily a refund.

Exact enumeration reuses each game outcome across all cards:

| Saved slate | Model-expected winning cards | Model-implied portfolio risk |
|---|---:|---|
| Week 5 pre-first-game, 18 cards | 4.32 | 41.59% chance of **one or fewer** winners |
| Current Week 6, 18 cards | 6.33 | 16.98% chance of **zero** winners |

These calculations assume the saved probabilities and independence **between games**, not between cards. They are model-implied risks, not externally validated probabilities or a statistical test proving the model adequate. Treating cards as independent incorrectly makes Week 6's zero-win probability about 0.019%.

Week 6 exposure is SF 18/18, NE 16/18, LAR 14/18, IND 11/18, KC 10/18 and JAX 7/18. SF's saved probability is 84.07%; its complementary **15.93% loss event alone defeats every card**. That single-event risk is distinct from the 16.98% overall zero-winner probability.

The Week builder selects combinations from a small set of top favorites (`parlay_builder.py:986–1025`). Same-game selection uses a different objective: descending absolute correlation, then simulated EV (`:874–907`), not simply highest joint hit probability. These are objective mismatches to investigate, not proof that a different ranking would have won Week 5.

Diversification can improve the chance of at least one successful card while reducing individual-card probability or expected total winners. Make the objective explicit; do not market many near-identical cards as independent chances. Evidence: [shared-game enumeration](evidence/portfolio.json).

## 3. MY Parlays really did underperform

These records represent generated team-seeded/dial possibilities, not verified tickets placed by the user. No Week 1 MY archive exists.

| Week | All-hit / all recorded MY cards | Safe all-hit / recorded Safe cards |
|---|---:|---:|
| 2 | 359/2,346 (15.30%) | 229/628 (36.46%) |
| 3 | 221/3,407 (6.49%) | 205/742 (27.63%) |
| 4 | 418/2,720 (15.37%) | 325/768 (42.32%) |
| 5 | 246/5,514 (4.46%) | 96/1,654 (5.80%) |

`resolve_my_cards.py:335–346` currently compares original card probability with `bucket == all_hit` across all graded cards. Changed/void contracts are therefore counted as false, contaminating original-contract calibration.

Even after excluding **every card with any void or pending leg**, a meaningful shortfall remains:

- Safe: **96/893 = 10.75%**, versus saved probabilities averaging **30.40%** (271.49 expected successes).
- All dials: **246/2,574 = 9.56%**, versus **20.29%** predicted (522.28 expected).

These are conditional, overlapping populations, not 893 or 2,574 independent trials. Week 5's 5,514 cards reference only 15 games, with repeated seeds/dials and related lines.

Shared misses include Darnold 200+ passing yards (195 actual; 620 Safe cards), Goff 275+ (271 actual; 1,518 total MY cards, 286 Safe), Dallas ML (567 Safe) and Doubs 30+ receiving yards (16 actual; 151 Safe). Near-threshold outcomes and repeated exposure explain amplification, but do not by themselves distinguish bad luck, poor marginal calibration, joint dependence, or selection bias. Lowering these exact lines after observing results would be hindsight fitting.

## 4. Is self-learning working?

**Some local NFL learning runs; the end-to-end process is not trustworthy enough to call it a validated self-improving engine.** Holding a candidate can be correct. The defects below are more specific than saying all learning failed.

### Confirmed: the MY evaluator applies a second calibration

The production chain is historical base probability → optional live sigmoid correction → final `model_prob` saved on the card. The learner later reads that final probability as raw and applies a candidate correction again.

A real October 6 receipt, `7344a76d`, D. Smith 60+ receiving yards:

| Stage | Probability |
|---|---:|
| Reconstructed historical base | 0.374058 |
| Apply live correction once | 0.520314 |
| Pool / saved card | 0.5203 |
| Evaluation applies the correction again | 0.659025 |

Source chain: `build_leg_pool.py:83–95` → `build_my_cards.py:142–158` → `backtest_leg_pool.py:342–398`.

The layer was adopted October 6 using Weeks 2–4 and disabled October 13 after a reported Week 5 deterioration. **That rollback comparison is invalid as a clean once-versus-never comparison.** We cannot conclude either that the once-applied layer caused the losses or that it was harmless. Keep it disabled until base/served probabilities and versions are recorded and evaluated consistently. Existing Week 6 receipts from before the disable retain their original regime; do not silently rewrite them.

### Other confirmed integrity defects

- **Identity:** `(week, abbreviated selection)` can merge different events. Week 3 contains two distinct players named `T. Johnson 20+ rec yds`, with different player and game IDs. No Week 5 collision was found; this is training-integrity debt, not a demonstrated isolated cause of Week 5 losses.
- **Dashboard chronology:** `build_learning_loops.py:47` takes `rows[-1]`, while `promote_signals.py:1879` prepends new entries. MODEL reports July 18 instead of the October 13 proposal. Some writers append, so select by validated timestamp, not a global index flip. Show effective model state separately from the latest held/reverted decision.
- **Production parity:** live Elo defaults to **k=20**, while metadata says **25**; this predates Week 1. `backtest.py:303` can replace the entire game-parameter object and lose independent signals if adoption occurs. No in-season adoption through that path was found.
- **Replay parity:** production yardage features differ from the historical backtest (`parlay_builder.py:636–647`); `refit.py:239` uses strided rather than chronological folds, and `:542–566` uses fixed end-of-2025 ratings instead of the complete evolving live game path. Historical scores do not validate the exact served function.

### Evidence against blaming every model update

The separate Game/Week prop calibration changed before Week 5. On the **same 45 recorded Week 5 props and original features**, new coefficients improve log loss from **0.667290 to 0.660012**; lower is better. Mean probability change is only 0.00649, with no 0.5 crossings. The fixed selections hit 23/45 regardless of rescoring. This is not a complete selection/card replay, and says nothing definitive about MY's separate calibration layer.

Player PPR MAE for Weeks 1–5 is **6.0865, 5.3504, 5.1690, 5.5179, 5.6881**: a recent worsening but still better than Week 1. The latest candidate's approximately 0.006-point improvement fails its 0.10-point required margin and worsens Week 2; holding it is defensible. Broad ATD probability scores also do not show monotonic deterioration, but their broad population does not validate selected parlay legs.

The game-signal promotion workflow is deliberately **propose-only**, not accidentally failing to auto-adopt. Do not turn on automatic promotion as a purported bug fix. The prop gate currently accepts non-worsening scores; any stronger margin should be task-specific and predeclared, not copied mechanically from the game model's 0.0015 policy.

Evidence: [learning reconstruction and counterfactual](evidence/learning.json).

### Separate SelfLearning repository

At the inspected SelfLearning remote baseline `aa5bbaeddca4138399a21c1894b4aed4bacb52b4`, the NFL adapter, score parity and shared promotion work remain roadmap items. Searches of NFL source/workflows find roadmap mentions, not a live SelfLearning import or service integration. Existing local hosted-foundation changes were preserved.

Therefore, **the separate engine is not currently feeding NFL predictions or receiving a verified closed-loop return path from these results**. This is a code-path finding, not a claim about every deployed service's health. Upstream generic receipt identity, versioned calibration, chronological evaluation and adoption-journal contracts first; introduce a read-only NFL adapter with parity before any shared engine candidate can affect production.

## 5. Data, injury feeds, weather and deployment

### P0 for Week 6: one unknown injury status freezes the whole feed

The public ESPN injury endpoint returned HTTP 200, 32 team groups and 800 rows at **October 14, 1:54 p.m. CDT**. One row, PHI Lane Johnson (`15797`), had `Reserve-Ret` / `INJURY_STATUS_RESERVE_RET`. `availability.py` lacks the mapping; `scrape/espn.py:365–373` raises on it and rejects the entire report.

The retained injury file is from **October 11, 3:10:35 p.m. CDT**. It was 66h52m old at the audited October 14 generation. The first failed daily run is [38180920617](https://github.com/liddar12/NFL2026/actions/runs/38180920617), October 11 at 5:35 p.m. CDT. The same exception appears in [38585561479](https://github.com/liddar12/NFL2026/actions/runs/38585561479).

`build_predictions.py:1090–1097` retains the old file but reports `rows=0`, `age_hours=999`, `last_success_utc=null`. `build_weekly.py:425–437` discards the report timestamp; `:696–704` uses its old statuses for the new week. Pipeline health does show `down`, but producer stages and the overall workflow can still succeed and publish.

Current Week 6 has 34 status-gated players. Of 30 matched to fresh ESPN rows by canonical ID, **15 are now Active or Questionable**: three Active, twelve Questionable. Thirteen of those item updates predate the audited build; Lamar Jackson and Caleb Williams were updated later. Four players remain unmatched/unknown. Questionable is eligible under the app's policy, not a guarantee of playing; other gates can still exclude a player. This proves incorrect retained status reasons, not that all 15 should become recommendations.

Repair retired-status semantics and quarantine unknown rows without mapping them to Active. Preserve the other valid rows, distinguish parser drift from transport failure, retain real last-success timestamps, and prevent stale data silently determining new-week eligibility.

**Timing matters:** Thursday and Sunday pre-noon Week 5 injury snapshots were healthy. This late-Sunday incident cannot explain Dallas's Thursday loss or the noon misses. Evidence: [frozen source comparison](evidence/injuries_2026-10-14.json), [public source](https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries).

### Another eligibility gap

`build_predictions.py:871–879` strips per-game `week`, then passes the rows to `build_props_by_game` (`:1519–1525`). Without a week, `_week_of` returns `None` and the weekly `avail:false` check is skipped. This persistent caller/callee contract bug needs a production-shaped regression test. It is not proof that every current Game prop is invalid.

### Weather: a limitation, not an established dominant Week 5 cause

The last saved forecast before Sunday noon, `143f3cad`, captured at 11:15:34 a.m. CDT, reports outdoor rain of **0.7 mm CLE–NYJ**, **0.4 mm IND–PIT**, **0.4 mm NYG–WAS**, and zero in the other available future outdoor rows. Outdoor winds are below the live 24 km/h threshold; temperatures above freezing. Arizona's larger wind value belongs to an indoor/retractable venue.

Production applies static roof/cold/RB-wind rules, **not precipitation** (`build_weekly.py:285–422`). The weather study remains measurement-only with no adopted candidate. These records do not support a broad heavy-rain explanation, but are not full-game observed conditions: actual roof state, forecast vintage and all-quarter weather remain gaps. Add those data and analyze residuals before fitting a weather effect; do not invent a rain multiplier to explain five weeks retrospectively.

### Hosting and pipeline reliability

The [October 8 hosting RCA](https://github.com/liddar12/NFL2026/blob/fb8830ae35f1e11d3f589b435e303b719886e3e7/docs/qa/RCA_2026-10-08_NETLIFY_CREDITS.md) records a roughly 38-hour credit-related stale deployment during Week 5 preparation. It recovered before Thursday kickoff, so it is not evidence that Sunday's slate was stale.

This audit independently compared nine public files on `https://nfl2026.netlify.app` with the pinned Git baseline; HTTP status and SHA-256 results are in [live hash evidence](evidence/live_hashes.json). This establishes the audited files at the check time, not every historical deployment or the separate custom hostname.

**R102 already added data CI.** Its producer-completion trigger runs after publication and independently checks out moving `main` in different jobs. It can diagnose a generation after release and potentially test different heads. R111's concurrent-publish fallback preserves receipts while reusing older regenerable data; that deliberate degraded generation should be visible. Add focused semantic checks before publication and bind all checks to the exact released generation; retain post-publish browser checks.

## 6. Changes that confound the apparent trend

| Change | Interpretation |
|---|---|
| R53/R73, Sep 13–14 | Ledger/review/history arrived during or after Week 1. Current early archives are not necessarily pregame forecasts. |
| R74–R87, Sep 16–19 | MY pool, availability, math and risk-dial changes alter candidate/receipt populations. |
| R100, Sep 24 | Live MY learning wiring added; first adoption occurred after Week 4. |
| R102, Sep 25 | Post-publication data CI exists; older claims of no data CI are obsolete. |
| R106, Oct 1 | Correct whole-card loss/DNP settlement, archive freeze and full-history grading change measurement. Preserve these fixes. |
| R108, Oct 4 | Owner excludes IND–WAS after its early kickoff; administrative void policy changes results. |
| R109/R111, Oct 4 | MY spread/dial policy and publish-race fallback change selection or generation behavior. |
| R117, Oct 6 | MY prop dial tolerance ±0.10 applied after live calibration; Week 5 is the first new week after its Weeks 2–4 evaluation. Isolate this from the calibration effect. |
| R118, Oct 7 | Recorded-team grading fix changes displayed outcomes for traded players without changing forecasts. |
| R119/R120, Oct 11 | PHI–JAX excluded after its 8:30 a.m. CDT kickoff; archived legs void and entirely excluded cards leave tallies. |
| R121–R124, Oct 11–13 | Pricing/final availability/tie/bye test repairs are correctness work, not evidence of improved predictive skill. |

Do not roll back these releases as a bundle. Separate data eligibility, probability calculation, candidate selection, portfolio construction and settlement policy in an as-of replay.

## 7. Why tests missed this

The latest audited [data CI run 38586365537](https://github.com/liddar12/NFL2026/actions/runs/38586365537) passed **2,063 feature tests**, the data gate and **355 browser tests**. Locally, data validation and 18 focused learning/reporting/settlement tests also passed. The full browser suite was observed in CI, not rerun locally by this audit.

| Missing oracle / scenario | Why a green suite was insufficient | Required acceptance evidence |
|---|---|---|
| Newly introduced provider enum in a mostly valid response | Fixtures do not exercise the live `Reserve-Ret` whole-feed failure | Valid rows survive; unknown player stays unknown/non-offered; real freshness is retained |
| Learning after its own first adoption | Unit tests do not follow base → adopt → serve → resolve → reevaluate | Two-cycle fixture proves exactly one calibration, with frozen base/served/version |
| Independent chronological history oracle | Builder and tests can agree on the same wrong last-row convention | Mixed append/prepend histories select the latest timestamp and expose effective state |
| First-publication provenance | Schema-valid historical cards can still be created after outcomes | Prospective score excludes post-kickoff or unreconstructable receipts; R106 stays covered |
| Production-shaped caller contract | Isolated prop-builder tests can supply a week that the real caller omits | End-to-end caller fixture carries game week and enforces availability |
| Shared exposure and changed contracts | Cards individually validate while portfolio risk/metrics mislead | Exposure/dependence tests and separate original-contract vs settlement metrics |
| Exact pre-publication generation | Post-publish regression checks do not block semantically stale data | Focused gate checks the exact tree and source timestamps released |

The missed issues are primarily **test coverage and oracle-design gaps**, not evidence that existing tests did not run. A browser that renders correctly is not proof of a valid statistical experiment or a functioning adaptive loop.

## 8. Statistical interpretation and Week 6 decision

The available evidence supports concentration and measurement defects strongly, confirms specific learning/data bugs, and leaves several causal questions unresolved. It does **not** identify a coefficient change that would honestly guarantee 15/18 wins. Under the current Week 6 model the expected count is only about 6.33/18, and the seven-leg cards average roughly 13.11% joint probability.

Use proper probability scores (log loss/Brier), selected-leg calibration, complete-card outcomes and portfolio concentration as different measures. Freeze decision times, model versions and settlement policies. Deduplicate repeated offers and cluster uncertainty by game/week; five weekly clusters cannot support precise causal estimates. Evaluate proposed line/ranking/calibration changes with rolling-origin, production-shaped replay and an untouched future cohort. Historical closing markets may be benchmarks, not assumed available earlier or silently introduced as predictors against existing policy.

See [WEEK6_ROADMAP.md](WEEK6_ROADMAP.md) for owners, LOE, risk, release gates, the replay experiment and the SelfLearning handoff.

## Collaboration, reproducibility and limits

- Three parallel internal audits covered weekly metrics/provenance, learning/backtests, and pipelines/history. A separate adversarial check reproduced the portfolio arithmetic and confirmed distinct underlying games.
- A **local Claude Code read-only peer review** inspected the pinned source and evidence and reconciled its conclusions. This is not access to the user's other Claude conversation. See [final peer response](evidence/CLAUDE_PEER_REVIEW.md); the primary report governs the two wording corrections recorded at its top.
- [REPRODUCE.md](REPRODUCE.md) documents the scripts and evidence manifest. Frozen JSON preserves the source/status observation; rerunning a live source check can legitimately change it.
- No application code, prediction files, cloud configuration or deployed services were changed. The only durable additions are this review/evidence package. Nothing was committed, pushed or deployed.
- Not completed: full cross-version candidate reselection on every historical as-of input, observed full-game weather attribution, a causal once-applied MY calibration estimate, verification of the user's actual sportsbook tickets, or a production SelfLearning integration. These are explicitly scoped follow-ups, not claimed results.
