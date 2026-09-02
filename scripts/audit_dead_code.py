#!/usr/bin/env python3
"""R52 — dead-code inventory (stdlib only, report-only; the gate never removes code).

Scans:
  JS      every export of app/**/*.js against every import in app/, tests/, index.html,
          sw.js (static `import {..} from`, `import x from`, side-effect imports, dynamic
          import(), and `mod.name` uses after a dynamic import). An export used only by
          tests is reported as TEST-ONLY, not dead. Modules nobody imports are ORPHANS.
  Python  top-level def/class in scripts/**/*.py against references anywhere in scripts/,
          tests/, .github/workflows/. main/selftest/_cli entry names and dunder names are
          entry points, never dead.
  Data    data/*.json (top level) referenced by nothing in app/, scripts/, tests/, workflows.

Usage: python3 scripts/audit_dead_code.py [--json out.json] [--selftest]
Exit 0 always (inventory), except --selftest which exits 1 on a broken scanner.
"""
import ast, json, os, re, sys
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
JS_DIRS = ("app",)
JS_CONSUMERS = ("app", "tests", "index.html", "sw.js")
PY_DIRS = ("scripts",)
PY_CONSUMERS = ("scripts", "tests", ".github/workflows")
ENTRY_PY = {"main", "selftest", "build", "run", "cli"}


def walk(rel_dirs, exts):
    for d in rel_dirs:
        p = os.path.join(ROOT, d)
        if os.path.isfile(p):
            if p.endswith(exts):
                yield p
            continue
        for base, dirs, files in os.walk(p):
            dirs[:] = [x for x in dirs if x not in ("node_modules", "__pycache__", ".claude", "worktrees")]
            for f in files:
                if f.endswith(exts):
                    yield os.path.join(base, f)


def read(p):
    with open(p, encoding="utf-8", errors="replace") as fh:
        return fh.read()


# ---- JS ------------------------------------------------------------------
EXPORT_RE = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)", re.M)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\}", re.M)
EXPORT_DEFAULT_RE = re.compile(r"^export\s+default\b", re.M)
IMPORT_NAMED_RE = re.compile(r"import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"]")
IMPORT_DEFAULT_RE = re.compile(r"import\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['\"]([^'\"]+)['\"]")
IMPORT_NS_RE = re.compile(r"import\s*\*\s*as\s*([\w$]+)\s*from\s*['\"]([^'\"]+)['\"]")
IMPORT_SIDE_RE = re.compile(r"import\s*['\"]([^'\"]+)['\"]")
DYN_IMPORT_RE = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")
HTML_SCRIPT_RE = re.compile(r"<script[^>]*src=['\"]([^'\"]+)['\"]")


def resolve(from_file, spec):
    if not spec.startswith("."):
        if spec.startswith("/app/"):
            return os.path.normpath(os.path.join(ROOT, spec.lstrip("/")))
        return None
    return os.path.normpath(os.path.join(os.path.dirname(from_file), spec))


def js_inventory():
    modules = {}
    for f in walk(JS_DIRS, (".js",)):
        src = read(f)
        names = set(EXPORT_RE.findall(src))
        for lst in EXPORT_LIST_RE.findall(src):
            for part in lst.split(","):
                part = part.strip()
                if not part:
                    continue
                names.add(part.split(" as ")[-1].strip())
        modules[f] = {"exports": names, "default": bool(EXPORT_DEFAULT_RE.search(src))}
    uses = defaultdict(lambda: defaultdict(set))     # module -> name -> {consumer files}
    imported_modules = defaultdict(set)              # module -> {consumer files}
    ns_aliases = []                                  # (consumer, alias, module)
    for f in walk(JS_CONSUMERS, (".js", ".mjs", ".html")):
        src = read(f)
        for spec in HTML_SCRIPT_RE.findall(src):
            m = resolve(f, spec if spec.startswith(".") else "/" + spec.lstrip("/"))
            if m:
                imported_modules[m].add(f)
        for names, spec in IMPORT_NAMED_RE.findall(src):
            m = resolve(f, spec)
            if not m:
                continue
            imported_modules[m].add(f)
            for part in names.split(","):
                part = part.strip()
                if part:
                    uses[m][part.split(" as ")[0].strip()].add(f)
        for alias, spec in IMPORT_DEFAULT_RE.findall(src):
            m = resolve(f, spec)
            if m:
                imported_modules[m].add(f); uses[m]["default"].add(f)
        for alias, spec in IMPORT_NS_RE.findall(src):
            m = resolve(f, spec)
            if m:
                imported_modules[m].add(f); ns_aliases.append((f, alias, m, src))
        for spec in IMPORT_SIDE_RE.findall(src):
            m = resolve(f, spec)
            if m:
                imported_modules[m].add(f)
        for spec in DYN_IMPORT_RE.findall(src):
            m = resolve(f, spec)
            if m:
                imported_modules[m].add(f)
                # `const mod = await import(...)` then mod.name / mod.default
                for name in modules.get(m, {}).get("exports", ()):
                    if re.search(r"\.\s*" + re.escape(name) + r"\b", src):
                        uses[m][name].add(f)
                if re.search(r"\.default\b", src):
                    uses[m]["default"].add(f)
    for f, alias, m, src in ns_aliases:
        for name in modules.get(m, {}).get("exports", ()):
            if re.search(re.escape(alias) + r"\.\s*" + re.escape(name) + r"\b", src):
                uses[m][name].add(f)
    # Tests import some modules through COMPUTED dynamic imports (a cache-busted
    # file URL), which no regex can resolve. A test file that names the module's
    # basename and the export as a bare word is counted as a test consumer.
    test_texts = {f: read(f) for f in walk(("tests",), (".mjs", ".js"))}
    dead, test_only, orphans = [], [], []
    for m, info in sorted(modules.items()):
        rel = os.path.relpath(m, ROOT)
        consumers = {c for c in imported_modules.get(m, set()) if c != m}
        if not consumers and not rel.endswith(("main.js", "sw.js")):
            orphans.append(rel)
        for name in sorted(info["exports"]):
            who = {c for c in uses[m].get(name, set()) if c != m}
            src = read(m)
            internal = len(re.findall(r"\b" + re.escape(name) + r"\b", src)) > 1
            if not who:
                base = os.path.basename(m)
                who = {t for t, txt in test_texts.items()
                       if base in txt and re.search(r"\b" + re.escape(name) + r"\b", txt)}
            if not who:
                dead.append({"module": rel, "export": name, "used_internally": internal})
            elif all(os.path.relpath(c, ROOT).startswith("tests/") for c in who):
                test_only.append({"module": rel, "export": name, "tests": sorted(os.path.relpath(c, ROOT) for c in who)})
    return {"modules": len(modules), "dead_exports": dead, "test_only_exports": test_only, "orphan_modules": orphans}


