# Parlay history: the per-week archive and the flat-stake P&L (R73)

`data/parlays.json` holds ONE week and is overwritten on every pipeline run, so
until R73 the cards of a finished week were gone the moment the builder moved on.
R73 keeps every week (owner decision 1), fixes which week PARLAYS opens on
(decision 2), and prices a finished week's cards at a flat $100 stake, in the
pipeline, display-only (decision 3). One new script, one new directory, two new
contracts, one new block in `data/review.json`.

Owner policy, restated because money and book prices appear here: a market price
is DISPLAYED, never an input. The P&L below reads the book's as-made price off the
R58 ledger to price a card after the fact; nothing downstream reads the result.

## 1. The archive — `scripts/build_parlay_archive.py`

Writes `data/parlays/<season>_wk<NN>.json` (contract
`data/contracts/parlays_archive.schema.json`) and `data/parlays/index.json`
(`parlays_index.schema.json`). Canonical JSON (`ensure_ascii=True`, `indent=2`,
trailing newline).

| rule | what it means |
|---|---|
| verbatim | the archive is `parlays.json` as shipped — `season`, `week`, `updated_utc`, `parlays[]` (the same leg contract: `market`, `selection`, `implied_prob`, `model_prob`, optional `edge_note` / prop provenance) — plus `archived_utc`, `closed`, `history`. Nothing is re-derived or re-priced |
| first sight creates | the first run that sees a week in `parlays.json` writes its file |
| refreshed while open | every later run rewrites the file with the current `parlays.json` while the week is open, so it ends as the LAST priced state before close. The as-made price of every leg (the one the P&L uses) lives in the R58 leg ledger `data/estimates/parlays_<season>.json`, locked on first sight — the archive is the cards, the ledger is the prices |
| closed | every game of the week carries a FINAL status in `data/schedule_full.json` (`scripts.scrape.espn.FINAL_STATUSES` — the STATUS-gate every builder uses). A week with no schedule rows is never closed. Every open archive is re-checked on every run, whichever week `parlays.json` holds, and flips to `closed: true` (content untouched) when its last game goes FINAL |
| never rewritten once closed | a later `parlays.json` for a closed week (a post-close reprice) is an idempotent no-op with a printed line: `parlay_archive: wk N is closed — data/parlays/... not rewritten` |
| no churn | an unchanged week (same `updated_utc`, same `closed`) is not rewritten; the index is rewritten only when an entry changes (`generated_utc` alone is not a change). The crons commit after every run, so a byte-identical archive keeps their diffs to real changes |
| history | one `{updated_utc, archived_utc}` per DISTINCT `parlays.json` `updated_utc` the archive saw for the week, in the order seen, plus `frozen` (a count) when that refresh carried frozen cards. A repricing leaves a trace even though only the last state is kept |
| index | `{season, generated_utc, current_week, weeks[]}`, `weeks` sorted ascending, each `{week, path, updated_utc, archived_utc, closed, n_parlays, n_week_scope, n_game_scope}`; `path` is repo-relative (`data/parlays/2026_wk01.json` — prefix `/` to fetch from the PWA root, as `app/data.js` does for `/data/parlays.json`) |

`--selftest` runs the whole lifecycle on `tests/fixtures/r73/` in a temp
directory and never writes `data/`; `--dry-run` prints the plan and writes
nothing. `--data`, `--parlays`, `--schedule`, `--ledger` and `--now` exist so the
tests can drive it against a temp data dir.

## 1a. Card freeze (R90)

"Refreshed while open" was too coarse. A week stayed mutable until its LAST game
ended, so a Thursday card could be rewritten on Friday — after Thursday's result
was known — and `history` kept timestamps, not compositions. Same-game ids are
built from rank (`<game_id>-g1`) and weekly ids from leg-count/rank, so the same
`parlay_id` can name a different bet after a rebuild. A pre-kickoff LEG ledger
proves a leg's price; it does not prove that a particular COMBINATION was offered.

R90 freezes **card by card**, each at its own kickoff. Two keys, and they are the
only things this script adds to a card:

| key | rule |
|---|---|
| `card_id` | short sha1 (12 hex) of the card's canonical ordered leg identity: `scope`, `game_id` when it has one, and the card's legs as sorted `market\|selection` lines. Reordering legs yields the SAME id; changing, adding or dropping a leg yields a new one. `parlay_id` is deliberately NOT part of it — it carries the rank, and a rank is not a bet. `parlay_id` stays exactly as it was, for display and for the review join |
| `frozen_utc` | stamped on the first refresh at or after the card's EARLIEST relevant kickoff. A game card: its own game. A week card: the earliest kickoff among the games its legs name — the team a selection starts with, through `schedule_full.json`; a PROP selection names a player, so its game comes from the R58 leg ledger `(week, market, selection) -> game_id`. A card that cannot be placed is never frozen: absent is unknown, not started |

