# QB DEPTH CASCADE (R92, part A — measure first, adopt nothing)

## The owner's order

> "there should be a drop if QB1 is out. And another if QB2 is out. And then
> look at the capability of QB3. This should apply to all key positions on
> offense and defense."
> — 2026-09-20

Three asks about the quarterback room, in order of depth:

| term | fires when | what it prices |
|---|---|---|
| `qb1_scale` | QB1 is listed Out/Doubtful | the drop itself |
| `qb2_extra` | QB2 is listed out **as well** | a second, further drop |
| `cap_scale` | QB1 is out, whoever starts is measurable | Elo per unit of **EPA per dropback** lost between QB1 and the man actually expected to start — QB3 when the first two are gone |

They are **one family**, not three: every term fires only inside the QB1-out
condition, so `qb_depth` at `(scale, 0, 0)` is exactly the shipped `qb_out`
family measured on a different substrate. That nesting is load-bearing and it
is why the two may never be applied together (see **The QB1 double-count rule**).

The last sentence of the order — "all key positions on offense and defense" —
is deliberately **not** attempted here. `skill_out` already prices RB/WR/TE
absence by usage share, and the line cascade is `scripts/backtest_lines.py`
(`docs/LINE_INJURY_CASCADE.md`). Widening this substrate to those positions is
a separate measurement, not a wider grid on this one.

## Decision that stands

**Measure first; ship on never-regress.** R92 part A produces the coefficients
and the family definition, and **changes no shipped number**:
`data/model_tuning.json` `game_params` is untouched, `qb_out` is still applied
at scale 75, and `qb_depth` carries no block at all. The family is registered
in the promotion gate as a **proposal-only** candidate, measured every week
beside `qb_out` and `skill_out`, and adoptable only by the weekly promotion run
under the rule everything else obeys.

## Definitions

Everything below is read **strictly as of before kickoff**.

| input | source | rule |
|---|---|---|
| **Depth order** (QB1, QB2, QB3, …) | nflverse `depth_charts_{season}` release, through `build_line_report.fetch_depth_chart` (the same CSV cache the line report uses — `--cache-dir` is shareable with it) | the QB rows of the **latest snapshot whose week is ≤ wk − 1**, ranked by `pos_rank`. Lag 1 is the `backtest_lines.py` STARTER RULE: a chart dated in the priced week is invisible. The 2025+ release is dated per snapshot (`dt`) and a snapshot belongs to the first week whose first kickoff is after it; the legacy release is dated per `week`. |
| **Week 1** | the prior season's **final** chart | week 1 has no in-season snapshot at lag 1. When the prior season was not fetched either, the team-game is **neutral and counted**, never guessed. |
| **`qb1_out` / `qb2_out`** | `data/injury_history.json` | the **final** report for (team, week): a QB row with status `Out` or `Doubtful`. Same vocabulary as the shipped `qb_out`. Ids join first (gsis), names second. |
| **Expected starter** | the two above | the **highest-ranked QB not listed Out/Doubtful** — QB3 when QB1 and QB2 are both out, QB4 when three are. |
| **`capability(passer)`** | `data/epa_history.json` `seasons[yr][team][wk].passers` | EPA per dropback over the passer's **trailing dropbacks before the week**, across seasons. Fewer than **100** prior dropbacks and he has no measured capability of his own: he takes replacement level. |
| **Replacement level** | the fold's training window | the pooled EPA/db of every passer who threw **fewer than 100 dropbacks in the whole training window** (the seasons before the evaluated one). Computed **once per fold**, from training data only. |
| **`cap_gap`** | the two above | `capability(QB1) − capability(expected starter)`, and **exactly 0.0** when QB1 is the expected starter. |

### Why replacement level is pooled by passer, not by passer-week

