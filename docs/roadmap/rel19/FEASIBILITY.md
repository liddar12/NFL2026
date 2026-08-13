# Rel19 — Custom League Scoring: Feasibility Report

**Role:** Feasibility Engineer
**Date of probes:** 2026-08-13 — every network result below was executed live from
this sandbox on this date. Nothing is recalled, assumed, or carried over from the brief.
**Scope:** prove what actually works for D1 (paste a Sleeper league id), D2 (real
component projections), D3 (all surfaces recalculate) — and say plainly where the
evidence stops.

> **Design-only artifact.** No code, test, data, contract or workflow file was created
> or modified. Every probe was a read-only HTTP GET. The browser harness and all
> downloads lived under `/tmp`, never in the repo.

---

## 0. Headline verdicts (read this first)

| # | Verdict | Consequence |
|---|---|---|
| **H1** | **CORS is OPEN on the Sleeper API — but this could not be confirmed in a browser here, because the sandbox proxy blocks browser TLS to *every* host tested, including a known-good positive control.** `api.sleeper.app` returns `access-control-allow-origin: *` on both the GET and the OPTIONS preflight. | Design browser-direct fetch as the primary path — **no Netlify function, no backend.** But treat it as *unverified until it runs on the real domain*, and ship the manual-paste fallback in the same release, not later. §1. |
| **H2** | **K and DST are BUILDABLE, not blocked.** Both are fully derivable from sources the repo already fetches. I computed real 2025 season totals for **all 42 kickers and all 32 team defenses** under the owner's exact scoring rules. | Rel19 can honestly support the owner's 9-starter lineup. This is a genuine pipeline expansion, not a stub. §4. |
| **H3** | **The `espn_id` → `gsis_id` join is DETERMINISTIC and 100% complete.** `players.csv` carries an `espn_id` column; it resolved **300/300** of the current projection pool with zero name matching. | The single biggest technical risk to D2 — joining ESPN-keyed projections to gsis-keyed nflverse components — **does not exist.** §3.2. |
| **H4** | **Component reconciliation is essentially EXACT: 289/300 players match to ≤0.01 points, median difference 0.0000, worst case 6.0.** | The reconciliation gate D2 requires is achievable at a *tight* tolerance, not a loose one. §5. |
| **H5** | **nflverse release assets ARE reachable from this sandbox** (HTTP 200, not the 403 the brief expected). | Rel19 builders can be developed and smoke-tested locally instead of blind. **Do not remove the dormant pattern** — see the caveat in §3.4. |
| **H6** | **The app's "PPR" is ESPN-PPR, which uses 4-point passing TDs.** The owner's league uses 6-point passing TDs *plus* 0.5/completion. | Under the owner's real scoring, **the entire top 12 becomes quarterbacks**, and QBs gain a mean of **+145.6** points. This is not a tweak. §6. |

---

## 1. HARD QUESTION 1 — CORS

### 1.1 What the server sends (curl, conclusive)

`GET https://api.sleeper.app/v1/state/nfl` with `Origin: https://nfl2026.netlify.app`:

```
HTTP/2 200
access-control-allow-origin: *
access-control-allow-credentials: true
access-control-expose-headers: etag,date
cache-control: public, s-maxage=60, stale-while-revalidate=180, stale-if-error=600
```

`OPTIONS https://api.sleeper.app/v1/league/1393691504228184064` (preflight):

```
HTTP/2 204
access-control-allow-origin: *
access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS
access-control-allow-headers: Authorization,Content-Type,Accept,Origin,...
access-control-max-age: 1728000
```

That is a complete, permissive CORS configuration. A plain `fetch()` with no custom
headers and no credentials is a *simple request* — it is not even preflighted — and
`ACAO: *` admits it from any origin.

### 1.2 The browser test I was asked to run — and why it cannot settle it

