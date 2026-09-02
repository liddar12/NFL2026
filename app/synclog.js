/* app/synclog.js — THE SYNC LOG (pure, no DOM). R48.
 *
 * A small persisted record of what each Sleeper sync CHANGED on this device,
 * plus the two diffs the LEAGUE tab paints: how the applied league's scoring
 * table departs from standard PPR, and how its roster shape departs from the
 * default. Every function here is PURE and DOM-free — no fetch, no document.
 * localStorage is reached only through an INJECTED storage handle (defaulting
 * to globalThis.localStorage when one exists), the same idiom as
 * app/league.js, so tests/feature/r48_league_tab.test.mjs imports this file
 * under node with zero setup.
 *
 * WHO WRITES: app/views/team.js calls recordSync() after its settings sync and
 * after its roster sync, then dispatches the 'nfl2026:league' window event.
 * WHO READS: app/views/league.js (the LEAGUE tab), on mount and on that event.
 *
 * HONESTY CONTRACT:
 *   - Absent is NOT zero. A key the league table does not carry is reported as
 *     `league: null` ("not in table"); a key standard PPR does not price is
 *     `standard: null` ("not scored"). Nothing here invents a 0 for display.
 *     `delta` is the arithmetic difference with absent read as 0 — it exists
 *     for SORTING only (biggest departure first) and is never shown as a value.
 *   - Corrupt / absent / hostile storage reads as [] and NEVER throws.
 *   - The log is a ring: newest first, capped at SYNC_LOG_CAP.
 *
 * SHAPES:
 *   entry   { kind:'settings'|'roster', at:ISO string, league_id:string|null,
 *             league_name:string|null, changes:[string], details?:object }
 *   diffRow { key, league:number|null, standard:number|null, delta, label }
 */

import { DEFAULT_PROFILE, DEFAULT_SCORING, SCORING_FIELDS, normalizeProfile } from './league.js';

/** localStorage key. v1 — bump only on a shape change that cannot be migrated. */
export const SYNC_LOG_KEY = 'nfl2026.synclog.v1';

/** Newest entries kept. */
export const SYNC_LOG_CAP = 20;

/** Longest change list one entry keeps (a roster sync could list every slot). */
const MAX_CHANGE_LINES = 60;

/* --------------------------------------------------------------------------
 * Small helpers (same defensive idiom as app/league.js)
 * ------------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toFinite(v) {
  if (typeof v === 'boolean' || v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The ambient localStorage, or null when unavailable/blocked. */
function defaultStorage() {
  try {
    const g = typeof globalThis === 'undefined' ? null : globalThis;
    return g && g.localStorage ? g.localStorage : null;
  } catch (err2) {
    return null; // access itself can throw in locked-down embeds
  }
}

