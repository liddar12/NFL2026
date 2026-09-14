/* app/views/parlays.js — the PARLAYS view (#/parlays).
 *
 * Fetches built parlays and paints one .card.parlay per parlay, split by scope
 * via a .scopeseg segmented control (GAME / WEEK). GAME shows scope==="game"
 * parlays; WEEK shows scope==="week". The contract guarantees >=3 of each.
 *
 * REL3: a LEG-COUNT selector (.legseg) filters the active scope by number of
 * legs. Same-game (GAME) parlays are 2-leg; cross-game (WEEK) parlays come in
 * 2..7-leg buckets from the pipeline. The selector is built from the leg counts
 * actually present in the active scope (plus ALL), so it never offers an empty
 * bucket. A short .legend explains leg / MODEL / IMPL / EV / tier — see the
 * legend() docblock for the honesty contract behind that wording. Filtering is
 * client-side.
 *
 * R51: every leg carries its pricing honesty on the card (annotateLegs):
 *   - a SPREAD leg shows a NO EDGE chip (the cover model measured below coin-
 *     flip on 2023-25 and the leg is priced flat at 50); the leg's edge_note
 *     from the feed is the chip's tooltip;
 *   - a PROP leg shows a provenance line: calibrated pricing from this week's
 *     projected yards (gate-verified on 2023-25), or "seed pricing" when the
 *     feed says pricing === "seed" (or carries no pricing field at all — a
 *     pre-R51 document was seed-priced by construction).
 *
 * R72: the post-game review's five outcome BUCKETS (all hit / push / partial /
 * all missed / pending) as a summary card ABOVE the list — a sibling painted
 * into #parlay-buckets, never the list's first child — whose chips filter the
 * painted list alongside scope + leg count (tap again to clear). Counts come
 * from summary.parlays.buckets and each card's bucket from its own review row
 * (app/review.js readers); this view never derives a bucket from legs.
 *
 * R73: PARLAY HISTORY. A .wkbar of week chips (the slate's idiom) lists every
 * week in data/parlays/index.json plus the current parlays.json week. The
 * DEFAULT week is parlays.json's own week — the pipeline rule (the earliest
 * week not entirely FINAL) — never the index's current_week, which can lag a
 * run behind; when they differ, parlays.json wins silently. Tapping a past
 * week loads its archive file (data/parlays/2026_wkNN.json, via data.js's
 * promise cache, ONLY on the tap — never on a cold mount) and paints the same
 * cards through the same renderer, so scope, leg count, the R72 buckets and
 * the R71 marks all keep working on the selected week (every review reader is
 * keyed by week). Under the bucket card, the $100 flat-stake P&L line for the
 * active scope, read from summary.parlays.stake_100 (display only). Index
 * absent (404): the current week alone, no chips. Archive absent: a .state
 * message — never a blank page.
 */

import { getParlays, getScheduleFull, getParlaysIndex, getParlayArchive } from '../data.js';
import { renderParlayCard } from '../render.js';

const PROP_MARKETS = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']);
// Tooltip for a spread leg whose feed predates edge_note; the same measured verdict.
const SPREAD_NOTE_FALLBACK =
  'NO EDGE — cover model measured below coin-flip on 2023-25 (scripts/backtest_parlay.py); '
  + 'priced flat until a margin model clears never-regress';
const PROV_CALIBRATED =
  'priced from this week’s projected yards, calibrated on 2023-25 — gate-verified';
const PROV_SEED = 'seed pricing';

/** Paint a plain .state message (empty / error). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/** Segmented control: GAME | WEEK. `active` is the selected scope. */
function scopeSeg(active) {
  const seg = (scope, label) => {
    const on = scope === active;
    return (
      `<button type="button" class="seg-btn${on ? ' seg-btn--active' : ''}" ` +
        `data-seg="${scope}" role="tab" aria-selected="${on ? 'true' : 'false'}" ` +
        `aria-pressed="${on ? 'true' : 'false'}">${label}</button>`
    );
  };
  return (
    '<div class="scopeseg" role="tablist" aria-label="Parlay scope">' +
      seg('game', 'GAME') +
      seg('week', 'WEEK') +
    '</div>'
  );
}

/** Leg-count chips for the counts present in the active scope, plus ALL. */
function legSeg(counts, activeLeg) {
  const chip = (val, label) => {
    const on = String(val) === String(activeLeg);
    return (
      `<button type="button" class="leg-chip${on ? ' leg-chip--active' : ''}" ` +
        `data-leg="${val}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`
    );
  };
  return (
    '<div class="legseg" role="group" aria-label="Filter by number of legs">' +
      chip('all', 'ALL') +
      counts.map((n) => chip(n, `${n} LEG`)).join('') +
    '</div>'
  );
}

