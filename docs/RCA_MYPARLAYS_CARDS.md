# RCA — MY PARLAYS cards: the numbers and the spacing (2026-09-17)

Prepared for an independent second review. Everything below is reproducible
from the committed tree at `main` `886b5bb` (R82 merged) with the scripts in
the appendix; nothing here was changed in the product yet.

## 0. Executive summary

The owner reported, on the MY tab of PARLAYS seeded with `DET` (desktop, dark
mode, 1395px), that (a) the card spacing still looks off and (b) CONVICTION,
EV and `$100 PAYS` look "completely wrong or made up" compared with the GAME
and WEEK slates.

**Both reports are correct, and neither is a display bug.**

* **The numbers are arithmetically consistent and structurally wrong.** The
  MY builder ranks cards by conviction (combined model probability) and lets
  every rung of every player compete. The highest-probability rung of any
  player is always his *lowest* line, so the search picks the lowest line for
  **100 % of prop legs** — 1,280 of 1,280 across all 32 team seeds, 320 cards.
  Every card is therefore a near-lock that pays pennies: mean EV −16 %, mean
  `$100 PAYS` +$26, every card tier `low`, the best 2-leg card in the whole
  product pays +$40. The slate (GAME / WEEK) never shows this because it prices
  each player at one fixed line near his projection (60+ for a 66.8 projection
  → 46 %), so its cards look like bets. Same maths, different question.
* **Two further inconsistencies make the MY numbers contradict the slate on
  the same screen:** the same leg carries two different probabilities (pool
  calibration vs slate calibration, mean gap 6 points, max 15.7), and
  `$100 PAYS` is computed under two different conventions (MY: our
  probability + 4.5 % hold; slate: every prop at −110). For the two DET props
  the owner saw, the slate would print +$264 where MY prints +$10.
* **A latent risk for any fix:** the same-game correlation adjustment chains
  pairwise ρ across legs in order. It is harmless on today's deep-rung cards,
  but on fair-line legs a 6-leg same-game MY card prints **EV +320 %** and
  `$100 PAYS` +$3,239. The slate never builds more than 3 legs, so this regime
  has never been validated.
* **The spacing is three measured faults**, one of them created by R82: an
  **83 px void** inside the shorter card of every mixed row (R82's equal-height
  rows anchor the footer to the bottom), **0 px** between the seed chips and the
  legend and **0 px** between the legend and the grid (the MY host has no
  vertical rhythm), and a row composition (3-up) that puts the two cards of a
  leg-count band in different rows even though the list is built as five
  pairs.

Recommended fix, rated in §6: change the *question* the MY builder answers
(one rung per player at a chosen risk dial, ranked by EV among fair-priced
legs, with same-game cards capped at 3 legs until the correlation chain is
validated), unify the `$100 PAYS` convention, and lay the list out as the
five leg-count pairs it already is.

## 1. What the owner saw (reproduced)

Viewport 1395 × 704, `prefers-color-scheme: dark`, `#/parlays` → MY → seed
`DET`. Screenshot: `rca_dark_1395.png` (sent with this report).

| card | legs | CONVICTION | EV | `$100 PAYS` | tier |
|---|---|---|---|---|---|
| 1 | J. Gibbs 20+ rush yds · J. Cook III 30+ rush yds | 82 | −9.2 % | +$10 | LOW |
| 2 | A. St. Brown 20+ rec yds · J. Cook III 30+ rush yds | 82 | −9.3 % | +$11 | LOW |
| 3 | J. Gibbs 20+ · B. Robinson 30+ · J. Cook III 30+ | 77 | −12.4 % | +$14 | LOW |
| 4–10 | 3 to 6 legs, all at each player's lowest rung | 76 → 59 | −12 → −23 % | +$15 → +$31 | LOW |

The slate's own card for two of the same players, the same week
(`data/parlays.json` `401872932-g3`):

| leg | line | projection | MODEL | IMPL |
|---|---|---|---|---|
| J. Gibbs 60+ rush yds | 59.5 | 66.8 | 45.6 % | 47.6 % |
| A. St. Brown 60+ rec yds | 59.5 | 69.75 | 48.2 % | 50.4 % |

