/* app/team-logic.js — THE FIT ENGINE (pure).
 *
 * Roster math + recommendation scoring for the TEAM tab. Every function here is
 * PURE: no DOM, no fetch, no storage, no Date — same inputs, same outputs, so
 * the unit tests (tests/feature/team_logic.test.mjs) import this file directly
 * under node with zero setup.
 *
 * Shapes (the build-contract shapes, byte-for-byte):
 *   projection player  { gsis_id, name, team, position, proj_points, ... }
 *   weekly entry       { gsis_id, receptions_prior, weeks: [ {wk, opp, home,
 *                        bye, pts} x18 ] }        (data/player_weekly.json)
 *   roster             { slots: { QB1,RB1,RB2,WR1,WR2,TE1,FLEX,
 *                        BN1..BN6: gsis_id|null } }  (localStorage nfl2026.team.v1)
 *   byId maps          Map or plain object keyed by String(gsis_id)
 *
 * Scoring conversion is EXACT via prior-season receptions (never a heuristic):
 * half = ppr − 0.5·rec, std = ppr − rec; weekly scales proportionally. All
 * points remain ESTIMATES — the weekly model is a labeled prior, not a measurement.
 *
 * Determinism invariant: no randomness, stable sorts, ties broken by season
 * points then gsis_id — recommend() output is reproducible byte-for-byte.
 */

/* --------------------------------------------------------------------------
 * Roster geometry
 * ------------------------------------------------------------------------ */

/** Starter slots in display/priority order (the weekly-total lineup). */
export const STARTER_SLOTS = Object.freeze(['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX']);

/** Bench slots. */
export const BENCH_SLOTS = Object.freeze(['BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6']);

/** All 13 slots, starters first — the "first eligible open slot" scan order. */
export const SLOT_ORDER = Object.freeze([...STARTER_SLOTS, ...BENCH_SLOTS]);

// Modeled positions only. No K / D-ST — the projection model does not cover
// them and we never fake numbers for them.
const MODELED = Object.freeze(['QB', 'RB', 'WR', 'TE']);
const FLEX_TAKES = Object.freeze(['RB', 'WR', 'TE']);

/* --------------------------------------------------------------------------
 * Fit-engine constants (build contract — do not tune without refitting tests)
 * ------------------------------------------------------------------------ */

export const W_PTS = 1.0;             // season points are the score backbone
export const STACK_BONUS = 12;        // same-team QB + WR/TE
export const BYE_COVER_BONUS = 6;     // per starter bye backfilled (cap below)
export const BYE_COVER_CAP = 12;      // covers beyond 2 add no score
export const BYE_CLASH_PENALTY = 10;  // per CURRENT STARTER sharing the bye
export const FLOOR_BONUS = 8;         // candidate raises the worst-week total
export const MATCHUP_BONUS_CAP = 8;   // complementary-schedule bonus ceiling
// Scale for the matchup bonus: bonus = min(cap, avg-strong-dip-week-pts × 0.4),
// so a ~20-pt dip-week performer hits the cap. Transparent prior, like TILT_COEF.
export const MATCHUP_SCALE = 0.4;

const EPS = 1e-9; // float comparisons ("raises", "dips") never flip on noise

/* --------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

/** Read from a Map or a plain object, keyed by String(id). */
function lookup(src, id) {
  if (src == null || id == null) return undefined;
  const key = String(id);
  return typeof src.get === 'function' ? src.get(key) : src[key];
}

/** Accept a weekly entry ({weeks:[...]}) or a bare weeks array; else null. */
function weeksOf(playerWeekly) {
  if (Array.isArray(playerWeekly)) return playerWeekly;
  if (playerWeekly && Array.isArray(playerWeekly.weeks)) return playerWeekly.weeks;
  return null;
}

/** Mean of an array (0 for empty — callers gate on emptiness themselves). */
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** Index of the minimum value (first hit — deterministic worst week). */
function argmin(arr) {
  let idx = 0;
  for (let i = 1; i < arr.length; i += 1) if (arr[i] < arr[idx]) idx = i;
  return idx;
}

/* --------------------------------------------------------------------------
 * Contract exports
 * ------------------------------------------------------------------------ */

/**
 * Season points under a scoring mode. EXACT conversion via prior-season
 * receptions: half = ppr − 0.5·rec, std = ppr − rec; ppr passes through.
 * Unknown mode falls back to ppr (never throws — display code depends on it).
 */
export function scoringAdjust(seasonPpr, receptions, mode) {
  const ppr = Number(seasonPpr) || 0;
  const rec = Number(receptions) || 0;
  if (mode === 'half') return ppr - 0.5 * rec;
  if (mode === 'std') return ppr - rec;
  return ppr;
}

