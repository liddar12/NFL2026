# Rel18 — Coaching, Scheme & Matchup Context: Solution Architecture

**Role:** Solution Architect · **Gate:** 1 (confirm before build)
**Scope:** Items 1–5 (games.csv enrichment, defense-vs-position, FTN scheme
proxy, participation personnel prior, coordinator table)
**Repo:** `/home/user/nfl2026` — vanilla-JS no-build PWA + stdlib-only Python.

> **Rel17 is in flight in this same tree.** Every file Rel17 owns
> (`scripts/availability.py`, `scripts/injury_duration.py`,
> `scripts/build_weekly.py`, `scripts/scrape/espn.py`,
> `scripts/build_injury_history.py`, `scripts/build_predictions.py`,
> `scripts/validate_data.py`, `app/availability.js`, `app/lineup.js`,
> `app/views/lineup.js`, `app/views/compare.js`, `app/theme.css`,
> `data/player_weekly.json`, `data/injuries.json`) is treated here as a
> **downstream dependency, not a workspace**. Rel18 designs *around* those
> files; §9 sequences every Rel18 agent that must eventually touch one of them
> strictly **after** Rel17 merges. Rel18 assumes availability + injury-duration
> already exist and are correct.

---

## 0. What was re-read before designing

| Source | What it settled |
|---|---|
| `scripts/promote_signals.py` (1096 ln) | Family builder contract `(setup, factory)`; `walk_season` residual tuple is `(home, resid, is_cold)`; `evaluate()` sums family deltas onto `hfa`; `APPLIABLE` set at line 781; `_write_adoption` per-family blocks; one family adopted per run; `MARGIN` imported from `refit.py`. |
| `scripts/refit.py:69` | `MARGIN = 0.0015`. **Never lowered.** |
| `data/model_tuning.json` | `game_params` today = `hfa_elo 45.0`, `revert 0.45`, `k 25.0`, **`qb_out {applied:true, scale:75.0}`** — the one and only adopted family. 19 history entries; the latest (2026-08-11) retained the incumbent. |
| `scripts/build_predictions.py:121–260` | The application blocks. Each adopted family reads `_adopted[...]`, guards on data availability, prints a `WARNING: … not applied` line, and contributes to `hfa_eff`. This is the pattern every new family copies. |
| `scripts/build_market_baseline.py` | The **proven** `games.csv` fetch: stdlib `urllib` + `csv.DictReader`, `RENAMES {LA→LAR, OAK→LV, SD→LAC, STL→LAR}`, `<1000` rows ⇒ refuse partial, keep existing file on failure. |
| `scripts/scrape/nflverse.py` | `fetch_release_csv(url, name, min_rows)` and `iter_pbp_release(season)` — the two reuse patterns for Items 2 and 3. `FeedError` on any transport/non-200/short-row condition. |
| `scripts/build_epa_history.py` | The artifact shape rule: **store SUMS, not means**, so any rolling window recomposes exactly. Immutable past seasons, only the current season refetches. `--selftest` on a committed fixture, never writes. |
| `scripts/signals/registry.py` + `scripts/validate_data.py:103` | 32 signals, all pinned at 0.0, mirrored as a literal in the validator. `MARKET_DISPLAY_ONLY` pinned permanently. |
| `data/player_weekly.json` | Week rows are `{wk, opp, home, bye, pts}` — **`opp` already exists**, so DvP needs no new join key on the client. |
| `scripts/scrape/stadiums.py` | The curated-static-table pattern Item 5 copies verbatim in spirit: no I/O, `SOURCES (checked <date>)` docstring, honest limitations stated inline. |
| `tests/smoke.sh:35–48` | Where every Python `--selftest` is wired. A **shared file** — see the partition in §9. |

**One correction to the brief's framing, and it changes the design.**
Item 1(a) says `away_qb_name/home_qb_name` is "the ACTUAL starting QB". It is —
and that is precisely why it **cannot** be the pregame input. Feeding the
realised starter into a pregame model is a leak: it is the answer to the
question `qb_out` is asking. §3 rebuilds the item around that, and the result
is *better* than the naive version, not a retreat from it.

---

## 1. The shape of Rel18

Five items, five kinds of thing:

| Item | New data | New gate family | Registry slot backed | App surface |
|---|---|---|---|---|
| 1 games.csv | `game_context.json`, `coach_history.json`, `qb_starters.json` | `div_game`, `div_rematch`, `coach_quality`, `coach_regime`, `referee` | `head_coach_change` | Slate matchup chips |
| 2 DvP | `dvp_history.json`, `dvp.json` | `dvp_mismatch` | `schedule_strength` | **Lineup + Compare** (primary) |
| 3 FTN | `scheme_history.json` | `scheme_matchup` | `scheme_fit` | Model tab + attribution |
| 4 personnel | `personnel_prior.json` *(deferred)* | — | — | Team tab (labelled PRIOR) |
| 5 coordinators | `coordinators.py` (static) | **none, deliberately** | *none — see §7* | Team tab |

Seven new candidate families join the eight that exist. **Six are appliable;
`referee` deliberately is not** — see §6, which is the sharpest illustration in
this release of why the `APPLIABLE` guard exists.

---

## 2. Item 1 — the nfldata gateway, and the betting-column trap

### 2.1 The trap, stated precisely

