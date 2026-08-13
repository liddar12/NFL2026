# REL17 — TECHNICAL DESIGN: Player Availability (IR / PUP / NFI / Suspension) + Preseason Form

Status: DESIGN (no code written yet). Author: technical design lead.
Scope: F1–F7 from the RCA. Vanilla-JS no-build PWA + stdlib-only Python pipeline.
Standing rules apply verbatim: no build step, stdlib-only Python, honest data,
learned signals default to weight 0 behind the never-regress gate, `ensure_ascii=True`
on-disk encoding, no opportunistic refactors.

---

## 0. Correction to the RCA before we design against it

**F6 is right about the outcome and wrong about the mechanism.** `injury_status` IS
populated today: `scripts/scrape/espn_players.py:119` sets
`"injury_status": (p.get("injuryStatus") or "").lower() or None` from the kona fantasy
pool, and `build_player_records` (`espn_players.py:179`) carries it into the records
that `build_predictions.py:331` feeds to `project_players` at `:339`. Nothing is
missing at the call site and **no reorder of `build_predictions.py` is required for the
base case.**

The bands are unreachable for a different reason: **a vocabulary mismatch.** ESPN's
kona feed emits `ACTIVE` / `INJURY_RESERVE` / `OUT` / `QUESTIONABLE` / `DOUBTFUL` /
`SUSPENSION` / `DAY_TO_DAY`, lowercased to `active` / `injury_reserve` / … .
`_INJURY_STATUS` (`scripts/models/player_projection.py:68-76`) is keyed
`healthy|probable|questionable|doubtful|out|ir|pup`, and `_interval_band` (`:184-186`)
widens only on `questionable|doubtful|pup`. So:

* `questionable` / `doubtful` / `out` DO reach the map today (they happen to collide);
* `active` and `injury_reserve` MISS it and silently fall to `(1.0, 1.0)` via
  `.get(status, (1.0, 1.0))` — an IR player is scored as fully healthy;
* `ir` / `pup` / `nfi` / suspension can **never** fire, because no feed on the box
  emits those spellings. `pup` at `:75` and `:185` is dead code exactly as F4 says.

This matters for the design: the fix is a **normalization boundary**, not a reorder,
plus a **second pass** for the richer injuries feed that the kona pool does not carry
(the free-text `detail`). Both are specified in §4.

Everything else in the RCA reproduces against source: F1 (`build_weekly.py:44-45`),
F2 (`INJURY_WEEKS = 3` at `:42` + the renormalization at `:153-157`), F3
(`app/views/lineup.js:93-103` reads only `pts`/`bye`), F5 (`scripts/scrape/espn.py:268`
stores `detail`, nothing consumes it), F7 (`seasontype` defaults to 2 in
`espn.py:95,162` and `espn_gamestats.py:60,160`; seasontype 1 is never requested).

Today's `data/injuries.json`: Active 673, Questionable 65, Out 51, Injured Reserve 10,
Suspension 1 — 11 players who cannot play are projected and startable.

---

## 1. One canonical availability vocabulary

**New module: `scripts/availability.py`** — stdlib, pure, no network, `--selftest`.
It is the single source of truth; nothing else may hold a status map. (The mirrored-map
rot in the sibling WC26 project is the lesson: three copies of one rename table always
drift. One module, imported everywhere.)

```python
ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED = (...)  # str constants

WEEK_SHAPING = frozenset({QUESTIONABLE, DOUBTFUL, OUT})   # mechanic (a)
LONG_TERM    = frozenset({IR, PUP, NFI, SUSPENDED})       # mechanic (b)

def normalize_status(raw, source="espn_injuries"):
    """Canonical status, or None when the spelling is unknown.

    source: "espn_injuries" | "espn_kona" | "nflverse".
    None means WE DO NOT KNOW — callers MUST NOT treat it as ACTIVE.
    """
```

Maps (verbatim strings, sourced from the real feeds):

| source | raw | canonical |
|---|---|---|
| espn_injuries | `Active` | ACTIVE |
| espn_injuries | `Questionable` / `Doubtful` / `Out` | QUESTIONABLE / DOUBTFUL / OUT |
| espn_injuries | `Injured Reserve` | IR |
| espn_injuries | `Suspension` | SUSPENDED |
| espn_injuries | `Physically Unable to Perform`, `PUP` | PUP |
| espn_injuries | `Non-Football Injury`, `NFI` | NFI |
| espn_kona | `active`, `day_to_day` | ACTIVE, QUESTIONABLE |
| espn_kona | `injury_reserve`, `suspension`, `out`, `questionable`, `doubtful` | IR, SUSPENDED, OUT, QUESTIONABLE, DOUBTFUL |
| espn_kona | `probable` | ACTIVE |
| nflverse | `Out` / `Doubtful` / `Questionable` | OUT / DOUBTFUL / QUESTIONABLE |

