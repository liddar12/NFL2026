# Selected NFL fixes — source-publication handoff

Read this first, then [the detailed handoff](CLAUDE_SELECTED_FIXES_HANDOFF_20261018.md).
The detailed handoff records the earlier preparation checkpoint; its upload-block
status is historical once the owner has pushed this branch. No production
deployment or fresh full-suite pass is asserted by a source push.

## Source locations

- NFL source branch: `release/selected-fixes-source-20261018`.
- The older `release/selected-fixes-20261018` is only a metadata branch unless
  separately updated; do not assume it contains these fixes.
- Original functional source: `3de293f55d3d97f238c99436bb4ad62c0c48857c`.
- Original complete handoff checkpoint: `4dd45027b3080c6c821d15eef245ef91788fcf65`.
- Later changes on this source branch are documentation only. Read its current
  GitHub head after publication; a document cannot name its own commit SHA.
- Engine source branch: `release/optimized-nfl-runtime-20261018`, expected
  `aacb19c73122f257449e977df40f2a2733991b2f`.
- Engine handoff:
  `docs/CLAUDE_OPTIMIZED_RUNTIME_HANDOFF_20261018.md` in SelfLearning.
- Do **not** overwrite `build/nfl-feedback-runtime-20261015`; use a separate
  engine draft targeting that existing feature branch, not main.

## Claude's next steps

1. Fetch both published source branches and verify their head commits. This NFL
   source is based on `9a537b9fdf5776d280f22549b1cb4aceb0b45458`, not today's
   generated-data head. Apply its source-only binary diff onto a fresh branch
   from current main. Preserve PR #181 and every newer public source/data change.
   `data/contracts/**` is reviewed source; all other generated data must come
   from current main and the supported pipeline. Stop on conflicts.
2. Rebuild using daily on a release branch containing the new branch-safe
   publisher, never the metadata-only branch. Do not hand-edit generated JSON.
   Record the workflow source SHA and the later generated-data SHA separately.
   A successful daily alone is not acceptance: inspect failed/best-effort stages
   and publisher fallback warnings.
3. Explicitly run CI on that exact generated-data head even if its commit uses
   `[skip actions]`. Require core, features, aggregate gate, and independent
   browser E2E. Report skips honestly; do not weaken tests. The existing local
   evidence is only 99 focused tests plus 5 release-helper test groups, not
   full hosted/production acceptance of current main.
4. Once accepted, use the owner-authorized normal release process and verify
   Netlify's served source/data. Reconcile moving main without dropping its
   history. Do not claim a source push or green CI means production is updated.
5. Publish/review the engine as disabled draft code only. Do not merge the full
   pilot, deploy Vercel/migrations, or enable learned recommendation corrections.
   The six NFL fixes do not yet consume the optimized runtime. Continue the
   remaining integration separately and keep learning off.

The operator helper in this checkout is an initial-publication helper with a
deliberately strict existing-release guard. If someone has already populated
its target branch independently, it should refuse. Do not force-push or remove
guards to make a repeated invocation proceed; reconcile and revalidate instead.

Return exact source/deploy SHAs, run URLs, exits/skips, and what is actually live.
