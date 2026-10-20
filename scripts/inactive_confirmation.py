#!/usr/bin/env python3
"""Official inactive confirmation and T-90 withholding for MY player props.

Lean pilot, checkpoint 1. Pure policy: no IO, no network, no serving write.
Nothing here is wired into the pipeline or the app; the pilot stays disabled
(config/selflearning_pilot.json enabled=false) and production is unchanged.

Per player, per game, at a given clock:

  provisional         before T-90 (kickoff - 90 min): props may be offered,
                      labelled provisional (the existing injury/depth gates
                      still apply upstream).
  confirmed_active    in [T-90, kickoff): a VALID official list for the
                      player's team names him among the game-day ACTIVES.
  confirmed_inactive  in [T-90, kickoff): a valid official list names him
                      among the INACTIVES.
  unknown_or_stale    in [T-90, kickoff) without valid, fresh, unambiguous
                      evidence -- the default. An empty, failed, expired,
                      unregistered or contradictory feed lands here.
  closed              at or after kickoff: no new offers.

Only provisional and confirmed_active rungs may be offered. Withholding at T-90
is automatic; only a valid confirmation restores a prop, and only while its
lease (15 min from the fetch) holds.

What counts as VALID evidence (validate_evidence) -- each rule is a refusal
reason a test names:
  * its source profile is REGISTERED (OFFICIAL_SOURCES). The ESPN core roster
    `didNotPlay` flags are NOT registered: on 2026-10-19, ~14 h before WAS@SF,
    ESPN already marked 7 players per team didNotPlay while omitting Deebo
    Samuel (reported OUT), and its roster shape carries no posting flag or
    time (docs/pilot/espn_inactive_probe_20261019.json). It is an observation,
    never confirmation. No official source is registered yet, so in production
    every player in the T-90 window is unknown_or_stale -> withheld;
  * exact game identity (game_id, home, away, literal kickoff_utc) and a team
    that plays in it;
  * posted and fetched inside the window [T-90, kickoff), fetched no later
    than the check, and the lease (fetched_utc + 15 min) unexpired;
  * an explicit complete list: complete is exactly True, a NON-EMPTY inactive
    list (an NFL club always declares inactives; empty is a failed or
    unposted read, never "nobody is out") and a non-empty active list;
  * ids: canonical numeric strings, unique, and the two lists disjoint;
  * a raw evidence digest (sha256 hex) so the decision binds retained bytes.
Two valid lists for one team that disagree about a player leave that player
unknown_or_stale (conflict), never a guess.
"""
import datetime as dt
import hashlib
import json
import re