`games.csv` carries `away_moneyline`, `home_moneyline`, `spread_line`,
`total_line`, `over_odds`, `under_odds`, `away_spread_odds`,
`home_spread_odds`. The owner's standing rule is that market prices are
**display/measurement only, never a model input**. `build_market_baseline.py`
reads the moneylines legitimately, for measurement, and its output is scored
*against* the model, never *into* it.

Rel18 makes the same file feed the **enrichment** path, which *is* a model
input path. A single careless `r.get("spread_line")` inside a builder that
feeds `promote_signals` would silently convert the platform into a
market-follower and every subsequent adoption would be uninterpretable.

### 2.2 The guard: physical separation, three enforcement layers

**New module `scripts/scrape/nfldata.py`** — the *only* sanctioned enrichment
reader of games.csv.

```python
# scripts/scrape/nfldata.py  (new — stdlib urllib + csv, gate-safe to import)

GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"

# ##### THE BETTING DENYLIST #####
# These columns exist in games.csv and MAY NEVER reach a model input path.
# build_market_baseline.py reads the moneylines through its OWN separate fetch,
# for MEASUREMENT ONLY. This module physically cannot serve them.
BETTING_COLUMNS = frozenset({
    "away_moneyline", "home_moneyline", "spread_line", "total_line",
    "over_odds", "under_odds", "away_spread_odds", "home_spread_odds",
})

# The ALLOW-LIST. Every column the enrichment builders may see, and no other.
ENRICHMENT_COLUMNS = frozenset({
    "game_id", "season", "game_type", "week", "gameday", "weekday", "gametime",
    "away_team", "home_team", "away_score", "home_score",
    "away_coach", "home_coach", "referee", "div_game",
    "away_qb_id", "away_qb_name", "home_qb_id", "home_qb_name",
    "stadium", "stadium_id", "location", "roof", "surface",
    "away_rest", "home_rest", "temp", "wind",
})

assert ENRICHMENT_COLUMNS.isdisjoint(BETTING_COLUMNS), \
    "allow-list leaked a betting column"          # import-time, fails fast

def iter_games_rows(seasons=None):
    """Yield games.csv rows PROJECTED TO ENRICHMENT_COLUMNS ONLY.

    A betting column is not filtered downstream — it is never constructed.
    A caller that reaches for one gets a KeyError, not a number.
    """
    for r in csv.DictReader(io.StringIO(_fetch_text())):
        yield {k: r.get(k) for k in ENRICHMENT_COLUMNS}
```

`build_market_baseline.py` is **not** refactored to use this module. That is
deliberate and load-bearing: keeping the moneyline reader in a separate file
with its own fetch means the module the enrichment builders import has no code
path to a betting column at all. Refactoring for DRY here would re-import the
trap.

**Three enforcement layers, so no single mistake is sufficient:**

| Layer | Mechanism | Where |
|---|---|---|
| **Code** | Projection at the source. Betting columns are never constructed, so downstream code cannot read one even by name. Import-time `assert` on disjointness. | `scripts/scrape/nfldata.py` |
| **Test** | `tests/feature/nfldata_guard.test.mjs` — (a) reads `nfldata.py` as text and asserts every betting column name appears **only** inside `BETTING_COLUMNS`; (b) greps `build_game_context.py`, `build_qb_starters.py`, `build_dvp_history.py`, `build_scheme_history.py`, `promote_signals.py` for any betting column name and asserts **zero hits**; (c) `python3 scripts/scrape/nfldata.py --selftest` (wired into `smoke.sh`) feeds a synthetic row containing `spread_line=-7.5` and asserts the projected dict's keys are a subset of `ENRICHMENT_COLUMNS` and that `"spread_line" not in row`. | `tests/feature/` + `tests/smoke.sh` |
| **Data** | New `validate_data.check_no_betting_columns()` walks every key of `game_context.json` / `coach_history.json` / `qb_starters.json` and fails the gate if any key matches a betting-column name. A backstop that catches a shipped artifact even if code and test were both edited. | `scripts/validate_data.py` |

### 2.3 New artifacts

**`data/game_context.json`** — the enrichment record, 1999–2026.

```json
{ "generated_utc": "...",
  "source": "nflverse nfldata games.csv (enrichment allow-list; betting columns never read)",
  "policy": "NO MARKET COLUMNS - allow-listed at scripts/scrape/nfldata.py",
  "seasons": { "2025": { "1|KC|LAC": {
      "div_game": 1, "referee": "Clete Blakeman",
      "home_coach": "Andy Reid", "away_coach": "Jim Harbaugh",
      "meeting_no": 1 } } } }
```

Key format `week|home|away` matches `market_baseline.json` / `weather_history.json`
so every gate builder joins the same way. `meeting_no` is **derived by us** from
the schedule (1 = first meeting of the season, 2 = rematch), not read from the
CSV. Encoding: `ensure_ascii=True, indent=1, sort_keys=True` — matching
`market_baseline.json`, which is the closest sibling.

**`data/coach_history.json`** — `{coach_name: {seasons: [...], teams: {...},
first_season_by_team: {...}, games: N}}`, derived from `game_context`. This is
what backs the `head_coach_change` registry slot (§7) and what
`coach_regime` reads for "is this a first-year coach at this team".

**`data/qb_starters.json`** — `{season: {week: {team: {"id": "00-00...",
"name": "P.Mahomes"}}}}`. Ground truth. See §3.

