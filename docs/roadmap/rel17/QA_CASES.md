# REL17 — QA CASES / TEST STORIES

**Player availability (IR / PUP / NFI / suspension / parsed duration) + preseason form.**

Role: QA lead. Derived from `SOLUTION_DESIGN.md` (authoritative). Where
`ARCHITECTURE.md` / `TECH_DESIGN.md` / `UX_DESIGN.md` disagree with it, this file follows
`SOLUTION_DESIGN.md`.

**173 cases.** Every expected value below was **executed against the real committed tree**
(`data/injuries.json` 800 rows, `data/player_weekly.json`, `data/player_projections.json`,
`scripts/build_weekly.py`) — not read off a doc. Where execution contradicted the design,
the correction is marked **[QA-CORRECTION]** and the measured number is the one to build to.

Gate (exit codes only; `tests/competition.test.mjs` does not exist — do not create it):

```
cd /home/user/nfl2026
python3 scripts/validate_data.py
bash tests/smoke.sh
node --test tests/feature/*.mjs
PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npx playwright test --config tests/playwright.config.mjs
```

Baseline **235 unit / 75 e2e**. Exactly **one** existing assertion is rewritten
(`weekly_contract.test.mjs:83-93`, §11.1) and it is justified there.

---

## 0. QA corrections to the design (executed, reproducible)

| # | Design claim | Measured |
|---|---|---|
| **QA-C1** | `§4.1`: without the status gate "the real feed produces **four** garbage durations". | **41**, not 4. Running the corrected §4.3 rules with the gate removed but all three vetoes on yields **41** extra parses across the 800 rows — overwhelmingly `Active` rows whose blurb describes *a teammate* going on IR. The worst is SF **Demarcus Robinson** (`Active`), whose detail literally reads *"ricky pearsall will miss the entire 2026 season due to a pcl injury…"* — un-gated, Robinson is marked out for the season. The gate is far more load-bearing than the design states. |
| **QA-C2** | `§4.1`: the four named negatives (Lamb, Gardner, Kirk, Ogbah) "are killed by the gate". | They are killed by **both** the gate **and** a veto, independently. Lamb → backward-ref `last year`; Gardner → backward-ref `the following`; Kirk → parenthetical `(knee, ir)`; Ogbah → parenthetical `(hamstring)`. QA therefore tests each of the four **twice**: once through the public entry point, once with `status=None` to prove the veto stands alone. A builder who "simplifies" either layer must fail a test. |
| **QA-C3** | `§9.1` expected Pearsall diff. | **Confirmed exactly**, digit for digit: bye wk8, 17 non-bye, blocked wks 1-4, target `88.6 × 13/17 = 67.75294117…`, `sum(surviving committed pts) = 67.73`, factor `1.0003387151`, rounded new sum `67.73`, `season_points_lost = 20.87`, and the 13 surviving 2dp values are **byte-identical to the committed ones**. Committed non-bye sum today is `88.61`. |
| **QA-C4** | `§4` corpus result. | **Confirmed exactly**: 12 gated parses, 0 false positives; season-class census 14 (10 IR + 1 SUSPENDED + 3 promoted `Out`); nulls = Gyllenborg + Pearsall; 9 week-class players in the top 300 (matches `injury_shape.statuses_used: 9`). |
| **QA-C5** | — | `data/injuries.json` is **not** in `validate_data.SCHEMA_TO_DATA` today. Adding `injuries.schema.json` (BUILD-C) makes `injuries.json` a **newly validated** file — so a schema that does not describe the *existing* `updated_utc` / `source` / `injuries` keys turns the gate red on landing. VAL-08 covers it. |
| **QA-C6** | — | `app/lineup.js:29` rebuilds each candidate as `{ id, pts }` inside `byPos` — `playable` is **discarded at that line**, before any sort. Adding `playable` to the sort key without adding it to that object is a silent no-op that still passes a naive test. APP-16/VW-01 are written to catch exactly this. |

---

## 1. QA stories (fantasy terms, with acceptance criteria)

### S1 — "Don't let me start a guy who's on IR."
> As a manager setting my Week 1 lineup, when a player on my roster is on injured
> reserve, I want the app to refuse to auto-start him and to tell me so on the row, so I
> don't take a zero at WR2 because the optimizer liked his season projection.

**AC1** A roster containing SF Ricky Pearsall (IR) and any healthy WR on the bench never
places Pearsall in `WR1`/`WR2`/`FLEX` in Weeks 1-4. *(APP-12, APP-17, E2E-03)*
**AC2** His lineup row shows `0.0` pts in Weeks 1-4, not `4.65`. *(E2E-02)*
**AC3** His row carries the chip `⊘ IR · 4+ WKS`. *(E2E-01)*
**AC4** From Week 5 the chip is gone and the row shows `4.45`. *(E2E-08)*

### S2 — "If both my RBs are hurt, fill the slot and say so — don't leave it blank."
> As a manager in a shallow league, when every player eligible for a slot is unavailable,
> I want the slot filled by the best of a bad bunch **with a warning**, not silently
> emptied, so I know I have a waiver problem rather than a rendering bug.

**AC1** The slot is filled, never `null`, and `warnings` names the slot, the id and the reason. *(APP-13)*
**AC2** A `.lu-forced` banner renders and the row takes `.lu-row--forced`. *(E2E-04)*
**AC3** The `✓ already optimal` line is **suppressed** whenever `warnings.length > 0` — the app must never claim a lineup containing an unplayable starter is optimal. *(APP-13, E2E-05)*
**AC4** The starter card still renders exactly 7 `.lu-row`s. *(E2E-06)*

### S3 — "A season-ending injury has to cost him points, not just move them around."
> As a manager deciding whether to keep an IR stash, I want a player who will not take a
> snap in 2026 to stop carrying 100% of his season points, so RoS value and my
> start/sit maths are not lying to me.

**AC1** `sum(non-bye pts)` for a season-ending player is **exactly `0.0`**. *(WK-04, VAL-02)*
**AC2** For a partially-blocked player the sum is `proj_points × available/non_bye`, ±0.1 — Pearsall: **67.73** against a season prior of **88.6**. *(CD-02, §11.1)*
**AC3** The reduction is real: `sum < season − 0.1` on every flagged player — a no-op can no longer pass. *(§11.1)*
**AC4** A `Questionable` player's season total is still **preserved to 1e-6**. *(WK-16, and `weekly_injury.test.mjs:69` unmodified)*

### S4 — "Never invent a return date."
> As a manager reading an injury note, I want the app to quote what the report actually
> said or say nothing, so I never trade for a guy because the app guessed "4 weeks" out of
> a sentence that said "6-12 months".

**AC1** Every hedged, ranged, backward-looking or about-a-teammate sentence yields `null`. *(DUR-13..DUR-19, DUR-25..DUR-27)*
**AC2** Zero false positives across all 800 committed rows. *(DUR-20)*
**AC3** A `rule`-confidence figure renders as `4+ WKS` / `LEAGUE MIN` and carries **no** evidence quote. *(APP-09, APP-10, E2E-12)*
**AC4** An `explicit` figure renders the matched sentence verbatim, never paraphrased. *(E2E-16)*
**AC5** A suspension of unknown length blocks **zero** weeks and is flagged only. *(AV-13, APP-06)*

### S5 — "Tell me why PROJ says 88.6 next to an IR badge."
> As a manager on the Compare screen, I want the availability-adjusted number named, so a
> full-season prior beside a `⊘ IR` chip reads as a design decision, not a bug.

**AC1** An `AVAILABILITY` row sits **above** `PROJ PTS` in both columns. *(E2E-10)*
**AC2** An available player renders plain muted `ACTIVE`, no chip. *(E2E-11)*
**AC3** The hint renders: *"PROJ is a full-season healthy prior — RoS VALUE is the availability-adjusted number."* *(E2E-13)*
**AC4** Pearsall's `RoS` reads **67.7** against `PROJ` **88.6**. *(E2E-14 — computed: `round(67.73×10)/10`)*

### S6 — "Preseason hype must not move my draft board."
> As a manager reading August box scores, I want preseason production treated as a
> bounded, labelled, decaying nudge, so a backup's three-TD PRE2 never outranks a starter
> who played one series.

**AC1** `|adj − 1| ≤ 0.03` always. *(PRE-01, PRE-02)*
**AC2** `adj == 1.0` **exactly** at 3 FINAL regular-season team games. *(PRE-05)*
**AC3** At full strength, no top-100 player moves more than ±2 ranks within his position. *(PRE-13)*
**AC4** Weight is `0.0`; `data/player_projections.json` is byte-identical after wiring. *(PRE-14)*
**AC5** The `caveat` string is mandatory in the contract. *(PRE-11)*

### S7 — "If the feed changes its wording, fail loudly — don't call him healthy."
> As the owner of a honest-data product, when ESPN invents a new status spelling I want
> the pipeline to stop, not to silently treat the player as Active.

**AC1** `espn.fetch_injuries()` raises `FeedError` naming the raw value. *(VAL-14)*
**AC2** `tests/smoke.sh` fails if any committed status fails to normalize. *(VAL-09, AV-11)*
**AC3** In the **consumer** (`build_weekly.load_injuries`) `None` means *no shaping and no unavailability* — never `ACTIVE`, never a raise. *(WK-17)*
**AC4** No player may carry an availability badge without a matching source row. *(VAL-04)*

---

## 2. AV — `scripts/availability.py --selftest` (17 cases)

Pure stdlib. Exact input → exact output. **`None` never means ACTIVE.**

