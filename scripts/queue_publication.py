#!/usr/bin/env python3
"""Opt-in persistent publication enqueue and read-only status, never a worker.

Preview reads no credentials and performs no HTTP or writes. Registration is
not publication. Explicit status uses a fresh authenticated GET; saved snapshots
are original evidence only. Status writes local immutable metadata while its
HTTP requests are GET-only. Server code IDs are declarations, not attestation.
"""
import importlib
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:sys.path.insert(0,str(ROOT))
from scripts import export_learning as E, export_publication as P
from scripts.learning_history_guard import _git
from scripts import run_parlay_feedback as feedback

ENGINE_COMMIT=P.ENGINE_COMMIT
ORIGIN=P.ORIGIN
BASE="/api/v2/nfl/publication-jobs"
DECLARATION="/api/v2/nfl/publication-job-policy"
MAX_OBSERVATIONS=128
MAX_LEDGER_BYTES=8*1024*1024
MAX_BYTES=E.MAX_BODY_BYTES
POOL_PATH="data/leg_pool.json"
PUBLISHER_RECEIPT=re.compile(rb"([1-9][0-9]*) ([1-9][0-9]*) (noop|[0-9a-f]{40})\n")
FLAGS={"learning_enabled":False,"model_adoption":False,"worker_invoked":False,
       "remote_engine_commit_verified":False,"current_status_fresh":False,
       "recording_complete":False,"publication_verified":False,"publication_evidence_available":False}


class QueueError(ValueError):pass
class BudgetExpired(RuntimeError):pass


def need(value,reason="queue_refused"):
    if not value:raise QueueError(reason)


def engine(checkout):
    selected=Path(checkout).absolute()
    need(not selected.is_symlink(),"queue_engine_symlink")
    selected=selected.resolve();package=selected/"packages/selflearn-core"
    need(feedback.git(selected,"rev-parse","--show-toplevel")==str(selected)
         and feedback.git(selected,"rev-parse","HEAD")==ENGINE_COMMIT,"queue_engine_pin")
    need(not feedback.git(selected,"status","--porcelain=v1","--untracked-files=all"),"queue_engine_dirty")
    ignored=feedback.git(selected,"ls-files","--others","--ignored","--exclude-standard","--","packages/selflearn-core/selflearn_core")
    need(not any(path.endswith(".py") for path in ignored.splitlines()),"queue_engine_dirty")
    feedback.import_identity(package)
    if str(package) not in sys.path:sys.path.insert(0,str(package))
    adapter=importlib.import_module("selflearn_core.adapters.nfl_publication_delivery")
    dto=importlib.import_module("selflearn_core.learning_jobs")
    feedback.import_identity(package)
    need(Path(adapter.__file__).resolve()==package/"selflearn_core/adapters/nfl_publication_delivery.py",
         "queue_engine_import")
    return adapter,dto


def read(path):
    descriptor=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)|getattr(os,"O_NONBLOCK",0))
    with os.fdopen(descriptor,"rb") as stream:
        need(stat.S_ISREG(os.fstat(stream.fileno()).st_mode),"queue_record_not_regular")
        raw=stream.read(MAX_BYTES+1)
    need(len(raw)<=MAX_BYTES,"queue_record_limit")
    return E._json(raw)


def publisher_commit(path, run_id, run_attempt):
    """Read the successful local publisher's receipt for this run attempt."""
    need(path is not None and type(run_id) is str and type(run_attempt) is str,
         "queue_publisher_receipt_required")
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as stream:
        need(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "queue_publisher_receipt_invalid")
        receipt = PUBLISHER_RECEIPT.fullmatch(stream.read(101))
    need(receipt is not None and receipt[1].decode("ascii") == run_id
         and receipt[2].decode("ascii") == run_attempt, "queue_publisher_receipt_invalid")
    return receipt[3].decode("ascii")


def _pool_id_at(checkout, commit):
    listing = _git(checkout, ["ls-tree", commit, "--", POOL_PATH], limit=256)
    if not listing:
        return None
    need(re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}\tdata/leg_pool\.json\n", listing),
         "queue_published_pool_invalid")
    body = _git(checkout, ["cat-file", "blob", commit + ":" + POOL_PATH],
                limit=P.MAX_PUBLIC_POOL_BYTES)
    pool = E._json(body)
    need(type(pool) is dict, "queue_published_pool_invalid")
    return E.fingerprint(pool)


