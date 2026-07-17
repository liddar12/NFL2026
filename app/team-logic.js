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
export function recommend(roster, pool, weeklyById, mode, slot, opts) {
  const players = Array.isArray(pool) ? pool : [];
  const slots = (roster && roster.slots) || {};
  const target = slot || neediestOpenSlot(roster, players, weeklyById, mode);
  if (!target) return [];

  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));
  const sortMode = opts && opts.sort === 'available' ? 'available' : 'fit';

  const scored = players
    // Exclude rostered ids, slot-ineligible positions, AND positions already at
    // their roster cap (POSITION_CAPS) — no 3rd QB / 2nd DEF / 2nd K is ever
    // proposed for a bench slot.
    .filter((p) => !rostered.has(String(p.gsis_id))
      && slotEligible(p.position, target)
      && !positionAtCap(p.position, slots, playersById))
    .map((p) => {
      const e = lookup(weeklyById, p.gsis_id);
      return {
        player: p,
        adj: scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode),
        ...fitScore(p, roster, { playersById, weeklyById, mode, slot: target }),
      };
    });

  sortScored(scored, sortMode);
  return scored.slice(0, 5).map(({ player, score, reasons }) => ({ player, score, reasons }));
}

/**
 * Deterministic in-place sort of scored reco rows.
 *   'fit'       (default) — fit score desc, then adjusted points, then id
 *   'available' — raw adjusted points desc, then fit score, then id
 * Both fully break ties on gsis_id so the order is reproducible byte-for-byte.
 */
function sortScored(scored, sortMode) {
  if (sortMode === 'available') {
    scored.sort((a, b) =>
      b.adj - a.adj
      || b.score - a.score
      || (String(a.player.gsis_id) < String(b.player.gsis_id) ? -1 : 1));
  } else {
    scored.sort((a, b) =>
      b.score - a.score
      || b.adj - a.adj
      || (String(a.player.gsis_id) < String(b.player.gsis_id) ? -1 : 1));
  }
}

/* --------------------------------------------------------------------------
 * FIT ENGINE v2 — the opt-in AI layer (ctx.ai === true)
 *
 * v2 = v1 EXACTLY (fitScore above is untouched — the OFF path is byte-
 * identical) plus bounded terms read from data/ai_insights.json (built by
 * scripts/ai_estimates.py — documented deterministic rules; every value
 * carries source "measured" | "ai_estimated" and the reasons below say which).
 * AI-estimated reasons always carry the literal "(AI estimate" marker so the
 * view can chip them; measured reasons cite their span. Insight values are
 * contract-bounded to |0.25|, so each term below is bounded too.
 * ------------------------------------------------------------------------ */

export const TRAJECTORY_SCALE = 40;  // fit pts per unit trajectory_adj (±0.25 -> ±10)
export const COLD_SCALE = 5;         // fit pts per cold-venue week per unit cold_adj
export const COLD_WEEKS_CAP = 4;     // cold weeks beyond 4 add no score (±0.25 -> ±5)
export const V2_REASON_CAP = 6;      // v1's 4 + up to 2 highest-impact AI reasons

/** Provenance suffixes (the contract strings — tests match on these). */
const PROV_MEASURED = '(measured 2021–2025)';
const PROV_ESTIMATED = '(AI estimate — fewer than 3 seasons observed)';

/** Accept the whole ai_insights.json doc ({players:{...}}) or a bare map. */
function insightFor(insights, id) {
  const map = insights && insights.players ? insights.players : insights;
  return lookup(map, id) || null;
}

/** Same-team QB+receiver stack partner (v2's copy — v1's inline scan stays
 * untouched). Returns the best-points partner or null. */
function stackPartner(candidate, slots, playersById, weeklyById, mode) {
  const candPos = String(candidate.position || '').toUpperCase();
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
  return bestOf(partners, weeklyById, mode);
}

/**
 * Score `candidate` with the AI layer ON. Same ctx as fitScore plus:
 *   ai        MUST be exactly true to add anything (else v1 passthrough)
 *   insights  data/ai_insights.json doc or its players map
 * Returns { score, reasons } in the SAME shape as fitScore. Missing insight
 * data for the candidate degrades to the v1 result — never throws.
 */