/**
 * The player's 18 weekly points rescaled to a scoring mode: each non-bye week
 * scales by season_adj/season_ppr (the season conversion redistributed
 * proportionally — weekly shares are reception-agnostic in the v1 model).
 * Byes are hard 0 (a zero-week, not a projection). ppr<=0 guards the division
 * (ratio 1: nothing to redistribute). Missing weekly data -> [].
 */
export function weeklyPoints(playerWeekly, seasonAdj, seasonPpr) {
  const weeks = weeksOf(playerWeekly);
  if (!weeks) return [];
  const ppr = Number(seasonPpr);
  const ratio = ppr > 0 ? Number(seasonAdj) / ppr : 1;
  return weeks.map((w) => (w && w.bye === true ? 0 : (Number(w && w.pts) || 0) * ratio));
}

/** The player's bye week number, or null if the weekly data carries none. */
export function byeWeek(playerWeekly) {
  const weeks = weeksOf(playerWeekly);
  if (!weeks) return null;
  const bye = weeks.find((w) => w && w.bye === true);
  return bye ? Number(bye.wk) : null;
}

/**
 * Can a player at `position` legally occupy `slot`? FLEX takes RB/WR/TE;
 * bench takes any MODELED position (QB/RB/WR/TE — never K/D-ST, not modeled).
 * Unknown slot or unmodeled position -> false.
 */
export function slotEligible(position, slot) {
  const pos = String(position || '').toUpperCase();
  if (!MODELED.includes(pos)) return false;
  const s = String(slot || '').toUpperCase();
  if (s === 'FLEX') return FLEX_TAKES.includes(pos);
  if (BENCH_SLOTS.includes(s)) return true;
  if (STARTER_SLOTS.includes(s)) return s.replace(/\d+$/, '') === pos;
  return false;
}

/**
 * 18 summed weekly floats for the STARTERS ONLY (the .team-weeks grid).
 * `starters` is an array of gsis_ids (nulls skipped; player objects with a
 * gsis_id also accepted). `weeklyById` values may be raw weekly entries
 * (summed at PPR) or pre-scaled 18-float arrays from weeklyPoints() — the
 * caller picks the scoring mode by pre-scaling.
 */
export function teamWeeklyTotals(starters, weeklyById) {
  const totals = new Array(18).fill(0);
  (Array.isArray(starters) ? starters : []).forEach((s) => {
    const id = s && typeof s === 'object' ? s.gsis_id : s;
    if (id == null) return;
    const entry = lookup(weeklyById, id);
    const arr = Array.isArray(entry)
      ? entry
      : weeklyPoints(entry, 1, 0); // ratio 1 -> raw PPR week pts, byes 0
    arr.forEach((p, i) => {
      if (i < 18) totals[i] += Number(p) || 0;
    });
  });
  return totals;
}

/* --------------------------------------------------------------------------
 * fitScore — score one candidate against the current roster
 * ------------------------------------------------------------------------ */

/** Resolve the starters (slot, player, weekly, scaled 18-array) for scoring. */
function resolveStarters(slots, playersById, weeklyById, mode) {
  const out = [];
  STARTER_SLOTS.forEach((slot) => {
    const id = slots[slot];
    if (!id) return;
    const player = lookup(playersById, id);
    const entry = lookup(weeklyById, id);
    const arr = player && entry
      ? weeklyPoints(entry, scoringAdjust(player.proj_points, entry.receptions_prior, mode), player.proj_points)
      : null;
    out.push({ slot, id: String(id), player, bye: entry ? byeWeek(entry) : null, arr });
  });
  return out;
}

/** Highest-adjusted-points player in a list (tie: gsis_id asc — deterministic). */
function bestOf(players, weeklyById, mode) {
  let best = null;
  let bestAdj = -Infinity;
  players.forEach((p) => {
    const e = lookup(weeklyById, p.gsis_id);
    const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode);
    if (adj > bestAdj + EPS || (Math.abs(adj - bestAdj) <= EPS && best && String(p.gsis_id) < String(best.gsis_id))) {
      best = p;
      bestAdj = adj;
    }
  });
  return best;
}

/**
 * Score `candidate` (a projection player) against `roster` for ctx.slot.
 * Returns { score, reasons: [string,...] } — reasons are REAL sentences
 * computed from the data, most impactful first, max 4 (the .reco-why lines).
 *
 * ctx: { playersById, weeklyById, mode='ppr', slot=null }. With no weekly
 * data for the candidate the bye/floor/matchup terms simply contribute 0 —
 * the score degrades to season points (+stack), never throws.
 */
