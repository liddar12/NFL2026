#!/usr/bin/env python3
"""R105 — every learning loop's live state, in one record -> data/learning_loops.json.

Owner (2026-10-01): "Show the learning." The MODEL tab's LEARNING RECORD showed
one proposal line; the system has a dozen loops that can move a shipped number,
each deciding on its own record whether a candidate clears its gate. This reads
THOSE records — nothing is re-fitted, re-scored or inferred here — and states,
per loop:

  state   adopted    the latest decision put the candidate live
          held       the latest decision kept the incumbent (and why)
          reverted   a learned change stopped earning its place and was undone
          measuring  a measure-only experiment: it can adopt nothing by design
          absent     the loop's record is not on file (an older deploy)
  why     the loop's OWN reason string, verbatim
  learns  what evidence it learns from; moves: what shipped number it can change
  last_run_utc / runs / live_since_utc where the record carries them

`transitions` is APPEND-ONLY: every time a loop's state differs from the last
build's, one row {utc, loop, from, to, why} is added. That is the learning made
visible over time — a hold turning into an adoption, an adoption reverted. The
file is rewritten only when a state, reason or transition changed, so the
pipelines do not churn it on every run.

  python3 scripts/build_learning_loops.py             write data/learning_loops.json
  python3 scripts/build_learning_loops.py --selftest  offline, writes nothing
"""

import argparse
import datetime as dt
import json
import os
import sys

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
DATA = os.path.join(_ROOT, "data")
OUT_PATH = os.path.join(DATA, "learning_loops.json")

STATES = ("adopted", "held", "reverted", "measuring", "absent")
SOURCES = ("model_tuning.json", "weekly_backtest.json", "kdst_backtest.json",
           "leg_pool_backtest.json", "parlay_backtest.json", "atd_backtest.json",
           "joint_backtest.json", "backup_qb_backtest.json", "weather_backtest.json",
           "qb_depth_backtest.json", "lines_backtest.json", "replay_lab.json")


def _last(history, kind):
    rows = [h for h in history or [] if isinstance(h, dict) and h.get("kind") == kind]
    return rows[-1] if rows else None, len(rows)


def _f(v, d=4):
    return ("%%.%df" % d) % v if isinstance(v, (int, float)) and not isinstance(v, bool) else "—"


def _row(state, why, last_run=None, **extra):
    out = {"state": state, "why": str(why or "").strip() or "no reason recorded",
           "last_run_utc": last_run}
    out.update({k: v for k, v in extra.items() if v is not None})
    return out


# --------------------------------------------------------------------------- #
# one derivation per loop — each reads only its own record                       #
# --------------------------------------------------------------------------- #

def game_params(src):
    mt = src.get("model_tuning.json")
    if not mt:
        return None
    last, n = _last(mt.get("history"), "game_params")
    gp = mt.get("game_params") or {}
    live = ("hfa %s · revert %s · k %s" % (gp.get("hfa_elo"), gp.get("revert"), gp.get("k"))
            if gp else None)
    if not last:
        return _row("held", "no refit archived yet", None, live=live)
    return _row("adopted" if last.get("adopted") else "held", last.get("reason"),
                last.get("generated_utc"), runs=n, live=live,
                live_since_utc=gp.get("adopted_utc"))


def game_signals(src):
    mt = src.get("model_tuning.json")
    if not mt:
        return None
    last, n = _last(mt.get("history"), "signal_promotion")
    if not last:
        return _row("held", "the promotion gate has not archived a run", None)
    return _row("adopted" if last.get("adopted") else "held", last.get("reason"),
                last.get("generated_utc"), runs=n)


def player_signals(src):
    mt = src.get("model_tuning.json")
    if not mt:
        return None
    last, n = _last(mt.get("history"), "player_signal_fit")
    if not last:
        return _row("held", "no player-signal fit archived yet", None)
    auto = last.get("auto") or {}
    action = auto.get("action")
    state = {"adopt": "adopted", "revert": "reverted"}.get(action, "held")
    why = auto.get("reason") or last.get("reason")
    live = mt.get("candidate_signal_weights") or {}
    return _row(state, why, last.get("generated_utc"), runs=n,
                live_since_utc=live.get("adopted_utc"),
                live=("learned weights" if live.get("kind") == "adopt" else "every signal at full strength"))


