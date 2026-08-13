# REL17 — UX DESIGN: AVAILABILITY IN THE APP

**Role:** Fantasy UX designer. **Scope:** F3 (Lineup optimizer ignores availability),
plus the visible half of F1/F2/F5 (haircut, season-long absence, parsed duration) and the
honest label for F7 (preseason).
**Surfaces:** `app/views/lineup.js`, `app/views/compare.js`, `app/views/players.js`,
`app/render.js`, `app/theme.css`.
**Canvases:** 402 px iPhone (Safari / standalone PWA) and 1032 px iPad. Dark only.
**Constraints honoured:** no build step, no new fonts, no new tokens, no new breakpoints,
AA ≥ 4.5:1 for every text pairing, semantic meaning never carried by color alone, team
tints untouched (they remain valid only on the ≥ 18.66 px bold `.cmp-name` / `.team-ab`).

The design principle for the whole release, in one line:

> **A manager should never have to wonder whether the app knows a player can't play.**
> Silence means "he plays". A chip means "he doesn't, and here is how long, and here is
> where that came from."

---

## 0. Resolved naming conflict (read this first)

`ARCHITECTURE.md §7` specifies `lu-avail`; `TECH_DESIGN.md §7` specifies `.lu-unavail`.
Both are wrong for the same reason: the identical chip must render on **Compare** and on
**Players**, where a `lu-` prefix is a lie about where the component lives.

**Settled:** the chip is a shared component, `.av-chip`, defined once in `theme.css`
alongside `.lu-bye`. Views add their own *positional/state* classes only
(`.lu-row--unavail`, `.lu-row--forced`, `.cmp-metric--avail`). Neither `.lu-avail` nor
`.lu-unavail` should be created. This is a one-word find/replace in both upstream docs.

---

## 1. Vocabulary → what the manager actually sees

