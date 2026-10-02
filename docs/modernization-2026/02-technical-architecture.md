# Technical architecture

## Runtime and repository boundaries

Preserve the NFL frontend's vanilla JavaScript ES modules and hash routing. Do not add React, a bundler or a package runtime to the application. Keep Python 3.11 stdlib-compatible gate code and Node 22 built-in tests. Dev-only browser tests retain their existing package boundary. The isolated prototype's DOM test harness is not a production dependency.

Proposed module boundaries, introduced incrementally rather than a wholesale move:

| Module / package | Contract and responsibility |
| --- | --- |
| `app/league.js`, `app/sleeper.js` | Existing normalized profile and manual import; retain public functions while improving coverage |
| `app/scoring-coverage.js` | Proposed shared complete/partial/unavailable assessment for a total and its components |
| `app/data.js` | Generation-aware fetch/cache; cancel superseded requests; explicit refresh; atomic publication to views |
| `app/views/my-league.js` | Proposed composition of matchup, lineup decisions, waivers and data status |
| Existing `lineup`, `team-logic`, `grade-*` | Keep the same mathematical engines; centralize scoring adjustments and coverage |
| `app/views/players.js`, `compare.js` | Search, filters and comparisons using the shared projection view model |
| Proposed `app/quotes.js` | Quote presentation/validation status; no imports into model feature or probability modules |
| Proposed `app/live-scores.js`, `live-poller.js` | Foreground live display with cleanup; no final outcome writes |
| `scripts/build_estimate_ledger.py` | Historical union and immutable locks independent from current pool |
| Proposed `selflearn_core/adapters/nfl.py` | Source normalization and idempotent import, not forecasting |
| Proposed `selflearn_core/scoring/sports.py` | Explicit points/probability/settlement task metrics |
| `selflearn_core/store`, `registry`, `updater` | Durable records, model versions, evidence eligibility and staged proposals |

Keep existing exports as compatibility seams until their consumers migrate. Move one feature at a time out of the large Team view only when it is touched by the corresponding roadmap item.

## Scoring and identity contract

Compute `league_points` once from base projected stat quantities and the versioned league scoring policy. For a TE premium, apply the rule to TE receptions, not to all receivers and not to an already-premium-adjusted total. A five-catch TE receives 2.5 extra points at +0.5; a five-catch WR does not. Apply supported yardage/TD/bonus rules through the existing verified component path. Avoid rescaling the entire player line to simulate a position-specific rule.

A `ProjectionView` must carry: points, estimate flag, player key, event/week, model version, scoring version, as-of, availability, applied component keys, unsupported keys and `coverage_status`. The total is `null` only when no justified estimate exists; partial totals remain numeric plus an unavoidable partial marker. Do not silently treat a missing quantity as zero. Uncertainty uses method/target/empirical coverage fields; no hardcoded 80% label.

Preserve currently used player IDs, including explicit ESPN fallback IDs, while adding an identity registry mapping source system and source ID to one stable internal entity. Prefer verified nflverse/GSIS mappings when available. Do not rename historical keys or guess name matches midseason. Retain original Sleeper roster IDs even when projection identity is unresolved. Names are labels, not primary keys.

Changing league rules produces a new `scoring_version` from canonicalized scoring and roster settings. Forecast comparisons and league grades must use that same version. Different scoring policies cannot be pooled into one points metric unless explicitly transformed and labeled.

## Versioned data publication

1. A producer writes an immutable generation directory, initially `data/generations/<id>/`, with checksums and source timestamps.
2. Validate all required contracts together, plus cross-file identity, week, model/scoring and generation invariants.
3. Write the manifest last. It references immutable artifact paths, schema versions, byte counts and hashes.
4. The client checks the manifest on Refresh and visibility return. It downloads a complete new generation in parallel, validates it, then replaces the active view model once.
5. A failed artifact keeps the previous complete generation visible with a stale reason. No route may combine new player rows with old weekly rows.
6. Prune public generation history only after retention policy is met; the learning archive is an independent durable copy and is not subject to active-pool pruning.

Generation IDs can initially be a build timestamp plus content hash. Record the source code commit separately; do not derive a circular commit hash by embedding the commit containing the manifest into itself. Keep a deploy-readable build ID so production can be matched to a source revision.

## Forecast, quote and outcome contracts

The schemas in `contracts/` are proposed wire contracts. Examples are marked fixtures and are ineligible as real learning evidence. Timestamp ordering, sums and cross-record ownership require semantic validators beyond JSON Schema.

