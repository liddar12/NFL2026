# Rel18 — Coaching, Scheme & Matchup Context: TECHNICAL DESIGN

**Role:** Technical Design Lead · **Companion to:** `docs/roadmap/rel18/ARCHITECTURE.md`
**Repo:** `/home/user/nfl2026` — vanilla-JS no-build PWA + stdlib-only Python pipeline.

> **Rel17 is in flight in this tree.** This document specifies changes to files
> Rel17 owns (`scripts/build_predictions.py`, `scripts/validate_data.py`,
> `app/views/lineup.js`, `app/views/compare.js`, `app/theme.css`). Every such
> change is assigned to the single integration agent (**A7**) and is **blocked on
> Rel17 merging**. No other Rel18 agent may open those files. §14 is the binding
> partition.

---

## 0. What this document is, and where it deviates from ARCHITECTURE.md

`ARCHITECTURE.md` settles *what* Rel18 builds and *why*. This document settles
*how*: exact module names and function signatures, exact JSON shapes and their
schema registration, the exact edits to `scripts/promote_signals.py` (family
builders, trial grids, `APPLIABLE`, `_incumbent_family_fns`, `_write_adoption`,
`selftest`), the exact application blocks in `scripts/build_predictions.py`, and
a line-level inventory of **every existing test that must change**.

Five technical corrections to the architecture, each with its engineering reason.
An architect confirm is requested on D1 and D2; D3–D5 are defect fixes and are
not optional.

| # | ARCHITECTURE.md says | This design says | Why |
|---|---|---|---|
| **D1** | Two families `div_game` and `div_rematch` | **One family `divisional`** with a 2-D grid `(base_scale, rematch_extra)` | `div_rematch ⊂ div_game` by construction. Two correlated families compete for the same one-adoption-per-run slot and double the multiplicity exposure for one hypothesis. `environment` already demonstrates the 2-D-grid-in-one-family pattern (venue × cold, 15 trials). Net families 14, not 15. |
| **D2** | `game_context.json` keyed `seasons.<yr>.<"week\|home\|away">` | Flat top-level `games` map keyed **`"{season}\|{week}\|{home}\|{away}"`** | That is byte-for-byte the key `market_baseline.json` and `weather_history.json` use, so `promote_signals._load_json(path, "games")` and the existing `f"{season}\|{g['week']}\|{g['home']}\|{g['away']}"` lookup work verbatim. A second key convention is a bug farm. |
| **D3** | `dvp_mismatch` weights opponent weakness by `player_usage_history.json` shares | Offensive positional profile comes from **`dvp_history.json`'s own offensive mirror** | `player_usage_history.json` rows are `{team, opp, share}` — **there is no `position` field**, so the architecture's `usage_share[off][pos]` join cannot be computed. The DvP builder already holds the `pid→position` roster map; emitting both sides costs nothing, removes the dependency, and buys the same league-balance invariant `rel7_contracts.test.mjs` asserts for `epa_history`. |
| **D4** | FTN charting gives team tendency directly | FTN charting rows must be **joined to pbp on `(nflverse_game_id, nflverse_play_id)`** to learn `posteam`/`defteam` | The FTN charting release carries no team column. Without the join there is no team attribution and the family cannot be built. This makes `build_scheme_history.py` a pbp streamer too. |
| **D5** | `walk_season` residual row becomes a 4-tuple carrying the game dict `g` | 4-tuple carrying a **context key string**, `(team, resid, is_cold, ctx_key)` | Retaining the whole game dict in a residual row puts `home_score`/`away_score` inside the structure that *fits training features*. That is legal today (training seasons only) and a leak the day someone reuses the row elsewhere. A flat key of primitives cannot be misused. |

---

## 1. The machinery this design must obey

Read from source before designing. These are constraints, not preferences.

### 1.1 The candidate-family contract — an eight-point checklist

A family is not "added" by writing a builder. `scripts/promote_signals.py` wires
a family through **eight** distinct places, and missing any one is a silent
failure mode with a specific symptom:

| # | Site | Signature / shape | Symptom if omitted |
|---|---|---|---|
| 1 | **Scale grid constant** (module level, near `QB_OUT_SCALES:92`) | `NAME_SCALES = [...]` | — |
| 2 | **Input loader** `name_inputs()` returning `None` when data is absent | `-> tuple | None` | Family fakes zeros instead of skipping loudly |
| 3 | **Builder** `name_builder(scale, *inputs)` | returns `(setup, factory)`; `setup(season, games, training_residuals) -> ctx`; `factory(ctx) -> fn(game, idx) -> float` | — |
| 4 | **Trials block** in `run()` | `families.append({"family": ..., "trials": [...]})` or `{"skipped": True, "reason": ...}` | `rel7_contracts.test.mjs:38` fails — the FAMILIES deepEqual |
| 5 | **`APPLIABLE`** set (`:781`) | add **only** if a prediction-time path exists | A family with no path gets adopted and silently never applied |
| 6 | **`_write_adoption`** branch (`:869`) | writes `game_params.<block>` | `ADOPTED` prints, `game_params` unchanged, next run re-adopts forever |
| 7 | **`_incumbent_family_fns`** branch (`:412`) | rebuilds the adopted family into the incumbent | **The nastiest one.** An adopted family that is not in this function is *not* part of next week's incumbent, so the same family re-clears the margin every week against a bar that excludes it — the gate silently stops being never-regress |
| 8 | **Prediction-time reader** `name_current(season)` + the `build_predictions.py` block | `-> inputs | None` | `WARNING: … not applied`, or worse, adopted-but-dormant with no warning |

Every new family in §8 is specified against all eight points.

### 1.2 The validator implements a **subset** of draft-07 — do not rely on the rest

`scripts/validate_data.py:166 _validate` implements exactly: `type`, `enum`,
`minimum`, `maximum`, `required`, `properties`, `additionalProperties`
(bool **or** subschema), `items`, `minItems`, `maxItems`.

**Everything else is silently ignored**, including `minProperties`,
`maxProperties`, `pattern`, `exclusiveMinimum`, `exclusiveMaximum`, `oneOf`,
`format`. `market_baseline.schema.json`'s `"pattern": "MEASUREMENT ONLY"` and
`"minProperties": 1000` are **dead keywords today**. `epa_history.schema.json`'s
`minProperties: 30` likewise enforces nothing.

**Consequence, binding on every Rel18 contract:** a schema keyword is
documentation. Any invariant that must actually hold is enforced by

- a `check_*()` cross-file function in `validate_data.py`, **or**
- a `node --test` assertion in `tests/feature/`, **or**
- an assertion inside the builder's `--selftest`.

This matters most for the betting guard (§2.2): writing
`"pattern": "NO MARKET COLUMNS"` into `game_context.schema.json` would enforce
**nothing**. The guard is code + selftest + a real `check_no_betting_columns()`.

### 1.3 The builder honesty contract (from `build_epa_history.py`, `build_player_usage_history.py`, `build_market_baseline.py`)

Every new builder copies this, exactly:

1. `FeedError` (or a non-200 / short-row condition) → print to `stderr`, **keep
   the existing file**, `return 0 if existing else 1`.
2. Past seasons are **immutable**: present-in-file ⇒ not refetched. Only the
   current season refreshes.
3. Store **sums, not means**, so any rolling window recomposes exactly.
4. `--selftest` runs against a committed fixture under `data/fixtures/`, asserts
   exact arithmetic, prints one `selftest OK: …` line, and **never writes**.
5. Output written `json.dump(..., ensure_ascii=True, indent=1, sort_keys=True)`
   plus a trailing newline (`indent=1` — matches every runner-built sibling;
   `indent=2` is the app-facing convention used by `build_predictions._write`).
6. **Header assertion (new, Rel18):** before parsing rows, assert the CSV header
   contains every required column; a missing column raises `FeedError` rather
   than yielding a column of `None`. Upstream renames are the failure mode this
   catches — `is_screen_pass` vs `is_screen_p` is exactly that risk.

---

## 2. Item 1 — `scripts/scrape/nfldata.py`, the enrichment gateway

### 2.1 Module spec (owner: A1)

```python
"""nfldata games.csv reader — ENRICHMENT ONLY, betting columns physically absent.

SOURCE: https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
  7,548 rows, seasons 1999-2026, 100% coach coverage; 2026 carries all 272 games
  with coaches assigned. Verified reachable from the sandbox (same host+file that
  already powers scripts/build_market_baseline.py).

##### THE BETTING TRAP #####
This file also carries away_moneyline, home_moneyline, spread_line, total_line,
over_odds, under_odds, away_spread_odds, home_spread_odds. Market prices are
DISPLAY/MEASUREMENT ONLY and may NEVER be a model input (owner standing rule).
build_market_baseline.py reads the moneylines through its OWN separate urllib
fetch, for measurement, and is DELIBERATELY NOT refactored onto this module:
keeping two physically separate readers means the module the enrichment builders
import has no code path to a betting column at all. DRY here would re-import the
trap.
"""
```

