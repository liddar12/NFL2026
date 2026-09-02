# MODEL tab — the R51 gate cards

Two cards on `#/model` (app/views/model.js) render the never-regress backtest
records that the R51 weekly-split and parlay work produces. This note is the
contract between the producers, the validator and the view.

## Where they sit

Reading order on the tab (each line is one `.mcard`; the extra class is the
selector tests use):

1. DATA FRESHNESS `.m-fresh`
2. ADOPTED PARAMETERS `.m-params`
3. BACKTEST · WALK-FORWARD `.m-backtest`
4. PROMOTION GATE · CANDIDATE FAMILIES `.m-gate`
5. MARKET YARDSTICK `.m-mkt`
6. CALIBRATION `.m-cal`
7. **WEEKLY SPLIT GATE · CANDIDATE vs INCUMBENT** `.m-weekly-gate` (R51)
8. **PARLAY GATE · MONEYLINE · SPREAD · PROPS** `.m-parlay-gate` (R51)
9. SEASON LOCKS `.m-locks`
10. PLAYOFF ODDS `.m-playoffs`
11. SIGNAL REGISTRY `.m-signals`
12. PROJECTION BASELINE `.m-baseline` (R49, omitted on an older meta)
13. LEARNING RECORD `.m-learning` (R49, omitted on an older meta)

The two new cards close the MEASURED cluster (everything that reports results
on real FINAL games or player-weeks) and sit before the status and
forward-looking cards. Both wear the MEASURED stamp; neither ever wears
ESTIMATE.

## The three states (owner policy, mechanical)

| File on the deploy | What renders |
| --- | --- |
| absent (404) or unparseable | **Nothing.** The loader resolves to `null`, the painter returns `''`, the mount omits the card. No placeholder shell, no header, no `.state` line. |
| present, verdict missing | An **AWAITING** state: the header row with a `gate-chip--skipped` AWAITING chip and a `.state` line saying the record carries no verdict. None of the record's numbers are shown, because without a verdict nothing on it has been judged. |
| present, verdict carried | The full card (below). |

"Verdict missing" means, for the weekly record, `verdict.adopted` is not a
boolean; for the parlay record, `spread.verdict` is not one of `no_edge` /
`edge` **or** `props.verdict.adopted` is not a boolean. A string `"true"` is
not a verdict.

Every market number on either card is a yardstick and is labelled
**MEASUREMENT ONLY** (`.ms-badge`, the app-wide display-only convention). No
number on either record is an input to a projection, a model weight, a
ranking or a parlay probability; `scripts/validate_data.py` enforces the
boundary on every model output independently of this view.

## Loaders (app/data.js)

```js
loadWeeklyBacktest()  // -> doc | null   (/data/weekly_backtest.json)
loadParlayBacktest()  // -> doc | null   (/data/parlay_backtest.json)
```

Unlike the other getters these never reject: a 404 or a parse error resolves
to `null`. They share the promise cache, and a failed fetch evicts its entry
so the next mount retries. Both ride the model mount's `Promise.allSettled`,
so `#/model` fetches 8 contracts cold (was 6) — recorded in
`tests/perf/budget.spec.mjs` with both files on `CONTRACT_ALLOWLIST`.

## Producers and validation

| File | Producer | Schema |
| --- | --- | --- |
| `data/weekly_backtest.json` | `scripts/backtest_weekly.py` | `data/contracts/weekly_backtest.schema.json` |
| `data/parlay_backtest.json` | `scripts/backtest_parlay.py` | `data/contracts/parlay_backtest.schema.json` |

Both scripts are run by the gate and by the daily workflow (the R51 pipeline
partition wires them; this document describes the records they write, not
the schedule). Both files are registered **OPTIONAL** in
`scripts/validate_data.py` (`SCHEMA_TO_DATA` + `OPTIONAL_DATA`): a clone
without them is not red, a present file is validated strictly against its
schema. The schemas require and type every key the cards read; extra
diagnostic keys are tolerated so a producer can add measurements without
redding the gate. Both corpora are the committed fixtures under
`data/fixtures/backtest_weekly/`.

Sample documents carrying the contract's expected values live at
`tests/fixtures/r51/weekly_backtest.sample.json` and
`tests/fixtures/r51/parlay_backtest.sample.json`. They are test fixtures
only — never copy them into `data/` on a branch; that would be fabricated
provenance.

## WEEKLY SPLIT GATE — `data/weekly_backtest.json`

Contract (every key required):

```
generated_utc, model_candidate ("weekly_split_vN"), model_incumbent ("weekly_split_vN")
fixture: {weekly_actuals, games_meta, seasons_scored[], rows, pool: {QB, RB, WR, TE}}
season_number_rule
pooled:        {v1: {mae, rank_corr, topk}, v2: {…}}
held_out_2025: {v1: {mae, rank_corr, topk}, v2: {…}}
per_position:  {QB|RB|WR|TE: {v1: {mae, rank_corr}, v2: {…}}}
band:      {rule, v1: {coverage_2025, half_width_2025}, v2: {…}}
bootstrap: {delta_mae_2025: {mean, lo95, hi95, blocks, B}}
factors:   {dvp: {shrink, source}, elo_tilt_positions[], weather: {pass_dome,
            pass_outdoors, pass_cold_extra, rb_wind, cold_f, wind_mph},
            venue: {coef, rel_clamp[2], shrink_n0}}
verdict:   {adopted: boolean, rule, reason}
policy
```

