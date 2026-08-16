/* app/league.js — LEAGUE PROFILE (pure).
 *
 * The single normalised description of the USER'S REAL LEAGUE: what a point is
 * worth (scoring) and what a roster looks like (shape). Every function here is
 * PURE and DOM-free — no fetch, no Date, no document. localStorage is reached
 * only through an INJECTED storage handle (defaulting to globalThis.localStorage
 * when one exists), so tests/feature/league_profile.test.mjs imports this file
 * directly under node with zero setup.
 *
 * WHY THIS EXISTS: roster geometry and position caps were frozen constants
 * (app/team-logic.js STARTER_SLOTS/BENCH_SLOTS/POSITION_CAPS) and draft settings
 * were an in-memory literal rebuilt on every mount of app/views/team.js — so a
 * 9-starter league with a K and a DEF could not be represented, and nothing
 * survived a reload. This module owns that state instead.
 *
 * HONESTY CONTRACT:
 *   - DEFAULT_PROFILE reproduces TODAY'S behaviour exactly: PPR reception
 *     scoring, 7 starters (QB1 RB1 RB2 WR1 WR2 TE1 FLEX) + 6 bench (BN1..BN6),
 *     and the current caps {QB:2, DEF:1, DST:1, K:1}. An unconfigured user sees
 *     no change whatsoever.
 *   - applyScoring() is EXACT per-stat arithmetic: sum(stat x points-per-stat).
 *     It is never a scale factor applied to a PPR total.
 *   - RB_TE_FLEX has NO Sleeper token. It is an app-only slot. Nothing here
 *     silently rewrites it to FLEX; sleeperToken('RB_TE_FLEX') returns null and
 *     the UI must say so rather than pretend a Sleeper equivalent exists.
 *   - Corrupt / absent / hostile storage falls back to DEFAULT and NEVER throws.
 *
 * SHAPES:
 *   profile  { version:1, name:string,
 *              scoring: { <stat_key>: number, ... },
 *              shape: { teams, roster_positions:[token,...], starters:int,
 *                       bench:int, flex_eligibility:{ <flex_token>:[POS,...] },
 *                       position_caps:{ POS:int }, draft_rounds:int,
 *                       keepers_enabled:bool, max_keepers:int,
 *                       playoff_week_start:int,
 *                       position_caps_source?:'sleeper'|'sleeper-advisory',
 *                       draft_rounds_source?:'draft'|'league' } }
 *            (the two *_source fields are PROVENANCE marks written only by the
 *             Sleeper import — see their normalisation blocks below)
 *   slots    { starters:['QB1',...], bench:['BN1',...], all:[...] }
 *   error    { path, code, message, value, severity:'error'|'warning' }
 */

/* --------------------------------------------------------------------------
 * Storage key + version
 * ------------------------------------------------------------------------ */

/** localStorage key. v1 — bump only on a shape change that cannot be migrated. */
export const LEAGUE_KEY = 'nfl2026.league.v1';

/** Profile schema version stamped into every normalised profile. */
export const PROFILE_VERSION = 1;

/* --------------------------------------------------------------------------
 * Positions and flex eligibility (DATA, not branches)
 * ------------------------------------------------------------------------ */

/** Non-flex starter position tokens a roster slot may name. */
export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST']);

/** The bench token. Anything not BN and not a flex token is a fixed starter. */
export const BENCH_TOKEN = 'BN';

/**
 * FLEX eligibility as DATA, aligned to Sleeper's tokens.
 *
 * `sleeper_token` is null for RB_TE_FLEX — Sleeper has no such slot. That is a
 * UI CONTRACT: an export/compare screen must show RB_TE_FLEX as app-only and
 * unmappable. Never substitute FLEX for it.
 */
export const FLEX_ELIGIBILITY = Object.freeze({
  WRRB_FLEX: Object.freeze({
    positions: Object.freeze(['WR', 'RB']),
    sleeper_token: 'WRRB_FLEX',
    label: 'W/R',
    app_only: false,
  }),
  REC_FLEX: Object.freeze({
    positions: Object.freeze(['WR', 'TE']),
    sleeper_token: 'REC_FLEX',
    label: 'W/T',
    app_only: false,
  }),
  FLEX: Object.freeze({
    positions: Object.freeze(['WR', 'RB', 'TE']),
    sleeper_token: 'FLEX',
    label: 'W/R/T',
    app_only: false,
  }),
  SUPER_FLEX: Object.freeze({
    positions: Object.freeze(['QB', 'WR', 'RB', 'TE']),
    sleeper_token: 'SUPER_FLEX',
    label: 'SUPERFLEX',
    app_only: false,
  }),
  RB_TE_FLEX: Object.freeze({
    positions: Object.freeze(['RB', 'TE']),
    sleeper_token: null, // APP-ONLY: Sleeper has no token for this slot.
    label: 'R/T',
    app_only: true,
  }),
});

/** Flex slot tokens, in menu order. */
export const FLEX_TOKENS = Object.freeze(Object.keys(FLEX_ELIGIBILITY));

/** Every token a roster_positions entry may legally carry. */
export const ROSTER_TOKENS = Object.freeze([...POSITIONS, ...FLEX_TOKENS, BENCH_TOKEN]);

/** Sleeper's token for a slot, or null when the slot is app-only. */
export function sleeperToken(token) {
  const t = String(token == null ? '' : token).toUpperCase();
  if (FLEX_ELIGIBILITY[t]) return FLEX_ELIGIBILITY[t].sleeper_token;
  if (POSITIONS.includes(t) || t === BENCH_TOKEN) return t;
  return null;
}

