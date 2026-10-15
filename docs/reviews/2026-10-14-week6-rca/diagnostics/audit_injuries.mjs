import fs from 'node:fs';
import childProcess from 'node:child_process';

// Read-only reproduction: fetch the public source and compare with fixed Git files.
// It does not invoke a builder, alter data/, or publish anything.
const repo = process.argv[2];
if (!repo) throw new Error('Usage: node audit_injuries.mjs AUDITED_CHECKOUT');
const source = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const read = name => JSON.parse(fs.readFileSync(`${repo}/data/${name}.json`, 'utf8'));
const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const current = await response.json();
const statusCounts = {};
const freshById = new Map();
const noId = [];
const unknown = [];
const known = new Set(['Active', 'Questionable', 'Doubtful', 'Out', 'Injured Reserve', 'Suspension',
  'Physically Unable To Perform', 'Non-Football Injury']);
function athleteId(athlete) {
  if (athlete.id) return String(athlete.id);
  const ids = new Set();
  for (const link of athlete.links || []) {
    const match = String(link.href || '').match(/espn\.com\/nfl\/player\/.*?\/id\/(\d+)(?:\/|$)/);
    if (match) ids.add(match[1]);
  }
  if (ids.size !== 1) return null;
  return [...ids][0];
}
for (const group of current.injuries || []) {
  for (const item of group.injuries || []) {
    const athlete = item.athlete || {};
    const id = athleteId(athlete);
    const status = typeof item.status === 'object' ? item.status.name : item.status;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const row = { espn_id: id, name: athlete.displayName, team: athlete.team?.abbreviation || group.displayName,
      status, item_date: item.date || null, status_type: item.type?.name || null };
    if (!id) noId.push(row);
    else {
      if (freshById.has(id)) throw new Error(`Duplicate athlete id ${id}`);
      freshById.set(id, row);
    }
    if (!known.has(status)) unknown.push(row);
  }
}
const weekly = read('player_weekly');
const players = new Map(read('player_projections').players.map(p => [p.gsis_id, p]));
const oldInjuries = read('injuries');
const statusGates = weekly.players.filter(p => p.this_week?.reason === 'status').map(p => {
  const projection = players.get(p.gsis_id);
  const espn = p.gsis_id.startsWith('espn-') ? p.gsis_id.slice(5) : null;
  const now = freshById.get(espn);
  return { gsis_id: p.gsis_id, name: projection?.name, team: projection?.team,
    old_status: p.this_week.status, now: now || null,
    changed_to_policy_playable: now ? ['Active', 'Questionable'].includes(now.status) : false };
});
const output = {
  checked_utc: new Date().toISOString(),
  git_sha: childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  source_url: source, http_status: response.status, source_timestamp: current.timestamp,
  groups: current.injuries?.length, status_counts: statusCounts, unknown_status_rows: unknown,
  matching: 'ESPN athlete.id or a unique ESPN player URL /id/ value; no name-only matches',
  missing_source_id_count: noId.length,
  retained_report_utc: oldInjuries.updated_utc, weekly_generated_utc: weekly.updated_utc,
  week: weekly.model.this_week.wk, status_gate_count: statusGates.length,
  id_matches: statusGates.filter(p => p.now).length,
  changed_to_policy_playable: statusGates.filter(p => p.changed_to_policy_playable),
  changed_to_active: statusGates.filter(p => p.now?.status === 'Active'),
  all_status_gates: statusGates,
  caveat: 'Questionable is playable under this app policy, not a guarantee of playing. Source checked later than the fixed Git build; figures document ongoing blocked refresh, not all changes necessarily known at build time.'
};
console.log(JSON.stringify(output, null, 2));
