# Rel19 — Custom League Scoring & League Shape: Solution Architecture

**Role:** Solution Architect
**Date:** 2026-08-13
**Owner decisions in force:** D1 (paste a Sleeper league id, auto-fetch, keep every
value hand-editable), D2 (real per-player component projections — exact, never
scaled off a PPR total), D3 (all player surfaces recalculate + a new scoring page).

> **Design-only artifact.** No code, test, data, contract or workflow file was
> created or modified. Every number tagged **[MEASURED]** was produced on
> 2026-08-13 by read-only HTTP GETs and by *importing* existing repo modules in a
> scratchpad process under `/tmp`. The browser CORS experiment ran a throwaway
> Playwright script under `/tmp/cors-probe/`, never in the repo.

---

## 0. Executive summary

### 0.1 The finding that should shape Rel19

The components D2 demands **are already in the payload the pipeline downloads
every run.** `scripts/scrape/espn_players.py` fetches ESPN's `kona_player_info`
entry, reads two fields off it (`appliedTotal`, `stats["53"]`), and throws the
rest away. That entry carries the whole per-category stat line.

```
Josh Allen 2025, kona actuals entry (statSourceId 0 / statSplitTypeId 0)  [MEASURED]
  statId  1  pass completions   319
  statId  3  pass yards        3668
  statId  4  pass TD             25
  statId 19  pass 2pt             1
  statId 20  interceptions       10
  statId 24  rush yards         579
  statId 25  rush TD             14
  statId 72  fumbles lost         3

  ESPN leaguedefaults/3 (PPR) recompute from those components:
    3668(.04) + 25(4) - 10(2) + 579(.1) + 14(6) - 3(2) + 1(2)  =  364.62
  ESPN appliedTotal                                            =  364.62   EXACT
```

Run across the **entire committed 300-player pool**: 288 of 300 reconcile to
better than 0.011 pts. The 12 that do not are off by **exactly 6.0 or 12.0** and
are all return specialists (Rashid Shaheed, Marvin Mims Jr., Parker Washington,
Chimere Dike, Malik Washington, …) — return touchdowns, one statId we do not yet
harvest. The owner's league scores that key: `st_td 6.0`. **[MEASURED]**

Rel19 therefore does **not** need a new projection model. It needs the pipeline
to stop discarding data it already has.

### 0.2 The second finding: what custom scoring actually moves

Re-scoring the same 300 players under Omilia-US's core keys:

```
Season points, 2025 actuals, ESPN-PPR vs Omilia-US core keys      [MEASURED]

  Christian McCaffrey  RB   PPR 416.6   OMILIA 416.6   delta   +0.0
  Puka Nacua           WR   PPR 375.0   OMILIA 375.0   delta   +0.0
  Bijan Robinson       RB   PPR 370.8   OMILIA 370.8   delta   +0.0
  Trey McBride         TE   PPR 315.9   OMILIA 315.9   delta   +0.0

  Matthew Stafford     QB   PPR 350.4   OMILIA 636.4   delta +286.0
  Jared Goff           QB   PPR 297.1   OMILIA 561.6   delta +264.5
  Drake Maye           QB   PPR 352.0   OMILIA 591.0   delta +239.0
  Josh Allen           QB   PPR 364.6   OMILIA 574.1   delta +209.5
```

**Every non-QB delta is exactly zero.** Omilia's RB/WR/TE keys (`rush_yd 0.1`,
`rush_td 6`, `rec 1`, `rec_yd 0.1`, `rec_td 6`, `fum_lost -2`) are byte-identical
to ESPN's PPR defaults. The entire divergence is at QB, and it is enormous:
`pass_cmp 0.5` and `pass_td 6.0` add **197 to 286 points**.

But raw points are not the draft board. Replacement level moves with them:

```
VOR board, top of the draft                                        [MEASURED]

  CURRENT APP (PPR, 12 teams, 7 starters)      replacement QB 241.6
    1 McCaffrey  RB  VOR 288.9      6 Nacua      WR  VOR 186.8
    2 Robinson   RB  VOR 243.1      7 Cook III   RB  VOR 174.5
    ... no QB in the top 12.  Josh Allen (best QB) VOR 123.0.

  OMILIA-US (custom, 10 teams, 9 starters)     replacement QB 495.4
    1 McCaffrey  RB  VOR 271.5      8 Cook III   RB  VOR 157.1
    ...                             9 Stafford   QB  VOR 141.0
```

**The honest headline:** QB point totals rise ~60%, but QB *value* rises far less
because every QB rises together — the top QB moves from roughly the 14th-best
pick to the 9th. A design that shouted "QBs are now top-3 picks" would be wrong.
Rel19's job is to make the app say the true thing, which is a five-slot shift,
not a revolution. The change that matters more than the number is that the app
currently shows a 10-team manager a 12-team replacement level and a 7-slot
lineup for a 9-starter roster.

### 0.3 What this architecture delivers

| # | Deliverable | Answers |
|---|---|---|
| A1 | Direct in-browser Sleeper fetch (**CORS-verified**), with a paste fallback | Q1 |
| A2 | `LeagueProfile` = scoring table **+ roster shape**, one object, one storage key | Q3, Q8 |
| A3 | `data/player_components.json` sidecar, built by the existing ESPN feed | Q4, Q5 |
| A4 | The **exact-by-construction** reconciliation identity + its gate test | Q4 |
| A5 | Shape threading into team-logic / auction / lineup with a default-preserving switch | Q3, Q6 |
| A6 | K and D/ST: contract first, projection second — never a silent 7-slot lineup | Q2 |
| A7 | The default-PPR bypass rule that makes silent drift structurally impossible | Q4, Q5, Q6 |
| A8 | Honest statement of the learning boundary + what a player-level loop needs | Q7 |

---

## 1. What was read and measured first

**Read (unmodified):** `app/team-logic.js`, `app/auction.js`, `app/lineup.js`,
`app/draft-sim.js`, `app/data.js`, `app/views/players.js`, `app/views/lineup.js`,
`app/views/team.js`, `app/views/compare.js`, `app/availability.js`,
`app/main.js`, `index.html`, `scripts/models/player_projection.py`,
`scripts/build_predictions.py`, `scripts/build_weekly.py`,
`scripts/scrape/espn_players.py`, `scripts/validate_data.py`,
`data/contracts/player_projections.schema.json`,
`data/contracts/player_weekly.schema.json`,
`docs/roadmap/rel18/BACKTEST_DESIGN.md`.

**Measurement log**

