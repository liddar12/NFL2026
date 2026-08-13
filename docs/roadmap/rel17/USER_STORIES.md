# REL17 — BACKLOG: EPICS → USER STORIES → TASKS

**Release:** Player availability (IR / PUP / NFI / suspension / parsed duration) + preseason form.
**Authority:** `docs/roadmap/rel17/SOLUTION_DESIGN.md`. Where `ARCHITECTURE.md`,
`TECH_DESIGN.md` or `UX_DESIGN.md` disagree with it, SOLUTION_DESIGN wins and this backlog
follows SOLUTION_DESIGN. Every number quoted below was re-verified against the committed
tree and the committed data, not copied from an upstream doc.

**Actors.** *Manager* = the human playing fantasy football in the app. *System* = the
Python pipeline / GitHub-Actions runner. *Operator* = whoever runs the gate and ships.

**Standing rules that bind every story:** no build step / bundler / framework; stdlib-only
Python; honest data (never fabricate — skip loudly); learned signals default to weight 0
behind the never-regress promotion gate; `ensure_ascii=True` on-disk encoding; fix only
what is scoped.

---

## 0. Release summary

| | |
|---|---|
| Epics | **6** |
| User stories | **21** (one — R17-E2-S5 — contingent on Open Decision 1) |
| Tasks | **122** |
| Acceptance criteria | **117** |
| Automated AC coverage | **117 / 117 = 100%**, zero manual-only ACs (see §7 rollup) |
| Build agents | A (pipeline) ∥ B (app) ∥ D (preseason) → **C (integration, last)** |

**Measured blast radius the whole backlog is written against** (SOLUTION_DESIGN §1.3,
reproduced here against the committed files):

* `data/injuries.json` holds **800** rows — `Active` 673, `Questionable` 65, `Out` 51,
  `Injured Reserve` 10, `Suspension` 1.
* **14** players are season-class (10 IR + 1 SUSPENDED + 3 `Out` rows promoted by
  unambiguous season-ending text: ATL DeAngelo Malone, NO Keeshawn Silver, TB Chase Lucas).
* Exactly **1** of those 14 is inside `data/player_projections.json`'s top 300:
  **SF Ricky Pearsall** (`espn-4428209`, WR, `proj_points` 88.6, bye wk 8).
* Pearsall is a **null parse** — no duration is stated — so he lands on the
  `MIN_WEEKS_OUT = 4` league floor. **Recomputed here from the committed files and
  confirmed exact:** target `88.6 × 13/17 = 67.75`, rescale factor `1.000339`, rounded
  new sum `67.73`, `season_points_lost` **20.87**, surviving weeks
  `4.45, 5.63, 5.16, [bye], 5.98, 5.33, 5.19, 4.63, 5.41, 4.84, 4.97, 5.32, 5.22, 5.60`.

> **Backlog-wide dependency — Open Decision 1.** If the owner rejects `MIN_WEEKS_OUT = 4`
> in favour of "zero nothing without a parsed duration", then **R17-E2-S5 is cut and the
> release changes nothing on disk** — Pearsall is the only in-app season-class player and
> he is the floor case. Every AC below that names Pearsall, `LEAGUE MIN`, `4+ WKS` or
> `20.87` is contingent on that decision being **adopt** (SOLUTION_DESIGN §10.1
> recommends adopt). Confirm before BUILD-A starts.

---

## EPIC R17-E1 · One availability vocabulary, honestly parsed
**Owner:** BUILD-A (with the espn_players/projection boundary handed to BUILD-C)
**Fixes:** F4 (PUP/NFI never captured), F5 (duration scraped then thrown away),
F6 (projection injury bands unreachable)
**Status:** 🔴 Not started

### Goal
Today the same fact — "this guy can't play" — is spelled five different ways across three
feeds and consumed by nobody. ESPN says `Injured Reserve`, ESPN's fantasy API says
`injury_reserve`, nflverse says `Out`, and `player_projection.py` is looking for `"pup"`,
a string no feed has ever emitted. One vocabulary, one Python module, one normalization
boundary — and the rich free text ESPN already gives us gets parsed into a duration
instead of being written to disk and ignored.

### Why it matters
A manager cannot act on a fact the app never records. F5 is the sharpest version: ESPN
literally tells us *"Kibble will now be forced to miss the entire 2026 season"* and we
store that sentence and do nothing with it. But the honest-data rule cuts both ways — a
parser that guesses is worse than no parser, so the acceptance bar here is **zero false
positives**, with recall reported honestly and allowed to be low.

---

### R17-E1-S1 — One canonical vocabulary every feed maps into · Est: M
**As** the System **I want** every injury string from every feed normalized into one
eight-code vocabulary **so that** "on IR" means the same thing to the weekly split, the
projection bands and the Lineup screen instead of three different things.

**Acceptance criteria** (Given/When/Then):
- **R17-E1-S1-AC1** — Given `scripts/availability.py`, When imported, Then it exposes
  exactly the eight codes `ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED`
  as `CODES`, plus `WEEK_CLASS == {QUESTIONABLE, DOUBTFUL, OUT}` and
  `SEASON_CLASS == {IR, PUP, NFI, SUSPENDED}`, and it imports with no third-party
  dependency.
- **R17-E1-S1-AC2** — Given each of the five statuses actually present in today's
  `data/injuries.json` (`Active`, `Questionable`, `Out`, `Injured Reserve`, `Suspension`),
  When passed to `normalize_status`, Then they return `ACTIVE, QUESTIONABLE, OUT, IR,
  SUSPENDED` respectively, case- and whitespace-insensitively.
- **R17-E1-S1-AC3** — Given ESPN's documented-but-currently-unfired spellings
  `"Physically Unable to Perform"` and `"Non-Football Injury"`, When normalized, Then they
  return `PUP` and `NFI` — **this is the whole of F4**: the codes exist and are wired
  before a feed emits them, so the day one does, nothing is silently dropped.
- **R17-E1-S1-AC4** — Given the ESPN fantasy (kona) spellings `injury_reserve`,
  `day_to_day`, `probable`, When normalized, Then they return `IR`, `QUESTIONABLE`,
  `ACTIVE`; and given nflverse's `Out` / `Doubtful` / `Questionable`, Then they return the
  matching week-class codes.
- **R17-E1-S1-AC5** — Given an unknown spelling (e.g. `"Reserve/COVID-19"`), When
  normalized, Then `normalize_status` returns **`None`**, and every consumer contract
  documents that `None` means *we do not know* — **never** silently `ACTIVE`.
- **R17-E1-S1-AC6** — Given `python3 scripts/availability.py --selftest`, When run, Then it
  exits `0` and covers every key in the map plus at least one unknown.

**Tasks:**
- [ ] R17-E1-S1-T1 — Create `scripts/availability.py` with the eight code constants, `CODES`, `WEEK_CLASS`, `SEASON_CLASS`, `MIN_WEEKS_OUT = 4`.
- [ ] R17-E1-S1-T2 — Implement `_MAP` with lower-cased, whitespace-collapsed keys per SOLUTION_DESIGN §1.2 (ESPN site, ESPN kona, nflverse, forward-compat).
- [ ] R17-E1-S1-T3 — Implement `normalize_status(raw) -> code | None` with the docstring stating the `None` contract verbatim.
- [ ] R17-E1-S1-T4 — Implement `classify(code) -> "week" | "season" | None`.
- [ ] R17-E1-S1-T5 — Implement `--selftest` covering every map key + unknown + `None` input + empty string.
- [ ] R17-E1-S1-T6 — Add `tests/feature/availability.test.mjs` driving the module via the `python3 -` subprocess pattern already used by `tests/feature/weekly_injury.test.mjs`.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::vocabulary_shape` (unit) — Planned
- AC2 → `tests/feature/availability.test.mjs::normalizes_live_feed_statuses` (unit) — Planned
- AC3 → `tests/feature/availability.test.mjs::pup_nfi_wired_before_first_sighting` (unit) — Planned
- AC4 → `tests/feature/availability.test.mjs::normalizes_kona_and_nflverse` (unit) — Planned
- AC5 → `tests/feature/availability.test.mjs::unknown_returns_none_not_active` (unit) — Planned
- AC6 → `scripts/availability.py --selftest` via `tests/smoke.sh` (smoke) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), smoke.

**Traceability:** `scripts/availability.py`, `scripts/scrape/espn.py`,
`scripts/scrape/espn_players.py`, `scripts/models/player_projection.py`.

---

### R17-E1-S2 — Parse the injury report into a duration, and never guess one · Est: L
**As** a Manager **I want** the app to read what the beat report actually said about how
long my guy is gone **so that** I can tell "he's out four games" from "he's done for the
year" without opening Twitter — and **so that** when the report doesn't say, the app
admits it doesn't know instead of inventing a number.

**Acceptance criteria** (Given/When/Then):
- **R17-E1-S2-AC1** — Given `parse_duration(detail, status)` and a status **not** in
  `SEASON_CLASS ∪ {OUT}`, When called, Then it returns `None` without evaluating a single
  pattern. *This status gate is load-bearing, not defensive:* without it the real feed
  produces four fabricated durations from `Active`/`Questionable` blurbs about **last
  season** or **a teammate** — CeeDee Lamb *"missing three games overall due to injury"*
  (2025), Sauce Gardner *"…to close out the 2025 regular…"*, Christian Kirk *"with ricky
  pearsall (knee, ir) out for the season"*, Emmanuel Ogbah (a sentence about Ashton
  Gillotte). All four must be `None`.
- **R17-E1-S2-AC2** — Given the eight real `Injured Reserve` rows whose text is
  unambiguously season-ending (Brazzell CAR, Downs KC, Collier LV, Walls LAR, Kibble NE,
  Webb NE, Kamara SF, Kane TEN), When parsed, Then each returns
  `{out_for_season: true, weeks_out: null, confidence: "explicit", evidence: <the matched
  sentence>}`. Named sub-cases that **must** match and are the C4 correction:
  Brazzell's *"miss **his entire rookie** season"* and Kibble/Webb's *"miss the entirety of
  the **upcoming** campaign"*.
- **R17-E1-S2-AC3** — Given the three ESPN-`Out` rows whose text is unambiguously
  season-ending (DeAngelo Malone ATL, Keeshawn Silver NO, Chase Lucas TB), When parsed,
  Then each returns `out_for_season: true` — i.e. **class is data, not a status lookup**.
  A build that hardcodes `class = "season" iff status in SEASON_CLASS` fails this AC.
- **R17-E1-S2-AC4** — Given CHI Beanie Bishop Jr. (`Suspension`, *"set to miss the first
  three games of the 2026 regular season"*), When parsed, Then it returns
  `{weeks_out: 3, out_for_season: false, confidence: "explicit"}`.
- **R17-E1-S2-AC5** — Given SF Ricky Pearsall, whose detail quotes a surgeon and one report
  saying `"6-12 months"`, When parsed, Then it returns **`None`** — rejected twice, by the
  hedge veto (`report`, `suggest`) and by the range veto. Given KC John Michael Gyllenborg
  (*"will need to miss some time"*), Then it also returns `None`.
- **R17-E1-S2-AC6** — Given a detail containing `unless he … reaches an injury settlement`,
  When parsed, Then the `unless … settlement` clause is stripped **before** the hedge veto
  runs and the season-ending read still fires — an injury settlement is a release from the
  roster, not a return to it. Six real IR rows carry this clause.
- **R17-E1-S2-AC7** — Given a parsed count outside `1..17`, or a hedged/ranged/
  week-to-week/day-to-day/"no timetable" sentence, When parsed, Then `weeks_out` is `None`.
- **R17-E1-S2-AC8** — Given `python3 scripts/injury_duration.py --selftest` run over the
  committed corpus, When it completes, Then it exits `0` **and asserts exactly 12 positive
  parses and 0 false positives across all 800 rows**. Claiming a duration nobody stated is
  a gate failure; low recall is not.
- **R17-E1-S2-AC9** — Given any successful parse, When returned, Then `evidence` carries
  the **matched sentence verbatim**, so every duration in the committed JSON is auditable
  and quotable without paraphrase.

**Tasks:**
- [ ] R17-E1-S2-T1 — Create `scripts/injury_duration.py` (stdlib `re` only, pure, deterministic).
- [ ] R17-E1-S2-T2 — Implement the status gate (`SEASON_CLASS ∪ {OUT}`) as the first statement in `parse_duration`.
- [ ] R17-E1-S2-T3 — Implement sentence splitting: `detail or ""` → casefold → collapse whitespace → split on `(?<=[.!?])\s+`; evaluate per sentence, first match wins.
- [ ] R17-E1-S2-T4 — Implement Veto 1 (hedge) with the `unless … settlement` whitelist strip.
- [ ] R17-E1-S2-T5 — Implement Veto 2 (numeric range `N-M weeks/months/games`).
- [ ] R17-E1-S2-T6 — Implement Veto 3 (parenthetical injury tag = other subject; backward-reference terms for numeric rules only).
- [ ] R17-E1-S2-T7 — Implement R1 season-ending with the bounded `[^.]{0,40}?` / `[^.]{0,30}?` gaps that fix C4.
- [ ] R17-E1-S2-T8 — Implement R2 (explicit game count) and R3 (explicit week count) with `<NUM>` word-or-digit and the `1..17` bound.
- [ ] R17-E1-S2-T9 — Do **not** implement R4 (`returns_wk`) — cut by SOLUTION_DESIGN §4.3; a field nothing consumes is F5 all over again.
- [ ] R17-E1-S2-T10 — Implement `--selftest` with the 12 real positives, the 4 real negatives from §4.1, and the Pearsall/Gyllenborg nulls; assert the corpus-wide 12/0 counts.
- [ ] R17-E1-S2-T11 — Extend `tests/feature/availability.test.mjs` with the parser cases.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::status_gate_kills_teammate_and_last_season_text` (unit) — Planned
- AC2 → `tests/feature/availability.test.mjs::season_ending_eight_ir_rows` (unit) — Planned
- AC3 → `tests/feature/availability.test.mjs::out_rows_promoted_to_season_class` (unit) — Planned
- AC4 → `tests/feature/availability.test.mjs::suspension_three_games_explicit` (unit) — Planned
- AC5 → `tests/feature/availability.test.mjs::pearsall_and_gyllenborg_are_null` (unit) — Planned
- AC6 → `tests/feature/availability.test.mjs::settlement_clause_whitelisted` (unit) — Planned
- AC7 → `tests/feature/availability.test.mjs::out_of_range_and_hedged_are_null` (unit) — Planned
- AC8 → `scripts/injury_duration.py --selftest` via `tests/smoke.sh` (smoke, corpus-wide) — Planned
- AC9 → `tests/feature/availability.test.mjs::evidence_is_verbatim` (unit) — Planned
- **Coverage: 9/9 = 100%.** Types: unit(node:test), smoke.

