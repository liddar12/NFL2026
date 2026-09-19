/* app/views/slate.js — the SLATE view (default route #/).
 *
 * Paints one .card.game per game under a week/season header, with a .wkbar
 * week selector (WK 1..18). The DEFAULT week is whatever game_predictions.json
 * carries (the pipeline's current week) and renders from that contract; any
 * OTHER week renders from schedule_full.json filtered to that week — same
 * renderGameCard markup, probs come from schedule_full's per-game probs.
 * R90: those probs are a RECOMPUTATION (build_predictions.py re-predicts the
 * whole season from today's ratings every run), so on any week but the current
 * one app/review.js repaints the heads from the immutable lock and demotes the
 * recomputed number to a provenance line — see its R90 block.
 * schedule_full is only fetched on the first non-default selection (cached by
 * data.js after that). Handles the empty + error states with a .state message
 * so the user never sees a blank screen. No rendering markup for cards lives
 * here — that is render.js's job; this module orchestrates fetch -> paint.
 */

import { getGamePredictions, getScheduleFull, getMarketPrices } from '../data.js';
import {
  renderGameCard, renderMarketStrip, dayGroupKey, dayGroupLabel,
} from '../render.js';

const WEEKS = 18; // fixed 2026 regular season length — chips are WK 1..18

/** Paint a plain .state message (empty / error). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/**
 * The .wkbar chip row. R90/F20: an ordinary GROUP of toggle buttons, not a
 * tablist — the tab roles promised tabpanel association and roving arrow keys
 * that never existed (review F20), and there is no panel here to associate:
 * the chips filter one list in place. Active chip = .wk-chip--active (what
 * theme.css styles) + aria-pressed="true" (what a screen reader reads).
 */
function wkBar(active) {
  let out = '<div class="wkbar" role="group" aria-label="Week">';
  for (let w = 1; w <= WEEKS; w += 1) {
    const on = w === active;
    out +=
      `<button type="button" class="wk-chip${on ? ' wk-chip--active' : ''}" ` +
        `data-wk="${w}" aria-pressed="${on ? 'true' : 'false'}">WK ${w}</button>`;
  }
  return out + '</div>';
}

/** Sync the topbar #week-chip with the selected week (lives outside #view). */
function setTopbarWeek(week) {
  const chip = document.getElementById('week-chip');
  if (chip) chip.textContent = `WK ${week}`;
}

