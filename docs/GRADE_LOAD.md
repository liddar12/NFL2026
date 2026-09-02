# GRADE · LOAD LEAGUE — one press, one pass (R52)

Files: `app/views/grade.js` (the view), `app/sleeper.js` (`loadSleeperPlayerIndex`, R52-S),
`tests/feature/r52_grade_load.test.mjs`, `tests/web/r52_grade_race.spec.mjs`.

## The defect

Owner's RCA, desktop Safari, intermittent: on GRADE, type the league id, press
LOAD LEAGUE. Sometimes the ten team cards and the standings appear; sometimes
the panel just shows the league header again as if nothing happened. A page
refresh and a second press then works every time.

## Root cause

R47 made a LOAD on GRADE a league sync for the whole session. To let the view
pick up the freshly saved league (roster shape, K/DEF pool, scoring), the LOAD
was a **two-pass** path:

1. `loadSleeperLeague` → `syncLeagueSettings` saves the league profile.
2. If the saved profile **changed** (always true on a fresh device), the code set
   a module flag `pendingAutoload = true`, called `remount()` — which was
   `mountGrade(el)` **directly, bypassing the router's `navSeq` guard** — and
   returned.
3. The new mount was expected to see the flag and load again on its own.

Two async mounts of the same element were then alive at once: the original
mount's closures (its `leagueOut` panel, its `pool`/`projOf`/`shape`) and the new
mount's. The flag was consumed by whichever mount reached it first, and the
load result was painted into a panel (`out`) that the other mount had since
replaced with a fresh form. The user saw the form with the league header and
no cards. The refresh "fixed" it only because the profile was then already
saved, so the sync reported no change and the load ran in a single pass.

Two side effects made it worse: every pass re-downloaded Sleeper's ~5 MB
player dump (twice per first LOAD), and the Playwright suite never saw the race
because its Sleeper mocks answer instantly, leaving no window for it.

## The single-pass design

Everything the view derived from the saved profile inside `mountGrade` — the
lineup shape from `roster_positions`, `weeklyById = withLeagueExtras(weeklyRaw,
profile)`, the K/DEF index / rows / pool, `projOf`, `engineCtx`, the K/DEF note
— now lives in one exported, pure function:

```js
deriveLeagueContext(profile, { offencePool, weeklyRaw, kdstDoc, scoring })
  -> { shape, starterTokens, weeklyById, kdstIndex, kdstRows, kdstNote,
       pool, feeds, hasK, scoring, projOf, engineCtx }
```

The docs are passed in, never fetched: the mount reads the projection and
weekly feeds once, and reads the K/DEF doc lazily at most once per mount (only
for a league that seats K/DEF — a sync that adds those seats reads it then).

`mountGrade` derives the context once and keeps it in a closure `ctx`. The LOAD
receives a `host` contract — `ctx()`, `rederive()`, `stale()` — instead of a
`remount` callback. After `syncLeagueSettings` reports a changed profile, the
**same** `loadSleeperLeague` call does `await host.rederive()` (re-derives `ctx`
in place from the new saved profile and repaints the paste box's "assumptions"
line) and continues with the league, rosters and users payloads it already
holds. Nothing is re-fetched, nothing remounts, `pendingAutoload` is gone.
Grading reads `host.ctx()` once, after every await that could have changed it;
the paste grader (`#gr-go`) reads the same current `ctx`, so a pasted team is
priced under the synced league too. The `nfl2026:league` chip event is still
dispatched from the sync.

## The mount guard

A module-level `mountSeq` is incremented at the top of every `mountGrade`; the
mount captures `const seq = mountSeq`. At every await boundary that writes DOM
it bails when `seq !== mountSeq || !el.isConnected` — one `console.debug`, no
user-facing text. Inside the LOAD every write goes through `paint(html)`, which
asks `host.stale()` first; `stale()` is true when the mount is superseded, when
the output panel has left the DOM (the user navigated away — the router repaints
`#view`, detaching `#gr-league-out`), or when a **newer LOAD on the same mount**
has started (a per-mount `loadSeq`; the LOAD button is also disabled while one
runs). A LOAD in flight when the user navigates away writes nothing; the R49
idle Sleeper fill checks the same guard on top of its own token.

