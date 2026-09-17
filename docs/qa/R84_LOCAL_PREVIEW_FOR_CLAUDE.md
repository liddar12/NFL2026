# R84 local preview — simulated pricing and safety

**Acceptance reopened, 2026-09-17:** the owner reported small MY returns and
overflowing GAME/WEEK payout labels. Both are reproduced in the
[R84 incident RCA](RCA_R84_PARLAY_PAYOUT_AND_OVERFLOW.md). The gate results below
remain factual, but the earlier “no horizontal overflow” observation was only
page-level evidence and did not establish card containment. Do not treat this
document as completed visual or pricing-product acceptance.

Status: local working-tree implementation on `codex/r83-parlay-correctness`.
No push, production deployment, database migration or historical data rewrite.
Builds on R83 (`9ece452`, `d2ffa48`). This is another tested increment, **not
completion of the entire R82 critical backlog**.

## Owner decision

Keep explicitly simulated EV/net profit, using one consistent assumption. The
application has no exact sportsbook quote for these combinations. Simulation
can differ substantially from a sportsbook; it must not be called realized
betting profit or calibrated confidence.

For displayed leg comparison probabilities `q_i`, the simulation assumes decimal
odds `D = product(1/q_i)`, including same-game cards. For a $100 stake:

- Potential net profit: `100 * (D - 1)`; stake excluded.
- Simulated EV: `P_model * D - 1`; prices never enter `P_model`.
- Graded simulation: drop void legs, use remaining hit-leg decimals; a losing
  card loses $100. Pending cards remain explicitly hypothetical.
- Missing/invalid comparison prices: unavailable, not an invented −110 or zero.
- Example: 0.50 and 0.25 imply decimal 8, gross $800, **net $700**.

## Implemented

- GAME/WEEK/MY display SIM EV and SIM NET with the independence-pricing caveat.
  Tiers are labeled SIM and explained as an edge heuristic, not calibrated
  confidence. Original model probabilities are not repriced from market data.
- Shared display simulator; review money is normalized **in memory** against
  the actual current/archive cards. Card values, dollar sorting and aggregate
  totals use those same normalized rows. Legacy stored −110/vig totals are not
  the preview's money source. No stored review receipts were changed.
- Review decorations require the full matching set of market/selection keys;
  reordered legs match by identity rather than position. A reused rank ID with
  different legs cannot acquire another combination's marks or money. A total
  with unavailable constituent money is unavailable, not a partial sum.
  After async loading, the selected week and painted leg identities are checked
  again so a late response cannot decorate a newly painted week's cards.
- Producers preserve explicit assumed/fair-market price provenance; legacy
  numeric probabilities are not automatically labeled executable book prices.
- Containment for the order-dependent joint estimator: refuse more than two
  legs from one event in both Python and JS; MY search respects the limit.
  Mixed cards can still contain multiple two-leg event groups. No new
  multivariate probability model has been fitted or claimed validated.
- MY filters events using the full schedule: only scheduled, known future
  kickoff times qualify. Cards are checked again at kickoff while open;
  unknown schedule/identity is fail-closed. Questionable-player policy unchanged.
- New game locks enforce aware `as_of <= locked < kickoff`, scheduled status,
  and append missing future events without replacing existing rows. The resolver
  requires FINAL status plus valid cutoff evidence before a new grade.
- JSON promise cache has a one-minute TTL and eight-second request deadline;
  failures remain retryable. Resume/online refresh replaces stale in-memory
  data. Offline resume retains the painted view and indicates it is unrefreshed.
- Navigation owns a new view node per route, so a stalled old mount cannot
  block or overwrite the new route. Slate paints without awaiting optional
  market-price data; those comparisons arrive progressively.
- Moneyline names no longer render the duplicated `ML ML` suffix.

## Verification

**Final clean full gate: PASS, exit code 0.** Data validation, smoke tests,
**1,698 feature tests**, all **four model gates**, and **285 browser/PWA/performance
tests** passed together after the final changes. `git diff --check` also passed.
This Mac ran Python 3.12.9 / Node 26.7.0 with installed Chromium 1223 selected
through `PW_CHROMIUM`; CI's Python 3.11 / Node 22 environment was not run here.
Command: `bash tests/run_gate.sh` with the local Python PATH and Chromium override.

