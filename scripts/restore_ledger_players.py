#!/usr/bin/env python3
"""R103/R105b — the estimate ledger heals itself from its own git history.

Until R103, scripts/build_estimate_ledger.py rebuilt `players` from the day's
projections alone, so a player who left them (IR, demoted out of the top 300)
lost his whole record, locked week estimates included. R103 restored the 25
players still missing (verbatim, missing-only). R105b (owner: "figure out an
ongoing solution") finishes the job and keeps it finished: this runs on EVERY
daily pipeline (full history checked out) right after the ledger append, and
for every player it restores, from the committed versions of the ledger file:

  * a missing player's record, verbatim from the newest version that held it;
  * every LOCKED week any committed version ever held and the record no longer
    does (the 19 lock-weeks lost by players dropped and later re-added);
  * the TRUE first sight — the earliest `first` any version recorded;
  * the absence a re-creation proves, as a gap {last_seen, back}: the player's
    latest as-of in the last version before he vanished, and the first as-of of
    the record that replaced him. With the gap on file, the ledger's own lock
    rule (build_estimate_ledger.lock_eligible) still holds exactly: no lock is
    owed for a kickoff that fell while he was gone.

Nothing is re-derived: every restored estimate is what the pipeline itself wrote.
A restored player or week is marked `recovered`. Idempotent: a healed ledger
heals to itself, so after the first run this is a no-op until something is lost
again — and then it is put back on the next run, not by hand.

  python3 scripts/restore_ledger_players.py [--season 2026] [--dry-run] [--selftest]
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


def _derived_gaps(pid, chrono):
    """[{last_seen, back}] proven by `chrono` (oldest first): the record vanished,
    or was re-created with a LATER first sight, between two versions."""
    gaps, prev = [], None
    for _sha, doc in chrono:
        rec = (doc.get("players") or {}).get(pid)
        if rec is None:
            continue
        if prev is not None and rec["first"]["as_of_utc"] > prev["first"]["as_of_utc"]:
            gaps.append({"last_seen": prev["latest"]["as_of_utc"],
                         "back": rec["first"]["as_of_utc"]})
        prev = rec
    return gaps


def restore(current, versions):
    """(new_doc, [(pid, name, sha, locked_weeks)]) — the heal over `versions`
    (newest first). The report lists every player something was restored for."""
    players = {pid: dict(rec) for pid, rec in (current.get("players") or {}).items()}
    restored = []
    present = set(players)
    for sha, doc in versions:                      # newest first: first sight wins
        for pid, rec in (doc.get("players") or {}).items():
            if pid in players:
                continue
            players[pid] = rec
            restored.append((pid, rec.get("name"), sha[:8],
                             sorted((rec.get("locked") or {}).keys(), key=int)))
    chrono = list(reversed(versions))
    for pid in sorted(present):
        rec = players[pid]
        locked = dict(rec.get("locked") or {})
        weeks, first, src = [], rec["first"], None
        for sha, doc in versions:                  # newest first
            old = (doc.get("players") or {}).get(pid)
            if not old:
                continue
            for wk, est in (old.get("locked") or {}).items():
                if wk not in locked:
                    locked[wk] = est
                    weeks.append(int(wk))
                    src = src or sha[:8]
            if old["first"]["as_of_utc"] < first["as_of_utc"]:
                first = old["first"]
        gaps = list(rec.get("gaps") or [])
        for g in _derived_gaps(pid, chrono + [("current", {"players": {pid: rec}})]):
            if g not in gaps:
                gaps.append(g)
        refirst = first is not rec["first"]
        if not weeks and not refirst and gaps == list(rec.get("gaps") or []):
            continue
        rec["locked"] = dict(sorted(locked.items(), key=lambda kv: int(kv[0])))
        rec["first"] = first
        rec["gaps"] = sorted(gaps, key=lambda g: g["last_seen"])
        mark = dict(rec.get("recovered") or {})
        mark["locked_weeks"] = sorted(set(mark.get("locked_weeks") or []) | set(weeks))
        mark["first"] = bool(mark.get("first")) or refirst
        mark["source"] = "git history of the ledger file"
        rec["recovered"] = mark
        restored.append((pid, rec.get("name"), src or "history", sorted(weeks)))
    doc = dict(current)
    doc["players"] = players
    return doc, restored


def selftest():
    from scripts.build_estimate_ledger import lock_violations  # noqa: PLC0415

    def est(t):
        return {"as_of_utc": t}

    def rec(first, latest, locked):
        return {"name": "P", "first": est(first), "latest": est(latest),
                "locked": {str(w): {"as_of_utc": a} for w, a in locked.items()}}
    kick = {1: "2026-09-10T00:20Z", 2: "2026-09-18T00:15Z", 3: "2026-09-25T00:15Z"}
    # v1 (09-12): a and b both projected, week 1 locked for both.
    v1 = {"as_of_utc": "2026-09-12T06:00:00Z", "players": {
        "a": rec("2026-09-02T06:00:00Z", "2026-09-12T06:00:00Z", {1: "2026-09-09T06:00:00Z"}),
        "b": rec("2026-09-02T06:00:00Z", "2026-09-12T06:00:00Z", {1: "2026-09-09T06:00:00Z"}),
        "c": rec("2026-09-02T06:00:00Z", "2026-09-12T06:00:00Z", {1: "2026-09-09T06:00:00Z"})}}
    # v2 (09-20): b dropped (pre-R103 the builder deleted him), c gone for good.
    v2 = {"as_of_utc": "2026-09-20T06:00:00Z", "players": {
        "a": rec("2026-09-02T06:00:00Z", "2026-09-20T06:00:00Z",
                 {1: "2026-09-09T06:00:00Z", 2: "2026-09-17T06:00:00Z"})}}
    # current (09-28): b re-created with a NEW first sight and none of his locks.
    cur = {"as_of_utc": "2026-09-28T06:00:00Z", "players": {
        "a": rec("2026-09-02T06:00:00Z", "2026-09-28T06:00:00Z",
                 {1: "2026-09-09T06:00:00Z", 2: "2026-09-17T06:00:00Z",
                  3: "2026-09-24T06:00:00Z"}),
        "b": rec("2026-09-26T06:00:00Z", "2026-09-28T06:00:00Z", {})}}
    versions = [("s2" * 20, v2), ("s1" * 20, v1)]            # newest first
    doc, rest = restore(cur, versions)
    assert doc["players"]["a"] == cur["players"]["a"], "nothing lost: never touched"
    b = doc["players"]["b"]
    assert list(b["locked"]) == ["1"] and b["locked"]["1"]["as_of_utc"] == "2026-09-09T06:00:00Z", \
        "the lock he lost when he was dropped comes back verbatim"
    assert b["first"]["as_of_utc"] == "2026-09-02T06:00:00Z", "his TRUE first sight"
    assert b["gaps"] == [{"last_seen": "2026-09-12T06:00:00Z", "back": "2026-09-26T06:00:00Z"}], \
        "the absence the re-creation proves"
    assert b["recovered"] == {"locked_weeks": [1], "first": True,
                              "source": "git history of the ledger file"}
    assert doc["players"]["c"] == v1["players"]["c"], "a missing player comes back verbatim"
    assert lock_violations(doc, kick) == [], lock_violations(doc, kick)
    # weeks 2-3 fell inside b's gap: the rule owes no lock there, and none was made
    assert {r[0] for r in rest} == {"b", "c"}
    again, rest2 = restore(doc, versions)
    assert again == doc and rest2 == [], "idempotent: a healed ledger heals to itself"
    print("selftest ok: lost locks, true first sight and the proven gap restored "
          "verbatim, missing players restored, untouched records untouched, the lock "
          "rule holds, idempotent")


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
