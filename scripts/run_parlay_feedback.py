#!/usr/bin/env python3
"""Default-off NFL-only repository feedback pilot using pinned shared code.

--execute opts into OFFLINE local persistence, not deployment or model adoption.
--fetch-outcomes additionally opts into the existing code-owned public source
adapter. No credentials, alternate HTTP client, fitting formula or normalized-
label trust lives here. Shared code independently grades the exact raw capture.
Actions must serialize publishers and impose a job/step wall-clock timeout.
An interrupted process cannot publish a successful pointer before its complete
immutable state/report/run files exist. This is not a hosted acknowledgement.
"""
import argparse
import datetime as dt
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parent.parent
if str(ROOT)not in sys.path:sys.path.insert(0,str(ROOT))
from scripts import export_learning as export, capture_outcome_evidence as capture  # noqa: E402

MAX_BYTES=128*1024*1024
MAX_CAPTURES=32
PROFILE={"version":1,"kind":"nfl.repository_feedback_profile.v1","population":"eligible_pool",
         "bootstrap_replicates":200,"maximum_json_bytes":MAX_BYTES,"maximum_raw_bytes":MAX_BYTES,
         "cpu_seconds":180,"regular_file_bytes":MAX_BYTES+1,"wall_clock_owner":"Actions step timeout (15 minutes)"}
FLAGS={"model_adoption":False,"public_serving_verified":False,"working_live_loop":False,
       "provider_authenticated":False,"accuracy_improvement_verified":False,"hosted_ack":False}


class FeedbackError(ValueError):pass


def need(value,reason="parlay_feedback_refused"):
    if not value:raise FeedbackError(reason)


def selected(path):
    path=Path(path).absolute();need(not path.is_symlink(),"feedback_symlink_refused")
    return path.resolve()


def git(root,*args):
    result=subprocess.run(["git","-C",str(root),*args],capture_output=True,timeout=15,check=False)
    need(result.returncode==0,"feedback_code_unavailable")
    need(len(result.stdout)<=1024*1024,"feedback_code_limit")
    return result.stdout.decode("utf-8").strip()


def engine(checkout,commit):
    need(type(commit) is str and re.fullmatch(r"[0-9a-f]{40}",commit),"feedback_exact_engine_commit_required")
    checkout=selected(checkout);need(checkout.is_dir(),"feedback_engine_unavailable")
    need(git(checkout,"rev-parse","HEAD")==commit,"feedback_engine_commit_mismatch")
    need(not git(checkout,"status","--porcelain","--untracked-files=all","--","packages/selflearn-core/selflearn_core"),
         "feedback_engine_runtime_dirty")
    package=checkout/"packages/selflearn-core"
    sys.path.insert(0,str(package))
    module=importlib.import_module("selflearn_core.adapters.nfl_file_feedback")
    identity=importlib.import_module("selflearn_core.learning_jobs").code_identity
    need(Path(module.__file__).resolve()==package/"selflearn_core/adapters/nfl_file_feedback.py","feedback_engine_import_mismatch")
    return module,identity,identity()


def read_json(path):
    path=Path(path);need(not path.is_symlink(),"feedback_symlink_refused")
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0)|getattr(os,"O_NONBLOCK",0))
    with os.fdopen(fd,"rb")as handle:
        need(stat.S_ISREG(os.fstat(handle.fileno()).st_mode),"feedback_record_not_regular")
        raw=handle.read(MAX_BYTES+1)
    need(len(raw)<=MAX_BYTES,"feedback_record_limit")
    return export._json(raw)


def artifact(root,folder,oid):
    export._hash(oid)
    root=selected(root)
    return export._delivery_path(root,folder,oid[7:]+".json")


def save(root,folder,oid,value):
    need(len(export.encoded(value))<=MAX_BYTES,"feedback_record_limit")
    export._immutable(artifact(root,folder,oid),value,root=root)


def pointer(data):
    return export._delivery_path(data,"learning_feedback.json")


