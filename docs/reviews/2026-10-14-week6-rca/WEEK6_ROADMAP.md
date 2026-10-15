# Week 6 roadmap and Claude Code implementation handoff

Revision 1 — October 14, 2026, 2:10 p.m. CDT (America/Chicago). **Proposed work; none of these application fixes were implemented by the RCA.** Baseline `fb8830ae35f1e11d3f589b435e303b719886e3e7`. Read [the RCA](README.md) before changing code.

## Release intent and boundaries

Deliver trustworthy inputs, receipts, measurements and visible risk before attempting to improve predictive equations. Preserve existing R102 data CI, R106 archive/settlement protections and immutable prediction receipts. Do not force a model adoption, change owner exclusions retrospectively, silently use market prices as predictors, or promise 15/18 wins.

The existing schedule shows the first Week 6 kickoff **Thursday, October 15 at 7:15 p.m. CDT**. Sunday, October 18 has an **8:30 a.m. CDT** early game and the main **noon CDT** window. Recheck the authoritative schedule before release. Dates below are target checkpoints, not completed work or guarantees.

Recommended ownership: Claude Code can take the NFL implementation lanes below; a second reviewer independently checks receipts, metrics and the tested deployment. These are proposed assignments, not claims that the user's separate Claude session has accepted them. The local read-only Claude peer review is recorded with this report.

## Sequencing, risk and effort

Estimates are engineering days, include focused tests, and overlap where noted. They are not elapsed-time promises. A single engineer should prioritize A/B containment and evidence over trying to land every item before Thursday.

| Priority / lane | Deliverable | Target | LOE | Main risk / release rule |
|---|---|---|---|---|
| P0 / A | Injury vocabulary, row quarantine, truthful freshness and new-week eligibility | Thu Oct 15, 5 p.m. CDT | 0.5–1.5 days | Incorrectly admitting an unavailable player; unknown never becomes Active |
| P0 / A | Pass event week through the real Game-prop caller | Same containment release if verified | 0.5–1 day, overlaps A | Broader missing-data behavior; test actual caller shapes |
| P0 / B | Keep MY correction held; surface effective regime and existing stale-source/concentration warnings | Before Thursday kickoff | 0.25–0.5 day for containment | Do not rewrite earlier Week 6 receipts or imply a held model is proven bad |
| P1 / B | Base/served/version receipts, canonical identity and valid two-cycle learner | Sat Oct 17, 5 p.m. CDT candidate freeze | 1–2 days plus 0.5–1 identity work, overlapping | Historical inputs partly unrecoverable; quarantine rather than fabricate |
| P1 / C | Original-contract calibration, settlement revisions, provenance scoreboard, chronology display | Before Sunday early kickoff, if verified | 1–2 days | Historic displayed metrics change; show explanation and retain raw history |
| P1 / D | Exposure summary and highest-hit versus diversified comparison | Warning before Thursday; selection experiment before Sunday | 0.5–1 day warning; 1–2 days experiment | Diversification can reduce individual hit probability; no arbitrary silent cap |
| P1 / E | Focused prepublish semantic gate and exact-generation served check | Before Sunday; sooner for A | 1–2 days | Publishing latency or overbroad halt; isolate affected markets |
| P2 / F | Effective-parameter reporting and safe parameter-family merge | Before Sunday if bounded | 0.5–1 day | Do not activate k=25 just because metadata says 25 |
| P2 / F | Full chronological live-path replay and selection ablations | Shadow-only during Week 6 | 2–4 days | Incomplete as-of inputs and leakage; explicit unreconstructable coverage |
| P2 / G | Forecast/roof/full-game weather receipt checks | During Week 6 | 1–2 days | Observed weather is unavailable pregame; do not leak it into forecasts |
| Next / H | Upstream generic contracts and read-only SelfLearning NFL adapter | After contract stabilization | 2–4 days for bounded adapter/parity milestone | Cross-domain behavior drift; no immediate production migration |

### A. Restore trustworthy availability first

Touch points: `scripts/availability.py`, `scripts/scrape/espn.py:365–373`, `scripts/build_predictions.py:871–879,1090–1097,1519–1525`, `scripts/build_weekly.py:425–437,696–704`, `scripts/models/parlay_builder.py:708`.

