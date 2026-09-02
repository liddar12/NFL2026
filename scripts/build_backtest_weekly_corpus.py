"""Refresh the WEEKLY backtest fixtures from nflverse release assets (runner only).

Writes, in exactly the committed formats:
  data/fixtures/backtest_weekly/weekly_actuals.json
      players{pid: {name, pos, seasons{season{week: [team, opp, pts_ppr,
      pass_yds, rush_yds, rec_yds]}}}} — REG only, QB/RB/WR/TE, a player kept
      for a season only when his PPR points that season reach MIN_PPR.
  data/fixtures/backtest_weekly/games_meta.json
      games rows (see GAMES_FIELDS) — REG only, seasons >= GAMES_FROM, played
      games only (a row without both scores is absent, not zero, and counted).

Sources (release assets, CSV):
  stats  https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_{season}.csv
         (the `stats_player` release tag is tried second — scripts/build_dvp_positional.py fetches from it)
  games  https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv

MARKET BOUNDARY: games.csv's spread_line / moneylines ARE carried into
games_meta — as the measurement yardstick and the handicap a cover leg is
evaluated at (the fixture's own policy text) — and NEVER as a projection input.
This builder is the only place they are read.

`requests` when importable, else urllib. Every fetch is LOUD on a non-200 or an
empty body: a hole is never written as an empty season. `--selftest` parses tiny
inline CSV text offline and round-trips the documents through a temp dir.
Stdlib only apart from the optional requests.
"""

import argparse
import csv
import io
import json
import os
import sys
import tempfile
import urllib.request

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts import build_weekly as bw   # noqa: E402  (norm_team / TEAM_RENAMES)

OUT_DIR = os.path.join(_ROOT, "data", "fixtures", "backtest_weekly")
ACTUALS_NAME = "weekly_actuals.json"
GAMES_NAME = "games_meta.json"

RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
STATS_URLS = (RELEASE_BASE + "/player_stats/stats_player_week_{season}.csv",
              RELEASE_BASE + "/stats_player/stats_player_week_{season}.csv")
GAMES_URL = RELEASE_BASE + "/schedules/games.csv"
HTTP_TIMEOUT = 180

POSITIONS = ("QB", "RB", "WR", "TE")
MIN_PPR = 20.0
GAMES_FROM = 2019
DEFAULT_SEASONS = (2022, 2023, 2024, 2025)

# The fixture texts, verbatim (the harness and its tests read them as-is).
ACTUALS_SOURCE = ("nflverse stats_player_week_{season}.csv (REG only), QB/RB/WR/TE "
                  "with >=20 PPR points in the season")
ACTUALS_FIELDS = ["team", "opp", "pts_ppr", "pass_yds", "rush_yds", "rec_yds"]
ACTUALS_POLICY = ("BACKTEST FIXTURE ONLY — resolved actuals for the weekly and "
                  "parlay never-regress gates; never a projection input. Refreshed by "
                  "scripts/build_backtest_weekly_corpus.py on the runner.")
GAMES_SOURCE = "nflverse games.csv (REG, {first}-{last})"
GAMES_FIELDS = ["season", "week", "home", "away", "home_score", "away_score",
                "kickoff_local_et", "roof", "temp_f", "wind_mph", "spread_line_home",
                "home_ml", "away_ml", "home_rest", "away_rest", "neutral", "stadium",
                "weekday"]
GAMES_POLICY = ("BACKTEST FIXTURE ONLY. spread_line_home/home_ml/away_ml are the BOOK'S "
                "numbers: a MEASUREMENT YARDSTICK and the handicap a cover leg is "
                "evaluated at — never a projection input (owner policy). Refreshed "
                "by scripts/build_backtest_weekly_corpus.py on the runner.")

# Column names, with the alternates nflverse has used across release formats.
STATS_COLUMNS = {
    "pid": ("player_id",),
    "name": ("player_display_name", "player_name"),
    "pos": ("position",),
    "team": ("team", "recent_team"),
    "opp": ("opponent_team",),
    "week": ("week",),
    "season": ("season",),
    "season_type": ("season_type",),
    "pts_ppr": ("fantasy_points_ppr",),
    "pass_yds": ("passing_yards",),
    "rush_yds": ("rushing_yards",),
    "rec_yds": ("receiving_yards",),
}
GAMES_COLUMNS = ("season", "game_type", "week", "gameday", "weekday", "gametime",
                 "away_team", "away_score", "home_team", "home_score", "location",
                 "away_rest", "home_rest", "away_moneyline", "home_moneyline",
                 "spread_line", "roof", "temp", "wind", "stadium")


