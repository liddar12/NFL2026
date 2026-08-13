# NFL2026 — Release Plan (revised)

**Date:** 2026-08-13 · **Last shipped:** Rel17 (`9fdcc0d`, verified on prod)
**Supersedes:** the first cut of this file. Decisions below are locked by the owner.

---

## 0. Locked decisions

| # | Decision |
|---|---|
| 1 | **K/DEF sourcing added.** Contract + slots in R19; projections in R20 from nflverse |
| 2 | **FLEX is a selector**, aligned to Sleeper (§2.2) |
| 3 | **Keeper league is a toggle**, on/off, changeable at any time |
| 4 | **Manual "sync now"** — no automatic polling |
| 5 | **SAVE button on the Team page**, after the draft-simulator league/roster settings |
| 6 | **Saved settings re-price, do not retrain** — the profile never enters the signal gate |
| 7 | Bug-fix releases go **last**, then a **performance/latency RCA** run autonomously |

---

## 1. Data test — is it available, and is it beneficial?

Run 2026-08-13. Every number below was produced in this pass, not recalled.
The governing constraint is the owner's: **it must improve backtesting.**

### 1.0 The structural finding that gates all of it

`scripts/promote_signals.py` evaluates **game-level log-loss** against
`data/fixtures/finals_{yr}.json`. All 8 families are game-model families. There is
**no player-level evaluation anywhere in the gate**, and the only player-level
backtest (`scripts/backtest_ros.py`) is an orphan: run by no CI job, surfaced in
no view, validated by no contract, and it scores a proxy formula rather than the
shipped RoS engine.

> **Consequence:** under "it must improve backtesting," *no player-level signal
> can be honestly adopted today* — there is nothing to measure it with. The
> player harness is therefore a prerequisite, not a nice-to-have. It is R18.

### 1.1 Target share / usage — **available, and beneficial in-season only**

**Availability:** already partly ingested. `data/player_usage.json` carries
`target_share`, `targets`, `air_yards`, `rz_touches` for 450 players;
`data/player_usage_history.json` carries season-level share for 5 seasons.
Weekly detail is free from nflverse `stats_player_week` — `target_share`,
`air_yards_share`, `wopr`, `racr`, `receiving_epa` (verified HTTP 200, 150 cols).

**Benefit — measured two ways, and the answer differs:**

*Season → next season* (n = 705 paired player-seasons, 2021→2025, ≥4 games each):

| Cohort | r(points) | r(targets/g) | R² points-only | + usage | **Δ** |
|---|---|---|---|---|---|
| ALL | +0.732 | +0.154 | 0.535 | 0.541 | **+0.005** |
| WR | +0.744 | +0.734 | 0.553 | 0.563 | +0.010 |
| RB | +0.659 | +0.515 | 0.435 | 0.438 | +0.003 |
| TE | +0.713 | +0.665 | 0.508 | 0.511 | +0.003 |

*Within season — through week 6 → rest-of-season PPG* (n = 480 player-seasons,
2023–2024, ≥4 early and ≥6 later games):

| Cohort | r(points) | r(target share) | r(wopr) | R² points-only | + usage | **Δ** |
|---|---|---|---|---|---|---|
| ALL | +0.770 | +0.623 | +0.540 | 0.592 | 0.604 | **+0.012** |
| **TE** | +0.717 | +0.728 | +0.705 | 0.514 | 0.558 | **+0.044** |
| **WR** | +0.793 | +0.776 | +0.783 | 0.629 | 0.656 | **+0.027** |
| **RB** | +0.746 | +0.632 | +0.592 | 0.557 | 0.581 | **+0.024** |

**Verdict: build it, but only for the in-season RoS path.** Season-to-season,
usage is nearly collinear with fantasy points — it restates what points already
say (+0.005). Within a season it adds real, consistent signal across all three
positions, strongest at TE. That is precisely where the RoS engine lives.

*Limits, stated plainly:* two seasons, a single week-6 cut, no walk-forward
across multiple cuts, no held-out season. This justifies **building the harness
and testing it properly** — it does not by itself justify adoption. The
never-regress gate makes that call, on the larger corpus, at weight 0 until it
earns otherwise.

### 1.2 Offensive schemes — **available for backtest, NOT applicable this season**

FTN charting: `2022` → 200, `2024` → 200, `2025` → 200, **`2026` → 404**.

