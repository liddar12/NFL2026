/* app/ros.js — Rest-of-Season (RoS) VALUE ENGINE (pure, no DOM/fetch at import).
 *
 * Phase 0 of the in-season roadmap. RoS value = a player's projected points over
 * the REMAINING weeks of the season (bye excluded), optionally adjusted by
 * remaining strength-of-schedule and availability — with those two adjustments
 * defaulting to weight 0 so the engine ships byte-identical to raw remaining
 * sums. Those weights are PLACEHOLDERS for a future never-regress gate family
 * (ros_sos / ros_avail) that is NOT yet implemented in scripts/promote_signals.py
 * — until it is, the adjustments stay pinned at weight 0 and change nothing, so
 * today RoS is exactly the raw remaining projection. This engine is independent
 * of any betting line by construction — projections, schedule, availability only.
 *
 * Everything is pure and unit-tested (tests/feature/ros.test.mjs). The app layer
 * feeds these functions the committed contracts (player_weekly, team_strength,
 * injury availability); this module never fetches.
 */

/** Remaining, non-bye week rows for a player from `fromWeek` onward (inclusive).
 * `weeks` is player_weekly[].weeks: [{wk, opp, home, bye, pts}]. */
export function remainingWeeks(weeks, fromWeek) {
  if (!Array.isArray(weeks)) return [];
  const from = Number(fromWeek) || 1;
  return weeks.filter((w) => w && Number(w.wk) >= from && !w.bye);
}

/** Count of remaining games (byes excluded). */
export function gamesLeft(weeks, fromWeek) {
  return remainingWeeks(weeks, fromWeek).length;
}

/** The player's upcoming bye week number at/after fromWeek, or null. */
export function nextBye(weeks, fromWeek) {
  if (!Array.isArray(weeks)) return null;
  const from = Number(fromWeek) || 1;
  const b = weeks.find((w) => w && w.bye && Number(w.wk) >= from);
  return b ? Number(b.wk) : null;
}

/**
 * Rest-of-season projected points. sosByTeam/availById are OPTIONAL adjustment
 * inputs; with the default weights (0) the result is the exact raw remaining
 * sum — the never-regress zero-default the promotion gate tunes upward only if
 * it beats the incumbent.
 *   sosByTeam[opp]  : a factor centered on 1 (e.g. 1.05 = a soft remaining slate)
 *   availById[id]?  : availability probability in [0,1] for THIS player
 *   opts.sosW       : weight on the (sosFactor-1) term (default 0)
 *   opts.availW     : weight on the (avail-1) term (default 0)
 */
export function rosPoints(weeks, fromWeek, opts = {}) {
  const rem = remainingWeeks(weeks, fromWeek);
  const sosW = Number(opts.sosW) || 0;
  const availW = Number(opts.availW) || 0;
  const sosByTeam = opts.sosByTeam || null;
  const avail = Number.isFinite(Number(opts.avail)) ? Number(opts.avail) : 1;
  let total = 0;
  for (const w of rem) {
    let pts = Number(w.pts) || 0;
    if (sosW && sosByTeam && w.opp != null) {
      const f = Number(sosByTeam[w.opp]);
      if (Number.isFinite(f)) pts *= 1 + sosW * (f - 1);
    }
    total += pts;
  }
  if (availW) total *= 1 + availW * (avail - 1);
  return Math.round(total * 10) / 10;
}

/** Floor / median / ceil band for the remaining slate, from the dispersion of
 * the remaining weekly projections (median ± 1σ · √games, a simple honest band).
 * Byes excluded. Returns nulls when there are no remaining games. */
export function rosRange(weeks, fromWeek, opts = {}) {
  const rem = remainingWeeks(weeks, fromWeek);
  const n = rem.length;
  if (n === 0) return { floor: null, median: null, ceil: null };
  const pts = rem.map((w) => Number(w.pts) || 0);
  const median = rosPoints(weeks, fromWeek, opts);
  const mean = pts.reduce((a, b) => a + b, 0) / n;
  const variance = pts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const sd = Math.sqrt(variance);
  const band = sd * Math.sqrt(n); // season-total sd scales with √games
  return {
    floor: Math.round(Math.max(0, median - band) * 10) / 10,
    median,
    ceil: Math.round((median + band) * 10) / 10,
  };
}

