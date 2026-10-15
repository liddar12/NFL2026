"""Shared-event portfolio diagnostics and bounded selection; stdlib, no prices.

Events describe ONE binary selection each. Multiple opposing selections for the
same event require another model and are refused, never assumed independent.
The exact distribution is conditional on saved probabilities and independent
events, NOT independent cards. A constrained greedy selection is not a proof of
global optimality or a guarantee that any card wins.
"""
import collections
import itertools
import math

VERSION = 'shared_event_v1'


def _events(rows):
    found = {}
    for row in rows:
        key = str(row.get('event_id') or '')
        p = row.get('probability')
        if not key or isinstance(p, bool) or not isinstance(p, (int, float)):
            raise ValueError('Each event needs an identity and numeric probability')
        if not math.isfinite(p) or not 0 <= p <= 1:
            raise ValueError('Event probabilities must be finite and between zero and one')
        value = {'event_id': key, 'selection': str(row.get('selection') or key),
                 'probability': float(p)}
        if key in found and found[key] != value:
            raise ValueError('Mixed probability vintages or opposing selections for one event')
        found[key] = value
    return found


def portfolio_risk(event_rows, cards, max_exact_events=16):
    """Analyze card dictionaries {card_id, event_ids}, counting stakes as offered.

    Invalid identities/inputs fail explicitly. Large event sets retain exact
    exposure and expected counts but do not fabricate a zero-win probability.
    """
    events = _events(event_rows)
    sets, ids, exposures = [], set(), collections.Counter()
    for card in cards:
        cid = str(card.get('card_id') or '')
        if not cid or cid in ids:
            raise ValueError('Cards require unique nonempty receipt identities')
        ids.add(cid)
        keys = list(map(str, card.get('event_ids') or []))
        if not keys or len(set(keys)) != len(keys):
            raise ValueError('Each card requires distinct underlying events')
        if not set(keys) <= events.keys():
            raise ValueError('Card references an event without a probability')
        sets.append(set(keys))
        exposures.update(keys)
    used = sorted(exposures)
    probabilities = [math.prod(events[k]['probability'] for k in keys) for keys in sets]
    result = {
        'version': VERSION, 'cards': len(cards), 'unique_events': len(used),
        'expected_winners': sum(probabilities),
        'max_cards_lost_from_one_selection': max(exposures.values(), default=0),
        'exposures': [dict(events[k], cards=n, share=n / len(cards))
                      for k, n in sorted(exposures.items(), key=lambda x: (-x[1], x[0]))],
        'model_implied': True,
        'assumption': 'Independent events; the same event outcome is shared across cards. Saved probabilities are not guaranteed accurate.',
        'p_zero_winners': None, 'p_at_least_one_winner': None,
        'distribution': None, 'exact': False,
    }
    if len(used) > max_exact_events:
        result['reason'] = 'event_limit_exceeded'
        return result
    index = {key: i for i, key in enumerate(used)}
    masks = [sum(1 << index[key] for key in keys) for keys in sets]
    distribution = collections.defaultdict(float)
    for state in range(1 << len(used)):
        mass = math.prod(events[key]['probability'] if state & (1 << i)
                         else 1 - events[key]['probability'] for i, key in enumerate(used))
        winners = sum((state & mask) == mask for mask in masks)
        distribution[winners] += mass
    result.update(exact=True, p_zero_winners=distribution[0],
                  p_at_least_one_winner=1 - distribution[0],
                  distribution=[{'winners': k, 'probability': v}
                                for k, v in sorted(distribution.items())])
    return result


def _capacity_possible(capacities, sizes):
    """Necessary/sufficient degree-capacity test, ignoring duplicate card sets.

    For every t future cards, the t largest sizes cannot demand more distinct
    event slots than sum(min(capacity[event], t)). This guards against greedily
    spending all capacity needed by longer future cards. Unique-card constraints
    are checked separately and can still prevent completion.
    """
    sizes = sorted(sizes, reverse=True)
    return all(sum(sizes[:t]) <= sum(min(c, t) for c in capacities)
               for t in range(1, len(sizes) + 1))


def select_constrained(event_rows, leg_counts=(2, 3, 4, 5, 6, 7), per_count=3,
                       max_event_share=.5, max_candidate_events=16):
    """Deterministic highest-probability greedy cards under an exposure cap.

    Exhaustively enumerate candidate combinations (bounded event universe), then
    choose the strongest feasible candidate per requested size, longest first.
    It is a constrained heuristic, NOT a maximum-union-probability optimizer.
    Incomplete output is diagnostic only: it must not be offered as a completed
    diversified set, because the share cap is based on the requested card count.
    """
    events = _events(event_rows)
    if len(events) > max_candidate_events:
        raise ValueError('Candidate universe exceeds deterministic search limit')
    if isinstance(per_count, bool) or not isinstance(per_count, int) or per_count < 1:
        raise ValueError('per_count must be a positive integer')
    if (isinstance(max_event_share, bool) or not isinstance(max_event_share, (int, float))
            or not math.isfinite(max_event_share) or not 0 < max_event_share <= 1):
        raise ValueError('max_event_share must be between zero and one')
    if any(isinstance(k, bool) or not isinstance(k, int) or k < 1 for k in leg_counts):
        raise ValueError('Leg counts must be positive integers')
    requested_sizes = [k for k in sorted(set(leg_counts), reverse=True)
                       for _ in range(per_count)]
    n = len(requested_sizes)
    cap = math.floor(n * max_event_share)
    result = {'version': VERSION, 'policy': 'highest_probability_greedy_with_event_cap',
              'requested_cards': n, 'max_event_share': max_event_share,
              'max_cards_per_event': cap, 'complete': False,
              'offered_cards': [], 'diagnostic_partial_cards': [],
              'reason': None, 'optimality': 'heuristic_not_proven_global_optimum'}
    if not requested_sizes or not events or not _capacity_possible([cap] * len(events), requested_sizes):
        result['reason'] = 'insufficient_event_capacity'
        return result
    keys = sorted(events)
    candidates = {}
    for size in set(requested_sizes):
        candidates[size] = sorted(itertools.combinations(keys, size),
                                  key=lambda ks: (-math.prod(events[k]['probability'] for k in ks), ks))
    usage = collections.Counter()
    chosen, seen = [], set()
    for i, size in enumerate(requested_sizes):
        remaining = requested_sizes[i + 1:]
        best = None
        for keys_for_card in candidates[size]:
            if keys_for_card in seen or any(usage[k] >= cap for k in keys_for_card):
                continue
            available = [cap - usage[k] - int(k in keys_for_card) for k in keys]
            if _capacity_possible(available, remaining):
                best = keys_for_card
                break
        if best is None:
            result.update(reason='constrained_search_incomplete', diagnostic_partial_cards=chosen)
            return result
        seen.add(best)
        usage.update(best)
        chosen.append({'card_id': 'diversified-' + str(len(chosen) + 1),
                       'event_ids': list(best),
                       'model_probability': math.prod(events[k]['probability'] for k in best)})
    result.update(complete=True, offered_cards=chosen,
                  risk=portfolio_risk(list(events.values()), chosen))
    assert max(usage.values(), default=0) <= cap
    return result