Scheme data can improve *backtesting* over 2022–2025, but there is **no 2026
file**, so a scheme signal cannot be applied to the live season until FTN
publishes. Design it as a backtest-and-wait family; ship the application path
dark. (Rel18's `scheme_matchup` design already handles the join to pbp — the FTN
header has no team column.)

### 1.3 Auction value — **available free, display + opponent model only**

ESPN's kona endpoint — **already scraped by this repo** — carries
`ownership.auctionValueAverage` on every player (15/15 populated in the probe,
e.g. Gibbs 64.08, Chase 56.60, Allen 28.55) alongside `averageDraftPosition`.
Marginal cost: one extra field on an existing request.

**It is a market price**, so the standing rule that governs ADP governs it:
**never a projection input.** It is legitimate for (a) display, (b) value flags —
your VOR dollars vs the room's price, and (c) a materially better auction
opponent model, which is what makes the AI+ room worth building. No backtest is
required, because it never touches a projection.

### 1.4 Playoff metrics — **available now, zero new feeds, material spread**

Reframed against your actual league: Sleeper reports `playoff_week_start 14`, so
what matters is **fantasy** playoffs (weeks 14–17), not the NFL postseason.

Computed from data already committed (`player_weekly.json` × `team_strength.json`,
300 players): opponent Elo faced in W14–17 minus each player's season average —

- mean **+1.5**, sd **27.2**
- easiest decile **−27.2**, hardest decile **+26.5**
- full spread **152.5 Elo** (−91.8 … +60.8)

At the usual ~25 Elo ≈ 1 point of spread, a decile-hard playoff schedule is worth
roughly a point a game against a decile-easy one, over the four weeks that decide
your season. **This is the cheapest win of the four: no new feed, no new
scraper, no gate family — it is a lens over data already on disk.**

