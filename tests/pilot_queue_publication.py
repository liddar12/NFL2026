#!/usr/bin/env python3
"""Explicit pinned-core queue/outbox contracts with real SQLite job histories.

HTTP responses are injected from real job/publication ports. This is local
protocol evidence, not a deployed worker, provider origin or cloud durability.
"""
import argparse
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from urllib.parse import unquote

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
ORIGIN="https://publication-queue.example.com"
TOKEN="local-publication-queue-"+"p"*40
INGEST="local-ingest-queue-"+"i"*40


def tree(root):return {str(p.relative_to(root)):p.read_bytes() for p in root.rglob("*") if p.is_file()}


class Server:
    def __init__(self,case):
        self.case=case;self.code=E.fingerprint("declared hosted code fixture")
        self.policy=P.policy(ORIGIN);self.calls=[];self.force_view=None
        self.lose_post=False;self.race_code=False;self.missing=False
    def declaration(self):
        return {"version":2,"authority_id":AUTHORITY,"code_id":self.code,"policy":self.policy,
                "settings":A.settings(self.policy)}
    def spec(self):
        pub=P.plan(self.case.workspace,ORIGIN)
        return A.definition(pub["request"]["object_id"],pub["generation_id"],pub["generation_recorded_utc"],
            [r["event_start_utc"] for r in pub["members"]],self.policy,self.code,AUTHORITY)
    def view(self,identity):
        current=self.case.jobs.read_job(identity)
        spec=current["definition"]
        def wrap(oid):return A.object_wrapper(oid,self.case.jobs.get_object(oid)["payload"])
        return {"version":2,"snapshot":current,"input":wrap(spec["input_object_id"]),
            "policy":wrap(spec["policy_object_id"]),
            "result":wrap(current["state"]["result_object_id"]) if current["effective_status"]=="succeeded" else None,
            "attestation":self.case.journal.get_publication_attestation(self.case.object_id)}
    def __call__(self,method,path,body):
        self.calls.append((method,path,body))
        self.case.assertNotIn("worker",path)
        if method=="GET" and path==Q.DECLARATION:return 200,E.encoded(self.declaration())
        if method=="GET":
            self.case.assertTrue(path.startswith(Q.BASE+"/"));self.case.assertIsNone(body)
            identity=unquote(path.rsplit("/",1)[1])
            if self.missing:return 404,b""
            try:view=self.view(identity)
            except ValueError:
                if self.race_code:self.code=E.fingerprint("new deployment code")
                return 404,b""
            return 200,E.encoded(self.force_view if self.force_view is not None else view)
        self.case.assertEqual((method,path),("POST",Q.BASE))
        request=E._json(body)
        self.case.assertEqual(set(request),{"version","object_id","expected_job_id","expected_definition_id"})
        self.case.assertEqual(request["version"],2)
        try:view=self.view(request["expected_job_id"])
        except ValueError:
            spec,inputs,settings=self.spec()
            if (request["expected_job_id"],request["expected_definition_id"])!=(spec["job_id"],spec["definition_id"]):return 409,b""
            for value in (inputs,settings):self.case.jobs.append_object("source_snapshot",E.fingerprint(value),value)
            self.case.jobs.register_job(spec);view=self.view(spec["job_id"])
        if self.lose_post:self.lose_post=False;raise TimeoutError("lost durable enqueue reply")
        return 200,E.encoded(view)
    def proof(self,identity):
        current=self.case.jobs.read_job(identity);spec=current["definition"]
        settings=self.case.jobs.get_object(spec["policy_object_id"])["payload"]
        now=P.capture.now()
        return self.case.journal.commit_publication_attestation(self.case.object_id,
            {"version":1,"policy":settings["publication_policy"],"observed_started_utc":now,
             "observed_completed_utc":now,"http_status":200,"body_utf8":json.dumps(self.case.pool)})
    def complete(self,identity):
        current=self.case.jobs.read_job(identity)
        def command(action,object_id=None):
            return DTO.seal_command({"version":1,"kind":"selflearn.job_command.v1","job_id":identity,
                "expected_head_event_id":current["head_event_id"],"action":action,"worker_id":"local-test-worker",
                "lease_id":None if action=="claim" else current["state"]["lease_id"],
                "object_id":object_id,"reason_code":None},authority_id=AUTHORITY)
        self.case.jobs.append_job_command(command("claim"));current=self.case.jobs.read_job(identity)
        spec=current["definition"];inputs=self.case.jobs.get_object(spec["input_object_id"])["payload"]
        proof=self.proof(identity);result=A.result(spec,inputs,proof);result_id=E.fingerprint(result)
        self.case.jobs.append_object("source_snapshot",result_id,result)
        self.case.jobs.append_job_command(command("complete",result_id))
        return self.view(identity)


