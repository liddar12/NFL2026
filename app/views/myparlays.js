/* app/views/myparlays.js — MY PARLAYS: cards built around players you name.
 *
 * Loaded ONLY when the MY chip in the PARLAYS scope control is tapped, by a
 * dynamic import from app/views/parlays.js. Neither this module nor the ~294 KB
 * leg pool it reads is on the boot graph, and a user who never taps MY never
 * pays for either. That is also why this is a mode inside PARLAYS rather than
 * its own route: a new route costs 644 bytes on a boot graph with 33 to spare,
 * and the feature does not need its own address badly enough to spend the
 * ceiling that has held since R73.
 *
 * WHAT IT DOES. You type one or more players or teams. Every card it offers
 * contains at least one of them; the rest of each card is filled from the pool
 * by conviction, subject to the rules below. Ten cards, two at each leg count
 * from 2 to 6 — ranked purely by conviction a 2-leg card always wins, so the
 * leg-count bands are what make the list worth reading.
 *
 * RANKED BY CONVICTION, NOT EV, and that is forced rather than chosen. There is
 * no player-prop odds feed, so a prop leg's implied price is our own number plus
 * the standard vig (app/parlay-math.impliedFromModel) and its EV is a constant
 * -vig. Ranking props by EV is ranking by nothing. Conviction — the combined
 * model probability — is the only ordering here that carries information. EV is
 * still shown on every card, because it is what the card is worth against its
 * price, and because the game legs DO carry real book prices and can genuinely
 * be positive.
 *
 * THE RULES A CARD MUST SATISFY (each one is a bet not being sold twice):
 *   - at least one leg from a seed you typed, or the card is not yours;
 *   - ONE LEG PER PLAYER. "40+ rec yds" and "20+ rec yds" on the same man is one
 *     opinion twice: clearing 40 clears 20. Same species of error as R74;
 *   - R74 itself, via violatesOnePerSide: a team's moneyline and that team's
 *     spread are one opinion;
 *   - same-game legs are correlation-adjusted, cross-game combined as
 *     independent — the builder's rule, through the shared maths.
 *
 * WHY EACH LEG, MEASURED. Every leg carries a line stating the numbers behind
 * it: the projection against the line, and the team's win probability that the
 * calibration's second term reads. No language model is involved — the product
 * runtime never contacts one (scripts/build_review_narrative.py is the single
 * opt-in exception and runs only on the runner), and a card built from what you
 * typed a second ago cannot have been narrated in advance.
 */

import { loadJson } from '../data.js';
import {
  combinedProbs, confidenceTier, correlationTable, legFromGame, legFromPool,
  modelEv, violatesOnePerSide,
} from '../parlay-math.js';

const POOL_PATH = '/data/leg_pool.json';
const CALIB_PATH = '/data/parlay_backtest.json';
const LEG_COUNTS = [2, 3, 4, 5, 6];
const PER_COUNT = 2;          // two cards per leg count -> ten cards
const BEAM = 24;              // partial cards kept at each step
const POOL_CAP = 220;         // strongest non-seed legs considered, by conviction
const STAKE = 100;

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ---- the searchable universe ------------------------------------------- */

/** Every leg in the pool, flattened: one per player-rung plus each game leg. */
export function poolLegs(pool) {
  const out = [];
  for (const row of (pool && pool.players) || []) {
    for (const rung of row.rungs || []) {
      const leg = legFromPool(row, rung);
      leg.owner = row.gsis_id;          // one leg per player, enforced below
      leg.label = row.player;
      leg.mu = row.mu;
      leg.line = rung.line;
      leg.position = row.position;
      // R77 — a QUESTIONABLE player stays in the pool at his full price (Q is
      // priced + labelled; DOUBTFUL and worse never reach the pool). The flag
      // rides the leg so the card can say so, and it changes no number.
      if (row.availability) leg.availability = row.availability;
      out.push(leg);
    }
  }
  for (const g of (pool && pool.game_legs) || []) {
    const leg = legFromGame(g);
    leg.owner = `team:${g.team || g.selection}`;
    leg.label = g.team || g.selection;
    out.push(leg);
  }
  return out;
}

