# Claude handoff — NFL2026 R82 review

Read [the full RCA and code review](CODEX_REVIEW_R82_FOR_CLAUDE.md), then [the evidence bundle](../reviews/2026-09-17/README.md).

## Owner request and baseline

Review UI/UX, data, pipelines and AI/self-learning, prioritizing **Parlay → Slate → Players**, and prepare this report for Claude. The owner selected latest main/R82 when the requested `docs/RCA_MYPARLAYS_CARDS.md` was not present. The review is pinned to `886b5bb40e68e90f6074489723fbe4c3703c0935`; compare against current main before acting.

This handoff authorizes no implementation, push, deployment, data mutation, new service, or promotion-policy change by itself. The work performed was the review and local report preparation.

## What to take away

R82's layout repairs are present and their tests pass. The next improvements should establish what the numbers mean and whether they describe the same event, price, model version and prediction cutoff across the product.

Most consequential findings:

1. **F01–F03:** MY loses game-side identity; mixed-game cards drop within-game correlation; multi-leg joint probabilities depend on leg order.
2. **F04–F06:** fair/synthetic probabilities are treated as executable prices, provenance is lost, and MY/review quote different payouts for the same assumed legs.
3. **F08–F13:** game locks lack a kickoff guard; game refit is not chronological and does not replay the effective production model; a successful refit drops other parameters; historical cards can describe different predictions from the ones graded.
4. **F14–F17:** session caches never age, a stalled optional feed blocks navigation, Git retries cannot resolve divergence, and gameday does not refresh the same dependency graph as daily.
5. **F18–F23:** mobile cards start below a large control/glossary wall; MY rejects its own abbreviated example; review interaction needs keyboard support; optional narrative validation is weak; confidence tiers need honest labeling; MY should survive curated-feed failure.

The full report contains **23 findings**, each with code references, evidence, risk, recommended repair, acceptance criteria and initial LOE. It also includes a phased roadmap, a data-contract design and an assessment of the actual learning mechanisms.

## Verification already completed

- Data validation, smoke tests and all four model gates passed.
- **1,685 feature tests passed.**
- **279 browser/PWA-emulation/performance tests passed.**
- Separate read-only JS/Python probes reproduce the findings in their saved outputs.
- Mobile/desktop screenshots and a delayed-feed navigation reproduction were recorded.

The first full gate log has an environmental browser startup failure; the successful browser rerun is separate. Local versions differ from CI (Node 26.7.0/Python 3.12.9 vs CI 22/3.11). No actual iOS Safari or production feed/deployment audit was performed. Passing these tests does not invalidate the uncovered defects: some tests enforce the defective contract, and parity tests compare two implementations of the same rule.

## Constraints to preserve

- Vanilla JS ES modules/PWA, no bundler or framework migration.
- Python stdlib and Node built-ins for the fast gate.
- Sportsbook prices remain separate from model predictions and fitted weights.
- No invented values: unavailable is not zero; assumed is not quoted; simulated is not realized.
- Preserve the documented owner choice to price and label QUESTIONABLE players.
- Preserve the explicit player scenario override and visible gated comparator.
- Preserve proposal-only game/player signal promotion; expanding auto-adoption needs a separate owner decision.
- Do not lower never-regress margins to obtain adoption.
- Preserve immutable records; no force-push or blind data conflict overwrite.

## Suggested first implementation brief, if separately authorized

Start with a small Parlay correctness change: preserve event/side/provenance through Python → JSON → JS and repair mixed-game grouping. Add source-shaped tests using the committed BUF/Goff example plus a two-event mixed card. Separate this from the pricing/joint-model redesign unless the contract needs a coordinated change. Then contain unquoted EV/payout claims before adding new bet types.

Recommended partitions and dependencies are in the full report; treat phase estimates as initial planning ranges, not exact promises. For every code change, first reproduce the finding, add meaningful behavioral regression coverage, run the repository gate and browser suite, review the final diff, and only deploy when explicitly authorized.

If a product decision is actually needed, ask **one question at a time**, with multiple choices, a recommendation, risk and LOE. Do not ask the owner to repeatedly approve routine read-only investigation or already authorized steps.

## Copyable starting prompt

> Read docs/qa/CLAUDE_HANDOFF_R82.md and docs/qa/CODEX_REVIEW_R82_FOR_CLAUDE.md in /Users/jliddar/code/NFL2026. Compare current main with the reviewed SHA 886b5bb40e68e90f6074489723fbe4c3703c0935, reproduce the prioritized findings using docs/reviews/2026-09-17, and use the report to prepare the next concrete implementation scope in Parlay → Slate → Players order. Preserve the documented architecture and owner decisions. Ask any necessary product questions one at a time with multiple choices, a recommendation, risk and LOE. Do not infer implementation or deployment authorization from the review alone.