All three go into `validate_data.OPTIONAL_DATA` (runner-built; the sandbox
reaches raw.githubusercontent, but the GH runner is the source of record) and
each gets a contract under `data/contracts/`.

### 2.4 New gate families from Item 1

All four appliable families follow the existing `(setup, factory)` builder
contract and add a delta to `hfa_eff`.

**`div_game`** — divisional familiarity.
`delta = scale` when `div_game == 1`, else 0. Signed grid
`DIV_SCALES = [-30, -20, -10, 10, 20, 30]` — direction is unknown a priori,
exactly as `WIND_SCALES` is signed. Hypothesis: familiarity compresses the home
edge, so a negative scale is expected; the gate decides.

**`div_rematch`** — `delta = scale` when `meeting_no == 2`. In the NFL every
second meeting *is* divisional, so `div_rematch ⊂ div_game`. The two are
**correlated by construction**; that is fine and is exactly what the
one-family-per-run cap handles — if `div_game` adopts first, `div_rematch` must
then beat an incumbent that already contains it, which is the correct bar.
Documented in the promotion record so a future reader is not surprised.

**`coach_quality`** — residual-fitted per-coach effect, structurally a copy of
`environment`'s venue term but *differenced*, like `epa_builder`:

```
q[coach] = scale * shrink(n) * mean(signed residual over TRAINING games)
           where the residual is +r when the coach was HOME, -r when AWAY
delta(game) = q[home_coach] - q[away_coach]
```

Shrinkage reuses `SHRINK_N = 16`. Training residuals only (seasons < eval
season) — the same leak discipline the `environment` family already enforces.
Grid `COACH_SCALES = [0, 100, 200, 300]`.

**`coach_regime`** — `delta = scale * (away_first_year - home_first_year)`,
where `first_year` is 1 when this is the coach's first season with this team.
Signed grid `[-40, -25, -10, 10, 25, 40]`. This is the game-side expression of
the `head_coach_change` registry slot.

**`referee`** — see §6. Same residual-fit construction as `coach_quality` but
grouped by crew chief. **Not appliable.**

### 2.5 One change to shared gate machinery

`coach_quality` and `referee` need the *game* behind each residual, which
`walk_season` currently discards. The residual row changes from a 3-tuple to a
**4-tuple**:

```python
residuals.append((h, actual - p_flat, is_cold_game(g), g))   # was 3-tuple
```

and `features_from_residuals` unpacks `for team, r, cold, _g in residual_rows:`.
This is a **breaking change to a shared structure**, which is why
`scripts/promote_signals.py` has exactly **one owner** in the partition (§9) and
why the existing `--selftest` gains an assertion that the tuple is length 4 and
that `environment`'s venue deltas are byte-identical before and after the shape
change (a pure-refactor proof).

---

## 3. Item 1(a) — the qb_out ground-truth upgrade

**This is the highest-value change in Rel18 and the only one that touches an
already-adopted signal. It gets the most validation.**

### 3.1 Why the naive version is a leak, and what to build instead

`home_qb_name` is *who actually took the first snap*. Pricing a game with it
means the model knows, before kickoff, the very fact the injury report is a
noisy forecast of. Log-loss would improve; the improvement would be fake; and
because `qb_out` is already adopted, the fake improvement would be baked into
the incumbent and contaminate every future family comparison. **Rejected.**

What games.csv legitimately gives us is a **ground-truth label**, and from a
label you can build a *better pregame estimator*.

Today (`promote_signals.qb_out_inputs`, lines 141–180) the expected starter for
team T in week W is the **cumulative-dropback leader over weeks < W**. That rule
has a known, severe failure mode: when a starter is benched or replaced in
week 9, the cumulative leader remains the *former* starter until roughly week
15, because he banked a half-season of dropbacks. For six weeks the family
prices "is the primary passer out?" against the wrong player — and those are
exactly the weeks when QB uncertainty is highest.

**The upgrade: `last_started`.** The expected starter for (T, W) is *the player
who actually started T's most recent game before week W*, read from
`qb_starters.json`. Week 1 falls back to the final start of the prior season;
if that is missing, fall back to the existing cumulative-dropback rule. Every
input is from a **completed prior game**, so it is strictly pregame — leak-free
by the same argument that makes `EpaFeatures.margin(…, week)` leak-free.

### 3.2 Validation — changing an adopted signal

Four gates, in order. The swap ships only if all four pass.

**(1) Agreement-rate diagnostic (descriptive, must be reported).**
`scripts/build_qb_starters.py --report` emits, into
`qb_starters.json.diagnostics`:

- `inferred_agreement` — % of team-weeks where the *cumulative-dropback* rule
  named the player who actually started.
- `last_started_agreement` — same for the new rule.
- Both broken out by "weeks following a QB change" (the population the upgrade
  targets) vs "stable weeks".

This is a **measurement, not a gate**: a rule can agree less often overall and
still price better, so agreement alone may not authorise the swap. It is
published so the swap is explicable.

**(2) Paired incumbent A/B — the actual acceptance bar.**
New mode `python -m scripts.promote_signals --qb-source-ab`. It runs the
**full incumbent walk twice** over 2022–2025 — identical params, identical
seasons, identical everything except `qb_out_inputs`' primary-passer rule — and
prints/records:

```
qb_out source A/B  (incumbent walk, 2022-2025)
  dropback_inferred   log-loss 0.xxxxx   n=1084
  last_started        log-loss 0.xxxxx   n=1084
  delta               -0.000xx           MARGIN 0.0015
```

**Acceptance bar: the new source must beat the old by `MARGIN` (0.0015) — the
same never-regress bar a new family faces.** Not "no worse". Not a lowered
margin. A source swap on an adopted signal is at least as consequential as a
new adoption, so it faces at least the same bar. If the delta is neutral or
adverse, the inferred rule is **kept**, the A/B record is archived anyway, and
Rel18 ships `qb_starters.json` as a diagnostic artifact only. That outcome is a
success of the gate.

**(3) Scale re-fit under the new source.**
`qb_out`'s adopted `scale = 75.0` was fitted against the *inferred* source. If
the source changes, the scale must be re-earned: the A/B mode re-runs the
`QB_OUT_SCALES = [25, 50, 75]` grid under `last_started` and adopts the best
scale **in the same write** as the source swap. `game_params.qb_out` gains:

```json
"qb_out": { "applied": true, "scale": 75.0,
            "source": "dropback_inferred",
            "adopted_utc": "2026-07-18T20:37:11Z" }
```

`source` is written on the **next run regardless of outcome** (defaulting to
`"dropback_inferred"`), so the live rule is always self-describing. A swap adds
`"source_switched_utc"` and `"source_ab": {...}` carrying both log-losses.

**(4) Regression capture — how a mistake here is caught.**

- `tests/feature/qb_ground_truth.test.mjs`:
  - `game_params.qb_out.source` is present and one of the two known values;
  - if `source == "last_started"` then `source_ab` exists and its recorded
    delta really is `> MARGIN` (the write cannot claim an unearned swap);
  - `qb_starters.json.diagnostics` carries both agreement rates;
  - `qb_out.applied` is still `true` and `scale` is still one of
    `QB_OUT_SCALES` (a source swap may not silently un-adopt or invent a scale).
- `promote_signals --selftest` gains a synthetic case that locks the
  `last_started` rule end-to-end: a team whose QB changes in week 9 must have
  the *new* starter named as primary from week 10 onward, and the *old* one for
  weeks ≤ 9. This is the exact failure the upgrade exists to fix, pinned.
- `build_predictions.py` prints which source is live in its existing
  `promoted qb_out in effect: …` line, so a prod run is auditable from the log.
- **Rollback:** one-line — set `game_params.qb_out.source` back to
  `"dropback_inferred"` and re-run the pipeline; no code revert needed. Stated
  here because Gate 4 requires a rollback before deploy.

### 3.3 Prediction-time path

`qb_out_current(season)` gains the same `last_started` rule sourced from
`qb_starters.json`'s current season (which the weekly runner refreshes from
games.csv — 2026 rows exist with coaches assigned; QB names populate as games
are played). Preseason, no 2026 starts exist ⇒ fall back to the last start of
2025, which is the honest preseason expectation, and print which fallback fired.
Dormant, never fabricated.

---

## 4. Item 2 — defense-vs-position (DvP)

### 4.1 Builder and artifacts

**`scripts/build_dvp_history.py`** → `data/dvp_history.json`. Streams
`iter_pbp_release(season)` (already proven) and joins a `pid → position` map
built from `fetch_roster_release(season)` (already exists in
`scripts/scrape/nflverse.py`).

Shape mirrors `epa_history.json` — **sums, not means**, so any window
recomposes exactly:

```json
"seasons": { "2025": { "SF": { "7": {
   "QB": {"ppr": 18.4, "plays": 41},
   "RB": {"ppr": 22.1, "plays": 28},
   "WR": {"ppr": 31.7, "plays": 34},
   "TE": {"ppr":  6.2, "plays":  7} } } } }
```

`ppr` is the **scrimmage PPR core** the defence allowed: receiving yards ×0.1 +
rushing yards ×0.1 + receptions ×1.0 + scrimmage TDs ×6 + passing yards ×0.04 +
passing TDs ×4 − interceptions ×2. **Honest limitation, stated in the artifact
and the docstring:** it excludes 2-pt conversions, fumbles lost, and
return TDs, because pbp does not attribute them cleanly to the defence faced.
The field is named `ppr_scrimmage`, not `ppr`, so nobody mistakes it for a full
fantasy total.

**`data/dvp.json`** — the current-season, app-facing rollup:
`{team: {pos: {ppr_per_game, rank, n_games, through_week}}}`, where **week W's
row aggregates weeks < W only**. Walk-forward by construction, and a new
validator invariant (`check_dvp_leak_free`) re-derives one spot-checked cell
from `dvp_history` and fails the gate if week W's own data is included.

### 4.2 App surface (the primary value — this is a start/sit tool)

`player_weekly.json` week rows already carry `opp`. So:

- **Lineup (`app/views/lineup.js`)** — each starter row gains a matchup chip:
  `vs LAR · 3rd-toughest vs WR`. Colour bands from `app/theme.css` (existing
  tokens; contrast already gated by `contrast_aa.test.mjs`). Tapping shows
  points-allowed per game and the sample size.
- **Compare (`app/views/compare.js`)** — a DvP row in the existing metric
  column, so "start Player A or Player B this week" is answerable from the
  matchup, not just the projection.
