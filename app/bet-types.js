/* app/bet-types.js — R133: the BET TYPE selector and the cards it builds, on
 * WEEK and GAME.
 *
 * Owner (2026-10-17, two rounds):
 *   - PUBLISHED is the curated slate (graded, the record; the default). ALL and
 *     the kind chips — ANYTIME TD, PASSING, RUSHING, RECEIVING, MONEYLINE,
 *     multi-select — BUILD cards live from the leg pool. Browser-only: not
 *     recorded, not graded, never counted in the ALL HIT buckets.
 *   - Each player offers his MOST LIKELY line (highest win chance), and the
 *     card is FORCED TO MIX: it carries as many different chosen kinds as it
 *     has legs (min(n, kinds)). The first round's rule (the hardest line still
 *     at 50%+) left every prop near 50-60% and a 65-84% moneyline won every
 *     game's slot, so "ALL" and "+ MONEYLINE" read as moneyline-only cards.
 *   - Whenever MONEYLINE is chosen (ALL included), the two most likely
 *     moneyline-only cards are shown too, in their own section.
 *   - The mixed cards sort by MOST LIKELY (default) or BIGGEST PAYOUT.
 *   - GAME: one game, picked from a dropdown, 2-7 legs from it. Three or more
 *     same-game legs have no backtested joint price (RCA F03), so the chance is
 *     an ESTIMATE that chains the measured pair correlations, and says so.
 *   - O/U and spread are not offered: no game-total model exists, and a spread
 *     is a flat 0.5 the model holds no opinion on (R109/R126).
 *
 * The confidence of a leg is its own model chance, cut at the MY dial's lines:
 * HIGH >= 0.65 (SAFE), MEDIUM >= 0.50 (EVEN), LOW below. Each leg box is
 * outlined green / yellow / red by it.
 *
 * Pure apart from two guarded localStorage touches, like app/atd-cards.js.
 */

import {
  combineTwo, correlationTable, legFromGame, legFromPool, pairRho, sameSideGamePair,
} from './parlay-math.js';
import { breakEven, pctText } from './atd-cards.js';

export const BET_TYPES = [
  ['atd', 'ANYTIME TD', 'anytime_td'],
  ['pass', 'PASSING', 'qb_pass_yds'],
  ['rush', 'RUSHING', 'rb_rush_yds'],
  ['rec', 'RECEIVING', 'wr_rec_yds'],
  ['ml', 'MONEYLINE', 'moneyline'],
];
const ALL_KEYS = BET_TYPES.map(([k]) => k);
const MARKET_OF = Object.fromEntries(BET_TYPES.map(([k, , m]) => [k, m]));
const KEY_OF = Object.fromEntries(BET_TYPES.map(([k, , m]) => [m, k]));
const LABEL_OF = Object.fromEntries(BET_TYPES.map(([k, l]) => [k, l]));

export const MIN_LEGS = 2;
export const MAX_LEGS = 10;
export const GAME_MAX_LEGS = 7;
export const MIX_CARDS = 6;
export const ML_CARDS = 2;
export const CONF_HIGH = 0.65;
export const CONF_MEDIUM = 0.50;
export const SORTS = [['likely', 'MOST LIKELY'], ['payout', 'BIGGEST PAYOUT']];

const KEY = 'nfl2026.parlays.types.v1';
export const DEFAULT_STATE = { types: [], legs: 'all', sort: 'likely' };

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HIGH / MEDIUM / LOW for one leg's model chance (null for no number). */
export function confTag(p) {
  if (p == null || p === '') return null;
  const v = Number(p);
  if (!Number.isFinite(v)) return null;
  if (v >= CONF_HIGH) return 'high';
  if (v >= CONF_MEDIUM) return 'medium';
  return 'low';
}

/** The small tag a leg row carries. */
export function confChip(p) {
  const t = confTag(p);
  if (!t) return '';
  const title = t === 'high' ? 'Model chance 65% or more'
    : t === 'medium' ? 'Model chance 50% to 65%' : 'Model chance under 50%';
  return `<span class="conf conf--${t}" title="${title}">${t === 'medium' ? 'MED' : t.toUpperCase()}</span>`;
}

/** The class that outlines a leg box green / yellow / red ('' for no number). */
export function confClass(p) {
  const t = confTag(p);
  return t ? `leg--conf-${t}` : '';
}

/** Keep only known type keys, in BET_TYPES order, without repeats. */
export function normTypes(types) {
  const want = new Set((types || []).map(String));
  return ALL_KEYS.filter((k) => want.has(k));
}

