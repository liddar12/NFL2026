/* app/views/team.js — the TEAM builder view (#/team).
 *
 * Orchestrates the fit engine (app/team-logic.js — pure, node-tested) against
 * the projection + weekly contracts and paints four sections:
 *   .roster        15 slots (QB1..FLEX, K1, DEF1 starters, BN1..BN6 bench) — tap an empty
 *                  slot to target recommendations, tap a filled one to remove
 *   .finder        substring search (name/team/pos) over the player pool; ADD
 *                  fills the first eligible open slot (FLEX RB/WR/TE, bench any)
 *   .reco          top-5 fit-engine picks for the selected (or neediest) open
 *                  slot, each with plain-language .reco-why reason lines
 *   .team-summary  starters season total, 18-cell .team-weeks grid (worst week
 *                  flagged .tw-cell--floor), .bye-warn chips for stacked byes
 *
 * State: roster persists in localStorage nfl2026.team.v1 ({slots:{...:id|null}});
 * scoring mode is READ from nfl2026.scoring.v1 (the Players header owns the
 * toggle — one setting, two views). All numbers are ESTIMATES and labeled so.
 *
 * Fit Engine v2 (AI+): a .aiseg BASE/AI+ toggle (persisted nfl2026.ai.v1,
 * default OFF) re-ranks the .reco panel via fitScoreV2 with data/ai_insights.json
 * as ctx. AI-ESTIMATED reason lines get an inline .prov-ai "AI EST" chip;
 * measured ones cite their span in the text. If ai_insights.json is absent
 * (404, older deploy) the toggle is hidden and the view is byte-for-byte the
 * v1 experience.
 *
 * Degrades honestly: player_weekly.json failing to load -> a .state
 * message, never a blank screen. Render helpers live LOCALLY (render.js is
 * untouched — this view owns its own markup).
 */

import {
  scoringAdjust,
  weeklyPoints,
  byeWeek,
  teamWeeklyTotals,
  neediestOpenSlot,
  recommend,
  recommendV2,
  strengthOfSchedule,
  trendLabel,
  positionAtCap,
  POSITION_CAPS,
  bestPickNow,
  withLeagueExtras,
  extraPtsOf,
} from '../team-logic.js';
import {
  getPlayerProjections, getPlayerWeekly, getGamePredictions, getAiInsights,
  getPlayerHistory, getTeamStrength, getAdp,
} from '../data.js';
import {
  getKdstProjections, shapeKdst, canonKdstPosition, isKdstPosition,
} from '../kdst.js';
import {
  rosterShape, createDraft, onTheClock, takeOpponentPick, takeMyPick,
  takeOpponentPickAt, undoLastPick, picksUntilMyNext, survivalProbabilities,
  scoreVsRoom, startersTotal, ROSTER_BOUNDS, DEFAULT_ROSTER, ROOM_TYPES, ROOM_LABELS,
} from '../draft-sim.js';
import {
  MIN_CALIBRATION_PICKS, MOCKS_KEY, MOCKS_KEY_V1, appendMock, clearHistory,
  expectedGoneBy, historySummary, loadHistory, migrateLegacy, noiseComparison,
  positionDrift, recordAuction, recordDraft, roomCalibration,
} from '../mocks.js';
import {
  BUDGET_CHOICES, DEFAULT_BUDGET, createAuction, myTeam as aucMyTeam,
  onTheNomination, autoNominate, nominate, resolveBids, sellTo, undoLastSale,
  liveInflation, myGuidance, nominationAdvice, planBudget, scoreAuction,
  maxBid, MIN_BID, classifyNomination, fairDollars, buyerOptions,
  normalizeTeamBudgets, totalRoomMoney,
} from '../auction.js';
import { TEAMS } from '../teams.js';
import { recordSync, scoringDiff, shapeDiff, SYNC_LOG_KEY } from '../synclog.js';
import {
  FLEX_ELIGIBILITY, FLEX_TOKENS, LEAGUE_BOUNDS, LEAGUE_KEY, LEAGUE_STASH_KEY,
  clearProfile, cloneProfile, isDefaultProfile, loadProfile, loadStashedProfile,
  normalizeProfile, saveProfile, stashProfile,
  scoringMode, validateProfile, rosterSlots, slotAccepts, firstOpenSlot,
  rosterPositionsInPlay, slotEligiblePositions, saveLeagueId, loadLeagueId, LEAGUE_ID_KEY,
} from '../league.js';
import {
  SLEEPER_API_BASE, PLAYER_INDEX_URL, buildSleeperPlayerIndex, crosswalkRoster,
  importFromPastedJson, importFromSleeper, importSleeperTeams, loadSleeperPlayerIndex,
  parseLeagueId, summarizeImport, unresolvedItems, fetchSleeperState,
} from '../sleeper.js';
// R49 — every roster in the league (in this app's ids) and Sleeper's current
// NFL week, remembered for LINEUP's WAIVER WIRE. Written here, read there.
import {
  LEAGUE_ROSTERS_KEY, NFL_WEEK_KEY, saveLeagueRosters, setMyRosterId, saveNflWeek,
} from '../league-rosters.js';
// R33 — the LIVE Sleeper draft companion. The module owns the polling, the
// pick diffing and every honesty rule; this view only renders FROM its state
// and routes its planned actions through the SAME take/sell functions a
// manual tap uses, so the learning side effects are byte-identical.
import { createCompanion, statusLine as companionStatus } from '../draft-live.js';

const TEAM_KEY = 'nfl2026.team.v1';
const SCORING_KEY = 'nfl2026.scoring.v1';
const AI_KEY = 'nfl2026.ai.v1'; // Fit Engine AI+ toggle — default OFF (base v1)
const TAKEN_KEY = 'nfl2026.taken.v1'; // draft board: ids taken by other managers

/* R27 — bounds for a TYPED auction budget. The old select offered $100/$200/
 * $300 and nothing else; these are the limits of what the pricing engine can
 * sensibly spread over a board, not a list of blessed values. $1 per roster
 * slot is the floor below which every player is a $1 player and the auction
 * has no decisions in it; the ceiling is generous enough for any real league
 * and exists only to stop a typo (a stray zero) rescaling the whole board. */
const BUDGET_BOUNDS = Object.freeze([10, 10000]);
/* MOUNT TEARDOWN (R25). This view delegates ten listeners onto #view — the ONE
 * permanent element app/main.js hands every route — and #view is never replaced
 * between navigations. Without a teardown every superseded mount's handlers stay
 * live on it forever: they keep firing on clicks meant for the CURRENT mount,
 * each one repainting from its own dead closure, and each one pins that whole
 * mount's derived state (playersById, scaledById, weeklyById, the memo caches)
 * in memory. Measured: +10 live listeners and +0.15 MiB per Team visit, and a
 * finder sort repaint growing LINEARLY at ~5.4 ms per prior mount (5.3 ms at one
 * mount, 71.7 ms at twelve). The mount's AbortController is parked here on the
 * element so the NEXT mount — including the scoring re-price re-mount this view
 * triggers on itself — can abort it before wiring its own. */
const TEARDOWN_KEY = '__nfl2026TeamTeardown';
// Draft/auction history lives in app/mocks.js (MOCKS_KEY there, plus the
// read-only migration off the superseded key). This view never touches either
// key inline: a record is written through appendMock() and read back through
// loadHistory(), so there is exactly one definition of what a record IS.
/* R34 — per-team STARTING BUDGETS + NAMES persist here. Before R34 the budgets
 * were pure session state (draftCfg.teamBudgets, rebuilt null on every mount),
 * so "the room the owner set up" evaporated on any reload — and RESTART
 * SESSION's contract (keep budgets and names) is only meaningful if they
 * survive one. Shape: { version: 1, budgets: number[]|null, names: string[]|null },
 * both seat-indexed (0-based, seat i = team i+1). `null` budgets = "every team
 * holds the league default" — the same not-stated meaning draftCfg.teamBudgets
 * has always had. A names entry of '' means NOT TYPED (the display falls
 * through to the Sleeper name, then T{n}); absent is not zero and blank is not
 * a name. normalizeAuctionTeams() also accepts a bare array as budgets-only,
 * so an unwrapped legacy write degrades to a working record, never a wipe. */
const AUCTION_TEAMS_KEY = 'nfl2026.auctionteams.v1';
export const AUCTION_TEAMS_VERSION = 1;
/** Typed team names are capped so one name cannot wreck the ROOM ledger. */
export const TEAM_NAME_MAX = 24;

/* R48 — WHICH SLEEPER ROSTER IS MINE. There is no login, so the only way the
 * app can know which of a league's rosters to seat is to be told once. The
 * answer is remembered per league id ({ [league_id]: roster_id }) so the next
 * SYNC NOW is one press with no picker. RESET ALL clears it. */
