# NFL reliability release: local acceptance

November 19, 2026, 9:08 a.m. CST (America/Chicago). Owner: Codex.
This is a local review checkpoint. No push, merge, deployment, migration or
prediction-changing activation is included in this evidence.

## Exact candidate and result

- Tested source: `3f38893237180e7392a88dddedd32cd348691a01`.
- Incorporated main: `539059eea490e8bcb2a270e5c33839929e25d0bd`.
- Local branch: `build/release-reconcile-20261118`.
- Full gate: exit 0 at 9:01:23 a.m. CST; all eight steps pass.
- Features: 2,337 passed, zero failed, zero skipped.
- Browser: 364 passed, zero failed, four existing data-dependent skips.
- Evidence: `code/evidence/nfl-release-validated-full-gate-20261119.log`.

The document commit following this source changes documentation only. The source
SHA above remains the full-gate subject. Exact-source GitHub CI and production
verification have not been performed for this local candidate.

## Problems corrected

The two owner-supplied November 18 Data CI alerts repeat the same five failures:
MY grading disagreement, referee coverage, offensive-line count, and two injury
browser fixtures. The November 19 run repeats four; newer provider data makes
the OL count pass without deploying its partial-coverage repair.

The release aligns outcome consumers to captured player identity, team and game
evidence; preserves unknown measurements and conflicting fixtures; adds missing
grading/receipt-retention checks before publication; and makes downstream checks
use the publisher's exact run-attempt SHA. Repeated diagnosed failures update one
incident summary while new or ambiguous failures remain visible.

Source gaps remain explicit. Optional referee-label coverage is reported by
season. A duplicate starting lineman does not become an invented fifth player.
Injury scenario tests use coherent schedule fixtures. Independently derived model
and market probabilities may round equally while provenance remains checked.
Bounded test workers avoid local subprocess contention without relaxing tests.

The last local failure was a reporting-validator mismatch: equal training counts
were interpreted as proof that identical receipts were consumed. The captured
review now validates game/lock eligibility and retains unknown consumption when
no refit receipt inventory exists. It does not authorize a refit or a learned
correction from a count or a capture-description string.

## History and correction evidence

All 302 checked receipt/ledger files, including 37 offer books, remain unchanged.
All 150 FINAL scores, 13 pending game locks, and 44 newer Week 11 offers are
preserved. Prior-publication grading validation compares 274,625 legs with zero
mismatches. The November 19 line report remains byte-identical to main.

Historical grading deliberately uses the retained November 18, 2:21 p.m. CST
capture; its clock is not relabeled as a new observation. Original offered terms
remain immutable. Nine MY and four ATD formerly void cards become pending because
the captured player/game identity conflicts with their offered event. A further
57 MY and eight ATD cards have corrected outcome fields. All transitions match
deterministic grading of retained evidence. These are grade corrections, not
evidence that prediction accuracy increased.

Evidence files:

- `code/evidence/nfl-release-validated-capture-replay-20261119.log`
- `code/evidence/nfl-release-validated-inventory-20261119.json`
- `code/evidence/nfl-release-validated-grading-transitions-20261119.json`

An independent bounded Codex review found no concrete regression in the captured
training-membership validator or publication checks. It performed focused
in-memory mutations and grading validation, not another full gate. Its checks
establish internal consistency; the report's capture label alone does not
authenticate the original bytes or prove a refit's receipt membership.

## Release sequence after authorization

1. Publish the tested release branch and run GitHub CI on its exact source.
   Keep any paired engine source reachable before changing a remote canary pin.
2. Check for newer main changes. Preserve new offers and ledgers; if data has
   advanced, rebuild through the capture/pipeline and revalidate the resulting
   candidate rather than copying older generated files over it.
3. Drain pre-fix publisher jobs before release. An already-running old helper
   cannot gain the new semantic check merely because main moved beneath it.
4. Merge through the owner's approved release procedure, rebuild from fresh
   inputs, then verify the exact published SHA and public app/data bytes.
5. Verify repeated daily/gameday refreshes, post-publication Data CI and incident
   closure. A local green gate does not close issue #202 in production.
6. Roll back by reverting source on a branch, rebuilding and checking the new
   candidate. Never reset main or erase offered history.

## Separate self-learning work

Historical NFL calibration is active in the last observed live pool. Shared
SelfLearning remains disabled/shadow and `live_adjustment` is null. This release
does not activate it.

The separate collection integration at `0dc93017` combines this release with
disabled forecast/publication/outcome clients pinned to engine `5e689539`.
Its 102 focused tests and both data validators pass, but that integrated tree
has not received a full gate. A durable run-attempt handoff is being added to the
existing Supabase journal and Vercel API; hosted migration state, restart
recovery, scheduled workers and real publication evidence remain release checks.

Collection may be enabled before recommendation corrections once its own hosted
acceptance passes. Accuracy adoption needs the same correction method evaluated
on frozen, untouched cohorts, with uncertainty, exclusions and fallback visible.
MY yardage evidence does not establish moneyline, anytime-TD or joint-card gains.

Supabase management currently reports healthy, but two schema-read methods
returned connector errors. The cause is not established. The local harness can
run Codex jobs; its Grok provider lacks `XAI_API_KEY`. Henry's separate cloud app
and service connections remain unverified. No Claude worker is assigned.