PUP/NFI have no live examples in today's feed — they are mapped from ESPN's documented
strings and will simply never fire until ESPN emits them. That is honest (a mapping that
is ready, not a fabricated value), and §5(d) makes an *unknown* spelling fail the gate
loudly rather than default to ACTIVE.

Helper used by the pipeline and mirrored (read-only) in the app:

```python
def availability_for(status_raw, detail, source="espn_injuries"):
    """-> {"status": str|None, "weeks_out": int|None, "out_for_season": bool,
           "returns_wk": int|None, "confidence": "explicit"|"rule"|None,
           "evidence": str|None}"""
```

`weeks_out` resolution order, most conservative first:

1. `injury_duration.parse_duration(detail)` (§3) returns `out_for_season` → `weeks_out = SEASON_OUT` (sentinel 99), `confidence = "explicit"`.
2. parser returns an explicit `weeks_out` → use it, `confidence = "explicit"`.
3. status ∈ LONG_TERM but the text said nothing unambiguous → the **rule floor**
   `LONG_TERM_MIN_WEEKS = 4`, `confidence = "rule"`. This is a league RULE, not a guess:
   a player placed on regular-season IR must miss at least 4 games before he is eligible
   to return, and regular-season PUP/NFI likewise requires missing the first 4.
4. otherwise `weeks_out = None`, `confidence = None` → **no reduction at all**.

`WEEK_SHAPING` statuses never produce `weeks_out` — they are this week's news, handled
by mechanic (a).

---

## 2. `scripts/build_weekly.py` — the exact change (the heart of the release)

### 2.1 What is wrong today

`player_weeks()` (`:116-158`) multiplies the first `INJURY_WEEKS = 3` non-bye weeks by
`injury_mult`, then at `:153-157` computes `scale = season_proj / total` over **all**
non-bye weeks and rescales them. The multiplier is algebraically cancelled: the season
total is invariant by construction. An IR player keeps 100% of his season points.

### 2.2 The change

Separate the two mechanics by **partitioning the non-bye weeks before renormalizing**,
and by making the renormalization target **pro-rata to availability** instead of the raw
season projection.

New signature (one added keyword; every existing caller and test keeps working):

```python
SEASON_OUT = 99                 # sentinel: no non-bye week is available
LONG_TERM_MIN_WEEKS = 4         # league rule floor, mirrored from availability.py

def player_weeks(season_proj, team, sched_by_team, elos, injury_mult=1.0,
                 unavailable_weeks=0, round_dp=2):
```

