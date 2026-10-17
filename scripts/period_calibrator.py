"""Explicit local operator control of a fixed MY-yardage candidate for a period.

Not discovered from JSON, environment, uploads or a PASS flag. The configured
filesystem operator/authority/evidence reader are trusted; this is not hosted
owner authentication, Git publication, a release or prospective accuracy proof.
V1 materialization/diagnostic contracts remain unchanged. Production/workflow
activation and final committed-tree publication checks are separate gates.
"""
from scripts import learning_receipts as lr, materialize_calibrator as model
from scripts import run_parlay_feedback as files

NS={"domain":"nfl","task":"nfl.parlay_leg","producer_id":"nfl2026"}
MARKETS=["qb_pass_yds","rb_rush_yds","wr_rec_yds"]
SCOPE_KEYS={"version","kind","season","week","base_model_version","nfl_code_id","engine_code_id",
    "receipt_policy","markets","evidence_basis","max_candidate_age_seconds","max_source_age_seconds","scope_id"}
PACKAGE_KEYS={"version","kind","scope","state","graph","evaluation","engine_commit","created_utc"}
REVOKE_KEYS={"version","kind","previous_event_id","target_package_id","target_pins","recorded_utc"}
PLAN_KEYS={"version","kind","scope_id","candidate_id","artifact_id","owner_head_event_id","evidence_object_id","nfl_code_id",
    "action","base_model_version","adjustment","current_id","previous_current_id","previous_application_id","previous_pool_id",
    "forecast_created_utc","source_snapshot_id","schedule_id","eligible_game_ids","schedule_issued_utc",
    "owner_recorded_utc","package_received_utc","expires_utc","evidence_basis","input_capture_id","application_context_id"}
INPUT_FILES={'pool_backtest':'leg_pool_backtest.json','player_weekly':'player_weekly.json',
    'player_projections':'player_projections.json','game_predictions':'game_predictions.json','parlays':'parlays.json',
    'atd_week':'atd_week.json','atd_backtest':'atd_backtest.json','schedule':'schedule_full.json'}
FRESHNESS_FILES = {'injuries': 'injuries.json', 'depth_chart': 'depth_chart.json', 'inactives': 'inactives.json'}
CODE=("scripts/build_leg_pool.py","scripts/build_my_cards.py","scripts/learning_receipts.py",
      "scripts/learning_journal.py","scripts/models/my_cards.py","scripts/models/parlay_builder.py",
      "scripts/availability.py","scripts/period_calibrator.py","scripts/build_weekly.py",
      "scripts/build_predictions.py","scripts/scrape/renames.py","scripts/excluded_games.py",
      "scripts/materialize_calibrator.py","scripts/run_parlay_feedback.py","scripts/export_learning.py",
      "scripts/capture_outcome_evidence.py","scripts/prepublication_semantics.py",
      "scripts/generation_capture_runtime.py","scripts/period_my_generation.py",
      "scripts/period_my_commit_replay.py","scripts/generation_semantic_gate.py",
      "scripts/period_source_eligibility.py","scripts/scrape/espn.py",
      "scripts/period_freshness_policy.py", "scripts/my_freshness.py",
      "scripts/period_publication_gate.py", "scripts/selected_my_publication_gate.py",
      "scripts/run_my_generation.py", "scripts/pilot_config.py", "scripts/publish_my_generation.py",
      "scripts/selected_legacy_bootstrap.py")


class PeriodReturnError(ValueError):pass


def need(value,reason="period_return_invalid"):
    if not value:raise PeriodReturnError(reason)


def stamp(value):
    parsed=lr.instant(value);need(type(value)is str and parsed is not None,"period_return_clock_invalid")
    return parsed


def sealed(value,key):return {**value,key:lr.fingerprint(value)}


def layer_id(base,adjustment,artifact=None):
    model.digest(base)
    if adjustment is not None:model.coefficients(adjustment)
    if artifact is not None:model.digest(artifact)
    return lr.fingerprint({"version":2,"kind":"nfl.period_return_current.v2","base_model_version":base,
        "adjustment":adjustment,"artifact_id":artifact})


def nfl_code_id():
    return lr.fingerprint({"profile":"nfl.period_return_consumer.v2",
        "sources":{name:files.hashlib.sha256((files.ROOT/name).read_bytes()).hexdigest()for name in CODE}})


