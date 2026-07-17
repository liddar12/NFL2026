/* app/views/team.js — the TEAM builder view (#/team).
 *
 * Orchestrates the fit engine (app/team-logic.js — pure, node-tested) against
 * the projection + weekly contracts and paints four sections:
 *   .roster        13 slots (QB1..FLEX starters, BN1..BN6 bench) — tap an empty
 *                  slot to target recommendations, tap a filled one to remove
 *   .finder        substring search (name/team/pos) over the player pool; ADD
 *                  fills the first eligible open slot (FLEX RB/WR/TE, bench any)
 *   .reco          top-5 fit-engine picks for the selected (or neediest) open
 *                  slot, each with plain-language .reco-why reason lines
 *   .team-summary  starters season total, 18-cell .team-weeks grid (worst week
 *                  flagged .tw-cell--floor), .bye-warn chips for stacked byes
 *
 * State: roster persists in localStorage nfl2026.team.v1 ({slots:{...:id|null}});
 * scoring mode is READ from nfl2026.scoring.v1 (the Players header owns the
 * toggle — one setting, two views). All numbers are ESTIMATES and labeled so.
 *
 * Fit Engine v2 (AI+): a .aiseg BASE/AI+ toggle (persisted nfl2026.ai.v1,
 * default OFF) re-ranks the .reco panel via fitScoreV2 with data/ai_insights.json
 * as ctx. AI-ESTIMATED reason lines get an inline .prov-ai "AI EST" chip;
 * measured ones cite their span in the text. If ai_insights.json is absent
 * (404, older deploy) the toggle is hidden and the view is byte-for-byte the
 * v1 experience.
 *
 * Degrades honestly: player_weekly.json missing (older deploy) -> a .state
 * message, never a blank screen. Render helpers live LOCALLY (render.js is
 * untouched — this view owns its own markup).
 */

import {
  SLOT_ORDER,
  STARTER_SLOTS,
  scoringAdjust,
  weeklyPoints,
  byeWeek,
  slotEligible,
  teamWeeklyTotals,
  neediestOpenSlot,
  recommend,
  recommendV2,
} from '../team-logic.js';
import {
  getPlayerProjections, getPlayerWeekly, getGamePredictions, getAiInsights,
} from '../data.js';
import { TEAMS } from '../teams.js';

const TEAM_KEY = 'nfl2026.team.v1';
const SCORING_KEY = 'nfl2026.scoring.v1';
const AI_KEY = 'nfl2026.ai.v1'; // Fit Engine AI+ toggle — default OFF (base v1)
const FINDER_CAP = 25; // candidate rows rendered before the "refine search" hint

/* ---- local render helpers (this view's markup is its own) ----------------- */

/** HTML-escape untrusted-ish text before interpolating into a template. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One-decimal fixed number (points everywhere in this view). */
const fix1 = (n) => Number(n).toFixed(1);

/** AA-safe identity tint for a team abbrev (falls back to --ink). */
const tint = (ab) => (TEAMS[ab] && TEAMS[ab].tint) || 'var(--ink)';

/** Index of the minimum value (first hit — deterministic worst week). */
function argmin(arr) {
  let idx = 0;
  for (let i = 1; i < arr.length; i += 1) if (arr[i] < arr[idx]) idx = i;
  return idx;
}

/** Paint a plain .state message (empty / error / missing-feed). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/* ---- persistence ----------------------------------------------------------- */

/** Read the shared scoring mode; unknown/unreadable values fall to ppr. */
function loadScoring() {
  try {
    const v = localStorage.getItem(SCORING_KEY);
    return v === 'half' || v === 'std' ? v : 'ppr';
  } catch (err) {
    return 'ppr'; // storage blocked (private mode) — session default
  }
}

/**
 * Load the roster, sanitized: every slot key present, ids must exist in the
 * current player pool (dropped players vanish honestly), duplicates keep only
 * their first slot. Corrupt/absent storage -> an all-empty roster.
 */
