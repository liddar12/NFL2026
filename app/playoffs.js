/* app/playoffs.js — FANTASY-PLAYOFF STRENGTH OF SCHEDULE (pure, DOM-free).
 *
 * A LENS over data already on disk: data/player_weekly.json (per-player 18-week
 * opponent/bye split) x data/team_strength.json (per-team Elo). It adds NO feed,
 * NO scraper and NO signal — nothing here feeds a projection, a weight or a
 * parlay probability, so it needs no promotion-gate family. It restates schedule
 * data the app already ships, scoped to the weeks that decide a fantasy season.
 *
 * WHY IT EXISTS: season-long SoS (app/team-logic.js strengthOfSchedule) averages
 * all 18 weeks, which washes out exactly the weeks an owner cannot lose. Measured
 * over the 300 committed player_weekly rows, opponent Elo faced in weeks 14-17
 * minus each player's OWN season average is mean +1.51, sd 27.25, 10th percentile
 * -27.19, 90th percentile +26.47, full spread 152.5 Elo (min -91.8, max +60.8).
 * At the app's fixed 25-Elo-per-point sensitivity a decile-hard playoff slate
 * costs ~1.1 points a game (26.47/25) and a decile-easy one gains ~1.1 — a
 * ~2.1-point decile-to-decile swing in the only weeks that pay.
 * tests/feature/playoff_sos.test.mjs reproduces those numbers from the committed
 * files rather than trusting this comment.
 *
 * HONESTY CONTRACT:
 *   - The window START comes from the LeagueProfile (shape.playoff_week_start)
 *     via app/league.js. Weeks 14-17 are NOT hardcoded; the default profile
 *     starts at 15 and a Sleeper import can set anything in [1,18].
 *   - Missing team_strength, missing weekly rows, or a player with no rated game
 *     inside the window returns NULL. Never 0 dressed up as neutral, never a
 *     league-average stand-in.
 *   - A BYE inside the window is counted and reported separately from games
 *     (report.byes vs report.games). A three-game playoff window with a bye in
 *     it is a different fact from a four-game window of hard opponents, and a
 *     caller can tell them apart without re-deriving anything.
 *   - pts_per_game is a transparent RESTATEMENT of elo_diff at the same fixed
 *     sensitivity the app already uses for SoS (25 Elo = 1 point). It is a
 *     display conversion. It is not applied to any projection anywhere.
 *
 * SHAPES:
 *   window  { start:int, end:int, weeks:int }
 *   report  see playoffSos() below, or null
 */

import { normalizeProfile } from './league.js';

/* --------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * Last week of the FANTASY regular season. NFL week 18 is not a fantasy week on
 * any mainstream host (resting starters), so a playoff window ends at 17.
 *
 * This is an ASSUMPTION, not a league setting: the LeagueProfile carries
 * playoff_week_start but no playoff-round count, so the end cannot be derived
 * from the profile today. It is exported and overridable (opts.endWeek) so a
 * caller with better information is never blocked, and when the profile gains a
 * rounds field the end should come from there instead of from this constant.
 */
export const FANTASY_SEASON_END_WEEK = 17;

/**
 * Elo per fantasy point. Mirrors SOS_ELO_PER_POINT in app/team-logic.js — the
 * value is duplicated rather than imported to keep this module's dependency
 * surface to app/league.js alone; the unit test imports BOTH and asserts they
 * are equal, so the two can never drift apart silently.
 */
export const PLAYOFF_ELO_PER_POINT = 25;

/** The Elo scale's league mean — the anchor for the absolute rating. */
export const LEAGUE_MEAN_ELO = 1500;

/**
 * Rating band edges on the 1.0 (easiest) .. 5.0 (hardest) scale, in menu order.
 * Set at +/-0.5 and +/-1.25 standard deviations of the measured differential
 * (sd 27.25 Elo -> 13.6 and 34.1 Elo -> 0.55 and 1.36 rating steps, rounded to
 * the clean 12.5 / 31.25 Elo cuts the 25-Elo scale makes exact).
 */
