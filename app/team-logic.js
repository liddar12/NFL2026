/* app/team-logic.js — THE FIT ENGINE (pure).
 *
 * Roster math + recommendation scoring for the TEAM tab. Every function here is
 * PURE: no DOM, no fetch, no storage, no Date — same inputs, same outputs, so
 * the unit tests (tests/feature/team_logic.test.mjs) import this file directly
 * under node with zero setup.
 *
 * Shapes (the build-contract shapes, byte-for-byte):
 *   projection player  { gsis_id, name, team, position, proj_points, ... }
 *   weekly entry       { gsis_id, receptions_prior, weeks: [ {wk, opp, home,
 *                        bye, pts} x18 ] }        (data/player_weekly.json)
 *   roster             { slots: { QB1,RB1,RB2,WR1,WR2,TE1,FLEX,
 *                        BN1..BN6: gsis_id|null } }  (localStorage nfl2026.team.v1)
 *   byId maps          Map or plain object keyed by String(gsis_id)
 *
 * Scoring conversion is EXACT via prior-season receptions (never a heuristic):
 * half = ppr − 0.5·rec, std = ppr − rec; weekly scales proportionally. All
 * points remain ESTIMATES — the weekly model is a labeled prior, not a measurement.
 *
 * Determinism invariant: no randomness, stable sorts, ties broken by season
 * points then gsis_id — recommend() output is reproducible byte-for-byte.
 *
 * ROSTER SHAPE IS DATA (R19-B4): every geometry constant below is the DEFAULT,
 * not the law. Each public function takes an OPTIONAL trailing `shape`
 * (fitScore/fitScoreV2 read it from ctx.shape); omit it and the arithmetic is
 * byte-for-byte what it has always been.
 */

import {
  normalizeProfile, rosterSlots, slotEligiblePositions, rosterPositionsInPlay,
  FLEX_ELIGIBILITY, BENCH_TOKEN,
} from './league.js';

/* --------------------------------------------------------------------------
 * Roster geometry
 * ------------------------------------------------------------------------ */

/** Starter slots in display/priority order (the weekly-total lineup). */
export const STARTER_SLOTS = Object.freeze(['QB1', 'RB1', 'RB2', 'WR1', 'WR2', 'TE1', 'FLEX']);

/** Bench slots. */
export const BENCH_SLOTS = Object.freeze(['BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6']);

/** All 13 slots, starters first — the "first eligible open slot" scan order. */
export const SLOT_ORDER = Object.freeze([...STARTER_SLOTS, ...BENCH_SLOTS]);

// Modeled positions only. No K / D-ST — the projection model does not cover
// them and we never fake numbers for them.
const MODELED = Object.freeze(['QB', 'RB', 'WR', 'TE']);
const FLEX_TAKES = Object.freeze(['RB', 'WR', 'TE']);

/* --------------------------------------------------------------------------
 * Fit-engine constants (build contract — do not tune without refitting tests)
 * ------------------------------------------------------------------------ */

export const W_PTS = 1.0;             // season points are the score backbone
export const STACK_BONUS = 12;        // same-team QB + WR/TE
export const BYE_COVER_BONUS = 6;     // per starter bye backfilled (cap below)
export const BYE_COVER_CAP = 12;      // covers beyond 2 add no score
export const BYE_CLASH_PENALTY = 10;  // per CURRENT STARTER sharing the bye
export const FLOOR_BONUS = 8;         // candidate raises the worst-week total
export const MATCHUP_BONUS_CAP = 8;   // complementary-schedule bonus ceiling
// Scale for the matchup bonus: bonus = min(cap, avg-strong-dip-week-pts × 0.4),
// so a ~20-pt dip-week performer hits the cap. Transparent prior, like TILT_COEF.
export const MATCHUP_SCALE = 0.4;

const EPS = 1e-9; // float comparisons ("raises", "dips") never flip on noise

/* --------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

/** Read from a Map or a plain object, keyed by String(id). */
function lookup(src, id) {
  if (src == null || id == null) return undefined;
  const key = String(id);
  return typeof src.get === 'function' ? src.get(key) : src[key];
}

/** Accept a weekly entry ({weeks:[...]}) or a bare weeks array; else null. */
function weeksOf(playerWeekly) {
  if (Array.isArray(playerWeekly)) return playerWeekly;
  if (playerWeekly && Array.isArray(playerWeekly.weeks)) return playerWeekly.weeks;
  return null;
}

/** Mean of an array (0 for empty — callers gate on emptiness themselves). */
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** Index of the minimum value (first hit — deterministic worst week). */
function argmin(arr) {
  let idx = 0;
  for (let i = 1; i < arr.length; i += 1) if (arr[i] < arr[idx]) idx = i;
  return idx;
}

/* --------------------------------------------------------------------------
 * ROSTER SHAPE AS DATA — the one geometry normaliser both engines read
 *
 * WHY: STARTER_SLOTS / SLOT_ORDER / POSITION_CAPS were frozen at the classic
 * 13-slot, one-QB roster, so a 2-QB league never got a third QB anywhere in the
 * reco panel, BEST PICK NOW or the simulated room, and a LIVE draft for any
 * other shape silently dropped won players. Everything below derives that
 * geometry from a shape instead.
 *
 * ACCEPTED SHAPES (pass any; pass nothing for the legacy path):
 *   * a LeagueProfile from app/league.js   { version, scoring, shape:{...} }
 *   * a bare profile shape                 { roster_positions:[...], teams, ... }
 *   * a draft-sim rosterShape              { config, starters:[...], bench:[...] }
 *
 * The returned geometry is READ-ONLY (cached per shape object) — treat it as
 * frozen; never mutate it.
 * ------------------------------------------------------------------------ */

/**
 * FLEX WIN SHARE — how often each eligible position actually WINS a flex slot.
 * A DOCUMENTED PRIOR (like MATCHUP_SCALE), not a measurement: the FLEX row is
 * literally the {RB .45, WR .45, TE .10} spread app/auction.js has always used,
 * extended to the other flex tokens so one definition covers both engines.
 * A slot whose eligibility the league overrode keeps only its eligible
 * positions and the shares are renormalised; an eligibility list this table
 * does not cover at all splits evenly.
 */
export const FLEX_WIN_SHARE = Object.freeze({
  FLEX: Object.freeze({ RB: 0.45, WR: 0.45, TE: 0.10 }),
  WRRB_FLEX: Object.freeze({ RB: 0.50, WR: 0.50 }),
  REC_FLEX: Object.freeze({ WR: 0.80, TE: 0.20 }),
  RB_TE_FLEX: Object.freeze({ RB: 0.80, TE: 0.20 }),
  SUPER_FLEX: Object.freeze({ QB: 0.90, RB: 0.04, WR: 0.04, TE: 0.02 }),
});

const _geoCache = new WeakMap();
let _legacyGeo = null;

function isLeagueProfile(s) {
  return Boolean(s) && typeof s === 'object' && Boolean(s.shape)
    && typeof s.shape === 'object' && Array.isArray(s.shape.roster_positions);
}

function isProfileShape(s) {
  return Boolean(s) && typeof s === 'object' && Array.isArray(s.roster_positions);
}

function isDraftShape(s) {
  return Boolean(s) && typeof s === 'object' && Array.isArray(s.starters)
    && Boolean(s.config) && typeof s.config === 'object';
}

/**
 * Starting slots a position can legally fill: its own fixed slots plus every
 * flex slot that accepts it (a SUPER_FLEX is a QB slot whenever a QB wins it).
 */
function startableDemand(pos, demand, flexSlots) {
  let n = demand[pos] || 0;
  flexSlots.forEach((f) => { if (f.positions.includes(pos)) n += 1; });
  return n;
}

