# WEATHER EFFECT (R94 — measure first, adopt nothing)

## The owner's question

> "Rain has to matter. The ball is wet, the QB's numbers should be down and
> it's harder to catch. Call it 8% off in heavy rain. Is that in the model?"
> — 2026-09-20

The short answer to the last sentence is **no**. `scripts/signals/weather.py`
carries the 8% passing haircut as a constant and has **zero call sites**; the
shipped player-side factor (`build_weekly.weather_factor`) prices roof and cold
and no precipitation at all; and `data/model_tuning.json` `game_params` carries
no weather key. Changing that constant today would change nothing.

The rest of this document is the measurement, because "is it in the model" is
only half the order. The other half — *should* it be — is a question about
whether this corpus can see the effect at all.

## Decision that stands

**Measure first; adopt nothing.** R94 produces one artifact and changes no
shipped number: `game_params` is byte-unchanged, no signal family is
registered, `scripts/build_weekly.py` is byte-unchanged, and
`data/weather_history.json` is never rewritten, refiltered or refetched. The
artifact's `verdict.adopted` is pinned `false` by its contract and
`verdict.families_registered` is pinned empty, so the document cannot record an
adoption even if a future edit to the script tried to claim one.

Everything quoted below is a field of **`data/weather_backtest.json`**. It is a
runner-built OPTIONAL artifact: it is not committed, `scripts/validate_data.py`
is green with it absent and strict with it present, and a run on a clone that
has no rate substrate reports every rate term `available: false` with
`unavailable_reason` rather than measuring on the committed synthetic
placeholder. The numbers here are from a full run with the rate substrate
present (`generated_utc` 2026-09-20).

To reproduce every number below, in two commands — the first is the step that
makes the substrate present, and nothing in this document exists without it:

```
python3 scripts/build_wet_rates.py --out-dir /tmp/wetrates
python3 scripts/backtest_weather.py --cache-dir /tmp/wetrates --out /tmp/wb.json
```

The corpus goes to a temp directory on purpose: `build_wet_rates.py` defaults
its `--out-dir` to `data/fixtures/wet_rates/`, which is the **committed
synthetic placeholder** that its own selftest asserts must stay synthetic, and
the real pull is 11.7 MB of derived data that does not belong in the repo.
`.github/workflows/backtest.yml` does the same thing with `$RUNNER_TEMP`, and
the two flags move together: `--out-dir` alone would leave the measurement
reading its own default cache directory and reporting `substrate_unavailable`.

The band cuts every band name below refers to are published in the artifact as
`band_edges.precip` and `band_edges.wind`, straight from `weather_corpus.py`'s
own tables, so no number in this prose has to be taken on trust.

## Definitions

Everything is read **strictly as of before kickoff**, and the weather label is
reanalysis, not a forecast — `substrate.weather_role` is pinned to `"label"`
and `substrate.perfect_foresight` to `true`.

| input | source | rule |
|---|---|---|
| **`precip_mm`** | `data/weather_history.json` (Open-Meteo historical archive) | **ONE hourly value at the kickoff hour**, and by that API's convention the sum over the **preceding** hour. It is roughly the rain *before* kickoff, not the rain during the game. Snow enters only as **liquid-water equivalent**, at roughly a tenth of its depth. |
| **`wind_kph` / `temp_c`** | the same row | the same kickoff-hour convention. |
| **Venue filter** | `data/fixtures/backtest_weekly/games_meta.json` `neutral` flag | a relocation carries the weather of a stadium nobody was in. The filter lives in the **reader** (`scripts/weather_corpus.py`), never on disk. `corpus_filter`: **893** rows read, **893** joined, **19** dropped as relocations, **874** kept. |
| **Roof** | `data/game_context.json` (nflverse) | an independent second column. `corpus_filter.roof_check` reads **`"all survivors outdoors"`** with `roof_check_ok: true`, so the venue filter is confirmed by a feed that knows nothing about the neutral flag. |
| **Pooling** | `roof_census` | `treated` = `outdoors` (**874** games / **1,748** team-games); `placebo` = `dome` + `closed` (**427** / **854**); **`open`** — a retractable roof that was open at kickoff — is reported in its own bucket (**32** / **64**) and **never pooled**, because opening a roof is itself a weather decision. `unknown` is **0**. |
| **Dropback** | `attempts + sacks` | scrambles are not separable in this substrate; they sit in the rushing counters, so a scramble in the rain leaves the passing denominator entirely (`limits`). |
| **Corpus digest** | `weather_history_sha256` | `1244c436273ee0810b0d671c0f981fe57fd09b92e8f8f6c52bc3e3864b59c5ad`, reported in the document so the never-rewritten claim is **checkable rather than believed**, and asserted identical before and after a full run. |

## Why the unit is an attempt and not a game

This is the whole of the design, and it is the one decision that moves the
order from hopeless to nearly answerable. It does not get all the way there on
five seasons, and the distance left is the most useful number in this file.

