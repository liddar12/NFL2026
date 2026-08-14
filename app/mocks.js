/* app/mocks.js — MOCK / DRAFT HISTORY + LIVE-ROOM CALIBRATION (pure).
 *
 * WHY THIS FILE EXISTS (R23-E3). localStorage `nfl2026.mocklocks.v1` stored
 * completed mock drafts and was re-read for exactly one purpose: to append the
 * next one. Nothing consumed it. The key was named "mocklocks" and the UI
 * called each row a "learning record", so the app claimed a mechanism it did
 * not have. This module removes that claim and replaces it with the part that
 * is actually defensible.
 *
 * WHAT A MOCK CAN AND CANNOT TEACH — the whole design turns on this:
 *
 *   SIM rooms teach NOTHING. In a sim the opponents are this app's own
 *   sampler: adpOpponentPick draws around ADP with sigma = ADP_NOISE_BASE +
 *   ADP_NOISE_PER_ROUND x round, sharkOpponentPick is our own greedy engine,
 *   aiPlusOpponentPick is our own league-profile engine. Fitting a "how does
 *   the room behave" model to those picks measures our own RNG and reports it
 *   back as evidence. That is circular, and it is exactly the kind of fake
 *   mechanism this project treats as unacceptable. Sim records are therefore
 *   kept as HISTORY ONLY and are excluded from every calibration number here.
 *
 *   LIVE rooms teach something real. In LIVE play (draftCfg.play === 'live')
 *   the manager taps the player each real team actually took
 *   (draft-sim.takeOpponentPickAt) — no opponent model is involved, the log is
 *   a transcript of a real draft room. Comparing those observed pick numbers
 *   to consensus ADP is a genuine measurement of how far from the market THIS
 *   room drafts, and which positions it takes earlier than consensus.
 *
 * POLICY BOUNDARY (non-negotiable). Everything computed here is an
 * OPPONENT MODEL: when players leave the board in this room. ADP is market
 * data and is allowed to model what the room will do. Nothing in this file
 * feeds a projection, a signal weight, or a parlay probability, and
 * expectedGoneBy() returns a PICK NUMBER — never points, never a value. If a
 * caller ever wires one of these outputs into adjOf()/projections, that is the
 * bug, not a feature.
 *
 * HONESTY RULES ENFORCED BY tests/feature/mocks.test.mjs:
 *   - roomCalibration() over sim-only history returns { ready:false } with a
 *     reason that names the circularity. It never invents a number.
 *   - Below MIN_CALIBRATION_PICKS observed picks it stays not-ready.
 *   - Legacy v1 records carry no observed pick log and no known play mode, so
 *     they can never become calibration evidence — but they are never dropped.
 *
 * PURE + DOM-FREE. localStorage is reached only through an injected storage
 * handle (defaulting to globalThis.localStorage when one exists), so node
 * unit tests import this file directly with zero setup. The only impurity is
 * the DEFAULT value of recordDraft/recordAuction's `nowIso` argument; tests
 * always pass it explicitly.
 */

import { ADP_NOISE_BASE, ADP_NOISE_PER_ROUND } from './draft-sim.js';

/* --------------------------------------------------------------------------
 * Keys, versions, evidence floors
 * ------------------------------------------------------------------------ */

/** The OLD key. Read-only from here on: migrated, never written, never wiped. */
export const MOCKS_KEY_V1 = 'nfl2026.mocklocks.v1';

/** The key records live under now. "history", because that is what they are. */
export const MOCKS_KEY = 'nfl2026.mockhistory.v2';

export const HISTORY_VERSION = 2;

/** Retained records (matches the v1 cap, so no user loses rows to the move). */
export const HISTORY_LIMIT = 50;

/** Observed LIVE opponent picks required before any calibration is reported.
 * Two rounds of a 12-team room. Below this the spread is noise about noise. */
export const MIN_CALIBRATION_PICKS = 24;