const isAll = (types) => normTypes(types).length === ALL_KEYS.length;

/** The viewer's last selection — a preference, never data. */
export function readState() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      const legs = raw.legs === 'all' ? 'all' : Number(raw.legs);
      return {
        types: normTypes(raw.types),
        legs: legs === 'all' || (Number.isInteger(legs) && legs >= MIN_LEGS && legs <= MAX_LEGS)
          ? legs : 'all',
        sort: raw.sort === 'payout' ? 'payout' : 'likely',
      };
    }
  } catch { /* private mode / blocked storage: the default is honest */ }
  return { ...DEFAULT_STATE };
}

export function writeState(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* nothing lost */ }
}

/**
 * The stepper's positions. Published cards: ALL, then the leg counts the slate
 * carries. Built cards: MIN_LEGS..GAME_MAX_LEGS on GAME, ..MAX_LEGS on WEEK.
 */
export function stepValues(state, scope, slateCounts) {
  if (!state.types.length) return ['all', ...(slateCounts || [])];
  const top = scope === 'game' ? GAME_MAX_LEGS : MAX_LEGS;
  const out = [];
  for (let n = MIN_LEGS; n <= top; n += 1) out.push(n);
  return out;
}

/** The value the stepper shows: the state's when it is a position, else the nearest one. */
export function stepValue(state, scope, slateCounts) {
  const vals = stepValues(state, scope, slateCounts);
  if (vals.includes(state.legs)) return state.legs;
  if (state.legs === 'all' || !vals.length) return vals[0];
  const nums = vals.filter((v) => v !== 'all');
  return nums.reduce((best, v) => (Math.abs(v - state.legs) < Math.abs(best - state.legs) ? v : best), nums[0]);
}

/** "AWAY @ HOME" for a game id, from the schedule the view holds. */
function gameLabel(id, games) {
  const g = (games || []).find((x) => String(x.game_id) === String(id));
  return g ? `${g.away} @ ${g.home}` : '';
}

/**
 * The selector. Row 1: PUBLISHED, ALL and the five kinds (shown only for the
 * current week, where built cards can be bet). Built cards add the GAME picker
 * (GAME) and the sort chips. The − n + stepper is on every week.
 * opts: { types: show the chip row, games: open games for the picker, gameId }.
 */
