#!/usr/bin/env python3
"""Default-off, offline NFL feedback pilot using exact pinned shared code.

--execute opts into local shadow persistence in an explicit separate workspace.
Shared code independently grades exact retained raw captures. This runner has
no network retrieval, model adoption, activation or publication path.
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
import signal
import stat
import sys
import tempfile

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parent.parent
if str(ROOT)not in sys.path:sys.path.insert(0,str(ROOT))
from scripts import export_learning as export, capture_outcome_evidence as capture  # noqa: E402
from scripts.learning_history_guard import _git  # noqa: E402

ENGINE_COMMIT="aacb19c73122f257449e977df40f2a2733991b2f"
OUTCOME_BASIS="threshold_observations_not_sportsbook_settlement"
SETTLEMENT_SUPPORT="unresolved_push_and_official_void"
MAX_BYTES=128*1024*1024
MAX_CAPTURES=32
MAX_CAPTURE_HISTORY_BYTES=512*1024*1024
MAX_STATE_HISTORY=4096
PROFILE={"version":1,"kind":"nfl.repository_feedback_profile.v1","population":"eligible_pool",
         "bootstrap_replicates":200,"maximum_json_bytes":MAX_BYTES,"maximum_raw_bytes":MAX_BYTES,
         "cpu_seconds":180,"regular_file_bytes":MAX_BYTES+1,"wall_clock_owner":"explicit_execute_CLI_SIGALRM",
         "wall_clock_seconds":300}
# Preserve PROFILE verbatim for historical run readers. Only reviewed code, not
# JSON input or an operator-provided profile string, selects this new boundary.
PARTITION_PROFILE="partitioned_repository_history_v2"
# Historical reference-runner measurement: 564,543,488-byte peak RSS on Darwin
# (33,100,828-byte graph). 2 GiB is a conservative address-space budget, not a
# claim that RSS measures virtual address space. Linux CLI capacity needs its
# own runner canary. The explicit CLI enforces CPU, file and wall-clock caps.
CLI_MEMORY_BYTES=2*1024*1024*1024
PARTITION_EXECUTION_PROFILE={**PROFILE,"version":2,"kind":"nfl.repository_feedback_profile.v2",
    "snapshot_profile":PARTITION_PROFILE,"cli_address_space_bytes":CLI_MEMORY_BYTES,
    "process_limits_owner":"explicit_execute_CLI_only_library_callers_install_their_own",
    "memory_enforcement":"Linux_RLIMIT_AS_unsupported_platforms_refuse"}
FLAGS={"model_adoption":False,"public_serving_verified":False,"working_live_loop":False,
       "provider_authenticated":False,"accuracy_improvement_verified":False,"hosted_ack":False,
       "production_authorized":False,"learning_enabled":False}


class FeedbackError(ValueError):pass


def need(value,reason="parlay_feedback_refused"):
    if not value:raise FeedbackError(reason)


def known_execution_profile(value):
    """Historical declarations are exact contracts, never uploaded budgets."""
    return any(export._same_json(value,known)for known in(PROFILE,PARTITION_EXECUTION_PROFILE))


def selected(path):
    path=Path(path).absolute();need(not path.is_symlink(),"feedback_symlink_refused")
    return path.resolve()


def workspace(path,engine_checkout=None):
    data=selected(path)
    authorities=[ROOT]
    if engine_checkout is not None:authorities.append(selected(engine_checkout))
    need(all(not data.is_relative_to(authority)and not authority.is_relative_to(data)
             for authority in authorities),"feedback_output_overlaps_code")
    return data


def git(root,*args):
    return _git(root,list(args),limit=1024*1024,seconds=15).decode("utf-8").strip()


def import_identity(package):
    """Refuse a cached foreign engine, including any already loaded submodule."""
    root=package/"selflearn_core"
    for name,module in tuple(sys.modules.items()):
        if name!="selflearn_core" and not name.startswith("selflearn_core."):continue
        suffix=name.split(".")[1:]
        path=root.joinpath(*suffix)
        expected=path/"__init__.py" if path.is_dir() else path.with_suffix(".py")
        need(module is not None and getattr(module,"__file__",None)
             and Path(module.__file__).resolve()==expected,"feedback_engine_import_mismatch")
        spec=getattr(module,"__spec__",None)
        need(spec is not None and spec.origin and Path(spec.origin).resolve()==expected,
             "feedback_engine_import_mismatch")
        if hasattr(module,"__path__"):
            need(list(module.__path__)==[str(expected.parent)],"feedback_engine_import_mismatch")


def engine(checkout,commit):
    need(type(commit) is str and commit==ENGINE_COMMIT,"feedback_exact_engine_commit_required")
    checkout=selected(checkout);need(checkout.is_dir(),"feedback_engine_unavailable")
    need(git(checkout,"rev-parse","HEAD")==commit,"feedback_engine_commit_mismatch")
    need(not git(checkout,"status","--porcelain","--untracked-files=all","--","packages/selflearn-core/selflearn_core"),
         "feedback_engine_runtime_dirty")
    package=checkout/"packages/selflearn-core"
    # Ignored .py source is executable too; it must not escape the clean-source
    # check merely because an engine checkout has a broad ignore rule.
    ignored=git(checkout,"ls-files","--others","--ignored","--exclude-standard","--",
                "packages/selflearn-core/selflearn_core")
    need(not any(path.endswith(".py") for path in ignored.splitlines()),"feedback_engine_runtime_dirty")
    import_identity(package)
    sys.path.insert(0,str(package))
    module=importlib.import_module("selflearn_core.adapters.nfl_file_feedback")
    identity=importlib.import_module("selflearn_core.learning_jobs").code_identity
    need(Path(module.__file__).resolve()==package/"selflearn_core/adapters/nfl_file_feedback.py","feedback_engine_import_mismatch")
    import_identity(package)
    need(getattr(module,"PARTITION_PROFILE",None)==PARTITION_PROFILE,"feedback_engine_profile_unavailable")
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
    root=selected(root)
    need(len(export.encoded(value))+1<=MAX_BYTES,"feedback_record_limit")
    export._immutable(artifact(root,folder,oid),value,root=root)


def pointer(data):
    data=selected(data)
    return export._delivery_path(data,"learning_feedback.json")


def previous(data,artifacts):
    path=pointer(data)
    if not path.exists():
        runs=export._delivery_path(artifacts,"runs")
        need(not runs.exists() or not any(runs.iterdir()),"feedback_pointer_missing_with_history")
        return None,None
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
         and run["engine_commit"]==ENGINE_COMMIT
         and known_execution_profile(run["execution_profile"])
         and run["execution_profile_id"]==export.fingerprint(run["execution_profile"]),"feedback_run_contract_mismatch")
    export._hash(run["graph_id"]);export._hash(run["engine_code_id"])
    state=read_json(artifact(artifacts,"states",value["state_id"]))
    report=read_json(artifact(artifacts,"evaluations",value["evaluation_id"]))
    need(state.get("state_id")==value["state_id"]
         and value["state_id"]==export.fingerprint({k:v for k,v in state.items()if k!="state_id"})
         and report.get("state_id")==value["state_id"]
         and report.get("evaluation_id")==value["evaluation_id"]
         and value["evaluation_id"]==export.fingerprint({k:v for k,v in report.items()if k!="evaluation_id"}),"feedback_pointer_mismatch")
    lineage=validate_state_history(artifacts,state)
    # A retained completed run outside this lineage means a deleted/rewound
    # pointer or interrupted final publication. Recovery must be explicit;
    # silently starting another history would erase correction/import clocks.
    runs=export._delivery_path(artifacts,"runs")
    if runs.exists():
        count=0;total=0
        for path in runs.iterdir():
            count+=1;need(count<=MAX_STATE_HISTORY,"feedback_state_history_limit")
            record=read_json(path);total+=len(export.encoded(record))
            need(total<=MAX_CAPTURE_HISTORY_BYTES,"feedback_state_history_limit")
            need(type(record)is dict and record.get("state_id")in lineage,
                 "feedback_pointer_rewound_or_incomplete")
    return value,state


def validate_state_history(artifacts,state):
    """Validate the complete bounded chain and every retained row/first clock.

    A resealed descendant cannot erase an older observation, revision or import
    clock. Hash checks alone establish neither cumulative history nor lineage.
    """
    histories=("source_object_ids","source_imports","receipts","receipt_imports",
        "generation_records","observation_records","revisions","capture_records")
    seen=set();total=0
    while True:
        sid=export._hash(state.get("state_id"))
        need(sid not in seen and len(seen)<MAX_STATE_HISTORY,"feedback_state_history_limit")
        seen.add(sid);total+=len(export.encoded(state))
        need(total<=MAX_CAPTURE_HISTORY_BYTES,"feedback_state_history_limit")
        need(sid==export.fingerprint({k:v for k,v in state.items()if k!="state_id"}),"feedback_parent_missing")
        need(type(state.get("sequence"))is int and state["sequence"]>=1,"feedback_state_lineage_mismatch")
        for key in histories:need(type(state.get(key))is list,"feedback_state_lineage_mismatch")
        if state.get("previous_state_id") is None:
            need(state["sequence"]==1,"feedback_state_lineage_mismatch")
            return seen
        parent=read_json(artifact(artifacts,"states",state["previous_state_id"]))
        need(type(parent)is dict and parent.get("state_id")==state["previous_state_id"],"feedback_parent_missing")
        need(type(parent.get("sequence"))is int and parent["sequence"]+1==state["sequence"]
             and capture._instant(parent["updated_utc"])<=capture._instant(state["updated_utc"]),
             "feedback_state_lineage_mismatch")
        for key in histories:
            need(type(parent.get(key))is list,"feedback_state_lineage_mismatch")
            retained={export.encoded(row)for row in state[key]}
            need(all(export.encoded(row)in retained for row in parent[key]),"feedback_state_history_removed_or_changed")
        state=parent


def validate_records(data_dir):
    """Publication integrity only; no fitting, network or shared engine load."""
    data=selected(data_dir)
    value,state=previous(data,export._delivery_path(data,"snapshots","learning_feedback"))
    if value is not None:
        full=export.plan(data/"snapshots")
        graph={k:full[k]for k in("source_objects","generations")}
        need(len(export.encoded(graph))<=MAX_BYTES,"feedback_record_limit")
        generations={r["request"]["object_id"]:r["request"]["payload"]for r in graph["generations"]}
        source_ids={r["object_id"]for r in graph["source_objects"]}
        need(set(state["source_object_ids"])<=source_ids,"feedback_frozen_sources_missing")
        need(all(r["object_id"]in generations and export._same_json(r["payload"],generations[r["object_id"]])
                 for r in state["generation_records"]),"feedback_frozen_generations_missing")
        validate_capture_history(data,state)
    return value is not None


def validate_capture_history(data,state):
    """Every recorded capture remains reproducible from exact repository bytes."""
    records=state["capture_records"]
    need(type(records) is list and len(records)<=4096,"feedback_capture_history_limit")
    raw_bytes=0
    for cid in sorted({export._hash(row["capture_id"])for row in records}):
        path=export._delivery_path(data,"snapshots","learning_outcomes","captures",cid[7:]+".json")
        bundle=capture.load_capture(path)
        need(bundle["manifest"]["capture_id"]==cid,"feedback_capture_history_mismatch")
        raw_bytes+=sum(map(len,bundle["raw_objects"].values()))
        need(raw_bytes<=MAX_CAPTURE_HISTORY_BYTES,"feedback_capture_history_limit")


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
    """Limit this explicit CLI only, never the parent pipeline/test runner.

    Linux RLIMIT_AS bounds allocation/address space; RLIMIT_RSS or a nominal
    setter on another OS is not substituted. Fail before engine/network/write
    work when a reviewed enforceable mechanism is unavailable.
    """
    need(sys.platform=="linux","feedback_memory_limit_unavailable")
    import resource
    need(all(hasattr(resource,name)for name in("RLIMIT_AS","RLIMIT_CPU","RLIMIT_CORE","RLIMIT_FSIZE","RLIM_INFINITY")),
         "feedback_limits_unavailable")
    applied={}
    for name,maximum in(("RLIMIT_CPU",PROFILE["cpu_seconds"]),("RLIMIT_CORE",0),
                        ("RLIMIT_FSIZE",PROFILE["regular_file_bytes"]),("RLIMIT_AS",CLI_MEMORY_BYTES)):
        key=getattr(resource,name);_soft,hard=resource.getrlimit(key)
        effective=maximum if hard==resource.RLIM_INFINITY else min(maximum,hard)
        resource.setrlimit(key,(effective,effective))
        need(resource.getrlimit(key)==(effective,effective),"feedback_limits_unavailable")
        applied[name]=effective
    return {"controller_limits_applied":True,"memory_enforcement":"linux_rlimit_as",
        "address_space_limit_bytes":applied["RLIMIT_AS"],"cpu_limit_seconds":applied["RLIMIT_CPU"],
        "regular_file_limit_bytes":applied["RLIMIT_FSIZE"]}


def resource_usage():
    """Observation only. In particular, importing/calling run installs no limits.

    Linux getrusage reports ru_maxrss in KiB; Darwin reports bytes. Unsupported
    units stay unknown rather than a fabricated cross-platform memory number.
    Runtime metrics are not part of immutable state/run IDs, so retry identity
    never changes just because allocator high-water marks differ.
    """
    result={"platform":sys.platform,"peak_rss_bytes":None,"peak_rss_measurement":"unavailable",
        "controller_limits_applied":False}
    if sys.platform not in("linux","darwin"):return result
    try:
        import resource
        raw=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if type(raw) is int and raw>=0:
            result.update(peak_rss_bytes=raw*(1024 if sys.platform=="linux"else 1),
                peak_rss_measurement="getrusage_RUSAGE_SELF_os_normalized")
    except (ImportError,OSError,ValueError,AttributeError):pass
    return result


def raw_capture(path):
    bundle=capture.load_capture(path);raw=bundle["raw_objects"]
    envelope={"version":1,"kind":"nfl.capture_envelope.v1","scope":"uploaded_only","manifest":bundle["manifest"],
        "observations":bundle["observations"],"raw_objects":[{"raw_sha256":key,"raw_bytes":len(value)}for key,value in sorted(raw.items())]}
    def chunks(key):
        value=raw[key]
        return(value[i:i+1024*1024]for i in range(0,len(value),1024*1024))
    return envelope,chunks,sum(map(len,raw.values())),bundle


def persist_repository_capture(bundle,data_dir):
    """Explicit controller-owned immutable sink, never a standalone export path.

    The standalone capture tool keeps refusing sports-data writes. This sink
    is limited to the repository pilot's fixed namespace, validates exact raw
    evidence first and preserves every observation byte and original clock.
    """
    capture.verify_capture(bundle)
    data=workspace(data_dir)
    root=export._delivery_path(data,"snapshots","learning_outcomes")
    for oid,raw in bundle["raw_objects"].items():
        capture._immutable(capture._safe_path(root,"objects",oid,".bin"),raw)
    for oid,doc in bundle["observations"].items():
        capture._immutable(capture._safe_path(root,"observations",oid,".json"),capture._encoded(doc)+b"\n")
    path=capture._safe_path(root,"captures",bundle["manifest"]["capture_id"],".json")
    capture._immutable(path,capture._encoded(bundle["manifest"])+b"\n")
    return path




def now():return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00","Z")


def run(*,data_dir,snapshot_dir,captures,engine_checkout,engine_commit,observed_utc,evaluation_clock=now,settlements=()):
    # The pinned file engine cannot accept explicit sourced push/VOID rules.
    # Refuse their presence before grading or persisting any state. Integer
    # forecast lines retain their existing threshold meaning.
    need(type(settlements)in(list,tuple)and not settlements,"feedback_settlement_unsupported")
    data,snapshots=workspace(data_dir,engine_checkout),selected(snapshot_dir)
    need(snapshots==export._delivery_path(data,"snapshots"),"feedback_forecast_authority_outside_repository_store")
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
            envelope,reader,size,bundle=raw_capture(path);raw_bytes+=size
            need(raw_bytes<=MAX_BYTES,"feedback_raw_limit")
            persist_repository_capture(bundle,data)
            bound.append((envelope,reader))
        prepared=core.prepare(graph,previous=old_state,captures=bound,observed_utc=observed_utc,
            snapshot_profile=PARTITION_PROFILE)
        state=prepared["state"];evaluated_utc=evaluation_clock()
        validate_capture_history(data,state)
        need(capture._instant(evaluated_utc)>=capture._instant(observed_utc),"feedback_evaluation_clock_regressed")
        evaluation=core.evaluate(state,graph,as_of_utc=evaluated_utc,bootstrap_replicates=PROFILE["bootstrap_replicates"],
            snapshot_profile=PARTITION_PROFILE)
        need(identity()==code_id,"feedback_engine_changed")
        _core,_identity,verified_code_id=engine(engine_checkout,engine_commit)
        need(verified_code_id==code_id,"feedback_engine_changed")
        run_record={"version":1,"kind":"nfl.repository_feedback_run.v1","state_id":state["state_id"],
            "evaluation_id":evaluation["evaluation_id"],"graph_id":export.fingerprint(graph),"engine_commit":engine_commit,
            "engine_code_id":code_id,"execution_profile":PARTITION_EXECUTION_PROFILE,
            "execution_profile_id":export.fingerprint(PARTITION_EXECUTION_PROFILE),
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
            "late_imported_receipts":evaluation["late_imported_receipts"],"resource_usage":resource_usage(),
            "outcome_basis":OUTCOME_BASIS,"settlement_support":SETTLEMENT_SUPPORT,
            "network_used":False,"writes":True,**FLAGS}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute",action="store_true")
    parser.add_argument("--check-records",action="store_true",help="read-only publication integrity; never engine import or fitting")
    parser.add_argument("--data-dir",help="explicit separate local workspace; required for --execute")
    parser.add_argument("--snapshots")
    parser.add_argument("--capture",action="append",default=[])
    parser.add_argument("--settlement",action="append",default=[],help="explicit settlement inputs are refused by the pinned engine")
    parser.add_argument("--engine-checkout",default=os.environ.get("SELFLEARN_CHECKOUT"))
    parser.add_argument("--engine-commit",default=ENGINE_COMMIT)
    args=parser.parse_args(argv)
    if not args.execute and not args.check_records:
        print(json.dumps({"version":1,"status":"disabled_dry_run","writes":False,"network_used":False,
            "outcome_basis":OUTCOME_BASIS,"settlement_support":SETTLEMENT_SUPPORT,**FLAGS},sort_keys=True));return 0
    try:
        if args.check_records:
            need(not(args.execute or args.capture or args.snapshots or args.settlement))
            present=validate_records(args.data_dir or ROOT/"data")
            print(json.dumps({"version":1,"status":"local_records_valid"if present else"no_feedback_record",
                "writes":False,"network_used":False,**FLAGS},sort_keys=True));return 0
        need(not args.settlement,"feedback_settlement_unsupported")
        need(args.data_dir,"feedback_explicit_workspace_required")
        need(args.engine_checkout,"feedback_engine_unavailable")
        need(args.engine_commit==ENGINE_COMMIT,"feedback_exact_engine_commit_required")
        workspace(args.data_dir,args.engine_checkout)
        applied_limits=limits()
        def expired(_signal,_frame):raise FeedbackError("feedback_wall_clock_limit")
        old_handler=signal.signal(signal.SIGALRM,expired)
        signal.alarm(PROFILE["wall_clock_seconds"])
        snapshots=args.snapshots or str(Path(args.data_dir)/"snapshots")
        paths=list(args.capture)
        try:
            result=run(data_dir=args.data_dir,snapshot_dir=snapshots,captures=paths,
                engine_checkout=args.engine_checkout,engine_commit=args.engine_commit,observed_utc=now())
        finally:
            signal.alarm(0);signal.signal(signal.SIGALRM,old_handler)
        result["resource_usage"].update(applied_limits)
        result["resource_usage"]["wall_clock_limit_seconds"]=PROFILE["wall_clock_seconds"]
        print(json.dumps(result,sort_keys=True,allow_nan=False));return 0
    except Exception as error:
        # Only these exact controller-owned static reasons are actionable.
        # Never expose arbitrary library, path, response or credential text.
        reason=(error.args[0]if type(error)is FeedbackError and len(error.args)==1
            and type(error.args[0])is str and error.args[0]in(
                "feedback_memory_limit_unavailable","feedback_limits_unavailable","feedback_wall_clock_limit",
                "feedback_settlement_unsupported","feedback_explicit_workspace_required",
                "feedback_exact_engine_commit_required","feedback_output_overlaps_code",
                "feedback_pointer_missing_with_history","feedback_pointer_rewound_or_incomplete")else"parlay_feedback_refused")
        print(json.dumps({"version":1,"status":"failed_no_success_ack","error":reason,
            "outcome_basis":OUTCOME_BASIS,"settlement_support":SETTLEMENT_SUPPORT,
            "network_used":False,**FLAGS},sort_keys=True),file=sys.stderr)
        return 2


if __name__=="__main__":raise SystemExit(main())