/**
 * Is this cap set the app's OWN fallback rather than a league rule?
 *
 * normalizeProfile() fills shape.position_caps with POSITION_CAPS whenever the
 * league did not supply one, and the draft-shape path passes POSITION_CAPS
 * directly — so a cap set that is value-for-value the frozen fallback is a
 * DEFAULT, not something a league asked for. That is the only signal available
 * here: a normalised profile keeps no record of where its caps came from, so
 * comparing against the fallback is the honest test, and it deliberately errs
 * towards "default" (a league that happens to state exactly {QB:2,DEF:1,DST:1,
 * K:1} keeps the pre-R24 behaviour byte-for-byte).
 */
function capsAreAppDefault(baseCaps) {
  if (!baseCaps || typeof baseCaps !== 'object') return true;
  const keys = Object.keys(baseCaps);
  const defKeys = Object.keys(POSITION_CAPS);
  if (keys.length !== defKeys.length) return false;
  return defKeys.every((k) => Number(baseCaps[k]) === Number(POSITION_CAPS[k]));
}

/**
 * Effective roster caps. Base caps come from the shape (a profile's
 * position_caps, else POSITION_CAPS). Positions with no base cap stay
 * uncapped: RB/WR/TE are bounded by roster geometry (the FLEX + bench), not by
 * a hard count.
 *
 * THE DEFAULT set is raised to startableDemand + 1 — a league that STARTS two
 * QBs must be allowed a third for byes and injuries, which the frozen {QB:2}
 * silently forbade (REL15 #4).
 *
 * AN EXPLICIT set is raised ONLY when the league's own cap is at or above what
 * the league STARTS, and only when the app cannot tell that the cap is an
 * ENFORCED roster limit. The three cases settle different questions:
 *
 *   cap <  startableDemand   The league has deliberately capped BELOW its own
 *                            starting requirement (a SUPER_FLEX league that
 *                            limits QB to 1). Left exactly as stated: that is
 *                            the league's rule, and the flex slot it starves is
 *                            filled by the other eligible positions. Raising it
 *                            would be the app overruling the league it models.
 *   cap >= startableDemand,  Ambiguous, and resolved in the user's favour. A
 *   source unknown           hand-built league that STARTS two QBs and types
 *                            "QB: 2" is probably describing its starting
 *                            requirement, not banning a bye/injury backup, and
 *                            reading it as a ban is REL15 #4 all over again.
 *                            Raised to startableDemand + 1.
 *   cap >= startableDemand,  NOT ambiguous (R26). Sleeper's position_limit_* is
 *   source 'sleeper'         a field distinct from the starting lineup, and
 *                            Sleeper ENFORCES it: a league with
 *                            position_limit_QB = 2 will not let you roster a
 *                            third QB no matter how many it starts. Honoured
 *                            exactly. Raising it here made the app recommend
 *                            players the league forbids — advice that fails at
 *                            the draft, which is the worst place to find out.
 *
 * So the disagreement that sat open after R24 — "a stated cap is a ban" vs "a
 * stated cap describes the starting requirement" — was never one question. Both
 * readings are right about different inputs, and provenance says which applies.
 * Where provenance is absent (older saved profiles, paste-JSON, hand-builds)
 * the lenient reading stands, so nothing that worked before breaks.
 *
 * @param {string} [capsSource] 'sleeper' when the caps came from a real
 *   league's enforced position_limit_* settings; anything else (including
 *   undefined) means the app cannot prove they are a roster ban.
 */
function derivedCaps(baseCaps, demand, flexSlots, capsSource) {
  const appDefault = capsAreAppDefault(baseCaps);
  const enforced = capsSource === 'sleeper' && !appDefault;
  const out = {};
  Object.keys(baseCaps || {}).forEach((k) => {
    const pos = String(k).toUpperCase();
    const base = Number(baseCaps[k]);
    if (!Number.isFinite(base)) return;
    const startable = startableDemand(pos, demand, flexSlots);
    out[pos] = (!enforced && (appDefault || base >= startable))
      ? Math.max(base, startable + 1)
      : base;
  });
  return out;
}

/** The legacy geometry: exactly the frozen constants above, as data. */
function legacyGeometry() {
  if (_legacyGeo) return _legacyGeo;
  const eligibility = {};
  SLOT_ORDER.forEach((slot) => {
    if (slot === 'FLEX') eligibility[slot] = [...FLEX_TAKES];
    else if (BENCH_SLOTS.includes(slot)) eligibility[slot] = [...MODELED];
    else eligibility[slot] = [slot.replace(/\d+$/, '')];
  });
  _legacyGeo = {
    legacy: true,
    teams: 12,
    starters: [...STARTER_SLOTS],
    bench: [...BENCH_SLOTS],
    all: [...SLOT_ORDER],
    eligibility,
    positions: [...MODELED],
    demand: { ...STARTER_DEMAND },
    flexSlots: [{ slot: 'FLEX', token: 'FLEX', positions: [...FLEX_TAKES] }],
    caps: { ...POSITION_CAPS },
  };
  return _legacyGeo;
}

/** Geometry from a LeagueProfile (or a bare profile shape). */
function profileGeometry(profile) {
  const p = normalizeProfile(profile);
  const slots = rosterSlots(p);
  const eligibility = {};
  slots.all.forEach((slot) => { eligibility[slot] = slotEligiblePositions(slot, p); });
  const starterTokens = p.shape.roster_positions.filter((t) => t !== BENCH_TOKEN);
  const demand = {};
  const flexSlots = [];
  starterTokens.forEach((token, i) => {
    const slot = slots.starters[i];
    if (FLEX_ELIGIBILITY[token]) {
      flexSlots.push({ slot, token, positions: eligibility[slot] || [] });
    } else {
      demand[token] = (demand[token] || 0) + 1;
    }
  });
  return {
    legacy: false,
    teams: p.shape.teams,
    starters: slots.starters,
    bench: slots.bench,
    all: slots.all,
    eligibility,
    positions: rosterPositionsInPlay(p),
    demand,
    flexSlots,
    caps: derivedCaps(p.shape.position_caps, demand, flexSlots,
                      p.shape.position_caps_source),
  };
}

/**
 * Geometry from a draft-sim rosterShape. Slot IDs are already built there
 * (QB1, RB1, FLEX / FLEX1+FLEX2), so the token is the ID minus its trailing
 * digits.
 *
 * TEAM COUNT (R24-D): a rosterShape is a ROSTER, not a league — it carries a
 * team count only when the config it was built from did (rosterShape(draftCfg)
 * keeps draftCfg.leagueSize). Before R24-D this returned teams:12 regardless,
 * so replacementLevel()'s league-wide path priced an 8- and a 16-team draft
 * identically while claiming league size moves VOR. When there is no honest
 * count it is now null, and the one reader of it (replacementLevel) refuses
 * rather than assuming twelve.
 */
function draftShapeGeometry(shape) {
  const rawTeams = Number(shape.config && shape.config.leagueSize);
  const teams = Number.isFinite(rawTeams) && rawTeams > 0 ? Math.round(rawTeams) : null;
  const starters = shape.starters.map(String);
  const bench = Array.isArray(shape.bench) ? shape.bench.map(String) : [];
  const eligibility = {};
  const demand = {};
  const flexSlots = [];
  const positions = [];
  const addPos = (pos) => { if (pos && !positions.includes(pos)) positions.push(pos); };
  starters.forEach((slot) => {
    const token = slot.replace(/\d+$/, '').toUpperCase();
    if (token === 'FLEX') {
      eligibility[slot] = [...FLEX_TAKES];
      flexSlots.push({ slot, token: 'FLEX', positions: [...FLEX_TAKES] });
    } else {
      eligibility[slot] = [token];
      demand[token] = (demand[token] || 0) + 1;
      addPos(token);
    }
  });
  flexSlots.forEach((f) => f.positions.forEach(addPos));
  bench.forEach((slot) => { eligibility[slot] = [...positions]; });
  return {
    legacy: false,
    teams,
    starters,
    bench,
    all: [...starters, ...bench],
    eligibility,
    positions,
    demand,
    flexSlots,
    caps: derivedCaps(POSITION_CAPS, demand, flexSlots),
  };
}

