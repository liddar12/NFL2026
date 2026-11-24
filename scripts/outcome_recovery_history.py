"""Locate original scoped-outcome pointers in trusted GitHub Actions history."""

import hashlib
import io
import json
import re
from threading import Lock
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import zipfile

from scripts import export_learning


WORKFLOW = "selflearning-outcomes.yml"
REPOSITORY_ID = 1301774434
API = "https://api.github.com/repos/liddar12/NFL2026/actions"
RUNS_PER_PAGE = 100
MAX_HISTORY_RUNS = 300
MAX_API_REQUESTS = 800
MAX_POINTER_BYTES = 4096
MAX_ARCHIVE_BYTES = 16384
MAX_JSON_BYTES = 8 * 1024 * 1024
IDENTIFIER = re.compile(r"[1-9][0-9]{0,18}")
ARTIFACT_NAME = re.compile(r"selflearning-outcome-([1-9][0-9]{0,18})-([1-9][0-9]{0,18})-game-([A-Za-z0-9_-]{1,200})")
BLOB_HOST = re.compile(r"productionresultssa[0-9]+\.blob\.core\.windows\.net")


class HistoryError(ValueError):
    """Source history was incomplete or failed its provenance checks."""


class _InspectRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


def _need(condition):
    if not condition:
        raise HistoryError("outcome_recovery_history_unverified")


def _id(value):
    _need(type(value) is int and IDENTIFIER.fullmatch(str(value)))
    return value


def _artifact_header(row, run, match):
    source = row["workflow_run"]
    _need(int(match[1]) == run["id"] == source["id"] and int(match[2]) <= _id(run["run_attempt"])
          and source["repository_id"] == source["head_repository_id"] == REPOSITORY_ID
          and source["head_branch"] == "main" and source["head_sha"] == run["head_sha"])
    _need(type(row["expired"]) is bool)
    if row["expired"]:
        return None
    _need(type(row["size_in_bytes"]) is int and 0 < row["size_in_bytes"] <= MAX_ARCHIVE_BYTES)
    export_learning._hash(row["digest"])
    return (_id(row["id"]), match[1], match[2], row["digest"], row["size_in_bytes"])


def pointer_candidates(get_json, game_ids, since, current_run_id):
    """Return newest-first pointer metadata from completed main dispatcher runs."""
    query = {"branch": "main", "status": "completed",
             "created": ">=" + since.date().isoformat(), "per_page": RUNS_PER_PAGE}
    runs = []
    for number in range(1, MAX_HISTORY_RUNS // RUNS_PER_PAGE + 1):
        page = get_json("/workflows/" + WORKFLOW + "/runs?" + urlencode({**query, "page": number}))
        _need(type(page["total_count"]) is int and 0 <= page["total_count"] <= MAX_HISTORY_RUNS)
        rows = page["workflow_runs"]
        _need(type(rows) is list and len(rows) <= RUNS_PER_PAGE)
        runs.extend(rows)
        if len(runs) >= page["total_count"]:
            break
        _need(len(rows) == RUNS_PER_PAGE)
    _need(len(runs) == page["total_count"] and len({_id(run["id"]) for run in runs}) == len(runs))
    output = {game_id: [] for game_id in game_ids}
    for run in sorted(runs, key=lambda row: row["id"], reverse=True):
        _need(run["path"] == ".github/workflows/" + WORKFLOW and run["status"] == "completed"
              and run["event"] in {"workflow_run", "workflow_dispatch"} and run["head_branch"] == "main"
              and run["repository"]["id"] == run["head_repository"]["id"] == REPOSITORY_ID
              and str(run["id"]) != current_run_id)
        listing = get_json(f"/runs/{run['id']}/artifacts?per_page=100")
        _need(type(listing["total_count"]) is int and listing["total_count"] == len(listing["artifacts"])
              and 0 <= listing["total_count"] <= RUNS_PER_PAGE)
        scoped = []
        for row in listing["artifacts"]:
            match = ARTIFACT_NAME.fullmatch(row["name"])
            if match is not None and match[3] in output:
                artifact = _artifact_header(row, run, match)
                if artifact is not None:
                    scoped.append((match[3], artifact))
        _need(len({(game, row[2]) for game, row in scoped}) == len(scoped))
        for game, artifact in sorted(scoped, key=lambda item: int(item[1][2]), reverse=True):
            output[game].append(artifact)
    return output


def _read_pointer_archive(raw, expected_digest, expected_size):
    _need(len(raw) == expected_size and "sha256:" + hashlib.sha256(raw).hexdigest() == expected_digest)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        _need(len(entries) == 1 and entries[0].filename == "pointer.json"
              and 0 < entries[0].file_size <= MAX_POINTER_BYTES)
        with archive.open(entries[0]) as entry:
            return export_learning._json(entry.read(MAX_POINTER_BYTES + 1))


class GitHubHistory:
    def __init__(self, token, *, deadline=None):
        _need(type(token) is str and 20 <= len(token) <= 8192 and all(0x21 <= ord(c) <= 0x7e for c in token))
        self.headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28"}
        self.opener = build_opener(ProxyHandler({}), _InspectRedirect())
        self.deadline = deadline if deadline is not None else time.monotonic() + 300
        self.api_requests = 0
        self.lock = Lock()

    def _timeout(self, *, github_api=False):
        remaining = self.deadline - time.monotonic()
        _need(remaining > 0)
        if github_api:
            with self.lock:
                _need(self.api_requests < MAX_API_REQUESTS)
                self.api_requests += 1
        return min(8, remaining)

    def json(self, route):
        with self.opener.open(Request(API + route, headers=self.headers), timeout=self._timeout(github_api=True)) as response:
            raw = response.read(MAX_JSON_BYTES + 1)
        _need(len(raw) <= MAX_JSON_BYTES)
        return json.loads(raw)

    def download(self, artifact):
        artifact_id, _, _, digest, size = artifact
        try:
            self.opener.open(Request(f"{API}/artifacts/{_id(artifact_id)}/zip", headers=self.headers),
                             timeout=self._timeout(github_api=True)).close()
        except HTTPError as error:
            status, address = error.code, error.headers.get("Location")
            error.close()
            _need(status == 302 and type(address) is str)
        else:
            raise HistoryError("outcome_recovery_artifact_redirect_missing")
        blob = urlsplit(address)
        _need(blob.scheme == "https" and BLOB_HOST.fullmatch(blob.netloc) and not blob.fragment)
        # The blob URL is already authorized by GitHub. Never attach the API token.
        with self.opener.open(Request(address), timeout=self._timeout()) as response:
            return _read_pointer_archive(response.read(MAX_ARCHIVE_BYTES + 1), digest, size)
