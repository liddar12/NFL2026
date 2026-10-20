#!/usr/bin/env python3
"""Minimal reproductions of three engine-contract gaps (lean pilot, checkpoint 1).

Runs against an UNMODIFIED SelfLearning checkout pinned at aacb19c7, using only
the engine's own test fixtures. Nothing here changes an equation, invents a
settlement or drops a result; it prints what the engine does today.

    SELFLEARN_CORE=<SelfLearning>/packages/selflearn-core \
      python3 docs/pilot/engine_gap_repros.py > docs/pilot/engine_gap_repros_aacb19c7.json

R1  z sign: schemas/sports/nfl_parlay_leg.schema.json documents one sign,
    adapters/nfl.py validate_nfl_receipt enforces the other.
R2  final status: a game that never reaches STATUS_FINAL[_OVERTIME]
    (postponed / cancelled / suspended) yields no revision; check how the
    evaluation accounts for the ungraded receipts.
R3  push / official VOID, executed: (a) the `gte` prediction threshold grades
    actual == line as a HIT on the file path, which is correct for that
    contract; (b) explicit push / official_void settlement inputs resolve as
    VOID and are counted as exclusions, not losses; (c) the file path has no
    channel to receive such a settlement input.
"""
import copy
import json
import math
import os
import sys

CORE = os.environ["SELFLEARN_CORE"]
sys.path[:0] = [CORE, os.path.join(CORE, "tests")]

from selflearn_core.adapters import nfl as N                      # noqa: E402
from selflearn_core.adapters import nfl_file_feedback as F         # noqa: E402
import test_nfl_capture_evidence as E                              # noqa: E402
import test_nfl_capture_labels as L                                # noqa: E402
import test_nfl_file_feedback as T                                 # noqa: E402

out = {"engine_core": CORE}

# ---------------------------------------------------------------- R1 z sign
schema = json.load(open(os.path.join(CORE, "selflearn_core/schemas/sports/nfl_parlay_leg.schema.json")))
def _find(node, key):
    if isinstance(node, dict):
        if key in node.get("properties", {}):
            return node["properties"][key]
        for v in node.values():
            hit = _find(v, key)
            if hit is not None:
                return hit
    elif isinstance(node, list):
        for v in node:
            hit = _find(v, key)
            if hit is not None:
                return hit
    return None


z_doc = _find(schema, "z")
journal = L.journal_fixture()
row = journal.snapshot["generation_records"][0]["payload"]["receipts"][0]
receipt, leg = row["learning_receipt"], row["leg"]
season, week = receipt["season"], receipt["week"]
f = receipt["features"]
r1 = {"schema_z_text": z_doc, "fixture_mu_line_sd": [f["mu"], f["line"], f["sd"]], "fixture_z": f["z"],
      "validator_z_formula": "(mu - line) / sd  (adapters/nfl.py validate_nfl_receipt)"}
try:
    N.validate_nfl_receipt(receipt, leg, season, week)
    r1["fixture_validates"] = True
except Exception as exc:  # noqa: BLE001
    r1["fixture_validates"] = repr(exc)
flipped = copy.deepcopy(receipt)
flipped["features"]["z"] = (f["line"] - f["mu"]) / f["sd"]
c = f["calibration"]
flipped["base_prob"] = N._sigmoid(c["a"] + c["b"] * flipped["features"]["z"] + c["c"] * (f["p_team"] - .5))
# reseal so ONLY the z-sign rule can refuse it (receipt_id = fingerprint of the rest)
from selflearn_core.probability_receipts import fingerprint  # noqa: E402
flipped["receipt_id"] = fingerprint({k: v for k, v in flipped.items() if k != "receipt_id"})
r1["note"] = "fixture base_prob is the sigmoid of a=b=c=0 calibration, so z does not move base_prob; the parity check on z alone decides"
try:
    N.validate_nfl_receipt(flipped, leg, season, week)
    r1["schema_sign_receipt"] = "accepted"