| # | Claim | Method | Result |
|---|---|---|---|
| M1 | Sleeper GET is CORS-open | server-side GET with `Origin:` | `access-control-allow-origin: *`, `access-control-allow-credentials: true`, `access-control-expose-headers: etag,date` |
| M2 | Sleeper answers preflight | `OPTIONS` with/without `Access-Control-Request-Headers` | `204`, ACAO `*`, `access-control-allow-methods GET,POST,PUT,PATCH,DELETE,OPTIONS`, broad `allow-headers`, `access-control-max-age 1728000` |
| M3 | A real browser accepts those headers cross-origin | Chromium 1194 + Playwright, page on `:4399` fetching a mirror on `:4400` replaying M1's headers verbatim | `status 200`, `response.type === "cors"` |
| M4 | The harness can detect a CORS block (positive control) | same mirror, ACAO stripped | `TypeError: Failed to fetch` + console `has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header` |
| M5 | Direct in-sandbox browser hit to `api.sleeper.app` | same page | `net::ERR_CONNECTION_RESET` — transport, **not** CORS (M4 proves a CORS block looks different) |
| M6 | kona carries full components | `_kona_page(2025, …)` | see §0.1; `appliedStats` is `[]`, `stats` is the map |
| M7 | PPR reconstructs exactly | recompute over the whole pool | 288/300 within 0.011; 12 off by exact multiples of 6.0 (return TDs) |
| M8 | kona serves **kickers** | `filterSlotIds [17]` | Jason Myers `appliedTotal 195.0`, FG-distance statIds 74–87 present |
| M9 | kona serves **D/ST** | `filterSlotIds [16]` | Seahawks D/ST `appliedTotal 185.0`, defensive statIds 89–136 present |
| M10 | Owner league payload | `GET /v1/league/1393691504228184064` | 4 543 B; `total_rosters 10`; `roster_positions` = QB,RB,RB,WR,WR,TE,FLEX,K,DEF,BN×4; 147 scoring keys (65 non-zero); `st_td 6.0` present |
| M11 | Share-link sizes | minify / base64 / deflate | scoring_settings 2 568 B; full profile 2 698 B; base64url 3 600 B; deflate+base64url **1 064 B** |
| M12 | Contracts are strict | read schemas | `additionalProperties: false` on both; `position` enum is `["QB","RB","WR","TE"]` |

---

## 2. Q1 — CORS: can the browser fetch Sleeper directly?

### 2.1 Verdict: **YES.** Fetch it directly from the page. No backend.

The experiment had to work around a sandbox artefact, and the workaround is what
makes the answer trustworthy rather than assumed.

A direct in-page `fetch('https://api.sleeper.app/v1/state/nfl')` from Chromium in
this sandbox fails with:

```
TypeError: Failed to fetch
[requestfailed] https://api.sleeper.app/v1/state/nfl :: {"errorText":"net::ERR_CONNECTION_RESET"}
```

`ERR_CONNECTION_RESET` is a **transport** failure — this session's egress proxy
resetting Chromium's tunnel. It is not a CORS decision. The positive control
proves the distinction is observable: pointing the same page at a server that
returns a body with **no** ACAO header produces a completely different, explicit
signature **[MEASURED]**:

```
Access to fetch at 'http://127.0.0.1:4400/nocors' from origin 'http://127.0.0.1:4399'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
on the requested resource.
```

So the harness detects CORS blocks, and Sleeper's failure is not one. To get a
real browser verdict on Sleeper's *headers*, the probe fetched
`api.sleeper.app` server-side (through the proxy, which works), captured the
response headers verbatim, replayed them from a **different-origin** localhost
server, and fetched *that* from the page:

```
mirror replaying api.sleeper.app's real headers, cross-origin:   [MEASURED]
  { status: 200, type: "cors", body: '{"week":1,"leg":0,"season":"2026",…' }
```

`type: "cors"` is Chromium stating it performed a cross-origin check and the
response passed. Combined with M2's `204` preflight, the conclusion is solid:
**a browser on `nfl2026.j5lagenticstrategy.com` can fetch any Sleeper `/v1/`
GET.** The sandbox reset is an artefact of this environment and must not drive
the design.

### 2.2 Two rules the fetch code must obey

1. **`credentials: 'omit'`.** Sleeper sends `ACAO: *` *and*
   `access-control-allow-credentials: true`. That pair is illegal for a
   credentialed request — the browser rejects `*` when credentials are included.
   Note `app/data.js` uses `credentials: 'same-origin'`, which is already safe
   cross-origin (credentials are withheld), but `app/sleeper.js` must state
   `'omit'` explicitly so nobody "fixes" it later.
2. **No custom request headers.** A plain GET with no non-safelisted headers is a
   *simple request* and skips preflight entirely — one round trip. Sleeper's
   `allow-headers` list is broad enough that a preflight would pass anyway, but
   adding a header to a public read costs a round trip for nothing.

### 2.3 The fallback ladder (required — a live network call is never load-bearing)

| Tier | Path | When |
|---|---|---|
| 1 | Direct `fetch` of `/v1/league/<id>` | normal |
| 2 | **Paste the JSON** — a textarea that accepts the raw league payload | fetch failed (offline, corporate DNS block, Sleeper outage), or a non-Sleeper league |
| 3 | **Hand-build from the default profile** — every one of the 147 keys editable | no league at all |

Tier 2 is not a consolation prize: D1 requires every value be hand-editable
anyway, so the editor exists regardless, and the paste box is ~15 lines on top of
it. One mechanism, two uses (it is also the profile-transfer mechanism in §7.3).

### 2.4 Rejected alternatives, with reasons

- **Netlify function proxy** — adds a serverless dependency and a cold-start to a
  static PWA to solve a problem that measurement says does not exist. Rejected.
- **Pipeline-side fetch keyed by a committed league id** — would hard-code the
  owner's league into the repo, make the feature single-tenant, and put a cron's
  latency between "I edited my scoring" and "the app agrees". It also inverts the
  standing rule that a pasted league id is a *user-supplied public identifier*,
  not repo configuration. Rejected.
- **Fetching at build time** — same objections, plus it would break the paste and
  hand-edit tiers. Rejected.

---

## 3. Q3 — The `LeagueProfile`: scoring **and** shape

### 3.1 Why one object

Scoring and shape are not separable. `pass_cmp 0.5` changes QB *points*;
`10 teams` and `9 starters` change what those points are *worth*. Shipping
scoring without shape would produce the worst possible outcome: a QB board that
moved for the right reason, ranked against a 12-team replacement level that is
wrong by 54 points at QB **[MEASURED: 495.4 vs 241.6]**.

### 3.2 The object

