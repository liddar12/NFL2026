# Rel18 — Backtesting Upgrade: Engineering Design

**Role:** Backtest / Evaluation Engineer
**Date:** 2026-08-13
**Governing constraint:** Rel18 must **improve backtesting**.
**Scope:** the evaluation machinery itself — corpus, statistics, ground truth,
player-level grading, CI wiring, and the transparency surface.

> **Design-only artifact.** No code, test, data, contract or workflow file was
> created or modified. Every measurement below was produced by *importing*
> `scripts.promote_signals` in a scratchpad process and calling its pure
> `evaluate()` / `load_finals()` helpers, or by read-only HTTP GETs. `run()` was
> never called (it writes `data/model_tuning.json`). Numbers marked **measured**
> were computed on 2026-08-13 against the repo as it stands on this branch.

> **Sibling docs.** This design is written to sit *underneath*
> `ARCHITECTURE.md` (which specifies Rel18's seven new signal families and the
> `qb_starters.json` ground-truth artifact) and `FEASIBILITY.md` (which
> established H1–H4). Where the two overlap — the `qb_out` source swap in
> ARCHITECTURE §3 — this document does not restate the plan, it supplies the
> **statistical acceptance bar** that plan defers to, and extends it to the
> larger corpus. Nothing here contradicts either document; §11 states the merge
> order explicitly because both this design and ARCHITECTURE §2.5 modify
> `scripts/promote_signals.py`.

---

## 0. Executive summary

### 0.1 The finding that should reorder Rel18

The gate's *one* adopted signal is **not distinguishable from noise**.

`qb_out` at `scale = 75.0` — the only family ever adopted, the entire output of
the self-learning loop — improves mean log-loss by **+0.002401** over 1,084
walk-forward games. Measured paired standard error of that delta: **0.001772**.

```
qb_out(75) vs no-qb_out — incumbent walk, 2022-2025           [MEASURED]
  mean paired delta   +0.002401   (positive = qb_out better)
  paired sd            0.058328
  paired se            0.001772
  t                        +1.36     (p ~ 0.17, two-sided)
  game bootstrap 95% CI   [-0.00104, +0.00597]   4000 resamples
  season-block 95% CI     [-0.00084, +0.00704]   4000 resamples

  per season:  2022 +0.00179 (se .00400)
               2023 -0.00028 (se .00352)
               2024 +0.00949 (se .00276)   <-- the entire effect
               2025 -0.00142 (se .00376)
```

**Both confidence intervals contain zero, and three of four seasons are flat or
negative.** The adoption is driven almost entirely by one season. It cleared
`MARGIN = 0.0015` because 0.0015 happens to be **0.85 standard errors** at
n = 1,084 — the margin is not a significance threshold at this sample size, it
is a coin flip with a bias.

This is not an argument that `qb_out` is wrong. It is an argument that **the
gate currently cannot tell**. That is a backtesting defect, and it is the
defect Rel18 must fix.

### 0.2 Why this is the highest-leverage part of Rel18

ARCHITECTURE §8 takes the gate from **8 candidate families to 15**. Run the
multiplicity arithmetic at today's resolution. Treat each family as roughly one
effective test (the 3–7 scale trials inside a family are near-perfectly
correlated, so a family contributes ~1 independent draw, not 4):

| Corpus | eval games | MARGIN in σ | P(one null family clears) | P(≥1 of 15 clears) |
|---|---:|---:|---:|---:|
| **today** (2022-2025) | 1,084 | **0.85 σ** | 0.20 | **96%** |
| primary window (2012-2025) | ~3,654 | 1.55 σ | 0.061 | **61%** |
| extended (2000-2025) | ~6,719 | 2.11 σ | 0.017 | 23% |

*(σ from the measured paired sd of 0.0583; `P = 1 − (1 − p)^15`.)*

Shipping seven new families into the gate as it stands means a **96% chance
that at least one of them clears the margin on noise**, and the design gives it
a permanent home in `game_params` where it contaminates the incumbent every
future family is measured against. Rel18 would *look* like it learned seven
things and would in fact have degraded the model.

So the ordering is not a preference, it is a dependency: **the evaluation
upgrade is a prerequisite for the family work being meaningful.** Build the
ruler before adding seven things to measure.

### 0.3 What this design delivers

1. **Corpus.** `data/fixtures/finals_{1999..2020}.json`, derived from
   `games.csv` in the **exact existing fixture shape** so `load_finals()` needs
   no change. Verified: the same derivation reproduces the committed ESPN
   fixtures for 2021-2025 with **0 missing games and 0 score differences across
   all 1,359 games** (measured).
2. **Windows, frozen in code.** `primary = 2011-2025` for adoption,
   `recent = 2019-2025` as a non-regression veto, `extended = 1999-2025`
   reported as a robustness column only. Rationale and the rejected
   alternatives in §2.
3. **Uncertainty.** `scripts/backtest_stats.py` — stdlib paired bootstrap. The
   selected candidate must clear a **one-sided 99% lower bound above zero**
   *in addition to* `MARGIN`. The margin is **not** touched.
4. **Ground truth.** A paired A/B of the `qb_out` starter rule on the expanded
   corpus, with an explicit "if it looks worse, here is where that gets
   published" path.
5. **Player-level backtesting**, which today is **zero**: `data/weekly_actuals.json`
   at a measured **0.5 MB/season** (0.1 MB in its minimal form) unlocks a real
   weekly RoS backtest, a start/sit backtest, and weekly DvP grading.
6. **The orphan fix.** `backtest_ros` wired into CI, surfaced on the MODEL tab,
   plus a generalized invariant so *no* backtest script can be orphaned again.

---

## 1. What was read and measured first

**Read:** `scripts/promote_signals.py` (all 1,097 lines), `scripts/backtest.py`,
`scripts/backtest_ros.py`, `scripts/build_market_baseline.py`,
`scripts/build_epa_history.py`, `scripts/build_player_usage_history.py`,
`scripts/optimize/never_regress.py`, `scripts/refit.py` (MARGIN),
`scripts/scrape/nflverse.py`, `scripts/validate_data.py` (contract wiring),
`.github/workflows/backtest.yml`, `app/views/model.js`,
`data/model_tuning.json`, `data/ros_backtest.json` + its contract,
`data/fixtures/finals_20*.json`, and the two sibling Rel18 docs.

**Measured (2026-08-13, live):**

| # | Measurement | Result |
|---|---|---|
| M1 | `games.csv` completed REG games | **6,967**, seasons **1999-2025**, 100% `home_coach`/`away_coach`/`home_qb_name`/`away_qb_name`/`div_game`/`home_rest`/`away_rest` |
| M2 | Corpus parity vs committed fixtures, 2021-2025 | **1,359 games, 0 missing, 0 score diffs** |
| M3 | Gate's current eval size | **1,084 decisive games** (2022-2025), incumbent log-loss **0.63450** |
| M4 | `qb_out` paired delta + CI | see §0.1 — **CI contains zero** |
| M5 | Era drift, implied naive HFA | **1999-2006: 51.0 Elo · 2007-2014: 51.0 · 2015-2020: 35.1 · 2021-2025: 28.5** |
| M6 | Scoring environment | PPG **41.7 → 45.0**; home-win rate **.573 → .541** |
| M7 | Adopted params vs their grids | `hfa_elo 45.0` = **grid floor**; `revert 0.45` = **grid ceiling**; `k 25.0` = **grid ceiling** — all three on a boundary |
| M8 | Off-grid parameter sweep | best `hfa ≈ 35` (0.63414 vs 0.63450 at 45) — the optimum is **outside** the searched grid |
| M9 | nflverse pbp back-availability | 1999 ✅ 2005 ✅ 2010 ✅ 2015 ✅ (12-18 MB/season, HTTP 200) |
| M10 | nflverse injuries back-availability | 2009 ✅ 2011 ✅ 2015 ✅ 2020 ✅ |
| M11 | Weekly fantasy actuals | `stats_player_week_{season}.csv` — HTTP 200, 150 cols, carries **`fantasy_points_ppr`**, `player_id`, `position`, `team`, `opponent_team`, `season_type` |
| M12 | Weekly-actuals artifact size | **0.10 MB/season** minimal (`pid → week → ppr`), **0.50 MB/season** with position/team/opponent |
| M13 | Team codes 1999-2025 | 35 raw → 32 canonical under the existing `{LA→LAR, OAK→LV, SD→LAC, STL→LAR}` map; 1999-2001 is a **31-team** league (HOU joins 2002) |
| M14 | `gametime` coverage | 100% except **1999 (248 games blank)** — `gameday` is 100% everywhere |

M7 and M8 deserve to be called out on their own: **all three adopted game
parameters sit on the boundary of the grid that produced them**, and a sweep
outside that grid finds a better `hfa_elo`. The parameter backtest is
truncating. §3.4 handles it.

---

## 2. Item 1 — expanding the evaluation corpus

### 2.1 The source and the shape

