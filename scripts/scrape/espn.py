"""ESPN public-JSON fetchers (schedule / scores / injuries).

ESPN exposes an unauthenticated JSON API (the same one the scoreboard site calls). We
read it directly. `requests` is imported INSIDE each function, guarded — the gate must
run with no pip install.

TWO inherited invariants encoded here:

  1. STATUS-GATING (critical). Only a FINAL game becomes an "actual result" that can
     award points or advance standings. ESPN status types we treat as final:
     STATUS_FINAL, STATUS_FINAL_OVERTIME. Everything else (in-progress, halftime,
     scheduled, postponed, and the 0-0 STATUS_SCHEDULED stubs) is DISPLAY-ONLY and must
     never leak into actuals. `fetch_scores(final_only=True)` returns only gated rows.

  2. LOUD ON ZERO ROWS (the silent-404 lesson). A 200 response with an empty events
     list, or a non-200, raises FeedError rather than returning [] — an empty schedule
     is almost always an outage or a wrong URL, not "no games". Callers must not mask it.
"""

import datetime as _dt

from .renames import normalize_team

# ESPN status.type.name values that mean "this game is over and the score is real".
FINAL_STATUSES = frozenset(["STATUS_FINAL", "STATUS_FINAL_OVERTIME"])

# Base for the public scoreboard/schedule endpoint (NFL).
_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
# Public injuries endpoint (per-team injury report).
_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
# Public teams endpoint (identity: colors, venue, ids).
_TEAMS_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams"

_HTTP_TIMEOUT = 20  # seconds; ESPN is fast, a long hang means trouble — fail, don't wait.


class FeedError(RuntimeError):
    """Raised loudly for a missing dependency, a non-200, or a zero-row payload."""


def _require_requests():
    """Import `requests` on demand with one actionable line. Kept out of module scope
    so the gate can import this file without the package present."""
    try:
        import requests  # noqa: PLC0415 (intentional in-function import)
    except ImportError as exc:  # pragma: no cover - exercised only off the gate
        raise FeedError(
            "requests is not installed. Install it in the pipeline runner only: "
            "`pip install requests`. It must NEVER be a gate dependency."
        ) from exc
    return requests


