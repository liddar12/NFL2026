# Week 6 corrective build — working status

Started October 14, 2026, 8:25 p.m. CDT (America/Chicago). Handoff revision: October 14, 2026, 9:05 p.m. CDT. The owner paused implementation and then authorized publishing the work to GitHub for Claude Code. This is an unfinished implementation checkpoint, not a release.

## Scope and safety

- NFL build worktree: `/Users/jliddar/code/NFL2026-week6-build`, branch `build/week6-correctness-20261014`, starting at `812657b3` (latest main at start).
- Shared-engine worktree: `/Users/jliddar/code/SelfLearning-week6-build`, branch `build/nfl-feedback-contracts-20261014`, starting at `aa5bbae`.
- Original checkouts, September work and uncommitted hosted-foundation work remain untouched.
- The owner authorized pushing the handoff and unfinished implementation to feature branches. Production deployment, merging to main, cloud configuration and database migrations are outside this publication task.
- Architecture remains the existing static NFL app, scheduled Python producers and a controlled shared-engine boundary. No new frontend framework, market-derived predictors or arbitrary model adoption.
- RCA and detailed acceptance roadmap: [the preserved evidence package](reviews/2026-10-14-week6-rca/README.md).
- Start here: [Claude continuation handoff](CLAUDE_WEEK6_HANDOFF.md). That file records newer main changes, remaining failures and cross-repository links.

## Workstreams

| Lane | Work | State |
|---|---|---|
| A | Injury vocabulary/quarantine, source freshness, event-week eligibility | Implemented locally; integration failures and R125 reconciliation remain |
| B | Immutable base/served/version receipts; canonical identity; two-cycle calibration | Implemented locally with focused tests; publication provenance and card-ID migration remain |
| C | Changed-contract calibration denominator; truthful learning chronology | Producer changes tested; two older UI assertions and chronology display integration remain |
| D | Shared-event portfolio risk, constrained diversification and visible warnings | Risk summary and shadow selector implemented; browser acceptance and selection-policy evaluation remain |
| E | Exact-generation semantic checks, regression and browser acceptance | Full integrated gate not completed; known failures documented |
| F | Read-only NFL → SelfLearning adapter, score parity and controlled candidate boundary | Offline adapter and 19 tests implemented in companion branch; cross-repository parity, persistence and controlled return path remain |

## Acceptance and completion

Each lane must add a regression that reproduces the observed defect and pass the relevant existing checks. The next implementer must run the full ordered gate and browser tests, examine generated candidate outputs, and obtain independent review. A proposed future policy is never labeled active unless the actual producer/UI path consumes it. Focused passing checks do not establish that this integrated branch is ready to merge or deploy.

Keep historical receipts immutable. Distinguish original predictions from later settlement changes and implemented local behavior from deployed behavior. Broader model replay, weather attribution and controlled engine promotion remain part of the roadmap; do not mark them complete merely because ingestion or unit tests work.
