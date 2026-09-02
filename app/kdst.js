/* app/kdst.js — KICKER + TEAM-DEFENSE PROJECTIONS: access and shaping.
 *
 * R20-B1. data/kdst_projections.json is a SEPARATE contract from
 * data/player_projections.json on purpose (merging them would evict ~74
 * offensive players from the projected[:300] cut — see the contract's own
 * notes). This module is the only place the app reads it, and the only place
 * that turns its rows into something a lineup can start.
 *
 * WHAT THE CONTRACT ACTUALLY CARRIES, and what that forces on us:
 *
 *   1. SEASON TOTALS, NOT WEEKS. Every `stats` value is a projected SEASON
 *      total over `games_projected` games. There is no per-week split and no
 *      opponent adjustment for K or D/ST. So `weeklyPoints` here is a flat
 *      per-game average — season / games — and it is LABELLED as such by every
 *      caller. Presenting a flat average as a week-specific projection would be
 *      the same species of lie as printing 0.0 for a slot with no feed.
 *
 *   2. STAT LINES, NOT POINTS. `proj_points` is the contract's own convenience
 *      total under DEFAULT_PROFILE. This module NEVER reads it for scoring: it
 *      recomputes with applyScoring(stats, profile), which is exact per-stat
 *      arithmetic under the CONNECTED league. Under DEFAULT the two agree
 *      exactly (locked in __selftest and in the unit tests), so a user with no
 *      league profile sees the contract's own numbers.
 *
 *   3. PARTIAL SCORING IS REAL AND MUST BE SAID OUT LOUD. The builder could not
 *      model three Sleeper D/ST keys (def_4_and_stop, def_st_ff,
 *      def_st_fum_rec) and — correctly — left them ABSENT from `stats` rather
 *      than zeroing them. applyScoring skips missing keys, so for a league that
 *      SCORES one of those keys the resulting total silently omits a component.
 *      `omittedKeys()` finds exactly that set, per entry, and the entry carries
 *      `partial: true` so the UI can mark the number instead of passing it off
 *      as complete. A league that does not score any of them (DEFAULT does not)
 *      omits nothing and is NOT marked — a false PARTIAL badge is its own lie.
 *
 *      R21 widened this past the contract's own vocabulary. app/sleeper.js
 *      mapScoring CARRIES unknown non-zero Sleeper keys onto the profile, so a
 *      real import brings in components (def_forced_fum, fgm_yds, …) that this
 *      contract has never heard of and therefore never declared. Those were
 *      dropped from the total with `partial:false` — the exact failure mode the
 *      flag exists to prevent. omittedKeys() now attributes them by ownership
 *      (scoringKeyOwner) and reports them with an honest generic reason.
 *
 * Nothing here fabricates. A missing contract, an empty position, an entry with
 * no stats: each degrades to "no feed", and the caller keeps its unprojected
 * path. Fetch is promise-cached and 404-graceful, mirroring app/data.js — the
 * getter lives here rather than in data.js because this agent does not own that
 * file; folding it into data.js later is a pure move with no behaviour change.
 */

import {
  applyScoring, normalizeProfile, DEFAULT_PROFILE, SCORING_FIELDS,
} from './league.js';

/** Site-root path of the contract. */
const KDST_PATH = '/data/kdst_projections.json';

/** The two positions this contract covers, canonically spelled. */
export const KDST_POSITIONS = Object.freeze(['K', 'DEF']);

/**
 * 'DST' and 'DEF' are the same thing wearing two spellings (Sleeper uses DEF,
 * plenty of hosts say D/ST). Canonicalise to DEF everywhere so a roster slot
 * spelled either way is fed by the same rows.
 *
 * R30b — the DEFINITION moved to app/team-logic.js, re-exported here so this
 * module's importers are untouched. draft-sim.js needs the fold at the engine
 * boundary (a DST-spelled board row could be bought but never seated) and this
 * file is LAZY-ONLY: a static draft-sim -> kdst edge put ~30 kB on every
 * route's boot path and tripped the R25 perf budget. team-logic is already in
 * the boot graph, so the fold rides free there.
 */
