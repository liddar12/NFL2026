/* app/availability.js — PURE player-availability presentation (no DOM, no fetch
 * at import). Rel17.
 *
 * THE ONE THING THIS MODULE DOES NOT DO: normalize. The app receives already-
 * canonical codes on data/player_weekly.json (`players[].availability.status`),
 * so a JS copy of ESPN's string table would be a mirror with nothing to mirror —
 * precisely the drift this release removes. Normalization lives once, in the
 * pipeline (scripts/availability.py). Here we only decide what a manager SEES.
 *
 * Canonical vocabulary (SOLUTION_DESIGN §1.1):
 *   ACTIVE · QUESTIONABLE · DOUBTFUL · OUT · IR · PUP · NFI · SUSPENDED
 *
 * Two mechanic classes ride along with it:
 *   week   — QUESTIONABLE / DOUBTFUL / OUT: this-week shaping, season total kept.
 *   season — IR / PUP / NFI / SUSPENDED (or a parsed season-ending duration):
 *            the affected weeks are actually zeroed and the season total drops.
 *
 * HONEST DATA, mechanically:
 *   - a duration is NEVER invented. No `~`, no `TBD`, no zero. When the pipeline
 *     parsed nothing, the chip carries a status and no number;
 *   - a number NEVER renders without its provenance tag (REPORT = parsed from a
 *     team report, LEAGUE MIN = the league's rule floor, not a measurement). If a
 *     duration ever arrives without a confidence, we drop the DURATION, not the
 *     provenance — a bare number is the exact failure mode F5 created;
 *   - an availability block that is absent (older deploy, or a build that predates
 *     the pipeline) degrades to "no chip, playable" so every view renders exactly
 *     as it does today. Absence of data is never rendered as a claim.
 */

export const AVAIL_CODES = Object.freeze([
  'ACTIVE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'IR', 'PUP', 'NFI', 'SUSPENDED',
]);

/** Codes whose meaning is "he is not playing" — chip tone `out`. */
const NOT_PLAYING = Object.freeze(['OUT', 'IR', 'PUP', 'NFI', 'SUSPENDED']);
/** Codes whose meaning is "your call" — chip tone `watch`. */
const WATCH = Object.freeze(['QUESTIONABLE', 'DOUBTFUL']);
/** Season-class codes (multi-week absence), mirroring SEASON_CLASS in the pipeline. */
const SEASON_CODES = Object.freeze(['IR', 'PUP', 'NFI', 'SUSPENDED']);

const CODE_SET = new Set(AVAIL_CODES);
const OUT_SET = new Set(NOT_PLAYING);
const WATCH_SET = new Set(WATCH);
const SEASON_SET = new Set(SEASON_CODES);

/* Chip labels. ACTIVE deliberately has none: a green badge on 673 of 800 players
 * is noise that trains managers to stop reading chips (UX_DESIGN §1). */
const LABEL = {
  QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'OUT',
  IR: 'IR', PUP: 'PUP', NFI: 'NFI', SUSPENDED: 'SUSP',
};

/* Every abbreviation is spelled out in `title` so the code is never the only
 * affordance (accessibility checklist item 5). */
const FULL = {
  ACTIVE: 'Active', QUESTIONABLE: 'Questionable', DOUBTFUL: 'Doubtful', OUT: 'Out',
  IR: 'Injured Reserve', PUP: 'Physically Unable to Perform',
  NFI: 'Non-Football Injury', SUSPENDED: 'Suspended',
};

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Positive integer week count, or null. Never coerces junk into a number. */
function weekCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return (i >= 1 && i <= 18) ? i : null;
}

/** The neutral result: no chip, no claim, playable. */
function healthy(playable) {
  return {
    status: null, cls: null, playable: playable !== false, applies: false,
    weeksOut: null, outForSeason: false, confidence: null, evidence: null,
    label: '', tone: '', glyph: '', durText: '', provText: '', title: '', phrase: '',
  };
}

/**
 * What the manager should see for ONE player in ONE week.
 *
 *   weeklyPlayerRow — a data/player_weekly.json players[] entry (or null).
 *   wk              — the week being rendered.
 *   currentWk       — the live week (an OUT designation is this-week news).
 *
 * Returns { status, cls, playable, weeksOut, outForSeason, confidence, evidence,
 *           label, tone, glyph, durText, provText, title, phrase }.
 *
 * `playable === false` iff the week row carries `avail === false` (the applied
 * consequence the pipeline wrote) OR the player is OUT for the CURRENT week (an
 * OUT zeroes nothing in the split — it is a designation, not a duration).
 * Everything else, including QUESTIONABLE/DOUBTFUL and a SUSPENDED of unknown
 * length, stays playable: that is a start/sit judgement the manager makes, and
 * the chip is how the app tells him.
 */
