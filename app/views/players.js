/* app/views/players.js — the PLAYERS view (#/players).
 *
 * Fetches season player projections and paints one .card.player per player,
 * with a .posfilter chip row (ALL/QB/RB/WR/TE) that filters the list entirely
 * client-side (no re-fetch). Empty/error states render a .state message.
 *
 * Weekly layer (degrades gracefully): player_weekly.json adds
 *   - a PPR/HALF/STD .scoreseg in the header. Conversion is EXACT via
 *     receptions_prior: half = ppr − 0.5·rec, std = ppr − rec (season);
 *     interval ends + weekly points scale by season_adj/season_ppr.
 *     Persisted in localStorage nfl2026.scoring.v1 (TEAM tab reads the same).
 *   - a per-card WEEKS toggle (.p-expand) that lazily injects the 18-cell
 *     .wkstrip at the CURRENT scoring mode.
 * If player_weekly.json is absent (older deploy), both are hidden and the
 * view is honestly PPR-only — never blank.
 */

import { getPlayerProjections, getPlayerWeekly } from '../data.js';
import { renderPlayerCard, renderScoreSeg, renderWeekStrip } from '../render.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

const SCORING_KEY = 'nfl2026.scoring.v1';
const SCORING_SET = new Set(['ppr', 'half', 'std']);

/** Read the persisted scoring mode; unknown/unreadable values fall to ppr. */
function loadScoring() {
  try {
    const v = localStorage.getItem(SCORING_KEY);
    return SCORING_SET.has(v) ? v : 'ppr';
  } catch (err) {
    return 'ppr'; // storage blocked (private mode) — session default
  }
}

/** Persist the scoring mode; storage failures are non-fatal (display still flips). */
function saveScoring(mode) {
  try {
    localStorage.setItem(SCORING_KEY, mode);
  } catch (err) {
    /* storage blocked — the in-memory mode still drives the render */
  }
}

/**
 * Season points under a scoring mode. EXACT conversion via prior-season
 * receptions: half = ppr − 0.5·rec, std = ppr − rec. ppr passes through.
 */
function seasonAdjust(ppr, receptions, mode) {
  const rec = Number(receptions) || 0;
  if (mode === 'half') return ppr - 0.5 * rec;
  if (mode === 'std') return ppr - rec;
  return ppr;
}

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
 * Mount the players view. Renders the header + filter + full list once, then
 * rewires chip/seg/expand clicks against data held in closure — no network
 * happens on filter, scoring, or expand changes.
 */
export default async function mountPlayers(el) {
  el.innerHTML = '<div class="state state--loading">Loading players…</div>';

  // Projections are required; the weekly contract is optional (may 404 on an
  // older deploy) — allSettled so a missing weekly file never blanks the view.
  const [projRes, weeklyRes] = await Promise.allSettled([
    getPlayerProjections(),
    getPlayerWeekly(),
  ]);
  if (projRes.status !== 'fulfilled') {
    stateMsg(el, 'Players unavailable — the projection feed did not load.');
    return;
  }
  const data = projRes.value;
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;

  const players = (data && Array.isArray(data.players)) ? data.players : [];
  if (players.length === 0) {
    stateMsg(el, 'No player projections yet.');
    return;
  }

  // gsis_id -> weekly entry ({receptions_prior, weeks[18]}). Empty map ==
  // weekly layer off (hide scoreseg + WEEKS toggles, PPR-only).
  const weeklyById = new Map();
  if (weekly && Array.isArray(weekly.players)) {
    weekly.players.forEach((w) => weeklyById.set(String(w.gsis_id), w));
  }
  const hasWeekly = weeklyById.size > 0;

  let scoring = hasWeekly ? loadScoring() : 'ppr';
  let active = 'ALL';

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PLAYER PROJECTIONS</h1>' +
      `<span class="view-sub">${data.season != null ? data.season : ''} · SEASON POINTS</span>` +
    '</header>';

  // Season/interval numbers rescaled to the current scoring mode. The whole
  // card scales by one ratio (season_adj/season_ppr), so the marker position
  // inside the band is unchanged — only the printed numbers move. ppr==0
  // guards the division (ratio 1: nothing to redistribute).
  function adjust(p) {
    const w = weeklyById.get(String(p.gsis_id));
    if (!w || scoring === 'ppr') return { player: p, weekly: !!w, ratio: 1 };
    const ppr = Number(p.proj_points);
    const adj = seasonAdjust(ppr, w.receptions_prior, scoring);
    const ratio = ppr > 0 ? adj / ppr : 1;
    return {
      player: {
        ...p,
        proj_points: adj,
        low: Number(p.low) * ratio,
        high: Number(p.high) * ratio,
      },
      weekly: true,
      ratio,
    };
  }

  // Render the card list for the active position filter into #players-list.
  // Re-painting collapses any open .wkstrip — it re-injects lazily at the
  // (possibly new) scoring mode on the next expand, so strips never go stale.
  function paintList() {
    const filtered = active === 'ALL'
      ? players
      : players.filter((p) => String(p.position).toUpperCase() === active);
    const listEl = el.querySelector('#players-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map((p) => {
          const a = adjust(p);
          return renderPlayerCard(a.player, { weekly: a.weekly });
        }).join('')
      : '<div class="state">No players at that position.</div>';
  }

  el.innerHTML =
    head +
    (hasWeekly ? renderScoreSeg(scoring) : '') +
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

  // Wire the scoring seg (only rendered when weekly data exists).
  const seg = el.querySelector('.scoreseg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-scoring]');
      if (!btn) return;
      const mode = btn.dataset.scoring;
      if (!SCORING_SET.has(mode) || mode === scoring) return;
      scoring = mode;
      saveScoring(mode);
      seg.querySelectorAll('button[data-scoring]').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('scoreseg--active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintList();
    });
  }

  // Wire the per-card WEEKS toggles (delegation on the persistent list node —
  // survives every paintList innerHTML swap). First expand lazily injects the
  // .wkstrip at the current scoring ratio; collapse just hides it.
  const listEl = el.querySelector('#players-list');
  if (listEl && hasWeekly) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.p-expand');
      if (!btn) return;
      const card = btn.closest('.card.player');
      if (!card) return;
      const open = btn.getAttribute('aria-expanded') === 'true';
      let strip = card.querySelector('.wkstrip');
      if (!open && !strip) {
        const p = players.find((pl) => String(pl.gsis_id) === card.dataset.gsis);
        const w = weeklyById.get(card.dataset.gsis);
        if (!p || !w) return; // no weekly row — leave the card collapsed
        btn.insertAdjacentHTML('afterend', renderWeekStrip(w.weeks, adjust(p).ratio));
        strip = card.querySelector('.wkstrip');
      }
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (strip) strip.style.display = open ? 'none' : '';
    });
  }
}
