/* app/atd-cards.js — R101c: the anytime-TD selector and the WEEK ATD cards;
 * R101b: and the GAME (same-game) ATD cards, rendered by the same card.
 *
 * Owner (2026-09-24): each parlay section goes up to 10 legs, with a choice of
 * ONLY anytime-TD scorers or MORE THAN HALF anytime-TD scorers — plus, as chosen,
 * 50%+ scorers. Gate 2 chose layout B: TD pills (ANY / ALL TD / MAJORITY / 50%+)
 * in the SAFE/EVEN/LONGSHOT pill idiom, and a − n + leg stepper (2–10) with
 * 44 pt targets, iPhone first.
 *
 * This module is PURE apart from two guarded localStorage touches: it renders
 * controls and cards from documents the caller hands it and fetches nothing
 * (the WEEK cards are built on the runner by scripts/build_atd_cards.py, one leg
 * per game, at the leg pool's own prices, recorded on first sight and graded by
 * scripts/resolve_atd_cards.py).
 *
 * A card shows the model's chance that every leg hits and the break-even
 * American odds that chance is worth. No book price is read or shown: there is
 * no EV here because there is no price to have an edge against.
 */

export const TD_MODES = [
  ['any', 'ANY'], ['all_td', 'ALL TD'], ['majority_td', 'MAJORITY'], ['scorers_50', '50%+'],
];
export const TD_MIN_LEGS = 2;
export const TD_MAX_LEGS = 10;
export const TD_DEFAULT = { mode: 'any', legs: 4 };
const TD_KEY = 'nfl2026.parlays.td.v1';
const LABEL = { all_td: 'ALL ANYTIME TD', majority_td: 'MAJORITY TD', scorers_50: '50%+ SCORERS' };

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Clamp a leg count into 2..10 (anything unreadable is the default). */
export function clampLegs(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return TD_DEFAULT.legs;
  return Math.min(TD_MAX_LEGS, Math.max(TD_MIN_LEGS, v));
}

/** The viewer's last TD mode and leg count — a preference, never data. */
export function readTd() {
  try {
    const raw = JSON.parse(localStorage.getItem(TD_KEY) || 'null');
    if (raw && TD_MODES.some(([k]) => k === raw.mode)) {
      return { mode: raw.mode, legs: clampLegs(raw.legs) };
    }
  } catch { /* private mode / blocked storage: the default is honest */ }
  return { ...TD_DEFAULT };
}

export function writeTd(td) {
  try { localStorage.setItem(TD_KEY, JSON.stringify(td)); } catch { /* nothing lost */ }
}