At the **game** level the wet cell is not a sample, it is an anecdote with a
standard error. In the primary stratum and over the four **scored** folds,
`power.rain_qb_points` reports **24** treated team-games against an MDE of
**4.87** QB points, when the effect of interest restated from the owner's 8% is
**1.32**. A sample that can only see an effect nearly four times the size of the
one being claimed cannot test the claim; a "significant" result from it would be
evidence of noise, not of rain.

The **same** wet team-games carry thousands of pass attempts, and a completion
is a Bernoulli trial whether or not the game around it is one of thirty-four.
The denominator move buys two orders of magnitude: `power.rain_completion_rate`
reports **786** wet attempts against **3,235** dry, against 24 team-games.

It is not enough. MDE **0.0581** against an effect of interest of **0.052**, and
a realized MDE of **0.0964** against the same bar — `powered: false`. **The
denominator move was necessary and it was not sufficient**, and saying so is the
finding this document leads with. The points-level terms (`rain_qb_points`,
`wind_qb_points`, `rb_wind_reprice`) are still measured and still published, so
the bound is on the page rather than in a sentence.

Two earlier drafts of this document reported the primary as `powered: true` at
MDE 0.0455 on 1,214 attempts. Both numbers were wrong, in the flattering
direction, for two separate reasons, and both are fixed here:

* **The power stage counted five seasons while the estimator fits four.** Fold
  2021 is the neutral first fold: it fits nothing, so no coefficient and no
  error bar in this document was ever computed from it. Counting its 428
  attempts in `n_treated` shrank the modelled SE and therefore the MDE.
  `substrate.power_seasons` now names the four seasons the power table is
  computed on, and `power.n_treated == terms.n_wet` is an identity on the rows
  the coefficient is fitted on rather than between two equally inflated numbers.
* **The modelled SE was not the estimator's SE.** See the power table below.

The rule those two fixes generalise to, and which this document now holds
without exception: **no published quantity is computed on data the estimator
never used.** The dose-response ladder was the last place it did not hold and
now does — each term's five band n's sum exactly to its own
`n_treated_rows + n_control_rows`.

## The walk-forward rule

`substrate.rule`: fold Y is scored on season Y and fits only seasons strictly
before it; the first fold fits nothing, is **neutral and counted**. Power reads
outcome-bearing quantities from the **training seasons only** and never from
the held-out season.

| fold | fit_seasons | scored | neutral |
|---|---|---|---|
| 2021 | — | no | **yes** |
| 2022 | 2021 | yes | no |
| 2023 | 2021, 2022 | yes | no |
| 2024 | 2021–2023 | yes | no |
| 2025 | 2021–2024 | yes | no |

`seasons_scored` is therefore **2022–2025** — four scored folds, three degrees
of freedom on the fold-clustered test, and that number does more damage to this
measurement than any effect size in it (see **Verdict**).

That the power stage is blind to the held-out season is not an assertion here.
`python3 scripts/backtest_weather.py --selftest` permutes the held-out outcome
column and asserts the power block is byte-identical, then perturbs a
**training** outcome and asserts that it **does** move — a blindness test
nothing can move proves nothing. `tests/feature/r94_weather.test.mjs` holds the
same property as a behavioural lock.

## The stratification rule and what it costs

Rain and wind travel together, so a marginal rain coefficient is partly a wind
coefficient wearing a rain label. The rain primary is taken inside the stratum
**`wind < 20 kph and temp > 5 C`**, and the artifact publishes what that costs:
`conditions.stratum` sums to **1,200** of **1,748** team-games, and the wet
cell falls from `precip_ge_1p0` **68** to `stratum_precip_ge_1p0` **36**.
Heavy rain inside the stratum (`stratum_precip_ge_2p5`) is **10** team-games.
`conditions` is tabulated over all five seasons, so those are census counts, not
estimation counts: the neutral first fold holds 12 of the 36, leaving **24**
that any coefficient is fitted on. Every n in the power and estimate tables
below is the 24-style number.

Two rules follow, both in `policy`:

* **A stratified primary is powered on its stratified n, over the scored folds
  only.** Powering a term on the 68 and estimating it on the 36 is how a design
  gets sold on power it does not have — and so is powering it on five seasons
  and fitting it on four. Each term's `power` entry carries its own
  `analysis_sample`; `substrate.power_seasons` carries the seasons; and the lock
  recounts `power[t].n_treated` from the rows, season by season, rather than
  comparing it to another number carrying the same inflation.
* **A wind term is never stratified on wind.** A slope stratified on its own
  predictor has no predictor spread left, the SE is a division by zero, and the
  term would read unpowered for an arithmetical reason rather than a physical
  one. The wind terms use `temp > 5 C and precip < 1 mm`.

## Results (2026-09-20, `data/weather_backtest.json`)

All five seasons were read: `substrate.seasons_unavailable` is `{}`, which is
the only claim that everything was fetched.

### n per condition per season

`conditions_unit` is **`team_game`** (each game contributes two). 2021 is in
the corpus and is the neutral first fold, so it is counted here and scored
nowhere.

