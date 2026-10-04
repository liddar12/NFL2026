/* app/views/mybets.js — R110 (R99 E2): MY BETS, the BETS chip in PARLAYS.
 *
 * Owner, 2026-10-04 (Gate 2): a BETS scope beside GAME / WEEK / MY, the
 * slip-stack look. Every bet the owner actually placed, recorded in one tap from
 * the card it came from ("I BET THIS", wired in parlays.js and myparlays.js) or
 * built by hand from the leg pool, kept on THIS DEVICE (export / import for a
 * backup), graded from data/bet_facts.json by app/bets.js, and warned about
 * before the same player is staked twice.
 *
 * Lazy: loaded on the BETS chip or an "I BET THIS" tap, never on boot.
 */
import { loadJson } from '../data.js';
import * as B from '../bets.js';

const FACTS = '/data/bet_facts.json';
const POOL = '/data/leg_pool.json';
const SLIPS = '/docs/backlog/evidence/2026_owner_fanduel_slips.json';
const SOURCE_LABEL = { game: 'GAME', week: 'WEEK', my: 'MY', td: 'TD', manual: 'BUILT', import: 'FANDUEL' };
const STATUS_LABEL = { open: 'OPEN', won: 'WON', lost: 'LOST', void: 'NO ACTION' };
const TICK = { hit: '✓', miss: '✗', void: '–', pending: '·' };

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const usd = (x) => (x == null || !Number.isFinite(Number(x)) ? '—'
  : `${Number(x) < 0 ? '−' : ''}$${Math.abs(Number(x)).toFixed(2).replace(/\.00$/, '')}`);
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x) * 100)}%`);

function storage() {
  try { return window.localStorage; } catch { return null; }
}

/* One module-level ledger: the sheet (opened from any card) and the BETS screen
 * read and write the same document. */
const S = { doc: null, persistent: true, note: null, facts: undefined, pool: undefined, host: null };

function ensureDoc() {
  if (S.doc) return;
  const st = storage();
  const r = st ? B.loadStore(st) : { doc: B.emptyDoc(), persistent: false,
    note: 'this browser will not keep data: bets last until the page closes — export them' };
  Object.assign(S, { doc: r.doc, persistent: r.persistent, note: r.note });
}

function persist() {
  const st = storage();
  if (!st || !B.saveStore(st, S.doc)) {
    S.persistent = false;
    S.note = 'this browser refused to save: bets last until the page closes — export them';
  }
}

async function facts() {
  if (S.facts === undefined) {
    try { S.facts = await loadJson(FACTS); } catch { S.facts = null; }
  }
  return S.facts;
}

async function pool() {
  if (S.pool === undefined) {
    try { S.pool = await loadJson(POOL); } catch { S.pool = null; }
  }
  return S.pool;
}

/* ------------------------------------------------------------ the sheet */

let sheetEl = null;

function closeSheet() {
  if (sheetEl) { sheetEl.remove(); sheetEl = null; }
}

/**
 * Open the save sheet for a card: {source, week, legs, title, model}. The legs
 * are kept verbatim (their as-offered model chance rides along); the stake and
 * the book's odds are typed here, the odds pre-filled with the card's own fair
 * price. Exposure against the bets already held is shown BEFORE saving.
 */
export function openBetSheet({ source, week, legs, title = null, model = null }) {
  ensureDoc();
  closeSheet();
  const betLegs = legs.slice(0, B.MAX_LEGS).map((l) => B.betLeg(l, l.game_id));
  const fair = B.fairAmerican(betLegs);
  const draft = B.makeBet({ source, legs: betLegs, stake: 10, odds: fair || 100, week,
    placed_utc: new Date().toISOString(), title, model });
  const dupe = S.doc.bets.some((b) => B.fingerprint(b) === B.fingerprint(draft));
  const warns = B.exposure(S.doc.bets, draft).filter((w) => w.bets.includes(draft.id));
  sheetEl = document.createElement('div');
  sheetEl.className = 'mb-sheet';
  sheetEl.innerHTML =
    '<div class="mb-sheet-in" role="dialog" aria-modal="true" aria-labelledby="mb-sheet-h">'
      + `<h2 id="mb-sheet-h" class="mb-sheet-h">I BET THIS · ${betLegs.length} LEG${betLegs.length === 1 ? '' : 'S'} · WK ${esc(week)}</h2>`
      + `<ul class="mb-sheet-legs">${betLegs.map((l) => `<li>${esc(l.selection)}</li>`).join('')}</ul>`
      + '<div class="mb-fields">'
        + '<label class="mb-field">STAKE ($)<input id="mb-stake" class="mp-input" inputmode="decimal" value="10"></label>'
        + `<label class="mb-field">BOOK ODDS<input id="mb-odds" class="mp-input" inputmode="text" value="${esc(B.fmtAmerican(fair || 100))}"></label>`
      + '</div>'
      + `<div class="mb-ret" id="mb-ret"></div>`
      + (fair ? `<div class="mb-hint">Pre-filled with this card's fair price (${esc(B.fmtAmerican(fair))}); type the odds your book gave you.</div>` : '')
      + (dupe ? '<div class="mb-warn">You already recorded this exact bet this week — saving adds a second one.</div>' : '')
      + warns.map((w) => `<div class="mb-warn">⚠ ${esc(w.label)} would be on ${w.count} of your bets in week ${w.week}: one outcome, ${w.count} tickets.</div>`).join('')
      + '<div class="mb-sheet-act">'
        + '<button type="button" class="leg-chip" data-mb="cancel">CANCEL</button>'
        + '<button type="button" class="leg-chip leg-chip--active" data-mb="save">SAVE BET</button>'
      + '</div>'
    + '</div>';
  document.body.appendChild(sheetEl);
  const stake = sheetEl.querySelector('#mb-stake');
  const odds = sheetEl.querySelector('#mb-odds');
  const ret = sheetEl.querySelector('#mb-ret');
  const sync = () => {
    const dec = B.americanToDecimal(String(odds.value).replace('+', ''));
    const st = Number(stake.value);
    ret.textContent = dec && st > 0 ? `To return ${usd(st * dec)} (${usd(st * (dec - 1))} profit) if every leg hits`
      : 'Type a stake and American odds (e.g. +260 or -150).';
  };
  sheetEl.addEventListener('input', sync);
  sync();
  sheetEl.addEventListener('click', (e) => {
    const act = e.target.closest('[data-mb]');
    if (e.target === sheetEl || (act && act.dataset.mb === 'cancel')) { closeSheet(); return; }
    if (!act || act.dataset.mb !== 'save') return;
    const st = Number(stake.value);
    const o = Number(String(odds.value).replace('+', ''));
    if (!(st > 0) || !B.americanToDecimal(o)) { sync(); ret.classList.add('mb-warn'); return; }
    S.doc = B.addBet(S.doc, { ...draft, stake: st, odds: o }).doc;
    persist();
    closeSheet();
    announce(`Bet saved: ${betLegs.length} legs, ${usd(st)} at ${B.fmtAmerican(o)}.`);
    if (S.host && S.host.isConnected) paintLedger();
    syncChip();
  });
  stake.focus();
}

