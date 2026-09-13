# LINE INJURY CASCADE (R70, phase 1 — measure first, annotate, adopt nothing)

## The owner's ask

> "If key offensive linemen are out, this could impact running back and QB
> performance. If key defensive linemen are out on the team they play against,
> it could help RB and QB."

Two cascades, both about **lines only** (OL and the DL front):

| cascade | who is out | who it touches | direction |
|---|---|---|---|
| `OL_OUT` | the player's **own** offensive-line starters | QB, RB (WR at half strength) | down |
| `DL_OUT` | the **opponent's** defensive-line-front starters | QB, RB | up |

Decision that stands: **measure first, ship on never-regress.** Phase 1 (this
release) measures both cascades walk-forward, ships a **LINE REPORT
annotation** that changes no number, and records the verdict. A learned line
factor reaches a projection only in phase 2, and only if a variant clears the
never-regress gate below.

## Data sources

| input | file / feed | what R70 added |
|---|---|---|
| Pregame report statuses, 2021-2025 | `data/injury_history.json` (`scripts/build_injury_history.py`, nflverse `injuries_{season}.csv`) | the filter admits OL (`T G C OL OT OG LT RT LG RG`) and the DL front (`DE DT NT DL EDGE LDE RDE LDT RDT`) beside QB/RB/WR/TE. **OLB is not front**: a 3-4 OLB is an edge rusher, a 4-3 OLB is a coverage linebacker, and the abbreviation cannot tell them apart. `--rebuild` re-pulls the immutable seasons once so they pick up the line rows. Skill rows are shaped exactly as before (same keys, same order). |
| Live report | `data/injuries.json` (`scripts/scrape/espn.py` -> `scripts/build_predictions.py`) | `position` (ESPN `athlete.position.abbreviation`) and `athlete_id` are carried **when the payload has them, null otherwise**, and only on request (`fetch_injuries(carry_positions=True)`) so the Rel17 row contract's default shape is untouched. |
| Starters | nflverse `depth_charts_{season}.csv` | read by `scripts/build_line_report.py` in both release shapes: 2025+ (`dt / team / pos_abb / pos_slot / pos_rank / player_name / gsis_id / espn_id`) and legacy (`week / club_code / position / depth_position / depth_team / full_name / gsis_id`, playoff charts dropped). |
| Corpus | `data/fixtures/backtest_weekly/{weekly_actuals,games_meta}.json` | unchanged; reused by import from `scripts/backtest_weekly.py`. |

Verified on the releases (2026-09-08): every team lists five OL starters
(`LT LG C RG RT`) and a three- or four-man front by scheme (`LDE NT RDE` for
a 3-4, `LDE LDT RDT RDE` for a 4-3). The injury releases spell linemen
`T / G / C / DE / DT / NT`.

**Upstream drift, documented:** the `--rebuild` pull found nflverse had
republished its 2025 injuries file since the committed pull. Three 2025 skill
rows changed `Out -> Doubtful` (KC wk 2 Xavier Worthy, NYG wk 7 Darius
Slayton, NYJ wk 4 Kene Nwangwu) and one row was added (PIT wk 6 Calvin Austin
III, Out). None are QB rows, so the `qb_out` family reads the same passers.
The committed file is the fresh pull, byte-for-byte what the builder writes.

## The LINE REPORT (annotation only)

`scripts/build_line_report.py` -> `data/line_report.json`
(contract `data/contracts/line_report.schema.json`):

```
{season, week, generated_utc, available, reason, source, snapshot, positions,
 teams: {TEAM: {ol: {starters, names, out, doubtful, questionable},
                dl: {...}}},
 counts: {teams, ol_starters, dl_starters, ol_out, dl_out, ol_doubtful,
          dl_doubtful, ol_questionable, dl_questionable, starters_matched}}
```

* Starters = the **latest** snapshot, rank 1, OL / DL-front positions, one
  entry per player.
