/* app/lineup.js — pure weekly START/SIT lineup optimizer (no DOM/fetch at import).
 *
 * Phase 1 of the in-season roadmap. Given a roster's players and each player's
 * projected points for ONE week, compute the optimal legal starting lineup and
 * the start/sit swaps versus the manager's current starters. Pure and
 * unit-tested (tests/feature/lineup.test.mjs); the view feeds it week-specific
 * projections from the committed contracts. Projections only — no betting line.
 *
 * Lineup shape mirrors the Team builder's STARTER_SLOTS: QB1 · RB1 · RB2 · WR1 ·
 * WR2 · TE1 · FLEX (FLEX takes the best remaining RB/WR/TE). Greedy dedicated-
 * first assignment is provably optimal for this shape: every dedicated slot must
 * be filled by its own position, and FLEX takes the best flex-eligible leftover,
 * so no reassignment can raise the total.
 *
 * REL17 — AVAILABILITY (F3). A row may carry `playable: false` (IR / PUP / NFI /
 * suspended / ruled out). Such a row ranks BELOW every available row for the same
 * slot regardless of points, so an available 4.0 beats an unavailable 12.4. That
 * is DEMOTION, not exclusion, and the difference is deliberate: if a manager has
 * no available RB at all, the slot is still filled — by the unavailable player —
 * and a WARNING is emitted so the view can say so out loud. Silently emptying the
 * slot, or silently starting him, are both dishonest. `playable` is read as
 * STRICTLY `=== false`, so every existing call site (which never sets it) sorts
 * and totals exactly as before.
 *
 * R19-B5 — THE LEAGUE'S REAL SLOTS, INCLUDING THE UNPROJECTED ONES. The lineup
 * is no longer frozen at seven slots: geometry comes from the connected league
 * profile (app/league.js), so a 9-starter league gets QB/RB/RB/WR/WR/TE/FLEX/K/DEF.
 * K and DEF have NO projection feed yet (data/player_projections.json carries
 * QB/RB/WR/TE only — see PROJECTED_POSITIONS). Those slots are therefore:
 *   - RETURNED, never omitted. A lineup that is quietly 7 slots long when the
 *     league starts 9 is a wrong answer wearing a right answer's clothes.
 *   - EMPTY (id null) and worth NOTHING toward `total` — never a fabricated 0.0
 *     that a manager could read as "my kicker is projected for zero".
 *   - WARNED about, through the SAME `warnings` channel as a forced start but
 *     under a DISTINCT reason code (WARN_NO_PROJECTION vs WARN_FORCED_UNAVAILABLE):
 *     "we cannot project this slot" and "you are forced to start someone who
 *     cannot play" are different facts and must never collapse into one.
 * `projectedSlots` / `slotCount` let the view state the coverage out loud
 * ("7 of 9 slots projected") instead of implying a complete lineup.
 * Omit `profile` entirely and the geometry is DEFAULT_PROFILE's — byte-for-byte
 * the seven slots this module has always returned, with zero new warnings.
 */

import {
  normalizeProfile, rosterSlots, slotToken, slotEligiblePositions, FLEX_ELIGIBILITY,
} from './league.js';

export const LINEUP_SLOTS = Object.freeze(['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX']);

/**
 * Positions the projection model actually covers. Mirrors app/team-logic.js's
 * MODELED list and the contents of data/player_projections.json. K / DEF / DST
 * are deliberately absent: no feed exists yet, and inventing one is fabrication.
 */
export const PROJECTED_POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);

/** Does the projection model cover this position at all? */
export function isProjectedPosition(pos) {
  return PROJECTED_POSITIONS.includes(String(pos == null ? '' : pos).toUpperCase());
}

/**
 * The two warning reasons, exported so the view and the tests share one spelling.
 * They are SEPARATE codes on purpose — see the R19-B5 note above. Never widen one
 * to cover the other's case.
 */
/** A slot filled by a player who cannot play, because nobody else could fill it. */
export const WARN_FORCED_UNAVAILABLE = 'no_available_alternative';
/** A real league slot whose position has no projection feed yet (K / DEF / DST). */
export const WARN_NO_PROJECTION = 'no_projection_feed';