**Forecast:** immutable record ID, project/task/entity/event, issued time, lock deadline, source-as-of, evidence class, code/model/scoring versions, source hash and typed prediction. Points prediction uses `{kind: "points", value, interval}` so an adapter can map it explicitly to the current scalar scorer. A class probability prediction uses an exhaustive outcome dictionary and sums to one. Unsupported task shapes fail visibly.

**Quote:** actual book and quote IDs, exact event/selection identities, market type, line and unit, combined decimal payout, quote/expiry times, settlement policy and verification state. There is no fallback price. A draft manually entered quote is unverified until reconciled with a supported source. Production actionable EV requires a verified, unexpired, matching quote and an eligible probability model.

**Outcome revision:** prediction FK, monotonically increasing revision, source record/hash, authoritative status, source-observed and resolved times, result, superseded revision and correction reason. Only eligible final/void revisions feed scoring. Do not use elapsed horizon alone as proof of finality.

For NFL ties, choose an explicit task: a three-outcome distribution, or a binary forecast explicitly conditional on no tie. Never infer `away = 1 - home` and settle a tied moneyline as a loss by accident. Sportsbook pushes, voids, rescheduling and partial parlay settlement follow the quote's recorded policy, not a generic all-legs-hit boolean.

## Temporal integrity and ledger migration

Retain the existing conservative week-first-kickoff policy for existing locks. A later per-game cutoff is a new versioned lock policy, not a reinterpretation of past records. Invariants:

- `source_max_as_of <= issued_at < lock_deadline` for a verified pre-event forecast.
- `ingested_at` is server assigned and never substituted for `issued_at`.
- An old artifact can be imported after kickoff only with an auditable pre-event source snapshot/commit. Reconstructed or unproven history is classified separately and excluded from live performance claims.
- The historical union survives removals, missing weekly feeds and reappearances. Active membership is a separate field.
- Same ID and same content hash is an idempotent retry. Same ID with different content is a conflict, never an upsert.
- Prediction rows cannot be updated or deleted by normal writers. Corrections append outcome revisions and new evaluations; old evaluations retain their exact input revision set.

Migration begins with a dry-run inventory and a deterministic import report: eligible, duplicate, reconstructed, late, unresolved and rejected counts. Do not turn a missing archive into an estimate made today with yesterday's timestamp.

## Durable store design

Recommend a private `learning` schema in Supabase Postgres, separate from authenticated user-owned preferences and any explicitly published aggregate views.

| Relation | Key and important fields | Invariant / access |
| --- | --- | --- |
| `projects`, `project_members` | project ID; member user ID and role | Owner/admin/operator/reader are server-controlled; indexed membership |
| `model_versions` | project + task + version; config/code/policy hashes | Immutable artifacts; status changes recorded as decisions |
| `forecast_records` | record ID; project/task/event/entity/model/scoring/cutoff | Unique semantic forecast key; insert-only; source lineage |
| `outcome_revisions` | prediction ID + revision | FK enforced; no overwrite; source correction chain |
| `import_runs` | run ID; source manifest/hash; counts and cursor | Retriable jobs with idempotent batch keys |
| `evaluation_runs` | run ID; model pair; event set and revision hashes | Frozen cohort/horizon/split/metric configuration and artifacts |
| `metric_results` | evaluation + cohort + metric | Value, sample and independent cluster count, CI method |
| `proposals` | proposal ID; evaluation reference; expected incumbent | Immutable proposed artifact; eligibility expiry |
| `promotion_decisions` | decision ID; proposal; actor; previous/next version | Append-only approval/rejection/rollback audit |
| `quote_records`, `paper_decisions` | quote ID; immutable decision ID | Separate measurement namespace; no model-feature access |

Index the equality prefix used by common reads, e.g. `(project_id, task, model_version, issued_at DESC)` on forecasts and `(prediction_id, revision DESC)` on outcomes. Index FKs and membership predicates. Paginate by stable cursor, not large OFFSET. Start without partitions; add partitioning only after realistic EXPLAIN/size evidence. Parameterize queries and cap result sizes.

