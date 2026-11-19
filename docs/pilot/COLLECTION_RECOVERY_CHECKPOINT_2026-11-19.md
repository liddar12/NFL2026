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

## Historical Week portfolio comparison

Run `python3 scripts/evaluate_week_portfolio.py --replay 1 11`. For each
week, replay takes the latest complete retained game forecast both generated
and captured before the slate's first kickoff. Both fixed selection rules
receive those same probabilities and only owner exclusions known at the
generation time. The control uses the current highest-probability builder
with no market prices. The report records the snapshot digest, card membership,
verified reviews and score coverage. A tie or missing result leaves the
affected cards unresolved.

Weeks 1–10 produced 43/180 full hits for the control and 33/180 for the cap.
The cap limited the most cards one selection could defeat to 9 of 18 in
each week. The control exposed 17 or 18 cards to one loss. Week 5 went from
1/18 to 2/18 full hits, and Week 6 went from 2/18 to 1/18. The cap produced
one week with zero full hits, and the control produced none. Week 11 was
not yet graded in the retained review.

This is a retrospective comparison of reconstructed Week moneyline cards.
The published record, same-game parlays, player props, payouts and engine
corrections are outside this comparison. The observed tradeoff supports
leaving the cap in shadow when the priority is maximizing full hits. The
15 focused feature tests passed, including the cutoff, tie and missing
snapshot cases. Output is in
`code/evidence/nfl-week-portfolio-historical-replay-20261119.json`.

## T-90 coverage across prop markets

The shadow assessment now covers yardage and Anytime TD rows in the same
pool. It withholds ambiguous team identities for that game and binds the
assessment to the exact pool bytes represented by its canonical digest.
Applying a stale assessment to a refreshed pool is refused.

On the retained Week 11 pool, Indianapolis at Houston had 72 yardage rungs
and 14 Anytime TD rungs eligible one second before T-90. At 5:45 p.m. CST
on November 19, all 86 would be withheld without confirmation, leaving
1,125 prop rungs in other games. This is a shadow counterfactual from the
retained pool. No serving flag or source registration changed.

On November 19 the NFL's public inactives page showed a placeholder. The
documented BALLDONTLIE designations endpoint distinguishes active status
from participation and exposes a record update time, but the documentation
does not establish a complete official list with its posting timestamp.
Provider qualification still requires a pregame capture of complete,
game-bound records and reviewed player ID mappings.

- [NFL Inactives](https://www.nfl.com/inactives/)
- [BALLDONTLIE Player Designations](https://nfl.balldontlie.io/#get-player-designations)

## Independently observed Week 11 forecast

At 10:44 a.m. CST on November 19 the ordinary public app served a leg pool,
schedule and parlay calibration file that matched the bytes at NFL main
`539059ee`. The producer captured the inputs using its real clock, and
the engine finalized 994 forecasts without rejections. A second anonymous
HTTP retrieval matched the stored pool. The local journal committed the
publication attestation before all 13 events kicked off.

Reopening the SQLite journal read-only verified 525 receiving, 331 rushing
and 138 passing forecasts in the eligible publication cohort. This marks
one observation of the baseline's publicly retrievable yardage legs.
There are zero outcome revisions, and the capture does not identify which
cards a viewer saw or any shadow probabilities. It used no hosted writes.

Evidence and the path to the retained local journal are in
`code/evidence/nfl-local-live-observation-20261119.json`. Retain that journal
and the original source files so later official outcomes can be matched
to the same receipt IDs.

## Browser expiry for injury evidence

The leg-pool producer now copies the expiry of the injury evidence that the
weekly model actually used. The browser rejects new yardage and Anytime TD
legs from a pool whose evidence expired or was unverified when generated.
Moneylines remain available to the applicable builder. Existing archived
cards and grades keep their original terms. Older pools without this metadata
retain their prior behavior.

MY and the Week/Game bet-type views show an explicit hold and reevaluate an
open page at expiry. The retained Week 11 inputs produce an injury expiry
of 4:15:59 p.m. CST on November 19, using the source's actual timestamp and
the existing 12-hour policy. Clock-controlled browser checks crossed expiry
on both Game and MY. This expiry is distinct from the still-shadow-only
T-90 official inactive confirmation.

## Published Game and Week card lineage

New published Game and Week cards carry the generation clock, a selection
policy fingerprint, and a joint-model fingerprint. Game pricing includes
the effective same-side and opposing-side correlation table and its default
in the fingerprint. Week moneylines retain their independence rule. The
metadata follows the card into the archive and its review row. Its presence
identifies the generation and supplies no independent publication timestamp.

The gate rejects a partially stamped live generation or mismatched scope
metadata. Existing archived cards keep their original fields, including
unknown lineage on older cards. A focused test rebuilt both scopes, changed
one correlation coefficient, and verified that the frozen card retained
its original stamp after archive and grading. The cards' original legs,
prices and ranking were unchanged in the control.

## Verified public card observation

The local observer retrieves the public slate and schedule, requires exact
matches to the supplied Git commit, and preserves the original bytes and
HTTP observation clock. A card qualifies only when each leg maps to a
scheduled event whose kickoff follows the completed observation. An
identical retry preserves the snapshot's first retained local observation.

```sh
python3 scripts/observe_parlay_offers.py --origin "$NFL_ORIGIN" \
  --published-commit "$NFL_PUBLISHED_COMMIT" --out-dir "$NFL_EVIDENCE"
```

The November 19 capture on main `539059ee` retained 39 Game cards and
18 Week cards before kickoff. None of those public cards had the new
producer lineage stamp, which exists only on the local branch. The
capture establishes retrieval of the published JSON files. Browser-built
cards and actual views by a specific person are outside this evidence.
See `code/evidence/nfl-public-card-observation-final-20261119.json`.

### Grade the retained observation

Use a later verified outcome capture for the same season and week. The
grader recomputes the public observation's membership from the retained
bytes and uses each card's original line, fixture and stable player ID.
A changed fixture remains pending. Full hits, losses, reduced cards,
fully void cards and pending cards have separate counts.

```sh
python3 scripts/grade_observed_parlays.py --observation "$NFL_OBSERVATION" \
  --outcomes "$NFL_OUTCOME_CAPTURE" --report-dir "$NFL_GRADE_REPORTS"
```

The optional report directory is outside the repository. Reports are
content-addressed, so retries retain the same result and new evidence
can produce a distinct report. The Week 11 pregame check produced 39
Game and 18 Week pending cards, with no verified finals. This command
does not publish grades, compute payouts or change recommendations.

## Retaining published parlay cards after refreshes

The local `public-parlay-observation` workflow starts after a successful daily
or gameday publisher run when `NFL_PUBLIC_PARLAY_OBSERVATION_MODE=record`.
It requires the receipt for that exact run and attempt. The observer checks
that the receipt's commit is in the checked-out main history. It retains a
manifest only after the public slate and schedule both match the Git bytes.
A no-op publisher produces a status file. A deployment that never matches
within the retry window fails the recorder and leaves no successful manifest.
The recorder has read-only repository access and uses no SelfLearning tokens.

The Actions artifact carries the upstream and observer run identities and is
requested to expire after 90 days. Download the manifest and its adjacent
`.bin` files before that expiry to keep the evidence for a later replay. Pass
each retained manifest as a separate `--observation` to
`scripts/grade_observed_parlays.py --first-observed`, together with a verified
outcome capture. The replay keeps the earliest verified offer per contract,
including forecasts with missing probabilities or unresolved grades. GitHub
execution and artifact availability still need verification after release.