| Symbol | Contract |
|---|---|
| `GAMES_URL` | the raw.githubusercontent URL above |
| `RENAMES` | `{"LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}` — **duplicated**, not imported from `build_market_baseline`, per the separation rule |
| `BETTING_COLUMNS: frozenset` | the eight names above |
| `ENRICHMENT_COLUMNS: frozenset` | `game_id, season, game_type, week, gameday, weekday, gametime, away_team, home_team, away_score, home_score, away_coach, home_coach, referee, div_game, away_qb_id, away_qb_name, home_qb_id, home_qb_name, stadium, stadium_id, location, roof, surface, away_rest, home_rest, temp, wind` |
| module-scope `assert` | `ENRICHMENT_COLUMNS.isdisjoint(BETTING_COLUMNS)` — import-time, fails fast |
| `fetch_games_text() -> str` | stdlib `urllib.request.urlopen(..., timeout=60)`; any exception propagates as `FeedError` |
| `iter_games_rows(seasons=None, game_type="REG")` | **projects** each `csv.DictReader` row to `{k: r.get(k) for k in ENRICHMENT_COLUMNS}`, applies `RENAMES` to `home_team`/`away_team`, coerces `season`/`week`/`div_game` to `int`. Raises `FeedError` if the header is missing any `ENRICHMENT_COLUMNS` member or if fewer than 7,000 rows arrive |
| `context_key(season, week, home, away) -> str` | `f"{season}\|{week}\|{home}\|{away}"` — the one join key (D2) |
| `selftest()` | see below |

`iter_games_rows` yields a **new dict built from the allow-list**. A betting
column is not filtered downstream — it is **never constructed**. A caller that
reaches for `row["spread_line"]` gets `KeyError`, not a number.

`--selftest` (no network; synthetic rows):

```
row = {"game_id": "2025_01_KC_LAC", "season": "2025", "week": "1",
       "home_team": "LA", "away_team": "KC", "div_game": "0",
       "spread_line": "-7.5", "home_moneyline": "-320", ...}
assert set(project(row)) <= ENRICHMENT_COLUMNS
assert "spread_line" not in project(row) and "home_moneyline" not in project(row)
assert project(row)["home_team"] == "LAR"                 # RENAMES applied
assert context_key(2025, 1, "LAR", "KC") == "2025|1|LAR|KC"
try: iter_games_rows_from_text(header_missing_referee); assert False
except FeedError: pass                                    # header guard fires
print("selftest OK: enrichment projection drops all 8 betting columns; header guard loud")
```

### 2.2 The betting guard — four enforcement layers

Layer 0 is new relative to `ARCHITECTURE.md` §2.2 and exists because of §1.2.

| Layer | Mechanism | Owner |
|---|---|---|
| **0 — schema (documentation only)** | `"policy": {"type": "string"}` carrying `NO MARKET COLUMNS — allow-listed at scripts/scrape/nfldata.py`. **Enforces nothing** (`pattern` is unimplemented); it is a note to the reader | A1 |
| **1 — code** | Projection at the source + import-time disjointness `assert` | A1 |
| **2 — test** | `tests/feature/nfldata_guard.test.mjs`: (a) reads `scripts/scrape/nfldata.py` as text; every betting-column literal occurs **only** inside the `BETTING_COLUMNS` block; (b) greps `build_game_context.py`, `build_coach_history.py`, `build_qb_starters.py`, `build_dvp_history.py`, `build_scheme_history.py`, `promote_signals.py`, `build_predictions.py` for all eight names — **zero hits**; (c) shells `python3 scripts/scrape/nfldata.py --selftest` and asserts exit 0 | A1 |
| **3 — data** | `validate_data.check_no_betting_columns(docs)` walks **every key at every depth** of `game_context.json`, `coach_history.json`, `qb_starters.json` and fails the gate on any key matching a betting-column name. Backstop for a shipped artifact when code *and* test were both edited | A7 |

### 2.3 `scripts/build_game_context.py` → `data/game_context.json` (owner: A1)

Seasons **2021–2026** (the gate window `promote_signals.SEASONS` plus the live
season). ~1,700 entries.

```json
{
  "generated_utc": "2026-08-14T07:03:11Z",
  "source": "nflverse nfldata games.csv via scripts/scrape/nfldata.py (enrichment allow-list)",
  "policy": "NO MARKET COLUMNS - betting columns are never read on this path",
  "seasons": [2021, 2022, 2023, 2024, 2025, 2026],
  "games": {
    "2025|1|LAR|KC": {
      "div_game": 0,
      "meeting_no": 1,
      "referee": "Clete Blakeman",
      "home_coach": "Sean McVay",
      "away_coach": "Andy Reid",
      "home_qb": {"id": "00-0033873", "name": "M.Stafford"},
      "away_qb": {"id": "00-0033873", "name": "P.Mahomes"}
    }
  }
}
```

- `meeting_no` is **derived by us**, not read: within a season, sort each
  unordered team pair's games by week; the first is 1, the second is 2.
- `home_qb`/`away_qb` may be `null` for a future game (2026 rows have coaches
  but no QB until played). Never fabricated.
- `--selftest`: synthetic 4-game season; asserts `meeting_no` is 1 then 2 for a
  repeated pair, asserts a null QB survives as `null`, asserts a betting key
  cannot appear in the emitted doc.

### 2.4 `scripts/build_coach_history.py` → `data/coach_history.json` (owner: A1)

Reads **all** seasons 1999–2026 (needed so "first year with this team" is
correct in 2021: a coach hired in 2019 is not a first-year coach in 2021).
Small — 177 coaches.

```json
{
  "generated_utc": "...",
  "source": "nflverse nfldata games.csv (away_coach/home_coach), 1999-2026",
  "coaches": {
    "Andy Reid": {
      "games": 431,
      "seasons": [1999, "...", 2026],
      "teams": {"PHI": [1999, 2012], "KC": [2013, 2026]},
      "first_season_by_team": {"PHI": 1999, "KC": 2013}
    }
  },
  "by_team_season": {"KC|2026": "Andy Reid"}
}
```

`by_team_season` is the O(1) lookup `coach_regime` uses.
`--selftest`: synthetic two-coach fixture asserting a mid-season replacement is
attributed per game (not per season) and that `first_season_by_team` picks the
minimum, not the first row encountered.

---

## 3. Item 1(a) — QB ground truth: `qb_starters.json` and the `qb_out` source swap

**The highest-value change in Rel18 and the only one that touches an already
adopted signal (`qb_out`, `scale 75.0`). It gets the most validation.**

### 3.1 Why the realised starter is not the pregame input

`home_qb_name` is *who actually took the first snap*. Feeding it into a pregame
price means the model knows the answer to the question `qb_out` asks. Because
`qb_out` is already adopted, a fake improvement would be baked into the
incumbent and would contaminate every future family comparison. **Rejected.**

What games.csv legitimately provides is a **ground-truth label**, and from a
label you build a better *pregame estimator*.

Today (`promote_signals.qb_out_inputs:141`) the expected starter for (T, W) is
the **cumulative-dropback leader over weeks < W**. Known severe failure: when a
starter is benched in week 9, the cumulative leader remains the *former* starter
until ~week 15, because he banked half a season of dropbacks. For six weeks the
family prices "is the primary passer out?" against the wrong player — exactly
the weeks when QB uncertainty is highest.

**The upgrade — `last_started`:** the expected starter for (T, W) is the player
who actually started T's most recent completed game before week W. Week 1 falls
back to the final start of the prior season; if that is missing, fall back to the
existing cumulative-dropback rule. Every input is a completed prior game ⇒
strictly pregame, leak-free by the same argument that makes
`EpaFeatures.margin(…, week)` leak-free.

### 3.2 `scripts/build_qb_starters.py` → `data/qb_starters.json` (owner: A2)

```json
{
  "generated_utc": "...",
  "source": "nflverse nfldata games.csv home_qb_name/away_qb_name via scripts/scrape/nfldata.py",
  "policy": "GROUND TRUTH LABEL - used to build a pregame estimator, never priced directly",
  "seasons": {
    "2025": {"9": {"CLE": {"id": "00-0039163", "name": "D.Gabriel"}}}
  },
  "diagnostics": {
    "seasons": [2021, "...", 2025],
    "team_weeks": 1445,
    "dropback_inferred_agreement": 0.9137,
    "last_started_agreement": 0.9564,
    "post_change_weeks": 118,
    "dropback_inferred_agreement_post_change": 0.5085,
    "last_started_agreement_post_change": 0.9153,
    "stable_weeks": 1327,
    "dropback_inferred_agreement_stable": 0.9498,
    "last_started_agreement_stable": 0.9600
  }
}
```

`--report` recomputes the `diagnostics` block: for each team-week it compares
both candidate rules against the realised starter, split by "weeks following a
QB change" (the population the upgrade targets) vs "stable weeks". A team-week
is *post-change* when the realised starter differs from the realised starter of
the team's previous game.

**Diagnostics are a measurement, not a gate.** A rule can agree less often
overall and still price better. It is published so the swap is explicable.

`--selftest`: synthetic season where CLE starts QB-A weeks 1–8 and QB-B weeks
9–18; assert `last_started` names QB-A for weeks ≤ 9 and QB-B from week 10, and
that `dropback_inferred` still names QB-A through ~week 15. That is the exact
failure the upgrade exists to fix, pinned in a test.

### 3.3 The acceptance bar — paired incumbent A/B (owner: A6)

New mode `python -m scripts.promote_signals --qb-source-ab`, which runs the
**full incumbent walk twice** over 2022–2025 — identical params, seasons and
families, differing **only** in `qb_out_inputs`' primary-passer rule:

