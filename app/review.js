/* app/review.js — POST-GAME REVIEW (R71): the reader + renderers for data/review.json.
 *
 * Loaded LAZILY (dynamic import() from the slate and parlays views, and from the
 * players view once wired) so it never joins the boot graph the perf budget
 * (tests/perf/budget.spec.mjs) measures. Reads the contract through data.js's
 * loadJson so the promise cache de-dupes it across routes; a 404 (the runner has
 * not produced the file yet) resolves to null ONCE per session and every renderer
 * then paints nothing — no shell, no error.
 *
 * WHAT IT PAINTS (all additive, .rv-* classes only, never touching existing rules):
 *   SLATE   after a FINAL game, a filled green circle on the predicted team when the
 *           pick won, a hollow red ring when it lost, nothing pre-final; a per-week
 *           review strip above the list; tapping a graded card reveals the measured
 *           why and, when present, the AI NARRATIVE line (labeled).
 *   PARLAYS a ✓ / ✗ / – mark per leg, HIT / MISS / PENDING / VOID per parlay, and a
 *           summary line.
 *   PLAYERS renderPlayerReview(gsisId, week) -> markup: the OVER / UNDER / MET / DNP
 *           chip plus the measured why; partition D's players.js calls it.
 *
 * HONESTY: everything shown is the builder's measured attribution
 * (source "measured"); the narrative is display-only, labeled, and never a
 * substitute — when it is absent the measured why still renders.
 */

import { loadJson } from './data.js';

const PATH = '/data/review.json';

let docPromise = null;

/** Prime (or reuse) the review document. Resolves to null when absent; the null is
 * cached for the session so no route re-issues a request the runner cannot yet
 * answer (the perf budget counts every /data/ request). */
export function primeReview() {
  if (!docPromise) {
    docPromise = loadJson(PATH).then((d) => (d && typeof d === 'object' ? d : null), () => null);
  }
  return docPromise;
}

let docSync = null; // the resolved document, for the synchronous player renderer
primeReview().then((d) => { docSync = d; });

/** Escape for innerHTML (the renderers build strings, like app/render.js). */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function weekBlock(doc, week) {
  if (!doc || !doc.weeks) return null;
  return doc.weeks[String(week)] || null;
}

const signed1 = (n) => (n >= 0 ? `+${Number(n).toFixed(1)}` : `−${Math.abs(Number(n)).toFixed(1)}`);

/** The measured why + optional labeled narrative, as a .rv-why panel. */
export function renderWhy(why, narrative, { hidden = true } = {}) {
  if (!why) return '';
  const reasons = Array.isArray(why.reasons) ? why.reasons : [];
  const items = reasons.map((r) => {
    const pts = (r.points == null) ? '' : `<b class="rv-pts">${esc(signed1(r.points))}</b> `;
    return `<li class="rv-reason" data-factor="${esc(r.factor)}">${pts}${esc(r.text)}</li>`;
  }).join('');
  const unattr = (why.unattributed != null && Math.abs(why.unattributed) >= 0.05)
    ? `<li class="rv-reason rv-reason--rest">unattributed ${esc(signed1(why.unattributed))}</li>` : '';
  const omitted = Array.isArray(why.omitted) && why.omitted.length
    ? `<div class="rv-omitted">${esc(why.omitted.join(' · '))}</div>` : '';
  const narr = narrative && narrative.text
    ? '<div class="rv-narr">' +
        '<span class="rv-narr-label">AI NARRATIVE</span> ' +
        `<span class="rv-narr-text">${esc(narrative.text)}</span>` +
      '</div>'
    : '';
  return (
    `<div class="rv-why"${hidden ? ' hidden' : ''}>` +
      `<div class="rv-why-head">WHY · ${esc(String(why.source || 'measured').toUpperCase())}</div>` +
      `<div class="rv-summary">${esc(why.summary || '')}</div>` +
      `<ul class="rv-reasons">${items}${unattr}</ul>` +
      omitted + narr +
    '</div>'
  );
}

/* --------------------------------------------------------------------------
 * SLATE
 * ------------------------------------------------------------------------ */

/** "WK 1 REVIEW: 9/14 picks, Brier 0.21" — only when the week has a result. */
export function renderReviewStrip(week, summary) {
  const p = summary && summary.picks;
  if (!p || !p.n) return '';
  const brier = p.brier == null ? '' : `, Brier ${Number(p.brier).toFixed(2)}`;
  return (
    `<div class="rv-strip" role="status" data-week="${esc(week)}">` +
      `WK ${esc(week)} REVIEW: ${esc(p.won)}/${esc(p.n)} picks${esc(brier)}` +
    '</div>'
  );
}

/**
 * Decorate the painted slate cards in `listEl` for `week`. Idempotent per paint
 * (the view repaints innerHTML on every week switch and calls this again). One
 * delegated click listener per listEl, bound once (the view creates a fresh
 * listEl per mount, so nothing accumulates across mounts).
 */