/**
 * Mount the slate into the given #view element. Async: awaits the contract,
 * then swaps innerHTML in one shot (no partial paints). Week switching only
 * repaints the #slate-list section — header + wkbar stay put.
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
  // Market prices are OPTIONAL adornment (DISPLAY ONLY — never a model input):
  // a 404 or empty file simply means no strips render, zero behavior change.
  let marketGames = {};
  const marketRequest = getMarketPrices({ timeoutMs: 2000 }).catch(() => null);
  if (!el.isConnected) return;

  const defaultGames = (data && Array.isArray(data.games)) ? data.games : [];
  if (defaultGames.length === 0) {
    stateMsg(el, 'No games scheduled yet.');
    return;
  }

  const defaultWeek = data.week != null ? Number(data.week) : 1;
  const season = data.season != null ? data.season : '';
  let active = defaultWeek;
  // Monotonic paint token: a fast chip-hopper must not have a slow
  // schedule_full fetch land on top of a later selection — only the latest wins.
  let paintSeq = 0;

  el.innerHTML =
    '<header class="view-head">' +
      `<h1 class="view-title">WEEK ${defaultWeek} SLATE</h1>` +
      `<span class="view-sub">${season} · MODEL PREDICTIONS</span>` +
    '</header>' +
    wkBar(active) +
    '<div id="slate-list" class="card-list"></div>';

  const listEl = el.querySelector('#slate-list');
  const titleEl = el.querySelector('.view-title');

  function paintGames(games) {
    if (!games.length) {
      listEl.innerHTML = '<div class="state">No games scheduled this week.</div>';
      return;
    }
    // Card + its market-comparison strip (when this game has a priced market).
    const card = (g) => renderGameCard(g) + renderMarketStrip(g, marketGames[g.game_id]);
    // Group by broadcast day (THU/SUN/MON…) so the day isn't repeated on every
    // card. Preserve the incoming order; a new key opens a new .slate-day header.
    const sorted = [...games].sort(
      (a, b) => String(a.kickoff_utc || '').localeCompare(String(b.kickoff_utc || '')));
    let html = '';
    let lastKey = null;
    for (const g of sorted) {
      const key = dayGroupKey(g.kickoff_utc);
      if (key !== lastKey) {
        const label = dayGroupLabel(g.kickoff_utc) || 'SCHEDULE';
        html += `<h2 class="slate-day">${label}</h2>`;
        lastKey = key;
      }
      html += card(g);
    }
    listEl.innerHTML = html;
    reviewSlate(listEl, active, sorted);
  }

  /**
   * R71 — post-game review decoration: after paint, lazily import app/review.js
   * (kept OFF the boot graph) and let it stamp won/lost circles, the review strip
   * and the tap-to-reveal why onto the painted cards. Nothing renders pre-final or
   * when data/review.json is absent; a failed import is silent — never a blank slate.
   */
  function reviewSlate(target, week, games) {
    // R90 — the review layer also owns HISTORICAL TRUTH (F13), so it needs the
    // week context this view alone has: which week the pipeline is currently
    // on (its cards keep today's forecast, which is the right one for an
    // unplayed game) and each painted game's schedule status.
    const statuses = new Map(games.map((g) => [String(g.game_id), String(g.status || '')]));
    import('../review.js')
      .then((mod) => mod.applySlateReview(target, week, { currentWeek: defaultWeek, statuses }))
      .catch(() => { /* review layer unavailable — cards stand on their own */ });
  }

  /** Select a week: sync chips/title/topbar, then repaint the list. */
  async function selectWeek(week) {
    active = week;
    el.querySelectorAll('.wkbar .wk-chip').forEach((b) => {
      const on = Number(b.dataset.wk) === week;
      b.classList.toggle('wk-chip--active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (titleEl) titleEl.textContent = `WEEK ${week} SLATE`;
    setTopbarWeek(week);

    const seq = ++paintSeq;
    // Default week keeps the game_predictions contract as its source of truth.
    if (week === defaultWeek) {
      paintGames(defaultGames);
      return;
    }
    listEl.innerHTML = '<div class="state state--loading">Loading week…</div>';
    let full;
    try {
      full = await getScheduleFull();
    } catch (err) {
      if (seq !== paintSeq) return;
      stateMsg(listEl, 'Week unavailable — the full schedule did not load.');
      return;
    }
    if (seq !== paintSeq) return; // a newer selection already painted
    const games = ((full && full.games) || []).filter((g) => Number(g.week) === week);
    paintGames(games);
  }

  // Initial paint: the pipeline's current week from game_predictions. Also
  // re-sync the topbar chip in case a prior visit left it on another week.
  setTopbarWeek(defaultWeek);
  paintGames(defaultGames);
  marketRequest.then((mp) => {
    if (!el.isConnected || active !== defaultWeek || !mp?.games) return;
    marketGames = mp.games;
    paintGames(defaultGames);
  });

  // Wire the week bar (event delegation, one listener).
  const bar = el.querySelector('.wkbar');
  if (bar) {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.wk-chip');
      if (!btn) return;
      const week = Number(btn.dataset.wk);
      if (!Number.isFinite(week) || week === active) return;
      selectWeek(week);
    });
    // Every chip is a button, so Tab already reaches all 18 — Left/Right are a
    // convenience on top (move focus AND select), the way the week rail reads
    // on a hardware keyboard. Nothing here removes a chip from the tab order.
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const btn = e.target.closest('.wk-chip');
      if (!btn) return;
      const chips = [...bar.querySelectorAll('.wk-chip')];
      const next = chips[chips.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      next.focus();
      const week = Number(next.dataset.wk);
      if (Number.isFinite(week) && week !== active) selectWeek(week);
    });
  }
}
