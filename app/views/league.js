/* app/views/league.js — THE LEAGUE TAB. R48.
 *
 * One page that answers, from storage alone, "which league is every number on
 * every tab priced under, and how does it differ from the app default?":
 *   - the applied league (name, Sleeper id, teams, starters + bench, what a
 *     reception is worth) — or the honest NO LEAGUE state;
 *   - SCORING: every key where the league's points differ from standard PPR;
 *   - ROSTER: every way its shape differs from the default 9 + 6 / 12 teams;
 *   - LAST SYNC: the device's sync log (app/synclog.js), newest first.
 *
 * It fetches NOTHING — no data contract, no Sleeper call. It reads the saved
 * profile (app/league.js), the remembered league id and the sync log, and
 * repaints on the 'nfl2026:league' window event TEAM and GRADE dispatch after
 * a sync. Listeners are scoped to the mount with the same AbortController
 * teardown app/views/team.js uses (TEARDOWN_KEY there), so navigating away
 * and back never stacks a second repaint handler on the window.
 *
 * Absent is not zero: a key the league table does not carry reads "not in
 * table"; a key standard PPR does not price reads "not scored".
 */

import { loadProfile, loadLeagueId, isDefaultProfile, DEFAULT_PROFILE } from '../league.js';
import { scoringDiff, shapeDiff, loadSyncLog } from '../synclog.js';

const TEARDOWN_KEY = '__nfl2026LeagueTeardown';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A scoring value for display: signed, trimmed, never invented. */
function pts(v, absentText) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) {
    return `<span class="lgv-absent">${esc(absentText)}</span>`;
  }
  const n = Number(v);
  const text = (n > 0 ? '+' : '') + String(Math.round(n * 1000) / 1000);
  return `<span class="lgv-num">${esc(text)}</span>`;
}

/** "Sep 1, 12:00" in the viewer's locale; the raw ISO string if unparseable. */
function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  try {
    return new Date(t).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch (err) {
    return new Date(t).toISOString();
  }
}

function headerHtml(profile, leagueId, applied) {
  if (!applied) {
    return '<section class="card lgv-card">'
      + '<h2>NO LEAGUE APPLIED</h2>'
      + '<p class="m-explain">Every projection on every tab is priced under standard PPR '
      + 'and the default roster shape (9 starters, 6 bench, 12 teams). Sync a Sleeper '
      + 'league on TEAM (SYNC NOW) or GRADE (LOAD) to price everything under yours.</p>'
      + '</section>';
  }
  const shape = profile.shape || {};
  const rec = profile.scoring && Object.prototype.hasOwnProperty.call(profile.scoring, 'rec')
    ? profile.scoring.rec : null;
  const recText = rec === null
    ? 'reception not in table'
    : `reception ${Math.round(Number(rec) * 1000) / 1000}`;
  return '<section class="card lgv-card">'
    + '<h2>LEAGUE APPLIED</h2>'
    + `<div class="lgv-name">${esc(profile.name)}</div>`
    + '<div class="lgv-meta">'
    + (leagueId ? `Sleeper league ${esc(leagueId)} · ` : 'hand-set (no Sleeper id) · ')
    + `${esc(shape.teams)} teams · ${esc(shape.starters)} starters + ${esc(shape.bench)} bench · `
    + `${esc(recText)}`
    + '</div>'
    + '<p class="m-explain">Every projection on every tab is priced under this league\'s '
    + 'scoring table and roster shape.</p>'
    + '</section>';
}

function scoringHtml(rows) {
  const body = rows.length
    ? '<div class="lgv-scroll"><table class="lgv-tbl">'
      + '<thead><tr><th>RULE</th><th class="lgv-r">LEAGUE</th><th class="lgv-r">STANDARD</th></tr></thead>'
      + '<tbody>'
      + rows.map((r) => (
        `<tr class="lgv-row" data-key="${esc(r.key)}">`
        + `<td><span class="lgv-label">${esc(r.label)}</span>`
        + (r.label !== r.key ? `<span class="lgv-key">${esc(r.key)}</span>` : '')
        + '</td>'
        + `<td class="lgv-r">${pts(r.league, 'not in table')}</td>`
        + `<td class="lgv-r">${pts(r.standard, 'not scored')}</td>`
        + '</tr>'
      )).join('')
      + '</tbody></table></div>'
      + `<div class="gr-note">${rows.length} rule${rows.length === 1 ? '' : 's'} differ. `
      + 'Sorted by the size of the difference. "Not scored" means standard PPR has no '
      + 'such rule; "not in table" means the league\'s table does not carry it.</div>'
    : '<div class="state lgv-empty">Scoring matches standard PPR on every key.</div>';
  return '<section class="card lgv-card">'
    + '<h2>SCORING · WHAT DIFFERS FROM STANDARD PPR</h2>'
    + body
    + '</section>';
}