class CorpusError(RuntimeError):
    """Loud, never masked: a fetch or a header the builder cannot trust."""


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_text(url, timeout=HTTP_TIMEOUT):
    """GET one asset as text. requests if importable, else urllib. Raises
    CorpusError on any transport failure, a non-200, or an empty body."""
    try:
        import requests                                    # noqa: PLC0415
    except ImportError:
        requests = None
    try:
        if requests is not None:
            resp = requests.get(url, timeout=timeout)
            if resp.status_code != 200:
                raise CorpusError("GET %s returned HTTP %s" % (url, resp.status_code))
            raw = resp.content
        else:
            with urllib.request.urlopen(url, timeout=timeout) as resp:
                if resp.status != 200:
                    raise CorpusError("GET %s returned HTTP %s" % (url, resp.status))
                raw = resp.read()
    except CorpusError:
        raise
    except Exception as exc:                               # noqa: BLE001
        raise CorpusError("GET %s failed in transport: %s" % (url, exc)) from exc
    if not raw:
        raise CorpusError("GET %s returned 0 bytes" % url)
    return raw.decode("utf-8", errors="replace")


def fetch_stats(season, urls=STATS_URLS):
    """The season's stats CSV text from the first release tag that serves it;
    every failure is reported when none does."""
    errors = []
    for tpl in urls:
        url = tpl.format(season=int(season))
        try:
            return fetch_text(url)
        except CorpusError as exc:
            errors.append(str(exc))
            print("[warn] %s" % exc, file=sys.stderr)
    raise CorpusError("stats_player_week_%d unavailable from every release tag: %s"
                      % (season, " | ".join(errors)))


# ---------------------------------------------------------------------------
# Parse (pure)
# ---------------------------------------------------------------------------

