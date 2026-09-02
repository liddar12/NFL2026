# TEAM · SYNC NOW — one press, one mount (R52)

## The defect

Owner's RCA, desktop Safari, intermittent: on TEAM, **SYNC NOW** sometimes
seated the roster and sometimes left the tab showing the league header only,
as if nothing had happened. A refresh and a second press then worked. Every
press also downloaded Sleeper's ~5 MB `/players/nfl` dump again.

## Root cause

`app/views/team.js` (R48) did this on SYNC NOW:

1. `importFromSleeper(id)` → `saveProfile` / `saveLeagueId` / scoring mode.
2. Set the module flag `pendingAutoRoster = leagueId`.
3. Call `mountTeam(el)` **directly** — bypassing the router's `navSeq`
   guard and its serialised mount queue in `app/main.js`.
4. The *new* mount was expected to reach its tail, see the flag, and call
   `runRosterSync()`.

`mountTeam` is async (it awaits eight feeds before it paints). Nothing stopped
two mounts of the same `#view` element from being alive at once: the one the
router started, the one SYNC NOW started, and — with a fast second press or a
tab change — a third. Whichever mount reached the tail first consumed the flag;
if that was not the mount whose DOM was still on screen, the roster read ran
against nodes another mount had already replaced, and the visible view stayed
at "league header only". The R25 teardown (`AbortController` per mount) only
unbinds listeners; it never cancelled a continuation already past an `await`.

## The single-pass design

SYNC NOW no longer remounts. After the save it **adopts the profile in the
same mount** and continues straight into the roster read:

```
saveProfile → saveLeagueId → LEAGUE chip event
→ adoptSavedProfile(importProfile, wrote)   // in place
→ leagueStatus = "Synced and SAVED …"
→ paintAll()
→ runRosterSync()                           // same mount, same closures
```

`pendingAutoRoster` and the `mountTeam(el)` at the SYNC NOW site are deleted
(and the mount tail no longer starts a roster read).

### What "adopt in place" recomputes

Everything a fresh mount derives from `loadProfile()` was lifted out of the
mount body into one module-level function, `deriveLeagueState({ savedProfile,
players, weeklyBase, kdstDoc, mode })`:

| derived                                              | why it depends on the profile                       |
| ---------------------------------------------------- | --------------------------------------------------- |
| `weeklyById` (stamped copy of the unstamped base)    | `withLeagueExtras` prices the league's extra rules  |
| `kdstSeatTokens`, `kdstRows`, `seatable`             | only a league fielding K/DEF/DST seats them          |
| `playersById`, `adjById`, `scaledById`               | priced under the (possibly re-locked) scoring mode  |
| `sortedPlayers`, `sortedKdst`, `kdstChips`           | finder order + the league's extra chips             |
| `kdstUnresolvedSlots`, `roster`                      | the saved roster under the profile's slot vocabulary |

The mount holds these as reassignable state and (re)assigns them through
`applyLeagueState()`, which also drops the OURS price memo (`_ourDollars`,
keyed on shape and money only — the R30c lesson). `adoptSavedProfile(profile,
wrote)` then does what the mount's top does: `savedProfile = wrote ?
loadProfile() : normalizeProfile(profile)` (so "applies to this page only" is
finally true when storage is blocked), reseeds `stagedProfile` /
`carriedTokens` / `clampedNotes` / `draftCfg`, re-reads the scoring `mode`,
calls `applyLeagueState()`, and rewrites the header's scoring label.

The node test proves the in-place derivation equals a fresh mount's for the
P.T.I. fixture profile (`tests/feature/r52_team_sync.test.mjs`) — same
function, same feeds, same output — and that the profile is a real input
(the default profile derives a different pool).

One deliberate difference from the old remount: an open draft/auction room and
the live companion **survive** SYNC NOW / RE-APPLY / SAVE now, as they already
did on a same-mode SAVE. The remount used to discard them silently.

## The mount guard

```js
let mountSeq = 0;                       // module level
…
const seq = ++mountSeq;                 // top of mountTeam
let shell = null;                       // this mount's #t-syncbar, once painted
const stale = (where) => {
  if (seq === mountSeq && el.isConnected && !(shell && !shell.isConnected)) return false;
  console.debug(`team: mount #${seq} superseded at ${where} — nothing written`);
  return true;
};
```

`stale()` is asked after every `await` that writes DOM on the sync path:

- the feeds `Promise.allSettled` (before the shell or an error state paints);
- `runRosterSync`: after `/rosters`+`/users`, after the player list, inside
  every progress tick, after the NFL-week read, and in the deferred scroll;
- the SYNC NOW continuation (`.then` **and** `.catch`) and both roster-sync
  failure handlers.

The `shell` anchor matters because the router paints every view into the same
`#view` element: `el.isConnected` alone cannot tell that PLAYERS now owns it.
A superseded SYNC NOW continuation writes **nothing** — DOM or storage; the
press belonged to a view that is gone and the next press repeats it.

