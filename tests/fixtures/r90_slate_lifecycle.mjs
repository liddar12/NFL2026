// Fixed G04 scenarios: review intentionally has no row for an unplayed game.
// Daily data may be mixed, entirely FINAL, or already rolled to the next week.
export function slateLifecycle(phase = 'mixed') {
  if (!['mixed', 'closed', 'rollover'].includes(phase)) throw new Error(`Unknown phase: ${phase}`);
  const game = (game_id, home, away, week, status, homeProb) => ({
    game_id, home, away, week, status, kickoff_utc: week === 6 ? '2026-10-18T17:00Z' : '2026-10-25T17:00Z',
    roof: 'outdoor', venue: 'Fixture Stadium', probs: { home: homeProb, away: 1 - homeProb },
    model: 'elo_prior', estimate: true,
  });
  const games = [game('r90-final', 'BUF', 'DET', 6, 'STATUS_FINAL', .69),
    game('r90-open', 'SEA', 'NE', 6, phase === 'mixed' ? 'STATUS_SCHEDULED' : 'STATUS_FINAL', .58),
    game('r90-next', 'SF', 'DAL', 7, 'STATUS_SCHEDULED', .61)];
  const receipt = (g) => ({ game_id: g.game_id, home: g.home, away: g.away,
    status: g.status, picked: g.home, pick_prob: .65, result: 'won',
    final: { home_score: 24, away_score: 17 },
    why: { reasons: [{ factor: 'confidence', text: 'lock 2026-10-15T10:00:00Z' }] } });
  const week = phase === 'rollover' ? 7 : 6;
  return {
    predictions: { season: 2026, week, updated_utc: '2026-10-20T04:00:00Z', games: games.filter(g => g.week === week) },
    schedule: { season: 2026, games },
    review: { season: 2026, weeks: { '6': { games: games.filter(g => g.week === 6 && g.status === 'STATUS_FINAL').map(receipt) }, '7': { games: [] } } },
  };
}
