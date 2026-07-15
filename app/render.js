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
  switch (market) {
    case 'moneyline':
      return `${sel} ML`;
    case 'anytime_td': {
      // Data carries e.g. "Patrick Mahomes TD"; strip trailing " TD" so we can
      // append the canonical "anytime TD" phrasing without duplicating it.
      const player = sel.replace(/\s+TD$/i, '');
      return `${player} anytime TD`;
    }
    case 'spread':
    case 'total':
    case 'player_receptions':
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
  const bad = Object.values(feeds).filter((f) => f && f.status && f.status !== 'ok').length;
  const label = `DATA · ${mod.toUpperCase()}`;
  const note = bad > 0 ? `${bad} ${bad === 1 ? 'feed' : 'feeds'} stale / degraded` : 'all feeds ok';
  return (
    `<span class="health-dot health-dot--${mod}"></span>` +
    `<span class="health-label">${esc(label)}</span>` +
    `<span class="health-note">${esc(note)}</span>`
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

  const model = String(game.model || '').toUpperCase();
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
          `<span class="ph ph--away">${esc(away)} ${awayPct}%</span>` +
          `<span class="ph ph--home">${esc(home)} ${homePct}%</span>` +
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

/** One .card.player article from a player_projections[] entry. */
export function renderPlayerCard(player) {
  const low = Number(player.low);
  const high = Number(player.high);
  const proj = Number(player.proj_points);

  // Point marker position inside the conformal band, clamped to the track.
  const span = high - low;
  const pctLeft = span > 0 ? clamp(((proj - low) / span) * 100, 0, 100) : 50;

  return (
    `<article class="card player" data-gsis="${esc(player.gsis_id)}">` +
      '<div class="p-top">' +
        '<div class="p-id">' +
          `<div class="p-pos">${esc(player.position)} · ${esc(player.team)}</div>` +
          `<div class="p-name">${esc(player.name)}</div>` +
        '</div>' +
        '<div class="p-proj">' +
          `<div class="p-num">${esc(fix1(proj))}</div>` +
          '<div class="p-unit">PROJ PTS</div>' +
        '</div>' +
      '</div>' +
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
    '</article>'
  );
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
