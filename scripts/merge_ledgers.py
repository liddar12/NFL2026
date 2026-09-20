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
  * a FROZEN parlay card survives from whichever side froze it, and only the
    still-live cards follow the newer generation (G02);
  * pipeline_stages is keyed per workflow: a workflow block only one side has is
    never dropped, and last_success is the per-stage max of both sides (G05);
  * a lock receipt row keeps its grading from whichever side graded it, and its
    earlier locked_utc (G06);
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
# when the file's only append-only part is its history list, and {"field": None}
# when the document IS that body -- a bare list with no header); its `policy`
# names the rule one entry is merged by; `runs` are the as-of keyed run records;
# everything else at the top level is header.

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
        # keyed by card_id and is NOT simply the newer generation's list (G02):
        # a card whose game has kicked off is FROZEN by build_parlay_archive's
        # merge_frozen and is the record of what was offered, so it survives
        # whichever writer stamped it; only the still-live cards follow the newer
        # header. `history` is the append-only part.
        "pattern": r"^data/parlays/[0-9]{4}_wk[0-9]{2}\.json$",
        "entries": {"field": "parlays", "kind": "list", "key": ("card_id",),
                    "first_sight": ("frozen_utc",), "policy": "archive_card"},
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
    {
        "name": "pipeline_stages",
        # data/pipeline_stages.json -- one block per WORKFLOW (scripts/stage_status.py
        # `begin` resets only its own block and re-seeds `last_success` from the file
        # it reads). Both workflows commit this file, so taking either whole side
        # erased the other workflow's entire per-stage record and regressed every one
        # of its `last_success_utc` carries to NEVER on the MODEL card (G05).
        "pattern": r"^data/pipeline_stages\.json$",
        "entries": {"field": "workflows", "kind": "dict",
                    "first_sight": ("run_started_utc",), "policy": "workflow"},
        "runs": [],
        "asof": ["generated_utc"],
        "compact": False,
    },
    {
        "name": "lock_receipts",
        # data/snapshots/<season>_wk<NN>_games_open.json -- the lock receipts, a
        # bare LIST of rows keyed by event_id (no header at all, hence
        # "field": None: the document IS the entry container). resolve_locks
        # grades rows in place from FINAL scores while build_predictions appends
        # new locks, so two writers really can both edit this one snapshot -- and
        # resolving it to one side un-graded a row nobody re-grades that cycle
        # (G06). Written by scripts/harness/snapshot.py with sort_keys=True.
        "pattern": r"^data/snapshots/[0-9]{4}_wk[0-9]{2}_games_open\.json$",
        "entries": {"field": None, "kind": "list", "key": ("event_id",),
                    "first_sight": ("locked_utc",), "policy": "receipt"},
        "runs": [],
        "asof": ["as_of_utc", "locked_utc"],
        "compact": False,
        "sort_keys": True,
    },
]

SNAPSHOT_PATTERN = r"^data/snapshots/"


class Refuse(Exception):
    """A shape this script will not guess at. Exit 2; the caller must fail hard."""


def shape_for(path):
    norm = path.replace("\\", "/").lstrip("./")
    for shape in SHAPES:
        if re.match(shape["pattern"], norm):
            return shape
    if re.match(SNAPSHOT_PATTERN, norm):
        # ONE rule for data/snapshots/, stated here and mirrored in
        # publish_data.sh: the *_games_open.json lock receipts are merged by
        # event_id (they are the one snapshot two writers legitimately both
        # edit -- see the lock_receipts shape); every other snapshot is a
        # per-run immutable file whose name is unique to its run, so a conflict
        # on one is a real anomaly and is never resolved by guesswork (G06).
        raise Refuse(
            "only the lock receipts (data/snapshots/*_games_open.json) are "
            "merged. Every other snapshot is its own immutable point-in-time "
            "file with a name unique to its run, so two writers cannot both "
            "edit one. A conflict there means something else is wrong -- "
            "resolve it by hand: %s" % path)
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
    """The document's own as-of: the first of the shape's fields that is present.

    A bare-list document (the lock receipts) has no header to read, so its as-of
    is the NEWEST stamp among its rows: the side holding the newest lock is the
    later generation.
    """
    if isinstance(doc, list):
        stamps = []
        for row in doc:
            if not isinstance(row, dict):
                continue
            for field in shape["asof"]:
                val = row.get(field)
                if isinstance(val, str) and val:
                    stamps.append(val)
                    break
        return max(stamps) if stamps else ""
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
    if spec["field"] is None:
        body = doc                       # the document itself (the lock receipts)
    elif isinstance(doc, dict):
        body = doc.get(spec["field"])
    else:
        return [], {}
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