/** Replacement level at a position: the RoS value of the last starter, given a
 * starter cutoff (e.g. 24 for RB in a 12-team league). `rosList` is the
 * descending-sorted RoS numbers for that position. */
export function replacementLevel(rosList, cutoff) {
  if (!Array.isArray(rosList) || rosList.length === 0) return 0;
  const idx = Math.min(Math.max(1, Number(cutoff) || 1), rosList.length) - 1;
  const sorted = rosList.slice().sort((a, b) => b - a);
  return sorted[idx];
}

/** RoS value over replacement (VOR) at a position. */
export function rosVOR(ros, replacement) {
  return Math.round((Number(ros) - Number(replacement)) * 10) / 10;
}

/** Default starter cutoffs per position for a 12-team league (replacement rank). */
const STARTER_CUTOFFS = Object.freeze({ QB: 12, RB: 24, WR: 36, TE: 12 });

/**
 * Rank a set of players by rest-of-season value within their positions.
 * `players`: [{id, pos, weeks}]. Returns [{id, pos, ros, gamesLeft, bye, vor, z}]
 * sorted by vor desc. Pure — no fetch, no external line, projections only.
 */
export function rankByRos(players, fromWeek, opts = {}) {
  const cutoffs = opts.cutoffs || STARTER_CUTOFFS;
  const rows = (Array.isArray(players) ? players : []).map((p) => ({
    id: p.id,
    pos: String(p.pos || '').toUpperCase(),
    ros: rosPoints(p.weeks, fromWeek, p.opts || opts),
    gamesLeft: gamesLeft(p.weeks, fromWeek),
    bye: nextBye(p.weeks, fromWeek),
  }));
  // Per-position replacement level + z-score, then VOR.
  const byPos = new Map();
  for (const r of rows) {
    if (!byPos.has(r.pos)) byPos.set(r.pos, []);
    byPos.get(r.pos).push(r.ros);
  }
  const repl = new Map();
  const stats = new Map();
  for (const [pos, list] of byPos) {
    repl.set(pos, replacementLevel(list, cutoffs[pos] || Math.ceil(list.length / 2)));
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    const variance = list.reduce((a, b) => a + (b - mean) * (b - mean), 0) / list.length;
    stats.set(pos, { mean, sd: Math.sqrt(variance) || 1 });
  }
  for (const r of rows) {
    r.vor = rosVOR(r.ros, repl.get(r.pos) || 0);
    const s = stats.get(r.pos);
    r.z = Math.round(((r.ros - s.mean) / s.sd) * 100) / 100;
  }
  rows.sort((a, b) => b.vor - a.vor || (a.id < b.id ? -1 : 1));
  return rows;
}

/** Tiny self-check (mirrors the Python builder selftests; called by unit test). */
export function __selftest() {
  const weeks = [
    { wk: 1, opp: 'A', bye: false, pts: 10 },
    { wk: 2, opp: 'B', bye: true, pts: 0 },
    { wk: 3, opp: 'C', bye: false, pts: 20 },
  ];
  // From week 2: bye at wk2 excluded, wk3 counts -> 20 pts, 1 game left.
  if (rosPoints(weeks, 2) !== 20) throw new Error('rosPoints remaining sum');
  if (gamesLeft(weeks, 2) !== 1) throw new Error('gamesLeft byes excluded');
  if (nextBye(weeks, 1) !== 2) throw new Error('nextBye');
  // Zero-weight SoS/avail must reproduce the raw sum exactly.
  const raw = rosPoints(weeks, 1);
  const adj = rosPoints(weeks, 1, { sosW: 0, availW: 0, sosByTeam: { A: 2 }, avail: 0.5 });
  if (raw !== adj) throw new Error('zero-default must equal raw sum');
  return true;
}