/** Observed picks at ONE position before that position gets its own drift
 * number; under it, expectedGoneBy falls back to the room-wide drift. */
export const MIN_POSITION_PICKS = 8;

/** Play modes. `null` = unknown (a migrated v1 snake record) — never live. */
export const PLAY_MODES = Object.freeze(['sim', 'live']);

/* --------------------------------------------------------------------------
 * Storage plumbing (defensive; never throws)
 * ------------------------------------------------------------------------ */

/** The ambient localStorage, or null when unavailable/blocked. */
function defaultStorage() {
  try {
    const g = typeof globalThis === 'undefined' ? null : globalThis;
    return g && g.localStorage ? g.localStorage : null;
  } catch (err) {
    return null; // access itself can throw in locked-down embeds
  }
}

function readJson(store, key) {
  try {
    const raw = store && store.getItem(key);
    if (raw == null) return undefined;      // absent, distinct from "empty list"
    const parsed = JSON.parse(raw);
    return parsed === null ? undefined : parsed;
  } catch (err) {
    return undefined;
  }
}

function writeJson(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false; // quota / private mode / blocked — the session still works
  }
}

/** Number or null. null/undefined/''/booleans are ABSENT, not zero — a missing
 * consensus ADP must never coerce to pick 0 and quietly become evidence. */
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const posOf = (v) => String(v == null ? '' : v).toUpperCase();

/* --------------------------------------------------------------------------
 * Record shape
 * ------------------------------------------------------------------------ */

/**
 * A v2 history record:
 *   { version:2, created_utc, kind:'snake'|'auction', play:'sim'|'live'|null,
 *     room_type:'adp'|'shark'|'aiplus'|null, league_size, my_slot, budget|null,
 *     roster_config, result, my_players:[{gsis_id,name,position}],
 *     observed:[{pick, team, name, position, adp}],
 *     migrated_from?: 'nfl2026.mocklocks.v1' }
 *
 * `observed` is the OPPONENTS' picks only, and is populated ONLY for
 * play === 'live'. My own picks are mine, not the room's; a sim's picks are
 * this app's sampler, not the room's.
 */

function normalizePlayers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => ({
    gsis_id: p && p.gsis_id != null ? String(p.gsis_id) : null,
    name: p && p.name != null ? String(p.name) : '',
    position: posOf(p && p.position),
  }));
}

function normalizeObserved(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e) continue;
    const pick = num(e.pick);
    const adp = num(e.adp);
    if (pick == null || pick < 1) continue;
    out.push({
      pick,
      team: num(e.team),
      name: e.name != null ? String(e.name) : '',
      position: posOf(e.position),
      adp,
    });
  }
  return out;
}

/** Normalize any stored row (v1 or v2) into a v2 record. Pure, never throws. */
export function normalizeRecord(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const legacy = Number(r.version) !== HISTORY_VERSION;
  const kind = r.kind === 'auction' ? 'auction' : 'snake';
  // v1 snake rows were written ONLY for the ADP room (finishDraft gated on
  // roomType === 'adp'), so that inference is safe. v1 never stored the play
  // mode for snake rows, so it stays UNKNOWN — and unknown is never live.
  let play = PLAY_MODES.includes(r.play) ? r.play : null;
  let roomType = ['adp', 'shark', 'aiplus'].includes(r.room_type) ? r.room_type : null;
  if (legacy) {
    if (kind === 'snake') { play = null; roomType = roomType || 'adp'; }
  }
  const out = {
    version: HISTORY_VERSION,
    created_utc: r.created_utc != null ? String(r.created_utc) : '',
    kind,
    play,
    room_type: roomType,
    league_size: num(r.league_size),
    my_slot: num(r.my_slot),
    budget: num(r.budget),
    roster_config: r.roster_config && typeof r.roster_config === 'object'
      ? { ...r.roster_config } : null,
    result: r.result && typeof r.result === 'object' ? { ...r.result } : null,
    my_players: normalizePlayers(r.my_players),
    // A record that is not LIVE has no observed room, by construction.
    observed: play === 'live' ? normalizeObserved(r.observed) : [],
  };
  if (legacy) out.migrated_from = MOCKS_KEY_V1;
  else if (r.migrated_from) out.migrated_from = String(r.migrated_from);
  return out;
}

