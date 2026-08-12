# Phase 0 — Rest-of-Season (RoS) Value: Visual / UX Design

Owner: Visual / UX designer · Status: DESIGN (not yet implemented)

---

## 0. Substrate + surface reality (honest-data gate — read first)

The brief points me at `app/theme.css`, `app/render.js`, `app/views/players.js`,
`app/views/team.js`. **None of those files exist in this checkout.** This tree is
the WC26 soccer tracker; verified with `ls`/`glob`. The design below is therefore
mapped onto the tokens and components that **actually exist and ship here**, so an
implementer against the real NFL2026 repo re-points file paths but keeps a
design that is already proven in this codebase's idiom:

| Brief names | Real, present equivalent used by this design |
|---|---|
| `app/theme.css` | `app/styles.css` (design tokens under `:root` + `:root[data-theme='dark']`) + `app/theme.js` (light/dark/auto toggle) |
| `app/render.js` | `app/main.js` router `switch` (`renderXView(root, data, params)` idiom) |
| `app/views/players.js`, `app/views/team.js` | `app/views/standings-view.js`, `app/views/team-detail.js`, `app/components/biggest-movers.js` (chip strip), `.winner-ladder` (ranked rows) |

**Design rule honored:** RoS ships as a **new lightweight route + view +
component**, touching **zero** e2e-locked hot files. It reuses existing tokens and
component idioms only — **no new fonts, no new color system, no build step, no
framework**. Every color below is an existing token (`--surface`, `--border`,
`--text`, `--text-muted`, `--good`, `--warn`, `--bad`, `--primary`); the only new
CSS is a `.ros-*` namespace built from those tokens.

---

## 1. Where RoS lives (route + non-disruption)

- **New route `#/ros`** — added as one `case 'ros': renderRosView(root, state.data, params)`
  line in `app/main.js`'s existing `switch` (the architect's `app/views/…` TEAM
  extension, isolated into its own view so nothing e2e-locked is edited).
- **New view `app/views/ros-view.js`** — pure display, `renderRosView(root, data, params)`,
  mounts into `root`, re-renders on `data:live-refresh` like every other view.
- **New component `app/components/ros-chip.js`** — the reusable RoS value chip +
  chip strip, so a compact RoS summary can also be embedded later on
  `team-detail.js` without duplicating markup.
- **New CSS block appended to `app/styles.css`** under a `/* RoS value */` banner,
  `.ros-*` namespaced.

Market prices are **display-only, never shown as a driver** — the RoS surface
renders no odds/price field (matches the STANDING RULE and the engine contract).

---

## 2. Information architecture of the RoS view

