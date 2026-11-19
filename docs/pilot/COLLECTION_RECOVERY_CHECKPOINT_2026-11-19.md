# Disabled collection recovery: paired acceptance

November 19, 2026, 9:22 a.m. CST (America/Chicago). Codex owns this checkpoint.
All work remains local. No GitHub push, production deployment, hosted migration,
scheduled collection or learned correction activation occurred.

## Tested pair

| Component | Exact source |
| --- | --- |
| NFL combined candidate | `ee40a528e621d4f87a631ebc251b92bebfc0819c` |
| Shared engine | `0fc6b1871bc6f06117adb42d1b72ff07f6c1a51a` |
| Incorporated NFL main | `539059eea490e8bcb2a270e5c33839929e25d0bd` |
| Independently releasable NFL reliability source | `3f38893237180e7392a88dddedd32cd348691a01` |

The combined NFL gate finished at 9:21:14 a.m. CST with exit 0: all eight steps,
2,370 feature tests with no skips, and 364 browser tests with four existing
conditional skips. Both source worktrees were clean at completion. This document
is a documentation-only follow-up and does not change that tested source.

Additional paired acceptance passed 72 pin/history/config tests and seven actual
NFL producer-to-ASGI/SQLite recovery tests, with zero skips. The engine passed
504 hosted-boundary tests, 107 focused core tests and four native PostgreSQL 17.11
tests. These are local tests, not hosted Supabase or remote CI results.

## Recovery behavior

`scripts/run_collection_handoff.py` is an explicit standalone client. Its default
mode is a preview: no credentials, writes or HTTP. Write paths require the
disabled/shadow pilot configuration and explicit command flags. Production
daily/gameday workflows and the app do not call it.

The client registers a run-attempt intent before delivering the original frozen
source graph. Supabase retains the intent and publisher receipt alongside the
existing journal. A new runner can discover and recover by workflow, run and
attempt after its local workspace is gone. It never reconstructs missing original
bytes from today's pool or changes the first capture time.

Publication handoff checks the actual run-attempt publisher receipt and canonical
pool content at that exact Git commit. Mismatch, unchanged data and no-op states
remain explicit. A complete intake ACK is not publication proof. The independent
worker must still observe matching public bytes before kickoff.

Acceptance covers lost registration, recovery and publisher replies; deletion of
the local workspace; duplicate requests; immutable conflicts; bounded discovery;
unknown original objects; and late recovery that performs only reads. Completed
intakes remain discoverable until their subsequent publication work is resolved.

The new read-only `selflearning-collection-canary.yml` runs the paired local
ASGI/SQLite tests with exact engine source and locked hosted dependencies. The
existing stdlib Linux canary remains separate. Publish the engine source first so
remote NFL CI can fetch its pin. Neither workflow collects production forecasts.

## Remaining integration and activation work

1. Verify actual hosted migration history, object definitions and grants. Five
   additive migration files differ from the last observed deployed engine source;
   do not infer which are already installed. Management health is green, while
   migration and SQL inspection returned connector errors.
2. Run exact-source GitHub CI, then the separately authorized release and hosted
   durability checks. Verify the paired Vercel source and scoped configuration.
3. Wire the standalone clients into the successful publisher, then connect durable
   readiness to pinned publication-job registration and independent observation.
   Preserve the original job definition across retries and code upgrades. This
   handoff does not yet enqueue a publication job itself.
4. Schedule outcome capture/application and verify one real full cycle, correction
   revision, repeated refresh and restart. Missing original capture bytes or a
   missing publisher receipt remains a hold, not fabricated evidence.
5. Before recommendation changes, enforce base-model/calibrator lineage and
   evaluate the exact serving correction method on untouched cohorts. The current
   base-logit file-feedback backtest cannot qualify the different additive
   correction planner. Preserve exclusions, game/week dependence, position checks
   and fallback behavior.

Local authenticated tests also found a future-fit clock gap and a serving-lineage
gap in corrections mode `on`. Separate engine commit
`781ba6ae4c6c01afc47bd4d4bdc67e2fd5c7f575` fixes the future-fit check and passes
84 focused tests. It is deliberately not the pair above. Lineage enforcement and
prospective acceptance remain open. Keep corrections off during collection rollout.

The current local harness successfully executed a Codex review. It reports no
configured campaigns; its Grok provider lacks an API credential. These facts do
not establish Henry's state in the separate Grok Bot app. No Claude worker ran.

## Retained evidence

Under `/Users/jliddar/code/evidence/`:

- `nfl-learning-handoff-full-gate-20261119.log` and `.exit`
- `nfl-learning-handoff-focused-20261119.log`
- `nfl-learning-handoff-asgi-20261119.log`
- `selflearn-collection-handoff-verification-20261119.log`
- `selflearn-cloud-cutover-inventory-20261119.md`
- `nfl-exact-correction-evaluation-plan-20261119.md`
- `nfl-corrections-adoption-boundaries-20261119.md`
- `selflearn-corrections-lineage-plan-20261119.md`

The evidence retains earlier failed runs separately. No test failure was converted
to a skip and no generated data file was edited by hand in this integration.

## Publication enqueue follow-up

The standalone client now supports `--publication-status` and
`--enqueue-publication` for an existing workflow, run ID and run attempt.
Pass `--expected-intent` when recovering from discovery. The engine seals the
original job definition and recovers it across retries. The client checks the
attempt, publisher receipt, generation and job input identities, and matches
the attestation membership against the original intake acknowledgment. A
separate scoped worker observes the pool and records publication evidence.

The paired canary now pins engine `d40b9f08dcfe3633dedab31d983bf99bb9b610d8`.
Eight local ASGI/SQLite tests passed, including lost enqueue reply, restart
after workspace deletion, one worker observation of synthetic public bytes
and replay of the existing proof. Seventy-two focused pin and history checks
also passed. This checkpoint covers the path through publication. Outcome
application and scheduled collection still need combined acceptance.

## Native forecast-to-outcome rehearsal

A disposable loopback PostgreSQL 17 cluster applied all 13 migrations from
engine `d40b9f0`. NFL source `eca0c9d5` sent two original receipts, recorded the
exact Git publisher receipt, and queued the independent worker. The worker
observed the synthetic pool once. After kickoff the v2 sender applied raw
scoreboard, statistics, participation and roster fixtures to the same database.

The sender recovered the stored result after a lost batch reply. Replay
preserved the journal snapshot, and a later corrected capture appended two
superseding revisions. The original forecasts and publication proof stayed
byte-equivalent. The first two runs caught fixture timestamps ahead of the
database clock. The passing run waited for the manifest completion time and
kept all production clock checks in place.

The rehearsal used in-process ASGI, a local RPC bridge, synthetic provider bytes
and in-memory private Storage. It finished with exit 0 and removed the database
cluster. Local reproduction and output are in
`code/evidence/nfl-full-cycle-20261119.{sh,py,log}`. Scheduled workflow
collection, hosted Storage and prospective accuracy still require verification.

## Opt-in daily and gameday hooks

The daily and gameday workflows now contain bounded collection steps for the
main branch of `liddar12/NFL2026`. They require the repository variable
`NFL_SELFLEARN_COLLECTION_MODE=record` and a configured engine. The default
workflow skips these steps.

Before the Git publisher runs, the collection step freezes and uploads the
candidate forecast. After the publisher runs and Data CI retains its receipt,
the handoff step verifies that the exact published pool matches the stored
forecast. It enqueues eligible publication work. A separate step invokes
the independent observation worker. Scope each secret to the step that uses it:

- Forecast recording uses `SELFLEARN_NFL_COLLECTION_TOKEN` and
  `SELFLEARN_NFL_INGEST_TOKEN`.
- Publication handoff uses `SELFLEARN_NFL_COLLECTION_TOKEN`.
- Observation uses `SELFLEARN_NFL_PUBLICATION_WORKER_TOKEN`.

Recording and handoff each have a 45-second limit. Observation has a 35-second
limit. Learning failure reports an explicit held status or a nonblocking
Actions failure, while the existing baseline publication and Data CI receipt
keep their own result. A delayed deployment can leave a job pending. The
independent recovery path still needs scheduling and acceptance, along with
scheduled outcome capture and hosted persistence verification.

Both workflows parse as YAML. Fourteen focused checks and nine paired local
acceptance cases passed, including scope, ordering, secrets and transport failure.
The opt-in workflow is prepared locally and has not been exercised in GitHub CI.

## Recovery after the publisher runner exits

The opt-in `selflearning-publication-retry` workflow follows a completed
daily or gameday run on this repository's main branch. With read-only GitHub
permissions, it checks out trusted main code and retrieves the receipt artifact
named for the exact upstream run ID and attempt. It can use a receipt that was
retained before a later cancellation or failure. It treats a missing artifact
as unavailable evidence and can still invoke the independently scoped observer
for existing jobs.

