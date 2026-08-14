/* app/sleeper.js — SLEEPER LEAGUE IMPORT (manual sync only).
 *
 * Turns a Sleeper league id into a LeagueProfile (see app/league.js). This is
 * the ONLY module in the app that talks to api.sleeper.app, and it talks to it
 * exactly once per user click.
 *
 * ============================ MANUAL SYNC ONLY ============================
 * There is NO polling, NO setInterval, NO background refresh and NO automatic
 * re-import. `SYNC_MODE` is the frozen string 'manual' and a unit test asserts
 * this file contains no interval timer. The single setTimeout in here exists
 * solely to abort a hung fetch. A league's settings change a handful of times
 * a season; a user who wants them re-read presses the button again.
 * ==========================================================================
 *
 * THREE TIERS, ALL SHIPPED. The browser leg against Sleeper is unproven from a
 * sandbox, so no tier is contingency scaffolding:
 *   1. `importFromSleeper(id)`  — GET https://api.sleeper.app/v1/league/{id}
 *   2. `importFromPastedJson(text)` — the user opens that URL themselves and
 *      pastes the response. Identical mapping, zero network.
 *   3. `importPprDefault()` — hand-build from the standard PPR default.
 * Tier 2 is not a fallback for tier 1 so much as the general case: every value
 * in a profile is hand-editable by requirement, so the editor exists anyway.
 *
 * REQUEST SHAPE (deliberate, do not "improve"):
 *   - `credentials: 'omit'`. Sleeper answers with `access-control-allow-origin: *`
 *     AND `access-control-allow-credentials: true`. That pair is ILLEGAL for a
 *     credentialed request — the browser rejects the response. Omitting
 *     credentials keeps the wildcard valid.
 *   - NO custom headers, no `Accept`, no `X-*`. Any author header outside the
 *     CORS safelist turns this into a preflighted request, and a preflight is
 *     one more thing that can fail against an endpoint we do not control.
 *   - `AbortController` + a 12s timeout so a hung socket cannot hang the page.
 *
 * HONESTY CONTRACT (this is the load-bearing part):
 *   - Nothing is silently dropped. Every Sleeper key that does not land in the
 *     profile is reported: unknown scoring keys with a non-zero value are
 *     CARRIED into the scoring table and flagged; unknown keys worth exactly 0
 *     are omitted (they cannot change a score) and listed by name; unsupported
 *     roster slots (IDP) are listed with a reason; unrecognised settings are
 *     listed with their values. `unresolvedItems(report)` returns the whole
 *     set as one flat list the UI must show.
 *   - No invented equivalences. `SCORING_ALIASES` is deliberately EMPTY —
 *     Sleeper's stat names ARE this app's stat keys (app/league.js SCORING_FIELDS
 *     was built from them), and pretending two DIFFERENT Sleeper stats mean the
 *     same thing (st_td vs def_st_td) would double-count a user's points.
 *   - No market data of any kind is read here. A Sleeper league payload carries
 *     draft-order and pricing metadata; this module never reads any of it.
 *
 * Every exported function is total: it returns a result object and NEVER throws.
 */

import {
  DEFAULT_PROFILE,
  LEAGUE_BOUNDS,
  POSITIONS,
  SCORING_FIELDS,
  cloneProfile,
  hasBlockingErrors,
  normalizeProfile,
  validateProfile,
} from './league.js';
import { TEAMS } from './teams.js';

/* --------------------------------------------------------------------------
 * Endpoint + sync policy
 * ------------------------------------------------------------------------ */

/** Sleeper's keyless, CORS-open read API. */
export const SLEEPER_API_BASE = 'https://api.sleeper.app/v1';

/** Hard ceiling on a single league read. A hung fetch must not hang the page. */
export const SLEEPER_TIMEOUT_MS = 12000;

/** Frozen policy marker. Manual only — see the header. */
export const SYNC_MODE = 'manual';

/** The three import routes, in the order the UI offers them. */
export const IMPORT_TIERS = Object.freeze([
  Object.freeze({
    id: 'api',
    label: 'Import from Sleeper',
    detail: 'Paste your league id or league URL and we read it directly from Sleeper.',
    needs_network: true,
  }),
  Object.freeze({
    id: 'paste',
    label: 'Paste league JSON',
    detail: 'Open the league URL yourself and paste the response. No network from this app.',
    needs_network: false,
  }),
  Object.freeze({
    id: 'default',
    label: 'Start from standard PPR',
    detail: 'Hand-build the league from the standard PPR default. Every value is editable.',
    needs_network: false,
  }),
]);

/** GET url for one league. */
export function leagueEndpoint(leagueId) {
  return `${SLEEPER_API_BASE}/league/${encodeURIComponent(String(leagueId))}`;
}

/* --------------------------------------------------------------------------
 * Roster slot vocabulary
 * ------------------------------------------------------------------------ */

/**
 * Sleeper roster_positions token -> app roster token.
 *
 * Sleeper and this app already agree on QB/RB/WR/TE/K/DEF/BN and on the four
 * mappable flex tokens, so this map is an IDENTITY map that exists to be
 * explicit: a token absent from it is NOT quietly passed through.
 *
 * Note the asymmetry with app/league.js FLEX_ELIGIBILITY: the app also has
 * RB_TE_FLEX, which Sleeper has no token for. That direction is app -> Sleeper
 * and is handled by league.js sleeperToken(); nothing here can produce it.
 */
export const SLEEPER_SLOT_MAP = Object.freeze({
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  DEF: 'DEF',
  DST: 'DST',
  BN: 'BN',
  FLEX: 'FLEX',
  WRRB_FLEX: 'WRRB_FLEX',
  REC_FLEX: 'REC_FLEX',
  SUPER_FLEX: 'SUPER_FLEX',
});

/**
 * Slots that are real, understood, and NOT part of the active roster geometry.
 * They are counted and reported, never folded into the bench (a taxi spot is
 * not a bench spot, and pretending otherwise inflates the roster).
 */
export const SLEEPER_RESERVE_SLOTS = Object.freeze({
  IR: 'reserve_slots',
  TAXI: 'taxi_slots',
});

/**
 * Slots this app cannot model, each with the reason the user is shown. The app
 * projects offence plus team defence; it has no individual-defensive-player or
 * punter projections, so an IDP slot cannot be filled honestly.
 */
export const UNSUPPORTED_SLOT_TOKENS = Object.freeze({
  DL: 'Individual defensive line slot — this app projects offence and team DEF only.',
  LB: 'Individual linebacker slot — this app projects offence and team DEF only.',
  DB: 'Individual defensive back slot — this app projects offence and team DEF only.',
  IDP: 'Individual defensive player slot — this app projects offence and team DEF only.',
  IDP_FLEX: 'Individual defensive flex slot — this app projects offence and team DEF only.',
  EDR: 'Edge rusher slot — this app projects offence and team DEF only.',
  DE: 'Defensive end slot — this app projects offence and team DEF only.',
  DT: 'Defensive tackle slot — this app projects offence and team DEF only.',
  CB: 'Cornerback slot — this app projects offence and team DEF only.',
  S: 'Safety slot — this app projects offence and team DEF only.',
  P: 'Punter slot — this app has no punter projections.',
});

/* --------------------------------------------------------------------------
 * Scoring vocabulary
 * ------------------------------------------------------------------------ */

const APP_SCORING_KEYS = Object.freeze(SCORING_FIELDS.map((f) => f.key));
const APP_SCORING_SET = new Set(APP_SCORING_KEYS);

/**
 * Sleeper key -> app key renames. DELIBERATELY EMPTY.
 *
 * app/league.js SCORING_FIELDS mirrors Sleeper's `scoring_settings` names by
 * construction, so all 35 keys this app computes are already literal Sleeper
 * keys and no rename is needed. This map is the extension point for a future
 * Sleeper rename — one line, not a refactor. It must never be used to equate
 * two stats that Sleeper keeps separate (e.g. `st_td`, scored by the returner,
 * and `def_st_td`, scored by the team unit): that would double-count points a
 * user never earned.
 */
export const SCORING_ALIASES = Object.freeze({});

/* --------------------------------------------------------------------------
 * Settings vocabulary
 * ------------------------------------------------------------------------ */

/**
 * League settings this app knowingly does not model. They are reported as
 * "understood, not used" rather than as unknowns, so a real unknown (a setting
 * Sleeper added after this was written) stands out instead of drowning.
 */
export const IGNORED_SETTING_KEYS = Object.freeze([
  'best_ball', 'bench_lock', 'capacity_override', 'commissioner_direct_invite',
  'daily_waivers', 'daily_waivers_days', 'daily_waivers_hour', 'daily_waivers_last_ran',
  'disable_adds', 'disable_trades', 'divisions', 'last_report', 'last_scored_leg',
  'leg', 'league_average_match', 'offseason_adds', 'pick_trading', 'playoff_round_type',
  'playoff_round_type_alt', 'playoff_seed_type', 'playoff_teams', 'playoff_type',
  'reserve_allow_cov', 'reserve_allow_dnr', 'reserve_allow_doubtful', 'reserve_allow_na',
  'reserve_allow_out', 'reserve_allow_sus', 'squads', 'start_week', 'taxi_allow_vets',
  'taxi_deadline', 'taxi_years', 'trade_deadline', 'trade_review_days', 'veto_auto_poll',
  'veto_show_votes', 'veto_votes_needed', 'waiver_budget', 'waiver_clear_days',
  'waiver_day_of_week', 'waiver_type',
]);

const IGNORED_SETTING_SET = new Set(IGNORED_SETTING_KEYS);

/** Sleeper's league `type` code -> label. */
export const SLEEPER_LEAGUE_TYPES = Object.freeze({
  0: 'redraft',
  1: 'keeper',
  2: 'dynasty',
});