New feature regressions cover simulation arithmetic, invalid prices, matching
and reordered receipts, incomplete aggregates, unsupported same-event triples,
cache expiry/timeouts/retry, future-event eligibility, lock append/idempotence,
timezone awareness, exact kickoff boundaries, and FINAL-only resolution.

New browser regressions exercise navigation away from a stalled required feed,
reused-ID/different-leg receipt rejection, and kickoff expiry without navigation.
Existing tests were updated where they explicitly required the incorrect price
labels, −110 preview totals, or unsupported three-leg estimator. The randomized
Python/JS parity suite now requires both implementations to reject unsupported
triples, while retaining numerical parity for supported combinations.

The browser-verification skills drove the local flow: Parlay → MY → Jared Goff
→ ten cards. Local JSON requests returned HTTP 200; no browser runtime errors
were detected; desktop and 402×874 Chromium mobile emulation had no horizontal
overflow. Not an actual iOS Safari test. The existing DATA DEGRADED indicator
remains visible; local code changes do not refresh upstream feeds.

Local evidence:

- `/private/tmp/nfl2026-r84-feature.log`
- `/private/tmp/nfl2026-r84-browser-targeted.log` (initial targeted run: one stale
  glossary-text expectation failed; the remaining 21 passed)
- `/private/tmp/nfl2026-r84-test-import-failure.log` (final runtime regression run; the feature
  step caught the new suffix test importing a private helper. The test was
  corrected to exercise `renderParlayCard`, without changing runtime exports.
  All 285 browser/PWA/performance tests and all four model gates passed in that
  run; its overall exit was correctly 1 because of the test import failure.)
- `/private/tmp/nfl2026-r84-gate.log` (clean all-in-one rerun after the test fix;
  **exit 0, all eight stages passed**)
- `/private/tmp/nfl2026-r84-final-feature.log` (complete feature-suite rerun
  after that test correction: **exit 0, 1,698 passed, zero failed/skipped**)
- `/private/tmp/nfl2026-r84-first-green.log` (first complete gate: exit 0,
  1,697 feature tests, four model gates, 285 browser/PWA/performance tests;
  final receipt-race and suffix changes were made afterward and rerun)
- `/private/tmp/nfl2026-r84-my.png`
- `/private/tmp/nfl2026-r84-parlays-mobile.png`

## Still open — do not describe this preview as release-complete

- F03: containment is not validation of all pairwise dependence or a 3+ leg model.
- F04–F06: the preview adapter implements the owner decision; the Python review
  builder and persisted legacy money contract still need the coordinated pricing
  migration. Exact-combination sportsbook quoting remains unavailable.
- F07/F14: no coherent-generation manifest or enforced maximum pool age yet.
  Request TTL is not proof that upstream data is current. MY cutoff comes from
  schedule identity/status; published historical cards remain reviewable.
- F08–F11: old invalid locks are preserved, not relabeled/repaired. Downstream
  review/refit consumers still need uniform cutoff auditing, chronological
  held-out evaluation, complete production-equivalent input replay and complete
  parameter preservation. No refit/promotional policy or effective coefficient
  was changed in this increment.
- F12–F13: matching guards do not create immutable content-versioned card
  receipts. Open-week archive rewrites and historical Slate forecast provenance
  still require work; do not claim old historical performance is repaired.
- F14–F15: no full offline cache or coherent cross-file refresh transaction;
  optional Players dependencies still need progressive rendering. Resume refresh
  remounts the page and can reset transient filters. Background requests are
  bounded, but not all are canceled on navigation.
- F16–F17: shared publication/retry/concurrency and daily/gameday pipeline
  convergence remain separate, unimplemented work. No workflows were changed.
- Broader mobile density/accessibility and Players UX review findings remain.

Before a live release: finish the required critical scope, reconcile current
main without overwriting cron data, rerun the full gate on the exact candidate,
then obtain/confirm deployment authorization. This preview is not that approval.

Preview: `http://127.0.0.1:4321/#/parlays` (MY is a scope within that page).
