# R30 — deep RCA findings

Produced by a 12-partition audit (one agent per disjoint domain), each domain's findings then
put to a second agent briefed to REFUTE them and to default to refuted when uncertain.

- **67 findings survived** adversarial verification; **20 were refuted**.
- Severity: 8 blocker, 39 major, 20 minor.

A refuted finding is NOT a finding. Three of them refuted the seeds this sweep was given,
including the claim that the OURS/AUC value cell should be gated on auction mode — it is an
app-wide valuation convention shown on PLAYERS too, and gating it would delete the app's own
VOR price from the default board.

Every entry below names the file and line the verifier personally read.


## BLOCKER — 8

### `auction-engine-kdef-caps-deadlock`

**A league that seats a K or DEF with the minimum bench can never fill a roster — the auction halts and finishes with a 4-of-13 team**

- **Where:** `app/auction.js:294`
- **What the user sees:** Set BENCH=4 (the ROSTER_BOUNDS minimum) and K=1 and/or DEF=1 in the DRAFT SIMULATOR settings grid (all three are steppers shipped in R28), pick AUCTION, START, then tap SIM NOMINATION repeatedly. After 90 of 156 sales the room stops: autoNominate() returns -1 because the team on the clock (12 players, 13 slots) needs nothing it can express, team.js:3800-3804 then sets auction.done = true and calls finishAuction(). The AUCTION RESULT card is shown with MY roster at 4 players out of 13 (measured: {RB:2, QB:1, WR:1}, spent $191) and a full score sheet — 'LOST TO THE ROOM BY 42.3 PTS · rank 8/12'. 64 of the 960 roster configs the settings grid can produce are affected; every one of them is a bench-4 config with a K or DEF seat.
- **Evidence:** teamNeedsPos() builds its cap table with only four keys:
  const caps = {
    QB: geo.caps.QB != null ? geo.caps.QB : (geo.demand.QB || 0) + 1,
    RB: (geo.demand.RB || 0) + nFlex + 1,
    WR: (geo.demand.WR || 0) + nFlex + 1,
    TE: (geo.demand.TE || 0) + 1,
  };
  ...
  return (counts[pos] || 0) < (caps[pos] || 0) + Math.max(0, geo.bench.length - 4);
caps.K and caps.DEF are undefined, so a K/DEF's whole allowance is `Math.max(0, bench.length - 4)` = 0 at bench 4. team-logic derivedCaps() DOES define K:1 and DEF:1 (app/team-logic.js:1092 POSITION_CAPS) and geo.caps carries them, but this table drops them.
For {qb:1,rb:2,wr:2,te:1,flex:1,bench:4,k:1,def:1}: shape.size = 13 while the per-position capacity sums to QB2+RB4+WR4+TE2+K0+DEF0 = 12, so `total >= geo.all.length` at line 301 is never reached and no team can ever be full. Driving the app's own loop (autoNominate -> nominate -> myGuidance -> resolveBids -> sellTo) against data/adp.json: halted=true, my roster 4/13, 90 sales. Same halt with an offence-only board (my roster 3/13), so it does not even need K/DST rows to be loaded.
- **Verifier's correction:** Mechanism and reachability are exactly as described; two details differ. (1) My reproduction finished with MY roster at 3/13 ({RB:2, WR:1}, $190 spent), not 4/13 — the exact stall roster varies with the adjusted-points source, so quote it as 'three or four of thirteen' rather than a fixed figure. (2) The failure is stronger than 'the room stops': because per-position capacity (12) is strictly less than shape.size (13), NO team can ever be full, so a bench-4 K/DEF auction can never complete normally under any seed — the -1 halt is the only exit. Note the deadlock does not require any K/DST rows on the board: roomBoardRows (team.js:3413-3423) only appends them when a saved profile seats them, and the halt reproduces on an offence-only board.
- **Proposed fix:** Give teamNeedsPos an explicit K/DEF/DST entry driven by the shape, e.g. add `K: geo.caps.K != null ? geo.caps.K : (geo.demand.K || 0), DEF: ..., DST: ...` and do NOT add the bench-slack term to them (nobody benches a second kicker). That makes capacity >= shape.size for every config the grid can build, and is the same cap team-logic already computes.

### `auction-engine-kdef-never-actually-drafted`

**R27/R28 made K/DEF draftable but no team ever ends up with one — the K1/DEF1 starters finish empty and are silently scored as zero**

- **Where:** `app/auction.js:440`
- **What the user sees:** In a working K/DEF league (12 teams, $200, QB1/RB2/WR2/TE1/FLEX/K1/DEF1 + 6 bench), run the auction the way the app tells you to — SIM NOMINATION, then the bid the BLOCK panel advises. You finish 15/15 with SIX running backs and SIX wide receivers, zero kickers and zero defences, in a league whose roster requires one of each. Across seeds 1/7/42/101/999/20260901 my team took a K or DEF exactly zero times; the whole 12-team room took 2 kickers and 0-2 defences out of the 24 it needs. The AUCTION RESULT card then reports 'BEAT THE ROOM BY 238.8 PTS · rank 1/12' for a roster that cannot legally be started, because startersTotal() leaves K1 and DEF1 unfilled and adds 0 for them without saying so.
- **Evidence:** autoNominate() ranks the entire board by MARKET price only:
  const m = a.market.get(String(a.board[i].gsis_id)) || MIN_BID;
  if (m > bestVal) { bestVal = m; best = i; }
K/DEF sit at the MIN_BID floor by design (fairDollars:236 gives them zero VOR, and they are appended past poolN so marketDollars gives them $1), so they are the last thing the room will ever nominate — and 212 offensive rows cover all 180 slots before any kicker is reached. teamNeedsPos (line 302) also never distinguishes 'this team has an EMPTY K1 STARTER slot' from 'this team has bench room': at bench 6 the K allowance is `Math.max(0, 6 - 4)` = 2, i.e. K is treated as generic bench slack that permits TWO kickers and demands none. nominationAdvice() cannot help either: fair $1 vs market $1 classifies NEUTRAL, so K/DEF never appear in the BAIT or TARGET lists. Measured end state (seed 42, real adp.json + kdst_projections.json on the board): my 15 players = {RB:6, QB:2, TE:1, WR:6}, roomK=2, roomDEF=0, sheet {mine:1726.5, margin:238.8, rank:1}. app/draft-sim.js:546-566 startersTotal() fills each shape slot with the best eligible player and simply adds nothing when none exists.
- **Verifier's correction:** Confirmed. One numeric correction: seed 42's margin measured 235.3, not 238.8 (the difference is the adjusted-points source; mine=1726.5 matches exactly). Also worth stating precisely why the room can skip them: 182 of the 212 adp.json rows carry a gsis_id and autoNominate skips id-less rows, so 182 nominatable offensive players cover all 180 roster slots before any $1 K/DEF row is ever the highest-market option — the 2 kickers that do get bought are the residue of teams hitting their offensive position caps, not the K1 slot being expressed as a need.
- **Proposed fix:** Two parts. (1) Make an unfilled STARTER slot a need the room can express: teamNeedsPos should return true for K/DEF whenever counts[pos] < geo.demand[pos], and autoNominate should prefer a position the nominating team still has an empty starter slot for over raw market price once its offensive starters are filled. (2) Have scoreAuction/startersTotal report the slots it could not fill (e.g. return an `emptySlots` list) so the result card can say 'K1 and DEF1 were never filled' instead of scoring them as a silent zero.

### `scoring-consistency-compare-ignores-mode-and-extras`

**COMPARE calls withLeagueExtras and then never reads it; PROJ PTS is raw full-PPR and ignores the scoring mode entirely**

- **Where:** `app/views/compare.js:167`
- **Criterion:** tests/feature/stale_text.test.mjs:194-219 — "any view that holds a weekly map AND converts season points must call withLeagueExtras… it would disagree with every other tab."
- **What the user sees:** Set the scoring mode to STD (the toggle on PLAYERS/TEAM — no league import needed) and compare Christian McCaffrey against Jonathan Taylor. The PLAYERS tab shows CMC 314.6 and Taylor 316.3, i.e. Taylor ahead. COMPARE shows PROJ PTS 416.6 vs 362.3 and its centre rail crowns CMC with a "PROJ" edge chip. The app tells the user opposite things about the same two players in two tabs. With the shipped pool there are 3,914 such PPR-vs-STD order flips. Separately, the `withLeagueExtras` call at compare.js:141 is entirely inert — no code path in the file ever reads `extra_pts` — so a pass_cmp league's quarterbacks are priced at zero extra here while PLAYERS prices them correctly (Dak Prescott 313.8 on COMPARE vs 515.8 on PLAYERS).
- **Evidence:** app/views/compare.js:141 `const weeklyById = withLeagueExtras(weeklyRaw, profile);`
The returned map is used only for availability, RoS, SoS, playoff SoS and bye (compare.js:164-176). The only reference to `extra_pts` in the whole app outside team-logic is app/views/players.js:338 (`renderLeagueExtra`), never compare.js.
app/views/compare.js:167 is the whole season-points path:
```
      proj: projected ? Number(p.proj_points) || 0 : null,
```
`p.proj_points` is documented as a FULL-PPR season total (app/draft-sim.js:244). `scoringAdjust` is never imported into compare.js, and `SCORING_KEY`/`loadScoring` is never read there (grep for SCORING_KEY returns only players.js, team.js).
Rendered at compare.js:281 `row('PROJ PTS', m.projected ? fix1(m.proj) : noFeed)` and used for the winner chip at compare.js:230 `edge('PROJ', A.proj, B.proj, 'high')`.
The green-gate blind spot: tests/feature/stale_text.test.mjs:214 asserts only `/withLeagueExtras\s*\(/.test(src)` — a grep for the call, which passes while the call does nothing.
- **Verifier's correction:** Two separable defects, both real: (a) the mode gap, which needs NO league import and hits any user who flips PLAYERS/TEAM to STD or HALF — the winner chip can contradict the PLAYERS ordering; (b) the inert withLeagueExtras call, which only bites a pass_cmp league. (a) is the blocker; (b) is the R28-class dead wiring plus a comment that describes a conversion the file does not perform.
- **Proposed fix:** Read the shared scoring mode (the same `nfl2026.scoring.v1` key players.js:96 and team.js:82 use) and convert: `proj: projected ? scoringAdjust(Number(p.proj_points) || 0, w && w.receptions_prior, mode, extraPtsOf(w)) : null`, and label the row `PROJ PTS · <MODE>` so the number says which table it is in. Strengthen the stale_text assertion from "calls withLeagueExtras" to "reads extraPtsOf/extra_pts" so an inert call cannot pass.

### `scoring-consistency-team-adjbyid-drops-league-extras`

**team.js builds its main season-points map with a 3-arg scoringAdjust, silently dropping the league's pass_cmp points on the same page that shows them**

- **Where:** `app/views/team.js:1307`
- **Criterion:** Standing rule R29 as stated in app/team-logic.js:453-478 and tests/feature/stale_text.test.mjs:194 — "EVERY SURFACE PRICES THE SAME PLAYER THE SAME WAY"; "Two surfaces quoting different points for the same quarterback is a worse bug than not pricing the rule at all."
- **What the user sees:** In a league that scores Sleeper `pass_cmp` (imported via the Sleeper button; e.g. 0.5/completion), the TEAM tab quotes two different season totals for the same quarterback at the same moment. With the shipped data and pass_cmp=0.5: the BEST FIT panel's reason line reads "Dak Prescott — Projects 515.8 season points (PPR)" while the player-finder row and his QB1 slot chip a few pixels away read "313.8" / "313.8 · SZN", and the STARTERS SEASON TOTAL adds him in at 313.8. The finder's default "best available" sort is built on the same wrong map, so it lists Trevor Lawrence (338.2) above Dak (313.8) while BEST FIT ranks Dak above Lawrence (515.8 vs 508.7). The TEAM tab's own auction price is affected too — `ourDollars()` feeds `adjById` into `fairDollars`, so the OURS $ shown for a QB on TEAM differs from the OURS $ the PLAYERS tab shows for the same player (players.js:745 does pass `extraPtsOf(w)`), directly contradicting players.js's stated intent that "one player cost one price across the two tabs".
- **Evidence:** app/views/team.js:1094 stamps the map: `weeklyById = withLeagueExtras(weeklyById, savedProfile);` — so entries DO carry `extra_pts`.
Then app/views/team.js:1304-1310 throws it away:
```
  players.forEach((p) => {
    const id = String(p.gsis_id);
    const e = weeklyById.get(id);
    const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode);   // <-- no 4th arg
    adjById.set(id, adj);
    if (e) scaledById.set(id, weeklyPoints(e, adj, p.proj_points));
  });
```
Every other call site in the repo passes the 4th argument, e.g. app/team-logic.js:1200 `scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e))` and app/views/players.js:655. app/team-logic.js:438-449 defines `extraPts` as the only channel for the league rate.
Blast radius of `adjById`/`scaledById`: team.js:1322 (finder sort), :1641 (slot SZN chip), :1749 (finder sort comparator), :1814 (finder points cell), :2009-2010 (weekly grid + STARTERS SEASON TOTAL), :1272 via `adjPointsMap()` -> :3648/:3760 (draft room board pricing), :1385 (`ourDollars` adjOf).
Data check: data/player_weekly.json carries `completions_prior` for 52 quarterbacks (Dak Prescott espn-2577417 = 404.0, proj_points 313.78), so 404*0.5 = 202.0 points go missing.
- **Verifier's correction:** Correct as written, with one scoping note: the divergence is triggered only by a saved/imported profile with a non-zero pass_cmp (any other league gets identical numbers). Within that league the claim is exact — team.js:1307 is the only scoringAdjust call site in the repo missing the extras argument.
- **Proposed fix:** Pass the extras through, exactly as every other call site does: `const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e));` (import `extraPtsOf` alongside `scoringAdjust` at team.js:31). Add a regression test that mounts TEAM under a profile with `pass_cmp` and asserts the finder's points cell for a QB equals the value in that QB's BEST FIT "Projects N season points" line.

### `cross-view-parity-team-board-drops-league-extras`

**TEAM's board/total/price drop the league's own scoring rules that PLAYERS applies — the R29 feature is wired on one tab and dead on the other**

- **Where:** `app/views/team.js:1307`
- **What the user sees:** Import a Sleeper league that scores pass_cmp (e.g. 0.5/completion) and open PLAYERS: Josh Allen reads 524.1 (364.6 base + 159.5 from 319 completions_prior) with a "+159.5 LEAGUE RULES" chip. Switch to TEAM and the same player's finder card, his slot chip and the roster SEASON TOTAL read 364.6. His OURS auction dollars differ between the two tabs as well. Worse, TEAM disagrees with itself: BEST FIT / BEST PICK NOW go through team-logic (which does pass extraPtsOf), so the recommendation engine values Allen at 524.1 while the number printed next to his name says 364.6, and the "best available" ordering is computed on a scale the page never shows.
- **Evidence:** app/views/team.js:1094 stamps the extras — `weeklyById = withLeagueExtras(weeklyById, savedProfile);` — and then line 1307 throws them away: `const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode);` (4th arg `extraPts` omitted). This is the ONLY scoringAdjust call site in the app that omits it; app/team-logic.js:588, 601, 629, 793, 832, 1062, 1200 and app/views/players.js:655, 745, 982 all pass `extraPtsOf(entry)`. adjById is what team.js prints (line 1641 `${fix1(adjById.get(id))} · SZN`, line 1814 `<span class="cd-pts">${fix1(adjById.get(id))}`), what it sorts by (1323, 1749) and what it sums (2010 `starterIds.reduce((sum, id) => sum + (adjById.get(id) || 0), 0)`), and it is the `adjOf` behind the auction price sheet (1385-1388). data/player_weekly.json carries completions_prior for 52 QBs, so this is live data, not a hypothetical. The gate misses it: tests/feature/players_view.test.mjs:406 builds its cross-tab price-equality assertion from `normalizeProfile(null)`, i.e. DEFAULT_PROFILE, which has no pass_cmp — so the equality it proves is only the case where the bug is invisible.
- **Proposed fix:** Pass the extras at team.js:1307: `const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e));` (import extraPtsOf from team-logic alongside scoringAdjust). Add a cross-tab test built on a profile with `scoring.pass_cmp` set, asserting players.js's ourDollars map and adjById-derived room price agree for a QB with completions_prior.

### `model-slate-parlays-market-prob-is-parlay-model-prob`

**Book de-vigged spread/total probabilities are written into the parlay leg's model_prob (market price IS the parlay probability)**

- **Where:** `scripts/models/parlay_builder.py:278`
- **What the user sees:** On #/parlays, GAME parlay "SEA -3.5" shows "MODEL 50 / IMPL 52 / −2". The 50 is not the model's number — it is The Odds API's de-vigged home-cover probability, fetched live and pasted into the MODEL column; the 52 is that same book number with a 4.5% hold added back on. Every shipped spread leg in data/parlays.json is affected (16 of them), and three of them sit below 0.5 (TEN -3 → 0.4783, NYG +2.5 → 0.4892, MIN -1.5 → 0.4826) which the model's own seed formula 0.5+(p_fav−0.5)*0.7 can never produce. Because that number goes into _combined_probs, the book's price also sets the parlay's combined probability, its MODEL EV badge, and its HIGH/MEDIUM/LOW tier. The owner's rule "I want to operate independently of Vegas" is broken: the user is being shown Vegas's number labelled MODEL.
- **Evidence:** scripts/models/parlay_builder.py:277-283 —
    spread = (market or {}).get("spread") or {}
    p_cover = spread.get("home_cover_prob") if fav_is_home else spread.get("away_cover_prob")
    if p_cover is None:
        p_cover = 0.5 + (p_fav - 0.5) * 0.7   # documented seed
    sel = spread.get("selection", "%s cover" % fav)
    legs.append(make_leg("spread", sel, p_cover, implied_prob=None, ...))
and the identical pattern for totals at line 287: `p_over = total.get("over_prob", 0.5)` → `make_leg("total", over_sel, p_over, implied_prob=None, ...)`.
make_leg's third positional parameter is `model_prob` (line 86), and with implied_prob=None line 102 fabricates the implied side from it: `ip = _clamp(mp * (1.0 + hold), ...)`.
The `market` dict is real, de-vigged book data: scripts/scrape/odds_api.py:135-144 builds `home_cover_prob` from `_devig_pair(_american_to_prob(...))`, and scripts/build_predictions.py:747 calls `odds_api.fetch_markets(week_games)` and passes it through at line 774 as `markets_by_game=markets_by_game`.
The feed is live, not dormant: data/pipeline_status.json shows `"odds_api": {"rows": 16, "status": "ok"}`.
Proven by executing the shipped code:
  derive_candidate_legs(gp, market={'spread':{'home_cover_prob':0.50,...},'total':{'over_prob':0.62,...}})
    -> {'market':'spread','model_prob':0.5,'implied_prob':0.5225}
    -> {'market':'total','model_prob':0.62,'implied_prob':0.6479}
  derive_candidate_legs(gp)  # no market
    -> {'market':'spread','model_prob':0.577,...}   # the seed
validate_data.py does not catch this: check_market_price_fields only guards MARKET_PRICE_FIELDS = {"adp","auction_value"} (line 267), so the gate is green.
- **Verifier's correction:** Confirmed as stated. One refinement to the fix: the total leg is worse than the spread leg, because its model side has no seed at all other than the literal 0.5 default (`total.get("over_prob", 0.5)`), so removing the market read leaves the total leg with no model number — a real model total has to be supplied, not just the book value swapped to implied_prob.
- **Proposed fix:** Never let a market number reach the model side. In derive_candidate_legs, always compute p_cover and p_over from the model (keep the documented seed / a real model total), and pass the book's de-vigged probability only as `implied_prob=` so it lands in the display-only IMPL column: `legs.append(make_leg("spread", sel, p_cover_model, implied_prob=spread.get("home_cover_prob" if fav_is_home else "away_cover_prob")))`, and the same for the total leg. Then extend validate_data.py with a parlay-specific check that fails the gate when a leg's model_prob equals the market feed's probability for that game/market.

### `pipeline-contracts-market-price-is-the-parlay-probability`

**Sportsbook de-vigged probabilities are written into parlays.json as `model_prob` (spread + total legs)**

- **Where:** `scripts/models/parlay_builder.py:278`
- **What the user sees:** On the PARLAYS view every spread leg on the current slate shows a "model" probability that is actually the sportsbook's own de-vigged cover probability, and the parlays are ranked/selected by an EV computed from it. Shipped data/parlays.json today: SEA -3.5 model_prob 0.5, LAC -10.5 model_prob 0.5, TEN -3 model_prob 0.4783 — for all 16 games the value differs from the documented model seed 0.5+(p_fav-0.5)*0.7 (0.577, 0.6435, 0.558). The owner's number is nowhere on screen; the book's number is, under our label.
- **Evidence:** parlay_builder.py:277-289:
    spread = (market or {}).get("spread") or {}
    p_cover = spread.get("home_cover_prob") if fav_is_home else spread.get("away_cover_prob")
    if p_cover is None:
        p_cover = 0.5 + (p_fav - 0.5) * 0.7   # documented seed
    sel = spread.get("selection", "%s cover" % fav)
    legs.append(make_leg("spread", sel, p_cover, implied_prob=None, ...))
    ...
    p_over = total.get("over_prob", 0.5)
    legs.append(make_leg("total", over_sel, p_over, implied_prob=None, ...))