/**
 * Canonical scan order for a multi-position (flex) slot. Only exact ties are
 * decided here, and this order reproduces the pre-R19-B5 FLEX scan (RB, WR, TE)
 * exactly, so a legacy tie still resolves the way it always has.
 */
const FLEX_SCAN_ORDER = ['RB', 'WR', 'TE', 'QB'];

/**
 * The starting slots of a league, as data:
 *   [{ slot, token, positions:[POS], flex:bool, projected:bool }]
 * `projected` is false when NO eligible position has a projection feed — a K or
 * DEF slot. Pass nothing for the historical seven-slot geometry.
 */
export function lineupGeometry(profile) {
  const p = normalizeProfile(profile);
  return rosterSlots(p).starters.map((slot) => {
    const token = slotToken(slot, p);
    const positions = slotEligiblePositions(slot, p);
    return {
      slot,
      token,
      positions,
      flex: Boolean(FLEX_ELIGIBILITY[token]),
      projected: positions.some(isProjectedPosition),
    };
  });
}

/**
 * Optimal legal starting lineup for one week.
 *   players: [{ id, pos, pts, onBye?, playable? }] — pts is THIS week's
 *            projection; a bye (or a missing projection) should arrive as pts 0 /
 *            onBye true. `playable: false` means the player CANNOT play this week
 *            (IR/PUP/NFI/suspended/ruled out) and demotes him below every
 *            available candidate for the same slot.
 *   profile: the connected LeagueProfile (app/league.js). Omitted -> DEFAULT.
 * Returns { slots:{slot->id|null}, bench:[id], total, warnings:[{slot,id,reason}],
 *           geometry, slotIds, projectedSlots, slotCount }.
 * `warnings` is additive and empty for the default geometry with everyone available.
 */
export function bestLineup(players, profile) {
  const geometry = lineupGeometry(profile);
  const byPos = {};
  for (const pos of PROJECTED_POSITIONS) byPos[pos] = [];
  for (const p of (Array.isArray(players) ? players : [])) {
    const pos = String(p.pos || '').toUpperCase();
    // `un` = 1 when the player cannot play. STRICT === false: an absent flag (an
    // older caller, or a deploy before the availability feed) is treated as
    // available, which is exactly today's behaviour.
    if (byPos[pos]) {
      byPos[pos].push({ id: String(p.id), pts: Number(p.pts) || 0, un: p.playable === false ? 1 : 0 });
    }
  }
  for (const k of Object.keys(byPos)) {
    // Availability first, then points, then id — an available 4.0 outranks an
    // unavailable 12.4 (a partly-parsed duration can still carry points).
    byPos[k].sort((a, b) => a.un - b.un || b.pts - a.pts || (a.id < b.id ? -1 : 1));
  }
  const used = new Set();
  const unById = new Map();
  for (const k of Object.keys(byPos)) for (const c of byPos[k]) unById.set(c.id, c.un);

  /**
   * Best still-unused candidate across `positions` (each byPos array is sorted,
   * so the first unused entry per position is that position's best leftover).
   * The cross-position comparison uses the SAME (availability, points) tuple as
   * the sort — comparing on points alone would let an unavailable 12.4 take FLEX
   * over an available 4.0, which is the F3 defect wearing a different hat. For a
   * dedicated one-position slot this is exactly the old single-position scan.
   */
  const takeBest = (positions) => {
    const scan = FLEX_SCAN_ORDER.filter((pos) => positions.includes(pos));
    let best = null;
    for (const pos of scan) {
      const list = byPos[pos];
      if (!list) continue;
      const c = list.find((x) => !used.has(x.id));
      if (!c) continue;
      if (!best || c.un < best.un || (c.un === best.un && c.pts > best.pts)) best = c;
    }
    if (best) used.add(best.id);
    return best ? best.id : null;
  };

  // Dedicated slots first, then flex: every dedicated slot must be filled by its
  // own position and flex takes the best eligible leftover, so no reassignment
  // can raise the total. Unprojected slots (K/DEF) are filled by nobody — there
  // is no feed to fill them from — but they still exist, so they still render.
  const slots = {};
  for (const g of geometry) if (g.projected && !g.flex) slots[g.slot] = takeBest(g.positions);
  for (const g of geometry) if (g.projected && g.flex) slots[g.slot] = takeBest(g.positions);
  for (const g of geometry) if (!g.projected) slots[g.slot] = null;

  // Two DISTINCT facts on one channel. A filled slot holding an unavailable
  // player means no available candidate was left for it; an unprojected slot
  // means the league starts a position this app cannot yet project. The view
  // turns the first into a waiver-wire banner and the second into an
  // "awaiting its feed" row — they must never be conflated.
  const warnings = [];
  for (const g of geometry) {
    if (!g.projected) {
      warnings.push({ slot: g.slot, id: null, reason: WARN_NO_PROJECTION });
      continue;
    }
    const id = slots[g.slot];
    if (id && unById.get(id) === 1) {
      warnings.push({ slot: g.slot, id, reason: WARN_FORCED_UNAVAILABLE });
    }
  }

  const ptsById = new Map((Array.isArray(players) ? players : []).map((p) => [String(p.id), Number(p.pts) || 0]));
  const total = geometry.reduce(
    (s, g) => s + (slots[g.slot] ? ptsById.get(slots[g.slot]) || 0 : 0), 0,
  );
  const bench = (Array.isArray(players) ? players : [])
    .filter((p) => !used.has(String(p.id)))
    .map((p) => String(p.id));
  return {
    slots,
    bench,
    total: Math.round(total * 10) / 10,
    warnings,
    geometry,
    slotIds: geometry.map((g) => g.slot),
    projectedSlots: geometry.filter((g) => g.projected).length,
    slotCount: geometry.length,
  };
}

