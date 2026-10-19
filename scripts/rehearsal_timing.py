"""Observe a local command without selecting or changing any NFL pipeline.

Usage: python3 -I -S -B scripts/rehearsal_timing.py --report /tmp/timing.json -- COMMAND ARG...

The child inherits stdout/stderr. Telemetry contains no command, arguments,
environment, output, or exception messages. Choose a private report destination.
UTC observations never supply producer/history clocks; signed clock differences
do not identify a cause. Observer persistence is outside the measured interval.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def write_timing_report(path, report):
    """Replace a report atomically; a partial write preserves the old report."""
    path = Path(path)
    descriptor, temporary_name = tempfile.mkstemp(prefix="." + path.name + ".timing-", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


class RehearsalTiming:
    """Independent UTC/monotonic observations around an operation and phases.

    Use disjoint phases. Names must be nonsecret labels. Clock, report-write,
    and fallback-stderr failures never replace the operation's return/exception.
    """

    def __init__(self, *, wall_clock=None, monotonic_clock=None):
        self.wall_clock = wall_clock or (lambda: dt.datetime.now(dt.timezone.utc))
        self.monotonic_clock = monotonic_clock or time.monotonic
        self.report = None
        self.writer = None
        self.document = {
            "version": 1,
            "clock_sources": {"wall": "injected" if wall_clock is not None else "system_utc",
                "monotonic": "injected" if monotonic_clock is not None else "time.monotonic"},
            "whole_run_scope": "run entry through operation return/exception and context cleanup; excludes final timing persistence and interpreter startup",
            "phase_scope": "Disjoint named phases; whole-minus-phase time includes all remaining work and measurement overhead",
            "difference_interpretation": "Signed wall-minus-monotonic measurements only; no cause is inferred",
            "phases": [],
        }

    def attach(self, report, writer):
        self.report, self.writer = report, writer
        report["timing"] = self.document

    @staticmethod
    def _observe(record, stage, operation):
        try:
            return operation()
        except Exception as error:
            record.setdefault("measurement_errors", []).append({"stage": stage,
                "exception_type": type(error).__module__ + "." + type(error).__qualname__})
            return None

    def _stamp(self, record, stage):
        def wall():
            value = self.wall_clock()
            if value.utcoffset() is None:
                raise ValueError("timing wall clock must be timezone-aware")
            return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")

        def monotonic():
            value = self.monotonic_clock()
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError("timing monotonic clock must be finite seconds")
            return value

        return (self._observe(record, stage + ":wall", wall),
            self._observe(record, stage + ":monotonic", monotonic))

    def _begin(self, name, kind):
        record = {"name": name, "kind": kind, "outcome": "running"}
        wall, monotonic = self._stamp(record, "start")
        record.update(started_utc=wall, monotonic_started_seconds=monotonic)
        return record

    def _finish(self, record):
        wall, monotonic = self._stamp(record, "end")
        wall_seconds = None
        if wall is not None and record["started_utc"] is not None:
            wall_seconds = (dt.datetime.fromisoformat(wall.replace("Z", "+00:00")) -
                dt.datetime.fromisoformat(record["started_utc"].replace("Z", "+00:00"))).total_seconds()
        monotonic_seconds = (None if monotonic is None or record["monotonic_started_seconds"] is None
            else monotonic - record["monotonic_started_seconds"])
        record.update(completed_utc=wall,
            monotonic_completed_seconds=monotonic, wall_seconds=wall_seconds,
            monotonic_seconds=monotonic_seconds,
            wall_minus_monotonic_seconds=(None if wall_seconds is None or monotonic_seconds is None
                else wall_seconds - monotonic_seconds))

    @staticmethod
    def _raised(record, error):
        record.update(outcome="raised", exception_type=type(error).__module__ + "." + type(error).__qualname__)

    @contextmanager
    def phase(self, name, *, kind="phase"):
        record = self._begin(name, kind)
        self.document["phases"].append(record)
        try:
            yield record
        except BaseException as error:
            self._raised(record, error)
            raise
        else:
            record["outcome"] = "completed"
        finally:
            self._finish(record)

    def run(self, operation):
        whole = self._begin("whole_run", "run")
        self.document["whole_run"] = whole
        try:
            result = operation(self)
        except BaseException as error:
            self._raised(whole, error)
            raise
        else:
            whole.update(outcome="returned", returncode=result)
            return result
        finally:
            self._finish(whole)
            durations = [row["monotonic_seconds"] for row in self.document["phases"]]
            phase_seconds = None if any(value is None for value in durations) else sum(durations)
            self.document["phase_monotonic_timing_complete"] = phase_seconds is not None
            self.document["phase_monotonic_seconds_sum"] = phase_seconds
            self.document["whole_minus_phase_monotonic_seconds"] = (
                None if whole["monotonic_seconds"] is None or phase_seconds is None
                else whole["monotonic_seconds"] - phase_seconds)
            fallback = self.writer is None
            if self.writer is not None:
                try:
                    self.writer()
                except Exception as error:
                    self.document["persistence_error_type"] = type(error).__module__ + "." + type(error).__qualname__
                    fallback = True
            if fallback:
                try:
                    print("REHEARSAL_TIMING=" + json.dumps(self.document, sort_keys=True), file=sys.stderr, flush=True)
                except Exception as error:
                    self.document["stderr_error_type"] = type(error).__module__ + "." + type(error).__qualname__


def run_command(timing, command, *, timeout=None):
    """Observe a child with inherited streams; do not retain its argv or output.

    There is no implicit deadline. The CLI maps an explicitly requested timeout
    to 124, inability to start to 127, and signal termination to 128+signal. The
    phase retains the child's raw return code when available.
    """
    with timing.phase("command", kind="command") as record:
        try:
            result = subprocess.run(command, timeout=timeout)
        except subprocess.TimeoutExpired:
            record["status"] = "timeout"
            return 124
        except OSError:
            record["status"] = "start_failed"
            return 127
        record["returncode"] = result.returncode
        return result.returncode if result.returncode >= 0 else 128 - result.returncode


def positive_timeout(value):
    try:
        seconds = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("timeout must be positive finite seconds") from None
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be positive finite seconds")
    return seconds


def main(argv=None, *, timing=None):
    def operation(observer):
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--report", required=True, type=Path)
        parser.add_argument("--timeout", type=positive_timeout, default=None,
            help="optional positive finite child deadline in seconds; no deadline by default")
        parser.add_argument("command", nargs=argparse.REMAINDER)
        args = parser.parse_args(argv)
        if args.report.resolve().is_relative_to(Path(__file__).resolve().parents[1] / "data"):
            parser.error("timing reports must be outside the repository data directory")
        report = {"version": 1, "kind": "local_command_rehearsal_timing_v1"}
        observer.attach(report, lambda: write_timing_report(args.report, report))
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("a command after -- is required")
        return run_command(observer, command, timeout=args.timeout)
    return (timing or RehearsalTiming()).run(operation)


if __name__ == "__main__":
    raise SystemExit(main())
