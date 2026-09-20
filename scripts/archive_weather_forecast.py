#!/usr/bin/env python3
"""APPEND-ONLY archive of PRE-KICKOFF weather forecasts -> data/weather_forecast_archive.json.

The owner's question (2026-09-20) was about rain and wind on passing and
catching. R94 answers it on data/weather_history.json, which is ERA5 REANALYSIS:
an after-the-fact observation of what the weather actually was. That corpus is
the right substrate for "does weather move the ball", and it is structurally the
WRONG substrate for "could we have known before kickoff" — nothing fitted on a
reanalysis value can ever prove what was on the table when the number shipped.
A leakage-free phase 2 needs the forecast as it stood BEFORE the game, and the
repo has none: data/weather_forecast.json is overwritten by every daily run, so
there are zero archived pre-kickoff forecasts for 2021-2025 anywhere here. The
only way to have that series is to start accumulating it now, which is all this
file does. It pays back nothing this season. It is the only route to a
leakage-free phase 2, so it starts today.

WHAT IT DOES, exactly: reads the `games` rows of data/weather_forecast.json —
the FORECAST rows, stamped source=forecast + fetched_utc by the R56 builder —
and appends (key, fetched_utc, precip_mm, temp_c, wind_kph) to the archive when
that exact (key, fetched_utc) pair is not already there. Nothing else is read,
nothing else is written, no live number moves, and NOTHING reads the artifact:
it is a recording, not an input.

APPEND-ONLY MEANS APPEND-ONLY. `observations` is an ordered list and an entry
already in it is never rewritten, reordered or dropped:
  * the same pair with the same values -> refused `duplicate`, so a re-run over
    the same forecast file adds zero rows and leaves the file byte-identical;
  * the same pair with DIFFERENT values -> refused `conflict` and reported on
    stderr. The archived row wins. A pair that changed value upstream means the
    builder re-stamped a fetched_utc without refetching, which is worth knowing
    about and is never worth losing the original observation over;
  * a run that appends nothing does not write at all, so `generated_utc` is the
    last time the file CHANGED, not the last time this ran (the artifact says so).

THE CLIMATOLOGY DOOR. data/weather_forecast.json also carries `climatology`
rows — stadium-month means for games beyond the 16-day horizon (R56). Those are
not forecasts, they carry no precip_mm at all, and a series that mixes them
would silently be measuring "the average December in Cleveland" on the days no
real forecast existed. The top-level `climatology` block is never read, AND a
row that declares source=climatology inside `games` is refused at the door
before any field is looked at. The contract pins each archived row's `source` to
the enum ["forecast"], so the refusal survives a future edit to this file.

A row that does not say what it is does not enter either: a pre-R56 forecast row
carries neither `source` nor `fetched_utc`, and with no fetch stamp there is no
honest observation time to record. Absent is absent; it is refused and counted,
never stamped with the run's own clock.

Stdlib only, no network (the fetching is build_weather_forecast.py's job; this
runs straight after it in the daily cron). --selftest is offline, fixture-driven
and writes nothing under data/. --dry-run prints what would be appended and
writes nothing.
"""

import argparse
import datetime as dt
import json
import os
import re
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

DATA = os.path.join(_ROOT, "data")
FORECAST_PATH = os.path.join(DATA, "weather_forecast.json")
OUT_PATH = os.path.join(DATA, "weather_forecast_archive.json")
SCHEMA_NAME = "weather_forecast_archive.schema.json"

KIND = "weather_forecast_archive"
SOURCE_FORECAST = "forecast"          # the only `source` that may enter the archive
VALUE_FIELDS = ("precip_mm", "temp_c", "wind_kph")
ROW_FIELDS = ("key", "fetched_utc") + VALUE_FIELDS + ("source",)
# Every reason is pre-seeded to 0 on every write: a refusal that never fired
# must read 0, not go missing, or a reader cannot tell "never happened" from
# "this version of the archiver could not have noticed".
REFUSALS = ("not_forecast", "no_fetched_utc", "malformed_row", "duplicate", "conflict")

KEY_RE = re.compile(r"^\d{4}\|\d{1,2}\|[A-Z]{2,3}\|[A-Z]{2,3}$")
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