I built the harness exactly as specified: a temporary page under `/tmp`, served on
`http://127.0.0.1:8781`, loaded in the chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` driven by the repo's Playwright
1.61.1, performing in-page `fetch()` calls.

Getting a *meaningful* result took four iterations, and the iterations are the finding:

| Attempt | Configuration | Result |
|---|---|---|
| 1 | chromium via proxy, no bypass | Page itself failed — proxy returned **405** (it only accepts CONNECT; the localhost page load was a plain-HTTP GET). |
| 2 | + `bypass: 127.0.0.1,localhost` | Page loads (200). Sleeper → `net::ERR_CONNECTION_RESET`. github.com → `net::ERR_CERT_AUTHORITY_INVALID`. Both are **transport** failures — chromium does not trust the sandbox MITM CA. |
| 3 | + pinned the sandbox CA by SPKI (`--ignore-certificate-errors-spki-list=KnP1OnzHv/y42eRQmbGwoYTHcSJF448m6CU5mdngwKk=`, the SHA-256 SPKI of `CN=CCR Upstream Proxy CA (staging)`) | `github.com` now completes TLS and yields a **genuine CORS verdict**: `blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`. **The harness demonstrably works.** Sleeper still `ERR_CONNECTION_RESET` at a consistent ~12.8 s. |
| 4 | Added controls | See below. |

I pinned one specific, documented certificate rather than disabling TLS verification.

**The controls are what make this honest:**

| Probe | ACAO over curl | In-browser result | Reading |
|---|---|---|---|
| `api.github.com/zen` | *(never reached — **403** from egress policy)* | "No ACAO header present" | Not a CORS fact. A policy 403 error page has no ACAO. |
| `site.api.espn.com/.../scoreboard` | ✅ `access-control-allow-origin: *` | `ERR_CONNECTION_RESET` | ESPN is polled directly **from production browsers** in the sibling WC2026 project. A false negative. |
| `raw.githubusercontent.com/.../games.csv` | ✅ `access-control-allow-origin: *` | `ERR_CONNECTION_RESET` | **Positive control fails.** |
| `api.sleeper.app/v1/state/nfl` | ✅ `access-control-allow-origin: *` | `ERR_CONNECTION_RESET` | Same signature as the failing positive control. |

**A known-good positive control fails in exactly the same way as Sleeper.** The
sandboxed browser therefore cannot distinguish "CORS-blocked" from "proxy won't carry
this host's TLS for chromium," and the ~12.8 s uniform reset is a proxy timeout
signature, not a CORS rejection. A real CORS block looks completely different, and I
captured one (the github.com line in attempt 3) to prove the harness detects it.

### 1.3 Verdict and the design that follows

> **CORS VERDICT: OPEN. The browser can fetch `api.sleeper.app` directly, and the PWA
> needs no backend for D1. Confidence: high, from response headers — not from an
> in-sandbox browser, which cannot answer the question at all.**

Because the proof is header-level rather than end-to-end, the design must not *depend*
on it silently. Recommended (in preference order, ship the first two together):

1. **Primary — browser-direct `fetch()`.** No backend, no build step, no key. Matches
   the project's static-host constraint exactly.
2. **Fallback — manual JSON paste, shipped in the same release.** A textarea that
   accepts the raw `scoring_settings` (or the whole league JSON) pasted from the
   browser. Costs one small view, works forever, needs no network, and is the honest
   degrade if H1 is ever wrong on a real device or Sleeper tightens CORS.
3. **Rejected — Netlify function proxy.** Adds a server dependency to a deliberately
   static app to solve a problem the evidence says does not exist. Only revisit if
   the real domain contradicts H1.
4. **Rejected — pipeline-side fetch keyed by a committed league id.** Puts the owner's
   private league id in a public repo and makes a user-level setting a deploy-time
   one. Contradicts D1's "hand-editable afterwards".

**First action on deploy:** load the real domain and confirm the direct fetch. It is a
30-second check that converts H1 from high-confidence inference to fact. Until then,
the fallback carries the release.

---

## 2. HARD QUESTION 2 (part) — the owner league, re-fetched

`GET https://api.sleeper.app/v1/league/1393691504228184064` → **HTTP 200**, no auth.

Every value in the brief is confirmed: `name` Omilia-US, `season` 2026, `status`
pre_draft, `total_rosters` **10**, `playoff_teams` 6, `playoff_week_start` 14,
`roster_positions` `[QB, RB, RB, WR, WR, TE, FLEX, K, DEF, BN, BN, BN, BN]`,
**147 scoring keys**.

`settings` also carries league-shape values the brief did not list, and they matter for
§7: `num_teams` 10, `draft_rounds` 3, `max_keepers` 1, `waiver_type` 1,
`waiver_budget` 100, `trade_deadline` 11, and per-position roster caps
`position_limit_qb` 2, `position_limit_rb` 5, `position_limit_wr` 5,
`position_limit_te` 3, `position_limit_k` 2, `position_limit_def` 2.

> Note `draft_rounds: 3` with a 13-slot roster — this league is configured as a
> **keeper/rookie draft** (`max_keepers: 1`), not a full 13-round startup. Do not
> hardcode `rounds = rosterSize` in the draft room from the league id.

### 2.1 The 147 keys by family, and what each needs

| Family | Keys | Non-zero here | Can we project it? |
|---|---|---|---|
| **Passing** | `pass_yd .04`, `pass_td 6`, `pass_cmp 0.5`, `pass_int -2`, `pass_int_td -4`, `pass_2pt 2`, `pass_cmp_40p 1`, `pass_td_40p 2`, `pass_td_50p 4`, `bonus_pass_yd_400 5` | 10 | ✅ core yes; ⚠️ bonuses need distributions, §5.3 |
| **Rushing** | `rush_yd .1`, `rush_td 6`, `rush_2pt 2`, `rush_40p 1`, `rush_td_40p 2`, `rush_td_50p 4`, `bonus_rush_yd_200 5` | 7 | ✅ / ⚠️ same |
| **Receiving** | `rec 1`, `rec_yd .1`, `rec_td 6`, `rec_2pt 2`, `rec_td_40p 2`, `rec_td_50p 4`, `bonus_rec_yd_200 5` | 7 | ✅ / ⚠️ same |
| **Fumbles** | `fum_lost -2` | 1 | ✅ |
| **Kicker** | `fgm_0_19/20_29/30_39` 3, `fgm_40_49` 4, `fgm_50_59` 5, `fgm_60p` 6, `fgmiss -1`, `xpm 1`, `xpmiss -2` | 9 | ✅ **exact bucket match**, §4.1 |
| **Team DEF/ST** | `sack 1`, `int 4`, `def_td 6`, `safe 2`, `ff 1`, `fum_rec 2`, `blk_kick 2`, `fum_rec_td 6`, `st_td 6`, `st_ff 1`, `st_fum_rec 1`, `def_st_td 6`, `def_st_ff 1`, `def_st_fum_rec 4`, `def_4_and_stop 1`, 7× `pts_allow_*`, 9× `yds_allow_*` | ~30 | ✅ mostly, §4.2; ⚠️ `def_4_and_stop` needs play-by-play |
| **IDP** | `idp_tkl`, `idp_sack`, `idp_int`, … (17 keys) | **0 — all zero** | ➖ **Not needed.** No IDP slot, no IDP scoring. Ignore this family entirely. |
| **Inactive bonuses** | `bonus_fd_*`, `bonus_rec_*`, `bonus_pass_yd_300`, `bonus_rush_yd_100`, `rec_0_4`…`rec_40p`, `tkl*`, `*_ret_yd`, … | **0** | ➖ Must still round-trip through the editor as 0. |