def publisher_disposition(value, commit, *, checkout=ROOT):
    if commit == "noop":
        return "noop"
    need(type(commit) is str and re.fullmatch(r"[0-9a-f]{40}", commit), "queue_publisher_receipt_invalid")
    need(_git(checkout, ["cat-file", "-t", commit], limit=32) == b"commit\n",
         "queue_publisher_receipt_invalid")
    source_pool = value["publication_plan"]["source_pool_id"]
    need(_pool_id_at(checkout, commit) == source_pool, "queue_published_pool_mismatch")
    # A pushed commit can carry other changed artifacts while retaining the
    # prior pool. The canonical pool identity includes generation metadata.
    return "unchanged" if _pool_id_at(checkout, commit + "^") == source_pool else "changed"


def _paths(value):
    root=P.capture.workspace_root(value["publication_plan"]["workspace"])
    op={"version":2,"kind":"nfl.publication_queue_operation.v2","destination_id":E.fingerprint({"base_url":ORIGIN}),
        "object_id":value["publication_plan"]["request"]["object_id"],
        "policy_id":value["publication_plan"]["policy_id"],"authority_id":value["authority_id"]}
    target=E._delivery_path(root,"publication-queue",op["destination_id"][7:],E.fingerprint(op)[7:])
    for name in ("declaration.json","outbox.json","receipt.json","conflict.json","observations","blobs"):
        E._delivery_path(root,*target.relative_to(root).parts,name)
    return root,target,op


def _save(root,path,value):
    E._delivery_path(root,*path.relative_to(root).parts)
    need(len(E.encoded(value))<=MAX_BYTES,"queue_record_limit")
    E._immutable(path,value,root=root)
    P.capture.journal._sync_published(str(path),str(root))


def _build(value,declaration,adapter):
    pub=value["publication_plan"]
    adapter.validate_declaration(declaration,pub["policy"],value["authority_id"])
    spec,inputs,settings=adapter.definition(pub["request"]["object_id"],pub["generation_id"],
        pub["generation_recorded_utc"],[r["event_start_utc"] for r in pub["members"]],
        pub["policy"],declaration["code_id"],value["authority_id"])
    request={"version":2,"object_id":pub["request"]["object_id"],
             "expected_job_id":spec["job_id"],"expected_definition_id":spec["definition_id"]}
    identity={"version":2,"publication_plan_id":pub["plan_id"],"authority_id":value["authority_id"],
              "declaration":declaration,"definition":spec,"input":inputs,"settings":settings,"request":request}
    return {**value,"prepared":True,"declaration":declaration,"expected_spec":spec,"inputs":inputs,
            "settings":settings,"request":request,"plan_id":E.fingerprint(identity)}


def plan(workspace,origin,engine_checkout,authority_id,code_id=None):
    P.capture.disabled_config()
    adapter,dto=engine(engine_checkout);dto.digest(authority_id)
    pub=P.plan(workspace,origin)
    checkout=Path(engine_checkout).resolve();root=Path(pub["workspace"])
    need(not root.is_relative_to(checkout) and not checkout.is_relative_to(root),"queue_workspace_overlaps_engine")
    value={"version":2,"kind":"nfl.publication_queue_plan.v2","publication_plan":pub,
        "engine_checkout":str(checkout),"authority_id":authority_id,"prepared":False,
        "declaration":None,"expected_spec":None,"inputs":None,"settings":None,"request":None,"plan_id":None}
    _,target,_=_paths(value)
    _inventory(root,target)
    if (target/"declaration.json").exists():
        saved=read(target/"declaration.json")
        need(type(saved) is dict and set(saved)=={"version","declaration"} and saved["version"]==2,"queue_declaration_invalid")
        declaration=saved["declaration"]
        need(code_id is None or declaration["code_id"]==code_id,"queue_declared_code_changed")
    elif code_id is not None:
        dto.digest(code_id)
        declaration={"version":2,"authority_id":authority_id,"code_id":code_id,
                     "policy":pub["policy"],"settings":adapter.settings(pub["policy"])}
    else:
        need(not (target/"outbox.json").exists(),"queue_declaration_missing")
        return value
    return _build(value,declaration,adapter)