/**
 * R73 — the week list for the chips: every week the index names (ascending,
 * de-duplicated) plus the current parlays.json week, which is flagged
 * `current` and carries no archive path when the index does not list it.
 * Returns [] when there is no index (the chips do not render at all).
 */
export function mergeWeekList(index, currentWeek) {
  const rows = index && Array.isArray(index.weeks) ? index.weeks : null;
  if (!rows) return [];
  const byWeek = new Map();
  rows.forEach((r) => {
    const w = Number(r && r.week);
    if (!Number.isInteger(w) || w < 1 || byWeek.has(w)) return;
    byWeek.set(w, {
      week: w,
      path: typeof r.path === 'string' && r.path ? r.path : null,
      closed: r.closed === true,
      current: false,
    });
  });
  const cur = Number(currentWeek);
  if (Number.isInteger(cur) && cur >= 1) {
    const row = byWeek.get(cur) || { week: cur, path: null, closed: false, current: false };
    row.current = true;
    byWeek.set(cur, row);
  }
  return [...byWeek.values()].sort((a, b) => a.week - b.week);
}

/**
 * R73 — the default week: parlays.json's own week whenever it carries one
 * (the pipeline rule), else the index's current_week, else null. The index
 * value is a FALLBACK only: when both exist and differ, parlays.json wins.
 */
export function chooseDefaultWeek(parlaysWeek, indexCurrentWeek) {
  const p = Number(parlaysWeek);
  if (Number.isInteger(p) && p >= 1) return p;
  const i = Number(indexCurrentWeek);
  if (Number.isInteger(i) && i >= 1) return i;
  return null;
}

/** R73 — the conventional archive path for (season, week): 2026_wk01.json —
 * the fallback when an index row carries no `path` (data.js still guards it). */
export function parlayArchivePathFor(season, week) {
  const s = Number(season);
  const w = Number(week);
  if (!Number.isInteger(s) || !Number.isInteger(w) || w < 1) return null;
  return `/data/parlays/${s}_wk${String(w).padStart(2, '0')}.json`;
}

/** The .wkbar chip row for the parlay weeks ('' when there is no index). */
function wkBar(weeks, active) {
  if (!weeks.length) return '';
  const chips = weeks.map((w) => {
    const on = w.week === active;
    const cls = `wk-chip${on ? ' wk-chip--active' : ''}${w.closed ? ' pw-wk--closed' : ''}`;
    return (
      `<button type="button" class="${cls}" data-wk="${w.week}" role="tab" ` +
        `aria-selected="${on ? 'true' : 'false'}"` +
        (w.closed ? ' title="archived week"' : '') +
      `>WK ${w.week}</button>`
    );
  }).join('');
  return `<div class="wkbar pw-wkbar" role="tablist" aria-label="Parlay week">${chips}</div>`;
}

/** "WEEK n · MODEL EV", with an ARCHIVED pill on a closed past week. */
function subText(week, archived) {
  return `WEEK ${week != null ? week : ''} · MODEL EV`
    + (archived ? ' <span class="est pw-archived">ARCHIVED</span>' : '');
}

/** A short glossary so the parlay terms are never unexplained.
 *
 * Every claim here is checked against the builder
 * (scripts/models/parlay_builder.py), the backtest (scripts/backtest_parlay.py)
 * and the shipped feed — this legend once called MODEL EV a "placeholder until
 * live odds" long after the live odds feed was wired (R30b), and until R51 it
 * described a spread model that had never been measured. The truth it states now:
 *   MODEL — our probability, computed with no book input (R30a: a de-vigged
 *           book price may never reach model_prob; the gate reds if it does).
 *           Moneyline = the game model. Spread = 50 flat: the cover model was
 *           measured below coin-flip on 2023-25 (NO EDGE on the leg). Props =
 *           a logistic on this week's projected yards vs the line, calibrated
 *           on 2023-25 under never-regress; a seed-priced leg says so.
 *   IMPL  — the price to beat. Game lines (moneyline/spread) are the book's
 *           real de-vigged prices from the live odds feed; prop legs have no
 *           book feed yet, so their IMPL charges the standard vig to our own
 *           number — a prop leg can therefore never fabricate a positive
 *           single-leg edge. IMPL is display + comparison only, never a model
 *           input.
 *   EV    — combined MODEL ÷ combined IMPL − 1 (_combined_probs): same-game
 *           legs are combined via the measured pairwise-rho correlation table
 *           (2023-25), cross-game (WEEK) legs as independent (rho=0), and the
 *           IMPL side is always the independence product because that is how
 *           books price parlays. Each card carries its own correlation note.
 */