Algorithm (replacing `:133-157`; steps 1–2 are today's code, unchanged):

1. Build the tilted/venue-adjusted raw `pts` for every non-bye week exactly as today.
   Bye rows stay `{opp: None, home: False, bye: True, pts: 0.0}`.
2. Collect `raw` = the ordered list of non-bye row indices. `n_total = len(raw)`.
3. **Partition:** `blocked = raw[:min(unavailable_weeks, n_total)]`,
   `available = raw[len(blocked):]`.
4. **Week-shape the AVAILABLE weeks only:** apply `injury_mult` to the first
   `INJURY_WEEKS` entries of `available` (today it is the first 3 of `raw`). A player
   who is out for 4 weeks and questionable after does not get his ding applied to weeks
   he was never going to play.
5. **Availability-adjusted target:**
   `target = season_proj * len(available) / n_total` (0.0 when `n_total == 0`).
6. **Renormalize the available weeks to `target`**:
   `scale = target / sum(pts over available)` when that sum > 0 else 0.0.
   Set every `blocked` row to `0.0` and **do not include it in the scale**.
7. Round as today (`round_dp`, `None` to skip).

Consequences, stated as the two mechanics the design direction asked for:

* **(a) short-term ding** — `unavailable_weeks == 0` ⇒ `available == raw` ⇒
  `target == season_proj` ⇒ the function is **numerically identical to today**, path for
  path. This is deliberate: it is what keeps the existing injury lock green (§2.4).
* **(b) long-term absence** — the season total drops by exactly the fraction of the
  season the player misses. Out for 6 of 17 games ⇒ 11/17 of the season projection, and
  the surviving weeks still carry the Elo tilt. `out_for_season` ⇒ every non-bye week is
  0.0 and the total is 0.0. No new fitted parameter, one sentence to explain to a manager.

### 2.3 Feeding `unavailable_weeks` in

`injury_multipliers()` (`:79-99`) is extended (or paired with a sibling) to return two
maps instead of one. Proposed shape, keeping the existing function's contract intact so
its lock at `weekly_injury.test.mjs:107` does not move:

```python
def injury_multipliers(projections, injuries):   # UNCHANGED behavior + contract
    """{gsis_id: multiplier} for WEEK_SHAPING statuses only."""

def unavailability_weeks(projections, injuries):  # NEW
    """{gsis_id: {"status", "weeks_out", "out_for_season", "confidence"}}
    for LONG_TERM statuses (or an explicitly parsed season-ending duration)."""
```

Both join on `(team, _norm_name(player))` using the existing `_norm_name` (`:74-76`).
Worst-case wins on duplicates: the LARGEST `weeks_out` (an `out_for_season` row beats a
4-week row). `INJURY_MULT` (`:45`) stays **byte-identical** — it is asserted verbatim by
a test — but `injury_multipliers` normalizes each row's status through
`availability.normalize_status` before the lookup, via a derived
`INJURY_MULT_CANON = {OUT: 0.55, DOUBTFUL: 0.7, QUESTIONABLE: 0.9}`. `Active` normalizes
to ACTIVE → 1.0 → dropped, exactly as today.

`build_weekly_document()` (`:161-197`) passes `unavailable_weeks` per player and emits:

* per player, **only when the player is affected** (so the injury-free build stays
  byte-identical, per the docstring promise at `:26-28`):
  ```json
  "availability": {"status": "IR", "weeks_out": 99, "out_for_season": true,
                   "confidence": "explicit"}
  ```
* in `model`, a sibling to the existing `injury_shape` — **`injury_shape` itself keeps
  its exact current shape `{applied, statuses_used}`** so its lock does not move:
  ```json
  "availability": {"applied": true, "unavailable": 11, "season_ending": 8,
                   "min_weeks_rule": 4, "source": "espn_injuries"}
  ```
* `MODEL_NOTES` (`:52-56`) gains one clause: "players with a long-term availability
  status (IR/PUP/NFI/suspended) have their unavailable weeks zeroed and REMOVED from
  the renormalization, so their season total is reduced pro-rata."

Module docstring `:20-28` must be rewritten to describe both mechanics; the current text
asserts "the season projection is the honest prior; injuries shift shape, never total",
which this release makes false for case (b).

### 2.4 CONFIRMED: which existing tests assert "non-bye weeks sum exactly to the season projection"

Three assertions exist. **Exactly one must change.**

**MUST CHANGE — `tests/feature/weekly_contract.test.mjs:83-93`**, test name
`'non-bye weekly points sum to the season projection within 0.1'`. It runs over the
COMMITTED `data/player_weekly.json` × `data/player_projections.json` and asserts
`|sum − proj_points| <= 0.1` for **every** player. Once an IR player's weeks are zeroed
this goes red — correctly, because the assertion encodes the bug.

How it must change (replace the body, keep the file, keep the other five tests):

```js
test('non-bye weekly points sum to the AVAILABILITY-ADJUSTED season projection', () => {
  weekly.players.forEach((p, i) => {
    const season = proj.players[i].proj_points;
    const sum = p.weeks.reduce((a, w) => a + (w.bye ? 0 : w.pts), 0);
    const nonBye = p.weeks.filter((w) => !w.bye).length;
    const a = p.availability || null;

    if (!a || !a.weeks_out) {                       // healthy / week-shaped only
      assert.ok(Math.abs(sum - season) <= 0.1, ...); // UNCHANGED law
      return;
    }
    if (a.out_for_season) {
      assert.equal(sum, 0, `${p.gsis_id}: out for season must carry 0 points`);
      return;
    }
    const avail = Math.max(0, nonBye - a.weeks_out);
    assert.ok(Math.abs(sum - season * (avail / nonBye)) <= 0.1, ...);
    assert.ok(sum < season - 0.1,                    // the reduction REALLY happened
      `${p.gsis_id}: flagged unavailable but the season total did not drop`);
  });
});
```

Why the change is legitimate, not a weakened lock:

* The invariant the old test actually protected is *"the tilt redistributes; it never
  inflates or leaks"* (its own comment, line 84). That survives verbatim — the sum is
  still pinned exactly, to a target that is now a function of games the player can play.
* The old form asserted something the product must stop believing: that a player who
  will not take a snap in 2026 still carries 100% of his season points. Keeping it would
  keep F2 shipped.
* The new form is **strictly stronger** for the affected rows: it pins the reduced total
  AND adds `sum < season - 0.1`, so the test cannot silently pass on a no-op — the exact
  failure mode that let F1/F2 live this long.
* The healthy path (the overwhelming majority of 300 rows) keeps the original assertion
  character for character.

**MUST NOT CHANGE — `tests/feature/weekly_injury.test.mjs:69-105`**, test name
`'multiplier hits ONLY the first 3 non-bye weeks; season total preserved to 1e-6'`, and
`:146-169` `'applied injuries -> injury_shape meta, shaped early weeks, season total intact'`.
Both drive mechanic (a) only: `player_weeks(..., injury_mult=0.55)` with
`unavailable_weeks` defaulted to 0, and `build_weekly_document` with a single `Out` row.
Under §2.2, `unavailable_weeks == 0` makes the code path numerically identical, so both
stay green **unmodified**. They are the regression proof that we did not disturb the
correct half of the system. **If either goes red, the implementation is wrong** —
do not "fix" them.

Also unaffected but worth naming: `tests/feature/weekly_injury.test.mjs:61`
(`INJURY_MULT` table asserted verbatim — do not re-key it), `:107` (the join test —
`Active` must still drop), `:122` (absent/empty/all-Active ⇒ byte-identical document,
which is why `availability` keys are emitted only when non-empty), and
`tests/feature/team_logic.test.mjs:138-149` (`weeklyPoints` rescales by
`seasonAdj / seasonPpr` — a *proportional* ratio, not a renormalization, so a reduced
weekly sum passes through untouched and PPR↔Standard conversion stays correct).

---

## 3. `detail` → structured duration parser

**New module: `scripts/injury_duration.py`** — stdlib (`re` only), pure, deterministic,
no network, `--selftest`. Separate from `availability.py` so the regex mass and its
fixture corpus live behind their own selftest.

```python
def parse_duration(detail, status=None):
    """Structured, CONSERVATIVE duration from an ESPN injury `detail` blob.

    Returns:
      {"weeks_out": int|None,        # explicit game/week count, 1..17
       "out_for_season": bool,       # only on an unambiguous season-ending phrase
       "returns_wk": int|None,       # explicit "return in Week N"
       "confidence": "explicit"|None,
       "evidence": str|None}         # the matched sentence, for UI honesty

    Everything None/False when the text is absent, empty, or ambiguous.
    NEVER guesses a number. `status` is advisory only (used to reject a
    season-ending read on a WEEK_SHAPING status); it never invents a duration.
    """
```

Preprocessing: `detail or ""` → casefold → collapse whitespace → split into sentences on
`[.!?]`. Rules are evaluated **per sentence**, first match wins, and a sentence that
trips a hedge guard is discarded before any rule runs.

**Hedge guard (evaluated first; a hedged sentence yields nothing):**
`\b(could|might|may|possibly|likely|hopes?|hoping|targeting|expected to return|aiming|
report(?:s|edly)?|one report|suggest\w*|estimate\w*|if he|questionable to|no timetable|
unclear|potentially)\b`
— with one deliberate whitelist: the clause `unless (he|the two sides|they)…(injury )?settlement`
does NOT hedge a season-ending read. An injury settlement is a release from the roster,
not a return to it; for a fantasy manager the conservative read is still "gone".

**R1 — season-ending** (`out_for_season = True`, `weeks_out = SEASON_OUT`):

```
\b(?:miss|missing|sit out)\s+(?:the\s+)?(?:entire|entirety of the|rest of the|
   remainder of the|whole)\s+(?:\d{4}\s+)?(?:regular\s+)?(?:season|campaign|year)\b
\b(?:his|her|their)\s+(?:entire\s+)?(?:rookie\s+)?season\s+is\s+over\b | \bseason is over\b
\bout for the (?:season|year)\b
\bseason[- ]ending\b
\b(?:spend|spending)\s+the\s+(?:entirety|duration|remainder)\s+of\s+the\s+
   (?:\d{4}\s+)?(?:season|campaign)\s+on\s+ir\b
```

Verified against today's committed `data/injuries.json` — these match, verbatim, 9 of the
10 `Injured Reserve` rows: "miss his entire rookie season" (CAR Brazzell), "season is
over" (KC Downs), "spend the entirety of the 2026 campaign on IR" (LV Collier), "sit out
the rest of the year" (LAR Walls), "miss the entirety of the upcoming campaign" (NE
Kibble, NE Webb), "spend the duration of the 2026 season on IR" (SF Kamara), "miss the
entire 2026 season" (TEN Kane). `status` must be in LONG_TERM ∪ {OUT} for R1 to fire —
a "Questionable" player whose blurb mentions a season-ending injury to a *teammate* is
rejected.

