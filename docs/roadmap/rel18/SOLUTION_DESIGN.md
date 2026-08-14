# Rel18 — SOLUTION DESIGN (authoritative)

**Role:** Adversarial Reconciler · **Supersedes:** conflicts between
`ARCHITECTURE.md`, `FEASIBILITY.md`, `TECH_DESIGN.md` in this directory.
**Repo:** `/home/user/nfl2026` — vanilla-JS no-build PWA + stdlib-only Python.

> Where this document disagrees with the other three, **this document wins**.
> Where it is silent, `TECH_DESIGN.md` is the detail of record, then
> `ARCHITECTURE.md`. `FEASIBILITY.md` is the evidence of record for every
> reachability / column / coverage claim.

> **Rel17 is in flight in this same tree.** Rel18 designs *around*
> `scripts/availability.py`, `scripts/injury_duration.py`,
> `scripts/build_weekly.py`, `scripts/scrape/espn*.py`,
> `scripts/build_injury_history.py`, `scripts/build_predictions.py`,
> `scripts/validate_data.py`, `app/availability.js`, `app/lineup.js`,
> `app/views/lineup.js`, `app/views/compare.js`, `app/theme.css`,
> `tests/smoke.sh`, `tests/web/web.spec.mjs`,
> `tests/feature/contrast_aa.test.mjs`, `data/player_weekly.json`,
> `data/injuries.json`. **Every one of those files is owned by agent B4 and B4
> is blocked on Rel17 merging.** Rel18 assumes availability + injury-duration
> already exist and are correct.

---

## 0. What I re-verified myself before ruling

Every claim below was re-probed live on 2026-08-13 from this sandbox, or read
out of the source. I did not take the other three documents' word for anything
load-bearing.

| Probe | Result | Consequence |
|---|---|---|
| `games.csv` GET | HTTP 200, **7,548 rows, 46 cols** | Item 1 is live |
| pregame split (`result` empty) | `home_coach` **272/272**, `div_game` **272/272**, `home_qb_name` **0/272**, `referee` **0/272**, `home_moneyline` 52/272 | H2 confirmed. QB/referee are post-game |
| `ftn_charting_2025.csv` header | 200; **`is_screen_pass`** (not `is_screen_p`); **no `posteam`/`defteam` column** | D4 confirmed; brief's column name is wrong |
| `ftn_charting_{2021,2026}.csv` | **404 / 404** | Short runway confirmed |
| `promote_signals.py:783-789` | **`best_overall` is a single family; if it is not `APPLIABLE`, `adopt` is set `False` and the run adopts NOTHING — it does not fall through to the best appliable family** | **Decisive. See §9.1 — `referee` is cut.** |
| `promote_signals.py:370` | residual row is a **3-tuple** `(h, resid, is_cold)` | D5 change is real and needed |
| `promote_signals.py:141-180` | `primaries[(season, team, week)] -> passer pid`, pid space `00-00xxxxx` | games.csv `home_qb_id` is the **same** pid space — drop-in |
| `data/epa_history.json` | `passers: {"00-0035228": {"db": 34, ...}}` per team-week | A second, dependency-free `last_started` estimator exists (§4.2) |
| `data/player_usage_history.json` | `seasons.<yr>.<pid> = {opp, share, team}` — **season-level, no `position`** | D3 confirmed, and worse than stated: it is not weekly either |
| `data/fixtures/finals_2024.json` | 272 games, **weeks 1–18, REG only**, `game_id` is the **ESPN** id | Join must be `season\|week\|home\|away`; postseason is out of scope entirely |
| finals ↔ games.csv join, 2021–2025 | **1,359 REG games, 0 missing**, 480 divisional; team-code sets identical after `{LA→LAR, OAK→LV, SD→LAC, STL→LAR}` | The enrichment join is exact. Eval span (2022–2025) = **1,087 games** |
| `validate_data.py:166 _validate` | implements `type, enum, minimum, maximum, required, properties, additionalProperties, items, minItems, maxItems` **only** | `pattern` / `minProperties` are decorative. The betting guard may never rely on a schema keyword |
| `tests/playwright.config.mjs` + `tests/run_gate.sh` | `testDir = tests/`, run with **no path filter** | `tests/web/web.spec.mjs` **is** in the gate. Its hardcoded `toBe(8)` will go red |
| `tests/competition.test.mjs` | **does not exist in this repo** | `TECH_DESIGN.md §16`'s gate block copied it from the wc2026 project. Corrected in §14 |
| `scripts/scrape/nflverse.py` | `fetch_release_csv`, `iter_pbp_release`, `fetch_roster_release` all present; module docstring still claims releases 403 | Reuse as-is; B3 corrects the docstring |

---

## 1. Conflict resolutions (the ruling table)

| # | Conflict | Ruling |
|---|---|---|
| **R1** | ARCH + TECH build a `referee` gate family; FEAS says cut it | **CUT the family.** New evidence: a non-appliable family that wins the run **suppresses adoption entirely** (§9.1). Referee has zero upside and real downside. `referee` stays as a *field* in `game_context.json` and gets a **separate `--referee-report` diagnostic** that never enters `families[]`. |
| **R2** | ARCH: `div_game` + `div_rematch` as two families; TECH D1: one `divisional` with a 2-D grid | **Accept TECH.** One family, `DIV_SCALES × DIV_REMATCH_EXTRA` = 30 trials, exactly the `environment` precedent. |
| **R3** | ARCH: `game_context.json` keyed `seasons.<yr>.<week\|home\|away>`; TECH D2: flat `season\|week\|home\|away` | **Accept TECH**, now proven: the flat key joins 1,359/1,359 REG games with zero misses. |
| **R4** | ARCH: `dvp_mismatch` weights by `player_usage_history` shares; TECH D3: DvP emits its own offensive mirror | **Accept TECH.** `player_usage_history.json` has no `position` **and is season-level** — the ARCH join is doubly impossible. |
| **R5** | ARCH implies FTN gives team tendency directly; TECH D4: join to pbp | **Accept TECH**, verified: the FTN header has no team column. |
| **R6** | ARCH: residual 4-tuple carries the game dict; TECH D5: carries a context key string | **Accept TECH.** A game dict inside a training-feature row carries `home_score`/`away_score`; a flat key of primitives cannot be misused. |
| **R7** | Family count: ARCH 15, TECH 14 | **13.** 8 existing + `divisional`, `coach_quality`, `coach_regime`, `dvp_mismatch`, `scheme_matchup`. Referee cut. |
| **R8** | Eval span: ARCH "~1,084", FEAS "1,139" | **1,087** REG games, 2022–2025 (FEAS counted postseason; the gate walks `finals_{yr}.json`, which is REG-only). |
| **R9** | Item 1a: brief says use `home_qb_name` as the starter; ARCH/TECH say label-only | **Label-only, and sharpened** (§4). The challenger estimator gets an epa_history-derived fallback so the live path never silently degrades to a rule the A/B never measured. |
| **R10** | TECH's FTN builder spec omits the zero-sentinel | **FEAS wins.** ~23.7% of FTN rows carry `0` in `n_defense_box`/`qb_location` (uncharted/ST). The filter and its fixture assertion are **mandatory** (§6.2). |
| **R11** | TECH §6 (participation) omits the 2022/2023 format break and ST contamination | **FEAS wins.** Both are written into the deferred spec (§7). |
| **R12** | TECH §7 (coordinators) covers no attribution; FEAS notes Wikipedia is CC-BY-SA | **FEAS wins.** Wikipedia attribution is required wherever coordinators render (§8). |
| **R13** | Betting guard: TECH layer 2 = grep + selftest; FEAS proposes a poisoned-fixture behavioural test | **Both.** A grep is defeated by a computed column name; the behavioural test is the load-bearing one (§3.2). |
| **R14** | Partition: ARCH/TECH propose 7 agents; the build calls for 4 | **Four** (§12), disjoint, with `DvpFeatures`/`SchemeFeatures` shipped inside their own builders so the gate file keeps a single owner. |

**Nothing in any of the three documents lets a betting column become a model
feature**, and nothing is claimed reachable that the probes contradict. Two
things in the repo are stale rather than wrong: `scripts/scrape/nflverse.py`'s
docstring claim that releases 403 (they now 200), and `TECH_DESIGN.md §16`'s
gate command.

---

## 2. What Rel18 ships