def _generation(value):
    pub=value["publication_plan"]
    return {"generation_id":pub["generation_id"],"recorded_utc":pub["generation_recorded_utc"],
            "source_snapshots":{"leg_pool":pub["source_pool_id"]}}


def _validate(view,value,adapter):
    checked=adapter.validate_delivery(view,value["expected_spec"],value["inputs"],value["settings"],
        value["publication_plan"]["members"],_generation(value),value["authority_id"])
    if checked["attestation"] is not None:P.validate_ack(checked["attestation"],value["publication_plan"])
    return checked


def _inventory(root,target):
    total=0
    for name in ("declaration.json","outbox.json","receipt.json","conflict.json"):
        path=E._delivery_path(root,*target.relative_to(root).parts,name)
        if path.exists():
            metadata=path.stat()
            need(stat.S_ISREG(metadata.st_mode),"queue_record_not_regular")
            total+=metadata.st_size
    for folder,maximum in (("observations",MAX_OBSERVATIONS),("blobs",4)):
        for index,path in enumerate((target/folder).glob("*.json")):
            need(index<maximum,"queue_observation_limit")
            E._delivery_path(root,*path.relative_to(root).parts)
            metadata=path.stat()
            need(stat.S_ISREG(metadata.st_mode),"queue_record_not_regular")
            total+=metadata.st_size
            need(total<=MAX_LEDGER_BYTES,"queue_ledger_byte_limit")
    need(total<=MAX_LEDGER_BYTES,"queue_ledger_byte_limit")
    return total


def _expand(root,target,stored,cache):
    need(type(stored) is dict and set(stored)=={"version","plan_id","snapshot","references"}
         and type(stored["version"]) is int and stored["version"]==2
         and type(stored["references"]) is dict
         and set(stored["references"])=={"input","policy","result","attestation"},"queue_local_conflict")
    view={"version":2,"snapshot":stored["snapshot"]}
    for name,identity in stored["references"].items():
        if identity is None:
            need(name in ("result","attestation"),"queue_local_conflict");view[name]=None
        else:
            E._hash(identity)
            path=E._delivery_path(root,*target.relative_to(root).parts,"blobs",identity[7:]+".json")
            if identity not in cache:cache[identity]=read(path)
            payload=cache[identity]
            need(E.fingerprint(payload)==identity,"queue_local_conflict")
            view[name]=payload
    return view


def _ledger(root,target,value,adapter):
    _inventory(root,target)
    views=[];cache={}
    for index,path in enumerate((target/"observations").glob("*.json")):
        need(index<MAX_OBSERVATIONS,"queue_observation_limit")
        E._delivery_path(root,*path.relative_to(root).parts)
        stored=read(path)
        need(stored.get("plan_id")==value["plan_id"] and path.stem==E.fingerprint(stored)[7:],"queue_local_conflict")
        views.append(_validate(_expand(root,target,stored,cache),value,adapter))
    views.sort(key=lambda view:(P.stamp(view["snapshot"]["observed_utc"]),len(view["snapshot"]["events"])))
    for previous,current in zip(views,views[1:]):_progress(previous,current,value,adapter)
    return views


def _saved_proof(root,target,value):
    # A proof blob may have been flushed before a later observation link failed.
    # Preserve that independently validated original across partial restores.
    original=None
    for path in (target/"blobs").glob("*.json"):
        E._delivery_path(root,*path.relative_to(root).parts)
        payload=read(path)
        need(path.stem==E.fingerprint(payload)[7:],"queue_local_conflict")
        if type(payload) is dict and payload.get("kind")=="nfl.pool_http_publication_attestation.v1":
            P.validate_ack(payload,value["publication_plan"])
            need(original is None or E._same_json(original,payload),"queue_original_proof_changed")
            original=payload
    return original


def _progress(previous,current,value,adapter):
    adapter.validate_progress(previous["snapshot"],current["snapshot"],value["expected_spec"],value["authority_id"])
    if previous["attestation"] is not None:
        need(E._same_json(previous["attestation"],current["attestation"]),"queue_original_proof_changed")