/**
 * Normalise any accepted shape into the geometry every function below reads:
 *   { legacy, teams, starters[], bench[], all[], eligibility{slot:[POS]},
 *     positions[], demand{POS:int}, flexSlots[{slot,token,positions}],
 *     caps{POS:int} }
 * A null/undefined shape returns the LEGACY geometry — the frozen constants,
 * unchanged. Cached per shape object, so hot loops pay for it once.
 */
export function rosterGeometry(shape) {
  if (shape == null) return legacyGeometry();
  if (typeof shape !== 'object') return legacyGeometry();
  const hit = _geoCache.get(shape);
  if (hit) return hit;
  let geo;
  if (isLeagueProfile(shape)) geo = profileGeometry(shape);
  else if (isProfileShape(shape)) geo = profileGeometry({ shape });
  else if (isDraftShape(shape)) geo = draftShapeGeometry(shape);
  else geo = legacyGeometry();
  _geoCache.set(shape, geo);
  return geo;
}

/** The win-share split for ONE flex slot, restricted to what it accepts. */
function flexShareFor(flexSlot) {
  const table = FLEX_WIN_SHARE[flexSlot.token] || null;
  const positions = flexSlot.positions || [];
  const out = {};
  let sum = 0;
  positions.forEach((pos) => {
    const w = table && Number.isFinite(table[pos]) ? table[pos] : 0;
    out[pos] = w;
    sum += w;
  });
  if (sum <= 0) {
    positions.forEach((pos) => { out[pos] = positions.length ? 1 / positions.length : 0; });
    return out;
  }
  // Only renormalise when the shares genuinely do not sum to 1 — a float ulp
  // must never perturb the shares the auction engine has always used.
  if (Math.abs(sum - 1) > EPS) {
    positions.forEach((pos) => { out[pos] = out[pos] / sum; });
  }
  return out;
}

/**
 * FULL starter demand per position: fixed starting slots plus each flex slot's
 * win share. THE single definition of demand — app/auction.js fairDollars and
 * replacementLevel()'s shape-aware path both read it, so a FLEX no longer means
 * "+1 to whichever position owns the best player" in one engine and "spread
 * over RB/WR/TE" in the other. Positions the shape cannot roster are absent.
 */
export function positionDemand(shape) {
  const geo = rosterGeometry(shape);
  // Flex shares are summed FIRST and added to the fixed count once, so two
  // identical flex slots contribute exactly 2 x share — bit-for-bit what
  // app/auction.js computed as `flexCount * share`.
  const flexAdd = {};
  geo.flexSlots.forEach((f) => {
    const share = flexShareFor(f);
    Object.keys(share).forEach((pos) => { flexAdd[pos] = (flexAdd[pos] || 0) + share[pos]; });
  });
  const out = {};
  Object.keys(geo.demand).forEach((pos) => { out[pos] = geo.demand[pos]; });
  Object.keys(flexAdd).forEach((pos) => { out[pos] = (out[pos] || 0) + flexAdd[pos]; });
  return out;
}

/**
 * The 0-based rank of the REPLACEMENT player at a position: the last player
 * LEAGUE-WIDE who still fills a starting slot, i.e. round(demand x teams) - 1.
 * Shared by app/auction.js fairDollars and replacementLevel()'s shape-aware
 * path, so "this is a 10-team league" finally moves VOR in both engines.
 */
export function replacementIndex(demand, leagueSize) {
  const d = Number(demand);
  const n = Number(leagueSize);
  if (!Number.isFinite(d) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(d * n) - 1);
}

/* --------------------------------------------------------------------------
 * Contract exports
 * ------------------------------------------------------------------------ */

/**
 * Season points under a scoring mode. EXACT conversion via prior-season
 * receptions: half = ppr − 0.5·rec, std = ppr − rec; ppr passes through.
 * Unknown mode falls back to ppr (never throws — display code depends on it).
 */
export function scoringAdjust(seasonPpr, receptions, mode, extraPts) {
  const ppr = Number(seasonPpr) || 0;
  const rec = Number(receptions) || 0;
  // R29 — league scoring rules this app can price but the base projection does
  // not include. `extraPts` is already the POINTS (component x the league's
  // rate), computed once per player by withLeagueExtras() rather than derived
  // here, so this function stays a pure conversion and there is exactly one
  // place that knows a rate. Absent/0 -> byte-identical to the pre-R29 result.
  const extra = Number(extraPts) || 0;
  if (mode === 'half') return ppr - 0.5 * rec + extra;
  if (mode === 'std') return ppr - rec + extra;
  return ppr + extra;
}

/**
 * R29 — THE LEAGUE'S OWN SCORING, STAMPED ONTO THE WEEKLY ENTRIES.
 *
 * The problem this solves. A league scoring Sleeper's `pass_cmp` awards points
 * the base projection knows nothing about — 0.5 a completion is roughly 150-200
 * points a season for a starting quarterback, and it moved Dak Prescott +42.8
 * VOR and Jared Goff +37.3 in the measurement that justified this release.
 * Applying it means every surface must agree, and the obvious route — threading
 * a rate through the eight signatures that carry `mode` — is exactly the shape
 * of change whose QA caught a half-threaded profile in R19. Two surfaces
 * quoting different points for the same quarterback is a worse bug than not
 * pricing the rule at all.
 *
 * So the rate is applied ONCE, here, and rides on the weekly entry that every
 * call site already holds beside `receptions_prior`. There is one place that
 * knows a rate and one place that reads it.
 *
 * WHY THIS IS NOT BEHIND AI+. It is the league's scoring table, not a model
 * opinion. The reception value already re-prices globally the moment it
 * changes; this is the same kind of input arriving through the same import.
 * (Owner's call, 2026-08-14.)
 *
 * HONEST DATA. A player with no `completions_prior` gets NO extra — not a zero
 * that pretends to be a measurement. A league that does not score pass_cmp gets
 * the identical Map back, so nothing downstream can tell this ran.
 *
 * Returns a NEW Map; the input is never mutated (views hold it across repaints).
 */
export function withLeagueExtras(weeklyById, profile) {
  const rate = passCmpRate(profile);
  if (!(weeklyById instanceof Map) || !rate) return weeklyById;
  const out = new Map();
  for (const [id, entry] of weeklyById) {
    const cmp = entry && Number(entry.completions_prior);
    out.set(id, Number.isFinite(cmp) && cmp > 0
      ? { ...entry, extra_pts: Math.round(cmp * rate * 100) / 100 }
      : entry);
  }
  return out;
}

/** The league's points-per-completion, or 0 when it does not score them. */
export function passCmpRate(profile) {
  const v = profile && profile.scoring ? Number(profile.scoring.pass_cmp) : NaN;
  return Number.isFinite(v) ? v : 0;
}

/** The extra points stamped on an entry by withLeagueExtras(), or 0. */
export function extraPtsOf(entry) {
  const v = entry ? Number(entry.extra_pts) : NaN;
  return Number.isFinite(v) ? v : 0;
}

/**
 * The player's 18 weekly points rescaled to a scoring mode: each non-bye week
 * scales by season_adj/season_ppr (the season conversion redistributed
 * proportionally — weekly shares are reception-agnostic in the v1 model).
 * Byes are hard 0 (a zero-week, not a projection). ppr<=0 guards the division
 * (ratio 1: nothing to redistribute). Missing weekly data -> [].
 */
export function weeklyPoints(playerWeekly, seasonAdj, seasonPpr) {
  const weeks = weeksOf(playerWeekly);
  if (!weeks) return [];
  const ppr = Number(seasonPpr);
  const ratio = ppr > 0 ? Number(seasonAdj) / ppr : 1;
  return weeks.map((w) => (w && w.bye === true ? 0 : (Number(w && w.pts) || 0) * ratio));
}

