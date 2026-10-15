# Claude Code continuation: Week 6 parlay accuracy

Revision 1 — October 14, 2026, 9:05 p.m. CDT (America/Chicago).

The owner requested that the RCA, evidence and unfinished implementation be published for Claude Code to continue. Implementation is paused. This branch is a work-in-progress checkpoint with known failures; it is not approved for production deployment.

## Branches and starting points

- NFL implementation: [`build/week6-correctness-20261014`](https://github.com/liddar12/NFL2026/tree/build/week6-correctness-20261014), based on `812657b3`.
- Shared engine: [`build/nfl-feedback-contracts-20261014`](https://github.com/liddar12/SelfLearning/tree/build/nfl-feedback-contracts-20261014), based on `aa5bbae`; read its [`docs/NFL_WEEK6_HANDOFF.md`](https://github.com/liddar12/SelfLearning/blob/build/nfl-feedback-contracts-20261014/docs/NFL_WEEK6_HANDOFF.md).
- Current RCA: [README](reviews/2026-10-14-week6-rca/README.md), [acceptance roadmap](reviews/2026-10-14-week6-rca/WEEK6_ROADMAP.md), [reproduction](reviews/2026-10-14-week6-rca/REPRODUCE.md), and [Claude peer review](reviews/2026-10-14-week6-rca/evidence/CLAUDE_PEER_REVIEW.md).
- [Build inventory](WEEK6_BUILD_STATUS.md).

Fetch both repositories and inspect current main before integrating. Preserve concurrent changes. The original local NFL checkout is an older audit branch, and the original SelfLearning checkout has separate dirty hosted-foundation work. Neither original checkout was reset or included wholesale in this publication.

The copied RCA package is byte-for-byte the October 14 afternoon capture. Its statements about then-current source health and uncommitted/unpublished status describe that capture. This handoff records the later implementation/publication context; do not rewrite historical evidence to imply it was captured later.

## Newer main changes that must be reconciled

Last fetched NFL main: `a8ef8d5e` (October 14, 9:01 p.m. CDT).

1. `99f6619a` / R125 maps `Reserve-Ret` to IR. Our branch introduces explicit RETIRED semantics and broader quarantine/freshness controls. Reconcile those alternatives deliberately; retirement must not invent an IR recovery period or become an injury-training label.
2. `f02107a1` refreshes data. Committed injuries contain 800 rows with timestamp `2026-10-15T01:29:27Z` and injury feed status `ok`. The original frozen-feed incident is historical evidence, not the current feed state.
3. `a8ef8d5e` pins `Suspension` and `Reserve-Ret` in injury-history observations after the fresh report exposed another selftest failure. Preserve its coverage when completing our explicit vocabulary changes.

These commits are not merged into this checkpoint. Do not overwrite newer generated data with this branch's older artifacts. Production delivery of these exact revisions was not independently checked during this handoff.

## What the RCA establishes

- Week 1's displayed 16/18 is not a verified prospective baseline. Fixed pre-first-kickoff Week 1–5 cohorts grade **1/18, 1/18, 1/18, 8/18, 1/18**.
- DAL appeared in 17/18 original Week 5 cards; one DAL loss defeated all 17. Audited Week 6 cards put SF in 18/18.
- Week 5 MY Safe unchanged-contract cards hit **96/893 = 10.75%**, against approximately **30.40%** predicted. Overlapping cards are not independent trials.
- MY evaluation applied a second correction to probabilities already adjusted in serving. A real example was base **.374058 → served .5203 → erroneous .659025**. The old rollback comparison cannot establish whether one application helped or hurt. Keep the disabled layer held until valid evidence supports adoption.
- The injury incident began after the Week 5 noon games and cannot explain those earlier misses.
- Separate SelfLearning is not a verified production NFL feedback loop. The companion branch adds offline validation/scoring only.
- There is no demonstrated coefficient change that guarantees 15/18. Do not hindsight-fit that target.

## Implemented here, still requiring integration

**Availability:** `scripts/availability.py`, `scripts/scrape/espn.py`, `scripts/build_predictions.py`, `scripts/build_weekly.py`, the shared playable helper, browser availability display, schemas and validator now address explicit retirement, unknown-row quarantine, source freshness and event-week propagation. A source that cannot authorize availability withholds affected recommendations while retaining projected ability. Review the 24-hour freshness policy against refresh cadence and event time.

**Learning lineage:** `scripts/learning_receipts.py`, pool/card writers and learner add canonical event identities, frozen features, immutable base/served probabilities, model/calibrator versions, source timestamps/digests, explicit settlement predicates and once-only correction parity. Legacy/malformed/late/conflicting records are quarantined. The audit found 36,854 repeated historical graded-leg records without base receipts, yielding zero eligible historical unique legs under these rules. New valid observations or auditable historical recovery are required; do not reconstruct bases from today's model. First-publication evidence, card-level policy/joint-model versions, outcome-revision persistence and safe display-key migration remain incomplete. Receipt payloads increase storage and should later be deduplicated.

**Scoring/reporting:** `scripts/resolve_my_cards.py` separates unchanged-contract calibration from settlement reporting, preserving canonical leg/receipt identities. `scripts/build_learning_loops.py` selects decisions by validated timestamp and reports effective configuration separately from the latest decision. Historical original contracts must remain immutable through void/reduced settlements.

**Portfolio:** `scripts/models/portfolio.py`, `scripts/evaluate_week_portfolio.py`, `app/portfolio-risk.js` and Parlay UI integration report shared exposure. The constrained selector is a deterministic shadow heuristic, not an activated or proven optimal portfolio policy. On the saved baseline, a 9-of-18 game exposure cap lowered model-implied zero-winner risk from approximately 17.0% to 13.6%, while expected winners fell from 6.33 to 4.56. Recompute on current inputs. Warnings alone do not diversify the offered cards.

## Known failures and next implementation steps

1. `scripts/build_injury_history.py --selftest` fails because RETIRED is unclassified. Put retirement in `REPORT_IGNORED`, preserve R125 follow-up observations, and keep it out of injury training.
2. Complete RETIRED consumers in `scripts/build_line_report.py` (`OUT_CODES` and severity ordering) and `scripts/models/player_projection.py` (`_INJURY_STATUS`). Do not change fitted weights as part of this vocabulary repair.
3. `app/views/model.js` expects `chronology_warnings`, while the producer emits `chronology:{invalid_timestamps,latest_conflict}`. Align and verify the actual display.
4. Two assertions in `tests/feature/r87_my_cards_record.test.mjs` still expect the old mean-conviction text. Update them to the honest cohort presentation and add an independent denominator test.
5. Finish actual browser acceptance for exposure, filtered card counts, Game/Week/MY/TD mode transitions and mobile containment. The earlier Playwright attempt omitted its config and executed no tests.
6. Test actual generated candidate data through producer → JSON → UI → settlement. Add exact-generation semantic prepublication checks while preserving R102 postpublication CI and R106 archive protections.
7. Evaluate highest individual joint-hit probability and diversified portfolio objectives explicitly. Cover Game/MY shared game/player outcomes, enforce selected caps or report infeasibility, and never duplicate filler. Do not silently lower the owner's highest-hit objective. The independent-game calculation is not a validated joint model for arbitrary player props.
8. Complete chronological, as-of production-path replay and separate fixed-leg rescoring from complete candidate reselection. Isolate calibration, R117 dial policy, ranking and availability effects. Resolve training/serving feature differences, truthful Elo k=20 metadata and parameter-family preservation without activating k=25 just to match metadata.
9. Persist forecast issue/receipt time, full game-window weather and roof state. Missing rain remains unknown. Use weather interactions only in shadow until supported out of sample. Markets remain display/benchmark data, never model or ranking inputs.
10. Finish the companion adapter's actual-producer parity test, full suite, documentation and malformed-input review. Idempotent persistence, outcome revisions, candidate return/promotion policy and rollback are subsequent integration work. Ingestion alone is not self-learning.

## Verification observed before publication

- Availability: 46 focused tests, availability/weekly selftests, module compilation and data validation passed.
- Learning receipts: 25 combined focused/existing tests passed; a final 10-test receipt run, three Python selftests and data validation passed. A current-input dry build produced 1,007 receipts with zero receipt validation errors; correction remained disabled.
- Reporting: 36 focused tests, resolver selftest and data validation passed. The two older UI-text assertions remain to be updated.
- Portfolio/browser availability: 30 combined feature tests passed. The new browser acceptance test has not executed successfully.
- Shared engine: 19 new unittest tests passed. Full engine regression and cross-repository parity have not run.

These are focused results from the implementation session, not proof that the combined branch passes the full gate. Known failures are intentionally preserved in this checkpoint for completion by the next implementer.

Run the complete NFL gate after integration:

```bash
bash tests/run_gate.sh
npx playwright test --config tests/playwright.config.mjs tests/web/week6_risk.spec.mjs --project=web
```

Gate on exit codes and confirm browser tests actually run. Verify card containment at card boundaries, not only page width. Simulated payout/EV must stay distinguishable from a sportsbook quote.

## Historical reviews and completion rules

Reconcile `docs/RCA_MYPARLAYS_CARDS.md`, `docs/qa/CODEX_REVIEW_R82_FOR_CLAUDE.md`, `docs/qa/RCA_R84_PARLAY_PAYOUT_AND_OVERFLOW.md`, R83/R85 release notes, `docs/qa/INDEPENDENT_REVIEW_R87_R91.md`, relevant R30 findings and `docs/REPLAY_LAB.md` against current code. Many historical payout/layout/settlement repairs are already committed; do not reopen them solely because old reports say local-only.

Proceed on routine authorized implementation and verification. Ask material product questions one at a time with choices, a recommendation, risk and LOE. Preserve vanilla JS/PWA, stdlib fast gates, market/model separation, immutable archives, current exclusions and promotion safeguards. Keep all work on review branches until release requirements are met. The owner authorized GitHub publication of this checkpoint; merging to main and production deployment are separate actions.

Completion requires a finding-by-finding inventory, passing full regression and real UI acceptance on the exact release candidate, small reviewed commits, and explicit remaining limits. Distinguish implemented, merged and production-verified behavior. No forced learning adoption, weakened tests or promised win count.
