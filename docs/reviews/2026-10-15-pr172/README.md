# PR #172 integration review and bounded corrections

October 15, 2026, America/Chicago. Reviewed PR head `7afea959c5c91791e194354dc78fab51e7f9e728` against main `259a5d6b4fc26c0d0e505aa6e6dbfe08e0973dca` and the original checkpoint `c0d42358`.

The owner authorized review and fixes on the PR or a branch based on it. No merge to main or production deployment is authorized by this review. The [revision-2 handoff](../../WEEK6_CLAUDE_TO_CODEX_HANDOFF.md) and [Claude RCA](../../qa/RCA_2026-10-15_PARLAY_ACCURACY.md) remain the broader roadmap. Final command exit codes and the tested commit are reported on [PR #172](https://github.com/liddar12/NFL2026/pull/172).

## Current-data comparison

The offline diagnostic imports main and candidate code in separate interpreters and passes the same committed inputs into the real weekly and prop producers. It preserves each revision's actual Game-prop caller shape. Input and runtime-code hashes are recorded in [the evidence](evidence/eligibility_comparison.json).

On the October 15 main input generation (`2026-10-15T11:40:20Z`):

- Both versions withhold the same **31 players: 17 status and 14 depth**. No newly withheld or newly playable player was observed.
- Both produce the same **41 curated prop candidates**, **42 Game cards and 18 Week cards**. No candidate identity or model-probability difference was observed.
- The source is verified at that generation; no source-uncertainty refusal is added on the fresh input.
- The independent learning review rebuilt **1,088 MY rungs for 185 players** with zero added/removed/changed probabilities. Every new receipt validated; the live correction stayed disabled.

These are controlled input replays, not a new network regeneration of every projection. They reuse rounded committed Elo and prior component receipts and omit optional sportsbook quotes equally for both versions. They do not establish that every historical source fact was correct.

A separate bounded public-source observation at `2026-10-15T12:38:18Z` returned HTTP 200, provider timestamp `12:38:14Z`, 32 teams, 800 valid rows, zero quarantines and verified freshness. The original Oct 11–15 frozen-feed incident is historical; it is not the current feed state.

## Findings corrected during this review

| Priority | Reproduced behavior at the reviewed head | Correction |
|---|---|---|
| P1 | One unknown row identifying only SF made the entire report unverified, withheld 267 scheduled players and discarded valid shaping for other teams. | Quarantine resolves to the smallest defensible identity/team scope; known-team uncertainty remains local. Truly unlocated malformed evidence still produces an explicit global source refusal. |
| P1 | A matching unknown-status row and a duplicate understood OUT/IR row could simultaneously refuse the offer and create a medical zero; the projection/depth passes could reintroduce the conflicting status. | Exclude scoped medical inputs at both the actual second projection pass and weekly/depth boundary; retain independent inactives/depth facts and pre-existing history/fantasy inputs. Unknown participation is not a new measured absence. |
| P2 | An ID-less unknown row on a prior team escaped quarantine despite an unambiguous player-name match. | Canonical IDs remain authoritative; guarded name fallback and explicit ambiguous-name refusal match the consumer's mover semantics. |
| P2 | The checkpoint allowed 24-hour injury freshness while the agreed Week 6 KPI requires less than 12 hours. | Producer and independent validation now enforce the 12-hour boundary. |
| P1, inherited path | All props withheld made R126's low-input fallback return three renamed copies of one ML bet, or ML/spread/ML. One/two-game slates also received repeated filler. | A publication wrapper retains distinct contracts, preserves original IDs/order, and records exact infeasible counts. The protected R126 ranking functions are unchanged. Three remains the target when feasible; copies do not satisfy it. |
| P2 | PLAYERS' literal status map omitted RETIRED, so a gated zero-point headline said MATCHUP. | The weekly headline names RETIRED and explains the reason. A browser fixture covers JSON → weekly state → actual rendered headline. |
| P3 | Missing game identity suppressed exact risk correctly but the summary still asserted a verified shared game. | The display calls this a shared selection until game evidence exists. |

Limited current offers are explained in the Parlay UI. `candidate_coverage` describes the live candidate generation and is deliberately omitted from mixed frozen archives. Offline callers that never supplied props state that distinction instead of claiming medical ineligibility. A missing real engine fails clearly instead of switching to fabricated scaffold cards.

## Merge, test and data preservation

- R126 `build_game_parlays` and `_rank_game_pairs` are source-byte and AST-identical to main. Their source-segment SHA-256 hashes (excluding a trailing newline) are respectively `9c0679e159cb507228156ce08ff369820f9148565ffe3e36ece3922da3bd203c` and `8ca4e58499427b8629fe24f0e10967daad7b758bdb5eb925e1cfb765354e3f4c`.
- The initial `git diff 279a06e5...7afea959 -- tests/` review found no deleted/renamed test files, added skips, TODOs, focused-only tests or exit suppression. Updated assertions reflect RETIRED, legacy calibration warnings, receipt quarantine and the expanded scraper call. The review adds coverage rather than suppressing those cases.
- Count tests retain the three-card target, explicitly reject duplicate filler and missing/stale/forged shortfall metadata, and cross-check eligible props. The R108 fixture adds real prop candidates while retaining its original minimum-count assertion.
- At the reviewed head, all 2,253 checkpoint Week 6 MY cards remain unchanged; 618 later cards arrived from main. The review does not rewrite historical predictions, estimates, snapshots or outcomes.
- No model coefficients were refit on Week 5, TNF or any other result. Market prices remain outside model/ranking inputs. R102 postpublication CI and R106 archive protections remain in place.
- No current-data eligibility/candidate change was found, so the conditional requirement to repeat R126's historical replay was not triggered. The documented 59/188 → 72/189 replay remains a comparison on the union of on-card frozen legs, not a recovered complete original candidate pool. It is not independently upgraded into evidence of prospective accuracy by this review.

## Reproduce

Use a detached main checkout at `259a5d6b` and this review checkout. The diagnostic prints JSON and does not alter data or fit parameters:

```bash
python3 docs/reviews/2026-10-15-pr172/diagnostics/compare_eligibility.py \
  --repo /path/to/review-checkout --inputs-ref 259a5d6b \
  --control-tree /path/to/pinned-main-checkout --candidate-tree /path/to/review-checkout
```

Run one gate at a time. Verify that port 4321 serves this checkout rather than an older preview. The review replaced its own leftover checkpoint preview and verified the served JavaScript hash against the review file.

```bash
bash tests/run_gate.sh
npx playwright test --config tests/playwright.config.mjs tests/web/week6_risk.spec.mjs --project=web
```

Focused regressions are in `week6_availability`, `week6_retired_consumers`, `week6_thin_cards`, `week6_coverage_display`, `week6_portfolio`, and the retired/risk browser specs. Scalar probability parity and shared-event risk do not establish a calibrated joint player-prop model.

## Work that remains separate from integration acceptance

- **R130 / honest record:** implement the as-offered headline and separate settlement presentation. The handoff's target cohorts and push/void rules are unchanged; the old Week 1 16/18 is not a prospective score.
- **Lane B:** first-publication proof, card selection/joint-model stamps, immutable outcome revisions and display-key migration remain. Actual replay offered 840 already-known MY cards and appended **zero** receipt-bearing cards because their legacy keys already exist. This PR does not retroactively make those Week 6 offers learning-eligible. Use an append-only receipt journal; do not rewrite historical bases.
- **R131:** the owner still chooses the Week portfolio objective. The selector remains shadow-only; this review does not activate diversification.
- **Lane E:** candidate-count checks and matching timestamps are not immutable source-snapshot/generation proof. The complete prepublication semantic gate remains open.
- **R127, Elo and weather:** prop feature and weather studies remain shadow-only; truthfully reporting Elo k=20 remains a separate correction. No activation of k=25 or hindsight refit is included.
- **SelfLearning:** actual-producer parity, adapter documentation, idempotent persistence, outcome revisions and the controlled candidate-return/promotion/rollback boundary remain. Claude reported 233 tests plus 43 subtests on its branch; this NFL review does not claim a live shared-engine integration.

Statistical caution: overlapping-card Wilson intervals and trend tests are descriptive. Failure to reject a trend does not establish absence of deterioration. The engineering findings and unchanged-input comparisons do not guarantee a winning card count.
