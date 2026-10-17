"""Small MODEL record derived from saved NFL shadow feedback, never activation."""
import datetime as dt
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo

KEY="_shared_feedback_status"
STAGE="Shared parlay feedback pilot"
REASON=re.compile(r"[a-z][a-z0-9_]{0,99}\Z")


def need(value):
    if not value:raise ValueError("invalid_shared_feedback_status")


def instant(value):
    need(type(value) is str)
    stamp=dt.datetime.fromisoformat(value.replace("Z","+00:00"))
    need(stamp.tzinfo is not None and stamp.utcoffset() is not None)
    return stamp.astimezone(dt.timezone.utc)


def count(value):
    need(type(value) is int and 0<=value<=1000000000)
    return value


def metric(value):
    need(value is None or type(value) in(int,float)and math.isfinite(value))
    return "unavailable"if value is None else format(value,".4f")


def clock(value):
    return instant(value).astimezone(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d %H:%M %Z")


def stage_status(data):
    """Use the newest recorded daily/gameday attempt, not daily's old success.

    A newly opened run with no feedback row is not a completed attempt. Skip
    rows have no stage clocks in the existing R88 format, so their run clock is
    the ordering witness. Legacy single-workflow rows remain readable; multiple
    unclocked rows or contradictory ties cannot establish which was latest.
    """
    from scripts import run_parlay_feedback as files
    path=data/"pipeline_stages.json"
    if not path.exists():return "not_recorded"
    try:
        doc=files.read_json(path)
        blocks=doc["workflows"];need(type(blocks) is dict)
        attempts=[]
        for workflow in("daily","gameday"):
            if workflow not in blocks:continue
            block=blocks[workflow];need(type(block) is dict)
            rows=block["stages"];need(type(rows) is list and len(rows)<=1000)
            matches=[r for r in rows if type(r) is dict and r.get("name")==STAGE]
            run_start=instant(block["run_started_utc"])if block.get("run_started_utc")is not None else None
            run_end=instant(block["run_finished_utc"])if block.get("run_finished_utc")is not None else None
            need(run_start is None or run_end is None or run_start<=run_end)
            if not matches:
                if run_start is not None:attempts.append((run_end or run_start,"not_recorded"))
                continue
            need(len(matches)==1 and matches[0].get("status") in("ok","failed","skipped"))
            row=matches[0];status=row["status"]
            start=instant(row["started_utc"])if row.get("started_utc")is not None else None
            end=instant(row["finished_utc"])if row.get("finished_utc")is not None else None
            need(start is None or end is None or start<=end)
            need(run_start is None or start is None or run_start<=start)
            need(run_start is None or end is None or run_start<=end)
            need(run_end is None or end is None or end<=run_end)
            if status!="skipped"and(run_start is not None or start is not None):need(end is not None)
            attempts.append((end or run_end or run_start,status))
        if not attempts:return "not_recorded"
        if len(attempts)==1:return attempts[0][1]
        need(all(when is not None for when,_ in attempts))
        latest=max(when for when,_ in attempts)
        statuses={status for when,status in attempts if when==latest};need(len(statuses)==1)
        return statuses.pop()
    except (ValueError,OSError,KeyError,TypeError,AttributeError,RecursionError):return "unreadable"


def load(data_dir):
    """Read a bounded complete record; failures never become zero-valued scores."""
    from scripts import run_parlay_feedback as files
    data=files.selected(data_dir)
    value={"status":"absent","stage":stage_status(data)}
    if not (data/"learning_feedback.json").exists()and not(data/"learning_feedback.json").is_symlink():return value
    try:
        need(files.validate_records(data))
        root=files.export._delivery_path(data,"snapshots","learning_feedback")
        pointer,state=files.previous(data,root)
        evaluation=files.read_json(files.artifact(root,"evaluations",pointer["evaluation_id"]))
        report=evaluation["report"]
        need(type(evaluation["version"]) is int and evaluation["version"]==1 and evaluation["kind"]=="nfl.file_feedback_evaluation.v1")
        need(evaluation["model_adoption"]is False and evaluation["public_serving_verified"]is False)
        need(type(report) is dict and type(report["version"]) is int and report["version"]==1 and report["kind"]=="nfl.my_props.walk_forward.v1")
        need(report["report_id"]==files.export.fingerprint({k:v for k,v in report.items()if k!="report_id"}))
        need(report["automatic_promotion"]is False and report["public_serving_verified"]is False)
        need(instant(report["as_of_utc"])==instant(evaluation["as_of_utc"]))
        gate=report["proposed_shared_return_gate"]
        need(type(gate) is dict and type(gate["passed"]) is bool and type(gate["failures"]) is list and len(gate["failures"])<=100)
        need(gate["passed"]==(len(gate["failures"])==0))
        count(report["cohort_n"]);count(report["captured_forecast_n"]);count(report["metrics"]["n"])
        for key in("incumbent_brier","candidate_brier","incumbent_log_loss","candidate_log_loss"):
            metric(report["metrics"][key])
        need(type(report["excluded"]) is dict and len(report["excluded"])<=1000)
        for reason,n in report["excluded"].items():need(type(reason) is str);count(n)
        receipts,revisions=state["receipts"],state["revisions"]
        need(type(receipts) is list and len(receipts)<=50000 and type(revisions) is list and len(revisions)<=200000)
        need(report["metrics"]["n"]<=report["cohort_n"]<=report["captured_forecast_n"]<=len(receipts))
        if report["metrics"]["n"]==0:
            need(all(report["metrics"][key]is None for key in("incumbent_brier","candidate_brier","incumbent_log_loss","candidate_log_loss")))
        forecasts=[r["forecast_created_utc"]for r in receipts]
        latest=max(forecasts,key=instant)if forecasts else None
        return {**value,"status":"saved_shadow","report":report,"evaluation_utc":evaluation["as_of_utc"],
            "state_id":state["state_id"],"receipt_vintages":len(receipts),"revisions":len(revisions),
            "corrections":sum(r["supersedes"]is not None for r in revisions),"latest_forecast_utc":latest}
    except (ValueError,OSError,KeyError,TypeError,AttributeError,RecursionError):
        return {**value,"status":"invalid"}


def _reasons(values):
    # Report strings are data, not authority or UI instructions. Only bounded
    # machine codes are displayed; unknown diagnostics never leak into the UI.
    values=[v.replace("_"," ")if type(v) is str and REASON.fullmatch(v)else"validation issue"for v in values]
    return "; ".join(values[:3])+("; additional reasons in saved report"if len(values)>3 else"")


def derive(value):
    stage={"ok":"latest pipeline stage completed","failed":"latest pipeline attempt FAILED; saved results are not a fresh success",
        "skipped":"latest pipeline stage SKIPPED or disabled","not_recorded":"no current pipeline attempt on file",
        "unreadable":"pipeline attempt status could not be verified"}.get(value.get("stage"),"pipeline attempt status unknown")
    effective={"state":"unknown","source":"data/learning_feedback.json","since_utc":None,"version":None,
        "note":"Shared evaluation is not model activation or proof of public serving.","observed_utc":None}
    row={"id":"shared_nfl_feedback","group":"measure","name":"Shared NFL feedback (shadow)",
        "learns":"source-complete frozen MY-yardage forecasts, observed outcomes and correction revisions",
        "moves":"nothing directly; owner-controlled candidate return is separate","source":"data/learning_feedback.json",
        "state":"absent","why":"No saved shared feedback record; "+stage+".","last_run_utc":None,"effective":effective}
    if value.get("status")=="invalid":
        row["why"]="Shared feedback integrity could not be verified; metrics withheld. "+stage+"."
    elif value.get("status")=="saved_shadow":
        report=value["report"];metrics=report["metrics"];gate=report["proposed_shared_return_gate"]
        decision="Numeric gate passed; candidate remains shadow and requires explicit approval"if gate["passed"]else"HOLD: "+_reasons(gate["failures"])
        exclusions=_reasons([reason+"_"+str(n)for reason,n in sorted(report["excluded"].items())])if report["excluded"]else"none recorded"
        row.update(state="measuring",last_run_utc=value["evaluation_utc"],
            why=decision+". "+stage+". Retrospective walk-forward policy evaluation is not proof of future accuracy. Exclusions: "+exclusions+".",
            live=(f"{value['receipt_vintages']} receipt vintages; {report['cohort_n']} unique graded legs; {metrics['n']} held-out comparison legs; "
                f"Brier incumbent/candidate {metric(metrics['incumbent_brier'])}/{metric(metrics['candidate_brier'])}; "
                f"log loss incumbent/candidate {metric(metrics['incumbent_log_loss'])}/{metric(metrics['candidate_log_loss'])}; "
                f"{value['corrections']} appended per-receipt correction revisions (not additional samples)"))
        if value["latest_forecast_utc"]:
            row["why"]+=" Latest captured forecast: "+clock(value["latest_forecast_utc"])+"; public offering time unverified."
        effective.update(state="measure_only",version="feedback:"+value["state_id"][7:23],observed_utc=value["evaluation_utc"])
    return row
