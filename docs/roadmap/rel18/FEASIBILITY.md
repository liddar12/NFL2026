# Rel18 — Data Source Feasibility Report

**Role:** Data Source / Feasibility Engineer
**Date of probes:** 2026-08-13 (all network checks below were executed live from
this sandbox on this date; nothing here is recalled or assumed)
**Scope:** prove what is fetchable from THIS sandbox vs. what must be runner-built,
and pin down exact column names for the five Rel18 items.

> **Design-only artifact.** No code, test, data, contract or workflow file was
> created or modified. Every probe was a read-only HTTP GET; downloads landed in
> the session scratchpad, never in the repo.

---

## 0. Headline verdicts (read this first)

Four findings overturn assumptions currently written into the codebase or the
Rel18 brief. Design around these, not around the prior beliefs.

| # | Finding | Why it matters |
|---|---|---|
| **H1** | **nflverse-data release assets are NOW REACHABLE from this sandbox.** `play_by_play_2025.csv.gz` (19 MB), `ftn_charting_2025.csv` (8.1 MB), `pbp_participation_2023.csv` (50 MB) all returned **HTTP 200** and streamed/parsed cleanly. | Multiple docstrings in the repo state "the sandbox proxy 403s these releases" (`build_epa_history.py`, `build_player_usage_history.py`, `scrape/nflverse.py`). That is **no longer true**. Rel18 builders for Items 2/3/4 can be developed and smoke-tested locally, not blind. See §7 for the caveat before you rely on it. |
| **H2** | **`away_qb_name` / `home_qb_name` / `referee` in games.csv are POST-GAME columns.** 100% populated on the 7,276 played games; **0% populated on all 272 unplayed 2026 games**. | This reframes Item 1a and largely **kills Item 1c**. QB ground truth is a *training/eval label*, not a pregame feature. Referee is not known pregame from this source at all, so a referee family cannot be APPLIABLE. Details in §2.2 and §2.4. |
| **H3** | **`away_coach` / `home_coach` / `div_game` ARE pregame.** 272/272 populated for the unplayed 2026 season. | Items 1b and 1d are genuinely appliable at prediction time. These are the two enrichment opportunities that can actually reach `build_predictions.py`. |
| **H4** | **The participation `offense_personnel` format BREAKS between 2022 and 2023.** ≤2022: `"1 RB, 1 TE, 3 WR"` (skill positions only, the classic personnel grouping). ≥2023: `"1 C, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR"` (all 11 players incl. OL/QB). | A naive Item 4 parser written against one era silently produces garbage on the other. Two parsers, or a normalizer, are mandatory. Details in §4.2. |

---

## 1. Verdict table (all sources)

| Source | Reachable from sandbox | Exact URL | Seasons verified | Cadence | License / attribution |
|---|---|---|---|---|---|
| **nfldata games.csv** | ✅ **YES** — HTTP 200, 2,175,368 B, 0.62 s | `https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv` | 1999–2026, 7,548 rows, 46 cols | Continuous; 2026 schedule already fully seeded (272 REG games) | MIT (nflverse). Credit "nflverse" — already the project's practice. |
| **nflverse pbp** | ✅ **YES** — HTTP 200, 19,362,351 B, gzip stream parsed, 372 cols | `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_{season}.csv.gz` | 2025 ✅, 2024 ✅; **2026 → 404** (season not started) | Weekly in-season | MIT (nflverse) |
| **nflverse FTN charting** | ✅ **YES** — HTTP 200, 7.1–8.3 MB per season | `https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_{season}.csv` | **2022 ✅ 2023 ✅ 2024 ✅ 2025 ✅**; **2021 → 404**, **2026 → 404** | Weekly in-season (evidence in §3.3) | **CC-BY-SA 4.0 — attribution "FTN Data via nflverse" REQUIRED wherever it surfaces.** Share-alike obligation. |
| **nflverse participation** | ✅ **YES** — HTTP 200, 21–50 MB per season | `https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_{season}.csv` | 2016 ✅ 2020 ✅ 2022 ✅ 2023 ✅ 2024 ✅ 2025 ✅; **2026 → 404** | **Post-postseason only. Does NOT update in-season.** | 2023+ is FTN-sourced → **CC-BY-SA 4.0, "FTN Data via nflverse"**. Pre-2023 is NGS-sourced. |
| **nflverse rosters** | ✅ **YES** — HTTP 200, `roster_2025.csv` 1,010,039 B (3,137 rows); **`roster_2026.csv` 923,611 B EXISTS** | `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{season}.csv` | 2025 ✅, 2026 ✅ | Weekly | MIT (nflverse) |
| **Wikipedia OC list** | ✅ **YES** — HTTP 200, 205,715 B | `https://en.wikipedia.org/wiki/List_of_current_NFL_offensive_coordinators` | Current season only (rev. **2026-07-12**) | Manual edits; churn concentrated in Jan–Feb | **CC-BY-SA 4.0** + attribution |
| **Wikipedia DC list** | ✅ **YES** — HTTP 200, 209,651 B | `https://en.wikipedia.org/wiki/List_of_current_NFL_defensive_coordinators` | Current season only (rev. **2026-07-12**) | Manual edits | **CC-BY-SA 4.0** + attribution |
| **nfldata `coaches.csv`** | ❌ **DOES NOT EXIST** — HTTP 404 | `…/nfldata/master/data/coaches.csv` | — | — | — |
| **nfldata `coordinators.csv`** | ❌ **DOES NOT EXIST** — HTTP 404 | `…/nfldata/master/data/coordinators.csv` | — | — | — |
| **spatto12/NFLCoaches** | ❌ **BLOCKED** — HTTP 403 from egress policy | `https://github.com/spatto12/NFLCoaches` | Cannot verify | — | Do not design against it. |
| **api.github.com** | ❌ **BLOCKED** — HTTP 403 | `https://api.github.com/repos/nflverse/nflverse-data/releases` | — | — | Asset URLs must be **constructed by convention**, never discovered via the API. |

