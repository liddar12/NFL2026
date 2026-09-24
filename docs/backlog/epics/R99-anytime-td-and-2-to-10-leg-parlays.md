# EPIC R99 — Anytime-TD, labelled 2–10-leg parlays, and the owner's bets as training data

**Filed:** 2026-09-24, from the owner. **Status:** Gate 3 approved 2026-09-24. **E1 S1–S4 built
2026-09-24** (measure-only; see E1 below); S5–S7 and E2–E4 not started.
**One line:** the owner bets mostly anytime-TD (ATD) parlays of 4–10 legs; the app has no ATD market,
prices at most two legs per game, and learns nothing from the bets he actually placed.

---

## 1. Owner decisions (Gate 1, recorded verbatim in substance)

| Decision | Owner's answer |
|---|---|
| 10-leg card shape | **Both, labelled, at every size from 2 to 10 legs:** a *TD + FLOOR LADDER* card and an *ALL ANYTIME TD* card for every game. |
| How real bets reach the app | **Screenshots to Claude**, transcribed into a committed ledger the pipeline grades. |
| Build order | **TD model first**, then ledger, then the game simulation and the 2–10-leg cards, then the parlay-type catalogue. |

Gate 2 (design direction) is **deferred to the start of E3**, the first phase with UI. It is a real
gate there: 2 shapes × 9 sizes is 18 cards per game and 288 per week, and how that is shown on an
iPhone without a wall of cards is a design question, not an implementation detail.

## 2. Evidence: the owner's 19 tickets

Transcribed from 18 screenshots into [`../evidence/2026_owner_fanduel_slips.json`](../evidence/2026_owner_fanduel_slips.json)
(113 legs; bet ids omitted). Measured, not estimated:

| | |
|---|---|
| Staked / returned | $186 / $608.33 → **+$422**, of which **$443 is one ticket** (Q, 4-leg ATD, 9/13). Without it ≈ −6%. |
| ATD legs, unique player-games | 62, **44 %** hit |
| Priced ATD legs vs the book | 40 legs: **18 hits vs 16.4 implied** — marginally ahead, far too few to call an edge |
| By position | RB **56 %** (14/25) · WR 40 % (10/25) · TE **30 %** (3/10) · QB rush TD 0/2 |
| By slate | 9/13 **13/18** · 9/20 **11/32** — the same RBs, a week apart |

What lost money, in order: **(1) exposure** — on 9/20 Bijan and Irving were on 3 tickets each, Swift,
Jeanty, Metcalf and Loveland on 2; one outcome, many dead tickets. **(2) leg count** — both 8-leg ATD
tickets hit 1/8. **(3) correlated collapse** — ticket K lost five pass-catcher legs to one dead passing
game; ticket A lost both Nabers legs after Dart was ruled out (the R92 cascade, on a real slip).
**(4) near misses** — N 3/4, F lost only Bijan, S 7/8 (cashed out), C 5/7, P 9/11. What worked:
alt-yardage floors (P 9/11, A 5/7) and favoured bell-cow RB ATDs across games (S 7/8, R 7/7 MLs).

## 3. Rules every story inherits

- **No book number reaches a model probability.** FanDuel prices in the ledger are a yardstick, like
  every market number in this repo (`validate_data.py` scans for it).
- **Measure before adopting.** Every model ships measure-only first and is adopted only by the
  never-regress gate on held-out seasons; a failed gate means it stays measure-only, said out loud.
- **Coverage counts only REAL tests** (`QA_COVERAGE.md`): an AC below is covered when the named test
  exists, runs in `tests/run_gate.sh`, and goes red when the AC is violated. Until then it is PLANNED.
- Stdlib Python / Node built-ins, no build step, iPhone-first HIG, `data/` is runner-owned.

---

## E1 — Anytime-TD model (Phase 1, measure first) · LOE ≈ 2–3 d

**Built 2026-09-24 — S1–S4, in `scripts/backtest_atd.py`, run weekly by `backtest.yml`, written to
`data/atd_backtest.json` (contract `atd_backtest.schema.json`; `validate_data.py` recomputes `adopted`
from the receipts).** Measured on the 2021–25 nflverse corpus; universe = every QB/RB/WR/TE who took an
offensive snap or touched the ball (snap counts, pfr → gsis through the rosters) — *not* stat rows
alone, which would leak the outcome because every TD needs a carry or a target. Hyper-parameters were
chosen on **2022 only**; 2023–25 never chose anything.