def previous(data,artifacts):
    path=pointer(data)
    if not path.exists():return None,None
    value=read_json(path)
    need(type(value) is dict and set(value)=={"version","kind","run_id","state_id","evaluation_id"}
         and type(value["version"]) is int and value["version"]==1 and value["kind"]=="nfl.repository_feedback_pointer.v1")
    run=read_json(artifact(artifacts,"runs",value["run_id"]))
    need(type(run) is dict and run.get("run_id")==value["run_id"]
         and value["run_id"]==export.fingerprint({k:v for k,v in run.items()if k!="run_id"})
         and run.get("state_id")==value["state_id"]and run.get("evaluation_id")==value["evaluation_id"],"feedback_pointer_mismatch")
    need(set(run)=={"version","kind","state_id","evaluation_id","graph_id","engine_commit","engine_code_id","execution_profile",
                   "execution_profile_id","basis","run_id",*FLAGS}
         and type(run["version"]) is int and run["version"]==1 and run["kind"]=="nfl.repository_feedback_run.v1"
         and all(run[k] is False for k in FLAGS)
         and run["basis"]=="local_repository_files_not_live_publication_or_hosted_ACK"
         and type(run["engine_commit"]) is str and re.fullmatch(r"[0-9a-f]{40}",run["engine_commit"])
         and export._same_json(run["execution_profile"],PROFILE)
         and run["execution_profile_id"]==export.fingerprint(PROFILE),"feedback_run_contract_mismatch")
    export._hash(run["graph_id"]);export._hash(run["engine_code_id"])
    state=read_json(artifact(artifacts,"states",value["state_id"]))
    report=read_json(artifact(artifacts,"evaluations",value["evaluation_id"]))
    need(state.get("state_id")==value["state_id"]
         and value["state_id"]==export.fingerprint({k:v for k,v in state.items()if k!="state_id"})
         and report.get("state_id")==value["state_id"]
         and report.get("evaluation_id")==value["evaluation_id"]
         and value["evaluation_id"]==export.fingerprint({k:v for k,v in report.items()if k!="evaluation_id"}),"feedback_pointer_mismatch")
    # The parent link must resolve too; a pointer is not permission to silently
    # forget the preceding persisted generation/correction state.
    if state.get("previous_state_id") is not None:
        parent=read_json(artifact(artifacts,"states",state["previous_state_id"]))
        need(parent.get("state_id")==state["previous_state_id"]
             and parent["state_id"]==export.fingerprint({k:v for k,v in parent.items()if k!="state_id"}),"feedback_parent_missing")
    return value,state


def validate_records(data_dir):
    """Publication integrity only; no fitting, network or shared engine load."""
    data=selected(data_dir)
    value,_state=previous(data,export._delivery_path(data,"snapshots","learning_feedback"))
    return value is not None