/** The player's bye week number, or null if the weekly data carries none. */
export function byeWeek(playerWeekly) {
  const weeks = weeksOf(playerWeekly);
  if (!weeks) return null;
  const bye = weeks.find((w) => w && w.bye === true);
  return bye ? Number(bye.wk) : null;
}

/**
 * Can a player at `position` legally occupy `slot`? FLEX takes RB/WR/TE;
 * bench takes any MODELED position (QB/RB/WR/TE — never K/D-ST, not modeled).
 * Unknown slot or unmodeled position -> false.
 *
 * With a `shape` the answer comes from THAT roster's slots instead: a league
 * that starts a K has a K1 slot and a bench that accepts kickers. Eligibility
 * is geometry, not a projection — a K still scores whatever the model has for
 * it (nothing is fabricated).
 */
export function slotEligible(position, slot, shape) {
  const pos = String(position || '').toUpperCase();
  const s = String(slot || '').toUpperCase();
  if (shape != null) {
    const allowed = rosterGeometry(shape).eligibility[s];
    return Array.isArray(allowed) && allowed.includes(pos);
  }
  if (!MODELED.includes(pos)) return false;
  if (s === 'FLEX') return FLEX_TAKES.includes(pos);
  if (BENCH_SLOTS.includes(s)) return true;
  if (STARTER_SLOTS.includes(s)) return s.replace(/\d+$/, '') === pos;
  return false;
}

/**
 * 18 summed weekly floats for the STARTERS ONLY (the .team-weeks grid).
 * `starters` is an array of gsis_ids (nulls skipped; player objects with a
 * gsis_id also accepted). `weeklyById` values may be raw weekly entries
 * (summed at PPR) or pre-scaled 18-float arrays from weeklyPoints() — the
 * caller picks the scoring mode by pre-scaling.
 */
export function teamWeeklyTotals(starters, weeklyById) {
  const totals = new Array(18).fill(0);
  (Array.isArray(starters) ? starters : []).forEach((s) => {
    const id = s && typeof s === 'object' ? s.gsis_id : s;
    if (id == null) return;
    const entry = lookup(weeklyById, id);
    const arr = Array.isArray(entry)
      ? entry
      : weeklyPoints(entry, 1, 0); // ratio 1 -> raw PPR week pts, byes 0
    arr.forEach((p, i) => {
      if (i < 18) totals[i] += Number(p) || 0;
    });
  });
  return totals;
}

/* --------------------------------------------------------------------------
 * fitScore — score one candidate against the current roster
 * ------------------------------------------------------------------------ */

/** Resolve the starters (slot, player, weekly, scaled 18-array) for scoring. */
function resolveStarters(slots, playersById, weeklyById, mode, geo) {
  const out = [];
  (geo || legacyGeometry()).starters.forEach((slot) => {
    const id = slots[slot];
    if (!id) return;
    const player = lookup(playersById, id);
    const entry = lookup(weeklyById, id);
    const arr = player && entry
      ? weeklyPoints(entry, scoringAdjust(player.proj_points, entry.receptions_prior, mode, extraPtsOf(entry)), player.proj_points)
      : null;
    out.push({ slot, id: String(id), player, bye: entry ? byeWeek(entry) : null, arr });
  });
  return out;
}

/** Highest-adjusted-points player in a list (tie: gsis_id asc — deterministic). */
function bestOf(players, weeklyById, mode) {
  let best = null;
  let bestAdj = -Infinity;
  players.forEach((p) => {
    const e = lookup(weeklyById, p.gsis_id);
    const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e));
    if (adj > bestAdj + EPS || (Math.abs(adj - bestAdj) <= EPS && best && String(p.gsis_id) < String(best.gsis_id))) {
      best = p;
      bestAdj = adj;
    }
  });
  return best;
}

/**
 * Score `candidate` (a projection player) against `roster` for ctx.slot.
 * Returns { score, reasons: [string,...] } — reasons are REAL sentences
 * computed from the data, most impactful first, max 4 (the .reco-why lines).
 *
 * ctx: { playersById, weeklyById, mode='ppr', slot=null, shape=null }. With no
 * weekly data for the candidate the bye/floor/matchup terms simply contribute
 * 0 — the score degrades to season points (+stack), never throws. `shape` is
 * the roster geometry (see rosterGeometry); omit it for the legacy 13-slot one.
 */
export function fitScore(candidate, roster, ctx) {
  const c = ctx || {};
  const mode = c.mode === 'half' || c.mode === 'std' ? c.mode : 'ppr';
  const playersById = c.playersById;
  const weeklyById = c.weeklyById;
  const geo = rosterGeometry(c.shape);
  const slots = (roster && roster.slots) || {};

  const candEntry = lookup(weeklyById, candidate.gsis_id);
  const candAdj = scoringAdjust(candidate.proj_points, candEntry ? candEntry.receptions_prior : 0, mode, extraPtsOf(candEntry));
  const candArr = candEntry ? weeklyPoints(candEntry, candAdj, candidate.proj_points) : null;
  const candBye = candEntry ? byeWeek(candEntry) : null;
  const candPos = String(candidate.position || '').toUpperCase();

  const starters = resolveStarters(slots, playersById, weeklyById, mode, geo);

  // reasons carry their score impact so "most impactful first" is computed,
  // not asserted. Base term first: raw points dominate by design (W_PTS=1.0).
  const reasons = [];
  let score = candAdj * W_PTS;
  reasons.push({
    impact: candAdj * W_PTS,
    text: `Projects ${candAdj.toFixed(1)} season points (${mode.toUpperCase()}) — raw points drive the fit score`,
  });

  // STACK: same-team QB + receiver compound (both spike in the same games).
  // Scans the WHOLE roster (a bench stack still stacks); partner = best points.
  const rostered = Object.values(slots)
    .filter(Boolean)
    .map((id) => lookup(playersById, id))
    .filter(Boolean);
  let partners = [];
  if (candPos === 'WR' || candPos === 'TE') {
    partners = rostered.filter((p) => String(p.position).toUpperCase() === 'QB' && p.team === candidate.team);
  } else if (candPos === 'QB') {
    partners = rostered.filter((p) => ['WR', 'TE'].includes(String(p.position).toUpperCase()) && p.team === candidate.team);
  }
  const partner = bestOf(partners, weeklyById, mode);
  if (partner) {
    score += STACK_BONUS;
    reasons.push({
      impact: STACK_BONUS,
      text: `Stacks with ${partner.name} (${candidate.team}) — QB+receiver points compound in good weeks`,
    });
  }

  // BYE COVER: +6 per same-position starter whose bye week the candidate
  // actually plays through (capped at 12 — two covers is a full rotation).
  let coverTotal = 0;
  if (candArr) {
    starters.forEach((s) => {
      if (coverTotal >= BYE_COVER_CAP) return;
      if (!s.player || String(s.player.position).toUpperCase() !== candPos) return;
      if (s.bye == null || s.bye === candBye) return;
      if (!(candArr[s.bye - 1] > EPS)) return; // candidate must play that week
      coverTotal += BYE_COVER_BONUS;
      score += BYE_COVER_BONUS;
      reasons.push({
        impact: BYE_COVER_BONUS,
        text: `Covers ${s.player.name}'s Week ${s.bye} bye at ${candPos}`,
      });
    });
  }

  // BYE CLASH: −10 per CURRENT STARTER sharing the candidate's bye — stacked
  // byes zero out a whole week. One combined reason names every clasher.
  if (candBye != null) {
    const clashers = starters.filter((s) => s.player && s.bye === candBye);
    if (clashers.length > 0) {
      const pen = BYE_CLASH_PENALTY * clashers.length;
      score -= pen;
      reasons.push({
        impact: -pen,
        text: `Shares Week ${candBye} bye with ${clashers.map((s) => s.player.name).join(', ')} — stacking byes creates a zero-week`,
      });
    }
  }

  // Starter weekly totals (current lineup) feed the floor + matchup terms.
  const anyStarterWeeks = starters.some((s) => s.arr);
  const totals = teamWeeklyTotals(
    starters.filter((s) => s.arr).map((s) => s.id),
    new Map(starters.filter((s) => s.arr).map((s) => [s.id, s.arr])),
  );

  // FLOOR: does slotting the candidate in (replacing any incumbent in the
  // target slot) raise the worst starter week? Bench adds never move the floor.
  const targetSlot = c.slot
    || geo.starters.find((s) => !slots[s] && slotEligible(candPos, s, c.shape))
    || null;
  if (candArr && anyStarterWeeks && targetSlot && geo.starters.includes(targetSlot)) {
    const withoutIncumbent = starters.filter((s) => s.slot !== targetSlot && s.arr);
    const base = teamWeeklyTotals(
      withoutIncumbent.map((s) => s.id),
      new Map(withoutIncumbent.map((s) => [s.id, s.arr])),
    );
    const next = base.map((t, i) => t + candArr[i]);
    const oldWorst = argmin(totals);
    const newFloor = next[argmin(next)];
    if (newFloor > totals[oldWorst] + EPS) {
      score += FLOOR_BONUS;
      reasons.push({
        impact: FLOOR_BONUS,
        text: `Raises your floor: worst week improves W${oldWorst + 1} ${totals[oldWorst].toFixed(1)} → ${newFloor.toFixed(1)}`,
      });
    }
  }

  // MATCHUP (complementary schedules): weeks where the current starters dip
  // below their own average AND the candidate beats their own non-bye average.
  // Bonus scales with the candidate's output in those weeks, capped at 8.
  if (candArr && anyStarterWeeks) {
    const avg = mean(totals);
    const candPlays = candArr.filter((p) => p > EPS);
    const candAvg = mean(candPlays);
    const strong = [];
    totals.forEach((t, i) => {
      if (t < avg - EPS && candArr[i] > candAvg + EPS) strong.push(i + 1);
    });
    if (strong.length > 0) {
      const strongAvg = mean(strong.map((wk) => candArr[wk - 1]));
      const bonus = Math.min(MATCHUP_BONUS_CAP, strongAvg * MATCHUP_SCALE);
      score += bonus;
      // Show the top 3 weeks by candidate points, listed in week order.
      const shown = strong
        .slice()
        .sort((a, b) => candArr[b - 1] - candArr[a - 1] || a - b)
        .slice(0, 3)
        .sort((a, b) => a - b);
      reasons.push({
        impact: bonus,
        text: `Strong Weeks ${shown.join(', ')} when your starters face tough matchups`,
      });
    }
  }

  // Most impactful first (|impact| desc; Array.sort is stable, so equal-impact
  // reasons keep computation order), max 4 shown.
  reasons.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return {
    score: Math.round(score * 100) / 100,
    reasons: reasons.slice(0, 4).map((r) => r.text),
  };
}

