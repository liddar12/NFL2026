# Rel19 — Custom League Scoring & League Shape: AUTHORITATIVE SOLUTION DESIGN

**Role:** Adversarial Reconciler (final)
**Date:** 2026-08-13
**Supersedes:** `ARCHITECTURE.md` and `FEASIBILITY.md` in this directory wherever they
disagree. Both remain valid as evidence logs; this file is the build contract.
**Owner decisions in force:** D1 (paste a Sleeper league id, auto-fetch, every value
hand-editable), D2 (real per-player component projections — exact, never scaled off a
PPR total), D3 (all player surfaces recalculate + a new scoring page).

> **Design-only artifact.** Nothing outside `docs/roadmap/rel19/` was created or
> modified. Every claim tagged **[R-MEASURED]** was produced by *this* reconciliation
> pass on 2026-08-13 via read-only HTTP GETs and read-only inspection of the repo.
> Claims tagged **[A]** / **[F]** are inherited from ARCHITECTURE / FEASIBILITY and are
> marked CONFIRMED, CORRECTED, or REJECTED below.

---

## 0. Executive summary — what changed after cross-checking

Both input documents are good. They disagree on four load-bearing points, and on three
of the four **both are wrong**. This pass re-measured the disputed facts directly.

| # | Dispute | ARCHITECTURE | FEASIBILITY | **Resolved** |
|---|---|---|---|---|
| **1** | Component source | ESPN kona (already fetched) | nflverse `stats_player_week` (runner-built) | **Both, split by position.** ESPN kona for QB/RB/WR/TE; nflverse for K/DST. §3 |
| **2** | Reconciliation quality | 288/300 within 0.011; 12 off by 6.0 | 289/300 within 0.01; max 6.0; loose thresholds | **300/300 EXACT, three seasons.** Both harvests were incomplete. §4 |
| **3** | D/ST tier scoring | permanently unmodelable from a season total | fully computed for 32 teams | **FEASIBILITY is right.** Tiers need *weekly*, and weekly exists. §5 |
| **4** | Kicker buckets | ESPN FG statIds usable | nflverse `fg_made_*` maps 1:1 | **FEASIBILITY is right.** My ESPN bucket decode reconciles only 33/42 kickers. §5.2 |

Two further findings neither document reached, both of which change the file plan:

- **F-NEW-1 — the 300-player truncation.** `build_predictions.py:344` writes
  `projected[:300]`. Kickers project 130–195 and D/ST 100–185 under ESPN default; the
  300th offensive player is **Noah Gray at 38.8** **[R-MEASURED]**. Merging K/DST into
  that pool would **silently evict ~74 offensive players** from Players, the draft
  board and every VOR pool. Both documents put K/DST into `player_projections.json`.
  **Rejected.** K/DST ship in their own contract. §5.4
- **F-NEW-2 — the stated gate command does not exist in this repo.** There is no
  `tests/competition.test.mjs`, no `tests/ux/`, no `tests/integrated/`. The real gate is
  `bash tests/run_gate.sh`; E2E is `tests/web/web.spec.mjs` (74) + `tests/pwa/standalone.spec.mjs` (8).
  ARCHITECTURE §10.2 names two directories that are not present. **[R-MEASURED]** §9.1

The single most important structural fact — and the reason this release is tractable —
is unchanged from ARCHITECTURE and is confirmed by reading the engine:

```python
# scripts/models/player_projection.py — project_player()
proj = baseline
for name, adj in raw.items():
    proj *= (1.0 + _weight(name, weights) * (adj - 1.0))
```

`Π applied` is **one scalar per player**, identical across every stat category. Scale
each component by that same scalar and `score_PPR(components) ≡ proj_points` **by
construction**, not by tolerance. §4.1

---

## 1. Measurement log for this pass

Everything below was executed on 2026-08-13 from this sandbox. No result is recalled.