| condition | 2021 | 2022 | 2023 | 2024 | 2025 | total |
|---|---:|---:|---:|---:|---:|---:|
| team-games | 358 | 344 | 350 | 346 | 350 | **1,748** |
| `precip_dry` | 288 | 270 | 280 | 286 | 296 | 1,420 |
| `precip_trace` | 38 | 34 | 34 | 30 | 26 | 162 |
| `precip_light` (0.25–1.0 mm) | 14 | 24 | 18 | 22 | 20 | 98 |
| `precip_moderate` (1.0–2.5 mm) | 10 | 12 | 12 | 6 | 4 | 44 |
| `precip_heavy` (≥ 2.5 mm) | 8 | 4 | 6 | 2 | 4 | 24 |
| **`precip_ge_1p0`** | 18 | 16 | 18 | 8 | 8 | **68** |
| `precip_ge_2p5` | 8 | 4 | 6 | 2 | 4 | 24 |
| `precip_ge_5p0` | 0 | 0 | 2 | 2 | 0 | 4 |
| `wind_ge_20` | 76 | 78 | 46 | 52 | 42 | 294 |
| `wind_ge_24` | 38 | 40 | 20 | 22 | 28 | 148 |
| `wind_ge_30` | 10 | 18 | 2 | 4 | 10 | 44 |
| **`stratum`** | 238 | 208 | 266 | 240 | 248 | **1,200** |
| **`stratum_precip_ge_1p0`** | 12 | 6 | 10 | 6 | 2 | **36** |
| `stratum_precip_ge_2p5` | 6 | 0 | 2 | 2 | 0 | 10 |

Both five-band families partition the sample: the precip bands and the wind
bands each sum to 1,748. A band that never fired reads **0** rather than being
absent — `precip_ge_5p0` is 0 in 2021, 2022 and 2025, and says so.

The wet cell is also **not evenly spread**: `precip_ge_1p0` is 18 team-games in
2021 and 8 in each of 2024 and 2025. A fold-clustered test on four folds is
therefore leaning on two thin seasons, which is part of why the fold SEs below
are what they are.

### The power table

The `MDE` column is written **before any coefficient was fitted**, on the rows
that coefficient will be fitted on (`substrate.power_seasons` = 2022–2025).
`powered` is simply *is the smallest effect this sample could see no larger than
the effect being claimed*, and an underpowered term is then structurally
incapable of returning `would_adopt: true` however large its coefficient,
because clause 1 of the adoption criterion reads this flag.

**Clause 1 reads TWO MDEs and requires both.** `power[t].mde` models the
estimator: a pooled two-arm binomial difference under the null baseline with the
measured design effect. `terms[t].mde_realized` **is** the estimator:
`adoption_rule.mde_z` (**2.8016** = z(1 − 0.05/2) + z(0.80) = 1.95996 +
0.84162, the two-sided-alpha, 80%-power multiplier both MDEs are built from) × `max(se_fold, se_stadium)`, built from the CR1 clustered
errors the fit actually produced. On this corpus the modelled SE runs **1.06x to
2.12x smaller** than the realized one — always in the flattering direction,
because a pooled binomial on thousands of attempts knows nothing about four
folds or twenty-one stadiums. Publishing `powered` off the modelled number alone
asserts a detection capability the estimator demonstrably does not have.

| term | sample | n_treated | n_control | measured ICC | deff | MDE (model) | MDE (realized) | effect of interest | powered |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| `rain_completion_rate` | stratified | 786 | 3,235 | 0.007055 | 1.245 | 0.058115 | **0.096437** | 0.052 | no |
| `rain_catch_rate_wr` | marginal | 843 | 5,673 | 0.013531 | 1.225 | 0.054755 | **0.061313** | 0.052 | no |
| `rain_catch_rate_te` | marginal | 290 | 1,971 | 0.019604 | 1.113 | 0.084490 | 0.069850 | 0.052 | no |
| `rain_catch_rate_rb` | marginal | 263 | 1,476 | −0.011319 | 1.000 | 0.078309 | 0.068922 | 0.052 | no |
| `rain_heavy_completion_rate` | stratified | 105 | 303 | 0.013363 | 1.441 | 0.171673 | 0.169233 | 0.052 | no |
| `wind_epa_per_dropback` | stratified | 146 | 936 | −0.073243 | 1.000 | 0.039903 | 0.040479 | 0.033 | no |
| `wind_dropback_volume` | stratified | 146 | 936 | −0.160754 | 1.000 | **1.027484** | 0.982503 | 1.0 | no |
| `wind_qb_points` | stratified | 146 | 936 | 0.124506 | 1.124 | 0.987311 | **1.338678** | 1.32 | no |
| `rain_qb_points` | stratified | 24 | 150 | 0.473843 | 1.083 | 4.872166 | 5.657535 | 1.32 | no |
| `rb_wind_reprice` | marginal | 110 | 707 | 0.072176 | 1.031 | 2.956804 | 3.705403 | 1.0 | no |