| Item | New data | New gate family | Registry slot | App surface |
|---|---|---|---|---|
| 1 games.csv | `game_context.json`, `coach_history.json`, `qb_starters.json` | `divisional`, `coach_quality`, `coach_regime` | `head_coach_change` **backed** | — |
| 1a qb_out | (uses `qb_starters.json`) | *source swap on an adopted family* | — | model-tab source line |
| 2 DvP | `dvp_history.json`, `dvp.json` | `dvp_mismatch` | `schedule_strength` **backed** | **Lineup + Compare (primary value)** |
| 3 FTN | `scheme_history.json` | `scheme_matchup` | `scheme_fit` **backed** | Model-tab provenance + chip credit |
| 4 personnel | `personnel_prior.json` | — | — | **DEFERRED** (§7) |
| 5 coordinators | `scripts/scrape/coordinators.py` | **none, deliberately** | `coordinator_change` **stays empty** | Team tab |

Registry **weights all stay 0.0**. `data/meta.json` and
`scripts/signals/registry.py` are **untouched by Rel18**. "Backed" means the
slot gains a real artifact, never a weight.

---

## 3. Item 1 — the nfldata gateway and the market trap

### 3.1 `scripts/scrape/nfldata.py` (owner B1) — the only enrichment reader

```python
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# ##### THE BETTING DENYLIST — these may NEVER reach a model input path. #####
BETTING_COLUMNS = frozenset({
    "away_moneyline", "home_moneyline", "spread_line", "total_line",
    "over_odds", "under_odds", "away_spread_odds", "home_spread_odds",
})

ENRICHMENT_COLUMNS = frozenset({
    "game_id", "season", "game_type", "week", "gameday", "weekday", "gametime",
    "away_team", "home_team", "away_score", "home_score",
    "away_coach", "home_coach", "referee", "div_game",
    "away_qb_id", "away_qb_name", "home_qb_id", "home_qb_name",
    "stadium", "stadium_id", "location", "roof", "surface",
    "away_rest", "home_rest", "temp", "wind",
})
assert ENRICHMENT_COLUMNS.isdisjoint(BETTING_COLUMNS)   # import-time, fails fast

RENAMES = {"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}   # duplicated, not imported
```

`iter_games_rows(seasons=None, game_type="REG")` yields **a new dict built from
the allow-list** — `{k: r.get(k) for k in ENRICHMENT_COLUMNS}`. A betting column
is not filtered downstream, it is **never constructed**; a caller that reaches
for `row["spread_line"]` gets `KeyError`, not a number.
`context_key(season, week, home, away) -> "{season}|{week}|{home}|{away}"` is the
one join key. `FeedError` if the header is missing any allow-listed column or
fewer than 7,000 rows arrive.

**`scripts/build_market_baseline.py` is deliberately NOT refactored onto this
module.** Two physically separate readers means the module the enrichment
builders import has no code path to a betting column at all. DRY here would
re-import the trap. That sentence goes in the docstring so a future reader does
not "clean it up".

### 3.2 The guard — four layers, and the test that actually enforces it

| Layer | Mechanism | Owner |
|---|---|---|
| 0 — schema | `"policy": "NO MARKET COLUMNS — allow-listed at scripts/scrape/nfldata.py"`. **Documentation only.** `pattern`/`minProperties` are unimplemented in `validate_data._validate` (verified) — no schema keyword may ever be the guard | B1 |
| 1 — code | allow-list projection at the source + import-time disjointness `assert` | B1 |
| 2 — **behavioural test (load-bearing)** | `nfldata_guard.test.mjs` runs `python3 scripts/scrape/nfldata.py --selftest`, which feeds **two synthetic row sets identical except that one has every betting column poisoned** (`spread_line=-999`, `home_moneyline=+99999`, …) and asserts the two projected outputs are **byte-identical**, and that `set(projected) <= ENRICHMENT_COLUMNS` | B1 |
| 2b — source-text test | same test file greps `build_game_context.py`, `build_coach_history.py`, `build_qb_starters.py`, `build_dvp_history.py`, `build_scheme_history.py`, `promote_signals.py`, `build_predictions.py` for all eight names — **zero hits**; and asserts the eight literals occur in `nfldata.py` **only** inside the `BETTING_COLUMNS` block | B1 |
| 3 — data | `validate_data.check_no_betting_columns(docs)` walks **every key at every depth** of `game_context.json`, `coach_history.json`, `qb_starters.json` and raises naming the file and JSON path. Denylist is a **literal** in the validator, never imported from the producer — a checker that imports the producer's constants grades the pipeline with the pipeline's own marking scheme | B4 |

A grep alone is defeated by a computed column name; the poisoned-fixture
identity test is not. Both ship.

### 3.3 `data/game_context.json` (owner B1)

Seasons **2021–2026**, `game_type == "REG"` only (the gate walks REG; the join
was verified 1,359/1,359 with zero misses).

```json
{ "generated_utc": "...",
  "source": "nflverse nfldata games.csv via scripts/scrape/nfldata.py (enrichment allow-list)",
  "policy": "NO MARKET COLUMNS - betting columns are never read on this path",
  "seasons": [2021, 2022, 2023, 2024, 2025, 2026],
  "games": {
    "2025|1|LAR|KC": {
      "div_game": 0, "meeting_no": 1, "referee": "Clete Blakeman",
      "home_coach": "Sean McVay", "away_coach": "Andy Reid",
      "home_qb": {"id": "00-0026498", "name": "M.Stafford"},
      "away_qb": {"id": "00-0033873", "name": "P.Mahomes"}
    } } }
```

- `meeting_no` is **derived by us** (sort each unordered pair's REG games by
  week: first = 1, second = 2), pregame-known because the schedule is published
  preseason. REG-only means `meeting_no ∈ {1,2}` — no postseason third meeting.
- `home_qb`/`away_qb` are **`null` for unplayed games** and are never fabricated.
  2026 rows carry coaches and `div_game` today and `null` QBs.
- Encoding `ensure_ascii=True, indent=1, sort_keys=True` + trailing newline.
- `--selftest`: synthetic 4-game season — `meeting_no` 1 then 2 for a repeated
  pair; a null QB survives as `null`; a poisoned betting column cannot appear in
  the emitted doc.

### 3.4 `data/coach_history.json` (owner B1)

All seasons **1999–2026** (so "first year with this team" is correct in 2021).
177 coaches.

```json
{ "coaches": {"Andy Reid": {"games": 431, "seasons": [1999, "..."],
                            "teams": {"PHI": [1999, 2012], "KC": [2013, 2026]},
                            "first_season_by_team": {"PHI": 1999, "KC": 2013}}},
  "by_team_season": {"KC|2026": "Andy Reid"} }
```

**Name normalization is required, not optional.** Coach identity is free text
with no ID column and the source contains at least one confirmed misspelling
(`Klint Kubliak` for *Kubiak*). The module carries a small `COACH_ALIASES` map in
the spirit of `scripts/scrape/renames.py`, and the selftest asserts the 2026
coach set resolves to **exactly 32 teams and 32 distinct coaches**.

---

## 4. Item 1(a) — the qb_out ground-truth upgrade

**The only change in Rel18 that touches the one adopted family
(`qb_out`, `scale 75.0`). It gets the most validation.**

### 4.1 Why the realised starter is a label, not a feature

`home_qb_name` is who actually took the first snap, and it is **0/272 populated
for unplayed games** (verified). Pricing a game with it means the model knows,
pregame, the answer `qb_out` forecasts. Because `qb_out` is already adopted, a
fake improvement would be baked into the incumbent and would contaminate every
later family comparison. **Rejected as a feature. Adopted as ground truth.**

### 4.2 The challenger estimator, and its fallback chain

Today's rule (`qb_out_inputs:141`) names the **cumulative-dropback leader over
weeks < W**. Its failure is severe and dated: a QB benched in week 9 stays the
"expected starter" until ~week 15 because he banked half a season of dropbacks —
exactly the weeks when QB uncertainty is highest.

The challenger, `last_started`, resolves in this **explicit, printed order**:

1. **Label** — the starter of the team's most recent completed prior REG week,
   from `qb_starters.json` (games.csv `*_qb_id`, same `00-00xxxxx` pid space as
   `epa_history.passers` — verified).
2. **Fallback A, `last_game_dropback_leader`** — the passer with the most
   dropbacks in the team's **most recent prior week** in `epa_history` (already
   in the pipeline, already required by `qb_out`, no new runtime dependency).
3. **Fallback B** — today's cumulative-dropback rule.
4. Week 1 → the final start of the prior season, then (2), then (3).