| ID | Input | Expected |
|---|---|---|
| **AV-01** | `normalize_status` on the five spellings observed in `data/injuries.json` today: `"Active"`, `"Questionable"`, `"Out"`, `"Injured Reserve"`, `"Suspension"` | `"ACTIVE"`, `"QUESTIONABLE"`, `"OUT"`, `"IR"`, `"SUSPENDED"` |
| **AV-02** | `"Physically Unable to Perform"`, `"Non-Football Injury"`, `"Doubtful"` | `"PUP"`, `"NFI"`, `"DOUBTFUL"` |
| **AV-03** | kona spellings (already lower-cased at `espn_players.py:119`): `"injury_reserve"`, `"day_to_day"`, `"probable"`, `"out"`, `"questionable"`, `"doubtful"`, `"suspension"` | `"IR"`, `"QUESTIONABLE"`, `"ACTIVE"`, `"OUT"`, `"QUESTIONABLE"`, `"DOUBTFUL"`, `"SUSPENDED"` |
| **AV-04** | forward-compat: `"ir"`, `"pup"`, `"nfi"`, `"suspended"` | `"IR"`, `"PUP"`, `"NFI"`, `"SUSPENDED"` |
| **AV-05** | `"  INJURED   reserve "` (mixed case, doubled internal space, padding) | `"IR"` — keys are lower-cased **and** whitespace-collapsed |
| **AV-06** | `"Reserve/Retired"`, `"Day-To-Day"`, `"Probable "`→ handled; but `"Commissioner Exempt"` | `None` for `"Reserve/Retired"` and `"Commissioner Exempt"`. **Assert `result is None`, and explicitly assert `result != "ACTIVE"`** — this is the bug class |
| **AV-07** | `None`, `""`, `"   "` | `None` (no exception) |
| **AV-08** | `WEEK_CLASS`, `SEASON_CLASS` | `frozenset({"QUESTIONABLE","DOUBTFUL","OUT"})`, `frozenset({"IR","PUP","NFI","SUSPENDED"})`; disjoint; `"ACTIVE"` in neither |
| **AV-09** | `CODES` | tuple of exactly 8, in order `ACTIVE, QUESTIONABLE, DOUBTFUL, OUT, IR, PUP, NFI, SUSPENDED`; `len(set(CODES)) == 8` |
| **AV-10** | `INJURY_MULT` (from `build_weekly`) and the derived `INJURY_MULT_CANON` | `INJURY_MULT == {"Out": 0.55, "Doubtful": 0.7, "Questionable": 0.9}` **byte-identical** (never re-keyed); `INJURY_MULT_CANON == {"OUT": 0.55, "DOUBTFUL": 0.7, "QUESTIONABLE": 0.9}`; `"Active"` → `ACTIVE` → `1.0` → dropped |
| **AV-11** | every `status` value in the committed `data/injuries.json` (800 rows) | all normalize; the resulting census is exactly `{ACTIVE: 673, QUESTIONABLE: 65, OUT: 51, IR: 10, SUSPENDED: 1}` (**executed**) |
| **AV-12** | class assignment for a row `{status: "Out", out_for_season: True}` | `class == "season"` — **class is data-driven, not a status lookup.** Also assert the three real promotions: ATL DeAngelo Malone, NO Keeshawn Silver, TB Chase Lucas |
| **AV-13** | `SUSPENDED`, `weeks_out=None`, `out_for_season=False` | `unavailable_weeks == 0`; **no season block emitted**; the player is *flagged only* |
| **AV-14** | `IR` / `PUP` / `NFI`, `weeks_out=None` | `unavailable_weeks == MIN_WEEKS_OUT == 4`, `confidence == "rule"` |
| **AV-15** | duplicate join rows for one player: `[{IR, ofs:False, wo:2}, {IR, ofs:True}]` then `[{OUT, wo:2},{OUT, wo:5}]` | worst wins: `out_for_season True` beats any count; else `weeks_out == 5` |
| **AV-16** | `build_injury_history.shape()` on its three whitelisted statuses | each maps through `normalize_status`; **`data/injury_history.json` output byte-identical** (C7 — the file is 553 KB, its schema pins `enum ["Out","Doubtful","Questionable"]`, and its upstream 403s in the sandbox) |
| **AV-17** | **[GAP-FILL — R17-E1-S1-AC1 "imports with no third-party dependency"]** parse `scripts/availability.py` and `scripts/injury_duration.py` with `ast` and collect the root module of every `Import` / `ImportFrom` node | the collected set is a **subset of** `{re, sys, json, os, math, typing, dataclasses, collections, argparse, pathlib}` — stdlib only. Explicitly assert `"numpy" not in mods`, `"pandas" not in mods`, `"scipy" not in mods`, `"requests" not in mods`. Both modules must also import successfully in a subprocess whose `PYTHONPATH` contains only the repo root. Makes the standing "stdlib-only Python" rule mechanical rather than a review promise |

---

## 3. DUR — `scripts/injury_duration.py --selftest` (31 cases)

`parse_duration(detail, status)` → `{"out_for_season": bool, "weeks_out": int|None,
"confidence": "explicit"|None, "evidence": str|None}` or `None`.

**All strings below are verbatim from the committed `data/injuries.json`.** `evidence` is
the matched sentence after `casefold()` + whitespace-collapse, so the expected values are
lower-case. Every result below was **executed**.

### 3.1 The 12 real positives (DUR-01 … DUR-12)

| ID | Row (team \| player \| status) | Matched sentence (= expected `evidence`) | Expected |
|---|---|---|---|
| **DUR-01** | CAR \| Chris Brazzell II \| `Injured Reserve` | `brazzell will officially miss his entire rookie season due to the lcl tear he suffered during wednesday's training camp practice.` | `{ofs: true, weeks_out: null, confidence: "explicit"}` — **the C4 fix**: `his` + `rookie` sit between quantifier and noun, so `[^.]{0,40}?` / `[^.]{0,30}?` are required |
| **DUR-02** | KC \| Ethan Downs \| `Injured Reserve` | `downs' season is over after he tore his acl during tuesday's practice session.` | `{ofs: true, null, "explicit"}` (R1 `season is over`) |
| **DUR-03** | LV \| Chris Collier \| `Injured Reserve` | `collier will return to the raiders after being waived/injured by the team friday, and he is now set to spend the entirety of the 2026 campaign on ir unless the two sides reach an injury settlement down the road.` | `{ofs: true, null, "explicit"}` — **settlement whitelist required**, else `unless…settlement` reads as a hedge |
| **DUR-04** | LAR \| Eddie Walls III \| `Injured Reserve` | `walls went down with an injury during otas and was carted off the practice field, and now he'll have to sit out the rest of the year unless he works out an injury settlement with the team.` | `{ofs: true, null, "explicit"}` (`sit out … rest of … year`) |
| **DUR-05** | NE \| Jimmy Kibble \| `Injured Reserve` | `the rookie undrafted free agent will now be forced to miss the entirety of the upcoming campaign unless he's waived with an injury settlement.` | `{ofs: true, null, "explicit"}` — **the second C4 miss** (`upcoming` between `entirety of` and `campaign`) |
| **DUR-06** | NE \| Jeremiah Webb \| `Injured Reserve` | `he now will be forced to miss the entirety of the upcoming campaign unless he's waived with an injury settlement.` | `{ofs: true, null, "explicit"}` |
| **DUR-07** | SF \| Mikail Kamara \| `Injured Reserve` | `the undrafted free agent out of indiana will now spend the duration of the 2026 season on ir unless he and the 49ers reach an injury settlement.` | `{ofs: true, null, "explicit"}` (`duration of`) |
| **DUR-08** | TEN \| Sanoussi Kane \| `Injured Reserve` | `now that he's on ir, the 2024 seventh-rounder will be forced to miss the entire 2026 season unless he reaches an injury settlement with tennessee.` | `{ofs: true, null, "explicit"}` — note the sentence contains `2024`; the backward-ref veto must apply to the **numeric rules only**, or this is lost |
| **DUR-09** | ATL \| DeAngelo Malone \| `Out` | `now that he's on the reserve/pup, malone will be required to miss the entire 2026 season unless he reaches an injury settlement with the falcons.` | `{ofs: true, null, "explicit"}` — **promoted `Out` → class `season`** |
| **DUR-10** | NO \| Keeshawn Silver \| `Out` | `regardless, since he went unclaimed off waivers he's landed on ir, which means silver will need to sit out the entire 2026 campaign unless he reaches an injury settlement with new orleans.` | `{ofs: true, null, "explicit"}` — **promoted** |
| **DUR-11** | TB \| Chase Lucas \| `Out` | `the cornerback will now spend the entirety of the 2026 season on injured reserve unless he is waived with an injury settlement.` | `{ofs: true, null, "explicit"}` — **promoted** |
| **DUR-12** | CHI \| Beanie Bishop Jr. \| `Suspension` | `the cornerback is set to miss the first three games of the 2026 regular season for a violation of the nfl's substance abuse policy back in march.` | `{ofs: false, weeks_out: 3, confidence: "explicit"}` — **the only R2 hit in the corpus**; word-number `three` → `3` |

### 3.2 The real negatives and nulls (DUR-13 … DUR-19)

Each is asserted **twice**: (a) through the public call with its real status (gate rejects),
and (b) with `status=None` (veto must reject on its own). **[QA-CORRECTION — QA-C2]**

| ID | Row | Offending sentence fragment | Rejected by | Expected |
|---|---|---|---|---|
| **DUR-13** | DAL \| CeeDee Lamb \| `Active` | `lamb took a step back last year, missing three games overall due to injury…` (R2 would fire on `three`) | gate (`ACTIVE`) **and** backward-ref `last year` (also `overall due to`) | `None` |
| **DUR-14** | IND \| Sauce Gardner \| `Questionable` | `he ended up missing the following three games and four of the last five contests to close out the 2025 regular season.` | gate (`QUESTIONABLE` ∉ SEASON∪OUT) **and** backward-ref `the following` / `to close out` / `2025` | `None` |
| **DUR-15** | SF \| Christian Kirk \| `Questionable` | `with ricky pearsall (knee, ir) out for the season, kirk is a candidate…` (R1 `out for the season` fires) | gate **and** parenthetical-injury veto `(knee, ir)` | `None` — **the sentence is about a teammate** |
| **DUR-16** | KC \| Emmanuel Ogbah \| `Active` | `ashton gillotte (hamstring) has been sidelined for the past two weeks of training camp…` (R3 `two weeks` fires) | gate **and** parenthetical veto `(hamstring)` | `None` |
| **DUR-17** | SF \| Ricky Pearsall \| `Injured Reserve` | `…rehab estimates have been so broad, with one report suggesting "6-12 months" as the timeline for pearsall's return.` | **double** veto: hedge (`report`, `suggesting`, `estimates`) **and** range (`6-12 months`) | `None` — **the canonical null**, and the reason the whole release rides on `MIN_WEEKS_OUT` |
| **DUR-18** | KC \| John Michael Gyllenborg \| `Injured Reserve` | `gyllenborg sprained his knee in late july and will need to miss some time.` | no rule matches (`some time` is not a count) | `None` — falls to the `rule` floor |
| **DUR-19** | SF \| Demarcus Robinson \| `Active` | `ricky pearsall will miss the entire 2026 season due to a pcl injury that requires surgery.` | **gate only** — no veto fires | `None` via the gate; with `status=None` this row **does** parse `{ofs:true}`. This is the single clearest proof the gate is load-bearing |

### 3.3 Corpus-level and synthetic rules (DUR-20 … DUR-30)