`market` is odds_api.fetch_markets() output (scripts/scrape/odds_api.py:140-142 `"home_cover_prob": round(ph,4)` from _devig_pair of the book's American prices). make_leg's 3rd positional arg IS model_prob (parlay_builder.py:86). build_predictions.py:772-775 passes markets_by_game=markets_by_game into build_parlays_document, and the feed is LIVE: data/pipeline_status.json has feeds.odds_api = {status: "ok", rows: 16}. _make_parlay then computes model_ev = model_p/implied_p - 1 (line 213) and build_game_parlays sorts combos by that EV (line 425), so the book price also drives which parlays ship. validate_data.check_market_price_fields only guards the field NAMES "adp"/"auction_value" (validate_data.py:267), so the gate is green.
- **Verifier's correction:** Correct except for one detail in the evidence: build_game_parlays (parlay_builder.py:417-425) sorts combos by `(-abs(rho), -ev, i, j)` — primarily by correlation magnitude, with the market-derived EV as the SECOND key — so the book price is a tie-breaker on parlay selection rather than the sole ranking driver. It is still the sole driver of the displayed MODEL number and of model_ev. Also note the same defect applies to the total leg (over_prob, line 287), not just the spread leg.
- **Proposed fix:** Never take a probability off the market into a leg's model_prob. Compute the spread cover probability from our own margin model (models/game_model.prob_from_margin) and the total's over probability from our own scoring model; pass the book's de-vigged number through as `implied_prob` only (which is what that field is for). If no model exists for a market yet, do not emit that leg rather than borrowing the book's.

### `pipeline-contracts-spread-leg-side-mismatch`

**Spread leg names the HOME team's line but is priced with whichever side OUR model favours**

- **Where:** `scripts/models/parlay_builder.py:278`
- **What the user sees:** When our model's favourite is the away team, the parlay card shows the home team's line with the away team's cover probability. In the shipped data/parlays.json this is wrong on 3 of 16 games: parlay 401872931-g* reads "KC -3" with model_prob 0.5108 which is P(DEN covers) — our model has DEN as the favourite (p_home 0.406). Same for "LV -3.5" (our fav MIA) and "CAR +2.5" (our fav CHI). The user is told to back a side at a probability computed for its opponent.
- **Evidence:** parlay_builder.py:278-283:
    p_cover = spread.get("home_cover_prob") if fav_is_home else spread.get("away_cover_prob")
    ...
    sel = spread.get("selection", "%s cover" % fav)
    legs.append(make_leg("spread", sel, p_cover, implied_prob=None, corr_tag="spread", side=fav_side))
scripts/scrape/odds_api.py:143 builds that selection unconditionally from the HOME team:
    "selection": "%s %s%g" % (home, "+" if point > 0 else "", point),
So `sel` is always the home side while `p_cover` is chosen by fav_is_home. `side=fav_side` is also then wrong, which feeds _pair_rho's opposing-direction sign flip (line 133-140). Verified against the committed feed: 401872661 (home CAR, p_home 0.483, sel 'CAR +2.5', model_prob = away_cover 0.5174), 401872928 (home LV, p_home 0.465, sel 'LV -3.5'), 401872931 (home KC, p_home 0.406, sel 'KC -3').
- **Verifier's correction:** The mechanism is right but the `side=fav_side` sub-claim is inverted. fav_side is 'away' exactly when away_cover_prob was used, so `side` matches the PROBABILITY and mismatches the SELECTION LABEL. The consequence for _pair_rho (lines 133-140) is therefore that the ML+spread pair is treated as same-direction (+0.55), which is correct for the probability actually used and wrong only relative to the printed selection. The single defect is: the label is derived from a home-only selection string while the probability is derived from the model's favourite. Fixing it means choosing the side once and deriving both from that choice.
- **Proposed fix:** Pick the side once and derive both the label and the probability from that choice: if fav_is_home use home_cover_prob and the home selection string, otherwise use away_cover_prob and build the away selection (mirror the point sign). Have odds_api emit both `home_selection` and `away_selection` instead of a single home-only `selection`, and add a regression assert that the team named in `selection` equals the team the probability was taken for.


## MAJOR — 39

### `auction-engine-unprojected-priced-at-one-dollar`

**A player with no projection is priced at $1 and labelled 'MARKET OVERPRICES · LET THEM SPEND' on the block, while the nomination advisor correctly refuses to price him**

- **Where:** `app/auction.js:613`
- **What the user sees:** Put Jeremiyah Love (RB, ADP 27.4) on the block — he is in the nomination pool chips and, in a LIVE room, on the board the moment a real team takes him. The BLOCK panel prints 'OURS $1 · INFL-ADJ $1 · MARKET $47', the chip 'MARKET OVERPRICES · LET THEM SPEND', and the verdict 'BID TO $1, THEN OUT'. The app has no projection for him at all — it is stating a valuation it does not hold, and telling you to pass on a top-30 ADP back for that reason. 30 of the 212 rows in data/adp.json carry gsis_id:null and behave this way (Jadarian Price OURS $1 vs MARKET $11, Carnell Tate OURS $1 vs MARKET $12).
- **Evidence:** myGuidance():
  const key = String(row.gsis_id || `name:${row.name}`);
  const fair = a.fair.get(key) || MIN_BID;
createAuction (line 391) builds `fair` from `boardRows.filter((r) => r.gsis_id)`, so a null-id row has no entry and `|| MIN_BID` turns 'we have no opinion' into 'we say $1'. That $1 then flows into `adjusted`, `bidTo`, `gap` and classifyNomination — a $47 market price against a fabricated $1 always clears the BAIT threshold. The same file already knows this is wrong: nominationAdvice() at lines 645-650 says so out loud and skips them — "No projection -> no honest value gap. Unprojected players are neither BAIT nor TARGET; they are unknowns and stay out of the advisor." — and I confirmed Love is absent from adv.bait/adv.targets while myGuidance classifies him BAIT.
- **Verifier's correction:** Confirmed. One reachability nuance the finding does not mention: the PLAYER FINDER cannot nominate these rows — roomBoardIdx() (team.js:956-965) indexes only rows with a gsis_id, so the finder's NOM/TOOK button is suppressed for them. The reachable path is the nomination pool chips (team.js:3232), which do not filter, plus LIVE mode where those chips are rendered for opponent nominations as well.
- **Proposed fix:** Have myGuidance return `fair: null` (and class: null / bidTo: 0) when `a.fair` has no entry for the key, and have aucPriceRow render 'OURS — (no projection for this player)' with the value chip suppressed, matching the honest degraded state nominationAdvice already implements.

### `auction-engine-negative-dollars-at-min-budget`

**At the minimum league budget every price goes below $1 and several go negative — the block shows 'OURS $-1' and MY BUILD plans '-$2' for QB1**

- **Where:** `app/auction.js:246`
- **What the user sees:** Type 10 into the BUDGET box (the BUDGET_BOUNDS minimum, team.js:92) and start a 12-team auction on the default 13-slot roster. The BLOCK panel for the #1 player on the board prints 'OURS $-1 · INFL-ADJ $-1', four players carry a negative OURS price and one carries MARKET -$7, and the MY BUILD panel lists 'QB1 -$2 planned'. Setting every team to $10 in the PER-TEAM BUDGETS editor produces the same thing. Nothing in the app tells the user the room is under-funded; it just quotes negative money.
- **Evidence:** fairDollars:
  const spread = money - poolN * MIN_BID;
  ...
  out.set(String(p.gsis_id), MIN_BID + (vorSum > 0 ? Math.round(spread * (v / vorSum)) : 0));
and marketDollars:162 has the identical unfloored `const spread = total - poolN * MIN_BID;`. When the room's total money is less than the number of draftable slots (leagueSize x rosterSize) the spread is negative and is distributed as a negative allocation on top of the $1 floor, so the highest-VOR player gets the most negative number. Measured against data/adp.json at 12 teams / $10 / roster 13 (poolN 156 > $120 in the room): fairMin -1 across 4 players, mktMin -7, myGuidance(board[0]) = {fair:-1, adjusted:-1, bidTo:-1, cap:0}, planBudget(shape, 10, 'stars').slots[0].planned = -2. team.js:3076 renders these with `const dollar = (n) => `$${Math.round(n)}`` — no floor. The condition is exactly 'per-team budget < roster size', which the $10 lower bound makes reachable for every roster the grid can build.
- **Verifier's correction:** Confirmed as stated. Worth noting the negative numbers also reach the ROOM panel and the plan rows, not just the block: aucBuildZone (team.js:3269) renders `dollar(slot.planned)` unfloored, so the QB1 row reads '$-2 planned'.
- **Proposed fix:** Clamp in both allocators: `const spread = Math.max(0, money - poolN * MIN_BID);` in fairDollars (line 246) and marketDollars (line 162), and clamp planBudget's drift adjustment so plan[0] cannot fall below MIN_BID. A room that cannot afford $1 per slot should price everyone at the floor, not at negative dollars.

### `auction-engine-dst-spelling-scores-zero`

**A league that spells the slot 'DST' can buy a defence in the auction and have it contribute nothing to the score sheet**

- **Where:** `app/draft-sim.js:86`
- **What the user sees:** A league whose saved profile uses the DST spelling (a first-class token — app/league.js:55 POSITIONS includes 'DST', and cfgFromProfile deliberately preserves it so saving does not rewrite the user's league) gets board rows with position 'DST' in the auction room. Buy one for real dollars and it disappears from the AUCTION RESULT: the DEF1 slot is scored empty and the player's points are dropped entirely. Measured on an otherwise identical 9-man roster, startersTotal returns 1860 with the defence spelled DST and 1990 with it spelled DEF — 130 points and one starting slot silently lost, plus the dollars spent on him still counted in 'spent' and 'pts/$'.
- **Evidence:** rosterShape only ever emits the DEF spelling: `push('K', c.k); push('DEF', c.def);` (app/draft-sim.js:86), so rosterGeometry gives eligibility DEF1 = ['DEF'] and the bench eligibility list is built from the starter tokens, which also contains only 'DEF'. app/views/team.js:1201-1206 pushes board rows with `position: token` where token comes from `rosterPositionsInPlay(savedProfile).filter(isKdstPosition)` — the RAW profile token, so 'DST' for a DST league (app/league.js:748-758 returns the token verbatim; only app/kdst.js canonKdstPosition folds DST->DEF, and that is used to pick the FEED, not the row's position). startersTotal (app/draft-sim.js:552-565) fills each slot with `accepts.includes(p.position)`, which no 'DST' row ever satisfies. Reached from app/auction.js:671 scoreAuction -> scoreVsRoom -> startersTotal.
- **Verifier's correction:** Real, but state the reachability precisely so the fix is not over-scoped: Sleeper's own API emits 'DEF', so this only bites a league whose saved profile carries the DST spelling — a pasted-JSON import (team.js:3558-3568 'sleeper-paste') or a hand-built/legacy profile. Also note DST is dropped from bench eligibility too (draftShapeGeometry builds bench eligibility from the starter tokens, team-logic.js:329), so canonicalising at the board boundary — writing `position: canonKdstPosition(token)` on the kdstRows — is the safer of the two proposed fixes, since widening DEF1 eligibility to ['DEF','DST'] would still leave teamNeedsPos and fairDollars treating them as two positions.
- **Proposed fix:** Canonicalise the position once at the boundary — either have team.js write `position: canonKdstPosition(token)` on the kdstRows it puts on the auction board, or make rosterGeometry's DEF1 eligibility ['DEF','DST']. Whichever is chosen, teamNeedsPos and fairDollars need the same canonicalisation so 'DST' and 'DEF' are one position everywhere in the engine.

### `sleeper-import-ff-attributed-to-nobody`

**The team-defence key `ff` is attributed to no position, so it is dropped from D/ST totals without appearing in the omitted list and is described to the user as an offence-only rule**

- **Where:** `app/kdst.js:162`
- **What the user sees:** The real league scores ff (forced fumble) at 1 point. On the import report the user is told: '"ff" is worth 1 in your league. It is kept and applied, but this app projects no component for it, so it adds nothing to a QB/RB/WR/TE projected total.' — which reads as "this is an offensive rule and it is irrelevant". In fact it is a team-defence rule, and the D/ST projections drop it: no defence stat line carries a forced-fumble column, so applyScoring skips it. Worse, the PARTIAL disclosure that exists precisely to name what a total leaves out never mentions it — the Lineup and Team pages print "INCOMPLETE: it omits 4th-down stop, Special-teams forced fumble, Special-teams fumble recovery" while a fourth scored component (worth ~10-14 points a season at league-average forced fumbles) is missing and unnamed. The app's own disclosure is therefore incomplete in exactly the way kdst.js says it exists to prevent.
- **Evidence:** app/kdst.js:160-170 —
const NAMESPACE_OWNER = Object.freeze([
  [/^(?:fgm|fgmiss|fga|xpm|xpmiss|xpa|pat_|kick_)/, 'K'],
  [/^(?:def_|pts_allow|yds_allow)/, 'DEF'],
]);
`ff` has no def_ prefix and is not in app/league.js SCORING_FIELDS, so scoringKeyOwner('ff') returns null (verified by running it: null; same for tkl, qb_hit, int_ret_yd). omittedKeys() at app/kdst.js:229-231 filters `scoringKeyOwner(k) === pos`, so `ff` can never enter the omitted list. Verified against the live league: profile.scoring.ff === 1, no defence row in data/kdst_projections.json carries an `ff` key, and shapeKdst(raw, importedProfile).byPosition.DEF[0].omitted === [def_4_and_stop, def_st_ff, def_st_fum_rec] — `ff` absent. That `ff` is the TEAM-defence key and not an IDP key is settled by the same league's scoring_settings, which carries a separate idp_ff (value 0) alongside ff (value 1), exactly as it carries idp_sack/sack, idp_int/int, idp_fum_rec/fum_rec — and app/league.js SCORING_FIELDS already classifies sack, int and fum_rec as group 'defense'.
- **Verifier's correction:** Confirmed as stated. Two cautions for the fix: (1) the same silent-drop applies to any other non-prefixed Sleeper team-defence key the user's league scores, so widen attribution deliberately rather than special-casing ff; (2) the deliberate st_* exclusion at kdst.js:164-169 and the idp_* keys must stay unattributed — st_ff and st_fum_rec are the individual returner's line and attributing them to DEF would be the false alarm that comment was written to prevent.
- **Proposed fix:** Add the non-prefixed Sleeper team-defence keys to attribution. Either extend app/league.js SCORING_FIELDS with `ff` (group 'defense') so KNOWN_OWNER covers it, or add an explicit DEF key set to app/kdst.js alongside NAMESPACE_OWNER covering the Sleeper team-defence keys that carry no def_ prefix: ff, tkl, tkl_solo, tkl_ast, tkl_loss, qb_hit, sack_yd, int_ret_yd, fum_ret_yd, blk_kick_ret_yd, fum. Keep the deliberate st_* exclusion untouched, and keep the idp_* keys attributed to nobody. Once attributed, omittedKeys() will name `ff` in the PARTIAL disclosure and app/sleeper.js unresolvedItems() will stop describing it as a QB/RB/WR/TE rule. Add a case to __selftest asserting scoringKeyOwner('ff') === 'DEF' and scoringKeyOwner('idp_ff') === null.

### `sleeper-import-draft-rounds-from-league-object`

**draft_rounds is read from the stale LEAGUE object; the authoritative draft object is never fetched**

- **Where:** `app/sleeper.js:477`
- **What the user sees:** Import league 1393691504228184064 ("Omilia-US"). Sleeper's league object reports settings.draft_rounds = 3; the draft object (draft_id 1393691505520041984) reports settings.rounds = 13, which matches the 13 roster slots the same league seats. I ran the real payload through sleeperToProfile(): the profile comes back with roster_positions of 13 slots and draft_rounds: 3, and NOT ONE note is emitted about it (the only draft_rounds note fires when the key is absent). The user then presses SAVE LEAGUE SETTINGS and the status line states as fact: "13 roster slots (your league sets 3 draft rounds in Sleeper; the room drafts one round per slot)". Downstream, app/league.js:435 clamps max_keepers to min(max_keepers, draft_rounds=3, roster size), so a keeper league importing 4 keepers silently becomes 3, and app/league.js:659 raises the blocking error "max_keepers (4) cannot exceed draft_rounds (3) — every keeper costs a pick", which summarizeImport reports as "Some values were out of range and were clamped" against a league that has 13 rounds.
- **Evidence:** app/sleeper.js:476-483 —
  /* ---- draft rounds ---- */
  const rounds = toFinite(s.draft_rounds);
  if (rounds !== null) {
    shape.draft_rounds = rounds;
  } else {
    notes.push(note('draft_rounds_missing',
      'No "draft_rounds" in the league settings; it will track the roster size.', null));
  }
`s` is payload.settings (sleeperToProfile line 623: mapSettings(payload.settings, ...)). Live league settings contain "draft_rounds": 3; live draft settings contain "rounds": 13. `payload.draft_id` is present on the league object (1393691505520041984) but grep shows draft_id appears nowhere in app/ — sleeper.js exposes only leagueEndpoint/rostersEndpoint/leagueUsersEndpoint/matchupsEndpoint, so no code path ever reads the draft object. Downstream consumers of shape.draft_rounds (exhaustive grep over app/): app/league.js:415-421 (normalisation), app/league.js:434-436 (max_keepers = Math.min(max_keepers, draft_rounds, roster size)), app/league.js:657-662 (keepers_exceed_draft_rounds blocking error), app/views/team.js:505-509 (profileFromCfg preserves an explicit value across every SAVE), app/views/team.js:3493-3496 (SAVE status text), app/views/team.js:3505-3508 (draftRoundsOverride message). Nothing in app/draft-sim.js or app/auction.js reads it — the room runs one round per roster slot.
- **Verifier's correction:** Real, but not a blocker and one part of the claimed failure does not occur for the cited league. Omilia-US is a redraft league: sleeperToProfile() returns keepers_enabled false, max_keepers 0, and report.validation comes back EMPTY — no 'keepers_exceed_draft_rounds' error and no 'Some values were out of range and were clamped' line is printed for this import. The max_keepers clamp/blocking-error path is real but latent, firing only on a keeper league whose league object carries a stale draft_rounds below its keeper count. Nothing in app/draft-sim.js or app/auction.js reads draft_rounds, so no board or pick order is wrong. The confirmed user-visible damage today is the false SAVE-line assertion (the next finding). Severity: major.
- **Proposed fix:** Make the DRAFT object authoritative for rounds. In the API tier, after the league GET succeeds, follow payload.draft_id with a second GET through the existing sleeperGetJson() core (add draftEndpoint(draftId) = `${SLEEPER_API_BASE}/draft/${id}`) and take draft.settings.rounds as shape.draft_rounds, recording the source in the report. Where the draft object was not read — the paste tier, a league with a null draft_id, or a failed/404 draft GET — do NOT write league.settings.draft_rounds onto the profile as fact: leave draft_rounds tracking roster size (the existing normalizeProfile fallback) and emit a loud note plus an unresolvedItems entry naming the number seen and why it is not trusted ("the league object says 3; the draft object holds the real round count and was not read — open .../v1/draft/{draft_id} and paste it, or set rounds by hand"). Add the draft id/rounds provenance to buildReport().league so the UI can qualify the number.

### `sleeper-import-only-reception-claim-false-for-kdst`

**The import summary tells the user only the reception value changes a projection, while app/kdst.js prices every K and D/ST projection off the whole imported scoring table**

- **Where:** `app/sleeper.js:1226`
- **What the user sees:** On the import report for the real league, line 2 reads: "35 scoring rule(s) recognised — of these, only the reception value currently changes a projection." Immediately below it in the same panel, the NOT-APPLIED list says of yds_allow_0_100: "It IS applied to your defence projections, under your own scoring table." Both are rendered by importReportHtml(), so the user reads two contradictory claims a centimetre apart. The first one is the false one: I ran shapeKdst(data/kdst_projections.json, importedProfile) and the top kicker prices at 181.36 season points under this league's table versus the contract's own DEFAULT-profile number, and the whole D/ST board is ordered by applyScoring(stats, profile) over sack/int/fum_rec/safe/blk_kick/def_td/def_st_td/pts_allow_*/yds_allow_*. A user who reads that line concludes their imported kicking and defence scoring is inert and stops checking it.
- **Evidence:** app/sleeper.js:1224-1228 —
  lines.push(`${report.scoring.mapped.length} scoring rule(s) recognised — of these, `
    + 'only the reception value currently changes a projection. Full per-stat '
    + 'scoring arrives with the component projections.');
Contradicted by app/kdst.js:273 `const seasonPoints = applyScoring(stats, profile);` inside shapeEntry(), which is called for every kicker and defence row (kdst.js:343-350), and by app/sleeper.js:1153-1157 which tells the user the opposite about carried keys. Measured: shapeKdst(raw, sleeperToProfile(liveLeague).profile) → K "Ben Sauls" seasonPoints 181.36, DEF "Houston Texans Defense" seasonPoints 206.86, both computed from the imported table, not from the contract's proj_points.
- **Verifier's correction:** Confirmed. The magnitude is larger than 'the defence board is reordered': the top of the D/ST board changes team entirely and season totals move by 60+ points, so a user who believes the line and skips checking their K/D/ST scoring is acting on numbers they were told were inert.
- **Proposed fix:** Rewrite the line to name the two paths separately and truthfully: the QB/RB/WR/TE projections currently convert on the reception value alone, while the K and D/ST projections are recomputed per stat under the full imported table by app/kdst.js. Derive the split from scoringKeyOwner() (already imported into this file) so the sentence cannot go stale again — e.g. "35 rules recognised: N kicking/defence rules are applied in full to your K and D/ST projections; of the offensive rules only the reception value currently changes a QB/RB/WR/TE projection."

### `scoring-consistency-import-note-says-pass-cmp-does-nothing`

**The Sleeper import honesty list tells the user pass_cmp "adds nothing to a QB/RB/WR/TE projected total" — R29 made that false**

- **Where:** `app/sleeper.js:1159`
- **Criterion:** Owner standing policy 4 — "Never claim a mechanism exists unless it is actually wired end to end"; and its converse, the R27/R28 failure mode: prose in the app describing behaviour the app no longer has.
- **What the user sees:** A manager importing a league that scores `pass_cmp` sees, in the import panel's unresolved list on the TEAM tab, the line: "\"pass_cmp\" is worth 0.5 in your league. It is kept and applied, but this app projects no component for it, so it adds nothing to a QB/RB/WR/TE projected total." It does add — 202.0 points to Dak Prescott, 194.0 to Jared Goff — and those points are visibly in the PLAYERS tab's projection and the TEAM tab's BEST FIT scores. The user is told to discount a rule the app is actively pricing, which is exactly backwards, and it is the same class of defect as R27's "the draft simulator does not draft them".
- **Evidence:** app/sleeper.js:1145-1161:
```
    const owner = scoringKeyOwner(c.key);
    const where = owner === 'K' ? 'kicker' : owner === 'DEF' ? 'defence' : null;
    ...
      message: where
        ? `"${c.key}" is worth ${c.value} in your league. It IS applied to your ...`
        : `"${c.key}" is worth ${c.value} in your league. It is kept and applied, but `
          + 'this app projects no component for it, so it adds nothing to a '
          + 'QB/RB/WR/TE projected total.',
```
Verified by running the module: `scoringKeyOwner('pass_cmp') -> null`, so pass_cmp always takes the false branch. `pass_cmp` is not in app/league.js SCORING_FIELDS (lines 131-167) and matches no NAMESPACE_OWNER regex (app/kdst.js:160-170).
Meanwhile app/team-logic.js:480-491 `withLeagueExtras` reads `profile.scoring.pass_cmp` and stamps `extra_pts`, and app/team-logic.js:447-449 adds it into every season total.
Rendered to the user via app/views/team.js:2592 `importUnresolved = importReport ? unresolvedItems(importReport) : [];`
- **Verifier's correction:** Accurate. Note the surrounding header at team.js:2131 also frames the whole list as 'N ITEM(S) NOT APPLIED', which compounds the same wrong impression for a key that IS applied.
- **Proposed fix:** Give the offensive-extras path its own branch, keyed off the same function that actually applies it. In `unresolvedItems`, before the owner check, test `passCmpRate({scoring:{[c.key]: c.value}})`-style membership (or an exported `OFFENSE_PRICED_KEYS = ['pass_cmp']` from team-logic) and emit: "\"pass_cmp\" is worth 0.5 in your league. It IS applied to every quarterback with a prior-season completion count, and shows as LEAGUE RULES on the Players tab." Import the predicate from team-logic rather than restating the list, for the same reason sleeper.js:63-67 imports scoringKeyOwner from kdst.js.

### `app-honesty-text-carried-rules-contribute-zero`

**Sleeper import summary still says every carried scoring rule "contributes 0 to every projected total" — the exact R28 claim, unqualified**

- **Where:** `app/sleeper.js:666`
- **What the user sees:** A user imports a Sleeper league that scores fgm_50_59, yds_allow_* or pass_cmp. The import report prints, e.g., "3 scoring rule(s) were kept exactly as this league has them but no projection in this app feeds them, so they contribute 0 to every projected total." Two lines further down the SAME report prints "\"fgm_50_59\" is worth 5 in your league. It IS applied to your kicker projections" and the app's own kicker/defence numbers move by up to ±16 points. The user is told in one sentence that a rule does nothing and in the next that it does.
- **Evidence:** app/sleeper.js:663-668 — `notes.push(note('scoring_carried', `${scoring.carried.length} scoring rule(s) were kept exactly as this league has them but ` + 'no projection in this app feeds them, so they contribute 0 to every projected total.', ...))`. These note messages reach the screen verbatim: app/sleeper.js:1237 `(report.notes || []).forEach((n) => lines.push(n.message));`, rendered by app/views/team.js:2129 as `.lp-rep-line` rows. The contradicting behaviour is app/kdst.js (applyScoring over the league's own table) and the corrected per-item message at app/sleeper.js:1153-1157. tests/feature/stale_text.test.mjs only greps for the string "adds nothing to a projected total", so this differently-worded copy of the same false claim is invisible to the gate.
- **Verifier's correction:** Real, but severity is major rather than blocker: it is a false statement in the import report, not a data defect — the numbers themselves are correct. Note the concrete carried keys in the shipped feed are the yds_allow_* ladder (present in every data/kdst_projections.json defense stat line), which is the strongest counterexample; fgm_50_59/fgm_60p are carried too but no kicker stat line supplies them, so those are covered by the PARTIAL path.
- **Proposed fix:** Scope this note the same way unresolvedItems() was scoped in R28: split scoring.carried by scoringKeyOwner() and say "N rule(s) apply only to your kicker/defence projections; M rule(s) this app projects no component for". Do not restate an unqualified absolute about "every projected total".

### `app-honesty-text-pass-cmp-adds-nothing`

**Import report tells the user pass_cmp "adds nothing to a QB/RB/WR/TE projected total" while R29 adds it to exactly that total**

- **Where:** `app/sleeper.js:1159`
- **What the user sees:** A league scoring 0.5 per completion imports. The report says: "\"pass_cmp\" is worth 0.5 in your league. It is kept and applied, but this app projects no component for it, so it adds nothing to a QB/RB/WR/TE projected total." On the PLAYERS tab that same league's quarterbacks then carry a chip reading "+200 LEAGUE RULES" whose tooltip says "Points from your league's own scoring rules (completions), already included in the projection above", and Dak-class QBs jump ~200 season points. The two screens state opposite facts about the same rule.
- **Evidence:** app/sleeper.js:1145-1161 routes any key whose scoringKeyOwner() is null into the else branch: `+ 'this app projects no component for it, so it adds nothing to a ' + 'QB/RB/WR/TE projected total.'`. Verified by running the shipped code: scoringKeyOwner('pass_cmp') === null, and withLeagueExtras()/scoringAdjust() (app/team-logic.js:480-503, 438-450) turn 400 completions x 0.5 into extra_pts 200 and 300 PPR points into 500. The R28 discriminator was written before R29 gave pass_cmp a reader, and nothing re-scoped it.
- **Verifier's correction:** Real. Worth stating that the surrounding heading makes it worse: unresolvedItems() output is printed under 'N ITEM(S) NOT APPLIED' (app/views/team.js:2132), so pass_cmp is both counted as unresolved and described as contributing nothing, while withLeagueExtras applies it on every tab.
- **Proposed fix:** Make the discriminator ask whether the key has a live reader, not only whether kdst.js owns it: add a passCmpRate()-aware branch so a key the offensive path DOES apply (currently pass_cmp) gets an "IS applied to your QB projections" message, and keep the "adds nothing" line for keys with no reader anywhere.

### `app-honesty-text-only-reception-changes-projection`

**Import summary claims only the reception value changes a projection, and promises "full per-stat scoring" as a future release**

- **Where:** `app/sleeper.js:1227`
- **What the user sees:** Every successful Sleeper import prints "N scoring rule(s) recognised — of these, only the reception value currently changes a projection. Full per-stat scoring arrives with the component projections." Both halves are wrong for the shipped app: the league's completion value moves QB projections on every tab, the TE-reception premium moves the AI+ draft room's valuations, and the whole kicking/defense table is applied to K and D/ST. A user who reads this stops checking numbers that did in fact change, and is told to wait for a release that is not named anywhere in the repo.
- **Evidence:** app/sleeper.js:1226-1228 `lines.push(`${report.scoring.mapped.length} scoring rule(s) recognised — of these, ` + 'only the reception value currently changes a projection. Full per-stat ' + 'scoring arrives with the component projections.');`. Contradicted by app/team-logic.js:480-491 withLeagueExtras (pass_cmp -> extra_pts on every weekly entry, consumed by players/team via scoringAdjust), app/draft-sim.js:260-278 leagueSeasonPoints (`bonus_rec_te` applied), and app/kdst.js applyScoring over the league's own table. "the component projections" names no shipped or scheduled mechanism — grep across scripts/ and app/ finds no component-projection path.
- **Verifier's correction:** Real, with one evidence correction: 'component projections' is NOT unnamed in the repo — it is an epic in docs/roadmap/rel19/USER_STORIES.md:363 and ARCHITECTURE.md:6. The defect is that no such path exists in shipped app/ or scripts/ code, so the sentence promises a release the running app cannot point at. Also, the strongest counterexample inside the sentence's own scope ('of these' = mapped rules) is the K/DEF table, not pass_cmp — pass_cmp is carried, not mapped.
- **Proposed fix:** Replace with what is true today: name the rules that DO reach a number (reception value, TE reception premium, completions, and the full K/D-ST table) and the ones that do not. Delete the forward-looking sentence — the owner's rule is never to name a mechanism that is not wired.

### `ipad-layout-a11y-undefined-line-token`

**`--line` is never defined, so three rules silently lose their border — the LIVE auction SOLD-price input renders as invisible, unfocusable-looking static text**

- **Where:** `app/theme.css:3508`
- **What the user sees:** In the LIVE auction room (Team tab → START LIVE AUCTION → a player on THE BLOCK), the row reads `SOLD TO [T3 ▾] FOR $36  −  +  RECORD SALE`. The `$36` is supposed to be a typed input with an underline. It has no border, no background and no focus ring, so it is pixel-identical to the static mono text either side of it — the manager who needs to record that the player actually went for $47 has no way to tell the number is editable, and taps `+` eleven times, which is the exact workflow R27 says it fixed. Tabbing to it from the keyboard shows nothing at all: the caret is the only cue. The PER-TEAM BUDGETS panel has the same problem — the `<details>` panel and all 8–14 team boxes are drawn borderless, and focusing a box gives no visible indication of which box you are in.
- **Evidence:** `:root` (app/theme.css:20-67) defines `--bg --surface --surface-2 --elev --border --ink --muted --brand --brand-txt --accent --accent-txt --home --home-txt --away --away-txt --pos --pos-txt --warn --neg --team-tint --radius --radius-sm --safe-* --sans --mono --topbar-pad --tabbar-pad`. There is no `--line`. `grep -n "\-\-line" app/theme.css` returns exactly three consumers, none with a fallback:
  3458  `.tb-panel { … border: 1px solid var(--line); }`
  3475  `.tb-cell  { … border: 1px solid var(--line); }`
  3508  `.auc-soldprice { … border-bottom: 1px solid var(--line); }`
An undefined custom property with no fallback is guaranteed-invalid, so the declaration becomes IACVT → `unset` → for the non-inherited border longhands that is `initial`, i.e. `border-style: none` and a used width of 0. No border is painted.
The two focus substitutes that were supposed to cover for the missing outline are dead for the same reason:
  3479  `.tb-cell:focus-within { border-color: var(--brand-txt); }`  (border-style is none — nothing renders)
  3510  `.auc-soldprice:focus { border-bottom-color: var(--brand-txt); }` (same)
And the outline that would otherwise show is explicitly suppressed:
  3448  `.ds-num:focus { outline: none; }       /* the tile border shows focus */`
`.auc-soldprice` and `.tb-num` both carry `.ds-num` (app/views/team.js:3190, 2841), and `.ds-num` also sets `background: transparent; border: 0;` (3433-3447). `.ds-num:focus` (0,1,1) sits at line 3448, later than the global `input:focus-visible { outline: 2px solid var(--brand-txt) }` at line ~2352 of equal specificity, so source order kills the ring. The comment "the tile border shows focus" is only true for `.ds-field` (theme.css:1849-1859), which has a real `1px solid var(--border)`; `.tb-cell` and the bare `.auc-soldprice` do not.
No JS defines it either — `grep -rn "setProperty" app/` returns nothing, and index.html loads only /app/theme.css.
- **Verifier's correction:** Mechanism and all three dead rules confirmed. Severity is major, not blocker: the field is still typeable and the value it records is correct (the `change` handler at team.js:3963-3967 reads it correctly), so nothing is lost or lied about — what is lost is the affordance and the focus indicator. Worth adding to the write-up: `.tb-panel` is --surface on --surface (theme.css:3462 inside .draftsim theme.css:1794), so the panel boundary is fully invisible, not merely borderless-but-tinted; the `.tb-cell` boxes do stay distinguishable because they set background:var(--bg) against the panel's --surface.
- **Proposed fix:** Either add `--line: var(--border);` to `:root`, or replace the three `var(--line)` references with `var(--border)`. Separately, narrow `.ds-num:focus { outline: none }` to `.ds-field .ds-num:focus` so inputs that are NOT inside a bordered tile (`.auc-soldprice`, `.tb-num`) keep the global focus ring.

### `ipad-layout-a11y-model-bars-below-non-text-contrast`

**Both bar charts on the MODEL tab draw their fills at 1.14:1 and 1.36:1 against the card — the data is invisible, and contrast_aa.test.mjs tests neither pair**

- **Where:** `app/theme.css:1761`
- **What the user sees:** On the MODEL tab, the CALIBRATION card tells the reader "predicted vs actual win rate. Matched bars = honest probabilities" — but the *predicted* bar is drawn in `--border` on a `--surface` card, which is 1.36:1. On the iPad's glossy screen at any normal brightness it is not visible at all, so the one comparison the card exists to support cannot be made; the user sees a single blue bar per row and no reference to compare it to. In the BACKTEST card, only the top ("best") trial's bar is filled with `--brand`; the other nine are `--surface-2` at 1.14:1 with a `--border` outline at 1.36:1, so the ranking those bar lengths encode is unreadable — the card looks like one bar and nine empty rows.
- **Evidence:** Computed with the same WCAG formula the repo's own gate uses:
  `--border` #2A3340 on `--surface` #161B22 = **1.36:1**
  `--surface-2` #1F2630 on `--surface` #161B22 = **1.14:1**
WCAG 1.4.11 requires 3.0:1 for graphical objects required to understand content; the repo adopts exactly that threshold (`AA_LARGE = 3.0`, tests/feature/contrast_aa.test.mjs:59, applied to "win-prob / EV bar fills").
The two offending rules:
  - theme.css:1761 `.cal-bar--exp { background: var(--surface-3, var(--border)); }` — `--surface-3` is not defined in `:root` (theme.css:20-67), so the `--border` fallback is what ships. The element is width-encoded data: app/views/model.js:438 `<span class="cal-bar cal-bar--exp" style="width:${(exp*100).toFixed(1)}%">`, beside `.cal-bar--act { background: var(--brand) }` (theme.css:1762). It renders inside `<section class="card mcard">` (model.js:529) and `.card { background: var(--surface) }` (theme.css:347-348).
  - theme.css:1621-1629 `.bt-bar { background: var(--surface-2); border: 1px solid var(--border); }`, overridden only for the leader by theme.css:1631 `.bt-row--best .bt-bar { background: var(--brand); }`. Data-bearing: app/views/model.js:293 `<span class="bt-bar" style="width:${w.toFixed(1)}%">`, on the same `--surface` card.
Contrast-gate coverage: tests/feature/contrast_aa.test.mjs hard-codes its token table (lines 30-51) and its pair list; `grep` over that file shows it never names `border`, `surface-2` or `surface-3` as a foreground/fill. Its bar-fill test ("win-prob / EV bar fills meet 3.0:1 on surface") only iterates `['home','away','accent','pos']`. So both shipped fills are outside the gate entirely — the test is green and the bars are invisible.
- **Proposed fix:** Give the non-highlighted fills a real graphic-contrast token: `.cal-bar--exp { background: var(--muted); }` (--muted #B0BDCC on --surface = 9.05:1) and `.bt-bar { background: var(--muted); }`, keeping `--brand` for `--act` / `--best` so the pair still reads as two distinct series. Then extend contrast_aa.test.mjs with a `bar fills that are not the highlight colour` block asserting `assertContrast(fill, 'surface', AA_LARGE)` for every fill token actually used by `.cal-bar--exp` and `.bt-bar`, so the pair is pinned.

### `cross-view-parity-compare-raw-proj`

**COMPARE reads proj_points raw: it honours neither the PPR/HALF/STD mode nor the league's scoring rules, so its numbers and its winner chip contradict PLAYERS and TEAM**

- **Where:** `app/views/compare.js:167`
- **What the user sees:** Set the scoring segment to STD on PLAYERS (or import a standard-scoring Sleeper league, which writes SCORING_KEY for you and announces "every projection on the board is recomputed" — team.js:3510-3514). PLAYERS and TEAM then show Puka Nacua at 246.0 and Christian McCaffrey at 314.6. Open #/compare with the same two players and the PROJ PTS rows read 375.0 and 416.6, and the centre PROJ edge chip hands the win to Nacua by 5.8 when the user's own scoring makes McCaffrey the winner by 68.6. Same defect for a pass_cmp league: COMPARE shows Josh Allen at 364.6 where PLAYERS shows 524.1.
- **Evidence:** app/views/compare.js:167 `proj: projected ? Number(p.proj_points) || 0 : null,` — the raw contract value; compare.js never reads `nfl2026.scoring.v1` (grep: SCORING_KEY appears only in players.js and team.js) and never calls scoringAdjust. Line 141 `const weeklyById = withLeagueExtras(weeklyRaw, profile);` stamps `extra_pts` onto every entry, but nothing in this file or its callees ever reads it — `extra_pts` is only consumed in app/team-logic.js and app/views/players.js; compare's uses of `w` are availabilityOf / rosPoints / strengthOfSchedule / playoffSos / nextBye, none of which touch it. So that call is inert. The gate certifies the inertness: tests/feature/stale_text.test.mjs:214 asserts only `/withLeagueExtras\s*\(/.test(src)` — the presence of the string, not the use of its output. The project's own design docs already flagged the underlying bug and it was never fixed: docs/roadmap/rel19/ARCHITECTURE.md:713 "metricsFor() line ~100 reads Number(p.proj_points) raw — Pre-existing defect: Compare does not honour even the existing PPR/HALF/STD toggle", and docs/roadmap/rel19/SOLUTION_DESIGN.md:646.
- **Verifier's correction:** The defect is real but the worked example is wrong in one respect: for Nacua (375.0 ppr / 246.0 std) vs McCaffrey (416.6 ppr / 314.6 std) the winner does NOT flip — McCaffrey wins in both scales. What COMPARE gets wrong for that pair is the magnitudes and the edge size: it prints 375.0 / 416.6 and an edge of 41.6 where the user's own scoring says 246.0 / 314.6 and an edge of 68.6. The winner-flip failure is real in principle (a reception-heavy WR vs a low-reception RB whose PPR gap is smaller than their reception gap) but should not be claimed for this pair. The pass_cmp half of the example is exact: COMPARE shows Josh Allen at 364.6 where PLAYERS shows 524.1.
- **Proposed fix:** In metricsFor(), derive proj the way players.js model() does: `const w = weeklyById.get(id); const proj = w ? scoringAdjust(Number(p.proj_points), w.receptions_prior, mode, extraPtsOf(w)) : Number(p.proj_points)`, with `mode` read from the shared `nfl2026.scoring.v1` key (extract the loadScoring helper rather than copying it). Scale the RoS row by the same season_adj/season_ppr ratio so the two rows stay in one unit. Replace the stale_text presence-check with an assertion that a profile carrying pass_cmp actually moves compare's rendered PROJ.

### `cross-view-parity-lineup-raw-weekly-pts`

**WEEKLY LINEUP prints raw PPR weekly points regardless of the connected league, so the same player's week disagrees with the TEAM tab's slot chip**

- **Where:** `app/views/lineup.js:303`
- **What the user sees:** With a standard-scoring league connected (or STD selected), the TEAM tab's roster slot for Puka Nacua shows "13.8 · W1" while #/lineup shows him at 21.1 in the same week — and the optimizer's card total and its "Switching to the optimal lineup adds +X pts" sentence are computed in PPR points for a league that does not award them. Inside a single lineup card the units are mixed: K/DEF rows ARE scored under the league's own table (shapeKdst(kdstDoc, profile), line 209) while the QB/RB/WR/TE rows beside them are not, so the total sums two different scoring systems.
- **Evidence:** app/views/lineup.js:303 `const pts = (onBye || avail.playable === false) ? 0 : Number(wkEntry && wkEntry.pts) || 0;` — the weekly row is taken straight from player_weekly.json, which is PPR by contract. lineup.js never reads `nfl2026.scoring.v1` and never calls scoringAdjust or weeklyPoints, whereas team.js builds `scaledById` as `weeklyPoints(e, adj, p.proj_points)` (team.js:1309) and renders `${fix1(arr[currentWk - 1])} · W${currentWk}` (team.js:1641). Line 185 `const weeklyById = withLeagueExtras(weeklyRaw, profile);` stamps `extra_pts` that this file never reads (its only uses of `w` are `w.weeks.find(...)`, availabilityOf and rosPoints) — inert, and certified only by the presence-check at tests/feature/stale_text.test.mjs:214. docs/roadmap/rel19/ARCHITECTURE.md:713 states the requirement for this surface: "Lineup optimizer … per-week points scale by custom/ppr".
- **Verifier's correction:** One qualifier on the 'app lies about itself' framing: lineup.js:255 already labels the surface `START / SIT · PPR · ESTIMATE`, so the QB/RB/WR/TE side is at least disclosed as PPR. The label is nonetheless wrong for the K/DEF rows in the same table (those ARE league-scored via shapeKdst), and it does not rescue the cross-tab disagreement with TEAM's slot chip or the optimizer's PPR-denominated '+X pts' claim. Severity major stands.
- **Proposed fix:** Compute the season conversion once per player exactly as players.js does (`scoringAdjust(p.proj_points, w.receptions_prior, mode, extraPtsOf(w))`, mode from the shared scoring key) and scale each weekly row by `seasonAdj / p.proj_points` — team-logic's weeklyPoints() already does precisely this and needs no change. Keep the header sub-label truthful by deriving it from the active mode instead of the literal 'PPR' at line 255.

### `app-honesty-text-gate-incumbent-shown-as-weight-zero`

**MODEL promotion-gate card shows the APPLIED incumbent family (qb_out) with the same RETAINED chip as families carrying no weight**

- **Where:** `app/views/model.js:325`
- **What the user sees:** On the MODEL tab ("FULL TRANSPARENCY"), the PROMOTION GATE card lists 13 families and marks all 13 RETAINED, under copy that reads "losing candidates stay recorded at weight 0". One of them, qb_out, is actually applied to every game probability at scale 75. A user reading this dashboard concludes no signal family is moving the numbers, when one is — and the caveat the data itself carries about it ("Its 95% CI spans zero: it is not statistically distinguishable from noise") is never shown anywhere in the app.
- **Evidence:** app/views/model.js:317-326 assigns the plain `<span class="gate-chip">RETAINED</span>` to every non-adopted, appliable family; familyRows (app/views/model.js:222-240) never reads `entry.incumbent_families`, which the shipped feed carries as `["qb_out"]`. app/views/model.js:351-353 prints "losing candidates stay recorded at weight 0". data/model_tuning.json game_params.qb_out = {"applied": true, "scale": 75.0, "note": "Adopted under the retired fixed-margin rule ... Its 95% CI spans zero: it is not statistically distinguishable from noise."}, and scripts/build_predictions.py:159-172, 273-276 applies it to the live Elo. paramsCard (app/views/model.js:268-285) renders only hfa_elo/revert/k from the same object and drops the qb_out block.
- **Verifier's correction:** Real, but the count is wrong: the card does NOT mark all 13 RETAINED — 4 families render NO PATH and 9 render RETAINED, and qb_out is one of the 9. The defect is that the one family the pipeline actually applies (scale 75, build_predictions.py:270-276) wears the same RETAINED chip as families carrying no weight, and its stored caveat ('95% CI spans zero') is rendered nowhere in the app.
- **Proposed fix:** Give a family named in entry.incumbent_families its own chip (e.g. INCUMBENT · APPLIED) instead of RETAINED, and render game_params.qb_out — scale, adopted_under and its note — in the ADOPTED PARAMETERS card beside hfa/revert/k.

### `app-honesty-text-backtest-nan-best-trial`

**BACKTEST card's highlighted "best" row renders "hfa NaN · rev NaN · k NaN"**

- **Where:** `app/views/model.js:292`
- **What the user sees:** The MODEL tab's BACKTEST · WALK-FORWARD card prints its top, best-marked bar as "hfa NaN · rev NaN · k NaN   0.6369", above the copy "The best trial is only ADOPTED when it beats the incumbent by the NEVER-REGRESS margin". The user sees the app's flagship transparency card assert that its best parameter set is three NaNs.
- **Evidence:** app/views/model.js:292 `<span class="bt-lbl">hfa ${esc(t.hfa)} · rev ${esc(t.revert)} · k ${esc(t.k)}</span>`. topTrials (app/views/model.js:57-83) accepts any history trial with a finite log_loss, but data/model_tuning.json also contains signal_promotion trials shaped {venue_scale, cold_scale, log_loss, n} which carry no hfa/revert/k, so Number(undefined) -> NaN. Ran the shipped exports against the committed feed: topTrials(history,10)[0] === { hfa: NaN, revert: NaN, k: NaN, log_loss: 0.6369 } and it sorts first, so it takes the `bt-row--best` class at app/views/model.js:291.
- **Verifier's correction:** Real and reproducible on the committed data — no hypothetical input required.
- **Proposed fix:** Filter topTrials to rows where hfa, revert and k are all finite — a parameter-grid card must only show parameter-grid trials — or label a signal trial by its own knobs instead of printing NaN.

### `model-slate-parlays-model-ev-legend-stale-and-self-referential`

**Parlays legend calls MODEL EV a "placeholder until live odds" while live odds are wired, and the headline EV is computed against a price the model made up**

- **Where:** `app/views/parlays.js:62`
- **What the user sees:** On #/parlays the legend reads "MODEL EV — model edge vs the book price (placeholder until live odds)", telling the user the numbers are not real yet. Live odds ARE in the shipped feed (data/pipeline_status.json odds_api rows 16, status ok; the cards carry real book lines like "SEA -3.5", "LAC -10.5"). Meanwhile the top GAME parlay displays a "+35.0% MODEL EV" badge that is not an edge against any book: its spread leg's IMPL 52 is not a book price at all but the model's own number re-vigged by 4.5%, and the entire positive sign comes from a hardcoded, unfitted correlation constant applied only to the numerator (independence would give −6.2%). A user reads a dismissive "placeholder" caption next to a badge advertising a 35% edge, and neither statement describes what the number is.
- **Evidence:** app/views/parlays.js:58-66 (legend) —
      '<span class="legend-item"><b>MODEL EV</b> model edge vs the book price (placeholder until live odds)</span>' +
data/parlays.json parlay 401872656-g1: legs [{moneyline SEA ML, model 0.61, implied 0.6225}, {spread "SEA -3.5", model 0.5, implied 0.5225}], model_ev 0.3501 -> app/render.js:568 renders `signedPct1(35.01)` = "+35.0%".
The moneyline implied 0.6225 is a real de-vigged book price (0.61 × 1.045 would be 0.6374), but the spread implied 0.5225 = 0.5 × 1.045 exactly — scripts/models/parlay_builder.py:100-102: `if implied_prob is None: ip = _clamp(mp * (1.0 + hold), ...)` with _DEFAULT_HOLD = 0.045 (line 54). derive_candidate_legs always passes implied_prob=None for the spread, total and prop legs (lines 282, 289, 293-299), so the IMPL column app/render.js:525 prints for those legs is never a book number.
The EV itself: parlay_builder.py:209-213 —
    correlated = scope == "game"
    model_p, implied_p = _combined_probs(legs, correlated)
    ev = (model_p / implied_p - 1.0) if implied_p > 0 else -1.0
with _combined_probs applying correlation to the MODEL side only (lines 183-190) using the hardcoded table at lines 65-72, documented at line 58 as "transparent priors (not fitted)": frozenset(("moneyline","spread")): 0.55. Recomputing this parlay: independence 0.61×0.5 = 0.305, bump 0.55×sqrt(0.61·0.39·0.5·0.5) = 0.134, model_p = 0.439; implied_p = 0.6225×0.5225 = 0.3253; EV = 0.439/0.3253 − 1 = +0.350. Without the bump: 0.305/0.3253 − 1 = −0.062. The whole advertised edge is the unfitted constant.
This also contradicts the builder's own stated rule (parlay_builder.py:38-44): "We never fabricate a positive edge out of thin air; a positive edge requires a real, beatable line."
- **Verifier's correction:** Confirmed on the two checkable defects — the stale '(placeholder until live odds)' legend and the un-marked synthetic IMPL — but drop the third strand. The claim that the card fails to explain where the positive EV comes from is not supportable: renderParlayCard (app/render.js:552-557) prints parlay.correlation_note on every game parlay, and that note states 'combined probability uses a pairwise correlation adjustment (not the independence product). Book prices legs independently, so the edge lives in that gap' — the mechanism is disclosed in the UI (only the fact that the rho constants are unfitted is confined to the source docstring). Scope the fix to: remove '(placeholder until live odds)'; add a `priced` flag from make_leg and render 'IMPL (est)' for hold-derived legs. Note this overlaps finding model-slate-parlays-market-prob-is-parlay-model-prob — fixing that one changes which legs carry a real implied_prob, so land it first.
- **Proposed fix:** Drop "(placeholder until live odds)" from the legend now that odds_api is configured, and make the legend state what model_ev is: EV per $1 of a correlation-adjusted model probability versus an independence-multiplied price. In render.js, mark legs whose implied_prob was hold-derived rather than fetched (add a `priced: true/false` flag from make_leg) and render "IMPL (est)" for the unpriced ones, so the card cannot present a synthetic re-vig as a book price. Suppress or grey the MODEL EV badge on any parlay containing an unpriced leg.

### `cross-view-parity-players-ros-ignores-scoring`

**PLAYERS' RoS chip and ROS sort are raw PPR while the PROJ on the same card is mode-adjusted, so rest-of-season reads higher than the whole season**

- **Where:** `app/views/players.js:689`
- **What the user sees:** On PLAYERS in STD mode, tap the ROS sort chip. Puka Nacua's card reads "246.0" as his projected season points and, two lines below, "RoS 375.0 · 17g" — the remaining 17 games are shown as worth 129 points more than his entire 18-game season. The ordering is wrong for the same reason: the ROS sort ranks by PPR remaining points, so reception-heavy receivers are ranked above backs a standard-scoring manager should prefer, while the PROJ column beside them says the opposite.
- **Evidence:** app/views/players.js:686-690 — `rosOf()` returns `{ points: rosPoints(w.weeks, currentWk), ... }` from the untouched weekly rows; app/ros.js rosPoints() sums `Number(w.pts)` verbatim (no ratio parameter exists). The card's headline number on the same render goes through the conversion: line 655 `const scoreAdj = w ? seasonAdjust(ppr, w.receptions_prior, scoring, extraPtsOf(w)) : ppr;` and line 656 `const scoreRatio = ppr > 0 ? scoreAdj / ppr : 1;`, applied to proj/low/high. The RoS value is fed to render.js:354-355, which prints it unqualified as "RoS 375.0 · 17g" with the title "Projected points over the remaining 17 games (bye excluded)" — no mode caveat. paintList (line 831) passes `ros` whenever sortKey === 'ros', and sortVal (line 786-788) sorts on the same unscaled number. Committed data: Nacua ppr 375.0 / receptions_prior 129 -> std 246.0; rosPoints from week 1 (game_predictions.week = 1) = 375.0 with 17 non-bye games.
- **Proposed fix:** Scale the RoS points by the same `scoreRatio` the card already computes — either pass the ratio into the chip (`rosPoints(w.weeks, currentWk) * scoreRatio`) or precompute the mode-scaled weekly array with team-logic's weeklyPoints() and sum that — and key _rosCache by scoring mode as _ourCache already is. The same scaling must be applied to compare.js's RoS VALUE row when that view is fixed, or the two surfaces will diverge again.

### `sleeper-import-save-line-asserts-stale-rounds`

**The SAVE status line states the stale league-object round count as a fact about the user's league**

- **Where:** `app/views/team.js:3495`
- **What the user sees:** After importing the real league and pressing SAVE LEAGUE SETTINGS, the panel prints: "Saved: Omilia-US · 10 teams · 9 starters + 4 bench · 13 roster slots (your league sets 3 draft rounds in Sleeper; the room drafts one round per slot)." The user's league does not set 3 draft rounds in Sleeper — it sets 13. The app noticed the 3-vs-13 contradiction on screen and, instead of finding the wrong source, shipped a sentence that asserts the wrong number as ground truth, which is more convincing than the bare number it replaced.
- **Evidence:** app/views/team.js:3484-3496 —
      // R27 — SAY WHOSE ROUNDS THESE ARE. This line printed a bare "3 rounds"
      // straight from the league's own draft_rounds while the card above it
      // said "13 ROUNDS" (one per roster slot, which is what the room actually
      // runs). Both numbers were right and nothing on screen said they meant
      // different things...
      const slotRounds = next.shape.roster_positions.length;
      const roundsTxt = next.shape.draft_rounds === slotRounds
        ? `${slotRounds} rounds`
        : `${slotRounds} roster slots (your league sets ${next.shape.draft_rounds} `
          + 'draft rounds in Sleeper; the room drafts one round per slot)';
The comment's premise "Both numbers were right" is false: 3 came from league.settings.draft_rounds, which the live API reports as 3 while the same league's draft object reports rounds: 13.
- **Verifier's correction:** Confirmed as stated. Note this is the same root defect as the draft_rounds finding surfaced at the UI layer, not an independent bug — fixing the source fixes both, and the fix must also handle the paste tier and any league with no draft_id, where the round count still cannot be confirmed.
- **Proposed fix:** Only claim "your league sets N draft rounds in Sleeper" when N came from the draft object (see the provenance field added by the fix above). When the value came from the league object, or from the roster-size fallback, say where it came from instead — e.g. "the room drafts one round per roster slot; Sleeper's league record says 3, which is the league object's stale copy — check your draft settings". Remove the "Both numbers were right" premise from the comment when the source is fixed.

### `auction-engine-my-build-panel-ignores-my-own-budget`

**MY BUILD reports my remaining money against the league default, so an uneven room opens with a partly-filled spend bar and a plan for money I do not have**

- **Where:** `app/views/team.js:3257`
- **What the user sees:** Open PER-TEAM BUDGETS, set YOU to $150 while the league default stays $200, and start the auction. Before a single bid the MY BUILD panel reads '$150 LEFT of $200' with the spend bar already 25% filled, and the slot plan below it targets $103/$49/$23/$11/$5/$2/$1 — $194 of a $200 budget I do not have. The room header also says 'AUCTION SIMULATOR · $200' while the setup card immediately above it correctly says '$2350 IN THE ROOM · UNEVEN'. The AUCTION RESULT card then reports the right number, because scoreAuction reads teamBudgets — so the two screens disagree about how much I started with.
- **Evidence:** aucBuildZone():
  const plan = planBudget(auction.shape, auction.budget, strategy.style);
  const spent = auction.budget - me.budget;
  ... `${dollar(me.budget)} LEFT <span class="cd-meta">of $${auction.budget} ...`
  ... `style="width:${Math.min(100, (spent / auction.budget) * 100).toFixed(0)}%"`
`auction.budget` is documented in app/auction.js:407 as 'the league default — what a team holds unless told otherwise'; my actual starting money is `auction.teamBudgets[auction.mySlot - 1]`. app/auction.js:673-675 scoreAuction gets this right and says why: 'MY starting budget, not the league default — R27 lets them differ, and spending $150 of $185 is not the same efficiency as $150 of $200.' auctionRoomHtml (team.js:3284) has the same defect in the header.
- **Proposed fix:** In aucBuildZone read `const myStart = auction.teamBudgets[auction.mySlot - 1];` and use it for the plan (planBudget(auction.shape, myStart, ...)), the 'of $X' label and the bar denominator; in auctionRoomHtml show the room total (or my own budget) rather than auction.budget when the room is uneven, matching aucBudgetLabel().

### `scoring-consistency-team-season-total-unmarked-partial`

**TEAM's STARTERS SEASON TOTAL folds in a PARTIAL D/ST total with no marker, while every other number on the page marks it**

- **Where:** `app/views/team.js:2010`
- **Criterion:** app/views/team.js:1170-1172 (the page's own stated rule 4) and app/kdst.js:25-33 — "PARTIAL SCORING IS REAL AND MUST BE SAID OUT LOUD… an incomplete number looks exactly like a complete one unless it is marked."
- **What the user sees:** Import a normal Sleeper league (the repo's own fixture has `def_st_ff: 1` and `def_st_fum_rec: 1`, both keys the K/DST builder declared it cannot model) and seat a defence. The DEF1 slot chip shows "95.0* · SZN" with a PARTIAL badge, the finder row shows "95.0*", and the Lineup card says "1 PARTIAL" next to its total — but the TEAM tab's headline "STARTERS SEASON TOTAL · PPR 1,842.3" contains that same incomplete number with no asterisk, no badge and no note. The single most prominent figure on the page reads as complete while the row it is built from admits it is not.
- **Evidence:** app/views/team.js:2009-2010:
```
    const totals = teamWeeklyTotals(starterIds, scaledById);
    const seasonTotal = starterIds.reduce((sum, id) => sum + (adjById.get(id) || 0), 0);
```
and the render, app/views/team.js:2056:
```
        `<span class="ts-label">STARTERS SEASON TOTAL · ${mode.toUpperCase()}</span> ` +
        `<span class="ts-total">${fix1(seasonTotal)}</span> ` +
```
The whole of `paintSummary` (team.js:2005-2080) never reads `p.kdst.partial`; its only K/DST note is about the weekly grid ("NOT in the weekly grid"). Compare team.js:1641 and :1814, which both append `${p.kdst && p.kdst.partial ? '*' : ''}`, and app/views/lineup.js:637 which appends `${startedRows.length} PARTIAL` to the coverage line beside the total.
This contradicts team.js's own stated rule at :1170-1172: "AN INCOMPLETE NUMBER IS MARKED HERE TOO. A PARTIAL total gets its badge on this page as well as on Lineup — otherwise seating a defence just moved an unmarked number to a different screen."
Reachability confirmed: data/kdst_projections.json `unmodelled_keys` = def_4_and_stop, def_st_ff, def_st_fum_rec; tests/fixtures/sleeper_league.json scores def_st_ff=1 and def_st_fum_rec=1.
- **Proposed fix:** In `paintSummary`, collect `starterIds.map(id => playersById.get(String(id))).filter(p => p && p.kdst && p.kdst.partial)` and, when non-empty, append `*` to `fix1(seasonTotal)` plus a `ts-note` naming the players and the omitted component labels — mirroring the coverage string app/views/lineup.js:634-638 already builds.

### `user-stories-paste-failure-points-at-nonexistent-tier3`

**A failed JSON paste tells the user to "Start from standard PPR … Every value is editable" — a tier with no control anywhere in the app, and no scoring editor at all**

- **Where:** `app/views/team.js:3568`
- **Criterion:** Owner standing policy 4: "Never claim a mechanism exists unless it is actually wired end to end." Also docs/roadmap/rel19/USER_STORIES.md R19-E1-S2-AC1 — "three tiers, all shipping together … Tier 2/3 are reachable without a failed fetch first."
- **What the user sees:** Team page → LEAGUE SETTINGS → PASTE LEAGUE JSON INSTEAD. Paste anything that is not a Sleeper league body (a truncated copy, the /rosters response, a stray character) and press IMPORT PASTED JSON. The import report prints two lines: the error, then `Next: Start from standard PPR — Hand-build the league from the standard PPR default. Every value is editable.` There is no such button, link, or tier on the page — the panel offers exactly two routes (SYNC NOW and the paste textarea) — and no surface in the app lets a user edit a single scoring value. The user is instructed to use a feature that does not exist, on the one path where they are already stuck.
- **Evidence:** app/views/team.js:3568 `applyImport(importFromPastedJson(pasteText));` → app/views/team.js:2591 `importLines = summarizeImport(res);` → app/sleeper.js:1206 `if (result.next_tier) lines.push(\`Next: ${result.next_tier.label} — ${result.next_tier.detail}\`);` with app/sleeper.js:1044 `next_tier: mappedResult.ok ? null : IMPORT_TIERS[2]` and app/sleeper.js:98-102 `{ id: 'default', label: 'Start from standard PPR', detail: 'Hand-build the league from the standard PPR default. Every value is editable.' }`. The lines are rendered at app/views/team.js:2130 (`importLines.map(...)` inside importReportHtml). Nothing outside app/sleeper.js imports `IMPORT_TIERS` or `importPprDefault` — `grep -rn "importPprDefault\|IMPORT_TIERS" app/` returns only app/sleeper.js and tests/feature/sleeper_import.test.mjs. `grep -rn "SCORING_FIELDS" app/views/*.js` returns nothing, so no view can edit a scoring value. Meanwhile app/sleeper.js:15 asserts "THREE TIERS, ALL SHIPPED" and tests/feature/sleeper_import.test.mjs:258 `test('IMPORT_TIERS ships all three routes in order', ...)` passes green.
- **Verifier's correction:** Real, but 'blocker' overstates it: nothing is broken or mis-computed, the first line of the report is the true actionable error, and both shipped routes (SYNC NOW, paste) remain available. The defect is an honesty/copy defect of the R27 class — the app names a route that does not exist and promises an editor ('Every value is editable') that no view provides. The module header at app/sleeper.js:15 ('THREE TIERS, ALL SHIPPED') is part of the same false claim and should be corrected with it. Grading major.
- **Proposed fix:** Either wire Tier 3 (a `START FROM STANDARD PPR` button in leaguePanelHtml calling `importPprDefault()` through `applyImport`) plus the editable table the detail string promises, or stop advertising it: drop `IMPORT_TIERS[2]` from the `next_tier` of `importFromPastedJson`, and correct app/sleeper.js:15 to say two tiers ship. Do not leave the on-screen `Next:` line pointing at an unreachable route.

### `user-stories-superflex-limit-copy-contradicts-aiplus`

**The league-settings card states as "one limit, said plainly" that a SUPERFLEX league is priced as WR/RB/TE — which the AI+ room has not done since R23**

- **Where:** `app/views/team.js:2367`
- **Criterion:** docs/roadmap/rel19/USER_STORIES.md R19-E3-S3-AC4 — "SUPER_FLEX does not silently exclude QBs … it keys off shape.flex and includes QB" (shipped); and owner standing policy 4 — app prose must not describe behaviour the app no longer has
- **What the user sees:** A superflex manager on the Team page reads, directly under SAVE LEAGUE SETTINGS: "One limit, said plainly: the opponent model drafts every FLEX as WR/RB/TE, so a SUPERFLEX league is priced as if its flex were WR/RB/TE." In the AI+ room that is false — the opponents treat SUPER_FLEX as QB-eligible, QB demand rises to ~1.9 per team, the QB replacement level collapses and the AI opponents chase quarterbacks. The same card contradicts itself a few lines up, telling the user that extra flex tokens are "kept exactly as saved and AI+ reads them in full". A manager who believes the limit will either stop using AI+ for the one league shape it was built for, or mis-read every QB price it produces.
- **Evidence:** The claim: app/views/team.js:2367-2368 `'retrained. One limit, said plainly: the opponent model drafts every FLEX as ' + 'WR/RB/TE, so a SUPERFLEX league is priced as if its flex were WR/RB/TE.'`. The contradicting behaviour: app/draft-sim.js:424 `if (!opponentNeeds(counts, pos, ctx.profile)) continue;` where `ctx.profile` is the saved LeagueProfile (app/draft-sim.js:292-304 `aiPlusContext`), and app/team-logic.js:168 `const flexible = geo.flexSlots.some((f) => f.positions.includes(pos));` with app/team-logic.js:131 `SUPER_FLEX: Object.freeze({ QB: 0.90, RB: 0.04, WR: 0.04, TE: 0.02 })`. app/draft-sim.js:401-404 states it outright: "In a superflex league the SUPER_FLEX slot pushes QB demand to ~1.9 starters per team, so the QB replacement level collapses and quarterbacks carry the biggest VOR in the room — the AI+ opponents chase them". Locked by tests/feature/auction.test.mjs:339 `assert.equal(positionDemand(superflex).QB, 1.9)`. SUPER_FLEX reaches the saved profile from the FLEX selector (app/views/team.js:2334 over `FLEX_TOKENS`) via app/views/team.js:472 `const token = FLEX_ELIGIBILITY[c.flexType] ? c.flexType : 'FLEX';`. The self-contradiction sits at app/views/team.js:2316-2321 ("AI+ reads them in full").
- **Verifier's correction:** The claim and the fix are right; two details in the evidence need correcting. (1) The self-contradiction the finding cites at app/views/team.js:2316-2321 only renders when carriedFlex is non-empty (a league carrying a SECOND kind of flex slot), so most superflex users never see it. The contradiction that always renders is the AI+ room-key note at app/views/team.js:2683-2686 — 'Roster shape, flex eligibility and position caps are used in full' — which is printed whenever AI+ is the selected room. (2) Note the sentence is a stale limit of exactly the kind the surrounding comments say the gate audits (the same m-explain has already been wrong twice, per the R27/R28 comments at :2354-2366). Rewrite as proposed: name the ADP/SHARK/auction rooms as the ones that price every flex as WR/RB/TE, and state that AI+ reads the saved flex slots in full.
- **Proposed fix:** Scope the sentence to the rooms it is still true of. The ADP and SHARK rooms and the auction board price from `rosterShape(draftCfg)`, whose flex slots are the literal token `FLEX` (app/draft-sim.js:82) and whose geometry hardcodes `FLEX_TAKES` (app/team-logic.js draftShapeGeometry), so the limit holds there; the AI+ room reads the saved profile and does honour SUPER_FLEX. Rewrite as e.g. "the ADP and SHARK rooms and the auction price every flex as WR/RB/TE; the AI+ room reads your saved flex slots in full."

### `app-honesty-text-superflex-limit-absolute`

**League settings card states the opponent model drafts every FLEX as WR/RB/TE; the AI+ room reads SUPER_FLEX in full**

- **Where:** `app/views/team.js:2367`
- **What the user sees:** A superflex manager opens TEAM > league settings and reads: "One limit, said plainly: the opponent model drafts every FLEX as WR/RB/TE, so a SUPERFLEX league is priced as if its flex were WR/RB/TE." Scrolling ~300px up in the same panel the ROOM key says AI+ uses "Roster shape, flex eligibility and position caps ... in full", and running an AI+ room visibly produces the QB run the first sentence says cannot happen. The manager cannot tell which of the two the app means, and the flagged "limit" is the app understating its own behaviour.
- **Evidence:** app/views/team.js:2367-2368 (the sentence) vs app/views/team.js:2685-2686 `'are not modelled rather than guessed at. Roster shape, flex eligibility and ' + 'position caps are used in full.'`. The AI+ opponent builds its geometry from the saved LeagueProfile: app/draft-sim.js:296 `const geo = rosterGeometry(p);` -> app/team-logic.js:265-296 profileGeometry, which pushes a flexSlot carrying FLEX_ELIGIBILITY.SUPER_FLEX.positions = ['QB','WR','RB','TE'] (app/league.js:86-91), and app/team-logic.js:131 FLEX_WIN_SHARE.SUPER_FLEX = {QB:0.90,...}. app/draft-sim.js:401-404 documents the resulting QB run explicitly. The sentence is true only for the 'adp'/'shark' rooms, which read the draft-sim shape (app/draft-sim.js:82, app/team-logic.js:322-325 hardcode FLEX_TAKES).
- **Verifier's correction:** Real. The sentence is not merely ambiguous — it is false for the AI+ room and true only for the ADP and SHARK rooms, and it errs by UNDERstating what the app does, which is why no test caught it.
- **Proposed fix:** Scope the sentence to the rooms it describes: "the ADP and SHARK rooms draft every FLEX as WR/RB/TE; the AI+ room reads your league's own flex eligibility." An unscoped absolute here is the same defect shape as the R28 scoring message.

### `app-honesty-text-carried-flex-not-drafted`

**Sleeper import report says a carried SUPER_FLEX is not drafted, contradicting the settings note printed alongside it**

- **Where:** `app/views/team.js:2607`
- **What the user sees:** Importing a superflex league (roster_positions containing FLEX and SUPER_FLEX) prints "SUPER_FLEX kept on the profile — the simulator does not draft them." The very next paint of the same panel prints "...SUPERFLEX is kept exactly as saved and AI+ reads it in full." A superflex manager reads the first line and concludes the practice room cannot model their league, when the AI+ room does seat and draft to that slot.
- **Evidence:** app/views/team.js:2606-2607 `if (mapped.carried.length > 0) lines.push(`${mapped.carried.join(', ')} kept on the profile — the simulator does not draft them.`);` — `mapped.carried` comes from cfgFromProfile, which pushes any SECOND kind of flex token into `carried` (app/views/team.js:404-408). Verified against the shipped module: cfgFromProfile(normalizeProfile({shape:{teams:12,roster_positions:['QB','RB','RB','WR','WR','TE','FLEX','SUPER_FLEX','K','DEF','BN','BN']}})) returns carried: ["SUPER_FLEX"]. The settings card already distinguishes the two cases correctly at app/views/team.js:2311-2321 (`carriedFlex` vs `carriedUndraftable`), and the import path never got that split. tests/feature/stale_text.test.mjs only checks carried tokens against DRAFTABLE_TOKENS, which does not contain SUPER_FLEX, so the guard passes.
- **Verifier's correction:** Real. Strictly, the import line is half-true — the snake/auction sim room does not seat the carried SUPER_FLEX slot — but it omits the half the settings card already states, that AI+ reads it in full, so the two panels contradict each other.
- **Proposed fix:** Apply the same carriedFlex / carriedUndraftable split used at app/views/team.js:2311-2321 to the import lines, so a carried flex token gets the "kept as saved and AI+ reads it in full" sentence and only genuinely undraftable tokens get "the simulator does not draft them".

### `app-honesty-text-aiplus-tuned-claim`

**Fit engine claims AI+ is "tuned to raise your weekly ceiling and playoff odds" — no tuning and no fantasy playoff-odds mechanism exists**

- **Where:** `app/views/team.js:1952`
- **What the user sees:** Turning AI+ on in the TEAM tab prints "AI+ re-ranks by 5-yr trajectory, cold-weather edge, and stack synergy — tuned to raise your weekly ceiling and playoff odds." The user is told the recommendations were fitted against an objective (weekly ceiling, playoff odds). Nothing in the app computes a fantasy team's ceiling or playoff odds, and the AI+ terms are three hardcoded constants that no optimiser has ever touched — so the sentence names a mechanism that does not exist.
- **Evidence:** app/views/team.js:1951-1952. The three terms are frozen priors: app/team-logic.js:57 `export const STACK_BONUS = 12;`, :915-916 `export const COLD_SCALE = 5; export const COLD_WEEKS_CAP = 4;`, consumed unchanged by fitScoreV2 (app/team-logic.js:953-1024). app/draft-sim.js:225-229 states the sibling constant is "A DOCUMENTED PRIOR ... not a measurement". Grep for a fantasy playoff-odds computation across app/ returns only data/playoff_odds.json, which is NFL-team season odds rendered on the MODEL tab (app/views/model.js:466-497) and is never read by the fit engine.
- **Verifier's correction:** Real. The precise defect is the word 'tuned' plus the named objective: three hardcoded priors are presented as fitted against a weekly-ceiling / playoff-odds outcome, neither of which any code computes for a fantasy roster.
- **Proposed fix:** Say what it does: "AI+ re-ranks by 5-yr trajectory, cold-weather edge and stack synergy, using fixed documented weights — not fitted, and not measured against outcomes." Drop "tuned" and drop the playoff-odds claim.

### `state-persistence-kdst-roster-wipe`

**A missing/failed kdst_projections.json silently deletes the saved kicker and D/ST from nfl2026.team.v1**

- **Where:** `app/views/team.js:1332`
- **What the user sees:** A manager whose league seats a K and a DEF has both saved on the TEAM page. On any load where /data/kdst_projections.json fails (404 on an older deploy, a dropped request, or the league's scoring table making every kicker `unscored`), the K1 and DEF1 slots come back EMPTY with an "ADD K" button and no message anywhere on the page saying why. The next thing the manager does — tapping ADD on any player, or REMOVE, or letting a LIVE draft room sync — calls saveRoster(roster) and writes the emptied slots back to localStorage. The kicker and the defence are now permanently gone from the saved roster even after the feed comes back. app/views/lineup.js:246-249 guards this exact case ("a stale kicker must not silently vanish merely because the fetch was skipped"); the TEAM builder, which is the only writer of the key, does not.
- **Evidence:** app/views/team.js:1185 `const kdstIndex = kdstSeatTokens.length ? shapeKdst(kdstRes.status === 'fulfilled' ? kdstRes.value : null, savedProfile) : null;` — app/kdst.js:333 `if (!isObj(raw)) return empty;` so a rejected fetch yields byPosition {K:[],DEF:[]}. Then app/views/team.js:1213 `const seatable = kdstRows.length ? players.concat(kdstRows) : players;` / :1301 `const playersById = new Map(seatable.map((p) => [String(p.gsis_id), p]));` / :1332 `const roster = loadRoster(new Set(playersById.keys()), savedProfile);`. loadRoster at :172-181 keeps a slot ONLY when `validIds.has(id)`: `const id = stored.slots[s] == null ? null : String(stored.slots[s]); if (id && validIds.has(id) && !seen.has(id)) { slots[s] = id; ... }`. K/DST ids are absent from player_projections.json (verified: positions in that feed are exactly QB/RB/TE/WR; '00-0032726' and 'DST-DEN' are not present), so with kdstRows empty every K/DEF id fails the test and is nulled. The loss is then persisted by app/views/team.js:3907-3909 `roster.slots[slot] = id; selectedSlot = null; saveRoster(roster);` (and :3439 remove, :1054 syncLiveRoom). Nothing in team.js reads kdstIndex.ok or renders a degraded notice — grep for `unscoredPositions|kdst.ok|awaiting` in app/views/team.js returns nothing.
- **Verifier's correction:** The mechanism and the persistence are exactly as stated, but tighten the trigger: data/kdst_projections.json is present in the repo and served by Netlify, so a 404 is unlikely on a current deploy — the realistic triggers are a rejected/aborted fetch (flaky mobile network, the request dropped while the required projection fetch still succeeds) or a contract whose games_projected is missing/<=0 (app/kdst.js:338), plus the all-rows-unscored case. Also worth adding to the report: the page does not merely stay silent — selecting the emptied K1 slot makes the fit-engine panel print 'No eligible players left for K1', a statement app/views/team.js:1884-1889 documents as false.
- **Proposed fix:** Do not let an optional feed decide what stays in the saved roster. Either (a) pass loadRoster a second "unresolved but retained" set so ids that only the K/DST contract could resolve are kept in place when that contract did not load (mirroring app/views/lineup.js:246-249), or (b) gate saveRoster so it never writes a slot map that dropped ids the current mount could not resolve — and paint a visible degraded chip on the K/DEF slot ("kicker projections did not load") instead of an empty ADD K button, per the loud-degradation policy.

### `ipad-layout-a11y-auc-restatement-hover-only`

**When the league budget differs from ESPN's board, the AUC column shows a rescaled number while the visible legend still claims it is ESPN's bid — the correction exists only in a title attribute**

- **Where:** `app/views/team.js:1532`
- **What the user sees:** Set a $150 league in PER-TEAM BUDGETS / the BUDGET field (R27 made this typeable). The finder rows and BEST PICK NOW now print `AUC $27` where ESPN actually published $36 — the number is silently rescaled to the user's budget. The on-screen legend directly above those rows still reads "AUC = ESPN's average winning bid". On an iPad there is no hover, so the sentence that discloses the rescale ("published as $36 on a $200 board and restated here in your $150") is unreachable: it lives only in a `title=`. The manager reads a market price that is not the market price, with the app's own visible key telling them it is.
- **Evidence:** The rescale (app/views/team.js:1464-1466):
```
const scale = mktBudget ? draftCfg.budget / mktBudget : null;
const mkt = mktRaw != null && scale != null ? mktRaw * scale : mktRaw;
```
and `mktBudget` is ESPN's published board budget (team.js:1351, `adpDoc.auction_budget`; data/adp.json:8 = 200), while `draftCfg.budget` is user-typed (team.js:2816 `value="${draftCfg.budget}"`, bounds enforced at team.js:3979).
The disclosure is title-only (app/views/team.js:1494-1499):
```
+ (mktBudget
    ? (scale === 1
      ? `, published on a $${mktBudget} board.`
      : `, published as $${Math.round(mktRaw)} on a $${mktBudget} board and restated `
        + `here in your $${draftCfg.budget}.`)
```
consumed only at team.js:1507 `<span class="cd-val" title="${esc(title)}">`.
The visible key contradicts it unconditionally (app/views/team.js:1529-1534):
```
'<span class="cvl-txt">OURS = our auction price (VOR). '
+ 'AUC = ESPN\'s average winning bid. '
+ 'OVER / UNDER = are you paying above or below the room.</span>'
```
This is the one title-only case on the Team page that carries information the user needs; the OVER / UNDER / FAIR flags themselves are fine — they render as words (team.js:1473-1485) and are explained in the same visible legend. app/views/players.js has the identical title text (players.js:362-368) but is safe because it always prices at `OUR_BUDGET = DEFAULT_BUDGET` (players.js:592), so `scale` is always 1 there.
- **Proposed fix:** Make the legend conditional on `scale`: when `mktBudget && draftCfg.budget !== mktBudget`, render "AUC = ESPN's average winning bid, restated in your $N budget (published on a $M board)" instead of the unqualified sentence; when `mktBudget` is absent, say "shown as published — ESPN does not publish this board's budget". Alternatively append a small visible `· $N` scale chip to the AUC cell whenever `scale !== 1`.

### `pipeline-contracts-market-prices-ref-hole`

**market_prices.schema.json validates nothing below `sources`/`games`/`futures` ($ref unsupported), and the builder already emits values that contract forbids**

- **Where:** `data/contracts/market_prices.schema.json:18`
- **What the user sees:** Two ways this bites. Today: garbage from Kalshi/Polymarket ships unchecked — I injected `{"status":"degraded","rows":3,"note":"...","bogus_key":123}` and a future row with `prob: 7.5` and an unknown team into the real document and validate_data.py passed it, so the SLATE market strip and the MODEL tab would render a 750% market price. Tomorrow: the obvious fix (teach the validator $ref, as three sibling schemas already assume) makes the daily pipeline die exactly like R29 — build_markets writes status "degraded" plus a `note` key whenever ONE of Polymarket's two sub-sources fails, and the contract permits neither, so validate_data would reject after the whole run and prod would keep the stale feed.
- **Evidence:** Six $refs (schema lines 18,19,28,29,38,39), e.g. `"kalshi": { "$ref": "#/definitions/source" }`. scripts/validate_data.py's _validate (line 179) implements only "type, required, properties, additionalProperties, items, enum, minimum, maximum, minItems, maxItems" (docstring line 8) — a schema node containing only $ref has no type/required/properties and additionalProperties defaults True, so it is a no-op. The repo knows: player_backtest.schema.json:5, player_usage_weekly.schema.json:5 and ros_backtest.schema.json:5 all say "Deliberately NO $ref ... a $ref here would be an unvalidated hole" — market_prices was never converted. Meanwhile the contract's source definition is stale: line 48 `"status": { "type": "string", "enum": ["ok", "down"] }` with additionalProperties false, while scripts/build_markets.py:226-233 emits `{"status": "degraded", "rows": ..., "dropped_unmapped": ..., "note": ...}` and `{"status": "down", "rows": 0, "note": ...}`.
- **Proposed fix:** Inline the three definitions at their six use sites (the same edit ros_backtest.schema.json already took), and in the same change add "degraded" to the status enum and declare `note` as an optional string — so the contract describes what build_markets actually writes before the validator starts enforcing it. Add a node test that asserts the schema contains no "$ref" anywhere under data/contracts/, so the next one cannot land.

### `qa-coverage-rollup-counts-tests-that-do-not-exist`

**QA_COVERAGE.md claims all 87 stories clear ≥90% AC coverage; 160 of the 309 AC→test mappings name only test files that do not exist**

- **Where:** `docs/backlog/QA_COVERAGE.md:12`
- **What the user sees:** Nothing renders wrong from this file alone, but it is the artifact the owner is told to trust: "Open the epic file, find the story ID, read its QA coverage block — it names the test file and case for each AC." Doing that for a randomly chosen story succeeds only about half the time. Anyone deciding whether a change is safe to ship — or whether a regression could have slipped through — is reading a coverage number that was computed by counting tests that were never written. Concretely: P3 (Multi-Model Ensemble) is rolled up as "5 stories · 4×100%, 1×75%" while 16 of its 18 ACs point at tests/feature/ensemble.test.mjs, a file that does not exist, for a module (any ensemble) that does not exist either.
- **Evidence:** docs/backlog/QA_COVERAGE.md:11-15 — "**16 epics · 87 user stories.** / **82 stories at 100%** automated AC coverage. / ... so **all 87 stories meet the ≥90% standard**." and line 66: "Open the epic file, find the story ID (e.g. `N4-S3`), read its `QA coverage` block — it names the test file and case for each AC and marks it Done or Planned."  Measured over docs/backlog/epics/*.md: 309 lines of the form `- <STORY>-AC<n> → \`<artifact>\``; 138 name an artifact that exists on disk, 11 name no code artifact (manual), and 160 name ONLY artifacts that do not exist. ~60 distinct named test files are absent, including tests/feature/{ensemble,game_model,player_projection,pipeline_status,pipeline_scrape,frozen_guard,determinism,headers,sw_purge,deploy_config,cron_racesafe,signal_wiring,contract_catalogue,schema_evolution,live_edge,live_fallback,status_gate,llm_signal_*}.test.mjs and tests/web/{router,players,slate,parlays,live,game_detail,theme,reskin}.spec.mjs, tests/pwa/{install,safe_area,sw_purge}.spec.mjs. Per-epic missing counts: P3 16/18, P9 16/22, N3 16/20, N1 14/18, N2 14/19, P5 14/20, N5 13/22, P6 13/17, P7 13/23, N6 12/18, P10 11/19.
- **Verifier's correction:** Real, but two parts of the framing need correcting and the severity is major, not blocker. (1) The doc is NOT uniformly deceptive at the story level: I checked every mapping and ZERO ACs marked '— Done' point at a missing artifact. All 160 missing-artifact mappings are explicitly marked '— Planned', and QA_COVERAGE.md:66-68 discloses that 'Planned tests are authored alongside the feature they cover'. So a reader who follows the stated recipe does see the Planned marker; the defect is that the AGGREGATE rollup (line 12-15 and the per-epic table) folds Planned into a coverage percentage and presents it as achieved 'automated AC coverage' enforced by a gate step. (2) The sharpest, unambiguous instance is not P3 (Status 🟡, honestly unbuilt) but the six stories marked Status ✅ (shipped) whose named tests do not exist: P6-S1 (4/4 missing), P7-S2 (3/3), P9-S6 (4/4), P7-S3 (2/4), P6-S2 (1/4), P5-S4 (1/3). Those are the ones where 'shipped and fully covered' is false today. Fix the rollup to report only landed-and-asserting tests, and retarget the ✅ stories' mappings to real files.
- **Proposed fix:** Recompute the rollup from artifacts that actually exist. Split the per-story line into two numbers — "ACs with a landed, asserting test" and "ACs with a planned test" — and make the aggregate report only the first. Where a differently-named test already covers the AC (e.g. P6-S1's four ACs are genuinely covered by tests/feature/data_contract.test.mjs, not the named data_reader.test.mjs), retarget the mapping to the real file so the doc's own verification recipe works.

### `qa-coverage-game-model-blend-untested`

**N3-S1/S2 claim 100% coverage against tests/feature/game_model.test.mjs, which does not exist; no test executes scripts/models/game_model.py**

- **Where:** `docs/backlog/epics/N3-game-model.md:27`
- **What the user sees:** Every win probability shown on the Slate screen is produced by `game_model.predict_game` (scripts/build_predictions.py:295). Its two headline behaviours — agree → normalized weighted average, disagree → element-wise max so opposing strong evidence is not averaged into a coin flip — are executed by no test in the repo. Replace `blend_vectors`' disagree branch with a plain average and every disagreeing game on the Slate collapses toward 50/50 while the full gate stays green; the user sees a slate of coin flips and nothing reports a regression.
- **Evidence:** docs/backlog/epics/N3-game-model.md:27-31 — "- N3-S1-AC1 → `tests/feature/game_model.test.mjs::agree_weighted_average` (unit) — Planned / - N3-S1-AC2 → `tests/feature/game_model.test.mjs::disagree_takes_max` (unit) — Planned / … - Coverage: 4/4 = 100%." (N3-S2 repeats at :45-48 for `equal_elo_neutral_half` / `home_field_logistic`.) `ls tests/feature/` has no game_model.test.mjs, and `grep -rn "scripts.models" tests/` shows tests import only `scripts.models.elo` (backtest.test.mjs, offgrid_search.test.mjs) and `scripts.models.parlay_builder` — never game_model. `scripts/models/game_model.py:128-187` holds `_favorite` and `blend_vectors`; `:87 elo_prob` is likewise unexercised, and no test pins `elo.expected_home(1500,1500,hfa=0) == 0.5` either.
- **Verifier's correction:** Correct. Minor scope note on the 'no test pins elo' sub-claim: tests/feature/offgrid_search.test.mjs:147 and tests/feature/backtest.test.mjs:171 DO execute scripts.models.elo (elo.expected_home, elo.rate_season), so Elo is not wholly untested — what is untested is game_model.elo_prob (its own 400-point logistic at game_model.py:87) and the entire blend. Also worth flagging when writing the test: blend_vectors treats a market-derived vector as a first-class blend source (game_model.py:196-210 _game_sources), which is a separate concern against the display-only market policy.
- **Proposed fix:** Add tests/feature/game_model.test.mjs shelling to python3: agree case → assert the normalized weighted average to 1e-12; disagree case (Elo home 0.60 vs market away 0.60) → assert element-wise max + renormalize and assert the result is NOT within 0.02 of 0.50; equal-Elo-neutral → 0.5 ± 1e-9; +65 hfa → the exact 400-point logistic value, not a literal bump. Until then correct N3-S1/S2 coverage to 1/4 (the schema AC) and 0/3.

### `qa-coverage-parlay-correlation-math-unasserted`

**N4-S2/S3/S4 claim 100% coverage for edge, correlation-adjusted EV and confidence tier — parlay_rules.test.mjs asserts none of that math**

- **Where:** `docs/backlog/epics/N4-parlay-builder.md:63`
- **What the user sees:** Every parlay card on the Parlays screen prints a `model_ev`, a `confidence_tier` (high/medium/low) and a correlation note claiming "combined probability uses a pairwise correlation adjustment (not the independence product)". If `_SAME_GAME_DEFAULT_RHO` were set to 0, `_CORR_RULES` emptied, or `_combined_probs` swapped for the naive product, every EV on that screen would change and every card would keep the same note — and the whole gate stays green. That is the R28 failure mode exactly: the label survives, the mechanism does not.
- **Evidence:** docs/backlog/epics/N4-parlay-builder.md:63-67 — "- N4-S3-AC1 → `tests/feature/parlay_rules.test.mjs::positive_corr_above_product` (unit) — Planned … - Coverage: 4/4 = 100%." (same shape at :44-48 for N4-S2's edge_definition/no_line_negative_edge/real_line_positive_edge and :81 for N4-S4's tier_monotone). None of those case names exists. The strongest correlation assertion actually in the file, tests/feature/parlay_rules.test.mjs:87-98, is: `assert.ok(typeof p.correlation_note === "string" && p.correlation_note.trim().length > 0, …)` — a non-empty-string check on a hardcoded sentence. tests/feature/parlay_props.test.mjs does import build_game_parlays but its only correlation-flavoured assertion (:141-147) is `r.parlays.some(p => mk[0]==='qb_pass_yds' && mk[1]==='wr_rec_yds')` — the pair exists; the comment says "rho 0.45" but nothing asserts rho is applied. No test in the repo reads `model_ev`, `_pair_rho`, `_combine_two` or `_combined_probs` numerically.
- **Verifier's correction:** Accurate as written. One clarification worth carrying into the fix: the IMPLIED side is deliberately always the independence product (_combined_probs docstring, parlay_builder.py:158-170), so the pinned assertions must compare the MODEL prob against p1·p2, not the parlay's implied prob.
- **Proposed fix:** Add pinned unit cases against scripts/models/parlay_builder.py: (1) two legs with a positive-rho tag → combined model prob strictly greater than p1·p2 by a pinned amount; (2) a negative-rho pair → strictly less; (3) scope='week' → exactly p1·p2 and note contains "independent legs"; (4) `model_ev` recomputed from the adjusted prob, asserted to differ from the EV the bare product would give; (5) tier monotonicity over (edge, n_legs). Until they land, mark N4-S2/S3/S4 coverage as 0/3, 0/4, 0/3.

### `ipad-layout-a11y-view-is-one-giant-live-region`

**`aria-live="polite"` is on `<main id="view">`, so every partial repaint queues the entire changed subtree for announcement**

- **Where:** `index.html:64`
- **What the user sees:** With VoiceOver on (the normal way an iPad user reads this app), typing three letters into the Team tab's player search makes the screen reader read out the whole rebuilt candidate list — up to FINDER_CAP rows of name, position, team, SoS, bye, badges and both price cells — instead of just moving the cursor. Adding a player to a slot announces the roster, the candidate list, the recommendation panel and the team summary in sequence. Switching tabs announces the entire new page top-to-bottom before the user can navigate it. The live region cannot be silenced without turning the screen reader off.
- **Evidence:** index.html:64 — `<main class="view" id="view" aria-live="polite" tabindex="-1"></main>`. This element is the mount point for every route: `app/main.js:110` `const el = document.getElementById('view');` … `app/main.js:129` `return route.mount(el);`, and each view assigns `el.innerHTML = …` (e.g. app/views/team.js:1541, app/views/lineup.js:252, app/views/players.js:852).
All partial repaints also happen inside it:
  - app/views/team.js:3352 `paintCands()` → `box.innerHTML = rows.join('')` (team.js:3835 region, `#t-cands`), fired on every 140 ms search debounce (team.js:3930).
  - app/views/team.js:3349-3355 `paintAll()` → paintDraft + paintRoster + paintCands + paintReco + paintSummary, fired on every add/remove.
The app already has a correctly-scoped live region for status — index.html:60 `<div class="health" id="health" role="status" aria-live="polite">` — so the pattern is understood; `#view` is simply the wrong element to put it on.
- **Proposed fix:** Remove `aria-live="polite"` from `#view` (route changes are already announced by the `el.focus()` at app/main.js:122 landing on the `tabindex="-1"` region). If specific state changes need announcing, add a small dedicated visually-hidden `role="status"` element and write short strings into it ("12 players match", "Bid $35", "RESET armed — activate again to confirm").

### `model-slate-parlays-kalshi-reported-ok-with-zero-rows`

**MODEL tab's DATA FRESHNESS card reports the Kalshi feed as OK and freshly refreshed while it delivered zero rows**

- **Where:** `scripts/build_predictions.py:690`
- **What the user sees:** On #/model the DATA FRESHNESS card says "Overall OK · 18/18 feeds ok · status written 0m ago" and the KALSHI row shows a green dot, "OK", "0m ago", rows "0". Two cards below, PLAYOFF ODDS — OURS vs THE MARKETS renders a KALSHI column that is "—" for all 12 teams. The user is told the feed is healthy and just refreshed while it produced nothing, which is exactly the silent-zero the pipeline_status module was written to prevent.
- **Evidence:** scripts/build_predictions.py:686-693 sets the status by hand and hardcodes "ok" without ever looking at the row count:
            src = mdoc["sources"].get(src_name, {})
            ok = src.get("status") == "ok"
            feeds[src_name] = (
                {"rows": src.get("rows", 0), "age_hours": 0.0,
                 "last_success_utc": now, "status": "ok"}
                if ok else ...)
and scripts/build_markets.py:167-170 returns status "ok" with a computed row count that can be 0:
        sources["kalshi"] = {"status": "ok", "rows": len(games_k) + len(futures["kalshi"]), "events_seen": len(events), "unmatched": unmatched}
Shipped data confirms it: data/market_prices.json sources.kalshi = {"status":"ok","rows":0,"events_seen":26,"unmatched":0}, futures.kalshi = [] (0 entries), and data/pipeline_status.json carries "kalshi": {"rows": 0, "age_hours": 0.0, "last_success_utc": "2026-08-14T21:37:00Z", "status": "ok"} with top-level "health": "ok".
The rule that would have caught it exists but is never called: scripts/pipeline_status.py:93-94 — `if rows == 0: status = "down"  # silent-zero: the cardinal sin, always down`. build_predictions.py never calls evaluate_feed/compute_status; it assembles the feeds dict inline at 25+ sites. Same bypass produces "environment": age_hours 697.1 (29 days) hardcoded "ok" at line 487-492, where the module's default spec (down_hours 72) would say "down".
The UI then counts it as green: app/views/model.js:173 `const okN = entries.filter(([, f]) => f.status === 'ok').length;` feeding the "${okN}/${n} feeds ok" summary at line 178, and app/views/model.js:503 `<span class="po-mkt">${fmtPct(kal.get(ab))}</span>` renders '—' for every team because the map is empty.
- **Verifier's correction:** Finding confirmed, but the proposed minimum fix (`ok = ... and src.get("rows",0) > 0`) is safe only for kalshi; do NOT generalise it by routing every feed through evaluate_feed, because data/pipeline_status.json also carries espn_results_2026 with rows 0 / status ok, which is legitimate (no 2026 game has been played) and would be flipped to 'down', turning the whole dashboard red for a non-problem. Fix kalshi (and the hardcoded 'ok' on `environment` at build_predictions.py:484-492, which reports a 29-day-old file as fresh) with a per-feed rule that distinguishes 'nothing has happened yet' from 'the feed delivered nothing'.
- **Proposed fix:** Route every feed observation through scripts/pipeline_status.evaluate_feed instead of hand-building the record: collect {rows, last_success_utc} per feed in build_predictions and call compute_status(observations, as_of=now) once at the end, so the rows==0 -> down and age -> stale/down rules actually apply. Minimum fix at line 686-693: `ok = src.get("status") == "ok" and src.get("rows", 0) > 0`.

### `pipeline-contracts-preseason-builder-never-runs`

**build_preseason.py is invoked by no workflow, its output is read by nobody, and its docstring claims a registry weight and promotion path that do not exist**

- **Where:** `scripts/build_preseason.py:18`
- **What the user sees:** data/preseason_form.json is frozen at the commit that introduced it — generated_utc 2026-08-13T17:24:41Z, preseason_games_seen 1, 32 players — and there is no code path that can ever refresh it. Two preseason weeks have been played since. Anything that consumes it (or any future surface built on "preseason form") reports August 13th's one-game sample as current, and the whole feature is presented in the repo as a live weight-0 signal awaiting promotion when it is not registered at all.
- **Evidence:** scripts/build_preseason.py:18-20 claims: "WEIGHT 0 — `preseason_form` ships at registry weight 0.0 like every learned signal, so today it moves no published number at all. It has to clear the never-regress promotion gate to earn any weight." But `grep -rn preseason scripts/signals/*.py data/meta.json` returns nothing: preseason_form is absent from scripts/signals/registry.py's SIGNALS (32 entries, none named it), absent from data/meta.json weights, and absent from scripts/promote_signals.py — so there is no gate for it to clear. `grep -rn build_preseason .github/ scripts/` finds it only in scripts/scrape/espn_gamestats.py comments, tests/smoke.sh:49 (a --selftest that writes nothing) and tests/feature/preseason.test.mjs — never in daily.yml, gameday.yml or backtest.yml, and never in build_predictions.py. Separately, preseason_form.schema.json is the one contract missing from scripts/validate_data.py's SCHEMA_TO_DATA map (lines 62-96), so the crons that run `python scripts/validate_data.py` never check it; only the node test does.
- **Proposed fix:** Decide which it is and make the repo say so. Either (a) add a `python scripts/build_preseason.py` step to daily.yml above the validate step, register `preseason_form` in scripts/signals/registry.py at 0.0 (and in data/meta.json + validate_data.EXPECTED_SIGNALS), give it a family in promote_signals.py, and add "preseason_form.schema.json": "preseason_form.json" to SCHEMA_TO_DATA with the file in OPTIONAL_DATA; or (b) delete the builder, the contract and the frozen artifact. Do not leave the docstring asserting a registry weight the registry has never heard of.

### `pipeline-contracts-unimplemented-schema-keywords`

**minProperties / maxProperties / pattern / exclusiveMinimum / exclusiveMaximum / minLength are silently ignored by validate_data.py in 13 contracts**

- **Where:** `scripts/validate_data.py:179`
- **What the user sees:** Every row-count floor and range bound written into these contracts is decorative. I set data/team_strength.json's `ratings` to a single team and validate_data.py returned clean, although the schema says minProperties 30 — so a partial ESPN 2025-results pull (fetch_final_results legitimately returns fewer finals without raising, and build_predictions marks the feed "ok" as long as it is non-empty) would ship a team_strength.json covering a handful of teams, the pipeline would commit it, and the app's 1.0-5.0 strength-of-schedule scale — normalised off elo_min/elo_max of that span — would render nonsense for all 32 teams. The same hole covers playoff_odds.teams (30), defense_composite.teams (30), oline_composite.teams (30), epa_history (30/1/1 + maxProperties 2), injuries.counts (1), injury_history.seasons (1), player_usage_history (200/1), weather_history.games (500), market_baseline.games (1000) plus its probability bounds exclusiveMinimum 0 / exclusiveMaximum 1 and `policy` pattern, weather_forecast (0), preseason_form (minLength 40, 0).
- **Evidence:** validate_data.py:179 `_validate` handles only type/enum/minimum/maximum/required/properties/additionalProperties/items/minItems/maxItems; unknown keywords fall through with no error. Proof run against the real files: patching data/team_strength.json's ratings to {'KC': 1600.0} and calling validate_against_schema against data/contracts/team_strength.schema.json (which has "minProperties": 30 at line 19) printed no error. The repo has already hit this twice and documented it in prose instead of fixing it — game_context.schema.json:5 ("pattern/minProperties are unimplemented in this repo's validator subset") and player_usage_weekly.schema.json:5 ("minProperties is likewise avoided — the validator does not implement it").
- **Verifier's correction:** The count is 12 contracts, not 13: game_context.schema.json only MENTIONS the keywords in its description (line 5, explaining it deliberately avoids them) and carries none. Everything else in the finding holds.
- **Proposed fix:** Either implement the five keywords in _validate (each is 3 lines) or make the validator FAIL on any keyword it does not implement — the second is stronger, because it converts every future decorative constraint into a red gate instead of a silent no-op. Then re-run the gate: the contracts that already use them become enforced, and the two schemas that dodged them can use them again.

### `qa-coverage-harness-python-never-executed`

**P1-S2/S3 ACs are marked Done against tests that re-implement scripts/harness/{metrics,conformal}.py in JavaScript; the Python is never executed**

- **Where:** `tests/feature/metrics.test.mjs:3`
- **What the user sees:** The MODEL screen's log-loss / Brier figures, and every adoption decision archived into data/model_tuning.json, come from scripts/harness/metrics.py. Break `brier()` there — e.g. change `diff*diff` to `abs(diff)` — and both metrics.test.mjs (which scores its own JS copy) and the only Python-side check (tests/feature/backtest.test.mjs:88, `assert.ok(G.base.brier > 0 && Number.isFinite(G.base.brier))`) stay green, so a wrong accuracy number ships to the MODEL page under a green gate. conformal.py is worse: the four "Done" P1-S3 ACs mirror a module that no pipeline script imports at all (scripts/build_all.py:395 — "real conformal safe-set tier until harness/conformal.py is wired in").
- **Evidence:** tests/feature/metrics.test.mjs:3-6 — "// The Python harness (scripts/harness/metrics.py) is the source of truth. This / // test RE-IMPLEMENTS the identical arithmetic in JS (no cross-language import) / // and asserts the exact numbers so the two implementations can never silently / // diverge." It then defines its own `logLoss`/`brier`/`mae` at :17-33 and asserts against those. tests/feature/conformal.test.mjs:18-41 likewise defines local `calibrate`/`safeSet`. `grep -rn "scripts.harness" tests/` returns only comment lines — no test ever imports or shells to the harness package. Meanwhile docs/backlog/epics/P1-evaluation-harness.md:50 marks "P1-S2-AC1 → `tests/feature/metrics.test.mjs::brier … equals exactly 0.18` … — Done" and :72-75 mark all four conformal ACs Done.
- **Verifier's correction:** Correct, with one precision fix: the MODEL screen displays log-loss (app/views/model.js:59, :239-240, :294, :361), not Brier — 'Brier' appears only in a comment at model.js:5. Brier from metrics.py surfaces via scripts/backtest.py output, not the MODEL page. The conformal half is the stronger point and should lead: four P1-S3 ACs are marked '— Done' (P1-evaluation-harness.md:72-76) against a JS mirror of a module that no pipeline script imports, while the shipped tier the user actually sees comes from build_all.py:392-398.
- **Proposed fix:** Do what tests/feature/backtest.test.mjs already does for scripts.backtest — shell to `python3 -` and assert the Python outputs: `metrics.brier(0,[0.7,0.3]) == 0.18`, `metrics.log_loss(0,[0.7,0.3]) == -ln(0.7)`, `conformal.calibrate(CAL,0.8) == 0.9`. Keep the JS mirrors if desired, but assert Python-vs-JS equality so the two genuinely cannot diverge. Separately, mark P1-S3 as untested-in-production until conformal.py is wired.

### `qa-coverage-signal-registry-mirror-never-compared`

**P4-S3-AC2 ("a renamed signal in registry.py fails the test until meta.json matches") is marked Done, but signal_registry.test.mjs compares meta.json to a hardcoded literal and never reads registry.py**

- **Where:** `tests/feature/signal_registry.test.mjs:16`
- **What the user sees:** The AC's stated behaviour is simply false: rename `ol_composite_vs_dl` to anything else in scripts/signals/registry.py and the gate stays green, because the test's `EXPECTED` list is a copy pasted into the test file. The optimizer's feature keys and data/meta.json would then disagree about which factor is which, and the MODEL screen's weights table would show a signal name that no longer exists in the registry (or silently omit one that does) with no test firing. The test named in the AC as the enforcement mechanism cannot enforce it.
- **Evidence:** tests/feature/signal_registry.test.mjs:14-16 — "// The full registry, in group order (player 19, game 10, market 3 = 32)." then `const EXPECTED = [ … ]`, and :7 "// must match registry.py byte-for-byte" — a comment, not an assertion. The three tests at :38, :49, :54 compare `meta.weights` against `EXPECTED` only. `grep -rn "registry.py\|SIGNAL_REGISTRY" tests/` returns two comment lines and nothing executable. docs/backlog/epics/P4-signal-registry.md:55 states the AC and :64 marks it "— Done". (Verified the two lists happen to agree today: registry SIGNALS n=32, meta.weights n=32, same set and same order — so the drift is unguarded, not yet present.) The same file's P4-S5-AC2 ("docs/SIGNAL_REGISTRY.md … doc is not stale") maps to a `doc-matches-registry` case that does not exist.
- **Verifier's correction:** Real as stated; two refinements. (a) There is a second hardcoded mirror — scripts/validate_data.py:113-117 EXPECTED_SIGNALS — so the fix needs BOTH mirrors sourced from scripts.signals.registry.SIGNALS, not just the .mjs one. (b) The test does not actually check ORDER despite the comment at :15 ('in group order'): :49 uses EXPECTED.includes() and :38 uses `name in meta.weights`, both order-insensitive, so a reorder in registry.py is doubly unguarded.
- **Proposed fix:** Replace the hardcoded `EXPECTED` with a value read from the source of truth: shell to `python3 -c "from scripts.signals.registry import SIGNALS; print(json.dumps(list(SIGNALS)))"` and deep-compare against `Object.keys(meta.weights)` for both set and order. Add the same comparison against the name tables in docs/SIGNAL_REGISTRY.md to make P4-S5-AC2 real.

### `qa-coverage-sw-purger-and-headers-unasserted`

**P7-S3 and P9-S6 are both marked Status ✅ at "Coverage: 4/4 = 100%"; nothing in the repo asserts sw.js has no fetch handler and no test reads _headers at all**

- **Where:** `tests/pwa/standalone.spec.mjs:363`
- **What the user sees:** This is the wc2026 stale-shell postmortem the docs cite by name. If a future change adds a caching `fetch` handler to sw.js, or relaxes `/data/*` from `max-age=0` to a long TTL, users get day-old JS and day-old projections after a deploy — the Slate and Players screens would silently show last week's numbers with a fresh-looking timestamp. Eight acceptance criteria across two stories marked shipped-and-fully-covered stand between that and production, and zero of them are asserted anywhere.
- **Evidence:** docs/backlog/epics/P7-pwa-design-system.md:53 "### P7-S3 — Pure cache-purger service worker · Status: ✅" with :65 "- P7-S3-AC1 → `tests/smoke.sh::sw-has-no-fetch-handler` (smoke) — Planned" and :68 "- P7-S3-AC4 → `tests/smoke.sh::headers-freshness-policy` (smoke) — Planned", closing "- Coverage: 4/4 = 100%." tests/smoke.sh contains neither check (it never mentions sw.js or _headers). docs/backlog/epics/P9-deploy-ops.md:105-120 repeats the claim against tests/feature/{sw_purge,headers}.test.mjs — neither file exists. `grep -rln "_headers" tests/` returns nothing. The single SW test in the repo, tests/pwa/standalone.spec.mjs:363-375, is titled "service worker registers (cache-purger)" but its only assertion is `expect(ready).toBe(true)` after awaiting `navigator.serviceWorker.ready` — it would pass unchanged against a full precaching service worker.
- **Verifier's correction:** Accurate. One factual nit for the fix: P9-S6-AC3 pins /data/* as 'max-age=0, stale-while-revalidate=120' while P7-S3-AC4 describes /data/* as 'must-revalidate'; the file actually has `max-age=0, stale-while-revalidate=120` for /data/* and `max-age=0, must-revalidate` for /index.html and /sw.js. Whichever check gets written should pin the _headers text, and the two ACs should be reworded to agree with each other.
- **Proposed fix:** Two cheap stdlib checks in tests/smoke.sh (or a node feature test): (1) `sw.js` must not match `addEventListener('fetch'` and must contain the `nfl26-` cache purge + `clients.claim()`; (2) parse `_headers` and assert the four blocks the ACs pin — `/app/*` max-age=120 + stale-while-revalidate=600, `/data/*` max-age=0, `/index.html` and `/sw.js` max-age=0 must-revalidate, and the four security headers on `/*`. Rename the pwa test to what it checks, or extend it to probe the active SW for a fetch handler.


## MINOR — 20

### `auction-engine-inflation-biased-low-at-kickoff`

**A fresh room reports negative inflation and prints 'bargains ahead — money is scarce' before a single dollar is spent**

- **Where:** `app/auction.js:399`
- **What the user sees:** Start an 8-team auction (an offered TEAMS option) at $200 with the default roster. Before any nomination the ROOM panel gauge shows 'INFLATION -4%' styled cold, with the copy 'bargains ahead — money is scarce' — in a room where, by construction, the money exactly equals the draftable pool's fair value. A 2-team imported league (LEAGUE_BOUNDS allows down to 2) opens at -28%.
- **Evidence:** createAuction sums the inflation denominator over the WHOLE board, not the draftable pool:
  let remainingFair = 0;
  for (const r of boardRows.filter((x) => x.gsis_id)) {
    remainingFair += fair.get(String(r.gsis_id)) || 0;
  }
data/adp.json has 182 rows with a projection but an 8-team/13-slot room drafts only 104, so the 78 rows outside the pool each contribute their $1 fair floor to a denominator the room's money will never chase. Measured: 8 teams money $1600, remainingFair 1675, liveInflation 0.9552 -> team.js:3126-3129 computes pct = -4, which trips `pct < -3` and prints the cold 'bargains ahead — money is scarce' copy. 10 teams -3%, 2 teams -28%, 12 teams -1%. The docstring at app/auction.js:457-458 justifies this — '($1-floor players carry ~$1 of fair value, so no reserve adjustment)' — but that reasoning only holds for players inside the pool; the tail is never bought, so its fair value never leaves the denominator.
- **Verifier's correction:** The defect and the measurements are correct, but the PROPOSED FIX is wrong and would ship a new lie in the other direction. Seeding remainingFair from the first leagueSize*shape.size board rows does not give 1.00: I measured the top-104 fair sum at 1562 against $1600 (ratio 1.024, i.e. +2%) for 8 teams and 2351 against $2400 (+2%) for 12, because 5 of those top-104 rows carry gsis_id:null and so hold no entry in the fair map at all. A correct fix has to account for the unpriced rows inside the pool as well — e.g. count MIN_BID for each pool row missing from `fair` — or the gauge just flips from a false 'bargains ahead' to a false 'selling rich'. Severity stays minor (display copy only; the ratio itself converges as sales drain both sides).
- **Proposed fix:** Seed remainingFair from the draftable pool only — the first `leagueSize * shape.size` board rows by ADP, the same cut fairDollars and marketDollars use for poolN — so a fresh room starts at inflation 1.00, and subtract on sale as it does today.

### `sleeper-import-caps-marked-enforced-without-enforce-flag`

**Imported position limits are stamped as ENFORCED provenance without ever reading the setting that governs enforcement**

- **Where:** `app/sleeper.js:690`
- **What the user sees:** Every Sleeper import stamps position_caps_source: 'sleeper' purely because position_limit_* keys were present, and app/team-logic.js then treats those caps as a hard roster ban that is never raised for byes/injuries. The flag that actually decides whether Sleeper enforces the limits — enforce_position_limits — lives on the DRAFT object (it is present there for league 1393691504228184064 with value 1) and appears nowhere in this repo. For a league whose commissioner left position_limit_qb = 2 in place but turned enforcement off, the app will refuse to recommend a third QB the league would happily let the user roster, and the draft-room advice fails at the draft. The import report compounds it: the user sees nothing about enforcement, because the setting is not in the league payload at all.
- **Evidence:** app/sleeper.js:685-691 —
      // R26 — these caps came from the league's real position_limit_* settings,
      // which Sleeper ENFORCES at the roster. ...
      position_caps_source: 'sleeper',
app/team-logic.js:207-214 justifies the strict reading with "Sleeper's position_limit_* is a field distinct from the starting lineup, and Sleeper ENFORCES it", and app/team-logic.js:228 `const enforced = capsSource === 'sleeper' && !appDefault;` honours the cap exactly. Live evidence: GET /v1/draft/1393691505520041984 returns settings { enforce_position_limits: 1, position_limit_qb: 2, ... rounds: 13 } — the enforcement flag and the limits both live on the draft object. `grep -rn enforce_position_limits` over the repo (excluding node_modules) returns nothing, and app/sleeper.js never fetches /v1/draft/{id}, so the app cannot distinguish an enforced limit from a disabled one.
- **Verifier's correction:** Real but narrower than claimed, and the proposed fix would cause a regression. What I could verify is the overclaim itself: an enforcement authority is asserted from a payload that does not contain the enforcement flag. What I could NOT verify is the triggering state — I have no Sleeper league with position_limit_* present and enforce_position_limits: 0, so the concrete 'refuses to recommend a third QB the league allows' failure is plausible but unconfirmed. Also, gating the stamp on a successful draft GET as proposed would strip position_caps_source from EVERY paste-tier import (sleeper.js:1036 shares sleeperToProfile and has no network), silently reverting those leagues to the lenient +1 reading — the opposite regression. Severity: minor.
- **Proposed fix:** Fetch the draft object anyway (the same call the draft_rounds fix needs) and gate the provenance stamp on it: set position_caps_source: 'sleeper' only when draft.settings.enforce_position_limits === 1, and prefer draft.settings.position_limit_* over the league object's mirror. When the draft object was not read (paste tier, missing draft_id, failed GET), leave position_caps_source unset so app/team-logic.js falls back to the documented lenient reading, and emit a note saying the limits were imported but could not be confirmed as enforced.

### `app-honesty-text-compare-proj-not-in-scoring-mode`

**COMPARE labels a raw full-PPR number "PROJ PTS", the label every other tab defines as "your scoring mode"**

- **Where:** `app/views/compare.js:281`
- **What the user sees:** A half-PPR (or pass_cmp) league opens PLAYERS, reads the legend "PROJ — projected season points (your scoring mode)", sees a WR at 210.4, taps through to COMPARE and sees the same WR under "PROJ PTS" at 261.4. Nothing on the COMPARE screen says its number is on a different scale, so one of the two reads as wrong.
- **Evidence:** app/views/compare.js:167 `proj: projected ? Number(p.proj_points) || 0 : null` — the raw full-PPR season total; compare.js imports withLeagueExtras (line 70) and calls it (line 141) but never reads extra_pts and never calls scoringAdjust or loadScoring. Rendered as `row('PROJ PTS', ...)` at app/views/compare.js:281 and the view-sub at :200 says only "HEAD-TO-HEAD · ESTIMATE". The competing definitions are app/views/players.js:430 "<b>PROJ</b> projected season points (your scoring mode)" and app/render.js:308 which prints the same "PROJ PTS" unit on cards that ARE mode-adjusted.
- **Verifier's correction:** Real. The mismatch is not only the reception mode — the pass_cmp extra (extra_pts) is likewise absent, which is why compare.js calls withLeagueExtras and then discards its only output; that dangling call is the clearest signal the conversion was intended and never wired.
- **Proposed fix:** Either convert on COMPARE the way PLAYERS does (scoringAdjust with the persisted mode plus extraPtsOf), or label the row "PROJ PTS (PPR)" and say so in the view-sub so the two screens are not silently on different scales.

### `scoring-consistency-lineup-extras-inert`

**LINEUP calls withLeagueExtras and never reads it, and applies no scoring conversion at all — its weekly points are hard-wired full PPR**

- **Where:** `app/views/lineup.js:185`
- **Criterion:** tests/feature/stale_text.test.mjs:194-219 (every surface prices the same player the same way) and the owner's HONEST DATA policy — a wired mechanism that delivers no observable change.
- **What the user sees:** In STD mode, Puka Nacua's Week 1 reads 13.8 on the TEAM tab's weekly grid and 21.1 on the LINEUP tab's Week 1 row — the same player, the same week, two tabs, a 53% difference. Because the LINEUP optimizer ranks candidates on those unconverted numbers, it can also seat a different FLEX than the TEAM tab's own math implies for a reception-heavy vs. reception-light pair. And in a pass_cmp league the OPTIMAL LINEUP total omits the league's completion points entirely for every quarterback, while PLAYERS and the TEAM fit engine include them.
- **Evidence:** app/views/lineup.js:185 `const weeklyById = withLeagueExtras(weeklyRaw, profile);`
The map is read exactly once, at lineup.js:295 `const w = weeklyById.get(id);`, and the points cell is built raw at lineup.js:303:
```
    const pts = (onBye || avail.playable === false) ? 0 : Number(wkEntry && wkEntry.pts) || 0;
```
`extra_pts` is never referenced in the file, and neither is `scoringAdjust`; lineup.js's only team-logic import is `withLeagueExtras` (lineup.js:89). The shared scoring mode key `nfl2026.scoring.v1` is never read here either.
Contrast app/views/team.js:1309 `scaledById.set(id, weeklyPoints(e, adj, p.proj_points))`, which scales every week by `seasonAdj/seasonPpr` — 246.0/375.0 = 0.656 for Nacua (data/player_weekly.json week 1 pts = 21.1 → 13.84).
- **Verifier's correction:** Downgrade to minor and restate: the mode half is DISCLOSED (visible 'START / SIT · PPR' sub-header at lineup.js:255), so the TEAM-vs-LINEUP number gap is labelled rather than false. What survives is narrower: (1) the withLeagueExtras call at lineup.js:185 is inert — nothing in the file reads extra_pts — while its comment at lineup.js:180-184 claims 'every conversion below prices the same player identically', and tests/feature/stale_text.test.mjs:214 accepts the bare call as proof of correctness; (2) in a pass_cmp league the OPTIMAL LINEUP total omits the league's completion points for every QB, and the 'PPR' label does not tell the user that their own league rule was dropped on this page.
- **Proposed fix:** Read the shared scoring mode and scale the weekly points through the single conversion: build the per-player 18-float array with `weeklyPoints(w, scoringAdjust(p.proj_points, w.receptions_prior, mode, extraPtsOf(w)), p.proj_points)` — the same expression team.js:1307-1309 uses — and pick `pts` out of it, so LINEUP and the TEAM weekly grid are the same arithmetic by construction. If the release deliberately keeps LINEUP at full PPR, say so on the card ("WEEKLY POINTS · PPR") and delete the inert withLeagueExtras call rather than leaving a call the test suite reads as proof of correctness.

### `model-slate-parlays-resolved-locks-never-written`

**SEASON LOCKS card can never report grading is active — no producer writes model_tuning.resolved_locks**

- **Where:** `app/views/model.js:455`
- **What the user sees:** After Week 1 games go FINAL and resolve_locks grades the locked predictions, the MODEL tab's SEASON LOCKS card will still say "In-season lock grading begins when 2026 games go FINAL…" forever. The transparency dashboard will tell the user the learning loop has not started at the exact moment it is running, and the "N locks resolved — in-season grading active" message is unreachable dead code.
- **Evidence:** app/views/model.js:454-462 —
  const resolved = Number(tuning && tuning.resolved_locks) || 0;
  if (resolved > 0) {
    return state(`${resolved} locks resolved — in-season grading active.`);
  }
  return state('In-season lock grading begins when 2026 games go FINAL: …');
`resolved_locks` is read here and nowhere else in the repo: `grep -rn "resolved_locks" --include=*.py --include=*.js --include=*.mjs --include=*.yml .` returns exactly one hit — this line. No pipeline script writes the key. data/model_tuning.json top-level keys are ['generated_utc','objective','margin','current_loss','candidate_loss','improvement','adopted','reason','weights','history','game_params'] — no resolved_locks.
The grading itself is genuinely wired (`python -m scripts.resolve_locks` runs in daily.yml:48, gameday.yml:61, backtest.yml:46, and scripts/refit.py:560 records the count as `n_resolved` inside a history entry of kind "game_params"), so the count exists — it is simply never surfaced under the key the view reads.
- **Verifier's correction:** Real, but 'major' overstates today's impact: the season has not started (data/pipeline_status.json espn_results_2026 rows 0, injury_history has no 2026 block), so the message the card currently prints is accurate. It becomes a false statement the first time a 2026 game goes FINAL and resolve_locks grades a snapshot. Prefer the second proposed fix — derive the count from the newest history entry with kind === 'game_params' and its `n_resolved` field — since that key is already written by scripts/refit.py:588 and needs no pipeline change.
- **Proposed fix:** Either have scripts/resolve_locks.py write the running total to model_tuning.json as `resolved_locks` after each grading pass, or change locksCard to derive it from what the pipeline already writes: read the newest history entry with kind === 'game_params' and use its `n_resolved` field.

### `model-slate-parlays-qb-out-invisible-on-model-tab`

**The one signal family actually applied to live game probabilities (qb_out, 75 Elo) is absent from ADOPTED PARAMETERS and shown as plain RETAINED in the gate table**

- **Where:** `app/views/model.js:269`
- **What the user sees:** On #/model the ADOPTED PARAMETERS card lists exactly three rows — HOME FIELD (Elo) 45, SEASON REVERT 0.45, K 25 — under the sentence "These are the fitted parameters every game probability is priced with". That is not true: game_params also carries qb_out {applied: true, scale: 75}, which subtracts 75 Elo from a team whose primary passer is listed Out/Doubtful — roughly an 11-percentage-point swing in the win probability the SLATE prints on that game's card. In the PROMOTION GATE table qb_out is rendered with a bare "RETAINED" chip, visually identical to the eight families that have never been applied, under a caption that tells the user "losing candidates stay recorded at weight 0". The data's own caveat on that adoption — "Its 95% CI spans zero: it is not statistically distinguishable from noise" — is never shown anywhere in the app. A user auditing the model concludes nothing is influencing predictions when something is.
- **Evidence:** app/views/model.js:268-275 (paramsCard) renders only three keys and then claims completeness:
    row('HOME FIELD (Elo)', gp.hfa_elo, DEFAULTS.hfa_elo) +
    row('SEASON REVERT', gp.revert, DEFAULTS.revert) +
    row('K (update speed)', gp.k, DEFAULTS.k) +
    ...
    '<div class="m-explain">These are the fitted parameters every game probability is priced with — earned against real seasons through the NEVER-REGRESS gate, not hand-tuned.</div>'
data/model_tuning.json game_params = {'hfa_elo': 45.0, 'revert': 0.45, 'k': 25.0, 'adopted_utc': ..., 'source': ..., 'qb_out': {'applied': True, 'scale': 75.0, 'adopted_under': 'fixed_margin_0.0015', 'significance': None, 'note': 'Adopted under the retired fixed-margin rule… Its 95% CI spans zero: it is not statistically distinguishable from noise…'}}.
It is genuinely applied at prediction time — scripts/build_predictions.py:270-277:
        if _qb_scale:
            _hp = _qb_primary.get(g["home"])
            if _hp and _hp in _qb_outs.get((g["home"], _wk), ()): hfa_eff -= _qb_scale
            ... hfa_eff += _qb_scale
        row["hfa_elo"] = hfa_eff
        pred = game_model.predict_game(row, teams=None, model="elo_prior")
(45 Elo HFA gives p_home 0.5646 for even ratings; 45−75 = −30 gives 0.4569.)
The gate entry names it as the live incumbent — data/model_tuning.json history[0].incumbent_families = ["qb_out"] — but nothing in app/ reads that key: `grep -rn "incumbent_families\|qb_out" app/` returns zero hits. familyRows (app/views/model.js:211-226) reads only family/skipped/best/improvement/reason/appliable, so qb_out falls through to `'<span class="gate-chip">RETAINED</span>'` at line 325.
The SLATE compounds it: the card label is hardcoded "elo_prior" (build_predictions.py:295), so app/render.js:283 prints "MODEL · ELO PRIOR" on a probability that includes the qb_out adjustment.
(Currently dormant only because data/injury_history.json has no 2026 season block yet — it goes live the first time build_injury_history.py records a QB as Out.)
- **Verifier's correction:** Real but mis-stated on impact and severity. The claimed user-visible failure — a ~11-point swing on a SLATE card — cannot occur today: data/injury_history.json contains only seasons 2021-2025, so scripts/promote_signals.qb_out_current(2026) yields no team-week listings and the ±75 Elo branch never fires; no shipped probability is currently affected. The defect that IS live is purely the honesty gap: ADOPTED PARAMETERS omits an `applied: true` family while claiming to list everything a game probability is priced with, and the PROMOTION GATE chips the live incumbent as RETAINED under a caption that says retained families sit at weight 0. Fix that labelling; do not describe it as a wrong number on the slate.
- **Proposed fix:** Render the adopted families in paramsCard: iterate the non-scalar keys of game_params that carry `applied: true` and emit a row per family (name, scale, adopted_utc, and the `note` when present), so qb_out's "CI spans zero" caveat is visible. In gateCard, give a family listed in entry.incumbent_families a distinct chip (e.g. "LIVE") instead of RETAINED, and adjust the m-explain so "stay recorded at weight 0" is not applied to a family that is in production.

### `app-honesty-text-model-estimate-on-measurements`

**MODEL tab stamps ESTIMATE on every card, including two whose own bodies read MEASUREMENT ONLY**

- **Where:** `app/views/model.js:530`
- **What the user sees:** The MARKET YARDSTICK card's header reads "MARKET YARDSTICK · OURS vs CLOSING LINE  ESTIMATE" while the legend inside the same card reads "MEASUREMENT ONLY". The same happens on PROMOTION GATE. DATA FRESHNESS (real timestamps and row counts), CALIBRATION (1,084 walk-forward real games) and SIGNAL REGISTRY (the literal stored weights) are also labelled ESTIMATE. Since ESTIMATE is this app's one honesty marker, applying it to measurements teaches the user to ignore it on the cards where it matters.
- **Evidence:** app/views/model.js:528-533 — `const card = (title, body, extra) => (... `<div class="m-head">${title} <span class="est">ESTIMATE</span></div>` ...)` is applied unconditionally to all nine cards at lines 540-549. The contradicting badges are emitted at app/views/model.js:389 and 424 (`<span class="ms-badge">MEASUREMENT ONLY</span>`) and at :368 for the gate bench line.
- **Verifier's correction:** Keep only the checkable half. The defect is the two cards (PROMOTION GATE, MARKET YARDSTICK) whose header says ESTIMATE while their own body says MEASUREMENT ONLY. The claim that the pill on DATA FRESHNESS / CALIBRATION / SIGNAL REGISTRY 'teaches the user to ignore it' is speculation — over-marking there is imprecise but errs toward caution and produces no contradiction.
- **Proposed fix:** Pass an `estimate` flag to card() and stamp the pill only on the cards that project (PLAYOFF ODDS, ADOPTED PARAMETERS' forward use). Leave the measured cards unmarked or give them a MEASURED counterpart pill.

### `draft-room-modes-ourdollars-key-omits-k-def`

**OURS price memo key omits draftCfg.k/def, so the K and DEF steppers repaint the board but change no price**

- **Where:** `app/views/team.js:1380`
- **What the user sees:** Set K = 1 and DEF = 1 in the DRAFT SIMULATOR roster grid. The board repaints (the code explicitly repaints for exactly this reason) but every OURS dollar on it is byte-identical to the 0-K/0-DEF league — 18 of the 182 priced rows are wrong for the rest of the session, e.g. Bijan Robinson stays at OURS $100 when the correct price for that shape is $99 and Lamar Jackson stays at $120 when it is $118. Then start the auction: createAuction recomputes fairDollars with the real K/DEF shape, so the room quotes $99/$118 for the same players the finder is still quoting at $100/$120 — two different OURS prices for one player on one page, which is the exact thing ourDollarsById()'s own docstring says it exists to prevent.
- **Evidence:** team.js:1380-1381 — `const key = `${draftCfg.leagueSize}|${draftCfg.budget}|${roomMoney}|${draftCfg.qb},${draftCfg.rb},` + `${draftCfg.wr},${draftCfg.te},${draftCfg.flex},${draftCfg.bench}`;` — no k, no def. But line 1388-1389 passes `rosterShape(draftCfg)`, and draft-sim.js:82-93 puts `push('K', c.k); push('DEF', c.def);` into `starters`, changing `shape.size` (13 -> 15) and therefore `poolN`/`spread` inside fairDollars (auction.js:245-252). The change handler at team.js:3945-3951 comments "OUR auction dollars are computed from league size, budget and roster shape, so the board's value cell would otherwise show a price for a league the user just changed away from" and repaints for every ROSTER_BOUNDS key (k and def are in ROSTER_BOUNDS, draft-sim.js:57) — the repaint fires and the memo hands back the old Map. Verified by running fairDollars directly on data/adp.json + data/player_projections.json: 18/182 rows differ between k:0,def:0 and k:1,def:1.
- **Verifier's correction:** The mechanism and the 18/182 measurement are right, but the headline consequence is wrong and the severity is overstated. There is NO 'two different OURS prices for one player on one page': ourDollarsById() short-circuits at team.js:1372 with `if (auction && auction.fair) return auction.fair;`, so once a room is open the finder, the BEST PICK strip and the room all read the SAME map — that guard is precisely what the docstring promises and it holds. The real, smaller failure is confined to the pre-room board: after the user raises the K or DEF stepper, the board repaints but 18 of 182 OURS prices stay $1-$2 high for the 0-K/0-DEF shape until some other keyed field (leagueSize, budget, another roster stepper, a team-budget edit) or an auction start forces a recompute. Severity minor.
- **Proposed fix:** Add `,${draftCfg.k},${draftCfg.def}` to the key template at team.js:1381 (or key on JSON.stringify(rosterShape(draftCfg).starters) so a future slot type cannot be forgotten again).

### `draft-room-modes-reset-leaves-sleeper-roster-plan`

**RESET empties the roster but leaves the Sleeper roster panel saying it filled it**

- **Where:** `app/views/team.js:3445`
- **What the user sees:** Sync a Sleeper roster, confirm FILL MY ROSTER, then tap RESET twice. The roster panel is now empty, but directly below it the setup card still reads "Roster replaced from Sleeper: 9 player(s) seated, 0 removed.", the report header still says "SLEEPER ROSTER · WHAT THIS DID", the SEATED list still names all nine players against the slots they are no longer in, and where the FILL MY ROSTER button used to be there is now only the line "Roster replaced. Sync again to pull a fresh copy." So the app describes a roster that does not exist, and the one button that could put those already-downloaded players back is gone — the manager must run another network sync to undo a RESET.
- **Evidence:** RESET (team.js:3454-3466) touches roster.slots/taken/draft/auction only; it never clears `rosterPlan`, `rosterApplied`, `rosterStatus` or `rosterCross` (declared 1231-1237). rosterPlanHtml() at 2173 renders whenever `rosterPlan` is non-null (2174) and branches on `rosterApplied` first: 2194-2195 `if (rosterApplied) { btn = '<div class="lp-saved">Roster replaced. Sync again to pull a fresh copy.</div>'; }` — the `filledNow === 0` branch at 2196 that would re-offer FILL MY ROSTER is unreachable. The header at 2222 is `${rosterApplied ? 'WHAT THIS DID' : 'WHAT THIS WOULD DO'}`. Precedent that a wholesale roster rewrite is supposed to clear this state: buildRosterPlan() at 2473-2475 and runRosterSync() at 2517-2519 both set `rosterPlan = null; rosterArmed = false; rosterApplied = false;`.
- **Verifier's correction:** Real but overstated as 'the app describes a roster that does not exist'. The panel header ('SLEEPER ROSTER · WHAT THIS DID') and the status line ('Roster replaced from Sleeper: 9 player(s) seated') are past tense — they are a report of a completed sync, not a claim about current roster state, so this is not the R27-class 'app lies about itself' defect. The concrete defect is that RESET never clears rosterApplied, so rosterPlanHtml() is pinned to its post-apply branch (team.js:2194) and the FILL MY ROSTER offer that the now-empty roster qualifies for (2196) can never appear; re-seating the same, already-downloaded players requires a fresh SYNC ROSTER network call. Severity minor. Fix: clear rosterApplied (and rosterStatus) in the RESET block, matching runRosterSync at 2515-2519.
- **Proposed fix:** In the RESET block, clear the applied state so the panel returns to an offer rather than a claim: set `rosterApplied = false; rosterStatus = null;` and re-run buildRosterPlan() (which re-plans against the now-empty roster.slots) — or, if the simpler behaviour is wanted, null out rosterPlan/rosterCross/rosterMissed/rosterStatus as well so the panel disappears entirely.

### `user-stories-auction-dollars-ignore-k-def-steppers`

**Auction "our $" prices are memoized on a key that omits the K and DEF slot counts, so adding a kicker slot re-prices nothing**

- **Where:** `app/views/team.js:1380`
- **Criterion:** docs/roadmap/rel19/USER_STORIES.md R19-E3-S1-AC5 — "auction dollars move with it … fairDollars uses the connected shape"; and the app's own SAVE copy at app/views/team.js:2351 ("league size and roster shape feed replacement level, VOR and beat-the-room draft value straight away")
- **What the user sees:** On the Team page with the draft mode set to auction, change the K or DEF stepper in the ROSTER grid from 0 to 1. The header updates ("9 STARTERS + 6 BENCH · 15 ROUNDS") and the code deliberately calls paintCands()/paintReco() to re-price, but every `$ours` figure in the board's value column, and every OVER/UNDER flag derived from it, stays exactly as it was for the 13-slot shape. Changing any other roster field (TEAMS, BUDGET, QB, RB, WR, TE, FLEX, BENCH) does move them, so the two adjacent steppers behave differently for no visible reason. The prices only correct themselves on a remount.
- **Evidence:** app/views/team.js:1380-1381 builds the memo key as `${draftCfg.leagueSize}|${draftCfg.budget}|${roomMoney}|${draftCfg.qb},${draftCfg.rb},${draftCfg.wr},${draftCfg.te},${draftCfg.flex},${draftCfg.bench}` — `draftCfg.k` and `draftCfg.def` are absent — and :1382 returns the cached map on a key hit. `_ourDollars` has no other invalidation point (`grep -n _ourDollars app/views/team.js` → only :1363, :1364, :1382, :1388, :1390). The steppers do fire the repaint: app/views/team.js:3948 `if (key === 'leagueSize' || key === 'budget' || ROSTER_BOUNDS[key]) { paintCands(); paintReco(); }`, and ROSTER_BOUNDS carries `k` and `def` (app/draft-sim.js:58). The shape genuinely changes the prices — running `fairDollars` over data/adp.json with `{k:0,def:0}` vs `{k:1,def:1}` returns 100/98/86 vs 99/97/85 for the top rows, because `rosterSize` feeds `poolN` and therefore `spread` (app/auction.js:203, :244-247). The stale map is consumed by `valueCell` (app/views/team.js:1459-1461), which renders the $ours-vs-$market cell and the OVER/UNDER chip.
- **Verifier's correction:** Accurate as written; keep it minor. Scope note for the fix: the staleness only bites before a room is opened — ourDollarsById returns auction.fair while an auction is live (app/views/team.js:1372) — and the observable drift on the current board is $1–2 on 18 of 182 rows, enough to flip an OVER/UNDER chip on a borderline row but not to mis-rank the board. Deriving the key from rosterShape(draftCfg).config is the better of the two proposed fixes, since it cannot be forgotten again when a ROSTER_BOUNDS field is added.
- **Proposed fix:** Append `,${draftCfg.k},${draftCfg.def}` to the key template at app/views/team.js:1380-1381 (or derive the key from `JSON.stringify(rosterShape(draftCfg).config)` so a future ROSTER_BOUNDS field cannot be forgotten the same way).

### `app-honesty-text-weekly-feed-ships-next-deploy`

**Team builder error blames a missing feed on a future deploy; the feed shipped and is refreshed daily**

- **Where:** `app/views/team.js:849`
- **What the user sees:** If data/player_weekly.json fails to load, the TEAM tab prints "Weekly data unavailable — the team builder needs the weekly projection feed (data/player_weekly.json), which ships with the next data deploy." The feed is committed and refreshed by the daily cron, so the message points the user at a release that already happened and hides the real cause (a fetch/deploy failure) behind a promise of a future one.
- **Evidence:** app/views/team.js:848-850. data/player_weekly.json exists with 300 players, is listed in scripts/validate_data.py's contract map (line 65) with a dedicated availability check (line 647), and its most recent commit is `0b1cd30 data: daily pipeline refresh`. The message's own preceding comment still calls it an "Older deploy without player_weekly.json" case.
- **Verifier's correction:** Real. Note the trigger is broader than a missing file: the branch also fires when the fetch succeeds but no entry has a gsis_id match, so 'did not load' is the honest wording rather than any claim about a release.
- **Proposed fix:** Say what actually happened: "Weekly data unavailable — data/player_weekly.json did not load. Reload; if it persists the feed is down."

### `app-honesty-text-sleeper-index-kept-for-this-visit`

**Roster-sync copy says the multi-MB Sleeper player list is "kept for this visit"; it is dropped on every navigation away from TEAM**

- **Where:** `app/views/team.js:2261`
- **What the user sees:** The SLEEPER ROSTER card says "the first press also downloads Sleeper's player list (several MB); it is kept for this visit, so a second sync does not download it again." A user syncs, taps PLAYERS, taps back to TEAM and syncs again — the several-MB download runs a second time, on a phone connection, because the cache lives in the mount and the router re-mounts the view on every visit.
- **Evidence:** app/views/team.js:1228 `let sleeperIndex = null;   // buildSleeperPlayerIndex().index, cached for the mount` — declared inside the mount function, so app/main.js:23-33 mountTeam calling `mod.default(el)` on each navigation resets it to null. app/views/team.js:2553 `if (!sleeperIndex) { ... }` then re-fetches. The app's own dynamic status line at :2522-2525 already tells the truth per-mount ("then its player index (several MB — this can ...)"), which is what makes the static "kept for this visit" copy the odd one out.
- **Verifier's correction:** Real, with two qualifications: the browser's HTTP cache may absorb the repeat request depending on Sleeper's response headers, so the guaranteed defect is the false claim rather than a guaranteed second download; and the 'on a phone connection' framing is off — the team page targets 13-inch iPadOS/laptop per the owner's policy.
- **Proposed fix:** Either hoist sleeperIndex to module scope so "this visit" becomes true, or change the copy to "it is kept while this tab stays open".

### `state-persistence-shape-change-no-repaint`

**SAVE LEAGUE SETTINGS changes the persisted roster geometry but never repaints the roster grid, so the page shows a slot layout the saved profile no longer has**

- **Where:** `app/views/team.js:3528`
- **Criterion:** Standing policy 4 (HONEST DATA — "never claim a mechanism exists unless it is actually wired end to end"); the panel's own SAVE status line claims the new starters+bench count is in effect.
- **What the user sees:** On the default profile (7 starters + 6 bench, PPR), set the K stepper to 1 and press SAVE LEAGUE SETTINGS. The status line under the button says "Saved: … 8 starters + 4 bench · 12 rounds", but the roster grid directly above it still draws QB1 RB1 RB2 WR1 WR2 TE1 FLEX BN1..BN6 — there is no K slot to put a kicker in. The same happens shrinking the bench: players sitting in BN5/BN6 stay on screen after the save, then vanish from the grid the moment the user taps ADD or REMOVE on anything (the first call that reaches paintRoster). The page asserts one roster shape in prose and renders a different one.
- **Evidence:** app/views/team.js:3469 `if (act === 'league-save') {` … :3478 `const wrote = saveProfile(next);` :3479 `savedProfile = next;` … and the branch ends at :3527-3530 `leagueStatus = { tone: wrote ? 'ok' : 'warn', lines }; paintDraft(); return;` — paintDraft() only rewrites `#t-draft` (:3329 `const box = el.querySelector('#t-draft');`). The roster grid is painted by :1617 `function paintRoster() { const rows = slotOrder().map((slot) => {` where :1579-1581 `function slotOrder() { return rosterSlots(savedProfile).all; }`, and grep for `paintRoster()|paintAll()` shows no call anywhere between 3465 and 3634, i.e. none in the league-save branch. Verified with node: rosterSlots on the default profile gives QB1,RB1,RB2,WR1,WR2,TE1,FLEX,BN1..BN6 and with a K token gives QB1,RB1,RB2,WR1,WR2,TE1,FLEX,K1,BN1..BN4 — a different list. The re-mount at :3520 `Promise.resolve(mountTeam(el))` only runs when the scoring mode also changed, which a pure shape edit never does.
- **Verifier's correction:** Real, but state the bench-shrink half correctly: players parked in slots the new shape dropped are NOT lost — saveRoster writes the whole slots object including the removed BN5/BN6 keys, and loadRoster's migration sweep (app/views/team.js:185-193) re-seats any id under a slot name the profile no longer has into the first open slot on the next mount. The defect is purely a stale render: the roster grid (and the starters total, finder and reco, which are also only repainted by paintAll) keeps asserting the pre-save geometry until some unrelated action reaches paintRoster.
- **Proposed fix:** In the league-save branch replace the terminal `paintDraft()` with `paintAll()` (or add `paintRoster(); paintSummary(); paintCands(); paintReco();`) so the slot grid, the starters total and the finder are redrawn against the profile that was just written.

### `ipad-layout-a11y-focus-destroyed-by-repaint`

**Every draft-room action rebuilds the section with innerHTML, destroying the control that was just activated — keyboard focus drops to the body on each press**

- **Where:** `app/views/team.js:3817`
- **What the user sees:** On the iPad-with-keyboard / laptop target, the auction room is effectively unusable from the keyboard. Tab to the `+` bid stepper and press Enter: the bid goes 34→35 and focus jumps to the top of the document. To raise a bid from $34 to $47 the user must Tab back through the whole page thirteen times. The same happens on `−`, on the SOLD-price `−`/`+`, on CLEAR HISTORY / TAP AGAIN TO ERASE HISTORY (the second tap is unreachable without re-Tabbing), on the roster-overwrite confirm, and on every TAKE toggle in the finder. A VoiceOver user on the iPad gets thrown back to the start of the page after each action too.
- **Evidence:** The stepper handlers call `paintDraft()` and nothing else (app/views/team.js:3809-3822):
```
if (act === 'auc-bid-minus' || act === 'auc-price-minus') {
  if (act === 'auc-price-minus' && soldTyped != null) { soldTyped -= 1; paintDraft(); return; }
  bidAdj -= 1;
  paintDraft();
  return;
}
```
`paintDraft()` replaces the whole section wholesale (app/views/team.js:3328-3347):
```
function paintDraft() {
  const box = el.querySelector('#t-draft');
  …
  else if (auction) { box.innerHTML = auctionRoomHtml(); _draftSetupPainted = null; }
```
The `−` / `+` / RECORD SALE buttons live inside `auctionRoomHtml()` (app/views/team.js:3190-3200), so the element that received the event is detached and replaced by a fresh one; the browser moves focus to `<body>`.
There is no focus restoration anywhere in the view — `grep -n "\.focus()\|activeElement" app/views/team.js` returns zero hits (the only `.focus()` in the app is `app/main.js:122`, the route-change focus of `#view`).
Same pattern at:
  - app/views/team.js:3873-3884 — `act === 'taken'` → `paintCands()` rebuilds `#t-cands`, destroying the TAKE button just pressed.
  - app/views/team.js:3416-3427 — `hist-clear` arms then `paintDraft()`, so the "TAP AGAIN TO ERASE HISTORY" button (team.js:2778) is a different element than the one the user is focused on.
  - app/views/team.js:3400-3406 — `rosterArmed` → `paintDraft()`, same.
RESET is the one that does it correctly (app/views/team.js:3445-3468): it mutates `t.textContent` / `t.classList` in place and never repaints, so focus survives. That is the pattern the rest should follow.
- **Verifier's correction:** Real, but blocker is far too high and one part of the claim is wrong. The failure is confined to keyboard-only and VoiceOver navigation: a pointer/touch user is unaffected because the replacement button renders at the identical position, and Safari does not focus buttons on click in the first place. The claim that this hits the typed SOLD-price field is wrong — team.js:3963-3967 deliberately returns without repainting (`// no repaint: repainting would blur the field`), and the budget `change` handler at team.js:3988/4004 guards its paintDraft with `if (!draft && !auction)`, so typed fields keep focus. Restate as: activating a stepper/toggle/arm button in the draft room moves keyboard focus to <body>, forcing a full re-Tab per press; severity minor.
- **Proposed fix:** Before each `innerHTML` assignment in `paintDraft()` / `paintCands()`, capture a stable identifier for `document.activeElement` (e.g. its `data-act` plus `data-gsis`/`data-bi`), and after the assignment re-query and `.focus({preventScroll:true})` the matching element. For the steppers specifically, prefer in-place mutation (update `.auc-bidnum`/`.auc-soldprice` value and the BID TO label) instead of a full section rebuild, matching what the RESET handler already does.

### `ipad-layout-a11y-roster-listbox-aria`

**The roster is marked up as a listbox whose options are unfocusable and contain interactive children, so it is announced as a selectable list that cannot be selected from**

- **Where:** `app/views/team.js:1558`
- **What the user sees:** With VoiceOver on the iPad, entering the Team tab's roster announces "Roster slots, list box, 13 items", which sets the expectation that the user can arrow through slots and pick one. Nothing responds to arrow keys and the container is not in the tab order. Every filled slot is announced "not selected" — because only an empty, user-targeted slot ever gets `aria-selected="true"` — so a roster with 9 players reads as 13 unselected options. The remove control is a `role="button"` nested inside a `role="option"`, which is not a valid child of an option, so the remove affordance is announced inconsistently across AT.
- **Evidence:** app/views/team.js:1558 — `'<section class="roster" id="t-roster" role="listbox" aria-label="Roster slots"></section>'`.
app/views/team.js:1666-1671 — the options carry no `tabindex`, and the container has no `tabindex` or `aria-activedescendant`:
```
const sel = selectedSlot === slot && !id;
return (
  `<div class="slot${sel ? ' slot--active' : ''}" role="option" data-slot="${slot}" ` +
    `aria-selected="${sel ? 'true' : 'false'}">` +
```
`sel` requires `!id`, so any slot holding a player is永 `aria-selected="false"`.
app/views/team.js:1657-1663 — a filled slot nests an interactive element inside the option:
```
`<div class="slot-player" role="button" tabindex="0" data-act="remove" data-slot="${slot}" ` +
  `aria-label="Remove ${esc(p.name)} from ${slot}">` +
```
and app/views/team.js:1625-1628 puts a real `<button class="slot-empty" data-act="pick">` inside the option for empty slots — i.e. selection is actually driven by a nested button, not by the option, so the listbox role describes an interaction model the markup does not implement. The only keyboard wiring is the Enter/Space shim for `[data-act][role="button"]` at app/views/team.js:3915-3920, which covers the remove control but nothing about listbox navigation.
- **Proposed fix:** Drop the listbox/option roles and let the native controls speak for themselves: `<section class="roster" id="t-roster" aria-label="Roster slots">` with each slot a plain `<div class="slot">` containing either the existing `<button class="slot-empty">` (use `aria-pressed` for the targeted state instead of `aria-selected`) or a real `<button class="slot-player">` for remove — which also lets the Enter/Space shim at team.js:3915 be deleted.

### `pipeline-contracts-parlay-conformal-claim`

**parlays.schema.json calls confidence_tier a "Conformal-derived confidence band"; it is a hard-coded edge threshold**

- **Where:** `data/contracts/parlays.schema.json:85`
- **What the user sees:** Every parlay card carries a HIGH/MEDIUM/LOW tier that the contract — the document the frontend and any future consumer read to know what the number means — describes as conformal-derived. It is a fixed cutoff on (model_prob - implied_prob) minus 0.01 per extra leg. Nothing was calibrated, so a "high confidence" tier states a coverage guarantee the pipeline never computed.
- **Evidence:** data/contracts/parlays.schema.json:83-86:
  "confidence_tier": { "type": "string", "description": "Conformal-derived confidence band.", "enum": ["high","medium","low"] }
scripts/models/parlay_builder.py:193-203:
    def _confidence_tier(model_prob, implied_prob, n_legs):
        edge = model_prob - implied_prob
        leg_penalty = 0.01 * max(0, n_legs - 2)
        eff = edge - leg_penalty
        if eff >= _TIER_HIGH_EDGE: return "high"
The module's own docstring (parlay_builder.py:30-35) is honest — "a proxy for the harness's split-conformal coverage bands ... Until then it is an honest ordinal, not" a calibrated tier — and scripts/harness/conformal.py is never imported by parlay_builder. Only the contract overclaims.
- **Verifier's correction:** Scope note: no USER-facing surface repeats the claim — app/views/parlays.js:63's legend says only 'TIER confidence: high > medium > low (more legs = lower)', which is accurate. The defect is confined to the contract, which is the honesty document any future consumer reads; that is why it is minor rather than major.
- **Proposed fix:** Change the schema description to match the code: "Ordinal tier from the combined edge minus a per-leg penalty — a documented heuristic, NOT a calibrated split-conformal band (see scripts/harness/conformal.py, not yet wired)." Change it back only when _confidence_tier actually calls the conformal module.

### `qa-coverage-canonical-json-claim-unenforced`

**P5-S6-AC2 (canonical JSON writes) is marked Done against smoke.sh and validate_data.py, neither of which inspects formatting — and 11 of 36 data/*.json already deviate**

- **Where:** `docs/backlog/epics/P5-pipeline-feed-health.md:119`
- **What the user sees:** Nothing breaks on screen, but the AC's purpose — keeping cron commits minimal-diff and race-safe merges clean — is unguarded, so a writer that switches to compact separators or non-ASCII output produces a whole-file diff on the next cron run and turns a data-conflict merge into a manual reconstruction. The gate would report this as fully covered.
- **Evidence:** docs/backlog/epics/P5-pipeline-feed-health.md:111 states the AC ("it uses `ensure_ascii=True`, `indent=2`, `sort_keys=True`, and a trailing newline") and :119 marks "P5-S6-AC2 → `tests/smoke.sh::parses` + `scripts/validate_data.py` … — Done", closing "Coverage: 3/3 = 100%." The smoke step is tests/smoke.sh:60-65: `python3 -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$json"` — a parse, which passes on any valid JSON in any formatting. scripts/validate_data.py performs no byte-level check (`grep -n "sort_keys\|ensure_ascii\|indent\|rstrip" scripts/validate_data.py` returns nothing relevant). Re-serializing each data/*.json with ensure_ascii=True, indent=2 + trailing newline shows 11 of 36 files differ (epa_history, game_context, injury_history, market_baseline, player_usage, player_usage_history, player_usage_weekly, preseason_form, ros_backtest, weather_forecast, …), and zero of 36 match the AC's `sort_keys=True` — which also contradicts CLAUDE.md:136-137, whose convention list omits sort_keys.
- **Verifier's correction:** Correct except one count: with sort_keys=True, 35 of 36 differ, not 36 — data/dvp_positional_history.json happens to match. Everything else holds. The right fix is to drop sort_keys from the AC text (CLAUDE.md:137 is the real convention) and add the byte-level re-serialize check to smoke.sh with an explicit allowlist for the 11 large compact files, or drop the Done marker.
- **Proposed fix:** Decide the real convention (CLAUDE.md's ensure_ascii+indent2+newline, with an explicit allowlist for the large compact files), write it once, then add a stdlib check to smoke.sh that re-serializes each data/*.json and diffs the bytes. Fix the AC text to match, or drop the Done marker.

### `ipad-layout-a11y-tab-role-without-tabs-pattern`

**`role="tab"` / `role="tablist"` are used on the bottom nav and the parlay scope switch without arrow-key navigation, roving tabindex, `aria-controls` or any `role="tabpanel"`**

- **Where:** `index.html:68`
- **What the user sees:** On the iPad with VoiceOver, the bottom navigation announces "Slate, tab, 1 of 6" instead of "Slate, link", and VoiceOver's "move to associated tab panel" gesture does nothing because no element carries `role="tabpanel"` and no tab carries `aria-controls`. With a keyboard, arrow keys do nothing inside either control — the user must Tab through all six nav items one at a time, which is the opposite of what the announced tab role promises. The parlay GAME / WEEK switch behaves the same way.
- **Evidence:** index.html:66-74 — `<nav class="tabbar" role="tablist" aria-label="Sections">` containing six `<a class="tab" href="#/…" role="tab">`; `role="tab"` overrides the implicit link role. `app/main.js:100-106` sets only `aria-selected`; there is no `tabindex` management and no keydown handler for ArrowLeft/ArrowRight anywhere (`grep -n "keydown" app/main.js` returns nothing). index.html:64 `<main class="view" id="view" …>` has no `role="tabpanel"` and no `id` referenced by any `aria-controls`.
app/views/parlays.js:27-37 — the same shape: `<div class="scopeseg" role="tablist" aria-label="Parlay scope">` with `<button … role="tab" aria-selected=… aria-pressed=…>`. The click handler (parlays.js:150-165) updates `aria-selected`/`aria-pressed` but installs no keyboard handler, and both buttons stay in the tab order (no roving tabindex). Carrying both `role="tab"`+`aria-selected` and `aria-pressed` on the same element also gives AT two contradictory state models for one control.
- **Proposed fix:** Simplest correct fix: drop `role="tablist"`/`role="tab"` from index.html:66-74 and let the links be links (keep `aria-current="page"` in place of `aria-selected` — update app/main.js:100-106 accordingly), and drop `role="tablist"`/`role="tab"`/`aria-selected` from app/views/parlays.js:27-37, keeping only `aria-pressed` on the two buttons (the `.scopeseg button[aria-pressed="true"]` selector at theme.css:815 already styles that state). If the tab pattern is wanted, add `role="tabpanel"` + `id` to `#view`, `aria-controls` on each tab, a roving `tabindex`, and Arrow/Home/End key handling.

### `pipeline-contracts-kalshi-zero-rows-reported-ok`

**A market feed that produced zero rows is written as status "ok" and rolls up into overall health "ok"**

- **Where:** `scripts/build_markets.py:167`
- **What the user sees:** The health badge reads "DATA · OK — all feeds ok" while Kalshi has delivered nothing at all. data/pipeline_status.json today: feeds.kalshi = {rows: 0, status: "ok"}, health "ok"; data/market_prices.json has games {} and futures.kalshi []. The MODEL tab's Kalshi column and every game card's Kalshi price are blank, and nothing on screen tells the user why — the one thing the feed-health panel exists to do.
- **Evidence:** scripts/build_markets.py:167-170 sets status unconditionally on success:
    sources["kalshi"] = {"status": "ok", "rows": len(games_k) + len(futures["kalshi"]), "events_seen": len(events), "unmatched": unmatched}
scripts/build_predictions.py:684-693 copies `ok` straight through into feeds["kalshi"], and the roll-up at line 780 takes the worst of the configured statuses — all "ok", so health is "ok". The committed document shows the result: sources.kalshi = {status "ok", rows 0, events_seen 26, unmatched 0}. This is the exact thing the contract forbids in its own words — data/contracts/pipeline_status.schema.json:44: "Row count of the last write; 0 must never be silently ok." — and validate_data.check_pipeline_health (line 484) only compares health against the per-feed statuses, never against rows.
- **Verifier's correction:** The quoted UI string is not what the app renders. app/views/model.js:177-178 emits 'Overall <b>OK</b> · N/M feeds ok', and the topbar chip says only OK/DEGRADED (see the comment at model.js:94). The failure is the same — a feed that delivered zero rows out of 26 seen events is counted among the 'feeds ok' and cannot drag health — but there is no 'DATA · OK — all feeds ok' string in the codebase.
- **Proposed fix:** In build_markets, downgrade a source to "stale" (or "degraded") when rows == 0 while events were seen, and add the rule to validate_data.check_pipeline_health: any feed with rows == 0 and status "ok" is a validation error unless it is on an explicit allowlist (espn_results_2026 before kickoff is the one legitimate case and is already documented at build_predictions.py:112).

### `qa-coverage-honesty-tests-assert-their-own-literals`

**P1-S4-AC2 / P8-S1-AC2 are marked Done against two tests that assert properties of the test file's own fixture literals and never invoke any validator**

- **Where:** `tests/feature/backtest_honesty.test.mjs:68`
- **What the user sees:** These two ACs are the estimate-vs-measured honesty rule — the one the whole platform's credibility rests on ("an estimate is not a measurement"). Two of the tests claimed to enforce it cannot fail under any change to any production code: they iterate a `const HONEST = [...]` array declared 20 lines above and assert that the object literal that was written without a `brier` key has no `brier` key. If scripts/harness/honesty.py::validate were deleted outright, or if the pipeline started attaching a Brier score to an unresolved estimate, these tests stay green and the MODEL page would display a fabricated "measured" accuracy for a game that has not been played.
- **Evidence:** tests/feature/backtest_honesty.test.mjs:68-72 — `test("every estimate row lacks brier and log_loss", () => { for (const row of HONEST.filter((r) => r.estimate)) { assert.ok(!hasScore(row, "brier") && !hasScore(row, "log_loss")); } });` and :74-79 — `test("every measured+resolved row carries brier and log_loss", () => { for (const row of HONEST.filter((r) => !r.estimate && r.resolved)) { assert.ok(hasScore(row, "brier"), …) } });`. `HONEST` is the literal declared at :38-52 inside the same file. Neither test calls `validateRow` (the file's own JS mirror at :21-36), let alone scripts/harness/honesty.py, which `grep -rn "harness.honesty" scripts/ tests/` shows is imported by nothing anywhere in the repo. docs/backlog/epics/P1-evaluation-harness.md:92 and docs/backlog/epics/P8-backtest-honesty.md:28 both mark these "— Done".
- **Verifier's correction:** Overstated as written; narrow it. The ACs' substance IS asserted — by tests/feature/backtest_honesty.test.mjs:81-83 (DISHONEST/bad_measured_unscored → validateRow throws) and :85-93 (committed game_predictions.json). Only ONE AC mapping is misdirected (used twice: P1-evaluation-harness.md:92 and P8-backtest-honesty.md:29 both name the tautological ':74 every measured+resolved row carries brier and log_loss' case); the test at :68 is named by no AC at all. The residual real defect is (a) that mis-named mapping, a special case of the rollup finding, and (b) that scripts/harness/honesty.py — named as the traceability target of both stories — is imported by nothing outside its own package __init__, so the Python enforcer is dead code and the ONLY thing enforcing the rule is a hand-maintained JS mirror. Fix (b) by shelling the HONEST/DISHONEST fixtures at scripts.harness.honesty.validate, and correct the AC→case names.
- **Proposed fix:** Point both tests at the real validator: shell to `python3 -` and assert `scripts.harness.honesty.validate` accepts each HONEST shape and raises on each DISHONEST shape. Additionally run it across every row of data/snapshots/2026_wk01_games_open.json (the one committed lock array, 16 rows) so the rule is enforced on real archived data, which is what P8-S5-AC2 asks for and nothing currently does.


## Refuted

Kept on the record so nobody re-raises them:

- draft-room-modes-valuecell-ungated: Board value cell renders auction dollars in SNAKE mode (seeded S1) - valueCell() at team.js:1459 does read only adpDoc/ourDollarsById/mktValueById, so the factual claim about the code is accurate — but it is not a defect. The OURS/AUC pair is an app-wide valuation conv

- draft-room-modes-bestpick-value-ungated: BEST PICK NOW strip renders the same auction prices and legend in SNAKE mode - bestPickStrip() at team.js:1826-1866 does call valueCell(id) at 1842 and valueLegendHtml() at 1861 with no mode test — verified. But this fails for the same reason as the previous finding: the strip i

- draft-room-modes-finder-legend-baked-into-shell: The auction price legend + MARKET badge are baked into the static shell and can never react to mode - Verified that valueLegendHtml() at team.js:1566 sits inside the one-shot el.innerHTML shell (1543-1573) and that no painter rewrites it — paintCands writes only #t-cands (1703). But a static legend de

- draft-room-modes-reset-leaves-price-memo: RESET clears the room but leaves the memoised OURS price map and its key (seeded S2) - Verified the reset block (team.js:3453-3467) does not touch _ourDollars/_ourDollarsKey. But this is a non-defect on its own: none of the memo's inputs — leagueSize, budget, roomMoney, roster shape — a

- draft-room-modes-reset-leaves-selected-slot: RESET leaves selectedSlot, so the FIT ENGINE keeps aiming at a stale slot - The code reads as described — selectedSlot (team.js:1333) is not cleared in the reset block, paintRoster highlights it at 1667 (`const sel = selectedSlot === slot && !id;`) and paintReco prefers it at

- sleeper-import-carried-kdst-is-applied-overclaim: Carried K/DEF scoring keys are reported as "IS applied" even when no stat line carries them and nothing is applied - The finding quotes only the first clause of the message. app/sleeper.js:1152-1158 emits the FULL sentence, which I captured verbatim from a real run: '"fgm_60p" is worth 6 in your league. It IS applie

- scoring-consistency-draft-sim-ignores-pass-cmp: The AI+ draft room's "your scoring table" valuation cannot see pass_cmp, and its doc comment asserts a limitation that is no longer true - The code reads as described — app/draft-sim.js:260-277 `leagueSeasonPoints` uses only `scoring.rec` and `scoring.bonus_rec_te`, and team.js:3658-3659 passes only pprPointsMap()/receptionsMap() — but t

- pipeline-contracts-pass-attempts-dead-end: pass_attempts is carried into the player record with a comment saying it keeps a check reproducible downstream; there is no downstream reader - The comment does not claim what the finding says it claims. scripts/scrape/espn_players.py:138-148 describes a check that was performed ONCE, by hand, against the 2025 top-40 ('the pairing was checked

- pipeline-contracts-adp-k-dst-comment-stale: scripts/scrape/adp.py drops K/DST rows saying "the sim skips them too" — R27 made the sim draft them - The claimed user-visible failure does not occur. The finding asserts 'the board is silently narrower than the room it is meant to model', but app/views/team.js:1413-1423 roomBoardRows() explicitly con

- qa-coverage-gate-reports-green-while-skipping-all-e2e: tests/run_gate.sh prints "GATE RESULT: PASS (green)" after skipping all 185 Playwright tests whenever @playwright/test is absent - The mechanics are as described — tests/run_gate.sh:66-74 is the else branch, it never sets fail=1, and :81 prints 'GATE RESULT: PASS (green)' before exit 0; my count of `^\s*test(` across tests/web + 

- user-stories-rel17-shipped-but-marked-not-started: Every epic in the Rel17 backlog still reads "🔴 Not started" although Rel17 shipped and is recorded as verified on prod - The facts check out (statuses at docs/roadmap/rel17/USER_STORIES.md:58,261,532,705,843,1041 are all 🔴 Not started; 9fdcc0d 'Rel17: availability overhaul' is on main; scripts/availability.py, scripts/

- user-stories-rel19-e3-shipped-but-marked-not-started: R19-E3 ("my league's shape drives value") is marked Not started, and its rationale states as present fact a defect that was fixed two releases ago - The code claims are accurate — R19 shipped in 6290dc9 ('R18 + R19: … the League Profile'); app/team-logic.js replacementLevel takes a trailing shape and derives the index from positionDemand(shape)/ro

- user-stories-rel19-e4-shipped-but-marked-not-started: R19-E4 (K and DEF) is marked Not started although the K/DST pipeline, feed, contract and roster seating all shipped - Same class as the other two roadmap findings, and same verdict. The shipped state is real (scripts/build_kdst.py, data/kdst_projections.json with its own contract, app/kdst.js consumed at app/views/te

- user-stories-rel19-e1-import-shipped-but-marked-not-started: R19-E1 is marked Not started although the Sleeper league import (fetch tier and paste tier) is fully shipped and wired into the Team page - Third instance of the same roadmap-status finding, refuted on the same grounds. The delivered surface is real and I verified it while judging the tier-3 finding (app/sleeper.js fetchSleeperLeague/slee

- app-honesty-text-draft-room-no-estimate: The running draft/auction room shows model estimates with no ESTIMATE marker, unlike the setup and result panels around it - The absence is real — `grep -n 'class="est"' app/views/team.js` returns 1859, 1880, 1918, 1946, 2058, 2865, 3055, 3303, and neither draftLiveHtml's head (app/views/team.js:3030-3038) nor auctionRoomHt

- state-persistence-scoring-two-writers: nfl2026.scoring.v1 and nfl2026.league.v1 both encode reception scoring and are allowed to diverge, so one TEAM screen states two different rule sets - The code reads as claimed (app/views/players.js:893-901 wires the segment with no profile check; app/render.js:460-469 has no disabled state; app/views/team.js:861 reads loadScoring() and :1545/:1305 

- state-persistence-unlock-not-tied-to-hash: nfl2026.unlock.v1 is a bare '1' with no tie to PASS_HASH, so rotating the password cannot revoke any browser that already unlocked - The code facts are accurate (app/gate.js:15 UNLOCK_KEY, :23 `localStorage.getItem(UNLOCK_KEY) === '1'`, :77 stores the literal '1', PASS_HASH at :18 is never consulted by isUnlocked; grep confirms gat

- ipad-layout-a11y-draftroom-touch-targets: The draft/auction room controls are 26–32 CSS px tall on a touch device — the project's own stated 44px minimum is met almost nowhere on the Team page - The measurements are accurate — I confirmed theme.css:2186 (.auc-mini min-height:26px, which wins over .sort-chip's 32px at theme.css:1979 on source order), theme.css:1976, 1979, 2141, 3503-3508, and 

- ipad-layout-a11y-no-ipad-viewport-in-layout-tests: Every layout/UX Playwright spec runs at 402x874 (iPhone 16 Pro); the only project using an iPad viewport asserts counts, so no test ever renders the iPad-first Team page at its target width - The central factual claim is false. Playwright project defaults are as described (tests/playwright.config.mjs:30-36, 67-75), but specs override the viewport per test and several do render the iPad bre

- ipad-layout-a11y-tabbar-36px: The primary bottom navigation is 36 CSS px tall on a touch device, below the 44px minimum the project states elsewhere - The arithmetic checks out (theme.css:301-314: padding 8px, font-size 13px, body line-height 1.4 at theme.css:76, 2px border-top = 36.2px; and the .wk-chip / .p-expand / .slot-empty / .scopeseg-button 