def weekly_split(src):
    d = src.get("weekly_backtest.json")
    if not d:
        return None
    v = d.get("verdict") or {}
    return _row("adopted" if v.get("adopted") else "held", v.get("reason"), d.get("generated_utc"))


def kdst_split(src):
    d = src.get("kdst_backtest.json")
    if not d:
        return None
    p = d.get("pooled") or {}
    return _row("adopted" if p.get("beats_flat") else "held", p.get("why"), d.get("generated_utc"))


def leg_pool(src):
    d = src.get("leg_pool_backtest.json")
    if not d:
        return None
    v = d.get("verdict") or {}
    return _row("adopted" if v.get("adopt") else "held", v.get("why"), d.get("generated_utc"))


def leg_pool_live(src):
    d = src.get("leg_pool_backtest.json")
    if not d or not isinstance(d.get("live_2026"), dict):
        return None
    lv = d["live_2026"]
    return _row("adopted" if lv.get("applied") else "held", lv.get("reason"), d.get("generated_utc"))


def props_calibration(src):
    d = src.get("parlay_backtest.json")
    if not d:
        return None
    v = ((d.get("props") or {}).get("verdict")) or {}
    return _row("adopted" if v.get("adopted") else "held", v.get("reason"), d.get("generated_utc"))


def spread_model(src):
    d = src.get("parlay_backtest.json")
    if not d:
        return None
    s = d.get("spread") or {}
    edge = s.get("verdict") not in (None, "no_edge")
    why = ("cover model log-loss %s vs a coin flip %s over %s games%s"
           % (_f(s.get("model_cover_log_loss")), _f(s.get("flat_log_loss")), s.get("n", "—"),
              "" if edge else " — no edge, spreads stay priced flat"))
    return _row("adopted" if edge else "held", why, d.get("generated_utc"))


def atd_model(src):
    d = src.get("atd_backtest.json")
    if not d:
        return None
    return _row("adopted" if d.get("adopted") else "held", d.get("verdict"), d.get("generated_utc"))


def joint_pricer(src):
    d = src.get("joint_backtest.json")
    if not d:
        return None
    p = d.get("pooled") or {}
    joint = d.get("pricer") == "joint"
    why = ("held-out log-loss joint %s vs independent %s over %s cards — %s"
           % (_f(p.get("log_loss_joint"), 6), _f(p.get("log_loss_independent"), 6),
              p.get("cards", "—"),
              "the joint model prices same-game cards" if joint
              else "the independent product keeps pricing them"))
    return _row("adopted" if joint else "held", why, d.get("generated_utc"))


def _measure(fname, why_fn):
    def derive(src):
        d = src.get(fname)
        if not d:
            return None
        return _row("measuring", why_fn(d), d.get("generated_utc"))
    return derive


def _verdict_reason(d):
    v = d.get("verdict")
    if isinstance(v, dict):
        return v.get("reason") or v.get("name")
    return "verdict: %s" % v


def _weather(d):
    power = d.get("power") or {}
    n = len(power)
    ok = sum(1 for v in power.values() if isinstance(v, dict) and v.get("powered"))
    v = d.get("verdict") or {}
    return ("%s: %d of %d measured effects have the sample to detect the effect of interest; "
            "%d candidate(s) adoptable" % (str(v.get("name", "no verdict")).replace("_", " "),
                                           ok, n, len(v.get("adoptable_candidates") or [])))


def _qb_depth(d):
    v = d.get("verdict")
    rule = d.get("adoption_rule") or {}
    return ("verdict %s: no candidate clears the %s test at alpha %s over %s families"
            % (v, "one-sided" if "one-sided" in str(rule.get("method")) else "adoption",
               rule.get("alpha", "—"), rule.get("tests", "—"))
            if v in (None, "none") else "verdict: %s" % v)


def _replay(d):
    vs = d.get("variants") or {}
    tally = {}
    for name, v in vs.items():
        if isinstance(v, dict) and v.get("verdict"):
            tally.setdefault(v["verdict"], []).append(name)
    parts = ["%s %s" % (k, ", ".join(sorted(n))) for k, n in sorted(tally.items())]
    return ("candidate parlay rules replayed on %s week(s): %s"
            % (len(d.get("weeks_replayed") or []), "; ".join(parts) or "nothing judged yet"))