export function typeControls(state, scope, slateCounts, opts = {}) {
  const { types: showTypes = true, games = [], gameId = null } = opts;
  const chosen = new Set(state.types);
  const all = isAll(state.types);
  const chip = (attr, key, label, on) => `<button type="button" class="leg-chip${on ? ' leg-chip--active' : ''}" `
    + `data-${attr}="${key}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
  const built = state.types.length > 0;
  let html = '';
  if (showTypes) {
    html += '<div class="td-seg type-seg" role="group" aria-label="Bet type">'
      + '<span class="lbl">BETS</span>'
      + chip('type', 'published', 'PUBLISHED', !built)
      + chip('type', 'all', 'ALL', all)
      + BET_TYPES.map(([k, label]) => chip('type', k, label, !all && chosen.has(k))).join('')
      + '</div>';
  }
  if (showTypes && built && scope === 'game') {
    html += '<div class="td-seg game-pick-row"><span class="lbl">GAME</span>'
      + '<select id="game-pick" class="game-pick" aria-label="Game">'
      + games.map((g) => `<option value="${esc(g.game_id)}"${String(g.game_id) === String(gameId) ? ' selected' : ''}>`
        + `${esc(`${g.away} @ ${g.home}`)}</option>`).join('')
      + '</select></div>';
  }
  const vals = stepValues(state, scope, slateCounts);
  // Published cards that come in one size only (GAME's pairs) have nothing to
  // step through: ALL and that size are the same list, so no stepper.
  if (built || vals.length > 2) {
    const v = stepValue(state, scope, slateCounts);
    const i = vals.indexOf(v);
    const nums = vals.filter((x) => x !== 'all');
    const range = nums.length ? `${nums[0]} – ${nums[nums.length - 1]}` : '';
    html += '<div class="td-step" role="group" aria-label="Legs per card">'
      + '<span class="lbl">LEGS</span>'
      + `<button type="button" class="leg-chip td-step-btn" data-step="-1" aria-label="Fewer legs"${i <= 0 ? ' disabled' : ''}>−</button>`
      + `<b class="td-step-n" aria-live="polite">${v === 'all' ? 'ALL' : v}</b>`
      + `<button type="button" class="leg-chip td-step-btn" data-step="1" aria-label="More legs"${i < 0 || i >= vals.length - 1 ? ' disabled' : ''}>+</button>`
      + `<span class="lbl td-step-range">${range}</span>`
      + '</div>';
  }
  if (showTypes && built) {
    html += '<div class="td-seg sort-seg" role="group" aria-label="Sort built cards">'
      + '<span class="lbl">SORT</span>'
      + SORTS.map(([k, label]) => chip('sort', k, label, state.sort === k)).join('')
      + '</div>';
  }
  return html;
}

/**
 * Apply a tap inside the controls; returns the new state or null. PUBLISHED
 * clears the kinds; ALL picks every kind; a kind chip toggles (from ALL it
 * starts a fresh pick; the last one off is PUBLISHED again). The leg count is
 * kept when it is still a position.
 */
export function typeTap(state, target, scope, slateCounts) {
  const chip = target.closest('[data-type]');
  if (chip) {
    const key = chip.dataset.type;
    let types;
    if (key === 'published') {
      if (!state.types.length) return null;
      types = [];
    } else if (key === 'all') {
      if (isAll(state.types)) return null;
      types = ALL_KEYS.slice();
    } else if (isAll(state.types)) {
      types = [key];
    } else {
      const set = new Set(state.types);
      if (set.has(key)) set.delete(key); else set.add(key);
      types = normTypes([...set]);
    }
    const next = { ...state, types };
    next.legs = stepValue(next, scope, slateCounts);
    return next;
  }
  const sort = target.closest('[data-sort]');
  if (sort) {
    const s = sort.dataset.sort === 'payout' ? 'payout' : 'likely';
    return s === state.sort ? null : { ...state, sort: s };
  }
  const step = target.closest('[data-step]');
  if (step && !step.disabled) {
    const vals = stepValues(state, scope, slateCounts);
    const i = vals.indexOf(stepValue(state, scope, slateCounts));
    const j = Math.max(0, Math.min(vals.length - 1, i + Number(step.dataset.step)));
    if (i === j) return null;
    return { ...state, legs: vals[j] };
  }
  return null;
}

/* ---- the legs ----------------------------------------------------------- */

/** Games that have not kicked off, in kickoff order (the only ones built cards use). */
export function openGames(games, now = Date.now()) {
  return (games || [])
    .filter((g) => g.status === 'STATUS_SCHEDULED' && Date.parse(g.kickoff_utc) > now)
    .slice().sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc)
      || String(a.game_id).localeCompare(String(b.game_id)));
}

/**
 * One rung for a yardage player: his MOST LIKELY line (highest win chance).
 * The pool's ladder is nested (clearing 60 clears 20), so one rung per player is
 * one opinion per player.
 */
export function pickRung(rungs) {
  const list = (rungs || []).filter((r) => Number.isFinite(Number(r.model_prob)));
  if (!list.length) return null;
  return list.reduce((a, b) => (b.model_prob > a.model_prob
    || (b.model_prob === a.model_prob && Number(b.line) > Number(a.line)) ? b : a));
}

/**
 * The legs the chosen kinds allow, from the leg pool, on games not yet started:
 * one leg per yardage player (pickRung), each anytime-TD leg, each moneyline.
 * Every leg carries `owner` (player or team) — a card never holds two opinions
 * about one man — and `kind`, the chip it came from.
 */
export function typeLegs(pool, types, games, now = Date.now()) {
  const want = new Set(normTypes(types).map((k) => MARKET_OF[k]));
  const open = new Set(openGames(games, now).map((g) => String(g.game_id)));
  const out = [];
  const keep = (leg) => open.has(String(leg.game_id));
  for (const row of (pool && pool.players) || []) {
    if (!want.has(row.market)) continue;
    const rung = pickRung(row.rungs);
    if (!rung) continue;
    const leg = { ...legFromPool(row, rung), owner: row.gsis_id, kind: KEY_OF[row.market] };
    // R77 — a QUESTIONABLE player stays in the pool at his price; the flag must
    // ride the leg to the card (RC-01: it was dropped here).
    if (row.availability) leg.availability = row.availability;
    if (keep(leg)) out.push(leg);
  }
  if (want.has('anytime_td')) {
    for (const row of (pool && pool.atd_legs) || []) {
      const rung = (row.rungs || [])[0];
      if (!rung) continue;
      const leg = { ...legFromPool(row, rung), owner: row.gsis_id, kind: 'atd' };
      if (row.availability) leg.availability = row.availability;
      if (keep(leg)) out.push(leg);
    }
  }
  if (want.has('moneyline')) {
    for (const g of (pool && pool.game_legs) || []) {
      if (g.market !== 'moneyline' || !g.game_id) continue;
      const leg = { ...legFromGame(g), owner: `team:${g.team || g.selection}`, kind: 'ml' };
      if (keep(leg)) out.push(leg);
    }
  }
  return out.sort((a, b) => b.model_prob - a.model_prob
    || String(a.selection).localeCompare(String(b.selection)));
}

/** How many different kinds a card of n legs must carry. */
export function mixTarget(n, legs) {
  return Math.min(n, new Set(legs.map((l) => l.kind)).size);
}

const KIND_BIT = Object.fromEntries(ALL_KEYS.map((k, i) => [k, 1 << i]));
const popcount = (m) => { let c = 0; for (let x = m; x; x &= x - 1) c += 1; return c; };
const cardKey = (legs) => legs.map((l) => l.selection).sort().join('|');
const byLikelyThenKey = (a, b) => b.p - a.p || a.key.localeCompare(b.key);

/**
 * WEEK, EXACT (RC-03): the k most likely n-leg cards with one leg per game and at
 * least `target` different kinds. Cross-game legs are independent, so a card's
 * chance is the product of its legs and the search is a k-best dynamic programme
 * over games with state (legs chosen, kinds covered) — keeping the k best partial
 * cards per state is exact for an additive (log) objective. Within a game only
 * the k most likely legs of each kind can be on a k-best card (any other leg of
 * that kind is dominated by k distinct swaps), so nothing else is considered.
 */
function exactWeek(legs, n, target, k) {
  const games = new Map();
  for (const l of legs) {
    const g = String(l.game_id);
    if (!games.has(g)) games.set(g, new Map());
    const perKind = games.get(g);
    if (!perKind.has(l.kind)) perKind.set(l.kind, []);
    const list = perKind.get(l.kind);
    if (list.length < k) list.push(l);          // legs arrive most likely first
  }
  let states = new Map([['0|0', [{ p: 1, legs: [], key: '' }]]]);
  for (const perKind of games.values()) {
    const options = [...perKind.values()].flat();
    const next = new Map();
    const push = (key, entry) => {
      if (!next.has(key)) next.set(key, []);
      next.get(key).push(entry);
    };
    for (const [key, entries] of states) {
      for (const e of entries) push(key, e);           // this game left out
      const [c, mask] = key.split('|').map(Number);
      if (c >= n) continue;
      for (const leg of options) {
        const m = mask | KIND_BIT[leg.kind];
        for (const e of entries) {
          const ls = [...e.legs, leg];
          push(`${c + 1}|${m}`, { p: e.p * leg.model_prob, legs: ls, key: cardKey(ls) });
        }
      }
    }
    for (const [key, list] of next) next.set(key, list.sort(byLikelyThenKey).slice(0, k));
    states = next;
  }
  const done = [];
  for (const [key, list] of states) {
    const [c, mask] = key.split('|').map(Number);
    if (c === n && popcount(mask) >= target) done.push(...list);
  }
  return done.sort(byLikelyThenKey).slice(0, k).map((e) => ({ legs: e.legs, model_prob: e.p }));
}

/**
 * WEEK: the MIX_CARDS most likely n-leg cards, one leg per game (cross-game legs
 * combine as independent, the builder's rule), each carrying min(n, kinds)
 * different kinds. Exact (exactWeek). {cards, reason, exact: true}.
 */
export function weekMixCards(legs, n, k = MIX_CARDS) {
  const games = new Set(legs.map((l) => String(l.game_id)));
  if (games.size < n) {
    return { cards: [], exact: true, reason: `Only ${games.size} game${games.size === 1 ? '' : 's'} still to play `
      + `${games.size === 1 ? 'has' : 'have'} legs of these kinds, and a WEEK card takes one leg per game — `
      + 'try fewer legs or more bet types.' };
  }
  const cards = exactWeek(legs, n, mixTarget(n, legs), k);
  return cards.length ? { cards, reason: '', exact: true }
    : { cards: [], exact: true, reason: 'No card of this size can be built.' };
}

/** The ML_CARDS most likely moneyline-only cards of n legs (one per game). Exact. */
export function moneylineCards(legs, n, k = ML_CARDS) {
  const ml = legs.filter((l) => l.kind === 'ml');
  if (new Set(ml.map((l) => String(l.game_id))).size < n) return [];
  return exactWeek(ml, n, 1, k);
}

/**
 * The same-game chance of `legs`, ESTIMATED: fold each leg in with combineTwo
 * at the mean measured correlation to the legs already on the card. Exact for a
 * pair (it is combinedProbs' own rule); for three or more it is an
 * approximation no backtest has validated, and the card says so.
 */
export function estimateSameGame(legs, table) {
  if (!legs.length) return 0;
  let p = legs[0].model_prob;
  for (let i = 1; i < legs.length; i += 1) {
    const rhos = legs.slice(0, i).map((l) => pairRho(l, legs[i], table));
    const rho = rhos.reduce((a, b) => a + b, 0) / rhos.length;
    p = combineTwo(p, legs[i].model_prob, rho);
  }
  return p;
}

/** Combinations the GAME search will enumerate exhaustively before it switches to a beam. */
export const GAME_EXACT_LIMIT = 250000;
const GAME_BEAM = 400;

function choose(m, n) {
  let c = 1;
  for (let i = 0; i < n; i += 1) c = (c * (m - i)) / (i + 1);
  return c;
}

/**
 * GAME: the MIX_CARDS most likely n-leg cards from ONE game (2..GAME_MAX_LEGS;
 * RC-02: the builder refuses any other size), one leg per player, never both
 * moneylines or a team's moneyline beside its own spread (R74), each carrying
 * min(n, kinds) different kinds; chance by estimateSameGame. EXACT (every valid
 * combination scored) when there are at most GAME_EXACT_LIMIT of them; otherwise
 * a beam, and the result says `exact: false` so the view can say so (RC-03).
 */
export function gameMixCards(legs, n, table, gameId, k = MIX_CARDS) {
  if (!Number.isInteger(n) || n < MIN_LEGS || n > GAME_MAX_LEGS) {
    return { cards: [], exact: true, reason: `A GAME card is ${MIN_LEGS}–${GAME_MAX_LEGS} legs.` };
  }
  const mine = legs.filter((l) => String(l.game_id) === String(gameId));
  if (mine.length < n) {
    return { cards: [], exact: true, reason: `This game has ${mine.length} leg${mine.length === 1 ? '' : 's'} of these kinds `
      + 'still to play — pick fewer legs or more bet types.' };
  }
  const target = mixTarget(n, mine);
  const clash = (a, b) => a.owner === b.owner || (a.kind === 'ml' && b.kind === 'ml') || sameSideGamePair(a, b);
  const exact = choose(mine.length, n) <= GAME_EXACT_LIMIT;
  let found = [];
  if (exact) {
    const pick = [];
    const walk = (start) => {
      if (pick.length === n) {
        if (new Set(pick.map((l) => l.kind)).size >= target) {
          const ls = pick.slice();
          found.push({ legs: ls, p: estimateSameGame(ls, table), key: cardKey(ls) });
        }
        return;
      }
      for (let i = start; i <= mine.length - (n - pick.length); i += 1) {
        if (pick.some((l) => clash(l, mine[i]))) continue;
        pick.push(mine[i]);
        walk(i + 1);
        pick.pop();
      }
    };
    walk(0);
  } else {
    let beam = [{ legs: [], kinds: new Set(), last: -1 }];
    for (let step = 0; step < n; step += 1) {
      const left = n - step - 1;
      const next = [];
      for (const part of beam) {
        for (let i = part.last + 1; i < mine.length; i += 1) {
          if (part.legs.some((l) => clash(l, mine[i]))) continue;
          const kinds = new Set(part.kinds).add(mine[i].kind);
          if (target - kinds.size > left) continue;
          const ls = [...part.legs, mine[i]];
          next.push({ legs: ls, kinds, last: i, p: estimateSameGame(ls, table), key: cardKey(ls) });
        }
      }
      beam = next.sort(byLikelyThenKey).slice(0, GAME_BEAM);
    }
    found = beam;
  }
  const cards = found.sort(byLikelyThenKey).slice(0, k)
    .map((e) => ({ legs: e.legs, model_prob: e.p, game_id: String(gameId) }));
  return cards.length ? { cards, reason: '', exact }
    : { cards: [], exact, reason: 'No card of this size can be built from this game.' };
}

/** The table the GAME pricer reads: the slate's pairs plus the measured ATD pairs. */
export function typeTable(calib, pool) {
  const base = (calib && calib.correlations) || {};
  const extra = (pool && pool.atd_correlations && pool.atd_correlations.pairs) || [];
  return correlationTable({ correlations: { ...base, pairs: [...(base.pairs || []), ...extra] } });
}

/** Sort mixed cards: MOST LIKELY first, or BIGGEST PAYOUT (least likely) first. */
export function sortCards(cards, sort) {
  const out = cards.slice();
  out.sort((a, b) => (sort === 'payout' ? a.model_prob - b.model_prob : b.model_prob - a.model_prob));
  return out;
}

/** Card heading words: "PASSING + RUSHING" or "ALL KINDS". */
export function typesLabel(types) {
  const t = normTypes(types);
  return t.length === ALL_KEYS.length ? 'ALL KINDS' : t.map((k) => LABEL_OF[k]).join(' + ');
}

const KIND = {
  anytime_td: 'anytime TD', qb_pass_yds: 'passing', rb_rush_yds: 'rushing',
  wr_rec_yds: 'receiving', moneyline: 'moneyline',
};

/**
 * One built card, in the ATD card's markup so it inherits its layout.
 * opts.label overrides the heading words ("MONEYLINE ONLY"); opts.estimated
 * marks a same-game chance of three or more legs.
 */
const QUESTIONABLE = 'QUESTIONABLE';

/** R77 — the Q chip PARLAYS and MY already paint, same copy and tone. */
export function qChip(leg) {
  return leg && leg.availability === QUESTIONABLE
    ? '<span class="est leg-q" title="Questionable — game-time decision">Q</span>' : '';
}

export function renderTypeCard(card, { scope = 'week', types = [], games = [], label = '', exact = true } = {}) {
  const where = scope === 'game' ? gameLabel(card.game_id, games) : '';
  const estimated = scope === 'game' && card.legs.length > 2;
  const legs = card.legs.map((l) => (
    `<div class="leg leg--annot ${confClass(l.model_prob)}">`
      + `<div class="leg-nm">${esc(l.selection)}</div>`
      + `<div class="leg-od">${qChip(l)}<span class="mo">MODEL <b>${Math.round(l.model_prob * 100)}</b></span>${confChip(l.model_prob)}</div>`
      + `<div class="leg-prov">${esc([l.team, KIND[l.market] || l.market,
        l.availability === QUESTIONABLE ? 'QUESTIONABLE — game-time decision' : ''].filter(Boolean).join(' · '))}</div>`
    + '</div>')).join('');
  const note = scope === 'game'
    ? (estimated
      ? 'Every leg is from one game. The chance is ESTIMATED by chaining the measured pair correlations — '
        + 'no backtest has validated three or more same-game legs.'
      : 'Both legs are from one game, so the chance comes from the same-game correlation model.')
    : 'One leg per game, so the chance is the product of the legs.';
  const hasQ = card.legs.some((l) => l.availability === QUESTIONABLE);
  return (
    `<article class="card parlay mp-card atd-card type-card" data-scope="${scope}"${label ? ' data-ml-only="1"' : ''}>`
      + '<div class="p-head">'
        + `<span class="lbl">${where ? `${esc(where)} · ` : ''}${esc(label || typesLabel(types))} · ${card.legs.length} LEGS</span>`
      + '</div>'
      + `<div class="legs">${legs}</div>`
      + '<div class="p-foot">'
        + `<div class="ev" title="Model chance every leg hits">${pctText(card.model_prob)}`
          + `<span class="k">${estimated ? 'EST. MODEL HIT' : 'MODEL HIT'}</span></div>`
        + `<div class="pay">${breakEven(card.model_prob)}<span class="k">BREAK-EVEN ODDS</span></div>`
      + '</div>'
      + `<div class="corr"><span>${note} Built live from the model's legs: not a published card, `
        + 'not recorded or graded. HIGH is a 65%+ leg, MED 50–65%, LOW under 50%: the model\'s chance, '
        + 'separate from injury status. '
        + (hasQ ? 'Q = questionable, a game-time decision: the chance assumes he plays. ' : '')
        + (exact ? '' : 'Too many combinations to score them all, so this card was chosen by an approximate search. ')
        + 'No book price is read.</span></div>'
    + '</article>'
  );
}

/** A section heading inside the built list. */
export function sectionHead(text) {
  return `<div class="type-sec lbl">${esc(text)}</div>`;
}