/** True when the slot token exists only in this app (no Sleeper equivalent). */
export function isAppOnlySlot(token) {
  const t = String(token == null ? '' : token).toUpperCase();
  return Boolean(FLEX_ELIGIBILITY[t] && FLEX_ELIGIBILITY[t].app_only);
}

/* --------------------------------------------------------------------------
 * Scoring vocabulary
 * ------------------------------------------------------------------------ */

/**
 * The stat keys this app understands, in display order, with the group they
 * belong to. Keys mirror Sleeper's scoring_settings names so a league imported
 * from Sleeper maps 1:1. Unknown keys are NOT rejected — a league may score
 * something we have not enumerated — they are kept, flagged as a warning by
 * validateProfile, and applied exactly like any other key.
 */
export const SCORING_FIELDS = Object.freeze([
  { key: 'pass_yd', label: 'Passing yard', group: 'passing' },
  { key: 'pass_td', label: 'Passing TD', group: 'passing' },
  { key: 'pass_int', label: 'Interception thrown', group: 'passing' },
  { key: 'pass_2pt', label: 'Passing 2-pt', group: 'passing' },
  { key: 'rush_yd', label: 'Rushing yard', group: 'rushing' },
  { key: 'rush_td', label: 'Rushing TD', group: 'rushing' },
  { key: 'rush_2pt', label: 'Rushing 2-pt', group: 'rushing' },
  { key: 'rec', label: 'Reception', group: 'receiving' },
  { key: 'rec_yd', label: 'Receiving yard', group: 'receiving' },
  { key: 'rec_td', label: 'Receiving TD', group: 'receiving' },
  { key: 'rec_2pt', label: 'Receiving 2-pt', group: 'receiving' },
  { key: 'fum_lost', label: 'Fumble lost', group: 'misc' },
  { key: 'fum_rec_td', label: 'Fumble recovery TD', group: 'misc' },
  { key: 'xpm', label: 'Extra point made', group: 'kicking' },
  { key: 'xpmiss', label: 'Extra point missed', group: 'kicking' },
  { key: 'fgm_0_19', label: 'FG made 0-19', group: 'kicking' },
  { key: 'fgm_20_29', label: 'FG made 20-29', group: 'kicking' },
  { key: 'fgm_30_39', label: 'FG made 30-39', group: 'kicking' },
  { key: 'fgm_40_49', label: 'FG made 40-49', group: 'kicking' },
  { key: 'fgm_50p', label: 'FG made 50+', group: 'kicking' },
  { key: 'fgmiss', label: 'FG missed', group: 'kicking' },
  { key: 'def_td', label: 'Defensive TD', group: 'defense' },
  { key: 'def_st_td', label: 'Special-teams TD', group: 'defense' },
  { key: 'sack', label: 'Sack', group: 'defense' },
  { key: 'int', label: 'Interception', group: 'defense' },
  { key: 'fum_rec', label: 'Fumble recovered', group: 'defense' },
  { key: 'safe', label: 'Safety', group: 'defense' },
  { key: 'blk_kick', label: 'Blocked kick', group: 'defense' },
  { key: 'pts_allow_0', label: 'Shutout', group: 'defense' },
  { key: 'pts_allow_1_6', label: 'Points allowed 1-6', group: 'defense' },
  { key: 'pts_allow_7_13', label: 'Points allowed 7-13', group: 'defense' },
  { key: 'pts_allow_14_20', label: 'Points allowed 14-20', group: 'defense' },
  { key: 'pts_allow_21_27', label: 'Points allowed 21-27', group: 'defense' },
  { key: 'pts_allow_28_34', label: 'Points allowed 28-34', group: 'defense' },
  { key: 'pts_allow_35p', label: 'Points allowed 35+', group: 'defense' },
]);

const KNOWN_SCORING_KEYS = Object.freeze(SCORING_FIELDS.map((f) => f.key));
const SCORING_ORDER = new Map(KNOWN_SCORING_KEYS.map((k, i) => [k, i]));

/** Standard full-PPR scoring — the DEFAULT profile's scoring table. */
const DEFAULT_SCORING = Object.freeze({
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  pass_2pt: 2,
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  fum_lost: -2,
  fum_rec_td: 6,
  xpm: 1,
  xpmiss: -1,
  fgm_0_19: 3,
  fgm_20_29: 3,
  fgm_30_39: 3,
  fgm_40_49: 4,
  fgm_50p: 5,
  fgmiss: -1,
  def_td: 6,
  def_st_td: 6,
  sack: 1,
  int: 2,
  fum_rec: 2,
  safe: 2,
  blk_kick: 2,
  pts_allow_0: 10,
  pts_allow_1_6: 7,
  pts_allow_7_13: 4,
  pts_allow_14_20: 1,
  pts_allow_21_27: 0,
  pts_allow_28_34: -1,
  pts_allow_35p: -4,
});

/* --------------------------------------------------------------------------
 * Bounds (every value is hand-editable, so every value is bounded)
 * ------------------------------------------------------------------------ */

export const LEAGUE_BOUNDS = Object.freeze({
  teams: Object.freeze([2, 32]),
  starters: Object.freeze([1, 20]),
  bench: Object.freeze([0, 20]),
  roster_size: Object.freeze([1, 40]),
  draft_rounds: Object.freeze([1, 40]),
  max_keepers: Object.freeze([0, 40]),
  playoff_week_start: Object.freeze([1, 18]),
  position_cap: Object.freeze([0, 40]),
  name_length: 60,
});