New pure module `app/league-profile.js`. No DOM, no fetch, no storage — the same
discipline as `team-logic.js`, so it unit-tests under bare node.

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
    flex: { FLEX: ['RB','WR','TE'] },      // SUPER_FLEX/WRRB_FLEX/REC_FLEX map here too
    size: 13,
    unsupported: []                        // positions with slots but no projection
  },

  scoring: { pass_yd: 0.04, pass_cmp: 0.5, pass_td: 6.0, ... },  // 147 keys as fetched
  edits:   { pass_td: 6.5 },               // hand-edit overlay, never merged into `scoring`
  modeled:   ['pass_yd','pass_cmp','pass_td','pass_int','pass_2pt','rush_yd',
              'rush_td','rush_2pt','rec','rec_yd','rec_td','rec_2pt','fum_lost','st_td'],
  unmodeled: ['pass_cmp_40p','bonus_pass_yd_400','rush_40p','bonus_rush_yd_200', ...]
}
```

Three details carry weight:

- **`edits` is an overlay, never merged.** The effective table is
  `{...scoring, ...edits}`. Keeping them apart makes "reset to league" a one-line
  delete, makes "3 values differ from Omilia-US" displayable, and means a re-fetch
  refreshes the league without silently discarding the manager's edits.
- **`modeled` / `unmodeled` are computed, not authored.** `unmodeled` is exactly
  the non-zero scoring keys the component artifact cannot express. This is the
  honesty channel: the Scoring page renders those keys greyed with "not modeled",
  and they contribute **0**, never an approximation. For Omilia that is the
  distance and threshold bonuses (`pass_cmp_40p`, `pass_td_40p/50p`, `rush_40p`,
  `rush_td_40p/50p`, `rec_td_40p/50p`, `bonus_pass_yd_400`, `bonus_rush_yd_200`,
  `bonus_rec_yd_200`, the `bonus_fd_*` first-down keys). A season total cannot
  express a per-play distance event, and inventing a rate to fake it is exactly
  the dishonesty this repo exists to avoid. Section 5.5 states what it would take
  to model them properly.
- **`unsupported`** holds roster positions with slots but no projection. It is the
  mechanism behind §6's K/DEF rule.

### 3.3 Sleeper → shape normalization

`roster_positions` is a flat array with repeats. Normalization is a pure fold:

| Sleeper token | Slot(s) | Eligible |
|---|---|---|
| `QB` `RB` `WR` `TE` `K` | `QB1`, `RB1/RB2`, … | own position |
| `DEF` | `DEF1` | `DEF` (team defense) |
| `FLEX` | `FLEX` | RB, WR, TE |
| `REC_FLEX` | `RFLEX` | WR, TE |
| `WRRB_FLEX` | `WRFLEX` | WR, RB |
| `SUPER_FLEX` | `SFLEX` | QB, RB, WR, TE |
| `IDP_FLEX`, `DL`, `LB`, `DB` | — | **unsupported** (surfaced, never silently dropped) |
| `BN` | `BN1…BNn` | any modeled position |
| `IR`, `TAXI` | excluded from `size` | not draftable |

Multiples get numeric suffixes in encounter order, matching `rosterShape()`'s
existing convention (`FLEX` when one, `FLEX1/FLEX2` when several).

### 3.4 How shape flows into the fit engine — and the defect it exposes

`app/team-logic.js` hard-codes the shape three times over: `STARTER_SLOTS`,
`BENCH_SLOTS`, `STARTER_DEMAND`, and `MODELED`. `app/lineup.js` hard-codes it a
fourth time as `LINEUP_SLOTS`. `app/draft-sim.js` already has a *configurable*
`rosterShape()` (Rel6) — but it is used only by the draft simulator and the
auction engine, and it has no K/DEF and bounds that cannot express this league
(`ROSTER_BOUNDS.bench = [4,8]` fits Omilia's 4; `qb:[1,2] rb:[2,3] wr:[2,3]
te:[1,2] flex:[0,2]` fits too — but there is no `k` or `def` key at all).

**The defect the shape work exposes.** The two engines already disagree on what
"replacement level" means:

```js
// app/team-logic.js  replacementLevel()  — PER-ROSTER
const row = ranked[demand + extra];        // QB demand 1 -> the 2nd-best QB overall

// app/auction.js     fairDollars()        — LEAGUE-WIDE
const idx = Math.max(0, Math.round(demand * leagueSize) - 1);   // QB -> the 10th/12th
```

`team-logic` computes the replacement as if the league had one team. That is why
its docstring can say "the player a manager could still get for free" and still
be internally consistent — but it means **team count has no effect on VOR today**,
which makes "this is a 10-team league" a cosmetic fact. Rel19 cannot deliver Q3
without fixing it.

**The resolution — a shape-gated switch, not a rewrite:**

```js
export function replacementLevel(pool, weeklyById, mode, position, shape /* optional */) {
  if (!shape) return /* today's exact code, byte for byte */;
  const demand = shape.starterDemand[pos] + flexAbsorbShare(pos, shape);
  return rankedAtPos(pool, ...)[Math.max(0, Math.round(demand * shape.teams) - 1)] ?? 0;
}
```

- **No league connected → `shape` is `undefined` → today's arithmetic, untouched.**
  All 13 assertions in `tests/feature/team_vor.test.mjs` keep passing on the
  literal current path.
- **League connected → league-wide replacement**, and `teams` finally means
  something.

This is defensible, not merely test-preserving: with no league connected the app
genuinely does not know the team count, and the per-roster definition is the
honest degenerate case. It is also a *weaker* definition, and the doc should say
so plainly — migrating the default is a follow-up release that must publish its
own before/after diff, not a side effect of a scoring feature.

The same optional-`shape` signature extends to `neediestOpenSlot`, `recommend`,
`recommendV2`, `bestPickNow`, `vorScore`, `slotEligible`, and `fitScore` (whose
`resolveStarters` iterates `STARTER_SLOTS`). In every case: **argument absent ⇒
the current frozen constants ⇒ current behaviour.**

`app/auction.js` needs less: `fairDollars` already takes a `shape`, and
`createAuction` already takes `leagueSize` and `rosterConfig`. What it needs is
(a) the profile's shape accepted where `rosterShape(rosterConfig)` is called,
(b) `teamNeedsPos`'s hard-coded `caps` map extended for K/DEF, and (c) the
`flexShare = {RB:.45, WR:.45, TE:.10}` constant keyed off `shape.flex` so a
`SUPER_FLEX` league does not silently spread flex demand over RB/WR/TE only.

`app/lineup.js` `bestLineup()` becomes `bestLineup(players, shape)` with
`shape` defaulting to the current `LINEUP_SLOTS` geometry — its greedy
dedicated-first-then-flex algorithm stays provably optimal as long as flex slots
are filled after dedicated ones and in decreasing order of eligibility breadth
(fill `RFLEX`/`WRFLEX` before `FLEX` before `SFLEX`). That ordering rule must be
written down, because it is the only thing keeping the greedy proof valid once
multiple heterogeneous flex slots exist.

---

## 4. Q8 — Storage, sharing, and life without a login

### 4.1 Storage

One new key, versioned like every existing key
(`nfl2026.{scoring,team,ai,taken,mocklocks,unlock}.v1`):

```
nfl2026.league.v1  ->  the LeagueProfile of §3.2 (JSON)
```

Measured payload: 2 698 B minified **[M11]** — trivial against a 5 MB quota.

`nfl2026.scoring.v1` (`'ppr' | 'half' | 'std'`) **stays exactly as it is**. It is
not migrated, not rewritten, not deleted. Precedence is explicit and visible:

> **A connected league profile supersedes the PPR/HALF/STD segment.** While one is
> connected, the segment renders **disabled** with the label `SCORING · OMILIA-US`
> and a link to the Scoring page. Disconnecting restores the segment and the
> previously stored mode.

Two controls silently fighting over the same number is the failure mode here. One
visibly winning is the fix.

### 4.2 Reading it

`app/league-profile.js` exports pure `parseSleeperLeague(json)`,
`normalizeShape(roster_positions, teams)`, `effectiveScoring(profile)`,
`scoreComponents(comp, table)`, `classifyKeys(table)`. A thin
`app/league-store.js` owns `localStorage` with the same try/catch-and-degrade
pattern `loadScoring()` already uses — storage blocked (private mode) must yield
a session-only profile, never a thrown error.

### 4.3 Sharing, and cross-device behaviour

Under the no-login rule nothing syncs. Say it out loud in the UI rather than
letting a manager discover it. Two mechanisms:

- **Primary — the league-id link.** `#/scoring?league=1393691504228184064` opens
  the page and re-fetches from Sleeper. The league id **is** the share token; it
  is a public identifier, which is precisely the standing rule's carve-out. The
  link is 40 characters, survives any messenger, and can never carry a stale copy
  of a league whose commissioner changed a setting.
