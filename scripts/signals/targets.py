"""Target / touch competition signal: the share-of-opportunity discount.

A skill player's fantasy production is gated by *opportunity* — how many targets (WR/TE)
or touches (RB) come their way. Opportunity is finite: a team throws a roughly fixed
number of passes and hands off a roughly fixed number of times per game. Every target a
teammate commands is a target this player does not get. This module quantifies how much
of a player's *potential* opportunity is removed by the teammates competing for the same
pool.

`target_competition(player_share, teammate_shares)` returns a dict:
    {
      "opportunity_share": float,   # this player's share of the contested pool (0..1)
      "competition_index": float,   # how crowded the pool is (0 == uncontested)
      "multiplier": float           # adjustment around 1.0 to apply to the baseline
    }

The multiplier is the value the projection engine consumes. It is centered on 1.0 at an
"expected" level of competition so that an average target-competition environment is
neutral, an *unusually crowded* room is a discount (< 1.0), and an *unusually thin* room
(a clear alpha, few mouths to feed) is a small premium (> 1.0).

Stdlib only, deterministic, no I/O.
"""

# The share a "typical" featured skill player commands of the contested pool. We center
# the multiplier on this so an average situation is neutral (1.0). E.g. a clear WR1 might
# see ~28% of team targets; a lead back ~55-65% of RB touches. We use a single generic
# reference and let the caller pass shares already normalized to the relevant pool.
_REFERENCE_SHARE = 0.28

# How hard the multiplier reacts to being above/below the reference share. A player who
# commands double the reference share doesn't get double the projection — usage has
# diminishing marginal fantasy value (defenses key on volume hogs) — so we keep the
# sensitivity gentle and bounded.
_SENSITIVITY = 0.6
_MAX_PREMIUM = 0.15   # cap the upside of a thin room
_MAX_DISCOUNT = 0.30  # crowded rooms can bite harder than thin rooms help


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def target_competition(player_share, teammate_shares):
    """Compute the opportunity-competition adjustment for one player.

    player_share    : this player's share of the contested pool (0..1). If None, we
                      derive it as the residual after teammates (1 - sum(teammates)),
                      floored at 0.
    teammate_shares : iterable of teammate shares of the SAME pool (targets for
                      pass-catchers, touches for backs). May be empty.

    All shares should reference the same pool and ideally sum to <= 1. We normalize
    defensively if they overflow.
    """
    tm = [float(s) for s in (teammate_shares or []) if s is not None and s > 0.0]
    teammate_total = sum(tm)

    if player_share is None:
        # Infer the player's share as whatever opportunity the teammates leave behind.
        player_share = max(0.0, 1.0 - teammate_total)
    else:
        player_share = float(player_share)

    total = player_share + teammate_total
    if total <= 0.0:
        # No usable information -> neutral.
        return {"opportunity_share": 0.0, "competition_index": 0.0, "multiplier": 1.0}

    # Normalize so the pool sums to 1 (guards against inputs that overflow 1.0).
    opportunity_share = player_share / total

    # Competition index: 1 - own_share == the fraction of the pool the field takes.
    # 0 == this player is the entire pool (no competition); ->1 == heavily contested.
    competition_index = 1.0 - opportunity_share

    # Center on the reference share. Above reference -> premium; below -> discount.
    delta = (opportunity_share - _REFERENCE_SHARE) * _SENSITIVITY
    multiplier = 1.0 + _clamp(delta, -_MAX_DISCOUNT, _MAX_PREMIUM)

    return {
        "opportunity_share": opportunity_share,
        "competition_index": competition_index,
        "multiplier": multiplier,
    }