**Runner-built / dormant required:** none of the five items is blocked by
reachability. The only hard blockers are **calendar** (FTN 2026 and participation
2026 do not exist yet) and **provenance** (no historical coordinator release
exists anywhere).

---

## 2. ITEM 1 — games.csv enrichment

### 2.1 Confirmed shape

`HTTP 200`, **7,548 rows**, **46 columns**, seasons **1999–2026**. Exact column
list, in file order:

```
game_id, season, game_type, week, gameday, weekday, gametime,
away_team, away_score, home_team, home_score, location, result, total, overtime,
old_game_id, gsis, nfl_detail_id, pfr, pff, espn, ftn,
away_rest, home_rest,
away_moneyline, home_moneyline, spread_line, away_spread_odds, home_spread_odds,
total_line, under_odds, over_odds,
div_game, roof, surface, temp, wind,
away_qb_id, home_qb_id, away_qb_name, home_qb_name,
away_coach, home_coach, referee, stadium_id, stadium
```

The brief's names are all confirmed correct for this file.

### 2.2 ⚠️ Pregame vs. post-game — the decisive finding (H2)

I partitioned the file on `result` being empty (unplayed) vs. populated (played):

| Column | Populated on 272 **unplayed** games | Populated on 7,276 **played** games | Verdict |
|---|---|---|---|
| `home_coach` / `away_coach` | **272 / 272 (100%)** | 100% | ✅ **PREGAME** |
| `div_game` | **272 / 272 (100%)** | 100% | ✅ **PREGAME** (7,548/7,548 all-time) |
| `home_qb_name` / `away_qb_name` | **0 / 272 (0%)** | 7,276 (100%) | ❌ **POST-GAME ONLY** |
| `referee` | **0 / 272 (0%)** | 7,275 (99.99%) | ❌ **POST-GAME ONLY** |
| `home_moneyline` | 52 / 272 (19%) | — | (irrelevant — banned, see §2.6) |

Per-season coverage, key columns:

| Season | Games | coaches | div_game | qb_name | referee | result |
|---|---|---|---|---|---|---|
| 2021 | 285 | 100% | 100% | 100% | 99.6% | 100% |
| 2022 | 284 | 100% | 100% | 100% | 100% | 100% |
| 2023 | 285 | 100% | 100% | 100% | 100% | 100% |
| 2024 | 285 | 100% | 100% | 100% | 100% | 100% |
| 2025 | 285 | 100% | 100% | 100% | 100% | 100% |
| **2026** | **272** | **100%** | **100%** | **0%** | **0%** | 0% |

2026 is REG-only (272); 2021–2025 are 272 REG + 12–13 postseason.

### 2.3 Item 1a — qb_out ground-truth upgrade: **FEASIBLE, but as a LABEL only**

`away_qb_name`/`home_qb_name` give the **actual** starter with `*_qb_id` in
nflverse gsis format (e.g. `00-0033077` = Dak Prescott), joinable to rosters and
to `epa_history` passers.

**The constraint that must shape the design:** because these columns are empty
for every unplayed game, they can be used to **train and validate** `qb_out`, but
the **live in-season path still has to infer the starter** from the existing
dropback/depth-chart/injury logic. This is a *measurement* upgrade, not a
prediction-time feature swap.

The honest framing for the build agents:

- **Backtest/gate side:** replace the inferred expected starter with the actual
  starter → this removes label noise from the walk-forward evaluation of an
  already-adopted family.
- **Prediction side:** unchanged inference. It cannot change.
- **The genuinely valuable deliverable** is therefore an **agreement-rate
  diagnostic**: how often does the current inference match the actual starter?
  That number is currently unknown and is measurable on all 1,424 resolved
  2021–2025 games. If agreement is already ~97%, the ceiling on this work is
  small and Rel18 should say so out loud rather than re-run the gate for nothing.

Validation bar (recommended, for the design doc to formalise): compute
agreement rate first as a **cheap gating step**; only if disagreement exceeds a
stated threshold on the eval span does re-running `promote_signals.py` for
`qb_out` become justified. Any re-run must clear the same `MARGIN = 0.0015`
never-regress bar as an initial adoption — an adopted family gets **no
grandfathering**. Regression is caught by pinning the current
`data/model_tuning.json` `game_params.qb_out` (`{"applied": true, "scale": 75.0}`)
in a test and asserting the value only moves via a gate run that records its own
margin.