export function fitScore(candidate, roster, ctx) {
  const c = ctx || {};
  const mode = c.mode === 'half' || c.mode === 'std' ? c.mode : 'ppr';
  const playersById = c.playersById;
  const weeklyById = c.weeklyById;
  const slots = (roster && roster.slots) || {};

  const candEntry = lookup(weeklyById, candidate.gsis_id);
  const candAdj = scoringAdjust(candidate.proj_points, candEntry ? candEntry.receptions_prior : 0, mode);
  const candArr = candEntry ? weeklyPoints(candEntry, candAdj, candidate.proj_points) : null;
  const candBye = candEntry ? byeWeek(candEntry) : null;
  const candPos = String(candidate.position || '').toUpperCase();

  const starters = resolveStarters(slots, playersById, weeklyById, mode);

  // reasons carry their score impact so "most impactful first" is computed,
  // not asserted. Base term first: raw points dominate by design (W_PTS=1.0).
  const reasons = [];
  let score = candAdj * W_PTS;
  reasons.push({
    impact: candAdj * W_PTS,
    text: `Projects ${candAdj.toFixed(1)} season points (${mode.toUpperCase()}) — raw points drive the fit score`,
  });

  // STACK: same-team QB + receiver compound (both spike in the same games).
  // Scans the WHOLE roster (a bench stack still stacks); partner = best points.
  const rostered = Object.values(slots)
    .filter(Boolean)
    .map((id) => lookup(playersById, id))
    .filter(Boolean);
  let partners = [];
  if (candPos === 'WR' || candPos === 'TE') {
    partners = rostered.filter((p) => String(p.position).toUpperCase() === 'QB' && p.team === candidate.team);
  } else if (candPos === 'QB') {
    partners = rostered.filter((p) => ['WR', 'TE'].includes(String(p.position).toUpperCase()) && p.team === candidate.team);
  }
  const partner = bestOf(partners, weeklyById, mode);
  if (partner) {
    score += STACK_BONUS;
    reasons.push({
      impact: STACK_BONUS,
      text: `Stacks with ${partner.name} (${candidate.team}) — QB+receiver points compound in good weeks`,
    });
  }

  // BYE COVER: +6 per same-position starter whose bye week the candidate
  // actually plays through (capped at 12 — two covers is a full rotation).
  let coverTotal = 0;
  if (candArr) {
    starters.forEach((s) => {
      if (coverTotal >= BYE_COVER_CAP) return;
      if (!s.player || String(s.player.position).toUpperCase() !== candPos) return;
      if (s.bye == null || s.bye === candBye) return;
      if (!(candArr[s.bye - 1] > EPS)) return; // candidate must play that week
      coverTotal += BYE_COVER_BONUS;
      score += BYE_COVER_BONUS;
      reasons.push({
        impact: BYE_COVER_BONUS,
        text: `Covers ${s.player.name}'s Week ${s.bye} bye at ${candPos}`,
      });
    });
  }

  // BYE CLASH: −10 per CURRENT STARTER sharing the candidate's bye — stacked
  // byes zero out a whole week. One combined reason names every clasher.
  if (candBye != null) {
    const clashers = starters.filter((s) => s.player && s.bye === candBye);
    if (clashers.length > 0) {
      const pen = BYE_CLASH_PENALTY * clashers.length;
      score -= pen;
      reasons.push({
        impact: -pen,
        text: `Shares Week ${candBye} bye with ${clashers.map((s) => s.player.name).join(', ')} — stacking byes creates a zero-week`,
      });
    }
  }

  // Starter weekly totals (current lineup) feed the floor + matchup terms.
  const anyStarterWeeks = starters.some((s) => s.arr);
  const totals = teamWeeklyTotals(
    starters.filter((s) => s.arr).map((s) => s.id),
    new Map(starters.filter((s) => s.arr).map((s) => [s.id, s.arr])),
  );

  // FLOOR: does slotting the candidate in (replacing any incumbent in the
  // target slot) raise the worst starter week? Bench adds never move the floor.
  const targetSlot = c.slot || STARTER_SLOTS.find((s) => !slots[s] && slotEligible(candPos, s)) || null;
  if (candArr && anyStarterWeeks && targetSlot && STARTER_SLOTS.includes(targetSlot)) {
    const withoutIncumbent = starters.filter((s) => s.slot !== targetSlot && s.arr);
    const base = teamWeeklyTotals(
      withoutIncumbent.map((s) => s.id),
      new Map(withoutIncumbent.map((s) => [s.id, s.arr])),
    );
    const next = base.map((t, i) => t + candArr[i]);
    const oldWorst = argmin(totals);
    const newFloor = next[argmin(next)];
    if (newFloor > totals[oldWorst] + EPS) {
      score += FLOOR_BONUS;
      reasons.push({
        impact: FLOOR_BONUS,
        text: `Raises your floor: worst week improves W${oldWorst + 1} ${totals[oldWorst].toFixed(1)} → ${newFloor.toFixed(1)}`,
      });
    }
  }

  // MATCHUP (complementary schedules): weeks where the current starters dip
  // below their own average AND the candidate beats their own non-bye average.
  // Bonus scales with the candidate's output in those weeks, capped at 8.
  if (candArr && anyStarterWeeks) {
    const avg = mean(totals);
    const candPlays = candArr.filter((p) => p > EPS);
    const candAvg = mean(candPlays);
    const strong = [];
    totals.forEach((t, i) => {
      if (t < avg - EPS && candArr[i] > candAvg + EPS) strong.push(i + 1);
    });
    if (strong.length > 0) {
      const strongAvg = mean(strong.map((wk) => candArr[wk - 1]));
      const bonus = Math.min(MATCHUP_BONUS_CAP, strongAvg * MATCHUP_SCALE);
      score += bonus;
      // Show the top 3 weeks by candidate points, listed in week order.
      const shown = strong
        .slice()
        .sort((a, b) => candArr[b - 1] - candArr[a - 1] || a - b)
        .slice(0, 3)
        .sort((a, b) => a - b);
      reasons.push({
        impact: bonus,
        text: `Strong Weeks ${shown.join(', ')} when your starters face tough matchups`,
      });
    }
  }

  // Most impactful first (|impact| desc; Array.sort is stable, so equal-impact
  // reasons keep computation order), max 4 shown.
  reasons.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return {
    score: Math.round(score * 100) / 100,
    reasons: reasons.slice(0, 4).map((r) => r.text),
  };
}

