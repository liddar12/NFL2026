"""Explicit local loader evidence for the opt-in generation semantic gate.

Importing this module does no IO. Callers must explicitly create/resume a run;
the builders and publisher use it only through explicit opt-in CLI arguments.
No existing workflow supplies those arguments. A loader call can record
the bytes it returns, not prove that arbitrary code subsequently consumed them.
Injury/depth/inactive files are validation witnesses, NOT original inputs of the
earlier weekly/ESPN producers. All clocks and execution claims are unauthenticated.
No workflow, serving policy, v1 journal schema, or publish permission is changed.
"""
import argparse
import datetime as dt
import functools
import hashlib
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import tempfile
import time

_ROOT = Path(__file__).absolute().parent.parent
if str(_ROOT) not in sys.path:sys.path.insert(0, str(_ROOT))
from scripts import generation_semantic_gate as gate

MAX_ARTIFACT = gate.MAX_BYTES
INPUT_PATHS = {
    "player_weekly": "data/player_weekly.json", "player_projections": "data/player_projections.json",
    "game_predictions": "data/game_predictions.json", "pool_backtest": "data/leg_pool_backtest.json",
    "parlays": "data/parlays.json", "atd_week": "data/atd_week.json", "atd_backtest": "data/atd_backtest.json",
    "excluded_games": "config/excluded_games.json", "schedule": "data/schedule_full.json",
    "parlay_calibration": "data/parlay_backtest.json", "injuries": "data/injuries.json",
    "depth_chart": "data/depth_chart.json", "inactives": "data/inactives.json",
}
POOL_NAMES = frozenset(("player_weekly", "player_projections", "game_predictions", "pool_backtest",
    "parlays", "atd_week", "atd_backtest", "excluded_games"))
WITNESS_NAMES = frozenset(("injuries", "depth_chart", "inactives"))
OPTIONAL = frozenset(("atd_week", "atd_backtest", "depth_chart", "inactives", "previous_my_cards", "parlay_calibration"))
RUNTIME_PATH = "scripts/generation_capture_runtime.py"
EXTRA_FIXED = frozenset((RUNTIME_PATH, "scripts/write-runtime-config.mjs", "index.html", "sw.js", "_headers", "netlify.toml"))
HASH = re.compile(r"sha256:[0-9a-f]{64}\Z")
CLAIMS = {"execution_authenticated": False, "filesystem_read_order_authenticated": False,
    "clock_authenticated": False, "earlier_weekly_producer_inputs_captured": False,
    "provider_original_bytes_captured": False, "whole_release_pass": False,
    "publication_authorized": False, "workflow_enabled": False}
SAFE_ERRORS = frozenset("""invalid_capture_clock capture_symlink_rejected invalid_capture_checkout
invalid_capture_relative_path capture_not_regular_file capture_file_size_limit invalid_capture_period
capture_clock_regressed required_capture_input_absent missing_capture_browser_tree missing_capture_python_tree capture_code_inventory_limit
capture_code_unavailable_or_oversized invalid_capture_code_inventory invalid_capture_raw_shape
capture_raw_hash_mismatch capture_raw_work_limit capture_output_overlaps_authority capture_output_inside_checkout
capture_artifact_size_limit immutable_capture_artifact_conflict invalid_capture_loader_shape
capture_artifact_hash_mismatch changed_capture_authority_claim incomplete_capture_reads invalid_capture_read_state
invalid_capture_read_chronology consumed_capture_documents_mutated invalid_capture_owner_exclusions
invalid_capture_pool_bytes invalid_capture_pool_identity immutable_capture_pool_conflict
capture_MY_stage_order_invalid capture_pool_changed_between_stages capture_MY_input_changed_between_stages
invalid_capture_MY_read_chronology capture_input_work_limit capture_checkpoint_absent invalid_capture_checkpoint
capture_checkpoint_changed capture_git_deadline_exceeded capture_git_output_limit capture_git_object_unavailable
invalid_runtime_capture_binding runtime_capture_binding_mismatch invalid_runtime_MY_read_evidence
runtime_MY_read_input_mismatch invalid_capture_git_head capture_dependency_inventory_changed
capture_head_input_absent capture_head_input_presence_changed capture_head_runtime_or_browser_changed
capture_head_not_regular_file invalid_capture_git_tree capture_git_blob_size_mismatch
capture_head_changed_during_check generation_capture_unavailable capture_semantic_work_limit
capture_semantics_unavailable capture_generated_clock_changed invalid_capture_journal_source
capture_journal_history_limit capture_journal_history_absent capture_journal_target_conflict
capture_retained_receipt_history_absent invalid_capture_binding_path capture_no_generation_changed_dependency
capture_no_generation_ambiguous_commit capture_checked_head_changed capture_source_code_mismatch
capture_no_generation_invalid_base capture_no_generation_commit_limit""".split())


