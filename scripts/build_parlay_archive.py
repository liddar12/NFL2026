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
    though only the last state is kept), plus `frozen` (a count) when that refresh
    carried frozen cards forward.
  * The document is parlays.json VERBATIM (season, week, updated_utc, parlays)
    plus archived_utc, closed, history. Nothing is re-derived or re-priced —
    card_id and frozen_utc (below) are the only keys this script adds to a card.

CARD FREEZE (R90/F12). A week stayed mutable until its LAST game ended, so a
Thursday card could be rewritten on Friday — after Thursday's result was known —
and history kept timestamps only. A pre-kickoff LEG ledger proves a leg's price,
never that a particular COMBINATION was offered. So every archived card now carries
  * card_id — a short sha1 over its canonical ordered leg identity (the sorted
    market|selection pairs plus scope and game_id). Reordering legs does not change
    it; changing a leg does. parlay_id stays exactly as it was, for display and for
    the review join (app/review.js, scripts/replay_lab.py), and is NOT part of the
    identity: it carries the card's rank, which moves week to week.
  * frozen_utc — stamped on the first refresh at or after the card's EARLIEST
    relevant kickoff (a game card: its game; a week card: the earliest kickoff among
    the games its legs name, resolved through the schedule by team, and through the
    R58 leg ledger for a prop selection, which names a player). A frozen card is
    kept VERBATIM: the incoming rebuild may neither replace nor remove it. An
    incoming card for that game with a DIFFERENT card_id is appended as a new card,
    so a rank change adds a card instead of overwriting one. `parlays` is the union,
    frozen cards first in their original order, then the live ones.
  A card whose kickoff cannot be resolved is never frozen: absent is unknown, not
  started. Cards for games that have not kicked off still replace their live
  predecessors, and the week still closes when every game is FINAL.
  * index.json: {season, generated_utc, current_week, weeks[]} sorted by week,
    current_week = the week parlays.json holds (the pipeline's default week:
    scripts/build_predictions.current_week — the earliest week not entirely
    FINAL). Rewritten only when an entry changed (generated_utc alone is not a
    change).
  * Canonical JSON (CLAUDE.md): ensure_ascii=True, indent=2, trailing newline.

Pure core (no I/O): week_closed, card_id, upgrade_cards, earliest_kickoff,
merge_frozen, archive_doc, index_doc. Thin shell: run.
  python3 scripts/build_parlay_archive.py --selftest   fixture-driven, never writes data/
  python3 scripts/build_parlay_archive.py --dry-run    prints what would change, writes nothing
  python3 scripts/build_parlay_archive.py              runner / local: archive + index