function cleanText(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

/** A valid ISO timestamp string, or null. */
function isoOrNull(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? v.trim() : null;
}

/** Normalise one log entry; null when it cannot be read as one. */
function normalizeEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const at = isoOrNull(raw.at);
  if (!at) return null;
  const kindText = cleanText(raw.kind, 40);
  const kind = kindText ? kindText.toLowerCase() : 'settings';
  // Change lines are human sentences: strings only, never a coerced number.
  const changes = Array.isArray(raw.changes)
    ? raw.changes.map((c) => (typeof c === 'string' ? cleanText(c, 400) : null))
      .filter(Boolean).slice(0, MAX_CHANGE_LINES)
    : [];
  const out = {
    kind,
    at,
    league_id: cleanText(raw.league_id, 80),
    league_name: cleanText(raw.league_name, 120),
    changes,
  };
  if (isPlainObject(raw.details)) {
    // Details must survive JSON.stringify; anything that cannot is dropped
    // rather than allowed to poison the whole log on the next read.
    try { out.details = JSON.parse(JSON.stringify(raw.details)); } catch (err2) { /* dropped */ }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * The log — persisted, newest first, capped
 * ------------------------------------------------------------------------ */

/**
 * The stored log, newest first. Corrupt JSON, a non-array, unreadable
 * entries, a throwing storage, or no storage at all read as []. NEVER throws.
 */
export function loadSyncLog(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  let raw = null;
  try {
    raw = JSON.parse((store && store.getItem(SYNC_LOG_KEY)) || 'null');
  } catch (err2) {
    raw = null;
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeEntry).filter(Boolean).slice(0, SYNC_LOG_CAP);
}

/**
 * Prepend one sync record. `entry.at` defaults to now (the ONE place this
 * module reads the clock, and only when the caller passed no timestamp).
 * Keeps the newest SYNC_LOG_CAP entries, newest first. Returns the list as
 * stored — or as it WOULD have been stored when storage is blocked, so the
 * caller can still paint it this session. NEVER throws.
 */
export function recordSync(entry, storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  const prior = loadSyncLog(store);
  // A non-object is not a sync: record nothing rather than invent an entry.
  if (!isPlainObject(entry)) return prior;
  const src = { ...entry };
  if (!isoOrNull(src.at)) src.at = new Date().toISOString();
  const next = normalizeEntry(src);
  const list = next ? [next, ...prior].slice(0, SYNC_LOG_CAP) : prior;
  try {
    store.setItem(SYNC_LOG_KEY, JSON.stringify(list));
  } catch (err2) {
    // Storage blocked/absent: the caller still gets the in-memory list.
  }
  return list;
}

/** Forget the log. Never throws. */
export function clearSyncLog(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  try {
    store.removeItem(SYNC_LOG_KEY);
    return true;
  } catch (err2) {
    return false;
  }
}

/* --------------------------------------------------------------------------
 * Labels — readable names for Sleeper scoring keys
 * ------------------------------------------------------------------------ */

/** Sleeper scoring keys beyond app/league.js SCORING_FIELDS, plus the D/ST
 * keys re-labelled with their unit so the LEAGUE tab reads as a settings
 * page ("D/ST: 0 points allowed") rather than a stat sheet ("Shutout").
 * Unknown keys fall back to SCORING_FIELDS' label, then to the raw key. */
const SCORING_LABELS = Object.freeze({
  // passing
  pass_yd: 'Passing yard',
  pass_td: 'Passing TD',
  pass_int: 'Interception thrown',
  pass_2pt: 'Passing 2-pt',
  pass_cmp: 'Completion',
  pass_inc: 'Incompletion',
  pass_att: 'Pass attempt',
  pass_sack: 'Sacked',
  pass_cmp_40p: '40+ yard completion',
  pass_td_40p: '40+ yard passing TD',
  pass_td_50p: '50+ yard passing TD',
  pass_int_td: 'Pick-six thrown',
  bonus_pass_yd_300: '300-yard passing game bonus',
  bonus_pass_yd_400: '400-yard passing game bonus',
  bonus_pass_cmp_25: '25-completion game bonus',
  // rushing
  rush_yd: 'Rushing yard',
  rush_td: 'Rushing TD',
  rush_2pt: 'Rushing 2-pt',
  rush_att: 'Rush attempt',
  rush_fd: 'Rushing first down',
  rush_40p: '40+ yard rush',
  rush_td_40p: '40+ yard rushing TD',
  rush_td_50p: '50+ yard rushing TD',
  bonus_rush_yd_100: '100-yard rushing game bonus',
  bonus_rush_yd_200: '200-yard rushing game bonus',
  bonus_rush_att_20: '20-carry game bonus',
  // receiving
  rec: 'Reception',
  rec_yd: 'Receiving yard',
  rec_td: 'Receiving TD',
  rec_2pt: 'Receiving 2-pt',
  rec_fd: 'Receiving first down',
  rec_40p: '40+ yard reception',
  rec_td_40p: '40+ yard receiving TD',
  rec_td_50p: '50+ yard receiving TD',
  rec_0_4: 'Reception, 0-4 yards',
  rec_5_9: 'Reception, 5-9 yards',
  rec_10_19: 'Reception, 10-19 yards',
  rec_20_29: 'Reception, 20-29 yards',
  rec_30_39: 'Reception, 30-39 yards',
  bonus_rec_te: 'TE reception bonus',
  bonus_rec_rb: 'RB reception bonus',
  bonus_rec_wr: 'WR reception bonus',
  bonus_rec_yd_100: '100-yard receiving game bonus',
  bonus_rec_yd_200: '200-yard receiving game bonus',
  bonus_rush_rec_yd_100: '100 rush+rec yard game bonus',
  bonus_rush_rec_yd_200: '200 rush+rec yard game bonus',
  // misc offence
  fum: 'Fumble',
  fum_lost: 'Fumble lost',
  fum_rec_td: 'Fumble recovery TD',
  fum_ret_yd: 'Fumble return yard',
  // kicking
  xpm: 'Extra point made',
  xpmiss: 'Extra point missed',
  fgm: 'FG made',
  fgm_yds: 'FG made, per yard',
  fgm_yds_over_30: 'FG made, per yard over 30',
  fgm_0_19: 'FG made 0-19',
  fgm_20_29: 'FG made 20-29',
  fgm_30_39: 'FG made 30-39',
  fgm_40_49: 'FG made 40-49',
  fgm_50_59: 'FG made 50-59',
  fgm_60p: 'FG made 60+',
  fgm_50p: 'FG made 50+',
  fgmiss: 'FG missed',
  fgmiss_0_19: 'FG missed 0-19',
  fgmiss_20_29: 'FG missed 20-29',
  fgmiss_30_39: 'FG missed 30-39',
  fgmiss_40_49: 'FG missed 40-49',
  fgmiss_50p: 'FG missed 50+',
  // D/ST
  def_td: 'D/ST: defensive TD',
  def_st_td: 'D/ST: special-teams TD',
  st_td: 'Special-teams TD (player)',
  def_st_fum_rec: 'D/ST: special-teams fumble recovery',
  st_fum_rec: 'Special-teams fumble recovery (player)',
  def_st_ff: 'D/ST: special-teams forced fumble',
  st_ff: 'Special-teams forced fumble (player)',
  def_kr_yd: 'D/ST: kick return yard',
  def_pr_yd: 'D/ST: punt return yard',
  def_2pt: 'D/ST: 2-pt return',
  sack: 'D/ST: sack',
  sack_yd: 'D/ST: sack yard',
  qb_hit: 'D/ST: QB hit',
  int: 'D/ST: interception',
  int_ret_yd: 'D/ST: interception return yard',
  fum_rec: 'D/ST: fumble recovered',
  ff: 'D/ST: forced fumble',
  safe: 'D/ST: safety',
  blk_kick: 'D/ST: blocked kick',
  blk_kick_ret_yd: 'D/ST: blocked kick return yard',
  tkl_loss: 'D/ST: tackle for loss',
  tkl: 'D/ST: tackle',
  tkl_solo: 'D/ST: solo tackle',
  tkl_ast: 'D/ST: assisted tackle',
  def_pass_def: 'D/ST: pass defended',
  def_forced_punts: 'D/ST: forced punt',
  def_3_and_out: 'D/ST: three-and-out forced',
  def_4_and_stop: 'D/ST: fourth-down stop',
  pts_allow: 'D/ST: per point allowed',
  pts_allow_0: 'D/ST: 0 points allowed',
  pts_allow_1_6: 'D/ST: 1-6 points allowed',
  pts_allow_7_13: 'D/ST: 7-13 points allowed',
  pts_allow_14_20: 'D/ST: 14-20 points allowed',
  pts_allow_21_27: 'D/ST: 21-27 points allowed',
  pts_allow_28_34: 'D/ST: 28-34 points allowed',
  pts_allow_35p: 'D/ST: 35+ points allowed',
  yds_allow: 'D/ST: per yard allowed',
  yds_allow_0_100: 'D/ST: 0-100 yards allowed',
  yds_allow_100_199: 'D/ST: 100-199 yards allowed',
  yds_allow_200_299: 'D/ST: 200-299 yards allowed',
  yds_allow_300_349: 'D/ST: 300-349 yards allowed',
  yds_allow_350_399: 'D/ST: 350-399 yards allowed',
  yds_allow_400_449: 'D/ST: 400-449 yards allowed',
  yds_allow_450_499: 'D/ST: 450-499 yards allowed',
  yds_allow_500_549: 'D/ST: 500-549 yards allowed',
  yds_allow_550p: 'D/ST: 550+ yards allowed',
  // returns (player)
  kr_yd: 'Kick return yard',
  pr_yd: 'Punt return yard',
  kr_td: 'Kick return TD',
  pr_td: 'Punt return TD',
});

const FIELD_LABELS = new Map(SCORING_FIELDS.map((f) => [f.key, f.label]));

/** Readable label for a scoring key; the raw key when nothing is known. */
export function scoringLabel(key) {
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(SCORING_LABELS, k)) return SCORING_LABELS[k];
  if (FIELD_LABELS.has(k)) return FIELD_LABELS.get(k);
  return k;
}

/* --------------------------------------------------------------------------
 * Diffs — what the applied league changes versus the app default
 * ------------------------------------------------------------------------ */

/**
 * Every scoring key where the league's points differ from the baseline
 * (standard PPR unless a baseline map is given):
 *   - a key both carry at different values (pass_int -2 vs -1);
 *   - a key only the league carries (bonus_rec_te 0.5; standard: null);
 *   - a key only the baseline carries (league: null — NOT in the table).
 * A key one side lacks and the other prices at 0 is NOT a difference: neither
 * side awards anything for it. Sorted by |delta| desc, then key A-Z.
 * Returns [] for a default profile.
 */
export function scoringDiff(profile, baseline) {
  const p = normalizeProfile(profile);
  const league = p && p.scoring ? p.scoring : {};
  const base = isPlainObject(baseline) ? baseline : DEFAULT_SCORING;
  const keys = new Set([...Object.keys(league), ...Object.keys(base)]);
  const rows = [];
  keys.forEach((key) => {
    const lv = Object.prototype.hasOwnProperty.call(league, key) ? toFinite(league[key]) : null;
    const sv = Object.prototype.hasOwnProperty.call(base, key) ? toFinite(base[key]) : null;
    const lEff = lv === null ? 0 : lv;
    const sEff = sv === null ? 0 : sv;
    if (lEff === sEff) return;
    rows.push({
      key,
      league: lv,
      standard: sv,
      delta: Math.round((lEff - sEff) * 1e6) / 1e6,
      label: scoringLabel(key),
    });
  });
  rows.sort((a, b) => {
    const d = Math.abs(b.delta) - Math.abs(a.delta);
    return d !== 0 ? d : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
  return rows;
}

/** Starter tokens in display order; anything else follows A-Z. */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRRB_FLEX',
  'RB_TE_FLEX', 'K', 'DEF', 'DST'];

function starterCounts(positions) {
  const counts = {};
  positions.forEach((t) => {
    const tok = String(t).toUpperCase();
    if (tok === 'BN') return;
    counts[tok] = (counts[tok] || 0) + 1;
  });
  return counts;
}

function shapeSummary(shape) {
  const positions = [...(shape.roster_positions || [])];
  return {
    starters: shape.starters,
    bench: shape.bench,
    teams: shape.teams,
    roster_positions: positions,
  };
}

const seats = (n) => (n === 1 ? 'one' : String(n));

/**
 * The league's roster shape beside the default's, with one line per
 * difference ("2 FLEX vs 1", "no K slot (standard seats one)", "5 bench vs
 * 6", "10 teams vs 12"). `lines` is [] when the shapes match.
 */
export function shapeDiff(profile) {
  const league = shapeSummary(normalizeProfile(profile).shape);
  const standard = shapeSummary(DEFAULT_PROFILE.shape);
  const lines = [];
  if (league.teams !== standard.teams) lines.push(`${league.teams} teams vs ${standard.teams}`);
  if (league.starters !== standard.starters) {
    lines.push(`${league.starters} starters vs ${standard.starters}`);
  }
  const lc = starterCounts(league.roster_positions);
  const sc = starterCounts(standard.roster_positions);
  const tokens = [...new Set([...Object.keys(lc), ...Object.keys(sc)])].sort((a, b) => {
    const ia = SLOT_ORDER.indexOf(a);
    const ib = SLOT_ORDER.indexOf(b);
    const ra = ia === -1 ? Infinity : ia;
    const rb = ib === -1 ? Infinity : ib;
    return ra !== rb ? ra - rb : (a < b ? -1 : a > b ? 1 : 0);
  });
  tokens.forEach((tok) => {
    const l = lc[tok] || 0;
    const s = sc[tok] || 0;
    if (l === s) return;
    if (l === 0) lines.push(`no ${tok} slot (standard seats ${seats(s)})`);
    else if (s === 0) lines.push(`${l} ${tok} slot${l === 1 ? '' : 's'} (standard seats none)`);
    else lines.push(`${l} ${tok} vs ${s}`);
  });
  if (league.bench !== standard.bench) lines.push(`${league.bench} bench vs ${standard.bench}`);
  return { league, standard, lines };
}