- **Secondary — the profile blob**, for hand-edited or pasted (non-Sleeper)
  profiles, which have no league id to point at. `#/scoring?p=<base64url>` of the
  minified profile. **[M11]**: 3 600 B raw base64url, or **1 064 B** through
  `CompressionStream('deflate-raw')` — a platform API (Safari/iOS 16.4+), no
  library, no build step, which is exactly why it is allowed here. Because that
  floor is not universal, the encoder must fall back to raw base64url when
  `CompressionStream` is absent, and the decoder must sniff which it got. A 3.6 KB
  URL is legal everywhere; it is merely ugly, and ugly beats broken.

Also offer plain **Copy profile JSON** / **Paste profile JSON** on the page — the
same textarea as the §2.3 Tier-2 fallback. One widget, three jobs: CORS fallback,
non-Sleeper leagues, cross-device transfer.

### 4.4 What must be stamped, not just stored

`nfl2026.mocklocks.v1` archives completed mock drafts point-in-time so they can be
graded later. A lock made under Omilia scoring and graded under PPR is a
meaningless comparison. **Every new lock must stamp `{league_id, profile_hash,
teams, roster_positions}`**; a lock without the stamp is a pre-Rel19 PPR lock and
must be graded as such. This is ~6 lines and it is the difference between the
draft-learning record staying interpretable and quietly rotting. Same stamp on
`nfl2026.team.v1`, so the Team tab can warn when a roster was built for a
different shape than the one now connected.

---

## 5. Q4 — The component model and the reconciliation that protects every number

### 5.1 The artifact

New contract **`data/player_components.json`** — a **sidecar**, not new fields on
`player_projections.json`. Three reasons:

1. `player_projections.schema.json` is `additionalProperties: false` **[M12]** and
   is read by every surface; widening the hot contract to carry 16 more numbers
   per player raises the blast radius of a bad build.
2. `player_weekly.json` mirrors `player_projections.json` **by index** — an
   invariant `build_weekly.py` documents in capitals. A sidecar keyed by
   `gsis_id` cannot perturb it.
3. A sidecar can **404 gracefully**, which is the whole of the dormancy design
   (§5.4) and the established pattern for `ai_insights` / `player_history` /
   `team_strength`.

```jsonc
{
  "season": 2026,
  "updated_utc": "2026-08-13T19:41:32Z",
  "source": "espn_kona_actuals",
  "basis_season": 2025,
  "estimate": true,
  "scoring_reference": "espn_leaguedefaults_3_ppr",
  "reconciled": { "players": 300, "max_abs_residual": 0.0, "tolerance": 0.011 },
  "players": [
    { "gsis_id": "espn-3117251", "position": "RB", "games": 17,
      "comp": { "pass_cmp":0, "pass_att":0, "pass_yd":0, "pass_td":0, "pass_int":0,
                "pass_2pt":0, "rush_att":311, "rush_yd":1202, "rush_td":10,
                "rush_2pt":0, "rec":102, "rec_yd":924, "rec_td":7, "rec_2pt":0,
                "fum_lost":0, "st_td":0 } }
  ]
}
```

Source statIds, all verified present in the entry the pipeline already fetches
**[M6]**: `1` completions, `0` attempts, `3` pass yd, `4` pass TD, `20` INT,
`19` pass 2pt, `23` rush att, `24` rush yd, `25` rush TD, `26` rush 2pt,
`53` receptions, `42` rec yd, `43` rec TD, `44` rec 2pt, `72` fumbles lost,
plus the return-TD statId that must be identified to close M7's 12-row gap.

### 5.2 The identity that makes reconciliation exact rather than approximate

This is the core of the design, and it is a one-line consequence of how
`project_player()` already works:

```
proj_points = baseline × Π_s applied(s)          where applied(s) = 1 + w_s(adj_s − 1)
```

`Π applied(s)` is **one scalar per player** — it does not vary by stat category.
So define each component the same way:

```
comp_i = prior_i × Π_s applied(s)                (the SAME scalar)
```

Then for any linear scoring table `T`:

```
score_T(comp) = Σ_i T_i · prior_i · Π applied
              = score_T(prior) × Π applied
```

and in particular, for `T` = ESPN PPR:

```
score_PPR(comp) = score_PPR(prior) × Π applied
                = appliedTotal      × Π applied      [M7: exact, 288/300 today]
                = baseline          × Π applied
                = proj_points                        EXACT, by construction
```

At today's weights (**all zero**) `Π applied = 1`, so components are literally the
prior-season actuals and the residual is float noise on 2-decimal rounding.

### 5.3 What this honestly is — and is not

