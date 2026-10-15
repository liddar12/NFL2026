# Claude Code peer review — final reconciled response

Captured October 14, 2026, approximately 2:00 p.m. CDT (America/Chicago). Read-only CLI review of the pinned audit checkout and three independent evidence memos. This is a separate review, not access to the user's other Claude conversation. The primary report adjudicates remaining wording: 41.6% refers to **one or fewer** Week-card wins, not exactly one; 15 changed statuses are out of 34 gated players, of whom 30 matched by ID. No model identifier or credential is included.

# Final peer review: NFL2026 Week 6 RCA (read-only, fb8830ae)

I read the three teammate documents. I also checked parts of the source myself; those checks are tagged **[verified]**. Teammate evidence I did not re-run is tagged **[teammate]**.

## Corrections to my earlier reviews

1. **The MY parlays correction layer.** All we have shown is that the test that rolled it back is invalid. It compared a probability already adjusted once against the same probability adjusted twice. **[teammate]** reconstructed one real leg: D. Smith 60+ went from a base of 0.374 to 0.520 served, then 0.659 in the evaluation. Whether applying the correction once helped or hurt Week 5 is not established either way.
2. **Slate coefficients.** The Week 5 refit improves only the score of a fixed set of 45 legs (log-loss 0.6673 → 0.6600) **[teammate]**. It says nothing about which legs or cards were selected, or about whole-card outcomes.
3. **Archive.** R106 (Oct 1, `build_parlay_archive.py:298/347`) already blocks new cards from being added to the archive after kickoff. Keep it. Quarantine and label the older history: Week 1's 16/18 is not a prospective result. The fixed pre-kickoff cohort was 1/18 **[teammate]**.
4. **Void settlements.** A void can legitimately reduce the number of live legs on a card, so I withdraw "leg count must match after void." The right model is an immutable original receipt plus appended settlement revisions. Calibration should count only cards whose contract is unchanged.
5. **Margins.** The 0.0015 margin belongs to the game-parameter gate only. I'm not proposing it as a general rule. The prop gate (`backtest_parlay.py:816-833`, adopt if the result is no worse) can stay. If it changes, it should get its own predeclared threshold with uncertainty clustered by game and week, set by the owner.

## Proven faults

- **[verified] Injury feed rejected over one row.** `espn.py:365-372` rejects the whole response when any single status is unmapped. `availability.py` has no mapping for `Reserve-Ret`. **[teammate]** found the trigger was PHI Lane Johnson in an otherwise healthy 800-row HTTP 200 response. The same exception appears in run 38180920617 (Oct 11 22:35 UTC) and in run 38585561479. Since then, Oct 11 injury data, 67 hours old, has been gating Week 6 players. 15 of 30 ID-matched gated players are now Active or Questionable. `pipeline_status.json` shows `injuries: down` (health `down`), and builds still publish.
- **[verified] Week cards share the same favourites.** The builder ranks favourites by probability and takes combinations from only the top games (`parlay_builder.py:1006/1013/1020`). Week 5 pre-Thursday: DAL was in 17/18 cards. Week 6 now: SF is in 18/18.
- **[verified] Correction layer applied twice in its own test.** `backtest_leg_pool.py:342-365` treats the probability already served as "raw".
- **[teammate]** The identity key `(week, abbreviated selection)` merges different players. Week 3 example: two different "T. Johnson 20+ rec yds" legs, one key.
- **[verified] Voids scored as losses.** `resolve_my_cards.py:334` pairs `(model, all_hit)` across all graded cards, so a voided card scores as a miss. The 5.8% safe-dial figure is not a like-for-like calibration number.
- **[verified] Elo k mismatch.** `elo.K = 20` in production while the model page reports 25. **[teammate]** says this mismatch predates Week 1.
- **[teammate]** The learning-loops page shows an outdated run because it reads the last history row (`rows[-1]`) while `promote_signals` prepends new entries.

## Losses concentrated in shared outcomes

- **Week 5 week cards.** The unique selections went 6/8. The DAL loss sank 17 cards and an ATL loss sank 2 more **[teammate]**. Under our own probabilities, about 1 win out of 18 had a 41.6% chance (assuming games are independent). That is concentration, not a proven calibration failure.
- **Week 5 MY parlays, safe dial, cards with no voided legs:** 96/893 hit (10.75%) against a predicted 30.4% **[teammate]**. A few near-miss legs were reused hundreds of times:
  - Darnold 200+ finished at 195, in 620 safe cards.
  - Goff 275+ finished at 271, in 1,518 cards.
  - DAL ML was in 567 safe cards.
  - Doubs 30+ finished at 16, in 151 safe cards.

  Those cards overlap, so they are not independent evidence. Choosing different lines after seeing these results would not count as an out-of-sample improvement.
- **The injury failure does not explain Week 5.** It started Sunday Oct 11 at 22:35 UTC. Snapshots before Thursday and before Sunday noon had injuries `ok` **[teammate]**.

## Unresolved hypotheses

- Whether the correction layer, applied once, helped or hurt.
- Whether the R117 dial change or line selection made the selected legs overconfident.
- Whether ranking same-game pairs by how strongly the legs move together, and the anti-informative EV, hurt card results.
- Whether prop features at training time differ from those served (the defence-vs-position shrink at `parlay_builder.py:636-647`).

## One disagreement

The Week 6 risk number in your summary needs a label, because two different quantities are in circulation:
- **15.93%** is the SF single-leg loss probability, which is enough to lose all 18 cards.
- **16.98%** is the chance that no card wins at all.

Either can be reported, but labelled.

## Missing tests that matter most

1. **Exposure:** a fixture shaped like Week 5 must report each game's share of cards and the probability of zero wins, and enforce whatever cap the owner agrees. Diversification versus the highest single-card hit rate is a trade-off; measure it explicitly.
2. **Injury vocabulary:** one unknown designation is quarantined as unknown or not offered, never mapped to ACTIVE, and the other rows still ingest. Freshness reports the real last success. A stale feed cannot gate a new week silently.
3. **Two-cycle learning:** run base → adopt → serve → resolve → re-evaluate. The test must prove exactly one correction is applied, use a stored `base_prob` / `served_prob` / calibrator version, and give the same result whatever order the archive is read in.
4. **Event identity:** the key is `(season, game_id, player_id, market, line, direction)`, with collision fixtures.
5. **Settlement:** the original receipt is immutable, revisions are appended, and voided or changed-contract cards are excluded from all-hit calibration.
6. **Prospective cohort:** every evaluation metric names its pre-kickoff cohort and contract hash, and R106 behaviour stays locked.
7. **Learning-loop chronology:** "latest" is chosen by timestamp, and the effective state is reported separately from the latest decision.

No files were edited, nothing was deployed, and nothing was delegated.
