/* tests/feature/r30b_theme.test.mjs — R30b theme repairs, pinned (Agent: R30b).
 *
 * PURE node:test. NO browser, NO dependencies — runs inside the FAST gate
 * (`node --test tests/feature/*.mjs`).
 *
 * Locks the three major R30 CSS/a11y findings plus the ROOM-ledger layout fix:
 *
 * 1. `ipad-layout-a11y-undefined-line-token` — three rules referenced
 *    `var(--line)`, a token defined NOWHERE, so the declaration was invalid at
 *    computed-value time and the borders (including the SOLD-price input's only
 *    visual affordance) silently never painted. The general lesson is bigger
 *    than one token, so the gate here is general: EVERY fallback-less `var(--x)`
 *    in app/theme.css must have a `--x:` definition in that same file. The next
 *    undefined token fails this test by name.
 *
 * 2. `ipad-layout-a11y-model-bars-below-non-text-contrast` — the MODEL tab's
 *    .cal-bar--exp and .bt-bar fills measured 1.36:1 / 1.14:1 on the card.
 *    They are width-encoded data, so WCAG 1.4.11 holds them to 3.0:1. This
 *    test PARSES the shipped rules (the contrast_aa_hig.test.mjs idiom — the
 *    audit can only ever be about the CSS that ships), resolves the fill
 *    tokens, and asserts every fill either bar chart uses clears 3.0:1 on
 *    --surface. contrast_aa.test.mjs is deliberately frozen (its token table
 *    is the audited reference), so the new pairs are pinned here, not there.
 *
 * 3. `ipad-layout-a11y-view-is-one-giant-live-region` — #view must never be
 *    aria-live (every partial repaint queued the whole subtree for
 *    announcement); targeted announcements go through the dedicated
 *    visually-hidden #announce outlet instead.
 *
 * 4. ROOM ledger (.auc-team) — five near-equal fr tracks squeezed cells below
 *    their content at the 13" widths, wrapping every row. The repaired grid
 *    sizes the bounded columns to content; this pins that shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS_RAW = readFileSync(join(REPO_ROOT, 'app', 'theme.css'), 'utf8');
const HTML = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');

/* Comments can legally mention tokens that do not exist; strip them before any
   reference/definition scan so prose can never satisfy (or fail) the gate. */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---- WCAG relative-luminance contrast --------------------------------------
 * Same formula as contrast_aa.test.mjs / contrast_aa_hig.test.mjs. Duplicated
 * ON PURPOSE (their stated rule): an auditor that imports its maths from the
 * thing next door is one edit away from auditing nothing. */
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

const AA_LARGE = 3.0; // UI graphics / non-text contrast (WCAG 1.4.11)

/* ---- tiny CSS helpers (brace counter, not a lazy regex) ------------------- */
function blockOf(selector) {
  // First rule whose selector list contains `selector` exactly as one entry.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    const parts = m[1].split(',').map((s) => s.trim());
    if (parts.includes(selector)) return m[2];
  }
  assert.fail(`selector not found in app/theme.css: ${selector}`);
  return '';
}

