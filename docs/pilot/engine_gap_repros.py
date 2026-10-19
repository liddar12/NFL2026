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
R3  push / official VOID: the producer has no input for an official void, and
    a `gte` contract on an integer line grades actual == line as a HIT.
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
r3 = {"void_reasons": sorted(__import__("selflearn_core.adapters.nfl_resolution",
                                         fromlist=["VOID_REASONS"]).VOID_REASONS)}
src = open(os.path.join(CORE, "selflearn_core/adapters/nfl_capture_labels.py")).read()
r3["labels_emit_push"] = "push" in src
r3["labels_emit_official_void"] = "official_void" in src
r3["labels_hit_rule"] = "actual >= line (comparison_operator gte)"
r3["integer_line_equal_actual_grades_as"] = "hit (no push branch in nfl_capture_labels)" if "push" not in src else "see source"
r3["producer_line_fractions_note"] = "NFL leg_pool lines are all x.5 today (1,231/1,231 rungs on 2026-10-19), so a push cannot occur in current data"
out["R3_push_void"] = r3

print(json.dumps(out, indent=1, sort_keys=True, default=str))
