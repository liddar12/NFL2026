# Rel17 — Player Availability & Preseason Signal: Solution Architecture

**Role:** Solution Architect · **Gate:** 1 (confirm before build)
**Scope:** F1–F7 (IR/suspension haircut, multi-week unavailability, lineup
availability, PUP/NFI capture, injury-duration parsing, unreachable projection
bands, preseason ingestion)
**Repo:** `/home/user/nfl2026` — vanilla-JS no-build PWA + stdlib-only Python.

---

## 0. Findings re-verified against real source (two corrections)

Every finding was re-read against the tree before designing. Five confirm exactly.
Two need correcting, and the corrections change the design:

| # | Verdict | Evidence |
|---|---|---|
| F1 | **Confirmed** | `scripts/build_weekly.py:45` `INJURY_MULT = {"Out":0.55,"Doubtful":0.7,"Questionable":0.9}`; `injury_multipliers()` drops anything mapping to `1.0`. Today's `data/injuries.json`: Active 673, Questionable 65, Out 51, **Injured Reserve 10, Suspension 1** → 11 unavailable players carry a 1.0 multiplier. |
| F2 | **Confirmed** | `player_weeks()` lines 145–157: the multiplier hits the first `INJURY_WEEKS = 3` non-bye weeks, then `scale = season_proj / total` renormalizes **all** non-bye weeks. Season total is invariant by construction — an injury only reshapes. |
| F3 | **Confirmed** | `app/views/lineup.js:93–103` builds rows from `pts` + `bye` only; `app/lineup.js` `bestLineup()` sorts on `pts` alone. Nothing reads availability. `app/views/compare.js` `metricsFor()` likewise. **No app module reads `injuries.json` at all** (`grep -rn injur app/` → one comment in `ros.js`). |
| F4 | **Confirmed** | `pup` appears only at `scripts/models/player_projection.py:75` and `:185`. No feed emits it. |
| F5 | **Confirmed** | `scripts/scrape/espn.py:268` stores `detail`; nothing reads it. No `weeks_out` / `expected_return` field exists anywhere in the tree. |
| F6 | **CORRECTED** | `injury_status` **is** populated: `scripts/scrape/espn_players.py:112` reads ESPN-fantasy `injuryStatus` and `build_player_records()` (line ~176) puts it on every record, so `project_players()` at `build_predictions.py:339` does see it. Proof it fires: `_interval_band` is **not** weight-gated, and committed bands exceed their position base — Chris Olave WR 0.26 (base 0.20 + 0.06 injury), Derrick Henry RB 0.37, McCaffrey RB 0.31. The **real** defect is threefold: (a) **vocabulary mismatch** — ESPN fantasy emits `INJURY_RESERVE` / `SUSPENSION` / `DAY_TO_DAY`, which lowercase to keys absent from `_INJURY_STATUS`, so the `ir`/`pup` bands are unreachable *in practice*; (b) the multiplier half is weight-0 gated, so it can never move `proj_points` even at `out → 0.00`; (c) it is a **second, different feed** (fantasy API) from `data/injuries.json` (site API, fetched later at `build_predictions.py:375`), so the two can disagree with nothing reconciling them. |
| F7 | **Confirmed, and smaller than stated** | `seasontype` is hardcoded `2` at every **call site**, but it is already a **parameter with a default** on `espn.fetch_schedule/fetch_scores/fetch_season_schedule/fetch_final_results` and `espn_gamestats.fetch_final_linescores/fetch_season_gamestats`. Preseason ingestion needs **no scraper signature change** — only a new caller. |

**Two gaps the findings did not name, both in scope because they block the fix:**

- **`data/injuries.json` has no contract.** There is no `data/contracts/injuries.schema.json` and no entry in `validate_data.SCHEMA_TO_DATA`. The only unvalidated core feed is precisely the one this release makes load-bearing.
- **`app/ros.js` already has the hook.** `rosPoints(weeks, fromWeek, {avail, availW})` exists with `availW` pinned at 0, documented as the not-yet-implemented `ros_avail` family. Rest-of-season value is computed by **summing `player_weekly` week rows** — so if the weekly split becomes availability-correct, **RoS becomes correct for free, in every surface, with zero client math changes.** That single fact drives the whole design.

