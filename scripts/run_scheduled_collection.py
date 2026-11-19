#!/usr/bin/env python3
"""Opt-in forecast recording at the data publisher boundary."""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib import request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import run_collection_handoff as handoff, run_forecast_delivery as forecast


def report(status):
    print(json.dumps({"status": status, "adoption_approved": False}))
    return 0


def invoke_worker(token):
    handoff.token_valid(token)
    export = handoff.export
    url = handoff.ORIGIN + "/api/v1/nfl/publication-worker"
    opener = request.build_opener(request.ProxyHandler({}), export._NoRedirect())
    call = request.Request(url, method="POST", data=b'{"version":1}',
                           headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with opener.open(call, timeout=25) as response:
        handoff.need(response.status == 200 and response.geturl() == url)
        raw = response.read(65537)
    handoff.need(len(raw) <= 65536)
    state = export._json(raw)
    handoff.need(state["version"] == 1 and state["kind"] == "nfl.publication_worker_status.v1")
    status = state["status"]
    handoff.need(status in {"recording_completed", "idle", "pending", "held"})
    return status


def publish_original(client, key, receipt_path, *, expected=None, checkout=ROOT):
    # Refuse the local receipt before writes if it belongs to another attempt.
    handoff.queue.publisher_commit(receipt_path, key[1], key[2])
    original = client.recover(*key, expected=expected)
    identity = original["intent"]["intent_id"]
    recorded = original if original["publisher_receipt"] is not None else client.publisher(
        *key, receipt_path, checkout=checkout)
    if original["publisher_receipt"] is not None:
        receipt = handoff.publisher_request(original["intent"], receipt_path, checkout)
        handoff.need(handoff.publisher_record(original["intent"], receipt)["receipt_id"]
                     == original["publisher_receipt"]["receipt_id"])
    if recorded["publication_ready"]:
        return client.publication(*key, expected=identity, enqueue=True)
    return recorded


def recover_published_run(env, temp):
    workflow = {"daily-pipeline": "daily.yml", "gameday": "gameday.yml"}[env["PUBLISHER_WORKFLOW"]]
    key = handoff.scope(workflow, env["PUBLISHER_RUN_ID"], env["PUBLISHER_RUN_ATTEMPT"])
    client = handoff.Client(env.get(handoff.TOKEN_ENV), attempts=1)
    try:
        result = publish_original(client, key, temp / "selflearning-publisher" / "published-data.txt",
                                  checkout=ROOT)
    except handoff.HandoffError as error:
        if str(error) == "collection_intent_not_found":
            return report("no_original_forecast")
        raise
    return report(result["state"])


def run(phase, workflow, *, env=os.environ):
    if env.get("NFL_SELFLEARN_COLLECTION_MODE") != "record":
        return report("disabled")
    if env.get("GITHUB_REPOSITORY", "").lower() != handoff.REPOSITORY or env.get("GITHUB_REF") != "refs/heads/main":
        return report("outside_collection_scope")

    try:
        if phase == "recover-published":
            forecast.capture.disabled_config()
            return recover_published_run(env, Path(env["RUNNER_TEMP"]).resolve(strict=True))
        key = handoff.scope(workflow, env["GITHUB_RUN_ID"], env["GITHUB_RUN_ATTEMPT"])
        if phase == "observe-publication":
            forecast.capture.disabled_config()
            return report(invoke_worker(env.get("SELFLEARN_NFL_PUBLICATION_WORKER_TOKEN")))
        temp = Path(env["RUNNER_TEMP"]).resolve(strict=True)
        workspace = temp / "selflearning-forecast"
        forecast.capture.disabled_config()
        if phase == "before-publish":
            client_token = env.get(handoff.TOKEN_ENV)
            ingest_token = env.get("SELFLEARN_NFL_INGEST_TOKEN")
            handoff.token_valid(client_token)
            handoff.token_valid(ingest_token)
            handoff.need(client_token != ingest_token)
            prepared = forecast.prepare(ROOT / "data", workspace, execute=True)
            if not prepared["ok"]:
                return report(prepared["status"])
            client = handoff.Client(client_token, attempts=1)
            state = client.send(workspace, *key, ingest_token)
        elif phase == "after-publish":
            receipt_path = temp / "published-data.txt"
            # Even an incomplete upload may leave a recoverable original on
            # the engine. Keep the publisher receipt bound to this local plan.
            if not workspace.is_dir():
                return report("no_original_forecast")
            local = handoff.preview(workspace, *key)["intent"]
            client = handoff.Client(env.get(handoff.TOKEN_ENV), attempts=1)
            state = publish_original(client, key, receipt_path, expected=local["intent_id"], checkout=ROOT)
        else:
            raise ValueError("invalid phase")
        return report(state["state"])
    except Exception:
        # Keep raw evidence and scoped credentials out of workflow output.
        print("::warning::SelfLearning collection could not complete this phase.")
        return report("collection_phase_held")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before-publish", "after-publish", "observe-publication", "recover-published"))
    parser.add_argument("workflow", choices=sorted(handoff.WORKFLOWS), nargs="?")
    args = parser.parse_args()
    if (args.workflow is None) != (args.phase == "recover-published"):
        parser.error("supply the workflow only for inline phases")
    return run(args.phase, args.workflow)


if __name__ == "__main__":
    raise SystemExit(main())
