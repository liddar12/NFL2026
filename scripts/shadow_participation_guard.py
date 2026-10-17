"""Pure diagnostic only: a known FINAL DNP is not verified next-game exclusion.

No complete prior-game inventory or genuine primary clearance profile currently
exists in this repository. ALL decisions therefore remain held_unknown with
shadow_signal null and weight zero, including direct observed true DNP flags.
No player medical status, projection, eligibility, receipt or model is mutated.
"""
from scripts import capture_outcome_evidence as outcomes, capture_final_participation as participation
from scripts.scrape.renames import normalize_team

FLAGS = {"weight": 0, "serving_changed": False, "eligibility_changed": False,
         "projection_changed": False, "medical_inference": False, "played_inferred": False,
         "source_authority_authenticated": False, "previous_game_inventory_verified": False,
         "clearance_authority_verified": False, "model_adoption": False, "working_learning_loop": False}
CONTEXT_KEYS = {"version", "kind", "season", "week", "espn_id", "team", "decision_utc", "target_game_id",
                "kickoff_utc", "context_id"}


def evaluate(outcome_history, final_roster_captures, decision_context, *, clearance=None):
    """Validate exact supplied raw evidence, but do not invent inventory authority.

    Context is an integrity-bound caller claim, not an authenticated roster or
    calendar authority. `clearance` deliberately cannot activate a future policy:
    no supported raw primary clearance profile exists. Unknown remains unknown.
    """
    result = {"version": 1, "kind": "nfl.participation_shadow_decision.v1", "status": "held_unknown",
              "shadow_signal": None, "reason": "participation_evidence_unavailable", "direct_dnp_observed": None,
              "known_final_game_id": None, "capture_id": None, "context_id": None,
              "provider_coverage": "unknown", "profile_status": participation.PROFILE_STATUS,
              "clearance_status": "unsupported_unknown", "provider_issued_utc": None,
              "game_finish_utc": None, "diagnostic": None, **FLAGS}
    try:
        participation.need(type(final_roster_captures) in (list, tuple) and len(final_roster_captures) <= 18)
        context = decision_context
        participation._metadata(context)
        participation.need(type(context) is dict and set(context) == CONTEXT_KEYS
             and type(context["version"]) is int and context["version"] == 1
             and context["kind"] == "nfl.participation_decision_context.v1")
        participation._integer(context["season"], 2000, 2100);participation._integer(context["week"], 1, 18)
        participation._id(context["espn_id"]);participation._id(context["target_game_id"])
        participation.need(type(context["team"]) is str and 2 <= len(context["team"]) <= 3
             and normalize_team(context["team"]) == context["team"])
        participation.need(all(type(context[k]) is str and len(context[k]) <= 64 for k in ("decision_utc", "kickoff_utc"))
             and type(context["context_id"]) is str and participation.HASH.fullmatch(context["context_id"])
             and context["context_id"] == participation.fingerprint({k:v for k,v in context.items()if k!="context_id"}))
        decision, kickoff = participation.instant(context["decision_utc"]), participation.instant(context["kickoff_utc"])
        participation.need(decision < kickoff)
        result["context_id"] = context["context_id"]
        total = 0
        for bundle in [outcome_history, *final_roster_captures]:
            participation.need(type(bundle) is dict and all(type(k) is str for k in bundle)
                 and set(bundle) == {"manifest", "observations", "raw_objects"}
                 and type(bundle["raw_objects"]) is dict and len(bundle["raw_objects"]) <= 64
                 and all(type(k) is str and participation.HASH.fullmatch(k) for k in bundle["raw_objects"]))
            participation._metadata(bundle["manifest"]);participation._metadata(bundle["observations"])
            for raw in bundle["raw_objects"].values():
                participation.need(type(raw) is bytes and len(raw) <= 16 * 1024 * 1024)
                total += len(raw);participation.need(total <= participation.MAX_TOTAL, "participation_work_limit")
        outcomes.verify_capture(outcome_history)
        participation.need(outcome_history["manifest"]["season"] == context["season"])
        rows = outcomes.scoreboard_rows(outcome_history)
        target = [row for row in rows if row["game_id"] == context["target_game_id"]]
        participation.need(len(target) == 1 and target[0]["week"] == context["week"]
             and context["team"] in (target[0]["home"], target[0]["away"])
             and participation.instant(target[0]["kickoff_utc"]) == kickoff
             and participation.instant(target[0]["observed_utc"]) <= decision
             and target[0]["status"] == "STATUS_SCHEDULED" and not target[0]["final"], "target_game_not_verified")
        final = [row for row in rows if row["final"] and row["game_id"] != context["target_game_id"]
                 and context["team"] in (row["home"], row["away"])
                 and row["week"] <= context["week"] and participation.instant(row["kickoff_utc"]) < decision
                 and participation.instant(row["observed_utc"]) <= decision]
        if not final:return {**result, "reason": "no_prior_known_final"}
        final.sort(key=lambda row: participation.instant(row["kickoff_utc"]))
        selected = final[-1]
        participation.need(sum(participation.instant(row["kickoff_utc"]) == participation.instant(selected["kickoff_utc"])
                               for row in final) == 1, "ambiguous_prior_known_final")
        result["known_final_game_id"] = selected["game_id"]
        by_game = {}
        for bundle in final_roster_captures:
            participation.verify_capture(bundle)
            manifest = bundle["manifest"]
            participation.need(manifest["game_id"] not in by_game, "duplicate_roster_capture")
            by_game[manifest["game_id"]] = bundle
        # Never search older games for a DNP after finding a newer known FINAL.
        if selected["game_id"] not in by_game:return {**result, "reason": "latest_known_final_roster_missing"}
        bundle = by_game[selected["game_id"]]
        manifest = bundle["manifest"]
        participation.need(manifest["season"] == context["season"] and manifest["week"] == selected["week"]
             and participation.instant(manifest["completed_utc"]) <= decision, "participation_after_decision")
        observed = participation.explicit_dnp(bundle, context["espn_id"], context["team"])
        participation.need(all(observed["game"][k] == selected[k] for k in ("game_id", "season", "week", "home", "away"))
             and participation.instant(observed["game"]["kickoff_utc"]) == participation.instant(selected["kickoff_utc"]),
             "participation_game_identity_mismatch")
        return {**result, "reason": "previous_game_inventory_and_clearance_unverified",
                "direct_dnp_observed": observed["explicit_dnp"], "capture_id": manifest["capture_id"], "diagnostic": observed}
    except Exception:
        # Input schemas, parser/custom-type failures or unsupported clearances
        # cannot leak supplied text or manufacture a complete guard decision.
        return {**result, "reason": "participation_shadow_refused"}
