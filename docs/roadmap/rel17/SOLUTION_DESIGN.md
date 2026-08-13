# REL17 — SOLUTION DESIGN (AUTHORITATIVE)

**Player availability (IR / PUP / NFI / suspension / parsed duration) + preseason form.**

Role: adversarial reconciler. This document supersedes `ARCHITECTURE.md`,
`TECH_DESIGN.md` and `UX_DESIGN.md` wherever they disagree. Those three remain
useful background; **where this file contradicts them, this file wins.**

Everything below was re-verified against the real tree and the real committed
data. Claims that could not be reproduced are marked and corrected.

Standing rules apply verbatim: no build step, stdlib-only Python, honest data,
learned signals default to weight 0 behind the never-regress gate,
`ensure_ascii=True` on-disk encoding, fix only what is scoped.

---

## 0. Verification pass — what the three docs got wrong

Nine corrections. Six change the build.

| # | Claim | Verdict |
|---|---|---|
| **C1** | `ARCHITECTURE §3`: "the injuries fetch moves **up**, to immediately before the N2 player block." `TECH_DESIGN §4(ii)`: "**Do not hoist it.**" | **Direct contradiction. TECH wins — no hoist.** The injuries block (`build_predictions.py:374-380`) is a guarded best-effort feed; `build_weekly` already runs *after* it (`:587-593`), so the weekly split already sees the fresh file. Hoisting buys only the projection band and costs the whole run's failure semantics. |
| **C2** | `ARCHITECTURE §7`: an unavailable player fills a slot **and is flagged** when no alternative exists (sort-key demotion). `TECH_DESIGN §7`: `bestLineup` **skips** unavailable rows and benches them. | **Contradiction. ARCHITECTURE wins — demotion, not skip.** Skipping makes `UX_DESIGN §4.3`'s forced-start banner unreachable dead UI, and turns "your only two RBs are hurt" into a silent `— no eligible player —`. Demotion is specified in §5.2. |
| **C3** | `ARCHITECTURE §2 Decision C`: the app reads availability **only** from `player_weekly.json` — "`injuries.json` stays a pipeline-internal feed." `TECH_DESIGN §7`: Compare fetches `injuries.json` via a new `getInjuries` in `app/data.js`. | **Contradiction. ARCHITECTURE wins.** Two client carriers for one fact is the exact drift failure the release is fixing. The `evidence` sentence rides `player_weekly.json`. No `app/data.js` change, no new fetch, no new cache entry. |
| **C4** | `TECH_DESIGN §3`: the R1 season-ending regexes "match, verbatim, **9 of the 10** `Injured Reserve` rows". | **False, twice over.** Run against the real `data/injuries.json`: the count is **8 of 10** (Gyllenborg and Pearsall are null), and TECH's regexes as written match only **6** — they miss `"miss his entire rookie season"` (Brazzell: `his`, and `rookie` between the quantifier and `season`) and `"miss the entirety of the upcoming campaign"` (Kibble, Webb: `upcoming`). Corrected, executed pattern set in §4. |
| **C5** | All three docs: "**11** players who cannot play are projected and startable" / `unavailable_players: 11`. | **Nobody ran the join.** The season-class census is **14**, not 11 (10 IR + 1 suspension + **3 `Out` rows promoted by unambiguous season-ending text** — ATL DeAngelo Malone, NO Keeshawn Silver, TB Chase Lucas). And of those 14, exactly **ONE** — SF **Ricky Pearsall** (WR, `proj_points` 88.6) — joins `data/player_projections.json`'s top 300. The other 13 are fringe/defensive players the app never renders. See §1.3; this rewrites the acceptance criteria. |
| **C6** | `UX_DESIGN §9`: reproductions R1 (Brazzell), R3 (Bishop), R4 (forced start) as "real rows from today's `data/injuries.json`". | **Not reproducible in the app.** Brazzell and Bishop are not in `player_projections.json`, so they never appear on Lineup or Compare. Only R2 (Pearsall) is live. R1/R3/R4 become fixture tests, not UI acceptance scenarios. §8 restates them. |
| **C7** | `ARCHITECTURE §9`: `build_injury_history.shape()` "emits canonical codes". | **Do not do this.** `data/injury_history.json` is a committed 553 KB file, its schema pins `status` to `enum ["Out","Doubtful","Questionable"]` under `additionalProperties: false`, and its upstream (nflverse release CSVs) **403s through the sandbox proxy** — it cannot be regenerated locally. Output stays byte-identical; the change is an assertion only (§3.4). |
| **C8** | `TECH_DESIGN §5(e)`: `tests/smoke.sh` contains `len(weights) != 32` "twice". | **Once**, at `tests/smoke.sh:75`. (`:66` is the *teams* count.) |
| **C9** | `ARCHITECTURE §8` cap 3% / file `preseason_signal.json`; `TECH_DESIGN §6` cap 5% / file `preseason_form.json`. `ARCHITECTURE §4` `unavailable_weeks` = a `frozenset` of week numbers; `TECH_DESIGN §2.2` = an `int`. `ARCHITECTURE §9` `out_for_season` + `weeks_out: null`; `TECH_DESIGN §1` `SEASON_OUT = 99`. | Four naming/shape splits, settled in §2, §3.2 and §6. |

**Confirmed as written** (re-read against source, no correction needed):
F1 (`build_weekly.py:44-45`), F2 (`INJURY_WEEKS=3` at `:42` + renormalization at `:153-157`),
F3 (`app/views/lineup.js:93-103` reads `pts`/`bye` only; `app/lineup.js` sorts on `pts` alone),
F5 (`scripts/scrape/espn.py:268` stores `detail`, nothing consumes it),
F7-as-corrected (`seasontype` is already a parameter on `espn.fetch_schedule/fetch_scores/fetch_season_schedule/fetch_final_results`
and `espn_gamestats.fetch_final_linescores/fetch_season_gamestats` — only callers hardcode `2`),
and **both** docs' F6 correction (`espn_players.py:119` does populate `injury_status`;
the defect is a vocabulary mismatch against `_INJURY_STATUS`, `player_projection.py:68-76`).

`UX_DESIGN §2.3`'s contrast table was independently recomputed and is **exactly right**
(`--accent-txt` 6.34 / 7.20 / 5.87; `--warn` 8.05; `--brand-txt` 6.81; `--muted` 7.98;
`--accent` as text 4.28 on `--surface-2` and 3.96 on `--elev` — **fails**, border-only).

### 0.1 Measured ground truth (`data/injuries.json`, today)

800 rows: `Active` 673, `Questionable` 65, `Out` 51, `Injured Reserve` 10, `Suspension` 1.
Row keys today are exactly `{team, player, status, detail}`; the document has no schema.
`player_weekly.json` currently records `injury_shape: {applied: true, statuses_used: 9}`
— nine week-class players join the top 300.

