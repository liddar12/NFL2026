# Codex takeover: PR #183 / #184 CI recovery

Revision R1 — October 20, 2026, 7:39 a.m. CDT (America/Chicago).

## Outcome and scope

Local recovery is prepared; **nothing was merged, deployed or activated**.
Checkpoint 2 remains paused, the lean pilot remains disabled/shadow/unwired,
engine `aacb19c73122f257449e977df40f2a2733991b2f` is unchanged, and #175 is untouched.
No generated data was hand-edited or rebuilt. Both candidate data trees exactly
match main `9fdd47a36299664efcc54bf4cf223e85fef19a1b`.

GitHub code publication is still blocked by the session approval policy.
The owner must push the local candidates from a normal permitted terminal.
No alternative write route was used. A source push only updates the existing
draft PRs and their previews; it is not an authorized merge or production release.

## Root cause: snapshots, not a clock-only flake

The failed runs were [#183](https://github.com/liddar12/NFL2026/actions/runs/39360745667)
and [#184](https://github.com/liddar12/NFL2026/actions/runs/39360764397).
The #184 runner checked merge tree
`f179787a8b342bdf606b110349b7543ada14d984`: PR head `5175bf49` plus main
`860ff675`. The local green PR checkout had older data.

At the Monday-night boundary all week-6 games had kicked off, so the app correctly
offered no new cards. Several tests wrongly required an upcoming leg, a new record,
or an unplayed review row. They failed on **unmodified main** too. Subsequently
main rolled to week 7; its old full feature suite passed again (2,179 passed,
2 existing skips). This is evidence of data-state-dependent tests, not proof the
old tests were fixed. Do not switch CI to head-only checkout to hide merge-data changes.

The four feature failures were:

- `r101d_my_td_parity.test.mjs`: first-sight recording expected a nonempty offer.
- `r87_my_cards_parity.test.mjs`: the real-data sweep required an upcoming game.
- `r90_slate_truth.test.mjs`: current week was assumed to contain unplayed games.
- `week6_learning_receipts.test.mjs`: the positive archive proof read live FINAL statuses.

Browser `r90_slate_truth.spec.mjs` had the same population assumption. It searched
review rows for an unplayed game; a closed slate legitimately has none, and
a future unplayed game need not have a pending review receipt.

## Bounded changes

Shared test fix: `019cf0576f4723bc4010f63e135d8d108895c0d1`.

- Keep every current-pool JS/Python card comparison. For an all-closed slate,
  require exactly zero offers; the independent nonempty toy sweep remains.
  Add explicit kicked-off and FINAL refusal cases at every dial.
- Make the ATD recorder proof unconditional with its existing small synthetic
  source. Both modes at both sizes must produce four positive top-card cases,
  first sight must record cards, repeat refresh must record zero, and closed
  phases must offer/record zero. The real-pool parity sweep remains separate.
- Build schema-valid, prospective synthetic inputs through the real pool builder
  for receipt/archive preservation. Retain adoption-policy, source/feature,
  schema-rejection and nonempty archival assertions; additionally require
  pre-kickoff locks and zero late/FINAL offers.
- Use a 23-line fixture for mixed, all-FINAL, and week-7 rollover slate states.
  Browser tests route predictions/schedule/review together and assert immutable
  locks versus recomputed numbers, unplayed forecasts with no review receipt,
  and navigation back to the fully graded prior week. No new skip was added.
- Correct the R3 wording and rerun the pinned-engine reproductions. Half-point
  lines avoid equality pushes, **not official VOIDs**. Threshold and settlement
  can still disagree. No engine equation, pin or settlement behavior changed.

The recovery changes production source and workflows in neither PR. PR #184's
existing shadow modules/config are unchanged from `5175bf49`.

## Exact verification

See [verification JSON](CODEX_CI_RECOVERY_20261020.json) for commands' source
identities, outcomes and log hashes.

| Check | Source | Exit | Result |
|---|---|---:|---|
| #183 full feature suite | `4695b17e87497faa219970b04dc4c09951fc86a9` | 0 | 2,184 passed, 1 existing skip, 0 failed |
| #184 full feature suite | `013a3c7940ac133923f59309eb309abef74dd450` | 0 | 2,196 passed, 1 existing skip, 0 failed |
| Four affected feature files, exact closed-week main plus recovery | `860ff675` plus shared fix | 0 | 29 passed, 0 skipped |
| Same focused files, week-7 main plus recovery | `9fdd47a3` plus shared fix | 0 | 28 passed, 1 existing skip |
| Core partition: schemas, smoke, four never-regress backtests | #184 source above | 0 | All six non-browser steps passed; **partial** acceptance only |
| Pinned engine R1/R2/R3 reproduction | #184 source above / engine `aacb19c7` | 0 | Executable threshold and explicit VOID assertions pass |
| Local browser R90 | Shared fix | 1 | **Environment blocked; 0 tests executed** |

Full feature commands:

```bash
node --test --test-concurrency=1 tests/feature/*.mjs
bash tests/run_gate.sh --partition core
```

Python 3.12.9 was selected from the existing local environment. Raw logs are
preserved at `/private/tmp/nfl-ci-recovery-20261020.iecFpC/`; hashes are recorded
in the JSON. The one feature skip is the pre-existing committed ATD sweep when
current data has no adopted ATD legs. Synthetic ATD parity and recorder coverage
still execute and require positive cases.

The direct browser attempt had installed dependencies/cached Chromium, but the
sandbox refused `http.server`'s socket bind. No alternate port or server workaround
was attempted. The fresh #184 core-partition checkout separately skipped its
optional browser step because dependencies were absent there. **Neither is a
browser pass, and no full gate pass is claimed.**

## Owner terminal and acceptance remaining

Local candidates:

- #183: `/Users/jliddar/code/NFL2026-pr183-ci-20261020`,
  branch `fix/pr183-ci-20261020`; push to existing
  `claude/practical-heisenberg-o9zg3m`.
- #184: `/Users/jliddar/code/NFL2026-pr184-ci-20261020`,
  branch `fix/pr184-ci-20261020`; push to existing
  `pilot/selflearning-lean-20261019`.

The source SHAs above are the tested commits; later commits add only this RCA
and JSON. Final publication SHAs are reported separately, avoiding self-reference.
Use personal process-only credentials and a **normal fast-forward push**, never
force. A concurrently changed remote must be reconciled and revalidated.
Keep both PRs draft until acceptance and owner direction. Leave the stray
`pilot/selflearn-lean-20261019` branch alone.

After pushing, require fresh core/features/gate/e2e on each updated PR merge
result. Inspect the actual checked-out merge SHA and exclusions/skips; a successful
Netlify preview is not CI acceptance. If main moves, compare the new source/data
and revalidate instead of overriding failed gates.

Codex owns continued diagnosis/review after the pushes; Claude credits are not
required. #183 may proceed to owner merge approval after acceptance. #184 stays
draft/shadow, and checkpoint 2 stays paused until explicitly resumed.
