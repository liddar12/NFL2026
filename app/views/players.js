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
 *
 * REL2 layers (all optional — each hides itself if its feed 404s on an older
 * deploy, view never blanks):
 *   - AI TREND chip per card (player_history/ai_insights trajectory): up/down
 *     with real pts/yr when measured, "AI EST" when age-curve estimated.
 *   - STRENGTH OF SCHEDULE 1.0–5.0 per card (team_strength + weekly opponents).
 *   - a .aiseg BASE/AI+ toggle (shared nfl2026.ai.v1 with the TEAM tab): AI+ ON
 *     re-ranks the list by an AI-adjusted projection (proj × (1+trajectory_adj),
 *     bounded ±25%) and shows the per-player AI delta — so the AI's effect is
 *     visible on the numbers, not just the team-builder recos.
 *   - a .sortseg (PROJ / TREND / SOS) with a direction arrow.
 */

import {
  getPlayerProjections, getPlayerWeekly, getAiInsights,
  getPlayerHistory, getTeamStrength,
} from '../data.js';
import { renderPlayerCard, renderScoreSeg, renderWeekStrip } from '../render.js';
import { strengthOfSchedule, trendLabel } from '../team-logic.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];

const SCORING_KEY = 'nfl2026.scoring.v1';
const SCORING_SET = new Set(['ppr', 'half', 'std']);
const AI_KEY = 'nfl2026.ai.v1'; // shared with the TEAM tab — one AI+ preference

// Sort modes: which value orders the list. Direction toggles per click.
const SORTS = [
  { key: 'proj', label: 'PROJ' },
  { key: 'trend', label: 'TREND' },
  { key: 'sos', label: 'SOS' },
];

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

/** Read the shared AI+ preference (default OFF). */
function loadAiPref() {
  try {
    return localStorage.getItem(AI_KEY) === 'on';
  } catch (err) {
    return false;
  }
}

