"""Register original NFL forecast delivery and recover by workflow attempt.

Each exchange has bounded retries and a socket timeout. A supervising process
must enforce the overall deadline, including DNS and filesystem work.
"""

import datetime as dt
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import export_learning as export, queue_publication as queue  # noqa: E402
from scripts import run_forecast_delivery as forecast  # noqa: E402
from scripts.learning_history_guard import _git  # noqa: E402

ORIGIN = forecast.ORIGIN
REPOSITORY = "liddar12/nfl2026"
BASE = "/api/v1/nfl/collection-intents"
TOKEN_ENV = "SELFLEARN_NFL_COLLECTION_TOKEN"
MAX_ATTEMPTS = 3
MAX_PAGES = 8
MAX_SCAN = 50
WORKFLOWS = {"daily.yml", "gameday.yml"}
RUN_NUMBER = re.compile(r"[1-9][0-9]{0,18}\Z")
REPO_NAME = re.compile(r"[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
RUN_ROUTE = re.compile(re.escape(BASE) + r"/(?:daily|gameday)\.yml/[1-9][0-9]{0,18}/[1-9][0-9]{0,18}(?:/(?:publisher|recover))?\Z")
PENDING_ROUTE = re.compile(re.escape(BASE) + r"/pending\?limit=(?:[1-9]|[1-4][0-9]|50)(?:&after=sha256%3A[0-9a-f]{64})?\Z")
STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-](?:0[0-9]|1[0-5]):[0-5][0-9])\Z")
SOURCES = {"leg_pool", "schedule", "parlay_calibration"}
LOCATOR = {"workflow", "run_id", "run_attempt"}
INTENT = {"version", *LOCATOR, "generation_object_id", "generation_id", "recorded_utc",
          "latest_kickoff_utc", "source_snapshots"}
PUBLISHER = {"version", "intent_id", "published_sha", "published_pool_id", "previous_pool_id"}
VIEW = {"version", "observed_utc", "intent", "publisher_receipt", "missing_object_ids", "state",
        "generation_ack", "intake_complete", "publication_ready", "publication_verified", "training_approved"}


class HandoffError(ValueError):
    """Static error codes for an untrusted response or refused operation."""


def need(condition, reason="collection_protocol_refused"):
    if not condition:
        raise HandoffError(reason)


def fields(value, keys, *, versioned=False):
    need(type(value) is dict and set(value) == keys)
    if versioned:
        need(type(value["version"]) is int and value["version"] == 1)


def scope(workflow, run_id, run_attempt):
    need(type(workflow) is str and workflow in WORKFLOWS
         and all(type(item) is str and RUN_NUMBER.fullmatch(item) for item in (run_id, run_attempt)),
         "invalid_collection_scope")
    return workflow, run_id, run_attempt


def clock(value):
    need(type(value) is str and STAMP.fullmatch(value))
    try:
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except (ValueError, OverflowError):
        raise HandoffError("invalid_collection_clock") from None
    need(2000 <= stamp.year <= 2100)
    return stamp


def intent_record(request, repository):
    fields(request, INTENT, versioned=True)
    need(type(repository) is str and REPO_NAME.fullmatch(repository))
    scope(request["workflow"], request["run_id"], request["run_attempt"])
    fields(request["source_snapshots"], SOURCES)
    sources = {export._hash(item) for item in request["source_snapshots"].values()}
    need(export._hash(request["generation_object_id"]) not in sources)
    export._hash(request["generation_id"])
    need(clock(request["recorded_utc"]) < clock(request["latest_kickoff_utc"]))
    original = {**request, "repository": repository, "kind": "nfl.collection_intent.v1"}
    return {**original, "intent_id": export.fingerprint(original)}


def original(workspace, workflow, run_id, run_attempt):
    """Read the original export graph. No capture, clock, writes or environment."""
    scope(workflow, run_id, run_attempt)
    root = forecast._workspace(workspace)
    plan = export.plan(export._delivery_path(root, "snapshots"))
    entry, generation = forecast._generation(plan)
    envelope = entry["request"]
    latest = max((item["kickoff_utc"] for item in envelope["payload"]["receipts"]), key=clock)
    request = {"version": 1, "workflow": workflow, "run_id": run_id, "run_attempt": run_attempt,
               "generation_object_id": envelope["object_id"], "generation_id": generation["generation_id"],
               "recorded_utc": generation["recorded_utc"], "latest_kickoff_utc": latest,
               "source_snapshots": generation["source_snapshots"]}
    return request, plan, entry["expected_receipt_ids"]


def preview(workspace, workflow, run_id, run_attempt, *, repository=REPOSITORY):
    request, _, _ = original(workspace, workflow, run_id, run_attempt)
    return {"version": 1, "state": "preview", "intent": intent_record(request, repository),
            "network_used": False, "writes": False, "publication_verified": False, "training_approved": False}