Use a restricted writer role or narrow validated ingestion endpoint, not a browser service-role key. Exposed schemas need both grants and RLS; private user records need ownership predicates. Aggregate views must not bypass underlying visibility accidentally. Supabase documents the interaction of grants, RLS and service-role bypass. [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

Schema design is not a migration applied to a database. Use the existing schema as the migration starting point, create migrations through the current CLI workflow, test against a separate development project, and obtain the explicit production-migration approval required by the repository.

## Proposed API surface

| Endpoint | Authentication | Behavior |
| --- | --- | --- |
| `GET /api/nfl` | Public read, rate-limited | Normalized event state + source as-of; bounded response cache |
| `GET /api/learning/scores` | Public sanitized aggregate or authorized private read | project/task/model/cohort/window; cursor; provenance |
| `GET /api/learning/forecasts` | Project reader | Paginated forecast/outcome revision display |
| `GET /api/learning/proposals` | Project reader | Eligibility and evidence artifacts; no implicit approval |
| `POST /api/learning/imports` | Restricted machine identity | Idempotent batch receipt; rejected-row report |
| `POST /api/learning/proposals/{id}/approve` | Authorized owner/operator policy | Expected incumbent + policy + artifact hashes; immutable audit |
| `POST /api/learning/rollback` | Authorized owner/operator policy | Restore an already validated version; explicit audit |

These are proposed routes, not existing endpoints. Confirm the actual `live-api` repository's runtime and routing before adding handlers. The existing NFL/SelfLearning checkouts do not prove that project is deployed or authenticated. Long evaluation work returns a job ID and runs in a batch worker; never depend on a serverless request staying open for training.

For authenticated mutations validate the server session, project role, origin/CSRF where cookie auth is used, request schema and idempotency key. Return 409 on stale incumbent or conflicting payload, 422 on invalid/ineligible evidence, and 503 on dependency unavailability. Do not convert failures into an empty successful record.

## Evaluation and promotion mechanics

Partition every evaluation by project, task, immutable model version, scoring policy, forecast horizon and cohort. Pair incumbent and candidate on identical event IDs and outcome revisions. Record missingness rather than selecting only convenient rows. For player-week metrics, bootstrap by week/game clusters as appropriate; 100 correlated player rows are not 100 independent games. Points: MAE, bias, rank correlation, top-K/lineup decision metrics and interval coverage. Probabilities: Brier, log-loss, calibration and sample counts. Paper parlays: settlement-aware net return and calibration on actual archived combined quotes.

Use temporal holdouts, embargo overlapping horizons where needed, and track repeated hypothesis search/multiple comparisons. The current minimum of 30 resolved outcomes is only a lower bound for proposal consideration; each task also needs enough independent clusters and a predeclared evaluation design. Do not relax the current never-regress rule to force an adoption.

An approval transaction locks the task registry row, checks the expected incumbent, evaluation/policy/artifact hashes and current eligibility, then appends a decision and changes the active version atomically. Two concurrent approvals cannot both succeed against the same incumbent. A changed incumbent, stale quote corpus or corrected evaluation set requires re-evaluation. Model rollback restores a prior artifact and records why; it does not delete historical outcomes or alter the thresholds.

## Bounded agents

Allow tools for reading feed health, proposing an allowlisted feature hypothesis, submitting a deterministic evaluation job, retrieving artifacts and preparing a PR or proposal. Deny direct production promotion, secret access, arbitrary SQL, arbitrary shell strings and direct betting/brokerage execution. Use schema-validated tool inputs, per-run wall-time/token/cost budgets, candidate count caps and recorded tool-call IDs. Limits are operator configuration, not numbers that an LLM may revise.

The deterministic evaluator decides eligibility. An LLM explains the result and suggests the next bounded experiment; it does not generate the measured metric. If the model provider fails, data refresh, the app and scoring continue. Log provider/model/prompt hashes for reproducibility without retaining secrets or unnecessary private roster information.

## Release and rollback

Release separately: scoring/data fixes; UI composition; shared read adapter; durable store; live read API; proposal control plane. Keep compatibility readers for the transition. Use feature flags in public runtime configuration for UI/read-path selection only; keep sensitive credentials server-side.

Require the full NFL gate and relevant SelfLearning suites at the exact release commit, browser/PWA checks and current phone Safari validation. Pin Node/Python versions. CI must include the currently broken power backtest import path. A prototype DOM pass is not a production browser pass.

Before merge, reconcile main with concurrent data-cron commits, regenerate derived data when needed and verify the exact candidate again. Production deployment follows repository approval. Roll back the frontend by restoring the preceding known Netlify deploy or reverting the release commit; restore the previous data manifest/model pointer separately. Database changes use expand/contract and forward repairs; do not casually reverse an applied data migration.
