/* tests/feature/contrast_aa_hig.test.mjs — WCAG AA gate for the R31 HIG theme.
 *
 * PURE node:test. NO browser, NO dependencies — this runs inside the FAST gate
 * (`node --test tests/feature/*.mjs`) alongside contrast_aa.test.mjs.
 *
 * WHY THIS EXISTS, SEPARATELY FROM contrast_aa.test.mjs
 * That file is the auditor for the Broadcast theme, and it works by holding the
 * audited token values as LITERALS: the test is the reference, the CSS must
 * match it. app/theme-hig.css adds a SECOND, opt-in palette — a full light set
 * plus a full `prefers-color-scheme: dark` set — and every pairing in it has to
 * clear the same bar. Rather than edit the Broadcast auditor (it is deliberately
 * frozen), this is its sibling.
 *
 * The one deliberate difference in method: this test PARSES app/theme-hig.css
 * and audits the values it actually finds there. The HIG palette is two full
 * sets of ~20 tokens with a dark set that inherits from the light one, and a
 * hand-copied literal table of forty-odd colors is a table that will silently
 * drift from the stylesheet. Parsing means the audit can only ever be about the
 * CSS that ships.
 *
 * WHY SOME APPLE HEXES ARE NOT APPLE'S HEXES: several UIKit semantic colors do
 * not clear 4.5:1 at the sizes this app uses them (secondaryLabel is ~3.5:1 on
 * white; systemBlue is 4.02:1 on white). The stylesheet documents each
 * adjustment at the token; this test is what proves the adjustment worked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(join(REPO_ROOT, 'app', 'theme-hig.css'), 'utf8');

/* ---- WCAG thresholds (identical to the Broadcast auditor) ----------------- */
const AA_TEXT = 4.5; // body / label text
const AA_LARGE = 3.0; // large text, UI graphics, focus indicators