function loadRoster(validIds) {
  const slots = Object.fromEntries(SLOT_ORDER.map((s) => [s, null]));
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
  } catch (err) {
    stored = null;
  }
  const seen = new Set();
  if (stored && stored.slots && typeof stored.slots === 'object') {
    SLOT_ORDER.forEach((s) => {
      const id = stored.slots[s] == null ? null : String(stored.slots[s]);
      if (id && validIds.has(id) && !seen.has(id)) {
        slots[s] = id;
        seen.add(id);
      }
    });
  }
  return { slots };
}

/** Persist the roster; storage failures are non-fatal (session still works). */
function saveRoster(roster) {
  try {
    localStorage.setItem(TEAM_KEY, JSON.stringify(roster));
  } catch (err) {
    /* storage blocked — in-memory roster still drives the render */
  }
}

/** Read the AI+ preference. Anything but the literal 'on' is OFF — the base
 * deterministic fit engine is the default experience (contract: default off). */
function loadAiPref() {
  try {
    return localStorage.getItem(AI_KEY) === 'on';
  } catch (err) {
    return false; // storage blocked (private mode) — session default: off
  }
}

/** Persist the AI+ preference; failures are non-fatal (session toggle works). */
function saveAiPref(on) {
  try {
    localStorage.setItem(AI_KEY, on ? 'on' : 'off');
  } catch (err) {
    /* storage blocked — in-memory flag still drives the render */
  }
}

/** The BASE / AI+ segmented toggle (.aiseg — same pill pattern as .scoreseg).
 * Only rendered when data/ai_insights.json loaded; a 404 hides it entirely. */
function renderAiSeg(on) {
  const btn = (label, active, val) => (
    `<button type="button" data-ai="${val}"` +
      `${active ? ' class="aiseg--active"' : ''} aria-pressed="${active ? 'true' : 'false'}">` +
      `${label}</button>`
  );
  return (
    '<div class="aiseg" role="group" aria-label="Fit engine mode">' +
      `${btn('BASE', !on, 'off')}${btn('AI+', on, 'on')}` +
    '</div>'
  );
}

/* ---- mount ------------------------------------------------------------------ */