# G02 -- the week archive. A frozen card is the record of what was offered when
# its game kicked off; the live cards are a rebuild and belong to the newer
# generation. The base tells us nothing here (a card is frozen or live NOW), so
# this rule reads the two sides only.
def merge_archive_cards(theirs, ours, spec, later_side):
    """The week's cards: every FROZEN card from either side, live cards from the
    later document.

    Order mirrors build_parlay_archive.merge_frozen -- the frozen cards first, in
    the earlier document's order, then the later document's live cards -- so the
    merged week is in the same shape the builder would have written and a merge
    of a file with itself reorders nothing.
    """
    t_order, t_map = index_entries(theirs, spec)
    o_order, o_map = index_entries(ours, spec)
    if later_side == "theirs":
        early_order, early_map, late_order, late_map = o_order, o_map, t_order, t_map
    else:
        early_order, early_map, late_order, late_map = t_order, t_map, o_order, o_map

    def frozen_at(card):
        val = card.get("frozen_utc") if isinstance(card, dict) else None
        return val if isinstance(val, str) and val else ""

    out, placed = [], set()
    for key in early_order + late_order:
        if key in placed:
            continue
        early, late = early_map.get(key), late_map.get(key)
        e_at, l_at = frozen_at(early), frozen_at(late)
        if not e_at and not l_at:
            continue                      # live on both sides: it comes from the
                                          # later set below, in that set's order
        if e_at and l_at:
            # Two frozen copies of one card: the EARLIER freeze is the one that
            # locked it, and its side's fields are what was offered then.
            card = early if e_at <= l_at else late
        else:
            card = early if e_at else late
        out.append(card)
        placed.add(key)
    for key in late_order:                # the live week, as the later run built it
        if key not in placed:
            out.append(late_map[key])
            placed.add(key)
    return out


# G05 -- data/pipeline_stages.json. One block per workflow, and the two
# workflows write it in the same window on Sunday.
def _carry_map(block):
    """Every stage's last known success in `block`: the stored carry plus what the
    block's own stage rows prove. Mirrors scripts/stage_status.py carry_map -- the
    two must agree, or a merge would hand the next `begin` a carry its own stage
    rows contradict."""
    out = {}
    if not isinstance(block, dict):
        return out
    stored = block.get("last_success")
    if isinstance(stored, dict):
        for name, when in stored.items():
            if isinstance(name, str) and isinstance(when, str):
                out[name] = when
    for stage in block.get("stages") or []:
        if not isinstance(stage, dict):
            continue
        name, when = stage.get("name"), stage.get("last_success_utc")
        if isinstance(name, str) and isinstance(when, str):
            if when > out.get(name, ""):
                out[name] = when
    return out


def merge_workflow_blocks(base, theirs, ours, spec):
    """The per-workflow record: a block only one side has is never dropped, a
    block both sides wrote takes the side whose run STARTED later, and
    `last_success` is the per-stage max of both sides so the losing run's carry
    survives the block it lost."""
    _, b_map = index_entries(base, spec)
    t_order, t_map = index_entries(theirs, spec)
    o_order, o_map = index_entries(ours, spec)

    order = []
    for key in list(b_map) + t_order + o_order:
        if key not in order:
            order.append(key)

    def started(block):
        val = block.get("run_started_utc") if isinstance(block, dict) else None
        return val if isinstance(val, str) else ""

    out = {}
    for workflow in order:
        t, o = t_map.get(workflow), o_map.get(workflow)
        if t is None and o is None:
            continue                      # both writers dropped it; so do we
        if t is None or o is None or t == o:
            out[workflow] = t if t is not None else o
            continue
        block = dict(t if started(t) > started(o) else o)
        carry = _carry_map(o)
        for name, when in _carry_map(t).items():
            if when > carry.get(name, ""):
                carry[name] = when
        # stage_status.py writes this map sorted; keep it that way so the next
        # run's own write is not a reordering diff.
        block["last_success"] = dict(sorted(carry.items()))
        out[workflow] = block
    return out