`load_finals(year)` (promote_signals.py:211) reads
`data/fixtures/finals_{yr}.json` → `{"season", "fetched_utc", "games": [...]}`
where each game is:

```json
{"game_id": "401671789", "home": "KC", "away": "BAL",
 "kickoff_utc": "2024-09-06T00:40Z", "status": "STATUS_FINAL", "final": true,
 "venue": "GEHA Field at Arrowhead Stadium", "venue_city": "Kansas City",
 "venue_country": "USA", "home_score": 27, "away_score": 20, "week": 1}
```

**Design decision: emit the historical seasons in this exact shape, as
per-season files, under the same path convention.** `load_finals()`,
`walk_season()`, `rest_diffs()`, `is_cold_game()` and every consumer stay
untouched. The corpus expansion becomes a *data* change plus a window constant,
not a rewrite of the walk-forward engine. Twenty-two new files at ~70 KB each
≈ 1.5 MB, immutable once written, byte-stable diffs.

**New builder: `scripts/build_finals_corpus.py`** (new file, no collision).

```python
# scripts/build_finals_corpus.py
SEASONS = range(1999, 2021)          # 2021-2025 are ESPN-sourced; NEVER overwritten
ET = zoneinfo.ZoneInfo("America/New_York")

def game_from_row(row) -> dict         # one games.csv row -> fixture-shaped game
def season_games(rows, season) -> list  # sorted, deduped, REG only
def verify_parity(season) -> dict       # re-derive 2021-2025, diff vs committed
def main()                              # --verify | --season Y | (default: backfill)
```

It reads through **A1's `scripts/scrape/nfldata.py` allow-listed accessor**
(ARCHITECTURE §2.2). It must not open `games.csv` itself — the betting-column
denylist is A1's guarantee and this builder is the second consumer that could
break it. `ALLOWED_COLUMNS` for this builder is a strict subset:
`{game_id, season, game_type, week, gameday, gametime, away_team, home_team,
away_score, home_score, stadium, espn, home_rest, away_rest}`.

Field mapping:

| Fixture field | Source | Note |
|---|---|---|
| `game_id` | `espn` column | Real ESPN id where present; `"nflverse:{game_id}"` otherwise. **Never fabricated.** |
| `home` / `away` | `home_team` / `away_team` | via `RENAMES = {LA→LAR, OAK→LV, SD→LAC, STL→LAR}` — the map `build_market_baseline.py` already uses |
| `kickoff_utc` | `gameday` + `gametime` (ET) → UTC | see §2.2 |
| `status` / `final` | constant | `"STATUS_FINAL"` / `true` — only rows with both scores are emitted |
| `venue` | `stadium` | |
| `venue_city` / `venue_country` | omitted | Absent from the source. **Omit, do not invent.** Only `is_cold_game()` reads venue-ish data and it keys on `home` + month, not on these. |
| `home_score` / `away_score` | as-is, int | |
| `week` | as-is, int | |

### 2.2 The kickoff-time trap (do not paper over this)

`gameday` is a **local** date and `gametime` is **Eastern local time**. Three
things in the gate read `kickoff_utc`:

1. `load_finals()` sorts on it — walk order.
2. `is_cold_game()` slices characters 5:7 for the **month**.
3. `rest_diffs()` converts it to an ordinal **day** and differences it.

(3) is the dangerous one. Treating a Sunday-night 8:20 PM ET kickoff as a UTC
date shifts it forward one day, which biases the `rest` family's day counts
systematically for exactly the subset of games that are nationally televised.
That is precisely the kind of silent, correlated error that manufactures a
signal.

**Design:** convert honestly with stdlib `zoneinfo`:

```python
naive = dt.datetime.fromisoformat(f"{gameday}T{gametime or '13:00'}")
kickoff_utc = naive.replace(tzinfo=ET).astimezone(dt.timezone.utc) \
                   .strftime("%Y-%m-%dT%H:%MZ")
```

`zoneinfo` is stdlib (3.9+) and handles the 2007 DST-rule change, which matters
for late-October and early-November kickoffs — i.e. for `is_cold_game()`'s
November boundary. No third-party tz library, no hand-rolled offset table.

**1999 has no `gametime` at all (M14).** Those 248 games get `13:00` ET (the
modal Sunday kickoff) and the record carries `"kickoff_estimated": true`. The
`primary` window starts in 2011, so no adoption ever depends on an estimated
kickoff; the `extended` window's 1999 season is flagged in the promotion record
so a reader knows. **Never silently estimate.**

**The validation that proves the conversion is right:** `games.csv` carries
`home_rest` and `away_rest` as source-of-truth columns. `build_finals_corpus.py
--verify` recomputes `rest_diffs()` from the derived kickoffs and asserts
agreement with `clamp(home_rest − away_rest)` on **≥ 99.5%** of games in
2011-2025, printing every disagreement. If the timezone handling is wrong, this
check fails loudly instead of quietly bending the `rest` family. This is a
falsifiable acceptance criterion (§10, AC-3).

### 2.3 The parity proof

Before a single historical season is trusted, the derivation must reproduce the
corpus we already have. **This is already measured and it passes:**

```
season  fixture  csv   missing  score-diffs        [MEASURED 2026-08-13]
2021      272    272      0         0
2022      271    271      0         0
2023      272    272      0         0
2024      272    272      0         0
2025      272    272      0         0
```

`build_finals_corpus.py --verify` performs exactly this comparison in CI and
**exits non-zero on any diff**. It never writes 2021-2025. The ESPN-sourced
fixtures remain the record for those seasons; games.csv is proven against them,
not substituted for them.

### 2.4 Era sensitivity — **the hard part**

More data is not automatically better. Here is the measured evidence that the
NFL of 1999 is a different game:

```
era          n     PPG   home-win   implied naive HFA (Elo)   [MEASURED]
1999-2006  2024   41.7     .573            51.0
2007-2014  2048   44.5     .573            51.0
2015-2020  1536   46.1     .550            35.1
2021-2025  1359   45.0     .541            28.5
```

Home-field advantage — **the single most important parameter in this model** —
has decayed by roughly **22 Elo points**, which is *larger than the entire
adopted `qb_out` scale of 75* applied to the ~5% of games where a starter is
out. A global fit over 1999-2025 would pull `hfa_elo` toward the old regime and
misprice every modern game. Scoring is up ~3.3 PPG. The 2020 season (no crowds)
sits at a .498 home-win rate, historically anomalous.

Four candidate defences, and the verdict on each:

| Option | Verdict | Why |
|---|---|---|
| **A. Full 1999-2025, single window** | **Reject** | Buys 1.36× the power of 2011+ (SE 0.000712 vs 0.000965) while importing a 22-Elo HFA regime change. Small gain, large bias. |
| **B. Era-weighted evaluation** (down-weight old seasons) | **Reject for adoption** | The weight schedule is a free parameter with no principled value. Every knob that can be tuned until something adopts *will* be, eventually. Keep it as an optional *reported diagnostic*, never as the adoption objective. |
| **C. Per-era parameters** | **Reject** | Production prices one era (2026). Fitting era-specific parameters improves the backtest number and changes nothing that ships — the definition of self-delusion. |
| **D. Frozen window + recent-era veto + reported robustness** | **RECOMMENDED** | Power where power is safe; an explicit transfer check; the wide window kept visible but non-authoritative. |

#### The recommendation

```python
# scripts/promote_signals.py — new module constants
WINDOWS = {
    "primary":  (2011, 2025),   # ADOPTION AUTHORITY
    "recent":   (2019, 2025),   # NON-REGRESSION VETO
    "extended": (1999, 2025),   # REPORTED ONLY — never authoritative
}
PRIMARY_WINDOW = "primary"
WINDOWS_FROZEN_UTC = "2026-08-13"   # changing any bound is a code change, and
                                    # tests/feature/backtest_windows.test.mjs pins it
```

`SEASONS` and `EVAL_SEASONS` become derived (`SEASONS = list(range(lo, hi+1))`,
`EVAL_SEASONS = SEASONS[1:]` — the first season of a window is the rating
warm-up, exactly as 2021 is today).

**Why 2011 specifically — the documented rationale.** Three independent reasons
converge on the same year, which is what makes it a *cutoff* rather than a
*choice*:

1. **Rule/CBA discontinuity.** The 2011 CBA moved kickoffs to the 35-yard line
   and cut offseason contact. Post-2011 the game is structurally recognizable.
2. **The HFA regime.** The break in M5 falls between the 2007-2014 block (51.0)
   and 2015-2020 (35.1). 2011 sits inside the older block, which is
   deliberately conservative: it includes some pre-decay seasons rather than
   cherry-picking the floor of the drift. A cutoff chosen to *maximise* the
   adoption rate would sit at 2019.
3. **It is the earliest floor at which every existing family has data**
   (measured): pbp back to 1999 (M9), injuries back to 2009 (M10), games.csv
   back to 1999 (M1), Open-Meteo archive unlimited. At 2011 no family needs to
   be tiered or excluded, so all 15 families are compared on **one identical
   game set** — see §2.6, which is a correctness requirement, not a nicety.