| ID | Case | Expected |
|---|---|---|
| **DUR-20** | Run the parser over all 800 committed rows with the gate on | **exactly 12** parses (the DUR-01..12 set, by `(team, player)`), **0** false positives. Executed and confirmed. Failing this is a gate failure, not a tuning opportunity |
| **DUR-21** | Same corpus with the **gate removed** (vetoes on) | **≥ 41** extra parses. Assert `> 12` and assert `("SF","Demarcus Robinson")` is among them. **[QA-CORRECTION — QA-C1: the design says 4; the measured number is 41]** |
| **DUR-22** | `"he will miss the next 0 games"`, `"…the next 25 games"`, `"…18 weeks"` | `None` for each — reject `N < 1` or `N > 17` |
| **DUR-23** | word numbers `one`…`twelve` in R2 form | `weeks_out` = 1…12 respectively; `"thirteen games"` → `None` (not in `<NUM>`) |
| **DUR-24** | `"he will miss the entire 2026 season unless he reaches an injury settlement"` | `{ofs: true}` — the settlement whitelist strips `unless…settlement` **before** the hedge test. Then assert `"he could miss the entire season unless he reaches an injury settlement"` → `None` (a real hedge outside the stripped clause still vetoes) |
| **DUR-25** | one synthetic sentence per hedge token (`could, might, may, possibly, perhaps, likely, unlikely, hopes, hoping, hopeful, targeting, aiming, expects to return, expected to return, reports, reported, reportedly, suggests, estimated, if he, questionable to, no timetable, timetable, unclear, potentially, uncertain, believed, rumored`) wrapped around a would-match R1/R2 clause | `None` for every one |
| **DUR-26** | `"out 4-6 weeks"`, `"out 4 to 6 weeks"`, `"3–5 games"` (en-dash) | `None` for each |
| **DUR-27** | `"He is fine. He will miss the entire season."` and the reverse `"He will miss. The entire season is long."` | first → `{ofs: true}` with `evidence` = **only the second sentence**; second → `None`. Proves `[^.]` cannot cross a period and sentences are evaluated independently, first match wins |
| **DUR-28** | `parse_duration(None, "Injured Reserve")`, `parse_duration("", "IR")`, `parse_duration("   ", "IR")` | `None` (no exception) |
| **DUR-29** | any parse result | **no `returns_wk` key exists** on the return dict, and `grep -r returns_wk scripts/` finds nothing. R4 is **CUT** — a field nothing backs and nothing reads is the shape of F5 |
| **DUR-30** | `evidence` on every positive | always the **matched sentence** (casefolded, whitespace-collapsed), never the whole `detail`, never `None` on a positive. Assert `evidence in normalized_detail` and `len(evidence) < len(detail)` where the detail is multi-sentence |
| **DUR-31** | **[GAP-FILL — R17-E1-S2-AC7, the `week-to-week` / `day-to-day` clause DUR-25's hedge list does not carry]** four synthetic sentences, each wrapping a clause that would otherwise fire R2/R3, with `status="Injured Reserve"` so the gate passes: (a) `"he is considered week-to-week and could miss the next four games."` (b) `"the team is calling him week to week after he will miss three games."` (c) `"he is day-to-day but will miss two weeks."` (d) `"there is no timetable for his return, though he will miss the entire season."` | `None` for **all four**. (a)/(b) prove `week-to-week` and its unhyphenated spelling are hedges; (c) proves `day-to-day`; (d) proves `no timetable` vetoes even an R1 season-ending clause, not just a numeric one. Assert each **twice** (public entry point and `status=None`) per the QA-C2 pattern, so neither the gate nor the veto can be removed alone |

---

## 4. WK — `scripts/build_weekly.py` availability math (22 cases)

Node `--test`, driven through `python3 -` from the repo root — the **exact
`weekly_injury.test.mjs` pattern** (no network, no committed-data churn). New file
`tests/feature/availability.test.mjs` (BUILD-A).

**Shared synthetic world — identical to `weekly_injury.test.mjs`'s `SETUP`** so the two
files are directly comparable: teams `SFX/DAL/GBX`, 6 games, `SFX` bye in week 2, so SFX's
non-bye weeks are **1, 3, 4, 5, 6** (n_total = 5). `season_proj = 200.0`,
`ELOS = {SFX: 1580, DAL: 1470, GBX: 1500}`.

**Baseline unrounded split (executed, `round_dp=None`, no injury):**

```
wk1 41.178297  wk3 39.563462  wk4 39.820771  wk5 38.259172  wk6 41.178297   (sum 200.0)
rounded 2dp:   41.18 · 39.56 · 39.82 · 38.26 · 41.18
```

| ID | Call | Expected (executed) |
|---|---|---|
| **WK-01** | `player_weeks(200.0,"SFX",sched,ELOS)` vs `player_weeks(..., unavailable_weeks=0)` | **numerically identical, path for path**, at both `round_dp=2` and `round_dp=None`. `deepEqual` on the full 18-row list. No `avail` key on any row |
| **WK-02** | `unavailable_weeks=1` | blocked `[1]`; target `200×4/5 = 160.0`; sum `160.0` ±1e-6; rounded rows `wk1 0.0, wk3 39.86, wk4 40.12, wk5 38.54, wk6 41.48`; `avail:false` on wk1 only |
| **WK-03** | `unavailable_weeks=2` | blocked `[1,3]`; target `120.0`; sum `120.0` ±1e-6; rounded `wk1 0.0, wk3 0.0, wk4 40.07, wk5 38.50, wk6 41.43` |
| **WK-04** | `unavailable_weeks=5` (out for season) | every non-bye row `pts == 0.0` **exactly**; `sum == 0.0`; target `0.0`; `avail:false` on all five |
| **WK-05** | `unavailable_weeks=1, injury_mult=0.55` — **the step-4 discriminator** | blocked `[1]`; shaping hits the first 3 of *available* = wk **3,4,5**, **not** wk1. Expected `wk1 0.0, wk3 32.88, wk4 33.10, wk5 31.80, wk6 62.23`, sum `160.0`. A build that shapes `raw[:3]` then zeros produces `wk3 28.28, wk4 28.47, wk5 49.73, wk6 53.52` — **assert against the correct set, and assert `wk6 < 50`** so the wrong-window bug cannot pass |
| **WK-06** | `unavailable_weeks=2, injury_mult=0.55` | **identical to WK-03** (`40.07 / 38.50 / 41.43`). With exactly 3 available weeks the `INJURY_WEEKS=3` window covers all of them, so a uniform multiplier cancels in the renormalization. Locks that the ding is never "spent" on weeks the player cannot play |
| **WK-07** | `unavailable_weeks=2, first_week=4` | blocked = first 2 non-bye rows with `wk >= 4` = `[4,5]`; wk1/wk3/wk6 survive; target `120.0` |
| **WK-08** | any blocked case | the rescale factor is computed over the **available** sum only. Assert `factor == target / sum(available raw)`, and that adding a blocked week's raw pts into the denominator would change the answer (i.e. the factor is not `target / sum(all raw)`) |
| **WK-09** | a team with zero scheduled games (`n_total == 0`) | target `0.0`, no `ZeroDivisionError`, all 18 rows `pts 0.0, bye true` |
| **WK-10** | week rows of a blocked player | a bye row is `{bye: true, pts: 0.0, opp: null}` with **no `avail` key**; a blocked row is `{bye: false, pts: 0.0, opp: "<TEAM>", avail: false}`. `opp` must stay non-null on blocked weeks |
| **WK-11** | `avail` key emission | present **only** on blocked rows and **only** with value `false`. `avail` never appears on an available or bye row (this is what keeps the committed diff off 5 400 booleans) |
| **WK-12** | `build_weekly_document` with 0 season-class players | `"availability" not in doc["model"]`; with ≥1 → the full 6-key block |
| **WK-13** | `injuries=[]`, `injuries_path="/nonexistent"`, all-`Active` report | all three produce a **byte-identical** document (`json.dumps(..., ensure_ascii=True, indent=2, sort_keys=False)` equality), no `availability` key anywhere. Mirrors and extends `weekly_injury.test.mjs:122` |
| **WK-14** | `season_points_lost` for the WK-02 case | `200.0 − 160.0 = 40.0`; general rule `season_proj − sum(new non-bye pts)`, rounded 2dp |
| **WK-15** | `model.availability.season_points_removed` with 2 season-class players | `== Σ players[].availability.season_points_lost` ±0.05 |
| **WK-16** | week-class only (`status "Questionable"`, `unavailable_weeks=0`) | season total preserved to **1e-6**; **no** `availability.weeks_out` / `out_for_season` / `confidence` / `evidence` / `season_points_lost` keys — class `week` carries exactly 2 keys `{status, class}` |
| **WK-17** | an injuries row with an **unmapped** status (`"Commissioner Exempt"`) reaching `load_injuries`/`injury_multipliers`/`unavailability` | **no shaping and no unavailability**, no raise, document byte-identical to the empty case. `None` is *not* `ACTIVE` and *not* an error here (loudness lives at the scraper and at the gate) |
| **WK-18** | `scripts/build_weekly.py` module docstring (`:20-28`) | no longer contains the string *"injuries shift shape, never total"* (false for class `season`); and `model.notes` no longer claims non-bye weeks sum *exactly* to the season projection without qualification |

#### [GAP-FILL] WORLD-18 — the real-league-shaped fixture (WK-19 … WK-22)

WK-01…WK-18 all run in the 6-game world, which cannot express the four **mandated fantasy
scenarios** (IR mid-season, PUP return, suspension, the live 3-game suspension) at their
real shape. WK-19…WK-22 add one more shared synthetic world and nothing else:

**WORLD-18** — one team `SFX`, an 18-week schedule, **bye in week 9**, therefore
**17 non-bye weeks** (`1..8, 10..18`). `season_proj = 200.0`. Same `ELOS` spread as the
6-game world so opponent strength still varies week to week. Every expected number below is
arithmetic on `TARGET = season_proj × len(available) / n_total` and is exact by
construction — no per-week value is asserted, because per-week values depend on the ELO
split and asserting them would be fabricating precision.

| ID | Call | Expected |
|---|---|---|
| **WK-19** | **[R17-E2-S1-AC1 — "my RB2 lands on IR in week 3"]** WORLD-18, `player_weeks(200.0, "SFX", sched, ELOS, unavailable_weeks=4, first_week=3)` | blocked = the first 4 non-bye rows with `wk >= 3` = **weeks 3, 4, 5, 6**, each `pts == 0.0` **exactly** with `avail: false`. Weeks **1 and 2 keep non-zero points** (`pts > 0`) — `first_week` must not retro-block. `len(available) == 13`, `n_total == 17`, target `200.0 × 13/17 = 152.94` (unrounded `152.941176…`), non-bye sum `152.94 ± 0.1`. **Anti-no-op:** assert `sum < 200.0 − 0.1` — the ~47.06-point drop is the whole of F2. Week 9 stays `{bye: true, pts: 0.0, opp: null}` with **no `avail` key** |
| **WK-20** | **[R17-E2-S2-AC1 — "a WR is on PUP to start the season and returns week 7"]** WORLD-18, status `PUP`, parsed `weeks_out: 6` → `unavailable_weeks=6, first_week=1` | blocked = **weeks 1–6**, each `pts == 0.0` with `avail: false`. **Week 7 is the return week**: `pts > 0` and **no `avail` key** (absent, not `true` — WK-11). `len(available) == 11`, target `200.0 × 11/17 = 129.41`, non-bye sum `129.41 ± 0.1`, `sum < 200.0 − 0.1`. `season_points_lost == round(200.0 − 129.41, 2) == 70.59` |
| **WK-21** | **[R17-E2-S3-AC1 — "a suspended player misses 6 games"]** WORLD-18, status `SUSPENDED`, parsed `weeks_out: 6` → `unavailable_weeks=6, first_week=1` | **numerically identical to WK-20** — `deepEqual` the two week lists. Suspension and PUP share one mechanic; only `availability.status` differs (`"SUSPENDED"` vs `"PUP"`) and both carry `class: "season"`. `season_points_lost == 70.59` is **emitted on the player block**. Contrast with **AV-13**: this case has a parsed duration, so it blocks; AV-13 has none, so it blocks nothing |
| **WK-22** | **[R17-E2-S3-AC2 — the live Bishop row, end to end]** WORLD-18 seeded with CHI Beanie Bishop Jr.'s real parse (`weeks_out: 3, out_for_season: false, confidence: "explicit"`, evidence = the DUR-12 sentence) → `unavailable_weeks=3, first_week=1` | blocked = **weeks 1, 2, 3** (`pts == 0.0`, `avail: false`); **week 4 onward is normal** — `weeks[3].pts > 0` with **no `avail` key**, which is what makes a Week-4 lineup start him with no chip. `len(available) == 14`, target `200.0 × 14/17 = 164.71`, sum `164.71 ± 0.1`, `season_points_lost == 35.29`. `confidence == "explicit"` and `evidence` is non-null on the player block — the one place in the release where a parsed duration, not the `MIN_WEEKS_OUT` floor, drives the block. **Fixture-level, not UI** (C6: Bishop is outside the top 300) |

---

## 5. CD — committed-data contract, real files (7 cases)

Runs against `data/*.json` like `real_data.test.mjs`. Owner: BUILD-A. **All values executed.**

| ID | Assertion | Expected |
|---|---|---|
| **CD-01** | count of `players[]` with `availability.class === "season"` in `data/player_weekly.json` | **exactly 1** — `espn-4428209`. (Not 11. **[QA-C4]**) |
| **CD-02** | Pearsall's 18 week rows | `wk1-4` → `pts 0.0` + `avail:false` (opp/home/bye untouched, `bye:false`); `wk8` → bye, `pts 0.0`, **no `avail` key**; `wk5,6,7,9..18` → `4.45, 5.63, 5.16, 5.98, 5.33, 5.19, 4.63, 5.41, 4.84, 4.97, 5.32, 5.22, 5.60`. Non-bye sum `67.73`. (Committed values today: `4.65, 5.55, 5.83, 4.85` on wk1-4 and non-bye sum `88.61`.) |
| **CD-03** | Pearsall's `availability` block | `{status:"IR", class:"season", weeks_out:4, out_for_season:false, confidence:"rule", evidence:null, season_points_lost:20.87}`. **`evidence` MUST be `null`** — his detail is the double-vetoed `"6-12 months"` row |
| **CD-04** | `model.availability` | `{applied:true, vocab_version:1, unavailable:1, season_ending:0, min_weeks_rule:4, season_points_removed:20.87}`; `model.injury_shape` unchanged at `{applied:true, statuses_used:9}` |
| **CD-05** | week-class blocks | exactly **9** players carry `availability.class === "week"`, each a 2-key `{status, class}`. Exact ids/statuses: `espn-3139477` Mahomes `QUESTIONABLE`, `espn-4360078` Alec Pierce `OUT`, `espn-4426385` Charbonnet `OUT`, `espn-3040151` Kittle `OUT`, `espn-4360423` Penix `QUESTIONABLE`, `espn-4572680` Kraft `QUESTIONABLE`, `espn-4683062` Worthy `QUESTIONABLE`, `espn-4595348` Nabers `QUESTIONABLE`, `espn-4241476` Shavers `OUT` |
| **CD-06** | diff scope | for all 299 non-Pearsall players, `weeks[].pts` are **unchanged** from the pre-release file (compare against `git show HEAD:data/player_weekly.json`). `git diff --stat data/player_weekly.json` shows only the Pearsall hunk + 9 two-key blocks + `model.availability` |
| **CD-07** | `data/injuries.json` after enrichment | `updated_utc`/`source`/`injuries` preserved; `vocab_version: 1`; `counts == {ACTIVE:673, QUESTIONABLE:65, OUT:51, IR:10, SUSPENDED:1}`; **every row's `status` and `detail` byte-identical to HEAD**; the 12 DUR positives carry `confidence:"explicit"` + non-null `evidence`; the other 788 carry `confidence:null`, `evidence:null`, `weeks_out:null`; `ensure_ascii=True` preserved (`grep -P '[^\x00-\x7F]' data/injuries.json` finds nothing) |

---

## 6. APP — `app/availability.js` + `app/lineup.js` (24 cases)

`tests/feature/availability_app.test.mjs` (new, BUILD-B). Pure ES modules, no DOM.

| ID | Case | Expected |
|---|---|---|
| **APP-01** | `availabilityOf(rowWithNoAvailability, 1, 1)` | `{playable: true, label: '', tone: '', durText: '', provText: '', status: null}` — a card rendered without availability is **byte-identical to today** |
| **APP-02** | row with `weeks[0].avail === false`, `wk=1` | `playable === false`. Same row at `wk=5` (no `avail`) → `playable === true` |
| **APP-03** | `status:'OUT'`, no `avail` flags, `wk === currentWk === 3` | `playable === false` — an OUT designation is this-week news |
| **APP-04** | same row, `wk = 4`, `currentWk = 3` | `playable === true` — OUT does not block future weeks |
| **APP-05** | `QUESTIONABLE` / `DOUBTFUL` | `playable === true`, `tone === 'watch'`, `label 'Q'` / `'D'` |
| **APP-06** | `SUSPENDED` with `weeks_out: null` | `playable === true` (unknown length blocks nothing), `tone === 'out'`, `label 'SUSP'`, `durText === ''` |
| **APP-07** | `label` for all 8 codes | `ACTIVE→''`, `QUESTIONABLE→'Q'`, `DOUBTFUL→'D'`, `OUT→'OUT'`, `IR→'IR'`, `PUP→'PUP'`, `NFI→'NFI'`, `SUSPENDED→'SUSP'` |
| **APP-08** | `tone` for all 8 | `'out'` for `{OUT,IR,PUP,NFI,SUSPENDED}`, `'watch'` for `{QUESTIONABLE,DOUBTFUL}`, `''` for `ACTIVE` |
| **APP-09** | `durText` | `out_for_season:true` → `'· SEASON'`; `{weeks_out:3, confidence:'explicit'}` → `'· 3 WKS'`; `{weeks_out:4, confidence:'rule'}` → `'· 4+ WKS'` (**the `+` is load-bearing**); `weeks_out:null` → `''`. `SEASON` beats a number when both are present |
| **APP-10** | `provText` | `'REPORT'` (explicit) / `'LEAGUE MIN'` (rule) / `''` (none) |
| **APP-11** | `AVAIL_CODES` | frozen, 8 entries, order matches `availability.py CODES`; `Object.isFrozen` true |
| **APP-12** | `bestLineup` demotion — WR pool `[{wrHurt, 24.0, playable:false}, {wrOk, 4.0}]`, one WR slot open | `WR1 === 'wrOk'`. **An available 4.0 beats an unavailable 24.0.** `warnings` empty |
| **APP-13** | forced start — only two RBs, both `playable:false` (12.0 and 9.0) | `RB1 === 'rbA'` (12.0), `RB2 === 'rbB'`, **neither slot null**; `warnings` contains `{slot:'RB1', id:'rbA', reason:<non-empty>}` and the same for `RB2`; `warnings.length === 2` |
| **APP-14** | FLEX scan on the tuple — leftovers: unavailable RB 12.4, available WR 4.0 | `slots.FLEX === 'wr'` (4.0). Locks that the FLEX loop compares `(playable, -pts, id)` and not `pts` alone |
| **APP-15** | return shape | `slots` (7 keys), `bench`, `total` unchanged in shape and value for a fully-available roster; `warnings` is a **new, always-present array** (`[]` when clean) — additive, so `lineup.test.mjs`'s `slots`/`bench`/`total` assertions are untouched |
| **APP-16** | strict `=== false` | rows with `playable` **undefined**, `true`, `null`, `0`, `''` all behave **exactly as today** (only literal `false` demotes). Run all five `lineup.test.mjs` fixtures through and `deepEqual` against the pre-release results |
| **APP-17** | `startSitSwaps` — manager benches `wrOk` (4.0, available) and starts `wrHurt` (24.0, `playable:false`) | `moves.start` includes `'wrOk'`; `moves.sit` includes `'wrHurt'`; **`moves.start` contains no id whose `playable === false`.** *This is the literal F3 defect and gets its own named assertion* |
| **APP-18** | `netGain` in APP-17 | computed against the **demoted** optimal lineup (`4.0 − 24.0 = −20.0`), i.e. going "optimal" can show a negative point delta while being the correct start/sit call. Assert the number, and assert `optimal.warnings` is reachable from the returned `optimal` |
| **APP-19** | `__selftest()` | still returns `true`; its `total` is still `98` and its `netGain` still `12` |
| **APP-20** | **[GAP-FILL — R17-E3-S3-AC3 + R17-E2-S5-AC2/AC5: the `phrase` function had no case at all]** `phrase(avail)` for every code × provenance branch | verbatim, never the raw enum: `IR` + `out_for_season` → `'is on IR for the season'`; `IR` + `{weeks_out:4, confidence:'rule'}` → `'is on IR, out at least 4 more weeks'` (**`at least` is load-bearing — a `rule` figure may never render as a bare count**); `IR` + `{weeks_out:3, confidence:'explicit'}` → `'is on IR, out 3 more weeks'` (**no `at least`**); `IR` + `weeks_out:null` → `'is on IR'`; `PUP` → `'is on the PUP list'`; `NFI` → `'is on the NFI list'`; `SUSPENDED` + null → `'is suspended'`; `SUSPENDED` + `{weeks_out:6}` → `'is suspended for 6 more weeks'`; `OUT` → `'is ruled out this week'`; `ACTIVE`/absent → `''`. Assert **no returned string contains a raw code token** for the non-`IR`/`PUP`/`NFI` codes — the regex `/\b(SUSPENDED\|QUESTIONABLE\|DOUBTFUL\|ACTIVE)\b/` never matches a returned phrase — and that the `rule`/`explicit` split is carried **in the prose**, so the sentence stays honest when a narrow phone has hidden the `provText` tag |
| **APP-21** | **[GAP-FILL — R17-E3-S3-AC2: the swap-note template had no case]** the template `` `${OUT_NAME} is ${phrase} — ${IN_NAME} starts at ${SLOT} instead.` `` rendered for the live Pearsall swap | exactly *"Ricky Pearsall is on IR, out at least 4 more weeks — Jauan Jennings starts at WR2 instead."* Assert the **em dash** (`—`, U+2014, not `-`), the terminal period, and that the string contains neither `'IR ·'` nor `'4+ WKS'` (chip vocabulary must not leak into prose). One swap-note per swap |
| **APP-22** | **[GAP-FILL — R17-E3-S3-AC4: chip accessibility had no case]** the markup returned by `renderAvailChip(avail)` for `IR + out_for_season` and for `OUT` | meaning survives with colour removed: the text content contains **both** the glyph `⊘` **and** the words `IR` and `SEASON` (`'⊘ IR · SEASON'`), so tone is never the only carrier. Every glyph element carries `aria-hidden="true"`; every abbreviation carries a spelled-out `title` — `IR` → `title="Injured Reserve"`, `PUP` → `"Physically Unable to Perform"`, `NFI` → `"Non-Football Injury"`, `SUSP` → `"Suspended"`, `Q` → `"Questionable"`, `D` → `"Doubtful"`. Assert `title=` count `>= 1` per chip and that no chip is glyph-only |
| **APP-23** | **[GAP-FILL — R17-E3-S3-AC5: the one-component rule had no case]** `readFileSync('app/theme.css')` and the chip markup | the chip classes are the **shared** family — `.av-chip`, `.av-chip--out`, `.av-chip--watch`, `.av-chip--sm`, `.av-glyph`, `.av-dur`, `.av-prov`, `.av-prov--report`, `.av-prov--min` all present. **Assert `.lu-avail` and `.lu-unavail` do NOT appear anywhere in `app/`** (`grep -c` === 0) — a Lineup-private chip class is the drift this release exists to remove, and Compare must reuse the identical component. Also assert **no new CSS custom property, `@font-face` or `@media` breakpoint** is introduced by the diff |
| **APP-24** | **[GAP-FILL — R17-E2-S2-AC2/AC5: the PUP *return* had no case]** the WK-20 player's row at `wk=7`, `currentWk=7`, through `availabilityOf` | `{playable: true, label: '', tone: '', durText: '', provText: ''}` — **byte-identical to APP-01's no-availability shape**: the return is automatic, with no manual clearing step, and the optimizer must treat him as any healthy player (feed the same row through `bestLineup` and assert he is startable). The same row at `wk=1` → `playable: false`, `label: 'PUP'`. Assert `NFI` at `wk=1` → `label: 'NFI'` on an otherwise identical row (**distinct labels, identical mechanic**). PUP/NFI are **fixture-only** — no feed emits them today (C6) and this case must not claim a live row |

---

## 7. VW — view-wiring source guards (7 cases)

Cheap `readFileSync` source assertions in the `ros.test.mjs:88` style. They catch the three
silent-drop bugs the design names, which no DOM test can see.

| ID | Guard | Expected |
|---|---|---|
| **VW-01** | `app/views/lineup.js` | the object literals passed to **`bestLineup`** *and* to **`startSitSwaps`** both contain `playable`. Assert `2` occurrences of `playable:` inside `paint()`. **[QA-C6: `app/lineup.js:29` rebuilds candidates as `{id, pts}`, so a one-sided wiring is a silent no-op]** |
| **VW-02** | `app/views/lineup.js` `playerRow` | `pts` is zeroed on unavailability, mirroring the bye line: source contains `(onBye || a.playable === false) ? 0 :`. Display and card total can never disagree |
| **VW-03** | `app/views/lineup.js` | the "already optimal" replacement element carries **`class="lu-optimal lu-gap"`** — assert the literal string. Dropping `lu-optimal` breaks `web.spec.mjs:1238` with no obvious connection to the change |
| **VW-04** | `app/views/compare.js` + `app/data.js` | compare does **not** import or call `getInjuries`; `app/data.js` gains **no** new getter and no new cache entry; `grep -c "injuries" app/data.js === 0`. (C3 — one client carrier for one fact) |
| **VW-05** | **[GAP-FILL — R17-E4-S3-AC5: the descope was stated but never asserted]** `app/views/players.js` and `app/views/team.js` | **neither** file imports `app/availability.js`, calls `availabilityOf`, or contains the strings `av-chip` / `renderAvailChip` / any availability legend text — `grep -c` === 0 on each. The descope is a *deliberate* Rel17 boundary (a chip with no availability-adjusted number beside it is half a fix); without this guard a build agent "helpfully" adding the chip ships the half-fix and no test objects |
| **VW-06** | **[GAP-FILL — R17-E5-S1-AC3: pipeline isolation was asserted only for `OPTIONAL_DATA`]** `scripts/build_predictions.py` | contains **no** `build_preseason` import, call or guarded `try` block — `grep -c "build_preseason" scripts/build_predictions.py === 0`. `build_preseason.py` is a standalone runner-built builder in the `build_injury_history` / `build_player_usage` mould. This is also what keeps `build_predictions.py` single-owner and the A/B/D partition genuinely disjoint — a violation is a merge collision as well as a design defect |
| **VW-07** | **[GAP-FILL — R17-E5-S1-AC4: "names settled" had no assertion]** artefact naming across the tree | `data/preseason_form.json`, `data/contracts/preseason_form.schema.json` and registry signal `preseason_form` all exist and match the `SCHEMA_TO_DATA` convention (`<name>.json` ↔ `<name>.schema.json`). Assert the rejected name is absent: `grep -rc "preseason_signal" scripts/ data/ app/ tests/ === 0` |

---

## 8. E2E — Playwright, `tests/web/web.spec.mjs` (19 cases)

**APPEND only — do not modify an existing assertion.**

**Seeding note (mandatory).** The existing `seedRoster()` picks the top 1 QB / 4 RB / 4 WR /
2 TE by projection order. Pearsall is **rank 192** — he is *not* in that set, so the
existing tests are unaffected **and** the new tests must seed him explicitly. Use a
dedicated `seedRosterWithIR()` that forces `WR2: 'espn-4428209'` (or benches him at `BN1`)
alongside the default picks. `currentWk` derives from `game_predictions.week` clamped to
1..18 (`app/views/lineup.js:59-63`); the week bar is how a test reaches Week 5.

| ID | Case | Expected |
|---|---|---|
| **E2E-01** | Lineup, Week 1, roster containing Pearsall | his row carries `.av-chip.av-chip--out` whose text contains `IR` and `4+ WKS`; `.av-glyph` renders `⊘` |
| **E2E-02** | same row's `.lu-pts` | `0.0` — **not** `4.7`/`4.65` |
| **E2E-03** | Pearsall + a healthy WR on the bench | Pearsall is **not** in any `.lu-row` of the starter card; the healthy WR is. (S1/F3) |
| **E2E-04** | roster whose only two WRs are both unavailable | both WR slots filled; a `.lu-forced` banner renders; the affected rows carry `.lu-row--forced` |
| **E2E-05** | same roster | `.lu-optimal` text does **not** contain `already optimal`; the app never claims an unplayable lineup is optimal |
| **E2E-06** | E2E-04 roster, starter card | `.lu-card >> .lu-row` count is still **exactly 7** (`web.spec.mjs:1234` invariant holds under demotion). Neither `.lu-forced` nor `.lu-swapnote` is a `.lu-row` |
| **E2E-07** | E2E-04 roster | `.lu-move, .lu-optimal` count `>= 1` (`web.spec.mjs:1238` invariant) |
| **E2E-08** | switch the week bar to **Week 5** | Pearsall's chip is gone; `.lu-pts` reads `4.5` (from `4.45`) |
| **E2E-09** | Week 8 (Pearsall's bye) | the row shows `BYE` (`.lu-bye`), **not** an IR chip — `bye:true,pts:0` and `avail:false,pts:0` must stay visually distinguishable |
| **E2E-10** | Compare `#/compare?a=espn-4428209&b=<healthy WR>` | an `AVAILABILITY` metric row renders in **both** columns and sits **above** `PROJ PTS` (assert DOM order); the centre rail stays row-aligned |
| **E2E-11** | same view | column A shows `.av-chip--out` with `IR`; column B shows plain muted text `ACTIVE` with **no** `.av-chip` |
| **E2E-12** | same view | `.cmp-evid` count is **0** — Pearsall is `confidence:"rule"`; a league-minimum floor has no report to quote |
| **E2E-13** | same view | `.cmp-hint` contains `PROJ is a full-season healthy prior` and `RoS VALUE is the availability-adjusted number` |
| **E2E-14** | same view | `PROJ` reads `88.6`; `RoS` reads **`67.7`** (executed: `round(67.73 × 10)/10`). Pre-release RoS is `88.6` |
| **E2E-15** | the two existing Compare tests | `.cmp-col .cmp-id` count still `2`; `.cmp-edge` count still `>= 4` (the new availability edge chip can only raise it) — both **unmodified** |
| **E2E-16** | **fixture-only**: inject a `player_weekly.json` route stub giving a rostered player `{confidence:"explicit", evidence:"the cornerback is set to miss the first three games of the 2026 regular season…", weeks_out:3}` | `.cmp-evid` renders the sentence verbatim (quoted, clamped to 3 lines), `.av-prov--report` reads `REPORT`, `durText` reads `· 3 WKS`. **[No live row today — the design's R1/R3/R4 reproductions (Brazzell, Bishop, forced-start) are NOT reachable in the app; do not chase a screenshot]** |
| **E2E-17** | **[GAP-FILL — R17-E3-S3-AC1: the swap-note had no e2e case]** Lineup, Week 1, `seedRosterWithIR()` (Pearsall starting at `WR2`, a healthy WR on the bench) → START / SIT MOVES card | at least one `.lu-swapnote` renders, and its DOM position is **above** the net-gain line — assert with `compareDocumentPosition` (or index within the card's children) that every `.lu-swapnote` precedes the net-gain element, not merely that both exist. Its text matches APP-21's template and contains `is on IR, out at least 4 more weeks`. **Reason before points** is the whole story: a swap-note rendered below the net gain fails this case |
| **E2E-18** | **[GAP-FILL — R17-E3-S2-AC5: only the *forced* half of the row-styling AC was covered]** the E2E-04 roster, plus one unavailable player left on the **bench** | the bench row carries `.lu-row--unavail` and its computed `opacity` is `0.72`; the **forced starter** row carries `.lu-row--forced` and its computed `opacity` is **`1`** (it must *not* recede) with a 3 px `--accent` left border. Assert the two classes are never both on one row. A merely-unavailable bench player is information; a forced start is a problem — they may not look the same |
| **E2E-19** | **[GAP-FILL — R17-E4-S1-AC3: the centre edge chip was not asserted]** Compare `#/compare?a=espn-4428209&b=<healthy WR>` | the centre rail renders an availability `.cmp-edge` chip on the `AVAILABILITY` row, aligned with it (same row offset in both columns), and it favours the **healthy** player. `.cmp-edge` total count is `>= 5` — strictly greater than the `>= 4` that E2E-15 locks — proving the new edge chip is actually emitted rather than the old count merely surviving. Column A's chip is the identical shared `.av-chip` element used on Lineup (assert the same class list as E2E-01's chip) |

---

## 9. VAL — `validate_data.py`, schemas, `smoke.sh` (14 cases)

| ID | Case | Expected |
|---|---|---|
| **VAL-01** | `check_weekly_availability` rule 1 | for **every** player, `sum(non-bye pts) == proj_points × available_non_bye / total_non_bye` ±0.1. Pearsall: `88.6 × 13/17 = 67.75` vs actual `67.73` ✓ |
| **VAL-02** | rule 2 | `out_for_season:true` ⇒ every non-bye `pts` is **exactly `0.0`** (not `0.001`) |
| **VAL-03** | rule 3 | `count(non-bye weeks with avail:false) == weeks_out`, or `== total non-bye` when `out_for_season`. Pearsall: `4 == 4` |
| **VAL-04** | rule 4 — no orphan flags | every player carrying `availability` joins a `data/injuries.json` row on `(team, _norm_name(player))` whose canonical code **equals** the flagged status. *The app can never show an `IR` badge no feed backs* |
| **VAL-05** | rule 5 | `model.availability.unavailable == count(class=="season")`; `season_points_removed == Σ season_points_lost` ±0.05 |
| **VAL-06** | **negative fixtures**, one per rule, in a temp copy of the data | five separate corrupted documents (sum inflated by 5.0; a season-ending player given `pts 3.2`; `weeks_out:4` with only 3 `avail:false`; an `availability` block whose player has no injuries row; `unavailable:2` with one season player) each produce a **non-zero exit** and name the offending `gsis_id`. *Exit-code gated — never grep the summary* |
| **VAL-07** | `data/contracts/player_weekly.schema.json` | `additionalProperties:false` retained on all three objects; `availability` + `avail` accepted; `weeks_out` typed `["integer","null"]` min 1 max 17; `confidence` `enum ["explicit","rule"]`; `class` `enum ["week","season"]`; an unknown key (`blocked_weeks`) is **rejected** — one carrier only |
| **VAL-08** | `data/contracts/injuries.schema.json` (**new**) | the committed `data/injuries.json` validates. **[QA-C5: `injuries.json` is NOT in `SCHEMA_TO_DATA` today — the schema must also describe the pre-existing `updated_utc`, `source` and `injuries` keys or the gate goes red on landing]**. `status` stays a free string (ESPN raw); `availability` is `enum ∪ null` |
| **VAL-09** | `tests/smoke.sh` new invariant | every `status` in `data/injuries.json` normalizes to a canonical code; inject `"Commissioner Exempt"` into a temp copy → smoke **fails**. *This is the single check that stops the bug class recurring* |
| **VAL-10** | three new selftest lines wired into the existing consolidated block | `python3 scripts/availability.py --selftest`, `scripts/injury_duration.py --selftest`, `scripts/build_preseason.py --selftest`, each `|| fail "…"`. Force each to exit 1 → `smoke.sh` exits non-zero |
| **VAL-11** | `tests/smoke.sh:75` | `len(weights) != 32` becomes `!= 33`. **Once** — `:66` is the *teams* count and must not be touched (C8) |
| **VAL-12** | `tests/feature/signal_registry.test.mjs:54-56` | `EXPECTED.length === 33`; `preseason_form` present in `EXPECTED` and in `meta.weights` at `0.0`; header comment updated from "player 19, game 10, market 3 = 32" to the new split |
| **VAL-13** | `scripts/validate_data.py EXPECTED_SIGNALS` | gains `preseason_form`; `check_meta_weights` passes at 33 |
| **VAL-14** | `espn.fetch_injuries()` on a row with an unmapped status | raises `FeedError` whose message **contains the raw string** and points at `scripts/availability.py` (the `_team_abbrev()` precedent, `espn.py:81-92`). Contrast with WK-17: loud at the scraper, graceful in the consumer |

---

## 10. PRE / PROJ — preseason and projection layer (22 + 10 cases)

### 10.1 PRE — `scripts/build_preseason.py --selftest`, `tests/feature/preseason.test.mjs`

| ID | Case | Expected |
|---|---|---|
| **PRE-01** | `ratio = 2.0`, `sample = 1.0`, `decay = 1.0` | `adj == 1.03` exactly (clamped) |
| **PRE-02** | `ratio = 0.1`, full sample/decay | `adj == 0.97` exactly |
| **PRE-03** | 15 snaps, `MIN_SNAPS = 30`, `signal = 1.03`, `decay = 1.0` | `sample == 0.5`, `adj == 1.015` |
| **PRE-04** | 60 snaps | `sample == 1.0` (capped, never > 1) |
| **PRE-05** | `team_regular_finals = 3` | `decay == 0.0` and **`adj == 1.0` exactly** — mechanical, not by convention. Assert equality, not a tolerance |
| **PRE-06** | 1 and 2 team finals | `decay == 2/3` and `1/3`; `adj` interpolates |
| **PRE-07** | 4 and 10 team finals | `decay == 0.0` (never negative) |
| **PRE-08** | 0 preseason snaps | `adj == 1.0`, `reason == "no_preseason_snaps"` |
| **PRE-09** | no prior-season baseline (`prior_season_points` None or 0) | `adj == 1.0`, `reason == "no_baseline"`, **no divide-by-zero** |
| **PRE-10** | feed unreachable / no preseason window | the whole document is `{"available": false, "reason": "<non-empty>"}` — never a stale or fabricated number. A previously-written document is **not** silently reused |
| **PRE-11** | contract | `caveat` is `required` in `preseason_form.schema.json` and matches verbatim: *"Preseason snaps are not true performance — starters sit or play a series and everyone is avoiding injury. Capped at ±3%, decays to zero after three regular-season games, and currently carries weight 0."* |
| **PRE-12** | document meta | `estimate: true`; `PRESEASON_CAP 0.03`, `MIN_SNAPS 30`, `DECAY_GAMES 3` all present. **Cap is 3%, not TECH's 5%** (C9) |
| **PRE-13** | rank stability against the **real** committed `data/player_projections.json` | applying `adj` at **full** strength moves no top-100 player more than **±2 ranks within his position**. Measured, not assumed |
| **PRE-14** | wiring at weight `0.0` | `data/player_projections.json` **byte-identical**; `signals_used` stays `[]` for all 300 rows (verified: `project_player` only appends when `w != 0.0`, and all 300 are `[]` today) |
| **PRE-15** | `_interval_band` | does **not** widen on `preseason_form` — it is a point estimate, not an uncertainty statement. Assert `low`/`high` unchanged when only `preseason_adj` is present |
| **PRE-16** | ingestion | `build_preseason` calls `espn.fetch_scores` / `fetch_final_linescores` with `seasontype=1`, `weeks=range(1,5)`; **no signature change** to `espn_gamestats.py` |
| **PRE-17** | status gating | non-FINAL preseason games are excluded from `preseason_ppr` / `preseason_snaps`, same rule as everywhere else |
| **PRE-18** | surfacing | no surface can render the number without the `caveat` (contract-enforced); `preseason_form.json` joins `OPTIONAL_DATA` so its absence is not a gate failure |
| **PRE-19** | **[GAP-FILL — R17-E5-S2-AC2 "the sitting starter", the mandated *preseason-must-not-jump-rankings* counterpart; PRE-03 tests 15 snaps, not this]** a proven starter who played **one series** — `preseason_snaps = 8`, `MIN_SNAPS = 30`, signal at its **clamped extreme** `1.03`, `decay = 1.0` | `sample == 8/30 == 0.2667` (assert `abs(sample − 0.266666…) < 1e-9`, and `sample < 0.3`); `adj == 1 + 0.03 × 8/30 == 1.008` exactly (assert `abs(adj − 1.008) < 1e-9`), i.e. **at most ±0.8 %** of movement. Assert the pairing that is the actual product claim: a **backup** with `preseason_snaps = 60` at the same clamped extreme gets `adj == 1.03`, and `1.03 / 1.008 = 1.0218` — a 2.2 % spread, far below the gap between a starter and a backup in `proj_points`, so **the three-TD backup cannot outrank the starter who sat**. Assert with the real committed `data/player_projections.json`: applying `1.03` to the lowest-ranked RB in the top 100 and `1.008` to the highest still leaves their order unchanged |
| **PRE-20** | **[GAP-FILL — R17-E5-S3-AC2: the table's `0`-finals endpoint was untested; PRE-05/06/07 cover 3, 1, 2, 4, 10]** `decay` at `team_regular_finals = 0` | `decay == 1.0` **exactly** — full strength before a single real game is final. Then assert the **whole** table in one pass: `[0,1,2,3,4]` → `[1.0, 0.667, 0.333, 0.0, 0.0]` (±1e-3 on the thirds, **exact equality** on `1.0` and `0.0`), and that the sequence is **monotonically non-increasing** and never negative for `0..18` |
| **PRE-21** | **[GAP-FILL — R17-E5-S3-AC3 "team, not global week": no case existed]** two players in the same calendar week whose teams have **different** FINAL regular-season counts (one team on bye, or a postponed game) — team X `2` finals, team Y `1` final | their `decay` values **differ**: `0.333` vs `0.667`. Assert the source is `espn.fetch_final_results(SEASON)` counted **per team** — inject a stub where a global `current_week - 1` would give both players the same decay, and assert the two still differ. Also assert `grep -c "current_week" scripts/build_preseason.py === 0`, so the wrong source cannot be reintroduced silently |
| **PRE-22** | **[GAP-FILL — R17-E5-S4-AC5: the on-disk encoding rule was asserted for `injuries.json` (CD-07) but not for the new file]** `data/preseason_form.json` as written by `build_preseason.py` | `ensure_ascii=True` — `grep -P '[^\x00-\x7F]' data/preseason_form.json` finds **nothing**, which also means the `caveat`'s em dash and `±` must be escaped as `—` / `±` on disk while reading back **exactly** as the PRE-11 verbatim string via `json.load`. Indent matches the repo convention used by the sibling `OPTIONAL_DATA` documents. Re-running the builder with unchanged inputs produces a **byte-identical** file (no cosmetic churn, no timestamp-only diff outside the declared `updated_utc` key) |

### 10.2 PROJ — F4 / F6 (`player_projection.py`, `espn_players.py`, `build_predictions.py`)

| ID | Case | Expected |
|---|---|---|
| **PROJ-01** | `espn_players.py:119` | `injury_status` is `availability.normalize_status(p.get("injuryStatus"))` → canonical code or `None`. No raw kona string escapes the boundary |
| **PROJ-02** | `_INJURY_STATUS` (`player_projection.py:68-76`) | re-keyed onto the canonical constants and **complete for all 8**: `ACTIVE (1.00,1.00)`, `QUESTIONABLE (0.85,0.95)`, `DOUBTFUL (0.35,0.90)`, `OUT (0.00,1.00)`, `IR/PUP/NFI/SUSPENDED (0.00,1.00)` |
| **PROJ-03** | `injury_status = None` | `(1.0, 1.0)` — **unknown is not a discount** |
| **PROJ-04** | `_interval_band` (`:184-186`) | widens `+0.06` on `QUESTIONABLE`, `DOUBTFUL` and every `SEASON_CLASS` code; `ACTIVE` and `None` unchanged |
| **PROJ-05** | the previously-dead `"pup"` key (`:75`, `:185`) | becomes live: a synthetic record with `injury_status="PUP"` now takes the band. F4 closed |
| **PROJ-06** | injuries feed down | the second pass sits **inside** the existing `try` at `:374-380`; first-pass projections are exactly today's and `feeds["injuries"] == "down"`. **No hoist** (C1) — the injuries block stays at `:374-380` and `build_weekly` still runs after it at `:587` |
| **PROJ-07** | id-order guard | if the re-projected top-300 id order differs, **skip the write**, print `[warn] …skipped` to **stderr**, and leave `player_projections.json` untouched. Protects `weekly_contract.test.mjs:40`. At all-weights-zero it must never fire — assert it does not on the real data |
| **PROJ-08** | numbers | `proj_points` **unchanged** for all 300; only `low`/`high` move; `low <= proj <= high` and the descending sort hold (`real_data.test.mjs:45-55` stays green) |
| **PROJ-09** | `build_injury_history.py` | output byte-identical; `--selftest` covers the three-status assertion (C7) |
| **PROJ-10** | **[GAP-FILL — R17-E6-S2-AC7: the fact-vs-learned-effect boundary had no case]** the two sides of the boundary, asserted separately | **(a) fact side:** *how many weeks an IR player misses* is **not** weight-gated — `unavailability()` / `player_weeks()` consult no registry weight; assert `grep -c "weight\|registry\|signals" scripts/availability.py === 0` and that WK-19…WK-22 produce their blocks with `data/meta.json` weights untouched. **(b) learned side:** *"players return from IR at ~85 % effectiveness"* **is** weight-gated — the `ros_avail` family stays registered at weight **`0.0`** in `data/meta.json` + `scripts/signals/registry.py`, `app/ros.js`'s `availW` hook stays **unimplemented**, and `data/player_projections.json` / RoS values are unchanged by it. A build that hard-codes a return-effectiveness haircut anywhere fails (b); a build that routes the *duration fact* through the promotion gate fails (a) |

---

## 11. REGRESSION RISK LIST

### 11.1 The ONE existing lock that changes

**`tests/feature/weekly_contract.test.mjs:83-93`** — `'non-bye weekly points sum to the
season projection within 0.1'`.

*Why it must change:* it runs over the committed files and asserts `|sum − proj_points| ≤ 0.1`
for **every** player. Pearsall's zeroed weeks make it red — **correctly**, because the
assertion in its current form *encodes F2*: it is the test that guarantees a player who will
not take a snap in 2026 still carries 100% of his season points.

*Expected new values:*

| Branch | Rows today | Assertion | Expected |
|---|---|---|---|
| no `availability`, or `class !== 'season'` | **299** of 300 | `Math.abs(sum − season) <= 0.1` — **character-for-character unchanged** | green, values unchanged |
| `out_for_season === true` | **0** today | `assert.equal(sum, 0)` | vacuously green today; locks the future |
| `class === 'season'`, partial | **1** (`espn-4428209`) | `Math.abs(sum − season × avail/nonBye) <= 0.1` **and** `sum < season − 0.1` | `sum = 67.73`, target `88.6 × 13/17 = 67.75`, `|Δ| = 0.02` ✓; `67.73 < 88.5` ✓ |

Rename to `'…sum to the AVAILABILITY-ADJUSTED season projection'`. **Strictly stronger:**
the new `sum < season − 0.1` clause means the test can no longer silently pass on a no-op —
the exact failure mode that let F1/F2 ship. Owner **BUILD-A**, landing in the same commit as
the regenerated data and the schema (all three are coupled by `additionalProperties:false`).

### 11.2 Existing tests that touch the renormalization invariant — must stay GREEN and UNMODIFIED

If any of these goes red, **the build is wrong — do not "fix" the test.**

| Test | Line(s) | Why it is exposed | Expected value (unchanged) |
|---|---|---|---|
| `tests/feature/weekly_injury.test.mjs` | `:61` | asserts the prior table verbatim; a builder re-keying `INJURY_MULT` to canonical codes breaks it | `{Out: 0.55, Doubtful: 0.7, Questionable: 0.9}` |
| " | `:69` | **mechanic (a) preservation proof** — drives `player_weeks` with `unavailable_weeks` defaulted to 0 | `sum_base == sum_hurt == 200.0` ±1e-6; shaped/unshaped ratio exactly `0.55`; bye row `0` |
| " | `:107` | the join contract; `"Active"` must still normalize to `1.0` and be **dropped** | `{ p1: 0.55 }` |
| " | `:122` | absent / empty / all-`Active` ⇒ **byte-identical** document, no `injury_shape` | three booleans `true` |
| " | `:146` | applied shaping meta + season total intact | `{applied: true, statuses_used: 1}`; `p1_sum` within `0.09` of `200.0`; `p2_untouched true` |
| `tests/feature/weekly_contract.test.mjs` | `:40` | id/order mirror — BUILD-C's re-projection could reorder | `deepEqual` of the 300 ids, unchanged. Guarded by PROJ-07 |
| " | `:55-80` | per-week type/2dp loop — new `avail` key must not break typing | unchanged (the loop reads named keys; it does not reject extras — the **schema** is the real gate, VAL-07) |
| " | `:95-…` | byes/opponents vs `schedule_full` — a blocked week is `pts 0` but **`bye:false, opp` non-null** | unchanged. Risk: a builder who "zeroes" a week by writing `bye:true` or `opp:null` breaks this |
| `tests/feature/lineup.test.mjs` | all 5 | no fixture sets `playable`; the strict `=== false` demotion must be inert | FLEX `'rbC'`; `total 106`; `bench ['wrC']`; FLEX `'wr3'`; `netGain 7`; `netGain 0`; `__selftest() true` (`total 98`, `netGain 12`) |
| `tests/feature/team_logic.test.mjs` | `:137-149` | `weeklyPoints` rescales by `seasonAdj/seasonPpr` — a *proportional* ratio, so a reduced weekly sum passes through | `pts[6] === 0`; every other week `5` ±1e-9; `sum == 85` ±1e-9 |
| `tests/feature/real_data.test.mjs` | `:45-55` | BUILD-C widens `low`/`high` | `low <= proj <= high`, `proj > 0`, descending sort — all unchanged; `proj_points` untouched |
| `tests/feature/team_rel2.test.mjs`, `team_vor.test.mjs` | — | VOR / replacement ranks read `proj_points`, which does not move | unchanged |
| `tests/feature/ros.test.mjs` | — | uses **synthetic** week arrays, not committed data | unchanged. (Real-data RoS *does* move: Pearsall `88.6 → 67.7`. Any new RoS assertion must use the new number) |
| `tests/feature/contrast_aa.test.mjs` | `T` token block + all existing pairings | BUILD-B **appends** 6 pairings | existing ratios unchanged; new: `--accent-txt` 6.34 / 7.20 / 5.87, `--warn` 8.05, `--brand-txt` 6.81, `--muted` 7.98. **`--accent` as chip text is 4.28 on `--surface-2` / 3.96 on `--elev` — FAILS AA; assert it is border-graphic only** |
| `tests/feature/signal_registry.test.mjs` | `:54-56` | **must change** with `meta.json` + `registry.py` (BUILD-C, one commit) | `32 → 33`; `preseason_form` at `0.0` |
| `tests/smoke.sh` | `:75` | **must change** — once. `:66` is the teams count, leave it | `32 → 33` |
| `tests/web/web.spec.mjs` | `:1234` | 7 starter rows under demotion | `7` — preserved because a slot is always filled, or falls to the existing `— no eligible player —` branch which already emits a `.lu-row`. Neither `.lu-forced` nor `.lu-swapnote` is a `.lu-row` |
| " | `:1238` | `.lu-move, .lu-optimal` ≥ 1 | preserved **only** if the "already optimal" replacement keeps `class="lu-optimal lu-gap"` (VW-03) |
| " | `:1253-1254` | compare deep-link + edge chips | `.cmp-id` `2`; `.cmp-edge` `>= 4` (the new availability edge can only raise it) |
| " | `:190`, `:489` | both read `player_weekly.json` and pick the **first** WR with `receptions_prior > 0` / first QB with a bye | unaffected — those resolve to Puka Nacua (WR rank 1) and a top QB, not Pearsall (rank **192**) |
| `tests/feature/history_contract.test.mjs`, `rel6_contracts`, `rel7_contracts`, `nflverse_aggregates` | — | **verified: none reads `player_weekly.json` or `injuries.json`** | unaffected |

### 11.3 Landing-order risks (gate goes red between commits if violated)

1. **A's three coupled files must land together**: `data/player_weekly.json` +
   `data/contracts/player_weekly.schema.json` + `tests/feature/weekly_contract.test.mjs`.
   `additionalProperties:false` makes any two-of-three landing red.
2. **C must land LAST**, after D. If C lands first, `smoke.sh` calls a `build_preseason.py`
   that does not exist and `meta.weights` is 33 with no builder → red between commits.
3. **C's `injuries.schema.json` newly enrolls `injuries.json` in validation** — see QA-C5.
4. `build_injury_history.py` must **not** be re-keyed (C7) — `injury_history.json` cannot be
   regenerated in the sandbox (nflverse 403s through the proxy), so the change would be an
   unfixable red gate.

---

## 12. Coverage matrix (RCA finding → cases)

| Finding | Cases | Count |
|---|---|---|
| **F1** IR/suspension get no haircut | AV-01, AV-08, AV-12..15, WK-02..06, WK-14, **WK-19..22**, CD-01..04, VAL-01..05, §11.1 | 26 |
| **F2** no multi-week / season-long unavailability | WK-01..09, WK-11, WK-14..16, **WK-19..22**, CD-02, CD-06, VAL-01..03, §11.1 | 23 |
| **F3** optimizer ignores availability | APP-02..06, APP-12..18, **APP-20..23**, VW-01..03, **VW-05**, E2E-01..09, **E2E-17..19** | 32 |
| **F4** PUP/NFI never captured | AV-02, AV-04, AV-08, AV-14, PROJ-02, PROJ-05, APP-07, APP-08, **APP-24** | 9 |
| **F5** duration scraped then thrown away | DUR-01..30, **DUR-31**, CD-03, CD-07, E2E-12, E2E-16, APP-09, APP-10, **APP-20** | 38 |
| **F6** projection bands unreachable | PROJ-01..09, **PROJ-10** | 10 |
| **F7** preseason not ingested | PRE-01..18, **PRE-19..22**, **VW-06**, **VW-07** | 24 |
| Vocabulary / honest-data / gate integrity | AV-06, AV-07, AV-11, AV-16, **AV-17**, WK-17, WK-18, VAL-06..14, VW-04 | 17 |

Every RCA finding and every acceptance criterion in §1 maps to at least one executable case;
no finding is covered by fewer than 9. Coverage of the seven findings: **7/7 (100%)**.
Coverage of the design's named behavioural contracts (§2 carrier shape, §3 algorithm, §4
parser, §5 surfaces, §6 preseason, §7 projections, §8 validation): **7/7**.

*(Two counts in this matrix were off by one before the gap-fill pass and are corrected
above: F2 enumerated 19 cases while claiming 20, and the vocabulary row enumerated 16 while
claiming 17 — the latter now genuinely reaches 17 with AV-17.)*

---

## 13. AC → case traceability (spec cross-check, all 117 ACs)

Added by the **spec cross-check** pass. `USER_STORIES.md` §7 already claims 117/117 coverage,
but that rollup maps each AC to a *named test function*, not to a case in this file — so it
could not show whether a concrete expected value existed anywhere. This section closes that
loop: every AC in `USER_STORIES.md` is mapped to the case ID(s) here that carry its expected
value. **22 cases were appended** to fill the holes it exposed; they are marked
**[GAP-FILL]** inline and shown in **bold** below.

**Before the fill:** 92 / 117 ACs (78.6 %) had a case carrying a concrete expected value —
13 ACs had no case at all, 12 had a case that covered only part of the AC.
**After the fill: 117 / 117 = 100 %.**

| Story | AC → case(s) |
|---|---|
| **E1-S1** | AC1 → AV-08, AV-09, **AV-17** · AC2 → AV-01 · AC3 → AV-02 · AC4 → AV-02, AV-03 · AC5 → AV-06, AV-07 · AC6 → AV-01..07, VAL-10 |
| **E1-S2** | AC1 → DUR-13..16, DUR-19 · AC2 → DUR-01..08 · AC3 → DUR-09..11, AV-12 · AC4 → DUR-12 · AC5 → DUR-17, DUR-18 · AC6 → DUR-03, DUR-24 · AC7 → DUR-22, DUR-23, DUR-25, DUR-26, **DUR-31** · AC8 → DUR-20, VAL-10 · AC9 → DUR-30 |
| **E1-S3** | AC1 → VAL-14 · AC2 → VAL-09, AV-11 · AC3 → WK-17 · AC4 → AV-16, PROJ-09 · AC5 → CD-07, VAL-08 |
| **E2-S1** | AC1 → **WK-19** · AC2 → WK-04 · AC3 → WK-01, §11.2 · AC4 → WK-05, WK-06 · AC5 → AV-15 · AC6 → CD-02, CD-06, §11.1 · AC7 → WK-18 |
| **E2-S2** | AC1 → **WK-20** · AC2 → **APP-24**, APP-02 · AC3 → **APP-24**, APP-07, AV-08, AV-14 · AC4 → AV-14 · AC5 → **APP-24** |
| **E2-S3** | AC1 → **WK-21** · AC2 → **WK-22**, DUR-12 · AC3 → AV-13 · AC4 → APP-06 |
| **E2-S4** | AC1 → WK-16, §11.2 · AC2 → AV-10 · AC3 → AV-10 · AC4 → APP-05 · AC5 → APP-03, APP-04 · AC6 → CD-04, CD-05 |
| **E2-S5** | AC1 → AV-14, CD-03 · AC2 → APP-09, APP-10, **APP-20** · AC3 → E2E-12 · AC4 → E2E-01, E2E-14 · AC5 → APP-09, APP-10, **APP-20** |
| **E3-S1** | AC1 → APP-12 · AC2 → APP-14 · AC3 → VW-01 · AC4 → APP-16 · AC5 → APP-17, APP-18 · AC6 → VW-02 |
| **E3-S2** | AC1 → APP-13 · AC2 → APP-13, E2E-05 · AC3 → VW-03, E2E-07 · AC4 → E2E-06 · AC5 → E2E-04, **E2E-18** · AC6 → APP-15 |
| **E3-S3** | AC1 → **E2E-17** · AC2 → **APP-21** · AC3 → **APP-20** · AC4 → **APP-22** · AC5 → **APP-23** · AC6 → §11.2 (`contrast_aa`, +6 pairings with ratios) |
| **E4-S1** | AC1 → E2E-10 · AC2 → E2E-11 · AC3 → **E2E-19**, **APP-23** · AC4 → VW-04 |
| **E4-S2** | AC1 → E2E-16 · AC2 → E2E-12 · AC3 → E2E-16 · AC4 → CD-03, VAL-07 |
| **E4-S3** | AC1 → E2E-13 · AC2 → E2E-14 · AC3 → PROJ-08 · AC4 → §11.2 (`team_logic:137-149`) · AC5 → **VW-05** |
| **E5-S1** | AC1 → PRE-16 · AC2 → PRE-17 · AC3 → **VW-06**, PRE-18 · AC4 → **VW-07**, VAL-12 |
| **E5-S2** | AC1 → PRE-01, PRE-02 · AC2 → **PRE-19**, PRE-03 · AC3 → PRE-13 · AC4 → PRE-14, VAL-12 · AC5 → PRE-15 · AC6 → VAL-11, VAL-12 |
| **E5-S3** | AC1 → PRE-05 · AC2 → **PRE-20**, PRE-06, PRE-07 · AC3 → **PRE-21** · AC4 → PRE-10 |
| **E5-S4** | AC1 → PRE-11 · AC2 → PRE-11 · AC3 → PRE-08, PRE-09, PRE-10 · AC4 → PRE-12 · AC5 → **PRE-22** |
| **E6-S1** | AC1 → VAL-01 · AC2 → VAL-02 · AC3 → VAL-03 · AC4 → VAL-04 · AC5 → VAL-05, CD-04 · AC6 → VAL-06 |
| **E6-S2** | AC1 → PROJ-01 · AC2 → PROJ-02, PROJ-05 · AC3 → PROJ-03 · AC4 → PROJ-06 · AC5 → PROJ-07 · AC6 → PROJ-08 · AC7 → **PROJ-10** |
| **E6-S3** | AC1 → §11.1 · AC2 → §11.1 (healthy branch, 299 rows) · AC3 → §11.1 (`sum < season − 0.1`) · AC4 → §11.3-1 · AC5 → §11.2 (do-not-touch list) · AC6 → gate header (`competition.test.mjs` does not exist) · AC7 → gate header (235 / 75 baseline) + §11.1 |

### 13.1 The five mandated fantasy scenarios — where each one now lives

| Scenario | Named AC | Case(s) carrying the expected value |
|---|---|---|
| **IR mid-season** ("my RB2 lands on IR in week 3") | R17-E2-S1-AC1 | **WK-19** (blocked wks 3-6, target `200 × 13/17 = 152.94`, drop ≈ 47.06) + the live CD-02/E2E-01..03 Pearsall reproduction |
| **PUP return** ("on PUP to start, returns week 7") | R17-E2-S2-AC1 | **WK-20** (blocked wks 1-6, wk 7 non-zero with **no** `avail` key, target `129.41`, `season_points_lost 70.59`) + **APP-24** (returned player renders byte-identically to a healthy one) |
| **Suspension** ("a suspended player misses 6 games") | R17-E2-S3-AC1 | **WK-21** (`deepEqual` to WK-20 — one mechanic, two labels) + **WK-22** (the live Bishop 3-game row end to end) + AV-13 (unknown length blocks **nothing**) |
| **Sunday-morning Questionable** (behaviour unchanged) | R17-E2-S4-AC1 | WK-16 (season total preserved to 1e-6, 2-key block) + AV-10 (`INJURY_MULT` byte-identical) + APP-05 + CD-05 (the real 9 week-class players) + `weekly_injury.test.mjs:61/69/107/122/146` **unmodified** |
| **Preseason must not jump the rankings** | R17-E5-S2-AC1/AC2 | PRE-01/PRE-02 (`\|adj − 1\| ≤ 0.03`) + **PRE-19** (8-snap starter → `sample 0.2667`, `adj 1.008`; backup-vs-starter spread only 2.2 %) + PRE-13 (±2 ranks on the **real** committed projections) + PRE-05/**PRE-20** (decay to exactly `1.0`) |

### 13.2 Two ACs whose coverage is deliberately *not* a new case

* **R17-E3-S3-AC6** (contrast) and **R17-E6-S3-AC1..AC7** (the one lock change) are covered by
  §11.1 / §11.2, which already carry exact ratios and exact expected values. Duplicating them
  as numbered cases would create two places to update for one fact — the same drift this
  release exists to remove.
