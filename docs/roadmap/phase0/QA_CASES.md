# Phase 0 — RoS Value: QA Test Cases

Owner: QA · Status: SPEC (test-first) · Derives from `SOLUTION_DESIGN.md` (authoritative).

Scope: concrete, executable test cases for the reconciled RoS design — pure-math
unit tests with exact expected numbers, one e2e app-surface case, validate/smoke
cases for the new committed feed `data/ros_value.json`, and the backtest
directional acceptance criterion.

**Blocking reality (SOLUTION_DESIGN §0, re-verified):** the NFL substrate is absent
from this checkout. These cases are written test-first against the settled contracts
and file names. Every case that needs substrate that is not yet on disk is tagged
**[BLOCKED-until-substrate]** and MUST skip-loud (clear message, non-zero where a
gate expects data) rather than fabricate — never a silent pass, never a fake number.

Total: **34 cases** (14 unit · 10 data-contract/smoke · 5 e2e · 5 backtest).

---

## Shared fixture (used by all unit cases)

Defined once, injected (`app/ros.js` is pure — no DOM/fetch/I-O at import). All
inputs live in the test file; no reads from `data/`.

```
fromWeek = 15            // remaining weeks are 15,16,17,18
replacement_rank = { QB:1, RB:2, WR:2, TE:2 }   // Nth-by-RoS = the waiver baseline

Player A  id="rb_a"  pos=RB team=ATL bye_week=17   // bye 17 EXCLUDED from remaining
  weekly: w15{pts20.0 floor14.0 ceil28.0}  w16{pts16.0 floor12.0 ceil22.0}
          w17 = BYE (no row)                w18{pts14.0 floor10.0 ceil20.0}

Player B  id="rb_b"  pos=RB team=BUF bye_week=6    // bye already past
  weekly: w15{12.0} w16{10.0} w17{8.0} w18{10.0}

Player C  id="te_c"  pos=TE team=DAL bye_week=8    // NO weekly rows at/after week 15
  weekly: (none in remaining window)
```

Per-week engine formula (SOLUTION_DESIGN §2):
`adj = base_wk * (1 + SOS_W*(m_wk-1)) * (1 - AVAIL_W*(1-a_wk))`.
Pre-tuning `SOS_W = AVAIL_W = 0` ⇒ `adj == base_wk` exactly.

---

## A. Unit tests — pure RoS math  ·  `tests/feature/ros-value.test.mjs`

Run by `node --test tests/feature/*.mjs`. Pure functions, exact numbers.

**UT-1 — `weeksRemaining` excludes the bye.**
`weeksRemaining("rb_a", inputs)` → `[15,16,18]`, `gamesLeft = 3` (week 17 bye dropped).
`weeksRemaining("rb_b", inputs)` → `[15,16,17,18]`, `gamesLeft = 4` (bye 6 is in the past, no effect).

**UT-2 — `rosProject` median = raw remaining sum at zero-default.**
`rosProject("rb_a").rosPoints === 50.0` (20.0+16.0+14.0).
`rosProject("rb_b").rosPoints === 40.0` (12+10+8+10). Assert strict equality (no float drift on these inputs).

**UT-3 — floor / ceil = summed range at zero-default.**
`rosProject("rb_a")` → `floor === 36.0` (14+12+10), `ceil === 70.0` (28+22+20).

**UT-4 — range invariant.** For A and B: `floor <= rosPoints <= ceil` holds.

**UT-5 — `replacementLevel(pos)`.** With `replacement_rank.RB = 2`, RB sorted by RoS
desc = `[A=50, B=40]`, rank 2 ⇒ `replacementLevel("RB", inputs) === 40.0`.