Top-to-bottom, single scroll column (the repo's `.view` shell):

1. **Position filter bar** — reuses `.filter-bar` + native `<select>` (QB / RB /
   WR / TE / FLEX), identical to `standings-view.js`'s group switcher. `font-size:16px`
   to suppress iOS zoom, `min-height:44px`. On iPad it renders as a segmented row
   (see §5) rather than a dropdown.
2. **"As-of week" honesty line** — `.muted` intro line: `From week 7 · 11 games
   left · projected from prior-week data only`. Mirrors `standings-view.js`'s
   phase-aware intro. Carries the walk-forward promise in plain language.
3. **RoS value chip strip** (horizontal scroll) — the top-N movers by RoS VOR,
   the `biggest-movers.js` strip idiom applied to RoS (§3).
4. **Ranked RoS list** — the position-stratified table of RoS rows, the
   `.winner-ladder` / `.winner-row` grid idiom applied to RoS (§4). This is the
   primary surface, and the one optimized for the 13" iPad.
5. **Skip-loud footer** — count of players excluded with a `reason` (the
   honest-data invariant made visible), using the `.empty-state` hook classes.

A `.tip-btn` + `.tip-popover` (existing components) sits on the section heading and
explains the method: *"RoS VOR = projected points over remaining non-bye weeks,
minus replacement level at the position. Higher = scarcer."* No methodology text
clutters the rows themselves.

---

## 3. The RoS value **chip** (compact summary)

The chip is the atomic RoS unit — a horizontal-scroll strip of the biggest RoS
risers, and the embeddable summary for other views. Built directly on the proven
`.mover-chip` markup (`biggest-movers.js`), extended with a floor→ceil micro-band.

```
┌──────────────┐
│ Bijan R. RB  │   ← name (var(--text), 600)
│ ▲ +42.7 VOR  │   ← RoS VOR, delta-up/down color (--good / --bad)
│ 159 pts ·11g │   ← RoS median points · games left (--text-muted, tabular-nums)
│ ▁▂▃▅▆ 121–201│   ← floor→ceil micro-band (reuses .xg-bar / track fill idiom)
└──────────────┘
```

- **Value color** = sign of VOR vs position replacement: positive → `--good`,
  near-replacement → `--text-muted`, negative → `--bad`. Arrow glyphs `▲ / ▼`
  reuse `.delta-up` / `.delta-down` (already in `styles.css`).
- **Floor→ceil band** = a 4px `.ros-band` track (clone of `.pos-bars .track` +
  `.fill`) with the median as a 2px tick — a one-glance uncertainty read without a
  chart library. Sparkline of weekly projection reuses `.sparkline-line`.
- **Numbers are `font-variant-numeric: tabular-nums`** so columns don't jitter as
  you scroll (the repo's standing convention, see `.standings .num`).
- Chip is an `<a href="#/ros?pos=RB">` (or player deep-link) — `min-width:120px`,
  `min-height:88px`, a 44px+ target.

Null / skipped players **never render a chip** (they can't be ranked); they surface
only in the skip-loud footer with their `reason`.

---

## 4. The RoS **row** (ranked list — primary iPad surface)

The ranked list is the `.winner-ladder` grid idiom retargeted to RoS. One row per
player, position-stratified (a subheading per position, `.section h2` uppercase
style). CSS-grid columns so values align into scannable numeric rulers.

**402px (iPhone) — 6-column grid, one line:**

```
grid: 22px  1fr        44px    56px      64px       28px
      rank  name/pos   VOR     median    floor–ceil trend
      1     Bijan R.   +42.7   159       121–201    ▂▃▅▆
            RB · ATL              pts      band
```

- `rank` — `--text-muted`, 600 (as `.winner-rank`).
- `name/pos` — name `--text` 600 truncates with ellipsis (`min-width:0; overflow`),
  `pos · team` on a 11px `--text-muted` second line.
- `VOR` — the headline number, right-aligned, tabular-nums, colored by sign; this
  is the column the eye lands on. A thin left border tints the whole row by VOR
  band (`border-left:3px solid` in `--good`/`--text-muted`/`--bad`, the
  `home-match-row.is-fav` precedent).
- `median` — RoS projected points; `floor–ceil` — the band as a mini track under
  the number (same `.ros-band`). `trend` — weekly sparkline.
- Micro-indicators (only when non-neutral, so rows stay quiet): a SoS chip `⬆ easy
  sched` / `⬇ tough` (reuses `.upset-badge.sev-*` pill styling) and an availability
  dot (`.home-hero-dot`-style pulse only if `avail_prob < 0.9`, colored `--warn`).

**Row height ≥ 56px** (comfortable 44px+ tap plus the second line). Whole row is a
tappable link to the player's detail.

**Skip-loud rows:** a player with `ros_points: null` is **not** silently zeroed —
it renders greyed at the bottom of its position group with the `reason` in
`--text-muted` (`no remaining projections`), never a fabricated number. This is the
honest-data rule made visible in the UI.

---

## 5. Reads at 402px (iPhone) and 1032px (13" iPad)

The repo already bumps `.view` to `max-width:840px` at `≥1024px` and reflows grids
at `720px`. RoS extends that ladder; the iPad is the **primary** surface per the
STANDING RULE (`TEAM optimized for 13" iPad`).

**402px — iPhone (single column, thumb-first):**
- `.view` stays ≤760px → full-bleed single column.
- Chip strip scrolls horizontally (`-webkit-overflow-scrolling:touch`), ~3 chips
  visible, the existing `movers-strip` overflow affordance.
- Rows are the 6-col compact grid above; SoS/availability collapse to icons only.
- Filter is the native `<select>` dropdown (least vertical cost).
- Below **380px** the grid tightens exactly like the existing
  `@media (max-width:380px) .winner-row` rule (narrower rank/trend columns, 12px).

**1032px — 13" iPad (the money view):**
- `.ros-view` opts into `max-width: 980px` at `≥1024px` (one step past the app's
  840px) to use the iPad's width without going edge-to-edge.
- **Two-column masonry of position groups** — QB+TE in the left column, RB+WR in
  the right (CSS grid `grid-template-columns:1fr 1fr; gap:16px`), the
  `.composite-grid` / `.form-grid` two-up pattern already in `styles.css`. All four
  positions are visible without scrolling — the manager compares scarcity across
  positions at a glance, which is the whole point of RoS.
- Rows widen: the `floor–ceil` band and weekly sparkline get real width, and the
  SoS/availability micro-indicators render as **labeled pills** (`easy sched`,
  `Q — 78%`) instead of bare icons, since the space exists.
- Filter becomes a **segmented control** (reuse `.tab-bar .tab` styling, or the
  `.watch-filter.is-active` pill) instead of a dropdown — one-tap position
  switching on a device with room for it.
- Chip strip becomes a static **wrap** (`flex-wrap:wrap`) rather than a scroller —
  no hidden content on a wide screen.

One component tree, two layouts, entirely via existing media-query breakpoints and
token-driven grids — no device sniffing, no JS layout branching.

---

## 6. New CSS (all from existing tokens — appended to `app/styles.css`)

```css
/* ============================================================
   RoS value — chip strip + ranked rows. Tokens only; no new
   colors/fonts. iPhone 402px single-col → iPad 1032px two-up.
   ============================================================ */
.ros-view { }                                   /* inherits .view */
@media (min-width: 1024px) {
  .ros-view { max-width: 980px; }
  .ros-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
}

/* Chip strip — extends .movers-strip / .mover-chip */
.ros-strip { display: flex; gap: 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; }
@media (min-width: 1024px) { .ros-strip { flex-wrap: wrap; overflow: visible; } }
.ros-chip {
  flex: 0 0 auto; min-width: 120px; min-height: 88px;
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; text-decoration: none; color: var(--text); font-size: 12px;
}
.ros-chip .ros-name { font-weight: 600; }
.ros-chip .ros-vor  { font-weight: 700; font-variant-numeric: tabular-nums; }
.ros-chip .ros-sub  { color: var(--text-muted); font-variant-numeric: tabular-nums; }

/* floor→median→ceil band — clone of .pos-bars .track/.fill */
.ros-band { position: relative; height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; }
.ros-band .fill { position: absolute; height: 100%; background: color-mix(in srgb, var(--primary) 45%, transparent); }
.ros-band .tick { position: absolute; top: -1px; width: 2px; height: 6px; background: var(--text); }

/* Ranked rows — extends .winner-ladder / .winner-row */
.ros-list { display: grid; gap: 6px; }
.ros-row {
  display: grid; grid-template-columns: 22px 1fr 44px 56px 64px 28px; gap: 6px;
  align-items: center; padding: 10px 12px; min-height: 56px;
  background: var(--surface); border: 1px solid var(--border);
  border-left-width: 3px; border-radius: 10px; text-decoration: none;
  color: var(--text); font-size: 13px;
}
.ros-row.val-pos { border-left-color: var(--good); }
.ros-row.val-neu { border-left-color: var(--border); }
.ros-row.val-neg { border-left-color: var(--bad); }
.ros-row .ros-vor { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.ros-row.val-pos .ros-vor { color: var(--good); }
.ros-row.val-neg .ros-vor { color: var(--bad); }
.ros-row .ros-pts { text-align: right; font-variant-numeric: tabular-nums; }
.ros-row .ros-meta { font-size: 11px; color: var(--text-muted); }
.ros-row.is-skipped { opacity: 0.6; }
.ros-row.is-skipped .ros-reason { grid-column: 2 / -1; font-size: 11px; color: var(--text-muted); }

@media (max-width: 380px) {
  .ros-row { grid-template-columns: 18px 1fr 40px 48px 52px 24px; font-size: 12px; padding: 8px; }
}
```

Dark mode is automatic: every value is a token that already has a
`:root[data-theme='dark']` counterpart in `styles.css`.

---

## 7. Accessibility & honesty (AA, matches repo rules)

- **Contrast:** all text/number colors are existing AA-verified tokens
  (`--good`/`--warn`/`--bad`/`--text` already documented AA in `styles.css`). Value
  is **never conveyed by color alone** — the `▲/▼` glyph and the numeric sign
  carry it too (color-blind safe).
- **Touch:** chips ≥88px tall, rows ≥56px, filter ≥44px — the repo's 44pt floor.
- **Numbers:** `tabular-nums` everywhere so ranked columns stay aligned.
- **Skip-loud:** null RoS renders a visible `reason`, greyed, never a zero;
  screen-reader text `aria-label="excluded: no remaining projections"`. The
  skip-loud footer counts them so absence is loud, not silent.
- **No market data on the surface** — the RoS view imports no odds/price source
  (enforced by the engine's regression test); nothing on screen implies price is a
  model input.

## 8. Handoff to build

1. Add `case 'ros'` to `app/main.js`, `renderRosView` in new `app/views/ros-view.js`.
2. New `app/components/ros-chip.js` (chip + strip), consumed by the view and later
   embeddable on `team-detail.js`.
3. Append §6 CSS to `app/styles.css` under the RoS banner.
4. Data comes from `app/ros-value.js` / `data/ros_value.json` (architect + tech
   design docs) — this doc consumes those fields (`ros_vor`, `ros_points`
   floor/median/ceil, `games_left`, `bye_week`, `skipped`) and adds no new ones.
5. Playwright: a `tests/ux` spec asserts the RoS route renders rows at 402px and the
   two-up group layout at 1032px, and that a `skipped` player shows its reason.
</content>
</invoke>
