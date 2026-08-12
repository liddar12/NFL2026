# Phase 2 Roadmap — Cross-Check & Build Order

Two scaffold designs were produced and cross-checked against the **actual
`nfl2026` source** (flat `app/*.js`, hash router, pure engines in
`team-logic.js` / `auction.js` / `draft-sim.js`, contract getters in `data.js`,
render primitives in `render.js`). This README ranks them by impact-vs-effort and
recommends a build order. Feasibility corrections already applied to each doc are
summarized at the bottom.

| # | Design | Impact | Effort | Reach | Verdict |
|---|---|---|---|---|---|
| **1** | [Head-to-Head Compare](./COMPARE.md) | **High / continuous** | **Low–Med** | Draft day **+ every week** (start/sit, trades) | **Build first** |
| **2** | [Keeper Support](./KEEPERS.md) | Med | Med | Keeper leagues only, once per season | Build second |

## Recommendation: Compare first, Keepers second

### Why Compare ranks first (best impact-to-effort)
- **Fully additive, no engine surgery.** New route + view + tray module + a
  `getPlayerUsage` getter + a *guarded* `renderPlayerCard` opt + a one-line
  `hash.split('?')[0]` normalization in `main.js`. It calls `vorScore`,
  `strengthOfSchedule`, `weeklyPoints`, `byeWeek`, `scoringAdjust` and reuses
  `renderTrendChip` / `renderSos` / `renderWeekStrip` / `renderScoreSeg`
  **verbatim** — every one of those exports was verified present. Computes no new
  model math.
- **Continuous, broad value.** Pairwise "A or B?" is the core decision *both* on
  draft day (DRAFT lens: VOR/ADP against the live pool) *and* every week of the
  season (START/SIT lens: this-week points, matchup, hard bye flag) — one code
  path, so the season-long value is essentially free once the draft-day build
  lands. It surfaces off existing Players cards and the Team finder, so reach is
  wide.
- **Cheap, safe rollback.** Route-gated and opt-guarded; reverting the `main.js`
  ROUTES line + the two tray mounts removes it byte-for-byte.
- **Feasibility: high.** The COMPARE author read the source; claims check out,
  including the genuinely tricky one — `player_projections` keys players as
  `espn-####` while `player_usage` keys as nflverse `00-00####`, so the usage row
  really does need a crosswalk and correctly degrades to "not matched." No
  corrections required.

### Why Keepers ranks second
- **Higher effort, narrower reach.** It modifies the **live draft-room init for
  both room types** (`createDraft` *and* `createAuction` — they are separate
  constructors, not one `createDraft(config)`), adds an **engine change to the
  snake turn loop** (`snakeTeam` is positional with no editable order array, so
  forfeited-pick handling means auto-consuming a slot inside `onTheClock`/step —
  the trickiest, highest-risk piece), and adds a per-team pre-spend to
  `auction.js`. That is real surgery on the most stateful part of the app.
- **Seasonal, single-audience payoff.** Only keeper leagues benefit, and only at
  draft setup (once a year). High value for those users, but far less continuous
  than Compare.
- **Good news that lowers its cost:** `team-logic.js` needs **no change** —
  `vorScore`/`replacementLevel` already take the pool as an argument, so feeding
  the keeper-reduced pool is enough. And `createDraft` already has a native
  `excludedIds` param, so the snake pool-exclusion half is nearly free.

### Sequencing synergy (concrete reason to do Compare first)
Compare's DRAFT-lens VOR reads the **currently available pool**. Keepers, when
they ship, simply remove kept players from that pool — so Compare's draft lens
stays correct behind Keepers with **zero extra wiring**. Building Compare first
and slotting Keepers in behind it means no rework in either direction.

### Suggested order
1. **Compare — C1-S1 → C1-S3** (route + tray + side-by-side/edge-chips): the
   spine, immediately useful.
2. **Compare — C1-S4/S5** (DRAFT and START/SIT lenses): unlocks year-round value.
3. **Compare — C1-S6 → S9** (usage row, honest states, a11y, gate wiring): ship.
4. **Keepers — K1 → K2** (config/persistence + pool/VOR repricing): the additive,
   low-risk half (native `excludedIds`, no team-logic change).
5. **Keepers — K3** (auction budgets/inflation via per-team pre-spend + filtered
   `boardRows`).
6. **Keepers — K4** (snake forfeiture): schedule the engine's turn-loop change
   last and pin it with the sign/parity fixtures — it is the one genuinely
   invasive piece in either project.

Both ship only when `bash tests/run_gate.sh` is 100% green; both are route-/flag-
gated so the no-feature path is byte-identical to today.

---

## Feasibility corrections applied during cross-check

### KEEPERS.md (author did **not** read source — several interface errors fixed)
- **`createDraft(config)` conflation.** Snake and auction use **two different
  constructors** — `createDraft({…})` (draft-sim) and `createAuction({…})`
  (auction). The doc treated them as one. Fixed in §2, §3.2, §5.
- **Adapter path.** `app/draft/keepers.js` → **`app/keepers.js`** (the app dir is
  flat; there is no `app/draft/`). Fixed throughout.
- **Test path.** `tests/keepers.test.mjs` → **`tests/feature/keepers.test.mjs`**
  so the gate glob `node --test tests/feature/*.mjs` picks it up.
- **Exclusion mechanism.** `createDraft` has a native `excludedIds` param (great
  for snake); `createAuction` does **not** — auction keeper exclusion is done by
  pre-filtering `boardRows`. Fixed §3.2 step 1.
- **`team-logic.js` change → none.** `vorScore`/`replacementLevel` already take
  the pool as an argument; feeding `pool'` suffices. Downgraded from "Low/Med" to
  no change. (Also: `scoreVsRoom` lives in `draft-sim.js`, not `team-logic.js`.)
- **Auction inflation.** Real API is `inflation(remainingBudget, remainingFairSum)`
  / `liveInflation(a)`. The proposed "preRemovedValue" param is redundant —
  dropping keeper rows from `boardRows` already shrinks `remainingFair`. Kept only
  a per-team pre-spend. Fixed §2, §3.2 steps 3–4, K3.2-AC1.
- **Persistence.** No persisted "draft config" exists (rooms are built from an
  in-memory `roomOpts`); keepers get a new `nfl2026.keepers.v1` key matching the
  `nfl2026.*.v1` convention. Fixed §3.1.
- **Snake forfeiture risk.** `snakeTeam(pick, leagueSize)` is a pure positional
  function with no editable order array, so forfeited-pick handling is an
  auto-skip inside the turn loop, not a one-line array edit. Risk raised
  Low → **Med**. Fixed §2, §3.2 step 5, §5.

### COMPARE.md (author **did** read source — no corrections needed)
Verified accurate: all reused exports exist (`vorScore`, `strengthOfSchedule`,
`weeklyPoints`, `byeWeek`, `scoringAdjust`, `renderTrendChip`, `renderSos`,
`renderWeekStrip`, `renderScoreSeg`); the `renderPlayerCard(player, opts)`
opt-guard pattern is real; `data.js` getters exist (`getPlayerProjections`,
`getPlayerWeekly`, `getPlayerHistory`, `getAiInsights`, `getTeamStrength`,
`getAdp`, `getGamePredictions`) and only the proposed `getPlayerUsage` is new;
`main.js` does a single `ROUTES[hash]` lookup that the one-line query-strip
handles cleanly; there are 5 tabs (Slate/Players/Parlays/Team/Model) as stated;
`game_predictions.week` exists; and the usage id-crosswalk concern is real and
honestly handled (projections `espn-####` vs usage nflverse `00-00####`).
