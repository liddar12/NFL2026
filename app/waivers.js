/* app/waivers.js — R49: the waiver wire, pure (no DOM/fetch at import).
 *
 * Owner's ask, verbatim intent: the LINEUP tab offers BEST FIT and BEST
 * AVAILABLE "pulling from available players on sleeper based on that week and
 * the remaining weeks". Three functions, all total, all deterministic:
 *
 *   freeAgents(pool, rosteredIds)   the pool minus every id any league roster holds
 *   bestAvailable({...})            per position, the top N by THIS WEEK and,
 *                                   separately, by REST OF SEASON
 *   bestFit({...})                  the free agents that RAISE my optimal lineup
 *                                   total (bestLineup with − bestLineup without),
 *                                   this week and over the rest of the season,
 *                                   each with the least-cost DROP
 *
 * HONESTY RULES this module enforces rather than trusts the caller with:
 *   - Absent is never 0. A row whose points cannot be computed carries null,
 *     ranks after every priced row, and never wins a list on a fabricated 0.
 *   - Nothing here is a market. There is no price, ADP or ownership input —
 *     the signature has no slot for one, on purpose.
 *   - Every gain is an ESTIMATE from the same weekly derivation the roster
 *     card prints (the caller passes rowsFor; this module never re-prices).
 *   - Ties break on id ascending, so two devices with the same data print the
 *     same list.
 *
 * WHAT A DROP COSTS. For a horizon (one week, or every remaining week) the
 * cost of dropping r is bestLineup(roster) − bestLineup(roster \ r), summed
 * over the horizon's weeks. Only BENCH players — outside the optimal lineup
 * of the week in view — are proposed while any exist; over the rest of the
 * season a bench player may still cover a bye, and that is the cost printed
 * beside him. Least cost first, then fewest points over the horizon (least
 * value lost if the estimate is wrong), then id ascending. A starter is
 * proposed only when the roster has no bench at all.
 */

import { bestLineup, canonPosition } from './lineup.js';

const r1 = (n) => Math.round(Number(n) * 10) / 10;
const idAsc = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
const idOf = (row) => (row == null ? '' : String(row.id != null ? row.id : (row.gsis_id != null ? row.gsis_id : '')));
// null / undefined / '' are ABSENT, never 0 — Number(null) is 0 and would lie.
const finiteOrNull = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** Every id under a roster: a slots map ({ slot: id|null }) or a plain array. */
export function rosterIdsOf(roster) {
  const list = Array.isArray(roster)
    ? roster
    : (roster && typeof roster === 'object' ? Object.values(roster) : []);
  const seen = new Set();
  return list.filter(Boolean).map(String).filter((id) => !seen.has(id) && seen.add(id));
}

/**
 * The pool rows nobody in the league has rostered. `pool` rows carry `id` (or
 * `gsis_id`); K/DEF rows are included exactly when the caller put them in the
 * pool — this function never decides what a league seats.
 */
export function freeAgents(pool, rosteredIds) {
  const taken = new Set((Array.isArray(rosteredIds) ? rosteredIds : []).map(String));
  return (Array.isArray(pool) ? pool : []).filter((p) => {
    const id = idOf(p);
    return id && !taken.has(id);
  });
}

