#!/usr/bin/env python3
"""Week-to-week parlay history -> data/parlays/<season>_wk<NN>.json + index.json (R73).

data/parlays.json holds ONE week — the pipeline overwrites it on every run — so
the cards of a finished week were gone the moment the builder moved on. This
archive keeps every week as its own file (owner decision 1) and an index the
PARLAYS view lists past weeks from.

RULES (locked by --selftest and tests/feature/r73_parlay_archive.test.mjs)
  * A week's file is CREATED on first sight of that week in parlays.json and
    REFRESHED on every run while the week is OPEN, so it ends as the last priced
    state before close. The as-made prices of every leg live in the R58 leg
    ledger (data/estimates/parlays_<season>.json) — this file is the cards.
  * CLOSED = every game of that week is FINAL in data/schedule_full.json
    (scripts.scrape.espn.FINAL_STATUSES, the STATUS-gate every builder uses).
    A week with no schedule rows is never closed (absent is unknown, not done).
    A file that is not yet closed is re-checked on every run, whichever week
    parlays.json holds, and flips to closed:true when its last game goes FINAL.
  * Once closed a file is NEVER rewritten: a later parlays.json for that week
    (a post-close reprice) is an idempotent no-op with a printed line.
  * An unchanged week (same parlays.json updated_utc, same closed flag) is not
    rewritten either — the crons commit after every run, and a byte-identical
    archive keeps their diffs to real changes.
  * `history` records one {updated_utc, archived_utc} per DISTINCT parlays.json
    updated_utc the archive saw for that week (a repricing leaves a trace even
    though only the last state is kept).
  * The document is parlays.json VERBATIM (season, week, updated_utc, parlays)
    plus archived_utc, closed, history. Nothing is re-derived or re-priced.
  * index.json: {season, generated_utc, current_week, weeks[]} sorted by week,
    current_week = the week parlays.json holds (the pipeline's default week:
    scripts/build_predictions.current_week — the earliest week not entirely
    FINAL). Rewritten only when an entry changed (generated_utc alone is not a
    change).
  * Canonical JSON (CLAUDE.md): ensure_ascii=True, indent=2, trailing newline.

Pure core (no I/O): week_closed, archive_doc, index_doc. Thin shell: run.
  python3 scripts/build_parlay_archive.py --selftest   fixture-driven, never writes data/
  python3 scripts/build_parlay_archive.py --dry-run    prints what would change, writes nothing
  python3 scripts/build_parlay_archive.py              runner / local: archive + index
"""

import argparse
import datetime as dt
import glob
import json
import os
import shutil
import sys
import tempfile

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scripts.scrape.espn import FINAL_STATUSES  # noqa: E402

DATA = os.path.join(_ROOT, "data")
ARCHIVE_SUBDIR = "parlays"
INDEX_NAME = "index.json"
FIXTURE_DIR = os.path.join(_ROOT, "tests", "fixtures", "r73")
VERBATIM_KEYS = ("season", "week", "updated_utc", "parlays")


def _now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def archive_name(season, week):
    """2026, 1 -> '2026_wk01.json'."""
    return "%d_wk%02d.json" % (int(season), int(week))


def parse_archive_name(filename):
    """'2026_wk01.json' -> (2026, 1); None for index.json or anything else."""
    base = os.path.basename(filename)
    if not base.endswith(".json"):
        return None
    stem = base[:-5]
    parts = stem.split("_")
    if len(parts) == 2 and parts[0].isdigit() and parts[1].startswith("wk") \
            and parts[1][2:].isdigit():
        return int(parts[0]), int(parts[1][2:])
    return None


# --------------------------------------------------------------------------- #
# pure core                                                                     #
# --------------------------------------------------------------------------- #