/* --------------------------------------------------------------------------
 * Small helpers (local — league.js keeps its own private copies)
 * ------------------------------------------------------------------------ */

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function toFinite(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function upper(v) {
  return String(v == null ? '' : v).toUpperCase().trim();
}

function note(code, message, detail) {
  return { code, message, detail: detail === undefined ? null : detail };
}

function failure(code, message, detail) {
  return { code, message, detail: detail === undefined ? null : detail };
}

/* --------------------------------------------------------------------------
 * League id parsing
 * ------------------------------------------------------------------------ */

/**
 * Pull a Sleeper league id out of whatever the user pasted: the bare id, a
 * sleeper.com league URL, or an api.sleeper.app URL. Returns null when there is
 * no id to be found — NEVER a guess.
 *
 * Sleeper ids are numeric STRINGS (snowflake-ish, ~18 digits). The 6..32 range
 * is deliberately loose: it accepts the ids Sleeper has actually issued across
 * eras without accepting a stray year or roster number.
 *
 * A JS `number` is refused above Number.MAX_SAFE_INTEGER. An 18-digit id does
 * not survive the float64 round trip — 917214231462133760 comes back as
 * ...133800 — and silently fetching a DIFFERENT league is exactly the class of
 * quiet corruption this app forbids. The caller must pass the id as a string.
 */
export function parseLeagueId(input) {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input > 0 ? parseLeagueId(String(input)) : null;
  }
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  if (/^[0-9]{6,32}$/.test(text)) return text;

  // .../leagues/<id>/... (sleeper.com) or .../league/<id> (api.sleeper.app)
  const path = text.match(/\/leagues?\/([0-9]{6,32})(?:[/?#]|$)/);
  if (path) return path[1];

  // ?league_id=<id>
  const query = text.match(/[?&]league_id=([0-9]{6,32})(?:[&#]|$)/);
  if (query) return query[1];

  return null;
}

/* --------------------------------------------------------------------------
 * Scoring mapping
 * ------------------------------------------------------------------------ */

/**
 * Map Sleeper's `scoring_settings` (145+ keys in a real league) onto a profile
 * scoring table.
 *
 * Four buckets, and every input key lands in exactly one of them:
 *   mapped        - a stat this app computes. Kept, including explicit zeros,
 *                   because "this league scores 0 for X" is information.
 *   carried       - not a stat this app computes, but WORTH POINTS. Kept in the
 *                   table (app/league.js applies unknown keys exactly like known
 *                   ones) and flagged, because no projection feeds it.
 *   dropped_zero  - not computed AND worth exactly 0. Omitted from the table —
 *                   it can never change a score — but listed by name.
 *   invalid       - a value that is not a finite number. Omitted and listed,
 *                   never coerced (Number(null) === 0 would invent a rule).
 */
export function mapScoring(scoringSettings) {
  const mapped = [];
  const carried = [];
  const droppedZero = [];
  const invalid = [];
  const scoring = {};

  if (!isPlainObject(scoringSettings)) {
    return {
      scoring: null,
      mapped,
      carried,
      dropped_zero: droppedZero,
      invalid,
      total_keys: 0,
      usable: false,
    };
  }

  Object.keys(scoringSettings).forEach((rawKey) => {
    const source = String(rawKey);
    const key = Object.prototype.hasOwnProperty.call(SCORING_ALIASES, source)
      ? SCORING_ALIASES[source]
      : source;
    const value = toFinite(scoringSettings[rawKey]);

    if (value === null) {
      invalid.push({ key: source, value: scoringSettings[rawKey] });
      return;
    }
    if (APP_SCORING_SET.has(key)) {
      scoring[key] = value;
      mapped.push({ key, value, source });
      return;
    }
    if (value === 0) {
      droppedZero.push(source);
      return;
    }
    scoring[key] = value;
    carried.push({ key, value, source });
  });

  return {
    scoring: Object.keys(scoring).length > 0 ? scoring : null,
    mapped,
    carried,
    dropped_zero: droppedZero,
    invalid,
    total_keys: Object.keys(scoringSettings).length,
    usable: Object.keys(scoring).length > 0,
  };
}

/* --------------------------------------------------------------------------
 * Roster mapping
 * ------------------------------------------------------------------------ */

/**
 * Map Sleeper's `roster_positions` onto the app's roster_positions.
 *
 * IR/TAXI are counted out into reserve_slots/taxi_slots — they are real slots
 * the app does not draft into, and folding them into BN would inflate the
 * roster. IDP slots are dropped with a stated reason. Anything unrecognised is
 * dropped with "unrecognised", never guessed at.
 */
export function mapRosterPositions(rosterPositions) {
  const kept = [];
  const unsupported = [];
  const counts = {};
  let reserveSlots = 0;
  let taxiSlots = 0;

  if (!Array.isArray(rosterPositions)) {
    return {
      roster_positions: null,
      starters: 0,
      bench: 0,
      unsupported,
      reserve_slots: 0,
      taxi_slots: 0,
      usable: false,
    };
  }

  const bump = (token, reason) => {
    if (!counts[token]) {
      counts[token] = { token, count: 0, reason };
      unsupported.push(counts[token]);
    }
    counts[token].count += 1;
  };

  rosterPositions.forEach((raw) => {
    const token = upper(raw);
    if (Object.prototype.hasOwnProperty.call(SLEEPER_SLOT_MAP, token)) {
      kept.push(SLEEPER_SLOT_MAP[token]);
      return;
    }
    if (token === 'IR') { reserveSlots += 1; return; }
    if (token === 'TAXI') { taxiSlots += 1; return; }
    if (Object.prototype.hasOwnProperty.call(UNSUPPORTED_SLOT_TOKENS, token)) {
      bump(token, UNSUPPORTED_SLOT_TOKENS[token]);
      return;
    }
    bump(token || '(blank)', 'Unrecognised Sleeper slot token — nothing in this app maps to it.');
  });

  const starters = kept.filter((t) => t !== 'BN');
  const bench = kept.length - starters.length;

  return {
    roster_positions: kept.length > 0 ? [...starters, ...new Array(bench).fill('BN')] : null,
    starters: starters.length,
    bench,
    unsupported,
    reserve_slots: reserveSlots,
    taxi_slots: taxiSlots,
    usable: starters.length > 0,
  };
}

/* --------------------------------------------------------------------------
 * Settings mapping
 * ------------------------------------------------------------------------ */

/**
 * Map Sleeper's `settings` block onto the profile's shape scalars and caps.
 *
 * `context.total_rosters` is the top-level fallback for team count.
 *
 * KEEPER INFERENCE is the one genuinely ambiguous mapping and is always
 * reported: Sleeper stores `max_keepers: 1` on plain redraft leagues, so
 * `max_keepers > 0` is NOT "this league has keepers". We trust `type`
 * (0 redraft / 1 keeper / 2 dynasty) when it is present and fall back to
 * `max_keepers > 1` when it is not — and either way we emit a note carrying the
 * raw values so the user can flip the toggle if we read it wrong.
 */
export function mapSettings(settings, context) {
  const ctx = isPlainObject(context) ? context : {};
  const s = isPlainObject(settings) ? settings : {};
  const notes = [];
  const ignored = [];
  const unmapped = [];
  const capsUnmapped = [];
  const positionCaps = {};
  const shape = {};
  let capKeysSeen = 0;

  const consumed = new Set([
    'num_teams', 'draft_rounds', 'playoff_week_start', 'max_keepers', 'type',
    'reserve_slots', 'taxi_slots',
  ]);

  /* ---- teams ---- */
  const teams = toFinite(s.num_teams);
  const totalRosters = toFinite(ctx.total_rosters);
  if (teams !== null) {
    shape.teams = teams;
  } else if (totalRosters !== null) {
    shape.teams = totalRosters;
    notes.push(note('teams_from_total_rosters',
      'League size came from "total_rosters" — settings.num_teams was absent.',
      { total_rosters: totalRosters }));
  } else {
    notes.push(note('teams_missing',
      `No league size in the payload; the default of ${DEFAULT_PROFILE.shape.teams} teams is used. `
      + 'Check it before drafting.', null));
  }

  /* ---- draft rounds ---- */
  const rounds = toFinite(s.draft_rounds);
  if (rounds !== null) {
    shape.draft_rounds = rounds;
  } else {
    notes.push(note('draft_rounds_missing',
      'No "draft_rounds" in the league settings; it will track the roster size.', null));
  }

  /* ---- playoffs ---- */
  const playoff = toFinite(s.playoff_week_start);
  if (playoff !== null && playoff >= LEAGUE_BOUNDS.playoff_week_start[0]) {
    shape.playoff_week_start = playoff;
  } else if (playoff !== null) {
    notes.push(note('playoff_week_auto',
      `Sleeper reports playoff_week_start = ${playoff} ("auto"), so the default week `
      + `${DEFAULT_PROFILE.shape.playoff_week_start} is used.`, playoff));
  }

  /* ---- keepers (inferred — always reported) ---- */
  const typeCode = toFinite(s.type);
  const maxKeepers = toFinite(s.max_keepers);
  const typeLabel = typeCode !== null && SLEEPER_LEAGUE_TYPES[typeCode]
    ? SLEEPER_LEAGUE_TYPES[typeCode]
    : null;
  let keepersEnabled;
  if (typeCode !== null && typeLabel) {
    keepersEnabled = typeCode === 1 || typeCode === 2;
  } else {
    // Sleeper stores max_keepers: 1 on redraft leagues, so 1 does not mean "one keeper".
    keepersEnabled = maxKeepers !== null && maxKeepers > 1;
    notes.push(note('keepers_inferred_from_max',
      'This league has no "type", so keepers were inferred from "max_keepers" '
      + '(Sleeper stores 1 on plain redraft leagues). Check the keeper toggle.',
      { max_keepers: maxKeepers }));
  }
  shape.keepers_enabled = keepersEnabled;
  shape.max_keepers = keepersEnabled && maxKeepers !== null ? maxKeepers : 0;
  notes.push(note('keepers_read',
    keepersEnabled
      ? `Read as a ${typeLabel || 'keeper'} league with up to ${shape.max_keepers} keeper(s).`
      : `Read as a ${typeLabel || 'redraft'} league — keepers off.`,
    { type: typeCode, type_label: typeLabel, max_keepers: maxKeepers }));

  /* ---- reserve / taxi (not part of the drafted roster) ---- */
  const reserve = toFinite(s.reserve_slots);
  const taxi = toFinite(s.taxi_slots);

  /* ---- position caps ---- */
  Object.keys(s).forEach((key) => {
    if (!/^position_limit_/.test(key)) return;
    consumed.add(key);
    capKeysSeen += 1;
    const pos = upper(key.replace(/^position_limit_/, ''));
    const value = toFinite(s[key]);
    if (!POSITIONS.includes(pos)) {
      capsUnmapped.push({
        key,
        value: s[key],
        position: pos,
        reason: `"${pos}" is not a position this app rosters, so its limit cannot be applied.`,
      });
      return;
    }
    if (value === null) {
      capsUnmapped.push({
        key, value: s[key], position: pos, reason: 'Limit is not a number, so it was not applied.',
      });
      return;
    }
    if (value < 0) {
      // Sleeper uses a negative limit to mean "no limit".
      notes.push(note('position_limit_uncapped',
        `Sleeper reports no limit at ${pos} (${key} = ${value}), so ${pos} is uncapped.`,
        { key, value }));
      return;
    }
    positionCaps[pos] = value;
  });

  if (capKeysSeen === 0) {
    notes.push(note('no_position_limits',
      'This league sets no position limits, so the app\'s default caps '
      + '(QB 2, K 1, DEF 1, DST 1) are removed — nothing will stop you rostering five QBs.',
      DEFAULT_PROFILE.shape.position_caps));
  }

  /* ---- everything else ---- */
  Object.keys(s).forEach((key) => {
    if (consumed.has(key)) return;
    if (IGNORED_SETTING_SET.has(key)) { ignored.push(key); return; }
    unmapped.push({ key, value: s[key] });
  });

  return {
    shape,
    position_caps: positionCaps,
    caps_unmapped: capsUnmapped,
    reserve_slots: reserve === null ? null : reserve,
    taxi_slots: taxi === null ? null : taxi,
    league_type: typeCode,
    league_type_label: typeLabel,
    ignored,
    unmapped,
    notes,
  };
}

/* --------------------------------------------------------------------------
 * Payload -> profile
 * ------------------------------------------------------------------------ */

/**
 * Turn a raw Sleeper league payload into { ok, profile, report, error }.
 * Never throws. `opts.source` labels the tier in the report; `opts.now` is an
 * injectable epoch-ms clock so tests are deterministic.
 */
export function sleeperToProfile(payload, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const source = typeof options.source === 'string' ? options.source : 'api';
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const syncedAt = new Date(nowMs).toISOString();

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      profile: null,
      report: null,
      error: failure('not_a_league',
        'That is not a Sleeper league object. Expected the JSON from '
        + 'https://api.sleeper.app/v1/league/{league_id}.', payload === null ? null : typeof payload),
    };
  }
  if (!Array.isArray(payload.roster_positions) || !isPlainObject(payload.scoring_settings)) {
    return {
      ok: false,
      profile: null,
      report: null,
      error: failure('not_a_league',
        'This JSON has no "roster_positions" array and/or no "scoring_settings" object, '
        + 'so it is not a Sleeper league. Did you paste a roster or a user response?',
        Object.keys(payload).slice(0, 12)),
    };
  }

  const scoring = mapScoring(payload.scoring_settings);
  const roster = mapRosterPositions(payload.roster_positions);
  const settings = mapSettings(payload.settings, { total_rosters: payload.total_rosters });
  const notes = [...settings.notes];

  if (!roster.usable) {
    return {
      ok: false,
      profile: null,
      report: buildReport({
        source, syncedAt, payload, scoring, roster, settings, notes, validation: [],
      }),
      error: failure('no_supported_slots',
        'Every starting slot in this league is one this app cannot fill (IDP or unknown). '
        + 'There is nothing to import.',
        roster.unsupported.map((u) => u.token)),
    };
  }
  if (!scoring.usable) {
    notes.push(note('scoring_unusable',
      'No usable scoring values were found, so the standard PPR table is used. '
      + 'Check every value before trusting a projection.', null));
  }

  if (roster.reserve_slots > 0 || roster.taxi_slots > 0) {
    notes.push(note('reserve_slots_excluded',
      `${roster.reserve_slots} IR and ${roster.taxi_slots} taxi slot(s) were read but are NOT `
      + 'part of the drafted roster, so they are excluded from the roster size.',
      { ir: roster.reserve_slots, taxi: roster.taxi_slots }));
  }
  if (settings.reserve_slots !== null && settings.reserve_slots !== roster.reserve_slots) {
    notes.push(note('reserve_slots_disagree',
      `League settings say ${settings.reserve_slots} IR slot(s) but roster_positions contains `
      + `${roster.reserve_slots}. The roster list was used.`,
      { settings: settings.reserve_slots, roster_positions: roster.reserve_slots }));
  }
  if (roster.unsupported.length > 0) {
    notes.push(note('slots_dropped',
      `${roster.unsupported.reduce((n, u) => n + u.count, 0)} roster slot(s) could not be `
      + 'imported and were left out of the roster.',
      roster.unsupported.map((u) => `${u.token} x${u.count}`)));
  }
  if (scoring.carried.length > 0) {
    notes.push(note('scoring_carried',
      `${scoring.carried.length} scoring rule(s) were kept exactly as this league has them but `
      + 'no projection in this app feeds them, so they contribute 0 to every projected total.',
      scoring.carried.map((c) => c.key)));
  }
  if (scoring.invalid.length > 0) {
    notes.push(note('scoring_invalid',
      `${scoring.invalid.length} scoring value(s) were not numbers and were left out.`,
      scoring.invalid.map((i) => i.key)));
  }

  const rawProfile = {
    version: DEFAULT_PROFILE.version,
    name: typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : DEFAULT_PROFILE.name,
    ...(scoring.usable ? { scoring: scoring.scoring } : {}),
    shape: {
      ...settings.shape,
      roster_positions: roster.roster_positions,
      position_caps: settings.position_caps,
      // R26 — these caps came from the league's real position_limit_* settings,
      // which Sleeper ENFORCES at the roster. Marking them lets team-logic
      // honour them exactly instead of adding the +1 bye/injury allowance it
      // gives a hand-typed cap; without the mark the app could recommend a
      // third QB this league will not let you roster.
      position_caps_source: 'sleeper',
    },
  };

  const validation = validateProfile(rawProfile);
  const profile = normalizeProfile(rawProfile);

  return {
    ok: true,
    profile,
    report: buildReport({
      source, syncedAt, payload, scoring, roster, settings, notes, validation,
    }),
    error: null,
  };
}

function buildReport({ source, syncedAt, payload, scoring, roster, settings, notes, validation }) {
  return {
    source,
    synced_at: syncedAt,
    league: {
      id: payload.league_id == null ? null : String(payload.league_id),
      name: typeof payload.name === 'string' ? payload.name : null,
      season: payload.season == null ? null : String(payload.season),
      season_type: payload.season_type == null ? null : String(payload.season_type),
      sport: payload.sport == null ? null : String(payload.sport),
      status: payload.status == null ? null : String(payload.status),
      type: settings.league_type,
      type_label: settings.league_type_label,
      previous_league_id: payload.previous_league_id == null
        ? null : String(payload.previous_league_id),
    },
    scoring: {
      total_keys: scoring.total_keys,
      mapped: scoring.mapped,
      carried: scoring.carried,
      dropped_zero: scoring.dropped_zero,
      invalid: scoring.invalid,
    },
    roster: {
      roster_positions: roster.roster_positions,
      starters: roster.starters,
      bench: roster.bench,
      unsupported: roster.unsupported,
      reserve_slots: roster.reserve_slots,
      taxi_slots: roster.taxi_slots,
    },
    settings: {
      position_caps: settings.position_caps,
      caps_unmapped: settings.caps_unmapped,
      ignored: settings.ignored,
      unmapped: settings.unmapped,
    },
    notes,
    validation,
  };
}

/* --------------------------------------------------------------------------
 * Tier 1 — direct fetch
 * ------------------------------------------------------------------------ */

/**
 * The shared GET core for every Sleeper read in this module.
 *
 * Extracted so the league read, the roster read, the user read and the matchup
 * read all issue the IDENTICAL request — same simple (never preflighted) shape,
 * same uncredentialed CORS, and ONE abort timer. A second copy of this would be
 * a second chance to get the CORS shape wrong; a unit test asserts this file
 * still contains exactly one setTimeout.
 *
 * Returns { ok, payload, status, url, error } and never throws.
 *
 * texts: { noFetch, missing, missingDetail, hint } — the caller supplies the
 * user-facing wording so a roster failure does not talk about league JSON.
 */
async function sleeperGetJson(url, opts, texts) {
  const options = isPlainObject(opts) ? opts : {};
  const t = isPlainObject(texts) ? texts : {};
  const hint = typeof t.hint === 'string' && t.hint ? t.hint : 'paste the JSON from that URL';

  const fetchImpl = typeof options.fetch === 'function'
    ? options.fetch
    : (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null);
  if (!fetchImpl) {
    return {
      ok: false,
      payload: null,
      status: 0,
      url,
      error: failure('no_fetch',
        t.noFetch || 'This browser has no fetch, so this read cannot run.', null),
    };
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : SLEEPER_TIMEOUT_MS;
  const Ctor = typeof options.AbortController === 'function'
    ? options.AbortController
    : (typeof AbortController === 'function' ? AbortController : null);

  const controller = Ctor ? new Ctor() : null;
  let timedOut = false;
  let timer = null;
  let onExternalAbort = null;

  if (controller) {
    // NOT unref'd: an unref'd timer lets the event loop drain before the abort
    // can fire, which is the same as having no timeout at all. `cleanup()` in
    // the finally block clears it on every path, so it cannot outlive the call.
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(); } catch (_) { /* already aborted */ }
    }, timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) {
        try { controller.abort(); } catch (_) { /* already aborted */ }
      } else if (typeof options.signal.addEventListener === 'function') {
        onExternalAbort = () => { try { controller.abort(); } catch (_) { /* noop */ } };
        options.signal.addEventListener('abort', onExternalAbort);
      }
    }
  }

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (onExternalAbort && options.signal
        && typeof options.signal.removeEventListener === 'function') {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  };

  try {
    // NO `headers` key: any author header outside the CORS safelist would make
    // this a preflighted request. `credentials: 'omit'` keeps Sleeper's
    // wildcard ACAO legal. `cache: 'no-store'` adds no header of its own.
    const res = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    });

    if (!res || typeof res.status !== 'number') {
      return {
        ok: false, payload: null, status: 0, url,
        error: failure('bad_response', 'Sleeper returned something that is not an HTTP response.',
          null),
      };
    }
    if (res.status === 404) {
      return {
        ok: false, payload: null, status: 404, url,
        error: failure('not_found',
          t.missing || `Sleeper has nothing at ${url}.`,
          t.missingDetail === undefined ? null : t.missingDetail),
      };
    }
    if (res.status === 429) {
      return {
        ok: false, payload: null, status: 429, url,
        error: failure('rate_limited',
          'Sleeper is rate-limiting this device. Wait a minute and press sync again, '
          + `or ${hint}.`, null),
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false, payload: null, status: res.status, url,
        error: failure('http_error',
          `Sleeper answered HTTP ${res.status}. Try again, or ${hint}.`,
          res.status),
      };
    }

    let text;
    try {
      text = await res.text();
    } catch (readErr) {
      return {
        ok: false, payload: null, status: res.status, url,
        error: failure('network', 'The connection dropped while reading Sleeper\'s response.',
          String(readErr && readErr.message ? readErr.message : readErr)),
      };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (parseErr) {
      return {
        ok: false, payload: null, status: res.status, url,
        error: failure('bad_json', 'Sleeper\'s response was not JSON.',
          String(text).slice(0, 200)),
      };
    }
    if (payload === null) {
      // Sleeper answers 200 with a literal `null` body for an unknown resource.
      return {
        ok: false, payload: null, status: res.status, url,
        error: failure('not_found',
          t.missing || `Sleeper has nothing at ${url}.`,
          t.missingDetail === undefined ? null : t.missingDetail),
      };
    }

    return { ok: true, payload, status: res.status, url, error: null };
  } catch (err) {
    const name = err && err.name ? String(err.name) : '';
    if (timedOut) {
      return {
        ok: false, payload: null, status: 0, url,
        error: failure('timeout',
          `Sleeper did not answer within ${Math.round(timeoutMs / 1000)}s. `
          + `Try again, or ${hint}.`, timeoutMs),
      };
    }
    if (name === 'AbortError') {
      return {
        ok: false, payload: null, status: 0, url,
        error: failure('aborted', 'The import was cancelled.', null),
      };
    }
    return {
      ok: false, payload: null, status: 0, url,
      error: failure('network',
        'Could not reach Sleeper. This is usually the network or a browser extension '
        + `blocking the request — ${hint} instead.`,
        String(err && err.message ? err.message : err)),
    };
  } finally {
    cleanup();
  }
}

