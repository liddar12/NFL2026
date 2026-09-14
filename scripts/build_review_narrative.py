#!/usr/bin/env python3
"""OPTIONAL AI narrative layer for data/review.json (R71) — the documented P10 exception.

The product runtime never contacts an LLM. This script is the ONE opt-in place a
model is called, and only on the GitHub runner, only when BOTH environment
variables are set:

    ANTHROPIC_API_KEY        the API key (repository secret)
    REVIEW_NARRATIVE_MODEL   the model name (repository variable) — the ONLY source
                             of the model id; nothing in this repo names a model.

Otherwise it prints one line saying why it skipped and exits 0. It never runs in
the gate (the selftest uses a stubbed transport; no live call is ever made by a
test).

WHAT IT WRITES — next to each MEASURED attribution (a game with a result, or a
player row), a display-only

    "narrative": {"text", "source": "ai_narrative", "generated_utc", "why_hash"}

The prompt hands the model the measured attribution JSON and instructs it to
restate ONLY those facts in <= 60 words and never a new number. The response is
then CHECKED, not trusted: a text over 60 words, or carrying a number that does
not appear in the attribution it was given, is rejected and nothing is written
for that row. `why_hash` ties the text to the exact why it restates;
scripts/build_review.py carries a narrative forward only while that hash still
matches, so a stale narrative can never outlive its facts. The UI labels it
AI NARRATIVE; the measured why stays the source of truth and renders without it.

Request shape (Messages API, raw HTTP via urllib — stdlib only, per the repo's
zero-external-deps rule): POST /v1/messages, headers x-api-key + anthropic-version,
body {model, max_tokens, temperature: 0, system, messages:[{role:"user", ...}]}.
temperature 0 is the owner's decision; a model that rejects the sampling parameter
(HTTP 400 naming `temperature`) is retried once without it and the run notes
"sampling: model default" — never silently.

  python3 scripts/build_review_narrative.py            runner (env-gated, exit 0 on skip)
  python3 scripts/build_review_narrative.py --selftest stubbed transport, never writes data/
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.build_review import why_hash, write  # noqa: E402

REVIEW_PATH = os.path.join(_ROOT, "data", "review.json")
API_URL = os.environ.get("ANTHROPIC_API_URL", "https://api.anthropic.com/v1/messages")
API_VERSION = "2023-06-01"
ENV_KEY = "ANTHROPIC_API_KEY"
ENV_MODEL = "REVIEW_NARRATIVE_MODEL"
MAX_WORDS = 60
MAX_TOKENS = 256          # <= 60 words never needs more
HTTP_TIMEOUT = 60
MAX_CONSECUTIVE_FAILURES = 3

SYSTEM_PROMPT = (
    "You write a short post-game note for a fantasy football app. You are given a "
    "MEASURED attribution as JSON: what the model predicted, what happened, and the "
    "measured reasons why. Restate ONLY the facts in that JSON, in plain prose of at "
    "most %d words. Never introduce a number that does not appear in the JSON. Never "
    "add opinion, prediction, advice, or facts that are not in the JSON. If a value is "
    "null, say it is not on file rather than inventing it. Plain text only: no "
    "markdown, no headings, no preamble." % MAX_WORDS
)

_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def attribution_for(kind, row):
    """The facts handed to the model: the row minus any prior narrative."""
    facts = {k: v for k, v in row.items() if k != "narrative"}
    facts["kind"] = kind
    return facts


def build_request(model, facts, temperature=0):
    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content":
                      "Measured attribution (JSON):\n"
                      + json.dumps(facts, ensure_ascii=True, indent=1)}],
    }
    if temperature is not None:
        body["temperature"] = temperature
    return body


def parse_response(resp):
    """The first text block of a Messages API response; None when there is none or
    the model stopped for a refusal."""
    if not isinstance(resp, dict) or resp.get("stop_reason") == "refusal":
        return None
    for block in resp.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
            return str(block["text"]).strip()
    return None


def check_text(text, facts):
    """(ok, reason). Rejects > MAX_WORDS words and any number not present in the
    attribution JSON (compared as literal numeric tokens)."""
    if not text:
        return False, "empty"
    words = text.split()
    if len(words) > MAX_WORDS:
        return False, "%d words > %d" % (len(words), MAX_WORDS)
    blob = json.dumps(facts, ensure_ascii=True)
    allowed = set(_NUM_RE.findall(blob))
    for tok in _NUM_RE.findall(text):
        if tok in allowed:
            continue
        # "65" is allowed when the facts carry "65%"/"65.0"; "10.7" when they carry "-10.7"
        if any(a.startswith(tok + ".") or a.endswith("." + tok) or a == tok.rstrip("0").rstrip(".")
               for a in allowed):
            continue
        return False, "number %s not in the attribution" % tok
    return True, None


def http_transport(api_key):
    """POST the body to the Messages API; returns (status, parsed_json_or_text)."""
    def send(body):
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(API_URL, data=data, method="POST", headers={
            "content-type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": API_VERSION,
        })
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            try:
                return err.code, json.loads(raw)
            except ValueError:
                return err.code, raw
    return send


def _mentions_temperature(payload):
    return "temperature" in json.dumps(payload).lower()


def narrate(doc, model, transport, now, max_calls=80, log=print):
    """Attach narratives in place. Returns a summary dict. `transport(body) ->
    (status, payload)`; injected so the selftest never touches the network."""
    calls = written = skipped = rejected = failed = 0
    consecutive = 0
    sampling = "temperature 0"
    for wk, blk in (doc.get("weeks") or {}).items():
        targets = [("game", g, "game_id") for g in blk.get("games") or [] if g.get("result")]
        targets += [("player", p, "gsis_id") for p in blk.get("players") or []]
        for kind, row, key in targets:
            if not row.get("why"):
                continue
            h = why_hash(row["why"])
            if row.get("narrative") and row["narrative"].get("why_hash") == h:
                skipped += 1
                continue
            if calls >= max_calls:
                skipped += 1
                continue
            if consecutive >= MAX_CONSECUTIVE_FAILURES:
                skipped += 1
                continue
            facts = attribution_for(kind, row)
            body = build_request(model, facts, 0)
            calls += 1
            status, payload = transport(body)
            if status == 400 and _mentions_temperature(payload):
                body = build_request(model, facts, None)
                sampling = "model default (temperature rejected by the API)"
                status, payload = transport(body)
            if status != 200:
                failed += 1
                consecutive += 1
                log("[review_narrative] wk %s %s %s: HTTP %s — skipped" % (
                    wk, kind, row.get(key), status))
                continue
            consecutive = 0
            text = parse_response(payload)
            ok, why = check_text(text, facts)
            if not ok:
                rejected += 1
                log("[review_narrative] wk %s %s %s: rejected (%s) — nothing written" % (
                    wk, kind, row.get(key), why))
                continue
            row["narrative"] = {"text": text, "source": "ai_narrative",
                                "generated_utc": now, "why_hash": h}
            written += 1
    return {"calls": calls, "written": written, "skipped": skipped, "rejected": rejected,
            "failed": failed, "sampling": sampling}


def run(path=REVIEW_PATH, env=None, now=None, transport=None, max_calls=80):
    env = os.environ if env is None else env
    key, model = env.get(ENV_KEY), env.get(ENV_MODEL)
    if not key or not model:
        missing = [n for n, v in ((ENV_KEY, key), (ENV_MODEL, model)) if not v]
        print("review_narrative: SKIPPED — %s not set (opt-in layer; the measured review "
              "stands on its own)" % " and ".join(missing))
        return 0
    if not os.path.exists(path):
        print("review_narrative: SKIPPED — %s does not exist yet (run build_review first)"
              % os.path.relpath(path, _ROOT))
        return 0
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    s = narrate(doc, model, transport or http_transport(key), now, max_calls=max_calls)
    if s["written"]:
        write(doc, path)
    print("review_narrative: %d calls, %d written, %d skipped (fresh or capped), "
          "%d rejected, %d failed; sampling: %s" % (
              s["calls"], s["written"], s["skipped"], s["rejected"], s["failed"],
              s["sampling"]))
    return 0


# --------------------------------------------------------------------------- #
# selftest — stubbed transport, never a live call, never writes data/           #
# --------------------------------------------------------------------------- #

def selftest():
    import io  # noqa: PLC0415
    import contextlib  # noqa: PLC0415
    from scripts.build_review import build, _fixture_inputs  # noqa: PLC0415
    doc = build(_fixture_inputs(), "2026-09-14T12:00:00Z")
    sent = []

    def stub(body):
        sent.append(body)
        facts = json.loads(body["messages"][0]["content"].split("\n", 1)[1])
        if facts["kind"] == "game":
            txt = "Picked %s at %s%%; %s." % (facts["picked"], round(facts["pick_prob"] * 100),
                                             facts["why"]["summary"])
        elif facts["gsis_id"] == "fx-wr":
            txt = "He scored 99 points."                       # invented number -> rejected
        elif facts["gsis_id"] == "fx-te":
            txt = " ".join(["word"] * 61)                        # too long -> rejected
        else:
            txt = "Actual %s against a projection of %s: %s." % (
                facts["actual"], facts["projected"], facts["why"]["summary"])
        return 200, {"content": [{"type": "text", "text": txt}], "stop_reason": "end_turn"}

    s = narrate(doc, "model-from-env", stub, "2026-09-14T13:00:00Z", log=lambda *_: None)
    # request shape: model only from the argument, temperature 0, system rule, JSON handed over
    b = sent[0]
    assert b["model"] == "model-from-env" and b["temperature"] == 0 \
        and b["max_tokens"] == MAX_TOKENS and "%d words" % MAX_WORDS in b["system"]
    assert b["messages"][0]["role"] == "user" and '"why"' in b["messages"][0]["content"]
    assert "thinking" not in b, "no thinking parameter: the model decides"
    games = [g for g in doc["weeks"]["1"]["games"] if g.get("result")]
    assert all(g["narrative"]["source"] == "ai_narrative" and g["narrative"]["why_hash"]
               == why_hash(g["why"]) for g in games)
    assert not any(g.get("narrative") for g in doc["weeks"]["1"]["games"] if not g.get("result")), \
        "an ungraded game gets no narrative"
    p = {x["gsis_id"]: x for x in doc["weeks"]["1"]["players"]}
    assert "narrative" not in p["fx-wr"], "invented number rejected"
    assert "narrative" not in p["fx-te"], "> 60 words rejected"
    assert p["fx-rb"]["narrative"]["text"].startswith("Actual 19.9")
    assert s["written"] == 2 + 3 and s["rejected"] == 2 and s["calls"] == 7, s
    # idempotent: a second pass skips every row whose why is unchanged and retries
    # only the two rows that were rejected (nothing on file for them)
    s2 = narrate(doc, "model-from-env", stub, "t2", log=lambda *_: None)
    assert s2["calls"] == 2 and s2["skipped"] == 5 and s2["written"] == 0, s2
    # the temperature retry: a 400 naming temperature -> one retry without it
    seen = []

    def stub400(body):
        seen.append(body)
        if "temperature" in body:
            return 400, {"error": {"message": "temperature is not supported on this model"}}
        return 200, {"content": [{"type": "text", "text": "Picked AAA at 60%."}]}
    doc2 = build(_fixture_inputs(), "2026-09-14T12:00:00Z")
    s3 = narrate(doc2, "m", stub400, "t", max_calls=1, log=lambda *_: None)
    assert len(seen) == 2 and "temperature" not in seen[1] and s3["written"] == 1 \
        and s3["sampling"].startswith("model default")
    # a refusal / empty response writes nothing; parse guards
    assert parse_response({"stop_reason": "refusal", "content": [{"type": "text", "text": "x"}]}) is None
    assert parse_response({"content": [{"type": "thinking", "thinking": ""},
                                       {"type": "text", "text": " hi "}]}) == "hi"
    assert check_text("Picked SEA at 65 percent.", {"pick_prob": 0.6508, "why": {"summary": "65%"}})[0]
    assert not check_text("Picked SEA at 66 percent.", {"pick_prob": 0.6508})[0]
    # env gate: skip loudly with exit 0, nothing read or written
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = run(path="/nonexistent/review.json", env={})
    assert rc == 0 and "SKIPPED" in buf.getvalue() and ENV_KEY in buf.getvalue() \
        and ENV_MODEL in buf.getvalue()
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = run(path="/nonexistent/review.json", env={ENV_KEY: "k", ENV_MODEL: "m"},
                 transport=lambda b: (_ for _ in ()).throw(AssertionError("no live call")))
    assert rc == 0 and "does not exist" in buf.getvalue()
    print("selftest OK: env-gated skip (exit 0), request shape (model from env only, "
          "temperature 0, no thinking), response parsing, <=60-word and no-new-number "
          "guards, why_hash idempotence, temperature-400 retry, refusal -> nothing written")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--path", default=REVIEW_PATH)
    ap.add_argument("--max-calls", type=int, default=80)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    return run(path=args.path, max_calls=args.max_calls)


if __name__ == "__main__":
    sys.exit(main())