/* --------------------------------------------------------------------------
 * DEFAULT — byte-for-byte today's behaviour
 * ------------------------------------------------------------------------ */

/** roster_positions producing exactly QB1 RB1 RB2 WR1 WR2 TE1 FLEX + BN1..BN6. */
const DEFAULT_ROSTER_POSITIONS = Object.freeze([
  'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN',
]);

/**
 * The profile an unconfigured user gets. Reproduces app/team-logic.js
 * STARTER_SLOTS + BENCH_SLOTS + POSITION_CAPS exactly (locked by
 * tests/feature/league_profile.test.mjs, which imports both modules and
 * deep-compares). Deep-frozen: mutate a clone, never this.
 */
export const DEFAULT_PROFILE = deepFreeze({
  version: PROFILE_VERSION,
  name: 'My League',
  scoring: { ...DEFAULT_SCORING },
  shape: {
    teams: 12,
    roster_positions: [...DEFAULT_ROSTER_POSITIONS],
    starters: 7,
    bench: 6,
    flex_eligibility: { FLEX: ['WR', 'RB', 'TE'] },
    position_caps: { QB: 2, DEF: 1, DST: 1, K: 1 },
    draft_rounds: 13,
    keepers_enabled: false,
    max_keepers: 0,
    playoff_week_start: 15,
  },
});

/* --------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.keys(obj).forEach((k) => deepFreeze(obj[k]));
  }
  return obj;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Strict numeric coercion -> number | null. A number or a non-empty numeric
 * string counts; null, '', true/false, [] and objects do NOT. Plain Number()
 * turns null, '' and [] into 0 and true into 1, which would silently invent
 * values a user never typed — exactly the fabrication this app forbids.
 */
function toFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampInt(v, lo, hi, fallback) {
  const raw = toFinite(v);
  if (raw === null) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(raw)));
}

function upper(v) {
  return String(v == null ? '' : v).toUpperCase().trim();
}

/** Deep copy of a profile (plain JSON shapes only — safe and mutable). */
export function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

/* --------------------------------------------------------------------------
 * Normalisation — total, never throws
 * ------------------------------------------------------------------------ */

/**
 * Sanitise anything into a valid profile. Mirrors the defensive discipline of
 * loadRoster() in app/views/team.js: whitelist known keys, coerce each value,
 * drop what does not survive, and fall back to DEFAULT rather than throw.
 * Returns a fresh MUTABLE profile. Idempotent.
 *
 * A supplied `scoring` table REPLACES the default table wholesale — it is not
 * merged. A league that does not score fumbles must not silently inherit -2.
 * An absent stat key is worth 0 points, which is the honest reading.
 */