class QueueContracts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="publication-queue-contract-");self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.workspace=self.root/"workspace"
        with patch.object(F,"KICKOFF","2099-09-02T00:15:00Z"):
            _,self.pool,schedule=F.generation(self.root/"fixture-seed")
        P.capture.capture_generation(self.pool,schedule,None,workspace=self.workspace,execute=True,clock=lambda:F.RECORDED)
        self.journal=PublicationJournal(self.root/"journal.sqlite");self.addCleanup(self.journal.close)
        self.jobs=JobJournal(self.root/"journal.sqlite",authority_id=AUTHORITY);self.addCleanup(self.jobs.close)
        graph=E.plan(self.workspace/"snapshots");self.object_id=graph["generations"][0]["request"]["object_id"]
        def ingest(route,body):
            request=E._json(body)
            if route==E.OBJECT_ROUTE:
                self.journal.append_object(request["kind"],request["object_id"],request["payload"])
                return 200,E.encoded({"version":1,"object_id":request["object_id"],"durable":True,"status":"recorded"})
            return 200,E.encoded(finalize_generation(self.journal,request["object_id"]))
        self.assertTrue(E.send(graph,P.ORIGIN,self.workspace/"delivery",INGEST,transport=ingest,sleep=lambda _:None)["ok"])
        self.server=Server(self)
    def plan(self,code=None):return Q.plan(self.workspace,ORIGIN,ENGINE,AUTHORITY,code)
    def send(self,value=None,**kwargs):return Q.send(value or self.plan(),TOKEN,transport=self.server,sleep=lambda _:None,**kwargs)
    def status(self,**kwargs):return Q.status(self.plan(),TOKEN,transport=self.server,sleep=lambda _:None,**kwargs)

    def test_preview_reads_no_credentials_network_or_writes(self):
        before=tree(self.workspace);output=io.StringIO();get=os.environ.get
        def guarded(key,*args):
            if "TOKEN" in key or "SECRET" in key:raise AssertionError("credential access")
            return get(key,*args)
        with patch.object(os.environ,"get",side_effect=guarded),patch.object(Q,"http_transport",side_effect=AssertionError("HTTP")),redirect_stdout(output):
            code=Q.main(["--workspace",str(self.workspace),"--expected-public-origin",ORIGIN,
                         "--engine-checkout",str(ENGINE),"--authority-id",AUTHORITY])
        self.assertEqual(code,0);value=E._json(output.getvalue().encode())
        self.assertEqual(value["status"],"preview_not_prepared")
        self.assertFalse(value["recording_complete"]);self.assertEqual(tree(self.workspace),before)

    def test_real_sqlite_registration_progress_completion_and_restart(self):
        frozen=tree(self.workspace/"snapshots");intake=tree(self.workspace/"delivery")
        first=self.send();self.assertTrue(first["ok"],first)
        self.assertTrue(first["job_registered"]);self.assertFalse(first["recording_complete"])
        self.assertFalse(first["publication_verified"])
        self.assertEqual(sum(path==Q.DECLARATION for _,path,_ in self.server.calls),1)
        job=first["job_id"];self.server.complete(job)
        self.server.calls.clear();complete=self.status()
        self.assertTrue(complete["recording_complete"],complete)
        self.assertTrue(complete["publication_verified"])
        self.assertTrue(complete["current_status_fresh"])
        self.assertEqual({method for method,_,_ in self.server.calls},{"GET"})
        moved=self.root/"restored";shutil.copytree(self.workspace,moved)
        value=Q.plan(moved,ORIGIN,ENGINE,AUTHORITY);self.server.calls.clear()
        retry=Q.status(value,TOKEN,transport=self.server,sleep=lambda _:None)
        self.assertEqual(retry["attestation_id"],complete["attestation_id"])
        self.assertTrue(retry["recording_complete"])
        self.assertEqual(tree(self.workspace/"snapshots"),frozen);self.assertEqual(tree(self.workspace/"delivery"),intake)

    def test_lost_enqueue_reply_recovers_original_before_another_post(self):
        self.server.lose_post=True;first=self.send()
        self.assertTrue(first["job_registered"],first)
        self.assertEqual(sum(method=="POST" for method,_,_ in self.server.calls),1)
        self.server.code=E.fingerprint("new deployment after original job")
        self.server.calls.clear();again=self.send()
        self.assertEqual(again["job_id"],first["job_id"])
        self.assertEqual({method for method,_,_ in self.server.calls},{"GET"})
        self.assertNotIn(Q.DECLARATION,[path for _,path,_ in self.server.calls])

    def test_contract_race_never_adopts_new_code_or_creates_another_job(self):
        self.server.race_code=True;result=self.send()
        self.assertFalse(result["ok"],result)
        value=self.plan();original_id=value["expected_spec"]["job_id"]
        self.assertNotEqual(value["declaration"]["code_id"],self.server.code)
        self.server.calls.clear();again=self.send()
        self.assertFalse(again["ok"])
        self.assertNotIn(Q.DECLARATION,[p for _,p,_ in self.server.calls])
        with self.assertRaises(ValueError):self.jobs.read_job(original_id)

    def test_known_registration_disappearing_never_posts_or_resets_history(self):
        first=self.send();self.assertTrue(first["ok"])
        self.server.missing=True;self.server.calls.clear();held=self.send()
        self.assertFalse(held["ok"]);self.assertEqual(held["reason"],"queue_registered_readback_missing")
        self.assertEqual({m for m,_,_ in self.server.calls},{"GET"})

    def test_queued_cache_is_never_current_and_status_never_enqueues(self):
        first=self.send();self.server.calls.clear()
        preview=Q.preview(self.plan())
        self.assertFalse(preview["current_status_fresh"]);self.assertFalse(preview["recording_complete"])
        observed=self.status();self.assertTrue(observed["current_status_fresh"])
        self.assertEqual(observed["effective_job_status"],"queued")
        self.assertEqual({m for m,_,_ in self.server.calls},{"GET"})

    def test_full_history_regression_is_rejected_without_overwriting_newer_proof(self):
        first=self.send();old=self.server.view(first["job_id"])
        self.server.complete(first["job_id"]);self.assertTrue(self.status()["recording_complete"])
        _,target,_=Q._paths(self.plan());before=tree(target/"observations")
        self.server.force_view=old;regressed=self.status()
        self.assertFalse(regressed["ok"]);self.assertEqual(tree(target/"observations"),before)
        self.server.force_view=None;self.assertTrue(self.status()["recording_complete"])

    def test_proof_on_pending_job_is_evidence_only_and_cannot_disappear(self):
        first=self.send();self.server.proof(first["job_id"])
        pending=self.status()
        self.assertTrue(pending["publication_evidence_available"]);self.assertFalse(pending["recording_complete"])
        missing=self.server.view(first["job_id"]);missing["attestation"]=None
        self.server.force_view=missing;held=self.status()
        self.assertFalse(held["ok"]);self.assertEqual(held["reason"],"queue_original_proof_changed")
        self.server.force_view=None;self.assertFalse(self.status()["ok"])

    def test_typed_snapshot_or_result_attacks_never_cache_success(self):
        first=self.send();view=self.server.complete(first["job_id"])
        for field in ("typed_state","wrong_result"):
            bad=copy.deepcopy(view)
            if field=="typed_state":bad["snapshot"]["state"]["attempt"]=True
            else:bad["result"]["payload"]["attestation_id"]=E.fingerprint("wrong proof")
            self.server.force_view=bad;self.assertFalse(self.status()["ok"],field)
        self.server.force_view=None;self.assertTrue(self.status()["recording_complete"])

    def test_secrets_redirects_and_wrong_methods_never_escape(self):
        before=tree(self.workspace)
        for token in (None,"","[SENSITIVE]","x"*31,"x"*32+"\n"):
            with self.assertRaises(Q.QueueError):Q.send(self.plan(),token,transport=self.server)
        self.assertEqual(tree(self.workspace),before)
        value=self.plan()
        result=Q.send(value,TOKEN,transport=lambda *_:(200,E.encoded({"leak":TOKEN})))
        self.assertFalse(result["ok"])
        self.assertFalse(any(TOKEN.encode() in raw for raw in tree(self.workspace).values()))
        for args in (("GET",Q.BASE,None),("POST",Q.DECLARATION,b"{}"),("GET","https://evil.example",None)):
            with self.assertRaises(Q.QueueError):Q._route(*args)

    def test_post_link_fsync_failure_recovers_without_duplicate_registration(self):
        self.send();value=self.plan();_,target,_=Q._paths(value)
        (target/"receipt.json").unlink()
        for path in (target/"observations").glob("*.json"):path.unlink()
        original=P.capture.journal._sync_published;failed=[False]
        def flush(path,boundary):
            self.assertTrue(Path(path).is_relative_to(self.workspace));self.assertEqual(Path(boundary),self.workspace)
            if Path(path).name=="receipt.json" and not failed[0]:failed[0]=True;raise OSError("post-link fsync fixture")
            return original(path,boundary)
        with patch.object(P.capture.journal,"_sync_published",side_effect=flush):held=self.status()
        self.assertFalse(held["ok"]);self.server.calls.clear()
        retry=self.status();self.assertTrue(retry["job_registered"],retry)
        self.assertEqual({method for method,_,_ in self.server.calls},{"GET"})

    def test_expired_budget_never_caches_late_registration_reply(self):
        clock=[0.0];actual=self.server
        def late(method,path,body):
            result=actual(method,path,body)
            if method=="POST":clock[0]=10000
            return result
        value=self.plan();held=Q.send(value,TOKEN,transport=late,sleep=lambda _:None,monotonic=lambda:clock[0])
        self.assertFalse(held["ok"])
        fresh=self.plan();self.server.calls.clear();retry=self.send(fresh)
        self.assertTrue(retry["job_registered"]);self.assertEqual({m for m,_,_ in self.server.calls},{"GET"})

    def test_loader_refuses_changed_pin_dirty_core_or_foreign_import(self):
        git=Q.feedback.git
        def changed(root,*args):return "0"*40 if args==("rev-parse","HEAD") else git(root,*args)
        with patch.object(Q.feedback,"git",side_effect=changed),self.assertRaises(Q.QueueError):Q.engine(ENGINE)
        def dirty(root,*args):return " M runtime.py" if args and args[0]=="status" else git(root,*args)
        with patch.object(Q.feedback,"git",side_effect=dirty),self.assertRaises(Q.QueueError):Q.engine(ENGINE)
        fake=types.ModuleType("selflearn_core.foreign");fake.__file__="/tmp/not-selected.py"
        with patch.dict(sys.modules,{"selflearn_core.foreign":fake}),self.assertRaises(ValueError):Q.engine(ENGINE)

    def test_repeated_completed_status_deduplicates_original_proof_and_result(self):
        first=self.send();view=self.server.complete(first["job_id"])
        for _ in range(5):self.assertTrue(self.status()["recording_complete"])
        value=self.plan();_,target,_=Q._paths(value)
        blobs=list((target/"blobs").glob("*.json"))
        self.assertEqual(len(blobs),4)
        proofs=[path for path in blobs if Q.read(path).get("kind")=="nfl.pool_http_publication_attestation.v1"]
        self.assertEqual(len(proofs),1)
        self.assertEqual(Q.read(proofs[0]),view["attestation"])
        observations=list((target/"observations").glob("*.json"))
        self.assertGreaterEqual(len(observations),2)
        for path in observations:
            stored=Q.read(path)
            self.assertNotIn("view",stored)
            self.assertEqual(set(stored),{"version","plan_id","snapshot","references"})
        self.assertLess(Q._inventory(self.workspace,target),Q.MAX_LEDGER_BYTES)
        reads=[];read=Q.read
        def tracked(path):
            reads.append(path)
            return read(path)
        with patch.object(Q,"read",side_effect=tracked):
            ledger=Q._ledger(self.workspace,target,value,A)
        proof_views=[item for item in ledger if item["attestation"] is not None]
        self.assertGreaterEqual(len(proof_views),2)
        self.assertTrue(all(item["attestation"] is proof_views[0]["attestation"] for item in proof_views))
        self.assertEqual(reads.count(proofs[0]),1)

    def test_aggregate_ledger_limit_is_checked_before_loading_records_or_http(self):
        self.send();value=self.plan();self.server.calls.clear()
        with patch.object(Q,"MAX_LEDGER_BYTES",1),patch.object(Q,"read",side_effect=AssertionError("loaded over-limit ledger")):
            with self.assertRaisesRegex(Q.QueueError,"queue_ledger_byte_limit"):
                Q.status(value,TOKEN,transport=self.server,sleep=lambda _:None)
        self.assertEqual(self.server.calls,[])

    def test_observation_count_limit_holds_before_another_status_request(self):
        self.send();value=self.plan();self.server.calls.clear()
        with patch.object(Q,"MAX_OBSERVATIONS",1):
            held=Q.status(value,TOKEN,transport=self.server,sleep=lambda _:None)
        self.assertFalse(held["ok"]);self.assertEqual(held["reason"],"queue_observation_limit")
        self.assertEqual(self.server.calls,[])

    def test_nonregular_fifo_or_symlink_records_refuse_without_blocking(self):
        value=self.plan();_,target,_=Q._paths(value);target.mkdir(parents=True)
        fifo=target/"declaration.json";os.mkfifo(fifo)
        def timeout(*_):raise AssertionError("FIFO read blocked the test runner")
        previous=signal.signal(signal.SIGALRM,timeout)
        signal.setitimer(signal.ITIMER_REAL,2)
        try:
            with self.assertRaisesRegex(Q.QueueError,"queue_record_not_regular"):Q.read(fifo)
            with self.assertRaisesRegex(Q.QueueError,"queue_record_not_regular"):self.plan()
        finally:
            signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
        fifo.unlink();fifo.symlink_to(self.root/"outside.json")
        with self.assertRaises(ValueError):self.plan()
        self.assertEqual(self.server.calls,[])

    def test_durable_proof_blob_survives_lost_observation_link(self):
        first=self.send();self.server.proof(first["job_id"])
        self.assertTrue(self.status()["publication_evidence_available"])
        value=self.plan();_,target,_=Q._paths(value)
        for path in (target/"observations").glob("*.json"):path.unlink()
        missing=self.server.view(first["job_id"]);missing["attestation"]=None
        self.server.force_view=missing;held=self.status()
        self.assertFalse(held["ok"]);self.assertEqual(held["reason"],"queue_original_proof_changed")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nfl-checkout",type=Path,required=True);parser.add_argument("--engine-checkout",type=Path,required=True)
    args=parser.parse_args();nfl=args.nfl_checkout.resolve();engine=args.engine_checkout.resolve()
    if nfl!=ROOT:parser.error("Use this exact NFL checkout")
    sys.path.insert(0,str(nfl))
    global Q,P,E,A,DTO,F,ENGINE,AUTHORITY,JobJournal,PublicationJournal,finalize_generation
    from scripts import queue_publication as Q,export_publication as P,export_learning as E
    ENGINE=engine;A,DTO=Q.engine(engine)
    AUTHORITY=E.fingerprint("offline SQLite queue contract authority")
    from selflearn_core.store.learning_job_journal import LearningJobJournal as JobJournal
    from selflearn_core.adapters.nfl_publication_journal import NFLPublicationJournal as PublicationJournal
    sys.path.insert(0,str(engine))
    from services.web.nfl_ingestion import finalize_generation
    if Path(sys.modules[finalize_generation.__module__].__file__).resolve()!=engine/"services/web/nfl_ingestion.py":parser.error("Foreign engine handler import")
    spec=importlib.util.spec_from_file_location("queue_actual_nfl_fixture",nfl/"tests/fixtures/week6_outcomes.py")
    F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(QueueContracts))
    Q.engine(engine)
    raise SystemExit(0 if result.wasSuccessful() and result.testsRun>=18 and not result.skipped else 1)


if __name__=="__main__":main()