/**
 * Start/sit changes vs the manager's CURRENT starters. Returns the players to
 * START (in the optimal lineup, currently benched) and to SIT (currently
 * starting, out of the optimal lineup), plus the HONEST net weekly gain of
 * switching the whole lineup to optimal — not a misleading 1:1 pairing (a WR
 * entering and an RB leaving aren't a head-to-head swap; only the net matters).
 *   { start:[id], sit:[id], netGain, optimal, week }
 *
 * `playable` rides through to bestLineup unchanged, so `start` can never contain
 * an unavailable id while an available alternative exists. That is the literal F3
 * defect, and it is locked as a test assertion.
 *
 * An unprojected slot (K/DEF) holds nobody, so it can never produce a START and
 * never contributes to `netGain`: this surface only ever claims points it can
 * actually project.
 */
export function startSitSwaps(currentStarterIds, players, week, profile) {
  const ptsById = new Map((Array.isArray(players) ? players : [])
    .map((p) => [String(p.id), Number(p.pts) || 0]));
  const optimal = bestLineup(players, profile);
  const optimalIds = new Set(optimal.slotIds.map((s) => optimal.slots[s]).filter(Boolean));
  const current = (Array.isArray(currentStarterIds) ? currentStarterIds : []).map(String);
  const currentSet = new Set(current);
  const start = [...optimalIds].filter((id) => !currentSet.has(id));
  const sit = current.filter((id) => !optimalIds.has(id));
  const currentTotal = current.reduce((s, id) => s + (ptsById.get(id) || 0), 0);
  const netGain = Math.round((optimal.total - currentTotal) * 10) / 10;
  return { start, sit, netGain, optimal, week: Number(week) || null };
}

