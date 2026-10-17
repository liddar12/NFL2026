# Sunday NFL parlay learning pilot

Revision 8 · October 17, 2026, 9:50 a.m. America/Chicago (CDT).
Requested target: **Sunday, October 18, 2026, 10:00 a.m. CDT**.

The owner resumed implementation and authorized getting the NFL pilot live
before this target on October 17. Release still requires successful pipeline
verification. It is not a commitment to finish the reusable platform or prove
better predictions by Sunday. Prioritize the existing NFL Actions pipeline,
Netlify app and a pinned SelfLearning Python package running in Actions. Do not
make the full hosted Vercel/Supabase service the critical path to this milestone.

This changes delivery priority, not the original 99-task denominator. The full
engine roadmap remains open. The owner asked to defer security work for speed;
defer broader hardening without exposing credentials or changing old forecasts.
The live-release request authorizes the tested NFL-first release, not an
unreviewed candidate, a Supabase migration or a separate Vercel deployment.
Reuse the existing R1 architecture; no new diagram or hosting provider is needed.

## Saturday release checkpoint

The owner selected provisional MY props before official inactive lists, clearly
labeled, with automatic withholding at 90 minutes before kickoff until rechecked.
Local producer, captured-source, saved-pool and UI enforcement are implemented.
The current registered policy does not yet bind official inactive confirmation:
after the checkpoint a fresh fetch alone cannot restore yardage props. Completing
that recheck is still required; do not advertise confirmation or silent recovery.

The selected-policy identity, isolated QB-depth and inactive-period defects are
fixed locally, with focused regressions. New complete engine reruns pass
**1,379 tests, zero failures/skips**, with **8,551/8,862 = 96.4906%** executable-line
coverage across 49 critical engine modules. The latest report binds engine
`95fc5bb` and NFL `dd8cabfd` with 61 NFL source hashes; it precedes the final
legacy-equation follow-up. The earlier clock-expiry failure is preserved, not
hidden or fixed by weakening expiry. Line coverage is not production evidence.

Actual main-sized, cached-input rehearsal on source `14570f0d` has regenerated
weekly projections, MY recommendations and dependent GAME ATD cards, and passed
the standard data validator. It preserves all 3,211 original MY cards and adds
50; current pool: 165 players/961 rungs. The weekly ID-first injury join removes
Deebo Samuel despite the provider's name suffix difference. This is a controlled
published-component replay, not a point-exact original pipeline reproduction or
a fresh provider HTTP fetch. Full NFL regression and exact publication checks
are still running; no final release certificate is claimed.

The first selected-only migration retains old whole cards exactly against source
Git and the fetched publication base. It does not invent missing journals: 225
old receipt IDs remain explicitly unverified and training-ineligible. The shared
engine accepts and persists 961 new forecast receipts, excludes those old IDs,
and returns HOLD with zero graded outcomes. A repeat leaves the receipt state and
all prior immutable files unchanged. This proves capture/retry behavior, not
prediction improvement or real-data model adoption. The approved/fitted route's
legacy-history migration remains separately unfinished.

A repeated-generation rehearsal exposed a release blocker: the bounded mixed
14-document calculation exceeds its 750,000-node ceiling on the next refresh.
The first wrapper is already 52.2 MB of its 64 MiB ceiling. Fix bounded processing
and prove multiple refreshes; do not delete history or simply waive limits.

Current main `28f7ac3b` is merged locally, including fresh pipeline data and the
post-TNF RCA update. No runtime changes were present between the prior production
merge and that main revision. Nothing from this integration has been pushed or
deployed as of this checkpoint. Direct Git push failed DNS; the connected GitHub
write was explicitly refused because it requires approval while this session's
policy is `never`. No remote object or ref was created. Do not try another write
route around that refusal. An authorized operator must perform publication once
the final candidate passes. The whole-roadmap tally remains 50/99 completed
local tasks, not an accuracy score or a live-readiness percentage.

**Owner selected A: NFL first, shared engine running in Actions.** The first
implementation slice is committed locally: engine `0e5b697` / `8460a71` and
NFL `903d5ff6` / `92b2b5a0`. Ten shared-core feedback tests and fifteen pilot tests pass,
including the real NFL producer, raw grading, corrections and persistence
recovery. The first full NFL gate found integration failures; all 66 focused
checks and the corrected full gate pass: 2,468 NFL features, zero failures/skips,
contracts/smoke/four model gates; browser step 8 skips. The paired engine run
passes 1,363 core/API tests, zero skips, with all 48 critical files above 90%
line coverage. Adoption/complete UI/live acceptance remain unfinished. Operational
instructions and remaining release requirements are in
[Parlay feedback pilot](PARLAY_FEEDBACK_PILOT.md).

