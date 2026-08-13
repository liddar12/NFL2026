# Rel19 — QA CASES

**Role:** QA Lead
**Date:** 2026-08-13
**Authority:** `docs/roadmap/rel19/SOLUTION_DESIGN.md` (the build contract). Where
`ARCHITECTURE.md` / `FEASIBILITY.md` disagree with it, this document follows
SOLUTION_DESIGN.
**Design-only artifact.** Nothing outside `docs/roadmap/rel19/` was created or modified.

> **99 cases.** 14 reconciliation · 24 scoring-evaluator · 15 league-shape ·
> 12 dormancy · 12 backward-compat · 14 E2E · 8 pipeline/validator.
> **13 existing test files at risk** (§8), of which **2 need new expected values**
> and **11 need added cases only, with no existing assertion edited**.

---

## 0. Scope, provenance, and the numeric-value policy

### 0.1 The gate these cases must end green in

`bash tests/run_gate.sh`, gating on exit codes, in order **[verified in repo]**:

```
1. python3 scripts/validate_data.py
2. bash tests/smoke.sh
3. node --test tests/feature/*.mjs
4. npx playwright test --config tests/playwright.config.mjs      (web + pwa)
```

Baseline **verified by `grep -c '^\s*test('` on 2026-08-13**: **277 unit**
(`tests/feature/*.mjs`), **82 E2E** (`tests/web/web.spec.mjs` 74 +
`tests/pwa/standalone.spec.mjs` 8).
There is **no** `tests/competition.test.mjs`, **no** `tests/ux/`, **no**
`tests/integrated/`. Any agent that runs the gate command quoted in the release
brief will get a spurious failure; use `run_gate.sh`.

**Exit criterion:** ≥ **277 + 85 = 362 unit** and ≥ **82 + 14 = 96 E2E**, all green.
(85 = the 99 cases minus the 14 E2E cases; §7's 8 pipeline cases split as 6 node
assertions inside `components_reconcile` / `smoke.sh` + 2 python assertions inside
`validate_data.py` — those two are counted in the 85 but execute in gate step 1, not
step 3. See §9 for the arithmetic.)

### 0.2 Where the expected values came from

Every number tagged **[M]** below was **measured on 2026-08-13** in this sandbox by
this QA pass — not recalled, not copied from the design doc:

| Source | What was measured |
|---|---|
| ESPN kona `leaguedefaults/3`, season 2025, `filterSlotIds [0,2,4,6]`, 400 rows | per-player `stats` maps + `appliedTotal` |
| `data/player_projections.json` (`season 2026`, `updated_utc 2026-08-13T07:25:44Z`, 300 rows) | `proj_points`, pool composition, ordering |
| `data/player_weekly.json` (same `updated_utc`) | `receptions_prior` |
| repo source | `team-logic.js:29/35/39/632/725/773`, `lineup.js:26/93-106`, `auction.js:107-108/161-166`, `ros.js:104/112`, `views/compare.js:100` |

**Independently re-derived here, and it holds:** scoring the 2025 kona component maps
under ESPN-PPR `{3:.04, 4:4, 19:2, 20:−2, 24:.1, 25:6, 26:2, 42:.1, 43:6, 44:2, 53:1,
63:6, 72:−2, 101:6, 102:6, 104:6}` reproduces `proj_points` for **300 of 300**
committed players with **zero** players outside 0.011 **[M]**. Dropping
`{63,101,102,104}` yields exactly **12** failures **[M]** — the design's RM6 residual,
reproduced independently.

### 0.3 Numeric-value policy (read before writing a single assertion)

Two classes of expected value appear below and they must be **coded differently**:

| Class | Example | Rule |
|---|---|---|
| **PINNED** — an inline fixture the test owns | `pass_cmp 388 × 0.5 = 194.00` | Hardcode the literal. It can never drift; the fixture is the test. |
| **DERIVED** — depends on committed `data/*.json`, which the daily cron rewrites | "replacement QB = 351.96" | **Never hardcode.** Recompute the expectation from the committed file inside the test and assert the *relationship* (`= ranked[1].adj`, `10-team ≠ 12-team`, `identical to the pre-Rel19 snapshot`). The literals in this document are the **2026-08-13 reference values** for reviewing the test, not for pasting into it. |

Hardcoding a DERIVED value produces a test that reds on a data refresh and teaches the
team to edit expectations — the exact habit that lets a real regression through. Every
DERIVED case below is marked **⟨D⟩** and carries its reference value in parentheses.

### 0.4 The four pinned player fixtures

Used by §2 and §5. All four are **real 2025 kona component maps [M]**; at today's
weights (`signals_used: []` on every committed row, all 32 registry signals at 0)
`Π applied = 1`, so the projected components **are** these actuals — which is why
`score_PPR(comp)` equals `proj_points` to the cent for each.

| Fixture | Player | Components (statId → value) | `score_PPR` | committed `proj_points` |
|---|---|---|---|---|
| **FIX-QB1** | Matthew Stafford | `pass_att 597, pass_cmp 388, pass_yd 4707, pass_td 46, pass_int 8, rush_att 29, rush_yd 1, fum_lost 3` | **350.38** | **350.38** |
| **FIX-QB2** | Josh Allen | `pass_att 460, pass_cmp 319, pass_yd 3668, pass_td 25, pass_int 10, pass_2pt 1, rush_att 112, rush_yd 579, rush_td 14, fum_lost 3` | **364.62** | **364.62** |
| **FIX-RB1** | Christian McCaffrey | `pass_att 1, pass_cmp 0, rush_att 311, rush_yd 1202, rush_td 10, rec 102, rec_yd 924, rec_td 7` | **416.60** | **416.60** |
| **FIX-WR1** | Ja'Marr Chase | `rush_att 3, rush_yd 14, rec 125, rec_yd 1412, rec_td 8, fum_lost 1` | **313.60** | **313.60** |