"""

import argparse
import datetime as dt
import glob
import hashlib
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
LEDGER_NAME = "parlays_%d.json"          # data/estimates/ — the R58 leg ledger
LEDGER_SUBDIR = "estimates"
CARD_ID_LEN = 12                          # sha1 prefix; 48 bits over ~70 cards a week
# G03 — how much of card_id disambiguates a reused rank id (see renamed_parlay_id).
PARLAY_ID_SUFFIX = 6


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


def card_identity(card):
    """The canonical string a card's card_id hashes — its ORDERED LEG IDENTITY.

    scope, the game it attaches to (when it has one) and the card's legs as sorted
    "market|selection" lines. Sorted, so the same bet written in a different leg
    order is the same card. parlay_id is deliberately absent: it carries the rank,
    and a rank is not a bet.
    """
    parts = ["scope=%s" % (card.get("scope") or "")]
    if card.get("game_id") not in (None, ""):
        parts.append("game_id=%s" % (card["game_id"],))
    parts.extend(sorted("%s|%s" % (leg.get("market"), leg.get("selection"))
                        for leg in card.get("legs") or []))
    return "\n".join(parts)


def card_id(card):
    """Short sha1 of card_identity — stable across runs, languages and orderings."""
    digest = hashlib.sha1(card_identity(card).encode("utf-8")).hexdigest()
    return digest[:CARD_ID_LEN]


def with_card_id(card):
    """The card with card_id written next to parlay_id. Already-stamped cards are
    returned as they are, so a re-run adds no churn."""
    if card.get("card_id"):
        return card
    out = {}
    for key, value in card.items():
        out[key] = value
        if key == "parlay_id":
            out["card_id"] = card_id(card)
    if "card_id" not in out:                # a card with no parlay_id: stamp it last
        out["card_id"] = card_id(card)
    return out


def upgrade_cards(doc):
    """Stamp card_id on any card of an OLD-shape archive that lacks one.

    Returns (doc, n_stamped). NOTHING else is touched — not archived_utc, not
    history, not the cards' own fields — because the id is derived from the card
    that is already there: this is a shape upgrade, never a new decision. n_stamped
    == 0 means the document is returned unchanged (same object).
    """
    cards = doc.get("parlays")
    if not isinstance(cards, list):
        return doc, 0
    stamped = [with_card_id(c) if isinstance(c, dict) else c for c in cards]
    changed = sum(1 for old, new in zip(cards, stamped) if old is not new)
    if not changed:
        return doc, 0
    out = dict(doc)
    out["parlays"] = stamped
    return out, changed


def _parse_utc(stamp):
    """'2026-09-18T00:15Z' / '...T00:15:00Z' -> aware datetime; None when unusable.
    Kickoffs and archive stamps differ in precision, so they are never compared as
    strings."""
    if not stamp:
        return None
    text = str(stamp).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        moment = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    return moment.astimezone(dt.timezone.utc)


def week_kickoffs(schedule_games, week):
    """({game_id: kickoff_utc}, {TEAM: game_id}) for one week of the schedule."""
    kickoffs, by_team = {}, {}
    for game in schedule_games or []:
        try:
            if int(game.get("week")) != int(week):
                continue
        except (TypeError, ValueError):
            continue
        gid = str(game.get("game_id"))
        kickoffs[gid] = game.get("kickoff_utc")
        for side in ("home", "away"):
            if game.get(side):
                by_team[str(game[side])] = gid
    return kickoffs, by_team


def ledger_game_index(ledger, week):
    """{(market, selection): game_id} for one week of the R58 leg ledger.

    The ledger is how a PROP selection finds its game: it names a player, not a
    team, so the schedule alone cannot place it."""
    out = {}
    for leg in (ledger or {}).get("legs") or []:
        try:
            if int(leg.get("week")) != int(week):
                continue
        except (TypeError, ValueError):
            continue
        if leg.get("game_id"):
            out[(leg.get("market"), leg.get("selection"))] = str(leg["game_id"])
    return out


def earliest_kickoff(card, kickoffs, by_team, ledger_games):
    """The earliest kickoff of the games this card is played in, or None.

    A game-scope card is its own game. A week-scope card is the earliest of the
    games its legs name — the ledger first (it holds the game a prop was priced
    in), then the team a selection starts with. None means the card could not be
    placed, and an unplaceable card is never treated as started.
    """
    gids = []
    if card.get("game_id") not in (None, ""):
        gids.append(str(card["game_id"]))
    else:
        for leg in card.get("legs") or []:
            gid = ledger_games.get((leg.get("market"), leg.get("selection")))
            if gid is None:
                token = str(leg.get("selection") or "").split(" ")[0]
                gid = by_team.get(token)
            if gid is not None:
                gids.append(str(gid))
    moments = [m for m in (_parse_utc(kickoffs.get(g)) for g in gids) if m is not None]
    if not moments:
        return None
    return min(moments)


def renamed_parlay_id(card):
    """`<parlay_id>~<first 6 of card_id>` — the name an incoming card takes when
    the rank-derived parlay_id it was built with already belongs to a frozen card.

    Derived from the card's own identity, so it is the SAME name on every run: a
    second pass over the same inputs writes the same bytes.
    """
    return "%s~%s" % (card.get("parlay_id"), str(card.get("card_id") or "")[:PARLAY_ID_SUFFIX])


def duplicate_parlay_ids(cards):
    """{parlay_id: n} for every id carried by more than one card. The archive's
    consumers build a Map on parlay_id (scripts/build_review.py, app/review.js),
    so a repeated id applies one bet's bucket, money and review row to another."""
    counts = {}
    for card in cards or []:
        if isinstance(card, dict) and card.get("parlay_id") is not None:
            pid = str(card["parlay_id"])
            counts[pid] = counts.get(pid, 0) + 1
    return {pid: n for pid, n in counts.items() if n > 1}


