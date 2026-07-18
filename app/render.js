/* app/render.js — PURE render helpers for the Broadcast Gameday UI.
 *
 * Every function here is side-effect free: it takes already-fetched contract
 * data and returns an HTML string (or a small formatted value). NO fetching,
 * NO DOM mutation, NO globals — the views own that. Keeping render pure means
 * the same helpers are trivially unit-testable and the markup lives in exactly
 * one place, matching the shared component contract byte-for-byte so the CSS
 * (which styles these classes) and the tests (which select them) all agree.
 *
 * Markup INVARIANTS (do not drift — CSS + Playwright depend on them):
 *   .card.game / .card.player / .card.parlay, .track/.seg, .interval/.iv-pt,
 *   .sig--none day-zero chip, .est/.estimate honesty pills.
 *
 * HONESTY INVARIANTS:
 *   - Game "ESTIMATE" pill shows only when estimate===true.
 *   - Player day-zero shows the "No signals weighted yet · day zero" chip
 *     because meta weights are all 0.0 (nothing has earned weight yet).
 *
 * Dependency-free: platform Intl + string building only.
 */

import { TEAMS } from './teams.js';

/* --------------------------------------------------------------------------
 * Small utilities
 * ------------------------------------------------------------------------ */

/** HTML-escape untrusted-ish text before interpolating into a template. */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One-decimal fixed number (projection points, interval ends). */
const fix1 = (n) => Number(n).toFixed(1);

/** Clamp a number into [lo, hi]. */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* --------------------------------------------------------------------------
 * Team helpers (exported — used by views + tests)
 * ------------------------------------------------------------------------ */

/** Nickname for an abbrev ("KC" -> "Chiefs"); falls back to the abbrev. */
export function teamName(ab) {
  return (TEAMS[ab] && TEAMS[ab].name) || ab;
}

/** AA-safe identity tint for an abbrev; falls back to --ink (always passes). */
export function teamTint(ab) {
  return (TEAMS[ab] && TEAMS[ab].tint) || 'var(--ink)';
}

/* --------------------------------------------------------------------------
 * Formatters (exported — pure)
 * ------------------------------------------------------------------------ */

/**
 * Format a kickoff UTC ISO string to broadcast form: "THU · 8:20 PM ET".
 * Always rendered in America/New_York (league clock) via Intl so it is stable
 * regardless of the viewer's device timezone.
 */
export function formatKickoff(utc) {
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return '';
  const tz = 'America/New_York';
  const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz })
    .format(d)
    .toUpperCase();
  const t = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  }).format(d);
  return `${wd} · ${t} ET`;
}

/**
 * Turn a parlay leg's (market, selection) into a readable leg name.
 *   moneyline        -> "<sel> ML"
 *   spread / total   -> "<sel>"           (selection already carries the line)
 *   anytime_td       -> "<player> anytime TD"
 *   player_receptions-> "<sel>"
 * Anything else falls back to the raw selection.
 */
