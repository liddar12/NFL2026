# Opt-in exact-generation capture and publisher integration

Revision 1 · October 16, 2026, 9:27 a.m. America/Chicago (CDT).
Local implementation only. No workflow enabled, production publish, serving
policy promotion or permission to run a release is implied by this guide.

## Boundaries and actual flow

The pool builder's explicit capture option reads each of 14 fixed inputs once,
records the original UTF-8 bytes and distinct missing/null states, and gives the
same parsed values to the actual pool producer. Original code and conservative
browser dependency bytes are pinned as well. It persists the loader observation
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

The printed focused trace is AST-statement coverage, not branch, browser or
network coverage. The 12-case run reached 401/418 statements; do not call it the
engine's executable-line metric. No native/hosted/browser, source completeness,
current full-pipeline or accuracy claim follows from synthetic fixture success.
R102 postpublication and R106 archive protections were not removed or weakened.