def _route(method,path,body):
    need((method=="GET" and body is None and (path==DECLARATION
        or re.fullmatch(re.escape(BASE)+r"/sha256%3A[0-9a-f]{64}",path)))
        or (method=="POST" and path==BASE and type(body) is bytes),"queue_route_refused")
    if method=="POST":
        obj=E._json(body)
        need(type(obj) is dict and set(obj)=={"version","object_id","expected_job_id","expected_definition_id"}
             and type(obj["version"]) is int and obj["version"]==2 and E.encoded(obj)==body,"queue_request_refused")
        for key in ("object_id","expected_job_id","expected_definition_id"):E._hash(obj[key])


def http_transport(token):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),E._NoRedirect())
    def exchange(method,path,body):
        _route(method,path,body)
        req=urllib.request.Request(ORIGIN+path,data=body,method=method,
            headers={"Authorization":"Bearer "+token,"Content-Type":"application/json","Accept":"application/json"})
        try:
            with opener.open(req,timeout=20) as response:
                need(response.geturl()==ORIGIN+path,"queue_redirect_refused")
                return response.status,response.read(MAX_BYTES+1)
        except urllib.error.HTTPError as error:
            error.close();return error.code,b""
    return exchange


def _result(status,**values):
    return {"version":2,"kind":"nfl.publication_queue_status.v2","status":status,
        "configured_engine_commit":ENGINE_COMMIT,"job_registered":False,**FLAGS,**values}


def preview(value):
    P.capture.disabled_config()
    return _result("preview_prepared" if value["prepared"] else "preview_not_prepared",ok=True,
        prepared=value["prepared"],writes=False,network_used=False,
        object_id=value["publication_plan"]["request"]["object_id"],
        job_id=value["expected_spec"]["job_id"] if value["prepared"] else None)


