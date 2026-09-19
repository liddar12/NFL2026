#!/usr/bin/env python3
"""Three-way merge of an APPEND-ONLY data ledger, by identity rather than by text.

WHY THIS EXISTS (F16). Two pipeline runs can generate from the same base commit at
the same time -- daily and gameday sit in different concurrency groups -- and the
owner can land a code commit on main while either is running. The publish loop then
has to put its generation on top of a head it did not start from. For a regenerable
artifact that is easy: this run just rebuilt it from the newest inputs, so its
version wins. For a LEDGER it is the opposite, and taking either whole side is a
data loss: these files are the record of what was offered and when it was first
seen, entries are never rewritten, and the other writer's entries are just as real
as ours. Line-level merging cannot help -- two appends at the end of the same JSON
array conflict textually every time, and "resolve by taking one side" silently drops
the other side's locks.

So the ledgers are merged the way they are keyed: by identity.

  * union of entries by the ledger's own identity key -- an entry present on either
    side is present in the result, always;
  * both sides added the same key -> the EARLIER first sight wins, because first
    sight is what locks the as-made numbers;
  * one side changed an entry the other left exactly as the base had it -> take the
    changed side (a resolver filling graded fields, `latest` advancing);
  * both changed the same field to different values -> the earlier-first-sight
    side's value, so the lock still decides;
  * runs[] / history[] union by their own as-of key, chronologically;
  * header scalars (generated_utc / as_of_utc / updated_utc / counts) take the
    LATER as-of: the header describes the newest generation in the merged file.

Absent data is never invented here: every value written comes from one of the three
inputs. Nothing is dropped, nothing is averaged, nothing is guessed.

Usage (one file per invocation, stages as written by `git show :1:/:2:/:3:`):

    python3 scripts/merge_ledgers.py <base.json> <theirs.json> <ours.json> \
        --path data/estimates/parlays_2026.json --out <merged.json>

`-` in place of a stage path means that stage does not exist (add/add, or a side
that deleted the file). The shape is chosen by --path; an unknown path is refused
with exit 2 rather than merged by guesswork, and scripts/publish_data.sh treats
that refusal as a hard failure.

    python3 scripts/merge_ledgers.py --selftest
"""

import argparse
import json
import os
import re
import sys

MISSING = object()

# --- shape registry -------------------------------------------------------
#
# One entry per append-only ledger. `entries` is the identity-keyed body (None
# when the file's only append-only part is its history list); `runs` are the
# as-of keyed run records; everything else at the top level is header.

SHAPES = [
    {
        "name": "estimate_ledger",
        # data/estimates/<season>.json -- the player ledger. Written COMPACT by
        # scripts/build_estimate_ledger.py (18-float arrays per player would cost
        # ~3 MB at indent=2), so the merge must write it compact too or the next
        # run would rewrite the whole file as cosmetic churn.
        "pattern": r"^data/estimates/[0-9]{4}\.json$",
        "entries": {"field": "players", "kind": "dict",
                    "first_sight": ("first", "as_of_utc"), "policy": "player"},
        "runs": [{"field": "runs", "key": ("as_of_utc",), "order": "asc"}],
        "asof": ["generated_utc", "as_of_utc"],
        "compact": True,
    },
    {
        "name": "parlay_ledger",
        "pattern": r"^data/estimates/parlays_[0-9]{4}\.json$",
        "entries": {"field": "legs", "kind": "list",
                    "key": ("season", "week", "game_id", "market", "selection"),
                    "first_sight": ("seen_utc",), "policy": "flat"},
        "runs": [{"field": "runs", "key": ("as_of_utc",), "order": "asc"}],
        "asof": ["generated_utc", "as_of_utc"],
        "compact": False,
    },
    {
        "name": "my_cards",
        "pattern": r"^data/my_cards/[0-9]{4}_wk[0-9]{2}\.json$",
        "entries": {"field": "cards", "kind": "list", "key": ("card_id",),
                    "first_sight": ("first_seen_utc",), "policy": "flat"},
        "runs": [{"field": "runs", "key": ("pool_generated_utc",), "order": "asc"}],
        "asof": ["generated_utc", "pool_generated_utc"],
        "compact": False,
    },
    {
        "name": "parlay_archive",
        # data/parlays/<season>_wk<NN>.json -- the per-week archive. `parlays` is
        # the week as of `updated_utc`, so it travels with the newer header (the
        # generic header rule); `history` is the append-only part.
        "pattern": r"^data/parlays/[0-9]{4}_wk[0-9]{2}\.json$",
        "entries": None,
        "runs": [{"field": "history", "key": ("updated_utc",), "order": "asc"}],
        "asof": ["archived_utc", "updated_utc"],
        # A week never re-opens, so `closed` only ever goes false -> true.
        "monotone_true": ["closed"],
        "compact": False,
    },
    {
        "name": "model_tuning",
        # The header here describes the ADOPTED weights (adoption is a deliberate
        # human act and is rare); `history` is what both writers append to.
        "pattern": r"^data/model_tuning\.json$",
        "entries": None,
        # Identity is (generated_utc, kind): promote_signals and the player fit can
        # both archive at the same second, and this list is written NEWEST FIRST
        # (`history.insert(0, entry)`), so the merge must put it back that way.
        "runs": [{"field": "history", "key": ("generated_utc", "kind"),
                  "order": "desc"}],
        "asof": ["generated_utc"],
        "compact": False,
    },
]

