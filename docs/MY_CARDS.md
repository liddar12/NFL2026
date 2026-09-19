# MY cards: recording and grading what MY PARLAYS offered (R87)

MY PARLAYS builds its cards in the browser. You type a player or a team,
`app/views/myparlays.js` searches the leg pool, and ten cards appear — each with a
CONVICTION number, a simulated EV and a $100 payout. Then you close the tab and
every one of them is gone.

That was the problem R87 fixes. Game parlays and week parlays are written to
`data/parlays.json`, archived per week under `data/parlays/`, locked leg-by-leg in
the R58 ledger and graded against what happened. MY cards — the surface that
produces by far the most cards — were never written down, so they were never
graded, and the only number on screen was the view's own confidence in itself.
Nothing could learn from them, and nothing could contradict them.

Three pieces close that loop, and they are deliberately the same three the slate
already has: a pure model, a first-sight record, and a resolver.

---

## 1. The pure model — `scripts/models/my_cards.py`

An exact Python mirror of the browser's selection: `pool_legs`, `dial_legs`,
`upcoming_legs`, `matches_seed`, `compatible`, `conviction`, `score_card`,
`build_cards`, `seed_options`, plus `DIALS` (SAFE 0.65 / EVEN 0.50 / LONGSHOT
0.35), `GAME_LEG_BAND` 0.15 and `STAKE` 100.

A second implementation of a model is a liability unless something forces the two
to agree, and a *selection* is a chain of tie-breaks — any one of them drifting
produces a plausible-looking card nobody was offered:

| what drifts | what it would cost |
|---|---|
| rounding | `parlay_builder.make_leg` rounds to 4dp, the browser does not round at all. The port never calls it: `legFromPool`'s clamp is reproduced, and 4dp rounding happens once, when a card is written |
| operation order | floating-point multiplication is not associative, so `implied` is the running product over legs in card order and `model` is the product over GAME GROUPS in insertion order (`parlay_builder.combined_game_probs`, added public for this) |
| sort stability | JS `Array.sort` and Python `sorted` are both stable, so the same key gives the same order — ties included, and a tie decides which of two equally-convicted cards is offered |
| the dial's tie-break | nearest rung to the target, ties to the HIGHER line; the game-leg band is INCLUSIVE to 1e-9 (`abs(p - t) - 0.15 <= 1e-9`), because `|0.65 - 0.50|` evaluates to `0.15000000000000002` |
| de-dupe | the key is the selections sorted and joined by `|` on both sides |

**The proof is `tests/feature/r87_my_cards_parity.test.mjs`.** Both sides run the
whole pipeline — `poolLegs -> upcomingLegs -> dialLegs -> buildCards` — over the
toy pool from R76 and over the COMMITTED `data/leg_pool.json` with `now` pinned to
the pool's own `generated_utc`, against the committed schedule. Every team seed at
EVEN, sampled seeds at SAFE and LONGSHOT, sampled player seeds at EVEN. Number of
cards, ordered selections, `model`, `implied`, `ev`, `tier`, `payout`, `same_game`
and `mixed_game` must agree to **1e-9**. It runs in about 23 s.

The only place the port differs in FORM (never in result): the JS sorts partial
cards with a comparator that recomputes conviction per comparison; Python sorts on
a precomputed key. Both are stable sorts on the same number, and the key form is
what keeps a 32-seed sweep inside a pipeline step's budget.

## 2. The record — `scripts/build_my_cards.py`

Writes `data/my_cards/<season>_wk<NN>.json` (contract
`data/contracts/my_cards.schema.json`).

