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
