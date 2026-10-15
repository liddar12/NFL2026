# NFL immutable learning export — local implementation handoff

Revision 1 · October 15, 2026 · America/Chicago

Status: implemented locally, not released. This exporter transports evidence; it
does not fit, activate, rank, publish or change any prediction. The production
operator token is not the ingestion identity and is not copied into this code.

## Components and authority

- Producer: `scripts/learning_journal.py` records prospective pool-rung receipts
  before MY-card display deduplication. Its immutable journal and exact consumer
  source snapshots remain the authoritative export inputs.
- Sender: `scripts/export_learning.py` validates the complete local content graph
  before an explicit send. The receiver must independently validate forecast
  semantics, source parity, eligibility and timing; valid hashes are not proof of
  public serving or correctness.
- Receiver: SelfLearning's backend-only NFL routes accept content-addressed
  objects, then persist accepted prospective receipt envelopes. An object-upload
  ACK alone does not mean that a generation's receipts were accepted.
- Delivery state: an operator-owned directory outside NFL `data/` and outside the
  source snapshot tree holds immutable requests, durable ACKs and safe machine
  failure codes. It is not an alternative sports-data store or a multi-user
  security sandbox. Existing symlinks in delivery paths are refused.

## CLI and transport contract

Safe local inspection, requiring no credentials, writes or network:

```bash
python3 scripts/export_learning.py --snapshots data/snapshots
```

Dry-run is always the default. Its counts describe the available immutable
capture population, not historical published cards. A zero-generation result does
not establish a working integration and must not be presented as a backfill.

Actual delivery requires all of `--send`, an HTTPS origin in `--base-url`, an
explicit `--out-dir`, and `SELFLEARN_NFL_INGEST_TOKEN` in the process environment.
Never pass a credential in an argument or URL. No workflow is enabled by this
change, and no production delivery is authorized by this document.

The client never follows redirects, including same-origin redirects. The origin
has no path, query, fragment or embedded credentials. Each JSON request and ACK
is bounded to 3 MiB. Oversize inputs fail before delivery rather than being
truncated or silently dropped. JSON nesting is explicitly limited to 24 levels,
matching the receiving API rather than relying on interpreter recursion limits.

1. `POST /api/v1/nfl/objects`: `{version:1, kind, object_id, payload}`. Referenced
   `source_snapshot` objects are delivered first. Their IDs hash the complete
   payload. A `generation` object's ID hashes its payload with `envelope_id`
   excluded, matching the producer's existing envelope contract.
2. Object ACK: `{version:1, object_id, durable:true,
   status:"recorded"|"duplicate"}`. Only a strict boolean `true` is durable.
3. `POST /api/v1/nfl/generations`: `{version:1, object_id}`. The server resolves
   and validates the durable generation and all referenced source objects.
4. Generation ACK: `{version:1, object_id, durable:true, receipts, rejections}`.
   Accepted rows contain `source_receipt_id`, generic `receipt_id`, and
   `status:"recorded"|"duplicate"`. Rejections contain `source_receipt_id` and a
   bounded machine `reason`. The accepted/rejected IDs must partition the exact
   source receipt set: no unknown, missing, duplicated or overlapping source ID;
   no generic receipt ID reused for distinct accepted sources.

Each ACK is validated before caching. A partial rejection is durably recorded
but the export exits nonzero; replay does not turn it into success. Arbitrary
server diagnostics and response bodies are never persisted. Error output avoids
echoing URLs, CLI arguments, tokens or transport exceptions.

## Retry, recovery and observability

Delivery files are keyed by normalized destination origin and by operation:
source upload, generation upload and generation finalization cannot reuse one
another's ACKs. A separate server cannot reuse a previous destination's state.
Requests and ACKs are published with exclusive atomic links and file/directory
fsync; conflicting content is not overwritten. Canonical JSON, not Python's
boolean/integer-coercing dictionary equality, determines immutable equality.
Concurrent `recorded`/`duplicate` status or row-order differences are harmless;
contradictory durable mappings remain failed on later replay and require
investigation rather than silently trusting whichever ACK won the local race.

Only transport failures, HTTP 429 and HTTP 5xx are retried, at most three attempts
by default (configurable through the Python API within one to five). Authentication,
conflict, schema/ACK and redirect failures are not retried. A lost reply after a
server commit may repeat the POST; the stable content ID lets the server return
`duplicate`. Cached validated ACKs make an unchanged replay network-free.

The CLI emits machine JSON with object/generation/receipt ACK counts, rejection
counts, cached ACKs and safe failures; exit 0 means every planned operation was
durably acknowledged with no rejected receipt. It does not mean that any model
was trained, publicly served or approved. Rejected receipts require diagnosis,
not deletion or mutation of the immutable source journal.

## Verification and remaining work

Run the focused stdlib/Node suite:

```bash
node --test tests/feature/week6_learning_export.test.mjs
```