export const MY_ROSTER_KEY = 'nfl2026.myroster.v1';
function myRosterStorage(storage) {
  if (storage !== undefined) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (err) { return null; }
}
export function loadMyRosterMap(storage) {
  const store = myRosterStorage(storage);
  try {
    const raw = store && store.getItem(MY_ROSTER_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (err) { return {}; }
}
export function rememberedRosterId(leagueId, storage) {
  const v = loadMyRosterMap(storage)[String(leagueId || '')];
  return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
}
export function saveMyRoster(leagueId, rosterId, storage) {
  const store = myRosterStorage(storage);
  const key = String(leagueId || '');
  if (!store || !key) return false;
  const map = loadMyRosterMap(store);
  if (rosterId == null) delete map[key]; else map[key] = Number(rosterId);
  try { store.setItem(MY_ROSTER_KEY, JSON.stringify(map)); return true; } catch (err) { return false; }
}

/* R52 — MOUNT SEQUENCE. Every mountTeam() call takes the next number; the
 * mount captures its own and, at every await boundary that writes DOM, bails
 * when a newer mount has taken the element (or the element left the page).
 * The R48 hand-off flag that carried SYNC NOW's roster step across a remount
 * is gone with the remount: SYNC NOW now recomputes the profile-derived state
 * in place and continues into the roster read in the SAME mount, so no two
 * mounts of one element can race for the flag or paint over each other. */
let mountSeq = 0;

/* R34 — RESET ALL's explicit key list: every localStorage key this app writes,
 * ENUMERATED (grep `nfl2026.` under app/), never a prefix wildcard over
 * localStorage — other sites' keys on this origin-adjacent storage must be
 * untouched. Keys defined by other modules are imported, not respelled, so a
 * rename there cannot silently orphan a key here.
 *
 * DELIBERATELY EXCLUDED: nfl2026.unlock.v1 (app/gate.js). That key is ACCESS,
 * not data — the owner's wipe list names league sync, budgets, names, history
 * and room memory, and re-locking the device the owner is actively holding is
 * not a reset they asked for. nfl2026.theme.v1 IS cleared: moot since R34 made
 * HIG the only theme (nothing reads it), but harmless and it is our key. */
export const RESET_ALL_KEYS = Object.freeze([
  TEAM_KEY,          // roster slots
  SCORING_KEY,       // scoring mode
  AI_KEY,            // AI+ toggle
  TAKEN_KEY,         // the TAKEN board
  LEAGUE_KEY,        // the APPLIED league profile
  LEAGUE_STASH_KEY,  // the saved-not-applied league (RESTART's shelf)
  LEAGUE_ID_KEY,     // R47 — the remembered Sleeper league id
  MY_ROSTER_KEY,     // R48 — which Sleeper roster is mine, per league
  SYNC_LOG_KEY,      // R48 — the LEAGUE tab's sync log
  LEAGUE_ROSTERS_KEY, // R49 — every league roster in app ids (LINEUP's waiver wire)
  NFL_WEEK_KEY,      // R49 — Sleeper's current NFL week (LINEUP's default WK)
  AUCTION_TEAMS_KEY, // per-team budgets + names
  MOCKS_KEY,         // draft history + auction room memory (v2)
  MOCKS_KEY_V1,      // the legacy history key the migration reads
  'nfl2026.theme.v1', // the retired R31 theme choice
]);

/** The ambient localStorage, or null when unavailable/blocked. Same defensive
 * idiom as app/league.js / app/mocks.js, local because this view is the one
 * module that historically reached localStorage directly. */
function ambientStorage() {
  try {
    const g = typeof globalThis === 'undefined' ? null : globalThis;
    return g && g.localStorage ? g.localStorage : null;
  } catch (err) {
    return null;
  }
}

/** RESET ALL's storage half: remove exactly RESET_ALL_KEYS, one by one, each
 * in its own try (one blocked key must not shield the rest). Pure over an
 * injected storage; returns false if any removal failed. */
export function wipeAllAppStorage(storage) {
  const store = storage === undefined ? ambientStorage() : storage;
  let ok = true;
  for (const key of RESET_ALL_KEYS) {
    try { store.removeItem(key); } catch (err) { ok = false; }
  }
  return ok;
}

/** Normalise anything into the auction-teams record. Total, never throws. */
export function normalizeAuctionTeams(raw) {
  const out = { version: AUCTION_TEAMS_VERSION, budgets: null, names: null };
  // Legacy/defensive: a bare array is budgets-only (the pre-versioned shape a
  // caller would most plausibly have written).
  const src = Array.isArray(raw) ? { budgets: raw } : raw;
  if (!src || typeof src !== 'object') return out;
  if (Array.isArray(src.budgets) && src.budgets.length > 0) {
    // Entries pass through loosely here; app/auction.js normalizeTeamBudgets
    // applies the money rules (blank = league default, never $0) at use, and
    // both ends must agree that "not stated" survives the round trip as null.
    out.budgets = src.budgets.map((b) => (b === null || b === undefined || b === ''
      ? null
      : (Number.isFinite(Number(b)) ? Math.round(Number(b)) : null)));
  }
  if (Array.isArray(src.names) && src.names.length > 0) {
    out.names = src.names.map((n) => (typeof n === 'string'
      ? n.trim().slice(0, TEAM_NAME_MAX)
      : ''));
    if (out.names.every((n) => n === '')) out.names = null; // all blank = none typed
  }
  return out;
}

/** Read the persisted budgets+names record (normalised). Never throws. */
export function loadAuctionTeams(storage) {
  const store = storage === undefined ? ambientStorage() : storage;
  let raw = null;
  try {
    raw = JSON.parse((store && store.getItem(AUCTION_TEAMS_KEY)) || 'null');
  } catch (err) {
    raw = null;
  }
  return normalizeAuctionTeams(raw);
}

/** Persist budgets+names (normalised first). Returns true on write. */
export function saveAuctionTeams(record, storage) {
  const store = storage === undefined ? ambientStorage() : storage;
  try {
    store.setItem(AUCTION_TEAMS_KEY, JSON.stringify(normalizeAuctionTeams(record)));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * R34 — what seat i (0-based) is CALLED, with the prefill precedence the owner
 * specified: (1) a name the owner typed (persisted), (2) the synced Sleeper
 * league's team name (team_name, else display_name — the fields
 * importSleeperTeams' joined teams carry) when the sync has them, (3) the
 * default T{n}. Returns { name, source: 'typed'|'sleeper'|'default' }.
 *
 * DISPLAY ONLY, and index-keyed ONLY: the auction engine never sees a name,
 * and no caller may look a seat up BY name — duplicate names are legal and
 * must keep working. Sleeper names map seat i -> the i-th synced roster
 * (roster_id order) and are used only when the synced league has exactly
 * leagueSize teams; mapping a 10-team sync onto a 12-team room would name
 * seats that do not correspond to anything.
 */
export function auctionTeamName(i, { typedNames = null, sleeperTeams = null,
                                     leagueSize = 0 } = {}) {
  const typed = Array.isArray(typedNames) && typeof typedNames[i] === 'string'
    ? typedNames[i].trim()
    : '';
  if (typed) return { name: typed.slice(0, TEAM_NAME_MAX), source: 'typed' };
  if (Array.isArray(sleeperTeams) && sleeperTeams.length === leagueSize) {
    const t = sleeperTeams[i];
    const s = t && (t.team_name || t.display_name);
    if (typeof s === 'string' && s.trim()) {
      return { name: s.trim().slice(0, TEAM_NAME_MAX), source: 'sleeper' };
    }
  }
  return { name: `T${i + 1}`, source: 'default' };
}

/**
 * R34 — the LIVE sale capture's validation, factored pure so the contract is
 * node-testable: recording a sale requires a SELECTED buyer AND a TYPED price
 * (owner's words: "when you press take, you have to type in the auction value
 * spent and select the team name it went to"). A blank price is refused —
 * never recorded as $0 and never silently replaced by our estimate, because
 * the estimate is our opinion and the log is a transcript of the room.
 * Returns { ok:true, teamIdx, price } or { ok:false, reason }.
 */
export function validateSoldEntry({ buyerValue, priceValue } = {}) {
  const buyerRaw = buyerValue == null ? '' : String(buyerValue).trim();
  const teamIdx = buyerRaw === '' ? NaN : Number(buyerRaw);
  if (!Number.isInteger(teamIdx) || teamIdx < 0) {
    return { ok: false, reason: 'Pick the team that bought this player first — a sale without a buyer cannot be recorded.' };
  }
  const priceRaw = priceValue == null ? '' : String(priceValue).trim();
  const price = priceRaw === '' ? NaN : Math.round(Number(priceRaw));
  if (!Number.isFinite(price) || price < 0) {
    return { ok: false, reason: 'Type the price the room actually paid. A blank price is not $0, and the estimate is a hint, not a recordable fact.' };
  }
  return { ok: true, teamIdx, price };
}

/**
 * R34 — RESTART SESSION's storage half, factored pure (injected storage) so
 * the keep/clear contract is node-testable. It:
 *   - STASHES the applied league profile (saved-not-applied — the RE-APPLY
 *     shelf) when one is applied, so the synced import survives WITHOUT a
 *     re-download. An already-default profile stashes nothing, and an
 *     existing stash is not overwritten with the default.
 *   - CLEARS the applied profile (LEAGUE_KEY) — this is the fix for "reset
 *     didn't clear the Omilia-US scoring": the imported league's scoring,
 *     rules and shape stop applying because the profile reverts to default.
 *   - REVERTS scoring to standard PPR (SCORING_KEY).
 *   - CLEARS the roster (TEAM_KEY) and the TAKEN board (TAKEN_KEY).
 * It does NOT touch: the stash it just wrote, draft history / auction room
 * memory (MOCKS_KEY, MOCKS_KEY_V1), or per-team budgets + names
 * (AUCTION_TEAMS_KEY) — the owner's KEEP list. Returns { stashed }.
 */
export function restartSessionStorage(storage) {
  const store = storage === undefined ? ambientStorage() : storage;
  // R47 (owner's pick: "RESTART SESSION keeps the league"): the applied
  // profile and the remembered league id are NOT touched — only the board,
  // the roster and the TAKEN list reset. Scoring stays locked to the league
  // (team-logic loadScoringMode is league-aware), so the toggle key reverting
  // to 'ppr' here only matters once RESET ALL has cleared the profile.
  const applied = loadProfile(store);
  const kept = !isDefaultProfile(applied);
  try { store.setItem(SCORING_KEY, kept ? scoringMode(applied) : 'ppr'); } catch (err) { /* session-only */ }
  for (const key of [TEAM_KEY, TAKEN_KEY]) {
    try { store.removeItem(key); } catch (err) { /* session-only */ }
  }
  return { stashed: false, kept };
}

const FINDER_CAP = 25; // candidate rows rendered before the "refine search" hint
// LIVE draft tap list: rows rendered at once (the list scrolls). Not a reach
// limit — the filter beside it spans the whole board, so any untaken player is
// tappable; this only bounds how much DOM one paint builds.
const LIVE_TAKE_CAP = 60;

/* ---- local render helpers (this view's markup is its own) ----------------- */

/** HTML-escape untrusted-ish text before interpolating into a template. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One-decimal fixed number (points everywhere in this view). */
const fix1 = (n) => Number(n).toFixed(1);

/** AA-safe identity tint for a team abbrev (falls back to --ink). */
const tint = (ab) => (TEAMS[ab] && TEAMS[ab].tint) || 'var(--ink)';

/** Index of the minimum value (first hit — deterministic worst week). */
function argmin(arr) {
  let idx = 0;
  for (let i = 1; i < arr.length; i += 1) if (arr[i] < arr[idx]) idx = i;
  return idx;
}

/** Paint a plain .state message (empty / error / missing-feed). */
function stateMsg(el, text) {
  el.innerHTML = `<div class="state">${text}</div>`;
}

/* ---- persistence ----------------------------------------------------------- */

/** Read the shared scoring mode; unknown/unreadable values fall to ppr. */
function loadScoring() {
  try {
    const v = localStorage.getItem(SCORING_KEY);
    return v === 'half' || v === 'std' ? v : 'ppr';
  } catch (err) {
    return 'ppr'; // storage blocked (private mode) — session default
  }
}

/**
 * Sanitize a stored roster against the current pool: every slot key present,
 * ids must exist in `validIds` (dropped players vanish honestly), duplicates
 * keep only their first slot. Corrupt/absent storage -> an all-empty roster.
 *
 * `retainSlots` (R30b) names the slots where an UNRESOLVABLE id is KEPT
 * instead of dropped. An id can be unresolvable for two different reasons and
 * they must not share a fate: a player who left the pool is gone and should
 * vanish, but a saved K or D/ST whose id only the kdst contract could resolve
 * is merely UNREADABLE while that feed is down. Dropping it here was the wipe:
 * the very next saveRoster() — any ADD, REMOVE or live-room sync — wrote the
 * emptied slot back to nfl2026.team.v1 and the player was gone even after the
 * feed came back. A retained id stays in its own slot only; the painters
 * render it as a degraded seat, and only the user removes it.
 *
 * Pure and exported so the retention rule is node-testable without a DOM or
 * localStorage.
 */
export function sanitizeRosterSlots(stored, order, validIds, retainSlots = null) {
  const slots = Object.fromEntries(order.map((s) => [s, null]));
  const retain = retainSlots || new Set();
  const seen = new Set();
  if (stored && stored.slots && typeof stored.slots === 'object') {
    order.forEach((s) => {
      const id = stored.slots[s] == null ? null : String(stored.slots[s]);
      if (!id || seen.has(id)) return;
      if (validIds.has(id) || retain.has(s)) {
        slots[s] = id;
        seen.add(id);
      }
    });
    // Migration sweep: an id parked under a slot id this profile no longer has
    // (a legacy roster, or a shape the user just changed) moves into the first
    // slot that will take it. A saved player is never dropped merely because the
    // geometry moved under him. Only RESOLVABLE ids move — retention is
    // per-slot, so an unreadable id under a dead slot has no seat to keep.
    Object.keys(stored.slots).forEach((s) => {
      if (order.includes(s)) return;
      const id = stored.slots[s] == null ? null : String(stored.slots[s]);
      if (!id || !validIds.has(id) || seen.has(id)) return;
      const target = order.find((slot) => !slots[slot]);
      if (target) {
        slots[target] = id;
        seen.add(id);
      }
    });
  }
  return { slots };
}

/** Load the roster from storage, sanitized (see sanitizeRosterSlots). */
function loadRoster(validIds, profile, retainSlots = null) {
  // ONE slot vocabulary, derived from the profile. The saved roster, the grid
  // the user taps, the engines and the Lineup page must all name slots the same
  // way. If Team writes the frozen legacy ids while Lineup reads profile-derived
  // ids, every rostered player silently disappears from the optimizer the moment
  // a league's geometry differs from the old 13-slot default.
  const order = rosterSlots(profile).all;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
  } catch (err) {
    stored = null;
  }
  return sanitizeRosterSlots(stored, order, validIds, retainSlots);
}

/** Persist the roster; storage failures are non-fatal (session still works). */
function saveRoster(roster) {
  try {
    localStorage.setItem(TEAM_KEY, JSON.stringify(roster));
  } catch (err) {
    /* storage blocked — in-memory roster still drives the render */
  }
}

/** Read the AI+ preference. Anything but the literal 'on' is OFF — the base
 * deterministic fit engine is the default experience (contract: default off). */
function loadAiPref() {
  try {
    return localStorage.getItem(AI_KEY) === 'on';
  } catch (err) {
    return false; // storage blocked (private mode) — session default: off
  }
}

/** Persist the AI+ preference; failures are non-fatal (session toggle works). */
function saveAiPref(on) {
  try {
    localStorage.setItem(AI_KEY, on ? 'on' : 'off');
  } catch (err) {
    /* storage blocked — in-memory flag still drives the render */
  }
}

/** Load the DRAFT BOARD taken-set (ids other managers have drafted). Corrupt or
 * absent storage -> empty set. Only ids still in the pool matter (stale ids are
 * harmless — they just never match a candidate). */
function loadTaken() {
  try {
    const arr = JSON.parse(localStorage.getItem(TAKEN_KEY) || '[]');
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (err) {
    return new Set();
  }
}

/** Persist the taken-set; failures are non-fatal (in-memory set still drives). */
function saveTaken(taken) {
  try {
    localStorage.setItem(TAKEN_KEY, JSON.stringify([...taken]));
  } catch (err) {
    /* storage blocked — in-memory set still drives the render */
  }
}

/** A compact glossary so no acronym or arrow is ever unexplained. Static markup,
 * placed once under the header on the TEAM tab. */
function renderLegend() {
  return (
    '<details class="legend legend--team">' +
      '<summary>WHAT DO THESE MEAN?</summary>' +
      '<div class="legend-body">' +
        '<span class="legend-item"><b>PROJ</b> projected season points (your scoring mode)</span>' +
        '<span class="legend-item"><b>TREND</b> 5-yr trajectory — <span class="cd-trend--up">▲</span> improving, <span class="cd-trend--down">▼</span> declining</span>' +
        '<span class="legend-item"><b>SoS</b> strength of schedule, 1.0 easiest to 5.0 hardest</span>' +
        '<span class="legend-item"><b>BYE</b> the week this player has no game (scores 0)</span>' +
        '<span class="legend-item"><b>AI+</b> AI re-rank by trajectory/cold/stack (bounded ±25%, labeled ESTIMATE)</span>' +
        '<span class="legend-item"><b>TAKEN</b> mark a player drafted by someone else — the fit engine drops them instantly</span>' +
        '<span class="legend-item"><b>▼ / ▲</b> sort direction: ▼ descending (high→low), ▲ ascending (low→high)</span>' +
      '</div>' +
    '</details>'
  );
}

/** The BASE / AI+ segmented toggle (.aiseg — same pill pattern as .scoreseg).
 * Only rendered when data/ai_insights.json loaded; a 404 hides it entirely. */
function renderAiSeg(on) {
  const btn = (label, active, val) => (
    `<button type="button" data-ai="${val}"` +
      `${active ? ' class="aiseg--active"' : ''} aria-pressed="${active ? 'true' : 'false'}">` +
      `${label}</button>`
  );
  return (
    '<div class="aiseg" role="group" aria-label="Fit engine mode">' +
      `${btn('BASE', !on, 'off')}${btn('AI+', on, 'on')}` +
    '</div>'
  );
}

/* ---- REL2 control rows (finder + reco) ------------------------------------ */

const FINDER_POS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const FINDER_SORTS = [
  { key: 'pts', label: 'PTS' },
  { key: 'trend', label: 'TREND' },
  { key: 'bye', label: 'BYE' },
];

/**
 * Finder position filter chips.
 *
 * `extra` appends the K/DEF (or DST) chips for a league that actually fields
 * those slots — the only way to browse a pool that is deliberately kept out of
 * the unfiltered best-available list. A league without those slots passes
 * nothing and gets the historical five chips, byte for byte.
 */
function finderPosRow(active, extra) {
  const list = [...FINDER_POS, ...(Array.isArray(extra) ? extra : [])];
  const chips = list.map((pos) => (
    `<button type="button" class="pf-chip${pos === active ? ' pf-chip--active' : ''}" ` +
      `data-fpos="${pos}" aria-pressed="${pos === active ? 'true' : 'false'}">${pos}</button>`
  )).join('');
  return `<div class="finder-posfilter" role="group" aria-label="Filter finder by position">${chips}</div>`;
}

/** Finder sort buttons (active one shows a ▼/▲ direction arrow). */
function finderSortInner(activeKey, dir) {
  return FINDER_SORTS.map((s) => {
    const on = s.key === activeKey;
    const arrow = on ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return (
      `<button type="button" class="sort-chip${on ? ' sort-chip--active' : ''}" ` +
        `data-fsort="${s.key}" aria-pressed="${on ? 'true' : 'false'}">${s.label}${arrow}</button>`
    );
  }).join('');
}
function finderSortRow(activeKey, dir) {
  return `<div class="finder-sortseg" role="group" aria-label="Sort finder">${finderSortInner(activeKey, dir)}</div>`;
}

/** Reco sort control: Best AI Pick (fit) vs Best available (raw points). */
function recoSortInner(activeKey) {
  const opt = (key, label) => (
    `<button type="button" class="sort-chip${key === activeKey ? ' sort-chip--active' : ''}" ` +
      `data-rsort="${key}" aria-pressed="${key === activeKey ? 'true' : 'false'}">${label}</button>`
  );
  return opt('fit', 'BEST FIT') + opt('available', 'BEST AVAIL');
}

/* ---- LEAGUE PROFILE bridge (pure — exported for tests, no DOM) -------------
 *
 * The draft simulator's roster config (app/draft-sim.js rosterShape) speaks
 * {qb,rb,wr,te,flex,bench}; the LeagueProfile (app/league.js) speaks
 * roster_positions tokens. These two functions are the ONLY translation, and
 * they translate in both directions without inventing anything:
 *   - tokens the simulator cannot price (K, DEF, DST) are CARRIED through the
 *     round trip and reported, never silently dropped;
 *   - counts outside ROSTER_BOUNDS are clamped and the clamp is reported.
 * ------------------------------------------------------------------------- */

/**
 * Roster tokens the draft simulator prices directly.
 *
 * R27 — K and DEF join the list. This constant is exported and asserted, and
 * its old comment ("its shape knows no K/DEF") is exactly the claim the release
 * retires: rosterShape seats a K1 and a DEF1 for a league that asks for them,
 * and the room's board carries this league's kickers and defences. Leaving the
 * four-token list here would have kept one authoritative-looking statement of
 * the old behaviour in the codebase after the behaviour changed.
 *
 * DST is deliberately absent: it is the same slot as DEF under a second
 * spelling, folded into one count on the way in and written back in the
 * league's own spelling on the way out (see cfgFromProfile / profileFromCfg).
 */
export const DRAFTABLE_TOKENS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

function clampCount(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Menu label for a flex token, in this app's idiom (bare positions, upper). */
export function flexLabel(token) {
  const spec = FLEX_ELIGIBILITY[token];
  if (!spec) return String(token == null ? '' : token);
  const positions = spec.positions.join('/');
  if (token === 'SUPER_FLEX') return `${positions} · SUPERFLEX`;
  return spec.app_only ? `${positions} · APP ONLY` : positions;
}

/**
 * LeagueProfile -> draft-simulator config.
 * Returns { cfg, carried, clamped } where `carried` lists roster tokens the
 * simulator cannot price (kept on the profile) and `clamped` lists every count
 * ROSTER_BOUNDS had to pull in, as { key, wanted, used }.
 *
 * MORE THAN ONE KIND OF FLEX SLOT (R23 fix). FLEX + SUPER_FLEX is the standard
 * superflex shape, and the grid has exactly ONE flex selector. The first flex
 * token owns that selector; every LATER flex token of a DIFFERENT kind is
 * CARRIED verbatim, the same way K/DEF are. It used to be counted into `flex`
 * and re-mapped onto the first token, which meant the round trip rewrote
 * SUPER_FLEX as a second FLEX — silently turning the saved superflex league
 * into a 1-QB league the moment the panel wrote it back.
 */
export function cfgFromProfile(profile) {
  const p = normalizeProfile(profile);
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const carried = [];
  let flex = 0;
  let bench = 0;
  let flexType = null;
  let kCount = 0;
  let defCount = 0;
  let defToken = null;   // 'DEF' or 'DST' — whichever spelling this league uses
  p.shape.roster_positions.forEach((token) => {
    if (token === 'BN') { bench += 1; return; }
    if (FLEX_ELIGIBILITY[token]) {
      if (!flexType) flexType = token;  // the first flex token owns the selector
      if (token === flexType) { flex += 1; return; }
      carried.push(token);              // a DIFFERENT flex slot — kept as itself
      return;
    }
    if (counts[token] != null) { counts[token] += 1; return; }
    // R27 — K / DEF / DST are DRAFTABLE now, so they get a real slot in the sim
    // shape and must NOT go into `carried`.
    //
    // `carried` means "kept on your profile but the simulator does not draft
    // it", and the settings card and the import report both say exactly that
    // about every token in it. Leaving K/DEF there while making them draftable
    // made the app state something false — which is worse than the original
    // gap, because a user who reads it stops looking for the kicker that is
    // now right there. (Caught in review of PR #38, 2026-08-14.)
    //
    // defToken preserves the league's own spelling: DEF and DST are the same
    // slot and fold into one count (the room cannot seat a team defence
    // twice), but writing DEF back into a profile that said DST would silently
    // rewrite the user's league.
    if (token === 'K') { kCount += 1; return; }
    if (token === 'DEF' || token === 'DST') {
      defCount += 1;
      if (!defToken) defToken = token;
      return;
    }
    carried.push(token); // anything else — kept, undrafted, and said out loud
  });
  const wanted = {
    qb: counts.QB, rb: counts.RB, wr: counts.WR, te: counts.TE, flex, bench,
  };
  // R47 — ALWAYS present. The default roster now seats one K and one DEF, so
  // a league that fields neither must say `k: 0 / def: 0` explicitly: left
  // absent, the DEFAULT_ROSTER spread underneath would re-seat them and the
  // setup card would read as UNSAVED against a profile that never changed.
  wanted.k = kCount;
  wanted.def = defCount;
  const cfg = {};
  const clamped = [];
  Object.keys(wanted).forEach((key) => {
    const [lo, hi] = ROSTER_BOUNDS[key];
    const used = clampCount(wanted[key], lo, hi);
    if (used !== wanted[key]) clamped.push({ key, wanted: wanted[key], used });
    cfg[key] = used;
  });
  cfg.leagueSize = clampCount(p.shape.teams, LEAGUE_BOUNDS.teams[0], LEAGUE_BOUNDS.teams[1]);
  cfg.flexType = flexType || 'FLEX';
  cfg.keepers = p.shape.keepers_enabled === true;
  cfg.maxKeepers = p.shape.max_keepers;
  // Only when this league actually seats a defence, and only the spelling it
  // used — so SAVE writes back DST to a DST league and DEF to a DEF one.
  if (defToken) cfg.defToken = defToken;
  return { cfg, carried, clamped };
}

/**
 * Draft-simulator config -> LeagueProfile. `base` supplies everything the
 * simulator has no opinion about (name, scoring table, position caps); the
 * shape comes from `cfg`. `carried` tokens are re-inserted after the flex
 * slots so a K/DEF league — or a second kind of flex slot the one selector
 * cannot show, e.g. the SUPER_FLEX of a superflex league — survives an edit
 * made in this panel. Eligibility is written for every flex token that ends up
 * on the roster, not just the selected one.
 */
export function profileFromCfg(cfg, base, carried) {
  const baseProfile = normalizeProfile(base);
  const out = cloneProfile(baseProfile);
  const c = cfg || {};
  const token = FLEX_ELIGIBILITY[c.flexType] ? c.flexType : 'FLEX';
  const positions = [];
  const push = (t, n) => { for (let i = 0; i < clampCount(n, 0, 40); i += 1) positions.push(t); };
  push('QB', c.qb); push('RB', c.rb); push('WR', c.wr); push('TE', c.te);
  push(token, c.flex);
  // R27 — K and DEF are written back from the CONFIG now, not from `carried`.
  // They used to ride along as carried tokens (the only way an undraftable slot
  // could survive a SAVE); making them draftable moved them into the shape, so
  // this is where they have to be rebuilt or SAVE would silently delete the
  // kicker slot off an imported league. c.defToken preserves DST vs DEF.
  push('K', c.k);
  push(c.defToken === 'DST' ? 'DST' : 'DEF', c.def);
  (carried || []).forEach((t) => positions.push(t));
  push('BN', c.bench);
  const flexEligibility = {};
  positions.forEach((t) => {
    if (FLEX_ELIGIBILITY[t] && !flexEligibility[t]) {
      flexEligibility[t] = [...FLEX_ELIGIBILITY[t].positions];
    }
  });
  out.shape.roster_positions = positions;
  out.shape.teams = clampCount(c.leagueSize, LEAGUE_BOUNDS.teams[0], LEAGUE_BOUNDS.teams[1]);
  out.shape.flex_eligibility = flexEligibility;
  /* DRAFT ROUNDS ARE NOT ROSTER SIZE (R24 fix). The grid has no rounds field,
   * so this used to write positions.length over whatever the profile carried —
   * erasing the draft_rounds the Sleeper import read from the real league (15
   * rounds against a 17-slot roster) and then reporting the fabricated number
   * in the SAVE status as fact. An EXPLICIT value (one that is not simply
   * tracking the roster size) survives any edit that leaves the roster size
   * alone; it is only re-derived when it was tracking the roster anyway, or
   * when the roster size moved under it. draftRoundsOverride() reports that
   * second case out loud, the way `clamped` entries are reported. */
  const priorSize = baseProfile.shape.roster_positions.length;
  const priorRounds = baseProfile.shape.draft_rounds;
  out.shape.draft_rounds = (priorRounds !== priorSize && positions.length === priorSize)
    ? priorRounds
    : positions.length;
  out.shape.keepers_enabled = c.keepers === true;
  out.shape.max_keepers = c.keepers === true ? clampCount(c.maxKeepers, 0, 40) : 0;
  return normalizeProfile(out);
}

/**
 * Did profileFromCfg() have to overwrite an EXPLICIT draft_rounds?
 *
 * Returns { wanted, used } when the base profile carried a draft_rounds that
 * was not merely tracking its roster size and the write could not keep it
 * (the roster size moved), else null. Pure — the SAVE status prints this the
 * same way it prints a ROSTER_BOUNDS clamp, so the panel never reports a
 * derived number as the league's own.
 */
export function draftRoundsOverride(cfg, base, carried) {
  const b = normalizeProfile(base);
  const priorRounds = b.shape.draft_rounds;
  if (priorRounds === b.shape.roster_positions.length) return null; // was tracking the roster
  const used = profileFromCfg(cfg, base, carried).shape.draft_rounds;
  return used === priorRounds ? null : { wanted: priorRounds, used };
}

/** "PPR (1)" / "HALF (0.5)" / "STD (0)" / "CUSTOM (0.75)" for a profile. */
export function receptionLabel(profile) {
  const p = normalizeProfile(profile);
  const rec = Number.isFinite(Number(p.scoring.rec)) ? Number(p.scoring.rec) : 0;
  return `${scoringMode(p).toUpperCase()} (${rec})`;
}

/**
 * The "did it take?" rows for an import: what actually landed on the profile.
 * Pure — reads the PROFILE, not the payload, so it can never claim a value the
 * profile does not carry.
 */
export function importSummaryRows(profile) {
  const p = normalizeProfile(profile);
  return [
    { label: 'TEAMS', value: String(p.shape.teams) },
    { label: 'STARTERS', value: String(p.shape.starters) },
    { label: 'BENCH', value: String(p.shape.bench) },
    { label: 'SCORING KEYS', value: String(Object.keys(p.scoring).length) },
    { label: 'RECEPTION', value: receptionLabel(p) },
  ];
}

/* ---- R30b honesty helpers (pure, exported for tests, no DOM) ----------------
 *
 * Four small facts this page states that R30 caught it stating wrongly. Each
 * is a pure function so the CLAIM itself is node-testable, not just the code
 * around it.
 */

/**
 * R30b — the import report's "Next:" line on a failed paste.
 *
 * app/sleeper.js still advertises a third import tier on failure ("Start from
 * standard PPR — Hand-build the league from the standard PPR default. Every
 * value is editable."). No such control exists anywhere: no button starts
 * from the PPR default, and no surface in this app edits a per-stat scoring
 * value. This view owns what the user actually reads, so the unreachable
 * route is replaced with the routes that exist — fix the paste, or SYNC NOW —
 * plus the hand-set path this card really offers (the roster counters and
 * selectors). Every other line passes through untouched: the first line of a
 * failure report is the true error and must stay first.
 */
export function honestImportFailureLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((l) => (
    /^Next: Start from standard PPR/.test(String(l))
      ? 'Next: check the paste and import again — the whole /league/{id} response, '
        + 'from the first { to the last } — or enter your league id above and press '
        + 'SYNC NOW. You can also set teams, roster slots and flex by hand with the '
        + 'counters on this card; there is no scoring editor in this app, so a '
        + 'league\'s own per-stat scoring arrives only through a successful import.'
      : String(l)
  ));
}

/**
 * R30b — MY starting auction money. `a.budget` is the league default ("what a
 * team holds unless told otherwise" — app/auction.js), and R27's per-team
 * editor lets mine differ. Mirrors app/auction.js scoreAuction, which
 * documents why: spending $150 of $185 is not the same as $150 of $200. MY
 * BUILD read the default and so opened an uneven room with a partly-filled
 * spend bar and a plan for money I do not have.
 */
export function aucStartingBudget(a) {
  const myStart = (a && a.teamBudgets ? a.teamBudgets : [])[a.mySlot - 1];
  return Number.isFinite(myStart) ? myStart : a.budget;
}

/**
 * R30b — the AUC half of the visible value-cell legend. The cell rescales
 * ESPN's published bid into the user's budget (valueCell), and the per-cell
 * title says so — but a title is hover-only, unreachable on an iPad, and the
 * always-visible legend flatly called the rescaled number "ESPN's average
 * winning bid". The legend must state the same restatement the cell performs,
 * in the same three cases the cell's own title distinguishes.
 */
export function aucLegendAucText(userBudget, mktBudget) {
  if (!mktBudget) {
    return 'AUC = ESPN\'s average winning bid, shown as published — ESPN does not '
      + 'publish this board\'s budget, so it cannot be restated in yours. ';
  }
  if (Number(userBudget) !== Number(mktBudget)) {
    return `AUC = ESPN's average winning bid, published on a $${mktBudget} board `
      + `and restated here in your $${userBudget}. `;
  }
  return 'AUC = ESPN\'s average winning bid. ';
}

/**
 * R30b — the seated starters whose K/D-ST total is INCOMPLETE under this
 * league's scoring (app/kdst.js marks them `partial` with the omitted
 * components named). The slot chip, the finder row and the Lineup card all
 * mark these numbers; the STARTERS SEASON TOTAL folded them in unmarked —
 * the single most prominent figure on the page read as complete while the
 * rows it was built from admitted they were not.
 */
export function partialKdstStarters(starterIds, playersById) {
  return (Array.isArray(starterIds) ? starterIds : [])
    .map((id) => playersById.get(String(id)))
    .filter((p) => p && p.kdst && p.kdst.partial);
}

/* ---- SLEEPER ROSTER SYNC — SEATING (pure, exported for tests, no DOM) -------
 *
 * R19 imported a Sleeper league's SCORING and SHAPE. This seats the ROSTER: the
 * players actually on the user's Sleeper team, in THIS app's slot vocabulary.
 *
 * DIVISION OF LABOUR. app/sleeper.js owns everything about Sleeper — reading
 * /rosters and /users (importSleeperTeams), indexing the player dump
 * (buildSleeperPlayerIndex) and crosswalking Sleeper ids onto this app's player
 * ids (crosswalkRoster, five ordered methods, every failure coded). None of
 * that is re-implemented here. What IS here is the one thing that module has no
 * business knowing: which SLOT a resolved player takes in the user's league.
 * Those slot ids come from rosterSlots(profile)/firstOpenSlot() — the same ids
 * the Lineup page reads. Writing legacy ids here was a P1 bug last release.
 *
 * ============================ MANUAL SYNC ONLY ============================
 * Three GETs per press of SYNC ROSTER and not one byte more: no polling, no
 * setInterval, no background refresh, no re-sync on focus or reconnect. The
 * only timer in this path is the abort timeout on a hung fetch.
 * ==========================================================================
 *
 * NOTHING IS SILENTLY DROPPED. Every Sleeper player id ends up either seated,
 * or in `unresolved` (app/sleeper.js could not match them, with the reason), or
 * in `unplaced` (they matched, but this league's geometry has no slot left for
 * them, with the reason). A hand-built roster is never replaced without the
 * losses being named first — that is what planRosterSync().dropped is for.
 *
 * NO MARKET DATA IS READ HERE. A Sleeper roster payload carries draft-pick and
 * waiver-budget metadata; none of it is touched.
 */

/**
 * Sleeper's whole-league player dump. Since R52 this view fetches NOTHING
 * itself: app/sleeper.js loadSleeperPlayerIndex() reads the dump once per
 * session (memoized, HTTP-cacheable, streamed with progress, a failure never
 * remembered) and hands back the built index. The URL is the loader's own,
 * re-exported because the roster-sync contract test pins it.
 */
export const SLEEPER_PLAYER_INDEX_URL = PLAYER_INDEX_URL;

/** Frozen policy marker for the roster path — manual only, see the header. */
export const ROSTER_SYNC_MODE = 'manual';

function up(v) {
  return String(v == null ? '' : v).toUpperCase().trim();
}

/**
 * A crosswalkRoster() result -> one seating order, de-duplicated by app player.
 *
 * Sleeper's STARTERS come first, in Sleeper's own starter order, so seating
 * them first is what puts the user's actual starters in the starting slots; the
 * rest of the roster follows in Sleeper's order and lands on the bench. A
 * player who appears in both lists is seated once.
 */
export function orderedRosterPlayers(crosswalk) {
  const cw = crosswalk && typeof crosswalk === 'object' ? crosswalk : {};
  const listOf = (part) => (part && Array.isArray(part.resolved) ? part.resolved : []);
  const out = [];
  const seen = new Set();
  const push = (row, starter) => {
    const id = row && row.player_id != null ? String(row.player_id) : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ ...row, player_id: id, position: up(row.position), starter });
  };
  listOf(cw.starters).forEach((r) => push(r, true));
  listOf(cw.players).forEach((r) => push(r, false));
  return out;
}

/**
 * The rows the UI must show as "could not be matched".
 *
 * `empty_slot` is dropped and only that: Sleeper writes "0" into a starting
 * slot the manager left empty, and an empty slot is not a player who went
 * missing. Every other code — unknown id, unsupported position, no app match,
 * ambiguous — is a real player this app could not place, and is shown.
 */
export function unmatchedRosterPlayers(crosswalk) {
  const list = crosswalk && Array.isArray(crosswalk.unresolved) ? crosswalk.unresolved : [];
  return list.filter((u) => u && u.code !== 'empty_slot');
}

/**
 * Seat resolved players into THIS league's slots and diff the result against
 * what is on the roster now.
 *
 * `resolved` is orderedRosterPlayers() output: rows carrying { player_id, name,
 * position, starter }. Slots come from rosterSlots(profile) via firstOpenSlot(),
 * so a 9-starter SUPERFLEX league gets SUPER_FLEX and never a stand-in FLEX.
 * Position caps are honoured exactly as the ADD button honours them, and a
 * player the caps or the geometry leave no room for is returned in `unplaced`
 * with the reason — never dropped.
 *
 * Returns { slots, assigned, unplaced, added, kept, moved, dropped, ... }.
 * `dropped` is the whole point of the confirm step: every player on the roster
 * now who would NOT be there afterwards.
 */
export function planRosterSync({ resolved, currentSlots, profile, playersById } = {}) {
  const pool = playersById instanceof Map ? playersById : new Map();
  const prof = normalizeProfile(profile);
  const order = rosterSlots(prof).all;
  const slots = {};
  order.forEach((s) => { slots[s] = null; });

  /* TWO DIFFERENT REASONS A PLAYER DOES NOT FIT (R24). "Every slot is taken"
   * is a lie when the league has ZERO slots for the position — a K in a league
   * with no K slot is not competing for a full slot, there is no slot at all,
   * and the two facts call for different actions from the user. Bench slots
   * only take positions the roster plays (rosterPositionsInPlay), so a single
   * slotAccepts() sweep over `order` answers it exactly. Memoised per position. */
  const rostersPos = new Map();
  const leagueRosters = (position) => {
    if (!rostersPos.has(position)) {
      rostersPos.set(position, order.some((s) => slotAccepts(position, s, prof)));
    }
    return rostersPos.get(position);
  };

  const list = Array.isArray(resolved) ? resolved : [];
  const ordered = [...list.filter((r) => r && r.starter), ...list.filter((r) => r && !r.starter)];
  const assigned = [];
  const unplaced = [];

  ordered.forEach((r) => {
    const id = String(r.player_id);
    const position = up(r.position);
    const name = r.name || id;
    if (positionAtCap(position, slots, pool, profile)) {
      unplaced.push({
        ...r,
        reason: `Your league profile caps ${position} and that cap is already full, so `
          + `${name} has no legal slot.`,
      });
      return;
    }
    const slot = firstOpenSlot(position, slots, prof);
    if (!slot) {
      unplaced.push({
        ...r,
        reason: leagueRosters(position)
          ? `Every slot this roster has for a ${position} is taken, so ${name} did not fit.`
          : `This league rosters no ${position} at all — no starting or bench slot accepts one, `
            + `so ${name} could not be seated.`,
      });
      return;
    }
    slots[slot] = id;
    assigned.push({ ...r, slot });
  });

  const before = new Map();
  const cur = currentSlots && typeof currentSlots === 'object' ? currentSlots : {};
  Object.keys(cur).forEach((s) => {
    const id = cur[s] == null ? null : String(cur[s]);
    if (id) before.set(id, s);
  });
  const after = new Map();
  Object.keys(slots).forEach((s) => { if (slots[s]) after.set(String(slots[s]), s); });

  const nameOf = (id) => {
    const p = pool.get(id);
    return p && p.name ? p.name : id;
  };
  const posOf = (id) => {
    const p = pool.get(id);
    return p && p.position ? up(p.position) : '';
  };

  const added = [];
  const kept = [];
  const moved = [];
  const dropped = [];
  after.forEach((slot, id) => {
    const row = { player_id: id, name: nameOf(id), position: posOf(id), slot };
    if (!before.has(id)) {
      added.push(row);
      return;
    }
    kept.push(row);
    if (before.get(id) !== slot) moved.push({ ...row, from: before.get(id) });
  });
  before.forEach((slot, id) => {
    if (!after.has(id)) dropped.push({ player_id: id, name: nameOf(id), position: posOf(id), slot });
  });

  return {
    slots,
    assigned,
    unplaced,
    added,
    kept,
    moved,
    dropped,
    before_count: before.size,
    after_count: after.size,
  };
}

/**
 * Plain-language lines for a sync plan. Says what WILL happen, in the numbers
 * the plan actually carries — never a flattering summary of an import.
 */
export function rosterPlanLines(plan, unresolved) {
  if (!plan) return [];
  const miss = Array.isArray(unresolved) ? unresolved : [];
  const lines = [
    `${plan.after_count} player(s) would be seated: ${plan.added.length} added, `
    + `${plan.kept.length} already on your roster (${plan.moved.length} moved slot).`,
  ];
  if (plan.dropped.length > 0) {
    lines.push(`${plan.dropped.length} player(s) currently on your roster are NOT on this `
      + 'Sleeper team and would be removed.');
  } else if (plan.before_count > 0) {
    lines.push('Nothing currently on your roster would be removed.');
  }
  if (plan.unplaced.length > 0) {
    lines.push(`${plan.unplaced.length} matched player(s) have no legal slot in this league's `
      + 'roster shape and would be left off.');
  }
  if (miss.length > 0) {
    lines.push(`${miss.length} Sleeper player(s) could not be matched to this app's pool and `
      + 'are listed in full below.');
  }
  if (plan.unplaced.length === 0 && miss.length === 0) {
    lines.push('Every player on that Sleeper roster was matched and seated.');
  }
  return lines;
}

/* ---- R52: everything this view derives from the SAVED PROFILE -------------
 *
 * ONE code path, whether the profile arrived by a fresh mount or by SYNC NOW /
 * RE-APPLY / SAVE inside a live mount. Before R52 the second case re-mounted
 * the whole view so these were rebuilt "for free" — and the remount is what
 * raced (two async mounts of one element, whichever reached the hand-off flag
 * first consumed it, the other painted over it). Now a live mount calls this
 * and reassigns its state in place, and the node test pins that the in-place
 * derivation equals a fresh mount's for the same saved profile.
 *
 * Inputs are the mount's feeds (players, the UNSTAMPED weekly map, the K/DST
 * document) plus the profile and the scoring mode. Pure apart from loadRoster,
 * which reads the saved roster under the profile's slot vocabulary exactly as
 * a fresh mount does.
 */
export function deriveLeagueState({ savedProfile, players, weeklyBase, kdstDoc, mode }) {
  /* R29 — THIS LEAGUE's own scoring rules, stamped onto the weekly entries
   * once, so every conversion below prices the same player identically without
   * threading a rate through eight signatures. Must follow the profile load:
   * stamping before the league is known would price every league at zero. A
   * league that does not score pass_cmp gets the identical Map back. */
  const weeklyById = withLeagueExtras(weeklyBase, savedProfile);
  /* ---- R21: K and D/ST can actually be SEATED -------------------------------
   *
   * R19-B5 gave a K/DEF league its K and DEF slots. R20-B1 gave the Lineup view
   * a K/DST feed. Nothing gave THIS page a kicker to put in the slot: the
   * player pool was data/player_projections.json, which is QB/RB/WR/TE by
   * contract (K/DST live in their own file precisely so they do not evict ~74
   * offensive players from its projected[:300] cut). So K1 and DEF1 rendered an
   * "ADD K" button that opened a finder containing no kickers, and SYNC ROSTER
   * reported a real kicker as "not in this app's player pool" and left the slot
   * null. The slot existed; nothing could ever go in it.
   *
   * FOUR RULES this seating obeys:
   *
   *  1. IT IS ADDITIVE AND GATED. `players` — the array every engine on this
   *     page reads (fit engine, VOR, best-pick, draft room, auction) — is NOT
   *     touched. K/DST rows live in their own array and are merged only into
   *     the id lookup, the finder and the roster crosswalk. And they exist at
   *     all only for a league whose roster_positions actually name K/DEF/DST:
   *     with no profile saved, `kdstRows` is empty and every byte of this page
   *     is what it was.
   *  2. THEY ARE NOT DRAFT-BOARD MATERIAL. A kicker's ~180 season points sit
   *     mid-board against offence, but he is worth almost nothing over
   *     replacement — every kicker scores about the same. So K/DST never enter
   *     the unfiltered "best available" list, the BEST PICK NOW strip, the
   *     draft simulator or the auction. They surface when you ask for them: the
   *     K/DEF finder chips, a search that matches by name, or a K/DEF slot.
   *  3. THE NUMBER IS THE LEAGUE'S OWN. app/kdst.js recomputes each stat line
   *     under the connected profile's scoring table (never the contract's
   *     DEFAULT-profile convenience total), and reports which components that
   *     table pays for that the feed cannot supply.
   *  4. AN INCOMPLETE NUMBER IS MARKED HERE TOO. A PARTIAL total gets its badge
   *     on this page as well as on Lineup — otherwise seating a defence just
   *     moved an unmarked number to a different screen.
   * ------------------------------------------------------------------------ */

  // The K/DST positions THIS league actually fields, spelled the way its own
  // roster tokens spell them (a DST league gets 'DST', fed by the DEF rows).
  const kdstSeatTokens = rosterPositionsInPlay(savedProfile).filter(isKdstPosition);
  /* SHAPED ONLY FOR A LEAGUE THAT SEATS THEM (R25). kdstIndex is read in
   * exactly one place — the kdstSeatTokens loop below — so with no K/DEF/DST
   * token on the roster (the DEFAULT profile has none) the entire shaping pass
   * was computed and thrown away. It is not cheap: app/kdst.js shapes 74 rows
   * and each row's applyScoring() and omittedKeys() re-runs normalizeProfile()
   * -> cloneProfile() on an already-normalised savedProfile, ~4.3 ms of the mount.
   * Gating on the tokens changes no output — kdstRows stays empty either way. */
  const kdstIndex = kdstSeatTokens.length
    ? shapeKdst(kdstDoc, savedProfile)
    : null;
  /** Contract rows shaped like a projection row, so every consumer is unchanged. */
  const kdstRows = [];
  {
    const usedCanon = new Set();
    for (const token of kdstSeatTokens) {
      const canon = canonKdstPosition(token);
      if (usedCanon.has(canon)) continue;   // one spelling per position
      usedCanon.add(canon);
      for (const e of kdstIndex.byPosition[canon] || []) {
        // An UNSCORED row cannot be valued under this league's table, so there
        // is no honest number to seat it with — app/kdst.js already refuses to
        // feed the position, and this page refuses to offer the player.
        if (e.unscored) continue;
        kdstRows.push({
          gsis_id: e.id,
          name: e.name,
          team: e.team,
          position: token,
          proj_points: e.seasonPoints,
          kdst: e,
        });
      }
    }
  }
  /** Every player this page can SEAT: offence, plus this league's K/DST. */
  const seatable = kdstRows.length ? players.concat(kdstRows) : players;
  // Per-mode derived maps (mode changes re-derive, see adoptSavedProfile):
  //   adjById    id -> season points at the current scoring mode (EXACT)
  //   scaledById id -> 18 weekly floats at the current scoring mode (byes 0)
  //
  // R34 RCA — "scores change when I flip AUCTION/SNAKE": they do not, and this
  // map is why. `mode` here is the SCORING mode (ppr/half/std); draftCfg.mode
  // (the draft FORMAT) is never an input to adjById, scaledById, the finder's
  // SZN column, the slot chips, the STARTERS SEASON TOTAL or the
  // best-available ordering — every one of those reads this map, built before
  // draftCfg is even consulted. What DOES differ by format is MONEY, by
  // design: auction mode adds the OURS/AUC dollar columns and, once a room is
  // open, an affordability FILTER on the reco/best-pick panels (see
  // recoBudget) — rows can drop, dollar chips appear, but no player's
  // projected points ever move. If a points number is ever observed moving on
  // a format flip, the bug is a new draftCfg.mode read in a scoring path, not
  // in here.
  const playersById = new Map(seatable.map((p) => [String(p.gsis_id), p]));
  const adjById = new Map();
  const scaledById = new Map();
  //
  // R30 — the 4th argument is NOT optional here. weeklyById was stamped with
  // this league's extra scoring rules at mount (withLeagueExtras, above);
  // omitting extraPtsOf(e) stamped the map and then threw the stamp away, and
  // this was the ONLY scoringAdjust call site in the app that did so. The
  // result was a page that disagreed with itself: team-logic DOES pass the
  // extras, so BEST FIT valued a pass_cmp league's Josh Allen at 524.1 while
  // the finder card, his slot chip and the SEASON TOTAL printed 364.6 for the
  // same player at the same moment — and the "best available" ordering was
  // computed on a scale the page never showed.
  players.forEach((p) => {
    const id = String(p.gsis_id);
    const e = weeklyById.get(id);
    const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e));
    adjById.set(id, adj);
    if (e) scaledById.set(id, weeklyPoints(e, adj, p.proj_points));
  });
  // K/DST season points are already exact under this league's scoring table
  // (app/kdst.js applyScoring) and carry no receptions, so the PPR/HALF/STD
  // reception adjustment has nothing to act on — the number is the same in
  // every mode, which is simply true of a kicker. No `scaledById` entry: there
  // is no weekly split for these positions and inventing one from a flat
  // average is the lie R20-B1 refused to tell.
  kdstRows.forEach((p) => { adjById.set(String(p.gsis_id), p.proj_points); });

  // Default finder order: best available first (adjusted points desc, id asc).
  // OFFENCE ONLY — see rule 2 above: a kicker outranking a WR3 on a board that
  // says "best available" would be a ranking this app does not believe.
  const sortedPlayers = players.slice().sort((a, b) =>
    adjById.get(String(b.gsis_id)) - adjById.get(String(a.gsis_id))
    || (String(a.gsis_id) < String(b.gsis_id) ? -1 : 1));
  /** This league's K/DST, best first — the finder's pool when one is asked for. */
  const sortedKdst = kdstRows.slice().sort((a, b) =>
    b.proj_points - a.proj_points
    || (String(a.gsis_id) < String(b.gsis_id) ? -1 : 1));
  /** The extra finder chips this league needs, in roster order. [] normally. */
  const kdstChips = [...new Set(kdstRows.map((r) => r.position))];

  /* R30b — WHICH SLOTS KEEP AN ID THIS MOUNT CANNOT RESOLVE. A saved K or
   * D/ST id resolves through the kdst contract alone (those ids are not in
   * player_projections.json), so on any load where that OPTIONAL feed fails —
   * a dropped request, a missing/hollow document, or a scoring table that
   * leaves every row unscored — the id has no row behind it. That is a fact
   * about THE FEED, not about the roster: dropping the id would let the next
   * saveRoster() (any ADD, REMOVE or live-room sync) delete the saved kicker
   * and defence permanently. So a slot whose eligible positions are all
   * K/D-ST, and none of which produced a seatable row this mount, RETAINS its
   * saved id; the painters render it as a degraded seat and only the user
   * removes it. When the feed IS up, the set is empty per position and a
   * player genuinely dropped from it still vanishes honestly, like any other.
   */
  const kdstFedCanon = new Set(kdstRows.map((r) => canonKdstPosition(r.position)));
  const kdstUnresolvedSlots = new Set(rosterSlots(savedProfile).all.filter((slot) => {
    const eligible = slotEligiblePositions(slot, savedProfile);
    return eligible.length > 0
      && eligible.every(isKdstPosition)
      && !eligible.some((pos) => kdstFedCanon.has(canonKdstPosition(pos)));
  }));
  const roster = loadRoster(new Set(playersById.keys()), savedProfile, kdstUnresolvedSlots);
  return {
    weeklyById, kdstSeatTokens, kdstRows, seatable, playersById, adjById, scaledById,
    sortedPlayers, sortedKdst, kdstChips, kdstUnresolvedSlots, roster,
  };
}

/* ---- mount ------------------------------------------------------------------ */

/** One-shot league status carried across the remount the two resets force (R52:
 * a re-price no longer remounts — see adoptSavedProfile). */
let leagueFlash = null;

