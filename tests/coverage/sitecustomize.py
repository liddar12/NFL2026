"""Opt-in stdlib tracing for Python children of the outcome Node suites.

Ordinary Python processes are unchanged. The dedicated configuration is created
in a fresh temporary directory by tests/measure_outcome_coverage.py.
"""
import os


if os.environ.get("NFL_OUTCOME_COVERAGE_CONFIG"):
    import atexit
    import hashlib
    import json
    from pathlib import Path
    import platform
    import sys
    import threading
    import trace
    import uuid

    TARGETS = ("scripts/capture_outcome_evidence.py", "scripts/build_learning_outcomes.py")

    def _hash(path):
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()

    def _identity():
        return {"executable": str(Path(sys.executable).resolve()), "version": sys.version,
                "implementation": platform.python_implementation()}

    class OutcomeTrace(trace.Trace):
        def __init__(self, paths):
            self.targets = set(paths)
            self.paths = {}
            super().__init__(count=True, trace=False)

        def globaltrace_lt(self, frame, why, arg):
            if why != "call":
                return None
            name = frame.f_code.co_filename
            if name not in self.paths:
                self.paths[name] = None if name.startswith("<") else str(Path(name).resolve())
            return self.localtrace if self.paths[name] in self.targets else None

    # Python normally logs and ignores a sitecustomize exception. Explicit
    # instrumentation must instead fail closed, not silently produce a green run.
    try:
        config_path = Path(os.environ["NFL_OUTCOME_COVERAGE_CONFIG"]).resolve()
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if (type(config["version"]) is not int or config["version"] != 1
                or set(config["source_sha256"]) != set(TARGETS)
                or not isinstance(config["run_id"], str) or len(config["run_id"]) != 32
                or config["python"] != _identity()):
            raise ValueError("coverage configuration or interpreter mismatch")
        root = Path(config["root"]).resolve()
        paths = {name: root / name for name in TARGETS}
        before = {name: _hash(path) for name, path in paths.items()}
        if before != config["source_sha256"]:
            raise ValueError("coverage target changed before child startup")
        output_dir = config_path.parent
        tracer = OutcomeTrace(str(path.resolve()) for path in paths.values())
        old_sys_trace = sys.gettrace()
        old_thread_trace = getattr(threading, "gettrace", lambda: None)()

        def flush():
            sys.settrace(old_sys_trace)
            threading.settrace(old_thread_trace)
            try:
                counts = tracer.results().counts
                targets = {}
                for name, path in paths.items():
                    target = str(path.resolve())
                    lines = {line for (filename, line), count in counts.items()
                             if count > 0 and line > 0 and str(Path(filename).resolve()) == target}
                    targets[name] = {"source_sha256_before": before[name],
                                     "source_sha256_after": _hash(path),
                                     "covered_lines": sorted(lines)}
                shard = {"version": 1, "run_id": config["run_id"], "pid": os.getpid(),
                         "python": _identity(), "targets": targets}
                destination = output_dir / (str(os.getpid()) + "-" + uuid.uuid4().hex + ".json")
                with destination.open("x", encoding="utf-8") as stream:
                    json.dump(shard, stream, sort_keys=True)
            except Exception:
                # Missing/invalid shards also fail the parent validation. Exit
                # status protects callers that do not collect the evidence.
                os.write(2, b"outcome coverage shard write failed\n")
                os._exit(97)

        atexit.register(flush)
        threading.settrace(tracer.globaltrace)
        sys.settrace(tracer.globaltrace)
    except Exception:
        os.write(2, b"outcome coverage instrumentation failed\n")
        os._exit(97)