# ---- Python --------------------------------------------------------------
def py_inventory():
    defs = {}
    for f in walk(PY_DIRS, (".py",)):
        try:
            tree = ast.parse(read(f))
        except SyntaxError:
            continue
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defs[(f, node.name)] = node.lineno
    corpus = {}
    for f in walk(PY_CONSUMERS, (".py", ".mjs", ".yml", ".yaml", ".sh")):
        corpus[f] = read(f)
    dead = []
    for (f, name), line in sorted(defs.items()):
        if name in ENTRY_PY or name.startswith("__") or name.startswith("test_"):
            continue
        pat = re.compile(r"\b" + re.escape(name) + r"\b")
        own = len(pat.findall(corpus.get(f, "")))
        others = sum(len(pat.findall(src)) for g, src in corpus.items() if g != f)
        if others == 0 and own <= 1:
            dead.append({"file": os.path.relpath(f, ROOT), "name": name, "line": line})
        elif others == 0:
            dead.append({"file": os.path.relpath(f, ROOT), "name": name, "line": line, "private_use_only": own - 1})
    return {"defs": len(defs), "unreferenced": [d for d in dead if "private_use_only" not in d],
            "file_private": [d for d in dead if "private_use_only" in d]}


# ---- Data ------------------------------------------------------------------
def data_inventory():
    feeds = sorted(f for f in os.listdir(os.path.join(ROOT, "data")) if f.endswith(".json"))
    corpus = "".join(read(f) for f in walk(("app", "scripts", "tests", ".github/workflows", "netlify.toml", "_headers", "index.html", "sw.js"), (".js", ".mjs", ".py", ".yml", ".yaml", ".sh", ".toml", ".html", "_headers")))
    orphan = [f for f in feeds if f not in corpus]
    return {"feeds": len(feeds), "unreferenced_feeds": orphan}


def selftest():
    r = js_inventory(); assert r["modules"] > 20, r["modules"]
    p = py_inventory(); assert p["defs"] > 200, p["defs"]
    d = data_inventory(); assert d["feeds"] > 10
    print("selftest OK: js modules %d, py defs %d, feeds %d" % (r["modules"], p["defs"], d["feeds"]))
    return 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    out = {"js": js_inventory(), "python": py_inventory(), "data": data_inventory()}
    if "--json" in argv:
        with open(argv[argv.index("--json") + 1], "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=2)
    js, py, dt = out["js"], out["python"], out["data"]
    print("JS: %d modules; %d exports with NO importer; %d test-only exports; %d orphan modules" % (
        js["modules"], len(js["dead_exports"]), len(js["test_only_exports"]), len(js["orphan_modules"])))
    for d in js["dead_exports"]:
        print("  DEAD-EXPORT %-34s %-32s %s" % (d["module"], d["export"], "(used inside its module)" if d["used_internally"] else "(unused even internally)"))
    for o in js["orphan_modules"]:
        print("  ORPHAN-MODULE", o)
    print("PY: %d top-level defs; %d unreferenced anywhere; %d file-private only" % (py["defs"], len(py["unreferenced"]), len(py["file_private"])))
    for d in py["unreferenced"]:
        print("  DEAD-DEF  %s:%d %s" % (d["file"], d["line"], d["name"]))
    print("DATA: %d feeds; unreferenced: %s" % (dt["feeds"], ", ".join(dt["unreferenced_feeds"]) or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