**Zero of ten terms are powered.** Four things in that table deserve saying out
loud:

1. **The design effect was measured, not assumed.** The primary's
   `measured_icc` is 0.007055 for a `deff` of 1.245. Every deff in the table is
   between 1.000 and 1.441; a measured ICC that comes back negative is floored at
   `deff` 1.0 so it can never buy back power.
2. **The owner's central claim does not survive the power stage anywhere.** The
   primary misses on both MDEs — 0.0581 and 0.0964 against 0.052. WR catch rate
   misses on both. TE and RB miss, and RB is the **control** position: a large
   RB effect beside a small WR one would have been evidence of a confound, not
   of the mechanism. There is no arm of the question this corpus can answer.
3. **The two MDEs disagree about which term is closest, and that is the point
   of publishing both.** `wind_dropback_volume` clears its bar on the realized
   number (0.9825 against 1.0) and misses on the modelled one (1.0275);
   `wind_qb_points` does the exact reverse (0.9873 modelled, 1.3387 realized).
   Either number alone would have declared one of them powered. The conjunction
   is the only reading that is true of both.
4. **`wind_epa_per_dropback` is the near miss, and it is now a near miss twice
   over.** 0.039903 modelled and 0.040479 realized against a bar of 0.033. It
   remains the term the model most obviously lacks and the one most worth
   re-measuring when the corpus grows, but "misses by 0.0023" was an artifact of
   the five-season count and is not true.

### The estimates and what refused them

`heldout_estimate` is the coefficient; `binding_threshold` is
`max(threshold_fold, threshold_stadium)` — never `max(se)`, because at 3 df
against 20 the larger SE can carry the *lower* bar.

Every coefficient, every standard error and every n in this table is computed
on the four **scored** folds, 2022–2025.

| term | held-out | marginal | stratified | se_fold | se_stadium | binding threshold (df) | folds_sign | rows_moved | refused for |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `rain_completion_rate` | **−0.03503** | −0.03441 | −0.047264 | 0.034422 | 0.026723 | 0.201057 (3) | 3/4 | 132 | underpowered, too_few_fired, below_threshold, non_monotone |
| `rain_catch_rate_wr` | −0.025394 | −0.029174 | −0.039915 | 0.021885 | 0.018966 | 0.127827 (3) | 3/4 | 1,210 | underpowered, below_threshold, non_monotone |
| `rain_catch_rate_te` | −0.02806 | −0.044959 | −0.059384 | 0.017273 | 0.024932 | 0.100891 (3) | 3/4 | 543 | underpowered, below_threshold, non_monotone |
| `rain_catch_rate_rb` | −0.00938 | −0.014404 | −0.014098 | 0.024601 | 0.021022 | 0.143693 (3) | 2/4 | 533 | underpowered, below_threshold, non_monotone, fold_sign_disagrees |
| `rain_heavy_completion_rate` | −0.142402 | −0.033214 | −0.078532 | 0.060406 | 0.053657 | 3.845234 (1) | 2/4 | 13 | underpowered, too_few_fired, below_threshold, non_monotone, fold_sign_disagrees |
| `wind_epa_per_dropback` | −0.017985 | −0.03892 | −0.022066 | 0.014448 | 0.009514 | 0.084392 (3) | 3/4 | 1,082 | underpowered, below_threshold, non_monotone |
| `wind_dropback_volume` | −0.665195 | −0.989173 | −0.528285 | 0.309761 | 0.350693 | 1.809285 (3) | 3/4 | 1,081 | underpowered, below_threshold, non_monotone |
| `wind_qb_points` | −0.500369 | −0.839362 | −0.508748 | 0.477826 | 0.274095 | 2.79094 (3) | 3/4 | 1,081 | underpowered, below_threshold, non_monotone |
| `rain_qb_points` | **+1.92425** | −0.723505 | +1.456224 | 1.922868 | 2.019394 | 11.231298 (3) | 1/4 | 174 | underpowered, too_few_fired, **wrong_sign**, below_threshold, non_monotone, fold_sign_disagrees |
| `rb_wind_reprice` | −0.581098 | −0.308054 | −0.848924 | 1.322603 | 1.139894 | 7.725202 (3) | 2/4 | 817 | underpowered, below_threshold, non_monotone, fold_sign_disagrees |

The coefficients did not move when the power stage was corrected, and that is
expected: they were always fitted on the four scored folds. What moved is every
claim about how well they can be SEEN.

`confounded` is `false` on every term — no marginal/stratified pair differs by
more than its own CI half-width — and `rows_moved` is positive on every term,
so the R92 no-op clause (a candidate that fits nothing *is* the shipped number)
bites nobody here. **Every single term is refused by `underpowered`, by
`below_threshold` and by `non_monotone`.** That pattern is the finding, not the
coefficients.

Two refusals are worth reading closely, because they are the ones the audit
moved:

* **`rain_completion_rate` picks up `too_few_fired`.** Clause 2 reads
  `min(n_wet, n_treated_rows)`, and on the scored folds the primary's treated
  side is **23 passer-weeks** holding those 786 attempts. The attempts are real;
  the number of independent wet passer-weeks behind them is 23. Its ladder keeps
  `non_monotone` — but for a different reason than before the audit, and the
  new reason is the stronger one: see below.
* **`rain_heavy_completion_rate` is measured on 3 treated passer-weeks and 10
  control.** `binding_df` is **1**, which is why its threshold is 3.85 on a
  completion rate. There is no version of this corpus in which "8% off in heavy
  rain" is a testable claim at the heavy-rain threshold.

### The dose-response ladders

Five bands, each with its own n, on the four scored folds, and the cuts are in
`band_edges.precip` / `band_edges.wind`. An empty band is present at n 0 with a
`null` value rather than dropped.

**The ladder is the estimation sample.** Like every other published quantity in
this document, it is tabulated on the four **scored** folds — nothing here is
computed on rows the estimator never used, and clause 4 was the last exception.
The identity that makes it checkable: each term's five band n's sum exactly to
its own `n_treated_rows + n_control_rows`, which the lock asserts. The primary's
bands sum to 95 + 9 + 5 + 20 + 3 = **132** = 23 + 109.

**And a band has to weigh something before it is allowed to vote.**
`adoption_rule.min_band_n` is **10**. Bands under that floor are still
*published* — an under-weighted cell is a fact about the corpus — but they are
dropped from the ladder's SHAPE exactly the way empty bands already were. Clause
4 is conjunctive in both directions, so without a floor a one-row cell could
certify a dose-response as easily as refuse one, voting with the same weight as
a cell of 878. Three surviving bands are still required for a shape, and **fewer
than three is `monotone: false` for want of a ladder** rather than an error.

Both rules bite hardest exactly where the corpus is thinnest, which is the
point. Read the `votes` column below as the honest census of what this corpus
can actually show about dose-response: **not much**.

**`rain_completion_rate`** (stratified, passer-weeks, completion rate):

| band | n | value | votes |
|---|---:|---:|---|
| `precip_dry` | 95 | 0.663124 | yes |
| `precip_trace` | 9 | 0.602996 | **no** — under the 10-row floor |
| `precip_light` | 5 | **0.703448** | **no** — under the 10-row floor |
| `precip_moderate` | 20 | 0.634361 | yes |
| `precip_heavy` | 3 | 0.580952 | **no** — under the 10-row floor |

**`monotone: false`, and for the most honest reason in the file: there is no
ladder.** Only TWO bands clear the floor on the rows the coefficient is fitted
on — `precip_dry` at 95 passer-weeks and `precip_moderate` at 20 — and two
points are a line, not a dose-response. The wet end of the primary's own ladder
is 5 and 3 passer-weeks.

Read the values anyway, because they are the physics the order asked about, and
they are not nothing: 0.663 dry → 0.635 at 1–2.5 mm → **0.581** in heavy rain,
the lowest cell on the ladder. That is the shape the owner predicted. It rests
on three passer-weeks at the heavy end, so it is a hint and not a finding, and
clause 4 correctly refuses to call it one.

**`rain_catch_rate_wr`** (marginal, receiver-weeks, catch rate): 0.639246 (n
878) / 0.616637 (96) / 0.623894 (90) / 0.594551 (102) / 0.616438 (44) — every
band clears the floor, down overall, non-monotone twice. `monotone: false` on
its own weight, decided by hundreds of receiver-weeks rather than by a thin
cell. This is the best-supported ladder in the artifact and it does not descend.

**`rain_catch_rate_te`**: 0.713670 (390) / 0.617143 (45) / 0.715116 (36) /
0.655000 (45) / 0.700000 (27). **`rain_catch_rate_rb`** (the control position):
0.787654 (382) / 0.746377 (45) / 0.837398 (36) / 0.790698 (46) / 0.725275 (24).
Both have all five bands voting and both zig-zag.

**`rain_heavy_completion_rate`**: 0.699187 (8) / 0.666667 (1) / 0.750000 (1) /
null (0) / 0.580952 (3). **Zero** bands clear the floor. Thirteen passer-weeks
in total. `monotone: false` for want of a ladder, and the cleanest statement in
the document of why "8% off in heavy rain" is not a testable claim here.

**`wind_epa_per_dropback`** (per 10 kph, calm → extreme): +0.013607 (329) /
+0.026485 (474) / −0.030325 (205) / −0.028387 (52) / −0.064338 (22). Every
band clears the floor. This is still the most physically convincing ladder in
the artifact — it crosses zero between the `wind_light` and `wind_moderate`
bands and then declines — but it RISES from calm to light and again from
moderate to strong, so `monotone: false` is decided on hundreds of team-games,
which is a real reversal and not a thin cell.

