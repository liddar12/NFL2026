/* Pure exposure/risk reader. No pricing, ranking, fetch or hidden model updates. */
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const validProbability = (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

const YARDAGE_MARKETS = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds', 'te_rec_yds']);

function selectionIdentity(leg, game, team) {
  if (!game || typeof leg.selection !== 'string' || !leg.selection.trim()) return null;
  const sideTeam = leg.side === 'home' ? game.home : leg.side === 'away' ? game.away : null;
  if (leg.market === 'moneyline') {
    return (sideTeam == null || sideTeam === team)
      && [game.home, game.away].includes(team) ? [String(game.game_id), leg.market, team] : null;
  }
  const player = leg.gsis_id ?? leg.owner;
  const playerTeam = leg.team ?? sideTeam;
  if ((!YARDAGE_MARKETS.has(leg.market) && leg.market !== 'anytime_td')
      || typeof player !== 'string' || !player.trim() || player.startsWith('team:')
      || typeof playerTeam !== 'string' || ![game.home, game.away].includes(playerTeam)
      || (sideTeam != null && sideTeam !== playerTeam)
      || (YARDAGE_MARKETS.has(leg.market) && !Number.isFinite(leg.line))) return null;
  // Keep exact displayed terms in the identity. An unrecognized direction,
  // differing comparison, or alternate rung must remain a different selection.
  return [String(game.game_id), leg.market, player, playerTeam, leg.line ?? null,
    leg.direction ?? null, leg.comparison_operator ?? null, leg.selection];
}

/** Shared selections reuse one outcome. Only one ML selection per game is modeled.
 * Non-ML/mixed-vintage portfolios still report exposure, never fake independence. */
export function summarizePortfolio(cards, schedule = [], week = null, { estimateJoint = true } = {}) {
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
  const selections = new Map();
  const events = new Map();
  const sets = [];
  let reason = null;
  for (const card of cards) {
    const seen = new Set();
    const selected = new Set();
    const eventIds = [];
    for (const leg of card.legs || []) {
      const team = leg.market === 'moneyline' ? String(leg.selection).replace(/ ML$/, '') : null;
      const matches = teams.get(team);
      const id = leg.game_id ?? card.game_id ?? (matches?.size === 1 ? [...matches][0] : null);
      const key = id != null ? `game:${id}` : `selection:${leg.market}:${leg.selection}`;
      const game = games.get(String(id));
      const identity = selectionIdentity(leg, game, team);
      if (identity != null) {
        const selectionKey = JSON.stringify(identity);
        if (!selected.has(selectionKey)) {
          const shared = selections.get(selectionKey) || { key: selectionKey, label: leg.selection, cards: 0 };
          shared.cards += 1;
          selections.set(selectionKey, shared);
          selected.add(selectionKey);
        }
      }
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
  const selectionExposures = [...selections.values()]
    .sort((a, b) => b.cards - a.cards || a.key.localeCompare(b.key));
  const out = { selectionExposures, cards: cards.length, exposures: rows, maxExposure: rows[0]?.cards || 0,
    pZeroWinners: null, expectedWinners: null, reason };
  if (events.size > 16) out.reason ||= 'event_limit_exceeded';
  if (!estimateJoint || out.reason || !cards.length) return out;
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

function sharedLossText(shared, total) {
  return `<p>If <strong>${esc(shared.label)}</strong> loses, it defeats ${shared.cards} of the ${total} shown cards.</p>`;
}

export function renderGameSelectionRisk(cards, schedule, week) {
  const summary = summarizePortfolio(cards, schedule, week, { estimateJoint: false });
  const shared = summary.selectionExposures[0];
  if (!shared || shared.cards < 2) return '';
  return '<details class="pfilters portfolio-risk game-selection-risk">'
    + `<summary>SHARED SELECTION · ${shared.cards}/${summary.cards} cards</summary>`
    + sharedLossText(shared, summary.cards) + '</details>';
}

export function renderPortfolioRisk(summary) {
  if (!summary || summary.cards < 2 || !summary.exposures.length
      || summary.exposures[0].cards < 2) return '';
  const top = summary.exposures[0];
  const exact = summary.pZeroWinners != null;
  const common = top.cards === summary.cards;
  const shared = summary.selectionExposures?.[0];
  const sharedLoss = !exact && shared?.cards > 1 ? sharedLossText(shared, summary.cards) : '';
  return '<details class="pfilters portfolio-risk">'
    + `<summary>SHARED RISK · ${top.cards}/${summary.cards} share one ${top.kind === 'game' ? 'game' : 'selection'}</summary>`
    + `<p>${esc(top.label)} appears in ${top.cards} of these ${summary.cards} shown cards. `
    + (common && exact ? 'One loss of that shared selection defeats every shown card. '
      : 'These cards are not independent chances. ')
    + 'Different card names do not remove shared exposure.</p>'
    + sharedLoss
    + (exact ? `<p>Model-implied chance of zero winners: ${(100 * summary.pZeroWinners).toFixed(1)}%. `
      + `Expected winners: ${summary.expectedWinners.toFixed(2)} of ${summary.cards}. `
      + 'Assumes independent games, not independent cards; forecast probabilities can be wrong.</p>'
      : '<p>Joint win risk is unavailable for this set; no independence estimate is substituted.</p>')
    + '<p>Exposure warning only: selection has not been diversified.</p></details>';
}