SNAPSHOT_PATTERN = r"^data/snapshots/"


class Refuse(Exception):
    """A shape this script will not guess at. Exit 2; the caller must fail hard."""


def shape_for(path):
    norm = path.replace("\\", "/").lstrip("./")
    if re.match(SNAPSHOT_PATTERN, norm):
        raise Refuse(
            "data/snapshots/ needs no merge: every snapshot is its own immutable "
            "point-in-time file, so two writers cannot both edit one. A conflict "
            "there means something else is wrong -- resolve it by hand: %s" % path)
    for shape in SHAPES:
        if re.match(shape["pattern"], norm):
            return shape
    raise Refuse(
        "no ledger shape is registered for %s. This script merges only the "
        "append-only ledgers listed in docs/PUBLISH.md; merging an unknown shape "
        "by guesswork could drop a lock silently." % path)


# --- small helpers --------------------------------------------------------

def load(path):
    """A stage; `-` (or a missing file) means the stage does not exist."""
    if path == "-" or path is None:
        return None
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def dig(obj, keys):
    for k in keys:
        if not isinstance(obj, dict) or k not in obj:
            return None
        obj = obj[k]
    return obj


def doc_asof(doc, shape):
    """The document's own as-of: the first of the shape's fields that is present."""
    if not isinstance(doc, dict):
        return ""
    for field in shape["asof"]:
        val = doc.get(field)
        if isinstance(val, str) and val:
            return val
    return ""


def canonical(obj):
    return json.dumps(obj, sort_keys=True, ensure_ascii=True)


def ordered_keys(*dicts):
    """Union of keys preserving first-seen order (base's order wins)."""
    out = []
    for d in dicts:
        if isinstance(d, dict):
            for k in d:
                if k not in out:
                    out.append(k)
    return out


def entry_key(entry, spec):
    return tuple(entry.get(f) for f in spec["key"])


def index_entries(doc, spec):
    """(ordered keys, {key: entry}) for a shape's entry container."""
    if not isinstance(doc, dict):
        return [], {}
    body = doc.get(spec["field"])
    order, by_key = [], {}
    if spec["kind"] == "list":
        if not isinstance(body, list):
            return [], {}
        for entry in body:
            if not isinstance(entry, dict):
                continue
            k = entry_key(entry, spec)
            if k not in by_key:
                order.append(k)
            by_key[k] = entry
    else:
        if not isinstance(body, dict):
            return [], {}
        for k, entry in body.items():
            order.append(k)
            by_key[k] = entry
    return order, by_key


def first_sight(entry, spec):
    """The entry's first-sight timestamp, or '' when it has none (never a guess)."""
    val = dig(entry, spec["first_sight"])
    return val if isinstance(val, str) else ""