class PeriodCalibrator:
    """Configured application capability, never a parsed request's authority.

    All sporting data is read from one repository data root. New decisions and
    generations require an explicit call. Nothing here chooses a candidate,
    fits a different equation or grants production release authority.
    """
    def __init__(self,*,data_dir,engine_checkout,engine_commit,authority_id,actor_ref,clock=files.now,
                 freshness_profile=None):
        from scripts import my_freshness
        need(freshness_profile in (None, my_freshness.PROFILE), 'MY_freshness_profile_unknown')
        self.freshness_profile = freshness_profile
        self.data=files.selected(data_dir);need(self.data!=files.ROOT,"period_return_output_overlaps_code")
        self.core,self.engine_identity,self.engine_code=files.engine(engine_checkout,engine_commit)
        self.engine_checkout=files.selected(engine_checkout)
        self.engine_commit=engine_commit;self.clock=clock
        need(callable(clock));model.digest(authority_id);model.text(actor_ref)
        self.authority_id,self.actor_ref=authority_id,actor_ref
        from selflearn_core import owner_intents
        from selflearn_core.store.file_owner_intents import FileOwnerIntentJournal
        self.dto=owner_intents
        self.journal=FileOwnerIntentJournal(self.path('owner'),authority_id=authority_id,actor_ref=actor_ref,
            evidence_reader=self._object_bytes,clock=clock)

    def path(self,*parts):return files.export._delivery_path(self.data,'learning_control',*parts)

    def _replace(self,path,value):
        path=files.export._delivery_path(self.data,*path.relative_to(self.data).parts)
        raw=files.export.encoded(value)+b'\n';need(len(raw)<=files.MAX_BYTES,'period_return_evidence_limit')
        path.parent.mkdir(parents=True,exist_ok=True)
        temporary=None
        try:
            with files.tempfile.NamedTemporaryFile(dir=path.parent,prefix='.period-',delete=False)as stream:
                temporary=files.Path(stream.name);stream.write(raw);stream.flush();files.os.fsync(stream.fileno())
            files.os.replace(temporary,path)
            fd=files.os.open(path.parent,files.os.O_RDONLY)
            try:files.os.fsync(fd)
            finally:files.os.close(fd)
            return raw
        finally:
            if temporary is not None:temporary.unlink(missing_ok=True)

    def _immutable(self,folder,value,identity):
        path=self.path(folder,identity[7:]+'.json')
        files.capture._immutable(path,files.export.encoded(value)+b'\n')
        return path

    def _recover(self):
        """Roll back an unacknowledged local two-file write, never its history."""
        path=self.path('pending.json')
        if not path.exists():return
        pending=files.read_json(path);model.hashed(pending,'transaction_id')
        need(set(pending)=={'version','kind','previous_pool_id','new_pool_id','previous_pointer','new_pointer','transaction_id'}
             and type(pending['version'])is int and pending['version']==2
             and pending['kind']=='nfl.period_return_local_transaction.v2','period_return_transaction_invalid')
        model.digest(pending['previous_pool_id']);model.digest(pending['new_pool_id'])
        for key in('previous_pointer','new_pointer'):
            p=pending[key]
            if p is None:
                need(key=='previous_pointer','period_return_transaction_invalid');continue
            self._pointer(p)
            a=self._application(p['application_id'])
            need(a['pool_id']==pending['previous_pool_id'if key=='previous_pointer'else'new_pool_id'],
                 'period_return_transaction_invalid')
        before=files.read_json(self.path('pools',pending['previous_pool_id'][7:]+'.json'))
        need(lr.fingerprint(before)==pending['previous_pool_id'],'period_return_recovery_missing_previous_pool')
        actual=files.read_json(self.data/'leg_pool.json')
        need(lr.fingerprint(actual)in(pending['previous_pool_id'],pending['new_pool_id']),
             'period_return_recovery_concurrent_pool')
        current=self.path('current.json');pointer=files.read_json(current)if current.exists()else None
        need(any(files.export._same_json(pointer,p)for p in(pending['previous_pointer'],pending['new_pointer'])),
             'period_return_recovery_concurrent_pointer')
        self._replace(self.data/'leg_pool.json',before)
        if pending['previous_pointer']is None:
            current.unlink(missing_ok=True)
        else:self._replace(current,pending['previous_pointer'])
        self._immutable('transactions',pending,pending['transaction_id'])
        self._remove(path)

    def _remove(self,path):
        path.unlink()
        fd=files.os.open(path.parent,files.os.O_RDONLY)
        try:files.os.fsync(fd)
        finally:files.os.close(fd)

    def _object_bytes(self,oid):
        model.digest(oid)
        path=self.path('evidence',oid[7:]+'.json')
        # Same bounded reader as feedback; original JSON bytes are returned to
        # the shared port, which independently checks the object and timestamp.
        files.read_json(path)
        with path.open('rb')as stream:raw=stream.read(files.MAX_BYTES+1)
        need(len(raw)<=files.MAX_BYTES,"period_return_evidence_limit")
        return raw

    def _save_object(self,payload):
        oid=lr.fingerprint(payload);path=self.path('evidence',oid[7:]+'.json')
        if path.exists():
            value=self.journal.get_object(oid)
            need(files.export._same_json(value['payload'],payload));return oid
        value={"object_id":oid,"kind":"source_snapshot","payload":payload,"received_utc":self.clock()}
        need(len(files.export.encoded(value))<files.MAX_BYTES,"period_return_evidence_limit")
        files.capture._immutable(path,files.export.encoded(value)+b'\n')
        return oid

    def _scope(self,value):
        need(type(value)is dict and set(value)==SCOPE_KEYS)
        need(type(value['version'])is int and value['version']==2 and value['kind']=='nfl.period_return_scope.v2',
             'period_return_wrong_scope_version')
        model.integer(value['season'],2000,2100);model.integer(value['week'],1,18)
        for name in('base_model_version','nfl_code_id','engine_code_id'):model.digest(value[name])
        need(value['scope_id']==lr.fingerprint({k:v for k,v in value.items()if k!='scope_id'}))
        need(files.export._same_json(value['markets'],MARKETS)and value['receipt_policy']==lr.POLICY)
        need(value['evidence_basis']=='retrospective_refitting_policy_not_fixed_artifact_prospective_validation')
        need(type(value['max_candidate_age_seconds'])is int and value['max_candidate_age_seconds']==7*86400
             and type(value['max_source_age_seconds'])is int and value['max_source_age_seconds']==12*3600)
        need(value['nfl_code_id']==nfl_code_id()and value['engine_code_id']==self.engine_code,
             'period_return_code_changed')
        need(self.engine_identity()==self.engine_code,'period_return_engine_changed')
        return value

    def prepare(self,*,season,week):
        """Stage a passing real feedback report; never record owner approval."""
        model.integer(season,2000,2100);model.integer(week,1,18)
        need(files.validate_records(self.data),'period_return_feedback_missing')
        pointer,state=files.previous(self.data,self.data/'snapshots/learning_feedback')
        evaluation=files.read_json(files.artifact(self.data/'snapshots/learning_feedback','evaluations',pointer['evaluation_id']))
        full=files.export.plan(self.data/'snapshots');graph={k:full[k]for k in('source_objects','generations')}
        replay=self.core.evaluate(state,graph,as_of_utc=evaluation['as_of_utc'],bootstrap_replicates=files.PROFILE['bootstrap_replicates'])
        need(files.export._same_json(evaluation,replay),'period_return_evaluation_mismatch')
        report=evaluation['report'];candidate=report['candidate']
        model.validate_candidate(candidate);model._report(report,candidate)
        scope=sealed({'version':2,'kind':'nfl.period_return_scope.v2','season':season,'week':week,
            'base_model_version':candidate['base_model_version'],'nfl_code_id':nfl_code_id(),
            'engine_code_id':self.engine_code,'receipt_policy':lr.POLICY,'markets':list(MARKETS),
            'evidence_basis':'retrospective_refitting_policy_not_fixed_artifact_prospective_validation',
            'max_candidate_age_seconds':7*86400,'max_source_age_seconds':12*3600},'scope_id')
        return self._save_object({'version':2,'kind':'nfl.period_return_package.v2','scope':scope,'state':state,
            'graph':graph,'evaluation':evaluation,'engine_commit':self.engine_commit,'created_utc':self.clock()})

    def _package(self,oid):
        obj=self.journal.get_object(oid);pkg=obj['payload']
        need(type(pkg)is dict and set(pkg)==PACKAGE_KEYS and type(pkg['version'])is int and pkg['version']==2
             and pkg['kind']=='nfl.period_return_package.v2','period_return_package_invalid')
        scope=self._scope(pkg['scope']);need(pkg['engine_commit']==self.engine_commit,'period_return_engine_changed')
        need(stamp(pkg['created_utc'])<=stamp(obj['received_utc']))
        # Newer generations may exist, but every member of the approved frozen
        # state/graph must still exist byte-for-byte in its original repository.
        full=files.export.plan(self.data/'snapshots')
        for key in('source_objects','generations'):
            current={r['object_id']if key=='source_objects'else r['request']['object_id']:r for r in full[key]}
            rows=pkg['graph'][key];seen=set()
            for row in rows:
                rid=row['object_id']if key=='source_objects'else row['request']['object_id']
                need(rid not in seen and rid in current and files.export._same_json(row,current[rid]),
                     'period_return_frozen_source_missing');seen.add(rid)
        files.validate_capture_history(self.data,pkg['state'])
        evaluation=pkg['evaluation']
        replay=self.core.evaluate(pkg['state'],pkg['graph'],as_of_utc=evaluation['as_of_utc'],
            bootstrap_replicates=files.PROFILE['bootstrap_replicates'])
        need(files.export._same_json(evaluation,replay),'period_return_evaluation_mismatch')
        candidate=evaluation['report']['candidate'];model.validate_candidate(candidate)
        model._report(evaluation['report'],candidate)
        need(candidate['base_model_version']==scope['base_model_version'])
        return pkg,obj

    def current(self):
        """Join the actual pool to its applied record; never accept a JSON claim."""
        need(not self.path('pending.json').exists(),'period_return_local_transaction_incomplete')
        pool=files.read_json(self.data/'leg_pool.json');base,adjustment=self._pool(pool)
        latest=self.path('current.json')
        if not latest.exists():return layer_id(base,adjustment),None,pool
        pointer=files.read_json(latest);self._pointer(pointer)
        app=self._application(pointer['application_id'])
        need(app['application_id']==pointer['application_id']and app['pool_id']==lr.fingerprint(pool),
             'period_return_current_pool_mismatch')
        need(app['current_id']==layer_id(base,adjustment,app['artifact_id']),'period_return_current_layer_mismatch')
        return app['current_id'],app,pool

    @staticmethod
    def _pool(pool):
        base=pool['base_model_version'];adjustment=pool.get('live_adjustment');layer_id(base,adjustment)
        for row in pool['players']:
            for rung in row['rungs']:
                receipt=rung.get('learning_receipt')
                need(receipt is not None and lr.receipt_problem(receipt,{**row,**rung},pool['season'],pool['week'])is None
                     and receipt['base_model_version']==base
                     and receipt['calibrator_version']==lr.fingerprint(adjustment),'period_return_current_receipts_unverified')
        return base,adjustment

    @staticmethod
    def _pointer(pointer):
        model.hashed(pointer,'pointer_id')
        need(set(pointer)=={'version','kind','application_id','pointer_id'}and type(pointer['version'])is int
             and pointer['version']==2 and pointer['kind']=='nfl.period_return_pointer.v2')
        model.digest(pointer['application_id'])

    def _application(self,identity):
        model.digest(identity);app=files.read_json(self.path('applications',identity[7:]+'.json'))
        model.hashed(app,'application_id')
        need(set(app)==PLAN_KEYS|{'pool_id','application_id'}and app['application_id']==identity
             and type(app['version'])is int and app['version']==2
             and app['kind']=='nfl.period_return_application.v2')
        plan={k:v for k,v in app.items()if k not in('pool_id','application_id')}
        plan['kind']='nfl.period_return_generation_plan.v2';model.hashed(plan,'application_context_id')
        for key in('pool_id','scope_id','candidate_id','owner_head_event_id','evidence_object_id','base_model_version','input_capture_id','nfl_code_id',
                   'current_id','previous_current_id','previous_pool_id','source_snapshot_id','schedule_id'):model.digest(app[key])
        if app['previous_application_id']is not None:model.digest(app['previous_application_id'])
        need(app['current_id']==layer_id(app['base_model_version'],app['adjustment'],app['artifact_id']))
        need(app['action']in('approve','rollback','revoke')and(app['artifact_id']is None)==(app['action']=='revoke'))
        games=app['eligible_game_ids']
        need(type(games)is list and 1<=len(games)<=32 and all(type(g)is str and 0<len(g)<=200 for g in games)
             and games==sorted(set(games)))
        for key in('forecast_created_utc','schedule_issued_utc','owner_recorded_utc','package_received_utc'):stamp(app[key])
        if app['expires_utc']is not None:stamp(app['expires_utc'])
        original=self._inputs(app['input_capture_id'])
        need(original['inputs']['generated_utc']==app['forecast_created_utc'],'period_return_input_capture_invalid')
        need(lr.fingerprint(files.export._json(original['files']['schedule']['raw_utf8']))==app['schedule_id'],
             'period_return_input_capture_invalid')
        return app

    @staticmethod
    def _input_file(path,*,optional=False):
        need(not path.is_symlink(),'period_return_input_symlink')
        try:fd=files.os.open(path,files.os.O_RDONLY|getattr(files.os,'O_NOFOLLOW',0)|getattr(files.os,'O_NONBLOCK',0))
        except FileNotFoundError:
            need(optional,'period_return_input_missing')
            return {'state':'absent_optional','raw_utf8':None,'raw_sha256':None,'content_id':lr.fingerprint(None)},None
        with files.os.fdopen(fd,'rb')as stream:
            need(files.stat.S_ISREG(files.os.fstat(stream.fileno()).st_mode),'period_return_input_not_regular')
            raw=stream.read(files.MAX_BYTES+1)
        need(0<len(raw)<=files.MAX_BYTES,'period_return_evidence_limit')
        doc=files.export._json(raw)
        return {'state':'present','raw_utf8':raw.decode('utf-8'),
            'raw_sha256':'sha256:'+files.hashlib.sha256(raw).hexdigest(),'content_id':lr.fingerprint(doc)},doc

    @staticmethod
    def _exclusions(doc):
        need(type(doc)is dict and type(doc.get('games'))is list,'period_return_exclusions_unverified')
        need(all(type(g)is dict and type(g.get('game_id'))is str and g['game_id']for g in doc['games']),
             'period_return_exclusions_unverified')
        return sorted({g['game_id']for g in doc['games']})

    def repository_snapshot(self):
        """One exact read per consumed file; metadata is not an original byte read."""
        raw,docs={},{}
        for key,name in INPUT_FILES.items():
            path=files.export._delivery_path(self.data,name)
            raw[key],docs[key]=self._input_file(path,optional=key in('atd_week','atd_backtest'))
        raw['excluded_games'],exclusions=self._input_file(files.ROOT/'config/excluded_games.json')
        if self.freshness_profile is not None:
            from scripts import my_freshness
            for key, name in FRESHNESS_FILES.items():
                raw[key], docs[key] = self._input_file(files.export._delivery_path(self.data, name),
                    optional=key != 'injuries')
            sources = {name: docs[name] for name in my_freshness.SOURCE_NAMES}
            for key in FRESHNESS_FILES:
                docs.pop(key)
            docs['my_freshness_sources'] = sources
        docs.pop('schedule')  # selector witness; not a build_leg_pool argument
        docs['excluded_games']=self._exclusions(exclusions)
        need(sum(len(r['raw_utf8'].encode())for r in raw.values()if r['raw_utf8']is not None)<=files.MAX_BYTES,
             'period_return_evidence_limit')
        return docs,raw

    def repository_inputs(self):return self.repository_snapshot()[0]

    def input_capture(self,inputs,raw):
        value=sealed({'version':2,'kind':'nfl.period_return_input_capture.v2','inputs':inputs,'files':raw},'input_capture_id')
        need(len(files.export.encoded(value))+1<=files.MAX_BYTES,'period_return_evidence_limit')
        return value

    def _inputs(self,identity):
        model.digest(identity);value=files.read_json(self.path('inputs',identity[7:]+'.json'))
        model.hashed(value,'input_capture_id')
        need(set(value)=={'version','kind','inputs','files','input_capture_id'}and type(value['version'])is int
             and value['version']==2 and value['kind']=='nfl.period_return_input_capture.v2'
             and value['input_capture_id']==identity,'period_return_input_capture_invalid')
        core_files = set(INPUT_FILES) | {'excluded_games'}
        selected = 'my_freshness_sources' in value['inputs']
        need(type(value['files'])is dict and set(value['files']) == core_files | (set(FRESHNESS_FILES) if selected else set()),
             'period_return_input_capture_invalid')
        decoded={}
        for key,row in value['files'].items():
            need(type(row)is dict and set(row)=={'state','raw_utf8','raw_sha256','content_id'},'period_return_input_capture_invalid')
            if row['state']=='absent_optional':
                need(key in('atd_week','atd_backtest','depth_chart','inactives')and row['raw_utf8']is None and row['raw_sha256']is None)
                doc=None
            else:
                need(row['state']=='present'and type(row['raw_utf8'])is str,'period_return_input_capture_invalid')
                body=row['raw_utf8'].encode();need(row['raw_sha256']=='sha256:'+files.hashlib.sha256(body).hexdigest(),
                    'period_return_input_capture_invalid');doc=files.export._json(body)
            need(row['content_id']==lr.fingerprint(doc),'period_return_input_capture_invalid')
            decoded[key]=self._exclusions(doc)if key=='excluded_games'else doc
        if selected:
            from scripts import my_freshness
            sources = {name: decoded[name] for name in my_freshness.SOURCE_NAMES}
            for key in FRESHNESS_FILES:
                decoded.pop(key)
            decoded['my_freshness_sources'] = sources
        decoded.pop('schedule')
        need(files.export._same_json({k:v for k,v in value['inputs'].items()if k not in('generated_utc','generation_sha')},decoded),
             'period_return_input_capture_invalid')
        stamp(value['inputs']['generated_utc'])
        return value

    def record_intent(self,oid,*,action,expires_utc=None,reason,acknowledge_retrospective=False):
        """Explicit trusted-local-operator action; not a producer auto-approval."""
        need(action in('approve','revoke','rollback'))
        need(action=='revoke'or acknowledge_retrospective is True,'period_return_risk_ack_required')
        if action!='revoke':
            with self.journal.lock(NS):self._recover()
        head=self.journal.read_owner_intents(NS)
        if action=='revoke':
            # Stopping a candidate must not need the fitter, raw history, the
            # old consumer code, or a healthy current pool. It is an explicit
            # decision over the latest known approval, not a new adoption.
            need(head['events'],'period_return_no_owner_intent')
            last=head['events'][-1];prior=last['command']
            need(prior['action']!='revoke'and prior['pins']['evidence_object_ids']==[oid],
                 'period_return_revoke_target_not_latest')
            note={'version':2,'kind':'nfl.period_return_revocation.v2','previous_event_id':last['event_id'],
                'target_package_id':oid,'target_pins':prior['pins'],'recorded_utc':self.clock()}
            pins={**prior['pins'],'evidence_object_ids':[self._save_object(note)]}
        else:
            pkg,_=self._package(oid);candidate=pkg['evaluation']['report']['candidate']
            current,_,_=self.current()
            pins={'candidate_id':candidate['candidate_id'],'artifact_id':model.artifact_id(candidate),
                'evaluation_report_id':pkg['evaluation']['report']['report_id'],
                'policy_id':model.evaluation_policy_id(pkg['evaluation']['report']),
                'generation_context_id':pkg['scope']['scope_id'],
                'expected_previous_current_id':current,'evidence_object_ids':[oid]}
        raw={'version':1,'kind':'selflearn.owner_intent_command.v1','namespace':dict(NS),'action':action,
            'expected_head_event_id':head['head_event_id'],'pins':pins,
            'effective_from_utc':None,'expires_utc':None if action=='revoke'else expires_utc,'reason':reason}
        command=self.dto.seal_command(raw,authority_id=self.authority_id)
        return self.journal.append_owner_intent(command)

    def _revocation(self,head,event):
        pins=event['command']['pins'];obj=self.journal.get_object(pins['evidence_object_ids'][0]);note=obj['payload']
        need(type(note)is dict and set(note)==REVOKE_KEYS and type(note['version'])is int and note['version']==2
             and note['kind']=='nfl.period_return_revocation.v2','period_return_revocation_invalid')
        need(len(head['events'])>=2,'period_return_revocation_invalid')
        previous=head['events'][-2];prior=previous['command']
        need(prior['action']!='revoke'and note['previous_event_id']==previous['event_id']
             and prior['pins']['evidence_object_ids']==[note['target_package_id']]
             and files.export._same_json(note['target_pins'],prior['pins'])
             and all(files.export._same_json(pins[k],prior['pins'][k])for k in pins if k!='evidence_object_ids')
             and stamp(note['recorded_utc'])<=stamp(obj['received_utc'])<=stamp(event['recorded_utc']),
             'period_return_revocation_invalid')
        return obj

    def select(self,inputs,context,legacy):
        """Read actual authority and reexecute its evidence for this generation."""
        started=stamp(self.clock());created=stamp(context['forecast_created_utc'])
        code=nfl_code_id()
        capture=self._generation_inputs
        need(files.export._same_json(capture['inputs'],inputs),'period_return_inputs_changed')
        need(inputs['pool_backtest']['verdict']['adopt']is True,'period_return_base_gate_held')
        model.integer(inputs['parlays']['season'],2000,2100);model.integer(inputs['parlays']['week'],1,18)
        need(created<=started and (started-created).total_seconds()<=120,'period_return_generation_clock_stale')
        head=self.journal.read_owner_intents(NS)
        need(head['events'],'period_return_no_owner_intent')
        need(all(e['actor_ref']==self.actor_ref for e in head['events']),'period_return_actor_mismatch')
        event=head['events'][-1];cmd=event['command'];pins=cmd['pins']
        need(len(pins['evidence_object_ids'])==1,'period_return_package_partition')
        action=cmd['action'];coefficient=legacy;artifact=None
        if action=='revoke':
            obj=self._revocation(head,event)
            # The reset may proceed without the revoked candidate's evidence.
            # Source and pre-kickoff checks still apply to the fallback pool.
            scope={'scope_id':pins['generation_context_id'],'max_source_age_seconds':12*3600,
                'evidence_basis':'retrospective_refitting_policy_not_fixed_artifact_prospective_validation'}
        else:
            need(head['head_sequence']<self.dto.MAX_EVENTS and len(self.dto.canonical(head['events']))
                 <=self.dto.MAX_HISTORY_BYTES-(self.dto.MAX_COMMAND_BYTES+4097),
                 'period_return_owner_capacity_unavailable')
            pkg,obj=self._package(pins['evidence_object_ids'][0]);scope=pkg['scope'];candidate=pkg['evaluation']['report']['candidate']
            need(scope['season']==context['season']and scope['week']==context['week'],'period_return_wrong_period')
            need(scope['base_model_version']==context['base_model_version'],'period_return_base_changed')
            need(pins['candidate_id']==candidate['candidate_id']and pins['artifact_id']==model.artifact_id(candidate)
                 and pins['evaluation_report_id']==pkg['evaluation']['report']['report_id']
                 and pins['policy_id']==model.evaluation_policy_id(pkg['evaluation']['report'])
                 and pins['generation_context_id']==scope['scope_id'],'period_return_owner_pin_mismatch')
        need(stamp(obj['received_utc'])<=stamp(event['recorded_utc'])<=created,'period_return_approval_after_forecast')
        current,previous,before=self.current()
        if action!='revoke':
            target=layer_id(context['base_model_version'],candidate['coefficients'],pins['artifact_id'])
            need(pins['expected_previous_current_id']==current or current==target and previous is not None
                 and previous['owner_head_event_id']==event['event_id'],'period_return_incumbent_changed')
            need(stamp(event['effective_from_utc'])<=created<stamp(cmd['expires_utc']),'period_return_approval_expired')
            fit=stamp(candidate['fit_as_of_utc'])
            need(fit<=created and (created-fit).total_seconds()<=scope['max_candidate_age_seconds'],
                 'period_return_candidate_stale')
            coefficient=candidate['coefficients'];artifact=pins['artifact_id']
            if action=='rollback':
                cursor=previous;found=False
                for _ in range(256):
                    if cursor is None:break
                    if cursor['artifact_id']==artifact and cursor['base_model_version']==scope['base_model_version']:found=True;break
                    parent=cursor['previous_application_id']
                    cursor=self._application(parent)if parent else None
                need(found,'period_return_rollback_never_applied')
        for name in('player_weekly','player_projections','game_predictions'):
            source=stamp(context['source_timestamps'][name])
            need(0<=(created-source).total_seconds()<=scope['max_source_age_seconds'],'period_return_source_stale')
        schedule=files.export._json(capture['files']['schedule']['raw_utf8']);model.integer(schedule['season'],2000,2100)
        need(schedule['season']==context['season'],'period_return_schedule_wrong_season')
        source=stamp(schedule.get('updated_utc')or schedule.get('generated_utc'))
        need(0<=(created-source).total_seconds()<=scope['max_source_age_seconds'],'period_return_schedule_stale')
        future={};conflicts=set()
        for game in schedule['games']:
            need(type(game)is dict and type(game.get('game_id'))is str and game['game_id']
                 and type(game.get('week'))is int and 1<=game['week']<=18,'period_return_schedule_game_invalid')
            gid=str(game['game_id'])
            if gid in future and not files.export._same_json(future[gid],game):conflicts.add(gid)
            future[gid]=game
        eligible=sorted(gid for gid,g in future.items()if gid not in conflicts and g['week']==context['week']
            and g['status']=='STATUS_SCHEDULED'and lr.instant(g.get('kickoff_utc'))is not None and created<stamp(g['kickoff_utc']))
        for game in inputs['game_predictions']['games']:
            gid=str(game['game_id'])
            if gid in eligible:
                need(all(files.export._same_json(game.get(k),future[gid].get(k))
                     for k in('week','home','away','kickoff_utc')),'period_return_schedule_game_mismatch')
                # The published week_game_rows contract deliberately omits
                # status. The captured full schedule owns that authority. A
                # contrary explicit status (including null) still fails.
                need('status'not in game or files.export._same_json(game['status'],future[gid].get('status')),
                     'period_return_schedule_game_mismatch')
        need(eligible,'period_return_no_future_games')
        now=stamp(self.clock());need(0<=(now-started).total_seconds()<=900,'period_return_verification_deadline')
        need(self.journal.read_owner_intents(NS)['head_event_id']==event['event_id'],'period_return_owner_changed')
        need(nfl_code_id()==code and self.engine_identity()==self.engine_code,'period_return_code_changed')
        value={'version':2,'kind':'nfl.period_return_generation_plan.v2','scope_id':scope['scope_id'],
            'candidate_id':pins['candidate_id'],'artifact_id':artifact,'owner_head_event_id':event['event_id'],
            'evidence_object_id':pins['evidence_object_ids'][0],
            'nfl_code_id':code,
            'input_capture_id':capture['input_capture_id'],
            'action':action,'base_model_version':context['base_model_version'],'adjustment':coefficient,
            'current_id':layer_id(context['base_model_version'],coefficient,artifact),'previous_current_id':current,
            'previous_application_id':previous['application_id']if previous else None,
            'previous_pool_id':lr.fingerprint(before),
            'forecast_created_utc':context['forecast_created_utc'],'source_snapshot_id':context['source_snapshot_id'],
            'schedule_id':lr.fingerprint(schedule),'eligible_game_ids':eligible,
            'schedule_issued_utc':schedule.get('updated_utc')or schedule.get('generated_utc'),
            'owner_recorded_utc':event['recorded_utc'],'package_received_utc':obj['received_utc'],
            'expires_utc':cmd['expires_utc'],'evidence_basis':scope['evidence_basis']}
        return sealed(value,'application_context_id')

    def apply_and_save(self,inputs=None,*,capture_runtime=None,capture_out_dir=None):
        """Actual local pool generation plus application record; no Git push."""
        from scripts import build_leg_pool
        from scripts import generation_capture_runtime as runtime
        need((capture_runtime is None)==(capture_out_dir is None),'period_return_capture_pair_required')
        if capture_runtime is not None:
            need(type(capture_runtime)is runtime.GenerationCapture and inputs is None,
                 'period_return_configured_capture_required')
            need(self.data==capture_runtime.checkout/'data','period_return_capture_data_mismatch')
            runtime._output_root(capture_out_dir,capture_runtime.checkout)
            runtime._output_root(capture_out_dir,self.engine_checkout)
            # These are the parsed values actually returned by the earlier
            # explicit loader. The repository reads below are REVALIDATION,
            # never relabeled as that earlier original read.
            inputs=capture_runtime.pool_inputs(freshness_profile=self.freshness_profile)
        with self.journal.lock(NS):
            self._recover()
            actual,raw=self.repository_snapshot()
            if inputs is None:inputs={**actual,'generated_utc':self.clock()}
            else:
                normalized={k:sorted(v)if k=='excluded_games'and type(v)in(set,frozenset)else v for k,v in inputs.items()}
                need(files.export._same_json({k:v for k,v in normalized.items()if k not in('generated_utc','generation_sha')},actual),
                     'period_return_inputs_do_not_match_repository')
                inputs=normalized
            inputs=self.core.plain(inputs)
            if 'generation_sha'not in inputs:inputs['generation_sha']=files.os.environ.get('GITHUB_SHA')
            self._generation_inputs=self.input_capture(inputs,raw)
            if capture_runtime is not None:
                source=capture_runtime.loader['capture']['inputs']
                for name,row in raw.items():
                    expected=source[name]
                    original=expected['raw_utf8'].encode()
                    need((row['state']=='absent_optional')==
                         (capture_runtime.loader['read_observations'][name]['state']=='absent_optional')
                         and (row['raw_utf8'].encode()if row['raw_utf8']is not None else b'null')==original,
                         'period_return_original_capture_changed')
            doc=build_leg_pool.build(inputs,calibration_return=self)
            need(doc['calibration_adopted']is True,'period_return_base_gate_held')
            plan=self.last_plan
            need(self.journal.read_owner_intents(NS)['head_event_id']==plan['owner_head_event_id'],'period_return_owner_changed')
            current_id,current,before=self.current()
            need((current['application_id']if current else None)==plan['previous_application_id'],'period_return_current_changed')
            need(current_id==plan['previous_current_id'],'period_return_current_changed')
            need(self.engine_identity()==self.engine_code,'period_return_engine_changed')
            need(files.git(self.engine_checkout,'rev-parse','HEAD')==self.engine_commit,'period_return_engine_changed')
            need(nfl_code_id()==plan['nfl_code_id'],'period_return_code_changed')
            final_inputs,final_raw=self.repository_snapshot()
            need(files.export._same_json(final_inputs,actual)and files.export._same_json(final_raw,raw),
                 'period_return_inputs_changed')
            schedule=files.read_json(self.data/'schedule_full.json')
            need(lr.fingerprint(schedule)==plan['schedule_id'],'period_return_schedule_changed')
            final=stamp(self.clock());created=stamp(plan['forecast_created_utc'])
            need(0<=(final-created).total_seconds()<=900,'period_return_verification_deadline')
            if plan['expires_utc']is not None:need(final<stamp(plan['expires_utc']),'period_return_approval_expired')
            cutoffs={g['game_id']:g.get('kickoff_utc')for g in schedule['games']}
            need(all(final<stamp(cutoffs[gid])for gid in plan['eligible_game_ids']),'period_return_event_started')
            self._immutable('inputs',self._generation_inputs,plan['input_capture_id'])
            value={**plan,'kind':'nfl.period_return_application.v2','pool_id':lr.fingerprint(doc)}
            app=sealed(value,'application_id');self._immutable('applications',app,app['application_id'])
            before_id=lr.fingerprint(before);self._immutable('pools',before,before_id)
            self._immutable('pools',doc,app['pool_id'])
            old_path=self.path('current.json');old_pointer=files.read_json(old_path)if old_path.exists()else None
            pointer=sealed({'version':2,'kind':'nfl.period_return_pointer.v2','application_id':app['application_id']},'pointer_id')
            pending=sealed({'version':2,'kind':'nfl.period_return_local_transaction.v2',
                'previous_pool_id':before_id,'new_pool_id':app['pool_id'],
                'previous_pointer':old_pointer,'new_pointer':pointer},'transaction_id')
            self._replace(self.path('pending.json'),pending)
            # Git publication is still a separate atomic boundary. A partial
            # local write must never be presented as a successful live release.
            pool_raw=self._replace(self.data/'leg_pool.json',doc)
            if capture_runtime is not None:
                # Persist the exact writer buffer BEFORE acknowledging the new
                # current pointer. A capture failure leaves the normal pending
                # transaction for recovery and cannot become a publishable pool.
                checkpoint=capture_runtime.record_pool_bytes(pool_raw)
                runtime.persist(checkpoint,capture_out_dir,checkout=capture_runtime.checkout)
            self._replace(self.path('current.json'),pointer)
            self._immutable('transactions',pending,pending['transaction_id'])
            self._remove(self.path('pending.json'))
            return doc,app

    def reverify(self):
        """Reexecute an acknowledged LOCAL application without changing its data.

        This is a building block, not the final committed-Git-tree gate. The
        configured clock/filesystem/code remain trusted and public serving is
        not observed. No current approval is inferred from a historical ACK.
        """
        from scripts import build_leg_pool
        with self.journal.lock(NS):
            _,app,pool=self.current();need(app is not None,'period_return_application_missing')
            head=self.journal.read_owner_intents(NS)
            need(head['head_event_id']==app['owner_head_event_id'],'period_return_owner_changed')
            original=self._inputs(app['input_capture_id']);inputs=original['inputs']
            actual,raw=self.repository_snapshot()
            need(files.export._same_json(actual,{k:v for k,v in inputs.items()if k not in('generated_utc','generation_sha')})
                 and files.export._same_json(raw,original['files']),'period_return_inputs_changed')
            before=files.read_json(self.path('pools',app['previous_pool_id'][7:]+'.json'))
            need(lr.fingerprint(before)==app['previous_pool_id'],'period_return_previous_pool_missing')
            prior=self._application(app['previous_application_id'])if app['previous_application_id']else None
            base,adjustment=self._pool(before)
            need(prior is None or prior['pool_id']==app['previous_pool_id'],'period_return_previous_pool_mismatch')
            previous=layer_id(base,adjustment,prior['artifact_id']if prior else None)
            need(previous==app['previous_current_id'],'period_return_previous_layer_mismatch')
            # Only this trusted replay constructs the old read view, from the
            # retained immutable prior pool/application. It never changes the
            # repository's current files or overwrites the owner history.
            view=PeriodCalibrator(data_dir=self.data,engine_checkout=self.engine_checkout,engine_commit=self.engine_commit,
                authority_id=self.authority_id,actor_ref=self.actor_ref,clock=lambda:app['forecast_created_utc'],
                freshness_profile=self.freshness_profile)
            view.current=lambda:(previous,prior,before)
            view._generation_inputs=original
            replay=build_leg_pool.build(inputs,calibration_return=view)
            need(files.export._same_json(view.last_plan,{**{k:v for k,v in app.items()if k not in('pool_id','application_id')},
                 'kind':'nfl.period_return_generation_plan.v2'}),'period_return_application_replay_mismatch')
            need(files.export._same_json(replay,pool),'period_return_pool_replay_mismatch')
            checked=self.clock();final=stamp(checked);created=stamp(app['forecast_created_utc'])
            need(0<=(final-created).total_seconds()<=900,'period_return_verification_deadline')
            if app['expires_utc']is not None:need(final<stamp(app['expires_utc']),'period_return_approval_expired')
            for key in('player_weekly','player_projections','game_predictions'):
                row=actual[key];source=stamp(row.get('generated_utc')or row.get('updated_utc'))
                need(0<=(final-source).total_seconds()<=12*3600,'period_return_source_stale')
            schedule=files.export._json(original['files']['schedule']['raw_utf8'])
            source=stamp(schedule.get('updated_utc')or schedule.get('generated_utc'))
            need(0<=(final-source).total_seconds()<=12*3600,'period_return_schedule_stale')
            cutoffs={g['game_id']:g.get('kickoff_utc')for g in schedule['games']}
            need(all(final<stamp(cutoffs[g])for g in app['eligible_game_ids']),'period_return_event_started')
            if app['action']!='revoke':
                pkg=self.journal.get_object(app['evidence_object_id'])['payload']
                fit=stamp(pkg['evaluation']['report']['candidate']['fit_as_of_utc'])
                need(fit<=final and(final-fit).total_seconds()<=7*86400,'period_return_candidate_stale')
            current_values,current_raw=self.repository_snapshot()
            need(files.export._same_json(current_values,actual)and files.export._same_json(current_raw,raw),
                 'period_return_inputs_changed')
            need(self.journal.read_owner_intents(NS)['head_event_id']==head['head_event_id']
                 and self.current()[1]['application_id']==app['application_id'],'period_return_owner_or_current_changed')
            need(nfl_code_id()==app['nfl_code_id']and self.engine_identity()==self.engine_code,'period_return_code_changed')
            need(files.git(self.engine_checkout,'rev-parse','HEAD')==self.engine_commit,'period_return_engine_changed')
            return {'version':2,'kind':'nfl.period_return_local_replay.v2','status':'local_application_replayed',
                'application_id':app['application_id'],'pool_id':app['pool_id'],'input_capture_id':app['input_capture_id'],
                'owner_head_event_id':head['head_event_id'],'checked_utc':checked,
                'source_writes':False,'temporary_lock_may_be_created':True,'network_used':False,
                'committed_git_tree_verified':False,'public_serving_verified':False,'production_authorized':False}