Corpus effect: eval games **1,084 → ~3,654** (3.4×). Paired SE **0.001772 →
~0.000965** (1.84× tighter). `MARGIN` goes from 0.85σ to 1.55σ of resolution.

#### The adoption rule

```python
def adoption_verdict(res, family):
    """res: {window: {loss_inc, loss_cand, delta, ci_lo99, ci_hi99, n}}"""
    p, r = res["primary"], res["recent"]
    return {
        "clears_margin":  p["delta"] > MARGIN,       # unchanged, still 0.0015
        "clears_ci":      p["ci_lo99"] > 0.0,        # NEW: 99% one-sided bound
        "era_stable":     r["delta"] > -MARGIN,      # NEW: no modern-era regression
        "appliable":      family in APPLIABLE,
    }
    # adopt = all four
```

**The recent-era check is a veto, not a second margin.** Requiring
`delta_recent > MARGIN` would be statistically illiterate: the recent window
holds ~1,900 games and has *less* power than the primary, so demanding
significance there would reject genuinely good signals for lack of data. The
honest split is **power from the primary window, transfer safety from the
recent one**. A candidate that helps overall but actively hurts the modern era
by more than the never-regress margin is rejected — that is the era-transfer
failure mode, caught directly.

The `extended` window is computed and recorded every run, and **never
consulted** by `adoption_verdict`. Its job is to let a human see, in the MODEL
tab and in `model_tuning.json`, when a signal behaves differently across eras.
If `extended` and `primary` disagree in sign, that is a finding to publish, not
an input to a rule.

#### The forking-path guard

The window bounds are the most dangerous new knob in this design. Someone who
wants an adoption can walk the start year until one appears. Three brakes:

1. `WINDOWS` and `WINDOWS_FROZEN_UTC` are **module constants pinned by a test**.
   Changing a bound is a code change, reviewed, with the whole history re-run.
2. Every promotion entry records `"windows": {...}` and
   `"eval_set_id": "<sha256 of the sorted game keys>"`. A run whose
   `eval_set_id` differs from the previous run's, without a corresponding
   `windows` change, is a bug and the test says so.
3. **2020 stays in.** Dropping a season post hoc because it is inconvenient is
   the same sin as moving the boundary. It is flagged in the era table on the
   MODEL tab and in the corpus record; it is never excluded.

### 2.5 What the incumbent must do first (a hard prerequisite)

`game_params` today is `hfa_elo 45.0, revert 0.45, k 25.0`, fitted by
`scripts/backtest.py` on **2022-2025 only**. Two measured facts make expanding
the family corpus *without first re-fitting these* actively dangerous:

- **M7:** all three values sit on a **grid boundary**
  (`HFA_GRID = (45,55,65,75,85)` floor; `REVERT_GRID = (.20,.33,.45)` ceiling;
  `K_GRID = (15,20,25)` ceiling).
- **M8:** sweeping outside the grid, `hfa ≈ 35` beats `hfa = 45`
  (0.63414 vs 0.63450) — and the modern era's *implied* HFA is 28.5 Elo (M5).

If the family gate moves to 2011-2025 while the incumbent keeps a 2022-2025 fit
with a truncated grid, then **every family is partly scored on how well it
patches a mis-specified HFA**, not on whether it adds information. A family
whose delta happens to correlate with home-field would look good for entirely
the wrong reason.

**Therefore, before any family is judged on the new window:**

```python
# scripts/backtest.py
EVAL_SEASONS = tuple(promote_signals.EVAL_SEASONS)   # single source of truth
HFA_GRID    = (25.0, 30.0, 35.0, 40.0, 45.0, 55.0, 65.0, 75.0, 85.0)  # floor opened
REVERT_GRID = (0.20, 0.33, 0.45, 0.55, 0.65)                          # ceiling opened
K_GRID      = (10.0, 15.0, 20.0, 25.0, 30.0)                          # both opened
```

Grid size goes 45 → 225 trials. `score_candidate` is ~15 ms per trial per
season on this corpus, so the full sweep is seconds — cost is not a
consideration. **A boundary-hit assertion is added:** if the winning point sits
on any grid edge, the run prints `GRID TRUNCATED: <dim> optimum at boundary`
and records `"grid_truncated": ["hfa_elo"]` in the history entry. That is how
M7 should have surfaced on its own, and it is AC-4.

This re-fit is gated by the same `should_adopt` / `MARGIN` rule it always was.
Nothing about never-regress is relaxed.

### 2.6 One eval set, or the comparison is meaningless

`run()` today picks the adopted family with
`min(fam["trials"], key=lambda t: t["log_loss"])` across families
(promote_signals.py:772-776). That comparison is only valid if every family was
scored on **the same games**. Today it accidentally is, because all families
share `SEASONS = [2021..2025]`. On a wider window that stops being automatic:
`epa_history.json` currently holds 2021-2025 only, so an EPA family would score
on 1,084 games while `div_game` scores on 3,654 — and log-losses on different
game sets are not comparable numbers. Picking the minimum across them would be
a category error that silently favours whichever family happened to draw the
easier games.

**Design:**

```python
FAMILY_MIN_SEASON = {          # earliest season each family's inputs exist
    "environment": 1999, "rest": 1999, "div_game": 1999, "div_rematch": 1999,
    "coach_quality": 1999, "coach_regime": 1999,
    "epa_total": None, "epa_pass": None, "elo_epa": None,   # from epa_history
    "qb_out": None, "skill_out": None, "weather_wind": None, "dvp_mismatch": None,
}   # None -> resolved at runtime from the artifact's own season coverage

def resolve_eval_set(families, window) -> (seasons, eval_set_id, excluded)
```

`resolve_eval_set` intersects the window with every **runnable** family's
coverage. Families that cannot cover the resolved set are `skipped` with a
recorded reason — the existing, correct behaviour for absent data
(promote_signals.py:700-706), extended from "file missing" to "file too short".
`eval_set_id` (sha256 of the sorted `season|week|home|away` keys) goes in the
entry, and `tests/feature/backtest_windows.test.mjs` asserts **every non-skipped
family in a run carries the same `eval_set_id`**.

**Consequence, stated plainly:** to keep all 15 families comparable on the
2011-2025 window, `epa_history.json` must be backfilled to 2010.
Cost (measured): 15 extra seasons × 12-18 MB streamed once on the runner;
`build_epa_history.py` already treats past seasons as immutable and never
refetches, so this is a **one-time `workflow_dispatch`**, not a weekly cost.
Committed file grows ~1.37 MB → ~4.4 MB. `player_usage_history.json` needs the
same backfill (~0.24 MB → ~0.8 MB). `injury_history.json` back to 2011 is
available (M10).

If a backfill is not completed in time, the fallback is **explicit tiering**,
not silent mixing: families are partitioned by eval set, each tier selects its
own best, and a tier's winner may only be adopted if it clears margin **and**
the 99% CI **on its own tier**. At most one adoption per run overall, as today.
Lower-power tiers therefore face a harder effective bar, which is the correct
direction.

---

## 3. Item 2 — statistical rigour

### 3.1 What is wrong today

`run()` compares two point estimates:

```python
adopt = (best_overall is not None
         and inc_loss - best_overall[1]["log_loss"] > MARGIN)     # line 783-784
```

No uncertainty is computed, reported, or stored. `MARGIN = 0.0015` is a fixed
number in loss units whose relationship to sampling noise depends entirely on
`n` — which the rule never looks at. §0.1 shows what that costs: an adoption
whose 95% interval spans zero and whose effect lives in one season.

### 3.2 The new module

**`scripts/backtest_stats.py`** — new file, pure, stdlib only (the standing
no-numpy/scipy rule), no I/O, `--selftest`.

```python
"""Paired uncertainty for walk-forward log-loss deltas. Pure + stdlib only."""

BOOTSTRAP_B    = 4000
BOOTSTRAP_SEED = 20260813        # FIXED: the gate must be byte-reproducible

def paired_delta(losses_a, losses_b) -> dict
    """Mean paired delta (a - b; positive = b better), sd, se, t. Raises on
    length mismatch — comparing unaligned vectors is the failure this prevents."""

def paired_bootstrap(deltas, *, b=BOOTSTRAP_B, seed=BOOTSTRAP_SEED,
                     alphas=(0.01, 0.05)) -> dict
    """Percentile CIs by resampling GAMES with replacement."""

def block_bootstrap(deltas, blocks, *, b=..., seed=..., alphas=...) -> dict
    """Percentile CIs by resampling SEASONS with replacement. Season-correlated
    error (a rule change, a weird year) violates the independence the game-level
    bootstrap assumes; the block version is the conservative one."""

def sign_test(deltas) -> dict
    """Exact binomial two-sided p on sign(delta) — distribution-free backstop
    for the fat-tailed log-loss delta. Stdlib math.comb, no scipy."""
```