def merge_frozen(existing_cards, incoming_cards, now, earliest_fn):
    """The union of an open week's archived cards and its rebuild.

    A card whose earliest relevant kickoff is at or before `now` is FROZEN: the
    ARCHIVED copy is carried forward verbatim (plus frozen_utc, stamped once), and
    an incoming card with the same card_id is dropped — the rebuild may not replace
    it. An incoming card with a different card_id is a different bet and is
    appended; if ITS game is already under way it is stamped frozen as it lands, so
    the union is a fixed point and the next run over the same inputs writes nothing.
    Order: the carried-forward frozen cards first, in the order they were archived,
    then the incoming cards in build order.

    G03 — an appended card whose parlay_id is already taken is RENAMED to
    `<parlay_id>~<first 6 of card_id>`. parlay_id carries the card's RANK, so a
    rebuild whose pool no longer offers a leg hands rank 1 to a different bet and
    the archive ends up with two `week-2leg-1` cards; the review's reproduction
    counted 17 such pairs after a single post-kickoff rebuild, and every consumer
    joins on that id, so which bet's grade and money a card gets came down to
    array order. Frozen cards are never renamed — they are verbatim by contract,
    and that promise is older than this one.

    Returns (cards, n_frozen) — n_frozen counts every frozen card in the result.
    """
    def started(card):
        kickoff = earliest_fn(card) if earliest_fn else None
        return kickoff is not None and kickoff <= _parse_utc(now)

    frozen = []
    for card in existing_cards or []:
        if not isinstance(card, dict):
            continue
        if not card.get("frozen_utc") and not started(card):
            continue
        kept = dict(card)
        kept.setdefault("frozen_utc", now)
        frozen.append(kept)
    kept_ids = set(c.get("card_id") for c in frozen)
    taken = set(str(c.get("parlay_id")) for c in frozen if c.get("parlay_id") is not None)
    cards = list(frozen)
    for card in incoming_cards or []:
        if card.get("card_id") in kept_ids:
            continue
        if str(card.get("parlay_id")) in taken:
            card = dict(card)
            card["parlay_id"] = renamed_parlay_id(card)
        if started(card):
            card = dict(card)
            card["frozen_utc"] = now
        taken.add(str(card.get("parlay_id")))
        cards.append(card)
    # Nothing this run appended may repeat an id. Cards carried forward from the
    # archive are NOT checked: the committed week-2 file already holds 13 pairs
    # frozen before this rule existed, and un-freezing them to rename them would
    # break the older promise.
    appended = {str(c.get("parlay_id")) for c in cards[len(frozen):]}
    introduced = set(duplicate_parlay_ids(cards)) & appended
    assert not introduced, (
        "parlay_id collision survived the rename: %s. Every consumer joins on this "
        "id (scripts/build_review.py, app/review.js)." % sorted(introduced))
    return cards, sum(1 for c in cards if c.get("frozen_utc"))