## The player dump, once per session

`draftLive.getJson(PLAYER_INDEX_URL, …)` is replaced by
`sleeper.loadSleeperPlayerIndex({ onProgress })` (R52-S in `app/sleeper.js`):
the built index is memoised for the session, failures are not memoised, the
body is streamed with progress. The loading state reads
"Reading Sleeper's player list… 2.1 MB" (bytes / 1e6 to one decimal) and
"cached" when served from the memo. The `draft-live` import is gone from
`grade.js` (nothing else in the file used it).

## The relabel and the per-week view

The standings, the letter grade and the headline number all use the
**weekly-optimal** season total (`grade-weekly` `teamWeekPoints` /
`bestLineup`: the best legal lineup each week from the full roster, bench
substituted). The card header used to say "SEASON-OPTIMAL STARTERS · projected
season pts" above that number — a different lineup's label on the standings'
number. Now the card reads, in order:

- `WEEKLY-OPTIMAL TOTAL · best legal lineup each week, bench substituted` with
  the season total the standings use, percentile and bench count;
- the sim row (playoffs / title / avg wins / PF / PA);
- the fold **Week by week · starters, bench and SUBs · N weeks** — the real
  per-week view: for each week, `STARTERS` (slot · name · pts) then `BENCH`
  (BN · name · pts), an `EMPTY` row for an unfillable slot, `BYE` / `OUT` /
  `NO PROJECTION` / `SEASON AVG` (K/DEF) tags, and the week total in the
  header (with the R49 Sleeper cell);
- `SEASON-OPTIMAL STARTERS · one fixed lineup all season · NOT what the
  standings use` with the R49 OURS · SCENARIO · SLEEPER line (it prices exactly
  those starters, and stays visible because R49's spec asserts on it), and the
  fold **Season-optimal starters · N slots · not the standings number** holding
  the list.

Decision: the season-optimal starters list was **moved into a fold, not
dropped**. Dropping it would have left the R49 estimate line pricing a lineup
the user can no longer see, and R48b's RCA ("cards without player names")
wants the names one tap away. The fold has one summary line of clutter.

**SUB marker**: the roster payload from `importSleeperTeams` / `mapRosters`
carries `starters` (Sleeper's own slot-ordered starter ids, `players` is the
whole roster). The loader maps those Sleeper ids to app ids through the same
crosswalk it grades with, and a seated player whose app id is not among them
gets `SUB`. This is Sleeper's **current** starters list at load time — Sleeper
does not publish past or future weeks' lineups — and the method notes say so.
When a payload has no `starters` list the set is `null`, nothing is marked, and
the fold summary says "SUB not marked (Sleeper's starters unknown)".

## What the race spec proves

`tests/web/r52_grade_race.spec.mjs` reuses the R48 routes and P.T.I. fixtures
but delays them the way the network does — the player dump at 1500 ms, rosters
at 800 ms, each matchups week at a random 100–600 ms — on a **fresh** profile,
so the first press's sync changes the saved league (the path that used to
remount). Run with `--repeat-each 3`:

1. One press: ten cards and the standings appear (30 s), the LEAGUE chip shows
   `LEAGUE: P.T.I. … SLEEPER`, a window marker survives (no reload), the typed
   id is still in the box (no remount), the dump and rosters were fetched once,
   the button was disabled during the load and enabled after.
2. A double-press: exactly one set of ten cards, one standings table, one
   "loaded" note, the standings last; still one of everything 1.5 s later.
3. Navigate to `#/players` 200 ms after LOAD: after 4 s nothing GRADE-shaped is
   in the players view; back on GRADE the form is clean (no cards, no error
   state, remembered id) and a fresh press works first time.

`tests/feature/r52_grade_load.test.mjs` locks the rest in node: the pure
`deriveLeagueContext`, the absence of `pendingAutoload` / any remount call /
the draft-live dump path, the guard in source, two concurrent `mountGrade`
calls on one element painting the form exactly once, the labels, and the
per-week view (STARTERS, BENCH, EMPTY, SUB, week total, SEASON AVG) from a
fixture week.