---

## 1. The three mechanics, and the one player they actually move

### 1.1 Canonical vocabulary

Eight codes, one Python module, one JS presentation mirror:

```
ACTIVE · QUESTIONABLE · DOUBTFUL · OUT · IR · PUP · NFI · SUSPENDED
```

Two **mechanic classes**:

| Class | Codes | What happens to the weekly split | Season total |
|---|---|---|---|
| `week` | `QUESTIONABLE`, `DOUBTFUL`, `OUT` | Today's behaviour, **untouched**: multiply the first 3 available non-bye weeks, then renormalize. | **Preserved exactly** |
| `season` | `IR`, `PUP`, `NFI`, `SUSPENDED`, **or any code with an unambiguous parsed season-ending / N-week duration** | Blocked weeks are zeroed and **excluded from the renormalization**. | **Actually reduced, pro-rata** |

`ACTIVE` is a no-op in both. Class is **data, not a lookup**: an `OUT` whose detail text
unambiguously says season-ending is promoted to `season` (this is not hypothetical — it
fires on three real rows, C5). A `SUSPENDED` with no parsed length is flagged but zeroes
nothing: we do not know how long, and honest data beats a convenient guess.

### 1.2 The vocabulary map (verbatim strings from the real feeds)

```python
# scripts/availability.py
ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED = (
    "ACTIVE", "QUESTIONABLE", "DOUBTFUL", "OUT", "IR", "PUP", "NFI", "SUSPENDED")
CODES = (ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED)

WEEK_CLASS   = frozenset({QUESTIONABLE, DOUBTFUL, OUT})
SEASON_CLASS = frozenset({IR, PUP, NFI, SUSPENDED})
MIN_WEEKS_OUT = 4          # NFL rule floor (see §3.2) — a FLOOR, never a measurement

_MAP = {   # keys are lower-cased + whitespace-collapsed
  # --- espn_injuries (ESPN site API -> data/injuries.json). Observed today: the
  #     first five. PUP/NFI are ESPN's documented spellings, ready but unfired.
  "active": ACTIVE, "questionable": QUESTIONABLE, "doubtful": DOUBTFUL,
  "out": OUT, "injured reserve": IR, "suspension": SUSPENDED,
  "physically unable to perform": PUP, "non-football injury": NFI,
  # --- espn_kona (fantasy API -> espn_players.injury_status, already lower-cased)
  "injury_reserve": IR, "day_to_day": QUESTIONABLE, "probable": ACTIVE,
  # --- nflverse injuries release (report_status): Out/Doubtful/Questionable only
  # --- forward-compat spellings
  "ir": IR, "pup": PUP, "nfi": NFI, "suspended": SUSPENDED,
}

def normalize_status(raw):
    """Canonical code, or None when the spelling is unknown.
    None means WE DO NOT KNOW. Callers MUST NOT treat it as ACTIVE."""
```

**Loudness is split deliberately, and this is a design decision, not an oversight:**

* **Loud at the scraper boundary.** `espn.fetch_injuries()` raises `FeedError` naming the
  raw value and pointing at `scripts/availability.py` — the `_team_abbrev()` precedent
  (`espn.py:81-92`). A drifted availability string mis-attributes a fact exactly like a
  drifted team abbrev.
* **Loud at the gate.** `tests/smoke.sh` asserts every `status` in the committed
  `data/injuries.json` normalizes. An unrecognised ESPN spelling fails the gate; it never
  silently becomes ACTIVE. *This is the single check that stops this bug class recurring.*
* **Graceful in the consumer.** `build_weekly.load_injuries()` documents itself as
  "graceful BY CONTRACT, unlike the feeds" (`build_weekly.py:60-65`) and
  `weekly_injury.test.mjs:122-144` locks that promise. `injury_multipliers()` /
  `unavailability()` therefore treat `None` as *no shaping and no unavailability* — never
  as ACTIVE, never as a raise. The degradation is visible upstream and at the gate, which
  is where the honest-data rule requires it to be visible.

### 1.3 The blast radius, measured

Parsing the real 800 rows (executed, §4) and joining on `(team, _norm_name(player))`
against `data/player_projections.json`:

| | count |
|---|---|
| season-class players in the feed | **14** (10 IR, 1 SUSPENDED, 3 `Out` promoted by text) |
| …with an **explicit** parsed duration | 12 (11 season-ending + Bishop 3 games) |
| …falling to the `MIN_WEEKS_OUT` floor | 2 (Gyllenborg, Pearsall) |
| **season-class players inside the top-300** | **1** — SF Ricky Pearsall (`espn-4428209`, WR, 88.6) |
| week-class players inside the top-300 | 9 (matches today's `statuses_used: 9`) |
| false positives across all 800 rows | **0** |

**Consequences the three docs missed, and every builder must internalise:**

1. `model.availability.unavailable` is **1**, not 11.
2. The only committed row that changes is Pearsall's — and he is the **`rule`-confidence**
   case. So the entire visible effect of this release on committed data depends on
   `MIN_WEEKS_OUT = 4`. **If the owner picks "zero nothing without a parsed duration",
   this release changes literally nothing on disk.** That is the decisive argument for
   adopting the floor (Open Decision 1, §10).
3. Compare's `evidence` quote and the `REPORT` provenance tag have **no live row today**.
   They are still built (Bishop and Brazzell prove the parser works, and mid-season this
   flips constantly) but their acceptance tests are fixtures, not screenshots.

---

## 2. `data/player_weekly.json` — the single app-facing carrier

Additive only. Three new shapes; every one is emitted **only when non-empty**, so an
all-healthy build stays byte-identical (the `build_weekly.py:26-28` docstring promise and
the `weekly_injury.test.mjs:122` lock).

```jsonc
"model": {
  "name": "weekly_split_v1", "tilt_coef": 0.5, "home_coef": 0.02,
  "estimate": true, "notes": "…",
  "injury_shape": { "applied": true, "statuses_used": 9 },   // UNCHANGED SHAPE
  "availability": {                    // NEW — only when >=1 player is season-class
    "applied": true,
    "vocab_version": 1,
    "unavailable": 1,                  // season-class players whose weeks were zeroed
    "season_ending": 0,                // of those, out_for_season
    "min_weeks_rule": 4,
    "season_points_removed": 20.87
  }
},
"players": [{
  "gsis_id": "espn-4428209",
  "receptions_prior": 0.0,
  "availability": {                    // NEW — only when status != ACTIVE
    "status": "IR",                    // canonical code
    "class": "season",                 // "week" | "season"
    // the five keys below are emitted ONLY for class "season":
    "weeks_out": 4,                    // int >= 1, or null; NEVER guessed
    "out_for_season": false,
    "confidence": "rule",              // "explicit" | "rule"
    "evidence": null,                  // the matched sentence, or null
    "season_points_lost": 20.87
  },
  "weeks": [
    { "wk": 1, "opp": "SEA", "home": true, "bye": false, "pts": 0.0, "avail": false }
    //                                                              ^^^^^ NEW
  ]
}]
```

* **`avail` is optional and emitted only when `false`.** Absent means available. This keeps
  the committed diff to the affected rows instead of 5 400 cosmetic booleans.
* `bye: true, pts: 0` and `avail: false, pts: 0` are deliberately distinguishable — that is
  what lets the lineup row say `BYE` versus `⊘ IR · 4+ WKS`.
* **There is exactly one carrier for blocked weeks: `weeks[].avail`.** An earlier draft
  also carried a `blocked_weeks` array on the availability block; it is **cut** — two
  representations of one fact is the drift bug this release exists to fix. `weeks_out` is
  a *duration statement*; `avail:false` is the *applied consequence*; `validate_data`
  cross-checks that they agree (§7).
* `evidence` rides here (not `injuries.json`) — this is C3.

`data/contracts/player_weekly.schema.json` (`additionalProperties: false` on all three
objects) must land **in the same commit** as the regenerated data, or validation goes red.
Owner: BUILD-A (§9).

### 2.1 `data/injuries.json` — extended, and given its first schema

```jsonc
{
  "updated_utc": "…", "source": "espn",
  "vocab_version": 1,                                     // NEW
  "counts": {"ACTIVE": 673, "QUESTIONABLE": 65, "OUT": 51, "IR": 10, "SUSPENDED": 1},  // NEW
  "injuries": [{
    "team": "SF", "player": "Ricky Pearsall",
    "status": "Injured Reserve",   // UNCHANGED — ESPN's raw string, kept verbatim
    "availability": "IR",          // NEW — canonical code (null if unmapped)
    "availability_class": "season",// NEW — "week" | "season" | null
    "weeks_out": null,             // NEW — int 1..17, or null. NEVER guessed.
    "out_for_season": false,       // NEW
    "confidence": null,            // NEW — "explicit" | null (see below)
    "evidence": null,              // NEW — matched sentence, or null
    "detail": "…"                  // UNCHANGED
  }]
}
```

`status` stays byte-identical **on purpose**: `INJURY_MULT`'s three verbatim keys
(`build_weekly.py:45`) and the `weekly_injury.test.mjs:61` assertion that the table is
*exactly* `{Out: 0.55, Doubtful: 0.7, Questionable: 0.9}` survive untouched.

`confidence` here is `"explicit"` or `null` only — the `"rule"` floor is applied by
`build_weekly`, not by the feed, because it depends on the schedule. The rule floor
surfaces as `confidence: "rule"` on the **player_weekly** block. This is a deliberate
split: `injuries.json` records *what the report said*; `player_weekly.json` records *what
we did about it*.

---

## 3. `scripts/build_weekly.py` — the heart of the release

### 3.1 Signature

```python
SEASON_OUT_SENTINEL = None      # out_for_season is a BOOL; there is no 99. (C9)

def player_weeks(season_proj, team, sched_by_team, elos, injury_mult=1.0,
                 unavailable_weeks=0, first_week=1, round_dp=2):
```

`unavailable_weeks` is an **int** (TECH's shape), and `first_week` resolves ARCHITECTURE's
"from `current_week`" intent without a set: **blocked = the first `unavailable_weeks`
non-bye rows whose `wk >= first_week`.** At `first_week=1` (the only value used today, and
the value `build_weekly_document` defaults to) this is exactly `raw[:N]`. At
`unavailable_weeks=0` the function is **numerically identical to today, path for path.**

### 3.2 Algorithm (replaces `build_weekly.py:133-157`; steps 1-2 unchanged)

```
1. tilted/venue raw pts for every non-bye week                       # unchanged
2. raw = ordered non-bye row indices; n_total = len(raw)             # unchanged
3. PARTITION
     blocked   = the first `unavailable_weeks` entries of raw with wk >= first_week
     available = raw - blocked  (order preserved)
4. WEEK-SHAPE the AVAILABLE weeks only: apply injury_mult to the first
   INJURY_WEEKS (3) entries of `available`
5. TARGET = season_proj * len(available) / n_total   (0.0 when n_total == 0)
6. RENORMALIZE `available` to TARGET; scale = TARGET / sum(available pts), 0.0 if that
   sum <= 0.  Set every `blocked` row to 0.0 and EXCLUDE it from the scale.
7. round(round_dp) as today
```

Step 4 matters: a player out four weeks and questionable after must not have his ding
applied to weeks he was never going to play.

**Ordering note.** `ARCHITECTURE §4` describes this as "renormalize first, zero second".
That is *outcome-equivalent* to partition-then-renormalize only when the blocked weeks
carry no shaping; partition-first is the correct general statement and is what must be
built. The property both descriptions are protecting — a fully-available player is
byte-identical — holds identically.

### 3.3 Deciding the blocked count

`unavailability(projections, injuries)` (new, sibling to the unchanged
`injury_multipliers`) returns
`{gsis_id: {"status", "weeks_out", "out_for_season", "confidence", "evidence"}}`.
Join on `(team, _norm_name(player))` with the existing `_norm_name` (`:74-76`).
On duplicate rows the **worst** wins: `out_for_season` beats any count; otherwise the
larger `weeks_out`.

| Input | `unavailable_weeks` | `confidence` |
|---|---|---|
| `out_for_season: true` | **all** non-bye weeks from `first_week` | `explicit` |
| `weeks_out: N` (parsed) | `N` | `explicit` |
| class `season`, no parsed duration, status ∈ {IR, PUP, NFI} | **`MIN_WEEKS_OUT = 4`** | `rule` |
| class `season`, no parsed duration, status = `SUSPENDED` | **0** — flagged only | *(no season block emitted)* |
| class `week` | 0 (shaping only) | — |

`MIN_WEEKS_OUT = 4` is not a guess: a player placed on in-season IR must miss at least
four games before he is eligible to return, and regular-season PUP/NFI likewise requires
missing the first four. It is an external, documented league rule applied as a **floor**,
stamped `confidence: "rule"` so the UI says *"at least 4"* and never implies a
measurement. Suspension has no rule minimum, so unknown stays visibly unknown.

`injury_multipliers()` keeps its exact contract and its `weekly_injury.test.mjs:107` lock.
Internally it looks up through a derived
`INJURY_MULT_CANON = {OUT: 0.55, DOUBTFUL: 0.7, QUESTIONABLE: 0.9}` built from
`INJURY_MULT` + `normalize_status`, so `"Active"` still normalizes to `ACTIVE` → 1.0 → is
dropped, exactly as today, and the literal `INJURY_MULT` table stays byte-identical.

The module docstring at `:20-28` must be rewritten: the sentence *"the season projection
is the honest prior; injuries shift shape, never total"* becomes false for class `season`
and would be a lie left in the file.

### 3.4 `scripts/build_injury_history.py`

**Output is byte-identical. Do not re-key it.** (C7.) The only change: `shape()` asserts
each of its three whitelisted statuses maps through `availability.normalize_status`, and
the `--selftest` covers it. This makes `availability.py` the single vocabulary source
without touching a 553 KB committed file whose upstream is unreachable from the sandbox.

---

## 4. Duration parsing — `scripts/injury_duration.py`

Stdlib (`re`), pure, deterministic, `--selftest`. **The rules below were executed against
all 800 committed rows: 12 parses, 0 false positives.** They are the corrected form of
`TECH_DESIGN §3` (C4).

### 4.1 Gate before anything else

The parser only runs for rows whose canonical status is in `SEASON_CLASS ∪ {OUT}`.
This is load-bearing, not belt-and-braces: without it the real feed produces four
garbage durations from `Active`/`Questionable` blurbs describing **last season** or **a
teammate** — CeeDee Lamb *"missing three games overall due to injury"* (2025), Sauce
Gardner *"missing the following three games … to close out the 2025 regular"*, Christian
Kirk *"with ricky pearsall (knee, ir) out for the season"*, Emmanuel Ogbah (a sentence
about Ashton Gillotte). All four are killed by the gate.

### 4.2 Per-sentence evaluation

`detail or ""` → casefold → collapse whitespace → split on `(?<=[.!?])\s+`. Each sentence
is evaluated independently, **first match wins**, and three vetoes run before any rule:

**Veto 1 — hedge.**
`\b(could|might|may|possibly|perhaps|likely|unlikely|hopes?|hoping|hopeful|targeting|aiming|expects? to return|expected to return|report(?:s|ed|edly)?|suggest\w*|estimate\w*|if he|questionable to|no timetable|timetable|unclear|potentially|uncertain|believed|rumor\w*)\b`
— with one whitelist: a clause matching `unless\b[^.]{0,80}?\bsettlement\b` is stripped
before the hedge test. An injury settlement is a release from the roster, not a return to
it; for a fantasy manager the conservative read is still "gone". (Six real IR rows carry
that clause.)

**Veto 2 — range.** `\d+\s*(?:-|–|to)\s*\d+\s*(?:week|month|game)s?` → nothing. Pearsall's
*"one report suggesting \"6-12 months\""* is doubly rejected (hedge **and** range) and is
the canonical null case.

**Veto 3 — other subject / backward reference.**
`\([a-z ]*?(?:knee|hamstring|ankle|shoulder|foot|calf|leg|arm|shin|back|hip|groin|wrist|elbow|neck|concussion|toe|quad|illness|abdomen|ribs?|achilles|acl|pup|ir)[a-z, ]*\)`
(a parenthetical injury tag means the sentence is about somebody else), and — for the
**numeric** rules only —
`\b(?:last (?:year|season)|(?:20)(?:1\d|2[0-5])|to close out|final \d+|the following|overall due to|previous(?:ly)? season|a year ago|career)\b`.

### 4.3 Rules

**R1 — season-ending** → `out_for_season: true`, `weeks_out: null`.

```
\b(?:miss|missing|sit(?:ting)? out|spend|spending)\b[^.]{0,40}?
  \b(?:entire|entirety of|rest of|remainder of|balance of|whole|duration of)\b
  [^.]{0,30}?\b(?:season|campaign|year)\b
\bseason is over\b
\bout for the (?:season|year)\b
\bseason[- ]ending\b
\bdone for the (?:season|year)\b
\bwill not play again (?:this|in) (?:season|year|\d{4})\b
```

The `[^.]{0,40}?` / `[^.]{0,30}?` spans are the fix for C4 — they are what let
`"miss his entire rookie season"` and `"miss the entirety of the upcoming campaign"`
match without opening the door to a cross-sentence read (`[^.]` cannot cross a period).

Executed R1 hits (11): Brazzell (CAR), Downs (KC), Collier (LV), Walls (LAR), Kibble (NE),
Webb (NE), Kamara (SF), Kane (TEN) — all `Injured Reserve`; Malone (ATL), Silver (NO),
Lucas (TB) — all ESPN `Out`, **promoted to class `season`**.

**R2 — explicit game count** → `weeks_out: N`.
`\bmiss(?:ing|es)?\b[^.]{0,25}?\b(?:the\s+)?(?:first\s+)?<NUM>\s+(?:regular[- ]season\s+)?games?\b`

**R3 — explicit week count** → `weeks_out: N`.
`\b(?:out|sidelined|shelved|miss(?:ing|es)?)\b[^.]{0,25}?\b<NUM>[- ]weeks?\b`

`<NUM>` = `(one|two|…|twelve|\d{1,2})`. Reject `N < 1 or N > 17`.
Executed R2 hit (1): CHI Beanie Bishop Jr., `Suspension`, *"set to miss the first three
games of the 2026 regular season"* → `weeks_out: 3`, `confidence: "explicit"`.

**R4 (explicit return week / `returns_wk`) from `TECH_DESIGN §3` is CUT.** No mechanic and
no surface consumes it; emitting a field nothing backs and nothing reads is exactly the
shape of F5. Do not build it.

### 4.4 Return shape and acceptance bar

```python
def parse_duration(detail, status=None):
    """-> {"out_for_season": bool, "weeks_out": int|None,
           "confidence": "explicit"|None, "evidence": str|None} or None."""
```

**Acceptance bar: zero false positives, enforced by `--selftest` against the real corpus.**
Recall is allowed to be low and is reported honestly. Claiming a duration that was never
stated is a gate failure. The selftest fixtures are the 12 real positives quoted above plus
the four real negatives from §4.1 and the Pearsall/Gyllenborg nulls.

---

## 5. App surfaces

### 5.1 `app/availability.js` (new, pure — no DOM, no fetch at import)

**It carries no normalization map.** The app receives already-canonical codes on
`player_weekly.json`, so a JS copy of the ESPN string table would be a mirror with nothing
to mirror — precisely the rot this release removes. It carries presentation only:

```js
export const AVAIL_CODES = Object.freeze([
  'ACTIVE','QUESTIONABLE','DOUBTFUL','OUT','IR','PUP','NFI','SUSPENDED']);

export function availabilityOf(weeklyPlayerRow, wk, currentWk) {
  // -> { status, cls, playable, weeksOut, outForSeason, confidence, evidence,
  //      label, tone, durText, provText, phrase }
}
```

**`playable === false` iff** the player's `weeks[]` row for `wk` carries `avail === false`,
**or** `status === 'OUT' && wk === currentWk` (an OUT designation is this-week news and
zeroes nothing in the split). Everything else — including `QUESTIONABLE`/`DOUBTFUL` and a
`SUSPENDED` of unknown length — is **playable**: that is a start/sit judgement the manager
makes, and the chip is how the app tells him. Absent availability ⇒ `playable: true`,
`label: ''`, so a card rendered without availability is byte-identical to today.

`label`: `Q · D · OUT · IR · PUP · NFI · SUSP` (ACTIVE → `''`).
`tone`: `out` for {OUT, IR, PUP, NFI, SUSPENDED}, `watch` for {QUESTIONABLE, DOUBTFUL}.
`durText`: `· SEASON` | `· {N} WKS` (explicit) | `· {N}+ WKS` (rule) | `''`.
`provText`: `REPORT` (explicit) | `LEAGUE MIN` (rule) | `''`.
`phrase`: the fantasy-natural prose from `UX_DESIGN §4.4`'s table, verbatim.

### 5.2 `app/lineup.js` — demotion, not skip (C2)

`bestLineup(players)` accepts an optional `playable` per row and gains one rule:

> **An unavailable row ranks below every available row for the same slot, regardless of
> points.** If an available candidate exists it is chosen. If none exists the slot is
> **filled by the unavailable player and a warning is emitted** — never left empty, never
> silent.

Implementation:

* per-position sort key becomes `(p.playable === false ? 1 : 0, -pts, id)` — strict
  `=== false`, so every existing call site and every row in `tests/feature/lineup.test.mjs`
  (which never sets `playable`) behaves **exactly** as today;
* the FLEX scan must compare on the same tuple, not on `pts` alone — an available 4.0 must
  beat an unavailable 12.4 (a partially-parsed `weeks_out` player can still carry points in
  a week he cannot play);
* the return value gains `warnings: [{slot, id, reason}]` — **additive**, so the existing
  assertions on `slots` / `bench` / `total` stay green;
* `startSitSwaps` passes `playable` through unchanged; `moves.start` therefore can never
  contain an unavailable id while an alternative exists. That is the literal F3 defect and
  it gets its own assertion.

### 5.3 `app/views/lineup.js`

`playerRow()` gains one line that mirrors the existing bye line at `:100` verbatim:

```js
const a = availabilityOf(w, wk, currentWk);
const pts = (onBye || a.playable === false) ? 0 : Number(wkEntry && wkEntry.pts) || 0;
```

…and `playable: a.playable` must be included in the objects passed to **both**
`bestLineup` (`:107`) and `startSitSwaps` (`:111`) — today both are mapped down to
`{id, pos, pts}` and would silently drop it.

Rendering, per `UX_DESIGN §4`: `.av-chip` beside the name (starter and bench),
`.lu-row--unavail { opacity: .72 }` on bench rows, `.lu-row--forced` (3 px `--accent` left
border, **does not recede**) plus a `.lu-forced` banner when a warning fires, and
`.lu-swapnote` rows above the net-gain line in START/SIT MOVES.

**Two hard constraints on the "already optimal" line:**

1. It must be **suppressed** when `optimal.warnings.length > 0` — today it would print
   `✓ Your starting lineup is already optimal` over a lineup containing a player who
   cannot play, which is a lie.
2. Its replacement element must carry **`class="lu-optimal lu-gap"`**, not `lu-gap` alone.
   `tests/web/web.spec.mjs:1238` asserts
   `page.locator('.lu-move, .lu-optimal').count() >= 1`; keeping `lu-optimal` on the
   replacement means that lock stays green **unmodified**, which is the point. (`UX_DESIGN
   §4.3c` already says the element "reuses `.lu-optimal` geometry" — this makes it literal.)

The 7-starter-row lock (`web.spec.mjs:1234`) is preserved by demotion: a slot is always
filled or falls to the existing `— no eligible player —` branch (`views/lineup.js:118`),
which already emits a `.lu-row`. Neither `.lu-forced` nor `.lu-swapnote` is a `.lu-row`.

### 5.4 `app/views/compare.js`

`metricsFor()` gains `avail: availabilityOf(w, currentWk, currentWk)`. An
**`AVAILABILITY` row goes above `PROJ PTS`** in both columns (both always rendered, so the
centre rail stays row-aligned); an available player renders plain muted `ACTIVE` text, not
a chip. Centre edge chip per `UX_DESIGN §5`. The `evidence` sentence renders in `.cmp-evid`
at the foot of the column **only when `confidence === "explicit"`** — clamped to 3 lines,
quoted, never paraphrased; `confidence === "rule"` gets **no** evidence block, because
there is no report to quote and `LEAGUE MIN` already says so.

**One addition to `UX_DESIGN`, required by ARCHITECTURE Decision D:** Compare shows a
season-long `PROJ PTS` next to a `⊘ IR` chip. Unexplained that reads as a bug, so the
`AVAILABILITY` row carries a one-line hint in the established `.cmp-hint` shape:

> `PROJ is a full-season healthy prior — RoS VALUE is the availability-adjusted number.`

That is true by construction: `rosPoints()` (`app/ros.js:47`) sums the week rows, so it
becomes availability-correct for free the moment the split is fixed. This replaces
`UX_DESIGN §6`'s Players-legend line (Players/Team chips are descoped, §9).

### 5.5 `app/theme.css` — one shared component (`UX_DESIGN §0` settles it)

`.av-chip` + `.av-chip--out` / `--watch` / `--sm`, `.av-glyph`, `.av-dur`, `.av-prov` +
`--report` / `--min`, `.lu-row--unavail`, `.lu-row--forced`, `.lu-forced`, `.lu-swapnote`,
`.lu-gap`, `.cmp-metric--avail`, `.cmp-evid`, `.cmp-evid-lbl`. **Neither `.lu-avail`
(ARCHITECTURE §7) nor `.lu-unavail` (TECH_DESIGN §7) is created.** CSS verbatim from
`UX_DESIGN §2.2`; no new tokens, fonts or breakpoints (reuses the existing `820px`/`560px`).

`--accent` is **forbidden as chip text** (4.28:1 on `--surface-2`, fails AA) — border
graphic only. Six pairings added to `tests/feature/contrast_aa.test.mjs`; the ratios in
`UX_DESIGN §2.3` were independently recomputed and are correct.

---

## 6. Preseason (F7) — separate, capped, decaying, weight 0

Names and constants settled (C9): **`data/preseason_form.json`**,
**`data/contracts/preseason_form.schema.json`**, registry signal **`preseason_form`**,
**`PRESEASON_CAP = 0.03`** (ARCHITECTURE's more conservative bound wins over TECH's 0.05;
TECH's *measured* promotion precondition is kept as the enforcement mechanism).

**No scraper rewrite.** `espn.fetch_scores` / `fetch_final_linescores` already take
`seasontype`; `scripts/build_preseason.py` calls them with `seasontype=1,
weeks=range(1, 5)` (HOF game + PRE1–PRE3), FINAL-gated like everything else.

```
PRESEASON_CAP = 0.03      # |adj - 1| can never exceed 3%
MIN_SNAPS     = 30        # snaps for a full-confidence sample
DECAY_GAMES   = 3         # decays to exactly 0 after 3 FINAL regular-season team games

ratio  = (preseason_ppr / preseason_games) / (prior_season_points / 17)   # None-safe
signal = clamp(ratio, 1 - PRESEASON_CAP, 1 + PRESEASON_CAP)
sample = min(preseason_snaps / MIN_SNAPS, 1.0)
decay  = max(0.0, 1.0 - team_regular_finals / DECAY_GAMES)
adj    = 1 + (signal - 1) * sample * decay
```

`decay` keys on the **player's team's** FINAL regular-season game count (ARCHITECTURE's
form), not a global week counter (TECH's) — byes and postponements make the team count the
honest one. Team finals come from the already-available `espn.fetch_final_results(SEASON)`;
if that is unavailable the builder writes `available: false` with a reason rather than
guessing a decay.

**Properties, each mechanically enforced and each with a test:**

* **Bounded** — clamped in code, and `sample` shrinks it further for a starter who played
  one series. A backup's three-TD preseason cannot outrank a starter who sat.
* **Decays to exactly zero** — at 3 team finals, `adj == 1.0` exactly. Not by convention.
* **Cannot flip a ranking** — twice over: (1) registry weight `0.0`, so
  `applied = 1 + 0 × (adj − 1) = 1.0`; (2) the `--selftest` asserts, against the real
  committed `data/player_projections.json`, that applying `adj` at **full** strength moves
  no top-100 player more than **±2 ranks within his position**. Measured, not assumed.
* **Honest** — zero snaps ⇒ `adj: 1.0`, `reason: "no_preseason_snaps"`; no prior-season
  baseline ⇒ `adj: 1.0`, `reason: "no_baseline"`; no preseason window / feed ⇒ the whole
  document is `{"available": false, "reason": "…"}`. Never a fabricated value, never a
  stale one. `estimate: true` and the three constants ride in the document.
* **Labelled** — a mandatory `caveat` string in the contract so no surface can render the
  number without it: *"Preseason snaps are not true performance — starters sit or play a
  series and everyone is avoiding injury. Capped at ±3%, decays to zero after three
  regular-season games, and currently carries weight 0."*

**Wiring.** `compute_raw_signals` gains
`adjustments["preseason_form"] = player["preseason_adj"]` when that key is present;
`build_predictions` stamps `preseason_adj` onto the records from
`data/preseason_form.json` when the file exists. `_interval_band` must **not** widen on it
— preseason form is a point estimate, not an uncertainty statement. At weight 0 this
changes no number and `signals_used` stays `[]`, so the committed
`player_projections.json` is untouched (verified: `signals_used` is `[]` for all 300 rows
today, and `project_player` only appends a name when `w != 0.0`).

**`build_preseason.py` is NOT invoked from `build_predictions.py`.** It is a standalone
runner-built builder in the `build_injury_history` / `build_player_usage` mould, and
`preseason_form.json` joins `OPTIONAL_DATA`. This keeps the core pipeline's failure
semantics untouched and — critically — keeps `build_predictions.py` a single-owner file.

---

## 7. Projection layer (F4, F6) — normalization boundary, band-only effect

**No reorder of `build_predictions.py`** (C1).

**(i) Normalize at the boundary.** `espn_players.py:119` becomes
`"injury_status": availability.normalize_status(p.get("injuryStatus"))` (canonical code or
`None`). `player_projection.py` re-keys `_INJURY_STATUS` (`:68-76`) onto the canonical
constants and completes it:

```
ACTIVE (1.00, 1.00) · QUESTIONABLE (0.85, 0.95) · DOUBTFUL (0.35, 0.90) ·
OUT (0.00, 1.00) · IR / PUP / NFI / SUSPENDED (0.00, 1.00) · None -> (1.0, 1.0)
```

`_interval_band` (`:184-186`) widens `+0.06` on `QUESTIONABLE`, `DOUBTFUL`, and every
`SEASON_CLASS` code. `None` is neutral — **unknown is not a discount**. The dead `"pup"`
key at `:75`/`:185` becomes live code the moment a feed emits PUP.

**(ii) A second, band-only pass** for the feed that has the free text. Inserted **inside
the existing injuries `try` block**, immediately after the `_write` at `:377`, so a down
injuries feed leaves first-pass projections exactly as they are today and marks
`feeds["injuries"] = "down"`:

```python
n = availability.apply_to_records(players_in, availability.index_report(inj))
if n:
    reprojected = [p for p in project_players(players_in, ctx={"teams": teams_fixture})
                   if p["proj_points"] > 0]
    reprojected.sort(key=lambda p: (-p["proj_points"], p["gsis_id"]))
    if [p["gsis_id"] for p in reprojected[:300]] == [p["gsis_id"] for p in projected[:300]]:
        projected = reprojected
        _write(... player_projections.json ...)
        print(f"injury re-projection (interval bands only): {n} records overridden")
    else:
        print("[warn] injury re-projection changed the top-300 ordering — skipped",
              file=sys.stderr)
```

**The id-order guard is mandatory.** `weekly_contract.test.mjs:40` locks that
`player_weekly.json` mirrors `player_projections.json` id-for-id and in order, and
`build_weekly` runs later at `:587` off `projected[:300]`. At every-weight-zero the order
*cannot* change (`proj_points` is untouched; only `low`/`high` move) — so the guard should
never fire, and if it ever does, that is a real regression and skipping is the honest
response. Cost: one extra in-memory pure pass, no extra network call.

**What actually changes in the numbers:** nothing in `proj_points` (every weight is 0.0),
so `real_data.test.mjs:45-55` (`low <= proj <= high`, `proj > 0`, descending sort) stays
green. What changes is `low`/`high` widening for genuinely uncertain players — the honest,
weight-0-safe half of the fix, and exactly why the season-total reduction has to live in
`build_weekly` instead. **How many weeks an IR player misses is a fact from a feed, not a
learned effect, so it must not sit behind the promotion gate.** What *would* be learned —
"players return from IR at 85% effectiveness" — belongs in `app/ros.js`'s existing
`availW` hook (the registered-but-unimplemented `ros_avail` family), still at weight 0.

---

## 8. `scripts/validate_data.py` — the new cross-file invariant

Beside `check_meta_weights` / `check_pipeline_health`, called from `main()` and folded into
`failures` so the gate keys on the exit code:

```python
def check_weekly_availability(weekly, projections, injuries):
    """1. sum(non-bye pts) == proj_points * available_non_bye / total_non_bye, +/-0.1,
          for EVERY player  (available = non-bye weeks without avail:false).
       2. out_for_season  =>  every non-bye pts is exactly 0.0.
       3. count(weeks with avail:false) == weeks_out          (or all non-bye when
          out_for_season) -- the duration statement and its applied consequence agree.
       4. NO ORPHAN FLAGS: every player carrying `availability` has a matching
          (team, normalized name) row in data/injuries.json whose canonical code equals
          the flagged status. You may not mark a player unavailable without a source row.
       5. model.availability.unavailable == the count of class-"season" players, and
          model.availability.season_points_removed == sum(season_points_lost) +/-0.05."""
```

Rule 4 is the honest-data rule made mechanical: the app can never show an `IR` badge that
no feed backs. Rule 3 is what lets §2 keep a single carrier for blocked weeks.

`tests/smoke.sh` additions (all in the existing consolidated blocks):

```
python3 scripts/availability.py      --selftest || fail "availability selftest"
python3 scripts/injury_duration.py   --selftest || fail "injury duration selftest"
python3 scripts/build_preseason.py   --selftest || fail "preseason selftest"
```

…plus the core invariant: **every `status` in `data/injuries.json` must normalize to a
canonical code**, and the `len(weights) != 32` → `33` edit at `:75` (once — C8).

---

## 9. File ownership — disjoint, with a corrected run order

**Deviation from the brief, with cause:** BUILD-D is specified to run *after* C. It must
run **before** C instead. D's only coupling to C is the signal *name* and the
`preseason_adj` key, both frozen in this document — no code dependency. But C is the
integrator: it registers the signal (`registry.py`, `meta.json`, `EXPECTED_SIGNALS`,
`smoke.sh`, `signal_registry.test.mjs`) and wires `smoke.sh` to run
`build_preseason.py --selftest`. If C lands first, the gate is **red** between C and D
(smoke calls a module that does not exist; the weights count disagrees with a meta.json
whose signal has no builder). Running C last makes every landing individually green.

```
   ┌── BUILD-A (pipeline) ──┐
   ├── BUILD-B (app)     ───┤ ── all three concurrent ──►  BUILD-C (integration, last)
   └── BUILD-D (preseason)──┘
```

C depends on A (imports `scripts/availability.py`, validates A's regenerated data) and on
D (registers D's schema and selftest). A, B and D share no file with each other.

### BUILD-A — pipeline / python feeds

| File | Action |
|---|---|
| `scripts/availability.py` | **new** — vocabulary, `normalize_status`, `WEEK_CLASS`/`SEASON_CLASS`, `MIN_WEEKS_OUT`, `enrich`, `index_report`, `apply_to_records`, `--selftest` |
| `scripts/injury_duration.py` | **new** — §4, `--selftest` |
| `scripts/build_weekly.py` | edit — §3.1-3.3 + docstring rewrite |
| `scripts/scrape/espn.py` | edit — `fetch_injuries()` emits the enriched row + `FeedError` on an unmapped status |
| `scripts/build_injury_history.py` | edit — **assertion only**, output byte-identical (§3.4) |
| `data/injuries.json` | **regenerate** — pure offline transform of the committed 800 rows (no network) |
| `data/player_weekly.json` | **regenerate** — surgical, §9.1 |
| `data/contracts/player_weekly.schema.json` | edit — must land **with** the data |
| `tests/feature/weekly_contract.test.mjs` | edit — the one legitimate lock change, §9.2. Lands with the data that makes it necessary. |
| `tests/feature/availability.test.mjs` | **new** — python-driven (the `weekly_injury.test.mjs` `python3 -` pattern) |

### BUILD-B — app surfaces (owns all of `app/`)

`app/availability.js` (**new**), `app/lineup.js`, `app/views/lineup.js`,
`app/views/compare.js`, `app/render.js` (`renderAvailChip`, beside `renderTrendChip`/
`renderSos`), `app/theme.css`, `tests/feature/availability_app.test.mjs` (**new**),
`tests/feature/contrast_aa.test.mjs` (+6 rows), `tests/web/web.spec.mjs` (**append new
cases only — do not modify an existing assertion**).

**Descoped from `UX_DESIGN`:** no chip on `app/views/players.js` or `app/views/team.js`
this release, and therefore no Players legend line (its honesty job moves to the Compare
hint, §5.4). Rationale: those two views are not in the brief's file list, and the only
in-app affected player is a WR whose Players card would gain a chip with no availability-
adjusted number beside it. Ranking on adjusted points is the Rel18 candidate that makes
that surface coherent.

B builds against the §2 contract, not against A's output — so it can run before A lands.

### BUILD-C — integration (last)

`scripts/build_predictions.py`, `scripts/models/player_projection.py`,
`scripts/scrape/espn_players.py`, `scripts/validate_data.py`, `scripts/signals/registry.py`,
`data/meta.json`, `data/contracts/injuries.schema.json` (**new**), `tests/smoke.sh`,
`tests/feature/signal_registry.test.mjs`.

### BUILD-D — preseason

`scripts/scrape/espn_gamestats.py` (verify/document `seasontype` pass-through — no
signature change needed), `scripts/build_preseason.py` (**new**),
`data/contracts/preseason_form.schema.json` (**new**), `data/preseason_form.json`
(**new** — the honest `available: false` document if the feed is unreachable),
`tests/feature/preseason.test.mjs` (**new**).

**No file appears twice.** `data/contracts/` is split at file granularity: A owns
`player_weekly.schema.json`, C owns `injuries.schema.json`, D owns
`preseason_form.schema.json`.

### 9.1 Regenerating `data/player_weekly.json` without the network

`build_weekly_document` needs elos and receptions that come from live feeds, so a full
rebuild is not reproducible in the sandbox — and would churn all 300 rows. It is also
unnecessary. Because the renormalization is a **uniform** rescale, the new split is
derivable from the committed one exactly:

```
committed_i = raw_i * (season / sum_all raw)      =>   raw_i  ∝  committed_i
new_i       = committed_i * (target / sum_available committed_j)
```

So: zero the blocked weeks, multiply the surviving non-bye weeks by
`target / sum(surviving committed pts)` where `target = proj_points * available / non_bye`,
re-round to 2dp, add the `availability` block and `avail:false` flags, add
`model.availability`. Pearsall is unshaped (`Injured Reserve` is not in `INJURY_MULT`), so
there is no shaping interaction.

**Expected committed diff — verified by computation, and the acceptance check for A:**

* affected players: **1** (`espn-4428209`, Ricky Pearsall, SF WR, `proj_points` 88.6)
* bye week 8; 17 non-bye weeks; blocked = weeks **1, 2, 3, 4** (`MIN_WEEKS_OUT`)
* target = 88.6 × 13/17 = **67.75**; rescale factor **1.000339**; rounded sum **67.73**
  (inside the ±0.1 contract tolerance)
* `season_points_lost` = **20.87**
* new week values: wk1-4 → `0.0` + `"avail": false`; wk5-18 →
  `4.45, 5.63, 5.16, [bye], 5.98, 5.33, 5.19, 4.63, 5.41, 4.84, 4.97, 5.32, 5.22, 5.60`
  — i.e. **most 2dp values are unchanged**; the scale is ~1.0003
* `model.availability = {applied: true, vocab_version: 1, unavailable: 1,
  season_ending: 0, min_weeks_rule: 4, season_points_removed: 20.87}`
* plus 9 week-class players gain a 2-key `availability: {status, class: "week"}` block

`git diff --stat data/player_weekly.json` must show only those hunks. Anything else is a
bug in the regeneration, not an improvement.

### 9.2 The ONE existing lock that changes — `tests/feature/weekly_contract.test.mjs:83-93`

`'non-bye weekly points sum to the season projection within 0.1'` runs over the committed
files and asserts `|sum − proj_points| <= 0.1` for **every** player. Pearsall's zeroed
weeks make it red — correctly, because **the assertion in its current form encodes F2.**

Replacement (keep the file, keep the other five tests, rename to
`'…sum to the AVAILABILITY-ADJUSTED season projection'`):

```js
weekly.players.forEach((p, i) => {
  const season = proj.players[i].proj_points;
  const sum    = p.weeks.reduce((a, w) => a + (w.bye ? 0 : w.pts), 0);
  const nonBye = p.weeks.filter((w) => !w.bye).length;
  const blocked = p.weeks.filter((w) => !w.bye && w.avail === false).length;
  const a = p.availability || null;

  if (!a || a.class !== 'season') {                 // healthy / week-shaped only
    assert.ok(Math.abs(sum - season) <= 0.1, ...);  // UNCHANGED law, verbatim
    return;
  }
  if (a.out_for_season) {
    assert.equal(sum, 0, `${p.gsis_id}: out for season must carry 0 points`);
    return;
  }
  const avail = nonBye - blocked;
  assert.ok(Math.abs(sum - season * (avail / nonBye)) <= 0.1, ...);
  assert.ok(sum < season - 0.1,        // the reduction REALLY happened
    `${p.gsis_id}: flagged unavailable but the season total did not drop`);
});
```

Why this is legitimate and **strictly stronger**, not a weakened lock:

* the invariant the old test actually protected — *"the tilt redistributes; it never
  inflates or leaks"* (its own comment at `:84`) — survives verbatim. The sum is still
  pinned exactly, to a target that is now a function of games the player can play;
* the healthy path (299 of 300 rows today) keeps the original assertion character for
  character;
* the affected path gains `sum < season − 0.1`, so the test **cannot silently pass on a
  no-op** — the exact failure mode that let F1/F2 ship;
* keeping the old form would keep asserting that a player who will not take a snap in 2026
  still carries 100% of his season points.

### 9.3 Tests that must stay green **unmodified** — if one goes red, the build is wrong

* `tests/feature/weekly_injury.test.mjs` — **all five.** `:61` (`INJURY_MULT` verbatim),
  `:69` and `:146` (mechanic (a): season total preserved to 1e-6 / injury_shape meta),
  `:107` (the join; `Active` must still drop), `:122` (absent/empty/all-Active ⇒
  byte-identical document). These are the proof the correct half of the system was not
  disturbed. `unavailable_weeks == 0` makes the code path numerically identical. **Do not
  "fix" them.**
* `tests/feature/lineup.test.mjs` — all five (no row sets `playable`).
* `tests/feature/team_logic.test.mjs:138-149` — `weeklyPoints` rescales by
  `seasonAdj / seasonPpr`, a *proportional* ratio, so a reduced weekly sum passes through
  and PPR↔Standard conversion stays correct.
* `tests/feature/real_data.test.mjs:45-55` — bands widen symmetrically, `proj_points` is
  unchanged, the sort is reapplied under an id-order guard.
* `tests/feature/team_rel2.test.mjs`, `tests/feature/team_vor.test.mjs`,
  `tests/feature/ros.test.mjs`.
* `tests/web/web.spec.mjs:1209-1305` — 7 `.lu-row` starter rows; `.lu-move, .lu-optimal`
  ≥ 1 (preserved by §5.3's `lu-optimal lu-gap` class pair); compare deep-link and finder.

---

## 10. Open decisions for the owner (each with a recommendation)

1. **`MIN_WEEKS_OUT = 4` for IR/PUP/NFI with no parsed duration.** **Recommend: adopt.**
   New evidence that was not available to the architect: Pearsall is the *only*
   season-class player in the top 300 and he is a null parse — so **without this floor,
   Rel17 changes nothing on disk and F1/F2 remain shipped in practice.** The alternatives
   are (b) zero nothing without a parsed duration (maximally literal, but leaves every
   current IR player startable — the bug we are fixing), or (c) treat any IR as
   season-ending (overstates for designated-to-return players).
2. **`proj_points` stays the full-availability prior; the adjusted number is RoS.**
   **Recommend: adopt.** Haircutting `proj_points` would re-rank VOR, auction values, ADP
   joins and the draft simulator in one release with no coverage for those interactions.
   `rosPoints()` already sums week rows, so RoS becomes correct for free everywhere.
   Compare's hint line (§5.4) is where this is made honest to the manager.
3. **Preseason: cap 3%, decay over 3 team finals, `sample` confidence scaling.**
   **Recommend: adopt** (ARCHITECTURE's bound + TECH's sample term + TECH's measured
   ±2-rank promotion precondition). At weight 0 none of these change a number today; the
   cap only bounds what a future promotion could do.

---

## 11. Regression gate

Unchanged commands, run in order, gated on **exit codes**:

```
cd /home/user/nfl2026
python3 scripts/validate_data.py
bash tests/smoke.sh
node --test tests/feature/*.mjs
PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test --config tests/playwright.config.mjs
```

> **Gate-command correction.** The brief's step 3 reads
> `node --test tests/feature/*.mjs tests/competition.test.mjs`. **`tests/competition.test.mjs`
> does not exist anywhere in the tree** (`tests/` holds only `feature/`, `web/`, `pwa/`,
> `smoke.sh`, `run_gate.sh`, `playwright.config.mjs`), and `node --test` errors on a missing
> path — so that command cannot pass as written. The authoritative gate is
> `tests/run_gate.sh` (`npm run gate`), whose step 3 is `node --test tests/feature/*.mjs`.
> Use that. Do not create a stub file to satisfy the typo.

Baseline 235 unit / 75 e2e must stay green, plus the new cases, with exactly one existing
assertion rewritten (§9.2) and its rewrite justified there. Every agent runs the full gate
before handing off; C runs it last with all four agents' work on disk.
