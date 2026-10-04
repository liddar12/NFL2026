# EPIC R110 — MY BETS ledger (R99 E2, re-scoped 2026-10-04)

**Filed:** 2026-10-04, from the owner ("…then the MY BETS ledger"). **Status:** Gate 2 and Gate 3
approved 2026-10-04 (BETS chip in PARLAYS · slip stack · backlog as written). **Supersedes** R99 E2 S1 (a committed
`bets/my_bets_2026.json`): the owner chose on-device storage, so nothing about a bet is committed.

**One line:** every bet the owner actually places is recorded in one tap from the card it came from
(or built by hand from the leg pool), graded automatically from the same facts the pipeline grades
with, and measured against the model and the book, with a warning before the same player is
staked twice.

---

## 1. Owner decisions (2026-10-04)

| Decision | Owner's answer |
|---|---|
| How a bet gets in | **"I bet this" + manual.** A button on every card (PARLAYS GAME/WEEK, MY, every TD scope) records it with the stake and the book's odds; a manual builder picks legs from the leg pool, so every leg auto-grades. An exposure warning flags overlap with bets already held. |
| Where it is stored | **On this device + export.** Browser storage, with export/import of a JSON backup; no sync, no account, nothing committed. |
| Placement / look | **A BETS chip in PARLAYS** beside GAME / WEEK / MY, with the open-bet count; **slip stack** look (Gate 2, below). |

## 2. Architecture (extends the settled stack; no new dependency, no build step)

| Piece | What it is |
|---|---|
| `scripts/build_bet_facts.py` → `data/bet_facts.json` | Runner step after the resolvers (daily + gameday). Per week: each game's status and, once FINAL, its score; each player's stat line (pass / rush / rec yds, receptions, TD scored) and whether the snap sheet shows the player played. Facts only, no probability. Contract `bet_facts.schema.json`. |
| `app/bets/grade.js` | Pure browser grader, a line-for-line mirror of `resolve_my_cards.grade_prop / grade_game / grade_atd`: R106 (any miss = loss, only all-hit wins, voids drop out at 1.0), R108 (an excluded game's legs are void), status gating (only FINAL settles; live/in-progress is pending). |
| `app/bets/store.js` | Versioned document in `localStorage` (`nfl26.mybets.v1`), every read and write in try/catch, an in-memory fallback with an honest banner, export (JSON download) and import (validated, merged by bet id). |
| `app/views/mybets.js` | The ledger screen + the save sheet + the manual builder (placement per Gate 2). |
| Exposure guard | One pure function over the open bets: a player, or a team side, on 2+ open bets in one week → warning naming the bets. Runs in the save sheet *before* saving and on the ledger. |

**Learning isolation (R99 §3):** the ledger lives only in the browser, so no pipeline script can read
it; the bettor's picks never enter a training set. They are a measurement, shown on the device only.

## 3. Stories, acceptance criteria and the tests that lock them

| Story | Acceptance criteria | Test |
|---|---|---|
| **S1 Facts feed** | AC1 `data/bet_facts.json` validates against its contract. AC2 only a FINAL game carries a score; an in-progress or scheduled game carries none. AC3 every leg graded in `my_card_scores.json` (weeks 2–3) regrades to the same result from `bet_facts.json` through the browser grader (parity). | `tests/feature/r110_bet_facts.test.mjs` |
| **S2 Store** | AC1 add / list / delete round-trip. AC2 storage that throws (private mode) falls back to memory with a banner, no crash. AC3 export → import round-trips byte-identical. AC4 a malformed import is refused with its reason; a valid one merges by id with no duplicates and never overwrites an existing bet silently. | `tests/feature/r110_store.test.mjs` |
| **S3 "I bet this"** | AC1 a ≥44 px button on every card in GAME, WEEK, MY and every TD scope. AC2 the sheet takes stake ($) and book odds (American, pre-filled with the card's fair price, editable) and saves the legs verbatim with the as-offered model probability. AC3 recording the same card twice in a week asks first. | `tests/feature/r110_bet_this.test.mjs` + `tests/web/r110_my_bets.spec.mjs` |
| **S4 Manual builder** | AC1 search a player or team, pick any rung or game/ATD leg from `data/leg_pool.json`, 1–10 legs, any games. AC2 one leg per player-market and R74 one per game side, same rules as MY. AC3 every saved leg carries game_id, gsis_id / team, market and line, so it auto-grades. | same files |
| **S5 Grading** | AC1 parity with the Python grader (S1 AC3). AC2 an R108-excluded game's legs are void; an all-void bet is "no action", out of the P&L. AC3 a leg stays pending until its game is FINAL. AC4 payout = stake × American-to-decimal on a win, the stake back on no action, −stake on a loss. | `tests/feature/r110_grade.test.mjs` |
| **S6 Ledger + what it says** | AC1 OPEN / WON / LOST / NO ACTION sections, newest first. AC2 totals: staked, returned, net, ROI. AC3 by leg count and by source (GAME / WEEK / MY / TD / manual). AC4 the model's average hit chance vs the actual hit rate, and the book-implied rate vs both. | `tests/feature/r110_ledger.test.mjs` + web spec |
| **S7 Exposure guard** | AC1 importing the 9/20 evidence tickets produces exactly the six warnings in R99 §2 (Bijan, Irving ×3; Swift, Jeanty, Metcalf, Loveland ×2). AC2 no warning across different weeks. AC3 the warning shows in the save sheet before saving. | `tests/feature/r110_exposure.test.mjs` + web spec |
| **S8 Evidence import** | AC1 the owner's 19 FanDuel tickets (`docs/backlog/evidence/2026_owner_fanduel_slips.json`) import as bets; a leg this app cannot grade keeps the slip's result and is marked "slip result", never dropped. | `tests/feature/r110_store.test.mjs` |
| **S9 Isolation** | AC1 no file under `scripts/` reads the bet store or its key; the model's training inputs are byte-identical with and without bets on the device. | `tests/feature/r110_isolation.test.mjs` |

**QA coverage:** 25 acceptance criteria, each named to a test above that runs in `tests/run_gate.sh`
and goes red when the criterion is violated: 25 / 25 planned (100 %), counted as covered only once the
test exists (`QA_COVERAGE.md` rule).

## 4. Gate 2 — design direction (iPhone first; approved: placement A, look 1)

Placement: **(A)** a BETS scope in PARLAYS beside GAME / WEEK / MY, where the "I bet this" buttons
live, with an open-bet count on the chip; **(B)** a ninth tab; **(C)** a sheet behind a badge in the
header. Look, inside the app's existing dark design system:

1. **Slip stack.** Each bet is a sportsbook-slip card: legs with ✓ / ✗ / – ticks, stake → to-win, a
   status rail on the left edge. Totals in a sticky strip on top.
2. **Ledger rows.** One dense row per bet (date · legs · odds · stake · net), tap to expand the legs;
   a P&L sparkline over the season. Most information per screen.
3. **By slate.** Bets grouped by game day, exposure heat on each player chip (how many open bets ride
   on that player), the guard's warnings inline. Best for spotting stacked risk.

## 5. Honest limits

- Device-only means a cleared browser loses the ledger unless it was exported; the screen says so
  and offers the export after every 5th new bet.
- Markets the pipeline has no facts for (alt receptions, first-TD, player specials) are kept with the
  slip's own result and never counted as model-graded.
- 19 tickets cannot prove an edge either way; the ledger becomes informative with volume.