export async function applySlateReview(listEl, week) {
  const doc = await primeReview();
  if (!listEl || !listEl.isConnected) return;
  const blk = weekBlock(doc, week);
  if (!blk) return;
  const byId = new Map((blk.games || []).map((g) => [String(g.game_id), g]));
  listEl.querySelectorAll('.card.game[data-game-id]').forEach((card) => {
    const g = byId.get(String(card.dataset.gameId));
    if (!g || !g.result || card.querySelector('.rv-dot')) return;
    const side = g.picked === g.home ? '.team--home' : '.team--away';
    const team = card.querySelector(side);
    if (!team) return;
    const dot = document.createElement('span');
    dot.className = `rv-dot rv-dot--${g.result}`;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', `${g.picked} pick ${g.result}`);
    team.appendChild(dot);
    card.classList.add('rv-graded', `rv-graded--${g.result}`);
    card.dataset.rvResult = g.result;
    card.setAttribute('aria-expanded', 'false');
    card.insertAdjacentHTML('beforeend', renderWhy(g.why, g.narrative));
  });
  const strip = renderReviewStrip(week, blk.summary);
  if (strip && !listEl.querySelector('.rv-strip')) {
    listEl.insertAdjacentHTML('afterbegin', strip);
  }
  if (!listEl.dataset.rvBound) {
    listEl.dataset.rvBound = '1';
    listEl.addEventListener('click', (e) => {
      const card = e.target.closest('.card.game.rv-graded');
      if (!card || !listEl.contains(card)) return;
      const why = card.querySelector('.rv-why');
      if (!why) return;
      why.hidden = !why.hidden;
      card.setAttribute('aria-expanded', why.hidden ? 'false' : 'true');
    });
  }
}

/* --------------------------------------------------------------------------
 * PARLAYS
 * ------------------------------------------------------------------------ */

const LEG_MARK = { hit: '✓', miss: '✗', pending: '–', void: '–' };

export function renderParlaySummary(week, summary) {
  const p = summary && summary.parlays;
  if (!p || !p.n) return '';
  return (
    `<div class="rv-strip rv-strip--parlay" role="status" data-week="${esc(week)}">` +
      `WK ${esc(week)} PARLAYS: ${esc(p.hit)}/${esc(p.n)} hit · legs ${esc(p.legs_hit)}/${esc(p.legs_n)}` +
      (p.pending ? ` · ${esc(p.pending)} pending` : '') +
    '</div>'
  );
}

/** Mark the painted parlay cards in `listEl` from the week's review. */
export async function applyParlayReview(listEl, week) {
  const doc = await primeReview();
  if (!listEl || !listEl.isConnected) return;
  const blk = weekBlock(doc, week);
  if (!blk) return;
  const byId = new Map((blk.parlays || []).map((p) => [String(p.parlay_id), p]));
  listEl.querySelectorAll('.card.parlay[data-parlay-id]').forEach((card) => {
    const p = byId.get(String(card.dataset.parlayId));
    if (!p || card.querySelector('.rv-pchip')) return;
    const head = card.querySelector('.p-head');
    if (head) {
      const chip = document.createElement('span');
      chip.className = `rv-pchip rv-pchip--${p.result}`;
      chip.textContent = String(p.result).toUpperCase();
      head.appendChild(chip);
    }
    card.classList.add('rv-parlay', `rv-parlay--${p.result}`);
    card.dataset.rvResult = p.result;
    const legNodes = card.querySelectorAll('.legs > .leg');
    (p.legs || []).forEach((leg, i) => {
      const node = legNodes[i];
      if (!node) return;
      const mark = document.createElement('span');
      mark.className = `rv-leg rv-leg--${leg.result}`;
      mark.textContent = LEG_MARK[leg.result] || '–';
      mark.setAttribute('aria-label', `leg ${leg.result}`);
      if (leg.why) mark.title = leg.why;
      const nm = node.querySelector('.leg-nm');
      if (nm) nm.insertBefore(mark, nm.firstChild);
      else node.insertBefore(mark, node.firstChild);
      node.dataset.rvResult = leg.result;
    });
  });
  const line = renderParlaySummary(week, blk.summary);
  if (line && !listEl.querySelector('.rv-strip--parlay')) {
    listEl.insertAdjacentHTML('afterbegin', line);
  }
}

/* --------------------------------------------------------------------------
 * PLAYERS — markup only; partition D's view decides where it goes.
 * ------------------------------------------------------------------------ */

/** The player's review row for `week` (or his latest reviewed week). */
export function playerReviewRow(gsisId, week, doc = docSync) {
  if (!doc || !doc.weeks) return null;
  const weeks = week != null ? [String(week)]
    : Object.keys(doc.weeks).sort((a, b) => Number(b) - Number(a));
  for (const wk of weeks) {
    const blk = doc.weeks[wk];
    const row = blk && (blk.players || []).find((p) => String(p.gsis_id) === String(gsisId));
    if (row) return row;
  }
  return null;
}

/**
 * OVER / UNDER / MET / DNP chip + the measured why for one player. Synchronous:
 * returns '' until the review document has resolved (primeReview() is kicked
 * off at module load; await it before the first paint for first-paint chips).
 */
export function renderPlayerReview(gsisId, week) {
  const row = playerReviewRow(gsisId, week);
  if (!row) return '';
  const v = String(row.verdict || '');
  const delta = row.delta == null ? '' : ` ${esc(signed1(row.delta))}`;
  return (
    `<div class="rv-player" data-gsis="${esc(row.gsis_id)}" data-week="${esc(row.week)}" data-verdict="${esc(v)}">` +
      `<span class="rv-chip rv-chip--${esc(v)}">WK ${esc(row.week)} ${esc(v.toUpperCase())}${delta}</span>` +
      `<span class="rv-line">${esc(row.actual == null ? 'no played row' : `${row.actual} vs ${row.projected} proj`)}</span>` +
      renderWhy(row.why, row.narrative, { hidden: false }) +
    '</div>'
  );
}
