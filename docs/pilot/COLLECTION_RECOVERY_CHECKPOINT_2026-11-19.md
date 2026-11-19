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