/** Persist the shared AI+ preference; failures are non-fatal. */
function saveAiPref(on) {
  try {
    localStorage.setItem(AI_KEY, on ? 'on' : 'off');
  } catch (err) {
    /* storage blocked — in-memory flag still drives the render */
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

/** A compact glossary so no acronym or arrow is ever unexplained; the same
 * collapsible <details> pattern the TEAM tab uses, owned locally (render.js is
 * integrator-owned, and this view's markup is its own). Static markup, placed
 * once under the view header. */
function renderLegend() {
  return (
    '<details class="legend legend--players">' +
      '<summary>WHAT DO THESE MEAN?</summary>' +
      '<div class="legend-body">' +
        '<span class="legend-item"><b>PROJ</b> projected season points (your scoring mode)</span>' +
        '<span class="legend-item"><b>TREND</b> 5-yr trajectory — <span class="cd-trend--up">▲</span> improving, <span class="cd-trend--down">▼</span> declining</span>' +
        '<span class="legend-item"><b>SOS</b> strength of schedule, 1.0 easiest to 5.0 hardest</span>' +
        '<span class="legend-item"><b>BYE</b> the week this player has no game (scores 0)</span>' +
        '<span class="legend-item"><b>AI+</b> AI re-rank by 5-yr trajectory (bounded ±25%, labeled ESTIMATE)</span>' +
        '<span class="legend-item"><b>▼ / ▲</b> sort direction: ▼ descending (high→low), ▲ ascending (low→high)</span>' +
      '</div>' +
    '</details>'
  );
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

/** The BASE/AI+ segmented toggle (shared pattern with the TEAM tab). */
function aiSegRow(on) {
  const btn = (label, active, val) => (
    `<button type="button" data-ai="${val}"` +
      `${active ? ' class="aiseg--active"' : ''} aria-pressed="${active ? 'true' : 'false'}">` +
      `${label}</button>`
  );
  return (
    '<div class="aiseg" role="group" aria-label="AI projection mode">' +
      `${btn('BASE', !on, 'off')}${btn('AI+', on, 'on')}` +
    '</div>'
  );
}

/** The inner buttons of the sort control (active one shows a ▼/▲ arrow). */
function sortChips(activeKey, dir) {
  return SORTS.map((s) => {
    const on = s.key === activeKey;
    const arrow = on ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return (
      `<button type="button" class="sort-chip${on ? ' sort-chip--active' : ''}" ` +
        `data-sort="${s.key}" aria-pressed="${on ? 'true' : 'false'}">${s.label}${arrow}</button>`
    );
  }).join('');
}

/** The sort control wrapper. */
function sortRow(activeKey, dir) {
  return `<div class="sortseg" role="group" aria-label="Sort players">${sortChips(activeKey, dir)}</div>`;
}

/**
 * Mount the players view. Renders the header + controls + full list once, then
 * rewires chip/seg/expand clicks against data held in closure — no network
 * happens on filter, scoring, sort, or AI toggle changes.
 */
export default async function mountPlayers(el) {
  el.innerHTML = '<div class="state state--loading">Loading players…</div>';

  // Projections required; everything else optional (allSettled) so a missing
  // weekly/insight/history/strength file never blanks the view.
  const [projRes, weeklyRes, aiRes, histRes, strRes] = await Promise.allSettled([
    getPlayerProjections(),
    getPlayerWeekly(),
    getAiInsights(),
    getPlayerHistory(),
    getTeamStrength(),
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

  // AI insights ({players:{id:{trajectory_adj,...}}}) — only real when populated.
  const aiInsights = (aiRes.status === 'fulfilled' && aiRes.value
    && aiRes.value.players && Object.keys(aiRes.value.players).length > 0)
    ? aiRes.value.players : null;
  // player_history fallback for trend when a player has no ai_insights entry.
  const history = (histRes.status === 'fulfilled' && histRes.value && histRes.value.players)
    ? histRes.value.players : null;
  const teamStrength = (strRes.status === 'fulfilled' && strRes.value && strRes.value.ratings)
    ? strRes.value : null;
  const hasAi = aiInsights !== null || history !== null; // trend feed present?

  let scoring = hasWeekly ? loadScoring() : 'ppr';
  let active = 'ALL';
  let aiOn = hasAi ? loadAiPref() : false;
  let sortKey = 'proj';
  let sortDir = 'desc';

  /** trajectory_adj insight for a player id (ai_insights first, else history). */
  function trajFor(id) {
    if (aiInsights && aiInsights[id] && aiInsights[id].trajectory_adj) {
      return aiInsights[id].trajectory_adj;
    }
    if (history && history[id] && history[id].trajectory) return history[id].trajectory;
    return null;
  }

  /** Bounded AI multiplier from trajectory_adj.value (±0.25); 1 when absent. */
  function aiRatio(id) {
    const t = aiInsights && aiInsights[id] ? aiInsights[id].trajectory_adj : null;
    const v = t && Number.isFinite(Number(t.value)) ? Number(t.value) : 0;
    const clamped = Math.max(-0.25, Math.min(0.25, v));
    return 1 + clamped;
  }

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PLAYER PROJECTIONS</h1>' +
      `<span class="view-sub">${data.season != null ? data.season : ''} · SEASON POINTS</span>` +
    '</header>';

  /**
   * Build the render model for a player at the current scoring mode + AI mode.
   * Returns { player (scaled), weekly, trend, sos, aiDelta }.
   *  - scoring rescale: whole card scales by season_adj/season_ppr (ppr==0 -> 1)
   *  - AI+ ON: proj/interval further scale by the bounded AI ratio; aiDelta =
   *    (aiProj − baseProj) so the number visibly moves and the delta is shown.
   */
  function model(p) {
    const id = String(p.gsis_id);
    const w = weeklyById.get(id);
    const ppr = Number(p.proj_points);
    const scoreAdj = (w && scoring !== 'ppr') ? seasonAdjust(ppr, w.receptions_prior, scoring) : ppr;
    const scoreRatio = ppr > 0 ? scoreAdj / ppr : 1;
    const r = aiOn ? aiRatio(id) : 1;
    const proj = scoreAdj * r;
    const player = {
      ...p,
      proj_points: proj,
      low: Number(p.low) * scoreRatio * r,
      high: Number(p.high) * scoreRatio * r,
    };
    const trend = trendLabel(trajFor(id));
    const sos = teamStrength ? strengthOfSchedule(w, teamStrength) : null;
    const aiDelta = aiOn ? (proj - scoreAdj) : null;
    return { player, weekly: !!w, trend, sos, aiDelta };
  }

  /** Sort key value for a player under the active sort. */
  function sortVal(p) {
    const id = String(p.gsis_id);
    if (sortKey === 'trend') {
      const t = trajFor(id);
      const tl = t ? trendLabel(t) : null;
      // Rank by the signed adjustment magnitude+direction: use ai value if
      // present, else slope; flat/absent sinks to the middle (0).
      if (t && Number.isFinite(Number(t.value))) return Number(t.value);
      if (tl && Number.isFinite(Number(tl.slope_pts_per_yr))) return Number(tl.slope_pts_per_yr);
      return 0;
    }
    if (sortKey === 'sos') {
      const w = weeklyById.get(id);
      const s = teamStrength ? strengthOfSchedule(w, teamStrength) : null;
      return s == null ? -Infinity : s; // players without SoS sink on desc
    }
    // proj: honor the AI-adjusted number when AI+ is on (matches the display).
    return model(p).player.proj_points;
  }

  // Render the card list for the active filter + sort into #players-list.
  function paintList() {
    const filtered = (active === 'ALL'
      ? players.slice()
      : players.filter((p) => String(p.position).toUpperCase() === active));
    filtered.sort((a, b) => {
      const d = sortVal(b) - sortVal(a);
      const signed = sortDir === 'asc' ? -d : d;
      return signed || (String(a.gsis_id) < String(b.gsis_id) ? -1 : 1);
    });
    const listEl = el.querySelector('#players-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map((p) => {
          const m = model(p);
          return renderPlayerCard(m.player, {
            weekly: m.weekly, trend: m.trend, sos: m.sos, aiDelta: m.aiDelta,
          });
        }).join('')
      : '<div class="state">No players at that position.</div>';
  }

  el.innerHTML =
    head +
    renderLegend() +
    (hasWeekly ? renderScoreSeg(scoring) : '') +
    (hasAi ? aiSegRow(aiOn) : '') +
    filterRow(active) +
    sortRow(sortKey, sortDir) +
    (hasAi && aiOn
      ? '<div class="ai-note">AI+ re-ranks by 5-yr trajectory — projection ×(1±25%). Trend + SoS labeled per card. ESTIMATE.</div>'
      : '') +
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

  // Wire the sort control. Clicking a new key selects it (desc); clicking the
  // active key toggles direction. The node persists — only its inner buttons
  // are repainted, so the single listener stays live.
  const ss = el.querySelector('.sortseg');
  if (ss) {
    ss.addEventListener('click', (e) => {
      const btn = e.target.closest('.sort-chip');
      if (!btn) return;
      const key = btn.dataset.sort;
      if (key === sortKey) {
        sortDir = sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        sortKey = key;
        sortDir = 'desc';
      }
      ss.innerHTML = sortChips(sortKey, sortDir);
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

  // Wire the AI+ toggle (only rendered when a trend feed exists). Flipping it
  // re-ranks + re-scales the projections and shows/hides the explainer note.
  const aiSeg = el.querySelector('.aiseg');
  if (aiSeg) {
    aiSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ai]');
      if (!btn) return;
      const on = btn.dataset.ai === 'on';
      if (on === aiOn) return;
      aiOn = on;
      saveAiPref(on);
      aiSeg.querySelectorAll('button[data-ai]').forEach((b) => {
        const act = (b.dataset.ai === 'on') === on;
        b.classList.toggle('aiseg--active', act);
        b.setAttribute('aria-pressed', act ? 'true' : 'false');
      });
      // Toggle the explainer note without a full re-render.
      let note = el.querySelector('.ai-note');
      if (on && !note) {
        const anchor = el.querySelector('.sortseg') || el.querySelector('.posfilter');
        if (anchor) {
          anchor.insertAdjacentHTML('afterend',
            '<div class="ai-note">AI+ re-ranks by 5-yr trajectory — projection ×(1±25%). '
            + 'Trend + SoS labeled per card. ESTIMATE.</div>');
        }
      } else if (!on && note) {
        note.remove();
      }
      paintList();
    });
  }

  // Wire the per-card WEEKS toggles (delegation on the persistent list node).
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
        // Match the card's displayed ratio (scoring × AI) so the strip agrees.
        const ppr = Number(p.proj_points);
        const scoreAdj = scoring !== 'ppr' ? seasonAdjust(ppr, w.receptions_prior, scoring) : ppr;
        const scoreRatio = ppr > 0 ? scoreAdj / ppr : 1;
        const ratio = scoreRatio * (aiOn ? aiRatio(card.dataset.gsis) : 1);
        btn.insertAdjacentHTML('afterend', renderWeekStrip(w.weeks, ratio));
        strip = card.querySelector('.wkstrip');
      }
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (strip) strip.style.display = open ? 'none' : '';
    });
  }
}