*(The NFL postseason is separately available — 309 completed games, 27 seasons —
but it is irrelevant to fantasy scoring. Its only use is extra game-model
training data, which R18's corpus expansion already picks up.)*

### 1.5 Summary

| Item | Available? | Beneficial? | Where it lands |
|---|---|---|---|
| Target share / usage | ✅ weekly, free | ✅ **in-season only** (+0.024…+0.044 R²) | R21, behind R18's harness |
| Offensive schemes | ✅ 2022–2025 · ❌ 2026 | ⚠️ backtest only, cannot apply live | R22, application path dark |
| Auction value | ✅ free, existing endpoint | ✅ as display + opponent model | R21 display · R23 opponent model |
| Playoff metrics (W14–17) | ✅ **already on disk** | ✅ 152 Elo spread | R21 — cheapest win |

---

## 2. The releases — 8 total

### R18 — Gate credibility + player-level harness *(foundation)*

Nothing measured above can be honestly adopted without this.

- Expand the backtest corpus to **27 seasons / 6,967 games** (from 1,359).
- Replace `MARGIN = 0.0015` with a **significance-based** criterion — it is
  currently ~0.85σ, which is why the sole adopted family's 95% CI spans zero.
- Re-fit the three adopted game params **off-grid** (all three sit on grid
  boundaries; hfa optimum ≈ 35 vs the adopted 45).
- **Build the player-level evaluation harness** — the thing that does not exist.
- Retire the `backtest_ros` orphan into it (closes open bugs #9, #10, #11).

### R19 — League Profile *(the big one)*

One saved `LeagueProfile` object; kills the frozen-constants root cause.

**2.1 Scope**
1. Sleeper league-id import (manual **sync now**), paste-JSON fallback, and
   hand-build — all three ship, so a CORS failure is a degraded path, not an outage.
2. **SAVE button on the Team page**, directly after the draft-simulator league and
   roster settings, persisting to `nfl2026.league.v1`.
3. Re-price every surface — Players, Team, Lineup, Compare, draft board, auction —
   from real per-player components × your scoring. Exact, never scaled off a PPR total.
4. Roster shape becomes data: fixes open P2 bugs **#4** (no backup QB in 2-QB
   leagues) and **#5** (LIVE mirror desync) at the root, and unifies the
   per-roster vs league-wide replacement-level split so team count finally
   affects VOR.
5. **Keeper toggle** — on/off, changeable whenever your league changes.
6. K/DEF **slots** render (all 9 starters); an unprojected slot reads "awaiting
   K/DST feed" rather than silently shorting your lineup.

**2.2 FLEX selector — Sleeper alignment**

| Option | Eligible | Sleeper token |
|---|---|---|
| WR/RB | WR, RB | `WRRB_FLEX` |
| WR/TE | WR, TE | `REC_FLEX` |
| WR/RB/TE | WR, RB, TE | `FLEX` *(standard)* |
| RB/TE | RB, TE | **no Sleeper token** — app-only, hand-editable |
| QB/WR/RB/TE | QB + all | `SUPER_FLEX` *(recommended to include — your league allows 2 QB)* |

Import maps Sleeper's token → the selector; a hand-set RB/TE simply has no token
to round-trip, which the UI states rather than silently rewriting.

### R20 — K/DST projections + Sleeper roster sync

- K/DST projections from **nflverse** (`fg_made_0_19` … `fg_made_60_` map 1:1 to
  the six FG buckets; weekly defensive tiers compute correctly). ESPN was rejected
  on measurement — a hand decode of its kicker statIds reconciles only 33/42.
- **Manual roster sync**: pull your actual Sleeper roster and weekly starters so
  Team and Lineup stop needing hand entry, and START/SIT compares against what
  you actually started.

### R21 — Measured signals *(everything §1 proved)*

- In-season usage (target share, wopr) into the **RoS** path, at weight 0 behind
  R18's harness until it earns otherwise.
- **Fantasy-playoff SoS (W14–17)** as a first-class lens on Players, Compare and
  the draft board — no new feed.
- Auction value **displayed** beside your VOR dollars as a value flag.

### R22 — New game families *(the original Rel18b)*

`divisional`, `coach_quality`, `coach_regime`, `dvp_mismatch`, `scheme_matchup`
— 13 families total, `referee` already cut in design. Gated by R18's corrected
statistics; scheme ships with its application path dark until FTN 2026 exists.

### R23 — AI+ room + mock-draft learning

A third room type beside ADP and SHARK, driven by the AI+ engine and by R19's
profile (an opponent drafting to *your* scoring), plus the auction opponent model
from §1.3. Makes the stored mock results actually feed something — or renames
them honestly if they will not.

### R24 — Bug-fix release *(owner-directed: bugs last)*

Everything still open after R19 absorbs #4 and #5:

- **Functional:** auction over-roster guard (#6). *(#9/#10/#11 close in R18.)*
- **UI/UX — 10 open findings**, led by the two that hit every screen:
  `.view-title` / `.view-sub` have **zero CSS** (#11), and the tab bar clips its
  6th tab at 320px (#2). Then `.cmp-name` WCAG AA (#1, the only P2), gate focus
  trap (#3), compare a11y labels (#4), tab-less compare route (#5), 18px touch
  target (#7), stacked-layout winner glyph (#8), edge-rail alignment (#9), 11px
  tinted abbreviations (#10).

### R25 — Performance & latency RCA *(autonomous)*

Run without owner involvement, using the standard approach.

**Method:** measure first, then fix — no speculative optimization.
1. **Instrument:** cold and warm load, per-route mount time, per-contract fetch
   and parse time, main-thread long tasks, layout thrash, memory growth across
   route churn. Phone (402pt) *and* 13" iPad, since the Team page is iPad-first.
2. **Attribute:** separate network (already brotli — 759 KB raw → ~32 KB wire, so
   payload is not the bottleneck) from parse, from compute, from render. The
   suspects are the per-mount `Map` builds over 300–450 players in
   `views/team.js`, repeated derived-value work in paint functions, and the
   6 sequential contract fetches on the heaviest route.
3. **Fix** highest-cost-first, each with a before/after number.
4. **Lock:** a performance budget assertion in the gate so a regression reds CI
   rather than being noticed months later.
5. **Verify on prod** and report with the measurements.

---

## 3. Ordering

```
R18 ──→ R21 ──→ R22          model track   (harness + statistics first)
  │
R19 ──→ R20 ──→ R23          league track  (profile first)

                 R24 ──→ R25  bugs, then performance   (owner-directed: last)
```

- **R18 and R19 run in parallel** — disjoint files (Python pipeline/gate vs
  `app/` engines and views), the one genuinely safe concurrent pair.
- R21 needs R18 (nothing to measure with) and benefits from R19 (playoff SoS is
  more useful once the profile knows your playoff weeks).
- R23 last of the feature work — an AI+ opponent is worth far more once it drafts
  to your league.
- **Bugs deliberately last, per your instruction.** Worth noting: the two P2s
  (#4, #5) are fixed structurally by R19, so no P2 waits for R24 — what waits is
  one P3 plus the UI/UX polish.