SOURCE = ("scripts/archive_weather_forecast.py over data/weather_forecast.json "
          "`games` (Open-Meteo forecast rows only; climatology rows never enter)")
RULE = ("Append-only. A (key, fetched_utc) pair already present is never "
        "rewritten, reordered or dropped, so a re-run adds zero rows and a "
        "changed upstream value is refused rather than overwriting the "
        "observation as it stood. generated_utc is the last APPEND, not the "
        "last run: a run that appends nothing leaves this file byte-identical.")


def _now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _rel(path):
    """Repo-relative for a repo path, absolute otherwise (the selftest's temp dirs)."""
    ap = os.path.abspath(path)
    return os.path.relpath(ap, _ROOT) if ap.startswith(_ROOT + os.sep) else ap


def _num(value):
    """True for a real JSON number. Booleans are not numbers here."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# --------------------------------------------------------------------------- #
# pure core                                                                     #
# --------------------------------------------------------------------------- #

def candidate_rows(forecast_doc):
    """(rows, refused) from a weather_forecast.json-shaped document.

    Reads `games` ONLY. Keys are walked in sorted order so a run's appended
    block is deterministic; the archive's own order stays append order.
    """
    refused = {reason: 0 for reason in REFUSALS}
    rows = []
    games = (forecast_doc or {}).get("games") or {}
    for key in sorted(games):
        row = games[key]
        # The door: a climatology row (or anything unlabelled) stops here,
        # before a single field is read.
        if not isinstance(row, dict) or row.get("source") != SOURCE_FORECAST:
            refused["not_forecast"] += 1
            continue
        fetched = row.get("fetched_utc")
        if not isinstance(fetched, str) or UTC_RE.match(fetched) is None:
            refused["no_fetched_utc"] += 1
            continue
        if KEY_RE.match(key) is None or not all(_num(row.get(f)) for f in VALUE_FIELDS):
            refused["malformed_row"] += 1
            continue
        if row["precip_mm"] < 0 or row["wind_kph"] < 0:
            refused["malformed_row"] += 1
            continue
        rows.append({"key": key, "fetched_utc": fetched, "source": SOURCE_FORECAST,
                     "precip_mm": row["precip_mm"], "temp_c": row["temp_c"],
                     "wind_kph": row["wind_kph"]})
    return rows, refused


def empty_archive(now_utc):
    """The day-one document: a valid archive with nothing in it yet."""
    return archive_doc([], now_utc, 0, {reason: 0 for reason in REFUSALS})


def archive_doc(observations, now_utc, appended, refused):
    return {
        "generated_utc": now_utc,
        "kind": KIND,
        "source": SOURCE,
        "rule": RULE,
        "counts": {
            "observations": len(observations),
            "games": len({o.get("key") for o in observations}),
            "appended": appended,
            "refused": {reason: int(refused.get(reason, 0)) for reason in REFUSALS},
        },
        "observations": observations,
    }


def append(archive, rows, now_utc):
    """(doc, appended, refused, conflicts) — the whole append-only rule, pure.

    Existing observations are carried through untouched and in order; only the
    tail grows. An archived row that predates a field is left exactly as it is
    rather than being repaired, because repairing it would be a rewrite.
    """
    observations = list((archive or {}).get("observations") or [])
    refused = {reason: 0 for reason in REFUSALS}
    seen = {}
    for obs in observations:
        if isinstance(obs, dict) and "key" in obs and "fetched_utc" in obs:
            seen[(obs["key"], obs["fetched_utc"])] = obs
    conflicts = []
    for row in rows:
        pair = (row["key"], row["fetched_utc"])
        prev = seen.get(pair)
        if prev is not None:
            if all(prev.get(f) == row[f] for f in VALUE_FIELDS):
                refused["duplicate"] += 1
            else:
                refused["conflict"] += 1
                conflicts.append(pair)
            continue                      # either way the archived row stands
        observations.append(dict(row))
        seen[pair] = observations[-1]
    appended = len(observations) - len((archive or {}).get("observations") or [])
    return archive_doc(observations, now_utc, appended, refused), appended, refused, conflicts


# --------------------------------------------------------------------------- #
# io                                                                            #
# --------------------------------------------------------------------------- #

def _load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_archive(doc, path):
    """data/*.json encoding: ensure_ascii, indent 2, sorted keys, trailing newline."""
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=True)
        fh.write("\n")


def run(forecast_path=FORECAST_PATH, out_path=OUT_PATH, dry_run=False,
        verbose=True, now_utc=None):
    """Archive one forecast build. Returns (exit_code, doc, appended, refused)."""
    now = now_utc or _now_utc()
    try:
        forecast = _load(forecast_path)
    except (OSError, ValueError) as exc:
        print("ARCHIVE WEATHER FORECAST: cannot read %s (%s) - nothing archived, "
              "nothing written" % (_rel(forecast_path), exc),
              file=sys.stderr)
        return 1, None, 0, {}
    existed = os.path.exists(out_path)
    if existed:
        try:
            archive = _load(out_path)
        except (OSError, ValueError) as exc:
            # Never clobber an archive we cannot read: the history in it is the
            # only copy there will ever be.
            print("ARCHIVE WEATHER FORECAST: %s is unreadable (%s) - refusing to "
                  "overwrite it" % (_rel(out_path), exc),
                  file=sys.stderr)
            return 1, None, 0, {}
    else:
        archive = empty_archive(now)

    rows, refused = candidate_rows(forecast)
    doc, appended, seen_refused, conflicts = append(archive, rows, now)
    # One run, one accounting: the rows the door turned away plus the rows the
    # archive already held. Both land in counts.refused so `appended + every
    # refusal` adds back up to the forecast rows this run was offered.
    for reason, n in seen_refused.items():
        refused[reason] = refused.get(reason, 0) + n
    doc["counts"]["refused"] = {r: int(refused.get(r, 0)) for r in REFUSALS}

    for key, fetched in conflicts:
        print("NOTICE: %s @ %s is already archived with different values - the "
              "archived row stands (upstream re-stamped without refetching?)"
              % (key, fetched), file=sys.stderr)

    if dry_run:
        if verbose:
            print("dry run: %d row(s) would be appended to %s (%d refused)"
                  % (appended, _rel(out_path),
                     sum(refused.values())))
        return 0, doc, appended, refused
    # A run that appends nothing leaves the file alone, so the daily cron does
    # not churn a byte of git history for a forecast it has already recorded.
    if appended or not existed:
        write_archive(doc, out_path)
    if verbose:
        print("archived %d new observation(s); %d total over %d game(s) [%s]"
              % (appended, doc["counts"]["observations"], doc["counts"]["games"],
                 ", ".join("%s=%d" % (r, refused.get(r, 0)) for r in REFUSALS)))
        if not appended and existed:
            print("nothing new: %s unchanged" % _rel(out_path))
    return 0, doc, appended, refused


# --------------------------------------------------------------------------- #
# selftest                                                                      #
# --------------------------------------------------------------------------- #

def _synthetic():
    """A forecast document carrying one of every row this archiver must judge."""
    stamp = "2026-09-20T16:39:07Z"
    return {
        "generated_utc": stamp,
        "source": "open-meteo forecast + climatology",
        "games": {
            "2026|3|BUF|NYJ": {"temp_c": 9.5, "wind_kph": 27.4, "precip_mm": 1.4,
                               "source": "forecast", "fetched_utc": stamp},
            "2026|3|GB|DET": {"temp_c": 4.0, "wind_kph": 11.0, "precip_mm": 0.0,
                              "source": "forecast", "fetched_utc": stamp},
            # a climatology row smuggled into `games`: refused at the door
            "2026|13|CHI|MIN": {"temp_c": -1.0, "wind_kph": 12.0, "n": 9,
                                "month": 12, "rules": ["cold"],
                                "source": "climatology"},
            # a pre-R56 row: no label, no fetch stamp, nothing honest to archive
            "2026|3|CLE|PIT": {"temp_c": 7.0, "wind_kph": 30.0, "precip_mm": 0.2},
            # labelled, but the stamp is not a UTC instant
            "2026|3|NE|MIA": {"temp_c": 20.0, "wind_kph": 8.0, "precip_mm": 0.0,
                              "source": "forecast", "fetched_utc": "tuesday"},
            # labelled and stamped, but precipitation cannot be negative
            "2026|3|SEA|SF": {"temp_c": 14.0, "wind_kph": 9.0, "precip_mm": -1.0,
                              "source": "forecast", "fetched_utc": stamp},
        },
        # never read at all
        "climatology": {"2026|18|DEN|LV": {"temp_c": -2.0, "wind_kph": 14.0,
                                           "source": "climatology", "n": 7,
                                           "month": 1, "rules": ["cold"]}},
    }


def _schema_errors(doc):
    """Validate a document with the repo's own stdlib contract validator."""
    from scripts import validate_data as vd  # noqa: PLC0415
    schema = _load(os.path.join(DATA, "contracts", SCHEMA_NAME))
    errors = []
    vd._validate(doc, schema, KIND, errors)
    return errors


def selftest():
    import contextlib, io, shutil, tempfile  # noqa: E401,PLC0415

    t0, t1 = "2026-09-20T17:00:00Z", "2026-09-21T17:00:00Z"
    fx = _synthetic()

    # --- day one: an empty archive is a VALID archive ------------------------
    empty = empty_archive(t0)
    assert not _schema_errors(empty), _schema_errors(empty)
    assert empty["counts"]["observations"] == 0 and empty["counts"]["games"] == 0
    assert empty["counts"]["refused"] == {r: 0 for r in REFUSALS}, \
        "every refusal reason is pre-seeded to 0, never absent"

    # --- the door ------------------------------------------------------------
    rows, refused = candidate_rows(fx)
    assert [r["key"] for r in rows] == ["2026|3|BUF|NYJ", "2026|3|GB|DET"], rows
    assert refused == {"not_forecast": 2,     # climatology row + unlabelled row
                       "no_fetched_utc": 1,   # "tuesday" is not an instant
                       "malformed_row": 1,    # precip_mm -1.0
                       "duplicate": 0, "conflict": 0}, refused
    assert all(r["source"] == SOURCE_FORECAST for r in rows)
    # The climatology block is not even looked at, so its keys cannot appear.
    assert not any(r["key"] == "2026|18|DEN|LV" for r in rows)
    clim_only = {"games": {"2026|13|CHI|MIN": fx["games"]["2026|13|CHI|MIN"]}}
    assert candidate_rows(clim_only)[0] == [], "a climatology row can never enter"

    # --- first append --------------------------------------------------------
    doc1, n1, _, conf1 = append(empty, rows, t0)
    assert (n1, conf1) == (2, []), (n1, conf1)
    assert not _schema_errors(doc1), _schema_errors(doc1)
    assert doc1["counts"]["observations"] == 2 and doc1["counts"]["games"] == 2
    assert set(doc1["observations"][0]) == set(ROW_FIELDS), doc1["observations"][0]

    # --- a re-run over the same input appends NOTHING ------------------------
    doc2, n2, ref2, _ = append(doc1, rows, t1)
    assert n2 == 0 and ref2["duplicate"] == 2, (n2, ref2)
    assert doc2["observations"] == doc1["observations"], "rows must not move"

    # --- an existing pair is NOT mutated when its values differ --------------
    revised = [dict(rows[0], precip_mm=99.9, wind_kph=1.0), rows[1]]
    doc3, n3, ref3, conf3 = append(doc1, revised, t1)
    assert n3 == 0 and ref3["conflict"] == 1 and ref3["duplicate"] == 1, ref3
    assert conf3 == [("2026|3|BUF|NYJ", "2026-09-20T16:39:07Z")], conf3
    assert doc3["observations"][0]["precip_mm"] == 1.4, doc3["observations"][0]
    assert doc3["observations"] == doc1["observations"]

    # --- a NEW fetch of the same game is a new observation, appended at the end
    later = [dict(rows[0], fetched_utc=t1, precip_mm=3.3)]
    doc4, n4, _, _ = append(doc1, later, t1)
    assert n4 == 1 and doc4["counts"]["observations"] == 3, doc4["counts"]
    assert doc4["observations"][:2] == doc1["observations"], "the prefix is frozen"
    assert doc4["observations"][2]["precip_mm"] == 3.3
    assert doc4["counts"]["games"] == 2, "two observations of one game, one key"

    # --- end to end on disk, entirely inside a temp dir ----------------------
    tmp = tempfile.mkdtemp(prefix="r94_forecast_archive_")
    try:
        fpath = os.path.join(tmp, "weather_forecast.json")
        apath = os.path.join(tmp, "weather_forecast_archive.json")
        with open(fpath, "w", encoding="utf-8") as fh:
            json.dump(fx, fh)
        code, doc_run, appended, ref_run = run(fpath, apath, verbose=False, now_utc=t0)
        assert (code, appended) == (0, 2), (code, appended)
        # The artifact's accounting adds up: every row the run was offered was
        # either appended or refused for exactly one named reason.
        assert appended + sum(ref_run.values()) == len(fx["games"]), ref_run
        assert doc_run["counts"]["refused"] == refused, doc_run["counts"]
        first = open(apath, "rb").read()
        assert not _schema_errors(json.loads(first)), "the written file honours the contract"
        code, doc_run, appended, ref_run = run(fpath, apath, verbose=False, now_utc=t1)
        assert (code, appended) == (0, 0), (code, appended)
        assert appended + sum(ref_run.values()) == len(fx["games"]), ref_run
        assert doc_run["counts"]["refused"] == dict(refused, duplicate=2), \
            doc_run["counts"]
        assert open(apath, "rb").read() == first, "a no-op run leaves the file byte-identical"
        # --dry-run on a genuinely new forecast still writes nothing.
        fx2 = json.loads(json.dumps(fx))
        for row in rows:                  # only the two rows that were archivable
            fx2["games"][row["key"]]["fetched_utc"] = t1
        with open(fpath, "w", encoding="utf-8") as fh:
            json.dump(fx2, fh)
        code, dry, appended, _ = run(fpath, apath, dry_run=True, verbose=False, now_utc=t1)
        assert (code, appended) == (0, 2) and open(apath, "rb").read() == first, appended
        assert dry["counts"]["observations"] == 4, dry["counts"]
        # The two refusals below are MEANT to fail, so their (correct) loud
        # stderr line is swallowed here rather than made quiet in `run`.
        with contextlib.redirect_stderr(io.StringIO()) as shouted:
            # An unreadable existing archive is refused, never overwritten.
            with open(apath, "w", encoding="utf-8") as fh:
                fh.write("{ this is not json")
            code, _, _, _ = run(fpath, apath, verbose=False, now_utc=t1)
            assert code == 1, code
            assert open(apath, "r", encoding="utf-8").read() == "{ this is not json"
            # A missing forecast file is loud and writes nothing.
            assert run(os.path.join(tmp, "nope.json"),
                       os.path.join(tmp, "nope_out.json"), verbose=False)[0] == 1
            assert not os.path.exists(os.path.join(tmp, "nope_out.json"))
        assert shouted.getvalue().count("ARCHIVE WEATHER FORECAST") == 2, \
            "both refusals must say so on stderr, not fail silently"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("selftest OK: the archive is append-only - a re-run over the same "
          "forecast adds 0 rows and leaves the file byte-identical, an existing "
          "(key, fetched_utc) pair keeps its archived values when upstream "
          "changes them (refused as `conflict`), a new fetched_utc appends at "
          "the end with the prefix frozen; a source=climatology row is refused "
          "at the door and an unlabelled or unstamped row with it; an empty "
          "day-one archive validates against %s; nothing was written outside a "
          "temp dir" % SCHEMA_NAME)


# --------------------------------------------------------------------------- #
# CLI                                                                           #
# --------------------------------------------------------------------------- #

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--forecast", default=FORECAST_PATH,
                        help="the forecast build to archive (default data/weather_forecast.json)")
    parser.add_argument("--out", default=OUT_PATH)
    parser.add_argument("--dry-run", action="store_true",
                        help="print what would be appended; write nothing")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    code, _, _, _ = run(args.forecast, args.out, dry_run=args.dry_run,
                        verbose=not args.quiet)
    return code


if __name__ == "__main__":
    sys.exit(main())
