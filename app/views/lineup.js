/* app/views/lineup.js — WEEKLY START/SIT + LINEUP OPTIMIZER (route #/lineup).
 *
 * Phase 1 of the in-season roadmap. Reads the roster the Team builder saved
 * (localStorage nfl2026.team.v1) and, for a chosen week, computes the optimal
 * legal starting lineup from the committed per-week projections (PPR), then
 * surfaces the start/sit moves versus the manager's current starters. Pure math
 * lives in app/lineup.js; this module only fetches contracts and paints.
 *
 * Honest by construction: byes are excluded (a bye-week player can never start);
 * a missing weekly feed degrades to a clear state message, never a blank or a
 * fabricated projection. Projections only — no betting line anywhere.
 */

import { getPlayerProjections, getPlayerWeekly, getGamePredictions } from '../data.js';
import { teamTint, teamName } from '../render.js';
import { STARTER_SLOTS } from '../team-logic.js';
import { bestLineup, startSitSwaps, LINEUP_SLOTS } from '../lineup.js';
import { rosPoints } from '../ros.js';

const TEAM_KEY = 'nfl2026.team.v1';   // mirror of the Team builder's roster key
const WEEKS = 18;
const SLOT_LABEL = {
  QB1: 'QB', RB1: 'RB', RB2: 'RB', WR1: 'WR', WR2: 'WR', TE1: 'TE', FLEX: 'FLEX',
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const fix1 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(1) : '—');
const stateMsg = (el, text) => { el.innerHTML = `<div class="state">${text}</div>`; };

/** Read the saved roster's slot->id map (starters only matter here). */
function loadRosterSlots() {
  try {
    const stored = JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
    return (stored && stored.slots && typeof stored.slots === 'object') ? stored.slots : null;
  } catch (err) {
    return null;
  }
}

