/* app/league-rosters.js — R49: the league's rosters and the NFL week, remembered.
 *
 * Two small storage records, both written by TEAM's Sleeper roster sync and
 * read by LINEUP's WAIVER WIRE card. Pure: no DOM, no fetch, storage injected
 * exactly like app/league.js, and every reader is total (corrupt JSON, a
 * hostile shape, a blocked storage, a record for a DIFFERENT league — each
 * reads as null, never as a fabricated empty league where everyone is free).
 *
 *   nfl2026.leaguerosters.v1 = {
 *     version: 1, league_id, at (ISO),
 *     teams: [{ roster_id, label, app_ids: [...] }],   // every roster, in this app's ids
 *     rostered_app_ids: [...],                          // the union, for fast exclusion
 *     my_roster_id: number | null,                      // set after a seat; null until
 *   }
 *   nfl2026.nflweek.v1 = { week, season_type, season, at }   // Sleeper /v1/state/nfl
 *
 * WHY A SEPARATE RECORD, not the roster in nfl2026.team.v1: that key is MY
 * team. The waiver wire needs everyone ELSE's, and "who is unrostered" can
 * only be answered honestly against the whole league at the moment it was
 * read — so the record carries the league id and a timestamp, and a reader
 * for another league gets null and says so.
 */

export const LEAGUE_ROSTERS_KEY = 'nfl2026.leaguerosters.v1';
const LEAGUE_ROSTERS_VERSION = 1;
export const NFL_WEEK_KEY = 'nfl2026.nflweek.v1';

function defaultStorage() {
  try {
    const g = typeof globalThis === 'undefined' ? null : globalThis;
    return g && g.localStorage ? g.localStorage : null;
  } catch (err) {
    return null; // access itself can throw in locked-down embeds
  }
}
const storeOf = (storage) => (storage === undefined ? defaultStorage() : storage);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idText = (v) => (v == null ? '' : String(v).trim());