**Roughly 64 of 147 keys are non-zero.** The remaining ~83 are zeros the editor must
preserve faithfully — a user may set any of them later, and silently dropping them
would make a hand-edited profile lossy.

### 2.2 One ambiguity to resolve with the owner, not to guess

The DEF/ST family contains **overlapping keys with different values**: `fum_rec 2.0`
vs `def_st_fum_rec 4.0`, and `ff 1.0` vs `def_st_ff 1.0` vs `st_ff 1.0`. Sleeper's
semantics for which key fires on a given real-world event are not documented in the
API payload, and I could not determine them from the data alone.

**Do not guess.** Either (a) score the unambiguous keys and label the DST projection's
precision honestly, or (b) confirm the intended mapping with the owner. Silently
picking one is exactly the "quietly wrong number" the honesty rule forbids.

---

## 3. HARD QUESTION 3 (part c) — nflverse component availability

### 3.1 Reachability — the brief's expectation was wrong

The brief said "expect 403 = runner-built." **It is not 403.**

| Asset | Result |
|---|---|
| `.../releases/download/stats_player/stats_player_week_2025.csv` | ✅ **HTTP 200**, 8,656,387 B, **19,423 rows × 150 cols** |
| `.../releases/download/stats_player/stats_player_week_2024.csv` | ✅ **HTTP 200**, 8,470,040 B *(first attempt returned a transient 502; retry succeeded)* |
| `.../releases/download/stats_team/stats_team_week_2025.csv` | ✅ **HTTP 200**, 229,660 B, 138 cols |
| `.../releases/download/players/players.csv` | ✅ **HTTP 200**, 7,327,768 B, 25,037 rows |
| `.../releases/download/rosters/roster_2026.csv` | ✅ **HTTP 200**, 923,611 B |
| `.../releases/download/pbp/play_by_play_2025.csv` | ✅ **HTTP 200**, 97,951,481 B |
| `raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv` | ✅ **HTTP 200**, 7,548 rows × 46 cols |
| `api.github.com/...` | ❌ **403** (egress policy) — construct asset URLs by convention, never discover them |

Note the release tag is **`stats_player`**, not `player_stats` (that path 404s).

### 3.2 The join — H3, and the most important result in this report

The projection pool is keyed `espn-<id>` (`scripts/scrape/espn_players.py` line 24:
*"canonical player key is nflverse `gsis_id`; ESPN doesn't expose it"*). nflverse
components are keyed by `gsis_id`. Bridging them looked like the main risk to D2.

**`players.csv` carries an `espn_id` column** (16,752 rows populated). Joining the
current 300 projected players through it:

```
DETERMINISTIC espn_id -> gsis_id join: 300/300 = 100.0%   (zero unmatched)
```

For comparison, fuzzy name matching — the fallback I expected to need — reaches only
94.3% against `roster_2026.csv` and 98.7% against `players.csv`, failing on exactly
the veterans/free agents you would predict (Stefon Diggs, Deebo Samuel, Nick Chubb…).

> **Use the `espn_id` column. Do not build a name matcher for this.** `renames.py`
> stays where it is for the feeds that genuinely need it.

### 3.3 Exact component column names (verified in the 150-col header)

Mapped to the league keys they satisfy:

| League key | nflverse column(s) |
|---|---|
| `pass_yd` | `passing_yards` |
| `pass_td` | `passing_tds` |
| `pass_cmp` | `completions` *(also `attempts`)* |
| `pass_int` | `passing_interceptions` |
| `pass_2pt` | `passing_2pt_conversions` |
| `rush_yd` / `rush_td` | `rushing_yards` / `rushing_tds` |
| `rush_2pt` | `rushing_2pt_conversions` |
| `rec` / `rec_yd` / `rec_td` | `receptions` / `receiving_yards` / `receiving_tds` |
| `rec_2pt` | `receiving_2pt_conversions` |
| `fum_lost` | `sack_fumbles_lost` + `rushing_fumbles_lost` + `receiving_fumbles_lost` |
| `st_td` | `special_teams_tds` |
| `fgm_0_19` … `fgm_60p` | `fg_made_0_19`, `fg_made_20_29`, `fg_made_30_39`, `fg_made_40_49`, `fg_made_50_59`, **`fg_made_60_`** *(trailing underscore)* |
| `fgmiss` | `fg_missed` *(per-bucket `fg_missed_0_19`…`fg_missed_60_` also present)* |
| `xpm` / `xpmiss` | `pat_made` / `pat_missed` |
| `sack` / `int` / `def_td` / `safe` | `def_sacks` / `def_interceptions` / `def_tds` / `def_safeties` |
| `ff` / `fum_rec` | `def_fumbles_forced` / `fumble_recovery_opp` |
| `blk_kick` | `def_fg_blocks` + `def_punt_blocks` + `def_pat_blocks` |

