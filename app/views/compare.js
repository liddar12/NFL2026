/* app/views/compare.js — HEAD-TO-HEAD COMPARE (route #/compare?a=<id>&b=<id>).
 *
 * Phase 2 of the roadmap. A pairwise surface: pick two players and see every
 * decision-relevant metric side by side with the edge called out. It invents
 * nothing — every number already exists in the committed contracts and is read
 * through existing pure helpers (strengthOfSchedule, trendLabel, rosPoints).
 * Stateless + deep-linkable: the two picks live in the hash query, so a
 * comparison is shareable and survives reload with no login and no storage.
 *
 * Each side is either a chosen player or an inline finder. Choosing a player
 * rewrites the hash, which the router replays — no local paint state to drift.
 */

import {
  getPlayerProjections, getPlayerWeekly, getTeamStrength, getPlayerHistory,
} from '../data.js';
import { teamTint, renderTrendChip } from '../render.js';
import { strengthOfSchedule, trendLabel } from '../team-logic.js';
import { rosPoints, nextBye } from '../ros.js';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const fix1 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(1) : '—');

/** Parse a/b out of the hash query (#/compare?a=..&b=..). */
function parsePicks() {
  const hash = window.location.hash || '';
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(q);
  return { a: params.get('a') || '', b: params.get('b') || '' };
}

/** Rewrite the hash query, preserving the other side. Router replays it. */
function setPick(side, id, picks) {
  const next = { ...picks, [side]: id };
  const q = new URLSearchParams();
  if (next.a) q.set('a', next.a);
  if (next.b) q.set('b', next.b);
  window.location.hash = `#/compare${q.toString() ? `?${q}` : ''}`;
}

export default async function mountCompare(el) {
  el.innerHTML = '<div class="state state--loading">Loading compare…</div>';
  const [projRes, weeklyRes, strRes, histRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(), getTeamStrength(), getPlayerHistory(),
  ]);
  if (projRes.status !== 'fulfilled') {
    el.innerHTML = '<div class="state">Compare unavailable — the projection feed did not load.</div>';
    return;
  }
  const players = (projRes.value && Array.isArray(projRes.value.players)) ? projRes.value.players : [];
  const byId = new Map(players.map((p) => [String(p.gsis_id), p]));
  const weekly = (weeklyRes.status === 'fulfilled' && weeklyRes.value && Array.isArray(weeklyRes.value.players))
    ? weeklyRes.value.players : [];
  const weeklyById = new Map(weekly.map((w) => [String(w.gsis_id), w]));
  const teamStrength = (strRes.status === 'fulfilled' && strRes.value && strRes.value.ratings) ? strRes.value : null;
  const historyMap = (histRes.status === 'fulfilled' && histRes.value && histRes.value.players)
    ? histRes.value.players : null;

  const picks = parsePicks();

  function metricsFor(id) {
    const p = byId.get(id);
    if (!p) return null;
    const w = weeklyById.get(id);
    const traj = historyMap && historyMap[id] ? historyMap[id].trajectory : null;
    return {
      id,
      name: p.name || id,
      pos: String(p.position || '').toUpperCase(),
      team: p.team || '',
      proj: Number(p.proj_points) || 0,
      ros: (w && Array.isArray(w.weeks)) ? rosPoints(w.weeks, 1) : null,
      sos: (w && teamStrength) ? strengthOfSchedule(w, teamStrength) : null,
      bye: (w && Array.isArray(w.weeks)) ? nextBye(w.weeks, 1) : null,
      trend: traj ? trendLabel(traj) : null,
      trendVal: traj && Number.isFinite(Number(traj.slope_pts_per_yr)) ? Number(traj.slope_pts_per_yr) : null,
    };
  }

  const A = picks.a ? metricsFor(picks.a) : null;
  const B = picks.b ? metricsFor(picks.b) : null;

  el.innerHTML =
    '<header class="view-head">'
      + '<h1 class="view-title">COMPARE</h1>'
      + '<span class="view-sub">HEAD-TO-HEAD · <span class="est">ESTIMATE</span></span>'
    + '</header>'
    + '<div class="cmp-grid">'
      + colHtml('a', A)
      + '<div class="cmp-mid" id="cmp-mid"></div>'
      + colHtml('b', B)
    + '</div>'
    + (A && B ? '' : '<div class="state">Pick two players to see the head-to-head.</div>');

  // Edge chips down the centre when both sides are chosen.
  if (A && B) {
    const mid = el.querySelector('#cmp-mid');
    mid.innerHTML =
      edge('PROJ', A.proj, B.proj, 'high')
      + edge('RoS', A.ros, B.ros, 'high')
      + edge('TREND', A.trendVal, B.trendVal, 'high')
      + edge('SoS', A.sos, B.sos, 'low')
      + byeEdge(A.bye, B.bye);
  }

  // Wire the two inline finders (delegated).
  wireFinders(el, players, picks);
}

