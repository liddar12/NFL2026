#!/usr/bin/env python3
"""Per-stage pipeline status -> data/pipeline_stages.json (R88, review finding F17).

WHY THIS EXISTS. Each workflow is a chain of steps and several of them are
`continue-on-error`. When a resolver or the replay lab fails, the run is GREEN,
data/pipeline_status.json says nothing about it (it is written *inside*
build_predictions, long before the ledger / resolver / review steps run) and the
only evidence is a line buried in the Actions log. F17's acceptance criterion is
"resolver outage is visible in final health": this document is that visibility.

WHAT IT RECORDS. One entry per pipeline STEP, per workflow, per run:

    {generated_utc, workflows: {daily|gameday|backtest: {
        run_id, run_started_utc, run_finished_utc|null,
        last_success: {<stage>: <utc>},        # the carry, see below
        stages: [{name, status, exit_code, started_utc, finished_utc,
                  duration_s, continue_on_error, last_success_utc, note}]}}}

VERBS
  begin  --workflow W --run-id ID
      Opens a run: resets `stages` for that workflow and CARRIES each stage's
      last success forward, so a stage that has not succeeded in days shows the
      day it last did instead of showing nothing.
  record --workflow W --stage NAME --exit-code N --started UTC --finished UTC
         [--run-id ID] [--continue-on-error]
      Appends (or REPLACES, so a re-run of the same stage is idempotent) the
      stage's outcome. exit 0 -> ok, anything else -> failed.
  skip   --workflow W --stage NAME --reason TEXT
      Records status `skipped` for a step a mode guard did not run (gameday
      scores mode). "Did not run" and "ran and failed" are different facts and
      a reader must be able to tell them apart.

`last_success` is the only field beyond the shape above: `begin` wipes `stages`,
so the carry has to live somewhere the next process can read it. It is the map
the per-stage `last_success_utc` is filled from, nothing more.

scripts/stage.sh is the wrapper the workflows call; it runs the real command,
calls `record` here, and exits with the COMMAND's exit code so a step's
`continue-on-error` keeps its meaning.

Both scripts honour STAGE_STATUS_PATH (tests point it at a temp file); the
default is data/pipeline_stages.json, which is runner-built and never committed
from a clone — validate_data.py registers it OPTIONAL for exactly that reason.

Canonical JSON (CLAUDE.md): ensure_ascii=True, indent=2, trailing newline.

    python3 scripts/stage_status.py --selftest    fixture-driven, never writes data/
"""

import argparse
import datetime as dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))

# The three pipeline workflows. A closed set on purpose: the contract enumerates
# them, and a typo'd --workflow must be a loud error, not a fourth key nobody
# ever reads.
WORKFLOWS = ("daily", "gameday", "backtest")

STATUSES = ("ok", "failed", "skipped")

DEFAULT_PATH = os.path.join(_ROOT, "data", "pipeline_stages.json")


def doc_path():
    """Where the document lives. STAGE_STATUS_PATH wins (tests, dry runs)."""
    return os.environ.get("STAGE_STATUS_PATH") or DEFAULT_PATH


def utc_now():
    """Second-resolution UTC stamp, the repo's usual shape."""
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(text):
    """A stamp -> aware datetime, or None. Never raises: a malformed stamp costs
    a duration, it may not cost the whole record."""
    if not isinstance(text, str) or not text:
        return None
    raw = text.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def duration_s(started, finished):
    """Elapsed seconds between two stamps, or None when either is unreadable.
    A negative span (a clock step) is honestly None rather than a negative
    duration nobody can interpret."""
    a, b = parse_utc(started), parse_utc(finished)
    if a is None or b is None:
        return None
    delta = (b - a).total_seconds()
    return None if delta < 0 else round(delta, 3)


# ---------------------------------------------------------------------------
# Pure core: every verb is doc -> doc. No I/O, so the selftest can drive them
# directly and the shell below is the only thing that touches the filesystem.
# ---------------------------------------------------------------------------

def empty_doc(now=None):
    return {"generated_utc": now or utc_now(), "workflows": {}}


def _workflow_block(doc, workflow):
    block = doc.setdefault("workflows", {}).get(workflow)
    if not isinstance(block, dict):
        block = {"run_id": None, "run_started_utc": None, "run_finished_utc": None,
                 "last_success": {}, "stages": []}
        doc["workflows"][workflow] = block
    block.setdefault("last_success", {})
    block.setdefault("stages", [])
    return block


