# Opt-in exact-generation capture and publisher integration

Revision 3 · October 16, 2026, 11:18 a.m. America/Chicago (CDT).
Local implementation only. No workflow enabled, production publish, serving
policy promotion or permission to run a release is implied by this guide.

## Boundaries and actual flow

The pool builder's explicit capture option reads each of 14 fixed inputs once,
records the original UTF-8 bytes and distinct missing/null states, and gives the
same parsed values to the actual pool producer. Original code, every local
`scripts/**/*.py` file and conservative browser dependency bytes are pinned as
well. It persists the loader observation
before producer execution and the exact output writer buffer afterward.

The separate MY stage resumes that immutable pool checkpoint. Its actual single
read of the pool must match the earlier writer buffer. Actual reads of schedule,
calibration and previous MY archive must match their earlier captured preimages,
including file presence. Changed sources hold rather than becoming a newly
invented original capture. The existing MY producer, writer and
`learning_journal.record` run normally; the returned actual envelope and current
consumed objects form the target graph. Retained old receipt lineage is read
from immutable old journal/source objects, never relabeled as original producer
input reads. The v1 journal's three source keys remain unchanged.

The final publisher check reads exact committed HEAD blobs, not just the
worktree. It runs after each rebase/fallback and before **every** push attempt.
HEAD must stay unchanged through the check, and the push ref uses that exact
verified SHA. A changed tree holds; no silent rebind or old-PASS authorization
exists. The verifier does not itself push, fetch, rebase or authorize publication.

Coordinator review found that the first runtime inventory omitted transitive
Python helpers, including `availability -> injury_duration`. Capturing only the
16 semantic entry points was insufficient to identify all local implementation
bytes. The conservative whole-Python-tree inventory now rejects modified,
added or rehashed-away helpers at final HEAD. This is dependency-byte identity,
not an assertion that every file executed. The 1,024-file cap is enforced on
each addition, including the last directory. Empty Python modules are valid
code bytes; data/artifact documents still require nonempty, valid JSON.

The final check also requires regular Git blob modes: changing a source to a
symlink with identical content is not accepted. NUL-framed tree metadata pins
file modes and lengths. Raw Git blob reads are batched in at most 32 arguments /
8,192 argument bytes and framed by those immutable lengths; they do not use
archives, export substitutions, textconv, worktree reads or temporary files.
Existing per-command deadlines and file/aggregate byte limits were not raised.
Unexpected framing or changed dependency membership holds.

Injury/depth/inactive inputs here are validation witnesses for already-derived
weekly output, not original bytes consumed by the earlier weekly/ESPN HTTP
producers. Clocks, source origin, execution order and browser execution remain
unauthenticated. Only MY-yardage consumer semantics can pass; Game/Week/ML/ATD,
joint probability quality, model adoption and whole-release readiness cannot.
Undefined QB-depth and in-window inactive freshness policies still hold.

## Explicit options; no automatic enablement

These are future operator interfaces, **not instructions to publish now**:

1. `build_leg_pool.py --generation-capture-dir PRIVATE_DIR` prints the immutable
   loader and pool-checkpoint paths. The directory must be outside every Git
   checkout and not an ancestor of the source checkout.
2. `build_my_cards.py --generation-capture-checkpoint EXACT_POOL_CHECKPOINT
   --generation-capture-dir PRIVATE_DIR` prints the immutable runtime-binding
   path. It rejects changed sources, different source paths or a caller clock
   substituted for the actual MY read completion.
3. Only after separate release authorization,
   `publish_data.sh --generation-binding EXACT_RUNTIME_BINDING "message"`
   invokes the fixed final-HEAD verifier inside its existing retry loop.

Default builder/publisher invocations remain unchanged. There is no environment
variable that enables these hooks and no workflow currently supplies the flags.
Private files use exclusive content identities, file mode 0600 and fsync;
directory ownership is a trusted local boundary, not a multi-user sandbox.
Known macOS `/var`/`/private/var` aliases can denote the same artifact; tests use
actual file identity rather than comparing those spellings as different files.

## Scores-only N/A is not a generation PASS

`publish_data.sh --no-new-generation "message"` supplies both the freshly fetched
remote base SHA and the exact final HEAD to a separate conservative check.
**Every unpublished commit** between them must change only the five fixed
settlement/review outputs. A scores-only final commit cannot conceal an earlier
forecast change, including one later reverted. Missing/nonancestor bases,
ambiguous merges, more than 64 unpublished commits or any unknown/source/model/
browser/config/forecast path hold. It never grants a generation PASS.

Independent coordinator review first reproduced the interrupted draft checking
only HEAD's parent: an earlier forecast commit followed by scores was accepted.
The unchanged behavioral regression failed before the fix. The runtime now
examines the whole pending range, and the publisher passes the actual fetched
base on every attempt. Pure and actual local publisher/CLI tests both verify
zero push on that hold. Remote fetch/push are intercepted in tests; no actual
remote operation is part of acceptance.