```
qb_out source A/B  (incumbent walk, 2022-2025)
  dropback_inferred   log-loss 0.65312   n=1084
  last_started        log-loss 0.65090   n=1084
  delta               -0.00222           MARGIN 0.0015   -> SWAP
```

**Bar: the new source must beat the old by `MARGIN` (0.0015)** — the same
never-regress bar a new family faces. Not "no worse". Not a lowered margin. A
source swap on an adopted signal is at least as consequential as a new adoption.

If the delta is neutral or adverse: the inferred rule is **kept**, the A/B record
is archived anyway, and Rel18 ships `qb_starters.json` as a diagnostic artifact
only. **That outcome is a success of the gate.**

**Scale re-fit in the same write.** `scale = 75.0` was fitted under the inferred
source. On a swap, the A/B mode re-runs `QB_OUT_SCALES = [25, 50, 75]` under
`last_started` and adopts the best scale atomically with the source change:

```json
"qb_out": {
  "applied": true,
  "scale": 75.0,
  "source": "dropback_inferred",
  "adopted_utc": "2026-07-18T20:37:11Z",
  "source_switched_utc": null,
  "source_ab": null
}
```

`source` is written on the **next run regardless of outcome** (defaulting to
`"dropback_inferred"`), so the live rule is always self-describing. A swap sets
`source_switched_utc` and `source_ab: {dropback_inferred: <ll>, last_started: <ll>, delta: <d>, margin: 0.0015, n: 1084}`.

### 3.4 How a regression here is caught

- `tests/feature/qb_ground_truth.test.mjs` (new, owner A2):
  - `game_params.qb_out.source ∈ {"dropback_inferred", "last_started"}` and present;
  - if `source == "last_started"` then `source_ab` exists **and its recorded
    delta really is `> margin`** — the write cannot claim an unearned swap;
  - `qb_out.applied === true` and `scale ∈ [25, 50, 75]` — a source swap may not
    silently un-adopt or invent a scale;
  - `qb_starters.json.diagnostics` carries both agreement rates and both
    post-change rates (when the file exists; it is OPTIONAL_DATA).
- `promote_signals --selftest` gains the week-9 QB-change case from §3.2.
- `build_predictions.py` prints the live source in its existing
  `promoted qb_out in effect: …` line, so a prod run is auditable from the log.
- **Rollback:** set `game_params.qb_out.source = "dropback_inferred"` and re-run
  the pipeline. **Data-only, no code revert.**

### 3.5 Prediction-time path

`promote_signals.qb_out_current(season)` gains the `last_started` branch reading
`qb_starters.json`'s current season. Preseason, no 2026 starts exist ⇒ fall back
to the last start of 2025 (the honest preseason expectation) and print which
fallback fired. Dormant, never fabricated.

---

## 4. Item 2 — Defense-vs-Position (DvP)

### 4.1 `scripts/build_dvp_history.py` → `data/dvp_history.json` (owner: A3)

Streams `iter_pbp_release(season)` (proven) and joins a `pid → position` map from
`fetch_roster_release(season)` (exists). Both sides of the ball are emitted
(D3), so the family needs no external usage join and the file carries its own
balance invariant.

```json
{
  "generated_utc": "...",
  "source": "nflverse play-by-play + roster releases (PPR scrimmage core, both sides)",
  "policy": "DvP gate raw material + start/sit context - earns weight only via NEVER-REGRESS",
  "scoring": "ppr_scrimmage = rec*1 + rec_yds*0.1 + rush_yds*0.1 + scrimmage_td*6 + pass_yds*0.04 + pass_td*4 - int*2",
  "excludes": "2-pt conversions, fumbles lost, return TDs - pbp does not attribute them cleanly to the defense faced",
  "seasons": {
    "2025": {
      "SF": {
        "7": {
          "games": 1,
          "off": {"QB": {"ppr": 17.9, "opp": 33}, "RB": {"ppr": 22.1, "opp": 24},
                  "WR": {"ppr": 31.7, "opp": 21}, "TE": {"ppr": 6.2, "opp": 5}},
          "def": {"QB": {"ppr": 14.2, "opp": 30}, "RB": {"ppr": 9.8, "opp": 19},
                  "WR": {"ppr": 27.4, "opp": 26}, "TE": {"ppr": 11.0, "opp": 7}}
        }
      }
    }
  }
}
```

- **Field name is `ppr_scrimmage` in the docstring/`scoring` string and `ppr` in
  the cell**, with the exclusions stated in the artifact itself. Nobody may
  mistake it for a full fantasy total.
- `opp` = opportunities (targets + carries + dropbacks) — the sample-size
  denominator the UI needs to say "insufficient sample".
- Positions: `QB, RB, WR, TE`. A play whose player id is absent from the roster
  map is **counted into a `"UNK"` bucket that is written out and asserted small**
  (`< 3%` of league PPR in the selftest), rather than silently dropped — an
  unmapped-id blowout is a roster-feed regression and must be visible.

`--selftest` against a new fixture `data/fixtures/nflverse_sample/pbp_dvp.csv`
(+ reuse of `roster.csv`): ~8 hand-computed plays; asserts exact PPR arithmetic
per position, asserts `LA→LAR` renaming, and asserts the **league balance**:
`Σ_teams off[pos].ppr == Σ_teams def[pos].ppr` for every position. Never writes.

### 4.2 The leak-free walk-forward rule, concretely

This is the rule that makes DvP honest. It is implemented once, in
`promote_signals.DvpFeatures`, and re-derived independently by
`validate_data.check_dvp_leak_free`.

For a game in season `Y`, week `W`, defense `D`, position `p`:

```
cur_ppr[D][p]  = Σ  dvp_history[Y][D][w]["def"][p]["ppr"]   for w in 1..W-1
cur_games[D]   = Σ  dvp_history[Y][D][w]["games"]           for w in 1..W-1
prev_ppr[D][p] = Σ  dvp_history[Y-1][D][w]["def"][p]["ppr"] for ALL w
prev_games[D]  = Σ  dvp_history[Y-1][D][w]["games"]         for ALL w

rate_cur  = cur_ppr / cur_games       (0 games -> undefined)
rate_prev = prev_ppr / prev_games     (0 games -> undefined)
w         = cur_games / (cur_games + DVP_N0)          # DVP_N0 = 4 games
rate[D][p]= w * rate_cur + (1 - w) * rate_prev
```

- **Week 1 of any season:** `cur_games == 0 ⇒ w == 0`, so the rate is the
  **complete prior season** — which finished before kickoff. Pregame honest.
