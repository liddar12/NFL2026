# Workflow reliability and shared learning release roadmap

Revision 1. November 18, 2026, 1:59 p.m. CST (America/Chicago). Codex owns this work; no Claude or Cursor dependency.

## What the audit established

The latest 100 NFL2026 workflow runs examined had 48 successes, 47 failures and
five cancellations. Forty-four failures were repeated `data-ci` failures; the
cancellations were superseded runs. This was not a failure of every workflow.
The separate SelfLearning repository had 22 successful runs and no failures in
the October 18–November 18 sample.

The main failures were:

1. **Inconsistent grading.** Stored MY/ATD grades and browser facts disagreed on
   167 card-leg occurrences. Player identity, historical team and game binding
   differed between consumers. These are repeated occurrences, not 167 unique bets.
2. **Unstable test inputs.** Injury scenarios reused live players whose bye-week
   state changed. Separate owner-evidence tests used authorization fixtures that
   expired as the real clock advanced.
3. **Incorrect market-copy detection.** Independently calculated model and market
   probabilities rounded to the same value. Equality alone incorrectly failed the
   pipeline; independent probability recomputation remains required.
4. **Optional upstream label gaps.** Missing current-season referee labels exceeded
   a blanket threshold. Missing labels must stay unknown, with cohort coverage
   reported; they must not become invented inputs or block unrelated predictions.
5. **Publication before complete semantic checks.** The data pipeline published
   before the checks that found the disagreements. Repeated refreshes consequently
   repeated the same incident. Floating downstream refs are an additional design
   risk, not a demonstrated cause of the sampled failures.