What a refresh of an open week now does:

* a frozen card is carried forward **verbatim**. The rebuild may neither replace
  nor remove it;
* an incoming card whose `card_id` matches a frozen one is dropped — that bet is
  already on the record;
* an incoming card for the same game with a DIFFERENT `card_id` is **appended** as
  a new card, so a rank change adds a card instead of overwriting one (and if its
  own game is already under way it is stamped frozen as it lands, which makes the
  result a fixed point: the next run over the same inputs writes zero bytes);
* cards for games that have not kicked off replace their live predecessors exactly
  as before;
* `parlays[]` is the union: the carried-forward frozen cards first, in their
  archived order, then the incoming cards in build order;
* `history[-1].frozen` counts the frozen cards in that refresh;
* the week still closes when every game is FINAL, and a closed week is still never
  rewritten.

**`parlay_id` uniqueness (G03).** Appending a rank-named card next to a frozen one
carrying the SAME name was F12 surviving R90 — R90 added a second id instead of
retiring the first. On the committed week-2 archive, one post-kickoff rebuild whose
pool no longer offers the DET/BUF legs produced **17** `parlay_id`s carried by two
cards each (`week-2leg-1` = `SF ML + BUF ML` frozen, and `SF ML` live), and every
consumer builds a Map on that id — `scripts/build_review.py`, `app/review.js` — so
one bet's bucket, money and review row were applied to the other, decided by array
order. An incoming card whose `parlay_id` is already taken is now **renamed**
`<parlay_id>~<first 6 of card_id>`: derived from the card's own identity, so the
name is the same on every run and a second pass writes the same bytes. **Frozen
cards are never renamed** — verbatim is the older promise, so the 13 pairs already
frozen on disk before this rule existed keep their shared rank id and are the only
duplicates left. The identity is also the join key now: `build_review` stamps
`card_id` on every reviewed parlay row (imported from this writer, never re-hashed)
and `app/review.js` keys every map by `card_id` when a card has one and by
`parlay_id` only for a pre-R90 archive. Locks:
`tests/feature/r90_card_freeze.test.mjs` (the reproduction above, 17 → 0 introduced,
ten rebuilds stable) and the two builders' `--selftest`s.

**Upgrade.** An archive written before R90 has no `card_id`, which the contract now
requires. The first run after R90 stamps it on every card of every archive of the
season — closed weeks included — and touches nothing else: not `archived_utc`, not
`history`, not the cards' own fields. The id is derived from the card already on
disk, so this decides nothing; the printed line is
`parlay_archive: wk N upgraded data/parlays/... (card_id stamped on M card(s);
nothing else touched)`. It happens once.

**Consumers.** `scripts/replay_lab.py` (`replay_parlays`) still joins archived cards
by `parlay_id` and their legs and ignores unknown keys — verified by
`replay_lab.py --selftest`. `scripts/build_review.py` and `app/review.js` join on
`card_id` (see G03 above), falling back to `parlay_id` only where a card has no
identity to join on.

**Committed today (backfill).** The script was run once against the committed
`data/parlays.json`, which at `origin/main 7d19080` is week 1 at its
`2026-09-14T19:46:26Z` repricing (the 16:44:55Z reprice was the previous commit,
703dc0e, and is superseded — an archive only ever holds the state on disk when it
runs). `data/parlays/2026_wk01.json`: 66 parlays (18 week-scope, 48 game-scope),
`closed: false` — one week-1 game (KC-DEN, 401872931) was still `STATUS_SCHEDULED`
at that schedule — one history entry. `data/parlays/index.json`: `current_week 1`,
one entry.

## 2. The default week (owner decision 2)

PARLAYS opens on the pipeline's week: the week `data/parlays.json` holds, which
`scripts/build_predictions.py` chooses with **`current_week(schedule)`** — *the
earliest week on the schedule not entirely FINAL* (every game of the week must be
FINAL for the slate to move on; `max(by_week)` once everything is). The archive
index carries the same number as `current_week`, so the view can open there and
list the other archived weeks from `weeks[]`. Note this is NOT
`build_review.pipeline_week` (which moves one week on as soon as the current week
is underway, so the review can carry the on-deck block): the parlays default is
the stricter rule, exactly as `parlays.json` is built.

## 3. The P&L — `data/review.json` → `weeks[w].summary.parlays.stake_100`

Computed by `scripts/build_review.stake_100` (pure; wired through `summarize`)
over the reviewed parlay rows of the week and the R58 ledger prices. One block per
scope, `{"week": {...}, "game": {...}}`, each:

| key | definition |
|---|---|
| `n` | parlays of the scope in the week |
| `graded` | `n` minus the `pending` bucket — only these are staked |
| `hit` | graded parlays in the `all_hit` bucket (paid) |
| `push` | graded parlays in the `push` bucket (pushed legs at 1.0) |
| `staked` | `100 × graded` |
| `net_fair` | sum over graded of `100 × (∏ leg decimals − 1)` for `all_hit`; the same with every void leg dropped out at 1.0 for `push`; `−100` for `partial` / `all_missed`. Null (never 0) when nothing is graded |
| `net_vig2` | `net_fair` with every leg re-priced at `implied_prob × 1.02`, capped at 0.99 |
| `assumed_price_legs` | legs of the graded parlays that carry no book price and were priced at 1.9091 (−110) |
| `note` | the rule and the counts in one sentence |

Leg decimal = `1 / implied_prob` of the R58 ledger row keyed
`(week, game_id, market, selection)` — the as-made price locked on first sight,
never the current `parlays.json` price. Only moneyline / spread legs ever carry a
book price (`parlay_builder.make_leg`: a prop's `implied_prob` is `model_prob`
re-vigged by the standard hold — no book line exists for it), so a prop leg, a
game leg the ledger never saw, or a leg whose game is unidentified is assumed at
−110 and counted. Rounded to 2 decimals at the block. The R73 fixture
(`tests/fixtures/r73/stake_fixture.json`) pins every case: 2.0 × 4.0 all-hit →
+700; a push with the spread void → +100; partial → −100; pending excluded
(counted in `n` only); ML × assumed prop → +281.82; a 0.995 favourite +0.50 fair
and +1.01 at the 0.99 cap.

**Committed week 1 (2026-09-14, from the runner-path regeneration):**

```
week: n 18, graded 18, hit 16, push 0, staked 1800.00, net_fair 11563.91, net_vig2 10200.20, assumed 0
game: n 48, graded 34, hit 13, push 0, staked 3400.00, net_fair   818.33, net_vig2   654.52, assumed 49
```

The week-scope number is what it is: sixteen of eighteen all-favourite ML cards
hit (a 7-leg card at 1.279 × 1.521 × 1.901 × 1.656 × 1.606 × 1.385 × 1.551 pays
+2012.76 on its own). Every week-scope leg was priced off a ledger row; all 49
assumed legs are game-scope props (11 QB, 20 RB, 18 WR). Week 2 has no parlays on
file and reports `n 0, staked 0.0, net null`.

Money is display-only: `stake_100` is not read by any builder, refit, ranking or
parlay probability, and `validate_data.py`'s market-independence checks are
unchanged. The schema description says so.

## 4. What the UI renders (partition U)

* PARLAYS opens on `index.current_week` (= `parlays.json` week, decision 2) and
  offers the other `index.weeks[]` — label `Week N`, `closed` weeks marked as
  finished, open ones as live.
* A past week fetches its `path` and renders the archived cards exactly as the
  live week does (same leg contract), with the R72 outcome bucket per card from
  `review.json weeks[w].parlays[]` (`parlay_id` join), and the week's
  `summary.parlays.stake_100` as one P&L line per scope: staked / net_fair /
  net_vig2, the `push` and `assumed_price_legs` counts, and the `note` as the
  explainer — labelled display-only. `net_*` null renders as "—", never 0.
* `history[]` (the reprice trail) and `archived_utc` are available for a "priced
  as of" caption; `updated_utc` is the state shown.

## 5. Wiring

`scripts/build_parlay_archive.py` runs in `daily.yml` and `gameday.yml` right
after `python -m scripts.build_predictions` (which writes the `parlays.json` it
archives) and before the parlay ledger append — so the ledger it reads for the
R90 freeze is the PREVIOUS run's. A prop leg seen for the first time this run is
therefore unplaceable and does not freeze its card by itself; the card's game and
team legs still place it, and the next run sees the ledger row. That is the safe
direction: a card is frozen only when its kickoff can be proved; `smoke.sh` runs its `--selftest`;
`pipeline_wiring.test.mjs` lists it in `WIRED_BUILDERS`. `validate_data.py`
registers `parlays/index.json` (OPTIONAL, strict when present) and walks
`data/parlays/*_wk*.json` against the archive contract.

Tests: `tests/feature/r73_parlay_archive.test.mjs` (lifecycle, P&L math,
committed data, gates); `r71_review.test.mjs`'s strict `deepEqual` on
`summary.parlays` was extended by the one new key;
`tests/feature/r90_card_freeze.test.mjs` (R90: the identity, the Thursday freeze,
the Friday rank change, the ledger placing a prop, the old-shape upgrade,
idempotence, the committed archives).