**R2 — explicit game count** (`weeks_out = N`):
`\bmiss(?:ing)?\s+(?:the\s+)?(?:first\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:regular[- ]season\s+)?games?\b`
Word-number map covers one…ten only. Reject `N < 1 or N > 17` → return nothing.
Live proof case: CHI Beanie Bishop Jr., status `Suspension` — *"set to miss the first
three games of the 2026 regular season"* → `weeks_out = 3`, `confidence = "explicit"`.

**R3 — explicit week count** (`weeks_out = N`): same word/number alternation against
`\b(?:out|sidelined|shelved|miss(?:ing)?)\b[^.]{0,30}?\b(one|…|ten|\d{1,2})[- ]weeks?\b`.
Same 1..17 bound.

**R4 — explicit return week** (`returns_wk = N`, `weeks_out` left None):
`\breturn\w*\b[^.]{0,30}?\bweek\s+(\d{1,2})\b`, 1..18. The caller derives absence from
the current week; the parser does not do arithmetic it lacks context for.

**Returns nothing (all None/False) when:** `detail` is None/empty; every sentence is
hedged; a **range** is present (`\d+\s*[-–]\s*\d+\s*(?:weeks?|months?)`) — SF Pearsall's
*"one report suggesting '6-12 months'"* is the canonical null case, and it is doubly
rejected (hedge + range); a matched count is out of bounds; or the phrase is
season-ending but `status` is a WEEK_SHAPING status.