def week_closed(schedule_games, week):
    """True only when the week HAS games on the schedule and EVERY one carries a
    FINAL status. No rows -> False (unknown is never done). STATUS-gated: a live,
    halftime or 0-0 scheduled stub keeps the week open."""
    rows = []
    for g in schedule_games or []:
        try:
            if int(g.get("week")) == int(week):
                rows.append(g)
        except (TypeError, ValueError):
            continue
    return bool(rows) and all(g.get("status") in FINAL_STATUSES for g in rows)


def archive_doc(parlays_doc, existing, closed, now):
    """The archive document for parlays_doc's week, or None when nothing should
    be written.

    existing  the on-disk archive for that week (dict) or None
    closed    week_closed(...) for that week, evaluated now
    Returns (doc, action) with action in
      created | refreshed | closed | unchanged | frozen
    doc is None for unchanged / frozen (nothing to write)."""
    if existing is not None and existing.get("closed") is True:
        return None, "frozen"
    doc = {k: parlays_doc[k] for k in VERBATIM_KEYS if k in parlays_doc}
    for k, v in parlays_doc.items():          # verbatim: any extra top-level key too
        if k not in doc:
            doc[k] = v
    history = list((existing or {}).get("history") or [])
    seen = set(h.get("updated_utc") for h in history)
    upd = parlays_doc.get("updated_utc")
    if upd not in seen:
        history.append({"updated_utc": upd, "archived_utc": now})
    if existing is not None and existing.get("updated_utc") == upd \
            and existing.get("closed") is False and not closed:
        return None, "unchanged"
    doc["archived_utc"] = now
    doc["closed"] = bool(closed)
    doc["history"] = history
    if existing is None:
        action = "created"
    elif closed:
        action = "closed"
    else:
        action = "refreshed"
    return doc, action


def close_doc(existing, now):
    """An OPEN archive (parlays.json has moved on) whose week is now entirely
    FINAL: the same document with closed:true. Content and history untouched."""
    doc = dict(existing)
    doc["archived_utc"] = now
    doc["closed"] = True
    return doc


def index_entry(doc, rel_path):
    parlays = doc.get("parlays") or []
    return {"week": int(doc["week"]), "path": rel_path,
            "updated_utc": doc.get("updated_utc"), "archived_utc": doc.get("archived_utc"),
            "closed": bool(doc.get("closed")), "n_parlays": len(parlays),
            "n_week_scope": sum(1 for p in parlays if p.get("scope") == "week"),
            "n_game_scope": sum(1 for p in parlays if p.get("scope") == "game")}


def index_doc(season, archives, current_week, now):
    """archives: [(doc, rel_path)] for this season, any order -> the index, weeks
    sorted ascending."""
    entries = [index_entry(d, p) for d, p in archives if int(d.get("season", -1)) == int(season)]
    entries.sort(key=lambda e: e["week"])
    return {"season": int(season), "generated_utc": now,
            "current_week": int(current_week) if current_week is not None else None,
            "weeks": entries}


def index_changed(new, old):
    """True when anything but generated_utc differs."""
    if not old:
        return True
    a = {k: v for k, v in new.items() if k != "generated_utc"}
    b = {k: v for k, v in old.items() if k != "generated_utc"}
    return a != b


# --------------------------------------------------------------------------- #
# I/O shell                                                                     #
# --------------------------------------------------------------------------- #

def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_opt(path):
    return _load(path) if os.path.exists(path) else None


def write_json(doc, path):
    """data/*.json convention: ensure_ascii=True, indent=2, no sort_keys, newline."""
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")