Eight canonical codes come out of `app/availability.js`. They map to **four visible
states**, because a manager only makes three kinds of decision (start him / think about
it / he's gone).

| Code | Chip label | Tone class | Glyph | Playable? | What it means at the draft-day/waiver level |
|---|---|---|---|---|---|
| `ACTIVE` | *(no chip)* | — | — | yes | Normal. Absence of a chip is the signal. |
| `QUESTIONABLE` | `Q` | `--watch` | `⚠` | yes | Game-time call. Have a plan B on the bench. |
| `DOUBTFUL` | `D` | `--watch` | `⚠` | yes | Probably sits. Most managers bench him. |
| `OUT` | `OUT` | `--out` | `⊘` | **no** | Ruled out **this week**. Start someone else. |
| `IR` | `IR` | `--out` | `⊘` | **no** | Multi-week. IR-stash candidate, not a starter. |
| `PUP` | `PUP` | `--out` | `⊘` | **no** | Same shape as IR; carries its own label because the return rules differ. |
| `NFI` | `NFI` | `--out` | `⊘` | **no** | Same shape as IR. |
| `SUSPENDED` | `SUSP` | `--out` | `⊘` | **no** | Not injured — banked, not droppable in most leagues. |

**Why two tones and not one per code.** Eight colors would be unreadable and would fail
the "never color-alone" rule harder (nobody memorises eight hues). Two tones map exactly
to the two *actions*: `--watch` = you decide, `--out` = the app decides for you. The
**code text is the primary carrier** in all eight cases; the glyph is redundant
reinforcement; color is the third and never-sole carrier.

**Do not render an `ACTIVE` chip.** A green "ACTIVE" badge on 673 of 800 players is noise
that trains managers to stop reading chips, and it would make the 11 that matter harder
to find. The one exception is Compare, where the two columns must be symmetric — there
`ACTIVE` renders as plain muted text, not a chip (§5).

**Glyph substitution note:** `⊘` (U+2298) renders in the iOS/macOS system stack. If a
device check shows a tofu box, substitute `✕` (U+2715) globally — do not fall back to
color-only. `⚠` is already in use by `.bye-warn`, so the caution idiom is consistent.

---

## 2. The `.av-chip` component

### 2.1 Markup contract (built in `app/render.js`, pure, one place)

New exported pure helper `renderAvailChip(avail, opts)` next to `renderTrendChip` /
`renderSos`, following their exact conventions (returns `''` for null/ACTIVE input, so a
card rendered without availability is byte-identical to today).

```html
<!-- full density (Compare, banners, ≥820px lineup rows) -->
<span class="av-chip av-chip--out"
      title="Injured Reserve — league minimum 4 games; no return date reported">
  <span class="av-glyph" aria-hidden="true">⊘</span>IR
  <span class="av-dur">· 4+ WKS</span>
  <span class="av-prov av-prov--min">LEAGUE MIN</span>
</span>

<!-- compact density (lineup rows, bench rows, player cards) -->
<span class="av-chip av-chip--sm av-chip--out" title="…">
  <span class="av-glyph" aria-hidden="true">⊘</span>OUT
</span>

<!-- watch tone -->
<span class="av-chip av-chip--sm av-chip--watch" title="Questionable — game-time decision">
  <span class="av-glyph" aria-hidden="true">⚠</span>Q
</span>
```

Rules:
- `.av-glyph` is always `aria-hidden="true"` (matches `.pt-glyph`, `.sig-mark`, `.lk`).
- `.av-dur` is omitted entirely when there is no duration. **Never** render `· ? WKS`,
  `· TBD`, or a zero. Honest-data rule: no duration means no duration element.
- `.av-prov` is omitted when there is no duration. It is never omitted when there *is*
  one — a number without provenance is the exact failure mode F5 created.
- `title` always spells the code out in full ("Injured Reserve", "Suspended", "Doubtful")
  so the abbreviation is never the only affordance.

### 2.2 CSS (append as a new `REL17` block at the end of `app/theme.css`)

```css
/* ==========================================================================
   REL17 — AVAILABILITY chip (OUT / IR / PUP / NFI / SUSP / Q / D).
   ONE component, three surfaces (Lineup, Compare, Players). Meaning is carried
   by the CODE TEXT; the glyph is redundant reinforcement; color is the third
   carrier and never the sole one. Geometry mirrors .lu-bye / .prov-src so the
   chip reads as native to the existing chip family. No new tokens.
   ========================================================================== */
.av-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: var(--mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap;
  background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 999px; padding: 2px 8px; color: var(--muted);
}
/* NOT playable — OUT / IR / PUP / NFI / SUSPENDED */
.av-chip--out   { color: var(--accent-txt); border-color: var(--accent-txt); }
/* Playable, but the manager's judgement — QUESTIONABLE / DOUBTFUL */
.av-chip--watch { color: var(--warn); border-color: var(--warn); }
/* Dense rows — exact size parity with the existing .lu-bye chip */
.av-chip--sm { font-size: 9px; gap: 4px; padding: 1px 6px; letter-spacing: 0.08em; }
.av-glyph { font-weight: 400; }
.av-dur   { font-weight: 700; font-variant-numeric: tabular-nums; }

/* Provenance micro-tag — geometry copied verbatim from .prov-src/.prov-ai so
   "where did this number come from" reads the same everywhere in the app. */
.av-prov {
  display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 0.06em;
  border: 1px solid var(--border); border-radius: 999px;
  padding: 0 5px; margin-left: 2px; white-space: nowrap;
}
.av-prov--report { color: var(--brand-txt); }  /* parsed from the team report */
.av-prov--min    { color: var(--muted); }      /* league-rule floor, NOT a report */

/* Phone sheds the provenance tag (it stays in title=); the tablet canvas shows
   it inline. Reuses the EXISTING 820px breakpoint — no new breakpoint. */
.av-chip--sm .av-prov { display: none; }
@media (min-width: 820px) { .av-chip--sm .av-prov { display: inline-block; } }
```

### 2.3 AA proof (WCAG 2.x relative luminance, computed against the locked tokens)

| Pairing | Ratio | Threshold | Result |
|---|---|---|---|
| `--accent-txt` #F08A8F on `--surface-2` #1F2630 (`.av-chip--out`) | **6.34** | 4.5 | pass |
| `--accent-txt` on `--surface` #161B22 (chip inside `.card`) | **7.20** | 4.5 | pass |
| `--warn` #E0B75D on `--surface-2` (`.av-chip--watch`) | **8.05** | 4.5 | pass |
| `--brand-txt` #78B4DE on `--surface-2` (`.av-prov--report`) | **6.81** | 4.5 | pass |
| `--muted` #B0BDCC on `--surface-2` (`.av-prov--min`, base chip) | **7.98** | 4.5 | pass |
| `--accent-txt` on `--elev` #232C38 | **5.87** | 4.5 | pass |

**Explicitly forbidden:** the base `--accent` (#E35A61) as chip *text* — it measures
4.28:1 on `--surface-2` and 3.96:1 on `--elev`, i.e. **fails**. `--accent` is used in this
design only as a 3 px left border (a graphic, ≥3:1). Add these five rows to
`tests/feature/contrast_aa.test.mjs` so the chip is audited like every other component.

---

## 3. How a duration reads

Three provenance states, three copy shapes. The distinction is the whole point of F5 —
a parsed report and a league-rule floor must never look like the same fact.

| Data | Chip reads | Provenance tag | `title=` |
|---|---|---|---|
| `out_for_season: true`, confidence `explicit` | `⊘ IR · SEASON` | `REPORT` | `Injured Reserve — reported out for the season` |
| `weeks_out: 3`, confidence `explicit` | `⊘ SUSP · 3 WKS` | `REPORT` | `Suspended — 3 games per league announcement` |
| `weeks_out: 4`, confidence `rule_minimum` | `⊘ IR · 4+ WKS` | `LEAGUE MIN` | `Injured Reserve — league minimum 4 games; no return date reported` |
| status only, no duration (`OUT` this week) | `⊘ OUT` | *(none)* | `Ruled out this week` |
| `SUSPENDED`, no parsed length | `⊘ SUSP` | *(none)* | `Suspended — length not announced` |

Copy rules, in priority order:
1. **`SEASON` beats a number.** Never `· 17 WKS`; a manager reads "season" as "drop or
   IR-stash", which is the actual decision.
2. **The `+` is load-bearing.** `4 WKS` = someone reported four. `4+ WKS` = the league's
   floor and we know nothing more. Never render a bare `4 WKS` for a `rule_minimum`.
3. **`WKS`, not `GAMES`.** The whole app is week-indexed (`WK 1`…`WK 18`, `W12` byes);
   introducing a second time unit for one chip breaks that.
4. **No tilde.** `~4 WKS` implies we estimated. We never estimate a duration — it is
   either parsed or it is the rule floor, and the tag says which.

---

## 4. Lineup (`#/lineup`) — the surface that matters most

Four distinct jobs, in the order the manager hits them.

### 4.1 The starter row — the unavailable player is simply not there

Because `bestLineup` demotes unavailable rows below every available one, the normal case
needs **no new UI in the OPTIMAL LINEUP card at all**: the IR player is not in a slot, he
is on the bench, and the bench row carries the chip. That is the correct, quiet outcome.

`app/views/lineup.js` `playerRow()` gains one line that mirrors the existing bye line
verbatim (`:100`), so display and the card total can never disagree:

```js
const a = availabilityOf(w, wk);                       // app/availability.js
const pts = (onBye || a.playable === false) ? 0 : Number(wkEntry && wkEntry.pts) || 0;
```

This matters: a partially-parsed `weeks_out` player can still carry points in a week he
cannot play, and showing `12.4` next to a `⊘ IR` chip is the same lie F1 shipped. Zero it
at the display boundary, exactly like a bye.

### 4.2 Bench row — informational, receded

```html
<div class="lu-row lu-row--bench lu-row--unavail">
  <span class="lu-slot">BN</span>
  <span class="lu-name">Ricky Pearsall
    <span class="av-chip av-chip--sm av-chip--out" title="Injured Reserve — league minimum 4 games; no return date reported">
      <span class="av-glyph" aria-hidden="true">⊘</span>IR<span class="av-dur">· 4+ WKS</span>
      <span class="av-prov av-prov--min">LEAGUE MIN</span></span>
    <span class="lu-meta">WR · <span style="color:#AA0000">SF</span></span>
  </span>
  <span class="lu-pts">0.0</span>
</div>
```

`.lu-row--unavail { opacity: 0.72; }` — identical recede to `.lu-row--bye`. An unavailable
bench player is a fact, not a task.

### 4.3 The forced start — the one case that must shout

If a manager's roster has no available RB, the optimizer has to fill RB2 with someone who
cannot play. **This must never be silent, and it must never read as "optimal".**

Two coordinated changes:

**(a) The row does NOT recede.** It is a to-do, not a footnote.

```css
.lu-row--forced { opacity: 1; border-left: 3px solid var(--accent); }
.lu-row--forced .lu-pts { color: var(--muted); }
```

**(b) A banner at the top of the OPTIMAL LINEUP card, one per warning:**

```css
.lu-forced {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  border-left: 3px solid var(--accent); background: var(--surface-2);
  font-family: var(--sans); font-size: 13px; line-height: 1.45; color: var(--ink);
}
.lu-forced .av-glyph { color: var(--accent-txt); font-size: 14px; line-height: 1.25; }
```

> ⊘ **No available RB on your bench** — RB2 is filled by Bijan Robinson, who is on IR.
> Nothing on your roster can start there. Check the waiver wire.

Template: `No available {POS} on your bench — {SLOT} is filled by {NAME}, who is {PHRASE}.
Nothing on your roster can start there. Check the waiver wire.`

**(c) The "already optimal" line must be suppressed.** Today `moves.start.length === 0`
prints `✓ Your starting lineup is already optimal for Week N`. With a live warning that is
false. Gate it:

```js
if (moves.start.length === 0 && optimal.warnings.length === 0)  // ✓ optimal
else if (moves.start.length === 0)                              // .lu-gap message
```

`.lu-gap` copy: `Your lineup is the best your roster allows this week, but {N} slot{s}
{is/are} filled by {a player/players} who can't play.` — reuses `.lu-optimal` geometry
with `color: var(--warn)`.

### 4.4 "This player is unavailable — started X instead"

The START / SIT MOVES card gains a **swap note** rendered **above** the net-gain line, one
per unavailability-caused swap. Availability is *why*; points are *how much*; the reason
comes first.

```css
.lu-swapnote {
  padding: 10px 14px; border-bottom: 1px solid var(--border);
  font-family: var(--sans); font-size: 13px; line-height: 1.45; color: var(--muted);
}
.lu-swapnote b { color: var(--ink); font-weight: 700; }
.lu-swapnote .av-glyph { color: var(--accent-txt); margin-right: 6px; }
```

```html
<div class="lu-swapnote"><span class="av-glyph" aria-hidden="true">⊘</span>
  <b>Ricky Pearsall</b> is on IR — <b>Jauan Jennings</b> starts at WR2 instead.</div>
```

Template: `{OUT_NAME} is {PHRASE} — {IN_NAME} starts at {SLOT} instead.`

`{PHRASE}` per code (fantasy-natural, never the raw enum):

| Code | Phrase | With `SEASON` | With `N WKS` |
|---|---|---|---|
| `IR` | `is on IR` | `is on IR for the season` | `is on IR, out at least {N} more weeks` |
| `PUP` | `is on the PUP list` | `is on PUP for the season` | `is on PUP, out at least {N} more weeks` |
| `NFI` | `is on the NFI list` | `is on NFI for the season` | `is on NFI, out at least {N} more weeks` |
| `SUSPENDED` | `is suspended` | — | `is suspended for {N} more weeks` |
| `OUT` | `is ruled out this week` | — | — |

`at least` appears only for `rule_minimum`; an `explicit` duration reads `out {N} more
weeks`. The word choice carries the provenance in prose, so the sentence is honest even
when the phone has hidden the `.av-prov` tag.

**Ordering inside the card:** swap notes → net-gain line → START rows → SIT rows.
`.lu-move--net` and the existing rows are untouched.

### 4.5 Start/sit moves never recommend an unavailable player

`moves.start` can never contain an unavailable id once `bestLineup` demotes them. Lock it
as a test assertion, not a code comment — this is the literal F3 defect.

---

## 5. Compare (`#/compare`) — availability is the first row

**AVAILABILITY goes above PROJ PTS**, in both columns and in the centre rail. A manager
comparing two WRs for a flex spot needs "one of them is on IR" before he needs a 0.4-point
projection edge. Both columns always render the row, so the mid-rail stays aligned.

```html
<div class="cmp-metric cmp-metric--avail">
  <span class="cmp-lbl">AVAILABILITY</span>
  <span class="cmp-v">
    <span class="av-chip av-chip--out" title="Injured Reserve — reported out for the season">
      <span class="av-glyph" aria-hidden="true">⊘</span>IR<span class="av-dur">· SEASON</span>
      <span class="av-prov av-prov--report">REPORT</span></span>
  </span>
</div>
```

An available player renders `<span class="cmp-v cmp-avail-ok">ACTIVE</span>` — plain text,
`color: var(--muted); font-weight: 400`, no chip, no green. Symmetry without noise.

**Centre edge chip** (first in `.cmp-mid`, reusing the existing `edge()` markup shapes):

| A / B | Chip |
|---|---|
| A playable, B not | `AVAIL` / `<span class="cmp-win cmp-win--a">◀ plays</span>` |
| B playable, A not | `AVAIL` / `<span class="cmp-win cmp-win--b">▶ plays</span>` |
| both playable | `.cmp-edge--even` / `even` |
| neither playable | `.cmp-edge--warn` / `⚠ neither` |

Direction is the `◀`/`▶` glyph (both `.cmp-win--a/--b` are already the same color token —
the existing pattern, kept).

**The evidence sentence.** When `confidence === "explicit"`, show the report text that
produced the number. This is the payoff for F5 — the manager sees *why* we said SEASON.
It goes at the **foot of the column**, after every metric row, so the centre rail stays
row-aligned:

```css
.cmp-evid {
  margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border);
  font-family: var(--sans); font-size: 11px; line-height: 1.45; color: var(--muted);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.cmp-evid-lbl {
  display: block; font-family: var(--mono); font-size: 9px;
  letter-spacing: 0.08em; color: var(--brand-txt);
}
```

```html
<div class="cmp-evid"><span class="cmp-evid-lbl">WHY · TEAM REPORT</span>
  “Brazzell will officially miss his entire rookie season due to the LCL tear he
  suffered during Wednesday's training camp practice.”</div>
```

Clamped to 3 lines, in quotes, never paraphrased. When `confidence === "rule_minimum"`
there is **no** evidence block — there is no report to quote, and the `LEAGUE MIN` tag
already says so. Rendering a generic sentence there would be fabrication.

---

## 6. Players (`#/players`) — chip only, plus the honesty note the chip forces

Per `ARCHITECTURE.md §7`: chip only, **no re-ranking** in this release.

But a chip alone creates a new problem the architecture flags in Decision D:
`proj_points` stays the **full-availability prior**, so Ricky Pearsall's card shows a large
season number *next to* a `⊘ IR · 4+ WKS` chip. Unexplained, that reads as a bug. Two
mitigations, both cheap:

**(a)** The chip becomes the **first** item in the existing `.p-adorn` row (before trend
and SoS — availability outranks both), passed as `opts.avail` through `renderPlayerCard`:

```css
.p-adorn .av-chip { margin-right: 8px; }
```

**(b)** The chip's `title` on this surface carries the explanation, and the players legend
(`app/views/players.js:108-116`) gains one line in the established `<b>KEY</b> meaning`
shape:

> `<b>OUT / IR / PUP / SUSP</b> this player can't play — PROJ still shows his full-season
> healthy prior, not an availability-adjusted number`

That sentence is the honest resolution of Decision D at the exact place a manager would
otherwise be misled. It also pre-announces the Rel18 change without promising it.

`app/views/team.js` slot meta rows take the same `.av-chip.av-chip--sm` with no other
change — out of this brief's scope beyond that one-line note.

---

## 7. Preseason label (F7) — one chip, one sentence

Preseason is weight `0.0` and display-first, so the *only* honest label is one that says
it is not in the number:

```html
<span class="av-prov av-prov--min" title="Preseason box scores — starters rest, snaps are
not representative. Not used in any projection (weight 0).">PRESEASON · WEIGHT 0</span>
```

It reuses `.av-prov` geometry (same provenance idiom as `AI EST` / `5-YR`) at
`--muted`. Wherever a preseason number appears it must sit beside this tag, and the
surrounding copy says **"preseason form, not weighted"** — never "preseason projection".
If the feed is absent, the tag is replaced by `NO PRESEASON SNAPS` in the same geometry;
it is never silently omitted.

---

## 8. Responsive — 402 px iPhone and 1032 px iPad

**Measured budgets** (`.view` padding `14px 16px`; `.lu-row` grid `44px 1fr auto`, gap 10,
padding `10px 14px`):

| | iPhone 402 | iPad 1032 |
|---|---|---|
| content width | 370 px | 1000 px (cap 1180 not reached) |
| `.lu-row` inner | 342 px | 972 px |
| `.lu-name` cell | **≈ 242 px** | **≈ 868 px** |
| `.cmp-col` inner | 346 px (stacked, ≤ 560 px rule) | ≈ 423 px each |

**iPhone 402.**
- `.av-chip--sm` at 9 px mono: `⊘ IR · 4+ WKS` ≈ 78 px. Name (14 px bold, "Ricky
  Pearsall" ≈ 100 px) + chip + `.lu-meta` ("WR · SF" ≈ 46 px) ≈ 224 px + gaps — it fits,
  but a long name (`John Michael Gyllenborg`) will **wrap to a second line**.
  **That is the accepted outcome.** A wrapped row is better than a truncated chip; never
  add `text-overflow: ellipsis` to `.lu-name`, because the ellipsis would eat the chip
  before it eats the name. `.lu-row`'s `align-items: center` handles the taller row.
- `.av-prov` is hidden (CSS above); provenance survives in `title` **and** in the swap-note
  prose ("out **at least** 4 more weeks"), so nothing is lost, only relocated.
- Compare is already single-column below 560 px, so the **full** chip + 3-line evidence
  block get 346 px and render at full density. No phone-specific Compare rule needed.
- Banners (`.lu-forced`, `.lu-swapnote`) are full-bleed sans at 13 px / 1.45 — two to three
  lines on a phone, which is fine; they are the most important text on the screen.

**iPad 1032.**
- Lineup rows have ~868 px of name cell: chip, duration and `LEAGUE MIN` tag all sit inline
  on one line with the name and meta. The `@media (min-width: 820px)` rule is the only
  size-conditional in the whole design.
- Compare is the 3-column `1fr auto 1fr` rail at ~423 px per column — the full chip and
  the evidence block fit without clamping in most cases; the 3-line clamp still guards a
  long quote.
- Players `.card-list` is a 3-up grid at ≥ 1200 px and 2-up at 1032 px; `.p-adorn` already
  `flex-wrap`s, so the chip pushes trend/SoS to a second adorn line on narrow cards with
  no new rule.

No new breakpoints. The design uses exactly two existing ones (`820px`, `560px`).

---

## 9. Concrete reproductions (real rows from today's `data/injuries.json`)

These are the acceptance scenarios in fantasy terms, using players actually in the feed.

**R1 — the season-ending stash (`REPORT` provenance).**
Chris Brazzell II (CAR, WR) — detail: *"will officially miss his entire rookie season due
to the LCL tear…"*. Parses to `out_for_season`. Bench row shows `⊘ IR · SEASON` +
`REPORT`; his weekly pts are `0.0` for every week; Compare shows the quoted sentence under
`WHY · TEAM REPORT`; Players card shows the chip **and** the legend note explaining why
PROJ is still his healthy prior. **Today he projects as fully healthy and can be
auto-started — that is F1+F2+F3 in one row.**

**R2 — the ambiguous IR (`LEAGUE MIN` provenance) — the Pearsall null.**
Ricky Pearsall (SF, WR) — detail is a surgeon quoting 2027 recovery odds, with **no**
duration. `parse_duration` returns null → `IR` + `MIN_WEEKS_OUT = 4`. Chip reads
`⊘ IR · 4+ WKS` + `LEAGUE MIN`; **no** evidence block in Compare (nothing to quote); swap
note reads *"Ricky Pearsall is on IR, out **at least** 4 more weeks"*. This row is the
proof that we never guess a number.

**R3 — the suspension with a stated length (`REPORT`).**
Beanie Bishop Jr. (CHI) — *"set to miss the first three games of the 2026 regular
season"* → `SUSPENDED`, `weeks_out: 3`, explicit. Chip `⊘ SUSP · 3 WKS` + `REPORT`.
Weeks 1–3 zeroed, week 4 onward normal — so the Week 4 lineup starts him again with no
chip, which is the behaviour a manager expects and the current build cannot produce.

**R4 — the forced start.** A 12-team roster whose only two RBs are both on IR. RB2 fills
with an unavailable player, `.lu-row--forced` + `.lu-forced` banner fire, the `✓ already
optimal` line is suppressed, and the copy points at the waiver wire.

---

## 10. Accessibility checklist (all must hold before the gate is called green)

1. Every text/background pairing in §2.3 ≥ 4.5:1 — added to
   `tests/feature/contrast_aa.test.mjs`.
2. `--accent` never used as chip text (fails at 4.28:1); only as a ≥ 3:1 border graphic.
3. Every chip's meaning is readable with color removed: `⊘ IR · SEASON` states it in
   glyph **and** text.
4. Every glyph is `aria-hidden="true"`; no glyph is the sole carrier of a fact.
5. Every abbreviation has a spelled-out `title` (`IR` → "Injured Reserve").
6. No team tint below 18.66 px bold — the chip carries none.
7. Chips are non-interactive `<span>`s, so no 32 px tap-target minimum applies; the
   existing `.sort-chip/.pf-chip { min-height: 32px }` rule is untouched.
8. `prefers-reduced-motion` — this design adds no animation at all.
9. The Playwright lock at `tests/web/web.spec.mjs:1209-1305` (exactly 7 `.lu-row` starter
   rows) is **preserved**: an unavailable player is demoted to bench, and the existing
   `— no eligible player —` branch already emits a row when a slot cannot be filled.

---

## 11. Copy strings — the complete set (builder's reference)

```
CHIP LABELS      Q · D · OUT · IR · PUP · NFI · SUSP        (ACTIVE renders nothing)
DURATIONS        · SEASON   · {N} WKS   · {N}+ WKS
PROVENANCE       REPORT   LEAGUE MIN   PRESEASON · WEIGHT 0   NO PRESEASON SNAPS

TITLES
  Injured Reserve — reported out for the season
  Injured Reserve — league minimum 4 games; no return date reported
  Suspended — {N} games per league announcement
  Suspended — length not announced
  Ruled out this week
  Questionable — game-time decision
  Doubtful — expected to sit

LINEUP · swap note
  {OUT_NAME} is {PHRASE} — {IN_NAME} starts at {SLOT} instead.
LINEUP · forced start banner
  No available {POS} on your bench — {SLOT} is filled by {NAME}, who is {PHRASE}.
  Nothing on your roster can start there. Check the waiver wire.
LINEUP · suppressed-optimal replacement
  Your lineup is the best your roster allows this week, but {N} slot{s} {is|are}
  filled by {a player|players} who can't play.
LINEUP · unchanged when nothing is wrong
  ✓ Your starting lineup is already optimal for Week {N}.

COMPARE · row label      AVAILABILITY
COMPARE · available      ACTIVE
COMPARE · edge chip      ◀ plays  /  ▶ plays  /  even  /  ⚠ neither
COMPARE · evidence label WHY · TEAM REPORT

PLAYERS · legend line
  OUT / IR / PUP / SUSP  this player can't play — PROJ still shows his full-season
  healthy prior, not an availability-adjusted number
```

---

## 12. What this design deliberately does NOT do

- **No re-ranking on Players.** Architecture §7 defers it to Rel18; the legend line is the
  honest bridge until then.
- **No green ACTIVE chip.** 673 chips to find 11 is worse than no chips.
- **No estimated durations, ever.** No `~`, no `TBD`, no inferred return week. If the
  parser returns null, the chip carries a status and no number.
- **No new tokens, fonts, breakpoints, or bundler.** Every color is a locked token; every
  geometry is copied from an existing chip (`.lu-bye`, `.prov-src`, `.bye-warn`).
- **No opportunistic refactor** of `.lu-row`, `.cmp-grid`, or `renderPlayerCard`'s existing
  arguments — every addition is an optional `opts` key that returns `''` when absent, so
  cards rendered without availability are byte-identical to today.