| # | Claim | Method | Result |
|---|---|---|---|
| **RM1** | Sleeper is live and CORS-open | `GET /v1/league/1393691504228184064` with `Origin: https://nfl2026.j5lagenticstrategy.com` | `HTTP/2 200`, `access-control-allow-origin: *`, `access-control-allow-credentials: true` |
| **RM2** | Owner league shape | same payload | `total_rosters 10`, `roster_positions [QB,RB,RB,WR,WR,TE,FLEX,K,DEF,BN×4]`, `147` scoring keys / **65 non-zero**, `position_limit_{qb:2,rb:5,wr:5,te:3,k:2,def:2}`, `draft_rounds 3`, `max_keepers 1`, `reserve_slots 1`, `playoff_week_start 14` |
| **RM3** | nflverse release assets reachable | `HEAD stats_player/stats_player_week_2025.csv` | **HTTP 200** (confirms **[F]** H5; refutes the brief's 403 expectation) |
| **RM4** | kona carries full offensive components | `filterSlotIds [0,2,4,6]`, 300 rows | `stats` map present on every real-season entry; `appliedStats` empty |
| **RM5** | **Components reconstruct `appliedTotal` EXACTLY** | recompute all 300 rows under ESPN-PPR from statIds `{3:.04, 4:4, 20:-2, 19:2, 24:.1, 25:6, 26:2, 42:.1, 43:6, 44:2, 53:1, 72:-2, 63:6, 101:6, 102:6, 104:6}` | **2025: 300/300** · **2024: 300/300** · **2023: 300/300**, all within 0.011 |
| **RM6** | The residual keys both docs missed | drop `{101,102,104,63}` and re-run | 2025 falls to **289/300**, residuals exactly −6.0/−12.0 on return men — *this is precisely ARCHITECTURE's 288 and FEASIBILITY's 289* |
| **RM7** | kona serves kickers | `filterSlotIds [17]` | 42 rows, `defaultPositionId 5`, Jason Myers `appliedTotal 195.0`, FG statIds 74–87 present |
| **RM8** | kona serves D/ST | `filterSlotIds [16]` | 32 rows, `defaultPositionId 16`, Seahawks `185.0`, defensive statIds 89–136 present |
| **RM9** | **ESPN's FG buckets do NOT decode reliably** | best-fit decode `74/77/80 = FGM 50+/40-49/0-39`, `85 = FG missed`, `86 = XPM`, weights `5/4/3/−1/+1` | Myers **195.0 = 195.0 exact**, Fairbairn **190.0 = 190.0 exact** — then **only 33/42 kickers reconcile**; the rest are short by 1.0–3.6 (an undiscovered 60+ bucket and offensive statIds on kickers) |
| **RM10** | Pool truncation boundary | read `data/player_projections.json` | 300 rows, top 416.6, **300th = 38.8**; 78 players ≥185 |
| **RM11** | Test surface | `grep -c 'test('` | 277 unit across `tests/feature/*.mjs`; **no** `tests/competition.test.mjs`; E2E = `tests/web` 74 + `tests/pwa` 8 |
| **RM12** | The replacement-level divergence is real | read both engines | `team-logic.js:781` `ranked[demand + extra]` (**per-roster**) vs `auction.js:107-108` `Math.round(demand * leagueSize) - 1` (**league-wide**) |
| **RM13** | `ros.js` is already parameterised | read `ros.js:112` | `const cutoffs = opts.cutoffs \|\| STARTER_CUTOFFS;` — **[F]**'s "❌ hardcoded 12" is **CORRECTED**: it is overridable today, no signature change needed |
| **RM14** | Compare ignores scoring entirely | read `views/compare.js:100` | `proj: Number(p.proj_points) \|\| 0` — no `scoringAdjust`, no mode. Confirms **[A]** §7 |

**Not re-run:** the in-browser Playwright CORS harness. Both documents ran it, both
reached the same transport-level dead end, and **[F]**'s positive control
(`raw.githubusercontent.com`, ACAO `*`, fails identically to Sleeper) proves the sandbox
cannot answer the question. Re-running it would produce a fourth identical
`ERR_CONNECTION_RESET`. §2 states the verdict on the evidence that *is* decisive.

---

## 2. Q1 — CORS: verdict and the design it forces

### 2.1 Verdict

> **CORS IS OPEN. Design browser-direct `fetch()` as the primary path — no Netlify
> function, no backend, no pipeline-side fetch. The end-to-end proof is HEADER-LEVEL
> plus one browser-level replay; it has NOT been confirmed against Sleeper's own host
> from a browser. Treat it as high-confidence, not as fact, until it runs on
> `nfl2026.j5lagenticstrategy.com`.**

The evidence, ranked:

1. **[R-MEASURED RM1]** Sleeper returns `access-control-allow-origin: *` on a GET
   carrying the production `Origin`. **[F]** §1.1 additionally captured the `OPTIONS`
   preflight: `204`, `allow-methods GET,POST,PUT,PATCH,DELETE,OPTIONS`,
   `max-age 1728000`. A plain GET with no custom headers is a *simple request* and is
   not preflighted at all.
2. **[A]** M3 is the strongest browser-level evidence anyone produced: Chromium fetched
   a cross-origin mirror replaying Sleeper's captured headers verbatim and returned
   `status 200, type: "cors"` — the browser performing and passing a real cross-origin
   check on exactly these headers.
3. **[A]** M4 / **[F]** attempt 3 both captured a *genuine* CORS block
   (`No 'Access-Control-Allow-Origin' header is present`), proving the harness detects
   one. Sleeper's failure is `net::ERR_CONNECTION_RESET`, a different signature.
4. **[F]** §1.2's positive control is what stops this being over-claimed:
   `raw.githubusercontent.com` (ACAO `*`, reachable in production) fails **identically**.
   The sandbox browser cannot distinguish transport from policy. So the browser leg is
   *unconfirmed against Sleeper's host*, and the design must not depend on it silently.

**REJECTED, with ARCHITECTURE's and FEASIBILITY's reasons upheld:** Netlify function
proxy (adds a server dependency to a deliberately static app for a problem the evidence
says does not exist); pipeline-side fetch keyed by a committed league id (single-tenant,
puts a cron between "I edited my scoring" and "the app agrees", and contradicts D1);
build-time fetch (same, plus it breaks the paste and hand-edit tiers).

### 2.2 Rules the fetch code must obey

1. **`credentials: 'omit'`, stated explicitly.** Sleeper sends `ACAO: *` *and*
   `access-control-allow-credentials: true`; that pair is illegal for a credentialed
   request and the browser will reject `*`. `app/data.js` uses `'same-origin'`, which is
   already safe cross-origin, but `app/league-profile.js` must say `'omit'` so nobody
   "fixes" it later.
2. **No custom request headers.** Keeps it a simple request: one round trip, no preflight.
3. **A 12-second timeout via `AbortController`**, then fall to Tier 2. The sandbox's
   uniform ~12.8 s reset **[F]** is a reminder that a hung fetch must not hang the page.

### 2.3 The fallback ladder — all three tiers ship in Rel19

| Tier | Path | When |
|---|---|---|
| 1 | Direct `fetch('https://api.sleeper.app/v1/league/<id>')` | normal |
| 2 | **Paste league JSON** into a textarea | fetch failed / offline / corporate DNS / Sleeper outage / a non-Sleeper league |
| 3 | **Hand-build from the PPR default**, all 147 keys editable | no league at all |

Tier 2 is not contingency scaffolding: D1 requires every value be hand-editable, so the
editor exists regardless, and the paste box is a textarea on top of it. **One widget,
three jobs** — CORS fallback, non-Sleeper leagues, and cross-device transfer (§8).

**First post-deploy action (mandatory, in the deploy checklist):** load
`https://nfl2026.j5lagenticstrategy.com/#/scoring`, paste `1393691504228184064`, press
FETCH, confirm 10 teams / 9 starters / 147 keys render. Thirty seconds; converts the
verdict from inference to fact.

---

## 3. The component model — one design, two sources

### 3.1 The split, and why it is not a compromise

| Family | Source | Reconciles | Dormant? | Rationale |
|---|---|---|---|---|
| **QB / RB / WR / TE** | **ESPN kona** — the entry `espn_players.py` already downloads and discards | **Exact by construction** (§4.1), verified **300/300 × 3 seasons** [RM5] | **NO** — lands on the next ordinary pipeline run | Same feed that produces `baseline`. No new fetch, no join, no 8.6 MB CSV, no runner dependency, and coverage is 300/300 by definition because the rows *are* the projection rows |
| **K / D-ST** | **nflverse** `stats_player_week` + `stats_team_week` + `nfldata/games.csv` | n/a — these are **new** numbers; nothing existing can move | **YES** — runner-built, ships empty | Named columns (`fg_made_0_19`…`fg_made_60_`) decode unambiguously; **weekly** granularity is the only way to score `pts_allow_*` / `yds_allow_*` tiers |

This resolves Dispute 1 without splitting the difference. ARCHITECTURE is right that the
components are already in hand for offense, and that this makes reconciliation an
identity rather than a tolerance. FEASIBILITY is right that K/DST need weekly nflverse
data — and **[R-MEASURED RM9]** proves the point harder than **[F]** did: my own best-fit
ESPN kicker decode reproduces two kickers to the cent and then fails on 9 of 42. Shipping
that would be exactly the "confidently wrong" outcome ARCHITECTURE's own K9 risk forbids.

### 3.2 Offensive component harvest — the exact statId map

Verified present on the real-season entry the pipeline already reads **[RM4, RM5]**:

| Component | statId | ESPN-PPR weight | Owner-league key |
|---|---|---|---|
| `pass_att` | 0 | 0 | — (denominator only) |
| `pass_cmp` | 1 | 0 | **`pass_cmp` 0.5** ← the key that cannot be recovered from a PPR total |
| `pass_yd` | 3 | 0.04 | `pass_yd` 0.04 |
| `pass_td` | 4 | 4.0 | **`pass_td` 6.0** |
| `pass_2pt` | 19 | 2.0 | `pass_2pt` 2.0 |
| `pass_int` | 20 | −2.0 | `pass_int` −2.0 |
| `rush_att` | 23 | 0 | — |
| `rush_yd` | 24 | 0.1 | `rush_yd` 0.1 |
| `rush_td` | 25 | 6.0 | `rush_td` 6.0 |
| `rush_2pt` | 26 | 2.0 | `rush_2pt` 2.0 |
| `rec_yd` | 42 | 0.1 | `rec_yd` 0.1 |
| `rec_td` | 43 | 6.0 | `rec_td` 6.0 |
| `rec_2pt` | 44 | 2.0 | `rec_2pt` 2.0 |
| `rec` | 53 | 1.0 | `rec` 1.0 |
| **`fum_rec_td`** | **63** | 6.0 | `fum_rec_td` 6.0 |
| `fum_lost` | 72 | −2.0 | `fum_lost` −2.0 |
| **`st_td`** | **101, 102, 104** | 6.0 each | `st_td` 6.0 |

**The 101/102/104/63 row is the finding.** Omitting it is what produced ARCHITECTURE's
12 bad rows and FEASIBILITY's 11 **[RM6]** — the two documents independently rediscovered
the same hole and both wrote a tolerance around it. With the full set the residual is
**zero on 900 player-seasons**. FEASIBILITY's own warning was right and should be carved
into the builder: *"a component scorer that forgets return TDs looks correct on 95% of
players and is silently wrong on exactly the ones fantasy managers argue about."*

Builder rule: the harvest must **whitelist** these statIds by name. A `for k, v in stats`
loop that carries unknown ids forward will silently start scoring a key ESPN adds later.

### 3.3 K / D-ST component build (runner)

`scripts/build_kdst.py`, stdlib `csv` only, guarded `requests`, same shape as
`build_epa_history.py`:

- **Kickers** — `stats_player_week_{season}.csv`, `position == 'K'`, REG only.
  `fg_made_0_19 / _20_29 / _30_39 / _40_49 / _50_59 / _60_` (note the trailing
  underscore **[F]** §3.3), `fg_missed`, `pat_made`, `pat_missed`. Every owner-league
  kicker key is covered **exactly**.
- **D/ST** — per team per week:
  `def_sacks`, `def_interceptions`, `def_tds`, `def_safeties`, `def_fumbles_forced`,
  `fumble_recovery_opp`, `def_fg_blocks + def_punt_blocks + def_pat_blocks`,
  `special_teams_tds`; **points allowed** from `nfldata/games.csv` (already fetched by
  `build_market_baseline.py:27`) inverted per team; **yards allowed** from the
  *opponent's* `stats_team_week` `passing_yards + rushing_yards`.
  Tiers are then evaluated **per game and summed** — which is the whole point of using
  weekly data and is what makes ARCHITECTURE §6.2's "same season-total wall" claim
  **WRONG**. FEASIBILITY computed all 32 defenses this way (HOU 236.0) **[F]** §4.2.
- **Baseline for the projection identity.** K/DST `proj_points` = their prior-season
  components scored under **ESPN's default table** × the same `Π applied` scalar, so they
  enter through the identical day-zero path as every other position. **No new model.**
- **Cross-check, not a gate.** The builder additionally records
  `|espn_default_score(nflverse_components) − kona_appliedTotal|` per K/DST into
  `pipeline_status.json`. It is a *report*: the two feeds are independent, and RM9 shows
  ESPN's own K decode is unresolved, so a disagreement is information, not a red gate.

### 3.4 What is NOT modeled, named exactly

Of the owner league's **65 non-zero keys [RM2]**, these **12** cannot be produced from
the data Rel19 harvests, and they contribute **exactly 0**:

| Key | Value | Why | Tight upper bound available? |
|---|---|---|---|
| `pass_cmp_40p` | 1.0 | per-play distance | no (bounding by `pass_cmp` is vacuous) |
| `pass_td_40p` / `pass_td_50p` | 2.0 / 4.0 | per-play distance | **yes** — ≤ `pass_td` |
| `rush_40p` | 1.0 | per-play distance | no |
| `rush_td_40p` / `rush_td_50p` | 2.0 / 4.0 | per-play distance | **yes** — ≤ `rush_td` |
| `rec_td_40p` / `rec_td_50p` | 2.0 / 4.0 | per-play distance | **yes** — ≤ `rec_td` |
| `bonus_pass_yd_400` | 5.0 | per-game threshold | **yes** — ≤ games |
| `bonus_rush_yd_200` / `bonus_rec_yd_200` | 5.0 | per-game threshold | **yes** — ≤ games |
| `pass_int_td` | −4.0 | pick-six thrown; needs play-by-play | **yes** — ≤ `pass_int` |
| `def_4_and_stop` | 1.0 | needs play-by-play **[F]** §4.2 | no |
| `st_ff` / `st_fum_rec` | 1.0 | special-teams player events | no |

**Honesty rule, and it is stronger than either input document proposed.** An unmodeled
key contributes 0 to the point estimate — never an invented rate — **and** where a *tight,
derivable* upper bound exists the Scoring page and the player card show the exposure as a
range: `+0 to +38 pts not modeled`. Where no tight bound exists, the page says
**"no bound"** rather than printing a loose one that would read as a measurement.
Magnitude for calibration: at league-average rates the offensive bonuses are worth roughly
10–25 points a season to a QB against a `pass_cmp` delta of ~160 **[A]** §5.5 — material
enough to disclose, nowhere near enough to justify guessing.

`bonus_pass_yd_400` / `bonus_rush_yd_200` / `bonus_rec_yd_200` and the `*_40p` long-play
counts are the *only* ones a future release can close cheaply: `stats_player_week` carries
`passing_40` / `rushing_40` / `receiving_40` and per-game yardage **[F]** §3.3. That is a
Rel20 item and is out of scope here. Decoding ESPN's unlabelled bucket statIds is
**forbidden** until a decode is *proved* by reconciling against a league whose scoring
prices the bonus — RM9 is the demonstration of why.

---

## 4. Q4 — Reconciliation: the identity, and the gate

### 4.1 The identity

```
proj_points  = baseline × Π_s applied(s)          applied(s) = 1 + w_s(adj_s − 1)
comp_i       = prior_i  × Π_s applied(s)          ← the SAME scalar, every category

score_T(comp) = Σ_i T_i · prior_i · Π applied = score_T(prior) × Π applied

with T = ESPN-PPR:
  score_PPR(comp) = score_PPR(prior) × Π applied
                  = appliedTotal      × Π applied     [RM5: exact, 300/300 × 3 seasons]
                  = baseline          × Π applied
                  = proj_points                       EXACT, BY CONSTRUCTION
```

At today's weights (all zero, `signals_used: []` on every row) `Π applied = 1`, so the
components are literally the prior-season actuals and the only residual is 2-dp rounding.
The identity survives non-zero weights unchanged, which is why FEASIBILITY's advice to
"build the test now, while the identity is simple" is right — but its inference that
reconciliation gets *harder* later is wrong. It gets harder to *verify by eye*; the
identity itself is weight-invariant.

### 4.2 What this honestly is

D2 asks for "REAL per-player COMPONENT PROJECTIONS". What §4.1 delivers is a **faithful
decomposition** of the projection the app already ships. It carries **exactly as much
predictive information as `proj_points` does — not one bit more.** What it adds is the
ability to *re-score*, which is precisely what D2's stated purpose requires and which a
single total can never provide.

Anything better — per-category aging curves, TD-rate regression, a completion model that
is not last year's completions — is a **model change**, and model changes go through
`scripts/promote_signals.py` at weight 0 behind the never-regress gate. Letting one ride
in on a scoring feature would smuggle an unvalidated model past the only mechanism this
repo has for keeping models honest. The Scoring page must label components
`basis: 2025 actuals, rescaled` so nobody mistakes them for a per-category forecast.

### 4.3 The gate — five tests

Added as `tests/feature/components_reconcile.test.mjs` (node, imports the pure scorer,
reads the committed JSON) plus one check in `scripts/validate_data.py`. Any failure is
**red**; red never deploys.

| # | Test | Fails when | Threshold |
|---|---|---|---|
| **R1** | For every player in `player_components.json`, `\|score_PPR(comp) − proj_points\| ≤ 0.011` | a statId is dropped, mis-mapped, or changes meaning | **0.011 pts, 300 of 300.** No percentage carve-out, no per-player escape hatch |
| **R2** | `gsis_id` sets of `player_projections.json` and `player_components.json` are equal | partial coverage — which would let a mixed PPR/custom board ship and mis-rank | exact set equality |
| **R3** | **Default-PPR bypass:** with `profile == null`, every rendered number on Players / Team / Lineup / Auction equals the pre-Rel19 value | the recompute path leaks into the default path | byte-identical strings. **Documented exception: Compare — see §7.3** |
| **R4** | Every non-zero key of a loaded profile is in `modeled ∪ unmodeled`, and the two sets are disjoint | a Sleeper key is silently neither scored nor declared | exact |
| **R5** | Sanity bounds on unmodeled-key upper bounds: `pass_td_40p ≤ pass_td`, `bonus_pass_yd_400 ≤ games`, etc. (§3.4) | a bound is computed from the wrong field and reads as a measurement | exact |

**R1's threshold is set by measurement, not by taste.** RM5 measured residual **0.0** on
900 player-seasons; 0.011 is pure 2-dp rounding slack (0.005 + 0.005 + float). This
**explicitly rejects** FEASIBILITY §5.3's `> 0.5 per player / mean ≤ 0.10 / ≥ 95% within
0.01` — those were calibrated against a *cross-feed* comparison (nflverse components vs
ESPN totals) that this design does not perform. Inside one feed, "95% match" is not a
tolerance, it is a bug.

**R2 is what makes dormancy tractable** (§6): a partial file cannot pass, so the runtime
only ever sees "absent" or "complete". The app still degrades defensively on a missing
row, but that state is unreachable in shipped data.

**R3 is the single most important test in Rel19.** It converts "no number moves silently"
from a hope into a mechanical property. §4.4 is the rule that makes it pass.

### 4.4 The rule that makes silent drift structurally impossible

> **DEFAULT-PPR BYPASS.** When no league profile is connected — or when the connected
> profile's effective table is byte-equal to the ESPN-PPR default — every surface reads
> `proj_points` and calls `scoringAdjust()`, exactly as today. `player_components.json`
> is not consulted at all, and `bestLineup` / `replacementLevel` / `fitScore` run their
> current arithmetic on their current constants.

Components are a **branch**, not a replacement. The recompute path can only be entered by
a manager who has connected a league and can see on screen that they did. The primary
defence is not "reconcile within tolerance" — it is **the default path never executes new
code.** Reconciliation is the safety net behind it.

Note the ESPN-PPR default table must record **`pass_td: 4.0`**, not 6.0 — **[F]** H6 is
correct and this is easy to get wrong. The app's "PPR" is ESPN-PPR.

---

## 5. Q2 — Kicker and team defense: the position

### 5.1 Position

> **Rel19 ships K and D/ST as a real pipeline expansion. The honest 9-slot lineup lands
> FIRST and INDEPENDENTLY, so that a slip in the projection work degrades into a visibly
> unsupported slot — never into a silent 7-slot lineup presented as optimal.**

Two deliverables in a deliberate order:

**F1 — CONTRACT (non-negotiable, no data dependency).** With a profile connected, the
lineup, roster builder, draft room and auction render **all nine** of this league's
starting slots. A slot whose position has no projection renders explicitly:

```
K     — awaiting K/DST feed —      [ why? ]
DEF   — awaiting K/DST feed —      [ why? ]
```

and the card total carries `7 of 9 slots projected`. `bestLineup` returns those slots
present-but-unfilled with a warning, reusing the existing `warnings: [{slot, id, reason}]`
channel Rel17 built for forced starts (`app/lineup.js:93-106`) — the banner mechanism, the
CSS, and the "suppress the *already optimal* line because it would be a lie" logic all
exist in `app/views/lineup.js:133-206`. A new `reason: 'unsupported_slot'` must be
distinguishable from Rel17's `'no_available_alternative'`, and a test must assert it.

**F2 — PROJECTION (measured feasible).** §3.3. K/DST are genuinely valuable in this
league — FEASIBILITY computed Myers at **196.0** and Fairbairn at **191.0** under the
owner's exact rules, which is **WR6–WR12 territory** in the same league **[F]** §4.1. A
starting slot that valuable cannot be left unmodelled.

**If F2 slips, F1 still ships.** That is the entire point of the ordering: the failure
mode is a visibly unsupported slot, never a silently short lineup. This is why
ARCHITECTURE's ordering is retained even though FEASIBILITY's measurements make F2 look
safe.

### 5.2 Why K components come from nflverse, not from the feed we already have

**[R-MEASURED RM9].** I decoded ESPN's kicker statIds from the data:
`74/77/80` = FGM from 50+ / 40-49 / 0-39, `85` = FG missed, `86` = XPM, scored
`5 / 4 / 3 / −1 / +1`. Jason Myers → **195.0 = appliedTotal exactly**. Ka'imi Fairbairn →
**190.0 = appliedTotal exactly**. Two exact hits is seductive. Across all 42 kickers it
reconciles **33/42**, the rest short by 1.0–3.6 — an undiscovered 60+ bucket plus
offensive statIds on kickers who ran the ball.

That is the shape of a decode that is *nearly* right, which is the most dangerous kind.
nflverse's `fg_made_0_19 … fg_made_60_` are **named columns** covering all six of the
owner league's FG buckets exactly. Use them. This also generalises: ESPN's 0–39 aggregate
happens to be exact for *this* league (all three sub-buckets price at 3.0), but D1 promises
any Sleeper league, and the next league will price them apart.

### 5.3 D/ST completeness, stated per key

D/ST scoring under the owner's table is **complete except three keys**: `def_4_and_stop`
(needs play-by-play), `st_ff`, `st_fum_rec` (§3.4). The `pts_allow_*` and `yds_allow_*`
tiers — **16 of the ~30 non-zero DEF keys, and the bulk of a defense's score** — are
**fully modeled** from weekly data. ARCHITECTURE §6.2's claim that they "hit the same
season-total wall" is **REJECTED**: it is true of a season total and false of the weekly
feed this design uses.

Consequence, accepted explicitly: a D/ST total is slightly less complete than a WR's.
D/ST cards therefore carry a `PARTIAL SCORING` chip naming the three keys. Unlike
ARCHITECTURE §6.3, D/ST **is** included in cross-position VOR — because with the tiers
modeled the incompleteness is a few points out of ~200, and excluding the position from
the ranking a manager must actually draft from would be a larger distortion than the
disclosure it avoids.

### 5.4 K/DST get their own contract — the F-NEW-1 fix

**Both input documents put K/DST into `player_projections.json`. Rejected.**

`build_predictions.py:344` writes `projected[:300]` sorted by points. The 300th player is
**Noah Gray at 38.8** **[RM10]**; every kicker and nearly every defense outscores him, so
merging would evict ~74 offensive players from the pool that feeds Players, the draft
board, VOR, the auction and the Fit engine.

New contracts, both 404-graceful in the `epa_history` / `ai_insights` tradition:

```
data/player_components.json     offense components   (ESPN, NOT dormant)
data/kdst_projections.json      K + DST projections  (nflverse, DORMANT)
data/kdst_components.json       K + DST components   (nflverse, DORMANT)
```

Held in separate files, this **eliminates four named risks at once**:

- `player_projections.schema.json`'s `position` enum stays `["QB","RB","WR","TE"]` →
  ARCHITECTURE's K8 ("widening the enum breaks a downstream consumer": `parlay_builder`,
  `build_history`, `ai_estimates`, `ros`) does not arise.
- `player_weekly.json`'s index-mirror invariant (`build_weekly.py:50-51`, locked by
  `weekly_contract.test.mjs` — *"players EXACTLY mirror player_projections.json (same ids,
  same order)"*) is untouched.
- `real_data.test.mjs`'s *"projections are sorted best-first"* and *">= 150 players"* are
  untouched.
- R3's byte-identical default path becomes trivially true for the whole existing pool.

K/DST appear on a surface **only** when a connected profile's shape declares a `K` or
`DEF` slot. With no profile, the files are never fetched.

---

## 6. Q5 — Dormancy: exactly what the app does, state by state

Because offense components come from the feed that already runs, and K/DST from a runner,
dormancy is **two-dimensional**, not one. Five states; one is unreachable in shipped data.

| State | Trigger | Behaviour |
|---|---|---|
| **D0 — no profile** | nothing connected | Today's app, **byte-identical**. PPR/HALF/STD segment live. Neither new file is fetched. Locked by R3 |
| **D1 — profile, no offense components** | `player_components.json` 404s (deploy predating the next pipeline run) | **Shape applies immediately** — 9 slots, 10-team replacement level, lineup geometry, roster caps. **Scoring does not.** Every player surface keeps PPR numbers behind a persistent, non-dismissable header banner: *"Omilia-US scoring is connected but per-player components have not been built yet — the points below are ESPN-PPR."* Plus a per-card `PPR` chip so a screenshot cannot be mistaken for a custom board. **No blending, no scaling, no ratio approximation** — §7.1 measures the error at +145.6 mean for QBs, which is exactly the fabrication the honesty rule forbids |
| **D2 — profile + offense, no K/DST** | `kdst_projections.json` absent (expected on day one) | Full custom recompute for QB/RB/WR/TE. K and DEF slots render `— awaiting K/DST feed —` with a `[why?]` link. Lineup shows **nine** slots, two unfilled, one warning each. Card total reads `7 of 9 slots projected` |
| **D3 — everything present** | all three files | All nine slots projected. `PARTIAL SCORING` chips on DEF (§5.3) and on any position with non-zero unmodeled keys (§3.4) |
| **D4 — components present, a player row missing** | gate-unreachable (R2) | Defensive: that row shows PPR + a chip, and the list header counts it. Never silently ranked as if custom |

**The split of shape from scoring in D1 is the best property of this design and it is
worth protecting.** Shape derives from `roster_positions` and `total_rosters` — data the
browser holds the instant the fetch returns. It needs no pipeline run at all. So on the
day Rel19 ships, before any cron fires, a 10-team manager already gets a 9-slot lineup and
a 10-team replacement level. The scoring half lights up when the pipeline catches up. Two
independently valuable halves, each honest standing alone.

**Builder rule.** `build_kdst.py` must emit `{"players": []}` plus a `degraded` row in
`pipeline_status.json` rather than a partial file — matching `epa_history` /
`injury_history`, and matching `validate_data.py`'s `OPTIONAL_DATA` set
(`validate_data.py:93-98`), to which the two new K/DST files must be added. **An empty
file is honest; a half file is a lie that passes `fetch`.** `player_components.json` is
NOT optional: it is built by the same run that writes `player_projections.json`, so its
absence after that run is a real failure and must red the gate.

---

## 7. Q3 — League shape, and how it actually reaches VOR / auction / lineup

### 7.1 Why shape and scoring must ship together

Scoring alone would be actively harmful. Under the owner's table QB totals rise ~60%
(**[F]** §6.1: mean **+145.6**, max +286.0; the raw-points top 12 becomes *entirely*
quarterbacks). But the draft board is VOR, not points, and replacement level rises with
them — **[A]** §0.2 measured replacement QB moving **241.6 → 495.4**, which turns a
raw-points revolution into a **five-slot shift** (best QB from ~14th to 9th). Shipping
scoring against a 12-team, 7-starter replacement level would produce confidently wrong
VOR and would tell a 10-team manager to draft as if QBs were top-3 picks. Both input
documents reach this conclusion independently; it is upheld.

### 7.2 One object: `LeagueProfile`

New pure module `app/league-profile.js`. No DOM, no storage, no fetch beyond one exported
`fetchSleeperLeague()` — the same discipline as `team-logic.js`, so it unit-tests under
bare node.

```js
{
  v: 1,
  source: 'sleeper' | 'paste' | 'manual' | 'default',
  league_id: '1393691504228184064' | null,
  name: 'Omilia-US' | null,
  season: 2026,
  fetched_utc: '2026-08-13T19:41:32Z' | null,

  shape: {
    teams: 10,
    roster_positions: ['QB','RB','RB','WR','WR','TE','FLEX','K','DEF','BN','BN','BN','BN'],
    starters:  ['QB1','RB1','RB2','WR1','WR2','TE1','FLEX','K1','DEF1'],
    bench:     ['BN1','BN2','BN3','BN4'],
    starterDemand: { QB:1, RB:2, WR:2, TE:1, K:1, DEF:1 },
    flex: { FLEX: ['RB','WR','TE'] },
    positionCaps: { QB:2, RB:5, WR:5, TE:3, K:2, DEF:2 },   // Sleeper position_limit_*
    draftRounds: 3,          // settings.draft_rounds — NOT rosterSize
    maxKeepers: 1,
    reserveSlots: 1,         // IR — excluded from `size`
    size: 13,
    unsupported: []          // positions with slots but no projection
  },

  scoring: { pass_yd:0.04, pass_cmp:0.5, pass_td:6.0, /* all 147, zeros included */ },
  edits:   { pass_td: 6.5 },                    // overlay, never merged into `scoring`
  modeled:   [...], unmodeled: [...]            // computed, never authored
}
```

Four details carry weight:

- **`edits` is an overlay.** Effective table = `{...scoring, ...edits}`. Makes "reset to
  league" a one-line delete, makes "3 values differ from Omilia-US" displayable, and means
  a re-fetch refreshes the league without destroying the manager's work. FEASIBILITY §10's
  provenance requirement, satisfied structurally.
- **All 147 keys are stored, zeros included** (**[F]** §2.1: ~83 are zero). Storing only
  non-zero keys makes hand-editing lossy.
- **`modeled` / `unmodeled` are computed** from the harvest map (§3.2, §3.3), not authored.
  This is the honesty channel behind R4.
- **`draftRounds` is not `size`.** **[F]** §2 caught this: `draft_rounds: 3` with
  `max_keepers: 1` means this is a keeper draft. Hard-coding `rounds = rosterSize` in the
  draft room from a league id would be wrong for the owner's own league.

**Sleeper token → slot normalization** (a pure fold, repeats numbered in encounter order,
matching `rosterShape()`'s existing `FLEX` vs `FLEX1/FLEX2` convention):
`QB/RB/WR/TE/K` → own position · `DEF` → team defense · `FLEX` → RB,WR,TE ·
`REC_FLEX` → WR,TE · `WRRB_FLEX` → WR,RB · `SUPER_FLEX` → QB,RB,WR,TE ·
`IDP_FLEX/DL/LB/DB` → **`unsupported`** (surfaced, never silently dropped) ·
`BN` → bench · `IR`/`TAXI` → excluded from `size`.
The 17 IDP scoring keys are all zero in this league **[F]** §2.1 and need no scorer, but
they must still round-trip through the editor.

### 7.3 Threading shape through the engines — and the defect it exposes

**[R-MEASURED RM12].** The two engines already disagree about what replacement level *is*:

```js
// app/team-logic.js:781  replacementLevel()      — PER-ROSTER
const row = ranked[demand + extra];                       // QB demand 1 -> 2nd-best QB overall

// app/auction.js:107-108  fairDollars()          — LEAGUE-WIDE
const idx = Math.max(0, Math.round(demand * leagueSize) - 1);   // QB -> the 10th/12th
```

`team-logic` computes replacement as if the league had **one team**, which is why *team
count has no effect on VOR today* and why "this is a 10-team league" is currently a
cosmetic fact. They also disagree about FLEX: `team-logic` gives winner-takes-all `+1` to
the position with the best available player (`flexAbsorbPos`), `auction` spreads it
`{RB:.45, WR:.45, TE:.10}`. Rel19 cannot deliver Q3 without addressing this.

**Resolution — a shape-gated trailing optional argument, not a rewrite:**

```js
export function replacementLevel(pool, weeklyById, mode, position, shape /* optional */) {
  if (!shape) return /* today's exact code, byte for byte */;
  const demand = shape.starterDemand[pos] + flexShareFor(pos, shape);
  return rankedAtPos(pool, ...)[Math.max(0, Math.round(demand * shape.teams) - 1)] ?? 0;
}
```

- **No profile ⇒ `shape` undefined ⇒ today's arithmetic, untouched.** All 13 assertions in
  `team_vor.test.mjs` run on the literal current path.
- **Profile connected ⇒ league-wide replacement**, and `teams` finally means something.
- **Under a profile, both engines use the SAME definition and the SAME fractional flex
  share** derived from `shape.flex` eligibility — which closes the divergence for profile
  users while leaving the default path alone. A new test must assert the two agree.

This is defensible, not merely test-preserving: with no league connected the app genuinely
does not know the team count, and the per-roster definition is the honest degenerate case.
It is also the *weaker* definition, and this document says so plainly — **migrating the
default is a follow-up release that must publish its own before/after diff, not a side
effect of a scoring feature.**

The same optional-`shape` signature extends to `neediestOpenSlot`, `recommend`,
`recommendV2`, `bestPickNow`, `vorScore`, `slotEligible` and `fitScore` (whose
`resolveStarters` iterates `STARTER_SLOTS`), and to `bestLineup(players, shape)`. In every
case: **argument absent ⇒ frozen constants ⇒ current behaviour.**

`bestLineup`'s greedy dedicated-then-flex proof stays valid **only** if flex slots are
filled after dedicated ones and **in increasing order of eligibility breadth**
(`RFLEX`/`WRFLEX` before `FLEX` before `SFLEX`). That ordering rule must be written into
the module docstring — it is the only thing keeping the proof true once heterogeneous flex
slots exist.

`app/auction.js` needs three things: (a) accept the profile's shape where
`rosterShape(rosterConfig)` is called, (b) extend `teamNeedsPos`'s hard-coded `caps` map
(`auction.js:161-166`) for K/DEF, (c) key `flexShare` off `shape.flex` so a `SUPER_FLEX`
league does not silently spread flex demand over RB/WR/TE only. `MARKET_DECAY 0.028` is
*"fitted to the classic 12-team/$200 AAV curve"* — it stays, with a stated caveat on the
auction surface for non-12-team leagues **[F]** §6.2. **`marketDollars` must NOT change:**
it is ADP-derived, ADP is the market's PPR consensus, and re-scoring it would be inventing
data. The resulting BAIT/TARGET classification (our custom dollars vs the PPR market's) is
then *more* useful, not less — it is exactly where a QB-premium league creates arbitrage.

`app/ros.js` needs **no signature change** — **[R-MEASURED RM13]** `rankByRos` already
reads `opts.cutoffs || STARTER_CUTOFFS` (`ros.js:112`). The caller passes
`teams × starterDemand` when a profile is connected. FEASIBILITY's "❌ hardcoded 12" is
corrected: the constant is a default, not a wall.

**Draft-sim opponents keep drafting by ADP.** The ADP room *is* the benchmark; a room that
magically knew the custom scoring would flatter our engine. Our picks use custom VOR; the
asymmetry is the edge.

### 7.4 The fit-engine constants — a real behaviour change hiding in a scoring feature

`STACK_BONUS 12`, `BYE_COVER_BONUS 6`, `BYE_CLASH_PENALTY 10`, `FLOOR_BONUS 8`,
`MATCHUP_BONUS_CAP 8` (`team-logic.js:47-52`) are denominated in **points**, tuned against
a PPR pool topping out at 416.6 **[RM10]**. Under Omilia the top player scores **636** and
QBs cluster 400–640. A flat +12 stack bonus is a materially smaller nudge in that pool, so
**the fit engine's recommendations change character under custom scoring even though no
constant changed.** ARCHITECTURE caught this (its R3/K3); FEASIBILITY did not.

**Adopted:** normalize each bonus by a pool-scale factor
`poolScale = mean(top-N adjusted) / mean(top-N ESPN-PPR)`, computed once per render, and
**short-circuited to exactly 1.0 when no profile is connected** — so the default path
multiplies by a literal 1, not by a computed value that happens to round to 1. That is
what keeps `team_logic.test.mjs`'s *"v1 fitScore is byte-for-byte frozen on the fixed
fixture"* green without touching the fixture. Rejected: leaving them fixed and documenting
the drift — that is a silent behaviour change inside a feature whose entire promise is
that nothing changes silently.

### 7.5 Compare — the pre-existing defect, fixed with an explicit R3 carve-out

**[R-MEASURED RM14]** `app/views/compare.js:100` reads `Number(p.proj_points)` raw.
Compare does not honour even **today's** PPR/HALF/STD toggle. D3 requires Compare to
recalculate, so the bug must be fixed.

**This breaks strict R3 for half/std users with no profile connected** — their Compare
numbers will change. That is a *correction*, but it is still a change, and R3 exists to
stop exactly this kind of thing riding in unannounced. So: **fix it, carve it out of R3
explicitly, give it its own test and its own line in the release notes.** Silently
allowing it, or silently excluding Compare from D3, are both worse.

---

## 8. Q8 — Storage, sharing, cross-device

**Storage.** One new versioned key alongside the existing family
(`nfl2026.{scoring,team,ai,taken,mocklocks,unlock}.v1`):

```
nfl2026.league.v1  ->  the LeagueProfile of §7.2 (JSON)
```

**[A]** M11 measured 2 698 B minified — trivial against a 5 MB quota. `app/league-store.js`
owns `localStorage` with the same try/catch-and-degrade pattern the existing loaders use:
storage blocked (private mode) yields a **session-only** profile, never a thrown error.

**`nfl2026.scoring.v1` (`'ppr'|'half'|'std'`) stays exactly as it is** — not migrated, not
rewritten, not deleted. Precedence is explicit and *visible*:

> A connected league profile supersedes the PPR/HALF/STD segment. While one is connected
> the segment renders **disabled** with the label `SCORING · OMILIA-US` and a link to the
> Scoring page. Disconnecting restores the segment and the previously stored mode.

Two controls silently fighting over the same number is the failure mode; one visibly
winning is the fix.

**Sharing.** No login exists and none may be added, so nothing syncs — and the UI must say
so rather than letting a manager discover it.

- **Primary — the league-id link.** `#/scoring?league=1393691504228184064` opens the page
  and re-fetches. The league id **is** the share token; it is a public identifier, which is
  precisely the standing rule's carve-out. Forty characters, survives any messenger, and
  can never carry a stale copy of a league whose commissioner changed a setting.
- **Secondary — the profile blob**, for hand-edited or non-Sleeper profiles that have no
  league id to point at. `#/scoring?p=<base64url>`. **[A]** M11: 3 600 B raw, or **1 064 B**
  through `CompressionStream('deflate-raw')` — a platform API, no library, no build step,
  which is why it is permissible here. Encoder falls back to raw base64url when
  `CompressionStream` is absent; decoder sniffs which it got. A 3.6 KB URL is legal
  everywhere; ugly beats broken.
- **Import lands in a REVIEW state the user confirms** — never a silent overwrite of an
  existing profile. (FEASIBILITY §10; adopted over ARCHITECTURE's silent apply.)
- **Copy / Paste profile JSON** on the page — the same textarea as the §2.3 Tier-2 fallback.

**Stamping (mandatory, ~6 lines, and the difference between an interpretable draft record
and one that quietly rots).** `nfl2026.mocklocks.v1` archives completed mocks for later
grading. A lock made under Omilia scoring and graded under PPR is a meaningless
comparison. **Every new lock stamps `{league_id, profile_hash, teams, roster_positions}`;
an unstamped lock is a pre-Rel19 PPR lock and is graded as such.** Same stamp on
`nfl2026.team.v1` so the Team tab can warn when a roster was built for a different shape
than the one now connected.

**Privacy.** A league id fetches unauthenticated, so a share link leaks nothing that is not
already public. It still must not go into analytics or any committed file.

**Unresolved, and deliberately not guessed** — **[F]** §2.2: Sleeper's DEF/ST key semantics
overlap (`fum_rec 2.0` vs `def_st_fum_rec 4.0`; `ff` vs `def_st_ff` vs `st_ff`). Which key
fires on which real-world event is not documented in the payload. `st_ff` and `st_fum_rec`
are in the **unmodeled** set (§3.4) precisely so this ambiguity produces a disclosed zero
rather than a confident wrong number. Confirm with the owner before any future release
moves them out.

---

## 9. Q6 — Backward compatibility

### 9.1 Correcting the gate definition

**[R-MEASURED RM11].** The gate is `bash tests/run_gate.sh`, which runs, gating on exit
codes:

```
1. python3 scripts/validate_data.py
2. bash tests/smoke.sh
3. node --test tests/feature/*.mjs          # 277 tests
4. npx playwright test --config tests/playwright.config.mjs   # web 74 + pwa 8
```

There is **no `tests/competition.test.mjs`, no `tests/ux/`, no `tests/integrated/`** in
this repo. ARCHITECTURE §10.2's row naming those directories is void. Baseline to preserve:
**277 unit, 82 E2E `test()` declarations**.

### 9.2 The compatibility contract

| Existing thing | Rel19 treatment |
|---|---|
| `scoringAdjust(ppr, rec, mode)` | **signature and body unchanged.** Becomes the D0/D1 path |
| `weeklyPoints(entry, seasonAdj, seasonPpr)` | **unchanged.** Already ratio-based and scoring-agnostic by construction — a custom season total flows through with no formula change |
| `nfl2026.scoring.v1` | **unchanged.** Superseded-and-visibly-disabled while a profile is connected (§8) |
| `STARTER_SLOTS` / `BENCH_SLOTS` / `SLOT_ORDER` / `STARTER_DEMAND` / `LINEUP_SLOTS` / `MODELED` / `POSITION_CAPS` / `STARTER_CUTOFFS` | **stay exported with today's values**, re-exported as `DEFAULT_SHAPE`. Shape-taking overloads default to them |
| `replacementLevel` / `vorScore` / `bestPickNow` / `recommend` / `recommendV2` / `fitScore` / `bestLineup` / `slotEligible` | gain a **trailing optional** `shape` / `profile`. Omitted ⇒ today's arithmetic |
| `rosterShape()` / `ROSTER_BOUNDS` (draft-sim) | extended with `k` / `def` bounds defaulting to **0**, so `DEFAULT_ROSTER` still yields the classic 13-slot shape. Assert that explicitly |
| `data/player_projections.json`, `data/player_weekly.json`, their schemas | **completely untouched** — §5.4 |

### 9.3 Tests at risk — named, with the mechanism and the mitigation

Counts are `grep -c 'test('` **[R-MEASURED]**; ARCHITECTURE's figures for three of these
were wrong (it reported 26/6/11 for files that hold 21/5/9).

| File | tests | Risk | Mitigation |
|---|---|---|---|
| `tests/feature/team_vor.test.mjs` | **13** | Highest. `STARTER_DEMAND contract: QB 1, RB 2, WR 2, TE 1`; `replacementLevel: (demand+1)th best; FLEX adds +1…`; 8 `bestPickNow` tests incl. determinism | optional-`shape` switch (§7.3); with no shape these run on the literal current path. **Add** 10-team/9-starter cases, never edit existing ones |
| `tests/feature/team_logic.test.mjs` | **18** | `scoringAdjust: ppr 300 / 100 rec -> half 250, std 200 (exact)`; `slotEligible truth table`; **`v1 fitScore is byte-for-byte frozen on the fixed fixture`** (the strictest in the repo); `fitScoreV2 OFF path … byte-identical to v1`; `recommend respects the scoring mode` | `scoringAdjust` untouched; `slotEligible` shape-defaulted; **fitScore constants are the live risk — §7.4's `poolScale` short-circuits to literal 1.0 on the default path** |
| `tests/feature/team_rel2.test.mjs` | **11** | `POSITION_CAPS` contract incl. `DEF/DST/K at 1`; "recommend excludes a 3rd QB" | K/DEF become draftable only under a profile, and the profile supplies `positionCaps` from `position_limit_*`. These tests **strengthen** (add the profile case), never change |
| `tests/feature/auction.test.mjs` | **18** | `marketDollars` absorbs exactly the room budget; `fairDollars` floors at $1; `planBudget` sums exactly; full simulated auction never overdraws | budget conservation is scoring-independent; `shape.size` is 13 for this league too. **Add** a 9-starter/10-team case |
| `tests/feature/draft_sim.test.mjs` | **15** | `rosterShape` defaults reproduce the classic 13-slot shape; bounds clamping; snake order | new `k`/`def` keys default to 0 ⇒ classic shape preserved. Assert it |
| `tests/feature/lineup.test.mjs` | **5** | `bestLineup fills dedicated slots then the best leftover FLEX`; `lineup optimizer self-check passes` (`__selftest()`); byes sink to bench | `shape` defaults to `LINEUP_SLOTS`; `__selftest()` must keep passing **untouched** |
| `tests/feature/availability_app.test.mjs` | **21** | Rel17 `playable:false` demotion and forced-start warnings | the availability tuple must survive the shape refactor **and extend to K/DEF slots**. §5.1 reuses Rel17's warning channel — **add a case proving `'unsupported_slot'` and `'no_available_alternative'` stay distinguishable** |
| `tests/feature/ros.test.mjs` | **9** | `zero-weight SoS/availability reproduces the raw sum EXACTLY (never-regress default)` | the **template for R3** — an existing, passing "default path is byte-identical" test to imitate. `ros.js` itself needs no change (RM13) |
| `tests/feature/weekly_contract.test.mjs` | **6** | `players EXACTLY mirror player_projections.json (same ids, same order)`; bye rows; sums | **untouched** by §5.4's separate-file decision. This is the strongest single argument for it |
| `tests/feature/real_data.test.mjs` | **6** | pool ≥150; sorted best-first; day-zero honesty (`signals_used` empty) | **untouched** by §5.4 |
| `tests/feature/contrast_aa.test.mjs` | **13** | WCAG AA on every token pair | the Scoring page's dense table introduces new token pairs — extend, do not relax |
| `tests/web/web.spec.mjs` | **74** | tab bar, route list, Players/Team/Lineup DOM | a **7th tab** and a 7th route change nav assertions; the Lineup card gains two rows under a profile |
| `scripts/validate_data.py` | — | `SCHEMA_FOR_DATA` map, `OPTIONAL_DATA` set, `additionalProperties: false` | three new schemas; the two K/DST files join `OPTIONAL_DATA`; `player_components.json` does **not** |

---

## 10. Q7 — The self-learning boundary, stated without euphemism

### 10.1 What custom scoring does NOT touch

**The promotion gate is a game-outcome model.** `scripts/promote_signals.py` grades
win-probability predictions by **log-loss against final scores**. Its unit of truth is
"did the home team win". Nothing in that loop reads a fantasy point. Therefore, and this
belongs on the Model tab in these words:

- Custom scoring does **not** retrain the Elo gate.
- It does **not** change a signal weight in `data/meta.json` — all 32 registry signals
  remain at 0.
- It does **not** alter `proj_points`, `player_weekly.json`, `game_predictions`,
  `playoff_odds`, `team_strength`, `model_tuning`, or any snapshot the harness resolves.
- It does **not** make projections more accurate. It makes them **correctly denominated.**

Rel19 is a **presentation-and-valuation transform over an unchanged model.** A per-user
setting must never write to the signal registry or contaminate a shared, measured model.
Any Scoring-page copy implying "the model now knows your league" would be false.

### 10.2 What it legitimately does affect

Which players the fit engine recommends (VOR, best-pick-now, auction dollars, ADP value
flags, lineup, Compare) — and the mock-draft record, which is why §8's profile stamp is
mandatory: ungraded locks made under different scoring are not comparable, and an
unstamped lock silently pretends they are.

### 10.3 What a genuine player-level learning loop would require

`docs/roadmap/rel18/BACKTEST_DESIGN.md` §5 already sized the first half: player-level
backtesting is currently **zero**; `stats_player_week_{season}.csv` is HTTP 200 with ~150
columns carrying `fantasy_points_ppr`; a minimal `pid → {pos, week → ppr}` artifact is
**0.10 MB/season** (0.52 MB with position/team/opponent). That artifact is the unlock for
grading projections at all.

**It is not sufficient for grading a *custom-scored* projection.** Grading "was Stafford's
636 right under Omilia scoring?" requires re-scoring the **actuals** under the same table,
which requires **weekly actual components**, not a weekly PPR total. Extending Rel18's
artifact from 1 numeric column to the ~16 of §3.2 puts it on the order of
**1.0–1.5 MB/season** — an estimate by column-count scaling from Rel18's measured figure,
**not a measurement**, and it must be measured before anyone commits to it.

The loop would then be:

```
weekly actual components ──┐
                           ├─► score under the SAME stamped profile ──► graded error
custom-scored projection ──┘        (MAE / calibration, per position)
                                              │
                                              ▼
                                   per-component signal weights,
                                   promoted at weight 0 through a
                                   SEPARATE never-regress gate
```

Four properties to state now so Rel19 does not foreclose them:

1. **Components make error decomposable.** Today a miss is one number; with components a
   QB miss splits into "right about volume, wrong about TD rate" — which is what a
   per-category signal would need to earn weight against.
2. **The grader must score under the profile the projection was made with** — §8's
   stamping discipline, applied to the pipeline instead of `localStorage`.
3. **It needs its own baseline and its own gate.** An improvement in fantasy-point
   accuracy is not evidence about win probability; sharing the game gate's baseline would
   be a category error.
4. **Fit against one canonical profile** (ESPN-PPR) and treat others as display, rather
   than carrying per-profile weights. Far simpler, and the honest first cut.

Rel19 does none of this. It builds the artifact shape that makes it possible, and it
claims no learning benefit.

---

## 11. The new page

Route `#/scoring`, seventh tab, mounted with the same lazy-import-with-degrade pattern as
`team` / `model` / `lineup` / `compare` in `main.js:20-71`.

```
SCORING & LEAGUE                                        [ ESTIMATE ]

  ┌ CONNECT ─────────────────────────────────────────────┐
  │  Sleeper league ID   [ 1393691504228184064 ]  FETCH   │
  │  or  ▸ paste league JSON     ▸ start from PPR default │
  └───────────────────────────────────────────────────────┘

  CONNECTED · Omilia-US · 10 teams · fetched 13 Aug 19:41    [ disconnect ]

  ROSTER SHAPE     QB RB RB WR WR TE FLEX K DEF · BN×4 · IR×1
                   3-round keeper draft · caps QB2 RB5 WR5 TE3 K2 DEF2
                   ⚠ K and DEF: see coverage below

  SCORING  ·  65 of 147 keys non-zero  ·  3 edited
    PASSING   pass_yd  0.04    pass_cmp  0.50 *
              pass_td  6.00    pass_int -2.00
              pass_cmp_40p 1.00   ⃠ not modeled (per-play distance, no bound)
    RUSHING   …
    KICKING   fgm_50_59 5.00   fgm_60p 6.00
    DEFENSE   pts_allow_0 6.00                       ✓ modeled (per-game tier)
              def_4_and_stop 1.00 ⃠ not modeled (needs play-by-play)

  COVERAGE    QB RB WR TE  ✓ full · unmodeled exposure +0 to +38 pts
              K   ✓ full
              DEF ◐ partial — def_4_and_stop, st_ff, st_fum_rec not modeled
              12 non-zero keys contribute 0 — [ show them ]

  [ copy share link ]  [ copy profile JSON ]  [ reset to league ]
```

Rules the page must obey:

1. **Every one of the 147 keys is editable**, including those already at their league
   value (D1). Edited keys carry `*` and land in `edits`, never in `scoring`.
2. **Unmodeled keys are shown, greyed, with a reason** — never hidden. Hiding them lets a
   manager believe a total is complete when it is not.
3. **The coverage block is not chrome.** It is the honesty contract: per position, whether
   the numbers on every other tab are complete, and the bounded exposure where §3.4 has a
   tight bound.
4. **The dormant banner outranks everything.** In D1 the page still connects, still shows
   the table, still applies shape — and says at the top that points are ESPN-PPR.
5. Dark-only tokens, AA contrast (`contrast_aa.test.mjs` extends to the new pairs),
   13-inch iPad first. The scoring table is the densest surface in the app; at iPhone width
   it collapses to one column per category group with a sticky category sub-header.

---

## 12. Build plan — four agents, disjoint file ownership

Per CLAUDE.md, concurrency equals genuinely independent partitions. There are **four**
here, and they are **not all parallel**: P1 must land first because P2/P3/P4 all import its
pure scorer. Say so rather than pretending to four-way concurrency.

### P1 — SCORING CORE + CONTRACT  *(lands first; everything else imports it)*

```
OWNS (new):   app/league-profile.js
              app/league-store.js
              data/contracts/player_components.schema.json
              data/contracts/kdst_projections.schema.json
              data/contracts/kdst_components.schema.json
              tests/feature/league_profile.test.mjs
              tests/feature/components_reconcile.test.mjs
OWNS (edit):  app/data.js            (three 404-graceful getters, additive)
EXPORTS:      parseSleeperLeague, fetchSleeperLeague, normalizeShape,
              effectiveScoring, scoreComponents, classifyKeys,
              ESPN_PPR_DEFAULT, isDefaultPpr, unmodeledBounds
TOUCHES NO EXISTING ENGINE OR VIEW.
```

### P2 — COMPONENT PIPELINE  *(parallel with P3/P4 after P1)*

```
OWNS: scripts/scrape/espn_players.py     (harvest the §3.2 statId whitelist)
      scripts/build_components.py        (new — offense components, NOT dormant)
      scripts/build_kdst.py              (new — nflverse K/DST, DORMANT)
      scripts/build_predictions.py       (call sites + pipeline_status rows)
      scripts/validate_data.py           (SCHEMA_FOR_DATA + OPTIONAL_DATA)
      tests/smoke.sh                     (selftest hooks, matching build_epa_history)
      data/player_components.json, data/kdst_projections.json, data/kdst_components.json
MUST NOT TOUCH: player_projections.json / player_weekly.json / their schemas / build_weekly.py
```

### P3 — ENGINES + SURFACE RECOMPUTE  *(one owner; these five engines share the fit contract)*

```
OWNS: app/team-logic.js  app/lineup.js  app/auction.js  app/draft-sim.js
      app/views/players.js  app/views/team.js  app/views/lineup.js  app/views/compare.js
      tests/feature/{team_vor,team_logic,team_rel2,auction,draft_sim,lineup,availability_app}.test.mjs
      (ADD cases only — never edit an existing assertion)
DOES NOT TOUCH app/ros.js (RM13: already parameterised; P3 only passes opts.cutoffs).
```

The single routing function all surfaces call, replacing every scattered `scoringAdjust`
call site:

```js
// app/team-logic.js
export function adjustedPoints(player, ctx) {
  const { profile, componentsById, weeklyById, mode } = ctx;
  if (!profile || profile.isDefaultPpr) {                    // §4.4 BYPASS
    const e = lookup(weeklyById, player.gsis_id);
    return scoringAdjust(player.proj_points, e ? e.receptions_prior : 0, mode);
  }
  const comp = lookup(componentsById, player.gsis_id);
  if (!comp) return { pts: player.proj_points, fallback: 'no_components' };  // D4
  return scoreComponents(comp, effectiveScoring(profile));
}
```

`low`/`high` scale by `custom/ppr` via the existing `scoreRatio` mechanism
(`views/players.js:264-273`); the AI± ratio composes on top unchanged.

### P4 — SCORING PAGE + SHELL

```
OWNS: app/views/scoring.js  (new)
      app/main.js           (route + lazy mount, 7th tab)
      index.html            (tab button)
      app/theme.css         (scoring-table tokens)
      tests/web/web.spec.mjs, tests/feature/contrast_aa.test.mjs
```

**Merge order and degradation.** P1 first. P2/P3/P4 then land in any order:

- P3 before P2 → shape accepts K/DEF for a pool that does not contain them → the
  "awaiting K/DST feed" slot renders. Harmless.
- P2 before P3 → the K/DST files exist and nothing reads them. Harmless.
- P4 before P3 → the page connects and stores a profile; surfaces ignore it until P3.
  Harmless (this is exactly state D1).

Every order degrades safely, which is the property to want.

**Rollback.** Every piece is additive and the two new data families are 404-graceful.
`git revert` P2 → the app returns to D1. Revert P4 → the route disappears and the profile
becomes unreachable → D0. No migration, no data loss, no schema downgrade. The one-line
emergency stop is deleting `nfl2026.league.v1` from `localStorage`, which the Scoring
page's **disconnect** button already does.

---

## 13. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| **K1** | Browser-direct Sleeper fetch fails on the real domain (the one leg not proven) | **high** | §2.3 Tier 2 ships in the same release and is not optional; the profile caches in `localStorage` and works offline forever once obtained. §2.3's 30-second post-deploy check is in the deploy list |
| **K2** | An ESPN statId silently changes meaning | **high** | R1 catches it on the next pipeline run — a remapped id breaks the identity and reds the gate. This is why reconciliation is a *gate*, not a report |
| **K3** | Fit-engine constants drift in a 636-point pool | **high** | §7.4 `poolScale`, short-circuited to literal 1.0 on the default path, locked by the frozen-fixture test |
| **K4** | Manager believes an unmodeled-key total is complete | **high** | §11 coverage block + `PARTIAL SCORING` chips + `⃠ not modeled` on the key + bounded exposure ranges (§3.4) |
| **K5** | Someone decodes ESPN's bucket statIds and ships confident garbage | **high** | RM9 is the demonstration: 2/2 exact then 33/42. Decoding requires a *proof* against a league that prices the bonus before any key leaves `unmodeled` |
| **K6** | K/DST merged into `player_projections.json` by a later agent, evicting 74 offensive players | **high** | F-NEW-1. §5.4 separate contracts; `weekly_contract.test.mjs` + `real_data.test.mjs` fail loudly if it happens |
| **K7** | Components ship partial and the board mis-ranks | med | R2 makes partial coverage un-shippable; D4 handles the unreachable case defensively anyway |
| **K8** | Two scoring controls fight | med | §8 explicit visible precedence — the segment renders **disabled**, not hidden |
| **K9** | `replacementLevel` semantics change breaks saved expectations | med | Shape-gated (§7.3): no profile ⇒ no change. Migrating the default is a separate release with a published diff |
| **K10** | nflverse reachability regresses (one transient 502 observed **[F]** §3.1) | med | K/DST are runner-built and ship DORMANT regardless. Sandbox reachability (RM3) is a development convenience, never a runtime dependency |
| **K11** | Compare's fix surprises a half/std user | low | §7.5: explicit R3 carve-out, own test, own release-note line |
| **K12** | `roster_2026.csv` team assignments move before Week 1 **[F]** §13.5 | low | K/DST *team* assignment is display metadata, not a scoring input; the pipeline re-runs |

---

## 14. Acceptance criteria

1. Pasting `1393691504228184064` into `#/scoring` fetches Omilia-US **from the browser
   with no backend** and renders 10 teams, 9 starters, 4 bench, 147 keys / 65 non-zero,
   caps `QB2 RB5 WR5 TE3 K2 DEF2`, `draft_rounds 3`. Verified on the production domain.
2. Every one of the 147 values is hand-editable; edits survive a reload; **reset to
   league** restores the fetched values exactly; a re-fetch preserves edits.
3. With no league connected, **every number on Players / Team / Lineup / Auction is
   byte-identical to pre-Rel19** — locked by R3. Compare is the one documented exception
   (§7.5).
4. `score_PPR(components) == proj_points` for **300 of 300** players within **0.011** —
   locked by R1. Any exception is a red gate.
5. Every non-zero scoring key is either scored or listed as `not modeled` with a reason;
   none is silently ignored — locked by R4. Bounded-exposure ranges are shown where a
   tight bound exists and omitted, not faked, where it does not — locked by R5.
6. The Lineup tab shows **nine** slots for this league. K and DEF are either projected or
   explicitly marked awaiting-data. **A 7-slot "optimal" lineup for a 9-starter league is
   a gate failure.**
7. With `player_components.json` absent, the app shows ESPN-PPR points behind a visible,
   non-dismissable banner **and still applies league shape** (9 slots, 10-team replacement
   level).
8. `data/player_projections.json`, `data/player_weekly.json` and their schemas are
   unchanged by this release. `git diff --stat` proves it.
9. Nothing in Rel19 writes to `data/meta.json`, the signal registry, or any snapshot.
10. Gate ends 100% green via `bash tests/run_gate.sh` at **≥ 277 unit** and **≥ 82 E2E**.
