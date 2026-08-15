/* tests/feature/r30c_minors.test.mjs — pins for the R30c minor tranche
 * (docs/qa/R30_RCA_FINDINGS.md, MINOR section), the last of the R30 audit.
 *
 * Two kinds of pin, both idioms this suite already uses:
 *
 *   1. RETIRED SENTENCES (the stale_text.test.mjs pattern) — copy that was
 *      false in production is asserted ABSENT with comments stripped, and the
 *      honest replacement is asserted PRESENT, so neither can quietly revert.
 *   2. MECHANISMS — the fixes that are wiring rather than words (memo key,
 *      RESET state clear, SAVE repaint, focus restore, announce region) are
 *      pinned against the source and, where a pure helper is reachable,
 *      against behaviour. team.js is a VIEW (its default export needs a DOM),
 *      so source-level assertions stand in where no helper is importable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { rosterShape } from '../../app/draft-sim.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
/** JS source with comments stripped — prose ABOUT a retired claim never trips. */
const prose = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
/** HTML with comments stripped, same reason. */
const html = (rel) => read(rel).replace(/<!--[\s\S]*?-->/g, ' ');

const TEAM = 'app/views/team.js';

/** The source of one `act === '<name>'` branch of team.js's onAction. */
function actBranch(src, name, nextName) {
  const start = src.indexOf(`act === '${name}'`);
  const end = src.indexOf(`act === '${nextName}'`);
  assert.ok(start >= 0 && end > start, `could not slice the ${name} branch`);
  return src.slice(start, end);
}

/* ==========================================================================
   1. OURS price memo key — derived from the priced shape, k/def included
   ========================================================================== */

