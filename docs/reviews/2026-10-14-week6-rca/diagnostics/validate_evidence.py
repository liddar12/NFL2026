"""Validate delivered RCA arithmetic and hashes; no repository/source mutations."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = 'fb8830ae35f1e11d3f589b435e303b719886e3e7'

def read(name):
    return json.loads((ROOT / 'evidence' / name).read_text())

metrics = read('metrics.json')
provenance = read('provenance.json')
portfolio = read('portfolio.json')
learning = read('learning.json')
live = read('live_hashes.json')
injuries = read('injuries_2026-10-14.json')

assert metrics['head'] == provenance['baseline'] == portfolio['head'] == live['sha'] == BASELINE
for week, expected in enumerate([1, 1, 1, 8, 1], 1):
    row = provenance['baseline_slates'][str(week)]['before_first_game']
    assert len(row['cards']) == row['still_available'] == 18
    assert row['without_exclusions'].get('all_hit', 0) == expected
for week, expected in enumerate([0, 2, 24, 18, 23], 1):
    assert provenance['archive_provenance'][str(week)]['by_scope']['week']['exact_prices_pregame'] == expected
safe = metrics['my']['5']['by_dial']['safe']
assert (safe['n_clean'], safe['hit_clean']) == (893, 96)
assert math.isclose(safe['expected_clean'] / safe['n_clean'], .3040, abs_tol=.0001)
for week, winners, n in [(1,16,18),(2,34,73),(3,3,37),(4,8,18),(5,1,23)]:
    row = metrics['weekly'][str(week)]['by_scope']['week']
    assert (row['buckets']['all_hit'], row['n']) == (winners,n)
week5, week6 = portfolio['cohorts']
assert week5['exposures']['DAL ML'] == 17
assert week5['observed']['all_hit_original_game_outcomes'] == 1
assert week5['observed']['losing_selections'] == ['DAL ML']
assert math.isclose(week5['expected_wins'], 4.317075, abs_tol=.000001)
assert math.isclose(week5['observed']['p_wins_at_most_observed_under_saved_model'], .4158898, abs_tol=.000001)
assert week6['exposures']['SF ML'] == week6['cards'] == 18
assert math.isclose(week6['p_zero_winners_shared_games'], .1697574, abs_tol=.000001)
assert math.isclose(week6['expected_wins'], 6.328982, abs_tol=.000001)
for row in portfolio['cohorts']:
    assert math.isclose(sum(row['distribution'].values()), 1, abs_tol=1e-10)
chain = next(x for x in learning['real_probability_chain']['examples'] if x['selection']=='D. Smith 60+ rec yds')
assert math.isclose(chain['raw_base_reconstructed'], .374058, abs_tol=.000001)
assert math.isclose(chain['ledger_probability'], .5203, abs_tol=.000001)
assert math.isclose(chain['gate_applies_second_layer'], .659025, abs_tol=.000001)
cf = learning['slate_week5_same_legs_coefficient_counterfactual']
assert (cf['n'], cf['hits']) == (45,23)
assert math.isclose(cf['log_loss']['old'], .667290, abs_tol=.000001)
assert math.isclose(cf['log_loss']['new'], .660012, abs_tol=.000001)
assert len(live['rows']) == 9 and all(x['status']==200 and x['matches'] and x['expected']==x['observed'] for x in live['rows'])
assert injuries['http_status'] == 200 and sum(injuries['status_counts'].values()) == 800
assert injuries['status_gate_count'] == 34 and injuries['id_matches'] == 30
assert len(injuries['changed_to_policy_playable']) == 15
assert len(injuries['changed_to_active']) == 3
assert injuries['unknown_status_rows'][0]['status'] == 'Reserve-Ret'
manifest = read('manifest.json')
assert manifest['audit_baseline'] == BASELINE
for row in manifest['files']:
    data = (ROOT / row['path']).read_bytes()
    assert len(data) == row['bytes'], row['path']
    assert hashlib.sha256(data).hexdigest() == row['sha256'], row['path']
print(f'PASS: headline metrics, prospective cohorts, learning chain, live checks, injury evidence, and {len(manifest["files"])} file hashes.')
