/* app/main.js — app entry: hash router, health chip, tab state, SW.
 *
 * Wires the views (slate/players/parlays/team/league/...) to a hash router, paints the
 * pipeline-health chip once, keeps the tab bar's active state + ARIA in sync,
 * and registers the pure cache-purger service worker (best-effort). No
 * framework, no build step, dependency-free (platform fetch + DOM only).
 *
 * A11Y: on every route change we move focus to #view (tabindex="-1") so screen
 * reader / keyboard users land on the freshly painted content, set
 * aria-current="page" on the active nav link (R30c — the tabbar is a <nav> of
 * links, not a tablist), and announce the loaded view's name in #announce.
 */

import { getPipelineStatus, getGamePredictions } from './data.js';
import { loadProfile, isDefaultProfile, loadLeagueId, leagueChipText } from './league.js';
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

/** Lazy GRADE mount (paste-anything team grader) — same pattern as team. */
async function mountGrade(el) {
  let mod;
  try {
    mod = await import('./views/grade.js');
  } catch (err) {
    console.warn('[nfl2026] grade view failed to load:', err);
    el.innerHTML = '<div class="state">Team grade unavailable — the view failed to load.</div>';
    return;
  }
  return mod.default(el);
}

/** Lazy LEAGUE mount (R48 — the applied league, its diffs, the sync log).
 * Same pattern as grade. Reads storage only; fetches no contract. */
async function mountLeague(el) {
  let mod;
  try {
    mod = await import('./views/league.js');
  } catch (err) {
    console.warn('[nfl2026] league view failed to load:', err);
    el.innerHTML = '<div class="state">League view unavailable — the view failed to load.</div>';
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

// hash -> { mount, tab, name }. '#/' is the default/fallback (slate). `name`
// is what #announce speaks on route change (R30c).
const ROUTES = {
  '#/': { mount: mountSlate, tab: 'slate', name: 'Slate' },
  '#/players': { mount: mountPlayers, tab: 'players', name: 'Players' },
  '#/parlays': { mount: mountParlays, tab: 'parlays', name: 'Parlays' },
  '#/team': { mount: mountTeam, tab: 'team', name: 'Team' },
  '#/league': { mount: mountLeague, tab: 'league', name: 'League' },
  '#/lineup': { mount: mountLineup, tab: 'lineup', name: 'Lineup' },
  '#/model': { mount: mountModel, tab: 'model', name: 'Model' },
  '#/grade': { mount: mountGrade, tab: 'grade', name: 'Grade' },
  // No tab: reached by action + deep link; reads its picks from the hash query.
  '#/compare': { mount: mountCompare, tab: null, name: 'Compare' },
};

// Monotonic navigation token: guards against out-of-order async paints when the
// user switches tabs faster than a view resolves — only the latest wins.
let navSeq = 0;

// Mount queue. Every view paints into the SAME #view element, so two mounts must
// never be in flight at once: whichever resolves LAST wins the element,
// regardless of which route the user actually asked for. That is not
// theoretical — booting at "/" and tapping a tab before the slate's feeds
// resolve left the tab bar on TEAM while SLATE content sat in the view. Chaining
// serializes mounts, and the navSeq check below runs at DEQUEUE time so a
// superseded route is dropped before it ever paints.
let mountQueue = Promise.resolve();

/** Sync .tab--active + aria-current on the nav bar for the active section.
 * R30c — aria-current="page", not aria-selected: the tabbar is a <nav> of
 * links (see index.html), and aria-selected is only valid on widget roles the
 * markup no longer claims. The attribute is REMOVED (not set "false") on the
 * inactive links — absent is the spec's inactive state for aria-current. */
function setActiveTab(tab) {
  document.querySelectorAll('.tabbar .tab').forEach((a) => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('tab--active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

/** R30c — speak the destination in the #announce live region on route change.
 * #view is focused on navigation (which announces its label), but the region
 * gives SRs an explicit, consistent "X view loaded" once the mount resolves.
 * Route changes ONLY — per-action announcements were rejected in R30b as a
 * firehose, which is why #view itself must never be aria-live. */
function announceRoute(name) {
  const live = document.getElementById('announce');
  if (live && name) live.textContent = `${name} view loaded`;
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

  const run = () => {
    // Superseded while we waited our turn: never paint a route the user has
    // already navigated away from.
    if (seq !== navSeq) return undefined;
    // Announce only after the mount settles, and only if this navigation is
    // still the latest — announcing a superseded route would tell an SR user
    // they are somewhere they are not. A failed mount paints its own .state
    // error and is deliberately NOT announced as "loaded".
    return Promise.resolve(route.mount(el)).then(() => {
      if (seq === navSeq) announceRoute(route.name);
    });
  };
  // `then(run, run)` on both settlements so one view's failure cannot wedge the
  // queue and freeze every later navigation.
  mountQueue = mountQueue.then(run, run);
  await mountQueue;
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

/* R47 — THE LEAGUE CHIP: every tab states which league's scoring the numbers
 * are priced under, so alignment is auditable at a glance. Repainted on boot,
 * on every route change, and whenever a sync saves a league (the
 * 'nfl2026:league' event TEAM and GRADE dispatch). */
function renderLeagueChip() {
  const el = document.getElementById('league-chip');
  if (!el) return;
  try {
    const profile = loadProfile();
    const id = loadLeagueId();
    const on = !isDefaultProfile(profile);
    el.textContent = leagueChipText(profile, id);
    el.className = `lg ${on ? 'lg--on' : 'lg--none'}`;
    el.title = on
      ? `Every projection on every tab is priced under ${profile.name}'s scoring table`
        + (id ? ` (Sleeper league ${id})` : '') + '. RESET ALL on TEAM clears it.'
      : 'No league saved: standard PPR and the default roster shape. Sync a league on TEAM or GRADE.';
  } catch (err) {
    el.textContent = 'NO LEAGUE · STD PPR';
    el.className = 'lg lg--none';
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
    renderLeagueChip();
    renderRoute();
    registerServiceWorker();
  });
}

// Router wiring: re-render on every hash change; bootstrap once on load.
window.addEventListener('hashchange', renderRoute);
// R47 — the LEAGUE chip follows every route change and every league sync.
window.addEventListener('hashchange', renderLeagueChip);
window.addEventListener('nfl2026:league', renderLeagueChip);
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
