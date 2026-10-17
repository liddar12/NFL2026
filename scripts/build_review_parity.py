#!/usr/bin/env python3
"""DEFAULT OFF local review preview; never modifies live review or source data.

Enabled execution requires every explicit argument, builds legacy review OFFLINE,
runs the trusted pinned comparator and pure attachment, then exclusively publishes
ONE new JSON outside both checkouts. Namespace/watermark remain supplied claims.
The fixed worker subtree is deadline-bounded; no upload-selected executable,
credential discovery, network request, model fit or activation is introduced.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
MAX_BUNDLE = 128 * 1024 * 1024  # Existing checker enforces the actual read cap.
MAX_INPUT, MAX_OUTPUT = 65 * 1024 * 1024, 66 * 1024 * 1024
MAX_CONFIG = 16384
TOTAL_TIMEOUT, ATTACH_TIMEOUT = 90, 15
HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
AUTHORITY_PARTS = frozenset((".git", "data", "snapshots", "captures", "objects", "outbox", "observations"))
ATTACHMENT_KEYS = frozenset(("version", "kind", "scope", "review_input_id", "review_season", "review_as_of_utc",
    "verification_utc", "verification_clock_authenticated", "expected_input_id", "diagnostic_id", "diagnostic",
    "display_only", "legacy_review_unchanged", "live_learning", "namespace_authenticated", "completeness_authenticated",
    "source_authentication", "model_adoption", "live_review_replaced", "accuracy_improvement_claimed",
    "verification_basis", "limitations", "attachment_id"))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def fingerprint(value):
    return "sha256:" + hashlib.sha256(encoded(value)).hexdigest()


def instant(value):
    if type(value) is not str:
        raise ValueError("invalid_preview_clock")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError("invalid_preview_clock")
    return result.astimezone(timezone.utc)


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("invalid_preview_json")
            result[key] = value
        return result
    def constant(_value):
        raise ValueError("invalid_preview_json")
    return json.loads(raw, object_pairs_hook=unique, parse_constant=constant)


def _path(value):
    if type(value) is not str or not value or len(value) > 4096:
        raise ValueError("invalid_preview_path")
    return Path(value)


def _tool(engine, name):
    candidate = engine / "tools" / name
    resolved = candidate.resolve(strict=True)
    if not resolved.is_relative_to(engine) or not resolved.is_file():
        raise ValueError("invalid_trusted_preview_tool")
    return resolved


def _configuration(bundle, expected_input_id, engine_checkout, now_utc):
    if type(expected_input_id) is not str or not HASH.fullmatch(expected_input_id):
        raise ValueError("invalid_preview_pin")
    instant(now_utc)
    bundle = _path(bundle).resolve(strict=True)
    engine = _path(engine_checkout).resolve(strict=True)
    if not bundle.is_file() or bundle.stat().st_size > MAX_BUNDLE or not engine.is_dir():
        raise ValueError("invalid_preview_input")
    _tool(engine, "nfl_review_parity.py")
    _tool(engine, "nfl_review_attachment.py")
    if not (engine / "packages/selflearn-core/selflearn_core").is_dir():
        raise ValueError("invalid_preview_engine")
    return {"version": 1, "bundle": str(bundle), "expected_input_id": expected_input_id,
            "engine_checkout": str(engine), "now_utc": now_utc}


def _run_json(command, payload, *, cwd, env, timeout, maximum_input=MAX_INPUT, maximum_output=MAX_OUTPUT, owned_group=False):
    """Incremental bounded pipes; child helpers inherit the worker's process group."""
    if len(payload) > maximum_input or timeout <= 0:
        raise ValueError("preview_process_budget")
    deadline = time.monotonic() + timeout
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=owned_group)
    try:
        output, offset = bytearray(), 0
        with selectors.DefaultSelector() as selected:
            for stream, mode in ((process.stdin, selectors.EVENT_WRITE), (process.stdout, selectors.EVENT_READ)):
                os.set_blocking(stream.fileno(), False)
                selected.register(stream, mode)
            while selected.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("preview_process_deadline")
                for key, _ in selected.select(min(remaining, 1)):
                    if key.fileobj is process.stdin:
                        if offset < len(payload):
                            offset += os.write(key.fd, payload[offset:offset + 65536])
                        else:
                            selected.unregister(process.stdin); process.stdin.close()
                    else:
                        chunk = os.read(key.fd, min(65536, maximum_output - len(output) + 1))
                        if not chunk:
                            selected.unregister(process.stdout)
                        output.extend(chunk)
                        if len(output) > maximum_output:
                            raise ValueError("preview_process_output_budget")
            code = process.wait(timeout=max(.01, deadline - time.monotonic()))
        if code not in (0, 3):
            raise ValueError("preview_process_refused")
        result = strict_json(output)
        return code, result
    finally:
        if owned_group:
            # A descendant can outlive even a successful leader, with or
            # without inherited stdout. This call owns the whole fresh group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        if process.poll() is None:
            process.wait(timeout=1)
        for stream in (process.stdin, process.stdout):
            if not stream.closed:
                stream.close()


