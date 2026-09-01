/* app/grade.js — TEAM GRADE engine. Pure module: no DOM, no fetch, no clock.
 *
 * Three jobs, each honest about what it is:
 *   1. PARSE anything a person pastes — site copy, typed names, JSON, HTML —
 *      into teams of matched pool players. Matching is deterministic (exact
 *      canonical name, then a UNIQUE-substring fallback); a line that cannot
 *      be matched is returned as `unmatched`, shown loudly, never guessed.
 *   2. GRADE a roster: the optimal starting lineup by OUR projections for a
 *      stated shape. An unfillable slot scores 0 and is reported EMPTY.
 *   3. SIMULATE a league season: Monte Carlo over weekly scores drawn from a
 *      DOCUMENTED variance prior. The fantasy schedule is unknown, so each
 *      simulated week pairs teams at random — stated as an assumption, not
 *      hidden. No market input anywhere (owner policy).
 *
 * Everything downstream is an ESTIMATE and the view says so on every card.
 */

/* ---------------------------------------------------------------- parsing */

/** Canonical join key: case/punctuation/suffix-insensitive. */
export function normName(s) {
  return String(s || '')
    .replace(/\./g, '')
    .toLowerCase()
    .replace(/\b(iii|ii|iv|jr|sr|v)\b/g, '')
    .replace(/[^a-z' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HTML → text: tags become line breaks so table/list markup splits cleanly. */
export function stripHtml(text) {
  return String(text || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** Try the JSON shapes people actually paste. Returns [{name, lines}] or null. */
function parseJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const asLines = (v) => (Array.isArray(v) ? v : [v])
    .map((x) => (typeof x === 'string' ? x : x && (x.name || x.player || x.full_name)))
    .filter(Boolean).map(String);
  if (Array.isArray(doc)) {
    if (doc.every((x) => typeof x === 'string')) return [{ name: null, lines: doc }];
    if (doc.every((x) => x && typeof x === 'object')) {
      // [{team|name|owner, players|roster|lineup|starters: [...]}]
      const teams = doc
        .map((t, i) => ({
          name: String(t.team || t.team_name || t.owner || t.name || `TEAM ${i + 1}`),
          lines: asLines(t.players || t.roster || t.lineup || t.starters || []),
        }))
        .filter((t) => t.lines.length);
      if (teams.length) return teams;
      // plain array of player objects -> one team
      const lines = asLines(doc);
      return lines.length ? [{ name: null, lines }] : null;
    }
    return null;
  }
  if (doc && typeof doc === 'object') {
    const teams = Object.entries(doc)
      .map(([k, v]) => ({ name: k, lines: asLines(v) }))
      .filter((t) => t.lines.length);
    return teams.length ? teams : null;
  }
  return null;
}

/** Split free text into blocks of lines (blank-line separated). */
export function parseBlocks(text) {
  const t = String(text || '');
  const isHtml = /<[a-z][\s\S]*>/i.test(t);
  // HTML: every tag became a newline, so blank-line team-splitting would turn
  // each table cell into a "team". Tag soup is treated as ONE block (one team
  // per HTML paste); multi-team pastes use plain text or JSON — stated in the
  // view's instructions.
  const plain = isHtml ? stripHtml(t).replace(/\n\s*\n+/g, '\n') : t;
  return plain
    .split(/\n\s*\n+/)
    .map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((b) => b.length);
}

/** Strip the noise pasted lines carry around a name: leading ranks/bullets,
 *  trailing "- BUF", ", RB", "(Q)", "$12", pos/team token runs. */
export function cleanLine(line) {
  return String(line || '')
    .replace(/^\s*[\d#.)\-•*]+\s*/, '')
    .replace(/\((?:[^)]*)\)/g, ' ')
    .replace(/[-–—,|·]\s*(QB|RB|WR|TE|K|DEF|DST)\b.*$/i, ' ')
    .replace(/\$\s*\d+(\.\d+)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match one pasted line to the pool. Returns the pool entry or null.
 * Order: exact canonical match; then a UNIQUE pool name contained in the line
 * (handles "QB Josh Allen BUF · proj 24.1"). Ambiguity = no match — a wrong
 * player on a graded roster is worse than an honest unmatched line.
 */
export function matchLine(line, index) {
  const cleaned = normName(cleanLine(line));
  if (!cleaned) return null;
  const exact = index.byNorm.get(cleaned);
  if (exact) return exact;
  const padded = ` ${cleaned} `;
  let hit = null;
  for (const [n, p] of index.byNorm) {
    if (n && padded.includes(` ${n} `)) {
      if (hit && hit !== p) return null; // two pool names inside one line
      hit = p;
    }
  }
  return hit;
}

/** Build the match index once per grade run. `pool` rows: {gsis_id, name, ...}. */
export function buildIndex(pool) {
  const byNorm = new Map();
  const dup = new Set();
  for (const p of pool || []) {
    const n = normName(p.name);
    if (!n) continue;
    if (byNorm.has(n) && byNorm.get(n).gsis_id !== p.gsis_id) dup.add(n);
    byNorm.set(n, p);
  }
  for (const n of dup) byNorm.delete(n); // an ambiguous name can never match
  return { byNorm };
}

/**
 * The whole pipeline: text -> [{name, players, unmatched}].
 * A block's first line becomes the TEAM NAME only when it does NOT match a
 * player — a headerless paste of players stays a full roster.
 */
export function buildLeague(text, pool) {
  const index = buildIndex(pool);
  const fromJson = parseJson(String(text || '').trim());
  const blocks = fromJson
    ? fromJson.map((t) => ({ header: t.name, lines: t.lines }))
    : parseBlocks(text).map((b) => ({ header: null, lines: b }));

  const teams = [];
  blocks.forEach((b, i) => {
    let lines = b.lines;
    let name = b.header;
    if (name == null && lines.length > 1 && !matchLine(lines[0], index)) {
      name = cleanLine(lines[0]).replace(/:\s*$/, '') || `TEAM ${i + 1}`;
      lines = lines.slice(1);
    }
    const players = [];
    const unmatched = [];
    const seen = new Set();
    for (const line of lines) {
      const p = matchLine(line, index);
      if (p && !seen.has(String(p.gsis_id))) {
        seen.add(String(p.gsis_id));
        players.push(p);
      } else if (p) {
        // duplicate line for the same player — fold silently, not an error
      } else {
        unmatched.push(line);
      }
    }
    if (players.length || unmatched.length) {
      teams.push({ name: name || `TEAM ${i + 1}`, players, unmatched });
    }
  });
  return { teams };
}

/* ---------------------------------------------------------------- grading */

export const DEFAULT_SHAPE = Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
const FLEX_POS = new Set(['RB', 'WR', 'TE']);

/**
 * Optimal starting lineup by projected points for `shape`. `projOf(p)` maps a
 * pool row to points. Unfillable slots are honest: 0 points + an EMPTY entry.
 * K/DEF are out of scope here (separate contract; the view says so).
 */
export function gradeTeam(players, projOf, shape = DEFAULT_SHAPE) {
  const rows = (players || [])
    .map((p) => ({ p, pts: Number(projOf(p)) || 0 }))
    .sort((a, b) => b.pts - a.pts || (String(a.p.gsis_id) < String(b.p.gsis_id) ? -1 : 1));
  const used = new Set();
  const starters = [];
  let total = 0;
  const takeBest = (accepts, slot) => {
    for (const r of rows) {
      const pos = String(r.p.position || '').toUpperCase();
      if (used.has(r.p.gsis_id) || !accepts(pos)) continue;
      used.add(r.p.gsis_id);
      starters.push({ slot, name: r.p.name, position: pos, pts: r.pts });
      total += r.pts;
      return true;
    }
    starters.push({ slot, name: null, position: null, pts: 0, empty: true });
    return false;
  };
  for (const [pos, n] of Object.entries(shape)) {
    if (pos === 'FLEX') continue;
    for (let i = 0; i < n; i++) takeBest((x) => x === pos, `${pos}${n > 1 ? i + 1 : ''}`);
  }
  for (let i = 0; i < (shape.FLEX || 0); i++) {
    takeBest((x) => FLEX_POS.has(x), 'FLEX');
  }
  const bench = rows.filter((r) => !used.has(r.p.gsis_id)).length;
  return { starters, total: Math.round(total * 10) / 10, bench };
}

/** Percentile (0..100) of `value` within `field` (inclusive-below). */
export function percentile(value, field) {
  const xs = (field || []).filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  const below = xs.filter((v) => v <= value).length;
  return Math.round((below / xs.length) * 100);
}

/** Letter for a percentile — plain bands, stated on the card. */
export function letterFor(pct) {
  if (pct == null) return '—';
  if (pct >= 90) return 'A+';
  if (pct >= 75) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 40) return 'C';
  if (pct >= 25) return 'D';
  return 'F';
}

/**
 * A reference field for a SINGLE pasted team: lineup totals of `leagueSize`
 * synthetic teams snake-drafted straight down OUR ranking (team k takes picks
 * k, 2N-1-k, 2N+k, ... — the plainest honest opponent model, no ADP, no
 * market). Deterministic.
 */
export function syntheticFieldTotals(pool, projOf, leagueSize = 10, rounds = 8,
  shape = DEFAULT_SHAPE) {
  const ranked = (pool || [])
    .filter((p) => FLEX_POS.has(String(p.position || '').toUpperCase())
      || String(p.position || '').toUpperCase() === 'QB')
    .slice()
    .sort((a, b) => (Number(projOf(b)) || 0) - (Number(projOf(a)) || 0));
  // NEED-AWARE snake: each seat takes the highest-ranked player it can still
  // roster (caps QB 1 / RB 3 / WR 3 / TE 2 over 8 rounds). A straight-down
  // snake can overdraft one position into an unfillable lineup — a strawman
  // field would flatter every pasted team, which is its own kind of dishonest.
  const CAPS = { QB: 1, RB: 3, WR: 3, TE: 2 };
  const rosters = Array.from({ length: leagueSize }, () => []);
  const counts = Array.from({ length: leagueSize }, () => ({ QB: 0, RB: 0, WR: 0, TE: 0 }));
  const takenIdx = new Set();
  for (let r = 0; r < rounds; r++) {
    const order = [...Array(leagueSize).keys()];
    if (r % 2 === 1) order.reverse();
    for (const k of order) {
      for (let i = 0; i < ranked.length; i++) {
        if (takenIdx.has(i)) continue;
        const pos = String(ranked[i].position || '').toUpperCase();
        if ((counts[k][pos] || 0) >= (CAPS[pos] || 0)) continue;
        takenIdx.add(i);
        counts[k][pos] += 1;
        rosters[k].push(ranked[i]);
        break;
      }
    }
  }
  return rosters.map((ps) => gradeTeam(ps, projOf, shape).total);
}

/* ------------------------------------------------------------- simulation */

/** Deterministic PRNG (mulberry32) — same seed, same season, always. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng) {
  // Box–Muller; rng() in (0,1)
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Documented weekly-variance prior: sd = max(sdFrac·mean, sdMin). A prior,
 *  not a fit — stated on the results card, revisited when 2026 scores exist. */
export const SD_FRAC = 0.22;
export const SD_MIN = 12;

/**
 * Monte Carlo a fantasy season. `teams`: [{name, weeklyMean}]. The league's
 * real schedule is unknown, so every simulated week pairs teams uniformly at
 * random (odd team out gets a bye-win coin flip weighted by its mean vs the
 * field). Top `playoffSlots` by wins (points tiebreak) reach a seeded
 * single-elimination bracket; with 6 slots the top 2 seeds get byes.
 * Returns [{name, playoff, title, avgWins}] in input order. ESTIMATE.
 */
export function simulateLeague(teams, {
  sims = 2000, seed = 20260901, weeks = 14, playoffSlots = null,
  sdFrac = SD_FRAC, sdMin = SD_MIN,
} = {}) {
  const n = (teams || []).length;
  if (n < 2) return (teams || []).map((t) => ({ name: t.name, playoff: null, title: null, avgWins: null }));
  const slots = playoffSlots || (n >= 8 ? 6 : Math.max(2, Math.floor(n / 2)));
  const rng = mulberry32(seed);
  const means = teams.map((t) => Math.max(1, Number(t.weeklyMean) || 1));
  const sds = means.map((m) => Math.max(sdFrac * m, sdMin));
  const score = (i) => Math.max(0, means[i] + sds[i] * normal(rng));
  const madePlayoffs = new Array(n).fill(0);
  const wonTitle = new Array(n).fill(0);
  const winsSum = new Array(n).fill(0);

  for (let s = 0; s < sims; s++) {
    const wins = new Array(n).fill(0);
    const pts = new Array(n).fill(0);
    for (let w = 0; w < weeks; w++) {
      const order = [...Array(n).keys()];
      for (let i = order.length - 1; i > 0; i--) { // Fisher–Yates
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let i = 0; i + 1 < order.length; i += 2) {
        const a = order[i]; const b = order[i + 1];
        const sa = score(a); const sb = score(b);
        pts[a] += sa; pts[b] += sb;
        if (sa >= sb) wins[a] += 1; else wins[b] += 1;
      }
      if (order.length % 2 === 1) {
        const solo = order[order.length - 1];
        const sp = score(solo);
        pts[solo] += sp;
        if (sp >= means.reduce((x, y) => x + y, 0) / n) wins[solo] += 1;
      }
    }
    const seeds = [...Array(n).keys()]
      .sort((a, b) => wins[b] - wins[a] || pts[b] - pts[a] || a - b)
      .slice(0, slots);
    for (const t of seeds) madePlayoffs[t] += 1;
    // Bracket: with 6 slots, seeds 1-2 bye; otherwise straight pairings.
    let field = seeds;
    if (slots === 6) {
      const g1 = score(field[2]) >= score(field[5]) ? field[2] : field[5];
      const g2 = score(field[3]) >= score(field[4]) ? field[3] : field[4];
      field = [field[0], field[1], g1, g2];
    }
    while (field.length > 1) {
      const nxt = [];
      for (let i = 0; i < field.length / 2; i++) {
        const a = field[i]; const b = field[field.length - 1 - i];
        nxt.push(score(a) >= score(b) ? a : b);
      }
      field = nxt;
    }
    wonTitle[field[0]] += 1;
    for (let i = 0; i < n; i++) winsSum[i] += wins[i];
  }
  return teams.map((t, i) => ({
    name: t.name,
    playoff: Math.round((madePlayoffs[i] / sims) * 1000) / 1000,
    title: Math.round((wonTitle[i] / sims) * 1000) / 1000,
    avgWins: Math.round((winsSum[i] / sims) * 10) / 10,
  }));
}

/* -------------------------------------------- scheduled simulation (R42) */

/** Standard normal CDF via the Abramowitz–Stegun erf approximation
 *  (|error| < 1.5e-7) — deterministic, no lookup tables. */
export function normCdf(x) {
  // Φ(x) = (1 + erf(x/√2)) / 2 — the polynomial approximates erf, so it is
  // evaluated at x/√2, not x (the first draft got this wrong and its own
  // Φ(1.96)≈0.975 fixture caught it).
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** P(team A outscores team B in one week), under the same documented variance
 *  prior the Monte Carlo draws from. Closed form, so the week-by-week table
 *  and the season sim cannot disagree about what a matchup is worth. */
export function winProb(meanA, meanB, { sdFrac = SD_FRAC, sdMin = SD_MIN } = {}) {
  const a = Math.max(1, Number(meanA) || 1);
  const b = Math.max(1, Number(meanB) || 1);
  const sa = Math.max(sdFrac * a, sdMin);
  const sb = Math.max(sdFrac * b, sdMin);
  return normCdf((a - b) / Math.hypot(sa, sb));
}

/**
 * Monte Carlo a fantasy season on the league's REAL schedule.
 *
 * `weeks`: [{week, games: [{a, b, aPts, bPts, final}], unscheduled}] where
 * a/b index into `teams`. A `final` game contributes its actual result —
 * locked wins and points, nothing simulated. A non-final game is simulated
 * from the same variance prior as simulateLeague. A week flagged
 * `unscheduled` (Sleeper has not published its pairings yet) falls back to
 * one random pairing per sim — the caller must SAY that on the page.
 * A team with no game in a scheduled week simply idles (no points, no win).
 *
 * Playoffs: top `playoffSlots` by wins (points tiebreak), same seeded
 * bracket as simulateLeague (6 slots -> two byes).
 * Returns [{name, playoff, title, avgWins}] in input order. ESTIMATE.
 */
export function simulateLeagueScheduled(teams, weeks, {
  sims = 2000, seed = 20260901, playoffSlots = null,
  sdFrac = SD_FRAC, sdMin = SD_MIN,
} = {}) {
  const n = (teams || []).length;
  if (n < 2) return (teams || []).map((t) => ({ name: t.name, playoff: null, title: null, avgWins: null }));
  const slots = playoffSlots || (n >= 8 ? 6 : Math.max(2, Math.floor(n / 2)));
  const rng = mulberry32(seed);
  const means = teams.map((t) => Math.max(1, Number(t.weeklyMean) || 1));
  const sds = means.map((m) => Math.max(sdFrac * m, sdMin));
  const score = (i) => Math.max(0, means[i] + sds[i] * normal(rng));

  // The locked base: final games count once, outside the sim loop.
  const baseWins = new Array(n).fill(0);
  const basePts = new Array(n).fill(0);
  const weekList = Array.isArray(weeks) ? weeks : [];
  for (const wk of weekList) {
    for (const g of (wk.games || [])) {
      if (!g.final) continue;
      const ap = Number(g.aPts) || 0;
      const bp = Number(g.bPts) || 0;
      basePts[g.a] += ap; basePts[g.b] += bp;
      if (ap >= bp) baseWins[g.a] += 1; else baseWins[g.b] += 1;
    }
  }

  const madePlayoffs = new Array(n).fill(0);
  const wonTitle = new Array(n).fill(0);
  const winsSum = new Array(n).fill(0);

  for (let s = 0; s < sims; s++) {
    const wins = [...baseWins];
    const pts = [...basePts];
    for (const wk of weekList) {
      if (wk.unscheduled) {
        // Sleeper has not published this week's pairings — random pairing,
        // same as the schedule-blind sim, and said out loud by the caller.
        const order = [...Array(n).keys()];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (let i = 0; i + 1 < order.length; i += 2) {
          const a = order[i]; const b = order[i + 1];
          const sa = score(a); const sb = score(b);
          pts[a] += sa; pts[b] += sb;
          if (sa >= sb) wins[a] += 1; else wins[b] += 1;
        }
        continue;
      }
      for (const g of (wk.games || [])) {
        if (g.final) continue;
        const sa = score(g.a); const sb = score(g.b);
        pts[g.a] += sa; pts[g.b] += sb;
        if (sa >= sb) wins[g.a] += 1; else wins[g.b] += 1;
      }
    }
    const seeds = [...Array(n).keys()]
      .sort((a, b) => wins[b] - wins[a] || pts[b] - pts[a] || a - b)
      .slice(0, slots);
    for (const t of seeds) madePlayoffs[t] += 1;
    let field = seeds;
    if (slots === 6) {
      const g1 = score(field[2]) >= score(field[5]) ? field[2] : field[5];
      const g2 = score(field[3]) >= score(field[4]) ? field[3] : field[4];
      field = [field[0], field[1], g1, g2];
    }
    while (field.length > 1) {
      const nxt = [];
      for (let i = 0; i < field.length / 2; i++) {
        const a = field[i]; const b = field[field.length - 1 - i];
        nxt.push(score(a) >= score(b) ? a : b);
      }
      field = nxt;
    }
    wonTitle[field[0]] += 1;
    for (let i = 0; i < n; i++) winsSum[i] += wins[i];
  }
  return teams.map((t, i) => ({
    name: t.name,
    playoff: Math.round((madePlayoffs[i] / sims) * 1000) / 1000,
    title: Math.round((wonTitle[i] / sims) * 1000) / 1000,
    avgWins: Math.round((winsSum[i] / sims) * 10) / 10,
  }));
}

/**
 * The week-by-week table: every scheduled matchup with either its FINAL
 * result (never a probability — a played game is a fact) or the closed-form
 * win probability from the same prior the season sim draws from.
 * Returns [{week, unscheduled, games: [{a, b, aName, bName, final,
 * aPts, bPts, pA}]}]; pA is null on a final game.
 */
export function weeklyWinTable(teams, weeks, opts) {
  const list = Array.isArray(teams) ? teams : [];
  return (Array.isArray(weeks) ? weeks : []).map((wk) => ({
    week: wk.week,
    unscheduled: Boolean(wk.unscheduled),
    games: (wk.games || []).map((g) => ({
      a: g.a,
      b: g.b,
      aName: list[g.a] ? list[g.a].name : `#${g.a}`,
      bName: list[g.b] ? list[g.b].name : `#${g.b}`,
      final: Boolean(g.final),
      aPts: g.final ? (Number(g.aPts) || 0) : null,
      bPts: g.final ? (Number(g.bPts) || 0) : null,
      pA: g.final ? null
        : winProb(list[g.a] && list[g.a].weeklyMean, list[g.b] && list[g.b].weeklyMean, opts),
    })),
  }));
}
