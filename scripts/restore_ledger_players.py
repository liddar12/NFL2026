#!/usr/bin/env python3
"""R103 — restore estimate-ledger records deleted before the ledger was append-only.

Until R103, scripts/build_estimate_ledger.py rebuilt `players` from the day's
projections alone, so a player who left them (IR, demoted out of the top 300)
lost his whole record, locked week estimates included — 25 players by week 3
(Thielen, Chubb, Achane, ...). The resolver can only score what the ledger holds,
so the accuracy record quietly dropped the injured and the demoted.

This restores each MISSING player's record VERBATIM from the NEWEST committed
version of the ledger that still held it (git history of the file). Nothing is
re-derived: every byte restored is what the pipeline itself wrote. A player on
the ledger is never touched (so a player who was dropped and later re-added keeps
his re-added record; the locks he lost on the way out are a known remainder, not
rewritten here). Idempotent. Owner-approved one-time repair (2026-09-28).

  python3 scripts/restore_ledger_players.py [--season 2026] [--dry-run]
"""

import argparse
import json
import os
import subprocess
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_estimate_ledger as bl                     # noqa: E402


def history(rel_path):
    """[(sha, doc)] for every committed version of rel_path, newest first."""
    shas = subprocess.check_output(["git", "log", "--format=%H", "--", rel_path],
                                   cwd=_ROOT, text=True).split()
    out = []
    for sha in shas:
        try:
            raw = subprocess.check_output(["git", "show", "%s:%s" % (sha, rel_path)],
                                          cwd=_ROOT, text=True)
            out.append((sha, json.loads(raw)))
        except (subprocess.CalledProcessError, ValueError):
            continue
    return out


def restore(current, versions):
    """(new_doc, [(pid, name, sha, locked_weeks)]) — each player absent from
    `current` but present in some version, taken verbatim from the newest one."""
    players = dict(current.get("players") or {})
    restored = []
    for sha, doc in versions:                      # newest first: first sight wins
        for pid, rec in (doc.get("players") or {}).items():
            if pid in players:
                continue
            players[pid] = rec
            restored.append((pid, rec.get("name"), sha[:8],
                             sorted((rec.get("locked") or {}).keys(), key=int)))
    doc = dict(current)
    doc["players"] = players
    return doc, restored


def selftest():
    cur = {"players": {"a": {"name": "A", "locked": {"1": 1}}}}
    versions = [("s2" * 20, {"players": {"a": {"name": "A-old", "locked": {"3": 7}},
                                         "b": {"name": "B2", "locked": {"1": 2, "2": 3}}}}),
                ("s1" * 20, {"players": {"b": {"name": "B1"}, "c": {"name": "C", "locked": {}}}})]
    doc, rest = restore(cur, versions)
    assert doc["players"]["a"] == {"name": "A", "locked": {"1": 1}}, \
        "a player on the ledger is never touched"
    assert doc["players"]["b"]["name"] == "B2", "the NEWEST version that held him wins"
    assert doc["players"]["c"]["name"] == "C"
    assert [r[0] for r in rest] == ["b", "c"] and rest[0][3] == ["1", "2"]
    again, rest2 = restore(doc, versions)
    assert again == doc and rest2 == [], "idempotent"
    print("selftest ok: missing records restored verbatim (newest wins), present "
          "players untouched, idempotent")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    path = bl.ledger_path(args.season)
    with open(path, encoding="utf-8") as fh:
        current = json.load(fh)
    doc, restored = restore(current, history(os.path.relpath(path, _ROOT)))
    for pid, name, sha, locked in restored:
        print("restore %-14s %-24s from %s locked %s" % (pid, name, sha, locked))
    print("%d player record(s) restored" % len(restored))
    if restored and not args.dry_run:
        bl.write(doc, path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