/* --------------------------------------------------------------------------
 * recommend — top-5 candidates for a slot
 * ------------------------------------------------------------------------ */

/**
 * The neediest OPEN slot: among open starter slots, the one leaving the most
 * projected points on the table (best available eligible candidate's adjusted
 * season points; tie -> earlier in STARTER_SLOTS order). Starters always
 * outrank bench; with starters full it is the first open bench slot; full
 * roster -> null. Exported so the view labels the .reco panel with the SAME
 * slot recommend() resolves.
 */
export function neediestOpenSlot(roster, pool, weeklyById, mode, shape) {
  const slots = (roster && roster.slots) || {};
  const players = Array.isArray(pool) ? pool : [];
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));
  const geo = rosterGeometry(shape);

  const openStarters = geo.starters.filter((s) => !slots[s]);
  if (openStarters.length === 0) return geo.bench.find((s) => !slots[s]) || null;

  let best = openStarters[0];
  let bestAdj = -Infinity;
  openStarters.forEach((slot) => {
    let top = -Infinity;
    players.forEach((p) => {
      if (rostered.has(String(p.gsis_id)) || !slotEligible(p.position, slot, shape)) return;
      const e = lookup(weeklyById, p.gsis_id);
      const adj = scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e));
      if (adj > top) top = adj;
    });
    if (top > bestAdj + EPS) {
      best = slot;
      bestAdj = top;
    }
  });
  return best;
}

/**
 * Top-5 { player, score, reasons } for `slot` (or the neediest open slot when
 * omitted), scored by fitScore against the current roster. Excludes rostered
 * players. Deterministic: score desc, then adjusted season points desc, then
 * gsis_id asc. Full roster with no slot given -> []. Trailing `shape` (optional)
 * swaps in that league's slots and caps — a 2-QB league proposes a third QB.
 */
export function recommend(roster, pool, weeklyById, mode, slot, opts, shape) {
  const players = Array.isArray(pool) ? pool : [];
  const slots = (roster && roster.slots) || {};
  const target = slot || neediestOpenSlot(roster, players, weeklyById, mode, shape);
  if (!target) return [];

  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));
  const sortMode = opts && opts.sort === 'available' ? 'available' : 'fit';

  const scored = players
    // Exclude rostered ids, slot-ineligible positions, AND positions already at
    // their roster cap (the shape's caps) — no over-cap add is ever proposed
    // for a bench slot.
    .filter((p) => !rostered.has(String(p.gsis_id))
      && slotEligible(p.position, target, shape)
      && !positionAtCap(p.position, slots, playersById, shape))
    .map((p) => {
      const e = lookup(weeklyById, p.gsis_id);
      return {
        player: p,
        adj: scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e)),
        ...fitScore(p, roster, { playersById, weeklyById, mode, slot: target, shape }),
      };
    });

  const affordable = affordableOnly(scored, opts && opts.budget, sortMode);
  sortScored(affordable, sortMode);
  return affordable.slice(0, 5).map(({ player, score, reasons }) => ({ player, score, reasons }));
}

/**
 * R27 — the auction dollar constraint, applied to BEST FIT and to BEST FIT ONLY.
 *
 * The fit engine was budget-blind: in an auction room it would happily rank a
 * $60 player first while the manager had $12 left, which is not a
 * recommendation, it is a distraction at the one moment the manager cannot
 * afford one.
 *
 * WHY ONLY 'fit'. BEST AVAILABLE answers "who is the best player left on the
 * board", and that question has a correct answer that does not depend on my
 * wallet — filtering it would make the board lie about what is out there.
 * BEST FIT answers "what should I do next", which is exactly where a $12
 * ceiling belongs. (Owner's call, 2026-08-14.)
 *
 * WHAT THIS IS NOT: it does not re-rank by value-per-dollar, and it does not
 * touch any player's projection. It removes what cannot be bought and leaves
 * the ordering of what remains exactly as it was — a roster-construction
 * constraint, never a projection input.
 *
 * `budget` is {cap, priceById}: the most this manager may legally commit to
 * ONE player (auction.js maxBid, which already reserves $1 per other open
 * slot), and the price map to test against. Passing nothing is the snake case
 * and changes nothing. Players with no known price are KEPT: an unpriced
 * player is unknown, not unaffordable, and dropping them would silently shrink
 * the board (HONEST DATA — skip loudly, never quietly).
 */
function affordableOnly(scored, budget, sortMode) {
  if (sortMode !== 'fit' || !budget || !Number.isFinite(budget.cap)) return scored;
  const priceById = budget.priceById instanceof Map ? budget.priceById : null;
  if (!priceById) return scored;
  const out = scored.filter((s) => {
    const price = priceById.get(String(s.player.gsis_id));
    return !Number.isFinite(price) || price <= budget.cap;
  });
  // Never hand back an empty panel: if the ceiling excludes everything, the
  // honest answer is the unfiltered list with the ceiling stated in the view,
  // not a blank card that reads as "no players exist".
  return out.length ? out : scored;
}