### 2.4 Item 1c — referee tendency: **RECOMMEND CUTTING**

Historically the data is excellent: **91 distinct referees** 1999–2026, **19
active** across 2022–2025 with a **median of 66 games each** (min 16, max 70) —
comfortably enough games per crew chief to estimate a tendency.

But the crew chief is **not in this file before kickoff** (0/272 for 2026). A
referee family would therefore hit the **APPLIABLE guard** in
`promote_signals.py` — the guard exists precisely to stop the gate claiming a
signal is applied when the pipeline cannot apply it — and would record
`would_adopt` forever. The current `APPLIABLE` set is:

```
{"environment", "rest", "epa_total", "epa_pass", "elo_epa",
 "qb_out", "weather_wind", "skill_out"}
```

Adding `referee` to it would be **dishonest**, because at prediction time there
is no referee to key on. The NFL does publish crew assignments midweek, but that
is a **different, unverified source** and out of Rel18's scope.

**Verdict: do not build the referee family in Rel18.** Document it as
"data-rich, application-blocked". If someone wants it later, the prerequisite is
a verified pregame crew-assignment feed, not more work on games.csv.

### 2.5 Item 1b (div_game) and 1d (coach) — both **FEASIBLE and APPLIABLE**

**`div_game`:** 100% populated across all 7,548 rows, values `{0: 4717, 1: 2831}`.
On the gate's eval span (2022–2025 REG): **1,087 games, 384 divisional (35.3%)**.
Pregame-known. This is the cleanest new candidate family in Rel18 — one binary
column, no join, no parsing, full history.

**Head coach:** 177 distinct coaches 1999–2026; **137 with ≥32 games**, **53 with
≥100 games**; median 64 games per coach. 32 coaches in 2026, of whom **4 are
first-year** (`Jeff Hafley`, `Jesse Minter`, `Klint Kubliak`, `Todd Monken`).
First-year regime-change team-games per season: 2021: 129 · 2022: 97 · 2023: 71 ·
2024: 68 · 2025: 88 · 2026: 68. That is a workable sample for a
tenure/regime-change effect.

**Why the pairwise coach-vs-coach version is NOT buildable — the hard numbers:**

- **3,452** distinct coach-vs-coach pairings across 1999–2026
- **median meetings per pairing: 1**; mean 2.19
- **1,965 pairings (57%) have exactly ONE meeting**
- only **63 pairings (1.8%)** have ≥10 meetings
- the most-played pairing all-time is Harbaugh–Tomlin at 40 games

A candidate family whose typical cell holds one observation cannot clear a
never-regress margin; it can only overfit. This is a **data-shape refusal**, and
the design doc should state it in exactly these terms.

⚠️ **Name-normalization risk:** the source contains at least one misspelling —
`Klint Kubliak` (should be *Kubiak*). Coach identity is a free-text string with no
ID column, so a coach-level family needs a normalization/alias map in the spirit
of `scripts/scrape/renames.py`, plus a test that the 2026 coach set resolves to
exactly 32 distinct teams.

### 2.6 ⚠️ THE TRAP — betting columns in the same file

games.csv carries **8 market columns**: `away_moneyline`, `home_moneyline`,
`spread_line`, `away_spread_odds`, `home_spread_odds`, `total_line`,
`under_odds`, `over_odds`.

`scripts/build_market_baseline.py` reads `away_moneyline`/`home_moneyline` **for
measurement only**, and its own docstring states the policy boundary. The Rel18
enrichment builder is a **second** consumer of the same file and is where the
standing rule could silently break.

**Recommended guard (design, not implementation):**

1. The enrichment builder declares a module-level **`ALLOWED_COLUMNS` frozenset** —
   the explicit allow-list of the only keys it may read:
   `{game_id, season, game_type, week, gameday, away_team, home_team,
   away_coach, home_coach, div_game, away_qb_id, home_qb_id,
   away_qb_name, home_qb_name, result}`.
2. Row access goes through a single accessor that raises on any key outside the
   set — so a future edit that reaches for `spread_line` fails loudly at runtime
   rather than quietly becoming a feature.
3. **Two tests enforce it.** (a) A **source-text test** greps the builder module
   for the 8 banned column names and fails on any literal occurrence — this
   catches the mistake at the point it is typed. (b) A **behavioural test** feeds
   the builder a fixture row whose market columns are poisoned with absurd
   sentinel values and asserts the emitted JSON is byte-identical to the same
   fixture with those columns blank — proving no market value can reach the
   output even indirectly.
4. `scripts/validate_data.py` continues to pin every market signal at weight 0.0;
   the enrichment output must contain **no market keys at all**, which is a
   stronger and more easily asserted property than "weight 0".

Test (b) is the load-bearing one: a grep alone can be defeated by a computed
column name, whereas the poisoned-fixture test is behavioural.

---