def archive_doc(parlays_doc, existing, closed, now, earliest_fn=None):
    """The archive document for parlays_doc's week, or None when nothing should
    be written.

    existing     the on-disk archive for that week (dict) or None
    closed       week_closed(...) for that week, evaluated now
    earliest_fn  card -> earliest relevant kickoff (aware datetime) or None; the
                 card-freeze gate (see merge_frozen). None freezes nothing.
    Returns (doc, action) with action in
      created | refreshed | closed | unchanged | frozen
    doc is None for unchanged / frozen (nothing to write)."""
    if existing is not None and existing.get("closed") is True:
        return None, "frozen"
    doc = {k: parlays_doc[k] for k in VERBATIM_KEYS if k in parlays_doc}
    for k, v in parlays_doc.items():          # verbatim: any extra top-level key too
        if k not in doc:
            doc[k] = v
    # Every archived card is identified by its legs, and the cards of a game that
    # has kicked off are carried forward verbatim rather than rebuilt (R90/F12).
    incoming = [with_card_id(c) for c in doc.get("parlays") or []]
    cards, n_frozen = merge_frozen((existing or {}).get("parlays"), incoming, now,
                                   earliest_fn)
    doc["parlays"] = cards
    history = list((existing or {}).get("history") or [])
    seen = set(h.get("updated_utc") for h in history)
    upd = parlays_doc.get("updated_utc")
    if upd not in seen:
        entry = {"updated_utc": upd, "archived_utc": now}
        if n_frozen:
            entry["frozen"] = n_frozen
        history.append(entry)
    # R74 — an OPEN week refreshes when its CONTENT changes, even at the same
    # updated_utc. Keying idempotence on the timestamp alone meant a correction
    # to a live slate was silently ignored: the one-leg-per-game-side fix
    # rebuilt week 2's cards and this returned "unchanged", leaving the bad
    # slate archived. A CLOSED week is still never rewritten — that is the
    # record of what shipped and it stays immutable.
    # Compared against the MERGED cards, so a freeze (or a card_id stamped on an
    # old-shape archive) counts as a change and a re-run over the same inputs
    # does not.
    same_cards = (existing or {}).get("parlays") == cards
    if existing is not None and existing.get("updated_utc") == upd \
            and existing.get("closed") is False and not closed and same_cards:
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
        quiet=False, ledger_path=None):
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
    ledger_path = ledger_path or os.path.join(data_dir, LEDGER_SUBDIR, LEDGER_NAME % season)
    ledger = _load_opt(ledger_path) or {}
    arch_dir = os.path.join(data_dir, ARCHIVE_SUBDIR)
    rel_dir = "data/" + ARCHIVE_SUBDIR
    actions = {}
    writes = []          # (path, doc)

    # 0) every archive of this season, card_id stamped where an older shape lacks
    # one. A pure shape upgrade: the id is derived from the card already on disk,
    # so nothing else about the file moves (a CLOSED week is upgraded too — the
    # contract requires the id on every card, and stamping it decides nothing).
    on_disk, upgraded = {}, {}
    for p in sorted(glob.glob(os.path.join(arch_dir, "*_wk*.json"))):
        sw = parse_archive_name(p)
        if sw is None or sw[0] != season:
            continue
        doc_up, n_up = upgrade_cards(_load(p))
        on_disk[sw[1]] = (p, doc_up)
        if n_up:
            upgraded[sw[1]] = n_up

    # 1) the week parlays.json holds: create / refresh / close / unchanged / frozen
    name = archive_name(season, week)
    path = os.path.join(arch_dir, name)
    existing = on_disk.get(week, (path, None))[1]
    kickoffs, by_team = week_kickoffs(games, week)
    ledger_games = ledger_game_index(ledger, week)
    earliest_fn = lambda card: earliest_kickoff(card, kickoffs, by_team, ledger_games)  # noqa: E731
    doc, action = archive_doc(parlays, existing, week_closed(games, week), now,
                              earliest_fn=earliest_fn)
    actions[week] = action
    n_frozen = sum(1 for c in (doc or {}).get("parlays") or [] if c.get("frozen_utc"))
    if n_frozen:
        log("parlay_archive: wk %d %d card(s) frozen (their earliest kickoff has passed; "
            "kept verbatim, the rebuild cannot replace them)" % (week, n_frozen))
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
    for wk, (p, ex) in sorted(on_disk.items()):
        if wk == week or ex.get("closed") is True:
            continue
        if week_closed(games, wk):
            writes.append((p, close_doc(ex, now)))
            actions[wk] = "closed"
            log("parlay_archive: wk %d closed %s/%s (every game FINAL; content kept as last "
                "archived, updated_utc %s)" % (wk, rel_dir, os.path.basename(p), ex.get("updated_utc")))

    # 2b) any upgraded archive nothing else rewrote this run (a closed week, or an
    # open one whose cards did not otherwise change) is written with card_id and
    # NOTHING else changed.
    written_paths = set(p for p, _ in writes)
    for wk, n_up in sorted(upgraded.items()):
        p, ex = on_disk[wk]
        if p in written_paths:
            continue
        writes.append((p, ex))
        if actions.get(wk) in (None, "unchanged", "frozen"):
            actions[wk] = "upgraded"
        log("parlay_archive: wk %d upgraded %s/%s (card_id stamped on %d card(s); "
            "nothing else touched)" % (wk, rel_dir, os.path.basename(p), n_up))

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