**Why the chain exists, and the adversarial requirement it satisfies.** The A/B
in §4.4 is measured on 2022–2025, where labels are 100% present, so it only ever
exercises step 1. Live, games.csv could lag. A silent drop to an unmeasured rule
would make the shipped behaviour differ from the validated behaviour. Therefore:

- `build_qb_starters.py` records `label_lag_weeks` = (current slate week − 1) −
  (max week with labels) for the live season;
- `qb_out_current()` **refuses `last_started` and falls back with a printed
  `WARNING: qb_starters label lag N weeks - falling back to <rule>`** when
  `label_lag_weeks > 1`;
- the diagnostics publish the agreement rate of **all three** rules, so fallback
  A is a *measured* rule, not an unknown one.

Every input is a completed prior game ⇒ strictly pregame, leak-free by the same
argument that makes `EpaFeatures.margin(…, week)` leak-free.

### 4.3 `data/qb_starters.json` (owner B1)

```json
{ "source": "nflverse nfldata games.csv home_qb_name/home_qb_id via scripts/scrape/nfldata.py",
  "policy": "GROUND TRUTH LABEL - used to build and measure a pregame estimator, never priced directly",
  "seasons": {"2025": {"9": {"CLE": {"id": "00-0039163", "name": "D.Gabriel"}}}},
  "label_lag_weeks": 0,
  "diagnostics": {
    "team_weeks": 1359,
    "agreement": {"dropback_inferred": 0.0, "last_game_dropback_leader": 0.0, "last_started": 0.0},
    "agreement_post_change": {"dropback_inferred": 0.0, "last_game_dropback_leader": 0.0, "last_started": 0.0},
    "agreement_stable": {"...": 0.0},
    "post_change_weeks": 0, "stable_weeks": 0 } }
```

Diagnostics are a **measurement, not a gate** — a rule can agree less often
overall and still price better. They are published so the swap is explicable.
`--selftest`: a synthetic season where CLE starts QB-A weeks 1–8 and QB-B weeks
9–18 asserts `last_started` names QB-A for weeks ≤ 9 and QB-B from week 10, and
that `dropback_inferred` still names QB-A through ~week 15. That is the exact
failure the upgrade exists to fix, pinned.

### 4.4 The acceptance bar — paired incumbent A/B (owner B1)

`python -m scripts.promote_signals --qb-source-ab` runs the **full incumbent
walk twice** over 2022–2025 — identical params, seasons and families, differing
**only** in `qb_out_inputs`' primary-passer rule:

```
qb_out source A/B  (incumbent walk, 2022-2025, n=1087)
  dropback_inferred   log-loss 0.xxxxx
  last_started        log-loss 0.xxxxx
  delta               -0.000xx    MARGIN 0.0015   -> SWAP / KEEP
```

**Bar: the challenger must beat the incumbent source by `MARGIN` (0.0015)** —
the same never-regress bar a new family faces. Not "no worse". Not a lowered
margin. An adopted family gets **no grandfathering**, and a source swap on an
adopted family is at least as consequential as a new adoption.

If the delta is neutral or adverse the inferred rule is **kept**, the A/B record
is archived anyway, and Rel18 ships `qb_starters.json` as a diagnostic artifact
only. **That outcome is a success of the gate, not a failed feature.**

**Scale is re-fitted in the same write.** `scale = 75.0` was fitted under the old
source; on a swap the mode re-runs `QB_OUT_SCALES = [25, 50, 75]` under the new
source and writes both atomically:

```json
"qb_out": {"applied": true, "scale": 75.0, "source": "dropback_inferred",
           "adopted_utc": "2026-07-18T20:37:11Z",
           "source_switched_utc": null, "source_ab": null}
```

`source` is written on the **next run regardless of outcome** (default
`"dropback_inferred"`), so the live rule is always self-describing.

### 4.5 How a regression here is caught

- `tests/feature/qb_ground_truth.test.mjs` (B1):
  `game_params.qb_out.source ∈ {"dropback_inferred","last_started"}` and present;
  **if `source == "last_started"` then `source_ab` exists and its recorded delta
  really is `> margin`** — the write cannot claim an unearned swap;
  `qb_out.applied === true` and `scale ∈ [25,50,75]` — a swap may not silently
  un-adopt or invent a scale; `qb_starters.diagnostics` carries all three
  agreement rates and the post-change split (when the file exists — it is
  `OPTIONAL_DATA`).
- `promote_signals --selftest` gains the week-9 QB-change case.
- `build_predictions.py` prints the live source **and the fallback that fired**
  in its existing `promoted qb_out in effect: …` line, so a prod run is
  auditable from the log alone.
- **Rollback: set `game_params.qb_out.source = "dropback_inferred"` and re-run.
  Data-only, one field, no code revert.**

---

## 5. Item 2 — Defense-vs-Position (DvP)

Lowest external risk in the release, and the only item whose primary value ships
regardless of whether its gate family ever adopts.

### 5.1 `scripts/build_dvp_history.py` → `data/dvp_history.json` (owner B2)

Streams `iter_pbp_release(season)` and joins `pid → position` from
`fetch_roster_release(season)` (both exist). **Both sides of the ball are
emitted** (R4), so the family needs no external usage join and the file carries
its own balance invariant.

```json
{ "scoring": "ppr_scrimmage = rec*1 + rec_yds*0.1 + rush_yds*0.1 + scrimmage_td*6 + pass_yds*0.04 + pass_td*4 - int*2",
  "excludes": "2-pt conversions, fumbles lost, return TDs - pbp does not attribute them cleanly to the defense faced",
  "seasons": {"2025": {"SF": {"7": {
     "games": 1,
     "off": {"QB": {"ppr": 17.9, "opp": 33}, "RB": {"ppr": 22.1, "opp": 24},
             "WR": {"ppr": 31.7, "opp": 21}, "TE": {"ppr": 6.2, "opp": 5}},
     "def": {"QB": {"ppr": 14.2, "opp": 30}, "RB": {"ppr": 9.8, "opp": 19},
             "WR": {"ppr": 27.4, "opp": 26}, "TE": {"ppr": 11.0, "opp": 7}}}}}} }
```

Sums, not means (`epa_history` rule) so any window recomposes exactly.
`opp` = targets + carries + dropbacks, the sample-size denominator the UI needs.
`play_type in ('run','pass')` only. Unmapped player ids go to a **`"UNK"` bucket
that is written out and asserted `< 3%` of league PPR in the selftest** — an
unmapped-id blowout is a roster-feed regression and must be visible, not
silently dropped.

`--selftest` on `data/fixtures/nflverse_sample/pbp_dvp.csv` (+ existing
`roster.csv`): ~8 hand-computed plays; exact PPR arithmetic per position;
`LA→LAR` renaming; and the **league balance identity**
`Σ_teams off[pos].ppr == Σ_teams def[pos].ppr` for every position. Never writes.

### 5.2 `DvpFeatures` — the leak-free rule, and who owns it