def run(data_dir=DATA, parlays_path=None, schedule_path=None, now=None, dry_run=False,
        quiet=False):
    """One archive pass. Returns a summary dict (actions per week + index action).
    Loud on a missing parlays.json (nothing to archive is a broken pipeline,
    not a clean no-op)."""
    now = now or _now_utc()
    log = (lambda *a: None) if quiet else (lambda *a: print(*a))
    parlays_path = parlays_path or os.path.join(data_dir, "parlays.json")
    schedule_path = schedule_path or os.path.join(data_dir, "schedule_full.json")
    parlays = _load(parlays_path)
    sched = _load_opt(schedule_path) or {}
    games = sched.get("games") or []
    season, week = int(parlays["season"]), int(parlays["week"])
    arch_dir = os.path.join(data_dir, ARCHIVE_SUBDIR)
    rel_dir = "data/" + ARCHIVE_SUBDIR
    actions = {}
    writes = []          # (path, doc)

    # 1) the week parlays.json holds: create / refresh / close / unchanged / frozen
    name = archive_name(season, week)
    path = os.path.join(arch_dir, name)
    existing = _load_opt(path)
    doc, action = archive_doc(parlays, existing, week_closed(games, week), now)
    actions[week] = action
    if doc is not None:
        writes.append((path, doc))
        log("parlay_archive: wk %d %s %s/%s (%s, %d parlays, updated_utc %s)" % (
            week, action, rel_dir, name, "closed" if doc["closed"] else "open",
            len(doc.get("parlays") or []), doc.get("updated_utc")))
    elif action == "frozen":
        log("parlay_archive: wk %d is closed — %s/%s not rewritten (parlays.json updated_utc %s, "
            "archived %s)" % (week, rel_dir, name, parlays.get("updated_utc"),
                              existing.get("updated_utc")))
    else:
        log("parlay_archive: wk %d unchanged (%s/%s already at updated_utc %s, open)" % (
            week, rel_dir, name, parlays.get("updated_utc")))

    # 2) every OTHER open archive of this season: close it once its week is FINAL
    on_disk = {}
    for p in sorted(glob.glob(os.path.join(arch_dir, "*_wk*.json"))):
        sw = parse_archive_name(p)
        if sw is None or sw[0] != season:
            continue
        on_disk[sw[1]] = (p, _load(p))
    for wk, (p, ex) in sorted(on_disk.items()):
        if wk == week or ex.get("closed") is True:
            continue
        if week_closed(games, wk):
            writes.append((p, close_doc(ex, now)))
            actions[wk] = "closed"
            log("parlay_archive: wk %d closed %s/%s (every game FINAL; content kept as last "
                "archived, updated_utc %s)" % (wk, rel_dir, os.path.basename(p), ex.get("updated_utc")))

    # 3) index over the post-write state
    state = {wk: d for wk, (p, d) in on_disk.items()}
    for p, d in writes:
        state[int(d["week"])] = d
    archives = [(d, "%s/%s" % (rel_dir, archive_name(season, wk))) for wk, d in state.items()]
    idx = index_doc(season, archives, week, now)
    idx_path = os.path.join(arch_dir, INDEX_NAME)
    old_idx = _load_opt(idx_path)
    idx_action = "rewritten" if index_changed(idx, old_idx) else "unchanged"
    if idx_action == "rewritten":
        writes.append((idx_path, idx))
    log("parlay_archive: index %s (%d week(s), current_week %d)" % (
        idx_action, len(idx["weeks"]), week))

    if dry_run:
        log("parlay_archive: --dry-run, %d file(s) would be written, nothing written" % len(writes))
        return {"actions": actions, "index": idx_action, "written": [], "dry_run": True}
    if writes:
        os.makedirs(arch_dir, exist_ok=True)
    for p, d in writes:
        write_json(d, p)
    return {"actions": actions, "index": idx_action,
            "written": [os.path.relpath(p, data_dir) for p, _ in writes], "dry_run": False}


# --------------------------------------------------------------------------- #
# selftest (fixture-driven, never writes data/)                                 #
# --------------------------------------------------------------------------- #

def _validate(doc, schema_name):
    from scripts import validate_data as vd  # noqa: PLC0415
    schema = _load(os.path.join(DATA, "contracts", schema_name))
    errors = []
    vd._validate(doc, schema, schema_name, errors)
    return errors