## 3. ITEM 3 — FTN charting (assessed before Item 2 because Item 4 gates on it)

### 3.1 Reachability and URL pattern — **CONFIRMED FETCHABLE**

```
https://github.com/nflverse/nflverse-data/releases/download/ftn_charting/ftn_charting_{season}.csv
```

This matches the existing `_RELEASE_BASE` convention in
`scripts/scrape/nflverse.py` exactly (`{_RELEASE_BASE}/{tag}/{asset}`), so
`fetch_release_csv()` is reusable **as-is** — plain `.csv`, not gzipped, so
`iter_pbp_release`'s gzip path is not needed.

| Season | HTTP | Bytes | Rows | Distinct games | Weeks |
|---|---|---|---|---|---|
| 2021 | **404** | 9 | — | — | — |
| 2022 | 200 | 7,089,615 | 41,643 | 284 | 1–22 |
| 2023 | 200 | 8,285,822 | 48,225 | 285 | 1–22 |
| 2024 | 200 | 8,254,908 | ~48,031 | 285 | 1–22 |
| 2025 | 200 | 8,128,926 | 47,316 | 285 | 1–22 |
| 2026 | **404** | 9 | — | — | — |

Game coverage is **complete** within covered seasons (284/284 and 285/285 vs.
games.csv). Weeks 1–22 include postseason.

### 3.2 Exact columns — **29, schema identical 2022 and 2025**

```
ftn_game_id, nflverse_game_id, season, week, ftn_play_id, nflverse_play_id,
starting_hash, qb_location, n_offense_backfield, n_defense_box,
is_no_huddle, is_motion, is_play_action, is_screen_pass, is_rpo, is_trick_play,
is_qb_out_of_pocket, is_interception_worthy, is_throw_away, read_thrown,
is_catchable_ball, is_contested_ball, is_created_reception, is_drop, is_qb_sneak,
n_blitzers, n_pass_rushers, is_qb_fault_sack, date_pulled
```

⚠️ **The brief says `is_screen_p`. The real column is `is_screen_pass`.** Correct
this in the design docs before build agents copy it.

Bonus columns the brief did not list but which are directly relevant to a scheme
family: **`is_rpo`**, **`n_blitzers`**, **`n_pass_rushers`**, `is_qb_out_of_pocket`.
`n_blitzers`/`n_pass_rushers` are arguably a *better* defensive-tendency axis than
`n_defense_box`, since box count conflates down-and-distance with scheme.

**Join keys:** `nflverse_game_id` (e.g. `2025_01_DAL_PHI`) + `nflverse_play_id`.
⚠️ **Do NOT join via the `ftn` column in games.csv** — it is only 834/1,139
populated on the 2022–2025 eval span and **0% for 2023**. Join on
`nflverse_game_id`, which is 100% clean.

### 3.3 Value formats and the **zero-sentinel trap**

Booleans are the literal strings `'TRUE'` / `'FALSE'` (not `true`/`1`).

`qb_location` distribution (2025): `S` 22,226 · `U` 12,145 · **`0` 11,241** · `P` 1,704
→ Shotgun / Under center / Pistol, and **`0` is a sentinel**, not a location.

`n_defense_box` distribution (2025): `6` 19,304 · **`0` 11,235** · `7` 9,567 ·
`5` 4,362 · `8` 1,772 · `4` 668 · `9` 237 · `10` 77 · `3` 68

⚠️ **~23.7% of FTN rows are uncharted/special-teams rows carrying `0` in the
numeric columns.** A naive `mean(n_defense_box)` would be dragged toward zero and
produce a completely wrong "light box" reading for every team. The builder MUST
filter to scrimmage plays — filtering on `n_defense_box not in ('', '0')` yields
**36,081** real plays in 2025, and on that subset `qb_location` is a clean
`S/U/P` with only 11 stragglers.

Reference rates on that filtered subset (2025) — useful as fixture assertions:

| Tendency | Rate |
|---|---|
| `is_play_action` | 14.0% |
| `is_motion` | 55.1% |
| `is_no_huddle` | 9.7% |
| `is_screen_pass` | 4.6% |

`n_offense_backfield` also carries 774 empty strings in 2025 — handle `''` and
`'0'` distinctly from a genuine `0`.

### 3.4 Cadence — **in-season use CONFIRMED**

`date_pulled` per week for 2025 shows the weekly refresh directly:

```
wk 1–12 : 2025-12-11   (bulk re-pull; whole-season file is republished each build)
wk13–14 : 2025-12-12
wk15    : 2025-12-17
wk16    : 2025-12-24
wk17    : 2025-12-31
wk18    : 2026-01-16
wk19–22 : 2026-01-20 .. 2026-02-10
```

Weeks 15/16/17 landing on consecutive Wednesdays is direct evidence of a weekly
in-season publish. This **confirms the brief's claim** that FTN is usable
in-season, unlike participation. Note the file is republished whole, so
`date_pulled` reflects the last pull, not the original charting time — it is
evidence of *cadence*, not a 48-hour SLA.

### 3.5 ⚠️ The short-runway constraint — state this plainly

