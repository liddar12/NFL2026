# Claude handoff: selected fixes, learning disabled

Revision R1 — October 18, 2026, 3:33 p.m. CDT (America/Chicago).

## Decision and actual status

The owner requested these seven candidates live, then chose:
**"publish disabled and write me something so claude can work on it to keep things moving forward."**

Publish the six selected NFL fixes through the normal main/Netlify path only
after a fresh rebuild and acceptance checks. Publish the optimized engine as a
separate draft candidate, **disabled and not connected to live recommendations**.
The whole Sunday learning pilot remains paused. Do not activate learning,
merge SelfLearning main, deploy Vercel changes, apply migrations, refit on week-5
or TNF outcomes, promote weather/R127, or change Elo k.

**Nothing from this selected release is newly live.** A remote NFL branch
`release/selected-fixes-20261018` was created at existing main
`b400175481ea083f241c0332b6c849881f8db062`; it has no selected code yet.
Do not dispatch daily on that metadata-only branch.

Code upload was explicitly rejected by `github_create_blob`:
"MCP tool call requires approval, but approval policy is never."
No alternative upload route was attempted. An operator must publish from an
allowed normal terminal or a separately permitted Claude session.

## Candidates and boundaries

| Candidate | Included locally | Remaining before acceptance |
|---|---|---|
| Injury identity hotfix | ESPN identity binding, consistent enrichment, validation and regression tests | Fresh provider/downstream rebuild, full exact-SHA CI |
| Inactive-feed parser | Row/identity integrity and malformed-entry isolation | Fresh official-feed execution and full CI |
| Weather/venue integrity | Game/venue/kickoff/source binding, null/unknown rain, isolated malformed rows, actual event venue in Slate | Rebuild new source contracts and full CI; no model promotion |
| Dead-code scanner | Faster scan preserving inventory semantics and tests | Full CI; tooling speed, not betting accuracy |
| Parallel CI | Core and feature partitions concurrently; required aggregate gate and separate browser job | Observe all workers on final generated SHA; a partial partition is not a pass |
| Rehearsal diagnostics | Standalone command timing, UTC/monotonic observation, optional explicit timeout, bounded atomic report | Tool is available, not automatically wired into a production pipeline |
| Optimized SelfLearning runtime | Separate engine candidate and handoff | Publish draft against existing feature branch, CI, future combined integration; stay disabled |

Supporting NFL change: daily/gameday publishers accept only main or a valid
`release/*` target and use the workflow branch for data publication. This allows
a candidate rebuild without writing main. The existing main default and race
safeguards remain tested.

## Exact NFL source and isolation

Local checkout:
`/Users/jliddar/code/NFL2026-selected-fixes-release-20261018`.

Functional source commit:
`3de293f55d3d97f238c99436bb4ad62c0c48857c`.
Base:
`9a537b9fdf5776d280f22549b1cb4aceb0b45458`.
Later commits may add only this handoff, evidence and the operator helper.

Do **not** merge the large unreleased pilot checkout
`NFL2026-sunday-release-evidence`, the old #175, or the old #10 to obtain these fixes.
The selected NFL delta has 43 paths before handoff/helper additions. It changes
source schemas in `data/contracts/`, but **no generated data**, model formulas,
MY controls, or parlay page source. It adds no self-learning activation config.

Observed remote main b4001754 includes PR #181. Its two source edits since the
selected base are `app/views/parlays.js` and
`tests/web/r90_parlays_ux.spec.mjs`; neither is owned by these selected changes.
Keep those and all newer main changes. Apply the selected binary patch onto
fresh current main with `git apply --3way --index`, never overwrite with the
older full checkout.

## Local evidence (not release acceptance)

[Verification JSON](../reviews/2026-10-18-selected-fixes-verification.json) records
the exact command and [raw log](../reviews/2026-10-18-selected-fixes-focused.log).

On 3de293f5: **99 tests passed, 0 failed, 0 skipped, exit 0**, 29.719 seconds,
Node 26.7.0 / Python 3.12.9. Coverage includes all six NFL fixes, original
publish-race tests, release-target isolation and the unchanged inactive/playable
behavior. `git diff --check` and generated-data base parity also exit 0.

The operator helper separately passed **5 local Git/stub test groups, 0 failures,
0 skips, exit 0**, on `0fd2b935`; Bash syntax also passes. These exercise patch
conflicts, newer-main preservation, generated-source/contract rejection,
exact-SHA CI/fallback guards and guarded publication resumption. They do not
call live GitHub or prove a hosted deployment. The separate raw log is adjacent
to the verification JSON.

