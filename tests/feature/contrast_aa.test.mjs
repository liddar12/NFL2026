/* tests/feature/contrast_aa.test.mjs — WCAG AA / ADA contrast gate (Agent D).
 *
 * PURE node:test. NO browser, NO dependencies — this runs inside the FAST gate
 * (`node --test tests/feature/*.mjs`) so it must stay on Node built-ins only.
 *
 * WHY THIS EXISTS: the design is dark-only and AA contrast is a HARD, non-
 * negotiable product requirement (see the build contract). The locked token set
 * in app/theme.css was hand-audited; this test re-implements the WCAG 2.x
 * relative-luminance contrast formula and PROVES, per pairing, that:
 *   - body/label text meets 4.5:1,
 *   - large text (>=18px or >=14px bold), UI graphics (bar fills, markers) and
 *     the focus ring meet 3.0:1.
 * It also imports app/teams.js and asserts every team `tint` clears 3.0:1 on
 * --surface (large bold `.team-ab`), so the app and the test can never drift.
 *
 * If ANY pairing fails, the failure message names the offending pair, the
 * measured ratio, and the threshold — so a regression is diagnosable at a glance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../../app/teams.js';

/* ---- LOCKED TOKENS (verbatim from the build contract / app/theme.css) ------
 * Kept here as literals ON PURPOSE: this test is the independent auditor. If a
 * token in theme.css is edited, the audited value here is the reference the CSS
 * must match. Team tints are the ONE exception — those are imported from
 * app/teams.js (below) so the registry is the single source of truth. */
const T = Object.freeze({
  bg: '#0D1117',
  surface: '#161B22',
  'surface-2': '#1F2630',
  elev: '#232C38',
  border: '#2A3340',
  ink: '#F0F3F8',
  muted: '#B0BDCC',
  brand: '#4A90C2',
  'brand-txt': '#78B4DE',
  accent: '#E35A61',
  'accent-txt': '#F08A8F',
  home: '#4288DB',
  'home-txt': '#6FB0F0',
  away: '#BE7E34',
  'away-txt': '#E0A64A',
  pos: '#56C168',
  'pos-txt': '#6FD182',
  warn: '#E0B75D',
  neg: '#E35A61',
});

/* WCAG thresholds. */
const AA_TEXT = 4.5; // body/label text
const AA_LARGE = 3.0; // large text, UI graphics, focus indicators

/* ---- WCAG relative-luminance contrast formula ------------------------------
 * https://www.w3.org/WAI/GL/wiki/Relative_luminance and the contrast-ratio def
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio . Implemented from scratch
 * (no color library) so the gate stays dependency-free. */

