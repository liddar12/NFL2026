/* app/bets.js — R110 (R99 E2): MY BETS, the pure core.
 *
 * The owner's bets live ON THIS DEVICE (owner, 2026-10-04: "on this device +
 * export"), so nothing here talks to a server. This module holds everything that
 * can be tested without a page:
 *
 *   - the store: one versioned document in localStorage, every read and write in
 *     try/catch, an in-memory fallback the view admits to, export / import;
 *   - grading: a line-for-line mirror of the pipeline's graders
 *     (resolve_my_cards.grade_game / grade_prop, resolve_parlay_legs.grade_atd)
 *     over data/bet_facts.json, so a leg grades the same here as in the record;
 *     R106 (one miss loses; voids drop out; only all-hit wins), R108 (an
 *     excluded game's legs are void), and status gating (only a FINAL score
 *     settles anything);
 *   - money: American odds, a win pays stake x decimal; a void leg is divided
 *     out at its own price when the bet carries one;
 *   - the exposure guard: a player or a team side on 2+ bets in one week;
 *   - the ledger's analytics, and the import of the owner's FanDuel slips.
 *
 * Lazy: loaded on the BETS chip or an "I bet this" tap, never on boot.
 */

export const STORE_KEY = 'nfl26.mybets.v1';
export const DOC_VERSION = 1;
export const MAX_LEGS = 10;
const PROP_COL = { qb_pass_yds: 0, rb_rush_yds: 1, wr_rec_yds: 2 };
const GAME_MARKETS = new Set(['moneyline', 'spread']);
const ATD = 'anytime_td';
const SPREAD_RE = /^([A-Z]{2,3}) ([+-]?\d+(?:\.\d+)?)$/;

/* ---------------------------------------------------------------- odds */

/** American odds -> decimal (stake included), or null for a non-price. */
export function americanToDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || (a > -100 && a < 100)) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