---

## 1. The canonical availability vocabulary

One enum, eight codes, used by every feed and every consumer:

```
ACTIVE · QUESTIONABLE · DOUBTFUL · OUT · IR · PUP · NFI · SUSPENDED
```

Split into exactly two **mechanic classes** — this is the heart of the release:

| Class | Codes | Mechanic | Season total |
|---|---|---|---|
| `week` | `QUESTIONABLE`, `DOUBTFUL`, `OUT` | **Week-shaping.** Today's behaviour, unchanged: multiply the first 3 non-bye weeks, then renormalize. Correct for a short-term ding. | **Preserved exactly** |
| `season` | `IR`, `PUP`, `NFI`, `SUSPENDED`, or any code promoted by a parsed duration | **Unavailability.** Zero the affected weeks and **do not renormalize them away.** | **Actually reduced** |

`ACTIVE` is a no-op in both. A code alone does not decide the class: an `OUT`
whose detail text unambiguously says season-ending is promoted to class `season`;
a `SUSPENDED` with no parsed length stays flagged but zeroes nothing (we do not
know how long — honest data beats a convenient guess).

### Normalization map

`scripts/availability.py` (new, pure, stdlib, no I/O) is the **single Python
source of truth**, deliberately built in the image of `scripts/scrape/renames.py`:

```python
AVAILABILITY = ("ACTIVE","QUESTIONABLE","DOUBTFUL","OUT","IR","PUP","NFI","SUSPENDED")

_NORMALIZE = {                      # keys lower-cased + whitespace-collapsed
    # --- ESPN site API (data/injuries.json, observed today) ---
    "active": "ACTIVE", "questionable": "QUESTIONABLE", "doubtful": "DOUBTFUL",
    "out": "OUT", "injured reserve": "IR", "suspension": "SUSPENDED",
    # --- ESPN fantasy API (espn_players.injuryStatus) ---
    "injury_reserve": "IR", "day_to_day": "QUESTIONABLE", "probable": "ACTIVE",
    # --- nflverse injuries release (report_status) ---
    #     emits Out / Doubtful / Questionable only — already covered above.
    # --- forward-compat spellings ---
    "ir": "IR", "physically unable to perform": "PUP", "pup": "PUP",
    "non-football injury": "NFI", "nfi": "NFI", "suspended": "SUSPENDED",
}

WEEK_CLASS   = frozenset({"QUESTIONABLE", "DOUBTFUL", "OUT"})
SEASON_CLASS = frozenset({"IR", "PUP", "NFI", "SUSPENDED"})
```

`normalize_availability(raw) -> code | None`, returning `None` for an unmapped
string — **exactly** the `normalize_team()` contract, and callers must handle
`None` loudly, exactly as `_team_abbrev()` does:

> An unmapped availability string **raises `FeedError`** at the scraper boundary,
> naming the raw value and pointing at `scripts/availability.py`.

Justification: a drifted availability string is the same class of failure as a
drifted team abbreviation — it silently mis-attributes a fact and everything
downstream is quietly wrong. The repo already chose loud-over-lenient for that
exact failure mode and this must not be the one place that guesses.

`app/availability.js` is a byte-equivalent JS mirror (the `RENAMES` mirror
pattern, which `renames.py` explicitly asks for and never got a test).
`tests/feature/availability_vocab.test.mjs` diffs the two maps and fails on drift.

---

## 2. Where normalization happens — and on which contract availability rides

### Decision A: normalize at the **scraper boundary**, keep the raw string beside it

`espn.fetch_injuries()` and `build_injury_history.shape()` emit canonical codes.
No builder, model, or view ever re-maps. But every row also keeps `status` (the
verbatim feed string) so the mapping is auditable and drift is diagnosable from
the committed data alone.

### Decision B: availability rides the **existing `data/injuries.json`**, extended additively — not a new file