Reproducibility is non-negotiable: `random.Random(seed)` seeded per call, so
re-running the gate on unchanged data produces a byte-identical
`model_tuning.json`. A gate whose verdict wobbles between runs is not a gate.

### 3.3 Wiring into the gate

`evaluate()` already accepts `probs_out` (promote_signals.py:607, 625-627) and
appends `(season, game, p, actual)` in walk order. Two candidate walks over the
same seasons produce **positionally aligned** vectors — the pairing is free.
Add:

```python
def per_game_losses(builders, hfa, revert, k, finals_by_year, seasons):
    """(losses, keys, seasons_of) — aligned per-game log-loss for a builder set."""

def compare(incumbent_builders, candidate_builder, hfa, revert, k, corpus):
    """Score a candidate against the incumbent on EVERY window.
    Returns {window: {loss_inc, loss_cand, delta, se, ci_lo95, ci_lo99,
                      ci_hi95, block_ci_lo99, sign_p, n}}"""
```

`try_candidate` (line 673) records the full block instead of a bare
`log_loss`. Trial records grow from `{scale, log_loss, n}` to:

```json
{"scale": 75.0, "log_loss": 0.63180, "n": 3654,
 "delta": 0.00241, "se": 0.00097, "ci_lo99": 0.00013, "ci_hi99": 0.00470,
 "block_ci_lo99": -0.00021, "sign_p": 0.041,
 "by_window": {"recent": {"delta": 0.00104, "n": 1897},
               "extended": {"delta": 0.00190, "n": 6719}}}
```

Note the deliberate cost: `compare()` walks three windows per trial instead of
one. Today's run is ~90 trials × 4 seasons. The new run is ~450 trials
(15 families) × 3 windows × up to 26 seasons. That is roughly **60× the walk
work** — minutes, not seconds, on a GitHub runner. Mitigations, in order of
preference: (a) the `extended` window is computed **only for each family's
best trial**, not for every trial in the grid — it is a report, not a
selection criterion, so it needs no grid; (b) the bootstrap runs only on the
selected candidate and the per-family best, never on every trial; (c) prior
seasons' rating trajectories are identical across families with no
`training_residuals` dependency and could be cached. (a) and (b) alone bring it
back under ~5 minutes and are what this design specifies. (c) is deliberately
**not** specified — it is a performance optimization that touches leak-freedom,
and it does not earn its risk in Rel18.

### 3.4 Does the bootstrap replace MARGIN? **No. Both, and here is why.**

They test different questions and the gate needs both answers:

- **`MARGIN` is a practical-significance floor.** "Is this improvement big
  enough to be worth the complexity of a permanent new term in the pricing
  path?" That question has nothing to do with sample size. A signal that is
  statistically certain but worth 0.0002 nats is not worth carrying.
- **The bootstrap bound is a statistical-significance floor.** "Given the noise,
  am I confident the improvement is real at all?"

A candidate must clear **both**. This is strictly *harder* than today's rule —
which is the correct direction, and is the honest answer to the temptation the
brief names. The design does not lower `MARGIN` and does not let the bootstrap
serve as an excuse to lower it later; `tests/feature/never_regress.test.mjs`
already pins `should_adopt`, and AC-6 adds a pin on `MARGIN == 0.0015` itself.

**Why 99% and one-sided, not 95%.** From §0.2: with 15 families each
contributing ~1 effective test, a 95% one-sided bound gives a family-wise false
adoption rate of `1 − 0.95^15 = 54%`. A 99% one-sided bound gives
`1 − 0.99^15 = 14%`. Combined with `MARGIN` (a second, partially independent
hurdle), the one-adoption-per-run cap, and the walk-forward-over-14-seasons
requirement, 14% is a defensible worst case for a loop that self-corrects over
weeks. This arithmetic is written into the promotion record as
`"multiplicity": {"families_tested": 15, "families_runnable": N,
"trials_total": M, "ci_level": 0.99, "familywise_bound": 0.14}` so the exposure
is visible rather than implied. This extends ARCHITECTURE §8 item 4 from a
count to a stated error rate.

**Which bootstrap decides.** The **game-level** 99% bound is the gate. The
**season-block** bound is computed and recorded but does not gate, because at
14 eval seasons a block bootstrap has only 14 units and its interval is wide
enough to reject almost everything — using it as the gate would be
conservatism disguised as rigour. But when the two disagree
(game-level positive, block-level spanning zero — **exactly the pattern
measured for `qb_out` in §0.1**), that is a season-concentration warning, and
the promotion record carries `"season_concentrated": true` and the MODEL tab
renders the caveat. Honest surfacing, not a hidden veto.

### 3.5 What this rule would have done to the one existing adoption

Applied to the measured 2022-2025 numbers, `qb_out` would **not** have been
adopted: `ci_lo95 = −0.00104 < 0`, and the 99% bound is wider still. The gate
would have recorded a `would_adopt`-style near-miss and kept the incumbent.

**This must be stated as a consequence of shipping this design, not discovered
after the fact.** Two candidate behaviours:

- **Re-run the whole gate history under the new rule and un-adopt anything that
  fails.** Rejected: `qb_out` was adopted honestly under the rule in force at
  the time, and retroactive un-adoption invites the mirror abuse (retroactive
  adoption).
- **RECOMMENDED: re-test `qb_out` once, on the new corpus, as a first-class
  candidate against a `qb_out`-free incumbent, in the same run that ships the
  new rule.** If it clears margin + 99% CI on 3,654 games, it stays and is now
  genuinely earned. If it does not, it is **un-adopted**, `game_params.qb_out`
  is removed, and the promotion record says so in plain words. Either outcome
  is a success of the gate. The re-test is one extra `compare()` call and is
  specified as part of the §4 work because it shares machinery with the
  ground-truth A/B.

---

## 4. Item 3 — `qb_out` ground-truth validation

ARCHITECTURE §3 already specifies the artifact (`data/qb_starters.json`, built
by A2's `scripts/build_qb_starters.py`), the rule change (`last_started`
replacing cumulative-dropback inference), why using the actual starter as a
*feature* is a leak, and the four-gate validation sequence. **This section does
not restate that. It supplies the three things that design defers to
backtesting: how agreement is measured, how the re-backtest is run on the
expanded corpus, and the exact acceptance bar — including what happens if the
answer is bad.**

### 4.1 (a) Agreement-rate measurement

`build_qb_starters.py --report` emits into `qb_starters.json.diagnostics`.
The backtest-side requirement on that block:

```json
"diagnostics": {
  "window": "2011-2025", "team_weeks": 8160,
  "inferred_agreement":     {"overall": 0.0, "stable_weeks": 0.0, "post_change_weeks": 0.0},
  "last_started_agreement": {"overall": 0.0, "stable_weeks": 0.0, "post_change_weeks": 0.0},
  "post_change_definition": "team-weeks 1-6 after the actual starter changed",
  "n_post_change": 0
}
```

The **split matters more than the headline**. The known failure mode of the
cumulative-dropback rule (ARCHITECTURE §3.1) is confined to the ~6 weeks after
a mid-season starter change; a headline agreement of 97% can hide a 60%
agreement in exactly the population the family is supposed to price. FEASIBILITY
§2.3 proposes agreement as a cheap gating step before spending a gate run — this
design accepts that with one amendment: **the gate is the `post_change`
sub-rate, not the overall rate.** Concretely: if
`last_started_agreement.post_change < inferred_agreement.post_change + 0.05`,
the source swap is not worth a gate run and Rel18 ships `qb_starters.json` as a
diagnostic artifact only.

Agreement is descriptive. It authorises spending compute; it never authorises a
swap.

### 4.2 (b) The re-backtest

New mode, as ARCHITECTURE §3.2 names it: `python -m scripts.promote_signals
--qb-source-ab`. This design specifies its statistics and corpus:

```
qb_out source A/B — incumbent walk, window=primary (2012-2025 eval)
  source              log-loss     delta vs A      99% CI          n
  dropback_inferred   0.xxxxx           —              —          3654
  last_started        0.xxxxx      +0.000xx    [+0.000xx, +0.00xxx]  3654
  recent window (2020-2025)  delta +0.000xx                        1897
  MARGIN 0.0015 · both sources scored on eval_set_id <sha>
```

Three requirements, all of which are the point:

1. **Paired on identical games.** Both walks use the same corpus, same params,
   same seasons, same everything except `qb_out_inputs`' primary-passer rule.
   `compare()` from §3.3 is reused verbatim — the A/B is not a bespoke code
   path with its own arithmetic.
2. **Run on the expanded window.** A source swap judged at n = 1,084 is judged
   at 0.85σ, which is how the family got adopted on one season in the first
   place. Doing the ground-truth upgrade at the old sample size would repeat
   the original error with better data.
