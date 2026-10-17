/* app/bet-types.js — R133: the BET TYPE selector and the cards it builds, on
 * WEEK and GAME.
 *
 * Owner (2026-10-17): one way to pick legs everywhere (the − n + stepper), and a
 * filter for the KIND of bet — All, Anytime TD, Passing, Rushing, Receiving,
 * Moneyline — so a card can be "all of one kind" or a mix the owner chose, with
 * every leg tagged HIGH / MEDIUM / LOW by the model's own chance. Chosen at the
 * same time:
 *   - the type chips REPLACE the TD pills (ANY / ALL TD / MAJORITY / 50%+) on
 *     WEEK and GAME; MY keeps its own TD pills and dial;
 *   - ALL is the published slate (the curated cards, graded as before); picking
 *     one or more types BUILDS cards live from the leg pool;
 *   - built cards are browser-only: not recorded, not graded, never counted in
 *     the ALL HIT buckets. Recording them is a later step;
 *   - O/U and spread are not offered: no game-total model exists, and a spread
 *     is a flat 0.5 the model holds no opinion on (R109/R126).
 *
 * The confidence tag is the model's chance for that one leg, cut at the same
 * lines as the MY dial: HIGH >= 0.65 (SAFE), MEDIUM >= 0.50 (EVEN), LOW below.
 * It is a reading of a calibrated number, not a new price.
 *
 * Pure apart from two guarded localStorage touches, like app/atd-cards.js.
 */

import {
  combinedGameProbs, correlationTable, legFromGame, legFromPool, sameSideGamePair,
} from './parlay-math.js';
import { breakEven, pctText } from './atd-cards.js';

export const BET_TYPES = [
  ['atd', 'ANYTIME TD', 'anytime_td'],
  ['pass', 'PASSING', 'qb_pass_yds'],
  ['rush', 'RUSHING', 'rb_rush_yds'],
  ['rec', 'RECEIVING', 'wr_rec_yds'],
  ['ml', 'MONEYLINE', 'moneyline'],
];
const MARKET_OF = Object.fromEntries(BET_TYPES.map(([k, , m]) => [k, m]));
const LABEL_OF = Object.fromEntries(BET_TYPES.map(([k, l]) => [k, l]));

export const MIN_LEGS = 2;
export const MAX_LEGS = 10;
/* Three or more legs from ONE game have no validated joint price (RCA F03;
 * app/parlay-math.combinedGameProbs refuses them), so a GAME card is a pair. */
export const GAME_MAX_LEGS = 2;
export const CARDS_PER_VIEW = 3;
export const CONF_HIGH = 0.65;
export const CONF_MEDIUM = 0.50;

const KEY = 'nfl2026.parlays.types.v1';
export const DEFAULT_STATE = { types: [], legs: 'all' };

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

/** Keep only known type keys, in BET_TYPES order, without repeats. */
export function normTypes(types) {
  const want = new Set((types || []).map(String));
  return BET_TYPES.map(([k]) => k).filter((k) => want.has(k));
}

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
      };
    }
  } catch { /* private mode / blocked storage: the default is honest */ }
  return { ...DEFAULT_STATE };
}

export function writeState(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* nothing lost */ }
}

/**
 * The stepper's positions. Published cards (no type chosen): ALL, then the leg
 * counts the slate actually carries. Built cards: MIN_LEGS..max, where max is
 * GAME_MAX_LEGS on GAME and MAX_LEGS on WEEK.
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

/**
 * The selector: one row of type chips (ALL + the five kinds, multi-select; the
 * row is shown only for the current week, where built cards can be bet), and the
 * − n + stepper, shown on every week.
 */