def earlier_side(t_entry, o_entry, spec):
    """'theirs' or 'ours': whichever saw this entry first. Ties resolve to ours.

    First sight is what locks a ledger entry's as-made numbers, so on any
    disagreement the side that recorded it first is the side that holds the lock.
    A tie means both runs stamped the same as-of, in which case the two entries
    describe the same moment and the choice cannot change a number that matters.
    """
    t_seen, o_seen = first_sight(t_entry, spec), first_sight(o_entry, spec)
    if t_seen and o_seen:
        return "theirs" if t_seen < o_seen else "ours"
    if t_seen and not o_seen:
        return "theirs"
    return "ours"


# --- entry merges ---------------------------------------------------------

def merge_flat(base, theirs, ours, spec):
    """Field-level three-way merge of one entry. Changed beats base; on a genuine
    both-changed disagreement the earlier first sight decides."""
    winner = earlier_side(theirs, ours, spec)
    out = {}
    for k in ordered_keys(base, theirs, ours):
        b = base.get(k, MISSING) if isinstance(base, dict) else MISSING
        t = theirs.get(k, MISSING)
        o = ours.get(k, MISSING)
        if t is MISSING and o is MISSING:
            val = b
        elif t is MISSING:
            val = o
        elif o is MISSING:
            val = t
        elif t == o:
            val = t
        elif b is not MISSING and o == b:
            val = t            # only theirs changed it
        elif b is not MISSING and t == b:
            val = o            # only ours changed it
        else:
            val = t if winner == "theirs" else o
        if val is not MISSING:
            out[k] = val
    return out


def pick_by_asof(a, b, later):
    """Of two {..., as_of_utc} blocks pick the later (or earlier) one."""
    if a is None:
        return b
    if b is None:
        return a
    a_at = a.get("as_of_utc", "") if isinstance(a, dict) else ""
    b_at = b.get("as_of_utc", "") if isinstance(b, dict) else ""
    if a_at == b_at:
        return a
    if later:
        return a if a_at > b_at else b
    return a if a_at < b_at else b


def merge_locked(base, theirs, ours):
    """The per-week locked estimates: union by week, earlier as-of wins.

    A locked week is frozen at the last as-of before that week's kickoff, so if
    the two sides disagree the earlier stamp is the one that was actually locked.
    """
    base = base if isinstance(base, dict) else {}
    theirs = theirs if isinstance(theirs, dict) else {}
    ours = ours if isinstance(ours, dict) else {}
    out = {}
    for week in ordered_keys(base, theirs, ours):
        b, t, o = base.get(week), theirs.get(week), ours.get(week)
        if t is None:
            out[week] = o if o is not None else b
        elif o is None:
            out[week] = t
        elif t == o:
            out[week] = t
        elif b is not None and o == b:
            out[week] = t
        elif b is not None and t == b:
            out[week] = o
        else:
            out[week] = pick_by_asof(t, o, later=False)
    return out


def merge_player(base, theirs, ours, spec):
    """One player in data/estimates/<season>.json.

    `first` is a lock (earlier wins), `latest` is a watermark (later wins), and
    `locked` is a per-week union of locks. Everything else is flat.
    """
    out = {}
    for k in ordered_keys(base, theirs, ours):
        b = base.get(k) if isinstance(base, dict) else None
        t = theirs.get(k)
        o = ours.get(k)
        if k == "first":
            out[k] = pick_by_asof(t, o, later=False)
        elif k == "latest":
            out[k] = pick_by_asof(t, o, later=True)
        elif k == "locked":
            out[k] = merge_locked(b, t, o)
        else:
            sub = merge_flat(
                {k: b} if b is not None else {},
                {k: t} if t is not None else {},
                {k: o} if o is not None else {},
                spec)
            if k in sub:
                out[k] = sub[k]
    return out


