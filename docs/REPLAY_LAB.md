# REPLAY LAB (R81) — candidate parlay rules, measured against the weeks already played

`scripts/replay_lab.py` → `data/replay_lab.json` → the MODEL tab card
**REPLAY LAB · CANDIDATES vs SHIPPED**.

## The one rule

**A variant is reported, never adopted.** There is no `--gate`, no promotion path,
no `adopt` flag, and no code path from this file to a calibration record or a
slate. The lab writes exactly one file — its own output — and
`tests/feature/r81_replay_lab.test.mjs` fails the gate if that ever stops being
true. Whether any finding here becomes a build is a decision the owner makes in
chat, from the numbers, on purpose.

## What it replays

For every week the parlay-leg resolver has graded, the lab:

1. **Joins** the locked legs of `data/estimates/parlays_<season>.json` to the
   resolved rows of `data/parlay_leg_scores.json` on
   `(week, game_id, market, selection)`. A locked leg with no outcome is counted
   under its reason (`no_stat_line`, `no_final_score`, `push`, …, or
   `week_not_resolved` when the resolver has not reached that week at all) and is
   **never scored**.
2. **Re-prices** every resolved leg under each variant, from the inputs the
   ledger recorded at lock time: `mu`, `sd`, `z`, `line`, `p_team`, `side`,
   `market`. Every variant sees identical legs.
3. **Scores** each variant pooled, per week and per market: `n`, hit rate,
   log-loss, Brier, plus a **paired bootstrap** (2000 resamples, fixed seed) of
   the per-leg log-loss difference against `shipped`, with a 90% CI. The verdict
   is `better` / `worse` only when that CI excludes 0; otherwise `same`.
4. **Re-combines** every archived parlay (`data/parlays/<season>_wk<NN>.json`)
   whose legs all resolved, using the builder's own
   `make_leg` / `_make_parlay` / `_combined_probs` — imported, never re-implemented
   — and re-settles the $100 with `build_review.parlay_money`, imported the same
   way. A parlay with any unresolved leg is excluded and counted.
5. **Applies selection rules** on top of each variant: `all`, `ev_gt_0`,
   `ev_gt_0.05`, `tier_high_only`, `max_2_legs`, reporting n, hits, staked, net at
   fair and at vig×1.02, and ROI.

## What it cannot replay

* **Only PRICING and SELECTION.** The ledger snapshots each leg's pricing inputs,
  not the week's full model state, so the lab cannot rebuild a slate: a different
  player, a different line or a different leg set would need a per-week input
  snapshot the pipeline does not keep. Adding one is the prerequisite for a
  *selection-of-legs* variant.
* **The realised settlement is a fact.** What a bet paid depends on the outcome
  and the book's price, not on our probability, so the money is identical across
  variants for the same parlay. A variant moves ROI only by moving **which**
  parlays a rule takes.
* **Eligibility is not random.** A parlay is replayed only when every leg of it
  resolved, so while spreads are ungraded every card carrying one drops out. The
  comparison between variants stays like-for-like; an absolute ROI is over a
  subset of the slate.
* **The baseline is the LOCKED price.** `shipped` is the price locked on first
  sight — what the resolver grades and what a pre-kickoff bet carried. The
  archived card may hold a later pre-kickoff refresh of the same leg, so a
  replayed `model_ev` will not always equal the number printed on the card. Both
  are ours; they are different snapshots.
* **Small samples.** One or two weeks of a season is a reason to look again next
  week, not a reason to change a build.

## Market numbers

`implied_prob` is read in exactly two places: the EV denominator (the price the
bet was offered at) and the leg decimal of the $100 settlement (what it pays).
**No variant function is handed a book number at all** — the registry signature is
`(row, ctx)` where `row` carries only model inputs, and a test asserts no variant's
bytecode references `implied_prob`.

## The variants today

| name | what it changes |
| --- | --- |
| `shipped` | nothing — the probability actually locked on the leg. The baseline. |
| `seed` | props = `seed_prop_prob(p_team)`, moneyline = `p_team`, spread = 0.5. The floor the calibrated model had to clear to ship. |
| `pool_calibration` | props re-priced with the wide-pool coefficients from `leg_pool_backtest.json`, **support rule kept** — a leg whose `z` is outside the pool's measured range is skipped and counted, never extrapolated. Game legs as shipped. |
| `spread_margin_model` | spreads priced by the retired pre-R51 Elo margin rule, `p_cover = Φ((Φ⁻¹(p_team)·13.5 − handicap)/13.5)`. Re-measuring a retired rule on live data is how the decision to retire it stays under review — it is not a path back in. |
| `shrink_to_half` | props halved toward 0.5. The simplest test of whether the prop model is overconfident rather than wrong. |

## Same-game pairs (R87)

`same_game_pairs` scores the **shipped same-game correlation** against 2026
outcomes. RC-N5 of `docs/RCA_MYPARLAYS_CARDS.md` asked for exactly this before
the chained joint is trusted beyond the 2–3-leg cards the slate builds today.

