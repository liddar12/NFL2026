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
 */

export const LINEUP_SLOTS = Object.freeze(['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX']);
const FLEX_POS = ['RB', 'WR', 'TE'];

/**
 * Optimal legal starting lineup for one week.
 *   players: [{ id, pos, pts, onBye?, playable? }] — pts is THIS week's
 *            projection; a bye (or a missing projection) should arrive as pts 0 /
 *            onBye true. `playable: false` means the player CANNOT play this week
 *            (IR/PUP/NFI/suspended/ruled out) and demotes him below every
 *            available candidate for the same slot.
 * Returns { slots:{slot->id|null}, bench:[id], total, warnings:[{slot,id,reason}] }.
 * `warnings` is additive and empty in the all-available case.
 */
export function bestLineup(players) {
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
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
  const takeBest = (pos) => {
    for (const c of byPos[pos]) if (!used.has(c.id)) { used.add(c.id); return c.id; }
    return null;
  };
  const slots = {
    QB1: takeBest('QB'),
    RB1: takeBest('RB'),
    RB2: takeBest('RB'),
    WR1: takeBest('WR'),
    WR2: takeBest('WR'),
    TE1: takeBest('TE'),
  };
  // FLEX: best still-unused player across RB/WR/TE (each pos array is sorted, so
  // the first unused entry per position is that position's best leftover). The
  // cross-position comparison uses the SAME (availability, points) tuple as the
  // sort — comparing on points alone here would let an unavailable 12.4 take FLEX
  // over an available 4.0, which is the F3 defect wearing a different hat.
  let flexId = null;
  let flexUn = 2;
  let flexPts = -Infinity;
  for (const pos of FLEX_POS) {
    for (const c of byPos[pos]) {
      if (!used.has(c.id)) {
        if (c.un < flexUn || (c.un === flexUn && c.pts > flexPts)) {
          flexUn = c.un; flexPts = c.pts; flexId = c.id;
        }
        break;
      }
    }
  }
  if (flexId) used.add(flexId);
  slots.FLEX = flexId;

  // A filled slot holding an unavailable player means no available candidate was
  // left for it. Never silent — the view turns each of these into a banner.
  const warnings = [];
  for (const slot of LINEUP_SLOTS) {
    const id = slots[slot];
    if (id && unById.get(id) === 1) {
      warnings.push({ slot, id, reason: 'no_available_alternative' });
    }
  }

  const ptsById = new Map((Array.isArray(players) ? players : []).map((p) => [String(p.id), Number(p.pts) || 0]));
  const total = LINEUP_SLOTS.reduce((s, slot) => s + (slots[slot] ? ptsById.get(slots[slot]) || 0 : 0), 0);
  const bench = (Array.isArray(players) ? players : [])
    .filter((p) => !used.has(String(p.id)))
    .map((p) => String(p.id));
  return { slots, bench, total: Math.round(total * 10) / 10, warnings };
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
 */
export function startSitSwaps(currentStarterIds, players, week) {
  const ptsById = new Map((Array.isArray(players) ? players : [])
    .map((p) => [String(p.id), Number(p.pts) || 0]));
  const optimal = bestLineup(players);
  const optimalIds = new Set(LINEUP_SLOTS.map((s) => optimal.slots[s]).filter(Boolean));
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
  return true;
}
