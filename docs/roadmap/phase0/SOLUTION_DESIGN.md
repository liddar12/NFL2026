# Phase 0 — Rest-of-Season (RoS) Value: Authoritative Solution Design

Owner: Reconciler / adversarial cross-checker · Status: DESIGN — supersedes
ARCHITECTURE.md, TECH_DESIGN.md, UX_DESIGN.md where they disagree.

This is the single source of truth. Where the three phase-0 docs agree it
restates the agreement; where they conflict it resolves the conflict once and
names the winner and why.

---

## 0. Load-bearing fact (all three docs agree; independently re-verified)

**The NFL2026 substrate named in the brief is NOT in this checkout.** This tree is
the WC26 World Cup soccer tracker. Re-verified for this reconciliation:

| Brief says exists | Reality (re-verified) |
|---|---|
| `app/team-logic.js`, `app/data.js`, `app/render.js`, `app/theme.css` | **Absent.** Present pure-module idiom: `app/lib/win-prob.js`, `app/group-scoring.js`, `app/data-loader.js` |
| `data/player_weekly.json`, `player_projections.json`, `team_strength.json`, `injury_history.json`, `player_usage_history.json`, `player_history.json` | **All absent.** `data/` holds soccer feeds. |
| `data/fixtures/gamestats_2025.json`, `data/fixtures/nflverse_sample/` | **`data/fixtures/` does not exist at all.** |
| `scripts/promote_signals.py`, `scripts/build_predictions.py` | **Absent.** |
| `data/model_tuning.json` → NFL `game_params` families | Exists but is the **soccer** file — top keys are `group`, `blend` (no `game_params`). |

No file contents were fabricated. This document is therefore a **spec-to-implement**
that (i) uses the brief's stated NFL data shapes as the domain input surface and
(ii) grounds every mechanism in a convention that is **real and verifiable in this
repo**. **Provisioning the substrate is a hard blocker** on build and on any
backtest (§4).

---

## 1. Conflicts found and how each is resolved