def publisher_record(intent, request):
    fields(request, PUBLISHER, versioned=True)
    need(request["intent_id"] == intent["intent_id"])
    sha, pool, previous = (request[key] for key in ("published_sha", "published_pool_id", "previous_pool_id"))
    if sha is None:
        need(pool is None and previous is None)
        disposition = "noop"
    else:
        need(type(sha) is str and COMMIT.fullmatch(sha))
        export._hash(pool)
        if previous is not None:
            export._hash(previous)
        if pool != intent["source_snapshots"]["leg_pool"]:
            disposition = "mismatch"
        else:
            disposition = "unchanged" if previous == pool else "match"
    receipt = {**request, "kind": "nfl.collection_publisher_receipt.v1", "disposition": disposition}
    return {**receipt, "receipt_id": export.fingerprint(receipt)}


def publisher_request(intent, receipt_path, checkout):
    commit = queue.publisher_commit(receipt_path, intent["run_id"], intent["run_attempt"])
    if commit == "noop":
        return {"version": 1, "intent_id": intent["intent_id"], "published_sha": None,
                "published_pool_id": None, "previous_pool_id": None}
    need(_git(checkout, ["cat-file", "-t", commit], limit=32) == b"commit\n")
    pool = export._hash(queue._pool_id_at(checkout, commit))
    try:
        parent = _git(checkout, ["rev-parse", "--verify", commit + "^"], limit=64).strip().decode("ascii")
    except ValueError:
        raise HandoffError("collection_publisher_parent_unavailable") from None
    need(COMMIT.fullmatch(parent), "collection_publisher_parent_unavailable")
    previous = queue._pool_id_at(checkout, parent)
    return {"version": 1, "intent_id": intent["intent_id"], "published_sha": commit,
            "published_pool_id": pool, "previous_pool_id": previous}


def validate_view(value, repository, key, *, expected=None, receipt_ids=None):
    fields(value, VIEW, versioned=True)
    intent = value["intent"]
    fields(intent, {*INTENT, "kind", "repository", "intent_id", "stored_utc"})
    request = {name: intent[name] for name in INTENT}
    need(scope(intent["workflow"], intent["run_id"], intent["run_attempt"]) == key)
    need(export._same_json(intent_record(request, repository), {k: v for k, v in intent.items() if k != "stored_utc"}))
    if expected is not None:
        need(intent["intent_id"] == expected, "collection_intent_conflict")
    observed, stored = clock(value["observed_utc"]), clock(intent["stored_utc"])
    need(clock(intent["recorded_utc"]) <= stored <= observed)
    late = observed >= clock(intent["latest_kickoff_utc"])
    receipt = value["publisher_receipt"]
    if receipt is not None:
        fields(receipt, {*PUBLISHER, "kind", "disposition", "receipt_id", "stored_utc"})
        saved = publisher_record(intent, {k: receipt[k] for k in PUBLISHER})
        need(export._same_json(saved, {k: v for k, v in receipt.items() if k != "stored_utc"})
             and stored <= clock(receipt["stored_utc"]) <= observed)
    missing = value["missing_object_ids"]
    need(type(missing) is list and all(type(item) is str for item in missing)
         and missing == sorted(set(missing))
         and set(missing) <= {intent["generation_object_id"], *intent["source_snapshots"].values()})
    ack = value["generation_ack"]
    complete = False
    if ack is not None:
        need(not missing)
        fields(ack, {"version", "object_id", "durable", "receipts", "rejections"}, versioned=True)
        need(type(ack["receipts"]) is list and type(ack["rejections"]) is list)
        actual_ids = []
        for row in ack["receipts"]:
            fields(row, {"source_receipt_id", "receipt_id", "status"})
            actual_ids.append(export._hash(row["source_receipt_id"]))
        for row in ack["rejections"]:
            fields(row, {"source_receipt_id", "reason"})
            actual_ids.append(export._hash(row["source_receipt_id"]))
        need(bool(actual_ids))
        export._validate_ack(ack, {"object_id": intent["generation_object_id"], "phase": "generation"},
                             actual_ids if receipt_ids is None else receipt_ids)
        complete = bool(ack["receipts"]) and not ack["rejections"]
    if missing:
        state = "held_late" if late else "awaiting_objects"
    elif ack is None:
        state = value["state"] if value["state"] == "held_invalid_generation" else (
            "held_late" if late else "ready_to_finalize")
    elif not complete:
        state = "held_intake_rejected"
    elif late:
        state = "held_late"
    elif receipt is None:
        state = "awaiting_publisher"
    else:
        state = "publication_ready" if receipt["disposition"] == "match" else "held_publisher_" + receipt["disposition"]
    need(value["state"] == state and value["intake_complete"] is complete
         and value["publication_ready"] is (state == "publication_ready")
         and value["publication_verified"] is False and value["training_approved"] is False)
    return value


