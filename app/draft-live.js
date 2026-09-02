/* app/draft-live.js — R33: the LIVE Sleeper draft companion.
 *
 * WHAT THIS IS. While the owner's REAL draft runs on Sleeper, this module
 * polls Sleeper's public picks endpoint and feeds every pick into the open
 * LIVE draft room — the same room the manager would otherwise feed by hand,
 * through the SAME functions the manual taps call (takeOpponentPickAt /
 * takeMyPick on the snake side, sellTo on the auction side). The companion is
 * a set of hands, not a second brain: it never values a player, never invents
 * a price, and never touches SIM rooms — a sim's opponents are this app's own
 * sampler, and feeding a real transcript into one (or a sim's picks into the
 * learning that only LIVE evidence may reach) would poison the calibration
 * that app/mocks.js protects.
 *
 * WHY THE TIMER LIVES HERE AND NOT IN THE VIEW. app/views/team.js is locked
 * manual-only for the ROSTER sync path (tests/feature/team_roster_sync.test.mjs
 * asserts the view contains no setInterval call at all), and app/sleeper.js is
 * locked the same way for the import path. Both locks exist to keep silent
 * background traffic out of paths the user believes are one-press. The
 * companion is the opposite kind of thing — polling is its entire announced
 * job, armed and disarmed by an explicit tap — so the polling primitive lives
 * in this module, behind an ARM the user pressed, and nowhere else.
 *
 * WHY POLLING SURVIVES REPAINTS. Every draft-room action rebuilds its section
 * with innerHTML (see paintDraft), so nothing here may live in the DOM: the
 * companion's whole state is this module's closure (createCompanion), and the
 * view re-renders FROM it. Teardown is threefold and explicit: the view stops
 * the companion on unmount (the R25 teardown signal), on DISARM, and this
 * module stops itself when the draft record reports complete or the room
 * finishes.
 *
 * HONESTY RULES, restated where they are enforced:
 *   - A pick that cannot be matched is SURFACED, never dropped (pending list).
 *   - A snake pick that cannot be applied PAUSES the feed: applying later
 *     picks past a hole would hand them to the wrong team, because the room
 *     attributes a pick to whoever its clock says is up.
 *   - An auction pick without metadata.amount is surfaced as needing a manual
 *     price. It is never recorded at $1 or at any guessed number: the sale
 *     prices are exactly the evidence the R32 room memory learns from, and a
 *     fabricated price is worse than no record.
 *   - Re-processing the same picks list is a no-op: picks are keyed by
 *     pick_no (high-water mark) and reconciled against board rows the room
 *     has already consumed, so a reload mid-draft or a manual tap made before
 *     arming is never applied twice.
 */

import {
  SLEEPER_API_BASE,
  draftEndpoint,
  crosswalkPlayerIds,
  normalizePlayerName,
} from './sleeper.js';
import { snakeTeam } from './draft-sim.js';

/* --------------------------------------------------------------------------
 * Endpoints + timing
 * ------------------------------------------------------------------------ */

/** GET url for a league's draft list (most recent first). */
export function leagueDraftsEndpoint(leagueId) {
  return `${SLEEPER_API_BASE}/league/${encodeURIComponent(String(leagueId))}/drafts`;
}

/** GET url for the picks made so far in one draft. */
export function picksEndpoint(draftId) {
  return `${SLEEPER_API_BASE}/draft/${encodeURIComponent(String(draftId))}/picks`;
}

/** Poll cadence. 5s is fast enough that a pick appears before the next one is
 * made (real rooms run 30s+ per pick) and slow enough to be a polite consumer
 * of a public, unauthenticated API. */
const POLL_MS = 5000;

/** Re-read the draft RECORD (not the picks) every N polls (~1/min at 5s):
 * `status` lives on the record, and a paused or cancelled draft is something
 * the status line must say instead of "SYNCING" forever. */
const RECORD_RECHECK_EVERY = 12;

/** Abort ceilings. The picks list is small; the player dump is ~5MB. */
const PICKS_TIMEOUT_MS = 10000;
export const INDEX_TIMEOUT_MS = 45000;

/** Sleeper's whole-league player dump — fetched HERE (not by the view: the
 * view is contractually limited to one Sleeper fetch, the roster sync's) and
 * only when the mount has not already cached it from a roster sync. */
export const PLAYER_INDEX_URL = `${SLEEPER_API_BASE}/players/nfl`;

/* --------------------------------------------------------------------------
 * Shared GET — same CORS discipline as app/sleeper.js sleeperGetJson()
 * ------------------------------------------------------------------------ */