export function availabilityOf(weeklyPlayerRow, wk, currentWk) {
  const w = weeklyPlayerRow || null;
  const weeks = (w && Array.isArray(w.weeks)) ? w.weeks : [];
  const wkNum = Number(wk);
  const entry = weeks.find((x) => Number(x.wk) === wkNum) || null;
  const blocked = !!(entry && entry.avail === false);

  const a = (w && w.availability && typeof w.availability === 'object') ? w.availability : null;
  if (!a) return healthy(!blocked);

  const raw = String(a.status || '').toUpperCase();
  // An UNKNOWN code is not ACTIVE and is not invented into a label either: we
  // honour the applied consequence (`avail:false` still benches him) and render
  // no claim we cannot back. A drifted vocabulary is caught loudly at the gate,
  // which is where SOLUTION_DESIGN §1.2 puts that job.
  if (!CODE_SET.has(raw)) return healthy(!blocked);
  if (raw === 'ACTIVE') return healthy(!blocked);

  const cls = (a.class === 'week' || a.class === 'season')
    ? a.class
    : (SEASON_SET.has(raw) ? 'season' : 'week');

  const outForSeason = a.out_for_season === true;
  // `rule_minimum` is the older spelling in UX_DESIGN; SOLUTION_DESIGN §5.1 settles
  // on `rule`. Accept both so a contract written to either doc renders correctly.
  let confidence = null;
  if (a.confidence === 'explicit') confidence = 'explicit';
  else if (a.confidence === 'rule' || a.confidence === 'rule_minimum') confidence = 'rule';

  let weeksOut = weekCount(a.weeks_out);
  // A number with no provenance is worse than no number. Drop the number.
  if (weeksOut != null && !confidence) weeksOut = null;

  const evidence = (typeof a.evidence === 'string' && a.evidence.trim())
    ? a.evidence.trim() : null;

  const isCurrent = Number.isFinite(Number(currentWk)) && wkNum === Number(currentWk);
  const playable = !(blocked || (raw === 'OUT' && isCurrent));

  // DOES THIS STATUS APPLY TO THE WEEK BEING RENDERED?
  // A three-game suspension is a fact about weeks 1-3, not about week 9. Showing
  // "⊘ SUSP · 3 WKS" beside a week-9 row that projects real points and starts him
  // says "he can't play" about a week he can — the same class of lie as the
  // un-haircut projection. So:
  //   season class — the chip rides the BLOCKED weeks the pipeline actually wrote;
  //   week class   — Q/D/OUT are this-week news and show on the current week.
  // The one exception is a season-class status that blocked nothing at all (a
  // suspension of unannounced length): we do not know when he plays, so the flag
  // must still be visible on the current week rather than vanish.
  const anyBlocked = weeks.some((x) => x && x.avail === false);
  const applies = cls === 'season'
    ? (blocked || (!anyBlocked && isCurrent))
    : (blocked || isCurrent);

  const tone = applies ? (OUT_SET.has(raw) ? 'out' : (WATCH_SET.has(raw) ? 'watch' : '')) : '';
  const glyph = tone === 'out' ? '⊘' : (tone === 'watch' ? '⚠' : '');

  // SEASON beats a number: a manager reads "season" as drop-or-IR-stash, which is
  // the actual decision. The `+` is load-bearing — it separates a reported four
  // from the league's floor of four.
  let durText = '';
  if (outForSeason) durText = '· SEASON';
  else if (weeksOut != null) durText = confidence === 'rule' ? `· ${weeksOut}+ WKS` : `· ${weeksOut} WKS`;

  let provText = '';
  if (durText) provText = confidence === 'explicit' ? 'REPORT' : (confidence === 'rule' ? 'LEAGUE MIN' : '');

  return {
    status: raw,
    cls,
    playable,
    weeksOut,
    outForSeason,
    confidence,
    evidence,
    applies,
    label: applies ? (LABEL[raw] || '') : '',
    tone,
    glyph,
    durText,
    provText,
    title: titleFor(raw, outForSeason, weeksOut, confidence),
    phrase: phraseFor(raw, outForSeason, weeksOut, confidence),
  };
}

/** Spelled-out tooltip. Copy set is UX_DESIGN §11, verbatim where it applies. */
function titleFor(code, outForSeason, weeksOut, confidence) {
  const full = FULL[code] || code;
  if (code === 'QUESTIONABLE') return 'Questionable — game-time decision';
  if (code === 'DOUBTFUL') return 'Doubtful — expected to sit';
  if (code === 'OUT') return 'Ruled out this week';
  if (outForSeason) return `${full} — reported out for the season`;
  if (weeksOut != null && confidence === 'explicit') {
    return code === 'SUSPENDED'
      ? `Suspended — ${weeksOut} games per league announcement`
      : `${full} — ${weeksOut} games per report`;
  }
  if (weeksOut != null && confidence === 'rule') {
    return `${full} — league minimum ${weeksOut} games; no return date reported`;
  }
  if (code === 'SUSPENDED') return 'Suspended — length not announced';
  return `${full} — no return date reported`;
}