export { canonKdstPosition } from './team-logic.js';
import { canonKdstPosition } from './team-logic.js';

/** True when this position is one the K/DST contract can feed. */
export function isKdstPosition(pos) {
  return KDST_POSITIONS.includes(canonKdstPosition(pos));
}

/* --------------------------------------------------------------------------
 * Fetch (promise-cached, 404-graceful) — same contract as app/data.js loadJson
 * ------------------------------------------------------------------------ */

let inflight = null;

/**
 * Load the contract. Rejects (cleanly, and evicts the cache so a retry can
 * work) when the file is absent — a deploy predating the K/DST builder must
 * degrade to "no feed", never blank or throw at import.
 */
export function getKdstProjections({ force = false } = {}) {
  if (!force && inflight) return inflight;
  const p = fetch(KDST_PATH, { credentials: 'same-origin' }).then((res) => {
    if (!res.ok) throw new Error(`[kdst] ${KDST_PATH} -> HTTP ${res.status}`);
    return res.json();
  });
  inflight = p;
  p.catch(() => { if (inflight === p) inflight = null; });
  return p;
}

/* --------------------------------------------------------------------------
 * Shaping
 * ------------------------------------------------------------------------ */

const LABELS = new Map(SCORING_FIELDS.map((f) => [f.key, f.label]));
const isNum = (v) => Number.isFinite(Number(v));
const round2 = (n) => Math.round(n * 100) / 100;

