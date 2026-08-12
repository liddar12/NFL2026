# Rest-of-Season (RoS) Value Engine — Solution Architecture

**Phase:** 0 (foundation)
**Author role:** Solution Architect
**Status:** design — confirm before build (Gate 1)

---

## 0. Repo-state note (honest-data rule, applied to this design)

The task brief references NFL2026 modules — `app/team-logic.js`,
`scripts/promote_signals.py`, `scripts/build_predictions.py`, `data/contracts/*`,
`data/player_weekly.json`, `data/team_strength.json`, `data/injury_history.json`,
`data/player_usage_history.json`, `data/player_history.json` — as existing
building blocks. **None of those files exist in the current working tree.** This
tree is the WC26 soccer tracker (verified: `find` returns nothing for those
paths; only `data/model_tuning.json` is present, and it holds soccer weights).

Rather than fabricate a code layer against files that are not here, this design
does two verifiable things:

1. It treats the NFL2026 data contracts **as specified in the brief** as the
   input surface, and specifies the RoS engine, its data file, and its promotion
   integration precisely against those contracts.
2. It grounds the **never-regress promotion mechanics** in the machinery that
   *does* exist and is proven in this repo — `scripts/optimize_weights.py`,
   `scripts/snapshot_backtest.py`, and the before→after `data/model_tuning.json`
   ledger — so Phase-0 build stands the new files up in the house style rather
   than inventing a parallel one.

Where the brief and the tree disagree, the tree wins on *conventions*
(walk-forward, margin-gated adoption, `ensure_ascii=True`, atomic tmp+replace,
exit-code gating, no build step) and the brief wins on *domain* (NFL, players,
weeks, RoS). Build must reconcile file paths against the real NFL2026 repo before
writing code.

---

## 1. What the RoS Value Engine is

A per-player, per-position **Rest-of-Season value** produced fresh each week `W`
from **only information available at or before week `W`**. It answers three
manager questions with one honest number each:

| Question | Output |
|---|---|
| Who should I start the rest of the way? | **RoS projected points** (floor / median / ceiling) over remaining non-bye weeks |
| Who is actually *scarce* rest-of-way? | **RoS VOR** — value over replacement across remaining weeks (reuses `team-logic.js` replacement level) |
| Who do I buy / sell? | **RoS Value score** — RoS VOR after remaining-schedule and availability adjustment, ranked within position |

**Inviolable constraints carried into this engine (STANDING RULES):**

- **Market prices are DISPLAY-ONLY, never a model input.** The RoS engine reads
  `player_weekly`, `team_strength`, and availability signals only. It must not
  read `data/markets.json` / odds / prices. A regression test asserts the RoS
  build imports no market source.
- **No login / commissioner** — RoS value is a pure client-computable read plus a
  precomputed cache; no per-user state, no server auth.
- **No build step / no bundler / no framework** — client math ships as an ES
  module `app/ros-value.js` under the hash router, mirroring `team-logic.js`.
- **Honest data — skip loudly.** A player missing remaining projections, or a
  team missing a remaining opponent's strength, is emitted with an explicit
  `skipped: <reason>` and excluded from ranks — never silently zero-filled.
- **13" iPad TEAM view** is the primary surface; RoS ranks render there.
- `data/*.json` written `ensure_ascii=True`, atomic tmp+`os.replace`, minimal
  diffs (matches `optimize_weights._write_atomic`).

---

## 2. Mandate 1 — Leverage existing data

### 2.1 Inputs (all as-of week `W`, no leakage)