**Traceability:** `scripts/injury_duration.py`, `data/injuries.json`.

---

### R17-E1-S3 — An unrecognised status fails loudly, never becomes "healthy" · Est: M
**As** the Operator **I want** a new ESPN injury spelling to break the gate **so that** the
class of bug this release exists to fix — a fact silently degrading into "he's fine" —
cannot recur the next time ESPN renames something.

**Acceptance criteria** (Given/When/Then):
- **R17-E1-S3-AC1** — Given `espn.fetch_injuries()` receives a status that
  `normalize_status` cannot map, When it runs, Then it raises `FeedError` naming the raw
  value and pointing at `scripts/availability.py`, matching the existing `_team_abbrev()`
  precedent (`scripts/scrape/espn.py:81-92`).
- **R17-E1-S3-AC2** — Given the committed `data/injuries.json`, When `tests/smoke.sh` runs,
  Then it asserts **every** `status` value normalizes to a canonical code and fails the
  gate otherwise. This is the single check that stops the bug class recurring.
- **R17-E1-S3-AC3** — Given `build_weekly.load_injuries()`, When it meets an unmappable
  status, Then it degrades **gracefully** — no raise, no shaping, no unavailability — per
  its own "graceful BY CONTRACT, unlike the feeds" docstring
  (`scripts/build_weekly.py:60-65`), and `tests/feature/weekly_injury.test.mjs:122-144`
  stays green **unmodified**. Loudness lives at the scraper and at the gate; the consumer
  stays graceful, and `None` is treated as *no shaping and no unavailability* — never as
  `ACTIVE`.
- **R17-E1-S3-AC4** — Given `scripts/build_injury_history.py`, When `shape()` runs, Then it
  **asserts** each of its three whitelisted statuses maps through
  `availability.normalize_status`, and `data/injury_history.json` is **byte-identical**
  to the committed file. It must **not** be re-keyed (C7: 553 KB committed, schema pins
  `enum ["Out","Doubtful","Questionable"]` under `additionalProperties: false`, and its
  nflverse upstream 403s through the sandbox proxy — re-keying is an unfixable red gate).
- **R17-E1-S3-AC5** — Given `data/injuries.json` after regeneration, When validated against
  the new `data/contracts/injuries.schema.json`, Then it carries `vocab_version`, a
  `counts` block, and per-row `availability`, `availability_class`, `weeks_out`,
  `out_for_season`, `confidence`, `evidence` — while `status` and `detail` remain
  **byte-identical** to ESPN's raw strings, so `INJURY_MULT`'s three verbatim keys and the
  `weekly_injury.test.mjs:61` assertion survive untouched.

**Tasks:**
- [ ] R17-E1-S3-T1 — Add the `FeedError`-on-unmapped-status guard to `espn.fetch_injuries()`.
- [ ] R17-E1-S3-T2 — Emit the enriched row shape (SOLUTION_DESIGN §2.1) from `fetch_injuries()`; keep `status`/`detail` verbatim.
- [ ] R17-E1-S3-T3 — Regenerate `data/injuries.json` as a **pure offline transform** of the committed 800 rows (no network call).
- [ ] R17-E1-S3-T4 — Add the assertion to `build_injury_history.shape()`; verify byte-identical output with `git diff --exit-code data/injury_history.json`.
- [ ] R17-E1-S3-T5 — [BUILD-C] Create `data/contracts/injuries.schema.json`.
- [ ] R17-E1-S3-T6 — [BUILD-C] Add the "every status normalizes" assertion to `tests/smoke.sh`.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::fetch_injuries_raises_on_unmapped` (unit) — Planned
- AC2 → `tests/smoke.sh::injuries_statuses_all_normalize` (smoke) — Planned
- AC3 → `tests/feature/weekly_injury.test.mjs:122-144` (unit, **must stay green unmodified**) — Existing
- AC4 → `tests/feature/history_contract.test.mjs` + `git diff --exit-code data/injury_history.json` in `tests/smoke.sh` (unit + smoke) — Existing/Planned
- AC5 → `scripts/validate_data.py::check_injuries_schema` (data) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test), smoke, data(validate_data).

**Traceability:** `scripts/scrape/espn.py`, `scripts/build_injury_history.py`,
`data/injuries.json`, `data/contracts/injuries.schema.json`, `tests/smoke.sh`.

---

## EPIC R17-E2 · Season-long absence actually costs season points
**Owner:** BUILD-A
**Fixes:** F1 (IR & suspension get no haircut), F2 (no concept of multi-week absence)
**Status:** 🔴 Not started

### Goal
Split the two mechanics that are currently welded together. **Week-shaping** (a
Questionable tag reshapes the curve, season total preserved) is correct today and must not
move a decimal. **Unavailability** (IR / PUP / NFI / suspension / a parsed duration) must
actually *remove* points from the season total instead of renormalizing them back in.

### Why it matters
This is F2 in one sentence: a player who will not take a snap in 2026 currently carries
100% of his season projection, because `player_weeks()` applies the injury multiplier to
the first three non-bye weeks and then rescales the remaining weeks to hit the season total
exactly. The injury only ever *reshapes* the curve. Every downstream number a manager
trusts — RoS points, RoS VOR, waiver rank, trade value — inherits that lie.

---

### R17-E2-S1 — "My RB2 lands on IR in week 3" · Est: L
**As** a Manager whose RB2 tore an ACL in the Week 3 game **I want** his remaining weeks to
go to zero and his season total to actually drop **so that** when I look at RoS points on
Tuesday I see what he's really worth to me — not a full-season number that pretends the
injury never happened.

**Acceptance criteria** (Given/When/Then):
- **R17-E2-S1-AC1 — "my RB2 lands on IR in week 3"** — Given a player with a 200.0 season
  projection, a Week 9 bye (17 non-bye weeks), and `unavailable_weeks=4, first_week=3`,
  When `player_weeks()` runs, Then weeks 1–2 keep non-zero points, weeks **3, 4, 5, 6** are
  exactly `0.0` and carry `avail: false`, and the non-bye sum equals
  `200.0 × 13/17 = 152.94` within `±0.1` — i.e. **the season total dropped by ~47 points
  and was not renormalized away**.
- **R17-E2-S1-AC2** — Given `out_for_season: true`, When `player_weeks()` runs, Then
  **every** non-bye week from `first_week` onward is exactly `0.0` and the non-bye sum for
  a Week-1 designation is exactly `0`.
- **R17-E2-S1-AC3 — the no-op proof** — Given `unavailable_weeks=0` (the default), When
  `player_weeks()` runs, Then the output is **numerically identical to today, path for
  path**, for all 300 committed players. `tests/feature/weekly_injury.test.mjs:69` and
  `:146` (season total preserved to `1e-6`) must stay green **unmodified**; if either goes
  red, the implementation is wrong — **do not "fix" the test**.
- **R17-E2-S1-AC4 — shaping is applied only to weeks he can play** — Given a player who is
  `unavailable_weeks=4` **and** carries a week-class multiplier, When the split runs, Then
  the multiplier lands on the first three entries of the **available** list, not on blocked
  weeks he was never going to play.
- **R17-E2-S1-AC5** — Given duplicate feed rows for one player, When `unavailability()`
  resolves them, Then the **worst** wins: `out_for_season` beats any count, otherwise the
  larger `weeks_out`.
- **R17-E2-S1-AC6 — the committed diff** — Given `data/player_weekly.json` after
  regeneration, When `git diff --stat` is inspected, Then exactly **one** player's weeks
  changed — `espn-4428209` Ricky Pearsall — with weeks 1–4 → `0.0` + `"avail": false`,
  target `67.75`, rounded sum **67.73**, `season_points_lost` **20.87**, and surviving
  weeks `4.45, 5.63, 5.16, [bye], 5.98, 5.33, 5.19, 4.63, 5.41, 4.84, 4.97, 5.32, 5.22,
  5.60`. Any other changed hunk is a regeneration bug, not an improvement.
- **R17-E2-S1-AC7** — Given `scripts/build_weekly.py`'s module docstring, When read after
  the change, Then the sentence *"the season projection is the honest prior; injuries shift
  shape, never total"* is **gone** — it is false for class `season` and would be a lie left
  in the file.

**Tasks:**
- [ ] R17-E2-S1-T1 — Extend `player_weeks()` with `unavailable_weeks=0, first_week=1` (int shape, C9-settled).
- [ ] R17-E2-S1-T2 — Implement the partition step: `blocked` = first `N` non-bye rows with `wk >= first_week`; `available` = the rest, order preserved.
- [ ] R17-E2-S1-T3 — Move week-shaping to apply to the first `INJURY_WEEKS` entries of `available` only.
- [ ] R17-E2-S1-T4 — Implement `TARGET = season_proj * len(available) / n_total` (0.0 when `n_total == 0`).
- [ ] R17-E2-S1-T5 — Renormalize `available` to `TARGET`; set `blocked` rows to `0.0` and **exclude** them from the scale.
- [ ] R17-E2-S1-T6 — Implement `unavailability(projections, injuries)` joining on `(team, _norm_name(player))` with worst-wins dedupe.
- [ ] R17-E2-S1-T7 — Emit `players[].availability` and `weeks[].avail: false` (emitted only when `false`) per SOLUTION_DESIGN §2.
- [ ] R17-E2-S1-T8 — Emit `model.availability {applied, vocab_version, unavailable, season_ending, min_weeks_rule, season_points_removed}`, only when ≥1 player is season-class.
- [ ] R17-E2-S1-T9 — Rewrite the module docstring at `scripts/build_weekly.py:20-28`.
- [ ] R17-E2-S1-T10 — Regenerate `data/player_weekly.json` via the uniform-rescale derivation (SOLUTION_DESIGN §9.1) — **no network, no 300-row churn**.
- [ ] R17-E2-S1-T11 — Update `data/contracts/player_weekly.schema.json` (`additionalProperties: false` on all three objects) **in the same commit** as the data.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::rb2_lands_on_ir_week_3` (unit) — Planned
- AC2 → `tests/feature/availability.test.mjs::out_for_season_zeroes_everything` (unit) — Planned
- AC3 → `tests/feature/weekly_injury.test.mjs:69,146` (unit, **unmodified**) — Existing
- AC4 → `tests/feature/availability.test.mjs::shaping_skips_blocked_weeks` (unit) — Planned
- AC5 → `tests/feature/availability.test.mjs::duplicate_rows_worst_wins` (unit) — Planned
- AC6 → `tests/feature/weekly_contract.test.mjs::availability_adjusted_season_sum` + `scripts/validate_data.py::check_weekly_availability` (unit + data) — Planned
- AC7 → `tests/feature/availability.test.mjs::docstring_no_longer_claims_total_preserved` (unit, source-text assertion) — Planned
- **Coverage: 7/7 = 100%.** Types: unit(node:test), data(validate_data).

