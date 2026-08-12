/* app/main.js — app entry: hash router, health chip, tab state, SW.
 *
 * Wires the four views (slate/players/parlays/team) to a hash router, paints the
 * pipeline-health chip once, keeps the tab bar's active state + ARIA in sync,
 * and registers the pure cache-purger service worker (best-effort). No
 * framework, no build step, dependency-free (platform fetch + DOM only).
 *
 * A11Y: on every route change we move focus to #view (tabindex="-1") so screen
 * reader / keyboard users land on the freshly painted content, and set
 * aria-selected on the active tab (the tabbar is role="tablist").
 */

import { getPipelineStatus, getGamePredictions } from './data.js';
import { renderHealth, healthMod } from './render.js';
import { ensureUnlocked } from './gate.js';
import mountSlate from './views/slate.js';
import mountPlayers from './views/players.js';
import mountParlays from './views/parlays.js';

/** Lazy TEAM mount: the builder ships as its own module (team-logic + weekly
 * data). Import at navigation time so a failed load degrades to a .state
 * message inside #view — the shell and the other three tabs stay alive. */
async function mountTeam(el) {
  let mod;
  try {
    mod = await import('./views/team.js');
  } catch (err) {
    console.warn('[nfl2026] team view failed to load:', err);
    el.innerHTML = '<div class="state">Team builder unavailable — the view failed to load.</div>';
    return;
  }
  return mod.default(el);
}

/** Lazy MODEL mount (transparency dashboard) — same pattern as the team view. */
async function mountModel(el) {
  let mod;
  try {
    mod = await import('./views/model.js');
  } catch (err) {
    console.warn('[nfl2026] model view failed to load:', err);
    el.innerHTML = '<div class="state">Model view unavailable — the view failed to load.</div>';
    return;
  }
  return mod.default(el);
}

/** Lazy LINEUP mount (weekly start/sit optimizer) — same lazy pattern. */
async function mountLineup(el) {
  let mod;
  try {
    mod = await import('./views/lineup.js');
  } catch (err) {
    console.warn('[nfl2026] lineup view failed to load:', err);
    el.innerHTML = '<div class="state">Lineup view unavailable — the view failed to load.</div>';
    return;
  }
  return mod.default(el);
}

/** Lazy COMPARE mount (head-to-head). Reads its two picks from the hash query. */
async function mountCompare(el) {
  let mod;
  try {
    mod = await import('./views/compare.js');
  } catch (err) {
    console.warn('[nfl2026] compare view failed to load:', err);
    el.innerHTML = '<div class="state">Compare view unavailable — the view failed to load.</div>';
    return;
  }
  return mod.default(el);
}

// hash -> { mount, tab }. '#/' is the default/fallback (slate).
const ROUTES = {
  '#/': { mount: mountSlate, tab: 'slate' },
  '#/players': { mount: mountPlayers, tab: 'players' },
  '#/parlays': { mount: mountParlays, tab: 'parlays' },
  '#/team': { mount: mountTeam, tab: 'team' },
  '#/lineup': { mount: mountLineup, tab: 'lineup' },
  '#/model': { mount: mountModel, tab: 'model' },
  // No tab: reached by action + deep link; reads its picks from the hash query.
  '#/compare': { mount: mountCompare, tab: null },
};

// Monotonic navigation token: guards against out-of-order async paints when the
// user switches tabs faster than a view resolves — only the latest wins.
let navSeq = 0;

/** Sync .tab--active + aria-selected on the tab bar for the active section. */
function setActiveTab(tab) {
  document.querySelectorAll('.tabbar .tab').forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('tab--active', on);
    a.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/** Render the current route into #view and update tab state + focus. */
async function renderRoute() {
  const el = document.getElementById('view');
  if (!el) return;

  // Strip any query string (#/compare?a=..&b=..) before the route lookup; the
  // view reads the query off the live hash itself.
  const hash = (window.location.hash || '#/').split('?')[0];
  const route = ROUTES[hash] || ROUTES['#/'];
  const seq = ++navSeq;

  setActiveTab(route.tab);
  // Focus the view region for a11y (it is tabindex="-1"). Do this before the
  // await so keyboard focus lands immediately, not after the fetch resolves.
  try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }

  await route.mount(el);

  // If another navigation started while we were awaiting, we may have painted
  // stale content — repaint with the now-current route. (Cheap: JSON is cached.)
  if (seq !== navSeq) return;
}

/** Fetch pipeline status and paint the #health chip (state color + note). */
async function renderHealthChip() {
  const el = document.getElementById('health');
  if (!el) return;
  try {
    const status = await getPipelineStatus();
    el.className = `health health--${healthMod(status && status.health)}`;
    el.innerHTML = renderHealth(status);
  } catch (err) {
    // Honest failure: show a down chip rather than an empty bar.
    el.className = 'health health--down';
    el.innerHTML =
      '<span class="health-dot health-dot--down"></span>' +
      '<span class="health-label">DATA · DOWN</span>' +
      '<span class="health-note">status feed unavailable</span>';
  }
}

/** Update the topbar week chip from the game-predictions contract. */
async function renderWeekChip() {
  const el = document.getElementById('week-chip');
  if (!el) return;
  try {
    const data = await getGamePredictions();
    if (data && data.week != null) el.textContent = `WK ${data.week}`;
  } catch (_) {
    // Leave the committed default ("WK 1") in place on failure.
  }
}

/** Register the pure cache-purger SW (best-effort; never blocks first paint). */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[nfl2026] SW registration failed:', err);
    });
  });
}

// One-time bootstrap guard. Module scripts are deferred and execute at
// readyState "interactive" (before DOMContentLoaded), so run once whichever
// path fires first, never twice.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  // Gate first: paint nothing behind the password screen until this browser is
  // unlocked. Already-unlocked visitors resolve synchronously (no fl[icker]).
  ensureUnlocked().then(() => {
    renderHealthChip();
    renderWeekChip();
    renderRoute();
    registerServiceWorker();
  });
}

// Router wiring: re-render on every hash change; bootstrap once on load.
window.addEventListener('hashchange', renderRoute);
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