Recovery validates the attempt receipt before any hosted write, joins it to
the original durable forecast, and checks the exact published Git pool hash.
It does not reconstruct a missing forecast or receipt. The paired rehearsal
deleted the forecasting workspace before recording the publisher handoff,
rejected a different attempt before contacting the engine, and recovered
the same publication job after a lost reply. Fourteen local isolation checks
and nine paired acceptance cases passed. GitHub event delivery and hosted
access still require acceptance during rollout.

## Daily outcome capture and registered recovery

The opt-in outcome workflow follows a successful daily refresh from this
repository's main branch. An operator can also dispatch it manually on main.
With `NFL_SELFLEARN_OUTCOME_MODE=record`, it selects regular-season weeks with a
published FINAL in the previous fourteen days. That selection only scopes
retrieval. Fresh raw scoreboard, statistics, snap and roster observations
supply the actual grading evidence. Preparation uses no secret. The delivery
step uses the outcome-specific token and private staging.

GitHub retains only the run locator, application ID and request digest.
To recover an application from a different runner, dispatch
`selflearning-outcomes` with the original `source_run_id` and
`source_run_attempt`. The client validates the registered request digest and
membership before sending an existing server-assigned step. If the run stopped
before registration, the pointer cannot reconstruct it. After registration,
recovery uses the original private staging and journal records, without raw
files or an outbox on the recovering runner.

The workflow parses as YAML. Thirty-two focused tests passed with the pinned
engine, including an active application that lost a step reply and resumed from
IDs alone. A local PostgreSQL 17 rehearsal verified the complete forecast,
publication and outcome cycle with the exact source `6dba43a6`. It deleted the
original raw files and outbox, recovered the stored grade from its pointer and
appended two corrected revisions, keeping the forecast and attestation intact.
The local RPC bridge and in-process ASGI used synthetic provider bytes and
in-memory private Storage. Hosted scheduling and persistence remain rollout
checks. Evidence is in `code/evidence/nfl-outcome-pointer-native-20261119.log`.

## Workflow regression follow-up

The first combined gate caught two workflow contract failures. A new cron
did not appear in the committed schedule inventory. The inline learning
handoff also followed the final Data CI receipt in gameday, which violated
the publisher's ordered graph.

The corrected outcome job follows a successful daily refresh from this
repository's main branch, or an explicit manual dispatch. Its cadence now
follows fresh daily data. Daily and gameday retain only the opt-in forecast
stage before the Git publisher. The separate recovery workflow owns the
publisher handoff and observation after completion, using the upstream
receipt. Data CI receipt retention is again the final publisher step.
No generated data or tests for the existing contracts had to change.

The affected checks and exporter acceptance passed 42 tests with the pinned
engine. The full local gate then passed on `47f86384` with 2,371 feature tests
and 364 browser tests passed, plus four browser skips. The preceding failed gate is retained in
`code/evidence/nfl-outcome-workflow-full-gate-20261119.log`.

## MY Parlays shared exposure

MY now shows how many of the cards on screen share its most common game or
selection. Where game, player and wager terms match, the expanded panel names
the selection whose loss would defeat multiple shown cards. It counts each
card once, keeps different rungs and directions distinct, and withholds joint
probability for mixed sets. Removing the seeds clears the panel and the saved
card selection. This display changes no rankings, prices or recorded grades.

The 13 portfolio feature tests and 12 MY/Week Chromium tests passed.
The mobile test checks the count, bounds and reset, and the existing desktop
and mobile layout checks still pass. The first local browser invocation used
a different port from the fixture's stored login. The corrected invocation
used the matching origin and ran all 12 tests.

The retained Week 11 snapshot provides a separate model-implied comparison.
The shipped moneyline set has eighteen out of eighteen cards exposed to a
single selection. The shadow cap reduces maximum single-selection exposure
to nine. Under the existing game-independence assumption, expected winners
change from 7.34 to 5.26 while modeled zero-winner risk goes from 11.95% to
9.23%. These are different objectives on a frozen forecast, and the
alternative needs prospective evaluation before any selection-policy decision.
See `code/evidence/nfl-week-portfolio-counterfactual-20261119.json`.

## Game Parlays shared selection

Published and browser-built Game cards show a warning when a verified
selection occurs in two or more displayed cards. The warning names the most
repeated selection and counts the affected cards. Published card filters and
the browser builder each use their own displayed set. Older published props
identify their team using the scheduled home or away side, with explicit team
conflicts refused. The warning estimates no joint probability.

Local source `9b58aeef` passed 14 portfolio feature tests and eight Chromium
tests. The browser checks cover published card filtering, the displayed
selection count on built cards, and clearing the warning when a filter
produces no built cards.