except Exception as exc:  # noqa: BLE001
    r1["schema_sign_receipt"] = repr(exc)
out["R1_z_sign"] = r1

# ------------------------------------------------- R2 game never reaches FINAL
PREGAME, POSTGAME = "2026-10-17T15:00:00Z", "2026-10-20T15:00:00Z"


def status_capture(status, final):
    raw = E.encoded({"season": {"year": 2026}, "week": {"number": 6}, "events": [E.event("g6", status=status)]})
    audit = E.score_audit(final_games=1 if final else 0, nonfinal_games=0 if final else 1)
    envelope, objects = E.fixture(stats=E.STATS.replace(b",,,NA", b",,,80"), score_raw={6: raw},
                                  score_audits={6: audit})
    return envelope, (lambda key: E.stream(objects[key]))


graph = T.graph()
base = F.prepare(graph, observed_utc=PREGAME)["state"]
r2 = {"receipts": len(base["receipts"])}
for status, final in (("STATUS_FINAL", True), ("STATUS_POSTPONED", False), ("STATUS_CANCELED", False),
                      ("STATUS_SUSPENDED", False), ("STATUS_FULL_TIME", False)):
    try:
        res = F.prepare(graph, previous=base, captures=[status_capture(status, final)], observed_utc=POSTGAME)
        ev = F.evaluate(res["state"], graph, as_of_utc="2026-10-20T15:00:01Z")
        rep = ev["report"]
        r2[status] = {"revisions": len(res["state"]["revisions"]),
                      "resolutions": sorted({(rv["resolution"].get("status"), str(rv["resolution"].get("hit")))
                                             for rv in res["state"]["revisions"]}),
                      "capture_results": res["capture_results"],
                      "report_top_keys": sorted(rep.keys()) if isinstance(rep, dict) else type(rep).__name__,
                      "report_counts": {k: v for k, v in (rep.items() if isinstance(rep, dict) else [])
                                        if isinstance(v, (int, float)) and not isinstance(v, bool)}}
    except Exception as exc:  # noqa: BLE001
        r2[status] = {"refused": repr(exc)}
out["R2_final_status"] = r2

# --------------------------------------------------------- R3 push / VOID
# Executed, not inferred from source text. Two different rules are in play:
#   * the PREDICTION contract is a threshold, `over` / `gte`: "player reaches
#     at least `line`". actual == line is a HIT of that prediction, whatever
#     the line's fraction. An integer line is NOT reinterpreted as a push.
#   * a SETTLEMENT rule (a sportsbook push, an official void) is a separate,
#     explicit input. The engine's resolution layer accepts it as VOID; the
#     question is whether the file path can ever receive it.
import inspect                                                     # noqa: E402
from selflearn_core.adapters import nfl_capture_labels as LB       # noqa: E402
from selflearn_core.adapters.nfl_resolution import VOID_REASONS    # noqa: E402
from selflearn_core.scoring.binary_receipts import score_binary_receipts   # noqa: E402
from selflearn_core.store.receipt_journal import ReceiptJournal    # noqa: E402
import test_nfl_resolution as RS                                   # noqa: E402

r3 = {"void_reasons_accepted_by_resolution": sorted(VOID_REASONS)}

# R3a  file path, executed: the engine's own journal fixture at three lines
# around an observed stat of exactly 80 (integer line 80 included).
LINES, ACTUAL = (79.5, 80.0, 80.5), 80
g3 = T.graph(L.journal_fixture(lines=LINES))
b3 = F.prepare(g3, observed_utc=PREGAME)["state"]
p3 = F.prepare(g3, previous=b3, captures=[T.capture(ACTUAL)], observed_utc=POSTGAME)
line_of = {rc["receipt_id"]: rc["features"]["line"] for rc in p3["state"]["receipts"]}
graded = {}
for rv in p3["state"]["revisions"]:
    res = rv["resolution"]
    graded.setdefault(format(line_of[res["receipt_id"]], "g"), set()).add(
        (res["status"], res["hit"], res["actual"], res["reason"]))