There is **no full gate/browser/provider or production proof of this selected
release**. The checked-in old snapshot is known to need a normal rebuild for
the stricter injury/weather contracts. Do not patch its JSON to pass.
A 2,835-case gate from a different full-pilot checkout is not acceptance of
this selected tree. Earlier engine full-suite proof is not combined release proof.

## Safe owner-terminal release procedure

The adjacent `publish-selected-fixes-20261018.sh` helper automates the preparation
and exact-SHA checks in a new preserved worktree. Review it before running.
Its default mode stops at a tested candidate; `--publish-main` additionally
permits a normal, guarded fast-forward of that exact candidate to main.
It is an operator helper, not permission to bypass the rejected agent tool.

On this Mac, after reading this document, the owner-authorized full NFL path is:

```bash
bash /Users/jliddar/code/NFL2026-selected-fixes-release-20261018/docs/releases/publish-selected-fixes-20261018.sh --publish-main
```

Without `--publish-main`, it prepares/tests only and prints a guarded resume
command. Failures preserve the worktree and log directory for Claude. Do not
blindly retry a branch that now contains independently changed source.

1. Obtain the complete selected branch using local Git objects or the portable
   bundle supplied with this handoff. Make sure personal GitHub authentication
   is available for `liddar12`. Do not alter global work-account credentials.
2. Start from fresh current remote main. Preserve its generated data and all
   newer source. Apply only the selected patch, source contracts included.
   Refuse conflicts; never auto-resolve by dropping somebody else's changes.
3. Push the selected source to the release branch and create a draft PR.
   Only now dispatch `daily.yml` **on the release branch**, not main.
4. Capture both source SHA (workflow head) and generated-data SHA (the later
   publisher commit). Require success and inspect publish fallback warnings.
   Require the latter SHA to descend from the tested source and change only
   generated `data/` paths. Do not mistake the daily run's head for its output.
5. Explicitly run `ci.yml` on the generated-data branch head: a data commit
   marked `[skip actions]` may otherwise suppress acceptance CI. Require both
   regression workers, the aggregate gate and independent e2e all successful.
   Skipped/cancelled jobs do not count. Main-only data-ci is not candidate proof.
6. If either main or release moved unexpectedly, **stop and revalidate**.
   Only fast-forward unchanged main to the exact fully tested data SHA with a
   normal push. No force, no admin override, no untested merge-tree race.
7. Verify the resulting Netlify production deployment and served source/data
   identity, schemas, injury/inactive handling, week-6 slate, and no malformed
   weather represented as dry. A main push alone is not served-site proof.
   Record URLs, commit IDs, run IDs, exit codes and any skips in the PR.

If a contract/provider step fails, leave main alone. Diagnose on the candidate
branch; the daily job's success alone is insufficient because some source
refresh steps intentionally continue after failure. Rebuild and rerun CI after
every functional correction. The daily workflow shares pipeline concurrency;
a queued run is not a failure and may take time.

## Separate engine publication and Claude continuation

Local optimized publication source:
`/Users/jliddar/code/SelfLearning-runtime-publish-20261018`,
`aacb19c73122f257449e977df40f2a2733991b2f`.

Base is remote PR #10 head
`c1bf3d4773312c99ef0f30563c791525389fd5af`,
branch `build/nfl-feedback-runtime-20261015`. Push to a new
`release/optimized-nfl-runtime-20261018` branch and open a **draft** PR
targeting that existing feature branch, **not main**. Its six code deltas include
the CI import-path correction. Follow its
`docs/CLAUDE_OPTIMIZED_RUNTIME_HANDOFF_20261018.md` and parity JSON.
Do not merge either engine PR, deploy its API, or switch live learning on.

The current selected NFL fixes do not consume that runtime. After these bounded
publications, continue the unfinished pilot separately: retain pre-kickoff
predictions, complete official-inactive confirmation and T-minus-90-minute
policy, prove idempotent feedback/outcome joins and receipt parity, validate
freshness and adoption boundaries, and run repeated-refresh/browser/Linux
integration tests against an exact published engine SHA. Keep corrections off
until these pass and a separate activation decision is made.
Weather remains shadow; missing rain remains unknown. Track accuracy only on
honestly saved pre-kickoff predictions, without outcome leakage or promises of
"peak accuracy."

## Rollback

Before main publication, abandon the draft candidate; production is unchanged.
After publication, revert the identified source release on a branch and run the
same validation/rebuild path before publishing rollback. Do not assume reverting
source automatically restores generated history, and do not reset/rewrite main.