Slate card: MODEL EV +1.9 %, `$100 PAYS` **+$264** (both props assumed at
−110 by `build_review.leg_decimal`).

Same two players, same projections, same week: MY says a 2-leg card is worth
+$10, the slate says +$264. That is the contradiction the owner is reading as
"made up".

## 2. How each number is produced (traced)

All in `app/views/myparlays.js` and `app/parlay-math.js`; the slate mirrors
the same maths in `scripts/models/parlay_builder.py` (parity locked by
`tests/feature/r76_parlay_math_parity.test.mjs`).

* **Leg MODEL** — `legFromPool(row, rung)`: `rung.model_prob` from
  `data/leg_pool.json`, clamped to [0.05, 0.95]. The pool prices every rung
  with the *pool* calibration (`data/leg_pool_backtest.json`,
  `sigmoid(a + b·z + c·(p_team − 0.5))`, z = (projection − line) / residual_sd).
* **Leg IMPL\*** — `impliedFromModel(model)` = `model × 1.045`, clamped below
  1. There is no player-prop odds feed, so a prop's "price" is our own number
  plus the standard hold. `J. Cook III 30+` at 94.6 % → IMPL\* 98.9 %, i.e. a
  price of about −9,000. No book offers that line.
* **CONVICTION** — `combinedProbs(legs, sameGame, table)[0]`: the independence
  product across games; within a game a chained pairwise adjustment
  `combineTwo(pJoint, pNext, ρ)` = `pJoint·pNext + ρ·√(pJoint(1−pJoint)·pNext(1−pNext))`,
  applied leg by leg in card order, ρ from `data/parlay_backtest.json
  correlations` (default 0.10, opposing sides negated).
* **EV** — `modelEv(model, implied)` = `conviction / Π(IMPL) − 1`. For an
  all-prop card this is `Π(model) / Π(model × 1.045) − 1` = `1.045^−n − 1`
  before the correlation term: **−8.4 % for 2 legs, −23.2 % for 6**, whatever
  the players. EV on a MY prop card carries no information by construction.
  (The module header says so; the owner is right that the screen does not.)
* **`$100 PAYS`** — `scoreCard`: `100 × (1 / Π(IMPL) − 1)`. For the deep rungs
  Π(IMPL) ≈ 0.91, so +$10.
* **TIER** — `confidenceTier`: needs `conviction − Π(IMPL) ≥ 0.04` for
  MEDIUM. On an all-prop card that difference is always negative, so every MY
  card is LOW forever.

Every figure on the card reconciles with every other figure on the card. The
fault is upstream of the arithmetic.

## 3. Root causes — the numbers

### RC-N1 (primary) — the objective is degenerate: "rank by conviction" over a ladder always picks the lowest rung

`buildCards` sorts candidates by `model_prob` and grows cards by conviction.
A player's rungs (`19.5, 29.5, … 99.5`) are nested events: clearing 60 clears
20. So his most probable rung is always his lowest line, the beam never has a
reason to take a higher one, and the one-leg-per-player rule then keeps only
that lowest rung on the card.

Measured on the committed pool (appendix script A, every team seed):

| seeds | cards | prop legs | at the player's lowest rung | mean EV | mean `$100 PAYS` | tiers | best 2-leg payout |
|---|---|---|---|---|---|---|---|
| 32 | 320 | 1,280 | **1,280 (100 %)** | −16.0 % | +$25.7 | low: 320 | +$40 |

This is not DET-specific and not a data accident. The pool ladder starts at
19.5 for RB/WR and 124.5 for QB; 210 of 220 pooled players have their ladder
floor in support, so for almost everyone the "best" leg is "clears 20 yards".

The existing tests lock this behaviour rather than catch it:
`tests/feature/r76_myparlays_search.test.mjs` §5 asserts the beam equals
exhaustive enumeration *by conviction*, and §"the $100 figure" asserts
`card.ev < 0` for an all-prop card as intended behaviour.

### RC-N2 — the pool ladder's floor is far below every projection

`scripts/build_leg_pool.py` offers a rung whenever its z is inside the
calibration's support window (RB `[−0.96, 1.66]`, WR `[−0.95, 1.56]`, QB
`[−2.12, 1.44]`). The window is a *calibration* fact (where the model has been
measured), not a *betting* fact; z = +1.2 (Gibbs, 20+) is "in support" and
also a 88 % event no book would post at a usable price. Nothing in the pool
marks a rung as "too deep to be a bet".