Implement explicit retired/nonplayable semantics for `Reserve-Ret`, preserving raw provider status. Unknown future statuses should quarantine the affected row, not reject all otherwise valid rows or become healthy. Separate transport failure, parser drift, incomplete coverage, stale last-good data and an authoritative fresh source. Carry `source_updated_utc`, `received_utc`, `last_success_utc`, source/event week and freshness policy into eligibility decisions.

Define the freshness threshold relative to event time and actual refresh cadence; report the chosen policy explicitly. A bounded fallback must not silently carry last Sunday's OUT into a new week. Keep unaffected markets operating; withhold affected player recommendations when status cannot be trusted. A warning alone is insufficient if an invalid status still drives an authoritative recommendation.

Acceptance:

- An 800-row fixture containing 799 understood statuses and one unknown retains the 799 valid records, flags the unknown, and never maps it to Active. Separately, the known retired status is represented as nonplayable without fabricating a four-week IR absence.
- Freshness preserves the real October 11 last-success value, not `999/null`; the actual source failure is visible even if the process exits successfully.
- The new-week stale-report fixture cannot create silent authoritative eligibility decisions.
- Replay the 34 status gates by canonical ID. Review the 15 currently Active/Questionable changes and four unknowns; do not assert all 15 are otherwise eligible. Check QB-depth and game-final rules independently.
- A production-shaped Game-prop input includes its event week; an `avail:false` weekly row is rejected through the real caller, with separate pregame and final-game expectations.
- Re-fetch, regenerate in a test workspace, validate joins and compare candidate changes. Publish only after source quality and exact-generation tests pass.

### B. Repair learning lineage before permitting readoption

Touch points: `build_leg_pool.py:83–95`, `build_my_cards.py:142–158`, `backtest_leg_pool.py:342–398`, archived MY receipts and model/candidate artifacts.

Each new leg receipt needs season, game ID, player ID, market, line, direction, immutable receipt/contract ID, decision cutoff, first publication evidence, feature/source timestamps, base probability/version, served probability, calibrator ID/version and generation SHA. Each card also needs selection-policy and joint-model versions. Keep outcome and settlement revisions separate from the original prediction.

Evaluate incumbent and candidate from the **same immutable base and feature vintage**. Deploy exactly the transformation evaluated. Old records without recoverable base/version data must be labeled unavailable for that experiment, not inferred from today's features. Document how many rows remain usable and any selection bias. Preserve already-issued Week 6 forecasts, with their effective calibration regime.

Acceptance:

- Full two-cycle regression: base → adopt → serve → resolve → re-evaluate; exactly one live correction is applied in both serving and evaluation.
- The real D. Smith chain reproduces base 0.374058 → served approximately 0.5203; 0.659025 is recognized as the second-application error, not the corrected once-served prediction.
- Reordering archives does not change joined probabilities or eligibility.
- Two `T. Johnson` player IDs in the same week remain distinct; the same player in different games also remains distinct. Include multiple lines, trades, repeated snapshots and duplicate ingestion.
- A previously adopted layer followed by hold/revert reports the actual effective version. Keep the currently disabled layer off until corrected evidence clears its policy.

### C. Separate prediction accuracy from settlement/accounting

Touch points: `resolve_my_cards.py:335–346`, `build_review.py`, `build_parlay_archive.py`, `build_learning_loops.py:47`, MODEL/review displays.

Expose four distinct results: unchanged full-contract all hit, successful reduced-leg settlement, pure void/refund, and loss; retain pending separately. A valid void may reduce the number of settled legs. Do not mutate the original contract to make it appear originally shorter. Binary all-hit calibration excludes changed contracts unless a separately documented multi-outcome model is used.

Label historical records as verified pregame commitment, retrospective, or unreconstructable. Preserve raw archives; publish a separate fixed-decision-time scoreboard with card scope, length, dial, model version and denominator. Generated recommendations are not user tickets. Choose the latest learning run by validated timestamp across mixed writer order, and show the effective adopted state separately from the latest decision.

Acceptance:

- The current Week 1 16/18 cannot appear as a verified prospective score; the reconstructed first-kickoff cohort remains 1/18.
- Week 5's current Week archive reconciles to 1 full hit + 3 reduced-leg successes + 19 losses. Its fixed 18-card cohort has 1 original-contract winner versus one reduced-leg success under later exclusions.
- MY Week 5 clean Safe cohort reproduces 96/893 and the approximately 30.40% saved probability mean. Any changed definition displays a new cohort/version instead of silently replacing it.
- A voided profitable remaining-leg settlement is not mislabeled a full win or necessarily a refund.
- Mixed prepend/append history selects October 13, not July 18; hold-after-adopt and revert-after-adopt fixtures display the effective state correctly.
- R106 continues rejecting new post-kickoff card identities while preserving immutable pregame receipts and legitimate settlement updates.