## Work limits and pinned-data evidence

The ordinary JSON document/graph ceiling remains 500,000 nodes. Only the named
previous/current MY archive and the aggregate 14-document runtime identity
calculation use 750,000. Byte ceilings remain 16 MiB per file and 64 MiB total;
depth remains 32. Larger archives or graphs fail closed; there is no unlimited
parse, truncated history or blanket exception for another document name.

Pinned remote main `0d49a948` MY blob `d3ff4124b25761f9d4fef74d0f332ab61650cd0b`
is 8,493,722 bytes / 533,560 nodes / depth 8, 3,059 cards and 21 runs. Pool blob
`e12f2b92b5ea2a3f38df2697dce175f66dd651b9` is 2,653,249 bytes / 116,486 nodes /
depth 8. The mixed size-only 14-document profile is 660,460 nodes; five of its
documents are older local files, so **it is not complete remote-main capture or
semantic acceptance**. The older local 2,901-card/14-run measurement must not be
described as current remote data. Multi-vintage retained graphs can still hit
the unchanged graph ceiling and hold.

## Local verification

The first complete focused run after the range fix passed 12 cases, zero skips,
exit 0, including real producer → writer → immutable journal composition,
second-generation retained lineage, private file/symlink boundaries, byte and
presence changes, callback cancellation, forged hashes/clocks, final HEAD/browser
changes, named work limits, CLI failures and publisher retry interception.
A thirteenth actual publisher scores-only range test then passed separately.
The combined full gate for this source revision is still required.

The corrected-PATH combined run passed contracts, smoke and all four model
gates, but feature results were **2,433 passed / 13 failed, exit 1**. Two old
source-pattern tests assumed an inline name fallback and text-only `open(...,
"w")`. They now drive both real fallback consumers (including a wrong-ID
negative) and parse every static writing mode with Python AST, retaining the
single-OUT-target assertion. This is stronger behavioral/mode coverage, not a
skip or removal. The remaining failed cases included real subprocess deadline
and process-cleanup assertions. macOS sleep/wake records overlap that run;
sleep-related timeout attribution is an inference, not a waiver. All 45 focused
fallback/pool/publisher-race/preview cases subsequently pass with their original
timeouts, zero skips, exit 0. The combined gate must still be rerun; neither
focused success nor an environment explanation makes that failed run green.

The next frozen run, `27b43fd5`, passed all 2,446 feature tests plus contracts,
smoke and four model gates, exit 0; browser skipped. After adding the newer-main
fixtures, `41a56a09` passed 2,449/2,450 feature cases and the other executable
gate steps, but remained red on the process-cleanup fixture. Its failing line
required a worker startup marker inside a 150 ms deadline; it did not report a
surviving descendant. The fixture now prepares a real exited leader with a live
descendant first, retains the same 150 ms held-pipe deadline, and arms the
forbidden side effect only after supervisor return. A separate real-startup
test proves startup still consumes the budget and a late worker is killed.
All six focused cases pass, zero skips; no production supervisor code or
timeout was changed. A fresh combined gate on that test revision is required.

The subsequent Python-inventory revision passes 14 focused cases, zero skips,
exit 0, plus a separate actual Git batch/framing case, exit 0. The latter checks
all enumerated code bytes against the clean synthetic checkout, binary/empty/
tab/newline/Unicode paths, bounded batching, truncated replies and duplicate
tree rows. Other cases now include the previously omitted injury-duration
helper, new Python dependencies, exact inventory cap, rehashed omissions and
same-byte symlink modes. The 14-case trace is 440/458 AST statements (96.07%),
not executable-line/branch or independent acceptance coverage. A new frozen
combined gate must include all 15 cases; focused passes do not change the
earlier full gate's red result or establish production readiness.

The frozen combined run on `6aafdfcf4b321f1085837766f3489c6340818c11` now
passes **2,453 feature tests, zero failed/skipped**, data contracts, smoke and
all four model-regression gates, terminal exit **0**. It includes all 15 runtime
cases; the printed trace remains 440/458 AST statements. Browser step 8 is
explicitly skipped. Log:
`/private/tmp/nfl-injury-capture-full-gate-root-r5-20261016.log`.
The runtime/tests/data and HEAD did not change during that run. Subsequent
handoff-only documentation is not a new exact-tested release SHA. Current-main
data reconciliation, browser/hosted acceptance and publication authorization
remain required. Earlier red runs are retained as historical failures.

The printed focused trace is AST-statement coverage, not branch, browser or
network coverage. The 12-case run reached 401/418 statements; do not call it the
engine's executable-line metric. No native/hosted/browser, source completeness,
current full-pipeline or accuracy claim follows from synthetic fixture success.
R102 postpublication and R106 archive protections were not removed or weakened.