The builder combines two same-game legs as
`joint = pA·pB + rho·sqrt(pA(1−pA)·pB(1−pB))` (`parlay_builder._combine_two`),
with `rho` from `parlay_builder._pair_rho` over the five pairs measured on
2023-25 in `data/parlay_backtest.json` (`default_rho` 0.10 for a pair nobody
measured). The lab imports both — it never re-implements them.

**What is measured.** From the same joined rows the lab already builds (locked
ledger legs joined to resolved outcomes), every unordered pair of resolved legs
sharing a `(week, game_id)`:

* a pair `parlay_builder.same_side_game_pair` refuses — a team's moneyline and
  that team's **own** spread — is **not scored**: the slate refuses to build it,
  so there is no such card to measure. It is counted under
  `refused_by_reason.same_side_game_pair`;
* the pair is keyed the way the calibration keys it: the two legs' correlation
  tags sorted and joined with `|`, plus `|opposing` when the two sides are
  `{home, away}` — so `qb_pass_yds|wr_rec_yds|opposing` is the row you read
  against the measured pair of the same name.

Per key, and once more pooled over every pair as the row `all`:

| field | what it is |
| --- | --- |
| `n` | pairs |
| `observed_joint` | mean of `yA·yB` — both legs landed |
| `independent_joint` | mean of `pA·pB` on the **locked** model probabilities |
| `shipped_joint` | mean of `_combine_two(pA, pB, _pair_rho(...))` — what shipped said |
| `rho_shipped` | the rho `_pair_rho` returned (constant per key; null on the pooled row, which mixes rules) |
| `rho_live` | the calibration's own moment estimator on these outcomes: `(observed − independent) / mean(sqrt(pA(1−pA)pB(1−pB)))`. Not bounded to [−1, 1] — on a handful of pairs it is a ratio of two small numbers, and leaving the range is itself the signal that `n` is too small |
| `delta` | `observed_joint − shipped_joint` |
| `ci90` | 90% paired bootstrap (the lab's own `paired_bootstrap`, 2000 resamples, fixed seed) of the per-pair `yA·yB − shipped joint` |

**The verdict rule.** `min_n` is **20** pairs.

* `n < min_n` → **`insufficient`** — the numbers are still reported, the claim is
  not made;
* otherwise the 90% CI decides, and only when it excludes 0: entirely **below**
  0 → **`shipped_high`** (the legs co-occurred less often than the shipped rho
  says, so the shipped joint overstates it); entirely **above** 0 →
  **`shipped_low`**; containing 0 → **`consistent`** (the shipped rho is not
  contradicted).

**The `cards` sub-block** is the *offered* population rather than every pair the
resolved legs could form: the archived same-game cards the lab already
re-combines (`scope: "game"`, exactly two legs, both resolved). It reports `n`,
`all_hit_rate`, `mean_model_shipped`, `mean_model_independent`, `delta`, `ci90`
and a verdict under the same rule, with every card it could not score counted
under `excluded_by_reason`. It is much smaller than the pair rows, and the two
answer different questions: whether the rho is right, and whether the cards it
priced landed.

**With no resolved week**: `pairs` is `[]`, every pooled number is `null` (never
0, which would read as a measurement), and `cards` is `n` 0 with nulls.

**It adopts nothing.** Like every other block here, this one is a report: no rho
measured in it is written back to `data/parlay_backtest.json` or anywhere else,
there is no promotion path from it, and no market number (`implied_prob`) is in
scope in any of its code — `tests/feature/r87_same_game_pairs.test.mjs` asserts
that from the function source. Whether a number here ever changes the builder is
a decision the owner makes in chat.

## Adding a variant

1. Write a pure function `v_<name>(row, ctx) -> float | None` in
   `scripts/replay_lab.py`. Return `None` to **skip** a leg you cannot honestly
   price; skips are counted per variant and never zero-filled.
2. Add one entry to the `VARIANTS` registry with a `description` a reader can
   check against the code.
3. Extend the fixture assertions in `tests/feature/r81_replay_lab.test.mjs` with
   the number your variant should produce on a known leg.

That is the whole extension surface. The scoring, bootstrap, parlay recombination
and settlement are shared, so a new variant is measured on exactly the same legs
and the same arithmetic as every other one.

## Wiring

* `.github/workflows/daily.yml` — runs right after *Resolve parlay legs against
  nflverse weekly yards*, `continue-on-error` like its neighbours: a measure-only
  bench never degrades the run.
* `tests/smoke.sh` — `python3 scripts/replay_lab.py --selftest`.
* `scripts/validate_data.py` — `replay_lab.schema.json` → `replay_lab.json`,
  registered OPTIONAL (runner-built). A 0-resolved-week document is valid and
  carries nulls, never zeros.
* `tests/feature/r87_same_game_pairs.test.mjs` — the same-game pair block: the
  contract requires it and is strict, the verdict follows its own CI, the shipped
  rho is the one measured, the refused pairs are counted, and the MODEL tab
  renders it.