/** One player column: identity + metric values, or an inline finder. */
function colHtml(side, m) {
  if (!m) {
    return (
      `<div class="cmp-col cmp-col--empty" data-side="${side}">`
      + `<input class="cmp-find" data-side="${side}" type="search" placeholder="Search player…" autocomplete="off" />`
      + `<div class="cmp-results" data-side="${side}"></div>`
      + '</div>'
    );
  }
  const row = (label, val) => `<div class="cmp-metric"><span class="cmp-lbl">${label}</span><span class="cmp-v">${val}</span></div>`;
  return (
    `<div class="cmp-col" data-side="${side}">`
    + `<div class="cmp-id"><span class="cmp-name" style="color:${teamTint(m.team)}">${esc(m.name)}</span>`
      + `<span class="cmp-pos">${esc(m.pos)} · ${esc(m.team)}</span>`
      + `<button type="button" class="cmp-swap" data-side="${side}" data-act="cmp-clear">change</button></div>`
    + row('PROJ PTS', fix1(m.proj))
    + row('RoS VALUE', m.ros == null ? '—' : fix1(m.ros))
    + row('TREND', m.trend ? renderTrendChip(m.trend) : '—')
    + row('SoS', m.sos == null ? '—' : `${fix1(m.sos)} <span class="cmp-hint">1 easy · 5 hard</span>`)
    + row('BYE', m.bye == null ? '—' : `W${m.bye}`)
    + '</div>'
  );
}

/** Centre edge chip for a numeric metric. dir 'high' = higher wins, 'low' = lower is easier/cheaper. */
function edge(label, a, b, dir) {
  const av = Number(a); const bv = Number(b);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return `<div class="cmp-edge cmp-edge--na">${label}</div>`;
  const diff = av - bv;
  const eps = 1e-6;
  if (Math.abs(diff) < eps) return `<div class="cmp-edge cmp-edge--even">${label}<br><span class="cmp-even">even</span></div>`;
  const aWins = dir === 'high' ? diff > 0 : diff < 0;
  const mag = Math.abs(Math.round(diff * 10) / 10);
  const word = dir === 'low' ? 'easier' : '';
  return (
    `<div class="cmp-edge">${label}<br>`
    + `<span class="cmp-win cmp-win--${aWins ? 'a' : 'b'}">${aWins ? '◀' : '▶'} ${mag} ${word}</span>`
    + '</div>'
  );
}

function byeEdge(a, b) {
  if (a == null || b == null) return '<div class="cmp-edge cmp-edge--na">BYE</div>';
  if (a === b) return '<div class="cmp-edge cmp-edge--warn">BYE<br><span class="cmp-even">⚠ same</span></div>';
  return '<div class="cmp-edge cmp-edge--even">BYE<br><span class="cmp-even">differ</span></div>';
}

function wireFinders(el, players, picks) {
  el.addEventListener('input', (e) => {
    const input = e.target.closest('.cmp-find');
    if (!input) return;
    const side = input.dataset.side;
    const q = (input.value || '').trim().toLowerCase();
    const box = el.querySelector(`.cmp-results[data-side="${side}"]`);
    if (!box) return;
    if (!q) { box.innerHTML = ''; return; }
    const hits = players.filter((p) => `${p.name} ${p.team} ${p.position}`.toLowerCase().includes(q)).slice(0, 8);
    box.innerHTML = hits.map((p) => (
      `<button type="button" class="cmp-hit" data-act="cmp-pick" data-side="${side}" data-id="${esc(String(p.gsis_id))}">`
      + `${esc(p.name)} <span class="cmp-hit-meta">${esc(String(p.position).toUpperCase())} · ${esc(p.team)}</span></button>`
    )).join('') || '<div class="cmp-none">No match.</div>';
  });
  el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-act="cmp-pick"]');
    if (pick) { setPick(pick.dataset.side, pick.dataset.id, picks); return; }
    const clr = e.target.closest('[data-act="cmp-clear"]');
    if (clr) { setPick(clr.dataset.side, '', picks); }
  });
}