def _execute(value,token,*,enqueue,ingest_token=None,transport=None,attempts=3,
             sleep=time.sleep,monotonic=time.monotonic,clock=P.capture.now):
    P.capture.disabled_config()
    need(type(token) is str and 32<=len(token)<=8192 and token!="[SENSITIVE]"
         and all(0x21<=ord(c)<=0x7e for c in token),"queue_token_invalid")
    need(ingest_token is None or token != ingest_token,"queue_tokens_not_distinct")
    need(type(attempts) is int and 1<=attempts<=3 and callable(sleep) and callable(monotonic)
         and callable(clock) and (transport is None or callable(transport)),"queue_budget_invalid")
    credentials=tuple(t for t in (token,ingest_token) if type(t) is str and t)
    E._reject_credentials(value,credentials)
    fresh=plan(value["publication_plan"]["workspace"],value["publication_plan"]["policy"]["origin"],
        value["engine_checkout"],value["authority_id"],value["declaration"]["code_id"] if value["prepared"] else None)
    if value["prepared"]:
        need(E._same_json(fresh,value),"queue_plan_changed")
    else:
        need(E._same_json(fresh["publication_plan"],value["publication_plan"])
             and fresh["authority_id"]==value["authority_id"]
             and fresh["engine_checkout"]==value["engine_checkout"],"queue_plan_changed")
    value=fresh
    adapter,_=engine(value["engine_checkout"])
    root,target,op=_paths(value);calls=0;deadline=monotonic()+20*attempts*3+12
    def check():
        if monotonic()>=deadline:raise BudgetExpired()
    def pause(seconds):
        check();sleep(seconds);check()
    def save(path,payload):
        E._reject_credentials(payload,credentials)
        existing=path.stat().st_size if path.exists() else 0
        need(_inventory(root,target)-existing+len(E.encoded(payload))+1<=MAX_LEDGER_BYTES,"queue_ledger_byte_limit")
        _save(root,path,payload)
    def conflict():
        save(target/"conflict.json",{"version":2,"operation":op,"reason":"immutable_queue_conflict"})
    channel=transport if transport is not None else http_transport(token)
    def request(method,path,body=None,*,missing=False,tries=attempts):
        nonlocal calls
        _route(method,path,body)
        for attempt in range(tries):
            check();calls+=1
            try:
                code,raw=channel(method,path,body)
            except (TimeoutError,OSError,urllib.error.URLError):
                check()
                if attempt+1==tries:raise QueueError("queue_transport_pending") from None
            except Exception:
                raise QueueError("queue_transport_refused") from None
            else:
                check();need(type(code) is int,"queue_http_invalid")
                if missing and code==404:return None
                if 200<=code<300:
                    need(type(raw) is bytes and len(raw)<=MAX_BYTES,"queue_response_bound")
                    reply=E._json(raw);E._reject_credentials(reply,credentials);return reply
                need(not 300<=code<400,"queue_redirect_refused")
                if code!=429 and not 500<=code<600:raise QueueError("queue_http_refused")
                if attempt+1==tries:raise QueueError("queue_http_pending")
            pause(min(.5*2**attempt,2))
    try:
        need(not (target/"conflict.json").exists(),"queue_known_conflict")
        if not enqueue:
            need((target/"outbox.json").exists(),"queue_outbox_missing")
        if not value["prepared"]:
            need(enqueue,"queue_not_prepared")
            need(not (target/"outbox.json").exists(),"queue_declaration_missing")
            declaration=request("GET",DECLARATION)
            adapter.validate_declaration(declaration,value["publication_plan"]["policy"],value["authority_id"])
            save(target/"declaration.json",{"version":2,"declaration":declaration})
            value=_build(value,declaration,adapter)
        else:
            save(target/"declaration.json",{"version":2,"declaration":value["declaration"]})
        outbox={"version":2,"operation":op,"plan_id":value["plan_id"],"request":value["request"],
            "definition":value["expected_spec"],"input":value["inputs"],"settings":value["settings"]}
        if enqueue:
            try:save(target/"outbox.json",outbox)
            except E.ExportError:conflict();raise QueueError("queue_known_conflict") from None
        else:
            need(E._same_json(read(target/"outbox.json"),outbox),"queue_local_conflict")
        views=_ledger(root,target,value,adapter)
        original_proof=_saved_proof(root,target,value)
        need(len(views)<MAX_OBSERVATIONS,"queue_observation_limit")
        path=BASE+"/"+urllib.parse.quote(value["expected_spec"]["job_id"],safe="")
        view=request("GET",path,missing=True)
        if view is None:
            need(not views and not (target/"receipt.json").exists(),"queue_registered_readback_missing")
            need(enqueue,"queue_job_not_found")
            for attempt in range(attempts):
                started=P.stamp(clock())
                need(any(started<P.stamp(row["event_start_utc"])
                         for row in value["publication_plan"]["members"]),"queue_no_remaining_preevent_members")
                try:
                    view=request("POST",BASE,E.encoded(value["request"]),tries=1)
                    break
                except QueueError as error:
                    if str(error) not in ("queue_transport_pending","queue_http_pending"):raise
                    view=request("GET",path,missing=True)
                    if view is not None:break
                    if attempt+1==attempts:raise
                    pause(min(.5*2**attempt,2))
        view=_validate(view,value,adapter)
        for old in views:_progress(old,view,value,adapter)
        if original_proof is not None:
            need(E._same_json(original_proof,view["attestation"]),"queue_original_proof_changed")
        current=view["snapshot"]
        receipt={"version":2,"plan_id":value["plan_id"],"definition":current["definition"],
            "registered_utc":current["registered_utc"],"input":view["input"],"policy":view["policy"]}
        try:save(target/"receipt.json",receipt)
        except E.ExportError:conflict();raise QueueError("queue_known_conflict") from None
        references={}
        for name in ("input","policy","result","attestation"):
            payload=view[name]
            references[name]=E.fingerprint(payload) if payload is not None else None
            if payload is not None:save(target/"blobs"/(references[name][7:]+".json"),payload)
        observation={"version":2,"plan_id":value["plan_id"],"snapshot":view["snapshot"],"references":references}
        save(target/"observations"/(E.fingerprint(observation)[7:]+".json"),observation)
        complete=current["effective_status"]=="succeeded"
        proof=view["attestation"]
        return _result("recording_completed" if complete else "job_registered" if enqueue else "job_status_observed",
            ok=True,job_registered=True,recording_complete=complete,current_status_fresh=True,
            publication_evidence_available=proof is not None,
            publication_verified=complete and bool(proof["receipts"]),
            publication_status=proof["status"] if proof is not None else None,
            publication_complete=complete and proof["status"]=="accepted" and bool(proof["receipts"]),
            accepted_receipts=len(proof["receipts"]) if proof is not None else 0,
            rejected_receipts=len(proof["rejections"]) if proof is not None else 0,
            execution_scope="frozen_original_declaration_not_current_deployment_attestation",
            job_id=current["definition"]["job_id"],definition_id=current["definition"]["definition_id"],
            effective_job_status=current["effective_status"],server_observed_utc=current["observed_utc"],
            head_event_id=current["head_event_id"],result_object_id=current["state"]["result_object_id"],
            attestation_id=proof["attestation_id"] if proof is not None else None,
            writes=True,transport_calls=calls,network_used=transport is None and calls>0)
    except Exception as error:
        reason=str(error) if type(error) is QueueError else "queue_budget_pending" if type(error) is BudgetExpired else "queue_validation_pending"
        allowed={"queue_engine_symlink","queue_engine_pin","queue_engine_dirty","queue_engine_import",
            "queue_record_limit","queue_route_refused","queue_request_refused","queue_transport_pending",
            "queue_transport_refused","queue_http_invalid","queue_response_bound","queue_redirect_refused",
            "queue_http_refused","queue_http_pending","queue_known_conflict","queue_not_prepared",
            "queue_declaration_missing","queue_outbox_missing","queue_local_conflict","queue_observation_limit",
            "queue_registered_readback_missing","queue_job_not_found","queue_original_proof_changed","queue_ledger_byte_limit",
            "queue_record_not_regular","queue_budget_pending","queue_validation_pending",
            "queue_no_remaining_preevent_members"}
        if reason not in allowed or token in reason:reason="queue_validation_pending"
        if reason in ("queue_local_conflict","queue_original_proof_changed"):conflict()
        return _result("pending",ok=False,reason=reason,writes=target.exists(),transport_calls=calls,
            network_used=transport is None and calls>0)


