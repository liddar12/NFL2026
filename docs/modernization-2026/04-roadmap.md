# Implementation roadmap and acceptance plan

**Status:** implementation backlog, not completed production work. Estimates are planning ranges for one engineer with focused QA assistance. Calendar evidence, provider access and approvals can extend elapsed time. The six release ranges total **38–62 engineering days**, roughly **8–13 working weeks** if access and decisions are available. These are effort estimates, not promised delivery dates. Shared contracts can be designed early; critical trust repairs ship before new model or UI claims.

## Release sequence

| Release | Effort | Outcome and dependencies | Exit gate |
| --- | --- | --- | --- |
| R1 — Repair trust | 8–12 days | NFL scoring, roster coverage, quote/market validity, immutable history and freshness. First release. | F1–F6/F10 reproductions fixed; full NFL release gate green |
| R2 — Sleeper-first UI | 7–11 days | Adopt design by route; depends on R1 view-model truth | Feature parity, device/a11y checks and end-to-end league flow pass |
| R3 — Shared learning record | 7–12 days | Repair SelfLearning, import NFL read-only, establish score parity; hosted store follows development proof | F7–F9 fixed; replay, revisions, isolation and schema tests pass |
| R4 — Live data and paper research | 6–10 days | Wire verified live API and final resolver; archive actual quotes; depends on R1/R3 | Event lifecycle, corrections and paper settlement tests pass |
| R5 — Bounded learning proposals | 6–10 days | Evaluator and agents prepare proposals; depends on eligible R3/R4 evidence | Temporal/paired evaluation, promotion concurrency, rollback and budget tests pass |
| R6 — Second sports adapter | 4–7 days | Inspect WC2026 and implement its domain adapter after NFL parity | Cross-project isolation, deterministic replay and domain score parity pass |

An R5 UI and proposal engine can be built before sufficient evidence exists, but the model must remain at its eligible stage. The season calendar, independent event count and never-regress gate control promotion. Shipping code does not prove a self-learning improvement.

## Work items

Every item below is **planned**. “Owner” names the implementation responsibility, not an assigned person. Tests are acceptance obligations; only the separate prototype tests and contract fixture checks have run in this package.

### R1 — Repair trust

| ID / owner | Change and file seam | Acceptance criteria and required regression |
| --- | --- | --- |
| N01 / NFL data + frontend | Apply TE premium through `app/team-logic.js` component quantities and league rules. F1. | Five-catch TE +0.5 yields +2.5; WR unchanged; premium applied once across Team/Players/Compare/Grade; unsupported component remains partial. QA-N01 fixtures cover TE, WR, absent quantity and repeat normalization. |
| N02 / NFL data + frontend | Preserve all Sleeper roster identities; add shared coverage assessment and grade suppression. F2. | Raw roster count survives import; unresolved IDs remain visible; zero is never substituted; incomplete relevant roster/scoring suppresses affected grade/title odds. QA-N02 reproduces 127/140 matching and independently checks missing-player consequences. |
| N03 / NFL model + research UI | Remove synthetic quote fallback in parlay construction; require actual matching combined quote. F3. | Model probability never generates offered odds; missing/unverified/expired quotes yield null actionable EV; quote-time and exact leg match enforced; hypothetical calculator clearly separate. QA-N03 asserts model-only example cannot emit positive actionable EV and verifies known payouts. |
| N04 / NFL markets | Match event date, participants, market type and settlement scope in `scripts/build_markets.py`. F4. | Season-series cannot map to one game; ambiguous/rescheduled identities quarantine visibly; unresolved counts shown. QA-N04 includes two meetings of same teams, swapped order, season series and postponement. |
| N05 / NFL ledger | Union historical player records independently of current active pool in `scripts/build_estimate_ledger.py`. F5. | Locked rows survive removal, missing feed and reappearance byte-for-byte; newly issued records use current lock rules; duplicate conflicting record rejected. QA-N05 replays consecutive build inputs and compares retained history. |
| N06 / NFL UI + calibration | Render interval method and target/empirical coverage from metadata in `app/render.js`. F6. | Missing metadata never becomes “80% conformal”; nominal target and measured coverage are distinct; sample and horizon available. QA-N06 covers scenario, conformal, missing metadata and incompatible horizon. |
| N07 / NFL client + delivery | Replace permanent successful-promise caching with generation-aware refresh and stale fallback in `app/data.js`; inspect service-worker policy. F10. | Refresh/visibility return can obtain new generation; incomplete fetch retains old complete set; no mixed generations; old promises cannot overwrite new context. QA-N07 uses delayed/out-of-order responses, one failed asset and a long-lived tab. |
| N08 / NFL maintainer | Restore reproducible full gate and deploy identity; reconcile cron commits before release. | Run pinned supported Node/Python and install browser dependencies through CI; full existing regression suite plus changed-feature checks green at exact release SHA; build ID visible; approved deploy and rollback target recorded. QA-N08 includes PWA update/offline and actual Netlify smoke after approval. |