def _unstamped(cards):
    """Cards without the two keys the archive itself adds — what parlays.json held."""
    return [{k: v for k, v in c.items() if k not in ("card_id", "frozen_utc")}
            for c in cards]


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
        assert {k: (_unstamped(v) if k == "parlays" else v)
                for k, v in a.items() if k in VERBATIM_KEYS} == src, \
            "parlays.json verbatim, card_id aside"
        assert all(c["card_id"] == card_id(c) for c in a["parlays"]), "every card identified"
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
        # a repricing while open -> refreshed: last state kept, history grows.
        # R90: every week-1 game has kicked off by this `now`, so all three cards
        # are FROZEN and the reprice cannot replace them (same legs, same card_id).
        r3 = run(tmp, fx("parlays_wk1_b.json"), fx("schedule_open.json"),
                 now="2026-09-14T17:00:00Z", quiet=True)
        assert r3["actions"] == {1: "refreshed"} and "parlays/2026_wk01.json" in r3["written"]
        b = _load(wk1)
        assert b["updated_utc"] == "2026-09-14T16:44:00Z" and b["closed"] is False
        assert b["parlays"][0]["legs"][0]["implied_prob"] == 0.55, \
            "the card kicked off: the reprice does NOT replace it"
        assert all(c["frozen_utc"] == "2026-09-14T17:00:00Z" for c in b["parlays"])
        assert _unstamped(b["parlays"]) == _unstamped(a["parlays"]), "frozen cards are verbatim"
        assert b["history"][-1]["frozen"] == 3, "the refresh records how many it carried"
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
    _selftest_freeze(fx)
    print("selftest OK: first sight creates, same as-of unchanged (byte-identical), reprice "
          "refreshes + history, close on every-game-FINAL keeps the cards, closed never "
          "rewritten, dry-run writes nothing, index shape/order/current_week, schemas, "
          "canonical JSON; R90 card freeze: id is leg-order-free, a kicked-off card is kept "
          "verbatim, a rank change appends under a renamed parlay_id, pre-kickoff cards "
          "still replace, an old-shape "
          "archive is upgraded, a re-run writes zero bytes")


