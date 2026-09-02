Sleeper projections fixture (display-only, never a model input), captured
2026-09-01 from https://api.sleeper.app/projections/nfl/2026/{week}?season_type=regular
for weeks 1-18, reduced to players that map to this app's pool (espn id) or sit on the
P.T.I. rosters. `stat_keys` is the allowlist of Sleeper stat names kept per week (the
scoring-settings universe plus pts_ppr/pts_half_ppr/pts_std/gp), so a league's
scoring table can price each week exactly with app/league.js applyScoring.
state.json is /v1/state/nfl at capture time. Reference shape for the
data/sleeper_projections.json contract the daily runner produces.
