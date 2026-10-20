# Lean self-learning pilot — Claude → Codex handoff

Branch `pilot/selflearning-lean-20261019`, cut from NFL2026 main `c13a80ea` (2026-10-19).
Engine pinned: SelfLearning `aacb19c73122f257449e977df40f2a2733991b2f`.
**Learning stays disabled. Serving mode is shadow. Production behavior is unchanged.**
Nothing here is wired into a workflow, a pipeline script or the app. There are no migrations,
model adoption or activation; each needs a separate owner approval.

Owner direction, 2026-10-19: lean, self-contained modules on a fresh branch from main. #175 is
left untouched; its compatible contracts and builders are reused without merging its history or
fixtures. There are three checkpoints, and each is handed to Codex before the next expands.

## Checkpoint 1 — official inactive confirmation + T-90 withholding (shadow)

| | |
|---|---|
| Exact commit | the head of this branch when this file was added; it is reported separately in the PR, because a file cannot name its own commit |
| New | `scripts/inactive_confirmation.py`, `config/selflearning_pilot.json`, `scripts/pilot_config.py` (adapted), `tests/feature/pilot_inactive_confirmation.test.mjs`, `docs/pilot/*` |
| Changed production files | **none** |

### Behaviour

Each player is classified per game, at a given check time:

- `provisional`: before T-90 (kickoff − 90 min). The existing injury and depth gates still apply upstream.
- `confirmed_active`: in [T-90, kickoff), a **valid official** list names him among the game-day actives.
- `confirmed_inactive`: in [T-90, kickoff), a valid official list names him among the inactives.
- `unknown_or_stale`: the default in the window. An empty, failed, expired, unregistered or contradictory feed lands here.
- `closed`: at or after kickoff.

Only `provisional` and `confirmed_active` rungs are offerable. Withholding at T-90 is automatic.
Only valid confirmation restores a rung, and only while its 15-minute lease holds.

A valid official list must meet every rule below. Each rule is a named refusal, and each has a test:

- a source profile that is a string (`source_profile_malformed` otherwise);
- not an observation-only profile. This is checked **before** the registry, so an observation-only
  profile never confirms, even under a registry that lists it by mistake and even when the record
  is otherwise complete (`observation_only_source`);
- a registered source profile;
- an exact game identity: game_id, home, away and the literal kickoff string;
- a team that plays in the game;
- posted and fetched inside [T-90, kickoff), not in the future, and within the lease;
- `complete is True`;
- non-empty inactive *and* active lists;
- canonical, unique, disjoint numeric ids;
- a raw-evidence sha256.

If two valid lists disagree about a player, he stays unknown.

Malformed input never raises. A non-dict game, player, evidence record or evidence map, a
missing kickoff, a non-ESPN player id or non-list rungs each produce a named state for that
player (`game_malformed`, `kickoff_unknown`, `player_id_not_espn`, `game_unknown`) or a
`malformed_players` count. Every other player in the pool is still assessed.

### No usable confirmation source exists today, so nothing is withheld in production

`OFFICIAL_SOURCES` is **empty**. ESPN's core-roster `didNotPlay` flags (main's `fetch_game_inactives`)
are registered as *observation-only*: they are recorded but never confirm. Evidence:
[`espn_inactive_probe_20261019.json`](espn_inactive_probe_20261019.json), probed about 14 h before WAS@SF kickoff.
- ESPN already marked 7 players per team `didNotPlay`, hours before the official lists are posted.
- It omitted Deebo Samuel, who is ruled OUT in the injury report.
- The roster shape is identical before and after posting. It carries no posting flag or time.

Consequence: if the module were enabled today, every player inside T-90 would be `unknown_or_stale`
and withheld. Per the owner, it is **not** enabled. Permanent T-90 withholding must not reach
production until two conditions hold: a usable official source exists and is registered, and the
owner approves the rollout.

**Decision needed (owner):** choose an official inactive source to register. Candidates:
- a licensed feed with a posting timestamp and complete active/inactive lists;
- parsing club or NFL inactive announcements, with retained raw bytes.

#175 estimated the adapter at 6–10 focused hours plus a runner canary.

### Acceptance evidence

`node --test tests/feature/pilot_inactive_confirmation.test.mjs`: 14/14 pass. The tests lock:

- The clock: T-90 − 1 s is provisional; T-90 and kickoff − 1 s are unknown without evidence; kickoff is closed.
- Confirmed active, confirmed inactive and not-listed outcomes from valid evidence.
- 21 named refusal cases, each leaving the player unknown.
- The lease: exactly 15 min confirms; 15 min + 1 s does not.
- Conflict, and the other team's list never applying.
- On the **real** committed `data/leg_pool.json` inside a game's window, with the production
  registry, nothing confirms and every rung in the window is withheld. ESPN evidence is refused
  as `observation_only_source`.
- ESPN `data/inactives.json`-shaped observations never confirm, even if the profile were registered by mistake.
- An enriched ESPN record (complete, both lists, digest, in-window clocks) under a registry that
  lists the ESPN profile is refused as `observation_only_source`. As a control, the same record
  under a registered official profile confirms.
- `source_profile` values of `[]`, `{}`, `None`, numbers and booleans are refused as
  `source_profile_malformed`, not raised.
- `assess()` is total. A player with no kickoff (ESPN and non-ESPN) is `kickoff_unknown`, a
  malformed id is `player_id_not_espn`, junk rows are counted in `malformed_players`, and a
  confirmed player in another game is still `confirmed_active` and kept by `withhold()`.
  A non-mapping `evidence_by_game` is treated as no evidence.
- A fuzz over every evidence field × nine JSON types raises nothing. The only substitutions that
  still confirm are the fixture's own values (`complete=True`, inactive list `['111']`).
- `withhold()` is pure.
- The pilot config is disabled, in shadow serving, and pinned to aacb19c7. The reader refuses a
  live mode, the old profile, a half override, extra keys and a short SHA.
- Production is unchanged: no file under `.github/`, `app/` or `scripts/`, nor `index.html`,
  references the pilot modules.

Mutation check. The suite fails when any of these is introduced:
- accepting empty lists;
- registering the ESPN profile;
- removing the lease check;
- an off-by-one at T-90;
- checking the registry before the observation-only list;
- removing the `source_profile` type check;
- removing the non-dict guard for the game, for players or for `evidence_by_game`;
- removing the `player_id_not_espn` reason.

Full gate on this branch: see the PR for the exact command and result.

### Reused vs replaced from #175 (3ea2a227)

| #175 component | Here | Why |
|---|---|---|
| `period_freshness_policy.PROFILES` constants (T-90 = 5400 s, observation lease = 900 s) | **Reused** (values inlined) | The same policy numbers keep both branches comparable |
| `pilot_config.py` | **Adapted** | Same strict reader. Keys narrowed to version/enabled/engine_commit/freshness_profile/serving_mode, `serving_mode` pinned to `shadow`, engine pin aacb19c7, new profile `confirmed_inactives_v1`. `authority_id`/`actor_ref` belong to #175's owner-authority stack, which stays there |
| `my_freshness.py` hold rule (`held = … or generated >= checkpoint`) | **Replaced** by `inactive_confirmation.player_state` | #175 has no confirmed states, so after T-90 nothing can restore a rung. Its freshness step also runs whatever the pilot flag says |
| `my_freshness` QB depth gate (`_depth`), 12 h source age | **Deferred** | Out of scope for checkpoint 1. Main's existing depth gate is unchanged |
| `app/pool-learning-status.js` `selectedFreshness` | **Deferred to checkpoint 3** | The UI is wired only once a served document exists. There is no UI change now |
| `scripts/publish_data.sh`, `scrape/espn.py`, `build_weekly.py`, `build_predictions.py`, `validate_data.py` from #175 | **Not taken** | Main's versions are newer: branch-safe publisher, inactive parser integrity, weather/venue, review join |

Planned for checkpoint 2 (not in this commit): **reuse as-is** #175's `learning_journal.py`,
`export_learning.py` and `capture_outcome_evidence.py`, plus `tests/fixtures/week6_outcomes.py`.
The engine's `nfl_generation`, `nfl_capture_evidence` and parity tests already verify these
formats. **Adapt** `run_parlay_feedback.py` (aacb19c7, optional `snapshot_profile`) and
`learning_history_guard.py`. **Defer** the hosted intake, publication gates, period calibrator
and `build_learning_outcomes.py`, because the engine grades from raw bytes itself.
Main's `scripts/learning_receipts.py` is byte-identical to #175's, and main already stamps a
`learning_receipt` on every MY rung.