- **Labelling** — every chip is `estimate: true` in spirit and carries the
  through-week: `through wk 6 · 6 games`. A defence with `n_games < 4` renders
  `insufficient sample`, not a rank. Never a rank off two games.

> **Sequencing:** all three files are Rel17-owned. This work lands after Rel17
> merges (§9), and `dvp.json` is additive — if it 404s (older deploy) the views
> render exactly as Rel17 left them, per the existing `getPlayerWeekly` graceful
> -rejection pattern in `app/data.js`.

### 4.3 Gate family `dvp_mismatch` — and why it is *not* just EPA again

A naive "defence allows more points" family is collinear with `epa_total`'s
defensive half and would add nothing. The non-redundant thing DvP knows that
aggregate EPA cannot express is **positional asymmetry**: a defence that is
elite vs WR and leaky vs RB has the same aggregate EPA as a balanced one.

So the family prices an **interaction**, weighting each opponent's positional
weakness by the offence's own positional usage — and `player_usage_history.json`
(built for `skill_out`) already carries within-team opportunity shares:

```
edge(off, def) = Σ_pos  usage_share[off][pos] * z_allowed[def][pos]
delta(game)    = scale * (edge(home_off, away_def) - edge(away_off, home_def))
```

`z_allowed` is a within-season, leak-free z-score across the 32 defences using
weeks < W. Grid `DVP_SCALES = [0, 100, 200, 300]`. **Appliable** — the
prediction-time path reads `dvp.json` (current season, through last week) plus
`player_usage_history`'s prior-season shares, exactly the inputs `skill_out`
already uses at prediction time.

Honest expectation, recorded in the design: this family is *partly* collinear
with `epa_total` and `skill_out`. If `epa_total` adopts first, `dvp_mismatch`
must beat an incumbent containing it. It may well never clear the margin. That
is the gate working.

---

## 5. Item 3 — FTN charting scheme proxy, and Item 4 — personnel prior

### 5.1 FTN fetcher and artifact

`scripts/scrape/nflverse.py` gains **one** function, reusing `fetch_release_csv`:

```python
def fetch_ftn_charting_release(season, min_rows=20000):
    """FTN charting (ftn_charting_{season}.csv). 2022-present, charted within
    48h of each game -> unlike participation data this IS usable in-season.

    DATA SOURCE: FTN Data via nflverse. Licensed CC-BY-SA 4.0; the attribution
    is carried in every artifact this feed produces and rendered wherever it
    surfaces in the app."""
    url = f"{_RELEASE_BASE}/ftn_charting/ftn_charting_{int(season)}.csv"
    return fetch_release_csv(url, f"ftn_charting_{season}", min_rows=min_rows)
```

**`scripts/build_scheme_history.py`** → `data/scheme_history.json`, sums again:

```json
{ "source": "nflverse FTN charting release",
  "attribution": "FTN Data via nflverse",
  "license": "CC-BY-SA 4.0",
  "coverage": "2022-present; seasons before 2022 are ABSENT, not zero",
  "seasons": { "2025": { "KC": { "7": {
      "off_plays": 62, "pa": 14, "screen": 7, "motion": 39, "no_huddle": 5,
      "def_plays": 58, "box_sum": 371 } } } } }
```

### 5.2 Family `scheme_matchup`

Offence tendency vs defence structure, one documented interaction:

```
off_agg[T]  = z(pa_rate) + z(screen_rate) + z(motion_rate) + z(no_huddle_rate)
def_box[D]  = z(mean n_defense_box)
edge(T, D)  = off_agg[T] * def_box[D]        # misdirection vs a heavy, downhill box
delta(game) = scale * (edge(home, away_def) - edge(away, home_def))
```

Rolling window follows `EpaFeatures`: weeks < W of the current season blended
with the full prior season at `w = plays/(plays + N0)`.

### 5.3 The runway constraint — stated plainly, not buried

FTN begins in **2022**. The gate walks 2022–2025 with **2021 as the prior**.
Therefore:

- 2021 has **no FTN data at all** ⇒ the prior-season half of the 2022 blend is
  empty, so the family is near-silent through most of 2022.
- Eval seasons with usable FTN ≈ **2023–2025**, roughly **800 games** against
  the ~1,084 every other family gets.
- **The margin does not scale down with the sample.** `scheme_matchup` must
  clear the same 0.0015 on ~26% less data. It is *structurally disadvantaged*.

**Missing-season behaviour: skip loudly, never impute.** When a season has no
FTN rows the family contributes `delta = 0.0` for every game in it and the
promotion record carries
`"coverage": {"seasons_with_ftn": [2023, 2024, 2025], "seasons_skipped": [2022], "games_priced": 812}`.
A zero delta on a skipped season is *not* a claim that scheme does not matter
there; it is a claim that we do not know, which is the only honest option.

**Expectation, set now:** `scheme_matchup` may legitimately never be adopted.
If it never clears 0.0015, that is the never-regress gate **working**, not the
feature failing. Success for Item 3 is defined as *"the family runs, is honest
about coverage, and the trials are archived"* — not as *"the family adopts"*.

### 5.4 Attribution — where the credit appears

CC-BY-SA 4.0 requires attribution wherever the data surfaces. Three places,
all **rendered from the artifact**, never hardcoded — so if the feed is
removed the credit disappears with it and cannot go stale:

1. `scheme_history.json.attribution` / `.license` (the source of truth).
2. The MODEL tab's data-provenance footer reads that field and renders
   `Scheme data: FTN Data via nflverse (CC-BY-SA 4.0)`.
3. Any Lineup/Compare chip whose value derives from scheme data carries the
   credit in its detail popover.
4. `docs/SIGNAL_REGISTRY.md` records it against the `scheme_fit` slot.

A `rel18_contracts.test.mjs` case asserts (1) is present and non-empty and that
the app string in (2) is derived from it.

### 5.5 Item 4 — participation personnel, deferred behind Item 3

nflverse participation (`offense_personnel` / `defense_personnel`, 11/12/21
groupings) exists for 2023–2025 **via FTN Data**, and **does not update during
the season** — it is published after the postseason completes. 2026 personnel
data will not exist until after the 2026 postseason.

Therefore it is designed as an **offseason prior only**:

- `scripts/build_personnel_prior.py` → `data/personnel_prior.json`, carrying
  `"cadence": "offseason-only"`, `"source_season": 2025`, `"is_prior": true`,
  `"never_in_season": true`, plus the same FTN attribution block.
- **Not** in `daily.yml` or `backtest.yml`. A `workflow_dispatch` job plus a
  single March cron — running it in-season can only re-publish last season's
  numbers under a fresh timestamp, which would be a lie about freshness.
- Any UI that shows it is prefixed `2025 PRIOR ·`, and the module docstring
  opens with the cadence warning so the next reader cannot miss it.

**Deferred behind Item 3. The evidence bar to start building it:**
`scheme_matchup` must, in the archived promotion trials, either
(a) **clear MARGIN** outright, or
(b) show a **positive best-scale improvement over the incumbent in ≥2
consecutive weekly gate runs** (i.e. it is consistently on the right side of
zero, just not yet past 0.0015).
If the best scale is 0.0 or the improvement is negative across the season,
**Item 4 is not built** — personnel groupings are a refinement of a scheme
signal that showed no signal, and building it would be adding data to a dead
hypothesis. This decision is re-evaluated at the end of the 2026 season, once.

---

## 6. `referee` — the APPLIABLE guard, made concrete

`referee` is designed, built, and entered into the gate as a **candidate that
cannot be applied**, and this is the release's clearest demonstration of why
the honesty guard exists.

**The family.** Same residual-fit shape as `coach_quality`, grouped by crew
chief: `bias[ref] = scale * shrink(n) * mean(signed home residual)`,
`delta(game) = bias[referee_of_this_game]`. Grid `REF_SCALES = [0, 100, 200, 300]`.

**Why it cannot be applied.** `games.csv` carries `referee` for **games already
played**. There is **no verified pregame crew-assignment feed** in this
platform. At prediction time, for an upcoming game, we do not know the referee.
So the family has walk-forward inputs but **no prediction-time path**.

**Therefore `referee` is NOT added to `APPLIABLE`.** If it clears the margin,
`promote_signals` records `would_adopt` and prints the existing
`PENDING: referee cleared the margin but has no application path yet` line.
`game_params` is not written. Nothing changes in production.

That is the correct outcome and it is worth stating why it is not a failure:
the run would have *measured* that crew-level home bias exists at a magnitude
worth chasing, which is exactly the evidence needed to justify a future
release going and finding a pregame assignment feed. A gate that adopted it
anyway would be claiming an effect the pipeline cannot deliver.

**Scope note — what is deliberately not built.** The brief mentions
penalty/total skew. This gate's objective is **game-outcome log-loss**; we do
not model totals. A referee-totals family would have neither an objective nor an
application path — a `would_adopt` on a metric we never score. Not built.

---

## 7. Registry slots — what finally gets real data, and what stays empty

The registry's 32 weights are pinned at 0.0 by `validate_data.check_meta_weights`
and **Rel18 does not change a single one**. "Backing a slot with real data"
means the slot stops being an *empty slot* (a name with nothing behind it) and
gains a real artifact the player-side optimizer could one day fit. Two distinct
mechanisms, never conflated:

- **Registry weight** — earned by the *player-side* optimizer. Still 0.0.
- **Game-side effect** — earned by the *promotion gate* as a family delta on
  `hfa`. Independent of the registry.

| Slot | Rel18 outcome |
|---|---|
| `head_coach_change` | **Backed.** `coach_history.json` — 177 coaches, 27 seasons, 100% coverage incl. all 272 2026 games. Weight stays 0.0; the game-side effect is earned separately via the `coach_regime` family. |
| `scheme_fit` | **Backed.** `scheme_history.json` (FTN, 2022+). Weight 0.0. Coverage limitation recorded on the slot. |
| `schedule_strength` | **Backed.** `dvp.json` is literally this slot's description — *"strength of the position-relevant opposing units"*. Weight 0.0; surfaced as display. |
| `coordinator_change` | **Stays empty, deliberately.** Item 5 gives current-season OC/DC only. A single cross-section cannot train anything: the gate learns from history, and there is no OC/DC-by-season release anywhere (nflverse `nfldata` DATASETS.md lists draft picks, draft values, games, team colors, logos, rosters, standings, teams, trades — no coordinators; `spatto12/NFLCoaches` is head coaches only, 1966–2023, PFR-derived). **Display/context only.** |
| `qb_coaching` | **Stays empty.** No source at all. Named, unbacked, honest. |
| `one_on_one_matchup` | **Stays empty.** DvP is a *positional-group* proxy; true WR-vs-shadow-CB needs tracking/coverage data this platform does not have. Explicitly **not** claimed as filled by DvP. |