### D. Align the selection objective and show shared risk

Touch points: `models/parlay_builder.py:874–907,986–1025`, MY selection/risk-dial functions, Parlay/MY UI and exports.

First ship truthful exposure: per-game/player inclusion count, top shared failure events, effective independent games, joint hit probability and probability of zero/at least one winning card when the model supports it. Label model-implied risk and simulated prices; do not present simulation EV as executable sportsbook value.

Then compare, on the same frozen candidate universe:

1. **Highest individual hit probability:** order eligible cards by estimated joint hit probability, with deterministic tie-breaks. Test the Game builder against its current absolute-correlation-first ranking.
2. **Diversified portfolio:** optimize a declared objective such as chance of at least one winner, with a documented exposure limit and expected-success tradeoff. Broaden eligible games or offer fewer cards if the cap is infeasible; never duplicate cards to fill a quota or silently violate the cap.

Recommended default for immediate containment: visible risk warnings, preserving selection behavior until the comparison is validated. A diversified option can then be explicit; the user's highest-hit objective is not automatically permission to lower every card's probability for diversity.

Acceptance:

- Current Week 6 fixture clearly states SF in 18/18 and one SF loss loses all 18.
- Shared-game enumeration reproduces approximately 16.98% zero-win risk, not the incorrectly independent-card 0.019%.
- Independent-card and shared-game fixtures diverge as expected; impossible/mutually exclusive same-game selections remain excluded.
- A lower-correlation pair with higher validated joint hit probability wins under a highest-hit policy. Correlation alone never masquerades as probability.
- A chosen exposure cap is enforced or reported infeasible; tests verify determinism and no duplicated filler. Display what expected individual/portfolio performance was traded away.

### E. Gate the data actually released

Touch points: producer workflows, `.github/workflows/data-ci.yml`, `publish_data.sh`, generation/pipeline manifest and public build metadata.

Keep existing post-publication browser coverage. Add a fast prepublication semantic gate for source freshness, event identity, eligibility, one-time calibration, immutable locks, candidate/settlement joins and generation coherence. Bind validation to one candidate tree/commit and record source timestamps. Mark concurrent-publication fallback generations degraded instead of implying every input was regenerated successfully.

Acceptance:

- An unknown-status/stale-new-week fixture cannot pass as healthy merely because JSON schemas and build steps succeed.
- Test and deploy identify the same immutable generation; both CI jobs check the intended SHA, not independently moving main.
- A failed or skipped deployment alerts; public source timestamps and hashes distinguish published Git data from data actually served.
- Recheck the nine audited public assets plus newly changed contracts after release. Validate early-game cutoff, not just Sunday noon.
- A failure isolates the affected market/data product where safe; it does not require a blind global outage or a silent stale fallback.

### F. Statistical replay and model parity

Make effective settings observable and preserve unrelated parameter families on every adoption path. Report k=20 if that is what live Elo consumes; activating a different k is a model change requiring evaluation, not a display fix.

Build the following experiment before attributing losses to an equation:

| Dimension | Required comparison |
|---|---|
| Code | Exact pre-change and post-change revisions; only specified model/selection components differ |
| Weeks | Same pregame decision cutoffs and as-of feature snapshots for both versions |
| Probability | Common-base once-applied incumbent/candidate calibration |
| Selection | Fixed-leg scoring **and separately** complete candidate reselection/card construction |
| Policies | Same availability, market universe, leg lengths and original exclusion policy; settlement policy reported separately |
| Attribution | Calibration × R117 dial policy; current correlation ranking × joint-probability ranking; freshness and feature changes isolated |
| Unavailable history | Explicit missing/unreconstructable rows and coverage, never today's data substituted as past knowledge |

Use the production forecasting function in chronological rolling-origin tests. Train strictly before test cutoff; no strided future-week training or observed future weather. Recompute Elo sequentially and include the same live signals, availability and yardage transformation. Distinguish a backward compatibility check on old labels from a genuine earlier-time forecast.

