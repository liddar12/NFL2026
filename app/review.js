/* app/review.js — POST-GAME REVIEW (R71): the reader + renderers for data/review.json.
 *
 * Loaded LAZILY (dynamic import() from the slate and parlays views, and from the
 * players view once wired) so it never joins the boot graph the perf budget
 * (tests/perf/budget.spec.mjs) measures. Reads the contract through data.js's
 * loadJson so the promise cache de-dupes it across routes; a 404 (the runner has
 * not produced the file yet) resolves to null and remains retryable; every renderer
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
 *
 * R72 (additive, same file): the SLATE strip becomes a week OVERVIEW
 * ("WK n · R RIGHT · W WRONG · T TBD · Brier b") plus a LEARNING line read
 * verbatim from summary.learning / the document's learning block; PARLAYS gain
 * the five outcome BUCKETS (summary.parlays.buckets + each row's `bucket`) as
 * a tappable filter card and a per-card chip; PLAYERS gain the season tally
 * (players_season) and the per-week delta / verdict readers behind the REVIEW
 * sort. Every count is READ from the document — nothing here recomputes a
 * bucket, a tally or a verdict from legs or rows (the builder is the truth).
 *
 * R75 (additive, parlay section): each parlay card gains its own $100 figure in
 * the card foot, read from the row's `money` block — kind "settled" is what the
 * stake returned on a graded parlay, kind "potential" is what it WOULD return if
 * every leg hit. Both are the BUILDER's arithmetic (scripts/build_review.
 * stamp_parlay_money). R84 replaces legacy money IN MEMORY from the displayed
 * card's original comparison prices, after checking leg identity. All figures
 * are simulations; the same normalized rows supply the card, sort and total.
 *
 * R73 (additive, parlay section): the $100 FLAT-STAKE P&L line, read from
 * summary.parlays.stake_100[scope] ({n, graded, hit, push, staked, net_fair,
 * net_vig2, assumed_price_legs, note}) — pending parlays are excluded by the
 * builder (graded < n), the money is the builder's arithmetic and this file
 * only formats it. DISPLAY ONLY: the dollar figures never feed a model.
 */

import { loadJson } from './data.js';
import { matchingLegs, simulateMoney, simulationBreakdown, SIMULATION_NOTE } from './parlay-simulation.js';

const PATH = '/data/review.json';

/** Prime or reuse the TTL-cached review document. Missing data remains retryable. */
export function primeReview() {
  return loadJson(PATH).then((d) => {
    docSync = d && typeof d === 'object' ? d : null;
    return docSync;
  }, () => { docSync = null; return null; });
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

/**
 * Place a review strip as the list's previous sibling, never inside it: the
 * slate's first list child is a day header by contract (tests/web/web.spec
 * D1/Rel12) and the parlays list is card-only. The view repaints the list's
 * innerHTML on every week switch, so any stale strip is removed first.
 */
function placeStrip(listEl, selector, html) {
  const parent = listEl.parentElement;
  if (!parent) return;
  parent.querySelectorAll(`:scope > ${selector}`).forEach((n) => n.remove());
  if (html) listEl.insertAdjacentHTML('beforebegin', html);
}

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

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * R72 — the LEARNING line, worded from the data and nothing else:
 *   refit on file : "LEARNING: 14 graded locks → game-model refit (n=14, held, 2026-09-14)"
 *   refit null    : "LEARNING: 14 graded locks → refit pending (<note>)"
 * `learn` is the week's summary.learning ({graded_locks, refit|null, note});
 * `top` is the document's learning block ({graded_locks_total, refit|null,
 * consumed_all, note}) and is the fallback when the week carries none. The
 * verdict is the refit's own `verdict` (adopted | held); a refit that shows no
 * verdict and no `adopted: true` is reported HELD — adoption is never assumed.
 * Returns '' when neither block names a graded-lock count.
 */
