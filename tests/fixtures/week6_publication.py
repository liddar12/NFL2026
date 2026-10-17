"""Synthetic publication fixture using real receipts, selection and journal."""
import datetime as dt
import json
import math

from scripts import build_my_cards as cards, learning_journal as journal, learning_receipts as lr

CREATED = "2026-09-01T12:00:00Z"
RECORDED = "2026-09-01T12:01:00Z"
KICKOFF = "2026-09-02T00:15:00Z"


def generation(root, created=CREATED, previous=None):
    pool = cards._fixture_pool(created)
    pool.update(week=6, base_model_version="publication-fixture-base")
    for player in pool["players"]:
        for rung in player["rungs"]:
            z = (player["mu"] - rung["line"]) / 30
            calibration = {"a": math.log(rung["model_prob"] / (1 - rung["model_prob"])), "b": 0, "c": 0}
            features = {"market": player["market"], "line": rung["line"], "mu": player["mu"], "sd": 30,
                "z": z, "p_team": player["p_team"], "calibration": calibration,
                "correlation_tags": ["game:" + player["game_id"]]}
            context = {"season": 2026, "week": 6, "base_model_version": pool["base_model_version"],
                "forecast_created_utc": created, "source_snapshot_id": lr.fingerprint({"created": created}),
                "source_timestamps": {"fixture": created}, "generation_sha": "unverified-fixture-code-claim"}
            receipt = lr.make_receipt({**player, **rung}, lr.base_probability(calibration, z, player["p_team"]),
                                      None, context, features=features)
            rung.update(model_prob=receipt["served_prob"], learning_receipt=receipt)
    schedule = {"season": 2026, "games": [{"game_id": gid, "week": 6, "status": "STATUS_SCHEDULED",
        "kickoff_utc": KICKOFF} for gid in ("G1", "G2")]}
    offered, _ = cards.offered_cards(pool, schedule["games"], None, created)
    records = [cards.card_record(dial, seed, rank, card, cards.kickoff_index(schedule["games"]))
               for dial, seed, rank, card in offered]
    recorded = (lr.instant(created) + dt.timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
    snapshots = root / "snapshots"
    doc, _ = journal.record(pool, schedule, None, records, recorded, str(snapshots))
    archive = cards.append(previous, records, 2026, 6, created, recorded)
    path = root / "my_cards" / "2026_wk06.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(archive, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    return snapshots, path, doc, archive