/** Sort: priced rows first (desc), null-priced rows last, id ascending on ties. */
function rankBy(key) {
  return (a, b) => {
    const av = a[key]; const bv = b[key];
    if (av == null && bv == null) return idAsc(a.id, b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av || idAsc(a.id, b.id);
  };
}

/**
 * bestAvailable({ freeAgents, week, weekPointsOf, rosPointsOf, positions, limit })
 *   freeAgents:   [{ id, name, team, position, bye?, availability? }]
 *   weekPointsOf: (row, week) -> number|null   THIS week, league-priced, bye and
 *                                              unavailable weeks already 0
 *   rosPointsOf:  (row, week) -> number|null   sum of weeks >= week, same rules
 *   positions:    the position tokens to list (DST is folded into DEF)
 *   limit:        rows per position per list (default 5)
 * Returns { week: { POS: [row] }, ros: { POS: [row] }, positions }, each row
 * { id, name, team, position, week_pts, ros_pts, bye, availability }.
 */
export function bestAvailable({
  freeAgents: fas, week, weekPointsOf, rosPointsOf, positions, limit = 5,
} = {}) {
  const wk = Number(week);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const posList = [];
  for (const pos of (Array.isArray(positions) ? positions : [])) {
    const c = canonPosition(pos);
    if (c && !posList.includes(c)) posList.push(c);
  }
  const rows = (Array.isArray(fas) ? fas : []).map((fa) => ({
    id: idOf(fa),
    name: fa && fa.name != null ? String(fa.name) : idOf(fa),
    team: fa && fa.team != null ? String(fa.team) : '',
    position: canonPosition(fa && fa.position),
    week_pts: finiteOrNull(typeof weekPointsOf === 'function' ? weekPointsOf(fa, wk) : null),
    ros_pts: finiteOrNull(typeof rosPointsOf === 'function' ? rosPointsOf(fa, wk) : null),
    bye: fa && Number.isFinite(Number(fa.bye)) ? Number(fa.bye) : null,
    availability: fa && fa.availability !== undefined ? fa.availability : null,
  })).filter((r) => r.id && posList.includes(r.position));

  const out = { week: {}, ros: {}, positions: posList };
  for (const pos of posList) {
    const mine = rows.filter((r) => r.position === pos);
    out.week[pos] = [...mine].sort(rankBy('week_pts')).slice(0, cap);
    out.ros[pos] = [...mine].sort(rankBy('ros_pts')).slice(0, cap);
  }
  return out;
}

/**
 * bestFit({ roster, freeAgents, week, profile, feeds, rowsFor, rosRowsFor, lastWeek, limit })
 *   roster:     my roster — a slots map ({ slot: id|null }) or an id array
 *   freeAgents: candidate rows (id / gsis_id is all this reads)
 *   week:       the week in view; the ROS horizon is week..lastWeek (default 18)
 *   profile:    the league profile bestLineup seats by
 *   feeds:      positions with a live feed (K/DEF), as bestLineup's opts.feeds
 *   rowsFor:    (ids, wk) -> [{ id, pos, pts, onBye, playable }] — the SAME rows
 *               the roster card optimises (bye and unavailable weeks 0)
 *   rosRowsFor: optional (ids, week) -> [[rows for week], [rows for week+1], ...];
 *               defaults to rowsFor over every week of the horizon
 * Returns { week: [{ candidate, gain, drop, drop_cost }], ros: [...],
 *           note: { week, ros }, base: { week, ros } }
 *   candidate / drop are ids; gains and costs are rounded to 0.1; a list holds
 *   only candidates whose gain is > 0, sorted gain desc then id asc, capped at
 *   `limit` (default 5). When a list is empty its note says so in words.
 */
export function bestFit({
  roster, freeAgents: fas, week, profile, feeds, rowsFor, rosRowsFor, lastWeek = 18, limit = 5,
} = {}) {
  const wk = Math.max(1, Math.round(Number(week)) || 1);
  const last = Math.max(wk, Math.round(Number(lastWeek)) || wk);
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 5;
  const opts = { feeds: Array.isArray(feeds) ? feeds : [] };
  const mine = rosterIdsOf(roster);
  const rows = typeof rowsFor === 'function' ? rowsFor : () => [];
  const weeksOf = (ids) => (typeof rosRowsFor === 'function'
    ? rosRowsFor(ids, wk)
    : Array.from({ length: last - wk + 1 }, (_, i) => rows(ids, wk + i)));

  /**
   * One horizon, fully evaluated once for MY roster: the per-week optimal
   * lineups, their total, who ever starts, and each player's points over the
   * horizon. Everything below is a delta against this.
   */
  const evalBase = (weekRows) => {
    const lineups = weekRows.map((list) => bestLineup(list, profile, opts));
    const starters = new Set();
    const ptsById = new Map();
    let total = 0;
    lineups.forEach((l, i) => {
      total += l.total;
      for (const s of l.slotIds) if (l.slots[s]) starters.add(l.slots[s]);
      for (const r of (Array.isArray(weekRows[i]) ? weekRows[i] : [])) {
        const id = String(r.id);
        ptsById.set(id, (ptsById.get(id) || 0) + (Number(r.pts) || 0));
      }
    });
    return { rows: weekRows, lineups, total, starters, ptsById };
  };

  /**
   * SOUND PRUNING — the lowest-scoring starter in any projected slot that
   * accepts `pos` this week (−Infinity when such a slot is empty, +Infinity
   * when no slot accepts the position). A candidate at or below that floor
   * cannot raise the week's optimal total, so bestLineup need not be re-run
   * for him: an optimal lineup that used him could swap him for that starter
   * at no loss. Above the floor the real bestLineup decides.
   */
  const floorFor = (l, list, pos) => {
    let floor = Infinity;
    const pts = new Map((Array.isArray(list) ? list : []).map((r) => [String(r.id), Number(r.pts) || 0]));
    for (const g of l.geometry) {
      if (!g.projected || !g.positions.some((p) => canonPosition(p) === pos)) continue;
      const id = l.slots[g.slot];
      if (!id) return -Infinity;
      floor = Math.min(floor, pts.get(id) || 0);
    }
    return floor;
  };

  /**
   * The candidate's rows per week of the horizon, and a SOUND upper bound on
   * his gain: Σ max(0, pts − floor). Adding one player evicts exactly one
   * starter from a slot chain that accepts his position (dedicated-first
   * greedy never lets a flex leftover outrank a dedicated occupant), and that
   * starter scores at least the floor, so the week's gain is at most
   * pts − floor. Infinity when an accepting slot is empty.
   */
  const candidateOf = (base, id, h) => {
    let bound = 0;
    const perWeek = base.lineups.map((l, i) => {
      const row = (h === 'week' ? rows([id], wk) : rows([id], wk + i))[0] || null;
      const pos = canonPosition(row && row.pos);
      const pts = Number(row && row.pts) || 0;
      const floor = row ? floorFor(l, base.rows[i], pos) : Infinity;
      const up = pts > floor ? pts - floor : 0;
      bound += up;
      return { row, up };
    });
    return { id, bound, perWeek };
  };

  /** Total over the horizon with the candidate added — recomputing only the weeks he can change. */
  const totalWith = (base, cand) => {
    let total = 0;
    base.lineups.forEach((l, i) => {
      const { row, up } = cand.perWeek[i];
      if (!row || !(up > 0)) { total += l.total; return; }
      total += bestLineup([...base.rows[i], row], profile, opts).total;
    });
    return total;
  };

  /** Total over the horizon with `id` removed — a week he never started is unchanged. */
  const totalWithout = (base, id) => {
    let total = 0;
    base.lineups.forEach((l, i) => {
      const started = l.slotIds.some((s) => l.slots[s] === id);
      if (!started) { total += l.total; return; }
      total += bestLineup(base.rows[i].filter((r) => String(r.id) !== id), profile, opts).total;
    });
    return total;
  };

  const out = { week: [], ros: [], note: { week: null, ros: null }, base: { week: 0, ros: 0 } };
  const scope = { week: 'this week', ros: 'over the rest of the season' };
  const candidates = (Array.isArray(fas) ? fas : []).map(idOf)
    .filter((id) => id && !mine.includes(id));

  for (const h of ['week', 'ros']) {
    const base = evalBase(h === 'week' ? [rows(mine, wk)] : weeksOf(mine));
    out.base[h] = r1(base.total);

    // The least-cost drop for this horizon, computed once: it does not depend
    // on which candidate comes in. Bench (never starts in the horizon) first —
    // its cost is 0 by construction, so only the points tie-break is needed.
    let drop = null;
    let dropCost = null;
    if (mine.length) {
      // "Bench" = outside the optimal lineup of the week in view (the horizon's
      // first week). Over ROS a bench player may still start on somebody's
      // bye, and that is exactly the cost named beside him.
      const first = base.lineups[0];
      const bench = mine.filter((id) => !first.slotIds.some((s) => first.slots[s] === id));
      const pick = bench.length ? bench : mine;
      let best = null;
      for (const id of pick) {
        const cost = r1(base.total - totalWithout(base, id));
        const pts = base.ptsById.get(id) || 0;
        if (!best || cost < best.cost || (cost === best.cost && (pts < best.pts
          || (pts === best.pts && idAsc(id, best.id) < 0)))) {
          best = { id, cost, pts };
        }
      }
      drop = best.id;
      dropCost = best.cost;
    }

    // Branch and bound: best bound first; once `cap` real gains are in hand
    // and the next bound cannot reach the cap-th of them, nobody behind it
    // can either. Every listed gain is still the exact bestLineup delta.
    const ranked = candidates.map((id) => candidateOf(base, id, h))
      .sort((a, b) => b.bound - a.bound || idAsc(a.id, b.id));
    const gains = [];
    for (const cand of ranked) {
      if (!(cand.bound > 0)) break;
      if (gains.length >= cap) {
        const kth = gains[gains.length - 1].gain;
        if (r1(cand.bound) < kth) break;
      }
      const gain = r1(totalWith(base, cand) - base.total);
      if (gain <= 0) continue;
      gains.push({ candidate: cand.id, gain, drop, drop_cost: dropCost });
      gains.sort((a, b) => b.gain - a.gain || idAsc(a.candidate, b.candidate));
      if (gains.length > cap) gains.length = cap;
    }
    out[h] = gains;
    if (out[h].length === 0) {
      out.note[h] = candidates.length
        ? `Your best lineup already beats every free agent ${scope[h]}`
        : `No free agent to compare ${scope[h]}`;
    }
  }
  return out;
}
