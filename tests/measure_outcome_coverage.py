#!/usr/bin/env python3
"""Measure the two outcome producers through real Node/Python child tests.

Stdlib only. No runtime dependency, source exclusions, installs, cloud calls or
sports-data regeneration. Exit nonzero for failing suites, invalid shards,
changed sources, interpreter mismatch, or coverage below --minimum-percent.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import trace
import uuid
from zoneinfo import ZoneInfo


TARGETS = ("scripts/capture_outcome_evidence.py", "scripts/build_learning_outcomes.py")
SUITES = (
    "tests/feature/week6_outcome_capture.test.mjs",
    "tests/feature/week6_outcome_capture_consumers.test.mjs",
    "tests/feature/week6_outcome_evidence.test.mjs",
    "tests/feature/week6_learning_outcomes.test.mjs",
    "tests/feature/week6_learning_outcomes_adversarial.test.mjs",
)
CONFIG_ENV = "NFL_OUTCOME_COVERAGE_CONFIG"


def source_hash(path):
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def python_identity():
    return {"executable": str(Path(sys.executable).resolve()), "version": sys.version,
            "implementation": platform.python_implementation()}


def executable_lines(path):
    """Recursively include nested/uncalled functions, without pragma exclusions."""
    return {line for line in trace._find_executable_linenos(str(path)) if line > 0}


def summarize(executable, observed):
    denominator = set(executable) | set(observed)
    covered = denominator & set(observed)
    return {"covered": len(covered), "total": len(denominator),
            "percent": round(100 * len(covered) / len(denominator), 4) if denominator else None,
            "covered_lines": sorted(covered), "missing_lines": sorted(denominator - covered),
            "enumerated_executable_lines": len(executable),
            "additional_observed_lines": sorted(set(observed) - set(executable))}


def make_config(root, run_id):
    root = Path(root).resolve()
    return {"version": 1, "run_id": run_id, "root": str(root),
            "python": python_identity(),
            "source_sha256": {name: source_hash(root / name) for name in TARGETS}}


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("non-finite JSON constant")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def collect_shards(directory, config):
    """Reject every malformed/mismatched shard; never silently discard one."""
    observed = {name: set() for name in TARGETS}
    shards = sorted(Path(directory).glob("*.json"))
    shards = [path for path in shards if path.name != "config.json"]
    if not shards:
        raise ValueError("no child-process coverage shards were produced")
    pids = set()
    physical_lines = {name: len((Path(config["root"]) / name).read_text(encoding="utf-8").splitlines())
                      for name in TARGETS}
    for path in shards:
        shard = strict_json(path.read_text(encoding="utf-8"))
        if (not isinstance(shard, dict)
                or set(shard) != {"version", "run_id", "pid", "python", "targets"}
                or type(shard["version"]) is not int or shard["version"] != 1
                or shard["run_id"] != config["run_id"] or shard["python"] != config["python"]
                or type(shard["pid"]) is not int or shard["pid"] <= 0
                or not isinstance(shard["targets"], dict) or set(shard["targets"]) != set(TARGETS)):
            raise ValueError("invalid child coverage shard identity: " + path.name)
        if (shard["pid"] in pids
                or not re.fullmatch(str(shard["pid"]) + r"-[0-9a-f]{32}\.json", path.name)):
            raise ValueError("duplicate process or mismatched coverage shard filename: " + path.name)
        pids.add(shard["pid"])
        for name in TARGETS:
            row = shard["targets"][name]
            if (not isinstance(row, dict)
                    or set(row) != {"source_sha256_before", "source_sha256_after", "covered_lines"}
                    or row["source_sha256_before"] != config["source_sha256"][name]
                    or row["source_sha256_after"] != config["source_sha256"][name]
                    or not isinstance(row["covered_lines"], list)):
                raise ValueError("invalid child coverage source metadata: " + path.name)
            lines = row["covered_lines"]
            if (any(type(line) is not int or line < 1 or line > physical_lines[name] for line in lines)
                    or lines != sorted(set(lines))):
                raise ValueError("invalid child coverage line list: " + path.name)
            observed[name].update(lines)
    return observed, {"shards": len(shards), "process_ids": sorted(pids)}


def _head(root):
    result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                            capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def child_environment(hook_dir, config_path):
    env = os.environ.copy()
    # Node suites call python3. Keep the existing interpreter, not whichever
    # unrelated system Python happens to appear first in the caller's PATH.
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    resolved = shutil.which("python3", path=env["PATH"])
    if not resolved or Path(resolved).resolve() != Path(sys.executable).resolve():
        raise ValueError("the tool interpreter directory must provide the same python3 binary")
    env["PYTHONPATH"] = str(hook_dir) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env[CONFIG_ENV] = str(config_path)
    return env


def safe_output_path(root, raw_path):
    """Evidence only: reviews JSON or system-temp JSON, never arbitrary sources."""
    root = Path(root).resolve()
    requested = Path(os.path.abspath(raw_path))
    resolved = requested.resolve()
    reviews = root / "docs/reviews"
    temporary_roots = {Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()}
    if resolved.suffix != ".json" or ".git" in requested.parts:
        raise ValueError("coverage evidence must be a .json file outside .git")
    if resolved.is_relative_to(root):
        if not resolved.is_relative_to(reviews):
            raise ValueError("inside the checkout, coverage output is restricted to docs/reviews/*.json")
        boundary = root
    else:
        boundary = next((path for path in temporary_roots if resolved.is_relative_to(path)), None)
        if boundary is None:
            raise ValueError("outside the checkout, coverage output is restricted to system temporary directories")
    current = requested
    while current.resolve() != boundary:
        if current.is_symlink():
            raise ValueError("coverage evidence must not follow symlink redirects")
        if current.parent == current:
            raise ValueError("coverage output has no trusted parent boundary")
        current = current.parent
    if requested.is_symlink() or (resolved.exists() and not resolved.is_file()):
        raise ValueError("coverage evidence destination must be a regular file")
    if resolved.exists() and resolved.stat().st_nlink != 1:
        raise ValueError("coverage evidence must not overwrite a multiply linked file")
    return resolved


def write_evidence(root, destination, result):
    """Replace a generated report atomically; never truncate linked content."""
    output = safe_output_path(root, destination)
    output.parent.mkdir(parents=True, exist_ok=True)
    output = safe_output_path(root, output)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent,
                                         prefix=".outcome-coverage-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary, output)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def passes(rows, outcomes, stable, errors, minimum_percent):
    """Every complete critical target must meet the floor, not just their sum."""
    covered, total = sum(row["covered"] for row in rows), sum(row["total"] for row in rows)
    return (not errors and stable and all(row["exit_code"] == 0 for row in outcomes)
            and total > 0 and 100 * covered / total >= minimum_percent
            and all(row["total"] > 0 and 100 * row["covered"] / row["total"] >= minimum_percent
                    for row in rows))


def measure(root, suites=SUITES, minimum_percent=90.0):
    root = Path(root).resolve()
    for name in (*TARGETS, *suites):
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("every target and suite must exist inside this checkout: " + name)
    config = make_config(root, uuid.uuid4().hex)
    evidence_sources = tuple(dict.fromkeys((*TARGETS, *suites,
                                           "tests/measure_outcome_coverage.py",
                                           "tests/coverage/sitecustomize.py")))
    evidence_before = {name: source_hash(root / name) for name in evidence_sources}
    tables = {name: executable_lines(root / name) for name in TARGETS}
    head_before = _head(root)
    start = time.monotonic()
    outcomes, errors = [], []
    with tempfile.TemporaryDirectory(prefix="nfl-outcome-coverage-") as temporary:
        directory = Path(temporary)
        config_path = directory / "config.json"
        config_path.write_text(json.dumps(config, sort_keys=True), encoding="utf-8")
        env = child_environment(root / "tests/coverage", config_path)
        for suite in suites:
            began = time.monotonic()
            child = subprocess.run(["node", "--test", str(root / suite)], cwd=root, env=env, check=False)
            outcomes.append({"suite": suite, "command": ["node", "--test", suite],
                             "exit_code": child.returncode,
                             "elapsed_seconds": round(time.monotonic() - began, 3)})
        try:
            observed, shard_summary = collect_shards(directory, config)
        except (ValueError, OSError, TypeError, KeyError) as exc:
            observed = {name: set() for name in TARGETS}
            shard_summary = {"shards": 0, "process_ids": []}
            errors.append(str(exc))
    after = {name: source_hash(root / name) for name in TARGETS}
    evidence_after = {name: source_hash(root / name) for name in evidence_sources}
    rows = [{"path": name, "source_sha256_before": config["source_sha256"][name],
             "source_sha256_after": after[name], **summarize(tables[name], observed[name])}
            for name in TARGETS]
    covered, total = sum(row["covered"] for row in rows), sum(row["total"] for row in rows)
    percent = round(100 * covered / total, 4) if total else None
    stable = evidence_before == evidence_after and head_before == _head(root)
    now = datetime.now(timezone.utc)
    return {"version": 1, "metric": "Python executable line coverage; not branch coverage",
            "tool": "opt-in sitecustomize + stdlib trace + recursive bytecode line tables",
            "tool_source_sha256": source_hash(Path(__file__)),
            "hook_source_sha256": source_hash(root / "tests/coverage/sitecustomize.py"),
            "run_id": config["run_id"], "python": config["python"],
            "root": str(root), "repository_head": head_before,
            "generated_utc": now.isoformat(),
            "generated_chicago": now.astimezone(ZoneInfo("America/Chicago")).isoformat(),
            "elapsed_seconds": round(time.monotonic() - start, 3),
            "suites": outcomes, "source_stable": stable, "errors": errors,
            "measurement_sources": [{"path": name, "source_sha256_before": evidence_before[name],
                                     "source_sha256_after": evidence_after[name]}
                                    for name in evidence_sources],
            "child_processes": shard_summary, "files": rows,
            "covered": covered, "total": total, "percent": percent,
            "minimum_percent": minimum_percent,
            "passed": passes(rows, outcomes, stable, errors, minimum_percent),
            "limitations": [
                "Line coverage is not branch, acceptance, statistical or production verification.",
                "Every enumerated physical executable target line is included, including uncalled functions; no exclusions.",
                "Actual observed physical lines are also included; synthetic compiler line 0 is not a physical source line.",
                "Each opted-in Python child and its newly started threads are traced; -I/-S children and os._exit do not produce shards.",
                "Shards are trusted local test instrumentation, not cryptographically attested execution.",
                "No live network, database, deployment or current sports-data pipeline is exercised by these fixture suites.",
                "Per-file source hashes describe dirty local code more precisely than the repository HEAD alone.",
            ]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", help="generated evidence JSON path")
    parser.add_argument("--minimum-percent", type=float, default=90.0)
    parser.add_argument("suites", nargs="*", help="optional repository-relative Node suites")
    args = parser.parse_args(argv)
    if not 0 <= args.minimum_percent <= 100:
        parser.error("--minimum-percent must be between 0 and 100")
    root = Path(__file__).resolve().parents[1]
    if args.output:
        try:
            output = safe_output_path(root, args.output)
        except ValueError as exc:
            parser.error(str(exc))
    try:
        result = measure(root, tuple(args.suites) or SUITES, args.minimum_percent)
    except (ValueError, OSError) as exc:
        parser.exit(2, "coverage tool error: " + str(exc) + "\n")
    if args.output:
        write_evidence(root, output, result)
    for row in result["files"]:
        print(f"{row['covered']}/{row['total']} ({row['percent']}%) {row['path']}")
    print(f"TOTAL {result['covered']}/{result['total']} ({result['percent']}%); "
          f"suite_exit_codes={[row['exit_code'] for row in result['suites']]}; "
          f"source_stable={result['source_stable']}; shards={result['child_processes']['shards']}; "
          f"passed={result['passed']}")
    for error in result["errors"]:
        print("coverage evidence error: " + error, file=sys.stderr)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
