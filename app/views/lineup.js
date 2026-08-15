/* app/views/lineup.js — WEEKLY START/SIT + LINEUP OPTIMIZER (route #/lineup).
 *
 * Phase 1 of the in-season roadmap. Reads the roster the Team builder saved
 * (localStorage nfl2026.team.v1) and, for a chosen week, computes the optimal
 * legal starting lineup from the committed per-week projections — converted to
 * the persisted scoring mode and the league's own extra rules (R30b,
 * leagueWeeks below) — then surfaces the start/sit moves versus the manager's
 * current starters. Pure math lives in app/lineup.js; this module only fetches
 * contracts and paints.
 *
 * Honest by construction: byes are excluded (a bye-week player can never start);
 * a missing weekly feed degrades to a clear state message, never a blank or a
 * fabricated projection. Projections only — no betting line anywhere.
 *
 * REL17 — AVAILABILITY. An unavailable player (IR/PUP/NFI/suspended/ruled out) is
 * never SILENTLY auto-started. Three coordinated behaviours:
 *   1. his week's points are zeroed at the display boundary, exactly like a bye,
 *      so the row and the card total can never disagree;
 *   2. bestLineup demotes him below every available candidate, so in the normal
 *      case he simply is not in a slot — the quiet, correct outcome;
 *   3. when the roster has nobody else for that slot he IS started, and the card
 *      shouts about it (`.lu-forced` banner + a non-receding row), and the
 *      "already optimal" line is suppressed because it would be a lie.
 * The availability block is optional on data/player_weekly.json: a deploy that
 * predates the pipeline renders exactly as it does today.
 *
 * R19-B5 — EVERY SLOT THE LEAGUE STARTS, INCLUDING K AND DEF. The card is no
 * longer hard-wired to seven rows: geometry comes from the connected league
 * profile, so a 9-starter league renders nine rows. K and DEF have no projection
 * feed yet, and this view refuses the two dishonest ways of handling that:
 *   - it does NOT omit the slot (a 7-row card for a 9-starter league is a wrong
 *     lineup presented as a right one), and
 *   - it does NOT print 0.0 (a manager would read that as a projection of zero).
 * The row renders as awaiting its feed, with an em dash where the points go, and
 * the card head states the real coverage: "7 of 9 slots projected". The START/SIT
 * card says the same thing in words, so "already optimal" never covers slots this
 * app never looked at.
 *
 * R20-B1 — THE K/DST FEED FILLS THOSE SLOTS, WITH ITS LIMITS ON THE FACE OF IT.
 * data/kdst_projections.json now exists (app/kdst.js reads it), so K and DEF
 * rows enter the same optimizer as everyone else and the coverage line goes to
 * "all 9 slots projected". Four things this view refuses to hide:
 *   1. THE FEED IS CONDITIONAL. `feeds` is derived from what actually loaded and
 *      which positions actually have rows. A 404, an empty `defenses`, an older
 *      deploy — each falls straight back to the R19-B5 "awaiting feed" row and
 *      its WARN_NO_PROJECTION warning. That path is not dead code; it is one
 *      failed fetch away at all times.
 *   2. THESE ARE SEASON AVERAGES. The contract carries season totals with no
 *      weekly split and no opponent adjustment, so a K/DST week is season ÷
 *      games. Every such row is tagged SEASON AVG. A flat average silently
 *      dressed as a week-specific projection is a lie by presentation.
 *   3. PARTIAL SCORING IS MARKED. Three Sleeper D/ST keys cannot be modelled
 *      from any available source. If the connected league SCORES one of them,
 *      the D/ST total omits it — so the row carries a PARTIAL badge and the card
 *      names the missing components. A league that does not score them omits
 *      nothing and is not marked.
 *   4. BYES STILL COUNT. K/DST have no weekly rows to carry a bye flag, so the
 *      bye comes from the schedule. A kicker on his bye is worth 0, exactly like
 *      every other player, and the optimizer benches him for it.
 *
 * R24-B — three carried findings. No number on this page changes:
 *   1. THE K/DST CONTRACT IS NO LONGER ON THE CRITICAL PATH FOR EVERYONE. Every
 *      mount awaited ~59KB that a DEFAULT-profile league (7 starters, no K/DEF
 *      slot, and no K/DEF position even in play for the bench) could never use.
 *      It is fetched when the league fields K/DEF/DST, when the saved roster
 *      still parks somebody in such a slot, or — lazily — when a roster id
 *      resolves through neither feed. A K/DEF league is unchanged.
 *   2. THE CARD HEAD TITLE IS ITS OWN ELEMENT. As a bare text node beside
 *      .lu-total it was an anonymous flex item, and at 402px the container broke
 *      it mid-phrase: "OPTIMAL LINEUP · WEEK" with the "1" orphaned onto the next
 *      line beside the total.
 *   3. THE START/SIT NET-GAIN SENTENCE IS ONE ELEMENT. .lu-move is a three-column
 *      grid and the sentence's three child nodes were being laid out as three
 *      CELLS ("Switching to the optimal   +8.8 pts   this week." with "lineup
 *      adds" wrapped underneath). It is prose in a block row now.
 */

