# BACKUP-QB CASCADE (R92 part C, phase 1 — measure first, adopt nothing)

## The owner's order

> 2026-09-20: "a drop when QB1 is out, another when QB2 is out, then the
> capability of the replacement — applied to key positions and carried into the
> PLAYER, game, week and MY parlay numbers."

This part is the **PLAYER** side of that order: what happens to a team's
receivers and backs (and to the quarterback slot itself) when the starting
quarterback is out, measured walk-forward on the shipped weekly number,
player-week by player-week.

Decision that stands, unchanged from R70: **measure first, ship on
never-regress.** Phase 1 (this release) measures the cascade and records the
verdict. A backup-QB factor reaches `scripts/build_weekly.py` — and therefore
the leg pool, the parlays and MY — only in phase 2, and only if a candidate
clears the weekly never-regress gate. Nothing in this release moves a number;
`tests/feature/r92_backup_qb.test.mjs` fails if `build_weekly.py` so much as
mentions `backup_qb`.

## Definitions

| term | definition |
|---|---|
| **the room** | The team's quarterbacks in depth-chart `rank` order, from the **latest snapshot whose week is `<= wk - 1`** (strictly before the week). One entry per player. Week 1 of every season therefore has no room. |
| **out** | Listed **Out or Doubtful** on the **final** injury report for that (team, week) — the owner's wording. Questionable is not an absence. |
| **QB1 / QB2** | Rank 1 and rank 2 of the room. |
| **expected starter** | The highest-ranked quarterback in the room who is not out. `None` when every listed quarterback is out. |
| **condition** | `qb1` (QB1 is not out — the baseline), `backup` (QB1 out, expected starter is QB2), `qb3_plus` (QB1 **and** QB2 out), `unknown` (no room was knowable). A team-week property, applied to every scored player of that team. |
| **capability** | EPA per dropback over the passer's most recent **600 dropbacks strictly before the week** (`data/epa_history.json` `passers`). Under **100** trailing dropbacks there is no measured capability. |
| **replacement level** | The fold's pooled EPA per dropback over every passer-season **before the scored season** that never reached 200 dropbacks — the league's non-starters. It stands in wherever capability is unmeasured. Measured at **-0.130 / -0.137 / -0.137** EPA per dropback for the 2023 / 2024 / 2025 folds. |
| **`cap_gap`** | `capability(QB1) - capability(expected starter)`, in EPA per dropback. **0** when QB1 starts. Positive = the replacement is worse. |

## Sources

| input | file / feed |
|---|---|
| Shipped weekly number (`v2`) | `scripts/build_weekly.player_weeks` through `scripts/backtest_weekly.py`'s as-of harness — same corpus, same pool, same fixed season number, same as-of Elo / DvP / venue / weather. `v2` here **is** `weekly_split_v2`. |
| Corpus | `data/fixtures/backtest_weekly/{weekly_actuals,games_meta}.json` (unchanged, imported) |
| The room | nflverse `depth_charts_{season}.csv`, both release shapes, via `build_line_report.fetch_depth_chart` (`--cache-dir`) |
| Statuses | `data/injury_history.json` (QB rows carry gsis ids) |
| Capability | `data/epa_history.json` `seasons[yr][team][wk].passers {gsis_id: {db, epa, name}}` |

Joins are **gsis id first, name key second, never guessed**. The book lines in
`games_meta` are not read — not for a projection, not for a metric.

## The walk-forward rule

Three things are held to "knowable before kickoff", and each is tested:

1. **The room** comes from a snapshot strictly before the week. The 2025+
   release is dated per snapshot (`dt`) and belongs to the first week whose
   first kickoff is after it; the legacy release is dated per `week`. A week
   with no earlier snapshot is `unknown`, neutral, and **counted** — never
   filled in from a later chart.
2. **Capability** reads only dropbacks before the week, and the replacement
   pool only seasons before the scored season.
3. **Every candidate parameter** is fitted on the scored seasons **before** the
   season it is scored on. The earliest scored season (2023) has no prior fold
   and is therefore exactly the shipped number; 2024 fits on 2023; 2025 fits on
   2023-2024.

The fit itself removes the fold's position-level bias first:
`base = sum(actual) / sum(v2)` over that fold's `qb1` rows. That subtraction is
the point — `actual / v2` sits below 1 in almost every bucket of this corpus, so
a factor fitted on backup rows alone would absorb `v2`'s generic level and read
as a cascade it is not. A fold with fewer than **25** backup rows fits nothing
and stays neutral; every applied factor is clamped to `[0.5, 1.5]`.

## Results (measured 2026-09-20; deterministic)