Source: issue [#202](https://github.com/liddar12/NFL2026/issues/202),
[sampled data-ci run](https://github.com/liddar12/NFL2026/actions/runs/44284403767),
and the local read-only audit of main `5e32aef638b71234e8a8096e87e729761f7a2141`.
Hosted observations were made around noon CST, November 18; later local tests
are not new production observations.

## What “learning is on” currently means

The live pool uses historical NFL-owned calibration. The shared SelfLearning
feedback runtime is different: the pilot is disabled, daily/gameday do not deliver
its forecast/outcome graph, and the served pool has `live_adjustment: null` with
`held: no adopted correction`. The Vercel health response established an online
L0 foundation, not an operating feedback loop. Supabase management reported
healthy, but the attempted SQL inspection timed out; durable hosted behavior was
not verified and a timeout does not establish an outage.

Do not enable corrections simply to change a flag. A pre-repair candidate worsened
log loss in weeks 7 and 8, although weeks 9 and 10 improved. Those results require
reevaluation using trustworthy labels, not retrospective tuning to those outcomes.

## Local repairs and evidence

The independently releasable NFL grading candidate is `543ec0542ac04f645417be43b148308574b8b62d`.
All eight local gate steps passed: 2,290 feature tests, 364 browser/PWA/performance
tests, and four existing conditional browser skips. All 274,625 compared MY/ATD
card legs agreed; 150 retained verified FINAL score pairs remained unchanged on
repeat refresh. Remote CI and production rollout are separate acceptance steps.

The subsequent engine integration adds:

- Captured raw fixture/opponent and stable ESPN/GSIS/PFR identity binding. A
  wrong-game row cannot become a hit, zero loss or did-not-play void.
- An optional retained roster capture (`capture_outcome_evidence.py --include-roster`)
  used only as postgame identity evidence. Legacy captures remain readable; they
  do not gain event-bound training qualification.
- Missing yardage and malformed target identity stay unknown. Numeric zero still
  grades. The retained snapshot contained 2,637 eligible player rows with no
  unknown primary measurement, so this follow-up does not require a data rebuild.
- Roster observation/hash/receipt provenance through both durable capture paths,
  an additive database migration, and a corresponding CI regression step.
- A fitter qualification boundary: an unchanged old result does not acquire
  verified provenance merely because a later capture reports the same number.
  Exclusions stay in the audit and the frozen forecast denominator is preserved.
- Read-only validation of approved historical engine/runtime identities when
  the execution pin changes. Unknown historical fingerprints require independent
  review; an uploaded record cannot authorize an old or different engine.
- Deterministic test clocks while production authorization expiry stays enforced.

The raw provider does not independently attest completeness of every snap sheet.
Did-not-play remains the documented R106 inference from supplied coherent evidence,
not an official inactive announcement or complete sportsbook settlement support.
Explicit pushes and official voids remain outside this file-path integration.

Current producer/capture tests and older review/oracle tests use distinct NFL
checkouts. The older oracle modules are absent from main. Passing the legacy
diagnostic does not prove the current production pipeline calls it.

The engine candidate is `69d37eb0d171f7999b94f706748f4635f9c58606` and the
paired NFL implementation is `fa680c2e0d561fce9871895475d0625111734051`.
The engine core passed 1,281 tests and 838 subtests with both explicit checkouts
and no skips. Hosted boundary tests with the actual NFL producer passed 492;
40 disposable PostgreSQL-WASM tests passed. These do not verify hosted Supabase
or native PostgreSQL concurrency. The paired NFL focused canary passed 55/55.

The full NFL gate also passed on exactly `fa680c2e`: exit 0, all eight steps,
2,296 feature tests with no failures/skips, and 364 browser/PWA/performance tests
with four existing conditional skips. Local environment: Python 3.11.16,
Chrome 148.0.7778.96 and two Playwright workers. The Linux bounded CLI and native
PostgreSQL CI jobs still require their own exact-commit remote execution.

Retained evidence under the operator's `code/evidence/` directory:

- `nfl-engine-identity-full-gate-20261118.log`
- `selflearn-event-core-both-checkouts-20261118.log`
- `selflearn-event-hosted-crossrepo-20261118.log`
- `nfl-engine-pin-focused-final-20261118.tap`
- `nfl-feedback-upgrade-rehearsal-20261118.py`, `.json`, `.log`
- `nfl-engine-roster-coverage-20261118.json`

The current pool's 175 unique players all map to retained roster identities for
stats and participation. That coverage check is not an availability or full
outcome-authority proof. Exact local source branches are
`build/nfl-engine-identity-contract-20261118` and
`build/nfl-event-bound-labels-20261118`. Publish the engine commit before the NFL
integration branch; otherwise its cross-repository canary cannot fetch its pin.

An actual runner rehearsal upgraded `aacb19c7` to `69d37eb0` in separate Python
processes: equal measurements retained old revisions, a correction appended
two verified revisions, duplicate captures preserved the state/run/evaluation
pointers, and every activation flag stayed false. This used synthetic inputs
and real runner APIs, not a live forecast.

**Remaining adoption blocker:** `nfl_file_feedback.evaluate()` still uses the
legacy-admitting walk-forward report for retrospective metrics and its proposed
shadow numeric gate. That report lacks a stable/legacy provenance breakdown.
It is non-authorizing and automatic promotion stays off, but it must not be
treated as proof of qualified improvement. Unify its qualification/coverage
rules with the trusted corrections fitter before using it for a serving decision.

## Ordered roadmap and ownership

| Stage | Work and acceptance | Owner / manual involvement |
|---|---|---|
| 1. Reliable NFL release | Publish the tested grading repair branch, run remote CI on the exact source/data SHA, drain older refresh jobs, merge only the reviewed artifact, verify production bytes and three representative refreshes. | Codex prepares and verifies; owner release authorization remains outstanding. |
| 2. Dependable publishing | Pin downstream checks to the published SHA; capture FINAL evidence with the same inputs; enforce grading coverage as well as agreement; deduplicate repeated incident signatures. | Automated implementation and tests; no manual data edits. |
| 3. Durable shared collection | Publish the engine commit before the NFL canary references it. Verify/apply the additive migration, reconcile Vercel alias and exact engine pin, wire pre-kickoff receipts and publication proof, raw outcomes and bounded scheduled workers. Replay and restart must preserve IDs; a correction must append a revision. | Codex; owner authorizes cloud release/migration. Account access is the only other manual dependency if existing connections cannot perform it. |
| 4. Safe serving | Unify shadow-report and trusted-fitter label qualification, showing legacy/unresolved exclusions. Reevaluate on untouched future/held-out periods, with clustered uncertainty, per-position calibration, coverage and parlay concentration. Approve one bounded correction, prove the served pool cites its artifact, and exercise automatic fallback to the base model. | Codex automates evidence and fallback; owner approves the serving policy. Future games, not more agents, supply prospective evidence. |
| 5. Operations | Show last forecast/publication/outcome/worker timestamps, pending and rejected counts, correction artifact and whether it reached recommendations. Verify Henry's monitoring connection. | Codex and Henry after connection verification; no Claude dependency. |

Collection, evaluation, adoption and use are separate states. The final proof is
a genuine pre-kickoff forecast with durable publication evidence, an outcome and
correction history, a passing evaluation, and an observable changed recommendation
under the approved artifact. None of these tests guarantees a winning parlay.

No remote push, merge, deployment, hosted migration or learning activation was
performed by this local repair work.