Rendered, top to bottom:

- explanation (`.m-explain`): what is measured and which direction is good;
- header row (`.gate-row`): `candidate vs incumbent` · seasons scored · row
  count · **ADOPTED** (`gate-chip--adopted`) or **RETAINED** (plain
  `gate-chip`);
- metric table (`.pf-tbl`): POOLED and 2025 HELD OUT × MAE (3 dp), RANK
  CORR (3 dp), TOP-K (percent, 1 dp), columns V1 / V2 / Δ V2−V1. The delta
  carries the good-direction mark: ▲ moved the good way (lower MAE, higher
  rank corr / top-K), ▼ regressed, = unchanged after rounding;
- per-position table (`.pf-tbl`): MAE and rank corr `v1 → v2` with the mark;
- BAND line (`.gate-bench`): 2025 coverage and half-width, v1 → v2, the rule;
- BOOTSTRAP line: ΔMAE 2025 mean and 95% interval, block unit, B;
- FACTORS line: DvP shrink and source, Elo tilt positions, the four weather
  multipliers with their cold / wind thresholds, the venue coefficient with
  its clamp and shrink;
- NEVER-REGRESS RULE (`.mp-src`) and the reason (`.gate-note`), the season
  numbering rule, then run date · pool · policy.

## PARLAY GATE — `data/parlay_backtest.json`

Contract (every key required):

```
generated_utc, fixture: {games_meta, weekly_actuals, seasons[]}
moneyline: {n, incumbent_log_loss, incumbent_brier, market_log_loss, market_brier,
            per_season: {<season>: {incumbent_log_loss, market_log_loss}}, note}
spread:    {n, sigma, model_cover_log_loss, flat_log_loss, model_brier,
            pick_hit_rate_by_conviction: [{bin, n, hit}], verdict: "no_edge"|"edge", reason}
props:     {lines: {QB, RB, WR}, residual_sd: {QB, RB, WR}, dvp_shrink,
            folds: [{season, fit_seasons[], seed: {log_loss, brier, hit_rate, picks,
                     hit_rate_60, picks_60}, calibrated: {…same keys…}}],
            calibration: {QB|RB|WR: {a, b, c, fit_seasons[]}},
            verdict: {adopted: boolean, rule, reason}}
correlations: {pairs: [{key "a|b", label, rho, n, prior}], default_rho, method}
policy
```

Rendered, top to bottom:

- explanation (`.m-explain`);
- MONEYLINE row (`.gate-row`): ours log-loss (4 dp) and Brier (4 dp) · market
  log-loss and Brier · **MEASUREMENT ONLY** badge in the verdict column — the
  market row has no verdict by contract, it is the yardstick. Below it n and
  the per-season pairs (`.gate-bench`) and the record's note (`.gate-note`);
- SPREAD row: model cover log-loss and Brier · flat log-loss and σ · **NO
  EDGE** (`gate-chip--nopath`, dashed, reason in its title) or **EDGE**
  (`gate-chip--adopted`). Below it the hit rate by conviction bin as an inline
  list (percent, 1 dp, with n) and the reason;
- PROPS row: the lines and residual sd per position · **ADOPTED** /
  **RETAINED**. Below it the folds table (`.pf-tbl`): per fold seed → calibrated
  log-loss with the mark, hit rate (picks) seed → calibrated, the >0.6 bucket
  hit rate (picks) seed → calibrated; then the CALIBRATION line (a, b, c per
  position with fit seasons, DvP shrink), the rule and the reason;
- CORRELATIONS table (`.pf-tbl`): LEG PAIR (label) · ρ (2 dp) · N · PRIOR, then
  the default ρ and the method;
- run date · seasons, and the record's policy line.

## Formatting and safety rules

- log-loss / Brier 4 dp; MAE / rank corr / bootstrap 3 dp; half-width 2 dp;
  rates and coverage as percent 1 dp; ρ and priors 2 dp; negatives use a real
  minus sign; a missing number renders `—`, never `0` or `NaN`.
- Every string from a record passes through the view's `esc` helper. No
  inline styles; only classes theme.css / theme-hig.css already style
  (`.gate-row`, `.gate-chip*`, `.gate-bench`, `.gate-note`, `.pf-tbl`,
  `.mp-src`, `.m-explain`, `.ms-badge`, `.state`).

## Tests

- `tests/feature/r51_model.test.mjs` — both painters against the sample docs
  (values, chips, badge, deltas), `''` for null, AWAITING without a verdict,
  escaping, the loaders' null-on-404/parse-error behaviour against a stubbed
  fetch, mount placement, and both schemas through the validator's own
  `validate_against_schema` (accept the sample, reject mistyped verdicts,
  calibration coefficients, correlation pairs).
- `tests/web/r51_model.spec.mjs` — `#/model` in the ABSENT, PRESENT and
  AWAITING states with the files routed, plus the committed data unrouted.
- `tests/perf/budget.spec.mjs` — the model route's cold contract count (8)
  and the allowlist entries.