export function normalizeProfile(raw) {
  const out = cloneProfile(DEFAULT_PROFILE);
  if (!isPlainObject(raw)) return out;

  out.version = PROFILE_VERSION;

  if (typeof raw.name === 'string' && raw.name.trim()) {
    out.name = raw.name.trim().slice(0, LEAGUE_BOUNDS.name_length);
  }

  /* ---- scoring ---- */
  if (isPlainObject(raw.scoring)) {
    const scoring = {};
    Object.keys(raw.scoring).forEach((k) => {
      const key = String(k);
      const n = toFinite(raw.scoring[k]);
      if (key && n !== null) scoring[key] = n;
    });
    // An entirely unusable scoring table (nothing finite) keeps the default.
    if (Object.keys(scoring).length > 0) out.scoring = sortScoring(scoring);
  }

  const rawShape = isPlainObject(raw.shape) ? raw.shape : {};

  /* ---- roster_positions is the source of truth for starters/bench ---- */
  let positions = null;
  if (Array.isArray(rawShape.roster_positions)) {
    const kept = rawShape.roster_positions
      .map(upper)
      .filter((t) => ROSTER_TOKENS.includes(t));
    const starterCount = kept.filter((t) => t !== BENCH_TOKEN).length;
    if (starterCount > 0 && kept.length <= LEAGUE_BOUNDS.roster_size[1]) {
      positions = kept;
    }
  }
  if (positions) {
    const starters = positions.filter((t) => t !== BENCH_TOKEN);
    const bench = positions.length - starters.length;
    out.shape.roster_positions = [...starters, ...new Array(bench).fill(BENCH_TOKEN)];
    out.shape.starters = starters.length;
    out.shape.bench = bench;
  }

  /* ---- flex eligibility ---- */
  const flexEl = {};
  usedFlexTokens(out.shape.roster_positions).forEach((token) => {
    const rawList = isPlainObject(rawShape.flex_eligibility)
      ? rawShape.flex_eligibility[token]
      : null;
    let list = null;
    if (Array.isArray(rawList)) {
      const kept = [];
      rawList.map(upper).forEach((p) => {
        if (POSITIONS.includes(p) && !kept.includes(p)) kept.push(p);
      });
      if (kept.length > 0) list = kept;
    }
    // No usable override -> the token's documented eligibility. RB_TE_FLEX
    // keeps its own [RB,TE]; it is never rewritten to FLEX.
    flexEl[token] = list || [...FLEX_ELIGIBILITY[token].positions];
  });
  out.shape.flex_eligibility = flexEl;

  /* ---- position caps ---- */
  if (isPlainObject(rawShape.position_caps)) {
    const caps = {};
    Object.keys(rawShape.position_caps).forEach((k) => {
      const pos = upper(k);
      const v = rawShape.position_caps[k];
      if (!pos) return;
      if (v == null) return; // explicit null = uncapped, so drop the key
      const n = toFinite(v);
      if (n === null) return;
      caps[pos] = clampInt(n, LEAGUE_BOUNDS.position_cap[0], LEAGUE_BOUNDS.position_cap[1], 0);
    });
    out.shape.position_caps = caps;
  }

  /* ---- position-cap PROVENANCE (R26, extended R30b) ----
   * Whether the caps above are a league's ENFORCED roster limit or somebody's
   * best guess. Only 'sleeper' carries authority: it means the numbers came
   * from a real league's position_limit_* settings, which Sleeper enforces at
   * the roster, so team-logic honours them exactly instead of adding the
   * bye/injury allowance it gives a hand-typed cap. Any other value — and
   * every profile saved before R26 — is dropped, which lands on the lenient
   * pre-R26 behaviour. An unrecognised string must never be treated as
   * authority: that would let a bad import silently tighten a roster.
   *
   * R30b adds 'sleeper-advisory': the limits DID come from a real league's
   * position_limit_* settings, but Sleeper's own draft record was read and its
   * enforce_position_limits flag is OFF — the commissioner left the numbers in
   * place with enforcement disabled. The mark is preserved (so the UI can say
   * why the caps are not read as a ban) but it deliberately carries NO
   * authority: app/team-logic.js treats anything other than the literal
   * 'sleeper' as the lenient hand-typed reading, which is exactly what an
   * unenforced limit deserves. */
  const capsSource = String(rawShape.position_caps_source || '').toLowerCase();
  if (capsSource === 'sleeper') out.shape.position_caps_source = 'sleeper';
  else if (capsSource === 'sleeper-advisory') out.shape.position_caps_source = 'sleeper-advisory';

  /* ---- scalars ---- */
  out.shape.teams = clampInt(
    rawShape.teams, LEAGUE_BOUNDS.teams[0], LEAGUE_BOUNDS.teams[1], out.shape.teams,
  );
  out.shape.draft_rounds = clampInt(
    rawShape.draft_rounds,
    LEAGUE_BOUNDS.draft_rounds[0],
    LEAGUE_BOUNDS.draft_rounds[1],
    // An unset draft_rounds tracks the roster size (13 by default).
    out.shape.starters + out.shape.bench,
  );

  /* ---- draft-rounds PROVENANCE (R30b) ----
   * WHERE an EXPLICIT draft_rounds came from, written only by the Sleeper
   * import. 'draft' means Sleeper's DRAFT record (draft.settings.rounds) — the
   * authoritative count. 'league' means only the league object's
   * settings.draft_rounds copy was readable (paste tier, missing draft_id, or
   * a failed draft read), and Sleeper leaves that copy STALE: the owner's real
   * league reports 3 there while its draft record and its 13 roster slots both
   * say 13 (R30b sleeper-import-draft-rounds). A 'league' number is therefore
   * a fallback the UI must not assert as the league's real round count.
   * Anything else is dropped — an unrecognised provenance must never lend
   * authority to a number — and a profile whose draft_rounds merely tracks the
   * roster size carries no source at all, because nothing was read. */
  const roundsSource = String(rawShape.draft_rounds_source || '').toLowerCase();
  if ((roundsSource === 'draft' || roundsSource === 'league')
      && toFinite(rawShape.draft_rounds) !== null) {
    out.shape.draft_rounds_source = roundsSource;
  }
  out.shape.playoff_week_start = clampInt(
    rawShape.playoff_week_start,
    LEAGUE_BOUNDS.playoff_week_start[0],
    LEAGUE_BOUNDS.playoff_week_start[1],
    out.shape.playoff_week_start,
  );
  out.shape.keepers_enabled = rawShape.keepers_enabled === true;
  out.shape.max_keepers = clampInt(
    rawShape.max_keepers, LEAGUE_BOUNDS.max_keepers[0], LEAGUE_BOUNDS.max_keepers[1], 0,
  );
  // Keepers consume draft picks and roster spots; a disabled toggle means none.
  if (!out.shape.keepers_enabled) out.shape.max_keepers = 0;
  out.shape.max_keepers = Math.min(
    out.shape.max_keepers, out.shape.draft_rounds, out.shape.starters + out.shape.bench,
  );

  return out;
}