Also present and useful: `passing_40`, `rushing_40`, `receiving_40` (long-play counts,
relevant to the `*_40p` bonuses), `targets`, `target_share`, `air_yards_share`, `wopr`,
`passing_epa`, and the reference totals `fantasy_points` / `fantasy_points_ppr`.

`position` values include **`K`** (569 rows, 42 distinct kickers in 2025 REG). There is
no `DST` row — team defense comes from the team feed, §4.2.

### 3.4 Keep the dormant pattern anyway

H5 says these are reachable *today, from this sandbox*. Two reasons not to treat that
as permanent: the 2024 asset returned a transient **502** on first request (upstream
availability is not guaranteed), and reachability is a property of the current egress
policy, which is not part of this project's contract. **Build these as runner-built and
ship them DORMANT**, exactly like `epa_history` and `injury_history`. The sandbox
reachability is a *development convenience* — it means the builder can be written and
smoke-tested locally instead of blind, which is a real win. It is not a licence to
make the app depend on a live fetch.

---

## 4. HARD QUESTION 2 — K and DST: the verdict

> **VERDICT: ADD THEM. Both K and DST projections are genuinely buildable from
> sources this repo already uses. The honest-degradation option is not needed
> because the honest option is available.**

The brief framed this as "expand the pipeline *or* show the slots as unsupported."
The measurements below remove the dilemma. Showing a 7-slot lineup for a 9-starter
league would be a real honesty violation — and it is now an avoidable one.

### 4.1 Kickers — exact, no modelling compromise

The league's FG buckets (`fgm_0_19`, `20_29`, `30_39`, `40_49`, `50_59`, `60p`) map
**one-to-one** onto nflverse's `fg_made_*` columns. Nothing is approximated.

Scoring real 2025 REG components under the owner's exact kicker rules:

```
Jason Myers        196.0     Cam Little        160.0
Ka'imi Fairbairn   191.0     Will Reichard     158.0
Brandon Aubrey     182.0     Chase McLaughlin  152.0
Cameron Dicker     165.0     Chris Boswell     148.0
                                    42 kickers covered
```

For scale: those totals sit between the **WR12 and WR6** range of the same league's
scoring. A kicker slot this valuable cannot be left unmodelled in a league that starts
one.

### 4.2 Team defense — derivable, with one honest gap

DST needs two things the team feed does not carry directly:

- **Points allowed** → `games.csv` `home_score` / `away_score`, inverted per team.
  This file is *already fetched by the repo* (`scripts/build_market_baseline.py:27`).
- **Yards allowed** → the **opponent's** offensive yards for that week, from
  `stats_team_week` (`passing_yards + rushing_yards`, joined on `opponent_team`).

Everything else (`def_sacks`, `def_interceptions`, `def_tds`, `def_safeties`,
`fumble_recovery_opp`, `def_fumbles_forced`, the three block columns) is a direct
column read.

Scoring real 2025 REG data under the owner's exact DEF rules:

```
HOU 236.0   SEA 211.0   JAX 195.0   LAC 192.0
CLE 190.0   MIN 190.0   DEN 183.0   LA  182.0
        32/32 teams, 17/17 weeks each
```

**The honest gap:** `def_4_and_stop` (1.0 pt) has no column in either feed. It is
derivable from `play_by_play_2025.csv` (97 MB, reachable) but that is a heavier build.
Two acceptable options — both honest, unlike silently dropping it:

- **(a) Ship without it and label the DST projection** as excluding fourth-down stops.
  Impact is small (a handful of points a season) but must be *stated*, not hidden.
- **(b) Derive it from play-by-play.** Correct, but pulls a 97 MB feed into the build.

**Recommendation: (a) for Rel19**, with the label visible on the DST surface, and (b)
as a follow-up if the owner wants it. Also resolve §2.2 before finalising the DST
scorer.

### 4.3 The dormancy consequence

K and DST projections are **new positions with no prior-season baseline in the current
pool** — the ESPN fantasy pool feeding `player_projections.json` is QB/RB/WR/TE only.
Until the runner produces the K/DST feed, the Lineup optimizer **must** show those two
slots as *awaiting data*, naming the missing feed — never as empty, and never by
quietly reverting to a 7-slot lineup. That is the §8 dormancy contract applied to the
one case where the app would otherwise misrepresent league coverage.

### 4.4 A tempting shortcut, and why I recommend against it

`https://api.sleeper.app/projections/nfl/2026?season_type=regular&position[]=K` returns
**HTTP 200** with per-component season projections for every position — including K and
DEF — keyed by *the exact same names as `scoring_settings`* (`pass_cmp`, `pass_td`,
`rec_yd`, `xpm`, `fgm_40_49`, `sack`, `int`, `pts_allow_0`…). It looks like it solves
D2 outright.

**It is `"company": "rotowire"`** — a third-party commercial projection, not a
measurement. Adopting it would replace this project's own model with someone else's,
which is a different product. It also does not fit the owner's league cleanly: kicker
FGs come bucketed only as `fgm_40_49` / `fgm_50p` / `fgm_yds`, so the league's
`fgm_0_19` / `20_29` / `30_39` / `50_59` / `60p` split cannot be scored exactly, and
the DEF rows carry `gp: 1.0` where 17 is expected.