export default async function mountTeam(el) {
  // Retire the previous mount's listeners BEFORE this one paints (see
  // TEARDOWN_KEY). Aborting a signal only unbinds; a handler already running —
  // the SAVE handler that re-mounts this view on a scoring re-price — finishes
  // normally. Absent AbortController, every listener binds as it always did.
  const priorTeardown = el[TEARDOWN_KEY];
  if (priorTeardown) { try { priorTeardown.abort(); } catch (_) { /* already gone */ } }
  /* R52 — THIS mount's number. Every continuation that follows an await and
   * writes DOM asks stale() first: a newer mount of this element, an element
   * that left the document, or another view having taken #view (the shell
   * anchor is gone) all mean this mount writes nothing more. */
  const seq = ++mountSeq;
  let shell = null; // this mount's own node inside el, set once the shell paints
  const stale = (where) => {
    if (seq === mountSeq && el.isConnected && !(shell && !shell.isConnected)) return false;
    console.debug(`team: mount #${seq} superseded at ${where} — nothing written`);
    return true;
  };
  const teardown = typeof AbortController === 'function' ? new AbortController() : null;
  el[TEARDOWN_KEY] = teardown;
  /** addEventListener scoped to THIS mount's lifetime. */
  const listen = (target, type, fn, capture) => {
    const opts = capture ? { capture: true } : {};
    if (teardown) opts.signal = teardown.signal;
    target.addEventListener(type, fn, opts);
  };
  // R33 — the companion's poll timer is closure state, not a listener, so the
  // abort signal cannot unbind it. Stop it explicitly when this mount is
  // superseded, or a navigated-away TEAM tab would keep polling Sleeper every
  // five seconds forever. `companion` is declared below; by the time any
  // abort can fire, the mount body has long since executed.
  if (teardown) {
    teardown.signal.addEventListener('abort', () => {
      if (companion) companion.stop('left the page');
    });
  }
  /** Has this mount been superseded? Guards work queued on a timer. */
  const retired = () => !!(teardown && teardown.signal.aborted);

  el.innerHTML = '<div class="state state--loading">Loading team builder…</div>';

  // Projections + weekly are both REQUIRED here (the fit engine is weekly
  // math); game predictions only pick the "current week" chip and ai_insights
  // only powers the opt-in AI+ toggle — both are optional (missing = degrade).
  const [projRes, weeklyRes, predsRes, aiRes, histRes, strRes, adpRes, kdstRes] =
    await Promise.allSettled([
      getPlayerProjections(),
      getPlayerWeekly(),
      getGamePredictions(),
      getAiInsights(),
      getPlayerHistory(),
      getTeamStrength(),
      getAdp(),
      // OPTIONAL, exactly like the others: a deploy predating the K/DST builder
      // (or a 404) leaves K and DEF slots exactly as unfillable as they were,
      // and every other surface on this page is untouched.
      getKdstProjections(),
    ]);
  if (stale('feeds')) return;
  if (projRes.status !== 'fulfilled') {
    stateMsg(el, 'Team builder unavailable — the projection feed did not load.');
    return;
  }
  const players = (projRes.value && Array.isArray(projRes.value.players))
    ? projRes.value.players
    : [];
  if (players.length === 0) {
    stateMsg(el, 'No player projections yet.');
    return;
  }
  const weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
  // UNSTAMPED: deriveLeagueState() stamps this league's extras onto a copy.
  const weeklyBase = new Map();
  if (weekly && Array.isArray(weekly.players)) {
    weekly.players.forEach((w) => weeklyBase.set(String(w.gsis_id), w));
  }
  if (weeklyBase.size === 0) {
    // No usable weekly feed: no bye/floor/matchup math is possible — say so
    // instead of faking a fit score. R30c — the old message promised the feed
    // "ships with the next data deploy"; it shipped long ago and the daily
    // cron refreshes it, so this branch means the fetch failed (or returned no
    // matchable rows) THIS visit. Name the honest failure and the honest
    // remedy (retry), never a release that already happened.
    stateMsg(el, 'Weekly data unavailable — the weekly projection feed '
      + '(data/player_weekly.json) did not load. Reload to retry; if it '
      + 'persists the feed is temporarily unreachable.');
    return;
  }

  // "Current week" for the filled-slot wk-pts chip (falls back to week 1).
  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(18, Math.max(1, Math.round(w)));
  }

  let mode = loadScoring(); // the Players header owns the toggle; re-read by adoptSavedProfile

  // Fit Engine AI layer (v2): available only when data/ai_insights.json loaded
  // AND actually carries players — a 404 (older deploy) or a hollow file hides
  // the toggle entirely, so the view never offers a mode it cannot honor.
  const aiInsights = (aiRes.status === 'fulfilled'
    && aiRes.value && aiRes.value.players
    && Object.keys(aiRes.value.players).length > 0)
    ? aiRes.value
    : null;
  let aiOn = aiInsights ? loadAiPref() : false; // persisted nfl2026.ai.v1, default off

  // REL2 finder adornments: player_history (trend fallback) + team_strength (SoS).
  const aiPlayersMap = aiInsights && aiInsights.players ? aiInsights.players : null;
  const historyMap = (histRes.status === 'fulfilled' && histRes.value && histRes.value.players)
    ? histRes.value.players : null;
  const teamStrength = (strRes.status === 'fulfilled' && strRes.value && strRes.value.ratings)
    ? strRes.value : null;

  /** trajectory_adj insight for an id (ai_insights first, else history). */
  function trajFor(id) {
    if (aiPlayersMap && aiPlayersMap[id] && aiPlayersMap[id].trajectory_adj) {
      return aiPlayersMap[id].trajectory_adj;
    }
    if (historyMap && historyMap[id] && historyMap[id].trajectory) return historyMap[id].trajectory;
    return null;
  }
  /** Signed trend magnitude for sorting (ai value, else slope, else 0).
   * Memoized: the sort comparator calls this O(n log n) times per paint. */
  const _trendValCache = new Map();
  function trendVal(id) {
    if (_trendValCache.has(id)) return _trendValCache.get(id);
    const t = trajFor(id);
    let v = 0;
    if (t) {
      if (Number.isFinite(Number(t.value))) v = Number(t.value);
      else if (Number.isFinite(Number(t.slope_pts_per_yr))) v = Number(t.slope_pts_per_yr);
    }
    _trendValCache.set(id, v);
    return v;
  }

  // Finder + reco control state (REL2).
  let finderPos = 'ALL';      // ALL/QB/RB/WR/TE
  // R41 — rookies-only, rendered only when the nflverse flag exists in data
  // (unstamped pool = rookie status UNKNOWN; a filter over unknowns would show
  // an empty board, so the control hides — the PLAYERS tab does the same).
  const hasRookieFlag = players.some((p) => typeof p.rookie === 'boolean');
  let finderRookies = false;
  let finderSort = 'pts';     // pts | trend | bye
  let finderDir = 'desc';
  let recoSort = 'fit';       // fit (Best AI Pick / Best fit) | available (Best available)

  // Draft board (REL3): ids other managers have taken. Live-excluded from the
  // fit engine so recommendations always come from the REMAINING pool.
  const taken = loadTaken();
  let hideTaken = false;      // finder view: greyed (false) vs removed (true)

  /** The pool the fit engine sees: every projection MINUS the drafted-by-others
   * set. Rebuilt on demand so a TAKEN toggle re-optimizes immediately. */
  function availablePool() {
    // The fit engine's pool: minus drafted-by-others AND minus anyone taken in
    // the active draft room (sim rooms overlay without persisting) — the reco
    // panel re-ranks live as the draft consumes players.
    const overlay = roomTakenIds();
    if (taken.size === 0 && overlay.size === 0) return players;
    return players.filter((p) => {
      const id = String(p.gsis_id);
      return !taken.has(id) && !overlay.has(id);
    });
  }

  /* ---- Rel9.1: the draft room and the page lists are ONE system ------------- */

  function activeRoom() { return auction || draft; }

  /** gsis ids consumed by the active room, split mine/others. */
  function roomIdSplit() {
    const others = new Set();
    const mine = new Set();
    const room = activeRoom();
    if (room) {
      const rosters = auction ? auction.teams : draft.rosters;
      const mySlotIdx = room.mySlot - 1;
      rosters.forEach((tm, idx) => {
        for (const p of tm.players) {
          if (p.gsis_id) (idx === mySlotIdx ? mine : others).add(String(p.gsis_id));
        }
      });
    }
    return { others, mine };
  }

  function roomTakenIds() {
    const { others, mine } = roomIdSplit();
    for (const id of mine) others.add(id);
    return others;
  }

  /** Board index by gsis for the active room (selection from any list). */
  function roomBoardIdx() {
    const room = activeRoom();
    const map = new Map();
    if (room) {
      room.board.forEach((row, i) => {
        if (row.gsis_id && !room.taken.has(i)) map.set(String(row.gsis_id), i);
      });
    }
    return map;
  }

  /** Unified strength suffix for list rows while an auction runs: our $ vs
   * market $ plus the value-gap flag (same language as the nomination advisor). */
  function strengthSuffix(id) {
    if (!auction) return '';
    const fair = auction.fair.get(id);
    const mkt = auction.market.get(id);
    if (fair == null || mkt == null) return '';
    const cls = classifyNomination(fair, mkt);
    const flag = cls === 'TARGET' ? ' 🎯' : cls === 'BAIT' ? ' 🎣' : '';
    return ` <span class="cd-cash">$${Math.round(fair)}v$${Math.round(mkt)}${flag}</span>`;
  }

  /** The contextual draft action for a list row (finder/reco): NOM during my or
   * live nominations, TOOK when the live snake room is picking, PICK on my
   * snake turn. '' when the room state offers no action for this player. */
  function draftActionBtn(id) {
    const room = activeRoom();
    if (!room) return '';
    const bi = roomBoardIdx().get(id);
    if (bi == null) return '';
    if (auction) {
      if (auction.block) {
        return auction.block.boardIdx === bi
          ? '<span class="cd-onblock">BLOCK</span>' : '';
      }
      const mine = onTheNomination(auction) === auction.mySlot - 1;
      // R27 — the LIVE label is TOOK, not NOM. The action is identical (both
      // put the row on the block, and in LIVE the block renders the SOLD
      // TO / FOR / RECORD SALE controls), but the WORD was wrong for what a
      // manager is doing in a live room: they are not nominating, they are
      // recording what the real room just did. "NOM" reads as a bid you are
      // starting, so the price-and-buyer capture behind it — the thing that
      // teaches the opponent model — looked like it did not exist. TOOK is
      // already this app's word for it on the snake side.
      if (auction.play === 'live') {
        return `<button type="button" class="cand-add cand-took" data-act="auc-nom" data-bi="${bi}">TOOK</button>`;
      }
      if (mine) {
        return `<button type="button" class="cand-add" data-act="auc-nom" data-bi="${bi}">NOM</button>`;
      }
      return '';
    }
    if (draft.done) return '';
    const clock = onTheClock(draft);
    if (clock === draft.mySlot - 1) {
      return `<button type="button" class="cand-add" data-act="draft-pick" data-bi="${bi}">PICK</button>`;
    }
    if (draft.play === 'live') {
      return `<button type="button" class="cand-add cand-took" data-act="draft-live-take" data-bi="${bi}">TOOK</button>`;
    }
    return '';
  }

  // LIVE-mode persistence: ids this room wrote into taken/roster, so undo can
  // retract exactly what the room added and nothing the user set by hand.
  const syncedOthers = new Set();
  const syncedMine = new Set();

  /** Diff the LIVE room state into the persistent page state (idempotent, so
   * undo simply re-diffs): others' players -> TAKEN; my wins -> roster slots. */
  function syncLiveRoom() {
    const room = activeRoom();
    if (!room || room.play !== 'live') return;
    const { others, mine } = roomIdSplit();
    let changed = false;
    for (const id of others) {
      if (!taken.has(id)) { taken.add(id); syncedOthers.add(id); changed = true; }
    }
    for (const id of [...syncedOthers]) {
      if (!others.has(id)) { taken.delete(id); syncedOthers.delete(id); changed = true; }
    }
    const slotted = new Set(Object.values(roster.slots).filter(Boolean).map(String));
    for (const id of mine) {
      if (!slotted.has(id)) {
        const p = playersById.get(id);
        const slot = p ? firstEligibleOpenSlot(p.position) : null;
        if (slot) { roster.slots[slot] = id; syncedMine.add(id); changed = true; }
      }
    }
    for (const id of [...syncedMine]) {
      if (!mine.has(id)) {
        for (const [slot, sid] of Object.entries(roster.slots)) {
          if (String(sid) === id) { roster.slots[slot] = null; changed = true; }
        }
        syncedMine.delete(id);
      }
    }
    if (changed) { saveTaken(taken); saveRoster(roster); }
  }

  // DRAFT SIMULATOR (Rel6). ADP board = the market; our picks = VOR + survival
  // lookahead; beat-the-room margin = the benchmark. Three rooms (ADP, SHARK,
  // AI+) choose who the opponents are. Every finished draft and auction is
  // stored through app/mocks.js as HISTORY; only a LIVE room — where the
  // manager taps what the real room took — is admissible as calibration
  // evidence. Absent adp.json (older deploy) hides the whole section.
  const adpDoc = (adpRes.status === 'fulfilled' && adpRes.value
    && Array.isArray(adpRes.value.players) && adpRes.value.players.length > 50)
    ? adpRes.value : null;
  let draft = null;          // snake draft state (createDraft) or null
  let draftResult = null;    // scoreVsRoom sheet after a finished snake draft
  let auction = null;        // auction room state (createAuction) or null
  let auctionResult = null;  // scoreAuction sheet after a finished auction
  let bidAdj = 0;            // my +/- adjustment to the advised bid, per block
  /* R27, rewritten R34 — the observed sale price is TYPED, MANDATORILY. The
   * field starts EMPTY on every block (our estimate appears only as
   * PLACEHOLDER text — the owner's explicit rule: never prefilled), and the
   * -/+ chips nudge a price only once one has been typed. soldBuyer is the
   * matching mandatory buyer selection. Both cleared whenever the block
   * changes (resetSoldEntry), so nothing from the last player carries over. */
  let soldTyped = null;   // typed price, or null = nothing typed yet
  let soldBuyer = null;   // selected buyer seat (0-based), or null = none picked
  function resetSoldEntry() { soldTyped = null; soldBuyer = null; }
  // A LIVE sale sellTo() refused (buyer's roster already full). Held so the
  // block zone can say WHY nothing happened instead of repainting unchanged.
  // Cleared at the top of every action, so it lives exactly one paint.
  let aucRefusal = '';
  // LIVE snake-draft tap list: the manager's name filter over the WHOLE board.
  let liveTakeQuery = '';
  // LEAGUE PROFILE (R19-B3). The saved profile is the durable half of this
  // config: it survives the reload that the in-memory literal never did, and
  // it is what the SAVE button below writes. Everything the profile does not
  // describe (my slot, snake vs auction, sim vs live, budget) stays session
  // state — those are how I am playing the room, not what my league IS.
  let savedProfile = loadProfile();
  let stagedProfile = cloneProfile(savedProfile); // name/scoring/caps, editable by import
  const seeded = cfgFromProfile(savedProfile);
  let carriedTokens = seeded.carried;             // K/DEF/DST — kept, not draftable
  let clampedNotes = seeded.clamped;              // counts ROSTER_BOUNDS pulled in
  const draftCfg = {
    leagueSize: 12, mySlot: 5, roomType: 'adp', mode: 'snake', play: 'sim',
    budget: DEFAULT_BUDGET, ...DEFAULT_ROSTER,
    flexType: 'FLEX', keepers: false, maxKeepers: 0,
    // R27 — per-team STARTING dollars. null means "every team holds `budget`",
    // the overwhelmingly common case, so the setup card stays uncluttered for
    // leagues that never trade money. It becomes a leagueSize-length array only
    // once a team is edited. Preseason trades of auction dollars are a real
    // house rule the room could not express: a team you KNEW had $185 was
    // modelled at $200, and every threat estimate built from its maxBid was
    // wrong for the rest of the draft.
    teamBudgets: null,
    ...seeded.cfg,
  };
  if (draftCfg.mySlot > draftCfg.leagueSize) draftCfg.mySlot = draftCfg.leagueSize;

  /* R34 — budgets + names come back from storage (nfl2026.auctionteams.v1).
   * Until R34 the per-team budgets were session-only and silently reverted to
   * a level room on every reload; persisting them is also what makes RESTART
   * SESSION's "keeps per-team budgets and names" true, since RESTART re-mounts
   * this view. Length drift (a stored 12-team array under a 10-team league) is
   * already handled at use: effectiveTeamBudgets()/auctionTeamName() read by
   * index and fall back per seat. */
  const storedAucTeams = loadAuctionTeams();
  if (storedAucTeams.budgets) draftCfg.teamBudgets = storedAucTeams.budgets;
  /** Owner-typed team names, seat-indexed; '' = not typed (fallbacks apply). */
  let teamNames = storedAucTeams.names || [];
  function persistAuctionTeams() {
    saveAuctionTeams({ budgets: draftCfg.teamBudgets, names: teamNames });
  }
  /** Seat i's display identity under the R34 precedence (typed > sleeper >
   * default). rosterTeams is session state, so Sleeper names appear only
   * after a sync this visit — exactly "when the roster sync has them". */
  function seatName(i) {
    return auctionTeamName(i, {
      typedNames: teamNames,
      sleeperTeams: rosterTeams,
      leagueSize: draftCfg.leagueSize,
    });
  }
  /** Seat label for the auction surfaces. My seat KEEPS the YOU marker: a
   * typed/synced name joins it, never replaces it. Index-keyed display only —
   * duplicate names stay unambiguous because nothing ever looks up BY name. */
  function seatLabel(i, mySlot) {
    const me = i === mySlot - 1;
    const n = seatName(i);
    if (!me) return n.name;
    return n.source === 'default' ? 'YOU' : `${n.name} · YOU`;
  }

  /* R34 — the stashed (saved-not-applied) league, cached for the mount: only
   * this view's own actions move it — RESTART and RESET ALL re-mount, and
   * RE-APPLY (in place since R52) leaves the stash itself untouched; its strip
   * hides because the stash then equals the applied profile. */
  const stashedLeague = loadStashedProfile();

  /* R27 — the roster totals the settings card reports.
   *
   * These were hand-rolled sums of qb+rb+wr+te+flex(+bench) in two places, and
   * both silently excluded K and DEF. Once those became real seats, an
   * Omilia-shaped league (9 starters + 4 bench) reported "7 STARTERS + 4 BENCH
   * · 11 ROUNDS" while the room it launched actually ran the correct 13 — the
   * card was describing a league the app was not simulating. Both numbers now
   * come from the SAME shape builder the room itself uses, which is what keeps
   * the two from drifting apart again. */
  function starterSlotCount() {
    return rosterShape(draftCfg).starters.length;
  }
  function rosterSlotCount() {
    return rosterShape(draftCfg).size;
  }

  /* The per-team starting budgets as exactly leagueSize numbers, whether or not
   * the manager ever opened the editor. `null` (nobody touched it) and a stale
   * array from a larger league both resolve to the league default, so changing
   * TEAMS after editing budgets can never leave a team with no money or invent
   * one that does not play. */
  function effectiveTeamBudgets() {
    return normalizeTeamBudgets(draftCfg.teamBudgets, draftCfg.leagueSize, draftCfg.budget);
  }


  // League-settings panel state (all of it survives a paintDraft() repaint).
  let leagueStatus = leagueFlash;   // {tone, lines} — one-shot across a re-mount
  leagueFlash = null;
  let importReport = null;          // report from the last Sleeper import
  let importLines = [];             // summarizeImport() plain-language lines
  let importUnresolved = [];        // unresolvedItems() — the honesty list
  let importProfile = null;         // the profile that import produced
  // R48 — seeded from the remembered league (R47 saves it on every sync). The
  // R47 remount after SYNC NOW used to reset this to '' and SYNC ROSTER then
  // refused with "enter your league id first" — the owner's RCA.
  let sleeperId = loadLeagueId() || '';  // league id / URL typed into the sync field
  let pasteText = '';               // pasted league JSON
  let pasteOpen = false;            // <details> disclosure state
  let syncBusy = false;             // a SYNC NOW request is in flight
  // ROSTER SYNC (R20-B4). All of it is session state: the roster itself is the
  // only thing that ever gets written, and only on a deliberate confirm.
  let sleeperIndex = null;          // the loader's built index, held for buildRosterPlan/companion
  let indexProgress = '';           // R52 — the sync banner's player-list progress line
  /** Bytes as a one-decimal MB string for the progress line. */
  const mb = (bytes) => `${(Number(bytes) / 1048576).toFixed(1)} MB`;
  let companion = null;             // R33 — the live Sleeper draft companion, when armed
  let rosterTeams = null;           // importSleeperTeams().teams, or null before a sync
  let rosterTeamIdx = -1;           // which team in that list is mine
  let rosterCross = null;           // crosswalkRoster() output for that team
  let rosterMissed = [];            // unmatchedRosterPlayers(rosterCross)
  let rosterPlan = null;            // planRosterSync() output — what WOULD happen
  let rosterStatus = null;          // {tone, lines} for the roster panel alone
  let rosterBusy = false;           // a SYNC ROSTER request is in flight
  let rosterArmed = false;          // two-step confirm before an overwrite
  let rosterApplied = false;        // the plan on screen has already been written
  // Live strategy dials (auction) — flipping any re-plans the room in place.
  const strategy = { style: 'balanced', tempo: 'patient', enforce: true };
  let restartArmed = false;  // two-step RESTART SESSION confirm (R34)
  let wipeArmed = false;     // two-step RESET ALL confirm (R34)
  let histArmed = false;     // two-step confirm before wiping draft history

  /* ---- R23-S1: draft history + LIVE-room calibration -------------------------
   *
   * The records this page writes used to be described as a refit input: the
   * result card claimed a completed mock taught the fit engine something.
   * Nothing read them at all. app/mocks.js is now the only owner of that
   * storage (including the read-only migration off the old key), and the copy
   * below says exactly what the records do: SIM rooms are history (their
   * opponents ARE this app's own sampler, so measuring them would measure the
   * model that produced them), LIVE rooms are a transcript of a real room and
   * calibrate how far from consensus ADP it drafts.
   *
   * migrateLegacy() runs on every mount, so a manager who never drafts again
   * still sees the mocks they already ran. It is idempotent and never deletes
   * the old key.
   */
  migrateLegacy();
  let mockHistory = loadHistory();
  let mockCal = roomCalibration(mockHistory);

  /** Re-read history after a write, so the panel and `gone by` never go stale. */
  function refreshHistory() {
    mockHistory = loadHistory();
    mockCal = roomCalibration(mockHistory);
  }

  /** id -> adjusted season points at the CURRENT scoring mode (draft pricing). */
  function adjPointsMap() {
    return new Map(players.map((p) => {
      const id = String(p.gsis_id);
      return [id, adjById.get(id) || 0];
    }));
  }

  /* The two ingredients the AI+ room needs to value a player under YOUR
   * scoring table instead of the page's scoring MODE (see draft-sim.js
   * leagueSeasonPoints): the full-PPR season total the projection ships, and
   * the prior-season reception count the weekly feed carries. Both are the
   * same numbers scoringAdjust() already converts with — no new source, no
   * market term. Built only when an AI+ draft starts; the other two rooms
   * never call them and their board is byte-for-byte unchanged. */
  function pprPointsMap() {
    return new Map(players.map((p) => [String(p.gsis_id), p.proj_points]));
  }
  function receptionsMap() {
    const out = new Map();
    players.forEach((p) => {
      const id = String(p.gsis_id);
      const e = weeklyById.get(id);
      if (e && Number.isFinite(Number(e.receptions_prior))) {
        out.set(id, Number(e.receptions_prior));
      }
    });
    return out;
  }

  /* R52 — the profile-derived state, (re)assigned from deriveLeagueState() so
   * a profile adopted mid-mount (SYNC NOW, RE-APPLY, SAVE) rebuilds exactly
   * what a fresh mount builds. The OURS price memo is keyed on shape and money
   * only (see ourDollarsById), so it is dropped here too — the R30c lesson. */
  const kdstDoc = kdstRes.status === 'fulfilled' ? kdstRes.value : null;
  let weeklyById; let kdstSeatTokens; let kdstRows; let seatable; let playersById;
  let adjById; let scaledById; let sortedPlayers; let sortedKdst; let kdstChips;
  let kdstUnresolvedSlots; let roster;
  let _ourDollars = null;
  let _ourDollarsKey = '';
  function applyLeagueState() {
    const d = deriveLeagueState({ savedProfile, players, weeklyBase, kdstDoc, mode });
    ({ weeklyById, kdstSeatTokens, kdstRows, seatable, playersById, adjById, scaledById,
      sortedPlayers, sortedKdst, kdstChips, kdstUnresolvedSlots, roster } = d);
    _ourDollars = null;
    _ourDollarsKey = '';
  }
  applyLeagueState();
  let selectedSlot = null; // empty slot targeted for recommendations
  let query = '';

  /* ---- R20-B4: MARKET auction value beside our own dollars ------------------
   *
   * data/adp.json carries ESPN's average winning bid (`auction_value`, kona
   * ownership.auctionValueAverage) on a published board. It is a MARKET PRICE:
   * DISPLAY ONLY, and a value FLAG — am I paying over or under the room. It is
   * never an input to a projection, a weight or a sort order, and nothing below
   * feeds it back into adjById, the fit engine or the profile. The policy is
   * enforced mechanically on the data side by validate_data.py
   * MARKET_PRICE_FIELDS; here it is enforced by the code simply never reading
   * it anywhere except the display cell.
   */

  /** app id -> ESPN auction value, as published (absent = unpriced, NOT $0). */
  const mktValueById = new Map();
  /** The budget ESPN's board is denominated in, or null when unpublished. */
  const mktBudget = adpDoc && Number.isFinite(Number(adpDoc.auction_budget))
    && Number(adpDoc.auction_budget) > 0
    ? Number(adpDoc.auction_budget)
    : null;
  if (adpDoc) {
    adpDoc.players.forEach((r) => {
      const id = r && r.gsis_id != null ? String(r.gsis_id) : null;
      const v = Number(r && r.auction_value);
      if (id && Number.isFinite(v) && v > 0) mktValueById.set(id, v);
    });
  }

  /**
   * OUR dollars for the board: value over replacement from OUR projections,
   * allocated across the league (app/auction.js fairDollars). While an auction
   * room is open we use that room's own `fair` map so one page never shows two
   * different prices for the same player.
   */
  function ourDollarsById() {
    if (!adpDoc) return null;
    if (auction && auction.fair) return auction.fair;
    // R27 — the cache key carries the room's TOTAL money, not just the league
    // default, or an uneven room would keep serving prices computed for a level
    // one. (Level rooms produce the same total as before, so the key is stable
    // for every league that never touches the editor.)
    const roomMoney = effectiveTeamBudgets().reduce((s, b) => s + b, 0);
    // R30c — the key is DERIVED from the same shape fairDollars prices with,
    // not hand-listed per field. The hand-written key spelled out qb..bench and
    // omitted k/def, so the K and DEF steppers repainted a board whose OURS
    // dollars were still priced for the 0-K/0-DEF shape (18 of 182 rows $1-$2
    // off until an unrelated keyed field moved). Joining shape.starters +
    // bench count means a future ROSTER_BOUNDS slot type cannot be forgotten
    // the same way — it lands in starters, so it lands in the key.
    const shape = rosterShape(draftCfg);
    const key = `${draftCfg.leagueSize}|${draftCfg.budget}|${roomMoney}|`
      + `${shape.starters.join(',')}|${shape.bench.length}`;
    if (_ourDollars && _ourDollarsKey === key) return _ourDollars;
    const rows = adpDoc.players.filter((r) => r && r.gsis_id);
    const adjOf = (r) => {
      const v = adjById.get(String(r.gsis_id));
      return Number.isFinite(v) ? v : 0;
    };
    _ourDollars = fairDollars(rows, adjOf, draftCfg.leagueSize, draftCfg.budget,
      shape, roomMoney);
    _ourDollarsKey = key;
    return _ourDollars;
  }

  /**
   * R27 — the ROOM's board: the ADP board, plus this league's K/DST when it
   * actually seats them.
   *
   * The board was adpDoc.players, which is QB/RB/WR/TE by contract — K and DST
   * live in their own feed precisely so they do not evict ~74 offensive players
   * from the projected cut. The consequence was that a league with a K1 and a
   * DEF1 could seat a kicker on this page and find one in the finder, but the
   * DRAFT ROOM had no kicker on the board to draft, in either format.
   *
   * They are appended AFTER the offensive rows, so they sit at the end of the
   * board by construction — which is both where ADP would put them and the
   * "late-round, $1 tier" the owner chose. auction.js fairDollars floors them
   * at MIN_BID (see the note there), so adding them cannot move the price of a
   * single offensive player.
   *
   * A league that seats no K/DEF gets `kdstRows.length === 0` and therefore the
   * exact array the room has always been given.
   */
  function roomBoardRows({ excludeTaken = true } = {}) {
    const offence = excludeTaken
      ? adpDoc.players.filter((pp) => !taken.has(String(pp.gsis_id)))
      : adpDoc.players;
    const seats = (draftCfg.k > 0 ? 1 : 0) + (draftCfg.def > 0 ? 1 : 0);
    if (!seats || !kdstRows.length) return offence;
    const extra = excludeTaken
      ? kdstRows.filter((r) => !taken.has(String(r.gsis_id)))
      : kdstRows;
    return offence.concat(extra);
  }

  /**
   * R27 — my auction ceiling for the RECO panel, or null when money is not a
   * constraint (snake draft, or no room open).
   *
   * The cap is auction.js maxBid(), the SAME number the block's guidance and
   * every threat estimate already use — one definition of "the most I can
   * commit to one player", which reserves $1 for each of my other open slots.
   * Prices are OUR dollars (the open room's `fair` map), not the market's: the
   * panel advises what I should do, and our own valuation is the app's answer
   * to that. Market price stays display-only, per the standing rule.
   *
   * R34 RCA — this is the ONLY draftCfg.mode consumer that changes what the
   * panels SHOW (every other read is a label or a settings-card branch), and
   * it is a FILTER, not a re-score: team-logic's affordableOnly() drops rows
   * priced above my cap and leaves every surviving row's points/VOR
   * byte-identical (locked by tests/feature/r34_reset_theme.test.mjs). It is
   * also null unless an auction ROOM is open — flipping the FORMAT select
   * alone changes no list at all.
   */
  function recoBudget() {
    if (!auction || draftCfg.mode !== 'auction') return null;
    const me = aucMyTeam(auction);
    if (!me) return null;
    const open = auction.shape.size - me.players.length;
    const priceById = auction.fair instanceof Map ? auction.fair : null;
    if (!priceById) return null;
    return { cap: maxBid(me.budget, open), priceById };
  }

  /** Whole dollars; a real price under $1 reads "<$1" so it never says free. */
  const money = (n) => (Math.round(Number(n)) < 1 ? '<$1' : `$${Math.round(Number(n))}`);

  /**
   * OURS vs the MARKET for one player, with the over/under flag. Returns '' when
   * we have neither number — an absent cell is the honest rendering of "no
   * price", and an em dash is used only when one of the two exists.
   *
   * When your budget differs from the board ESPN published, the market price is
   * restated in YOUR dollars (a linear rescale of the same number) and the title
   * says so; when ESPN publishes no budget at all the flag is withheld, because
   * two prices in unknown denominations cannot be compared.
   */
  function valueCell(id) {
    if (!adpDoc) return '';
    const ourMap = ourDollarsById();
    const oursRaw = ourMap ? ourMap.get(id) : null;
    const mktRaw = mktValueById.has(id) ? mktValueById.get(id) : null;
    const scale = mktBudget ? draftCfg.budget / mktBudget : null;
    const mkt = mktRaw != null && scale != null ? mktRaw * scale : mktRaw;
    const haveOurs = Number.isFinite(oursRaw) && oursRaw > 0;
    const haveMkt = Number.isFinite(mkt) && mkt > 0;
    if (!haveOurs && !haveMkt) return '';

    let flag = '';
    if (haveOurs && haveMkt && scale != null) {
      const cls = classifyNomination(Math.round(oursRaw), Math.round(mkt));
      if (cls === 'BAIT') {
        flag = '<span class="cv-flag cv-flag--over" '
          + 'title="The room pays more than we would — buying at that price is an overpay '
          + 'against our own valuation.">OVER</span>';
      } else if (cls === 'TARGET') {
        flag = '<span class="cv-flag cv-flag--under" '
          + 'title="We value this player above what the room pays — buying at that price is '
          + 'a discount against our own valuation.">UNDER</span>';
      } else {
        flag = '<span class="cv-flag cv-flag--fair" '
          + 'title="Our price and the room\'s are within a few dollars of each other.">'
          + 'FAIR</span>';
      }
    }

    const oursTxt = haveOurs
      ? `OURS ${money(oursRaw)} is this app's own price: value over replacement from our `
        + `projections, spread over ${draftCfg.leagueSize} teams at $${draftCfg.budget}.`
      : 'OURS is blank: this player is not on the board we price.';
    const mktTxt = haveMkt
      ? `AUC ${money(mkt)} is the MARKET's price — ESPN's average winning bid`
        + (mktBudget
          ? (scale === 1
            ? `, published on a $${mktBudget} board.`
            : `, published as $${Math.round(mktRaw)} on a $${mktBudget} board and restated `
              + `here in your $${draftCfg.budget}.`)
          : ', on a board whose budget ESPN does not publish — so no over/under flag is '
            + 'shown.')
      : 'AUC is blank: ESPN publishes no auction value for this player. That is a missing '
        + 'price, not a price of zero.';
    const title = `${oursTxt} ${mktTxt} The market price is shown for comparison only: it is `
      + 'never an input to a projection, a weight, or this list\'s order.';

    return (
      `<span class="cd-val" title="${esc(title)}">`
        + '<span class="cv-lbl">OURS</span>'
        + (haveOurs
          ? `<span class="cv-us">${esc(money(oursRaw))}</span>`
          : '<span class="cv-us cv-none">—</span>')
        + '<span class="cv-lbl">AUC</span>'
        + (haveMkt
          ? `<span class="cv-mkt">${esc(money(mkt))}</span>`
          : '<span class="cv-mkt cv-none">—</span>')
        + flag
      + '</span>'
    );
  }

  /** The one DISPLAY-ONLY badge this app uses, verbatim (app/views/model.js). */
  const MARKET_BADGE =
    '<span class="ms-badge" title="Market prices are never weighted into '
    + 'predictions (user policy)">MARKET · DISPLAY ONLY</span>';

  /* R30b — the AUC sentence must match what the cells beside it actually
   * show. valueCell() rescales ESPN's bid into the user's budget, and the
   * unconditional "AUC = ESPN's average winning bid" made the visible key
   * contradict every rescaled cell under it — with the correction living only
   * in a hover title an iPad cannot reach. One string, built from the same
   * two inputs the rescale reads, used by the shell legend and the BEST PICK
   * strip alike. */
  function valueLegendText() {
    return 'OURS = our auction price (VOR). '
      + aucLegendAucText(draftCfg.budget, mktBudget)
      + 'OVER / UNDER = are you paying above or below the room.';
  }

  /** Column key for the value cell — one per section, never one per row. */
  function valueLegendHtml() {
    if (!adpDoc) return '';
    return (
      '<div class="cd-vallegend">'
        + `<span class="cvl-txt">${esc(valueLegendText())}</span>`
        + MARKET_BADGE
      + '</div>'
    );
  }

  /* ---- static shell -------------------------------------------------------- */

  const season = projRes.value.season != null ? projRes.value.season : '';
  el.innerHTML =
    '<header class="view-head">' +
      '<h1 class="view-title">TEAM BUILDER</h1>' +
      `<span class="view-sub">${esc(season)} · ${mode.toUpperCase()} SCORING · ESTIMATE</span>` +
    '</header>' +
    renderLegend() +
    '<div class="team-toolbar">' +
      (aiInsights ? renderAiSeg(aiOn) : '') +
      /* R34 — the single RESET is now TWO buttons, each saying plainly what it
       * does (the titles are the owner's spec, verbatim). Both keep the
       * two-tap arm/confirm pattern; arming one disarms the other, and any
       * other action disarms both (see onAction). RESTART SESSION arms in the
       * brand tone (it keeps the synced league + history); RESET ALL is the
       * red, destructive factory wipe. */
      '<button type="button" class="sort-chip reset-btn reset-btn--session" data-act="restart-session" ' +
        'title="Clears the board, rosters and scoring back to standard PPR. Your synced league ' +
        'stays saved — RE-APPLY brings it back in one tap.">RESTART SESSION</button>' +
      '<button type="button" class="sort-chip reset-btn reset-btn--all" data-act="reset-all" ' +
        'title="Erases everything: league sync, budgets, team names, draft history and room ' +
        'memory. Cannot be undone.">RESET ALL</button>' +
    '</div>' +
    // Two-column grid on wide screens (iPad 13"): builder column (roster +
    // finder + reco) beside the summary. On phones it is a single column.
    '<div class="team-grid">' +
      '<div class="team-col team-col--build">' +
        '<section class="draftsim" id="t-draft" aria-label="Draft simulator"></section>' +
        // R48b — the Sleeper sync's NEXT STEP and RESULT live right above the
        // roster they act on, not inside the settings card far below (owner
        // RCA: "picked a team, it went to show the league data instead").
        '<div id="t-syncbar" aria-live="polite"></div>' +
        // R30c — role="list", NOT listbox. The old listbox/option markup
        // announced "Roster slots, list box, 13 items" — a selectable widget —
        // while nothing responded to arrow keys, the container was not
        // focusable, and every filled slot read "not selected". Selection here
        // is actually driven by the buttons INSIDE each slot (ADD / remove),
        // so the honest semantics are a plain list whose interactive children
        // keep their own roles; the targeted-slot state lives on the ADD
        // button as aria-pressed. Deliberately not a full ARIA listbox.
        '<section class="roster" id="t-roster" role="list" aria-label="Roster slots"></section>' +
        '<section class="finder" aria-label="Player finder">' +
          '<input class="finder-input" id="t-find" type="search" autocomplete="off" ' +
            'placeholder="SEARCH NAME · TEAM · POS" aria-label="Search player pool">' +
          '<div class="finder-controls">' +
            `${finderPosRow(finderPos, kdstChips)}${finderSortRow(finderSort, finderDir)}` +
            (hasRookieFlag
              ? `<label class="rookie-filter"><input type="checkbox" id="t-rookies-only"${finderRookies ? ' checked' : ''} /> <span>ROOKIES ONLY</span></label>`
              : '') +
            `<button type="button" class="sort-chip taken-toggle" data-act="taken-filter" aria-pressed="false">${hideTaken ? 'SHOW TAKEN' : 'HIDE TAKEN'}</button>` +
          '</div>' +
          valueLegendHtml() +
          '<div id="t-cands"></div>' +
        '</section>' +
      '</div>' +
      '<div class="team-col team-col--side">' +
        '<section class="reco" id="t-reco" aria-label="Fit engine recommendations"></section>' +
        '<section class="team-summary" id="t-summary" aria-label="Team summary"></section>' +
      '</div>' +
    '</div>';
  shell = el.querySelector('#t-syncbar');

  /* ---- section painters ----------------------------------------------------- */

  /** The slot ids this league actually has, in draft order. */
  function slotOrder() {
    return rosterSlots(savedProfile).all;
  }

  /** First open slot (starters before bench) this position may occupy. */
  function firstEligibleOpenSlot(position) {
    return firstOpenSlot(position, roster.slots, savedProfile);
  }

  /**
   * The badges a seated K/DST row must wear — the same ones the Lineup card
   * uses, for the same reasons, so the marking does not stop at a tab boundary.
   *
   *   SEASON      the K/DST contract carries SEASON totals with no weekly split
   *               and no opponent adjustment. Every other number in this list is
   *               a season projection too, so the badge is about the ABSENCE of
   *               a weekly breakdown behind it, which the slot chip relies on.
   *   LOW SAMPLE  the contract's own flag: few games behind the projection.
   *   PARTIAL     this league's scoring table pays for components the feed
   *               cannot supply, so the total is INCOMPLETE. Marked with a '*'
   *               on the number as well, because an unmarked incomplete figure
   *               looking exactly like a complete one is the whole hazard.
   */
  function kdstTags(p) {
    const e = p && p.kdst;
    if (!e) return '';
    let out = ' <span class="lu-tag" title="A season projection scored under YOUR league&#39;s '
      + 'table. There is no weekly split and no opponent adjustment for this position.">SEASON</span>';
    if (e.lowSample) {
      out += ' <span class="lu-tag lu-tag--warn" title="Few games behind this projection.">LOW SAMPLE</span>';
    }
    if (e.partial) {
      const names = e.omitted.map((o) => o.label).join(', ');
      out += ` <span class="lu-tag lu-tag--warn" title="${esc(`This total is INCOMPLETE — it omits: ${names}`)}">PARTIAL</span>`;
    }
    return out;
  }

  function paintRoster() {
    const rows = slotOrder().map((slot) => {
      const pos = slot.replace(/\d+$/, ''); // QB1 -> QB, BN3 -> BN
      const id = roster.slots[slot];
      let body;
      if (!id) {
        const label = pos === 'BN' ? 'BENCH' : pos;
        // aria-pressed carries the "fit engine is aiming here" state the old
        // aria-selected pretended to: it sits on the control that actually
        // toggles it, so AT announces it where the interaction happens (R30c).
        const sel = selectedSlot === slot;
        body =
          `<button type="button" class="slot-empty" data-act="pick" data-slot="${slot}" ` +
            `aria-pressed="${sel ? 'true' : 'false'}">` +
            `ADD ${label}</button>`;
      } else if (!playersById.has(id)) {
        // R30b — a RETAINED id (see kdstUnresolvedSlots): the saved K/D-ST is
        // kept while its feed is down, and the seat says so instead of
        // reverting to an ADD button that pretends nothing was ever here. No
        // name or number can be shown — the feed is the only source of both —
        // so the seat states the feed failure and offers exactly one action,
        // the user's own REMOVE.
        body =
          `<div class="slot-player" role="button" tabindex="0" data-act="remove" data-slot="${slot}" ` +
            `aria-label="Remove the saved ${esc(pos)} from ${slot}">` +
            '<span class="sp-main">' +
              `<span class="sp-name">SAVED ${esc(pos)} · FEED UNAVAILABLE</span>` +
              '<span class="sp-pts">—</span>' +
            '</span>' +
            '<span class="sp-meta"><span class="lu-tag lu-tag--warn" ' +
              'title="The K/D-ST projections feed did not load this visit. Your saved player ' +
              'is kept and comes back with the feed; nothing removes it but you.">' +
              'K/D-ST projections did not load — kept, not counted. Tap to remove.</span></span>' +
          '</div>';
      } else {
        const p = playersById.get(id);
        const e = weeklyById.get(id);
        const arr = scaledById.get(id);
        // wk-pts chip: this week's estimate, "BYE" on the bye, season pts if
        // the player somehow lacks weekly data (defensive — ids should mirror).
        const onBye = e && e.weeks && e.weeks[currentWk - 1] && e.weeks[currentWk - 1].bye === true;
        // A seated K/DST has no weekly split at all, so the chip states the
        // season total and says SZN — never a week number it cannot support.
        // The '*' marks a total this league's scoring makes INCOMPLETE.
        const ptsTxt = onBye
          ? `BYE · W${currentWk}`
          : arr
            ? `${fix1(arr[currentWk - 1])} · W${currentWk}`
            : `${fix1(adjById.get(id))}${p.kdst && p.kdst.partial ? '*' : ''} · SZN`;
        // REL3: the slot line now carries the SAME context the finder shows —
        // trend arrow, strength-of-schedule, and the player's bye week — so an
        // added player is never just a bare "W1" number.
        const tl = trendLabel(trajFor(id));
        const trendTxt = tl && tl.dir !== 'flat'
          ? `<span class="sp-trend cd-trend--${tl.dir}" title="5-yr ${tl.dir === 'up' ? 'up' : 'down'} trend">${tl.dir === 'up' ? '▲' : '▼'}</span>`
          : '';
        const sos = teamStrength ? strengthOfSchedule(e, teamStrength) : null;
        const sosTxt = sos != null ? `<span class="sp-sos" title="Strength of schedule 1-5">SoS ${fix1(sos)}</span>` : '';
        const bw = byeOf(id);
        const byeTxt = bw != null ? `<span class="sp-bye" title="Bye week">BYE W${bw}</span>` : '';
        const tags = kdstTags(p);
        const meta = (trendTxt || sosTxt || byeTxt || tags)
          ? `<span class="sp-meta">${trendTxt}${sosTxt}${byeTxt}${tags}</span>`
          : '';
        body =
          `<div class="slot-player" role="button" tabindex="0" data-act="remove" data-slot="${slot}" ` +
            `aria-label="Remove ${esc(p.name)} from ${slot}">` +
            '<span class="sp-main">' +
              `<span class="sp-name"><span class="sp-ab" style="color:${tint(p.team)}">${esc(p.team)}</span> ${esc(p.name)}</span>` +
              `<span class="sp-pts">${esc(ptsTxt)}</span>` +
            '</span>' +
            meta +
          '</div>';
      }
      // R30c — listitem, not option (see the shell comment at #t-roster). The
      // visual highlight stays on .slot--active; the announced state moved to
      // the ADD button's aria-pressed above, because only an empty slot ever
      // had a "selected" state and role="option" told AT every filled slot
      // was an unselectable "not selected" entry.
      const sel = selectedSlot === slot && !id;
      return (
        `<div class="slot${sel ? ' slot--active' : ''}" role="listitem" data-slot="${slot}">` +
          `<span class="slot-pos">${pos}</span>${body}` +
        '</div>'
      );
    });
    // R48-D — a league that fields no K slot says so where the slot would be,
    // instead of leaving "where is my kicker" unanswered.
    const noK = !rosterPositionsInPlay(savedProfile).includes('K');
    const noKNote = noK
      ? '<div class="roster-note" role="note">This league fields no K slot — no kicker is '
        + 'seated or scored here.</div>'
      : '';
    el.querySelector('#t-roster').innerHTML = rows.join('') + noKNote;
  }

  // Per-id derived-value memo caches. weekly / teamStrength / history are static
  // for the life of the mount, so these values never change once computed —
  // caching removes the repeated work paintCands does every paint (and, for the
  // sort comparators, O(n log n) recomputations per paint of the SAME value).
  const _byeCache = new Map();
  const _sosCache = new Map();

  /** Bye week for an id (from weekly data), or null. Memoized. */
  function byeOf(id) {
    if (_byeCache.has(id)) return _byeCache.get(id);
    const e = weeklyById.get(id);
    const v = e ? byeWeek(e) : null;
    _byeCache.set(id, v);
    return v;
  }

  /** Strength-of-schedule for an id, or null. Memoized. */
  function sosOf(id) {
    if (_sosCache.has(id)) return _sosCache.get(id);
    const v = teamStrength ? strengthOfSchedule(weeklyById.get(id), teamStrength) : null;
    _sosCache.set(id, v);
    return v;
  }

  function paintCands() {
    const box = el.querySelector('#t-cands');
    // R30c — same focus preservation as paintDraft (see draftFocusKey there):
    // the TAKE toggle is rebuilt by the very press that toggles it, so without
    // this a keyboard user lost their place in the finder on every mark.
    const focusKey = draftFocusKey(box);
    // R30b — the finder's legend sits in the ONE-SHOT shell, but its AUC
    // sentence depends on draftCfg.budget (see valueLegendText). Every path
    // that reprices the cells calls paintCands, so syncing the ≤2 legend
    // spans here keeps the visible key in lock-step with the numbers under
    // it, at the cost of two textContent writes per paint.
    el.querySelectorAll('.cd-vallegend .cvl-txt').forEach((s) => {
      s.textContent = valueLegendText();
    });
    const q = query.trim().toLowerCase();
    const rostered = new Set(Object.values(roster.slots).filter(Boolean));
    // WHICH POOL. K/DST are seatable but are not draft-board material (see the
    // seating block above), so they never pad the unfiltered best-available
    // list. They appear when the user asks for them by chip, when a search
    // could otherwise silently fail to find a kicker he typed the name of, or
    // when the slot he tapped is a K/DEF slot.
    const slotWantsKdst = selectedSlot
      && !roster.slots[selectedSlot]
      && kdstRows.some((p) => slotAccepts(p.position, selectedSlot, savedProfile));
    const pool = kdstChips.includes(finderPos)
      ? sortedKdst
      : ((q || slotWantsKdst) && sortedKdst.length
        ? sortedPlayers.concat(sortedKdst)
        : sortedPlayers);
    let hits = pool.filter((p) => {
      const pid = String(p.gsis_id);
      if (rostered.has(pid)) return false;
      if (hideTaken && taken.has(pid)) return false; // hide-taken view removes them
      if (finderPos !== 'ALL' && String(p.position).toUpperCase() !== finderPos) return false;
      if (finderRookies && p.rookie !== true) return false;
      if (!q) return true;
      return `${p.name} ${p.team} ${p.position}`.toLowerCase().includes(q);
    });

    // Sort by the active finder key + direction. Default 'pts' matches the
    // pre-sorted best-available order; 'trend' and 'bye' re-order in place.
    // Every comparator fully breaks ties on gsis_id so paints are reproducible.
    const dirMul = finderDir === 'asc' ? -1 : 1;
    hits = hits.slice().sort((a, b) => {
      const ida = String(a.gsis_id);
      const idb = String(b.gsis_id);
      let d;
      if (finderSort === 'trend') {
        d = trendVal(idb) - trendVal(ida);
      } else if (finderSort === 'bye') {
        // Sort by bye week number; players without a bye sink to the end.
        const ba = byeOf(ida);
        const bb = byeOf(idb);
        const va = ba == null ? Infinity : ba;
        const vb = bb == null ? Infinity : bb;
        // 'desc' shows latest bye first; asc shows earliest. Infinity stays last
        // on desc by special-casing so "no bye" never floats to the top.
        d = (vb === va) ? 0 : (finderDir === 'asc' ? (va - vb) : (vb - va));
        return (d) || (ida < idb ? -1 : 1); // dir already applied here
      } else {
        d = adjById.get(idb) - adjById.get(ida);
      }
      return (d * dirMul) || (ida < idb ? -1 : 1);
    });

    if (hits.length === 0) {
      box.innerHTML = '<div class="state">No players match.</div>';
      return;
    }
    const roomTaken = roomTakenIds();
    /* PER-PAINT SLOT MEMO (R25). firstEligibleOpenSlot() and positionAtCap()
     * are pure in (position, roster.slots, savedProfile, playersById), and the
     * last three are FIXED for the duration of one paint — only `position`
     * varies across the rows. Both bottom out in app/league.js rosterSlots /
     * slotEligiblePositions, each of which opens with normalizeProfile() ->
     * cloneProfile() -> JSON.parse(JSON.stringify(profile)), so the unmemoised
     * loop deep-cloned an identical profile object ~13 times per rendered row
     * (~325 per repaint) and league.js owned 70% of the paint's self time.
     * FINDER_CAP is 25 rows but the roster only fields a handful of distinct
     * positions, so this collapses that to one lookup per position per paint.
     * Same inputs, same function, same answer — the markup cannot move. */
    const _openByPos = new Map();
    const _cappedByPos = new Map();
    const openFor = (position) => {
      if (!_openByPos.has(position)) _openByPos.set(position, firstEligibleOpenSlot(position));
      return _openByPos.get(position);
    };
    const cappedFor = (position) => {
      if (!_cappedByPos.has(position)) {
        _cappedByPos.set(position, positionAtCap(position, roster.slots, playersById, savedProfile));
      }
      return _cappedByPos.get(position);
    };
    const rows = hits.slice(0, FINDER_CAP).map((p) => {
      const id = String(p.gsis_id);
      const open = openFor(p.position);
      const capped = cappedFor(p.position);
      const tl = trendLabel(trajFor(id));
      const trendTxt = tl && tl.dir !== 'flat'
        ? ` <span class="cd-trend cd-trend--${tl.dir}">${tl.dir === 'up' ? '▲' : '▼'}</span>`
        : '';
      const sos = sosOf(id);
      const sosTxt = sos != null ? ` <span class="cd-sos">SoS ${fix1(sos)}</span>` : '';
      // Bye week on EVERY row (owner rule), mirroring the filled roster slots.
      const bw = byeOf(id);
      const byeTxt = bw != null ? ` <span class="cd-bye" title="Bye week">BYE W${bw}</span>` : '';
      const isTaken = taken.has(id) || roomTaken.has(id);
      // A capped position (2 QBs already) or a TAKEN player can't be added.
      const canAdd = open && !capped && !isTaken;
      const addLabel = capped ? `${p.position} FULL` : 'ADD';
      // During an active draft the room's contextual action (NOM/TOOK/PICK)
      // replaces the manual TAKE toggle — the room drives taken-state itself.
      const roomBtn = activeRoom() ? draftActionBtn(id) : '';
      const takenBtn = activeRoom()
        ? (roomBtn || '<span class="cd-onblock cd-onblock--idle">—</span>')
        : `<button type="button" class="cand-taken${isTaken ? ' cand-taken--on' : ''}" ` +
          `data-act="taken" data-gsis="${esc(id)}" aria-pressed="${isTaken ? 'true' : 'false'}" ` +
          `title="Mark drafted by another manager">${isTaken ? 'TAKEN' : 'TAKE'}</button>`;
      // MARKET value cell — last child, on its own grid row (see theme.css
      // .cand--val). Display only; it changes no number above it.
      const val = valueCell(id);
      return (
        `<div class="cand${isTaken ? ' cand--taken' : ''}${val ? ' cand--val' : ''}" data-gsis="${esc(id)}">` +
          `<span class="cd-name">${esc(p.name)}${trendTxt}</span>` +
          `<span class="cd-meta">${esc(p.position)} · <span style="color:${tint(p.team)}">${esc(p.team)}</span>${sosTxt}${byeTxt}${kdstTags(p)}${strengthSuffix(id)}</span>` +
          `<span class="cd-pts">${fix1(adjById.get(id))}${p.kdst && p.kdst.partial ? '*' : ''}</span>` +
          takenBtn +
          `<button type="button" class="cand-add" data-act="add" data-gsis="${esc(id)}"${canAdd ? '' : ' disabled'}>${esc(addLabel)}</button>` +
          val +
        '</div>'
      );
    });
    if (hits.length > FINDER_CAP) {
      rows.push(`<div class="cand cand--more">+ ${hits.length - FINDER_CAP} more — refine search</div>`);
    }
    box.innerHTML = rows.join('');
    restoreDraftFocus(box, focusKey);
  }

  /** BEST PICK NOW strip: top-3 by value over replacement, from the SAME
   * available pool the fit engine sees, so TAKEN players are excluded and the
   * strip re-ranks live as players are taken. Empty picks -> no strip. */
  function bestPickStrip(pool) {
    // R27 — the strip respects my remaining dollars in an auction room; null
    // outside one, which is byte-for-byte the previous call.
    const picks = bestPickNow(roster, pool, weeklyById, mode,
      { budget: recoBudget() }, savedProfile);
    if (picks.length === 0) return '';
    const rows = picks.map((r) => {
      const p = r.player;
      const id = String(p.gsis_id);
      const sign = r.vor >= 0 ? '+' : '';
      const bw = byeOf(id);
      const bye = bw != null ? ` · <span class="bp-bye" title="Bye week">BYE W${bw}</span>` : '';
      const val = valueCell(id);
      return (
        `<div class="bp-row${val ? ' bp-row--val' : ''}" data-gsis="${esc(id)}">` +
          `<span class="bp-name">${esc(p.name)}</span>` +
          `<span class="bp-meta">${esc(p.position)} · <span style="color:${tint(p.team)}">${esc(p.team)}</span>${bye}</span>` +
          `<span class="bp-vor" title="Value over replacement (adjusted pts above the replacement-level ${esc(p.position)})">${sign}${fix1(r.vor)} VOR</span>` +
          (activeRoom()
            ? (draftActionBtn(id) || '<span class="cd-onblock cd-onblock--idle">—</span>')
            : `<button type="button" class="cand-add" data-act="add" data-gsis="${esc(id)}">ADD</button>`) +
          val +
        '</div>'
      );
    }).join('');
    return (
      '<div class="bestpick">' +
        '<div class="bp-head">' +
          '<span class="bp-label">BEST PICK NOW - VALUE OVER REPLACEMENT</span> ' +
          '<span class="est">ESTIMATE</span>' +
        '</div>' +
        valueLegendHtml() +
        rows +
      '</div>'
    );
  }

  function paintReco() {
    const box = el.querySelector('#t-reco');
    // Target = the user-selected empty slot, else the engine's neediest open
    // slot (the SAME resolution recommend() applies — panel label never lies).
    // The engine sees the AVAILABLE pool: projections minus drafted-by-others.
    // Marking a player TAKEN re-optimizes the recommendations immediately.
    const pool = availablePool();
    const strip = bestPickStrip(pool);
    const target = (selectedSlot && !roster.slots[selectedSlot])
      ? selectedSlot
      : neediestOpenSlot(roster, pool, weeklyById, mode);
    if (!target) {
      box.innerHTML = strip +
        '<div class="reco-head"><span class="reco-slot">FIT ENGINE</span> <span class="est">ESTIMATE</span></div>' +
        '<div class="reco-why">Roster complete — tap a filled slot to remove a player and rework the build.</div>';
      return;
    }
    // A K or DEF slot: the fit engine has nothing to say about it. Its score is
    // weekly math (floor, matchup, bye clash) and the K/DST contract carries a
    // SEASON total with no weekly split, so running it here would produce an
    // empty list and the panel would print "No eligible players left for K1" —
    // which, now that this league's kickers are seatable, is false. Rank them by
    // the one honest number that exists, and name what that number is.
    const targetPositions = slotEligiblePositions(target, savedProfile);
    const kdstOnlySlot = targetPositions.length > 0 && targetPositions.every(isKdstPosition);
    if (kdstOnlySlot && kdstRows.length) {
      const rostered = new Set(Object.values(roster.slots).filter(Boolean).map(String));
      const list = sortedKdst
        .filter((p) => slotAccepts(p.position, target, savedProfile))
        .filter((p) => !rostered.has(String(p.gsis_id)))
        .slice(0, 5);
      const label = targetPositions.join('/');
      const items = list.map((p) => {
        const id = String(p.gsis_id);
        return (
          `<div class="reco-item" data-gsis="${esc(id)}">`
          + '<div class="reco-row">'
            + `<span class="reco-name">${esc(p.name)} <span class="reco-meta">${esc(p.position)} · ${esc(p.team)}</span></span> `
            + `<span class="reco-score">${fix1(p.proj_points)}${p.kdst && p.kdst.partial ? '*' : ''}</span> `
            + `<button type="button" class="cand-add" data-act="add" data-gsis="${esc(id)}" data-slot="${esc(target)}">ADD</button>`
          + '</div>'
          + '<div class="reco-why">Season projection under your league\'s scoring'
            + `${p.kdst && p.kdst.partial
              ? ` — INCOMPLETE: it omits ${esc(p.kdst.omitted.map((o) => o.label).join(', '))}, `
                + 'which your league scores and this feed cannot measure.'
              : '.'}</div>`
          + '</div>'
        );
      }).join('');
      box.innerHTML = strip
        + '<div class="reco-head">'
          + `<span class="reco-slot">${esc(target)}</span> <span class="est">ESTIMATE</span></div>`
        + '<div class="reco-why">Ranked by season points, not by fit: there is no weekly split '
          + 'and no opponent adjustment for this position, so no matchup call is possible. '
          + 'Treat it as a baseline.</div>'
        + (items || `<div class="reco-why">No ${esc(label)} left to add.</div>`);
      return;
    }

    // AI+ ON re-ranks through fitScoreV2 (recommendV2); OFF is the untouched
    // v1 path. recoSort picks the ordering: 'fit' (Best fit — the full score) or
    // 'available' (Best available — raw projected points). The head names the
    // active mode so the ranking is never ambiguous.
    const ai = aiOn && aiInsights !== null;
    /* R27 — BEST FIT respects the dollars I have left; BEST AVAILABLE does not.
     * Only meaningful inside an open auction room: outside one there is no
     * "left", and in a snake draft there is no money at all, so recoBudget()
     * returns null and both paths are byte-for-byte what they were. */
    const budget = recoBudget();
    const recos = ai
      ? recommendV2(roster, pool, weeklyById, mode, target, aiInsights,
        { sort: recoSort, budget }, savedProfile)
      : recommend(roster, pool, weeklyById, mode, target, { sort: recoSort, budget },
        savedProfile);
    const sortLabel = recoSort === 'available' ? 'BEST AVAIL' : 'BEST FIT';
    const head =
      '<div class="reco-head">' +
        `<span class="reco-slot">FIT ENGINE${ai ? ' · AI+' : ''} · ${esc(target)}</span> ` +
        `<span class="reco-controls">${recoSortInner(recoSort)}</span> ` +
        '<span class="est">ESTIMATE</span>' +
      '</div>' +
      // What AI+ actually does — the answer to "what is the AI doing?". Only
      // shown when AI+ is on, so BASE stays byte-identical to before.
      // R30b — this said "tuned to raise your weekly ceiling and playoff
      // odds". Nothing tunes these terms (they are fixed, documented priors —
      // STACK_BONUS, COLD_SCALE in app/team-logic.js — no optimiser has ever
      // touched them) and nothing in this app computes a fantasy roster's
      // ceiling or playoff odds. Naming a mechanism that does not exist is the
      // R27 defect class; say what the toggle does instead.
      (ai
        ? '<div class="reco-explain">AI+ re-ranks by 5-yr trajectory, cold-weather edge, and stack synergy '
          + '— three fixed, documented weights, not fitted to any outcome. Δ vs BASE shown per pick.</div>'
        : '') +
      `<div class="reco-sublabel">Ranked by ${sortLabel}${ai ? ' · AI+' : ''}` +
        // R27 — a filter the manager cannot see is a filter they cannot trust.
        // State the ceiling whenever it is actually applied, and state plainly
        // that BEST AVAILABLE is deliberately not filtered, so the two panels
        // showing different players never reads as a bug.
        (budget
          ? (recoSort === 'available'
            ? ' · <span class="reco-cap">BEST AVAIL ignores your budget by design</span>'
            : ` · <span class="reco-cap">within your ${dollar(budget.cap)} max bid</span>`)
          : '') +
      '</div>';
    if (recos.length === 0) {
      box.innerHTML = strip + head + `<div class="reco-why">No eligible players left for ${esc(target)}.</div>`;
      return;
    }
    const items = recos.map((r) => {
      const p = r.player;
      const id = String(p.gsis_id);
      // base->AI delta (only when AI+ on and recommendV2 carried the base score).
      const delta = ai && Number.isFinite(Number(r.base))
        ? Math.round((r.score - r.base) * 10) / 10
        : null;
      const deltaChip = delta != null && delta !== 0
        ? ` <span class="reco-delta reco-delta--${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${fix1(delta)} AI</span>`
        : '';
      const rbw = byeOf(id);
      const rbye = rbw != null ? ` · BYE W${rbw}` : '';
      return (
        `<div class="reco-item" data-gsis="${esc(id)}">` +
          '<div class="reco-row">' +
            `<span class="reco-name">${esc(p.name)} <span class="reco-meta">${esc(p.position)} · ${esc(p.team)}${rbye}</span></span> ` +
            `<span class="reco-score">${fix1(r.score)}${deltaChip}</span> ` +
            (activeRoom()
              ? (draftActionBtn(id) || '<span class="cd-onblock cd-onblock--idle">—</span>')
              : `<button type="button" class="cand-add" data-act="add" data-gsis="${esc(id)}" data-slot="${esc(target)}">ADD</button>`) +
          '</div>' +
          r.reasons.map((t) => {
            // AI-estimated reasons carry the literal "(AI estimate" marker from
            // fitScoreV2 — chip them. Only possible when AI+ is ON (v1 reasons
            // never contain the marker), so the chip never appears on BASE.
            const chip = ai && t.includes('(AI estimate')
              ? ' <span class="prov-ai">AI EST</span>'
              : '';
            return `<div class="reco-why">${esc(t)}${chip}</div>`;
          }).join('') +
        '</div>'
      );
    });
    box.innerHTML = strip + head + items.join('');
  }

  function paintSummary() {
    const box = el.querySelector('#t-summary');
    const starterIds = rosterSlots(savedProfile).starters
      .map((s) => roster.slots[s]).filter(Boolean);
    const totals = teamWeeklyTotals(starterIds, scaledById);
    const seasonTotal = starterIds.reduce((sum, id) => sum + (adjById.get(id) || 0), 0);
    // Starters this app has a SEASON number for and no weekly one (K/DST).
    const kdstStarterNames = starterIds
      .map((id) => playersById.get(String(id)))
      .filter((p) => p && p.kdst)
      .map((p) => p.name);
    // R30b — starters whose K/D-ST total is INCOMPLETE under this league's
    // scoring. The slot chip, the finder row and the Lineup card all mark
    // these numbers ('*' / PARTIAL); a total built FROM them is exactly as
    // incomplete and gets the same mark — rule 4 of the seating block above.
    const partialStarters = partialKdstStarters(starterIds, playersById);
    // R30b — retained seats (kdstUnresolvedSlots): a saved id kept through a
    // failed kdst feed has no number, so it is NOT in the total. Saying so is
    // what keeps the kept-but-uncounted seat from reading as a scored one.
    const staleSeats = rosterSlots(savedProfile).starters
      .filter((s) => roster.slots[s] && !playersById.has(String(roster.slots[s])));

    // Worst week flagged only when someone actually starts (an all-zero grid
    // has no meaningful floor). Marker glyph + label text, never color alone.
    const worst = starterIds.length > 0 ? argmin(totals) : -1;
    const cells = totals.map((t, i) => {
      const floor = i === worst;
      return (
        `<div class="tw-cell${floor ? ' tw-cell--floor' : ''}"${floor ? ' title="Worst week (floor)"' : ''}>` +
          `W${i + 1}<br>${fix1(t)}${floor ? ' ▼' : ''}` +
        '</div>'
      );
    }).join('');
    const gridLabel = worst >= 0
      ? `Starter points by week; worst week W${worst + 1} at ${fix1(totals[worst])}`
      : 'Starter points by week; no starters yet';

    // Bye schedule by week — NAMES, not just counts. Group every starter by
    // their bye week; a week with >=2 starters out is a clash (⚠ warn styling),
    // a single bye is an informational chip. Both list who is out.
    const byeNames = new Map(); // wk -> [name,...]
    starterIds.forEach((id) => {
      const wk = byeWeek(weeklyById.get(id));
      if (wk == null) return;
      const p = playersById.get(id);
      const nm = p ? `${p.team} ${p.name}` : id;
      if (!byeNames.has(wk)) byeNames.set(wk, []);
      byeNames.get(wk).push(nm);
    });
    const chips = [...byeNames.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([wk, names]) => {
        const clash = names.length >= 2;
        const cls = clash ? 'bye-warn' : 'bye-info';
        const mark = clash ? '⚠ ' : '';
        return `<span class="${cls}">${mark}WK ${wk} BYE · ${esc(names.join(', '))}</span>`;
      })
      .join(' ');

    box.innerHTML =
      '<div class="ts-head">' +
        `<span class="ts-label">STARTERS SEASON TOTAL · ${mode.toUpperCase()}</span> ` +
        `<span class="ts-total">${fix1(seasonTotal)}${partialStarters.length ? '*' : ''}</span> ` +
        '<span class="est">ESTIMATE</span>' +
      '</div>' +
      // R30b — the '*' above is a claim, and this line is its proof: name the
      // partial starters and the components their totals omit, mirroring the
      // coverage line the Lineup card prints beside ITS total.
      (partialStarters.length
        ? `<div class="ts-note">* INCOMPLETE — ${esc(partialStarters.map((p) => (
          `${p.name} omits ${p.kdst.omitted.map((o) => o.label).join(', ')}`)).join('; '))}: `
          + 'components your league scores that the K/D-ST feed cannot measure.</div>'
        : '') +
      (staleSeats.length
        ? `<div class="ts-note">${esc(staleSeats.join(', '))}: your saved player is kept but `
          + 'NOT in the total above — the K/D-ST projections feed did not load, so there is '
          + 'no number to add.</div>'
        : '') +
      `<div class="team-weeks" role="img" aria-label="${esc(gridLabel)}">${cells}</div>` +
      (chips
        ? `<div class="ts-byes"><div class="ts-byes-lbl">BYE WEEKS BY STARTER</div>${chips}</div>`
        : '') +
      (starterIds.length === 0
        ? '<div class="ts-note">Add starters to project weekly totals.</div>'
        : '') +
      // A seated K/DST is IN the season total (its stat line is scored under
      // this league's table) but cannot be in the weekly grid: the contract has
      // no weekly split for these positions, and spreading a season total into
      // 18 invented weeks is exactly the fabrication R20-B1 refused. The grid
      // therefore reads lower than the total, and saying so is the difference
      // between a limitation and a bug.
      (kdstStarterNames.length
        ? `<div class="ts-note">${esc(kdstStarterNames.join(', '))} `
          + `${kdstStarterNames.length === 1 ? 'is' : 'are'} in the season total above but `
          + `NOT in the weekly grid — there is no weekly split for K/DST, so `
          + `${kdstStarterNames.length === 1 ? 'that slot adds' : 'those slots add'} `
          + 'nothing to any single week shown here.</div>'
        : '');
  }


  /* ---- DRAFT SIMULATOR painter ---------------------------------------------- */

  /* ---- LEAGUE SETTINGS panel (FLEX · keepers · SAVE · Sleeper) ------------- */

  /** Does the on-screen shape differ from what is actually persisted?
   *
   * Both sides go through the SAME round trip on purpose. The grid cannot
   * express everything a LeagueProfile can — ROSTER_BOUNDS clamps counts and
   * slot ORDER is normalised — so comparing the staged round trip against the
   * RAW saved profile answers the wrong question. It reported UNSAVED for a
   * profile that was saved, and the SAVE it then told the user to press was the
   * very thing that overwrote the unrepresentable part. Round-tripping both
   * sides asks the only honest question: would pressing SAVE change anything?
   * What the grid cannot express is reported by clampedNotes and the carried
   * list instead, where it belongs. */
  function leagueDirty() {
    const seededSaved = cfgFromProfile(savedProfile);
    const asTheGridSeesIt = profileFromCfg(
      seededSaved.cfg, savedProfile, seededSaved.carried,
    );
    return JSON.stringify(profileFromCfg(draftCfg, stagedProfile, carriedTokens))
      !== JSON.stringify(asTheGridSeesIt);
  }

  /* R34 — the SAVED, NOT APPLIED strip. Rendered only while a stashed league
   * exists AND differs from the applied profile: after RE-APPLY the two are
   * equal and the strip disappears on its own, so it can never advertise a
   * restore that would change nothing. One tap, no network — the stash IS the
   * synced import RESTART SESSION parked. */
  function stashStripHtml() {
    if (!stashedLeague) return '';
    if (JSON.stringify(stashedLeague) === JSON.stringify(normalizeProfile(savedProfile))) {
      return '';
    }
    return '<div class="lp-stash">'
      + `<span class="lp-stash-txt">SAVED, NOT APPLIED · ${esc(stashedLeague.name)} · `
      + `${stashedLeague.shape.teams} TEAMS · ${stashedLeague.shape.starters}+`
      + `${stashedLeague.shape.bench} · ${esc(receptionLabel(stashedLeague))} — kept through `
      + 'the restart; RE-APPLY restores it in one tap, nothing is re-downloaded.</span>'
      + '<button type="button" class="lp-btn" data-act="league-reapply">RE-APPLY</button>'
      + '</div>';
  }

  /** The status block: what just happened, in the app's own plain language. */
  function leagueStatusHtml() {
    if (!leagueStatus || !leagueStatus.lines || leagueStatus.lines.length === 0) return '';
    const tone = leagueStatus.tone === 'err' ? 'err' : (leagueStatus.tone === 'warn' ? 'warn' : 'ok');
    return `<div class="lp-status lp-status--${tone}" role="status">`
      + leagueStatus.lines.map((l) => `<div class="lp-status-line">${esc(l)}</div>`).join('')
      + '</div>';
  }

  /** What the last import actually put on the profile — never what it promised. */
  function importReportHtml() {
    if (!importReport && importLines.length === 0) return '';
    const league = (importReport && importReport.league) || {};
    const srcLabel = importReport
      ? ({ api: 'SLEEPER API', paste: 'PASTED JSON', default: 'PPR DEFAULT' }[importReport.source]
        || String(importReport.source).toUpperCase())
      : 'IMPORT';
    const cells = importProfile
      ? importSummaryRows(importProfile).map((r) => (
        `<div class="lp-rep-cell"><span class="ds-lbl">${r.label}</span>`
        + `<b class="lp-rep-val">${esc(r.value)}</b></div>`)).join('')
      : '';
    const lines = importLines.map((l) => `<div class="lp-rep-line">${esc(l)}</div>`).join('');
    const unresolved = importUnresolved.length > 0
      ? `<div class="lp-unres-head">${importUnresolved.length} ITEM(S) NOT APPLIED</div>`
        + '<ul class="lp-unres">'
        + importUnresolved.map((u) => (
          `<li><b>${esc(String(u.kind).replace(/_/g, ' ').toUpperCase())}</b> ${esc(u.message)}</li>`
        )).join('')
        + '</ul>'
      : '';
    return '<div class="lp-report">'
      + `<div class="lp-rep-head">${esc(srcLabel)}`
        + (league.name ? ` · ${esc(league.name)}` : '')
        + (importReport && importReport.synced_at ? ` · ${esc(importReport.synced_at)}` : '')
      + '</div>'
      + (cells ? `<div class="lp-rep-grid">${cells}</div>` : '')
      + lines
      + unresolved
      + '</div>';
  }

  /* ---- ROSTER SYNC panel ---------------------------------------------------- */

  /** The roster panel's own status block (separate from the league one). */
  function rosterStatusHtml() {
    if (!rosterStatus || !rosterStatus.lines || rosterStatus.lines.length === 0) return '';
    const tone = rosterStatus.tone === 'err' ? 'err' : (rosterStatus.tone === 'warn' ? 'warn' : 'ok');
    return `<div class="lp-status lp-status--${tone}" role="status">`
      + rosterStatus.lines.map((l) => `<div class="lp-status-line">${esc(l)}</div>`).join('')
      + '</div>';
  }

  /** One <li> per player, with the slot or the reason they have none. */
  function rosterList(items, cls) {
    if (!items || items.length === 0) return '';
    return `<ul class="lp-unres ${cls}">`
      + items.map((r) => (
        `<li><b>${esc(r.slot || r.position || '—')}</b> ${esc(r.name || r.sleeper_id || '—')}`
        + (r.reason ? ` — ${esc(r.reason)}` : '')
        + (r.from ? ` — was ${esc(r.from)}` : '')
        + '</li>'
      )).join('')
      + '</ul>';
  }

  function rosterPlanHtml() {
    if (!rosterPlan) return '';
    const lines = rosterPlanLines(rosterPlan, rosterMissed)
      .map((l) => `<div class="lp-rep-line">${esc(l)}</div>`).join('');
    const filledNow = Object.values(roster.slots).filter(Boolean).length;

    const section = (label, items, cls) => (items && items.length
      ? `<div class="lp-unres-head">${esc(label)} (${items.length})</div>${rosterList(items, cls)}`
      : '');

    // The losses come FIRST and are always named. Silently destroying a
    // hand-built roster is the worst outcome available here, so the removal
    // list is never collapsed, never counted-only, and never below the fold.
    const losses = rosterPlan.dropped.length > 0
      ? '<div class="lp-unres-head lp-unres-head--warn">'
        + `${rosterApplied ? 'REMOVED FROM' : 'WILL BE REMOVED FROM'} YOUR ROSTER `
        + `(${rosterPlan.dropped.length})</div>`
        + rosterList(rosterPlan.dropped, 'lp-unres--drop')
      : '';

    let btn;
    if (rosterApplied) {
      btn = '<div class="lp-saved">Roster replaced. Sync again to pull a fresh copy.</div>';
    } else if (filledNow === 0) {
      btn = '<button type="button" class="lp-savebtn" data-act="roster-apply">'
        + `FILL MY ROSTER · ${rosterPlan.after_count} PLAYER`
        + `${rosterPlan.after_count === 1 ? '' : 'S'}</button>`
        + '<div class="lp-saved">Your roster is empty, so nothing is overwritten.</div>';
    } else if (!rosterArmed) {
      btn = '<button type="button" class="lp-savebtn lp-savebtn--dirty" data-act="roster-apply">'
        + 'REPLACE MY ROSTER…</button>'
        + `<div class="lp-saved lp-saved--dirty">This replaces all ${filledNow} player(s) on `
        + `your roster with the ${rosterPlan.after_count} above`
        + (rosterPlan.dropped.length
          ? `, removing the ${rosterPlan.dropped.length} named as WILL BE REMOVED.`
          : '.')
        + '</div>';
    } else {
      btn = '<button type="button" class="lp-savebtn lp-savebtn--dirty reset-btn--armed" '
        + 'data-act="roster-apply">TAP AGAIN TO REPLACE</button>'
        + `<div class="lp-saved lp-saved--dirty">Confirming overwrites ${filledNow} player(s)`
        + (rosterPlan.dropped.length
          ? ` and removes ${rosterPlan.dropped.map((d) => d.name).join(', ')}`
          : '')
        + '. Any other action cancels.</div>';
    }

    return '<div class="lp-report lp-report--roster">'
      + '<div class="lp-rep-head">SLEEPER ROSTER · '
        + `${rosterApplied ? 'WHAT THIS DID' : 'WHAT THIS WOULD DO'}</div>`
      + lines
      + losses
      + section('SEATED', rosterPlan.assigned.map((a) => ({
        slot: a.slot,
        name: a.name,
        // How the match was made is part of the claim: an espn_id match is an
        // identity, a name match is an inference and says so.
        reason: `${a.position} · ${a.team || '—'} · matched by ${String(a.method || 'id').replace(/_/g, ' ')}`,
      })), 'lp-unres--seat')
      + section('MATCHED BUT NO SLOT LEFT', rosterPlan.unplaced, 'lp-unres--drop')
      + section('NOT IN THIS APP\'S PLAYER POOL', rosterMissed.map((u) => ({
        slot: u.sleeper_position || 'SLEEPER',
        name: u.sleeper_name || `id ${u.sleeper_id}`,
        reason: u.message,
      })), 'lp-unres--miss')
      + `<div class="lp-save">${btn}</div>`
      + '</div>';
  }

  function rosterPanelHtml() {
    const teamOpts = rosterTeams
      ? [`<option value="-1"${rosterTeamIdx < 0 ? ' selected' : ''}>— pick your team —</option>`]
        .concat(rosterTeams.map((t, i) => (
          `<option value="${i}"${i === rosterTeamIdx ? ' selected' : ''}>`
          + esc(`${t.label} · ${(t.players || []).length} player`
            + `${(t.players || []).length === 1 ? '' : 's'}`
            + (t.display_name && t.display_name !== t.label ? ` · @${t.display_name}` : '')
            + (t.owner_known ? '' : ' · no manager'))
          + '</option>'
        ))).join('')
      : '';
    return (
      '<div class="ds-sub"><span>SLEEPER ROSTER</span>'
        + '<span class="ds-sub-note">RUNS WITH SYNC NOW · NO POLLING</span></div>'
      + '<div class="m-explain">Pull the players actually on your Sleeper team into the roster '
        + 'above, so it stops needing hand entry. SYNC NOW above runs this step for you after '
        + 'it saves the league settings; the first time, pick which team is yours and it is '
        + 'remembered on this device (RESET ALL forgets it). SYNC ROSTER re-runs just this '
        + 'step. There is no polling and no background '
        + 'refresh. A Sleeper roster carries player ids and no names, so the first press also '
        // R52 — app/sleeper.js keeps the built list for the session (memoized
        // in the module, not this mount), so the boundary is the page load.
        + 'downloads Sleeper\'s player list (several MB); it is kept while you stay on this '
        + 'page — any tab, until you reload — so a later sync does not re-download it. '
        + 'Nothing is written until you '
        + 'confirm, and every player it cannot match is listed by name.</div>'
      + '<div class="lp-sync">'
        + `<button type="button" class="lp-btn" data-act="roster-sync"${rosterBusy ? ' disabled' : ''}>`
          + `${rosterBusy ? 'READING…' : 'SYNC ROSTER'}</button>`
        // .lp-rsel gives this select the 44px minimum touch target (theme.css).
        // The bare .ds-select it used is 30px — draft-room density, wrong for
        // the control that picks WHICH team a destructive sync overwrites, and
        // wrong beside the 44px .lp-btn sharing its row.
        + (rosterTeams
          ? '<label class="lp-field lp-field--grow"><span class="ds-lbl">MY TEAM</span>'
            + `<select class="ds-select lp-rsel" data-rcfg="team">${teamOpts}</select></label>`
          : '')
      + '</div>'
      + rosterStatusHtml()
      + rosterPlanHtml()
    );
  }

  function leaguePanelHtml() {
    const rounds = rosterSlotCount();
    const keeperCap = Math.min(LEAGUE_BOUNDS.max_keepers[1], rounds);
    if (draftCfg.maxKeepers > keeperCap) draftCfg.maxKeepers = keeperCap;
    const lopt = (v, cur, label) => (
      `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>`
      + `${esc(label == null ? v : label)}</option>`
    );
    const lfield = (key, label, optsHtml) => (
      '<label class="lp-field">'
      + `<span class="ds-lbl">${label}</span>`
      + `<select class="ds-select" data-lcfg="${key}">${optsHtml}</select>`
      + '</label>'
    );
    const keeperOpts = [];
    for (let v = 0; v <= keeperCap; v += 1) keeperOpts.push(lopt(v, draftCfg.maxKeepers));
    const dirty = leagueDirty();
    const savedLine = dirty
      ? 'UNSAVED — press SAVE to keep this shape past a reload'
      : (isDefaultProfile(savedProfile)
        ? 'SAVED · STANDARD PPR DEFAULT (nothing customised yet)'
        : `SAVED · ${savedProfile.name} · ${savedProfile.shape.teams} TEAMS · `
          + `${savedProfile.shape.starters}+${savedProfile.shape.bench} · ${receptionLabel(savedProfile)}`);
    const seedNotes = [];
    clampedNotes.forEach((c) => seedNotes.push(
      `${c.key.toUpperCase()}: your saved league has ${c.wanted}; the draft simulator prices `
      + `${c.used} (its bounds).`));
    // Two different reasons a token is carried, and they mean opposite things:
    // K/DEF are kept but NOT drafted, while a second kind of flex slot is kept
    // AND drafted — there is just one flex selector to show it in.
    const carriedFlex = carriedTokens.filter((t) => FLEX_ELIGIBILITY[t]);
    const carriedUndraftable = carriedTokens.filter((t) => !FLEX_ELIGIBILITY[t]);
    if (carriedUndraftable.length > 0) seedNotes.push(
      `${carriedUndraftable.join(', ')} stay on your league profile but the draft simulator `
      + 'does not draft them.');
    if (carriedFlex.length > 0) seedNotes.push(
      `Your league starts more than one kind of flex slot. The selector above sets the first `
      + `(${flexLabel(draftCfg.flexType)}); ${carriedFlex.map(flexLabel).join(', ')} `
      + `${carriedFlex.length === 1 ? 'is' : 'are'} kept exactly as saved and AI+ reads `
      + `${carriedFlex.length === 1 ? 'it' : 'them'} in full. Saving here does not change `
      + `${carriedFlex.length === 1 ? 'it' : 'them'}.`);

    return (
      '<div class="ds-sub"><span>FLEX &amp; KEEPERS</span>'
        + `<span class="ds-sub-note">${esc(flexLabel(draftCfg.flexType))}`
        + `${draftCfg.keepers
          ? ` · ${draftCfg.maxKeepers} KEEPER${draftCfg.maxKeepers === 1 ? '' : 'S'}`
          : ' · NO KEEPERS'}</span></div>`
      + '<div class="lp-grid">'
        + lfield('flexType', 'FLEX SLOTS TAKE',
          FLEX_TOKENS.map((t) => lopt(t, draftCfg.flexType, flexLabel(t))).join(''))
        + lfield('keepers', 'KEEPERS',
          lopt('off', draftCfg.keepers ? 'on' : 'off', 'OFF')
          + lopt('on', draftCfg.keepers ? 'on' : 'off', 'ON'))
        + lfield('maxKeepers', 'MAX KEEPERS', keeperOpts.join(''))
      + '</div>'
      + '<div class="m-explain">Keepers are recorded on your league profile and can be changed '
        + 'at any time. They are NOT simulated: mark the players you are keeping TAKEN on the '
        + 'board so the room drafts without them.</div>'
      // SAVE — directly after the league + roster settings it persists.
      + '<div class="lp-save">'
        + `<button type="button" class="lp-savebtn${dirty ? ' lp-savebtn--dirty' : ''}" `
          + 'data-act="league-save">SAVE LEAGUE SETTINGS</button>'
        + `<div class="lp-saved${dirty ? ' lp-saved--dirty' : ''}">${esc(savedLine)}</div>`
      + '</div>'
      + stashStripHtml()
      + leagueStatusHtml()
      + (seedNotes.length
        ? `<div class="lp-notes">${seedNotes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>`
        : '')
      + '<div class="m-explain">SAVE writes these to your league profile and RE-PRICES the '
        + 'board: league size and roster shape feed replacement level, VOR and beat-the-room '
        + 'draft value straight away, and the reception value sets the scoring mode the whole '
        + 'app projects at. None of it is ever an input to the learned-signal gate — nothing is '
        // R27 — THE OLD FIRST LIMIT WAS NO LONGER TRUE. This said "the 13-slot
        // roster panel on this page is still fixed", which stopped being the
        // case when R19 built the panel from rosterSlots(profile).all, and is
        // now visibly false: a league that seats a K and a DEF renders a K and
        // a DEF slot. A stale confession is still the app stating something
        // untrue, and it understated what the page could actually do. Replaced
        // with the limit that IS still real — the roster steppers only cover
        // the offensive slots, so a K/DEF league has to arrive by import.
        // R28 — this sentence has now been wrong twice, which is why the gate
        // audits it. It first claimed the roster panel was fixed at 13 slots
        // (untrue since R19 made it shape-driven), then that K/DEF could only
        // arrive by import (untrue the moment the K and DEF counters above
        // shipped). What remains genuinely limited is the flex assumption.
        // R30b — and a third time: "the opponent model drafts every FLEX as
        // WR/RB/TE" stopped being true of the AI+ room at R23, which reads
        // the saved profile's flex eligibility in full (app/draft-sim.js
        // aiPlusContext -> app/team-logic.js FLEX_WIN_SHARE.SUPER_FLEX — a
        // superflex league's QB demand rises to ~1.9 per team there). The
        // limit is real only for the rooms priced off the derived roster
        // shape, whose flex slots are the literal FLEX token — the sentence now
        // names those rooms, and agrees with the carriedFlex note above and
        // the AI+ room key below instead of contradicting both.
        + 'retrained. One limit, said plainly: the ADP and SHARK rooms and the auction '
        + 'price every flex as WR/RB/TE, so they treat a SUPERFLEX league as if its flex '
        + 'were WR/RB/TE; the AI+ room reads your saved flex slots in full, superflex '
        + 'included.</div>'
      + '<div class="ds-sub"><span>SLEEPER</span>'
        + '<span class="ds-sub-note">MANUAL SYNC ONLY</span></div>'
      + '<div class="lp-sync">'
        + '<label class="lp-field lp-field--grow">'
          + '<span class="ds-lbl">LEAGUE ID OR URL</span>'
          + '<input class="lp-input" type="text" data-lin="sleeperId" autocomplete="off" '
            // A placeholder that LOOKS like a real 19-digit league id reads as a
            // value already entered, and SYNC NOW then contradicts what the user
            // sees ("Enter your Sleeper league id or league URL first."). R24:
            // say what to do instead of showing a plausible id.
            + 'spellcheck="false" placeholder="paste your league id or URL" '
            + `value="${esc(sleeperId)}" `
            + 'aria-label="Sleeper league id or league URL">'
        + '</label>'
        + `<button type="button" class="lp-btn" data-act="sleeper-sync"${syncBusy ? ' disabled' : ''}>`
          + `${syncBusy ? 'SYNCING…' : 'SYNC NOW'}</button>`
      + '</div>'
      + `<details class="lp-paste"${pasteOpen ? ' open' : ''}>`
        + '<summary class="lp-summary">PASTE LEAGUE JSON INSTEAD</summary>'
        + `<div class="m-explain">No network from this app: open ${esc(SLEEPER_API_BASE)}`
          + '/league/{your league id} in a browser tab and paste the whole response here.</div>'
        + '<textarea class="lp-textarea" data-lin="pasteText" rows="4" spellcheck="false" '
          + `aria-label="Pasted Sleeper league JSON" placeholder="{ &quot;league_id&quot;: … }">${esc(pasteText)}</textarea>`
        + '<button type="button" class="lp-btn lp-btn--wide" data-act="sleeper-paste">'
          + 'IMPORT PASTED JSON</button>'
      + '</details>'
      + importReportHtml()
      + rosterPanelHtml()
    );
  }

  /* ---- ROSTER SYNC wiring --------------------------------------------------
   * No network of its own since R52: /rosters + /users go through
   * app/sleeper.js importSleeperTeams(), the player dump through its
   * loadSleeperPlayerIndex(). */

  /** Build (or rebuild) the plan for the currently selected Sleeper team. */
  function buildRosterPlan() {
    rosterArmed = false;
    rosterApplied = false;
    if (!rosterTeams || rosterTeamIdx < 0 || !rosterTeams[rosterTeamIdx] || !sleeperIndex) {
      rosterCross = null;
      rosterMissed = [];
      rosterPlan = null;
      return;
    }
    // app/sleeper.js owns the crosswalk; this view owns only the seating. The
    // app-player set handed over is exactly the pool this page can seat, which
    // now INCLUDES this league's kickers and team defences — sleeper.js already
    // documents kicker gsis ids and 'DST-DEN' ids as this app's ids and carries
    // a team_def match method, so a K or a DEF on the Sleeper roster resolves
    // and takes its slot instead of coming back as "not in this app's player
    // pool" while the slot it belongs in stays null. A league with no K/DEF
    // slot passes exactly `players`, so that report is unchanged for it.
    rosterCross = crosswalkRoster(rosterTeams[rosterTeamIdx], seatable, { index: sleeperIndex });
    rosterMissed = unmatchedRosterPlayers(rosterCross);
    // R43 (owner RCA): a K/DEF on the Sleeper roster that lands in the missed
    // list because THIS PAGE handed over no K/DEF rows is a league-profile
    // state, not a matching failure — name the state and its one-step fix
    // instead of letting "not in this app's player set" imply the player is
    // unknown. kdstRows is empty in exactly two honest cases: the saved
    // profile fields no K/DEF slot, or it fields one its scoring cannot price.
    if (kdstRows.length === 0) {
      const missedKdst = rosterMissed.filter((u) => {
        const p = String(u.sleeper_position || '').toUpperCase();
        return p === 'K' || p === 'DEF' || p === 'DST';
      });
      if (missedKdst.length) {
        const cause = kdstSeatTokens.length
          ? 'your league\'s scoring table prices no K/DEF stat, so there is no honest '
            + 'number to seat them with'
          : 'your saved league profile fields no K/DEF slot';
        rosterStatus = {
          tone: 'err',
          lines: [
            ...(rosterStatus && Array.isArray(rosterStatus.lines) ? rosterStatus.lines : []),
            `${missedKdst.length} K/DEF from this Sleeper roster cannot seat: ${cause}. `
            + 'Import your league from Sleeper in the LEAGUE panel above, SAVE it, then '
            + 'sync the roster again.',
          ],
        };
      }
    }
    rosterPlan = planRosterSync({
      resolved: orderedRosterPlayers(rosterCross),
      currentSlots: roster.slots,
      profile: savedProfile,
      playersById,
    });
  }

  /** SYNC ROSTER: rosters + users + (once) the player index. Manual only. */
  async function runRosterSync() {
    const leagueId = parseLeagueId(sleeperId);
    if (!leagueId) {
      rosterStatus = {
        tone: 'err',
        lines: ['Enter your Sleeper league id or league URL in the field above first — the '
          + 'roster sync reads the same league.'],
      };
      paintDraft();
      return;
    }
    rosterBusy = true;
    rosterTeams = null;
    rosterTeamIdx = -1;
    rosterCross = null;
    rosterMissed = [];
    rosterPlan = null;
    rosterArmed = false;
    rosterApplied = false;
    rosterStatus = {
      tone: 'ok',
      lines: [sleeperIndex
        ? 'Reading the rosters from Sleeper…'
        : 'Reading the rosters from Sleeper, then its player list (several MB the first '
          + 'time this session; kept after that).'],
    };
    paintDraft();

    // /rosters + /users, read and joined by app/sleeper.js.
    const teamsRes = await importSleeperTeams(leagueId);
    if (stale('rosters')) return;
    if (!teamsRes.ok || !Array.isArray(teamsRes.teams) || teamsRes.teams.length === 0) {
      rosterBusy = false;
      rosterStatus = {
        tone: 'err',
        lines: [(teamsRes.error && teamsRes.error.message)
          || `Sleeper returned no rosters for league ${leagueId}.`,
        'Nothing on your roster was changed.'],
      };
      paintDraft();
      return;
    }
    const notes = [];
    if (teamsRes.users_error) {
      notes.push('The manager names could not be read, so the teams below are listed by roster '
        + 'number only. The rosters themselves are unaffected.');
    }
    (teamsRes.orphan_rosters || []).forEach((o) => notes.push(
      `Roster ${o.roster_id}: ${o.reason}`));

    // R52 — the player dump, through app/sleeper.js: once per session (memo),
    // streamed with a progress line in the sync banner, a failure forgotten so
    // the next press retries. The mount keeps the built index only because
    // buildRosterPlan() and the draft companion read it by reference.
    if (!sleeperIndex) {
      indexProgress = 'Reading Sleeper\'s player list…';
      paintSyncBar();
      const idxRes = await loadSleeperPlayerIndex({
        onProgress: ({ bytes }) => {
          if (stale('player list progress')) return;
          indexProgress = `Reading Sleeper's player list… ${mb(bytes)}`;
          const line = el.querySelector('#t-syncbar .sync-bar-prog');
          if (line) line.textContent = indexProgress;
        },
      });
      if (stale('player list')) return;
      indexProgress = '';
      if (!idxRes.ok) {
        rosterBusy = false;
        rosterStatus = {
          tone: 'err',
          lines: [(idxRes.error && idxRes.error.message)
            || 'Sleeper\'s player list came back in a shape this app does not recognise.',
          'Without that list a roster is a list of opaque ids, so nothing can be matched. '
            + 'Nothing on your roster was changed.'],
        };
        paintDraft();
        return;
      }
      sleeperIndex = idxRes.index;
      notes.push(idxRes.cached
        ? 'Sleeper\'s player list: cached from earlier this session.'
        : `Sleeper's player list: ${idxRes.bytes != null ? `${mb(idxRes.bytes)} ` : ''}read.`);
    }

    rosterTeams = teamsRes.teams;
    rosterBusy = false;
    // R49 — EVERY roster in the league, crosswalked through the same index
    // and the same seatable pool as my own, saved once so LINEUP can say who
    // is unrostered without a second read. The memory is a convenience: a
    // blocked storage cannot fail the sync. my_roster_id is the remembered
    // pick for now; a seat (applyRosterPlan / the picker) overwrites it.
    try {
      saveLeagueRosters({
        league_id: leagueId,
        teams: rosterTeams.map((t) => ({
          roster_id: t.roster_id,
          label: t.label,
          app_ids: orderedRosterPlayers(crosswalkRoster(t, seatable, { index: sleeperIndex }))
            .map((r) => r.player_id),
        })),
        my_roster_id: rememberedRosterId(leagueId),
      });
    } catch (err) { /* the roster memory is a convenience; the sync stands without it */ }
    // R49 — Sleeper's current NFL week, one small GET. Failure is silent by
    // design: the week simply stays unknown and LINEUP keeps its own default.
    try {
      const stateRes = await fetchSleeperState({ timeoutMs: 4000 });
      if (stateRes.ok) saveNflWeek(stateRes.payload);
    } catch (err) { /* no week is better than an invented one */ }
    if (stale('nfl week')) return;
    // R48 — a remembered pick (this device told us once which roster is
    // theirs) or a one-roster league selects itself and, when the roster on
    // this page is still empty, seats the team without a second press.
    const remembered = rememberedRosterId(leagueId);
    const rememberedIdx = remembered == null
      ? -1 : rosterTeams.findIndex((t) => Number(t.roster_id) === remembered);
    if (rememberedIdx >= 0 || rosterTeams.length === 1) {
      rosterTeamIdx = rememberedIdx >= 0 ? rememberedIdx : 0;
      buildRosterPlan();
      notes.unshift(rememberedIdx >= 0
        ? `${rosterTeams[rosterTeamIdx].label} is remembered as your team on this device.`
        : 'This league has one roster, so it was selected for you.');
      rosterStatus = { tone: teamsRes.users_error ? 'warn' : 'ok', lines: notes };
      // Seat without a second press whenever doing so can drop nobody: an
      // empty roster, or a plan whose only effect is to add or re-seat.
      if (rosterPlan && (rosterFilledCount() === 0 || rosterPlan.dropped.length === 0)) {
        if (applyRosterPlan({ auto: true })) return;
      }
      notes.push('Check the plan below before confirming — it removes players seated now.');
    } else {
      notes.unshift(`${rosterTeams.length} teams read. PICK YOUR TEAM (banner above the roster) `
        + 'to finish the sync — it is remembered on this device, so the next SYNC NOW needs no pick.');
    }
    rosterStatus = { tone: teamsRes.users_error ? 'warn' : 'ok', lines: notes };
    paintDraft();
    // The next step is above the roster grid: bring it on screen.
    scrollToSyncBar();
  }

  /** R48b — put the sync banner (and the roster under it) on screen. */
  function scrollToSyncBar() {
    const bar = el.querySelector('#t-syncbar');
    if (!bar || typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
    try {
      // Land the banner just under the sticky topbar, never behind it.
      const topbar = document.querySelector('.topbar');
      const offset = (topbar ? topbar.getBoundingClientRect().height : 0) + 8;
      const top = bar.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    } catch (err) { /* no-op: scrolling is a courtesy */ }
  }

  /** How many roster slots hold a player right now. */
  function rosterFilledCount() {
    return Object.values(roster.slots).filter(Boolean).length;
  }

  /**
   * Seat the planned Sleeper roster. `auto` (R48) is the one-press path: it
   * writes only when the plan drops nobody (an empty roster, or adds and
   * re-seats only), so it can never remove a hand-added player. The manual
   * path keeps its deliberate second tap when a plan would remove players.
   */
  function applyRosterPlan({ auto = false } = {}) {
    if (!rosterPlan || rosterApplied || !rosterCross) return false;
    const fresh = planRosterSync({
      resolved: orderedRosterPlayers(rosterCross),
      currentSlots: roster.slots,
      profile: savedProfile,
      playersById,
    });
    const unchanged = JSON.stringify(fresh) === JSON.stringify(rosterPlan);
    rosterPlan = fresh;
    if (!unchanged && !auto) {
      rosterArmed = false;
      rosterStatus = {
        tone: 'warn',
        lines: ['Your roster or league shape changed since this plan was drawn, so it was '
          + 'recalculated. Read what will be removed, then confirm again.'],
      };
      paintDraft();
      return false;
    }
    const filledNow = rosterFilledCount();
    if (filledNow > 0 && !rosterArmed && !(auto && rosterPlan.dropped.length === 0)) {
      if (auto) { paintDraft(); return false; }
      // DELIBERATE CONFIRM. The panel already names every player that goes;
      // this second tap is the user saying they read it.
      rosterArmed = true;
      paintDraft();
      return false;
    }
    rosterArmed = false;
    slotOrder().forEach((slot) => {
      roster.slots[slot] = rosterPlan.slots[slot] || null;
    });
    saveRoster(roster);
    selectedSlot = null;
    rosterApplied = true;
    const team = rosterTeams && rosterTeamIdx >= 0 ? rosterTeams[rosterTeamIdx] : null;
    const leagueId = parseLeagueId(sleeperId);
    if (team && leagueId) saveMyRoster(leagueId, team.roster_id);
    if (team && leagueId) setMyRosterId(leagueId, team.roster_id); // R49 — mark mine in the league record
    try {
      recordSync({
        kind: 'roster',
        league_id: leagueId,
        league_name: savedProfile.name,
        changes: [
          `${team ? team.label : 'Roster'}: ${rosterPlan.after_count} player(s) seated, `
            + `${rosterPlan.dropped.length} removed${auto ? ' (one-press sync)' : ''}`,
          ...(rosterPlan.unplaced.length ? [`${rosterPlan.unplaced.length} matched but no slot left`] : []),
          ...(rosterMissed.length ? [`${rosterMissed.length} not in this app's player pool`] : []),
        ],
      });
      try { window.dispatchEvent(new Event('nfl2026:league')); } catch (err) { /* no window */ }
    } catch (err) { /* the log is a convenience; the seat stands without it */ }
    // The RESULT is the roster itself: after the paint below, show it rather
    // than the settings card the picker used to sit under.
    setTimeout(() => { if (!stale('scroll')) scrollToSyncBar(); }, 0);
    rosterStatus = {
      tone: 'ok',
      lines: [`${auto ? 'Synced: ' : ''}roster ${auto ? 'seated' : 'replaced'} from Sleeper`
        + `${team ? ` (${team.label})` : ''}: ${rosterPlan.after_count} player(s) seated, `
        + `${rosterPlan.dropped.length} removed. LINEUP and GRADE now read this roster.`,
      ...(rosterPlan.unplaced.length > 0 || rosterMissed.length > 0
        ? ['The players listed below as unmatched or unseated were NOT added — they are '
          + 'still yours in Sleeper, this app just has no slot or no projection for them.']
        : [])],
    };
    paintAll();
    return true;
  }

  /** Fold an ImportResult into the panel: it stages, it never saves. */
  function applyImport(res) {
    importReport = res && res.report ? res.report : null;
    // R30b — a failed import's "Next:" line pointed at an import tier that is
    // not wired anywhere (see honestImportFailureLines). Rewritten HERE, at
    // the one place the lines reach a screen, because this agent owns this
    // view and not app/sleeper.js.
    importLines = honestImportFailureLines(summarizeImport(res));
    importUnresolved = importReport ? unresolvedItems(importReport) : [];
    if (res && res.ok && res.profile) {
      importProfile = normalizeProfile(res.profile);
      stagedProfile = cloneProfile(importProfile);
      const mapped = cfgFromProfile(importProfile);
      carriedTokens = mapped.carried;
      clampedNotes = mapped.clamped;
      Object.assign(draftCfg, mapped.cfg);
      if (draftCfg.mySlot > draftCfg.leagueSize) draftCfg.mySlot = draftCfg.leagueSize;
      const lines = ['Imported into the settings above — NOT saved yet. Check the numbers, '
        + 'then press SAVE LEAGUE SETTINGS.'];
      mapped.clamped.forEach((c) => lines.push(
        `${c.key.toUpperCase()}: your league has ${c.wanted}; the draft simulator prices `
        + `${c.used} (its bounds).`));
      // R30b — the same carried split the settings card makes (carriedFlex vs
      // carriedUndraftable in leaguePanelHtml), because the two kinds mean
      // OPPOSITE things. The import line lumped them together as "the
      // simulator does not draft them", so importing a superflex league told
      // its manager the one room built to model it would not draft their
      // SUPER_FLEX — while the settings note beside it said AI+ reads it in
      // full. One truth, both panels.
      const carriedFlexImp = mapped.carried.filter((t) => FLEX_ELIGIBILITY[t]);
      const carriedOtherImp = mapped.carried.filter((t) => !FLEX_ELIGIBILITY[t]);
      if (carriedOtherImp.length > 0) lines.push(
        `${carriedOtherImp.join(', ')} stay on your league profile but the draft simulator `
        + 'does not draft them.');
      if (carriedFlexImp.length > 0) lines.push(
        `${carriedFlexImp.join(', ')} kept on the profile exactly as imported — the AI+ room `
        + `reads ${carriedFlexImp.length === 1 ? 'it' : 'them'} in full; the ADP and SHARK `
        + 'rooms and the auction price every flex as WR/RB/TE.');
      leagueStatus = { tone: 'ok', lines };
    } else {
      importProfile = null;
      leagueStatus = { tone: 'err', lines: importLines };
    }
    paintDraft();
  }

  /* ---- R23-S1: the ROOM selector and its explainer ---------------------------
   *
   * There are three rooms now and their names alone do not say who you are
   * drafting against, so each carries one line. ADP has always been the
   * default and stays first in the menu — an existing manager opens this page
   * to exactly the room they left it on.
   */

  /** One line per room, in the app's voice: WHO the opponents are. */
  const ROOM_BLURB = Object.freeze({
    adp: 'Opponents take the consensus board — real ADP, with need-aware noise. '
      + 'The closest thing here to a public league.',
    shark: 'Every opponent runs this app\'s own engine and takes the best available on raw '
      + 'projected points. A stress test, not a room you will meet.',
    aiplus: 'Opponents draft to YOUR saved league: value converted to your per-reception '
      + 'scoring, starters and caps read off your roster shape.',
  });

  /** The ROOM <option> list, ADP first so the default never moves. */
  function roomOptionsHtml() {
    return ROOM_TYPES.map((rt) => (
      `<option value="${esc(rt)}"${draftCfg.roomType === rt ? ' selected' : ''}>`
      + `${esc(ROOM_LABELS[rt] || rt.toUpperCase())}</option>`
    )).join('');
  }

  /**
   * The room key: one line each, the selected one lit.
   *
   * AI+ WITH NOTHING SAVED. app/draft-sim.js aiPlusContext() falls back to the
   * DEFAULT profile when none is saved, which is a standard 12-team full-PPR
   * league. That is a working room — but a manager who picked AI+ believes
   * their league is being modelled, and with nothing saved it is not. So the
   * fallback is stated, not hidden.
   *
   * AND WHAT IT DOES NOT MODEL. leagueSeasonPoints() converts our full-PPR
   * projection using the one scoring key this app has a projected stat for
   * (receptions, plus a TE-reception premium). Every other scoring difference
   * is left alone rather than guessed at, and the copy says so.
   */
  function roomKeyHtml() {
    if (draftCfg.mode === 'auction') return ''; // no ROOM select in auction mode
    const rows = ROOM_TYPES.map((rt) => (
      `<div class="ds-rk${draftCfg.roomType === rt ? ' ds-rk--on' : ''}">`
        + `<b class="ds-rk-tag">${esc(ROOM_LABELS[rt] || rt.toUpperCase())}</b>`
        + `<span class="ds-rk-txt">${esc(ROOM_BLURB[rt] || '')}</span>`
      + '</div>'
    )).join('');
    let notes = '';
    if (draftCfg.roomType === 'aiplus') {
      if (isDefaultProfile(savedProfile)) {
        notes += '<div class="ds-rk-warn">NO LEAGUE PROFILE SAVED — AI+ is running the '
          + 'default: 12 teams, QB/RB/RB/WR/WR/TE/FLEX/K/DEF + 6 bench, full PPR (1.0 per '
          + 'reception). That is a standard PPR room, not yours. Set or import your '
          + 'league below and press SAVE LEAGUE SETTINGS to have AI+ model it.</div>';
      } else {
        notes += '<div class="ds-rk-note">AI+ is reading your saved profile: '
          + `${esc(savedProfile.name)} · ${savedProfile.shape.teams} TEAMS · `
          + `${savedProfile.shape.starters}+${savedProfile.shape.bench} · `
          + `${esc(receptionLabel(savedProfile))}.</div>`;
      }
      if (leagueDirty()) {
        notes += '<div class="ds-rk-warn">The settings above are UNSAVED. AI+ reads the '
          + 'SAVED profile, so those changes are not in the room yet — press SAVE LEAGUE '
          + 'SETTINGS first.</div>';
      }
      notes += '<div class="ds-rk-note">Scope, exactly: AI+ converts this app\'s full-PPR '
        + 'projection using your per-reception value and any TE-reception premium — the '
        + 'scoring keys there is a projected stat to multiply. Other scoring differences '
        + 'are not modelled rather than guessed at. Roster shape, flex eligibility and '
        + 'position caps are used in full.</div>';
    }
    return `<div class="ds-roomkey">${rows}${notes}</div>`;
  }

  /* ---- R23-S1: DRAFT HISTORY + what it is allowed to claim -------------------
   *
   * Every finished draft and auction is stored (app/mocks.js). This panel is
   * the consumer that used to be missing, and it is deliberately split in two:
   *
   *   HISTORY   — everything, counted. A SIM room is practice; saying so is
   *               the whole point, because it is what the old "learning
   *               record" copy hid.
   *   ROOM      — LIVE drafts only. When there is not enough of it, the panel
   *   CALIBRATION prints roomCalibration()'s own reason instead of a number.
   *               No number is ever synthesised to fill the space.
   */
  function historyPanelHtml() {
    const s = historySummary(mockHistory);
    const head = '<div class="ds-sub"><span>DRAFT HISTORY</span>'
      + `<span class="ds-sub-note">${s.total} RECORDED</span></div>`;
    if (s.total === 0) {
      return head + '<div class="ds-hist"><div class="m-explain">Nothing recorded yet. '
        + 'Finishing a draft or an auction saves it here, on this device only.</div></div>';
    }
    const bits = [
      `${s.snake} snake`,
      `${s.auction} auction`,
      `${s.live} live`,
      `${s.sim} sim`,
    ];
    if (s.unknown_play > 0) bits.push(`${s.unknown_play} play mode unknown`);
    const legacy = s.legacy > 0
      ? `<div class="ds-hnote">${s.legacy} record${s.legacy === 1 ? '' : 's'} carried over from `
        + 'this app\'s previous draft-history storage — nothing was lost, and the old copy is '
        + 'still on disk. Records from then did not store a play mode, so they count as '
        + 'unknown and can never become calibration evidence.</div>'
      : '';

    let cal;
    if (mockCal.ready) {
      const d = mockCal.drift;
      const dir = d.mean < 0 ? 'REACHES' : 'WAITS';
      const mag = Math.abs(d.mean).toFixed(1);
      const drift = '<div class="ds-hcal ds-hcal--on">'
        + `THIS ROOM ${dir} — players go ${mag} picks `
        + `${d.mean < 0 ? 'EARLIER' : 'LATER'} than consensus on average`
        + (d.sd != null ? `, spread ±${d.sd.toFixed(1)}` : '')
        + `<span class="cd-meta">measured from ${mockCal.picks} observed opponent picks `
        + `across ${mockCal.drafts} live draft${mockCal.drafts === 1 ? '' : 's'}</span></div>`
        // The survivorship caveat app/mocks.js documents for roomCalibration()
        // never reached the UI (R24), so the headline read as an unqualified
        // fact about the room. It is the mean's own definition — say it here.
        + '<div class="ds-hnote">Read that mean honestly: it is taken over players this room '
        + 'actually DRAFTED. Consensus players who went undrafted contribute nothing, so a '
        + 'negative room-wide mean is the signature of a room that reaches outside the '
        + 'consensus board — not a claim about every player.</div>';
      const drifts = positionDrift(mockCal);
      const posRows = drifts.length
        ? '<div class="ds-hrow">' + drifts.map((p) => (
          `<span class="ds-hpos${p.picksEarly > 0 ? ' ds-hpos--early' : ''}">`
          + `${esc(p.position)} ${p.picksEarly > 0 ? '−' : '+'}`
          + `${Math.abs(p.picksEarly).toFixed(1)}`
          + `<span class="cd-meta">n=${p.n}</span></span>`
        )).join('') + '</div>'
          + '<div class="ds-hnote">Per position, picks earlier (−) or later (+) than '
          + 'consensus in this room. Only positions with enough observed picks appear.</div>'
        : '';
      const noise = noiseComparison(mockCal).slice(0, 6);
      const noiseRows = noise.length
        ? '<div class="ds-hrow">' + noise.map((n) => (
          `<span class="ds-hnoise">R${n.round} ${n.ratio != null ? `${n.ratio.toFixed(2)}×` : '—'}`
          + `<span class="cd-meta">n=${n.n}</span></span>`
        )).join('') + '</div>'
          + '<div class="ds-hnote">Your room\'s spread against the SIM room\'s assumed spread, '
          + 'per round. Above 1.00× means your real league drafts looser (further off '
          + 'consensus) than the practice room does.</div>'
        : '';
      cal = drift + posRows + noiseRows
        + '<div class="ds-hnote">This is an OPPONENT MODEL and it produces a PICK NUMBER — '
        + 'shown as “gone ~N here” beside consensus ADP while you draft. It feeds no '
        + 'projection, no weight and no ranking.</div>';
    } else {
      cal = '<div class="ds-hcal">ROOM CALIBRATION — NOT MEASURED'
        + (mockCal.drafts > 0
          ? `<span class="cd-meta">${mockCal.picks} of ${MIN_CALIBRATION_PICKS} observed `
            + 'opponent picks</span>'
          : '')
        + `</div><div class="ds-hnote">${esc(mockCal.reason)}</div>`;
    }

    const clear = histArmed
      ? '<button type="button" class="sort-chip auc-mini ds-hclear ds-hclear--armed" '
        + 'data-act="hist-clear">TAP AGAIN TO ERASE HISTORY</button>'
      : '<button type="button" class="sort-chip auc-mini ds-hclear" data-act="hist-clear">'
        + 'CLEAR HISTORY</button>';

    return head + '<div class="ds-hist">'
      + `<div class="ds-hsum">${esc(bits.join(' · '))}</div>`
      + legacy + cal + clear
      + '</div>';
  }

  function draftSetupHtml() {
    const opt = (v, cur, label) => `<option value="${v}"${Number(v) === Number(cur) ? ' selected' : ''}>${label || v}</option>`;
    const slots = [];
    for (let i = 1; i <= draftCfg.leagueSize; i += 1) slots.push(opt(i, draftCfg.mySlot));
    const field = (key, label, optsHtml) => (
      '<label class="ds-field">' +
        `<span class="ds-lbl">${label}</span>` +
        `<select class="ds-select" data-dcfg="${key}">${optsHtml}</select>` +
      '</label>'
    );
    const stepper = (key, label) => {
      const [lo, hi] = ROSTER_BOUNDS[key];
      const opts = [];
      for (let v = lo; v <= hi; v += 1) opts.push(opt(v, draftCfg[key]));
      return field(key, label, opts.join(''));
    };
    /* R27 — BUDGET is typed, not picked. It was a select over
     * BUDGET_CHOICES ($100/$200/$300), which cannot express the $150 and $250
     * leagues that plainly exist, let alone a league that trades dollars. The
     * three old choices survive as a datalist so the common cases are still
     * one tap. Bounds are enforced on commit, not here, so a half-typed "2"
     * on the way to "200" is not rewritten under the cursor. */
    const budgetField = () => (
      '<label class="ds-field">' +
        '<span class="ds-lbl">BUDGET</span>' +
        `<input class="ds-num" type="number" inputmode="numeric" data-dnum="budget" ` +
          `min="${BUDGET_BOUNDS[0]}" max="${BUDGET_BOUNDS[1]}" step="1" ` +
          `value="${draftCfg.budget}" list="ds-budget-choices" aria-label="League auction budget">` +
        `<datalist id="ds-budget-choices">${BUDGET_CHOICES.map((b) => `<option value="${b}"></option>`).join('')}</datalist>` +
      '</label>'
    );
    /* The header must not advertise "$200 BUDGET" for a room where that is only
     * one team's number — the total is the honest summary of an uneven room. */
    const aucBudgetLabel = () => {
      const budgets = effectiveTeamBudgets();
      return budgets.every((b) => b === budgets[0])
        ? `AUCTION · $${budgets[0]} BUDGET`
        : `AUCTION · $${budgets.reduce((s, b) => s + b, 0)} IN THE ROOM · UNEVEN`;
    };
    /* The per-team editor. Collapsed by default and OPEN once the budgets are
     * uneven, so a league that trades dollars never has its own settings
     * hidden behind a disclosure it might not open. Every box is seeded from
     * the league default, so "level" is what you see until you change it. */
    const teamBudgetsHtml = () => {
      if (draftCfg.mode !== 'auction') return '';
      const budgets = effectiveTeamBudgets();
      const level = budgets.every((b) => b === budgets[0]);
      const total = budgets.reduce((s, b) => s + b, 0);
      /* R34 — each seat gains an editable NAME beside its budget. The VALUE is
       * only ever what the owner typed (persisted, nfl2026.auctionteams.v1);
       * the Sleeper fallback lives in the PLACEHOLDER so an untyped box shows
       * what the room will call the team without claiming the owner said it.
       * The cell is a div, not a label: a label may own one control and this
       * tile now holds two, each carrying its own aria-label. */
      const boxes = budgets.map((b, i) => {
        const mine = i === draftCfg.mySlot - 1;
        const typed = typeof teamNames[i] === 'string' ? teamNames[i].trim() : '';
        const fallback = auctionTeamName(i, {
          typedNames: null, sleeperTeams: rosterTeams, leagueSize: draftCfg.leagueSize,
        });
        return '<div class="tb-cell">' +
          `<span class="tb-lbl${mine ? ' tb-lbl--me' : ''}">${mine ? 'YOU' : `T${i + 1}`}</span>` +
          `<input class="tb-name" type="text" autocomplete="off" data-tname="${i}" ` +
            `maxlength="${TEAM_NAME_MAX}" value="${esc(typed)}" placeholder="${esc(fallback.name)}" ` +
            `aria-label="${mine ? 'Your' : `Team ${i + 1}`} name">` +
          `<input class="ds-num tb-num" type="number" inputmode="numeric" data-tbudget="${i}" ` +
            `min="${BUDGET_BOUNDS[0]}" max="${BUDGET_BOUNDS[1]}" step="1" value="${b}" ` +
            `aria-label="${mine ? 'Your' : `Team ${i + 1}`} starting budget">` +
        '</div>';
      }).join('');
      return `<details class="tb-panel"${level ? '' : ' open'}>` +
        '<summary class="lp-summary">PER-TEAM BUDGETS' +
          `<span class="ds-sub-note"> ${level ? `LEVEL · $${budgets[0]} EACH` : `UNEVEN · $${total} IN THE ROOM`}</span>` +
        '</summary>' +
        '<div class="m-explain">Preseason trades can leave teams with different auction ' +
          'dollars. Type what each team actually starts with — the room prices the board ' +
          'against the money really in it, and every threat estimate uses that team\'s own ' +
          'ceiling. Leave it alone if your league starts level.</div>' +
        `<div class="tb-grid">${boxes}</div>` +
        `<button type="button" class="lp-btn" data-act="tb-level">LEVEL ALL TO $${draftCfg.budget}</button>` +
      '</details>';
    };
    const starters = starterSlotCount();
    const rounds = starters + draftCfg.bench;
    // 8/10/12 are the offered sizes; an imported league of any other size keeps
    // its own number in the menu rather than being silently shown as 8.
    const teamsOptions = [...new Set([8, 10, 12, draftCfg.leagueSize])].sort((a, b) => a - b);
    return (
      '<div class="ds-head"><span class="ds-title">DRAFT SIMULATOR</span> ' +
        '<span class="est">ESTIMATE</span></div>' +
      '<div class="m-explain">Mock a full snake draft: your picks come from the VOR engine ' +
        'with a survival forecast for your next turn, and beat-the-room margin is the ' +
        'score. Pick the ROOM to choose who you are drafting against — the three are ' +
        'described under the settings. SIM rooms are practice and are kept as history ' +
        'only; a LIVE draft, where you tap what the real room actually took, is the one ' +
        'thing that measures YOUR league.</div>' +
      `<div class="ds-sub"><span>LEAGUE</span><span class="ds-sub-note">${draftCfg.mode === 'auction' ? aucBudgetLabel() : 'SNAKE DRAFT'}</span></div>` +
      '<div class="ds-grid ds-grid--league">' +
        field('mode', 'FORMAT',
          `<option value="snake"${draftCfg.mode === 'snake' ? ' selected' : ''}>SNAKE</option>` +
          `<option value="auction"${draftCfg.mode === 'auction' ? ' selected' : ''}>AUCTION</option>`) +
        field('play', 'PLAY',
          `<option value="sim"${draftCfg.play === 'sim' ? ' selected' : ''}>SIM (practice)</option>` +
          `<option value="live"${draftCfg.play === 'live' ? ' selected' : ''}>LIVE (my real draft)</option>`) +
        field('leagueSize', 'TEAMS', teamsOptions.map((n) => opt(n, draftCfg.leagueSize)).join('')) +
        field('mySlot', 'MY SLOT', slots.join('')) +
        (draftCfg.mode === 'auction'
          ? budgetField()
          : field('roomType', 'ROOM', roomOptionsHtml())) +
      '</div>' +
      teamBudgetsHtml() +
      roomKeyHtml() +
      `<div class="ds-sub"><span>ROSTER</span><span class="ds-sub-note">${starters} STARTERS + ${draftCfg.bench} BENCH · ${rounds} ROUNDS</span></div>` +
      '<div class="ds-grid ds-grid--roster">' +
        stepper('qb', 'QB') + stepper('rb', 'RB') + stepper('wr', 'WR') +
        stepper('te', 'TE') + stepper('flex', 'FLEX') +
        // R28 — K and DEF are settable at last. R27 made them draftable and
        // gave rosterShape k/def, but nothing in this grid could SET them, so
        // the only way to have a kicker was a Sleeper import: a hand-built
        // league could not say it seats one, and the settings card had to
        // confess exactly that. Bounded [0,1] by ROSTER_BOUNDS — a league
        // starting two kickers is not a shape this app prices.
        stepper('k', 'K') + stepper('def', 'DEF') +
        stepper('bench', 'BENCH') +
      '</div>' +
      leaguePanelHtml() +
      (draftCfg.mode === 'auction'
        ? `<button type="button" class="cand-add ds-start" data-act="auc-start">START ${draftCfg.play === 'live' ? 'LIVE ' : ''}AUCTION · $${draftCfg.budget} · ${rounds} SLOTS</button>`
        : `<button type="button" class="cand-add ds-start" data-act="draft-start">START ${draftCfg.play === 'live' ? 'LIVE ' : ''}DRAFT · ${rounds} ROUNDS</button>`) +
      historyPanelHtml()
    );
  }

  /** The LIVE tap list: every untaken board row that matches the filter, in
   * board (consensus) order, capped only for render size. Split out so the
   * filter can repaint the list alone and keep the input focused. */
  function liveTakePoolHtml() {
    const q = liveTakeQuery.trim().toLowerCase();
    const hits = [];
    let matched = 0;
    for (let i = 0; i < draft.board.length; i += 1) {
      if (draft.taken.has(i)) continue;
      const row = draft.board[i];
      if (q && !String(row.name).toLowerCase().includes(q)
        && String(row.position).toLowerCase() !== q) continue;
      matched += 1;
      if (hits.length < LIVE_TAKE_CAP) hits.push({ i, row });
    }
    const more = matched - hits.length;
    return '<div class="auc-pool auc-pool--live">' +
      hits.map((c) => (
        `<button type="button" class="sort-chip auc-poolchip" data-act="draft-live-take" data-bi="${c.i}">` +
          `${esc(c.row.name)} <span class="cd-meta">${esc(c.row.position)} · ADP ${c.row.adp}</span></button>`
      )).join('') +
      (more > 0 ? `<div class="cd-meta ds-livemore">+ ${more} more — type a name</div>` : '') +
      (matched === 0 ? '<div class="cd-meta ds-livemore">no untaken player matches that filter</div>' : '') +
      '</div>';
  }

  /* R33 — THE LIVE SLEEPER DRAFT COMPANION, view side.
   *
   * app/draft-live.js owns everything hard: the polling, the pick diffing,
   * the slot maps, the refusal rules and the paused-not-corrupted clock
   * check. This view contributes exactly three things: a description of the
   * open room (companionRoomCtx), a router that applies each planned action
   * through the SAME functions a manual tap calls (applyCompanionAction — so
   * the tendency/calibration/memory side effects are byte-identical to hand
   * entry), and the strip that renders the companion's state verbatim
   * (companionHtml — the status line is the module's honesty surface, and
   * this view does not editorialise it). */
  function companionRoomCtx() {
    const team = rosterTeams && rosterTeamIdx >= 0 ? rosterTeams[rosterTeamIdx] : null;
    const hints = team
      ? { rosterId: team.roster_id, userId: team.owner_id }
      : {};
    if (draft && draft.play === 'live' && !draft.done) {
      return {
        mode: 'snake',
        mySlot: draft.mySlot,
        leagueSize: draft.leagueSize,
        roomPick: draft.pick,
        board: draft.board,
        isTaken: (bi) => draft.taken.has(bi),
        canBuy: null,
        slotHints: hints,
        isDone: () => !!draft.done,
      };
    }
    if (auction && auction.play === 'live' && !auction.done) {
      return {
        mode: 'auction',
        mySlot: auction.mySlot,
        leagueSize: auction.leagueSize,
        roomPick: 0,
        board: auction.board,
        isTaken: (bi) => auction.taken.has(bi),
        canBuy: (i) => !!auction.teams[i]
          && auction.teams[i].players.length < auction.shape.size,
        slotHints: hints,
        isDone: () => !!auction.done,
      };
    }
    return null;
  }

  function applyCompanionAction(action) {
    if (action.type === 'my-pick' && draft) {
      takeMyPick(draft, action.boardIdx);
      if (draft.done) finishDraft();
      return { ok: true };
    }
    if (action.type === 'opponent-pick' && draft) {
      takeOpponentPickAt(draft, action.boardIdx);
      if (draft.done) finishDraft();
      return { ok: true };
    }
    if (action.type === 'sale' && auction) {
      // The exact engine path the manual auc-sold handler takes: sellTo owns
      // the log, the tendencies, the inflation base and (via recordAuction at
      // the end) the R32 memory. A refusal is reported, never swallowed.
      if (sellTo(auction, action.buyerIdx, action.amount, action.boardIdx) === null) {
        // R34 — the buyer is NAMED here too (typed > synced > T{n}), the same
        // seatLabel every other auction surface threads.
        return { ok: false,
          reason: `${seatLabel(action.buyerIdx, auction.mySlot)} has no open roster spot for `
            + `Sleeper pick #${action.pick.pick_no} — record it by hand and tap RESOLVED.` };
      }
      if (auction.block && auction.block.boardIdx === action.boardIdx) {
        auction.block = null; bidAdj = 0; resetSoldEntry();
      }
      if (auction.done) finishAuction();
      return { ok: true };
    }
    return { ok: false, reason: `no route for a ${action.type} action` };
  }

  function armCompanion() {
    const leagueId = parseLeagueId(sleeperId);
    if (!leagueId) {
      aucRefusal = null;
      compNote = 'Enter your Sleeper league id or URL in the SLEEPER field above, then ARM '
        + '— the companion polls that league\'s draft.';
      paintDraft();
      return;
    }
    compNote = null;
    if (!companion) {
      companion = createCompanion({
        leagueId,
        getRoom: companionRoomCtx,
        apply: applyCompanionAction,
        getIndex: () => sleeperIndex,
        setIndex: (idx) => { sleeperIndex = idx; },
        buildIndex: buildSleeperPlayerIndex,
        onChange: (c, applied) => {
          if (retired()) { c.stop('left the page'); return; }
          if (applied > 0) { syncLiveRoom(); paintAll(); return; }
          // No pick applied: the strip alone repaints (status text, pending
          // list, blocked reason) — a full paint every 5s poll would fight
          // the manager's own typing in the live-take filter.
          const strip = el.querySelector('#comp-strip');
          if (strip) strip.outerHTML = companionHtml();
        },
      });
    }
    companion.arm();
  }

  let compNote = null;   // one-line arming hint when the league id is missing

  function companionHtml() {
    const ctx = companionRoomCtx();
    if (!ctx) return '';
    const st = companion ? companion.state : null;
    const line = st ? companionStatus(st, Date.now())
      : (compNote || 'OFF — picks are recorded by hand until you ARM.');
    const armed = !!(st && st.armed);
    let extra = '';
    if (st && st.detectedSlot && st.detectedSlot !== ctx.mySlot) {
      extra += `<div class="m-explain">Sleeper says your draft slot is ${st.detectedSlot}; `
        + `this room is set to ${ctx.mySlot}. If Sleeper is right, EXIT and restart the `
        + 'room with MY SLOT corrected — the companion will not silently re-seat you.</div>';
    }
    if (st && st.blocked) {
      extra += `<div class="ds-sheet ds-sheet--warn">${esc(st.blocked.reason)} `
        + `<button type="button" class="sort-chip" data-act="comp-ack" `
        + `data-pickno="${st.blocked.pick.pick_no}">RESOLVED BY HAND</button></div>`;
    }
    if (st && st.pending.length) {
      extra += st.pending.map((p) => (
        `<div class="ds-sheet ds-sheet--warn">Pick #${p.pick.pick_no} `
        + `${esc(p.pick.name || p.pick.player_id)}: ${esc(p.message
          || (p.type === 'needs-price' ? 'Sleeper reported no price — record the sale by hand.'
            : p.type === 'needs-buyer' ? 'The buyer could not be mapped — record the sale by hand.'
              : 'unmatched'))} `
        + `<button type="button" class="sort-chip" data-act="comp-ack" `
        + `data-pickno="${p.pick.pick_no}">RESOLVED BY HAND</button></div>`
      )).join('');
    }
    return '<div id="comp-strip">'
      + '<div class="ds-sheet">'
      + `<span id="companion-status">SLEEPER COMPANION: ${esc(line)}</span> `
      + (armed
        ? '<button type="button" class="sort-chip" data-act="comp-stop">DISARM</button>'
        : '<button type="button" class="sort-chip" data-act="comp-arm">ARM</button>')
      + '</div>' + extra + '</div>';
  }

  function draftLiveHtml() {
    const clock = onTheClock(draft);
    const myTurn = clock === draft.mySlot - 1;
    const round = Math.floor(draft.pick / draft.leagueSize) + 1;
    const logTail = draft.log.slice(-5).map((l) => (
      `<div class="ds-log">#${l.pick} T${l.team} ${esc(l.name)} <span class="cd-meta">${esc(l.position)} · ADP ${l.adp}</span>${l.team === draft.mySlot ? ' <b class="ds-me">YOU</b>' : ''}</div>`
    )).join('');
    let body = '';
    if (draft.done) {
      body = '<div class="state">Draft complete — see the results below.</div>';
    } else if (!myTurn && draft.play === 'live') {
      // LIVE: the real room is picking — tap what actually happened.
      // EVERY untaken board row must be reachable. This log is the only
      // admissible evidence for roomCalibration(), and an off-consensus pick
      // (a superflex QB, a deep reach) is exactly the observation that matters
      // most; a short consensus-ordered list would censor the sample on the
      // tail it is meant to measure, and force the manager to tap the wrong
      // player to keep going. Hence: a name filter over the whole board, plus
      // a scrolling list instead of a 15-row cut-off.
      body =
        `<div class="ds-turn">TEAM ${clock + 1} IS ON THE CLOCK — tap the player they took</div>` +
        '<input type="search" class="ds-livefind" data-lfind="1" autocomplete="off"'
          + ` placeholder="filter any player on the board" value="${esc(liveTakeQuery)}">`
        + liveTakePoolHtml();
    } else if (!myTurn) {
      body = `<button type="button" class="cand-add" data-act="draft-sim">SIM TO MY PICK</button>`;
    } else {
      // MY TURN: top-5 projected + eligible candidates by VOR, with survival.
      const counts = draft.rosters[draft.mySlot - 1].counts;
      const cands = [];
      for (let i = 0; i < draft.board.length && cands.length < 40; i += 1) {
        if (draft.taken.has(i)) continue;
        const row = draft.board[i];
        if (!row.gsis_id) continue;                       // never recommend unprojected
        const cap = POSITION_CAPS[row.position] != null ? POSITION_CAPS[row.position] : Infinity;
        if ((counts[row.position] || 0) >= cap) continue; // no 3rd QB advice either
        cands.push({ i, row, pts: draft.adjOf(row) });
      }
      cands.sort((a, b) => b.pts - a.pts);
      const top = cands.slice(0, 5);
      const until = picksUntilMyNext({ ...draft, pick: draft.pick + 1 }) + 1;
      const surv = survivalProbabilities(
        top.map((c) => c.i), draft.board, draft.rosters, draft.shape,
        draft.roomType, draft.adjOf, draft.pick, until, draft.leagueSize,
        // The AI+ room's own context, so the lookahead simulates the SAME
        // opponents the room is drafting with (a default profile would model a
        // room this manager is not in).
        draft.mySlot - 1, draft.seed + draft.pick, 150, draft.ai || null);
      body =
        `<div class="ds-turn">YOUR PICK — ROUND ${round}</div>` +
        top.map((c) => {
          const sp = surv.get(c.i);
          const pct = sp != null ? Math.round(sp * 100) : null;
          const risk = pct != null
            ? `<span class="ds-surv${pct < 40 ? ' ds-surv--hot' : ''}">${pct}% survives to your next pick</span>`
            : '';
          // CONSUMPTION PATH for the LIVE-room calibration (app/mocks.js):
          // where this room, measured from your own recorded live drafts,
          // actually takes a player at that consensus ADP. A PICK NUMBER —
          // never points, never a value, never an input to c.pts.
          //
          // TWO HONESTY RULES on the chip:
          //  1. "HERE" MEANS THE ROOM ON SCREEN. The number is measured from
          //     the manager's recorded LIVE drafts, so it describes THEIR real
          //     room. In a SIM room the opponents are draft-sim.js's own
          //     sampler — a different room — so "here" would be false. The
          //     chip stays (a practice room is practice FOR that league) but
          //     it is relabelled "your room: ~N" and says so in the tooltip.
          //  2. NEVER IN THE PAST. The player is demonstrably still on the
          //     board at this pick, so a claim that the room took him at or
          //     before it is contradicted by what the manager is looking at.
          //     expectedGoneBy clamps to >= 1, which piles every reach onto
          //     pick 1 — exactly the contradiction this gate drops.
          const curPick = Math.min(draft.pick + 1, draft.totalPicks);
          const isLive = draft.play === 'live';
          const gone = expectedGoneBy(c.row.adp, c.row.position, mockCal);
          const goneTxt = gone != null && gone > curPick
            && Math.abs(gone - Number(c.row.adp)) >= 1
            ? ` · <span class="ds-gone" title="Measured from your recorded LIVE drafts: `
              + `${mockCal.picks} observed opponent picks across ${mockCal.drafts} room(s). `
              + `Consensus ADP is ${esc(c.row.adp)}; your room takes him around pick `
              + `${gone}.`
              + (isLive ? '' : ' These opponents are the practice sampler, not that room.')
              + `">${isLive ? `gone ~${gone} here` : `your room: ~${gone}`}</span>`
            : '';
          return (
            `<div class="ds-cand">` +
              `<span class="cd-name">${esc(c.row.name)}</span>` +
              `<span class="cd-meta">${esc(c.row.position)} · ADP ${c.row.adp}${goneTxt} · ${fix1(c.pts)} pts</span>` +
              risk +
              `<button type="button" class="cand-add" data-act="draft-pick" data-bi="${c.i}">PICK</button>` +
            '</div>'
          );
        }).join('');
    }
    return (
      '<div class="ds-head"><span class="ds-title">' +
        `${draft.play === 'live' ? 'LIVE DRAFT' : 'DRAFT SIMULATOR'} · ` +
        `${esc(ROOM_LABELS[draft.roomType] || 'ADP')} ROOM</span> ` +
        `<span class="ds-status">PICK ${Math.min(draft.pick + 1, draft.totalPicks)}/${draft.totalPicks}</span> ` +
        (draft.play === 'live' && draft.log.length
          ? '<button type="button" class="sort-chip auc-mini" data-act="draft-undo">UNDO</button> '
          : '') +
        '<button type="button" class="sort-chip" data-act="draft-close">EXIT</button></div>' +
      // R33 — the companion strip renders only in a LIVE room (companionRoomCtx
      // returns null otherwise), directly under the header so the ARM control
      // and the sync status sit where the manager is already looking.
      (draft.play === 'live' ? companionHtml() : '') +
      logTail + body
    );
  }

  function draftResultHtml() {
    const r = draftResult;
    const my = draft.rosters[draft.mySlot - 1].players
      .map((p) => `<span class="ds-pick">${esc(p.position)} ${esc(p.name)}</span>`).join(' ');
    const beat = r.margin >= 0;
    return (
      '<div class="ds-head"><span class="ds-title">MOCK RESULT</span> ' +
        '<button type="button" class="sort-chip" data-act="draft-close">NEW DRAFT</button></div>' +
      `<div class="ds-score ${beat ? 'ds-score--win' : 'ds-score--loss'}">` +
        `${beat ? 'BEAT' : 'LOST TO'} THE ${esc(ROOM_LABELS[draft.roomType] || 'ADP')} ROOM BY ` +
        `${fix1(Math.abs(r.margin))} PTS</div>` +
      `<div class="ds-sheet">You ${fix1(r.mine)} · room avg ${fix1(r.roomAvg)} · ` +
        `rank ${r.rank}/${r.teams} <span class="est">ESTIMATE</span></div>` +
      `<div class="ds-roster">${my}</div>` +
      // WHAT THIS RECORD ACTUALLY DOES. It used to say the fit engine refits
      // from it; nothing read the record at all. A SIM room's opponents ARE
      // this app's own sampler, so it is history and says so. A LIVE room is a
      // transcript of a real draft, and its opponent picks are the only thing
      // here that measures anything.
      (draft.play === 'live'
        ? '<div class="m-explain">Saved to DRAFT HISTORY, and its opponent picks are '
          + 'evidence: comparing what this room took to consensus ADP is how the '
          + '“gone ~N here” number gets measured. It changes no projection and no '
          + 'weight — it is an opponent model, and it is a pick number.</div>'
        : '<div class="m-explain">Saved to DRAFT HISTORY. A SIM room teaches nothing about '
          + 'a real league: the opponents were this app\'s own sampler, so measuring them '
          + 'would only measure the model that produced them. Run a LIVE draft — tapping '
          + 'what your real room takes — to calibrate anything.</div>')
    );
  }

  /* ---- AUCTION room painters ------------------------------------------------ */

  const dollar = (n) => `$${Math.round(n)}`;

  function aucToggles() {
    const b = (act, on, lbl) => (
      `<button type="button" class="sort-chip auc-toggle${on ? ' auc-toggle--on' : ''}" data-act="${act}" aria-pressed="${on}">${lbl}</button>`
    );
    return (
      '<div class="auc-togglebar">' +
        b('auc-style', strategy.style === 'stars', strategy.style === 'stars' ? 'STARS & SCRUBS' : 'BALANCED') +
        b('auc-tempo', strategy.tempo === 'aggressive', strategy.tempo === 'aggressive' ? 'AGGRESSIVE' : 'PATIENT') +
        b('auc-enforce', strategy.enforce, `ENFORCE ${strategy.enforce ? 'ON' : 'OFF'}`) +
      '</div>'
    );
  }

  /* ---- R23-S1: the room's likely price, beside OUR dollars -------------------
   *
   * OURS and INFL-ADJ are this app's own numbers: value over replacement from
   * our projections, times live inflation. MARKET is the OPPONENT MODEL — what
   * this room is likely to pay — and app/auction.js now builds it from ESPN's
   * published `auction_value` whenever the board carries any, instead of the
   * ADP-rank decay it always used. That is a real change in what the number
   * means, so it is labelled, and it carries the app's ONE display-only badge
   * verbatim (MARKET_BADGE above, identical to app/views/model.js and
   * app/views/players.js). A market price never enters `fair`, `adjusted`,
   * `bidTo` or `cap` — validate_data.py MARKET_PRICE_FIELDS is the data-side
   * half of the same rule.
   */
  function aucPriceRow(g) {
    const src = g.marketSource === 'auction'
      ? `ESPN's average winning bid, restated in this $${auction.budget} room`
      : (g.marketSource === 'given'
        ? 'the dollar curve this room was started with'
        : 'modelled from ADP rank — ESPN publishes no auction values on this board');
    const title = `OURS ${dollar(g.fair)} is our own price: value over replacement from our `
      + `projections. INFL-ADJ ${dollar(g.adjusted)} is that price times the room's live `
      + `inflation. MARKET ${dollar(g.market)} is what the ROOM is likely to pay — ${src}. `
      + 'The market number is an opponent model and a comparison only: it is never an input '
      + 'to our valuation, our max bid, or any projection.';
    return (
      `<div class="auc-prices" title="${esc(title)}">`
        + `OURS ${dollar(g.fair)} · INFL-ADJ ${dollar(g.adjusted)} · `
        + `<span class="auc-mkt">MARKET ${dollar(g.market)}</span> `
        + MARKET_BADGE
      + '</div>'
      + `<div class="auc-mktsrc">Room price ${esc(src)}.</div>`
    );
  }

  function aucRoomZone() {
    const infl = liveInflation(auction);
    const pct = Math.round((infl - 1) * 100);
    const gauge =
      `<div class="auc-infl${pct > 3 ? ' auc-infl--hot' : pct < -3 ? ' auc-infl--cold' : ''}">` +
        `INFLATION ${pct >= 0 ? '+' : ''}${pct}% <span class="cd-meta">${pct > 3 ? 'players selling rich — patience pays' : pct < -3 ? 'bargains ahead — money is scarce' : 'prices near fair'}</span></div>`;
    const rows = auction.teams.map((t, i) => {
      const open = auction.shape.size - t.players.length;
      const cap = maxBid(t.budget, open);
      const counts = {};
      t.players.forEach((pp) => { counts[pp.position] = (counts[pp.position] || 0) + 1; });
      const needs = ['QB', 'RB', 'WR', 'TE']
        .filter((pos) => (counts[pos] || 0) < (auction.shape.starterDemand[pos] || 0))
        .slice(0, 2).join(' ') || '—';
      const tend = Object.entries(t.tendencies)
        .filter(([, v]) => v >= 1.15).map(([pos]) => pos);
      const me = i === auction.mySlot - 1;
      return (
        `<div class="auc-team${me ? ' auc-team--me' : ''}${cap <= MIN_BID ? ' auc-team--broke' : ''}">` +
          // R34 — seats carry NAMES now (typed > synced Sleeper > T{n}),
          // display-threading only: the ledger still keys every seat by index,
          // and my seat keeps its YOU marker beside a name (seatLabel).
          `<span class="auc-tname">${esc(seatLabel(i, auction.mySlot))}</span>` +
          `<span>${dollar(t.budget)}</span>` +
          `<span class="cd-meta">max ${dollar(cap)}</span>` +
          `<span class="cd-meta">${esc(needs)}</span>` +
          (tend.length ? `<span class="auc-tend" title="learned from observed sales">overpays ${esc(tend.join('/'))}</span>` : '<span></span>') +
        '</div>'
      );
    }).join('');
    return `<div class="auc-zone auc-zone--room"><div class="auc-zhead">ROOM</div>${gauge}${rows}</div>`;
  }

  function aucBlockZone() {
    const live = draftCfg.play === 'live' && auction.play === 'live';
    if (auction.block) {
      const bi = auction.block.boardIdx;
      const row = auction.board[bi];
      const g = myGuidance(auction, bi, strategy);
      const advised = g.needIt ? g.bidTo
        : (strategy.enforce ? Math.max(0, Math.round(g.adjusted * 0.85)) : 0);
      const myMax = Math.max(0, Math.min(g.cap, advised + bidAdj));
      const chip = g.class === 'BAIT'
        ? '<span class="auc-cls auc-cls--bait">MARKET OVERPRICES · LET THEM SPEND</span>'
        : g.class === 'TARGET'
          ? '<span class="auc-cls auc-cls--target">UNDERVALUED · OUR GUY</span>'
          : '<span class="auc-cls">FAIRLY PRICED</span>';
      const verdict = g.needIt
        ? `BID TO ${dollar(myMax)}, THEN OUT`
        : (strategy.enforce && myMax > 0 ? `ENFORCE TO ${dollar(myMax)} — don't win cheap for them` : 'NOT MY PLAYER — PASS');
      const threats = g.threats.length
        ? `<div class="cd-meta">${g.threats.length} team${g.threats.length > 1 ? 's' : ''} can fight you: ${g.threats.map((t) => `${esc(seatLabel(t.team - 1, auction.mySlot))}(${dollar(t.estWill)})`).join(' ')}</div>`
        : '<div class="cd-meta">no credible threats at that number</div>';
      const soldBase = Math.max(1, g.adjusted + bidAdj); // shown as a HINT only (R34)
      // The picker offers only teams that can legally take another player
      // (auction.js buyerOptions/canBuy). A team at shape.size is not an
      // option at all, so the manager cannot tap a sale the engine will refuse.
      const buyers = live ? buyerOptions(auction) : [];
      /* R27 made the observed price TYPEABLE; R34 makes typing it MANDATORY,
       * and the buyer selection with it (owner's words: "when you press take,
       * you have to type in the auction value spent and select the team name
       * it went to"). The price field starts EMPTY on every block — our
       * estimate appears as PLACEHOLDER text only, never as a value, so a
       * recorded price is always a fact the manager stated. The select opens
       * on a no-buyer placeholder for the same reason. RECORD SALE stays
       * disabled until BOTH are set (kept live by the input/change listeners
       * below, no repaint), and a submit that slips through anyway is refused
       * by validateSoldEntry — never recorded as $0 or as the seed. The -/+
       * chips still correct a TYPED price by a dollar; with nothing typed
       * they do nothing, because there is no fact to correct. */
      const soldControls = live
        ? '<div class="auc-soldrow">SOLD TO ' +
          '<select class="ds-select auc-soldteam" aria-label="Team that bought this player">' +
            `<option value=""${soldBuyer == null ? ' selected' : ''}>— pick buyer —</option>` +
            `${buyers.map((i) => `<option value="${i}"${soldBuyer === i ? ' selected' : ''}>${esc(seatLabel(i, auction.mySlot))}</option>`).join('')}</select>` +
          ' FOR <span class="auc-soldwrap">$<input class="ds-num auc-soldprice" type="number" ' +
            `inputmode="numeric" min="0" step="1" value="${soldTyped == null ? '' : soldTyped}" ` +
            `placeholder="${soldBase}?" aria-label="Price this player actually sold for — ` +
            `our estimate is $${soldBase}; type what the room really paid"></span>` +
          '<button type="button" class="sort-chip" data-act="auc-price-minus">−</button>' +
          '<button type="button" class="sort-chip" data-act="auc-price-plus">+</button>' +
          `<button type="button" class="cand-add" data-act="auc-sold"${soldTyped != null && soldBuyer != null && buyers.length ? '' : ' disabled'}>RECORD SALE</button></div>`
        : '<div class="auc-bidrow">' +
          '<button type="button" class="sort-chip" data-act="auc-bid-minus">−</button>' +
          `<span class="auc-bidnum">${dollar(myMax)}</span>` +
          '<button type="button" class="sort-chip" data-act="auc-bid-plus">+</button>' +
          `<button type="button" class="cand-add" data-act="auc-bid" data-max="${myMax}">BID TO ${dollar(myMax)}</button>` +
          '<button type="button" class="sort-chip" data-act="auc-bid" data-max="0">PASS</button></div>';
      return (
        '<div class="auc-zone auc-zone--block"><div class="auc-zhead">THE BLOCK ' +
          '<button type="button" class="sort-chip auc-mini" data-act="auc-cancel" title="Wrong player? Return to nomination">✕ SWAP</button></div>' +
          // R27 — K/DST reach the block now, and they carry no ADP (they are
          // not in adp.json at all). Printing "ADP undefined" would be the app
          // stating a fact it does not have; say NO ADP instead.
          `<div class="auc-player"><span class="cd-name">${esc(row.name)}</span> <span class="cd-meta">${esc(row.position)} · ${Number.isFinite(Number(row.adp)) ? `ADP ${row.adp}` : 'NO ADP'}</span></div>` +
          aucPriceRow(g) +
          chip +
          `<div class="auc-verdict">⚡ ${verdict}</div>` +
          threats + soldControls +
          (aucRefusal ? `<div class="auc-refusal">${esc(aucRefusal)}</div>` : '') +
        '</div>'
      );
    }
    // No player on the block: nomination phase.
    const nomTeam = onTheNomination(auction);
    const mine = nomTeam === auction.mySlot - 1;
    const adv = nominationAdvice(auction, strategy);
    const advHtml =
      (adv.suggestion
        ? `<div class="auc-nomadv">🎣 BAIT: <b>${esc(adv.suggestion.name)}</b> (mkt ${dollar(adv.suggestion.market)}, ours ${dollar(adv.suggestion.fair)}) — ${esc(adv.suggestion.why)} <button type="button" class="cand-add" data-act="auc-nom" data-bi="${adv.suggestion.boardIdx}">NOMINATE</button></div>`
        : '') +
      (adv.targets.length
        ? `<div class="auc-nomadv">🎯 HOLD (our value, buy late): ${adv.targets.map((t) => `<b>${esc(t.name)}</b> ${dollar(t.fair)}v${dollar(t.market)}`).join(' · ')}</div>`
        : '');
    const pool = [];
    for (let i = 0; i < auction.board.length && pool.length < 12; i += 1) {
      if (!auction.taken.has(i)) pool.push({ i, row: auction.board[i] });
    }
    const poolHtml = '<div class="auc-pool">' + pool.map((c) => (
      `<button type="button" class="sort-chip auc-poolchip" data-act="auc-nom" data-bi="${c.i}">${esc(c.row.name)} <span class="cd-meta">${esc(c.row.position)}</span></button>`
    )).join('') + '</div>';
    const undoBtn = auction.log.length
      ? '<button type="button" class="sort-chip auc-mini" data-act="auc-undo" title="Reverse the last recorded sale exactly">UNDO LAST SALE</button>'
      : '';
    const finderHint =
      '<div class="cd-meta">…or search the PLAYER FINDER below — every row can nominate.</div>';
    if (mine || live) {
      return (
        `<div class="auc-zone auc-zone--block"><div class="auc-zhead">THE BLOCK ${undoBtn}</div>` +
          `<div class="ds-turn">${mine ? 'YOUR NOMINATION' : `TEAM ${nomTeam + 1} NOMINATES — tap who they put up`}</div>` +
          (mine ? advHtml : '') + poolHtml + finderHint +
        '</div>'
      );
    }
    return (
      `<div class="auc-zone auc-zone--block"><div class="auc-zhead">THE BLOCK ${undoBtn}</div>` +
        `<div class="ds-turn">TEAM ${nomTeam + 1} TO NOMINATE</div>` +
        '<button type="button" class="cand-add" data-act="auc-sim-nom">SIM NOMINATION</button>' +
      '</div>'
    );
  }

  function aucBuildZone() {
    const me = aucMyTeam(auction);
    // R30b — MY money, not the league default (aucStartingBudget). With a $150
    // YOU in a $200 room this panel opened saying "$150 LEFT of $200" with the
    // spend bar 25% filled and a slot plan for $194 of money I do not have.
    // scoreAuction already reads teamBudgets for the same reason; the plan,
    // the label and the bar denominator now read the same number it does.
    const myStart = aucStartingBudget(auction);
    const plan = planBudget(auction.shape, myStart, strategy.style);
    const spent = myStart - me.budget;
    // Greedy: match my buys to plan slots by descending price for the display.
    const buys = auction.log.filter((l) => l.team === auction.mySlot)
      .sort((a, b) => b.price - a.price);
    const rows = plan.slots.map((slot, i) => {
      const buy = buys[i];
      return (
        '<div class="auc-plan">' +
          `<span class="cd-meta">${esc(slot.slot)}</span>` +
          `<span>${dollar(slot.planned)} planned</span>` +
          (buy ? `<span class="auc-bought">${esc(buy.name)} ${dollar(buy.price)}</span>` : '<span class="cd-meta">—</span>') +
        '</div>'
      );
    }).join('');
    // R34 — a typed/synced name joins the MY BUILD header, KEEPING the YOU
    // marker (seatLabel appends " · YOU" whenever a name replaces the bare
    // default) — display only, the plan below stays index-driven.
    const myName = seatName(auction.mySlot - 1);
    return (
      '<div class="auc-zone auc-zone--build"><div class="auc-zhead">MY BUILD' +
        `${myName.source === 'default' ? '' : ` · ${esc(seatLabel(auction.mySlot - 1, auction.mySlot))}`}</div>` +
        `<div class="auc-budget">${dollar(me.budget)} LEFT <span class="cd-meta">of $${myStart} · max bid ${dollar(maxBid(me.budget, auction.shape.size - me.players.length))} · $1 bench x ${plan.benchDollars}</span></div>` +
        `<div class="auc-budgetbar"><span style="width:${Math.min(100, (spent / myStart) * 100).toFixed(0)}%"></span></div>` +
        rows +
      '</div>'
    );
  }

  function auctionRoomHtml() {
    // R30b — "$${auction.budget}" here was the league default, which in an
    // uneven room is nobody's number (the setup card directly above already
    // said "IN THE ROOM · UNEVEN"). Same summary rule as aucBudgetLabel():
    // a level room's one true number, else the room's total, flagged UNEVEN.
    const starts = auction.teamBudgets || [];
    const headBudget = starts.length && starts.every((b) => b === starts[0])
      ? `$${starts[0]}`
      : (starts.length
        ? `$${totalRoomMoney(auction)} IN THE ROOM · UNEVEN`
        : `$${auction.budget}`);
    return (
      '<div class="ds-head"><span class="ds-title">' +
        `${auction.play === 'live' ? 'LIVE AUCTION' : 'AUCTION SIMULATOR'} · ${headBudget}</span> ` +
        `<span class="ds-status">${auction.log.length}/${auction.leagueSize * auction.shape.size} SOLD</span> ` +
        '<button type="button" class="sort-chip" data-act="auc-close">EXIT</button></div>' +
      // R33 — LIVE auctions get the companion too: Sleeper's auction picks
      // carry the winning bid, so armed sales flow through sellTo with the
      // real buyer and the real dollars.
      (auction.play === 'live' ? companionHtml() : '') +
      aucMemoryHtml() +
      aucToggles() +
      '<div class="auc-room">' + aucRoomZone() + aucBlockZone() + aucBuildZone() + '</div>'
    );
  }

  /* Auction-memory S4 — what the room learned from PAST drafts, said plainly.
   *
   * auction.memory is seedTendencies' summary: when active, the opponents in
   * THIS room opened at per-position priors fitted to the sale prices real
   * rooms actually paid (LIVE auctions only, shrunk hard toward 1.0 at low
   * sample counts — see TENDENCY_PRIOR_K). When inactive, the engine says WHY
   * in `reason`, written to be user-facing, and this card prints it verbatim
   * rather than implying a memory that is not there. Only positions whose seed
   * actually moved (≥ 1% off the 1.0 prior) are listed — printing "RB ×1.00"
   * would dress the prior up as a finding. */
  function aucMemoryHtml() {
    const m = auction && auction.memory;
    if (!m) return '';
    if (!m.active) {
      return `<div class="m-explain">ROOM MEMORY: off — ${esc(m.reason || 'no usable history')}.</div>`;
    }
    const parts = Object.keys(m.byPosition).sort()
      .filter((pos) => Math.abs(m.byPosition[pos].seeded - 1) >= 0.01)
      .map((pos) => `${esc(pos)} ×${m.byPosition[pos].seeded.toFixed(2)} `
        + `(${m.byPosition[pos].n} sales)`);
    if (!parts.length) {
      return `<div class="m-explain">ROOM MEMORY: ${m.drafts} LIVE `
        + `draft${m.drafts === 1 ? '' : 's'} on record — every seeded tendency is `
        + 'within 1% of the market prior, so the room opens effectively unseeded.</div>';
    }
    return `<div class="m-explain">ROOM MEMORY: opponents open at tendencies learned `
      + `from ${m.drafts} LIVE draft${m.drafts === 1 ? '' : 's'} (${m.sales} observed `
      + `sales, shrunk toward 1.0 at low counts): ${parts.join(' · ')}. In-room `
      + 'bidding keeps re-teaching these live.</div>';
  }

  /* R30 — the starting slots a finished draft left empty, or '' when the lineup
   * is complete. Worded as a warning rather than a stat because it invalidates
   * the number printed directly above it: a total that silently counted two
   * empty seats as 0.0 is not a score, it is an incomplete roster. */
  function emptySlotsHtml(slots) {
    if (!Array.isArray(slots) || !slots.length) return '';
    const names = slots.map((s) => esc(String(s))).join(', ');
    return `<div class="ds-sheet ds-sheet--warn">${slots.length === 1 ? 'SLOT' : 'SLOTS'} `
      + `NEVER FILLED: ${names} — the total above counts ${slots.length === 1 ? 'it' : 'them'} `
      + 'as 0.0, so this lineup cannot legally be started.</div>';
  }

  function auctionResultHtml() {
    const r = auctionResult;
    const beat = r.margin >= 0;
    const my = aucMyTeam(auction).players
      .map((pp) => `<span class="ds-pick">${esc(pp.position)} ${esc(pp.name)}</span>`).join(' ');
    return (
      '<div class="ds-head"><span class="ds-title">AUCTION RESULT</span> ' +
        '<button type="button" class="sort-chip" data-act="auc-close">NEW AUCTION</button></div>' +
      `<div class="ds-score ${beat ? 'ds-score--win' : 'ds-score--loss'}">` +
        `${beat ? 'BEAT' : 'LOST TO'} THE ROOM BY ${fix1(Math.abs(r.margin))} PTS</div>` +
      `<div class="ds-sheet">You ${fix1(r.mine)} · room avg ${fix1(r.roomAvg)} · rank ${r.rank}/${r.teams} · ` +
        `spent ${dollar(r.spent)} · ${r.ptsPerDollar} pts/$ <span class="est">ESTIMATE</span></div>` +
      // R30 — AN UNFILLED SLOT IS NOT A ZERO, IT IS A HOLE. The margin above
      // adds 0 for every starting slot the auction did not fill, so a roster
      // that cannot legally be started used to read as a comfortable win. Say
      // it, above the roster, in the same place the score is claimed.
      emptySlotsHtml(r.emptySlots) +
      `<div class="ds-roster">${my}</div>` +
      // R35 — WHO SPENT WHAT, BY NAME. The sheet above is aggregates; a room
      // that just finished a real auction wants the ledger by the names R34
      // put on the seats. Points via the same startersTotal every score in
      // this card already uses; spend from the R27 per-team starting budgets.
      // Sorted by points so the sheet reads as a standings table, my row
      // marked the way seatLabel already marks it.
      `<div class="ds-sheet">${auction.teams
        .map((t, i) => ({
          i,
          pts: startersTotal(t.players, auction.shape, auction.adjOf),
          spent: (Number.isFinite((auction.teamBudgets || [])[i])
            ? auction.teamBudgets[i] : auction.budget) - t.budget,
        }))
        .sort((a, b) => b.pts - a.pts)
        .map((row) => `${esc(seatLabel(row.i, auction.mySlot))} ${fix1(row.pts)} · ${dollar(row.spent)}`)
        .join(' &nbsp;|&nbsp; ')}</div>` +
      // An auction has no pick order, so it can never calibrate ADP drift. The
      // in-room price model (inflation + per-team tendencies) already ran LIVE
      // during the auction itself — nothing is deferred to a later refit.
      '<div class="m-explain">Saved to DRAFT HISTORY. An auction has no pick order, so it '
        + 'calibrates no ADP drift; the room\'s price behaviour — live inflation and each '
        + 'team\'s overpay tendency — was modelled during the auction itself, not '
        + 'afterwards.</div>'
    );
  }

  /* Markup the SETUP branch last wrote, so an unchanged card is not re-parsed
   * (R25). paintAll() repaints all five panels on every ADD / REMOVE, but the
   * setup card is built only from draftCfg, the league panel state and the
   * mock history — it reads neither roster.slots, nor `taken`, nor playersById
   * — so seating a player rebuilds 8.4 kB of identical HTML. Measured at
   * 1.27 ms of a ~10 ms ADD. The guard is a STRING comparison, so a card that
   * would render differently by even one byte still repaints; only a
   * character-for-character identical write is skipped, and skipping it also
   * stops the card throwing away an open <details> or a focused input it was
   * about to restore from closure state anyway. The four live-board branches
   * are deliberately excluded: liveTakePoolHtml() writes into that box behind
   * paintDraft's back, so only the setup branch can trust its own cache. */
  let _draftSetupPainted = null;
  /* R30c — FOCUS SURVIVES THE REPAINT. Every draft-room action rebuilds its
   * section with innerHTML, which detaches the very control that was just
   * activated and drops keyboard/VoiceOver focus to <body> — raising a bid
   * from $34 to $47 meant re-Tabbing the whole page per press, and the armed
   * "TAP AGAIN" confirms were unreachable without a full re-Tab. Pointer users
   * never noticed (the replacement renders at the identical spot, and Safari
   * does not focus buttons on click), which is why this survived so long.
   * The cheap fix inside the existing painter architecture: capture the
   * focused control's identity (its data-act plus whichever stable data-*
   * identity it carries) before the rebuild, and focus its equivalent in the
   * fresh markup afterwards. data-max is tried but never required — the BID
   * button's max moves with the bid, so the act-only fallback catches it. */
  function draftFocusKey(box) {
    const a = document.activeElement;
    if (!box || !a || !box.contains(a) || !a.dataset || !a.dataset.act) return null;
    const d = a.dataset;
    return { act: d.act, gsis: d.gsis, bi: d.bi, slot: d.slot, max: d.max };
  }
  function restoreDraftFocus(box, key) {
    if (!key) return;
    const attr = (n, v) => (v == null ? '' : `[data-${n}="${v}"]`);
    const exact = `[data-act="${key.act}"]${attr('gsis', key.gsis)}`
      + `${attr('bi', key.bi)}${attr('slot', key.slot)}${attr('max', key.max)}`;
    const next = box.querySelector(exact) || box.querySelector(`[data-act="${key.act}"]`);
    if (next) {
      try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); }
    }
  }

  function paintDraft() {
    paintSyncBar();
    const box = el.querySelector('#t-draft');
    if (!box) return;
    const focusKey = draftFocusKey(box);
    if (!adpDoc) {
      box.innerHTML = '';
      _draftSetupPainted = null;
      return;
    }
    let rebuilt = true;
    if (auction && auctionResult) { box.innerHTML = auctionResultHtml(); _draftSetupPainted = null; }
    else if (auction) { box.innerHTML = auctionRoomHtml(); _draftSetupPainted = null; }
    else if (draft && draftResult) { box.innerHTML = draftResultHtml(); _draftSetupPainted = null; }
    else if (draft) { box.innerHTML = draftLiveHtml(); _draftSetupPainted = null; }
    else {
      const html = draftSetupHtml();
      if (html !== _draftSetupPainted) {
        box.innerHTML = html;
        _draftSetupPainted = html;
      } else {
        rebuilt = false; // the DOM was not touched, so focus never moved
      }
    }
    if (rebuilt) restoreDraftFocus(box, focusKey);
  }

  /**
   * R48b — the sync banner beside the roster grid. Three states, one place:
   * reading (busy), PICK YOUR TEAM (teams read, none chosen — the picker is
   * here, in the same viewport as the roster it fills), and the RESULT of a
   * seat (how many, from which team, what did not match). Empty otherwise.
   */
  function syncBarHtml() {
    if (rosterBusy) {
      return '<div class="lp-status lp-status--ok sync-bar" role="status">'
        + '<div class="lp-status-line">Reading your Sleeper rosters — the roster below fills '
        + 'when they land.</div>'
        + (indexProgress ? `<div class="lp-status-line sync-bar-prog">${esc(indexProgress)}</div>` : '')
        + '</div>';
    }
    if (rosterTeams && rosterTeamIdx < 0) {
      const opts = ['<option value="-1" selected>— pick your team —</option>']
        .concat(rosterTeams.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`)).join('');
      return '<div class="lp-status lp-status--warn sync-bar" role="status">'
        + '<div class="lp-status-line"><b>ONE STEP LEFT — PICK YOUR TEAM.</b> The league settings '
        + `are saved; ${rosterTeams.length} rosters were read. Choose yours and it is seated below `
        + 'and remembered on this device.</div>'
        + '<label class="lp-field lp-field--grow sync-bar-pick"><span class="ds-lbl">MY TEAM</span>'
        + `<select class="ds-select lp-rsel" data-rcfg="team">${opts}</select></label>`
        + '</div>';
    }
    if (rosterApplied && rosterPlan) {
      const team = rosterTeams && rosterTeamIdx >= 0 ? rosterTeams[rosterTeamIdx] : null;
      const total = rosterPlan.after_count + rosterPlan.unplaced.length + rosterMissed.length;
      return '<div class="lp-status lp-status--ok sync-bar" role="status">'
        + `<div class="lp-status-line"><b>SEATED FROM SLEEPER${team ? ` · ${esc(team.label)}` : ''}.</b> `
        + `${rosterPlan.after_count} of ${total} player(s) are in the roster below`
        + (rosterMissed.length ? `; ${rosterMissed.length} have no projection in this app and are named in the SLEEPER ROSTER panel` : '')
        + (rosterPlan.unplaced.length ? `; ${rosterPlan.unplaced.length} had no slot left` : '')
        + '. LINEUP, LEAGUE and GRADE read this roster now.</div></div>';
    }
    return '';
  }
  function paintSyncBar() {
    const bar = el.querySelector('#t-syncbar');
    if (bar) bar.innerHTML = syncBarHtml();
  }

  function paintAll() {
    paintDraft();
    paintSyncBar();
    paintRoster();
    paintCands();
    paintReco();
    paintSummary();
  }

  /* R52 — THE ONE REMOUNT PATH. Only the two resets use it: they cleared
   * storage that this mount's derived state was built from, and the R30c
   * lesson is that a hand-cleared list of that state is what goes stale.
   * Bumping mountSeq FIRST retires every continuation of this mount (a roster
   * read still in flight, a progress tick) before the new mount paints. */
  function remount() {
    mountSeq += 1;
    return Promise.resolve(mountTeam(el)).catch(() => { /* the mounted view reports its own state */ });
  }

  /* R52 — ADOPT A PROFILE JUST WRITTEN, IN PLACE. What a fresh mount would read
   * back (loadProfile) becomes the saved profile; when storage refused the
   * write the in-memory profile drives this page, which is the honest meaning
   * of "applies to this page only". Then every derivation a fresh mount makes
   * from the profile is remade: the settings grid seed, the scoring mode, the
   * derived maps and the roster under the new slot vocabulary, the header. */
  function adoptSavedProfile(profile, wrote) {
    savedProfile = wrote ? loadProfile() : normalizeProfile(profile);
    stagedProfile = cloneProfile(savedProfile);
    const remapped = cfgFromProfile(savedProfile);
    carriedTokens = remapped.carried;
    clampedNotes = remapped.clamped;
    Object.assign(draftCfg, remapped.cfg);
    if (draftCfg.mySlot > draftCfg.leagueSize) draftCfg.mySlot = draftCfg.leagueSize;
    mode = loadScoring();
    applyLeagueState();
    const sub = el.querySelector('.view-head .view-sub');
    if (sub) sub.textContent = `${season} · ${mode.toUpperCase()} SCORING · ESTIMATE`;
  }

  /* ---- events ---------------------------------------------------------------- */


  /**
   * Draft finished: score vs the room, then record it.
   *
   * EVERY room is recorded now, not just ADP. app/mocks.js stores the room
   * type and the play mode on the record and decides for itself what is
   * admissible evidence (LIVE snake drafts only), so throwing away a SHARK or
   * AI+ mock just lost the manager their own history for no reason. A LIVE
   * record additionally carries the observed OPPONENT picks — that is the
   * transcript roomCalibration() measures.
   */
  function finishDraft() {
    const mine = draft.rosters[draft.mySlot - 1].players;
    const opp = draft.rosters
      .filter((_, i) => i !== draft.mySlot - 1)
      .map((r) => r.players);
    draftResult = scoreVsRoom(mine, opp, draft.shape, draft.adjOf);
    appendMock(recordDraft(draft, draftResult));
    refreshHistory();
  }

  /** Auction finished: score vs the room, then record it as history. */
  function finishAuction() {
    auctionResult = scoreAuction(auction);
    appendMock(recordAuction(auction, auctionResult, aucMyTeam(auction).players));
    refreshHistory();
  }

  /* R34 — the two reset buttons' arm/disarm repaint. State-driven (never
   * toggled ad hoc on the event target) so a button can never LOOK armed
   * while it is not, whichever path disarmed it. */
  function paintResetButtons() {
    const rs = el.querySelector('[data-act="restart-session"]');
    if (rs) {
      rs.textContent = restartArmed ? 'TAP AGAIN TO RESTART' : 'RESTART SESSION';
      rs.classList.toggle('reset-btn--armed', restartArmed);
    }
    const ra = el.querySelector('[data-act="reset-all"]');
    if (ra) {
      ra.textContent = wipeArmed ? 'TAP AGAIN TO ERASE ALL' : 'RESET ALL';
      ra.classList.toggle('reset-btn--armed', wipeArmed);
    }
  }

  function onAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled || !el.contains(t)) return;
    const act = t.dataset.act;
    aucRefusal = '';           // any new action clears the last refusal notice

    /* R34 — two reset buttons, one arm at a time. Any other action disarms a
     * pending confirm (no accidental wipes), and because each button is "any
     * other action" for its sibling, arming one disarms the other. */
    if (act !== 'restart-session' && restartArmed) { restartArmed = false; paintResetButtons(); }
    if (act !== 'reset-all' && wipeArmed) { wipeArmed = false; paintResetButtons(); }

    if (act !== 'roster-apply' && rosterArmed) {
      // Same rule for the roster overwrite: the armed confirm survives nothing
      // but a second tap on the same button, and the panel repaints so the
      // button can never LOOK armed while it is not (or the reverse).
      rosterArmed = false;
      paintDraft();
    }

    if (act !== 'hist-clear' && histArmed) {
      // Same one-tap-arms rule for the history wipe: history is the only copy
      // of a live room's transcript, so erasing it needs a deliberate second
      // tap and nothing else may leave the button looking armed.
      histArmed = false;
      paintDraft();
    }

    if (act === 'hist-clear') {
      if (!histArmed) {
        histArmed = true;
        paintDraft();
        return;
      }
      histArmed = false;
      clearHistory();
      refreshHistory();
      paintDraft();
      return;
    }

    if (act === 'pick') {
      // Select an empty slot: recommendations retarget to it.
      selectedSlot = t.dataset.slot;
      paintRoster();
      paintReco();
      return;
    }

    if (act === 'remove') {
      roster.slots[t.dataset.slot] = null;
      saveRoster(roster);
      paintAll();
      return;
    }


    /* R34 — RESTART SESSION (replaces the single RESET, extended per the
     * owner's spec). Clears: roster slots, TAKEN board, any draft/auction in
     * progress + results, companion stopped, scoring mode back to standard
     * PPR, and the ACTIVE league profile back to the app default — the fix
     * for "reset didn't clear the Omilia-US scoring". KEEPS: the synced
     * league (stashed saved-not-applied, restored by one-tap RE-APPLY without
     * a re-download), draft history / auction room memory, and the per-team
     * budgets + names. The storage half lives in restartSessionStorage()
     * (pure, node-tested); the view half is a full RE-MOUNT — the same idiom
     * league-save uses for a scoring change, and the structural form of the
     * R30c lesson: rosterApplied, the OURS price memo, adjById and every
     * other derived cache are rebuilt from the cleared storage rather than
     * hand-cleared one by one (the hand-cleared list is what went stale). */
    if (act === 'restart-session') {
      if (!restartArmed) {
        restartArmed = true;
        paintResetButtons();
        return;
      }
      restartArmed = false;
      if (companion) companion.stop('RESTART SESSION wiped the room.'); // R33
      const { kept } = restartSessionStorage();
      leagueFlash = {
        tone: 'ok',
        lines: ['Session restarted: roster, TAKEN board and any draft in progress cleared. '
          + 'Draft history and per-team budgets/names were kept.',
        ...(kept
          ? ['Your synced league stays SAVED and APPLIED — scoring and roster shape are '
            + 'unchanged on every tab. RESET ALL is the button that clears it.']
          : ['No league is saved, so scoring is standard PPR and the default shape applies.'])],
      };
      remount();
      return;
    }

    /* R34 — RESET ALL: the factory wipe. Everything RESTART clears PLUS the
     * saved/stashed league, per-team budgets and names, and the draft
     * history + auction room memory — the explicit RESET_ALL_KEYS list, never
     * a wildcard over localStorage (other sites' keys must be untouched). */
    if (act === 'reset-all') {
      if (!wipeArmed) {
        wipeArmed = true;
        paintResetButtons();
        return;
      }
      wipeArmed = false;
      if (companion) companion.stop('RESET ALL wiped this device.'); // R33
      wipeAllAppStorage();
      leagueFlash = {
        tone: 'ok',
        lines: ['Factory reset: league sync, budgets, team names, draft history, room memory, '
          + 'roster and the TAKEN board are all erased from this device.'],
      };
      remount();
      return;
    }

    /* R34 — RE-APPLY the stashed (saved-not-applied) league in one tap: write
     * it back as the ACTIVE profile and re-price the whole page under its
     * scoring and shape. No network — the stash IS the synced import RESTART
     * parked. R52 — in place (adoptSavedProfile + paintAll), no remount: the
     * mount holds everything the re-price needs, and the strip hides itself
     * because the stash now equals the applied profile. */
    if (act === 'league-reapply') {
      const parked = loadStashedProfile();
      if (!parked) return;
      const wrote = saveProfile(parked);
      const nextMode = scoringMode(parked);
      if (nextMode !== 'custom') {
        try { localStorage.setItem(SCORING_KEY, nextMode); } catch (err) { /* session-only */ }
      }
      adoptSavedProfile(parked, wrote);
      leagueStatus = {
        tone: wrote ? 'ok' : 'warn',
        lines: [wrote
          ? `Re-applied ${parked.name} · ${parked.shape.teams} teams · `
            + `${parked.shape.starters}+${parked.shape.bench} · ${receptionLabel(parked)} — `
            + 'every number on this page is re-priced under it.'
          : 'Storage is blocked, so the league could not be re-applied to disk.'],
      };
      paintAll();
      return;
    }

    if (act === 'league-save') {
      // Persist the league + roster settings as the LeagueProfile. This is the
      // only writer of nfl2026.league.v1 in this view, and it RE-PRICES: the
      // shape it writes is the shape the draft room prices against, and the
      // reception value it carries is the scoring mode the app projects at.
      const next = profileFromCfg(draftCfg, stagedProfile, carriedTokens);
      // An explicit draft_rounds this panel could not keep is REPORTED, never
      // swapped in silently (R24) — the "Saved:" line below prints the number.
      const roundsMoved = draftRoundsOverride(draftCfg, stagedProfile, carriedTokens);
      const wrote = saveProfile(next);
      // R27 — SAY WHOSE ROUNDS THESE ARE. This line printed a bare "3 rounds"
      // straight from the league's own draft_rounds while the card above it
      // said "13 ROUNDS" (one per roster slot, which is what the room actually
      // runs). Both numbers were right and nothing on screen said they meant
      // different things, so the card read as self-contradicting — and a user
      // who cannot reconcile two numbers stops trusting the rest of them. Only
      // qualify it when the two genuinely differ; on a league where Sleeper's
      // rounds match the roster there is nothing to disambiguate.
      const slotRounds = next.shape.roster_positions.length;
      const roundsTxt = next.shape.draft_rounds === slotRounds
        ? `${slotRounds} rounds`
        : `${slotRounds} roster slots (your league sets ${next.shape.draft_rounds} `
          + 'draft rounds in Sleeper; the room drafts one round per slot)';
      const lines = [wrote
        ? `Saved: ${next.name} · ${next.shape.teams} teams · ${next.shape.starters} starters `
          + `+ ${next.shape.bench} bench · ${roundsTxt}`
          + `${next.shape.keepers_enabled
            ? ` · ${next.shape.max_keepers} keeper${next.shape.max_keepers === 1 ? '' : 's'}`
            : ''}.`
        : 'Storage is blocked, so nothing was written to disk. These settings still drive this '
          + 'session, but they will not survive a reload.'];
      if (roundsMoved) lines.push(
        `Draft rounds moved from ${roundsMoved.wanted} to ${roundsMoved.used}: this panel has no `
        + 'rounds field, so a roster-size change re-derives it. Your league\'s '
        + `${roundsMoved.wanted} rounds could not be kept.`);
      validateProfile(next).forEach((p) => { if (p && p.message) lines.push(p.message); });
      const nextMode = scoringMode(next);
      if (nextMode !== 'custom' && nextMode !== mode) {
        lines.push(`Scoring re-priced to ${nextMode.toUpperCase()} from your league's reception `
          + 'value — every projection on the board is recomputed.');
        try {
          localStorage.setItem(SCORING_KEY, nextMode);
        } catch (err) {
          lines.push('The scoring mode could not be stored, so it reverts on reload.');
        }
      }
      if (nextMode === 'custom') {
        lines.push(`Reception is ${receptionLabel(next)} — the projection conversion only knows `
          + `1, 0.5 and 0, so the board stays at ${mode.toUpperCase()}.`);
      }
      // R52 — in place for BOTH the re-price and the same-mode save (the
      // re-price used to remount; the same-mode save used to repaint without
      // re-deriving, so a newly saved K slot had no kickers to seat until a
      // reload). adoptSavedProfile re-reads the scoring mode and remakes every
      // derived map; paintAll (R30c) then repaints everything the profile feeds.
      adoptSavedProfile(next, wrote);
      leagueStatus = { tone: wrote ? 'ok' : 'warn', lines };
      paintAll();
      return;
    }

    if (act === 'sleeper-sync') {
      if (syncBusy) return;
      const idText = sleeperId.trim();
      if (!idText) {
        leagueStatus = { tone: 'err', lines: ['Enter your Sleeper league id or league URL first.'] };
        paintDraft();
        return;
      }
      syncBusy = true;
      leagueStatus = { tone: 'ok', lines: ['Reading your league from Sleeper…'] };
      paintDraft();
      Promise.resolve(importFromSleeper(idText)).then((res) => {
        // R52 — a superseded mount writes nothing, storage included: the press
        // belonged to a view that is gone, and the next press repeats it.
        if (stale('SYNC NOW')) return;
        syncBusy = false;
        applyImport(res);
        /* R47 — ONE SYNC = WHOLE SESSION (owner's pick). A successful Sleeper
         * import is SAVED and applied immediately: the profile (scoring table,
         * roster shape incl. K/DEF), the scoring mode locked to the league's
         * rec value, and the league id itself — so every tab reprices under
         * it from this moment, with no separate SAVE press. SAVE LEAGUE
         * SETTINGS remains the manual-edit path; RESET ALL clears it all. */
        if (res && res.ok && importProfile) {
          const wrote = saveProfile(importProfile);
          const nextMode = scoringMode(importProfile);
          if (nextMode !== 'custom') {
            try { localStorage.setItem(SCORING_KEY, nextMode); } catch (err) { /* session-only */ }
          }
          saveLeagueId(idText);
          // R48 — the LEAGUE tab's log: what this sync applied, in plain lines.
          try {
            const diffs = scoringDiff(importProfile);
            const shapeLines = shapeDiff(importProfile).lines;
            recordSync({
              kind: 'settings',
              league_id: parseLeagueId(idText),
              league_name: importProfile.name,
              changes: [
                `${importProfile.shape.teams} teams · ${importProfile.shape.starters} starters + `
                  + `${importProfile.shape.bench} bench · ${receptionLabel(importProfile)}`,
                `${diffs.length} scoring key(s) differ from standard PPR`,
                ...shapeLines,
                `Scoring mode ${nextMode === 'custom' ? 'left on the toggle (custom rec value)' : `locked to ${nextMode.toUpperCase()}`}`,
              ],
            });
          } catch (err) { /* the log is a convenience; the sync stands without it */ }
          try { window.dispatchEvent(new Event('nfl2026:league')); } catch (err) { /* no window */ }
          /* R52 — SINGLE PASS. The saved profile is adopted in THIS mount
           * (every derivation a fresh mount makes, remade in place), the
           * status says what landed, and the roster read continues right
           * here — no remount, so no second mount to race this one for the
           * hand-off and no result painted into DOM another mount replaced. */
          adoptSavedProfile(importProfile, wrote);
          leagueStatus = {
            tone: wrote ? 'ok' : 'warn',
            lines: [wrote
              ? `Synced and SAVED ${importProfile.name} · ${importProfile.shape.teams} teams · `
                + `${importProfile.shape.starters}+${importProfile.shape.bench} · `
                + `${receptionLabel(importProfile)} — every tab now prices under this league. `
                + 'Reading the rosters next; pick your team once and it is remembered. '
                + 'Edit below and press SAVE LEAGUE SETTINGS only to override it.'
              : 'Imported, but storage is blocked, so the league could not be saved to disk — '
                + 'it applies to this page only.'],
          };
          paintAll();
          Promise.resolve(runRosterSync()).catch((err) => {
            if (stale('roster sync failure')) return;
            rosterBusy = false;
            rosterStatus = {
              tone: 'err',
              lines: [`The roster sync failed: ${err && err.message ? err.message : String(err)}`,
                'Nothing on your roster was changed. Press SYNC ROSTER to try again.'],
            };
            paintDraft();
          });
        }
      }).catch((err) => {
        if (stale('SYNC NOW failure')) return;
        syncBusy = false;
        leagueStatus = {
          tone: 'err',
          lines: [`The import failed: ${err && err.message ? err.message : String(err)}`,
            'Open the league URL yourself and paste the JSON instead.'],
        };
        paintDraft();
      });
      return;
    }

    if (act === 'sleeper-paste') {
      if (!pasteText.trim()) {
        leagueStatus = {
          tone: 'err',
          lines: ['Paste the league JSON first — the whole response, from the first { to the '
            + 'last }.'],
        };
        paintDraft();
        return;
      }
      applyImport(importFromPastedJson(pasteText));
      return;
    }

    if (act === 'roster-sync') {
      if (rosterBusy) return;
      Promise.resolve(runRosterSync()).catch((err) => {
        if (stale('roster sync failure')) return;
        rosterBusy = false;
        rosterStatus = {
          tone: 'err',
          lines: [`The roster sync failed: ${err && err.message ? err.message : String(err)}`,
            'Nothing on your roster was changed.'],
        };
        paintDraft();
      });
      return;
    }

    if (act === 'roster-apply') {
      applyRosterPlan({ auto: false });
      return;
    }

    if (act === 'draft-start') {
      draftResult = null;
      syncedOthers.clear();
      syncedMine.clear();
      draft = createDraft({
        leagueSize: draftCfg.leagueSize,
        mySlot: Math.min(draftCfg.mySlot, draftCfg.leagueSize),
        roomType: draftCfg.roomType,
        rosterConfig: draftCfg,
        boardRows: roomBoardRows({ excludeTaken: false }),
        adjPointsById: adjPointsMap(),
        seed: 20260901 + draftCfg.leagueSize * 100 + draftCfg.mySlot,
        excludedIds: [...taken],
        // AI+ only. createDraft ignores all three for the ADP and SHARK rooms,
        // so those two boards are byte-for-byte what they were; for AI+ they
        // are what lets the opponents value a player under YOUR scoring
        // instead of the page's scoring mode. The SAVED profile is deliberate
        // — the room-key panel says so, and warns when it is still the
        // default or when the settings above are unsaved.
        profile: savedProfile,
        pprPointsById: draftCfg.roomType === 'aiplus' ? pprPointsMap() : null,
        receptionsById: draftCfg.roomType === 'aiplus' ? receptionsMap() : null,
      });
      draft.play = draftCfg.play;
      paintAll();
      return;
    }

    if (act === 'draft-sim') {
      // Advance opponents until my turn (or the end).
      while (draft && !draft.done && onTheClock(draft) !== draft.mySlot - 1) {
        takeOpponentPick(draft);
      }
      if (draft && draft.done) finishDraft();
      paintAll();
      return;
    }

    if (act === 'draft-pick') {
      const bi = Number(t.dataset.bi);
      takeMyPick(draft, bi);
      if (draft.play !== 'live') {
        while (draft && !draft.done && onTheClock(draft) !== draft.mySlot - 1) {
          takeOpponentPick(draft);
        }
      }
      if (draft && draft.done) finishDraft();
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'draft-close') {
      if (companion) companion.stop('The draft room was closed.');
      draft = null;
      draftResult = null;
      paintAll();
      return;
    }

    /* R33 — the companion's three controls. ARM builds the controller once
     * per mount and (re)arms it; DISARM stops the polling but keeps the room
     * exactly as the applied picks left it; RESOLVED acknowledges a pick the
     * manager handled by hand so the feed moves past it. */
    if (act === 'comp-arm') { armCompanion(); return; }
    if (act === 'comp-stop') {
      if (companion) companion.stop('Disarmed — picks are recorded by hand again.');
      paintDraft();
      return;
    }
    if (act === 'comp-ack') {
      if (companion) companion.acknowledge(Number(t.dataset.pickno));
      paintDraft();
      return;
    }

    if (act === 'draft-live-take') {
      takeOpponentPickAt(draft, Number(t.dataset.bi));
      liveTakeQuery = '';   // next opponent starts from the full board again
      if (draft.done) finishDraft();
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'draft-undo') {
      undoLastPick(draft);
      draftResult = null;
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'auc-cancel') {
      if (auction && auction.block) { auction.block = null; bidAdj = 0; }
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      paintAll();
      return;
    }

    if (act === 'tb-level') {
      // Back to a level room. Setting null rather than writing leagueSize
      // copies of the default keeps "nobody has said otherwise" distinguishable
      // from "every team was typed and happens to match", which is what the
      // summary line reports.
      draftCfg.teamBudgets = null;
      persistAuctionTeams();   // R34 — level-all persists too (names are kept)
      leagueStatus = null;
      paintDraft();
      paintCands();
      paintReco();
      return;
    }

    if (act === 'auc-undo') {
      undoLastSale(auction);
      auctionResult = null;
      bidAdj = 0;
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'auc-start') {
      auctionResult = null;
      bidAdj = 0;
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      syncedOthers.clear();
      syncedMine.clear();
      auction = createAuction({
        leagueSize: draftCfg.leagueSize,
        mySlot: Math.min(draftCfg.mySlot, draftCfg.leagueSize),
        budget: draftCfg.budget,
        // R27 — what each team ACTUALLY starts with. Always passed (not only
        // when uneven) so the room has one code path, and normalizeTeamBudgets
        // makes a level room identical to the pre-R27 construction.
        teamBudgets: effectiveTeamBudgets(),
        rosterConfig: draftCfg,
        boardRows: roomBoardRows(),
        adjPointsById: adjPointsMap(),
        seed: 20260901 + draftCfg.leagueSize * 100 + draftCfg.mySlot,
        // Auction-memory S2 — the stored DRAFT HISTORY seeds the opponents'
        // per-position priors from past LIVE auctions at this league size
        // (seedTendencies applies the shrinkage and the SIM/market exclusions;
        // an empty or SIM-only history seeds nothing and says why in
        // auction.memory.reason, which the room header prints verbatim).
        history: mockHistory,
      });
      auction.play = draftCfg.play;
      paintAll();
      return;
    }

    if (act === 'auc-close') {
      if (companion) companion.stop('The auction room was closed.');
      auction = null;
      auctionResult = null;
      paintAll();
      return;
    }

    if (act === 'auc-style') {
      strategy.style = strategy.style === 'stars' ? 'balanced' : 'stars';
      paintDraft();
      return;
    }
    if (act === 'auc-tempo') {
      strategy.tempo = strategy.tempo === 'aggressive' ? 'patient' : 'aggressive';
      paintDraft();
      return;
    }
    if (act === 'auc-enforce') {
      strategy.enforce = !strategy.enforce;
      paintDraft();
      return;
    }

    if (act === 'auc-nom') {
      nominate(auction, Number(t.dataset.bi));
      bidAdj = 0;
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      paintAll();
      return;
    }

    if (act === 'auc-sim-nom') {
      const bi = autoNominate(auction);
      if (bi >= 0) { nominate(auction, bi); bidAdj = 0; }
      else { auction.done = true; }
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      if (auction.done) finishAuction();
      paintDraft();
      return;
    }

    /* R34 — the price chips correct a TYPED price only. They used to nudge
     * the seeded estimate; the estimate no longer prefills (typing is
     * mandatory), so with nothing typed there is no fact to nudge and the
     * chips deliberately do nothing rather than invent a starting number. */
    if (act === 'auc-price-minus') {
      if (soldTyped != null && soldTyped > 0) { soldTyped -= 1; paintDraft(); }
      return;
    }
    if (act === 'auc-price-plus') {
      if (soldTyped != null) { soldTyped += 1; paintDraft(); }
      return;
    }
    if (act === 'auc-bid-minus') {
      bidAdj -= 1;
      paintDraft();
      return;
    }
    if (act === 'auc-bid-plus') {
      bidAdj += 1;
      paintDraft();
      return;
    }

    if (act === 'auc-bid') {
      // Resolve the block against the room with my ceiling (0 = pass/enforce off).
      const { winnerIdx, price } = resolveBids(auction, Number(t.dataset.max) || 0);
      sellTo(auction, winnerIdx, price, auction.block.boardIdx);
      bidAdj = 0;
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      if (auction.done) finishAuction();
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'auc-sold') {
      // LIVE: record the observed sale exactly as it happened in the real room.
      // R34 — the capture is MANDATORY buyer + TYPED price. validateSoldEntry
      // (pure, node-tested) refuses a missing buyer and a blank price — a
      // blank is NEVER recorded as $0 and NEVER silently replaced with our
      // estimate; the manager is told what is missing instead. The RECORD
      // button is disabled until both are set, so these refusals are the
      // keyboard/edge backstop, not the primary UX.
      const sel = el.querySelector('.auc-soldteam');
      const priceEl = el.querySelector('.auc-soldprice');
      const v = validateSoldEntry({
        buyerValue: sel ? sel.value : '',
        priceValue: priceEl ? priceEl.value : '',
      });
      if (!v.ok) {
        aucRefusal = v.reason;
        paintAll();
        return;
      }
      // Clamp the TYPED price to what the BUYER can legally pay ($1 reserved
      // per other open slot); sellTo's budget clamp backstops even this.
      const buyer = auction.teams[v.teamIdx];
      const price = buyer ? Math.max(0, Math.min(v.price,
        maxBid(buyer.budget, auction.shape.size - buyer.players.length))) : 0;
      // sellTo REFUSES a full buyer (returns null). Say so — a silent no-op
      // reads as a broken button, and the manager needs to pick another team.
      if (!buyer || sellTo(auction, v.teamIdx, price, auction.block.boardIdx) === null) {
        const who = seatLabel(v.teamIdx, auction.mySlot);
        aucRefusal = buyer
          ? `${who} already filled all ${auction.shape.size} roster spots — that `
            + 'team cannot buy. Pick another buyer.'
          : 'No team has an open roster spot — this sale cannot be recorded.';
        paintAll();
        return;
      }
      bidAdj = 0;
      resetSoldEntry();   // the block changed — last player's typed entry must not carry over
      if (auction.done) finishAuction();
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'taken') {
      // Draft board: mark/unmark a player drafted by another manager. The fit
      // engine re-optimizes from the remaining pool immediately (paintReco).
      const id = String(t.dataset.gsis);
      if (taken.has(id)) taken.delete(id);
      else taken.add(id);
      saveTaken(taken);
      paintCands();
      paintReco();
      paintSummary();
      return;
    }

    if (act === 'taken-filter') {
      // Toggle the finder view between greying taken players and hiding them.
      hideTaken = !hideTaken;
      t.textContent = hideTaken ? 'SHOW TAKEN' : 'HIDE TAKEN';
      t.setAttribute('aria-pressed', hideTaken ? 'true' : 'false');
      paintCands();
      return;
    }

    if (act === 'add') {
      const id = t.dataset.gsis;
      const p = playersById.get(id);
      if (!p) return;
      // Reco ADDs carry their target slot; finder ADDs honor the selected slot
      // when it fits, else the first eligible open slot (starters before bench).
      const wanted = t.dataset.slot || selectedSlot;
      const slot = (wanted && !roster.slots[wanted]
        && slotAccepts(p.position, wanted, savedProfile))
        ? wanted
        : firstEligibleOpenSlot(p.position);
      if (!slot) return;
      roster.slots[slot] = id;
      selectedSlot = null;
      saveRoster(roster);
      paintAll();
    }
  }

  listen(el, 'click', onAction);
  // Keyboard parity for the div-based remove control (role="button").
  listen(el, 'keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-act][role="button"]')) {
      e.preventDefault();
      onAction(e);
    }
  });
  // Debounced search: repaint the candidate list at most once per ~140ms of
  // typing instead of on every keystroke — the list rebuild (filter + sort +
  // up-to-FINDER_CAP rows) is wasted work between characters.
  let _findTimer = null;
  listen(el.querySelector('#t-find'), 'input', (e) => {
    query = e.target.value || '';
    if (_findTimer) clearTimeout(_findTimer);
    // A debounce still in flight when the view re-mounts would paint THIS
    // mount's list into the new mount's DOM — retired() drops it instead.
    _findTimer = setTimeout(() => { _findTimer = null; if (!retired()) paintCands(); }, 140);
  });

  // Draft setup selects (delegated change — the section repaints often).
  listen(el, 'change', (e) => {
    const sel = e.target.closest('select[data-dcfg]');
    if (!sel) return;
    const key = sel.dataset.dcfg;
    draftCfg[key] = (key === 'roomType' || key === 'mode' || key === 'play')
      ? sel.value : Number(sel.value);
    if (draftCfg.mySlot > draftCfg.leagueSize) draftCfg.mySlot = draftCfg.leagueSize;
    // The shape moved, so a "Saved:" line from a moment ago would now be a lie.
    if (key === 'leagueSize' || ROSTER_BOUNDS[key]) leagueStatus = null;
    if (!draft && !auction) paintDraft(); // setup card reflects clamped values
    // OUR auction dollars are computed from league size, budget and roster
    // shape, so the board's value cell would otherwise show a price for a
    // league the user just changed away from.
    if (key === 'leagueSize' || key === 'budget' || ROSTER_BOUNDS[key]) {
      paintCands();
      paintReco();
    }
  });

  /* R27 — typed budgets (league default + per team). `change` rather than
   * `input`, so the value is read when the field is committed: clamping on
   * every keystroke rewrites "2" to the minimum while the user is still typing
   * "200". An empty or unparseable box falls back to the league default rather
   * than to zero — a blank field means "I have not said", not "this team has
   * no money". */
  /* R34 — the sale capture keeps RECORD SALE's disabled state live WITHOUT a
   * repaint (a repaint would blur the field mid-entry). The price is tracked
   * on `input` (see the shared input listener below) so the button enables as
   * the manager types; the buyer select and the team-name field ride THIS
   * delegated change listener rather than adding their own — the R25 listener
   * budget counts every mount-scoped registration. The blank check is
   * explicit because Number('') is 0 and a cleared box must mean "nothing
   * typed", never "$0 typed" — the same trap the budget boxes document below. */
  function updateSoldConfirm() {
    const btn = el.querySelector('[data-act="auc-sold"]');
    if (btn) btn.disabled = !(soldTyped != null && soldBuyer != null);
  }
  function readSoldPrice(input) {
    const blank = String(input.value).trim() === '';
    const n = Math.round(Number(input.value));
    soldTyped = !blank && Number.isFinite(n) && n >= 0 ? n : null;
    updateSoldConfirm();
  }

  listen(el, 'change', (e) => {
    // R34 — the MANDATORY buyer selection for a live sale.
    const buyerSel = e.target.closest('select.auc-soldteam');
    if (buyerSel) {
      const n = Number(buyerSel.value);
      soldBuyer = buyerSel.value !== '' && Number.isInteger(n) && n >= 0 ? n : null;
      updateSoldConfirm();
      return;
    }
    // R34 — a typed team NAME commits on `change` (blur), persists alongside
    // the budgets, and clears back to the fallback ladder when emptied.
    const nameBox = e.target.closest('input[data-tname]');
    if (nameBox) {
      const idx = Number(nameBox.dataset.tname);
      if (!Number.isInteger(idx) || idx < 0 || idx >= draftCfg.leagueSize) return;
      const next = teamNames.slice();
      while (next.length < draftCfg.leagueSize) next.push('');
      next[idx] = String(nameBox.value || '').trim().slice(0, TEAM_NAME_MAX);
      teamNames = next;
      persistAuctionTeams();
      // A room in progress shows names on the ledger/buyer surfaces.
      if (auction) paintDraft();
      return;
    }
    // A typed observed sale price on commit (blur) — the input listener below
    // already tracked it live; this re-checks the final value.
    const sold = e.target.closest('input.auc-soldprice');
    if (sold) {
      readSoldPrice(sold);
      return;                       // no repaint: repainting would blur the field
    }
    const box = e.target.closest('input[data-dnum], input[data-tbudget]');
    if (!box) return;
    const [lo, hi] = BUDGET_BOUNDS;
    // A CLEARED box is "not stated", not zero. Number('') is 0, which is finite
    // and would clamp to the $10 minimum — so an emptied field would silently
    // leave a team with almost no money instead of restoring the default. Same
    // trap as normalizeTeamBudgets(); both ends have to agree about it.
    const blank = String(box.value).trim() === '';
    const raw = blank ? NaN : Math.round(Number(box.value));
    if (box.dataset.dnum === 'budget') {
      const next = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : DEFAULT_BUDGET;
      const wasLevel = !draftCfg.teamBudgets;
      box.value = String(next);         // same dirty-property reason as below
      draftCfg.budget = next;
      // While the room is level, changing the league default moves every team
      // with it — that is what "default" means. Once budgets are uneven the
      // per-team numbers are the truth and are left alone.
      if (wasLevel) draftCfg.teamBudgets = null;
      persistAuctionTeams();   // R34 — budgets survive a reload now
      leagueStatus = null;
      if (!draft && !auction) paintDraft();
      paintCands();
      paintReco();
      return;
    }
    const idx = Number(box.dataset.tbudget);
    if (!Number.isInteger(idx) || idx < 0 || idx >= draftCfg.leagueSize) return;
    const next = effectiveTeamBudgets();
    next[idx] = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, raw)) : draftCfg.budget;
    // Write the RESOLVED number straight back into the field. A repaint alone
    // is not enough: re-rendering sets the value ATTRIBUTE, and a box the user
    // has typed in has a dirtied value PROPERTY that the attribute no longer
    // drives — so a cleared box would keep looking empty while the room quietly
    // held $200. The field must state what was actually stored.
    box.value = String(next[idx]);
    draftCfg.teamBudgets = next;
    persistAuctionTeams();   // R34 — budgets survive a reload now
    leagueStatus = null;
    if (!draft && !auction) paintDraft();
    // OUR dollars are spread over the money in the room, so an uneven room
    // reprices the board's value cell immediately.
    paintCands();
    paintReco();
  });

  // Sleeper ROSTER team picker — selecting a team re-plans (it never writes).
  listen(el, 'change', (e) => {
    const sel = e.target.closest('select[data-rcfg]');
    if (!sel || sel.dataset.rcfg !== 'team') return;
    const n = Number(sel.value);
    rosterTeamIdx = Number.isInteger(n) && n >= 0 && rosterTeams && n < rosterTeams.length
      ? n : -1;
    buildRosterPlan();
    // R48 — the pick is the one thing a login would have told us. Remember it
    // for this league, and when nothing is seated yet, seat the team now.
    const picked = rosterTeamIdx >= 0 ? rosterTeams[rosterTeamIdx] : null;
    const pickedLeague = parseLeagueId(sleeperId);
    if (picked && pickedLeague) saveMyRoster(pickedLeague, picked.roster_id);
    if (picked && pickedLeague) setMyRosterId(pickedLeague, picked.roster_id); // R49
    if (picked && rosterPlan && (rosterFilledCount() === 0 || rosterPlan.dropped.length === 0)) {
      if (applyRosterPlan({ auto: true })) return;
    }
    paintDraft();
  });

  // League-profile selects (FLEX eligibility + keepers) — same delegation.
  listen(el, 'change', (e) => {
    const sel = e.target.closest('select[data-lcfg]');
    if (!sel) return;
    const key = sel.dataset.lcfg;
    if (key === 'flexType') {
      draftCfg.flexType = FLEX_ELIGIBILITY[sel.value] ? sel.value : 'FLEX';
    } else if (key === 'keepers') {
      draftCfg.keepers = sel.value === 'on';
      // Turning keepers on with a max of 0 says nothing; 1 is the smallest
      // league that actually keeps anyone, and it is one tap from any other.
      if (draftCfg.keepers && draftCfg.maxKeepers < 1) draftCfg.maxKeepers = 1;
    } else if (key === 'maxKeepers') {
      const n = Number(sel.value);
      draftCfg.maxKeepers = Number.isFinite(n) ? n : 0;
    }
    leagueStatus = null;
    if (!draft && !auction) paintDraft();
  });

  // Sleeper text fields: keep the typed value in closure state so the frequent
  // setup-card repaint restores it instead of eating it. R34 — the sale-price
  // field shares this input listener (listener budget): tracking it per
  // keystroke is what lets RECORD SALE enable while the manager types.
  listen(el, 'input', (e) => {
    const sold = e.target.closest('input.auc-soldprice');
    if (sold) { readSoldPrice(sold); return; }
    const f = e.target.closest('[data-lin]');
    if (!f) return;
    if (f.dataset.lin === 'sleeperId') sleeperId = f.value || '';
    else if (f.dataset.lin === 'pasteText') pasteText = f.value || '';
  });

  // LIVE tap-list filter. Repaints ONLY the pool, never the whole draft box —
  // a full repaint would replace the input mid-keystroke and drop focus.
  listen(el, 'input', (e) => {
    const f = e.target.closest('[data-lfind]');
    if (!f || !draft) return;
    liveTakeQuery = f.value || '';
    const pool = el.querySelector('.auc-pool--live');
    if (pool) pool.outerHTML = liveTakePoolHtml();
  });

  // <details> does not bubble its toggle — listen in the capture phase so the
  // paste fallback stays open across a repaint.
  listen(el, 'toggle', (e) => {
    const d = e.target && e.target.closest ? e.target.closest('details.lp-paste') : null;
    if (d) pasteOpen = d.open;
  }, true);

  // Finder + reco controls (delegated on el so they survive every repaint).
  listen(el, 'change', (e) => {
    if (e.target && e.target.id === 't-rookies-only') {
      finderRookies = e.target.checked;
      paintCands();
    }
  });
  listen(el, 'click', (e) => {
    const posBtn = e.target.closest('button[data-fpos]');
    if (posBtn) {
      finderPos = posBtn.dataset.fpos;
      const row = el.querySelector('.finder-posfilter');
      if (row) {
        row.querySelectorAll('.pf-chip').forEach((c) => {
          const on = c === posBtn;
          c.classList.toggle('pf-chip--active', on);
          c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      paintCands();
      return;
    }
    const sortBtn = e.target.closest('button[data-fsort]');
    if (sortBtn) {
      const key = sortBtn.dataset.fsort;
      if (key === finderSort) {
        finderDir = finderDir === 'desc' ? 'asc' : 'desc';
      } else {
        finderSort = key;
        finderDir = 'desc';
      }
      const row = el.querySelector('.finder-sortseg');
      if (row) row.innerHTML = finderSortInner(finderSort, finderDir);
      paintCands();
      return;
    }
    const recoBtn = e.target.closest('button[data-rsort]');
    if (recoBtn) {
      const key = recoBtn.dataset.rsort;
      if (key !== recoSort) {
        recoSort = key;
        paintReco();
      }
    }
  });

  // Wire the BASE / AI+ toggle (only rendered when ai_insights loaded). The
  // choice persists in nfl2026.ai.v1; flipping it re-ranks the reco panel.
  const aiSeg = el.querySelector('.aiseg');
  if (aiSeg) {
    listen(aiSeg, 'click', (e) => {
      const btn = e.target.closest('button[data-ai]');
      if (!btn) return;
      const on = btn.dataset.ai === 'on';
      if (on === aiOn) return;
      aiOn = on;
      saveAiPref(on);
      aiSeg.querySelectorAll('button[data-ai]').forEach((b) => {
        const active = (b.dataset.ai === 'on') === on;
        b.classList.toggle('aiseg--active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      paintReco();
    });
  }

  paintAll();
}