/** Scoring object with known keys first (display order), then extras A-Z. */
function sortScoring(scoring) {
  const keys = Object.keys(scoring).sort((a, b) => {
    const ia = SCORING_ORDER.has(a) ? SCORING_ORDER.get(a) : Infinity;
    const ib = SCORING_ORDER.has(b) ? SCORING_ORDER.get(b) : Infinity;
    if (ia !== ib) return ia - ib;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  const out = {};
  keys.forEach((k) => { out[k] = scoring[k]; });
  return out;
}

/** Distinct flex tokens present in a roster_positions list, in first-seen order. */
function usedFlexTokens(rosterPositions) {
  const seen = [];
  (rosterPositions || []).forEach((t) => {
    const token = upper(t);
    if (FLEX_ELIGIBILITY[token] && !seen.includes(token)) seen.push(token);
  });
  return seen;
}

/* --------------------------------------------------------------------------
 * Validation — actionable errors, never booleans
 * ------------------------------------------------------------------------ */

function err(path, code, message, value, severity) {
  return { path, code, message, value, severity: severity || 'error' };
}

/**
 * Validate a HAND-EDITED profile. Returns an array of
 * { path, code, message, value, severity } — empty means the profile is
 * usable as-is. Warnings (severity 'warning') do not block saving; they tell
 * the user something was kept but is unusual.
 *
 * This inspects the RAW input, so the user sees what THEY typed was wrong.
 * normalizeProfile() will still produce something usable from the same input.
 */
export function validateProfile(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    errors.push(err('', 'not_an_object',
      'A league profile must be a JSON object with "scoring" and "shape".', raw));
    return errors;
  }

  if (raw.name != null && typeof raw.name !== 'string') {
    errors.push(err('name', 'name_not_a_string', 'League name must be text.', raw.name));
  } else if (typeof raw.name === 'string' && raw.name.length > LEAGUE_BOUNDS.name_length) {
    errors.push(err('name', 'name_too_long',
      `League name is longer than ${LEAGUE_BOUNDS.name_length} characters and will be cut.`,
      raw.name, 'warning'));
  }

  /* ---- scoring ---- */
  if (raw.scoring == null) {
    errors.push(err('scoring', 'scoring_missing',
      'No "scoring" table — add one, or the standard PPR table is used.', raw.scoring, 'warning'));
  } else if (!isPlainObject(raw.scoring)) {
    errors.push(err('scoring', 'scoring_not_an_object',
      '"scoring" must be an object of stat key -> points, e.g. {"rec": 1}.', raw.scoring));
  } else {
    Object.keys(raw.scoring).forEach((k) => {
      const v = raw.scoring[k];
      if (toFinite(v) === null) {
        errors.push(err(`scoring.${k}`, 'scoring_value_not_a_number',
          `Points for "${k}" must be a number (got ${JSON.stringify(v)}).`, v));
      } else if (!SCORING_ORDER.has(k)) {
        errors.push(err(`scoring.${k}`, 'unknown_stat_key',
          `"${k}" is not a stat this app computes; it is kept and applied, but no `
          + 'projection feeds it.', v, 'warning'));
      }
    });
  }

  /* ---- shape ---- */
  if (raw.shape == null) {
    errors.push(err('shape', 'shape_missing',
      'No "shape" — add one, or the default 7-starter / 6-bench roster is used.',
      raw.shape, 'warning'));
    return errors;
  }
  if (!isPlainObject(raw.shape)) {
    errors.push(err('shape', 'shape_not_an_object',
      '"shape" must be an object describing the roster and league size.', raw.shape));
    return errors;
  }
  const s = raw.shape;

  validateBoundedInt(errors, 'shape.teams', s.teams, LEAGUE_BOUNDS.teams, 'Teams in the league');
  validateBoundedInt(errors, 'shape.draft_rounds', s.draft_rounds,
    LEAGUE_BOUNDS.draft_rounds, 'Draft rounds');
  validateBoundedInt(errors, 'shape.playoff_week_start', s.playoff_week_start,
    LEAGUE_BOUNDS.playoff_week_start, 'Playoff start week');

  /* roster_positions */
  let starters = null;
  let bench = null;
  if (s.roster_positions == null) {
    errors.push(err('shape.roster_positions', 'roster_positions_missing',
      'No "roster_positions" — the default QB/RB/RB/WR/WR/TE/FLEX + 6 bench roster is used.',
      s.roster_positions, 'warning'));
  } else if (!Array.isArray(s.roster_positions)) {
    errors.push(err('shape.roster_positions', 'roster_positions_not_an_array',
      '"roster_positions" must be an array of slot tokens, e.g. ["QB","RB","RB","WR","WR","TE","FLEX","BN"].',
      s.roster_positions));
  } else {
    const list = s.roster_positions;
    if (list.length === 0) {
      errors.push(err('shape.roster_positions', 'roster_positions_empty',
        'A roster needs at least one slot.', list));
    }
    if (list.length > LEAGUE_BOUNDS.roster_size[1]) {
      errors.push(err('shape.roster_positions', 'roster_too_large',
        `A roster may have at most ${LEAGUE_BOUNDS.roster_size[1]} slots (got ${list.length}).`,
        list.length));
    }
    list.forEach((tok, i) => {
      const t = upper(tok);
      if (!ROSTER_TOKENS.includes(t)) {
        errors.push(err(`shape.roster_positions[${i}]`, 'unknown_roster_token',
          `"${tok}" is not a slot this app knows. Use one of: ${ROSTER_TOKENS.join(', ')}.`,
          tok));
      }
    });
    const valid = list.map(upper).filter((t) => ROSTER_TOKENS.includes(t));
    starters = valid.filter((t) => t !== BENCH_TOKEN).length;
    bench = valid.length - starters;
    if (starters === 0 && list.length > 0) {
      errors.push(err('shape.roster_positions', 'no_starters',
        'This roster has no starting slots — at least one non-BN slot is required.', list));
    }
    if (Number.isFinite(Number(s.starters)) && Number(s.starters) !== starters) {
      errors.push(err('shape.starters', 'starters_mismatch',
        `"starters" says ${s.starters} but "roster_positions" contains ${starters} `
        + 'starting slots. roster_positions wins.', s.starters));
    }
    if (Number.isFinite(Number(s.bench)) && Number(s.bench) !== bench) {
      errors.push(err('shape.bench', 'bench_mismatch',
        `"bench" says ${s.bench} but "roster_positions" contains ${bench} BN slots. `
        + 'roster_positions wins.', s.bench));
    }
  }

  /* flex_eligibility */
  if (s.flex_eligibility != null && !isPlainObject(s.flex_eligibility)) {
    errors.push(err('shape.flex_eligibility', 'flex_eligibility_not_an_object',
      '"flex_eligibility" must map a flex token to an array of positions.', s.flex_eligibility));
  } else if (isPlainObject(s.flex_eligibility)) {
    Object.keys(s.flex_eligibility).forEach((token) => {
      const t = upper(token);
      const v = s.flex_eligibility[token];
      if (!FLEX_ELIGIBILITY[t]) {
        errors.push(err(`shape.flex_eligibility.${token}`, 'unknown_flex_token',
          `"${token}" is not a flex slot. Use one of: ${FLEX_TOKENS.join(', ')}.`, token));
        return;
      }
      if (!Array.isArray(v) || v.length === 0) {
        errors.push(err(`shape.flex_eligibility.${token}`, 'flex_positions_empty',
          `"${token}" must list at least one eligible position, e.g. ["WR","RB","TE"].`, v));
        return;
      }
      v.forEach((p, i) => {
        if (!POSITIONS.includes(upper(p))) {
          errors.push(err(`shape.flex_eligibility.${token}[${i}]`, 'unknown_flex_position',
            `"${p}" is not a position. Use one of: ${POSITIONS.join(', ')}.`, p));
        }
      });
    });
  }

  /* position_caps */
  if (s.position_caps != null && !isPlainObject(s.position_caps)) {
    errors.push(err('shape.position_caps', 'position_caps_not_an_object',
      '"position_caps" must map a position to a maximum count, e.g. {"QB": 2}.',
      s.position_caps));
  } else if (isPlainObject(s.position_caps)) {
    Object.keys(s.position_caps).forEach((pos) => {
      const v = s.position_caps[pos];
      if (!POSITIONS.includes(upper(pos))) {
        errors.push(err(`shape.position_caps.${pos}`, 'unknown_cap_position',
          `"${pos}" is not a position. Use one of: ${POSITIONS.join(', ')}.`, pos));
      }
      if (v == null) return; // null = uncapped, allowed
      const n = Number(v);
      if (!Number.isInteger(n) || n < LEAGUE_BOUNDS.position_cap[0]
          || n > LEAGUE_BOUNDS.position_cap[1]) {
        errors.push(err(`shape.position_caps.${pos}`, 'cap_out_of_range',
          `Cap for "${pos}" must be a whole number from ${LEAGUE_BOUNDS.position_cap[0]} to `
          + `${LEAGUE_BOUNDS.position_cap[1]} (or null for uncapped); got ${JSON.stringify(v)}.`,
          v));
      }
    });
  }

  /* keepers */
  if (s.keepers_enabled != null && typeof s.keepers_enabled !== 'boolean') {
    errors.push(err('shape.keepers_enabled', 'keepers_enabled_not_a_boolean',
      '"keepers_enabled" must be true or false.', s.keepers_enabled));
  }
  if (s.max_keepers != null) {
    validateBoundedInt(errors, 'shape.max_keepers', s.max_keepers,
      LEAGUE_BOUNDS.max_keepers, 'Max keepers');
    const mk = Number(s.max_keepers);
    if (Number.isInteger(mk)) {
      if (s.keepers_enabled === true && mk < 1) {
        errors.push(err('shape.max_keepers', 'keepers_enabled_without_keepers',
          'Keepers are on but "max_keepers" is 0 — set a maximum or turn keepers off.', mk));
      }
      if (s.keepers_enabled !== true && mk > 0) {
        errors.push(err('shape.max_keepers', 'keepers_disabled_with_max',
          `Keepers are off, so "max_keepers": ${mk} is ignored (it will be stored as 0).`,
          mk, 'warning'));
      }
      const rounds = Number(s.draft_rounds);
      if (Number.isInteger(rounds) && mk > rounds) {
        errors.push(err('shape.max_keepers', 'keepers_exceed_draft_rounds',
          `"max_keepers" (${mk}) cannot exceed "draft_rounds" (${rounds}) — every keeper `
          + 'costs a pick.', mk));
      }
      if (starters != null && mk > starters + bench) {
        errors.push(err('shape.max_keepers', 'keepers_exceed_roster',
          `"max_keepers" (${mk}) cannot exceed the ${starters + bench} roster slots.`, mk));
      }
    }
  }

  return errors;
}

function validateBoundedInt(errors, path, value, bounds, label) {
  if (value == null) return;
  const n = Number(value);
  if (!Number.isInteger(n) || n < bounds[0] || n > bounds[1]) {
    errors.push(err(path, 'out_of_range',
      `${label} must be a whole number from ${bounds[0]} to ${bounds[1]} `
      + `(got ${JSON.stringify(value)}).`, value));
  }
}

/** True when the error list contains a blocking error (warnings do not block). */
export function hasBlockingErrors(errors) {
  return (errors || []).some((e) => e && e.severity === 'error');
}

/* --------------------------------------------------------------------------
 * Roster geometry derived from a profile
 * ------------------------------------------------------------------------ */

/**
 * Slot IDs for a profile: { starters, bench, all }.
 *
 * Numbering mirrors app/draft-sim.js rosterShape(): fixed positions are always
 * numbered (QB1, RB1, RB2), a flex token appearing ONCE keeps its bare name
 * (FLEX, SUPER_FLEX) and repeats are numbered (FLEX1, FLEX2). With the DEFAULT
 * profile this returns exactly today's STARTER_SLOTS + BENCH_SLOTS.
 */
export function rosterSlots(profile) {
  const p = normalizeProfile(profile);
  const positions = p.shape.roster_positions;
  const starterTokens = positions.filter((t) => t !== BENCH_TOKEN);
  const totals = {};
  starterTokens.forEach((t) => { totals[t] = (totals[t] || 0) + 1; });
  const seen = {};
  const starters = starterTokens.map((t) => {
    seen[t] = (seen[t] || 0) + 1;
    if (FLEX_ELIGIBILITY[t] && totals[t] === 1) return t;
    return `${t}${seen[t]}`;
  });
  const benchCount = positions.length - starterTokens.length;
  const bench = [];
  for (let i = 1; i <= benchCount; i += 1) bench.push(`BN${i}`);
  return { starters, bench, all: [...starters, ...bench] };
}

/** The roster token a slot ID came from ('RB2' -> 'RB', 'FLEX' -> 'FLEX'). */
export function slotToken(slotId, profile) {
  const id = upper(slotId);
  if (!id) return null;
  const { starters, bench } = rosterSlots(profile);
  if (bench.includes(id)) return BENCH_TOKEN;
  const p = normalizeProfile(profile);
  const starterTokens = p.shape.roster_positions.filter((t) => t !== BENCH_TOKEN);
  const idx = starters.indexOf(id);
  return idx === -1 ? null : starterTokens[idx];
}

/**
 * Positions a slot ID accepts. Bench takes everything on the roster; a fixed
 * slot takes its own position; a flex slot takes the profile's eligibility for
 * that token. Unknown slot -> [].
 */
export function slotEligiblePositions(slotId, profile) {
  const p = normalizeProfile(profile);
  const token = slotToken(slotId, p);
  if (!token) return [];
  if (token === BENCH_TOKEN) return rosterPositionsInPlay(p);
  if (FLEX_ELIGIBILITY[token]) {
    const list = p.shape.flex_eligibility[token];
    return Array.isArray(list) ? [...list] : [...FLEX_ELIGIBILITY[token].positions];
  }
  return [token];
}

/** Every position this profile can actually roster (fixed slots + flex slots). */
export function rosterPositionsInPlay(profile) {
  const p = normalizeProfile(profile);
  const out = [];
  p.shape.roster_positions.forEach((token) => {
    if (token === BENCH_TOKEN) return;
    const list = FLEX_ELIGIBILITY[token]
      ? (p.shape.flex_eligibility[token] || FLEX_ELIGIBILITY[token].positions)
      : [token];
    list.forEach((pos) => { if (!out.includes(pos)) out.push(pos); });
  });
  return out;
}

/** May `position` occupy `slotId` under this profile? */
export function slotAccepts(position, slotId, profile) {
  const pos = upper(position);
  if (!pos) return false;
  return slotEligiblePositions(slotId, profile).includes(pos);
}

/** The first open slot (starters before bench) `position` may take, or null. */
export function firstOpenSlot(position, slots, profile) {
  const p = normalizeProfile(profile);
  const order = rosterSlots(p).all;
  const taken = slots || {};
  return order.find((s) => !taken[s] && slotAccepts(position, s, p)) || null;
}

/** Roster cap for a position, or null when the position is uncapped. */
export function positionCap(position, profile) {
  const p = normalizeProfile(profile);
  const pos = upper(position);
  const cap = p.shape.position_caps[pos];
  return Number.isFinite(cap) ? cap : null;
}

/** Total roster slots (starters + bench). */
export function rosterSize(profile) {
  const p = normalizeProfile(profile);
  return p.shape.starters + p.shape.bench;
}

/** True when this profile is identical to DEFAULT_PROFILE (nothing customised). */
export function isDefaultProfile(profile) {
  return JSON.stringify(normalizeProfile(profile)) === JSON.stringify(DEFAULT_PROFILE);
}

/* --------------------------------------------------------------------------
 * Scoring applicator — EXACT arithmetic
 * ------------------------------------------------------------------------ */

/**
 * Points for a set of stat components under this profile.
 *
 *   points = SUM over stat keys of ( stat_value x points_per_unit )
 *
 * Exact per-stat arithmetic — NEVER a scale factor applied to a PPR total.
 * Stats the profile does not score contribute nothing; stats the profile scores
 * but the caller did not supply contribute nothing (a missing stat is missing,
 * not zero-scored fabrication). Non-finite inputs are skipped. Never throws.
 */
export function applyScoring(stats, profile) {
  if (!isPlainObject(stats)) return 0;
  const p = normalizeProfile(profile);
  let total = 0;
  scoredKeys(stats, p).forEach((key) => {
    total += toFinite(stats[key]) * toFinite(p.scoring[key]);
  });
  return total;
}

/**
 * Per-key breakdown of applyScoring(), most-positive contribution first, ties
 * broken by the display order of SCORING_FIELDS then key name (deterministic).
 * Each row: { key, stat, points_per, points }. Rows sum EXACTLY to
 * applyScoring() only up to float association — use applyScoring() for the total.
 */
export function scoringBreakdown(stats, profile) {
  if (!isPlainObject(stats)) return [];
  const p = normalizeProfile(profile);
  const rows = scoredKeys(stats, p).map((key) => ({
    key,
    stat: toFinite(stats[key]),
    points_per: toFinite(p.scoring[key]),
    points: toFinite(stats[key]) * toFinite(p.scoring[key]),
  }));
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const ia = SCORING_ORDER.has(a.key) ? SCORING_ORDER.get(a.key) : Infinity;
    const ib = SCORING_ORDER.has(b.key) ? SCORING_ORDER.get(b.key) : Infinity;
    if (ia !== ib) return ia - ib;
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });
  return rows;
}