/** Build a v2 record from a finished snake draft (draft-sim state) + sheet. */
export function recordDraft(draft, result, nowIso) {
  const d = draft || {};
  const mySlot = num(d.mySlot);
  const play = PLAY_MODES.includes(d.play) ? d.play : 'sim';
  const log = Array.isArray(d.log) ? d.log : [];
  return normalizeRecord({
    version: HISTORY_VERSION,
    created_utc: nowIso || new Date().toISOString(),
    kind: 'snake',
    play,
    room_type: d.roomType || null,
    league_size: d.leagueSize,
    my_slot: mySlot,
    roster_config: d.shape ? d.shape.config : null,
    result,
    my_players: (d.rosters && mySlot ? (d.rosters[mySlot - 1] || {}).players : []) || [],
    // Opponents only: a transcript of what the OTHER teams did.
    observed: play === 'live' ? log.filter((l) => num(l && l.team) !== mySlot) : [],
  });
}

/** Build a v2 record from a finished auction. Auctions have no pick order, so
 * they carry NO observed pick log and never calibrate ADP drift — they are
 * history. (In-room price behaviour is already modelled live by
 * app/auction.js liveInflation()/tendencies; nothing here duplicates it.) */
export function recordAuction(auction, result, myPlayers, nowIso) {
  const a = auction || {};
  return normalizeRecord({
    version: HISTORY_VERSION,
    created_utc: nowIso || new Date().toISOString(),
    kind: 'auction',
    play: PLAY_MODES.includes(a.play) ? a.play : 'sim',
    room_type: null,
    league_size: a.leagueSize,
    my_slot: a.mySlot,
    budget: a.budget,
    roster_config: a.shape ? a.shape.config : null,
    result,
    my_players: myPlayers || [],
    observed: [],
  });
}

/* --------------------------------------------------------------------------
 * Persistence + the v1 -> v2 migration
 * ------------------------------------------------------------------------ */

/**
 * Every stored record, oldest first, normalised to v2.
 *
 * MIGRATION: when the v2 key is absent, v1 rows are read and normalised in
 * place, so a user with existing "mocklocks" sees their history immediately
 * and loses nothing. The v1 key is NEVER deleted — if this build is rolled
 * back, the old rows are still there. Once v2 exists it is authoritative.
 * NEVER throws.
 */
export function loadHistory(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  const v2 = readJson(store, MOCKS_KEY);
  if (Array.isArray(v2)) return v2.map(normalizeRecord);
  const v1 = readJson(store, MOCKS_KEY_V1);
  if (Array.isArray(v1)) return v1.map(normalizeRecord);
  return [];
}

/** Persist (normalised, trimmed to HISTORY_LIMIT). Returns true when written. */
export function saveHistory(records, storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  const rows = (Array.isArray(records) ? records : []).map(normalizeRecord);
  return writeJson(store, MOCKS_KEY, rows.slice(-HISTORY_LIMIT));
}

/**
 * Materialise the v1 -> v2 move without adding a record. Idempotent: once the
 * v2 key exists this is a no-op. Returns { migrated, wrote }. Safe to call on
 * every mount — that is the intended wiring, so the review panel is correct
 * even for a user who never runs another draft.
 */
export function migrateLegacy(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  if (Array.isArray(readJson(store, MOCKS_KEY))) return { migrated: 0, wrote: false };
  const v1 = readJson(store, MOCKS_KEY_V1);
  if (!Array.isArray(v1) || v1.length === 0) return { migrated: 0, wrote: false };
  const rows = v1.map(normalizeRecord).slice(-HISTORY_LIMIT);
  return { migrated: rows.length, wrote: writeJson(store, MOCKS_KEY, rows) };
}

