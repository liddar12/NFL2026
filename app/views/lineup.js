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
 *
 * REL17 — AVAILABILITY. An unavailable player (IR/PUP/NFI/suspended/ruled out) is
 * never SILENTLY auto-started. Three coordinated behaviours:
 *   1. his week's points are zeroed at the display boundary, exactly like a bye,
 *      so the row and the card total can never disagree;
 *   2. bestLineup demotes him below every available candidate, so in the normal
 *      case he simply is not in a slot — the quiet, correct outcome;
 *   3. when the roster has nobody else for that slot he IS started, and the card
 *      shouts about it (`.lu-forced` banner + a non-receding row), and the
 *      "already optimal" line is suppressed because it would be a lie.
 * The availability block is optional on data/player_weekly.json: a deploy that
 * predates the pipeline renders exactly as it does today.
 */

import { getPlayerProjections, getPlayerWeekly, getGamePredictions } from '../data.js';
import { teamTint, teamName } from '../render.js';
import { STARTER_SLOTS } from '../team-logic.js';
import { bestLineup, startSitSwaps, LINEUP_SLOTS } from '../lineup.js';
import { availabilityOf, renderAvailChip } from '../availability.js';
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
  // Sanitize against the live pool exactly like the Team builder's loadRoster:
  // a player dropped/traded/retired out of projections must NOT render as a
  // phantom row named after his raw id — drop any id we can't resolve.
  const rosterIds = slots
    ? [...STARTER_SLOTS, 'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6']
        .map((s) => slots[s]).filter(Boolean).map(String)
        .filter((id) => byId.has(id))
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
    // Mirrors the bye line: a player who cannot play scores 0 for display. Showing
    // 12.4 beside a "⊘ IR" chip is the same lie the un-haircut projection shipped.
    const avail = availabilityOf(w, wk, currentWk);
    const pts = (onBye || avail.playable === false) ? 0 : Number(wkEntry && wkEntry.pts) || 0;
    const ros = w && Array.isArray(w.weeks) ? rosPoints(w.weeks, wk) : 0;
    return { id, name: (p && p.name) || id, pos, team, pts, onBye, ros, avail };
  }

  function paint(wk) {
    const rows = rosterIds.map((id) => playerRow(id, wk));
    // `playable` MUST ride into both pure helpers — mapping down to {id,pos,pts}
    // is what silently dropped availability before Rel17.
    const optIn = rows.map((r) => ({
      id: r.id, pos: r.pos, pts: r.pts, playable: r.avail.playable,
    }));
    const optimal = bestLineup(optIn);
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const currentStarters = STARTER_SLOTS.map((s) => slots[s])
      .filter(Boolean).map(String).filter((id) => byId.has(id));
    const moves = startSitSwaps(currentStarters, optIn, wk);
    const warnings = Array.isArray(optimal.warnings) ? optimal.warnings : [];
    const forcedSlots = new Set(warnings.map((wn) => wn.slot));

    // A forced start is a to-do, not a footnote: one banner per warning, at the
    // top of the card, naming the slot, the player and why he can't play.
    const forcedHtml = warnings.map((wn) => {
      const r = rowById.get(wn.id);
      if (!r) return '';
      return (
        '<div class="lu-forced"><span class="av-glyph" aria-hidden="true">⊘</span>'
        + `<span>No available ${esc(r.pos)} on your bench — <b>${esc(wn.slot)}</b> is filled by `
        + `<b>${esc(r.name)}</b>, who ${esc(r.avail.phrase || 'cannot play')}. `
        + 'Nothing on your roster can start there. Check the waiver wire.</span></div>'
      );
    }).join('');

    // Optimal starting lineup by slot.
    const starterHtml = LINEUP_SLOTS.map((slot) => {
      const id = optimal.slots[slot];
      const r = id ? rowById.get(id) : null;
      if (!r) {
        return `<div class="lu-row lu-row--empty"><span class="lu-slot">${SLOT_LABEL[slot]}</span>`
          + '<span class="lu-name">— no eligible player —</span><span class="lu-pts">0.0</span></div>';
      }
      const byeTag = r.onBye ? ' <span class="lu-bye" title="On bye this week">BYE</span>' : '';
      const chip = renderAvailChip(r.avail, { sm: true });
      const forced = forcedSlots.has(slot);
      return (
        `<div class="lu-row${r.onBye ? ' lu-row--bye' : ''}${forced ? ' lu-row--forced' : ''}">`
        + `<span class="lu-slot">${SLOT_LABEL[slot]}</span>`
        + `<span class="lu-name">${esc(r.name)}${byeTag}${chip ? ` ${chip}` : ''} `
          + `<span class="lu-meta">${esc(r.pos)} · <span style="color:${teamTint(r.team)}">${esc(r.team)}</span></span></span>`
        + `<span class="lu-pts">${fix1(r.pts)}</span>`
        + '</div>'
      );
    }).join('');

    // Start/sit moves — honest net gain of going optimal, with the START set
    // (each into the slot it fills) and the SIT set. No misleading 1:1 pairing:
    // an incoming WR and an outgoing RB don't compete, only the net matters.
    const slotOf = (id) => LINEUP_SLOTS.find((s) => optimal.slots[s] === id) || 'FLEX';

    // "This player is unavailable — X starts instead." Availability is WHY, points
    // are HOW MUCH, so the reason is rendered above the net-gain line. One note per
    // sit caused by unavailability, mapped through the manager's own slot.
    const mgrSlotOf = new Map();
    for (const s of STARTER_SLOTS) {
      const sid = slots[s]; if (sid) mgrSlotOf.set(String(sid), s);
    }
    const swapNotes = moves.sit
      .map((outId) => {
        const out = rowById.get(outId);
        if (!out || out.avail.playable !== false || !out.avail.phrase) return '';
        const mgrSlot = mgrSlotOf.get(String(outId));
        const inId = mgrSlot ? optimal.slots[mgrSlot] : null;
        if (!inId || inId === outId) return '';
        const inRow = rowById.get(inId);
        return (
          '<div class="lu-swapnote"><span class="av-glyph" aria-hidden="true">⊘</span>'
          + `<b>${esc(out.name)}</b> ${esc(out.avail.phrase)} — `
          + `<b>${esc(inRow ? inRow.name : inId)}</b> starts at ${esc(mgrSlot)} instead.</div>`
        );
      }).join('');

    let movesHtml;
    if (moves.start.length === 0 && warnings.length === 0) {
      movesHtml = '<div class="lu-optimal">✓ Your starting lineup is already optimal for Week ' + wk + '.</div>';
    } else if (moves.start.length === 0) {
      // There is nothing better to do, but "optimal" would be a lie over a lineup
      // containing a player who cannot take a snap. Say what is actually true.
      const n = warnings.length;
      movesHtml = swapNotes
        + `<div class="lu-optimal lu-gap">Your lineup is the best your roster allows this week, but `
        + `${n} slot${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} filled by `
        + `${n === 1 ? 'a player' : 'players'} who can’t play.</div>`;
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
      movesHtml = swapNotes
        + `<div class="lu-move lu-move--net">Switching to the optimal lineup adds `
        + `<b class="lu-move-gain">+${fix1(moves.netGain)} pts</b> this week.</div>`
        + startRows + sitRows;
    }

    // Bench (non-starters), sorted by this week's projection.
    const benchHtml = optimal.bench
      .map((id) => rowById.get(id))
      .filter(Boolean)
      .sort((a, b) => b.pts - a.pts)
      .map((r) => {
        // An unavailable bench player is a fact, not a task — same recede as a bye.
        const chip = renderAvailChip(r.avail, { sm: true });
        const un = r.avail.playable === false ? ' lu-row--unavail' : '';
        return (
          `<div class="lu-row lu-row--bench${un}">`
          + `<span class="lu-slot">BN</span>`
          + `<span class="lu-name">${esc(r.name)}${r.onBye ? ' <span class="lu-bye">BYE</span>' : ''}${chip ? ` ${chip}` : ''} `
            + `<span class="lu-meta">${esc(r.pos)} · <span style="color:${teamTint(r.team)}">${esc(r.team)}</span></span></span>`
          + `<span class="lu-pts">${fix1(r.pts)}</span>`
          + '</div>'
        );
      }).join('');

    body.innerHTML =
      '<section class="card lu-card">'
        + `<div class="m-head">OPTIMAL LINEUP · WEEK ${wk} <span class="lu-total">${fix1(optimal.total)} pts</span></div>`
        + forcedHtml
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
