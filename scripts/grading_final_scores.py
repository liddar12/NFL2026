"""Derive a grading generation's scores from frozen ESPN observations."""

from urllib.parse import urlsplit

from scripts.scrape.espn import FINAL_STATUSES
from scripts.scrape.renames import normalize_team
from scripts.scrape import scoreboard_evidence as evidence


def scoreboard_sources(season, weeks):
    return {f"scoreboard_week_{week:02d}.json": {
        "season": season, "week": week, "source_url": evidence.regular_week_url(season, week)}
        for week in weeks}


def is_scoreboard_url(url):
    return urlsplit(url).hostname == "site.api.espn.com"


def fixture_snapshot(schedule, previous, season, started_utc):
    """Pin schedule identity and candidates for historically verified finals."""
    if (type(schedule.get("season")) is not int or schedule["season"] != season
            or not isinstance(schedule.get("games"), list)):
        raise ValueError("schedule does not identify the capture season")
    fixtures = {}
    for game in schedule["games"]:
        gid, week = str(game.get("game_id") or ""), game.get("week")
        home, away = normalize_team(game.get("home")), normalize_team(game.get("away"))
        kickoff = game.get("kickoff_utc")
        if (not gid or type(week) is not int or not 1 <= week <= 18 or not home
                or not away or home == away or game.get("season", season) != season):
            raise ValueError(f"invalid schedule identity for game {gid!r}")
        evidence.instant(kickoff)
        row = {"season": season, "game_id": gid, "week": week, "home": home,
               "away": away, "kickoff_utc": kickoff}
        if fixtures.setdefault(gid, row) != row:
            raise ValueError(f"conflicting schedule identity for game {gid}")
    start = evidence.instant(started_utc)
    weeks = sorted({g["week"] for g in fixtures.values() if evidence.instant(g["kickoff_utc"]) <= start})
    prior, conflicts = {}, set()
    if previous and previous.get("season") == season:
        for week, block in (previous.get("weeks") or {}).items():
            for game in block.get("games") or []:
                gid = str(game.get("game_id") or "")
                fixture = fixtures.get(gid)
                final = game.get("final") or {}
                status = game.get("status")
                hs, away = final.get("home_score"), final.get("away_score")
                if (fixture is None or str(fixture["week"]) != str(week)
                        or normalize_team(game.get("home")) != fixture["home"]
                        or normalize_team(game.get("away")) != fixture["away"]
                        or game.get("season", season) != season
                        or game.get("final_source") != "espn_final" or status not in FINAL_STATUSES
                        or type(hs) is not int or type(away) is not int or min(hs, away) < 0
                        or evidence.instant(fixture["kickoff_utc"]) > start):
                    continue
                try:
                    same_kickoff = evidence.instant(game.get("kickoff_utc")) == evidence.instant(
                        fixture["kickoff_utc"])
                except evidence.CaptureError:
                    continue
                if not same_kickoff:
                    continue
                row = {"status": status, "home_score": hs, "away_score": away}
                if prior.setdefault(gid, row) != row:
                    conflicts.add(gid)
    return {"fixtures": fixtures, "weeks": weeks, "prior": {
        gid: row for gid, row in prior.items() if gid not in conflicts},
        "prior_review_utc": (previous or {}).get("generated_utc")}


def derive_finals(snapshot, specs, entries, contents):
    """Return verified score rows, giving explicit captured statuses precedence."""
    fixtures = snapshot["fixtures"]
    prior = snapshot["prior"]
    by_sides = {(row["week"], row["home"], row["away"]): gid for gid, row in fixtures.items()}
    seen, conflicts, unfinished, finals, statuses, coverage = set(), set(), set(), {}, {}, []
    for name, spec in specs.items():
        entry = entries[name]
        week = spec["week"]
        observed = entry["source_utc"]
        rows, quarantined = [], []
        if entry["status"] == "captured":
            rows, audit = evidence.parse(contents[name], spec, observed, allow_empty=True)
            quarantined = audit["quarantined_game_ids"]
        conflicts.update(quarantined)
        observed_ids, nonfinal, mismatched = set(), set(), set()
        for row in rows:
            gid = row["game_id"]
            fixture = fixtures.get(gid)
            if gid in seen:
                conflicts.add(gid)
            seen.add(gid)
            if (fixture is None or any(row[key] != fixture[key] for key in ("week", "home", "away"))
                    or evidence.instant(row["kickoff_utc"]) != evidence.instant(fixture["kickoff_utc"])):
                mismatched.add(gid)
                alternate = by_sides.get((week, row["home"], row["away"]))
                if alternate:
                    mismatched.add(alternate)
                continue
            observed_ids.add(gid)
            statuses[gid] = row["status"]
            if row["final"]:
                finals[gid] = {**row, "observed_utc": observed, "raw_sha256": entry["sha256"],
                               "grading_source": "espn_scoreboard"}
            else:
                nonfinal.add(gid)
                unfinished.add(gid)
        conflicts.update(mismatched)
        expected = {gid for gid, fixture in fixtures.items() if fixture["week"] == week}
        unknown = expected - observed_ids
        coverage.append({
            "week": week, "observed_utc": observed, "http_status": entry["http_status"],
            "observed_games": len(observed_ids), "nonfinal_games": len(nonfinal),
            "unknown_games": len(unknown), "unknown_game_ids": sorted(unknown),
            "conflicting_game_ids": sorted(set(quarantined) | mismatched),
            "raw_sha256": entry["sha256"],
        })
    blocked = conflicts | unfinished
    contradicted = prior.keys() & blocked
    if contradicted:
        raise ValueError("captured scoreboard contradicts previously verified FINAL identity or status: "
                         + ", ".join(sorted(contradicted)))
    finals = {gid: row for gid, row in finals.items() if gid not in blocked}
    retained = prior.keys() - finals.keys()
    for gid in retained:
        finals[gid] = {**fixtures[gid], **prior[gid], "final": True, "observed_utc": None,
                       "final_utc": None, "upstream_updated_utc": None,
                       "grading_source": "verified_prior_review",
                       "prior_review_utc": snapshot["prior_review_utc"]}
    coherent = {gid: status for gid, status in statuses.items() if gid not in conflicts}
    return [finals[gid] for gid in sorted(finals)], coherent, coverage, len(retained)
