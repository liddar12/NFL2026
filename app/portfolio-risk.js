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

const identity = (v) => (typeof v === 'string' && v.trim() !== ''
  || typeof v === 'number' && Number.isFinite(v)) ? String(v) : null;
const text = (v) => typeof v === 'string' && v.trim() !== '';
const PROP_MARKETS = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds', 'anytime_td']);

/** Counts only. Repeated contracts and shared games are different quantities.
 * Missing/conflicting identity never becomes a shared "unknown" event, and
 * these counts do not estimate the joint distribution of player outcomes. */
export function summarizeConcentration(cards, schedule = [], week = null) {
  const games = new Map();
  const conflicts = new Set();
  for (const game of schedule) {
    if (!game || week != null && Number(game.week) !== Number(week)) continue;
    const id = identity(game.game_id);
    if (!id || !text(game.home) || !text(game.away) || game.home === game.away) continue;
    const prior = games.get(id);
    if (prior && (prior.home !== game.home || prior.away !== game.away)) conflicts.add(id);
    games.set(id, game);
  }
  conflicts.forEach((id) => games.delete(id));
  const teams = new Map();
  games.forEach((game, id) => [game.home, game.away].forEach((team) => {
    if (!teams.has(team)) teams.set(team, new Set());
    teams.get(team).add(id);
  }));
  const selections = new Map(), events = new Map();
  let unverifiedGames = 0, unverifiedSelections = 0;
  const add = (rows, seen, key, label) => {
    if (seen.has(key)) return;
    seen.add(key);
    const row = rows.get(key) || {key, label, cards: 0};
    row.cards += 1;
    rows.set(key, row);
  };
  for (const card of cards) {
    const seenGames = new Set(), seenSelections = new Set();
    for (const leg of card.legs || []) {
      const ml = leg.market === 'moneyline' && text(leg.selection)
        ? leg.selection.match(/^(.+) ML$/)?.[1] : null;
      const candidates = teams.get(ml);
      const inferred = candidates?.size === 1 ? [...candidates][0] : null;
      const id = identity(leg.game_id ?? card.game_id ?? inferred);
      const conflict = leg.game_id != null && card.game_id != null
        && identity(leg.game_id) !== identity(card.game_id);
      const game = !conflict && games.get(id);
      if (!game || leg.market === 'moneyline' && ![game.home, game.away].includes(ml)) {
        unverifiedGames += 1; unverifiedSelections += 1; continue;
      }
      add(events, seenGames, id, `${game.away} @ ${game.home}`);
      const owner = identity(leg.gsis_id ?? leg.owner);
      const prop = PROP_MARKETS.has(leg.market);
      const numericLine = typeof leg.line === 'number' && Number.isFinite(leg.line);
      const lineOk = (leg.line == null || numericLine)
        && (!prop || leg.market === 'anytime_td' || numericLine);
      const ownerConflict = leg.gsis_id != null && leg.owner != null
        && identity(leg.gsis_id) !== identity(leg.owner);
      if (!text(leg.selection) || !['moneyline', 'spread', ...PROP_MARKETS].includes(leg.market)
          || !lineOk || prop && (!owner || owner.startsWith('team:') || ownerConflict)) {
        unverifiedSelections += 1; continue;
      }
      // Keep different lines, markets, players and events distinct, even when
      // their abbreviated display text happens to match. No receipt is edited.
      const key = JSON.stringify([id, leg.market, prop ? owner : null,
        leg.line ?? null, leg.selection]);
      add(selections, seenSelections, key, `${leg.selection} · ${game.away} @ ${game.home}`);
    }
  }
  const sorted = (rows) => [...rows.values()].sort((a, b) => b.cards - a.cards || a.key.localeCompare(b.key));
  return {cards: cards.length, selections: sorted(selections), games: sorted(events),
    unverifiedGames, unverifiedSelections};
}

export function renderConcentrationRisk(summary) {
  if (!summary || summary.cards < 2) return '';
  const legs = summary.selections.filter((row) => row.cards > 1);
  const games = summary.games.filter((row) => row.cards > 1);
  if (!legs.length && !games.length && !summary.unverifiedSelections && !summary.unverifiedGames) return '';
  const top = legs[0] || games[0];
  const rows = (values) => values.slice(0, 3).map((row) =>
    `<li>${row.cards}/${summary.cards}: ${esc(row.label)}</li>`).join('');
  return '<details class="pfilters portfolio-concentration">'
    + '<summary class="pf-sum">SHARED EXPOSURE · '
    + (top ? `${top.cards}/${summary.cards} share one ${legs.length ? 'selection' : 'game'}` : 'identity incomplete')
    + '</summary>'
    + (legs.length ? '<p>Repeated selections (up to three largest):</p><ul>' + rows(legs) + '</ul>'
      + `<p>One loss of the most repeated selection defeats ${legs[0].cards} of these ${summary.cards} shown cards.</p>`
      : '<p>No repeated selection could be verified in this set.</p>')
    + (games.length ? '<p>Shared games (up to three largest):</p><ul>' + rows(games) + '</ul>'
      + '<p>A shared game is not necessarily a shared selection or one common losing result.</p>' : '')
    + (summary.unverifiedSelections || summary.unverifiedGames
      ? `<p>Identity incomplete for ${summary.unverifiedSelections} selection occurrence(s) and ${summary.unverifiedGames} game occurrence(s); exposure may be understated.</p>` : '')
    + '<p>Counts overlap; do not add them. No joint win probability or independent-card estimate is inferred. '
    + 'Exposure warning only: ranking and prices are unchanged; selection has not been diversified.</p></details>';
}

/** Clear before every repaint, including empty seeds and unavailable cards. */
export function paintConcentrationRisk(host, cards, schedule = [], week = null) {
  if (!host) return;
  const html = renderConcentrationRisk(summarizeConcentration(cards, schedule, week));
  host.innerHTML = html;
  host.hidden = !html;
}