/**
 * Parse the league id or return the ready-made bad-id failure. Every endpoint
 * in this module takes the same id/URL input, so they all reject it the same
 * way and none of them reaches the network with a guess.
 */
function requireLeagueId(idOrUrl) {
  const leagueId = parseLeagueId(idOrUrl);
  if (leagueId) return { ok: true, leagueId, error: null };
  return {
    ok: false,
    leagueId: null,
    error: failure('bad_league_id',
      'That is not a Sleeper league id. Paste the number from your league URL, '
      + 'e.g. https://sleeper.com/leagues/1051234567890123456/team.', idOrUrl),
  };
}

/**
 * GET one league from Sleeper. Returns { ok, payload, status, error } and never
 * throws — a rejected fetch, a timeout and a 500 all come back as data.
 *
 * opts: { fetch, timeoutMs, signal, AbortController } — all injectable so the
 * unit tests never touch the network.
 */
export async function fetchSleeperLeague(idOrUrl, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const id = requireLeagueId(idOrUrl);
  if (!id.ok) {
    return { ok: false, payload: null, status: 0, url: null, error: id.error };
  }
  return sleeperGetJson(leagueEndpoint(id.leagueId), options, {
    noFetch: 'This browser has no fetch, so the direct import cannot run. '
      + 'Use "Paste league JSON" instead.',
    missing: `Sleeper has no league ${id.leagueId}. Check the id in your league URL.`,
    missingDetail: id.leagueId,
    hint: 'paste the league JSON',
  });
}