export const RATING_BANDS = Object.freeze([
  Object.freeze({ label: 'Easiest', below: 1.75 }),
  Object.freeze({ label: 'Easy', below: 2.5 }),
  Object.freeze({ label: 'Neutral', below: 3.5 }),
  Object.freeze({ label: 'Hard', below: 4.25 }),
  Object.freeze({ label: 'Hardest', below: Infinity }),
]);

/* --------------------------------------------------------------------------
 * Small helpers (local — this module stays dependency-light on purpose)
 * ------------------------------------------------------------------------ */

function toFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round(n, places) {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return r === 0 ? 0 : r; // never emit -0: it survives JSON as 0 but breaks ===
}

/** player_weekly entry ({weeks:[...]}) or a bare weeks array -> array | null. */
function weeksOf(weeks) {
  if (Array.isArray(weeks)) return weeks;
  if (weeks && typeof weeks === 'object' && Array.isArray(weeks.weeks)) return weeks.weeks;
  return null;
}

/**
 * data/team_strength.json ({ratings:{TEAM:elo}}) or a bare {TEAM:elo} map ->
 * the ratings map, or null when there is nothing usable. An empty map is null:
 * "the file shipped but rates nobody" must degrade exactly like "no file".
 */
function ratingsOf(teamStrength) {
  if (!teamStrength || typeof teamStrength !== 'object' || Array.isArray(teamStrength)) {
    return null;
  }
  let map = teamStrength;
  if ('ratings' in teamStrength) {
    const r = teamStrength.ratings;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    map = r;
  }
  return Object.keys(map).length ? map : null;
}

/** Elo for an opponent code, or null. Uppercase first, then the raw key. */
function eloFor(ratings, opp) {
  if (!ratings || opp == null) return null;
  const key = String(opp).toUpperCase();
  const hit = ratings[key] != null ? ratings[key] : ratings[opp];
  return toFinite(hit);
}

/** 1.0 (easiest) .. 5.0 (hardest), one decimal, at the fixed Elo sensitivity. */
function toRating(eloAboveBaseline) {
  const raw = 3 + eloAboveBaseline / PLAYOFF_ELO_PER_POINT;
  return round(Math.max(1, Math.min(5, raw)), 1);
}

/* --------------------------------------------------------------------------
 * The window
 * ------------------------------------------------------------------------ */

/**
 * The fantasy-playoff week window for a league profile.
 *
 *   playoffWindow(profile)              -> { start, end, weeks }
 *   playoffWindow(profile, {endWeek})   -> caller-supplied end
 *
 * `profile` is a LeagueProfile (app/league.js). It is normalised here, so a raw
 * / partial / corrupt object is safe and `undefined` yields DEFAULT_PROFILE
 * (playoff_week_start 15 -> weeks 15-17). This module never touches storage:
 * a view calls loadProfile() itself and passes the result in.
 *
 * The end is FANTASY_SEASON_END_WEEK unless opts.endWeek overrides it, and is
 * never allowed below the start — a league whose playoffs start in week 18 gets
 * the one-week window [18,18], not a nonsense empty one.
 */
export function playoffWindow(profile, opts = {}) {
  const start = normalizeProfile(profile).shape.playoff_week_start;
  const asked = toFinite(opts && opts.endWeek);
  const end = Math.max(start, asked === null ? FANTASY_SEASON_END_WEEK : Math.round(asked));
  return { start, end, weeks: end - start + 1 };
}

/** True when NFL week `wk` falls inside a window from playoffWindow(). */
export function inPlayoffWindow(wk, window) {
  const n = toFinite(wk);
  if (n === null || !window) return false;
  return n >= window.start && n <= window.end;
}

/* --------------------------------------------------------------------------
 * The lens
 * ------------------------------------------------------------------------ */