function readJson(store, key) {
  try {
    const raw = store && store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Coerce a roster record into the stored shape, or null when it cannot be one
 * (no league id, or no teams array). Ids are stringified and de-duplicated;
 * `rostered_app_ids` is always recomputed from the teams so the union can
 * never disagree with the rosters it summarises.
 */
export function normalizeLeagueRosters(raw) {
  if (!isObj(raw)) return null;
  const leagueId = idText(raw.league_id);
  if (!leagueId || !Array.isArray(raw.teams)) return null;
  const union = new Set();
  const teams = raw.teams.filter(isObj).map((t) => {
    const seen = new Set();
    const appIds = (Array.isArray(t.app_ids) ? t.app_ids : [])
      .map(idText).filter((id) => id && !seen.has(id) && seen.add(id));
    appIds.forEach((id) => union.add(id));
    // R98 — a player in a Sleeper IR (reserve) slot is rostered, not a pickup.
    // Kept apart from app_ids, which is the seatable roster TEAM seats, so the
    // "your roster differs from Sleeper" check never flags an IR stash.
    const reserve = (Array.isArray(t.reserve_app_ids) ? t.reserve_app_ids : [])
      .map(idText).filter((id) => id && !seen.has(id) && seen.add(id));
    reserve.forEach((id) => union.add(id));
    const rid = Number(t.roster_id);
    return {
      roster_id: Number.isFinite(rid) ? rid : null,
      label: typeof t.label === 'string' ? t.label : null,
      app_ids: appIds,
      ...(reserve.length ? { reserve_app_ids: reserve } : {}),
    };
  });
  const my = Number(raw.my_roster_id);
  return {
    version: LEAGUE_ROSTERS_VERSION,
    league_id: leagueId,
    // R98 — a READ keeps what was written: a record with no timestamp is of
    // unknown age, and stamping it with the clock here made every such record
    // read as brand new. Only a WRITE stamps the time (saveLeagueRosters).
    at: typeof raw.at === 'string' && raw.at ? raw.at : null,
    teams,
    rostered_app_ids: [...union],
    my_roster_id: raw.my_roster_id == null || !Number.isFinite(my) ? null : my,
  };
}

/** Persist a roster record (normalised first). False when storage is blocked. */
export function saveLeagueRosters(record, storage) {
  const store = storeOf(storage);
  const rec = normalizeLeagueRosters(record);
  if (!store || !rec) return false;
  if (!rec.at) rec.at = new Date().toISOString();
  try {
    store.setItem(LEAGUE_ROSTERS_KEY, JSON.stringify(rec));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * The stored record for `leagueId`, or null when absent, corrupt, or saved
 * for a DIFFERENT league. Pass null/undefined as the id to read whatever is
 * stored regardless of league (the view uses that to say "these rosters are
 * for another league" instead of a bare "sync first").
 */
export function loadLeagueRosters(leagueId, storage) {
  const rec = normalizeLeagueRosters(readJson(storeOf(storage), LEAGUE_ROSTERS_KEY));
  if (!rec) return null;
  const want = idText(leagueId);
  if (want && rec.league_id !== want) return null;
  return rec;
}

/**
 * R98 — how old the saved rosters are, in hours, or null when the record carries
 * no readable timestamp. The waiver wire is "this app's pool minus every roster
 * AS READ AT THAT MOMENT", and the read only happens on TEAM's SYNC NOW (it needs
 * Sleeper's multi-megabyte player list to translate ids, which is too heavy to
 * pull on every LINEUP mount). Every add and drop since then is invisible, so a
 * player another manager picked up keeps showing as available. This number is
 * what lets LINEUP say so out loud instead of in a footnote.
 */
export const ROSTERS_STALE_HOURS = 24;
export function rosterAgeHours(rec, now = Date.now()) {
  const t = rec && typeof rec.at === 'string' && rec.at ? Date.parse(rec.at) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Number(now) - t) / 3600000);
}

/**
 * R98 — AUTOMATIC RE-READ POLICY (owner, 2026-09-24: "re-synced automatically 4
 * times per day"). Lives here, not in app/league-sync.js, so LINEUP can decide
 * whether a re-read is due WITHOUT loading app/sleeper.js; the sync module is
 * imported only when this says yes.
 */
export const AUTO_SYNC_EVERY_HOURS = 6;      // four times a day
export const AUTO_SYNC_RETRY_MINUTES = 30;   // after a failed attempt
export const LAST_ATTEMPT_KEY = 'nfl2026.leaguesync.attempt.v1';

export function readSyncAttempt(storage) {
  const rec = readJson(storeOf(storage), LAST_ATTEMPT_KEY);
  return isObj(rec) ? rec : null;
}

export function writeSyncAttempt(rec, storage) {
  try {
    const store = storeOf(storage);
    if (store) store.setItem(LAST_ATTEMPT_KEY, JSON.stringify(rec));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Is a re-read due? True when the saved rosters for this league are missing, of
 * unknown age, or older than AUTO_SYNC_EVERY_HOURS — unless an attempt for this
 * league started less than AUTO_SYNC_RETRY_MINUTES ago (a Sleeper outage is not
 * hammered on every mount).
 */
export function autoSyncDue(rec, attempt, leagueId, now = Date.now()) {
  const id = idText(leagueId);
  if (!id) return false;
  const age = rosterAgeHours(rec, now);
  if (age != null && age < AUTO_SYNC_EVERY_HOURS) return false;
  const t = attempt && attempt.league_id === id && typeof attempt.at === 'string'
    ? Date.parse(attempt.at) : NaN;
  if (Number.isFinite(t) && Number(now) - t < AUTO_SYNC_RETRY_MINUTES * 60000) return false;
  return true;
}

/**
 * R98 — how the roster seated on this device differs from Sleeper's: `added` =
 * on Sleeper, not here; `dropped` = here, no longer on Sleeper.
 */
export function rosterChange(hereIds, sleeperIds) {
  const here = new Set((hereIds || []).map(String));
  const there = new Set((sleeperIds || []).map(String));
  return {
    added: [...there].filter((id) => !here.has(id)),
    dropped: [...here].filter((id) => !there.has(id)),
  };
}

/**
 * Mark which of the saved rosters is mine. A no-op (false) when nothing is
 * saved or the saved record is for another league — a seat in league A must
 * never relabel league B's record.
 */
export function setMyRosterId(leagueId, rosterId, storage) {
  const store = storeOf(storage);
  const rec = loadLeagueRosters(leagueId, store);
  if (!rec) return false;
  const rid = Number(rosterId);
  rec.my_roster_id = rosterId == null || !Number.isFinite(rid) ? null : rid;
  // Written directly, not through saveLeagueRosters: marking a seat does not
  // re-read the league, so it must not refresh the rosters' age (R98).
  try {
    store.setItem(LEAGUE_ROSTERS_KEY, JSON.stringify(rec));
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * The ids in `poolIds` that no roster in the saved league holds. Returns NULL
 * (not []) when no record exists for `leagueId`: "nobody is rostered" is a
 * claim, and without the rosters it cannot be made.
 */
export function freeAgentIds(poolIds, leagueId, storage) {
  const rec = loadLeagueRosters(leagueId, storage);
  if (!rec) return null;
  const taken = new Set(rec.rostered_app_ids);
  return (Array.isArray(poolIds) ? poolIds : []).map(idText).filter((id) => id && !taken.has(id));
}

/**
 * Sleeper's current NFL week (/v1/state/nfl), as this app keeps it. Only the
 * three fields LINEUP needs are kept; `week` must be a finite number or the
 * write is refused (an absent week is never stored as 0).
 */
export function saveNflWeek(state, storage) {
  const store = storeOf(storage);
  if (!store || !isObj(state)) return false;
  const week = Number(state.week);
  if (!Number.isFinite(week)) return false;
  const rec = {
    week,
    season_type: state.season_type == null ? null : String(state.season_type),
    season: state.season == null ? null : String(state.season),
    at: new Date().toISOString(),
  };
  try {
    store.setItem(NFL_WEEK_KEY, JSON.stringify(rec));
    return true;
  } catch (err) {
    return false;
  }
}

/** { week, season_type, season, at } or null. Never a made-up week. */
export function loadNflWeek(storage) {
  const raw = readJson(storeOf(storage), NFL_WEEK_KEY);
  if (!isObj(raw)) return null;
  const week = Number(raw.week);
  if (!Number.isFinite(week)) return null;
  return {
    week,
    season_type: raw.season_type == null ? null : String(raw.season_type),
    season: raw.season == null ? null : String(raw.season),
    at: typeof raw.at === 'string' ? raw.at : null,
  };
}

/**
 * The week LINEUP should open on: Sleeper's current week when the record says
 * the REGULAR season is in progress and the week is one the selector offers
 * (1..maxWeek); otherwise null and the caller keeps its own default.
 */
export function defaultLineupWeek(rec, maxWeek = 18) {
  if (!isObj(rec)) return null;
  const week = Number(rec.week);
  if (rec.season_type !== 'regular' || !Number.isInteger(week)) return null;
  if (week < 1 || week > maxWeek) return null;
  return week;
}