Rejected alternative: a new `data/availability.json`. Rejected because
`injuries.json` is already the per-player current-availability feed, is already
written every pipeline run, and is already the file `build_weekly.load_injuries()`
reads. A second file would create two sources of truth for one fact — the precise
drift failure `renames.py` was written to prevent. The app-facing surface is
greenfield (no app module reads `injuries.json` today), so there is nothing to
migrate.

The extension is strictly additive, and `status` keeps its verbatim ESPN value.
That is deliberate: `INJURY_MULT`'s keys (`"Out"/"Doubtful"/"Questionable"`) and
the existing lock in `tests/feature/weekly_injury.test.mjs` — which asserts the
table is *exactly* those three strings — survive byte-for-byte. **No existing
test changes.** The new mechanic reads the new fields.

### Decision C: the **app** reads availability from `player_weekly.json`, not `injuries.json`

All four consuming surfaces — `players.js:177`, `team.js:274`, `lineup.js:48`,
`compare.js:49` — already `getPlayerWeekly()`. Carrying availability there costs
**zero new fetches, zero new `data.js` getters, zero new cache entries**, and
keeps the week rows and the reason they are zero in the same object. `injuries.json`
stays a pipeline-internal feed. One carrier, no drift.

### Decision D: `player_projections.proj_points` stays the **full-availability prior**

It is not haircut. `proj_points` is the honest "what this player does over a
healthy season" baseline that VOR, auction values, ADP joins, and the draft
simulator are all calibrated against; reducing it there would double-count with
the weekly zeroing and silently re-rank six surfaces in one release. The
availability-adjusted number is **the sum of the available weeks in
`player_weekly`** — which is what `rosPoints()` already returns. The season prior
and the availability-adjusted expectation are different quantities and this
architecture keeps them visibly different, each labelled.

---

## 3. End-to-end flow

```
                     scripts/availability.py  (vocabulary + duration parser — PURE)
                                    │  normalize_availability() / parse_duration()
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
  ESPN site API              ESPN fantasy API            nflverse release
  espn.fetch_injuries()   espn_players.build_          build_injury_history
  (+ longComment text)      player_records()             .shape()
        │                           │                           │
        ▼                           ▼                           ▼
  data/injuries.json          player["availability"]     data/injury_history.json
  ── CONTRACT (new schema)      (build-time only)          (unchanged shape,
     canonical + raw + duration                             canonical codes)
        │                           │
        │                           ▼
        │                  player_projection.py
        │                  _INJURY_STATUS keyed on CANONICAL codes
        │                  → interval band widens (NOT weight-gated: honest spread)
        │                  → multiplier stays weight-0 (learned-signal rule)
        │                           │
        │                           ▼
        │                  data/player_projections.json
        │                  proj_points = FULL-AVAILABILITY PRIOR (unchanged)
        │
        ▼
  build_weekly.build_weekly_document()
   ├─ week-shaping  (class "week")   → multiply first 3 available weeks, RENORMALIZE
   └─ unavailability (class "season") → ZERO those weeks, DO NOT renormalize
                                    │
                                    ▼
                     data/player_weekly.json  ── CONTRACT (extended)
                       weeks[].pts = 0 + weeks[].avail = false on lost weeks
                       players[].availability = {status, class, weeks_out, ...}
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  app/ros.js rosPoints()      app/lineup.js bestLineup()   app/views/compare.js
  CORRECT FOR FREE            never auto-starts an          availability row
  (sums week rows)            unavailable player; warns
```

**Pipeline ordering change (fixes F6c):** in `scripts/build_predictions.py` the
injuries fetch currently sits at line ~375, *after* `project_players()` at line
339. It moves **up**, to immediately before the N2 player block, so the projection
layer sees the same canonical availability the weekly split will use. One feed,
one vocabulary, one run. The `feeds["injuries"]` health row and the
degrade-never-mask `try/except` move with it unchanged.

---

## 4. The weekly split — exact mechanics

`scripts/build_weekly.py`, `player_weeks()` gains one parameter and one step.
Order of operations is load-bearing:

```
1. base = season_proj / len(sched)                      # unchanged
2. raw week pts = base * tilt * venue                   # unchanged
3. week-shaping: pts *= week_mult on the first 3 AVAILABLE non-bye weeks
4. RENORMALIZE over ALL non-bye weeks so they sum to season_proj   # unchanged
5. THEN zero pts for every week in `unavailable`        # NEW — no renormalization
```

Doing the renormalization first and zeroing second is what makes the two mechanics
compose correctly:

- A fully-available player (`unavailable = frozenset()`) is **byte-identical** to
  today — step 5 is a no-op. All 300 committed players in the current
  `player_weekly.json` are unaffected except the 11 genuinely unavailable ones.
- The existing `weekly_injury.test.mjs` invariant ("season total preserved to
  1e-6") remains true *for class `week`*, which is the case it was written for.
- For class `season`, remaining points fall by exactly the zeroed weeks' share of
  the season — an IR player really does lose points. F1 and F2 close together.

### Deciding which weeks are lost

New pure helper `unavailable_weeks(row, sched, current_week) -> frozenset[int]`:

| Input | Weeks zeroed | `duration_source` |
|---|---|---|
| `out_for_season: true` | `current_week` … 18 | `detail_text` |
| `weeks_out: N` | the next `N` non-bye weeks from `current_week` | `detail_text` |
| `IR` / `PUP` / `NFI`, no parsed duration | next **4** non-bye weeks — `MIN_WEEKS_OUT = 4` | `rule_minimum` |
| `SUSPENDED`, no parsed duration | **none** — flagged only | `null` |
| class `week` | none (shaping only) | `null` |

`MIN_WEEKS_OUT = 4` is **not a guess**: NFL rules require a player placed on
in-season IR to miss at least four games before he is eligible to return. It is a
documented external rule, applied as a *floor*, and every row it produces is
stamped `duration_source: "rule_minimum"` so the app can say "at least 4 games"
rather than implying a measurement. `SUSPENDED` gets no floor because suspension
length has no rule minimum — unknown stays unknown, visibly.

### Meta

```json
"model": {
  "availability": {
    "applied": true,
    "vocab_version": 1,
    "unavailable_players": 11,
    "season_points_removed": 1834.6
  }
}
```
Emitted **only** when at least one player was affected — mirroring the existing
`injury_shape` convention, so an all-Active report still produces a byte-identical
document.

---

## 5. Duration parsing (F5) — precision over recall, always

`scripts/availability.py` also owns `parse_duration(detail_text) -> dict`:

```python
{"out_for_season": False, "weeks_out": 4, "matched_phrase": "expected to miss four to six weeks"}
```

Rules, strictly whitelisted:

- **Season-ending** only on an unambiguous phrase: `out for the season`,
  `season-ending`, `miss the entire (2026 )?(season|campaign)`,
  `sit out the entire 2026 campaign`, `done for the year`, `will not play again in 2026`.
- **Numeric duration** only on an explicit span: `(expected|projected|likely) to miss
  <N> (weeks|games)`, `out <N>-<M> weeks`, `<N> to <M> weeks`. Word-numbers two…eight
  supported. **A range takes the lower bound** — conservative by policy.
- **Everything else → `null`.** `week-to-week`, `day-to-day`, `could return`,
  `hopes to`, `targeting Week X`, `no timetable` yield nothing. We never invent a number.
- **Negation veto list** runs first: `not expected to miss any time`,
  `avoided a season-ending injury`, `unlikely to miss`, `should not miss` → `null`,
  even if a later clause matches.
- `matched_phrase` is always returned, so every parse is auditable in the committed
  JSON and the UI can show *why* it thinks a player is gone.

**Acceptance bar: zero false positives.** The parser is fixtured against real
`detail` strings lifted from the committed `data/injuries.json` (e.g. *"He'll need
to sit out the entire 2026 campaign unless he reaches an injury settlement"* →
season-ending; *"reinjured his neck during training camp, prompting this placement
on injured reserve"* → `IR`, no duration, falls to the 4-game floor). Recall is
reported honestly in the test output; it is allowed to be low. Claiming a duration
that was never stated is a gate failure.

---

## 6. Projection layer (F4, F6)

`scripts/models/player_projection.py`:

- `_INJURY_STATUS` is re-keyed on the **canonical codes** and completed:
  `ACTIVE (1.00,1.00) · QUESTIONABLE (0.85,0.95) · DOUBTFUL (0.35,0.90) ·
  OUT (0.00,1.00) · IR/PUP/NFI/SUSPENDED (0.00,1.00)`. The dead `"pup"` /
  `"healthy"` / `"probable"` string keys go away — F4's dead code becomes
  reachable code the moment PUP appears in a feed.
- Lookup normalizes through `availability.normalize_availability()` so a fixture
  written in either feed's dialect still resolves.
- `_interval_band` widens on class `season` as well as `QUESTIONABLE/DOUBTFUL`.
  This is **not** weight-gated and never has been — a band is a statement of
  spread, not a fitted effect, and widening it for a player who may not play is
  honest.
- The **multiplier stays weight-0 gated.** Deliberate, and it is the reason the
  season-total reduction lives in `build_weekly` instead: *how many weeks an IR
  player misses is a fact from a feed, not a learned effect*, so it must not sit
  behind the never-regress promotion gate. What *would* be learned — e.g. "players
  return from IR at 85% effectiveness" — belongs in `app/ros.js`'s already-existing
  `availW` hook (the registered-but-unimplemented `ros_avail` family), still at
  weight 0. That boundary is the standing rule applied correctly in both directions.

---

## 7. App surfacing (F3)

**`app/availability.js`** (new, pure): the mirrored vocabulary plus
`isUnavailable(code)`, `availLabel(code)` → `OUT · IR · PUP · NFI · SUS`,
`availTone(code)` for the chip class.

**`app/lineup.js`** (pure, unit-tested) — `bestLineup(players)` accepts an
`unavailable` boolean per row and gains one rule:

> An unavailable player is **never** placed in a starting slot while any available
> alternative for that slot exists. If no alternative exists, the slot is filled
> **and flagged** — never silently.

Implemented as a sort-key demotion (unavailable rows rank below every available
row regardless of `pts`), which is belt-and-braces: those rows already project 0
for the zeroed weeks, but a partially-parsed `weeks_out` player can still carry
points in a week he cannot play. The return value gains
`warnings: [{slot, id, reason}]` — **additive**, so the existing
`tests/feature/lineup.test.mjs` assertions on `slots` / `bench` / `total` stay green.

**`app/views/lineup.js`**: an availability chip beside the name, styled like the
existing `BYE` chip (`lu-bye` → `lu-avail`), a `lu-row--unavail` row class, and a
banner when a warning fires: *"No available RB — this slot is filled by a player
who cannot play."* Start/sit moves never recommend starting an unavailable player.

**`app/views/compare.js`**: an `AVAILABILITY` row in the metric table showing the
code, the weeks lost, and the duration provenance (`per report` vs `league minimum`).

**`app/views/players.js` / `team.js`**: chip only in this release — no re-ranking.
Ranking on availability-adjusted points is a deliberate Rel18 candidate, not
opportunistic scope here.

---

## 8. Preseason as a separate, capped, decaying signal (F7)

**Nothing about preseason touches `player_projections.json` or `player_weekly.json`.**
It is its own contract, its own builder, its own registry entry, and it is
display-first.

- **New** `scripts/build_preseason.py` → `data/preseason_signal.json`. It calls
  the **existing** `espn.fetch_scores(season, week=w, seasontype=1)` and
  `espn_gamestats.fetch_final_linescores(..., seasontype=1)` over `weeks=range(1,5)`
  (HOF game + three preseason weeks). No scraper signature changes.
- **Registry:** new player signal `preseason_form` at **weight 0.0**. This is a
  coordinated three-file edit — `scripts/signals/registry.py`,
  `validate_data.EXPECTED_SIGNALS` (player count 19 → 20), and `data/meta.json`
  — because `tests/feature/signal_registry.test.mjs` asserts the three agree
  name-for-name.
- **Hard cap:** the raw adjustment is clamped to `[1 - PRESEASON_CAP, 1 + PRESEASON_CAP]`
  with `PRESEASON_CAP = 0.03`. Clamped in code, not by convention, so the signal
  can never flip a ranking on its own.
- **Decay to zero:** `decay = max(0, 1 - team_regular_season_finals / 3)`. Once a
  player's team has three FINAL regular-season games, the preseason contribution is
  exactly 0.0. Team finals come from the already-fetched
  `espn.fetch_final_results(SEASON)` — no new feed.
- **Honest labelling, mandatory wherever it surfaces:** *"Preseason snaps are not
  true performance — starters sit or play a series and everyone is avoiding injury.
  Capped at ±3% and decays to zero after three regular-season games."* Carried in
  the contract as a `caveat` string so the UI cannot render the number without it.
- **Loud on absent:** outside the preseason window the builder writes
  `{"available": false, "reason": "..."}` rather than stale numbers, and
  `pipeline_status.json` gains a `preseason` feed row. Never a silent default.

---

## 9. Exact data-shape changes

### `data/injuries.json` — extended, and given its first schema

```jsonc
{
  "updated_utc": "2026-08-13T…Z",
  "source": "espn",
  "vocab_version": 1,                                  // NEW
  "counts": {"ACTIVE": 673, "OUT": 51, "IR": 10, …},   // NEW — honest census
  "injuries": [{
    "team": "ARI",
    "player": "Josh Sweat",
    "status": "Out",                 // UNCHANGED — verbatim ESPN string
    "availability": "OUT",           // NEW — canonical code
    "availability_class": "week",    // NEW — "week" | "season"
    "weeks_out": null,               // NEW — int >= 1 or null; NEVER guessed
    "out_for_season": false,         // NEW — only when unambiguous
    "duration_source": null,         // NEW — "detail_text" | "rule_minimum" | null
    "matched_phrase": null,          // NEW — the text that justified the parse
    "detail": "…"                    // UNCHANGED
  }]
}
```

New `data/contracts/injuries.schema.json`; new entry in
`validate_data.SCHEMA_TO_DATA`. `availability_class` is emitted explicitly rather
than re-derived by each consumer — the mirror-drift lesson.

### `data/player_weekly.json` — three optional additions

```jsonc
"model": {
  "availability": {                    // NEW — present only when someone is affected
    "applied": true, "vocab_version": 1,
    "unavailable_players": 11, "season_points_removed": 1834.6
  }
},
"players": [{
  "gsis_id": "espn-4430807",
  "receptions_prior": 61.0,
  "availability": {                    // NEW — present ONLY when != ACTIVE
    "status": "IR", "class": "season",
    "weeks_out": [1, 2, 3, 4],         // explicit week numbers zeroed
    "out_for_season": false,
    "duration_source": "rule_minimum",
    "season_points_lost": 41.2         // the honest delta, stated
  },
  "weeks": [
    {"wk": 1, "opp": "SF", "home": true, "bye": false, "pts": 0.0, "avail": false}
    //                                                             ^^^^^ NEW, optional
  ]
}]
```

`avail` is **optional and emitted only when `false`**. Absent means available —
which keeps the diff on the committed 300-player file to the 11 affected rows
instead of 5 400 cosmetic edits, honouring the minimal-diff rule. The
feed-level degradation story lives in `pipeline_status.json` and the doc-level
`counts` block, not in 5 400 booleans.

Distinguishing `bye: true, pts: 0` from `avail: false, pts: 0` is what lets the
lineup view say *"BYE"* versus *"IR — cannot start"*.

### `data/preseason_signal.json` — new contract (+ schema, + `OPTIONAL_DATA`)

```jsonc
{
  "season": 2026, "updated_utc": "…", "estimate": true,
  "available": true,
  "source": "espn preseason (seasontype=1)",
  "cap": 0.03, "decay_games": 3,
  "caveat": "Preseason snaps are not true performance …",
  "players": [{"gsis_id": "…", "snaps": 14, "pts": 6.2,
               "raw_adj": 1.021, "decay": 1.0, "applied_adj": 1.0}]
}
```
`applied_adj` is `1.0` for as long as `preseason_form` sits at weight 0 — the
day-zero rule, visible in the data.

### Python / JS module surface

| Path | Status | Contents |
|---|---|---|
| `scripts/availability.py` | **new** | vocabulary, `normalize_availability`, `WEEK_CLASS`/`SEASON_CLASS`, `parse_duration`, `MIN_WEEKS_OUT` |
| `app/availability.js` | **new** | mirrored vocabulary + `isUnavailable`/`availLabel`/`availTone` |
| `scripts/build_preseason.py` | **new** | preseason ingest, cap, decay |
| `scripts/scrape/espn.py` | edit | `fetch_injuries()` emits canonical + duration fields; loud on unmapped status |
| `scripts/build_weekly.py` | edit | `unavailable_weeks()`; `player_weeks(..., unavailable=frozenset())`; zero-after-renormalize; `model.availability` meta |
| `scripts/build_predictions.py` | edit | injuries fetch moves **above** `project_players`; preseason block added (guarded, degrade-never-mask) |
| `scripts/models/player_projection.py` | edit | `_INJURY_STATUS` re-keyed canonical + NFI/SUSPENDED; band widens on class `season` |
| `scripts/build_injury_history.py` | edit | `shape()` emits canonical codes |
| `scripts/signals/registry.py` · `validate_data.py` · `data/meta.json` | edit | `preseason_form` at 0.0 (three-file coordinated edit) |
| `app/lineup.js` · `app/views/{lineup,compare,players,team}.js` | edit | availability-aware optimizer + chips + warnings |

---

## 10. Regression additions (every fix locks its behaviour)

| Test | Locks |
|---|---|
| `tests/feature/availability_vocab.test.mjs` **new** | Python map ≡ JS mirror; every observed ESPN + nflverse string maps; an unmapped string raises |
| `tests/feature/injury_duration.test.mjs` **new** | real-`detail` fixtures; **zero false positives**; ambiguous → `null`; negation veto |
| `tests/feature/weekly_unavailable.test.mjs` **new** | zeroing does **not** renormalize; season total drops by exactly the lost share; a fully-available player is byte-identical to today; `IR` with no duration → 4-week floor; `SUSPENDED` with no duration zeroes nothing |
| `tests/feature/lineup.test.mjs` **extend** | an IR player is never auto-started when an alternative exists; flagged when none; existing assertions untouched |
| `tests/feature/preseason_signal.test.mjs` **new** | cap ±3% enforced in code; decay hits exactly 0 at 3 finals; top-100 ranking identical with and without the signal; weight is 0.0 |
| `tests/feature/weekly_injury.test.mjs` **unchanged** | the class-`week` mechanic still preserves the season total exactly |
| Playwright `tests/ux` | lineup renders the availability chip + warning banner; compare shows the availability row; iPad 13" layout holds |

**No existing lock changes.** `INJURY_MULT` keeps its three verbatim ESPN string
keys and its exact values; the season-preservation invariant keeps holding for the
case it was written for. Baseline 235 unit / 75 e2e must stay green, plus the new
cases.

---

## 11. Open decisions for the owner

1. **`MIN_WEEKS_OUT = 4` for IR/PUP/NFI with no parsed duration.** Recommended:
   **adopt** — it is the NFL rule minimum, applied as a floor and labelled
   `rule_minimum`. Alternatives: (b) zero nothing without a parsed duration —
   maximally honest but leaves all 10 current IR players startable, which is the
   bug we are fixing; (c) treat any IR as season-ending — simple but overstates
   for designated-to-return players.
2. **`proj_points` stays the healthy prior; RoS carries the adjusted number.**
   Recommended: **adopt** (§2 Decision D). Alternative: haircut `proj_points`
   directly — re-ranks VOR, auction, ADP and the draft simulator in the same
   release, with no test coverage for those interactions.
3. **Preseason cap 3% / decay over 3 games.** Recommended: **adopt**. Alternative:
   2% / 2 games (more conservative), or 5% / 4 games (more responsive). At weight 0
   none of these change a number today; the cap only bounds what a future
   promotion could do.