function rosterHtml(diff) {
  const lines = diff.lines.length
    ? '<ul class="lgv-lines">'
      + diff.lines.map((l) => `<li class="lgv-line">${esc(l)}</li>`).join('')
      + '</ul>'
    : '<div class="state lgv-empty">Roster shape matches the default: '
      + `${DEFAULT_PROFILE.shape.starters} starters, ${DEFAULT_PROFILE.shape.bench} bench, `
      + `${DEFAULT_PROFILE.shape.teams} teams.</div>`;
  return '<section class="card lgv-card">'
    + '<h2>ROSTER · WHAT DIFFERS</h2>'
    + lines
    + `<div class="lgv-positions"><span class="lgv-key">LEAGUE</span> `
    + `<code class="lgv-code">${esc(diff.league.roster_positions.join(' '))}</code></div>`
    + `<div class="lgv-positions"><span class="lgv-key">STANDARD</span> `
    + `<code class="lgv-code">${esc(diff.standard.roster_positions.join(' '))}</code></div>`
    + '</section>';
}

function syncLogHtml(log) {
  const body = log.length
    ? log.map((e) => (
      `<article class="lgv-sync" data-kind="${esc(e.kind)}">`
      + '<div class="lgv-sync-head">'
      + `<span class="lgv-kind">${esc(String(e.kind).toUpperCase())}</span>`
      + `<span class="lgv-when">${esc(when(e.at))}</span>`
      + '</div>'
      + `<div class="lgv-sync-league">${esc(e.league_name || 'league not named')}`
      + (e.league_id ? ` <span class="lgv-key">${esc(e.league_id)}</span>` : '')
      + '</div>'
      + (e.changes.length
        ? '<ul class="lgv-lines">'
          + e.changes.map((c) => `<li class="lgv-line">${esc(c)}</li>`).join('')
          + '</ul>'
        : '<div class="gr-note">No changes recorded for this sync.</div>')
      + '</article>'
    )).join('')
    : '<div class="state lgv-empty">No sync recorded yet on this device.</div>';
  return '<section class="card lgv-card">'
    + '<h2>LAST SYNC</h2>'
    + body
    + '<div class="gr-note">RESET ALL on TEAM clears the league and this log.</div>'
    + '</section>';
}

/** Paint the whole page from storage. Pure read; never throws past here. */
function render(el) {
  let profile;
  let leagueId = null;
  let applied = false;
  try {
    profile = loadProfile();
    leagueId = loadLeagueId();
    applied = !isDefaultProfile(profile);
  } catch (err) {
    profile = loadProfile(null);
  }
  const rows = scoringDiff(profile);
  const shape = shapeDiff(profile);
  const log = loadSyncLog();
  el.innerHTML = '<div class="lgv">'
    + headerHtml(profile, leagueId, applied)
    + scoringHtml(rows)
    + rosterHtml(shape)
    + syncLogHtml(log)
    + '</div>';
}

export default function mountLeague(el) {
  // Retire the previous mount's listener BEFORE this one paints (see
  // app/views/team.js TEARDOWN_KEY for the full reasoning). Absent
  // AbortController, the listener binds as any other would.
  const priorTeardown = el[TEARDOWN_KEY];
  if (priorTeardown) { try { priorTeardown.abort(); } catch (_) { /* already gone */ } }
  const teardown = typeof AbortController === 'function' ? new AbortController() : null;
  el[TEARDOWN_KEY] = teardown;
  const listen = (target, type, fn) => {
    const opts = {};
    if (teardown) opts.signal = teardown.signal;
    target.addEventListener(type, fn, opts);
  };

  render(el);
  // TEAM and GRADE dispatch this after every sync (settings or roster).
  listen(window, 'nfl2026:league', () => render(el));
}