| rule | what it means |
|---|---|
| **key** | `(dial, seed, sorted selections)`. Leg ORDER is not part of it — the same set of legs reached by a different beam path is one card, which is exactly the de-dupe the search itself applies. `card_id` is the first 12 hex of its sha1 |
| **first sight locks** | the first run that sees a key appends it with its as-made numbers (`model`, `implied`, `ev`, `tier`, `payout`, `assumed`, and every leg's own `model_prob` / `implied_prob` / `line` / `mu`) and no later run ever touches that entry |
| **pre-kickoff only** | `locked: true` only when the first sight (`pool_generated_utc`) precedes the EARLIEST kickoff among the card's legs. Only locked cards are graded. One leg with an unreadable kickoff makes the whole card unlockable — a card is offered as one bet, so its exposure starts at its first leg |
| **idempotent per pool** | the as-of is `data/leg_pool.json`'s `generated_utc`; `runs` records each as-of once and a second run on the same pool writes no bytes at all |
| **as at the moment offered** | the cards are rebuilt at `now = pool_generated_utc` against the committed schedule, so the record is of what the view would have shown then, not of what it would show now |

`rank` is the card's position (1..10) in the ten offered for that seed and dial, at
first sight.

### The limits, stated plainly

* **Team seeds only.** A viewer can type any of the ~220 players in the pool, and
  recording every one of those card sets would be a record of combinations nobody
  asked for. The recorded universe is **every team seed at every dial**, which
  reaches every game on the slate and every player the pool can price through his
  team. A player-seeded card is not in this record and is not graded.
* **The stored `model` is the browser's number rounded to 4dp.** The parity proof
  above is on the pure module, *before* rounding; the file is a record, and 4dp is
  the precision the slate ledger already uses.
* **`locked` is true for every card in practice.** `upcoming_legs` admits only
  games that have not kicked off at `now`, so a recorded card cannot contain a
  started game. The flag and the check are written anyway: a record that asserts a
  property it never checks is not a record, and `--selftest` exercises both sides.
* **`implied_prob` is display and the terms of the bet.** It is on the card because
  the card showed it. It reaches no model probability, here or anywhere.

## 3. The resolver — `scripts/resolve_my_cards.py`

Writes `data/my_card_scores.json` (OPTIONAL feed, contract
`data/contracts/my_card_scores.schema.json`).

* **Prop legs** resolve against nflverse `stats_player_week_<season>.csv`, the same
  release `scripts/resolve_estimates.py` reads. `index_stats`, `find_player`,
  `split_abbrev`, `load_finals` and `read_csv` are **imported** from
  `scripts/resolve_parlay_legs.py` and `fetch_csv` from `scripts/resolve_estimates.py`
  — never copied, so the join cannot drift between the two records. `hit` = the
  market's yards `>=` the recorded line. The candidate set is restricted to the
  leg's own recorded team: the man on the card is the man on that roster.
* **Game legs** resolve against FINAL results through the same layered
  `load_finals` the leg resolver uses (a `--finals` file wins outright; otherwise
  lock receipts, `data/review.json` and ESPN live merge, and `finals_source` names
  exactly what contributed). Moneyline grades on the winner. Spread grades on the
  margin against the handicap its **selection** states (`TB -8.5` — the terms of
  the bet as displayed, parsed with the R58 ledger's own regex). A tie or an exact
  push is a **void** leg, never a miss.
* **The card's verdict**: pending if any leg is pending, miss if any leg missed,
  void if something voided and nothing missed, hit only when every leg hit — the
  rule `build_review.review_parlay` applies to a slate parlay. `bucket` comes from
  `build_review.parlay_bucket`, so the five buckets mean the same thing everywhere.
* **Money**: `build_review.parlay_money` settles a flat $100 on each graded card at
  a price index built from **the card's own recorded `implied_prob`**. A prop has
  no book feed, so it falls to the -110 assumption `build_review` applies
  everywhere, and `assumed_price_legs` says how many did. Display-only, never an
  input.
* **Output**: per week, the counts, the five buckets, and a block per **dial** and
  per **leg count** — `n`, `graded`, `all_hit`, `hit_rate`, `mean_model`,
  `log_loss`, `brier`, `staked`, `net_fair`, `net_vig2`, `roi_fair`. `log_loss` and
  `brier` score the card's recorded `model` against whether the whole card hit
  (1/0) over the graded cards.

**Honesty rules, which are the point of the file**

* An unresolved leg is **pending, never a miss**. No stats rows for the week, no
  stat line for the player, an unreadable handicap: all pending, with the reason.
* With **no graded card every metric is null, never 0**. A hit rate of 0.0 says we
  measured and nothing hit; null says we have not measured. That is the committed
  state today: 900 cards recorded for week 2, 900 locked, 0 graded,
  `weeks_resolved: 0`, `skipped: "offline run: stats not fetched"`.
* `cards[]` holds the **graded** cards. A pending card has no outcome to record and
  the complete record of what was offered is `data/my_cards/`; putting ~900 pending
  rows a week into an app-reachable feed would cost the reader megabytes to learn
  nothing.

CLI, mirroring the leg resolver: `--season`, `--cache-dir`, `--offline` (write the
honest skip), `--dry-run-with <csv>`, `--finals <json>`, `--out`, `--selftest`.

## 4. The RECORD line in the app

`app/views/myparlays.js` exports a pure `renderRecord(scores, dial)` and paints one
line under the legend, for the CURRENT dial, from the LATEST week that has graded
cards:

```
RECORD · WK 2 · EVEN · 320 cards graded · 41 all hit (12.8%) · mean conviction 14.1% · $100 flat net −$1,240
```

It re-renders when the dial changes (SAFE, EVEN and LONGSHOT are different
populations of cards, and showing one dial's record under another's chip would be
a lie with no visible symptom). It reuses `.legend` / `.legend-item` / `.est`, so
it costs no CSS; `.mp-record` is a handle, not a style. **A week with nothing
graded, a null metric, a 404 or any other failure renders nothing at all** — the
honest state of a season that has not been played is an absent line, not a zero.
Locked by `tests/feature/r87_my_cards_record.test.mjs`.

## 5. Contracts, the gate and the pipeline

* `data/contracts/my_cards.schema.json` — the offered cards (strict: every field
  declared, `locked` / `priced` / `same_game` real booleans, dial, tier, market,
  position, side, team and price source enumerated).
* `data/contracts/my_card_scores.schema.json` — the scores (strict; `result` on a
  listed card may only be `hit` / `miss` / `void`, so a pending card can never
  appear as a graded one; every metric is `number|null`).
* `scripts/validate_data.py` routes `data/my_cards/<season>_wk<NN>.json` to the
  cards contract (the way it already walks `data/parlays/`) and registers
  `my_card_scores.json` as OPTIONAL. Its `--selftest` reds both contracts: a string
  `locked` flag, an invented dial, a >1 leg probability, an undeclared leg field, a
  seed kind that is not swept, a string hit rate, a pending card in the graded list
  and a missing leg-count block.
* `tests/smoke.sh` runs both `--selftest`s beside the R58 pair.
* Daily pipeline order:

```
build_leg_pool -> build_my_cards (record the offered cards; idempotent per pool)
  -> ... -> build_parlay_ledger -> resolve_parlay_legs
  -> resolve_my_cards (grade the locked cards; continue-on-error)
  -> replay_lab -> build_review -> validate_data -> commit
```

`build_my_cards` runs immediately after the pool it reads; `resolve_my_cards` runs
immediately after the leg resolver, so both records are scored against the same
nflverse release (the fetch cache is shared by import) and the same finals on the
same day. `gameday.yml` carries the same two commands.