/** TIER 1: fetch + map, as one call. Returns an ImportResult. */
export async function importFromSleeper(idOrUrl, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const fetched = await fetchSleeperLeague(idOrUrl, options);
  if (!fetched.ok) {
    return {
      ok: false,
      tier: 'api',
      profile: null,
      report: null,
      error: fetched.error,
      next_tier: IMPORT_TIERS[1],
    };
  }
  const mappedResult = sleeperToProfile(fetched.payload, { ...options, source: 'api' });
  return {
    ok: mappedResult.ok,
    tier: 'api',
    profile: mappedResult.profile,
    report: mappedResult.report,
    error: mappedResult.error,
    next_tier: mappedResult.ok ? null : IMPORT_TIERS[1],
  };
}

/* --------------------------------------------------------------------------
 * Tier 2 — pasted JSON
 * ------------------------------------------------------------------------ */

/**
 * TIER 2: the user opens the league URL themselves and pastes the response.
 * Accepts a JSON string or an already-parsed object. Zero network.
 */
export function importFromPastedJson(input, opts) {
  const options = isPlainObject(opts) ? opts : {};
  let payload = input;

  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) {
      return {
        ok: false,
        tier: 'paste',
        profile: null,
        report: null,
        error: failure('empty_paste',
          `Nothing was pasted. Open ${SLEEPER_API_BASE}/league/{your league id} and paste the `
          + 'whole response.', null),
        next_tier: IMPORT_TIERS[2],
      };
    }
    try {
      payload = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        tier: 'paste',
        profile: null,
        report: null,
        error: failure('bad_json',
          'That is not valid JSON. Copy the whole response, from the first { to the last }.',
          String(err && err.message ? err.message : err)),
        next_tier: IMPORT_TIERS[2],
      };
    }
  }

  const mappedResult = sleeperToProfile(payload, { ...options, source: 'paste' });
  return {
    ok: mappedResult.ok,
    tier: 'paste',
    profile: mappedResult.profile,
    report: mappedResult.report,
    error: mappedResult.error,
    next_tier: mappedResult.ok ? null : IMPORT_TIERS[2],
  };
}

/* --------------------------------------------------------------------------
 * Tier 3 — hand-build from the PPR default
 * ------------------------------------------------------------------------ */

/**
 * TIER 3: no Sleeper at all. Returns the standard PPR default profile with a
 * report that says plainly where it came from, so nothing in the UI can imply
 * these values were read from the user's league.
 */
export function importPprDefault(opts) {
  const options = isPlainObject(opts) ? opts : {};
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  return {
    ok: true,
    tier: 'default',
    profile: cloneProfile(DEFAULT_PROFILE),
    report: {
      source: 'default',
      synced_at: new Date(nowMs).toISOString(),
      league: {
        id: null,
        name: DEFAULT_PROFILE.name,
        season: null,
        season_type: null,
        sport: 'nfl',
        status: null,
        type: null,
        type_label: null,
        previous_league_id: null,
      },
      scoring: {
        total_keys: Object.keys(DEFAULT_PROFILE.scoring).length,
        mapped: Object.keys(DEFAULT_PROFILE.scoring)
          .map((key) => ({ key, value: DEFAULT_PROFILE.scoring[key], source: key })),
        carried: [],
        dropped_zero: [],
        invalid: [],
      },
      roster: {
        roster_positions: [...DEFAULT_PROFILE.shape.roster_positions],
        starters: DEFAULT_PROFILE.shape.starters,
        bench: DEFAULT_PROFILE.shape.bench,
        unsupported: [],
        reserve_slots: 0,
        taxi_slots: 0,
      },
      settings: {
        position_caps: { ...DEFAULT_PROFILE.shape.position_caps },
        caps_unmapped: [],
        ignored: [],
        unmapped: [],
      },
      notes: [note('ppr_default',
        'Nothing was imported. This is the standard PPR default, not your league — '
        + 'edit every value that differs.', null)],
      validation: [],
    },
    error: null,
    next_tier: null,
  };
}

/* --------------------------------------------------------------------------
 * Surfacing — the honesty contract, in one list
 * ------------------------------------------------------------------------ */

/**
 * Everything the import could NOT put into the profile, flattened into one list
 * the UI must render. If this returns [] the whole payload was understood.
 *
 * kind: 'scoring_carried' | 'scoring_zero' | 'scoring_invalid' | 'roster_slot'
 *     | 'position_limit' | 'setting'
 */
export function unresolvedItems(report) {
  if (!isPlainObject(report)) return [];
  const out = [];
  const scoring = isPlainObject(report.scoring) ? report.scoring : {};
  const roster = isPlainObject(report.roster) ? report.roster : {};
  const settings = isPlainObject(report.settings) ? report.settings : {};

  (scoring.carried || []).forEach((c) => out.push({
    kind: 'scoring_carried',
    key: c.key,
    value: c.value,
    message: `"${c.key}" is worth ${c.value} in your league. It is kept and applied, but this `
      + 'app has no projection for it, so it adds nothing to a projected total.',
  }));
  (scoring.dropped_zero || []).forEach((key) => out.push({
    kind: 'scoring_zero',
    key,
    value: 0,
    message: `"${key}" is worth 0 in your league, so it was left out. It cannot change a score.`,
  }));
  (scoring.invalid || []).forEach((i) => out.push({
    kind: 'scoring_invalid',
    key: i.key,
    value: i.value,
    message: `"${i.key}" had a value that is not a number (${JSON.stringify(i.value)}) and was `
      + 'left out.',
  }));
  (roster.unsupported || []).forEach((u) => out.push({
    kind: 'roster_slot',
    key: u.token,
    value: u.count,
    message: `${u.count} x ${u.token}: ${u.reason}`,
  }));
  (settings.caps_unmapped || []).forEach((c) => out.push({
    kind: 'position_limit',
    key: c.key,
    value: c.value,
    message: c.reason,
  }));
  (settings.unmapped || []).forEach((u) => out.push({
    kind: 'setting',
    key: u.key,
    value: u.value,
    message: `League setting "${u.key}" (${JSON.stringify(u.value)}) is not one this app `
      + 'understands, so it was not applied.',
  }));

  return out;
}