/** Parse "#RRGGBB" (or "#RGB") -> [r,g,b] each 0..255. */
function parseHex(hex) {
  const s = String(hex).trim().replace(/^#/, '');
  const full = s.length === 3 ? s.replace(/(.)/g, '$1$1') : s;
  assert.match(full, /^[0-9a-fA-F]{6}$/, `not a hex color: ${hex}`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** sRGB 8-bit channel -> linear-light component (WCAG gamma expansion). */
function linearize(channel8) {
  const c = channel8 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance L of an sRGB color (0 = black, 1 = white). */
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colors: (L_light + 0.05) / (L_dark + 0.05). */
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Assert a single pairing clears its threshold, naming both tokens, the measured
 * ratio and the requirement in the failure message.
 */
function assertContrast(fgName, bgName, threshold) {
  const fg = T[fgName] ?? fgName; // allow raw hex (team tints) too
  const bg = T[bgName] ?? bgName;
  const ratio = contrast(fg, bg);
  assert.ok(
    ratio >= threshold,
    `AA FAIL: "${fgName}" (${fg}) on "${bgName}" (${bg}) = ` +
      `${ratio.toFixed(2)}:1, needs >= ${threshold.toFixed(1)}:1`,
  );
}

/* ---- Sanity: the formula itself (known WCAG reference values) -------------- */
test('contrast formula matches WCAG reference values', () => {
  // Black on white is the canonical 21:1 maximum.
  assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21);
  // A color against itself is 1:1.
  assert.equal(Math.round(contrast('#4A90C2', '#4A90C2')), 1);
  // Symmetric: order of args must not change the ratio.
  assert.equal(
    contrast(T.ink, T.bg).toFixed(6),
    contrast(T.bg, T.ink).toFixed(6),
  );
});

/* ---- Body / label text: >= 4.5:1 ------------------------------------------ */
test('ink (body text) meets 4.5:1 on every background layer', () => {
  for (const bg of ['bg', 'surface', 'surface-2', 'elev']) {
    assertContrast('ink', bg, AA_TEXT);
  }
});

test('muted (secondary text) meets 4.5:1 on bg/surface/surface-2', () => {
  for (const bg of ['bg', 'surface', 'surface-2']) {
    assertContrast('muted', bg, AA_TEXT);
  }
});

test('colored -txt labels meet 4.5:1 on surface AND bg', () => {
  // These are the SMALL-text colored variants (win-prob %, links, EV, edges).
  const txtTokens = [
    'home-txt',
    'away-txt',
    'brand-txt',
    'accent-txt',
    'pos-txt',
  ];
  for (const fg of txtTokens) {
    assertContrast(fg, 'surface', AA_TEXT);
    assertContrast(fg, 'bg', AA_TEXT);
  }
});

test('warn (stale/degraded health text) meets 4.5:1 on surface', () => {
  // The health chip note sits on --surface; warn is documented AA on surface.
  assertContrast('warn', 'surface', AA_TEXT);
});

/* ---- REL17 availability chip (.av-chip / .av-prov) ------------------------ */
test('availability chip text meets 4.5:1 on every surface it sits on', () => {
  // .av-chip has background: var(--surface-2) and also renders inside .card
  // (--surface) and on elevated rows. All of it is small mono text, so the 4.5:1
  // body threshold applies — there is no "large text" escape hatch here.
  assertContrast('accent-txt', 'surface-2', AA_TEXT); // .av-chip--out
  assertContrast('accent-txt', 'surface', AA_TEXT);   // chip inside .card
  assertContrast('accent-txt', 'elev', AA_TEXT);      // chip on an elevated row
  assertContrast('warn', 'surface-2', AA_TEXT);       // .av-chip--watch (Q / D)
  assertContrast('brand-txt', 'surface-2', AA_TEXT);  // .av-prov--report ("REPORT")
  assertContrast('muted', 'surface-2', AA_TEXT);      // .av-prov--min ("LEAGUE MIN")
});

test('--accent is FORBIDDEN as availability chip text, legal only as a border', () => {
  // The design bans the base --accent as chip TEXT because it measures below AA.
  // This pins the reason: if someone reaches for it as text, this is the proof it
  // fails; it IS legal as the 3px .lu-row--forced / .lu-forced left border, which
  // is a graphic held to 3.0:1.
  assert.ok(
    contrast(T.accent, T['surface-2']) < AA_TEXT,
    '--accent unexpectedly clears 4.5:1 on --surface-2; revisit the chip-text ban',
  );
  assert.ok(
    contrast(T.accent, T.elev) < AA_TEXT,
    '--accent unexpectedly clears 4.5:1 on --elev; revisit the chip-text ban',
  );
  assertContrast('accent', 'surface-2', AA_LARGE); // border graphic: >= 3:1
});

/* ---- Large text: >= 3.0:1 ------------------------------------------------- */
test('brand/accent as LARGE text meet 3.0:1 on bg', () => {
  // --brand and --accent are display/heading-only (large). 3:1 suffices.
  assertContrast('brand', 'bg', AA_LARGE);
  assertContrast('accent', 'bg', AA_LARGE);
});

test('active pill: dark ink (#0D1117) on solid --brand meets 3.0:1 (large bold)', () => {
  // .scopeseg / .scoreseg active pills: solid --brand background with dark
  // BOLD ink (#0D1117 = --bg). Bold >=14px qualifies as large text, so the
  // 3.0:1 threshold applies; the pair measures 5.46:1. Locked here so neither
  // token can drift the pill below AA.
  assertContrast('bg', 'brand', AA_LARGE); // #0D1117 ink on #4A90C2 pill
});

/* ---- UI graphics (bar fills, markers): >= 3.0:1 --------------------------- */
test('win-prob / EV bar fills meet 3.0:1 on surface', () => {
  // .seg--home/.seg--away and pos/accent markers render ON the card (--surface).
  for (const fill of ['home', 'away', 'accent', 'pos']) {
    assertContrast(fill, 'surface', AA_LARGE);
  }
});

/* ---- Focus ring: >= 3.0:1 (WCAG 2.4.11 non-text contrast) ----------------- */
test('accent focus ring meets 3.0:1 on bg and surface', () => {
  assertContrast('accent', 'bg', AA_LARGE);
  assertContrast('accent', 'surface', AA_LARGE);
});

/* ---- Team tints: imported from app/teams.js, >= 3.0:1 on --surface -------- */
test('every team tint clears 3.0:1 on --surface (large bold .team-ab)', () => {
  const surface = T.surface; // #161B22
  const offenders = [];
  for (const [ab, team] of Object.entries(TEAMS)) {
    const ratio = contrast(team.tint, surface);
    if (ratio < AA_LARGE) {
      offenders.push(`${ab} (${team.tint}) = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `AA FAIL: team tint(s) below 3.0:1 on --surface (${surface}): ` +
      offenders.join(', '),
  );
});

/* ---- R21-B2 players playoff-SoS + market-value chips ---------------------- */
test('playoff-SoS + market-value chips meet AA on the player card (R21-B2)', () => {
  // Both chips render on .card.player (--surface) in 10-11px mono — SMALL text,
  // so every ink here is held to 4.5:1. There is no large-text escape hatch.
  //   .posos-lbl / .p-posos--even .posos-word / .pv-lbl / .pv-none  -> muted
  //   .posos-num                                                    -> ink
  //   .p-posos--easy .posos-word                                    -> pos-txt
  //   .p-posos--hard .posos-word                                    -> accent-txt
  //   .pv-us                                                        -> brand-txt
  //   .pv-mkt                                                       -> ink
  //   .ms-badge (reused verbatim)                                   -> muted
  for (const fg of ['muted', 'ink', 'pos-txt', 'accent-txt', 'brand-txt']) {
    assertContrast(fg, 'surface', AA_TEXT);
  }
  // The bye pill fills itself with --surface-2 and sits on the card, so its ink
  // is audited against the pill, not the card.
  assertContrast('warn', 'surface-2', AA_TEXT);   // .posos-bye text + glyph
  assertContrast('muted', 'surface-2', AA_TEXT);  // .pb-n games count

  // Meter fills and the bye pill's 1px edge are GRAPHICS: 3.0:1 (WCAG 1.4.11).
  // --brand is the .po-seg--on default (matching .sos-seg--on) and had never
  // been pinned on --surface before; --muted is the "even" fill.
  for (const fill of ['brand', 'pos', 'accent', 'muted']) {
    assertContrast(fill, 'surface', AA_LARGE);
  }
  assertContrast('warn', 'surface-2', AA_LARGE);  // .posos-bye border
});

/* ---- R19-R23 UI: the token pairings the new panels introduced -------------
 * These all MEASURE fine today. They are locked here because until now nothing
 * pinned them, so a future token nudge could quietly drop a shipped surface
 * below AA with the gate still green — which is precisely how a contrast
 * regression ships. Every pairing names the app/theme.css rule it comes from. */

test('--elev panels: every ink that sits on them meets 4.5:1', () => {
  // --elev had only ever been audited for `ink` and `accent-txt`. Three shipped
  // rules put OTHER inks on it, all small text (9-11px), so there is no
  // large-text escape hatch:
  //   .lp-rep-cell { background: var(--elev) } + .ds-lbl { color: var(--muted) }
  //     -> league-profile replacement-level cells, 9px mono label   (7.39:1)
  //   .ds-hnoise / .ds-hpos { background: var(--elev); color: var(--muted) }
  //     -> draft-room history pills, 11px mono                      (7.39:1)
  //   .ds-hpos--early { color: var(--brand-txt) } on that same pill (6.30:1)
  assertContrast('muted', 'elev', AA_TEXT);
  assertContrast('brand-txt', 'elev', AA_TEXT);
});

test('.lp-savebtn--dirty: dark ink on solid --accent meets 4.5:1', () => {
  // The unsaved-edits state of SAVE LEAGUE SETTINGS swaps the brand fill for
  // --accent, keeping #0D1117 (= --bg) ink. The button is 13px/800 — bold, but
  // WCAG large text starts at 18.66px bold, so this is held to the FULL 4.5:1
  // body threshold, not the 3.0:1 the .scopeseg pill gets by size. It measures
  // 5.32:1, so the stricter pin is the honest one to lock.
  assertContrast('bg', 'accent', AA_TEXT);
});

test('team registry is non-empty and every tint is a valid hex', () => {
  const entries = Object.entries(TEAMS);
  assert.ok(entries.length > 0, 'TEAMS registry is empty');
  for (const [ab, team] of entries) {
    assert.match(
      team.tint,
      /^#[0-9a-fA-F]{6}$/,
      `team ${ab} has a malformed tint: ${team.tint}`,
    );
  }
});
