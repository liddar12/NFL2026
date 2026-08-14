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
 * GET one league from Sleeper. Returns { ok, payload, status, error } and never
 * throws — a rejected fetch, a timeout and a 500 all come back as data.
 *
 * opts: { fetch, timeoutMs, signal, AbortController } — all injectable so the
 * unit tests never touch the network.
 */
export async function fetchSleeperLeague(idOrUrl, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const leagueId = parseLeagueId(idOrUrl);
  if (!leagueId) {
    return {
      ok: false,
      payload: null,
      status: 0,
      url: null,
      error: failure('bad_league_id',
        'That is not a Sleeper league id. Paste the number from your league URL, '
        + 'e.g. https://sleeper.com/leagues/1051234567890123456/team.', idOrUrl),
    };
  }

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
      url: leagueEndpoint(leagueId),
      error: failure('no_fetch',
        'This browser has no fetch, so the direct import cannot run. '
        + 'Use "Paste league JSON" instead.', null),
    };
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : SLEEPER_TIMEOUT_MS;
  const Ctor = typeof options.AbortController === 'function'
    ? options.AbortController
    : (typeof AbortController === 'function' ? AbortController : null);

  const url = leagueEndpoint(leagueId);
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
          `Sleeper has no league ${leagueId}. Check the id in your league URL.`, leagueId),
      };
    }
    if (res.status === 429) {
      return {
        ok: false, payload: null, status: 429, url,
        error: failure('rate_limited',
          'Sleeper is rate-limiting this device. Wait a minute and press sync again, '
          + 'or paste the league JSON.', null),
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false, payload: null, status: res.status, url,
        error: failure('http_error',
          `Sleeper answered HTTP ${res.status}. Try again, or paste the league JSON.`,
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
      // Sleeper answers 200 with a literal `null` body for an unknown league.
      return {
        ok: false, payload: null, status: res.status, url,
        error: failure('not_found',
          `Sleeper has no league ${leagueId}. Check the id in your league URL.`, leagueId),
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
          + 'Try again, or paste the league JSON.', timeoutMs),
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
        + 'blocking the request — paste the league JSON instead.',
        String(err && err.message ? err.message : err)),
    };
  } finally {
    cleanup();
  }
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
