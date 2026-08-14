/* tests/perf/seed.mjs — build a realistic full 13-slot roster string.
 *
 * WHY: an untouched install has an EMPTY roster, and both #/team and #/lineup
 * short-circuit on that (lineup paints an empty state, team paints a finder with
 * no seated players). Measuring only the empty state would understate the two
 * routes this RCA exists to profile. This produces the localStorage payload for
 * nfl2026.team.v1 with every DEFAULT_PROFILE slot filled by a real, correctly
 * positioned player from data/player_projections.json + data/kdst_projections.json.
 *
 * Reads the shipped contracts directly (node fs) — no fabricated ids.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function buildRoster(fill = 13) {
  const proj = JSON.parse(readFileSync(resolve(ROOT, 'data/player_projections.json'), 'utf8'));
  let kdst = { players: [] };
  try { kdst = JSON.parse(readFileSync(resolve(ROOT, 'data/kdst_projections.json'), 'utf8')); } catch (_) {}

  const byPos = {};
  for (const p of proj.players) (byPos[String(p.position).toUpperCase()] ||= []).push(p);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.proj_points - a.proj_points);
  const kd = {};
  for (const p of (kdst.players || [])) {
    const pos = String(p.position).toUpperCase();
    (kd[pos] ||= []).push(p);
  }
  for (const k of Object.keys(kd)) kd[k].sort((a, b) => (b.proj_points || 0) - (a.proj_points || 0));

  const used = new Set();
  const take = (pos) => {
    const src = byPos[pos] || kd[pos] || (pos === 'DEF' ? kd.DST : null) || [];
    for (const p of src) {
      const id = String(p.gsis_id);
      if (!used.has(id)) { used.add(id); return id; }
    }
    return null;
  };
  // DEFAULT_ROSTER_POSITIONS -> rosterSlots() slot names (app/league.js).
  const plan = [
    ['QB1', 'QB'], ['RB1', 'RB'], ['RB2', 'RB'], ['WR1', 'WR'], ['WR2', 'WR'],
    ['TE1', 'TE'], ['FLEX', 'WR'], ['K1', 'K'], ['DEF1', 'DEF'],
    ['BN1', 'RB'], ['BN2', 'WR'], ['BN3', 'QB'], ['BN4', 'TE'], ['BN5', 'RB'], ['BN6', 'WR'],
  ];
  const slots = {};
  let n = 0;
  for (const [slot, pos] of plan) {
    if (n >= fill) break;
    const id = take(pos);
    if (id) { slots[slot] = id; n += 1; }
  }
  return { slots };
}

/** ~40 mid-round ids marked TAKEN by other managers (draft-board state). */
export function buildTaken(skipIds) {
  const proj = JSON.parse(readFileSync(resolve(ROOT, 'data/player_projections.json'), 'utf8'));
  const out = [];
  for (const p of proj.players.slice(20, 90)) {
    const id = String(p.gsis_id);
    if (!skipIds.has(id)) out.push(id);
    if (out.length >= 40) break;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = buildRoster();
  console.log(JSON.stringify(r, null, 1));
  console.log('slots filled:', Object.values(r.slots).filter(Boolean).length);
}
