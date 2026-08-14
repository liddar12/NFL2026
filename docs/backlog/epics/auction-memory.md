# EPIC — AUCTION MEMORY: observed sale prices that survive the draft

**Filed:** 2026-08-14, from the owner. **Status:** backlog, not started.
**One line:** the room already records who bought each player and for how much;
it throws that away when the auction ends, so it re-learns your league from
scratch every single time.

---

## 1. What already exists (do NOT rebuild it)

The owner's request was "after you press TAKE you have to select the team the
player is going to and how much they spent". Most of that shipped in R27, and
building it again would be duplicated work:

| capability | where | state |
|---|---|---|
| Row action to record a sale | `draftActionBtn()` — **TOOK** in LIVE | shipped R27 |
| Pick the buying team | `.auc-soldteam`, built from `buyerOptions()` so a full roster is not offered | shipped |
| Type the real price | `.auc-soldprice`, typed; `−`/`+` seed and nudge | shipped R27 |
| Apply it exactly | `sellTo(a, teamIdx, price, boardIdx)` — decrements that team's budget, logs it, clamps to `maxBid()` | shipped |
| Learn from it, in-room | `tendencyUpdate(current, paid, market)` per team per position; skipped for my own buys | shipped |
| Feed BEST FIT | the room's `fair` map + `maxBid()` ceiling | shipped R27 |

Verified end to end: recording T3 at $47 leaves them at $153 and moves their
`maxBid` to $142.

## 2. The actual gap

`app/mocks.js`:

```js
export function recordAuction(auction, result, myPlayers, nowIso) {
  return normalizeRecord({ /* … */ observed: [] });   // hardcoded
}
```

and its comment: *"Auctions have no pick order, so they carry NO observed pick
log and never calibrate ADP drift."*

That reasoning is sound for **ADP drift** — an auction genuinely has no pick
order to calibrate against. But it silently threw away the thing an auction
*does* produce and a snake draft does not: **a price per player per buyer**.

Consequences, in order of how much they cost the owner:

1. **Opponent tendencies start empty at every auction.** `createAuction` builds
   `tendencies: {}` for all teams. Everything the room learned about how your
   league-mates bid — the whole point of recording sales — dies with the room.
   The second auction against the same ten people knows exactly as much as the
   first.
2. **No cross-draft price record.** `data/adp.json` carries ESPN's
   `auctionValueAverage`, which is the *market's* price, not *your league's*.
   Your league's real clearing prices are the only honest answer to "what will
   this actually cost in MY room", and they are being discarded.
3. **`observed: []` makes the record dishonest by omission.** The history entry
   claims to be a record of the auction while holding none of what happened.

## 3. Scope when this is picked up

- **S1 — Persist the log.** `recordAuction` writes the real sale log (buyer
  slot, price, position, and the `market`/`fair` value at the time so later
  analysis can compute the premium without re-deriving it). Exclude my own buys
  from the *learning* set for the same reason `sellTo` already does — measuring
  my own opinion back is not evidence — but keep them in the *record*.
- **S2 — Seed tendencies from history.** `createAuction` accepts a prior built
  from past LIVE auctions in the same league, so room N+1 opens already knowing
  T3 pays over market for running backs. This is the self-learning tie-in.
  MUST be shrunk toward neutral by sample size: two observations of one manager
  is not a tendency, and a confident wrong prior is worse than no prior.
- **S3 — Enforce capture in auction mode.** With a room open, marking a player
  taken without naming a buyer and a price should not be possible; today the
  plain board TAKE stays binary and SIM mode shows bid controls rather than the
  SOLD row. Every take in an auction is a price observation or it is nothing.
- **S4 — Surface it.** Show, per league-mate, what the app has learned and on
  how many observations — the MODEL tab's existing idiom. A learned prior the
  user cannot inspect is one they cannot correct.

## 4. Constraints this must honour

- **Market prices stay display / opponent-model only** (standing owner rule).
  Observed sale prices are an opponent model and a roster-construction input.
  They must never feed a player projection or the learned-signal gate.
- **Honest data.** A tendency with too few observations reports as unknown, not
  as 1.0. Skip loudly.
- **Device-local.** History lives in `localStorage` on one device; the record
  must say so rather than implying a league-wide memory.
- **No retrain.** This is a prior for the in-room opponent model, not a signal
  family. It does not go through `promote_signals.py`.

## 5. Sizing note

S1 is small (stop writing `[]`, write the log that already exists in
`auction.log`). S2 is the real work and the real value. S3 is a UI change of
similar size to R27-B. S4 is a MODEL-tab panel.

**Not scheduled.** Filed ahead of R28 and deliberately left unscheduled: the
owner's draft is weeks away and this pays off across *repeated* drafts against
the same league, so it is worth doing well rather than fast.