/** Plain-language lines for the import screen. Never invents a success. */
export function summarizeImport(result) {
  if (!isPlainObject(result)) return ['Nothing to report.'];
  if (!result.ok) {
    const lines = [result.error && result.error.message
      ? result.error.message
      : 'The import failed.'];
    if (result.next_tier) lines.push(`Next: ${result.next_tier.label} — ${result.next_tier.detail}`);
    return lines;
  }

  const report = isPlainObject(result.report) ? result.report : null;
  if (!report) return ['Imported.'];

  const lines = [];
  const league = report.league || {};
  if (result.tier === 'default') {
    lines.push('Standard PPR default — nothing was read from a league.');
  } else {
    lines.push(`${league.name || 'League'}${league.season ? ` (${league.season})` : ''}: `
      + `${report.roster.starters} starters, ${report.roster.bench} bench.`);
  }
  // Say what is TRUE, not what is flattering. "N rules mapped" reads as "your
  // scoring is now in effect", but at this release only the reception value
  // reaches a projection — a 6-point-passing-TD league still sees 4-point
  // numbers. Overstating this is worse than the gap itself, because the user
  // cannot tell the difference by looking at the number.
  lines.push(`${report.scoring.mapped.length} scoring rule(s) recognised — of these, `
    + 'only the reception value currently changes a projection. Full per-stat '
    + 'scoring arrives with the component projections.');

  const unresolved = unresolvedItems(report);
  if (unresolved.length > 0) {
    lines.push(`${unresolved.length} item(s) could not be applied — review them below.`);
  } else if (result.tier !== 'default') {
    lines.push('Every value in the payload was understood.');
  }

  (report.notes || []).forEach((n) => lines.push(n.message));

  if (hasBlockingErrors(report.validation)) {
    lines.push('Some values were out of range and were clamped — check the roster and scoring.');
  }
  return lines;
}

/* ==========================================================================
 * ROSTERS, OWNERS, MATCHUPS
 *
 * The league read above answers "what are the rules". These three reads answer
 * "who is on which team, and what did they start". Same discipline: MANUAL
 * only (every function here runs once per user click — there is still no timer
 * in this file except the fetch abort), same simple uncredentialed request via
 * sleeperGetJson(), and the same refusal to guess.
 *
 * Sleeper's shapes, for the record:
 *   /league/{id}/rosters       array, one object per team, ALWAYS all teams
 *   /league/{id}/users         array, one object per manager. A roster with no
 *                              manager has owner_id: null; a manager who left
 *                              can still appear here with no roster.
 *   /league/{id}/matchups/{wk} array, one object per team. Two teams share a
 *                              matchup_id. `starters` is SLOT-ORDERED and an
 *                              EMPTY slot is the literal string "0".
 * ======================================================================== */

/** Sleeper's marker for an empty starting slot. It is NOT a player id. */
export const SLEEPER_EMPTY_SLOT = '0';

/**
 * Weeks a matchup may be requested for. 1-18 regular season; Sleeper numbers
 * league playoff weeks straight on from there, and a 14-team league with two
 * byes can run to 22. Outside this range we refuse rather than build a URL.
 */
export const SLEEPER_WEEK_RANGE = Object.freeze([1, 22]);

/** GET url for every team's roster. */
export function rostersEndpoint(leagueId) {
  return `${leagueEndpoint(leagueId)}/rosters`;
}

/** GET url for the league's managers. */
export function leagueUsersEndpoint(leagueId) {
  return `${leagueEndpoint(leagueId)}/users`;
}

/** GET url for one week's matchups. */
export function matchupsEndpoint(leagueId, week) {
  return `${leagueEndpoint(leagueId)}/matchups/${encodeURIComponent(String(week))}`;
}

/** A week number, or null. Never a guess — "week 1" and 1.5 are both refused. */
export function parseWeek(input) {
  const n = toFinite(input);
  if (n === null || !Number.isInteger(n)) return null;
  return n >= SLEEPER_WEEK_RANGE[0] && n <= SLEEPER_WEEK_RANGE[1] ? n : null;
}

/* --------------------------------------------------------------------------
 * Fetchers
 * ------------------------------------------------------------------------ */

/** GET every roster in the league. { ok, payload, status, url, error }. */
export async function fetchSleeperRosters(idOrUrl, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const id = requireLeagueId(idOrUrl);
  if (!id.ok) return { ok: false, payload: null, status: 0, url: null, error: id.error };
  return sleeperGetJson(rostersEndpoint(id.leagueId), options, {
    noFetch: 'This browser has no fetch, so the roster read cannot run. '
      + 'Open the rosters URL yourself and paste the response.',
    missing: `Sleeper has no rosters for league ${id.leagueId}. Check the id in your league URL.`,
    missingDetail: id.leagueId,
    hint: 'paste the roster JSON',
  });
}

/** GET the league's managers. { ok, payload, status, url, error }. */
export async function fetchSleeperUsers(idOrUrl, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const id = requireLeagueId(idOrUrl);
  if (!id.ok) return { ok: false, payload: null, status: 0, url: null, error: id.error };
  return sleeperGetJson(leagueUsersEndpoint(id.leagueId), options, {
    noFetch: 'This browser has no fetch, so the manager read cannot run. '
      + 'Open the users URL yourself and paste the response.',
    missing: `Sleeper has no managers for league ${id.leagueId}. Check the id in your league URL.`,
    missingDetail: id.leagueId,
    hint: 'paste the users JSON',
  });
}

/** GET one week of matchups. A bad week never reaches the network. */
export async function fetchSleeperMatchups(idOrUrl, week, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const id = requireLeagueId(idOrUrl);
  if (!id.ok) return { ok: false, payload: null, status: 0, url: null, error: id.error };
  const wk = parseWeek(week);
  if (wk === null) {
    return {
      ok: false,
      payload: null,
      status: 0,
      url: null,
      error: failure('bad_week',
        `"${String(week)}" is not a week. Ask for a whole number between `
        + `${SLEEPER_WEEK_RANGE[0]} and ${SLEEPER_WEEK_RANGE[1]}.`, week),
    };
  }
  return sleeperGetJson(matchupsEndpoint(id.leagueId, wk), options, {
    noFetch: 'This browser has no fetch, so the matchup read cannot run. '
      + 'Open the matchups URL yourself and paste the response.',
    missing: `Sleeper has no week ${wk} matchups for league ${id.leagueId}.`,
    missingDetail: { league_id: id.leagueId, week: wk },
    hint: 'paste the matchup JSON',
  });
}

/* --------------------------------------------------------------------------
 * Roster mapping
 * ------------------------------------------------------------------------ */

/** A player id as Sleeper writes it: a non-empty string. Numbers are accepted
 * (some tools re-serialise the array) and stringified; nothing else is. */
function playerIdList(value, bucket) {
  if (!Array.isArray(value)) return [];
  const out = [];
  value.forEach((raw, i) => {
    if (typeof raw === 'string' && raw.trim() !== '') { out.push(raw.trim()); return; }
    if (typeof raw === 'number' && Number.isFinite(raw)) { out.push(String(raw)); return; }
    if (bucket) bucket.push({ index: i, value: raw });
  });
  return out;
}

/**
 * Map /rosters onto plain roster records.
 *
 * Sleeper ships `null` (not `[]`) for an empty reserve/taxi/keepers list, and
 * `owner_id: null` for a team nobody manages. Both are preserved as absence,
 * never as an empty-but-present claim.
 *
 * `points_for` follows Sleeper's split-decimal convention: `fpts` is the whole
 * part and `fpts_decimal` the hundredths, so 1180 + 42 is 1180.42. The raw
 * pair is kept alongside it so a UI never has to trust the arithmetic.
 */
export function mapRosters(payload) {
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      rosters: [],
      invalid: [],
      error: failure('not_rosters',
        'That is not a Sleeper roster list. Expected the JSON array from '
        + 'https://api.sleeper.app/v1/league/{league_id}/rosters.',
        payload === null ? null : typeof payload),
    };
  }

  const rosters = [];
  const invalid = [];

  payload.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      invalid.push({ index: i, reason: 'Not an object.', value: raw });
      return;
    }
    const rosterId = toFinite(raw.roster_id);
    if (rosterId === null) {
      invalid.push({
        index: i,
        reason: 'No roster_id, so this team cannot be identified.',
        value: raw.roster_id,
      });
      return;
    }
    const dropped = [];
    const players = playerIdList(raw.players, dropped);
    const starters = playerIdList(raw.starters, dropped);
    const s = isPlainObject(raw.settings) ? raw.settings : {};
    const meta = isPlainObject(raw.metadata) ? raw.metadata : {};
    const whole = toFinite(s.fpts);
    const decimal = toFinite(s.fpts_decimal);
    const againstWhole = toFinite(s.fpts_against);
    const againstDecimal = toFinite(s.fpts_against_decimal);

    rosters.push({
      roster_id: rosterId,
      owner_id: raw.owner_id == null ? null : String(raw.owner_id),
      co_owner_ids: Array.isArray(raw.co_owners) ? raw.co_owners.map((c) => String(c)) : [],
      players,
      starters,
      empty_starter_slots: starters.filter((p) => p === SLEEPER_EMPTY_SLOT).length,
      reserve: playerIdList(raw.reserve, dropped),
      taxi: playerIdList(raw.taxi, dropped),
      keepers: playerIdList(raw.keepers, dropped),
      dropped_ids: dropped,
      record: {
        wins: toFinite(s.wins),
        losses: toFinite(s.losses),
        ties: toFinite(s.ties),
        streak: typeof meta.streak === 'string' ? meta.streak : null,
      },
      points_for: whole === null ? null : whole + (decimal === null ? 0 : decimal / 100),
      points_against: againstWhole === null
        ? null : againstWhole + (againstDecimal === null ? 0 : againstDecimal / 100),
      points_raw: {
        fpts: whole, fpts_decimal: decimal,
        fpts_against: againstWhole, fpts_against_decimal: againstDecimal,
      },
    });
  });

  return {
    ok: rosters.length > 0,
    rosters,
    invalid,
    error: rosters.length > 0 ? null : failure('no_rosters',
      'That roster list is empty — no team could be read from it.', invalid.length),
  };
}

/* --------------------------------------------------------------------------
 * User mapping
 * ------------------------------------------------------------------------ */

