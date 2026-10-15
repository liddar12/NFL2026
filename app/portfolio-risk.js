/* Pure exposure/risk reader. No pricing, ranking, fetch or hidden model updates. */
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const validProbability = (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

/** Shared selections reuse one outcome. Only one ML selection per game is modeled.
 * Non-ML/mixed-vintage portfolios still report exposure, never fake independence. */
export function summarizePortfolio(cards, schedule = [], week = null) {
  const games = new Map(schedule.filter((g) => week == null || Number(g.week) === Number(week))
    .map((g) => [String(g.game_id), g]));
  const teams = new Map();
  games.forEach((g, id) => {
    [g.home, g.away].forEach((team) => {
      if (!teams.has(team)) teams.set(team, new Set());
      teams.get(team).add(id);
    });
  });
  const exposures = new Map();
  const events = new Map();
  const sets = [];
  let reason = null;
  for (const card of cards) {
    const seen = new Set();
    const eventIds = [];
    for (const leg of card.legs || []) {
      const team = leg.market === 'moneyline' ? String(leg.selection).replace(/ ML$/, '') : null;
      const matches = teams.get(team);
      const id = leg.game_id ?? card.game_id ?? (matches?.size === 1 ? [...matches][0] : null);
      const key = id != null ? `game:${id}` : `selection:${leg.market}:${leg.selection}`;
      const game = games.get(String(id));
      if (!seen.has(key)) {
        const row = exposures.get(key) || { key, kind: game ? 'game' : 'selection',
          label: game ? `${game.away} @ ${game.home}` : String(leg.selection), cards: 0 };
        row.cards += 1;
        exposures.set(key, row);
      } else reason ||= 'multiple_legs_same_game';
      seen.add(key);
      eventIds.push(key);
      if (id == null || !game) reason ||= 'event_identity_unverified';
      if (leg.market !== 'moneyline') reason ||= 'joint_player_outcomes_not_modeled';
      if (leg.market === 'moneyline' && game && ![game.home, game.away].includes(team)) {
        reason ||= 'selection_event_mismatch';
      }
      if (!validProbability(leg.model_prob)) reason ||= 'invalid_probability';
      const prior = events.get(key);
      if (prior && (prior.selection !== leg.selection || prior.probability !== leg.model_prob)) {
        reason ||= 'mixed_probability_vintages_or_opposing_selections';
      }
      events.set(key, { selection: leg.selection, probability: leg.model_prob });
    }
    if (!eventIds.length) reason ||= 'empty_card';
    sets.push(eventIds);
  }
  const rows = [...exposures.values()].sort((a, b) => b.cards - a.cards || a.key.localeCompare(b.key));
  const out = { cards: cards.length, exposures: rows, maxExposure: rows[0]?.cards || 0,
    pZeroWinners: null, expectedWinners: null, reason };
  if (events.size > 16) out.reason ||= 'event_limit_exceeded';
  if (out.reason || !cards.length) return out;
  const keys = [...events.keys()].sort();
  const indices = new Map(keys.map((key, i) => [key, i]));
  const masks = sets.map((ids) => ids.reduce((mask, key) => mask | (1 << indices.get(key)), 0));
  out.expectedWinners = sets.reduce((sum, ids) => sum + ids.reduce((p, key) => p * events.get(key).probability, 1), 0);
  let zero = 0;
  for (let state = 0; state < 2 ** keys.length; state += 1) {
    if (masks.some((mask) => (state & mask) === mask)) continue;
    zero += keys.reduce((p, key, i) => p * ((state & (1 << i))
      ? events.get(key).probability : 1 - events.get(key).probability), 1);
  }
  out.pZeroWinners = zero;
  return out;
}

export function renderPortfolioRisk(summary) {
  if (!summary || summary.cards < 2 || !summary.exposures.length
      || summary.exposures[0].cards < 2) return '';
  const top = summary.exposures[0];
  const exact = summary.pZeroWinners != null;
  const common = top.cards === summary.cards;
  return '<details class="pfilters portfolio-risk">'
    + `<summary>SHARED RISK · ${top.cards}/${summary.cards} share one ${top.kind === 'game' ? 'game' : 'selection'}</summary>`
    + `<p>${esc(top.label)} appears in ${top.cards} of these ${summary.cards} shown cards. `
    + (common && exact ? 'One loss of that shared selection defeats every shown card. '
      : 'These cards are not independent chances. ')
    + 'Different card names do not remove shared exposure.</p>'
    + (exact ? `<p>Model-implied chance of zero winners: ${(100 * summary.pZeroWinners).toFixed(1)}%. `
      + `Expected winners: ${summary.expectedWinners.toFixed(2)} of ${summary.cards}. `
      + 'Assumes independent games, not independent cards; forecast probabilities can be wrong.</p>'
      : '<p>Joint win risk is unavailable for this set; no independence estimate is substituted.</p>')
    + '<p>Exposure warning only: selection has not been diversified.</p></details>';
}