D2 asks for "REAL per-player COMPONENT PROJECTIONS". What §5.2 delivers is a
**faithful decomposition** of the projection the app already ships. It carries
**exactly as much predictive information as `proj_points` does** — not one bit
more. What it adds is the ability to *re-score*, which is precisely what D2's
stated purpose requires ("Custom scoring must be EXACT, not scaled off a PPR
total") and which a single total can never provide.

Stating that plainly is not a hedge, it is the design constraint. Anything
better — per-category aging curves, TD-rate regression to the mean, a completion
model that is not last year's completions — is a **model change**. Model changes
go through `scripts/promote_signals.py` and the never-regress gate at weight 0.
Letting them ride in on a scoring feature would smuggle an unvalidated model past
the one mechanism this repo has for keeping models honest. Rel19 does not do
that, and the Scoring page must label components `basis: 2025 actuals, rescaled`
so nobody mistakes them for a per-category forecast.

### 5.4 The gate — four tests, and what each one catches

Add `tests/feature/components_reconcile.test.mjs` (node, imports the pure
scorer + reads the committed JSON) and one Python check in
`scripts/validate_data.py`. Any failure is a **red gate**; per CLAUDE.md, red
never deploys.

| # | Test | Fails when | Tolerance |
|---|---|---|---|
| **R1** | For every player, `\|score_PPR(comp) − proj_points\| ≤ 0.011` | a component is dropped, mis-mapped, or a statId changes meaning | **0.011 pts** — chosen from measurement: both sides round to 2 dp, so 0.005 + 0.005 + float slack. Today's residual over 288/300 is < 0.011 and the other 12 are off by exactly 6.0 (§0.1) |
| **R2** | Every `gsis_id` in `player_projections.json` has an entry, and vice versa | partial coverage — which would let a mixed PPR/custom board ship and silently mis-rank | exact set equality |
| **R3** | **The default-PPR bypass:** with `profile == null`, every rendered number equals the value produced with `player_components.json` absent | the recompute path leaks into the default path | byte-identical strings |
| **R4** | `sum(non-zero scoring keys) − sum(modeled ∪ unmodeled) == ∅` | a Sleeper key is silently neither scored nor declared unmodeled | exact |

**R2 is what makes §5.5's dormancy tractable.** Because a partial file cannot pass
the gate, the runtime only ever sees "absent" or "complete". The app still handles
a missing per-player row defensively (PPR points + a visible per-row chip), but
that state is unreachable in shipped data.

**R3 is the single most important test in Rel19.** It converts "every number in
the app must not silently move" from a hope into a mechanical property, and §5.6
is the rule that makes it pass.

### 5.5 The unmodeled keys — what it would actually take

Omilia scores 9 keys that a season total cannot express. Their honest treatment is
**contribute 0, render greyed, label "not modeled"**. Two candidate routes exist
and both are out of Rel19 scope:

- **ESPN bucket statIds.** The kona entry carries dozens of unlabelled bucket
  ids — Josh Allen has `5:726, 6:361, … 15:4, 16:2, 17:3` and CMC has
  `27–38` on the rushing side **[M6]**. These *look* like distance/count splits
  and would plausibly decode `rush_40p`, `pass_td_40p`, `rec_td_50p`. **The
  mapping is not verified**, and a wrong mapping produces confidently wrong points
  — worse than zero. Any future release must *prove* a decode by reconciling
  against a known league whose scoring includes the bonus, before shipping it.
- **nflverse `stats_player_week_{season}.csv`** — ~150 columns, runner-built
  (403s from this sandbox, works on GitHub Actions), the same dormant pattern as
  `epa_history` / `injury_history`. Its per-week granularity handles the
  *threshold* bonuses (`bonus_pass_yd_400`, `bonus_rush_yd_200`) correctly, since
  those are per-game, not per-season. It still cannot do the per-play distance
  bonuses without play-by-play.

Magnitude check so the omission is sized, not just declared: at league-average
rates these bonuses are worth on the order of 10–25 points a season to a QB
against a `pass_cmp` delta of ~160. Material enough to disclose, nowhere near
enough to justify guessing.

### 5.6 The rule that makes silent drift impossible

> **DEFAULT-PPR BYPASS.** When no league profile is connected — or when the
> connected profile's effective table is byte-equal to the ESPN PPR default —
> every surface reads `proj_points` and calls `scoringAdjust()`, exactly as it
> does today. `player_components.json` is not consulted at all.

Components are a *branch*, not a *replacement*. The recompute path can only be
entered by a manager who has connected a league and can see, on screen, that they
did. R3 locks it. This is why "reconcile within tolerance" is a safety net rather
than the primary defence: the primary defence is that the default path never
executes new code.

---

## 6. Q2 — Kicker and team defense: the position

### 6.1 The position, stated plainly

**Rel19 ships K and D/ST as a real pipeline expansion — and the honest 9-slot
lineup lands first, independently, so that a failure of the projection work
degrades correctly instead of hiding.**

This is two deliverables in a deliberate order, not one.

**F1 (contract — non-negotiable).** The lineup, the roster builder, the draft
room and the auction render **all nine** of this league's starting slots. A
position in `shape.unsupported` renders its slot explicitly:

```
K     — not projected —          [ why? ]
DEF   — not projected —          [ why? ]
```

and the card total carries `7 of 9 slots projected`. The optimizer must never
present a 7-slot lineup and call it optimal for a 9-starter league; `bestLineup`
must return those slots as present-but-unfilled with a warning, reusing the exact
`warnings: [{slot, id, reason}]` channel Rel17 built for forced starts — the
banner mechanism, the CSS, and the "suppress the *already optimal* line because it
would be a lie" logic all already exist in `app/views/lineup.js`.

**F2 (projection — measured feasible).** Add slots 16 and 17 to
`_SLOT_IDS = [0, 2, 4, 6]` in `scripts/scrape/espn_players.py`. Measurement says
both come back populated with real prior-season totals and full components
**[M8, M9]**:

```
filterSlotIds [17]  ->  Jason Myers   K    appliedTotal 195.0   FG buckets 74–87
filterSlotIds [16]  ->  Seahawks D/ST DEF  appliedTotal 185.0   def stats 89–136
```

### 6.2 Why this is a genuinely small change, and where the real cost sits

There is **no new model**. K and D/ST enter through the identical day-zero path
every other position uses: prior-season actuals × a neutral signal product. No
signal in `compute_raw_signals()` is position-specific in a way that breaks (age
curve returns a multiplier for any position; target competition is already gated
to RB/WR/TE; OL/DL needs an `ol` field kickers do not have and is simply omitted).

The real cost is contract surface, and it must be named:

- `player_projections.schema.json` — `position` enum must gain `"K"` and `"DEF"` **[M12]**
- `player_weekly.json` — `build_weekly.py`'s split runs unchanged (it is
  position-agnostic: season total ÷ games, Elo tilt, renormalize). Bye detection
  works off the team schedule, which K and D/ST have.
- `app/team-logic.js` `MODELED = ['QB','RB','WR','TE']` — the constant that
  currently makes `slotEligible()` return `false` for K/DEF and keeps them off the
  bench. It becomes shape-derived. Note `POSITION_CAPS` **already** carries
  `{DEF:1, DST:1, K:1}` with a comment saying it is "ready the moment they are
  ever added to the pool" — Rel2 anticipated this exactly.
- Scoring: Omilia specifies K and DEF fully (`fgm_0_19` … `fgm_60p`, `fgmiss`,
  `xpm`, `xpmiss`; `pts_allow_*` tiers, `yds_allow_*` tiers, `sack`, `int`,
  `def_td`, `safe`, `ff`, `fum_rec`, `blk_kick`). The **scoring side is solvable**;
  the FG-distance buckets are already in the K component line **[M8]**. The
  `pts_allow` / `yds_allow` **tiers are step functions of a per-game value** and
  therefore hit the same season-total wall as §5.5's threshold bonuses — a
  season's total points allowed cannot recover which tier each of 17 games landed
  in. Those keys ship **unmodeled**, and a D/ST's custom score is therefore
  materially incomplete. That must be stated on the card, not buried.

### 6.3 The honesty consequence, accepted explicitly