/** Append one record (migrating first) and persist. Returns the new list. */
export function appendMock(record, storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  const rows = loadHistory(store);
  rows.push(normalizeRecord(record));
  const trimmed = rows.slice(-HISTORY_LIMIT);
  saveHistory(trimmed, store);
  return trimmed;
}

/** Forget the history. Clears BOTH keys — an explicit user wipe means both. */
export function clearHistory(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  let ok = true;
  for (const key of [MOCKS_KEY, MOCKS_KEY_V1]) {
    try { store.removeItem(key); } catch (err) { ok = false; }
  }
  return ok;
}

/* --------------------------------------------------------------------------
 * The review panel's counts (Option B half: history, honestly labelled)
 * ------------------------------------------------------------------------ */

/** Counts for the history panel header. Pure. */
export function historySummary(records) {
  const rows = Array.isArray(records) ? records : [];
  const out = {
    total: rows.length,
    snake: 0, auction: 0,
    sim: 0, live: 0, unknown_play: 0,
    legacy: 0,
    observed_picks: 0,
  };
  for (const r of rows) {
    if (r.kind === 'auction') out.auction += 1; else out.snake += 1;
    if (r.play === 'live') out.live += 1;
    else if (r.play === 'sim') out.sim += 1;
    else out.unknown_play += 1;
    if (r.migrated_from) out.legacy += 1;
    out.observed_picks += (r.observed || []).length;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * CALIBRATION — live rooms only (Option A half: a real, consumed mechanism)
 * ------------------------------------------------------------------------ */

/** The records that are admissible evidence: LIVE snake drafts with a log. */
export function liveRecords(records) {
  return (Array.isArray(records) ? records : []).filter(
    (r) => r && r.kind === 'snake' && r.play === 'live'
      && Array.isArray(r.observed) && r.observed.length > 0,
  );
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample standard deviation (n-1). null below 2 observations. */
function sampleSd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * What this room does relative to consensus ADP, measured from LIVE drafts.
 *
 * For every observed OPPONENT pick, delta = overall pick number - consensus
 * ADP. delta < 0 means the room REACHED (took the player earlier than the
 * market); delta > 0 means he FELL. Aggregated room-wide, per round, and per
 * position.
 *
 * Read the mean honestly: it is taken over players this room actually
 * DRAFTED. Consensus players who went undrafted contribute nothing, so a
 * negative room-wide mean is the signature of a room that reaches outside the
 * consensus board — not a claim about every player.
 *
 * Returns { ready:false, reason } until there is real evidence. It never
 * fabricates a number from sim data:
 *   - no live records            -> reason names the circularity
 *   - fewer than MIN_CALIBRATION_PICKS observed picks -> reason says how many
 *
 * Pure.
 */
export function roomCalibration(records) {
  const live = liveRecords(records);
  const deltas = [];
  const byRoundRaw = new Map();
  const byPosRaw = new Map();
  for (const rec of live) {
    const size = rec.league_size && rec.league_size > 0 ? rec.league_size : null;
    for (const e of rec.observed) {
      if (e.adp == null || e.pick == null) continue; // no consensus -> no delta
      const d = e.pick - e.adp;
      deltas.push(d);
      if (size) {
        const round = Math.floor((e.pick - 1) / size) + 1;
        if (!byRoundRaw.has(round)) byRoundRaw.set(round, []);
        byRoundRaw.get(round).push(d);
      }
      if (e.position) {
        if (!byPosRaw.has(e.position)) byPosRaw.set(e.position, []);
        byPosRaw.get(e.position).push(d);
      }
    }
  }
  const base = {
    ready: false,
    drafts: live.length,
    picks: deltas.length,
    drift: null,
    byRound: [],
    byPosition: {},
    reason: '',
  };
  if (live.length === 0) {
    base.reason = 'No LIVE draft recorded. SIM mocks are not evidence about a '
      + 'room: in a sim the opponents are this app’s own ADP sampler, so '
      + 'measuring them would only measure the model that produced them.';
    return base;
  }
  if (deltas.length < MIN_CALIBRATION_PICKS) {
    base.reason = `Only ${deltas.length} observed opponent picks; `
      + `${MIN_CALIBRATION_PICKS} needed before a drift number means anything.`;
    return base;
  }
  const byRound = [...byRoundRaw.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([round, xs]) => ({
      round,
      n: xs.length,
      meanDelta: r2(mean(xs)),
      sd: r2(sampleSd(xs)),
    }));
  const byPosition = {};
  for (const [pos, xs] of byPosRaw) {
    byPosition[pos] = { n: xs.length, meanDelta: r2(mean(xs)), sd: r2(sampleSd(xs)) };
  }
  return {
    ready: true,
    drafts: live.length,
    picks: deltas.length,
    drift: { mean: r2(mean(deltas)), sd: r2(sampleSd(deltas)) },
    byRound,
    byPosition,
    reason: '',
  };
}

/**
 * THE CONSUMPTION PATH. Where a player with consensus ADP `adp` typically
 * comes off the board in THIS room — the number the reco/finder rows show
 * next to consensus ADP, and the one that makes "he will not last to your next
 * pick here" a measurement instead of a vibe.
 *
 * Position drift is used once that position has MIN_POSITION_PICKS
 * observations; otherwise the room-wide drift stands in. Returns null when the
 * calibration is not ready — the caller must show consensus ADP alone and say
 * so, never a made-up adjustment.
 *
 * A PICK NUMBER. Never points, never a value, never a projection input.
 */
export function expectedGoneBy(adp, position, calibration) {
  const cal = calibration;
  const a = num(adp);
  if (a == null || !cal || !cal.ready) return null;
  const pos = posOf(position);
  const p = cal.byPosition[pos];
  const shift = p && p.n >= MIN_POSITION_PICKS ? p.meanDelta : cal.drift.mean;
  if (shift == null) return null;
  return Math.max(1, Math.round((a + shift) * 10) / 10);
}

/**
 * Per-round comparison of the room's OBSERVED spread against the spread the
 * ADP sim assumes (ADP_NOISE_BASE + ADP_NOISE_PER_ROUND x round, round 0-based
 * in draft-sim). Answers "is my real league tighter or looser than the
 * practice room?" — the practice room's sigma is a documented prior, and this
 * says whether it matches reality. Returns [] when not ready.
 *
 * `ratio` > 1 means the real room is LOOSER (more off-consensus) than the sim.
 */
export function noiseComparison(calibration) {
  const cal = calibration;
  if (!cal || !cal.ready) return [];
  return cal.byRound
    .filter((r) => r.sd != null && r.n >= 2)
    .map((r) => {
      const modelSd = ADP_NOISE_BASE + ADP_NOISE_PER_ROUND * (r.round - 1);
      return {
        round: r.round,
        n: r.n,
        observedSd: r.sd,
        modelSd: r2(modelSd),
        ratio: modelSd > 0 ? r2(r.sd / modelSd) : null,
      };
    });
}

/**
 * The positions this room takes EARLIEST relative to consensus, most extreme
 * first — the beat-the-room line ("TE goes ~6 picks early here, so the last
 * starting TE is gone before your consensus-based turn"). Only positions with
 * MIN_POSITION_PICKS observations appear. [] when not ready.
 */
export function positionDrift(calibration) {
  const cal = calibration;
  if (!cal || !cal.ready) return [];
  return Object.entries(cal.byPosition)
    .filter(([, v]) => v.n >= MIN_POSITION_PICKS)
    .map(([position, v]) => ({
      position,
      n: v.n,
      meanDelta: v.meanDelta,
      // Positive = this room takes the position EARLIER than consensus.
      picksEarly: r2(-v.meanDelta),
    }))
    .sort((a, b) => b.picksEarly - a.picksEarly);
}