* Join to the injury report: ESPN athlete id against the chart's `espn_id`
  when `injuries.json` carries `athlete_id`, else `(team, normalized name)`
  (`name_key`: lower-case, punctuation and Jr/Sr/II/III dropped). A starter
  the report does not list is ACTIVE by the report's construction.
* `out` = `OUT / IR / PUP / NFI / SUSPENDED`; `doubtful` and `questionable`
  are kept apart (both read as "Q" on the chip).
* **When the depth chart is unreachable** the document is
  `available: false` with the reason, `teams: {}` and zero counts. Never
  invented starters. `--offline` forces that path; `--selftest` runs a
  synthetic chart + report in memory.

### The chips (LINEUP, GRADE, PLAYERS)

One component, `.line-chip` (geometry of `.lu-bye`; meaning carried by the
text, never by colour alone; names on the title):

* `OL: 2 out` — the player's own line; `OL: 1 Q` when nobody is out but
  someone is doubtful/questionable; nothing when the line is healthy.
* `vs DL: 1 out` — the week's opponent's front, same rules.

Where: every offence starter row on **LINEUP** (`app/views/lineup.js`), every
starter row of every week fold on **GRADE** (`app/views/grade.js`), and the
AI+ THIS WEEK headline on **PLAYERS** (`app/views/players.js`, after the BASE
line in `.p-line` so the r51-pinned `.p-unit` order is intact). Each surface
carries a one-line legend **only while the report is on screen** stating that
the chips are facts that change no number. Nothing renders — no placeholder —
when the file is absent, `available: false`, or for another week.

`lineReportTeams` / `lineChipsHtml` live in `players.js` (GRADE imports them)
and again verbatim in `lineup.js`, because LINEUP must stay off `players.js`'s
import graph (the R25 perf budget); `tests/feature/r70_lines.test.mjs` locks
the two copies to identical output. PLAYERS fetches the report only when AI+
is the persisted view (or on the first toggle to it), so its cold BASE load
keeps its measured contract count; LINEUP's cold load goes 6 -> 7 contracts
(`tests/perf/budget.spec.mjs`).

## The experiment (`scripts/backtest_lines.py`)

Walk-forward on 2023-2025 (held-out 2025), on top of the shipped weekly split
exactly as `scripts/backtest_weekly.py` builds it (same pool, same fixed
season number, same as-of Elo / DvP / venue / weather, the deployed
`build_weekly.player_weeks` path). `v2` here **is** `weekly_split_v2`.