/**
 * Deterministic in-place sort of scored reco rows.
 *   'fit'       (default) — fit score desc, then adjusted points, then id
 *   'available' — raw adjusted points desc, then fit score, then id
 * Both fully break ties on gsis_id so the order is reproducible byte-for-byte.
 */
function sortScored(scored, sortMode) {
  if (sortMode === 'available') {
    scored.sort((a, b) =>
      b.adj - a.adj
      || b.score - a.score
      || (String(a.player.gsis_id) < String(b.player.gsis_id) ? -1 : 1));
  } else {
    scored.sort((a, b) =>
      b.score - a.score
      || b.adj - a.adj
      || (String(a.player.gsis_id) < String(b.player.gsis_id) ? -1 : 1));
  }
}

/* --------------------------------------------------------------------------
 * FIT ENGINE v2 — the opt-in AI layer (ctx.ai === true)
 *
 * v2 = v1 EXACTLY (fitScore above is untouched — the OFF path is byte-
 * identical) plus bounded terms read from data/ai_insights.json (built by
 * scripts/ai_estimates.py — documented deterministic rules; every value
 * carries source "measured" | "ai_estimated" and the reasons below say which).
 * AI-estimated reasons always carry the literal "(AI estimate" marker so the
 * view can chip them; measured reasons cite their span. Insight values are
 * contract-bounded to |0.25|, so each term below is bounded too.
 * ------------------------------------------------------------------------ */

export const TRAJECTORY_SCALE = 40;  // fit pts per unit trajectory_adj (±0.25 -> ±10)
export const COLD_SCALE = 5;         // fit pts per cold-venue week per unit cold_adj
export const COLD_WEEKS_CAP = 4;     // cold weeks beyond 4 add no score (±0.25 -> ±5)
export const V2_REASON_CAP = 6;      // v1's 4 + up to 2 highest-impact AI reasons

/** Provenance suffixes (the contract strings — tests match on these). */
const PROV_MEASURED = '(measured 2021–2025)';
const PROV_ESTIMATED = '(AI estimate — fewer than 3 seasons observed)';

/** Accept the whole ai_insights.json doc ({players:{...}}) or a bare map. */
function insightFor(insights, id) {
  const map = insights && insights.players ? insights.players : insights;
  return lookup(map, id) || null;
}

/** Same-team QB+receiver stack partner (v2's copy — v1's inline scan stays
 * untouched). Returns the best-points partner or null. */
function stackPartner(candidate, slots, playersById, weeklyById, mode) {
  const candPos = String(candidate.position || '').toUpperCase();
  const rostered = Object.values(slots)
    .filter(Boolean)
    .map((id) => lookup(playersById, id))
    .filter(Boolean);
  let partners = [];
  if (candPos === 'WR' || candPos === 'TE') {
    partners = rostered.filter((p) => String(p.position).toUpperCase() === 'QB' && p.team === candidate.team);
  } else if (candPos === 'QB') {
    partners = rostered.filter((p) => ['WR', 'TE'].includes(String(p.position).toUpperCase()) && p.team === candidate.team);
  }
  return bestOf(partners, weeklyById, mode);
}

/**
 * Score `candidate` with the AI layer ON. Same ctx as fitScore plus:
 *   ai        MUST be exactly true to add anything (else v1 passthrough)
 *   insights  data/ai_insights.json doc or its players map
 * Returns { score, reasons } in the SAME shape as fitScore. Missing insight
 * data for the candidate degrades to the v1 result — never throws.
 */
export function fitScoreV2(candidate, roster, ctx) {
  const base = fitScore(candidate, roster, ctx);
  const c = ctx || {};
  if (c.ai !== true) return base;
  const ins = insightFor(c.insights, candidate.gsis_id);
  if (!ins) return base;

  const candPos = String(candidate.position || '').toUpperCase();
  const extra = []; // {impact, text} — merged after v1's reasons, |impact| desc

  // TRAJECTORY_TERM — 5-yr trend (measured OLS) or age-curve prior (estimated).
  const t = ins.trajectory_adj;
  if (t && Number.isFinite(Number(t.value)) && Number(t.value) !== 0) {
    const v = Number(t.value);
    const impact = v * TRAJECTORY_SCALE;
    const prov = t.source === 'measured' ? PROV_MEASURED : PROV_ESTIMATED;
    let text;
    if (v > 0) {
      // Cite the real pts/yr when the insight carries it (the emitted file
      // always does); a minimal fixture falls back to the builder's norm.
      const slope = Number.isFinite(Number(t.slope_pts_per_yr))
        ? Number(t.slope_pts_per_yr)
        : v * 200;
      const n = Number(t.seasons_observed);
      const span = Number.isFinite(n) && n > 0 ? ` over ${n} season${n === 1 ? '' : 's'}` : '';
      text = `Trending up: +${slope.toFixed(1)} pts/yr${span} ${prov}`;
    } else {
      const provDown = t.source === 'measured' ? '(source: measured 2021–2025)' : prov;
      text = `Declining faster than the ${candPos} age curve ${provDown}`;
    }
    extra.push({ impact, text });
  }

  // STACK SYNERGY — scales the flat v1 stack bonus, only when a stack exists.
  const s = ins.stack_synergy;
  if (s && Number.isFinite(Number(s.value)) && Number(s.value) !== 0) {
    const partner = stackPartner(candidate, (roster && roster.slots) || {}, c.playersById, c.weeklyById,
      c.mode === 'half' || c.mode === 'std' ? c.mode : 'ppr');
    if (partner) {
      const impact = Number(s.value) * STACK_BONUS;
      const pair = s.pair || (candPos === 'QB' ? 'QB+WR' : `QB+${candPos}`);
      const prov = s.source === 'measured'
        ? PROV_MEASURED
        : '(AI estimate — position-pair default)';
      extra.push({
        impact,
        text: `Stack synergy with ${partner.name}: ${pair} pairs compound beyond the base stack bonus ${prov}`,
      });
    }
  }

  // COLD_TERM — the team's sub-32F delta applied to its cold-venue weeks.
  const cold = ins.cold_adj;
  const coldWeeks = cold && Array.isArray(cold.weeks)
    ? cold.weeks.map(Number).filter((w) => Number.isFinite(w))
    : [];
  if (cold && Number.isFinite(Number(cold.value)) && Number(cold.value) !== 0
      && coldWeeks.length > 0) {
    const v = Number(cold.value);
    const impact = v * COLD_SCALE * Math.min(coldWeeks.length, COLD_WEEKS_CAP);
    const pct = Math.abs(v * 100).toFixed(0);
    const prov = cold.source === 'measured'
      ? PROV_MEASURED
      : '(AI estimate — no team-specific cold sample)';
    const word = v > 0 ? 'edge' : 'risk';
    const sign = v > 0 ? '+' : '−';
    const wkWord = coldWeeks.length === 1 ? 'Week' : 'Weeks';
    extra.push({
      impact,
      text: `Cold-weather ${word}: ${sign}${pct}% win rate below 32°F in ${wkWord} ${coldWeeks.join(', ')} ${prov}`,
    });
  }

  extra.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const score = Math.round((base.score + extra.reduce((sum, r) => sum + r.impact, 0)) * 100) / 100;
  return {
    score,
    reasons: base.reasons.concat(extra.map((r) => r.text)).slice(0, V2_REASON_CAP),
  };
}

/**
 * recommend() with the AI layer ON: same candidate filter, same deterministic
 * tie-breaks (score desc, adjusted points desc, gsis_id asc), scored by
 * fitScoreV2 with `insights`. The OFF path keeps using recommend() — this
 * function exists so the v1 ranking code stays byte-identical.
 */