`DvpFeatures` ships **inside `scripts/build_dvp_history.py`** (B2's file) and is
lazily imported by `promote_signals.py`. That keeps the leak rule next to the
artifact that defines it, keeps the gate file single-owner, and introduces no
new module tree.

For season `Y`, week `W`, defense `D`, position `p`:

```
cur_*  = Σ over weeks 1..W-1 of season Y          (strictly weeks < W)
prev_* = Σ over ALL weeks of season Y-1
rate   = w*rate_cur + (1-w)*rate_prev,  w = cur_games/(cur_games + DVP_N0), DVP_N0 = 4
```

- **Week 1:** `cur_games == 0 ⇒ w == 0` ⇒ the rate is the **complete prior
  season**, which finished before kickoff. Pregame-honest.
- **Prior season missing (2021) and `cur_games == 0`** ⇒ rate **undefined**, the
  family contributes `0.0`, and the count of such games is recorded in the
  promotion entry. **Never imputed.**
- `z_allowed[D][p]` is computed **within season Y over the same weeks-<W
  window**; if fewer than `MIN_DEFENSES_FOR_Z = 24` defenses are defined or
  `stdev == 0`, all z are `0.0`.
- Offensive profile `share[T][p] = off_ppr[T][p] / Σ_p off_ppr[T][p]` over the
  identical window and blend. Shares sum to 1.

`_season_sums(season, team, side, before_week=None)` uses
`if before_week is not None and int(wk) >= before_week: continue` — byte-identical
to `EpaFeatures._season_sums`. The selftest pins it the same way: on a fixture
where week `W` is an outlier, `rate(…, W)` and `rate(…, W+1)` must differ in the
direction that proves week `W` was excluded from the first.

### 5.3 `data/dvp.json` — the app rollup (owner B2)

```json
{ "season": 2026, "through_week": 6, "min_games": 4,
  "policy": "start/sit context - walk-forward by construction; never includes the week it describes",
  "teams": {"LAR": {"WR": {"ppr_per_game": 41.7, "rank": 30, "n_games": 6, "sample": "ok"}}} }
```

`rank` 1 = **toughest** (fewest PPR allowed), 32 = softest, stated in the file.
`n_games < min_games` ⇒ `"sample": "insufficient"` and **`rank` is `null`** —
never a rank off two games. `through_week` must equal `slate_week - 1`.

### 5.4 Family `dvp_mismatch`

```
edge(T, D) = Σ_p share[T][p] * z_allowed[D][p]
delta(g)   = scale * (edge(home, away_def) - edge(away, home_def))
DVP_SCALES = [0.0, 100.0, 200.0, 300.0]
```

A naive "this defence allows more points" family is collinear with `epa_total`'s
defensive half and adds nothing. The non-redundant thing DvP knows is
**positional asymmetry**: a defence elite vs WR and leaky vs RB has the same
aggregate EPA as a balanced one.

**Recorded expectation:** partly collinear with `epa_total` and `skill_out`; if
`epa_total` adopts first, `dvp_mismatch` must beat an incumbent containing it. It
may never clear 0.0015. **That is the gate working, and the app surface ships
either way.**

### 5.5 App surface (owner B4, after Rel17)

`player_weekly.json` week rows already carry `opp`, so no new client join key.

- `app/data.js`: `dvp: '/data/dvp.json'` in `PATHS` +
  `export const getDvp = (opts) => loadJson(PATHS.dvp, opts);` — the same
  404-graceful promise-cache pattern as `getPlayerWeekly`. On an older deploy the
  fetch rejects, callers catch, and the views render exactly as Rel17 left them.
- `app/views/lineup.js`: each starter row gains `vs LAR · 30th vs WR · through wk 6`.
- `app/views/compare.js`: a DvP row in the existing metric column.
- `"sample": "insufficient"` renders the literal `insufficient sample` — no rank,
  no colour band.
- **Rel17 co-existence (adversarial requirement neither prior doc covers):** the
  same Lineup rows carry Rel17's availability chips. On the 402pt iPhone viewport
  the DvP chip must **wrap below the availability chip and never truncate it**.
  Playwright asserts both chips present on one row and no horizontal overflow.
- Colour bands reuse **existing** `app/theme.css` tokens. If a new token is
  genuinely needed, `contrast_aa.test.mjs` must be re-run and the token proven AA.

---

## 6. Item 3 — FTN charting scheme proxy

### 6.1 Fetcher (owner B3, sole writer of `scripts/scrape/nflverse.py`)

```python
def fetch_ftn_charting_release(season, min_rows=20000):
    """FTN charting (ftn_charting_{season}.csv). 2022-2025 verified; 2021 and
    2026 are 404. Charted weekly in-season -> unlike participation data this IS
    usable in-season.

    DATA SOURCE: FTN Data via nflverse. CC-BY-SA 4.0; the attribution is carried
    in every artifact this feed produces and rendered wherever it surfaces."""
    url = f"{_RELEASE_BASE}/ftn_charting/ftn_charting_{int(season)}.csv"
    return fetch_release_csv(url, f"ftn_charting_{season}", min_rows=min_rows)
```

B3 also corrects the module docstring's stale claim that release assets 403 — to
a **conditional** statement ("these may 403 behind an egress policy; the
fetchers raise `FeedError` loudly when they do"), never an assertion that they
always work. The loud-failure path stays exactly as it is.

### 6.2 `scripts/build_scheme_history.py` → `data/scheme_history.json` (owner B3)

**The join.** FTN charting carries **no team column** (verified). The builder:

1. streams `iter_pbp_release(season)` once, building
   `{(nflverse_game_id, play_id): (posteam, defteam, week)}`;
2. fetches `fetch_ftn_charting_release(season)`;
3. joins on `(nflverse_game_id, nflverse_play_id)`. **Never** on games.csv's
   `ftn` column — it is 0% populated for 2023. **Unjoined rows are counted and
   reported; > 2% unjoined raises `FeedError`** — a join that quietly half-works
   is worse than no feed.

**The zero-sentinel filter is mandatory (R10).** ~23.7% of FTN rows are
uncharted/special-teams rows carrying `0` in the numeric columns; a naive
`mean(n_defense_box)` is dragged toward zero and reports every defence as a
"light box". The builder keeps only rows with `n_defense_box not in ('', '0')`
(≈36,081 real plays in 2025) and treats `''` and `'0'` distinctly from a genuine
count in `n_offense_backfield`. `qb_location == '0'` is likewise a sentinel, not
a location. Booleans are the literal strings `'TRUE'`/`'FALSE'`.

**Header assertion before parsing:** `nflverse_game_id, nflverse_play_id, season,
week, is_play_action, is_screen_pass, is_motion, is_no_huddle, n_defense_box,
n_offense_backfield, qb_location`. A rename upstream (the brief's `is_screen_p`
is exactly this risk) must raise `FeedError`, never yield a column of zeros.

```json
{ "attribution": "FTN Data via nflverse", "license": "CC-BY-SA 4.0",
  "coverage": "2022-2025; 2021 and 2026 are ABSENT, not zero",
  "seasons": {"2025": {"KC": {"7": {"off_plays": 62, "pa": 14, "screen": 7,
     "motion": 39, "no_huddle": 5, "def_plays": 58, "box_sum": 371.0,
     "box_plays": 58}}}} }
```

Sums, not rates. `box_sum / box_plays` recomposes the mean box count over any
window exactly.

**Fixture assertions (from the live 2025 filtered subset):** `is_play_action`
≈14.0%, `is_motion` ≈55.1%, `is_no_huddle` ≈9.7%, `is_screen_pass` ≈4.6%. The
selftest pins the arithmetic on `ftn_sample.csv` + `pbp_scheme.csv`, asserts an
unjoinable row is **counted not dropped**, asserts a missing required column
raises, and asserts a `0`-sentinel row is excluded from `box_plays`.

### 6.3 Family `scheme_matchup`

```
off_agg[T] = z(pa/off_plays) + z(screen/off_plays) + z(motion/off_plays) + z(no_huddle/off_plays)
def_box[D] = z(box_sum/box_plays)
edge(T, D) = off_agg[T] * def_box[D]        # misdirection vs a heavy, downhill box
delta(g)   = scale * (edge(home, away_def) - edge(away, home_def))
SCHEME_SCALES = [0.0, 40.0, 80.0, 120.0]; SCHEME_N0 = 400 plays
```

`SchemeFeatures` ships **inside `scripts/build_scheme_history.py`** (B3's file),
lazily imported by the gate — same rule as `DvpFeatures`.

### 6.4 The short runway — stated plainly, with the real numbers

FTN begins in **2022** (2021 → 404, verified). The gate walks 2022–2025 with
**2021 as the prior**. Therefore:

- 2021 has no FTN data, so the prior-season half of the 2022 blend is empty and
  the family is near-silent through most of 2022;
- usable eval ≈ **2023–2025, ~816 games** against the **1,087** every other
  family gets — **25% less data**;
- **the margin does not scale with the sample.** `scheme_matchup` clears the same
  0.0015 on 25% less data or it does not adopt. It is **structurally
  disadvantaged, and that is accepted, not corrected for.**

**Missing seasons: skip loudly, never impute.** A season with no FTN rows
contributes `delta = 0.0` for every game and the promotion record carries
`"coverage": {"seasons_with_ftn": [...], "seasons_skipped": [...], "games_priced": N}`.
A zero delta on a skipped season is **not** a claim that scheme does not matter
there; it is a claim that we do not know — the only honest option.

**Pre-committed expectation: `scheme_matchup` may legitimately never be adopted.
If it never clears 0.0015, that is the never-regress gate WORKING, not the
feature failing.** Success for Item 3 is defined as *"the family runs, is honest
about its coverage, and the trials are archived"* — **not** *"the family
adopts"*. A `RETAINED` verdict must not be relitigated later as a build failure.

### 6.5 Attribution — CC-BY-SA 4.0, rendered from the artifact

Never hardcoded, so removing the feed removes the credit and it cannot go stale:
(1) `scheme_history.json.attribution` / `.license` is the source of truth;
(2) the MODEL tab provenance footer renders
`Scheme data: FTN Data via nflverse (CC-BY-SA 4.0)` **read from that field**;
(3) any Lineup/Compare chip derived from scheme data carries the credit in its
detail popover; (4) `docs/SIGNAL_REGISTRY.md` records it against `scheme_fit`.
`rel18_contracts.test.mjs` asserts (1) is non-empty and that (2) derives from it
rather than being a literal.

---

## 7. Item 4 — participation personnel prior (DESIGNED, DEFERRED)

**Not built in the Rel18 build wave.** Specified so it can start the day the
evidence bar is met.

- Source: nflverse participation, `offense_personnel` / `defense_personnel`.
  Verified reachable 2016–2025; **2026 → 404 on 2026-08-13**, which is direct
  confirmation of the offseason-only cadence.
- **It does not update in-season.** It is published after the postseason
  completes; 2026 personnel will not exist until after the 2026 postseason.
  Therefore it is an **offseason prior only** — `"cadence": "offseason-only"`,
  `"source_season": 2025`, `"is_prior": true`, `"never_in_season": true`, and the
  module docstring opens with that warning. Any UI is prefixed `2025 PRIOR ·`.
- **Not** in `daily.yml` or `backtest.yml`. `workflow_dispatch` + a single March
  cron. Running it in-season could only republish last season's numbers under a
  fresh timestamp — a lie about freshness.
- **Two parsers are mandatory (R11).** The format breaks at the 2022/2023
  boundary: ≤2022 is `"1 RB, 1 TE, 3 WR"` (skill only); ≥2023 is
  `"1 C, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR"` (all 11 incl. OL). To recover "11
  personnel" from the 2023+ format, parse `"<count> <POS>"` tokens and count
  **only RB/FB/TE/WR**. A parser written against one era silently produces
  garbage on the other.
- **Special-teams contamination is mandatory to filter (R11).** Rows exist with
  `offense_personnel = "2 CB, 2 DE, 1 FS, 2 MLB, 1 OLB, 2 RB, 1 TE"` and a kicker
  inside `defense_personnel`. Filter to scrimmage plays or reject rows containing
  defensive position tokens. `n_offense`/`n_defense` carry a `'0'` sentinel;
  `defense_man_zone_type` / `defense_coverage_type` are ~50% populated — too
  sparse to lean on.
- Attribution: 2023+ is FTN-sourced ⇒ **CC-BY-SA 4.0, "FTN Data via nflverse"**.

**Evidence bar to start building it.** From the archived `scheme_matchup` trials,
either (a) it **clears MARGIN** outright, or (b) its best-scale improvement over
the incumbent is **positive in ≥2 consecutive weekly gate runs**. If the best
scale is `0.0` or the improvement is negative across the season, **Item 4 is not
built** — personnel groupings are a coarser proxy for the same underlying thing
on a strictly worse cadence, and adding data to a dead hypothesis is not a
feature. Re-evaluated **once**, at the end of the 2026 season.

---

## 8. Item 5 — coordinators: curated, display-only

`scripts/scrape/coordinators.py` (owner B4) — a **static curated table** in the
declared spirit of `scripts/scrape/stadiums.py`: no I/O, no network, gate-safe to
import. It lives under `scrape/` and scrapes nothing, exactly like `stadiums.py`.

```python
SOURCES = ("https://en.wikipedia.org/wiki/List_of_current_NFL_offensive_coordinators",
           "https://en.wikipedia.org/wiki/List_of_current_NFL_defensive_coordinators")
ATTRIBUTION = "Wikipedia (CC-BY-SA 4.0)"      # R12 - rendered wherever this shows
CHECKED_UTC = "2026-08-13"
SEASON = 2026
STALE_WARN_DAYS = 180
STALE_HIDE_DAYS = 365

COORDINATORS = {
    "KC": {"hc": "Andy Reid", "oc": "Matt Nagy", "dc": "Steve Spagnuolo",
           "oc_since": 2023, "dc_since": 2019},
    # ... all 32, validated against renames' canonical team set at import
}
```

`oc_since` / `dc_since` come from the Wikipedia `Since` column and give an honest
"first year in this system" context note with no modelling at all.

**Why it is not a model signal.** There is **no by-season historical OC/DC
release anywhere** — verified: `nfldata/coordinators.csv` and
`nfldata/coaches.csv` both 404, `DATASETS.md` lists draft picks, draft values,
games, colors, logos, rosters, standings, teams, trades and **no coordinators**;
`spatto12/NFLCoaches` is head coaches only, 1966–2023. A current-season
cross-section gives the walk-forward gate **one** observation per team and
**zero** prior seasons. Any weight fitted on it would be fitting 2026 to itself.
**Display and context only; `coordinator_change` stays an empty slot.**

**Refresh story, honestly.** Coordinator churn clusters in **January–February**
(Black Monday through the Super Bowl). So:

- **Who/when:** a human, once per offseason in February, plus ad hoc after an
  in-season firing. This ships as a **manual handoff** in the backlog with
  copy-paste-ready steps: open the two Wikipedia lists → diff against
  `COORDINATORS` → edit the dict → bump `CHECKED_UTC` → run the gate.
- **App behaviour:** `now - CHECKED_UTC` over **180 days** ⇒ render under a
  `COACHING STAFF · AS OF <date>` header with a muted `may be out of date` note;
  over **365 days** ⇒ **suppress the block entirely** and render `coaching staff
  data not refreshed for this season`. A stale coordinator shown confidently is
  worse than no coordinator — the same discipline `weather_forecast` uses when
  its horizon lapses.
- **Validator:** the table must contain exactly 32 canonical teams and its
  `SEASON` must match `data/meta.json`'s season, so staleness fails the gate
  rather than reaching the UI.
- `--selftest`: 32 teams exactly once, no empty strings, `CHECKED_UTC` parses,
  `STALE_WARN_DAYS < STALE_HIDE_DAYS`.

---

## 9. `scripts/promote_signals.py` — consolidated gate change (owner B1, SOLE WRITER)

### 9.1 Why `referee` is CUT — the decisive finding

`run()` selects **one** `best_overall` family, then:

```python
adopt = (best_overall is not None and inc_loss - best_overall[1]["log_loss"] > MARGIN)
if adopt and best_overall[0] not in APPLIABLE:
    adopt = False
    pending = best_overall
```

There is **no fall-through to the best appliable family**. A non-appliable
family that happens to post the lowest log-loss **suppresses adoption for the
entire run** — including a genuinely adoptable family sitting just behind it.
Today every one of the eight families is in `APPLIABLE`, so this branch has
never fired. Rel18 would be the first release to make it reachable.

`referee` can **never** be applied — the crew chief is **0/272 on unplayed
games** (verified) and there is no verified pregame crew-assignment feed in this
platform. So a `referee` family has **zero upside and a real, recurring downside:
it can starve a real adoption.** It is cut.

**What replaces it, so the evidence is not lost.** `referee` remains a field in
`game_context.json`, and `promote_signals.py` gains a standalone
`--referee-report` mode: it computes crew-level shrunk home-residual bias over
the walk and appends a `{"kind": "referee_diagnostic", "format": 1, …}` entry to
`model_tuning.history`. It is **never** a member of `families[]`, never enters
the adoption race, and never writes `game_params`. If the diagnostic shows a
crew-level effect worth chasing, that is the evidence a future release needs to
justify sourcing a **pregame** assignment feed — which is the real prerequisite,
not more work on games.csv.

**Also deliberately not built:** a referee totals/penalty family. This gate's
objective is game-outcome log-loss; we do not model totals. Such a family would
have neither an objective nor an application path.

**Recorded as a known defect, not fixed here:** the no-fall-through behaviour in
`run()` is arguably conservative-by-design but silently drops a legitimate
adoption. Changing it alters never-regress semantics and belongs in its own
scoped release with its own test. **Rel18 avoids triggering it rather than
changing it.**

### 9.2 New constants

```python
CONTEXT_PATH = os.path.join(DATA, "game_context.json")
COACH_PATH   = os.path.join(DATA, "coach_history.json")
QBSTART_PATH = os.path.join(DATA, "qb_starters.json")
DVP_PATH     = os.path.join(DATA, "dvp_history.json")
SCHEME_PATH  = os.path.join(DATA, "scheme_history.json")

DIV_SCALES        = [-30.0, -20.0, -10.0, 10.0, 20.0, 30.0]   # signed: direction unknown
DIV_REMATCH_EXTRA = [-20.0, -10.0, 0.0, 10.0, 20.0]           # 2-D with DIV_SCALES
COACH_SCALES      = [0.0, 100.0, 200.0, 300.0]
REGIME_SCALES     = [-40.0, -25.0, -10.0, 10.0, 25.0, 40.0]   # signed
DVP_SCALES        = [0.0, 100.0, 200.0, 300.0]
DVP_N0            = 4                                          # games
SCHEME_SCALES     = [0.0, 40.0, 80.0, 120.0]
SCHEME_N0         = 400                                        # plays
MIN_DEFENSES_FOR_Z = 24
QB_SOURCES = ("dropback_inferred", "last_started")
```

New trials: `divisional` 30, `coach_quality` 3, `coach_regime` 6,
`dvp_mismatch` 3, `scheme_matchup` 3 = **45** on top of the existing ~40. A gate
run roughly doubles in wall clock; B4 adds `timeout-minutes: 60` to the
promotion step in `backtest.yml`.

### 9.3 The residual-row change (D5), and its pure-refactor proof

```python
residuals.append((h, actual - p_flat, is_cold_game(g), ctx_key))   # was 3-tuple
# ctx_key = f"{season}|{g.get('week')}|{h}|{a}"  (None when season is not passed)
```

`walk_season` gains `season=None`; `features_from_residuals` unpacks
`for team, r, cold, _ctx in residual_rows:`. Call sites: `evaluate()` (lines
~623 and ~631, pass `season=yr`) and `_write_adoption()` (line ~880). Verified by
grep that no module outside `promote_signals.py` imports either function.

**Required in `selftest()`:** with the same synthetic rows,
`features_from_residuals` must return **byte-identical** venue and cold deltas
before and after the shape change, and the tuple length must assert `== 4`. That
assertion is what stops a shared-structure change from silently moving an
adopted family's numbers.

Only `coach_quality` needs the key. It is still required: `training_residuals`
span all prior seasons, so a residual cannot otherwise be mapped back to a game.

### 9.4 The eight-point family checklist

Every new family is wired at all eight sites or it fails silently:
(1) scale grid; (2) `*_inputs()` returning `None` when data is absent;
(3) `(setup, factory)` builder; (4) trials block with the skip-loudly idiom;
(5) `APPLIABLE` — **only** if a prediction-time path exists;
(6) `_write_adoption` branch; (7) **`_incumbent_family_fns` branch — the nastiest
omission: an adopted family missing here is not part of next week's incumbent, so
it re-clears the margin every week against a bar that excludes it and the gate
silently stops being never-regress**; (8) `*_current(season)` reader + the
`build_predictions.py` block.

```python
APPLIABLE = {"environment", "rest", "epa_total", "epa_pass", "elo_epa",
             "qb_out", "weather_wind", "skill_out",
             "divisional"}
```

**CORRECTED (R21).** The design intended all 13 to be appliable ("Rel18
introduces no non-appliable family", §9.1). What shipped wires only
`divisional` into `scripts/build_predictions.py`; `coach_quality`,
`coach_regime`, `dvp_mismatch` and `scheme_matchup` have readers but no caller,
so listing them in `APPLIABLE` would make the gate claim an application path the
pipeline does not have. They stay out until the reader is wired — and
`scheme_matchup` cannot be wired for the live season at all while FTN charting
has no release for it (§9.5, `application.dark`).

That leaves the §9.1 hazard that cut `referee` — a non-appliable family that
WINS a run — live four times over, so the gate no longer resolves it by
suppressing adoption. `promote_signals.fallthrough_candidate` records the
unappliable winner (`application_pending`, and `would_adopt` when nothing else
is adopted) and then falls through to the best APPLIABLE family, which is
**re-tested on its own significance**, never adopted on the winner's evidence.
An unwired family therefore has no downside either: it can never cost a wired
family its earned adoption. The margin between the two is real — on the corpus
the best appliable (`rest` scale=3.0, 0.63032) and the best non-appliable
(`coach_regime` shrink=0.15, 0.63038) sit 0.00006 apart.

`_write_adoption` blocks: `divisional → {applied, scale, rematch_extra}`;
`coach_quality → {applied, scale, shrink_n: 16, deltas: {coach: q}}` (production
fit over **all** resolved seasons, matching the `venue_hfa` precedent);
`coach_regime → {applied, scale}`; `dvp_mismatch → {applied, scale, n0_games}`;
`scheme_matchup → {applied, scale, n0_plays, attribution, license}`.

### 9.5 Family definitions

**`divisional`** — `delta = scale + (rematch_extra if meeting_no == 2 else 0)`
when `div_game == 1`, else `0.0`. Missing context key ⇒ `0.0`, never a crash.
Direction is unknown a priori (familiarity may compress the home edge), hence a
signed grid, exactly as `WIND_SCALES` is signed.

**`coach_quality`** — residual-fitted, **differenced**:
`q[coach] = scale * shrink(n) * mean(signed residual over TRAINING games)`
(`+r` when the coach was HOME, `-r` when AWAY), `delta = q[home] - q[away]`,
`shrink` reusing `SHRINK_N = 16`. Training residuals only (seasons < eval
season) — the leak discipline `features_from_residuals` already enforces.

**`coach_regime`** — `delta = scale * (away_first_year - home_first_year)` where
`first_year` is 1 when this is the coach's first season **with this team**. This
is the game-side expression of the `head_coach_change` registry slot.
First-year regime team-games per season: 2021: 129 · 2022: 97 · 2023: 71 ·
2024: 68 · 2025: 88 · 2026: 68 — a workable sample.

**`dvp_mismatch`** (§5.4) and **`scheme_matchup`** (§6.3) as specified.

### 9.6 Why coach-vs-coach pairings are NOT built

Coach *identity* is rich: 177 distinct head coaches over 27 seasons, 137 with
≥32 games. Coach-level aggregate, tenure and first-year effects are exactly what
`coach_quality` and `coach_regime` price.

Specific **pairings** are not: **3,452** distinct pairings, **median 1 meeting**,
**57% have exactly one**, only **63 (1.8%)** have ≥10, and the most-played
pairing all-time is Harbaugh–Tomlin at 40. Fitting a per-pairing effect on n ≤ 2
and asking it to clear a 0.0015 log-loss margin is fitting noise and calling it a
coaching matchup. **Not built — a data-shape refusal.** The honest future form is
a hierarchical shrink toward the coach-level effect, which is a different design,
not a scale grid.

### 9.7 Multiplicity — the brake

Rel18 takes the gate from 8 candidate families to **13**, and from 45 to 89
trials. More chances that one clears the bar by luck.

**CORRECTED (R21).** The paragraph this replaces said "the margin does not move,
it stays 0.0015". That was already stale when Rel18 shipped: R18 retired the
fixed 0.0015 constant for a **significance-based** threshold —
`max(MIN_EFFECT, t_crit x se)`, where `se` is the candidate's own CR1
fold-clustered standard error and `t_crit` is Bonferroni-corrected at
`alpha / n_trials` (`scripts/promote_signals.adoption_threshold`). 0.0015 was
only ~0.85 sigma, i.e. not a significance bar at all.

So the margin **does** move, and Rel18 moved it: the Bonferroni divisor is every
trial the run evaluates, so going 45 -> 89 trials took `t_crit` from ~9.85 to
~12.42 and the threshold from ~0.00993 to ~0.01252 — a ~26% higher bar **for
every family**, including the ones that were already clearing it. That is the
honest price of searching wider, and it is deliberately paid rather than dodged:
scoping the correction to one family would make the bar depend on which family
happened to win, which is the selection effect the correction exists to price.
The run records `significance.trials` and `significance.trials_note` so a reader
can see which run's bar they are looking at and why an incumbent-improving family
may have stopped clearing.

Four brakes remain: (1) one family adopted per run, so a lucky family must be the
best of 13; (2) the incumbent absorbs adoptions, so a noise adoption must keep
earning every later week; (3) walk-forward over four held-out seasons; (4) the
promotion entry records the full multiplicity exposure (`significance.trials`,
`alpha_bonferroni`, `t_crit`, `threshold`) so any adoption can be re-checked from
the archive.

---

## 10. `scripts/validate_data.py` and contracts (owner B4)

1. `SCHEMA_TO_DATA` — six new pairs.
2. `OPTIONAL_DATA` += `game_context.json`, `coach_history.json`,
   `qb_starters.json`, `dvp_history.json`, `dvp.json`, `scheme_history.json` —
   all runner-built; absence before the bootstrap dispatch is documented state,
   not failure.
3. **`check_no_betting_columns(docs)`** — §3.2 layer 3. Denylist is a literal.
4. **`check_dvp_leak_free(dvp, dvp_history, predictions)`** —
   `dvp.through_week == predictions.week - 1` (when both exist); every
   `sample == "ok"` cell has `n_games >= min_games`; every `"insufficient"` cell
   has `rank is None`; ranks per position are a permutation of `1..n_ranked`
   (no ties, no gaps); and a **spot-check** that re-derives one deterministic
   cell (first team alphabetically, `WR`) straight from `dvp_history` over weeks
   `1..through_week` and asserts `|recomputed - ppr_per_game| <= 0.05`. That is
   the assertion that catches "week W's own data leaked into week W's rank".
5. **`check_game_context_join(game_context, finals)`** — new: every REG game in
   `finals_{yr}.json` for `yr in SEASONS` has a `game_context.games` row. Verified
   achievable today at 1,359/1,359. A silent join regression (an upstream team-code
   change) would otherwise turn `divisional` into a family of zeros.
6. `_selftest()` — red/green cases for all three: a doc with a `spread_line` key
   at depth 3 must be caught; a `dvp.json` whose `through_week` equals the slate
   week must be caught; a cell with `n_games = 2` and a non-null `rank` must be
   caught; a missing context row must be caught. `validate_data.py --selftest` is
   already wired into `smoke.sh`, so these run in the gate.

**Every contract:** draft-07, `$id` = filename, `title`, a `description` stating
the honesty policy, `additionalProperties: false` at top level, `required`
listing `generated_utc`, `source` and the payload key. **No schema may rely on
`minProperties`, `pattern` or `exclusiveMinimum`** — verified unimplemented.
Anything load-bearing lives in a `check_*` function, a node test, or a builder
selftest. A schema file with no `SCHEMA_TO_DATA` entry is validated by nothing;
the registration line and the schema file land in the **same commit**.

**Explicitly unchanged:** `EXPECTED_SIGNALS` (32 names), `check_meta_weights`,
`MARKET_DISPLAY_ONLY`.

---

## 11. Test impact matrix

### 11.1 Existing tests that MUST change

| File | Where | Change | Symptom if missed |
|---|---|---|---|
| `tests/feature/rel7_contracts.test.mjs` | `:26` | `FAMILIES` 8 → **13** (`+divisional, coach_quality, coach_regime, dvp_mismatch, scheme_matchup`) | `deepEqual` fails on the first gate run after the families ship |
| `tests/feature/rel7_contracts.test.mjs` | `:75-83` | `block` map gains `divisional: gp.divisional`, `coach_quality: gp.coach_hfa`, `coach_regime: gp.coach_regime`, `dvp_mismatch: gp.dvp_hfa`, `scheme_matchup: gp.scheme_hfa` | On the day one adopts, `block && block.applied` is `undefined` → **red gate on a correct adoption** |
| `tests/feature/rel7_contracts.test.mjs` | `:39-42` | pin `divisional.trials.length === 30` alongside environment-15 / rest-4 | additive |
| **`tests/web/web.spec.mjs`** | **`:849-850`** | **`expect(rows).toBe(8)` → `13`, `expect(chips).toBe(8)` → `13`, and the family-name loop at `:842-843` gains the five new names** | **Playwright red. `tests/run_gate.sh` runs playwright with no path filter, so `tests/web` IS in the gate.** The most easily missed change in the release |
| `tests/smoke.sh` | after the Rel17 selftest block | six new `--selftest` lines | New builders ship untested by the gate |
| `scripts/validate_data.py` `_selftest` | — | new red/green cases (§10.6) | "A check nobody has watched fail is a check that might do nothing" |
| `scripts/promote_signals.py` `selftest` | `:917` | six new assertions (§11.3) | The residual-shape refactor ships unproven |
| `.github/workflows/backtest.yml` | — | five builder steps + `timeout-minutes: 60` on the promotion step | Gate runs on absent artifacts; families skip forever, nobody notices |
| `.github/workflows/daily.yml` | — | `build_qb_starters.py` + `build_dvp.py` | `last_started` prices next week off stale starts; DvP chips freeze |

### 11.2 Tests at risk that MUST NOT change

| File | Rule |
|---|---|
| `tests/feature/signal_registry.test.mjs` | 32-name `EXPECTED` list. **`data/meta.json` and `scripts/signals/registry.py` are untouched by Rel18.** Editing either reds this test, `validate_data.EXPECTED_SIGNALS` and the `smoke.sh` invariant block together |
| `tests/feature/never_regress.test.mjs` | Top-level `model_tuning` keys (`current_loss`, `candidate_loss`, `margin`, `adopted`) belong to the *parameter* backtest, not the family gate. `promote_signals` only inserts into `history`. No Rel18 change may touch them |
| `tests/feature/model_view.test.mjs` | `MARKET_SIGNALS` mirrors `validate_data.MARKET_DISPLAY_ONLY`. Rel18 adds `check_no_betting_columns` and **does not touch `MARKET_DISPLAY_ONLY`** |
| `tests/feature/contrast_aa.test.mjs` | Rel17 is editing it. B4 reuses existing `theme.css` tokens; a genuinely new band colour must be proven AA and this re-run |
| `tests/feature/learning_loop.test.mjs` | `MARGIN` is imported **from** `refit.py` and must never be redefined in `promote_signals.py` |

### 11.3 New tests

| File | Owner | Asserts |
|---|---|---|
| `tests/feature/nfldata_guard.test.mjs` | B1 | the four-layer betting guard, incl. the **poisoned-fixture byte-identity** selftest |
| `tests/feature/qb_ground_truth.test.mjs` | B1 | source/scale/A-B consistency; a claimed swap really cleared the margin; all three agreement rates published |
| `tests/feature/rel18_families.test.mjs` | B1 | each of the five new families is trialed-or-skipped-with-reason; `divisional` has 30 trials; `scheme_matchup` carries a `coverage` block naming skipped seasons; **`referee` never appears in `families[]`**; `families_tested === 13` |
| `tests/feature/dvp.test.mjs` | B2 | `dvp.json` rank/sample consistency; the leak proof; the league-balance identity |
| `tests/feature/scheme.test.mjs` | B3 | zero-sentinel exclusion; unjoined-row counting; `attribution`/`license` non-empty |
| `tests/feature/rel18_contracts.test.mjs` | B4 | app attribution string derives from the artifact; coordinator 180/365 thresholds and `CHECKED_UTC` parses; **day-zero identity** — every Rel18 `game_params` block is absent or carries `applied` |

---

## 12. Build partition — four agents, disjoint file ownership

**No two agents write the same file.** `DvpFeatures` and `SchemeFeatures` ship
inside their own builders (lazily imported by the gate) precisely so
`promote_signals.py` keeps a single owner.

| Agent | Writes — EXCLUSIVELY | Reads only | Blocked on |
|---|---|---|---|
| **B1 — games enrichment + gate** | `scripts/scrape/nfldata.py`, `scripts/build_game_context.py`, `scripts/build_coach_history.py`, `scripts/build_qb_starters.py`, **`scripts/promote_signals.py` (SOLE WRITER)**, `data/contracts/{game_context,coach_history,qb_starters}.schema.json`, `tests/feature/{nfldata_guard,qb_ground_truth,rel18_families}.test.mjs`, `tests/feature/rel7_contracts.test.mjs` | `build_market_baseline.py` (pattern only), B2/B3 feature-class signatures | — |
| **B2 — DvP** | `scripts/build_dvp_history.py` (incl. `DvpFeatures`), `scripts/build_dvp.py`, `data/contracts/{dvp_history,dvp}.schema.json`, `data/fixtures/nflverse_sample/pbp_dvp.csv`, `tests/feature/dvp.test.mjs` | `scripts/scrape/nflverse.py` (read-only) | — |
| **B3 — FTN scheme** | **`scripts/scrape/nflverse.py` (SOLE WRITER)**, `scripts/build_scheme_history.py` (incl. `SchemeFeatures`), `data/contracts/scheme_history.schema.json`, `data/fixtures/nflverse_sample/{ftn_sample,pbp_scheme}.csv`, `tests/feature/scheme.test.mjs` | — | — |
| **B4 — app surfaces + coordinators + integration** | `scripts/scrape/coordinators.py`, `scripts/build_predictions.py`, `scripts/validate_data.py`, `tests/smoke.sh`, `tests/web/web.spec.mjs`, `app/data.js`, `app/views/{team,lineup,compare}.js`, `app/theme.css`, `.github/workflows/{backtest,daily}.yml`, `tests/feature/rel18_contracts.test.mjs` | everything | **Rel17 merged**, then B1–B3 |

**Interface contracts agreed up front, before any agent starts** (this is what
lets B1/B2/B3 run fully parallel):

```
# B2 exports, from scripts/build_dvp_history.py
class DvpFeatures:
    def __init__(self, doc): ...
    def has_season(self, season) -> bool
    def diff(self, game, season) -> float      # home_edge - away_edge, 0.0 when undefined
    def undefined_games(self) -> int

# B3 exports, from scripts/build_scheme_history.py
class SchemeFeatures:
    def __init__(self, doc): ...
    def has_season(self, season) -> bool
    def diff(self, game, season) -> float
    def coverage(self) -> dict   # {seasons_with_ftn, seasons_skipped, games_priced}
```

**Waves:**

- **Wave 1 (3 parallel): B1, B2, B3.** Fully independent; no shared file.
- **Wave 2 (1): B4.** Blocked on Rel17 merging. Rebases onto merged Rel17, then
  lands: the five `build_predictions.py` application blocks, the schemas +
  `OPTIONAL_DATA` + three new invariants, all six `smoke.sh` selftest lines, the
  Playwright family count, the DvP chips, the coordinator block, and the workflow
  steps — **in one commit each**.

**Named collisions, so they are avoided:**

- `tests/smoke.sh` — B1/B2/B3 each *want* a selftest line. **They must not.**
  Each writes the selftest inside its own module; **B4 adds all six in one edit**,
  after Rel17's lines.
- `scripts/scrape/nflverse.py` — B2 **reads** `iter_pbp_release` /
  `fetch_roster_release`; only **B3 writes** it.
- `tests/feature/rel7_contracts.test.mjs` — **B1's**, not B4's: the `FAMILIES`
  array must change in the same commit as the families themselves.
- `tests/web/web.spec.mjs`, `app/theme.css`, `app/views/*.js`,
  `scripts/validate_data.py`, `scripts/build_predictions.py` — Rel17-owned;
  **B4 only, after Rel17 merges**.
- `data/meta.json`, `scripts/signals/registry.py` — **untouched by Rel18.**

**Cadence wiring (B4):** `build_game_context.py`, `build_coach_history.py`,
`build_dvp_history.py`, `build_scheme_history.py` → `backtest.yml` weekly;
`build_qb_starters.py` → `backtest.yml` **and** `daily.yml`; `build_dvp.py` →
`daily.yml`; `build_personnel_prior.py` → `workflow_dispatch` + one March cron,
**never in-season**; `coordinators.py` → no workflow, hand-curated.

Every builder follows the honesty contract: `FeedError` on transport/non-200/
short rows, **keep the existing file on failure**, past seasons immutable, sums
not means, a `pipeline_status` feed row with real `rows`/`status`, and a
`--selftest` on a committed fixture that **never writes**.

---

## 13. Fantasy stories and acceptance criteria

**S1 — Stream a defence without walking into a buzzsaw.** *As a manager holding
two streaming candidates in week 7, I want to see which offences they face and
how those offences have actually scored.*
**AC:** the Lineup row shows `vs <OPP> · <rank> vs <POS> · through wk N · N games`;
a defence with `< 4` games shows `insufficient sample` and **no rank**; the rank
never reflects the week being displayed (`through_week == slate_week - 1`,
enforced by `check_dvp_leak_free`).

**S2 — Start/sit on the matchup, not just the projection.** *Reproduction: week
7, choosing between a WR2 facing a defence ranked 30th vs WR and a WR2 facing one
ranked 3rd vs WR, projections within 0.4 points.*
**AC:** Compare shows a DvP row for both; tapping reveals PPR allowed per game
and the sample size; every number is re-derivable by hand from
`dvp_history.json`.

**S3 — The benched starter, priced honestly.** *Reproduction: a starter is
benched in week 9. Under the old rule he is still "the primary passer" in weeks
10–15, so an "QB out" report moves the line the wrong way for six weeks.*
**AC:** `qb_starters.json.diagnostics` publishes agreement for all three rules,
split stable vs post-change; **if and only if** the paired A/B beats the
incumbent source by `> 0.0015` does `game_params.qb_out.source` become
`"last_started"`, with `source_ab` recording both log-losses; a label lag > 1
week forces a printed fallback rather than a silent one.

**S4 — Divisional rematch.** *Reproduction: a week-16 rematch of a week-4
divisional game.* **AC:** `game_context.json` marks it `div_game: 1,
meeting_no: 2`; `divisional` is trialed over 30 combinations; if it does not
clear the margin the MODEL tab shows it `RETAINED` with its best loss — visible,
at weight 0.

**S5 — New head coach, honest silence on the pairing.** **AC:**
`coach_history.json` marks a first-year regime; `coach_regime` is trialed; the
MODEL tab and `docs/SIGNAL_REGISTRY.md` state plainly that coach-**vs**-coach
pairings are not modelled, with the arithmetic: 3,452 pairings, **median 1
meeting**, 57% with exactly one, 63 with ≥10.

**S6 — Coaching staff context.** **AC:** the Team tab shows HC/OC/DC with
`since` years from the curated table, credited to Wikipedia (CC-BY-SA 4.0); over
180 days stale it renders under `AS OF <date>` with `may be out of date`; over
365 days the block is replaced by `coaching staff data not refreshed for this
season`.

**S7 — The credit is paid.** **AC:** wherever a scheme-derived value surfaces,
`FTN Data via nflverse (CC-BY-SA 4.0)` renders, **sourced from
`scheme_history.json.attribution`**, not a literal.

**S8 — No market leakage, provably.** **AC:** `nfldata_guard.test.mjs` green;
`check_no_betting_columns` passes; the poisoned-fixture projection is
byte-identical to the clean one; the eight betting column names appear nowhere
in any enrichment builder, the gate, or the predictor.

**S9 — Chips co-exist with Rel17.** **AC:** on the 402×874 iPhone viewport a
Lineup starter row shows both the Rel17 availability chip and the Rel18 DvP chip,
neither truncated, with no horizontal overflow.

**S10 — A family that never adopts is not a failure.** **AC:** if
`scheme_matchup` records `RETAINED` every run, the MODEL tab still lists it with
its trials and its `coverage` block naming the skipped seasons. The design has
pre-committed that this is the gate working.

---

## 14. Gate and rollback

```
python3 scripts/validate_data.py                          # +6 schemas, +3 cross-file invariants
bash tests/smoke.sh                                       # +6 python selftests (B4 adds them all)
node --test tests/feature/*.mjs                           # +6 new files, 1 edited (rel7_contracts)
npx playwright test --config tests/playwright.config.mjs   # no path filter -> tests/web + tests/pwa
```

`tests/run_gate.sh` runs these in order and gates on **exit codes**, never on
grepped summaries. **`tests/competition.test.mjs` does not exist in this repo** —
`TECH_DESIGN.md §16` carried it over from the wc2026 project; ignore it.

| Change | Rollback |
|---|---|
| `qb_out` source swap | `game_params.qb_out.source = "dropback_inferred"`, re-run. **Data-only, one field, no code revert** |
| Any new family adoption | Delete its block from `game_params`; `build_predictions` guards on `applied` and reverts to byte-identical output |
| DvP / scheme / coordinator app surfaces | `git revert` the B4 commit; views degrade to Rel17 because every new read is 404-guarded |
| A whole artifact | Delete the file — it is `OPTIONAL_DATA`, the gate stays green, every consumer already skips loudly |
| The residual 4-tuple refactor | `git revert` B1's commit — the only structural change, and the one covered by the byte-identity assertion in `selftest()` |

**Day-zero output guarantee.** With no new family adopted and every new artifact
absent, `build_predictions.py` produces **byte-identical** output to Rel17 —
every addition is behind an `applied` flag **and** a file-existence guard.
`rel18_contracts.test.mjs` asserts it directly. That property is what makes this
release safe to land next to Rel17.

---

*Design-only. No code, test, data, contract or workflow file was created or
modified by this document's author; the only file written is this one.*