test('the OURS memo key is derived from the shape fairDollars prices with', () => {
  /* The defect: the key hand-listed qb..bench and omitted k/def, so the K and
   * DEF steppers repainted a board whose prices were still the 0-K/0-DEF
   * shape's. The fix keys on rosterShape's own starters + bench, so a future
   * ROSTER_BOUNDS slot type cannot be forgotten the same way. */
  const src = prose(TEAM);
  assert.match(src, /_ourDollarsKey/, 'the memo key must still exist');
  assert.match(src, /\$\{shape\.starters\.join\(','\)\}\|\$\{shape\.bench\.length\}/,
    'the memo key must be derived from shape.starters + bench length, not a '
    + 'hand-maintained field list that can omit a slot type again');
  assert.doesNotMatch(src,
    /\$\{draftCfg\.qb\},\$\{draftCfg\.rb\},[\s\S]{0,80}\$\{draftCfg\.bench\}`;/,
    'the old hand-listed key spelling (qb..bench, no k/def) must be gone');
});

test('k and def change the shape the key is built from (pure helper)', () => {
  // rosterShape IS importable, so the invariant behind the key is asserted as
  // behaviour: two configs differing only in k/def must produce different
  // starters lists — and therefore different memo keys.
  const base = { qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 6, k: 0, def: 0 };
  const keyOf = (cfg) => {
    const s = rosterShape(cfg);
    return `${s.starters.join(',')}|${s.bench.length}`;
  };
  assert.notEqual(keyOf(base), keyOf({ ...base, k: 1 }),
    'raising K must move the key, or the K stepper re-prices nothing');
  assert.notEqual(keyOf(base), keyOf({ ...base, def: 1 }),
    'raising DEF must move the key, or the DEF stepper re-prices nothing');
  // The DST spelling question: rosterShape emits the canonical DEF token, so
  // the key cannot fork on a league that spells the slot DST.
  assert.ok(keyOf({ ...base, def: 1 }).includes('DEF1'),
    'the shape speaks the canonical DEF spelling');
});

/* ==========================================================================
   2. RESET clears the Sleeper roster panel's applied claim
   ========================================================================== */

test('RESET clears rosterApplied/rosterStatus and re-plans', () => {
  /* The defect: RESET emptied the roster but left rosterApplied=true, so the
   * panel kept saying "Roster replaced … seated" about a roster that no longer
   * existed, and the no-network FILL MY ROSTER offer was unreachable. */
  const branch = actBranch(prose(TEAM), 'reset', 'league-save');
  assert.match(branch, /rosterApplied = false/,
    'RESET must clear the applied flag, or rosterPlanHtml stays pinned to its '
    + 'post-apply "Roster replaced" branch over an empty roster');
  assert.match(branch, /rosterStatus = null/,
    'RESET must clear the "N player(s) seated" status line');
  assert.match(branch, /buildRosterPlan\(\)/,
    'RESET must re-plan against the emptied slots so FILL MY ROSTER comes back '
    + 'without a fresh network sync');
});

/* ==========================================================================
   3 + 4. Retired sentences — the future-deploy excuse and "kept for this visit"
   ========================================================================== */

test('no user-facing copy blames a missing feed on a future deploy', () => {
  const src = prose(TEAM);
  assert.ok(!src.includes('ships with the next data deploy'),
    'data/player_weekly.json shipped long ago and refreshes daily — a load '
    + 'failure must be reported as a load failure, not a pending release');
  // The honest replacement: what happened, and the remedy.
  assert.ok(src.includes('did not load. Reload to retry'),
    'the weekly-feed failure message must state the honest failure and remedy');
});

test('the Sleeper player-list cache states its real lifetime', () => {
  const src = prose(TEAM);
  assert.ok(!src.includes('kept for this visit'),
    'sleeperIndex lives in the mount closure and every navigation re-mounts '
    + 'the view — "kept for this visit" was false the moment the user tapped '
    + 'another tab');
  assert.ok(src.includes('kept while you stay on this'),
    'the copy must state the true boundary: the cache survives only while the '
    + 'user stays on the TEAM tab');
});

/* ==========================================================================
   5. SAVE LEAGUE SETTINGS repaints the geometry it just changed
   ========================================================================== */

test('the league-save branch repaints everything the profile feeds', () => {
  /* The defect: SAVE rewrote savedProfile then called paintDraft() only, so
   * the roster grid, starters total, finder and reco kept asserting the
   * pre-save slot geometry until an unrelated action reached paintRoster. */
  const branch = actBranch(prose(TEAM), 'league-save', 'sleeper-sync');
  assert.match(branch, /paintAll\(\);/,
    'saving the profile must repaint the roster grid and every other '
    + 'profile-driven panel, not just the draft card');
  assert.doesNotMatch(branch, /leagueStatus = \{ tone: wrote[^}]*\};\s*paintDraft\(\)/,
    'the terminal paintDraft()-only repaint is the defect and must not return');
});

/* ==========================================================================
   6. Draft-room repaints preserve keyboard focus
   ========================================================================== */

test('paintDraft and paintCands restore focus across the innerHTML rebuild', () => {
  const src = prose(TEAM);
  // The capture half: identity is read from the focused control BEFORE the
  // rebuild detaches it...
  assert.match(src, /function draftFocusKey/,
    'the focused control\'s identity must be captured before a rebuild');
  assert.match(src, /function restoreDraftFocus/,
    'and restored onto its equivalent in the fresh markup after');
  // ...and both rebuilding painters actually use it. Two call sites: the
  // draft room (steppers, arm buttons) and the finder (TAKE toggles).
  const calls = src.match(/restoreDraftFocus\(box, focusKey\)/g) || [];
  assert.ok(calls.length >= 2,
    `paintDraft AND paintCands must restore focus (found ${calls.length} call sites)`);
  assert.match(src, /focus\(\{ preventScroll: true \}\)/,
    'restoration must not scroll-jack the page');
});

/* ==========================================================================
   7. The roster is an honest list, not a fake listbox
   ========================================================================== */

test('the roster carries list semantics, never listbox/option', () => {
  const src = prose(TEAM);
  assert.ok(!src.includes('role="listbox"'),
    'role="listbox" promised arrow-key selection that never existed');
  assert.ok(!src.includes('role="option"'),
    'role="option" told AT every filled slot was an unselectable "not '
    + 'selected" entry, and is not a valid parent for interactive children');
  assert.ok(!src.includes('aria-selected'),
    'aria-selected is only valid on widget roles the roster no longer claims');
  assert.ok(src.includes('role="list"') && src.includes('role="listitem"'),
    'the roster is a plain list whose buttons speak for themselves');
  // The targeted-slot state moved to the control that toggles it.
  assert.match(src, /slot-empty" data-act="pick" data-slot="\$\{slot\}" ` \+\s*`aria-pressed=/,
    'the ADD button carries the fit-engine target state as aria-pressed');
});

/* ==========================================================================
   8. Bottom nav — links with aria-current, not a phantom tabs widget
   ========================================================================== */

test('the bottom nav is nav-link semantics with aria-current', () => {
  const shell = html('index.html');
  assert.ok(!shell.includes('role="tablist"') && !shell.includes('role="tab"'),
    'the tab roles promised roving tabindex / arrow keys / aria-controls, '
    + 'none of which existed — the nav must be links');
  assert.match(shell, /<nav class="tabbar" aria-label="Sections">/,
    'the nav landmark keeps its label');

  const main = prose('app/main.js');
  assert.match(main, /setAttribute\('aria-current', 'page'\)/,
    'the active link must carry aria-current="page" — required either way');
  assert.match(main, /removeAttribute\('aria-current'\)/,
    'inactive links must have the attribute REMOVED (absent is the spec\'s '
    + 'inactive state), never set to "false"');
  assert.ok(!main.includes("setAttribute('aria-selected'"),
    'aria-selected is invalid on a link and must not come back');

  // theme.css styles the state the DOM actually carries.
  const css = read('app/theme.css');
  assert.ok(css.includes('.tab[aria-current="page"]'),
    'the active-tab style must key on aria-current, matching the markup');
});

/* ==========================================================================
   9. The #announce live region speaks route changes
   ========================================================================== */

test('route changes populate #announce, and only route changes', () => {
  const main = prose('app/main.js');
  assert.match(main, /getElementById\('announce'\)/,
    'R30b shipped the region and documented populating it as follow-up work — '
    + 'this is the follow-up');
  assert.match(main, /view loaded/,
    'the announcement names the destination view');
  // Scope guard: the announcement is driven by the route table, not scattered
  // per-action writes (the R30b firehose this region exists to avoid).
  const writes = main.match(/announceRoute\(/g) || [];
  assert.ok(writes.length <= 3,
    'announce stays a route-change concern — one helper, one call site in the '
    + `router (found ${writes.length} references)`);
  // And the shell still has the region for it to write into.
  assert.match(html('index.html'), /id="announce"[^>]*aria-live="polite"/,
    'the #announce region must remain in the shell');
});