export function recommendV2(roster, pool, weeklyById, mode, slot, insights, opts, shape) {
  const players = Array.isArray(pool) ? pool : [];
  const slots = (roster && roster.slots) || {};
  const target = slot || neediestOpenSlot(roster, players, weeklyById, mode, shape);
  if (!target) return [];

  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));
  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));
  const sortMode = opts && opts.sort === 'available' ? 'available' : 'fit';

  const scored = players
    .filter((p) => !rostered.has(String(p.gsis_id))
      && slotEligible(p.position, target, shape)
      && !positionAtCap(p.position, slots, playersById, shape))
    .map((p) => {
      const e = lookup(weeklyById, p.gsis_id);
      const ctx = { playersById, weeklyById, mode, slot: target, shape };
      // base = the v1 fit score (AI OFF); v2 adds the bounded AI terms. Carrying
      // both lets the view show a visible base -> AI+ delta on every pick.
      const base = fitScore(p, roster, ctx).score;
      return {
        player: p,
        adj: scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e)),
        base,
        ...fitScoreV2(p, roster, { ...ctx, ai: true, insights }),
      };
    });

  const affordable = affordableOnly(scored, opts && opts.budget, sortMode);
  sortScored(affordable, sortMode);
  return affordable.slice(0, 5).map(({ player, score, reasons, base }) => ({
    player, score, reasons, base,
  }));
}

/* --------------------------------------------------------------------------
 * REL2 — roster position caps, reco sort, strength-of-schedule, trend labels
 * ------------------------------------------------------------------------ */

/**
 * Roster caps by position — a fantasy roster never needs a 3rd QB, a 2nd
 * defense, or a 2nd kicker, so the fit engine stops recommending a position
 * once its cap is reached (the "why does it keep pushing QBs?" fix). Positions
 * NOT listed here are uncapped: RB/WR/TE are bounded by roster geometry (the
 * FLEX + bench), not by a hard count. DEF/DST/K are listed and ready even
 * though the projection model does not cover them yet (no slots, no fabricated
 * numbers) — the cap holds the moment they are ever added to the pool.
 *
 * THESE ARE THE DEFAULTS FOR THE DEFAULT SHAPE. Pass a shape and the caps are
 * derived from it (see rosterGeometry): a league that starts two QBs caps QB at
 * three, so it can carry a bye/injury backup for a lineup that must start two.
 */
export const POSITION_CAPS = Object.freeze({ QB: 2, DEF: 1, DST: 1, K: 1 });

/** Count rostered players by uppercased position. */
export function rosteredCountByPos(slots, playersById) {
  const counts = {};
  Object.values(slots || {}).filter(Boolean).forEach((id) => {
    const p = lookup(playersById, id);
    if (!p) return;
    const pos = String(p.position || '').toUpperCase();
    counts[pos] = (counts[pos] || 0) + 1;
  });
  return counts;
}

/**
 * Has `position` already reached its roster cap? Uncapped positions never do.
 * Used to drop capped-position candidates from recommend()/recommendV2 so the
 * engine never proposes an over-cap add (e.g. a 3rd QB for a bench slot in a
 * ONE-QB league). Trailing `shape` (optional) uses that league's derived caps.
 */
export function positionAtCap(position, slots, playersById, shape) {
  const pos = String(position || '').toUpperCase();
  const cap = shape == null ? POSITION_CAPS[pos] : rosterGeometry(shape).caps[pos];
  if (cap == null) return false;
  return (rosteredCountByPos(slots, playersById)[pos] || 0) >= cap;
}

/**
 * Per-player STRENGTH OF SCHEDULE on a 1.0 (easiest) .. 5.0 (hardest) scale,
 * one decimal. `weeks` is a player_weekly entry ({weeks:[...]}) or a bare weeks
 * array; `teamStrength` is data/team_strength.json ({ratings:{team:elo}, ...}).
 *
 * Difficulty = the mean Elo of the player's real (non-bye) opponents, mapped
 * around the 1500 league mean at a transparent, fixed sensitivity: every
 * SOS_ELO_PER_POINT Elo of average-opponent strength above/below 1500 moves the
 * rating one full step, clamped to [1,5]. A fixed sensitivity (not a per-slate
 * re-normalization) keeps a player's SoS stable as the pool filters. Returns
 * null when weekly opponents or ratings are unavailable (caller shows nothing).
 */
export const SOS_ELO_PER_POINT = 25;

export function strengthOfSchedule(weeks, teamStrength) {
  const arr = weeksOf(weeks);
  const ratings = teamStrength && teamStrength.ratings ? teamStrength.ratings : null;
  if (!arr || !ratings) return null;
  const opps = [];
  arr.forEach((w) => {
    if (!w || w.bye === true) return;
    const key = String(w.opp == null ? '' : w.opp).toUpperCase();
    const r = ratings[key] != null ? ratings[key] : ratings[w.opp];
    if (Number.isFinite(Number(r))) opps.push(Number(r));
  });
  if (opps.length === 0) return null;
  const meanOpp = opps.reduce((a, b) => a + b, 0) / opps.length;
  const raw = 3.0 + (meanOpp - 1500) / SOS_ELO_PER_POINT;
  return Math.round(Math.max(1, Math.min(5, raw)) * 10) / 10;
}

/**
 * Normalize a trajectory insight (ai_insights trajectory_adj, or a
 * player_history trajectory) into a display-ready trend:
 *   { dir: 'up'|'down'|'flat', slope_pts_per_yr|null, seasons|null,
 *     source: 'measured'|'ai_estimated' }
 * `dir` comes from the signed adjustment when present (ai_insights carries
 * `value`), else from the raw OLS slope (player_history carries
 * `slope_pts_per_yr`). Missing/zero -> 'flat'. Never throws. Pure.
 */
export function trendLabel(traj) {
  if (!traj || typeof traj !== 'object') return null;
  const source = traj.source === 'measured' ? 'measured' : 'ai_estimated';
  const slope = Number.isFinite(Number(traj.slope_pts_per_yr))
    ? Number(traj.slope_pts_per_yr) : null;
  const seasons = Number.isFinite(Number(traj.seasons_observed))
    ? Number(traj.seasons_observed) : null;
  // Direction: prefer the signed adjustment (value); fall back to raw slope.
  let signal = null;
  if (Number.isFinite(Number(traj.value))) signal = Number(traj.value);
  else if (slope != null) signal = slope;
  const dir = signal == null || signal === 0 ? 'flat' : (signal > 0 ? 'up' : 'down');
  return { dir, slope_pts_per_yr: slope, seasons, source };
}

/* --------------------------------------------------------------------------
 * VOR - value over replacement + BEST PICK NOW (draft-time pick ranking)
 * ------------------------------------------------------------------------ */

/**
 * Starter demand per position: how many starting slots each position must
 * fill on a legal lineup (QB1 / RB1+RB2 / WR1+WR2 / TE1). The FLEX slot is
 * absorbed here rather than modeled separately: it adds +1 demand to whichever
 * of RB/WR/TE currently owns the BEST available player (highest adjusted
 * season points; tie broken RB before WR before TE), because that is the
 * position the FLEX would realistically be filled from.
 *
 * THAT WINNER-TAKES-ALL FLEX IS THE LEGACY (no-shape) RULE. With a shape,
 * positionDemand() spreads each flex slot by FLEX_WIN_SHARE instead — the same
 * spread app/auction.js uses, so the two engines agree.
 */
export const STARTER_DEMAND = Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1 });

/** Scarcity threshold: at or below this many startable (at-or-above the
 * replacement level) players left at a position, bestPickNow adds a
 * "drying up" reason line. */
export const VOR_SCARCITY_MAX = 3;

/** Adjusted season points for a projection player at a scoring mode. */
function adjOf(p, weeklyById, mode) {
  const e = lookup(weeklyById, p.gsis_id);
  return scoringAdjust(p.proj_points, e ? e.receptions_prior : 0, mode, extraPtsOf(e));
}

/** Pool rows at `position`, sorted adjusted points desc, tie gsis_id asc. */
function rankedAtPos(pool, weeklyById, mode, position) {
  const pos = String(position || '').toUpperCase();
  return (Array.isArray(pool) ? pool : [])
    .filter((p) => String(p.position || '').toUpperCase() === pos)
    .map((p) => ({ p, adj: adjOf(p, weeklyById, mode) }))
    .sort((a, b) => b.adj - a.adj
      || (String(a.p.gsis_id) < String(b.p.gsis_id) ? -1 : 1));
}

