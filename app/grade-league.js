/* app/grade-league.js — Sleeper league → GRADE engine inputs. Pure module:
 * no DOM, no fetch, no clock. The view fetches (via app/sleeper.js and the
 * player dump) and hands the payloads here; this module turns them into the
 * shapes app/grade.js simulates — and REPORTS everything it cannot use.
 *
 * Honesty surface:
 *   - a pre-draft league is a stated state, not an error to hide: Sleeper
 *     publishes rosters and the weekly schedule only after the draft;
 *   - a week Sleeper returns [] for is UNSCHEDULED — the sim falls back to
 *     random pairing for that week and the page must say so;
 *   - a game is FINAL only when the league's own `last_scored_leg` says its
 *     week has been scored — points on an unscored week never lock a result;
 *   - matchup pairs that are not clean head-to-heads (byes, 3-team payloads)
 *     are listed in `problems`, never truncated into a fake game.
 */

import { matchupPairs } from './sleeper.js';

/** Read the sim-relevant league facts from the raw /league payload. */
export function leagueMeta(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'That is not a Sleeper league object.' };
  }
  const s = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
  // null/undefined stay null — Number(null) is 0, and "week 0 has been
  // scored" is a different claim from "nothing has been scored yet".
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const playoffWeekStart = num(s.playoff_week_start);
  return {
    ok: true,
    error: null,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'League',
    status: payload.status == null ? null : String(payload.status),
    season: payload.season == null ? null : String(payload.season),
    totalRosters: num(payload.total_rosters),
    // Regular season = weeks 1 .. playoff_week_start-1. A missing/auto value
    // falls back to the common 14 (weeks 1-13) and the view says "assumed".
    playoffWeekStart: playoffWeekStart && playoffWeekStart >= 2 ? playoffWeekStart : null,
    playoffTeams: num(s.playoff_teams),
    // Sleeper's own "how far has scoring got" cursor. null before week 1.
    lastScoredLeg: num(s.last_scored_leg),
    preDraft: String(payload.status) === 'pre_draft' || String(payload.status) === 'drafting',
  };
}

/**
 * Mapped matchup weeks -> the engine's week list.
 *
 * `matchupWeeks`: [{week, matchups}] with `matchups` from mapMatchups(). An
 * entry whose matchups are empty is an UNSCHEDULED week. `rosterIds` is the
 * team order the sim uses (index = team index).
 * Returns { weeks, unscheduledWeeks, problems }.
 */
export function buildWeeks(matchupWeeks, rosterIds, lastScoredLeg) {
  const idx = new Map((Array.isArray(rosterIds) ? rosterIds : [])
    .map((id, i) => [Number(id), i]));
  const weeks = [];
  const unscheduledWeeks = [];
  const problems = [];
  const scored = Number.isFinite(Number(lastScoredLeg)) ? Number(lastScoredLeg) : 0;

  (Array.isArray(matchupWeeks) ? matchupWeeks : []).forEach((entry) => {
    const week = Number(entry.week);
    const rows = Array.isArray(entry.matchups) ? entry.matchups : [];
    if (rows.length === 0) {
      weeks.push({ week, games: [], unscheduled: true });
      unscheduledWeeks.push(week);
      return;
    }
    const games = [];
    matchupPairs(rows).forEach((pair) => {
      if (pair.kind !== 'head_to_head') {
        problems.push(`Week ${week}: matchup ${pair.matchup_id == null ? '(none)' : pair.matchup_id} `
          + `is ${pair.kind} (${pair.roster_ids.length} team(s)) — not simulated as a game.`);
        return;
      }
      const a = idx.get(Number(pair.roster_ids[0]));
      const b = idx.get(Number(pair.roster_ids[1]));
      if (a === undefined || b === undefined) {
        problems.push(`Week ${week}: rosters ${pair.roster_ids.join(' vs ')} are not in the `
          + 'league team list — game skipped.');
        return;
      }
      const final = week <= scored;
      const aPts = pair.points[0];
      const bPts = pair.points[1];
      if (final && (aPts == null || bPts == null)) {
        // The league says this week is scored but the points are missing —
        // refuse to lock a result we do not have.
        problems.push(`Week ${week}: scored per the league but points are missing for `
          + `rosters ${pair.roster_ids.join(' vs ')} — simulated instead of locked.`);
        games.push({ a, b, aPts: null, bPts: null, final: false });
        return;
      }
      games.push({ a, b, aPts: final ? aPts : null, bPts: final ? bPts : null, final });
    });
    weeks.push({ week, games, unscheduled: false });
  });

  return { weeks, unscheduledWeeks, problems };
}

/**
 * Crosswalked roster rows -> the pool records gradeTeam() grades.
 * `resolvedRows`: crosswalkPlayerIds().resolved (player_id = our pool id);
 * `poolById`: Map<gsis_id, pool record>. A resolved id missing from the pool
 * map is reported, never silently dropped.
 */
export function poolPlayersFor(resolvedRows, poolById) {
  const players = [];
  const missing = [];
  const seen = new Set();
  (Array.isArray(resolvedRows) ? resolvedRows : []).forEach((r) => {
    const id = String(r.player_id);
    if (seen.has(id)) return;
    seen.add(id);
    const rec = poolById.get(id);
    if (rec) players.push(rec);
    else missing.push(r.name || id);
  });
  return { players, missing };
}