Committed corpus, nflverse depth charts 2023-2025. **8,279 player-weeks**; the
room was known for **7,752** (week 1 of each season is `unknown` under lag 1),
`cap_gap` known for the same 7,752, of which **117** used the replacement pool
on one side.

### n per condition per position per season

| pos | 2023 qb1 / backup / qb3+ / unknown | 2024 | 2025 |
|---|---|---|---|
| QB | 338 / 4 / 0 / 26 | 359 / 4 / 0 / 26 | 382 / 7 / 0 / 28 |
| RB | 757 / 33 / 0 / 50 | 741 / 31 / 0 / 52 | 740 / 50 / 2 / 52 |
| WR | 1009 / 48 / 0 / 67 | 992 / 19 / 0 / 71 | 901 / 81 / 1 / 67 |
| TE | 393 / 22 / 0 / 28 | 401 / 17 / 0 / 30 | 395 / 25 / 0 / 30 |

77 backup-start team-weeks across three seasons. **QB3-or-deeper is all but
absent** (three player-weeks, one team-week): the condition is reported with its
n and nothing is concluded from it.

### Residual `actual - v2` by condition (PPR points)

| pos | condition | n | mean residual | MAE | actual / v2 |
|---|---|---|---|---|---|
| QB | qb1 | 1079 | -0.33 | 6.72 | 0.980 |
| QB | backup | 15 | +6.80 | 8.08 | **1.641** |
| RB | qb1 | 2238 | -0.19 | 5.94 | 0.982 |
| RB | backup | 114 | -0.69 | 6.23 | **0.928** |
| RB | qb3_plus | 2 | -0.34 | 10.20 | 0.966 |
| WR | qb1 | 2902 | -0.91 | 6.24 | 0.923 |
| WR | backup | 148 | -1.77 | 5.97 | **0.842** |
| WR | qb3_plus | 1 | -7.29 | 7.29 | 0.180 |
| TE | qb1 | 1189 | -0.10 | 5.15 | 0.989 |
| TE | backup | 64 | -1.15 | 4.45 | **0.873** |

Relative to each position's own baseline, a backup start is worth about
**-5.5% RB**, **-8.8% WR**, **-11.7% TE** — and **+67% QB**, which is the
opposite mechanism and not a cascade (see limits).

### As a function of `cap_gap` (`actual / v2`)

| pos | none (QB1) | neg | 0.00-0.05 | 0.05-0.15 | 0.15+ |
|---|---|---|---|---|---|
| QB | 0.980 (1079) | 1.573 (3) | 2.000 (2) | 1.496 (1) | 1.599 (9) |
| RB | 0.982 (2238) | 1.309 (37) | 1.560 (14) | 0.905 (16) | **0.639 (49)** |
| WR | 0.923 (2902) | 0.833 (63) | 1.078 (13) | 0.888 (16) | **0.769 (57)** |
| TE | 0.989 (1189) | 0.796 (19) | 1.191 (8) | 0.935 (9) | **0.824 (28)** |

RB is the clean one: monotone across the three positive buckets and a 36% hole
at `cap_gap >= 0.15`. WR and TE are noisy in the middle but lowest at the top
bucket. The `neg` column (the replacement grades out **better** than the man he
replaces) is not a wrong-signed cascade so much as a mixed bag: it holds both
genuinely better backups and quarterbacks whose trailing EPA was bad.

### Component yards (raw means; there is no shipped yards projection)

| pos | condition | n | rush yds (vs qb1) | rec yds (vs qb1) | pass yds (vs qb1) |
|---|---|---|---|---|---|
| RB | qb1 | 2238 | 45.9 | 15.3 | — |
| RB | backup | 114 | 39.4 (**0.859**) | 12.6 (**0.821**) | — |
| WR | qb1 | 2902 | — | 50.1 | — |
| WR | backup | 148 | — | 45.2 (**0.903**) | — |
| TE | qb1 | 1189 | — | 37.3 | — |
| TE | backup | 64 | — | 34.9 (**0.937**) | — |
| QB | qb1 | 1079 | 16.6 | — | 222.6 |
| QB | backup | 15 | 14.1 (0.852) | — | 239.6 (1.076) |

The pass-catching side moves more than the rushing side for backs (0.821 vs
0.859) — the backup's receptions go first, which is what a shorter, more
conservative passing game does to a back's PPR line.

### Candidates (fitted walk-forward, scored against the shipped number)

Shipped `weekly_split_v2`: pooled MAE **6.0030**, rank corr **0.3814**, top-K
0.7836; held-out 2025 MAE 6.0790, rank corr 0.3517.