PROFILE = "confirmed_inactives_v1"
PARAMETERS = {
    "version": 1,
    "recheck_seconds_before_kickoff": 90 * 60,      # T-90 (#175 PROFILES)
    "evidence_lease_seconds": 15 * 60,              # #175 inactive_observation_max_seconds
}
POLICY_ID = "sha256:" + hashlib.sha256(json.dumps(
    {"profile": PROFILE, **PARAMETERS}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

# Registered OFFICIAL inactive sources. Empty on purpose: no source in the
# pipeline today establishes official posting/completeness. Registering one is
# an owner decision (see docs/pilot/LEAN_PILOT_HANDOFF.md).
OFFICIAL_SOURCES = frozenset()
# Recorded for the audit trail; never confirms.
OBSERVATION_ONLY_SOURCES = frozenset({"espn_core_roster_didnotplay_v1"})

OFFERABLE = frozenset({"provisional", "confirmed_active"})
STATES = ("provisional", "confirmed_active", "confirmed_inactive", "unknown_or_stale", "closed")
_ID = re.compile(r"[0-9]+")
_HEX = re.compile(r"[0-9a-f]{64}")


def parse_utc(value):
    """A strict UTC instant ('...Z', minutes or seconds), else None."""
    if type(value) is not str:
        return None
    for fmt in ("%Y-%m-%dT%H:%MZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return dt.datetime.strptime(value, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def checkpoint(game):
    kick = parse_utc(game.get("kickoff_utc")) if type(game) is dict else None
    return None if kick is None else kick - dt.timedelta(seconds=PARAMETERS["recheck_seconds_before_kickoff"])


def _ids(values):
    if type(values) is not list:
        return None
    out = []
    for v in values:
        if type(v) is not str or not _ID.fullmatch(v):
            return None
        out.append(v)
    return out if len(out) == len(set(out)) else None


def validate_evidence(ev, game, now, registry=OFFICIAL_SOURCES):
    """(True, None) for usable confirmation evidence, else (False, reason)."""
    if type(ev) is not dict:
        return False, "evidence_malformed"
    profile = ev.get("source_profile")
    if type(profile) is not str:
        return False, "source_profile_malformed"
    # Observation-only profiles never confirm, whatever registry a caller
    # passes and however complete the record looks (Codex review of #184).
    if profile in OBSERVATION_ONLY_SOURCES:
        return False, "observation_only_source"
    if profile not in registry:
        return False, "unregistered_source"
    for key in ("game_id", "home", "away", "kickoff_utc"):
        if type(ev.get(key)) is not str or ev.get(key) != game.get(key):
            return False, "game_identity_mismatch"
    if ev.get("team") not in (game.get("home"), game.get("away")):
        return False, "team_not_in_game"
    kick, check = parse_utc(game.get("kickoff_utc")), checkpoint(game)
    posted, fetched = parse_utc(ev.get("posted_utc")), parse_utc(ev.get("fetched_utc"))
    if kick is None or posted is None or fetched is None:
        return False, "clock_malformed"
    if not (check <= posted <= fetched < kick):
        return False, "outside_window"
    if fetched > now:
        return False, "future_evidence"
    if (now - fetched).total_seconds() > PARAMETERS["evidence_lease_seconds"]:
        return False, "lease_expired"
    if ev.get("complete") is not True:
        return False, "incomplete_list"
    inactive, active = _ids(ev.get("inactive_ids")), _ids(ev.get("active_ids"))
    if inactive is None or active is None:
        return False, "ids_malformed"
    if not inactive or not active:
        return False, "empty_list"
    if set(inactive) & set(active):
        return False, "lists_overlap"
    if type(ev.get("raw_sha256")) is not str or not _HEX.fullmatch(ev["raw_sha256"]):
        return False, "raw_evidence_missing"
    return True, None


def player_state(espn_id, team, game, now, evidence, registry=OFFICIAL_SOURCES):
    """(state, reason) for one player at `now`; `evidence` is every record seen
    for this game (any team, valid or not). Pure."""
    if type(game) is not dict:
        return "unknown_or_stale", "game_malformed"
    kick, check = parse_utc(game.get("kickoff_utc")), checkpoint(game)
    if kick is None:
        return "unknown_or_stale", "kickoff_unknown"
    if now >= kick:
        return "closed", "kicked_off"
    if now < check:
        return "provisional", "before_checkpoint"
    if team not in (game.get("home"), game.get("away")):
        return "unknown_or_stale", "team_not_in_game"
    verdicts, refusals = set(), []
    for ev in evidence or []:
        if type(ev) is not dict or ev.get("team") != team:
            continue
        ok, reason = validate_evidence(ev, game, now, registry)
        if not ok:
            refusals.append(reason)
            continue
        if espn_id in ev["inactive_ids"]:
            verdicts.add("confirmed_inactive")
        elif espn_id in ev["active_ids"]:
            verdicts.add("confirmed_active")
        else:
            verdicts.add("not_listed")
    if len(verdicts) > 1:
        return "unknown_or_stale", "conflicting_evidence"
    if verdicts == {"confirmed_inactive"}:
        return "confirmed_inactive", "official_inactive"
    if verdicts == {"confirmed_active"}:
        return "confirmed_active", "official_active"
    if verdicts == {"not_listed"}:
        return "unknown_or_stale", "not_on_official_lists"
    return "unknown_or_stale", (sorted(set(refusals))[0] if refusals else "no_evidence")


def assess(pool, games, now, evidence_by_game, registry=OFFICIAL_SOURCES):
    """Shadow assessment of a leg pool: every MY prop rung's state at `now`.

    `pool` is data/leg_pool.json-shaped ({players:[{gsis_id, team, game_id,
    rungs:[...]}]}); `games` the week's schedule rows. Returns a document with
    per-game checkpoints and per-player states, and the rung counts it would
    withhold. It does NOT modify the pool."""
    games = [g for g in (games or []) if type(g) is dict]
    by_game = {str(g.get("game_id")): g for g in games}
    evidence_by_game = evidence_by_game if type(evidence_by_game) is dict else {}
    players, counts = [], {s: 0 for s in STATES}
    withheld = offered = malformed = 0
    for p in (pool or {}).get("players") or []:
        if type(p) is not dict:
            malformed += 1          # reported, never fatal to the other players
            continue
        gid = str(p.get("game_id"))
        game = by_game.get(gid)
        pid = str(p.get("gsis_id") or "")
        espn_id = pid[5:] if pid.startswith("espn-") and _ID.fullmatch(pid[5:]) else ""
        if game is None:
            state, reason = "unknown_or_stale", "game_unknown"
        else:
            ev = evidence_by_game.get(gid)
            state, reason = player_state(espn_id, p.get("team"), game, now,
                                         ev if type(ev) is list else [], registry)
            # an id-less player can never be found on an official list
            if not espn_id and state == "unknown_or_stale" and reason != "kickoff_unknown":
                reason = "player_id_not_espn"
        counts[state] += 1
        rungs = p.get("rungs")
        n = len(rungs) if type(rungs) is list else 0
        if state in OFFERABLE:
            offered += n
        else:
            withheld += n
        players.append({"gsis_id": pid, "game_id": gid, "team": p.get("team"),
                        "state": state, "reason": reason})
    return {
        "version": 1, "kind": "nfl.inactive_confirmation_assessment.v1",
        "profile": PROFILE, "policy_id": POLICY_ID, **{"parameters": PARAMETERS},
        "checked_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "registered_official_sources": sorted(registry),
        "games": [{"game_id": str(g.get("game_id")), "kickoff_utc": g.get("kickoff_utc"),
                   "checkpoint_utc": checkpoint(g).strftime("%Y-%m-%dT%H:%M:%SZ") if checkpoint(g) else None}
                  for g in games],
        "players": players, "state_counts": counts, "malformed_players": malformed,
        "rungs": {"offered": offered, "withheld": withheld},
        "serving_applied": False,
    }


def withhold(pool, assessment):
    """The pool a pilot would serve: rungs of non-offerable players removed.
    Returns a new document; the input is not mutated. Not called in production."""
    keep = {(p["gsis_id"], p["game_id"]) for p in assessment["players"] if p["state"] in OFFERABLE}
    out = dict(pool)
    out["players"] = [p for p in pool.get("players") or []
                      if type(p) is dict and (str(p.get("gsis_id") or ""), str(p.get("game_id"))) in keep]
    return out


def espn_observations(inactives_doc):
    """Map data/inactives.json games to OBSERVATION-only evidence records (one
    per team). Kept for the audit trail; validate_evidence always refuses them."""
    out = {}
    for g in (inactives_doc or {}).get("games") or []:
        if type(g) is not dict or type(g.get("inactive")) is not dict:
            continue
        for team, rows in g["inactive"].items():
            out.setdefault(str(g.get("game_id")), []).append({
                "source_profile": "espn_core_roster_didnotplay_v1",
                "game_id": str(g.get("game_id")), "home": g.get("home"), "away": g.get("away"),
                "kickoff_utc": g.get("kickoff_utc"), "team": team,
                "fetched_utc": g.get("fetched_utc"),
                "inactive_ids": [str(r.get("espn_id")) for r in rows or [] if type(r) is dict],
            })
    return out
