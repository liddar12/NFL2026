/* app/views/parlays.js — the PARLAYS view (#/parlays).
 *
 * Fetches built parlays and paints one .card.parlay per parlay, split by scope
 * via a .scopeseg segmented control (GAME / WEEK). GAME shows scope==="game"
 * parlays; WEEK shows scope==="week". The contract guarantees >=3 of each.
 *
 * REL3: a LEG-COUNT selector (.legseg) filters the active scope by number of
 * legs. Same-game (GAME) parlays are 2-leg; cross-game (WEEK) parlays come in
 * 2..7-leg buckets from the pipeline. The selector is built from the leg counts
 * actually present in the active scope (plus ALL), so it never offers an empty
 * bucket. A short .legend explains leg / EV / tier. Filtering is client-side.
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
    return (
      `<button type="button" class="seg-btn${on ? ' seg-btn--active' : ''}" ` +
        `data-seg="${scope}" role="tab" aria-selected="${on ? 'true' : 'false'}" ` +
        `aria-pressed="${on ? 'true' : 'false'}">${label}</button>`
    );
  };
  return (
    '<div class="scopeseg" role="tablist" aria-label="Parlay scope">' +
      seg('game', 'GAME') +
      seg('week', 'WEEK') +
    '</div>'
  );
}

/** Leg-count chips for the counts present in the active scope, plus ALL. */
function legSeg(counts, activeLeg) {
  const chip = (val, label) => {
    const on = String(val) === String(activeLeg);
    return (
      `<button type="button" class="leg-chip${on ? ' leg-chip--active' : ''}" ` +
        `data-leg="${val}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`
    );
  };
  return (
    '<div class="legseg" role="group" aria-label="Filter by number of legs">' +
      chip('all', 'ALL') +
      counts.map((n) => chip(n, `${n} LEG`)).join('') +
    '</div>'
  );
}

/** A one-line glossary so the parlay terms are never unexplained. */
function legend() {
  return (
    '<div class="legend">' +
      '<span class="legend-item"><b>LEG</b> one pick in the parlay — all must hit</span>' +
      '<span class="legend-item"><b>MODEL EV</b> model edge vs the book price (placeholder until live odds)</span>' +
      '<span class="legend-item"><b>TIER</b> confidence: high &gt; medium &gt; low (more legs = lower)</span>' +
      '<span class="est">ESTIMATE</span>' +
    '</div>'
  );
}

/**
 * Mount the parlays view. Renders the controls + list once, then rewires
 * scope + leg-count clicks to re-render the list from data held in closure.
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
  let activeLeg = 'all';

  const scopeOf = (p) => (p.scope === 'week' ? 'week' : 'game');
  const legOf = (p) => (Array.isArray(p.legs) ? p.legs.length : 0);

  /** Distinct leg counts present in the active scope, ascending. */
  function legCountsForScope() {
    const set = new Set(parlays.filter((p) => scopeOf(p) === active).map(legOf));
    return [...set].sort((a, b) => a - b);
  }

  /** Repaint the leg-count selector for the active scope (keeps the node). */
  function paintLegSeg() {
    const box = el.querySelector('#leg-controls');
    if (!box) return;
    box.innerHTML = legSeg(legCountsForScope(), activeLeg);
  }

  // Render the parlay cards for the active scope + leg filter into #parlays-list.
  function paintList() {
    const filtered = parlays.filter((p) =>
      scopeOf(p) === active
      && (activeLeg === 'all' || legOf(p) === Number(activeLeg)));
    const listEl = el.querySelector('#parlays-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map(renderParlayCard).join('')
      : '<div class="state">No parlays at this leg count.</div>';
  }

  el.innerHTML =
    head +
    scopeSeg(active) +
    '<div id="leg-controls"></div>' +
    legend() +
    '<div id="parlays-list" class="card-list"></div>';
  paintLegSeg();
  paintList();

  // Wire the scope control: switching scope resets the leg filter to ALL and
  // rebuilds the leg-count chips for the new scope.
  const seg = el.querySelector('.scopeseg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      active = btn.dataset.seg;
      activeLeg = 'all';
      seg.querySelectorAll('.seg-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('seg-btn--active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintLegSeg();
      paintList();
    });
  }

  // Wire the leg-count selector (delegated on the persistent container).
  const legBox = el.querySelector('#leg-controls');
  if (legBox) {
    legBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.leg-chip');
      if (!btn) return;
      activeLeg = btn.dataset.leg;
      legBox.querySelectorAll('.leg-chip').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('leg-chip--active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintList();
    });
  }
}
