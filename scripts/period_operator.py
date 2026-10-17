"""Explicit trusted-local-operator commands for period-return v2.

No command runs on import. This is local filesystem authority, not a hosted
authenticated owner or a production workflow. Preparing/reading evidence never
approves it. Only a separate approve/rollback command with the retrospective
risk acknowledgement records intent; applying is another explicit command.
The publisher continues to refuse v2 until final MY semantics are implemented.
"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts import period_calibrator as period

FLAGS = {'local_filesystem_authority_only': True, 'owner_authenticated': False,
    'publication_authorized': False, 'production_authorized': False,
    'public_serving_verified': False, 'accuracy_improvement_verified': False}


def inspect(control):
    """Report saved application and newest intent separately; never adopt/refit."""
    current_id, application, pool = control.current()
    history = control.journal.read_owner_intents(period.NS)
    event = history['events'][-1] if history['events'] else None
    owner = None
    if event is not None:
        command = event['command']
        expires = command['expires_utc']
        owner = {'event_id': event['event_id'], 'action': command['action'],
            'candidate_id': command['pins']['candidate_id'], 'artifact_id': command['pins']['artifact_id'],
            'evidence_object_ids': command['pins']['evidence_object_ids'], 'expires_utc': expires,
            'expired': expires is not None and period.stamp(control.clock()) >= period.stamp(expires)}
    saved = None if application is None else {key: application[key] for key in (
        'application_id', 'candidate_id', 'artifact_id', 'owner_head_event_id', 'action', 'expires_utc')}
    return {'current_id': current_id, 'saved_application': saved, 'latest_owner_intent': owner,
        'pool_generated_utc': pool.get('generated_utc'),
        'saved_application_matches_latest_intent': application is not None and event is not None
            and application['owner_head_event_id'] == event['event_id'],
        'interpretation': 'saved local generation and latest intent; not current public serving or pipeline health'}


def main(argv=None, *, clock=period.files.now):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('data-dir', 'engine-checkout', 'engine-commit', 'authority-id', 'actor-ref'):
        parser.add_argument('--' + name, required=True)
    commands = parser.add_subparsers(dest='operation', required=True)
    commands.add_parser('inspect', help='Read saved application and latest intent without approval or fitting')
    prepare = commands.add_parser('prepare', help='Stage independently reexecuted evidence; does not approve')
    prepare.add_argument('--season', type=int, required=True)
    prepare.add_argument('--week', type=int, required=True)
    for operation in ('approve', 'rollback', 'revoke'):
        command = commands.add_parser(operation, help='Record explicit local intent; does not apply or publish')
        command.add_argument('--package-id', required=True)
        command.add_argument('--reason', required=True)
        if operation != 'revoke':
            command.add_argument('--expires-utc', required=True)
            command.add_argument('--ack-retrospective-risk', action='store_true',
                help='Acknowledge that refitting-policy evidence is not prospective fixed-artifact validation')
    commands.add_parser('apply', help='Build/save a new local pool under existing verified intent; no auto-approval')
    apply_my = commands.add_parser('apply-my', help='Build/save the actual MY archive with original-input/writer capture; no publication')
    apply_my.add_argument('--generation-sha', required=True)
    apply_my.add_argument('--capture-dir', required=True, help='Private persistent recovery directory outside the checkout')
    commands.add_parser('reverify', help='Read-only replay of the current local application; not a MY publication gate')
    committed_my = commands.add_parser('replay-my-commit',
        help='Replay exact committed MY/application/history bytes; not an upstream eligibility or release gate')
    for name in ('expected-head', 'base-head', 'period-generation-id'):
        committed_my.add_argument('--' + name, required=True)
    args = parser.parse_args(argv)
    try:
        control = period.PeriodCalibrator(data_dir=args.data_dir, engine_checkout=args.engine_checkout,
            engine_commit=args.engine_commit, authority_id=args.authority_id, actor_ref=args.actor_ref, clock=clock)
        if args.operation == 'inspect':
            result = {'status': 'local_state_inspected', 'details': inspect(control)}
        elif args.operation == 'prepare':
            oid = control.prepare(season=args.season, week=args.week)
            result = {'status': 'local_evidence_prepared_not_approved', 'package_id': oid}
        elif args.operation in ('approve', 'rollback', 'revoke'):
            event = control.record_intent(args.package_id, action=args.operation, reason=args.reason,
                expires_utc=getattr(args, 'expires_utc', None),
                acknowledge_retrospective=getattr(args, 'ack_retrospective_risk', False))
            result = {'status': 'local_intent_recorded_not_applied', 'event_id': event['event_id'],
                'action': args.operation}
        elif args.operation == 'apply':
            pool, application = control.apply_and_save()
            result = {'status': 'local_pool_saved_not_published', 'application_id': application['application_id'],
                'artifact_id': application['artifact_id'], 'owner_head_event_id': application['owner_head_event_id'],
                'pool_generated_utc': pool['generated_utc']}
        elif args.operation == 'apply-my':
            from scripts.period_my_generation import generate
            # Keep the operator protocol one JSON result, not MY's human log or
            # private recovery paths. The returned identities trace the records.
            with contextlib.redirect_stdout(io.StringIO()):
                result = generate(control, generation_sha=args.generation_sha, capture_dir=args.capture_dir)
        elif args.operation == 'reverify':
            result = {'status': 'local_application_replayed_not_publication_verified', 'details': control.reverify()}
        else:
            from scripts.period_my_commit_replay import check_committed
            period.need(control.data == control.data.parent / 'data', 'period_MY_checkout_data_required')
            details = check_committed(checkout=control.data.parent, expected_head=args.expected_head,
                base_head=args.base_head, period_generation_id=args.period_generation_id,
                engine_checkout=control.engine_checkout, engine_commit=control.engine_commit,
                authority_id=control.authority_id, actor_ref=control.actor_ref, clock=clock)
            result = {'status': 'committed_MY_replayed_not_publication_verified', 'details': details}
        print(json.dumps({'version': 2, 'kind': 'nfl.period_local_operator_result.v2',
            'operation': args.operation, **result, **FLAGS}, sort_keys=True))
        return 0
    except Exception:
        # Never echo a private path, reason, raw source record, token or tool error.
        print(json.dumps({'version': 2, 'status': 'local_period_operation_refused',
            'operation': args.operation, **FLAGS}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