/** Stat keys present in BOTH the stat line and the scoring table, in table order. */
function scoredKeys(stats, profile) {
  return Object.keys(profile.scoring).filter((key) => (
    Object.prototype.hasOwnProperty.call(stats, key)
    && toFinite(stats[key]) !== null
    && toFinite(profile.scoring[key]) !== null
  ));
}

/**
 * The reception mode this profile's scoring implies: 'ppr' (rec=1),
 * 'half' (0.5), 'std' (0) or 'custom' (anything else).
 *
 * Derived from the `rec` value ALONE — that is exactly what
 * app/team-logic.js scoringAdjust() keys off, so this is the honest bridge
 * between a full profile and the existing season-points conversion. It says
 * nothing about the rest of the scoring table.
 */
export function scoringMode(profile) {
  const p = normalizeProfile(profile);
  const rec = toFinite(p.scoring.rec);
  if (rec === null) return 'std';
  if (rec === 1) return 'ppr';
  if (rec === 0.5) return 'half';
  if (rec === 0) return 'std';
  return 'custom';
}

/* --------------------------------------------------------------------------
 * Persistence — localStorage, defensive, never throws
 * ------------------------------------------------------------------------ */

/** The ambient localStorage, or null when unavailable/blocked. */
function defaultStorage() {
  try {
    const g = typeof globalThis === 'undefined' ? null : globalThis;
    return g && g.localStorage ? g.localStorage : null;
  } catch (err2) {
    return null; // access itself can throw in locked-down embeds
  }
}

