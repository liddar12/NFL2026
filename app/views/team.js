/* app/views/team.js — the TEAM builder view (#/team).
 *
 * Orchestrates the fit engine (app/team-logic.js — pure, node-tested) against
 * the projection + weekly contracts and paints four sections:
 *   .roster        13 slots (QB1..FLEX starters, BN1..BN6 bench) — tap an empty
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
 * Degrades honestly: player_weekly.json missing (older deploy) -> a .state
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
  scoreVsRoom, ROSTER_BOUNDS, DEFAULT_ROSTER,
} from '../draft-sim.js';
import {
  BUDGET_CHOICES, DEFAULT_BUDGET, createAuction, myTeam as aucMyTeam,
  onTheNomination, autoNominate, nominate, resolveBids, sellTo, undoLastSale,
  liveInflation, myGuidance, nominationAdvice, planBudget, scoreAuction,
  maxBid, MIN_BID, classifyNomination, fairDollars,
} from '../auction.js';
import { TEAMS } from '../teams.js';
import {
  FLEX_ELIGIBILITY, FLEX_TOKENS, LEAGUE_BOUNDS,
  cloneProfile, isDefaultProfile, loadProfile, normalizeProfile, saveProfile,
  scoringMode, validateProfile, rosterSlots, slotAccepts, firstOpenSlot,
  rosterPositionsInPlay, slotEligiblePositions,
} from '../league.js';
import {
  SLEEPER_API_BASE, buildSleeperPlayerIndex, crosswalkRoster, importFromPastedJson,
  importFromSleeper, importSleeperTeams, parseLeagueId, summarizeImport, unresolvedItems,
} from '../sleeper.js';

const TEAM_KEY = 'nfl2026.team.v1';
const SCORING_KEY = 'nfl2026.scoring.v1';
const AI_KEY = 'nfl2026.ai.v1'; // Fit Engine AI+ toggle — default OFF (base v1)
const TAKEN_KEY = 'nfl2026.taken.v1'; // draft board: ids taken by other managers
const MOCKS_KEY = 'nfl2026.mocklocks.v1'; // completed ADP-room mocks (learning locks)
const FINDER_CAP = 25; // candidate rows rendered before the "refine search" hint

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
 * Load the roster, sanitized: every slot key present, ids must exist in the
 * current player pool (dropped players vanish honestly), duplicates keep only
 * their first slot. Corrupt/absent storage -> an all-empty roster.
 */