/**
 * Map /users onto manager records. `display_name` is the Sleeper handle and
 * `team_name` the name the manager gave their team (metadata.team_name, which
 * is absent until they set one). Both are carried; neither is invented.
 */
export function mapLeagueUsers(payload) {
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      users: [],
      invalid: [],
      error: failure('not_users',
        'That is not a Sleeper user list. Expected the JSON array from '
        + 'https://api.sleeper.app/v1/league/{league_id}/users.',
        payload === null ? null : typeof payload),
    };
  }

  const users = [];
  const invalid = [];

  payload.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      invalid.push({ index: i, reason: 'Not an object.', value: raw });
      return;
    }
    if (raw.user_id == null || String(raw.user_id).trim() === '') {
      invalid.push({
        index: i,
        reason: 'No user_id, so this manager cannot be matched to a roster.',
        value: raw.user_id,
      });
      return;
    }
    const meta = isPlainObject(raw.metadata) ? raw.metadata : {};
    const teamName = typeof meta.team_name === 'string' && meta.team_name.trim()
      ? meta.team_name.trim()
      : null;
    users.push({
      user_id: String(raw.user_id),
      username: typeof raw.username === 'string' ? raw.username : null,
      display_name: typeof raw.display_name === 'string' && raw.display_name.trim()
        ? raw.display_name.trim()
        : null,
      team_name: teamName,
      avatar: raw.avatar == null ? null : String(raw.avatar),
      is_owner: raw.is_owner === true,
      is_bot: raw.is_bot === true,
    });
  });

  return {
    ok: users.length > 0,
    users,
    invalid,
    error: users.length > 0 ? null : failure('no_users',
      'That user list is empty — no manager could be read from it.', invalid.length),
  };
}

/* --------------------------------------------------------------------------
 * Roster + user join
 * ------------------------------------------------------------------------ */

/**
 * Join rosters to managers so a team can be shown with a human-readable label
 * — which is the ONLY way a user can point at "mine". A roster whose owner is
 * missing keeps its roster_id label and is listed in `orphan_rosters`; a
 * manager with no roster is listed in `users_without_roster`. Nothing is
 * silently paired.
 */
export function joinRosters(rosters, users) {
  const rosterList = Array.isArray(rosters) ? rosters : [];
  const userList = Array.isArray(users) ? users : [];
  const byUserId = new Map(userList.map((u) => [String(u.user_id), u]));
  const claimed = new Set();
  const orphanRosters = [];

  const teams = rosterList.map((r) => {
    const ownerId = r.owner_id == null ? null : String(r.owner_id);
    const user = ownerId ? byUserId.get(ownerId) || null : null;
    if (user) claimed.add(ownerId);
    if (!user) {
      orphanRosters.push({
        roster_id: r.roster_id,
        owner_id: ownerId,
        reason: ownerId === null
          ? 'This team has no manager on Sleeper (an open team).'
          : `Manager ${ownerId} is not in the league user list, so this team has no name.`,
      });
    }
    const displayName = user ? user.display_name : null;
    const teamName = user ? user.team_name : null;
    return {
      roster_id: r.roster_id,
      owner_id: ownerId,
      user_id: user ? user.user_id : null,
      display_name: displayName,
      username: user ? user.username : null,
      team_name: teamName,
      label: teamName || displayName || `Roster ${r.roster_id}`,
      owner_known: Boolean(user),
      players: r.players,
      starters: r.starters,
      reserve: r.reserve,
      taxi: r.taxi,
      keepers: r.keepers,
      record: r.record,
      points_for: r.points_for,
      points_against: r.points_against,
    };
  }).sort((a, b) => a.roster_id - b.roster_id);

  const usersWithoutRoster = userList
    .filter((u) => !claimed.has(String(u.user_id)))
    .map((u) => ({
      user_id: u.user_id,
      display_name: u.display_name,
      team_name: u.team_name,
      reason: 'This manager is in the league user list but owns no roster.',
    }));

  return { teams, orphan_rosters: orphanRosters, users_without_roster: usersWithoutRoster };
}

/**
 * The picker the UI must show: one row per team, labelled. Identifying "which
 * roster is mine" is a CHOICE the user makes — this module offers the list and
 * never picks for them.
 */
export function ownerChoices(teams) {
  return (Array.isArray(teams) ? teams : []).map((t) => ({
    roster_id: t.roster_id,
    label: t.label,
    display_name: t.display_name,
    team_name: t.team_name,
    owner_known: t.owner_known,
  }));
}

/**
 * Find one team by roster id, Sleeper handle or team name. EXACT (trimmed,
 * case-insensitive) only — no prefix and no fuzzy match, because picking the
 * wrong team silently is worse than asking again. Two hits is a failure with
 * both listed, not a coin flip.
 */
export function findTeam(teams, query) {
  const list = Array.isArray(teams) ? teams : [];
  const text = String(query == null ? '' : query).trim();
  if (!text) {
    return {
      ok: false,
      team: null,
      matches: [],
      error: failure('empty_query',
        'Enter a team name, a Sleeper username or a roster number.', null),
    };
  }

  const asNumber = toFinite(text);
  if (asNumber !== null && Number.isInteger(asNumber)) {
    const byId = list.filter((t) => t.roster_id === asNumber);
    if (byId.length === 1) return { ok: true, team: byId[0], matches: byId, error: null };
  }

  const wanted = text.toLowerCase();
  const matches = list.filter((t) => [t.display_name, t.username, t.team_name, t.label]
    .some((v) => typeof v === 'string' && v.trim().toLowerCase() === wanted));

  if (matches.length === 1) return { ok: true, team: matches[0], matches, error: null };
  if (matches.length === 0) {
    return {
      ok: false,
      team: null,
      matches: [],
      error: failure('no_match',
        `No team in this league is called "${text}". Pick one from the list instead.`,
        ownerChoices(list).map((c) => c.label)),
    };
  }
  return {
    ok: false,
    team: null,
    matches,
    error: failure('ambiguous',
      `"${text}" matches ${matches.length} teams in this league. Pick one by roster number.`,
      matches.map((m) => ({ roster_id: m.roster_id, label: m.label }))),
  };
}

/* --------------------------------------------------------------------------
 * Matchup mapping
 * ------------------------------------------------------------------------ */

/**
 * Map one week of /matchups.
 *
 * `starters` is SLOT-ORDERED and pairs positionally with `starters_points`.
 * When the two disagree in length we pair what we can and say so — we never
 * shift points onto the wrong player to make the arrays line up. A starter of
 * "0" is an EMPTY SLOT the manager left unfilled, not a player.
 */
export function mapMatchups(payload, week) {
  const wk = parseWeek(week);
  if (!Array.isArray(payload)) {
    return {
      ok: false,
      week: wk,
      matchups: [],
      invalid: [],
      warnings: [],
      error: failure('not_matchups',
        'That is not a Sleeper matchup list. Expected the JSON array from '
        + 'https://api.sleeper.app/v1/league/{league_id}/matchups/{week}.',
        payload === null ? null : typeof payload),
    };
  }

  const matchups = [];
  const invalid = [];
  const warnings = [];

  payload.forEach((raw, i) => {
    if (!isPlainObject(raw)) {
      invalid.push({ index: i, reason: 'Not an object.', value: raw });
      return;
    }
    const rosterId = toFinite(raw.roster_id);
    if (rosterId === null) {
      invalid.push({
        index: i,
        reason: 'No roster_id, so this line cannot be attached to a team.',
        value: raw.roster_id,
      });
      return;
    }
    const starters = playerIdList(raw.starters);
    const points = Array.isArray(raw.starters_points)
      ? raw.starters_points.map((v) => toFinite(v))
      : [];
    if (Array.isArray(raw.starters_points) && points.length !== starters.length) {
      warnings.push(note('starters_points_length',
        `Roster ${rosterId} has ${starters.length} starter(s) but `
        + `${points.length} starter score(s). The extra values were left unpaired.`,
        { roster_id: rosterId, starters: starters.length, points: points.length }));
    }
    const playersPoints = {};
    if (isPlainObject(raw.players_points)) {
      Object.keys(raw.players_points).forEach((k) => {
        const v = toFinite(raw.players_points[k]);
        if (v !== null) playersPoints[String(k)] = v;
      });
    }

    matchups.push({
      roster_id: rosterId,
      matchup_id: toFinite(raw.matchup_id),
      points: toFinite(raw.points),
      custom_points: toFinite(raw.custom_points),
      starters,
      starter_rows: starters.map((sleeperId, slot) => ({
        slot,
        sleeper_id: sleeperId,
        empty: sleeperId === SLEEPER_EMPTY_SLOT,
        points: slot < points.length ? points[slot] : null,
      })),
      starters_points: points,
      players: playerIdList(raw.players),
      players_points: playersPoints,
    });
  });

  return {
    ok: matchups.length > 0,
    week: wk,
    matchups,
    invalid,
    warnings,
    error: matchups.length > 0 ? null : failure('no_matchups',
      'That matchup list is empty — Sleeper returns [] for a week that has not been played.',
      invalid.length),
  };
}

/** One team's line from a mapped matchup week, or null. */
export function matchupForRoster(matchups, rosterId) {
  const id = toFinite(rosterId);
  if (id === null) return null;
  return (Array.isArray(matchups) ? matchups : []).find((m) => m.roster_id === id) || null;
}

/**
 * Group a week into head-to-head pairs. A matchup_id with one team is a BYE
 * and is reported as such; a matchup_id with three or more is a payload we do
 * not understand and is reported rather than truncated to two.
 */
function matchupKind(key, size) {
  if (key === 'none') return 'unscheduled';
  if (size === 2) return 'head_to_head';
  return size === 1 ? 'bye' : 'unexpected';
}