**`wind_dropback_volume`** (dropbacks per team-game): 35.787234 (329) /
35.164557 (474) / 35.492683 (205) / 33.192308 (52) / 34.363636 (22).
**`wind_qb_points`**: 16.985593 (329) / 16.602194 (474) / 15.355415 (205) /
15.357692 (52) / 16.751818 (22) — the extreme band **reverses**, on 22
team-games, above the floor, so it votes.

**`rain_qb_points`** (stratified, QB fantasy points per team-game): 16.613701
(127) / 15.630000 (12) / 17.049091 (11) / 18.463000 (20) / 15.490000 (4). Four
bands vote and the ladder rises in the middle, which is why the term also
carries `wrong_sign`. **`rb_wind_reprice`** (RB points per team-game, the
shipped `rb_wind` threshold re-measured): 23.292676 (213) / 22.771463 (335) /
21.865409 (159) / 21.269737 (76) / 22.938235 (34) — falling to `wind_strong`
and then reversing in the extreme band, all five voting.

**Every one of the ten terms reads `monotone: false`.** Five of them (the WR,
TE and RB catch rates and the two wind-value terms) are refused by genuine
reversals on hundreds of rows; the primary and `rain_heavy_completion_rate` are
refused for having too little ladder to read at all. Those are different facts
and the `votes` columns above are what tells them apart.

### CONTROL — does the weather factor the repo already ships earn its place?

`arms.control`, **8,279** rows over 2023–2025. `v2_no_weather` is the deployed
split handed no roof and no forecast, so `weather_factor` returns 1.0
everywhere; `scripts/build_weekly.py` is byte-unchanged and nothing is
monkey-patched.

| series | pooled MAE | rank_corr |
|---|---:|---:|
| `shipped_v2` | **6.003032** | **0.381358** |
| `v2_no_weather` | 6.008667 | 0.380102 |
| `flat` | **5.999077** | 0.377060 |

`weather_earns_its_place` is **true**: the shipped weather factor beats
deleting it, on both MAE and rank correlation. And a **flat** split beats both
on MAE while giving up 0.004 of rank correlation. R51's gate can only ever ask
whether v2 beats v1, so it is structurally incapable of seeing that second row.
Note what this arm measures: the split renormalises to the player's season
total, so a weather factor can never lower that total — it only moves points
between a player's own weeks. This is **allocation**, not level.

### PLACEBO — the finding that most deserves reading

`placebo` runs the identical estimator on roofed team-games handed the weather
of a matched outdoor game in the same season-week. It is **a diagnostic with an
interval, never a pass/fail threshold**.

| term | n_rows | n_treated | estimate | se | ci95 |
|---|---:|---:|---:|---:|---|
| `rain_completion_rate` | 56 | 13 | **−0.050199** | 0.014257 | **[−0.081966, −0.018432]** |
| `rain_catch_rate_wr` | 753 | 131 | −0.012163 | 0.016777 | [−0.049545, +0.025219] |
| `rain_catch_rate_te` | 310 | 60 | −0.002713 | 0.030660 | [−0.071029, +0.065602] |
| `rain_catch_rate_rb` | 297 | 54 | +0.035833 | 0.023029 | [−0.015479, +0.087145] |
| `wind_epa_per_dropback` | 601 | 102 | +0.023336 | 0.014949 | [−0.009972, +0.056643] |
| `wind_qb_points` | 601 | 102 | +0.263667 | 0.372768 | [−0.566913, +1.094246] |

On games that had **no weather at all**, the completion-rate placebo is
**−0.0502 with an interval that excludes zero** — larger in magnitude than the
treated held-out estimate of −0.03503. It rests on **13** treated passer-weeks
across 11 stadium clusters, which is why this arm is reported as a diagnostic
and not as a gate. But a write-up that quotes the treated coefficient and not
this one is not honest, and the plainest reading of the two together is that
the treated coefficient is **not yet distinguishable from whatever this
estimator does to a sample with no signal in it**.

The receiving and wind placebos are small and straddle zero, which is the
reassuring half of the same table.

### REACH — would any of it matter?

`arms.reach`, slate **2026 week 2**. The primary's held-out effect is
propagated through the deployed split's own renormalisation identity as an
`effect_ratio` of **0.946163**, then to leg-pool rung probabilities.

| quantity | value |
|---|---:|
| rungs on the slate | 1,229 |
| rungs moved beyond the pool's own ECE (0.0066) | **0** |
| rungs crossing a support bound | **0** |
| mean / p90 / max \|Δp\| | 0.0 / 0.0 / 0.0 |
| currently-forecast games that would trigger the factor at all | **0** |

Zero of the 1,229 rungs move further than the pool's own calibration error, and
**no game on that slate reaches the 1.0 mm threshold**, so the factor would not
fire even once. This is one named slate and never a season-long frequency. It
is also the only place in the repo where the silent hazard is visible: a rung
that crosses a support bound is not re-priced, it stops being **offered**, and
`backtest_parlay` never calls `build_weekly`, so no gate watches that happen.

## Verdict: **not_powered**

`verdict` reads `{name: "not_powered", adopted: false, families_registered: [],
oracle_only: true, adoptable_candidates: []}`. Nothing is adopted, nothing is
registered, no live number moved.