**Traceability:** `scripts/build_weekly.py`, `data/player_weekly.json`,
`data/contracts/player_weekly.schema.json`, `tests/feature/weekly_contract.test.mjs`.

---

### R17-E2-S2 — "A WR is on PUP to start the season and returns week 7" · Est: M
**As** a Manager holding a PUP-listed WR in an IR-stash slot **I want** weeks 1–6 to read
zero and week 7 onward to read normal points **so that** I can plan the stash: I know
exactly which week he becomes startable and I'm not paying a roster spot on a number that
pretends he's playing Week 1.

**Acceptance criteria** (Given/When/Then):
- **R17-E2-S2-AC1 — "a WR is on PUP to start the season and returns week 7"** — Given a WR
  with status `PUP` and a parsed `weeks_out: 6`, When the split runs, Then weeks **1–6**
  are exactly `0.0` with `avail: false`, week **7 onward** carries normal (rescaled)
  points, and the non-bye sum equals `season × 11/17` within `±0.1` for a player with one
  bye.
- **R17-E2-S2-AC2** — Given that same player, When the Week 7 Lineup is painted, Then he
  carries **no chip**, is fully startable, and the optimizer treats him identically to any
  healthy player — the return is automatic, with no manual clearing step.
- **R17-E2-S2-AC3** — Given status `NFI` with a parsed duration, When the split runs, Then
  it behaves identically to `PUP` (same class, same blocking), and the chip reads `NFI`,
  not `PUP` — the label is distinct because the return rules differ.
- **R17-E2-S2-AC4** — Given `PUP` or `NFI` with **no** parsed duration, When the split
  runs, Then the `MIN_WEEKS_OUT = 4` floor applies with `confidence: "rule"` (see
  R17-E2-S5), never a guessed larger number.
- **R17-E2-S2-AC5** — Given no feed currently emits `PUP` or `NFI`, When these paths are
  tested, Then they are covered by **fixtures**, and the story explicitly does not claim a
  live row. (C6: fixture coverage is the honest form here.)

**Tasks:**
- [ ] R17-E2-S2-T1 — Add PUP/NFI fixtures to `tests/feature/availability.test.mjs` (week-1 start, 6-week duration, return week).
- [ ] R17-E2-S2-T2 — Verify the `first_week=1` path blocks exactly `raw[:6]`.
- [ ] R17-E2-S2-T3 — Verify `avail` is **absent** (not `true`) on weeks 7+, keeping the committed diff minimal.
- [ ] R17-E2-S2-T4 — Assert PUP and NFI produce distinct `status` codes on the player block.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::pup_start_of_season_returns_week_7` (unit) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::returned_player_has_no_chip_and_is_startable` (unit) — Planned
- AC3 → `tests/feature/availability.test.mjs::nfi_matches_pup_mechanic_distinct_label` (unit) — Planned
- AC4 → `tests/feature/availability.test.mjs::pup_without_duration_uses_rule_floor` (unit) — Planned
- AC5 → `tests/feature/availability.test.mjs` fixture block (unit) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test).

**Traceability:** `scripts/build_weekly.py`, `scripts/availability.py`, `app/availability.js`.

---

### R17-E2-S3 — "A suspended player misses 6 games" · Est: M
**As** a Manager who drafted a suspended player at a discount **I want** his suspended
weeks to read zero and his season total to reflect only the games he'll actually play
**so that** I can decide whether he's worth a bench spot through the suspension — and
**so that** when nobody has reported the length yet, the app says so instead of picking a
number.

**Acceptance criteria** (Given/When/Then):
- **R17-E2-S3-AC1 — "a suspended player misses 6 games"** — Given a player with status
  `SUSPENDED` and a parsed `weeks_out: 6`, When the split runs, Then weeks **1–6** are
  `0.0` with `avail: false`, the non-bye sum equals `season × 11/17` within `±0.1`, and
  `season_points_lost` is emitted as the difference.
- **R17-E2-S3-AC2 — the live 3-game case** — Given CHI Beanie Bishop Jr. (`Suspension`,
  *"set to miss the first three games of the 2026 regular season"*), When enriched, Then
  `weeks_out: 3`, `confidence: "explicit"`, weeks 1–3 blocked, **week 4 onward normal** —
  so a Week 4 lineup starts him again with no chip. That is exactly what a manager expects
  and exactly what the current build cannot produce. (He is not in the top 300, so this is
  a **fixture/pipeline** AC, not a UI screenshot — C6.)
- **R17-E2-S3-AC3 — unknown length stays visibly unknown** — Given status `SUSPENDED` with
  **no** parsed duration, When the split runs, Then `unavailable_weeks == 0` — **nothing is
  zeroed** — and the player is still **flagged** with `class: "season"`, `status:
  "SUSPENDED"`, `weeks_out: null`. There is no league rule minimum for suspensions, so the
  `MIN_WEEKS_OUT` floor must **not** be applied here. Honest data beats a convenient guess.
