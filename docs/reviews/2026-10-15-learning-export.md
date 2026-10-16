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

## Immutable outcome-capture checkpoint

October 15, 2026, 6:33 p.m. CDT (America/Chicago). Local runtime checkpoint
`1bd076ac`, independently reviewed; not pushed, deployed or enabled in the
daily workflow.

- `scripts/capture_outcome_evidence.py` captures raw ESPN scoreboards first,
  then nflverse stats and snaps, under fixed source profiles and bounded
  retrieval. Content-addressed bytes, observations and a final success manifest
  are verified together. Failed/partial retrieval never publishes a success
  manifest. Replay does not refetch or restamp clocks.
- `scripts/build_learning_outcomes.py` joins the original frozen journal
  receipt, player pool and schedule. It preserves every valid vintage/rung
  without using current rosters or owner exclusions as learning labels.
  Raw-hash, membership, timing, canonical-contract and feature/base parity are
  checked before normalized outcomes are produced.
- `resolve_parlay_legs.py`, `resolve_my_cards.py` and `build_bet_facts.py` have
  an opt-in `--evidence-capture` path. Conflicting legacy inputs are rejected;
  no fallback is fetched. Required historical/locked weeks cannot be silently
  dropped by an aggregate overwrite. Every supported market requires explicit
  FINAL/OT evidence and a matching game identity.
- Missing required measurements, unknown identities/periods, plausible aliases,
  malformed/fractional/duplicate snaps and ambiguous zero-offense participation
  cannot fabricate a zero or DNP. Exact measured zero/negative yardage and valid
  R106 evidence remain usable. Explicit POST stat evidence can conservatively
  withhold an inferred label; it never fabricates one.

Unknown provider issue/update, actual game-finish time and last-revision status
remain unknown. A fetch after observed FINAL does not establish provider
completeness. R106 team-sheet absence and positive-snap/absent-stat zero are
explicit inferences, **not official sportsbook settlement**. This producer
supports MY yardage learning only; optional existing UI graders support their
declared markets without extending the shared calibrator to joint parlays.

Root verification on the frozen runtime (exit 0): Python 3.12 full gate passed
data validation, smoke, **2,220 feature tests** and all four model-regression
gates. **Browser step 8 was skipped** because Playwright is absent; this is not
a complete browser or exact-release-SHA acceptance claim. Focused capture,
consumer, producer/adversarial and tool self-tests passed independent review.

`tests/measure_outcome_coverage.py` traces actual Node-spawned Python children
and new threads using opt-in stdlib instrumentation. The evidence report is
`docs/reviews/2026-10-15-outcome-coverage.json`: capture **518/575 = 90.087%**,
producer **316/346 = 91.3295%**, total **834/921 = 90.5537%**, all five suites
passed (**57 tests**, **69 Python shards**), source hashes stable. Six tooling
self-tests cover per-file thresholds, uncalled-line denominator, shard binding
and safe output including hardlinks. This is line coverage of those two new
files, not consumer-change/branch coverage, full acceptance, SQL, live source
verification or an accuracy measurement.

SelfLearning checkpoint `7204ebd` adds a separate pure observed-clock resolver
and immutable no-change observation records. The later local `3ed4cae` D1
checkpoint implements indexed observations, complete fenced enumeration and
atomic observation/revision CAS, with a separate adapter port and internal job.
Its 601 core/API, 32 PostgreSQL-WASM SQL and 14 Python-to-SQL integration tests
pass; native concurrency and hosted PostgREST remain unverified. The API does
not select this new path. D2 must still bind raw provenance through bounded
transport and validate complete underlying-stat groups across rungs/vintages.
Neither this capture nor the existing exporter implements that hosted outcome
transport. No synthetic records were sent to a cloud database, and committed
`data/` and workflows are unchanged.

## Exact public-content observation checkpoint

October 15, 2026, 7:08 p.m. CDT (America/Chicago). Local runtime **`4cd7e1e6`**;
independently reviewed, not pushed, fetched live, wired into workflows or deployed.

`scripts/publication_observations.py` records a separate immutable observation
of exact MY-card bytes and their supported served prop-leg receipt membership.
It never changes original `generated_unverified` receipts or attests an entire
card, joint probability, generated pool or display-deduped newer vintage.
Conflicting generation envelopes, unsupported versions, incoherent capture
clocks and ambiguous membership fail closed or remain explicitly unsupported.

Default CLI is a read-only local plan, with no credentials, network or writes:

```sh
python3 scripts/publication_observations.py --snapshots data/snapshots \
  --my-cards data/my_cards/2026_wk06.json --season 2026 --week 6
```

Only explicit `--observe --out-dir <operator-directory>` permits a fixed-origin
HTTPS fetch from `https://nfl2026.netlify.app/data/my_cards/2026_wk06.json` and
immutable raw/event persistence outside `data/` and snapshot authority. The
fetch is bounded to 16 MiB/12 seconds, identity-encoded JSON, no redirects or
proxy credentials. Local authority is revalidated before and after retrieval.
Fetch-completion time is observed locally, never copied from a response header,
archive timestamp or generated clock. A late observation cannot prove earlier
availability. Output root/ancestor symlinks and immutable conflicts are refused.