`not_powered` is read FIRST, before any other clause, and it is the strongest
thing this document says: **the primary term is underpowered, so the corpus
cannot answer the question that was asked, and nothing downstream of that is
worth reading as evidence about rain.** It is a harder answer than `none`.
`none` would have meant "measured, and it did not clear the bar"; `not_powered`
means the measurement was never able to clear the bar, whatever rain does. Six
things are worth saying plainly rather than burying.

1. **This is a BOUND, not a null, and the bound is wide.** Rain costs about
   **3.5 percentage points** of completion rate on the held-out estimate
   (marginal 3.4, stratified 4.7), with a realized MDE of **0.0964**. The honest
   sentence is: *the point estimate is smaller than the 8% the order claimed,
   but this corpus could not have distinguished the 8% from zero either, so the
   estimate is a direction and not a size.* It is not "we found nothing" and it
   is not "rain costs 3.5 points".
2. **Every term fails clause 1, and it fails on the estimator's own error
   bar.** The primary's realized MDE is 0.0964 against a 0.052 bar — 1.85x, not
   a hair. Even the modelled MDE, computed on the right four seasons, misses at
   0.0581. `powered` requires both, and nothing in the grid has both.
3. **The threshold would have refused every term anyway.** Four scored folds
   give three degrees of freedom; `limits` puts the multiplier at about **5.8**
   against about **2.9** on the stadium clustering's ~20 df, so the fold
   clustering binds on every term and the primary's bar is **0.201** — about
   twenty percentage points of completion rate. Nothing on this corpus clears
   that. `not_powered` and `below_threshold` are the same shortage counted
   twice: **folds**.
4. **The points-level question is dead and the play-level one is not
   ANSWERABLE either — but they are dead by different margins.** At the game
   level: **24** wet team-games in the stratum, MDE **4.87** QB points against a
   claimed **1.32**, a factor of 3.7. At the play level: **786** attempts on 23
   passer-weeks, MDE **0.0581** modelled and **0.0964** realized against a
   claimed 0.052, a factor of 1.1 to 1.9. The denominator move bought roughly a
   two-orders-of-magnitude n and closed most, but not all, of the gap. That is
   the number phase 2 has to beat, and it is much closer to beatable than the
   game-level one ever was.
5. **A live number was re-measured and its sign held.** `rb_wind_reprice` —
   the shipped `rb_wind` 0.95 penalty above 24 kph — comes back
   **−0.581** within team-season on **110** treated team-games. The direction
   agrees with the shipped penalty. It is `powered: false` with a binding
   threshold of **7.73** against that coefficient, so **the constant must not
   move on this evidence** in either direction.
6. **Any winner would have been `oracle_only` anyway.** The effect arm is
   fitted on reanalysis weather — perfect foresight — so a NULL under a perfect
   forecast is conclusive and a WIN under one is not adoptable evidence.
   `data/weather_forecast_archive.json` **begins accumulating from the first
   daily cron after R94** — it is not in the tree today and a fresh clone has no
   such file — precisely so a leakage-free phase 2 is possible at all; there are
   zero archived pre-kickoff forecasts for 2021–2025 anywhere in this repo.

## Adoption path

Nothing here adopts. What exists after R94:

1. `scripts/backtest_weather.py` measures ten pre-registered terms every run
   and computes `would_adopt` **mechanically** from all eight clauses in
   `adoption_rule`, so the human decision is arithmetic rather than judgement.
   `tests/feature/r94_weather.test.mjs` recomputes it from the artifact's own
   published numbers and compares.
2. The grid is **immutable**: `adoption_rule.tests` is **10** and is the
   Bonferroni divisor, so grid *resolution* can never move a bar but a new
   *row* taxes every other row.
3. `scripts/archive_weather_forecast.py` starts accumulating pre-kickoff
   forecast rows on the daily cron, writing `data/weather_forecast_archive.json`
   from the first run after R94 — there is no such file before it. It pays back
   nothing for a full season.
4. **Extend the corpus backwards.** This is the single change that would most
   alter this document, because it buys **folds** as well as games: the fold
   clustering binds on all ten terms today and it binds because there are four
   of them. Blocked on stadium relocations and roof changes not being
   representable by the static `STADIUMS` table — deliberately not attempted
   here.
5. Re-measure `wind_epa_per_dropback` first when either of 3 or 4 lands. It is
   the term the model genuinely lacks, its ladder is the most physically
   convincing in the artifact, and it is the closest miss in the grid on both
   MDEs — 0.039903 modelled and 0.040479 realized against 0.033. Both have to
   come down; folds move the realized one, games move the modelled one.
6. Only then consider registering a weather family in
   `scripts/promote_signals.py`. **On today's evidence, step 6 should not
   happen** — and the closed-form reason is separate from the measurement: a
   game-side weather term has to clear the promotion gate's own threshold on
   Elo log-loss, which `data/model_tuning.json` records that the entire shipped
   QB1-out penalty does not do.