function legend() {
  return (
    '<div class="legend">' +
      '<span class="legend-item"><b>LEG</b> one pick in the parlay — all must hit</span>' +
      '<span class="legend-item"><b>MODEL</b> our model’s probability — computed with '
        + 'no book input. Spread legs are priced flat at 50 (NO EDGE: the cover model '
        + 'measured below coin-flip on 2023-25); prop legs are priced from this week’s '
        + 'projected yards, calibrated on 2023-25 — a seed-priced leg says so</span>' +
      '<span class="legend-item"><b>IMPL</b> the price to beat: the book’s de-vigged '
        + 'line (live odds feed) on game legs; on prop legs, our number plus the '
        + 'standard vig until a prop feed lands. Display only — never a model input</span>' +
      '<span class="legend-item"><b>MODEL EV</b> our combined probability vs the book’s '
        + 'parlay price. Same-game legs are correlation-adjusted (measured rho, 2023-25); '
        + 'cross-game legs are combined as independent — see each card’s note</span>' +
      '<span class="legend-item"><b>TIER</b> confidence: high &gt; medium &gt; low (more legs = lower)</span>' +
      '<span class="legend-item"><b>P&amp;L</b> a $100 flat stake on every graded parlay at the '
        + 'book’s price (2%/leg vig; “fair” = no vig). Display only — never a model input</span>' +
      '<span class="est">ESTIMATE</span>' +
    '</div>'
  );
}

/** Provenance line text for a prop leg from its feed fields. */
function propProvenance(leg) {
  if (leg.pricing === 'calibrated') return PROV_CALIBRATED;
  const note = typeof leg.estimate_note === 'string' ? leg.estimate_note.trim() : '';
  if (note && note !== PROV_SEED) {
    return note.startsWith(PROV_SEED) ? note : `${PROV_SEED} — ${note}`;
  }
  return PROV_SEED;
}

/**
 * R51 — stamp each painted .leg with its pricing honesty. renderParlayCard
 * (app/render.js) paints the contract's four leg fields; the annotations live
 * on the feed's legs and are added here, INSIDE each .leg node so the card's
 * `.legs > *` count still equals the leg count (the leg-count selector relies
 * on it). `filtered` is the parlay list in the exact order the cards were
 * painted.
 */
function annotateLegs(listEl, filtered) {
  const cards = listEl.querySelectorAll('.card.parlay');
  cards.forEach((card, ci) => {
    const parlay = filtered[ci];
    if (!parlay || !Array.isArray(parlay.legs)) return;
    const legNodes = card.querySelectorAll('.legs > .leg');
    parlay.legs.forEach((leg, li) => {
      const node = legNodes[li];
      if (!node) return;
      if (leg.market === 'spread') {
        const chip = document.createElement('span');
        chip.className = 'est leg-noedge';
        chip.textContent = 'NO EDGE';
        chip.title = typeof leg.edge_note === 'string' && leg.edge_note
          ? leg.edge_note : SPREAD_NOTE_FALLBACK;
        const od = node.querySelector('.leg-od');
        if (od) od.insertBefore(chip, od.firstChild);
        else node.appendChild(chip);
      } else if (PROP_MARKETS.has(leg.market)) {
        node.classList.add('leg--annot');
        const prov = document.createElement('div');
        prov.className = 'leg-prov';
        prov.dataset.pricing = leg.pricing === 'calibrated' ? 'calibrated' : 'seed';
        prov.textContent = propProvenance(leg);
        node.appendChild(prov);
      }
    });
  });
}

/**
 * Mount the parlays view. Renders the controls + list once, then rewires
 * scope + leg-count (+ R72 bucket, + R73 week) clicks to re-render the list
 * from data held in closure.
 */