def merge_entry(base, theirs, ours, spec):
    if theirs is None and ours is None:
        return base
    if theirs is None:
        return ours
    if ours is None:
        return theirs
    if theirs == ours:
        return theirs
    if base is None:
        # Both sides added this key independently: first sight locks.
        return theirs if earlier_side(theirs, ours, spec) == "theirs" else ours
    if ours == base:
        return theirs
    if theirs == base:
        return ours
    if spec["policy"] == "player":
        return merge_player(base, theirs, ours, spec)
    return merge_flat(base, theirs, ours, spec)


def merge_entries(base, theirs, ours, spec):
    """Union by identity key: base order first, then whatever each side added."""
    b_order, b_map = index_entries(base, spec)
    t_order, t_map = index_entries(theirs, spec)
    o_order, o_map = index_entries(ours, spec)

    order = list(b_order)
    for k in t_order + o_order:
        if k not in order:
            order.append(k)

    merged = []
    for k in order:
        entry = merge_entry(b_map.get(k), t_map.get(k), o_map.get(k), spec)
        if entry is not None:
            merged.append((k, entry))
    if spec["kind"] == "list":
        return [e for _, e in merged]
    return {k: e for k, e in merged}


# --- runs / history -------------------------------------------------------

def merge_runs(base, theirs, ours, spec, t_asof, o_asof):
    """Union of run records by their own identity key, in the writer's order.

    A run record already in the base was published; it is never rewritten. When
    both sides recorded the same key and disagree, the side whose document is
    older saw that build first (the other run's record of it says it added
    nothing new); a dead tie falls to canonical order so the merge is a function
    of its inputs and nothing else.
    """
    field, key = spec["field"], spec["key"]

    def index(doc):
        rows = doc.get(field) if isinstance(doc, dict) else None
        out = {}
        if isinstance(rows, list):
            for row in rows:
                if isinstance(row, dict):
                    out[tuple(row.get(f) for f in key)] = row
        return out

    b_map, t_map, o_map = index(base), index(theirs), index(ours)
    out = {}
    for k in set(b_map) | set(t_map) | set(o_map):
        if k in b_map:
            out[k] = b_map[k]
        elif k in t_map and k in o_map:
            t, o = t_map[k], o_map[k]
            if t == o:
                out[k] = t
            elif t_asof != o_asof:
                out[k] = t if t_asof < o_asof else o
            else:
                out[k] = t if canonical(t) <= canonical(o) else o
        else:
            out[k] = t_map.get(k, o_map.get(k))

    # ORDER: keep the base's rows exactly where they are and place only the NEW
    # rows, at the end for an append-ordered list and at the front for the
    # newest-first one (`history.insert(0, entry)`). Sorting the whole list would
    # reorder rows nobody touched -- cosmetic churn in a data commit, and the
    # committed model_tuning history is not in strict timestamp order anyway
    # (two writers stamp at the start of their own run). New rows are sorted
    # among themselves so the result is chronological where the writer's is.
    def sort_key(k):
        return tuple("" if v is None else str(v) for v in k)

    desc = spec["order"] == "desc"
    kept = [k for k in index(base) if k in out] if isinstance(base, dict) else []
    fresh = sorted((k for k in out if k not in set(kept)), key=sort_key, reverse=desc)
    order = fresh + kept if desc else kept + fresh
    return [out[k] for k in order]


# --- document -------------------------------------------------------------

def merge_docs(base, theirs, ours, shape):
    if theirs is None and ours is None:
        raise Refuse("both sides of the merge are absent: nothing to merge")
    if theirs is None:
        return ours
    if ours is None:
        return theirs

    t_asof, o_asof = doc_asof(theirs, shape), doc_asof(ours, shape)
    later = theirs if t_asof > o_asof else ours
    spec = shape["entries"]
    run_specs = {spec["field"]: spec for spec in shape["runs"]}
    monotone = set(shape.get("monotone_true", []))

    out = {}
    for k in ordered_keys(base, theirs, ours):
        if spec and k == spec["field"]:
            out[k] = merge_entries(base, theirs, ours, spec)
        elif k in run_specs:
            out[k] = merge_runs(base, theirs, ours, run_specs[k], t_asof, o_asof)
        else:
            b = base.get(k, MISSING) if isinstance(base, dict) else MISSING
            t = theirs.get(k, MISSING)
            o = ours.get(k, MISSING)
            if k in monotone and (t is True or o is True):
                out[k] = True
                continue
            if t is MISSING and o is MISSING:
                val = b
            elif t is MISSING:
                val = o
            elif o is MISSING:
                val = t
            elif t == o:
                val = t
            elif b is not MISSING and o == b:
                val = t
            elif b is not MISSING and t == b:
                val = o
            else:
                val = later.get(k, MISSING)   # the header describes the newest generation
            if val is not MISSING:
                out[k] = val
    return out