`--selftest` asserts every case above (positives from the real blobs quoted here,
negatives from Pearsall + a hand-written hedge corpus), and is wired into
`tests/smoke.sh` (§5d).

---

## 4. Wiring `injury_status` into `project_players`

Two parts. **No reorder of `build_predictions.py`.**

**(i) Normalize at the boundary — fixes the vocabulary mismatch (§0).**
`scripts/scrape/espn_players.py:119` becomes
`"injury_status": availability.normalize_status(p.get("injuryStatus"), source="espn_kona")`
(returning the canonical constant or `None`). `scripts/models/player_projection.py`
re-keys `_INJURY_STATUS` (`:68-76`) and the band widening (`:184-186`) onto the canonical
constants — ACTIVE/QUESTIONABLE/DOUBTFUL/OUT/IR/PUP/NFI/SUSPENDED, `None` ⇒ neutral
`(1.0, 1.0)` (unknown is not a discount). Dead `"pup"` at `:75`/`:185` becomes live.
This alone makes the IR/PUP/NFI/SUSPENDED bands reachable, with zero ordering change.

**(ii) A second projection pass — for the feed that has the `detail` text.**
The kona pool has a status but no free text; `data/injuries.json` has both. The injuries
fetch sits at `build_predictions.py:374-380`, *after* `project_players` at `:339`.
**Do not hoist it.** It is a guarded best-effort feed ("don't fail the whole run"); moving
it onto the critical path of the core `player_projections.json` write changes the failure
semantics of the entire pipeline for a feature that must degrade gracefully.

Instead, insert an explicit, additive re-projection **inside the existing injuries
`try` block**, immediately after the `_write` at `:377`:

```python
        avail_by_key = availability.index_report(inj)          # {(team, norm_name): rec}
        n_over = availability.apply_to_records(players_in, avail_by_key)
        if n_over:
            projected = project_players(players_in, ctx={"teams": teams_fixture})
            projected = [p for p in projected if p["proj_points"] > 0]
            projected.sort(key=lambda p: (-p["proj_points"], p["gsis_id"]))
            _write(os.path.join(DATA, "player_projections.json"),
                   {"season": SEASON, "updated_utc": now, "players": projected[:300]})
            print(f"injury re-projection: {n_over} records overridden")
```

* `apply_to_records` writes the canonical status onto `players_in[i]["injury_status"]`,
  preferring the injuries-feed status over the kona status (it is the richer, fresher
  source), and returns the count of records it changed.
* Guarded by the enclosing `try/except` at `:378`: a down injuries feed leaves the
  first-pass projections **exactly as they are today** and marks `feeds["injuries"]`
  `"down"` — honest degradation, never a silent default.
* Re-slicing `projected[:300]` here is what keeps `build_weekly.build_weekly_document`
  at `:594` index-aligned with the file on disk — the invariant locked by
  `weekly_contract.test.mjs:40` (`players EXACTLY mirror player_projections.json`).
  `build_weekly` already runs at `:587`, after this block. No move required.