def _selftest_freeze(fx):
    """R90/F12 — card-level freezing, on its own fixtures and its own temp dir."""
    tmp = tempfile.mkdtemp(prefix="r90_freeze_")
    try:
        arch = os.path.join(tmp, ARCHIVE_SUBDIR)
        wk1 = os.path.join(arch, "2026_wk01.json")
        sched, led = fx("schedule_open.json"), fx("ledger_wk1.json")
        thu, fri = fx("parlays_wk1_thu.json"), fx("parlays_wk1_fri.json")

        # PURE: identity ignores leg ORDER and parlay_id, and separates scopes.
        card = {"parlay_id": "G1-g1", "scope": "game", "game_id": "G1",
                "legs": [{"market": "moneyline", "selection": "AAA ML"},
                         {"market": "spread", "selection": "AAA -3"}]}
        flipped = dict(card, parlay_id="G1-g7", legs=list(reversed(card["legs"])))
        assert card_id(card) == card_id(flipped), "reordered legs are the same bet"
        assert card_id(card) != card_id(dict(card, game_id="G2"))
        assert card_id(card) != card_id(dict(card, scope="week"))
        assert card_id(card) != card_id(dict(card, legs=card["legs"][:1]))
        assert len(card_id(card)) == CARD_ID_LEN

        # PURE: where a card is played. A game card is its game; a week card is the
        # earliest game its legs name (team through the schedule, prop through the
        # ledger); an unplaceable card has no kickoff at all.
        games = _load(sched)["games"]
        kicks, teams = week_kickoffs(games, 1)
        legs = ledger_game_index(_load(led), 1)
        pick = lambda doc, pid: [c for c in _load(doc)["parlays"] if c["parlay_id"] == pid][0]  # noqa: E731
        ek = lambda c: earliest_kickoff(c, kicks, teams, legs)  # noqa: E731
        assert ek(pick(thu, "G1-g1")) == _parse_utc("2026-09-13T17:00Z")
        assert ek(pick(thu, "week-1")) == _parse_utc("2026-09-13T17:00Z"), "earliest of its games"
        assert ek(pick(thu, "week-2")) == _parse_utc("2026-09-13T17:00Z"), "a prop placed by the ledger"
        assert ek(pick(thu, "week-3")) == _parse_utc("2026-09-14T00:15Z")
        assert earliest_kickoff(pick(thu, "week-2"), kicks, teams, {}) is None, \
            "without the ledger a prop-only card cannot be placed - and is never frozen"

        # Thursday morning, nothing kicked off yet: a plain create.
        r1 = run(tmp, thu, sched, now="2026-09-13T07:00:00Z", quiet=True, ledger_path=led)
        assert r1["actions"] == {1: "created"}
        a = _load(wk1)
        assert not any(c.get("frozen_utc") for c in a["parlays"]), "nothing has started"
        ids = {c["parlay_id"]: c["card_id"] for c in a["parlays"]}

        # Reordered legs, same bets: the ids do not move (still before any kickoff).
        run(tmp, fx("parlays_wk1_thu_reordered.json"), sched, now="2026-09-13T12:00:00Z",
            quiet=True, ledger_path=led)
        rr = _load(wk1)
        assert {c["parlay_id"]: c["card_id"] for c in rr["parlays"]} == ids, \
            "reordering legs is not a new card"
        assert rr["parlays"][0]["legs"][0]["market"] == "spread", "the rebuild did replace them"

        # 2026-09-13T20:00Z: G1 has kicked off (17:00), G2 has not (Sunday 00:15).
        r2 = run(tmp, fri, sched, now="2026-09-13T20:00:00Z", quiet=True, ledger_path=led)
        assert r2["actions"] == {1: "refreshed"}
        f = _load(wk1)
        frozen = [c for c in f["parlays"] if c.get("frozen_utc")]
        live = [c for c in f["parlays"] if not c.get("frozen_utc")]
        # G03 — the rank change lands as a NEW card under a NEW name: rank 1 now
        # names a different bet, and the frozen G1-g1 keeps the id every consumer
        # joins on. Before the rename the archive held two G1-g1 cards and which
        # one got the grade came down to array order.
        newg1 = [c for c in f["parlays"] if c["card_id"] != ids["G1-g1"]
                 and c["legs"][0]["selection"] == "BBB ML"][0]
        renamed = "G1-g1~" + newg1["card_id"][:PARLAY_ID_SUFFIX]
        assert newg1["parlay_id"] == renamed, newg1["parlay_id"]
        assert renamed_parlay_id({"parlay_id": "G1-g1", "card_id": newg1["card_id"]}) == renamed
        assert [c["parlay_id"] for c in frozen] == ["G1-g1", "week-1", "week-2", renamed], \
            "the three carried forward, plus the new G1 card that landed after kickoff"
        assert f["parlays"][:3] == frozen[:3], "carried-forward cards come first, in order"
        assert all(c["frozen_utc"] == "2026-09-13T20:00:00Z" for c in frozen)
        assert _unstamped(frozen[:3]) == _unstamped([c for c in rr["parlays"]
                                                     if c["parlay_id"] in ("G1-g1", "week-1", "week-2")]), \
            "a frozen card is the archived copy, verbatim"
        assert f["history"][-1]["frozen"] == 4
        assert newg1["card_id"] != ids["G1-g1"], "a new bet, a new id"
        assert [c["parlay_id"] for c in f["parlays"]] == \
            ["G1-g1", "week-1", "week-2", renamed, "G2-g1", "week-3"]
        assert not duplicate_parlay_ids(f["parlays"]), "one card, one parlay_id"
        assert [c["parlay_id"] for c in live] == ["G2-g1", "week-3"]
        # a game that has NOT kicked off still reprices in place
        g2 = [c for c in live if c["parlay_id"] == "G2-g1"][0]
        assert g2["legs"][0]["implied_prob"] == 0.58 and g2["card_id"] == ids["G2-g1"]
        assert [c for c in live if c["parlay_id"] == "week-3"][0]["legs"][0]["implied_prob"] == 0.56
        assert not _validate(f, "parlays_archive.schema.json")

        # IDEMPOTENCE: the same inputs again write zero bytes.
        raw = open(wk1, "rb").read()
        r3 = run(tmp, fri, sched, now="2026-09-13T21:00:00Z", quiet=True, ledger_path=led)
        assert r3["actions"] == {1: "unchanged"} and r3["written"] == [], r3
        assert open(wk1, "rb").read() == raw, "a second run over the same inputs changes nothing"

        # The week still closes when every game is FINAL — frozen cards and all.
        r4 = run(tmp, fri, fx("schedule_closed.json"), now="2026-09-15T11:00:00Z",
                 quiet=True, ledger_path=led)
        assert r4["actions"] == {1: "closed"}
        cl = _load(wk1)
        assert cl["closed"] is True
        assert _unstamped(cl["parlays"]) == _unstamped(f["parlays"]), \
            "closing changes the flag, never the cards"
        assert all(c.get("frozen_utc") for c in cl["parlays"]), \
            "by the close every game has kicked off, so every card is frozen"

        # An OLD-shape archive (no card_id) is upgraded on the next refresh: the id
        # is stamped and NOTHING else moves.
        old = json.loads(json.dumps(cl))
        old["closed"] = False
        old["parlays"] = _unstamped(old["parlays"])
        write_json(old, wk1)
        r5 = run(tmp, fx("parlays_wk2.json"), sched, now="2026-09-16T12:00:00Z",
                 quiet=True, ledger_path=led)
        assert r5["actions"][1] == "upgraded", r5
        up = _load(wk1)
        assert all(c["card_id"] == card_id(c) for c in up["parlays"])
        assert _unstamped(up["parlays"]) == old["parlays"], "the cards themselves are untouched"
        assert up["archived_utc"] == old["archived_utc"] and up["history"] == old["history"] \
            and up["updated_utc"] == old["updated_utc"], "an upgrade is not a refresh"
        assert not _validate(up, "parlays_archive.schema.json")
        raw_up = open(wk1, "rb").read()
        r6 = run(tmp, fx("parlays_wk2.json"), sched, now="2026-09-16T13:00:00Z",
                 quiet=True, ledger_path=led)
        assert 1 not in r6["actions"] or r6["actions"][1] != "upgraded", r6
        assert open(wk1, "rb").read() == raw_up, "an upgraded archive is upgraded once"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=DATA, help="data directory (default: data/)")
    ap.add_argument("--parlays", default=None, help="parlays.json path (default: <data>/parlays.json)")
    ap.add_argument("--schedule", default=None, help="schedule_full.json path")
    ap.add_argument("--ledger", default=None,
                    help="R58 leg ledger path (default: <data>/estimates/parlays_<season>.json); "
                         "it places a prop selection in its game for the card freeze")
    ap.add_argument("--now", default=None, help="archived_utc stamp (default: now, UTC)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    run(data_dir=args.data, parlays_path=args.parlays, schedule_path=args.schedule,
        now=args.now, dry_run=args.dry_run, ledger_path=args.ledger)
    return 0


if __name__ == "__main__":
    sys.exit(main())