### Why coach-vs-coach pairings are NOT built

Coach *identity* is rich: 177 distinct head coaches over 27 seasons, ~7,548
games — plenty for coach-level aggregate, tenure, and first-year-regime effects,
which is exactly what `coach_quality` and `coach_regime` price.

Specific **pairings** are not. 177 coaches admit ~15,600 unordered pairs against
~1,084 eval games; the overwhelming majority of pairs have **zero or one**
meeting in the eval window, and even long-running rivalries reach single digits.
Fitting a per-pairing effect on n≤2 and asking it to clear a 0.0015 log-loss
margin is fitting noise and calling it a coaching matchup. **Not built.** If a
future release wants it, the honest form is a hierarchical shrink toward the
coach-level effect — which is a different design, not a scale grid.

---

## 8. Multiplicity — a risk this release creates, and its brake

Rel18 takes the gate from 8 candidate families to **15**. More families means
more chances that one clears 0.0015 by luck rather than signal.

**The margin is not raised or lowered.** It stays 0.0015 (standing rule: never
lower it to force an adoption; and raising it ad hoc would be the same sin in
the other direction). Three existing mechanisms already brake multiplicity, and
Rel18 adds one record:

1. **One family adopted per run.** A lucky family must be the *best* of 15, not
   merely better than the incumbent.
2. **The incumbent absorbs adoptions.** A family adopted on noise becomes part
   of the incumbent and must keep earning against every subsequent candidate; a
   spurious adoption degrades the incumbent and makes the *next* run's bar
   easier to clear for genuinely better families — the loop is self-correcting
   over weeks, not within a run.
3. **Walk-forward, not in-sample.** Luck has to survive four held-out seasons.
4. **New:** the promotion record gains
   `"families_tested": 15, "families_runnable": N, "trials": M` so the
   multiple-comparisons exposure of any adoption is visible in the archive
   rather than implicit. A future release can compute a best-of-N null from
   this; Rel18 records it and does not act on it.

---

## 9. Build partition — disjoint file ownership

Seven agents. **No two agents write the same file.** Serialization points are
explicit.

| Agent | Owns (writes) | Reads | Depends on |
|---|---|---|---|
| **A1 — nfldata gateway** | `scripts/scrape/nfldata.py`, `scripts/build_game_context.py`, `data/contracts/game_context.schema.json`, `data/contracts/coach_history.schema.json`, `tests/feature/nfldata_guard.test.mjs` | `build_market_baseline.py` (pattern only) | — |
| **A2 — QB ground truth** | `scripts/build_qb_starters.py`, `data/contracts/qb_starters.schema.json`, `tests/feature/qb_ground_truth.test.mjs` | A1's `nfldata.iter_games_rows` | **A1** (module contract agreed up front, before A1 finishes) |
| **A3 — DvP** | `scripts/build_dvp_history.py`, `scripts/build_dvp.py`, `data/contracts/dvp_history.schema.json`, `data/contracts/dvp.schema.json` | `scrape/nflverse.py` (read-only), `build_player_usage.py` | — |
| **A4 — FTN scheme** | `scripts/scrape/nflverse.py` **(sole writer)**, `scripts/build_scheme_history.py`, `data/contracts/scheme_history.schema.json` | — | — |
| **A5 — coordinators (static)** | `scripts/scrape/coordinators.py`, `data/contracts/` entry if any | `scrape/stadiums.py` (pattern) | — |
| **A6 — gate families** | `scripts/promote_signals.py` **(sole writer)**, `tests/feature/rel18_families.test.mjs` | every artifact above | **A1–A4** artifacts must exist |
| **A7 — integration / tech lead** | `scripts/build_predictions.py`, `scripts/validate_data.py`, `tests/smoke.sh`, `.github/workflows/backtest.yml`, `.github/workflows/daily.yml`, `app/data.js`, `app/views/team.js`, `app/views/lineup.js`, `app/views/compare.js`, `app/theme.css`, `tests/feature/rel18_contracts.test.mjs` | everything | **Rel17 merged**, then A1–A6 |

**Wave plan (respects the 4–6 default concurrency):**

- **Wave 1 (4 parallel):** A1, A3, A4, A5 — fully independent, no shared files.
- **Wave 2 (1):** A2 — needs A1's module.
- **Wave 3 (1):** A6 — needs every artifact; sole writer of the gate.
- **Wave 4 (1):** A7 — **blocked on Rel17 merging.** Every file in A7's column
  except the new test and the workflows is a Rel17-owned file. A7 rebases onto
  merged Rel17 and integrates: application blocks in `build_predictions.py`,
  schemas + `OPTIONAL_DATA` + two new invariants in `validate_data.py`, the new
  `--selftest` lines in `smoke.sh`, the DvP chips in the views, the coordinator
  block on the Team tab, and the runner steps in `backtest.yml`.

**Shared-file collisions, named so they are avoided:**

- `tests/smoke.sh` — A1/A2/A3/A4 each *want* to add a `--selftest` line.
  **They must not.** They write the selftest inside their own module; **A7 adds
  every `smoke.sh` line in one edit.**
- `scripts/scrape/nflverse.py` — A3 reads `iter_pbp_release`/`fetch_roster_release`;
  only **A4 writes** it.