**Recommendation: do not use it as a model input.** It is worth recording as a
*validation cross-check* — an independent number to compare our own K/DST projections
against — provided any display is clearly attributed to Rotowire. That is the same
posture as the display-only market-price rule.

---

## 5. HARD QUESTION 4 — component model and reconciliation

### 5.1 What the baseline actually is (and a correction to the brief)

`scripts/build_predictions.py:340` feeds `project_players()` from
`espn_players.build_player_records(PRIOR_SEASON, teams)`, and
`scripts/scrape/espn_players.py:6` states the league context is `leaguedefaults/3` =
**ESPN standard PPR**. So `prior_season_points` is ESPN's own PPR season total.

**ESPN standard PPR uses 4-point passing TDs.** The app's "PPR" mode is therefore not
neutral — it already embeds a passing-TD convention, and it is the *opposite* end of
the range from the owner's league. This is H6 and it should be stated plainly in the UI.

The projection identity is `proj_points = baseline × Π applied(signal)`, and at day-zero
weights every signal is neutral, so **`proj_points` is currently exactly the
prior-season ESPN-PPR total**. That is what makes the reconciliation below so clean —
and it also means reconciliation will get *harder*, not easier, once signals earn
weight. Build the test now, while the identity is simple.

### 5.2 The reconciliation measurement

I scored 2025 REG nflverse components under ESPN-PPR rules and compared to
`proj_points` for all 300 pool players:

| Metric | Value |
|---|---|
| Players matched | **300/300** |
| Median absolute difference | **0.0000** |
| Mean absolute difference | **0.0950** |
| p95 | **0.0000** |
| Max | **6.0000** |
| Exact (≤0.01) | **289/300** |

Getting there surfaced a real trap worth recording. My first pass showed a max
difference of **12.0** concentrated on return specialists (Parker Washington, Rashid
Shaheed, Chimere Dike, Jaylin Lane, Isaiah Williams). The cause was the omitted
**`special_teams_tds`** column — 2 return TDs × 6. Adding it collapsed the error to
near zero. **A component scorer that forgets return TDs looks correct on 95% of players
and is silently wrong on exactly the ones fantasy managers argue about.**

The 11 remaining players differ by exactly 6.0 — one uncredited TD each, most likely
fumble-recovery TDs, and worth one more pass during implementation.

### 5.3 The test that must gate the build

> **RECONCILIATION TEST (blocks the gate):** for every player in
> `player_projections.json`, score the emitted components under **ESPN-PPR**
> (`pass_yd .04`, `pass_td 4`, `pass_int -2`, `rush_yd .1`, `rush_td 6`, `rec 1`,
> `rec_yd .1`, `rec_td 6`, `st_td 6`, `2pt 2`, `fum_lost -2`) and compare to that
> player's existing `proj_points`.
>
> **FAIL the gate if:** any single player differs by **> 0.5 points**, OR the mean
> absolute difference exceeds **0.10**, OR fewer than **95%** of players match within
> 0.01, OR coverage drops below **100%** of the pool.

Those thresholds are set from measured behaviour with headroom, not invented. The
per-player bound is what actually protects the app: a mean-only test would let one
player's numbers move badly while the average stayed clean.

**Two things the test must not do:**

- **Do not reconcile the `*_40p` / `bonus_*` keys against the PPR total** — they are
  worth 0 in ESPN-PPR, so they are invisible to this test. They need their own
  sanity bounds (e.g. `pass_td_40p ≤ pass_td`, `bonus_pass_yd_400` count ≤ games).
  This is where a component model is most likely to produce nonsense unnoticed.
- **Do not let the test pass on a reduced pool.** Coverage is part of the assertion.

### 5.4 Projecting the components

The cleanest structure, and the one that makes reconciliation hold *by construction*:
derive a per-component recency-weighted baseline from the same weekly data, then apply
the **same** signal multiplier the scalar model applies. Then
`score_ppr(components) ≡ baseline_ppr × Π applied(signal) ≡ proj_points` up to the
scoring-completeness gap measured in §5.2.

Distributional keys (`pass_cmp_40p`, `bonus_pass_yd_400`, `rec_td_50p`, …) cannot come
from season totals — they need per-game or per-play rates. `passing_40` / `rushing_40`
/ `receiving_40` supply the long-play counts directly; the 400-yard and 200-yard game
bonuses need a per-game distribution, which the weekly rows already provide. Where a
rate cannot be honestly estimated, **emit zero and mark the key unsupported** rather
than inventing a frequency.

---

## 6. HARD QUESTION 3 — league shape, and how much it actually moves

### 6.1 The scoring impact, measured

Scoring the same 300 players under the owner's real scoring vs ESPN-PPR:

```
   ESPN-PPR order                Omilia-US order
 1 Christian McCaffrey 416.6     Matthew Stafford    636.4
 2 Puka Nacua          375.0     Drake Maye          591.0
 3 Bijan Robinson      370.8     Dak Prescott        575.8
 4 Jahmyr Gibbs        366.9     Josh Allen          574.1
 5 Josh Allen          364.6     Trevor Lawrence     566.7
 6 Jonathan Taylor     362.3     Jared Goff          561.6
 7 Jaxon Smith-Njigba  359.9     Bo Nix              548.8
 8 Drake Maye          352.0     Caleb Williams      537.7
 9 Matthew Stafford    350.4     Justin Herbert      508.9
10 Trevor Lawrence     338.2     Jalen Hurts         498.1
11 Amon-Ra St. Brown   324.0     Baker Mayfield      495.4
12 De'Von Achane       322.8     Patrick Mahomes     487.2

QB delta (Omilia − PPR): mean +145.6, max +286.0 (Matthew Stafford)
```