**UT-6 — `rosVOR` = RoS − replacement.** `rosVOR("rb_a") === 10.0` (50−40),
`rosVOR("rb_b") === 0.0` (40−40). `rosVOR("te_c") === null` (propagates C's null, UT-10).

**UT-7 — `ros_value` z within position (population std, ddof=0).**
RB VORs `[10,0]`, mean 5, std `sqrt(((10-5)^2+(0-5)^2)/2)=5`. So `ros_value(A) === 1.0`,
`ros_value(B) === -1.0`. Guard: when a position's VOR std is 0, `ros_value === 0` for all (no divide-by-zero, no NaN).

**UT-8 — `rankByRos` is position-stratified, deterministic, null-last.**
Returns RB group ordered `[rb_a, rb_b]` (by `ros_value` desc), TE group has `te_c`
sorted to the BOTTOM of its group (null RoS never outranks a real value). Ties break
by `player_id` ascending so two runs are byte-identical.

**UT-9 — `rosRange`.** `rosRange("rb_a")` deep-equals `{ floor: 36.0, ceil: 70.0 }`.

**UT-10 — null-safety / loud-skip (never a fabricated zero).**
`rosProject("te_c")` → `rosPoints === null`, `floor === null`, `ceil === null`,
`ros_vor === null`, and `reason === "no_remaining_projections"` (non-empty). Assert
`rosPoints !== 0` explicitly — an absent projection must NOT read as a real zero.

**UT-11 — SOS/AVAIL formula worked example (locks the tuned path).**
With `SOS_W = 0.5, AVAIL_W = 0.5`, per-week `m = {w15:1.2, w16:1.0, w18:0.8}`,
`a = {w15:0.8, w16:1.0, w18:1.0}` for A:
w15 `20*(1+0.5*0.2)*(1-0.5*0.2)=20*1.10*0.90=19.80`;
w16 `16*1.0*1.0=16.00`; w18 `14*(1+0.5*-0.2)*1.0=14*0.90=12.60`.
`rosProject("rb_a").rosPoints === 48.40`. (Assert with a 1e-9 tolerance.)

**UT-12 — no market input, by construction.** (a) Source scan: `app/ros.js` text
contains none of `/\b(price|market|odds|moneyline|implied)\b/i`. (b) Behavioral:
inject a `market`/`price` field into every player row; `rosProject`/`rosVOR`/`rankByRos`
output is byte-identical to the no-market run. Price is structurally excluded, not merely unused.

**UT-13 — `__selftest()` determinism + purity.** `__selftest() === true`. Two full
recomputes over the fixture yield identical vectors. Static assert: `app/ros.js` imports
no `fs`/`node:fs`/`fetch`/DOM global (grep the source) — the pure-module guarantee.

**UT-14 — zero-default PARITY regression lock (never-regress guarantee).**
For EVERY non-null player, at `SOS_W = AVAIL_W = 0`, `rosPoints` equals the plain sum
of that player's remaining weekly `pts` — asserted programmatically over the fixture,
not just A/B. This is the lock that keeps "RoS can only improve or stay flat" true: a
nonzero default leaking in would break parity and fail here loudly.

---

## B. Data contract + smoke — `data/ros_value.json`

`check_ros_value()` in `scripts/validate_data.py` (gated on EXIT CODE); `--self-test`
via `bash tests/smoke.sh`. **[BLOCKED-until-substrate]** applies to real output, but the
validator/self-test run today against crafted good/bad fixtures.

**DC-1 — valid file passes.** A well-formed `ros_value.json` (map `players`, `__meta__`
with ISO-8601 `generated_at`, `from_week` in 1..18, `replacement_by_pos`) → validator exit 0.

**DC-2 — null-without-reason is a HARD error.** A row with `ros_points: null` and no
(or empty) `reason` → validator exits non-zero with a message naming the player_id. This
is the loud-skip invariant; it must never warn-and-pass.

**DC-3 — null-WITH-reason passes.** Same null but `reason: "no_remaining_projections"` → exit 0.

**DC-4 — range invariant enforced.** `floor > ros_points` OR `ros_points > ceil`
(when all non-null) → HARD error.

**DC-5 — `from_week` bounds.** `from_week` = 0 or 19 (outside 1..18) → HARD error.

**DC-6 — non-numeric core rejected.** `ros_points`/`ros_vor`/`floor`/`ceil` = NaN,
Infinity, or a string → HARD error (numeric-or-null only).

**DC-7 — coverage escalation.** `players: {}` → WARN only in default mode (exit 0),
but HARD error under `--strict` (the cron gate) — mirrors `check_feed_emptiness`.

**DC-8 — market fields structurally absent.** `data/contracts/ros_value.schema.json`
is `additionalProperties:false` on the row; a row carrying `price`/`odds`/`market` fails
schema validation. Price can never enter the committed feed.

**DC-9 — `py_self_test "scripts/build_ros_value.py"`.** `build_ros_value.py --self-test`
exits 0, asserting on its seeded in-memory fixture: determinism (two builds identical),
null ⇒ non-empty reason, `floor <= ros_points <= ceil`, output validates against the
schema, and idempotence (re-running the seeded build changes nothing).

**DC-10 — encoding + atomic write.** Self-test verifies the writer uses `ensure_ascii=True`
(diff-minimal, matches on-disk soccer feeds) and atomic `tmp + os.replace` (no
partial/truncated file is ever observable mid-write).

---

## C. E2E — app surface  ·  `tests/ux/ros.spec.mjs`

Playwright, `npx playwright test --config tests/playwright.config.mjs`. Each case
collects `pageerror` and asserts zero (ignoring the known `Transition was skipped` noise).

**E2E-1 — route renders at 402px (iPhone).** Viewport 402px wide, `goto('/#/ros')`;
position rows render (poll `.ros-row` count > 0 through the live-refresh re-render race),
URL stays `#/ros`, no page errors. Confirms the additive `case 'ros'` in `app/main.js` resolves.

**E2E-2 — two-up at 1032px (13" iPad, primary surface).** Viewport 1032px; `.ros-view`
shows the two-column all-positions comparison (`grid-template-columns:1fr 1fr` in effect,
both position columns visible). No page errors.

**E2E-3 — skipped player shows its reason, never a zero.** A `ros_points:null` player
renders greyed at the bottom of its group with `aria-label` starting `"excluded:"` and
its reason text visible; assert its cell shows no fabricated `0`/`0.0`. An exclusion-count
footer is present.

**E2E-4 — value is never color-only (color-blind / AA safe).** Each RoS value carries a
`▲`/`▼` glyph and a numeric sign, not hue alone — assert the glyph node exists alongside
positive/negative values.

**E2E-5 — survives `data:live-refresh`.** Dispatch the app's `data:live-refresh` event;
rows re-render and remain present (the view re-renders on refresh like every other view),
still no page errors.

---

## D. Backtest — honesty + directional acceptance

`tests/feature/ros-backtest-honesty.test.mjs` (mirrors `backtest-honesty.test.mjs`) +
`scripts/ros_backtest.py`. **[BLOCKED-until-substrate]** — none run until
`player_history.json`, `team_strength.json`, `usage_history.json` land.

**BT-1 — method + granularity labeled.** `data/ros_backtest.json` `__meta__.method ===
"season_rank_correlation"` and `__meta__.granularity === "season"`. No other method may be claimed.

**BT-2 — measured-vs-estimate split.** Every row computed from real `player_history.json`
is `measured:true`; every other row is explicitly `estimate:true`. No row is un-flagged
(exactly the `backtest-honesty.test.mjs` discipline).

**BT-3 — no unearned weekly claim.** Assert the file contains NO weekly fields
(`weekly_mae`, `start_sit_hit_rate`, `weekly_rho`) unless a `__meta__.weekly_fixtures_confirmed`
flag is `true`. Weekly granularity is contingent on someone opening `data/fixtures/`
(which does not exist); a weekly number without that flag fails the honest-data rule here.

**BT-4 — DIRECTIONAL ACCEPTANCE CRITERION ("directionally right").** A run counts as
directionally right iff ALL hold, per position AND pooled:

  1. **Pooled Spearman ρ ≥ 0.50**, and **per-position ρ > 0** (QB/RB/WR/TE all positive —
     never anti-correlated).
  2. **Beats the baseline** (prior-season rank, "last year's finish") by `ROS_MARGIN` on ρ:
     `ros_rho > baseline_rho + ROS_MARGIN` (the never-regress adopt rule, maximize-ρ
     sign per SOLUTION_DESIGN §2 — a family that fails this is rejected, number unchanged).
  3. **Bootstrap 95% CI lower bound on pooled ρ > 0** (the correlation is not a small-n
     fluke; report n + CI).
  4. **NDCG@k ≥ 0.70** at starter cutoffs (QB12/RB24/WR36/TE12, confirm at Gate 1) — the
     ranking is right where it matters most, at the top tier.

  *Justification for the thresholds.* ρ ≥ 0.50 is a moderate-to-strong monotone
  association — season-ahead fantasy rank-correlation from prior-year-only signal
  realistically lands ~0.4–0.6, so 0.50 is an honest, clearable bar rather than an
  aspirational one; below it the ranking is too noisy to steer roster decisions. The
  positivity and beat-baseline gates are the real acceptance: a projector that cannot
  beat "just use last year's finish" by the margin adds nothing and must not be adopted —
  this is the same never-regress guarantee the engine ships with (zero-weight default ==
  raw sums, UT-14). The CI-lower-bound-> 0 gate rejects small-sample luck. NDCG@k ≥ 0.70
  targets the top-of-board decisions (starters), where errors cost most and a merely-OK
  global ρ can still hide a bad top tier.

**BT-5 — BLOCKED-until-substrate guard (skip-loud, never fabricate).** With
`player_history.json` absent, `ros_backtest.py` exits non-zero with a clear
"substrate absent — backtest cannot run" message and writes NO `ros_backtest.json` (or
writes one with every row `estimate:true` and ρ `null`). A fabricated ρ is a hard failure
of the honest-data rule; the test asserts no numeric ρ is emitted without measured inputs.

---

## Coverage map (design surface → cases)

| Design element (SOLUTION_DESIGN) | Cases |
|---|---|
| Pure engine API `app/ros.js` (§6) | UT-1..UT-14 |
| Zero-default == raw sums / never-regress (§2) | UT-2, UT-14, BT-4.2 |
| Loud-skip / null⇒reason (§3) | UT-10, DC-2/3, E2E-3, BT-5 |
| No market input by construction (§3, §6) | UT-12, DC-8 |
| Data contract `data/ros_value.json` (§3) | DC-1..DC-10 |
| App surface + collision-safe route (§5) | E2E-1..E2E-5 |
| Season rank-corr backtest + honesty (§4) | BT-1..BT-5 |
| Self-learning sign-flip / adopt-by-margin (§2) | BT-4.2 |
