/* app/main.js — provisional app entry: hash router stub + contract self-check.
 *
 * MINIMAL by design. Real views/layout are Gate 2's job. This module only:
 *   1. Runs a tiny hash router over #/ , #/players, #/games, #/parlays, each
 *      rendering a "Gate 2 pending" placeholder.
 *   2. On load, fetches every data/*.json contract via app/data.js and
 *      console.logs each one's shape — proving the JSON contract links up end
 *      to end before any UI is built on top of it.
 *
 * No framework, no build step, dependency-free.
 */

import { getAll, RUNTIME_CONFIG } from './data.js';

// The four provisional routes. Home is the default/fallback.
const ROUTES = {
  '#/': 'Home',
  '#/players': 'Players',
  '#/games': 'Games',
  '#/parlays': 'Parlays',
};

/** Render the placeholder view for whatever hash is current. */
function renderRoute() {
  const el = document.getElementById('view');
  if (!el) return;

  const hash = window.location.hash || '#/';
  const label = ROUTES[hash] || ROUTES['#/'];

  // Deliberately plain placeholder text. Gate 2 replaces the whole view layer.
  el.textContent = '';
  const h = document.createElement('h2');
  h.textContent = label;
  h.style.cssText = 'margin:0 0 4px;font-size:16px;';
  const p = document.createElement('p');
  p.textContent = 'Gate 2 pending';
  p.style.cssText = 'margin:0;color:#9fb0c0;';
  el.append(h, p);
}

/**
 * Fetch all contracts and log a compact shape summary for each. This is the
 * end-to-end proof that data.js + the on-disk JSON contracts are wired up.
 * Never throws into the router — a bad feed is logged, not fatal.
 */
async function proveContracts() {
  try {
    const all = await getAll();
    console.log('[nfl2026] runtime-config:', RUNTIME_CONFIG);
    for (const [name, value] of Object.entries(all)) {
      if (value && value.__error) {
        console.warn(`[nfl2026] contract "${name}" failed:`, value.__error);
        continue;
      }
      console.log(`[nfl2026] contract "${name}" shape:`, describeShape(value));
    }
  } catch (err) {
    console.error('[nfl2026] contract self-check failed:', err);
  }
}

/**
 * Produce a shallow, human-readable description of a parsed JSON value's shape
 * (type, array length, top-level keys) without dumping the whole payload.
 */
function describeShape(value) {
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, sampleKeys: value[0] ? Object.keys(value[0]) : [] };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value) };
  }
  return { type: typeof value, value };
}

// One-time bootstrap guard. Module scripts are deferred and execute at
// readyState "interactive" (before DOMContentLoaded fires), so we cannot know
// in advance whether the event will still fire — run once, whichever path hits
// first, and never twice.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  renderRoute();
  proveContracts();
}

// Router wiring: re-render on every hash change; bootstrap once on load.
window.addEventListener('hashchange', renderRoute);
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  // DOM already parsed (typical for a deferred module) — bootstrap now.
  boot();
}
