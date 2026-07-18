"""ADP (average draft position) from FantasyFootballCalculator — keyless.

ADP is DRAFTER consensus (the market of fantasy humans), not sportsbook data.
POLICY BOUNDARY: it is used ONLY to (a) model the simulated opponents in the
draft simulator (real leagues draft near ADP — beating them is the benchmark)
and (b) flag value-vs-ADP in the UI. It is NEVER blended into projections,
weights, or game probabilities — same independence discipline as the market
scoreboard, and the validator's day-zero/market pins are untouched by it.

Endpoint: https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=N&year=Y
(free, keyless, JSON). Loud on non-200 / empty payloads; a failed fetch leaves
any existing data/adp.json untouched (the cron retries daily).
"""

import json
import urllib.parse
import urllib.request

BASE = "https://fantasyfootballcalculator.com/api/v1/adp"
USER_AGENT = "nfl2026-tracker/1.0 (personal-project)"
_HTTP_TIMEOUT = 20


class AdpError(RuntimeError):
    """Loud failure: transport error, non-JSON, or a structurally empty payload."""


def fetch_adp(year, fmt="ppr", teams=12):
    """Raw ADP rows: list[{name, position, team, adp, adp_formatted, ...}].

    Loud when the API returns no players — an empty consensus is an outage,
    not "nobody drafts".
    """
    url = f"{BASE}/{fmt}?" + urllib.parse.urlencode({"teams": teams, "year": year})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            data = json.load(resp)
    except Exception as exc:  # noqa: BLE001 — surfaced as one loud typed error
        raise AdpError(f"ADP GET {url} failed: {exc}") from exc
    players = data.get("players") or []
    if len(players) < 100:
        raise AdpError(f"ADP {fmt}/{teams}/{year} returned {len(players)} players "
                       f"(< 100) — outage or a bad query, not a thin consensus.")
    return players


def norm_name(name):
    """Join key: lowercase letters/spaces, suffixes dropped ("A.J. Brown Jr.")."""
    s = "".join(c for c in str(name or "").lower() if c.isalpha() or c == " ")
    parts = [p for p in s.split() if p not in ("jr", "sr", "ii", "iii", "iv", "v")]
    return " ".join(parts)


def join_to_pool(adp_rows, projection_players):
    """Attach our gsis_id to ADP rows by (normalized name, position family).

    Returns (rows, join_rate): rows are
    {name, position, team, adp, gsis_id|None} sorted by adp asc. Unjoined rows
    are KEPT (the simulator needs the full market board — a rookie we don't
    project still gets drafted by opponents) but carry gsis_id None. Pure.
    """
    ours = {}
    for p in projection_players:
        key = (norm_name(p["name"]), str(p["position"]).upper())
        ours.setdefault(key, str(p["gsis_id"]))
    out, joined = [], 0
    for r in adp_rows:
        pos = str(r.get("position") or "").upper()
        if pos not in ("QB", "RB", "WR", "TE"):
            continue  # K/DST not modeled or rostered — the sim skips them too
        gid = ours.get((norm_name(r.get("name")), pos))
        if gid is not None:
            joined += 1
        out.append({
            "name": r.get("name"),
            "position": pos,
            "team": r.get("team"),
            "adp": float(r.get("adp") or 0.0),
            "gsis_id": gid,
        })
    out.sort(key=lambda x: (x["adp"], x["name"] or ""))
    join_rate = round(joined / len(out), 3) if out else 0.0
    return out, join_rate