Local follow-up `49bcd2ac` verifies the exact Git data selected for publication,
retains original raw captures for replay, and adds MODEL's saved shadow metrics,
cohort counts, hold reasons and evaluation age. A checkout-shaped regression also
fixes the controller's outcome-save path while preserving the standalone
exporter's sports-data write refusal. Twenty-nine focused tests pass with no
skips. Full reruns on frozen NFL `49bcd2ac` and engine `9738ead` both finish exit
0: **2,482 NFL features** pass with zero failed/skipped, plus contracts/smoke/four
model gates; **1,363 core/API** pass with zero skips and stable **48/48 targets
above 90%** line coverage. Browser step 8 skips. These changes do not activate a
candidate or establish a served generation.

Game/MY shared-leg and shared-game warnings are now local `c63f34fe`, with 66
focused tests passing; the full NFL rerun finishes exit 0 with **2,493 features**,
zero failed/skipped, plus contracts/smoke/four model gates. Browser step 8 skips;
three authored browser cases are not yet executed. Week exposure already exists. The owner selected
approval of one exact candidate for eligible future 2026 Week 6 refreshes, with
per-generation compatibility/freshness/expiry checks. This is approval-scope
design, not activation of any candidate. The actual consumer and rollback remain
next; a new refitted candidate cannot approve itself.

## What Sunday should deliver

| Capability | Owner-visible result | Acceptance evidence |
| --- | --- | --- |
| Freshness and eligibility | Parlay page shows generation/source age and excludes documented unavailable players; stale or unknown data is explicit | Fresh-input regeneration; same-ID OUT, stale feed and isolated unknown-row cases; verify final served generation |
| Forecasting and recommendations | Game/Week/MY cards use their appropriate existing models; highest-hit ranking stays the default | Same-input selector tests and published policy/model versions; no MY-yardage coefficients applied to ML, spreads, TD or joint probabilities |
| Forecast record | Exact pregame inputs, offered legs/cards, base and served probabilities and code/policy versions are saved before display dedupe | Retry produces the same immutable receipt; later generation cannot replace an earlier forecast; kickoff cutoff test |
| Outcomes and corrections | A finished game can move to graded; a genuine source correction appends a revision | Exact event/player/market joins, FINAL versus pending/VOID distinctions, original history preserved and retry-safe correction test |
| Evaluation | Model/Review shows cohort size, exclusions, Brier/log loss, as-offered card results and candidate/hold reason | Same frozen cohort compared with incumbent; chronological training, game-clustered uncertainty and independent membership/score checks |
| Adoption | A compatible, passing candidate has an explicit owner-controlled future-generation activation/rollback path; otherwise the incumbent stays | Positive approved activation test, stale/incompatible/refused candidate tests, old receipt unchanged and rollback rehearsal |
| Concentration | User can see when many recommendations depend on the same leg or game | Shared-leg/game exposure counts on the displayed cards; no fake claim of independent bets or duplicate filler |
| Operational loop | Forecast capture and postgame grading/evaluation run from the pipeline, with visible last success/failure | One manually dispatched full run and one repeat/recovery run; workflow evidence and exact served hashes |

MY player-yardage props are the first supported shared calibration population.
Game/Week cards remain in selection and honest record reporting, but shared
MY calibration must not silently become their probability model. Weather stays
observational/shadow where its predictive lift has not passed evaluation;
missing rain is unknown, not zero. Preserve R102/R106, existing R126 ranking,
Elo k=20 and the held R127 feature policy. Do not refit on Week 5 or TNF outcomes
to satisfy this deadline or promise a particular number of winners.

## Fastest implementation route

Use NFL's existing producer and postgame source adapters, and invoke an exact
SelfLearning package commit from a bounded Actions evaluation step. Save complete
receipt/source/revision manifests and reports durably through the repository's
existing race-safe data publisher; Actions temporary files/caches alone are not
durable state. Do not truncate a cohort to fit a request or promote a partial
evaluation. Internal capture is not proof of public publication: verify the
served generation separately.

Retain the engine's versioned adapter/report/artifact contracts, so the same
records can subsequently mirror into Supabase without inventing a second model
or separate calibration formula. The first pilot may run the shared code in
Actions without a new evaluation HTTP service. This execution location already
matches the R1 technical plan. Full hosted ingestion, indexed outcome storage,
the generic worker API, dashboard/MCP expansion, screenshots, other domains and
broad security hardening are follow-on work, not Sunday prerequisites.