export function fitScoreV2(candidate, roster, ctx) {
  const base = fitScore(candidate, roster, ctx);
  const c = ctx || {};
  if (c.ai !== true) return base;
  const ins = insightFor(c.insights, candidate.gsis_id);
  if (!ins) return base;

  const candPos = String(candidate.position || '').toUpperCase();
  const extra = []; // {impact, text} — merged after v1's reasons, |impact| desc

  // TRAJECTORY_TERM — 5-yr trend (measured OLS) or age-curve prior (estimated).
  const t = ins.trajectory_adj;
  if (t && Number.isFinite(Number(t.value)) && Number(t.value) !== 0) {
    const v = Number(t.value);
    const impact = v * TRAJECTORY_SCALE;
    const prov = t.source === 'measured' ? PROV_MEASURED : PROV_ESTIMATED;
    let text;
    if (v > 0) {
      // Cite the real pts/yr when the insight carries it (the emitted file
      // always does); a minimal fixture falls back to the builder's norm.
      const slope = Number.isFinite(Number(t.slope_pts_per_yr))
        ? Number(t.slope_pts_per_yr)
        : v * 200;
      const n = Number(t.seasons_observed);
      const span = Number.isFinite(n) && n > 0 ? ` over ${n} season${n === 1 ? '' : 's'}` : '';
      text = `Trending up: +${slope.toFixed(1)} pts/yr${span} ${prov}`;
    } else {
      const provDown = t.source === 'measured' ? '(source: measured 2021–2025)' : prov;
      text = `Declining faster than the ${candPos} age curve ${provDown}`;
    }
    extra.push({ impact, text });
  }

  // STACK SYNERGY — scales the flat v1 stack bonus, only when a stack exists.
  const s = ins.stack_synergy;
  if (s && Number.isFinite(Number(s.value)) && Number(s.value) !== 0) {
    const partner = stackPartner(candidate, (roster && roster.slots) || {}, c.playersById, c.weeklyById,
      c.mode === 'half' || c.mode === 'std' ? c.mode : 'ppr');
    if (partner) {
      const impact = Number(s.value) * STACK_BONUS;
      const pair = s.pair || (candPos === 'QB' ? 'QB+WR' : `QB+${candPos}`);
      const prov = s.source === 'measured'
        ? PROV_MEASURED
        : '(AI estimate — position-pair default)';
      extra.push({
        impact,
        text: `Stack synergy with ${partner.name}: ${pair} pairs compound beyond the base stack bonus ${prov}`,
      });
    }
  }

  // COLD_TERM — the team's sub-32F delta applied to its cold-venue weeks.
  const cold = ins.cold_adj;
  const coldWeeks = cold && Array.isArray(cold.weeks)
    ? cold.weeks.map(Number).filter((w) => Number.isFinite(w))
    : [];
  if (cold && Number.isFinite(Number(cold.value)) && Number(cold.value) !== 0
      && coldWeeks.length > 0) {
    const v = Number(cold.value);
    const impact = v * COLD_SCALE * Math.min(coldWeeks.length, COLD_WEEKS_CAP);
    const pct = Math.abs(v * 100).toFixed(0);
    const prov = cold.source === 'measured'
      ? PROV_MEASURED
      : '(AI estimate — no team-specific cold sample)';
    const word = v > 0 ? 'edge' : 'risk';
    const sign = v > 0 ? '+' : '−';
    const wkWord = coldWeeks.length === 1 ? 'Week' : 'Weeks';
    extra.push({
      impact,
      text: `Cold-weather ${word}: ${sign}${pct}% win rate below 32°F in ${wkWord} ${coldWeeks.join(', ')} ${prov}`,
    });
  }

  extra.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const score = Math.round((base.score + extra.reduce((sum, r) => sum + r.impact, 0)) * 100) / 100;
  return {
    score,
    reasons: base.reasons.concat(extra.map((r) => r.text)).slice(0, V2_REASON_CAP),
  };
}

/**
 * recommend() with the AI layer ON: same candidate filter, same deterministic
 * tie-breaks (score desc, adjusted points desc, gsis_id asc), scored by
 * fitScoreV2 with `insights`. The OFF path keeps using recommend() — this
 * function exists so the v1 ranking code stays byte-identical.
 */
export function recommendV2(roster, pool, weeklyById, mode, slot, insights, opts) {
  const players = Array.isArray(pool) ? pool : [];
  const slots = (roster && roster.slots) || {};
  const target = slot || neediestOpenSlot(roster, players, weeklyById, mode);
  if (!target) return [];

  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));
  const sortMode = opts && opts.sort === 'available' ? 'available' : 'fit';

  const scored = players
    .filter((p) => !rostered.has(String(p.gsis_id))
      && slotEligible(p.position, target)
      && !positionAtCap(p.position, slots, playersById))
    .map((p) => {
      const e = lookup(weeklyById, p.gsis_id);
      const ctx = { playersById, weeklyById, mode, slot: target };
      // base = the v1 fit score (AI OFF); v2 adds the bounded AI terms. Carrying
      // both lets the view show a visible base -> AI+ delta on every pick.
      const base = fitScore(p, roster, ctx).score;
      return {
        player: p,
        adj: scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode),
        base,
        ...fitScoreV2(p, roster, { ...ctx, ai: true, insights }),
      };
    });

  sortScored(scored, sortMode);
  return scored.slice(0, 5).map(({ player, score, reasons, base }) => ({
    player, score, reasons, base,
  }));
}

