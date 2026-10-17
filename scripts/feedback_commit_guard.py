"""Validate NFL feedback from a fixed Git tree, never mutable checkout bytes.

Only bounded data blobs are copied into a fresh private temporary directory.
No checkout, fetch, fitting, engine import or source modification occurs.
Git content integrity is not provider authentication or served-site evidence.
"""
import hashlib
import argparse
import json
from pathlib import Path
import re
import tempfile
import time
import sys
sys.dont_write_bytecode=True

ROOT=Path(__file__).resolve().parent.parent
if str(ROOT)not in sys.path:sys.path.insert(0,str(ROOT))

from scripts import export_learning as export
from scripts import generation_capture_runtime as runtime
from scripts import capture_outcome_evidence as capture

SHA=re.compile(r"[0-9a-f]{40}\Z")
PROFILE={"version":1,"kind":"nfl.feedback_committed_data_profile.v1","maximum_metadata_bytes":1024*1024,
         "maximum_file_bytes":128*1024*1024,"maximum_total_bytes":1024*1024*1024,
         "maximum_files":20000,"wall_seconds":300}
PREFIXES=("data/learning_feedback.json","data/snapshots/learning_feedback/","data/snapshots/learning_journal/",
          "data/snapshots/learning_sources/","data/snapshots/learning_outcomes/")


def need(value,reason="invalid_committed_feedback"):
    if not value:raise ValueError(reason)


class _Snapshot:
    prefixes=PREFIXES
    def __init__(self,checkout,head,destination):
        need(type(head) is str and SHA.fullmatch(head),"feedback_exact_head_required")
        self.checkout,self.head,self.destination=Path(checkout).resolve(),head,Path(destination).resolve()
        self.deadline=time.monotonic()+PROFILE["wall_seconds"]
        self.files,self.total={},0
        need(self.git(["rev-parse","HEAD"],128).strip().decode()==head,"feedback_committed_head_changed")
        raw=self.git(["ls-tree","-r","-l","-z",head,"--",*self.prefixes],PROFILE["maximum_metadata_bytes"])
        self.tree={}
        need(not raw or raw.endswith(b"\0"),"feedback_invalid_tree_framing")
        for row in raw.split(b"\0"):
            if not row:continue
            metadata,name=row.split(b"\t",1);mode,kind,oid,size=metadata.split()
            path=name.decode("utf-8")
            need(path not in self.tree and len(self.tree)<PROFILE["maximum_files"])
            need(any(path==prefix or path.startswith(prefix)for prefix in self.prefixes))
            need(all(part not in("",".","..")for part in path.split("/")))
            need(kind==b"blob"and SHA.fullmatch(oid.decode())and size.isdigit())
            self.tree[path]=(mode,oid.decode(),int(size))

    def git(self,args,maximum):
        remaining=self.deadline-time.monotonic();need(remaining>0,"feedback_committed_deadline")
        return runtime._git(self.checkout,args,limit=maximum,seconds=min(30,remaining))

    def copy(self,relative,*,maximum=None):
        if relative in self.files:return self.files[relative]
        need(relative in self.tree,"feedback_committed_file_missing")
        mode,oid,size=self.tree[relative]
        need(mode in(b"100644",b"100755"),"feedback_committed_not_regular")
        maximum=PROFILE["maximum_file_bytes"]if maximum is None else maximum
        need(type(maximum) is int and 0<=size<=maximum<=PROFILE["maximum_file_bytes"],"feedback_committed_file_limit")
        need(self.total+size<=PROFILE["maximum_total_bytes"],"feedback_committed_total_limit")
        raw=self.git(["cat-file","blob",oid],size)
        need(len(raw)==size and hashlib.sha1(b"blob "+str(size).encode()+b"\0"+raw).hexdigest()==oid,
             "feedback_committed_blob_mismatch")
        target=export._delivery_path(self.destination,*relative.split("/"))
        target.parent.mkdir(parents=True,exist_ok=True)
        with target.open("xb")as stream:stream.write(raw)
        self.files[relative]=target;self.total+=size
        return target

    def document(self,relative,*,maximum=None):
        return export._read(self.copy(relative,maximum=maximum))

    def immutable(self,folder,oid):
        export._hash(oid)
        return self.document("data/snapshots/learning_feedback/"+folder+"/"+oid[7:]+".json")


def check_committed(checkout,expected_head):
    """Repository-read-only check of exactly the commit the publisher selected."""
    from scripts.run_parlay_feedback import validate_records
    with tempfile.TemporaryDirectory(prefix="nfl-feedback-commit-")as temporary:
        view=_Snapshot(checkout,expected_head,temporary)
        pointer=view.document("data/learning_feedback.json")
        need(type(pointer) is dict)
        state=view.immutable("states",pointer["state_id"])
        view.immutable("runs",pointer["run_id"]);view.immutable("evaluations",pointer["evaluation_id"])
        if state.get("previous_state_id") is not None:view.immutable("states",state["previous_state_id"])
        journals=sorted(p for p in view.tree if p.startswith("data/snapshots/learning_journal/")and p.endswith(".json"))
        need(journals,"feedback_committed_journal_missing")
        for relative in journals:
            # Stored snapshots are indented; the exporter's 3 MiB limit is on
            # canonical request JSON, not the original file's physical length.
            doc=view.document(relative)
            for oid in doc["generations"][0]["source_snapshots"].values():
                export._hash(oid)
                view.copy("data/snapshots/learning_sources/"+oid[7:]+".json")
        records=state["capture_records"]
        need(type(records) is list and len(records)<=4096)
        for cid in sorted({export._hash(row["capture_id"])for row in records}):
            base="data/snapshots/learning_outcomes/"
            manifest=view.document(base+"captures/"+cid[7:]+".json",maximum=65536)
            need(type(manifest.get("sources")) is list and len(manifest["sources"])<=20)
            for ref in manifest["sources"]:
                oid=export._hash(ref["observation_id"])
                observation=view.document(base+"observations/"+oid[7:]+".json",maximum=65536)
                rid=export._hash(observation["raw_sha256"])
                view.copy(base+"objects/"+rid[7:]+".bin",maximum=max(capture.CSV_LIMIT,capture.SCOREBOARD_LIMIT))
        need(validate_records(Path(temporary)/"data"),"feedback_committed_record_missing")
        need(view.git(["rev-parse","HEAD"],128).strip().decode()==expected_head,"feedback_committed_head_changed")
        return {"version":1,"kind":"nfl.committed_feedback_validation.v1","status":"committed_records_valid",
            "head":expected_head,"profile_id":export.fingerprint(PROFILE),"files":len(view.files),"bytes":view.total,
            "source_writes":False,"temporary_files_written":True,"network_used":False,"engine_loaded":False,
            "model_adoption":False,"provider_authenticated":False,"public_serving_verified":False}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout",required=True)
    parser.add_argument("--expected-head",required=True)
    args=parser.parse_args(argv)
    try:
        print(json.dumps(check_committed(args.checkout,args.expected_head),sort_keys=True));return 0
    except Exception:
        print(json.dumps({"version":1,"status":"committed_feedback_refused","source_writes":False,
            "public_serving_verified":False,"model_adoption":False},sort_keys=True),file=sys.stderr);return 2


if __name__=="__main__":raise SystemExit(main())