def _validate_attached(value, config):
    if type(value) is not dict or type(value.get("engine_parity")) is not dict:
        raise ValueError("invalid_attached_preview")
    block = value["engine_parity"]
    diagnostic = block.get("diagnostic")
    base = {key: item for key, item in value.items() if key != "engine_parity"}
    if (set(block) != ATTACHMENT_KEYS or block.get("kind") != "nfl.review_engine_parity_attachment.v1" or type(block.get("version")) is not int
            or block["version"] != 1 or block.get("review_input_id") != fingerprint(base)
            or block.get("scope") != "local_pinned_MY_yardage_diagnostic_only"
            or type(block.get("review_season")) is not int or block["review_season"] != base["season"]
            or instant(block["review_as_of_utc"]) != instant(config["now_utc"])
            or block.get("verification_basis") != "supplied_content_hashes_not_authenticated_execution"
            or block.get("attachment_id") != fingerprint({k: v for k, v in block.items() if k != "attachment_id"})
            or block.get("expected_input_id") != config["expected_input_id"]
            or block.get("display_only") is not True or block.get("legacy_review_unchanged") is not True
            or block.get("source_authentication") != "not_performed"
            or block.get("verification_clock_authenticated") is not False
            or type(diagnostic) is not dict or diagnostic.get("input_id") != config["expected_input_id"]
            or diagnostic.get("namespace") != {"destination_id": fingerprint({"base_url": "https://self-learning-beige.vercel.app"}), "producer_id": "nfl2026"}
            or type(diagnostic.get("version")) is not int or diagnostic["version"] != 1
            or diagnostic.get("kind") != "nfl.review_parity_diagnostic.v1"
            or diagnostic.get("diagnostic_id") != fingerprint({k: v for k, v in diagnostic.items() if k != "diagnostic_id"})
            or block.get("diagnostic_id") != diagnostic["diagnostic_id"]
            or instant(base["generated_utc"]) != instant(config["now_utc"])
            or instant(diagnostic["as_of_utc"]) != instant(config["now_utc"])
            or not instant(diagnostic["snapshot_exported_utc"]) <= instant(block["verification_utc"]) <= datetime.now(timezone.utc)):
        raise ValueError("invalid_attached_preview")
    for key in ("live_learning", "namespace_authenticated", "completeness_authenticated", "model_adoption",
                "live_review_replaced", "accuracy_improvement_claimed"):
        if block.get(key) is not False:
            raise ValueError("invalid_attached_preview")
    for key in ("namespace_authenticated", "completeness_authenticated", "model_adoption", "live_review_replaced"):
        if diagnostic.get(key) is not False:
            raise ValueError("invalid_attached_preview")
    if type(diagnostic.get("parity")) is not bool or diagnostic.get("source_authentication") != "not_performed":
        raise ValueError("invalid_attached_preview")
    return value


def build_preview(config, *, load_inputs=None, build=None, checker=None):
    """Worker logic. Optional trusted test injections never change CLI policy."""
    if type(config) is not dict or set(config) != {"version", "bundle", "expected_input_id", "engine_checkout", "now_utc"}:
        raise ValueError("invalid_preview_configuration")
    if type(config["version"]) is not int or config["version"] != 1:
        raise ValueError("invalid_preview_configuration")
    config = _configuration(config["bundle"], config["expected_input_id"], config["engine_checkout"], config["now_utc"])
    verification_utc = datetime.now(timezone.utc).isoformat()
    if instant(config["now_utc"]) > instant(verification_utc):
        raise ValueError("future_preview_cutoff")
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from scripts import build_review, check_learning_parity
    loader = build_review.load_inputs if load_inputs is None else load_inputs
    builder = build_review.build if build is None else build
    check = check_learning_parity.check if checker is None else checker
    legacy = builder(loader(offline=True), config["now_utc"])
    before = fingerprint(legacy)
    diagnostic = check(config["bundle"], engine_checkout=config["engine_checkout"],
        expected_input_id=config["expected_input_id"], now_utc=verification_utc)
    engine = Path(config["engine_checkout"])
    tool = _tool(engine, "nfl_review_attachment.py")
    source_hash = hashlib.sha256(tool.read_bytes()).digest()
    request = encoded({"version": 1, "review": legacy, "diagnostic": diagnostic,
        "expected_input_id": config["expected_input_id"], "now_utc": verification_utc})
    code, result = _run_json([sys.executable, str(tool), "--attach-stdin"], request,
        cwd=engine, env={"PYTHONPATH": str(engine / "packages/selflearn-core"),
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}, timeout=ATTACH_TIMEOUT)
    _validate_attached(result, config)
    if (source_hash != hashlib.sha256(tool.read_bytes()).digest()
            or result["engine_parity"]["review_input_id"] != before
            or fingerprint(result["engine_parity"]["diagnostic"]) != fingerprint(diagnostic)
            or (code == 0) != diagnostic["parity"]):
        raise ValueError("changed_or_invalid_preview_evidence")
    return result