/** The :root token table, as { name: '#hex' } (hex-valued tokens only). */
function rootTokens() {
  const block = blockOf(':root');
  const out = {};
  const re = /--([A-Za-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2];
  return out;
}

/** Resolve `background: var(--x)` inside a rule block to its :root hex. */
function fillToken(block, tokens, where) {
  const m = /background\s*:\s*var\(\s*--([A-Za-z0-9-]+)\s*\)/.exec(block);
  assert.ok(m, `${where}: expected a plain \`background: var(--token)\` fill`);
  const name = m[1];
  assert.ok(tokens[name], `${where}: fill token --${name} is not a :root hex token`);
  return name;
}

/* =============================================================================
 * 1 · Every fallback-less var(--x) reference has a definition in theme.css.
 * ========================================================================== */
test('theme.css: every var(--x) without a fallback is a defined token', () => {
  // Definitions: any `--name:` declaration anywhere in the file (:root, media
  // blocks, component rules). JS never calls setProperty in this app, so the
  // stylesheet itself is the complete universe of definitions.
  const defined = new Set();
  {
    const re = /(^|[{;])\s*--([A-Za-z0-9-]+)\s*:/g;
    let m;
    while ((m = re.exec(CSS)) !== null) defined.add(m[2]);
  }
  assert.ok(defined.has('border'), 'sanity: --border must be defined in :root');

  // References WITHOUT a fallback: `var(--x)` closed immediately, no comma.
  // (`var(--x, fallback)` is the deliberate defensive idiom and is exempt —
  // its behavior is defined; a fallback-less miss is IACVT, i.e. the bug.)
  const offenders = new Set();
  const re = /var\(\s*--([A-Za-z0-9-]+)\s*\)/g;
  let m;
  while ((m = re.exec(CSS)) !== null) {
    if (!defined.has(m[1])) offenders.add(m[1]);
  }
  assert.deepEqual(
    [...offenders],
    [],
    'app/theme.css references undefined custom propert(ies) with no fallback ' +
      '(the declaration is invalid at computed-value time and silently paints ' +
      `nothing): --${[...offenders].join(', --')}`,
  );
});

test('theme.css: the phantom --line token stays gone (R30 finding, by name)', () => {
  // The three repaired rules must carry the app border idiom, and no rule may
  // reach for --line again (it was never in the LOCKED token block).
  assert.ok(!/--line\b/.test(CSS), 'a rule references --line again');
  for (const sel of ['.tb-panel', '.tb-cell']) {
    assert.match(
      blockOf(sel),
      /border\s*:\s*1px solid var\(--border\)/,
      `${sel} lost its 1px solid var(--border) hairline`,
    );
  }
  assert.match(
    blockOf('.auc-soldprice'),
    /border-bottom\s*:\s*1px solid var\(--border\)/,
    '.auc-soldprice (LIVE SOLD-price input) lost its border-bottom affordance',
  );
});

/* =============================================================================
 * 2 · MODEL bar-chart fills: >= 3.0:1 on the card (WCAG 1.4.11).
 * ========================================================================== */
test('MODEL bars: every fill .cal-bar--exp/.bt-bar ship clears 3.0:1 on --surface', () => {
  const tokens = rootTokens();
  assert.ok(tokens.surface, ':root --surface not found');

  // The two fills the R30 finding caught invisible, plus their highlighted
  // partners — the whole chart is pinned so neither series can regress alone.
  const fills = [
    ['.cal-bar--exp', fillToken(blockOf('.cal-bar--exp'), tokens, '.cal-bar--exp')],
    ['.cal-bar--act', fillToken(blockOf('.cal-bar--act'), tokens, '.cal-bar--act')],
    ['.bt-bar', fillToken(blockOf('.bt-bar'), tokens, '.bt-bar')],
    [
      '.bt-row--best .bt-bar',
      fillToken(blockOf('.bt-row--best .bt-bar'), tokens, '.bt-row--best .bt-bar'),
    ],
  ];
  for (const [rule, name] of fills) {
    const ratio = contrast(tokens[name], tokens.surface);
    assert.ok(
      ratio >= AA_LARGE,
      `AA FAIL: ${rule} fill --${name} (${tokens[name]}) on --surface ` +
        `(${tokens.surface}) = ${ratio.toFixed(2)}:1, needs >= ${AA_LARGE.toFixed(1)}:1 ` +
        '(width-encoded data bar, WCAG 1.4.11)',
    );
  }

  // The two series of each chart must remain DIFFERENT fills, or the
  // comparison the charts exist for disappears even at perfect contrast.
  assert.notEqual(fills[0][1], fills[1][1], 'calibration exp/act fills collapsed into one');
  assert.notEqual(fills[2][1], fills[3][1], 'backtest best/rest fills collapsed into one');
});

/* =============================================================================
 * 3 · #view is not a live region; #announce is the dedicated outlet.
 * ========================================================================== */
test('index.html: #view carries no aria-live; #announce is the scoped outlet', () => {
  const view = /<main\b[^>]*id="view"[^>]*>/.exec(HTML);
  assert.ok(view, 'index.html: <main id="view"> not found');
  assert.ok(
    !/aria-live/.test(view[0]),
    '#view is aria-live again — every partial repaint (search debounce, draft ' +
      'pick) would queue its entire subtree for screen-reader announcement',
  );
  // Route changes stay announced via focus: the region must keep tabindex=-1.
  assert.match(view[0], /tabindex="-1"/, '#view lost tabindex="-1" (route focus target)');

  const announce = /<div\b[^>]*id="announce"[^>]*>/.exec(HTML);
  assert.ok(announce, 'index.html: dedicated #announce live region is missing');
  assert.match(announce[0], /aria-live="polite"/, '#announce is not aria-live=polite');
  assert.match(announce[0], /class="[^"]*\bvisually-hidden\b[^"]*"/,
    '#announce is not visually hidden');

  // The utility must hide visually WITHOUT removing the node from rendering —
  // display:none / visibility:hidden would silence the live region.
  const vh = blockOf('.visually-hidden');
  assert.match(vh, /position\s*:\s*absolute/, '.visually-hidden must be the clip pattern');
  assert.ok(!/display\s*:\s*none/.test(vh), '.visually-hidden uses display:none (mutes SRs)');
  assert.ok(!/visibility\s*:\s*hidden/.test(vh), '.visually-hidden uses visibility:hidden');
});

/* =============================================================================
 * 4 · ROOM ledger grid: content-sized columns, not five equal squeezed tracks.
 * ========================================================================== */
test('.auc-team ledger: bounded columns are content-sized (no per-row wrapping)', () => {
  const block = blockOf('.auc-team');
  const m = /grid-template-columns\s*:\s*([^;]+);/.exec(block);
  assert.ok(m, '.auc-team lost its grid-template-columns');
  const tracks = m[1].trim();
  // The regression shape was equal minmax(0,1fr) tracks: every cell narrower
  // than its bounded content ("max $200", "QB RB") at the 13" zone widths.
  assert.ok(
    /max-content/.test(tracks),
    `.auc-team tracks are not content-aware again: "${tracks}"`,
  );
  assert.ok(
    !/minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/.test(tracks),
    `.auc-team back to adjacent equal-fr tracks (the squeezed-ledger bug): "${tracks}"`,
  );
});
