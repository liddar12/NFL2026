#!/usr/bin/env python3
"""Standalone NFL client against actual engine ASGI with a temporary SQLite journal."""

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import run_collection_handoff as H
from scripts import run_forecast_delivery as D
from scripts import export_learning as E

COLLECTION = "offline-collection-handoff-" + "c" * 40
INGEST = "offline-collection-ingest-" + "i" * 40
OWNER = "offline-collection-owner-" + "o" * 40
RUN = ("daily.yml", "10001", "1")
ENV = {H.TOKEN_ENV: COLLECTION, "SELFLEARN_OPERATOR_TOKEN": OWNER, "SELFLEARN_NFL_INGEST_TOKEN": INGEST,
       "SELFLEARN_NFL_COLLECTION_MODE": "record", "SELFLEARN_NFL_COLLECTION_REPOSITORY": H.REPOSITORY}


def stamp(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def git(checkout, *args):
    return subprocess.check_output(["git", "-C", str(checkout), *args], stderr=subprocess.DEVNULL).decode().strip()


class HandoffAcceptance(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="offline-nfl-collection-")
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name)
        self.workspace = self.base / "workspace"
        self.database = self.base / "journal.sqlite"
        self.checkout = self.base / "git"
        self.checkout.mkdir()
        self.calls = []
        source = self.base / "source"
        source.mkdir()
        now = datetime.now(timezone.utc)
        self.kickoff = now + timedelta(hours=1)
        created, self.recorded = stamp(now - timedelta(minutes=2)), stamp(now - timedelta(minutes=1))
        fixture = runpy.run_path(str(ROOT / "tests" / "fixtures" / "week6_outcomes.py"))
        builder = fixture["generation"]
        with patch.dict(builder.__globals__, {"KICKOFF": stamp(self.kickoff)}):
            _, self.pool, schedule = builder(self.base / "fixture", created=created)
        for name, value in (("leg_pool", self.pool), ("schedule_full", schedule), ("parlay_backtest", None)):
            (source / (name + ".json")).write_bytes(E.encoded(value))
        result = D.prepare(source, self.workspace, execute=True, clock=lambda: self.recorded)
        self.assertTrue(result["ok"])
        self.object_id = result["envelope_id"]
        for target in ("socket.create_connection", "urllib.request.OpenerDirector.open"):
            guard = patch(target, side_effect=AssertionError("network forbidden"))
            guard.start()
            self.addCleanup(guard.stop)

    def server(self, *, late=False, env=ENV):
        kickoff = self.kickoff

        class Store(SQLiteCollectionHandoff):
            def _now(store):
                return stamp(kickoff + timedelta(seconds=1)) if late else super()._now()

        return TestClient(create_app(store=object(), env=env, journal_factory=lambda: ReceiptJournal(self.database),
                                     collection_handoff_store=Store))

    def transport(self, server, token, *, lose=(), skip=()):
        lost = set(lose)

        def send(method, route, body):
            self.calls.append((method, route, token, body))
            if any(route.endswith(suffix) for suffix in skip):
                raise TimeoutError("synthetic interruption before POST")
            response = server.request(method, route, content=body,
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            if method == "POST" and route in lost:
                lost.remove(route)
                raise TimeoutError("synthetic reply loss after commit")
            return response.status_code, response.content
        return send

    def client(self, server, **kwargs):
        return H.Client(COLLECTION, transport=self.transport(server, COLLECTION, **kwargs), sleep=lambda _: None)

    def receipt(self, disposition, key=RUN):
        path = self.base / "publisher.receipt"
        if disposition == "noop":
            sha = "noop"
        else:
            git(self.checkout, "init", "-q")
            git(self.checkout, "config", "user.email", "offline@example.invalid")
            git(self.checkout, "config", "user.name", "Offline Fixture")
            file = self.checkout / "data" / "leg_pool.json"
            file.parent.mkdir()
            first = self.pool if disposition == "unchanged" else {"different": "previous"}
            second = {"different": "published"} if disposition == "mismatch" else self.pool
            for index, pool in enumerate((first, second)):
                file.write_bytes(E.encoded(pool))
                (self.checkout / "step").write_text(str(index), encoding="ascii")
                git(self.checkout, "add", "data/leg_pool.json", "step")
                git(self.checkout, "commit", "-qm", "synthetic publisher blob")
            sha = git(self.checkout, "rev-parse", "HEAD")
            file.write_bytes(E.encoded({"uncommitted": "ignored"}))
        path.write_text(f"{key[1]} {key[2]} {sha}\n", encoding="ascii")
        return path

    def test_preview_register_lost_replies_restart_and_durable_publication_handoff(self):
        class GuardedEnvironment(dict):
            def get(self, key, default=None):
                if key.startswith("SELFLEARN_"):
                    raise AssertionError("preview read SelfLearning environment")
                return super().get(key, default)

            def __getitem__(self, key):
                if key.startswith("SELFLEARN_"):
                    raise AssertionError("preview read SelfLearning environment")
                return super().__getitem__(key)

        cli = io.StringIO()
        before = {file: file.read_bytes() for file in self.workspace.rglob("*.json")}
        with (patch.object(H.os, "environ", GuardedEnvironment()),
              patch.object(H, "Client", side_effect=AssertionError("preview client")), redirect_stdout(cli)):
            preview = H.preview(self.workspace, *RUN)
            self.assertEqual(H.main(["--workspace", str(self.workspace), "--workflow", RUN[0],
                "--run-id", RUN[1], "--run-attempt", RUN[2]]), 0)
        self.assertEqual(preview["intent"]["recorded_utc"], self.recorded)
        self.assertFalse(preview["writes"] or preview["network_used"])
        self.assertEqual(E._json(cli.getvalue().encode()), preview)
        self.assertEqual({file: file.read_bytes() for file in self.workspace.rglob("*.json")}, before)

        location = H.BASE + "/" + "/".join(RUN)
        with self.server() as first:
            result = self.client(first, lose=(H.BASE,)).send(self.workspace, *RUN, INGEST,
                intake_transport=self.transport(first, INGEST, skip=(E.GENERATION_ROUTE,)))
        self.assertEqual(result["state"], "ready_to_finalize")
        self.assertEqual(result["intent"]["intent_id"], preview["intent"]["intent_id"])
        self.assertEqual(self.calls[0][:3], ("POST", H.BASE, COLLECTION))
        self.assertEqual(self.calls[0], self.calls[1])
        self.assertTrue(all((token == COLLECTION) == route.startswith(H.BASE) for _, route, token, _ in self.calls))
        shutil.rmtree(self.workspace)

        with self.server() as second:
            api = self.client(second, lose=(location + "/recover",))
            page = api.pending()
            self.assertEqual(len(page["pending"]), 1)
            expected = page["pending"][0]["intent_id"]
            accepted = api.recover(*RUN, expected=expected)
            self.assertEqual(accepted["state"], "awaiting_publisher")
            self.assertTrue(accepted["intake_complete"])
            self.assertEqual(api.pending()["pending"], page["pending"])

        with self.server() as third:
            api = self.client(third, lose=(location + "/publisher",))
            ready = api.publisher(*RUN, self.receipt("match"), checkout=self.checkout)
            self.assertEqual(ready["state"], "publication_ready")
            self.assertTrue(ready["publication_ready"])
            self.assertFalse(ready["publication_verified"] or ready["training_approved"])
            self.assertEqual(ready["publisher_receipt"]["previous_pool_id"], E.fingerprint({"different": "previous"}))
        with self.server() as fourth:
            api = self.client(fourth)
            earlier = len(self.calls)
            replay = api.recover(*RUN, expected=expected)
            self.assertEqual(replay["intent"], ready["intent"])
            self.assertEqual(replay["publisher_receipt"], ready["publisher_receipt"])
            self.assertEqual(replay["generation_ack"], accepted["generation_ack"])
            self.assertEqual([call[0] for call in self.calls[earlier:]], ["GET"])
            self.assertEqual(api.pending()["pending"], page["pending"])
            for change in ({"publication_verified": True}, {"training_approved": True},
                           {"publisher_receipt": {**ready["publisher_receipt"], "receipt_id": E.fingerprint("foreign")}},
                           {"missing_object_ids": [self.object_id]}):
                forged = H.Client(COLLECTION, transport=lambda *_: (200, E.encoded({**ready, **change})))
                with self.assertRaises(H.HandoffError):
                    forged.read(*RUN)
        with ReceiptJournal(self.database) as journal:
            self.assertEqual(len(journal.generations()), 1)
            self.assertEqual(journal._db.execute("SELECT count(*) FROM nfl_collection_handoff_v1").fetchone()[0], 2)

    def disposition(self, expected):
        with self.server() as server:
            api = self.client(server)
            self.assertEqual(api.send(self.workspace, *RUN, INGEST,
                intake_transport=self.transport(server, INGEST))["state"], "awaiting_publisher")
            self.assertTrue(api.read(*RUN)["intake_complete"])
            path = self.receipt(expected)
            first = api.publisher(*RUN, path, checkout=self.checkout)
            second = api.publisher(*RUN, path, checkout=self.checkout)
            self.assertEqual(first["state"], "held_publisher_" + expected)
            self.assertEqual(first["publisher_receipt"], second["publisher_receipt"])
            self.assertFalse(first["publication_ready"])
            wrong = path.read_text(encoding="ascii").replace(f"{RUN[1]} {RUN[2]} ", f"{RUN[1]} 2 ")
            path.write_text(wrong, encoding="ascii")
            with self.assertRaises(ValueError):
                api.publisher(*RUN, path, checkout=self.checkout)

    def test_enqueue_reply_loss_recovers_original_worker_result(self):
        from contextlib import contextmanager
        from selflearn_core.adapters.nfl_publication_journal import NFLPublicationJournal
        from selflearn_core.store.learning_job_journal import LearningJobJournal

        authority = E.fingerprint("local publication authority")
        worker_token = "offline-publication-worker-" + "w" * 40
        env = {**ENV, "SELFLEARN_PUBLICATION_MODE": "record",
               "SELFLEARN_NFL_PUBLICATION_ORIGIN": "https://publication-fixture.example.com",
               "SELFLEARN_PUBLICATION_WORKER_MODE": "record",
               "SELFLEARN_PUBLICATION_WORKER_AUTHORITY_ID": authority,
               "SELFLEARN_NFL_PUBLICATION_WORKER_TOKEN": worker_token}
        observed = []
        raw = E.encoded(self.pool)

        def fetch(url):
            observed.append(url)
            return 200, {"Content-Type": "application/json"}, raw, url

        @contextmanager
        def pair():
            with LearningJobJournal(self.database, authority_id=authority) as jobs:
                with NFLPublicationJournal(self.database) as journal:
                    yield jobs, journal

        def app():
            return TestClient(create_app(store=object(), env=env,
                journal_factory=lambda: NFLPublicationJournal(self.database),
                collection_handoff_store=SQLiteCollectionHandoff,
                publication_transport=fetch, publication_job_factory=pair))

        path = H.BASE + "/" + "/".join(RUN) + "/publication"
        with app() as first:
            api = self.client(first, lose=(path,))
            api.send(self.workspace, *RUN, INGEST, intake_transport=self.transport(first, INGEST))
            ready = api.publisher(*RUN, self.receipt("match"), checkout=self.checkout)
            identity = ready["intent"]["intent_id"]
            queued = api.publication(*RUN, expected=identity, enqueue=True)
            self.assertEqual(queued["state"], "registered")
            self.assertFalse(queued["publication_verified"])
            self.assertEqual(sum(method == "POST" and route == path for method, route, _, _ in self.calls), 2)
            self.assertEqual(observed, [])

        shutil.rmtree(self.workspace)
        with app() as restarted:
            api = self.client(restarted)
            recovered = api.publication(*RUN, expected=identity)
            self.assertEqual(recovered["prepared"], queued["prepared"])
            self.assertEqual(recovered["job"]["snapshot"]["definition"], queued["job"]["snapshot"]["definition"])
            worker = restarted.post("/api/v1/nfl/publication-worker", json={"version": 1},
                                    headers={"Authorization": "Bearer " + worker_token})
            self.assertEqual(worker.status_code, 200, worker.text)
            finished = api.publication(*RUN, expected=identity)
            self.assertEqual(finished["prepared"], queued["prepared"])
            self.assertTrue(finished["publication_verified"])
            repeated = api.publication(*RUN, expected=identity, enqueue=True)
            self.assertEqual(repeated["job"]["attestation"], finished["job"]["attestation"])
            self.assertEqual(repeated["job"]["result"], finished["job"]["result"])
            self.assertEqual(observed, ["https://publication-fixture.example.com/data/leg_pool.json"])
            self.assertFalse(finished["training_approved"])
            self.assertEqual(api.pending()["pending"], [])
            with self.assertRaises(H.HandoffError):
                H.validate_publication({**finished, "intent_id": E.fingerprint("foreign")}, ready)

    def test_workflow_collection_is_opt_in_and_reports_transport_failure(self):
        from scripts import run_scheduled_collection as scheduled

        env = {"GITHUB_REPOSITORY": "liddar12/NFL2026", "GITHUB_REF": "refs/heads/main",
               "GITHUB_RUN_ID": RUN[1], "GITHUB_RUN_ATTEMPT": RUN[2],
               "RUNNER_TEMP": str(self.base), H.TOKEN_ENV: COLLECTION,
               "SELFLEARN_NFL_INGEST_TOKEN": INGEST}
        with patch.object(H, "Client", side_effect=AssertionError("collection access")) as client:
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(scheduled.run("before-publish", RUN[0], env=env), 0)
                self.assertEqual(scheduled.run("after-publish", RUN[0], env={
                    **env, "NFL_SELFLEARN_COLLECTION_MODE": "record", "GITHUB_REF": "refs/heads/other"
                }), 0)
            client.assert_not_called()
        self.assertIn('"status": "disabled"', output.getvalue())
        self.assertIn('"status": "outside_collection_scope"', output.getvalue())
        with (patch.object(D, "prepare", return_value={"ok": True}) as prepare,
              patch.object(H, "Client", side_effect=OSError("fixture private transport detail")),
              redirect_stdout(io.StringIO()) as output):
            self.assertEqual(scheduled.run("before-publish", RUN[0], env={
                **env, "NFL_SELFLEARN_COLLECTION_MODE": "record"
            }), 0)
        prepare.assert_called_once()
        self.assertIn("collection_phase_held", output.getvalue())
        self.assertNotIn("fixture private transport detail", output.getvalue())

    def test_noop_receipt(self):
        self.disposition("noop")

    def test_mismatched_commit_pool(self):
        self.disposition("mismatch")

    def test_unchanged_commit_pool(self):
        self.disposition("unchanged")

    def test_missing_original_then_late_recovery_is_read_only(self):
        with self.server() as server:
            api = self.client(server)
            result = api.send(self.workspace, *RUN, INGEST, intake_transport=self.transport(server, INGEST,
                skip=(E.OBJECT_ROUTE,)))
            self.assertEqual(result["state"], "awaiting_objects")
            self.assertIn(self.object_id, result["missing_object_ids"])
            self.assertEqual(api.pending()["pending"], [])
            earlier = len(self.calls)
            self.assertEqual(api.recover(*RUN)["missing_object_ids"], result["missing_object_ids"])
            self.assertEqual([call[0] for call in self.calls[earlier:]], ["GET"])
            result = api.send(self.workspace, *RUN, INGEST, intake_transport=self.transport(server, INGEST,
                skip=(E.GENERATION_ROUTE,)))
            self.assertEqual(result["state"], "ready_to_finalize")
        with self.server(late=True) as late:
            api = self.client(late)
            earlier = len(self.calls)
            recovered = api.recover(*RUN)
            self.assertEqual(recovered["state"], "held_late")
            self.assertIsNone(recovered["generation_ack"])
            self.assertEqual([call[0] for call in self.calls[earlier:]], ["GET"])
            self.assertEqual(api.pending()["pending"], [])
        with ReceiptJournal(self.database) as journal:
            self.assertIsNone(journal.generation_ack(self.object_id))

    def test_disabled_pilot_boundary_stops_all_collection_writes(self):
        with self.server() as server:
            api = self.client(server)
            refused = D.capture.PilotCaptureError("pilot_disabled_pin_required")
            with patch.object(D.capture, "disabled_config", side_effect=refused):
                with self.assertRaises(D.capture.PilotCaptureError):
                    api.send(self.workspace, *RUN, INGEST)
                with self.assertRaises(D.capture.PilotCaptureError):
                    api.publisher(*RUN, self.receipt("noop"), checkout=self.checkout)
            self.assertEqual(self.calls, [])
            result = api.send(self.workspace, *RUN, INGEST,
                intake_transport=self.transport(server, INGEST, skip=(E.GENERATION_ROUTE,)))
            self.assertEqual(result["state"], "ready_to_finalize")
            earlier = len(self.calls)
            with patch.object(D.capture, "disabled_config", side_effect=refused):
                with self.assertRaises(D.capture.PilotCaptureError):
                    api.recover(*RUN)
            self.assertEqual([call[0] for call in self.calls[earlier:]], ["GET"])
            with self.assertRaisesRegex(H.HandoffError, "^collection_intent_conflict$"):
                api.recover(*RUN, expected=E.fingerprint("other intent"))
        with ReceiptJournal(self.database) as journal:
            self.assertIsNone(journal.generation_ack(self.object_id))

    def test_bounded_paging_checks_cursor_and_scope_and_stops_on_refusal(self):
        stamps = {"version": 1, "observed_utc": stamp(datetime.now(timezone.utc))}
        cursor = "sha256:" + "1" * 64
        outputs = iter(({**stamps, "pending": [], "next_after": cursor}, {**stamps, "pending": [], "next_after": cursor}))
        routes = []

        def page(method, path, body):
            routes.append(path)
            self.assertEqual((method, body), ("GET", None))
            return 200, E.encoded(next(outputs))
        api = H.Client(COLLECTION, transport=page)
        with self.assertRaises(H.HandoffError):
            api.pending(pages=3)
        self.assertEqual(routes, [H.BASE + "/pending?limit=16", H.BASE + "/pending?limit=16&after=sha256%3A" + "1" * 64])
        for bad in ("../objects", "daily.yml/10001/1/publisher", "other.yml"):
            with self.assertRaises(H.HandoffError):
                api.read(bad, "10001", "1")
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("credential leak")) as opener:
            call = H._https(COLLECTION)
            with self.assertRaises(H.HandoffError):
                call("GET", "@external.example/a", None)
            opener.assert_not_called()
        redirect = H.Client(COLLECTION, transport=lambda *_: (307, COLLECTION.encode()))
        with self.assertRaisesRegex(H.HandoffError, "^collection_redirect_refused$"):
            redirect.read(*RUN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-checkout", required=True, type=Path)
    parser.add_argument("--expected-engine-sha")
    args = parser.parse_args()
    root = args.engine_checkout.resolve()
    found = git(root, "rev-parse", "HEAD")
    if args.expected_engine_sha:
        if found != args.expected_engine_sha or git(root, "status", "--porcelain"):
            parser.error("engine checkout differs from the pinned clean source")
    else:
        print("Local in-flight engine source fixture at " + found)
    sys.path[:0] = [str(root), str(root / "packages" / "selflearn-core")]
    global TestClient, SQLiteCollectionHandoff, ReceiptJournal, create_app
    from fastapi.testclient import TestClient
    from selflearn_core.adapters.nfl_collection_handoff import SQLiteCollectionHandoff
    from selflearn_core.store.receipt_journal import ReceiptJournal
    from services.web.application import create_app
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(HandoffAcceptance)
    expected = suite.countTestCases()
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return not (expected > 0 and result.testsRun == expected and not result.skipped
                and result.wasSuccessful())


if __name__ == "__main__":
    raise SystemExit(main())
