/* app/views/myparlays.js — MY PARLAYS: cards built around players you name.
 *
 * Loaded ONLY when the MY chip in the PARLAYS scope control is tapped, by a
 * dynamic import from app/views/parlays.js. Neither this module nor the ~294 KB
 * leg pool it reads is on the boot graph, and a user who never taps MY never
 * pays for either. That is also why this is a mode inside PARLAYS rather than
 * its own route: a new route costs 644 bytes on a boot graph with 33 to spare,
 * and the feature does not need its own address badly enough to spend the
 * ceiling that has held since R73.
 *
 * WHAT IT DOES. You type one or more players or teams. Every card it offers
 * contains at least one of them; the rest of each card is filled from the pool
 * by conviction among the legs the risk dial admits, subject to the rules below. Ten cards, two at each leg count
 * from 2 to 6 — ranked purely by conviction a 2-leg card always wins, so the
 * leg-count bands are what make the list worth reading.
 *
 * ONE LINE PER PLAYER, CHOSEN BY A RISK DIAL (R86). The ladder a player carries
 * is a set of NESTED events — clearing 60 clears 20 — so his most probable rung
 * is always his lowest line. Letting every rung compete for a conviction ranking
 * therefore had exactly one answer: measured on the committed pool before R86,
 * 1,280 of 1,280 prop legs across all 32 team seeds sat on the ladder floor,
 * mean model probability 0.906, and the best 2-leg card in the product paid about
 * +$10 on a $100 simulation. dialLegs keeps ONE rung per player before the search
 * — the rung nearest the dial's target probability (SAFE 0.65, EVEN 0.50 default,
 * LONGSHOT 0.35), ties to the higher line. The dial re-prices nothing: it only
 * decides which already-calibrated rung is eligible.
 *
 * RANKED BY CONVICTION, NOT EV, and that is forced rather than chosen. There is
 * no player-prop odds feed, so a prop leg's implied price is our own number plus
 * the standard vig (app/parlay-math.impliedFromModel) and its EV is a constant
 * -vig. Ranking props by EV is ranking by nothing. Conviction — the combined
 * model probability — is the only ordering here that carries information. EV is
 * shown as a simulation using per-leg comparison prices. Even a sourced single-leg
 * price does not establish an executable quote for the complete combination.
 *
 * THE RULES A CARD MUST SATISFY (each one is a bet not being sold twice):
 *   - at least one leg from a seed you typed, or the card is not yours;
 *   - ONE LEG PER PLAYER. "40+ rec yds" and "20+ rec yds" on the same man is one
 *     opinion twice: clearing 40 clears 20. Same species of error as R74;
 *   - R74 itself, via violatesOnePerSide: a team's moneyline and that team's
 *     spread are one opinion;
 *   - same-game legs are correlation-adjusted, cross-game combined as
 *     independent — the builder's rule, through the shared maths.
 *
 * R89 — WE DO OUR OWN TYPE-AHEAD, AND THE EMPTY STATE SAYS WHY. The seed box
 * was a native <datalist>: it accepted only an EXACT option name, so "goff",
 * "aaron jones" and "j allen" each added nothing and cleared the field, and on
 * iPhone Safari the native popup is unreliable enough that the search read as
 * dead. 16 of the 214 pooled players carry a suffix ("James Cook III") that
 * nobody types, and on a Friday the list still offered the 17 players on DET and
 * BUF — whose game was final — and answered with "No upcoming card is available
 * for those names", which never said why. matchSeeds ranks the options
 * ourselves, the list is ours (so it behaves the same on every browser), a row
 * whose game has no upcoming leg says GAME FINAL before it is picked, and
 * emptyReason names the game, its state, and the week the next cards arrive.
 *
 * WHY EACH LEG, MEASURED. Every leg carries a line stating the numbers behind
 * it: the projection against the line, and the team's win probability that the
 * calibration's second term reads. No language model is involved — the product
 * runtime never contacts one (scripts/build_review_narrative.py is the single
 * opt-in exception and runs only on the runner), and a card built from what you
 * typed a second ago cannot have been narrated in advance.
 */

import { loadJson, getMyCardScores, getScheduleFull } from '../data.js';
import { simulateMoney, simulationBreakdown } from '../parlay-simulation.js';
import {
  combinedGameProbs, confidenceTier, correlationTable, legFromGame, legFromPool,
  modelEv, violatesOnePerSide,
} from '../parlay-math.js';

const POOL_PATH = '/data/leg_pool.json';
const CALIB_PATH = '/data/parlay_backtest.json';
const LEG_COUNTS = [2, 3, 4, 5, 6];
const PER_COUNT = 2;          // two cards per leg count -> ten cards
const BEAM = 24;              // partial cards kept at each step
const POOL_CAP = 220;         // strongest non-seed legs considered, by conviction
const STAKE = 100;