3. **Scale re-fit in the same run.** `QB_OUT_SCALES = [25, 50, 75]` is
   re-swept under `last_started`, because 75.0 was fitted against the inferred
   source. The scale grid is a within-family sweep, so it contributes to the
   trial count recorded under `multiplicity`, and the winning scale must itself
   clear the CI bound.

### 4.3 (c) The acceptance bar

**A source swap on an adopted signal faces the same bar as a new adoption. No
grandfathering, in either direction.**

```
swap_accepted = (delta_primary > MARGIN)          # practical significance
            AND (ci_lo99_primary > 0)             # statistical significance
            AND (delta_recent > -MARGIN)          # no modern-era regression
```

This is ARCHITECTURE §3.2's bar (`must beat the old by MARGIN`) with the
bootstrap condition added, on the wider corpus. It is strictly stricter; there
is no conflict.

Written to `game_params.qb_out` on the next run **regardless of outcome**, so
the live rule is always self-describing:

```json
"qb_out": {
  "applied": true, "scale": 75.0,
  "source": "dropback_inferred",
  "window": "primary", "eval_n": 3654,
  "delta": 0.00241, "ci_lo99": 0.00013,
  "adopted_utc": "2026-07-18T20:37:11Z",
  "source_ab": {"dropback_inferred": 0.0, "last_started": 0.0,
                "delta": 0.0, "ci_lo99": 0.0, "accepted": false,
                "measured_utc": "2026-..."}
}
```

### 4.4 If ground truth makes `qb_out` look worse

This is a live possibility and the design must pre-commit to the reporting
path, because the temptation to bury it arrives *after* the number does.

There are two distinct bad outcomes, and they are reported differently:

**(i) `last_started` is worse than `dropback_inferred`.** The swap is rejected,
the inferred rule is kept, and `source_ab` is written with `"accepted": false`
and both log-losses. The MODEL tab's gate card renders a
`QB SOURCE A/B · REJECTED` row with both numbers. Nothing is deleted. This is a
normal, healthy gate outcome — the same shape as a family that fails to clear
the margin — and ARCHITECTURE §3.2 already says so.

**(ii) `qb_out` itself fails the §3.5 re-test on 3,654 games.** This is the
serious one: the platform's only adopted signal turns out not to be earned.
Pre-committed handling:

- `game_params.qb_out` is **removed** (`applied` deleted, not flipped to a
  quiet `false` that leaves a stale scale lying around).
- The promotion entry carries
  `"unadopted": {"family": "qb_out", "reason": "failed re-test on expanded
  corpus", "old_window": "2022-2025", "old_delta": 0.00240,
  "new_window": "2012-2025", "new_delta": 0.0, "new_ci_lo99": 0.0}`.
- The MODEL tab renders an **UN-ADOPTED** chip in the family table and an
  explicit line in the adoption history: *"qb_out was adopted in July 2026 on
  1,084 games; re-tested on 3,654 games it did not clear the bar and was
  removed."*
- `data/meta.json` signal weights are untouched (`injury_impact` was never
  given weight for this) — no downstream surface silently changes.
- Rollback if the removal is itself wrong: restore the `qb_out` block in
  `game_params`; data-only, no code revert.

**A release whose headline result is "we removed our only adopted signal
because it did not survive a better test" is a successful release.** That
sentence belongs in the release notes, and this document is where it gets
committed to in advance so no one has to be brave about it later.

---

## 5. Item 4 — player-level backtesting (currently zero)

### 5.1 The gap, precisely

`scripts/backtest_ros.py` states it honestly in its own docstring: no
per-player weekly actuals are committed, so it falls back to **season
rank-correlation on a proxy formula** that is explicitly *not* the deployed
projection. The app's RoS engine (`app/ros.js`) sums per-week
`player_weekly.json` points; `data/player_weekly.json` (760 KB) contains
**2026 projections**, not actuals. There is no weekly grading anywhere in the
platform. The Lineup start/sit recommendation — arguably the product's most
consequential output — has never been measured against anything.

### 5.2 Verdict: **yes, commit a weekly-actuals artifact. It is cheap and it is the unlock.**

Measured (M11, M12): `stats_player_week_{season}.csv` on the nflverse
`stats_player` release carries `fantasy_points_ppr` per player per week with
`player_id`, `position`, `team`, `opponent_team`, `season_type`. For 2025:
19,422 rows → **6,037 REG QB/RB/WR/TE rows, 610 players**.

Size, measured on the real 2025 file:

| Artifact form | Per season | 2021-2025 | 2011-2025 |
|---|---:|---:|---:|
| minimal (`pid → {pos, week → ppr}`) | **0.10 MB** | 0.52 MB | 1.6 MB |
| with `team` + `opponent` per week | **0.50 MB** | 2.5 MB | 7.5 MB |