### RC-N3 — two conventions for `$100 PAYS`

| surface | prop leg price | 2-prop example |
|---|---|---|
| MY (`scoreCard`) | our probability × 1.045 | Gibbs 20+ & Cook 30+ → **+$10** |
| slate (`build_review.leg_decimal` → `potential_return`) | −110 flat (1.9091), flagged "assumed" | Gibbs 60+ & St. Brown 60+ → **+$264** |

Both are labelled "display only", both call themselves `$100 PAYS`, and they
disagree by 25× on comparable cards. Neither is a price anyone offers for the
deep rungs; the −110 convention is at least the price books do offer for the
near-median lines the slate uses.

### RC-N4 — the same leg carries two probabilities

The pool is priced with its own calibration by design (R76: one coefficient
set could not serve both populations). The consequence is visible: 44 slate
prop legs also exist in the pool at the same line; 35 differ by more than 3
points, mean |gap| 6.0, max 15.7 (`D. Samuel 60+ rec yds` slate 37.3 % vs
pool 21.6 %; `J. Gibbs 60+` slate 45.6 % vs pool 49.4 %). A user who opens
GAME and then MY sees two MODEL numbers for one bet. R81's replay lab
measured the pool calibration as *worse* on QB legs (log-loss 0.79 vs 0.71),
which argues against letting the pool number stand beside the slate number.

### RC-N5 (latent) — the chained same-game correlation can print absurd EV

`combinedProbs` applies ρ between consecutive legs only and compounds the
adjustment on the running joint. It is order-dependent and, on many
fair-line legs, inflates the joint well past anything the independence
denominator can match. Appendix script B, DET, "one rung per player nearest
50 %": the 6-leg same-game card prints **conviction 13 %, EV +320 %,
`$100 PAYS` +$3,239**; the "nearest 65 %" dial prints EV +129 %. The slate
never builds more than 3 legs so this has never been on screen; any fix that
moves MY to fair-line legs will surface it immediately.

### RC-N6 — the 0.95 clamp and IMPL\* ≈ 99

`PROB_CLAMP = (0.05, 0.95)` in the pool and `PROB_EPS` in the app cap
`model_prob`; `impliedFromModel` then prints 98.9 % for a 94.6 % leg. A card
whose legs read "MODEL 95 · IMPL\* 99" is telling the user the model is
almost certain and the price is worse than certain. It is the honest output
of RC-N1 + the hold, and it should never be the headline of a product card.

## 4. Root causes — the spacing

Measured at 1395 × 704, dark, DET (appendix script C):

| fault | measurement | cause |
|---|---|---|
| **RC-L1** void inside the shorter card of a mixed row | **83 px** between the last leg and the footer on 5 of 10 cards | R82: `#mp-list` rows stretch and `.p-foot { margin-top: auto }` anchors the footer; a 2-leg card beside a 3-leg card inherits its 366 px height |
| **RC-L2** no rhythm inside the MY host | chips → legend **0 px**, legend → grid **0 px**, input → chips 8 px | `#myparlays-host` is one `.view` child; the 12 px `.view` gap never reaches its children, and only `.mp-seeds` has a one-sided 8 px margin |
| **RC-L3** rows mix leg counts | 3-up at 1395 px yields rows (2,2,3) (3,4,4) (5,5,6) (6) | the list is built as five pairs (two cards per leg count, `PER_COUNT = 2`); three columns split every pair across rows, so every row is a mixed-height row |

Row-bottom alignment (the R82 fix) holds: bottoms are level in every row.
The void is the cost of levelling a mixed row; RC-L3 is why every row is
mixed.

## 5. Regression baseline

Full gate on the untouched tree (`bash tests/run_gate.sh`, main `886b5bb`):

| step | result |
|---|---|
| 1 validate data contracts | PASS |
| 2 smoke selftests | PASS |
| 3 feature tests | PASS — 1,685 tests, 0 fail |
| 4 weekly split never-regress (R51) | PASS |
| 5 parlay never-regress (R51) | PASS |
| 6 K/DST weekly split never-regress (R55) | PASS |
| 7 leg-pool calibration never-regress (R76) | PASS |
| 8 browser E2E (web + pwa + perf) | PASS — 279 passed |