/** Layout B: the TD pills, and — once a TD mode is on — the leg stepper. */
export function tdControls(td) {
  const pills = TD_MODES.map(([key, label]) => {
    const on = td.mode === key;
    return `<button type="button" class="leg-chip${on ? ' leg-chip--active' : ''}" `
      + `data-td="${key}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
  }).join('');
  const stepper = td.mode === 'any' ? '' : (
    '<div class="td-step" role="group" aria-label="Legs per card">'
      + '<span class="lbl">LEGS</span>'
      + `<button type="button" class="leg-chip td-step-btn" data-step="-1" aria-label="Fewer legs"${td.legs <= TD_MIN_LEGS ? ' disabled' : ''}>−</button>`
      + `<b class="td-step-n" aria-live="polite">${td.legs}</b>`
      + `<button type="button" class="leg-chip td-step-btn" data-step="1" aria-label="More legs"${td.legs >= TD_MAX_LEGS ? ' disabled' : ''}>+</button>`
      + `<span class="lbl td-step-range">${TD_MIN_LEGS} – ${TD_MAX_LEGS}</span>`
    + '</div>');
  return '<div class="td-seg" role="group" aria-label="Anytime TD">'
    + '<span class="lbl">TD</span>' + pills + '</div>' + stepper;
}

/** Apply a tap inside the controls to `td`; returns the new state or null. */
export function tdTap(td, target) {
  const pill = target.closest('[data-td]');
  if (pill) {
    const mode = pill.dataset.td;
    return mode === td.mode ? null : { mode, legs: td.legs };
  }
  const step = target.closest('[data-step]');
  if (step && !step.disabled) {
    const legs = clampLegs(td.legs + Number(step.dataset.step));
    return legs === td.legs ? null : { mode: td.mode, legs };
  }
  return null;
}

/** Break-even American odds for a chance p ("+686", "−400"). */
export function breakEven(p) {
  if (!(p > 0 && p < 1)) return '';
  const v = p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
  const abs = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '−' : '+'}${abs}`;
}

/** A chance as a percentage with enough digits to be readable at 10 legs. */
export function pctText(p) {
  const v = p * 100;
  if (v >= 10) return `${v.toFixed(1)}%`;
  if (v >= 1) return `${v.toFixed(2)}%`;
  if (v >= 0.01) return `${v.toFixed(3)}%`;
  return '<0.01%';
}

/**
 * The WEEK cards for (mode, legs), minus any card with a leg whose game has
 * kicked off (the runner builds them before the week starts; a Thursday game
 * removes its cards on Thursday night). Returns {cards, reason}.
 */
export function atdCardsFor(doc, mode, legs, games, now = Date.now()) {
  if (!doc) return { cards: [], reason: 'No anytime-TD cards are published for this view yet.' };
  if (!doc.adopted || !doc.modes) {
    return { cards: [], reason: 'No anytime-TD cards this week — the anytime-TD model is not adopted.' };
  }
  if (!Object.keys(doc.modes).length) {
    // R101b — GAME without a held-out verdict: the builder's own last note says why.
    const why = (doc.notes || []).slice(-1)[0];
    return { cards: [], reason: why || 'No anytime-TD cards this week.' };
  }
  const blk = doc.modes[mode];
  if (!blk) return { cards: [], reason: 'No cards for this mode this week.' };
  const open = new Set((games || [])
    .filter((g) => g.status === 'STATUS_SCHEDULED' && Date.parse(g.kickoff_utc) > now)
    .map((g) => String(g.game_id)));
  const all = (blk.cards && blk.cards[String(legs)]) || [];
  if (!all.length) {
    const why = blk.not_offered && blk.not_offered[String(legs)];
    return { cards: [], reason: why ? `Not offered at ${legs} legs: ${why}.` : `No ${legs}-leg card this week.` };
  }
  const cards = all.filter((c) => c.legs.every((l) => open.has(String(l.game_id))));
  return cards.length ? { cards, reason: '' }
    : { cards: [], reason: `Every ${legs}-leg card has a game that has already kicked off.` };
}

const NOTE = {
  week: 'One leg per game, so the chance is the product of the legs.',
  joint: 'Every leg is from one game, so the legs move together: the chance comes from '
    + 'the same-game model, which beat the plain product on held-out seasons.',
  independent: 'Every leg is from one game. The same-game model did not beat the plain '
    + 'product on held-out seasons, so the chance is the product — and this size passed '
    + 'its held-out hit-count test.',
};

/** "NE @ SEA" for a card's game, from the schedule the view already holds. */
function gameLabel(card, games) {
  const id = String((card.legs[0] || {}).game_id);
  const g = (games || []).find((x) => String(x.game_id) === id);
  return g ? `${g.away} @ ${g.home}` : '';
}

/**
 * One ATD card, in the MY card's markup so it inherits its layout. opts.scope
 * 'week' (default) or 'game'; opts.pricer is the GAME document's pricer and
 * opts.games the schedule, for the game label.
 */
export function renderAtdCard(card, opts = {}) {
  const scope = opts.scope === 'game' ? 'game' : 'week';
  const note = scope === 'game' ? (NOTE[opts.pricer] || NOTE.independent) : NOTE.week;
  const where = scope === 'game' ? gameLabel(card, opts.games) : '';
  const legs = card.legs.map((l) => (
    '<div class="leg leg--annot">'
      + `<div class="leg-nm">${esc(l.selection)}</div>`
      + `<div class="leg-od"><span class="mo">MODEL <b>${Math.round(l.model_prob * 100)}</b></span></div>`
      + `<div class="leg-prov">${esc([l.team, l.market === 'anytime_td' ? 'anytime TD' : 'floor'].filter(Boolean).join(' · '))}</div>`
    + '</div>')).join('');
  return (
    `<article class="card parlay mp-card atd-card" data-scope="${scope}" data-atd="${esc(card.mode)}">`
      + '<div class="p-head">'
        + `<span class="lbl">${where ? `${esc(where)} · ` : ''}${esc(LABEL[card.mode] || card.label)} · ${card.n_legs} LEGS · ${card.n_atd} TD</span>`
      + '</div>'
      + `<div class="legs">${legs}</div>`
      + '<div class="p-foot">'
        + `<div class="ev" title="Model chance every leg hits">${pctText(card.model_prob)}<span class="k">MODEL HIT</span></div>`
        + `<div class="pay">${breakEven(card.model_prob)}<span class="k">BREAK-EVEN ODDS</span></div>`
      + '</div>'
      + `<div class="corr"><span>${note} `
        + 'Break-even is the price this chance is worth — take less and the bet loses money '
        + 'on average. No book price is read.</span></div>'
    + '</article>'
  );
}
