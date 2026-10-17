// Test oracle, not a production eligibility implementation. Legacy pools retain
// the full scheduled-team floor. The only selected-policy exception is an
// already FINAL game, independently identified by the schedule and generation
// clock, whose exact 90-minute metadata holds every known yardage identity.
// A missing future team is never excused by whatever happens to survive a pool.
import assert from 'node:assert/strict';
import { poolLearningStatus } from '../../app/pool-learning-status.js';

const PROP = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']);

export function assertScheduledSeedCoverage(pool, games, excluded, projections, seeds) {
  const weekGames = games.filter((g) => Number(g.week) === Number(pool.week));
  const excludedIds = new Set(excluded.filter((g) => Number(g.season) === Number(pool.season)
    && Number(g.week) === Number(pool.week)).map((g) => String(g.game_id)));
  const all = new Set(weekGames.flatMap((g) => [g.home, g.away]));
  const required = new Set(weekGames.filter((g) => !excludedIds.has(String(g.game_id)))
    .flatMap((g) => [g.home, g.away]));
  const generated = Date.parse(pool.generated_utc);
  const status = poolLearningStatus(pool, generated);
  const metadata = pool.freshness_policy;
  const exemptIds = new Set();
  if (metadata?.profile === 'provisional_before_90m_v1' && !status.freshnessInvalid) {
    for (const game of weekGames) {
      const kick = Date.parse(game.kickoff_utc);
      if (game.status !== 'STATUS_FINAL' || !Number.isFinite(kick) || kick > generated) continue;
      const row = metadata.games.find((r) => r.game_id === String(game.game_id));
      const roster = projections.filter((p) => [game.home, game.away].includes(p.team)
        && ['QB', 'RB', 'WR', 'TE'].includes(p.position));
      if (!row || row.state !== 'held' || Date.parse(row.check_due_utc) !== kick - 90 * 60000
        || !status.blockedGameIds.includes(String(game.game_id)) || !roster.length
        || !roster.every((p) => row.blocked_player_ids.includes(p.gsis_id))
        || (pool.players || []).some((p) => PROP.has(p.market) && String(p.game_id) === String(game.game_id))) continue;
      exemptIds.add(String(game.game_id));
    }
  }
  required.clear();
  for (const game of weekGames) if (!excludedIds.has(String(game.game_id)) && !exemptIds.has(String(game.game_id))) {
    required.add(game.home); required.add(game.away);
  }
  const actual = new Set(seeds.map((s) => s.name));
  assert.deepEqual([...required].filter((team) => !actual.has(team)).sort(), [],
    'every required scheduled team must retain a seed; only source-bound FINAL held games are exempt');
  assert.deepEqual([...actual].filter((team) => !all.has(team)).sort(), [],
    'a pool must not invent a team outside this week\'s schedule');
  return required;
}