export function renderLearningLine(learn, top) {
  const src = learn && typeof learn === 'object' ? learn : (top && typeof top === 'object' ? top : null);
  if (!src) return '';
  const graded = isNum(src.graded_locks) ? src.graded_locks
    : (isNum(src.graded_locks_total) ? src.graded_locks_total : null);
  if (graded == null) return '';
  const refit = src.refit && typeof src.refit === 'object' ? src.refit : null;
  let tail;
  if (refit) {
    const verdict = (refit.verdict === 'adopted' || refit.verdict === 'held')
      ? refit.verdict : (refit.adopted === true ? 'adopted' : 'held');
    const parts = [];
    if (isNum(refit.n_resolved)) parts.push(`n=${refit.n_resolved}`);
    parts.push(verdict);
    if (typeof refit.archived_utc === 'string' && refit.archived_utc) parts.push(refit.archived_utc.slice(0, 10));
    tail = `game-model refit (${parts.join(', ')})`;
  } else {
    const note = typeof src.note === 'string' ? src.note.trim() : '';
    tail = note ? `refit pending (${note})` : 'refit pending';
  }
  return `LEARNING: ${graded} graded locks → ${tail}`;
}

/** "WK 1 · 8 RIGHT · 4 WRONG · 2 TBD · Brier 0.48" (Brier omitted when null). */
export function overviewText(week, picks) {
  if (!picks || !isNum(picks.right) || !isNum(picks.wrong) || !isNum(picks.tbd)) return '';
  const brier = picks.brier == null ? '' : ` · Brier ${Number(picks.brier).toFixed(2)}`;
  return `WK ${week} · ${picks.right} RIGHT · ${picks.wrong} WRONG · ${picks.tbd} TBD${brier}`;
}

/**
 * R72 — the week OVERVIEW strip for the slate. Renders whenever the week block
 * carries the R72 picks shape (right / wrong / tbd) — a TBD-only week shows
 * "0 RIGHT · 0 WRONG · 16 TBD" — with the LEARNING line beneath it. A document
 * still in the R71 shape falls back to the R71 strip, unchanged.
 */