**Recommendation: the minimal form**, with opponent recovered by joining
`data/game_context.json` (A1's artifact, keyed `week|home|away`) on the
player's team. 0.52 MB for 2021-2025 is smaller than the already-committed
`epa_history.json` (1.37 MB) and comparable to `player_usage_history.json`
(0.24 MB). This is not a size decision worth agonising over; it is a decision
worth *making explicitly* so nobody commits the 7.5 MB variant by accident.

Do **not** derive weekly points from pbp. `build_epa_history.py` already streams
pbp and the temptation is to reconstruct PPR scoring there. Rejected: a
hand-rolled scoring reconstruction will disagree with the app's scoring in edge
cases (two-point conversions, fumble recoveries, return TDs, kneel-downs), and
a backtest that grades against a *different* scoring rule than the product uses
is worse than no backtest. `fantasy_points_ppr` is the same convention the rest
of the ecosystem uses. Take the number, do not recompute it.

### 5.3 The artifact and its builder

**`scripts/build_weekly_actuals.py` → `data/weekly_actuals.json`**
(new file; `data/contracts/weekly_actuals.schema.json`; added to
`validate_data.OPTIONAL_DATA` and `SCHEMA_TO_DATA`).

```json
{"generated_utc": "...",
 "source": "nflverse stats_player_week releases (fantasy_points_ppr, REG only)",
 "policy": "ACTUALS - the grading truth for player-side backtests",
 "seasons": {"2025": {"00-0023459": {"pos": "QB",
                                     "weeks": {"1": 25.66, "2": 18.2}}}}}
```

Same honesty contract as every sibling builder: `FeedError` on
transport/non-200/short rows, past seasons immutable and never refetched, keep
the existing file on failure, `--selftest` against a committed fixture under
`data/fixtures/nflverse_sample/` that never writes. Cadence: **weekly** in
`backtest.yml` (the current season refreshes; history is cached).

`scrape/nflverse.py` gains `fetch_player_week_release(season)` — and per
ARCHITECTURE §9 that file has exactly one writer (**A4**), so this fetcher is
handed to A4 as a spec, not written by the backtest agent. Alternative if the
serialization is inconvenient: the builder constructs the URL and calls the
existing generic `fetch_release_csv(url, name, min_rows)`, which requires no
edit to `nflverse.py` at all. **Prefer this** — it removes the dependency
entirely.

### 5.4 What it unlocks

**(1) A real weekly RoS backtest** — replaces the season-rank-correlation proxy.
`scripts/backtest_ros.py` gains a `weekly` mode (the season mode stays, clearly
labelled, so the historical `ros_backtest.json` series is not orphaned). Method:
for eval season S, week W, project each player's week-W points from information
available before week W only (prior seasons + weeks < W of S), score against
`weekly_actuals`. Metrics: **MAE** and **Spearman ρ within position and week**,
against two baselines that must both be beaten —
`season_pace` (season total ÷ games, the naive constant) and
`last3` (trailing 3-week mean). The RoS approach earns its keep only by beating
both; if it beats neither, `ros_backtest.json` says so in the same
`beats_baseline` vocabulary it uses today.

**(2) A start/sit backtest — the metric that matches the product's claim.**
`scripts/backtest_players.py` → `data/player_backtest.json`. For every
(season, week, position) and every **pair** of startable players at that
position, ask: did the player the Lineup view would have started outscore the
other? Report **pairwise accuracy** and **points left on the bench per lineup
per week** versus the same two baselines. Pairwise accuracy is the honest
metric here because it is exactly the decision the user makes; aggregate
correlation is not.

**(3) Weekly DvP grading.** ARCHITECTURE §4 builds `dvp_history.json` from pbp.
With weekly actuals, DvP becomes *gradeable*: for each defence and position,
does the prior-weeks DvP rating predict points allowed in the **held-out**
following week, above a league-average baseline? That is the honest test of
whether DvP is signal or noise — and it must be run **before** the
`dvp_mismatch` gate family is trusted, because a DvP rating that does not
predict next week's points has no business adding an Elo delta to a game.

**(4) A player-side never-regress gate — deliberately deferred.** Once weekly
actuals exist, the same margin discipline could govern projection-model
changes. That is a genuinely large piece of work (a player-side incumbent, a
per-player walk-forward harness, an adoption record) and Rel18 should **not**
attempt it. Rel18 delivers *measurement*; the gate on top of it is the natural
Rel19 item, and the artifact designed here is what makes it possible.

---

## 6. Item 5 — the orphaned RoS backtest

### 6.1 The diagnosis, confirmed

`.github/workflows/backtest.yml` runs `scripts.resolve_locks`,
`build_epa_history`, `build_injury_history`, `build_weather_history`,
`build_market_baseline`, `build_player_usage`, `build_player_usage_history`,
`scripts.backtest`, `scripts.promote_signals --auto-adopt`, `validate_data`.
**`backtest_ros` appears nowhere.** No other workflow references it. Grep of
`app/` for `ros_backtest`: **no hits** — `app/data.js` has no getter and no view
reads it. The file is measured once, committed, frozen, and invisible.

An honesty check nobody runs and nobody sees is worse than no honesty check: it
is a claim of rigour with no rigour behind it.

### 6.2 The fix — three parts, because two is how it happened

**(a) Cron wiring.** In `backtest.yml` (owned by **A7** per ARCHITECTURE §9),
after `build_player_usage_history`:

```yaml
      - name: Build weekly fantasy actuals (grading truth)
        run: python scripts/build_weekly_actuals.py

      - name: RoS projection backtest (honest directional check)
        run: python -m scripts.backtest_ros

      - name: Player-level backtest (weekly RoS + start/sit + DvP grading)
        run: python -m scripts.backtest_players
```

Placed **before** `validate_data.py` so a malformed artifact fails the run, and
before the commit step so both land in the weekly data commit.

**(b) Surfaced on the MODEL tab.** §7 — a card that reads
`data/ros_backtest.json` and `data/player_backtest.json`. A number a user can
see is a number someone will notice has stopped moving.

**(c) The generalized invariant, so this class of bug cannot recur.** Two new
checks:

```python
# scripts/validate_data.py  (A7 owns this file)
CI_REGENERATED = {          # artifacts a CI job MUST refresh; staleness is a failure
    "ros_backtest.json": 60,        # max age in days behind the newest
    "player_backtest.json": 60,     # data/model_tuning.json history entry
    "weekly_actuals.json": 60,
}
```

plus a repo-level test, `tests/feature/backtest_wiring.test.mjs`: **every
`scripts/backtest*.py` and every `scripts/build_*.py` that writes into `data/`
must be referenced by at least one file in `.github/workflows/`.** A new
builder with no cron fails the gate at the moment it is written. This is the
check whose absence allowed a one-shot artifact to masquerade as a live
measurement for a whole release cycle, and it is AC-9.

The `60` day tolerance is deliberately loose because, per the project's own
hard-won rule, **GitHub `schedule:` crons are heavily throttled** — a weekly
cron may genuinely fire every two or three weeks. 60 days catches "nothing has
run since the release" without flapping on ordinary throttling.

---

## 7. Item 6 — what the MODEL tab should show

`app/views/model.js` is the transparency promise, and today it renders eight
cards. Better backtesting means three additions and two upgrades. All numbers
labelled, all estimates marked, nothing rounded into a claim it cannot support.
`app/data.js` gains `getRosBacktest()` and `getPlayerBacktest()`; both files are
**A7-owned and Rel17-blocked** (ARCHITECTURE §9), so this is a spec for A7.

**NEW — `CORPUS · WHAT THE MODEL WAS TESTED ON`** (place it first; it frames
every number below it):

```
EVALUATION CORPUS
  3,654 games · 14 seasons · 2012-2025          [primary window — adoption]
  1,897 games ·  6 seasons · 2020-2025          [recent — era check]
  6,719 games · 26 seasons · 2000-2025          [extended — reported only]
  Source: nflverse games.csv, verified against ESPN finals 2021-2025 (0 diffs)

ERA CONTEXT  (why we do not simply use all of it)
  era         PPG   home-win   implied HFA
  1999-2006  41.7      .573       51 Elo
  2007-2014  44.5      .573       51 Elo
  2015-2020  46.1      .550       35 Elo    (incl. 2020, no crowds, .498)
  2021-2025  45.0      .541       28 Elo
  Adoption uses 2011+ only: home-field has decayed ~22 Elo since 1999 and a
  signal fitted across that break may not transfer to today.
```

This card is the single best thing the MODEL tab could gain. It turns "we
backtest" into "here is exactly what we backtested on, and here is the
limitation we chose to accept."

**UPGRADED — the gate card** (`gateCard`, `familyRows`). Add two columns and one
chip:

```
FAMILY          BEST LOSS   Δ LOSS   99% CI              ERA Δ      VERDICT
qb_out            0.63180   +0.0024  [+0.0001, +0.0047]  +0.0010    ADOPTED
div_game          0.63402   +0.0005  [-0.0009, +0.0019]  -0.0002    RETAINED
epa_total         0.64291   -0.0084  [-0.0165, -0.0003]  -0.0091    RETAINED
weather_wind      0.63416   +0.0003  [-0.0004, +0.0011]  +0.0006    RETAINED
dvp_mismatch          —          —          —                —      AWAITING DATA
```

`familyRows` gains `ciLo`, `ciHi`, `eraDelta`, and a `seasonConcentrated` flag
that renders a `⚠ ONE-SEASON EFFECT` chip when the game-level and block
bootstraps disagree (§3.4). The explain line changes from *"A family earns
pricing weight ONLY by clearing the NEVER-REGRESS margin"* to state **both**
hurdles and the corpus size — the current copy is accurate but no longer
complete.

**NEW — `ADOPTION HISTORY`.** One row per family per gate run, oldest → newest,
from `model_tuning.history`. Shows what was adopted, when, on how many games,
and — critically — **un-adoptions**, with the reason. If §4.4(ii) happens, this
card is where the platform tells the truth about it without anyone having to
write a blog post.

**NEW — `PLAYER MODEL · BACKTEST`.** From `ros_backtest.json` +
`player_backtest.json`:

```
WEEKLY PROJECTIONS (2012-2025, walk-forward)     MAE     ρ within week
  our projection                                 x.xx        0.xx
  baseline: season pace                          x.xx        0.xx
  baseline: last 3 weeks                         x.xx        0.xx

START/SIT — pairwise accuracy                    xx.x%   (baseline xx.x%)
POINTS LEFT ON BENCH per lineup per week          x.xx    (baseline x.xx)
DEFENSE-vs-POSITION — next-week predictive lift   +x.xx pts vs league average

Measured on N player-weeks. Last run YYYY-MM-DD.
```

with an honest `state()` message when the artifact is absent, exactly as every
other card degrades today. If we beat the baselines, say so. **If we do not,
show it anyway** — a start/sit tool that cannot beat "start last week's higher
scorer" is a fact the user is entitled to.

**UPGRADED — market yardstick.** `marketTrend()` already plots ours vs the
closing line per gate run. Add the corpus size to each point's tooltip and to
the footer, because the gap moving when `n` tripled is not the same event as
the gap moving at constant `n`. Keep the `MEASUREMENT ONLY` badge — the market
policy boundary is untouched by everything in this document.

**Copy discipline.** Every number gets its `n`. Every interval says what level
it is. `ESTIMATE` badges stay. No card claims "validated" — the vocabulary is
`measured on N games`, `beats baseline` / `does not beat`, `retained`,
`adopted`, `un-adopted`, `awaiting data`.

---

## 8. Exact changes to `scripts/promote_signals.py`

Consolidated, since three sections above touch it. This file has **one owner**
(A6, per ARCHITECTURE §9) and this design **adds a second set of changes to the
same file** — see §11 for the merge order, which is not optional.

| # | Location | Change |
|---|---|---|
| 1 | after L58 | Add `WINDOWS`, `PRIMARY_WINDOW`, `WINDOWS_FROZEN_UTC`, `FAMILY_MIN_SEASON`. `SEASONS` / `EVAL_SEASONS` become derived from `WINDOWS[PRIMARY_WINDOW]`. |
| 2 | new import | `from scripts.backtest_stats import paired_delta, paired_bootstrap, block_bootstrap, sign_test` |
| 3 | after `evaluate` (L635) | `per_game_losses(...)`, `compare(...)`, `resolve_eval_set(...)`, `adoption_verdict(...)` |
| 4 | `try_candidate` (L673) | Record the full `compare()` block, not a bare `log_loss`. `extended` window computed for the family's best trial only. |
| 5 | `run()` verdict (L768-789) | Replace the single-expression adopt with `adoption_verdict()`. `MARGIN` unchanged. Per-family best selected on `primary` only. |
| 6 | `run()` entry (L793-813) | `format: 3`; add `windows`, `corpus`, `eval_set_id`, `multiplicity`, `uncertainty`, `era`, `season_concentrated`, optional `unadopted`. `format: 2` entries stay readable — `app/views/model.js:latestPromotion` filters on `format === 2` and **must** be widened to `>= 2` or the MODEL tab silently blanks on the first new run. *(Flagged loudly: this is a cross-file break between an A6-owned and an A7-owned file.)* |
| 7 | `_write_adoption` (L869) | Every `game_params` block gains `window`, `eval_n`, `delta`, `ci_lo99`, `source` (for `qb_out`). |
| 8 | new mode | `--qb-source-ab` (§4.2) |
| 9 | `selftest()` (L917) | Add: `paired_delta` on a known vector; bootstrap determinism (same seed → same CI, twice); `adoption_verdict` truth table (all four conditions, each failing alone); `resolve_eval_set` rejecting a family whose coverage is short. |

**Leak-freedom is unchanged and must be re-asserted.** Nothing here alters
`walk_season`'s predict-then-update order, the training-residual discipline, or
`EpaFeatures`' `before_week` exclusion. The existing leak assertions in
`selftest()` (L952-955) stay and are the regression proof.

**Backwards compatibility of `model_tuning.json`.** History is append-only and
19 entries deep. `format: 3` entries are additive; the `format: 2` entries stay
valid; `refit.py:append_history` is untouched. The top-level NEVER-REGRESS
example entry locked by `never_regress.test.mjs` + `smoke.sh` is **not**
modified — the same rule `backtest.py`'s docstring already states.

---

## 9. RISK — the skeptical section

**R1 — Era transfer: a signal that only worked in a dead era.** *The central
risk.* Measured: implied HFA 51 → 28.5 Elo (M5), PPG +3.3 (M6). A candidate
fitted across that break can clear a margin on strength borrowed from a league
that no longer exists. **Mitigations:** the primary window starts at 2011, a
documented structural break, not a tuned one; the `recent` window vetoes
modern-era regressions; the `extended` window is reported but never
authoritative; `hfa/revert/k` are re-fitted on the same window before any
family is judged (§2.5). **Residual risk:** 2011-2019 is still not 2025, and
the veto only catches *large* modern-era regressions. Accepted, and named on
the MODEL tab so the user sees the assumption rather than inheriting it.

**R2 — The margin gets loosened.** The most likely bad outcome of this whole
release. It arrives disguised: *"we now have 3.4× the data and rigorous CIs, so
0.0015 is over-conservative."* It is not. `MARGIN` is a practical-significance
floor, orthogonal to sample size (§3.4). **Mitigation:** `MARGIN == 0.0015` is
pinned by a test (AC-6); the bootstrap is added **alongside**, never in place;
the design nowhere makes adoption easier. **Watch for the mirror abuse too:**
raising the margin ad hoc to suppress an inconvenient adoption is the same sin.

**R3 — The window becomes the new knob.** Having removed the margin as a
tunable, this design hands over three window bounds. Walking the start year
until something adopts is a garden-of-forking-paths. **Mitigation:** constants
pinned by a test, `WINDOWS_FROZEN_UTC`, `eval_set_id` in every entry, and a test
that `eval_set_id` changes only when `windows` changes. **Residual:** a
determined person can still change a constant and re-run. The brake is that the
change is visible in the diff and in the archive forever.

**R4 — Multiplicity outruns the fix.** 15 families × ~30 trials ≈ 450 trials.
The bootstrap bound is applied to the *selected* candidate and is **not** a
multiplicity-corrected test. **Mitigation:** the 99% level was chosen from the
family-wise arithmetic (§3.4) and the exposure is recorded in every entry.
**Honest limitation:** the family-wise bound of ~14% is an approximation that
treats each family as one effective test; correlated families (`div_game` and
`div_rematch` are correlated *by construction* — ARCHITECTURE §2.4) make the
true number lower, and a family with a wide, poorly-correlated scale grid makes
it higher. Rel18 records the exposure and does not compute a best-of-N null.
Say that out loud rather than implying the 14% is exact.

**R5 — Bigger corpus, worse model.** The specific mechanism: expanding the
family corpus while the incumbent's `hfa/revert/k` remain fitted to 2022-2025
makes every family partly a patch for a mis-specified HFA. With `hfa_elo` at
its grid floor and the true optimum at ~35 (M7, M8), the mis-specification is
real, not hypothetical. **Mitigation:** §2.5 makes the re-fit a hard
prerequisite with an explicit boundary-hit assertion. **This is the "looks
better while being worse" failure mode the brief warned about, and it is the
one this design most nearly walked into.**

**R6 — Comparing losses across different game sets.** Silent, and it produces a
confident wrong answer. **Mitigation:** `eval_set_id` + the same-set test
(§2.6) + explicit tiering if a backfill is incomplete.

**R7 — Ground truth used as a feature.** Using `home_qb_name` to price a game
is a leak that would improve log-loss *and be entirely fake*, and because
`qb_out` is already adopted the fake improvement would be baked into the
incumbent forever. ARCHITECTURE §3.1 rejects it. **Mitigation, additive here:**
`qb_starters.json` is consumed **only** through the `last_started` rule (which
reads completed prior games); the `--selftest` case that locks the week-9
starter-change behaviour is also the leak test, because a rule that could see
the current week would name the *new* starter in week 9 rather than week 10.

**R8 — Compute blows up the weekly cron.** Three windows × 450 trials × up to
26 seasons is ~60× today's work. **Mitigation:** `extended` computed for
per-family bests only; bootstrap on selected candidates only (§3.3).
**Residual:** if the runner times out, the weekly gate silently stops adopting
and nobody notices — the same failure class as R9. The run prints wall-clock
per phase and records `"runtime_s"` in the entry, so a slow drift is visible.

**R9 — A new artifact gets orphaned exactly like `ros_backtest.json`.**
**Mitigation:** the workflow-reference test (§6.2c) plus `CI_REGENERATED`
staleness bounds. This is the only mitigation in the document that is designed
to catch a *process* failure rather than a statistical one, and it is the one
most likely to pay for itself.

**R10 — Player-level metrics get graded on the wrong scoring rule.** A
hand-rolled PPR reconstruction from pbp disagreeing with `app/ros.js` would
produce a backtest that measures neither the model nor reality.
**Mitigation:** take `fantasy_points_ppr` from the source; never recompute
(§5.2). A contract test asserts a known player-week matches a hand-checked
value.

**R11 — Franchise-continuity collapse.** `STL → LAR` and `SD → LAC` (M13) merge
relocated franchises into one Elo identity across the move, and 1999-2001 is a
31-team league (HOU joins 2002). For Elo this is the standard, defensible
convention (the franchise persists), but it is a modelling assumption imported
silently along with the corpus. **Mitigation:** documented in the corpus
builder's docstring and in the promotion record's `corpus` block; the primary
window starts at 2011, well after both relocations *and* after the 2002
realignment that changed the divisional-game rate from 52% to 38% — which
would otherwise have distorted the new `div_game` family badly.

---

## 10. Acceptance criteria — "backtesting is measurably improved"

Falsifiable. Each is a check that can fail, with the thing that enforces it.

| # | Criterion | Enforced by | Fails if |
|---|---|---|---|
| **AC-1** | **Corpus parity.** Re-deriving 2021-2025 finals from `games.csv` reproduces the committed ESPN fixtures on `(week, home, away, home_score, away_score)` with **0 missing and 0 diffs** across all 1,359 games. | `build_finals_corpus.py --verify` in `smoke.sh`; non-zero exit on any diff | any diff |
| **AC-2** | **Corpus size.** The primary-window promotion entry records `n ≥ 3,500` eval games (vs 1,084 today) across `≥ 13` eval seasons. | `backtest_windows.test.mjs` asserts on the newest entry | `n < 3500` |
| **AC-3** | **Kickoff derivation is correct.** Derived `rest_diffs()` agrees with `clamp(home_rest − away_rest)` from `games.csv` on **≥ 99.5%** of 2011-2025 games. | `build_finals_corpus.py --verify` | below threshold; every disagreement printed |
| **AC-4** | **No grid truncation.** The adopted `hfa_elo`, `revert`, `k` do **not** sit on a `backtest.py` grid boundary; if they do, the entry carries `grid_truncated` and the run says so. | `backtest.py` boundary assertion + `backtest_windows.test.mjs` | a boundary hit is adopted silently |
| **AC-5** | **Uncertainty is reported.** Every non-skipped family's best trial carries `delta`, `se`, `ci_lo99`, `ci_hi99`, `sign_p`, `n`. | `rel18_contracts.test.mjs` | any field missing |
| **AC-6** | **The margin did not move.** `refit.MARGIN == 0.0015` and `should_adopt` is byte-unchanged. | existing `never_regress.test.mjs` + a new literal pin | any change |
| **AC-7** | **Adoption requires both hurdles.** No entry exists with `adopted: true` and `ci_lo99 <= 0`, or with `delta <= MARGIN`, or with `recent.delta <= -MARGIN`. | `backtest_windows.test.mjs` scans the whole history | any such entry |
| **AC-8** | **Era sensitivity is enforced and visible.** Every `format: 3` entry carries all three windows with per-window `n` and `delta`, and `windows` matches the pinned constants. | `backtest_windows.test.mjs` | missing window or drifted constant |
| **AC-9** | **No orphaned backtests.** Every `scripts/backtest*.py` and every `scripts/build_*.py` writing to `data/` is referenced by a file in `.github/workflows/`. | `backtest_wiring.test.mjs` | any unreferenced script |
| **AC-10** | **RoS backtest is live.** `data/ros_backtest.json.__meta__.generated_utc` is within 60 days of the newest `model_tuning.history` entry. | `validate_data.py` `CI_REGENERATED` | stale artifact |
| **AC-11** | **RoS backtest is surfaced.** `app/views/model.js` reads `ros_backtest.json` and `player_backtest.json`; the MODEL tab renders a player-backtest card (or its honest `state()` message). | Playwright case under `tests/ux` | card absent |
| **AC-12** | **Player-level backtesting exists at all.** `data/player_backtest.json` reports weekly MAE and within-week ρ against **both** named baselines over `≥ 50,000` player-weeks, and a pairwise start/sit accuracy with its baseline. | contract + `rel18_contracts.test.mjs` | file absent, or a baseline missing |
| **AC-13** | **`qb_out` is re-adjudicated, either way.** `game_params.qb_out` carries `source`, `window`, `eval_n ≥ 3,500`, `delta`, `ci_lo99` — **or** the family is absent and an `unadopted` record explains why. | `qb_ground_truth.test.mjs` | neither state holds |
| **AC-14** | **Agreement rates are published.** `qb_starters.json.diagnostics` carries `inferred_agreement` and `last_started_agreement`, each split `stable` vs `post_change`, with `n_post_change`. | `qb_ground_truth.test.mjs` | any split missing |
| **AC-15** | **Determinism.** Two consecutive gate runs on unchanged data produce byte-identical `model_tuning.json` except `generated_utc` and `runtime_s`. | `smoke.sh` double-run diff | any other byte differs |
| **AC-16** | **Same eval set.** All non-skipped families in a run share one `eval_set_id`. | `backtest_windows.test.mjs` | any mismatch |

AC-1, AC-2, AC-5, AC-7, AC-8, AC-9, AC-10, AC-12 are the eight that, together,
constitute "backtesting is measurably improved": **bigger corpus, uncertainty
reported, era sensitivity enforced, RoS backtest live and visible, player-level
backtesting existing where there was none.** The rest are the guardrails that
stop each of those from being satisfied dishonestly.

---

## 11. Build order, ownership, and prerequisites

### 11.1 The collision that must be handled

**Both this design and ARCHITECTURE §2.5 modify `scripts/promote_signals.py`,
and ARCHITECTURE §9 assigns it a single owner (A6).** ARCHITECTURE's change is
a breaking one to a shared structure (the residual tuple 3 → 4). This design's
changes touch `evaluate`, `try_candidate`, `run`, `_write_adoption` and the
module constants. Two agents editing that file concurrently will collide.

**Recommendation: one new agent, A8 — Backtest Core, and a strict serialization.**

| Agent | Owns (writes) | Depends on |
|---|---|---|
| **A8a — corpus + stats** | `scripts/build_finals_corpus.py`, `scripts/backtest_stats.py`, `data/fixtures/finals_{1999..2020}.json`, `tests/feature/backtest_windows.test.mjs` | A1's `nfldata` gateway |
| **A8b — player backtest** | `scripts/build_weekly_actuals.py`, `scripts/backtest_players.py`, `data/contracts/weekly_actuals.schema.json`, `data/contracts/player_backtest.schema.json`, `tests/feature/backtest_wiring.test.mjs` | A3 (DvP) for the DvP grading section only |
| **A8c — gate integration** | `scripts/promote_signals.py`, `scripts/backtest.py`, `scripts/backtest_ros.py` | **A6 must be merged first** |

A8c is the sole writer of `promote_signals.py` **after** A6 lands. A6's family
additions and A8c's window/uncertainty rework are merged **sequentially, never
in parallel**. If the schedule cannot accommodate that, the fallback is to give
A6 both specs and have one agent make both changes in one pass — which is
slower but not riskier. What must **not** happen is two agents holding that
file at once.

`scripts/backtest_ros.py` moves into A8c's column (it is currently unowned in
ARCHITECTURE §9 — an omission, since nobody was assigned the orphan).