## Limits

Every sentence below is also a line of the artifact's own `limits` block.

* **`precip_mm` is one kickoff-hour value covering the PRECEDING hour.** A
  steady three-hour downpour and a wet hour that then cleared are
  indistinguishable here, and both attenuate a true effect toward zero. So the
  bound in **Verdict** is conservative in the wrong direction: the real effect
  could be larger than the measurement can see. The remedy — widen the fetch to
  kickoff..+3h — is deliberately **not** done, because it would red the closed
  `weather_history` schema and R56's exact-equality pins.
* **Snow is invisible.** It enters `precip_mm` only as liquid-water equivalent.
  The coldest and windiest game in the corpus, `2022|16|CLE|NO` at −14.5 °C and
  43.5 kph, records `precip_mm` **0.0**. Any wet-game classifier on this field
  silently excludes the games a fan would call the worst weather of the decade.
* **The venue filter marks venue, not roof state.** The archive carries the
  venue's roof *type*, never the roof's *behaviour* on the day.
* **Open retractables are never pooled**, because the decision to open a roof
  is itself a weather decision and pooling would import that selection.
* **Five seasons of open-roof home games generalise nowhere else**, and eight
  stadiums supply about three quarters of the windy games. Within-team-season
  estimation and stadium-clustered inference widen the interval; they do not
  manufacture representativeness.
* **The rate substrate is an nflverse release pull the repo does not perform on
  every run.** When it is absent — or when it is the committed synthetic
  placeholder — every rate term reports `substrate_unavailable` rather than
  measuring on hand-made numbers. An artifact from a fresh clone carries **no
  completion-rate finding at all**.
* **Four folds give three degrees of freedom** (see **Verdict**, point 3).
* **`power[].mde` and `terms[].mde_realized` are different quantities and both
  are published.** The first models the estimator, the second is the estimator.
  Where they disagree, `powered` takes the pessimistic one, because a term that
  can only be seen by one of the two readings cannot be said to be visible.
* **The placebo arm is a judgement call, not a randomised assignment.** Read a
  small placebo coefficient as weak reassurance and never as a clean bill of
  health — and read the one in this artifact, which is not small, as the
  warning it is.
* **A dropback is `attempts + sacks`.** A scramble in the rain leaves the
  passing denominator.
* **The REACH arm is one named slate.** Never a season-long frequency.
* **The CONTROL arm measures allocation, not level**, because the split
  renormalises to the player's season total.

## Files

| file | role |
|---|---|
| `scripts/weather_corpus.py` | the reader: the relocation filter, the roof census, the condition bands (`--selftest`, `--report`) |
| `scripts/weather_power.py` | measured ICC, design effect, MDE, `powered` — the stage that runs before any coefficient is fitted (`--selftest`) |
| `scripts/build_wet_rates.py` | the play-level rate substrate: the mechanism counters `weekly_actuals.json` throws away (`--selftest`, `--fixture-from-csv`) |
| `scripts/backtest_weather.py` | the measurement: ten terms, four arms, `would_adopt` (`--selftest`, `--cache-dir`, `--offline`, `--out`) |
| `scripts/archive_weather_forecast.py` | the append-only pre-kickoff forecast archive — the only route to a leakage-free phase 2 (`--selftest`, `--dry-run`) |
| `data/weather_backtest.json` | the artifact, runner-built and OPTIONAL: absent on a fresh clone, validated strictly whenever present |
| `data/weather_forecast_archive.json` | the append-only pre-kickoff forecast archive. **Not in the tree today.** It begins accumulating on the first daily cron after R94 and is the only route to a leakage-free phase 2; OPTIONAL, so its absence is not a gate failure |
| `data/fixtures/wet_rates/*.json` | the **synthetic** committed placeholder for the rate substrate. `build_wet_rates.py --selftest` asserts it stays synthetic, so the real pull must go to `--out-dir` outside the tree |
| `data/contracts/weather_backtest.schema.json` | its closed contract: `adopted` pinned `false`, `families_registered` `maxItems 0`, every estimate `["number","null"]` so an unestimable term is null and never 0 |
| `data/contracts/wet_rates.schema.json`, `data/contracts/weather_forecast_archive.schema.json` | the substrate and archive contracts, registered OPTIONAL in `scripts/validate_data.py` |
| `tests/feature/r94_weather.test.mjs` | the lock: power-is-blind, underpowered-cannot-adopt, grid immutability, `would_adopt` recomputed from the artifact, the fold barrier, the two-clustering rule, the corpus digest, that nothing live moved, and — added after the R94 audit — a season-by-season recount proving the power n is the ESTIMATION n, the two-MDE conjunction behind `powered`, that no `monotone: true` was decided by a band under `min_band_n`, and that each term's five band n's sum exactly to its own fitted row count |
| `docs/WEATHER_HORIZON.md` | R56: where the prediction-time weather feed comes from |
| `docs/SIGNAL_REGISTRY.md` | the `weather` signal's registry row |