# G06 -- one lock receipt, seen by a grader on one side and an appender on the
# other. `resolved` only ever goes false -> true, and the graded side carries the
# measurement with it.
GRADED_FIELDS = ("resolved", "actual", "brier", "log_loss")


def merge_receipt(base, theirs, ours, later_side):
    """One row of a *_games_open.json lock receipt.

    A row graded on exactly one side keeps that side's grading verbatim -- the
    other side simply has not resolved it yet, and its unresolved copy is not
    news. `locked_utc` is a lock: the earlier stamp is when the row was actually
    locked. Everything else follows the ordinary three-way rules, with the later
    document deciding a genuine both-changed disagreement.
    """
    base = base if isinstance(base, dict) else {}
    graded = None
    if theirs.get("resolved") is True and ours.get("resolved") is not True:
        graded = theirs
    elif ours.get("resolved") is True and theirs.get("resolved") is not True:
        graded = ours

    out = {}
    for k in ordered_keys(base, theirs, ours):
        b = base.get(k, MISSING)
        t = theirs.get(k, MISSING)
        o = ours.get(k, MISSING)
        if graded is not None and k in GRADED_FIELDS:
            val = graded.get(k, MISSING)
        elif k == "locked_utc":
            stamps = [x for x in (t, o) if isinstance(x, str) and x]
            val = min(stamps) if stamps else (t if t is not MISSING else o)
        elif t is MISSING:
            val = o
        elif o is MISSING:
            val = t
        elif t == o:
            val = t
        elif b is not MISSING and o == b:
            val = t                        # only theirs changed it
        elif b is not MISSING and t == b:
            val = o                        # only ours changed it
        else:
            val = t if later_side == "theirs" else o
        if val is not MISSING:
            out[k] = val
    return out


def merge_entry(base, theirs, ours, spec, later_side):
    if theirs is None and ours is None:
        return base
    if theirs is None:
        return ours
    if ours is None:
        return theirs
    if theirs == ours:
        return theirs
    if spec["policy"] == "receipt":
        # One rule for a receipt row, base or no base: a grading is monotone.
        return merge_receipt(base, theirs, ours, later_side)
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


