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
 */

import { getParlays, getScheduleFull } from '../data.js';
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
 * scope + leg-count clicks to re-render the list from data held in closure.
 */
export default async function mountParlays(el) {
  el.innerHTML = '<div class="state state--loading">Loading parlays…</div>';
  let data;
  try {
    data = await getParlays();
  } catch (err) {
    stateMsg(el, 'Parlays unavailable — the parlay feed did not load.');
    return;
  }

  const parlays = (data && Array.isArray(data.parlays)) ? data.parlays : [];
  if (parlays.length === 0) {
    stateMsg(el, 'No parlays built yet.');
    return;
  }

  // Resolve the numeric game_id on each GAME parlay to an "AWAY @ HOME" label
  // (the built parlays carry only the id). Optional adornment: if the schedule
  // feed is absent, cards simply show "GAME PARLAY" with no matchup.
  const matchupById = new Map();
  try {
    const sched = await getScheduleFull();
    if (sched && Array.isArray(sched.games)) {
      sched.games.forEach((g) => matchupById.set(String(g.game_id), `${g.away} @ ${g.home}`));
    }
  } catch (err) {
    /* schedule unavailable — matchup label just omitted, never blank the view */
  }

  const head =
    '<header class="view-head">' +
      '<h1 class="view-title">PARLAYS</h1>' +
      `<span class="view-sub">WEEK ${data.week != null ? data.week : ''} · MODEL EV</span>` +
    '</header>';

  let active = 'game';
  let activeLeg = 'all';

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

  // Render the parlay cards for the active scope + leg filter into #parlays-list.
  function paintList() {
    const filtered = parlays.filter((p) =>
      scopeOf(p) === active
      && (activeLeg === 'all' || legOf(p) === Number(activeLeg)));
    const listEl = el.querySelector('#parlays-list');
    if (!listEl) return;
    listEl.innerHTML = filtered.length
      ? filtered.map((p) => renderParlayCard(p, matchupById)).join('')
      : '<div class="state">No parlays at this leg count.</div>';
    if (filtered.length) annotateLegs(listEl, filtered);
  }

  el.innerHTML =
    head +
    scopeSeg(active) +
    '<div id="leg-controls"></div>' +
    legend() +
    '<div id="parlays-list" class="card-list"></div>';
  paintLegSeg();
  paintList();

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