/**
 * Read the stored profile. Corrupt JSON, a non-object, a hostile shape, a
 * throwing storage, or no storage at all all fall back to DEFAULT_PROFILE.
 * Returns a fresh mutable profile. NEVER throws.
 */
export function loadProfile(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  let stored = null;
  try {
    stored = JSON.parse((store && store.getItem(LEAGUE_KEY)) || 'null');
  } catch (err2) {
    stored = null;
  }
  return normalizeProfile(stored);
}

/**
 * Persist a profile (normalised first, so only valid state is ever written).
 * Returns true on write, false when storage is blocked/absent — a false is
 * survivable: the caller's in-memory profile still drives the session.
 */
export function saveProfile(profile, storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  const normalized = normalizeProfile(profile);
  try {
    store.setItem(LEAGUE_KEY, JSON.stringify(normalized));
    return true;
  } catch (err2) {
    return false;
  }
}

/** Forget the stored profile (back to DEFAULT). Never throws. */
export function clearProfile(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  try {
    store.removeItem(LEAGUE_KEY);
    return true;
  } catch (err2) {
    return false;
  }
}

/* --------------------------------------------------------------------------
 * R34 — the PROFILE STASH: saved, not applied
 * ------------------------------------------------------------------------ */

/**
 * Where a profile that is SAVED BUT NOT APPLIED lives. RESTART SESSION reverts
 * the ACTIVE profile (LEAGUE_KEY) to the app default so an imported league's
 * scoring and shape stop driving every number — but the import itself was
 * expensive to obtain (a network sync) and the owner's rule is that a restart
 * must not cost it. So the applied profile is moved HERE, and a one-tap
 * RE-APPLY writes it back to LEAGUE_KEY without re-downloading anything.
 *
 * DESIGN NOTE — why a second key rather than an `applied` flag inside
 * LEAGUE_KEY: nfl2026.league.v1 IS the applied profile, read by loadProfile()
 * on every mount, and every profile a user has already stored is a bare
 * profile object under that key. Wrapping it would force a migration in the
 * hottest read path for zero benefit; a sibling key means a returning user's
 * stored profile loads byte-for-byte as before (locked by
 * tests/feature/r34_reset_theme.test.mjs), and the stash's own shape is
 * versioned independently: { version: 1, profile: <normalised profile> }.
 */