| candidate | pooled MAE | pooled rank | dMAE | d rank | boot dMAE [95%] | rows moved | would_adopt |
|---|---|---|---|---|---|---|---|
| cap_gap_QB | 6.0030 | 0.3814 | +0.0000 | +0.0000 | +0.0000 [+0.0000, +0.0000] | 0 | false (no-op) |
| **cap_gap_RB** | **5.9971** | **0.3821** | **-0.0060** | **+0.0007** | -0.0062 [-0.0137, +0.0012] | 83 | **true** |
| cap_gap_WR | 6.0031 | 0.3809 | +0.0001 | -0.0005 | -0.0001 [-0.0057, +0.0050] | 101 | false |
| cap_gap_TE | 6.0037 | 0.3810 | +0.0007 | -0.0004 | +0.0007 [+0.0001, +0.0013] | 25 | false |
| cap_gap_ALL | 5.9978 | 0.3812 | -0.0052 | -0.0002 | -0.0055 [-0.0151, +0.0040] | 209 | false (rank) |
| backup_flat_QB | 6.0030 | 0.3814 | +0.0000 | +0.0000 | +0.0000 [+0.0000, +0.0000] | 0 | false (no-op) |
| backup_flat_RB | 6.0049 | 0.3811 | +0.0019 | -0.0002 | +0.0019 [-0.0008, +0.0046] | 83 | false |
| **backup_flat_WR** | **6.0005** | **0.3816** | **-0.0025** | **+0.0002** | -0.0025 [-0.0057, +0.0004] | 101 | **true** |
| backup_flat_TE | 6.0021 | 0.3813 | -0.0009 | -0.0000 | -0.0009 [-0.0023, +0.0004] | 25 | false |
| backup_flat_ALL | 6.0015 | 0.3813 | -0.0015 | -0.0000 | -0.0015 [-0.0073, +0.0039] | 209 | false (rank) |

`ci` is a paired season-week block bootstrap (B = 400, fixed seed) of
`MAE(candidate) - MAE(shipped)` over the scored seasons; the artifact also
carries the held-out-only bootstrap as `ci_held_out`.

Fitted parameters, per fold (2023 is neutral — no prior fold):

| candidate | fold 2024 (fits 2023) | fold 2025 (fits 2023-24) | fit n (2024 / 2025) |
|---|---|---|---|
| cap_gap RB (beta) | -2.276 | -1.759 | 33 / 64 |
| cap_gap WR (beta) | -0.218 | -1.161 | 48 / 67 |
| cap_gap TE (beta) | neutral (22 rows < 25) | +0.152 | 22 / 39 |
| backup_flat RB (m) | 1.141 | 0.922 | 33 / 64 |
| backup_flat WR (m) | 1.065 | 0.912 | 48 / 67 |
| backup_flat TE (m) | neutral (22 rows < 25) | 0.895 | 22 / 39 |
| either QB | neutral (4 rows) | neutral (8 rows) | 4 / 8 |

**Verdict: 2 of 10 candidates clear never-regress** — `cap_gap_RB` (best by
pooled MAE) and `backup_flat_WR`. **Phase 1 adopts nothing.**

What the numbers say, honestly:

* The **effect is real and correctly signed** in the residual table for RB, WR
  and TE, and it scales with `cap_gap` at the top bucket for all three.
* The **gain is tiny**: the best candidate takes 0.006 PPR points off a pooled
  MAE of 6.00 — one part in a thousand — because only ~100 of 8,279 rows move.
  A factor can be right and still be nearly invisible in a pooled metric.
* The **bootstrap CI crosses zero** for both adoptable candidates. Neither
  improvement is distinguishable from noise on this corpus.
* The **parameters flip sign between folds** (RB `m` 1.141 then 0.922; WR beta
  -0.218 then -1.161). With 20-50 backup rows a fold, the fit is not yet stable,
  and a parameter that changes sign is not ready to price anything.
* The **QB rows go the other way** (`actual / v2` = 1.64). That is not the
  cascade: condition is a team property, so a QB row on a backup week is
  usually the replacement himself, whose shipped number is his own low
  prior-season baseline and who then plays a full game. It is a real effect and
  a separate one; `qb_subject_rows` in the artifact counts the two apart.
* **`_ALL` loses on rank correlation** even though it wins MAE — the same
  pattern R70 found for the line cascade. Moving the level of a handful of rows
  helps the level and does not help the ordering.

## The adoption path (phase 2), and what it would carry

`scripts/build_weekly.py` composes a player-week as
`base x D x T x W x V`, renormalised over the team's scheduled weeks
(`player_weeks`, `week_multiplier`). A backup-QB factor belongs in that chain as
one more multiplicative term **behind a gate**, not post-split as it is applied
here — inside the chain the season total is renormalised, so a week discounted
for a backup start pushes its points into the team's other weeks instead of
vanishing.

