/* tests/feature/r35_polish.test.mjs — the R35 polish set, pinned.
 *
 * Three display-only changes, chosen by the owner as the lowest-risk items on
 * the board. Display-only is not assert-free: R27's stale card text and R31's
 * dark-chrome mismatch were both "just display" too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { myRosterIds, renderRosterBadge } from '../../app/views/players.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/* ==========================================================================
   1. The browser chrome matches the HIG page it frames
   ========================================================================== */

test('theme-color metas carry the exact HIG --bg tokens, per scheme', () => {
  const html = read('index.html');
  const metas = [...html.matchAll(
    /<meta name="theme-color"(?: media="\(prefers-color-scheme: (light|dark)\)")? content="([^"]+)"/g,
  )].map((m) => ({ scheme: m[1] || null, content: m[2] }));
  assert.equal(metas.length, 2, 'one media-scoped tag per scheme');
  assert.equal(metas.find((m) => m.scheme === 'light')?.content, '#F2F2F7',
    'light chrome = systemGroupedBackground, the page HIG paints');
  assert.equal(metas.find((m) => m.scheme === 'dark')?.content, '#000000',
    'dark chrome = systemBackground');

  // The tokens must MATCH theme-hig.css, not merely equal today's constants —
  // if the theme repaints its page, the chrome must be changed with it or this
  // fails the build instead of shipping a mismatched band.
  const hig = read('app/theme-hig.css');
  assert.match(hig, /--bg:\s*#F2F2F7/i, 'light --bg token moved — update the theme-color metas');
  assert.match(hig, /--bg:\s*#000000/i, 'dark --bg token moved — update the theme-color metas');
});

test('the manifest matches HIG dark and stopped claiming dark-only', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.theme_color, '#000000');
  assert.equal(m.background_color, '#000000');
  assert.ok(!/dark-only/i.test(m.description),
    'HIG follows the system scheme; "dark-only" is a retired claim');
});

/* ==========================================================================
   2. ON MY ROSTER badge — PLAYERS reports the roster TEAM owns
   ========================================================================== */

test('myRosterIds reads the TEAM slots defensively and never writes', () => {
  const src = read('app/views/players.js');
  // Reads the same key TEAM persists; a second spelling here is how the two
  // tabs would drift apart.
  assert.match(src, /nfl2026\.team\.v1/);
  assert.ok(!/localStorage\.setItem\(\s*'nfl2026\.team\.v1'/.test(src),
    'PLAYERS only reports the roster — TEAM owns every write');
});

test('the badge renders for a rostered id and nothing otherwise', () => {
  assert.equal(renderRosterBadge(false), '', 'no roster claim without a seat');
  const html = renderRosterBadge(true);
  assert.match(html, /ON MY ROSTER/);
  assert.match(html, /p-lgx--mine/);
});

test('corrupt or absent roster storage is an empty set, not a throw', () => {
  // Node has no localStorage: the read path must survive that too — the same
  // guard that covers Safari private mode covers this test environment, which
  // is exactly the point.
  const ids = myRosterIds();
  assert.ok(ids instanceof Set);
  assert.equal(ids.size, 0);
});

test('the badge is inked with the small-text tier in HIG', () => {
  // theme.css inks the badge with --brand (5.15:1 on the Broadcast bg — AA
  // small passes there). In HIG, --brand is the 3:1 fills tier and would FAIL
  // AA for an 11px badge; the override must ride --brand-txt, the 4.5:1 tier.
  const hig = read('app/theme-hig.css');
  const rule = hig.match(/\[data-theme="hig"\] \.p-lgx--mine \{[\s\S]*?\}/);
  assert.ok(rule, 'HIG must restyle the badge — base --brand ink fails AA small there');
  assert.match(rule[0], /var\(--brand-txt\)/);
});

/* ==========================================================================
   3. The auction result sheet names its buyers
   ========================================================================== */

test('the result card renders a per-team ledger through seatLabel', () => {
  const src = read('app/views/team.js');
  const card = src.match(/function auctionResultHtml\(\) \{[\s\S]*?\n  \}/);
  assert.ok(card, 'auctionResultHtml present');
  assert.match(card[0], /seatLabel\(/,
    'the ledger must use the same seat names R34 put on the budget editor — '
    + 'a second name source is how a room comes to call one team two things');
  assert.match(card[0], /startersTotal\(/,
    'per-team points come from the same startersTotal the score sheet uses');
  assert.match(card[0], /teamBudgets/,
    'spend is measured from the R27 per-team STARTING budgets, not the league default');
});