Because D/ST tier scoring is partly unmodeled, a D/ST's custom-scored total is
**less trustworthy than a QB's**. The design accepts that and discloses it per
position rather than suppressing the position entirely — a manager who must start
a D/ST is better served by "here is an incomplete number, and here is exactly
which keys are missing" than by an empty slot. But the disclosure is mandatory:
`DEF` cards carry a `PARTIAL SCORING` chip listing the unmodeled keys, and D/ST
never appears in `bestPickNow`'s VOR ranking against fully-scored positions,
because comparing a complete number to an incomplete one across positions is the
kind of quiet apples-to-oranges this repo does not ship.

**If F2 slips, F1 still ships.** That is the whole point of the ordering: the
failure mode is a visibly unsupported slot, never a silently short lineup.

---

## 7. The recompute path, surface by surface (D3)

One pure entry point replaces every scattered `scoringAdjust(...)` call site:

```js
// app/team-logic.js — the single routing function
export function adjustedPoints(player, ctx) {
  const { profile, componentsById, weeklyById, mode } = ctx;
  if (!profile || profile.isDefaultPpr) {                 // §5.6 BYPASS
    const e = lookup(weeklyById, player.gsis_id);
    return scoringAdjust(player.proj_points, e ? e.receptions_prior : 0, mode);
  }
  const comp = lookup(componentsById, player.gsis_id);
  if (!comp) return { pts: player.proj_points, fallback: 'no_components' };
  return scoreComponents(comp, effectiveScoring(profile));
}
```

| Surface | File | Change | Notes |
|---|---|---|---|
| **Players list** | `app/views/players.js` | `model()` calls `adjustedPoints`; `seasonAdjust()` (its private duplicate of `scoringAdjust`) routes through it | `low`/`high` scale by `custom/ppr` — the same `scoreRatio` mechanism already there; the AI± ratio composes on top unchanged |
| **Player week strip** | same | ratio changes only | `renderWeekStrip(w.weeks, ratio)` already takes a scalar |
| **Team — finder + reco** | `app/views/team.js` | `adjOf` (line ~535) routes through `adjustedPoints`; `fitScore` ctx gains `profile` | `fitScore`'s bonus constants (STACK 12, BYE_CLASH −10, FLOOR 8) are in **points** and were tuned against PPR magnitudes. Under Omilia a QB scores ~575 — a 12-point stack bonus is 4× less influential than it was. **These constants must be expressed relative to the pool's points scale, or the fit engine's behaviour changes silently under custom scoring.** See §9 R3. |
| **Team — VOR / best-pick-now** | `app/team-logic.js` | `shape` threaded (§3.4) | this is where the 10-team replacement level lands |
| **Team — auction dollars** | `app/auction.js` | `adjOf` closure in `createAuction` routes through `adjustedPoints`; `shape` from the profile | `fairDollars` is already VOR-over-budget, so custom points flow through with no formula change. `marketDollars` is **ADP-derived and must not change** — ADP is the market's PPR consensus, and re-scoring it would be inventing data. The BAIT/TARGET classification comparing our custom dollars to PPR-market dollars is then *more* useful, not less: it is exactly where a QB-premium league creates arbitrage |
| **Lineup optimizer** | `app/lineup.js`, `app/views/lineup.js` | `bestLineup(players, shape)`; per-week points scale by `custom/ppr` | `weeklyPoints(entry, seasonAdj, seasonPpr)` needs **no change at all** — it already takes an arbitrary season target and redistributes proportionally. The weekly split is scoring-agnostic by construction |
| **Compare** | `app/views/compare.js` | `metricsFor()` line ~100 reads `Number(p.proj_points)` **raw** | **Pre-existing defect:** Compare does not honour even the *existing* PPR/HALF/STD toggle. D3 forces the fix; call it out rather than folding it into the new work silently |
| **Scoring page (new)** | `app/views/scoring.js` | new route `#/scoring`, new tab | §8 |

**Draft-sim opponents** (`app/draft-sim.js`) deserve a decision: the ADP room
drafts by ADP, which is a PPR-consensus artefact. Opponents must keep drafting by
ADP — that *is* the benchmark, and a room that magically knew the custom scoring
would flatter our engine. Our picks use custom VOR. The asymmetry is the edge, and
the mock-lock stamp (§4.4) records which scoring produced it.

---

## 8. The new page

Route `#/scoring`, seventh tab, mounted like every other view.

```
SCORING & LEAGUE                                        [ ESTIMATE ]

  ┌ CONNECT ─────────────────────────────────────────────┐
  │  Sleeper league ID   [ 1393691504228184064 ]  FETCH   │
  │  or  ▸ paste league JSON     ▸ start from PPR default │
  └───────────────────────────────────────────────────────┘

  CONNECTED · Omilia-US · 10 teams · fetched 13 Aug 19:41    [ disconnect ]

  ROSTER SHAPE          QB RB RB WR WR TE FLEX K DEF · BN×4
                        ⚠ K and DEF: see coverage below

  SCORING  ·  65 of 147 keys non-zero  ·  3 edited
    PASSING     pass_yd     0.04     pass_cmp   0.50 *
                pass_td     6.00     pass_int  -2.00
                pass_cmp_40p  1.00   ⃠ not modeled
    RUSHING     …
    KICKING     …
    DEFENSE     pts_allow_0 6.00     ⃠ not modeled (per-game tier)

  COVERAGE      QB RB WR TE  ✓ full        K  ◐ partial (FG buckets only)
                DEF ◐ partial (9 tier keys not modeled)
                9 scoring keys contribute 0 — [ show them ]

  [ copy share link ]  [ copy profile JSON ]  [ reset to league ]
```

Design rules the page must obey:

1. **Every key is editable**, including the ones already at their league value
   (D1). Edited keys carry `*` and land in `edits`, never in `scoring`.
2. **Unmodeled keys are shown, greyed, with a reason** — never hidden. Hiding them
   would let a manager believe a total is complete when it is not.
3. **The coverage block is not optional chrome.** It is the honesty contract: it
   states per position whether the number on every other tab is complete.
4. **The dormant banner outranks everything** (§9). If
   `player_components.json` is absent, the page still connects, still shows the
   table, still applies shape — and says, at the top, that points are PPR.
5. Dark-only tokens, AA contrast, 13-inch iPad first. The scoring table is the
   densest surface in the app; at iPhone width it collapses to one column per
   category group with the category as a sticky sub-header.

---

## 9. Q5 — Dormancy: exactly what happens before the runner builds components

Four states, one of which is unreachable in shipped data (§5.4 R2):

| State | Trigger | Behaviour |
|---|---|---|
| **D0 — no profile** | nothing connected | today's app, byte-identical. PPR/HALF/STD segment live |
| **D1 — profile, components ABSENT** | `#/scoring` connected, `player_components.json` 404s | **shape applies immediately** (slots, replacement level, lineup geometry — none of it needs components). **Scoring does not.** Every player surface keeps PPR numbers and carries a persistent header banner: *"Omilia-US scoring is connected but per-player components have not been built yet — points below are PPR."* Plus a per-card `PPR` chip so a screenshot cannot be mistaken for a custom board |
| **D2 — profile, components PRESENT** | both | full recompute; positions in `unsupported` render `— not projected —`; partial-coverage positions carry `PARTIAL SCORING` |
| **D3 — components present, player missing** | gate-unreachable (R2) | defensive: that row shows PPR + a chip, and the list header counts it. Never silently ranked as if custom |