And the **OMILIA** profile (the owner league's effective table, offense keys only):
`pass_yd .04 · pass_cmp .5 · pass_td 6 · pass_int −2 · pass_2pt 2 · rush_yd .1 ·
rush_td 6 · rush_2pt 2 · rec 1 · rec_yd .1 · rec_td 6 · rec_2pt 2 · fum_lost −2 ·
fum_rec_td 6 · st_td 6`, with the 12 unmodeled keys of SOLUTION_DESIGN §3.4 present
and non-zero.

---

## 1. Reconciliation suite — `tests/feature/components_reconcile.test.mjs`

Implements SOLUTION_DESIGN §4.3 R1 / R2 / R4 / R5. (**R3 is realized as §5's
backward-compat suite** — it is a property of the default path, not of the component
file, and it is tested where the numbers actually render.)

**The tolerance is 0.011 and it is not negotiable.** It is 2-dp rounding slack
(0.005 + 0.005 + float), set by a measured residual of **0.0 on 300 players [M]**.
FEASIBILITY's `> 0.5 per player / mean ≤ 0.10 / ≥ 95 % within 0.01` is **rejected**:
those were calibrated for a cross-feed comparison this design does not perform. Inside
one feed, "95 % match" is a bug, not a tolerance.

### R1 — the identity

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-R1.1** | `score_PPR(components) == proj_points`, 300 of 300 | committed `player_components.json` + `player_projections.json` | for **every** row `\|score_PPR(comp) − proj_points\| ≤ 0.011`. **No percentage carve-out. No per-player allow-list. `failures.length === 0`, asserted on the array, not on a count ratio** ⟨D⟩ (reference: 300/300, max residual 0.00) | any statId dropped, mis-mapped, or re-purposed by ESPN |
| **QA-R1.2** | Mutation: harvest map loses `102` | same data, scorer run with `{102:0}` | test **fails**, and the failure message names **Parker Washington, residual −12.00** ⟨D⟩ (2 punt-return TDs [M]) | the assertion is written as a mean/percentage and absorbs 12 players |
| **QA-R1.3** | Mutation: harvest map loses `63` | scorer run with `{63:0}` | test **fails** naming **Woody Marks, residual −6.00** ⟨D⟩ [M] | as above |
| **QA-R1.4** | Failure-message contract | force one residual | message contains **name, gsis_id, expected, actual, residual** — a reviewer must be able to diagnose without re-running | message is a bare `assert.ok(ok)` |
| **QA-R1.5** | Weight-invariance | synthetic fixture: FIX-QB1 with every component × **1.37** and `proj_points = 350.38 × 1.37 = 480.02` | `score_PPR = 480.02` (± 0.011). Proves the identity survives non-zero signal weights, so the gate does not quietly weaken the day a signal earns weight | the scorer or builder introduces a per-category scalar |

### R2 — coverage is all-or-nothing

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-R2.1** | `gsis_id` set equality | both committed files | `new Set(components.ids)` **deep-equals** `new Set(projections.ids)`; **both sizes equal** ⟨D⟩ (reference: 300 = 300) | partial coverage ships and the board mixes PPR and custom rows |
| **QA-R2.2** | Missing-row diagnostic | delete one component row in-memory | fails, message names the missing `gsis_id` **and** its player name from the projections side | a symmetric-difference test prints only ids |
| **QA-R2.3** | Schema strictness | `data/contracts/player_components.schema.json` | `additionalProperties: false`; every component key in the §3.2 whitelist; **no key outside it**; every value a finite number ≥ 0 except `pass_int` / `fum_lost` which are counts ≥ 0 | the builder loops `for k, v in stats` and carries an unknown ESPN id forward |

### R4 — every non-zero key is scored or declared

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-R4.1** | Total coverage | OMILIA profile | `classifyKeys(profile)` returns `modeled ∪ unmodeled ⊇ {every key with value ≠ 0}` (**65 non-zero keys**). **Assert the unmodeled SET, never a count:** `{pass_cmp_40p, pass_td_40p, pass_td_50p, rush_40p, rush_td_40p, rush_td_50p, rec_td_40p, rec_td_50p, bonus_pass_yd_400, bonus_rush_yd_200, bonus_rec_yd_200, pass_int_td, def_4_and_stop, st_ff, st_fum_rec}`. **⚠ QA FINDING — SOLUTION_DESIGN §3.4 calls this "12 keys" but its own table enumerates 15** (three rows pair two keys each). The set is authoritative; the string "12" appears in the §11 page mockup and in acceptance criterion 5 and must be corrected to a **computed count**, never a literal | a key is silently neither scored nor disclosed — or the UI prints a hardcoded "12" that disagrees with the list it expands to |
| **QA-R4.2** | Disjointness | same | `modeled ∩ unmodeled === ∅` | a key is both scored and disclosed as unmodeled — a double lie |
| **QA-R4.3** | Unknown key | profile with a fabricated key `pass_td_70p: 9.0` | classified **unmodeled**, contributes **0.00**, appears in the coverage block. **Never dropped, never guessed** | a future Sleeper key silently vanishes from the UI |

### R5 — bounds must not read as measurements

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-R5.1** | Tight bounds | FIX-QB1 + OMILIA | `unmodeledBounds()` returns `pass_td_40p ≤ 46` (= `pass_td`), `pass_td_50p ≤ 46`, `pass_int_td ≤ 8` (= `pass_int`), `bonus_pass_yd_400 ≤ games`. Upper exposure for FIX-QB1 = `46×2 + 46×4 + 8×(−4) + games×5` — assert **each term against its own source field**, not the sum alone | a bound is computed from the wrong field (e.g. `pass_td_40p ≤ pass_att`) and reads as a measurement |
| **QA-R5.2** | No-bound keys | same | `pass_cmp_40p`, `rush_40p`, `def_4_and_stop`, `st_ff`, `st_fum_rec` return **`null`**, and the UI string is literally `"no bound"`. **Asserting `null`, not `Infinity`, not `0`** | a loose bound is printed (bounding `pass_cmp_40p` by `pass_cmp` implies **+319 pts** — vacuous, and worse than saying nothing) |
| **QA-R5.3** | Range formatting | a player with upper exposure 38 | renders exactly `+0 to +38 pts not modeled`; the lower bound is **always 0** and never omitted | the UI shows a single number, which reads as a point estimate |

---

## 2. Scoring evaluator unit tests — `tests/feature/league_profile.test.mjs`

Pure `node:test`, no DOM, no fetch. Every value here is **PINNED**.

### 2.1 The default table and the two headline keys

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-S1** | `ESPN_PPR_DEFAULT` is ESPN-PPR, not Sleeper-PPR | the exported constant | **`pass_td === 4.0`** (not 6.0), `pass_yd 0.04`, `pass_int −2.0`, `rush_td 6.0`, `rec 1.0`, `rec_yd 0.1`, `rec_td 6.0`, `fum_lost −2.0`, `st_td 6.0`, `fum_rec_td 6.0`, **`pass_cmp 0.0`**. Assert the **whole table** with `deepStrictEqual` | someone "corrects" `pass_td` to 6 and every default-path number moves |
| **QA-S2** | FIX-QB1 under default PPR | FIX-QB1 + `ESPN_PPR_DEFAULT` | **`350.38`** = `4707×.04 (188.28) + 46×4 (184.00) + 8×(−2) (−16.00) + 1×.1 (0.10) + 3×(−2) (−6.00)`. Equals the committed `proj_points` to the cent | the scorer or the default table drifts |
| **QA-S3** | **FIX-QB1 under OMILIA — the pass_cmp 0.5 + 6-pt-TD case** | FIX-QB1 + OMILIA | **`636.38`** = `188.28 + 46×6 (276.00) + 388×0.5 (194.00) − 16.00 + 0.10 − 6.00`. Delta vs PPR = **+286.00**, the largest QB delta in the pool [M] | either headline key is mis-applied |
| **QA-S4** | `pass_cmp` in isolation | FIX-QB1 + `ESPN_PPR_DEFAULT` with **only** `pass_cmp: 0.5` changed | **`544.38`**, i.e. exactly **+194.00** = `388 × 0.5`. This is the key that **cannot** be recovered from a PPR total and is the whole reason D2 requires components | a "scale the PPR total" shortcut is reintroduced |
| **QA-S5** | 6-point passing TD in isolation | FIX-QB1 + default with **only** `pass_td: 6.0` | **`442.38`**, i.e. exactly **+92.00** = `46 × 2` | — |
| **QA-S6** | Rushing QB, incl. a 2-pt conversion | FIX-QB2 | PPR **`364.62`**; OMILIA **`574.12`** (delta **+209.50** = `319×0.5` + `25×2`). `pass_2pt 1 × 2.0` present in both | 2-pt keys are dropped (they are 1 stat on 1 player and easy to lose) |
| **QA-S7** | **Position invariance — RB** | FIX-RB1 | PPR **`416.60`** and OMILIA **`416.60`** — **byte-identical**. The QB-premium keys must not perturb a non-passer | the evaluator applies a global scalar instead of per-key weights |
| **QA-S8** | **Position invariance — WR** | FIX-WR1 | PPR **`313.60`** = OMILIA **`313.60`** | — |

### 2.2 Evaluator robustness

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-S9** | Whitelist enforcement | component map with a bogus key `pass_wizardry: 99` | contributes **0.00**; result unchanged from QA-S3 (`636.38`) | the scorer iterates the component map instead of the table's known keys |
| **QA-S10** | Unmodeled non-zero key | OMILIA (all 12 unmodeled keys non-zero) | result is **exactly** the QA-S3 value `636.38` — the 12 keys contribute **precisely 0**, never an estimated rate | someone fills a "reasonable" rate for `bonus_pass_yd_400` |
| **QA-S11** | Absent component field | FIX-WR1 (no `pass_yd` at all) | **`313.60`**, not `NaN`, not a throw | `undefined × 0.04` leaks a `NaN` into a sort comparator and silently reorders the board |
| **QA-S12** | Signed keys | fixture with `pass_int 8`, `fum_lost 3` | contributes **`−16.00`** and **`−6.00`**; a profile with `fum_lost: 0` raises the total by exactly `+6.00` | `Math.abs` creeps in |
| **QA-S13** | Rounding + purity | FIX-QB1 × 2 runs | both runs `636.38`, 2-dp, **byte-identical strings**; the input component object is **not mutated** (`deepStrictEqual` against a frozen copy) | a reducer writes back into the fixture |
| **QA-S14** | `edits` is an overlay | OMILIA with `edits: { pass_td: 6.5 }` | `effectiveScoring` = `{...scoring, ...edits}` → **`659.38`** (`+0.5 × 46`); **`profile.scoring.pass_td` is still `6.0`**; deleting `edits.pass_td` restores `636.38` | edits are merged into `scoring` and "reset to league" becomes impossible |
| **QA-S15** | `isDefaultPpr` | (a) a profile whose effective table equals `ESPN_PPR_DEFAULT`; (b) same with `pass_cmp: 0.01` | (a) **`true`** → bypass; (b) **`false`** → recompute. Compares the **effective** table (scoring + edits), not `scoring` | a hand-edited default silently keeps the bypass |

### 2.3 Shape parsing (part of the same pure module)

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-S16** | Omilia normalization | captured `roster_positions` `[QB,RB,RB,WR,WR,TE,FLEX,K,DEF,BN,BN,BN,BN]`, `total_rosters 10` | `teams 10`; `starters ['QB1','RB1','RB2','WR1','WR2','TE1','FLEX','K1','DEF1']` (**9**, repeats numbered in encounter order); `bench ['BN1'..'BN4']`; `starterDemand {QB:1,RB:2,WR:2,TE:1,K:1,DEF:1}`; `flex {FLEX:['RB','WR','TE']}`; `size 13` | a 7-slot lineup is presented for a 9-starter league (an **acceptance-criterion-6 gate failure**) |
| **QA-S17** | Flex-token table | `REC_FLEX`, `WRRB_FLEX`, `SUPER_FLEX` | `['WR','TE']`, `['WR','RB']`, `['QB','RB','WR','TE']` respectively | a SUPER_FLEX league spreads flex demand over RB/WR/TE only |
| **QA-S18** | IDP + reserve tokens | `[...,'IDP_FLEX','DL','LB','DB','IR','TAXI']` | those four land in **`shape.unsupported`** (surfaced, never silently dropped); `IR`/`TAXI` excluded from `size`; the **17 zero-valued IDP scoring keys still round-trip** through the editor unchanged | an IDP league silently renders a shape it does not have |
| **QA-S19** | Payload parse | the captured Sleeper league JSON | `name 'Omilia-US'`, `season 2026`, **147 scoring keys stored including zeros**, **65 non-zero**, `positionCaps {QB:2,RB:5,WR:5,TE:3,K:2,DEF:2}` from `position_limit_*` | storing only non-zero keys makes hand-editing lossy |
| **QA-S20** | `draftRounds ≠ size` | same payload | **`draftRounds === 3`** (from `settings.draft_rounds`) and **`size === 13`**, `maxKeepers === 1`. Assert they are **not equal** | the draft room runs 13 rounds for a 3-round keeper draft |
| **QA-S21** | **Kicker scoring** | pinned kicker components `fg_made_0_19 2, _20_29 6, _30_39 9, _40_49 8, _50_59 4, _60_ 1, fg_missed 5, pat_made 40, pat_missed 2` + table `3/3/3/4/5/6, fgmiss −1, xpm 1, xpmiss −2` | **`140.00`** = `6+18+27+32+20+6−5+40−4`. Named nflverse columns map 1:1 — **no ESPN statId decode** (RM9: a decode that hit 2/2 exactly then failed 9 of 42) | someone re-introduces the ESPN bucket decode |
| **QA-S22** | **D/ST tiers must be scored PER GAME** | pinned 2-game defense — G1: `pts_allow 3, yds_allow 250, sack 4, int 2, fum_rec 1, def_td 1, ff 2`; G2: `pts_allow 24, yds_allow 410, sack 1, safe 1, ff 1, blk_kick 1`; table `pts_allow_1_6 7, pts_allow_21_27 0, yds_allow_200_299 2, yds_allow_400_449 −3, sack 1, int 4, fum_rec 2, def_td 6, safe 2, ff 1, blk_kick 2` | **`34.00`** (G1 `31.00` + G2 `3.00`). **And assert the season-total trap explicitly:** scoring the summed season (`pts_allow 27`, `yds_allow 660`) gives **`21.00`** — a **13.00** error. This is the case that proves ARCHITECTURE §6.2's "same season-total wall" wrong and locks the weekly requirement | anyone "optimizes" the builder to store season totals for D/ST |
| **QA-S23** | Fetch discipline | `fetchSleeperLeague('1393691504228184064')` against a stub | request carries **`credentials: 'omit'`** (ACAO `*` + `allow-credentials: true` is illegal for a credentialed request), **no custom headers** (keeps it a simple request, no preflight), and aborts at **12 000 ms** via `AbortController` then resolves to a typed `{ error: 'fetch_failed' }` — **never a throw, never a hang** | K1 materializes on the real domain and the page hangs instead of falling to the paste tier |
| **QA-S24** | Malformed paste | `'{"total_rosters": 10'` (truncated) and `'{}'` | typed error, **no profile written to storage**, the previously connected profile **unchanged**. A half-parsed profile must never reach `localStorage` | a bad paste half-connects a league and the board silently mixes shapes |

---

## 3. League-shape tests — add-only in `team_vor` / `auction` / `lineup` / `draft_sim`

**The defect these lock, verified in source:** `team-logic.js:781` computes
`ranked[demand + extra]` (**per-roster** — as if the league had one team) while
`auction.js:107-108` computes `Math.round(demand * leagueSize) - 1` (**league-wide**).
**Team count therefore has no effect on VOR today.** Rel19 closes this *only under a
profile*; the default path keeps today's arithmetic byte for byte.

All values ⟨D⟩ — recompute from committed data inside the test. Reference values
measured 2026-08-13 [M].

| # | Case | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-L1** | Default path unchanged | `replacementLevel(pool, weekly, 'ppr', 'QB')` with **no** `shape` argument | identical to today: `ranked[1]` ⟨D⟩ (**351.96**, Drake Maye). RB gets FLEX's `+1` via `flexAbsorbPos` → `ranked[3]` ⟨D⟩ (**362.30**); WR `ranked[2]` ⟨D⟩ (**324.00**); TE `ranked[1]` ⟨D⟩ (**210.80**) | the optional argument is not truly optional |
| **QA-L2** | **10-team replacement level** | shape `{teams:10, starterDemand{QB:1,RB:2,WR:2,TE:1,K:1,DEF:1}, flex{FLEX:[RB,WR,TE]}}` + OMILIA points | QB index `Math.round(1×10)−1 = 9` → **10th-best QB** ⟨D⟩ (**496.06**, Jalen Hurts) | the per-roster formula is used under a profile and a 10-team manager drafts as if QBs were top-3 picks |
| **QA-L3** | **10-team ≠ 12-team — the headline league-shape assertion** | same, `teams: 12` | QB index `11` → **12th-best QB** ⟨D⟩ (**487.18**, Mahomes). **Assert `repl10 !== repl12`** ⟨D⟩ (difference **8.88**), and assert `repl10 > repl12` — fewer teams ⇒ shallower demand ⇒ a *better* free player ⇒ *less* scarcity. **This is the case that proves team count is no longer cosmetic** | `teams` is stored but never reaches the arithmetic |
| **QA-L4** | Fractional flex share reaches RB/WR/TE | same 10-team shape, `flexShare {RB:.45, WR:.45, TE:.10}` derived from `shape.flex` | demands `RB 2.45, WR 2.45, TE 1.10`; indices `24, 24, 10` ⟨D⟩ (**178.80 / 188.20 / 176.20**). At `teams:12` → `28, 28, 12` ⟨D⟩ (**151.10 / 182.70 / 161.50**). Uses **`Math.round`** (JS half-up), asserted at the `.5` boundary `2.45 × 10 = 24.5 → 25` | a language-rounding difference silently shifts every replacement level by one rank |
| **QA-L5** | **The two engines finally agree** | same shape, same pool, same table | `replacementLevel(..., shape)` **equals** `auction`'s internal `repl[pos]` for **all of QB/RB/WR/TE** | the divergence survives into the profile path and VOR disagrees with auction dollars on the same screen |
| **QA-L6** | SUPER_FLEX | shape with `flex {SFLEX:['QB','RB','WR','TE']}` | QB demand > 1; QB replacement moves **deeper** than QA-L2's. Assert `demandQB > 1` and the index changes | `flexShare` is keyed off a hardcoded RB/WR/TE map |
| **QA-L7** | VOR re-rank end-to-end | 10-team OMILIA shape over the committed pool | top-1 by VOR ⟨D⟩ (**McCaffrey, 237.80**); **the first QB appears at VOR rank 8** ⟨D⟩ (**Stafford, VOR 140.32**) even though he is **#1 by raw points at 636.38**. Assert the **invariant**: *the raw-points leader is not the VOR leader under this profile* — points ≠ draft order | a QB-premium league is mistaken for "draft QBs first" |
| **QA-L8** | Nine lineup slots | `bestLineup(players, shape)` with the Omilia shape | `Object.keys(slots).length === 9`, order `QB1,RB1,RB2,WR1,WR2,TE1,FLEX,K1,DEF1`. **A 7-slot "optimal" lineup is a gate failure** (acceptance criterion 6) | the shape argument is accepted and ignored |
| **QA-L9** | Greedy proof holds with heterogeneous flex | shape with `RFLEX` (RB/WR), `FLEX` (RB/WR/TE), `SFLEX` (QB/RB/WR/TE) | flex slots fill **after** dedicated slots and **in increasing order of eligibility breadth** (`RFLEX` → `FLEX` → `SFLEX`); the resulting total equals a brute-force optimum on a 12-player fixture. The ordering rule is the **only** thing keeping the greedy proof true and must also be in the module docstring | a future edit reorders the flex scan and the optimizer silently returns a sub-optimal lineup |
| **QA-L10** | Caps come from the profile | Omilia `positionCaps {QB:2,RB:5,WR:5,TE:3,K:2,DEF:2}` | `bestPickNow` never proposes a 3rd QB or a 3rd K under this profile. **With no profile, `POSITION_CAPS` stays `{QB:2, DEF:1, DST:1, K:1}`** (verified at `team-logic.js:632`) | profile caps leak into the default path |
| **QA-L11** | `ros.js` needs no signature change | `rankByRos(..., { cutoffs })` | passing `teams × starterDemand` = `{QB:10, RB:24(→ 2.45×10), WR:24, TE:11}` changes the ranking; **omitting `opts.cutoffs` reproduces `STARTER_CUTOFFS {QB:12,RB:24,WR:36,TE:12}` exactly** (verified at `ros.js:104/112` — FEASIBILITY's "hardcoded 12" is wrong) | someone edits `ros.js`, which P3 must not touch |
| **QA-L12** | Auction caps extend to K/DEF | `teamNeedsPos` with an Omilia shape | K and DEF are needed until their caps; **with a default shape the caps map is unchanged** (`auction.js:161-166`) and no K/DEF is ever needed | the classic 13-slot auction starts nominating kickers |
| **QA-L13** | `marketDollars` must NOT change | profile connected | `marketDollars` output is **byte-identical** to the no-profile run. It is ADP-derived and ADP is the market's PPR consensus; re-scoring it would invent data. The BAIT/TARGET spread between our custom dollars and the PPR market is the *product*, not a bug | someone "fixes" the inconsistency and destroys the arbitrage signal |
| **QA-L14** | Draft-sim opponents stay on ADP | profile connected | opponent picks are **byte-identical** to the no-profile run for the same seed; **only our picks move**. The ADP room *is* the benchmark | a room that magically knows our custom scoring flatters our engine |
| **QA-L15** | **`poolScale` is a literal 1.0 on the default path** | (a) no profile; (b) OMILIA | (a) `poolScale === 1.0` asserted with **`Object.is(poolScale, 1)`** — a literal short-circuit, **not** a computed value that rounds to 1; every fit bonus is exactly `STACK_BONUS 12 / BYE_COVER_BONUS 6 / BYE_CLASH_PENALTY 10 / FLOOR_BONUS 8 / MATCHUP_BONUS_CAP 8`. (b) `poolScale > 1.3` ⟨D⟩ (reference at N=24: **1.4449**; N=12: **1.5288**) and the effective stack bonus is `12 × poolScale` | K3: the points-denominated bonuses become a materially smaller nudge in a 636-point pool and the fit engine changes character with no constant changed |

---

## 4. Dormancy tests

Dormancy is **two-dimensional** (offense components land on the next ordinary pipeline
run; K/DST are runner-built), so the five states of SOLUTION_DESIGN §6 must each be
pinned. **No blending, no scaling, no ratio approximation** in any degraded state — the
measured error of approximating Omilia from a PPR total is **+145.57 mean, +286.00 max
for QBs [M]**, which is precisely the fabrication the honesty rule forbids.

| # | State | Given | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-D1** | **D0** — no profile | fresh storage | `app/data.js` is **never asked** for `player_components.json`, `kdst_projections.json` or `kdst_components.json` (assert via a fetch spy counting requests by URL, **=== 0**) | the default path pays for and depends on files it must not read |
| **QA-D2** | **D1** — profile, components 404 | profile connected, `player_components.json` returns 404 | **shape applies**: 9 lineup slots, 10-team replacement level, roster caps, lineup geometry — all live | shape and scoring are coupled and the best property of the design is lost |
| **QA-D3** | **D1** — scoring does *not* apply | same | every player number equals the **D0 PPR value byte-for-byte** ⟨D⟩ (e.g. Stafford renders **350.4**, *not* 636.4) | a "close enough" scalar is applied |
| **QA-D4** | **D1** — the banner | same | a **persistent, non-dismissable** header banner is present containing the league name and the words *"per-player components have not been built yet"* and *"ESPN-PPR"*; **no dismiss control exists in the DOM** | a screenshot of a PPR board is mistaken for a custom board |
| **QA-D5** | **D1** — per-card chip | same | **every** player card carries a `PPR` chip; the count of chips equals the count of rendered player cards | the banner scrolls away and the chips are the only remaining signal |
| **QA-D6** | **D2** — no K/DST | components present, `kdst_projections.json` 404 | QB/RB/WR/TE fully custom (Stafford **636.4**); K and DEF slots render the literal string `— awaiting K/DST feed —` with a `[why?]` control; the card total reads exactly **`7 of 9 slots projected`** | a 9-starter league silently gets a 7-slot "optimal" lineup |
| **QA-D7** | **D2** — warning channel | same | `bestLineup(...).warnings` contains **exactly 2** entries, `{slot:'K1', reason:'unsupported_slot'}` and `{slot:'DEF1', reason:'unsupported_slot'}`; **`slots.K1 === null`** (present-but-unfilled, not absent) | the slot is dropped from `slots` and the lineup looks complete |
| **QA-D8** | **D2** — reason strings stay distinguishable | a fixture producing **both** a Rel17 forced start **and** an unsupported slot | warnings contain both `'no_available_alternative'` and `'unsupported_slot'`; the view renders **two different** banner texts. (Rel17's channel is `lineup.js:93-106`; `availability_app.test.mjs:257` locks the existing reason string) | the new reason is folded into the old one and "we have no kicker" reads as "your kicker is hurt" |
| **QA-D9** | **D3** — everything present | all three files | 9 slots projected; a `PARTIAL SCORING` chip on **DEF** naming exactly `def_4_and_stop, st_ff, st_fum_rec`; a chip on any position with non-zero unmodeled keys | K4: a manager believes an incomplete total is complete |
| **QA-D10** | **D4** — a row missing (gate-unreachable via R2) | components present, one player's row deleted at runtime | that row shows its **PPR** value plus a chip; the list header counts it (`"1 player on PPR"`); it is **never** silently sorted among custom-scored rows | a single missing row mis-ranks the board with no visible trace |
| **QA-D11** | Builder emits empty, never partial | `build_kdst.py` with the upstream unreachable | writes `{"players": []}` **and** a `degraded` row in `pipeline_status.json`; **exit code 0**; matches the `build_epa_history` / `build_injury_history` pattern. *An empty file is honest; a half file is a lie that passes `fetch`* | a truncated CSV read produces 6 kickers and the draft board ranks them as the complete set |
| **QA-D12** | Optionality is asymmetric | `validate_data.py` | `kdst_projections.json` and `kdst_components.json` are in **`OPTIONAL_DATA`** (absence ≠ failure, presence validated strictly); **`player_components.json` is NOT** — it is written by the same run as `player_projections.json`, so its absence **reds the gate** | the one non-dormant new file is quietly made optional and the reconciliation gate stops running |

---

## 5. Backward-compatibility suite — the realization of R3

**R3 is the single most important test in Rel19.** It converts *"no number moves
silently"* from a hope into a mechanical property. Its template already exists and
passes: `ros.test.mjs`'s *"zero-weight SoS/availability reproduces the raw sum EXACTLY
(never-regress default)"* — imitate its structure.

**Method (all of QA-B1…B6):** capture a **pre-Rel19 baseline** by running the current
`main` against the committed data and serializing every rendered number to a JSON
snapshot; then run the Rel19 build with `profile == null` and assert
`deepStrictEqual` on the snapshot. **Byte-identical strings, not numeric tolerance** —
a tolerance here would permit exactly the drift the test exists to forbid.

| # | Case | Surface | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-B1** | Players list | `#/players`, all three modes (`ppr`/`half`/`std`) | every `proj`, `low`, `high`, badge and the **row order** byte-identical to baseline ⟨D⟩ (spot-check: McCaffrey **416.6 / 287.45 / 545.75**, row 1; Noah Gray **38.8**, row 300) | the recompute path leaks into the default path |
| **QA-B2** | Team / VOR / best-pick-now | `#/team` | `replacementLevel`, `vorScore`, the top-3 strip **and its reason sentences** byte-identical ⟨D⟩ | the optional `shape` argument changes behaviour when omitted |
| **QA-B3** | Lineup | `#/lineup` | `slots`, `bench`, `total`, `warnings` byte-identical; **7 slots**, not 9; `__selftest() === true` **untouched** | `LINEUP_SLOTS` is replaced rather than defaulted |
| **QA-B4** | Auction | auction surface | `marketDollars`, `fairDollars`, `planBudget` byte-identical; budget conservation intact | `rosterShape()`'s new `k`/`def` bounds do not default to 0 |
| **QA-B5** | Fit engine | `fitScore` on the frozen fixture | **byte-for-byte identical** to `team_logic.test.mjs:345`'s locked value — the strictest assertion in the repo, and the reason QA-L15's `poolScale` must short-circuit to a **literal** 1.0 | K3 |
| **QA-B6** | The bypass never reads components | `profile == null` and `isDefaultPpr === true` | `componentsById` is accessed **zero times** (Proxy/spy counter `=== 0`) on a full render of all four surfaces. *The primary defence is not "reconcile within tolerance" — it is that the default path never executes new code* | reconciliation becomes the only thing standing between a bug and every number in the app |
| **QA-B7** | `scoringAdjust` untouched | direct call | `scoringAdjust(300, 100, 'half') === 250` and `'std' === 200` exactly (the existing `team_logic.test.mjs:94` assertion); signature and body unchanged | — |
| **QA-B8** | `weeklyPoints` untouched | a custom season total | 18 floats scale by `seasonAdj/seasonPpr`, byes stay `0.0`, non-bye weeks sum to the season total. **Already ratio-based and scoring-agnostic — a custom total flows through with no formula change** | someone adds a scoring branch to a function that does not need one |
| **QA-B9** | `nfl2026.scoring.v1` survives | connect a profile, then disconnect | the stored `'ppr'\|'half'\|'std'` value is **unchanged throughout**; on disconnect the segment re-enables **on the previously stored mode** | the migration everyone assumes is needed is quietly performed and a user's mode is lost |
| **QA-B10** | Visible precedence | profile connected | the PPR/HALF/STD segment renders **`disabled`** (assert the attribute) with the label `SCORING · OMILIA-US` and a link to `#/scoring`. **Disabled, not hidden** | K8: two controls silently fight over the same number |
| **QA-B11** | Untouched contracts | `git diff --stat` in CI | `data/player_projections.json`, `data/player_weekly.json` and **both schemas** show **zero** changed lines (acceptance criterion 8). `weekly_contract.test.mjs`'s index-mirror and `real_data.test.mjs`'s sorted/≥150 assertions pass **unedited** | K6: a later agent merges K/DST into `player_projections.json` and the `projected[:300]` truncation evicts ~74 offensive players — the 300th is **Noah Gray at 38.8** while kickers project 130–195 [M] |
| **QA-B12** | **Compare — the one documented R3 exception** | `#/compare`, mode `half`, **no profile** | Compare's `proj` **changes** from today's value ⟨D⟩ (Chase renders `313.6 − 0.5×125 = 251.1` in `half`, not `313.6`) because `views/compare.js:100` reads `Number(p.proj_points)` raw and honours no mode at all. **This is a correction, and it is carved out of R3 explicitly, with this test and its own release-note line.** In `ppr` mode the value is unchanged | the fix rides in unannounced, or Compare is silently excluded from D3 |

---

## 6. E2E — `tests/web/web.spec.mjs`

| # | Case | Steps | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-E1** | Route + 7th tab | `goto('/#/scoring')` | the view paints; the tab bar has **7** tabs with `#/scoring` active; `.topbar`/`.tabbar`/`#view` still tile without overlap at 390 px and 1024 px (the existing geometry assertion must be re-run with 7 tabs) | a 7th tab overflows the bar on iPhone width |
| **QA-E2** | **Connect (Tier 1 or Tier 2)** | paste `1393691504228184064`, press FETCH; **if the network is unavailable, paste the captured league JSON instead — the test must pass on either tier** | renders `Omilia-US`, **10 teams**, **9 starters** `QB RB RB WR WR TE FLEX K DEF`, **4 bench**, **147 keys / 65 non-zero**, caps `QB2 RB5 WR5 TE3 K2 DEF2`, `3-round keeper draft` | K1 — and note the CORS verdict is **inference, not fact**: the browser leg against Sleeper's own host is unproven, so **this test must not depend on the network** |
| **QA-E3** | Hand-edit + persistence | edit `pass_td` 6.00 → 6.50; reload | the value reads `6.50`, carries `*`, the header reads `1 edited`, and `scoring.pass_td` is still `6.0` underneath | D1's hand-editability regresses on reload |
| **QA-E4** | Reset to league | after QA-E3, press **reset to league** | `6.00` restored exactly; `edits` empty; `0 edited` | — |
| **QA-E5** | Re-fetch preserves edits | after QA-E3, press FETCH again | `pass_td` still `6.50`; a league-side change to a **different** key is picked up | a re-fetch destroys the manager's work |
| **QA-E6** | Disconnect → D0 | press **disconnect** | `nfl2026.league.v1` removed; Players numbers return to the QA-B1 baseline **byte-identical**; the PPR/HALF/STD segment re-enables. **This is the one-line emergency stop** | rollback is not actually reachable from the UI |
| **QA-E7** | **The re-rank** | connect, `goto('/#/players')` | row 1 is **Matthew Stafford at 636.4** ⟨D⟩ (was **McCaffrey 416.6** ⟨D⟩ at row 1 in D0). Assert the **invariant** — *"the #1 row differs from the D0 #1 row, and the new #1 is a QB"* — rather than the literal name, so a data refresh cannot red the gate | D2's entire purpose is unverified |
| **QA-E8** | Position invariance on screen | same render | McCaffrey's number is **416.6** in **both** D0 and the connected state ⟨D⟩ — an RB must not move because a passing key changed | a global scalar is applied instead of per-key scoring |
| **QA-E9** | Nine-slot lineup | connect, `goto('/#/lineup')` | **9** slot rows; with no K/DST feed, K1 and DEF1 read `— awaiting K/DST feed —`; the total reads `7 of 9 slots projected` | acceptance criterion 6 |
| **QA-E10** | Coverage block | on `#/scoring` | a per-position coverage row for QB/RB/WR/TE/K/DEF; DEF marked **partial** naming its 3 keys; an `N non-zero keys contribute 0 — [show them]` control whose **N is computed and equals the length of the list it expands to** (see QA-R4.1: the design's literal "12" disagrees with its own 15-key enumeration — assert `N === list.length`, never `N === 12`); a reason per key; exposure shown as `+0 to +N pts not modeled` where a tight bound exists and `no bound` where it does not | K4, or a header count that contradicts the list one click away |
| **QA-E11** | Unmodeled keys are visible, not hidden | expand the list | `pass_cmp_40p` is present, greyed, with the reason `not modeled (per-play distance, no bound)`. **Hidden ≠ disclosed** | a manager believes the total is complete |
| **QA-E12** | Share round-trip | copy share link → open in a fresh context | `#/scoring?league=…` re-fetches; `#/scoring?p=<base64url>` decodes (with and without `CompressionStream`); **import lands in a REVIEW state the user confirms — never a silent overwrite** of an existing profile | a shared link silently replaces a hand-tuned profile |
| **QA-E13** | Dormant banner is visible in the browser | force a `player_components.json` 404 | the banner is present and **has no dismiss control**; the shape is still applied (9 slots) | QA-D4/D2 pass in unit-land while the real page fails |
| **QA-E14** | Density at iPhone width | 390 px viewport on `#/scoring` | the scoring table collapses to **one column per category group** with a sticky category sub-header; **no horizontal page scroll** (`scrollWidth <= clientWidth`); the AA-audited tokens still apply | the densest surface in the app becomes unusable on the secondary target |

---

## 7. Pipeline / validator cases

| # | Case | Where | Expect (exact) | Reds when |
|---|---|---|---|---|
| **QA-P1** | Whitelist harvest | `espn_players.py` selftest | the harvested statId set is **exactly** `{0,1,3,4,19,20,23,24,25,26,42,43,44,53,63,72,101,102,104}`. **Assert set equality, not superset** | a `for k, v in stats` loop starts carrying an unknown ESPN id into the scorer |
| **QA-P2** | Real-season entry selection | same | still `statSourceId == 0 && statSplitTypeId == 0 && seasonId == season`. **`statSourceId == 1` is ESPN's own projection and must never be read** | the harvest silently swaps measured reality for someone else's model |
| **QA-P3** | Components carry the same scalar | `build_components.py` selftest | for one player, `comp_i / prior_i` is **identical across every category** to 1e-9. This is the mechanical form of the identity in SOLUTION_DESIGN §4.1 | a per-category adjustment is introduced and reconciliation starts passing for the wrong reason |
| **QA-P4** | `validate_data.py` — new schemas | gate step 1 | three new entries in `SCHEMA_FOR_DATA`; `additionalProperties: false` on all three | an unknown field ships unvalidated |
| **QA-P5** | `validate_data.py` — reconciliation check | gate step 1 | a **cross-file** check: for every row in `player_components.json`, `score_espn_ppr(comp)` matches `player_projections.json` within **0.011**. Duplicated in Python so the reconciliation reds the gate at **step 1**, before any JS runs | a node-only check is skipped on a box without the E2E deps |
| **QA-P6** | `smoke.sh` hooks | gate step 2 | the three new files parse as JSON when present; the two K/DST files are **allowed to be absent**; `player_components.json` absent ⇒ **fail** | QA-D12's asymmetry is enforced in only one place |
| **QA-P7** | K/DST feeds stay out of the 300 pool | gate steps 1–3 | `player_projections.json` still has **exactly** its committed row count with **zero** K or DEF rows; its `position` enum stays `["QB","RB","WR","TE"]` | K6 |
| **QA-P8** | Cross-feed report is a report, not a gate | `pipeline_status.json` | `\|espn_default_score(nflverse_kdst) − kona_appliedTotal\|` is **recorded per K/DST** and a disagreement **does not** fail the gate. The two feeds are independent and RM9 shows ESPN's own K decode is unresolved | a red gate fires on a known-unresolved cross-feed difference and the team learns to ignore the gate |

---

## 8. Existing tests at risk

Counts are `grep -c '^\s*test('`, **measured 2026-08-13 [M]**. ARCHITECTURE's figures
for `availability_app` / `lineup` / `ros` (26/6/11) are wrong; the real counts are
21/5/9.

### 8.1 Files needing **new expected values** (2)

| File | tests | Assertion affected | New expected value |
|---|---|---|---|
| **`tests/web/web.spec.mjs`** | **74** | tab-bar count and route list (`#/`, `#/players`, `#/parlays`, `#/team`, `#/compare`, …). The topbar/tabbar/view **no-overlap geometry** assertion re-runs with a wider bar | tab count **6 → 7**; `#/scoring` added to the route list; geometry assertions must still hold at **390 px and 1024 px** with 7 tabs. **Existing per-route assertions are unchanged** |
| **`tests/feature/contrast_aa.test.mjs`** | **13** | the locked token literals mirrored from `app/theme.css` | **add** the scoring-table pairs (dense-row text on `--surface-2`, the greyed `not modeled` text, the `*` edited marker, the `PPR` / `PARTIAL SCORING` chips) at **4.5:1** for small text and **3.0:1** for UI graphics. **Extend the table, never relax a threshold.** The greyed unmodeled-key text is the live risk: "greyed out" is the classic way an AA gate gets quietly lowered |

### 8.2 Files needing **added cases only** — no existing assertion edited (11)

| File | tests | Mechanism of risk | Required additions |
|---|---|---|---|
| `tests/feature/team_vor.test.mjs` | **13** | **Highest risk.** `STARTER_DEMAND contract: QB 1, RB 2, WR 2, TE 1`; `replacementLevel: (demand+1)th best; FLEX adds +1…`; 8 `bestPickNow` tests incl. determinism | QA-L1…L7, L10. The optional `shape` argument means all 13 run on the literal current path |
| `tests/feature/team_logic.test.mjs` | **18** | `scoringAdjust … (exact)`; `slotEligible truth table`; **`v1 fitScore is byte-for-byte frozen on the fixed fixture`** (line 345 — strictest in the repo); `fitScoreV2 OFF path … byte-identical to v1`; `recommend respects the scoring mode` | QA-B5, B7, L15. `poolScale` must be a **literal** 1.0 |
| `tests/feature/team_rel2.test.mjs` | **11** | `POSITION_CAPS` incl. `DEF/DST/K at 1` (`team-logic.js:632`); "recommend excludes a 3rd QB" | QA-L10's profile case. These **strengthen** |
| `tests/feature/auction.test.mjs` | **18** | `marketDollars` absorbs exactly the room budget; `fairDollars` floors at $1; `planBudget` sums exactly; a full simulated auction never overdraws | QA-L5, L12, L13 + a 10-team/9-starter budget-conservation case. Conservation is scoring-independent |
| `tests/feature/draft_sim.test.mjs` | **15** | `rosterShape` defaults reproduce the classic 13-slot shape; bounds clamping; snake order | QA-L14 + an explicit assertion that new `k`/`def` bounds **default to 0** so `DEFAULT_ROSTER` is unchanged |
| `tests/feature/lineup.test.mjs` | **5** | `bestLineup fills dedicated slots then the best leftover FLEX`; `lineup optimizer self-check passes` (`__selftest()`); byes sink to bench | QA-L8, L9, D7. **`__selftest()` must keep passing untouched** |
| `tests/feature/availability_app.test.mjs` | **21** | Rel17's `warnings:[{slot,id,reason}]` channel; line 257 locks `reason === 'no_available_alternative'`; `warnings.length === 2` for two forced starts | QA-D8 — a case proving `'unsupported_slot'` and `'no_available_alternative'` stay **distinguishable in both the data and the rendered banner** |
| `tests/feature/ros.test.mjs` | **9** | `zero-weight … reproduces the raw sum EXACTLY (never-regress default)` — **the template R3 imitates** | QA-L11. `ros.js` itself needs **no change** (`ros.js:112` already reads `opts.cutoffs`) |
| `tests/feature/weekly_contract.test.mjs` | **6** | `players EXACTLY mirror player_projections.json (same ids, same order)` | **none — must pass unedited.** This is the strongest single argument for the separate-K/DST-contract decision (QA-B11, QA-P7) |
| `tests/feature/real_data.test.mjs` | **6** | pool ≥ 150; sorted best-first; day-zero honesty (`signals_used` empty) | **none — must pass unedited.** Same reason |
| `tests/feature/never_regress.test.mjs` | **7** | the promotion gate's own contract | **none.** QA adds one assertion elsewhere for acceptance criterion 9: Rel19 writes **nothing** to `data/meta.json`, the signal registry, or any snapshot. Custom scoring does not retrain the Elo gate, does not move a signal weight, and does not make projections more accurate — it makes them **correctly denominated** |

### 8.3 Not at risk, and why it is worth stating

`weekly_contract.test.mjs` and `real_data.test.mjs` are untouched **only because**
K/DST ship in their own contract. Both input designs proposed merging K/DST into
`player_projections.json`; measured, that would push ~74 offensive players past the
`projected[:300]` truncation (300th = **Noah Gray, 38.8** [M]; kickers project
130–195). **If a future agent proposes the merge, these two files are the tripwire.**

---

## 9. Gate arithmetic and exit criteria

| | Before | Added | After |
|---|---|---|---|
| Unit (`node --test tests/feature/*.mjs`) | 277 | **+85** | **≥ 362** |
| E2E (playwright web + pwa) | 82 | **+14** | **≥ 96** |
| Python assertions (`validate_data.py`) | — | **+2** (QA-P4, QA-P5) | — |

*The 85 unit cases are the 99 total minus the 14 E2E; QA-P4/P5/P6 execute in gate
steps 1–2 rather than step 3 but are counted once, in the 85.*

**A release is shippable only when all of the following hold:**

1. `bash tests/run_gate.sh` exits **0** — gated on the exit code, never on grepping a
   coloured summary.
2. **QA-R1.1 passes at 300 of 300**, no carve-out. Any single player outside 0.011 is
   red.
3. **QA-B1…B6 pass byte-identically** with no profile connected. QA-B12 (Compare) is the
   **only** permitted difference and must appear in the release notes.
4. **QA-D6/D7/QA-E9** pass: a 9-starter league never renders a 7-slot "optimal" lineup.
5. **QA-P7 / QA-B11** pass: `player_projections.json` and `player_weekly.json` show zero
   diff lines.
6. The **post-deploy check** in SOLUTION_DESIGN §2.3 is executed on
   `https://nfl2026.j5lagenticstrategy.com/#/scoring` and recorded: paste the league id,
   confirm 10 teams / 9 starters / 147 keys. **Thirty seconds, and it is the only thing
   that converts the CORS verdict from inference to fact.** If it fails, the paste tier
   (QA-E2) is the shipped path and the release notes must say so.