- **Prior season missing** (2021, the gate's first prior) **and** `cur_games == 0`
  ⇒ `rate` is **undefined**; the family contributes `0.0` for that game and the
  count of such games is recorded in the promotion entry. Never imputed.
- `z_allowed[D][p] = (rate[D][p] - mean_D rate) / stdev_D rate`, computed
  **within season Y over the same weeks-< W window**, over the defenses that have
  a defined rate. If fewer than 24 defenses are defined or `stdev == 0`, all z
  are `0.0` for that (Y, W, p).
- Offensive profile: `share[T][p] = off_ppr[T][p] / Σ_p off_ppr[T][p]` over the
  identical weeks-< W window with the identical prior blend. Shares sum to 1.

`DvpFeatures` mirrors `EpaFeatures` exactly in structure (`__init__(doc)`,
`_season_sums(season, team, side, before_week=None)`, `rate`, `z`, `edge`,
`diff`, `has_season`) so a reader who understands one understands the other.

**The leak assertion, mechanically:** `_season_sums` takes `before_week` and
does `if before_week is not None and int(wk) >= before_week: continue` —
byte-identical to `EpaFeatures._season_sums:300`. The selftest pins it the same
way `EpaFeatures` is pinned at `promote_signals.py:954`: compute
`rate(Y, D, p, W)` and `rate(Y, D, p, W+1)` on a fixture where week `W` is an
outlier, and assert they differ in the direction that proves week `W` was
excluded from the first.

### 4.3 `scripts/build_dvp.py` → `data/dvp.json`, the app-facing rollup (owner: A3)

```json
{
  "generated_utc": "...",
  "season": 2026,
  "through_week": 6,
  "source": "data/dvp_history.json (weeks < the upcoming slate week ONLY)",
  "policy": "start/sit context - walk-forward by construction; never includes the week it describes",
  "min_games": 4,
  "teams": {
    "LAR": {
      "WR": {"ppr_per_game": 41.7, "rank": 30, "n_games": 6, "sample": "ok"},
      "RB": {"ppr_per_game": 18.2, "rank": 6,  "n_games": 6, "sample": "ok"}
    }
  }
}
```

- `rank` 1 = **toughest** (fewest PPR allowed), 32 = softest. Stated in the file.
- `n_games < min_games` ⇒ `"sample": "insufficient"` and **`rank` is `null`**.
  Never a rank off two games.
- `through_week` must be `slate_week - 1`. Enforced by
  `check_dvp_leak_free` (§10), which also re-derives one spot-checked cell from
  `dvp_history.json` and fails if it disagrees by more than 0.05.

### 4.4 App surface (owner: A7, after Rel17 merges)

`player_weekly.json` week rows already carry `opp`, so no new join key is needed
on the client.

- `app/data.js`: add `dvp: '/data/dvp.json'` to `PATHS` and
  `export const getDvp = (opts) => loadJson(PATHS.dvp, opts);` — the same
  404-graceful promise-cache pattern as `getPlayerWeekly`. On an older deploy the
  fetch rejects, callers catch, and the views render exactly as Rel17 left them.
- `app/views/lineup.js`: each starter row gains a matchup chip —
  `vs LAR · 30th vs WR · through wk 6`. Colour bands from existing `app/theme.css`
  tokens (contrast already gated by `contrast_aa.test.mjs`; **no new colour may
  be introduced without re-running that test**).
- `app/views/compare.js`: a DvP row in the existing metric column so "start A or
  B this week" is answerable from the matchup, not only the projection.
- `"sample": "insufficient"` renders the literal text `insufficient sample`, not
  a rank, not a colour band.

### 4.5 Family `dvp_mismatch` — and why it is not `epa_total` again

A naive "this defence allows more points" family is collinear with `epa_total`'s
defensive half and adds nothing. The non-redundant thing DvP knows is
**positional asymmetry**: a defence elite vs WR and leaky vs RB has the same
aggregate EPA as a balanced one.

```
edge(T, D) = Σ_p  share[T][p] * z_allowed[D][p]
delta(g)   = scale * ( edge(home, away_def) - edge(away, home_def) )
```

`DVP_SCALES = [0.0, 100.0, 200.0, 300.0]` (`0` retained so the grid can express
"no effect", matching `VENUE_SCALES`; the zero trial is **not** skipped here
because unlike `environment` there is no second axis making it the incumbent).

**Recorded expectation:** partly collinear with `epa_total` and `skill_out`. If
`epa_total` adopts first, `dvp_mismatch` must beat an incumbent containing it. It
may never clear 0.0015. That is the gate working. Its **primary** value is the
app surface (§4.4), which ships regardless of adoption.

---

## 5. Item 3 — FTN charting scheme proxy

### 5.1 Fetcher (owner: A4, sole writer of `scripts/scrape/nflverse.py`)

```python
def fetch_ftn_charting_release(season, min_rows=20000):
    """FTN charting (ftn_charting_{season}.csv). 2022-present, charted within 48h
    of each game -> unlike participation data this IS usable in-season.

    DATA SOURCE: FTN Data via nflverse. Licensed CC-BY-SA 4.0; the attribution is
    carried in every artifact this feed produces and rendered wherever it
    surfaces in the app (see docs/roadmap/rel18/TECH_DESIGN.md §5.4)."""
    url = f"{_RELEASE_BASE}/ftn_charting/ftn_charting_{int(season)}.csv"
    return fetch_release_csv(url, f"ftn_charting_{season}", min_rows=min_rows)
```

One function, reusing `fetch_release_csv`. No other change to that file.

### 5.2 `scripts/build_scheme_history.py` → `data/scheme_history.json` (owner: A4)

**The join (D4).** FTN charting rows carry no team. The builder must:

1. Stream `iter_pbp_release(season)` once, building
   `{(nflverse_game_id, play_id): (posteam, defteam, week)}` (~50k entries/season,
   plain tuples — acceptable memory, and the row is discarded immediately).
2. Fetch `fetch_ftn_charting_release(season)`.
3. Join on `(nflverse_game_id, nflverse_play_id)`. **Unjoined FTN rows are
   counted and reported**; if the unjoined fraction exceeds 2% the builder raises
   `FeedError` — a join that quietly half-works is worse than no feed.

**Required columns**, asserted against the header before parsing (§1.3 rule 6):
`nflverse_game_id, nflverse_play_id, season, week, is_play_action,
is_screen_pass, is_motion, is_no_huddle, n_defense_box, n_offense_backfield,
qb_location`. *A rename upstream (e.g. `is_screen_p`) must fail loud, not zero.*

```json
{
  "generated_utc": "...",
  "source": "nflverse FTN charting release joined to pbp on (game_id, play_id)",
  "attribution": "FTN Data via nflverse",
  "license": "CC-BY-SA 4.0",
  "coverage": "2022-present; seasons before 2022 are ABSENT, not zero",
  "seasons": {
    "2025": {"KC": {"7": {
      "off_plays": 62, "pa": 14, "screen": 7, "motion": 39, "no_huddle": 5,
      "def_plays": 58, "box_sum": 371.0, "box_plays": 58
    }}}
  }
}
```

Sums, not rates (§1.3 rule 3). `box_sum / box_plays` recomposes the mean box
count over any window exactly.

`--selftest` on `data/fixtures/nflverse_sample/ftn_sample.csv` +
`pbp_scheme.csv`: asserts the join attributes each charted play to the right
`posteam`/`defteam`, asserts an unjoinable row is counted (not silently
dropped), asserts a missing required column raises, and asserts the rate
arithmetic. Never writes.

### 5.3 Family `scheme_matchup`

```
off_agg[T] = z(pa/off_plays) + z(screen/off_plays) + z(motion/off_plays) + z(no_huddle/off_plays)
def_box[D] = z(box_sum/box_plays)
edge(T, D) = off_agg[T] * def_box[D]          # misdirection vs a heavy, downhill box
delta(g)   = scale * ( edge(home, away_def) - edge(away, home_def) )
```

Rolling window follows `EpaFeatures`: weeks < W of the current season blended
with the full prior season at `w = plays / (plays + SCHEME_N0)`, `SCHEME_N0 = 400`.
z-scores computed within season across the teams with data.

`SCHEME_SCALES = [0.0, 40.0, 80.0, 120.0]` — the product of two z-scores is
O(1) and rarely exceeds ±3, so this grid spans roughly ±0–360 Elo at the extreme,
comparable to `epa_total`'s reach.

### 5.4 The runway constraint — stated plainly

FTN begins in **2022**. The gate walks 2022–2025 with **2021 as the prior**.
Therefore:

- 2021 has **no FTN data at all** ⇒ the prior-season half of the 2022 blend is
  empty, so the family is near-silent through most of 2022.
- Usable eval seasons ≈ **2023–2025**, roughly **800 games** against the ~1,084
  every other family gets.
- **The margin does not scale down with the sample.** `scheme_matchup` must clear
  the same 0.0015 on ~26% less data. It is **structurally disadvantaged**, and
  that is accepted, not corrected for.

**Missing-season behaviour: skip loudly, never impute.** A season with no FTN
rows contributes `delta = 0.0` for every game in it and the promotion record
carries:

```json
"coverage": {"seasons_with_ftn": [2023, 2024, 2025],
             "seasons_skipped": [2022], "games_priced": 812}
```

A zero delta on a skipped season is **not** a claim that scheme does not matter
there; it is a claim that we do not know.

**Expectation set now:** `scheme_matchup` may legitimately never be adopted. If
it never clears 0.0015 that is the never-regress gate **working**, not the
feature failing. Success for Item 3 = *"the family runs, is honest about
coverage, and the trials are archived"* — not *"the family adopts"*.

**Attribution (CC-BY-SA 4.0).** Rendered **from the artifact**, never hardcoded,
so removing the feed removes the credit and it cannot go stale:

1. `scheme_history.json.attribution` / `.license` — the source of truth.
2. MODEL tab provenance footer reads that field:
   `Scheme data: FTN Data via nflverse (CC-BY-SA 4.0)`.
3. Any Lineup/Compare chip derived from scheme data carries the credit in its
   detail popover.
4. `docs/SIGNAL_REGISTRY.md` records it against the `scheme_fit` slot.

`tests/feature/rel18_contracts.test.mjs` asserts (1) is present and non-empty and
that the app string in (2) is derived from it, not a literal.

---

## 6. Item 4 — participation personnel prior (DESIGNED, DEFERRED)

**Not built in the Rel18 build wave.** Specified so it can start the day the
evidence bar is met.

- `scripts/build_personnel_prior.py` → `data/personnel_prior.json`, carrying
  `"cadence": "offseason-only"`, `"source_season": 2025`, `"is_prior": true`,
  `"never_in_season": true`, plus the FTN attribution block.
- Source: nflverse participation (`offense_personnel` / `defense_personnel`,
  11/12/21 groupings), available 2023–2025 via FTN Data.
- **CRITICAL CADENCE:** participation **does not update during the season** — it
  is published after the postseason completes. 2026 personnel data will not exist
  until after the 2026 postseason. The module docstring opens with that warning;
  any UI showing it is prefixed `2025 PRIOR ·`.
- **Not** in `daily.yml` or `backtest.yml`. `workflow_dispatch` plus a single
  March cron. Running it in-season could only re-publish last season's numbers
  under a fresh timestamp — a lie about freshness.

**Evidence bar to start building it.** From the archived `scheme_matchup` trials,
either

- (a) it **clears MARGIN** outright, **or**
- (b) its best-scale improvement over the incumbent is **positive in ≥2
  consecutive weekly gate runs** (consistently on the right side of zero, just
  not past 0.0015).

If the best scale is `0.0` or the improvement is negative across the season,
**Item 4 is not built** — personnel groupings refine a scheme signal that showed
no signal. Re-evaluated once, at the end of the 2026 season.

---

## 7. Item 5 — coordinators: curated, display-only

`scripts/scrape/coordinators.py` (owner: A5) — a **static curated table** in the
declared spirit of `scripts/scrape/stadiums.py`: no I/O, no network, gate-safe to
import, with a `SOURCES (checked <date>)` docstring citing Wikipedia's *List of
current NFL offensive coordinators* and *…defensive coordinators*. It lives under
`scrape/` and scrapes nothing — same as `stadiums.py`.

```python
CHECKED_UTC = "2026-08-13"          # the freshness contract, in the data itself
STALE_WARN_DAYS = 180
STALE_HIDE_DAYS = 365

COORDINATORS = {
    "KC": {"hc": "Andy Reid", "oc": "Matt Nagy", "dc": "Steve Spagnuolo",
           "oc_first_year": False, "dc_first_year": False},
    # ... all 32, validated against renames.CANONICAL_TEAMS at import
}
```

`--selftest`: all 32 canonical teams present exactly once, no empty strings,
`CHECKED_UTC` parses as a date, `STALE_WARN_DAYS < STALE_HIDE_DAYS`.

**Why it is not a model signal.** There is no historical OC/DC-by-season release
anywhere: nflverse `nfldata` DATASETS.md lists draft picks, draft values, games,
team colors, logos, rosters, standings, teams, trades — **no coordinators**; and
`spatto12/NFLCoaches` is head coaches only, 1966–2023, PFR-derived. A
current-season cross-section gives the gate **one** observation per team and
**zero** prior seasons to walk forward over. Any weight fitted on it would be
fitting the 2026 season to itself. **Display and context only** — the
`coordinator_change` registry slot stays an empty slot.

**Refresh story, honestly.** Coaching changes cluster in **January** (Black
Monday through the Super Bowl) with a tail into February.

- **Who:** a human, once per offseason, plus ad-hoc after an in-season firing.
  This is a **manual handoff** and ships in the backlog as one, with
  copy-paste-ready steps: open the two Wikipedia lists → diff against
  `COORDINATORS` → edit the dict → bump `CHECKED_UTC` → run the gate.
- **Staleness in the app** (`app/views/team.js`, owner A7): `now - CHECKED_UTC`
  over **180 days** ⇒ render under a `COACHING STAFF · AS OF <date>` header with a
  muted `may be out of date` note; over **365 days** ⇒ **suppress the block
  entirely** and render `coaching staff data not refreshed for this season`. A
  stale coordinator shown confidently is worse than no coordinator — the same
  discipline `weather_forecast` uses when its horizon lapses.
- `rel18_contracts.test.mjs` pins both thresholds and asserts `CHECKED_UTC`
  parses.

---

## 8. `scripts/promote_signals.py` — consolidated change spec (owner: A6, SOLE WRITER)

### 8.1 New module-level constants

```python
CONTEXT_PATH = os.path.join(DATA, "game_context.json")
COACH_PATH   = os.path.join(DATA, "coach_history.json")
QBSTART_PATH = os.path.join(DATA, "qb_starters.json")
DVP_PATH     = os.path.join(DATA, "dvp_history.json")
DVP_CUR_PATH = os.path.join(DATA, "dvp.json")
SCHEME_PATH  = os.path.join(DATA, "scheme_history.json")

DIV_SCALES      = [-30.0, -20.0, -10.0, 10.0, 20.0, 30.0]   # signed: direction unknown
DIV_REMATCH_EXTRA = [-20.0, -10.0, 0.0, 10.0, 20.0]         # 2-D with DIV_SCALES (D1)
COACH_SCALES    = [0.0, 100.0, 200.0, 300.0]
REGIME_SCALES   = [-40.0, -25.0, -10.0, 10.0, 25.0, 40.0]   # signed
REF_SCALES      = [0.0, 100.0, 200.0, 300.0]                # NOT APPLIABLE
DVP_SCALES      = [0.0, 100.0, 200.0, 300.0]
DVP_N0          = 4                                          # games at which current outweighs prior
SCHEME_SCALES   = [0.0, 40.0, 80.0, 120.0]
SCHEME_N0       = 400                                        # plays
MIN_DEFENSES_FOR_Z = 24
QB_SOURCES = ("dropback_inferred", "last_started")
```

**Trial counts:** `divisional` 30 (6 × 5), `coach_quality` 3 (non-zero),
`coach_regime` 6, `referee` 3, `dvp_mismatch` 3, `scheme_matchup` 3. Total new
trials 48 on top of the existing ~40 — a gate run roughly doubles in wall-clock.
`backtest.yml` has no timeout override today; A7 adds `timeout-minutes: 60` to
the promotion step so a doubled runtime cannot silently hit the 6-hour default
after a future family is added.

### 8.2 Shared-machinery change: the residual row (D5)

```python
def walk_season(games, priors, hfa, k, delta_fn=None, collect_residuals=False,
                calibration=None, probs=None, season=None):        # + season
    ...
            if collect_residuals:
                p_flat = elo_mod.expected_home(rh, ra, hfa)
                ctx = (f"{season}|{g.get('week')}|{h}|{a}" if season else None)
                residuals.append((h, actual - p_flat, is_cold_game(g), ctx))   # 4-tuple

def features_from_residuals(residual_rows, venue_scale, cold_scale):
    for team, r, cold, _ctx in residual_rows:                       # + unpack
```

Call sites to update: `evaluate()` (two calls, pass `season=yr`) and
`_write_adoption()` (one call, pass `season=yr`). No module outside
`promote_signals.py` imports either function (verified by grep — only
`build_predictions.py` imports, and only `is_cold_game`, `rest_diffs`,
`epa_blend_deltas`, `*_current`, `load_epa_features`).

**Pure-refactor proof, required in `selftest()`:** with the same synthetic
residual rows, `features_from_residuals` must return **byte-identical** venue and
cold deltas before and after the shape change, and the tuple length must be
asserted `== 4`. This is the assertion that keeps a shared-structure change from
silently moving an adopted family's numbers.

### 8.3 New input loaders (all return `None` when data is absent — skip loudly)

| Function | Returns | `None` when |
|---|---|---|
| `game_context_map()` | `{ctx_key: {div_game, meeting_no, referee, home_coach, away_coach}}` | `game_context.json` absent, or missing any season in `SEASONS` |
| `coach_history_map()` | `{f"{team}\|{season}": coach}` + `{coach: {first_season_by_team}}` | `coach_history.json` absent |
| `qb_starters_map()` | `{(season, week, team): pid}` | `qb_starters.json` absent |
| `qb_out_inputs(source=None)` | `(primaries, outs)` — **existing function, gains the `source` argument**; `source=None` reads `game_params.qb_out.source`, defaulting to `"dropback_inferred"` | as today, plus `last_started` requested but `qb_starters.json` absent (falls back to inferred **and prints the fallback**) |
| `load_dvp_features()` | `DvpFeatures` | `dvp_history.json` absent or missing a `SEASONS` member |
| `load_scheme_features()` | `SchemeFeatures` + `coverage` dict | `scheme_history.json` absent (**not** when 2021/2022 are missing — that is expected coverage, recorded, not a skip) |

### 8.4 New family builders

All follow the `(setup, factory)` contract exactly.

```python
def divisional_builder(scale, rematch_extra, ctx):
    def setup(season, games, training_residuals): return season
    def factory(season):
        def fn(g, i):
            rec = ctx.get(f"{season}|{g.get('week')}|{g['home']}|{g['away']}")
            if not rec or not rec.get("div_game"):
                return 0.0
            return scale + (rematch_extra if rec.get("meeting_no") == 2 else 0.0)
        return fn
    return setup, factory


def coach_quality_builder(scale, ctx):
    """Residual-fitted per-coach effect, DIFFERENCED (structurally environment's
    venue term, but signed by which side the coach was on).

      q[coach] = scale * shrink(n) * mean(signed residual over TRAINING games)
                 (+r when the coach was HOME, -r when AWAY)
      delta(g) = q[home_coach] - q[away_coach]

    Training residuals only (seasons < eval season) - the same leak discipline
    features_from_residuals already enforces. shrink reuses SHRINK_N = 16."""
    def setup(season, games, training_residuals):
        per_coach = {}
        for team, r, _cold, key in training_residuals:
            rec = ctx.get(key)
            if not rec or key is None:
                continue
            home = key.split("|")[2]
            per_coach.setdefault(rec["home_coach"], []).append(+r if team == home else -r)
            per_coach.setdefault(rec["away_coach"], []).append(-r if team == home else +r)
        return {c: scale * (sum(rs) / len(rs)) * (len(rs) / (len(rs) + SHRINK_N))
                for c, rs in per_coach.items()}
    def factory(q):
        def fn(g, i): ...   # q.get(home_coach, 0.0) - q.get(away_coach, 0.0)
        return fn
    return setup, factory


def coach_regime_builder(scale, ctx, first_season_by_team):
    """delta = scale * (away_first_year - home_first_year); first_year == 1 when
    this is the coach's FIRST season with THIS team. The game-side expression of
    the head_coach_change registry slot."""


def referee_builder(scale, ctx):
    """Same residual fit as coach_quality, grouped by crew chief.
    ##### NOT APPLIABLE ##### - see section 8.6."""


def dvp_builder(scale, feats):
    def setup(season, games, training_residuals): return season
    def factory(season):
        return lambda g, i: scale * feats.diff(g, season)
    return setup, factory


def scheme_builder(scale, feats):
    ...  # identical shape to dvp_builder
```

### 8.5 Trials blocks in `run()`

Each follows the existing skip-loudly idiom verbatim:

```python
ctx = game_context_map()
if ctx is None:
    print("  divisional   SKIPPED: data/game_context.json absent (runner-built)")
    families.append({"family": "divisional", "skipped": True,
                     "reason": "game_context.json absent - built by the weekly "
                               "backtest workflow"})
else:
    fam_trials = [try_candidate("divisional", f"base={b:+.0f} rematch={e:+.0f}",
                                {"scale": b, "rematch_extra": e},
                                divisional_builder(b, e, ctx))
                  for b in DIV_SCALES for e in DIV_REMATCH_EXTRA]
    families.append({"family": "divisional", "trials": fam_trials})
```

`scheme_matchup` additionally attaches its `coverage` block (§5.4) to the family
record whether or not it is skipped.

### 8.6 `APPLIABLE` and the `referee` demonstration

```python
APPLIABLE = {"environment", "rest", "epa_total", "epa_pass", "elo_epa",
             "qb_out", "weather_wind", "skill_out",
             "divisional", "coach_quality", "coach_regime",
             "dvp_mismatch", "scheme_matchup"}
# referee is DELIBERATELY ABSENT.
```

`games.csv` carries `referee` for games **already played**. There is no verified
pregame crew-assignment feed in this platform, so at prediction time we do not
know the referee: walk-forward inputs exist, a prediction-time path does not.

If `referee` clears the margin, `run()` records `would_adopt`, prints the
existing `PENDING: referee cleared the margin but has no application path yet`
line, and **`game_params` is not written**. That is correct: the run has
*measured* that crew-level home bias exists at a magnitude worth chasing —
exactly the evidence a future release needs to justify sourcing a pregame
assignment feed. A gate that adopted it anyway would claim an effect the pipeline
cannot deliver.

**Deliberately not built:** a referee **totals/penalty** family. This gate's
objective is game-outcome log-loss; we do not model totals. Such a family would
have neither an objective nor an application path — a `would_adopt` on a metric
we never score.

### 8.7 `_write_adoption` branches

| Family | `game_params` block |
|---|---|
| `divisional` | `{"applied": true, "scale": b, "rematch_extra": e, "adopted_utc": now}` |
| `coach_quality` | `{"applied": true, "scale": s, "shrink_n": 16, "adopted_utc": now, "deltas": {coach: round(q,2)}}` — production fit uses **ALL** resolved seasons (matching the `venue_hfa` precedent) |
| `coach_regime` | `{"applied": true, "scale": s, "adopted_utc": now}` |
| `dvp_mismatch` | `{"applied": true, "scale": s, "n0_games": DVP_N0, "adopted_utc": now}` |
| `scheme_matchup` | `{"applied": true, "scale": s, "n0_plays": SCHEME_N0, "attribution": "FTN Data via nflverse", "license": "CC-BY-SA 4.0", "adopted_utc": now}` |
| `referee` | **no branch** — unreachable; a defensive `raise AssertionError` documents why |

### 8.8 `_incumbent_family_fns` branches (checklist point 7 — the one that silently breaks never-regress)

One branch per new appliable family, each guarding on its data being loadable and
appending the rebuilt builder. `qb_out`'s existing branch changes to
`qb_out_inputs(qo.get("source"))`.

### 8.9 Prediction-time readers

`divisional_current(season)`, `coach_context_current(season)`,
`dvp_current(season)`, `scheme_current(season)` — each returning the inputs the
`build_predictions.py` block needs, or `None`. `qb_out_current(season)` gains the
`last_started` branch (§3.5).

`divisional_current` and `coach_context_current` both read `game_context.json`,
whose 2026 rows already carry coaches and `div_game` for all 272 games — so these
are **live from day one**, unlike `dvp_current` which is empty until week 2.

### 8.10 `--qb-source-ab` mode

`main()` gains the flag. It runs `evaluate(incumbent_builders, …)` twice with the
two `qb_out_inputs` sources, prints the block in §3.3, appends a
`{"kind": "qb_source_ab", "format": 1, …}` entry to `model_tuning.history`, and —
only with `--auto-adopt` **and** `delta > MARGIN` — rewrites
`game_params.qb_out` with the new source and its re-fitted scale.

### 8.11 `selftest()` additions

1. Residual-tuple pure-refactor proof (§8.2).
2. `divisional`: a div rematch gets `scale + rematch_extra`; a non-div game gets
   exactly `0.0`; a missing context key gets `0.0`, never a crash.
3. `coach_quality`: two synthetic coaches with symmetric residuals produce
   `q_home - q_away` of the expected sign and exact shrunk magnitude.
4. `DvpFeatures` leak proof (§4.2) — week `W` excluded from `rate(…, W)`.
5. `qb_out` `last_started` week-9 change case (§3.2).
6. `SchemeFeatures` with a season absent from the doc returns `0.0` deltas and
   reports that season in `coverage.seasons_skipped`.

### 8.12 Multiplicity — the brake

Rel18 takes the gate from 8 candidate families to **14**. More families = more
chances one clears 0.0015 by luck.

**The margin is not moved.** It stays 0.0015 — never lowered to force an
adoption, and not raised ad hoc either (same sin, other direction). Four brakes:

1. **One family adopted per run** — a lucky family must be the best of 14, not
   merely better than the incumbent.
2. **The incumbent absorbs adoptions** — a family adopted on noise must keep
   earning against every later candidate; the loop self-corrects over weeks.
3. **Walk-forward, not in-sample** — luck must survive four held-out seasons.
4. **New:** the promotion entry gains
   `"families_tested": 14, "families_runnable": N, "trials": M` so the
   multiple-comparisons exposure of any adoption is visible in the archive. Rel18
   **records** it and does not act on it.

---

## 9. `scripts/build_predictions.py` — application blocks (owner: A7, after Rel17)

Five new blocks, each an exact copy of the established pattern: read
`_adopted.get(...)`, guard on `applied`, load prediction-time inputs, print a
`promoted … in effect` line **or** a `WARNING: … not applied` line, then
contribute to `hfa_eff` inside the existing per-game loop.

```python
# divisional (adopted family): divisional games and in-season rematches.
_div = _adopted.get("divisional") or {}
_div_ctx, _div_scale, _div_rematch = {}, 0.0, 0.0
if _div.get("applied"):
    from scripts.promote_signals import divisional_current      # noqa: PLC0415
    _dc = divisional_current(SEASON)
    if _dc is None:
        print("WARNING: divisional adopted but game_context.json unavailable - not applied")
    else:
        _div_ctx = _dc
        _div_scale = float(_div["scale"])
        _div_rematch = float(_div.get("rematch_extra", 0.0))
        print(f"promoted divisional in effect: base={_div_scale:+g} "
              f"rematch={_div_rematch:+g} ({len(_div_ctx)} games with context)")
```

…and inside the loop:

```python
if _div_scale or _div_rematch:
    _rec = _div_ctx.get(f"{SEASON}|{g.get('week')}|{g['home']}|{g['away']}")
    if _rec and _rec.get("div_game"):
        hfa_eff += _div_scale + (_div_rematch if _rec.get("meeting_no") == 2 else 0.0)
```

Identical treatment for `coach_quality` (`_coach_deltas.get(home_coach) -
…get(away_coach)`), `coach_regime`, `dvp_mismatch` (`_dvp_feats.diff(g, SEASON)`)
and `scheme_matchup` (`_scheme_feats.diff(g, SEASON)`).

**Day-zero output guarantee.** With no new family adopted and every new artifact
absent, `build_predictions.py` produces **byte-identical** output to Rel17: every
addition is behind an `applied` flag **and** a file-existence guard.
`rel18_contracts.test.mjs` asserts this directly by checking that every Rel18
`game_params` block is either absent or carries `applied`.

---

## 10. `scripts/validate_data.py` — change spec (owner: A7, after Rel17)

1. **`SCHEMA_TO_DATA`** — six new pairs (§11).
2. **`OPTIONAL_DATA`** — add `game_context.json`, `coach_history.json`,
   `qb_starters.json`, `dvp_history.json`, `dvp.json`, `scheme_history.json`.
   All six are runner-built; absence before the bootstrap dispatch is the
   documented state, not a failure.
3. **`check_no_betting_columns(docs)`** — new cross-file invariant. Walks every
   key at every depth of the three nfldata-derived artifacts; any key in the
   betting denylist raises `ValidationError` naming the file and the JSON path.
   The denylist is a **literal** in `validate_data.py`, not imported from
   `scrape/nfldata.py` — same reasoning as `EXPECTED_SIGNALS` and `_norm_name`:
   the validator keeps zero local imports so it runs while `scripts/` is
   mid-edit, and a checker that imported the producer's own constants would be
   grading the pipeline with the pipeline's own marking scheme.
4. **`check_dvp_leak_free(dvp, dvp_history, predictions)`** — new cross-file
   invariant:
   - `dvp["through_week"] == predictions["week"] - 1` (when both exist);
   - every team/pos cell with `sample == "ok"` has `n_games >= min_games`;
   - every cell with `sample == "insufficient"` has `rank is None`;
   - ranks per position are a permutation of `1..n_ranked` (no ties, no gaps);
   - **spot-check:** re-derive one deterministic cell (first team alphabetically,
     position `WR`) straight from `dvp_history` over weeks `1..through_week` and
     assert `|recomputed - ppr_per_game| <= 0.05`. This is the assertion that
     catches "week W's own data leaked into week W's rank".
5. **`main()`** — three new `try/except` blocks in the cross-file section,
   printing `ok    …` on success like the existing three.
6. **`_selftest()`** — new red/green cases for both new invariants:
   a doc containing a `spread_line` key at depth 3 must be caught; a `dvp.json`
   whose `through_week` equals the slate week must be caught; a cell with
   `n_games = 2` and a non-null `rank` must be caught. **`validate_data.py
   --selftest` is already wired into `smoke.sh:45`**, so these run in the gate.

**Explicitly unchanged:** `EXPECTED_SIGNALS` (32 names) and
`check_meta_weights`. Rel18 backs registry **slots with artifacts**; it does not
add a slot and does not move a weight off 0.0. See §12 for why touching them
would red three tests.

---

## 11. Contracts and schema registration

| Artifact | Schema (new file under `data/contracts/`) | `SCHEMA_TO_DATA` | `OPTIONAL_DATA` | Owner |
|---|---|---|---|---|
| `data/game_context.json` | `game_context.schema.json` | yes | yes | A1 |
| `data/coach_history.json` | `coach_history.schema.json` | yes | yes | A1 |
| `data/qb_starters.json` | `qb_starters.schema.json` | yes | yes | A2 |
| `data/dvp_history.json` | `dvp_history.schema.json` | yes | yes | A3 |
| `data/dvp.json` | `dvp.schema.json` | yes | yes | A3 |
| `data/scheme_history.json` | `scheme_history.schema.json` | yes | yes | A4 |
| `scripts/scrape/coordinators.py` | **none** — a Python module, not a data file | no | n/a | A5 |

Each schema: `$schema` draft-07, `$id` = filename, `title`, a `description` that
states the honesty policy (measurement/prior/coverage), `type: object`,
`additionalProperties: false` at the top level, `required` listing
`generated_utc`, `source` and the payload key. **Per §1.2, no schema may rely on
`minProperties`, `pattern` or `exclusiveMinimum` for enforcement** — anything
load-bearing lives in a `check_*` function or a node test.

A schema file with no `SCHEMA_TO_DATA` entry is validated by nothing. The
registration line and the schema file must land in the **same commit**.

---

## 12. Test impact matrix

### 12.1 Existing tests that MUST change

| File | Line(s) | Change | Break symptom if missed |
|---|---|---|---|
| `tests/feature/rel7_contracts.test.mjs` | `:26` | `FAMILIES` array grows from 8 to **14**: `+divisional, coach_quality, coach_regime, referee, dvp_mismatch, scheme_matchup` | `assert.deepEqual(names.sort(), FAMILIES.sort())` fails on the first gate run after the new families ship |
| `tests/feature/rel7_contracts.test.mjs` | `:75-83` | the `block` lookup object gains `divisional: gp.divisional`, `coach_quality: gp.coach_hfa`, `coach_regime: gp.coach_regime`, `dvp_mismatch: gp.dvp_hfa`, `scheme_matchup: gp.scheme_hfa` | On the day one of them adopts, `block && block.applied` is `undefined` → red gate on an otherwise correct adoption |
| `tests/feature/rel7_contracts.test.mjs` | `:39-42` | add `assert.equal(divisional.trials.length, 30)` alongside the existing environment-15 / rest-4 pins | (additive; no break, but the grid must be pinned like its siblings) |
| **`tests/web/web.spec.mjs`** | **`:838-853`** | **`expect(rows).toBe(8)` → `14`, `expect(chips).toBe(8)` → `14`, and the family-name loop gains the six new names** | **Playwright red.** This hardcoded count is the single most easily missed change in the release and is not named in `ARCHITECTURE.md` |
| `tests/smoke.sh` | `:35-48` | six new `--selftest` lines (§13) | New builders ship untested by the gate |
| `tests/smoke.sh` | `:50-55` | none — the recursive `data/*.json` parse loop picks up new files automatically | — |
| `scripts/validate_data.py` `_selftest` | `:520` | new red/green cases (§10.6) | The new invariants are unproven — "a check nobody has watched fail is a check that might do nothing" |
| `scripts/promote_signals.py` `selftest` | `:917` | six new assertions (§8.11) | The residual-shape refactor ships unproven |
| `.github/workflows/backtest.yml` | after `:65` | five new builder steps + `timeout-minutes: 60` on the promotion step | Gate runs on stale/absent artifacts; families skip forever and nobody notices |
| `.github/workflows/daily.yml` | after the injury-history step | `build_qb_starters.py` + `build_dvp.py` | `last_started` prices next week's slate off last week's stale starts; DvP chips freeze |

### 12.2 Existing tests at risk that MUST NOT change (and why)

| File | Why it is at risk | The rule |
|---|---|---|
| `tests/feature/signal_registry.test.mjs` | Hardcodes the 32-name `EXPECTED` list and `assert.equal(EXPECTED.length, 32)` | Rel18 **backs slots with artifacts**; it does not add a slot or change a weight. If any agent edits `scripts/signals/registry.py` or `data/meta.json`, this test, `validate_data.EXPECTED_SIGNALS` and `smoke.sh:78-83` all go red together. **`data/meta.json` and `scripts/signals/registry.py` are untouched by Rel18.** |
| `tests/feature/never_regress.test.mjs` | Pins `margin 0.0015` semantics and that `model_tuning.adopted === false` | The **top-level** `model_tuning` keys (`current_loss`, `candidate_loss`, `margin`, `adopted`) belong to the *parameter* backtest, not the family gate. `promote_signals` only inserts into `history`. No Rel18 change may touch those top-level keys, and `smoke.sh:97-99` re-asserts the same thing |
| `tests/feature/model_view.test.mjs` | `MARKET_SIGNALS` must mirror `validate_data.MARKET_DISPLAY_ONLY` exactly | Rel18 adds `check_no_betting_columns` but **does not touch `MARKET_DISPLAY_ONLY`**. The two lists stay in sync by not being edited |
| `tests/feature/contrast_aa.test.mjs` | Any new colour token in `app/theme.css` for DvP bands | A7 reuses existing tokens. If a new band colour is genuinely needed, this test must be re-run and the token proven AA |
| `tests/feature/learning_loop.test.mjs` | Drives `scripts/refit.py` / `resolve_locks.py` through `python3 -` | Untouched by Rel18. `MARGIN` is imported *from* `refit.py` and must not be redefined in `promote_signals.py` |
| `tests/feature/real_data.test.mjs` | Asserts committed-data shapes | New artifacts are `OPTIONAL_DATA` and are not read here; no change expected |

### 12.3 New tests

| File | Owner | Asserts |
|---|---|---|
| `tests/feature/nfldata_guard.test.mjs` | A1 | the three-part betting guard (§2.2 layer 2) |
| `tests/feature/qb_ground_truth.test.mjs` | A2 | source/scale/A-B consistency + published agreement rates (§3.4) |
| `tests/feature/rel18_families.test.mjs` | A6 | for each of the six new families in the newest v2 entry: trialed-or-skipped-with-reason; `divisional` has 30 trials; `scheme_matchup` carries a `coverage` block naming skipped seasons; `referee` is **never** the `adopted_family` (it may only ever appear as `would_adopt`); `families_tested === 14` |
| `tests/feature/rel18_contracts.test.mjs` | A7 | `scheme_history.attribution` non-empty and the app string derives from it; coordinator staleness thresholds (180/365) and `CHECKED_UTC` parses; `dvp.json` ranks/sample consistency; **day-zero identity** — every Rel18 `game_params` block is absent or carries `applied` |

---

## 13. `tests/smoke.sh` and workflow wiring

**`tests/smoke.sh` is a shared file. A1–A6 must NOT edit it.** Each writes the
`--selftest` inside its own module; **A7 adds all six lines in one edit**, after
`:48`:

```bash
python3 scripts/scrape/nfldata.py --selftest      || fail "nfldata guard selftest"
python3 scripts/build_game_context.py --selftest  || fail "game context selftest"
python3 scripts/build_coach_history.py --selftest || fail "coach history selftest"
python3 scripts/build_qb_starters.py --selftest   || fail "qb starters selftest"
python3 scripts/build_dvp_history.py --selftest   || fail "dvp history selftest"
python3 scripts/build_scheme_history.py --selftest || fail "scheme history selftest"
python3 scripts/scrape/coordinators.py --selftest || fail "coordinators table selftest"
```

Cadence:

| Builder | Workflow | Cadence | Why |
|---|---|---|---|
| `build_game_context.py` | `backtest.yml` | weekly | Coaches/div/referee change on a season timescale; 2026 rows already complete |
| `build_coach_history.py` | `backtest.yml` | weekly | Derived from the same fetch |
| `build_qb_starters.py` | `backtest.yml` **and** `daily.yml` | weekly + daily | `last_started` needs last week's starts before the next slate is priced |
| `build_dvp_history.py` | `backtest.yml` | weekly | Streams pbp; past seasons immutable and cached, like `epa_history` |
| `build_dvp.py` | `daily.yml` | daily | Feeds the start/sit surface; must be current through last week |
| `build_scheme_history.py` | `backtest.yml` | weekly | FTN charts within 48h; weekly is sufficient and cheap |
| `build_personnel_prior.py` | `workflow_dispatch` + one March cron | **offseason only** | §6 — never in-season |
| `coordinators.py` | none (static) | hand-curated | §7 |

Each builder also emits a `pipeline_status` feed row with real `rows`/`status`
via the existing `evaluate_feed` path, so a broken enrichment feed drags
`health` honestly (`check_pipeline_health` already enforces that).

---

## 14. Build partition — disjoint file ownership

**No two agents write the same file.** Serialization points are explicit.

| Agent | Writes (exclusively) | Reads | Blocked on |
|---|---|---|---|
| **A1 — nfldata gateway** | `scripts/scrape/nfldata.py`, `scripts/build_game_context.py`, `scripts/build_coach_history.py`, `data/contracts/game_context.schema.json`, `data/contracts/coach_history.schema.json`, `tests/feature/nfldata_guard.test.mjs` | `build_market_baseline.py` (pattern only) | — |
| **A2 — QB ground truth** | `scripts/build_qb_starters.py`, `data/contracts/qb_starters.schema.json`, `tests/feature/qb_ground_truth.test.mjs` | A1's `nfldata.iter_games_rows` | **A1** (module signature agreed up front, before A1 finishes) |
| **A3 — DvP** | `scripts/build_dvp_history.py`, `scripts/build_dvp.py`, `data/contracts/dvp_history.schema.json`, `data/contracts/dvp.schema.json`, `data/fixtures/nflverse_sample/pbp_dvp.csv` | `scrape/nflverse.py` (read-only) | — |
| **A4 — FTN scheme** | `scripts/scrape/nflverse.py` **(sole writer)**, `scripts/build_scheme_history.py`, `data/contracts/scheme_history.schema.json`, `data/fixtures/nflverse_sample/ftn_sample.csv`, `data/fixtures/nflverse_sample/pbp_scheme.csv` | — | — |
| **A5 — coordinators** | `scripts/scrape/coordinators.py` | `scrape/stadiums.py` (pattern), `scrape/renames.py` | — |
| **A6 — gate families** | `scripts/promote_signals.py` **(sole writer)**, `tests/feature/rel18_families.test.mjs`, `tests/feature/rel7_contracts.test.mjs` | every artifact above | **A1–A4** artifacts (or their fixtures) exist |
| **A7 — integration / tech lead** | `scripts/build_predictions.py`, `scripts/validate_data.py`, `tests/smoke.sh`, `tests/web/web.spec.mjs`, `.github/workflows/backtest.yml`, `.github/workflows/daily.yml`, `app/data.js`, `app/views/team.js`, `app/views/lineup.js`, `app/views/compare.js`, `app/theme.css`, `tests/feature/rel18_contracts.test.mjs` | everything | **Rel17 merged**, then A1–A6 |

**Waves** (respects the 4–6 default concurrency):

- **Wave 1 (4 parallel):** A1, A3, A4, A5 — fully independent, no shared files.
- **Wave 2 (1):** A2 — needs A1's module.
- **Wave 3 (1):** A6 — needs every artifact; sole writer of the gate.
- **Wave 4 (1):** A7 — **blocked on Rel17 merging.** Rebases onto merged Rel17,
  then integrates: application blocks, schemas + `OPTIONAL_DATA` + two new
  invariants, all six `smoke.sh` lines, the Playwright family count, the DvP
  chips, the coordinator block, the workflow steps.

**Named collisions, so they are avoided:**

- `tests/smoke.sh` — A1–A4 each *want* a selftest line. **They must not.** A7
  adds all of them in one edit.
- `tests/feature/rel7_contracts.test.mjs` — the `FAMILIES` array is A6's, not
  A7's, because it must change in the same commit as the families themselves.
- `tests/web/web.spec.mjs` — A7 only (it also contains Rel17 UI assertions).
- `scripts/scrape/nflverse.py` — A3 **reads** `iter_pbp_release` /
  `fetch_roster_release`; only **A4 writes** it.
- `scripts/validate_data.py`, `scripts/build_predictions.py`, `app/views/*.js`,
  `app/theme.css` — Rel17-owned; **A7 only, after Rel17 merges**.
- `data/meta.json`, `scripts/signals/registry.py` — **untouched by Rel18.**

---

## 15. Fantasy stories and acceptance criteria

Written in league language, with concrete reproductions. Full backlog lives in
`docs/roadmap/rel18/USER_STORIES.md`; these are the AC the QA agents verify.

**S1 — Stream a defence with confidence.** *As a manager holding two streaming
DSTs in week 7, I want to see which offences my candidates face and how those
offences have actually scored, so I stop streaming into a buzzsaw.*
AC: the Lineup row for each candidate shows `vs <OPP> · <rank> vs <POS>` with
`through wk N · N games`; a defence with `< 4` games shows `insufficient sample`
and **no rank**; the rank never reflects the week being displayed.

**S2 — Start/sit on the matchup, not just the projection.** *Reproduction:
week 7, deciding between a WR2 facing a defence ranked 30th vs WR and a WR2
facing one ranked 3rd vs WR, with projections within 0.4 points.*
AC: Compare shows a DvP row for both; tapping it reveals PPR allowed per game and
the sample size; the numbers are re-derivable from `dvp_history.json` by hand.

**S3 — Backup QB, priced honestly.** *Reproduction: a starter is benched in
week 9. In weeks 10–15 the old rule still names him the primary passer, so a
"QB out" report moves the line the wrong way.*
AC: `qb_starters.json.diagnostics.last_started_agreement_post_change` is
published; if and only if the paired A/B beats the incumbent by `> 0.0015` does
`game_params.qb_out.source` become `"last_started"`, and `source_ab` records both
log-losses.

**S4 — Divisional rematch.** *Reproduction: a week-16 rematch of a week-4
divisional game.* AC: `game_context.json` marks it `div_game: 1, meeting_no: 2`;
the `divisional` family trials the effect; if it does not clear the margin the
MODEL tab shows it `RETAINED` with its best loss — visible, at weight 0.

**S5 — New head coach, honest silence on the pairing.** AC: `coach_history.json`
marks a first-year regime; `coach_regime` is trialed; the MODEL tab and
`docs/SIGNAL_REGISTRY.md` state plainly that coach-**vs**-coach pairings are not
modelled, with the arithmetic: 177 coaches ⇒ ~15,600 unordered pairs against
~1,084 eval games; most pairs have **zero or one** meeting, and even long
rivalries reach single digits. Fitting a per-pairing effect on n ≤ 2 and asking
it to clear a 0.0015 log-loss margin is fitting noise and calling it a coaching
matchup. **Not built.** The honest future form is a hierarchical shrink toward the
coach-level effect — a different design, not a scale grid.

**S6 — Coaching staff context.** AC: the Team tab shows HC/OC/DC from the curated
table; over 180 days stale it renders under `AS OF <date>` with `may be out of
date`; over 365 days the block is replaced by `coaching staff data not refreshed
for this season`.

**S7 — The credit is paid.** AC: wherever a scheme-derived value surfaces, the
string `FTN Data via nflverse (CC-BY-SA 4.0)` is rendered, sourced from
`scheme_history.json.attribution`, not a literal.

**S8 — No market leakage, provably.** AC: `nfldata_guard.test.mjs` is green;
`check_no_betting_columns` passes; the eight betting column names appear nowhere
in any enrichment builder, the gate, or the predictor.

**Registry outcomes** (weights all stay 0.0 — "backed" means the slot gains a
real artifact, not a weight): `head_coach_change` **backed** by
`coach_history.json`; `scheme_fit` **backed** by `scheme_history.json`;
`schedule_strength` **backed** by `dvp.json`; `coordinator_change` **stays
empty** (no history exists to learn from); `qb_coaching` **stays empty** (no
source); `one_on_one_matchup` **stays empty** — DvP is a positional-*group*
proxy and is explicitly **not** claimed as filling it.

---

## 16. Rollback

Stated before any deploy (Gate 4 requirement).

| Change | Rollback |
|---|---|
| `qb_out` source swap | `game_params.qb_out.source = "dropback_inferred"`, re-run pipeline. **Data-only, no code revert** |
| Any new family adoption | Delete its block from `game_params`; `build_predictions` guards on `applied` and reverts to byte-identical output |
| DvP / scheme / coordinator app surfaces | `git revert` the A7 commit; views degrade to Rel17 behaviour because every new read is 404-guarded |
| A whole artifact | Delete the file; it is in `OPTIONAL_DATA`, the gate stays green, and every consumer already skips loudly |
| The residual 4-tuple refactor | `git revert` A6's commit — the only structural change, and the one covered by the byte-identity assertion in `selftest()` |

**Gate, unchanged in shape, only in content:**

```
python3 scripts/validate_data.py                  # +6 schemas, +2 cross-file invariants
bash tests/smoke.sh                               # +7 python selftests (A7 adds them all)
node --test tests/feature/*.mjs tests/competition.test.mjs   # +4 files, 2 edited
npx playwright test --config tests/playwright.config.mjs tests/ux tests/integrated
```

100% green before any deploy. Gate on **exit codes**, never on grepped summaries.