/* --------------------------------------------------------------------------
 * recommend — top-5 candidates for a slot
 * ------------------------------------------------------------------------ */

/**
 * The neediest OPEN slot: among open starter slots, the one leaving the most
 * projected points on the table (best available eligible candidate's adjusted
 * season points; tie -> earlier in STARTER_SLOTS order). Starters always
 * outrank bench; with starters full it is the first open bench slot; full
 * roster -> null. Exported so the view labels the .reco panel with the SAME
 * slot recommend() resolves.
 */
export function neediestOpenSlot(roster, pool, weeklyById, mode) {
  const slots = (roster && roster.slots) || {};
  const players = Array.isArray(pool) ? pool : [];
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));

  const openStarters = STARTER_SLOTS.filter((s) => !slots[s]);
  if (openStarters.length === 0) return BENCH_SLOTS.find((s) => !slots[s]) || null;

  let best = openStarters[0];
  let bestAdj = -Infinity;
  openStarters.forEach((slot) => {
    let top = -Infinity;
    players.forEach((p) => {
      if (rostered.has(String(p.gsis_id)) || !slotEligible(p.position, slot)) return;
      const e = lookup(weeklyById, p.gsis_id);
      const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode);
      if (adj > top) top = adj;
    });
    if (top > bestAdj + EPS) {
      best = slot;
      bestAdj = top;
    }
  });
  return best;
}

/**
 * Top-5 { player, score, reasons } for `slot` (or the neediest open slot when
 * omitted), scored by fitScore against the current roster. Excludes rostered
 * players. Deterministic: score desc, then adjusted season points desc, then
 * gsis_id asc. Full roster with no slot given -> [].
 */
export function recommend(roster, pool, weeklyById, mode, slot) {
  const players = Array.isArray(pool) ? pool : [];
  const slots = (roster && roster.slots) || {};
  const target = slot || neediestOpenSlot(roster, players, weeklyById, mode);
  if (!target) return [];

  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));

  const scored = players
    .filter((p) => !rostered.has(String(p.gsis_id)) && slotEligible(p.position, target))
    .map((p) => {
      const e = lookup(weeklyById, p.gsis_id);
      return {
        player: p,
        adj: scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode),
        ...fitScore(p, roster, { playersById, weeklyById, mode, slot: target }),
      };
    });

  scored.sort((a, b) =>
    b.score - a.score
    || b.adj - a.adj
    || (String(a.player.gsis_id) < String(b.player.gsis_id) ? -1 : 1));

  return scored.slice(0, 5).map(({ player, score, reasons }) => ({ player, score, reasons }));
}
