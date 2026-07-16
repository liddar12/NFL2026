/* app/views/parlays.js — the PARLAYS view (#/parlays).
 *
 * Fetches built parlays and paints one .card.parlay per parlay, split by scope
 * via a .scopeseg segmented control (GAME / WEEK). GAME shows scope==="game"
 * parlays; WEEK shows scope==="week". The contract guarantees >=3 of each.
 * Filtering is client-side (no re-fetch). Empty/error -> a .state message.
 */

import { getParlays } from '../data.js';
import { renderParlayCard } from '../render.js';

/** Paint a plain .state message (empty / error). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/** Segmented control: GAME | WEEK. `active` is the selected scope. */
function scopeSeg(active) {
  const seg = (scope, label) => {
    const on = scope === active;
    // NOTE: uses data-seg, NOT data-scope — data-scope is reserved for the
    // parlay CARDS (the contract/test selector `[data-scope="game|week"]`), so
    // the control must not pollute that count.
    return (
      `<button type="button" class="seg-btn${on ? ' seg-btn--active' : ''}" ` +
        `data-seg="${scope}" role="tab" aria-selected="${on ? 'true' : 'false'}">${label}</button>`
    );
  };
  return (
    '<div class="scopeseg" role="tablist" aria-label="Parlay scope">' +
      seg('game', 'GAME') +
      seg('week', 'WEEK') +
    '</div>'
  );
}

/**
 * Mount the parlays view. Renders the segmented control + list once, then
 * rewires GAME/WEEK to re-render the list section from data held in closure.
 */
export default async function mountParlays(el) {
  el.innerHTML = '<div class="state state--loading">Loading parlays…</div>';
  let data;
  try {
    data = await getParlays();
  } catch (err) {
    stateMsg(el, 'Parlays unavailable — the parlay feed did not load.');
    return;
  }

  const parlays = (data && Array.isArray(data.parlays)) ? data.parlays : [];
  if (parlays.length === 0) {
    stateMsg(el, 'No parlays built yet.');
    return;
  }

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PARLAYS</h1>' +
      `<span class="view-sub">WEEK ${data.week != null ? data.week : ''} · MODEL EV</span>` +
    '</header>';

  let active = 'game';

  // Render the parlay cards for the active scope into #parlays-list.
  function paintList() {
    const filtered = parlays.filter((p) => (p.scope === 'week' ? 'week' : 'game') === active);
    const listEl = el.querySelector('#parlays-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map(renderParlayCard).join('')
      : '<div class="state">No parlays in this scope.</div>';
  }

  el.innerHTML =
    head +
    scopeSeg(active) +
    '<div id="parlays-list" class="card-list"></div>';
  paintList();

  // Wire the segmented control (event delegation).
  const seg = el.querySelector('.scopeseg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      active = btn.dataset.seg;
      seg.querySelectorAll('.seg-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('seg-btn--active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      paintList();
    });
  }
}