* Cost: one extra in-memory pass over ~1.5k pure records. No extra network call.

**What actually changes in the numbers today:** nothing in `proj_points`. Every registry
weight is 0.0, so `applied = 1 + 0 × (adj − 1) = 1.0` and the `injury_status` adjustment
is neutral by the "started at 0" rule — which is correct and required. What DOES change
is `low`/`high`: `_interval_band` is **not** weight-gated (`player_projection.py:174-194`),
so an IR/PUP/questionable player's interval widens immediately. That is the honest,
weight-0-safe half of the fix, and it is why the season-total reduction has to live in
`build_weekly` (§2) rather than in the projection engine.

`tests/feature/real_data.test.mjs:45-48` (`low <= proj <= high`, `proj > 0`) and `:55`
(descending sort) stay green: the band only widens symmetrically, `proj_points` is
unchanged, and the re-sort is reapplied.

---

## 5. Contracts, schemas, and `validate_data.py`

**(a) NEW `data/contracts/injuries.schema.json`** + a row in `SCHEMA_TO_DATA`
(`validate_data.py:55-81`). `data/injuries.json` is committed and always present, so it
is **NOT** added to `OPTIONAL_DATA` (`:86-90`). Row shape (`additionalProperties: false`):

```
team            string, enum = the 32 canonical abbrevs
player          string
status          string        # ESPN's RAW designation, kept verbatim for auditability
availability    string|null, enum = the canonical vocabulary (null = unmapped spelling)
detail          string|null
duration        object|null   { weeks_out: int|null (1..99), out_for_season: bool,
                                returns_wk: int|null (1..18),
                                confidence: enum ["explicit","rule"]|null,
                                evidence: string|null }
```

`build_predictions.py:377` therefore writes `availability.enrich(inj)` rather than raw
`inj`. `_write` already applies the repo's `ensure_ascii=True` encoding — the enriched
rows must not change indent or key ordering conventions.

**(b) `data/contracts/player_weekly.schema.json`** — both objects are
`additionalProperties: false`, so the new keys are blocking and must land *before* the
data is regenerated:

* `model.properties.availability` — optional object, mirroring how `injury_shape` is
  optional: `{applied: bool, unavailable: int ≥ 1, season_ending: int ≥ 0,
  min_weeks_rule: int, source: string}`, `additionalProperties: false`.
* `players.items.properties.availability` — optional object:
  `{status: enum(canonical), weeks_out: int|null, out_for_season: bool,
  confidence: enum ["explicit","rule"]|null}`, `additionalProperties: false`.
* Reword the `weeks` description: non-bye pts sum to the **availability-adjusted**
  season projection (`season_proj × available_non_bye / total_non_bye`).
* `pts.minimum: 0` is unchanged — zeroed weeks are legal.

**(c) NEW cross-file invariant in `validate_data.py`**, beside `check_meta_weights` and
`check_pipeline_health`, called from `main()` and folded into `failures` so the gate keys
on the exit code:

```python
def check_weekly_availability(weekly, projections, injuries):
    """1. sum(non-bye pts) == proj × available/non_bye, within 0.1, for EVERY player.
       2. out_for_season  =>  every non-bye pts is exactly 0.0.
       3. no orphan flags: every player carrying `availability` has a matching
          (team, normalized name) row in injuries.json. You may not mark a player
          unavailable without a source row.
       4. model.availability.unavailable == the count of flagged players."""
```

Rule 3 is the honest-data rule made mechanical: the app can never show an "IR" badge that
no feed backs.

**(d) `tests/smoke.sh`** — add to the existing selftest block (after the
`build_player_usage_history` line):

```
python3 scripts/availability.py --selftest    || fail "availability selftest"
python3 scripts/injury_duration.py --selftest || fail "injury duration selftest"
python3 scripts/build_preseason.py --selftest || fail "preseason selftest"
```

…and one new core invariant in the consolidated python block: **every `status` in
`data/injuries.json` must normalize to a canonical value** — an unrecognized ESPN
spelling fails the gate LOUDLY instead of silently becoming ACTIVE. That is the single
check that prevents this class of bug from recurring.