`GATE RESULT: PASS (green)`.

The gate is green because nothing above is a defect *against the tests as
written*; §3 names the tests that lock the degenerate behaviour.

## 5a. Status after the independent review (2026-09-17, later the same day)

An independent review reproduced every root cause above with its own probes
(`docs/reviews/2026-09-17/`) and added findings this RCA did not check
(`docs/qa/CODEX_REVIEW_R82_FOR_CLAUDE.md`). Its release R83–R85 (main
`5bf4399`) closed part of the numbers section and none of the spacing section:

| item | state after R83–R85 |
|---|---|
| RC-N1 rung selection | **open** — 1,280 of 1,280 prop legs still at the lowest rung; first DET card still 82 % · −9.1 % · +$10 |
| RC-N2 ladder floor | open (unchanged) |
| RC-N3 two `$100 PAYS` conventions | **closed** — one shared simulation (`app/parlay-simulation.js`) on every surface, labelled `$100 SIM NET`; review money is re-derived in memory from each card's own comparison prices |
| RC-N4 two probabilities per leg | open (unchanged) |
| RC-N5 correlation chain | **contained** — pairs clamped to both Fréchet bounds, more than two legs in one game refused, mixed cards grouped by game (review F01–F03) |
| RC-N6 clamp / IMPL\* 99 | open, now labelled as an assumed comparison |
| RC-L1 83 px void | **open** — still 83 px on 5 of 10 cards at 1395 px; footer grew from 32 px to 84 px |
| RC-L2 0 px host rhythm | open |
| RC-L3 3-up splits the pairs | open |

Owner decision on §6 Q1: **option B** (one rung per player at a risk dial,
EVEN ≈ 50 % by default, ranked by model hit chance within the dial), because
legs near 50 % are where the model's calibrated skill lives and where resolved
outcomes inform the weekly refits; a 90 % leg teaches the loop nothing. Built
as R86 with the RC-L1..L3 fixes. Recording the cards MY offers (so the
learning loop can grade them) is the follow-up, since it needs a pipeline
step.

## 6. Options, rated (risk · LOE · recommendation)

### Q1 — the objective (fixes RC-N1, RC-N2, RC-N6)

* **A. One rung per player at a risk dial, ranked by EV among fair-priced
  legs (Recommended).** Before the search, keep one rung per player: the rung
  whose model probability is nearest a dial the user picks (SAFE ≈ 65 %,
  EVEN ≈ 50 %, LONGSHOT ≈ 35 %; default EVEN). Rank cards by EV where a
  book price exists and by conviction only to break ties. Cards then look
  like the slate's, `$100 PAYS` becomes meaningful, and the ladder stays a
  ladder. Risk: medium (new selection rule; the search tests in
  `r76_myparlays_search` change meaning). LOE: 1 day incl. tests. Requires
  Q3-A or the same-game EV blow-up appears on day one.