def merge_entries(base, theirs, ours, spec, later_side):
    """Union by identity key: base order first, then whatever each side added.

    Two shapes are not a plain union and say so here: the week archive keeps the
    frozen cards from both sides and the live week from the later document (G02),
    and pipeline_stages is keyed per workflow (G05).
    """
    if spec["policy"] == "archive_card":
        return merge_archive_cards(theirs, ours, spec, later_side)
    if spec["policy"] == "workflow":
        return merge_workflow_blocks(base, theirs, ours, spec)
    b_order, b_map = index_entries(base, spec)
    t_order, t_map = index_entries(theirs, spec)
    o_order, o_map = index_entries(ours, spec)

    order = list(b_order)
    for k in t_order + o_order:
        if k not in order:
            order.append(k)

    merged = []
    for k in order:
        entry = merge_entry(b_map.get(k), t_map.get(k), o_map.get(k), spec,
                            later_side)
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
    later_side = "theirs" if t_asof > o_asof else "ours"
    later = theirs if later_side == "theirs" else ours
    spec = shape["entries"]
    if spec and spec["field"] is None:
        # The document IS the entry container (the lock receipts are a bare
        # list): there is no header to merge, only rows.
        return merge_entries(base, theirs, ours, spec, later_side)
    run_specs = {spec["field"]: spec for spec in shape["runs"]}
    monotone = set(shape.get("monotone_true", []))

    out = {}
    for k in ordered_keys(base, theirs, ours):
        if spec and k == spec["field"]:
            out[k] = merge_entries(base, theirs, ours, spec, later_side)
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
        sort_keys = bool(shape.get("sort_keys"))    # the snapshot writer sorts
        if shape["compact"]:
            json.dump(doc, fh, ensure_ascii=True, separators=(",", ":"),
                      sort_keys=sort_keys)
        else:
            json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=sort_keys)
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
    #    G02's race: theirs froze two cards and closed the week at t1, ours
    #    refreshed the same week at t2 with a card theirs never saw.
    path = "data/parlays/2026_wk01.json"
    cardof = lambda cid, **kw: dict({"parlay_id": "week-2leg-1", "card_id": cid,
                                     "legs": [{"selection": cid + " ML"}]}, **kw)
    base = {"season": 2026, "week": 1, "updated_utc": a,
            "parlays": [cardof("c-base")],
            "archived_utc": a, "closed": False, "history": [{"updated_utc": a,
                                                             "archived_utc": a}]}
    theirs = dict(base, updated_utc=t1, archived_utc=t1, closed=True,
                  parlays=[cardof("c-base", frozen_utc=t1),
                           cardof("c-frozen-A", frozen_utc=t1)],
                  history=base["history"] + [{"updated_utc": t1, "archived_utc": t1}])
    ours = dict(base, updated_utc=t2, archived_utc=t2,
                parlays=[cardof("c-base"), cardof("c-refresh-B")],
                history=base["history"] + [{"updated_utc": t2, "archived_utc": t2}])
    m = merged(base, theirs, ours, path)
    assert [h["updated_utc"] for h in m["history"]] == [a, t1, t2]
    assert [c["card_id"] for c in m["parlays"]] == [
        "c-base", "c-frozen-A", "c-refresh-B"], m["parlays"]
    assert m["parlays"][0]["frozen_utc"] == t1, "a frozen card survives verbatim"
    assert m["closed"] is True, "a closed week never re-opens"
    assert m["updated_utc"] == t2, "the header takes the later as-of"
    # Two frozen copies of one card: the EARLIER freeze is the one that locked it.
    t_early = dict(theirs, parlays=[cardof("c-base", frozen_utc=t1, model_ev=-0.1)])
    o_late = dict(ours, parlays=[cardof("c-base", frozen_utc=t2, model_ev=-0.9)])
    m = merged(base, t_early, o_late, path)
    assert [(c["card_id"], c["frozen_utc"], c["model_ev"]) for c in m["parlays"]] == [
        ("c-base", t1, -0.1)], m["parlays"]
    # A card live on BOTH sides comes from the later document only -- one copy.
    m = merged(base, dict(theirs, parlays=[cardof("c-base", model_ev=-0.1)]),
               dict(ours, parlays=[cardof("c-base", model_ev=-0.9)]), path)
    assert [(c["card_id"], c["model_ev"]) for c in m["parlays"]] == [("c-base", -0.9)]

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

    # 6. data/pipeline_stages.json -- one block per workflow (G05) -----------
    path = "data/pipeline_stages.json"
    stage = lambda name, when: {"name": name, "status": "ok", "exit_code": 0,
                                "started_utc": when, "finished_utc": when,
                                "duration_s": 1.0, "continue_on_error": False,
                                "last_success_utc": when, "note": None}
    block = lambda run, when, rows, carry: {
        "run_id": run, "run_started_utc": when, "run_finished_utc": when,
        "last_success": dict(sorted(carry.items())), "stages": rows}
    base = {"generated_utc": a,
            "workflows": {"daily": block("1", a, [stage("S1", a)], {"S1": a})}}
    # daily re-ran at t1; gameday raced from the same base and never touched daily.
    theirs = {"generated_utc": t1,
              "workflows": {"daily": block("2", t1, [stage("S1", t1)], {"S1": a})}}
    ours = {"generated_utc": t2,
            "workflows": {"daily": base["workflows"]["daily"],
                          "gameday": block("3", t2, [stage("G1", t2)],
                                           {"G1": t2})}}
    m = merged(base, theirs, ours, path)
    assert sorted(m["workflows"]) == ["daily", "gameday"], \
        "a workflow block only one side has is never dropped"
    assert m["workflows"]["daily"]["run_id"] == "2", "the later run's block wins"
    assert m["workflows"]["daily"]["last_success"] == {"S1": t1}
    assert m["workflows"]["gameday"]["last_success"] == {"G1": t2}, \
        "a block only one side wrote is carried over verbatim"
    assert m["generated_utc"] == t2, "the header takes the later as-of"
    # The LOSING side's carry survives the block it lost: daily failed S1 at t2
    # but succeeded at S2, and t1's block knows nothing of S2.
    late_daily = block("4", t2, [stage("S2", t2)], {"S1": a})
    m = merged(base, theirs, {"generated_utc": t2, "workflows": {"daily": late_daily}},
               path)
    assert m["workflows"]["daily"]["run_id"] == "4"
    assert m["workflows"]["daily"]["last_success"] == {"S1": t1, "S2": t2}, \
        "last_success is the per-stage max of both sides"

    # 7. data/snapshots/<season>_wk<NN>_games_open.json -- lock receipts (G06)
    path = "data/snapshots/2026_wk02_games_open.json"
    receipt = lambda eid, when, **kw: dict(
        {"event_id": eid, "event_type": "game", "model": "elo_prior",
         "estimate": False, "as_of_utc": when, "locked_utc": when,
         "probs": [0.65, 0.35], "resolved": False}, **kw)
    base = [receipt("g1", a)]
    # theirs graded g1 from a FINAL score; ours only appended a new lock.
    theirs = [receipt("g1", a, resolved=True, actual=0, brier=0.12, log_loss=0.43)]
    ours = [receipt("g1", a), receipt("g2", t2)]
    m = merged(base, theirs, ours, path)
    assert [r["event_id"] for r in m] == ["g1", "g2"], m
    assert m[0]["resolved"] is True and m[0]["actual"] == 0 and m[0]["brier"] == 0.12, \
        "a grading is never un-done by the side that did not grade"
    # Both sides touched g1 and only one graded it: the grading still survives,
    # and locked_utc is the EARLIER stamp.
    ours2 = [receipt("g1", t2, locked_utc=t2, probs=[0.7, 0.3])]
    m = merged(base, theirs, ours2, path)
    assert m[0]["resolved"] is True and m[0]["brier"] == 0.12
    assert m[0]["locked_utc"] == a, "the earlier lock is when the row was locked"
    assert m[0]["probs"] == [0.7, 0.3], "the later document decides the rest"

    # 8. a side that does not exist at all (add/add, or a deleted stage) -----
    m = merge_docs(None, None, ours, shape(path))
    assert m == ours
    m = merge_docs(None, theirs, None, shape(path))
    assert m == theirs

    # 9. refusals ------------------------------------------------------------
    #    The lock receipts are merged (case 7); every OTHER snapshot is refused,
    #    and publish_data.sh turns that refusal into a hard failure (G06).
    assert shape_for("data/snapshots/2026_wk01_games_open.json")["name"] == "lock_receipts"
    for bad in ("data/snapshots/game_predictions.20260719T031822Z.json",
                "data/snapshots/2026_wk01_props_open.json",
                "data/game_predictions.json", "app/main.js"):
        try:
            shape_for(bad)
        except Refuse:
            pass
        else:
            raise AssertionError("expected a refusal for %s" % bad)

    # 10. on-disk form: compact for the player ledger, indent=2 elsewhere, and a
    #    trailing newline either way -- the ledgers' own writers do exactly this.
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "compact.json")
        write({"a": 1}, p, shape("data/estimates/2026.json"))
        assert open(p, "rb").read() == b'{"a":1}\n'
        p = os.path.join(tmp, "indent.json")
        write({"a": 1}, p, shape("data/model_tuning.json"))
        assert open(p, "rb").read() == b'{\n  "a": 1\n}\n'
        # The receipts are a bare list and their writer sorts every row's keys.
        p = os.path.join(tmp, "receipt.json")
        write([{"b": 1, "a": 2}], p, shape("data/snapshots/2026_wk02_games_open.json"))
        assert open(p, "rb").read() == b'[\n  {\n    "a": 2,\n    "b": 1\n  }\n]\n'

    print("merge_ledgers selftest: ok -- 7 shapes, both refusal paths, on-disk form")


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