def _num(value):
    """float or None for blank / NA — an absent cell stays absent."""
    if value is None:
        return None
    v = str(value).strip()
    if v == "" or v.upper() in ("NA", "NAN", "NULL", "NONE"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _int(value):
    f = _num(value)
    return None if f is None else int(round(f))


def _resolve_columns(header, spec):
    """{field: actual column} or CorpusError naming every field with no
    column in the header (a rename must raise, never read as zeros)."""
    out, missing = {}, []
    for field, alternates in spec.items():
        col = next((c for c in alternates if c in header), None)
        if col is None:
            missing.append("%s (%s)" % (field, "/".join(alternates)))
        else:
            out[field] = col
    if missing:
        raise CorpusError("stats_player_week header is missing %s" % ", ".join(missing))
    return out


def parse_stats(text, season, min_ppr=MIN_PPR):
    """({pid: {"name", "pos", "weeks": {wk: [team, opp, pts, pass, rush, rec]}}},
    stats) for one season's CSV text: REG rows, QB/RB/WR/TE, the season's own
    rows, players at or above min_ppr PPR points for the season."""
    reader = csv.DictReader(io.StringIO(text))
    cols = _resolve_columns(reader.fieldnames or [], STATS_COLUMNS)
    stats = {"rows": 0, "kept_rows": 0, "not_reg": 0, "other_position": 0,
             "other_season": 0, "no_points": 0, "duplicate_player_week": 0,
             "players_below_min_ppr": 0, "players": 0}
    players = {}
    for row in reader:
        stats["rows"] += 1
        if (row.get(cols["season_type"]) or "").strip().upper() != "REG":
            stats["not_reg"] += 1
            continue
        if _int(row.get(cols["season"])) != int(season):
            stats["other_season"] += 1
            continue
        pos = (row.get(cols["pos"]) or "").strip().upper()
        if pos not in POSITIONS:
            stats["other_position"] += 1
            continue
        pts = _num(row.get(cols["pts_ppr"]))
        wk = _int(row.get(cols["week"]))
        if pts is None or wk is None:
            stats["no_points"] += 1
            continue
        pid = (row.get(cols["pid"]) or "").strip()
        rec = players.setdefault(pid, {"name": (row.get(cols["name"]) or "").strip(),
                                       "pos": pos, "weeks": {}})
        if wk in rec["weeks"]:
            stats["duplicate_player_week"] += 1
            continue
        rec["weeks"][wk] = [bw.norm_team(row.get(cols["team"])),
                            bw.norm_team(row.get(cols["opp"])),
                            round(pts, 2),
                            _num(row.get(cols["pass_yds"])) or 0.0,
                            _num(row.get(cols["rush_yds"])) or 0.0,
                            _num(row.get(cols["rec_yds"])) or 0.0]
        stats["kept_rows"] += 1
    kept = {}
    for pid, rec in players.items():
        if sum(v[2] for v in rec["weeks"].values()) >= min_ppr:
            kept[pid] = rec
        else:
            stats["players_below_min_ppr"] += 1
    stats["players"] = len(kept)
    return kept, stats


def actuals_document(per_season):
    """The weekly_actuals.json document from {season: parse_stats() players}.
    Players sorted by id; a player's name/position come from his latest
    season; seasons and weeks ascending."""
    merged = {}
    for season in sorted(per_season):
        for pid, rec in per_season[season].items():
            m = merged.setdefault(pid, {"name": rec["name"], "pos": rec["pos"], "seasons": {}})
            m["name"], m["pos"] = rec["name"], rec["pos"]
            m["seasons"][str(season)] = {str(wk): list(rec["weeks"][wk])
                                         for wk in sorted(rec["weeks"])}
    return {
        "source": ACTUALS_SOURCE,
        "seasons": sorted(int(s) for s in per_season),
        "fields": list(ACTUALS_FIELDS),
        "policy": ACTUALS_POLICY,
        "players": {pid: merged[pid] for pid in sorted(merged)},
    }


def parse_games(text, first_season=GAMES_FROM):
    """(rows, stats) from games.csv text: REG, season >= first_season, both
    scores present. Rows are GAMES_FIELDS-ordered lists."""
    reader = csv.DictReader(io.StringIO(text))
    header = reader.fieldnames or []
    missing = [c for c in GAMES_COLUMNS if c not in header]
    if missing:
        raise CorpusError("games.csv header is missing %s" % ", ".join(missing))
    stats = {"rows": 0, "kept": 0, "not_reg": 0, "before_first_season": 0, "unplayed": 0}
    rows = []
    for row in reader:
        stats["rows"] += 1
        if (row.get("game_type") or "").strip().upper() != "REG":
            stats["not_reg"] += 1
            continue
        season = _int(row.get("season"))
        if season is None or season < first_season:
            stats["before_first_season"] += 1
            continue
        hs, as_ = _int(row.get("home_score")), _int(row.get("away_score"))
        if hs is None or as_ is None:
            stats["unplayed"] += 1
            continue
        gameday = (row.get("gameday") or "").strip()
        gametime = (row.get("gametime") or "").strip()
        kickoff = "%sT%s" % (gameday, gametime) if gametime else gameday
        rows.append([
            season, _int(row.get("week")),
            bw.norm_team(row.get("home_team")), bw.norm_team(row.get("away_team")),
            hs, as_, kickoff,
            (row.get("roof") or "").strip() or None,
            _num(row.get("temp")), _num(row.get("wind")),
            _num(row.get("spread_line")),
            _int(row.get("home_moneyline")), _int(row.get("away_moneyline")),
            _int(row.get("home_rest")), _int(row.get("away_rest")),
            (row.get("location") or "").strip().lower() == "neutral",
            (row.get("stadium") or "").strip() or None,
            (row.get("weekday") or "").strip() or None,
        ])
        stats["kept"] += 1
    rows.sort(key=lambda r: (r[0], r[1], r[6] or ""))
    return rows, stats


def games_document(rows):
    seasons = sorted({r[0] for r in rows})
    return {
        "source": GAMES_SOURCE.format(first=seasons[0], last=seasons[-1]) if seasons
        else GAMES_SOURCE.format(first="", last=""),
        "fields": list(GAMES_FIELDS),
        "policy": GAMES_POLICY,
        "games": rows,
    }


def write_json(path, doc):
    """Exactly the committed encoding: compact separators, ASCII-escaped, no
    trailing newline."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# selftest — offline, inline CSV
# ---------------------------------------------------------------------------

_STATS_CSV = """player_id,player_display_name,position,recent_team,opponent_team,season,week,season_type,fantasy_points_ppr,passing_yards,rushing_yards,receiving_yards
00-0000001,Big Arm,QB,LA,SF,2024,1,REG,21.5,300,5,
00-0000001,Big Arm,QB,LA,ARI,2024,2,REG,18.25,250,10,
00-0000001,Big Arm,QB,LA,SF,2024,19,POST,30.0,400,0,
00-0000002,Speed Guy,WR,LA,SF,2024,1,REG,12.3,,0,123
00-0000002,Speed Guy,WR,LA,ARI,2024,2,REG,9.7,,0,97
00-0000002,Speed Guy,WR,LA,ARI,2024,2,REG,9.7,,0,97
00-0000003,Bench Guy,TE,SF,LA,2024,1,REG,4.0,,0,40
00-0000004,Kicker,K,SF,LA,2024,1,REG,9.0,,,
00-0000005,Last Year,RB,OAK,DEN,2023,1,REG,25.0,,250,
"""

_GAMES_CSV = """game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium
2024_01_SF_LA,2024,REG,1,2024-09-08,Sunday,16:25,SF,20,LA,24,Home,4,44,0,,,,,,,,7,7,150,-170,3.5,-110,-110,47.5,-110,-110,1,dome,sportturf,,,,,,,,,,,SoFi Stadium
2024_02_LA_ARI,2024,REG,2,2024-09-15,Sunday,16:05,LA,17,ARI,27,Home,10,44,0,,,,,,,,7,7,-120,100,-1.0,-110,-110,48.0,-110,-110,1,closed,grass,,,,,,,,,,,State Farm Stadium
2024_05_CHI_OAK,2024,REG,5,2024-10-06,Sunday,09:30,CHI,21,OAK,24,Neutral,3,45,0,,,,,,,,7,7,110,-130,2.0,-110,-110,44.5,-110,-110,0,outdoors,grass,59,15,,,,,,,,,,Tottenham Stadium
2018_01_A_B,2018,REG,1,2018-09-09,Sunday,13:00,A,10,B,20,Home,10,30,0,,,,,,,,7,7,,,,,,,,,,0,outdoors,grass,70,5,,,,,,,,,,Old Field
2024_19_SF_LA,2024,WC,19,2025-01-12,Sunday,16:30,SF,10,LA,30,Home,20,40,0,,,,,,,,7,7,,,,,,,,,,0,dome,sportturf,,,,,,,,,,,SoFi Stadium
2025_01_X_Y,2025,REG,1,2025-09-07,Sunday,13:00,SF,,LA,,Home,,,0,,,,,,,,7,7,,,,,,,,,,0,dome,sportturf,,,,,,,,,,,SoFi Stadium
"""


def selftest():
    players, st = parse_stats(_STATS_CSV, 2024)
    assert st["rows"] == 9 and st["not_reg"] == 1 and st["other_position"] == 1
    assert st["other_season"] == 1 and st["duplicate_player_week"] == 1
    assert set(players) == {"00-0000001", "00-0000002"}, sorted(players)
    assert st["players_below_min_ppr"] == 1, "the 4.0-point TE is dropped for the season"
    qb = players["00-0000001"]
    assert qb["name"] == "Big Arm" and qb["pos"] == "QB"
    assert qb["weeks"][1] == ["LAR", "SF", 21.5, 300.0, 5.0, 0.0], qb["weeks"][1]
    assert qb["weeks"][2][1] == "ARI" and 19 not in qb["weeks"], "POST is out"
    wr = players["00-0000002"]
    assert wr["weeks"][1] == ["LAR", "SF", 12.3, 0.0, 0.0, 123.0]
    # the older release header (recent_team / player_name) resolves too
    alt = _STATS_CSV.replace("player_display_name", "player_name")
    assert parse_stats(alt, 2024)[0]["00-0000001"]["name"] == "Big Arm"
    try:
        parse_stats(_STATS_CSV.replace("fantasy_points_ppr", "fp"), 2024)
    except CorpusError as exc:
        assert "pts_ppr" in str(exc)
    else:
        raise AssertionError("a renamed points column must raise, never read as zeros")

    prior, _ = parse_stats(_STATS_CSV, 2023)
    assert set(prior) == {"00-0000005"} and prior["00-0000005"]["weeks"][1][0] == "LV"
    doc = actuals_document({2024: players, 2023: prior})
    assert list(doc) == ["source", "seasons", "fields", "policy", "players"]
    assert doc["seasons"] == [2023, 2024] and doc["fields"] == ACTUALS_FIELDS
    assert doc["source"] == ACTUALS_SOURCE and doc["policy"] == ACTUALS_POLICY
    assert list(doc["players"]) == sorted(doc["players"])
    assert doc["players"]["00-0000001"]["seasons"]["2024"]["1"][2] == 21.5
    assert list(doc["players"]["00-0000001"]["seasons"]["2024"]) == ["1", "2"]

    rows, gst = parse_games(_GAMES_CSV)
    assert gst == {"rows": 6, "kept": 3, "not_reg": 1, "before_first_season": 1,
                   "unplayed": 1}, gst
    assert rows[0][:7] == [2024, 1, "LAR", "SF", 24, 20, "2024-09-08T16:25"], rows[0]
    assert rows[0][7] == "dome" and rows[0][8] is None and rows[0][9] is None
    assert rows[0][10] == 3.5 and rows[0][11] == -170 and rows[0][12] == 150
    assert rows[0][13:] == [7, 7, False, "SoFi Stadium", "Sunday"]
    neutral = rows[2]
    assert neutral[2] == "LV" and neutral[15] is True and neutral[8] == 59.0
    assert len(rows[0]) == len(GAMES_FIELDS)
    gdoc = games_document(rows)
    assert list(gdoc) == ["source", "fields", "policy", "games"]
    assert gdoc["source"] == "nflverse games.csv (REG, 2024-2024)"
    assert gdoc["policy"] == GAMES_POLICY and gdoc["fields"] == GAMES_FIELDS
    try:
        parse_games(_GAMES_CSV.replace("spread_line", "spread"))
    except CorpusError as exc:
        assert "spread_line" in str(exc)
    else:
        raise AssertionError("a renamed games column must raise")

    with tempfile.TemporaryDirectory() as tmp:
        write_json(os.path.join(tmp, ACTUALS_NAME), doc)
        write_json(os.path.join(tmp, GAMES_NAME), gdoc)
        raw = open(os.path.join(tmp, ACTUALS_NAME), "rb").read()
        assert raw.startswith(b'{"source":') and not raw.endswith(b"\n")
        assert b"\\u2014" in raw and b"\xe2" not in raw, "ASCII-escaped like the committed file"
        assert json.loads(raw) == doc
        assert json.load(open(os.path.join(tmp, GAMES_NAME), encoding="utf-8")) == gdoc
    print("selftest OK: REG-only QB/RB/WR/TE actuals with the season floor, played REG "
          "games from 2019, renames applied, headers guarded, encoding matches the fixture")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_seasons(text):
    if "-" in text:
        a, b = text.split("-", 1)
        return tuple(range(int(a), int(b) + 1))
    return tuple(int(s) for s in text.split(","))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--seasons", default="%d-%d" % (DEFAULT_SEASONS[0], DEFAULT_SEASONS[-1]),
                    help="actuals seasons, e.g. 2022-2025 or 2023,2024")
    ap.add_argument("--games-from", type=int, default=GAMES_FROM)
    ap.add_argument("--out-dir", default=OUT_DIR)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0

    seasons = _parse_seasons(args.seasons)
    per_season = {}
    for season in seasons:
        players, st = parse_stats(fetch_stats(season), season)
        if not players:
            raise CorpusError("season %d produced 0 players — refusing to write" % season)
        per_season[season] = players
        print("stats %d: %s" % (season, st))
    rows, gst = parse_games(fetch_text(GAMES_URL), args.games_from)
    if not rows:
        raise CorpusError("games.csv produced 0 REG games from %d" % args.games_from)
    print("games: %s" % gst)
    write_json(os.path.join(args.out_dir, ACTUALS_NAME), actuals_document(per_season))
    write_json(os.path.join(args.out_dir, GAMES_NAME), games_document(rows))
    print("wrote %s and %s under %s" % (ACTUALS_NAME, GAMES_NAME,
                                        os.path.relpath(args.out_dir, _ROOT)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CorpusError as exc:
        print("CORPUS ERROR: %s" % exc, file=sys.stderr)
        sys.exit(1)