**(e) Signal registry.** `preseason_form` is added as a **new registry signal at weight
0.0** (§6) — the standing rule ("learned signals default to WEIGHT 0 behind the
never-regress promotion gate") governs, and it is inviolable. That is a 32 → 33 change in
four coupled places, all of which are deliberate and named in §7:
`scripts/signals/registry.py`, `data/meta.json`'s `weights` map,
`validate_data.py:96-108` `EXPECTED_SIGNALS` (and the `:354` print string
"32 signals @ 0.0"), `tests/smoke.sh` (`len(weights) != 32`, twice), and
`tests/feature/signal_registry.test.mjs:18`. No availability signal is added — the
availability fix is a **mechanical** correction to a split, not a learned signal, so it
must NOT be weight-gated (a weight-0 availability signal would ship F1 unfixed).

---

## 6. Preseason: builder module, cap, and decay

**New `scripts/build_preseason.py`** (follows the `build_*.py` + `--selftest` +
guarded-import pattern of `build_gamescript.py`), **new contract
`data/contracts/preseason_form.schema.json` → `data/preseason_form.json`**, invoked from
`build_predictions.py` in its own guarded block (mirroring `:432-444`) so a preseason
failure degrades loudly and never kills the core pipeline.

**No new fetch code.** `espn.fetch_schedule` / `fetch_season_schedule` (`:95`, `:162`) and
`espn_gamestats.fetch_final_linescores` / `fetch_season_gamestats` (`:60`, `:160`) already
take `seasontype`; the builder calls them with `seasontype=1, weeks=range(1, 5)`
(HOF game + PRE1–PRE3). Only FINAL preseason games are ingested — the same status gating
the rest of the pipeline uses.

**Per-player math** (all constants are documented priors, recorded in the output meta):

```
PRESEASON_CAP   = 0.05    # the nudge can never exceed ±5%
MIN_SNAPS       = 30      # snaps for a full-confidence sample
DECAY_GAMES     = 3       # decays to exactly 0 once 3 regular-season weeks are final

raw_ppg  = preseason_ppr_points / preseason_games_played        # None if games == 0
base_ppg = prior_season_points / 17                             # None if <= 0
ratio    = raw_ppg / base_ppg                                   # None if either is None
signal   = clamp(ratio, 1 - PRESEASON_CAP, 1 + PRESEASON_CAP)
sample   = min(preseason_snaps / MIN_SNAPS, 1.0)                # 0 snaps -> 0
decay    = max(0.0, 1.0 - (current_week - 1) / DECAY_GAMES)     # week from
                                                                # game_predictions.json
adj      = 1 + (signal - 1) * sample * decay                    # -> exactly 1.0 at wk 4
```

Properties this buys, in the owner's terms:

* **Bounded.** `|adj − 1| ≤ PRESEASON_CAP` always, and `sample` shrinks it further for a
  starter who played one series. A backup's 3-TD preseason cannot outrank a starter who
  sat.
* **Decays to zero.** At `current_week ≥ 4`, `decay == 0` and `adj == 1.0` exactly —
  preseason stops existing once real games are final, mechanically, not by convention.
* **Cannot flip a ranking on its own.** Guaranteed twice over: (1) the registry weight is
  0.0, so until the never-regress gate promotes it, `applied = 1.0` and the projection is
  untouched; (2) the promotion precondition, asserted in `--selftest` against the real
  committed `data/player_projections.json`, is that applying `adj` at full strength to
  every row moves no player more than **±2 ranks within his position** in the top 100 —
  measured, not assumed, and the selftest fails loudly if the cap ever stops holding it.
* **Honest.** Zero preseason snaps ⇒ `adj: 1.0` with `reason: "no_preseason_snaps"`;
  no prior-season baseline ⇒ `adj: 1.0`, `reason: "no_baseline"`. Never a fabricated
  value, and the reason is carried into the file so the UI can say so. The document
  carries `estimate: true`, `applied: false` (weight 0), and the three constants.
* **Labelled wherever it surfaces:** "PRESEASON · LOW WEIGHT · starters sit and everyone
  is avoiding injury — this is not regular-season performance", alongside the existing
  `.est` ESTIMATE chip.

If the preseason fetch fails, the builder writes **nothing** (leaving any existing file
untouched) and `feeds["preseason"]` is marked `degraded` — visible in the pipeline-health
roll-up, per the honest-data rule.

---

## 7. Surfacing availability in the app (F3)

**New pure module `app/availability.js`** (mirrors the `app/lineup.js` pure-module +
unit-test pattern; no DOM, no fetch at import):

```js
export const AVAIL = Object.freeze({ ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED });
export function availabilityOf(weeklyPlayerRow, wk)
  // -> { status, playable, weeksOut, outForSeason, label, tone }
```

`playable === false` when `outForSeason`, or `wk <= weeksOut`, or status ∈
{OUT, IR, PUP, NFI, SUSPENDED}. QUESTIONABLE/DOUBTFUL stay **playable** — they are a
start/sit judgement the manager makes, not a block — but carry a `tone` for the chip.

**`app/lineup.js`** — `bestLineup` skips any row with `p.playable === false` when filling
slots (falling through to the next candidate) and pushes it to `bench`. Strict `=== false`
means every existing call site and every row in `tests/feature/lineup.test.mjs` (which
never sets `playable`) behaves exactly as today. No signature change.

**`app/views/lineup.js`** — `playerRow` (`:93-103`) adds
`const a = availabilityOf(w, wk)` and returns `playable: a.playable`. Renders an
`IR` / `OUT` / `SUSP` / `PUP` chip as a sibling of the existing `BYE` chip (`.lu-bye` →
new `.lu-unavail`), and the START/SIT block gains one honest line when a swap was caused
by unavailability. Data source: the `availability` block already on `player_weekly.json`
(both views fetch it) — no second fetch on the lineup path.

**`app/views/compare.js`** — adds an availability row to the side-by-side metric table:
status chip, `weeks_out`, and the parsed `evidence` sentence when
`confidence === "explicit"` (from `data/injuries.json`, fetched via a new
`getInjuries` in `app/data.js` under `Promise.allSettled`, so an absent file degrades to
no badge and never blanks the view — the same contract note `app/data.js:17` already
makes for `player_weekly`).

---

## 8. Every file that must change

**Python — new:** `scripts/availability.py`, `scripts/injury_duration.py`,
`scripts/build_preseason.py`.
**Python — edited:** `scripts/build_weekly.py` (§2), `scripts/build_predictions.py`
(§4ii, §5a, §6 guarded block), `scripts/scrape/espn_players.py:119` (§4i),
`scripts/models/player_projection.py:68-76,149-154,184-186` (§4i),
`scripts/scrape/espn.py:268` (carry `detail` unchanged; add the PUP/NFI raw strings to
the normalization docstring only), `scripts/signals/registry.py` (+`preseason_form`),
`scripts/validate_data.py` (§5a,c,e).

**Contracts — new:** `data/contracts/injuries.schema.json`,
`data/contracts/preseason_form.schema.json`.
**Contracts — edited:** `data/contracts/player_weekly.schema.json` (§5b).
**Data:** `data/meta.json` (+`preseason_form: 0.0`), regenerated
`data/injuries.json`, `data/player_weekly.json`, `data/player_projections.json`, new
`data/preseason_form.json`.

**App — new:** `app/availability.js`.
**App — edited:** `app/lineup.js`, `app/views/lineup.js`, `app/views/compare.js`,
`app/data.js` (+`getInjuries`), plus the `.lu-unavail` chip rule in the stylesheet that
owns `.lu-bye`.

**Tests — new:** `tests/feature/availability.test.mjs` (vocabulary + `availabilityOf` +
`bestLineup` unavailable-skip), `tests/feature/injury_duration.test.mjs` (the parser
corpus, positives and the Pearsall null), `tests/feature/weekly_unavailability.test.mjs`
(mechanic (b): pro-rata target, `out_for_season` ⇒ 0, `unavailable_weeks=0` ⇒ byte-identical
to the pre-change build), `tests/feature/preseason.test.mjs` (cap, decay-to-zero at week 4,
`no_preseason_snaps` honesty).
**Tests — edited:** `tests/feature/weekly_contract.test.mjs:83-93` (§2.4, the one
legitimate lock change), `tests/smoke.sh` (§5d + the 32→33 weight count),
`tests/feature/signal_registry.test.mjs:18` (+`preseason_form`).
**Tests — at risk, must stay green unmodified:** `tests/feature/weekly_injury.test.mjs`
(all five), `tests/feature/lineup.test.mjs` (all five),
`tests/feature/team_logic.test.mjs:138-149`, `tests/feature/real_data.test.mjs:45-55`,
`tests/feature/team_rel2.test.mjs`, `tests/feature/team_vor.test.mjs`,
`tests/web/web.spec.mjs:1209-1305` (REL15/REL16 lineup + compare: the optimal-lineup card
must still render exactly 7 `.lu-row` starter rows — the existing
`— no eligible player —` branch at `app/views/lineup.js:118` already emits a row, so
excluding an unavailable player keeps the count; re-verify, do not relax the assertion).

**Gate:** unchanged commands, run in order, 100% green on exit codes. Expected baseline
after this release: 235 + the new unit tests, 75 e2e, all passing.