* **B. One rung per player nearest the projection (the slate's shape), keep
  conviction ranking.** Simplest; matches the slate visually. But conviction
  ranking then prefers heavy-favourite moneylines over any prop (measured:
  the 2-leg card becomes `J. Goff 200+ & SF ML`), so seeds get crowded out by
  game legs. Risk: low. LOE: 0.5 day. Not recommended alone.
* **C. Keep conviction ranking; mark deep rungs.** Add a "LOCK" band and a
  note that the card is a probability, not a bet. Honest, cheap, and leaves
  the product answering a question nobody asked. LOE: 0.25 day. Not
  recommended.

### Q2 — one `$100 PAYS` convention (fixes RC-N3)

* **A. Adopt the slate's convention in MY (Recommended).** Props at −110
  flagged "assumed", game legs at the book price, via one shared function
  (port `leg_decimal` to `app/parlay-math.js` and use it in `scoreCard`;
  keep `impliedFromModel` for EV only). The two tabs then agree on money for
  identical legs. Risk: low. LOE: 0.5 day incl. a parity test.
* **B. Adopt MY's convention in the slate.** Changes the archived P&L
  arithmetic R73–R75 locked; the review money on graded weeks would move.
  Risk: high. Not recommended.

### Q3 — the correlation chain (RC-N5)

* **A. Cap same-game MY cards at 3 legs and clamp the combined adjustment
  (Recommended).** The slate's regime is 2–3 legs; hold MY to it until the
  chain is measured. Add a replay-lab variant that scores the chained joint
  against resolved same-game parlays before allowing 4+. Risk: low. LOE:
  0.5 day plus a replay-lab variant (measure only).
* **B. Leave it.** Only safe if Q1-C is chosen.

### Q4 — one probability per leg (RC-N4)

* **A. Show the slate's number where the slate prices the leg; pool number
  elsewhere, labelled.** Cheapest honest option. LOE: 0.25 day.
* **B. Re-run the R76 never-regress with the slate calibration on the pool
  population after week 3 (Sep 29) and adopt one calibration.** The right
  long-term answer; needs the data. LOE: 1 day, after Sep 29.
* Recommendation: A now, B after Sep 29.

### Q5 — the layout (RC-L1..L3)

* **A. Two columns on desktop, one leg-count band per row, 12 px rhythm in
  the host (Recommended).** `#mp-list { grid-template-columns: repeat(2, 1fr) }`
  at ≥ 820 px puts each pair on its own row, so equal heights come free and
  the void disappears; drop `margin-top:auto`; a band eyebrow ("2 LEGS",
  "3 LEGS") spanning the row, reusing `.slate-day`; `#myparlays-host
  { display:flex; flex-direction:column; gap:12px }`. Risk: low. LOE: 0.5
  day incl. updating `r82_myparlays_layout` (row bottoms still equal; void
  ≤ 12 px; band count 5).
* **B. Keep 3-up, drop the stretch.** Removes the void, brings back ragged
  bottoms. Not recommended.

## 7. Proposed acceptance tests (to be written with the fix)

1. For every team seed, no prop leg on a MY card is the player's lowest rung
   unless it is also the rung nearest the dial (feature test over the
   committed pool).
2. Two MY cards containing the same legs as a slate card print the same
   `$100 PAYS` (parity test between `scoreCard` and `build_review`).
3. No MY card prints EV > +100 %; same-game MY cards have ≤ 3 legs.
4. A leg present on both surfaces shows one MODEL number (or a labelled pool
   number).
5. Layout at 402 × 874 and 1280 × 900 and 1395 × 704: void between last leg
   and footer ≤ 12 px on every card; chips→legend and legend→grid gaps =
   12 px; five band eyebrows; row bottoms equal within 1 px.

## Appendix — reproduction scripts

Run from the repo root with Node 22 (no dependencies beyond the repo).

### A. Every DET card, then every team seed

```js
// node repro_numbers.mjs
import { readFileSync } from 'node:fs';
import { poolLegs, buildCards, seedOptions } from './app/views/myparlays.js';
import { correlationTable } from './app/parlay-math.js';
const pool = JSON.parse(readFileSync('data/leg_pool.json', 'utf8'));
const calib = JSON.parse(readFileSync('data/parlay_backtest.json', 'utf8'));
const table = correlationTable(calib);
const legs = poolLegs(pool);
const lowest = new Map();
for (const l of legs) if (l.owner && l.line != null) lowest.set(l.owner, Math.min(lowest.get(l.owner) ?? Infinity, Number(l.line)));
function report(seedName) {
  const cards = buildCards(legs, [{ kind: 'team', id: `team:${seedName}`, name: seedName }], table);
  return cards.map((c) => {
    const props = c.legs.filter((l) => !l.priced);
    return { n: c.legs.length, conviction: +(c.model * 100).toFixed(1), ev: +(c.ev * 100).toFixed(1),
      payout: Math.round(c.payout), tier: c.tier, props: props.length,
      atLowest: props.filter((l) => Number(l.line) === lowest.get(l.owner)).length,
      legs: c.legs.map((l) => `${l.selection} [mu ${l.mu} line ${l.line} model ${(l.model_prob * 100).toFixed(1)} impl ${(l.implied_prob * 100).toFixed(1)}]`) };
  });
}
for (const c of report('DET')) console.log(JSON.stringify(c));
let cards = 0, props = 0, atLow = 0, ev = 0, pay = 0; const tiers = {};
for (const t of seedOptions(pool).filter((s) => s.kind === 'team')) {
  for (const c of report(t.name)) { cards++; props += c.props; atLow += c.atLowest; ev += c.ev; pay += c.payout; tiers[c.tier] = (tiers[c.tier] || 0) + 1; }
}
console.log({ cards, props, atLow, pctAtLowest: 100 * atLow / props, meanEv: ev / cards, meanPayout: pay / cards, tiers });
```

Output on `886b5bb`: `{ cards: 320, props: 1280, atLow: 1280, pctAtLowest: 100, meanEv: -15.96, meanPayout: 25.7, tiers: { low: 320 } }`.

### B. Alternative rung policies (sizes the options; exposes RC-N5)

```js
// node repro_policies.mjs
import { readFileSync } from 'node:fs';
import { poolLegs, buildCards } from './app/views/myparlays.js';
import { correlationTable } from './app/parlay-math.js';
const pool = JSON.parse(readFileSync('data/leg_pool.json', 'utf8'));
const table = correlationTable(JSON.parse(readFileSync('data/parlay_backtest.json', 'utf8')));
const all = poolLegs(pool);
const seeds = [{ kind: 'team', id: 'team:DET', name: 'DET' }];
function oneRungPer(legs, pick) {
  const by = new Map();
  for (const l of legs) { if (l.priced) continue; (by.get(l.owner) || by.set(l.owner, []).get(l.owner)).push(l); }
  return legs.filter((l) => l.priced).concat([...by.values()].map(pick));
}
const nearest = (target) => (arr) => arr.reduce((b, l) => Math.abs(l.model_prob - target) < Math.abs(b.model_prob - target) ? l : b);
const policies = {
  shipped: all,
  nearestProjection: oneRungPer(all, (arr) => arr.reduce((b, l) => Math.abs(l.line - l.mu) < Math.abs(b.line - b.mu) ? l : b)),
  nearest50: oneRungPer(all, nearest(0.5)),
  nearest65: oneRungPer(all, nearest(0.65)),
};
for (const [name, legs] of Object.entries(policies)) {
  const cards = buildCards(legs, seeds, table);
  for (const n of [2, 6]) {
    const c = cards.find((x) => x.legs.length === n);
    console.log(name, n, c && `conv ${(c.model * 100).toFixed(0)} ev ${(c.ev * 100).toFixed(1)}% pays $${Math.round(c.payout)} :: ${c.legs.map((l) => l.selection).join(' + ')}`);
  }
}
```

Output on `886b5bb` (abridged): `shipped 2 → conv 82 ev −9.2 % pays $10`;
`nearest50 6 → conv 13 ev +320.5 % pays $3239` (same game);
`nearest65 6 → conv 22 ev +128.8 % pays $958`.

### C. Spacing at 1395 × 704, dark

Serve the repo (`python3 -m http.server 4399`), then with Playwright: seed
`localStorage nfl2026.unlock.v1 = '1'`, open `#/parlays`, click
`.scopeseg [data-seg="my"]`, fill `#mp-input` with `DET`, press Enter, and
read for every `.mp-card`: `foot.top − legs.bottom` (the void), and for
`#myparlays-host` children the gaps between consecutive bounding boxes.
Measured: void 83 px on cards 1, 2, 4, 7, 8; 12 px on the rest; chips→legend
0 px; legend→grid 0 px; grid columns `429 429 429`.

### D. Slate vs pool probability on identical legs

```python
import json
pool = json.load(open('data/leg_pool.json')); slate = json.load(open('data/parlays.json'))
pb = {g['selection']: g['model_prob'] for r in pool['players'] for g in r['rungs']}
seen, gaps = set(), []
for c in slate['parlays']:
    for l in c['legs']:
        s = l['selection']
        if s in seen or s not in pb: continue
        seen.add(s); gaps.append((abs(l['model_prob'] - pb[s]), s, l['model_prob'], pb[s]))
gaps.sort(reverse=True)
print(len(gaps), sum(g[0] for g in gaps) / len(gaps), gaps[:3])
```

Output on `886b5bb`: 44 shared legs, mean |gap| 0.0598, max 0.1569
(`D. Samuel 60+ rec yds` 0.373 vs 0.216).