## Per-site remount audit

| site (act)                     | before                          | now                                                      | why |
| ------------------------------ | ------------------------------- | -------------------------------------------------------- | --- |
| `sleeper-sync` (SYNC NOW)      | flag + direct `mountTeam(el)`   | **in place**: `adoptSavedProfile` → `paintAll` → `runRosterSync` | the defect itself; the mount holds every input |
| `restart-session`              | direct `mountTeam(el)`          | `remount()`                                              | storage the derived state was built from was cleared; the R30c lesson is that a hand-cleared list of that state goes stale |
| `reset-all`                    | direct `mountTeam(el)`          | `remount()`                                              | same: factory wipe, rebuild from empty storage |
| `league-reapply` (RE-APPLY)    | `leagueFlash` + `mountTeam(el)` | **in place**: `adoptSavedProfile(parked, wrote)` → `leagueStatus` → `paintAll` | a profile write + re-price, exactly SYNC NOW's shape; the stash strip hides itself because stash == applied |
| `league-save` (mode change)    | `leagueFlash` + `mountTeam(el)` | **in place**: `adoptSavedProfile(next, wrote)` → `leagueStatus` → `paintAll` | same; the same-mode branch now also re-derives, so a newly saved K slot has kickers to seat without a reload |

`remount()` is the one remount path: it bumps `mountSeq` **first** (retiring
every continuation of the current mount) and then calls `mountTeam(el)`. It is
called from exactly two places. `leagueFlash` survives only for those two.

## The player dump, once per session

The view's own `sleeperGetJson` + `SLEEPER_INDEX_TIMEOUT_MS` are gone; the
view fetches nothing itself. `runRosterSync` calls
`loadSleeperPlayerIndex({ onProgress })` from `app/sleeper.js` (b414a22):
memoized for the session, `cache: 'default'` so the browser keeps the body,
streamed, failures never memoized. The sync banner shows
"Reading Sleeper's player list… 2.1 MB" while it streams (a targeted text
update of `.sync-bar-prog`, guarded), and the status notes say
"Sleeper's player list: cached from earlier this session." when the memo
served it, or "… 4.9 MB read." otherwise. `SLEEPER_PLAYER_INDEX_URL` stays
exported as the loader's own `PLAYER_INDEX_URL` (a contract test pins it).
The mount-scoped `sleeperIndex` is kept because `buildRosterPlan()` and the
draft companion (`getIndex`/`setIndex`) read it by reference; it is now
assigned from the loader's result.

## What the race spec proves

`tests/web/r52_team_race.spec.mjs` (project `web`, run `--repeat-each 3`)
reuses r48's P.T.I. fixtures and route with **delays**: `/players/nfl`
1500 ms, `/rosters` 800 ms, `/users` 400 ms — so every await boundary on the
path is crossed while other things can happen. On fresh keys:

1. **One press**: settings land in place (chip, id field, "Synced and SAVED"
   status), the banner shows the player-list progress line, the picker
   appears, picking seats 12 of 14 with `nfl2026.myroster.v1 = {id: 4}` —
   with a `window` marker proving no reload and no second press.
2. **Double press**: two quick clicks → one `#t-syncbar`, one picker, one
   seated banner, one "roster seated" status, one "Synced and SAVED" status.
3. **Navigate away** to `#/players` 200 ms after the press, wait past every
   delay: no `#t-syncbar`, `.sync-bar`, `.roster` or `#t-draft` inside
   `#view`, the PLAYERS cards intact, and a `team: mount #N superseded at …`
   debug line; back on `#/team`: one shell, one empty banner slot, the saved
   league in the chip and the field, and the same mount then completes a
   full press cleanly.

## Pins moved

- `tests/feature/r48_team_sync.test.mjs`: the hand-off pin now asserts the
  absence of the flag and the remount, and the in-mount continuation.
- Three files outside this partition still pin the old shape and need a
  one-line move each (see the R52 report): `tests/feature/r30c_minors.test.mjs`
  and `tests/feature/r34_reset_theme.test.mjs` expect the literal
  `mountTeam(el)` inside the RESTART / RESET ALL branches (now `remount()`),
  and `tests/feature/team_roster_sync.test.mjs` expects two `sleeperGetJson(`
  occurrences (now none — the view fetches nothing itself).