def publish_pointer(data,value,expected):
    path=pointer(data)
    current=read_json(path)if path.exists()else None
    need(export._same_json(current,expected),"feedback_pointer_changed")
    if export._same_json(current,value):return
    data.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=data,prefix=".feedback-",delete=False)as handle:
        temporary=Path(handle.name);handle.write(export.encoded(value)+b"\n");handle.flush();os.fsync(handle.fileno())
    try:
        pointer(data);os.replace(temporary,path)
        fd=os.open(data,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:temporary.unlink(missing_ok=True)


def lock(data):
    """Local nonblocking writer lock; no lock file is committed as sports data."""
    import fcntl
    key=hashlib.sha256(str(data).encode()).hexdigest()
    path=Path(tempfile.gettempdir())/("nfl-feedback-"+key+".lock")
    fd=os.open(path,os.O_RDWR|os.O_CREAT|getattr(os,"O_NOFOLLOW",0),0o600)
    handle=os.fdopen(fd,"r+b")
    try:
        need(stat.S_ISREG(os.fstat(handle.fileno()).st_mode),"feedback_lock_refused")
        fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        return handle
    except BaseException:
        handle.close();raise


def limits():
    """Limit this explicit CLI only, never the parent pipeline/test runner."""
    import resource
    for name,maximum in(("RLIMIT_CPU",PROFILE["cpu_seconds"]),("RLIMIT_CORE",0),("RLIMIT_FSIZE",PROFILE["regular_file_bytes"])):
        key=getattr(resource,name);_soft,hard=resource.getrlimit(key)
        effective=maximum if hard==resource.RLIM_INFINITY else min(maximum,hard)
        resource.setrlimit(key,(effective,effective))
        need(resource.getrlimit(key)==(effective,effective),"feedback_limits_unavailable")


def raw_capture(path):
    bundle=capture.load_capture(path);raw=bundle["raw_objects"]
    envelope={"version":1,"kind":"nfl.capture_envelope.v1","scope":"uploaded_only","manifest":bundle["manifest"],
        "observations":bundle["observations"],"raw_objects":[{"raw_sha256":key,"raw_bytes":len(value)}for key,value in sorted(raw.items())]}
    def chunks(key):
        value=raw[key]
        return(value[i:i+1024*1024]for i in range(0,len(value),1024*1024))
    return envelope,chunks,sum(map(len,raw.values()))


def fetch_captures(snapshot_dir,out_dir):
    """Explicit public-source observation of EVERY frozen forecast period."""
    exported=export.plan(snapshot_dir);periods={}
    for entry in exported["generations"]:
        doc=entry["request"]["payload"]
        periods.setdefault(doc["season"],set()).add(doc["week"])
    need(periods and len(periods)<=MAX_CAPTURES,"feedback_empty_or_excessive_periods")
    paths=[]
    for season,weeks in sorted(periods.items()):
        bundle=capture.capture(season,sorted(weeks),fetcher=capture.http_fetcher)
        paths.append(capture.save_capture(bundle,out_dir))
    return paths


def now():return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00","Z")


def run(*,data_dir,snapshot_dir,captures,engine_checkout,engine_commit,observed_utc,evaluation_clock=now):
    data,snapshots=selected(data_dir),selected(snapshot_dir)
    need(data!=ROOT and data!=selected(engine_checkout),"feedback_output_overlaps_code")
    need(type(captures) in(list,tuple)and len(captures)<=MAX_CAPTURES,"feedback_capture_limit")
    artifacts=export._delivery_path(data,"snapshots","learning_feedback")
    paths=[selected(path)for path in captures]
    need(len(set(paths))==len(paths),"feedback_duplicate_capture")
    for authority in(snapshots/"learning_journal",snapshots/"learning_sources",*(path.parent.parent for path in paths)):
        need(not artifacts.is_relative_to(authority)and not authority.is_relative_to(artifacts),"feedback_output_overlaps_inputs")
    core,identity,code_id=engine(engine_checkout,engine_commit)
    with lock(data):
        old_pointer,old_state=previous(data,artifacts)
        exported=export.plan(snapshots)
        graph={k:exported[k]for k in("source_objects","generations")}
        need(bool(graph["generations"]),"feedback_empty_forecasts")
        need(len(export.encoded(graph))<=MAX_BYTES,"feedback_record_limit")
        bound=[];raw_bytes=0
        for path in paths:
            envelope,reader,size=raw_capture(path);raw_bytes+=size
            need(raw_bytes<=MAX_BYTES,"feedback_raw_limit");bound.append((envelope,reader))
        prepared=core.prepare(graph,previous=old_state,captures=bound,observed_utc=observed_utc)
        state=prepared["state"];evaluated_utc=evaluation_clock()
        need(capture._instant(evaluated_utc)>=capture._instant(observed_utc),"feedback_evaluation_clock_regressed")
        evaluation=core.evaluate(state,graph,as_of_utc=evaluated_utc,bootstrap_replicates=PROFILE["bootstrap_replicates"])
        need(identity()==code_id,"feedback_engine_changed")
        need(git(engine_checkout,"rev-parse","HEAD")==engine_commit,"feedback_engine_changed")
        run_record={"version":1,"kind":"nfl.repository_feedback_run.v1","state_id":state["state_id"],
            "evaluation_id":evaluation["evaluation_id"],"graph_id":export.fingerprint(graph),"engine_commit":engine_commit,
            "engine_code_id":code_id,"execution_profile":PROFILE,"execution_profile_id":export.fingerprint(PROFILE),
            "basis":"local_repository_files_not_live_publication_or_hosted_ACK",**FLAGS}
        run_record["run_id"]=export.fingerprint(run_record)
        # Publish completion LAST. Immutable orphan artifacts after interruption
        # are recoverable evidence, never a partially successful latest result.
        save(artifacts,"states",state["state_id"],state)
        save(artifacts,"evaluations",evaluation["evaluation_id"],evaluation)
        save(artifacts,"runs",run_record["run_id"],run_record)
        value={"version":1,"kind":"nfl.repository_feedback_pointer.v1","run_id":run_record["run_id"],
            "state_id":state["state_id"],"evaluation_id":evaluation["evaluation_id"]}
        publish_pointer(data,value,old_pointer)
        return {**value,"kind":"nfl.repository_feedback_summary.v1","status":"local_repository_persisted_not_deployed","state_changed":prepared["changed"],
            "receipts":len(state["receipts"]),"outcome_revisions":len(state["revisions"]),"capture_results":prepared["capture_results"],
            "cohort_n":evaluation["report"]["cohort_n"],"candidate_gate":evaluation["report"]["proposed_shared_return_gate"],
            "forecast_quarantine":prepared["forecast_quarantine"],"first_imported_before_kickoff":evaluation["first_imported_before_kickoff"],
            "late_imported_receipts":evaluation["late_imported_receipts"],"network_used":False,"writes":True,**FLAGS}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute",action="store_true")
    parser.add_argument("--data-dir",default=str(ROOT/"data"))
    parser.add_argument("--snapshots")
    parser.add_argument("--capture",action="append",default=[])
    parser.add_argument("--fetch-outcomes",action="store_true")
    parser.add_argument("--engine-checkout")
    parser.add_argument("--engine-commit")
    args=parser.parse_args(argv)
    if not args.execute:
        print(json.dumps({"version":1,"status":"disabled_dry_run","writes":False,"network_used":False,**FLAGS},sort_keys=True));return 0
    try:
        need(args.engine_checkout and args.engine_commit,"feedback_exact_engine_commit_required")
        limits()
        snapshots=args.snapshots or str(Path(args.data_dir)/"snapshots")
        paths=list(args.capture)
        if args.fetch_outcomes:
            # Refuse a floating/dirty/missing engine BEFORE public retrieval.
            engine(args.engine_checkout,args.engine_commit)
            paths.extend(fetch_captures(snapshots,Path(args.data_dir)/"snapshots/learning_outcomes"))
        result=run(data_dir=args.data_dir,snapshot_dir=snapshots,captures=paths,
            engine_checkout=args.engine_checkout,engine_commit=args.engine_commit,
            observed_utc=now())
        result["network_used"]=bool(args.fetch_outcomes)
        print(json.dumps(result,sort_keys=True,allow_nan=False));return 0
    except Exception:
        # Do not log arbitrary library, path, response or credential text.
        print(json.dumps({"version":1,"status":"failed_no_success_ack","error":"parlay_feedback_refused",**FLAGS},sort_keys=True),file=sys.stderr)
        return 2


if __name__=="__main__":raise SystemExit(main())