export function renderWeekOverview(week, summary, topLearning) {
  const ov = overviewText(week, summary && summary.picks);
  const learn = renderLearningLine(summary && summary.learning, topLearning);
  if (!ov) {
    const legacy = renderReviewStrip(week, summary);
    if (!learn) return legacy;
    if (!legacy) return '';
  }
  const head = ov || `WK ${esc(week)} REVIEW: ${esc(summary.picks.won)}/${esc(summary.picks.n)} picks`;
  return (
    `<div class="rv-strip rv-strip--week" role="status" data-week="${esc(week)}">` +
      `<span class="rv-ov">${esc(head)}</span>` +
      (learn ? `<span class="rv-learn">${esc(learn)}</span>` : '') +
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
  if (!blk) { placeStrip(listEl, '.rv-strip', ''); return; }
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
  placeStrip(listEl, '.rv-strip', renderWeekOverview(week, blk.summary, doc && doc.learning));
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

/** R72 — the five outcome buckets, in display order, with their labels. */
export const BUCKET_ORDER = Object.freeze(['all_hit', 'push', 'partial', 'all_missed', 'pending']);
export const BUCKET_LABEL = Object.freeze({
  all_hit: 'ALL HIT', push: 'PUSH', partial: 'PARTIAL', all_missed: 'ALL MISSED', pending: 'PENDING',
});

/** summary.parlays.buckets for `week` (null when the document has none). */
export function parlayBucketCounts(week, doc = docSync) {
  const blk = weekBlock(doc, week);
  const b = blk && blk.summary && blk.summary.parlays && blk.summary.parlays.buckets;
  return b && typeof b === 'object' ? b : null;
}

/** parlay_id -> bucket for `week`, from each row's own `bucket` field only. */
export function parlayBucketMap(week, doc = docSync) {
  const blk = weekBlock(doc, week);
  const out = new Map();
  ((blk && blk.parlays) || []).forEach((p) => {
    if (p && BUCKET_LABEL[p.bucket]) out.set(String(p.parlay_id), p.bucket);
  });
  return out;
}

/**
 * The bucket summary card: one tappable chip per bucket whose count the
 * document carries, "ALL HIT 12". `active` marks the pressed chip. '' when
 * the document has no buckets (an R71-shaped file), so nothing invents a 0.
 */
export function renderParlayBuckets(week, buckets, active) {
  if (!buckets || typeof buckets !== 'object') return '';
  const chips = BUCKET_ORDER.filter((b) => isNum(buckets[b])).map((b) => {
    const on = b === active;
    return (
      `<button type="button" class="rv-bucket${on ? ' rv-bucket--active' : ''}" ` +
        `data-bucket="${b}" aria-pressed="${on ? 'true' : 'false'}">` +
        `${BUCKET_LABEL[b]} <b class="rv-bucket-n">${esc(buckets[b])}</b></button>`
    );
  }).join('');
  if (!chips) return '';
  return (
    `<div class="rv-buckets" role="group" aria-label="Filter parlays by outcome" data-week="${esc(week)}">` +
      chips +
    '</div>'
  );
}

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

/* R73 — the $100 flat-stake P&L line (display only) ----------------------- */

/** summary.parlays.stake_100[scope] for `week`, or null when the document
 * has none (an R72-shaped file, an unknown week, a scope it did not price). */
export function parlayStake100(week, scope, doc = docSync) {
  const blk = weekBlock(doc, week);
  const s100 = blk && blk.summary && blk.summary.parlays && blk.summary.parlays.stake_100;
  const st = s100 && typeof s100 === 'object' ? s100[scope === 'week' ? 'week' : 'game'] : null;
  return st && typeof st === 'object' ? st : null;
}

/** "+$10,200" / "−$1,250" / "$0" — whole dollars, thousands grouped. */
export function fmtMoney(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v === 0) return '$0';
  const abs = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v > 0 ? '+' : '−'}$${abs}`;
}

/**
 * The P&L line's text, from one stake_100 block:
 *   "WEEK 1 · 16/18 hit · +$10,200 at $100 flat (book vig 2%/leg; fair +$11,564)"
 * A push count rides after the hit ratio only when there is one. '' until the
 * week has a graded parlay (graded > 0) — pending parlays are never counted.
 */
export function pnlLineText(week, st) {
  if (!st || !isNum(st.graded) || st.graded <= 0) return '';
  const hit = isNum(st.hit) ? st.hit : 0;
  const push = isNum(st.push) && st.push > 0 ? ` · ${st.push} push` : '';
  const net = isNum(st.net_fair) ? fmtMoney(st.net_fair) : 'unavailable';
  return `WEEK ${week} · ${hit}/${st.graded} hit${push} · SIM NET ${net} at $100 flat (stake excluded; not actual betting returns)`;
}

/** Name unverified/assumed comparison inputs without inventing a -110 quote. */
export function pnlAssumedText(st) {
  const n = st && isNum(st.assumed_price_legs) ? st.assumed_price_legs : 0;
  if (n <= 0) return '';
  return `${n} leg${n === 1 ? '' : 's'} with assumed or unverified comparison prices`;
}

/** The .rv-pnl line for `week` at `scope`; '' when nothing is graded yet. */
export function renderParlayPnl(week, scope, st) {
  const text = pnlLineText(week, st);
  if (!text) return '';
  const net = isNum(st.net_fair) ? st.net_fair : 0;
  const tone = net > 0 ? 'pos' : (net < 0 ? 'neg' : 'flat');
  const assumed = pnlAssumedText(st);
  return (
    `<div class="rv-pnl rv-pnl--${tone}" role="status" data-week="${esc(week)}" data-scope="${esc(scope)}">` +
      `<span class="rv-pnl-line">${esc(text)}</span>` +
      (assumed ? `<span class="rv-pnl-note">${esc(assumed)}</span>` : '') +
    '</div>'
  );
}

/* R75 — per-parlay money ---------------------------------------------------- */

/** The label under a card's dollar figure — what the money IS, so a quote is
 * never mistaken for a result. */
const PAY_KIND = { settled: '$100 SIM NET · GRADED', potential: '$100 SIM NET · IF HIT' };

/** parlay_id -> the row's own `money` block for `week`. Rows without one are
 * absent from the map (a pre-R75 document paints no money at all). */
export function parlayMoneyMap(week, doc = docSync) {
  const blk = weekBlock(doc, week);
  const out = new Map();
  ((blk && blk.parlays) || []).forEach((p) => {
    const m = p && p.money;
    if (m && typeof m === 'object' && isNum(m.net_fair) && PAY_KIND[m.kind]) {
      out.set(String(p.parlay_id), m);
    }
  });
  return out;
}

/** The tooltip naming this parlay's assumed prices, '' when every leg is priced. */
export function payAssumedText(m) {
  const n = m && isNum(m.assumed_price_legs) ? m.assumed_price_legs : 0;
  return SIMULATION_NOTE + (n > 0 ? ` ${n} leg${n === 1 ? '' : 's'} with assumed or unverified comparison prices.` : '');
}

/** The .pay cell for one card's money block; '' when there is none. */
export function renderPay(m) {
  if (!m || !isNum(m.net_fair) || !PAY_KIND[m.kind]) return '';
  const tone = m.net_fair > 0 ? 'pos' : (m.net_fair < 0 ? 'neg' : 'flat');
  const assumed = payAssumedText(m);
  return (
    `<div class="pay pay--${tone}" data-kind="${esc(m.kind)}"` +
      (assumed ? ` title="${esc(assumed)}"` : '') + '>' +
      `${esc(fmtMoney(m.net_fair))}<span class="k">${PAY_KIND[m.kind]}</span>` +
      `<span class="pay-detail">${esc(simulationBreakdown(m))}</span>` +
    '</div>'
  );
}

/** Mark the painted parlay cards in `listEl` from the week's review. */
export async function applyParlayReview(listEl, week, sourceCards = []) {
  const doc = await primeReview();
  if (!listEl || !listEl.isConnected) return;
  if (listEl.dataset.parlayWeek !== String(week)) return;
  prepareParlaySimulation(week, sourceCards, doc);
  const blk = weekBlock(doc, week);
  if (!blk) { placeStrip(listEl, '.rv-strip--parlay', ''); return; }
  const byId = new Map((blk.parlays || []).map((p) => [String(p.parlay_id), p]));
  listEl.querySelectorAll('.card.parlay[data-parlay-id]').forEach((card) => {
    const p = byId.get(String(card.dataset.parlayId));
    if (!p || card.querySelector('.rv-pchip')) return;
    const source = sourceCards.find((p) => String(p.parlay_id) === String(card.dataset.parlayId));
    const matched = matchingLegs(source, p);
    if (!matched) return; // A reused rank ID is not an immutable card identity.
    const painted = { legs: [...card.querySelectorAll('.legs > .leg')].map((n) => ({
      market: n.dataset.market, selection: n.dataset.selection,
    })) };
    if (!matchingLegs(painted, p)) return;
    const head = card.querySelector('.p-head');
    if (head) {
      const chip = document.createElement('span');
      chip.className = `rv-pchip rv-pchip--${p.result}`;
      chip.textContent = String(p.result).toUpperCase();
      head.appendChild(chip);
      // R72 — the row's own bucket, never recomputed from its legs here.
      if (BUCKET_LABEL[p.bucket]) {
        const b = document.createElement('span');
        b.className = `rv-bchip rv-bchip--${p.bucket}`;
        b.textContent = BUCKET_LABEL[p.bucket];
        head.appendChild(b);
        card.dataset.rvBucket = p.bucket;
      }
    }
    card.classList.add('rv-parlay', `rv-parlay--${p.result}`);
    card.dataset.rvResult = p.result;
    // R75 — the card's own $100 figure, beside MODEL EV in the foot. The sort
    // control reads dataset.rvPay, so it sorts the number the card shows.
    const foot = card.querySelector('.p-foot');
    const pay = renderPay(p.money);
    if (foot && pay) {
      foot.querySelector('.pay')?.remove();
      foot.insertAdjacentHTML('beforeend', pay);
      card.dataset.rvPay = String(p.money.net_fair);
      card.dataset.rvPayKind = p.money.kind;
    }
    const legNodes = card.querySelectorAll('.legs > .leg');
    matched.forEach((leg, i) => {
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
  placeStrip(listEl, '.rv-strip--parlay', renderParlaySummary(week, blk.summary));
}

/** Reprice legacy review money from the actual displayed card, never old -110 totals.
 * Composition mismatches are withheld rather than transferring another card's grade.
 * This only normalizes the in-memory view; historical JSON receipts stay untouched. */
export function prepareParlaySimulation(week, cards, doc = docSync) {
  const blk = weekBlock(doc, week);
  if (!blk) return;
  const sources = new Map(cards.map((p) => [String(p.parlay_id), p]));
  for (const row of blk.parlays || []) {
    const source = sources.get(String(row.parlay_id));
    const outcomes = matchingLegs(source, row);
    row.money = source && outcomes ? simulateMoney(source.legs, outcomes) : null;
  }
  const summary = blk.summary?.parlays;
  if (!summary) return;
  summary.stake_100 = Object.fromEntries(['game', 'week'].map((scope) => {
    const rows = (blk.parlays || []).filter((r) => r.scope === scope);
    const graded = rows.filter((r) => r.bucket !== 'pending');
    const complete = graded.every((r) => isNum(r.money?.net_fair));
    return [scope, { n: rows.length, graded: graded.length,
      hit: graded.filter((r) => r.bucket === 'all_hit').length,
      push: graded.filter((r) => r.bucket === 'push').length,
      staked: graded.length * 100,
      net_fair: graded.length && complete ? graded.reduce((s, r) => s + r.money.net_fair, 0) : null,
      net_vig2: null, assumed_price_legs: graded.reduce((s, r) => s + (r.money?.assumed_price_legs || 0), 0) }];
  }));
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
    const row = rowIndex(doc, wk).get(String(gsisId));
    if (row) return row;
  }
  return null;
}

// R72 — gsis_id -> row per (document, week), built once: the REVIEW sort reads
// a row per player per paint, and a linear find over 200 rows x 300 players
// per repaint is work the phone does not need to do.
const rowIndexes = new WeakMap();
function rowIndex(doc, wk) {
  let byWeek = rowIndexes.get(doc);
  if (!byWeek) { byWeek = new Map(); rowIndexes.set(doc, byWeek); }
  let idx = byWeek.get(wk);
  if (!idx) {
    idx = new Map();
    const blk = doc.weeks[wk];
    ((blk && blk.players) || []).forEach((p) => {
      if (p && p.gsis_id != null && !idx.has(String(p.gsis_id))) idx.set(String(p.gsis_id), p);
    });
    byWeek.set(wk, idx);
  }
  return idx;
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

/* --------------------------------------------------------------------------
 * PLAYERS — R72: the REVIEW sort's readers and the season tally.
 * ------------------------------------------------------------------------ */

/** Weeks (ascending numbers) whose block carries at least one graded player row. */
export function gradedPlayerWeeks(doc = docSync) {
  if (!doc || !doc.weeks) return [];
  return Object.keys(doc.weeks)
    .filter((w) => Array.isArray(doc.weeks[w].players) && doc.weeks[w].players.length > 0)
    .map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

/** The row's verdict for `week` (over | met | under | dnp) or null when no row. */
export function playerReviewVerdict(gsisId, week, doc = docSync) {
  const row = playerReviewRow(gsisId, week, doc);
  return row && row.verdict != null ? String(row.verdict) : null;
}

/** The row's delta for `week`; null when no row or the row has none (DNP). */
export function playerReviewDelta(gsisId, week, doc = docSync) {
  const row = playerReviewRow(gsisId, week, doc);
  return row && isNum(row.delta) ? row.delta : null;
}

/**
 * Comparator over two deltas for the REVIEW sort: biggest over-performance
 * first under 'desc' (the default), reversed under 'asc'; a null delta sorts
 * LAST either way and two nulls compare equal (0), so a stable sort keeps
 * their incoming relative order.
 */
export function compareReviewDelta(a, b, dir = 'desc') {
  const an = !isNum(a);
  const bn = !isNum(b);
  if (an || bn) return an - bn;
  const d = b - a;
  return dir === 'asc' ? -d : d;
}

/** The players_season entry for one player, or null. */
export function seasonEntry(gsisId, doc = docSync) {
  const ps = doc && doc.players_season;
  const e = ps && typeof ps === 'object' ? ps[String(gsisId)] : null;
  return e && typeof e === 'object' ? e : null;
}

/** "3 MET · 1 OVER · 1 UNDER" from a players_season entry ('' when nothing graded). */
export function seasonTallyText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [];
  for (const [k, label] of [['met', 'MET'], ['over', 'OVER'], ['under', 'UNDER'], ['dnp', 'DNP']]) {
    if (isNum(entry[k]) && entry[k] > 0) parts.push(`${entry[k]} ${label}`);
  }
  return parts.join(' · ');
}

/** The season tally chip for a card, or '' when the player has no graded week. */
export function renderSeasonTally(gsisId, doc = docSync) {
  const e = seasonEntry(gsisId, doc);
  const text = seasonTallyText(e);
  if (!text) return '';
  const weeks = isNum(e.weeks) ? e.weeks : null;
  const title = weeks == null ? 'season vs the calibrated week band'
    : `${weeks} graded week${weeks === 1 ? '' : 's'} vs the calibrated week band`;
  return `<span class="rv-tally" data-gsis="${esc(gsisId)}" title="${esc(title)}">${esc(text)}</span>`;
}

/**
 * The REVIEW sort's per-mount state for the players view: the graded weeks,
 * the selected week (default = the latest graded) and the verdict chips that
 * are on (default all). null when no week has a graded player row, which is
 * what hides the sort chip. Kept here, off the boot graph, with the controls.
 */
export const REVIEW_VERDICTS = Object.freeze(['over', 'met', 'under']);
export function reviewState(doc = docSync) {
  const weeks = gradedPlayerWeeks(doc);
  if (!weeks.length) return null;
  return { weeks, week: weeks[weeks.length - 1], on: new Set(REVIEW_VERDICTS) };
}

/** Under the REVIEW filter: a graded row passes when its verdict chip is on;
 * rows the week did not grade (and DNP) always pass and sort last. */
export function verdictPasses(gsisId, rv, doc = docSync) {
  if (rv.on.size >= REVIEW_VERDICTS.length) return true;
  const v = playerReviewVerdict(gsisId, rv.week, doc);
  return !REVIEW_VERDICTS.includes(v) || rv.on.has(v);
}

/** The controls: a WK chip per graded week (single-select) and the OVER / MET /
 * UNDER verdict chips (multi-select), from a reviewState(). */
export function renderReviewControls(rv) {
  if (!rv || !Array.isArray(rv.weeks) || !rv.weeks.length) return '';
  const wk = rv.weeks.map((w) => {
    const on = Number(w) === Number(rv.week);
    return (
      `<button type="button" class="rv-wk${on ? ' rv-wk--active' : ''}" ` +
        `data-rv-week="${esc(w)}" aria-pressed="${on ? 'true' : 'false'}">WK ${esc(w)}</button>`
    );
  }).join('');
  const on = rv.on instanceof Set ? rv.on : new Set(rv.on || []);
  const vc = REVIEW_VERDICTS.map((v) => (
    `<button type="button" class="rv-vchip rv-vchip--${v}${on.has(v) ? ' rv-vchip--active' : ''}" ` +
      `data-rv-verdict="${v}" aria-pressed="${on.has(v) ? 'true' : 'false'}">${v.toUpperCase()}</button>`
  )).join('');
  return (
    '<div class="rv-pfilter" role="group" aria-label="Review week and verdict">' +
      `<span class="rv-pfilter-lbl">GRADED WEEK</span>${wk}` +
      `<span class="rv-pfilter-lbl rv-pfilter-lbl--gap">VERDICT</span>${vc}` +
    '</div>'
  );
}

/** Delegate the controls' clicks onto `rv` (week select / verdict toggle),
 * then call onChange(); a tap on the already-selected week is a no-op. */
export function bindReviewControls(host, rv, onChange) {
  host.addEventListener('click', (e) => {
    const wk = e.target.closest('.rv-wk');
    const vc = e.target.closest('.rv-vchip');
    if (wk) {
      const w = Number(wk.dataset.rvWeek);
      if (!Number.isFinite(w) || w === rv.week) return;
      rv.week = w;
    } else if (vc) {
      const v = vc.dataset.rvVerdict;
      if (rv.on.has(v)) rv.on.delete(v); else rv.on.add(v);
    } else {
      return;
    }
    onChange();
  });
}