- `scripts/validate_data.py`, `scripts/build_predictions.py`, `app/views/*.js`,
  `app/theme.css` — Rel17-owned; **A7 only, after Rel17 merges**.
- `data/meta.json` / `scripts/signals/registry.py` — **untouched by Rel18.**
  No slot is added or reweighted; §7's "backing" is about artifacts, not weights.

---

## 10. Pipeline wiring and cadence

| Builder | Workflow | Cadence | Why |
|---|---|---|---|
| `build_game_context.py` | `backtest.yml` | weekly | Coaches/div/referee change on a season timescale; 2026 rows already complete. |
| `build_qb_starters.py` | `backtest.yml` **and** `daily.yml` | weekly + daily | The `last_started` rule needs last week's starts before the next slate is priced. |
| `build_dvp_history.py` | `backtest.yml` | weekly | Streams pbp; past seasons immutable and cached, like `epa_history`. |
| `build_dvp.py` | `daily.yml` | daily | Feeds the start/sit surface; must be current through last week. |
| `build_scheme_history.py` | `backtest.yml` | weekly | FTN charts within 48h; weekly is sufficient and cheap. |
| `build_personnel_prior.py` | `workflow_dispatch` + one March cron | offseason only | **Never in-season** — see §5.5. |
| `coordinators.py` | none (static) | hand-curated | See §11. |

Every builder follows the established honesty contract: `FeedError` on
transport/non-200/short rows, **keep the existing file on failure**, a
`pipeline_status` feed row with real `rows`/`status`, and a `--selftest` that
runs against a committed fixture under `data/fixtures/` and **never writes**.
Each new artifact is added to `validate_data.OPTIONAL_DATA` (runner-built), so
the gate passes on a fresh checkout before the bootstrap dispatch has run.

---

## 11. Item 5 — coordinators: curated, display-only, and its refresh story

**`scripts/scrape/coordinators.py`** — a static curated table, in the
declared spirit of `scripts/scrape/stadiums.py`: no I/O, no network, gate-safe
to import, with a `SOURCES (checked <date>)` docstring citing Wikipedia's
*List of current NFL offensive coordinators* and *…defensive coordinators*.
Despite living under `scrape/`, it scrapes nothing — same as `stadiums.py`.

```python
COORDINATORS = {
    "KC": {"hc": "Andy Reid", "oc": "Matt Nagy", "dc": "Steve Spagnuolo",
           "oc_first_year": False, "dc_first_year": False},
    ...  # all 32
}
CHECKED_UTC = "2026-08-13"   # the freshness contract, in the data itself
```

**Why it is not a model signal.** There is no historical OC/DC-by-season
release anywhere (§7). A current-season cross-section gives the gate exactly
**one** observation per team and **zero** prior seasons to walk forward over —
nothing to learn from, and any weight fitted on it would be fitting the 2026
season to itself. Display and context only.

**The refresh story, honestly.** Coaching changes cluster in **January**
(Black Monday through the Super Bowl) with a long tail into February. So:

- **Who:** a human, once per offseason, plus ad-hoc after any in-season firing.
  This is a **manual handoff** and it is in the backlog as one, with
  copy-paste-ready steps (open the two Wikipedia lists → diff against
  `COORDINATORS` → edit the dict → bump `CHECKED_UTC` → run the gate).
- **When the app detects staleness:** the Team tab computes
  `now - CHECKED_UTC`. Over **180 days** it renders the block with a
  `COACHING STAFF · AS OF <date>` header and a muted `may be out of date` note
  rather than hiding it. Over **365 days** the block is **suppressed entirely**
  and replaced by `coaching staff data not refreshed for this season` — a stale
  coordinator shown confidently is worse than no coordinator, and this is the
  same discipline `weather_forecast` uses when its horizon lapses.
- A `rel18_contracts.test.mjs` case pins both thresholds and asserts
  `CHECKED_UTC` parses.

---

## 12. Gate impact and rollback

**Regression gate is unchanged in shape**, only in content:

```
python3 scripts/validate_data.py          # +5 schemas, +2 cross-file invariants
bash tests/smoke.sh                       # +5 python selftests (A7 adds them all)
node --test tests/feature/*.mjs           # +4 test files
npx playwright test …                     # Rel17's suite + DvP chip cases
```

**Rollback, per item, stated before any deploy (Gate 4 requirement):**

| Change | Rollback |
|---|---|
| qb_out source swap | `game_params.qb_out.source = "dropback_inferred"`, re-run pipeline. **Data-only, no code revert.** |
| Any new family adoption | Delete its block from `game_params` (e.g. `coach_hfa`); `build_predictions` guards on `applied` and reverts to byte-identical output. |
| DvP / scheme / coordinator app surfaces | `git revert` the A7 commit; views degrade to Rel17 behaviour because every new read is guarded on a possibly-404 artifact. |
| A whole artifact | Delete the file; it is in `OPTIONAL_DATA`, so the gate stays green and every consumer is already written to skip loudly. |

**Day-zero output guarantee:** with no family adopted and every new artifact
absent, `build_predictions.py` produces **byte-identical** output to Rel17.
Every Rel18 addition is behind an `applied` flag or a file-existence guard.
That property is what makes this release safe to land next to Rel17, and
`rel18_contracts.test.mjs` asserts it directly.
