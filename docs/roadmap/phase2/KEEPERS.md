# Keeper Support — Draft Room (Phase 2 Design)

Status: SCAFFOLD (design + backlog only — do not build from this doc).
Scope: NON-BETTING. Market prices remain display-only. No login/commissioner,
no build step/framework. 13" iPad TEAM layout. Extend the existing draft
engine — do not rebuild it.

Standing rule honored: keepers are a *pre-draft configuration of who is already
rostered and what it cost*. They are pure roster/pool state and auction dollars —
never a market-price input to any model.

---

## 1. Problem & goal

Keeper leagues start the draft with some players already retained by specific
teams at a known cost (draft round in snake, dollar salary in auction). Today the
draft room assumes an empty board. Keepers must:

1. Remove kept players from the available pool (they can't be drafted again).
2. Pre-fill the rosters of the teams that kept them.
3. Reprice everything the removals touch: VOR/replacement levels, the ADP board
   ranking, "best pick now", and — in auction — league inflation and each team's
   remaining budget.
4. In snake, consume the forfeited draft pick so the draft order is correct.

The engines that already do the underlying math are reused verbatim; keepers are
an *input layer* in front of them.

## 2. Existing engine surfaces we extend (reuse, do not rebuild)

| Module | What it already does | How keepers plug in |
|---|---|---|
| `app/views/team.js` | Draft room UI: finder, reco/roster panels, `taken` set (persisted `nfl2026.taken.v1`), live sync. Instantiates the room via **two separate constructors**: snake = `createDraft({…})` (draft-sim), auction = `createAuction({…})` (auction). There is NO shared `createDraft(config)` for both. | Add a pre-draft **Keeper Setup** step; seed the room at construction: snake via `createDraft`'s native `excludedIds` param + `forfeitedPicks`; auction via pre-filtered `boardRows` + per-team pre-spend |
| `app/auction.js` | Pure auction engine: `createAuction`, `inflation(remainingBudget, remainingFairSum)`, `liveInflation(a)`, nominations. Every team starts at the uniform `budget`. | Accept an optional per-team pre-spend so a keeper's owner starts at `budget − Σ salaries`. Keeper *value* is removed automatically by dropping keeper rows from `boardRows` (that shrinks `remainingFair`); no separate "preRemovedValue" param is needed |
| `app/team-logic.js` | `vorScore(candidate, pool, …)`, `replacementLevel(pool, …)`, `recommend`, `bestPickNow` — all take the pool as an argument | **No change.** VOR/replacement already read whatever pool is passed; feed the keeper-reduced pool and the smaller-pool VOR falls out. (`scoreVsRoom` lives in `draft-sim.js`, not team-logic.js.) |
| `app/draft-sim.js` | Snake sim. Turn order is `snakeTeam(pick, leagueSize)` — a **pure positional function**, not an editable order array. `createDraft` already accepts `excludedIds`. `scoreVsRoom` also lives here. | Add optional `forfeitedPicks`; `onTheClock`/step logic auto-consumes a forfeited `{teamSlot, round}` slot (pre-rostering the keeper) instead of prompting a live pick. More than a one-line skip — see risk note |
| `data/player_weekly.json`, `data/player_history.json`, `data/team_strength.json` | Projections / history / strength inputs | Read-only; keeper cost is *not* derived from these, it is user-entered |

No new engine. Keepers are a config object + a small pure `app/keepers.js` adapter
that transforms that config into the inputs the engines already accept.

> **Cross-check note (verified against `nfl2026` source):** the app dir is flat
> (`app/*.js`), so the adapter is `app/keepers.js`, not `app/draft/keepers.js`
> (there is no `app/draft/`). Snake and auction are built by two different
> constructors (`createDraft` vs `createAuction`); `createDraft` already has a
> native `excludedIds` param, `createAuction` does not. `team-logic.js` needs no
> change. Corrections below reflect the real interfaces.

## 3. Design

### 3.1 Data model — keeper config

Keepers persist client-side in a new `nfl2026.keepers.v1` localStorage key
(matching the existing `nfl2026.*.v1` convention: `team.v1`, `taken.v1`,
`scoring.v1`, `ai.v1`). Note: `createDraft`/`createAuction` are constructed
transiently in `team.js` from an in-memory `roomOpts` object — there is no
persisted "draft config" today, so keepers get their own key. No server, no
login. One array:

```js
// draft config addition
keepers: [
  {
    playerId: "P1234",     // must resolve in players.json / current pool
    teamSlot: 3,           // 0-based index of the keeping team in the draft
    format: "auction",     // "auction" | "snake" (matches draft.format)
    dollars: 42,           // auction only — salary that counts against budget
    round: 6               // snake only — round whose pick is forfeited
  }
]
```

Only the field for the active format is required; the other is ignored.
`format` on each keeper is validated against the draft's format at load.

### 3.2 Pipeline: config -> engine inputs

New pure module `app/keepers.js` (no DOM, unit-testable) exposes:

- `validateKeepers(keepers, draft) -> { ok, errors[], warnings[] }`
- `applyKeepers(pool, draft, keepers) -> { pool', excludedIds, rosters, budgets, forfeitedPicks }`

`applyKeepers` is the single choke point. It:

1. **Pool** — moves each `playerId` out of the available pool into that team's
   roster. Snake: pass keeper ids to `createDraft`'s native `excludedIds` param.
   Auction: `createAuction` has no `excludedIds`, so pre-filter the keeper rows
   out of `boardRows` before construction. team.js's persisted `taken` set
   (`nfl2026.taken.v1`) also excludes them from finder/reco. Same visible effect,
   two mechanisms.
2. **VOR / ADP / bestPickNow** — no keeper-specific math. `vorScore` and
   `replacementLevel` already take the pool as an argument, so feeding `pool'`
   (keepers removed) makes replacement level and VOR reflect the smaller pool for
   free — removing 3 RB keepers lifts RB VOR for everyone. ADP board re-ranks
   over `pool'`. **No `team-logic.js` change.**
3. **Auction budgets** — set the owning team's starting budget to
   `budget − Σ keeper.dollars` before pick 1. `createAuction` currently starts
   every team at the uniform `budget`, so this needs an additive optional
   per-team pre-spend input.
4. **Auction inflation** — `auction.js` exposes `inflation(remainingBudget,
   remainingFairSum)` and `liveInflation(a)`. Value is removed automatically:
   dropping keeper rows from `boardRows` (step 1) shrinks `remainingFair`; the
   per-team pre-spend (step 3) shrinks the remaining budget. A keeper kept *below*
   its fair `$` removes more value than dollars -> inflation rises for the rest of
   the room, and vice-versa — the engine's existing identity, fed correct seeds.
   No formula change and no separate "preRemovedValue" param.
5. **Snake picks** — emits `forfeitedPicks: [{teamSlot, round}]` for `createDraft`.
   Because turn order is the pure positional `snakeTeam(pick, leagueSize)` (no
   editable order array), `onTheClock`/step logic must auto-consume the forfeited
   slot (pre-rostering the keeper) rather than "skipping" an array entry — a real
   engine change, not a one-liner (see §6 and the file plan risk).

### 3.3 UI flow (13" iPad TEAM layout)

A **Keeper Setup** panel precedes "enter draft room", reachable from the draft
config screen. Reuses the finder component to pick a player, a team selector, and
a cost field whose type flips with `draft.format` (dollars vs round). Kept players
appear on the "taken" board pre-marked with a small "K" chip and the owning team,
using the board's existing rendering — no new board. A summary line per team shows
kept count, Σ dollars (auction) or forfeited rounds (snake), and remaining budget.
Setup is editable until the first live pick, then locked.

### 3.4 Snake vs auction — the real differences

| Concern | Snake | Auction |
|---|---|---|
| Cost unit | A draft pick (round) | Dollars against the budget |
| Engine input | `forfeitedPicks` -> `draft-sim.js` | `spent` + removed value -> `auction.js` inflation |
| Over-cost failure | Two keepers forfeit the *same* round for one team; or more keepers than the team has picks | Σ keeper dollars > team budget (can't afford own nominations) |
| Reprice effect | Pool shrink lifts VOR only | Pool shrink + budget/inflation shift |
| Board | "K" chip + round badge | "K" chip + salary badge |

Keeper cost is user-entered in both formats — the tool never invents a keeper
"price" from projections or market data (standing rule).

## 4. Backlog

### EPIC K1 — Keeper configuration & persistence
- **K1.1** As a user I add a keeper by selecting a player, a team, and a cost.
  - AC1: Finder search returns only players currently in the pool; selecting one
    stages it as a keeper for the chosen team.
  - AC2: Cost field renders dollars when `draft.format==="auction"` and a round
    selector when `"snake"`.
  - AC3: The keeper persists in draft config across reload (localStorage), with no
    network/login call.
- **K1.2** As a user I edit or remove a keeper before the draft starts.
  - AC1: Removing a keeper returns the player to the pool and reverses all repricing.
  - AC2: Keeper setup is read-only after the first live pick is recorded; the UI
    shows a locked state.

### EPIC K2 — Pool, VOR & ADP repricing
- **K2.1** As a user, kept players never appear as draftable.
  - AC1: Every keeper `playerId` is in `excludedIds`; finder, reco, and
    `bestPickNow` never return a kept player.
  - AC2: The "taken" board shows each keeper with a "K" chip and owning team.
- **K2.2** As a user, VOR/ADP reflect the reduced pool.
  - AC1: Replacement level per position is computed over `pool'` (keepers removed);
    removing N keepers at a position measurably shifts that position's VOR.
  - AC2: ADP board rank order is recomputed over `pool'`; no kept player appears in
    the ranked list.
  - AC3: `recommend`/`scoreVsRoom`/`bestPickNow` outputs are unchanged vs a manual
    board where the same players were marked taken (parity test).

### EPIC K3 — Auction budgets & inflation
- **K3.1** As a user, keeper salaries reduce the owning team's budget up front.
  - AC1: Team `remaining = budget - Σ keeperDollars` before pick 1.
  - AC2: A team whose keeper salaries equal its budget can nominate no one and is
    shown as fully committed.
- **K3.2** As a user, league inflation accounts for keepers.
  - AC1: `inflation(remainingBudget, remainingFairSum)` / `liveInflation(a)` return
    keeper-adjusted values (pre-spend shrinks the budget; pre-filtered `boardRows`
    shrink `remainingFair`).
  - AC2: A below-market keeper raises inflation for the remaining pool; an
    above-market keeper lowers it (sign test on a fixture).

### EPIC K4 — Snake pick forfeiture
- **K4.1** As a user, a snake keeper forfeits that team's pick in its round.
  - AC1: `draft-sim.js` order skips `{teamSlot, round}`; that team makes one fewer
    pick and its other picks keep correct serpentine positions.
  - AC2: Total live picks = roster slots × teams − keeper count.

### EPIC K5 — Validation & edge-case guardrails
- **K5.1** As a user, invalid keeper sets are blocked with a clear reason.
  - AC1: Duplicate player across teams -> error, setup can't be locked.
  - AC2: Auction Σ dollars > budget for a team -> error.
  - AC3: Snake round collision (same team, same round) -> error.
  - AC4: Keepers at a position exceeding roster capacity -> warning (allowed to
    bench), not a hard block.
  - AC5: Keeper count > roster size for a team -> error.
  - AC6: `playerId` not in current pool (retired/traded) -> flagged orphan; user
    must resolve (drop or remap) before lock.

## 5. File-by-file change plan

| File | Change | Risk |
|---|---|---|
| `app/keepers.js` (NEW) | Pure `validateKeepers` + `applyKeepers`; no DOM. The only new logic. (Flat `app/` — there is no `app/draft/`.) | Low — isolated, fully unit-tested |
| `app/views/team.js` | Add Keeper Setup panel; call `applyKeepers` at room construction and seed the right constructor: snake `createDraft({…, excludedIds, forfeitedPicks})`, auction `createAuction({…, boardRows: filtered, preSpentBySlot})`; render "K" chips on the candidate/taken rows; lock setup after first pick | Med — touches draft-room init for BOTH room types; guard behind `keepers?.length` so non-keeper drafts are byte-identical |
| `app/auction.js` | Accept optional per-team pre-spend (e.g. `preSpentBySlot`); subtract from that team's starting `budget`. No formula change; keeper *value* is removed by the caller pre-filtering `boardRows`, not by a new param | Med — keep default (no keepers) numerically identical; regression-test parity against `tests/feature/auction.test.mjs` |
| `app/draft-sim.js` | Accept `forfeitedPicks`; `onTheClock`/step auto-consumes each forfeited `{teamSlot, round}` slot (pre-rosters the keeper, advances `pick`). Order stays `snakeTeam`-driven | **Med** (not Low) — `snakeTeam` is positional with no order array, so auto-skip touches the turn loop; empty array must reproduce current behavior exactly |
| `app/team-logic.js` | **No change.** `vorScore(candidate, pool, …)` / `replacementLevel(pool, …)` already take the pool as an argument — feed `pool'` and VOR reflects it. Verified against source | None |
| `data/*` | None — keeper cost is user-entered, not data-derived | None |
| `tests/feature/keepers.test.mjs` (NEW) | `validateKeepers` + `applyKeepers` units, auction inflation sign/parity fixtures, snake forfeiture order test, and a parity test (keeper vs manually-taken board). Must be under `tests/feature/` so the gate glob `node --test tests/feature/*.mjs` picks it up | — |

Fallback / no-keeper path must be byte-for-byte the current behavior — every
keeper hook is gated on a non-empty `keepers` array.

## 6. Risks & edge cases

- **Keeper over budget (auction):** Σ salaries ≥ team budget — block lock (K5.1
  AC2). If exactly equal, allow but mark team fully committed (K3.1 AC2).
- **Keeper at a full position:** more keepers at a position than starting slots —
  allow onto the bench with a warning (K5.1 AC4); if it also exceeds total roster
  size, hard error (K5.1 AC5).
- **Snake round collision:** two keepers, one team, same forfeited round — the
  draft-order simulation can only skip one slot per round; hard error until the
  user reassigns rounds (K5.1 AC3).
- **Duplicate keeper:** same player on two teams — hard error (K5.1 AC1).
- **Orphan keeper:** `playerId` absent from current `players.json` (retired/traded)
  — flag, require drop-or-remap before lock (K5.1 AC6).
- **Inflation sign confusion:** below-market keepers *raise* remaining inflation;
  document and pin with a sign test (K3.2 AC2) so a future refactor can't invert it.
- **Snake vs auction cross-wiring:** a keeper carrying the wrong cost field for the
  draft format — validate `keeper.format === draft.format` at load; ignore the
  irrelevant field.
- **Locking:** editing keepers mid-draft would desync the pool/budgets — lock at
  first live pick (K1.2 AC2); no partial re-apply.
- **iPad layout:** Keeper Setup and "K" chips must fit the 13" TEAM layout without a
  new full-screen route — reuse finder/board components inline.