export default async function mountLineup(el) {
  el.innerHTML = '<div class="state state--loading">Loading lineup…</div>';

  const [projRes, weeklyRes, predsRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(), getGamePredictions(),
  ]);
  if (projRes.status !== 'fulfilled' || weeklyRes.status !== 'fulfilled') {
    stateMsg(el, 'Lineup unavailable — the projection or weekly feed did not load.');
    return;
  }
  const players = (projRes.value && Array.isArray(projRes.value.players)) ? projRes.value.players : [];
  const weekly = (weeklyRes.value && Array.isArray(weeklyRes.value.players)) ? weeklyRes.value.players : [];
  const byId = new Map(players.map((p) => [String(p.gsis_id), p]));
  const weeklyById = new Map(weekly.map((w) => [String(w.gsis_id), w]));

  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(WEEKS, Math.max(1, Math.round(w)));
  }

  const slots = loadRosterSlots();
  const rosterIds = slots
    ? [...STARTER_SLOTS, 'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6']
        .map((s) => slots[s]).filter(Boolean).map(String)
    : [];

  el.innerHTML =
    '<header class="view-head">' +
      '<h1 class="view-title">WEEKLY LINEUP</h1>' +
      '<span class="view-sub">START / SIT · PPR · <span class="est">ESTIMATE</span></span>' +
    '</header>' +
    weekBar(currentWk) +
    '<div id="lineup-body"></div>';

  const body = el.querySelector('#lineup-body');

  if (!slots || rosterIds.length === 0) {
    body.innerHTML =
      '<div class="state">No roster yet. Build one in the <a href="#/team">Team</a> tab — '
      + 'add players to your starting slots and bench, and your best weekly lineup shows up here.</div>';
    wireWeekBar(el, () => {});
    return;
  }

  function playerRow(id, wk) {
    const p = byId.get(id);
    const w = weeklyById.get(id);
    const pos = String((p && p.position) || '').toUpperCase();
    const team = (p && p.team) || '';
    const wkEntry = (w && Array.isArray(w.weeks)) ? w.weeks.find((x) => Number(x.wk) === wk) : null;
    const onBye = !!(wkEntry && wkEntry.bye);
    const pts = onBye ? 0 : Number(wkEntry && wkEntry.pts) || 0;
    const ros = w && Array.isArray(w.weeks) ? rosPoints(w.weeks, wk) : 0;
    return { id, name: (p && p.name) || id, pos, team, pts, onBye, ros };
  }

  function paint(wk) {
    const rows = rosterIds.map((id) => playerRow(id, wk));
    const optimal = bestLineup(rows.map((r) => ({ id: r.id, pos: r.pos, pts: r.pts })));
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const currentStarters = STARTER_SLOTS.map((s) => slots[s]).filter(Boolean).map(String);
    const moves = startSitSwaps(currentStarters, rows.map((r) => ({ id: r.id, pos: r.pos, pts: r.pts })), wk);

    // Optimal starting lineup by slot.
    const starterHtml = LINEUP_SLOTS.map((slot) => {
      const id = optimal.slots[slot];
      const r = id ? rowById.get(id) : null;
      if (!r) {
        return `<div class="lu-row lu-row--empty"><span class="lu-slot">${SLOT_LABEL[slot]}</span>`
          + '<span class="lu-name">— no eligible player —</span><span class="lu-pts">0.0</span></div>';
      }
      const byeTag = r.onBye ? ' <span class="lu-bye" title="On bye this week">BYE</span>' : '';
      return (
        `<div class="lu-row${r.onBye ? ' lu-row--bye' : ''}">`
        + `<span class="lu-slot">${SLOT_LABEL[slot]}</span>`
        + `<span class="lu-name">${esc(r.name)}${byeTag} `
          + `<span class="lu-meta">${esc(r.pos)} · <span style="color:${teamTint(r.team)}">${esc(r.team)}</span></span></span>`
        + `<span class="lu-pts">${fix1(r.pts)}</span>`
        + '</div>'
      );
    }).join('');

    // Start/sit moves — honest net gain of going optimal, with the START set
    // (each into the slot it fills) and the SIT set. No misleading 1:1 pairing:
    // an incoming WR and an outgoing RB don't compete, only the net matters.
    const slotOf = (id) => LINEUP_SLOTS.find((s) => optimal.slots[s] === id) || 'FLEX';
    let movesHtml;
    if (moves.start.length === 0) {
      movesHtml = '<div class="lu-optimal">✓ Your starting lineup is already optimal for Week ' + wk + '.</div>';
    } else {
      const startRows = moves.start.map((id) => {
        const r = rowById.get(id);
        return `<div class="lu-move"><span class="lu-move-in">START <b>${esc(r ? r.name : id)}</b> `
          + `<span class="lu-meta">${esc(SLOT_LABEL[slotOf(id)])} · ${fix1(r ? r.pts : 0)}</span></span></div>`;
      }).join('');
      const sitRows = moves.sit.map((id) => {
        const r = rowById.get(id);
        return `<div class="lu-move lu-move--sit"><span class="lu-move-out">SIT ${esc(r ? r.name : id)} `
          + `<span class="lu-meta">${fix1(r ? r.pts : 0)}</span></span></div>`;
      }).join('');
      movesHtml = `<div class="lu-move lu-move--net">Switching to the optimal lineup adds `
        + `<b class="lu-move-gain">+${fix1(moves.netGain)} pts</b> this week.</div>`
        + startRows + sitRows;
    }

    // Bench (non-starters), sorted by this week's projection.
    const benchHtml = optimal.bench
      .map((id) => rowById.get(id))
      .filter(Boolean)
      .sort((a, b) => b.pts - a.pts)
      .map((r) => (
        `<div class="lu-row lu-row--bench">`
        + `<span class="lu-slot">BN</span>`
        + `<span class="lu-name">${esc(r.name)}${r.onBye ? ' <span class="lu-bye">BYE</span>' : ''} `
          + `<span class="lu-meta">${esc(r.pos)} · <span style="color:${teamTint(r.team)}">${esc(r.team)}</span></span></span>`
        + `<span class="lu-pts">${fix1(r.pts)}</span>`
        + '</div>'
      )).join('');

    body.innerHTML =
      '<section class="card lu-card">'
        + `<div class="m-head">OPTIMAL LINEUP · WEEK ${wk} <span class="lu-total">${fix1(optimal.total)} pts</span></div>`
        + starterHtml
      + '</section>'
      + '<section class="card lu-card">'
        + '<div class="m-head">START / SIT MOVES</div>'
        + movesHtml
      + '</section>'
      + '<section class="card lu-card">'
        + '<div class="m-head">BENCH</div>'
        + (benchHtml || '<div class="state">No bench players.</div>')
      + '</section>'
      + '<div class="lu-foot"><a class="lu-compare" href="#/compare">⚖ Compare two players →</a></div>';
  }

  wireWeekBar(el, paint);
  paint(currentWk);
}

function weekBar(active) {
  let out = '<div class="wkbar lu-wkbar" role="tablist" aria-label="Week">';
  for (let w = 1; w <= WEEKS; w += 1) {
    const on = w === active;
    out += `<button type="button" class="wk-chip${on ? ' wk-chip--active' : ''}" `
      + `data-wk="${w}" role="tab" aria-selected="${on ? 'true' : 'false'}">WK ${w}</button>`;
  }
  return out + '</div>';
}

function wireWeekBar(el, paint) {
  const bar = el.querySelector('.lu-wkbar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.wk-chip');
    if (!btn) return;
    const wk = Number(btn.dataset.wk);
    bar.querySelectorAll('.wk-chip').forEach((b) => {
      const on = Number(b.dataset.wk) === wk;
      b.classList.toggle('wk-chip--active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    paint(wk);
  });
}