export const LEAGUE_STASH_KEY = 'nfl2026.leaguestash.v1';

/** Stash schema version (independent of PROFILE_VERSION). */
export const STASH_VERSION = 1;

/**
 * Park a profile as saved-not-applied (normalised first). Returns true on
 * write, false when storage is blocked/absent. Never throws.
 */
export function stashProfile(profile, storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  const wrapped = { version: STASH_VERSION, profile: normalizeProfile(profile) };
  try {
    store.setItem(LEAGUE_STASH_KEY, JSON.stringify(wrapped));
    return true;
  } catch (err2) {
    return false;
  }
}

/**
 * The stashed profile, normalised — or NULL when nothing usable is stashed.
 * Null, not DEFAULT_PROFILE: "no stash" and "a stashed default" are different
 * claims, and the RE-APPLY control must only render for the first. A bare
 * profile object (no {version, profile} wrapper) is accepted defensively —
 * an unwrapped write must degrade to a working stash, not a lost league.
 * NEVER throws.
 */
export function loadStashedProfile(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  let raw = null;
  try {
    raw = JSON.parse((store && store.getItem(LEAGUE_STASH_KEY)) || 'null');
  } catch (err2) {
    raw = null;
  }
  if (!isPlainObject(raw)) return null;
  const inner = isPlainObject(raw.profile) ? raw.profile : raw;
  // A wrapper with no usable profile inside — or a bare object that carries
  // neither scoring nor shape — is corrupt, and corrupt reads as "no stash".
  if (!isPlainObject(inner.scoring) && !isPlainObject(inner.shape)) return null;
  return normalizeProfile(inner);
}

/** Forget the stash. Never throws. */
export function clearStashedProfile(storage) {
  const store = storage === undefined ? defaultStorage() : storage;
  try {
    store.removeItem(LEAGUE_STASH_KEY);
    return true;
  } catch (err2) {
    return false;
  }
}