/** Decimal -> American, rounded the way a book prints it. */
export function decimalToAmerican(decimal) {
  const d = Number(decimal);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** "+260" / "-150" for display. */
export function fmtAmerican(american) {
  const a = Number(american);
  return Number.isFinite(a) ? (a > 0 ? `+${a}` : String(a)) : '—';
}

/* ------------------------------------------------------------- grading */

/** The handicap a spread leg is evaluated at (resolve_my_cards.spread_handicap). */
export function spreadHandicap(leg) {
  if (typeof leg.line === 'number' && Number.isFinite(leg.line)) return leg.line;
  const m = SPREAD_RE.exec(String(leg.selection || ''));
  if (!m) return null;
  if (leg.team && m[1] !== leg.team) return null;
  return Number(m[2]);
}

const teamOf = (leg) => leg.team || String(leg.selection || '').split(' ')[0] || null;

/** The leg's game in one week of facts: by id, else (a week leg carries none) by team. */
function findGame(leg, wk) {
  const games = (wk && wk.games) || {};
  if (leg.game_id != null && games[String(leg.game_id)]) {
    return [String(leg.game_id), games[String(leg.game_id)]];
  }
  const team = teamOf(leg);
  if (!team) return [null, null];
  const hits = Object.entries(games).filter(([, g]) => g.h === team || g.a === team);
  return hits.length === 1 ? hits[0] : [null, null];
}

function sideOf(leg, game) {
  if (leg.side === 'home' || leg.side === 'away') return leg.side;
  const team = teamOf(leg);
  if (game && team === game.h) return 'home';
  if (game && team === game.a) return 'away';
  return null;
}

/**
 * {result: hit|miss|void|pending, actual, reason} for one leg of one bet.
 * `facts` is data/bet_facts.json (or null: everything pending).
 */
export function gradeLeg(leg, facts) {
  const pending = (reason) => ({ result: 'pending', actual: null, reason });
  if (leg.slip_result) {
    // an imported slip leg this app cannot grade keeps the slip's own result
    const r = String(leg.slip_result);
    return { result: ['hit', 'miss', 'void'].includes(r) ? r : 'pending', actual: null,
      reason: 'slip_result' };
  }
  const wk = facts && facts.weeks && facts.weeks[String(leg.week)];
  const [gid, game] = findGame(leg, wk);
  const excluded = new Set(((facts && facts.excluded) || []).map(String));
  if ((leg.game_id != null && excluded.has(String(leg.game_id))) || (gid && excluded.has(gid))) {
    return { result: 'void', actual: null, reason: 'excluded_game' };
  }
  if (!wk) return pending('week_not_published');
  const market = leg.market;
  if (GAME_MARKETS.has(market)) {
    if (!game) return pending('no_game');
    const side = sideOf(leg, game);
    if (!side) return pending('no_side');
    if (typeof game.hs === 'number' && typeof game.as === 'number') {
      const actual = { home_score: game.hs, away_score: game.as };
      if (market === 'moneyline') {
        if (game.hs === game.as) return { result: 'void', actual, reason: 'tie' };
        const hit = side === 'home' ? game.hs > game.as : game.as > game.hs;
        return { result: hit ? 'hit' : 'miss', actual, reason: null };
      }
      const hcap = spreadHandicap(leg);
      if (hcap == null) return pending('no_line');
      const [own, opp] = side === 'home' ? [game.hs, game.as] : [game.as, game.hs];
      const margin = own + hcap - opp;
      if (margin === 0) return { result: 'void', actual, reason: 'push' };
      return { result: margin > 0 ? 'hit' : 'miss', actual, reason: null };
    }
    if (game.w === 'home' || game.w === 'away') {
      // a winner-only source grades a moneyline and nothing else
      if (market !== 'moneyline') return pending('no_final_score');
      return { result: game.w === side ? 'hit' : 'miss', actual: { winner: game.w }, reason: null };
    }
    return pending('no_final');
  }
  const p = leg.gsis_id != null ? (wk.players || {})[String(leg.gsis_id)] : null;
  if (market in PROP_COL) {
    if (leg.line == null || !Number.isFinite(Number(leg.line))) return pending('no_line');
    if (!p || p.y == null) return pending('no_stat_line');
    if (p.y === 'dnp') return { result: 'void', actual: null, reason: 'did_not_play' };
    const yards = Number(p.y[PROP_COL[market]]);
    if (!Number.isFinite(yards)) return pending('no_stat_line');
    return { result: yards >= Number(leg.line) ? 'hit' : 'miss', actual: yards, reason: null };
  }
  if (market === ATD) {
    if (!p || p.td == null) return pending('no_stat_line');
    if (p.td === 'dnp') return { result: 'void', actual: null, reason: 'did_not_play' };
    return { result: Number(p.td) >= 1 ? 'hit' : 'miss', actual: { tds: Number(p.td) }, reason: null };
  }
  return pending('unknown_market');
}

/** R106 — a bet's status from its leg results. */
export function betStatus(results) {
  if (!results.length) return 'open';
  if (results.includes('miss')) return 'lost';
  if (results.includes('pending')) return 'open';
  if (results.every((r) => r === 'void')) return 'void';
  return 'won';
}

/**
 * Grade a whole bet: per-leg results, status and money. A win pays
 * stake x the book's decimal; a void leg is divided out at its own price
 * (1 / implied) when the leg carries one, and otherwise the return is marked an
 * estimate. `settled_return`, typed from the book, always wins.
 */
export function gradeBet(bet, facts) {
  const legs = (bet.legs || []).map((l) => ({ ...l, ...gradeLeg({ week: bet.week, ...l }, facts) }));
  const status = betStatus(legs.map((l) => l.result));
  const stake = Number(bet.stake) || 0;
  const dec = americanToDecimal(bet.odds);
  let ret = null;
  let estimate = false;
  if (status === 'lost') ret = 0;
  else if (status === 'void') ret = stake;
  else if (status === 'won' && dec) {
    let d = dec;
    for (const l of legs) {
      if (l.result !== 'void') continue;
      const ip = Number(l.implied_prob);
      if (ip > 0 && ip < 1) d *= ip; else estimate = true;
    }
    ret = stake * Math.max(d, 1);
  }
  if (bet.settled_return != null && Number.isFinite(Number(bet.settled_return))
      && status !== 'open') {
    ret = Number(bet.settled_return);
    estimate = false;
  }
  return { ...bet, legs, status, ret, net: ret == null ? null : ret - stake, estimate };
}

/* --------------------------------------------------------------- store */

export function emptyDoc() {
  return { kind: 'my_bets', version: DOC_VERSION, bets: [] };
}

/** null when `doc` is a valid store document, else the reason it is not. */
export function validateDoc(doc) {
  if (!doc || typeof doc !== 'object') return 'not an object';
  if (doc.kind !== 'my_bets') return 'not a MY BETS file (kind is not "my_bets")';
  if (doc.version !== DOC_VERSION) return `unsupported version ${doc.version}`;
  if (!Array.isArray(doc.bets)) return 'bets is not a list';
  for (const b of doc.bets) {
    if (!b || typeof b.id !== 'string' || !b.id) return 'a bet has no id';
    if (!Array.isArray(b.legs) || !b.legs.length) return `bet ${b.id} has no legs`;
    if (b.legs.length > MAX_LEGS && b.source !== 'import') return `bet ${b.id} has more than ${MAX_LEGS} legs`;
    if (!(Number(b.stake) > 0)) return `bet ${b.id} has no stake`;
    if (!Number.isInteger(Number(b.week))) return `bet ${b.id} has no week`;
    for (const l of b.legs) {
      if (!l || typeof l.market !== 'string' || typeof l.selection !== 'string') {
        return `bet ${b.id} has a leg without a market and a selection`;
      }
    }
  }
  return null;
}

/** {doc, persistent, note}. Storage that throws or holds junk never crashes the view. */
export function loadStore(storage) {
  try {
    const raw = storage.getItem(STORE_KEY);
    if (raw == null) return { doc: emptyDoc(), persistent: true, note: null };
    const doc = JSON.parse(raw);
    const bad = validateDoc(doc);
    if (bad) return { doc: emptyDoc(), persistent: true, note: `the saved ledger was unreadable (${bad}); starting empty` };
    return { doc, persistent: true, note: null };
  } catch {
    return { doc: emptyDoc(), persistent: false,
      note: 'this browser will not keep data (private mode?): bets last until the page closes — export them' };
  }
}

/** true when written; false when storage refused (the caller keeps the in-memory doc). */
export function saveStore(storage, doc) {
  try { storage.setItem(STORE_KEY, JSON.stringify(doc)); return true; } catch { return false; }
}

/** A stable fingerprint: one bet per week per set of selections. */
export function fingerprint(bet) {
  return `${bet.week}|${(bet.legs || []).map((l) => `${l.market}:${l.selection}`).sort().join('|')}`;
}

export function newId(now = Date.now(), rnd = Math.random()) {
  return `b${now.toString(36)}${Math.floor(rnd * 1e8).toString(36)}`;
}

const LEG_FIELDS = ['market', 'selection', 'game_id', 'team', 'side', 'player', 'gsis_id',
  'position', 'line', 'model_prob', 'implied_prob', 'slip_result', 'date'];

/** A bet record from a card's legs. Only the fields grading and display need are kept. */
export function makeBet({ source, legs, stake, odds, week, placed_utc, title = null, note = null,
  model = null, id = null }) {
  return {
    id: id || newId(),
    placed_utc,
    week: Number(week),
    source,
    title,
    stake: Number(stake),
    odds: Number(odds),
    model: model == null ? null : Number(model),
    note,
    legs: legs.map((l) => {
      const o = {};
      for (const k of LEG_FIELDS) if (l[k] != null) o[k] = l[k];
      return o;
    }),
  };
}

/** {doc, duplicate}. A second bet on the same card in the same week is allowed but flagged. */
export function addBet(doc, bet) {
  const fp = fingerprint(bet);
  const duplicate = doc.bets.some((b) => fingerprint(b) === fp);
  return { doc: { ...doc, bets: [...doc.bets, bet] }, duplicate };
}

export function removeBet(doc, id) {
  return { ...doc, bets: doc.bets.filter((b) => b.id !== id) };
}

export function setSettled(doc, id, amount) {
  return { ...doc, bets: doc.bets.map((b) => (b.id === id
    ? { ...b, settled_return: amount == null || amount === '' ? null : Number(amount) } : b)) };
}

/** The backup file's text: the document itself, stable key order per bet. */
export function exportText(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Merge an exported file into the ledger: {doc, added, kept, error}. A bet whose
 * id is already here is KEPT as it is on this device (never silently
 * overwritten); a malformed file changes nothing and says why.
 */
export function importText(doc, text) {
  let incoming;
  try { incoming = JSON.parse(text); } catch { return { doc, added: 0, kept: 0, error: 'not JSON' }; }
  const bad = validateDoc(incoming);
  if (bad) return { doc, added: 0, kept: 0, error: bad };
  const have = new Set(doc.bets.map((b) => b.id));
  const fresh = incoming.bets.filter((b) => !have.has(b.id));
  return { doc: { ...doc, bets: [...doc.bets, ...fresh] }, added: fresh.length,
    kept: incoming.bets.length - fresh.length, error: null };
}

/* ------------------------------------------------------------ exposure */

const legKey = (l) => {
  if (l.gsis_id) return [`p:${l.gsis_id}`, l.player || String(l.selection).replace(/ (\d|ATD|anytime).*$/i, '')];
  if (l.player) return [`n:${String(l.player).toLowerCase()}`, l.player];
  if (GAME_MARKETS.has(l.market)) return [`t:${teamOf(l)}`, teamOf(l)];
  return [null, null];
};

/**
 * Who is riding on more than one bet in the same week: [{week, key, label,
 * count, bets: [id]}], most-exposed first. A player counts once per bet however
 * many of their markets the bet holds; a team side counts through its game legs.
 * `extra` (a bet being saved) is included so the sheet can warn BEFORE saving.
 */
export function exposure(bets, extra = null) {
  const all = extra ? [...bets, extra] : bets;
  const by = new Map();
  for (const b of all) {
    const seen = new Set();
    for (const l of b.legs || []) {
      const [key, label] = legKey(l);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const k = `${b.week}|${key}`;
      const row = by.get(k) || { week: Number(b.week), key, label, count: 0, bets: [] };
      row.count += 1;
      row.bets.push(b.id);
      by.set(k, row);
    }
  }
  return [...by.values()].filter((r) => r.count >= 2)
    .sort((a, b) => b.count - a.count || a.week - b.week || String(a.label).localeCompare(String(b.label)));
}

/* ----------------------------------------------------------- analytics */

const r4 = (x) => Math.round(x * 1e4) / 1e4;

function block(graded) {
  const settled = graded.filter((g) => g.status === 'won' || g.status === 'lost');
  const staked = settled.reduce((s, g) => s + Number(g.stake || 0), 0);
  const returned = settled.reduce((s, g) => s + Number(g.ret || 0), 0);
  const won = settled.filter((g) => g.status === 'won').length;
  const priced = settled.filter((g) => Number(g.model) > 0);
  const book = settled.map((g) => americanToDecimal(g.odds)).filter(Boolean);
  return {
    bets: graded.length,
    open: graded.filter((g) => g.status === 'open').length,
    won,
    lost: settled.length - won,
    void: graded.filter((g) => g.status === 'void').length,
    staked,
    returned: r4(returned),
    net: r4(returned - staked),
    roi: staked ? r4((returned - staked) / staked) : null,
    hit_rate: settled.length ? r4(won / settled.length) : null,
    model_hit: priced.length ? r4(priced.reduce((s, g) => s + Number(g.model), 0) / priced.length) : null,
    book_hit: book.length ? r4(book.reduce((s, d) => s + 1 / d, 0) / book.length) : null,
  };
}

/** The ledger's numbers: all bets, by leg count, by source. */
export function summarize(graded) {
  const group = (keyOf) => {
    const m = new Map();
    for (const g of graded) {
      const k = keyOf(g);
      m.set(k, [...(m.get(k) || []), g]);
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
      .map(([k, gs]) => [k, block(gs)]));
  };
  return { all: block(graded), by_legs: group((g) => g.legs.length), by_source: group((g) => g.source) };
}

/* --------------------------------------------------- FanDuel slip import */

const SLIP_RESULT = { W: 'hit', L: 'miss', V: 'void', hit: 'hit', miss: 'miss', void: 'void' };

/**
 * The owner's transcribed FanDuel slips (docs/backlog/evidence) as bets. Their
 * legs carry no game id or player id, so they keep the slip's own result
 * ("slip result") and are never counted as model-graded. `weekOf(date)` maps a
 * slip date to its NFL week.
 */
export function slipsToBets(evidence, weekOf) {
  const out = [];
  for (const t of (evidence && evidence.tickets) || []) {
    const legs = (t.legs || []).map((l) => ({
      market: String(l.market || 'other'),
      selection: [l.player || l.team || '', l.market || '', l.line != null ? l.line : ''].join(' ').replace(/\s+/g, ' ').trim(),
      player: l.player || undefined,
      team: l.team || undefined,
      position: l.pos || undefined,
      line: l.line != null && Number.isFinite(Number(l.line)) ? Number(l.line) : undefined,
      date: l.date || t.placed,
      slip_result: SLIP_RESULT[l.result] || 'pending',
    }));
    const wk = weekOf((t.legs && t.legs[0] && t.legs[0].date) || t.placed);
    if (!legs.length || !Number.isInteger(wk)) continue;
    out.push(makeBet({ id: `slip-${t.id}`, source: 'import', legs, stake: Number(t.stake),
      odds: Number(t.odds), week: wk, placed_utc: t.placed || null,
      title: t.kind || null }));
    if (Number.isFinite(Number(t.ret))) out[out.length - 1].settled_return = Number(t.ret);
  }
  return out;
}