### 11.2 Build order

```
P0  A8a — corpus + stats                        [PREREQUISITE FOR EVERYTHING]
      build_finals_corpus.py, --verify passes AC-1/AC-3
      backfill epa_history + player_usage_history + injury_history to 2010
        (one-time workflow_dispatch on the runner)
      backtest_stats.py + selftest
      -> nothing downstream is trustworthy until AC-1 and AC-3 are green

P1  A8c(i) — re-fit the incumbent on the new window       [BLOCKS ALL FAMILIES]
      backtest.py: window from promote_signals, grids opened, boundary assertion
      -> AC-4. Until this lands, every family delta is partly an HFA patch (R5).

P2  A8c(ii) — gate rework
      windows, compare(), adoption_verdict(), eval_set_id, format 3
      -> AC-2, AC-5, AC-7, AC-8, AC-16

P3  A8c(iii) — qb_out ground truth + re-adjudication
      --qb-source-ab; the §3.5 re-test in the same run
      -> AC-13, AC-14.  Needs A2's qb_starters.json and P2's compare().

P4  A8b — player-level backtesting               [PARALLEL WITH P1-P3]
      build_weekly_actuals.py, backtest_players.py, backtest_ros weekly mode
      -> AC-12.  Shares no files with A8a/A8c.

P5  A7 — integration                             [BLOCKED ON REL17 + P0-P4]
      backtest.yml steps, validate_data CI_REGENERATED + 2 schemas,
      app/data.js getters, app/views/model.js cards, smoke.sh selftests
      -> AC-9, AC-10, AC-11
```