| Held-out | Model log loss / Brier / slope | Position base rate | Opportunity-only |
|---|---|---|---|
| 2023 (6,773) | **0.3750** / **0.1150** / 1.06 | 0.4262 / 0.1297 | 0.3819 / 0.1172 |
| 2024 (6,798) | **0.3844** / **0.1197** / 1.03 | 0.4391 / 0.1351 | 0.3893 / 0.1212 |
| 2025 (6,880) | **0.3831** / **0.1188** / 1.00 | 0.4377 / 0.1340 | 0.3881 / 0.1202 |

Team TDs (S2 AC2), pooled 2024–25: mean λ 2.360 vs realised 2.427, **ratio 0.972** (inside ±5 %).
Per season it is 1.000 (2023), **0.942 (2024)** and 1.003 (2025): league scoring rose 7.8 % in 2024
and a walk-forward model cannot see a league-wide jump coming, so it priced that season about 6 % low —
the conservative direction. A faster-adapting league level was tried and chosen *against* on 2022
(it made 2022 worse, 1.05 → 1.07–1.09), so the setting stands. **Verdict on 2021–25: ADOPTED** — the
runner's weekly run is the one that counts. S5 (ATD legs in the pool) is the next step and reads that
flag.

**Coverage (REAL, in the gate):** S1 AC1–AC3 → `r99_td_corpus.test.mjs` (4); S2 AC1–AC2 →
`r99_team_td.test.mjs` (2, the leakage test has a control that goes red); S3 AC1–AC3 →
`r99_td_share.test.mjs` (3, cascade proven with and without); S4 AC1–AC3 → `r99_atd_backtest.test.mjs`
(4, each failing condition alone, forged verdicts refused by the validator); `--selftest` in
`tests/smoke.sh`. Mutation-checked: removing the team cap and relaxing `<` to `<=` both go red.
**11 of 11 S1–S4 ACs covered.**

**Source:** nflverse `stats_player/stats_player_week_{season}.csv` — verified 2026-09-24 to carry
`carries, targets, target_share, rushing_tds, receiving_tds, passing_tds, special_teams_tds`
(the `player_stats` tag returned nothing; the corpus builder already falls back to `stats_player`).
**No red-zone columns** — red-zone share needs play-by-play and is E1-S7, later.

| Story | Acceptance criteria | Test |
|---|---|---|
| **S1 TD corpus.** Extend the weekly corpus with carries, targets, rushing_tds, receiving_tds (REG, 2021–25), same loud-on-hole posture. | AC1 every player-week row carries the four fields, absent-not-zero when unknown. AC2 a season with zero rows raises, never writes an empty season. AC3 team TD totals reconcile to the sum of player TDs per team-week. | `tests/feature/r99_td_corpus.test.mjs` |
| **S2 Team TD expectation λ_team.** Shrunk offence TD rate × opponent TDs-allowed rate × home factor, walk-forward. | AC1 no week uses data from itself or later (leakage test on a planted future row). AC2 mean predicted vs realised team TDs within ±5 % on held-out 2024–25. | `tests/feature/r99_team_td.test.mjs` |
| **S3 Player TD share.** Shrunk blend of TD share and opportunity share (carries, targets), plus the R92 depth cascade: a promoted backup inherits the starter's share, an OUT player has none. | AC1 shares per team-game sum to ≤ 1. AC2 an OUT starter's share is 0 and his backup's rises (R92 fixture). AC3 a player with no history falls back to the position prior, never to 0. | `tests/feature/r99_td_share.test.mjs` |
| **S4 P(ATD) = 1 − e^(−λ_team·share)**, measured walk-forward 2023–25 into `data/atd_backtest.json` (contract, measure-only). | AC1 log loss and Brier reported against two baselines (position base rate; opportunity-only share). AC2 `adopted` is true only if the model beats both on every held-out season and its calibration slope is within [0.9, 1.1]. AC3 the verdict text names the failing condition when not adopted. | `tests/feature/r99_atd_backtest.test.mjs` + validator contract |
| **S5 ATD legs in the pool** — only after S4 adopts. Market `atd`, one rung, `this_week` gate applies. | AC1 no ATD leg on a player who does not play this week (the existing invariant, extended). AC2 no ATD leg exists while `adopted` is false. | `tests/feature/r99_atd_pool.test.mjs` + validator |
| **S6 Resolution.** ATD graded from nflverse `rushing_tds + receiving_tds ≥ 1`; a void (did not play) is void, never a loss. | AC1 the three outcomes on fixture rows. AC2 the owner's 62 ATD player-games resolve to the transcribed results. | `tests/feature/r99_atd_resolve.test.mjs` |
| S7 *(later)* red-zone share from play-by-play. | Adopted only if it beats S4 on the same gate. | — |