import {
  getPlayerProjections, getPlayerWeekly, getGamePredictions, getScheduleFull,
} from '../data.js';
import { teamTint, teamName } from '../render.js';
import { loadProfile, rosterSlots, rosterPositionsInPlay } from '../league.js';
import {
  bestLineup, startSitSwaps, WARN_FORCED_UNAVAILABLE, WARN_NO_PROJECTION,
} from '../lineup.js';
import {
  getKdstProjections, shapeKdst, fedPositions, teamByeWeeks,
} from '../kdst.js';
import { availabilityOf, renderAvailChip } from '../availability.js';
// R29 — the league's own scoring rules, stamped onto the weekly entries once.
// R30b — plus the ONE shared season-points conversion (scoringAdjust) and the
// ONE weekly redistribution (weeklyPoints), so this tab prints the same table
// as PLAYERS/TEAM/COMPARE instead of hard-wired full PPR.
import {
  withLeagueExtras, scoringAdjust, extraPtsOf, weeklyPoints, loadScoringMode,
} from '../team-logic.js';
import { rosPoints } from '../ros.js';

const TEAM_KEY = 'nfl2026.team.v1';   // mirror of the Team builder's roster key
const WEEKS = 18;

/**
 * Row label for a slot id: the roster token without its ordinal, exactly as the
 * seven-slot map used to spell it (QB1 -> QB, FLEX -> FLEX) and as a K/DEF league
 * needs it (K1 -> K, DEF1 -> DEF).
 */
const slotLabel = (slot) => String(slot).replace(/\d+$/, '');

/** What a slot with no projection feed is waiting for, in plain words. */
const AWAITING = {
  K: 'Kicker projections aren’t published yet',
  DEF: 'Team-defense projections aren’t published yet',
  DST: 'Team-defense projections aren’t published yet',
};

/**
 * The OTHER reason a slot can carry no number: the feed is published, but the
 * connected league's scoring table pays for nothing this position produces, so
 * every projection under it would be 0 — a fact about the scoring table, not
 * about any player. Same warning code (the slot genuinely has no projection),
 * different words, because "not published" and "your league doesn't score it"
 * send a manager to two different places.
 */
const UNSCORED = {
  K: 'Your league’s scoring table scores no kicking stat',
  DEF: 'Your league’s scoring table scores no team-defense stat',
  DST: 'Your league’s scoring table scores no team-defense stat',
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const fix1 = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(1) : '—');
const stateMsg = (el, text) => { el.innerHTML = `<div class="state">${text}</div>`; };

/**
 * R30b — ONE player's weekly points in the LEAGUE'S OWN TABLE, exported PURE.
 *
 * WEEKLY LINEUP used to print `wkEntry.pts` raw — full PPR by contract —
 * regardless of the persisted scoring mode or the league's extra rules, so the
 * same player's week disagreed with the TEAM tab's slot chip (Nacua W1: 21.1
 * here, 13.8 on TEAM in STD) and the optimizer ranked, totalled and phrased its
 * "+X pts" claim in points the league does not award.
 *
 * The conversion is the SAME two shared functions team.js:1307-1309 uses, in
 * the same order — never a private copy:
 *   1. scoringAdjust() turns the full-PPR season total into this mode's season
 *      total, including the league's extra_pts (stamped by withLeagueExtras).
 *   2. weeklyPoints() redistributes that season total across the weeks
 *      proportionally to each week's share of the season (byes stay hard 0).
 *
 * That redistribution IS the extras-apportionment decision R30a deferred:
 * `extra_pts` is a SEASON total, and scaling every non-bye week by
 * season_adj/season_ppr hands week i exactly extra × (pts_i / season_ppr) —
 * proportional to its share of season points, 0 on byes — so the season
 * identity holds: the weekly extras sum back to extra_pts.
 *
 * Returns { adj, ratio, weeks } where weeks[i] aligns 1:1 with w.weeks[i].
 * No weekly entry -> weeks [] and ratio 1 (nothing to convert — absent stays
 * absent, never a fabricated 0.0).
 */
export function leagueWeeks(p, w, mode) {
  const ppr = Number(p ? p.proj_points : NaN);
  const adj = scoringAdjust(ppr, w ? w.receptions_prior : 0, mode, extraPtsOf(w));
  return {
    adj,
    ratio: Number.isFinite(ppr) && ppr > 0 ? adj / ppr : 1,
    weeks: weeklyPoints(w, adj, ppr),
  };
}

/** Read the saved roster's slot->id map (starters only matter here). */
function loadRosterSlots() {
  try {
    const stored = JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
    return (stored && stored.slots && typeof stored.slots === 'object') ? stored.slots : null;
  } catch (err) {
    return null;
  }
}