/** The BETS chip's open count (PARLAYS paints it from the same cached status). */
function syncChip() {
  const chip = document.querySelector('.scopeseg [data-seg="bets"]');
  const n = B.openCount(S.doc);
  if (chip) chip.textContent = n ? `BETS · ${n}` : 'BETS';
}

function announce(text) {
  const live = document.getElementById('announce');
  if (live) live.textContent = text;
}

/* ----------------------------------------------------------- the ledger */

function slip(g, warnIds) {
  const legs = g.legs.map((l) => {
    const gm = l.result === 'pending' && S.facts ? kickoffOf(g.week, l) : '';
    return '<div class="leg mb-leg">'
      + `<span class="mb-tick mb-tick--${l.result}" aria-label="${l.result}">${TICK[l.result] || '·'}</span>`
      + `<span class="leg-nm">${esc(l.selection)}</span>`
      + (gm ? `<span class="mb-when">${esc(gm)}</span>` : '')
      + (l.reason === 'slip_result' ? '<span class="mb-when">slip result</span>' : '')
    + '</div>';
  }).join('');
  const dec = B.americanToDecimal(g.odds);
  const toWin = dec ? usd(g.stake * dec) : '—';
  const money = g.status === 'open'
    ? `${usd(g.stake)} → ${toWin}`
    : `${usd(g.stake)} → ${usd(g.ret)}${g.estimate ? ' (est.)' : ''} · net ${usd(g.net)}`;
  return `<article class="card parlay mp-card mb-slip mb-slip--${g.status}" data-bet="${esc(g.id)}">`
    + '<div class="p-head">'
      + `<span class="lbl">${g.legs.length}-LEG ${esc(SOURCE_LABEL[g.source] || g.source)} · WK ${esc(g.week)} · ${esc(B.fmtAmerican(g.odds))}</span>`
      + `<span class="mb-st mb-st--${g.status}">${STATUS_LABEL[g.status]}</span>`
    + '</div>'
    + `<div class="mb-money">${money}</div>`
    + `<div class="legs">${legs}</div>`
    + warnIds
    + '<div class="mb-slip-act">'
      + (g.status !== 'open' ? `<button type="button" class="leg-chip" data-mb="settle">${g.settled_return != null ? 'EDIT PAYOUT' : 'BOOK PAID…'}</button>` : '')
      + '<button type="button" class="leg-chip" data-mb="delete">DELETE</button>'
    + '</div>'
  + '</article>';
}