Coverage includes the actual producer object graph, dry-run/no-write behavior,
ordered delivery, destination isolation, exact ACK partitioning, partial
rejections, crash-after-commit recovery, bounded transient retries, credential
non-disclosure, immutable conflicts, plan/source tampering, size limits, malformed
JSON/control-byte URLs and tokens, and delivery-path symlinks. These are local
fixture checks; they are not production persistence or acceptance evidence.

Release still requires backend persistence and scoped ingestion identity to be
configured and verified, deployed-code identity checks, the complete regression
gate at the release SHA, and owner authorization. Wire the existing pipeline only
after that controlled end-to-end test. Final-result revision transport,
candidate evaluation/return, approval/adoption and public-serving evidence remain
separate contracts; this sender does not claim to implement them.

Local checkpoint verification (October 15, 2026): all 16 exporter tests passed
under both Python 3.9 and 3.12. With Python 3.12 on PATH,
`bash tests/run_gate.sh` exited 0: data validation, smoke, 2,157 feature tests and
all four model-regression gates passed. Browser step 8 was explicitly skipped
because this isolated checkout has no `@playwright/test`; this is **not** a full
browser/release-gate pass. Existing generated `data/` had no tracked changes.
The exact future release SHA must still be reconciled with current main and
re-gated, including configured browser checks.

## Outcome evidence correctness and remaining transport gap

Local follow-up (October 15, 2026; not released): the shared yardage index now
preserves an unknown **required** measurement (QB passing, RB rushing, WR
receiving) instead of converting missing, malformed, boolean or nonfinite values
to zero. Both the leg-ledger and MY-card graders withhold that measurement with
`missing_stat_value`. Actual numeric zero and negative yardage remain measurable
outcomes. A present but malformed cell is not repaired by a snap sheet. R106's
distinct no-stat-row path remains unchanged: positive offensive-snap evidence
supports zero production; a published team sheet without the player supports
DNP/VOID; absent participation evidence remains pending. Non-applicable yardage
columns and the existing blank-TD-component convention remain unchanged.

The compact MY BETS facts consumer emits `y:null` for an unknown required
measurement, never an invalid numeric array containing a null cell or a false
zero. Existing valid finalized facts and grading behavior are unchanged.

The shared finals index now independently requires `STATUS_FINAL` or
`STATUS_FINAL_OVERTIME` and two finite nonnegative integer scores. This also
protects explicit `--finals` files and injected ESPN fetchers: live/stub,
status-less or malformed rows cannot grade merely because they carry scores or
`final:true`. Intended-FINAL inline selftest fixtures now name their actual FINAL
status; every pre-existing expected outcome and assertion is retained. No
committed outcome history was regenerated or repriced by this change.

`tests/feature/week6_outcome_evidence.test.mjs` covers these behaviors through
both graders, the facts schema and actual browser `gradeLeg`, file and injected
fetch routes, and the existing producer selftests. This is a correctness fix,
**not a completed authoritative outcome transport**.

Local verification: the new suite passed 8/8 under Python 3.9.6 and 3.12.9
(both exit 0). The nine related feature suites passed 69/69 (exit 0), including
the existing parlay gate and committed-data validator. `git diff --check`
exited 0. No full browser/release gate is claimed for this follow-up.

Root regression on the frozen follow-up source, October 15, 2026, before
5:44 p.m. CDT (America/Chicago): `PATH` selected Python 3.12.9 and
`bash tests/run_gate.sh` exited 0. Data validation, smoke, all 2,165 feature
tests and all four model-regression gates passed. Browser step 8 explicitly
skipped because Playwright is not installed. There were no tracked changes to
`data/` or workflows. This is a dependency-free regression checkpoint, not
complete browser acceptance or authorization to release.

The remaining boundary must not manufacture authority from legacy outputs:

- `fetch_csv` and the snap fetcher discard response digests, headers and retrieval
  clocks. ESPN `fetch_scores` retains FINAL/OT status and kickoff but no exact
  finish time or upstream update clock. Missing clocks remain unknown.
- `load_finals` and compact score/facts outputs discard per-row source identity;
  MY scored-card output also omits pending-only cards and per-leg reasons. These
  display/settlement files are not complete source-evidence journals.
- Separate daily resolver/facts commands currently refetch without a shared
  cache, so they can observe different source vintages in one run. A future
  outcome producer should capture one immutable stats/snaps/scoreboard bundle
  and have every learner fact reference it.
- Resolve identities from each forecast's frozen pool, never today's roster.
  Fan a verified official correction out to every original receipt vintage of
  the same contract. Owner `excluded_game` policy is not an official learning
  VOID and must not remove real outcomes from the learning population.
- Preserve first observation per measurement revision. A repeated fetch of
  identical evidence must not restamp its clocks or fabricate a new correction.
  Use an explicitly versioned observation-clock adapter when upstream update or
  exact game-finish times are unavailable; do not relabel retrieval time as
  either. Database insertion time remains the trustworthy training-availability
  boundary, not a claimed historical `generated_utc`.

No workflow, production source, model coefficient, candidate adoption or
deployed site is changed by this local follow-up.