def _output_path(value, config):
    path = _path(value)
    if not path.is_absolute() or path.suffix != ".json" or path.name == ".json" or ".." in path.parts:
        raise ValueError("invalid_preview_output")
    if any(part in AUTHORITY_PARTS for part in path.parts):
        raise ValueError("authority_preview_output")
    for authority in (ROOT, Path(config["engine_checkout"])):
        if path.is_relative_to(authority):
            raise ValueError("authority_preview_output")
    if path == Path(config["bundle"]):
        raise ValueError("authority_preview_output")
    # Reject redirects, including symlink ancestors; the publishing walk below
    # repeats this with nofollow directory descriptors rather than path trust.
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        cursor /= part
        if cursor.is_symlink():
            raise ValueError("redirected_preview_output")
    if path.exists() or not path.parent.is_dir():
        raise ValueError("existing_or_invalid_preview_output")
    return path


def publish_new(path, raw):
    """Atomically link a new private inode; never replace any existing target."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(path.anchor, flags)
    temporary, created, published, identity = None, False, False, None
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, flags, dir_fd=parent)
            os.close(parent); parent = child
        try:
            os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError("existing_preview_output")
        temporary = ".review-parity-" + secrets.token_hex(12) + ".tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        created = True
        identity = os.fstat(fd)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        published = True
        os.unlink(temporary, dir_fd=parent)
        created = False
    except BaseException:
        if published:
            target = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
            if (target.st_dev, target.st_ino) == (identity.st_dev, identity.st_ino):
                os.unlink(path.name, dir_fd=parent)
        raise
    finally:
        if created:
            os.unlink(temporary, dir_fd=parent)
        os.close(parent)


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise ValueError("invalid_preview_arguments")


def main(argv=None):
    try:
        parser = Parser(description=__doc__.splitlines()[0])
        for key in ("bundle", "expected-input-id", "engine-checkout", "now-utc", "out"):
            parser.add_argument("--" + key)
        parser.add_argument("--worker-stdin", action="store_true", help=argparse.SUPPRESS)
        args = parser.parse_args(argv)
        values = (args.bundle, args.expected_input_id, args.engine_checkout, args.now_utc, args.out)
        if args.worker_stdin:
            if any(value is not None for value in values):
                raise ValueError("invalid_preview_worker")
            raw = sys.stdin.buffer.read(MAX_CONFIG + 1)
            if len(raw) > MAX_CONFIG:
                raise ValueError("preview_configuration_budget")
            result = build_preview(strict_json(raw))
            raw = encoded(result)
            if len(raw) > MAX_OUTPUT:
                raise ValueError("preview_output_budget")
            sys.stdout.buffer.write(raw + b"\n")
            return 0 if result["engine_parity"]["diagnostic"]["parity"] else 3
        if all(value is None for value in values):
            print('{"version":1,"status":"disabled","parity":false}')
            return 0
        if any(value is None for value in values):
            raise ValueError("explicit_preview_arguments_required")
        config = _configuration(args.bundle, args.expected_input_id, args.engine_checkout, args.now_utc)
        output = _output_path(args.out, config)
        sources = (Path(__file__).resolve(), ROOT / "scripts/build_review.py", ROOT / "scripts/check_learning_parity.py",
            _tool(Path(config["engine_checkout"]), "nfl_review_parity.py"),
            _tool(Path(config["engine_checkout"]), "nfl_review_attachment.py"))
        source_hashes = {path: hashlib.sha256(path.read_bytes()).digest() for path in sources}
        env = {"PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}
        code, result = _run_json([sys.executable, str(Path(__file__).resolve()), "--worker-stdin"], encoded(config),
            cwd=ROOT, env=env, timeout=TOTAL_TIMEOUT, maximum_input=MAX_CONFIG, owned_group=True)
        _validate_attached(result, config)
        if any(hashlib.sha256(path.read_bytes()).digest() != digest for path, digest in source_hashes.items()):
            raise ValueError("preview_source_changed")
        if (code == 0) != result["engine_parity"]["diagnostic"]["parity"]:
            raise ValueError("invalid_preview_exit_status")
        raw = encoded(result) + b"\n"
        if len(raw) > MAX_OUTPUT:
            raise ValueError("preview_output_budget")
        _output_path(args.out, config)
        publish_new(output, raw)
        print(json.dumps({"version": 1, "status": "local_preview_written", "parity": code == 0,
            "output": str(output), "live_review_replaced": False, "model_adoption": False}, sort_keys=True))
        return code
    except KeyboardInterrupt:
        print('{"version":1,"status":"local_preview_cancelled","parity":false}')
        return 130
    except (ValueError, TypeError, KeyError, OSError, OverflowError, RecursionError, AttributeError, subprocess.SubprocessError):
        print('{"version":1,"status":"invalid_or_unavailable_local_review_preview","parity":false}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