| Signal | Source (per brief) | Use in RoS |
|---|---|---|
| Remaining weekly projections | `data/player_weekly.json` weeks `> W`, excluding the player's bye | Base RoS points: sum of remaining weekly `points` with `floor` / `ceil` carried as the RoS floor/ceiling band |
| Remaining strength-of-schedule | `data/team_strength.json` (per-team Elo) for each remaining opponent | Per-week multiplicative matchup factor `m_wk` on that week's projection |
| Availability | `data/injury_history.json` + `qb_out` / `skill_out` signals | Per-week availability probability `a_wk` discounting projection; teammate cascade (QB out → discount that team's pass-catchers) |
| Replacement level | `app/team-logic.js` (VOR / replacement-level / `scoreVsRoom`) | Convert RoS points → RoS VOR per position |
| Opportunity share (context) | `data/player_usage_history.json` | Confidence weight only (shrink projections for low-sample / volatile usage); **not** a point source |

### 2.2 Computation (per player `p`, position `pos`, current week `W`)

```
remaining_weeks(p) = { wk in player_weekly[p] : wk > W and wk != bye(p) }

for wk in remaining_weeks(p):
    proj_wk      = player_weekly[p][wk].points          # base projection
    opp          = schedule[p.team][wk].opponent_def(pos)
    m_wk         = sos_factor(team_strength[opp], pos)   # ~[0.85, 1.15], Elo-scaled
    a_wk         = avail_prob(p, wk, injury_history, qb_out, skill_out)
    adj_wk       = proj_wk * (1 + SOS_W*(m_wk-1)) * (1 - AVAIL_W*(1-a_wk))

RoS_points(p)  = sum_wk adj_wk           # + floor/ceil bands summed likewise
RoS_VOR(p)     = RoS_points(p) - replacement_RoS(pos)   # team-logic replacement level
RoS_Value(p)   = z_within_pos(RoS_VOR(p))               # rank-ready, position-normalized
```

`SOS_W`, `AVAIL_W`, and the `sos_factor` Elo scale and the availability decay are
**tunable parameters owned by the promotion gate** (§3), not hand-set constants.
Their *pre-tuning defaults* are `SOS_W = AVAIL_W = 0` — i.e. the engine ships
identical to raw remaining-projection sums, and each adjustment earns its weight
**only** by beating that incumbent (mirrors dominance starting at weight 0 in
`optimize_weights.py`).

### 2.3 Outputs — data contract `data/contracts/ros_value.schema.json` → `data/ros_value.json`

```jsonc
{
  "generated_week": 7,
  "generated_utc": "2026-...",
  "params_version": "<sha of model_tuning.json ros block>",
  "players": [
    {
      "player_id": "…", "pos": "RB", "team": "…",
      "remaining_weeks": [8,9,10,11,13,14,15,16,17],   // bye (12) excluded
      "ros_points": {"floor": 121.4, "median": 158.9, "ceil": 201.3},
      "ros_vor": 42.7,
      "ros_value": 1.83,                                // z within pos
      "sos_factor_mean": 1.04,
      "avail_prob_mean": 0.92,
      "confidence": 0.71,                               // usage-history shrink
      "skipped": null                                   // or "no_remaining_projections"
    }
  ],
  "replacement_by_pos": {"QB": …, "RB": …, "WR": …, "TE": …}
}
```

Client `app/ros-value.js` recomputes the same math live from the raw JSON (so a
stale cache never lies), and falls back to `data/ros_value.json` for the heavy
cross-player replacement/z aggregation. This is the `live-scores.js →
live-poller.js` "compute-live, cache-durable" pattern applied to RoS.

---

## 3. Mandate 2 — Feed the self-learning engine

The self-learning engine promotes **signal FAMILIES** through a walk-forward
**NEVER-REGRESS** gate; adopted params live in `data/model_tuning.json`
`game_params`; `build_predictions.py` applies them; a family earns weight only by
beating the incumbent by a margin (`MARGIN` in the house code = `0.002` log-loss).
RoS plugs in at **two** points, exactly analogous to how `qb_out` / `skill_out`
work (both are availability-driven adjustments to a projection that must prove
out before they move the number).

### 3.1 New candidate families

Add two families to the `promote_signals.py` family list
(`environment, rest, epa_total, epa_pass, elo_epa, weather_wind, qb_out,
skill_out` → **`+ ros_sos, ros_avail`**):

- **`ros_sos`** — owns `SOS_W` and the `sos_factor` Elo scale. Candidate = RoS
  projections *with* remaining-schedule adjustment; incumbent = raw remaining sums.
- **`ros_avail`** — owns `AVAIL_W` and the availability decay + teammate cascade.
  Candidate = RoS projections *with* availability discount; incumbent = without.

Each family is fit and gated **independently** (disjoint params), so one can be
adopted while the other is rejected — the partitioning discipline the concurrency
rule calls for, applied to signals. Adopted params land in
`model_tuning.json.game_params.ros = { sos_w, sos_scale, avail_w, avail_decay,
cascade_w, adopted_families: [...] }`, with a before→after block written the same
way `optimize_weights.py` writes its ledger.

### 3.2 Graded predictions (locks) — how RoS becomes trainable

A RoS projection made as-of week `W` is a **graded lock** once its target weeks
are played. Grading obeys the never-regress gate: the candidate family's error on
the leak-safe set must beat the incumbent's by `MARGIN` or the incumbent is kept.

**Objective:** because RoS is a *ranking/roster* tool, grade it as a **ranking**
problem, not W/D/L log-loss. Metric = **Spearman rank correlation** (plus MAE on
`ros_points`) between projected RoS rank within position and realized
rest-of-season rank within position. Walk-forward: for each week `W` in the
backtest season, project RoS from prior-week data only, then score against what
actually happened from `W+1` onward. Never fit-then-report the same weeks
(the circularity `optimize_weights.py` explicitly guards against).

### 3.3 Backtest data reality — honest granularity (BACKTEST DATA REALITY rule)

Committed data has **per-player SEASON totals** (`player_history.json`,
2021–2025) but **no committed per-player WEEKLY actuals**. Two designs, declared
honestly, chosen by what data build can actually stand up:

- **Design A (guaranteed to run today) — season/rest-of-season RANK-CORRELATION.**
  Reconstruct a "rest-of-season" as a season boundary: project a completed
  season's *rest-of-season* using only **prior-season** `player_history` +
  `team_strength` + availability, and score the projected within-position ranking
  against that season's *actual* season-total ranking (Spearman). This is coarse
  (season, not week) and is **stated as a limitation** in the backtest output —
  it validates the SoS/availability *direction and weight*, not week-level timing.

- **Design B (preferred, gated on data) — weekly graded locks.** Investigate
  `data/fixtures/gamestats_2025.json` and `data/fixtures/nflverse_sample/` for
  reconstructable per-player weekly actuals. If a clean weekly reconstruction
  exists, grade true weekly RoS locks (project from week `W`, score weeks
  `W+1…end`). If reconstruction is lossy or partial, **skip loudly** — emit the
  covered weeks only and record `coverage` in the backtest, never interpolate.

Build starts on Design A (real, shippable, honest) and upgrades to Design B only
when the fixture reconstruction passes a data-integrity check. The backtest file
`data/ros_backtest.json` records `granularity: "season" | "weekly"`, `coverage`,
Spearman, MAE, and the incumbent-vs-candidate margin — the same self-describing,
skip-loud shape as `backtest.json`/`live-backtest.json`.

### 3.4 The loop (closes the self-learning cycle)

```
build_ros.py (week W, prior data only)
   → data/ros_value.json  (+ locked snapshot for grading)
        → [target weeks play out]
             → ros_backtest.py grades locks (Spearman/MAE, walk-forward)
                  → promote_signals.py: ros_sos / ros_avail vs incumbent, MARGIN gate
                       → model_tuning.json.game_params.ros (adopt or keep)
                            → build_predictions.py applies adopted params
                                 → next week's RoS is sharper (or provably not worse)
```

A family that regresses is **rejected and leaves the number unchanged** — the RoS
engine can only get better or stay flat, never worse, which is the whole point of
the never-regress gate.

---

## 4. Component / file plan (Phase 0)

| File | New/extend | Responsibility |
|---|---|---|
| `data/contracts/ros_value.schema.json` | new | Output contract; validated by `validate_data.py` |
| `scripts/build_ros.py` | new | Weekly precompute → `data/ros_value.json` + locked snapshot; stdlib-only; atomic write |
| `scripts/ros_backtest.py` | new | Walk-forward grading (Design A now, B when data allows) → `data/ros_backtest.json` |
| `scripts/promote_signals.py` | extend | Add `ros_sos`, `ros_avail` families to the gate |
| `scripts/build_predictions.py` | extend | Apply `game_params.ros` adopted params |
| `data/model_tuning.json` | extend | `game_params.ros` block + before→after ledger |
| `app/ros-value.js` | new | Client RoS compute (reuses `team-logic.js`), cache fallback |
| `app/views/…` (TEAM) | extend | RoS rank surface, 13" iPad |
| `tests/feature/ros_value.test.mjs` | new | Contract + math + "no market input" + skip-loud |
| `scripts/validate_data.py` | extend | Enforce `ros_value.schema.json` |

## 5. Regression gate additions (must be 100% green, gate on EXIT CODES)

- `python3 scripts/validate_data.py` — validates `data/ros_value.json` against the
  new contract; fails on missing `skipped` reasons or NaN.
- `bash tests/smoke.sh` — `build_ros.py` runs clean and is idempotent (seeded).
- `node --test tests/feature/ros_value.test.mjs` — replacement/VOR reuse correct;
  **asserts no market/odds/price source is imported**; skip-loud path exercised;
  pre-tuning defaults reproduce raw remaining-projection sums exactly.
- `npx playwright test` — RoS ranks render on the 13" iPad TEAM view.

## 6. Decisions requiring confirmation (Gate 1)

1. **Design A first, B on data check** — ship the honest season-rank backtest now,
   upgrade to weekly locks only if fixtures reconstruct cleanly. (Recommended.)
2. **Two families, gated independently** (`ros_sos`, `ros_avail`) rather than one
   combined RoS family — lets availability adopt even if SoS doesn't, and vice
   versa. (Recommended over a single coupled family.)
3. **Pre-tuning defaults = 0 weight** — engine ships identical to raw remaining
   sums; adjustments earn weight only through the gate. (Recommended; mirrors
   dominance-at-0 in `optimize_weights.py`.)
4. **Reconcile file paths against the real NFL2026 repo** before any code — the
   modules named in the brief are absent from this working tree (§0).
