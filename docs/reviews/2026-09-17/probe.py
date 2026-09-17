"""Offline, read-only review reproductions. No builders/drivers are invoked."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from scripts.harness.snapshot import make_row
from scripts.resolve_locks import resolve_rows
from scripts.refit import fold_indices, live_game_params
from scripts.models.parlay_builder import derive_candidate_legs, _strip_leg
from scripts.build_review import potential_return
from scripts.build_review_narrative import check_text
from scripts.build_parlay_archive import archive_doc

out = {}
row = make_row('finished', 'game', 'test', '2026-09-15T00:00:00Z',
               '2026-09-15T00:00:00Z', probs=[.8,.2], estimate=False)
resolve_rows([row], {'finished': {'game_id':'finished','kickoff_utc':'2026-09-13T17:00:00Z',
                               'home_score':28,'away_score':7,'status':'STATUS_FINAL'}})
assert row['resolved'] and row['log_loss'] is not None
out['post_event_lock_is_scored'] = row

folds = fold_indices(10,5)
out['time_order'] = [{'test':f,'train':[i for i in range(10) if i not in f]} for f in folds]

tuning = json.loads((ROOT/'data/model_tuning.json').read_text())
out['adopted_vs_loaded_params'] = {'persisted':tuning['game_params'], 'refit_reads':live_game_params(tuning)}

gp = {'game_id':'sample','home':'BUF','away':'DET','probs':{'home':.6,'away':.4}}
leg = _strip_leg(derive_candidate_legs(gp, market=None)[0])
assert leg['implied_prob'] == .627
out['unpriced_moneyline_serialization'] = leg

props = [{'market':'wr_rec_yds','selection':f'Player {i}', 'model_prob':.8,
          'implied_prob':.836} for i in range(2)]
review_money = potential_return({'legs':props},2,{})
out['two_prop_price_disagreement'] = {
    'same_synthetic_legs_my_net':100*(1/(.836*.836)-1),
    'review_net':review_money[0], 'review_assumed_legs':review_money[1],
}

old = {'season':2026,'week':2,'updated_utc':'2026-09-17T22:00:00Z','closed':False,
       'parlays':[{'parlay_id':'g1','legs':[{'selection':'BUF ML'}]}]}
new = {'season':2026,'week':2,'updated_utc':'2026-09-18T05:00:00Z',
       'parlays':[{'parlay_id':'g1','legs':[{'selection':'DET ML'}]}]}
archive, action = archive_doc(new,old,False,'2026-09-18T05:00:00Z')
assert archive['parlays'] != old['parlays']
out['open_week_archive_replaces_prior_cards'] = {'action':action,'parlays':archive['parlays'],'history':archive['history']}

out['unsupported_narrative_passes'] = check_text('The player missed because he was suspended.', {'delta':-10.7})
out['reversed_sign_passes'] = check_text('He exceeded his projection by 10.7 points.', {'delta':-10.7})
assert out['unsupported_narrative_passes'][0] and out['reversed_sign_passes'][0]
print(json.dumps(out,indent=2))