export function matchupPairs(matchups) {
  const groups = new Map();
  (Array.isArray(matchups) ? matchups : []).forEach((m) => {
    const key = m.matchup_id === null ? 'none' : String(m.matchup_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  const pairs = [];
  groups.forEach((rows, key) => {
    pairs.push({
      matchup_id: key === 'none' ? null : Number(key),
      roster_ids: rows.map((r) => r.roster_id),
      points: rows.map((r) => r.points),
      kind: matchupKind(key, rows.length),
    });
  });
  return pairs.sort((a, b) => (a.matchup_id === null ? 1 : 0) - (b.matchup_id === null ? 1 : 0)
    || (a.matchup_id || 0) - (b.matchup_id || 0));
}

/* ==========================================================================
 * PLAYER ID CROSSWALK
 *
 * Sleeper's player ids and this app's player ids are two unrelated namespaces:
 *   Sleeper  "4034"           its own id. Team defences use the team abbrev.
 *   this app "espn-3117251"   offence, from data/player_projections.json
 *            "00-0032726"     kickers, a gsis id, from kdst_projections.json
 *            "DST-DEN"        team defences, ditto
 *
 * Nothing in this repo carries a Sleeper id, so a roster of bare Sleeper ids
 * cannot be resolved on its own. Two things can resolve it:
 *   1. Sleeper's own player dump (GET /v1/players/nfl — ~5MB, which is why it
 *      is NOT fetched here; the caller supplies it). Each entry carries
 *      `espn_id` and often `gsis_id`, which ARE this app's ids.
 *   2. The id itself, when it is a team abbreviation — Sleeper identifies a
 *      team defence by its abbreviation, and so does this app.
 *
 * THE MATCH IS IMPERFECT AND SAYS SO. Every strategy below is an EXACT match:
 * an id equality, or a normalised name that is unique in the app's player set.
 * There is no edit distance, no nickname table and no "closest" anything. A
 * player who matches nothing, or matches two rows, comes back in `unresolved`
 * with the reason — never dropped, never guessed.
 * ======================================================================== */

/** Match strategies, strongest first. `method` on a resolved row is one of these. */
export const CROSSWALK_METHODS = Object.freeze([
  'espn_id',            // Sleeper's espn_id == this app's espn-<id>
  'gsis_id',            // Sleeper's gsis_id == this app's kicker id
  'team_def',           // a team abbreviation on both sides
  'name_team_position', // exact normalised name + team + position, unique
  'name_position',      // exact normalised name + position, unique
]);

/**
 * Historical / broadcast abbreviations Sleeper has shipped, mapped to the
 * abbreviation app/teams.js uses. These are RENAMES of the same franchise, not
 * guesses at similar spellings — the same class of fix as a team-name
 * normalisation table, and it is the only place this module rewrites an id.
 */
export const SLEEPER_TEAM_ALIASES = Object.freeze({
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
  JAC: 'JAX',
  LA: 'LAR',
  OAK: 'LV',
  SD: 'LAC',
  SL: 'LAR',
  STL: 'LAR',
  WSH: 'WAS',
});

/**
 * Player positions this app cannot project, with the reason a user is shown.
 * Mirrors UNSUPPORTED_SLOT_TOKENS but phrased about a PLAYER rather than a
 * slot: the app projects offence plus team defence, so an individual defender
 * on a Sleeper roster has nowhere to land.
 */
export const UNSUPPORTED_PLAYER_POSITIONS = Object.freeze({
  DL: 'an individual defensive lineman', LB: 'a linebacker', DB: 'a defensive back',
  DE: 'a defensive end', DT: 'a defensive tackle', CB: 'a cornerback', S: 'a safety',
  SS: 'a strong safety', FS: 'a free safety', EDR: 'an edge rusher',
  IDP: 'an individual defensive player', P: 'a punter', LS: 'a long snapper',
  OL: 'an offensive lineman', OT: 'an offensive tackle', OG: 'an offensive guard',
  G: 'a guard', T: 'a tackle', C: 'a center', NT: 'a nose tackle',
});

/**
 * Reasons a Sleeper id did not resolve. Every unresolved row carries one.
 *
 * `unsupported_position` and `position_not_projected` are different failures
 * and must stay different. The first is a player this app can never model (an
 * individual defender). The second is a position the caller's own player set
 * does not contain at all — data/player_projections.json is offence-only, so a
 * kicker crosswalked against it alone is missing a DATA SET, not a modelling
 * capability, and the fix is to pass the kicker rows in. Collapsing the two
 * would tell a user their kicker is unsupported when it is not.
 */
export const CROSSWALK_CODES = Object.freeze([
  'bad_id', 'empty_slot', 'no_player_index', 'unknown_sleeper_id',
  'unsupported_position', 'position_not_projected', 'no_app_match', 'ambiguous',
]);

/** Team abbreviation as app/teams.js spells it, or null. */
function canonicalTeam(value) {
  const raw = upper(value);
  if (!raw) return null;
  const aliased = Object.prototype.hasOwnProperty.call(SLEEPER_TEAM_ALIASES, raw)
    ? SLEEPER_TEAM_ALIASES[raw]
    : raw;
  return Object.prototype.hasOwnProperty.call(TEAMS, aliased) ? aliased : null;
}

/** DEF and DST are the same thing on both sides; everything else is itself. */
function canonicalPosition(value) {
  const pos = upper(value);
  return pos === 'DST' ? 'DEF' : pos;
}

/**
 * A name reduced to what two sources can be expected to agree on: lower case,
 * no accents, no punctuation, no generational suffix, single-spaced.
 *
 * Dropping the suffix is what makes "Odell Beckham Jr." meet "Odell Beckham" —
 * and it is also what could collide a father with a son. That is handled by
 * refusing any name key that hits more than one app row, so a collision costs
 * a report, never a wrong player.
 */
export function normalizePlayerName(name) {
  const text = String(name == null ? '' : name);
  const stripped = (typeof text.normalize === 'function' ? text.normalize('NFD') : text)
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!stripped) return '';
  const parts = stripped.split(' ').filter(Boolean);
  while (parts.length > 1 && /^(jr|sr|ii|iii|iv|v)$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  return parts.join(' ');
}

/**
 * Build a lookup from Sleeper's /v1/players/nfl dump (an object keyed by
 * player id). The dump is ~5MB, so this module never fetches it — the caller
 * hands over whatever it has (fetched, cached, or pasted) and gets back an
 * index plus a count of entries that were unusable.
 */
export function buildSleeperPlayerIndex(dump) {
  if (!isPlainObject(dump)) {
    return {
      ok: false,
      index: new Map(),
      count: 0,
      skipped: [],
      error: failure('not_a_player_dump',
        'That is not Sleeper\'s player dump. Expected the JSON object from '
        + `${SLEEPER_API_BASE}/players/nfl, keyed by player id.`,
        dump === null ? null : typeof dump),
    };
  }

  const index = new Map();
  const skipped = [];

  Object.keys(dump).forEach((key) => {
    const raw = dump[key];
    if (!isPlainObject(raw)) {
      skipped.push({ key, reason: 'Not a player object.' });
      return;
    }
    const id = String(raw.player_id == null ? key : raw.player_id);
    const first = typeof raw.first_name === 'string' ? raw.first_name : '';
    const last = typeof raw.last_name === 'string' ? raw.last_name : '';
    const full = typeof raw.full_name === 'string' && raw.full_name.trim()
      ? raw.full_name.trim()
      : `${first} ${last}`.trim();
    const espnId = toFinite(raw.espn_id);
    index.set(id, {
      sleeper_id: id,
      name: full || null,
      position: canonicalPosition(raw.position),
      team: canonicalTeam(raw.team),
      raw_team: raw.team == null ? null : String(raw.team),
      espn_id: espnId === null ? null : String(Math.trunc(espnId)),
      gsis_id: typeof raw.gsis_id === 'string' && raw.gsis_id.trim() ? raw.gsis_id.trim() : null,
      fantasy_positions: Array.isArray(raw.fantasy_positions)
        ? raw.fantasy_positions.map((p) => canonicalPosition(p))
        : [],
    });
  });

  return { ok: index.size > 0, index, count: index.size, skipped, error: null };
}

/** Accept an already-built index, a raw dump, or nothing at all. */
function toPlayerIndex(value) {
  if (value instanceof Map) return value;
  if (isPlainObject(value) && value.index instanceof Map) return value.index;
  if (isPlainObject(value)) return buildSleeperPlayerIndex(value).index;
  return new Map();
}

/** This app's id for a player row. Both field names are in use in data/. */
function appPlayerId(row) {
  if (!isPlainObject(row)) return null;
  const id = row.gsis_id != null ? row.gsis_id : (row.player_id != null ? row.player_id : row.id);
  return id == null || String(id).trim() === '' ? null : String(id).trim();
}

/** Index this app's player rows every way the crosswalk can look them up. */
function buildAppIndex(appPlayers) {
  const byId = new Map();
  const byNameTeamPos = new Map();
  const byNamePos = new Map();
  const defByTeam = new Map();
  // Which positions the caller's player set actually covers. A position that
  // is absent entirely is a different report from a player who is absent.
  const positions = new Set();

  (Array.isArray(appPlayers) ? appPlayers : []).forEach((row) => {
    const id = appPlayerId(row);
    if (!id) return;
    const position = canonicalPosition(row.position);
    const team = canonicalTeam(row.team);
    const name = normalizePlayerName(row.name);
    const entry = { player_id: id, name: row.name == null ? null : String(row.name), position, team };

    if (position) positions.add(position);
    if (!byId.has(id)) byId.set(id, entry);
    if (name) {
      const ntp = `${name}|${team || ''}|${position}`;
      const np = `${name}|${position}`;
      if (!byNameTeamPos.has(ntp)) byNameTeamPos.set(ntp, []);
      byNameTeamPos.get(ntp).push(entry);
      if (!byNamePos.has(np)) byNamePos.set(np, []);
      byNamePos.get(np).push(entry);
    }
    if (position === 'DEF' && team) {
      if (!defByTeam.has(team)) defByTeam.set(team, []);
      defByTeam.get(team).push(entry);
    }
  });

  return { byId, byNameTeamPos, byNamePos, defByTeam, positions };
}

function resolvedRow(sleeperId, entry, appEntry, method) {
  return {
    sleeper_id: sleeperId,
    player_id: appEntry.player_id,
    name: appEntry.name,
    position: appEntry.position,
    team: appEntry.team,
    method,
    sleeper_name: entry ? entry.name : null,
    sleeper_position: entry ? entry.position : null,
    sleeper_team: entry ? entry.team : null,
  };
}

function unresolvedRow(sleeperId, entry, code, message, candidates) {
  return {
    sleeper_id: sleeperId,
    code,
    message,
    sleeper_name: entry ? entry.name : null,
    sleeper_position: entry ? entry.position : null,
    sleeper_team: entry ? entry.team : null,
    candidates: candidates || [],
  };
}

/**
 * Crosswalk a list of Sleeper player ids onto this app's player ids.
 *
 * Returns resolved and unresolved SEPARATELY, both in input order, and the two
 * always account for every input id: `counts.input === resolved.length +
 * unresolved.length`. An unresolved player is a REPORT, not a hole — the UI is
 * expected to show it.
 *
 * appPlayers: rows carrying { gsis_id | player_id, name, team, position } —
 *   data/player_projections.json players, plus the kicker and defence rows out
 *   of data/kdst_projections.json.
 * opts.index: Sleeper's player dump, or the Map from buildSleeperPlayerIndex().
 *   Without it only team defences can resolve, and every other id comes back
 *   unresolved with `no_player_index` rather than a guess.
 */
export function crosswalkPlayerIds(sleeperIds, appPlayers, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const index = toPlayerIndex(options.index);
  const app = buildAppIndex(appPlayers);
  const ids = Array.isArray(sleeperIds) ? sleeperIds : [];
  const resolved = [];
  const unresolved = [];

  ids.forEach((raw) => {
    const sleeperId = typeof raw === 'string' ? raw.trim()
      : (typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '');
    if (!sleeperId) {
      unresolved.push(unresolvedRow(raw === undefined ? null : raw, null, 'bad_id',
        'This is not a Sleeper player id, so nothing was looked up.'));
      return;
    }
    if (sleeperId === SLEEPER_EMPTY_SLOT) {
      unresolved.push(unresolvedRow(sleeperId, null, 'empty_slot',
        'An empty starting slot — the manager started nobody here.'));
      return;
    }

    const entry = index.get(sleeperId) || null;

    // A team defence is self-identifying: Sleeper uses the team abbreviation
    // as the player id, and so does this app. It resolves with no dump at all.
    const idAsTeam = canonicalTeam(sleeperId);
    if (!entry && idAsTeam) {
      const defs = app.defByTeam.get(idAsTeam) || [];
      if (defs.length === 1) {
        resolved.push(resolvedRow(sleeperId, null, defs[0], 'team_def'));
        return;
      }
      if (defs.length > 1) {
        unresolved.push(unresolvedRow(sleeperId, null, 'ambiguous',
          `${defs.length} team defences in this app are listed for ${idAsTeam}.`,
          defs.map((d) => d.player_id)));
        return;
      }
      unresolved.push(unresolvedRow(sleeperId, null, 'no_app_match',
        `This app has no team defence for ${idAsTeam}.`));
      return;
    }

    if (!entry) {
      if (index.size === 0) {
        unresolved.push(unresolvedRow(sleeperId, null, 'no_player_index',
          'No Sleeper player list was supplied, so this id could not be looked up. '
          + `Load ${SLEEPER_API_BASE}/players/nfl and pass it as the index.`));
        return;
      }
      unresolved.push(unresolvedRow(sleeperId, null, 'unknown_sleeper_id',
        'Sleeper\'s player list has no player with this id — the list is probably '
        + 'older than the roster.'));
      return;
    }

    const positions = [entry.position, ...entry.fantasy_positions].filter(Boolean);
    const supported = positions.some((p) => POSITIONS.includes(p));
    if (!supported) {
      const known = positions.find((p) => UNSUPPORTED_PLAYER_POSITIONS[p]);
      unresolved.push(unresolvedRow(sleeperId, entry, 'unsupported_position',
        known
          ? `${entry.name || 'This player'} is ${UNSUPPORTED_PLAYER_POSITIONS[known]} — this app `
            + 'projects offence and team defence only, so there is nothing to match him to.'
          : `${entry.name || 'This player'} plays ${entry.position || 'an unknown position'}, `
            + 'which this app does not roster.'));
      return;
    }

    // 1. espn_id -> this app's "espn-<id>".
    if (entry.espn_id) {
      const hit = app.byId.get(`espn-${entry.espn_id}`);
      if (hit) { resolved.push(resolvedRow(sleeperId, entry, hit, 'espn_id')); return; }
    }
    // 2. gsis_id -> this app's kicker ids, which ARE gsis ids.
    if (entry.gsis_id) {
      const hit = app.byId.get(entry.gsis_id);
      if (hit) { resolved.push(resolvedRow(sleeperId, entry, hit, 'gsis_id')); return; }
    }
    // 3. team defence carried in the dump rather than as a bare abbreviation.
    if (entry.position === 'DEF' && entry.team) {
      const defs = app.defByTeam.get(entry.team) || [];
      if (defs.length === 1) {
        resolved.push(resolvedRow(sleeperId, entry, defs[0], 'team_def'));
        return;
      }
      if (defs.length > 1) {
        unresolved.push(unresolvedRow(sleeperId, entry, 'ambiguous',
          `${defs.length} team defences in this app are listed for ${entry.team}.`,
          defs.map((d) => d.player_id)));
        return;
      }
    }

    const name = normalizePlayerName(entry.name);
    if (name) {
      // 4. name + team + position, when it is unique.
      const ntp = app.byNameTeamPos.get(`${name}|${entry.team || ''}|${entry.position}`) || [];
      if (ntp.length === 1) {
        resolved.push(resolvedRow(sleeperId, entry, ntp[0], 'name_team_position'));
        return;
      }
      if (ntp.length > 1) {
        unresolved.push(unresolvedRow(sleeperId, entry, 'ambiguous',
          `${ntp.length} players in this app are called ${entry.name} at `
          + `${entry.position} for ${entry.team}. Nothing was matched.`,
          ntp.map((c) => c.player_id)));
        return;
      }
      // 5. name + position across every team — a player who changed team since
      //    one of the two sources was built. Only when it is unique.
      const np = app.byNamePos.get(`${name}|${entry.position}`) || [];
      if (np.length === 1) {
        resolved.push(resolvedRow(sleeperId, entry, np[0], 'name_position'));
        return;
      }
      if (np.length > 1) {
        unresolved.push(unresolvedRow(sleeperId, entry, 'ambiguous',
          `${np.length} players in this app are called ${entry.name} at ${entry.position}. `
          + 'Nothing was matched.', np.map((c) => c.player_id)));
        return;
      }
    }

    if (entry.position && !app.positions.has(entry.position)) {
      // The player set handed in covers no one at this position at all — the
      // honest report is "this pool has no K", not "this player is missing".
      unresolved.push(unresolvedRow(sleeperId, entry, 'position_not_projected',
        `${entry.name || sleeperId} is not in this app's player set: ${entry.position} is not a `
        + 'position this app projects from the player set supplied, so no projection can be '
        + 'shown for him.'));
      return;
    }
    unresolved.push(unresolvedRow(sleeperId, entry, 'no_app_match',
      `${entry.name || sleeperId} is on this roster but not in this app's player set, `
      + 'so no projection can be shown for him.'));
  });

  const byMethod = {};
  resolved.forEach((r) => { byMethod[r.method] = (byMethod[r.method] || 0) + 1; });
  const byCode = {};
  unresolved.forEach((u) => { byCode[u.code] = (byCode[u.code] || 0) + 1; });

  return {
    resolved,
    unresolved,
    counts: {
      input: ids.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      by_method: byMethod,
      by_code: byCode,
    },
  };
}

/**
 * Crosswalk one joined team. `starters` is slot-ordered (so the UI can line it
 * up with the league's roster_positions) and `players` is the whole roster.
 * `unresolved` is the union of both, de-duplicated by Sleeper id, so a screen
 * can show one honest "we could not match these" list.
 */
export function crosswalkRoster(team, appPlayers, opts) {
  const t = isPlainObject(team) ? team : {};
  const starters = crosswalkPlayerIds(t.starters, appPlayers, opts);
  const players = crosswalkPlayerIds(t.players, appPlayers, opts);
  const reserve = crosswalkPlayerIds(t.reserve, appPlayers, opts);

  const seen = new Set();
  const unresolved = [];
  [...starters.unresolved, ...players.unresolved, ...reserve.unresolved].forEach((u) => {
    const key = `${u.code}|${String(u.sleeper_id)}`;
    if (seen.has(key)) return;
    seen.add(key);
    unresolved.push(u);
  });

  return {
    roster_id: t.roster_id === undefined ? null : t.roster_id,
    label: typeof t.label === 'string' ? t.label : null,
    starters,
    players,
    reserve,
    unresolved,
    fully_resolved: unresolved.length === 0,
  };
}

/* --------------------------------------------------------------------------
 * Rosters + users, as one manual sync
 * ------------------------------------------------------------------------ */

/**
 * MANUAL SYNC: read every roster and every manager and join them. Two GETs per
 * press, no timer, nothing cached. Returns the joined teams plus the raw
 * payloads so a caller can crosswalk without re-reading.
 */
const EMPTY_TEAM_IMPORT = Object.freeze({
  ok: false, teams: [], rosters: [], users: [], orphan_rosters: [], users_without_roster: [],
});

export async function importSleeperTeams(idOrUrl, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const rostersRes = await fetchSleeperRosters(idOrUrl, options);
  if (!rostersRes.ok) {
    return { ...EMPTY_TEAM_IMPORT, error: rostersRes.error };
  }
  const rosters = mapRosters(rostersRes.payload);
  if (!rosters.ok) {
    return { ...EMPTY_TEAM_IMPORT, error: rosters.error };
  }

  // A failed user read is NOT a failed import: rosters alone are usable, the
  // teams just have no names. That is said out loud rather than papered over.
  const usersRes = await fetchSleeperUsers(idOrUrl, options);
  const users = usersRes.ok
    ? mapLeagueUsers(usersRes.payload)
    : { ok: false, users: [], invalid: [], error: usersRes.error };
  const joined = joinRosters(rosters.rosters, users.users);

  return {
    ok: true,
    teams: joined.teams,
    rosters: rosters.rosters,
    users: users.users,
    orphan_rosters: joined.orphan_rosters,
    users_without_roster: joined.users_without_roster,
    invalid: { rosters: rosters.invalid, users: users.invalid },
    users_error: users.error,
    error: null,
  };
}