/** The FLEX-absorbing position: the RB/WR/TE whose best available player has
 * the highest adjusted points (tie: earlier in RB, WR, TE order). */
function flexAbsorbPos(pool, weeklyById, mode) {
  let best = 'RB';
  let bestAdj = -Infinity;
  FLEX_TAKES.forEach((pos) => {
    const top = rankedAtPos(pool, weeklyById, mode, pos)[0];
    if (top && top.adj > bestAdj + EPS) {
      best = pos;
      bestAdj = top.adj;
    }
  });
  return best;
}

/**
 * REPLACEMENT LEVEL at `position`: the adjusted season points of the player a
 * manager could still get "for free", the (starterDemand+1)th best available
 * at that position, where starterDemand comes from STARTER_DEMAND with the
 * FLEX absorbed as +1 on the RB/WR/TE owning the best available player (see
 * STARTER_DEMAND). Fewer than demand+1 players available -> 0 (there is no
 * replacement; everything left is a starter). Unmodeled position -> 0.
 *
 * WITH A SHAPE (trailing, optional) the replacement is LEAGUE-WIDE and matches
 * app/auction.js exactly: round(demand x teams) - 1 into the ranked list, with
 * demand = positionDemand(shape) (fixed slots + each flex slot's win share).
 * That is what makes "this is a 10-team league" move VOR at all, and what stops
 * the two engines disagreeing about who the FLEX belongs to. A pool shallower
 * than that index clamps to the worst available player — league-wide, every
 * one of them IS replacement level.
 *
 * A shape with NO honest team count (a bare draft-sim rosterShape, whose config
 * carries no leagueSize) THROWS rather than silently pricing the league as a
 * 12-team one: "league size moves VOR" and "we quietly assume twelve" cannot
 * both be true, and the wrong one of those is unreadable from the number that
 * comes back. Pass a LeagueProfile, or build the rosterShape from a config that
 * states leagueSize.
 */
export function replacementLevel(pool, weeklyById, mode, position, shape) {
  const pos = String(position || '').toUpperCase();
  if (shape == null) {
    const demand = STARTER_DEMAND[pos];
    if (demand == null) return 0;
    const extra = FLEX_TAKES.includes(pos)
      && flexAbsorbPos(pool, weeklyById, mode) === pos ? 1 : 0;
    const ranked = rankedAtPos(pool, weeklyById, mode, pos);
    const row = ranked[demand + extra]; // 0-based: index d == the (d+1)th best
    return row ? Math.round(row.adj * 100) / 100 : 0;
  }
  const demand = positionDemand(shape)[pos];
  if (demand == null) return 0;
  const teams = rosterGeometry(shape).teams;
  if (!(Number.isFinite(teams) && teams > 0)) {
    throw new TypeError('replacementLevel(): this shape carries no league size — '
      + 'pass a LeagueProfile, or a rosterShape built from a config with leagueSize');
  }
  const ranked = rankedAtPos(pool, weeklyById, mode, pos);
  if (ranked.length === 0) return 0;
  const idx = Math.min(replacementIndex(demand, teams), ranked.length - 1);
  return Math.round(ranked[idx].adj * 100) / 100;
}

/**
 * VALUE OVER REPLACEMENT for one candidate: adjusted season points minus the
 * replacement level at the candidate's own position (same pool, same mode).
 * Positive = worth drafting ahead of need; near zero = wait, a same-value
 * player will still be there. Trailing `shape` is optional (see above).
 */
export function vorScore(candidate, pool, weeklyById, mode, shape) {
  const adj = adjOf(candidate, weeklyById, mode);
  const repl = replacementLevel(pool, weeklyById, mode, candidate.position, shape);
  return Math.round((adj - repl) * 100) / 100;
}

/**
 * BEST PICK NOW: the top-3 available players ranked by VOR, i.e. who to draft
 * THIS pick. Candidates must be eligible for at least one OPEN slot on the
 * roster (starters or bench), not already rostered, and not at their
 * POSITION_CAPS cap. Replacement levels are computed from the AVAILABLE pool
 * (pool minus rostered ids), so the ranking re-optimizes live as players are
 * taken. Deterministic: VOR desc, then adjusted points desc, then gsis_id asc.
 *
 * Returns [{ player, vor, replacement, reasons: [string,...] }] where reasons
 * are real sentences: the VOR line always, plus a scarcity line when the
 * position's startable supply (at-or-above replacement) is at most
 * VOR_SCARCITY_MAX.
 * opts.limit overrides the row count (default 3).
 * Trailing `shape` (optional) supplies the league's slots, caps and demand.
 */
export function bestPickNow(roster, pool, weeklyById, mode, opts, shape) {
  const players = Array.isArray(pool) ? pool : [];
  const slots = (roster && roster.slots) || {};
  const limit = opts && Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : 3;
  const geo = rosterGeometry(shape);

  const rostered = new Set(Object.values(slots).filter(Boolean).map(String));
  const openSlots = geo.all.filter((s) => !slots[s]);
  const playersById = new Map(players.map((p) => [String(p.gsis_id), p]));

  // Replacement math sees only what is actually still available.
  const available = players.filter((p) => !rostered.has(String(p.gsis_id)));

  // Per-position replacement level + STARTABLE supply, computed once.
  // Startable = at or above the replacement level (the replacement player is
  // the last startable one); with fewer than demand+1 left the replacement is
  // 0 and everyone still projecting points counts. Supply <= VOR_SCARCITY_MAX
  // triggers the "drying up" reason line below.
  const replByPos = {};
  const supplyByPos = {};
  geo.positions.forEach((pos) => {
    const repl = replacementLevel(available, weeklyById, mode, pos, shape);
    replByPos[pos] = repl;
    const ranked = rankedAtPos(available, weeklyById, mode, pos);
    supplyByPos[pos] = repl > 0
      ? ranked.filter((r) => r.adj >= repl - EPS).length
      : ranked.filter((r) => r.adj > EPS).length;
  });

  const scored = available
    .filter((p) => !positionAtCap(p.position, slots, playersById, shape)
      && openSlots.some((s) => slotEligible(p.position, s, shape)))
    .map((p) => {
      const pos = String(p.position || '').toUpperCase();
      const adj = adjOf(p, weeklyById, mode);
      const repl = replByPos[pos] || 0;
      return { player: p, adj, replacement: repl, vor: Math.round((adj - repl) * 100) / 100 };
    });

  scored.sort((a, b) => b.vor - a.vor
    || b.adj - a.adj
    || (String(a.player.gsis_id) < String(b.player.gsis_id) ? -1 : 1));

  // R27 — BEST PICK NOW answers "what should I draft", so the dollar ceiling
  // belongs here for the same reason it belongs in BEST FIT: a pick you cannot
  // pay for is not a pick. Reuses the fit path's helper (passing 'fit'
  // explicitly, since this strip has no sort mode of its own) so there is ONE
  // affordability rule in this module, not two that can drift. Snake drafts
  // pass no budget and are untouched. Owner's call, 2026-08-14.
  const buyable = affordableOnly(scored, opts && opts.budget, 'fit');

  return buyable.slice(0, limit).map(({ player, vor, replacement }) => {
    const pos = String(player.position || '').toUpperCase();
    const sign = vor >= 0 ? '+' : '';
    const reasons = [
      `Best value over replacement: ${sign}${vor.toFixed(1)} pts vs the next-best available ${pos}`,
    ];
    const supply = supplyByPos[pos] || 0;
    if (supply <= VOR_SCARCITY_MAX) {
      reasons.push(`Only ${supply} startable ${pos}s left - position is drying up`);
    }
    return { player, vor, replacement, reasons };
  });
}