**The entire top 12 becomes quarterbacks.** Stafford moves from 9th to 1st. The app
currently shows the left column to a manager whose league is the right column. This
validates D2's insistence on real components — no scalar transform of a PPR total
produces this, because `pass_cmp 0.5` is not recoverable from a PPR number.

*(Caveat: this ranks by raw points, which is why QBs dominate. VOR against a
one-QB replacement level will compress it — which is precisely §6.2's point, and
precisely why scoring and shape must land together.)*

### 6.2 Where league shape is hardcoded

| Location | Current | Owner's league | Status |
|---|---|---|---|
| `app/team-logic.js:29` `STARTER_SLOTS` | `QB1,RB1,RB2,WR1,WR2,TE1,FLEX` (7) | **9** — adds K, DEF | ❌ frozen, no K/DEF |
| `app/team-logic.js:32` `BENCH_SLOTS` | `BN1..BN6` (6) | **4** | ❌ frozen |
| `app/team-logic.js:725` `STARTER_DEMAND` | `{QB:1,RB:2,WR:2,TE:1}` | + `{K:1,DEF:1}` | ❌ frozen, drives `replacementLevel` |
| `app/ros.js:104` `STARTER_CUTOFFS` | `{QB:12,RB:24,WR:36,TE:12}` — comment says *"for a 12-team league"* | **10-team → `{QB:10,RB:20,WR:30,TE:10,K:10,DEF:10}`** | ❌ hardcoded 12 |
| `app/team-logic.js:632` `POSITION_CAPS` | `{QB:2,DEF:1,DST:1,K:1}` | `position_limit_*`: QB 2, K 2, DEF 2, RB 5, WR 5, TE 3 | ⚠️ partly wrong |
| `app/draft-sim.js:40` `DEFAULT_ROSTER` | `{qb,rb,wr,te,flex,bench}` | needs `k`, `def` | ⚠️ parameterised but no K/DEF |
| `app/draft-sim.js:287` `createDraft` | `leagueSize = 12` default | 10 | ✅ already a parameter |
| `app/auction.js` `marketDollars(…, leagueSize, budget, rosterSize=13)` | parameterised | 10 × 13 | ✅ already a parameter |
| `app/auction.js:42` `MARKET_DECAY` | *"Fitted to the classic 12-team/$200 AAV curve"* | 10-team | ⚠️ fitted constant, needs a stated caveat |

**The good news:** `draft-sim.js` and `auction.js` already take `leagueSize` and a
roster config. The blockers are the **frozen constants in `team-logic.js` and
`ros.js`** — and `rosterShape()` (`draft-sim.js:49`), which builds slots for
qb/rb/wr/te/flex/bench only and has no concept of K or DEF.

Replacement level is where this bites hardest: `replacementLevel()` returns the
`(demand+1)`th best available. A 10-team league with 9 starters has a materially
different replacement level than the hardcoded 12-team/7-starter assumption, and that
number flows straight into **VOR → ADP value flags → auction dollars**. Shape is not
cosmetic; it is arithmetic, and it must ship together with scoring — shipping scoring
alone would produce confidently wrong VOR.

---

## 7. HARD QUESTION 6 — backward compatibility: tests at risk

`scoringAdjust()` is called from **`app/team-logic.js`** (10 sites: lines 180, 193,
219, 380, 418, 535, 607, 735), **`app/views/team.js`**, and **`app/draft-sim.js`**.

Named tests that will break if `scoringAdjust`, `STARTER_SLOTS`, `STARTER_DEMAND`, or
`replacementLevel` change behaviour:

| File | Test |
|---|---|
| `tests/feature/team_logic.test.mjs` | `scoringAdjust: ppr 300 with 100 receptions -> half 250, std 200 (exact)` |
| | `scoringAdjust: zero receptions makes every mode identical` |
| | `slotEligible truth table: FLEX takes RB/WR/TE (not QB); BN takes any modeled` |
| | **`v1 fitScore is byte-for-byte frozen on the fixed fixture`** ← the strictest |
| | `fitScoreV2 OFF path … is byte-identical to v1` |
| | `recommend respects the scoring mode (std demotes a reception-heavy WR)` |
| | `weeklyPoints: 18 floats scaled by seasonAdj/seasonPpr; bye stays 0` |
| | `teamWeeklyTotals: 18 summed starter floats, byes drop to the other starter` |
| `tests/feature/team_vor.test.mjs` | **`STARTER_DEMAND contract: QB 1, RB 2, WR 2, TE 1`** ← breaks on K/DEF |
| | `replacementLevel: (demand+1)th best; FLEX adds +1 to the best RB/WR/TE position` |
| | `replacementLevel: fewer than demand+1 available -> 0; unmodeled -> 0` |
| | `vorScore: adjusted points minus own-position replacement level` |
| | `vorScore: honors the scoring mode via receptions_prior` |
| | `bestPickNow:` (8 tests — VOR order, caps, scarcity, determinism) |
| `tests/feature/auction.test.mjs` | `marketDollars: the draftable pool absorbs EXACTLY the room budget` |
| | `fairDollars: better players cost more, floor is $1, budget-scaled` |
| | `a full simulated auction fills every roster and never overdraws` |
| | `planBudget: stars front-loads, balanced spreads, both sum exactly` |
| `tests/feature/lineup.test.mjs` | `bestLineup fills dedicated slots then the best leftover FLEX` |
| | `lineup optimizer self-check passes` |
| | `bye/zero-projection players sink to the bench, never start` |
| `tests/feature/draft_sim.test.mjs` | `rosterShape` / snake-order tests |