export default async function mountParlays(el) {
  el.innerHTML = '<div class="state state--loading">Loading parlays…</div>';
  // R73 — one allSettled: the current document, the schedule (optional
  // matchup labels) and the history index (optional; 404 = no chips). Archive
  // files are NOT here — they are fetched only when a past week is tapped.
  const [parlaysR, schedR, indexR] = await Promise.allSettled([
    getParlays(), getScheduleFull(), getParlaysIndex(),
  ]);
  if (parlaysR.status !== 'fulfilled') {
    stateMsg(el, 'Parlays unavailable — the parlay feed did not load.');
    return;
  }
  const data = parlaysR.value;

  const curParlays = (data && Array.isArray(data.parlays)) ? data.parlays : [];
  if (curParlays.length === 0) {
    stateMsg(el, 'No parlays built yet.');
    return;
  }

  // Resolve the numeric game_id on each GAME parlay to an "AWAY @ HOME" label
  // (the built parlays carry only the id). Optional adornment: if the schedule
  // feed is absent, cards simply show "GAME PARLAY" with no matchup.
  const matchupById = new Map();
  const sched = schedR.status === 'fulfilled' ? schedR.value : null;
  if (sched && Array.isArray(sched.games)) {
    sched.games.forEach((g) => matchupById.set(String(g.game_id), `${g.away} @ ${g.home}`));
  }

  // R73 — the week list and the default week (parlays.json's, never the index's).
  const index = indexR.status === 'fulfilled' && indexR.value && typeof indexR.value === 'object'
    ? indexR.value : null;
  const curWeek = chooseDefaultWeek(data.week, index && index.current_week);
  const weeks = mergeWeekList(index, curWeek);
  let selWeek = curWeek;
  let parlays = curParlays; // the list being painted (current or an archive)
  let paintSeq = 0;

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PARLAYS</h1>' +
      `<span class="view-sub">${subText(curWeek, false)}</span>` +
    '</header>';

  let active = 'game';
  let activeLeg = 'all';
  // R72 — the pressed bucket chip (null = no bucket filter) and the lazily
  // imported review module once it has resolved (null until then / absent).
  let activeBucket = null;
  let reviewMod = null;
  const reviewP = import('../review.js')
    .then((m) => m.primeReview().then(() => m))
    .catch(() => null);

  const scopeOf = (p) => (p.scope === 'week' ? 'week' : 'game');
  const legOf = (p) => (Array.isArray(p.legs) ? p.legs.length : 0);

  /** Distinct leg counts present in the active scope, ascending. */
  function legCountsForScope() {
    const set = new Set(parlays.filter((p) => scopeOf(p) === active).map(legOf));
    return [...set].sort((a, b) => a - b);
  }

  /** Repaint the leg-count selector for the active scope (keeps the node). */
  function paintLegSeg() {
    const box = el.querySelector('#leg-controls');
    if (!box) return;
    box.innerHTML = legSeg(legCountsForScope(), activeLeg);
  }

  /** R72 — repaint the bucket summary card from the review document. */
  function paintBuckets() {
    const host = el.querySelector('#parlay-buckets');
    if (!host || !reviewMod) return;
    host.innerHTML = reviewMod.renderParlayBuckets(
      selWeek, reviewMod.parlayBucketCounts(selWeek), activeBucket);
  }

  /** R73 — repaint the $100 flat-stake P&L line for the selected week + scope. */
  function paintPnl() {
    const host = el.querySelector('#parlay-pnl');
    if (!host || !reviewMod) return;
    host.innerHTML = reviewMod.renderParlayPnl(
      selWeek, active, reviewMod.parlayStake100(selWeek, active));
  }

  /**
   * R71/R72/R73 — once the lazy review module lands, mark the painted cards
   * for the week they belong to and paint the bucket card + P&L line. Guarded
   * by the week the paint was for: a chip tapped while the import was still
   * pending must not stamp week 1's marks onto week 2's cards (week-scope
   * parlay ids repeat across weeks).
   */
  function paintReview(listEl, week) {
    reviewP.then((mod) => {
      if (!mod || !listEl.isConnected || week !== selWeek) return;
      reviewMod = mod;
      mod.applyParlayReview(listEl, week);
      paintBuckets();
      paintPnl();
    });
  }

  // Render the parlay cards for the active scope + leg filter (+ R72 bucket)
  // into #parlays-list.
  function paintList() {
    const bucketOf = activeBucket && reviewMod ? reviewMod.parlayBucketMap(selWeek) : null;
    const filtered = parlays.filter((p) =>
      scopeOf(p) === active
      && (activeLeg === 'all' || legOf(p) === Number(activeLeg))
      && (!bucketOf || bucketOf.get(String(p.parlay_id)) === activeBucket));
    const listEl = el.querySelector('#parlays-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map((p) => renderParlayCard(p, matchupById)).join('')
      : (bucketOf
        ? '<div class="state">No parlays in that bucket at this scope and leg count.</div>'
        : '<div class="state">No parlays at this leg count.</div>');
    if (filtered.length) annotateLegs(listEl, filtered);
    // R71 — post-game review marks (✓ / ✗ / – per leg, HIT / MISS / PENDING per
    // parlay, a summary line), lazily so app/review.js stays off the boot graph.
    // Absent data/review.json (or a failed import) paints nothing extra.
    // R72 — the same resolved module paints the bucket card once it lands.
    if (reviewMod) { paintBuckets(); paintPnl(); }
    paintReview(listEl, selWeek);
  }

  /** R73 — sync the chips + header to the selected week. */
  function syncWeekChrome(week, archived) {
    el.querySelectorAll('.pw-wkbar .wk-chip').forEach((b) => {
      const on = Number(b.dataset.wk) === week;
      b.classList.toggle('wk-chip--active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const sub = el.querySelector('.view-sub');
    if (sub) sub.innerHTML = subText(week, archived);
  }

  /**
   * R73 — select a week. The current week repaints from parlays.json; a past
   * week loads its archive (cached by data.js) and paints it through the same
   * path. Leg count and bucket reset (their chips are per-week); scope stays.
   */
  async function selectWeek(week) {
    selWeek = week;
    activeLeg = 'all';
    activeBucket = null;
    const entry = weeks.find((w) => w.week === week) || null;
    syncWeekChrome(week, !!(entry && entry.closed && week !== curWeek));
    const seq = ++paintSeq;
    if (week === curWeek) {
      parlays = curParlays;
      paintLegSeg();
      paintList();
      return;
    }
    const listEl = el.querySelector('#parlays-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="state state--loading">Loading week…</div>';
    let doc;
    try {
      const path = (entry && entry.path) || parlayArchivePathFor(index && index.season, week);
      doc = await getParlayArchive(path);
    } catch (err) {
      if (seq !== paintSeq) return;
      parlays = [];
      paintLegSeg();
      stateMsg(listEl, `Week ${week} is not archived — no parlay history for this week yet.`);
      if (reviewMod) { paintBuckets(); paintPnl(); }
      paintReview(listEl, week);
      return;
    }
    if (seq !== paintSeq) return; // a newer selection already painted
    parlays = (doc && Array.isArray(doc.parlays)) ? doc.parlays : [];
    paintLegSeg();
    if (!parlays.length) {
      stateMsg(listEl, `Week ${week} archive holds no parlays.`);
      if (reviewMod) { paintBuckets(); paintPnl(); }
      paintReview(listEl, week);
      return;
    }
    paintList();
  }

  el.innerHTML =
    head +
    wkBar(weeks, selWeek) +
    scopeSeg(active) +
    '<div id="leg-controls"></div>' +
    legend() +
    '<div id="parlay-buckets"></div>' +
    '<div id="parlay-pnl"></div>' +
    '<div id="parlays-list" class="card-list"></div>';
  paintLegSeg();
  paintList();

  // R73 — week chips (event delegation, one listener; a tap on the selected
  // week is a no-op).
  const bar = el.querySelector('.pw-wkbar');
  if (bar) {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.wk-chip');
      if (!btn) return;
      const week = Number(btn.dataset.wk);
      if (!Number.isFinite(week) || week === selWeek) return;
      selectWeek(week);
    });
  }

  // R72 — bucket chips (delegated on the persistent host; tap again clears).
  const bucketBox = el.querySelector('#parlay-buckets');
  if (bucketBox) {
    bucketBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.rv-bucket');
      if (!btn || !reviewMod) return;
      const b = btn.dataset.bucket;
      activeBucket = activeBucket === b ? null : b;
      paintBuckets();
      paintList();
    });
  }

  // Wire the scope control: switching scope resets the leg filter to ALL and
  // rebuilds the leg-count chips for the new scope.
  const seg = el.querySelector('.scopeseg');
  if (seg) {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      active = btn.dataset.seg;
      activeLeg = 'all';
      seg.querySelectorAll('.seg-btn').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('seg-btn--active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintLegSeg();
      paintList();
    });
  }

  // Wire the leg-count selector (delegated on the persistent container).
  const legBox = el.querySelector('#leg-controls');
  if (legBox) {
    legBox.addEventListener('click', (e) => {
      const btn = e.target.closest('.leg-chip');
      if (!btn) return;
      activeLeg = btn.dataset.leg;
      legBox.querySelectorAll('.leg-chip').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('leg-chip--active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintList();
    });
  }
}