The gate uses `SEASONS = [2021, 2022, 2023, 2024, 2025]` with
`EVAL_SEASONS = [2022, 2023, 2024, 2025]`, i.e. **2021 is the prior season**.

**FTN does not cover 2021** (verified 404). So an FTN family has:

- **no prior season** — the walk-forward's first evaluated season has no FTN
  history to build its team-tendency estimates from;
- an effective runway of roughly **2023–2025 (~855 evaluated games)** if 2022 is
  consumed as the FTN prior, versus **1,139** for every existing family.

That is a **~25% smaller evaluation set and a structurally weaker first season**,
against an unchanged `MARGIN = 0.0015`.

**Handling seasons with no FTN data:** skip loudly. The family must return "no
opinion" (zero delta, explicitly recorded as `unavailable`) for 2021 and for any
2026 week before the 2026 asset appears — never impute a league-average
tendency, which would fabricate signal.

**Expectation-setting:** an FTN scheme family may legitimately **never be
adopted**. Exactly one family has ever been adopted in this project's history
(`qb_out`). A never-regress gate declining a short-runway family is the gate
**working**, and the design doc should pre-commit to that reading so a
`would_adopt`/no-adopt outcome is not later relitigated as a build failure.

### 3.6 License

**CC-BY-SA 4.0.** The credit line **"FTN Data via nflverse"** must appear
wherever FTN-derived numbers surface — in the app UI on any matchup/scheme
element, in the generated JSON's `source` field, and in the builder docstring.
Share-alike also applies to derived data files.

---

## 4. ITEM 4 — Participation personnel (offseason prior, gated behind Item 3)

### 4.1 Reachability — better than the brief assumed

```
https://github.com/nflverse/nflverse-data/releases/download/pbp_participation/pbp_participation_{season}.csv
```

| Season | HTTP | Bytes | Note |
|---|---|---|---|
| 2016 | 200 | 21,073,382 | NGS-era format |
| 2020 | 200 | 21,537,880 | NGS-era format |
| 2022 | 200 | 22,245,804 | NGS-era format, **20 columns** |
| 2023 | 200 | 49,967,956 | FTN-era format, **26 columns** |
| 2024 | 200 | 49,688,308 | FTN-era format |
| 2025 | 200 | 49,094,943 | FTN-era format |
| **2026** | **404** | 9 | **Does not exist — confirms the offseason-only cadence** |

The brief said "available 2023, 2024, 2025". In fact data reaches back to at
least **2016**, but in a **different format** (§4.2). The 2026 404 on
2026-08-13 — well after the 2025 postseason and shortly before the 2026 season —
is direct confirmation that this feed is **published after the postseason and
never refreshed in-season**. The offseason-prior framing in the brief is correct
and is now evidence-backed.

### 4.2 ⚠️ THE FORMAT BREAK (H4)

**≤2022 (NGS-derived), 20 columns.** `offense_personnel` is the classic skill
grouping. Top values, 2022:

```
3,251  '1 RB, 1 TE, 3 WR'      <- 11 personnel
  859  '1 RB, 2 TE, 2 WR'      <- 12 personnel
  426  '2 RB, 1 TE, 2 WR'      <- 21 personnel
  186  '2 RB, 2 TE, 1 WR'
  176  '1 RB, 3 TE, 1 WR'
```

Identical shape in 2016 and 2020.

**≥2023 (FTN-derived), 26 columns.** `offense_personnel` lists **all 11 players
including OL and QB**. Top values, 2023:

```
711  '1 C, 2 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR'
301  '1 C, 1 G, 1 QB, 1 RB, 3 T, 1 TE, 3 WR'
266  '1 C, 2 G, 1 QB, 1 RB, 2 T, 2 TE, 2 WR'
129  '3 G, 1 QB, 1 RB, 2 T, 1 TE, 3 WR'
```

To recover "11 personnel" from the 2023+ format you must parse the
comma-separated `"<count> <POS>"` tokens and count **only RB/FB/TE/WR**, then
render as the conventional `RB·TE` two-digit code. The 2023+ format is strictly
more informative (it exposes 6-OL packages, e.g. `3 T`) but is **not**
drop-in compatible.

The extra 2023+ columns are: `offense_names`, `defense_names`,
`offense_positions`, `defense_positions`, `offense_numbers`, `defense_numbers`.

Full 2023+ column list:

```
nflverse_game_id, old_game_id, play_id, possession_team, offense_formation,
offense_personnel, defenders_in_box, defense_personnel, number_of_pass_rushers,
players_on_play, offense_players, defense_players, n_offense, n_defense,
ngs_air_yards, time_to_throw, was_pressure, route,
defense_man_zone_type, defense_coverage_type,
offense_names, defense_names, offense_positions, defense_positions,
offense_numbers, defense_numbers
```

### 4.3 ⚠️ Special-teams contamination