def write(doc, path, shape):
    """Match the ledger's own writer byte for byte, so a merge causes no churn."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        if shape["compact"]:
            json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"), sort_keys=False)
        else:
            json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")


# --- selftest -------------------------------------------------------------

def _selftest():
    """Every shape, on a hand-built base/theirs/ours triple.

    Each case carries the two cases the publish loop actually depends on: the
    SAME key appended on both sides (the earlier first sight must survive) and an
    entry one side changed while the other left it exactly as the base had it
    (the change must survive).
    """
    import tempfile

    def shape(path):
        return shape_for(path)

    def merged(base, theirs, ours, path):
        return merge_docs(base, theirs, ours, shape(path))

    # 1. data/estimates/<season>.json -- the player ledger -------------------
    path = "data/estimates/2026.json"
    a, t1, t2 = "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"
    base = {"season": 2026, "generated_utc": a, "as_of_utc": a,
            "runs": [{"as_of_utc": a, "players": 1}],
            "players": {"p1": {"name": "A", "first": {"as_of_utc": a, "shipped_pts": 1.0},
                               "latest": {"as_of_utc": a, "shipped_pts": 1.0},
                               "locked": {}}}}
    theirs = {"season": 2026, "generated_utc": t1, "as_of_utc": t1,
              "runs": [{"as_of_utc": a, "players": 1}, {"as_of_utc": t1, "players": 2}],
              "players": {"p1": {"name": "A", "first": {"as_of_utc": a, "shipped_pts": 1.0},
                                 "latest": {"as_of_utc": t1, "shipped_pts": 1.1},
                                 "locked": {"1": {"as_of_utc": t1, "shipped": 1.1}}},
                          "p3": {"name": "C", "first": {"as_of_utc": t1, "shipped_pts": 3.0},
                                 "latest": {"as_of_utc": t1, "shipped_pts": 3.0},
                                 "locked": {}}}}
    ours = {"season": 2026, "generated_utc": t2, "as_of_utc": t2,
            "runs": [{"as_of_utc": a, "players": 1}, {"as_of_utc": t2, "players": 3}],
            "players": {"p1": {"name": "A", "first": {"as_of_utc": a, "shipped_pts": 1.0},
                               "latest": {"as_of_utc": t2, "shipped_pts": 1.2},
                               "locked": {}},
                        "p2": {"name": "B", "first": {"as_of_utc": t2, "shipped_pts": 2.0},
                               "latest": {"as_of_utc": t2, "shipped_pts": 2.0},
                               "locked": {}},
                        "p3": {"name": "C", "first": {"as_of_utc": t2, "shipped_pts": 3.9},
                               "latest": {"as_of_utc": t2, "shipped_pts": 3.9},
                               "locked": {}}}}
    m = merged(base, theirs, ours, path)
    assert set(m["players"]) == {"p1", "p2", "p3"}, m["players"].keys()
    assert m["players"]["p1"]["first"]["as_of_utc"] == a
    assert m["players"]["p1"]["latest"]["as_of_utc"] == t2, "latest advances"
    assert m["players"]["p1"]["locked"] == {"1": {"as_of_utc": t1, "shipped": 1.1}}, \
        "a lock only the other side had must survive"
    assert m["players"]["p3"]["first"]["as_of_utc"] == t1, "earlier first sight wins"
    assert m["players"]["p3"]["latest"]["shipped_pts"] == 3.0
    assert m["generated_utc"] == t2, "header takes the later as-of"
    assert [r["as_of_utc"] for r in m["runs"]] == [a, t1, t2]

    # 2. data/estimates/parlays_<season>.json -- the leg ledger --------------
    path = "data/estimates/parlays_2026.json"
    leg = lambda sel, seen, **kw: dict(
        {"season": 2026, "week": 1, "game_id": "g1", "market": "moneyline",
         "selection": sel, "model_prob": 0.5, "seen_utc": seen, "locked": True}, **kw)
    base = {"season": 2026, "generated_utc": a, "as_of_utc": a,
            "runs": [{"as_of_utc": a, "legs_added": 1}], "legs": [leg("SEA ML", a)]}
    theirs = {"season": 2026, "generated_utc": t1, "as_of_utc": t1,
              "runs": [{"as_of_utc": a, "legs_added": 1}, {"as_of_utc": t1, "legs_added": 2}],
              "legs": [leg("SEA ML", a, graded="hit"), leg("NE ML", t1),
                       leg("KC ML", t1, model_prob=0.61)]}
    ours = {"season": 2026, "generated_utc": t2, "as_of_utc": t2,
            "runs": [{"as_of_utc": a, "legs_added": 1}, {"as_of_utc": t2, "legs_added": 2}],
            "legs": [leg("SEA ML", a), leg("BUF ML", t2),
                     leg("KC ML", t2, model_prob=0.70)]}
    m = merged(base, theirs, ours, path)
    sels = [l["selection"] for l in m["legs"]]
    assert sels == ["SEA ML", "NE ML", "KC ML", "BUF ML"], sels
    by = {l["selection"]: l for l in m["legs"]}
    assert by["SEA ML"].get("graded") == "hit", "a field only theirs filled must survive"
    assert by["KC ML"]["seen_utc"] == t1 and by["KC ML"]["model_prob"] == 0.61, \
        "same key on both sides: the earlier first sight is the locked one"
    assert [r["as_of_utc"] for r in m["runs"]] == [a, t1, t2]

    # 3. data/my_cards/<season>_wk<NN>.json ---------------------------------
    path = "data/my_cards/2026_wk02.json"
    card = lambda cid, seen, **kw: dict(
        {"card_id": cid, "dial": "even", "seed": "ARI", "model": 0.5,
         "first_seen_utc": seen, "locked": True}, **kw)
    base = {"season": 2026, "week": 2, "generated_utc": a, "pool_generated_utc": a,
            "runs": [{"pool_generated_utc": a, "cards_added": 1}],
            "cards": [card("aaa", a)]}
    theirs = {"season": 2026, "week": 2, "generated_utc": t1, "pool_generated_utc": t1,
              "runs": [{"pool_generated_utc": a, "cards_added": 1},
                       {"pool_generated_utc": t1, "cards_added": 2}],
              "cards": [card("aaa", a), card("bbb", t1), card("ccc", t1, model=0.31)]}
    ours = {"season": 2026, "week": 2, "generated_utc": t2, "pool_generated_utc": t2,
            "runs": [{"pool_generated_utc": a, "cards_added": 1},
                     {"pool_generated_utc": t2, "cards_added": 2}],
            "cards": [card("aaa", a, rank=1), card("ddd", t2), card("ccc", t2, model=0.44)]}
    m = merged(base, theirs, ours, path)
    ids = [c["card_id"] for c in m["cards"]]
    assert ids == ["aaa", "bbb", "ccc", "ddd"], ids
    byid = {c["card_id"]: c for c in m["cards"]}
    assert byid["aaa"].get("rank") == 1, "a field only ours filled must survive"
    assert byid["ccc"]["first_seen_utc"] == t1 and byid["ccc"]["model"] == 0.31
    assert len(m["runs"]) == 3

    # 4. data/parlays/<season>_wk<NN>.json -- the week archive ---------------
    path = "data/parlays/2026_wk01.json"
    base = {"season": 2026, "week": 1, "updated_utc": a, "parlays": [{"id": "old"}],
            "archived_utc": a, "closed": False, "history": [{"updated_utc": a,
                                                             "archived_utc": a}]}
    theirs = dict(base, updated_utc=t1, archived_utc=t1, parlays=[{"id": "t"}],
                  history=base["history"] + [{"updated_utc": t1, "archived_utc": t1}])
    ours = dict(base, updated_utc=t2, archived_utc=t2, parlays=[{"id": "o"}], closed=True,
                history=base["history"] + [{"updated_utc": t2, "archived_utc": t2}])
    m = merged(base, theirs, ours, path)
    assert [h["updated_utc"] for h in m["history"]] == [a, t1, t2]
    assert m["parlays"] == [{"id": "o"}], "the week body follows the later as-of"
    assert m["closed"] is True, "a closed week never re-opens"

    # 5. data/model_tuning.json ---------------------------------------------
    path = "data/model_tuning.json"
    base = {"generated_utc": a, "adopted": False, "weights": {"elo": 1.0},
            "history": [{"generated_utc": a, "kind": "signal_promotion"}]}
    # The writer inserts at the FRONT, so both sides' new entries lead their file;
    # identity is (generated_utc, kind) because the promotion gate and the player
    # fit can archive within the same second (they do, three times, in the
    # committed file).
    theirs = dict(base, history=[{"generated_utc": t1, "kind": "signal_promotion"}]
                  + base["history"])
    ours = dict(base, weights={"elo": 1.5},
                history=[{"generated_utc": t1, "kind": "player_fit"},
                         {"generated_utc": t2, "kind": "signal_promotion"}]
                + base["history"])
    m = merged(base, theirs, ours, path)
    assert [(h["generated_utc"], h["kind"]) for h in m["history"]] == [
        (t2, "signal_promotion"), (t1, "signal_promotion"), (t1, "player_fit"),
        (a, "signal_promotion")], m["history"]
    assert m["weights"] == {"elo": 1.5}, "the only side that changed the weights wins"

    # 6. a side that does not exist at all (add/add, or a deleted stage) -----
    m = merge_docs(None, None, ours, shape(path))
    assert m == ours
    m = merge_docs(None, theirs, None, shape(path))
    assert m == theirs

    # 7. refusals ------------------------------------------------------------
    for bad in ("data/snapshots/2026_wk01_games_open.json",
                "data/game_predictions.json", "app/main.js"):
        try:
            shape_for(bad)
        except Refuse:
            pass
        else:
            raise AssertionError("expected a refusal for %s" % bad)

    # 8. on-disk form: compact for the player ledger, indent=2 elsewhere, and a
    #    trailing newline either way -- the ledgers' own writers do exactly this.
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "compact.json")
        write({"a": 1}, p, shape("data/estimates/2026.json"))
        assert open(p, "rb").read() == b'{"a":1}\n'
        p = os.path.join(tmp, "indent.json")
        write({"a": 1}, p, shape("data/model_tuning.json"))
        assert open(p, "rb").read() == b'{\n  "a": 1\n}\n'

    print("merge_ledgers selftest: ok -- 5 shapes, both refusal paths, on-disk form")


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Three-way merge of an append-only data ledger, by identity.")
    ap.add_argument("base", nargs="?", help="stage 1 (merge base); - if absent")
    ap.add_argument("theirs", nargs="?", help="stage 2 (the new head); - if absent")
    ap.add_argument("ours", nargs="?", help="stage 3 (this run's generation); - if absent")
    ap.add_argument("--path", help="the ledger's repo-relative path; picks the shape")
    ap.add_argument("--out", help="where to write the merged document")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        _selftest()
        return 0
    if not (args.base and args.theirs and args.ours and args.path and args.out):
        ap.error("base, theirs, ours, --path and --out are all required")

    try:
        shape = shape_for(args.path)
        doc = merge_docs(load(args.base), load(args.theirs), load(args.ours), shape)
    except Refuse as exc:
        print("merge_ledgers: REFUSED: %s" % exc, file=sys.stderr)
        return 2
    except ValueError as exc:      # unparseable JSON on any stage
        print("merge_ledgers: %s is not valid JSON: %s" % (args.path, exc),
              file=sys.stderr)
        return 1
    write(doc, args.out, shape)
    print("merge_ledgers: merged %s as %s" % (args.path, shape["name"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
