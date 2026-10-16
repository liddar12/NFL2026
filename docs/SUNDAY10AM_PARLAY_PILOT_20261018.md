# Sunday NFL parlay learning pilot

Revision 1 · October 16, 2026, 12:58 p.m. America/Chicago (CDT).
Requested target: **Sunday, October 18, 2026, 10:00 a.m. CDT**.

An NFL-only operational pilot is a plausible target in the remaining roughly
45 hours, conditional on the owner's release approval and successful pipeline
verification. It is not a commitment to finish the reusable platform or prove
better predictions by Sunday. Prioritize the existing NFL Actions pipeline,
Netlify app and a pinned SelfLearning Python package running in Actions. Do not
make the full hosted Vercel/Supabase service the critical path to this milestone.

This changes delivery priority, not the original 99-task denominator. The full
engine roadmap remains open. The owner asked to defer security work for speed;
defer broader hardening without exposing credentials or changing old forecasts.
No production push, migration, deployment or model activation is authorized by
this planning document. Reuse the existing R1 architecture; no new diagram or
hosting provider is needed.

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
agents are credit-blocked, and no live Claude collaboration is connected.

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

- Read-only GitHub main: NFL `45b3cac4a0356b7e91b11121265ae1b84067fe93`;
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

## One scope decision for the owner

**A. NFL-first operational pilot, shared engine running in Actions
(recommended).** LOE: 16–24 focused engineering hours plus release time. Risk:
the fully hosted shared service follows later; a candidate may correctly remain
held, and actual gains cannot be guaranteed by Sunday.

**B. Require the fully hosted Vercel/Supabase learning loop first.** LOE:
several additional days or more, including hosted/schema/credential integration.
Risk: Sunday is unlikely; current Vercel access and unapplied migrations are
additional dependencies. This is distinct from the still larger complete
multi-domain platform roadmap.

Choosing either path sets priority; it does not authorize a production release.