### Engine contract gaps at aacb19c7 (minimal reproductions; nothing changed)

`SELFLEARN_CORE=<SelfLearning>/packages/selflearn-core python3 docs/pilot/engine_gap_repros.py`
writes the output in [`engine_gap_repros_aacb19c7.json`](engine_gap_repros_aacb19c7.json).
It uses only the engine's own fixtures at the pinned SHA.

Owner classification (2026-10-19):

| | Classification | Finding at aacb19c7 |
|---|---|---|
| **R1 z sign** | **Documentation correction; no equation change.** | `schemas/sports/nfl_parlay_leg.schema.json` documents `z = (line - mu)/sd`. `adapters/nfl.py validate_nfl_receipt` enforces `(mu - line)/sd`, and so do NFL's producer and validator (real data: mu 197.95, line 124.5, z +0.958). A receipt built to the schema text (correctly resealed) is refused with `base_feature_parity_mismatch`. The fix is to correct the schema description in the engine, reviewed separately; the engine stays pinned at aacb19c7 meanwhile. |
| **R2 final status** | **No NFL blocker demonstrated; unresolved games remain visible and ungraded.** | NFL and the engine agree on final = `STATUS_FINAL`, `STATUS_FINAL_OVERTIME`. A POSTPONED, CANCELED, SUSPENDED or `STATUS_FULL_TIME` game yields 0 revisions (withheld `game_not_final_with_complete_scores`). The evaluation keeps its forecasts visible (`captured_forecast_n` 2, `cohort_n` 0) without grading them. |
| **R3 push / official VOID** | **Real settlement gap.** Pushes and VOIDs must remain *visibly unresolved*. They must not silently become losses or disappear from evaluation. This must be resolved and tested before any claim of complete settlement support. | Executed cases; the script asserts each and exits non-zero on a change. **(a) Prediction threshold, file path:** the engine's own journal at lines 79.5 / 80 / 80.5 with an observed 80 grades hit / hit / miss. actual == line is a **hit**, which is correct for an `over`/`gte` threshold. An integer line is **not** reinterpreted as a push, and it should not be. **(b) Settlement rule, resolution layer:** an explicit `push` or `official_void` input resolves as `VOID` with `hit = null`. The scorer reports it as `excluded.not_final_binary_outcome = 1`, with n 0 and hits 0: visible, not a loss, not dropped. A binary-hit control scores n 1, hits 1. **(c) The gap:** `bind_capture_labels(journal, capture_envelope, raw_chunks)` has no settlement parameter, and it emits only `did_not_play`. If a book settled a leg as a push or a league voided it, the file path would grade it by the threshold rather than leaving it `VOID`. The fix is an explicit, sourced settlement input on the file path that produces (b). It must not be inferred from integer lines. In the historical 2026-10-19 snapshot, all 1,231 rungs were x.5: that avoids equality pushes only. Official VOIDs can still disagree with threshold grades on half-point lines. The sourced-settlement gap remains unresolved, and complete settlement support is not claimed. |

### Codex review corrections (2026-10-20)

| Finding | Correction | Locked by |
|---|---|---|
| #183: the reference lookup rejected a legitimate legacy match (an id-less same-team row plus another team's id row) | `referenceLookup` now mirrors `availability.resolve_report` step by step. Conflicting ids are scoped like the producer: only same-team rows count when a same-team name match exists | The Codex parity case and three neighbours; a parity test that agrees with the producer on all 300 committed pool players |
| #184: malformed inputs crashed | Named refusals and per-player states; unaffected players are still assessed (see Behaviour) | The `assess()` totality test, the `source_profile` test and the field × type fuzz |
| #184: "ESPN never confirms" depended on the registry | Observation-only profiles are refused before the registry check | The enriched-evidence test with a leaky registry, plus a registered-official control |
| R3: evidence was source-string searches and a hard-coded conclusion | Executed engine cases separating the prediction threshold from settlement rules (table above) | The assertions in `engine_gap_repros.py` |

