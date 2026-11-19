# Workflow reliability and shared learning release roadmap

Revision 6. November 19, 2026, 9:03 a.m. CST (America/Chicago). Codex owns this work.

## Morning verification — November 19

Main is now `539059eea490e8bcb2a270e5c33839929e25d0bd`: two more commits
changed 49 data files and no source since `640df164`. Latest
[Data CI run 44504506061](https://github.com/liddar12/NFL2026/actions/runs/44504506061)
still fails referee completeness, 124 MY leg occurrences, and the same two IR
browser tests. The OL-count test now passes on refreshed provider data; the local
partial-coverage fix still has not shipped. The live 4:17:02 a.m. CST pool retains
`live_adjustment: null`, `held: no adopted correction`; main's pilot is disabled.

Reconciliation source `3f38893237180e7392a88dddedd32cd348691a01` includes the
worker bound, OL fix and captured review validation, then merges main through
`539059ee`. Its full gate passed all eight steps at 9:01 a.m. CST. All 2,337
feature tests passed, and browser E2E passed 364 tests with four existing
data-dependent skips. That exact grading release is now merged into the disabled
collection branch. Integrated and production acceptance remain open.

The offline semantic audit passed: all 302 receipt/ledger files (37 offer books)
and 150 FINAL score pairs remain intact; 274,625 leg comparisons have zero
mismatches. Corrections relative to published main are explicit: nine MY and four
ATD formerly void cards become pending because their player/game identity cannot
be verified. Another 57 MY and eight ATD cards have corrected outcome fields.
Original terms remain unchanged; all settled and pending reductions match the
immutable offered legs. These are grading corrections, not a model-accuracy gain.

No new source was pushed, deployed or activated. See the readable local report
`/Users/jliddar/code/reports/github-learning-rca-20261118/report.html` and evidence
`nfl-release-reconcile-grading-transitions-20261118.json`.

## Latest incident update — November 18, 4:45 p.m. CST

The two owner-supplied Data CI runs,
[44374429027](https://github.com/liddar12/NFL2026/actions/runs/44374429027)
and [44408445217](https://github.com/liddar12/NFL2026/actions/runs/44408445217),
repeat the same five failed tests: referee completeness (86 absent labels),
MY grading parity (124 repeated card-leg occurrences), OL starter count
(159 rather than 160), and the two IR availability browser fixtures.
Both browser runs passed 346, failed two, skipped four and left 16 not run.
The reporting job posts its comment successfully and intentionally exits 1.
It is not an independent infrastructure failure.

Main advanced from `ff98e60f` to `640df1640d139d6cb1f7d95f0eeea38843d65d63`
with one commit changing 50 data files and no source files. Upstream daily run
44407503845 succeeded, including contract validation and publication. Thus
refresh success and post-publication semantic failure can coexist. No new local
repair reached production in either run.

The new OL failure is reproduced from the exact source snapshot. Pittsburgh lists
Brock Hoffman (GSIS `00-0037336`, ESPN `4241087`) as both starting LG and RG.
Deduplicating correctly yields four unique players. Local fix `9f966ce6` retains
that fact, reports one unknown starter, preserves known injury warnings and never
promotes a backup to fill the gap. All 41 focused checks passed; production inputs
reproduce the previous document except the explicit coverage field and build clock.
The rule now reconciles counts and names rather than assuming the provider always
supplies exactly 160 distinct starters. This annotation changes no prediction.

The initial expanded full gate is no longer running. It ended with four subprocess
failures and an unfinished r88 test, with no complete acceptance result. Worker
bound `1c6c8b7a` passed nine focused tests without changing any timeout or assertion.
The isolated grading release `build/release-reconcile-20261118` subsequently
passed its full gate after reconciliation with `539059ee` and replay of frozen
captured inputs. It remains local.

At 4:37 p.m. CST the public pool was Week 11, generated 4:05:10 p.m. CST, with
historical `calibration_adopted: true` but `live_adjustment: null` and
`held: no adopted correction`. Main's shared pilot stays disabled/shadow at
`aacb19c7`. The online foundation and historical NFL calibration are distinct from
an operational shared feedback loop.

The separate disabled collection checkpoint `96ad2a6a` integrates exact pinned
engine `5e689539`, frozen forecast delivery, publisher-receipt-bound registration,
and roster-aware outcome clients. Pin/history guards passed 71 tests; outcome
clients passed 31 paired tests; engine delivery/application/labels passed 64;
publication queue and local ASGI integration passed 18 and 10 respectively.
Local intake accepted 1,008 actual-pool receipts and replay required zero transport
calls. This is local adapter evidence, not hosted persistence or public observation.
See [the collection checkpoint](../pilot/COLLECTION_DELIVERY_CHECKPOINT_2026-11-18.md).

Release order: verified NFL grading/publication repair; paired engine and durable
collection; complete prospective forecast/publication/outcome/evaluation cycle;
then measured correction adoption. Preserve model evaluation exclusions and
original pre-kickoff clocks. Assess joint-card calibration and correlated losses
separately from individual yardage-probability improvements. Only a tested,
explicitly approved correction may change served probabilities. No new betting
accuracy gain is demonstrated yet.

Owner involvement remains concrete release/cloud-change approval, administrative
access repair if the Supabase connector still cannot verify migration state,
verification of Henry's service connections, and the first scoped adoption decision.
There is no routine manual outcome grading step. Do not replace missing official
inactive evidence with ESPN's observation-only didNotPlay list.

## Earlier checkpoint (retained evidence)

### NFL release-candidate reconciliation

The tested grading release reconciled the coverage branch with main at
`539059ee`. It carries forward 42 additional Week 11 MY offers and two
additional ATD game offers. The main line report uses the November 19 nflverse
snapshot and identifies all five Pittsburgh starters. Historical grading
was replayed from the November 18 ESPN capture at 2:21 p.m. CST. The replay
checks that frozen evidence against the November 19 publication baseline.

The first local candidate reconciled the coverage branch with main at `640df164`.
The six generated-file conflicts started from main's copies. The grading
and replay CLIs rebuilt their outputs from the retained v2 capture with network
access blocked. The line-report CLI used the retained November 18 nflverse
snapshot and main's injury file. Pittsburgh's offensive line shows four
identified starters and one unknown because the source lists Brock Hoffman at
both starting guard slots.

The replay preserved 302 receipt, snapshot, archive and ledger files from main
byte for byte, including all 37 offer files and 13 pending Week 11 game locks.
The 150 captured ESPN finals match the prior and rebuilt facts and review.
The prior-publication validator passed with 30,208 MY and 22,663 ATD gradeable
cards, 274,625 leg comparisons and zero mismatches. Ten previously settled
Week 10 terms now return `player_game_mismatch`; nine MY cards and four ATD
cards that previously showed void are pending. Their offers remain intact.
Other retained cards also reflect event-bound stat and participation corrections.
The retained audit logs are under `code/evidence/nfl-release-reconcile-*`.

The `640df164` candidate passed the smoke tests, all four calibration checks,
and 364 browser tests. The data-contract and four feature failures shared one
cause. The captured review reported unknown refit receipt membership, while
the validator still expected matched counts to prove membership. The current
candidate validates that review against captures and lock snapshots while
preserving the unknown membership. Its full gate passed on `3f388932`.

The new NFL source is `479ac73bcc14dbe5db0cc52f8de1f11cd903f68f` on
`build/grading-coverage-20261118`. This checkpoint adds offer-derived grading
coverage, prior-publication receipt retention and Data CI incident deduplication.
The new engine source is `5e68953989b95731503d9e909ede7d4279b2a570` on
`build/nfl-qualified-jobs-20261118`. Both remain local and unpushed.

The engine passed 1,306 core tests plus 838 subtests, 492 hosted-boundary tests
with no skips, and six local PostgreSQL-WASM adapter tests. New durable job
policies explicitly qualify labels in inline and subprocess execution. A real
old-code/new-code rehearsal preserved completed legacy job results and refused
to resume an unfinished old job under different source. These checks do not prove
hosted Supabase operation or an independently assembled publication cohort.

The NFL coverage replay passed on a detached copy of that exact source, using
retained raw evidence with network access blocked: 30,208 MY and 22,663 ATD
card rows unchanged, 274,625 leg comparisons without mismatch, 150 verified FINAL
scores retained, and all 37 receipt files unchanged. Missing grades, erased
receipts, changed original terms, policy downgrade and coordinated disappearance
of verified FINAL evidence are refused. Recognized player-stat withholding can
still correct an earlier grade; it is reported, not forced back into a result.
Focused suites passed: coverage 26, publication 34, incident reporting 20.

**The new NFL full gate is not green yet.** Data contracts and smoke checks
passed, but the full feature run has reported four Git-fixture failures so far.
They passed in focused runs. The full runner uses nine parallel feature files on
this Mac; exact failure stacks and a bounded-worker rerun remain to be assessed.
This is a new local acceptance issue, not proof that parallelism caused the
original GitHub grading failures. Do not deploy this candidate on the strength
of its focused checks alone. See the live local gate log in
`/Users/jliddar/code/evidence/nfl-grading-coverage-full-gate-20261118.log`.

The NFL file-feedback pin remains `889e147e`, an ancestor of the new engine
checkpoint. Publish reachable engine source before a remote NFL canary can fetch
that pin; choose and verify any later combined pin deliberately.

## Previous full-gate checkpoint

NFL source `64060b9ed877ffafd351621e8731e529ee473190` passed the full local
gate: exit 0, all eight steps, 2,307 feature tests with no failures or skips,
and 364 browser/PWA/performance tests with four existing conditional skips.
It pins engine `889e147e84b01c28898f268eb89f91c978ef490f`, whose core suite
passed 1,295 tests plus 838 subtests with both NFL checkouts and no skips.
The hosted boundary suite passed 492 tests. Those are local checks, not
GitHub CI, native PostgreSQL or hosted Supabase acceptance.

The implementation branches are `build/published-evidence-20261118` (NFL)
and `build/nfl-qualified-shadow-20261118` (engine). Both remain local. The
earlier checkpoints below retain their evidence; these commits supersede them
for the combined review. This document is a documentation-only follow-up to
the tested NFL source.

At **2:25 p.m. CST**, a fresh production HTTP read still showed Week 11,
`calibration_adopted: true`, `live_adjustment: null` and
`held: no adopted correction`. The pool was generated at 12:50:29 p.m. CST.
GitHub main `ff98e60f62f8a06632dcf65b53bc3cbfde8d91a7` still has the
disabled/shadow pilot pinned to `aacb19c7`. It is one data-only commit
(49 files) beyond the original audit base; no source changed. Preserve its
new ledger/snapshot entries and regenerate data when reconciling the release.
The tested local tree is not a claim to have merged that later data refresh.

The live historical NFL calibration and the shared feedback runtime are
different. The shared engine is **not currently changing recommendations**.
No activation or new prospective accuracy claim follows from the local tests.

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

## Follow-up repairs verified locally

### Published commit and one grading generation

All three publishers now emit a receipt containing the workflow run, attempt
and final pushed commit (or an explicit no-op). Data CI resolves that receipt
and both validation jobs test its immutable SHA. Wrong run/attempt metadata,
missing receipts and commits outside main are refused. A historical result
cannot close a newer main incident, and no-op publication leaves it unchanged.
The report queue uses GitHub's `queue: max` support; the installed Actionlint
1.7.12 predates that key, so only its exact stale-schema diagnostic was excluded.
The remaining workflow lint checks and 42 focused publication tests passed.
Remote Actions behavior still needs verification after publishing.

The production grading capture now freezes the schedule identity, raw ESPN
scoreboards, player statistics, participation and roster evidence together.
Daily/gameday capture before their first game-lock resolution; weekly backtest
does so before its current-season lock stage. Historical backtest inputs are
unchanged. Configured consumers cannot substitute a live fetch, manual CSV or
old results from another capture. Unchanged verified historical FINALs can
survive omitted upstream events, but explicit contrary identity/status evidence
blocks that fallback. Contradictory nested competition IDs, kickoff times and
FINAL lifecycle states are quarantined by both NFL and the engine.

Current-run lock/refit admission checks the captured fixture and winner without
rewriting old locks or changing the fitting equations. A stored refit count is
no longer presented as proof of identical receipt membership. Weekly fantasy
estimate grading requires complete FINAL coverage. This is distinct from the
per-game gating used for parlay legs. Legacy CSV-only manual capture remains
available; production explicitly selects the stronger scoreboard profile.

A fresh read-only source capture at 2:21 p.m. CST returned HTTP 200 for all
13 source requests. It covered all 150 FINAL games in Weeks 1–10 with zero
unknown games, zero conflicting games and zero historical fallback. The
capture is outside the repositories; no generated production data was edited.
The frozen schedule's own timestamp remains visible rather than being restamped
as a freshly fetched schedule.

Two isolated replays of all seven grading CLIs and the production browser-grade
validator passed with network access refused. Each compared 130,697 MY legs and
143,928 ATD legs with zero mismatches. All 30,208 graded MY cards and 22,663
graded ATD cards retained their original outcomes and leg measurements; none
was added or removed. Review and bet facts each matched all 150 captured scores.
All derived documents repeated semantically, excluding four documented clock
fields whose per-pass values were independently checked. Lock files and the
raw capture manifest remained byte-identical. This rehearsal performed no
prediction rebuild or fit/refit and wrote only to a disposable checkout.

### Qualified shadow evaluation

The previous shadow-report blocker is repaired locally. Operational file
feedback and CLI reports now use `event_bound_labels_v2`, sharing the trusted
fitter's label admission rule. Frozen forecast totals remain visible alongside
legacy, unresolved, void and unqualified exclusions. Every training fold applies
the same as-of rule; unchanged legacy observations do not acquire new provenance.
Generic v1 reports remain readable for historical research, but the owner reader
cannot accept their numeric gate as qualified evidence.

Executed regressions exposed and close two generation-evidence loopholes:
invalid nonempty records cannot stand in for durable ACKs, and a complete late
import cannot backfill proof at an earlier training cutoff. A timing-only test
passes with 110/110 and 220/220 timely fold records, and holds with late or
partial records even when final coverage is 330/330. Metrics remain visible;
all serving/activation flags remain false. This is not proof of public
publication, sufficient future sample size or improved joint parlay selection.

The actual runner upgrade from `aacb19c7` to `889e147e` preserved old artifact
bytes and first-observation clocks. Two unchanged legacy labels stayed excluded;
two genuinely corrected labels qualified through appended revisions. Duplicate
retries retained identical state/run/evaluation pointers. The small synthetic
candidate remained held, as it should.

Follow-up evidence under `code/evidence/`:

- `nfl-published-evidence-full-gate-20261118.log`
- `selflearn-qualified-shadow-core-final-20261118.log`
- `selflearn-qualified-shadow-hosted-final-20261118.log`
- `nfl-qualified-shadow-pin-focused-final-20261118.tap` (53/53)
- `nfl-qualified-shadow-upgrade-rehearsal-20261118.py`, `.json`, `.log`
- `nfl-grading-v2-live-capture-summary-20261118.json` and its retained raw capture
- `nfl-grading-v2-rehearsal-20261118.json`, `.log`
- `nfl-learning-main-recheck-20261118.json`
- `nfl-learning-live-recheck-20261118.json`

GitHub's queue semantics are documented in its
[May 7, 2026 release note](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/).
This platform documentation supports the queue configuration, not a claim that
the new workflows have already executed remotely.

## Ordered roadmap and ownership

| Stage | Work and acceptance | Owner / manual involvement |
|---|---|---|
| 1. Reliable NFL release | Publish the tested grading repair branch, run remote CI on the exact source/data SHA, drain older refresh jobs, merge only the reviewed artifact, verify production bytes and three representative refreshes. | Codex prepares and verifies; owner release authorization remains outstanding. |
| 2. Dependable publishing | Exact-SHA handoff and shared FINAL capture now pass local checks. Still enforce aggregate grading coverage as well as agreement, deduplicate repeated incident signatures, and verify three representative remote refreshes. | Automated implementation and tests; no manual data edits. |
| 3. Durable shared collection | Publish the engine commit before the NFL canary references it. Verify/apply the additive migration, reconcile Vercel alias and exact engine pin, wire pre-kickoff receipts and publication proof, raw outcomes and bounded scheduled workers. Replay and restart must preserve IDs; a correction must append a revision. | Codex; owner authorizes cloud release/migration. Account access is the only other manual dependency if existing connections cannot perform it. |
| 4. Safe serving | Unified shadow/fitter label qualification is locally verified. Reevaluate on untouched future/held-out periods, with clustered uncertainty, per-position calibration, coverage and parlay concentration. Approve one bounded correction, prove the served pool cites its artifact, and exercise automatic fallback to the base model. | Codex automates evidence and fallback; owner approves the serving policy. Future games, not more agents, supply prospective evidence. |
| 5. Operations | Show last forecast/publication/outcome/worker timestamps, pending and rejected counts, correction artifact and whether it reached recommendations. Verify Henry's monitoring connection. | Codex and Henry after connection verification; no Claude dependency. |

Collection, evaluation, adoption and use are separate states. The final proof is
a genuine pre-kickoff forecast with durable publication evidence, an outcome and
correction history, a passing evaluation, and an observable changed recommendation
under the approved artifact. None of these tests guarantees a winning parlay.

No remote push, merge, deployment, hosted migration or learning activation was
performed by this local repair work.


## Collection implementation order and owner actions

1. Finish the new NFL acceptance run, reconcile latest main's data without
   losing offer history, and regenerate only through the pipeline. Run remote CI
   on the exact generated commit before a production release. Drain pre-fix
   publisher jobs at the release boundary. Owner release authorization remains
   separate from the local build scope.
2. Reconcile the engine source, public Vercel alias and Supabase migration history.
   The afternoon read still found the production alias READY at `aacb19c7`;
   connected migration reads returned permission/connection errors. Those errors
   leave persistence unverified; they do not establish a database outage. Restore
   appropriate administration access if needed, then approve concrete deployment
   and migration changes. Never pass secrets through a handoff or chat.
3. Selectively port the already-written forecast sender, publication exporter/
   queue client, raw capture chunker and resumable v2 outcome sender from the
   preserved November 9 worktree. Keep November 18 grading/capture code. Adapt
   the sender's metadata and fact checks for optional retained roster evidence;
   the old sender currently rejects that newer capture. Port the journal's strict
   JSON/directory-fsync support and update engine pins together.
4. Collect one designated genuine pre-kickoff publication vintage per populated
   week at first. A current 1,008-receipt generation passed the exact local adapter;
   that is not a durable hosted ACK. The legacy whole-capture protocol caps at 500,
   so use resumable v2 with its complete membership contract. Retain original
   private graph, ACK and outbox across runner loss; temporary Actions artifacts
   are insufficient as the sole authority. Match the published Git pool bytes,
   then let the worker independently observe the actual public origin.
5. Capture FINAL outcomes and qualified identity evidence; verify repeated
   delivery, lost replies, restart and superseding corrections against hosted
   persistence. Assemble evaluation inputs from one durable journal watermark.
   Never truncate a multiweek population to fit current 2,000-receipt/transport
   limits; complete cohort handling is still an integration task.
6. Evaluate against the baseline on untouched periods under the declared
   statistical rule, including clustered uncertainty and no worse position.
   Obtain the first scoped adoption approval and demonstrate the candidate ID,
   baseline and adjustment in the served output, with tested fallback. The current
   learner covers MY player-yardage probabilities. Game/Week joint-hit policy,
   moneylines, anytime TD and unrecorded browser-built cards require separate
   evidence. Collection-on, evaluation-on and correction-serving are distinct
   statuses; no future betting improvement is guaranteed by a passing build.
7. Verify Henry's monitoring account/channel and then automate freshness,
   delivery backlog, worker heartbeat and distinct-incident reporting. Codex owns
   implementation; no Claude or Cursor dependency. Routine forecast capture,
   grading and evidence generation should require no manual operator work.

New evidence lives in `code/evidence/nfl-grading-coverage-capture-replay-20261118.*`,
`selflearn-qualified-jobs-core-20261118.log`,
`selflearn-qualified-jobs-hosted-final-20261118.log`,
`selflearn-qualified-jobs-sql-20261118.log` and
`selflearn-qualified-jobs-upgrade-20261118.{py,json}`. The readable report is
`code/reports/github-learning-rca-20261118/report.html`, revision 9.
