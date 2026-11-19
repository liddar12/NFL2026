#!/usr/bin/env python3
"""Retain a locally observed pre-kickoff copy of the published Game and Week slate."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import Request, ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_parlay_archive import card_id
from scripts.capture_outcome_evidence import _immutable
from scripts.export_learning import base_url, _NoRedirect
from scripts.learning_receipts import fingerprint, instant
from scripts.queue_publication import publisher_commit

NAMES = ("parlays.json", "schedule_full.json")
MAX_BYTES = 3 * 1024 * 1024


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _get_json(origin, name):
    url = f"{origin}/data/{name}"
    opener = build_opener(ProxyHandler({}), _NoRedirect())
    request = Request(url, headers={"Accept": "application/json", "Accept-Encoding": "identity"})
    with opener.open(request, timeout=12) as response:
        if (response.status != 200 or response.geturl() != url
                or response.headers.get_content_type() != "application/json"):
            raise ValueError("public_resource_response_refused_" + name)
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("public_resource_size_exceeded_" + name)
    return raw


def classify_offers(slate, schedule, observed_utc):
    observed = instant(observed_utc)
    generated = instant(slate["updated_utc"])
    if observed is None or generated is None or generated > observed or slate["season"] != schedule["season"]:
        raise ValueError("invalid_observed_slate_clock_or_season")
    games, teams = {}, defaultdict(list)
    for game in schedule["games"]:
        if game["week"] != slate["week"]:
            continue
        gid = str(game["game_id"])
        if gid in games:
            raise ValueError("duplicate_observed_game_id")
        games[gid] = game
        for side in ("home", "away"):
            teams[game[side]].append(gid)
    results = []
    for card in slate["parlays"]:
        ids = []
        reason = None
        for leg in card["legs"]:
            if card["scope"] == "game":
                gid = str(card.get("game_id"))
            elif (card["scope"] == "week" and leg["market"] == "moneyline"
                  and leg["selection"].endswith(" ML")
                  and len(teams[leg["selection"].removesuffix(" ML")]) == 1):
                gid, = teams[leg["selection"].removesuffix(" ML")]
            else:
                reason = "unresolved_leg_game"
                break
            game = games.get(gid)
            kickoff = instant(game.get("kickoff_utc")) if game else None
            side = leg.get("side")
            expected_team = game.get(side) if game and side in ("home", "away") else None
            if (kickoff is None or (leg.get("game_id") is not None and str(leg["game_id"]) != gid)
                    or (leg.get("team") is not None
                        and leg["team"] not in (game["home"], game["away"]))
                    or (expected_team is not None and leg.get("team") not in (None, expected_team))
                    or (leg["market"] == "moneyline"
                        and (leg["selection"] not in {game["home"] + " ML", game["away"] + " ML"}
                             or (expected_team is not None and leg["selection"] != expected_team + " ML")))):
                reason = "unresolved_leg_game"
                break
            if kickoff <= observed or game.get("status") != "STATUS_SCHEDULED":
                reason = "game_not_open_at_observation"
                break
            ids.append(gid)
        if not card["legs"]:
            reason = "empty_card"
        elif card["scope"] == "week" and len(ids) != len(set(ids)):
            reason = "duplicate_game_in_week_card"
        results.append({"parlay_id": card["parlay_id"], "card_id": card_id(card),
                        "scope": card["scope"], "game_ids": ids if reason is None else [],
                        "offer_sha256": fingerprint(card), "lineage_recorded": "offer_lineage" in card,
                        "pre_kickoff_observed": reason is None, "reason": reason})
    return results


def published_bytes(commit, name, *, checkout=ROOT):
    """Read one exact retained publisher input from trusted Git history."""
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("invalid_published_commit")
    if name not in NAMES:
        raise ValueError("invalid_published_resource")
    try:
        return subprocess.check_output(["git", "-C", str(checkout), "show", f"{commit}:data/{name}"],
                                       stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        raise ValueError("public_parlay_git_commit_unavailable") from None


def observe(origin, published_commit, out_dir):
    origin = base_url(origin)
    if not re.fullmatch(r"[0-9a-f]{40}", published_commit):
        raise ValueError("invalid_published_commit")
    started = _now()
    raw = {name: _get_json(origin, name) for name in NAMES}
    completed = _now()
    if instant(completed) < instant(started):
        raise ValueError("observation_clock_regressed")
    for name, body in raw.items():
        if body != published_bytes(published_commit, name):
            raise ValueError("public_resource_does_not_match_git_" + name)
    objects = {name: sha256(body).hexdigest() for name, body in raw.items()}
    slate, schedule = (json.loads(raw[name]) for name in NAMES)
    cards = classify_offers(slate, schedule, completed)
    out_dir = out_dir.resolve()
    if out_dir == ROOT or out_dir.is_relative_to(ROOT):
        raise ValueError("observation_workspace_must_be_outside_repo")
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = fingerprint({"origin": origin, "objects": objects}).split(":")[1]
    manifest = out_dir / (key + ".json")
    descriptor = os.open(out_dir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        for name, body in raw.items():
            _immutable(out_dir / (objects[name] + ".bin"), body)
        if manifest.exists():
            prior = json.loads(manifest.read_bytes())
            body = {key: value for key, value in prior.items() if key != "observation_id"}
            if (body["origin"] != origin or body["objects_sha256"] != objects
                    or fingerprint(body) != prior["observation_id"]):
                raise ValueError("stored_public_observation_conflict")
            return {**prior, "manifest": str(manifest), "replayed": True}
        body = {"version": 1, "kind": "nfl.public_parlay_observation.v1", "season": slate["season"],
                "week": slate["week"], "origin": origin, "published_commit": published_commit,
                "observed_started_utc": started, "observed_completed_utc": completed,
                "objects_sha256": objects, "cards": cards,
                "pre_kickoff_count_by_scope": dict(Counter(c["scope"] for c in cards if c["pre_kickoff_observed"]))}
        evidence = {**body, "observation_id": fingerprint(body)}
        _immutable(manifest, (json.dumps(evidence, sort_keys=True, indent=2) + "\n").encode())
        return {**evidence, "manifest": str(manifest), "replayed": False}
    finally:
        os.close(descriptor)


def observe_after_publisher(origin, receipt_path, run_id, run_attempt, out_dir, *, sleep=time.sleep):
    """Wait briefly for the proven commit's public bytes, using the live observation clock."""
    commit = publisher_commit(receipt_path, run_id, run_attempt)
    if commit == "noop":
        return {"status": "publisher_no_new_commit", "run_id": run_id, "run_attempt": run_attempt}
    subprocess.run(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", commit, "HEAD"],
                   check=True, capture_output=True)
    for pause in (0, 10, 20, 30):
        if pause:
            sleep(pause)
        try:
            result = observe(origin, commit, out_dir)
            return {**result, "publisher_run_id": run_id, "publisher_run_attempt": run_attempt}
        except ValueError as exc:
            # A concurrent or not-yet-deployed publication must never attach the
            # body to this run. Re-read both files and recheck both Git blobs.
            if not str(exc).startswith("public_resource_does_not_match_git_"):
                raise
            if pause == 30:
                raise
        except OSError:
            if pause == 30:
                raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--published-commit")
    source.add_argument("--publisher-receipt", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--run-attempt")
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.publisher_receipt is not None:
            result = observe_after_publisher(args.origin, args.publisher_receipt, args.run_id,
                                             args.run_attempt, args.out_dir)
        else:
            if args.run_id is not None or args.run_attempt is not None:
                raise ValueError("publisher_run_identity_requires_receipt")
            result = observe(args.origin, args.published_commit, args.out_dir)
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"parlay observation refused: {exc}\n")


if __name__ == "__main__":
    main()