def carry_map(block):
    """Every stage's last known success in `block`, newest wins.

    Reads the stored carry AND the run's own stages, so a document written
    before this field existed (or hand-edited) still carries what its stage
    rows prove: a stage that says it succeeded at T succeeded at T.
    """
    out = {}
    if isinstance(block, dict):
        stored = block.get("last_success")
        if isinstance(stored, dict):
            for name, when in stored.items():
                if isinstance(name, str) and isinstance(when, str):
                    out[name] = when
        for stage in block.get("stages") or []:
            if not isinstance(stage, dict):
                continue
            name = stage.get("name")
            when = stage.get("last_success_utc")
            if isinstance(name, str) and isinstance(when, str):
                out[name] = when
    return out


def begin(doc, workflow, run_id, now=None):
    """Open a run: reset `stages`, keep the carry."""
    now = now or utc_now()
    doc = dict(doc) if isinstance(doc, dict) else empty_doc(now)
    doc.setdefault("workflows", {})
    carried = carry_map(doc["workflows"].get(workflow))
    doc["workflows"][workflow] = {
        "run_id": None if run_id is None else str(run_id),
        "run_started_utc": now,
        "run_finished_utc": None,
        "last_success": dict(sorted(carried.items())),
        "stages": [],
    }
    doc["generated_utc"] = now
    return doc


def _upsert(block, entry):
    """Replace the stage's entry in place, or append it. Idempotent by NAME: a
    re-run of the same stage inside one run describes the same stage, and two
    rows for it would make the table lie about how many stages there are."""
    for i, existing in enumerate(block["stages"]):
        if isinstance(existing, dict) and existing.get("name") == entry["name"]:
            block["stages"][i] = entry
            return
    block["stages"].append(entry)


def record(doc, workflow, stage, exit_code, started, finished,
           continue_on_error=False, run_id=None, now=None):
    """Record one stage's outcome. exit 0 -> ok, anything else -> failed."""
    now = now or utc_now()
    doc = dict(doc) if isinstance(doc, dict) else empty_doc(now)
    block = _workflow_block(doc, workflow)
    if run_id is not None and not block.get("run_id"):
        block["run_id"] = str(run_id)
    if not block.get("run_started_utc"):
        block["run_started_utc"] = started or now

    code = int(exit_code)
    ok = code == 0
    carried = carry_map(block)
    if ok:
        block["last_success"][stage] = finished or now
    note = None
    if not ok and continue_on_error:
        # The whole point of the document: this stage failed and the run still
        # went green, so the failure has to be written down where a reader looks.
        note = "failed under continue-on-error — the workflow stayed green"
    entry = {
        "name": stage,
        "status": "ok" if ok else "failed",
        "exit_code": code,
        "started_utc": started or None,
        "finished_utc": finished or None,
        "duration_s": duration_s(started, finished),
        "continue_on_error": bool(continue_on_error),
        "last_success_utc": (finished or now) if ok else carried.get(stage),
        "note": note,
    }
    _upsert(block, entry)
    # As far as this document knows, the run has got this far. The steps that
    # follow the last wrapped stage (validate + publish) are the ones that
    # commit it, so this is the honest "finished at" for the record as shipped.
    block["run_finished_utc"] = finished or now
    block["last_success"] = dict(sorted(block["last_success"].items()))
    doc["generated_utc"] = now
    return doc


def skip(doc, workflow, stage, reason, now=None):
    """Record a step a mode guard did not run. NOT a failure, and the reason is
    mandatory: "did not run" with no reason is the same silence F17 is about."""
    now = now or utc_now()
    doc = dict(doc) if isinstance(doc, dict) else empty_doc(now)
    block = _workflow_block(doc, workflow)
    carried = carry_map(block)
    entry = {
        "name": stage,
        "status": "skipped",
        "exit_code": None,
        "started_utc": None,
        "finished_utc": None,
        "duration_s": None,
        "continue_on_error": False,
        "last_success_utc": carried.get(stage),
        "note": reason,
    }
    _upsert(block, entry)
    doc["generated_utc"] = now
    return doc


# ---------------------------------------------------------------------------
# Thin shell.
# ---------------------------------------------------------------------------

def load_doc(path):
    """The document on disk, or an empty one. A corrupt file is NOT fatal: the
    record is an observability aid, and refusing to run because yesterday's
    document is unreadable would turn it into a new way to break the pipeline."""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return empty_doc()
    if not isinstance(doc, dict) or not isinstance(doc.get("workflows"), dict):
        return empty_doc()
    return doc