/* R86 — the risk dial. Target MODEL probability for a leg. For a player it picks
 * the rung nearest the target, which is the only rung of his ladder the search
 * ever sees; for a game leg, which has no ladder to pick from, it is a BAND: keep
 * the leg only when it is within GAME_LEG_BAND of the target. Without the band a
 * 77% moneyline out-convicts every ~50% prop and MY stops being about the players
 * you typed — measured at EVEN before the band, 905 of the 1,280 legs on cards
 * were game legs. These are difficulty bands over legs the calibration already
 * priced, not new prices. */
export const DIALS = { safe: 0.65, even: 0.50, longshot: 0.35 };
export const GAME_LEG_BAND = 0.15;
export const DEFAULT_DIAL = 'even';
const DIAL_ORDER = [['safe', 'SAFE'], ['even', 'EVEN'], ['longshot', 'LONGSHOT']];
const DIAL_KEY = 'nfl2026.myparlays.dial.v1';

export function upcomingLegs(legs, games, now = Date.now()) {
  const byId = new Map((games || []).map((g) => [String(g.game_id), g]));
  return legs.filter((leg) => {
    const g = byId.get(String(leg.game_id));
    return g?.status === 'STATUS_SCHEDULED' && Date.parse(g.kickoff_utc) > now;
  });
}

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ---- the searchable universe ------------------------------------------- */

/** Every leg in the pool, flattened: one per player-rung plus each game leg. */
export function poolLegs(pool) {
  const out = [];
  const sides = new Map();
  for (const row of (pool && pool.players) || []) {
    const key = `${row.game_id}|${row.team}`;
    if (row.game_id && row.team && ['home', 'away'].includes(row.side)) {
      // A disagreement is not resolved by whichever player happens to be last.
      sides.set(key, !sides.has(key) || sides.get(key) === row.side ? row.side : null);
    }
    for (const rung of row.rungs || []) {
      const leg = legFromPool(row, rung);
      leg.owner = row.gsis_id;          // one leg per player, enforced below
      leg.label = row.player;
      leg.mu = row.mu;
      leg.line = rung.line;
      leg.position = row.position;
      // R77 — a QUESTIONABLE player stays in the pool at his full price (Q is
      // priced + labelled; DOUBTFUL and worse never reach the pool). The flag
      // rides the leg so the card can say so, and it changes no number.
      if (row.availability) leg.availability = row.availability;
      out.push(leg);
    }
  }
  for (const g of (pool && pool.game_legs) || []) {
    const key = `${g.game_id}|${g.team}`;
    const side = g.side || sides.get(key);
    if (!g.game_id || !g.team || !['home', 'away'].includes(side)) continue;
    if (sides.has(key) && sides.get(key) !== side) continue;
    const leg = legFromGame({ ...g, side });
    leg.owner = `team:${g.team || g.selection}`;
    leg.label = g.team || g.selection;
    out.push(leg);
  }
  return out;
}

/** A prop leg: an unpriced rung owned by a PLAYER. Game legs own a `team:` id. */
const isPropLeg = (leg) => !leg.priced && leg.owner && !String(leg.owner).startsWith('team:');

/**
 * R86 — the dial, applied to EVERY leg.
 *
 * A PLAYER has a ladder, so the dial PICKS: one rung per player, the one whose
 * model probability is nearest `target`. Ties go to the HIGHER line — 0.55 and
 * 0.45 are equidistant from EVEN, the higher line is the harder bet, and pinning
 * the tie-break stops the selection depending on the order the pool happens to be
 * flattened in.
 *
 * A GAME LEG has no ladder, so the dial FILTERS: keep it only when its model
 * probability is within GAME_LEG_BAND of the target. A moneyline is one fixed
 * number; leaving every one of them eligible meant conviction ranking took the
 * heaviest favourite in the league ahead of any leg the dial had just chosen, and
 * the cards filled with moneylines instead of the players you typed. The band is
 * the same question asked of a leg that cannot be re-chosen: is this the
 * difficulty you asked for?
 *
 * Pure: it neither mutates the legs nor re-prices them, and it returns a new
 * array in the input's order. Nothing here touches a price: the dial only decides
 * which already-calibrated leg is eligible.
 */
export function dialLegs(legs, target) {
  const t = Number(target);
  const chosen = new Map();
  for (const leg of legs || []) {
    if (!isPropLeg(leg)) continue;
    const cur = chosen.get(leg.owner);
    if (!cur) { chosen.set(leg.owner, leg); continue; }
    const d = Math.abs(leg.model_prob - t);
    const dCur = Math.abs(cur.model_prob - t);
    if (d < dCur || (d === dCur && Number(leg.line) > Number(cur.line))) chosen.set(leg.owner, leg);
  }
  // The band edge is INCLUSIVE, and binary floating point has to be told so:
  // |0.65 - 0.50| evaluates to 0.15000000000000002, which would silently drop the
  // leg that sits exactly on the edge the legend promises.
  const inBand = (p) => Math.abs(Number(p) - t) - GAME_LEG_BAND <= 1e-9;
  return (legs || []).filter((leg) => (isPropLeg(leg)
    ? chosen.get(leg.owner) === leg
    : inBand(leg.model_prob)));
}