export default async function mountTeam(el) {
  el.innerHTML = '<div class="state state--loading">Loading team builder…</div>';

  // Projections + weekly are both REQUIRED here (the fit engine is weekly
  // math); game predictions only pick the "current week" chip and ai_insights
  // only powers the opt-in AI+ toggle — both are optional (missing = degrade).
  const [projRes, weeklyRes, predsRes, aiRes] = await Promise.allSettled([
    getPlayerProjections(),
    getPlayerWeekly(),
    getGamePredictions(),
    getAiInsights(),
  ]);
  if (projRes.status !== 'fulfilled') {
    stateMsg(el, 'Team builder unavailable — the projection feed did not load.');
    return;
  }
  const players = (projRes.value && Array.isArray(projRes.value.players))
    ? projRes.value.players
    : [];
  if (players.length === 0) {
    stateMsg(el, 'No player projections yet.');
    return;
  }
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
  const weeklyById = new Map();
  if (weekly && Array.isArray(weekly.players)) {
    weekly.players.forEach((w) => weeklyById.set(String(w.gsis_id), w));
  }
  if (weeklyById.size === 0) {
    // Older deploy without player_weekly.json: no bye/floor/matchup math is
    // possible — say so instead of faking a fit score.
    stateMsg(el, 'Weekly data unavailable — the team builder needs the weekly '
      + 'projection feed (data/player_weekly.json), which ships with the next '
      + 'data deploy.');
    return;
  }

  // "Current week" for the filled-slot wk-pts chip (falls back to week 1).
  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(18, Math.max(1, Math.round(w)));
  }

  const mode = loadScoring(); // read-only here; the Players header owns the toggle

  // Fit Engine AI layer (v2): available only when data/ai_insights.json loaded
  // AND actually carries players — a 404 (older deploy) or a hollow file hides
  // the toggle entirely, so the view never offers a mode it cannot honor.
  const aiInsights = (aiRes.status === 'fulfilled'
    && aiRes.value && aiRes.value.players
    && Object.keys(aiRes.value.players).length > 0)
    ? aiRes.value
    : null;
  let aiOn = aiInsights ? loadAiPref() : false; // persisted nfl2026.ai.v1, default off

  // Per-mode derived maps, built once per mount (mode changes re-mount):
  //   adjById    id -> season points at the current scoring mode (EXACT)
  //   scaledById id -> 18 weekly floats at the current scoring mode (byes 0)
  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const adjById = new Map();
  const scaledById = new Map();
  players.forEach((p) => {
    const id = String(p.gsis_id);
    const e = weeklyById.get(id);
    const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode);
    adjById.set(id, adj);
    if (e) scaledById.set(id, weeklyPoints(e, adj, p.proj_points));
  });

  // Default finder order: best available first (adjusted points desc, id asc).
  const sortedPlayers = players.slice().sort((a, b) =>
    adjById.get(String(b.gsis_id)) - adjById.get(String(a.gsis_id))
    || (String(a.gsis_id) < String(b.gsis_id) ? -1 : 1));

  const roster = loadRoster(new Set(playersById.keys()));
  let selectedSlot = null; // empty slot targeted for recommendations
  let query = '';

  /* ---- static shell -------------------------------------------------------- */

  const season = projRes.value.season != null ? projRes.value.season : '';
  el.innerHTML =
    '<header class="view-head">' +
      '<h1 class="view-title">TEAM BUILDER</h1>' +
      `<span class="view-sub">${esc(season)} · ${mode.toUpperCase()} SCORING · ESTIMATE</span>` +
    '</header>' +
    (aiInsights ? renderAiSeg(aiOn) : '') +
    '<section class="roster" id="t-roster" role="listbox" aria-label="Roster slots"></section>' +
    '<section class="finder" aria-label="Player finder">' +
      '<input class="finder-input" id="t-find" type="search" autocomplete="off" ' +
        'placeholder="SEARCH NAME · TEAM · POS" aria-label="Search player pool">' +
      '<div id="t-cands"></div>' +
    '</section>' +
    '<section class="reco" id="t-reco" aria-label="Fit engine recommendations"></section>' +
    '<section class="team-summary" id="t-summary" aria-label="Team summary"></section>';

  /* ---- section painters ----------------------------------------------------- */

  /** First open slot (starters before bench) this position may occupy. */
  function firstEligibleOpenSlot(position) {
    return SLOT_ORDER.find((s) => !roster.slots[s] && slotEligible(position, s)) || null;
  }

  function paintRoster() {
    const rows = SLOT_ORDER.map((slot) => {
      const pos = slot.replace(/\d+$/, ''); // QB1 -> QB, BN3 -> BN
      const id = roster.slots[slot];
      let body;
      if (!id) {
        const label = pos === 'BN' ? 'BENCH' : pos;
        body =
          `<button type="button" class="slot-empty" data-act="pick" data-slot="${slot}">` +
            `ADD ${label}</button>`;
      } else {
        const p = playersById.get(id);
        const e = weeklyById.get(id);
        const arr = scaledById.get(id);
        // wk-pts chip: this week's estimate, "BYE" on the bye, season pts if
        // the player somehow lacks weekly data (defensive — ids should mirror).
        const onBye = e && e.weeks && e.weeks[currentWk - 1] && e.weeks[currentWk - 1].bye === true;
        const ptsTxt = onBye
          ? `BYE · W${currentWk}`
          : arr
            ? `${fix1(arr[currentWk - 1])} · W${currentWk}`
            : `${fix1(adjById.get(id))} · SZN`;
        body =
          `<div class="slot-player" role="button" tabindex="0" data-act="remove" data-slot="${slot}" ` +
            `aria-label="Remove ${esc(p.name)} from ${slot}">` +
            `<span class="sp-name"><span class="sp-ab" style="color:${tint(p.team)}">${esc(p.team)}</span> ${esc(p.name)}</span>` +
            `<span class="sp-pts">${esc(ptsTxt)}</span>` +
          '</div>';
      }
      const sel = selectedSlot === slot && !id;
      return (
        `<div class="slot${sel ? ' slot--active' : ''}" role="option" data-slot="${slot}" ` +
          `aria-selected="${sel ? 'true' : 'false'}">` +
          `<span class="slot-pos">${pos}</span>${body}` +
        '</div>'
      );
    });
    el.querySelector('#t-roster').innerHTML = rows.join('');
  }

  function paintCands() {
    const box = el.querySelector('#t-cands');
    const q = query.trim().toLowerCase();
    const rostered = new Set(Object.values(roster.slots).filter(Boolean));
    const hits = sortedPlayers.filter((p) => {
      if (rostered.has(String(p.gsis_id))) return false;
      if (!q) return true;
      return `${p.name} ${p.team} ${p.position}`.toLowerCase().includes(q);
    });
    if (hits.length === 0) {
      box.innerHTML = '<div class="state">No players match.</div>';
      return;
    }
    const rows = hits.slice(0, FINDER_CAP).map((p) => {
      const id = String(p.gsis_id);
      const open = firstEligibleOpenSlot(p.position);
      return (
        `<div class="cand" data-gsis="${esc(id)}">` +
          `<span class="cd-name">${esc(p.name)}</span>` +
          `<span class="cd-meta">${esc(p.position)} · <span style="color:${tint(p.team)}">${esc(p.team)}</span></span>` +
          `<span class="cd-pts">${fix1(adjById.get(id))}</span>` +
          `<button type="button" class="cand-add" data-act="add" data-gsis="${esc(id)}"${open ? '' : ' disabled'}>ADD</button>` +
        '</div>'
      );
    });
    if (hits.length > FINDER_CAP) {
      rows.push(`<div class="cand cand--more">+ ${hits.length - FINDER_CAP} more — refine search</div>`);
    }
    box.innerHTML = rows.join('');
  }

  function paintReco() {
    const box = el.querySelector('#t-reco');
    // Target = the user-selected empty slot, else the engine's neediest open
    // slot (the SAME resolution recommend() applies — panel label never lies).
    const target = (selectedSlot && !roster.slots[selectedSlot])
      ? selectedSlot
      : neediestOpenSlot(roster, players, weeklyById, mode);
    if (!target) {
      box.innerHTML =
        '<div class="reco-head"><span class="reco-slot">FIT ENGINE</span> <span class="est">ESTIMATE</span></div>' +
        '<div class="reco-why">Roster complete — tap a filled slot to remove a player and rework the build.</div>';
      return;
    }
    // AI+ ON re-ranks through fitScoreV2 (recommendV2); OFF is the untouched
    // v1 path. The head names the active mode so the ranking is never ambiguous.
    const ai = aiOn && aiInsights !== null;
    const recos = ai
      ? recommendV2(roster, players, weeklyById, mode, target, aiInsights)
      : recommend(roster, players, weeklyById, mode, target);
    const head =
      `<div class="reco-head"><span class="reco-slot">FIT ENGINE${ai ? ' · AI+' : ''} · ${esc(target)}</span> ` +
      '<span class="est">ESTIMATE</span></div>';
    if (recos.length === 0) {
      box.innerHTML = head + `<div class="reco-why">No eligible players left for ${esc(target)}.</div>`;
      return;
    }
    const items = recos.map((r) => {
      const p = r.player;
      const id = String(p.gsis_id);
      return (
        `<div class="reco-item" data-gsis="${esc(id)}">` +
          '<div class="reco-row">' +
            `<span class="reco-name">${esc(p.name)} <span class="reco-meta">${esc(p.position)} · ${esc(p.team)}</span></span> ` +
            `<span class="reco-score">${fix1(r.score)}</span> ` +
            `<button type="button" class="cand-add" data-act="add" data-gsis="${esc(id)}" data-slot="${esc(target)}">ADD</button>` +
          '</div>' +
          r.reasons.map((t) => {
            // AI-estimated reasons carry the literal "(AI estimate" marker from
            // fitScoreV2 — chip them. Only possible when AI+ is ON (v1 reasons
            // never contain the marker), so the chip never appears on BASE.
            const chip = ai && t.includes('(AI estimate')
              ? ' <span class="prov-ai">AI EST</span>'
              : '';
            return `<div class="reco-why">${esc(t)}${chip}</div>`;
          }).join('') +
        '</div>'
      );
    });
    box.innerHTML = head + items.join('');
  }

  function paintSummary() {
    const box = el.querySelector('#t-summary');
    const starterIds = STARTER_SLOTS.map((s) => roster.slots[s]).filter(Boolean);
    const totals = teamWeeklyTotals(starterIds, scaledById);
    const seasonTotal = starterIds.reduce((sum, id) => sum + (adjById.get(id) || 0), 0);

    // Worst week flagged only when someone actually starts (an all-zero grid
    // has no meaningful floor). Marker glyph + label text, never color alone.
    const worst = starterIds.length > 0 ? argmin(totals) : -1;
    const cells = totals.map((t, i) => {
      const floor = i === worst;
      return (
        `<div class="tw-cell${floor ? ' tw-cell--floor' : ''}"${floor ? ' title="Worst week (floor)"' : ''}>` +
          `W${i + 1}<br>${fix1(t)}${floor ? ' ▼' : ''}` +
        '</div>'
      );
    }).join('');
    const gridLabel = worst >= 0
      ? `Starter points by week; worst week W${worst + 1} at ${fix1(totals[worst])}`
      : 'Starter points by week; no starters yet';

    // Bye clash chips: any week where >=2 starters are simultaneously out.
    const byeCounts = new Map();
    starterIds.forEach((id) => {
      const wk = byeWeek(weeklyById.get(id));
      if (wk != null) byeCounts.set(wk, (byeCounts.get(wk) || 0) + 1);
    });
    const chips = [...byeCounts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => a[0] - b[0])
      .map(([wk, n]) => `<span class="bye-warn">⚠ WK ${wk} · ${n} STARTERS ON BYE</span>`)
      .join(' ');

    box.innerHTML =
      '<div class="ts-head">' +
        `<span class="ts-label">STARTERS SEASON TOTAL · ${mode.toUpperCase()}</span> ` +
        `<span class="ts-total">${fix1(seasonTotal)}</span> ` +
        '<span class="est">ESTIMATE</span>' +
      '</div>' +
      `<div class="team-weeks" role="img" aria-label="${esc(gridLabel)}">${cells}</div>` +
      (chips ? `<div class="ts-byes">${chips}</div>` : '') +
      (starterIds.length === 0
        ? '<div class="ts-note">Add starters to project weekly totals.</div>'
        : '');
  }

  function paintAll() {
    paintRoster();
    paintCands();
    paintReco();
    paintSummary();
  }

  /* ---- events ---------------------------------------------------------------- */

  function onAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled || !el.contains(t)) return;
    const act = t.dataset.act;

    if (act === 'pick') {
      // Select an empty slot: recommendations retarget to it.
      selectedSlot = t.dataset.slot;
      paintRoster();
      paintReco();
      return;
    }

    if (act === 'remove') {
      roster.slots[t.dataset.slot] = null;
      saveRoster(roster);
      paintAll();
      return;
    }

    if (act === 'add') {
      const id = t.dataset.gsis;
      const p = playersById.get(id);
      if (!p) return;
      // Reco ADDs carry their target slot; finder ADDs honor the selected slot
      // when it fits, else the first eligible open slot (starters before bench).
      const wanted = t.dataset.slot || selectedSlot;
      const slot = (wanted && !roster.slots[wanted] && slotEligible(p.position, wanted))
        ? wanted
        : firstEligibleOpenSlot(p.position);
      if (!slot) return;
      roster.slots[slot] = id;
      selectedSlot = null;
      saveRoster(roster);
      paintAll();
    }
  }

  el.addEventListener('click', onAction);
  // Keyboard parity for the div-based remove control (role="button").
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-act][role="button"]')) {
      e.preventDefault();
      onAction(e);
    }
  });
  el.querySelector('#t-find').addEventListener('input', (e) => {
    query = e.target.value || '';
    paintCands();
  });

  // Wire the BASE / AI+ toggle (only rendered when ai_insights loaded). The
  // choice persists in nfl2026.ai.v1; flipping it re-ranks the reco panel.
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
        const active = (b.dataset.ai === 'on') === on;
        b.classList.toggle('aiseg--active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      paintReco();
    });
  }

  paintAll();
}