- **R17-E2-S3-AC4** — Given that same unknown-length suspended player, When the Lineup is
  painted, Then he is still **playable** (the chip is how the app tells the manager; the
  start/sit call is the manager's), and the chip reads `⊘ SUSP` with **no** duration text.

**Tasks:**
- [ ] R17-E2-S3-T1 — Wire `SUSPENDED` + parsed duration → blocked weeks in `unavailability()`.
- [ ] R17-E2-S3-T2 — Wire `SUSPENDED` + null duration → `unavailable_weeks = 0`, flagged only, **no** season block that zeroes weeks.
- [ ] R17-E2-S3-T3 — Add the Bishop row as a real-corpus fixture asserting `weeks_out: 3, confidence: "explicit"`.
- [ ] R17-E2-S3-T4 — Assert `availabilityOf()` returns `playable: true` for unknown-length `SUSPENDED`.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::suspended_six_games` (unit) — Planned
- AC2 → `tests/feature/availability.test.mjs::bishop_three_game_suspension` (unit) — Planned
- AC3 → `tests/feature/availability.test.mjs::suspension_unknown_length_zeroes_nothing` (unit) — Planned
- AC4 → `tests/feature/availability_app.test.mjs::unknown_suspension_stays_playable` (unit) — Planned
- **Coverage: 4/4 = 100%.** Types: unit(node:test).

**Traceability:** `scripts/build_weekly.py`, `scripts/injury_duration.py`, `app/availability.js`.

---

### R17-E2-S4 — "A starter is Questionable on Sunday morning" — behaviour unchanged · Est: S
**As** a Manager staring at a Q tag ninety minutes before kickoff **I want** the app to keep
doing exactly what it does today — shade his next few weeks, keep his season total intact,
and leave the start/sit call to me **so that** this release fixes the season-long hole
without quietly changing the short-term numbers I already trust.

**Acceptance criteria** (Given/When/Then):
- **R17-E2-S4-AC1 — "a starter is Questionable on Sunday morning"** — Given a player with
  ESPN status `Questionable`, When the split runs, Then the `0.9` multiplier is applied to
  the first three non-bye weeks and the non-bye sum still equals his season projection to
  **`1e-6`** — season total preserved, exactly as today.
- **R17-E2-S4-AC2** — Given `INJURY_MULT`, When inspected, Then it is **byte-identical** to
  `{"Out": 0.55, "Doubtful": 0.7, "Questionable": 0.9}` and
  `tests/feature/weekly_injury.test.mjs:61` passes **unmodified**.
- **R17-E2-S4-AC3** — Given `injury_multipliers()`, When called, Then its contract and its
  `weekly_injury.test.mjs:107` lock are unchanged: `"Active"` normalizes to `ACTIVE` →
  `1.0` → is dropped from the map, exactly as today. Internally it may look up through a
  derived `INJURY_MULT_CANON`, but the literal table must not change.
- **R17-E2-S4-AC4** — Given a `QUESTIONABLE` or `DOUBTFUL` player, When
  `availabilityOf()` is called, Then `playable === true`, `tone === "watch"`, and **no**
  `avail: false` is written on any week. The optimizer will still start him if he's the
  best option — the chip is information, not a decision.
- **R17-E2-S4-AC5** — Given an `OUT` player, When `availabilityOf(row, wk, currentWk)` is
  called with `wk === currentWk`, Then `playable === false` for **that week only** — an
  `OUT` designation is this-week news and zeroes nothing in the split. For any other week
  he is playable.
- **R17-E2-S4-AC6** — Given the nine week-class players already inside the top 300, When
  `player_weekly.json` is regenerated, Then each gains only a **two-key**
  `availability: {status, class: "week"}` block, their week values are unchanged, and
  `model.injury_shape` stays `{applied: true, statuses_used: 9}` — the same shape as today.

**Tasks:**
- [ ] R17-E2-S4-T1 — Derive `INJURY_MULT_CANON` from `INJURY_MULT` + `normalize_status` without editing the literal table.
- [ ] R17-E2-S4-T2 — Emit the two-key `availability` block for week-class players.
- [ ] R17-E2-S4-T3 — Implement the `OUT && wk === currentWk` rule in `app/availability.js`.
- [ ] R17-E2-S4-T4 — Run all five `weekly_injury.test.mjs` cases unmodified and record them as the regression proof.

**QA coverage:**
- AC1 → `tests/feature/weekly_injury.test.mjs:69` (unit, **unmodified**) — Existing
- AC2 → `tests/feature/weekly_injury.test.mjs:61` (unit, **unmodified**) — Existing
- AC3 → `tests/feature/weekly_injury.test.mjs:107` (unit, **unmodified**) — Existing
- AC4 → `tests/feature/availability_app.test.mjs::questionable_is_playable_watch_tone` (unit) — Planned
- AC5 → `tests/feature/availability_app.test.mjs::out_blocks_current_week_only` (unit) — Planned
- AC6 → `tests/feature/weekly_contract.test.mjs::week_class_players_keep_their_values` (unit) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test).

**Traceability:** `scripts/build_weekly.py`, `app/availability.js`, `tests/feature/weekly_injury.test.mjs`.

---

### R17-E2-S5 — The league-minimum floor, labelled as a rule and never as a measurement · Est: S
> **Contingent on Open Decision 1 = adopt.** If rejected, this story is cut and the release
> changes nothing on disk.

**As** a Manager looking at an IR player whose beat writer hasn't given a timeline **I want**
the app to apply the four-game league minimum and *tell me that's what it did* **so that** I
get a usable floor for my roster decision without ever mistaking a rule for a report.

**Acceptance criteria** (Given/When/Then):
- **R17-E2-S5-AC1** — Given status `IR`, `PUP` or `NFI` with `weeks_out: null` and
  `out_for_season: false`, When the split runs, Then `unavailable_weeks == 4` and the
  player block carries `confidence: "rule"`, `weeks_out: 4`, `evidence: null`.
- **R17-E2-S5-AC2** — Given `confidence: "rule"`, When rendered, Then the duration text is
  **`4+ WKS`** (the `+` is load-bearing), the provenance tag is **`LEAGUE MIN`**, and the
  swap-note prose reads *"…out **at least** 4 more weeks"*. A `rule` value must never
  render as a bare `4 WKS` or carry a `REPORT` tag.
- **R17-E2-S5-AC3** — Given `confidence: "rule"`, When Compare renders the column, Then
  there is **no** evidence block — there is no report to quote, and `LEAGUE MIN` already
  says so.
- **R17-E2-S5-AC4 — the live row** — Given SF Ricky Pearsall (`espn-4428209`), When the
  Lineup or Compare screen renders him, Then his chip reads `⊘ IR · 4+ WKS` with a
  `LEAGUE MIN` tag, and his RoS points reflect the reduced weekly sum. He is the **only**
  season-class player in the app today, so this is the release's single live UI
  reproduction.
- **R17-E2-S5-AC5** — Given `confidence: "explicit"`, When rendered, Then the text is
  `{N} WKS` / `SEASON` with a `REPORT` tag and the prose reads *"out {N} more weeks"* — no
  `at least`. The word choice carries the provenance in prose, so the sentence stays honest
  when a narrow phone has hidden the tag.

**Tasks:**
- [ ] R17-E2-S5-T1 — Apply `MIN_WEEKS_OUT = 4` for `{IR, PUP, NFI}` with a null duration; stamp `confidence: "rule"`.
- [ ] R17-E2-S5-T2 — Keep `injuries.json`'s `confidence` as `"explicit" | null` only — the rule floor is a `build_weekly` decision (it depends on the schedule) and surfaces only on `player_weekly.json`.
- [ ] R17-E2-S5-T3 — Implement `durText` / `provText` / `phrase` provenance branches in `app/availability.js`.
- [ ] R17-E2-S5-T4 — Assert the Pearsall chip text end-to-end.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::ir_null_duration_uses_four_week_floor` (unit) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::rule_confidence_renders_plus_and_league_min` (unit) — Planned
- AC3 → `tests/feature/availability_app.test.mjs::rule_confidence_has_no_evidence_block` (unit) — Planned
- AC4 → `tests/web/web.spec.mjs::pearsall_chip_reads_ir_4plus_league_min` (e2e) — Planned
- AC5 → `tests/feature/availability_app.test.mjs::explicit_confidence_renders_report` (unit) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test), e2e(playwright).

**Traceability:** `scripts/availability.py`, `scripts/build_weekly.py`, `app/availability.js`.

---

## EPIC R17-E3 · Lineup never auto-starts a player who can't play
**Owner:** BUILD-B
**Fixes:** F3 (lineup optimizer ignores availability)
**Status:** 🔴 Not started

### Goal
`app/views/lineup.js` builds its rows from weekly points and bye only. Nothing reads
availability, so the optimizer will happily slot an IR player into WR2 and print
*"✓ Your starting lineup is already optimal"* over him. Fix it by **demotion, not skip**:
an unavailable row ranks below every available row for the same slot; if no alternative
exists the slot is still filled and a warning fires.

### Why it matters
This is the defect a manager actually loses a week to. It is also the one place where the
"skip" design would have made things worse: skipping leaves `— no eligible player —` where
a manager needed to be told *why*, and it makes the forced-start banner unreachable dead UI.

---

### R17-E3-S1 — An available bench player always beats an unavailable starter · Est: M
**As** a Manager setting my Week 5 lineup **I want** the optimizer to bench my IR'd WR and
start whoever is actually suiting up **so that** I never lose a matchup to a zero I could
have seen on Sunday morning.

**Acceptance criteria** (Given/When/Then):
- **R17-E3-S1-AC1 — the F3 defect, asserted directly** — Given a roster where an
  unavailable WR projects **12.4** and an available WR projects **4.0**, When `bestLineup`
  runs, Then the **4.0 player is started** and the 12.4 player is benched. The per-position
  sort key is `(p.playable === false ? 1 : 0, -pts, id)`.
- **R17-E3-S1-AC2 — the FLEX trap** — Given the same pair competing for FLEX, When the FLEX
  scan runs, Then it compares on the **same tuple**, not on `pts` alone. A partially-parsed
  `weeks_out` player can still carry points in a week he cannot play, so a `pts`-only FLEX
  scan silently reintroduces F3 in one slot.
- **R17-E3-S1-AC3 — the wiring trap** — Given `app/views/lineup.js:107` and `:111`, When
  rows are mapped down before being passed on, Then `playable` is included in the objects
  passed to **both** `bestLineup` **and** `startSitSwaps`. Adding it to only one is a
  silent no-op that leaves F3 half-fixed and still passes a naive unit test.
- **R17-E3-S1-AC4 — strict `=== false`** — Given any row that does **not** set `playable`,
  When `bestLineup` runs, Then behaviour is **exactly** as today. All five cases in
  `tests/feature/lineup.test.mjs` (none of which set `playable`) stay green **unmodified**.
- **R17-E3-S1-AC5** — Given `startSitSwaps`, When it returns, Then `moves.start` **can
  never contain an unavailable id while an available alternative exists** — the literal F3
  defect, with its own dedicated assertion.
- **R17-E3-S1-AC6** — Given a blocked week, When `playerRow()` computes points, Then
  `pts = (onBye || a.playable === false) ? 0 : …`, mirroring the existing bye line at
  `app/views/lineup.js:100`, so the displayed row and the card total can never disagree.

**Tasks:**
- [ ] R17-E3-S1-T1 — Create `app/availability.js` (pure, no DOM, no fetch at import) exporting `AVAIL_CODES` and `availabilityOf(weeklyPlayerRow, wk, currentWk)`.
- [ ] R17-E3-S1-T2 — Implement `playable === false` iff `weeks[wk].avail === false` **or** (`status === 'OUT'` and `wk === currentWk`).
- [ ] R17-E3-S1-T3 — Implement `label` / `tone` / `durText` / `provText` / `phrase` per the UX table; absent availability → `playable: true`, `label: ''` (byte-identical render).
- [ ] R17-E3-S1-T4 — Add the demotion term to `bestLineup`'s per-position sort key with strict `=== false`.
- [ ] R17-E3-S1-T5 — Update the FLEX scan to compare on the full tuple.
- [ ] R17-E3-S1-T6 — Thread `playable` through the row maps at `views/lineup.js:107` **and** `:111`.
- [ ] R17-E3-S1-T7 — Add the availability-aware `pts` line to `playerRow()`.
- [ ] R17-E3-S1-T8 — Create `tests/feature/availability_app.test.mjs`.

**QA coverage:**
- AC1 → `tests/feature/availability_app.test.mjs::available_4pt_beats_unavailable_12pt` (unit) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::flex_scan_uses_playable_tuple` (unit) — Planned
- AC3 → `tests/feature/availability_app.test.mjs::playable_threaded_to_both_call_sites` (unit) — Planned
- AC4 → `tests/feature/lineup.test.mjs` all five (unit, **unmodified**) — Existing
- AC5 → `tests/feature/availability_app.test.mjs::start_sit_never_starts_unavailable` (unit) — Planned
- AC6 → `tests/feature/availability_app.test.mjs::blocked_week_row_shows_zero` (unit) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test).

**Traceability:** `app/availability.js`, `app/lineup.js`, `app/views/lineup.js`.

---

### R17-E3-S2 — "Both my RBs are hurt" — a forced start is loud, never silent · Est: M
**As** a Manager whose only two RBs are both on IR **I want** the app to fill RB2 anyway
and tell me it had to **so that** I go hit the waiver wire instead of trusting a green
checkmark that says my lineup is optimal.

**Acceptance criteria** (Given/When/Then):
- **R17-E3-S2-AC1 — "both my RBs are on IR" (forced start)** — Given a 12-team roster whose
  only two RB-eligible players are both unavailable, When `bestLineup` runs, Then RB2 is
  **filled** by an unavailable player (never left empty, never silent) and
  `warnings: [{slot, id, reason}]` contains an entry for that slot.
- **R17-E3-S2-AC2 — the "already optimal" lie** — Given `optimal.warnings.length > 0`, When
  the START/SIT card renders, Then the `✓ Your starting lineup is already optimal` line is
  **suppressed** and replaced by the `.lu-gap` message. Printing "optimal" over a lineup
  containing a player who cannot play is a lie and fails this AC.
- **R17-E3-S2-AC3 — the Playwright lock** — Given that replacement element, When rendered,
  Then it carries `class="lu-optimal lu-gap"` — **not `lu-gap` alone** — so
  `tests/web/web.spec.mjs:1238` (`.lu-move, .lu-optimal` count ≥ 1) stays green
  **unmodified**. Dropping `lu-optimal` breaks a lock with no obvious connection to the
  change that caused it.
- **R17-E3-S2-AC4 — the 7-row lock** — Given any roster, When the Lineup paints, Then there
  are still exactly **7** `.lu-row` starter rows (`web.spec.mjs:1234`). Demotion guarantees
  a slot is filled or falls to the existing `— no eligible player —` branch, which already
  emits a `.lu-row`. Neither `.lu-forced` nor `.lu-swapnote` may be a `.lu-row`.
- **R17-E3-S2-AC5** — Given a forced start, When rendered, Then the row carries
  `.lu-row--forced` (3 px `--accent` left border — it **does not** recede) and a
  `.lu-forced` banner fires, while merely-unavailable **bench** rows carry
  `.lu-row--unavail { opacity: .72 }`.