Waves: **P0 ∥ P4** (2 agents), then **P1 → P2 → P3** (serial, 1 agent), then
**P5** (1 agent). Peak concurrency 2-3 — well inside the 4-6 default. The
serial chain is a genuine dependency, not conservatism: P2 measures against
P1's parameters, and P3 measures with P2's machinery.

### 11.3 Which Rel18 items depend on this

| Rel18 item | Dependency | Consequence if built first |
|---|---|---|
| **7 new gate families** (div_game, div_rematch, coach_quality, coach_regime, dvp_mismatch, scheme_matchup, referee) | **Hard.** P0-P2. | 96% chance ≥1 adopts on noise (§0.2), and it contaminates the incumbent permanently |
| **qb_out ground truth** | **Hard.** P0-P2 for the corpus; the A/B is meaningless at 0.85σ | repeats the original error with better data |
| **DvP as a gate family** | **Hard.** P4 — DvP must be shown to predict next week's points before it may price a game | an Elo delta from a rating never shown to predict anything |
| **DvP as an app surface** | **Soft.** Ships without this; better with the grading number next to it | a chip with no accuracy claim behind it |
| **FTN scheme / personnel** | **Soft.** Same gate, so same benefit; no ordering requirement | evaluated at low power |
| **Coordinators (display-only)** | **None.** Never enters the gate | — |

### 11.4 Rollback

| Change | Rollback |
|---|---|
| Window expansion | Revert `WINDOWS` to `{"primary": (2021, 2025)}`; historical fixtures stay on disk, unread. **One constant.** |
| Bootstrap gate | Revert `adoption_verdict` to the `MARGIN`-only expression; `backtest_stats.py` becomes dead code, harmless. |
| `qb_out` source swap | `game_params.qb_out.source = "dropback_inferred"`, re-run. **Data-only** (ARCHITECTURE §3.2). |
| `qb_out` un-adoption | Restore the `game_params.qb_out` block. **Data-only.** |
| New artifacts | Delete the file — all are in `OPTIONAL_DATA`; every consumer already skips loudly. |
| MODEL tab cards | `git revert` the A7 commit; every new read is guarded on a possibly-absent artifact. |
| Grid widening | Revert the three tuples in `backtest.py`. |

---

## 12. What this design deliberately does not do

Named so they are choices on the record, not omissions.

- **No player-side never-regress gate.** Rel18 delivers player-level
  *measurement*. A gate on top of it is a whole release (§5.4 item 4).
- **No best-of-N null / permutation multiplicity correction.** The exposure is
  recorded; acting on it is a future release. The 99% level is a blunt,
  defensible stand-in and is described as such (R4).
- **No era-weighted objective.** Rejected as a tunable knob (§2.4 option B).
  It may be *reported*.
- **No per-era parameters.** Production prices one era (§2.4 option C).
- **No caching of rating trajectories across families.** A real speedup that
  touches leak-freedom; not worth the risk here (§3.3c).
- **No change to the market policy.** `market_baseline.json` stays
  measurement-only. Nothing in this document reads a price into a model input.
- **No retroactive re-adjudication of the gate's whole history.** Only `qb_out`
  is re-tested, once, prospectively (§3.5).
- **No referee family.** FEASIBILITY §2.4 cut it; nothing here revives it.