r3["R3a_file_path_threshold"] = {
    "observed_actual": ACTUAL,
    "graded_by_line": {k: sorted(map(list, v), key=str) for k, v in sorted(graded.items())},
    "reading": "gte threshold: 79.5 hit, 80 hit (actual == line), 80.5 miss. Correct for the "
               "prediction contract; the engine does not infer a push from an integer line, and should not."}

# R3b  resolution layer, executed: an explicit settlement input of push or
# official_void resolves as VOID (hit=None) and the scorer counts it as an
# EXCLUSION, never as a loss and never silently dropped.
r, s, leg, games, *_ = RS.settlement_fixture()
r3b = {}
for reason in ("push", "official_void"):
    batch = RS.resolve(r, s, [dict(leg, result="void", reason=reason, actual=None)], games)
    with ReceiptJournal(":memory:") as j:
        j.append_receipt(r)
        j.append_resolution(**batch["proposals"][0])
        rep = score_binary_receipts(j.receipts(), j.latest_resolutions())
    r3b[reason] = {"resolution": [[p["resolution"]["status"], p["resolution"]["hit"], p["resolution"]["reason"]]
                                  for p in batch["proposals"]],
                   "score_n": rep["n"], "score_hits": rep["hits"], "score_excluded": rep["excluded"]}
binary = RS.resolve(r, s, [leg], games)
with ReceiptJournal(":memory:") as j:
    j.append_receipt(r)
    j.append_resolution(**binary["proposals"][0])
    rep = score_binary_receipts(j.receipts(), j.latest_resolutions())
r3b["control_binary_hit"] = {"score_n": rep["n"], "score_hits": rep["hits"], "score_excluded": rep["excluded"]}
r3["R3b_resolution_layer_settlement_inputs"] = r3b

# R3c  the file path's settlement inputs, executed: its entry point takes only
# the journal, the capture envelope and raw bytes, and every void reason it
# emitted across R2/R3a is did_not_play. There is no channel for an official
# void or a book's push rule, so such an outcome would be graded by the
# threshold (R3a) instead of staying visibly unresolved.
emitted = {rv["resolution"].get("reason") for rv in p3["state"]["revisions"]}
sig = inspect.signature(LB.bind_capture_labels)
r3["R3c_file_path_settlement_channel"] = {
    "bind_capture_labels_signature": str(sig),
    "settlement_parameters": [k for k in sig.parameters
                              if k not in ("journal", "capture_envelope", "raw_chunks", "max_total_bytes")],
    "void_reasons_emitted_in_R3a": sorted(x for x in emitted if x is not None),
    "gap": "settlement rules need an explicit, sourced input on the file path that yields VOID "
           "(excluded and counted, R3b) rather than a threshold grade"}
r3["producer_line_fractions_note"] = ("NFL leg_pool lines are all x.5 today (1,231/1,231 rungs on 2026-10-19), "
                                      "so threshold and settlement cannot disagree in current data")
out["R3_push_void"] = r3

# The R3 cases are executable checks: the script exits non-zero if the pinned
# engine stops behaving as recorded above.
assert graded == {"79.5": {("FINAL", True, 80.0, None)}, "80": {("FINAL", True, 80.0, None)},
                  "80.5": {("FINAL", False, 80.0, None)}}, graded
for reason in ("push", "official_void"):
    assert r3b[reason] == {"resolution": [["VOID", None, reason]], "score_n": 0, "score_hits": 0,
                           "score_excluded": {"not_final_binary_outcome": 1}}, r3b[reason]
assert r3b["control_binary_hit"] == {"score_n": 1, "score_hits": 1, "score_excluded": {}}, r3b
assert r3["R3c_file_path_settlement_channel"]["settlement_parameters"] == []
assert r3["R3c_file_path_settlement_channel"]["void_reasons_emitted_in_R3a"] == []

print(json.dumps(out, indent=1, sort_keys=True, default=str))
