"""Reexecute a period application from bounded exact Git blobs, without release.

This is an application-replay building block, NOT the final MY-card semantic
publication gate. It never loads code from the supplied commit, changes its
checkout, pushes, authenticates an owner or claims that Netlify served a card.
The caller configures the trusted engine, authority, actor and clock explicitly.
"""
import argparse
import json
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parent.parent
if str(ROOT)not in sys.path:sys.path.insert(0,str(ROOT))
from scripts import feedback_commit_guard as committed
from scripts import generation_capture_runtime as runtime
from scripts import period_calibrator as period


class Snapshot(committed._Snapshot):
    # Read-only data/source inventory; all inherited file/work/time ceilings
    # and Git regular-mode/blob-integrity checks remain mandatory.
    prefixes=('data/','scripts/','config/excluded_games.json')

    def materialize(self):
        """Bounded raw batches, still verifying each original Git blob hash.

        Large legal files use the original single-blob reader. Small files use
        the already-tested length-framed reader instead of one Git subprocess
        per file. No file or history member is omitted to fit a batch.
        """
        profile=committed.PROFILE;total=0
        for mode,_oid,size in self.tree.values():
            period.need(mode in(b'100644',b'100755')and 0<=size<=profile['maximum_file_bytes'],
                 'period_committed_not_regular_or_oversized')
            total+=size
        period.need(total<=profile['maximum_total_bytes'],'period_committed_total_limit')
        batch=[];size=0
        def flush():
            if not batch:return
            tree={p:(self.tree[p][0],self.tree[p][2])for p in batch}
            values=runtime._head_blobs(self.checkout,self.head,tree,set(batch))
            for relative,raw in values.items():
                _mode,oid,length=self.tree[relative]
                period.need(len(raw)==length and committed.hashlib.sha1(b'blob '+str(length).encode()+b'\0'+raw).hexdigest()==oid,
                     'period_committed_blob_mismatch')
                target=period.files.export._delivery_path(self.destination,*relative.split('/'))
                target.parent.mkdir(parents=True,exist_ok=True)
                with target.open('xb')as stream:stream.write(raw)
                self.files[relative]=target;self.total+=length
        for relative,(_mode,_oid,length)in sorted(self.tree.items()):
            if length>runtime.gate.MAX_FILE:
                flush();batch=[];size=0;self.copy(relative);continue
            if batch and(len(batch)==32 or size+length>32*1024*1024):
                flush();batch=[];size=0
            batch.append(relative);size+=length
        flush()


def check_committed(*,checkout,expected_head,engine_checkout,engine_commit,authority_id,actor_ref,clock=period.files.now):
    """Validate the selected commit, not a repaired or absent working directory."""
    with tempfile.TemporaryDirectory(prefix='nfl-period-tree-')as temporary:
        view=Snapshot(checkout,expected_head,temporary)
        # Conservative Python inventory, not a selected import list. Compare
        # trusted executing source to the commit; never exec uploaded Git code.
        names={p for p in runtime._extra_paths(ROOT)if p.startswith('scripts/')and p.endswith('.py')}
        selected={p for p in view.tree if p.startswith('scripts/')and p.endswith('.py')}
        period.need(names==selected,'period_committed_code_inventory_changed')
        sources=runtime._code(ROOT,names)
        view.materialize()
        for relative,raw in sources.items():
            path=view.copy(relative)
            period.need(path.read_bytes()==raw,'period_committed_code_changed')
        cfg='config/excluded_games.json';cfg_bytes=view.copy(cfg).read_bytes()
        period.need(runtime._read(ROOT/cfg)==cfg_bytes,'period_committed_exclusions_changed')
        for relative in sorted(view.tree):
            if relative.startswith('data/'):view.copy(relative)
        control=period.PeriodCalibrator(data_dir=Path(temporary)/'data',engine_checkout=engine_checkout,
            engine_commit=engine_commit,authority_id=authority_id,actor_ref=actor_ref,clock=clock)
        replay=control.reverify()
        period.need(runtime._code(ROOT,names)==sources and runtime._read(ROOT/cfg)==cfg_bytes,
             'period_committed_runtime_changed')
        period.need(view.git(['rev-parse','HEAD'],128).strip().decode()==expected_head,'period_committed_head_changed')
        return {'version':2,'kind':'nfl.period_committed_application_replay.v2','status':'committed_application_replayed',
            'head':expected_head,'application_replay':replay,'files':len(view.files),'bytes':view.total,
            'committed_data_tree_verified':True,'MY_card_semantics_verified':False,'whole_release_pass':False,
            'source_writes':False,'temporary_files_written':True,'network_used':False,'owner_authenticated':False,
            'public_serving_verified':False,'production_authorized':False}


def main(argv=None,*,clock=period.files.now):
    parser=argparse.ArgumentParser(description=__doc__)
    for name in('checkout','expected-head','engine-checkout','engine-commit','authority-id','actor-ref'):
        parser.add_argument('--'+name,required=True)
    args=parser.parse_args(argv)
    try:
        result=check_committed(checkout=args.checkout,expected_head=args.expected_head,
            engine_checkout=args.engine_checkout,engine_commit=args.engine_commit,
            authority_id=args.authority_id,actor_ref=args.actor_ref,clock=clock)
        print(json.dumps(result,sort_keys=True));return 0
    except Exception:
        print(json.dumps({'version':2,'status':'committed_period_application_refused','source_writes':False,
            'MY_card_semantics_verified':False,'whole_release_pass':False,'production_authorized':False},sort_keys=True),file=sys.stderr)
        return 2


if __name__=='__main__':raise SystemExit(main())