def validate_page(page, limit, after):
    fields(page, {"version", "observed_utc", "pending", "next_after"}, versioned=True)
    clock(page["observed_utc"])
    rows = page["pending"]
    need(type(rows) is list and len(rows) <= limit)
    ids, keys = [], set()
    for row in rows:
        fields(row, {*LOCATOR, "intent_id"})
        key = scope(row["workflow"], row["run_id"], row["run_attempt"])
        need(key not in keys)
        keys.add(key)
        ids.append(export._hash(row["intent_id"]))
    lower = after or ""
    need(ids == sorted(set(ids)) and (not ids or ids[0] > lower))
    cursor = page["next_after"]
    if cursor is not None:
        need(export._hash(cursor) > lower and (not ids or cursor >= ids[-1]))
    return page


def token_valid(token):
    need(type(token) is str and 32 <= len(token) <= 8192 and token != "[SENSITIVE]"
         and all(0x21 <= ord(char) <= 0x7e for char in token), "invalid_collection_token")


def _https(token, *, intake=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), export._NoRedirect())

    def call(method, route, body):
        if intake:
            need(method == "POST" and route in (export.OBJECT_ROUTE, export.GENERATION_ROUTE))
        elif method == "GET":
            need((RUN_ROUTE.fullmatch(route) and route.count("/") == BASE.count("/") + 3)
                 or PENDING_ROUTE.fullmatch(route))
        else:
            need(method == "POST" and (route == BASE or RUN_ROUTE.fullmatch(route)
                 and route.endswith(("/publisher", "/recover"))))
        need(body is None if method == "GET" else type(body) is bytes and 0 < len(body) <= export.MAX_BODY_BYTES)
        request = urllib.request.Request(ORIGIN + route, data=body, method=method,
            headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=15) as response:
                need(response.geturl() == ORIGIN + route, "collection_redirect_refused")
                return response.status, response.read(export.MAX_BODY_BYTES + 1)
        except urllib.error.HTTPError as error:
            error.close()
            return error.code, b""
    return call