Sampled 2023/2025 rows show values like
`offense_personnel = '2 CB, 2 DE, 1 FS, 2 MLB, 1 OLB, 2 RB, 1 TE'` and
`defense_personnel = '4 CB, 2 ILB, 1 K, 2 OLB, 1 SS, 1 WR'`. These are
**special-teams plays** where "offense"/"defense" mean the possession team's
units — a kicker appears in `defense_personnel`. Any personnel-rate builder must
filter to scrimmage plays (join to pbp `play_type in ('run','pass')`, or reject
rows whose offense personnel contains defensive position tokens) or the
personnel distribution will be badly polluted.

Also note `n_offense`/`n_defense` carry `'0'` on some rows (another sentinel) and
`offense_formation` is only ~80% populated (`SHOTGUN`, `EMPTY`, `UNDER CENTER`, …).
`defense_man_zone_type` / `defense_coverage_type` are only ~50% populated —
attractive columns, but too sparse to lean on.

### 4.4 Conditionality — keep it deferred

Item 4 remains **deferred behind Item 3**, and the feasibility work supports
that ordering for a reason beyond effort: participation cannot cover 2026 at all
during the 2026 season, so its best case is a static preseason prior that decays
all year. Item 3's FTN feed does the same conceptual job (scheme tendency) with a
**live weekly** cadence.

**Evidence from Item 3 that would justify starting Item 4:** the FTN scheme
family clearing the never-regress margin, or — the weaker but still meaningful
bar — recording a `would_adopt` with a log-loss improvement that survives all
three of 2023/2024/2025 rather than being carried by one season. If the FTN
family shows nothing, personnel groupings (a coarser proxy for the same
underlying thing, on a worse cadence) will show less, and Item 4 should be
dropped rather than built dormant.

---

## 5. ITEM 2 — Defense-vs-Position (DvP)

**No new source required. Fully feasible, and the only Item with zero external
risk.**

`play_by_play_{season}.csv.gz` streamed live: **HTTP 200, 372 columns**, 40,000
rows parsed without error. Every column needed for PPR fantasy-points-allowed is
present — verified individually:

`posteam`, `defteam`, `season`, `week`, `game_id`, `season_type`, `play_type`,
`receiver_player_id`, `receiver_player_name`, `rusher_player_id`,
`passer_player_id`, `complete_pass`, `yards_gained`, `receiving_yards`,
`rushing_yards`, `pass_touchdown`, `rush_touchdown`, `touchdown`, `td_player_id`,
`td_team`, `interception`, `fumble_lost`, `two_point_conv_result`, `sack`,
`air_yards`, `yards_after_catch`, `pass_attempt`, `rush_attempt`,
`field_goal_result`, `extra_point_result`, `special_teams_play`, `epa`

**Convenience columns also present:** `fantasy_player_id`, `fantasy_player_name`,
`fantasy`, `fantasy_id` — nflverse's own attribution of the play to the fantasy-
relevant player. Worth evaluating as a simplification, though deriving from
`receiver_player_id`/`rusher_player_id` keeps the math explicit and auditable.

`play_type` distribution over the first 40k rows of 2025:
`pass` 16,162 · `run` 12,163 · `no_play` 3,953 · `kickoff` 2,408 · `punt` 1,671 ·
`''` 1,185 · `extra_point` 1,101 · `field_goal` 925. Filter as
`build_epa_history.py` already does (`play_type in ('run','pass')`).