A by-week rule ("every passer-week thrown by someone under 100 prior
dropbacks") sweeps **every starter's first three September weeks** into the
pool, because a starter is also under 100 prior dropbacks in week 2. On this
corpus that turns replacement level from roughly −0.25 EPA/db into roughly
+0.02 — i.e. into a league average — and shrinks every `cap_gap` toward
nothing. Pooling by **passer** keeps the pool to passers who never established
themselves, which is what "replacement" means. The measured levels are:

| fold (evaluated season) | 2022 | 2023 | 2024 | 2025 |
|---|---:|---:|---:|---:|
| replacement EPA/dropback (training window only) | −0.070 | −0.230 | −0.293 | −0.275 |

2022's is the thinnest: its training window is the single season 2021.

## The walk-forward rule

Scored through `scripts/promote_signals.evaluate()` — the promotion gate's own
harness, so the number here is the number the gate would produce:

* seasons **2021–2025**, folds **2022–2025** evaluated (2021 seeds the priors);
* every eval season is priced with priors from the season before it and
  features computed only from information available before kickoff;
* **ratings always update on the flat HFA** — a candidate shifts *pricing*
  only, never the rating trajectory;
* the **baseline is the model production ships**: `hfa 45`, `revert 0.45`,
  `k 25`, `qb_out` applied at scale 75, rebuilt by `_incumbent_family_fns`;
* adoption rule unchanged: paired per-game log-loss differences, **CR1
  cluster-robust over the folds**, one-sided Student-t at α 0.05 Bonferroni-
  corrected over the number of candidate **families** (4 here), floored at the
  effect floor 0.0015. Four folds give **3 degrees of freedom**, so the bar is
  very high by construction.

### The QB1 double-count rule

`qb_depth`'s first term **is** `qb_out`'s drop — same condition, same sign, a
depth-chart substrate instead of a dropback-leader one. So:

* **in the backtest and in the gate**, a `qb_depth` trial is stacked on the
  incumbent **minus** `qb_out` (`_incumbent_family_fns(tuning, exclude=("qb_out",))`),
  while still being *measured against* the full shipped walk;
* **in `scripts/build_predictions.py`**, when `game_params.qb_depth.applied` is
  true the `qb_out` term is **skipped** and the absence is priced once;
* **on adoption**, `_write_adoption` retires the `qb_out` block
  (`applied: false`, with a reason) rather than stacking the two.

`tests/feature/r92_qb_depth.test.mjs` asserts the rule at both sites; if either
drifts, one QB absence gets priced twice.

## Results (2026-09-20, `data/qb_depth_backtest.json`)

All five depth releases (2021–2025) were fetched; **no season was unavailable**
and **no team-game was priced on an unknown chart**.

### n per condition per season (scored team-games, two per game)

| condition | 2022 | 2023 | 2024 | 2025 | total |
|---|---:|---:|---:|---:|---:|
| team-games scored | 542 | 544 | 544 | 544 | 2,174 |
| depth order known | 542 | 544 | 544 | 544 | 2,174 |
| depth order unknown | 0 | 0 | 0 | 0 | 0 |
| **QB1 out** | 40 | 24 | 19 | 35 | **118** |
| **QB2 also out** | 0 | 1 | 0 | 1 | **2** |
| **QB3 or deeper started** | 0 | 1 | 0 | 0 | **1** |
| cap_gap measurable | 37 | 24 | 19 | 34 | 114 |

**This is the headline, and it is a fact about the data, not about the model.**
Across four seasons and 2,174 scored team-games, both listed quarterbacks were
Out/Doubtful on the same final report **twice**, and a QB3-or-deeper start
happened **once**. The injury feed agrees independently: only six team-weeks in
2021–2025 list two QBs as Out/Doubtful at all. The second and third terms of
the owner's order therefore **cannot be estimated** on this corpus — not
"were estimated and found small", but "fired twice".

### Held-out log-loss, shipped vs each candidate

Lower is better. `delta` is shipped minus candidate, so **positive would mean
the candidate priced better**.

| candidate | best params | 2022 | 2023 | 2024 | 2025 | pooled | delta vs shipped | t | 95% CI | needed > | would_adopt | n_fired |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---:|
| **shipped** (`qb_out` 75) | — | 0.63533 | 0.66551 | 0.60135 | 0.63582 | **0.63450** | — | — | — | — | — | 98 |
| `qb1_out` | qb1 75 | 0.63549 | 0.66606 | 0.60183 | 0.63851 | 0.63547 | −0.00097 | −1.68 | [−0.00281, +0.00087] | 0.00241 | **no** | 118 |
| `qb1_qb2` | qb1 75, qb2 **0** | 0.63549 | 0.66606 | 0.60183 | 0.63851 | 0.63547 | −0.00097 | −1.68 | [−0.00281, +0.00087] | 0.00241 | **no** | 118 |
| `capability` | cap 300 | 0.63947 | 0.66525 | 0.60006 | 0.63693 | 0.63541 | −0.00091 | −0.78 | [−0.00466, +0.00283] | 0.00491 | **no** | 114 |
| `combined` | qb1 50, qb2 0, cap 200 | 0.63737 | 0.66562 | 0.59812 | 0.63857 | 0.63491 | −0.00041 | −0.31 | [−0.00467, +0.00384] | 0.00559 | **no** | 118 |

Grids: `qb1_out` 4 points (50–125 by 25), `qb1_qb2` 20 (× extras 0–100 by 25),
`capability` 5 (100–500 by 100 Elo per EPA/db), `combined` 36. The full grid is
carried in the artifact so the *shape* is visible, not just the best point.

### Verdict: **none**

No candidate clears the never-regress rule. Three things are worth saying
plainly rather than burying:

1. **Nothing beat the shipped model.** Every candidate's pooled log-loss is
   *worse* than `qb_out` at 75, and every confidence interval spans zero. The
   verdict is not "close but not significant"; it is "not better".
2. **`qb2_extra` never helped at any amplitude** — its best value is 0 in both
   families that offer it. With n = 2 that is the only honest outcome available:
   the grid could not have learned anything else.
3. **The capability term is the one with a pulse.** It is the only single-term
   candidate that wins on 2 of 4 folds, and adding it to a *smaller* QB1 drop
   (`combined`: qb1 50 + cap 200, versus the shipped flat 75) gives the closest
   result to shipped of anything tried, with the smallest |t|. That is a hint
   about *shape* — the drop should scale with who replaces him rather than being
   flat — and it is nowhere near evidence.

A further caution that the shipped number deserves: `qb_out`'s own adoption
record in `data/model_tuning.json` (2026-07-18) already says it was adopted
under the retired fixed-margin rule and that **its 95% CI spans zero** — it is
not statistically distinguishable from noise either. So the baseline these
candidates failed to beat is itself unproven. The honest reading of all of it
is that **the QB-absence effect is real in football and not resolvable in
1,084 games of Elo log-loss**.

## Adoption path

Nothing here adopts. What exists after R92 part A:

1. `qb_depth` is a registered candidate family in `scripts/promote_signals.py`
   with its grid (`QB_DEPTH_GRID`), its walk-forward inputs
   (`qb_depth_inputs`, built by `scripts/backtest_qb_depth.py`) and its
   prediction-time reader (`qb_depth_current` → `qb_depth_row` →
   `qb_depth_delta`).
2. It is in `APPLIABLE`, because `scripts/build_predictions.py` really does
   call that reader — the rule for that set is unchanged. Being **measured**
   every week while `game_params` carries **no** `qb_depth` block is exactly
   what proposal-only means.
3. The weekly cron runs `promote_signals --propose`: it measures `qb_depth`
   beside every other family, archives the result, and records `would_adopt`
   without writing `game_params`.
4. A human applies it with `python3 -m scripts.promote_signals --auto-adopt`,
   which writes `game_params.qb_depth` (with `applied: true` and the three
   scales) **and retires `qb_out`** in the same write.
5. On today's evidence, step 4 should not happen. Re-measure when the corpus
   grows: `--corpus` (1999–2025) buys folds, and `qb_depth` will skip there
   until the depth and passer histories reach back that far — which they do
   not, and the gate says so out loud rather than scoring exact ties.

## Limits

* The depth-chart release is a **public listing, not a lineup card**. A chart
  that never caught up to a mid-week change is wrong here exactly as it was
  wrong in public, and that error is not correctable after the fact.
* The **legacy (pre-2025) release lists two QBs** for most team-weeks, so QB3
  is frequently unknown in 2022–2024 and the `qb3_or_deeper_started` counts for
  those seasons are a floor, not a census. (2025's dated release lists three or
  more for most team-snapshots.)
* **Capability is raw EPA per dropback**, with no opponent, game-script or
  situation adjustment: a backup whose sample came in garbage time reads better
  than he is.
* **Four folds give three degrees of freedom.** A "none" verdict here means
  *not proven on 1,084 games*, not *no effect*.
* `Doubtful` counts as out, matching the shipped `qb_out` vocabulary. A
  `Questionable` QB1 who does not play is invisible to this substrate.
* The substrate needs the nflverse depth-chart releases. Where they cannot be
  fetched the family **skips loudly** — an uncovered fold would score exact
  ties, and ties count in n and in the cluster-robust variance, so "no data
  here" would be archived as "no help here".

## Files

| file | role |
|---|---|
| `scripts/backtest_qb_depth.py` | the substrate, the four candidates, the measurement (`--selftest`, `--cache-dir`, `--offline`, `--out`) |
| `data/qb_depth_backtest.json` | the artifact (measurement record, like `replay_lab.json`) |
| `data/contracts/qb_depth_backtest.schema.json` | its strict contract, registered OPTIONAL in `scripts/validate_data.py` |
| `scripts/promote_signals.py` | the `qb_depth` family: grid, inputs, builder, the pure penalty/delta, the adoption block |
| `scripts/build_predictions.py` | the prediction-time application, guarded by `applied` and by the double-count rule |
| `tests/feature/r92_qb_depth.test.mjs` | the leak barrier, the cascade arithmetic, replacement pooling, both double-count sites, proposal-only, the artifact |