# id, group, name, learns, moves, source, derive
LOOPS = [
    ("game_params", "ships", "Game model parameters",
     "every FINAL game 2022-25 + each graded 2026 lock", "every game win probability",
     "model_tuning.json", game_params),
    ("game_signals", "ships", "Game signal weights (promotion gate)",
     "walk-forward 2022-25 finals", "the venue / cold signal weights in game odds",
     "model_tuning.json", game_signals),
    ("player_signals", "ships", "Player signal weights",
     "this season's resolved player-weeks (walk-forward)", "every player projection",
     "model_tuning.json", player_signals),
    ("weekly_split", "ships", "Weekly split (player points per week)",
     "2023-25 player-weeks, held-out 2025", "every player's weekly number",
     "weekly_backtest.json", weekly_split),
    ("kdst_split", "ships", "Kicker / D-ST weekly split",
     "resolved K and D/ST weeks", "K and D/ST weekly numbers",
     "kdst_backtest.json", kdst_split),
    ("leg_pool", "ships", "Parlay leg calibration (wide pool)",
     "41k historical prop legs, walk-forward", "every MY PARLAYS leg probability",
     "leg_pool_backtest.json", leg_pool),
    ("leg_pool_live", "ships", "Parlay leg calibration (2026 layer)",
     "this season's graded legs", "every MY PARLAYS leg probability",
     "leg_pool_backtest.json", leg_pool_live),
    ("props_calibration", "ships", "Slate prop calibration",
     "2024-25 prop outcomes, walk-forward", "prop legs on the slate parlays",
     "parlay_backtest.json", props_calibration),
    ("spread_model", "ships", "Spread cover model",
     "797 games 2023-25", "spread legs (flat until it shows an edge)",
     "parlay_backtest.json", spread_model),
    ("atd_model", "ships", "Anytime-TD model",
     "2023-25 held-out seasons", "every anytime-TD leg and card",
     "atd_backtest.json", atd_model),
    ("joint_pricer", "ships", "Same-game card pricer",
     "held-out seasons of simulated same-game cards", "GAME anytime-TD card prices and sizes",
     "joint_backtest.json", joint_pricer),
    ("backup_qb", "measure", "Backup-QB effect", "QB-out games", "nothing (phase 1 measures only)",
     "backup_qb_backtest.json", _measure("backup_qb_backtest.json", _verdict_reason)),
    ("weather", "measure", "Rain and wind", "outdoor games with weather", "nothing (measure only)",
     "weather_backtest.json", _measure("weather_backtest.json", _weather)),
    ("qb_depth", "measure", "QB depth chart", "QB changes", "nothing (measure only)",
     "qb_depth_backtest.json", _measure("qb_depth_backtest.json", _qb_depth)),
    ("lines", "measure", "Offensive / defensive line injuries", "starter absences",
     "nothing (phase 1 measures only)",
     "lines_backtest.json", _measure("lines_backtest.json", _verdict_reason)),
    ("replay_lab", "measure", "Replay lab (parlay rules)", "this season's graded legs",
     "nothing (adopts nothing)", "replay_lab.json", _measure("replay_lab.json", _replay)),
]


def derive_loops(sources):
    out = []
    for lid, group, name, learns, moves, src, fn in LOOPS:
        row = fn(sources)
        if row is None:
            row = _row("absent", "data/%s is not on file" % src, None)
        out.append(dict({"id": lid, "group": group, "name": name, "learns": learns,
                          "moves": moves, "source": "data/" + src}, **row))
    return out


def summarize(loops):
    return {s: sum(1 for l in loops if l["state"] == s) for s in STATES}


def build(sources, previous, now):
    """(doc, changed). `previous` is the last data/learning_loops.json (or None)."""
    loops = derive_loops(sources)
    prev_state = {l["id"]: l for l in (previous or {}).get("loops") or []}
    transitions = list((previous or {}).get("transitions") or [])
    for l in loops:
        p = prev_state.get(l["id"])
        if p and p.get("state") != l["state"]:
            transitions.append({"utc": now, "loop": l["id"], "name": l["name"],
                                "from": p["state"], "to": l["state"], "why": l["why"]})
    doc = {"kind": "learning_loops", "generated_utc": now,
           "policy": ("Each loop decides on its own record whether a candidate clears its "
                      "gate; this file only reports those decisions, verbatim. transitions "
                      "is append-only."),
           "summary": summarize(loops), "loops": loops, "transitions": transitions}
    same = previous is not None and all(
        previous.get(k) == doc[k] for k in ("summary", "loops", "transitions", "policy"))
    if same:
        return previous, False
    return doc, True