/**
 * Minimal JSON GET. Deliberately the same request shape sleeper.js documents
 * (no author headers so the request is never preflighted, credentials
 * omitted so Sleeper's wildcard ACAO stays legal, no-store, one abort timer)
 * — restated here rather than imported because sleeper.js keeps its core
 * private to its own error-wording contract, and this module's callers need
 * machine states, not import-flow prose. Returns { ok, payload, status,
 * error } and never throws. `fetchImpl` is injectable so unit tests and the
 * e2e stub never touch the network.
 */
export async function getJson(url, fetchImpl, timeoutMs) {
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null);
  if (!doFetch) {
    return { ok: false, payload: null, status: 0, error: 'no fetch available' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch (_) { /* already aborted */ }
    }, timeoutMs > 0 ? timeoutMs : PICKS_TIMEOUT_MS);
  }
  try {
    const res = await doFetch(url, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    });
    if (!res || typeof res.status !== 'number') {
      return { ok: false, payload: null, status: 0, error: 'not an HTTP response' };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, payload: null, status: res.status, error: `HTTP ${res.status}` };
    }
    let payload;
    try {
      payload = JSON.parse(await res.text());
    } catch (parseErr) {
      return { ok: false, payload: null, status: res.status, error: 'not JSON' };
    }
    // Sleeper answers 200 + literal null for an unknown resource.
    if (payload === null) {
      return { ok: false, payload: null, status: res.status, error: 'not found' };
    }
    return { ok: true, payload, status: res.status, error: null };
  } catch (err) {
    if (timedOut) {
      return { ok: false, payload: null, status: 0, error: 'timeout' };
    }
    return {
      ok: false,
      payload: null,
      status: 0,
      error: String(err && err.message ? err.message : err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------------
 * Pure core — pick normalization, diffing, slot mapping
 * ------------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * The winning bid on an AUCTION pick, or null when Sleeper reported none.
 * Null is a REPORT the UI must surface, never a $1: the recorded prices are
 * the evidence stream the R32 room memory and the tendency learning read, so
 * a fabricated dollar would teach the opponent model something nobody paid.
 */
function pickAmount(raw) {
  const meta = isPlainObject(raw) ? raw.metadata : null;
  if (!isPlainObject(meta) || meta.amount == null || String(meta.amount).trim() === '') {
    return null;
  }
  const n = toInt(meta.amount);
  return n !== null && n >= 0 ? n : null;
}

/**
 * Sleeper's /picks payload -> validated rows this module works with.
 * A row without a positive integer pick_no or a player_id is reported in
 * `invalid`, never guessed at — pick_no is the idempotency key, so a pick
 * without one cannot be processed exactly-once.
 */
export function normalizePicks(payload) {
  if (!Array.isArray(payload)) {
    return { ok: false, picks: [], invalid: [], error: 'Sleeper\'s picks response was not a list.' };
  }
  const picks = [];
  const invalid = [];
  payload.forEach((raw, i) => {
    if (!isPlainObject(raw)) { invalid.push({ index: i, reason: 'not an object' }); return; }
    const pickNo = toInt(raw.pick_no);
    const playerId = raw.player_id == null ? '' : String(raw.player_id).trim();
    if (pickNo === null || pickNo < 1) { invalid.push({ index: i, reason: 'no pick_no' }); return; }
    if (!playerId) { invalid.push({ index: i, reason: 'no player_id' }); return; }
    const meta = isPlainObject(raw.metadata) ? raw.metadata : {};
    const first = typeof meta.first_name === 'string' ? meta.first_name : '';
    const last = typeof meta.last_name === 'string' ? meta.last_name : '';
    picks.push({
      pick_no: pickNo,
      round: toInt(raw.round),
      player_id: playerId,
      roster_id: toInt(raw.roster_id),
      draft_slot: toInt(raw.draft_slot),
      picked_by: raw.picked_by == null ? null : String(raw.picked_by),
      is_keeper: raw.is_keeper === true,
      amount: pickAmount(raw),
      // The pick carries the player's own name — kept so an UNMATCHED pick can
      // be shown to the user by name even when the cached player dump has
      // never heard of the id (a dump older than a rookie class).
      name: `${first} ${last}`.trim() || null,
      position: typeof meta.position === 'string' ? meta.position : null,
    });
  });
  return { ok: true, picks, invalid, error: null };
}

/**
 * The picks past the high-water mark, sorted ascending and de-duplicated by
 * pick_no. Sorting is what makes an out-of-order payload safe; de-duplication
 * is what makes an overlapping poll safe; the mark itself is what makes a
 * reload mid-draft safe.
 */
export function freshPicks(picks, highWater) {
  const hw = Number.isFinite(highWater) ? highWater : 0;
  const seen = new Set();
  return (Array.isArray(picks) ? picks : [])
    .filter((p) => p && p.pick_no > hw && !seen.has(p.pick_no) && seen.add(p.pick_no))
    .sort((a, b) => a.pick_no - b.pick_no);
}

/**
 * The draft record's two slot maps, inverted for lookup. `slot_to_roster_id`
 * and `draft_order` (user_id -> slot) both live on the draft object; the room
 * numbers its teams by SLOT (team index = slot - 1), so both are turned into
 * something-to-SLOT maps.
 */
export function draftSlotMaps(record) {
  const rec = isPlainObject(record) ? record : {};
  const settings = isPlainObject(rec.settings) ? rec.settings : {};
  const slotByRosterId = new Map();
  if (isPlainObject(rec.slot_to_roster_id)) {
    Object.keys(rec.slot_to_roster_id).forEach((slot) => {
      const s = toInt(slot);
      const rid = toInt(rec.slot_to_roster_id[slot]);
      if (s !== null && rid !== null) slotByRosterId.set(rid, s);
    });
  }
  const slotByUserId = new Map();
  if (isPlainObject(rec.draft_order)) {
    Object.keys(rec.draft_order).forEach((uid) => {
      const s = toInt(rec.draft_order[uid]);
      if (s !== null) slotByUserId.set(String(uid), s);
    });
  }
  return {
    draft_id: rec.draft_id == null ? null : String(rec.draft_id),
    type: typeof rec.type === 'string' ? rec.type : null,
    status: typeof rec.status === 'string' ? rec.status : null,
    teams: toInt(settings.teams),
    rounds: toInt(settings.rounds),
    slotByRosterId,
    slotByUserId,
  };
}

/**
 * The 1-based draft slot a pick belongs to. `draft_slot` is authoritative
 * when present (it IS the column on Sleeper's board); the roster and user
 * maps are fallbacks for a payload that omits it. Null means unknowable —
 * the caller surfaces that, it never guesses.
 */
export function slotOfPick(pick, maps) {
  if (!isPlainObject(pick)) return null;
  if (Number.isFinite(pick.draft_slot) && pick.draft_slot >= 1) return pick.draft_slot;
  const m = maps || {};
  if (Number.isFinite(pick.roster_id) && m.slotByRosterId instanceof Map) {
    const s = m.slotByRosterId.get(pick.roster_id);
    if (s != null) return s;
  }
  if (pick.picked_by && m.slotByUserId instanceof Map) {
    const s = m.slotByUserId.get(String(pick.picked_by));
    if (s != null) return s;
  }
  return null;
}

/**
 * The owner's own draft slot, from what the app already knows: the roster the
 * user picked during roster sync (roster_id and/or owner user_id). Returns a
 * slot or null — the caller OFFERS the detected slot as a one-tap correction
 * and never applies it silently, because a wrong MY SLOT misroutes every "is
 * this pick mine?" decision for the rest of the draft.
 */
export function detectMySlot(record, { rosterId = null, userId = null } = {}) {
  const maps = draftSlotMaps(record);
  const rid = toInt(rosterId);
  if (rid !== null && maps.slotByRosterId.has(rid)) return maps.slotByRosterId.get(rid);
  if (userId != null && maps.slotByUserId.has(String(userId))) {
    return maps.slotByUserId.get(String(userId));
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Arming — when the companion must refuse
 * ------------------------------------------------------------------------ */

/**
 * Why the companion may not arm, as a user-facing sentence — or null when
 * arming is legal. The SIM refusal is the load-bearing one: a sim room's
 * picks are this app's own sampler, and the LIVE rooms' learning (tendencies,
 * ADP drift, the R32 auction memory) is only admissible because everything in
 * a LIVE room is a transcript of a real draft. Auto-feeding a sim would
 * launder simulated picks into that evidence.
 *
 * `record` checks run only when a record is supplied (the view calls this
 * once before any network for the room-mode gate, and again with the fetched
 * record for the shape gates).
 */
export function armRefusal({ room = null, mode = null, leagueId = null, record = null } = {}) {
  if (!room) return 'Open a LIVE draft room first — the companion feeds a room, it cannot run without one.';
  if (room.play !== 'live') {
    return 'This is a SIM room. The companion only feeds LIVE rooms: sim picks are this '
      + 'app\'s own sampler, and auto-feeding them would poison the live-only learning.';
  }
  if (!leagueId) {
    return 'Enter your Sleeper league id or URL in the SLEEPER field above first — the '
      + 'companion reads the same league.';
  }
  if (record) {
    const maps = draftSlotMaps(record);
    if (mode === 'auction' && maps.type !== 'auction') {
      return `Sleeper says this draft is ${maps.type || 'of unknown type'}, but this room is an `
        + 'auction. Start the matching room type before arming.';
    }
    if (mode === 'snake' && maps.type !== 'snake') {
      return `Sleeper says this draft is ${maps.type || 'of unknown type'}, but this room is a `
        + 'snake draft. Start the matching room type before arming.';
    }
    if (Number.isFinite(maps.teams) && Number.isFinite(room.leagueSize)
        && maps.teams !== room.leagueSize) {
      return `Sleeper's draft has ${maps.teams} teams; this room is set to ${room.leagueSize}. `
        + 'Fix TEAMS in the setup and restart the room, or every pick lands on the wrong slot.';
    }
  }
  return null;
}

/**
 * Choose the draft to follow from GET /league/{id}/drafts. Sleeper lists a
 * league's drafts most recent first; the one to follow is the first that is
 * not complete (the upcoming or running one), falling back to the most recent
 * when they all are — a just-finished draft is still worth replaying into the
 * room for the transcript.
 */
export function pickDraftRecord(payload) {
  const list = Array.isArray(payload) ? payload.filter(isPlainObject) : [];
  if (list.length === 0) return null;
  return list.find((d) => d.status !== 'complete') || list[0];
}

/* --------------------------------------------------------------------------
 * Board matching — reuse the crosswalk, resolve to BOARD indices
 * ------------------------------------------------------------------------ */

/**
 * Map Sleeper player ids onto ROOM BOARD indices, via the SAME crosswalk the
 * roster sync uses (espn_id, gsis_id, team-def, then unique name matching —
 * app/sleeper.js crosswalkPlayerIds, not reimplemented here). The board rows
 * themselves are the app-player pool handed to the crosswalk, so a resolved
 * player is by construction ON the board; a miss means the board genuinely
 * does not carry him.
 *
 * Returns Map<sleeperId, { boardIdx|null, code, message }>.
 */
function matchPicksToBoard(sleeperIds, board, index) {
  const rows = Array.isArray(board) ? board : [];
  const byGsis = new Map();
  rows.forEach((row, i) => {
    if (row && row.gsis_id != null && !byGsis.has(String(row.gsis_id))) {
      byGsis.set(String(row.gsis_id), i);
    }
  });
  const ids = [...new Set((Array.isArray(sleeperIds) ? sleeperIds : []).map(String))];
  const out = new Map();
  if (ids.length === 0) return out;
  const cw = crosswalkPlayerIds(ids, rows, { index });
  cw.resolved.forEach((r) => {
    const bi = byGsis.get(String(r.player_id));
    out.set(String(r.sleeper_id), bi === undefined
      ? { boardIdx: null, code: 'no_board_row', message: `${r.name || r.sleeper_id} matched but is not on this board.` }
      : { boardIdx: bi, code: r.method, message: null });
  });
  cw.unresolved.forEach((u) => {
    out.set(String(u.sleeper_id), {
      boardIdx: null,
      code: u.code,
      message: u.message || 'Could not be matched.',
    });
  });
  return out;
}

/**
 * Last-resort board lookup by the NAME the pick itself carries (Sleeper puts
 * first/last name in pick metadata) — for the one-tap "mark taken by name"
 * fallback when the id crosswalk missed (typically a cached player dump older
 * than the player). Unique normalized-name match only; a position, when the
 * pick carries one, must agree. Ambiguity returns null — a fallback that
 * guesses between two players is worse than a manual tap.
 */
export function boardIdxByName(board, name, position) {
  const want = normalizePlayerName(name);
  if (!want) return null;
  const pos = position ? String(position).toUpperCase() : null;
  let hit = null;
  const rows = Array.isArray(board) ? board : [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || normalizePlayerName(row.name) !== want) continue;
    if (pos && row.position && String(row.position).toUpperCase() !== pos
        && !(pos === 'DEF' && String(row.position).toUpperCase() === 'DST')
        && !(pos === 'DST' && String(row.position).toUpperCase() === 'DEF')) continue;
    if (hit !== null) return null; // two candidates — refuse to guess
    hit = i;
  }
  return hit;
}

/* --------------------------------------------------------------------------
 * Planning — picks in, room actions out (pure)
 * ------------------------------------------------------------------------ */

/**
 * Turn fresh picks into the actions the view applies through the EXISTING
 * room functions. Pure: the room is described by plain values and the board
 * match is a prebuilt Map, so node can test every branch without a DOM.
 *
 * ctx:
 *   mode          'snake' | 'auction'
 *   mySlot        the room's 1-based my-slot
 *   leagueSize    teams in the room
 *   roomPick      snake only: picks the room has ALREADY applied (draft.pick)
 *   matchOf       Map<sleeperId, {boardIdx|null, code, message}> (matchPicksToBoard)
 *   slotOf        (pick) -> 1-based slot | null      (slotOfPick + maps, bound)
 *   isTaken       (boardIdx) -> bool                 (room.taken, bound)
 *   canBuy        auction only: (teamIdx0) -> bool   (auction.js canBuy, bound)
 *
 * Actions:
 *   { type:'already',       pick, boardIdx }               — reconciled, skip
 *   { type:'my-pick',       pick, boardIdx }               — takeMyPick
 *   { type:'opponent-pick', pick, boardIdx }               — takeOpponentPickAt
 *   { type:'sale',          pick, boardIdx, buyerIdx, amount } — sellTo
 *   { type:'needs-price',   pick, boardIdx, buyerIdx }     — manual price entry
 *   { type:'needs-buyer',   pick, boardIdx, amount }       — buyer unmappable/full
 *   { type:'unmatched',     pick, code, message }          — crosswalk miss
 *
 * Returns { actions, blocked } — `blocked` is the SNAKE stop reason: a snake
 * pick that cannot be applied halts everything after it, because the room
 * hands each applied pick to the team its clock says is up, and applying pick
 * N+1 while N is missing would credit it to N's team. Auctions have no clock
 * (sellTo names its buyer), so an auction problem is surfaced and skipped
 * over instead.
 */
export function planPickActions(picks, ctx) {
  const c = ctx || {};
  const actions = [];
  let blocked = null;
  // The clock the room WILL show as each planned pick applies, simulated
  // ahead so one poll batch of many picks plans correctly.
  let simPick = Number.isFinite(c.roomPick) ? c.roomPick : 0;

  for (const pick of (Array.isArray(picks) ? picks : [])) {
    const match = c.matchOf instanceof Map ? c.matchOf.get(String(pick.player_id)) : null;
    const bi = match && match.boardIdx != null ? match.boardIdx : null;

    if (bi !== null && typeof c.isTaken === 'function' && c.isTaken(bi)) {
      // Reconciliation: this board row is already consumed — a manual tap made
      // before arming, or a pick applied by an earlier poll. Skipped, and for
      // the snake clock it counts as already-in-room (the manual tap advanced
      // the real clock when it happened).
      actions.push({ type: 'already', pick, boardIdx: bi });
      continue;
    }

    if (c.mode === 'snake') {
      if (bi === null) {
        const a = {
          type: 'unmatched',
          pick,
          code: match ? match.code : 'no_match',
          message: match ? match.message : 'This pick could not be matched to the board.',
        };
        actions.push(a);
        blocked = {
          pick,
          reason: `Sleeper pick #${pick.pick_no} (${pick.name || pick.player_id}) is not `
            + 'matchable on this board, and later picks cannot be applied past it — the room '
            + 'credits each pick to the team on its clock.',
        };
        break;
      }
      const expectSlot = snakeTeam(simPick, c.leagueSize) + 1;
      const slot = c.slotOf ? c.slotOf(pick) : null;
      if (slot !== null && slot !== expectSlot) {
        // The room and Sleeper disagree about whose pick this is. Applying it
        // anyway would file the pick under the wrong team and quietly corrupt
        // the tendency/calibration transcript — pause and say so instead.
        blocked = {
          pick,
          reason: `Sleeper says pick #${pick.pick_no} belongs to slot ${slot}, but this room's `
            + `clock is on slot ${expectSlot}. The room and Sleeper are out of step (check `
            + 'TEAMS and any picks recorded by hand), so the companion paused rather than '
            + 'file picks under the wrong teams.',
        };
        break;
      }
      const effSlot = slot === null ? expectSlot : slot;
      actions.push({
        type: effSlot === c.mySlot ? 'my-pick' : 'opponent-pick',
        pick,
        boardIdx: bi,
      });
      simPick += 1;
      continue;
    }

    // AUCTION — no clock, so every problem is surfaced and stepped over.
    if (bi === null) {
      actions.push({
        type: 'unmatched',
        pick,
        code: match ? match.code : 'no_match',
        message: match ? match.message : 'This pick could not be matched to the board.',
      });
      continue;
    }
    const slot = c.slotOf ? c.slotOf(pick) : null;
    const buyerIdx = slot === null ? null : slot - 1;
    if (buyerIdx === null || buyerIdx < 0 || buyerIdx >= c.leagueSize
        || (typeof c.canBuy === 'function' && !c.canBuy(buyerIdx))) {
      actions.push({ type: 'needs-buyer', pick, boardIdx: bi, amount: pick.amount });
      continue;
    }
    if (pick.amount === null) {
      // NEVER $1, never a guess: the price is the evidence. Surfaced for
      // manual entry through the room's own RECORD SALE flow.
      actions.push({ type: 'needs-price', pick, boardIdx: bi, buyerIdx });
      continue;
    }
    actions.push({ type: 'sale', pick, boardIdx: bi, buyerIdx, amount: pick.amount });
  }

  return { actions, blocked };
}

/* --------------------------------------------------------------------------
 * The controller — timer, fetches, state; the view renders FROM this
 * ------------------------------------------------------------------------ */

/**
 * Create the polling companion for ONE armed session. Everything the status
 * line shows lives on `companion.state`; the view's callbacks do the applying
 * (through the room's own functions) and the repainting.
 *
 * opts:
 *   leagueId       parsed Sleeper league id (string)
 *   getRoom        () -> { mode, room, mySlot, leagueSize, roomPick, board,
 *                          isTaken(bi), canBuy(i), slotHints:{rosterId,userId},
 *                          isDone() } | null when the room is gone
 *   apply          (action) -> { ok, reason } — MUST route through the room's
 *                  existing take/sell functions, learning side effects intact
 *   onChange       (companion, appliedCount) -> void — repaint hook
 *   getIndex       () -> Map|null — the mount's cached Sleeper player index
 *   setIndex       (Map) -> void  — cache a freshly fetched index back
 *   buildIndex     (dump) -> { ok, index } (sleeper.js buildSleeperPlayerIndex)
 *   fetchImpl      injectable fetch implementation, stubbed by tests and e2e
 *   intervalMs     poll cadence (default POLL_MS)
 *   setTimer/clearTimer  injectable interval primitives (tests)
 *   now            injectable clock (tests)
 */
export function createCompanion(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const setTimer = typeof o.setTimer === 'function' ? o.setTimer
    : (fn, ms) => setInterval(fn, ms);
  const clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer
    : (id) => clearInterval(id);

  const state = {
    armed: false,
    status: 'off',       // off|arming|waiting|syncing|retrying|paused|complete
    detail: '',          // one honest sentence behind the status word
    draftId: null,
    record: null,
    maps: null,
    highWater: 0,        // last pick_no fully accounted for
    lastOkAt: 0,         // ms clock of the last successful picks poll
    lastError: null,
    pending: [],         // unmatched / needs-price / needs-buyer, by pick_no
    blocked: null,       // snake stop: { pick, reason }
    detectedSlot: null,  // Sleeper's answer to "which slot is mine", offered not forced
    polls: 0,
    picksSeen: 0,        // length of the last picks payload (status line)
  };

  let timer = null;
  let busy = false;              // a slow poll must not overlap the next tick
  let matchCache = new Map();    // sleeperId -> {boardIdx|null, code, message}
  let matchBoard = null;         // the board the cache was built against

  const emit = (applied) => {
    if (typeof o.onChange === 'function') o.onChange(companion, applied || 0);
  };

  function stopTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  function pushPending(action) {
    if (state.pending.some((p) => p.pick.pick_no === action.pick.pick_no)) return;
    state.pending.push(action);
  }

  /** Match any ids the cache has not seen, against the room's board. */
  function ensureMatches(picks, roomCtx) {
    if (matchBoard !== roomCtx.board) {
      // A new room object means new board indices — the old cache would point
      // into the wrong array.
      matchCache = new Map();
      matchBoard = roomCtx.board;
    }
    const unseen = picks.map((p) => p.player_id).filter((id) => !matchCache.has(String(id)));
    if (unseen.length) {
      const fresh = matchPicksToBoard(unseen, roomCtx.board, o.getIndex ? o.getIndex() : null);
      fresh.forEach((v, k) => matchCache.set(k, v));
    }
    return matchCache;
  }

  async function fetchRecord() {
    const got = await getJson(draftEndpoint(state.draftId), o.fetchImpl, PICKS_TIMEOUT_MS);
    if (got.ok && isPlainObject(got.payload)) {
      state.record = got.payload;
      state.maps = draftSlotMaps(got.payload);
    }
    return got;
  }

  async function tick() {
    if (!state.armed || busy) return;   // `busy`: poll overlap = double-process risk
    busy = true;
    try {
      const roomCtx = typeof o.getRoom === 'function' ? o.getRoom() : null;
      if (!roomCtx) {
        stop('The draft room was closed.');
        return;
      }

      const got = await getJson(picksEndpoint(state.draftId), o.fetchImpl, PICKS_TIMEOUT_MS);
      state.polls += 1;
      if (!got.ok) {
        // Keep polling — the status line says RETRYING and how stale we are,
        // never a silent freeze.
        state.lastError = got.error;
        state.status = 'retrying';
        emit(0);
        return;
      }
      state.lastOkAt = now();
      state.lastError = null;

      const norm = normalizePicks(got.payload);
      const all = norm.ok ? norm.picks : [];
      state.picksSeen = all.length;
      const fresh = freshPicks(all, state.highWater);

      let applied = 0;
      if (fresh.length) {
        const matchOf = ensureMatches(fresh, roomCtx);
        const plan = planPickActions(fresh, {
          mode: roomCtx.mode,
          mySlot: roomCtx.mySlot,
          leagueSize: roomCtx.leagueSize,
          roomPick: roomCtx.roomPick,
          matchOf,
          slotOf: (p) => slotOfPick(p, state.maps),
          isTaken: roomCtx.isTaken,
          canBuy: roomCtx.canBuy,
        });
        state.blocked = plan.blocked;
        for (const action of plan.actions) {
          if (action.type === 'already') {
            state.highWater = Math.max(state.highWater, action.pick.pick_no);
            continue;
          }
          if (action.type === 'unmatched' || action.type === 'needs-price'
              || action.type === 'needs-buyer') {
            pushPending(action);
            if (roomCtx.mode === 'snake') break; // planner blocked; belt + braces
            // Auction: surfaced AND stepped over — the pick_no advances so the
            // pending row is shown once, not re-planned forever.
            state.highWater = Math.max(state.highWater, action.pick.pick_no);
            continue;
          }
          const res = o.apply(action);
          if (!res || !res.ok) {
            state.blocked = {
              pick: action.pick,
              reason: (res && res.reason)
                || `The room refused pick #${action.pick.pick_no} — it is out of step with Sleeper.`,
            };
            break;
          }
          state.highWater = Math.max(state.highWater, action.pick.pick_no);
          applied += 1;
        }
      } else {
        state.blocked = state.blocked || null;
      }

      // Pending rows resolved by hand (the manual flow consumed their board
      // row) disappear on their own — nothing nags about a solved problem.
      state.pending = state.pending.filter(
        (p) => !(p.boardIdx != null && roomCtx.isTaken(p.boardIdx)),
      );

      // Status, most specific first.
      if (state.blocked) {
        state.status = 'paused';
        state.detail = state.blocked.reason;
      } else if (all.length === 0 && state.maps && state.maps.status === 'pre_draft') {
        state.status = 'waiting';
        state.detail = 'Sleeper has not started this draft yet — the companion will pick up '
          + 'the first pick the moment it lands.';
      } else {
        state.status = 'syncing';
        state.detail = '';
      }

      // Stop conditions: the room says done, or the record says complete and
      // everything Sleeper has is accounted for.
      const doneRoom = typeof roomCtx.isDone === 'function' && roomCtx.isDone();
      let doneRecord = false;
      if (!doneRoom && fresh.length === 0
          && (state.polls % RECORD_RECHECK_EVERY === 0
            || (state.maps && Number.isFinite(state.maps.teams) && Number.isFinite(state.maps.rounds)
              && all.length >= state.maps.teams * state.maps.rounds))) {
        await fetchRecord();
        doneRecord = state.maps && state.maps.status === 'complete'
          && state.highWater >= all.length && !state.blocked && state.pending.length === 0;
      }
      if (doneRoom || doneRecord) {
        state.status = 'complete';
        state.detail = doneRoom
          ? 'The room is full — every seat is drafted.'
          : 'Sleeper reports this draft complete, and every pick is accounted for.';
        state.armed = false;
        stopTimer();
      }
      emit(applied);
    } finally {
      busy = false;
    }
  }

  async function arm() {
    if (state.armed) return;
    state.status = 'arming';
    state.detail = '';
    emit(0);

    const roomCtx = typeof o.getRoom === 'function' ? o.getRoom() : null;
    let refusal = armRefusal({
      room: roomCtx ? { play: 'live', leagueSize: roomCtx.leagueSize } : null,
      mode: roomCtx ? roomCtx.mode : null,
      leagueId: o.leagueId,
    });
    if (refusal) { fail(refusal); return; }

    // 1. Which draft? The league's draft list, most recent first.
    const drafts = await getJson(leagueDraftsEndpoint(o.leagueId), o.fetchImpl, PICKS_TIMEOUT_MS);
    if (!drafts.ok) {
      fail(`Could not read this league's drafts from Sleeper (${drafts.error}). Check the `
        + 'league id and try ARM again.');
      return;
    }
    const record = pickDraftRecord(drafts.payload);
    if (!record) {
      fail('Sleeper lists no draft for this league yet.');
      return;
    }
    state.draftId = record.draft_id == null ? null : String(record.draft_id);
    state.record = record;
    state.maps = draftSlotMaps(record);
    if (!state.draftId) {
      fail('Sleeper\'s draft record carries no draft id — nothing can be polled.');
      return;
    }

    // 2. Does the draft fit the open room?
    refusal = armRefusal({
      room: { play: 'live', leagueSize: roomCtx.leagueSize },
      mode: roomCtx.mode,
      leagueId: o.leagueId,
      record,
    });
    if (refusal) { fail(refusal); return; }

    // 3. The player index — reuse the mount's cache (a roster sync already
    // paid for the ~5MB download), fetch it here only when absent.
    if (!(o.getIndex && o.getIndex())) {
      const dump = await getJson(PLAYER_INDEX_URL, o.fetchImpl, INDEX_TIMEOUT_MS);
      const built = dump.ok && typeof o.buildIndex === 'function' ? o.buildIndex(dump.payload) : null;
      if (!built || !built.ok) {
        fail('Sleeper\'s player list could not be read, and without it picks are opaque ids. '
          + `(${dump.ok ? 'unrecognised shape' : dump.error}) Try ARM again.`);
        return;
      }
      if (typeof o.setIndex === 'function') o.setIndex(built.index);
    }

    // 4. My slot, detected from what the app already knows — OFFERED, never
    // silently applied (the view renders the one-tap correction).
    state.detectedSlot = detectMySlot(record, roomCtx.slotHints || {});

    state.armed = true;
    state.status = state.maps.status === 'pre_draft' ? 'waiting' : 'syncing';
    timer = setTimer(() => { tick(); }, Number.isFinite(o.intervalMs) ? o.intervalMs : POLL_MS);
    emit(0);
    await tick(); // first poll immediately — five seconds matter on draft day
  }

  function fail(message) {
    state.armed = false;
    state.status = 'off';
    state.detail = message;
    stopTimer();
    emit(0);
  }

  function stop(reason) {
    stopTimer();
    state.armed = false;
    if (state.status !== 'complete') {
      state.status = 'off';
      state.detail = reason || '';
    }
    emit(0);
  }

  /**
   * The view resolved a surfaced pick by hand (name-fallback tap, manual sale)
   * — account for it so the feed moves on instead of re-surfacing it.
   */
  function acknowledge(pickNo) {
    const n = toInt(pickNo);
    if (n === null) return;
    state.highWater = Math.max(state.highWater, n);
    state.pending = state.pending.filter((p) => p.pick.pick_no !== n);
    if (state.blocked && state.blocked.pick.pick_no === n) state.blocked = null;
  }

  const companion = { state, arm, stop, tick, acknowledge };
  return companion;
}

/**
 * The status line, as one honest string. Kept here (pure, testable) because
 * it IS the companion's honesty surface: the view prints it verbatim.
 */
export function statusLine(state, nowMs) {
  const s = state || {};
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ago = s.lastOkAt ? `${Math.max(0, Math.round((t - s.lastOkAt) / 1000))}s ago` : 'never';
  switch (s.status) {
    case 'arming': return 'ARMING — reading the draft from Sleeper…';
    case 'waiting': return `ARMED — Sleeper draft not started · checked ${ago}`;
    case 'syncing': return `SYNCING · pick ${s.highWater || 0} · ${ago}`;
    case 'retrying': return `RETRYING — last sync ${ago}`;
    case 'paused': return `PAUSED at Sleeper pick #${s.blocked ? s.blocked.pick.pick_no : '?'} · last sync ${ago}`;
    case 'complete': return 'DRAFT COMPLETE — companion stopped.';
    default: return s.detail || 'OFF — picks are recorded by hand until you ARM.';
  }
}