/** Seed suggestions: every player and every team the pool can actually price. */
export function seedOptions(pool) {
  const players = new Map();
  const teams = new Map();
  for (const row of (pool && pool.players) || []) {
    if (row.player) players.set(row.gsis_id, { kind: 'player', id: row.gsis_id,
      name: row.player, team: row.team, position: row.position });
    if (row.team) teams.set(row.team, { kind: 'team', id: `team:${row.team}`, name: row.team });
  }
  for (const g of (pool && pool.game_legs) || []) {
    if (g.team) teams.set(g.team, { kind: 'team', id: `team:${g.team}`, name: g.team });
  }
  return [...players.values()].sort((a, b) => a.name.localeCompare(b.name))
    .concat([...teams.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

/** Does this leg belong to one of the seeds? Teams match their players too. */
export function matchesSeed(leg, seeds) {
  for (const s of seeds) {
    if (s.kind === 'player' && leg.owner === s.id) return true;
    if (s.kind === 'team' && (leg.team === s.name || leg.owner === s.id)) return true;
  }
  return false;
}

/* ---- R89: the seed type-ahead and the honest empty state ----------------- */

/* Suffix tokens. 16 of the 214 pooled players carry one ("James Cook III",
 * "Aaron Jones Sr."), and nobody types it: dropping it from the NAME is what
 * lets "aaron jones" reach "Aaron Jones Sr." while the full form still matches
 * exactly, which is what the four MY browser specs type. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/** lower-case, diacritics dropped, non-alphanumerics -> space, spaces collapsed. */
function normName(v) {
  return String(v == null ? '' : v)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The three forms of an option's name a query is measured against. */
function nameForms(option) {
  const full = normName(option && option.name);
  const tokens = full ? full.split(' ') : [];
  return { full, tokens, core: tokens.filter((t) => !NAME_SUFFIXES.has(t)).join(' ') };
}

/** A team's abbreviation, which is seedable on its own ("ari" -> ARI). */
const teamAbbr = (option) => (option && option.kind === 'team'
  ? normName(option.abbr || option.name) : '');

const NO_MATCH = 99;    // sorts behind every real rank; never returned

/**
 * How well `option` answers the query — LOWER IS BETTER, NO_MATCH is no match.
 *
 * 1 exact (after suffix-dropping) · 2 team abbreviation · 3 the query is a
 * prefix of the whole name · 4 every query token prefixes a name token AND the
 * first one prefixes the FIRST name token · 5 every query token prefixes some
 * name token · 6 the name contains the query. Ties break A->Z in matchSeeds.
 */
function seedRank(option, q, qTokens) {
  const { full, tokens, core } = nameForms(option);
  if (!full || !q) return NO_MATCH;
  if (q === full || q === core) return 1;
  if (teamAbbr(option) === q) return 2;
  if (full.startsWith(q)) return 3;
  // A surname typed in full is a whole token: "cook" is James Cook III before
  // Brandin Cooks, whose token only STARTS with it. Measured on the committed
  // pool the A-to-Z tie-break alone put Cooks first.
  if (qTokens.length === 1 && tokens.includes(q)) return 4;
  const everyToken = qTokens.every((t) => tokens.some((n) => n.startsWith(t)));
  if (everyToken && tokens[0].startsWith(qTokens[0])) return 5;
  if (everyToken) return 6;
  if (full.includes(q) || core.includes(q)) return 7;
  return NO_MATCH;
}

/**
 * R89 — the ranked matches for what the viewer has typed so far.
 *
 * Pure, and the whole of the search: the view renders exactly this list. An
 * empty query returns nothing (a 246-row list is not a suggestion), and a query
 * nothing answers returns [] so the caller can say so rather than guess.
 */
export function matchSeeds(options, query, limit = 8) {
  const q = normName(query);
  if (!q) return [];
  const qTokens = q.split(' ');
  const ranked = [];
  for (const option of options || []) {
    const rank = seedRank(option, q, qTokens);
    if (rank < NO_MATCH) ranked.push({ option, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank
    || String(a.option.name).localeCompare(String(b.option.name)));
  return ranked.slice(0, Math.max(0, Number(limit) || 0)).map((r) => r.option);
}

/** The seed ids — players and `team:` ids — that still have an upcoming leg. */
function liveSeedIds(upcoming) {
  const live = new Set();
  for (const leg of upcoming || []) {
    if (leg.owner) live.add(String(leg.owner));
    if (leg.team) live.add(`team:${leg.team}`);
  }
  return live;
}

/** What a game is doing, in the three words the empty state is allowed to use. */
function gameState(game, now) {
  const status = String((game && game.status) || '').toUpperCase();
  if (!status) return 'not verified';
  if (/FINAL|FULL_TIME|END_OF/.test(status)) return 'final';
  if (/IN_PROGRESS|HALF|PERIOD|QUARTER|OVERTIME|DELAY/.test(status)) return 'in progress';
  const kickoff = Date.parse(game.kickoff_utc);
  // A SCHEDULED record whose kickoff has passed is a game being played that the
  // feed has not caught up with — R84's cutoff already dropped its legs.
  if (status.includes('SCHEDULED') && Number.isFinite(kickoff) && kickoff <= now) return 'in progress';
  return 'not verified';
}

/**
 * R89 — WHY there is no card, per seed, in numbers.
 *
 * "No upcoming card is available for those names" was true and useless: it
 * never said that DET and BUF had played on Thursday, so the 17 pooled players
 * on those two teams read as a broken search for three days a week. Pure, so
 * the sentences are testable without a browser.
 */
export function emptyReason(seeds, legs, games, poolWeek, now = Date.now()) {
  const byId = new Map((games || []).map((g) => [String(g.game_id), g]));
  const live = liveSeedIds(upcomingLegs(legs || [], games || [], now));
  const week = Number(poolWeek);
  const nextWeek = Number.isFinite(week) ? week + 1 : null;
  const out = [];
  for (const seed of seeds || []) {
    if (live.has(String(seed.id))) {
      out.push(`No card could be built around ${seed.name} at this dial; `
        + 'try another risk setting.');
      continue;
    }
    const mine = (legs || []).filter((l) => matchesSeed(l, [seed]));
    const team = seed.kind === 'team' ? seed.name
      : (mine.find((l) => l.team) || {}).team || seed.name;
    const tail = `cards are built only for games that have not kicked off, and ${team}'s `
      + `next cards arrive with the week ${nextWeek} pool.`;
    const ids = [...new Set(mine.map((l) => String(l.game_id)).filter(Boolean))];
    if (!ids.length) { out.push(`${seed.name}: no game is on file; ${tail}`); continue; }
    for (const id of ids) {
      const game = byId.get(id);
      const where = game ? `${game.away} @ ${game.home}` : 'the game';
      out.push(`${seed.name}: ${where} is ${gameState(game, now)}; ${tail}`);
    }
  }
  return out.join(' ');
}

/**
 * One suggestion row. `live` is the set of seed ids with an upcoming leg, so a
 * row it does not hold is offered with the reason it will build nothing.
 * A team's second cell is the literal word TEAM — its name IS its abbreviation,
 * so repeating it there would say nothing.
 */
function renderSeedOption(option, i, active, live) {
  const meta = option.kind === 'team' ? 'TEAM'
    : [option.team, option.position].filter(Boolean).map(esc).join(' · ');
  const done = live && !live.has(String(option.id))
    ? '<span class="est">GAME FINAL</span>' : '';
  return `<li role="option" id="mp-opt-${i}" class="mp-opt" data-seed="${esc(option.id)}" `
    + `aria-selected="${i === active ? 'true' : 'false'}">`
      + `<span class="mp-opt-nm">${esc(option.name)}</span>`
      + (meta ? `<span class="mp-opt-meta">${meta}</span>` : '')
      + done
    + '</li>';
}

/* ---- the search --------------------------------------------------------- */

/** Two legs may not sit in one card when they are the same opinion twice. */
function compatible(legs, next) {
  if (next.game_id && legs.filter((l) => l.game_id === next.game_id).length >= 2) return false;
  for (const leg of legs) {
    if (leg.owner === next.owner) return false;      // one leg per player / team
    if (leg.selection === next.selection) return false;
  }
  return !violatesOnePerSide([...legs, next]);
}

/** Conviction: the combined model probability, correlation-aware within a game. */
export function conviction(legs, table) {
  return combinedGameProbs(legs, table)[0];
}

/** Everything a card shows, from its legs alone. */
export function scoreCard(legs, table) {
  const sameGame = legs.length > 1
    && legs.every((l) => l.game_id && l.game_id === legs[0].game_id);
  const games = legs.map((l) => l.game_id).filter(Boolean);
  const mixedGame = !sameGame && new Set(games).size < games.length;
  const [model, implied] = combinedGameProbs(legs, table);
  const decimal = implied > 0 ? 1 / implied : 0;
  return {
    legs,
    model,
    implied,
    ev: modelEv(model, implied),
    tier: confidenceTier(model, implied, legs.length),
    sameGame,
    mixedGame,
    // What $100 would return if every leg hit, at the prices shown. A price, not
    // a result: these cards are never graded, so there is no realized figure.
    payout: decimal > 0 ? STAKE * (decimal - 1) : 0,
    assumed: legs.filter((l) => !l.priced).length,
  };
}

/**
 * Top cards containing at least one seed leg.
 *
 * Beam search rather than enumeration: 1,400+ legs choose 6 is astronomical, and
 * the greedy frontier finds the same high-conviction cards because conviction is
 * monotone decreasing as legs are added — the best 6-leg card is built from
 * strong 5-leg prefixes. BEAM keeps enough alternatives that a leg blocked by
 * the one-per-player or R74 rules does not dead-end the whole branch.
 */
export function buildCards(legs, seeds, table, opts = {}) {
  const perCount = opts.perCount || PER_COUNT;
  const counts = opts.counts || LEG_COUNTS;
  const seedLegs = legs.filter((l) => matchesSeed(l, seeds));
  if (!seedLegs.length) return [];

  const byConviction = (a, b) => b.model_prob - a.model_prob;
  const others = legs.filter((l) => !matchesSeed(l, seeds))
    .sort(byConviction).slice(0, opts.poolCap || POOL_CAP);
  const candidates = seedLegs.slice().sort(byConviction).concat(others);

  let beam = seedLegs.slice().sort(byConviction).slice(0, BEAM).map((l) => [l]);
  const out = [];
  const maxLegs = Math.max(...counts);
  for (let size = 2; size <= maxLegs; size += 1) {
    const grown = [];
    for (const partial of beam) {
      for (const next of candidates) {
        if (!compatible(partial, next)) continue;
        grown.push([...partial, next]);
      }
    }
    if (!grown.length) break;
    grown.sort((a, b) => conviction(b, table) - conviction(a, table));
    // de-dupe: the same set of legs reached by different orders is one card
    const seen = new Set();
    beam = [];
    for (const card of grown) {
      const key = card.map((l) => l.selection).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      beam.push(card);
      if (beam.length >= BEAM) break;
    }
    if (counts.includes(size)) {
      out.push(...beam.slice(0, perCount).map((c) => scoreCard(c, table)));
    }
  }
  return out;
}

/* ---- rendering ---------------------------------------------------------- */

/** The measured reason this leg is on the card. Numbers only, no adjectives. */
export function whyLine(leg) {
  if (leg.market === 'moneyline' || leg.market === 'spread') {
    const source = leg.price_source === 'fair_market' ? 'fair market comparison'
      : leg.price_source === 'book_quote' ? 'single-leg book price'
        : leg.price_source === 'assumed' ? 'assumed comparison' : 'legacy comparison (source unknown)';
    return `${source} ${Math.round(leg.implied_prob * 100)} vs our ${Math.round(leg.model_prob * 100)}`;
  }
  const mu = Number(leg.mu);
  if (!Number.isFinite(mu) || !Number.isFinite(Number(leg.line))) return '';
  const gap = mu - Number(leg.line);
  // One decimal on all three, so the numbers on screen RECONCILE. Rounding the
  // gap to an integer beside un-rounded operands prints arithmetic that does not
  // add up (70 vs a 39.5 line reading "+31"), which is a small lie in a product
  // whose whole claim is that every number is checkable.
  return `projects ${mu.toFixed(1)} vs a ${Number(leg.line).toFixed(1)} line `
    + `(${gap >= 0 ? '+' : ''}${gap.toFixed(1)})`;
}

const money = (n) => {
  const v = Math.round(n);
  const abs = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '−' : '+'}$${abs}`;
};

/**
 * R87 — THE RECORD LINE: how the cards this dial offered actually did.
 *
 * Every card above is a claim. Until R87 no MY card was ever written down, so no
 * MY card was ever graded and the only number on screen was a projection of its
 * own confidence. scripts/build_my_cards.py now records what was offered and
 * scripts/resolve_my_cards.py grades it; this prints the result for the dial the
 * viewer is looking at, from the LATEST week that has graded cards.
 *
 * Pure, and deliberately unforgiving: a week whose `graded` is 0 is not "0%", it
 * is not shown at all, because a hit rate of zero claims a measurement that was
 * never made. A missing feed, a missing block or a null metric renders NOTHING —
 * the honest state of a season that has not been played is an absent line, not a
 * zero. Numbers only, no adjectives.
 */
export function renderRecord(scores, dial) {
  const weeks = scores && Array.isArray(scores.weeks) ? scores.weeks : [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let best = null;
  for (const w of weeks) {
    const b = w && w.by_dial ? w.by_dial[dial] : null;
    if (!b || !num(b.graded)) continue;
    if (!best || Number(w.week) > Number(best.week)) best = { week: w.week, b };
  }
  if (!best) return '';
  const { b } = best;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const label = (DIAL_ORDER.find(([k]) => k === dial) || [dial, String(dial)])[1];
  const parts = [`WK ${best.week}`, label, `${b.graded} cards graded`];
  const hitRate = num(b.hit_rate);
  if (num(b.all_hit) != null && hitRate != null) {
    parts.push(`${b.all_hit} all hit (${pct(hitRate)})`);
  }
  const mean = num(b.mean_model);
  if (mean != null) parts.push(`mean conviction ${pct(mean)}`);
  const net = num(b.net_fair);
  if (net != null) parts.push(`$100 flat net ${money(net)}`);
  // `.mp-record` carries no style — it is the handle paint() removes the line by.
  return '<div class="legend mp-record">'
    + `<span class="legend-item"><b>RECORD</b> · ${parts.map(esc).join(' · ')}</span>`
    + '<span class="est">MEASURED</span>'
    + '</div>';
}

/** R77 — the same Q chip PARLAYS paints in annotateLegs, same copy, same tone. */
const qChip = (l) => (l.availability === 'QUESTIONABLE'
  ? '<span class="est leg-q" title="Questionable — game-time decision">Q</span>' : '');

export function renderCard(card, i) {
  const pct = (p) => Math.round(p * 100);
  // R82 — `leg--annot` (flex-wrap:wrap) is REQUIRED here, not decorative. Every
  // leg on a MY card carries a why-line, and `.leg-prov` is flex-basis:100% by
  // design: without the wrap it stays on the name's flex line and, being
  // shrinkable, eats it — measured 62px of a 155px name at 1280px, and 54px at
  // 402px, where the name then stacked one word per line (5 lines, a 106px leg).
  // PARLAYS adds the same class in annotateLegs; this list never did.
  const legs = card.legs.map((l) => (
    '<div class="leg leg--annot">'
      + `<div class="leg-nm">${esc(l.selection)}</div>`
      + '<div class="leg-od">'
        + qChip(l)
        + `<span class="mo">MODEL <b>${pct(l.model_prob)}</b></span>`
        + `<span class="im">${l.priced ? 'IMPL' : 'IMPL*'} ${pct(l.implied_prob)}</span>`
      + '</div>'
      + `<div class="leg-prov">${esc(whyLine(l))}</div>`
    + '</div>'
  )).join('');
  return (
    `<article class="card parlay mp-card" data-mp="${i}" data-scope="my">`
      + '<div class="p-head">'
        + `<span class="lbl">${card.legs.length} LEG · ${card.sameGame ? 'SAME GAME' : card.mixedGame ? 'MIXED GAMES' : 'CROSS GAME'}</span>`
        + `<span class="tier tier--${esc(card.tier)}" title="Simulated edge category, not calibrated confidence">SIM ${esc(card.tier.toUpperCase())}</span>`
      + '</div>'
      + `<div class="legs">${legs}</div>`
      + '<div class="p-foot">'
        + `<div class="ev" title="Model-estimated chance that every leg hits; not a guarantee">${pct(card.model)}%<span class="k">CONVICTION</span></div>`
        + `<div class="legcount">${(card.ev * 100).toFixed(1)}% SIM EV</div>`
        + `<div class="pay">${money(card.payout)}<span class="k">$100 SIM NET</span><span class="pay-detail">${esc(simulationBreakdown(simulateMoney(card.legs)))}</span></div>`
      + '</div>'
      + '<div class="corr"><span class="lk" aria-hidden="true">*</span><span>'
        + 'SIMULATION · multiply 1/IMPL for each leg; no same-game book adjustment. '
        + 'Prop IMPL* = model probability × 1.045 (capped below 100%), not a book price. '
        + 'Higher hit-probability lines produce lower simulated returns. Net excludes the stake; no executable quote.</span></div>'
    + '</article>'
  );
}

/* ---- mount -------------------------------------------------------------- */

const state = { seeds: [], pool: null, table: null, legs: null, scores: null,
  dial: DEFAULT_DIAL, live: new Set() };

/* The dial is a per-VIEWER preference, not data: it says which of his own legs a
 * person wants to look at. localStorage throws outright in Safari private mode,
 * so every touch is guarded and an unreadable store simply means EVEN. */
function readDial() {
  try {
    const v = localStorage.getItem(DIAL_KEY);
    if (v && Object.prototype.hasOwnProperty.call(DIALS, v)) return v;
  } catch { /* private mode, blocked storage: the default is honest */ }
  return DEFAULT_DIAL;
}

function writeDial(v) {
  try { localStorage.setItem(DIAL_KEY, v); } catch { /* nothing to do, nothing lost */ }
}

/** The three risk chips, reusing the leg-chip pill the leg-count selector uses. */
function renderDial() {
  return DIAL_ORDER.map(([key, label]) => {
    const on = state.dial === key;
    return `<button type="button" class="leg-chip${on ? ' leg-chip--active' : ''}" `
      + `data-dial="${key}" aria-pressed="${on ? 'true' : 'false'}">${label}</button>`;
  }).join('');
}

function renderSeeds() {
  if (!state.seeds.length) return '';
  return '<div class="legseg mp-seeds">' + state.seeds.map((s) => (
    `<button type="button" class="leg-chip leg-chip--active" data-drop="${esc(s.id)}" `
    + `aria-label="Remove ${esc(s.name)}">${esc(s.name)} ✕</button>`
  )).join('') + '</div>';
}

/* R87 — the RECORD line is INSERTED and REMOVED rather than emptied, so a season
 * with nothing graded costs no row in the host's 12px flex rhythm (the same
 * reason #mp-seeds:empty is display:none). It follows the legend it annotates. */
function paintRecord(el) {
  const prev = el.querySelector('.mp-record');
  if (prev) prev.remove();
  const html = renderRecord(state.scores, state.dial);
  const note = el.querySelector('#mp-note');
  if (html && note) note.insertAdjacentHTML('afterend', html);
}

function paint(el) {
  const list = el.querySelector('#mp-list');
  const seedBox = el.querySelector('#mp-seeds');
  const dialBox = el.querySelector('.mp-dial');
  // R89 — the upcoming legs are read ONCE per paint: the card search needs them,
  // and so does the suggestion list, which marks every seed that has none.
  const eligible = upcomingLegs(state.legs || [], state.games || []);
  state.live = liveSeedIds(eligible);
  if (seedBox) seedBox.innerHTML = renderSeeds();
  if (dialBox) dialBox.innerHTML = renderDial();
  paintRecord(el);            // the dial decides which record is shown
  if (!list) return;
  if (!state.seeds.length) {
    list.innerHTML = '<div class="state">Type a player or a team above — every card '
      + 'we build will contain at least one of them.</div>';
    return;
  }
  // R86 — the dial narrows each player's ladder to ONE rung BEFORE the search, so
  // conviction ranks legs of comparable difficulty instead of racing to the floor.
  const target = DIALS[state.dial] != null ? DIALS[state.dial] : DIALS[DEFAULT_DIAL];
  const cards = buildCards(dialLegs(eligible, target), state.seeds, state.table);
  if (!cards.length) {
    // R89 — per seed, the game and its state, instead of one fixed sentence.
    list.innerHTML = `<div class="state">${esc(emptyReason(state.seeds, state.legs,
      state.games, state.pool && state.pool.week))}</div>`;
    return;
  }
  // The list is built as leg-count PAIRS; the eyebrow says so, once per band,
  // instead of every card repeating its own count in isolation.
  const html = [];
  let band = null;
  cards.forEach((card, i) => {
    const n = card.legs.length;
    if (n !== band) {
      band = n;
      html.push(`<div class="mp-band" role="heading" aria-level="3">${n} LEGS</div>`);
    }
    html.push(renderCard(card, i));
  });
  list.innerHTML = html.join('');
}

/**
 * Mount MY PARLAYS into `el`.
 *
 * R82 — RESOLVES TO THE POOL'S WEEK (or null when the pool would not load).
 * app/views/parlays.js owns the header and titles MY mode "MY PARLAYS · POOL
 * WK n"; n is the week the leg pool was built for, which is this module's
 * document to read, not the header's. Returning it is cheaper than exporting
 * the loaded pool — the caller needs one number and must not hold the ~294 KB
 * document alive after the tab is closed.
 */
export default async function mountMyParlays(el) {
  el.innerHTML = '<div class="state state--loading">Loading the leg pool…</div>';
  const [poolR, calibR, scheduleR, scoresR] = await Promise.allSettled([
    loadJson(POOL_PATH), loadJson(CALIB_PATH), getScheduleFull(), getMyCardScores(),
  ]);
  if (!el.isConnected) return null;
  if (poolR.status !== 'fulfilled' || !poolR.value) {
    el.innerHTML = '<div class="state">My Parlays unavailable — the leg pool has '
      + 'not been built yet.</div>';
    return null;
  }
  state.pool = poolR.value;
  state.dial = readDial();          // R86 — the viewer's own risk band, or EVEN
  state.games = scheduleR.status === 'fulfilled' ? scheduleR.value?.games || [] : [];
  state.table = correlationTable(calibR.status === 'fulfilled' ? calibR.value : null);
  // R87 — the graded record. A 404 (a deploy predating the feed) or any other
  // failure leaves it null and the RECORD line simply is not painted.
  state.scores = scoresR.status === 'fulfilled' ? scoresR.value : null;
  state.legs = poolLegs(state.pool);
  const unavailable = (state.pool.game_legs || []).length
    - state.legs.filter((l) => l.market === 'moneyline' || l.market === 'spread').length;
  const options = seedOptions(state.pool);

  el.innerHTML =
    '<div class="mp-head">'
      + '<label class="mp-label" for="mp-input">PLAYERS OR TEAMS</label>'
      + '<input id="mp-input" class="mp-input" autocomplete="off" role="combobox" '
        + 'aria-autocomplete="list" aria-expanded="false" aria-controls="mp-suggest" '
        + 'placeholder="e.g. goff, j allen, KC" aria-describedby="mp-note">'
      + '<ul id="mp-suggest" class="mp-suggest" role="listbox" '
        + 'aria-label="Matching players and teams"></ul>'
    + '</div>'
    + '<div id="mp-seeds"></div>'
    + '<div class="mp-dial" role="group" aria-label="Risk dial"></div>'
    + `<div class="legend" id="mp-note"><span class="legend-item"><b>CONVICTION</b> our `
      + `combined probability the whole card hits. Cards carry ONE line per player, chosen by `
      + `the RISK dial above (SAFE \u2248 65%, EVEN \u2248 50%, LONGSHOT \u2248 35% model chance per leg). `
      + `The dial applies to EVERY leg: a moneyline or spread is only offered when its own model `
      + `chance is within 15 points of the dial. Cards are ranked by model hit chance within that `
      + `dial, never by payout. `
      + `Search is approximate, not a guaranteed optimum. `
      + `At most two legs per game are supported</span>`
      + `<span class="legend-item"><b>$100 SIM NET</b> hypothetical profit, excluding the stake, `
      + `using the independent product of displayed IMPL assumptions. Not a sportsbook quote or actual wager</span>`
      + `<span class="est">ESTIMATE</span></div>`
    + (unavailable ? `<div class="state" role="status">${unavailable} game leg(s) unavailable — `
      + 'event or team-side identity could not be verified.</div>' : '')
    + '<div id="mp-list" class="card-list"></div>';

  /* R89 — the type-ahead. The whole list is re-rendered on every keystroke:
   * matchSeeds over 246 options is one pass of string work, far below a frame,
   * so a debounce would only add latency to a keypress that is already free. */
  const input = el.querySelector('#mp-input');
  const listbox = el.querySelector('#mp-suggest');
  let shown = [];             // the options on screen, in rank order
  let active = 0;             // the row Enter picks — the best match by default
  let blurTimer = null;

  const closeSuggest = () => {
    shown = [];
    active = 0;
    listbox.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const markActive = () => {
    const rows = [...listbox.children];
    rows.forEach((li, i) => {
      if (li.dataset.seed) li.setAttribute('aria-selected', i === active ? 'true' : 'false');
    });
    const row = rows[active];
    if (!row || !row.dataset.seed) return;
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  };

  const paintSuggest = () => {
    if (!String(input.value || '').trim()) { closeSuggest(); return; }
    shown = matchSeeds(options, input.value);
    if (active >= shown.length) active = 0;
    listbox.innerHTML = shown.length
      ? shown.map((o, i) => renderSeedOption(o, i, active, state.live)).join('')
      // Not an option, and not silence either: the old box just cleared itself.
      : '<li class="mp-opt mp-opt--none" aria-disabled="true">No player or team matches</li>';
    input.setAttribute('aria-expanded', 'true');
    if (shown.length) input.setAttribute('aria-activedescendant', `mp-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const pick = (opt) => {
    input.value = '';
    closeSuggest();
    if (!opt || state.seeds.some((s) => s.id === opt.id)) return;
    state.seeds.push(opt);
    paint(el);
  };

  input.addEventListener('input', paintSuggest);
  input.addEventListener('focus', () => { clearTimeout(blurTimer); paintSuggest(); });
  // The tap must land before the blur that follows it, or iOS swallows the pick:
  // pointerdown fires first and preventDefault keeps the focus where it is.
  for (const type of ['pointerdown', 'mousedown']) {
    listbox.addEventListener(type, (e) => {
      const row = e.target.closest('[data-seed]');
      if (!row || !shown.length) return;
      e.preventDefault();
      pick(shown.find((o) => String(o.id) === row.dataset.seed));
    });
  }
  input.addEventListener('blur', () => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(closeSuggest, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      markActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Nothing matched: the typed text stays where the viewer can fix it.
      if (shown.length) pick(shown[active]); else paintSuggest();
    } else if (e.key === 'Escape') {
      closeSuggest();
    }
  });
  el.querySelector('.mp-dial').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dial]');
    if (!btn || btn.dataset.dial === state.dial) return;
    state.dial = btn.dataset.dial;
    writeDial(state.dial);
    paint(el);
  });
  el.querySelector('#mp-seeds').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-drop]');
    if (!btn) return;
    state.seeds = state.seeds.filter((s) => s.id !== btn.dataset.drop);
    paint(el);
  });
  paint(el);
  // Recheck at the next kickoff even when the tab stays open in the foreground.
  let timer;
  const scheduleCutoff = () => {
    const next = Math.min(...state.games.map((g) => Date.parse(g.kickoff_utc)).filter((t) => t > Date.now()));
    if (Number.isFinite(next)) timer = setTimeout(() => {
      if (el.isConnected) { paint(el); scheduleCutoff(); }
    }, Math.min(next - Date.now() + 25, 2147483647));
  };
  scheduleCutoff();
  const observer = new MutationObserver(() => {
    if (!el.isConnected) { clearTimeout(timer); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // R82 — the pool's own week, for the MY-mode subtitle the header paints.
  const wk = Number(state.pool.week);
  return Number.isFinite(wk) ? wk : null;
}
