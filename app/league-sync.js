/* app/league-sync.js — R98: the league's rosters re-read automatically, four
 * times a day.
 *
 * Owner's rule (2026-09-24): "In Sleeper, teams and waivers are updated multiple
 * times a day, they should be re-synced automatically 4 times per day." Until
 * now the rosters behind LINEUP's waiver wire were read only when TEAM's SYNC
 * NOW was pressed, so every add, drop and claim since then was invisible and a
 * player another manager had picked up kept showing as available.
 *
 * WHAT RUNS, AND WHEN. An iPhone web app cannot run in the background, so "four
 * times a day" means: whenever LINEUP is opened and the saved rosters are more
 * than AUTO_SYNC_EVERY_HOURS (6) old, they are re-read — the view imports this
 * module only then, so a fresh mount costs nothing. A failed attempt waits
 * AUTO_SYNC_RETRY_MINUTES before the next, so a Sleeper outage is not hammered
 * (policy and constants: app/league-rosters.js).
 *
 * WHAT IT COSTS. Two small GETs to Sleeper (rosters, users) plus this app's own
 * data/sleeper_index.json (~148 KB, ~25 KB over the wire), which the daily
 * runner cuts from Sleeper's 14.7 MB player dump, read through app/data.js. TEAM's manual sync still reads
 * the full dump; the compact index resolves exactly the same rostered players
 * (127 of 127 on the P.T.I. league, measured 2026-09-24) because a player on no
 * NFL team is not in this app's pool either.
 *
 * WHAT IT WRITES. Only the league-rosters record (who is rostered anywhere),
 * through the same saveLeagueRosters TEAM uses. It NEVER seats, moves or drops a
 * player on the viewer's own roster: that keeps TEAM's rule that a roster is
 * never replaced without the losses being named first. If the viewer's Sleeper
 * roster differs from the one seated here, LINEUP names exactly who was added and
 * dropped (app/league-rosters.js rosterChange) and links to TEAM to seat it.
 */

import { importSleeperTeams, buildSleeperPlayerIndex, crosswalkRoster } from './sleeper.js';
import { getSleeperIndex } from './data.js';
import {
  loadLeagueRosters, saveLeagueRosters, autoSyncDue, readSyncAttempt, writeSyncAttempt,
} from './league-rosters.js';

/** The resolved app ids of one crosswalk part, de-duplicated against `seen`. */
function idsOf(crosswalk, part, seen) {
  const list = crosswalk && crosswalk[part] && Array.isArray(crosswalk[part].resolved)
    ? crosswalk[part].resolved : [];
  const out = [];
  for (const r of list) {
    const id = r && r.player_id != null ? String(r.player_id) : '';
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/**
 * One roster as the league record stores it. `app_ids` is exactly what TEAM's
 * orderedRosterPlayers yields (Sleeper starters first, then the rest), so a
 * roster saved here and one saved by SYNC NOW agree; `reserve_app_ids` are the
 * IR-slot players, rostered (never offered as pickups) but not seatable.
 */
export function rosterAppIds(crosswalk) {
  const seen = new Set();
  const appIds = [...idsOf(crosswalk, 'starters', seen), ...idsOf(crosswalk, 'players', seen)];
  return { app_ids: appIds, reserve_app_ids: idsOf(crosswalk, 'reserve', seen) };
}

/**
 * Re-read the league if due. Resolves to one of:
 *   { ran: false, reason }                         nothing was due
 *   { ran: true, ok: false, error }                attempted, nothing written
 *   { ran: true, ok: true, record }                rosters saved
 * Never throws.
 */
export async function autoSyncLeague({
  leagueId, seatable, fetch: fetchImpl, loadIndex = getSleeperIndex, now = Date.now(), storage,
  force = false,
} = {}) {
  const store = storage;
  const id = leagueId == null ? '' : String(leagueId).trim();
  if (!id) return { ran: false, reason: 'no league applied' };
  const prev = loadLeagueRosters(id, store);
  if (!force && !autoSyncDue(prev, readSyncAttempt(store), id, now)) {
    return { ran: false, reason: 'rosters are fresh' };
  }
  writeSyncAttempt({ league_id: id, at: new Date(now).toISOString() }, store);
  try {
    // The compact index is a data/ contract, so it is read through app/data.js
    // like every other one (the data-contract test binds this); only Sleeper's
    // own API goes through app/sleeper.js.
    let doc;
    try {
      doc = await loadIndex({ force: true });
    } catch (err) {
      return { ran: true, ok: false, error: `The compact Sleeper player index is not available (${(err && err.message) || err}).` };
    }
    const built = buildSleeperPlayerIndex(doc && doc.players);
    if (!built.ok) return { ran: true, ok: false, error: 'The compact Sleeper player index could not be read.' };
    const teamsRes = await importSleeperTeams(id, {
      ...(typeof fetchImpl === 'function' ? { fetch: fetchImpl } : {}), timeoutMs: 8000,
    });
    if (!teamsRes.ok) {
      return { ran: true, ok: false, error: (teamsRes.error && teamsRes.error.message) || 'Sleeper did not return the rosters.' };
    }
    const teams = teamsRes.teams.map((t) => ({
      roster_id: t.roster_id,
      label: t.label,
      ...rosterAppIds(crosswalkRoster(t, seatable, { index: built.index })),
    }));
    const myId = prev && prev.my_roster_id != null ? prev.my_roster_id : null;
    const record = {
      league_id: id,
      at: new Date(now).toISOString(),
      teams,
      my_roster_id: myId,
    };
    if (!saveLeagueRosters(record, store)) {
      return { ran: true, ok: false, error: 'This device would not store the rosters.' };
    }
    return { ran: true, ok: true, record: loadLeagueRosters(id, store) };
  } catch (err) {
    return { ran: true, ok: false, error: (err && err.message) || String(err) };
  }
}
