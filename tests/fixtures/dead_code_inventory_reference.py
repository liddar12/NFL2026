"""Frozen R52 Python inventory before the short-circuit optimization.

Source: scripts/audit_dead_code.py at b56fd8dd50769030a1e9990bdaf570a5599e5096.
Keep this exhaustive reference independent of the optimized implementation.
Its source is retained here so tests do not depend on private Git ancestors.
"""
import ast
import os
import re


def legacy_py_inventory(scanner):
    defs = {}
    for f in scanner.walk(scanner.PY_DIRS, (".py",)):
        try:
            tree = ast.parse(scanner.read(f))
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs[(f, node.name)] = node.lineno
    corpus = {}
    for f in scanner.walk(scanner.PY_CONSUMERS, (".py", ".mjs", ".yml", ".yaml", ".sh")):
        corpus[f] = scanner.read(f)
    dead = []
    for (f, name), line in sorted(defs.items()):
        if name in scanner.ENTRY_PY or name.startswith("__") or name.startswith("test_"):
            continue
        pat = re.compile(r"\b" + re.escape(name) + r"\b")
        own = len(pat.findall(corpus.get(f, "")))
        others = sum(len(pat.findall(src)) for g, src in corpus.items() if g != f)
        if others == 0 and own <= 1:
            dead.append({"file": os.path.relpath(f, scanner.ROOT), "name": name, "line": line})
        elif others == 0:
            dead.append({"file": os.path.relpath(f, scanner.ROOT), "name": name, "line": line, "private_use_only": own - 1})
    return {"defs": len(defs), "unreferenced": [d for d in dead if "private_use_only" not in d],
            "file_private": [d for d in dead if "private_use_only" in d]}