def write_doc(doc, path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true",
                    help="run the fixture-driven selftest and exit")
    sub = ap.add_subparsers(dest="verb")

    p_begin = sub.add_parser("begin", help="open a run for a workflow")
    p_begin.add_argument("--workflow", required=True, choices=WORKFLOWS)
    p_begin.add_argument("--run-id", default=None)

    p_rec = sub.add_parser("record", help="record one stage's outcome")
    p_rec.add_argument("--workflow", required=True, choices=WORKFLOWS)
    p_rec.add_argument("--stage", required=True)
    p_rec.add_argument("--exit-code", required=True, type=int)
    p_rec.add_argument("--started", required=True)
    p_rec.add_argument("--finished", required=True)
    p_rec.add_argument("--run-id", default=None)
    p_rec.add_argument("--continue-on-error", action="store_true")

    p_skip = sub.add_parser("skip", help="record a stage a mode guard did not run")
    p_skip.add_argument("--workflow", required=True, choices=WORKFLOWS)
    p_skip.add_argument("--stage", required=True)
    p_skip.add_argument("--reason", required=True)

    args = ap.parse_args(argv)
    if args.selftest:
        return _selftest()
    if not args.verb:
        ap.print_help()
        return 2

    path = doc_path()
    doc = load_doc(path)
    if args.verb == "begin":
        doc = begin(doc, args.workflow, args.run_id)
    elif args.verb == "record":
        doc = record(doc, args.workflow, args.stage, args.exit_code,
                     args.started, args.finished,
                     continue_on_error=args.continue_on_error, run_id=args.run_id)
    else:
        doc = skip(doc, args.workflow, args.stage, args.reason)
    write_doc(doc, path)
    return 0


# ---------------------------------------------------------------------------
# Selftest.
# ---------------------------------------------------------------------------