def send(value,token,**kwargs):return _execute(value,token,enqueue=True,**kwargs)
def status(value,token,**kwargs):return _execute(value,token,enqueue=False,**kwargs)


def main(argv=None):
    parser=E._SafeParser(description=__doc__)
    parser.add_argument("--workspace",required=True);parser.add_argument("--expected-public-origin",required=True)
    parser.add_argument("--engine-checkout",required=True);parser.add_argument("--authority-id",required=True)
    parser.add_argument("--code-id")
    parser.add_argument("--publisher-receipt")
    parser.add_argument("--publisher-run-id")
    parser.add_argument("--publisher-run-attempt")
    mode=parser.add_mutually_exclusive_group();mode.add_argument("--send",action="store_true");mode.add_argument("--status",action="store_true")
    args=parser.parse_args(argv)
    try:
        commit=publisher_commit(args.publisher_receipt,args.publisher_run_id,args.publisher_run_attempt) if args.send else None
        if commit=="noop":
            root=P.capture.workspace_root(args.workspace)
            P.capture.disabled_config()
            if not E._delivery_path(root,"publication-queue").exists():
                print(E.encoded(_result("skipped_publisher_noop",ok=True,writes=False,network_used=False)).decode("ascii"))
                return 0
        value=plan(args.workspace,args.expected_public_origin,args.engine_checkout,args.authority_id,args.code_id)
        if args.send or args.status:
            disposition=publisher_disposition(value,commit) if args.send else None
            _,target,_=_paths(value)
            if disposition in ("noop","unchanged") and not (target/"outbox.json").exists():
                output=_result("skipped_publisher_"+disposition,ok=True,writes=False,network_used=False)
            else:
                operation=send if disposition=="changed" else status
                output=operation(value,os.environ.get("SELFLEARN_NFL_PUBLICATION_TOKEN"),
                                 ingest_token=os.environ.get("SELFLEARN_NFL_INGEST_TOKEN"))
        else:
            output=preview(value)
        print(E.encoded(output).decode("ascii"));return 0 if output["ok"] else 1
    except Exception as error:
        safe_reasons={"queue_publisher_receipt_required","queue_publisher_receipt_invalid",
                      "queue_published_pool_invalid","queue_published_pool_mismatch"}
        reason=str(error) if type(error) is QueueError and str(error) in safe_reasons else "queue_refused"
        print(E.encoded(_result("refused",ok=False,reason=reason)).decode("ascii"),file=sys.stderr);return 2


if __name__=="__main__":raise SystemExit(main())