/**
 * Fantasy-natural prose for banners and swap notes (UX_DESIGN §4.4). "at least"
 * appears ONLY for the league-rule floor, so the sentence carries its own
 * provenance even on a phone where the LEAGUE MIN tag is hidden.
 */
function phraseFor(code, outForSeason, weeksOut, confidence) {
  const base = {
    IR: 'is on IR', PUP: 'is on the PUP list', NFI: 'is on the NFI list',
    SUSPENDED: 'is suspended', OUT: 'is ruled out this week',
    QUESTIONABLE: 'is questionable', DOUBTFUL: 'is doubtful',
  }[code] || 'is unavailable';
  if (code === 'OUT' || code === 'QUESTIONABLE' || code === 'DOUBTFUL') return base;
  if (outForSeason) {
    if (code === 'SUSPENDED') return 'is suspended for the season';
    return `is on ${code} for the season`;
  }
  if (weeksOut != null) {
    const at = confidence === 'rule' ? 'out at least' : 'out';
    if (code === 'SUSPENDED') {
      return confidence === 'rule'
        ? `is suspended for at least ${weeksOut} more weeks`
        : `is suspended for ${weeksOut} more weeks`;
    }
    return `is on ${code}, ${at} ${weeksOut} more weeks`;
  }
  return base;
}

/**
 * The shared `.av-chip` component, as an HTML string. ONE component, every
 * surface. Returns '' for null / ACTIVE / unknown input, so a view rendered
 * without availability is byte-identical to today (the renderTrendChip contract).
 *
 *   opts.sm — dense variant for lineup/bench rows (`.av-chip--sm`).
 */
export function renderAvailChip(avail, opts) {
  const a = avail || null;
  if (!a || !a.label || !a.tone) return '';
  const sm = !!(opts && opts.sm);
  const dur = a.durText ? `<span class="av-dur">${esc(a.durText)}</span>` : '';
  // .av-prov is omitted when there is no duration, and NEVER omitted when there
  // is one (UX_DESIGN §2.1).
  const prov = (a.durText && a.provText)
    ? `<span class="av-prov av-prov--${a.confidence === 'explicit' ? 'report' : 'min'}">${esc(a.provText)}</span>`
    : '';
  return (
    `<span class="av-chip${sm ? ' av-chip--sm' : ''} av-chip--${esc(a.tone)}" title="${esc(a.title)}">`
    + `<span class="av-glyph" aria-hidden="true">${esc(a.glyph)}</span>${esc(a.label)}${dur}${prov}`
    + '</span>'
  );
}

/** Tiny self-check (called by the unit test). */
export function __selftest() {
  const ir = availabilityOf(
    {
      availability: {
        status: 'IR', class: 'season', weeks_out: 4, out_for_season: false, confidence: 'rule',
      },
      weeks: [{ wk: 1, bye: false, pts: 0, avail: false }, { wk: 9, bye: false, pts: 5.1 }],
    }, 1, 1,
  );
  if (ir.playable !== false) throw new Error('IR blocked week must not be playable');
  if (ir.durText !== '· 4+ WKS') throw new Error('rule floor renders the + form');
  if (ir.provText !== 'LEAGUE MIN') throw new Error('rule floor provenance');
  if (!/at least 4 more weeks/.test(ir.phrase)) throw new Error('rule phrase says "at least"');
  // Same player, an unblocked week later in the season: he plays again.
  const back = availabilityOf(
    {
      availability: { status: 'IR', class: 'season', weeks_out: 4, confidence: 'rule' },
      weeks: [{ wk: 1, bye: false, pts: 0, avail: false }, { wk: 9, bye: false, pts: 5.1 }],
    }, 9, 1,
  );
  if (back.playable !== true) throw new Error('unblocked week is playable');
  // No availability at all (older deploy) — byte-identical to today.
  const none = availabilityOf({ weeks: [{ wk: 3, bye: false, pts: 9 }] }, 3, 3);
  if (none.playable !== true || none.label !== '' || renderAvailChip(none) !== '') {
    throw new Error('absent availability must render nothing');
  }
  // A duration with no provenance is dropped, never rendered bare.
  const bare = availabilityOf(
    { availability: { status: 'IR', class: 'season', weeks_out: 6 }, weeks: [] }, 1, 1,
  );
  if (bare.weeksOut !== null || bare.durText !== '') throw new Error('no number without provenance');
  return true;
}