export function formatLeg(market, selection) {
  const sel = String(selection == null ? '' : selection);
  // Abbreviate a leading "First Last" to "F. Last" so long player-prop names fit
  // one card row instead of truncating with an ellipsis.
  const abbrevPlayer = (s) => String(s).replace(/^([A-Z])[a-z]+\s+([A-Z][a-z'.-]+)/, '$1. $2');
  switch (market) {
    case 'moneyline':
      return `${sel} ML`;
    case 'anytime_td': {
      // Data carries e.g. "Patrick Mahomes TD"; strip trailing " TD" so we can
      // append the canonical "anytime TD" phrasing without duplicating it.
      const player = sel.replace(/\s+TD$/i, '');
      return `${abbrevPlayer(player)} anytime TD`;
    }
    case 'player_receptions':
      return abbrevPlayer(sel);
    case 'spread':
    case 'total':
    default:
      return sel;
  }
}

/**
 * Model edge in whole percentage points: round((model - implied) * 100).
 * Positive = model likes it more than the market implies.
 */
export function edgePct(modelProb, impliedProb) {
  return Math.round((Number(modelProb) - Number(impliedProb)) * 100);
}

/** Signed integer with a unicode minus for negatives ("+3" / "−2"). */
function signedInt(n) {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/** Signed one-decimal percent ("+4.1%" / "−2.0%"). */
function signedPct1(n) {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
}

/* --------------------------------------------------------------------------
 * Health chip
 * ------------------------------------------------------------------------ */

const HEALTH_MODS = new Set(['ok', 'stale', 'degraded', 'down']);

/** Normalize a pipeline health value to a known modifier (default degraded). */
export function healthMod(health) {
  const h = String(health || '').toLowerCase();
  return HEALTH_MODS.has(h) ? h : 'degraded';
}

/**
 * Inner HTML for the #health chip from getPipelineStatus() output
 * ({ health, feeds }). Dot modifier carries the state color; note counts the
 * non-ok feeds (honest degraded/stale reporting). The container's stripe
 * modifier class is set by main.js via healthMod().
 */
export function renderHealth(status) {
  const mod = healthMod(status && status.health);
  const feeds = (status && status.feeds) || {};
  const all = Object.values(feeds).filter((f) => f && f.status);
  // 'unconfigured' = a feed the owner has not turned on (needs a key /
  // integration) — a fact, not a failure. It never colors health (the pipeline
  // excludes it from the roll-up) and is reported as "awaiting config", so
  // DEGRADED is reserved for feeds that WERE working and broke.
  const unconfigured = all.filter((f) => f.status === 'unconfigured').length;
  const bad = all.filter((f) => f.status !== 'ok' && f.status !== 'unconfigured').length;
  const label = `DATA · ${mod.toUpperCase()}`;
  const parts = [];
  if (bad > 0) parts.push(`${bad} ${bad === 1 ? 'feed' : 'feeds'} stale / degraded`);
  if (unconfigured > 0) parts.push(`${unconfigured} awaiting config`);
  const note = parts.length ? parts.join(' · ') : 'all feeds ok';
  return (
    `<span class="health-dot health-dot--${mod}"></span>` +
    `<span class="health-label">${esc(label)}</span>` +
    `<span class="health-note">${esc(note)}</span>`
  );
}

/**
 * Compact market-comparison strip for a game card — DISPLAY ONLY (user
 * policy: market prices are never a model input; the badge + title say so on
 * every render). `game` is a game_predictions[] entry (probs.home is OURS);
 * `markets` is data/market_prices.json games[game_id] ({kalshi?, polymarket?}).
 * Returns '' when no market has a price for this game — cards unchanged.
 */
export function renderMarketStrip(game, markets) {
  if (!markets || typeof markets !== 'object') return '';
  const ours = game && game.probs ? Number(game.probs.home) : NaN;
  const rows = [];
  if (Number.isFinite(ours)) {
    rows.push(`<span class="ms-src ms-src--us">MODEL <b class="ms-val">${(ours * 100).toFixed(1)}%</b></span>`);
  }
  const src = (key, label) => {
    const m = markets[key];
    if (!m || !Number.isFinite(Number(m.home_prob))) return;
    rows.push(`<span class="ms-src">${label} <b class="ms-val">${(Number(m.home_prob) * 100).toFixed(1)}%</b></span>`);
  };
  src('kalshi', 'KALSHI');
  src('polymarket', 'POLYMKT');
  if (rows.length < 2) return ''; // nothing to compare against — no strip
  return (
    '<div class="mstrip" ' +
      'title="Market prices are shown for comparison only — never used in predictions">' +
      `<span class="ms-lbl">${esc(teamName(game.home))} WIN</span>` +
      rows.join('') +
      '<span class="ms-badge">MARKET · DISPLAY ONLY</span>' +
    '</div>'
  );
}

/* --------------------------------------------------------------------------
 * Game card (slate)
 * ------------------------------------------------------------------------ */

/** One .card.game article from a game_predictions[] entry. */
export function renderGameCard(game) {
  const home = game.home;
  const away = game.away;
  const homePct = Math.round((game.probs && game.probs.home) * 100);
  const awayPct = Math.round((game.probs && game.probs.away) * 100);

  // Venue = home stadium + roof; roof-only if we don't know the stadium.
  const roof = String(game.roof || '').toUpperCase();
  const stadium = TEAMS[home] && TEAMS[home].stadium;
  const venue = stadium ? `${stadium.toUpperCase()} · ${roof}` : roof;

  // Human label, never internal snake_case ("ELO_PRIOR" -> "ELO PRIOR").
  const model = String(game.model || '').replace(/_/g, ' ').toUpperCase();
  const est = game.estimate === true
    ? '<span class="est">ESTIMATE</span>'
    : '';

  const trackLabel = `Model win probability: ${home} ${homePct}%, ${away} ${awayPct}%`;

  return (
    `<article class="card game" data-game-id="${esc(game.game_id)}">` +
      '<div class="game-meta">' +
        `<span class="g-time">${esc(formatKickoff(game.kickoff_utc))}</span>` +
        `<span class="g-venue">${esc(venue)}</span>` +
      '</div>' +
      '<div class="game-teams">' +
        `<div class="team team--away" data-team="${esc(away)}">` +
          `<span class="team-ab" style="color:${teamTint(away)}">${esc(away)}</span>` +
          `<span class="team-nm">${esc(teamName(away))}</span>` +
        '</div>' +
        '<span class="at" aria-hidden="true">@</span>' +
        `<div class="team team--home" data-team="${esc(home)}">` +
          `<span class="team-ab" style="color:${teamTint(home)}">${esc(home)}</span>` +
          `<span class="team-nm">${esc(teamName(home))}</span>` +
        '</div>' +
      '</div>' +
      '<div class="prob">' +
        '<div class="prob-heads">' +
          `<span class="ph ph--away${awayPct > homePct ? ' ph--fav' : ''}">${esc(away)} ${awayPct}%</span>` +
          `<span class="ph ph--home${homePct >= awayPct ? ' ph--fav' : ''}">${esc(home)} ${homePct}%</span>` +
        '</div>' +
        `<div class="track" role="img" aria-label="${esc(trackLabel)}">` +
          `<div class="seg seg--away" style="width:${awayPct}%"></div>` +
          `<div class="seg seg--home" style="width:${homePct}%"></div>` +
        '</div>' +
        '<div class="prob-sub">' +
          `<span>MODEL · ${esc(model)}</span>` +
          est +
        '</div>' +
      '</div>' +
    '</article>'
  );
}

/* --------------------------------------------------------------------------
 * Player card
 * ------------------------------------------------------------------------ */

/** Render the signals row: day-zero honest chip, or one .sig per signal. */
function renderSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) {
    // Day zero: meta weights are all 0.0, so nothing is weighted. Say so.
    return '<span class="sig sig--none">No signals weighted yet · day zero</span>';
  }
  // Future-proofing: if a signal ever appears, carry sign by glyph (never color
  // alone). Accept string signals or objects with a direction/effect field.
  return signals
    .map((s) => {
      let label = '';
      let dir = 'neutral';
      if (typeof s === 'string') {
        label = s;
      } else if (s && typeof s === 'object') {
        label = s.label || s.name || s.signal || '';
        const raw = s.direction || s.effect || s.sign || '';
        if (/pos|up|\+/i.test(String(raw))) dir = 'pos';
        else if (/neg|down|-/i.test(String(raw))) dir = 'neg';
      }
      const glyph = dir === 'pos' ? '▲' : dir === 'neg' ? '▼' : '●';
      return (
        `<span class="sig sig--${dir}">` +
          `<span class="sig-mark" aria-hidden="true">${glyph}</span>${esc(label)}` +
        '</span>'
      );
    })
    .join('');
}

/**
 * One .card.player article from a player_projections[] entry.
 *
 * `opts.weekly === true` appends the .p-expand WEEKS toggle (collapsed; the
 * view lazily injects the .wkstrip on first expand). Guarded so a bare
 * `players.map(renderPlayerCard)` (opts = array index) still renders the
 * legacy card unchanged — existing callers/tests keep working.
 */
export function renderPlayerCard(player, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const low = Number(player.low);
  const high = Number(player.high);
  const proj = Number(player.proj_points);

  // Point marker position inside the conformal band, clamped to the track.
  const span = high - low;
  const pctLeft = span > 0 ? clamp(((proj - low) / span) * 100, 0, 100) : 50;

  const expand = o.weekly === true
    ? '<button type="button" class="p-expand" aria-expanded="false">WEEKS</button>'
    : '';

  // REL2 adornments (all optional — a card rendered without them is unchanged):
  //   o.trend  { dir, slope_pts_per_yr, seasons, source }  (team-logic trendLabel)
  //   o.sos    number 1.0..5.0 (strengthOfSchedule; 1 easiest, 5 hardest)
  const trend = renderTrendChip(o.trend);
  const sos = renderSos(o.sos);
  const adorn = (trend || sos) ? `<div class="p-adorn">${trend}${sos}</div>` : '';

  return (
    `<article class="card player" data-gsis="${esc(player.gsis_id)}">` +
      '<div class="p-top">' +
        '<div class="p-id">' +
          `<div class="p-pos">${esc(player.position)} · ${esc(player.team)}</div>` +
          `<div class="p-name">${esc(player.name)}</div>` +
        '</div>' +
        '<div class="p-proj">' +
          `<div class="p-num">${esc(fix1(proj))}</div>` +
          `<div class="p-unit">${o.aiDelta != null ? 'AI PROJ PTS' : 'PROJ PTS'}</div>` +
          (o.aiDelta != null && Number.isFinite(Number(o.aiDelta))
            ? `<div class="p-aidelta p-aidelta--${Number(o.aiDelta) >= 0 ? 'up' : 'down'}">` +
                `${Number(o.aiDelta) >= 0 ? '+' : ''}${esc(fix1(Number(o.aiDelta)))} AI</div>`
            : '') +
        '</div>' +
      '</div>' +
      adorn +
      '<div class="interval">' +
        '<div class="lbl">80% conformal range</div>' +
        '<div class="iv-scale">' +
          '<div class="iv-band"></div>' +
          `<div class="iv-pt" style="left:${pctLeft.toFixed(1)}%"></div>` +
        '</div>' +
        '<div class="iv-ends">' +
          `<span>${esc(fix1(low))}</span><span>${esc(fix1(high))}</span>` +
        '</div>' +
      '</div>' +
      `<div class="sigs">${renderSignals(player.signals_used)}</div>` +
      '<div class="estimate">' +
        '<span class="em">ESTIMATE</span> preseason — not yet measured' +
      '</div>' +
      expand +
    '</article>'
  );
}

/**
 * AI trend chip from team-logic trendLabel() output. Up/down/flat with the real
 * pts/yr when the trend is MEASURED (>=3 seasons of OLS); an "AI EST" chip when
 * it is an age-curve estimate. Empty string for null/absent trend (older deploy
 * without player_history/ai_insights). Provenance is never hidden.
 */
export function renderTrendChip(trend) {
  if (!trend || !trend.dir) return '';
  const glyph = trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '▬';
  const word = trend.dir === 'up' ? 'Trending up' : trend.dir === 'down' ? 'Declining' : 'Steady';
  const measured = trend.source === 'measured';
  const slope = Number(trend.slope_pts_per_yr);
  // Measured up-trends cite +pts/yr; declines say so; flats just read "steady".
  let detail = '';
  if (trend.dir !== 'flat' && Number.isFinite(slope)) {
    const sign = slope > 0 ? '+' : '';
    detail = ` ${sign}${fix1(slope)}/yr`;
  }
  const prov = measured
    ? '<span class="prov-src">5-YR</span>'
    : '<span class="prov-ai">AI EST</span>';
  return (
    `<span class="p-trend p-trend--${esc(trend.dir)}" ` +
      `title="${measured ? 'Measured 5-year trajectory' : 'AI age-curve estimate (fewer than 3 seasons)'}">` +
      `<span class="pt-glyph" aria-hidden="true">${glyph}</span>` +
      `<span class="pt-txt">${word}${esc(detail)}</span>${prov}` +
    '</span>'
  );
}

/**
 * Strength-of-schedule pill: a 1.0..5.0 number (1 easiest, 5 hardest) plus a
 * 5-segment meter. Empty string when sos is null/undefined (no team_strength or
 * weekly opponents). The number is the accessible source of truth; the meter is
 * a redundant visual, never color-only.
 */
export function renderSos(sos) {
  const v = Number(sos);
  if (!Number.isFinite(v)) return '';
  const filled = clamp(Math.round(v), 1, 5);
  const segs = [1, 2, 3, 4, 5]
    .map((i) => `<span class="sos-seg${i <= filled ? ' sos-seg--on' : ''}"></span>`)
    .join('');
  return (
    `<span class="p-sos" title="Strength of schedule: 1.0 easiest, 5.0 hardest (mean opponent Elo)">` +
      '<span class="sos-lbl">SOS</span>' +
      `<span class="sos-num">${esc(fix1(v))}</span>` +
      `<span class="sos-meter" aria-hidden="true">${segs}</span>` +
    '</span>'
  );
}

/* --------------------------------------------------------------------------
 * Scoring seg + weekly strip (players view)
 * ------------------------------------------------------------------------ */

/** Scoring modes in display order. Persisted value ∈ this set (default ppr). */
export const SCORING_MODES = ['ppr', 'half', 'std'];

/**
 * The global PPR/HALF/STD scoring toggle (.scoreseg) for the players header.
 * Active button carries .scoreseg--active + aria-pressed (CSS matches either).
 * Only rendered when player_weekly.json is available — the conversion needs
 * receptions_prior, so without it the view is honestly PPR-only.
 */
export function renderScoreSeg(active) {
  const btns = SCORING_MODES.map((mode) => {
    const on = mode === active;
    return (
      `<button type="button" data-scoring="${mode}"` +
        `${on ? ' class="scoreseg--active"' : ''} aria-pressed="${on ? 'true' : 'false'}">` +
        `${mode.toUpperCase()}</button>`
    );
  }).join('');
  return `<div class="scoreseg" role="group" aria-label="Scoring format">${btns}</div>`;
}

/**
 * The 18-cell .wkstrip from a player_weekly weeks[] array.
 * `ratio` = season_adj / season_ppr — the EXACT scoring rescale (weekly points
 * scale proportionally to the season conversion; callers guard division by
 * zero and pass 1). Byes render .wkcell--bye with "BYE" and NO points (a bye
 * is a zero-week, not a 0.0 projection). Away opponents are "@OPP".
 */
export function renderWeekStrip(weeks, ratio) {
  const r = Number.isFinite(Number(ratio)) ? Number(ratio) : 1;
  const cells = (Array.isArray(weeks) ? weeks : []).map((w) => {
    const wk = `<span class="wkc-wk">W${esc(w.wk)}</span>`;
    if (w.bye === true) {
      return `<div class="wkcell wkcell--bye">${wk}<span class="wkc-opp">BYE</span></div>`;
    }
    const opp = `${w.home ? '' : '@'}${w.opp == null ? '' : w.opp}`;
    return (
      `<div class="wkcell">${wk}` +
        `<span class="wkc-opp">${esc(opp)}</span>` +
        `<span class="wkc-pts">${esc(fix1(Number(w.pts) * r))}</span>` +
      '</div>'
    );
  }).join('');
  return `<div class="wkstrip">${cells}</div>`;
}

/* --------------------------------------------------------------------------
 * Parlay card
 * ------------------------------------------------------------------------ */

/** Build the "KC/BAL" matchup label from a game_id "2026_01_BAL_KC". */
function matchupFromGameId(gameId) {
  const parts = String(gameId || '').split('_');
  if (parts.length >= 4) {
    const away = parts[2];
    const home = parts[3];
    return `${home}/${away}`;
  }
  return '';
}

/** One .leg row. */
function renderLeg(leg) {
  const model = Math.round(Number(leg.model_prob) * 100);
  const impl = Math.round(Number(leg.implied_prob) * 100);
  const edge = edgePct(leg.model_prob, leg.implied_prob);
  const edgeCls = edge >= 0 ? 'lg-edge--pos' : 'lg-edge--neg';
  return (
    '<div class="leg">' +
      `<div class="leg-nm">${esc(formatLeg(leg.market, leg.selection))}</div>` +
      '<div class="leg-od">' +
        `<span class="mo">MODEL <b>${model}</b></span>` +
        `<span class="im">IMPL ${impl}</span>` +
        `<span class="lg-edge ${edgeCls}">${signedInt(edge)}</span>` +
      '</div>' +
    '</div>'
  );
}

/** One .card.parlay article from a parlays[] entry. */
export function renderParlayCard(parlay) {
  const scope = parlay.scope === 'week' ? 'week' : 'game';
  const label = scope === 'game'
    ? `GAME PARLAY · ${matchupFromGameId(parlay.game_id)}`
    : 'WEEK PARLAY';

  const tier = String(parlay.confidence_tier || '').toLowerCase() || 'low';
  const tierLabel = tier.toUpperCase();

  const ev = Number(parlay.model_ev) * 100;
  const evCls = ev >= 0 ? 'ev--pos' : 'ev--neg';

  const legs = Array.isArray(parlay.legs) ? parlay.legs : [];
  const legsHtml = legs.map(renderLeg).join('');

  const corr = parlay.correlation_note
    ? '<div class="corr">' +
        '<span class="lk" aria-hidden="true">⚭</span>' +
        `<span>${esc(parlay.correlation_note)}</span>` +
      '</div>'
    : '';

  return (
    `<article class="card parlay" data-parlay-id="${esc(parlay.parlay_id)}" data-scope="${esc(scope)}">` +
      '<div class="p-head">' +
        `<span class="lbl">${esc(label)}</span>` +
        `<span class="tier tier--${tier}">${esc(tierLabel)}</span>` +
      '</div>' +
      `<div class="legs">${legsHtml}</div>` +
      '<div class="p-foot">' +
        `<div class="ev ${evCls}">${signedPct1(ev)}<span class="k">MODEL EV</span></div>` +
        `<div class="legcount">${legs.length} legs</div>` +
      '</div>' +
      corr +
    '</article>'
  );
}