**This is not deployment attestation:** deployment/code identity, observed
region and actual first-publication time remain unknown. `x-nf-request-id` and
claimed deployment SHA headers are not treated as proof. Supplied deployment
identity claims are rejected. S005-T2 is partial, not completed production
verification. No public observation was performed in this checkpoint.

Root verification, executed with Python 3.12.9 on PATH, exit **0**:

- Publication/journal/exporter regression: **38 passed**. Source-bound
  executable-line coverage **345/354 = 97.4576%** in the root run; independent
  focused rerun **344/354 = 97.1751%** (one concurrency branch differs).
  Source SHA256 `c1ed84442e357fd7c8132d7152e4140bb21d3d0fdccde020844497fb2e4f03ac`.
  This is line coverage, not branch or hosted acceptance.
- `bash tests/run_gate.sh`: data validation, smoke, **2,235 feature tests** and
  all four model-regression gates passed. **Browser step 8 skipped** because
  Playwright is absent. This is not complete browser/release acceptance.
- Actual committed Week 6 archive dry-run: **7,006,137 bytes**, raw SHA256
  `9fcec66cab3d0587c830320c799c5c2fe233fa0e1168934e97d48ef76e754111`.
  **Zero** verifiable members, **7,817** prop-leg occurrences missing original
  learning receipts and **4,378** unsupported-market occurrences. These are leg
  occurrences, not independent bets. No historical basis/publication evidence
  is reconstructed, and a zero-membership plan is not a working integration.
- `git diff --exit-code -- data .github/workflows scripts/build_my_cards.py
  scripts/export_learning.py scripts/learning_receipts.py scripts/learning_journal.py`
  exited 0: builders, existing export/journal contracts, sports data and
  workflows were unchanged by this slice.

Reproduce the focused checks with:

```sh
node --test tests/feature/week6_publication_observations.test.mjs \
  tests/feature/week6_learning_journal.test.mjs \
  tests/feature/week6_learning_export.test.mjs
```

The full candidate universe/correlation vintages for historical weeks 2–5 are
not established by these observations. Claude's earlier R126 replay used an
on-card-leg union; it must not be relabeled a complete-candidate prospective
backtest. The next local replay tool must report missing inputs explicitly.

## Frozen-candidate source audit and explicit replay tool

October 15, 2026, 9:57 p.m. CDT (America/Chicago). Local runtime **`5a4b057b`**,
independently reviewed, not pushed or activated. New `scripts/replay_r126.py`
and `tests/feature/week6_r126_replay.test.mjs` do not change the existing builder,
injuries, calibration, data or workflows.

The default CLI audits retained card archives, game snapshots, shipped-leg
ledger and correlation artifacts without network, Git fetch, credentials or
writes. The generated
[source audit](2026-10-15-r126-source-audit.json) binds actual hashes and reports
**null/unavailable complete-candidate historical metrics for weeks 2–5**.
Those source classes do not establish the original full candidate pool or
independent pre-kickoff public availability.

Explicit supplied experiments preserve actual R126 non-spread-first/fallback,
protected builder singleton behavior and actual-contract dedupe. The separately
implemented R74 control uses its original legal-pair/absolute-correlation/EV
ordering and full-pool singleton behavior. Synthetic inputs and local-Git
content are explicitly labeled; mutable Git clocks never qualify independent
historical availability. Frozen source probabilities are never refitted or
re-priced. No output can be persisted inside repository/custom data authority
or through selected output symlinks.

Reports separate full-contract hits, reduced settlement wins, all-VOID refunds,
pending exclusions and distinct selected-card denominators. A changed label,
metadata or whitespace cannot manufacture another actual bet; same-label bets
with genuinely different player/line/side remain distinct.

Root checks, exit **0**:

- New replay plus existing R126 suites: **10 passed**; independent new-suite
  replay **8 passed**, source-bound executable coverage **323/342 = 94.4444%**.
  Source SHA256 `9196125a39b7d0eae5d39e020fb179e5bbff6e086e2d02fb51ffd856c2e7e24d`.
- Python 3.12 full dependency-free gate: data, smoke, **2,243 feature tests**
  and all four model-regression gates passed; **browser step 8 skipped**.
- Real-data default audit succeeds without source changes. Each required week
  has four hashed source artifacts, but no complete original candidate authority.

```sh
python3 scripts/replay_r126.py
node --test tests/feature/week6_r126_replay.test.mjs \
  tests/feature/r126_game_card_ranking.test.mjs
```

Original S018-AC1 still requires the separately labeled on-card reference
reconstruction. Retained history has 366 slate revisions with a shallow August
16 boundary before the required weeks, so that narrower available-history
calculation is now being attempted. It must not be represented as the full-pool
comparison or forced to match the earlier 59/188 → 72/189 claim. No new whole
task, measured accuracy improvement or future hit-count credit is awarded here.
