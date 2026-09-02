"""Read-modify-write ONE top-level key of data/meta.json (R49).

meta.json is hand-owned (weights, versions) and was never written by a builder.
R49 adds two builder-maintained records to it — `projection_baseline`
(scripts/build_predictions.py) and `learning_record` (scripts/resolve_estimates.py)
— so this helper exists to change exactly one key, keep every other byte in place
(key order, ensure_ascii, indent=2, trailing newline: the repo convention), and
never touch `weights`. Stdlib only, pure apart from the file it is told to edit.
"""

import json
import os

_THIS = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_THIS, ".."))
META_PATH = os.path.join(_ROOT, "data", "meta.json")

PROTECTED = frozenset({"weights", "season", "models", "optimizer"})


def set_record(key, value, path=META_PATH):
    """Set meta[key] = value and rewrite the file. Returns the new document.
    Refuses to touch a protected key — this is a record writer, not a fitter."""
    if key in PROTECTED:
        raise ValueError("meta_record.set_record may not change %r" % key)
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    doc[key] = value
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=True, indent=2, sort_keys=False)
        fh.write("\n")
    return doc