Report log loss, Brier score and calibration by market/position/line range; actual versus expected complete-card wins by length/dial; and shared-game portfolio distribution. Deduplicate recommendation copies and cluster uncertainty by game/week. With only five weeks, use broad intervals and descriptive evidence; hierarchical shrinkage can borrow historical information but does not manufacture independent samples. Predeclare one primary metric, practical-effect margin and safety constraints per task, and account for the many tried candidates. Cut off model training/tuning at Week 5, preserve Thursday's original regime, and evaluate later Week 6 predictions prospectively under their frozen regime. A Saturday freeze occurs after Thursday's result: if that outcome influences revisions, Week 7 is the first wholly untouched weekly holdout, not all of Week 6.

Acceptance: fixed-leg reproduction remains approximately 0.667290 old versus 0.660012 new log loss on 45 Week 5 props; a complete selection rerun is separately labeled. Parity failures block promotion. No policy is tuned until it retroactively reaches 15/18 and then presented as validated.

### G. Weather and unknown variables

Persist forecast provider issue time, receipt time, event-time window, units, venue and actual/unknown roof state. Capture the full expected game window, not only kickoff. Missing source conditions remain unknown, not zero rain. Preserve forecast histories under concurrent publication.

For attribution, use residual outcomes conditional on pregame predicted probability and relevant exposure (market, position, line, quarterback changes, pace/pass-volume expectations, rest/travel, venue and forecast conditions). Use shrinkage and limited predeclared interactions such as outdoor rain × passing market; avoid a many-variable fit to five weekly outcomes. Observed full-game weather can explain residuals retrospectively but must not enter an ex-ante replay as if known. Include an uncertainty/abstention policy for stale or weakly supported inputs rather than unsupported confidence boosts.

Acceptance: indoor/retractable and outdoor exposures are not conflated; forecast-as-of and observed-weather studies are labeled separately; any proposed weather coefficient is shadow-only until sufficiently supported out of sample. Existing market-measurement-only policy remains intact.

### H. Make the improvements reusable in SelfLearning

Upstream domain-neutral contracts and tests to `liddar12/SelfLearning` after NFL correctness is established:

- Immutable observation/feature receipts and canonical event identities.
- Base/served probability and transformation versions; idempotent ingestion and outcome revisions.
- Chronological evaluation, grouped uncertainty, candidate registry and adoption/rollback journal.
- Freshness/coverage/abstention status and provenance-aware result metrics.

Keep NFL adapters responsible for player/game identity, sport-specific features, injury semantics and settlement. Generic engine code should not contain NFL-specific names, rules or sportsbook assumptions. A read-only adapter first ingests NFL receipts/outcomes and must reproduce scores and cohort membership exactly. Only then can a controlled return path offer a versioned candidate; NFL retains an explicit validation/promotion boundary and rollback path. The engine should not directly overwrite live predictions.

Acceptance: repeated ingestion is idempotent; original receipts survive outcome corrections; NFL local and engine scores agree within declared numerical tolerance; malformed/late records are quarantined; a shared candidate cannot bypass NFL's promotion policy. A second non-NFL fixture proves generic contracts without initiating financial/election production forecasting. Broader backend/frontend/MCP rollout is a separate scope, not a Week 6 emergency migration.

## Release acceptance and evidence checklist

1. Rebase the proposed change onto the then-current main in a separate branch; inspect concurrent Claude changes and preserve them.
2. Each lane supplies fixtures reproducing the observed defect, before/after evidence, and explicit data/model version changes. Run relevant feature tests, schema/data gate and UI acceptance where displays change.
3. Verify changes in preview against a generated candidate dataset. Test errors, stale input, unknown statuses, first/last kickoff boundaries, voids and mixed regimes, not only happy-path rendering.
4. For Thursday containment, require A, truthful effective calibration state, and visibility of shared exposure. If the deeper learner is not ready, keep it held. No rushed equation retune is required to restore input correctness.
5. Before Sunday, freeze selection/model policy and timestamped receipts, then run complete regression checks on the exact release SHA. Do not reset Thursday's issued receipts during a later deploy.
6. After any authorized production release, compare served hashes/source ages and the source-health/eligibility counts. Preserve a deploy manifest and verified rollback target.
7. Evaluate Week 6 prospectively by scope/length/dial, with administrative settlements separate. Report both improvements and regressions; no guarantee of a winning total follows from these engineering repairs.

This report authorizes no additional production action by itself. It is the review/handoff requested by the user; implementation and deployment remain distinct actions from this RCA.
