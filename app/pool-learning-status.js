/* The correction actually recorded in a MY pool, not the newest proposal.
 * This is a saved-generation consistency/display check, NOT owner authentication,
 * a receipt-hash verifier, a publication gate or a current pipeline-health check.
 * Unknown legacy metadata remains unknown. A known expired/invalid period return
 * withholds only MY yardage props; it never silently re-prices them to a baseline.
 */
const HASH = /^sha256:[0-9a-f]{64}$/;
const MARKETS = new Set(['qb_pass_yds', 'rb_rush_yds', 'wr_rec_yds']);
const BASIS = 'retrospective_refitting_policy_not_fixed_artifact_prospective_validation';
export const PERIOD_SOURCE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CONTEXT_KEYS = ['version', 'scope_id', 'candidate_id', 'artifact_id',
  'owner_head_event_id', 'application_context_id', 'expires_utc', 'evidence_basis'];
const own = (v, k) => v != null && Object.hasOwn(v, k);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const digest = (v) => typeof v === 'string' && HASH.test(v);
const instant = (v) => typeof v === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(v)
  && Number.isFinite(Date.parse(v)) ? Date.parse(v) : NaN;
const sameLayer = (a, b) => a === null && b === null || object(a) && object(b)
  && Object.keys(a).length === 2 && Object.keys(b).length === 2
  && finite(a.a) && finite(a.b) && a.b > 0 && a.a === b.a && a.b === b.b;
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const isMyYardageProp = (leg) => MARKETS.has(leg?.market);

function sameReceipt(pool, player, rung) {
  const r = rung?.learning_receipt;
  if (!object(r) || r.version !== 1 || !digest(r.receipt_id)
    || !digest(r.base_model_version) || !digest(r.calibrator_version)
    || r.base_model_version !== pool.base_model_version
    || r.forecast_created_utc !== pool.generated_utc
    || r.season !== pool.season || r.week !== pool.week
    || r.player_id !== player.gsis_id || r.game_id !== player.game_id
    || r.market !== player.market || r.side !== player.side || r.line !== rung.line
    || r.direction !== 'over' || r.comparison_operator !== 'gte'
    || !sameLayer(r.calibrator, pool.live_adjustment)
    || !finite(r.base_prob) || r.base_prob <= 0 || r.base_prob >= 1
    || !finite(r.served_prob) || r.served_prob !== rung.model_prob) return false;
  const logit = Math.log(r.base_prob / (1 - r.base_prob));
  const corrected = r.calibrator === null ? r.base_prob
    : 1 / (1 + Math.exp(-(r.calibrator.a + r.calibrator.b * logit)));
  // Python rounds the once-served result to four places; don't require JS's
  // different half-way rounding rule to manufacture a disagreement at a tie.
  return Math.abs(r.served_prob - Math.min(.95, Math.max(.05, corrected))) <= .000050000001;
}