## E2 — MY BETS ledger (Phase 2) · LOE ≈ 1–2 d

| Story | Acceptance criteria | Test |
|---|---|---|
| **S1 Ledger + contract.** `bets/my_bets_2026.json` — hand-authored input, deliberately *outside* runner-owned `data/`; seeded from the evidence file. | AC1 schema-valid; AC2 a leg with a market this app cannot grade is kept and marked ungradable, never dropped. | `tests/feature/r99_ledger_contract.test.mjs` |
| **S2 Grader.** Each leg resolved from nflverse/finals (ATD, yardage, receptions, ML); voids honoured. | AC1 regrading the 19 seed tickets reproduces the screenshots' results leg for leg (the `?` legs excepted). | `tests/feature/r99_ledger_grade.test.mjs` |
| **S3 What the ledger says.** Hit rate vs book-implied vs model, by market / position / slate; near misses; ticket ROI with and without the single biggest ticket. | AC1 every figure in §2 of this doc is reproduced from the ledger by code. | same file |
| **S4 Exposure guard.** Warn when one player is on ≥ 2 tickets in one slate — on MY BETS and while building a MY PARLAYS card. | AC1 the 9/20 seed produces the six warnings in §2; AC2 no warning across different slates. | `tests/feature/r99_exposure.test.mjs` + a web spec |
| **S5 Learning, honestly.** Ledger legs join the *measurement* corpus (how the model rates the legs the owner chose), not the training set — a bettor's picks are a biased sample and would teach the model his taste. | AC1 the model's training input is byte-identical with and without the ledger. | `tests/feature/r99_ledger_isolation.test.mjs` |

## E3 — Game simulation + labelled 2–10-leg cards (Phase 3) · LOE ≈ 3–4 d · **Gate 2 first**

| Story | Acceptance criteria | Test |
|---|---|---|
| **S1 Simulator.** Team TDs from λ_team, allocated to players by share (teammates compete for the same TDs); yardage drawn around each player's mean with a shared team pass/run factor (a dead passing game takes every pass-catcher with it — ticket K); ML from the win model. Seeded, deterministic. | AC1 same seed, same bytes. AC2 marginals reproduce E1 P(ATD) and the existing yardage probabilities within Monte-Carlo error. AC3 two same-team ATD legs are less likely together than independence says; QB yards + his WR's yards more likely. | `tests/feature/r99_sim.test.mjs` |
| **S2 Joint validation.** Random historical cards of 2…10 legs per shape, 2023–25: predicted joint vs realised. | AC1 per-size calibration reported; AC2 a size whose calibration fails is **not offered** and the card says why. | `tests/feature/r99_sim_backtest.test.mjs` |
| **S3 Two labelled shapes × 2–10 legs, every game.** *TD + FLOOR LADDER* (about a third ATD, the rest the highest-probability alt floors, never two legs from one opinion) and *ALL ANYTIME TD*. | AC1 each game offers both shapes at every size that passed S2. AC2 every card shows its label, leg count, model hit %, break-even odds. AC3 R74 one-leg-per-side holds. | `tests/feature/r99_cards.test.mjs` + web spec |
| **S4 The R83 two-legs-per-game cap** lifts only for simulator-priced cards; the pairwise path keeps it. | AC1 a pairwise-priced card with 3 same-game legs is still refused. | `tests/feature/r99_cap.test.mjs` |

## E4 — Parlay-type catalogue (Phase 4) · LOE ≈ 1–2 d

Game: TD + floor ladder, shootout stack (both QBs + WR1s), script (favourite ML + its RB1 ATD + rush
floor), ALL ANYTIME TD. Week: bell-cow RB ATDs (the S pattern), favourite ML ladder (R), one ATD per
game across 4–8 games (spreads the exposure the 9/20 slate concentrated), round-robin suggestion.
Every type carries model hit %, break-even odds and the exposure guard. ACs and tests are written
when E3's design lands, because they depend on it.

---

## 4. Honest limits, stated before anyone builds

- ATD is a Poisson event; a well-calibrated 35 % leg misses 65 % of the time. A 10-leg ALL ANYTIME TD
  card at a 44 % leg rate hits about **1 in 3,700**; the app will print that, not hide it.
- 19 tickets / 62 player-games cannot prove an edge either way; the ledger's value grows with every
  slate sent.
- Red-zone usage is the strongest ATD signal and is not in the free weekly feed (E1-S7).