### R2 — Sleeper-first UI

| ID / owner | Change and dependency | Acceptance criteria and required regression |
| --- | --- | --- |
| U01 / frontend | Introduce tokens, five-destination navigation and old-route aliases. Needs N07. | Saved hashes and browser back still resolve; every existing feature has a destination; phone safe area and keyboard current-state indicators work. QA-U01 route/alias/history checks. |
| U02 / frontend + Sleeper adapter | My League onboarding, matchup, lineup and coverage; needs N01/N02. | Saved league and own roster restore; invalid league/network failure preserves context; points share scoring version; bye/injury/partial states visible; suggestions describe read-only Sleeper behavior. QA-U02 connects a fixture league, refreshes, changes week/rules and recovers offline. |
| U03 / frontend | Players, detail and Compare; retain draft and grade access. Needs U01/U02. | Search/filter preserve focus; two-player comparisons require compatible horizon/scoring; long names/empty results work; legacy draft functions remain available. QA-U03 covers keyboard and draft-season parity. |
| U04 / frontend + QA | Research and Learning states; device and accessibility pass. Needs N03/N04/N06. | No unavailable value appears as zero; preview language removed only when live adapters exist; 320–1440px/200% text and phone Safari pass; contrast, dialogs, focus and status announcements meet design criteria. QA-U04 checks all six screens and failure states. |

### R3 — Shared learning record

| ID / owner | Change and dependency | Acceptance criteria and required regression |
| --- | --- | --- |
| S01 / SelfLearning core | Partition scorer by immutable model and scoring version. F7. | Different models cannot pool into one unnamed result; paired evaluation uses same events/revisions; a 0-MAE and 10-MAE pair remain distinct. QA-S01 regression plus missing/cohort mismatch cases. |
| S02 / SelfLearning store | Append-only outcome revisions, foreign keys on every connection and idempotent immutable forecasts. F8. | Orphan rejected; original outcome retained after correction; same ID/different payload conflicts; earlier score points to original revision set. QA-S02 tests transaction rollback and file reopen as well as memory store. |
| S03 / SelfLearning package + CI | Restore missing power-backtest data package or repair its import/packaging contract. F9. | Clean checkout collects the existing power suite; core/shared/sports/power tests included in CI; generated data is distinguished from Python source ignore rules. QA-S03 clean-install collection and full relevant suites. |
| S04 / both repositories | Implement proposed versioned sports contracts and NFL read adapter. Needs N05/S01/S02. | Dry run reports eligible/late/reconstructed/unresolved/rejected rows; repeat import is a no-op; source hashes and original IDs retained; NFL-local and shared scores match on a frozen corpus. QA-S04 fixtures include historical proof and late import. |
| S05 / backend + database | Hosted record and authenticated read API after local parity. Needs S04. | Separate development schema, restricted writer, grants/RLS and ownership tests; backup/restore rehearsal; no browser service key; schema migration explicitly approved before production. QA-S05 two users/two projects, pagination, retry, permission and recovery tests. |

### R4 — Live data and paper research