- **R17-E3-S2-AC6** — Given `bestLineup`'s return value, When inspected, Then `warnings` is
  **additive**: existing assertions on `slots`, `bench` and `total` are untouched and stay
  green.

**Tasks:**
- [ ] R17-E3-S2-T1 — Add `warnings: [{slot, id, reason}]` to `bestLineup`'s return value.
- [ ] R17-E3-S2-T2 — Gate the `✓ already optimal` branch on `moves.start.length === 0 && optimal.warnings.length === 0`.
- [ ] R17-E3-S2-T3 — Render the `.lu-gap` replacement with the `lu-optimal lu-gap` class pair.
- [ ] R17-E3-S2-T4 — Add `.lu-row--forced` / `.lu-forced` / `.lu-row--unavail` rendering.
- [ ] R17-E3-S2-T5 — Append (do **not** modify) new cases to `tests/web/web.spec.mjs`.

**QA coverage:**
- AC1 → `tests/feature/availability_app.test.mjs::forced_start_fills_and_warns` (unit) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::already_optimal_suppressed_on_warning` (unit) — Planned
- AC3 → `tests/web/web.spec.mjs:1238` (e2e, **unmodified**) + `::lu_gap_keeps_lu_optimal_class` (e2e) — Existing/Planned
- AC4 → `tests/web/web.spec.mjs:1234` (e2e, **unmodified**) — Existing
- AC5 → `tests/web/web.spec.mjs::forced_row_and_banner_render` (e2e) — Planned
- AC6 → `tests/feature/lineup.test.mjs` all five (unit, **unmodified**) — Existing
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(playwright).

**Traceability:** `app/lineup.js`, `app/views/lineup.js`, `app/theme.css`, `tests/web/web.spec.mjs`.

---

### R17-E3-S3 — Tell me *why* the lineup changed, in fantasy English · Est: S
**As** a Manager reading START / SIT MOVES **I want** the reason before the points **so
that** I understand the swap is "he's hurt", not "the model nudged 0.3" — and I can sanity-
check it against what I already know.

**Acceptance criteria** (Given/When/Then):
- **R17-E3-S3-AC1** — Given an unavailability-caused swap, When the START/SIT card renders,
  Then a `.lu-swapnote` row appears **above** the net-gain line, one per swap: availability
  is *why*, points are *how much*, and the reason comes first.
- **R17-E3-S3-AC2** — Given the template `{OUT_NAME} is {PHRASE} — {IN_NAME} starts at
  {SLOT} instead.`, When rendered for Pearsall, Then it reads *"Ricky Pearsall is on IR,
  out **at least** 4 more weeks — Jauan Jennings starts at WR2 instead."*
- **R17-E3-S3-AC3** — Given each code, When `phrase` is generated, Then it uses the
  fantasy-natural wording, **never the raw enum**: `IR` → *is on IR* / *is on IR for the
  season* / *is on IR, out at least {N} more weeks*; `PUP` → *is on the PUP list*; `NFI` →
  *is on the NFI list*; `SUSPENDED` → *is suspended* / *is suspended for {N} more weeks*;
  `OUT` → *is ruled out this week*.
- **R17-E3-S3-AC4** — Given the chip, When rendered, Then meaning survives with colour
  removed (`⊘ IR · SEASON` states it in glyph **and** text), every glyph is
  `aria-hidden="true"`, and every abbreviation carries a spelled-out `title`
  (`IR` → "Injured Reserve").
- **R17-E3-S3-AC5** — Given `app/theme.css`, When the new classes land, Then they are the
  shared `.av-chip` family (`--out` / `--watch` / `--sm`, `.av-glyph`, `.av-dur`,
  `.av-prov --report/--min`) — and **neither `.lu-avail` nor `.lu-unavail` is created**, so
  Compare can reuse the identical component. No new tokens, fonts or breakpoints.
- **R17-E3-S3-AC6** — Given the six new colour pairings, When
  `tests/feature/contrast_aa.test.mjs` runs, Then every one is ≥ 4.5:1, and **`--accent` is
  never used as chip text** (4.28:1 on `--surface-2`, 3.96:1 on `--elev` — border graphic
  only).

**Tasks:**
- [ ] R17-E3-S3-T1 — Implement `phrase` in `app/availability.js` per the UX §4.4 table, verbatim.
- [ ] R17-E3-S3-T2 — Render `.lu-swapnote` rows above the net-gain line.
- [ ] R17-E3-S3-T3 — Add `renderAvailChip` to `app/render.js`, beside `renderTrendChip` / `renderSos`.
- [ ] R17-E3-S3-T4 — Add the `.av-chip` family to `app/theme.css`.
- [ ] R17-E3-S3-T5 — Add `title` attributes and `aria-hidden` glyphs.
- [ ] R17-E3-S3-T6 — Add the six pairings to `tests/feature/contrast_aa.test.mjs`.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::swapnote_renders_above_net_gain` (e2e) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::swapnote_template_pearsall` (unit) — Planned
- AC3 → `tests/feature/availability_app.test.mjs::phrase_table_per_code` (unit) — Planned
- AC4 → `tests/feature/availability_app.test.mjs::chip_meaning_survives_colour_removal` (unit) — Planned
- AC5 → `tests/feature/availability_app.test.mjs::shared_av_chip_no_lu_prefixed_class` (unit, CSS-text assertion) — Planned
- AC6 → `tests/feature/contrast_aa.test.mjs` (+6 rows) (unit) — Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), e2e(playwright).

**Traceability:** `app/availability.js`, `app/render.js`, `app/theme.css`,
`tests/feature/contrast_aa.test.mjs`.

---

## EPIC R17-E4 · Compare shows availability, duration and where it came from
**Owner:** BUILD-B
**Fixes:** F5 (visible half) + F3's Compare sibling
**Status:** 🔴 Not started

### Goal
`app/views/compare.js` shows no availability at all, so two players can be compared purely
on projected points while one of them is on IR. Add an `AVAILABILITY` row, quote the beat
report when we actually have one, and explain in one line why `PROJ PTS` still reads like a
healthy season.

### Why it matters
Compare is the trade/waiver screen. Comparing a healthy WR to an IR'd WR on season points
with no availability row is the single most misleading view in the app, and the fix also
retires F5 by finally rendering the sentence we've been storing and ignoring.

---

### R17-E4-S1 — Availability sits above PROJ PTS, in both columns · Est: M
**As** a Manager deciding whether to trade for a guy **I want** his availability on the same
card as his points **so that** I don't send an offer for somebody who's on IR.

**Acceptance criteria** (Given/When/Then):
- **R17-E4-S1-AC1** — Given any two compared players, When the card renders, Then an
  `AVAILABILITY` row appears **above** `PROJ PTS` in **both** columns — always rendered in
  both, so the centre rail stays row-aligned.
- **R17-E4-S1-AC2** — Given an available player, When his `AVAILABILITY` cell renders, Then
  it shows plain **muted `ACTIVE` text, not a chip**. A green badge on 673 of 800 players
  is noise that trains managers to stop reading chips.
- **R17-E4-S1-AC3** — Given an unavailable player, When his cell renders, Then it shows the
  identical shared `.av-chip` used on Lineup, plus the centre edge chip per the UX spec.
- **R17-E4-S1-AC4 — one carrier, no second fetch** — Given the app needs availability, When
  it reads it, Then it comes **only** from `data/player_weekly.json` (which all four
  consuming views already fetch). There is **no** `getInjuries` in `app/data.js`, no new
  fetch, no new cache entry — two client carriers for one fact is the drift failure this
  release exists to fix.

**Tasks:**
- [ ] R17-E4-S1-T1 — Add `avail: availabilityOf(w, currentWk, currentWk)` to `metricsFor()`.
- [ ] R17-E4-S1-T2 — Render the `AVAILABILITY` row above `PROJ PTS` in both columns with `.cmp-metric--avail`.
- [ ] R17-E4-S1-T3 — Render plain muted `ACTIVE` for available players; `.av-chip` otherwise.
- [ ] R17-E4-S1-T4 — Verify no new fetch/getter/cache entry is introduced (`app/data.js` untouched).

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::compare_availability_row_above_proj` (e2e) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::compare_active_renders_plain_text` (unit) — Planned
- AC3 → `tests/feature/availability_app.test.mjs::compare_reuses_shared_chip` (unit) — Planned
- AC4 → `tests/feature/availability_app.test.mjs::no_second_availability_carrier` (unit, source assertion) — Planned
- **Coverage: 4/4 = 100%.** Types: unit(node:test), e2e(playwright).

**Traceability:** `app/views/compare.js`, `app/availability.js`, `app/data.js` (must stay unchanged).

---

### R17-E4-S2 — Quote the report, never paraphrase it, and only when there is one · Est: S
**As** a Manager **I want** to read the actual sentence the beat writer wrote **so that** I
can judge the source myself instead of trusting a number the app derived from it.

**Acceptance criteria** (Given/When/Then):
- **R17-E4-S2-AC1** — Given `confidence === "explicit"`, When the Compare column renders,
  Then the `evidence` sentence appears in `.cmp-evid` at the foot of the column, **in
  quotes, clamped to 3 lines, never paraphrased**, with a `REPORT` provenance tag.
- **R17-E4-S2-AC2** — Given `confidence === "rule"`, When the column renders, Then there is
  **no** `.cmp-evid` block at all — there is nothing to quote, and `LEAGUE MIN` already
  says where the 4 came from.
- **R17-E4-S2-AC3 — honest scope, stated up front** — Given today's data, When this story is
  QA'd, Then it is verified by **fixtures only**: `evidence` and the `REPORT` tag have **no
  live row** in the app, because the 11 players carrying explicit parsed durations are
  outside the top 300. Brazzell (R1) and Bishop (R3) are **not in
  `data/player_projections.json`** and never render on Lineup or Compare. A QA agent
  chasing a screenshot of these will burn a cycle — do not plan one.
- **R17-E4-S2-AC4** — Given `evidence` is present, When it is written to
  `player_weekly.json`, Then it rides on **that** file (not `injuries.json`), consistent
  with the single-carrier rule.

**Tasks:**
- [ ] R17-E4-S2-T1 — Render `.cmp-evid` / `.cmp-evid-lbl` gated strictly on `confidence === "explicit"`.
- [ ] R17-E4-S2-T2 — Apply the 3-line clamp and quotation marks in CSS/markup.
- [ ] R17-E4-S2-T3 — Build a fixture `player_weekly` row carrying an explicit `evidence` string for the unit test.
- [ ] R17-E4-S2-T4 — Add a note to the story/QA sheet that R1/R3 are fixture-only (C6).

**QA coverage:**
- AC1 → `tests/feature/availability_app.test.mjs::explicit_confidence_renders_evidence_quote` (unit, fixture) — Planned
- AC2 → `tests/feature/availability_app.test.mjs::rule_confidence_omits_evidence` (unit, fixture) — Planned
- AC3 → `tests/feature/availability_app.test.mjs` fixture block + documented in `docs/backlog/QA_COVERAGE.md` (unit) — Planned
- AC4 → `scripts/validate_data.py::check_weekly_availability` (data) — Planned
- **Coverage: 4/4 = 100%.** Types: unit(node:test), data(validate_data).

**Traceability:** `app/views/compare.js`, `data/player_weekly.json`.

---

### R17-E4-S3 — Explain why PROJ still looks healthy · Est: S
**As** a Manager seeing `⊘ IR` next to a full-season 88.6 **I want** one line telling me
which number is availability-adjusted **so that** the card reads as designed instead of as
a bug.

**Acceptance criteria** (Given/When/Then):
- **R17-E4-S3-AC1** — Given the `AVAILABILITY` row, When it renders, Then it carries a
  one-line `.cmp-hint`: **"PROJ is a full-season healthy prior — RoS VALUE is the
  availability-adjusted number."**
- **R17-E4-S3-AC2** — Given that claim, When verified, Then it is **true by construction**:
  `rosPoints()` (`app/ros.js:47`) sums the week rows, so it becomes availability-correct
  automatically once the split is fixed. Assert that Pearsall's RoS from week 1 equals the
  reduced weekly sum, not `proj_points`.
- **R17-E4-S3-AC3** — Given `proj_points`, When this release ships, Then it is
  **unchanged** for every player. Haircutting it would re-rank VOR, auction values, ADP
  joins and the draft simulator in one release with no coverage for those interactions
  (Open Decision 2 = adopt). `tests/feature/real_data.test.mjs:45-55`,
  `team_rel2.test.mjs`, `team_vor.test.mjs` and `ros.test.mjs` all stay green
  **unmodified**.
- **R17-E4-S3-AC4** — Given `tests/feature/team_logic.test.mjs:138-149`, When run, Then it
  stays green **unmodified**: `weeklyPoints` rescales by the *proportional* ratio
  `seasonAdj / seasonPpr`, so a reduced weekly sum passes through and PPR↔Standard
  conversion stays correct.
- **R17-E4-S3-AC5 — descope, stated** — Given `app/views/players.js` and
  `app/views/team.js`, When this release ships, Then they gain **no** availability chip and
  **no** legend line — the honesty job moves to this Compare hint. Ranking on
  availability-adjusted points is the Rel18 candidate that makes those surfaces coherent.

**Tasks:**
- [ ] R17-E4-S3-T1 — Add the `.cmp-hint` line to the `AVAILABILITY` row.
- [ ] R17-E4-S3-T2 — Add an assertion that Pearsall's `rosPoints(weeks, 1)` equals the reduced non-bye sum.
- [ ] R17-E4-S3-T3 — Re-run `real_data`, `team_rel2`, `team_vor`, `ros`, `team_logic` unmodified and record as the no-regression proof.
- [ ] R17-E4-S3-T4 — Record the Players/Team descope in `docs/backlog/DECISIONS.md`.

**QA coverage:**
- AC1 → `tests/web/web.spec.mjs::compare_hint_line_present` (e2e) — Planned
- AC2 → `tests/feature/ros.test.mjs::ros_reflects_blocked_weeks` (unit) — Planned
- AC3 → `tests/feature/real_data.test.mjs:45-55` (unit, **unmodified**) — Existing
- AC4 → `tests/feature/team_logic.test.mjs:138-149` (unit, **unmodified**) — Existing
- AC5 → `tests/feature/availability_app.test.mjs::players_and_team_views_unchanged` (unit, source assertion) — Planned
- **Coverage: 5/5 = 100%.** Types: unit(node:test), e2e(playwright).

**Traceability:** `app/views/compare.js`, `app/ros.js`, `docs/backlog/DECISIONS.md`.

---

## EPIC R17-E5 · Preseason: a small, honest, decaying nudge — never a ranking
**Owner:** BUILD-D
**Fixes:** F7 (preseason game data not ingested at all)
**Status:** 🔴 Not started

### Goal
Pull `seasontype=1` (HOF game + PRE1–PRE3), turn it into a **capped ±3%** adjustment that
shrinks with snap count and **decays to exactly zero** after three FINAL regular-season team
games, register it at **weight 0** behind the never-regress gate, and label it so no surface
can show the number without the caveat.

### Why it matters — the owner rule, stated as product
Preseason box scores are **not true performance**. Starters sit or play one series, backups
feast on other backups, and everybody is avoiding contact. A fantasy product that lets a
preseason line move a ranking is worse than one that ignores preseason entirely. So this is
built as a bounded nudge that can be promoted later, not as a signal that ships hot.

---

### R17-E5-S1 — Ingest preseason without touching the regular-season pipeline · Est: M
**As** the System **I want** preseason box scores pulled into their own document **so that**
the signal exists to be evaluated, without putting a new failure mode into the pipeline that
builds every projection.

**Acceptance criteria** (Given/When/Then):
- **R17-E5-S1-AC1** — Given `scripts/build_preseason.py`, When it runs, Then it calls the
  **existing** `espn.fetch_scores` / `espn_gamestats.fetch_final_linescores` with
  `seasontype=1, weeks=range(1, 5)`. **No scraper signature changes** — `seasontype` is
  already a parameter with a default; only the callers hardcode `2`. F7 is smaller than the
  RCA stated.
- **R17-E5-S1-AC2** — Given any preseason game, When ingested, Then it is FINAL-status-gated
  exactly like every other feed in the repo.
- **R17-E5-S1-AC3 — pipeline isolation** — Given `scripts/build_predictions.py`, When this
  story lands, Then it contains **no** call to `build_preseason` and **no** guarded block
  for it. `build_preseason.py` is a standalone runner-built builder in the
  `build_injury_history` / `build_player_usage` mould, and `data/preseason_form.json` joins
  `OPTIONAL_DATA`. This keeps the core pipeline's failure semantics untouched **and** keeps
  `build_predictions.py` a single-owner file, which is what makes the four-agent partition
  actually disjoint.
- **R17-E5-S1-AC4 — names settled** — Given the artefacts, When created, Then they are
  `data/preseason_form.json`, `data/contracts/preseason_form.schema.json` and registry
  signal `preseason_form` (matching the repo's `SCHEMA_TO_DATA` convention). The name
  `preseason_signal.json` is **not** used.

**Tasks:**
- [ ] R17-E5-S1-T1 — Verify and document the `seasontype` pass-through in `scripts/scrape/espn_gamestats.py` (no signature change).
- [ ] R17-E5-S1-T2 — Create `scripts/build_preseason.py` with `seasontype=1, weeks=range(1,5)`.
- [ ] R17-E5-S1-T3 — FINAL-status gate every ingested game.
- [ ] R17-E5-S1-T4 — Create `data/contracts/preseason_form.schema.json`.
- [ ] R17-E5-S1-T5 — [BUILD-C] Add `preseason_form.json` to `OPTIONAL_DATA` in `scripts/validate_data.py`.

**QA coverage:**
- AC1 → `tests/feature/preseason.test.mjs::calls_seasontype_1_without_signature_change` (unit) — Planned
- AC2 → `tests/feature/preseason.test.mjs::final_status_gated` (unit) — Planned
- AC3 → `tests/feature/preseason.test.mjs::build_predictions_untouched` (unit, source assertion) — Planned
- AC4 → `tests/feature/signal_registry.test.mjs::preseason_form_naming` (unit) — Planned
- **Coverage: 4/4 = 100%.** Types: unit(node:test).

**Traceability:** `scripts/build_preseason.py`, `scripts/scrape/espn_gamestats.py`,
`data/preseason_form.json`, `data/contracts/preseason_form.schema.json`.

---

### R17-E5-S2 — "Preseason hero puts up 90 yards against backups" — and moves nothing · Est: L
**As** a Manager **I want** the fourth-string RB who ripped off 90 yards in PRE2 against
other fourth-stringers to **stay** where he belongs in the rankings **so that** I don't draft
a preseason mirage over a proven starter who took three snaps and sat.

**Acceptance criteria** (Given/When/Then):
- **R17-E5-S2-AC1 — "preseason hero puts up 90 yards against backups and must NOT jump the
  rankings"** — Given a player whose preseason PPR-per-game is 5× his prior-season baseline,
  When `adj` is computed, Then `|adj − 1| ≤ 0.03` — the clamp is applied in code, not by
  convention.
- **R17-E5-S2-AC2 — the sitting starter** — Given a proven starter who played **one series**
  (say 8 snaps) and produced nothing, When `adj` is computed, Then
  `sample = min(8/30, 1.0) = 0.267` shrinks the movement to at most `±0.8%`. A backup's
  three-TD preseason cannot outrank a starter who sat.
- **R17-E5-S2-AC3 — measured, not assumed** — Given
  `python3 scripts/build_preseason.py --selftest`, When run against the **real committed**
  `data/player_projections.json` with `adj` applied at **full** strength (weight ignored),
  Then no top-100 player moves more than **±2 ranks within his position**, and the selftest
  exits `0`.
- **R17-E5-S2-AC4 — weight 0, the standing rule** — Given `data/meta.json` and
  `scripts/signals/registry.py`, When `preseason_form` is registered, Then its weight is
  `0.0`, so `applied = 1 + 0 × (adj − 1) = 1.0` and it changes **no number** today.
  `data/player_projections.json` must be **byte-identical** after wiring (verified:
  `project_player` only appends to `signals_used` when `w != 0.0`, and all 300 committed
  rows have `signals_used == []`).
- **R17-E5-S2-AC5** — Given `_interval_band`, When `preseason_form` is present, Then the
  band does **not** widen on it — preseason form is a point estimate, not an uncertainty
  statement.
- **R17-E5-S2-AC6** — Given the signal count, When the registry is updated, Then
  `tests/smoke.sh:75` changes `len(weights) != 32` → `33` **once** (`:66` is the *teams*
  count, not a second occurrence), and `tests/feature/signal_registry.test.mjs` and the
  never-regress gate stay green.

**Tasks:**
- [ ] R17-E5-S2-T1 — Implement `ratio` / `signal` / `sample` / `decay` / `adj` per SOLUTION_DESIGN §6, None-safe.
- [ ] R17-E5-S2-T2 — Clamp to `[1 − 0.03, 1 + 0.03]` in code.
- [ ] R17-E5-S2-T3 — Implement `sample = min(preseason_snaps / 30, 1.0)`.
- [ ] R17-E5-S2-T4 — Write the ±2-rank selftest against the real committed projections at full strength.
- [ ] R17-E5-S2-T5 — [BUILD-C] Register `preseason_form` at weight `0.0` in `scripts/signals/registry.py` + `data/meta.json` + `EXPECTED_SIGNALS`.
- [ ] R17-E5-S2-T6 — [BUILD-C] `compute_raw_signals` gains `adjustments["preseason_form"] = player["preseason_adj"]` when present; `build_predictions` stamps `preseason_adj` from the file when it exists.
- [ ] R17-E5-S2-T7 — [BUILD-C] Assert `_interval_band` does not widen on `preseason_form`.
- [ ] R17-E5-S2-T8 — [BUILD-C] Bump `tests/smoke.sh:75` 32 → 33 (once).
- [ ] R17-E5-S2-T9 — Verify `git diff --exit-code data/player_projections.json` after wiring.

**QA coverage:**
- AC1 → `tests/feature/preseason.test.mjs::adj_clamped_to_three_percent` (unit) — Planned
- AC2 → `tests/feature/preseason.test.mjs::sample_shrinks_one_series_starter` (unit) — Planned
- AC3 → `scripts/build_preseason.py --selftest` via `tests/smoke.sh` (smoke, real-data) — Planned
- AC4 → `tests/feature/signal_registry.test.mjs::preseason_form_weight_zero` + `git diff --exit-code data/player_projections.json` in `tests/smoke.sh` (unit + smoke) — Planned
- AC5 → `tests/feature/preseason.test.mjs::interval_band_not_widened` (unit) — Planned
- AC6 → `tests/feature/never_regress.test.mjs` + `tests/feature/signal_registry.test.mjs` (unit) — Existing/Planned
- **Coverage: 6/6 = 100%.** Types: unit(node:test), smoke.

**Traceability:** `scripts/build_preseason.py`, `scripts/signals/registry.py`,
`data/meta.json`, `scripts/models/player_projection.py`, `tests/smoke.sh`.

---

### R17-E5-S3 — The nudge decays to exactly zero once real games land · Est: S
**As** a Manager in Week 4 **I want** preseason to have completely stopped influencing
anything **so that** August tape never contaminates a rest-of-season decision made off real
football.

**Acceptance criteria** (Given/When/Then):
- **R17-E5-S3-AC1** — Given a player whose team has **3** FINAL regular-season games, When
  `adj` is computed, Then `decay == 0.0` and `adj == 1.0` **exactly** — mechanically, not by
  convention.
- **R17-E5-S3-AC2** — Given team FINAL counts of 0, 1, 2, 3, 4, When `decay` is computed,
  Then it is `1.0, 0.667, 0.333, 0.0, 0.0` — monotonically non-increasing and floored at 0.
- **R17-E5-S3-AC3 — team, not global week** — Given two players on teams with different
  FINAL-game counts in the same calendar week (bye or postponement), When `decay` is
  computed, Then it keys on the **player's team's** FINAL regular-season game count from
  `espn.fetch_final_results(SEASON)`, not a global `current_week - 1`.
- **R17-E5-S3-AC4** — Given `fetch_final_results` is unavailable, When the builder runs,
  Then it writes `{"available": false, "reason": "…"}` rather than **guessing a decay**.

**Tasks:**
- [ ] R17-E5-S3-T1 — Implement `decay = max(0.0, 1.0 - team_regular_finals / 3)`.
- [ ] R17-E5-S3-T2 — Source team FINAL counts from `espn.fetch_final_results(SEASON)`.
- [ ] R17-E5-S3-T3 — Implement the `available: false` degrade path when team finals are unavailable.
- [ ] R17-E5-S3-T4 — Add the decay table test.

**QA coverage:**
- AC1 → `tests/feature/preseason.test.mjs::decay_is_exactly_zero_at_three_finals` (unit) — Planned
- AC2 → `tests/feature/preseason.test.mjs::decay_table` (unit) — Planned
- AC3 → `tests/feature/preseason.test.mjs::decay_keys_on_team_not_global_week` (unit) — Planned
- AC4 → `tests/feature/preseason.test.mjs::no_team_finals_writes_available_false` (unit) — Planned
- **Coverage: 4/4 = 100%.** Types: unit(node:test).

**Traceability:** `scripts/build_preseason.py`, `scripts/scrape/espn.py`.

---

### R17-E5-S4 — No surface can show the preseason number without the caveat · Est: S
**As** a Manager **I want** any preseason-derived number to arrive with the reason it's small
**so that** I never mistake a bounded August nudge for a real projection input.

**Acceptance criteria** (Given/When/Then):
- **R17-E5-S4-AC1** — Given `data/contracts/preseason_form.schema.json`, When validated,
  Then `caveat` is a **required** string — a surface physically cannot read the document
  without it.
- **R17-E5-S4-AC2** — Given the `caveat` value, When read, Then it is exactly: *"Preseason
  snaps are not true performance — starters sit or play a series and everyone is avoiding
  injury. Capped at ±3%, decays to zero after three regular-season games, and currently
  carries weight 0."*
- **R17-E5-S4-AC3 — honest degradation, three distinct reasons** — Given zero preseason
  snaps, Then `adj: 1.0, reason: "no_preseason_snaps"`. Given no prior-season baseline, Then
  `adj: 1.0, reason: "no_baseline"`. Given no preseason window or a down feed, Then the
  **whole document** is `{"available": false, "reason": "…"}`. Never a fabricated value,
  never a stale one.
- **R17-E5-S4-AC4** — Given the document, When written, Then it carries `estimate: true` and
  all three constants (`PRESEASON_CAP`, `MIN_SNAPS`, `DECAY_GAMES`) inline, so the numbers
  are auditable from the file alone.
- **R17-E5-S4-AC5** — Given the file is written from a script, When inspected on disk, Then
  it matches the repo's existing encoding (`ensure_ascii=True`, existing indent) with no
  cosmetic churn.

**Tasks:**
- [ ] R17-E5-S4-T1 — Mark `caveat` required in the schema; add the verbatim string.
- [ ] R17-E5-S4-T2 — Implement the three degrade reasons.
- [ ] R17-E5-S4-T3 — Emit `estimate: true` and the three constants.
- [ ] R17-E5-S4-T4 — Write with `ensure_ascii=True` matching the existing indent.

**QA coverage:**
- AC1 → `scripts/validate_data.py` schema check (data) — Planned
- AC2 → `tests/feature/preseason.test.mjs::caveat_verbatim` (unit) — Planned
- AC3 → `tests/feature/preseason.test.mjs::three_degrade_reasons` (unit) — Planned
- AC4 → `tests/feature/preseason.test.mjs::constants_ride_in_document` (unit) — Planned
- AC5 → `tests/smoke.sh::encoding_ensure_ascii` (smoke) — Existing
- **Coverage: 5/5 = 100%.** Types: unit(node:test), data(validate_data), smoke.

**Traceability:** `data/preseason_form.json`, `data/contracts/preseason_form.schema.json`.

---

## EPIC R17-E6 · The app can never claim an injury no feed backs
**Owner:** BUILD-C (integration, runs **last**)
**Fixes:** the honest-data rule, made mechanical; plus F6's projection-band wiring
**Status:** 🔴 Not started

### Goal
Turn every promise in this release into a gate assertion, so the next drift breaks the build
instead of shipping. Plus the one legitimate lock change, justified in the open.

### Why it matters
F1/F2 shipped because the test suite asserted the *wrong* invariant with total confidence:
*"non-bye weekly points sum to the season projection"* is exactly F2 written as a passing
test. The fix is not just new code — it is a cross-file invariant that would have caught it.

---

### R17-E6-S1 — Cross-file invariants: the duration and its consequence must agree · Est: M
**As** the Operator **I want** `validate_data.py` to refuse a build where the availability
story is internally inconsistent **so that** an app that says "out 4 weeks" can never be
showing 5 zeroed weeks, or 3.

**Acceptance criteria** (Given/When/Then):
- **R17-E6-S1-AC1** — Given every player in `data/player_weekly.json`, When
  `check_weekly_availability` runs, Then `sum(non-bye pts)` equals
  `proj_points × available_non_bye / total_non_bye` within `±0.1`, where *available* = non-bye
  weeks **without** `avail: false`.
- **R17-E6-S1-AC2** — Given `out_for_season: true`, When validated, Then **every** non-bye
  `pts` is exactly `0.0`.
- **R17-E6-S1-AC3 — one carrier, cross-checked** — Given any player block, When validated,
  Then `count(weeks with avail: false) == weeks_out` (or all non-bye weeks when
  `out_for_season`). The duration *statement* and its applied *consequence* must agree —
  this is what lets `weeks[].avail` be the **single** carrier for blocked weeks, with no
  redundant `blocked_weeks` array.
- **R17-E6-S1-AC4 — NO ORPHAN FLAGS** — Given any player carrying an `availability` block,
  When validated, Then there is a matching `(team, normalized name)` row in
  `data/injuries.json` whose canonical code **equals** the flagged status. **You may not
  mark a player unavailable without a source row.** This is the honest-data rule made
  mechanical: the app can never show an `IR` badge that no feed backs.
- **R17-E6-S1-AC5** — Given `model.availability`, When validated, Then `unavailable` equals
  the count of class-`season` players and `season_points_removed` equals
  `sum(season_points_lost)` within `±0.05`. For today's data that is `unavailable: 1` and
  `season_points_removed: 20.87` — **not 11**, which is what all three upstream docs
  claimed before anyone ran the join.
- **R17-E6-S1-AC6** — Given all of the above, When any check fails, Then it is folded into
  `failures` so `scripts/validate_data.py` exits non-zero — the gate keys on the **exit
  code**, never on grepped output.

**Tasks:**
- [ ] R17-E6-S1-T1 — Implement `check_weekly_availability(weekly, projections, injuries)` with all five rules.
- [ ] R17-E6-S1-T2 — Call it from `main()` and fold results into `failures`.
- [ ] R17-E6-S1-T3 — Add the `injuries.json` schema check to the same pass.
- [ ] R17-E6-S1-T4 — Add negative fixtures (orphan flag, mismatched count, non-zero season-ending week) proving each rule fails when violated.

**QA coverage:**
- AC1 → `scripts/validate_data.py::check_weekly_availability` (data) — Planned
- AC2 → `scripts/validate_data.py::check_weekly_availability` (data) — Planned
- AC3 → `scripts/validate_data.py::check_weekly_availability` (data) — Planned
- AC4 → `scripts/validate_data.py::check_weekly_availability` + `tests/feature/availability.test.mjs::orphan_flag_fails_validation` (data + unit) — Planned
- AC5 → `tests/feature/weekly_contract.test.mjs::model_availability_meta` (unit) — Planned
- AC6 → `tests/run_gate.sh` step 1 exit code (gate) — Existing
- **Coverage: 6/6 = 100%.** Types: data(validate_data), unit(node:test), gate.

**Traceability:** `scripts/validate_data.py`, `data/player_weekly.json`, `data/injuries.json`.

---

### R17-E6-S2 — Projection bands widen for genuinely uncertain players — and nothing else moves · Est: M
**As** the System **I want** the injury feed's free text to reach the projection model's
uncertainty bands **so that** F6's dead code becomes live — without letting a
non-promoted signal touch a single `proj_points` value.

**Acceptance criteria** (Given/When/Then):
- **R17-E6-S2-AC1** — Given `espn_players.py:119`, When it runs, Then `injury_status` is
  `availability.normalize_status(...)` — a canonical code or `None` — so the vocabulary
  mismatch that made `player_projection.py`'s bands unreachable is closed at the boundary.
- **R17-E6-S2-AC2** — Given `_INJURY_STATUS` in `scripts/models/player_projection.py`, When
  re-keyed, Then it covers all eight canonical codes plus `None → (1.0, 1.0)`, and the dead
  `"pup"` key at `:75`/`:185` becomes **live code** the moment a feed emits `PUP`.
- **R17-E6-S2-AC3 — unknown is not a discount** — Given `injury_status is None`, When the
  band is computed, Then it is **neutral** — no widening, no haircut.
- **R17-E6-S2-AC4 — no hoist** — Given `scripts/build_predictions.py`, When this story
  lands, Then the injuries fetch is **not** moved up (C1). The second, band-only
  re-projection pass is inserted **inside the existing injuries `try` block**, immediately
  after the `_write` at `:377`, so a down injuries feed leaves first-pass projections
  exactly as today and marks `feeds["injuries"] = "down"`.
- **R17-E6-S2-AC5 — the id-order guard is mandatory** — Given the re-projection, When the
  top-300 id ordering differs from the first pass, Then the write is **skipped** with a loud
  `[warn]` on stderr. This protects `weekly_contract.test.mjs:40`'s index-alignment lock. At
  every-weight-zero the order **cannot** change, so the guard should never fire — if it
  does, that is a real regression. **A builder who removes it as "dead code" removes the
  safety net.**
- **R17-E6-S2-AC6** — Given the release ships, When `proj_points` is compared, Then it is
  unchanged for all 300 players; only `low`/`high` move. `tests/feature/real_data.test.mjs:45-55`
  (`low <= proj <= high`, `proj > 0`, descending sort) stays green **unmodified**.
- **R17-E6-S2-AC7 — the boundary between fact and learned effect** — Given the design, When
  reviewed, Then *how many weeks an IR player misses* is treated as a **fact from a feed**
  and is **not** weight-gated, while *"players return from IR at 85% effectiveness"* is a
  **learned effect** and belongs behind the promotion gate in `app/ros.js`'s existing
  `availW` hook (the registered-but-unimplemented `ros_avail` family), still at weight 0.

**Tasks:**
- [ ] R17-E6-S2-T1 — Normalize `injury_status` at `espn_players.py:119`.
- [ ] R17-E6-S2-T2 — Re-key and complete `_INJURY_STATUS` onto the canonical constants.
- [ ] R17-E6-S2-T3 — Widen `_interval_band` by `+0.06` on `QUESTIONABLE`, `DOUBTFUL` and every `SEASON_CLASS` code; keep `None` neutral.
- [ ] R17-E6-S2-T4 — Implement `availability.apply_to_records` / `index_report`.
- [ ] R17-E6-S2-T5 — Insert the band-only second pass inside the existing injuries `try` block after `:377`.
- [ ] R17-E6-S2-T6 — Implement the top-300 id-order guard with a stderr `[warn]` and skip.
- [ ] R17-E6-S2-T7 — Verify `proj_points` byte-identical; only `low`/`high` change.

**QA coverage:**
- AC1 → `tests/feature/availability.test.mjs::espn_players_normalizes_at_boundary` (unit) — Planned
- AC2 → `tests/feature/availability.test.mjs::injury_status_bands_cover_all_codes` (unit) — Planned
- AC3 → `tests/feature/availability.test.mjs::none_status_is_neutral` (unit) — Planned
- AC4 → `tests/feature/availability.test.mjs::injuries_fetch_not_hoisted` (unit, source assertion) — Planned
- AC5 → `tests/feature/availability.test.mjs::id_order_guard_skips_and_warns` (unit) — Planned
- AC6 → `tests/feature/real_data.test.mjs:45-55` (unit, **unmodified**) — Existing
- AC7 → `tests/feature/signal_registry.test.mjs::ros_avail_family_still_weight_zero` (unit) — Existing
- **Coverage: 7/7 = 100%.** Types: unit(node:test).

**Traceability:** `scripts/scrape/espn_players.py`, `scripts/models/player_projection.py`,
`scripts/build_predictions.py`, `app/ros.js`.

---

### R17-E6-S3 — One lock changes, and the change is strictly stronger · Est: S
**As** the Operator **I want** the single rewritten assertion documented and justified in the
open **so that** nobody later mistakes a deliberate correction for a weakened test.

**Acceptance criteria** (Given/When/Then):
- **R17-E6-S3-AC1** — Given `tests/feature/weekly_contract.test.mjs:83-93`
  (`'non-bye weekly points sum to the season projection within 0.1'`), When this release
  lands, Then it is **the only existing assertion rewritten**, because in its current form
  **it encodes F2** — it asserts that a player who will not take a snap in 2026 still carries
  100% of his season points.
- **R17-E6-S3-AC2 — the healthy path is untouched** — Given a player with no `availability`
  block or `class !== "season"` (299 of 300 rows today), When the rewritten test runs, Then
  it applies the **original assertion, character for character**.
- **R17-E6-S3-AC3 — strictly stronger, not weaker** — Given a season-class player, When the
  rewritten test runs, Then it asserts **both** the pro-rata target within `±0.1` **and**
  `sum < season − 0.1`, so the test **cannot silently pass on a no-op** — the exact failure
  mode that let F1/F2 ship.
- **R17-E6-S3-AC4 — same commit** — Given the coupling, When landed, Then
  `tests/feature/weekly_contract.test.mjs`, `data/contracts/player_weekly.schema.json`
  (`additionalProperties: false`) and the regenerated `data/player_weekly.json` land in **one
  commit**, all owned by BUILD-A. Any of the three landing alone turns the gate red.
- **R17-E6-S3-AC5 — the do-not-touch list** — Given the full gate, When run, Then all of the
  following are green **unmodified**: all five of `weekly_injury.test.mjs`, all five of
  `lineup.test.mjs`, `team_logic.test.mjs:138-149`, `real_data.test.mjs:45-55`,
  `team_rel2.test.mjs`, `team_vor.test.mjs`, `ros.test.mjs`, and `web.spec.mjs:1209-1305`.
  **If one goes red, the build is wrong — do not "fix" the test.**
- **R17-E6-S3-AC6 — the gate command** — Given the release gate, When run, Then it is
  `tests/run_gate.sh` (`npm run gate`), whose step 3 is `node --test tests/feature/*.mjs`.
  The brief's `tests/competition.test.mjs` **does not exist anywhere in the tree** and
  `node --test` errors on a missing path. **Do not create a stub file to satisfy the typo.**
- **R17-E6-S3-AC7** — Given the completed release, When the gate finishes, Then the baseline
  **235 unit / 75 e2e** are green plus the new cases, with exactly **one** existing assertion
  rewritten and its rewrite justified in `docs/backlog/DECISIONS.md`.

**Tasks:**
- [ ] R17-E6-S3-T1 — Rewrite `weekly_contract.test.mjs:83-93` per SOLUTION_DESIGN §9.2; rename to `'…sum to the AVAILABILITY-ADJUSTED season projection'`.
- [ ] R17-E6-S3-T2 — Keep the healthy branch character-for-character.
- [ ] R17-E6-S3-T3 — Add the `out_for_season → sum === 0` branch and the `sum < season − 0.1` no-op guard.
- [ ] R17-E6-S3-T4 — Land the test, the schema and the data in one commit.
- [ ] R17-E6-S3-T5 — Record the lock change and its justification in `docs/backlog/DECISIONS.md`.
- [ ] R17-E6-S3-T6 — Add the three new selftests to `tests/smoke.sh` (`availability`, `injury_duration`, `build_preseason`).
- [ ] R17-E6-S3-T7 — Run the full gate on exit codes with all four agents' work on disk.
- [ ] R17-E6-S3-T8 — Update `docs/backlog/QA_COVERAGE.md` with the 22 new stories.

**QA coverage:**
- AC1 → `tests/feature/weekly_contract.test.mjs` (unit) — Planned
- AC2 → `tests/feature/weekly_contract.test.mjs::healthy_branch_unchanged` (unit) — Planned
- AC3 → `tests/feature/weekly_contract.test.mjs::reduction_really_happened` (unit) — Planned
- AC4 → `scripts/validate_data.py` + `node --test` both green in one commit (data + gate) — Planned
- AC5 → `tests/run_gate.sh` full run (gate) — Existing
- AC6 → `tests/run_gate.sh` step 3 exit code (gate) — Existing
- AC7 → `tests/run_gate.sh` full run + `docs/backlog/DECISIONS.md` entry (gate + doc) — Planned
- **Coverage: 7/7 = 100%.** Types: unit(node:test), data(validate_data), gate.

**Traceability:** `tests/feature/weekly_contract.test.mjs`,
`data/contracts/player_weekly.schema.json`, `tests/smoke.sh`, `tests/run_gate.sh`,
`docs/backlog/DECISIONS.md`.

---

## 7. QA coverage rollup

| Epic | Stories | ACs | Automated | Coverage |
|---|---|---|---|---|
| R17-E1 · Vocabulary & parsing | 3 | 20 | 20 | 100% |
| R17-E2 · Season-long absence | 5 | 27 | 27 | 100% |
| R17-E3 · Lineup availability | 3 | 18 | 18 | 100% |
| R17-E4 · Compare availability | 3 | 13 | 13 | 100% |
| R17-E5 · Preseason | 4 | 19 | 19 | 100% |
| R17-E6 · Integrity & regression | 3 | 20 | 20 | 100% |
| **Total** | **21** | **117** | **117** | **100%** |

> Every AC maps to at least one named automated test, so coverage is **100%** against the
> Gate-3 ≥90% standard with **zero** manual-only ACs — there is no deploy drill, no live
> third-party call and no doc review in this release. One story (R17-E2-S5, 5 ACs) is
> **contingent on Open Decision 1**; if the owner rejects `MIN_WEEKS_OUT = 4`, the release
> drops to 20 stories / 112 ACs **and changes nothing on disk** (§0).

**Test types used:** `unit` (`node --test tests/feature/*.mjs`), `e2e` (Playwright,
`tests/web/web.spec.mjs`), `data` (`scripts/validate_data.py`), `smoke` (`tests/smoke.sh`
+ the three `--selftest` runners), `gate` (`tests/run_gate.sh`).

**New test files:** `tests/feature/availability.test.mjs` (BUILD-A),
`tests/feature/availability_app.test.mjs` (BUILD-B),
`tests/feature/preseason.test.mjs` (BUILD-D).
**Edited:** `tests/feature/weekly_contract.test.mjs` (A — the one lock change),
`tests/feature/contrast_aa.test.mjs` (B, +6 rows),
`tests/web/web.spec.mjs` (B — **append only**),
`tests/feature/signal_registry.test.mjs` + `tests/smoke.sh` (C).

---

## 8. Sequencing

```
   ┌── BUILD-A · E1-S1, E1-S2, E1-S3, E2-S1…S5 ──┐
   ├── BUILD-B · E3-S1…S3, E4-S1…S3           ───┤ ── concurrent ──►  BUILD-C · E6-S1…S3
   └── BUILD-D · E5-S1, E5-S3, E5-S4          ───┘                    (+ E5-S2 wiring tasks)
```

BUILD-C runs **last** — it is the integrator (registry, meta, smoke, validate_data) and
depends on both A's regenerated data and D's schema/selftest existing. A, B and D share no
file. B builds against the frozen `player_weekly.json` contract, not against A's output, so
it can land first.

---

## 9. Explicitly out of scope for Rel17

| Item | Why | Where it goes |
|---|---|---|
| Availability chip on `app/views/players.js` / `app/views/team.js` | Not in the brief's file list; a chip with no availability-adjusted number beside it is half a fix. Its honesty job moves to the Compare hint (R17-E4-S3). | Rel18, with ranking on availability-adjusted points |
| Haircutting `proj_points` | Would re-rank VOR, auction values, ADP joins and the draft simulator in one release with no coverage for those interactions. | Rel18+ (Open Decision 2 = keep `proj_points` as the healthy prior) |
| `returns_wk` / explicit return-week parsing (TECH_DESIGN §3 R4) | No mechanic and no surface consumes it. Emitting a field nothing backs and nothing reads is F5 all over again. | Cut, not deferred |
| Re-keying `data/injury_history.json` to canonical codes | 553 KB committed file, schema pins the old enum under `additionalProperties: false`, nflverse upstream 403s through the sandbox proxy — unfixable red gate. | Cut (C7) |
| A JS mirror of the normalization map (`app/availability.js`) | Normalization happens in Python at the scraper boundary; the app receives canonical codes. A mirror with nothing to mirror is the rot this release removes. | Cut (SOLUTION_DESIGN §5.1) |
| Learned "players return from IR at 85% effectiveness" | That is a learned effect and belongs behind the never-regress promotion gate, unlike the *fact* of how many weeks he misses. | `app/ros.js` `availW` / `ros_avail` family, weight 0 |
