/* app/teams.js — NFL team identity registry (Broadcast Gameday marks).
 *
 * Keyed by the canonical ESPN/nflverse abbreviation. One record per team:
 *   name    short nickname shown in `.team-nm` (e.g. "Chiefs")
 *   city    metro label (unused in cards yet, kept for future headers/tooltips)
 *   tint    the team's identity color, LIGHTENED so it clears WCAG AA large-text
 *           contrast (>= 3.0:1) on `--surface` (#161B22). `.team-ab` renders the
 *           abbreviation in this tint at >=18px bold, so 3:1 (large text) suffices.
 *   stadium the home venue, used to build `.g-venue` on the game card.
 *
 * AA INVARIANT: many NFL identity colors are dark navies/greens that FAIL on a
 * dark surface. Every `tint` here has been lightened toward the token band
 * (L ~= 0.6-0.75) and is asserted >= 3.0:1 on --surface by the contrast test
 * (tests/feature/contrast_aa.test.mjs imports THIS map, so the app and the test
 * can never drift). Do not darken a tint without re-checking the test.
 */
export const TEAMS = Object.freeze({
  ARI: { name: 'Cardinals', city: 'Arizona',        tint: '#E36B82', stadium: 'State Farm Stadium' },
  ATL: { name: 'Falcons',   city: 'Atlanta',        tint: '#E8697C', stadium: 'Mercedes-Benz Stadium' },
  BAL: { name: 'Ravens',    city: 'Baltimore',      tint: '#9B8CE0', stadium: 'M&T Bank Stadium' },
  BUF: { name: 'Bills',     city: 'Buffalo',        tint: '#6FA8E8', stadium: 'Highmark Stadium' },
  CAR: { name: 'Panthers',  city: 'Carolina',       tint: '#58B6E8', stadium: 'Bank of America Stadium' },
  CHI: { name: 'Bears',     city: 'Chicago',        tint: '#F0824A', stadium: 'Soldier Field' },
  CIN: { name: 'Bengals',   city: 'Cincinnati',     tint: '#F98A5C', stadium: 'Paycor Stadium' },
  CLE: { name: 'Browns',    city: 'Cleveland',      tint: '#F58A5A', stadium: 'Huntington Bank Field' },
  DAL: { name: 'Cowboys',   city: 'Dallas',         tint: '#6FA3E0', stadium: 'AT&T Stadium' },
  DEN: { name: 'Broncos',   city: 'Denver',         tint: '#F98A5C', stadium: 'Empower Field' },
  DET: { name: 'Lions',     city: 'Detroit',        tint: '#5CB4E8', stadium: 'Ford Field' },
  GB:  { name: 'Packers',   city: 'Green Bay',      tint: '#FFCB4D', stadium: 'Lambeau Field' },
  HOU: { name: 'Texans',    city: 'Houston',        tint: '#E8697C', stadium: 'NRG Stadium' },
  IND: { name: 'Colts',     city: 'Indianapolis',   tint: '#6FA8E8', stadium: 'Lucas Oil Stadium' },
  JAX: { name: 'Jaguars',   city: 'Jacksonville',   tint: '#4CC3D4', stadium: 'EverBank Stadium' },
  KC:  { name: 'Chiefs',    city: 'Kansas City',    tint: '#F45B6B', stadium: 'Arrowhead' },
  LV:  { name: 'Raiders',   city: 'Las Vegas',      tint: '#C9CFD2', stadium: 'Allegiant Stadium' },
  LAC: { name: 'Chargers',  city: 'Los Angeles',    tint: '#5CB4E8', stadium: 'SoFi Stadium' },
  LAR: { name: 'Rams',      city: 'Los Angeles',    tint: '#FFC24D', stadium: 'SoFi Stadium' },
  MIA: { name: 'Dolphins',  city: 'Miami',          tint: '#33C4CC', stadium: 'Hard Rock Stadium' },
  MIN: { name: 'Vikings',   city: 'Minnesota',      tint: '#A98CE0', stadium: 'U.S. Bank Stadium' },
  NE:  { name: 'Patriots',  city: 'New England',    tint: '#6F9FE0', stadium: 'Gillette Stadium' },
  NO:  { name: 'Saints',    city: 'New Orleans',    tint: '#E0CFA0', stadium: 'Caesars Superdome' },
  NYG: { name: 'Giants',    city: 'New York',       tint: '#6F9FE0', stadium: 'MetLife Stadium' },
  NYJ: { name: 'Jets',      city: 'New York',       tint: '#4FC08A', stadium: 'MetLife Stadium' },
  PHI: { name: 'Eagles',    city: 'Philadelphia',   tint: '#4FBFC9', stadium: 'Lincoln Financial Field' },
  PIT: { name: 'Steelers',  city: 'Pittsburgh',     tint: '#FFCB4D', stadium: 'Acrisure Stadium' },
  SF:  { name: '49ers',     city: 'San Francisco',  tint: '#E8697C', stadium: "Levi's Stadium" },
  SEA: { name: 'Seahawks',  city: 'Seattle',        tint: '#8FD95C', stadium: 'Lumen Field' },
  TB:  { name: 'Buccaneers',city: 'Tampa Bay',      tint: '#EE6A6A', stadium: 'Raymond James Stadium' },
  TEN: { name: 'Titans',    city: 'Tennessee',      tint: '#6FB0E8', stadium: 'Nissan Stadium' },
  WAS: { name: 'Commanders',city: 'Washington',     tint: '#FFCB4D', stadium: 'Northwest Stadium' },
});