def _get_json(url, params=None):
    """GET + parse JSON with a loud non-200 policy."""
    requests = _require_requests()
    resp = requests.get(url, params=params or {}, timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise FeedError(
            f"ESPN GET {url} returned HTTP {resp.status_code}. Refusing to treat a "
            f"non-200 as empty data (the silent-404 lesson)."
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise FeedError(f"ESPN GET {url} returned non-JSON body.") from exc


def _competitors(event):
    """Extract (home, away) competitor dicts from an ESPN event, or (None, None)."""
    comps = (event.get("competitions") or [{}])[0].get("competitors") or []
    home = away = None
    for c in comps:
        if c.get("homeAway") == "home":
            home = c
        elif c.get("homeAway") == "away":
            away = c
    return home, away


def _team_abbrev(competitor):
    """Canonical nflverse abbrev for an ESPN competitor, via the RENAMES map. Loud on
    an unmappable team — a drift here silently mis-attributes scores."""
    team = (competitor or {}).get("team") or {}
    raw = team.get("abbreviation") or team.get("displayName")
    abbrev = normalize_team(raw)
    if abbrev is None:
        raise FeedError(
            f"ESPN team '{raw}' did not map to a canonical abbreviation. Update "
            f"scripts/scrape/renames.py (and mirror in JS) before trusting this run."
        )
    return abbrev


def fetch_schedule(season, week=None, seasontype=2):
    """Game schedule for a week (seasontype 2 = regular season).

    Returns list[dict]: {game_id, home, away, kickoff_utc, status}. Loud if zero games.
    kickoff_utc is the walk-forward information cutoff downstream, so it is carried
    verbatim from ESPN's `date` (already ISO-8601 UTC with a trailing Z).
    """
    params = {"seasontype": seasontype, "dates": int(season)}
    if week is not None:
        params["week"] = int(week)
    data = _get_json(_SCOREBOARD_URL, params)
    events = data.get("events") or []
    if not events:
        raise FeedError(
            f"ESPN schedule for season={season} week={week} returned 0 events. That is "
            f"an outage or a wrong query, not an empty week — failing loudly."
        )
    out = []
    for ev in events:
        home, away = _competitors(ev)
        status = (((ev.get("status") or {}).get("type")) or {}).get("name")
        venue = (ev.get("competitions") or [{}])[0].get("venue") or {}
        out.append(
            {
                "game_id": str(ev.get("id")),
                "home": _team_abbrev(home),
                "away": _team_abbrev(away),
                "kickoff_utc": ev.get("date"),  # e.g. "2026-09-10T00:20Z"
                "status": status,
                "venue": venue.get("fullName"),
                # ESPN's `indoor` flag covers domes + closed retractables; we record
                # the binary here and let the stadium table refine retractable/open.
                "roof": "indoor" if venue.get("indoor") else "outdoor",
            }
        )
    return out


def fetch_teams(min_rows=30):
    """Return {canonical_abbrev: {name, location, display, espn_id, color, alt_color}}.

    Colors are ESPN identity hex WITH a leading '#'. `color` is the primary; the app
    lightens it for AA on the dark surface (never used raw as small text). Loud if the
    league doesn't return ~32 teams.
    """
    data = _get_json(_TEAMS_URL)
    rows = (((data.get("sports") or [{}])[0].get("leagues") or [{}])[0].get("teams")) or []
    if len(rows) < min_rows:
        raise FeedError(f"ESPN teams returned {len(rows)} (< {min_rows}) — outage or bad shape.")
    out = {}
    for r in rows:
        t = r.get("team") or {}
        raw = t.get("abbreviation")
        ab = normalize_team(raw)
        if ab is None:
            raise FeedError(f"ESPN team '{raw}' unmapped — update renames.py before trusting this run.")
        out[ab] = {
            "name": t.get("nickname") or t.get("name"),
            "location": t.get("location"),
            "display": t.get("displayName"),
            "espn_id": t.get("id"),
            "color": ("#" + t["color"]) if t.get("color") else None,
            "alt_color": ("#" + t["alternateColor"]) if t.get("alternateColor") else None,
        }
    return out


def fetch_season_schedule(season, weeks=range(1, 19), seasontype=2):
    """Full regular-season schedule for `season`, each row tagged with its `week`.
    Asserts a sane total (a full NFL regular season is 272 games)."""
    games = []
    for wk in weeks:
        for g in fetch_schedule(season, week=wk, seasontype=seasontype):
            g["week"] = wk
            games.append(g)
    if len(games) < 200:
        raise FeedError(f"season {season} schedule: only {len(games)} games (expected ~272).")
    return games


def fetch_final_results(season, weeks=range(1, 19), seasontype=2):
    """All FINAL games from `season` (STATUS-gated) with integer scores — the input to
    Elo priors. A future season with nothing played yet legitimately returns []."""
    finals = []
    for wk in weeks:
        for g in fetch_scores(season, week=wk, seasontype=seasontype, final_only=True):
            g["week"] = wk
            finals.append(g)
    return finals


def fetch_scores(season, week=None, seasontype=2, final_only=True):
    """Scores for a week. STATUS-GATED.

    With `final_only=True` (default) ONLY final games are returned, each carrying an
    integer home/away score — these are the rows eligible to become actuals. With
    `final_only=False` every game is returned with a `final` boolean and a `status`, for
    display purposes only. Non-final rows must NEVER be written into actuals.

    Loud if the schedule query itself returns zero games. A week with real games but
    none yet final legitimately returns [] under final_only=True — that is not an error
    (the games simply haven't happened), so we only assert on the raw event count.

    Rows also carry OPTIONAL venue identity (venue / venue_city / venue_country, each
    possibly None) — added backward-compatibly for the environment model, which needs
    `venue_country != 'USA'` to spot international games and the city to confirm a
    "home" game was really played at the home stadium. Existing consumers ignore them.
    """
    params = {"seasontype": seasontype, "dates": int(season)}
    if week is not None:
        params["week"] = int(week)
    data = _get_json(_SCOREBOARD_URL, params)
    events = data.get("events") or []
    if not events:
        raise FeedError(
            f"ESPN scores for season={season} week={week} returned 0 events — outage or "
            f"bad query, not an empty week."
        )
    out = []
    for ev in events:
        status = (((ev.get("status") or {}).get("type")) or {}).get("name")
        is_final = status in FINAL_STATUSES
        if final_only and not is_final:
            # Display-only / not-yet-played: excluded from the actuals-eligible set.
            continue
        home, away = _competitors(ev)
        venue = (ev.get("competitions") or [{}])[0].get("venue") or {}
        address = venue.get("address") or {}
        row = {
            "game_id": str(ev.get("id")),
            "home": _team_abbrev(home),
            "away": _team_abbrev(away),
            "kickoff_utc": ev.get("date"),
            "status": status,
            "final": is_final,
            # Optional venue identity (None-safe): see docstring.
            "venue": venue.get("fullName"),
            "venue_city": address.get("city"),
            "venue_country": address.get("country"),
        }
        # Scores are only trustworthy on final games; parse them for final rows.
        if is_final:
            row["home_score"] = _to_int((home or {}).get("score"))
            row["away_score"] = _to_int((away or {}).get("score"))
        out.append(row)
    return out


def fetch_injuries(min_rows=1):
    """Per-team injury reports. Returns list[dict]:
    {team, player, status, detail}. Loud if the payload is structurally empty.

    `status` is ESPN's designation (Out/Doubtful/Questionable/...) consumed by the
    `injury_status` signal; the mapping to a discount lives in the signal, not here.
    """
    data = _get_json(_INJURIES_URL)
    groups = data.get("injuries") or []
    if not groups:
        raise FeedError(
            "ESPN injuries endpoint returned 0 team groups — outage, not 'nobody hurt'."
        )
    out = []
    for grp in groups:
        team = normalize_team((grp.get("team") or {}).get("abbreviation") or grp.get("displayName"))
        for item in grp.get("injuries") or []:
            athlete = item.get("athlete") or {}
            out.append(
                {
                    "team": team,
                    "player": athlete.get("displayName"),
                    "status": (item.get("status") or item.get("type") or {}).get("name")
                    if isinstance(item.get("status"), dict)
                    else item.get("status"),
                    "detail": item.get("longComment") or item.get("shortComment"),
                }
            )
    if len(out) < min_rows:
        raise FeedError(
            f"ESPN injuries produced {len(out)} rows (< {min_rows}); treating as an "
            f"outage rather than an empty (and therefore misleading) injury report."
        )
    return out


def _to_int(value):
    """Coerce an ESPN score string to int; None-safe. Returns None if not parseable."""
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def utc_now_iso():
    """ISO-8601 UTC 'now' with a trailing Z. Not used in gated logic — convenience for
    stamping a scrape run."""
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