Because the weekly number is what everything downstream prices from, adopting it
there carries it automatically into:

* **PLAYER / LINEUP / GRADE** — the weekly projection on screen;
* **`scripts/build_leg_pool.py`** → `data/leg_pool.json` — candidate legs are
  priced off the weekly number;
* **`scripts/build_my_cards.py` / the parlays** — MY cards and parlay legs
  inherit whatever the leg pool prices;
* the **game / week** numbers on the other side of this release (parts A and B).

That reach is exactly why the gate is what it is. Phase 2 may proceed only when
**all** of these hold:

1. the factor sits inside `build_weekly`'s chain (renormalised), gated off by
   default, with the weight at 0 until the gate says otherwise;
2. `scripts/backtest_weekly.py`'s never-regress gate is re-run **on that
   substrate** and the candidate is not worse on pooled MAE **and** pooled rank
   corr — the owner's standing rule;
3. the fitted parameter is **stable across folds** (it is not yet) and its
   bootstrap CI excludes zero (it does not yet);
4. the shape is tried the way the table suggests rather than the way it was
   first written: a `cap_gap` term for RB (the monotone one), a threshold at
   `cap_gap >= 0.15` rather than a line through the noisy middle, and the QB
   slot handled by its own mechanism (playing time), never by the receiver
   cascade;
5. `scripts/promote_signals.py` and the signal registry record it like any other
   earned signal.

Until then the artifact is a measurement and nothing reads it.

## Running it

```
python3 scripts/backtest_backup_qb.py --selftest                  # offline, exit code only
python3 scripts/backtest_backup_qb.py [--cache-dir DIR] [--starter-lag 0|1] [--out PATH]
```

Writes `data/backup_qb_backtest.json` (contract
`data/contracts/backup_qb_backtest.schema.json`, strict). Exits **2**, with the
missing input named and **no result written**, when `injury_history.json` carries
no QB rows for a scored season, when `epa_history.json` carries no passer rows
before the first scored season, or when a depth-chart release is unreachable.
Nothing is invented in any of those cases.

Artifact shape:

```
{generated_utc, experiment, model_incumbent, seasons_scored, held_out, substrate,
 starter_rule, capability_rule, fit_rule, coverage, conditions, qb_subject_rows,
 residuals, residuals_by_cap_gap, components, shipped, candidates, verdict,
 policy, limits, meta}
```

## Limits (also carried in the artifact)

* The final report lists a quarterback only when the team reports him. A QB1 on
  injured reserve for a long stretch can stop appearing weekly, so some backup
  starts are read as `qb1`. Those weeks **dilute the baseline**, they do not
  inflate the effect.
* Out means Out or Doubtful. A game-time scratch listed Questionable is scored
  as `qb1` — the pregame report is the only thing knowable before kickoff, and
  the inactive list is not.
* QB3-or-deeper starts are almost absent here (n = 3 player-weeks). Reported,
  not concluded from.
* Condition is a **team**-week property, so a QB row under `backup` is usually
  the replacement himself. Different mechanism; `qb_subject_rows` separates them.
* The corpus carries component yards but the shipped weekly number is PPR points
  only, so the component tables are raw means and a ratio against the `qb1`
  baseline — never a residual against a projection that does not exist. A ratio
  is suppressed where the baseline is under one yard.
* Week 1 of every season has no room under starter lag 1 and is `unknown`,
  neutral for every candidate. `--starter-lag 0` admits the same-week chart.
* Parameters are fitted by least squares on the shipped scale, which weights
  high-scoring rows more than the MAE the gate scores. A median-ratio fit would
  trade level accuracy for rank accuracy and is not tried here.
* 2023 has no prior fold, so every candidate is the shipped number there. Its
  rows still count in the pooled metrics, which is why a pooled delta is smaller
  than the per-fold deltas that produced it.

## Tests

`tests/feature/r92_backup_qb.test.mjs` — the selftest (a synthetic corpus with a
planted backup dip of known size); the room read strictly before the week and
Out/Doubtful-only statuses; trailing capability, the replacement pool and an
absent `cap_gap` that stays `None`; the fold fit recovering a toy fold's answer
to the digit, staying neutral when thin and clamping a wild one; a boolean
`would_adopt` per candidate that follows the artifact's own pooled numbers, with
a no-op never adoptable; the committed artifact against its strict contract; and
`build_weekly.py` plus the whole `app/` tree free of `backup_qb`.

## Operational wiring (owned by the orchestrator this release)

`scripts/validate_data.py` — register the contract (in `SCHEMA_FOR`, beside the
other backtest records) and in `OPTIONAL_DATA`; `tests/smoke.sh` — the selftest
line. Both exact lines are in the part-C hand-off.