/** Tiny self-check (called by the unit test). */
export function __selftest() {
  const players = [
    { id: 'qb1', pos: 'QB', pts: 20 },
    { id: 'rb1', pos: 'RB', pts: 18 }, { id: 'rb2', pos: 'RB', pts: 14 }, { id: 'rb3', pos: 'RB', pts: 12 },
    { id: 'wr1', pos: 'WR', pts: 16 }, { id: 'wr2', pos: 'WR', pts: 10 },
    { id: 'te1', pos: 'TE', pts: 8 },
    { id: 'rbBye', pos: 'RB', pts: 0, onBye: true },
  ];
  const l = bestLineup(players);
  // FLEX should take rb3 (12) — the best leftover flex-eligible — over wr2(10)/te leftovers.
  if (l.slots.FLEX !== 'rb3') throw new Error('FLEX picks best leftover');
  if (l.slots.QB1 !== 'qb1' || l.slots.RB1 !== 'rb1' || l.slots.RB2 !== 'rb2') throw new Error('dedicated slots');
  if (l.total !== 20 + 18 + 14 + 16 + 10 + 8 + 12) throw new Error('total');
  // 8 players, 7 start (rb3 flexes) -> only the bye RB is benched.
  if (l.bench.length !== 1 || !l.bench.includes('rbBye')) throw new Error('bench remainder');
  // Start/sit: manager wrongly starts rbBye (0) over rb3 (12) at FLEX.
  const ss = startSitSwaps(['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'rbBye'], players, 5);
  if (!ss.start.includes('rb3') || !ss.sit.includes('rbBye') || ss.netGain !== 12) {
    throw new Error('start/sit net gain');
  }
  if (l.warnings.length !== 0) throw new Error('no warnings when everyone is available');

  // REL17 — an unavailable 12.4 must lose his slot to an available 4.0.
  const hurt = [
    { id: 'qbA', pos: 'QB', pts: 20 },
    { id: 'rbIR', pos: 'RB', pts: 12.4, playable: false }, { id: 'rbOk', pos: 'RB', pts: 4 },
    { id: 'wrA', pos: 'WR', pts: 15 }, { id: 'wrB', pos: 'WR', pts: 11 },
    { id: 'teA', pos: 'TE', pts: 7 },
  ];
  const h = bestLineup(hurt);
  if (h.slots.RB1 !== 'rbOk') throw new Error('available RB outranks the unavailable one');
  // Only two RBs and one cannot play: RB2 is FORCED, filled and flagged, never empty.
  if (h.slots.RB2 !== 'rbIR') throw new Error('forced slot is filled, not emptied');
  if (h.warnings.length !== 1 || h.warnings[0].slot !== 'RB2' || h.warnings[0].id !== 'rbIR') {
    throw new Error('forced start emits exactly one warning');
  }
  // FLEX must compare on the tuple too, not on points alone.
  const flex = bestLineup([
    { id: 'qbA', pos: 'QB', pts: 20 },
    { id: 'rbA', pos: 'RB', pts: 18 }, { id: 'rbB', pos: 'RB', pts: 16 },
    { id: 'wrA', pos: 'WR', pts: 15 }, { id: 'wrB', pos: 'WR', pts: 11 },
    { id: 'teA', pos: 'TE', pts: 7 },
    { id: 'wrIR', pos: 'WR', pts: 12.4, playable: false }, { id: 'teOk', pos: 'TE', pts: 4 },
  ]);
  if (flex.slots.FLEX !== 'teOk') throw new Error('FLEX prefers an available player');
  if (flex.warnings.length !== 0) throw new Error('a benched unavailable player is not a warning');

  // R19-B5 — a 9-starter K/DEF league. Both extra slots exist, hold nobody, are
  // worth nothing, and say why. The seven projected slots are untouched.
  const nine = bestLineup(players, KDEF_PROFILE);
  if (nine.slotCount !== 9 || nine.projectedSlots !== 7) throw new Error('nine slots, seven projected');
  if (nine.slots.K1 !== null || nine.slots.DEF1 !== null) throw new Error('unprojected slots hold nobody');
  if (nine.total !== l.total) throw new Error('an unprojected slot adds no points');
  const unproj = nine.warnings.filter((w) => w.reason === WARN_NO_PROJECTION).map((w) => w.slot);
  if (unproj.length !== 2 || unproj[0] !== 'K1' || unproj[1] !== 'DEF1') {
    throw new Error('both unprojected slots warn');
  }
  if (nine.warnings.some((w) => w.reason === WARN_FORCED_UNAVAILABLE)) {
    throw new Error('an unprojected slot is not a forced start');
  }
  return true;
}

/** A 9-starter league (QB RB RB WR WR TE FLEX K DEF + 6 bench) for __selftest. */
const KDEF_PROFILE = {
  shape: {
    roster_positions: [
      'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
      'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
    ],
  },
};