function kickoffOf(week, leg) {
  const wk = S.facts && S.facts.weeks && S.facts.weeks[String(week)];
  if (!wk) return '';
  const g = leg.game_id && wk.games[String(leg.game_id)];
  const t = g && Date.parse(g.k);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function totals(sum) {
  const a = sum.all;
  return '<div class="mb-totals" role="status">'
    + `<span><b>${usd(a.staked)}</b> staked</span>`
    + `<span><b>${usd(a.returned)}</b> back</span>`
    + `<span class="${a.net >= 0 ? 'mb-pos' : 'mb-neg'}"><b>${usd(a.net)}</b> net</span>`
    + `<span><b>${a.roi == null ? '—' : pct(a.roi)}</b> ROI</span>`
    + `<span><b>${a.won}-${a.lost}</b>${a.void ? `-${a.void}` : ''} W-L</span>`
    + `<span><b>${a.open}</b> open</span>`
  + '</div>';
}

function analytics(sum) {
  const row = (k, b) => `<tr><th scope="row">${esc(k)}</th><td>${b.won}/${b.won + b.lost}</td>`
    + `<td>${pct(b.hit_rate)}</td><td>${pct(b.model_hit)}</td><td>${pct(b.book_hit)}</td><td>${usd(b.net)}</td></tr>`;
  const table = (title, groups) => `<table class="mb-table"><caption>${title}</caption>`
    + '<thead><tr><th></th><th>WON</th><th>HIT</th><th>MODEL</th><th>BOOK</th><th>NET</th></tr></thead><tbody>'
    + Object.entries(groups).map(([k, b]) => row(k, b)).join('') + '</tbody></table>';
  return '<details class="mb-what"><summary class="leg-chip">WHAT THE LEDGER SAYS</summary>'
    + '<p class="mb-hint">HIT = your settled hit rate; MODEL = the model\'s average chance on the cards you bet; '
    + 'BOOK = the chance your odds imply. Settled bets only.</p>'
    + table('BY LEGS', Object.fromEntries(Object.entries(sum.by_legs).map(([k, v]) => [`${k} LEG`, v])))
    + table('BY SOURCE', Object.fromEntries(Object.entries(sum.by_source).map(([k, v]) => [SOURCE_LABEL[k] || k, v])))
  + '</details>';
}

function paintLedger() {
  const host = S.host;
  if (!host) return;
  ensureDoc();
  const graded = S.doc.bets.map((b) => B.gradeBet(b, S.facts));
  // cache each bet's status so the chip can count open bets without the facts
  let changed = false;
  S.doc = { ...S.doc, bets: S.doc.bets.map((b, i) => {
    if (b.status === graded[i].status) return b;
    changed = true;
    return { ...b, status: graded[i].status };
  }) };
  if (changed) persist();
  syncChip();
  const sum = B.summarize(graded);
  const warns = B.exposure(S.doc.bets);
  const warnFor = (id) => warns.filter((w) => w.bets.includes(id))
    .map((w) => `<div class="mb-warn">⚠ ${esc(w.label)} is on ${w.count} of your week-${w.week} bets</div>`).join('');
  const order = ['open', 'won', 'lost', 'void'];
  const sections = order.map((st) => {
    const gs = graded.filter((g) => g.status === st)
      .sort((a, b) => b.week - a.week || String(b.placed_utc || '').localeCompare(String(a.placed_utc || '')));
    if (!gs.length) return '';
    return `<h3 class="mb-sec">${STATUS_LABEL[st]} · ${gs.length}</h3>`
      + gs.map((g) => slip(g, warnFor(g.id))).join('');
  }).join('');
  const hasSlips = S.doc.bets.some((b) => b.source === 'import');
  host.innerHTML =
    totals(sum)
    + (S.note ? `<div class="mb-warn">${esc(S.note)}</div>` : '')
    + (S.facts === null ? '<div class="mb-hint">Results feed not reachable — every leg shows as open until it is.</div>' : '')
    + (S.doc.bets.length - (Number(S.doc.exported_n) || 0) >= 5
      ? `<div class="mb-warn">${S.doc.bets.length - (Number(S.doc.exported_n) || 0)} bets since your last backup — `
        + 'they live only in this browser; EXPORT keeps a copy.</div>' : '')
    + '<div class="mb-actions">'
      + '<button type="button" class="leg-chip leg-chip--active" data-mb="build">+ BUILD A BET</button>'
      + '<button type="button" class="leg-chip" data-mb="export">EXPORT</button>'
      + '<label class="leg-chip mb-import">IMPORT<input type="file" accept="application/json,.json" data-mb="import" hidden></label>'
      + (hasSlips ? '' : '<button type="button" class="leg-chip" data-mb="slips">ADD MY 19 FANDUEL SLIPS</button>')
    + '</div>'
    + '<div id="mb-builder"></div>'
    + (S.doc.bets.length ? analytics(sum) + sections
      : '<div class="state">No bets yet. Tap I BET THIS on any card in GAME, WEEK or MY, '
        + 'or BUILD A BET from this week\'s legs. Bets stay on this device — EXPORT keeps a copy.</div>');
}

async function onLedgerClick(e) {
  const btn = e.target.closest('[data-mb]');
  if (!btn || btn.dataset.mb === 'import') return;
  const act = btn.dataset.mb;
  const card = btn.closest('[data-bet]');
  if (act === 'delete' && card) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete this bet from the ledger?')) return;
    S.doc = B.removeBet(S.doc, card.dataset.bet);
    persist();
    paintLedger();
  } else if (act === 'settle' && card) {
    // eslint-disable-next-line no-alert
    const v = window.prompt('What did the book pay back in total (stake included)? Leave empty to use the graded amount.', '');
    if (v === null) return;
    if (v.trim() !== '' && !Number.isFinite(Number(v))) return;
    S.doc = B.setSettled(S.doc, card.dataset.bet, v.trim() === '' ? null : Number(v));
    persist();
    paintLedger();
  } else if (act === 'export') {
    const blob = new Blob([B.exportText(S.doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `my-bets-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    S.doc = { ...S.doc, exported_n: S.doc.bets.length };
    persist();
    paintLedger();
  } else if (act === 'slips') {
    let ev = null;
    try { ev = await loadJson(SLIPS); } catch { ev = null; }
    const f = await facts();
    if (!ev || !f) { announce('The slips file or the results feed is not reachable right now.'); return; }
    const slips = B.slipsToBets(ev, B.weekOfDate(f));
    const have = new Set(S.doc.bets.map((b) => b.id));
    S.doc = { ...S.doc, bets: [...S.doc.bets, ...slips.filter((b) => !have.has(b.id))] };
    persist();
    paintLedger();
  } else if (act === 'build') {
    openBuilder();
  }
}

function onLedgerChange(e) {
  const input = e.target.closest('input[data-mb="import"]');
  if (!input || !input.files || !input.files[0]) return;
  input.files[0].text().then((text) => {
    const r = B.importText(S.doc, text);
    if (r.error) { announce(`Import refused: ${r.error}`); S.note = `import refused: ${r.error}`; }
    else {
      S.doc = r.doc;
      S.note = `imported ${r.added} bet(s)${r.kept ? `, kept ${r.kept} already here` : ''}`;
      persist();
    }
    paintLedger();
  });
}

/* --------------------------------------------------------- the builder */

const B_STATE = { picked: [], q: '' };

function builderLegs(p) {
  const out = [];
  for (const row of (p && p.players) || []) {
    for (const r of row.rungs || []) {
      out.push({ market: row.market, selection: r.selection, model_prob: r.model_prob,
        game_id: row.game_id, team: row.team, side: row.side, player: row.player,
        gsis_id: row.gsis_id, position: row.position, line: r.line, owner: row.gsis_id });
    }
  }
  for (const row of (p && p.atd_legs) || []) {
    const r = (row.rungs || [])[0];
    if (r) out.push({ market: 'anytime_td', selection: r.selection, model_prob: r.model_prob,
      game_id: row.game_id, team: row.team, side: row.side, player: row.player,
      gsis_id: row.gsis_id, position: row.position, line: r.line, owner: row.gsis_id });
  }
  for (const g of (p && p.game_legs) || []) {
    out.push({ ...g, owner: `team:${g.team}` });
  }
  return out;
}

/** Why `leg` cannot join `picked` (null when it can): same rules as MY. */
export function builderRefusal(picked, leg) {
  if (picked.length >= B.MAX_LEGS) return `at most ${B.MAX_LEGS} legs`;
  if (picked.some((l) => l.selection === leg.selection)) return 'already on the bet';
  if (picked.some((l) => l.owner === leg.owner && l.market === leg.market)) return 'one line per player and market';
  const side = (l) => (['moneyline', 'spread'].includes(l.market) ? `${l.game_id}|${l.team}` : null);
  if (side(leg) && picked.some((l) => side(l) === side(leg))) return 'one leg per game side (R74)';
  return null;
}

async function openBuilder() {
  const box = S.host && S.host.querySelector('#mb-builder');
  if (!box) return;
  box.innerHTML = '<div class="state state--loading">Loading this week\'s legs…</div>';
  const p = await pool();
  if (!p) { box.innerHTML = '<div class="state">The leg pool is not reachable right now.</div>'; return; }
  const all = builderLegs(p);
  const paint = () => {
    const q = B_STATE.q.trim().toLowerCase();
    const hits = q.length < 2 ? [] : all.filter((l) => String(l.selection).toLowerCase().includes(q)
      || String(l.player || l.team || '').toLowerCase().includes(q)).slice(0, 24);
    box.innerHTML = '<div class="card mb-build">'
      + `<label class="mb-field">FIND A PLAYER OR TEAM<input id="mb-q" class="mp-input" autocomplete="off" value="${esc(B_STATE.q)}" placeholder="e.g. bijan, KC"></label>`
      + `<div class="legseg mb-hits">${hits.map((l, i) => {
        const why = builderRefusal(B_STATE.picked, l);
        return `<button type="button" class="leg-chip" data-hit="${all.indexOf(l)}"${why ? ` disabled title="${esc(why)}"` : ''}>`
          + `${esc(l.selection)} · ${pct(l.model_prob)}</button>`;
      }).join('')}</div>`
      + (q.length >= 2 && !hits.length ? '<div class="mb-hint">No leg on this week\'s pool matches.</div>' : '')
      + `<div class="mb-picked">${B_STATE.picked.map((l, i) => `<button type="button" class="leg-chip leg-chip--active" data-unpick="${i}" aria-label="Remove ${esc(l.selection)}">${esc(l.selection)} ✕</button>`).join('')}</div>`
      + '<div class="mb-sheet-act">'
        + '<button type="button" class="leg-chip" data-bx="close">CLOSE</button>'
        + `<button type="button" class="leg-chip leg-chip--active" data-bx="next"${B_STATE.picked.length ? '' : ' disabled'}>NEXT · ${B_STATE.picked.length} LEG${B_STATE.picked.length === 1 ? '' : 'S'}</button>`
      + '</div></div>';
    const input = box.querySelector('#mb-q');
    input.addEventListener('input', () => {
      B_STATE.q = input.value;
      const at = input.selectionStart;
      paint();
      const again = box.querySelector('#mb-q');
      again.focus();
      try { again.setSelectionRange(at, at); } catch { /* not a text input */ }
    });
  };
  box.onclick = (e) => {
    const hit = e.target.closest('[data-hit]');
    if (hit && !hit.disabled) { B_STATE.picked.push(all[Number(hit.dataset.hit)]); paint(); return; }
    const un = e.target.closest('[data-unpick]');
    if (un) { B_STATE.picked.splice(Number(un.dataset.unpick), 1); paint(); return; }
    const bx = e.target.closest('[data-bx]');
    if (!bx) return;
    if (bx.dataset.bx === 'close') { box.innerHTML = ''; return; }
    if (bx.dataset.bx === 'next' && B_STATE.picked.length) {
      const legs = B_STATE.picked.slice();
      B_STATE.picked = [];
      B_STATE.q = '';
      box.innerHTML = '';
      openBetSheet({ source: 'manual', week: p.week, legs, title: 'built' });
    }
  };
  paint();
}

/* ------------------------------------------------------------- mount */

/** Mount the BETS screen into `host` (PARLAYS calls it on the BETS chip). */
export default async function mountMyBets(host) {
  ensureDoc();
  S.host = host;
  if (!host.dataset.mbWired) {
    host.dataset.mbWired = '1';
    host.addEventListener('click', onLedgerClick);
    host.addEventListener('change', onLedgerChange);
  }
  paintLedger();
  await facts();
  if (S.host === host && host.isConnected) paintLedger();
}

/** Re-read the ledger (another tab, or a sheet saved from a card) and repaint. */
export function refresh() {
  S.doc = null;
  ensureDoc();
  if (S.host && S.host.isConnected) paintLedger();
}
