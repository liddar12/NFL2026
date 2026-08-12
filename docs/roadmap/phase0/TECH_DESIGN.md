# Phase 0 — Rest-of-Season (RoS) Value: Technical Design

Owner: Technical Design lead · Status: DESIGN (not yet implemented)

---

## 0. SUBSTRATE STATUS — read this first (honest-data gate)

**The NFL2026 data substrate named in the brief is NOT present in this checkout.**
This working tree is the **WC26 World Cup soccer tracker** (`wc2026-tracker`). I
verified via `ls`/`find`/`git`:

| Brief says exists | Reality in this checkout |
|---|---|
| `app/data.js`, `app/team-logic.js` | **Absent.** Present instead: `app/data-loader.js`, `app/hybrid-model.js`, `app/stack-model.js`, `app/live-*.js` (soccer) |
| `data/player_weekly.json`, `player_projections.json`, `team_strength.json`, `injury_history.json`, `player_usage_history.json`, `player_history.json` | **All absent.** `data/` holds soccer feeds (`teams.json`, `xg.json`, `fatigue.json`, `group_matchups.json`, …) |
| `data/fixtures/gamestats_2025.json`, `data/fixtures/nflverse_sample/` | **`data/fixtures/` does not exist at all.** |
| `scripts/promote_signals.py`, `scripts/build_predictions.py` | **Absent.** |
| `data/model_tuning.json` → NFL `game_params` families (environment/rest/epa_*) | Exists but is the **soccer** file (group/blend multiclass log-loss over World Cup matches). No `game_params`. |