**The splitting of shape from scoring in D1 is deliberate and is the best part of
this design.** Shape is derived from `roster_positions` and `total_rosters` — data
the browser has the instant the fetch returns. It needs no pipeline run. So the
day Rel19 ships, before any cron fires, a 10-team manager already gets a 9-slot
lineup and a 10-team replacement level. The scoring half lights up when the runner
catches up. Two independently valuable halves, each honest on its own.

**Builder rule.** `build_predictions.py` must emit `player_components.json` with
`players: []` and a `degraded` row in `pipeline_status.json` rather than emitting a
partial file — matching the runner-built dormant pattern of `epa_history` /
`injury_history`. An empty file is honest; a half file is a lie that passes
`fetch`.

---

## 10. Q6 — Backward compatibility, and every test at risk

### 10.1 The compatibility contract

| Existing thing | Rel19 treatment |
|---|---|
| `scoringAdjust(ppr, rec, mode)` | **signature and body unchanged.** Becomes the D0/D1 path |
| `weeklyPoints(entry, seasonAdj, seasonPpr)` | **unchanged.** Already ratio-based, already scoring-agnostic |
| `nfl2026.scoring.v1` | **unchanged.** Not migrated. Superseded-and-visibly-disabled while a profile is connected (§4.1) |
| `STARTER_SLOTS` / `BENCH_SLOTS` / `SLOT_ORDER` / `STARTER_DEMAND` / `LINEUP_SLOTS` / `MODELED` | **stay exported with today's values** as `DEFAULT_SHAPE`. Shape-taking overloads default to them |
| `replacementLevel` / `vorScore` / `bestPickNow` / `recommend` / `recommendV2` / `fitScore` / `bestLineup` | gain a **trailing optional** `shape` / `profile` argument. Omitted ⇒ today's arithmetic |
| `POSITION_CAPS` | unchanged — already carries `K:1, DEF:1, DST:1` |
| `rosterShape()` / `ROSTER_BOUNDS` (draft-sim) | extended with `k` / `def` bounds; defaults unchanged so `DEFAULT_ROSTER` still yields the classic 13-slot shape |
| `data/player_projections.json`, `data/player_weekly.json` | field-compatible; only the `position` enum widens (F2) |

### 10.2 Tests at risk — named, with the mechanism

Baseline is **277 unit / 81 e2e**. Counts below are `grep -c 'test('` **[MEASURED]**.

| File | tests | Risk | Mitigation |
|---|---|---|---|
| `tests/feature/team_vor.test.mjs` | 13 | **highest.** Asserts `STARTER_DEMAND` is `{QB:1,RB:2,WR:2,TE:1}`, that `replacementLevel` is the `(demand+1)`th best, and exact VOR numbers | optional-`shape` switch (§3.4); with no shape these run on the literal current code path |
| `tests/feature/team_logic.test.mjs` | 18 | asserts `scoringAdjust` exactly (`ppr 300 / 100 rec → half 250, std 200`), the `slotEligible` truth table, `fitScore` reason strings and point impacts | `scoringAdjust` untouched; `slotEligible` shape-defaulted; **`fitScore` constants are the live risk — see R3 below** |
| `tests/feature/team_rel2.test.mjs` | 11 | `POSITION_CAPS` contract incl. `DEF/DST/K at 1`; "recommend excludes a 3rd QB" | F2 makes K/DEF *draftable*, so these caps go from theoretical to live. Tests should **strengthen**, not change |
| `tests/feature/auction.test.mjs` | 18 | `marketDollars` absorbs exactly the room budget; `fairDollars` floors at $1; `planBudget` sums exactly | budget conservation is scoring-independent; `shape.size` 13 is unchanged for this league. Add a 9-starter case rather than editing existing ones |
| `tests/feature/draft_sim.test.mjs` | 15 | `rosterShape: defaults reproduce the classic 13-slot shape`; bounds clamping | new `k`/`def` keys default to 0 ⇒ classic shape preserved. Assert that explicitly |
| `tests/feature/lineup.test.mjs` | 6 | `bestLineup` slot geometry, FLEX-takes-best-leftover, `__selftest()` | `shape` defaults to `LINEUP_SLOTS`; `__selftest()` must keep passing untouched |
| `tests/feature/availability_app.test.mjs` | 26 | Rel17 `playable:false` demotion, forced-start warnings | `bestLineup`'s availability tuple must survive the shape refactor **and extend to K/DEF slots**. Rel17's warning channel is being reused for unsupported slots (§6.1) — add a case proving the two reasons stay distinguishable |
| `tests/feature/ros.test.mjs` | 11 | `zero-weight SoS/availability reproduces the raw sum EXACTLY (never-regress default)` | the template for R3: an existing, passing "default path is byte-identical" test to imitate |
| `tests/feature/weekly_contract.test.mjs` | — | `player_weekly` mirrors `player_projections` by index | F2 adds K/DEF to both; the index invariant must hold across the widened pool |
| `tests/feature/real_data.test.mjs` | — | asserts committed-data shape | position enum widening |
| `tests/ux`, `tests/integrated` (81 e2e) | — | tab count, route list, Players/Team/Lineup DOM | a 7th tab and a 7th route change nav assertions; the Lineup card gains 2 rows |
| `scripts/validate_data.py` | — | schema `additionalProperties: false`, `position` enum | new schema `player_components.schema.json`; enum widened |

### 10.3 The risk in §10.2 that is not a test-fixture problem

**R3 — the fit-engine constants are denominated in points.** `STACK_BONUS 12`,
`BYE_CLASH_PENALTY −10`, `FLOOR_BONUS 8`, `BYE_COVER_BONUS 6`,
`MATCHUP_BONUS_CAP 8` were tuned against a PPR pool where the top player scores
~417 **[MEASURED]**. Under Omilia the top player scores **636** and QBs cluster
400–640. A flat +12 stack bonus is a materially smaller nudge in that pool, so
**the fit engine's recommendations change character under custom scoring even
though no constant changed.**

Two options, and the design takes the first:

1. **Normalize the bonuses to the pool** — express each as a fraction of the
   pool's top-N mean adjusted points, calibrated so the default PPR pool
   reproduces today's integer values *exactly* (a fixture test locks that). This
   keeps the engine's behaviour stable across scoring systems and keeps
   `team_logic.test.mjs`'s impact assertions green on the default pool.
2. Leave them fixed and document the drift. Rejected — it is a silent behaviour
   change under a feature whose entire promise is that nothing changes silently.

---

## 11. Q7 — The self-learning boundary, stated without euphemism

### 11.1 What custom scoring does **not** touch

**The promotion gate is a game-outcome model.** `scripts/promote_signals.py`
grades win-probability predictions by **log-loss against final scores**. Its unit
of truth is "did the home team win". Its one adopted signal is `qb_out` at
`scale = 75.0`. Nothing in that loop reads a fantasy point.