/**
 * Playoff-window strength of schedule for ONE player, or NULL.
 *
 *   weeks        player_weekly players[] entry, or a bare weeks[] array
 *                ([{wk, opp, home, bye, pts}, ...])
 *   teamStrength data/team_strength.json, or a bare {TEAM: elo} map
 *   profile      LeagueProfile (supplies playoff_week_start); undefined -> DEFAULT
 *   opts.endWeek override for the last fantasy week (default 17)
 *
 * Returns null when there are no ratings, no weekly rows, or the player has no
 * RATED, non-bye game inside the window (an all-bye window is a null, not a 0).
 * Otherwise:
 *
 *   {
 *     window:      { start, end, weeks },  // weeks = calendar weeks in the window
 *     games:       int,   // window weeks with a rated opponent (the sample)
 *     byes:        int,   // bye weeks INSIDE the window
 *     unrated:     int,   // window games whose opponent has no Elo (skipped loudly)
 *     season_games:int,   // rated non-bye games across the whole schedule
 *     playoff_elo: num,   // mean opponent Elo inside the window        (2dp)
 *     season_elo:  num,   // mean opponent Elo across the season        (2dp)
 *     elo_diff:    num,   // playoff_elo - season_elo; + = HARDER than usual (2dp)
 *     rating:      num,   // 1.0 easiest .. 5.0 hardest, from elo_diff  (1dp)
 *     abs_rating:  num,   // same scale, window Elo vs the 1500 mean    (1dp)
 *     pts_per_game:num,   // -elo_diff / 25; + = easier slate = points  (2dp)
 *     label:       str,   // RATING_BANDS label for `rating`
 *     schedule:    [ { wk, opp, elo, home, bye }, ... ]  // every window week
 *   }
 *
 * `rating` is the lens: it is relative to the player's OWN season average, so it
 * answers "does this player's schedule get harder when it matters?". `abs_rating`
 * is the window's raw difficulty on the same scale and formula the season-long
 * SoS meter already uses, for a caller that wants both readings side by side.
 * Both use a FIXED sensitivity rather than re-normalising over whatever pool is
 * on screen, so a player's number does not move when the list is filtered.
 */
export function playoffSos(weeks, teamStrength, profile, opts = {}) {
  const rows = weeksOf(weeks);
  const ratings = ratingsOf(teamStrength);
  if (!rows || !ratings) return null;

  const window = playoffWindow(profile, opts);

  const schedule = [];
  const windowElo = [];
  const seasonElo = [];
  let byes = 0;
  let unrated = 0;

  for (const w of rows) {
    if (!w || typeof w !== 'object') continue;
    const wk = toFinite(w.wk);
    if (wk === null) continue;
    const bye = w.bye === true;
    const elo = bye ? null : eloFor(ratings, w.opp);
    if (!bye && elo !== null) seasonElo.push(elo);

    if (!inPlayoffWindow(wk, window)) continue;
    schedule.push({
      wk,
      opp: bye ? null : (w.opp == null ? null : String(w.opp)),
      elo,
      home: w.home === true,
      bye,
    });
    if (bye) byes += 1;
    else if (elo === null) unrated += 1;
    else windowElo.push(elo);
  }

  // No rated game in the window (all byes, an unrated slate, or a short season)
  // and no season baseline to compare against are both honest nulls.
  if (windowElo.length === 0 || seasonElo.length === 0) return null;

  schedule.sort((a, b) => a.wk - b.wk);

  const playoffElo = windowElo.reduce((a, b) => a + b, 0) / windowElo.length;
  const seasonAvg = seasonElo.reduce((a, b) => a + b, 0) / seasonElo.length;
  const diff = playoffElo - seasonAvg;
  const rating = toRating(diff);
  // pts_per_game is derived from the REPORTED (rounded) elo_diff, not the raw
  // mean, so the identity a caller can see — pts = -elo_diff / 25 — holds
  // exactly rather than being off by a rounding hair.
  const eloDiff = round(diff, 2);

  return {
    window,
    games: windowElo.length,
    byes,
    unrated,
    season_games: seasonElo.length,
    playoff_elo: round(playoffElo, 2),
    season_elo: round(seasonAvg, 2),
    elo_diff: eloDiff,
    rating,
    abs_rating: toRating(playoffElo - LEAGUE_MEAN_ELO),
    pts_per_game: round(-eloDiff / PLAYOFF_ELO_PER_POINT, 2),
    label: playoffSosLabel(rating),
    schedule,
  };
}