/* --------------------------------------------------------------------------
 * REL2 — roster position caps, reco sort, strength-of-schedule, trend labels
 * ------------------------------------------------------------------------ */

/**
 * Roster caps by position — a fantasy roster never needs a 3rd QB, a 2nd
 * defense, or a 2nd kicker, so the fit engine stops recommending a position
 * once its cap is reached (the "why does it keep pushing QBs?" fix). Positions
 * NOT listed here are uncapped: RB/WR/TE are bounded by roster geometry (the
 * FLEX + bench), not by a hard count. DEF/DST/K are listed and ready even
 * though the projection model does not cover them yet (no slots, no fabricated
 * numbers) — the cap holds the moment they are ever added to the pool.
 */
export const POSITION_CAPS = Object.freeze({ QB: 2, DEF: 1, DST: 1, K: 1 });

/** Count rostered players by uppercased position. */
export function rosteredCountByPos(slots, playersById) {
  const counts = {};
  Object.values(slots || {}).filter(Boolean).forEach((id) => {
    const p = lookup(playersById, id);
    if (!p) return;
    const pos = String(p.position || '').toUpperCase();
    counts[pos] = (counts[pos] || 0) + 1;
  });
  return counts;
}

/**
 * Has `position` already reached its roster cap? Uncapped positions never do.
 * Used to drop capped-position candidates from recommend()/recommendV2 so the
 * engine never proposes an over-cap add (e.g. a 3rd QB for a bench slot).
 */
export function positionAtCap(position, slots, playersById) {
  const pos = String(position || '').toUpperCase();
  const cap = POSITION_CAPS[pos];
  if (cap == null) return false;
  return (rosteredCountByPos(slots, playersById)[pos] || 0) >= cap;
}

/**
 * Per-player STRENGTH OF SCHEDULE on a 1.0 (easiest) .. 5.0 (hardest) scale,
 * one decimal. `weeks` is a player_weekly entry ({weeks:[...]}) or a bare weeks
 * array; `teamStrength` is data/team_strength.json ({ratings:{team:elo}, ...}).
 *
 * Difficulty = the mean Elo of the player's real (non-bye) opponents, mapped
 * around the 1500 league mean at a transparent, fixed sensitivity: every
 * SOS_ELO_PER_POINT Elo of average-opponent strength above/below 1500 moves the
 * rating one full step, clamped to [1,5]. A fixed sensitivity (not a per-slate
 * re-normalization) keeps a player's SoS stable as the pool filters. Returns
 * null when weekly opponents or ratings are unavailable (caller shows nothing).
 */
export const SOS_ELO_PER_POINT = 25;

export function strengthOfSchedule(weeks, teamStrength) {
  const arr = weeksOf(weeks);
  const ratings = teamStrength && teamStrength.ratings ? teamStrength.ratings : null;
  if (!arr || !ratings) return null;
  const opps = [];
  arr.forEach((w) => {
    if (!w || w.bye === true) return;
    const key = String(w.opp == null ? '' : w.opp).toUpperCase();
    const r = ratings[key] != null ? ratings[key] : ratings[w.opp];
    if (Number.isFinite(Number(r))) opps.push(Number(r));
  });
  if (opps.length === 0) return null;
  const meanOpp = opps.reduce((a, b) => a + b, 0) / opps.length;
  const raw = 3.0 + (meanOpp - 1500) / SOS_ELO_PER_POINT;
  return Math.round(Math.max(1, Math.min(5, raw)) * 10) / 10;
}

/**
 * Normalize a trajectory insight (ai_insights trajectory_adj, or a
 * player_history trajectory) into a display-ready trend:
 *   { dir: 'up'|'down'|'flat', slope_pts_per_yr|null, seasons|null,
 *     source: 'measured'|'ai_estimated' }
 * `dir` comes from the signed adjustment when present (ai_insights carries
 * `value`), else from the raw OLS slope (player_history carries
 * `slope_pts_per_yr`). Missing/zero -> 'flat'. Never throws. Pure.
 */
export function trendLabel(traj) {
  if (!traj || typeof traj !== 'object') return null;
  const source = traj.source === 'measured' ? 'measured' : 'ai_estimated';
  const slope = Number.isFinite(Number(traj.slope_pts_per_yr))
    ? Number(traj.slope_pts_per_yr) : null;
  const seasons = Number.isFinite(Number(traj.seasons_observed))
    ? Number(traj.seasons_observed) : null;
  // Direction: prefer the signed adjustment (value); fall back to raw slope.
  let signal = null;
  if (Number.isFinite(Number(traj.value))) signal = Number(traj.value);
  else if (slope != null) signal = slope;
  const dir = signal == null || signal === 0 ? 'flat' : (signal > 0 ? 'up' : 'down');
  return { dir, slope_pts_per_yr: slope, seasons, source };
}