**⚠️ The one join DvP requires:** pbp has **no position column**. Positions come
from `roster_{season}.csv` — verified reachable, **3,137 rows for 2025**, with
`gsis_id` (matching pbp's `*_player_id` format `00-00xxxxx`) and `position`:
`DB` 614 · `OL` 550 · `DL` 458 · `LB` 415 · **`WR` 401 · `RB` 233 · `TE` 207 ·
`QB` 131** · `K` 50 · `LS` 39 · `P` 39. Offensive skill positions are exactly the
granularity DvP needs. `ngs_position` offers a finer split if required. Note the
roster file also carries `week` and `game_type`, so mid-season team changes are
resolvable rather than being flattened to a season-end team.

**`roster_2026.csv` already exists** (923,611 B), so the 2026 join works from day
one even though `play_by_play_2026.csv.gz` is still 404 (season not started).

**Leak-free requirement** is satisfiable purely with columns in hand: partition on
`season`, accumulate by `week`, and expose week *W* only the sum over weeks `< W`.
No external dependency, no cadence risk.

---

## 6. ITEM 5 — Coordinators

### 6.1 The gap is CONFIRMED — no historical source exists

- `https://raw.githubusercontent.com/nflverse/nfldata/master/data/coordinators.csv` → **HTTP 404**
- `https://raw.githubusercontent.com/nflverse/nfldata/master/data/coaches.csv` → **HTTP 404**
- `nfldata/DATASETS.md` fetched and inspected: sections are Draft Picks, Draft
  Values, Games, Colors, Logos, Rosters, Standings, Teams, Trades. The **only**
  coaching entries anywhere in it are, under *Games*:
  `away_coach: Name of the head coach of the away team` and the home equivalent.
  **No coordinator dataset. Confirmed.**
- `https://github.com/spatto12/NFLCoaches` → **HTTP 403** (egress policy). Cannot
  be verified from here and must not be designed against. Independently, the
  brief notes it is head-coaches-only 1966–2023, which does not solve the OC/DC
  problem regardless.

### 6.2 Wikipedia — reachable, and structured better than expected

Both pages return **HTTP 200**. Titles resolve under two forms (the `NFL` and
`National_Football_League` variants both 200, ~205–210 KB).

**⚠️ The MediaWiki API rejects the default `urllib` User-Agent with HTTP 403.**
It succeeds with an explicit UA. Any fetch helper must set one — e.g.
`User-Agent: nfl2026/1.0 (contact: liddar@gmail.com)`. This is a real trap: the
plain page GET works via curl while `urllib.request.urlopen` on the API 403s.

Retrieved via `action=query&prop=revisions&rvslots=main`:

| Page | pageid | Last revision | Wikitext |
|---|---|---|---|
| List of current NFL offensive coordinators | 14853106 | **2026-07-12T04:12:40Z** | 15,805 B |
| List of current NFL defensive coordinators | 30472955 | **2026-07-12T04:10:44Z** | 16,243 B |

Both are a single `{| class="wikitable sortable"` with columns:

```
! Team !! Coordinator !! Since !! Previous coaching position
```

32 team rows plus 8 division sub-headers (43 and 42 `|-` separators
respectively). Coordinator names are wrapped in `{{sortname|First|Last}}`
templates, occasionally with `|dab=` disambiguators (e.g.
`{{sortname|Sean|Duggan|dab=American football}}`), and the `Since` cell is a
season wikilink. Real 2026 rows confirmed: Buffalo OC **Pete Carmichael Jr.**
(since 2026), Miami OC **Bobby Slowik** (2026), Buffalo DC **Jim Leonhard**
(2026), Miami DC **Sean Duggan** (2026).

The **`Since` column is a genuinely useful bonus** the brief did not anticipate:
it gives coordinator *tenure*, which supports an honest "first year in this
system" context note without any modelling.

### 6.3 Verdict — curated static table, display/context only

The recommendation in the brief holds and is now evidence-backed. Build it in the
spirit of `scripts/scrape/stadiums.py` (deliberately curated, not scraped): a
small hand-maintainable table of 32 teams × {OC, DC, since}, checked into the
repo.

**Why it must NOT become a model signal:** there is **no by-season historical
OC/DC release anywhere** — verified above across nfldata, its DATASETS.md, and
the only third-party candidate. The walk-forward gate evaluates 2022–2025; with
only a current-season snapshot there are **zero historical observations** for the
gate to learn from. A coordinator signal could not be trialled, so it could not
earn weight, so under the project's weight-0 rule it would sit at 0.0 forever
while implying a precision that does not exist. The registry slots
`coordinator_change` and `scheme_fit` therefore **stay empty in Rel18**;
`head_coach_change` is the one that Item 1d can legitimately begin to fill,
because head-coach history *does* exist back to 1999.

**Refresh story, honestly:** coordinator churn is concentrated in **January–
February** (both pages were last edited 2026-07-12, i.e. stable through the
summer; the confirmed 2026 hires are dated late Jan / early Feb 2026). So this is
a **once-a-year manual refresh in February**, with an opportunistic mid-season
touch-up if a team fires a coordinator. The design must include:

- a `season` and `verified_utc` field in the static table;
- an app behaviour when the table's `season` is older than the current season:
  **suppress the display entirely** rather than showing a stale name, consistent
  with the project's skip-loudly rule;
- a validator check that the table contains exactly 32 teams and that its
  `season` matches `data/meta.json`'s `season`, so staleness fails the gate
  rather than reaching the UI.

**Attribution:** Wikipedia content is **CC-BY-SA 4.0** — the same obligation as
FTN. Credit and link the two source pages wherever coordinators are displayed.

---

## 7. Cross-cutting notes for the build agents

### 7.1 The reachability change is real but should be treated as a bonus, not a dependency

H1 is the biggest operational finding: pbp, FTN, participation and roster release
assets all fetch cleanly from this sandbox today. That makes Items 2/3/4
developable locally instead of blind-shipped dormant.

**But do not remove the loud-failure paths.** The repo's existing posture —
`FeedError` on any non-200, keep the existing file, ship dormant rather than fake
— is what makes an egress-policy change survivable. The historical 403s were real
enough to be written into three docstrings; treating today's 200s as permanent
would be the wrong lesson. **Recommendation:** builders keep the
`fetch_release_csv` / `iter_pbp_release` contract exactly as-is, and the docstring
claims that say "the sandbox proxy 403s these releases" get **corrected to
describe the behaviour conditionally** rather than asserting a permanent block.

⚠️ `api.github.com` **is** still 403. Asset URLs must be built by convention from
`_RELEASE_BASE`, never discovered by listing releases. The existing code already
does this correctly.

### 7.2 Environment facts

- `requests` **2.33.1 is installed**.
- `nfl_data_py` is **NOT installed** — so the `_require_nfl_data_py()` path in
  `scrape/nflverse.py` is unusable here. Every Rel18 builder must use the
  **release-CSV path** (`fetch_release_csv` / `iter_pbp_release`), which is
  stdlib `csv` + guarded `requests`. This aligns with the stdlib-only rule anyway.
- Release assets 302 to `release-assets.githubusercontent.com` with signed,
  short-lived query strings — follow redirects; never cache a resolved URL.

### 7.3 Gate parameters confirmed by reading the code

- `MARGIN = 0.0015` (`scripts/refit.py:69`), imported by `promote_signals.py`
- `SEASONS = [2021, 2022, 2023, 2024, 2025]`, `EVAL_SEASONS = [2022, 2023, 2024, 2025]`
- `APPLIABLE = {environment, rest, epa_total, epa_pass, elo_epa, qb_out, weather_wind, skill_out}`
- at most one family adopted per run; non-APPLIABLE families record `would_adopt`
- current adopted state: `game_params.qb_out = {"applied": true, "scale": 75.0}`,
  adopted 2026-07-18
- eval-span size: **1,139** resolved games 2022–2025 (1,088 REG); **1,424**
  resolved games 2021–2025

### 7.4 Suggested file-ownership partition (disjoint, for parallel build agents)

Derived from the source verdicts — each partition owns a distinct feed and a
distinct output file, so no two agents touch the same file.

| Agent | Owns (new files) | Reads only |
|---|---|---|
| **A — games.csv enrichment** | `scripts/build_game_context.py`, `data/game_context.json`, its contract + tests | games.csv (allow-listed columns) |
| **B — DvP** | `scripts/build_dvp.py`, `data/dvp.json`, contract + tests | pbp release, roster release |
| **C — FTN scheme** | `scripts/build_scheme_tendency.py`, `data/scheme_tendency.json`, contract + tests | ftn_charting release |
| **D — coordinators** | `scripts/scrape/coordinators.py` (curated static table), contract + tests | none at runtime |
| **E — gate families** | new candidate-family definitions inside `promote_signals.py` | outputs of A/B/C |
| **F — app surfaces** | `app/` views for DvP + scheme + coordinator context | outputs of A/B/C/D |

⚠️ **Agent E is the serialization point** — `promote_signals.py` is a single file
and cannot be co-owned. It must run **after** A/B/C have landed their JSON
outputs. Agent F likewise depends on A–D. Genuine parallelism here is **A, B, C, D
concurrently (4 agents)**, then E and F. That matches the project's "default 4 to
6 concurrent" guidance; adding more agents to this shape would only add merge
cost.

⚠️ **Rel17 collision check:** none of the files above appear in the Rel17
in-flight list (`scripts/availability.py`, `scripts/injury_duration.py`,
`scripts/build_weekly.py`, `scripts/scrape/espn.py`,
`scripts/build_injury_history.py`, `scripts/build_predictions.py`,
`scripts/validate_data.py`, `app/availability.js`, `app/lineup.js`,
`app/views/lineup.js`, `app/views/compare.js`, `app/theme.css`,
`data/player_weekly.json`, `data/injuries.json`). **Two files are shared and need
sequencing after Rel17 lands:** `scripts/build_predictions.py` (Agent E's
application wiring) and `scripts/validate_data.py` (every agent's contract
registration). Agent F's Lineup/Compare surfaces also land in files Rel17 is
editing — `app/views/lineup.js` and `app/views/compare.js` — so Rel18's app work
must be sequenced behind Rel17, not merged concurrently.

---

## 8. Item-by-item bottom line

| Item | Verdict | Confidence | Principal risk |
|---|---|---|---|
| **1a** qb_out ground truth | ✅ Feasible **as a training/eval label only** | High | Post-game column; cannot change the live inference path. Value may be small — measure agreement rate first. |
| **1b** div_game | ✅ **Feasible and appliable** — best value/effort in Rel18 | High | None material. 100% coverage, pregame, one column. |
| **1c** referee | ❌ **Recommend cutting** | High | Not pregame → fails the APPLIABLE guard by construction. |
| **1d** head coach (coach-level) | ✅ Feasible and appliable | High | Free-text names, no ID; needs an alias map (`Klint Kubliak` typo confirmed). |
| **1d′** coach-vs-coach pairwise | ❌ **Not buildable** | High | Median 1 meeting per pairing; 57% have exactly one. |
| **2** DvP | ✅ **Feasible — lowest external risk** | High | Needs a roster join for position; ST/`no_play` filtering. |
| **3** FTN scheme | ✅ Fetchable; **adoption genuinely uncertain** | High on data, low on adoption | No 2021 → short runway (~855 vs 1,139 eval games); 23.7% zero-sentinel rows. May never adopt — that is the gate working. |
| **4** Participation prior | ✅ Fetchable 2016–2025; **2026 confirmed absent** | High | Format break at 2022/2023 boundary; ST contamination. Keep deferred behind Item 3. |
| **5** Coordinators | ✅ Feasible as curated static table | High | No history anywhere → **must not** become a model signal. Annual Feb refresh; suppress when stale. |

---

*All probes read-only. No repository file outside `docs/roadmap/rel18/` was
created or modified.*
