# Week 6 handoff: Claude Code -> Codex (Astra)

Revision 2, 2026-10-15 (overnight run, owner asleep; revision 2 applies the second verification round). This answers `docs/CLAUDE_WEEK6_HANDOFF.md` on `build/week6-correctness-20261014`.

Read with:
- the Claude RCA, `docs/qa/RCA_2026-10-15_PARLAY_ACCURACY.md`, whose section 8 reconciles it finding by finding with the Codex RCA;
- the Codex RCA on `build/week6-correctness-20261014`, `docs/reviews/2026-10-14-week6-rca/`.

## 0. State at hand-off

| Item | Implemented | GitHub-merged | Production-verified |
|---|---|---|---|
| R125: ESPN "Reserve-Ret" mapped (feed unfrozen) | yes | `main` `99f6619a` (PR #166) | yes: `injuries.json` 800 rows, feed `ok` |
| R125 follow-up: injury-history vocabulary pins (data-ci #168) | yes | `main` `a8ef8d5e` (PR #168) | data-ci #169 green |
| R126: game cards ranked by joint probability; spread as fallback | yes | `main` `c2b272ac` (PR #169) | yes: daily #311 slate has 0 spread legs and cards ordered by joint probability; data-ci #170 green |
| Claude RCA + this handoff | yes | `main` (docs PR) | n/a |
| Codex checkpoint integrated with current main + 5 failures fixed | yes (local `astra-integration`, head `9292bcdd`, base `c0d42358`) | **no**: pushed to `claude/practical-heisenberg-o9zg3m` and opened as a draft PR right after this docs PR merges (section 2) | no |
| SelfLearning `build/nfl-feedback-contracts-20261014` | Codex's | no | no |

The owner authorized two kinds of merge tonight:
- **Week-6 accuracy fixes:** "fix to improve parlay accuracy, and then refit after the results of the Thursday TNF game ends as a backtest / validation".
- **The RCA/handoff docs:** "merge when CI is green".

The Codex checkpoint itself was **not** merged. Its own rules require independent review before merge or deploy, and it is 29k lines including evidence.

## 1. What Claude changed on `main`

1. **R125** (`scripts/availability.py`): `"reserve-ret": IR` plus selftest/test. This is **interim**; Codex's `RETIRED` supersedes it (section 2 resolves it on the integration branch).
2. **R125 follow-up** (`scripts/build_injury_history.py`): `OBSERVED_REPORT_STATUSES` gains `"Suspension"` and `"Reserve-Ret"`. The first fresh report carried 3 Suspension rows.
3. **R126** (`scripts/models/parlay_builder.py`):
   - `build_game_parlays` ranks by joint model probability via the new `_rank_game_pairs`.
   - The spread is a candidate only when fewer than 3 non-spread pairs exist.
   - This touches lines 879-947, plus docstrings at 317-319 and in `validate_data.py`; nothing near the checkpoint's `playable_this_week` change at line 731.
   - Tests: `tests/feature/r126_game_card_ranking.test.mjs` (new), plus edits to `r74_one_leg_per_side` and `parlay_props`.

## 2. Integration of the Codex checkpoint (done here, awaiting review)

Branch: `astra-integration` (head `9292bcdd`; base `c0d42358`). As of 2026-10-15T07:30Z it is local only. Right after this docs PR merges it is merged with current `main`, re-gated, pushed to the Claude session branch `claude/practical-heisenberg-o9zg3m` and opened as a **draft PR**: the open draft PR from that branch is the one to review. Contents:

1. **Merge commit:** `main` (through R125 follow-up + data) merged into `c0d42358`. One semantic conflict, resolved deliberately:
   - Both sides added a `"reserve-ret"` dict key. Python keeps the last, so IR silently won and the two selftests contradicted each other.
   - **Resolution:** RETIRED stays; the R125 IR line and its asserts are removed; `availability.test.mjs` expects RETIRED.
2. **Known failures 1-2** (commit "classify RETIRED in every availability consumer"):
   - `build_injury_history`: RETIRED joins `REPORT_IGNORED` (never an injury label; R125 pins kept).
   - `build_line_report`: RETIRED added to `OUT_CODES` and the severity order.
   - `player_projection`: `_INJURY_STATUS[RETIRED] = (0.00, 1.00)`, explicit, no weight change.
   - New `week6_retired_consumers.test.mjs`.
3. **Known failure 3** (commit "MODEL shows the producer's chronology warnings"): `app/views/model.js` reads `chronology: {invalid_timestamps, latest_conflict}` through a new exported `chronologyWarnings()`. A test in `week6_reporting.test.mjs` fails without the change.
4. **Known failure 4** (commit "r87 record line reads the honest cohort presentation"):
   - The two assertions now expect "legacy calibration cohort not verified".
   - A new **independent denominator** test checks that the cohort prints its own `n` (250), never the graded count (320), and that an empty cohort says so.
5. **Post-R126 merge** (`ae2b899e`, `4d88f08d`, `9292bcdd`), a fifth failure beyond the four known ones:
   - `injuries.json` regenerated under availability vocab 2 with the new `python3 scripts/availability.py --reenrich PATH` (800 rows, 0 row changes; smoke REL17 requires the file's `vocab_version` to equal `VOCAB_VERSION`).
   - r70's source check failed against the widened `fetch_injuries` call (`quarantine_unknown`, `return_document`) and now accepts it; `carry_positions=True` is still required.
   - `main` through R126 and the RCA docs merged in; `injuries.json` re-run through `--reenrich`.

Gate results on the integration head are in the draft PR. The run order is:

```
bash tests/run_gate.sh
npx playwright test --config tests/playwright.config.mjs tests/web/week6_risk.spec.mjs --project=web
```

The PR body reports exit codes and confirms the browser spec actually executed tests.

## 3. What Codex needs to complete (in priority order)

Each item lists the acceptance test. Do it on top of the integration PR, not on the old checkpoint.

1. **Review and decide the integration PR before TNF** (2026-10-16 00:15Z, 7:15 p.m. CDT).
   - Look in particular at the availability withholding behaviour on the **current** week-6 data. Regenerate in a scratch workspace:
     ```
     python3 scripts/build_predictions.py
     ```
     with network access, or replay the committed inputs.
   - Compare the candidate slate: which players and legs it withholds, and why.
   - Acceptance: no player is withheld on a fresh, `ok` feed except for a documented eligibility reason. Unknown statuses quarantine the row, never the whole feed.
   - Merging needs owner authorization (production deploy).
2. **Re-run R126's replay** after any eligibility change that alters candidates. The R126 ranking must still match or beat the R74-consistent |rho| control in each of weeks 2-5 on the frozen pre-kickoff candidates (currently 59/188 -> 72/189: 12->20, 20->21, 14->16, 13->15). Week 1 predates R74 and is reported separately.
3. **Lane C (honest record), Claude roadmap R130:**
   - a pre-kickoff-only headline;
   - push winners and reduced-leg settlements reported separately;
   - void legs out of the leg denominator;
   - a `post_kickoff` flag on late exclusions.
   - Acceptance: the headline is the as-offered cohort (RCA section 10 method: push winners counted, voids out of the denominator), weeks 1-5 = 17/66, 13/66, 21/66, 22/65, 14/63. A separate settlement view shows the archive's week 5 as 1 full + 3 reduced + 19 losses on 23 week cards (16/65 incl. push). Week 1 cannot show 16/18 as prospective.
4. **Lane B remainder:**
   - first-publication evidence;
   - card-level selection/joint-model versions (R126 is a new selection policy, so stamp it);
   - outcome-revision persistence;
   - display-key migration.
   - Do not reconstruct historical bases.
5. **Lane D:** compare highest-hit vs diversified on frozen candidates (Game, Week, MY). R126 settled Game-card ranking under highest-hit; Week cards remain the open objective question for the owner (R131). Never duplicate filler; enforce caps or report infeasible.
6. **Lane E:** a prepublication semantic gate bound to the exact generation (freshness, eligibility, once-only calibration, joins). Keep R102 post-publication CI and R106 archive protection.
7. **R127 train/serve prop feature.** Shadow the training-shaped feature on week 6.
   - Evidence: live log loss 0.6293 vs 0.6598 on 212 legs.
   - Promote only on prospective evidence, with no per-position regression.
8. **Elo k.** Report k = 20 truthfully; do not activate 25 to match metadata.
9. **SelfLearning:**
   - The branch passes its CI-equivalent suite in a clean venv: `pip install -e ".[dev]"` then `pytest -q`, 233 passed + 43 subtests, and the walk-forward demo is clean. Bare `unittest` without pytest shows 7 import errors; that is environment only.
   - Remaining:
     - actual-producer parity against `scripts/learning_receipts.py` output;
     - `docs/nfl-adapter.md`;
     - idempotent persistence and outcome revisions;
     - the controlled candidate-return boundary with NFL promotion and rollback.
   - Keep NFL rules in the adapter.
10. **Weather:** persist issue/receipt time, full game window and roof state. Missing rain is unknown, not zero. Shadow only.

## 4. Things Claude deliberately did NOT do

- **Merge the Codex checkpoint.** It needs review.
- **Change the week-card objective.** The owner prioritizes the highest chance of hitting, and diversification lowers expected winners (Codex: 6.33 -> 4.56 under a 9-of-18 cap).
- **Floor props at p >= 0.5 or offer unders.** That needs grader support and would break 3-cards-per-game on 10 of 14 week-6 games; it is R128.
- **Refit any coefficient on week-5 or TNF outcomes.** No hindsight fit.
- **Touch the SelfLearning repository.** It is outside this session's push scope.

## 5. Scheduled follow-ups (Claude)

- **2026-10-16 12:00Z:** post-TNF look at R126 against the old-policy control (the old rule on the pre-kickoff candidate legs, spreads from `data/estimates/parlays_2026.json`; reference slate `bb6ae6ed`), recorded in the RCA. One game decides nothing and refits nothing.
- **2026-10-20 13:00Z:** full week-6 look. Week 6 starts the prospective record but cannot by itself confirm or refute a 1.6-card lift; keep or revert is decided on the pooled paired difference over weeks 6+ (RCA section 7), with a multiple-choice question to the owner before any further accuracy change.
- **Standing refresh routines** (morning/evening daily, Mon/Thu/Sun pre-kickoff gameday) continue. Each checks data-ci and fixes red per the standing order.