Per the inviolable rule ("honest data — never fabricate values, skip loudly when
data absent"), I did **not** invent the contents of files I cannot open. In
particular I **could not investigate** `gamestats_2025.json` or `nflverse_sample/`
for weekly reconstruction, because they are not on disk.

**Consequence for this document:** this is a *specification to be implemented*,
not a description of existing code. Every schema below is designed against the
brief's stated shapes (the brief is the spec) and against the **real, verifiable
conventions of this repo** (validate_data.py wiring, `.schema.json` contracts,
`--self-test` builders, `node --test` feature tests, the measured-vs-estimate
honesty pattern in `data/backtest.json` + `tests/feature/backtest-honesty.test.mjs`).
The backtest section (§3) states exactly what is honestly runnable **today**
(nothing, at NFL granularity) versus **once the substrate lands** (season
rank-correlation), and why weekly-actual backtesting stays unproven until the
fixtures are produced and inspected.

---

## 1. Pure RoS module API — `app/ros.js`

**Design rule (matches repo):** pure and testable, **no DOM at import time**, no
top-level side effects, no network. Views import it; it imports nothing from
`app/views/*`. Inputs are plain objects loaded by `app/data-loader.js` and passed
in — the module never fetches. This mirrors how `app/team-logic.js` (per the
brief: `VOR / replacement-level / recommend / scoreVsRoom / bestPickNow`) is meant
to be consumed, and how existing pure modules here (`app/lib/win-prob.js`,
`app/group-scoring.js`) are structured.

```js
// app/ros.js — pure, no DOM, no fetch. All data injected by the caller.

/**
 * @typedef {Object} RosInputs
 * @property {Object} projections   // data/player_projections.json (season proj)
 * @property {Object} weekly        // data/player_weekly.json (18-wk split + bye + floor/ceil)
 * @property {Object} teamStrength  // data/team_strength.json (per-team Elo, for SoS)
 * @property {Object} [availability]// injury_history + qb_out/skill_out signals
 * @property {Object} [usage]       // data/player_usage_history.json (opportunity share)
 * @property {Object} params        // model_tuning.json game_params (adopted weights only)
 * @property {number} fromWeek      // first unplayed week (RoS horizon start), 1..18
 */

/** Weeks remaining for a player from `fromWeek`, excluding their bye. Pure. */
export function weeksRemaining(playerId, inputs) { /* … */ }

/**
 * Rest-of-season projected points for one player.
 * Sum over remaining weeks of: base_weekly × SoS_adj × availability_adj.
 * SoS_adj from opponent teamStrength Elo; availability_adj from qb_out/skill_out.
 * Returns { rosPoints, perWeek:[{week, pts, floor, ceil}], byeWeek, gamesLeft }.
 * NEVER fabricates: a player with no weekly row yields rosPoints:null + reason.
 */
export function rosProject(playerId, inputs) { /* … */ }

/** Replacement-level RoS points per position (baseline for VOR). Pure. */
export function replacementLevel(position, inputs) { /* … */ }

/** Value Over Replacement on the RoS horizon: rosPoints − replacementLevel. */
export function rosVOR(playerId, inputs) { /* … */ }

/** Rank a roster/pool by rosVOR, position-stratified. Stable, deterministic. */
export function rankByRos(playerIds, inputs) { /* … */ }

/** floor/ceil band for the RoS total (sum of weekly floor/ceil). */
export function rosRange(playerId, inputs) { /* … */ }

/** Self-check invoked by the builder + a node --test: recompute a fixed vector
 *  and assert determinism + null-safety. No I/O. */
export function __selftest() { /* returns true or throws */ }
```

**Reuse, do not reinvent:** `rosVOR`/`replacementLevel` extend the VOR /
replacement-level machinery the brief attributes to `app/team-logic.js` — `ros.js`
provides the *horizon-aware* projection input and delegates the ranking idiom.
`params` is read **only** for **adopted** families (the self-learning gate already
decided them); `ros.js` does no tuning of its own. Market prices are **display-only
and never an input** — `ros.js` has no `market`/`price` parameter by construction.

---

## 2. Data contract — DECISION: committed `data/ros_value.json` + schema + wiring

Two options were weighed:

- **(A) Compute client-side** from `player_projections.json` + `player_weekly.json`
  + `team_strength.json` on every load.
- **(B) Precompute a committed `data/ros_value.json`** from a stdlib Python builder,
  validated in `validate_data.py`, consumed read-only by `app/ros.js`.

**Recommendation: (B), with `app/ros.js` still pure so (A) remains possible for
what-ifs.** Rationale, grounded in this repo's actual patterns:

1. **Determinism + gating.** Every other derived feed here (`xg.json`,
   `fatigue.json`, `conformal.json`, `stacker.json`) is a committed artifact with a
   builder and a validator check. RoS value — schedule-aware, availability-aware —
   is exactly that kind of artifact and belongs on the same rail so the regression
   gate can catch a silently-empty or malformed build.
2. **Honesty is enforceable.** A committed file lets `validate_data.py` assert
   "skip loudly when data absent" (null RoS carries a `reason`, never a fabricated
   number) as a hard check, not a runtime hope.
3. **`app/ros.js` stays pure either way** — it accepts injected objects, so a
   client-side recompute path (A) is available for interactive what-ifs without a
   rebuild.

### 2a. `data/contracts/ros_value.schema.json` (new dir — none exists yet)

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ros_value",
  "type": "object",
  "required": ["__meta__", "players"],
  "properties": {
    "__meta__": {
      "type": "object",
      "required": ["generated_at", "from_week", "params_version", "source"],
      "properties": {
        "generated_at": { "type": "string" },      // ISO-8601
        "from_week":     { "type": "integer", "minimum": 1, "maximum": 18 },
        "params_version":{ "type": "string" },      // model_tuning.json game_params hash
        "source":        { "type": "string" }
      }
    },
    "players": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["ros_points", "ros_vor", "games_left"],
        "properties": {
          "ros_points":  { "type": ["number", "null"] },   // null ⇒ reason required
          "ros_vor":     { "type": ["number", "null"] },
          "floor":       { "type": ["number", "null"] },
          "ceil":        { "type": ["number", "null"] },
          "games_left":  { "type": "integer", "minimum": 0 },
          "bye_week":    { "type": ["integer", "null"] },
          "reason":      { "type": "string" }              // present iff a value is null
        }
      }
    }
  }
}
```

### 2b. `validate_data.py` wiring (mirror existing `check_xg` / `check_fatigue`)

Add a `check_ros_value()` method + a `CHECKS` entry:

- File is an object with `__meta__` + `players`.
- `__meta__.generated_at` ISO-8601 parseable; `from_week` in 1..18.
- Each player row: `ros_points`/`ros_vor` numeric **or** `null`; **if null,
  `reason` is a non-empty string** (the loud-skip invariant — a null with no
  reason is a hard error).
- `floor <= ros_points <= ceil` when all three are non-null.
- Coverage: warn (not error) when `len(players) == 0`, matching the warn-only
  coverage checks already in `validate_data.py` (`check_form_coverage`, etc.).
- **strict mode** escalates empty/stale to a hard error, exactly like
  `check_feed_emptiness`.

### 2c. Builder self-test (mirror `smoke.sh` `py_self_test` convention)

`scripts/build_ros_value.py --self-test`: builds `ros_value` from a tiny in-file
fixture, asserts (i) determinism, (ii) null rows always carry `reason`, (iii)
`floor <= points <= ceil`, (iv) schema validates. Wired into `tests/smoke.sh`
next to `py_self_test "scripts/build_ros_value.py"`. Plus a
`tests/feature/ros-value.test.mjs` (`node --test`) that loads the committed file
and re-checks the schema invariants — same shape as `knockout-data.test.mjs`.

---

## 3. Backtest — the exact method, and what is honestly runnable

### 3a. What I could NOT verify (loud skip)

The brief asks me to investigate `data/fixtures/gamestats_2025.json` and
`data/fixtures/nflverse_sample/` to decide whether **per-week actuals** can be
reconstructed. **Those fixtures do not exist in this checkout** (§0), so I cannot
confirm weekly reconstruction is possible. I therefore **do not claim** a
weekly-granularity backtest — asserting one would be fabrication.

### 3b. The backtest I can honestly SPECIFY: walk-forward SEASON RANK-CORRELATION

**Granularity the committed data supports** (per the brief's own "BACKTEST DATA
REALITY": `player_history.json` = per-player **season** totals 2021-2025 + NO
committed weekly actuals):

> **Project a completed season using ONLY prior-season data, then compare the
> projected ranking to that season's ACTUAL finishing points — position-stratified
> Spearman rank correlation.**

Procedure (walk-forward, never peeking):

1. For target season *S* ∈ {2022, 2023, 2024, 2025}: build inputs from seasons
   `≤ S-1` **only** (`player_history.json` totals + trajectory, `usage_history`
   opportunity share, `team_strength` as of *S-1*). No season-*S* signal enters.
2. Produce a projected season-points ranking per position (QB/RB/WR/TE).
3. Compare to season *S* actual totals (`player_history.json[S]`):
   - **Spearman ρ** (primary) and **NDCG@k** (k = starter counts: QB12, RB24,
     WR36, TE12) per position.
   - Baseline to beat: **prior-season points** ("last year's finish") and ADP if
     present. RoS earns its keep only by beating last-year rank by a margin —
     the same **never-regress** discipline the self-learning engine already uses.
4. Report per-season and pooled ρ/NDCG with n and a bootstrap CI.

**Honest labeling (mirror `data/backtest.json`):** the output file
`data/ros_backtest.json` carries `__meta__.method` naming this as a
**season-rank** backtest and `measured: true` only for rows actually computed from
`player_history.json`; anything not so computed is `estimate: true`. A
`tests/feature/ros-backtest-honesty.test.mjs` enforces that split, exactly like
`backtest-honesty.test.mjs` does for the soccer models.

### 3c. Upgrade path (only if fixtures materialize)

If `gamestats_2025.json` / `nflverse_sample/` are later produced AND inspection
shows real per-player **weekly** actuals, upgrade to a **weekly walk-forward**
backtest (project week *w* from data `< w`; score MAE + weekly rank-corr + a
start/sit hit-rate). Until an implementer opens those files and confirms the
schema, this stays a documented *possibility*, not a claim.

---

## 4. Regression gate deltas (all four stages stay green)

- `scripts/validate_data.py` — new `check_ros_value()` (+ strict escalation).
- `tests/smoke.sh` — `py_self_test "scripts/build_ros_value.py"`.
- `node --test tests/feature/*.mjs` — `ros-value.test.mjs`,
  `ros-backtest-honesty.test.mjs`.
- Playwright — unchanged unless a RoS view ships (out of Phase-0 scope).

## 5. Open decisions for the architect

1. Provision the NFL substrate (§0 table) — nothing below can be built or
   backtested until `player_history.json` et al. land. **Blocking.**
2. Confirm SoS adjustment source: `team_strength.json` Elo (brief) vs a
   schedule-derived opponent-rank.
3. Confirm starter counts for NDCG@k cutoffs.