export default async function mountLineup(el) {
  el.innerHTML = '<div class="state state--loading">Loading lineup…</div>';

  // The two SYNCHRONOUS inputs are read FIRST because they decide what has to be
  // fetched at all. Both are localStorage reads that cannot throw.
  const slots = loadRosterSlots();
  // The connected league's own geometry. An unconfigured user gets DEFAULT_PROFILE,
  // which is the seven-starter / six-bench roster this view has always drawn.
  const profile = loadProfile();
  const leagueSlots = rosterSlots(profile);

  // R24 — DO NOT BLOCK FIRST PAINT ON A CONTRACT THIS LEAGUE CANNOT USE.
  // data/kdst_projections.json is ~59KB and every Lineup mount used to await it,
  // including the DEFAULT 7-starter league, which has no K/DEF slot and — per
  // rosterPositionsInPlay — cannot even bench a kicker, so not one byte of it
  // could ever reach the screen. It is fetched when the league actually fields
  // K/DEF/DST, or when the SAVED roster still parks somebody in a K/DEF/DST slot
  // from an earlier profile: the roster is a BAG of players here, and a stale
  // kicker must not silently vanish merely because the fetch was skipped.
  const KDST_TOKEN = /^(K|DEF|DST)\d*$/;
  const wantsKdst = rosterPositionsInPlay(profile)
    .some((pos) => KDST_TOKEN.test(String(pos).toUpperCase()))
    || (slots ? Object.keys(slots).some((k) => KDST_TOKEN.test(String(k).toUpperCase())) : false);

  // The first two are REQUIRED — no offence, no lineup. The last three are
  // OPTIONAL by design: the K/DST contract and the schedule may be absent on an
  // older deploy, and the view must degrade rather than blank.
  const [projRes, weeklyRes, predsRes, kdstRes, schedRes] = await Promise.allSettled([
    getPlayerProjections(), getPlayerWeekly(), getGamePredictions(),
    wantsKdst ? getKdstProjections() : Promise.resolve(null), getScheduleFull(),
  ]);
  if (projRes.status !== 'fulfilled' || weeklyRes.status !== 'fulfilled') {
    stateMsg(el, 'Lineup unavailable — the projection or weekly feed did not load.');
    return;
  }
  const players = (projRes.value && Array.isArray(projRes.value.players)) ? projRes.value.players : [];
  const weekly = (weeklyRes.value && Array.isArray(weeklyRes.value.players)) ? weeklyRes.value.players : [];
  const byId = new Map(players.map((p) => [String(p.gsis_id), p]));
  const weeklyRaw = new Map(weekly.map((w) => [String(w.gsis_id), w]));
  /* R29 — THIS LEAGUE's own scoring rules, stamped onto the weekly entries
   * once, so every conversion below prices the same player identically without
   * threading a rate through eight signatures. Must follow the profile load:
   * stamping before the league is known would price every league at zero. A
   * league that does not score pass_cmp gets the identical Map back.
   * R30b — the stamp is no longer inert here: leagueWeeks() reads extra_pts
   * (via the shared scoringAdjust) into every weekly number this tab prints. */
  const weeklyById = withLeagueExtras(weeklyRaw, profile);
  /* R30b — the persisted scoring mode, through the ONE shared reader. Read once
   * per mount, exactly like players.js/team.js/compare.js: the toggle lives on
   * those tabs, and whatever it last persisted is the table this page is in. */
  const scoringMode = loadScoringMode();
  // Per-player converted weekly arrays, memoized: paint(wk) re-runs on every
  // week tap and the conversion is identical each time.
  const _lw = new Map();
  const leagueWeeksOf = (id) => {
    if (!_lw.has(id)) _lw.set(id, leagueWeeks(byId.get(id), weeklyById.get(id), scoringMode));
    return _lw.get(id);
  };

  let currentWk = 1;
  if (predsRes.status === 'fulfilled' && predsRes.value && predsRes.value.week != null) {
    const w = Number(predsRes.value.week);
    if (Number.isFinite(w)) currentWk = Math.min(WEEKS, Math.max(1, Math.round(w)));
  }

  // The one case the cheap test above cannot see: a roster id that resolves
  // through NEITHER feed. It may be a K or a D/ST parked on a BENCH slot under a
  // league that has since dropped the position, and dropping him unseen would be
  // the phantom-row bug in reverse. So ask for the contract before concluding he
  // is gone — rare by construction, and it costs the fetch only when it happens.
  let kdstDoc = kdstRes.status === 'fulfilled' ? kdstRes.value : null;
  if (!wantsKdst && slots) {
    const unknown = Object.values(slots).filter(Boolean).map(String).some((id) => !byId.has(id));
    if (unknown) {
      try { kdstDoc = await getKdstProjections(); } catch (err) { kdstDoc = null; }
    }
  }
  // K/DST, scored under THIS league (applyScoring on the stat line — never the
  // contract's DEFAULT-profile convenience total). `feeds` is what tells the
  // optimizer which slots it may fill; an unfulfilled fetch leaves it empty and
  // the R19-B5 "awaiting feed" path is exactly what runs.
  const kdst = shapeKdst(kdstDoc, profile);
  const feeds = fedPositions(kdst);
  const kdstById = kdst.byId;
  // Positions whose rows arrived but which this league's scoring table cannot
  // value. They are NOT fed (there is no honest number), and the row must say
  // that rather than blame a missing feed.
  const unscoredPos = new Set(kdst.unscoredPositions.flatMap(
    (pos) => (pos === 'DEF' ? ['DEF', 'DST'] : [pos]),
  ));
  // Byes for K/DST come from the schedule — they have no weekly rows of their
  // own. No schedule, no bye claims (and no invented ones).
  const byeByTeam = teamByeWeeks(schedRes.status === 'fulfilled' ? schedRes.value : null);
  const resolvable = (id) => byId.has(id) || kdstById.has(id);
  // Sanitize against the live pool exactly like the Team builder's loadRoster:
  // a player dropped/traded/retired out of projections must NOT render as a
  // phantom row named after his raw id — drop any id we can't resolve.
  // Read EVERY id the saved roster holds, not just those parked under slot names
  // this profile happens to have. The optimizer takes the roster as a BAG of
  // players and assigns its own slots, so keying off slot names here only
  // creates a way to lose people: a roster saved under a different geometry (an
  // older release, or before the user changed their league) would vanish from
  // the lineup while still showing on the Team page. Profile slots are read
  // first so the familiar order is preserved; anything else follows.
  const seenIds = new Set();
  const rosterIds = slots
    ? Object.keys(slots)
      .sort((a, b) => {
        const ia = leagueSlots.all.indexOf(a);
        const ib = leagueSlots.all.indexOf(b);
        return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
      })
      .map((s) => slots[s]).filter(Boolean).map(String)
      .filter((id) => {
        // A K or D/ST id resolves through the K/DST contract, not through
        // player_projections — but ONLY while that contract is loaded. Without
        // it they are as unresolvable as a traded player, and drop out rather
        // than render as a phantom row named after a raw id.
        if (!resolvable(id) || seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      })
    : [];

  el.innerHTML =
    '<header class="view-head">' +
      '<h1 class="view-title">WEEKLY LINEUP</h1>' +
      // R30b — the sub-label names the ACTIVE table, not a literal 'PPR': the
      // rows below are converted to the persisted mode, and a header that said
      // PPR over STD numbers would be the exact stale-copy defect R27 shipped.
      `<span class="view-sub">START / SIT · ${esc(scoringMode.toUpperCase())} · <span class="est">ESTIMATE</span></span>` +
    '</header>' +
    weekBar(currentWk) +
    '<div id="lineup-body"></div>';

  const body = el.querySelector('#lineup-body');

  if (!slots || rosterIds.length === 0) {
    body.innerHTML =
      '<div class="state">No roster yet. Build one in the <a href="#/team">Team</a> tab — '
      + 'add players to your starting slots and bench, and your best weekly lineup shows up here.</div>';
    wireWeekBar(el, () => {});
    return;
  }

  function playerRow(id, wk) {
    // K / D/ST: one flat per-game average from the season contract, zeroed on
    // the team's bye exactly like anyone else. There is no injury feed for a
    // team defense, so availabilityOf(null) makes no claim rather than a false
    // "healthy" one — it renders no chip at all.
    const kd = kdstById.get(id);
    if (kd) {
      const bye = byeByTeam.get(String(kd.team).toUpperCase());
      const onBye = Number.isFinite(bye) && Number(bye) === Number(wk);
      return {
        id,
        name: kd.name,
        pos: kd.pos,
        team: kd.team,
        // An unscored row contributes 0 to the optimizer (it cannot be valued,
        // so it cannot earn a slot on merit) but must never PRINT 0.0.
        pts: (onBye || kd.unscored) ? 0 : kd.weeklyPoints,
        onBye,
        ros: 0,
        avail: availabilityOf(null, wk, currentWk),
        kdst: kd,
        unscored: kd.unscored,
      };
    }
    const p = byId.get(id);
    const w = weeklyById.get(id);
    const pos = String((p && p.position) || '').toUpperCase();
    const team = (p && p.team) || '';
    const weeks = (w && Array.isArray(w.weeks)) ? w.weeks : null;
    const wkIdx = weeks ? weeks.findIndex((x) => Number(x.wk) === wk) : -1;
    const wkEntry = wkIdx >= 0 ? weeks[wkIdx] : null;
    const onBye = !!(wkEntry && wkEntry.bye);
    // Mirrors the bye line: a player who cannot play scores 0 for display. Showing
    // 12.4 beside a "⊘ IR" chip is the same lie the un-haircut projection shipped.
    const avail = availabilityOf(w, wk, currentWk);
    // R30b — the week's points come out of the CONVERTED array (same index as
    // w.weeks), never raw wkEntry.pts: this row must be the same arithmetic as
    // the TEAM tab's weekly grid, in the league's own scoring table.
    const lw = leagueWeeksOf(id);
    const pts = (onBye || avail.playable === false)
      ? 0
      : (wkIdx >= 0 ? Number(lw.weeks[wkIdx]) || 0 : 0);
    // RoS rides the same season ratio (mode + apportioned extras), matching
    // players.js rosValue(): remaining games must never outweigh the season.
    const ros = weeks ? rosPoints(weeks, wk) * lw.ratio : 0;
    return { id, name: (p && p.name) || id, pos, team, pts, onBye, ros, avail, kdst: null, unscored: false };
  }

  /** The points cell. An unvaluable row shows an em dash, never a made-up 0.0. */
  const ptsCell = (r) => (r.unscored ? '—' : fix1(r.pts));

  /**
   * The rendered points cell for a starter row.
   *
   * A PARTIAL total is marked ON THE NUMBER, not only beside it. Before this,
   * an incomplete D/ST total rendered in exactly the same mono/800/--ink as
   * every complete number in the column, and the only qualification was a 9px
   * badge plus a disclosure block that sits below the fold on a phone — so the
   * most prominent thing on the row read as complete. The marker travels with
   * the figure now: a trailing '*' (never colour alone — the app's own rule)
   * plus the warn tone the badge already uses, and the PARTIAL SCORING block
   * below names the asterisk so it is not a mystery glyph.
   */
  function ptsCellHtml(r) {
    const partial = Boolean(r.kdst && r.kdst.partial && !r.unscored);
    if (!partial) return `<span class="lu-pts">${ptsCell(r)}</span>`;
    const names = r.kdst.omitted.map((o) => o.label).join(', ');
    return '<span class="lu-pts lu-pts--partial" '
      + `title="${esc(`INCOMPLETE total — it omits: ${names}`)}">${ptsCell(r)}*</span>`;
  }

  /**
   * The badges a K/DST row must wear. SEASON AVG is not decoration: it is the
   * difference between "we project 8.6 for him this week" (false) and "he
   * averages 8.6 a game" (true). PARTIAL names a total that omits a component
   * this league pays for. LOW SAMPLE is the contract's own flag.
   */
  function kdstTags(r) {
    if (!r.kdst) return '';
    let out = '<span class="lu-tag" title="Season projection ÷ games. '
      + 'No weekly split and no opponent adjustment exist for this position.">SEASON AVG</span>';
    if (r.kdst.lowSample) {
      out += ' <span class="lu-tag lu-tag--warn" title="Few games behind this projection.">LOW SAMPLE</span>';
    }
    if (r.kdst.partial) {
      const names = r.kdst.omitted.map((o) => o.label).join(', ');
      out += ` <span class="lu-tag lu-tag--warn" title="${esc(`This total omits: ${names}`)}">PARTIAL</span>`;
    }
    return ` ${out}`;
  }

  function paint(wk) {
    const rows = rosterIds.map((id) => playerRow(id, wk));
    // `playable` MUST ride into both pure helpers — mapping down to {id,pos,pts}
    // is what silently dropped availability before Rel17.
    const optIn = rows.map((r) => ({
      id: r.id, pos: r.pos, pts: r.pts, playable: r.avail.playable,
    }));
    const optimal = bestLineup(optIn, profile, { feeds });
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const currentStarters = leagueSlots.starters.map((s) => slots[s])
      .filter(Boolean).map(String).filter(resolvable);
    const moves = startSitSwaps(currentStarters, optIn, wk, profile, { feeds });
    const allWarnings = Array.isArray(optimal.warnings) ? optimal.warnings : [];
    // ONE channel, TWO facts. A forced start is a waiver-wire to-do; an
    // unprojected slot is a missing feed. Splitting them here is what keeps the
    // banners, the rows and the "optimal" line each telling the truth.
    const warnings = allWarnings.filter((wn) => wn.reason === WARN_FORCED_UNAVAILABLE);
    const unprojected = allWarnings.filter((wn) => wn.reason === WARN_NO_PROJECTION);
    const forcedSlots = new Set(warnings.map((wn) => wn.slot));
    // A THIRD fact, distinct from both of the above: the slot has a feed, and
    // the roster has nobody eligible to fill it. bestLineup leaves it null. It
    // contributes nothing to the total, so anything the card claims about that
    // total has to exclude it — including the word "optimal".
    const emptySlots = optimal.geometry
      .filter((g) => g.projected && !optimal.slots[g.slot])
      .map((g) => g.slot);

    // A forced start is a to-do, not a footnote: one banner per warning, at the
    // top of the card, naming the slot, the player and why he can't play.
    const forcedHtml = warnings.map((wn) => {
      const r = rowById.get(wn.id);
      if (!r) return '';
      return (
        '<div class="lu-forced"><span class="av-glyph" aria-hidden="true">⊘</span>'
        + `<span>No available ${esc(r.pos)} on your bench — <b>${esc(wn.slot)}</b> is filled by `
        + `<b>${esc(r.name)}</b>, who ${esc(r.avail.phrase || 'cannot play')}. `
        + 'Nothing on your roster can start there. Check the waiver wire.</span></div>'
      );
    }).join('');

    // Optimal starting lineup, one row per slot the LEAGUE starts — including the
    // ones we cannot project. Nothing here is ever silently dropped.
    const starterHtml = optimal.geometry.map((g) => {
      const slot = g.slot;
      const label = slotLabel(slot);
      if (!g.projected) {
        // NOT "0.0". An em dash is the honest glyph for "no number exists"; a
        // zero would read as a projection, and this slot has none. Two causes,
        // two sentences, one code: the feed is missing, or it is here and this
        // league scores nothing it measures.
        const unscored = g.positions.some((pos) => unscoredPos.has(String(pos).toUpperCase()));
        const why = unscored
          ? (UNSCORED[label] || `Your league scores no ${label} stat`)
          : (AWAITING[label] || `${label} projections aren’t published yet`);
        const tag = unscored ? 'NOT SCORED BY THIS LEAGUE' : 'AWAITING FEED';
        return (
          '<div class="lu-row lu-row--unprojected" style="opacity:0.9">'
          + `<span class="lu-slot">${esc(label)}</span>`
          + `<span class="lu-name" style="font-weight:600;color:var(--muted)">${esc(why)} `
            + `<span class="lu-meta">${esc(tag)} · NOT IN THE TOTAL</span></span>`
          + '<span class="lu-pts" style="color:var(--muted)">—</span>'
          + '</div>'
        );
      }
      const id = optimal.slots[slot];
      const r = id ? rowById.get(id) : null;
      if (!r) {
        // NOT "0.0" EITHER. This slot HAS a feed — the roster simply has nobody
        // who can fill it. "No player" and "a projection of zero points" are
        // different facts and a manager acts on them differently: one sends him
        // to the waiver wire, the other tells him his kicker is worthless. The
        // em dash is the same glyph the unprojected row above uses for the same
        // reason, and the slot is excluded from the card total, so saying so
        // here keeps the row and the total telling one story.
        return '<div class="lu-row lu-row--empty">'
          + `<span class="lu-slot">${esc(label)}</span>`
          + '<span class="lu-name" style="font-weight:600;color:var(--muted)">— no eligible player — '
            + '<span class="lu-meta">EMPTY · NOT IN THE TOTAL</span></span>'
          + '<span class="lu-pts" style="color:var(--muted)">—</span>'
          + '</div>';
      }
      const byeTag = r.onBye ? ' <span class="lu-bye" title="On bye this week">BYE</span>' : '';
      const chip = renderAvailChip(r.avail, { sm: true });
      const forced = forcedSlots.has(slot);
      return (
        `<div class="lu-row${r.onBye ? ' lu-row--bye' : ''}${forced ? ' lu-row--forced' : ''}">`
        + `<span class="lu-slot">${esc(label)}</span>`
        + `<span class="lu-name">${esc(r.name)}${byeTag}${chip ? ` ${chip}` : ''}${kdstTags(r)} `
          + `<span class="lu-meta">${esc(r.pos)} · <span style="color:${teamTint(r.team)}">${esc(r.team)}</span></span></span>`
        + ptsCellHtml(r)
        + '</div>'
      );
    }).join('');

    // A number that leaves components out must say which. One footnote per
    // distinct omitted key, naming the players whose totals it affects — a
    // PARTIAL badge with nothing behind it is a shrug, not a disclosure.
    const startedRows = optimal.slotIds
      .map((s) => optimal.slots[s]).filter(Boolean)
      .map((id) => rowById.get(id)).filter((r) => r && r.kdst && r.kdst.partial);
    const omittedByKey = new Map();
    for (const r of startedRows) {
      for (const o of r.kdst.omitted) {
        if (!omittedByKey.has(o.key)) omittedByKey.set(o.key, { ...o, who: [] });
        omittedByKey.get(o.key).who.push(r.name);
      }
    }
    const partialHtml = omittedByKey.size === 0 ? '' : (
      '<div class="lu-partial">'
      + '<div class="lu-partial-head">PARTIAL SCORING · MARKED * ABOVE</div>'
      + `<div class="lu-partial-body">Your league scores ${omittedByKey.size === 1 ? 'a component' : `${omittedByKey.size} components`} `
      + 'this feed cannot measure, so the D/ST total above is INCOMPLETE — it is not a zero for '
      + `${omittedByKey.size === 1 ? 'that component' : 'those components'}, it simply leaves `
      + `${omittedByKey.size === 1 ? 'it' : 'them'} out.</div>`
      + [...omittedByKey.values()].map((o) => (
        '<div class="lu-partial-key"><b>' + esc(o.label) + '</b> '
        + `<span class="lu-meta">${fix1(o.points_per)} pts each · ${esc(o.who.join(', '))}</span>`
        + `<div class="lu-partial-why">${esc(o.reason)}</div></div>`
      )).join('')
      + '</div>'
    );

    // K/DST are season averages, and the card says so once in prose as well as
    // once per row, because the badge alone does not explain what it means.
    const kdstStarted = optimal.slotIds
      .map((s) => optimal.slots[s]).filter(Boolean)
      .map((id) => rowById.get(id)).filter((r) => r && r.kdst);
    const kdstNote = kdstStarted.length === 0 ? '' : (
      '<div class="lu-kdstnote">'
      + `${kdstStarted.length === 1 ? 'The K/DST row' : `The ${kdstStarted.length} K/DST rows`} above `
      + `${kdstStarted.length === 1 ? 'is' : 'are'} a flat season average — `
      + `${esc(String(kdst.games))}-game projection ÷ ${esc(String(kdst.games))} games. `
      + 'No weekly split or opponent adjustment exists for these positions, so the number is the '
      + 'same every week except a bye. Treat it as a baseline, not a matchup call.</div>'
    );

    // Start/sit moves — honest net gain of going optimal, with the START set
    // (each into the slot it fills) and the SIT set. No misleading 1:1 pairing:
    // an incoming WR and an outgoing RB don't compete, only the net matters.
    const slotOf = (id) => optimal.slotIds.find((s) => optimal.slots[s] === id) || 'FLEX';

    // "This player is unavailable — X starts instead." Availability is WHY, points
    // are HOW MUCH, so the reason is rendered above the net-gain line. One note per
    // sit caused by unavailability, mapped through the manager's own slot.
    const mgrSlotOf = new Map();
    for (const s of leagueSlots.starters) {
      const sid = slots[s]; if (sid) mgrSlotOf.set(String(sid), s);
    }
    const swapNotes = moves.sit
      .map((outId) => {
        const out = rowById.get(outId);
        if (!out || out.avail.playable !== false || !out.avail.phrase) return '';
        const mgrSlot = mgrSlotOf.get(String(outId));
        const inId = mgrSlot ? optimal.slots[mgrSlot] : null;
        if (!inId || inId === outId) return '';
        const inRow = rowById.get(inId);
        return (
          '<div class="lu-swapnote"><span class="av-glyph" aria-hidden="true">⊘</span>'
          + `<b>${esc(out.name)}</b> ${esc(out.avail.phrase)} — `
          + `<b>${esc(inRow ? inRow.name : inId)}</b> starts at ${esc(mgrSlot)} instead.</div>`
        );
      }).join('');

    // The slots this app cannot speak to. Said in words, in the same card that
    // claims a lineup is optimal, because "optimal" over seven of nine slots is
    // only true if the other two are named out loud.
    const unprojNames = [...new Set(unprojected.map((wn) => slotLabel(wn.slot)))];
    const unprojNote = unprojected.length === 0 ? '' : (
      '<div class="lu-unproj" style="padding:10px 14px;border-bottom:1px solid var(--border);'
      + 'font-family:var(--sans);font-size:13px;line-height:1.45;color:var(--muted)">'
      + `<b style="color:var(--ink);font-weight:700">${esc(unprojNames.join(' · '))}</b> `
      + `${unprojected.length === 1 ? 'is a slot' : `are ${unprojected.length} slots`} your league starts that `
      + 'this app cannot put a number on — '
      + (unprojNames.every((n) => unscoredPos.has(n))
        ? (unprojNames.length === 1
          ? 'your scoring table pays for nothing that position produces'
          : 'your scoring table pays for nothing those positions produce')
        : `no projection exists for ${unprojNames.length === 1 ? 'it' : 'them'}`)
      + '. '
      + `${unprojected.length === 1 ? 'That slot is' : 'Those slots are'} yours to set, and `
      + `${unprojected.length === 1 ? 'it adds' : 'they add'} nothing to the total above.</div>`
    );

    // The slots this app CAN speak to and the roster cannot fill. Same reason
    // the note above exists: a lineup with an empty starting slot is not
    // "optimal", it is incomplete, and the card may not claim otherwise merely
    // because there was no better arrangement of the players that do exist.
    const emptyNames = [...new Set(emptySlots.map(slotLabel))];
    const emptyNote = emptySlots.length === 0 ? '' : (
      '<div class="lu-emptynote" style="padding:10px 14px;border-bottom:1px solid var(--border);'
      + 'font-family:var(--sans);font-size:13px;line-height:1.45;color:var(--muted)">'
      + `<b style="color:var(--ink);font-weight:700">${esc(emptyNames.join(' · '))}</b> `
      + `${emptySlots.length === 1 ? 'is a starting slot' : `cover ${emptySlots.length} starting slots`} `
      + 'your league fields that nothing on your roster can fill. '
      + `${emptySlots.length === 1 ? 'It is' : 'They are'} empty, and `
      + `${emptySlots.length === 1 ? 'it adds' : 'they add'} nothing to the total above — `
      + `add ${emptySlots.length === 1 ? 'a player' : 'players'} on the `
      + '<a href="#/team">Team</a> tab.</div>'
    );

    // What the word "optimal" is allowed to cover: the projected slots that
    // actually hold somebody. An unprojected slot was already excluded; an
    // EMPTY one has to be too, or the tick claims a lineup that isn't there.
    const claimed = optimal.projectedSlots - emptySlots.length;
    let claimScope;
    if (emptySlots.length) {
      claimScope = `${claimed} filled slot${claimed === 1 ? '' : 's'} ${claimed === 1 ? 'is' : 'are'}`;
    } else if (unprojected.length) {
      claimScope = `${optimal.projectedSlots} projected slots are`;
    } else {
      claimScope = 'starting lineup is';
    }

    let movesHtml;
    if (moves.start.length === 0 && warnings.length === 0) {
      movesHtml = unprojNote + emptyNote
        + `<div class="lu-optimal">✓ Your ${claimScope}`
        + ' already optimal for Week ' + wk + '.</div>';
    } else if (moves.start.length === 0) {
      // There is nothing better to do, but "optimal" would be a lie over a lineup
      // containing a player who cannot take a snap. Say what is actually true.
      const n = warnings.length;
      movesHtml = unprojNote + emptyNote + swapNotes
        + `<div class="lu-optimal lu-gap">Your lineup is the best your roster allows this week, but `
        + `${n} slot${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} filled by `
        + `${n === 1 ? 'a player' : 'players'} who can’t play.</div>`;
    } else {
      const startRows = moves.start.map((id) => {
        const r = rowById.get(id);
        return `<div class="lu-move"><span class="lu-move-in">START <b>${esc(r ? r.name : id)}</b> `
          + `<span class="lu-meta">${esc(slotLabel(slotOf(id)))} · ${fix1(r ? r.pts : 0)}</span></span></div>`;
      }).join('');
      const sitRows = moves.sit.map((id) => {
        const r = rowById.get(id);
        return `<div class="lu-move lu-move--sit"><span class="lu-move-out">SIT ${esc(r ? r.name : id)} `
          + `<span class="lu-meta">${fix1(r ? r.pts : 0)}</span></span></div>`;
      }).join('');
      // ONE sentence, ONE element. .lu-move is a three-column grid (START name |
      // meta | pts), and this row's three child nodes — the lead-in text, the
      // <b> gain and the trailing " this week." — were being laid out as three
      // GRID CELLS, so the sentence read "Switching to the optimal   +8.8 pts
      // this week. / lineup adds" across the phone width. Wrapping it makes it a
      // single grid item, and .lu-move--net drops to block flow (theme.css), so
      // it wraps as prose like any other sentence.
      movesHtml = unprojNote + emptyNote + swapNotes
        + '<div class="lu-move lu-move--net"><span class="lu-move-net-txt">'
        + 'Switching to the optimal lineup adds '
        + `<b class="lu-move-gain">+${fix1(moves.netGain)} pts</b> this week.</span></div>`
        + startRows + sitRows;
    }

    // Bench (non-starters), sorted by this week's projection.
    const benchHtml = optimal.bench
      .map((id) => rowById.get(id))
      .filter(Boolean)
      .sort((a, b) => b.pts - a.pts)
      .map((r) => {
        // An unavailable bench player is a fact, not a task — same recede as a bye.
        const chip = renderAvailChip(r.avail, { sm: true });
        const un = r.avail.playable === false ? ' lu-row--unavail' : '';
        return (
          `<div class="lu-row lu-row--bench${un}">`
          + `<span class="lu-slot">BN</span>`
          + `<span class="lu-name">${esc(r.name)}${r.onBye ? ' <span class="lu-bye">BYE</span>' : ''}${chip ? ` ${chip}` : ''}${kdstTags(r)} `
            + `<span class="lu-meta">${esc(r.pos)} · <span style="color:${teamTint(r.team)}">${esc(r.team)}</span></span></span>`
          + `<span class="lu-pts">${ptsCell(r)}</span>`
          + '</div>'
        );
      }).join('');

    // The total is a total OF SOMETHING — say of what. The count is READ OFF the
    // lineup that was actually built, never asserted: it was "7 of 9" when K/DST
    // had no feed, it is "all 9" now that they do, and it goes back the instant
    // the feed does. Complete coverage reads as complete rather than as a ratio
    // a manager has to check.
    // ...and a total that is complete in COVERAGE can still be incomplete in
    // ARITHMETIC. "all 9 slots projected" beside a D/ST whose own row admits it
    // omits three scoring components made the card's two most prominent numbers
    // both read as complete while the body said otherwise. The qualifications
    // now ride on the same line as the claim: EMPTY slots (fed, but nobody on
    // the roster fills them) and PARTIAL rows (a summand that leaves components
    // out). Absent either, the string is byte-for-byte what it always was.
    const coverage = [
      optimal.projectedSlots >= optimal.slotCount
        ? `all ${optimal.slotCount} slot${optimal.slotCount === 1 ? '' : 's'} projected`
        : `${optimal.projectedSlots} of ${optimal.slotCount} slots projected`,
      ...(emptySlots.length ? [`${emptySlots.length} EMPTY`] : []),
      ...(startedRows.length ? [`${startedRows.length} PARTIAL`] : []),
    ].join(' · ');

    body.innerHTML =
      '<section class="card lu-card">'
        // The title is its OWN flex item. As a bare text node beside .lu-total it
        // was an ANONYMOUS flex item the container could break mid-phrase, and at
        // 402px it did: "OPTIMAL LINEUP · WEEK" on one line with the "1" orphaned
        // onto the next, beside the total. One element + nowrap (theme.css) means
        // the phrase either fits or pushes the total to its own line, whole.
        + `<div class="m-head"><span class="lu-title">OPTIMAL LINEUP · WEEK ${wk}</span> `
          + `<span class="lu-total">${fix1(optimal.total)} pts`
          + '<span class="lu-cover" style="display:block;font-family:var(--sans);font-weight:600;'
            + 'font-size:11px;letter-spacing:0.02em;color:var(--muted);text-align:right">'
          + `${esc(coverage)}</span></span></div>`
        + forcedHtml
        + starterHtml
        + partialHtml
        + kdstNote
      + '</section>'
      + '<section class="card lu-card">'
        + '<div class="m-head">START / SIT MOVES</div>'
        + movesHtml
      + '</section>'
      + '<section class="card lu-card">'
        + '<div class="m-head">BENCH</div>'
        + (benchHtml || '<div class="state">No bench players.</div>')
      + '</section>'
      + '<div class="lu-foot"><a class="lu-compare" href="#/compare">⚖ Compare two players →</a></div>';
  }

  wireWeekBar(el, paint);
  paint(currentWk);
}

function weekBar(active) {
  let out = '<div class="wkbar lu-wkbar" role="tablist" aria-label="Week">';
  for (let w = 1; w <= WEEKS; w += 1) {
    const on = w === active;
    out += `<button type="button" class="wk-chip${on ? ' wk-chip--active' : ''}" `
      + `data-wk="${w}" role="tab" aria-selected="${on ? 'true' : 'false'}">WK ${w}</button>`;
  }
  return out + '</div>';
}

function wireWeekBar(el, paint) {
  const bar = el.querySelector('.lu-wkbar');
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.wk-chip');
    if (!btn) return;
    const wk = Number(btn.dataset.wk);
    bar.querySelectorAll('.wk-chip').forEach((b) => {
      const on = Number(b.dataset.wk) === wk;
      b.classList.toggle('wk-chip--active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    paint(wk);
  });
}
