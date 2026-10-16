# Injury identity join and validator RCA

Revision 1 · October 16, 2026, 9:24 a.m. America/Chicago (CDT).
Local candidate only; no push, data regeneration, deployment or accuracy claim.

## Confirmed failure

Pinned NFL main `0d49a94868142b4e6e888b927363d42270ed23c0` contains a
canonical OUT report for ESPN athlete `3126486`, named “Deebo Samuel Sr.”.
The corresponding weekly `espn-3126486`, named “Deebo Samuel”, has no
availability/eligibility/this-week block and retains 10.77 projected Week 6
points. The source row and weekly output refer to the same explicit identity
and SF team; display-name drift broke the legacy name join.

This is a demonstrated Week 6 eligibility defect. It does not establish a cause
or numerical counterfactual for Week 5 losses.

| Evidence at the pinned revision | Git blob |
| --- | --- |
| Original injury report | `8bfc1db66a4822483c6441d7c64690093b67a54d` |
| Original weekly output | `250699dc6a13fac318bfd8b785b81d691a96fc24` |
| Original leg pool | `e12f2b92b5ea2a3f38df2697dce175f66dd651b9` |
| Retained MY archive | `d3ff4124b25761f9d4fef74d0f332ab61650cd0b` |

The pool generated at `2026-10-16T01:58:13Z` contains seven priced receiving-yard
over rungs for this player, lines 19.5–79.5. Each receipt input context has null
availability, eligibility and this-week fields. That is direct downstream
candidate contamination, not merely a hypothetical predicate failure.

The retained MY archive has 149 overlapping cards out of 3,059 (8 safe, 141
even; 38 matching legs have learning receipts). **All 149 first-seen timestamps
precede the latest injury receipt, `2026-10-16T01:57:09Z`.** These are retained
historical memberships, not 149 simultaneously published tickets, placed bets,
losses or proof that this OUT designation existed at those earlier times.
The thin, qualified projection is in
`tests/fixtures/week6_eligibility_baseline_0d49/downstream_exposure_audit.json`.

## Why existing testing missed it

1. The producer prioritized normalized names despite already available ESPN
   identity. A suffixed provider display name became a different lookup key.
2. Several consumers repeated the name join: weekly shaping, status blocks,
   projection status/absence and nonprojected depth decisions. Fixing one badge
   would not fix that shared input contract.
3. The validator repeated the producer's lookup discipline. Agreement between
   two implementations of the same incomplete join was not an identity oracle.
4. The earlier current-input audit explained all 33 existing holds (19 status,
   14 depth) but did not prove the reverse invariant: every unambiguous canonical
   negative source identity must receive its required block. That task was
   reopened rather than retaining unsupported completion credit.
5. Final review reproduced a second validator gap. Mixed ACTIVE/OUT rows were
   explicitly exempted from the reverse check; mixed QUESTIONABLE/OUT could pass
   because any member of the reported set was accepted. Healthy or merely
   Questionable producer output for a weaker source could therefore pass when
   compared against the stronger duplicate report, even with all counts and
   source-clock metadata internally consistent.

The new mixed-status regressions use genuine weaker-source producer output,
not malformed totals or deliberately stale metadata. They test the relevant
semantic failure rather than an unrelated parser error.

## Implemented local correction

- One ID-first producer resolver binds canonical `espn-N`, `athlete_id` and
  `espn_id`. Matching IDs require an agreeing team; different explicit IDs never
  borrow a same-name person's medical status.
- Contradictory IDs, same-ID team conflicts and ambiguous legacy names create
  row-local source uncertainty. They withhold affected offers without inventing
  OUT, ACTIVE, absence duration or a medical zero. Recognizable aliases remain
  collision targets even when their containing record is damaged.
- ID-absent legacy fallback remains guarded. Projection status and absence use
  the same binding; nonprojected depth uncertainty cannot promote a backup as
  though a starter's absence were established.
- The validator independently derives identity refusal and the winning
  canonical duration/season/severity status. It does not import the producer's
  resolver or worst-row function. A stronger OUT/IR/RETIRED winner cannot be
  hidden by an ACTIVE or Questionable neighbor. The documented unusual legacy
  duration-first winning ACTIVE case retains its existing no-block behavior.
- R103 FINAL and past-week behavior, coefficients, R126 ranking, workflows and
  historical data remain unchanged.

## Verification and honest limits

All 20 frozen original input/code files retain their exact lengths, SHA-256 and
Git blob identities. Independent review also checked their membership in the
exact remote commit. Historical 33 = 19 status + 14 depth evidence is retained;
candidate source hashes are separate, not replacements for the original pins.

The full 300-player controlled same-input comparison yields **33 → 34 held**:
only `espn-3126486` changes, now OUT/status. No prior refusal becomes playable.
Both runs use the same original projections, injuries, schedule, depth,
inactives and factor documents. The original runtime Elo map and raw fantasy
inputs were not retained: the common neutral Elo and rounded receptions make
this an eligibility comparison, **not an original point-exact pipeline replay**.

Root reruns at the four hashes in `candidate_audit.json`:

- Current-input + identity author/independent regressions: **25 passed, zero
  skipped, exit 0**. Includes actual frozen-input replay, reverse omission,
  duplicate winners, namesakes, alias conflicts, second pass and R103 controls.
- Existing related vocabulary/UI/weekly injury/line consumers: **67 passed,
  zero skipped, exit 0**.
- The original independent-agent acceptance preceded the final duplicate/alias
  follow-ups; coordinator additions/reruns are not a new independent-agent
  signoff. No completed full gate for the combined hook/source revision is
  claimed in this report yet.

The pool was not regenerated, tickets were not regraded, and a complete
historical-candidate R126 replay is unavailable. A retained on-card control
replay is a separate limited regression, not a substitute for missing full-pool
history. Provider completeness/authentication, real browser/mobile layout,
hosted/native persistence and a controlled active learning consumer remain
separate acceptance requirements. No postgame refit or history rewrite occurred.

## Prevention and follow-through

Keep both audit directions: output-to-source justification **and** required
source-to-output consequences. Keep explicit-ID/name/team conflict fixtures,
mixed duplicate status winners and one unaffected-neighbor assertion. Bind any
future prepublication result to the actual consumed source bytes and final
committed tree; a green old test run must not authorize changed data. Retain
shared-leg exposure reporting separately: correct eligibility prevents this
bad leg entering new candidates, while portfolio policy controls the blast
radius of an otherwise legitimate leg losing. Neither guarantees a parlay win.