| ID / owner | Change and dependency | Acceptance criteria and required regression |
| --- | --- | --- |
| L01 / live-api + NFL client | Inspect the actual Vercel project, then normalized event API and foreground poller. | Scheduled/live/final/delayed/corrected states round-trip; rate limits and stale age visible; hidden tab/route cancels polling; credentials absent from client. QA-L01 deterministic clock and provider failure fixtures plus live read smoke. |
| L02 / pipeline + SelfLearning | Authoritative final resolver with append-only corrections. Needs S02/S04/L01. | Live/intermediate result cannot score; final source and revision retained; corrections re-evaluate affected records without overwriting old evaluations; tie/push/void rules explicit. QA-L02 covers postponed game, stat correction and replay. |
| L03 / research + data | Archive supported combined sportsbook quotes and paper decisions. Needs N03/N04/S04. | Quote includes exact book/legs/lines/payout/time/expiry/policy; known joint event constraints enforced; no quote or ineligible model disables actionable EV; settled net returns reconcile to stored quote policy. QA-L03 includes nested events, impossible legs, voids, pushes and expiry. |

### R5 / R6 — Learning and reuse

| ID / owner | Change and dependency | Acceptance criteria and required regression |
| --- | --- | --- |
| A01 / evaluation | Versioned sports evaluator and evidence policy. Needs S01/S04/L02. | Temporal holdout and overlapping horizons controlled; model/scoring/cohort/horizon partitions explicit; independent clusters and missingness recorded; minimum count alone cannot pass. QA-A01 leakage, paired-event mismatch and low-cluster cases. |
| A02 / registry + API | Auditable proposal approval and rollback. Needs A01/S05. | Approval checks current incumbent and policy/artifact/evidence hashes atomically; concurrent stale request returns conflict; reader cannot approve; rollback retains history. QA-A02 concurrency, permissions and correction-invalidated proposal tests. |
| A03 / agent integration | Allowlisted experiment tools and budgets. Needs A01/A02. | Agent can submit deterministic evaluation and explain artifacts; cannot promote, execute bets, access secrets or change policy; failures exhaust bounded budget and preserve job audit. QA-A03 tool-schema, budget, retry and prohibited-action checks. |
| X01 / second-domain adapter | Audit WC2026 schema and implement soccer task/outcome adapter. Needs NFL score parity and stable contract. | Soccer draw/advancement/extra-time settlement explicit; source IDs preserved; fixtures replay to known domain scores; no cross-project/model pooling. QA-X01 three-way outcome and project-isolation tests. This repository has not yet been audited. |

## Finding-to-release traceability

| Review finding | Primary work item | Release |
| --- | --- | --- |
| F1 TE premium | N01 | R1 |
| F2 roster coverage/grades | N02 | R1 |
| F3 synthetic parlay EV | N03, L03 | R1 containment, R4 complete paper path |
| F4 market scope | N04 | R1 |
| F5 locked history loss | N05 | R1 |
| F6 interval label | N06 | R1 |
| F7 model pooling | S01 | R3, before shared use |
| F8 overwrite/orphans | S02 | R3, before shared use |
| F9 power collection | S03 | R3 |
| F10 stale cache | N07 | R1 |

## Regression and release policy

Maintain an acceptance matrix keyed by the QA IDs above. Before each release, at least 90% of its acceptance criteria must have meaningful automated or recorded manual assertions, and all critical scoring, quote, history, isolation and promotion criteria must be asserted. This is acceptance coverage, not a claim about line coverage. The full existing regression gate must also be green; the percentage does not permit known failures. Record the exact source SHA, runtime versions, commands, browser/device, result and artifact for every gate.

Use unit tests for deterministic math and identity; contract/replay tests for imports and outcomes; integration tests for DB/RLS/API; browser tests for complete manager journeys. The first release fixture pack should reproduce the ten review findings before applying fixes. Mock provider failures and time boundaries; use read-only production smoke checks after a reviewed deploy. No test should create real bets, mutate Sleeper lineups or run financial execution.

Migration controls: inventory current exports and consumers; add compatibility readers; shadow-read new adapter; compare frozen-corpus outputs; enable per-route read/UI flags; monitor generation freshness and error rates; retain prior deploy/data manifest/model version. A database migration requires development proof and the repository's explicit production approval. Confirm live-api ownership, provider entitlements/rate limits and Supabase project configuration during implementation rather than guessing them.

## First implementation slice

Start one reviewable NFL branch with N01, N02 and N05: scoring fidelity, honest coverage and history preservation. Add their failing fixtures, apply minimal engine changes, regenerate affected outputs and run the full gate. Then N03/N04 contain misleading research output before adopting the new UI. Keep unrelated refactors and model changes outside these repair slices so their effect can be measured.