**Coexistence strategy — additive, not a replacement.** `scoringAdjust(seasonPpr,
receptions, mode)` must keep its exact signature and arithmetic, and `'ppr' | 'half' |
'std'` must keep meaning what they mean today (including the ESPN 4-pt-pass-TD
convention, §5.1). A custom profile becomes a **fourth mode** that routes to a
component scorer, leaving the three-mode path untouched. The frozen-fixture test then
still passes byte-for-byte, because with no profile loaded nothing about the v1 path
changed.

`STARTER_DEMAND` is the one contract that cannot be preserved as a frozen literal if
K/DEF are added. Keep the exported default exactly as-is (so its test passes unchanged)
and derive the *active* demand from the league profile at call time, defaulting to the
frozen literal when no profile is loaded.

---

## 8. HARD QUESTION 5 — dormancy

Components are runner-built (§3.4), so there is a window where a user can connect a
league whose scoring the app **cannot yet compute**. The rule:

> **If a custom profile is loaded but components are absent, the app must NOT display
> numbers computed by `scoringAdjust()` as if they honoured that profile.**

Showing PPR-derived values under a "6-pt pass TD, 0.5/completion" header would be off
by the **+145.6 mean QB error** measured in §6.1 — the single most damaging silent
failure available in this release.

Required behaviour before components exist:

1. The scoring page accepts, validates, stores and edits the profile — **always
   works**, it is pure data and needs no feed.
2. Every player surface keeps showing PPR/half/std numbers **labelled as PPR**, with a
   visible, non-dismissable notice that custom scoring is awaiting the component feed
   and naming the feed.
3. **No blending, no scaling, no approximation** — do not scale a PPR total by a
   ratio derived from the profile. That is the fabrication the honesty rule forbids,
   and §6.1 proves it cannot work.
4. K and DEF lineup slots render as *awaiting data* (§4.3).
5. A `components_available: false` flag drives all of the above from one place.

---

## 9. HARD QUESTION 7 — the self-learning boundary

**Plainly: custom scoring does not touch the promotion gate, in either direction.**

The never-regress gate evaluates **game-outcome** predictions — win probability, scored
by log-loss against FINAL results. A fantasy scoring profile changes how *player points*
are totalled. These are disjoint. Concretely:

| Affected by a custom profile | Not affected |
|---|---|
| Player point totals on every surface | Elo ratings, `team_strength.json` |
| VOR, replacement level, ADP value flags, auction dollars | `game_predictions.json`, win probabilities |
| Lineup optimizer, Compare, draft room ordering | The promotion gate and signal weights |
| — | `model_tuning.json`, the walk-forward optimizer |

A custom profile must therefore **never** write to the signal registry, `meta.json`
weights, or any snapshot the harness resolves. It is a *presentation-and-valuation*
layer over projections, not a model input. Anything else would let a per-user setting
contaminate a shared, measured model.

**What a genuine player-level learning loop would require**, per the sibling design at
`docs/roadmap/rel18/BACKTEST_DESIGN.md` (weekly fantasy actuals ≈ 0.10 MB/season):

1. **Point-in-time locked player projections** — component-level, archived weekly in
   the existing `data/snapshots/` pattern, immutable once written.
2. **Weekly component actuals** — `stats_player_week_{season}.csv`, already proven
   reachable (§3.1). The 0.10 MB/season figure is consistent with what I measured
   (8.6 MB raw for 150 columns; the fantasy-relevant subset is far smaller).
3. **A scoring-profile-aware grader** — score both locked projection and actual under
   the *same* profile, then measure error (MAE/RMSE per position).
4. **A separate promotion gate for player projections**, with its own baseline and
   never-regress rule. It must not share the game gate's baseline: an improvement in
   fantasy-point accuracy is not evidence about win probability.
5. **Profile-conditional evaluation.** A signal that improves accuracy under 6-pt
   passing TDs may not under 4-pt. Either fit against a canonical profile and treat
   others as display, or carry per-profile weights — the first is far simpler and is
   what I would recommend.

Steps 1–2 are feasible with sources proven above. Steps 3–5 are a design in their own
right and are **out of scope for Rel19** — Rel19 should ship the scoring layer without
claiming any learning benefit from it.

---

## 10. HARD QUESTION 8 — storage and sharing

No login exists and none may be added, so the profile is device-local. Recommendation,
consistent with how roster and AI+ already persist:

| Concern | Recommendation |
|---|---|
| **Where** | `localStorage`, one key (e.g. `nfl2026.league_profile`), same pattern as roster/AI+. |
| **What** | The **complete** payload: all 147 scoring keys (including the ~83 zeros, §2.1), `roster_positions`, `total_rosters`, the `position_limit_*` caps, plus `league_id`, `name`, a `source` (`sleeper` \| `manual` \| `edited`), a `fetched_utc`, and a schema `version`. Storing only non-zero keys makes hand-editing lossy. |
| **Sharing** | A hash link (`#/scoring?p=<base64url-json>`). The payload is a few KB — well within URL limits — and needs no backend. Import must land in a **review** state the user confirms, never silently overwriting a profile. |
| **Cross-device** | No login means **no sync, and the app must say so.** Re-pasting the league id on a second device re-fetches the same scoring — that is the honest answer, and it is a good one. Manual edits do not travel; the share link is how you move them. |
| **Privacy** | A league id is a public identifier (it fetches unauthenticated, §2), so a share link leaks nothing that is not already public. Still, do not put it in analytics or any committed file. |
| **Provenance** | Track edits per key so the UI can distinguish *fetched from Sleeper* from *hand-edited*, and offer re-fetch without discarding edits. D1 requires values stay hand-editable; without provenance a re-fetch silently destroys the user's work. |

---

## 11. Consolidated verdict table

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Can the browser fetch `api.sleeper.app` directly? | ✅ **YES** (headers). ⚠️ Not confirmable in-sandbox — a known-good positive control fails identically. | §1.1–1.3 |
| 1b | Which fallback? | **Manual JSON paste**, shipped alongside. No backend. | §1.3 |
| 2 | K and DST — add or degrade? | ✅ **ADD.** Both fully derivable; real 2025 numbers computed for 42 K and 32 DST. | §4 |
| 2b | Any DST gap? | ⚠️ `def_4_and_stop` needs play-by-play. Ship labelled, or derive later. Plus the §2.2 key ambiguity. | §4.2 |
| 3 | League shape flow-through | ⚠️ `draft-sim`/`auction` already parameterised; `team-logic` + `ros` constants are frozen and must change. | §6.2 |
| 4 | Component reconciliation | ✅ **289/300 exact**, median 0.0000, max 6.0. Gate spec written. | §5.2–5.3 |
| 4b | Biggest scorer trap | ⚠️ Omitting `special_teams_tds` — silently wrong by 12.0 on return men. | §5.2 |
| 5 | Dormancy | ✅ Defined: PPR labelled as PPR, no scaling, K/DEF slots await data. | §8 |
| 6 | Backward compatibility | ✅ Additive 4th mode; 20+ named tests at risk listed. | §7 |
| 7 | Self-learning boundary | ✅ **No effect on the Elo gate**, either way. Player loop scoped out. | §9 |
| 8 | Storage / sharing | ✅ localStorage + hash link; no cross-device sync, stated honestly. | §10 |
| — | nflverse reachable from sandbox? | ✅ **HTTP 200** (brief expected 403) — but keep the dormant pattern. | §3.1, §3.4 |
| — | espn_id → gsis_id join | ✅ **300/300 deterministic** via `players.csv`. No name matcher needed. | §3.2 |
| — | App's "PPR" convention | ⚠️ **ESPN-PPR = 4-pt passing TDs.** Owner's league = 6. Top 12 becomes all QBs. | §5.1, §6.1 |
| — | Sleeper's own component projections | ➖ Available but **Rotowire-authored**; cross-check only, never a model input. | §4.4 |

---

## 12. Reproducing these probes

All commands were read-only GETs run from this sandbox on 2026-08-13.

```bash
# League (public, no auth)
curl -s https://api.sleeper.app/v1/league/1393691504228184064   # 200, 147 scoring keys
curl -s -D - -o /dev/null -H "Origin: https://example.com" \
     https://api.sleeper.app/v1/state/nfl                       # access-control-allow-origin: *

# nflverse (note the release tag is stats_player, NOT player_stats)
B=https://github.com/nflverse/nflverse-data/releases/download
curl -sL $B/stats_player/stats_player_week_2025.csv   # 200, 8,656,387 B, 19,423 rows x 150 cols
curl -sL $B/stats_team/stats_team_week_2025.csv       # 200,   229,660 B, 138 cols
curl -sL $B/players/players.csv                       # 200, 7,327,768 B — carries espn_id
curl -sL https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv  # 200

# Browser CORS harness (temporary, /tmp only)
#   node + @playwright/test 1.61.1, chromium-1194, proxy bypass for 127.0.0.1,
#   sandbox CA pinned by SPKI (KnP1OnzHv/y42eRQmbGwoYTHcSJF448m6CU5mdngwKk=).
#   Result: transport-level ERR_CONNECTION_RESET for Sleeper AND for the
#   raw.githubusercontent.com positive control -> harness cannot answer CORS here.
#   It DID return a true CORS verdict for github.com, proving detection works.
```

---

## 13. What I could not determine

Stated explicitly, so nothing here is mistaken for a proven fact:

1. **End-to-end browser CORS against Sleeper.** Header evidence is strong and the
   design accounts for it, but only a load on the real domain settles it. §1.3 names
   this as the first post-deploy check.
2. **Sleeper's exact DEF/ST key semantics** — which of `fum_rec` / `def_st_fum_rec` /
   `st_ff` / `def_st_ff` fires on which event. Needs owner confirmation. §2.2.
3. **The 11 players with a 6.0 reconciliation residual.** Almost certainly uncredited
   fumble-recovery TDs; worth one pass during implementation. §5.2.
4. **Whether nflverse reachability persists.** One transient 502 observed. This is
   exactly why §3.4 keeps the dormant pattern.
5. **Whether `roster_2026.csv` is final.** It exists and is populated, but it is
   pre-season; 16 currently-projected veterans are unrostered in it. The `players.csv`
   join is unaffected (100%), but K/DST *team* assignments will move before Week 1.