/** The RATING_BANDS label for a 1..5 rating, or null when rating is not a number. */
export function playoffSosLabel(rating) {
  const n = toFinite(rating);
  if (n === null) return null;
  for (const band of RATING_BANDS) {
    if (n < band.below) return band.label;
  }
  return RATING_BANDS[RATING_BANDS.length - 1].label;
}

/**
 * Every player's report, keyed by id: { [gsis_id]: report }.
 *
 *   playerWeekly  data/player_weekly.json, or a bare players[] array
 *
 * Players whose report is null are OMITTED rather than carried as null: absence
 * means "no lens for this player", and a caller iterating the object can never
 * mistake a placeholder for a neutral schedule. Use playoffSos() directly when
 * you need to distinguish "not in the file" from "in the file, no window games".
 */
export function playoffSosById(playerWeekly, teamStrength, profile, opts = {}) {
  const list = Array.isArray(playerWeekly)
    ? playerWeekly
    : (playerWeekly && Array.isArray(playerWeekly.players) ? playerWeekly.players : null);
  const out = {};
  if (!list) return out;
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const id = p.gsis_id != null ? p.gsis_id : (p.id != null ? p.id : p.player_id);
    if (id == null) continue;
    const report = playoffSos(p, teamStrength, profile, opts);
    if (report) out[String(id)] = report;
  }
  return out;
}

/**
 * playoffSosById() output -> [{ id, ...report }] sorted EASIEST FIRST
 * (elo_diff ascending), ties broken by id so the order is deterministic.
 */
export function rankPlayoffSos(byId) {
  if (!byId || typeof byId !== 'object') return [];
  return Object.keys(byId)
    .map((id) => ({ id, ...byId[id] }))
    .sort((a, b) => a.elo_diff - b.elo_diff || (a.id < b.id ? -1 : 1));
}

/* --------------------------------------------------------------------------
 * Self-check (mirrors the pattern in app/ros.js; called by the unit test)
 * ------------------------------------------------------------------------ */

export function __selftest() {
  const RATINGS = { A: 1600, B: 1400, C: 1500, D: 1550 };
  const weeks = [
    { wk: 14, opp: 'A', home: true, bye: false, pts: 10 },
    { wk: 15, opp: null, home: false, bye: true, pts: 0 },
    { wk: 16, opp: 'B', home: false, bye: false, pts: 12 },
    { wk: 17, opp: 'C', home: true, bye: false, pts: 14 },
    { wk: 18, opp: 'D', home: false, bye: false, pts: 9 },
  ];
  const profile = { shape: { playoff_week_start: 14 } };
  const r = playoffSos(weeks, { ratings: RATINGS }, profile);
  if (!r) throw new Error('playoffSos returned null on a rated window');
  if (r.window.start !== 14 || r.window.end !== 17) throw new Error('window not 14-17');
  if (r.games !== 3 || r.byes !== 1) throw new Error('games/byes not separated');
  // window mean (1600+1400+1500)/3 = 1500; season mean adds wk18 D=1550 -> 1512.5
  if (r.playoff_elo !== 1500) throw new Error('playoff_elo');
  if (r.season_elo !== 1512.5) throw new Error('season_elo');
  if (r.elo_diff !== -12.5) throw new Error('elo_diff');
  if (r.pts_per_game !== 0.5) throw new Error('pts_per_game restatement');
  // An all-bye window is null, never a neutral zero.
  const allBye = playoffSos(
    [{ wk: 14, opp: null, bye: true, pts: 0 }, { wk: 1, opp: 'A', bye: false, pts: 5 }],
    { ratings: RATINGS }, profile,
  );
  if (allBye !== null) throw new Error('all-bye window must be null');
  if (playoffSos(weeks, null, profile) !== null) throw new Error('no ratings must be null');
  return true;
}