**Starter rule (history, walk-forward).** For team T in week `wk`: the N
players most often listed at rank 1 on an OL position across the season's
depth-chart snapshots with `week <= wk - STARTER_LAG` (default lag 1 = the
brief's "weeks < wk"; week 1 has no starters, is neutral and is counted), where
N is the modal number of rank-1 OL rows the team listed per snapshot. Same for
the DL front. 2025+ snapshots are dated (`dt`) and belong to the first week
whose first kickoff (`games_meta`) is after them; legacy snapshots carry
`week`. `--starter-lag 0` admits the same-week chart (pregame by
construction) and is reported below for reference.

**Counts.** `OL_out(T, wk)` = own OL starters listed **Out** on the final
report for (T, wk), capped at 3; `DL_out` likewise for the opponent's front.
Out only — Doubtful / Questionable are not absences. gsis ids join first,
name keys second; nothing is guessed.

**Variants.** `v2 x (1 - a x min(OL_out, 3) x {QB 1, RB 1, WR 0.5, TE 0}) x
(1 + b x min(DL_out, 3) x {QB 1, RB 1, WR 0, TE 0})`, `a, b in {0, .02, .04,
.06}`, `(0, 0)` excluded — 15 variants, so each cascade is measured alone.
Applied post-split without renormalisation (phase 2 would put the factor
inside `build_weekly`'s chain, where the season total is renormalised).

**Metrics.** The harness's own: pooled and held-out MAE / rank corr / top-K,
per-position MAE and rank corr, a paired season-week block bootstrap of
`MAE(variant) - MAE(v2)` on 2025 (B = 400, fixed seed), and the **raw ratio
table** `actual / v2` by "own OL starters out" and "opposing DL starters out"
bucket per position — the effect, visible before any factor.

**Never-regress (per variant).** Adoptable only if pooled MAE <= v2's **and**
pooled rank_corr >= v2's. Phase 1 adopts nothing regardless; the artifact
records which variants would have cleared.

Runner:

```
python3 scripts/build_injury_history.py --rebuild      # once: 2021-2025 with linemen
python3 scripts/backtest_lines.py [--cache-dir DIR] [--starter-lag 0|1] [--out PATH]
```

Exit 2, with the missing input named and **no result written**, when
`injury_history.json` carries no line rows for a scored season or a
depth-chart release is unreachable.

## Results (measured 2026-09-09 and reproduced 2026-09-13; deterministic)

Committed corpus, `injury_history.json` rebuilt with linemen, nflverse depth
charts 2023-2025. 8,279 player-weeks; OL / DL counts known for 7,752 (week 1
of each season is neutral under lag 1).

Raw ratio `actual / v2` (lag 1):

| own OL starters out | QB | RB | WR | TE |
|---|---|---|---|---|
| 0 | 0.988 (n=899) | 0.975 (1884) | 0.927 (2413) | 0.972 (993) |
| 1 | 0.979 (180) | 1.009 (426) | 0.896 (577) | 1.019 (234) |
| 2 | 0.940 (15) | 0.862 (43) | 0.788 (58) | 1.093 (25) |

| opposing DL-front starters out | QB | RB | WR | TE |
|---|---|---|---|---|
| 0 | 0.987 (972) | 0.974 (2091) | 0.925 (2721) | 0.982 (1110) |
| 1 | 0.970 (117) | 1.032 (246) | 0.868 (312) | 0.993 (135) |
| 2 | 1.028 (5) | 1.013 (17) | 0.803 (18) | 0.990 (8) |

Incumbent `v2`: pooled MAE 6.0030, rank corr 0.3814, top-K 0.7836; held-out
2025 MAE 6.0790, rank corr 0.3517.

| variant | pooled MAE | pooled rank | held-out MAE | boot dMAE 2025 [95%] | verdict |
|---|---|---|---|---|---|
| ol0.02_dl0.00 | 5.9969 | 0.3805 | 6.0740 | -0.0050 [-0.0094, -0.0006] | regresses (rank) |
| ol0.04_dl0.00 | 5.9913 | 0.3806 | 6.0695 | -0.0095 [-0.0185, -0.0009] | regresses (rank) |
| ol0.06_dl0.00 | 5.9863 | 0.3799 | 6.0657 | -0.0133 [-0.0269, -0.0002] | regresses (rank) |
| ol0.00_dl0.02 | 6.0051 | 0.3814 | 6.0818 | +0.0029 [+0.0010, +0.0049] | regresses (MAE) |
| ol0.00_dl0.04 | 6.0075 | 0.3815 | 6.0851 | +0.0062 [+0.0023, +0.0100] | regresses (MAE) |
| ol0.00_dl0.06 | 6.0101 | 0.3812 | 6.0884 | +0.0095 [+0.0037, +0.0154] | regresses (MAE) |
| ol0.04_dl0.04 | 5.9956 | 0.3810 | 6.0751 | -0.0039 [-0.0118, +0.0048] | regresses (rank) |

Full 15-variant table: `data/lines_backtest.json`. **Verdict: 0 of 15
variants clear never-regress.** Lag 0 (same-week chart, 8,279 rows covered)
gives the same picture: best OL-only MAE 5.9870 / rank 0.3796, 0 of 15.

What the numbers say, honestly:

* **OL out, QB:** monotone in the right direction (0.988 -> 0.979 -> 0.940)
  but two-out weeks are rare (n = 15).
* **OL out, RB:** one starter out shows **no** dip (1.009 vs 0.975); two out
  shows a large one (0.862, n = 43). The cascade looks non-linear — a single
  replacement lineman is absorbed, two are not — which a linear `1 - a x n`
  does not fit.
* **OL out, WR:** dips at 1 and 2 (0.896, 0.788) even at half strength.
* **DL out, RB:** the only clean "help" (1.032 at one out, n = 246). **DL
  out, QB:** no help (0.970). Every `b > 0` variant raises MAE.
* Every OL variant **wins MAE** (bootstrap CIs exclude zero for the a-only
  variants) but **loses rank correlation** by 0.001-0.002 — a shrink that
  helps the level does not help the ordering. Note the level: `actual / v2`
  is below 1 in every bucket, so part of the MAE gain is generic shrinkage,
  not the cascade.

## Phase 2 — what would change a number, and the gate

Nothing in this release moves a projection. If phase 2 proceeds it must:

1. wait for partition A's weekly-harness changes to merge and re-run
   `backtest_lines.py` on that substrate;
2. try the shapes the table suggests rather than the linear grid: a
   threshold at two OL starters out (RB/QB), an RB-only `DL_out` term, and
   the factor placed inside `build_weekly`'s chain (renormalised);
3. adopt a variant **only** if it is not worse than the incumbent on pooled
   MAE **and** pooled rank corr (`NEVER_REGRESS_RULE` in the artifact), with
   the weight at 0 until then — the owner's standing rule;
4. keep the LINE REPORT chip as-is; it is a fact either way.

## Operational wiring (owned by the orchestrator this release)

`scripts/validate_data.py` — register the contract (in `SCHEMA_FOR`):

```
    # R70 — the OL / DL-front LINE REPORT: facts (depth-chart starters x injury
    # report) read by the LINEUP / GRADE / PLAYERS chips; changes no number.
    # Runner-built; the honest available:false document is also valid.
    "line_report.schema.json": "line_report.json",
```

and in `OPTIONAL_DATA` (first build happens on the runner):

```
    "line_report.json",
```

`.github/workflows/daily.yml` — after the injuries feed is written (i.e.
after `python -m scripts.build_predictions`):

```yaml
      # R70 — the OL / DL-front LINE REPORT for the week (annotation only, changes
      # no number). Best-effort: an unreachable depth chart writes the honest
      # available:false document, never invented starters.
      - name: Build the line report (OL / DL-front starters x injury report)
        run: python scripts/build_line_report.py
        continue-on-error: true
```

and, optionally, after the weekly never-regress backtest:

```yaml
      # R70 — line-injury cascade measurement (writes data/lines_backtest.json;
      # adopts nothing). Exit 2 = an input is missing, no result invented.
      - name: Line-injury cascade backtest (measure only)
        run: python scripts/backtest_lines.py
        continue-on-error: true
```

`tests/smoke.sh` — beside the other pipeline selftests:

```
python3 scripts/build_line_report.py --selftest || fail "line report selftest"
python3 scripts/backtest_lines.py --selftest || fail "lines backtest selftest"
```

## Tests

* `tests/feature/r70_lines.test.mjs` — position admission and skill-row
  identity; the feed's optional position carry-through (default shape
  unchanged); the line report from a synthetic chart (both shapes, ESPN-id
  join, the unavailable path) and the committed document against its
  contract; the measurement's verdict shape on a synthetic corpus with a
  planted OL effect, and the committed artifact's verdicts against its own
  numbers; the two chip-helper copies locked to identical output; the
  PLAYERS splice leaving the r51 `.p-unit` order intact; the wiring.
* `tests/web/r70_lines.spec.mjs` — LINEUP / GRADE / PLAYERS with
  `data/line_report.json` stubbed via `page.route`: chips and legend render
  for the week on screen, nothing for another week, nothing on a 404.