function asArray(v) { return Array.isArray(v) ? v : []; }
function isObj(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

/**
 * Every stat key this POSITION could conceivably produce, per the contract
 * itself: the keys it modelled plus the keys it declared it could not model.
 * Driven by the data, never hardcoded here — when the builder learns to model
 * def_4_and_stop, that key moves from one list to the other and this module
 * needs no edit.
 */
export function positionKeyUniverse(raw, position) {
  const pos = canonKdstPosition(position);
  const modelled = isObj(raw && raw.modelled_keys) ? asArray(raw.modelled_keys[pos]) : [];
  const unmodelled = asArray(raw && raw.unmodelled_keys)
    .filter((u) => isObj(u) && canonKdstPosition(u.position) === pos)
    .map((u) => String(u.key));
  const out = [];
  for (const k of [...modelled, ...unmodelled]) {
    const key = String(k);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * KEY OWNERSHIP — which roster position a scoring key describes, or null when
 * this module cannot say.
 *
 * Two sources, in order:
 *
 *   1. THE APP'S OWN VOCABULARY. app/league.js SCORING_FIELDS groups every key
 *      it computes; `kicking` is a kicker's, `defense` is a team defence's, and
 *      passing/rushing/receiving/misc belong to an offensive player. That is a
 *      declaration, not a guess.
 *   2. THE SLEEPER NAMESPACE, for keys the app does NOT compute. app/sleeper.js
 *      mapScoring CARRIES an unknown non-zero key straight onto the profile
 *      (documented at sleeper.js "carried"), so a real import routinely brings
 *      in keys nothing here has ever heard of — def_forced_fum, def_3_and_out,
 *      def_pass_def, fgm_yds. Sleeper namespaces them, so their prefix is a
 *      fact about the key rather than a similarity score.
 *
 * DELIBERATELY CONSERVATIVE. `st_*` is NOT read as team defence: Sleeper scores
 * `st_td` for the individual returner and `def_st_td` for the unit, and
 * app/sleeper.js already refuses to equate the two. A key whose owner cannot be
 * established returns null and is attributed to NOBODY — a PARTIAL badge raised
 * against a defence for an offensive bonus key would be a false alarm, and the
 * module's whole argument is that a badge which cries wolf is worse than none.
 */
const GROUP_OWNER = Object.freeze({ kicking: 'K', defense: 'DEF' });
const KNOWN_OWNER = new Map(
  SCORING_FIELDS.map((f) => [f.key, GROUP_OWNER[f.group] || 'OFF']),
);
const NAMESPACE_OWNER = Object.freeze([
  [/^(?:fgm|fgmiss|fga|xpm|xpmiss|xpa|pat_|kick_)/, 'K'],
  [/^(?:def_|pts_allow|yds_allow)/, 'DEF'],
  // R28 tried to add [/^st_/, 'DEF'] here and was WRONG. __selftest below
  // caught it, and the reasoning it defends is right: in Sleeper `st_*` is the
  // individual RETURNER's line (a WR or RB scores that touchdown) while
  // `def_st_*` is the unit's, and this module deliberately refuses to equate
  // them. Attributing st_* to DEF would raise a PARTIAL badge on every defence
  // for a component no defence was ever owed — a false alarm, which this file
  // exists to prevent. Left alone on purpose; do not "fix" it again.
]);

/* R30b — SLEEPER'S TEAM-DEFENCE KEYS THAT CARRY NO PREFIX, by exact name.
 *
 * Not every team-defence key Sleeper scores lives in the def_ namespace. The
 * unit's core line is the BARE family — `sack`, `int`, `fum_rec`, `ff`, … —
 * and Sleeper disambiguates it from the two look-alikes by PREFIX, not by the
 * bare key: the individual defender's line is `idp_*` (a real league's
 * scoring_settings carries idp_ff/idp_sack/idp_int/idp_fum_rec ALONGSIDE
 * ff/sack/int/fum_rec — two families, same suffixes) and the individual
 * returner's is `st_*` (vs the unit's `def_st_*`, see the R28 note above). So
 * a bare key from this family is the UNIT's stat — the same reading
 * app/league.js SCORING_FIELDS already applies to the members it computes
 * (sack, int, fum_rec: group 'defense'). Before R30b the members it does NOT
 * compute — `ff` first among them — returned null here, so a league scoring
 * forced fumbles at 1 point had that component dropped from every D/ST total
 * WITHOUT appearing in the omitted list, and the import report described `ff`
 * as an offence-only rule. That is the exact silent-drop this module exists
 * to prevent.
 *
 * An EXACT-NAME set, not a regex, so `idp_ff` and `st_ff` can never match.
 * `fum` is deliberately ABSENT: Sleeper's `fum` is the offensive
 * ball-carrier's fumble (sibling of `fum_lost`/`fum_rec_td`, which
 * SCORING_FIELDS files under the offensive 'misc' group), and attributing it
 * to DEF would be the same false alarm the R28 note above refuses for st_*.
 * Ambiguous keys stay unattributed — conservative by design. */
const SLEEPER_TEAM_DEF_KEYS = Object.freeze(new Set([
  'ff', 'tkl', 'tkl_solo', 'tkl_ast', 'tkl_loss', 'qb_hit',
  'sack_yd', 'int_ret_yd', 'fum_ret_yd', 'blk_kick_ret_yd',
]));

export function scoringKeyOwner(key) {
  const k = String(key == null ? '' : key);
  if (!k) return null;
  const known = KNOWN_OWNER.get(k);
  if (known) return known;
  if (SLEEPER_TEAM_DEF_KEYS.has(k)) return 'DEF';
  for (const [re, owner] of NAMESPACE_OWNER) if (re.test(k)) return owner;
  return null;
}

/**
 * The scoring components THIS league pays for that THIS stat line does not
 * carry — i.e. exactly what the computed total silently leaves out.
 *
 *   omitted = { k : profile scores k with a non-zero value }
 *             INTERSECT { k : k belongs to this position }
 *             MINUS     { k : the stat line supplies k }
 *
 * Non-zero matters: a league that scores def_4_and_stop at 0 loses nothing by
 * our not modelling it, and marking that total PARTIAL would be noise. The
 * contract's `unmodelled_keys` supplies the human reason where it has one;
 * anything else omitted still gets reported, with an honest generic reason,
 * because "the feed didn't carry it" is true regardless of why.
 *
 * "BELONGS TO THIS POSITION" HAS TWO SOURCES, and it used to have one.
 *
 *   a) THE CONTRACT'S OWN VOCABULARY — positionKeyUniverse(), i.e. what the
 *      builder modelled plus what it declared it could not model. Authoritative
 *      for every key the app computes: scripts/validate_data.py check_kdst_
 *      honesty rule 3 forces each row's `stats` key set to EQUAL
 *      modelled_keys[position], so a modelled key is never missing from a row
 *      and an unmodelled one is named with its reason.
 *   b) EVERYTHING OUTSIDE THAT VOCABULARY — scoringKeyOwner() above. This is
 *      the R21 fix. A Sleeper import carries unknown non-zero keys onto the
 *      profile; the contract cannot have an opinion about a key it has never
 *      heard of, so before this those components were dropped from the total
 *      with `partial:false` — an INCOMPLETE number wearing the same face as a
 *      complete one, which is the single failure mode this whole module exists
 *      to prevent. Reproduce with scoring `{ def_forced_fum: 1 }`: the league
 *      pays a point per forced fumble, no stat line carries one, and the D/ST
 *      total quietly left it out and said nothing.
 */
export function omittedKeys(raw, stats, position, profile) {
  const p = normalizeProfile(profile);
  const pos = canonKdstPosition(position);
  const universe = positionKeyUniverse(raw, position);
  const declared = new Set(universe);
  // (b): CARRIED keys — non-zero profile keys this app does not compute at all,
  // which the Sleeper namespace attributes to THIS position. Sorted so the
  // report is stable whatever order the import wrote the scoring table in.
  //
  // Keys the app DOES compute (SCORING_FIELDS) are excluded here on purpose:
  // they are the contract's to declare, and it declares them exhaustively —
  // validate_data.py check_kdst_honesty rule 3 forces every row's `stats` key
  // set to EQUAL modelled_keys[position], so branch (a) above already sees each
  // one. The residual, stated plainly rather than papered over: if a future
  // builder dropped a known key from BOTH modelled_keys and every stat line,
  // rule 3 would still pass and that component would go unreported here.
  const carried = Object.keys(p.scoring)
    .filter((k) => !declared.has(k) && !KNOWN_OWNER.has(k) && scoringKeyOwner(k) === pos)
    .sort();
  const reasons = new Map(
    asArray(raw && raw.unmodelled_keys)
      .filter(isObj)
      .map((u) => [String(u.key), u]),
  );
  const have = isObj(stats) ? stats : {};
  const out = [];
  const seen = new Set();
  for (const key of [...universe, ...carried]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const per = Number(p.scoring[key]);
    if (!isNum(per) || per === 0) continue;               // the league doesn't pay for it
    if (Object.prototype.hasOwnProperty.call(have, key)) continue; // we have it
    const u = reasons.get(key);
    const generic = declared.has(key)
      ? 'No source column carries this component, so it is absent from the stat line rather than scored as zero.'
      : 'This app does not compute this component at all — your league carries it from its own '
        + 'scoring table, and no projection feeds it. It is left out of the total rather than scored as zero.';
    out.push({
      key,
      label: String((u && u.label) || LABELS.get(key) || key),
      points_per: per,
      reason: String((u && u.reason) || generic),
    });
  }
  return out;
}

/**
 * One contract row -> one shaped entry, or null when the row is unusable.
 * `games` is games_projected (already validated by the caller).
 */
function shapeEntry(raw, row, games, profile) {
  if (!isObj(row)) return null;
  const id = String(row.player_id == null ? '' : row.player_id);
  const pos = canonKdstPosition(row.position);
  if (!id || !KDST_POSITIONS.includes(pos)) return null;
  const stats = isObj(row.stats) ? row.stats : null;
  if (!stats) return null;                       // no stat line -> nothing honest to score

  const seasonPoints = applyScoring(stats, profile);
  const omitted = omittedKeys(raw, stats, pos, profile);
  // How many of THIS stat line's components the league actually pays for. Zero
  // means the profile's scoring table says nothing whatsoever about this
  // position — and then `seasonPoints` is 0 for a reason that has nothing to do
  // with the player. Presenting that as a projection of 0.0 is the exact
  // fabrication R19-B5 refused to ship; the flag lets callers say what is true
  // instead ("this league scores no kicker stat") and drop the row's claim.
  // `profile` arrives already normalized from shapeKdst, so scoring is complete.
  const scoredKeys = Object.keys(stats).filter((k) => {
    const per = Number(profile.scoring[k]);
    return Number.isFinite(per) && per !== 0;
  });
  return {
    id,
    name: String(row.name || id),
    team: String(row.team || ''),
    pos,
    stats,
    gamesSample: isNum(row.games_sample) ? Number(row.games_sample) : null,
    seasonsSample: asArray(row.seasons_sample).map(Number).filter(Number.isFinite),
    lowSample: row.low_sample === true,
    games,
    seasonPoints: round2(seasonPoints),
    /* FLAT PER-GAME AVERAGE. Not opponent-adjusted, not week-specific. Every
     * caller must say so where it renders this number. */
    weeklyPoints: round2(seasonPoints / games),
    scoredKeys,
    /* True when the league scores NOTHING this stat line carries: the 0 above is
     * a fact about the scoring table, not about the player. */
    unscored: scoredKeys.length === 0,
    omitted,
    partial: omitted.length > 0,
  };
}

/**
 * Shape the whole contract for one league profile.
 *
 * Returns a stable, always-usable index — `ok:false` when the contract is
 * missing/empty rather than a throw, and `positions` lists only the positions
 * that ACTUALLY have at least one row. A caller must gate on `positions`, not
 * on `ok`: a contract that ships kickers but no defenses leaves DEF honestly
 * unprojected, and that path has to keep working.
 */
export function shapeKdst(raw, profile) {
  const empty = {
    ok: false,
    unscoredPositions: [],
    season: null,
    updatedUtc: null,
    source: null,
    games: null,
    positions: [],
    byId: new Map(),
    byPosition: { K: [], DEF: [] },
    unmodelled: [],
    partialDeclared: {},
    notes: [],
  };
  if (!isObj(raw)) return empty;

  const games = Number(raw.games_projected);
  // A per-game average needs a game count. Without a positive one there is no
  // honest weekly number to hand a lineup, so the whole contract is unusable.
  if (!isNum(games) || games <= 0) return empty;

  const p = normalizeProfile(profile);
  const byPosition = { K: [], DEF: [] };
  const byId = new Map();
  for (const [key, pos] of [['kickers', 'K'], ['defenses', 'DEF']]) {
    for (const row of asArray(raw[key])) {
      const e = shapeEntry(raw, row, games, p);
      if (!e || e.pos !== pos) continue;
      if (byId.has(e.id)) continue;              // first row wins; ids are unique by contract
      byId.set(e.id, e);
      byPosition[pos].push(e);
    }
  }
  for (const pos of KDST_POSITIONS) {
    byPosition[pos].sort((a, b) => b.weeklyPoints - a.weeklyPoints
      || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
  }
  // A position is FED only when at least one of its rows can actually be valued
  // under this league. Rows exist but none is scorable -> `unscoredPositions`,
  // which is a different fact from "no rows" and gets different words.
  const withRows = KDST_POSITIONS.filter((pos) => byPosition[pos].length > 0);
  const positions = withRows.filter((pos) => byPosition[pos].some((e) => !e.unscored));
  const unscoredPositions = withRows.filter((pos) => !positions.includes(pos));

  return {
    ok: positions.length > 0,
    unscoredPositions,
    season: isNum(raw.season) ? Number(raw.season) : null,
    updatedUtc: raw.updated_utc == null ? null : String(raw.updated_utc),
    source: raw.source == null ? null : String(raw.source),
    games,
    positions,
    byId,
    byPosition,
    unmodelled: asArray(raw.unmodelled_keys).filter(isObj),
    partialDeclared: isObj(raw.partial_scoring) ? { ...raw.partial_scoring } : {},
    notes: asArray(raw.notes).map(String),
  };
}

/**
 * The positions a lineup may treat as fed, given a shaped index — including the
 * 'DST' spelling so a league whose slot token is DST is fed by the DEF rows.
 * Empty when nothing loaded, which is what keeps the unprojected path alive.
 */
export function fedPositions(index) {
  const pos = (index && Array.isArray(index.positions)) ? index.positions : [];
  const out = [...pos];
  if (pos.includes('DEF')) out.push('DST');
  return out;
}

/* --------------------------------------------------------------------------
 * Byes — the one schedule fact a K/DST row cannot supply itself
 * ------------------------------------------------------------------------ */

/**
 * team -> bye week, derived from data/schedule_full.json. Lives here because
 * K/DST is the only surface that needs it: offensive players carry `bye` on
 * their own player_weekly rows, but there is no weekly split for K or D/ST, so
 * a flat per-game average would otherwise happily start a kicker on his bye.
 * A team with no missing week (or more than one) is simply absent from the map
 * — an ambiguous schedule yields no claim rather than a guessed bye.
 */
export function teamByeWeeks(schedule) {
  const games = asArray(schedule && schedule.games);
  if (games.length === 0) return new Map();
  const weeks = new Set();
  const played = new Map();     // team -> Set(week)
  const note = (team, wk) => {
    const t = String(team || '').toUpperCase();
    if (!t) return;
    if (!played.has(t)) played.set(t, new Set());
    played.get(t).add(wk);
  };
  for (const g of games) {
    if (!isObj(g)) continue;
    const wk = Number(g.week);
    if (!Number.isInteger(wk) || wk <= 0) continue;
    weeks.add(wk);
    note(g.home, wk);
    note(g.away, wk);
  }
  const allWeeks = [...weeks];
  const out = new Map();
  for (const [team, set] of played) {
    const missing = allWeeks.filter((w) => !set.has(w));
    if (missing.length === 1) out.set(team, missing[0]);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Self-check (called by the unit test)
 * ------------------------------------------------------------------------ */

/** A miniature contract mirroring the real one's shape. */
const FIXTURE = {
  season: 2026,
  games_projected: 17,
  modelled_keys: {
    K: ['xpm', 'fgm_30_39'],
    DEF: ['sack', 'int', 'pts_allow_0'],
  },
  unmodelled_keys: [
    { key: 'def_4_and_stop', label: '4th-down stop', position: 'DEF', reason: 'no column' },
  ],
  partial_scoring: { K: false, DEF: true },
  kickers: [
    { player_id: 'K-A', name: 'Kicker A', team: 'HOU', position: 'K', stats: { xpm: 34, fgm_30_39: 17 } },
  ],
  defenses: [
    { player_id: 'DST-DEN', name: 'Denver Defense', team: 'DEN', position: 'DEF', stats: { sack: 51, int: 17, pts_allow_0: 1 } },
  ],
  notes: [],
};

export function __selftest() {
  const idx = shapeKdst(FIXTURE);
  if (!idx.ok) throw new Error('fixture shapes');
  if (idx.positions.join(',') !== 'K,DEF') throw new Error('both positions fed');
  if (fedPositions(idx).join(',') !== 'K,DEF,DST') throw new Error('DST is fed by DEF rows');

  // Exact per-stat arithmetic under DEFAULT: 34*1 + 17*3 = 85 over 17 games.
  const k = idx.byId.get('K-A');
  if (k.seasonPoints !== 85) throw new Error('K season points');
  if (k.weeklyPoints !== 5) throw new Error('K weekly = season / games');
  if (k.partial !== false || k.omitted.length !== 0) throw new Error('K omits nothing');

  // 51*1 + 17*2 + 1*10 = 95 -> 5.59/gm. DEFAULT does not score def_4_and_stop,
  // so nothing is omitted and the total must NOT be marked partial.
  const d = idx.byId.get('DST-DEN');
  if (d.seasonPoints !== 95) throw new Error('DEF season points');
  if (d.weeklyPoints !== 5.59) throw new Error('DEF weekly average');
  if (d.partial !== false) throw new Error('an unscored unmodelled key omits nothing');

  // A league that DOES pay for the unmodelled key gets a partial total, named.
  // Note the total is IDENTICAL (95) — that is precisely the danger: an
  // incomplete number looks exactly like a complete one unless it is marked.
  const paying = shapeKdst(FIXTURE, {
    scoring: { ...DEFAULT_PROFILE.scoring, def_4_and_stop: 2 },
  });
  const pd = paying.byId.get('DST-DEN');
  if (pd.seasonPoints !== 95) throw new Error('the omitted key changes no arithmetic');
  if (pd.partial !== true) throw new Error('a scored unmodelled key marks the total partial');
  if (pd.omitted.length !== 1 || pd.omitted[0].key !== 'def_4_and_stop') {
    throw new Error('the omitted component is named');
  }
  if (paying.byId.get('K-A').partial !== false) throw new Error('a DEF gap never marks a kicker');

  // R21 — A KEY THE CONTRACT HAS NEVER HEARD OF still gets reported. This is
  // the reachable case: app/sleeper.js mapScoring CARRIES unknown non-zero
  // Sleeper keys straight onto the profile, and before this the total dropped
  // them with partial:false — an incomplete number wearing a complete face.
  const carried = shapeKdst(FIXTURE, {
    scoring: { ...DEFAULT_PROFILE.scoring, def_forced_fum: 1, fgm_yds: 0.1 },
  });
  const cd = carried.byId.get('DST-DEN');
  if (cd.partial !== true) throw new Error('a carried DEF key marks the total partial');
  if (cd.omitted.map((o) => o.key).join(',') !== 'def_forced_fum') {
    throw new Error('the carried DEF component is named');
  }
  if (!/does not compute this component/.test(cd.omitted[0].reason)) {
    throw new Error('a carried key gets the honest generic reason');
  }
  if (cd.seasonPoints !== 95) throw new Error('a carried key changes no arithmetic');
  const ck = carried.byId.get('K-A');
  if (ck.omitted.map((o) => o.key).join(',') !== 'fgm_yds') {
    throw new Error('a carried kicking key lands on the kicker, not the defence');
  }

  // ...and attribution is CONSERVATIVE. An offensive bonus key, and Sleeper's
  // individual special-teams keys (st_* is the RETURNER, def_st_* is the unit —
  // app/sleeper.js refuses to equate them), are attributed to nobody. A PARTIAL
  // badge raised for those would be a false alarm, which is worse than none.
  const notOurs = shapeKdst(FIXTURE, {
    scoring: { ...DEFAULT_PROFILE.scoring, bonus_rec_te: 0.5, st_ff: 1, rec_0_4: 0.2 },
  });
  if (notOurs.byId.get('DST-DEN').partial !== false) throw new Error('offence/ST keys never mark a defence');
  if (notOurs.byId.get('K-A').partial !== false) throw new Error('offence/ST keys never mark a kicker');
  if (scoringKeyOwner('sack') !== 'DEF' || scoringKeyOwner('fgm_50p') !== 'K'
    || scoringKeyOwner('rec_td') !== 'OFF' || scoringKeyOwner('st_td') !== null) {
    throw new Error('key ownership');
  }

  // R30b — the bare team-defence family is the UNIT's (Sleeper separates the
  // individual defender as idp_* and the individual returner as st_*), so `ff`
  // belongs to DEF while its prefixed look-alikes stay unattributed, and the
  // ambiguous offensive `fum` is attributed to NOBODY.
  if (scoringKeyOwner('ff') !== 'DEF' || scoringKeyOwner('tkl') !== 'DEF'
    || scoringKeyOwner('qb_hit') !== 'DEF' || scoringKeyOwner('int_ret_yd') !== 'DEF') {
    throw new Error('bare team-defence keys belong to the unit');
  }
  if (scoringKeyOwner('idp_ff') !== null || scoringKeyOwner('st_ff') !== null
    || scoringKeyOwner('idp_tkl') !== null || scoringKeyOwner('fum') !== null) {
    throw new Error('idp_*/st_*/ambiguous keys stay unattributed');
  }
  // A league paying for `ff` gets the D/ST total marked PARTIAL with `ff`
  // NAMED in the omitted list (it used to vanish without a trace), the
  // arithmetic untouched, and the kicker unmarked.
  const ffLeague = shapeKdst(FIXTURE, {
    scoring: { ...DEFAULT_PROFILE.scoring, ff: 1 },
  });
  const ffd = ffLeague.byId.get('DST-DEN');
  if (ffd.partial !== true) throw new Error('a scored ff marks the D/ST total partial');
  if (ffd.omitted.map((o) => o.key).join(',') !== 'ff') {
    throw new Error('the omitted forced-fumble component is named');
  }
  if (ffd.seasonPoints !== 95) throw new Error('ff attribution changes no arithmetic');
  if (ffLeague.byId.get('K-A').partial !== false) throw new Error('ff never marks a kicker');

  // A league whose scoring table pays for NOTHING a kicker does does not get a
  // 0.0 kicker: the position is not fed, and it is flagged as unscored rather
  // than as an unpublished feed — two different things to tell a manager.
  const recOnly = shapeKdst(FIXTURE, { scoring: { rec: 1 } });
  if (recOnly.ok !== false) throw new Error('an unvaluable feed is not a feed');
  if (fedPositions(recOnly).length !== 0) throw new Error('nothing to feed a lineup with');
  if (recOnly.unscoredPositions.join(',') !== 'K,DEF') throw new Error('both positions unscored');
  if (recOnly.byId.get('K-A').unscored !== true) throw new Error('the row says it cannot be valued');
  if (idx.byId.get('K-A').unscored !== false) throw new Error('a scorable row is not unscored');

  // Degradation: no contract, junk contract, or no game count -> no feed at all.
  for (const bad of [null, undefined, 42, {}, { games_projected: 0, kickers: [] }]) {
    const e = shapeKdst(bad);
    if (e.ok !== false || e.positions.length !== 0 || fedPositions(e).length !== 0) {
      throw new Error('a missing contract yields no feed');
    }
  }
  // A contract with kickers but no defenses leaves DEF honestly unprojected.
  const kOnly = shapeKdst({ ...FIXTURE, defenses: [] });
  if (kOnly.positions.join(',') !== 'K') throw new Error('per-position feed gating');
  if (fedPositions(kOnly).includes('DST')) throw new Error('no DEF rows -> no DST feed');

  // Byes come from the schedule, and only when they are unambiguous.
  const bye = teamByeWeeks({
    games: [
      { week: 1, home: 'DEN', away: 'HOU' },
      { week: 2, home: 'DEN', away: 'KC' },
      { week: 3, home: 'HOU', away: 'KC' },
    ],
  });
  if (bye.get('DEN') !== 3 || bye.get('KC') !== 1 || bye.get('HOU') !== 2) {
    throw new Error('bye = the one week a team has no game');
  }
  if (teamByeWeeks(null).size !== 0) throw new Error('no schedule -> no bye claims');
  return true;
}