Checkpoint 2 was paused at the checkpoint-1 handoff. The owner resumed its build
on 2026-10-20 with learning explicitly disabled; see the checkpoint-2 addendum below.

### Rollback

Checkpoint 1 changes no production file. Rolling back means closing the draft PR or deleting the
branch; nothing deployed needs reverting.

### Next (after Codex review of checkpoint 1)

Checkpoint 2: capture predictions and receipts before kickoff, using the reused journal/export.
- Quarantine invalid documents before submission, recording the exclusion reasons.
- Keep raw captures immutable; the engine owns grading, superseding and idempotency.
- The runner targets aacb19c7 and runs engine `prepare`/`evaluate` after the fact without backdating.
- Records are git-backed under `data/snapshots/` and go through main's publisher unchanged.

Checkpoint 3: integration acceptance, covering repeated refreshes, stale/missing feeds, kickoff
boundaries, retries, duplicate outcomes and browser behaviour.

## Checkpoint 2 — Codex build, 2026-10-20, America/Chicago

Owner authorization: **resume checkpoint 2, keep learning disabled**. This is a local
review candidate, not merge, deployment, workflow or model-adoption authority.

- Branch: `build/lean-checkpoint2-20261020`; isolated checkout
  `/Users/jliddar/code/NFL2026-lean-checkpoint2-20261020`.
- Reconciled checkpoint-1 head `72644df1` with merged main `7d9bb8e5` using a
  conflict-free merge. Main's newer generated data was preserved, not regenerated.
- Functional source: `30ff2360feef7981db748418483c1c329aa0928b`. Later commits only
  update this handoff and verification evidence. Engine remains exactly
  `aacb19c73122f257449e977df40f2a2733991b2f`, unmodified.
- #175 and its checkout are untouched. The existing pilot config and inactive
  module are unchanged: `enabled=false`, `serving_mode=shadow`, no official source.

### Implemented boundaries

The old branch's `learning_journal.py`, `export_learning.py`,
`capture_outcome_evidence.py` and 92-line `tests/fixtures/week6_outcomes.py` are
reused byte-for-byte from `de7e93c0`. No old publisher, workflow, calibrator,
prediction builder, hosted intake or database adapter is imported.

`scripts/pilot_capture.py` is a new, standalone offline capture command. Default
execution previews without writes. `--execute` requires an explicit workspace
outside the source checkout and inputs. It owns the real clock, exposes no
historical `--as-of`, rejects future/malformed generation clocks before persistence,
and quarantines bad receipt rows with counts and reasons. Immutable retries keep
the original capture, including an offered cohort replayed after kickoff.

Its default cohort is **eligible MY prop rungs**, not published WEEK/GAME cards,
the newer browser-built cards, placed bets or authenticated public publication.
No offered-card cohort is invented. A producer can supply exact offered records
through the library later; that future pipeline integration is not wired here.

`scripts/run_parlay_feedback.py` independently invokes the pinned engine's
`prepare` and `evaluate` on the frozen source graph and raw outcome captures.
The engine, not the producer, grades thresholds and appends superseding revisions.
Repeated captures do not add forecasts or revisions; corrected measurements append
history, and retrying an older capture does not roll back the correction. Late
imports remain visibly late, never relabeled as prospective.

The runner requires the exact clean engine checkout/import identity and a separate
workspace. It persists completion last, checks bounded full state ancestry and
retained import clocks, and refuses missing/rewound completion pointers. Explicit
push/official-VOID settlement inputs are refused **before grading or state advance**;
the refusal labels settlement support unresolved. No push is inferred from an
integer threshold. Without sourced settlement integration, its outcome basis is
`threshold_observations_not_sportsbook_settlement`, not sportsbook P&L or settlement
accuracy. R3 remains an activation blocker for settlement-based learning.

`scripts/learning_history_guard.py` now uses its own bounded stdlib Git reader,
without `generation_capture_runtime` or the #175 owner-authority stack. It checks
committed append-only evidence; it is not wired into publication and does not
authenticate publication, approvals or input observations.

The checkpoint-1 isolation test now allows only eight explicitly named standalone
pilot tools to reference one another. It still rejects **all workflow, existing
producer and app references**. No production caller or live selection path changed.

### Local evidence and limitations