class CaptureError(ValueError):
    """Static local reason codes, never exception text from paths or tools."""


def _need(value, reason):
    if not value:
        raise CaptureError(reason)


def _safe(function):
    @functools.wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except CaptureError as error:
            reason = error.args[0] if type(error) is CaptureError and len(error.args) == 1 else None
            raise CaptureError(reason if type(reason) is str and reason in SAFE_ERRORS else "generation_capture_unavailable") from None
        except gate.GateError as error:
            raise CaptureError("capture_semantic_work_limit" if error.args == ("generation_binding_work_limit",)
                else "capture_semantics_unavailable") from None
        except Exception:
            # BaseException cancellation intentionally propagates.
            raise CaptureError("generation_capture_unavailable") from None
    return call


def _utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _clock(clock):
    value = clock()
    _need(type(value) is str and gate.lr.instant(value) is not None, "invalid_capture_clock")
    return value


def _hash(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _sealed(value, key):
    return {**value, key: gate.fingerprint(value)}


def _verify_hash(value, key):
    _need(type(value) is dict and type(value.get(key)) is str and HASH.fullmatch(value[key])
          and value[key] == gate.fingerprint({k: v for k, v in value.items() if k != key}), "capture_artifact_hash_mismatch")


def _same(left, right, reason):
    _need(gate.encoded(left) == gate.encoded(right), reason)


def _alias(path):
    """Normalize ONLY known macOS system aliases, before rejecting user links."""
    value = Path(os.path.abspath(os.fspath(path)))
    for old, new in ((Path("/var"), Path("/private/var")), (Path("/tmp"), Path("/private/tmp"))):
        if old.is_symlink() and os.readlink(old) in (str(new), str(new).lstrip("/")) and (value == old or old in value.parents):
            value = new.joinpath(*value.relative_to(old).parts)
    return value


def _no_links(path):
    for part in reversed((path, *path.parents)):
        _need(not part.is_symlink(), "capture_symlink_rejected")
    return path


def _checkout(path):
    path = _no_links(_alias(path))
    _need(path.is_dir() and (path / "scripts/generation_semantic_gate.py").is_file(), "invalid_capture_checkout")
    return path


def _relative(root, relative):
    _need(type(relative) is str and relative and not relative.startswith("/")
          and all(p not in ("", ".", "..") for p in relative.split("/")), "invalid_capture_relative_path")
    return _no_links(root.joinpath(*relative.split("/")))


def _read(path, limit=gate.MAX_FILE, *, allow_empty=False):
    """One open/read, no exists-then-open or permissive malformed-JSON fallback."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        _need(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), "capture_not_regular_file")
        raw = handle.read(limit + 1)
    _need((0 if allow_empty else 1) <= len(raw) <= limit, "capture_file_size_limit")
    return raw


def _input_paths(season, week):
    _need(type(season) is int and 2000 <= season <= 2100 and type(week) is int and 1 <= week <= 18,
          "invalid_capture_period")
    return {**INPUT_PATHS, "previous_my_cards": "data/my_cards/%d_wk%02d.json" % (season, week)}


def _role(name):
    if name in WITNESS_NAMES:
        return "eligibility_validation_witness_not_earlier_producer_original"
    return "pool_loader_value" if name in POOL_NAMES else "frozen_for_later_MY_loader_equality_check"


def _read_input(root, name, relative, clock):
    started = _clock(clock)
    raw = _read(_relative(root, relative))
    completed = _clock(clock)
    _need(gate.lr.instant(started) <= gate.lr.instant(completed), "capture_clock_regressed")
    _need(raw is not None or name in OPTIONAL, "required_capture_input_absent")
    # The logical null is consumed fallback value, NOT raw bytes from an absent
    # file. A real b'null' has a real raw hash and distinct present_json_null state.
    consumed = b"null" if raw is None else raw
    document = gate._document(consumed, name)
    state = "absent_optional" if raw is None else "present_json_null" if document is None else "present_json"
    observation = {"path": relative, "role": _role(name), "state": state,
        "raw_sha256": None if raw is None else _hash(raw), "consumed_value_sha256": _hash(consumed),
        "read_started_utc_claim": started, "read_completed_utc_claim": completed}
    return consumed, document, observation


def _extra_path(name):
    # Conservatively bind the whole local Python tree rather than trying to
    # infer dynamic/transitive imports (e.g. availability -> injury_duration).
    # This is code-byte identity, NOT proof that any file was executed.
    return type(name) is str and not any(p in ("", ".", "..") for p in name.split("/")) and (
        name in EXTRA_FIXED or name.startswith("app/") and name.endswith((".js", ".mjs", ".css"))
        or name.startswith("scripts/") and name.endswith(".py"))


def _extra_paths(root):
    paths = set(EXTRA_FIXED)
    for tree, reason in (("app", "missing_capture_browser_tree"), ("scripts", "missing_capture_python_tree")):
        directory_root = _relative(root, tree)
        _need(directory_root.is_dir(), reason)
        for directory, dirs, files in os.walk(directory_root, followlinks=False):
            for name in dirs:
                _no_links(Path(directory) / name)
            for name in files:
                path = _no_links(Path(directory) / name)
                relative = path.relative_to(root).as_posix()
                if _extra_path(relative):
                    paths.add(relative)
                    _need(len(paths) <= 1024, "capture_code_inventory_limit")
    return frozenset(paths)


def _code(root, names):
    result = {name: _read(_relative(root, name), allow_empty=True) for name in sorted(names)}
    _need(all(raw is not None for raw in result.values()) and sum(map(len, result.values())) <= gate.MAX_BYTES,
          "capture_code_unavailable_or_oversized")
    return result


def _freeze_raw(raw):
    return {key: {"raw_utf8": value.decode("utf-8"), "raw_sha256": _hash(value)} for key, value in raw.items()}


def _thaw_raw(values, *, allow_empty=False):
    _need(type(values) is dict and 0 < len(values) <= 1024, "invalid_capture_code_inventory")
    result = {}
    for key, row in values.items():
        _need(type(key) is str and type(row) is dict and set(row) == {"raw_utf8", "raw_sha256"}
              and type(row["raw_utf8"]) is str, "invalid_capture_raw_shape")
        raw = row["raw_utf8"].encode("utf-8")
        _need((0 if allow_empty else 1) <= len(raw) <= gate.MAX_FILE
              and row["raw_sha256"] == _hash(raw), "capture_raw_hash_mismatch")
        result[key] = raw
    _need(sum(map(len, result.values())) <= gate.MAX_BYTES, "capture_raw_work_limit")
    return result


def _output_root(path, checkout):
    root = _no_links(_alias(path))
    _need(len(root.parts) >= 3 and root != checkout and root not in checkout.parents and checkout not in root.parents,
          "capture_output_overlaps_authority")
    _need(not any((p / ".git").exists() for p in (root, *root.parents)), "capture_output_inside_checkout")
    return root


@_safe
def persist(value, out_dir, *, checkout):
    """Private exclusive content-addressed local artifact, outside every checkout.

The operator owns the directory; this is not an adversarial multi-user sandbox.
There is no replace/rebind operation. Exact retries reuse existing exact bytes.
"""
    checkout = _checkout(checkout);root = _output_root(out_dir, checkout)
    content = gate.encoded(gate._plain(value)) + b"\n"
    _need(len(content) <= MAX_ARTIFACT, "capture_artifact_size_limit")
    identity = _hash(content[:-1]);path = root / (identity.split(":")[1] + ".json")
    root.mkdir(parents=True, exist_ok=True, mode=0o700);_no_links(root)
    previous = _read(_no_links(path), MAX_ARTIFACT)
    if previous is not None:
        _need(previous == content, "immutable_capture_artifact_conflict")
        return path
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, prefix=".generation-", delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600);handle.write(content);handle.flush();os.fsync(handle.fileno())
        _no_links(root);_no_links(path)
        try:
            os.link(temporary, path)
        except FileExistsError:
            _need(_read(_no_links(path), MAX_ARTIFACT) == content, "immutable_capture_artifact_conflict")
        fd = os.open(root, os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if temporary is not None:temporary.unlink()
    return path


def _loader(value):
    value = gate._plain(value)
    _need(type(value) is dict and set(value) == {"version", "kind", "capture", "read_observations", "extra_code", "claims", "loader_id"}
          and type(value["version"]) is int and value["version"] == 1
          and value["kind"] == "nfl.generation_loader_observation.v1", "invalid_capture_loader_shape")
    _verify_hash(value, "loader_id");capture, documents = gate._capture(value["capture"])
    _same(value["claims"], CLAIMS, "changed_capture_authority_claim")
    paths = _input_paths(capture["season"], capture["week"])
    observations = value["read_observations"]
    _need(type(observations) is dict and set(observations) == gate.INPUT_NAMES, "incomplete_capture_reads")
    for name, row in observations.items():
        _need(type(row) is dict and set(row) == {"path", "role", "state", "raw_sha256", "consumed_value_sha256",
            "read_started_utc_claim", "read_completed_utc_claim"}, "invalid_capture_read_state")
        raw = capture["inputs"][name]["raw_utf8"].encode()
        missing = row["state"] == "absent_optional"
        _need(row["path"] == paths[name] and row["role"] == _role(name)
              and row["consumed_value_sha256"] == _hash(raw)
              and row["state"] in ("absent_optional", "present_json_null", "present_json")
              and (missing and name in OPTIONAL and raw == b"null" and row["raw_sha256"] is None
                   or not missing and row["raw_sha256"] == _hash(raw)
                   and (row["state"] == "present_json_null") == (documents[name] is None)), "invalid_capture_read_state")
        _need(gate._time(row["read_started_utc_claim"]) <= gate._time(row["read_completed_utc_claim"])
              <= gate._time(capture["captured_utc_claim"]), "invalid_capture_read_chronology")
    # Empty __init__.py files are valid dependencies; pool/output documents still
    # use the nonempty default of _thaw_raw and their strict JSON validators.
    extra = _thaw_raw(value["extra_code"], allow_empty=True)
    _need(EXTRA_FIXED <= set(extra) and all(_extra_path(k) for k in extra), "invalid_capture_code_inventory")
    return value, documents


class GenerationCapture:
    """Explicit trusted loader session; no source discovery on import/default run."""
    @_safe
    def __init__(self, checkout, loader, *, clock=_utc):
        self.checkout = _checkout(checkout)
        self.loader, self.documents = _loader(loader)
        self.clock = clock
        self.pool_bytes = None
        self.my_reads = None
        self.generated_utc = None

    @_safe
    def pool_inputs(self):
        """Return the same parsed values read once by begin(), without rereading."""
        _same(self.documents, {k: gate._document(v["raw_utf8"], k) for k, v in self.loader["capture"]["inputs"].items()},
              "consumed_capture_documents_mutated")
        exclusions = self.documents["excluded_games"]
        _need(type(exclusions) is dict and type(exclusions.get("games")) is list, "invalid_capture_owner_exclusions")
        ids = set()
        for row in exclusions["games"]:
            _need(type(row) is dict and type(row.get("game_id")) is str and row["game_id"], "invalid_capture_owner_exclusions")
            ids.add(row["game_id"])
        inputs = {name: self.documents[name] for name in POOL_NAMES if name != "excluded_games"}
        if self.generated_utc is None:self.generated_utc = _clock(self.clock)
        inputs.update(excluded_games=ids, generation_sha=self.loader["capture"]["generation_sha_claim"], generated_utc=self.generated_utc)
        _need(gate._time(inputs["generated_utc"]) >= gate._time(self.loader["capture"]["captured_utc_claim"]), "capture_clock_regressed")
        return inputs

    @_safe
    def record_pool_bytes(self, raw):
        """Pass the exact writer buffer, not a later reread mislabeled original."""
        _need(type(raw) is bytes and 0 < len(raw) <= gate.MAX_FILE, "invalid_capture_pool_bytes")
        pool = gate._json(raw);capture = self.loader["capture"]
        _need(type(pool) is dict and type(pool.get("season")) is int and type(pool.get("week")) is int
              and (pool["season"], pool["week"]) == (capture["season"], capture["week"])
              and gate._time(pool.get("generated_utc")) >= gate._time(capture["captured_utc_claim"]), "invalid_capture_pool_identity")
        _need(self.generated_utc is None or self.generated_utc == pool["generated_utc"], "capture_generated_clock_changed")
        _need(self.pool_bytes is None or self.pool_bytes == raw, "immutable_capture_pool_conflict")
        self.pool_bytes = raw
        self.generated_utc = pool["generated_utc"]
        return _sealed({"version": 1, "kind": "nfl.generation_pool_checkpoint.v1", "loader": self.loader,
            "pool": _freeze_raw({"data/leg_pool.json": raw})}, "checkpoint_id")

    @_safe
    def my_inputs(self):
        """Single actual MY-stage read with exact earlier-capture equality checks."""
        _need(self.pool_bytes is not None and self.my_reads is None, "capture_MY_stage_order_invalid")
        capture = self.loader["capture"];paths = _input_paths(capture["season"], capture["week"])
        read_started = _clock(self.clock)
        pool_raw = _read(_relative(self.checkout, "data/leg_pool.json"))
        _need(pool_raw == self.pool_bytes, "capture_pool_changed_between_stages")
        observed, docs = {}, {}
        for name in ("schedule", "parlay_calibration", "previous_my_cards"):
            raw, document, row = _read_input(self.checkout, name, paths[name], self.clock)
            _need(raw == capture["inputs"][name]["raw_utf8"].encode()
                  and row["state"] == self.loader["read_observations"][name]["state"], "capture_MY_input_changed_between_stages")
            observed[name] = row;docs[name] = document
        completed = _clock(self.clock)
        _need(gate._time(read_started) <= gate._time(completed) and gate._time(gate._json(pool_raw)["generated_utc"]) <= gate._time(read_started),
              "invalid_capture_MY_read_chronology")
        self.my_reads = {"inputs": observed, "pool_raw_sha256": _hash(pool_raw),
            "read_started_utc_claim": read_started, "read_completed_utc_claim": completed}
        return {"pool": gate._json(pool_raw), "schedule": docs["schedule"], "calibration": docs["parlay_calibration"],
            "previous": docs["previous_my_cards"], "recorded_utc": completed}

    @_safe
    def finish(self, graph, my_raw, *, target_generation_id):
        _need(self.my_reads is not None and type(my_raw) is bytes, "capture_MY_stage_order_invalid")
        capture = self.loader["capture"];pool = gate._json(self.pool_bytes)
        outputs = {"data/leg_pool.json": self.pool_bytes, _input_paths(capture["season"], capture["week"])["previous_my_cards"]: my_raw}
        binding = gate.bind_generation(capture, graph, outputs, target_generation_id=target_generation_id,
            generated_utc=pool["generated_utc"], bound_utc=_clock(self.clock))
        return _sealed({"version": 1, "kind": "nfl.generation_runtime_binding.v1", "loader": self.loader,
            "my_stage_reads": self.my_reads, "binding": binding, "claims": dict(CLAIMS)}, "runtime_binding_id")

    @_safe
    def journal_graph(self, journal, pool, schedule, calibration, archive, snapshot_dir):
        """Bind actual returned target envelope + consumed objects, then old history.

Only retained receipt IDs require old immutable journal reads. Those additional
reads are evidence of stored lineage, NEVER original producer input reads.
Legacy displayed legs without receipt IDs remain unsupported, not newly attested.
"""
        sources = {gate.fingerprint(v): v for v in (pool, schedule, calibration)}
        document = gate._plain(journal)
        _need(type(document) is dict and type(document.get("generations")) is list and len(document["generations"]) == 1,
              "invalid_capture_journal_source")
        generation = document["generations"][0]
        _same(generation.get("source_snapshots"), {"leg_pool": gate.fingerprint(pool), "schedule": gate.fingerprint(schedule),
            "parlay_calibration": gate.fingerprint(calibration)}, "invalid_capture_journal_source")
        needed = set()
        for card in archive.get("cards") or []:
            for leg in card.get("legs") or []:
                receipt = leg.get("learning_receipt")
                if type(receipt) is dict and leg.get("market") in gate.lr.PROP_MARKETS:
                    _need(type(receipt.get("receipt_id")) is str and HASH.fullmatch(receipt["receipt_id"]), "invalid_capture_journal_source")
                    needed.add(receipt["receipt_id"])
        needed -= set(generation["receipt_ids"])
        documents = {document["envelope_id"]: document};used = 0
        if needed:
            root = _no_links(_alias(snapshot_dir));capture = self.loader["capture"]
            directory = _relative(root, "learning_journal/%d_wk%02d" % (capture["season"], capture["week"]))
            _need(directory.is_dir(), "capture_journal_history_absent")
            paths = sorted(directory.glob("*.json"))
            _need(len(paths) <= 64, "capture_journal_history_limit")
            for path in paths:
                raw = _read(_no_links(path));_need(raw is not None, "capture_journal_history_absent")
                used += len(raw);_need(used <= gate.sem.GRAPH_LIMIT, "capture_journal_history_limit")
                previous = gate._json(raw)
                _need(type(previous) is dict and type(previous.get("generations")) is list and len(previous["generations"]) == 1,
                      "invalid_capture_journal_source")
                prior = previous["generations"][0]
                _need(type(prior.get("generation_id")) is str and HASH.fullmatch(prior["generation_id"])
                      and path.stem == prior["generation_id"].split(":")[1], "invalid_capture_journal_source")
                if prior["generation_id"] == generation["generation_id"]:
                    _same(previous, document, "capture_journal_target_conflict")
                if not needed.intersection(prior.get("receipt_ids") or []):continue
                documents[previous["envelope_id"]] = previous
                for identity in (prior.get("source_snapshots") or {}).values():
                    _need(type(identity) is str and HASH.fullmatch(identity), "invalid_capture_journal_source")
                    if identity in sources:continue
                    raw_source = _read(_relative(root, "learning_sources/" + identity.split(":")[1] + ".json"))
                    _need(raw_source is not None, "capture_journal_history_absent")
                    used += len(raw_source);_need(used <= gate.sem.GRAPH_LIMIT, "capture_journal_history_limit")
                    sources[identity] = gate._json(raw_source)
            known = {identity for doc in documents.values() for identity in doc["generations"][0].get("receipt_ids") or []}
            _need(needed <= known, "capture_retained_receipt_history_absent")
        graph = {"version": 1,
            "source_objects": [{"version": 1, "kind": "source_snapshot", "object_id": k, "payload": v} for k, v in sorted(sources.items())],
            "generations": [{"request": {"version": 1, "kind": "generation", "object_id": k, "payload": v},
                "expected_receipt_ids": sorted(v["generations"][0]["receipt_ids"])} for k, v in sorted(documents.items())]}
        return gate.sem._graph(graph)


@_safe
def begin(checkout, *, generation_sha, clock=_utc):
    """Explicit IO: read each fixed input once, before returning builder values.

No output is written. Persist session.loader explicitly BEFORE running a producer
when crash recovery is needed. The caller's observation/execution order remains
the trusted boundary, not evidence of upstream HTTP/weekly producer provenance.
"""
    root = _checkout(checkout)
    first_raw, first_doc, first_observation = _read_input(root, "parlays", INPUT_PATHS["parlays"], clock)
    _need(type(first_doc) is dict, "invalid_capture_period")
    paths = _input_paths(first_doc.get("season"), first_doc.get("week"))
    raw, observations = {"parlays": first_raw}, {"parlays": first_observation}
    for name in sorted(gate.INPUT_NAMES - {"parlays"}):
        raw[name], _document, observations[name] = _read_input(root, name, paths[name], clock)
    _need(sum(map(len, raw.values())) <= gate.MAX_BYTES, "capture_input_work_limit")
    code = _code(root, gate.CODE_NAMES);extra = _code(root, _extra_paths(root))
    capture = gate.capture_inputs(raw, code, season=first_doc["season"], week=first_doc["week"], captured_utc=_clock(clock),
        generation_sha=generation_sha, policy=gate.POLICY)
    loader = _sealed({"version": 1, "kind": "nfl.generation_loader_observation.v1", "capture": capture,
        "read_observations": observations, "extra_code": _freeze_raw(extra), "claims": dict(CLAIMS)}, "loader_id")
    return GenerationCapture(root, loader, clock=clock)


@_safe
def resume(checkpoint_path, *, checkout, clock=_utc):
    """Read a private immutable checkpoint, never source paths from uploaded JSON."""
    root = _checkout(checkout)
    value = read_artifact(checkpoint_path, checkout=root)
    _need(type(value) is dict and set(value) == {"version", "kind", "loader", "pool", "checkpoint_id"}
          and type(value["version"]) is int and value["version"] == 1
          and value["kind"] == "nfl.generation_pool_checkpoint.v1", "invalid_capture_checkpoint")
    _verify_hash(value, "checkpoint_id")
    session = GenerationCapture(root, value["loader"], clock=clock)
    pool = _thaw_raw(value["pool"])
    _need(set(pool) == {"data/leg_pool.json"}, "invalid_capture_checkpoint")
    _same(session.record_pool_bytes(pool["data/leg_pool.json"]), value, "capture_checkpoint_changed")
    return session


def _git(root, args, *, limit=gate.MAX_FILE, seconds=10):
    """Fixed-argument local git only, bounded output/deadline; no checkout or fetch."""
    deadline = time.monotonic() + seconds
    process = subprocess.Popen(["git", "--no-replace-objects", *args], cwd=root,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    result = bytearray();selector = selectors.DefaultSelector()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            _need(remaining > 0, "capture_git_deadline_exceeded")
            for key, _mask in selector.select(min(remaining, 0.1)):
                data = os.read(key.fd, min(65536, limit + 1 - len(result)))
                if not data:selector.unregister(key.fileobj)
                else:result.extend(data)
                _need(len(result) <= limit, "capture_git_output_limit")
        _need(process.wait(timeout=max(0.001, deadline - time.monotonic())) == 0, "capture_git_object_unavailable")
        return bytes(result)
    finally:
        selector.close()
        if process.poll() is None:process.kill()
        process.wait();process.stdout.close()


def _head_tree(root, head):
    """NUL-framed metadata; do not let quoting or symlink modes hide a change."""
    raw = _git(root, ["ls-tree", "-r", "-l", "-z", head], limit=1024 * 1024)
    tree = {}
    for row in raw.split(b"\0"):
        if not row:continue
        metadata, name = row.split(b"\t", 1);mode, kind, _oid, size = metadata.split()
        path = name.decode("utf-8")
        _need(path not in tree and kind in (b"blob", b"commit"), "invalid_capture_git_tree")
        tree[path] = (mode, int(size) if size != b"-" else -1)
    return tree


def _head_blobs(root, head, tree, names):
    # git show emits raw blobs concatenated in argument order. Frame them using
    # the same immutable tree's byte lengths, not delimiters that may occur in
    # source text. Small argument batches avoid one subprocess per dependency;
    # no archive/export-subst, textconv, temporary file or worktree reads.
    names = sorted(names);total = 0
    for name in names:
        mode, size = tree[name]
        _need(mode in (b"100644", b"100755"), "capture_head_not_regular_file")
        _need(0 <= size <= gate.MAX_FILE, "capture_file_size_limit")
        total += size
    _need(total <= gate.MAX_BYTES, "capture_raw_work_limit")
    result = {};batch = [];arg_bytes = 0
    def read_batch():
        expected = sum(tree[p][1] for p in batch)
        raw = _git(root, ["show", "--no-textconv", "--no-ext-diff", *[head + ":" + p for p in batch]], limit=expected)
        _need(len(raw) == expected, "capture_git_blob_size_mismatch")
        offset = 0
        for path in batch:
            size = tree[path][1];result[path] = raw[offset:offset + size];offset += size
    for name in names:
        length = len((head + ":" + name).encode())
        _need(length <= 8192, "invalid_capture_git_tree")
        if batch and (len(batch) == 32 or arg_bytes + length > 8192):
            read_batch();batch = [];arg_bytes = 0
        batch.append(name);arg_bytes += length
    if batch:read_batch()
    return result


@_safe
def head_identity(checkout):
    result = _git(_checkout(checkout), ["rev-parse", "--verify", "HEAD"], limit=100).decode().strip()
    _need(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", result), "invalid_capture_git_head")
    return result


@_safe
def read_artifact(path, *, checkout):
    root = _checkout(checkout);path = _no_links(_alias(path))
    _output_root(path.parent, root)
    raw = _read(path, MAX_ARTIFACT)
    _need(raw is not None, "invalid_capture_binding_path")
    value = gate._json(raw)
    _need(path.name == gate.fingerprint(value).split(":")[1] + ".json", "capture_artifact_hash_mismatch")
    return value


@_safe
def verify_head(value, *, checkout, clock=_utc, expected_head=None):
    """Recheck exact FINAL HEAD blobs before EACH push, never the worktree alone.

No publish/rebase/rebind occurs. A code/data/tree change after generation holds.
The caller must additionally keep HEAD unchanged until its push invocation;
this local preflight cannot lock an external writer or authenticate git clocks.
"""
    root = _checkout(checkout);value = gate._plain(value)
    _need(type(value) is dict and set(value) == {"version", "kind", "loader", "my_stage_reads", "binding", "claims", "runtime_binding_id"}
          and type(value["version"]) is int and value["version"] == 1
          and value["kind"] == "nfl.generation_runtime_binding.v1", "invalid_runtime_capture_binding")
    _verify_hash(value, "runtime_binding_id");loader, _docs = _loader(value["loader"])
    _same(value["claims"], CLAIMS, "changed_capture_authority_claim")
    _same(value["binding"]["capture"], loader["capture"], "runtime_capture_binding_mismatch")
    # Stage evidence must be well formed; it does not upgrade claim authority.
    reads = value["my_stage_reads"]
    _need(type(reads) is dict and set(reads) == {"inputs", "pool_raw_sha256", "read_started_utc_claim", "read_completed_utc_claim"}
          and reads["pool_raw_sha256"] == value["binding"]["outputs"]["data/leg_pool.json"]["raw_sha256"]
          and gate._time(reads["read_started_utc_claim"]) <= gate._time(reads["read_completed_utc_claim"])
          <= gate._time(value["binding"]["bound_utc_claim"]), "invalid_runtime_MY_read_evidence")
    _need(type(reads["inputs"]) is dict and set(reads["inputs"]) == {"schedule", "parlay_calibration", "previous_my_cards"},
          "invalid_runtime_MY_read_evidence")
    for name, row in reads["inputs"].items():
        original = loader["read_observations"][name]
        _same({k: v for k, v in row.items() if k not in ("read_started_utc_claim", "read_completed_utc_claim")},
              {k: v for k, v in original.items() if k not in ("read_started_utc_claim", "read_completed_utc_claim")}, "runtime_MY_read_input_mismatch")
        _need(gate._time(reads["read_started_utc_claim"]) <= gate._time(row["read_started_utc_claim"])
              <= gate._time(row["read_completed_utc_claim"]) <= gate._time(reads["read_completed_utc_claim"]), "invalid_runtime_MY_read_evidence")
    head = _git(root, ["rev-parse", "--verify", "HEAD"], limit=100).decode().strip()
    _need(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", head), "invalid_capture_git_head")
    _need(expected_head is None or expected_head == head, "capture_checked_head_changed")
    tracked = _head_tree(root, head)
    extra_names = set(EXTRA_FIXED) | {p for p in tracked if _extra_path(p)}
    _need(extra_names == set(loader["extra_code"]), "capture_dependency_inventory_changed")
    capture = loader["capture"];paths = _input_paths(capture["season"], capture["week"])
    names = extra_names | gate.CODE_NAMES | set(gate._paths(capture)) | {paths[p] for p in gate.CURRENT_INPUT_NAMES}
    head_bytes = _head_blobs(root, head, tracked, names & set(tracked))
    def blob(path, *, missing=False):
        if path not in tracked:
            _need(missing, "capture_head_input_absent")
            return None
        return head_bytes[path]
    current = {}
    for name in gate.CURRENT_INPUT_NAMES:
        raw = blob(paths[name], missing=name in OPTIONAL)
        state = loader["read_observations"][name]["state"]
        _need((raw is None) == (state == "absent_optional"), "capture_head_input_presence_changed")
        current[name] = b"null" if raw is None else raw
    extras = {p: blob(p) for p in extra_names}
    _same(_freeze_raw(extras), loader["extra_code"], "capture_head_runtime_or_browser_changed")
    _need(_read(_no_links(_alias(__file__))) == extras[RUNTIME_PATH], "capture_source_code_mismatch")
    report = gate.verify_generation(value["binding"], current_input_bytes=current,
        current_code_bytes={p: blob(p) for p in gate.CODE_NAMES},
        current_output_bytes={p: blob(p) for p in gate._paths(capture)}, checked_utc=_clock(clock))
    _need(_git(root, ["rev-parse", "--verify", "HEAD"], limit=100).decode().strip() == head, "capture_head_changed_during_check")
    return _sealed({"version": 1, "kind": "nfl.final_HEAD_consumer_preflight.v1", "head": head,
        "runtime_binding_id": value["runtime_binding_id"], "semantic_report": report,
        "supported_consumer_pass": report["supported_consumer_pass"], "claims": dict(CLAIMS),
        "scope": "exact_HEAD_MY_yardage_generation_only_not_whole_release"}, "preflight_id")


SCORE_ONLY_PATHS = frozenset(("data/parlay_leg_scores.json", "data/my_card_scores.json", "data/my_card_review.json",
    "data/review.json", "data/bet_facts.json"))


@_safe
def verify_no_generation(*, checkout, base_head, expected_head=None):
    """Explicit N/A, never an old generation PASS or a caller's unsupported flag.

The publisher supplies the exact freshly fetched remote base. EVERY unpublished
commit from that base to the pinned final HEAD must touch ONLY named settlement/
review outputs. A scores-only final commit cannot hide an earlier forecast
change, even one later reverted. Ambiguous merges, missing ancestry and more
than 64 unpublished commits hold. This is deliberately conservative.
"""
    root = _checkout(checkout);head = head_identity(root)
    _need(expected_head is None or expected_head == head, "capture_checked_head_changed")
    _need(type(base_head) is str and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", base_head)
          and base_head != head, "capture_no_generation_invalid_base")
    try:
        _git(root, ["merge-base", "--is-ancestor", base_head, head], limit=100)
    except CaptureError:
        raise CaptureError("capture_no_generation_invalid_base") from None
    commits = _git(root, ["rev-list", "--parents", base_head + ".." + head], limit=16384).decode().splitlines()
    _need(1 <= len(commits) <= 64, "capture_no_generation_commit_limit")
    changed = set()
    for line in commits:
        ancestry = line.split()
        _need(len(ancestry) == 2, "capture_no_generation_ambiguous_commit")
        paths = _git(root, ["diff", "--name-only", "--no-renames", ancestry[1], ancestry[0], "--"],
                     limit=1024 * 1024).decode().splitlines()
        _need(set(paths) <= SCORE_ONLY_PATHS, "capture_no_generation_changed_dependency")
        changed.update(paths)
    _need(changed, "capture_no_generation_changed_dependency")
    _need(head_identity(root) == head, "capture_head_changed_during_check")
    return _sealed({"version": 1, "kind": "nfl.generation_semantic_not_applicable.v1", "head": head,
        "base_head": base_head, "checked_commit_count": len(commits),
        "status": "not_applicable_no_new_generation_scores_only", "changed_paths": sorted(changed),
        "supported_consumer_pass": False, "no_new_generation_proven_by_fixed_diff": True,
        "scope": "no_forecast_dependency_change_not_whole_release", "claims": dict(CLAIMS)}, "preflight_id")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("operation", choices=("verify-head", "no-new-generation"))
    parser.add_argument("--checkout", required=True)
    parser.add_argument("--binding")
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--base-head")
    args = parser.parse_args(argv)
    try:
        if args.operation == "verify-head":
            _need(args.binding is not None and args.base_head is None, "invalid_capture_binding_path")
            result = verify_head(read_artifact(args.binding, checkout=args.checkout), checkout=args.checkout, expected_head=args.expected_head)
            success = result["supported_consumer_pass"]
        else:
            _need(args.binding is None, "invalid_capture_binding_path")
            result = verify_no_generation(checkout=args.checkout, base_head=args.base_head, expected_head=args.expected_head)
            success = result["no_new_generation_proven_by_fixed_diff"]
        print(gate.encoded(result).decode())
        return 0 if success else 3
    except Exception as error:
        reason = error.args[0] if type(error) is CaptureError and len(error.args) == 1 else None
        reason = reason if type(reason) is str and reason in SAFE_ERRORS else "generation_capture_unavailable"
        print(gate.encoded({"version": 1, "status": "held", "reason_codes": [reason], **CLAIMS}).decode())
        return 2


if __name__ == "__main__":
    sys.exit(main())
