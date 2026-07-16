/* app/views/slate.js — the SLATE view (default route #/).
 *
 * Fetches the week's game predictions and paints one .card.game per game,
 * under a week/season header. Handles the empty + error states with a .state
 * message so the user never sees a blank screen. No rendering markup lives
 * here — that is render.js's job; this module only orchestrates fetch -> paint.
 */

import { getGamePredictions } from '../data.js';
import { renderGameCard } from '../render.js';

/** Paint a plain .state message (empty / error). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/**
 * Mount the slate into the given #view element. Async: awaits the contract,
 * then swaps innerHTML in one shot (no partial paints).
 */
export default async function mountSlate(el) {
  el.innerHTML = '<div class="state state--loading">Loading slate…</div>';
  let data;
  try {
    data = await getGamePredictions();
  } catch (err) {
    stateMsg(el, 'Slate unavailable — the game feed did not load.');
    return;
  }

  const games = (data && Array.isArray(data.games)) ? data.games : [];
  if (games.length === 0) {
    stateMsg(el, 'No games scheduled yet.');
    return;
  }

  const week = data.week != null ? data.week : '';
  const season = data.season != null ? data.season : '';
  const head =
    '<header class="view-head">' +
      `<h1 class="view-title">WEEK ${week} SLATE</h1>` +
      `<span class="view-sub">${season} · MODEL PREDICTIONS</span>` +
    '</header>';

  el.innerHTML = head + games.map(renderGameCard).join('');
}