/* ---- WCAG relative-luminance contrast, reimplemented from the spec --------
 * Same formula as contrast_aa.test.mjs. Duplicated ON PURPOSE: an auditor that
 * imports its own maths from the thing next door is one edit away from auditing
 * nothing. https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio */
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
function linearize(channel8) {
  const c = channel8 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ---- read the two token blocks straight out of the stylesheet -------------
 * Both blocks open with the same selector; the first is the light palette at
 * top level, the second is inside @media (prefers-color-scheme: dark). A brace
 * counter is used rather than a lazy regex so a nested rule could never end the
 * block early. */
function blockAt(css, startIndex) {
  const open = css.indexOf('{', startIndex);
  assert.ok(open > -1, 'token block has no opening brace');
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in app/theme-hig.css');
}

/** All `--name: #hex;` declarations in a block, as { name: hex } (no leading --). */
function hexTokens(block) {
  const out = {};
  const re = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
  return out;
}

const SELECTOR = ':root[data-theme="hig"]';
const firstAt = CSS.indexOf(SELECTOR);
const secondAt = CSS.indexOf(SELECTOR, firstAt + SELECTOR.length);
assert.ok(firstAt > -1, 'app/theme-hig.css: light token block not found');
assert.ok(secondAt > -1, 'app/theme-hig.css: dark token block not found');

const LIGHT = hexTokens(blockAt(CSS, firstAt));
// The dark block only RESTATES what changes, so it inherits the light values
// for everything it leaves alone — exactly as the cascade does at runtime.
const DARK = { ...LIGHT, ...hexTokens(blockAt(CSS, secondAt)) };

const SCHEMES = [
  ['light', LIGHT],
  ['dark', DARK],
];

/** Assert one pairing, naming both tokens, the measured ratio and the rule. */
function assertContrast(scheme, T, fgName, bgName, threshold, why) {
  const fg = T[fgName];
  const bg = T[bgName];
  assert.ok(fg, `${scheme}: token --${fgName} missing from app/theme-hig.css`);
  assert.ok(bg, `${scheme}: token --${bgName} missing from app/theme-hig.css`);
  const ratio = contrast(fg, bg);
  assert.ok(
    ratio >= threshold,
    `AA FAIL (${scheme}, HIG theme): "${fgName}" (${fg}) on "${bgName}" (${bg}) = ` +
      `${ratio.toFixed(2)}:1, needs >= ${threshold.toFixed(1)}:1 — ${why}`,
  );
}

/* Sanity: the parse actually found a palette, not an empty object. */
test('HIG theme: both token blocks parse and carry a full palette', () => {
  for (const [scheme, T] of SCHEMES) {
    for (const name of ['bg', 'surface', 'surface-2', 'elev', 'ink', 'muted']) {
      assert.ok(T[name], `${scheme}: --${name} not found in app/theme-hig.css`);
    }
  }
  // Light and dark must actually differ, or the "full dark set" is a fiction.
  assert.notEqual(LIGHT.bg, DARK.bg, 'dark block does not override --bg');
  assert.notEqual(LIGHT.ink, DARK.ink, 'dark block does not override --ink');
});

/* ---- body / label text: >= 4.5:1 on every surface layer ------------------- */
const SURFACES = ['bg', 'surface', 'surface-2', 'elev'];

test('HIG: --ink (label) meets 4.5:1 on every surface layer', () => {
  for (const [scheme, T] of SCHEMES) {
    for (const bg of SURFACES) {
      assertContrast(scheme, T, 'ink', bg, AA_TEXT, 'body text');
    }
  }
});

test('HIG: --muted (secondaryLabel) meets 4.5:1 on every surface layer', () => {
  // This is the token that carries every 11-13px label in the app, including
  // the ones the theme puts on --elev (selected rows, pressed inserts), so it
  // is audited on all four layers rather than the Broadcast auditor's three.
  for (const [scheme, T] of SCHEMES) {
    for (const bg of SURFACES) {
      assertContrast(scheme, T, 'muted', bg, AA_TEXT, 'secondary label');
    }
  }
});

test('HIG: colored small-text tokens meet 4.5:1 on every surface layer', () => {
  const txtTokens = ['brand-txt', 'accent-txt', 'home-txt', 'away-txt', 'pos-txt'];
  for (const [scheme, T] of SCHEMES) {
    for (const fg of txtTokens) {
      for (const bg of SURFACES) {
        assertContrast(scheme, T, fg, bg, AA_TEXT, 'small colored text');
      }
    }
  }
});

test('HIG: --warn reads as TEXT on the surfaces the health chip uses', () => {
  for (const [scheme, T] of SCHEMES) {
    for (const bg of ['surface', 'surface-2', 'elev']) {
      assertContrast(scheme, T, 'warn', bg, AA_TEXT, 'stale/degraded health text');
    }
  }
});

/* ---- UI graphics (bar fills, meters, markers): >= 3.0:1 ------------------- */
test('HIG: bar fills and meter segments meet 3.0:1 on the card', () => {
  for (const [scheme, T] of SCHEMES) {
    for (const fill of ['home', 'away', 'accent', 'pos', 'brand', 'muted']) {
      assertContrast(scheme, T, fill, 'surface', AA_LARGE, 'graphic (WCAG 1.4.11)');
    }
  }
});

test('HIG: --brand and --accent clear 3.0:1 as large text / focus ring on --bg', () => {
  for (const [scheme, T] of SCHEMES) {
    assertContrast(scheme, T, 'brand', 'bg', AA_LARGE, 'tint as large text / focus ring');
    assertContrast(scheme, T, 'accent', 'bg', AA_LARGE, 'accent as large text');
  }
});

/* ---- the control tokens this theme had to invent -------------------------
 * app/theme.css hardcodes `color:#0D1117` on `background:var(--brand)` for
 * every solid pill. That pair is 5.46:1 in the Broadcast palette and about
 * 2.4:1 in the HIG light palette, so theme-hig.css re-inks all of them with
 * --hig-fill-ink on --hig-fill-solid. If that substitution were wrong the app
 * would ship an unreadable primary button, which is exactly the class of
 * regression this file exists to stop. */
test('HIG: prominent button — --hig-fill-ink on --hig-fill-solid meets 4.5:1', () => {
  for (const [scheme, T] of SCHEMES) {
    assertContrast(scheme, T, 'hig-fill-ink', 'hig-fill-solid', AA_TEXT,
      'ADD / SAVE / START / ENTER button label');
  }
});

test('HIG: tinted selected chip — --brand-txt on --hig-tint-soft meets 4.5:1', () => {
  // Selected week / position / sort chips, the selected tab, and .slot--active
  // all use this pairing. All small text, so no large-text escape hatch.
  for (const [scheme, T] of SCHEMES) {
    assertContrast(scheme, T, 'brand-txt', 'hig-tint-soft', AA_TEXT,
      'selected capsule chip and selected tab label');
  }
});

test('HIG: segmented-control thumb — --ink on --hig-thumb meets 4.5:1', () => {
  for (const [scheme, T] of SCHEMES) {
    assertContrast(scheme, T, 'ink', 'hig-thumb', AA_TEXT,
      'selected segment label (PPR / HALF / STD, BASE / AI+)');
  }
});

test('HIG: --hig-label-3 clears the 3:1 graphic bar on every surface layer', () => {
  // tertiaryLabel is Apple's placeholder/glyph gray. The stylesheet uses it for
  // ONE thing — the "@" that separates two teams on a game card — which is a
  // decorative glyph, so 3:1 is the applicable bar (WCAG 1.4.11). It is pinned
  // on all four layers rather than one, because a future rule that reaches for
  // it on an inset would otherwise be unaudited.
  for (const [scheme, T] of SCHEMES) {
    for (const bg of SURFACES) {
      assertContrast(scheme, T, 'hig-label-3', bg, AA_LARGE, 'decorative glyph');
    }
  }
});

/* ---- team tints on a LIGHT card ------------------------------------------
 * app/teams.js is tuned for a dark surface ("lightened to clear 3:1 on
 * --surface"), and those tints reach the DOM as inline style="color:#…", so the
 * HIG light theme corrects them with filter: brightness(--hig-tint-darken).
 * This re-derives that bound over the real registry: if a future team is added
 * with a paler tint, or the factor is nudged, this fails with the offender
 * named. The corrected tints carry SMALL text (.po-team, the abbreviation in
 * .cd-meta / .lu-meta), so the 4.5:1 bar applies, not the large-text 3:1. */
test('HIG light: every team tint clears 4.5:1 on the card AFTER --hig-tint-darken', async () => {
  const { TEAMS } = await import('../../app/teams.js');
  const block = blockAt(CSS, firstAt);
  const m = /--hig-tint-darken\s*:\s*([0-9.]+)\s*;/.exec(block);
  assert.ok(m, '--hig-tint-darken not found in the light token block');
  const factor = Number(m[1]);
  assert.ok(factor > 0 && factor <= 1, `--hig-tint-darken out of range: ${factor}`);

  // CSS filter: brightness(f) multiplies each sRGB channel by f.
  const darken = (hex) =>
    '#' + parseHex(hex)
      .map((c) => Math.round(c * factor).toString(16).padStart(2, '0'))
      .join('');

  const offenders = [];
  for (const [ab, team] of Object.entries(TEAMS)) {
    const ratio = contrast(darken(team.tint), LIGHT.surface);
    if (ratio < AA_TEXT) {
      offenders.push(`${ab} (${team.tint} -> ${darken(team.tint)}) = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `AA FAIL (light, HIG theme): team tint(s) below 4.5:1 on --surface ` +
      `(${LIGHT.surface}) after brightness(${factor}): ${offenders.join(', ')}`,
  );
});

test('HIG dark: every team tint clears 3.0:1 on the dark card, uncorrected', async () => {
  // The dark block sets --hig-tint-darken:1 (no correction), so the raw
  // registry has to stand on the HIG dark card (#1C1C1E) the same way it does
  // on the Broadcast one (#161B22, pinned in contrast_aa.test.mjs).
  const { TEAMS } = await import('../../app/teams.js');
  const darkBlock = blockAt(CSS, secondAt);
  assert.match(darkBlock, /--hig-tint-darken\s*:\s*1\s*;/,
    'dark block no longer disables the tint correction — re-audit this test');
  const offenders = [];
  for (const [ab, team] of Object.entries(TEAMS)) {
    const ratio = contrast(team.tint, DARK.surface);
    if (ratio < AA_LARGE) offenders.push(`${ab} (${team.tint}) = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(offenders, [],
    `AA FAIL (dark, HIG theme): team tint(s) below 3.0:1 on --surface ` +
      `(${DARK.surface}): ${offenders.join(', ')}`);
});

/* ---- the default theme must remain untouched by all of this --------------- */
test('theme-hig.css cannot affect the default theme: every rule is scoped', () => {
  // The product promise is that a user who never flips the switch sees exactly
  // what they saw before. That holds by CONSTRUCTION only if no selector in the
  // file can match without html[data-theme="hig"]. Strip comments and at-rule
  // headers, then check every remaining selector carries the scope.
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  // A selector is the text between a `}` (or start / `{` of an at-rule) and `{`.
  const re = /(^|[};])\s*([^{}@;]+?)\s*\{/g;
  let m;
  while ((m = re.exec(noComments)) !== null) {
    const selector = m[2].trim();
    if (!selector || selector.startsWith('@')) continue;
    // Keyframe stops ("from", "to", "42%") are not selectors.
    if (/^(from|to|[\d.]+%)$/.test(selector)) continue;
    for (const part of selector.split(',')) {
      const s = part.trim();
      if (!s) continue;
      if (!s.includes('[data-theme="hig"]')) offenders.push(s);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'app/theme-hig.css has UNSCOPED selector(s) — these would leak into the ' +
      `default Broadcast theme: ${offenders.join(' | ')}`,
  );
});