An operating grading path does not imply it has graded Sunday's games at
10 a.m. They have not yet supplied future outcomes. Before release, rehearse
outcome/correction/adoption paths on labeled local fixtures and read-only frozen
evidence, never fake production outcomes. Verify actual postgame processing when
the source becomes available. Show pending/stale status while waiting for FINAL
stats. Additional pre-kickoff refreshes remain necessary after the 10 a.m. target.

## Work order and estimate

Planning estimate with the coordinator working alone: **16–24 focused engineering
hours**, plus owner review/release and external pipeline queue/provider time.
This is a capacity estimate, not a measured completion guarantee. Three parallel
agents are now active on source/producer acceptance, regression/UI acceptance
and pipeline checks. No live Claude collaboration is connected. Publication
permissions, final CI/browser evidence and the remaining blockers still govern
the target; local test counts do not make the requested date a guarantee.

1. **Friday, October 16:** freeze the supported pilot contract, inspect/reconcile
   current main, prepare the minimal correctness release and wire the complete
   forecast → source-verified outcome → correction → shared evaluation job.
   Target 6–8 hours. Keep nonessential generic infrastructure work off this path.
2. **Saturday, October 17:** finish the actual candidate-consumption/rollback
   boundary and reuse Model/Review/Parlay pages for status, freshness, metrics
   and exposure. Run a full dataflow rehearsal with negative cases. Target
   6–8 hours. A candidate/JSON file without actual future-serving consumption
   does not satisfy adoption acceptance.
3. **Saturday by 6:00 p.m. CDT:** target code freeze and release-readiness review.
   Run exact-revision core/API/NFL gates and browser/preview acceptance, rehearse
   failed refresh/correction/rollback, then request the owner's release approval.
   Budget another 4–8 hours across verification/rework. If the complete dataflow
   is not green, revise scope/date explicitly; do not relabel a local-only or
   shadow-only fragment as the complete live learning pilot.
4. **Sunday, October 18:** target a manually dispatched refresh at 8:00 a.m. CDT,
   served-generation/data checks by 9:00 and a go/no-go decision by 9:30. Use the
   remaining half hour as buffer, not primary integration time. GitHub cron is
   best-effort and cannot be the only deadline mechanism. The target is 10:00;
   it is not verified completion.

If no compatible candidate passes, a visible, correct HOLD is the release result;
do not weaken the model gate to manufacture an adoption. New accuracy gains
remain an empirical question requiring future graded evidence. The immediate
benefit can be fewer correctness errors, fresher eligibility and transparent
selection/coverage, not a guaranteed higher hit rate.

## Evidence and dependencies checked October 16

- Latest read-only check at **8:53 p.m. CDT**: NFL main
  `d0f99be248003f109c9b6394feb2ab14921205cb`, two commits after `45b3cac4`,
  changing 51 data paths and no runtime/workflows. Engine main is unchanged.
  [Comparison](qa/2026-10-16-2053-remote-heads.json). This newer data was not
  imported or release-gated locally; verify current main again before release.

- Earlier read-only GitHub main: NFL `45b3cac4a0356b7e91b11121265ae1b84067fe93`;
  SelfLearning `aa5bbaeddca4138399a21c1894b4aed4bacb52b4`. The local integration
  work is not published by these remote heads.
- Supabase migration read returns only `20260921025211 hosted_foundation`.
  The newer journal/capture/owner/job migrations are local, not applied there.
- Vercel project inspection returns 403: the current connection is not
  authorized for the `liddar-terminal` scope. No retry through another identity,
  deployment or configuration change was attempted. The fully hosted track needs
  the owner to restore authorized access; the NFL-first Actions path avoids
  making this its first dependency.
- Locally tested NFL source `6aafdfcf`: 2,453 feature tests plus contracts/smoke/
  four model gates pass; browser step 8 skipped. Engine runtime `419c73a`, test
  hardening `e087541`, evidence `605afd4`: 1,353 core/API pass, 46 critical files
  above 90% executable-line coverage. Separate SQL: 93 Node and 101 Python pass,
  seven native-only skips. These are component/regression checkpoints, not
  acceptance of the proposed Sunday pipeline or a live accuracy improvement.

## Accepted delivery scope

**A selected. NFL-first operational pilot, shared engine running in Actions.**
Planning LOE: 16–24 focused engineering hours plus release time. Risk:
the fully hosted shared service follows later; a candidate may correctly remain
held, and actual gains cannot be guaranteed by Sunday.

**Deferred alternative B. Fully hosted Vercel/Supabase learning loop first.** LOE:
several additional days or more, including hosted/schema/credential integration.
Risk: Sunday is unlikely; current Vercel access and unapplied migrations are
additional dependencies. This is distinct from the still larger complete
multi-domain platform roadmap.

The A selection sets priority; it does not authorize a production release.