| # | Conflict across the three docs | Resolution (authoritative) |
|---|---|---|
| C1 | ARCH §3.3 calls season-rank backtest **"Design A — guaranteed to run today."** TECH §3a says **nothing** is runnable today (data absent) and even season-rank is blocked. | **TECH wins.** The season-rank backtest is the honest *granularity*, but it is **BLOCKED until `player_history.json` et al. land**. "Guaranteed to run today" is struck. See §4. |
| C2 | Data contract shape differs three ways: ARCH `players` = **array**, `ros_points` = **object** {floor,median,ceil}, has `ros_value` z + `skipped`. TECH `players` = **map**, `ros_points` = **number**, separate floor/ceil, `reason`, no z. UX consumes `ros_vor`, floor/median/ceil, `games_left`, `bye_week`, `skipped`. | **One contract, §3.** `__meta__` + `players` as a **map** (TECH's repo-idiomatic, O(1) lookup, schema-validated) carrying **every** field the chip/row need (median+floor+ceil, `ros_vor`, `ros_value` z, `games_left`, `bye_week`, `sos_factor_mean`, `avail_prob_mean`, `confidence`) with **`reason` present iff any core value is null** (loud-skip). |
| C3 | Module named `app/ros-value.js` (ARCH, UX) vs `app/ros.js` (TECH, with the full API). Builder `build_ros.py` (ARCH) vs `build_ros_value.py` (TECH). | **TECH's pure-module API wins**, standardized as **`app/ros.js`** (matches `win-prob.js` short-name pure idiom). Builder = **`scripts/build_ros_value.py`** (name matches its output `data/ros_value.json`). See §6. |
| C4 | ARCH: "extend **`promote_signals.py`**" with `game_params.ros`. That file and `game_params` **do not exist here**. TECH grounds the gate in `optimize_weights.py` / `snapshot_backtest.py`. | **TECH's grounding wins.** The never-regress gate that actually exists is `optimize_weights.py`. The RoS optimizer is built in that idiom; in the real NFL repo it lands as `promote_signals.py` families. Crucially the adopt comparison **flips sign** for a maximize-ρ objective (§2). |
| C5 | UX claims "touching **zero** e2e-locked hot files," then adds a `case 'ros'` line to `app/main.js`. | **`app/main.js` IS edited** — two additive lines (render switch + route-normalize switch). Honest correction: not "zero files," but **no e2e-locked test enumerates the route table** (verified — no spec rejects unknown routes), so a purely additive case is collision-safe. See §5. |

Everything else in the three docs is mutually consistent and is adopted as-is.

---

## 2. Self-learning integration — does it actually work with the gate as it EXISTS?

**Yes, with two honest adjustments.** The real never-regress machinery is
`optimize_weights.py`, verified:

- `MARGIN = 0.002`; adoption is `adopt = new_loss < cur_loss - MARGIN` (line ~174/227) —
  a family/optimizer earns the change **only** by beating the incumbent by the margin.
- Walk-forward / leak-safe: Elo, form, dominance are **recomputed as-of each
  kickoff** from prior games only; the doc-comment explicitly guards the
  fit-then-report circularity.
- `snapshot_backtest.py` **locks** the sharpest pre-kickoff read per match and
  scores it once the result is final — this **is** the graded-lock mechanism the
  RoS snapshots mirror.
- Adopted params are written atomically (`_write_atomic`) with a before→after
  ledger — the house style for `data/model_tuning.json`.

**Adjustment 1 — objective is RANK, and the margin comparison FLIPS.** The soccer
gate minimizes multiclass log-loss (`new < cur - MARGIN`). RoS is a roster/ranking
tool, so its objective is **Spearman ρ (maximize)** with **NDCG@k** secondary.
The adopt rule therefore becomes `adopt = new_rho > cur_rho + ROS_MARGIN`. This is
the same never-regress discipline with the inequality flipped for a
higher-is-better metric — it must be stated, not silently inherited.

**Adjustment 2 — the family registry does not exist in this tree.** `promote_signals.py`
and `game_params` are NFL-repo files. Here the analogous mechanism is a new
`optimize_ros` step built in the `optimize_weights.py` idiom (independent
optimizers, each never-regress). In the real NFL repo it lands as two families on
`promote_signals.py`.

**Two families, independently gated (disjoint params, so one can adopt while the
other is rejected — the concurrency-rule partitioning discipline applied to signals):**

- **`ros_sos`** — owns `SOS_W` + the `sos_factor` Elo scale. Candidate = RoS
  projections **with** remaining-schedule adjustment; incumbent = raw remaining sums.
- **`ros_avail`** — owns `AVAIL_W` + availability decay + teammate cascade.
  Candidate = RoS **with** availability discount; incumbent = without.

**Pre-tuning defaults `SOS_W = AVAIL_W = 0`** — the engine ships **identical to raw
remaining-projection sums**, and each adjustment earns weight only through the gate
(mirrors dominance starting inert at 0 in `optimize_weights.py`). A regression test
asserts the zero-default reproduces raw sums exactly.

**The closed loop:**

```
build_ros_value.py (week W, prior-week data ONLY)
  → data/ros_value.json  (+ locked snapshot for grading)   [snapshot_backtest.py idiom]
     → target weeks play out
        → ros_backtest.py grades locks (Spearman ρ / NDCG@k, walk-forward)
           → optimize_ros (ros_sos / ros_avail): adopt = new_rho > cur_rho + ROS_MARGIN
              → model_tuning.json game_params.ros  (adopt or keep, before→after ledger)
                 → build_ros_value.py applies adopted params
                    → next week's RoS is sharper — or provably not worse
```

A family that regresses is rejected and leaves the number unchanged: RoS can only
improve or stay flat. **This loop is sound against the gate as it exists** — the
one non-obvious requirement build must honor is the sign-flip (Adjustment 1).

---

## 3. Authoritative data contract — `data/ros_value.json` (resolves C2)

Committed artifact + schema + validator check + builder self-test — the rail every
derived feed here already rides (`xg.json`, `fatigue.json`). `app/ros.js` stays
**pure** so a client-side what-if recompute (compute-live / cache-durable, the
`live-scores.js` pattern) remains possible without a rebuild.

```jsonc
{
  "__meta__": {
    "generated_at": "2026-...T..Z",         // ISO-8601
    "from_week": 7,                          // integer 1..18, first UNPLAYED week
    "params_version": "<sha of model_tuning.json game_params.ros>",
    "source": "build_ros_value.py"
  },
  "players": {                               // MAP keyed by player_id (O(1) lookup)
    "<player_id>": {
      "pos": "RB", "team": "ATL",
      "games_left": 9, "bye_week": 12,       // bye excluded from remaining weeks
      "ros_points": 158.9,                   // median; number|null (null ⇒ reason)
      "floor": 121.4, "ceil": 201.3,         // number|null; floor<=ros_points<=ceil
      "ros_vor": 42.7,                        // vs replacement level at pos; number|null
      "ros_value": 1.83,                      // z within position; number|null
      "sos_factor_mean": 1.04,                // for the chip micro-indicator
      "avail_prob_mean": 0.92,                // availability dot threshold (<0.9)
      "confidence": 0.71,                     // usage-history shrink
      "reason": "no_remaining_projections"    // present IFF any core value is null
    }
  },
  "replacement_by_pos": { "QB": 0, "RB": 0, "WR": 0, "TE": 0 }
}
```

**Contract invariants (enforced by `check_ros_value()` in `validate_data.py`,
mirroring `check_xg`/`check_fatigue`):**
- object with `__meta__` + `players`; `generated_at` ISO-8601 parseable; `from_week` in 1..18.
- each row: `ros_points`/`ros_vor`/`ros_value`/`floor`/`ceil` numeric **or** `null`;
  **any null ⇒ non-empty `reason`** (a null with no reason is a HARD error — the loud-skip invariant).
- `floor <= ros_points <= ceil` when all three non-null.
- coverage `len(players)==0` is warn-only by default, **escalated to hard error in
  `--strict`** (the cron gate) — exactly like `check_feed_emptiness`.
- Market/odds/price fields are **structurally absent** from the schema.

This single shape satisfies all three consumers: UX reads `ros_vor`,
`ros_points`+`floor`+`ceil`, `games_left`, `bye_week`, `sos_factor_mean`,
`avail_prob_mean`, `reason`; the chip/row need nothing not present here.

---

## 4. Backtest — exactly what is honestly runnable (resolves C1)

**Runnable today at NFL granularity: nothing** — the inputs are absent. Do not
claim otherwise.

**The honest method, once the substrate lands — walk-forward SEASON rank-correlation:**

> Project a completed season using **ONLY prior-season data**, then compare the
> projected within-position ranking to that season's ACTUAL finishing points.

1. Target season *S* ∈ {2022,2023,2024,2025}: inputs from seasons `≤ S-1` only
   (`player_history.json` totals + trajectory, `usage_history` share, `team_strength`
   as-of *S-1*). No season-*S* signal enters.
2. Produce a projected season-points ranking per position (QB/RB/WR/TE).
3. Score vs season-*S* actual totals: **Spearman ρ** (primary) + **NDCG@k**
   (k = starter counts, to confirm at Gate 1: QB12/RB24/WR36/TE12) per position.
4. **Baseline to beat: prior-season rank ("last year's finish").** RoS earns its
   keep only by beating it by `ROS_MARGIN` — the never-regress discipline (§2).
5. Report per-season + pooled ρ/NDCG with n and a bootstrap CI.

**Honest labeling (mirrors `data/backtest.json` + `backtest-honesty.test.mjs`):**
`data/ros_backtest.json` carries `__meta__.method` = `"season_rank_correlation"`,
`__meta__.granularity` = `"season"`, and per-row `measured:true` only where computed
from real `player_history.json`; everything else `estimate:true`. A
`tests/feature/ros-backtest-honesty.test.mjs` enforces the split.

**Weekly upgrade (Design B) — CONTINGENT, not claimed.** `data/fixtures/` does not
exist, so per-week actuals **cannot be confirmed reconstructable**. If those
fixtures are later produced AND an implementer opens them and confirms per-player
weekly actuals, upgrade to weekly walk-forward (project week *w* from data `<w`,
score MAE + weekly rank-corr + start/sit hit-rate), recording `coverage` and
skipping loud on partial data. Until then it is a documented possibility only.

**Blocking dependency:** even the season-rank backtest cannot run until
`player_history.json`, `team_strength.json`, and `usage_history.json` are provisioned.

---

## 5. App surface — collision-safety (resolves C5)

RoS ships as a **new isolated route + view + component**. Re-verified: **no `ros`
identifier exists anywhere** in `app/ scripts/ tests/ data/`, and **no playwright
spec enumerates or validates the route table** (`tests/ux/*`, `tests/integrated/*`
are per-feature; none reject unknown routes). So an additive route is collision-safe.

- **`app/main.js`** — edited, minimally and additively (honest correction to the
  "zero hot files" claim): one `case 'ros': renderRosView(root, state.data, params); break;`
  in the render `switch` (~line 244) and one normalize case in the route switch
  (~line 342). No locked test asserts against this table.
- **`app/views/ros-view.js`** (new) — `renderRosView(root, data, params)`, pure
  display, re-renders on `data:live-refresh` like every other view.
- **`app/components/ros-chip.js`** (new) — the RoS value chip + strip, reused by the
  view and later embeddable on `team-detail.js`.
- **`app/styles.css`** — appended `.ros-*` block under a banner. Every color is an
  existing token (verified present: `--surface`, `--surface-2`, `--border`, `--text`,
  `--text-muted`, `--good`, `--warn`, `--bad`, `--primary`); every idiom reused is
  present (verified: `.mover-chip`, `.movers-strip`, `.winner-ladder`, `.winner-row`,
  `.winner-rank`, `.tip-popover`, `.tip-btn`, `.empty-state`, `.delta-up/-down`,
  `.sparkline-line`, `.filter-bar`). No new fonts, colors, build step, or framework.

**Layout (unchanged from UX_DESIGN, adopted):** single thumb-first column at 402px
(6-col compact grid rows, horizontal-scroll chip strip, native `<select>` filter);
two-up all-positions comparison at 1032px (the primary 13" iPad surface — `.ros-view`
`max-width:980px` at `≥1024px`, `grid-template-columns:1fr 1fr`, segmented filter,
wrapped chip strip). One component tree, two layouts, existing breakpoints only.

**Skip-loud in the UI:** a `ros_points:null` player renders greyed at the bottom of
its position group with its `reason` (`aria-label="excluded: <reason>"`), never a
fabricated zero; a footer counts exclusions. Value is never color-only — the `▲/▼`
glyph and numeric sign carry it (color-blind safe, AA tokens).

---

## 6. Component / file plan (authoritative names — resolves C3)

| File | New/extend | Responsibility |
|---|---|---|
| `data/contracts/ros_value.schema.json` | new (new dir) | Output contract (§3); validated by `validate_data.py` |
| `scripts/build_ros_value.py` | new | Weekly precompute → `data/ros_value.json` + locked snapshot; stdlib-only; atomic tmp+`os.replace`; `ensure_ascii=True`; `--self-test` |
| `scripts/ros_backtest.py` | new | Walk-forward SEASON rank-corr (§4) → `data/ros_backtest.json`; measured-vs-estimate labeled |
| `scripts/optimize_ros.py` (real NFL repo: `promote_signals.py` families) | new / extend | `ros_sos`, `ros_avail` never-regress gate, `adopt = new_rho > cur_rho + ROS_MARGIN` |
| `data/model_tuning.json` | extend | `game_params.ros = { sos_w, sos_scale, avail_w, avail_decay, cascade_w, adopted_families:[] }` + before→after ledger |
| `app/ros.js` | new | **Pure** engine (no DOM/fetch at import): `weeksRemaining`, `rosProject`, `replacementLevel`, `rosVOR`, `rankByRos`, `rosRange`, `__selftest`. No `market`/`price` param by construction. |
| `app/views/ros-view.js` | new | `renderRosView(root,data,params)` surface |
| `app/components/ros-chip.js` | new | RoS chip + strip |
| `app/main.js` | extend | 2 additive route lines (§5) |
| `app/styles.css` | extend | appended `.ros-*` block |
| `scripts/validate_data.py` | extend | `check_ros_value()` + strict escalation |
| `tests/feature/ros-value.test.mjs` | new | contract + math + **no-market-input assertion** + skip-loud + zero-default==raw-sums |
| `tests/feature/ros-backtest-honesty.test.mjs` | new | measured-vs-estimate split |
| `tests/ux/ros.spec.mjs` | new | route renders rows @402px + two-up @1032px + skipped player shows reason |

---

## 7. Regression gate additions (100% green, gate on EXIT CODES)

- `python3 scripts/validate_data.py` — `check_ros_value()` validates `data/ros_value.json`;
  hard-fails on null-without-reason, NaN, `floor>ros_points>ceil`; strict escalates empty.
- `bash tests/smoke.sh` — `py_self_test "scripts/build_ros_value.py"` (determinism,
  null⇒reason, `floor<=points<=ceil`, schema validates, idempotent seeded).
- `node --test tests/feature/*.mjs tests/competition.test.mjs` — `ros-value.test.mjs`
  (incl. no-market-source import + zero-default parity), `ros-backtest-honesty.test.mjs`.
- `npx playwright test --config tests/playwright.config.mjs` — `tests/ux/ros.spec.mjs`.

---

## 8. Gate-1 confirmations required before build

1. **Provision the NFL substrate (§0) — BLOCKING.** Nothing builds or backtests
   until `player_history.json`, `player_weekly.json`, `team_strength.json`,
   `usage_history.json`, `injury_history.json` land, and file paths reconcile
   against the real NFL2026 repo.
2. **Backtest = season rank-corr now, weekly only if fixtures materialize + are
   inspected** (§4). No weekly claim until someone opens `data/fixtures/`.
3. **Two independently-gated families, pre-tuning weight 0**, and **RoS_MARGIN
   comparison is `new_rho > cur_rho + MARGIN`** (maximize-ρ sign-flip, §2).
4. **Confirm** SoS source (`team_strength.json` Elo vs schedule-derived opponent
   rank) and NDCG@k starter cutoffs.