def selftest():
    fx = lambda n: os.path.join(FIXTURE_DIR, n)  # noqa: E731
    tmp = tempfile.mkdtemp(prefix="r73_archive_")
    try:
        arch = os.path.join(tmp, ARCHIVE_SUBDIR)
        wk1 = os.path.join(arch, "2026_wk01.json")
        wk2 = os.path.join(arch, "2026_wk02.json")
        idx = os.path.join(arch, INDEX_NAME)
        # pure: closed only when rows exist and all FINAL
        games_open = _load(fx("schedule_open.json"))["games"]
        games_closed = _load(fx("schedule_closed.json"))["games"]
        assert week_closed(games_open, 1) is False and week_closed(games_closed, 1) is True
        assert week_closed(games_closed, 2) is False and week_closed(games_closed, 9) is False, \
            "a week with no schedule rows is never closed"
        # dry-run on an empty dir writes nothing
        r0 = run(tmp, fx("parlays_wk1_a.json"), fx("schedule_open.json"),
                 now="2026-09-13T11:00:00Z", dry_run=True, quiet=True)
        assert r0["dry_run"] and r0["written"] == [] and not os.path.exists(arch), r0
        assert r0["actions"] == {1: "created"} and r0["index"] == "rewritten"
        # first sight -> created, open, one history entry; index built
        r1 = run(tmp, fx("parlays_wk1_a.json"), fx("schedule_open.json"),
                 now="2026-09-13T11:00:00Z", quiet=True)
        assert r1["actions"] == {1: "created"} and sorted(r1["written"]) == \
            ["parlays/2026_wk01.json", "parlays/index.json"], r1
        a = _load(wk1)
        src = _load(fx("parlays_wk1_a.json"))
        assert {k: a[k] for k in VERBATIM_KEYS} == src, "parlays.json verbatim"
        assert a["closed"] is False and a["archived_utc"] == "2026-09-13T11:00:00Z"
        assert a["history"] == [{"updated_utc": "2026-09-13T10:00:00Z",
                                 "archived_utc": "2026-09-13T11:00:00Z"}]
        assert list(a) == ["season", "week", "updated_utc", "parlays", "archived_utc", "closed", "history"]
        i1 = _load(idx)
        assert i1 == {"season": 2026, "generated_utc": "2026-09-13T11:00:00Z", "current_week": 1,
                      "weeks": [{"week": 1, "path": "data/parlays/2026_wk01.json",
                                 "updated_utc": "2026-09-13T10:00:00Z",
                                 "archived_utc": "2026-09-13T11:00:00Z", "closed": False,
                                 "n_parlays": 3, "n_week_scope": 1, "n_game_scope": 2}]}, i1
        assert not _validate(a, "parlays_archive.schema.json") and not _validate(i1, "parlays_index.schema.json")
        # same as-of again -> unchanged, byte-identical, index untouched
        raw1 = open(wk1, "rb").read()
        r2 = run(tmp, fx("parlays_wk1_a.json"), fx("schedule_open.json"),
                 now="2026-09-13T15:00:00Z", quiet=True)
        assert r2["actions"] == {1: "unchanged"} and r2["written"] == [] and r2["index"] == "unchanged"
        assert open(wk1, "rb").read() == raw1
        # a repricing while open -> refreshed: last state kept, history grows
        r3 = run(tmp, fx("parlays_wk1_b.json"), fx("schedule_open.json"),
                 now="2026-09-14T17:00:00Z", quiet=True)
        assert r3["actions"] == {1: "refreshed"} and "parlays/2026_wk01.json" in r3["written"]
        b = _load(wk1)
        assert b["updated_utc"] == "2026-09-14T16:44:00Z" and b["closed"] is False
        assert b["parlays"][0]["legs"][0]["implied_prob"] == 0.57, "the repriced state replaces the old"
        assert [h["updated_utc"] for h in b["history"]] == ["2026-09-13T10:00:00Z", "2026-09-14T16:44:00Z"]
        assert b["history"][0]["archived_utc"] == "2026-09-13T11:00:00Z", "earlier history entries keep their stamp"
        assert _load(idx)["weeks"][0]["updated_utc"] == "2026-09-14T16:44:00Z"
        # parlays.json moves to week 2 while week 1 goes entirely FINAL: wk1 closes
        # with its last archived content, wk2 is created, index has both, current 2
        r4 = run(tmp, fx("parlays_wk2.json"), fx("schedule_closed.json"),
                 now="2026-09-15T11:00:00Z", quiet=True)
        assert r4["actions"] == {2: "created", 1: "closed"}, r4
        c = _load(wk1)
        assert c["closed"] is True and c["archived_utc"] == "2026-09-15T11:00:00Z"
        assert c["parlays"] == b["parlays"] and c["history"] == b["history"] \
            and c["updated_utc"] == b["updated_utc"], "closing changes the flag, never the cards"
        d2 = _load(wk2)
        assert d2["week"] == 2 and d2["closed"] is False and len(d2["history"]) == 1
        i4 = _load(idx)
        assert i4["current_week"] == 2 and [w["week"] for w in i4["weeks"]] == [1, 2]
        assert i4["weeks"][0]["closed"] is True and i4["weeks"][1]["closed"] is False
        assert i4["weeks"][1] == {"week": 2, "path": "data/parlays/2026_wk02.json",
                                  "updated_utc": "2026-09-15T10:00:00Z",
                                  "archived_utc": "2026-09-15T11:00:00Z", "closed": False,
                                  "n_parlays": 2, "n_week_scope": 1, "n_game_scope": 1}
        for doc in (c, d2):
            errs = _validate(doc, "parlays_archive.schema.json")
            assert not errs, errs
        assert not _validate(i4, "parlays_index.schema.json")
        # a post-close reprice of week 1 -> frozen: byte-identical, nothing written
        raw_c = open(wk1, "rb").read()
        late = json.loads(json.dumps(_load(fx("parlays_wk1_b.json"))))
        late["updated_utc"] = "2026-09-16T09:00:00Z"
        late["parlays"][0]["model_ev"] = 9.9
        late_path = os.path.join(tmp, "late.json")
        write_json(late, late_path)
        r5 = run(tmp, late_path, fx("schedule_closed.json"), now="2026-09-16T10:00:00Z", quiet=True)
        assert r5["actions"] == {1: "frozen"} and r5["written"] == ["parlays/index.json"], r5
        assert open(wk1, "rb").read() == raw_c, "a closed week is never rewritten"
        assert _load(idx)["current_week"] == 1, "index current_week follows parlays.json (the only change)"
        assert _load(idx)["weeks"][0]["updated_utc"] == c["updated_utc"], "the frozen entry keeps its stamps"
        # index sorted by week whatever the input order
        ix = index_doc(2026, [(d2, "p2"), (c, "p1")], 2, "t")
        assert [w["week"] for w in ix["weeks"]] == [1, 2] and ix["generated_utc"] == "t"
        assert index_changed(dict(ix, generated_utc="u"), ix) is False, "generated_utc alone is not a change"
        # canonical bytes on every file written
        for p in (wk1, wk2, idx):
            raw = open(p, "rb").read()
            assert raw == (json.dumps(json.loads(raw), ensure_ascii=True, indent=2) + "\n").encode("utf-8"), p
        assert parse_archive_name("2026_wk01.json") == (2026, 1) and parse_archive_name("index.json") is None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("selftest OK: first sight creates, same as-of unchanged (byte-identical), reprice "
          "refreshes + history, close on every-game-FINAL keeps the cards, closed never "
          "rewritten, dry-run writes nothing, index shape/order/current_week, schemas, "
          "canonical JSON")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=DATA, help="data directory (default: data/)")
    ap.add_argument("--parlays", default=None, help="parlays.json path (default: <data>/parlays.json)")
    ap.add_argument("--schedule", default=None, help="schedule_full.json path")
    ap.add_argument("--now", default=None, help="archived_utc stamp (default: now, UTC)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    run(data_dir=args.data, parlays_path=args.parlays, schedule_path=args.schedule,
        now=args.now, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