class Client:
    def __init__(self, token, *, repository=REPOSITORY, transport=None, attempts=MAX_ATTEMPTS, sleep=time.sleep):
        token_valid(token)
        need(type(repository) is str and REPO_NAME.fullmatch(repository))
        need(type(attempts) is int and 1 <= attempts <= MAX_ATTEMPTS)
        self.repository = repository
        self.token = token
        self._transport = _https(token) if transport is None else transport
        self._attempts = attempts
        self._sleep = sleep

    def _exchange(self, method, route, request=None):
        body = None if request is None else export.encoded(request)
        export._reject_credentials(request, (self.token,))
        for attempt in range(self._attempts):
            try:
                status, raw = self._transport(method, route, body)
            except OSError:
                pass
            except Exception:
                raise HandoffError("collection_transport_refused") from None
            else:
                need(type(status) is int)
                if status == 200:
                    need(type(raw) is bytes and len(raw) <= export.MAX_BODY_BYTES)
                    result = export._json(raw)
                    export._reject_credentials(result, (self.token,))
                    return result
                if 300 <= status < 400:
                    raise HandoffError("collection_redirect_refused")
                if status == 404:
                    raise HandoffError("collection_intent_not_found")
                if status == 409:
                    raise HandoffError("collection_intent_conflict")
                need(status == 429 or 500 <= status < 600, "collection_http_refused")
            if attempt + 1 < self._attempts:
                self._sleep(0.5 * 2 ** attempt)
        raise HandoffError("collection_retry_exhausted")

    def read(self, workflow, run_id, run_attempt, *, expected=None, receipt_ids=None):
        key = scope(workflow, run_id, run_attempt)
        if expected is not None:
            export._hash(expected)
        path = BASE + "/" + "/".join(key)
        return validate_view(self._exchange("GET", path), self.repository, key,
                             expected=expected, receipt_ids=receipt_ids)

    def recover(self, workflow, run_id, run_attempt, *, expected=None, receipt_ids=None):
        key = scope(workflow, run_id, run_attempt)
        prior = self.read(*key, expected=expected, receipt_ids=receipt_ids)
        if prior["state"] != "ready_to_finalize":
            return prior
        forecast.capture.disabled_config()
        identity = prior["intent"]["intent_id"]
        path = BASE + "/" + "/".join(key) + "/recover"
        return validate_view(self._exchange("POST", path, {"version": 1, "intent_id": identity}),
                             self.repository, key, expected=identity, receipt_ids=receipt_ids)

    def pending(self, *, limit=16, after=None, pages=1):
        need(type(limit) is int and 1 <= limit <= MAX_SCAN and type(pages) is int and 1 <= pages <= MAX_PAGES)
        if after is not None:
            export._hash(after)
        rows, seen = [], set()
        for _ in range(pages):
            query = {"limit": limit}
            if after is not None:
                query["after"] = after
            path = BASE + "/pending?" + urllib.parse.urlencode(query)
            page = validate_page(self._exchange("GET", path), limit, after)
            for row in page["pending"]:
                key = scope(row["workflow"], row["run_id"], row["run_attempt"])
                need(key not in seen)
                seen.add(key)
                rows.append(row)
            after = page["next_after"]
            if after is None:
                break
        return {**page, "pending": rows}

    def publisher(self, workflow, run_id, run_attempt, receipt_path, *, checkout=ROOT):
        key = scope(workflow, run_id, run_attempt)
        forecast.capture.disabled_config()
        view = self.read(*key)
        intent = view["intent"]
        request = publisher_request(intent, receipt_path, checkout)
        expected = publisher_record(intent, request)["receipt_id"]
        path = BASE + "/" + "/".join(key) + "/publisher"
        result = validate_view(self._exchange("POST", path, request), self.repository, key, expected=intent["intent_id"])
        need(result["publisher_receipt"] is not None and result["publisher_receipt"]["receipt_id"] == expected)
        return result

    def send(self, workspace, workflow, run_id, run_attempt, ingest_token, *, intake_transport=None):
        """Register first, then use the original forecast sender and its outbox."""
        forecast.capture.disabled_config()
        token_valid(ingest_token)
        need(ingest_token != self.token, "collection_requires_separate_tokens")
        key = scope(workflow, run_id, run_attempt)
        request, plan, receipt_ids = original(workspace, *key)
        export._reject_credentials(plan, (self.token, ingest_token))
        intent = intent_record(request, self.repository)
        identity = intent["intent_id"]
        result = validate_view(self._exchange("POST", BASE, request), self.repository, key,
                               expected=identity, receipt_ids=receipt_ids)
        if result["state"] == "ready_to_finalize":
            return self.recover(*key, expected=identity, receipt_ids=receipt_ids)
        if result["state"] != "awaiting_objects":
            return result
        entry, _ = forecast._generation(plan)
        envelope = entry["request"]
        allowed = {export.encoded(item) for item in [*plan["source_objects"], envelope]}
        final = export.encoded({"version": 1, "object_id": envelope["object_id"]})
        channel = _https(ingest_token, intake=True) if intake_transport is None else intake_transport

        def intake(route, body):
            need((route == export.OBJECT_ROUTE and body in allowed)
                 or (route == export.GENERATION_ROUTE and body == final), "collection_original_plan_changed")
            return channel("POST", route, body)

        forecast.deliver(workspace, ingest_token, transport=export._credential_guarded_transport(
            intake, (self.token, ingest_token)), attempts=self._attempts, sleep=self._sleep)
        return self.read(*key, expected=identity, receipt_ids=receipt_ids)


def main(argv=None):
    parser = export._SafeParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    for command in ("send", "status", "recover", "pending", "publisher"):
        mode.add_argument("--" + command, action="store_true")
    parser.add_argument("--workspace")
    parser.add_argument("--workflow")
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt")
    parser.add_argument("--publisher-receipt")
    parser.add_argument("--expected-intent")
    parser.add_argument("--page-limit", type=int, default=16)
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--after")
    args = parser.parse_args(argv)
    try:
        key = (args.workflow, args.run_id, args.run_attempt)
        if args.pending:
            need(not any(key) and not (args.workspace or args.publisher_receipt or args.expected_intent))
            value = Client(os.environ.get(TOKEN_ENV)).pending(limit=args.page_limit, after=args.after, pages=args.max_pages)
        else:
            scope(*key)
            need(args.after is None and args.page_limit == 16 and args.max_pages == 1)
            need(bool(args.publisher_receipt) == args.publisher)
            need(not args.expected_intent or args.status or args.recover)
            need(bool(args.workspace) == (not (args.status or args.recover or args.publisher)))
            if args.send or args.publisher or args.status or args.recover:
                client = Client(os.environ.get(TOKEN_ENV))
                if args.expected_intent is not None:
                    export._hash(args.expected_intent)
                if args.send:
                    value = client.send(args.workspace, *key, os.environ.get("SELFLEARN_NFL_INGEST_TOKEN"))
                elif args.publisher:
                    value = client.publisher(*key, args.publisher_receipt)
                else:
                    operation = client.recover if args.recover else client.read
                    value = operation(*key, expected=args.expected_intent)
            else:
                value = preview(args.workspace, *key)
        print(export.encoded(value).decode("ascii"))
        return 0
    except Exception:
        print('{"version":1,"state":"collection_handoff_refused"}', file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