function savedLearningStatus(pool, now) {
  const result = { state: 'unknown', label: 'Learning version unavailable',
    note: 'This saved pool has no complete model-receipt metadata. Learning adoption and freshness are unknown.',
    blockProps: false, generatedUtc: null, expiresUtc: null, nextCheckMs: null,
    baseVersion: null, calibratorVersion: null, artifactId: null, ownerEventId: null,
    applicationContextId: null, action: null };
  if (!object(pool)) return result;
  const generated = instant(pool.generated_utc);
  if (Number.isFinite(generated)) result.generatedUtc = pool.generated_utc;
  const rows = Array.isArray(pool.players) ? pool.players : [];
  const entries = rows.filter(isMyYardageProp).flatMap((p) =>
    (Array.isArray(p.rungs) ? p.rungs : []).map((r) => [p, r]));
  const meta = pool.calibration_return;
  const period = own(pool, 'calibration_return') || entries.some(([, r]) =>
    own(r?.learning_receipt?.input_context, 'calibration_return'))
    || /^period return v2:/.test(String(pool.live_adjustment_status || ''));
  const hold = (state, label, note) => Object.assign(result, { state, label, note, blockProps: period });
  if (!finite(now) || !Number.isFinite(generated) || generated > now) {
    return hold('unavailable', 'Pool clock unavailable',
      'The saved pool clock is missing, invalid or ahead of this device. Refresh and check the device clock.');
  }
  if (!entries.length || !entries.every(([p, r]) => sameReceipt(pool, p, r))) {
    return period ? hold('held', 'MY prop correction withheld',
      'The saved period-return metadata does not match every MY yardage rung. Refresh the pool; no baseline price is substituted.') : result;
  }
  const versions = new Set(entries.map(([, r]) => r.learning_receipt.calibrator_version));
  if (versions.size !== 1) return hold('held', 'Learning versions disagree',
    'The saved MY yardage receipts disagree about the correction. Refresh the pool.');
  result.baseVersion = pool.base_model_version;
  result.calibratorVersion = versions.values().next().value;
  if (!period) return Object.assign(result, { state: pool.live_adjustment === null ? 'base_only' : 'saved_correction',
    label: pool.live_adjustment === null ? 'Base model in saved pool' : 'Receipt correction in saved pool',
    note: 'Versions below describe the displayed MY yardage prices, not the newest proposal. Current pipeline health and future accuracy are not established.' });
  if (!object(meta) || Object.keys(meta).length !== CONTEXT_KEYS.length + 1
    || !CONTEXT_KEYS.every((k) => own(meta, k)) || !own(meta, 'action')
    || meta.version !== 2 || !['approve', 'rollback', 'revoke'].includes(meta.action)
    || !['scope_id', 'candidate_id', 'owner_head_event_id', 'application_context_id'].every((k) => digest(meta[k]))
    || meta.evidence_basis !== BASIS
    || !entries.every(([, rung]) => {
      const context = rung.learning_receipt.input_context?.calibration_return;
      return object(context) && Object.keys(context).length === CONTEXT_KEYS.length
        && CONTEXT_KEYS.every((k) => own(context, k) && context[k] === meta[k]);
    })) return hold('held', 'MY prop correction withheld',
    'The saved approval/application metadata is incomplete or inconsistent. Refresh the pool.');
  const expiry = instant(meta.expires_utc);
  if (meta.action === 'revoke' ? meta.artifact_id !== null || meta.expires_utc !== null
    : !digest(meta.artifact_id) || !Number.isFinite(expiry) || expiry <= generated) {
    return hold('held', 'MY prop correction withheld', 'The saved correction has an invalid approval expiry or artifact. Refresh the pool.');
  }
  Object.assign(result, { action: meta.action, artifactId: meta.artifact_id,
    expiresUtc: meta.expires_utc, ownerEventId: meta.owner_head_event_id,
    applicationContextId: meta.application_context_id });
  if (meta.action !== 'revoke' && now >= expiry) return hold('expired', 'Approval expired — MY props withheld',
    'These yardage prices used an approval that has expired. Refresh for a newly checked generation; no client-side re-pricing is performed.');
  let earliest = Infinity;
  for (const [, rung] of entries) {
    for (const name of ['player_weekly', 'player_projections', 'game_predictions', 'return_schedule']) {
      const source = instant(rung.learning_receipt.source_timestamps?.[name]);
      if (!Number.isFinite(source) || source > generated) return hold('held', 'Source freshness unknown — MY props withheld',
        'The saved period-return receipts lack consistent input clocks. Refresh the pool.');
      earliest = Math.min(earliest, source);
    }
  }
  const staleAt = earliest + PERIOD_SOURCE_MAX_AGE_MS;
  result.nextCheckMs = Math.min(staleAt + 1, meta.action === 'revoke' ? Infinity : expiry);
  if (now > staleAt) return hold('stale', 'Saved inputs stale — MY props withheld',
    'An input is older than the 12-hour period-return limit. Refresh for fresh inputs; this does not establish injury-feed completeness.');
  return Object.assign(result, { state: meta.action === 'revoke' ? 'revoked' : 'saved_period_return',
    label: meta.action === 'revoke' ? 'Period return stopped in saved pool'
      : meta.action === 'rollback' ? 'Rolled-back correction in saved pool' : 'Owner-selected correction in saved pool',
    note: 'Saved-generation state only: current owner authority and live pipeline health are not checked by this file. Retrospective evidence is not prospective proof of improved accuracy.' });
}

const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every((key) => own(value, key));
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;

/* A separately selected generation policy, never a proposed/shadow assessment.
 * These are saved consistency checks, not client authentication. The publisher
 * must rederive this contract. No posted/complete flag can extend a saved pool.
 */
