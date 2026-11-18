"""Report results for the exact Data CI run attempt to one GitHub issue."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

SHA_PATTERN = r"[0-9a-f]{40}"
ATTEMPT_PATTERN = r"[1-9][0-9]*/[1-9][0-9]*"
SUMMARY_START = "<!-- data-ci-summary:v1 "
SUMMARY_END = "<!-- /data-ci-summary -->"
BOT_LOGIN = "github-actions[bot]"
PAGE_SIZE = 100
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_DIAGNOSTICS = 100
RECENT_ATTEMPTS = 32
WORKFLOW_STEPS = {
    "Checkout the resolved commit",
    "Verify the commit under test",
    "Setup Python",
    "Setup Node",
    "Install dependencies",
    "Install Playwright chromium",
    "Run regression gate",
    "Run browser E2E (web + pwa)",
}
GATE_DIAGNOSTICS = (
    ("data validation", r"  \* (.+)"),
    ("smoke test", r"SMOKE FAIL: (.+)"),
    ("backtest", r"(?:GATE FAIL: |\[gate\] REFUSED: )(.+)"),
    ("missing weekly input", r"WEEKLY BACKTEST: (.+ is missing; refusing to score a partial corpus)"),
)
TAP_FAILURE = re.compile(r"\s*not ok \d+ - (.+)")
PLAYWRIGHT_TITLE = r"(\[[^\]]+\] › .*\.spec\.[cm]?[jt]sx?:\d+:\d+ › .+)"
LOG_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T[\d:.]+Z ")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
GENERIC_ANNOTATION = re.compile(
    r"(?i)(process completed with exit code \d+\.?|the operation was cancel[el]+ed\.?|"
    r"the job was cancel[el]+ed\.?|job failed\.?|step failed\.?)"
)


class ApiError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self, env):
        self.base = env["GITHUB_API_URL"].rstrip("/") + "/repos/" + env["GH_REPO"]
        self.token = env["GH_TOKEN"]
        self.opener = build_opener(NoRedirect())

    def request(self, path, method="GET", payload=None, *, log=False):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2026-03-10",
        }
        try:
            try:
                response = self.opener.open(Request(self.base + "/" + path, body, headers, method=method),
                                            timeout=15)
            except HTTPError as exc:
                with exc:
                    location = exc.headers.get("Location", "")
                    if not log or exc.code != 302 or urlsplit(location).scheme != "https":
                        raise ApiError(f"GitHub API returned HTTP {exc.code} for {method} {path}") from None
                # The Actions API returns a signed, short-lived URL. Fetch it
                # without the GitHub token and never print the URL or its content.
                response = self.opener.open(Request(location), timeout=15)
            with response:
                data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise ApiError("GitHub API response exceeded the size limit")
            return data.decode() if log else json.loads(data)
        except (URLError, OSError, ValueError):
            raise ApiError(f"Could not read GitHub API response for {method} {path}") from None

    def items(self, path, **params):
        page = 1
        while True:
            result = self.request(f"{path}?{urlencode(dict(params, per_page=PAGE_SIZE, page=page))}")
            yield from result
            if len(result) < PAGE_SIZE:
                return
            page += 1


@dataclass(frozen=True)
class Evidence:
    fingerprint: str | None
    steps: tuple
    categories: tuple


def digest(values):
    encoded = json.dumps(values, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def diagnostic(value):
    """Normalize only formatting. Keep assertion text and values in the hash."""
    if not isinstance(value, str) or re.search(r"\*\*\*|\[redacted\]", value, re.I):
        return None
    value = "\n".join(line.strip() for line in ANSI_ESCAPE.sub("", value).splitlines()).strip()
    return value if 0 < len(value) <= 4000 else None


def tap_failures(lines):
    failures = []
    for index, line in enumerate(lines):
        tap = TAP_FAILURE.fullmatch(line)
        if tap:
            reasons = []
            multiline_indent = None
            for following in lines[index + 1:]:
                if re.match(r"\s*(?:\.\.\.|#|not ok |ok )", following):
                    break
                field = re.match(r"(\s*)(failureType|error|code|expected|actual):\s*(.*)", following)
                if field:
                    reasons.append(field[2] + "=" + field[3])
                    multiline_indent = len(field[1]) if field[3] in ("|", "|-", ">", ">-") else None
                elif multiline_indent is not None:
                    if len(following) - len(following.lstrip()) > multiline_indent:
                        reasons.append(following)
                    else:
                        multiline_indent = None
            failures.append(("feature test", "\n".join([tap[1], *reasons])))
    return failures


def browser_failures(lines):
    """Use Playwright's final failed tests and each test's printed error details."""
    failures = {}
    title = None
    for index, line in enumerate(lines):
        line = re.sub(r" +─+$", "", line)
        header = re.fullmatch(r"\s*\d+\) " + PLAYWRIGHT_TITLE, line)
        if header:
            title = header[1]
            failures.setdefault(title, [])
        elif title and re.match(r"\s*(?:\w*Error:|Test timeout of |Expected to fail, but passed\.|"
                                r"Expected[^:]*:|Received[^:]*:|Locator:|>\s+\d+\s*\|)", line):
            failures[title].append(line)
        count = re.fullmatch(r"\s*([1-9]\d*) failed\s*", line)
        if count:
            break
    else:
        return []
    expected = int(count[1])
    incomplete = r"\d+ (?:interrupted|errors? (?:was|were) not a part of any test)"
    if expected > MAX_DIAGNOSTICS or any(re.search(incomplete, item) for item in lines[index + 1:]):
        return []
    reasons = []
    for line in lines[index + 1:index + expected + 1]:
        match = re.fullmatch(r"\s*" + PLAYWRIGHT_TITLE, re.sub(r" +─+$", "", line))
        if not match:
            return []
        candidates = [details for header, details in failures.items()
                      if header == match[1] or header.startswith(match[1] + " › ")]
        if len(candidates) != 1 or not candidates[0]:
            return []
        reasons.append(("browser test", "\n".join([match[1], *candidates[0]])))
    return reasons if len(reasons) == expected else []


def gate_failures(lines):
    """Require concrete diagnostics for every internal gate stage that failed."""
    stage_number = None
    stage = []
    failures = []
    for line in lines:
        start = re.fullmatch(r"GATE STEP (\d+): .+", line)
        if start:
            stage_number = start[1]
            stage = []
            continue
        failed = re.fullmatch(r"GATE STEP (\d+) FAIL: (.+)", line)
        if failed:
            if failed[1] != stage_number:
                return []
            issues = tap_failures(stage) + browser_failures(stage)
            for output in stage:
                for category, pattern in GATE_DIAGNOSTICS:
                    match = re.fullmatch(pattern, output)
                    if match:
                        issues.append((category, match[1]))
            if not issues:
                return []
            failures.extend((category, failed[2] + "\n" + reason) for category, reason in issues)
        stage.append(line)
    return failures if "GATE RESULT: FAIL (red — do NOT deploy)" in lines else []


def annotation_failures(api, check_run_url, repo):
    if not isinstance(check_run_url, str):
        return []
    check = re.fullmatch(r"/(?:api/v3/)?repos/" + re.escape(repo) + r"/check-runs/([1-9]\d*)",
                         urlsplit(check_run_url).path)
    if not check:
        return []
    # If this page is full, evidence may be truncated. Do not fingerprint a subset.
    entries = api.request(f"check-runs/{check[1]}/annotations?per_page={MAX_DIAGNOSTICS}")
    if not isinstance(entries, list) or len(entries) >= MAX_DIAGNOSTICS:
        return []
    failures = []
    for entry in entries:
        if entry.get("annotation_level") == "failure":
            message = entry.get("message")
            if not isinstance(message, str):
                return []
            if not GENERIC_ANNOTATION.fullmatch(message.strip()):
                failures.append(("GitHub check annotation", json.dumps([
                    entry.get("title"), entry.get("path"), message, entry.get("raw_details")
                ], ensure_ascii=False)))
    return failures


def get_evidence(api, env, results):
    if env.get("SIMULATE_RED") == "true":
        return Evidence(digest(["manual simulation"]), (), ("manual simulation",))

    run_id, attempt = env["GITHUB_RUN_ID"], env["GITHUB_RUN_ATTEMPT"]
    steps, reasons = [], []
    complete = True
    try:
        result = api.request(f"actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
        jobs = result["jobs"]
        if len(jobs) != result["total_count"] or len(jobs) >= PAGE_SIZE:
            return Evidence(None, (), ())
        for name, status in results.items():
            if status == "success":
                continue
            candidates = [job for job in jobs if job["name"] == name]
            if len(candidates) != 1 or status != "failure":
                complete = False
                continue
            job = candidates[0]
            if (job["run_id"] != int(run_id) or job.get("run_attempt", int(attempt)) != int(attempt)
                    or job["conclusion"] != "failure" or job["status"] != "completed"
                    or type(job["id"]) is not int or job["id"] < 1):
                complete = False
                continue
            failed = [step for step in job["steps"] if step["conclusion"] == "failure"]
            if not failed:
                complete = False
            for step in failed:
                step_name = step["name"]
                steps.append((name, step_name if step_name in WORKFLOW_STEPS else "failed workflow step"))
                found = []
                if step_name in ("Run regression gate", "Run browser E2E (web + pwa)"):
                    number = step["number"]
                    if type(number) is int and number > 0:
                        try:
                            log = api.request(f"actions/jobs/{job['id']}/steps/{number}/logs", log=True)
                            lines = [LOG_TIMESTAMP.sub("", ANSI_ESCAPE.sub("", line)) for line in log.splitlines()]
                            found = gate_failures(lines) if step_name == "Run regression gate" else browser_failures(lines)
                        except ApiError:
                            pass
                elif len(failed) == 1:
                    # Test steps can fail for several reasons at once. A job
                    # annotation alone cannot establish the full set of failing tests.
                    try:
                        found = annotation_failures(api, job.get("check_run_url"), env["GH_REPO"])
                    except ApiError:
                        pass
                if not found or len(found) > MAX_DIAGNOSTICS or step_name not in WORKFLOW_STEPS:
                    complete = False
                    continue
                for category, raw in found:
                    value = diagnostic(raw)
                    if value is None:
                        complete = False
                    else:
                        reasons.append((name, step_name, category, value))
    except (ApiError, KeyError, TypeError, ValueError, AttributeError):
        complete = False
    key = digest([results, sorted(reasons)]) if complete and reasons else None
    return Evidence(key, tuple(sorted(set(steps))), tuple(sorted({item[2] for item in reasons})))


def prior_summary(body):
    start = body.find(SUMMARY_START)
    if start == -1:
        return None, None
    end = body.find(SUMMARY_END, start)
    if end == -1 or body.count(SUMMARY_START) != 1 or body.count(SUMMARY_END) != 1:
        return None, None
    state_text, separator, content = body[start + len(SUMMARY_START):end].partition(" -->\n")
    if not separator:
        return None, None
    try:
        state = json.loads(state_text)
        fingerprint = state["fingerprint"]
        attempts = state["attempts"]
        if (state["content_hash"] != digest(content)
                or fingerprint is not None and not re.fullmatch(r"[0-9a-f]{64}", fingerprint)
                or not isinstance(attempts, list) or len(attempts) > RECENT_ATTEMPTS
                or any(not re.fullmatch(ATTEMPT_PATTERN, item) for item in attempts)):
            return None, None
    except (TypeError, ValueError, KeyError):
        return None, None
    return state, (start, end + len(SUMMARY_END))


def report_text(env, results, evidence, attempt):
    sha = env["SHA"]
    source = html.escape(env["SOURCE"].replace("\n", " ").replace("\r", " ")[:150]).replace("@", "&#64;")
    source_url = env.get("SOURCE_URL", "")
    run_url = env["RUN_URL"]
    run = f"{run_url}/attempts/{attempt}"
    if source_url.startswith(run_url.rsplit("/actions/runs/", 1)[0] + "/actions/runs/"):
        source = f"{source} ({source_url})"
    lines = [
        f"Exact tested commit `{sha}`, after {source}.",
        f"- Fast gate (`tests/run_gate.sh`) — {results['gate']}",
        f"- Browser E2E — {results['e2e']}",
        f"- [Data CI run, attempt {attempt}]({run})",
    ]
    if evidence.steps:
        lines.append("- Failed steps — " + ", ".join(f"`{job}` / {step}" for job, step in evidence.steps))
    if evidence.fingerprint:
        lines.append(f"- Failure evidence — {', '.join(evidence.categories)} (`{evidence.fingerprint[:12]}`)")
    else:
        lines.append("- Failure evidence — insufficient to identify a repeat failure. See the run for details.")
    return "\n".join(lines)


def summary(body, bounds, state, text):
    content = "### Latest Data CI failure\n\n" + text + "\n"
    state = {**state, "content_hash": digest(content)}
    block = SUMMARY_START + json.dumps(state, separators=(",", ":")) + " -->\n" + content + SUMMARY_END
    if bounds is None:
        return body + "\n\n" + block
    return body[:bounds[0]] + block + body[bounds[1]:]


def post_comment_once(api, issue_path, key, body, current):
    marker = f"<!-- data-ci-report:v1 {key} -->"
    comments = issue_path + "/comments"
    if any(comment.get("user", {}).get("login") == BOT_LOGIN
           and (comment.get("body") or "").startswith(marker + "\n")
           for comment in api.items(comments)):
        return
    if current():
        api.request(comments, "POST", {"body": marker + "\n" + body})


def report(api, env):
    results = {"gate": env["GATE"], "e2e": env["E2E"]}
    if "cancelled" in (env["RESOLUTION"], *results.values()):
        print("Data CI was cancelled. No issue updated.")
        return 0
    if env["RESOLUTION"] != "success":
        print("::error::could not resolve the published commit; see the resolution job")
        return 1
    sha = env["SHA"]
    if not sha:
        print("No data was published. No issue updated.")
        return 0
    key = f"{env['GITHUB_RUN_ID']}/{env['GITHUB_RUN_ATTEMPT']}"
    if not re.fullmatch(SHA_PATTERN, sha) or not re.fullmatch(ATTEMPT_PATTERN, key):
        raise ApiError("Invalid Data CI SHA or run attempt")
    green = all(status == "success" for status in results.values())

    def current():
        head = api.request("git/ref/heads/main")["object"]["sha"]
        if sha == head:
            return True
        print(f"Historical Data CI result on {sha} (main is {head}): "
              f"gate={results['gate']}, e2e={results['e2e']}")
        return False

    if not current():
        return int(not green)

    title = env["DATA_CI_TITLE"]
    issue = next((item for item in api.items("issues", state="open", sort="created", direction="asc")
                  if item["title"] == title and "pull_request" not in item), None)
    path = f"issues/{issue['number']}" if issue else None
    attempt = env["GITHUB_RUN_ATTEMPT"]
    if green:
        print(f"Data CI GREEN on {sha}")
        if path:
            recovery = (f"Green again on `{sha}`. "
                        f"[Data CI run, attempt {attempt}]({env['RUN_URL']}/attempts/{attempt})")
            post_comment_once(api, path, "green " + key, recovery, current)
            if current():
                api.request(path, "PATCH", {"state": "closed", "state_reason": "completed"})
        return 0

    print(f"Data CI RED on {sha}")
    prior, _ = prior_summary((issue.get("body") or "") if issue else "")
    if prior and key in prior["attempts"]:
        return 1
    evidence = get_evidence(api, env, results)
    text = report_text(env, results, evidence, attempt)
    if path is None:
        if current():
            state = {"fingerprint": evidence.fingerprint, "attempts": [key]}
            initial = (text + "\n\nFix forward via the pipeline and keep `data/` pipeline-owned. "
                       "The next green Data CI run on current main closes this issue.")
            api.request("issues", "POST", {"title": title, "body": summary(initial, None, state, text)})
        return 1

    # Refresh issue text before deciding whether the existing summary can be replaced.
    body = api.request(path).get("body") or ""
    prior, bounds = prior_summary(body)
    same_failure = evidence.fingerprint is not None and prior and prior["fingerprint"] == evidence.fingerprint
    if not same_failure:
        post_comment_once(api, path, "red " + key, text, current)
        body = api.request(path).get("body") or ""
        prior, bounds = prior_summary(body)
    recent = prior["attempts"] if prior else []
    state = {"fingerprint": evidence.fingerprint, "attempts": (recent + [key])[-RECENT_ATTEMPTS:]}
    if (bounds is not None or (SUMMARY_START not in body and SUMMARY_END not in body)) and current():
        api.request(path, "PATCH", {"body": summary(body, bounds, state, text)})
    return 1


def main():
    try:
        return report(GitHub(os.environ), os.environ)
    except (ApiError, KeyError, TypeError) as error:
        message = str(error) if isinstance(error, ApiError) else "Unexpected GitHub response or Data CI environment"
        print(f"::error::{message}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