function loadRoster(validIds, profile) {
  // ONE slot vocabulary, derived from the profile. The saved roster, the grid
  // the user taps, the engines and the Lineup page must all name slots the same
  // way. If Team writes the frozen legacy ids while Lineup reads profile-derived
  // ids, every rostered player silently disappears from the optimizer the moment
  // a league's geometry differs from the old 13-slot default.
  const order = rosterSlots(profile).all;
  const slots = Object.fromEntries(order.map((s) => [s, null]));
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
  } catch (err) {
    stored = null;
  }
  const seen = new Set();
  if (stored && stored.slots && typeof stored.slots === 'object') {
    order.forEach((s) => {
      const id = stored.slots[s] == null ? null : String(stored.slots[s]);
      if (id && validIds.has(id) && !seen.has(id)) {
        slots[s] = id;
        seen.add(id);
      }
    });
    // Migration sweep: an id parked under a slot id this profile no longer has
    // (a legacy roster, or a shape the user just changed) moves into the first
    // slot that will take it. A saved player is never dropped merely because the
    // geometry moved under him.
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

/** Roster tokens the draft simulator prices directly (its shape knows no K/DEF). */
export const DRAFTABLE_TOKENS = Object.freeze(['QB', 'RB', 'WR', 'TE']);

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
 */
export function cfgFromProfile(profile) {
  const p = normalizeProfile(profile);
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const carried = [];
  let flex = 0;
  let bench = 0;
  let flexType = null;
  p.shape.roster_positions.forEach((token) => {
    if (token === 'BN') { bench += 1; return; }
    if (FLEX_ELIGIBILITY[token]) {
      flex += 1;
      if (!flexType) flexType = token; // first flex token wins; the rest re-map
      return;
    }
    if (counts[token] != null) { counts[token] += 1; return; }
    carried.push(token); // K / DEF / DST — kept, and said out loud
  });
  const wanted = {
    qb: counts.QB, rb: counts.RB, wr: counts.WR, te: counts.TE, flex, bench,
  };
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
  return { cfg, carried, clamped };
}

/**
 * Draft-simulator config -> LeagueProfile. `base` supplies everything the
 * simulator has no opinion about (name, scoring table, position caps); the
 * shape comes from `cfg`. `carried` tokens are re-inserted after the flex
 * slots so a K/DEF league survives an edit made in this panel.
 */
export function profileFromCfg(cfg, base, carried) {
  const out = cloneProfile(normalizeProfile(base));
  const c = cfg || {};
  const token = FLEX_ELIGIBILITY[c.flexType] ? c.flexType : 'FLEX';
  const positions = [];
  const push = (t, n) => { for (let i = 0; i < clampCount(n, 0, 40); i += 1) positions.push(t); };
  push('QB', c.qb); push('RB', c.rb); push('WR', c.wr); push('TE', c.te);
  push(token, c.flex);
  (carried || []).forEach((t) => positions.push(t));
  push('BN', c.bench);
  out.shape.roster_positions = positions;
  out.shape.teams = clampCount(c.leagueSize, LEAGUE_BOUNDS.teams[0], LEAGUE_BOUNDS.teams[1]);
  out.shape.flex_eligibility = clampCount(c.flex, 0, 40) > 0
    ? { [token]: [...FLEX_ELIGIBILITY[token].positions] }
    : {};
  out.shape.draft_rounds = positions.length;
  out.shape.keepers_enabled = c.keepers === true;
  out.shape.max_keepers = c.keepers === true ? clampCount(c.maxKeepers, 0, 40) : 0;
  return normalizeProfile(out);
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
 * Sleeper's whole-league player dump. app/sleeper.js deliberately never fetches
 * it (it is multi-megabyte and a caller may already have it), so the ONE piece
 * of network this view owns is reading it — once per press, cached for the
 * mount, then handed to buildSleeperPlayerIndex().
 */
export const SLEEPER_PLAYER_INDEX_URL = `${SLEEPER_API_BASE}/players/nfl`;

/** Abort ceiling for that dump (it is far larger than a league read). */
export const SLEEPER_INDEX_TIMEOUT_MS = 45000;

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
  const order = rosterSlots(profile).all;
  const slots = {};
  order.forEach((s) => { slots[s] = null; });

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
    const slot = firstOpenSlot(position, slots, profile);
    if (!slot) {
      unplaced.push({
        ...r,
        reason: `Every slot this roster has for a ${position} is taken, so ${name} did not fit.`,
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

/* ---- mount ------------------------------------------------------------------ */

/** One-shot league status carried across the re-mount a scoring re-price forces. */
let leagueFlash = null;

export default async function mountTeam(el) {
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
  const weeklyById = new Map();
  if (weekly && Array.isArray(weekly.players)) {
    weekly.players.forEach((w) => weeklyById.set(String(w.gsis_id), w));
  }
  if (weeklyById.size === 0) {
    // Older deploy without player_weekly.json: no bye/floor/matchup math is
    // possible — say so instead of faking a fit score.
    stateMsg(el, 'Weekly data unavailable — the team builder needs the weekly '
      + 'projection feed (data/player_weekly.json), which ships with the next '
      + 'data deploy.');
    return;
  }

  // "Current week" for the filled-slot wk-pts chip (falls back to week 1).
  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(18, Math.max(1, Math.round(w)));
  }

  const mode = loadScoring(); // read-only here; the Players header owns the toggle

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
      if (mine || auction.play === 'live') {
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
  // lookahead; beat-the-room margin = the benchmark. ADP-room mocks are locked
  // to localStorage as learning records; shark room is a stress test (never
  // locked). Absent adp.json (older deploy) hides the whole section.
  const adpDoc = (adpRes.status === 'fulfilled' && adpRes.value
    && Array.isArray(adpRes.value.players) && adpRes.value.players.length > 50)
    ? adpRes.value : null;
  let draft = null;          // snake draft state (createDraft) or null
  let draftResult = null;    // scoreVsRoom sheet after a finished snake draft
  let auction = null;        // auction room state (createAuction) or null
  let auctionResult = null;  // scoreAuction sheet after a finished auction
  let bidAdj = 0;            // my +/- adjustment to the advised bid, per block
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
    ...seeded.cfg,
  };
  if (draftCfg.mySlot > draftCfg.leagueSize) draftCfg.mySlot = draftCfg.leagueSize;

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
  const kdstIndex = shapeKdst(kdstRes.status === 'fulfilled' ? kdstRes.value : null, savedProfile);
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

  // League-settings panel state (all of it survives a paintDraft() repaint).
  let leagueStatus = leagueFlash;   // {tone, lines} — one-shot across a re-mount
  leagueFlash = null;
  let importReport = null;          // report from the last Sleeper import
  let importLines = [];             // summarizeImport() plain-language lines
  let importUnresolved = [];        // unresolvedItems() — the honesty list
  let importProfile = null;         // the profile that import produced
  let sleeperId = '';               // league id / URL typed into the sync field
  let pasteText = '';               // pasted league JSON
  let pasteOpen = false;            // <details> disclosure state
  let syncBusy = false;             // a SYNC NOW request is in flight
  // ROSTER SYNC (R20-B4). All of it is session state: the roster itself is the
  // only thing that ever gets written, and only on a deliberate confirm.
  let sleeperIndex = null;          // buildSleeperPlayerIndex().index, cached for the mount
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
  let resetArmed = false;    // two-step RESET confirm

  /** id -> adjusted season points at the CURRENT scoring mode (draft pricing). */
  function adjPointsMap() {
    return new Map(players.map((p) => {
      const id = String(p.gsis_id);
      return [id, adjById.get(id) || 0];
    }));
  }

  // Per-mode derived maps, built once per mount (mode changes re-mount):
  //   adjById    id -> season points at the current scoring mode (EXACT)
  //   scaledById id -> 18 weekly floats at the current scoring mode (byes 0)
  const playersById = new Map(seatable.map((p) => [String(p.gsis_id), p]));
  const adjById = new Map();
  const scaledById = new Map();
  players.forEach((p) => {
    const id = String(p.gsis_id);
    const e = weeklyById.get(id);
    const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode);
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

  const roster = loadRoster(new Set(playersById.keys()), savedProfile);
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

  let _ourDollars = null;
  let _ourDollarsKey = '';

  /**
   * OUR dollars for the board: value over replacement from OUR projections,
   * allocated across the league (app/auction.js fairDollars). While an auction
   * room is open we use that room's own `fair` map so one page never shows two
   * different prices for the same player.
   */
  function ourDollarsById() {
    if (!adpDoc) return null;
    if (auction && auction.fair) return auction.fair;
    const key = `${draftCfg.leagueSize}|${draftCfg.budget}|${draftCfg.qb},${draftCfg.rb},`
      + `${draftCfg.wr},${draftCfg.te},${draftCfg.flex},${draftCfg.bench}`;
    if (_ourDollars && _ourDollarsKey === key) return _ourDollars;
    const rows = adpDoc.players.filter((r) => r && r.gsis_id);
    const adjOf = (r) => {
      const v = adjById.get(String(r.gsis_id));
      return Number.isFinite(v) ? v : 0;
    };
    _ourDollars = fairDollars(rows, adjOf, draftCfg.leagueSize, draftCfg.budget,
      rosterShape(draftCfg));
    _ourDollarsKey = key;
    return _ourDollars;
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

  /** Column key for the value cell — one per section, never one per row. */
  function valueLegendHtml() {
    if (!adpDoc) return '';
    return (
      '<div class="cd-vallegend">'
        + '<span class="cvl-txt">OURS = our auction price (VOR). '
        + 'AUC = ESPN\'s average winning bid. '
        + 'OVER / UNDER = are you paying above or below the room.</span>'
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
      '<button type="button" class="sort-chip reset-btn" data-act="reset" ' +
        'title="Clear the roster, the TAKEN board, and any draft in progress">RESET</button>' +
    '</div>' +
    // Two-column grid on wide screens (iPad 13"): builder column (roster +
    // finder + reco) beside the summary. On phones it is a single column.
    '<div class="team-grid">' +
      '<div class="team-col team-col--build">' +
        '<section class="draftsim" id="t-draft" aria-label="Draft simulator"></section>' +
        '<section class="roster" id="t-roster" role="listbox" aria-label="Roster slots"></section>' +
        '<section class="finder" aria-label="Player finder">' +
          '<input class="finder-input" id="t-find" type="search" autocomplete="off" ' +
            'placeholder="SEARCH NAME · TEAM · POS" aria-label="Search player pool">' +
          '<div class="finder-controls">' +
            `${finderPosRow(finderPos, kdstChips)}${finderSortRow(finderSort, finderDir)}` +
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
        body =
          `<button type="button" class="slot-empty" data-act="pick" data-slot="${slot}">` +
            `ADD ${label}</button>`;
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
      const sel = selectedSlot === slot && !id;
      return (
        `<div class="slot${sel ? ' slot--active' : ''}" role="option" data-slot="${slot}" ` +
          `aria-selected="${sel ? 'true' : 'false'}">` +
          `<span class="slot-pos">${pos}</span>${body}` +
        '</div>'
      );
    });
    el.querySelector('#t-roster').innerHTML = rows.join('');
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
    const rows = hits.slice(0, FINDER_CAP).map((p) => {
      const id = String(p.gsis_id);
      const open = firstEligibleOpenSlot(p.position);
      const capped = positionAtCap(p.position, roster.slots, playersById, savedProfile);
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
  }

  /** BEST PICK NOW strip: top-3 by value over replacement, from the SAME
   * available pool the fit engine sees, so TAKEN players are excluded and the
   * strip re-ranks live as players are taken. Empty picks -> no strip. */
  function bestPickStrip(pool) {
    const picks = bestPickNow(roster, pool, weeklyById, mode, undefined, savedProfile);
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
    const recos = ai
      ? recommendV2(roster, pool, weeklyById, mode, target, aiInsights, { sort: recoSort },
        savedProfile)
      : recommend(roster, pool, weeklyById, mode, target, { sort: recoSort }, savedProfile);
    const sortLabel = recoSort === 'available' ? 'BEST AVAIL' : 'BEST FIT';
    const head =
      '<div class="reco-head">' +
        `<span class="reco-slot">FIT ENGINE${ai ? ' · AI+' : ''} · ${esc(target)}</span> ` +
        `<span class="reco-controls">${recoSortInner(recoSort)}</span> ` +
        '<span class="est">ESTIMATE</span>' +
      '</div>' +
      // What AI+ optimizes for — the answer to "what is the AI doing?". Only
      // shown when AI+ is on, so BASE stays byte-identical to before.
      (ai
        ? '<div class="reco-explain">AI+ re-ranks by 5-yr trajectory, cold-weather edge, and stack synergy '
          + '— tuned to raise your weekly ceiling and playoff odds. Δ vs BASE shown per pick.</div>'
        : '') +
      `<div class="reco-sublabel">Ranked by ${sortLabel}${ai ? ' · AI+' : ''}</div>`;
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
        `<span class="ts-total">${fix1(seasonTotal)}</span> ` +
        '<span class="est">ESTIMATE</span>' +
      '</div>' +
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

  /** Does the on-screen shape differ from what is actually persisted? */
  function leagueDirty() {
    return JSON.stringify(profileFromCfg(draftCfg, stagedProfile, carriedTokens))
      !== JSON.stringify(savedProfile);
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
        + '<span class="ds-sub-note">MANUAL SYNC ONLY</span></div>'
      + '<div class="m-explain">Pull the players actually on your Sleeper team into the roster '
        + 'above, so it stops needing hand entry. Uses the same league id as the settings sync. '
        + 'It runs ONLY when you press the button — there is no polling and no background '
        + 'refresh. A Sleeper roster carries player ids and no names, so the first press also '
        + 'downloads Sleeper\'s player list (several MB); it is kept for this visit, so a '
        + 'second sync does not download it again. Nothing is written until you confirm, and '
        + 'every player it cannot match is listed by name.</div>'
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
    const rounds = draftCfg.qb + draftCfg.rb + draftCfg.wr + draftCfg.te
      + draftCfg.flex + draftCfg.bench;
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
    if (carriedTokens.length > 0) seedNotes.push(
      `${carriedTokens.join(', ')} stay on your league profile but the draft simulator does not `
      + 'draft them.');

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
      + leagueStatusHtml()
      + (seedNotes.length
        ? `<div class="lp-notes">${seedNotes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>`
        : '')
      + '<div class="m-explain">SAVE writes these to your league profile and RE-PRICES the '
        + 'board: league size and roster shape feed replacement level, VOR and beat-the-room '
        + 'draft value straight away, and the reception value sets the scoring mode the whole '
        + 'app projects at. None of it is ever an input to the learned-signal gate — nothing is '
        + 'retrained. Two limits, said plainly: the 13-slot roster panel on this page is still '
        + 'fixed, and the opponent model drafts every FLEX as WR/RB/TE, so a SUPERFLEX league '
        + 'is priced as if its flex were WR/RB/TE.</div>'
      + '<div class="ds-sub"><span>SLEEPER</span>'
        + '<span class="ds-sub-note">MANUAL SYNC ONLY</span></div>'
      + '<div class="lp-sync">'
        + '<label class="lp-field lp-field--grow">'
          + '<span class="ds-lbl">LEAGUE ID OR URL</span>'
          + '<input class="lp-input" type="text" data-lin="sleeperId" autocomplete="off" '
            + `spellcheck="false" placeholder="1051234567890123456" value="${esc(sleeperId)}" `
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

  /* ---- ROSTER SYNC network + wiring ---------------------------------------- */

  /**
   * The ONE fetch this view owns: Sleeper's player dump. /rosters and /users go
   * through app/sleeper.js importSleeperTeams(); the dump does not, because
   * that module deliberately never fetches a multi-megabyte document on a
   * caller's behalf.
   *
   * Same request discipline app/sleeper.js documents, for the same reasons:
   * `credentials: 'omit'` (Sleeper's wildcard ACAO is illegal for a credentialed
   * request), NO author headers (any header outside the CORS safelist would
   * force a preflight), and an AbortController timeout so a hung socket cannot
   * hang the page. That timeout is the ONLY timer in this path — no polling.
   *
   * Returns { ok, payload, status, error } and never throws.
   */
  async function sleeperGetJson(url, timeoutMs) {
    const fetchImpl = typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null;
    if (!fetchImpl) {
      return { ok: false, payload: null, status: 0, error: 'This browser has no fetch, so the roster sync cannot run.' };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    let timer = null;
    if (controller) {
      timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch (_) { /* already aborted */ } }, timeoutMs);
    }
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        redirect: 'follow',
        signal: controller ? controller.signal : undefined,
      });
      if (!res || typeof res.status !== 'number') {
        return { ok: false, payload: null, status: 0, error: 'Sleeper returned something that is not an HTTP response.' };
      }
      if (res.status === 404) {
        return { ok: false, payload: null, status: 404, error: 'Sleeper has no such league — check the id in your league URL.' };
      }
      if (res.status === 429) {
        return { ok: false, payload: null, status: 429, error: 'Sleeper is rate-limiting this device. Wait a minute and press SYNC ROSTER again.' };
      }
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, payload: null, status: res.status, error: `Sleeper answered HTTP ${res.status}.` };
      }
      const text = await res.text();
      try {
        return { ok: true, payload: JSON.parse(text), status: res.status, error: null };
      } catch (parseErr) {
        return { ok: false, payload: null, status: res.status, error: 'Sleeper\'s response was not JSON.' };
      }
    } catch (err) {
      if (timedOut) {
        return { ok: false, payload: null, status: 0, error: `Sleeper did not answer within ${Math.round(timeoutMs / 1000)}s.` };
      }
      return {
        ok: false,
        payload: null,
        status: 0,
        error: 'Could not reach Sleeper. This is usually the network or a browser extension '
          + `blocking the request (${err && err.message ? err.message : String(err)}).`,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
        : 'Reading the rosters from Sleeper, then its player index (several MB — this can '
          + 'take a moment).'],
    };
    paintDraft();

    // /rosters + /users, read and joined by app/sleeper.js.
    const teamsRes = await importSleeperTeams(leagueId);
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

    // The player dump is the one thing app/sleeper.js will not fetch for us
    // (multi-megabyte, and a caller may already hold it), so this view reads it
    // once per press and keeps it for the mount.
    if (!sleeperIndex) {
      const idxRes = await sleeperGetJson(SLEEPER_PLAYER_INDEX_URL, SLEEPER_INDEX_TIMEOUT_MS);
      const built = idxRes.ok ? buildSleeperPlayerIndex(idxRes.payload) : null;
      if (!built || !built.ok) {
        rosterBusy = false;
        rosterStatus = {
          tone: 'err',
          lines: [idxRes.ok
            ? ((built && built.error && built.error.message)
              || 'Sleeper\'s player list came back in a shape this app does not recognise.')
            : idxRes.error,
          'Without that list a roster is a list of opaque ids, so nothing can be matched. '
            + 'Nothing on your roster was changed.'],
        };
        paintDraft();
        return;
      }
      sleeperIndex = built.index;
    }

    rosterTeams = teamsRes.teams;
    rosterBusy = false;
    if (rosterTeams.length === 1) {
      rosterTeamIdx = 0;
      buildRosterPlan();
      notes.unshift('This league has one roster, so it was selected for you. Check the plan '
        + 'below before confirming.');
    } else {
      notes.unshift(`${rosterTeams.length} teams read. Pick yours — nothing is written until `
        + 'you confirm.');
    }
    rosterStatus = { tone: teamsRes.users_error ? 'warn' : 'ok', lines: notes };
    paintDraft();
  }

  /** Fold an ImportResult into the panel: it stages, it never saves. */
  function applyImport(res) {
    importReport = res && res.report ? res.report : null;
    importLines = summarizeImport(res);
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
      if (mapped.carried.length > 0) lines.push(
        `${mapped.carried.join(', ')} kept on the profile — the simulator does not draft them.`);
      leagueStatus = { tone: 'ok', lines };
    } else {
      importProfile = null;
      leagueStatus = { tone: 'err', lines: importLines };
    }
    paintDraft();
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
    const starters = draftCfg.qb + draftCfg.rb + draftCfg.wr + draftCfg.te + draftCfg.flex;
    const rounds = starters + draftCfg.bench;
    // 8/10/12 are the offered sizes; an imported league of any other size keeps
    // its own number in the menu rather than being silently shown as 8.
    const teamsOptions = [...new Set([8, 10, 12, draftCfg.leagueSize])].sort((a, b) => a - b);
    return (
      '<div class="ds-head"><span class="ds-title">DRAFT SIMULATOR</span> ' +
        '<span class="est">ESTIMATE</span></div>' +
      '<div class="m-explain">Mock a full snake draft: opponents follow real ADP ' +
        '(the market) with need-aware noise; your picks come from the VOR engine with a ' +
        'survival forecast for your next turn. Beat-the-room margin is the score. ' +
        'SHARK room (everyone drafts like our engine) is a stress test and is never ' +
        'recorded as market evidence.</div>' +
      `<div class="ds-sub"><span>LEAGUE</span><span class="ds-sub-note">${draftCfg.mode === 'auction' ? `AUCTION · $${draftCfg.budget} BUDGET` : 'SNAKE DRAFT'}</span></div>` +
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
          ? field('budget', 'BUDGET',
              BUDGET_CHOICES.map((b) => opt(b, draftCfg.budget, `$${b}`)).join(''))
          : field('roomType', 'ROOM',
              `<option value="adp"${draftCfg.roomType === 'adp' ? ' selected' : ''}>ADP</option>` +
              `<option value="shark"${draftCfg.roomType === 'shark' ? ' selected' : ''}>SHARK</option>`)) +
      '</div>' +
      `<div class="ds-sub"><span>ROSTER</span><span class="ds-sub-note">${starters} STARTERS + ${draftCfg.bench} BENCH · ${rounds} ROUNDS</span></div>` +
      '<div class="ds-grid ds-grid--roster">' +
        stepper('qb', 'QB') + stepper('rb', 'RB') + stepper('wr', 'WR') +
        stepper('te', 'TE') + stepper('flex', 'FLEX') + stepper('bench', 'BENCH') +
      '</div>' +
      leaguePanelHtml() +
      (draftCfg.mode === 'auction'
        ? `<button type="button" class="cand-add ds-start" data-act="auc-start">START ${draftCfg.play === 'live' ? 'LIVE ' : ''}AUCTION · $${draftCfg.budget} · ${rounds} SLOTS</button>`
        : `<button type="button" class="cand-add ds-start" data-act="draft-start">START ${draftCfg.play === 'live' ? 'LIVE ' : ''}DRAFT · ${rounds} ROUNDS</button>`)
    );
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
      const avail = [];
      for (let i = 0; i < draft.board.length && avail.length < 15; i += 1) {
        if (!draft.taken.has(i)) avail.push({ i, row: draft.board[i] });
      }
      body =
        `<div class="ds-turn">TEAM ${clock + 1} IS ON THE CLOCK — tap the player they took</div>` +
        '<div class="auc-pool">' +
        avail.map((c) => (
          `<button type="button" class="sort-chip auc-poolchip" data-act="draft-live-take" data-bi="${c.i}">` +
            `${esc(c.row.name)} <span class="cd-meta">${esc(c.row.position)} · ADP ${c.row.adp}</span></button>`
        )).join('') + '</div>';
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
        draft.mySlot - 1, draft.seed + draft.pick, 150);
      body =
        `<div class="ds-turn">YOUR PICK — ROUND ${round}</div>` +
        top.map((c) => {
          const sp = surv.get(c.i);
          const pct = sp != null ? Math.round(sp * 100) : null;
          const risk = pct != null
            ? `<span class="ds-surv${pct < 40 ? ' ds-surv--hot' : ''}">${pct}% survives to your next pick</span>`
            : '';
          return (
            `<div class="ds-cand">` +
              `<span class="cd-name">${esc(c.row.name)}</span>` +
              `<span class="cd-meta">${esc(c.row.position)} · ADP ${c.row.adp} · ${fix1(c.pts)} pts</span>` +
              risk +
              `<button type="button" class="cand-add" data-act="draft-pick" data-bi="${c.i}">PICK</button>` +
            '</div>'
          );
        }).join('');
    }
    return (
      '<div class="ds-head"><span class="ds-title">' +
        `${draft.play === 'live' ? 'LIVE DRAFT' : 'DRAFT SIMULATOR'} · ` +
        `${draft.roomType === 'shark' ? 'SHARK' : 'ADP'} ROOM</span> ` +
        `<span class="ds-status">PICK ${Math.min(draft.pick + 1, draft.totalPicks)}/${draft.totalPicks}</span> ` +
        (draft.play === 'live' && draft.log.length
          ? '<button type="button" class="sort-chip auc-mini" data-act="draft-undo">UNDO</button> '
          : '') +
        '<button type="button" class="sort-chip" data-act="draft-close">EXIT</button></div>' +
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
        `${beat ? 'BEAT' : 'LOST TO'} THE ${draft.roomType === 'shark' ? 'SHARK' : 'ADP'} ROOM BY ` +
        `${fix1(Math.abs(r.margin))} PTS</div>` +
      `<div class="ds-sheet">You ${fix1(r.mine)} · room avg ${fix1(r.roomAvg)} · ` +
        `rank ${r.rank}/${r.teams} <span class="est">ESTIMATE</span></div>` +
      `<div class="ds-roster">${my}</div>` +
      (draft.roomType === 'adp'
        ? '<div class="m-explain">Locked as a learning record: when real season points resolve, this mock grades whether beating ADP here was right — and the fit engine refits through NEVER-REGRESS.</div>'
        : '<div class="m-explain">Shark-room drill — not recorded as market evidence.</div>')
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
          `<span class="auc-tname">${me ? 'YOU' : `T${i + 1}`}</span>` +
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
        ? `<div class="cd-meta">${g.threats.length} team${g.threats.length > 1 ? 's' : ''} can fight you: ${g.threats.map((t) => `T${t.team}(${dollar(t.estWill)})`).join(' ')}</div>`
        : '<div class="cd-meta">no credible threats at that number</div>';
      const soldBase = Math.max(1, g.adjusted + bidAdj); // buyer cap applies at record time
      const soldControls = live
        ? '<div class="auc-soldrow">SOLD TO ' +
          `<select class="ds-select auc-soldteam">${auction.teams.map((_, i) => `<option value="${i}">${i === auction.mySlot - 1 ? 'YOU' : `T${i + 1}`}</option>`).join('')}</select>` +
          ' FOR <span class="auc-bidnum auc-soldprice" data-price="' + soldBase + '">' + dollar(soldBase) + '</span>' +
          '<button type="button" class="sort-chip" data-act="auc-price-minus">−</button>' +
          '<button type="button" class="sort-chip" data-act="auc-price-plus">+</button>' +
          '<button type="button" class="cand-add" data-act="auc-sold">RECORD SALE</button></div>'
        : '<div class="auc-bidrow">' +
          '<button type="button" class="sort-chip" data-act="auc-bid-minus">−</button>' +
          `<span class="auc-bidnum">${dollar(myMax)}</span>` +
          '<button type="button" class="sort-chip" data-act="auc-bid-plus">+</button>' +
          `<button type="button" class="cand-add" data-act="auc-bid" data-max="${myMax}">BID TO ${dollar(myMax)}</button>` +
          '<button type="button" class="sort-chip" data-act="auc-bid" data-max="0">PASS</button></div>';
      return (
        '<div class="auc-zone auc-zone--block"><div class="auc-zhead">THE BLOCK ' +
          '<button type="button" class="sort-chip auc-mini" data-act="auc-cancel" title="Wrong player? Return to nomination">✕ SWAP</button></div>' +
          `<div class="auc-player"><span class="cd-name">${esc(row.name)}</span> <span class="cd-meta">${esc(row.position)} · ADP ${row.adp}</span></div>` +
          `<div class="auc-prices">OURS ${dollar(g.fair)} · INFL-ADJ ${dollar(g.adjusted)} · MARKET ${dollar(g.market)}</div>` +
          chip +
          `<div class="auc-verdict">⚡ ${verdict}</div>` +
          threats + soldControls +
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
    const plan = planBudget(auction.shape, auction.budget, strategy.style);
    const spent = auction.budget - me.budget;
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
    return (
      '<div class="auc-zone auc-zone--build"><div class="auc-zhead">MY BUILD</div>' +
        `<div class="auc-budget">${dollar(me.budget)} LEFT <span class="cd-meta">of $${auction.budget} · max bid ${dollar(maxBid(me.budget, auction.shape.size - me.players.length))} · $1 bench x ${plan.benchDollars}</span></div>` +
        `<div class="auc-budgetbar"><span style="width:${Math.min(100, (spent / auction.budget) * 100).toFixed(0)}%"></span></div>` +
        rows +
      '</div>'
    );
  }

  function auctionRoomHtml() {
    return (
      '<div class="ds-head"><span class="ds-title">' +
        `${auction.play === 'live' ? 'LIVE AUCTION' : 'AUCTION SIMULATOR'} · $${auction.budget}</span> ` +
        `<span class="ds-status">${auction.log.length}/${auction.leagueSize * auction.shape.size} SOLD</span> ` +
        '<button type="button" class="sort-chip" data-act="auc-close">EXIT</button></div>' +
      aucToggles() +
      '<div class="auc-room">' + aucRoomZone() + aucBlockZone() + aucBuildZone() + '</div>'
    );
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
      `<div class="ds-roster">${my}</div>` +
      '<div class="m-explain">Locked as a learning record: when real season points resolve, the bid advice grades against outcomes through NEVER-REGRESS.</div>'
    );
  }

  function paintDraft() {
    const box = el.querySelector('#t-draft');
    if (!box) return;
    if (!adpDoc) {
      box.innerHTML = '';
      return;
    }
    if (auction && auctionResult) box.innerHTML = auctionResultHtml();
    else if (auction) box.innerHTML = auctionRoomHtml();
    else if (draft && draftResult) box.innerHTML = draftResultHtml();
    else if (draft) box.innerHTML = draftLiveHtml();
    else box.innerHTML = draftSetupHtml();
  }

  function paintAll() {
    paintDraft();
    paintRoster();
    paintCands();
    paintReco();
    paintSummary();
  }

  /* ---- events ---------------------------------------------------------------- */


  /** Draft finished: score vs the room; ADP-room mocks are locked locally. */
  function finishDraft() {
    const mine = draft.rosters[draft.mySlot - 1].players;
    const opp = draft.rosters
      .filter((_, i) => i !== draft.mySlot - 1)
      .map((r) => r.players);
    draftResult = scoreVsRoom(mine, opp, draft.shape, draft.adjOf);
    if (draft.roomType === 'adp') {
      try {
        const locks = JSON.parse(localStorage.getItem(MOCKS_KEY) || '[]');
        locks.push({
          created_utc: new Date().toISOString(),
          league_size: draft.leagueSize,
          my_slot: draft.mySlot,
          roster_config: draft.shape.config,
          result: draftResult,
          my_players: mine.map((p) => ({ gsis_id: p.gsis_id, name: p.name, position: p.position })),
        });
        localStorage.setItem(MOCKS_KEY, JSON.stringify(locks.slice(-50)));
      } catch (err) {
        /* storage blocked — the result still displays */
      }
    }
  }

  /** Auction finished: score vs the room; lock as a learning record. */
  function finishAuction() {
    auctionResult = scoreAuction(auction);
    try {
      const locks = JSON.parse(localStorage.getItem(MOCKS_KEY) || '[]');
      locks.push({
        created_utc: new Date().toISOString(),
        kind: 'auction',
        play: auction.play || 'sim',
        league_size: auction.leagueSize,
        budget: auction.budget,
        roster_config: auction.shape.config,
        result: auctionResult,
        my_players: aucMyTeam(auction).players
          .map((pp) => ({ gsis_id: pp.gsis_id, name: pp.name, position: pp.position })),
      });
      localStorage.setItem(MOCKS_KEY, JSON.stringify(locks.slice(-50)));
    } catch (err) {
      /* storage blocked — the result still displays */
    }
  }

  function onAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled || !el.contains(t)) return;
    const act = t.dataset.act;

    if (act !== 'reset' && resetArmed) {
      // Any other action disarms the pending reset (no accidental wipes).
      resetArmed = false;
      const rb = el.querySelector('.reset-btn');
      if (rb) { rb.textContent = 'RESET'; rb.classList.remove('reset-btn--armed'); }
    }

    if (act !== 'roster-apply' && rosterArmed) {
      // Same rule for the roster overwrite: the armed confirm survives nothing
      // but a second tap on the same button, and the panel repaints so the
      // button can never LOOK armed while it is not (or the reverse).
      rosterArmed = false;
      paintDraft();
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


    if (act === 'reset') {
      // Two-step confirm: first tap arms, second tap wipes roster + taken +
      // any draft in progress. Arm state resets on any other action.
      if (!resetArmed) {
        resetArmed = true;
        t.textContent = 'TAP AGAIN TO CONFIRM';
        t.classList.add('reset-btn--armed');
        return;
      }
      resetArmed = false;
      slotOrder().forEach((slot) => { roster.slots[slot] = null; });
      taken.clear();
      draft = null;
      draftResult = null;
      auction = null;
      auctionResult = null;
      saveRoster(roster);
      saveTaken(taken);
      t.textContent = 'RESET';
      t.classList.remove('reset-btn--armed');
      paintAll();
      return;
    }

    if (act === 'league-save') {
      // Persist the league + roster settings as the LeagueProfile. This is the
      // only writer of nfl2026.league.v1 in this view, and it RE-PRICES: the
      // shape it writes is the shape the draft room prices against, and the
      // reception value it carries is the scoring mode the app projects at.
      const next = profileFromCfg(draftCfg, stagedProfile, carriedTokens);
      const wrote = saveProfile(next);
      savedProfile = next;
      stagedProfile = cloneProfile(next);
      const remapped = cfgFromProfile(next);
      carriedTokens = remapped.carried;
      clampedNotes = remapped.clamped;
      const lines = [wrote
        ? `Saved: ${next.name} · ${next.shape.teams} teams · ${next.shape.starters} starters `
          + `+ ${next.shape.bench} bench · ${next.shape.draft_rounds} rounds`
          + `${next.shape.keepers_enabled
            ? ` · ${next.shape.max_keepers} keeper${next.shape.max_keepers === 1 ? '' : 's'}`
            : ''}.`
        : 'Storage is blocked, so nothing was written to disk. These settings still drive this '
          + 'session, but they will not survive a reload.'];
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
        leagueFlash = { tone: wrote ? 'ok' : 'warn', lines };
        Promise.resolve(mountTeam(el)).catch(() => { /* the mounted view reports its own state */ });
        return;
      }
      if (nextMode === 'custom') {
        lines.push(`Reception is ${receptionLabel(next)} — the projection conversion only knows `
          + `1, 0.5 and 0, so the board stays at ${mode.toUpperCase()}.`);
      }
      leagueStatus = { tone: wrote ? 'ok' : 'warn', lines };
      paintDraft();
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
        syncBusy = false;
        applyImport(res);
      }).catch((err) => {
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
      if (!rosterPlan || rosterApplied || !rosterCross) return;
      // Re-plan against the roster and profile AS THEY ARE NOW. If anything
      // moved since the plan was drawn (a player added by hand, a league shape
      // saved), the confirm on screen no longer describes what would happen —
      // so it is redrawn and re-armed rather than executed.
      const fresh = planRosterSync({
        resolved: orderedRosterPlayers(rosterCross),
        currentSlots: roster.slots,
        profile: savedProfile,
        playersById,
      });
      const unchanged = JSON.stringify(fresh) === JSON.stringify(rosterPlan);
      rosterPlan = fresh;
      if (!unchanged) {
        rosterArmed = false;
        rosterStatus = {
          tone: 'warn',
          lines: ['Your roster or league shape changed since this plan was drawn, so it was '
            + 'recalculated. Read what will be removed, then confirm again.'],
        };
        paintDraft();
        return;
      }
      const filledNow = Object.values(roster.slots).filter(Boolean).length;
      if (filledNow > 0 && !rosterArmed) {
        // DELIBERATE CONFIRM. The panel already names every player that goes;
        // this second tap is the user saying they read it.
        rosterArmed = true;
        paintDraft();
        return;
      }
      rosterArmed = false;
      slotOrder().forEach((slot) => {
        roster.slots[slot] = rosterPlan.slots[slot] || null;
      });
      saveRoster(roster);
      selectedSlot = null;
      rosterApplied = true;
      rosterStatus = {
        tone: 'ok',
        lines: [`Roster replaced from Sleeper: ${rosterPlan.after_count} player(s) seated, `
          + `${rosterPlan.dropped.length} removed.`,
        ...(rosterPlan.unplaced.length > 0 || rosterMissed.length > 0
          ? ['The players listed below as unmatched or unseated were NOT added — they are '
            + 'still yours in Sleeper, this app just has no slot or no projection for them.']
          : [])],
      };
      paintAll();
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
        boardRows: adpDoc.players,
        adjPointsById: adjPointsMap(),
        seed: 20260901 + draftCfg.leagueSize * 100 + draftCfg.mySlot,
        excludedIds: [...taken],
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
      draft = null;
      draftResult = null;
      paintAll();
      return;
    }

    if (act === 'draft-live-take') {
      takeOpponentPickAt(draft, Number(t.dataset.bi));
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
      paintAll();
      return;
    }

    if (act === 'auc-undo') {
      undoLastSale(auction);
      auctionResult = null;
      bidAdj = 0;
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'auc-start') {
      auctionResult = null;
      bidAdj = 0;
      syncedOthers.clear();
      syncedMine.clear();
      auction = createAuction({
        leagueSize: draftCfg.leagueSize,
        mySlot: Math.min(draftCfg.mySlot, draftCfg.leagueSize),
        budget: draftCfg.budget,
        rosterConfig: draftCfg,
        boardRows: adpDoc.players.filter((pp) => !taken.has(String(pp.gsis_id))),
        adjPointsById: adjPointsMap(),
        seed: 20260901 + draftCfg.leagueSize * 100 + draftCfg.mySlot,
      });
      auction.play = draftCfg.play;
      paintAll();
      return;
    }

    if (act === 'auc-close') {
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
      paintAll();
      return;
    }

    if (act === 'auc-sim-nom') {
      const bi = autoNominate(auction);
      if (bi >= 0) { nominate(auction, bi); bidAdj = 0; }
      else { auction.done = true; }
      if (auction.done) finishAuction();
      paintDraft();
      return;
    }

    if (act === 'auc-bid-minus' || act === 'auc-price-minus') {
      bidAdj -= 1;
      paintDraft();
      return;
    }
    if (act === 'auc-bid-plus' || act === 'auc-price-plus') {
      bidAdj += 1;
      paintDraft();
      return;
    }

    if (act === 'auc-bid') {
      // Resolve the block against the room with my ceiling (0 = pass/enforce off).
      const { winnerIdx, price } = resolveBids(auction, Number(t.dataset.max) || 0);
      sellTo(auction, winnerIdx, price, auction.block.boardIdx);
      bidAdj = 0;
      if (auction.done) finishAuction();
      syncLiveRoom();
      paintAll();
      return;
    }

    if (act === 'auc-sold') {
      // LIVE: record the observed sale exactly as it happened in the real room.
      const sel = el.querySelector('.auc-soldteam');
      const priceEl = el.querySelector('.auc-soldprice');
      const teamIdx = sel ? Number(sel.value) : 0;
      const base = priceEl ? Number(priceEl.dataset.price) : 1;
      // Clamp to what the BUYER can legally pay ($1 reserved per other open
      // slot); sellTo's budget clamp backstops even this.
      const buyer = auction.teams[teamIdx];
      const price = Math.max(0, Math.min(base,
        maxBid(buyer.budget, auction.shape.size - buyer.players.length)));
      sellTo(auction, teamIdx, price, auction.block.boardIdx);
      bidAdj = 0;
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

  el.addEventListener('click', onAction);
  // Keyboard parity for the div-based remove control (role="button").
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-act][role="button"]')) {
      e.preventDefault();
      onAction(e);
    }
  });
  // Debounced search: repaint the candidate list at most once per ~140ms of
  // typing instead of on every keystroke — the list rebuild (filter + sort +
  // up-to-FINDER_CAP rows) is wasted work between characters.
  let _findTimer = null;
  el.querySelector('#t-find').addEventListener('input', (e) => {
    query = e.target.value || '';
    if (_findTimer) clearTimeout(_findTimer);
    _findTimer = setTimeout(() => { _findTimer = null; paintCands(); }, 140);
  });

  // Draft setup selects (delegated change — the section repaints often).
  el.addEventListener('change', (e) => {
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

  // Sleeper ROSTER team picker — selecting a team re-plans (it never writes).
  el.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-rcfg]');
    if (!sel || sel.dataset.rcfg !== 'team') return;
    const n = Number(sel.value);
    rosterTeamIdx = Number.isInteger(n) && n >= 0 && rosterTeams && n < rosterTeams.length
      ? n : -1;
    buildRosterPlan();
    paintDraft();
  });

  // League-profile selects (FLEX eligibility + keepers) — same delegation.
  el.addEventListener('change', (e) => {
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
  // setup-card repaint restores it instead of eating it.
  el.addEventListener('input', (e) => {
    const f = e.target.closest('[data-lin]');
    if (!f) return;
    if (f.dataset.lin === 'sleeperId') sleeperId = f.value || '';
    else if (f.dataset.lin === 'pasteText') pasteText = f.value || '';
  });

  // <details> does not bubble its toggle — listen in the capture phase so the
  // paste fallback stays open across a repaint.
  el.addEventListener('toggle', (e) => {
    const d = e.target && e.target.closest ? e.target.closest('details.lp-paste') : null;
    if (d) pasteOpen = d.open;
  }, true);

  // Finder + reco controls (delegated on el so they survive every repaint).
  el.addEventListener('click', (e) => {
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
    aiSeg.addEventListener('click', (e) => {
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