/** Seed suggestions: every player and every team the pool can actually price. */
export function seedOptions(pool) {
  const players = new Map();
  const teams = new Map();
  for (const row of (pool && pool.players) || []) {
    if (row.player) players.set(row.gsis_id, { kind: 'player', id: row.gsis_id,
      name: row.player, team: row.team, position: row.position });
    if (row.team) teams.set(row.team, { kind: 'team', id: `team:${row.team}`, name: row.team });
  }
  for (const g of (pool && pool.game_legs) || []) {
    if (g.team) teams.set(g.team, { kind: 'team', id: `team:${g.team}`, name: g.team });
  }
  return [...players.values()].sort((a, b) => a.name.localeCompare(b.name))
    .concat([...teams.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

/** Does this leg belong to one of the seeds? Teams match their players too. */
export function matchesSeed(leg, seeds) {
  for (const s of seeds) {
    if (s.kind === 'player' && leg.owner === s.id) return true;
    if (s.kind === 'team' && (leg.team === s.name || leg.owner === s.id)) return true;
  }
  return false;
}

/* ---- the search --------------------------------------------------------- */

/** Two legs may not sit in one card when they are the same opinion twice. */
function compatible(legs, next) {
  for (const leg of legs) {
    if (leg.owner === next.owner) return false;      // one leg per player / team
    if (leg.selection === next.selection) return false;
  }
  return !violatesOnePerSide([...legs, next]);
}

/** Conviction: the combined model probability, correlation-aware within a game. */
export function conviction(legs, table) {
  const sameGame = legs.every((l) => l.game_id && l.game_id === legs[0].game_id);
  return combinedProbs(legs, sameGame, table)[0];
}

/** Everything a card shows, from its legs alone. */
export function scoreCard(legs, table) {
  const sameGame = legs.length > 1
    && legs.every((l) => l.game_id && l.game_id === legs[0].game_id);
  const [model, implied] = combinedProbs(legs, sameGame, table);
  const decimal = implied > 0 ? 1 / implied : 0;
  return {
    legs,
    model,
    implied,
    ev: modelEv(model, implied),
    tier: confidenceTier(model, implied, legs.length),
    sameGame,
    // What $100 would return if every leg hit, at the prices shown. A price, not
    // a result: these cards are never graded, so there is no realized figure.
    payout: decimal > 0 ? STAKE * (decimal - 1) : 0,
    assumed: legs.filter((l) => !l.priced).length,
  };
}

/**
 * Top cards containing at least one seed leg.
 *
 * Beam search rather than enumeration: 1,400+ legs choose 6 is astronomical, and
 * the greedy frontier finds the same high-conviction cards because conviction is
 * monotone decreasing as legs are added — the best 6-leg card is built from
 * strong 5-leg prefixes. BEAM keeps enough alternatives that a leg blocked by
 * the one-per-player or R74 rules does not dead-end the whole branch.
 */
export function buildCards(legs, seeds, table, opts = {}) {
  const perCount = opts.perCount || PER_COUNT;
  const counts = opts.counts || LEG_COUNTS;
  const seedLegs = legs.filter((l) => matchesSeed(l, seeds));
  if (!seedLegs.length) return [];

  const byConviction = (a, b) => b.model_prob - a.model_prob;
  const others = legs.filter((l) => !matchesSeed(l, seeds))
    .sort(byConviction).slice(0, opts.poolCap || POOL_CAP);
  const candidates = seedLegs.slice().sort(byConviction).concat(others);

  let beam = seedLegs.slice().sort(byConviction).slice(0, BEAM).map((l) => [l]);
  const out = [];
  const maxLegs = Math.max(...counts);
  for (let size = 2; size <= maxLegs; size += 1) {
    const grown = [];
    for (const partial of beam) {
      for (const next of candidates) {
        if (!compatible(partial, next)) continue;
        grown.push([...partial, next]);
      }
    }
    if (!grown.length) break;
    grown.sort((a, b) => conviction(b, table) - conviction(a, table));
    // de-dupe: the same set of legs reached by different orders is one card
    const seen = new Set();
    beam = [];
    for (const card of grown) {
      const key = card.map((l) => l.selection).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      beam.push(card);
      if (beam.length >= BEAM) break;
    }
    if (counts.includes(size)) {
      out.push(...beam.slice(0, perCount).map((c) => scoreCard(c, table)));
    }
  }
  return out;
}

/* ---- rendering ---------------------------------------------------------- */

/** The measured reason this leg is on the card. Numbers only, no adjectives. */
export function whyLine(leg) {
  if (leg.market === 'moneyline' || leg.market === 'spread') {
    return `book price ${Math.round(leg.implied_prob * 100)} vs our ${Math.round(leg.model_prob * 100)}`;
  }
  const mu = Number(leg.mu);
  if (!Number.isFinite(mu) || !Number.isFinite(Number(leg.line))) return '';
  const gap = mu - Number(leg.line);
  // One decimal on all three, so the numbers on screen RECONCILE. Rounding the
  // gap to an integer beside un-rounded operands prints arithmetic that does not
  // add up (70 vs a 39.5 line reading "+31"), which is a small lie in a product
  // whose whole claim is that every number is checkable.
  return `projects ${mu.toFixed(1)} vs a ${Number(leg.line).toFixed(1)} line `
    + `(${gap >= 0 ? '+' : ''}${gap.toFixed(1)})`;
}

const money = (n) => {
  const v = Math.round(n);
  const abs = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '−' : '+'}$${abs}`;
};

/** R77 — the same Q chip PARLAYS paints in annotateLegs, same copy, same tone. */
const qChip = (l) => (l.availability === 'QUESTIONABLE'
  ? '<span class="est leg-q" title="Questionable — game-time decision">Q</span>' : '');

export function renderCard(card, i) {
  const pct = (p) => Math.round(p * 100);
  const evCls = card.ev >= 0 ? 'ev--pos' : 'ev--neg';
  // R82 — `leg--annot` (flex-wrap:wrap) is REQUIRED here, not decorative. Every
  // leg on a MY card carries a why-line, and `.leg-prov` is flex-basis:100% by
  // design: without the wrap it stays on the name's flex line and, being
  // shrinkable, eats it — measured 62px of a 155px name at 1280px, and 54px at
  // 402px, where the name then stacked one word per line (5 lines, a 106px leg).
  // PARLAYS adds the same class in annotateLegs; this list never did.
  const legs = card.legs.map((l) => (
    '<div class="leg leg--annot">'
      + `<div class="leg-nm">${esc(l.selection)}</div>`
      + '<div class="leg-od">'
        + qChip(l)
        + `<span class="mo">MODEL <b>${pct(l.model_prob)}</b></span>`
        + `<span class="im">${l.priced ? 'IMPL' : 'IMPL*'} ${pct(l.implied_prob)}</span>`
      + '</div>'
      + `<div class="leg-prov">${esc(whyLine(l))}</div>`
    + '</div>'
  )).join('');
  return (
    `<article class="card parlay mp-card" data-mp="${i}" data-scope="my">`
      + '<div class="p-head">'
        + `<span class="lbl">${card.legs.length} LEG · ${card.sameGame ? 'SAME GAME' : 'CROSS GAME'}</span>`
        + `<span class="tier tier--${esc(card.tier)}">${esc(card.tier.toUpperCase())}</span>`
      + '</div>'
      + `<div class="legs">${legs}</div>`
      + '<div class="p-foot">'
        + `<div class="ev ${evCls}">${pct(card.model)}<span class="k">CONVICTION</span></div>`
        + `<div class="legcount">${(card.ev * 100).toFixed(1)}% EV</div>`
        + `<div class="pay">${money(card.payout)}<span class="k">$100 PAYS</span></div>`
      + '</div>'
      + (card.assumed
        ? `<div class="corr"><span class="lk" aria-hidden="true">*</span><span>`
          + `${card.assumed} leg${card.assumed === 1 ? '' : 's'} has no book price — `
          + `IMPL* is our number plus the standard vig, so its EV is the vig. `
          + `Display only.</span></div>`
        : '')
    + '</article>'
  );
}

/* ---- mount -------------------------------------------------------------- */

const state = { seeds: [], pool: null, table: null, legs: null };

function renderSeeds() {
  if (!state.seeds.length) return '';
  return '<div class="legseg mp-seeds">' + state.seeds.map((s) => (
    `<button type="button" class="leg-chip leg-chip--active" data-drop="${esc(s.id)}" `
    + `aria-label="Remove ${esc(s.name)}">${esc(s.name)} ✕</button>`
  )).join('') + '</div>';
}

function paint(el) {
  const list = el.querySelector('#mp-list');
  const seedBox = el.querySelector('#mp-seeds');
  if (seedBox) seedBox.innerHTML = renderSeeds();
  if (!list) return;
  if (!state.seeds.length) {
    list.innerHTML = '<div class="state">Type a player or a team above — every card '
      + 'we build will contain at least one of them.</div>';
    return;
  }
  const cards = buildCards(state.legs, state.seeds, state.table);
  list.innerHTML = cards.length
    ? cards.map(renderCard).join('')
    : '<div class="state">No card can be built from those names this week — '
      + 'the pool has no line we can price for them without guessing.</div>';
}

/**
 * Mount MY PARLAYS into `el`.
 *
 * R82 — RESOLVES TO THE POOL'S WEEK (or null when the pool would not load).
 * app/views/parlays.js owns the header and titles MY mode "MY PARLAYS · POOL
 * WK n"; n is the week the leg pool was built for, which is this module's
 * document to read, not the header's. Returning it is cheaper than exporting
 * the loaded pool — the caller needs one number and must not hold the ~294 KB
 * document alive after the tab is closed.
 */
export default async function mountMyParlays(el) {
  el.innerHTML = '<div class="state state--loading">Loading the leg pool…</div>';
  const [poolR, calibR] = await Promise.allSettled([
    loadJson(POOL_PATH), loadJson(CALIB_PATH),
  ]);
  if (poolR.status !== 'fulfilled' || !poolR.value) {
    el.innerHTML = '<div class="state">My Parlays unavailable — the leg pool has '
      + 'not been built yet.</div>';
    return null;
  }
  state.pool = poolR.value;
  state.table = correlationTable(calibR.status === 'fulfilled' ? calibR.value : null);
  state.legs = poolLegs(state.pool);
  const options = seedOptions(state.pool);
  const byName = new Map(options.map((o) => [o.name.toLowerCase(), o]));

  el.innerHTML =
    '<div class="mp-head">'
      + '<label class="mp-label" for="mp-input">PLAYERS OR TEAMS</label>'
      + '<input id="mp-input" class="mp-input" list="mp-opts" autocomplete="off" '
        + 'placeholder="e.g. J. Jefferson, KC" aria-describedby="mp-note">'
      + `<datalist id="mp-opts">${options.map((o) => `<option value="${esc(o.name)}">`).join('')}</datalist>`
    + '</div>'
    + '<div id="mp-seeds"></div>'
    + `<div class="legend" id="mp-note"><span class="legend-item"><b>CONVICTION</b> our `
      + `combined probability the whole card hits — the ranking, because prop legs `
      + `have no book price and their EV is the vig by construction</span>`
      + `<span class="legend-item"><b>$100 PAYS</b> what a $100 wager returns if every `
      + `leg hits, at the prices shown. Display only — never a model input</span>`
      + `<span class="est">ESTIMATE</span></div>`
    + '<div id="mp-list" class="card-list"></div>';

  const input = el.querySelector('#mp-input');
  const add = () => {
    const opt = byName.get(String(input.value || '').trim().toLowerCase());
    if (!opt || state.seeds.some((s) => s.id === opt.id)) { input.value = ''; return; }
    state.seeds.push(opt);
    input.value = '';
    paint(el);
  };
  input.addEventListener('change', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  el.querySelector('#mp-seeds').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-drop]');
    if (!btn) return;
    state.seeds = state.seeds.filter((s) => s.id !== btn.dataset.drop);
    paint(el);
  });
  paint(el);
  // R82 — the pool's own week, for the MY-mode subtitle the header paints.
  const wk = Number(state.pool.week);
  return Number.isFinite(wk) ? wk : null;
}
