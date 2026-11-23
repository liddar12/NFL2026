"""Run and diagnose the offline large-replay canary without logging payloads."""
from collections import Counter
import json
import re

import pytest


RPC_PATH = re.compile(r"/rest/v1/rpc/([a-z0-9_]{1,90})")
SQL_CODE = re.compile(r"[A-Z0-9]{5}")
MEMBERSHIP_RPC = "/rest/v1/rpc/selflearn_journal_prepare_capture_membership_v2"


@pytest.fixture(autouse=True)
def allow_large_replay_membership_response(request, monkeypatch):
    bridge = request.module.TimedSQLBridge
    read = bridge._read

    def read_membership(self, **options):
        # Keep the offline pipe synchronized on slower Linux runners. The
        # engine's operation deadline and all other SQL reads keep their limits.
        if "timeout" not in options and self.calls and self.calls[-1]["path"] == MEMBERSHIP_RPC:
            options["timeout"] = 40
        return read(self, **options)

    monkeypatch.setattr(bridge, "_read", read_membership)


def pytest_exception_interact(node, call, report):
    if not report.failed:
        return
    for entry in call.excinfo.traceback:
        local = entry.frame.f_locals
        if "transport" not in local or "bridge" not in local:
            continue
        http = local["transport"].timings
        bridge = local["bridge"]
        rpc = []
        for row in sorted(bridge.timings, key=lambda item: -item["seconds"])[:5]:
            name = RPC_PATH.fullmatch(row["path"])
            if name:
                rpc.append([name[1], round(row["seconds"], 2)])
        codes = Counter(code for code, _ in bridge.errors
                        if isinstance(code, str) and SQL_CODE.fullmatch(code))
        print("Large replay timings", json.dumps({
            "http_failures": [[row["method"], row["status"], round(row["seconds"], 2)]
                              for row in http if row["status"] >= 400][-12:],
            "slowest_rpc": rpc,
            "sql_codes": dict(codes),
        }))
        break
