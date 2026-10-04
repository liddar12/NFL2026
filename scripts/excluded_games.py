#!/usr/bin/env python3
"""R108 — the owner's excluded-games list (config/excluded_games.json), read once.

Owner, 2026-10-04: "Update all the parlays for week 4, so that the Colts vs
Washington game is not included in any bets." Chosen rule: the game's legs are
VOIDED everywhere. Every builder that offers a leg asks `is_excluded(game_id)`
and drops it; every grader turns a leg of an excluded game into a void leg
(reason "excluded_game"), so a card settles on its remaining legs and a card
made ONLY of excluded legs is dropped from tallies and $100 P&L
(`card_fully_excluded`). The list is hand-edited and reusable for any game.

An absent or unreadable file excludes nothing (and says so on stderr): a missing
owner list must never silently void a real bet.

  python3 scripts/excluded_games.py            print the list
  python3 scripts/excluded_games.py --selftest offline
"""

import argparse
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
PATH = os.path.join(_ROOT, "config", "excluded_games.json")
VOID_REASON = "excluded_game"

_CACHE = {}


def load(path=PATH):
    """{game_id(str): entry} — {} when the file is absent or unreadable."""
    if path in _CACHE:
        return _CACHE[path]
    out = {}
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        for g in doc.get("games") or []:
            if g.get("game_id"):
                out[str(g["game_id"])] = g
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as exc:
        print("[excluded_games] %s unreadable (%s) — nothing excluded" % (path, exc),
              file=sys.stderr)
    _CACHE[path] = out
    return out


def excluded_ids(path=PATH):
    return set(load(path))


def is_excluded(game_id, path=PATH):
    return game_id is not None and str(game_id) in load(path)


def card_fully_excluded(leg_game_ids, path=PATH):
    """True when the card has legs and EVERY leg belongs to an excluded game."""
    ids = [g for g in leg_game_ids]
    return bool(ids) and all(is_excluded(g, path) for g in ids)


def selftest():
    import tempfile
    d = tempfile.mkdtemp()
    p = os.path.join(d, "x.json")
    with open(p, "w") as fh:
        json.dump({"games": [{"game_id": "G1", "season": 2026, "week": 4, "matchup": "A @ B",
                              "reason": "test", "added_utc": "t"}]}, fh)
    assert is_excluded("G1", p)
    assert not is_excluded("G2", p) and not is_excluded(None, p)
    assert excluded_ids(p) == {"G1"}
    assert card_fully_excluded(["G1", "G1"], p) and not card_fully_excluded(["G1", "G2"], p)
    assert not card_fully_excluded([], p), "a card with no legs is not 'fully excluded'"
    assert load(os.path.join(d, "missing.json")) == {}, "absent file excludes nothing"
    with open(os.path.join(d, "bad.json"), "w") as fh:
        fh.write("{nope")
    assert load(os.path.join(d, "bad.json")) == {}, "unreadable file excludes nothing"
    print("selftest OK: listed games excluded, others not, a card is fully excluded only "
          "when every leg is, an absent/unreadable list excludes nothing")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        selftest()
        return 0
    for gid, g in sorted(load().items()):
        print("%s  %s wk%s  %s — %s" % (gid, g.get("season"), g.get("week"),
                                        g.get("matchup"), g.get("reason")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
