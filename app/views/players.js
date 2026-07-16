/* app/views/players.js — the PLAYERS view (#/players).
 *
 * Fetches season player projections and paints one .card.player per player,
 * with a .posfilter chip row (ALL/QB/RB/WR/TE) that filters the list entirely
 * client-side (no re-fetch). Empty/error states render a .state message.
 */

import { getPlayerProjections } from '../data.js';
import { renderPlayerCard } from '../render.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

/** Paint a plain .state message (empty / error). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/** Build the position filter chip row. `active` is the selected position. */
function filterRow(active) {
  const chips = POSITIONS.map((pos) => {
    const on = pos === active;
    return (
      `<button type="button" class="pf-chip${on ? ' pf-chip--active' : ''}" ` +
        `data-pos="${pos}" aria-pressed="${on ? 'true' : 'false'}">${pos}</button>`
    );
  }).join('');
  return `<div class="posfilter" role="group" aria-label="Filter by position">${chips}</div>`;
}

/**
 * Mount the players view. Renders the filter + full list once, then rewires the
 * chip clicks to filter the already-rendered cards by toggling a hidden state
 * (cheap: we just re-render the list section, keeping the fetched data in
 * closure so no network happens on filter changes).
 */
export default async function mountPlayers(el) {
  el.innerHTML = '<div class="state state--loading">Loading players…</div>';
  let data;
  try {
    data = await getPlayerProjections();
  } catch (err) {
    stateMsg(el, 'Players unavailable — the projection feed did not load.');
    return;
  }

  const players = (data && Array.isArray(data.players)) ? data.players : [];
  if (players.length === 0) {
    stateMsg(el, 'No player projections yet.');
    return;
  }

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PLAYER PROJECTIONS</h1>' +
      `<span class="view-sub">${data.season != null ? data.season : ''} · SEASON POINTS</span>` +
    '</header>';

  let active = 'ALL';

  // Render the card list for the active position filter into #players-list.
  function paintList() {
    const filtered = active === 'ALL'
      ? players
      : players.filter((p) => String(p.position).toUpperCase() === active);
    const listEl = el.querySelector('#players-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map(renderPlayerCard).join('')
      : '<div class="state">No players at that position.</div>';
  }

  el.innerHTML =
    head +
    filterRow(active) +
    '<div id="players-list" class="card-list"></div>';
  paintList();

  // Wire the filter chips (event delegation on the filter row).
  const pf = el.querySelector('.posfilter');
  if (pf) {
    pf.addEventListener('click', (e) => {
      const btn = e.target.closest('.pf-chip');
      if (!btn) return;
      active = btn.dataset.pos;
      pf.querySelectorAll('.pf-chip').forEach((c) => {
        const on = c === btn;
        c.classList.toggle('pf-chip--active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintList();
    });
  }
}