- Focused producer/capture/runner/inactive suite: **53 passed, 0 skipped**, exit 0,
  with `SELFLEARN_CHECKOUT` pointing to the exact pinned engine. Includes actual
  producer → raw capture → engine integration, corrections, retry/crash recovery,
  unsupported settlement refusal, full ancestry and source-identity guards.
- Core partition: exit 0, `GATE PARTITION core RESULT: PASS (partial checks only)`.
  Its optional browser step was skipped because this worktree has no browser
  dependencies. No local browser pass or full-gate pass is claimed.
- Full feature suite on Python 3.12.9: **2,238 passed, 0 failed, 0 skipped**,
  exit 0. The same source passed the core partition and all 53 focused tests.
  The first full run accidentally selected macOS Python 3.9.6: 2,237 passed,
  1 failed because the existing R87 scanner needs `sys.stdlib_module_names`
  (Python 3.10+). No scanner assertion was changed. Source/log identities and
  that failed attempt are preserved in `CHECKPOINT2_EVIDENCE_20261020.json`.
- Independent review reproduced two wrapper bugs (offered replay after kickoff,
  and a future generation poisoning the graph). Both were fixed with acceptance
  tests before the functional source commit; final review reported no remaining
  reproducible P1/P2 finding in the reviewed capture/runner paths.
- Real Week-7 local canary: **978 candidate rungs, 976 captured/imported before
  kickoff, 2 explicitly quarantined, 0 outcomes, cohort 0, adoption gate false**.
  Repeating the engine run preserves the same state ID and adds no revisions.
  This proves prospective capture only, not accuracy improvement or settlement.
- Both exclusions are one-ULP base-probability differences under macOS:
  Raheim Sanders rushing 19.5 and Christian Watson receiving 49.5. Each stored vs
  reconstructed base differs by `5.551115123125783e-17`; z and 4dp served prices
  match. Existing NFL and pinned-engine validators demand exact base equality.
  Cross-platform `math.exp` variation is suspected, not Linux-verified. No equation,
  tolerance, receipt or served data was changed to force acceptance.
- Local `--execute` feedback CLI refuses on macOS because its Linux address-space
  ceiling cannot be enforced. Library integration reports
  `controller_limits_applied=false`; it is not a CLI resource-canary pass.
  A supported Linux CLI canary remains required before scheduling the runner.

Raw local evidence is in `/private/tmp/nfl-lean-checkpoint2-evidence-20261020.lAiZfk/`;
the isolated real-data store is
`/private/tmp/nfl-lean-checkpoint2-canary-20261020.w9cREf/`. Neither is served or
automatically published. The latter contains immutable real forecasts, not outcomes
or proof that a viewer saw them.

### Commands and next acceptance

```bash
# Safe, offline previews; neither command writes or calls a provider.
python3 -B scripts/pilot_capture.py
python3 -B scripts/run_parlay_feedback.py

# Explicit prospective capture into a NEW, separate local workspace.
python3 -B scripts/pilot_capture.py --execute --workspace /private/tmp/nfl-shadow-example

# Supported Linux only: pinned offline feedback, no automatic outcome retrieval.
python3 -B scripts/run_parlay_feedback.py --execute \
  --data-dir /private/tmp/nfl-shadow-example \
  --engine-checkout /path/to/clean/pinned/SelfLearning
```

The feedback runner deliberately has no fetch option. Raw outcome capture remains
an explicit separate operation in the reused capture tool; its source URLs and
observed bytes/clocks are retained and independently verified by the engine.

Next: publish the exact local candidate to the existing #184 draft (normal
fast-forward only), require fresh hosted core/features/gate/browser checks on its
current-main merge, and execute a Linux bounded-CLI canary with the exact engine.
Hosted default CI lacks an engine checkout: its engine integration cases explicitly
skip and **must not** substitute for the exact-engine acceptance above.

Checkpoint 3, an official inactive-source decision, source-publication evidence,
settlement integration, scheduled production capture, and any model adoption remain
separate. In particular, no fit on week-5/TNF outcomes and no activation is authorized.

Shared-engine follow-ups belong in **SelfLearning**, not an NFL-only equation
fork: a reviewed cross-platform numeric-parity contract, sourced settlement
support for R3, and the R1 schema-description correction. Keep the current exact
pin and quarantines until separately tested engine changes are reviewed.