def load_sources(data_dir=DATA):
    out = {}
    for f in SOURCES:
        p = os.path.join(data_dir, f)
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as fh:
                    out[f] = json.load(fh)
            except (OSError, ValueError):
                out[f] = None
    return out


def write(doc, path=OUT_PATH):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2)
        fh.write("\n")


def run(data_dir=DATA, out_path=OUT_PATH, now=None):
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    previous = None
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as fh:
            previous = json.load(fh)
    doc, changed = build(load_sources(data_dir), previous, now)
    if changed:
        write(doc, out_path)
    s = doc["summary"]
    print("learning_loops: %d loops — %d adopted, %d held, %d reverted, %d measuring, %d absent; "
          "%d transition(s) on record%s"
          % (len(doc["loops"]), s["adopted"], s["held"], s["reverted"], s["measuring"],
             s["absent"], len(doc["transitions"]), "" if changed else " (unchanged, not rewritten)"))
    return doc


def selftest():
    mt = {"history": [
        {"kind": "game_params", "generated_utc": "t1", "adopted": False, "reason": "NEVER REGRESS: kept"},
        {"kind": "player_signal_fit", "generated_utc": "t2", "auto": {"action": "hold", "reason": "worse on week 2"}}],
        "game_params": {"hfa_elo": 45.0, "revert": 0.45, "k": 25.0, "adopted_utc": "t0"}}
    src = {"model_tuning.json": mt,
           "weekly_backtest.json": {"generated_utc": "t3", "verdict": {"adopted": True, "reason": "v2 wins"}},
           "joint_backtest.json": {"generated_utc": "t4", "pricer": "independent",
                                   "pooled": {"cards": 10, "log_loss_joint": 0.2, "log_loss_independent": 0.1}},
           "weather_backtest.json": {"generated_utc": "t5", "verdict": {"name": "not_powered"}}}
    d1, ch1 = build(src, None, "2026-10-01T00:00:00Z")
    by = {l["id"]: l for l in d1["loops"]}
    assert ch1 and d1["transitions"] == [], "the first build records no transition"
    assert by["game_params"]["state"] == "held" and by["game_params"]["why"] == "NEVER REGRESS: kept"
    assert by["game_params"]["live_since_utc"] == "t0" and by["game_params"]["runs"] == 1
    assert by["player_signals"]["state"] == "held" and by["player_signals"]["why"] == "worse on week 2"
    assert by["weekly_split"]["state"] == "adopted"
    assert by["joint_pricer"]["state"] == "held" and "independent product" in by["joint_pricer"]["why"]
    assert by["weather"]["state"] == "measuring" and by["weather"]["why"].startswith("not powered")
    assert by["atd_model"]["state"] == "absent", "a missing record is ABSENT, never a guess"
    assert sum(d1["summary"].values()) == len(LOOPS)
    # unchanged inputs: nothing to write, the old document stands
    d1b, ch1b = build(src, d1, "2026-10-02T00:00:00Z")
    assert not ch1b and d1b is d1
    # the player loop adopts, then reverts: two transitions, append-only, reasons verbatim
    mt["history"].append({"kind": "player_signal_fit", "generated_utc": "t6",
                          "auto": {"action": "adopt", "reason": "beats by 0.2"}})
    d2, ch2 = build(src, d1, "2026-10-03T00:00:00Z")
    assert ch2 and d2["transitions"] == [{"utc": "2026-10-03T00:00:00Z", "loop": "player_signals",
                                          "name": "Player signal weights", "from": "held",
                                          "to": "adopted", "why": "beats by 0.2"}], d2["transitions"]
    mt["history"].append({"kind": "player_signal_fit", "generated_utc": "t7",
                          "auto": {"action": "revert", "reason": "now loses to full strength"}})
    d3, _ = build(src, d2, "2026-10-10T00:00:00Z")
    assert [t["to"] for t in d3["transitions"]] == ["adopted", "reverted"]
    assert d3["transitions"][0] == d2["transitions"][0], "append-only"
    assert {l["id"]: l for l in d3["loops"]}["player_signals"]["state"] == "reverted"
    print("selftest OK: each loop's state and reason read verbatim from its own record, a missing "
          "record is absent, unchanged inputs write nothing, adopt -> revert is two append-only "
          "transitions")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        selftest()
        return 0
    run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