function selectedFreshness(pool, now) {
  const result = { freshnessLabel: null, freshnessNote: null, freshnessSelected: false,
    blockedGameIds: [], blockedPlayerIds: [], hasHeldProps: false, freshnessNextCheckMs: null };
  if (!own(pool, 'freshness_policy')) return result;
  result.freshnessSelected = true;
  const meta = pool.freshness_policy;
  const invalid = () => ({ ...result, freshnessInvalid: true, hasHeldProps: true,
    freshnessLabel: 'MY source policy unavailable — yardage props withheld',
    freshnessNote: 'The selected saved-generation freshness policy is missing or inconsistent. Refresh the pool; moneylines and anytime-TD remain separate.' });
  if (!finite(now) || !exactKeys(meta, ['version', 'profile', 'policy_id', 'generated_utc', 'games'])
    || meta.version !== 1 || meta.profile !== 'provisional_before_90m_v1' || !digest(meta.policy_id)
    || meta.generated_utc !== pool.generated_utc || !Number.isFinite(instant(meta.generated_utc))
    || instant(meta.generated_utc) > now || !Array.isArray(meta.games) || meta.games.length > 64) return invalid();
  const games = new Map();
  const blockedGames = new Set(), blockedPlayers = new Set(), deadlines = [];
  let provisional = 0;
  for (const game of meta.games) {
    if (!exactKeys(game, ['game_id', 'check_due_utc', 'source_expires_utc', 'state', 'blocked_player_ids', 'player_source_expires'])
      || !identity(game.game_id) || games.has(game.game_id)
      || !['provisional', 'held'].includes(game.state)
      || !Number.isFinite(instant(game.check_due_utc)) || !Number.isFinite(instant(game.source_expires_utc))
      || !Array.isArray(game.blocked_player_ids) || game.blocked_player_ids.length > 2000
      || !game.blocked_player_ids.every(identity)
      || new Set(game.blocked_player_ids).size !== game.blocked_player_ids.length
      || !object(game.player_source_expires) || Object.keys(game.player_source_expires).length > 2000
      || !Object.entries(game.player_source_expires).every(([pid, clock]) => identity(pid)
        && Number.isFinite(instant(clock)))) return invalid();
    games.set(game.game_id, game);
    game.blocked_player_ids.forEach((pid) => blockedPlayers.add(pid));
    const cutoff = Math.min(instant(game.check_due_utc), instant(game.source_expires_utc));
    if (game.state === 'held' || now >= cutoff) blockedGames.add(game.game_id);
    else {
      provisional += 1; deadlines.push(cutoff);
      for (const [pid, clock] of Object.entries(game.player_source_expires)) {
        const expiry = instant(clock);
        if (now >= expiry) blockedPlayers.add(pid);
        else deadlines.push(expiry);
      }
    }
  }
  const rows = Array.isArray(pool.players) ? pool.players.filter(isMyYardageProp) : [];
  if (!rows.every((player) => identity(player.game_id) && games.has(player.game_id))) return invalid();
  Object.assign(result, { blockedGameIds: [...blockedGames], blockedPlayerIds: [...blockedPlayers],
    hasHeldProps: blockedGames.size > 0 || blockedPlayers.size > 0,
    freshnessNextCheckMs: deadlines.length ? Math.min(...deadlines) : null,
    freshnessLabel: provisional ? 'Provisional MY props — inactive recheck required'
      : 'MY props withheld pending inactive recheck',
    freshnessNote: 'MY yardage props are provisional, not confirmed active. They are automatically withheld 90 minutes before kickoff or earlier if a source expires; a newly checked pool is required. '
      + (blockedGames.size ? `${blockedGames.size} game(s) currently withheld. ` : '')
      + (blockedPlayers.size ? `${blockedPlayers.size} player(s) withheld by source checks. ` : '')
      + 'Later eligible games, moneylines and anytime-TD are not globally disabled.' });
  return result;
}

export function poolLearningStatus(pool, now = Date.now()) {
  const status = Object.assign(savedLearningStatus(pool, now), selectedFreshness(pool, now));
  if (status.freshnessInvalid) status.blockProps = true;
  const deadlines = [status.nextCheckMs, status.freshnessNextCheckMs].filter(Number.isFinite);
  status.nextCheckMs = deadlines.length ? Math.min(...deadlines) : null;
  return status;
}

export function learningEligibleLegs(legs, status) {
  if (!status.blockProps && !status.blockedGameIds?.length && !status.blockedPlayerIds?.length) return legs || [];
  const games = new Set(status.blockedGameIds || []), players = new Set(status.blockedPlayerIds || []);
  return (legs || []).filter((leg) => !isMyYardageProp(leg) || !status.blockProps
    && !games.has(String(leg.game_id)) && !players.has(leg.gsis_id || leg.owner));
}

export function learningCardRefusal(pool, legs, now = Date.now()) {
  const status = poolLearningStatus(pool, now);
  return learningEligibleLegs(legs, status).length === (legs || []).length ? null
    : `${status.freshnessLabel || status.label}. Refresh for a newly checked card before recording it as a recommendation.`;
}

export function renderPoolLearning(status) {
  const rows = [['Pool generated (UTC)', status.generatedUtc], ['Approval expires (UTC)', status.expiresUtc],
    ['Base model', status.baseVersion], ['Applied calibration', status.calibratorVersion],
    ['Applied artifact', status.artifactId], ['Owner event at generation', status.ownerEventId],
    ['Application context', status.applicationContextId]].filter(([, value]) => value !== null);
  return `<section class="mp-learning${status.blockProps || status.hasHeldProps ? ' mp-learning--held' : ''}" role="status" aria-label="MY learning status">`
    + `<strong>${esc(status.label)}</strong><p>${esc(status.note)}</p>`
    + (status.freshnessLabel ? `<strong>${esc(status.freshnessLabel)}</strong><p>${esc(status.freshnessNote)}</p>` : '')
    + '<p>MY yardage props only. Game, Week, moneyline and anytime-TD models are separate.</p>'
    + (rows.length ? '<details><summary>Saved model versions and clocks</summary><dl>'
      + rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')
      + '</dl><p>As-recorded metadata; this display does not authenticate receipt hashes, an owner or publication.</p></details>' : '')
    + '</section>';
}
