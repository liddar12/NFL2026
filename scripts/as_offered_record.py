"""R130: reconstruct a fixed pre-kickoff curated-card cohort, never its prices.

Git commit evidence is not proof of a public deployment. Original blobs and
settlement records are never modified. The CLI prints JSON; it writes no data.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

# Keep the read-only CLI and package imports on the producer's shared contract.
_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
from scripts.scrape.espn import FINAL_STATUSES  # noqa: E402

POLICY = "git_last_pre_kickoff_v1"
PROP_MARKETS = {"qb_pass_yds", "rb_rush_yds", "wr_rec_yds"}
VOID_REASONS = {"push", "tie", "no_stat_line", "did_not_play"}


def instant(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(dt.timezone.utc) if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def read_git_history(root, ref="HEAD"):
    """One history scan per path and one blob read per revision, never per leg.

    A shallow checkout cannot prove last-before-kickoff history completeness.
    A corrupt/unreadable history is unavailable, not silently an older cohort.
    """
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, text=True,
                                       stderr=subprocess.PIPE, timeout=60).strip()
    try:
        head = git("rev-parse", "--verify", ref + "^{commit}")
        if git("rev-parse", "--is-shallow-repository") != "false":
            return {"status": "unavailable", "reason": "shallow_history", "head": head}
        paths = {"snapshots": "data/parlays.json", "exclusions": "config/excluded_games.json"}
        result = {"status": "available", "head": head}
        for name, path in paths.items():
            rows = []
            for line in git("log", "--format=%H %cI", head, "--", path).splitlines():
                sha, committed = line.split(" ", 1)
                # A deletion is an explicit empty document, not a reason to use an older offer.
                try:
                    document = json.loads(git("show", sha + ":" + path))
                except subprocess.CalledProcessError:
                    document = None
                if instant(committed) is None:
                    raise ValueError("invalid Git committer time")
                rows.append({"sha": sha, "committed_utc": committed,
                             "path": path, "document": document})
            result[name] = rows
        if not result["snapshots"]:
            return {"status": "unavailable", "reason": "no_snapshot_history", "head": head}
        return result
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"status": "unavailable", "reason": "history_unreadable"}


def outcome_counts(cards):
    """Original full wins, reduced successes and refunds are different outcomes."""
    counts = {key: 0 for key in ("full_hits", "reduced_successes", "refunds", "losses", "pending")}
    legs = {"hit": 0, "miss": 0, "void": 0, "pending": 0}
    for card in cards:
        results = [leg.get("result", "pending") for leg in card.get("legs", [])]
        for value in results:
            legs[value if value in legs else "pending"] += 1
        if "miss" in results:
            counts["losses"] += 1
        elif not results or any(value not in ("hit", "void") for value in results):
            counts["pending"] += 1
        elif all(value == "void" for value in results):
            counts["refunds"] += 1
        elif "void" in results:
            counts["reduced_successes"] += 1
        else:
            counts["full_hits"] += 1
    decided = counts["full_hits"] + counts["reduced_successes"] + counts["losses"]
    wins = counts["full_hits"] + counts["reduced_successes"]
    return {**counts, "cards": len(cards), "decided_cards": decided,
            "successful_cards": wins, "success_rate": wins / decided if decided else None,
            "legs": legs, "decided_legs": legs["hit"] + legs["miss"],
            "leg_hit_rate": legs["hit"] / (legs["hit"] + legs["miss"])
            if legs["hit"] + legs["miss"] else None}


def summaries(cards):
    return {"all": outcome_counts(cards), **{
        scope: outcome_counts([c for c in cards if c.get("scope") == scope])
        for scope in ("game", "week")}}


def _key(week, gid, leg):
    return (int(week), str(gid), leg.get("market"), leg.get("selection"))


def grade_context(review, ledger_scores):
    """Conflicting same-contract evidence is quarantined, never last-write-wins."""
    ledger, fallback = defaultdict(list), defaultdict(list)
    for kind in ("resolved", "unresolved"):
        for row in (ledger_scores or {}).get(kind, []):
            if kind == "resolved":
                hit = row.get("hit")
                value = ("hit" if hit else "miss") if type(hit) is bool else "pending"
            else:
                value = "void" if row.get("reason") in VOID_REASONS else "pending"
            ledger[_key(row["week"], row.get("game_id"), row)].append(
                (value, row.get("actual"), row.get("reason")))
    for week, block in (review.get("weeks") or {}).items():
        for card in block.get("parlays", []):
            for leg in card.get("legs", []):
                # Administrative exclusions are not evidence of the on-field outcome.
                if "excluded game" not in str(leg.get("why") or "").lower():
                    fallback[_key(week, leg.get("game_id"), leg)].append(
                        (leg.get("result", "pending"), leg.get("actual"), None))
    return ledger, fallback


def _unique_grade(rows, source):
    grades = {row[0] for row in rows}
    if len(grades) != 1:
        return {"result": "pending", "source": source, "reason": "conflicting_outcomes"}
    # Actual scalar is informational only; never infer a result from missing data.
    return {"result": rows[0][0], "actual": rows[0][1], "source": source,
            "reason": rows[0][2]}


def grade_leg(leg, gid, week, game, ledger, fallback):
    final = (game or {}).get("final") or {}
    if (game or {}).get("status") not in FINAL_STATUSES or not final:
        return {"result": "pending", "source": "final_gate", "reason": "no_final_evidence"}
    market = leg.get("market")
    if market in ("moneyline", "spread"):
        team = str(leg.get("selection") or "").split(" ")[0]
        home, away = game.get("home"), game.get("away")
        if team not in (home, away):
            return {"result": "pending", "source": "review_final", "reason": "team_identity_missing"}
        if market == "moneyline":
            winner = final.get("winner")
            hs, aws = final.get("home_score"), final.get("away_score")
            tie = type(hs) in (int, float) and type(aws) in (int, float) and hs == aws
            if winner not in (home, away) and not tie:
                return {"result": "pending", "source": "review_final", "reason": "winner_missing"}
            return {"result": "void" if winner is None else "hit" if winner == team else "miss",
                    "actual": winner, "source": "review_final", "reason": "tie" if winner is None else None}
        line = leg.get("line")
        if line is None:
            match = re.fullmatch(r"\S+\s+([+-]?\d+(?:\.\d+)?)", str(leg.get("selection") or ""))
            line = float(match.group(1)) if match else None
        hs, aws = final.get("home_score"), final.get("away_score")
        if any(type(v) not in (int, float) or not math.isfinite(v) for v in (hs, aws, line)):
            return {"result": "pending", "source": "review_final", "reason": "score_or_line_missing"}
        margin = (hs - aws if team == home else aws - hs) + line
        return {"result": "hit" if margin > 0 else "miss" if margin < 0 else "void",
                "actual": margin, "source": "review_final", "reason": "push" if margin == 0 else None}
    key = _key(week, gid, leg)
    if market in PROP_MARKETS and ledger.get(key):
        return _unique_grade(ledger[key], "leg_ledger")
    if market in PROP_MARKETS and fallback.get(key):
        return _unique_grade(fallback[key], "review_fallback")
    return {"result": "pending", "source": "unavailable", "reason": "no_matching_outcome"}


def _exclusions(history, exclusions):
    first = {}
    for snapshot in sorted(history.get("exclusions", []), key=lambda x: instant(x["committed_utc"])):
        for row in (snapshot.get("document") or {}).get("games", []):
            first.setdefault(str(row.get("game_id")), snapshot)
    output = {}
    for row in (exclusions or {}).get("games", []):
        gid = str(row.get("game_id"))
        evidence = first.get(gid) or {}
        output[gid] = {"added_utc": row.get("added_utc"),
                       "committed_utc": evidence.get("committed_utc"),
                       "sha": evidence.get("sha"), "reason": row.get("reason")}
    return output


def build_record(review, history, ledger_scores=None, exclusions=None, now=None):
    """Pure reconstruction. Headline counts never fall back to mutable archives."""
    ledger, fallback = grade_context(review, ledger_scores)
    excluded = _exclusions(history, exclusions)
    result = {"policy": POLICY, "history_head": history.get("head"),
              "public_serving_verified": False,
              "note": "Git-committed pre-kickoff cohort, not proof of public serving. "
                      "Game cards use each game's last pre-kickoff blob; Week cards use the first kickoff. "
                      "Headline successes include reduced-leg successes; refunds and pending are excluded. "
                      "On-field outcomes ignore later administrative exclusions; settlement is separate.",
              "weeks": {}}
    for week, block in (review.get("weeks") or {}).items():
        games = {str(g["game_id"]): g for g in block.get("games", [])}
        team_games = defaultdict(set)
        for gid, game in games.items():
            for side in ("home", "away"):
                if game.get(side):
                    team_games[game[side]].add(gid)
        cutoffs = [instant(g.get("kickoff_utc")) for g in games.values()]
        first_kick = min((t for t in cutoffs if t), default=None)
        targets = [("game", gid, instant(g.get("kickoff_utc"))) for gid, g in games.items()]
        targets.append(("week", None, first_kick))
        cards, missing, evidence = [], [], []
        for scope, gid, cutoff in targets:
            reason = history.get("reason") if history.get("status") != "available" else None
            if cutoff is None:
                reason = "missing_kickoff"
            elif now and instant(now) and cutoff > instant(now):
                reason = "awaiting_decision_cutoff"
            eligible = [s for s in history.get("snapshots", [])
                        if cutoff and instant(s.get("committed_utc"))
                        and instant(s["committed_utc"]) < cutoff]
            if not eligible:
                reason = reason or "no_pre_kickoff_blob"
            if reason:
                missing.append({"scope": scope, "game_id": gid, "reason": reason})
                continue
            latest_time = max(instant(s["committed_utc"]) for s in eligible)
            latest = [s for s in eligible if instant(s["committed_utc"]) == latest_time]
            if len({digest(s["document"]) for s in latest}) != 1:
                missing.append({"scope": scope, "game_id": gid, "reason": "conflicting_latest_blobs"})
                continue
            snapshot = min(latest, key=lambda s: s["sha"])
            doc = snapshot.get("document") or {}
            if doc.get("season") != review.get("season") or doc.get("week") != int(week):
                missing.append({"scope": scope, "game_id": gid, "reason": "latest_blob_missing_or_wrong_week"})
                continue
            updated = instant(doc.get("updated_utc"))
            if updated and (updated >= cutoff or updated > latest_time):
                missing.append({"scope": scope, "game_id": gid, "reason": "post_kickoff_document_time"})
                continue
            proof = {"scope": scope, "game_id": gid, "sha": snapshot["sha"],
                     "committed_utc": snapshot["committed_utc"],
                     "cutoff_utc": cutoff.isoformat(), "document_updated_utc": doc.get("updated_utc")}
            chosen = [c for c in doc.get("parlays", []) if c.get("scope") == scope
                      and (scope == "week" or str(c.get("game_id")) == gid)]
            evidence.append({**proof, "offered_cards": len(chosen)})
            for card in chosen:
                graded_legs = []
                unverifiable = False
                for leg in card.get("legs", []):
                    leg_gid = str(leg.get("game_id") or gid or "")
                    if not leg_gid:
                        candidates = team_games[str(leg.get("selection") or "").split(" ")[0]]
                        leg_gid = next(iter(candidates)) if len(candidates) == 1 else ""
                    game = games.get(leg_gid)
                    leg_kick = instant((game or {}).get("kickoff_utc"))
                    if leg_kick is None or latest_time >= leg_kick:
                        unverifiable = True
                    grade = grade_leg(leg, leg_gid, int(week), game, ledger, fallback)
                    ex = excluded.get(leg_gid)
                    if ex:
                        kick = instant((game or {}).get("kickoff_utc"))
                        times = [instant(ex.get(k)) for k in ("added_utc", "committed_utc")]
                        known = [t for t in times if t]
                        grade["exclusion"] = {**ex, "post_kickoff":
                            max(known) >= kick if known and kick else None}
                    graded_legs.append({"market": leg.get("market"), "selection": leg.get("selection"),
                                        "game_id": leg_gid or None, **grade})
                if unverifiable:
                    missing.append({"scope": scope, "game_id": gid,
                                    "parlay_id": card.get("parlay_id"), "reason": "leg_cutoff_not_verified"})
                    continue
                cards.append({"parlay_id": card.get("parlay_id"), "scope": scope,
                              "contract_hash": digest(card), "provenance": proof,
                              "legs": graded_legs})
        status = "available" if not missing else "partial" if cards else "unavailable"
        result["weeks"][str(week)] = {"policy": POLICY, "provenance_status": status,
            "public_serving_verified": False, "summary": summaries(cards), "cards": cards,
            "coverage": {"targets": len(targets), "verified_targets": len(evidence),
                         "missing": missing, "snapshots": evidence},
            "headline": summaries(cards)["all"] if status == "available" else None,
            "settlement": {"provenance": "retrospective_archive", "summary": summaries(block.get("parlays", []))}}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--ref", default="HEAD")
    args = parser.parse_args()
    def read(path):
        return json.loads(subprocess.check_output(["git", "show", args.ref + ":" + path], cwd=args.repo))
    print(json.dumps(build_record(read("data/review.json"), read_git_history(args.repo, args.ref),
                                  read("data/parlay_leg_scores.json"), read("config/excluded_games.json")),
                     indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
