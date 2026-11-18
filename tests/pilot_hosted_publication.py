#!/usr/bin/env python3
"""Actual NFL exporters -> actual engine handlers -> real temporary SQLite.

Synthetic future games, credentials and injected public HTTP bytes are explicit
test inputs. This does not prove deployed HTTP, native PostgreSQL, settlement or
model improvement. No production reads/writes or network fallback are allowed.
"""
import argparse
from contextlib import redirect_stderr, redirect_stdout
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
ENGINE_COMMIT = "5e68953989b95731503d9e909ede7d4279b2a570"
PUBLIC_ORIGIN = "https://publication-fixture.example.com"
INGEST = "offline-publication-ingest-" + "i" * 40
OWNER = "offline-publication-owner-" + "o" * 40
PUBLICATION = "offline-publication-token-" + "p" * 40
WORKER = "offline-publication-worker-" + "w" * 40
WORKER_AUTHORITY = "sha256:" + hashlib.sha256(b"offline real-producer publication worker authority").hexdigest()
WORKER_ROUTE = "/api/v1/nfl/publication-worker"


def utc(value):
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True,
                                   stderr=subprocess.DEVNULL).strip()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def tree(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


class FakeStore:
    def status(self):
        return {"schema_version": 1, "predictions": 0, "outcomes": 0, "models": 0}


class HostedPublication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="nfl-publication-acceptance-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.inputs = self.base / "inputs"
        self.inputs.mkdir()
        self.workspace = self.base / "workspace"
        self.db_path = self.base / "journal.sqlite"
        now = datetime.now(timezone.utc)
        self.prepare_fixture(now, kickoff=now + timedelta(hours=1), name="synthetic-seed")
        self.fetch_calls = []
        self.forbid_fetch = False
        self.db_clock = None
        self.forbid_db_clock = False
        owner = self

        class FixtureJournal(NFLPublicationJournal):
            def _publication_recorded_utc(journal):
                if owner.forbid_db_clock:
                    raise AssertionError("replay must recover before a new database timestamp")
                return owner.db_clock or super()._publication_recorded_utc()

        self.journal = FixtureJournal
        self.addCleanup(patch.stopall)
        patch("socket.create_connection", side_effect=AssertionError("network forbidden")).start()
        patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("network forbidden")).start()

    def prepare_fixture(self, now, *, kickoff, name):
        self.created, self.recorded = utc(now - timedelta(minutes=3)), utc(now - timedelta(minutes=2))
        self.kickoff = utc(kickoff)
        with patch.object(F, "KICKOFF", self.kickoff):
            _, self.pool, schedule = F.generation(self.base / name, created=self.created)
        for filename, payload in (("leg_pool", self.pool), ("schedule_full", schedule), ("parlay_backtest", None)):
            (self.inputs / (filename + ".json")).write_text(json.dumps(payload), encoding="utf-8")
        result = D.prepare(self.inputs, self.workspace, execute=True, clock=lambda: self.recorded)
        self.assertIs(result["ok"], True)
        self.original_id = result["envelope_id"]
        self.public_pool = self.pool


    def fetch(self, url):
        self.assertFalse(self.forbid_fetch, "existing attestation must recover without another public fetch")
        self.assertEqual(url, PUBLIC_ORIGIN + "/data/leg_pool.json")
        self.fetch_calls.append(url)
        return 200, {"Content-Type": "application/json"}, json.dumps(self.public_pool, indent=2).encode(), url


    def client(self, origin=PUBLIC_ORIGIN, worker=False):
        env = {"SELFLEARN_OPERATOR_TOKEN": OWNER, "SELFLEARN_NFL_INGEST_TOKEN": INGEST,
            "SELFLEARN_NFL_PUBLICATION_TOKEN": PUBLICATION,
            "SELFLEARN_PUBLICATION_MODE": "record", "SELFLEARN_NFL_PUBLICATION_ORIGIN": origin}
        options = {}
        if worker:
            # Import only after main() establishes the explicitly pinned engine
            # path. Both real persistence ports open this same temporary file.
            from selflearn_core.store.learning_job_journal import LearningJobJournal
            @contextmanager
            def paired():
                with LearningJobJournal(self.db_path, authority_id=WORKER_AUTHORITY) as jobs, \
                        self.journal(self.db_path) as journal:
                    yield jobs, journal
            options["publication_job_factory"] = paired
            env.update(SELFLEARN_PUBLICATION_WORKER_MODE="record",
                SELFLEARN_PUBLICATION_WORKER_AUTHORITY_ID=WORKER_AUTHORITY,
                SELFLEARN_NFL_PUBLICATION_WORKER_TOKEN=WORKER)
        return TestClient(create_app(store=FakeStore(), journal_factory=lambda: self.journal(self.db_path),
            publication_transport=self.fetch, env=env, **options))


    def ingest(self, client):
        def send(route, body):
            response = client.post(route, content=body, headers={"Authorization": "Bearer " + INGEST,
                                                                 "Content-Type": "application/json"})
            return response.status_code, response.content
        return D.deliver(self.workspace, INGEST, transport=send, sleep=lambda _: None)


    def snapshot(self):
        with self.journal(self.db_path) as journal:
            return journal.receipts(), journal.generations(), journal.get_publication_attestation(self.original_id)


    def queue_plan(self):
        return Q.plan(self.workspace, PUBLIC_ORIGIN, ENGINE_ROOT, WORKER_AUTHORITY)


    def queue_transport(self, client, calls):
        def send(method, path, body):
            calls.append((method, path))
            self.assertIn(method, ("GET", "POST"))
            self.assertTrue(path.startswith("/api/v2/nfl/publication-job"), path)
            response = client.request(method, path, content=body,
                headers={"Authorization": "Bearer " + PUBLICATION, "Content-Type": "application/json"})
            return response.status_code, response.content
        return send


    def run_worker(self, client):
        response = client.post(WORKER_ROUTE, json={"version": 1},
            headers={"Authorization": "Bearer " + WORKER})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["recording_complete"], response.text)
        return response.json()

    def publisher_fixture(self):
        repo = self.base / "publisher-repo"
        repo.mkdir()
        git(repo, "init", "--quiet")
        git(repo, "config", "user.name", "Offline publisher fixture")
        git(repo, "config", "user.email", "publisher@example.invalid")
        (repo / "data").mkdir()
        path = repo / "data" / "leg_pool.json"

        def commit(pool, label):
            path.write_text(json.dumps(pool, indent=2), encoding="utf-8")
            (repo / "data" / "stage.txt").write_text(label, encoding="utf-8")
            git(repo, "add", "data")
            git(repo, "commit", "--quiet", "-m", label)
            return git(repo, "rev-parse", "HEAD")

        # A fallback preserves the previous pool. Only its generation metadata
        # differs from the candidate, so comparing just the legs would pass.
        previous = {**self.pool, "generated_utc": "2026-01-01T00:00:00Z"}
        commit(previous, "previous public pool")
        fallback = commit(previous, "fallback retains prior pool")
        changed = commit(self.pool, "publish captured pool")
        unchanged = commit(self.pool, "other content changes")
        return repo, fallback, changed, unchanged

    def publisher_send(self, repo, client, commit, calls, *, receipt_attempt="2", run_attempt="2"):
        path = self.base / "published-data.txt"
        path.write_text(f"123 {receipt_attempt} {commit}\n", encoding="ascii")
        real_disposition = Q.publisher_disposition
        with patch.dict(os.environ, {"SELFLEARN_NFL_PUBLICATION_TOKEN": PUBLICATION,
                                     "SELFLEARN_NFL_INGEST_TOKEN": INGEST}), \
                patch.object(Q, "publisher_disposition", side_effect=lambda value, revision:
                    real_disposition(value, revision, checkout=repo)), \
                patch.object(Q, "http_transport", return_value=self.queue_transport(client, calls)), \
                redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            result = Q.main(["--workspace", str(self.workspace), "--expected-public-origin", PUBLIC_ORIGIN,
                             "--engine-checkout", str(ENGINE_ROOT), "--authority-id", WORKER_AUTHORITY,
                             "--send", "--publisher-receipt", str(path), "--publisher-run-id", "123",
                             "--publisher-run-attempt", run_attempt])
        return result, json.loads(stdout.getvalue() or stderr.getvalue())

    def test_fallback_and_unchanged_publisher_commits_cannot_register(self):
        repo, fallback, changed, unchanged = self.publisher_fixture()
        calls = []
        with self.client(worker=True) as client:
            first = self.ingest(client)
            self.assertTrue(first["durable_ack_validated"], first)
            intake_before = tree(self.workspace / "delivery")
            recovered = self.ingest(client)
            self.assertTrue(recovered["durable_ack_validated"], recovered)
            self.assertEqual(recovered["transport_calls"], 0)
            self.assertEqual(tree(self.workspace / "delivery"), intake_before)

            exit_code, result = self.publisher_send(repo, client, fallback, calls)
            self.assertEqual((exit_code, result["reason"]), (2, "queue_published_pool_mismatch"))
            exit_code, result = self.publisher_send(repo, client, changed, calls, receipt_attempt="1")
            self.assertEqual((exit_code, result["reason"]), (2, "queue_publisher_receipt_invalid"))
            for revision, disposition in ((unchanged, "unchanged"), ("noop", "noop")):
                exit_code, result = self.publisher_send(repo, client, revision, calls)
                self.assertEqual((exit_code, result["status"]), (0, "skipped_publisher_" + disposition))
            self.assertEqual(calls, [])

            exit_code, queued = self.publisher_send(repo, client, changed, calls)
            self.assertEqual(exit_code, 0, queued)
            self.assertTrue(queued["job_registered"])
            self.assertEqual(sum(method == "POST" for method, _ in calls), 1)
            self.assertEqual(self.fetch_calls, [])

            # The commit is only a handoff. The actual public response must
            # match, including the same generation metadata, before recording.
            self.public_pool = {**self.pool, "generated_utc": "2026-01-01T00:00:00Z"}
            pending = client.post(WORKER_ROUTE, json={"version": 1},
                headers={"Authorization": "Bearer " + WORKER})
            self.assertEqual((pending.status_code, pending.json()["status"]), (200, "pending"))
            self.assertIsNone(self.snapshot()[2])

            self.public_pool = self.pool
            self.run_worker(client)
            original = self.snapshot()[2]
            self.forbid_fetch = self.forbid_db_clock = True
            self.assertEqual(original["source_pool_id"], E.fingerprint(self.pool))
            raw_body = json.dumps(self.pool, indent=2).encode()
            self.assertEqual(original["observation"]["body_sha256"], "sha256:" + hashlib.sha256(raw_body).hexdigest())
            for revision in (unchanged, "noop"):
                read_calls = []
                exit_code, result = self.publisher_send(repo, client, revision, read_calls)
                self.assertEqual(exit_code, 0, result)
                self.assertTrue(result["publication_verified"], result)
                self.assertEqual(result["attestation_id"], original["attestation_id"])
                self.assertEqual([method for method, _ in read_calls], ["GET"])
            self.assertEqual(self.snapshot()[2], original)
            self.assertEqual(len(self.fetch_calls), 2)

    def test_late_prepare_and_send_cannot_refresh_the_capture_clock_or_register(self):
        before = tree(self.workspace / "snapshots")
        replay = D.prepare(self.inputs, self.workspace, execute=True, clock=lambda: self.kickoff)
        self.assertEqual((replay["envelope_id"], replay["recorded_utc"]), (self.original_id, self.recorded))
        self.assertEqual(tree(self.workspace / "snapshots"), before)
        fresh_workspace = self.base / "late-capture"
        fresh = D.prepare(self.inputs, fresh_workspace, execute=True, clock=lambda: self.kickoff)
        self.assertEqual(fresh["status"], "no_eligible_forecasts")
        self.assertFalse(fresh_workspace.exists())

        calls = []
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            result = Q.send(self.queue_plan(), PUBLICATION, clock=lambda: self.kickoff,
                transport=self.queue_transport(client, calls), sleep=lambda _: None)
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["reason"], "queue_no_remaining_preevent_members")
            self.assertFalse(any(method == "POST" for method, _ in calls))
        self.assertEqual(tree(self.workspace / "snapshots"), before)
        self.assertEqual(self.fetch_calls, [])

    def test_matching_public_pool_first_observed_after_kickoff_is_withheld(self):
        self.workspace = self.base / "already-started"
        now = datetime.now(timezone.utc)
        self.prepare_fixture(now, kickoff=now - timedelta(minutes=1), name="late-observation-fixture")
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            send = self.queue_transport(client, [])
            # Inject only the producer guard's clock to exercise recovery of a
            # queued generation whose actual first worker observation is late.
            queued = Q.send(self.queue_plan(), PUBLICATION, clock=lambda: self.recorded,
                transport=send, sleep=lambda _: None)
            self.assertTrue(queued["job_registered"], queued)
            self.run_worker(client)
            finished = Q.status(self.queue_plan(), PUBLICATION, transport=send, sleep=lambda _: None)
            self.assertTrue(finished["recording_complete"], finished)
            self.assertFalse(finished["publication_verified"], finished)
            self.assertEqual(finished["publication_status"], "withheld")
            self.assertGreater(finished["rejected_receipts"], 0)
            self.assertEqual(len(self.fetch_calls), 1)

    def test_concurrent_prepare_leaves_original_generation_untouched(self):
        original = tree(self.workspace)
        descriptor = os.open(self.workspace, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(D.DeliveryError, "delivery_workspace_busy"):
                D.prepare(self.inputs, self.workspace, execute=True)
        finally:
            os.close(descriptor)
        self.assertEqual(tree(self.workspace), original)
        replay = D.prepare(self.inputs, self.workspace, execute=True)
        self.assertEqual(replay["envelope_id"], self.original_id)

    def test_lost_intake_finalize_reply_recovers_original_partition(self):
        with self.client() as client:
            calls = []

            def lose_reply(route, body):
                calls.append(route)
                response = client.post(route, content=body,
                    headers={"Authorization": "Bearer " + INGEST, "Content-Type": "application/json"})
                self.assertEqual(response.status_code, 200, response.text)
                if route == E.GENERATION_ROUTE:
                    raise TimeoutError("synthetic lost finalize reply")
                return response.status_code, response.content

            first = D.deliver(self.workspace, INGEST, transport=lose_reply, attempts=1, sleep=lambda _: None)
            self.assertFalse(first["durable_ack_validated"], first)
            self.assertEqual(calls.count(E.GENERATION_ROUTE), 1)
            stored = self.snapshot()[:2]
        with self.client() as restarted:
            recovered = self.ingest(restarted)
            self.assertTrue(recovered["durable_ack_validated"], recovered)
            self.assertEqual(recovered["transport_calls"], 1)
        self.assertEqual(self.snapshot()[:2], stored)


    def test_queue_sender_pins_declared_job_and_reads_completed_original_after_restart(self):
        calls = []
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            originals, frozen = self.snapshot()[:2], tree(self.workspace / "snapshots")
            before = tree(self.workspace)
            preview = self.queue_plan()
            self.assertFalse(preview["prepared"])
            self.assertEqual(tree(self.workspace), before)
            queued = Q.send(preview, PUBLICATION, transport=self.queue_transport(client, calls), sleep=lambda _: None)
            self.assertTrue(queued["ok"], queued)
            self.assertTrue(queued["job_registered"], queued)
            self.assertFalse(queued["recording_complete"], queued)
            self.assertFalse(queued["publication_verified"], queued)
            self.assertEqual(self.fetch_calls, [])
        with self.client(worker=True) as restarted:
            self.run_worker(restarted)
            read_calls = []
            completed = Q.status(self.queue_plan(), PUBLICATION,
                transport=self.queue_transport(restarted, read_calls), sleep=lambda _: None)
            self.assertTrue(completed["ok"], completed)
            self.assertTrue(completed["current_status_fresh"], completed)
            self.assertTrue(completed["recording_complete"], completed)
            self.assertTrue(completed["publication_verified"], completed)
            self.assertFalse(completed["remote_engine_commit_verified"], completed)
            self.assertTrue(all(method == "GET" for method, _ in read_calls))
            self.assertEqual(len(self.fetch_calls), 1)
            self.forbid_fetch = True
            again = Q.send(self.queue_plan(), PUBLICATION,
                transport=self.queue_transport(restarted, read_calls), sleep=lambda _: None)
            self.assertTrue(again["recording_complete"], again)
            self.assertEqual(len(self.fetch_calls), 1)
            self.assertTrue(all(method == "GET" for method, _ in read_calls))
        self.assertEqual(self.snapshot()[:2], originals)
        self.assertEqual(tree(self.workspace / "snapshots"), frozen)


    def test_queue_lost_enqueue_ack_recovers_same_job_after_server_code_changes(self):
        from services.web import nfl_publication_jobs as worker_module
        calls, changed = [], []
        self.addCleanup(lambda: [context.stop() for context in changed])
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            send = self.queue_transport(client, calls)
            lost = False
            def lose_ack(method, path, body):
                nonlocal lost
                response = send(method, path, body)
                if method == "POST" and not lost:
                    self.assertEqual(response[0], 200, response[1])
                    lost = True
                    context = patch.object(worker_module, "code_identity", return_value="sha256:" + "e" * 64)
                    changed.append(context); context.start()
                    raise TimeoutError("explicit synthetic lost enqueue response")
                return response
            Q.send(self.queue_plan(), PUBLICATION, transport=lose_ack, attempts=1, sleep=lambda _: None)
            self.assertTrue(lost)
        with self.client(worker=True) as restarted:
            recovery_calls = []
            recovered = Q.send(self.queue_plan(), PUBLICATION,
                transport=self.queue_transport(restarted, recovery_calls), sleep=lambda _: None)
            self.assertTrue(recovered["job_registered"], recovered)
            self.assertTrue(all(method == "GET" for method, _ in recovery_calls))
            self.assertFalse(any(path.endswith("publication-job-policy") for _, path in recovery_calls))
        with self.journal(self.db_path) as journal:
            self.assertEqual(journal._db.execute("SELECT count(*) FROM learning_jobs_v1").fetchone()[0], 1)
        self.assertEqual(self.fetch_calls, [])


    def test_queue_contract_change_before_registration_refuses_without_starting_a_new_job(self):
        from services.web import nfl_publication_jobs as worker_module
        calls, changed = [], []
        self.addCleanup(lambda: [context.stop() for context in changed])
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            send = self.queue_transport(client, calls)
            def redeploy_after_declaration(method, path, body):
                response = send(method, path, body)
                if path.endswith("publication-job-policy"):
                    self.assertEqual(response[0], 200, response[1])
                    context = patch.object(worker_module, "code_identity", return_value="sha256:" + "d" * 64)
                    changed.append(context); context.start()
                return response
            refused = Q.send(self.queue_plan(), PUBLICATION,
                transport=redeploy_after_declaration, sleep=lambda _: None)
            self.assertFalse(refused["ok"], refused)
            self.assertFalse(refused["job_registered"], refused)
            retry_calls = []
            retry = Q.send(self.queue_plan(), PUBLICATION,
                transport=self.queue_transport(client, retry_calls), sleep=lambda _: None)
            self.assertFalse(retry["job_registered"], retry)
            self.assertFalse(any(path.endswith("publication-job-policy") for _, path in retry_calls))
        with self.journal(self.db_path) as journal:
            self.assertEqual(journal._db.execute("SELECT count(*) FROM learning_jobs_v1").fetchone()[0], 0)
        self.assertEqual(self.fetch_calls, [])


    def test_queue_known_registration_missing_readback_never_recreates_it(self):
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            self.assertTrue(Q.send(self.queue_plan(), PUBLICATION,
                transport=self.queue_transport(client, []), sleep=lambda _: None)["job_registered"])
            calls = []
            def absent(method, path, body):
                calls.append((method, path))
                self.assertEqual(method, "GET", "known registrations must never be recreated")
                return 404, b'{"detail":"synthetic missing readback"}'
            held = Q.send(self.queue_plan(), PUBLICATION, transport=absent, sleep=lambda _: None)
            self.assertFalse(held["ok"], held)
            self.assertFalse(held["current_status_fresh"], held)
            self.assertTrue(calls)


    def test_queue_refuses_valid_but_regressed_history_after_recording_completion(self):
        captured = []
        with self.client(worker=True) as client:
            self.assertTrue(self.ingest(client)["ok"])
            send = self.queue_transport(client, [])
            def capture_queued(method, path, body):
                response = send(method, path, body)
                if method == "POST" and response[0] == 200:
                    captured.append(response[1])
                return response
            self.assertTrue(Q.send(self.queue_plan(), PUBLICATION,
                transport=capture_queued, sleep=lambda _: None)["job_registered"])
            self.assertEqual(len(captured), 1)
            self.run_worker(client)
            completed = Q.status(self.queue_plan(), PUBLICATION, transport=send, sleep=lambda _: None)
            self.assertTrue(completed["recording_complete"], completed)
            held = Q.status(self.queue_plan(), PUBLICATION,
                transport=lambda method, path, body: (200, captured[0]), sleep=lambda _: None)
            self.assertFalse(held["ok"], held)
            self.assertFalse(held["current_status_fresh"], held)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-checkout", type=Path, required=True)
    parser.add_argument("--nfl-checkout", type=Path, required=True)
    args = parser.parse_args()
    engine, nfl = args.engine_checkout.resolve(), args.nfl_checkout.resolve()
    if nfl != ROOT or Path(git(nfl, "rev-parse", "--show-toplevel")).resolve() != ROOT:
        parser.error("--nfl-checkout must identify this script's current worktree")
    if (Path(git(engine, "rev-parse", "--show-toplevel")).resolve() != engine
            or git(engine, "rev-parse", "HEAD") != ENGINE_COMMIT or git(engine, "status", "--porcelain=v1")):
        parser.error("engine must be the exact clean publication checkpoint")
    sys.path[:0] = [str(nfl), str(engine), str(engine / "packages/selflearn-core")]
    global F, D, E, Q, ENGINE_ROOT, TestClient, create_app, NFLPublicationJournal
    ENGINE_ROOT = engine
    from fastapi.testclient import TestClient
    from services.web.application import create_app
    from selflearn_core.adapters.nfl_publication_journal import NFLPublicationJournal
    from scripts import export_learning as E, run_forecast_delivery as D
    from scripts import queue_publication as Q
    if Path(sys.modules[create_app.__module__].__file__).resolve() != engine / "services/web/application.py":
        parser.error("engine handlers resolved outside selected checkout")
    F = load("offline_actual_nfl_publication_fixture", nfl / "tests/fixtures/week6_outcomes.py")
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(HostedPublication)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if git(engine, "rev-parse", "HEAD") != ENGINE_COMMIT or git(engine, "status", "--porcelain=v1"):
        raise SystemExit("engine identity or cleanliness changed during acceptance")
    raise SystemExit(0 if result.wasSuccessful() and result.testsRun >= 10 and not result.skipped else 1)


if __name__ == "__main__":
    main()