Therefore, and this should be written on the Model tab:

- Custom scoring does **not** retrain the Elo gate.
- It does **not** change a single signal weight in `data/meta.json` — all still 0.
- It does **not** alter `proj_points`, `player_weekly.json`, `game_predictions`,
  `playoff_odds`, or `parlays`.
- It does **not** make projections more accurate. It makes them **correctly
  denominated**.

Rel19 is a **presentation and ranking transform over an unchanged model.** Any
copy on the Scoring page implying "the model now knows your league" would be
false, and the page should say the true thing instead.

### 11.2 What it *does* affect, legitimately

- Which players the fit engine recommends (VOR, best-pick-now, auction dollars).
- The mock-draft record, which is why §4.4's profile stamp is mandatory —
  ungraded locks made under different scoring are not comparable, and an
  unstamped lock silently pretends they are.

### 11.3 What a genuine player-level learning loop would require

Its sibling design already did the sizing work.
`docs/roadmap/rel18/BACKTEST_DESIGN.md` §5 establishes that player-level
backtesting is **currently zero**, that `stats_player_week_{season}.csv` is
HTTP 200 with ~150 columns carrying `fantasy_points_ppr`, and that a minimal
`pid → {pos, week → ppr}` artifact is **0.10 MB/season** (0.52 MB with
position/team/opponent). That artifact is the unlock for grading projections.

**It is not sufficient for grading a *custom-scored* projection.** Grading
"was Stafford's 636 right under Omilia scoring?" requires re-scoring the
**actuals** under the same table, which requires **weekly actual components**,
not a weekly PPR total. Extending Rel18's A8b from 1 numeric column to the ~16 of
§5.1 puts the artifact on the order of **1.0–1.5 MB/season** — an estimate by
column-count scaling from Rel18's measured 0.10 MB, **not a measurement**, and it
should be measured before anyone commits to it.

With that artifact, the loop becomes real and looks like this:

```
weekly actual components  ──┐
                            ├─►  score under the SAME profile  ──►  graded error
custom-scored projection ───┘        (MAE / calibration by position)
                                              │
                                              ▼
                                  per-component signal weights,
                                  promoted at weight 0 through
                                  the SAME never-regress gate
```

Two properties of that design matter and should be stated now so Rel19 does not
foreclose them:

1. **Components make the error decomposable.** Today a projection is one number
   and a miss is one number. With components, a QB miss splits into "we were
   right about volume, wrong about TD rate" — which is what a per-category signal
   would need to earn weight against.
2. **The gate must grade under the profile the projection was made with**, which
   is the same stamping discipline as §4.4, applied to the pipeline instead of
   `localStorage`.

Rel19 does none of this. It builds the artifact shape that makes it possible.

---

## 12. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **K1** | Sleeper changes/rate-limits the endpoint | med | §2.3's paste tier makes the network non-load-bearing; profile is cached in `localStorage` and works offline forever once fetched |
| **K2** | An ESPN statId silently changes meaning | **high** | R1 catches it on the next pipeline run: a remapped statId breaks the PPR identity and reds the gate. This is why the reconciliation test is a *gate*, not a report |
| **K3** | Fit-engine constants drift under a big-points pool | **high** | §10.3 option 1, locked by a default-pool fixture test |
| **K4** | Manager believes an unmodeled-key total is complete | **high** | §8 coverage block + `PARTIAL SCORING` chips + `⃠ not modeled` on the key itself + D/ST excluded from cross-position VOR (§6.3) |
| **K5** | Components ship partial and the board mis-ranks | med | R2 makes partial coverage un-shippable; D3 handles the unreachable case defensively anyway |
| **K6** | Two scoring controls fight | med | §4.1 explicit visible precedence; the segment renders disabled, not hidden |
| **K7** | `replacementLevel` semantics change breaks saved expectations | med | shape-gated (§3.4); no league ⇒ no change. Migrating the default is a separate release with a published diff |
| **K8** | Widening the `position` enum breaks a downstream consumer | low | `parlay_builder`, `build_history`, `ai_estimates` all filter by position; each needs an audit pass, and `real_data.test.mjs` covers committed shape |
| **K9** | Bucket statIds get decoded wrong and ship confident garbage | **high** | §5.5: decoding requires a *proof* — reconciliation against a league whose scoring includes the bonus — before any bonus key leaves `unmodeled` |

---

## 13. Build order

Partitioning follows CLAUDE.md's rule — concurrency equals genuinely independent
file ownership. There are **four** disjoint partitions here, not sixteen.

```
P1  app/league-profile.js + app/league-store.js  (pure; new files)      ── independent
P2  scripts/scrape/espn_players.py + build_predictions.py               ── independent
      + data/contracts/player_components.schema.json + validate_data.py
P3  app/team-logic.js + app/lineup.js + app/auction.js + app/draft-sim.js  ── serialized
      (shape threading; four files, one owner — they share the fit contract)
P4  app/views/scoring.js + main.js + index.html (route + tab)           ── depends on P1

then, serialized on P1–P4:
P5  app/views/{players,team,lineup,compare}.js  (recompute wiring)
P6  R1–R4 gate tests + e2e updates
```

**Merge order matters in exactly one place:** P2 widens the `position` enum and P3
widens `MODELED`. If P3 lands first, `slotEligible` accepts K/DEF for a pool that
does not contain them — harmless. If P2 lands first, K/DEF appear in
`player_projections.json` while `slotEligible` still rejects them — also harmless
(they render in Players, are un-rosterable). Either order degrades safely, which
is the property to want.

**Rollback:** every piece is additive. `git revert` of the P2 commit removes
`player_components.json` and returns the app to state D1; revert of P4 removes the
route and the profile becomes unreachable, returning the app to D0. No migration,
no data loss, no schema downgrade. The one-line emergency stop is deleting
`nfl2026.league.v1` from `localStorage` — which the Scoring page's **disconnect**
button already does.

---

## 14. Acceptance criteria

1. Pasting `1393691504228184064` into `#/scoring` fetches Omilia-US from the
   browser with no backend, and renders 10 teams / 9 starters / 147 keys.
2. Every one of those 147 values is hand-editable; edits survive a reload; **reset
   to league** restores the fetched values exactly.
3. With no league connected, **every number on every tab is byte-identical to
   pre-Rel19** — locked by R3.
4. `score_PPR(components) == proj_points` for 300/300 players within 0.011 —
   locked by R1, a gate failure otherwise.
5. Every non-zero scoring key is either scored or listed as `not modeled`; none is
   silently ignored — locked by R4.
6. The Lineup tab shows **nine** slots for this league. K and DEF are either
   projected, or explicitly marked unprojected. A 7-slot "optimal" lineup for a
   9-starter league is a **gate failure**.
7. With `player_components.json` absent, the app shows PPR points behind a visible
   banner and still applies league shape.
8. Gate ends 100% green: `validate_data.py`, `tests/smoke.sh`,
   `node --test tests/feature/*.mjs tests/competition.test.mjs`, playwright —
   at ≥ 277 unit / ≥ 81 e2e.