export function typeControls(state, scope, slateCounts, { types = true } = {}) {
  const chosen = new Set(state.types);
  const chip = (key, label, on) => `<button type="button" class="leg-chip${on ? ' leg-chip--active' : ''}" `
    + `data-type="${key}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
  const row = types
    ? '<div class="td-seg type-seg" role="group" aria-label="Bet type">'
      + '<span class="lbl">BETS</span>'
      + chip('all', 'ALL', !chosen.size)
      + BET_TYPES.map(([k, label]) => chip(k, label, chosen.has(k))).join('')
      + '</div>'
    : '';
  const vals = stepValues(state, scope, slateCounts);
  const v = stepValue(state, scope, slateCounts);
  const i = vals.indexOf(v);
  const nums = vals.filter((x) => x !== 'all');
  const range = state.types.length && scope === 'game'
    ? `${GAME_MAX_LEGS} · same-game limit`
    : (nums.length ? `${nums[0]} – ${nums[nums.length - 1]}` : '');
  // Published cards that come in one size only (GAME's pairs) have nothing to
  // step through: ALL and that size are the same list, so no stepper.
  if (!state.types.length && vals.length <= 2) return row;
  const stepper = '<div class="td-step" role="group" aria-label="Legs per card">'
    + '<span class="lbl">LEGS</span>'
    + `<button type="button" class="leg-chip td-step-btn" data-step="-1" aria-label="Fewer legs"${i <= 0 ? ' disabled' : ''}>−</button>`
    + `<b class="td-step-n" aria-live="polite">${v === 'all' ? 'ALL' : v}</b>`
    + `<button type="button" class="leg-chip td-step-btn" data-step="1" aria-label="More legs"${i < 0 || i >= vals.length - 1 ? ' disabled' : ''}>+</button>`
    + `<span class="lbl td-step-range">${range}</span>`
    + '</div>';
  return row + stepper;
}

/**
 * Apply a tap inside the controls; returns the new state or null. ALL clears the
 * types; a type chip toggles (the last one off is ALL again). Changing between
 * published and built cards keeps the leg count when it is still a position.
 */
export function typeTap(state, target, scope, slateCounts) {
  const chip = target.closest('[data-type]');
  if (chip) {
    const key = chip.dataset.type;
    let types;
    if (key === 'all') {
      if (!state.types.length) return null;
      types = [];
    } else {
      const set = new Set(state.types);
      if (set.has(key)) set.delete(key); else set.add(key);
      types = normTypes([...set]);
    }
    const next = { types, legs: state.legs };
    next.legs = stepValue(next, scope, slateCounts);
    return next;
  }
  const step = target.closest('[data-step]');
  if (step && !step.disabled) {
    const vals = stepValues(state, scope, slateCounts);
    const i = vals.indexOf(stepValue(state, scope, slateCounts));
    const j = Math.max(0, Math.min(vals.length - 1, i + Number(step.dataset.step)));
    if (i === j) return null;
    return { types: state.types, legs: vals[j] };
  }
  return null;
}

/* ---- the legs ----------------------------------------------------------- */

/** A game that has not kicked off (the only legs a built card may use). */
function openGames(games, now) {
  return new Set((games || [])
    .filter((g) => g.status === 'STATUS_SCHEDULED' && Date.parse(g.kickoff_utc) > now)
    .map((g) => String(g.game_id)));
}

/**
 * One rung for a yardage player: the HARDEST line the model still gives 50% or
 * better (the most a "coin flip or better" leg can ask); when none clears 50%,
 * his most likely rung. The pool's ladder is nested (clearing 60 clears 20), so
 * one rung per player is one opinion per player.
 */
export function pickRung(rungs) {
  const list = (rungs || []).filter((r) => Number.isFinite(Number(r.model_prob)));
  if (!list.length) return null;
  const over = list.filter((r) => r.model_prob >= CONF_MEDIUM);
  if (over.length) return over.reduce((a, b) => (Number(b.line) > Number(a.line) ? b : a));
  return list.reduce((a, b) => (b.model_prob > a.model_prob ? b : a));
}

/**
 * The legs the chosen types allow, from the leg pool, on games not yet started:
 * one leg per yardage player (pickRung), each anytime-TD leg, each moneyline.
 * Every leg carries `owner` (player or team) so a card never holds two opinions
 * about one man, and `type` for the card's label.
 */
export function typeLegs(pool, types, games, now = Date.now()) {
  const want = new Set(normTypes(types).map((k) => MARKET_OF[k]));
  const open = openGames(games, now);
  const out = [];
  const keep = (leg) => open.has(String(leg.game_id));
  for (const row of (pool && pool.players) || []) {
    if (!want.has(row.market)) continue;
    const rung = pickRung(row.rungs);
    if (!rung) continue;
    const leg = { ...legFromPool(row, rung), owner: row.gsis_id };
    if (keep(leg)) out.push(leg);
  }
  if (want.has('anytime_td')) {
    for (const row of (pool && pool.atd_legs) || []) {
      const rung = (row.rungs || [])[0];
      if (!rung) continue;
      const leg = { ...legFromPool(row, rung), owner: row.gsis_id };
      if (keep(leg)) out.push(leg);
    }
  }
  if (want.has('moneyline')) {
    for (const g of (pool && pool.game_legs) || []) {
      if (g.market !== 'moneyline' || !g.game_id) continue;
      const leg = { ...legFromGame(g), owner: `team:${g.team || g.selection}` };
      if (keep(leg)) out.push(leg);
    }
  }
  return out.sort((a, b) => b.model_prob - a.model_prob
    || String(a.selection).localeCompare(String(b.selection)));
}

const BEAM = 64;
const POOL_CAP = 90;

/**
 * WEEK: the CARDS_PER_VIEW most likely n-leg cards, one leg per game, so the
 * chance is the product of the legs (cross-game legs are combined as
 * independent, the builder's rule). A beam over the legs in descending chance;
 * distinct leg sets only. {cards, reason}.
 */
export function weekTypeCards(legs, n, k = CARDS_PER_VIEW) {
  const pool = legs.slice(0, POOL_CAP);
  const games = new Set(pool.map((l) => String(l.game_id)));
  if (games.size < n) {
    return { cards: [], reason: `Only ${games.size} game${games.size === 1 ? '' : 's'} still to play `
      + `${games.size === 1 ? 'has' : 'have'} legs of this kind, and a WEEK card takes one leg per game — `
      + `try fewer legs or more bet types.` };
  }
  let beam = [{ legs: [], p: 1, last: -1 }];
  for (let step = 0; step < n; step += 1) {
    const next = [];
    for (const part of beam) {
      const usedGames = new Set(part.legs.map((l) => String(l.game_id)));
      for (let i = part.last + 1; i < pool.length; i += 1) {
        const leg = pool[i];
        if (usedGames.has(String(leg.game_id))) continue;
        next.push({ legs: [...part.legs, leg], p: part.p * leg.model_prob, last: i });
      }
    }
    next.sort((a, b) => b.p - a.p);
    beam = next.slice(0, BEAM);
  }
  const cards = beam.slice(0, k).map((c) => ({ legs: c.legs, model_prob: c.p }));
  return cards.length ? { cards, reason: '' } : { cards: [], reason: 'No card of this size can be built.' };
}

/**
 * GAME: per game still to play, the CARDS_PER_VIEW most likely PAIRS of the
 * chosen kinds, priced by the same-game correlation table (combinedGameProbs),
 * one leg per player and never a team's moneyline twice (R74). Games in
 * kickoff order. {cards, reason}.
 */
export function gameTypeCards(legs, table, games, k = CARDS_PER_VIEW) {
  const byGame = new Map();
  for (const leg of legs) {
    const id = String(leg.game_id);
    if (!byGame.has(id)) byGame.set(id, []);
    byGame.get(id).push(leg);
  }
  const order = (games || []).slice()
    .sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc))
    .map((g) => String(g.game_id));
  const cards = [];
  for (const id of order) {
    const ls = byGame.get(id) || [];
    const pairs = [];
    for (let i = 0; i < ls.length; i += 1) {
      for (let j = i + 1; j < ls.length; j += 1) {
        const a = ls[i]; const b = ls[j];
        if (a.owner === b.owner || sameSideGamePair(a, b)) continue;
        if (a.market === 'moneyline' && b.market === 'moneyline') continue;   // the two sides of one game
        pairs.push({ legs: [a, b], model_prob: combinedGameProbs([a, b], table)[0], game_id: id });
      }
    }
    pairs.sort((x, y) => y.model_prob - x.model_prob);
    cards.push(...pairs.slice(0, k));
  }
  return cards.length ? { cards, reason: '' }
    : { cards: [], reason: 'No game still to play has two legs of these kinds — add a bet type.' };
}

/** The table the GAME pricer reads: the slate's pairs plus the measured ATD pairs. */
export function typeTable(calib, pool) {
  const base = (calib && calib.correlations) || {};
  const extra = (pool && pool.atd_correlations && pool.atd_correlations.pairs) || [];
  return correlationTable({ correlations: { ...base, pairs: [...(base.pairs || []), ...extra] } });
}

/** Card heading words: "PASSING + RUSHING" or "ALL KINDS". */
export function typesLabel(types) {
  const t = normTypes(types);
  return t.length === BET_TYPES.length ? 'ALL KINDS' : t.map((k) => LABEL_OF[k]).join(' + ');
}

const KIND = {
  anytime_td: 'anytime TD', qb_pass_yds: 'passing', rb_rush_yds: 'rushing',
  wr_rec_yds: 'receiving', moneyline: 'moneyline',
};

function gameLabel(id, games) {
  const g = (games || []).find((x) => String(x.game_id) === String(id));
  return g ? `${g.away} @ ${g.home}` : '';
}

/** One built card, in the ATD card's markup so it inherits its layout. */
export function renderTypeCard(card, { scope = 'week', types = [], games = [] } = {}) {
  const where = scope === 'game' ? gameLabel(card.game_id, games) : '';
  const legs = card.legs.map((l) => (
    '<div class="leg leg--annot">'
      + `<div class="leg-nm">${esc(l.selection)}</div>`
      + `<div class="leg-od"><span class="mo">MODEL <b>${Math.round(l.model_prob * 100)}</b></span>${confChip(l.model_prob)}</div>`
      + `<div class="leg-prov">${esc([l.team, KIND[l.market] || l.market].filter(Boolean).join(' · '))}</div>`
    + '</div>')).join('');
  const note = scope === 'game'
    ? 'Both legs are from one game, so the chance comes from the same-game correlation model.'
    : 'One leg per game, so the chance is the product of the legs.';
  return (
    `<article class="card parlay mp-card atd-card type-card" data-scope="${scope}">`
      + '<div class="p-head">'
        + `<span class="lbl">${where ? `${esc(where)} · ` : ''}${esc(typesLabel(types))} · ${card.legs.length} LEGS</span>`
      + '</div>'
      + `<div class="legs">${legs}</div>`
      + '<div class="p-foot">'
        + `<div class="ev" title="Model chance every leg hits">${pctText(card.model_prob)}<span class="k">MODEL HIT</span></div>`
        + `<div class="pay">${breakEven(card.model_prob)}<span class="k">BREAK-EVEN ODDS</span></div>`
      + '</div>'
      + `<div class="corr"><span>${note} Built live from the model's legs: not a published card, `
        + 'not recorded or graded. HIGH is a 65%+ leg, MED 50–65%, LOW under 50%. '
        + 'No book price is read.</span></div>'
    + '</article>'
  );
}