def _selftest():
    import subprocess
    import tempfile

    # 1 — begin / record / skip on a pure document.
    doc = begin(empty_doc("2026-09-18T00:00:00Z"), "daily", "111",
                now="2026-09-18T00:00:00Z")
    assert doc["workflows"]["daily"]["run_id"] == "111"
    assert doc["workflows"]["daily"]["stages"] == []
    assert doc["workflows"]["daily"]["run_finished_utc"] is None

    doc = record(doc, "daily", "Resolve estimates", 0,
                 "2026-09-18T00:00:01Z", "2026-09-18T00:00:04Z",
                 now="2026-09-18T00:00:04Z")
    entry = doc["workflows"]["daily"]["stages"][0]
    assert entry["status"] == "ok" and entry["exit_code"] == 0, entry
    assert entry["duration_s"] == 3.0, entry
    assert entry["last_success_utc"] == "2026-09-18T00:00:04Z", entry

    doc = skip(doc, "daily", "Replay lab", "measure-only bench, not run today",
               now="2026-09-18T00:00:05Z")
    sk = [s for s in doc["workflows"]["daily"]["stages"] if s["name"] == "Replay lab"][0]
    assert sk["status"] == "skipped" and sk["exit_code"] is None, sk
    assert sk["note"] == "measure-only bench, not run today", sk
    assert sk["last_success_utc"] is None, sk
    print("ok    selftest: begin resets the run, record grades it, skip is not a failure")

    # 2 — a failed stage under continue-on-error, and the carry across runs.
    doc = record(doc, "daily", "Resolve parlay legs", 7,
                 "2026-09-18T00:00:06Z", "2026-09-18T00:00:08Z",
                 continue_on_error=True, now="2026-09-18T00:00:08Z")
    bad = [s for s in doc["workflows"]["daily"]["stages"]
           if s["name"] == "Resolve parlay legs"][0]
    assert bad["status"] == "failed" and bad["exit_code"] == 7, bad
    assert bad["continue_on_error"] is True and bad["note"], bad
    assert bad["last_success_utc"] is None, "it has never succeeded, so it says so"

    # A later run: the stage that succeeded YESTERDAY keeps its date even though
    # today's run has not reached it, and the one that failed still reports the
    # day it last worked once it has one.
    doc = record(doc, "daily", "Resolve parlay legs", 0,
                 "2026-09-18T00:00:09Z", "2026-09-18T00:00:10Z",
                 now="2026-09-18T00:00:10Z")
    doc = begin(doc, "daily", "222", now="2026-09-19T00:00:00Z")
    assert doc["workflows"]["daily"]["stages"] == [], "begin resets the stage list"
    assert doc["workflows"]["daily"]["last_success"]["Resolve estimates"] \
        == "2026-09-18T00:00:04Z", "yesterday's success must survive begin"
    doc = record(doc, "daily", "Resolve estimates", 1,
                 "2026-09-19T00:00:01Z", "2026-09-19T00:00:02Z",
                 continue_on_error=True, now="2026-09-19T00:00:02Z")
    carried = doc["workflows"]["daily"]["stages"][0]["last_success_utc"]
    assert carried == "2026-09-18T00:00:04Z", carried
    print("ok    selftest: a continue-on-error failure is recorded, and last "
          "success carries across runs")

    # 3 — idempotent re-record: one row per stage, the newest outcome wins.
    before = len(doc["workflows"]["daily"]["stages"])
    doc = record(doc, "daily", "Resolve estimates", 0,
                 "2026-09-19T00:00:03Z", "2026-09-19T00:00:05Z",
                 now="2026-09-19T00:00:05Z")
    assert len(doc["workflows"]["daily"]["stages"]) == before, "a re-record appended a row"
    again = doc["workflows"]["daily"]["stages"][0]
    assert again["status"] == "ok" and again["duration_s"] == 2.0, again
    print("ok    selftest: re-recording a stage replaces its row (idempotent)")

    # 4 — the wrapper: stdout/stderr pass through, the COMMAND's exit code is
    # the wrapper's exit code, and both outcomes land in the document.
    wrapper = os.path.join(_THIS, "stage.sh")
    with tempfile.TemporaryDirectory() as tmp:
        target = os.path.join(tmp, "pipeline_stages.json")
        env = dict(os.environ, STAGE_STATUS_PATH=target)
        begin_run = subprocess.run(
            [sys.executable, os.path.join(_THIS, "stage_status.py"), "begin",
             "--workflow", "gameday", "--run-id", "999"],
            env=env, capture_output=True, text=True)
        assert begin_run.returncode == 0, begin_run.stderr

        good = subprocess.run(["bash", wrapper, "gameday", "a green stage", "--", "true"],
                              env=env, capture_output=True, text=True)
        assert good.returncode == 0, good.stderr
        bad_run = subprocess.run(["bash", wrapper, "gameday", "a red stage", "--", "false"],
                                 env=env, capture_output=True, text=True)
        assert bad_run.returncode == 1, (bad_run.returncode, bad_run.stderr)
        echoed = subprocess.run(["bash", wrapper, "gameday", "a talkative stage", "--",
                                 "echo", "hello from the stage"],
                                env=env, capture_output=True, text=True)
        assert "hello from the stage" in echoed.stdout, echoed.stdout

        with open(target, encoding="utf-8") as fh:
            written = json.load(fh)
        stages = {s["name"]: s for s in written["workflows"]["gameday"]["stages"]}
        assert stages["a green stage"]["status"] == "ok", stages
        assert stages["a red stage"]["status"] == "failed", stages
        assert stages["a red stage"]["exit_code"] == 1, stages
        assert written["workflows"]["gameday"]["run_id"] == "999", written
        # continue-on-error is the wrapper's flag too, and a failure under it
        # still exits non-zero so the step's own continue-on-error decides.
        coe = subprocess.run(["bash", wrapper, "--continue-on-error", "gameday",
                              "a tolerated stage", "--", "false"],
                             env=env, capture_output=True, text=True)
        assert coe.returncode == 1, coe.returncode
        with open(target, encoding="utf-8") as fh:
            written = json.load(fh)
        tolerated = [s for s in written["workflows"]["gameday"]["stages"]
                     if s["name"] == "a tolerated stage"][0]
        assert tolerated["continue_on_error"] is True, tolerated
        raw = open(target, "rb").read()
        assert raw == (json.dumps(written, ensure_ascii=True, indent=2) + "\n").encode("utf-8"), \
            "the document is not written in the repo's canonical JSON style"
    print("ok    selftest: stage.sh propagates the command's exit code and does "
          "not swallow its output")

    print("selftest OK: the stage record opens a run, grades every stage, tells "
          "'did not run' from 'failed', carries last success across runs, is "
          "idempotent per stage, and the wrapper exits with the command's own "
          "exit code so continue-on-error keeps its meaning")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
