#!/usr/bin/env python3
"""Extract the IronHorse architecture model the static map is drawn from.

The map must depict real structures in the code, so every region, edge and
number on it comes from this model rather than from prose. Cargo supplies
crate identity and dependency direction; the Rust sources supply module
terrain, the seam traits and their implementors, and the compatibility
constants; the checked-in guides supply the inference hazards, keyed to the
section that states them.

Constants are read from source and compared against the values ARCHITECTURE.md
claims, so prose drift becomes data the map can show instead of a silent lie.
Surface extraction is regex-based and deliberately shallow: it reports declared
public items, not a resolved name graph.
"""

import argparse
import difflib
import json
from pathlib import Path
import re
import subprocess

ENGINE = Path(__file__).resolve().parents[1]
ROOT = ENGINE.parents[1]
OUTPUT = ENGINE / "architecture-map.json"

# Outer-workspace directories that embed the engine. They are not members of
# the engine workspace, so cargo metadata below never sees them, but a map that
# stops at the workspace edge hides where the engine is actually used.
CONSUMERS = [
    ("rust/endo/src/ironhorse_engine.rs", "Endo daemon engine backend"),
    ("rust/endo/ironhorse-store-sqlite", "SQLite HeapStore backend"),
    ("rust/thixotrope-ironhorse-worker", "Persistent worker process"),
    ("packages/thixotrope/src/ironhorse-engine.js", "Thixotrope engine binding"),
    ("packages/thixotrope/src/ironhorse-runtime.js", "Thixotrope runtime binding"),
]

# The four seams ARCHITECTURE.md is organised around. Each is a trait the
# engine owns and something else implements; the map's value is showing which
# side of each seam a reader's change lands on.
SEAMS = [
    ("SourceCompiler", "ironhorse-vm/src/interp.rs",
     "The VM compiles source at run time. In production the VM does not\n     depend on the compiler."),
    ("HeapStore", "ironhorse-snapshot/src/store.rs",
     "A backend stores bytes. The snapshot layer keeps the codec and the\n     validation."),
    ("GcHooks", "ironhorse-vm/src/gc.rs",
     "The collector cannot see these references, because they are not in\n     the arenas."),
    ("SideTable", "ironhorse-snapshot/src/sidetable.rs",
     "Each machine field receives one classification for persistence."),
]

# Compatibility identifiers. A restore is gated on all of them agreeing, so a
# map that prints one and omits the others invites exactly the wrong inference.
WATCHED_CONSTS = [
    "COST_TABLE_VERSION",
    "PARSE_METER_RELEASE",
    "IRONHORSE_FORMAT_VERSION",
    "IRONHORSE_FORMAT_VERSION_MIN_READ",
    "STORE_SCHEMA_VERSION",
    "ROW_SCHEMA_VERSION",
    "NATIVE_DEPTH_LIMIT",
]

CONST_RE = re.compile(
    r"^pub const (?P<name>[A-Z][A-Z0-9_]*)\s*:\s*(?P<type>[^=]+?)\s*=\s*(?P<value>.+?);",
    re.MULTILINE,
)
# Only crate-root items are read for the public surface, so these stay anchored
# at column zero; re-exported items nested in modules are not the map's subject.
ITEM_RE = re.compile(
    r"^pub (?:unsafe )?(?P<kind>trait|struct|enum|type|fn|const|mod) (?P<name>[A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)
# Seam declarations and their implementations are routinely indented inside a
# module or macro body, and a trait is as often named through its path
# (`crate::gc::GcHooks`) as bare, so both forms have to be admitted or the seam
# reads as unimplemented.
DECL_TEMPLATE = r"^[ \t]*pub (?:unsafe )?(?P<kind>trait|struct|enum|type) %s\b"
IMPL_RE = re.compile(
    r"^[ \t]*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][A-Za-z0-9_]*::)*"
    r"(?P<trait>[A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?\s+for\s+"
    r"(?P<type>[A-Za-z_][A-Za-z0-9_:]*)",
    re.MULTILINE,
)

# Sentences that correct an inference a reader would otherwise draw. Weight
# rises with how specifically the sentence forecloses a wrong conclusion,
# because a bare "is not" is usually just ordinary prose.
HAZARD_PATTERNS = [
    (re.compile(r"\bdo not infer\b", re.I), 5),
    (re.compile(r"\bdoes not (?:mean|imply|describe|certify|prove|cover)\b", re.I), 5),
    (re.compile(r"\bis not evidence\b|\bare not\s+\w+\s*proofs?\b", re.I), 5),
    (re.compile(r"\bdo not assume\b", re.I), 5),
    (re.compile(r"\bnot permission\b", re.I), 5),
    (re.compile(r"\bis neither\b|\bis not a valid\b|\bis not automatically\b", re.I), 4),
    (re.compile(r"\bmust not\b|\bnever\b", re.I), 3),
    (re.compile(r"\bthere is no\b|\bno longer\b|\bis removed\b", re.I), 3),
    (re.compile(r"\bdo not\b|\bdoes not\b|\bcannot\b", re.I), 2),
    (re.compile(r"\bis not\b|\bare not\b|\bnot\b", re.I), 1),
]
HAZARD_SOURCES = ["ARCHITECTURE.md", "README.md"]
HAZARD_KEEP = 18


def run(args, cwd):
    return subprocess.check_output(args, cwd=str(cwd), text=True)


def metadata():
    return json.loads(run([
        "cargo", "metadata", "--locked", "--no-deps", "--format-version", "1",
        "--manifest-path", str(ENGINE / "Cargo.toml"),
    ], ROOT))


def rel(path):
    return str(Path(path).resolve().relative_to(ROOT))


def sources(crate_dir):
    return sorted(p for p in (crate_dir / "src").rglob("*.rs")) if (crate_dir / "src").is_dir() else []


MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def plain(text):
    """Strip inline markup that reads as noise outside its source document.

    Sentences are lifted out of Markdown guides and doc comments into a page
    that renders them as prose, so link syntax and bold markers would otherwise
    appear verbatim. Backticks are kept: they mark real identifiers.
    """
    return MD_LINK_RE.sub(r"\1", text).replace("**", "").strip()


def first_sentence(text, limit=180):
    """The first sentence, truncated at a clause if it runs long."""
    cleaned = plain(" ".join(text.split()))
    sentence = cleaned.split(". ")[0].rstrip(".")
    if len(sentence) > limit:
        cut = sentence.rfind(" ", 0, limit)
        sentence = sentence[:cut if cut > 0 else limit].rstrip(" ,;:") + "…"
    return sentence + ("." if sentence and not sentence.endswith("…") else "")


def leading_doc(text):
    """The first sentence of a `//!` or `///` block, used as a region caption."""
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("//!") or stripped.startswith("///"):
            body = stripped[3:].strip()
            if not body and lines:
                break
            if body:
                lines.append(body)
        elif lines:
            break
        elif stripped and not stripped.startswith("#!") and not stripped.startswith("//"):
            break
    return first_sentence(" ".join(lines)) if lines else ""


def module_entry(path, crate_dir):
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "path": rel(path),
        # The module's own name within the crate, which is how a reader
        # navigates to it, rather than its full path.
        "module": str(path.relative_to(crate_dir / "src")).removesuffix(".rs"),
        "lines": text.count("\n") + (0 if text.endswith("\n") or not text else 1),
        "doc": leading_doc(text),
    }


def test_groups(crate_dir):
    """Test files bucketed by leading token.

    Oracle findings land as `finding_<hash>_<topic>.rs`, so the raw file count
    overstates how many distinct concerns the suite covers.
    """
    tests = crate_dir / "tests"
    if not tests.is_dir():
        return {"count": 0, "groups": {}}
    names = sorted(p.stem for p in tests.glob("*.rs"))
    groups = {}
    for name in names:
        key = name.split("_")[0]
        groups[key] = groups.get(key, 0) + 1
    top = dict(sorted(groups.items(), key=lambda kv: (-kv[1], kv[0]))[:8])
    return {"count": len(names), "groups": top}


def crate_model(package, packages):
    crate_dir = Path(package["manifest_path"]).parent
    lib = next((t for t in package["targets"] if "lib" in t["kind"]), None)
    files = sources(crate_dir)
    modules = [module_entry(p, crate_dir) for p in files]
    root_text = Path(lib["src_path"]).read_text(encoding="utf-8", errors="replace") if lib else ""
    surface = {}
    for match in ITEM_RE.finditer(root_text):
        surface.setdefault(match.group("kind"), []).append(match.group("name"))
    local = {p["name"] for p in packages}
    deps = [
        {"name": d["name"], "kind": d["kind"] or "normal", "optional": bool(d["optional"])}
        for d in sorted(package["dependencies"], key=lambda d: (d["name"], d["kind"] or ""))
        if d["name"] in local and d.get("path")
    ]
    return {
        "name": package["name"],
        "description": package.get("description") or "",
        "dir": rel(crate_dir),
        "lib_root": rel(lib["src_path"]) if lib else None,
        "doc": leading_doc(root_text),
        "forbids_unsafe": bool(re.search(r"(?m)^#!\[forbid\(unsafe_code\)\]$", root_text)),
        "lines": sum(m["lines"] for m in modules),
        "module_count": len(modules),
        # Ordered by size: the largest modules are where a reader actually gets
        # lost, and the map lets them be searched rather than only listed.
        "modules": sorted(modules, key=lambda m: (-m["lines"], m["module"])),
        "surface": {k: sorted(set(v)) for k, v in sorted(surface.items())},
        "deps": deps,
        "tests": test_groups(crate_dir),
    }


def find_item(name, hint_path):
    """Locate a named public item, preferring the documented file."""
    pattern = re.compile(DECL_TEMPLATE % re.escape(name), re.MULTILINE)
    candidates = [ENGINE / hint_path] if (ENGINE / hint_path).is_file() else []
    candidates += [p for p in ENGINE.rglob("*.rs") if "target" not in p.parts]
    for path in candidates:
        text = path.read_text(encoding="utf-8", errors="replace")
        match = pattern.search(text)
        if match:
            line = text[:match.start()].count("\n") + 1
            return {"file": rel(path), "line": line, "kind": match.group("kind")}
    return None


def under_cfg_test(text, offset):
    """Whether `offset` sits inside a `#[cfg(test)]` block of a source file.

    Test implementations of a seam far outnumber the production ones, and a
    map that counts them together makes an unimplemented seam look busy. A
    `#[cfg(test)]` that is not yet closed by a brace at column zero is a
    reliable enough marker for the in-file test modules this repository uses.
    """
    head = text[:offset]
    gate = head.rfind("#[cfg(test)]")
    if gate == -1:
        return False
    return "\n}" not in head[gate:]


def seam_impls(name):
    """Every implementor of a seam trait, inside the workspace and outside it."""
    found = []
    roots = [ENGINE] + [ROOT / c for c, _ in CONSUMERS if (ROOT / c).is_dir()]
    seen = set()
    for root in roots:
        for path in sorted(root.rglob("*.rs")):
            if "target" in path.parts or path in seen:
                continue
            seen.add(path)
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in IMPL_RE.finditer(text):
                if match.group("trait") != name:
                    continue
                in_tests = ("tests" in path.parts or path.stem.endswith("tests")
                            or under_cfg_test(text, match.start()))
                found.append({
                    "type": match.group("type"),
                    "file": rel(path),
                    "line": text[:match.start()].count("\n") + 1,
                    "in_tests": in_tests,
                })
    return sorted(found, key=lambda i: (i["in_tests"], i["file"], i["type"]))


def enum_variants(path, name):
    """A public enum's variants with the first sentence of each doc comment.

    Used for the taxonomies a newcomer has to choose from rather than read
    around: how a field may be persisted, and how execution may stop.
    """
    text = (ENGINE / path).read_text(encoding="utf-8", errors="replace")
    start = re.search(r"^[ \t]*pub enum %s\b" % re.escape(name), text, re.MULTILINE)
    if not start:
        return []
    opening = text.find("{", start.end())
    if opening == -1:
        return []
    # Scanning begins just inside the enum body, so the opening brace is
    # already accounted for. Starting at zero instead ends the scan at the
    # first struct-shaped variant that opens and closes on one line.
    body, depth = [], 1
    for index in range(opening + 1, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                break
        body.append(char)
    variants, doc, nesting, next_value = [], [], 0, 0
    for line in "".join(body).splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            doc.append(stripped[3:].strip())
            continue
        # A struct-shaped variant's own fields are not variants, so only lines
        # at the body's own nesting level are considered.
        match = re.match(
            r"^(?P<name>[A-Z][A-Za-z0-9]*)\s*(?:\((?P<tuple>[^)]*)\))?\s*"
            r"(?:=\s*(?P<value>\d+))?\s*(?:\(|\{|,|$)", stripped)
        if match and nesting == 0:
            # Rust numbers a variant with no explicit discriminant as the
            # previous one plus one, so the running counter is the fallback.
            value = int(match.group("value")) if match.group("value") else next_value
            next_value = value + 1
            variants.append({
                "name": match.group("name"),
                "value": value,
                "doc": first_sentence(" ".join(doc)) if doc else "",
            })
        if stripped and not stripped.startswith("#["):
            doc = []
        nesting += line.count("{") - line.count("}")
    return variants


def seam_model():
    seams = []
    for name, hint, why in SEAMS:
        location = find_item(name, hint)
        if location is None:
            continue
        impls = seam_impls(name)
        seam = {
            "name": name,
            "why": why,
            "owner": hint.split("/")[0],
            **location,
            "implementors": impls,
            "production_implementors": [i for i in impls if not i["in_tests"]],
        }
        # The side-table seam is a classification, not a trait: what crosses it
        # is a verdict on each field, so the verdicts are the seam's surface.
        if name == "SideTable":
            seam["classification"] = enum_variants(hint, "Coverage")
        seams.append(seam)
    return seams


def doc_claims(text):
    """Values ARCHITECTURE.md's identifier table claims, for drift comparison."""
    claims = {}
    for row in text.splitlines():
        if not row.startswith("|"):
            continue
        for name in WATCHED_CONSTS:
            if f"`{name}`" not in row:
                continue
            cells = [c.strip() for c in row.strip("|").split("|")]
            owner = cells[1] if len(cells) > 1 else ""
            number = re.search(r":\s*(\d+)\b", owner) or re.search(r"\b(\d+)\s*$", owner)
            literal = re.search(r"`([a-z][a-z0-9-]*-\d+)`", owner)
            if literal:
                claims[name] = literal.group(1)
            elif number:
                claims[name] = number.group(1)
    return claims


def constants(packages):
    """Compatibility constants, read from source and diffed against the guide."""
    found = {}
    for package in packages:
        crate_dir = Path(package["manifest_path"]).parent
        for path in sources(crate_dir):
            text = path.read_text(encoding="utf-8", errors="replace")
            for match in CONST_RE.finditer(text):
                name = match.group("name")
                if name not in WATCHED_CONSTS or name in found:
                    continue
                found[name] = {
                    "name": name,
                    "value": match.group("value").strip().strip('"'),
                    "type": match.group("type").strip(),
                    "file": rel(path),
                    "line": text[:match.start()].count("\n") + 1,
                }
    claims = doc_claims((ENGINE / "ARCHITECTURE.md").read_text(encoding="utf-8"))
    for name, entry in found.items():
        claimed = claims.get(name)
        entry["documented"] = claimed
        # An alias carries no value of its own, so absence here is not drift.
        entry["drift"] = bool(claimed) and claimed != entry["value"]
    return [found[n] for n in WATCHED_CONSTS if n in found]


def paragraph_sentences(lines):
    """Sentences of a wrapped paragraph, each with the line it starts on.

    `lines` is a list of `(text, line_number)` pairs. Joining first and
    splitting after keeps sentences that wrap across lines intact, while the
    offset table maps each one back to a line a reader can open.
    """
    if not lines:
        return []
    joined, offsets, cursor = [], [], 0
    for text, number in lines:
        offsets.append((cursor, number))
        joined.append(text)
        cursor += len(text) + 1
    body = " ".join(joined)
    results, position = [], 0
    for sentence in re.split(r"(?<=[.;])\s+", body):
        stripped = sentence.strip()
        start = body.find(stripped, position) if stripped else position
        position = start + len(stripped)
        if not stripped:
            continue
        line = next((n for offset, n in reversed(offsets) if offset <= start), lines[0][1])
        results.append((stripped, line))
    return results


def hazards():
    """Inference corrections mined from the guides, keyed to their section.

    The engine's documentation spends much of its length foreclosing wrong
    conclusions. Those sentences are the map's danger markings, so they are
    extracted with their source and heading rather than paraphrased.
    """
    found = []
    for source in HAZARD_SOURCES:
        path = ENGINE / source
        if not path.is_file():
            continue
        heading, in_code = "", False
        # This repository starts each sentence on its own line but still wraps
        # at 80 columns, so a sentence is a run of lines, not one line. Reading
        # line by line silently beheads every wrapped sentence.
        paragraph = []

        def flush():
            sentences = paragraph_sentences(paragraph)
            for index, (sentence, number) in enumerate(sentences):
                if len(sentence) < 40 or len(sentence) > 220:
                    continue
                score = sum(w for p, w in HAZARD_PATTERNS if p.search(sentence))
                if score < 5:
                    continue
                found.append({
                    "text": plain(sentence),
                    # A correction often names only the wrong conclusion and
                    # leaves its subject in the sentence before. Carrying that
                    # sentence keeps the hazard readable away from the guide.
                    "context": plain(sentences[index - 1][0]) if index else "",
                    "source": source,
                    "line": number,
                    "section": heading,
                    "score": score,
                })
            paragraph.clear()

        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.startswith("```"):
                flush()
                in_code = not in_code
                continue
            if in_code or line.startswith("|") or not line.strip():
                flush()
                continue
            if line.startswith("#"):
                flush()
                heading = line.lstrip("#").strip()
                continue
            paragraph.append((line.strip(), number))
        flush()
    found.sort(key=lambda h: (-h["score"], h["source"], h["line"]))
    kept, sections = [], {}
    # Cap per section so one dense chapter cannot crowd out the rest of the map.
    for hazard in found:
        if sections.get(hazard["section"], 0) >= 3:
            continue
        sections[hazard["section"]] = sections.get(hazard["section"], 0) + 1
        kept.append(hazard)
        if len(kept) >= HAZARD_KEEP:
            break
    return sorted(kept, key=lambda h: (h["source"], h["line"]))


# Routes through the codebase for the changes a newcomer is most likely to be
# handed. Each waypoint is verified against the tree below, so a recipe cannot
# quietly keep pointing at a file that moved. The duties themselves are stated
# by ARCHITECTURE.md; what is added here is the path to each one.
RECIPES = [
    {
        "goal": "Add or fix a built-in",
        "note": "The engine calls a built-in through the native dispatcher and an "
                "id enum. The two must agree, or the method does not run.",
        "waypoints": [
            ("ironhorse-vm/src/interp/natives", "The built-in families, one module for each"),
            ("ironhorse-vm/src/interp/natives/dispatch.rs", "The router for a native call"),
            ("ironhorse-vm/src/interp/native_ids.rs", "The native id enum"),
            ("ironhorse-262", "The harness that compares the result"),
        ],
    },
    {
        "goal": "Add a per-instance machine field",
        "note": "A new field has five duties. If you do only the codec, the engine "
                "stores the field but never traces it, or traces it but refuses "
                "to restore it.",
        "waypoints": [
            ("ironhorse-snapshot/src/sidetable.rs", "Give it a persistence classification"),
            ("ironhorse-vm/tests/gc_visitation_registry.rs", "Add it to the GC visitation registry"),
            ("ironhorse-snapshot/src/image.rs", "Encode and decode it"),
            ("ironhorse-vm/src/interp/boot.rs", "Build it again at boot, if it is derived"),
            ("ironhorse-vm/src/interp/persist.rs", "Satisfy the quiescence and checkpoint gates"),
        ],
    },
    {
        "goal": "Change a cost or a charging point",
        "note": "The weights and the policy share one release identity. Releases "
                "3, 4 and 5 use the same weights and different policy. "
                "Therefore the digest cannot separate them.",
        "waypoints": [
            ("ironhorse-meter/src/lib.rs", "The frozen weights and the release literal"),
            ("ironhorse-meter/src/releases.rs", "Add a release. Never change an old pin."),
            ("ironhorse-vm/tests/golden_computrons.rs", "Update golden vectors in the same commit"),
        ],
    },
    {
        "goal": "Change a persisted row",
        "note": "A row change is a schema change, not an edit. It increases the "
                "container version and the store version. You must also add a "
                "migration step or a refusal.",
        "waypoints": [
            ("ironhorse-vm/src/snapshot_api.rs", "The row declarations and their version"),
            ("ironhorse-snapshot/tests/fixtures/row_schema_releases.tsv", "Append-only fingerprint ledger"),
            ("scripts/check-row-schema.py", "The check that CI does against your base"),
            ("ironhorse-snapshot/src/versions.rs", "The version rules and their effects"),
        ],
    },
    {
        "goal": "Add a storage backend",
        "note": "A backend supplies bytes. The codec and the validation stay in "
                "the snapshot layer. The commit token keeps one admission "
                "path for all backends.",
        "waypoints": [
            ("ironhorse-snapshot/src/store.rs", "HeapStore and HeapStoreCommit"),
            ("ironhorse-snapshot/src/store_suite.rs", "The test suite for each backend"),
            ("rust/endo/ironhorse-store-sqlite", "An example backend outside the workspace"),
        ],
    },
    {
        "goal": "Diagnose a refused restore",
        "note": "Several identities control adoption, and each one fails "
                "independently. Find the identity that refused before you "
                "change any code.",
        "waypoints": [
            ("ironhorse-snapshot/src/format.rs", "Container format version"),
            ("ironhorse-snapshot/src/store.rs", "Store schema version"),
            ("ironhorse-meter/src/lib.rs", "Meter release identity"),
            ("ironhorse-snapshot/tests/persist_gates.rs", "Examples of a refusal"),
        ],
    },
]


def recipes():
    """Task routes, with each waypoint verified to exist in the tree."""
    resolved = []
    for recipe in RECIPES:
        waypoints = []
        for path, why in recipe["waypoints"]:
            target = ENGINE / path
            if not target.exists():
                target = ROOT / path
            waypoints.append({
                "path": rel(target) if target.exists() else path,
                "why": why,
                "exists": target.exists(),
                "kind": "directory" if target.is_dir() else "file",
            })
        resolved.append({**recipe, "waypoints": waypoints})
    return resolved


def checks():
    """Engine steps CI runs, so the map can show the real verification loop.

    Parsed from the workflow text rather than a YAML model: only step names and
    their command lines are wanted, and that survives without a parser
    dependency.
    """
    workflows = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    found = []
    for path in workflows:
        steps, name, commands, indent = [], None, [], 0
        for line in path.read_text(encoding="utf-8").splitlines():
            step = re.match(r"^(\s*)- name:\s*(.+?)\s*$", line)
            if step:
                if name and commands:
                    steps.append((name, commands))
                name, commands, indent = step.group(2), [], len(step.group(1))
                continue
            run = re.match(r"^\s*run:\s*(.*?)\s*$", line)
            if run and name:
                if run.group(1) and run.group(1) != "|":
                    commands.append(run.group(1))
                continue
            body = re.match(r"^(\s+)(cargo|python3|rustup|yarn)\s+(.*?)\s*$", line)
            if body and name and len(body.group(1)) > indent:
                commands.append(f"{body.group(2)} {body.group(3)}")
        if name and commands:
            steps.append((name, commands))
        for step_name, step_commands in steps:
            engine = [c for c in step_commands if "rust/engine" in c or "ironhorse" in c]
            if not engine:
                continue
            found.append({
                "workflow": path.name,
                "step": step_name,
                "commands": engine[:4],
            })
    return found


# ARCHITECTURE.md, "Halts, resource admission and determinism": `Halt`
# distinguishes guest and control-flow outcomes from host stops, and a guest
# handler must not catch resource exhaustion or an engine panic. Yield and
# await are `DispatchOutcome` control outcomes, not `Halt` variants at all.
GUEST_OUTCOMES = {"Throw", "Return"}


def halts():
    """The halt taxonomy, each variant marked guest-visible or host stop."""
    variants = enum_variants("ironhorse-vm/src/interp.rs", "Halt")
    for variant in variants:
        variant["kind"] = "guest" if variant["name"] in GUEST_OUTCOMES else "host"
    return variants


# The heap-snapshot layout. The container is a tagged-atom envelope; the paged
# store is the same state cut into rows a backend can write one at a time. Both
# are read from source below, because both carry persisted identities that a
# transcribed diagram would misreport within one release.
FORMAT_SRC = "ironhorse-snapshot/src/format.rs"
ROSTER_SRC = "ironhorse-snapshot/src/snapshot_roster.rs"
STORE_SRC = "ironhorse-snapshot/src/store.rs"
SQLITE_SRC = "rust/endo/ironhorse-store-sqlite/src/lib.rs"

# The five atoms `canonical_atom_order()` writes before it walks the payload
# roster. They are the envelope's own header, not roster rows.
HEADER_ATOMS = ["VERS", "SIGN", "CREA", "BLOC", "HEAP"]

# Several tables carry no comment in the DDL because their names say what they
# hold. The map still needs one line for each, so these supply it; the parsed
# comment wins wherever the source has one.
SQLITE_ROLES = {
    "meta": "The manifest and the store stamps, as key and value.",
    "slot_pages": "One row for each slot page. The row holds the encoded slot records.",
    "chunk_exts": "One row for each chunk extent. The row holds the arena bytes.",
    "small_state": "The framed small state, for a store that predates the section split.",
    "small_sections": "One row for each small-state section, with the section hash.",
}

ATOM_DECL_RE = re.compile(
    r"^pub const (?P<tag>[A-Z_0-9]{4}): FourCc = FourCc\(\*b\"(?P<fourcc>....)\"\);", re.MULTILINE)
ROSTER_ATOM_RE = re.compile(
    r"atom: Some\(crate::format::(?P<tag>[A-Z_0-9]{4})\),\s*"
    r"present\((?P<arg>[a-z_]+)\): (?P<present>[^\n]+?),?\n")
CREATE_TABLE_RE = re.compile(
    r"CREATE TABLE IF NOT EXISTS (?P<name>\w+)\s*\(", re.IGNORECASE)


def atom_docs(text):
    """Each atom tag with the first sentence of its declaration comment."""
    docs, pending = {}, []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("///"):
            pending.append(stripped[3:].strip())
            continue
        match = ATOM_DECL_RE.match(line)
        if match:
            tag = match.group("tag")
            role = first_sentence(" ".join(pending), limit=150)
            # The comments open with "`TAG` — ..."; the tag is already the
            # heading on the map, so the prefix is noise there.
            role = re.sub(r"^`%s`\s*[—-]\s*" % re.escape(tag), "", role)
            docs[tag] = role[:1].upper() + role[1:] if role else ""
        if not stripped.startswith("#["):
            pending = []
    return docs


def container_layout():
    """The container's atom order, taken the way the encoder takes it.

    `canonical_atom_order()` is a const function, so it cannot be evaluated
    here. It writes the five header atoms and then walks the payload roster in
    declaration order, so reading that order reproduces the same sequence. The
    tests compare the result against the list the roster's own test pins.
    """
    text = (ENGINE / FORMAT_SRC).read_text(encoding="utf-8")
    roster = (ENGINE / ROSTER_SRC).read_text(encoding="utf-8")
    docs = atom_docs(text)
    atoms = [{"tag": tag, "role": docs.get(tag, ""), "section": "header",
              "always": True, "condition": ""} for tag in HEADER_ATOMS]
    for match in ROSTER_ATOM_RE.finditer(roster):
        condition = match.group("present").strip()
        always = condition == "true"
        atoms.append({
            "tag": match.group("tag"),
            "role": docs.get(match.group("tag"), ""),
            "section": "payload",
            "always": always,
            # An optional atom is omitted when empty, which is what keeps a
            # machine's container bytes, and its content hash, unchanged.
            "condition": "" if always else condition,
        })
    return atoms


def byte_string(literal):
    """The text of a Rust byte-string literal such as `*b"IRON"`.

    `const_value` strips surrounding quotes, so the literal can arrive here
    with its closing quote already removed; both forms are accepted.
    """
    match = re.search(r'b"([^"]*)"?', literal or "")
    return match.group(1) if match else (literal or "")


def product(expression):
    """Evaluate a literal size expression such as `64 * 1024`.

    Sizes are written in the source as a readable product. The map wants the
    number, and reporting the expression verbatim reads as an extraction bug.
    """
    if not expression:
        return None
    parts = [p.strip().replace("_", "") for p in expression.split("*")]
    if not all(p.isdigit() for p in parts):
        return expression
    value = 1
    for part in parts:
        value *= int(part)
    return str(value)


def const_value(path, name):
    match = re.search(
        r"^pub const %s\s*:\s*[^=]+=\s*(?P<value>.+?);" % re.escape(name),
        (ENGINE / path).read_text(encoding="utf-8"), re.MULTILINE)
    return match.group("value").strip().strip('"') if match else None


def byte_tags(path, prefix):
    """Domain-separation tags, as the readable characters they are written as."""
    text = (ENGINE / path).read_text(encoding="utf-8")
    found = []
    for match in re.finditer(
            r"^pub const (?P<name>%s_[A-Z]+): u8 = b'(?P<char>.)';" % prefix,
            text, re.MULTILINE):
        found.append({"name": match.group("name"), "char": match.group("char")})
    return found


def sqlite_schema():
    """The backend's tables, parsed from the DDL it executes at open."""
    path = ROOT / SQLITE_SRC
    if not path.is_file():
        return {"tables": [], "pragmas": [], "transaction": ""}
    text = path.read_text(encoding="utf-8")
    tables = []
    for match in CREATE_TABLE_RE.finditer(text):
        depth, index = 1, match.end()
        while index < len(text) and depth:
            if text[index] == "(":
                depth += 1
            elif text[index] == ")":
                depth -= 1
            index += 1
        body = text[match.end():index - 1]
        columns = []
        for part in re.split(r",(?![^()]*\))", body):
            cleaned = " ".join(part.replace("\\\"", '"').split())
            cleaned = re.sub(r"^--.*?(?=[A-Za-z(]|$)", "", cleaned).strip()
            if cleaned and not cleaned.startswith("--"):
                columns.append(cleaned)
        # A trailing table option such as WITHOUT ROWID follows the body.
        tail = text[index:index + 40]
        option = "WITHOUT ROWID" if "WITHOUT ROWID" in tail else ""
        # The `--` comment block immediately above a table states its purpose.
        preamble, note_lines = text[:match.start()].splitlines(), []
        for line in reversed(preamble):
            stripped = line.strip()
            if stripped.startswith("--"):
                note_lines.append(stripped.lstrip("-").strip())
                continue
            if stripped:
                break
        note = " ".join(reversed(note_lines))
        name = match.group("name")
        tables.append({
            "name": name,
            "columns": columns,
            "option": option,
            "note": (first_sentence(note.replace("\\\"", '"'), limit=200) if note
                     else SQLITE_ROLES.get(name, "")),
            "documented": bool(note),
        })
    # A pragma is executed in a batch string that may continue into the DDL,
    # so keep only the first statement and drop the read-back probes and the
    # format-string placeholders that are not settings.
    pragmas = set()
    for match in re.finditer(r'"PRAGMA ([^"]+)"', text):
        statement = match.group(1).split(";")[0].strip()
        if "=" in statement and "{" not in statement:
            pragmas.add(" ".join(statement.split()))
    pragmas = sorted(pragmas)
    behavior = re.search(r"TransactionBehavior::(\w+)", text)
    return {
        "tables": sorted(tables, key=lambda t: t["name"]),
        "pragmas": pragmas,
        "transaction": behavior.group(1) if behavior else "",
    }


# A real heap, decoded from a checked-in container so the map can show one
# instead of describing it. The container is captured by
# `ironhorse-snapshot/examples/capture-map-heap.rs` at the current format, so
# the map draws what the engine writes today. Re-run that example after a
# format bump; the map prints the container's own format version, so a stale
# capture shows on the page rather than passing silently.
HEAP_FIXTURE = "architecture-map-heap.container"
HEAP_CAPTURE = "ironhorse-snapshot/examples/capture-map-heap.rs"
PAYLOAD_TAGS = ["None", "Boolean", "Integer", "Number", "String", "Reference", "At", "BigInt"]
SLOT_INDEX_NULL = 0xFFFFFFFF


def walk_atoms(buf, start, end):
    """Yield `(tag, payload)` for the container's `[u32 size][tag][body]` atoms."""
    offset = start
    while offset + 8 <= end:
        size = int.from_bytes(buf[offset:offset + 4], "big")
        if size < 8 or offset + size > end:
            return
        yield buf[offset + 4:offset + 8].decode("latin1"), buf[offset + 8:offset + size]
        offset += size


def chunk_text(bloc, offset):
    """The string a `ChunkOffset` points at.

    The handle addresses the payload; its byte length sits in the four bytes
    before it, written in the host's byte order that `VERS` records, while the
    code units themselves are UTF-16 big-endian.
    """
    if offset < 4 or offset > len(bloc):
        return None
    length = int.from_bytes(bloc[offset - 4:offset], "little")
    if length == 0 or length > 4096 or offset + length > len(bloc):
        return None
    try:
        return bloc[offset:offset + length].decode("utf-16-be")
    except UnicodeDecodeError:
        return None


def record_layout():
    """The serialized slot record's fields, from the codec's own layout table."""
    text = (ENGINE / "ironhorse-snapshot/src/slot_codec.rs").read_text(encoding="utf-8")
    fields = []
    for line in text.splitlines():
        match = re.match(r"^//!\s*\|\s*([0-9]+(?:\.\.[0-9]+)?)\s*\|\s*(.+?)\s*\|\s*$", line)
        if match:
            span = match.group(1)
            first = int(span.split("..")[0])
            last = int(span.split("..")[1]) if ".." in span else first + 1
            fields.append({"offset": first, "end": last, "field": plain(match.group(2))})
    return fields


def heap_sample():
    """Decode the fixture's slot arena into a form the map can draw."""
    path = ENGINE / HEAP_FIXTURE
    if not path.is_file():
        return None
    buf = path.read_bytes()
    total = int.from_bytes(buf[0:4], "big")
    if buf[4:8] != b"XS_M":
        return None
    atoms = dict(walk_atoms(buf, 8, min(total, len(buf))))
    vers, heap, bloc = atoms.get("VERS"), atoms.get("HEAP"), atoms.get("BLOC", b"")
    if not vers or not heap or len(heap) < 12:
        return None

    kinds = enum_variants("ironhorse-vm/src/value.rs", "Kind")
    # `Kind` assigns Closure 9, Reference 10 and Uninitialized 11, which is not
    # their declaration order. Indexing the list by the kind byte therefore
    # mislabels exactly those three, so every lookup goes through the
    # discriminant the source states.
    by_discriminant = {k["value"]: k["name"] for k in kinds}
    records = heap[12:]
    count = len(records) // 20
    strings, seen = [], {}
    rows, histogram = [], {}

    for index in range(count):
        record = records[index * 20:(index + 1) * 20]
        kind = record[0]
        flag = record[1]
        ident = int.from_bytes(record[2:4], "big")
        nxt = int.from_bytes(record[4:8], "big")
        tag = record[8]
        data = record[10:20]
        value, text_index = -1, -1
        if tag in (4, 7):                      # String, BigInt: a chunk handle
            value = int.from_bytes(data[0:4], "big")
            text = chunk_text(bloc, value) if tag == 4 else None
            if text is not None:
                if text not in seen:
                    seen[text] = len(strings)
                    strings.append(text)
                text_index = seen[text]
        elif tag == 5:                         # Reference: a slot handle
            value = int.from_bytes(data[0:4], "big")
        elif tag == 2:                         # Integer
            value = int.from_bytes(data[0:4], "big", signed=True)
        elif tag == 1:                         # Boolean
            value = data[0]
        name = by_discriminant.get(kind, f"?{kind}")
        histogram[name] = histogram.get(name, 0) + 1
        rows.append(f"{kind},{flag},{ident},{nxt},{tag},{value},{text_index}")

    return {
        "source": rel(path),
        "capture": rel(ENGINE / HEAP_CAPTURE),
        "format_version": int.from_bytes(vers[4:8], "big"),
        "slot_width": vers[8] if len(vers) > 8 else None,
        "slot_count": int.from_bytes(heap[0:4], "big"),
        "live": int.from_bytes(heap[8:12], "big"),
        "chunk_bytes": len(bloc),
        "slots_per_page": int(const_value("ironhorse-vm/src/value.rs", "SLOTS_PER_PAGE")),
        "null": SLOT_INDEX_NULL,
        # One compact line per slot keeps the checked-in model reviewable.
        "columns": "kind,flag,id,next,ptag,value,str",
        "slots": rows,
        "strings": strings,
        "histogram": dict(sorted(histogram.items(), key=lambda kv: -kv[1])),
        "kinds": kinds,
        "payload_tags": [
            {"name": name, "id": index}
            for index, name in enumerate(PAYLOAD_TAGS)],
        "payloads": enum_variants("ironhorse-vm/src/value.rs", "Payload"),
        "record_layout": record_layout(),
        # Where a reader goes next for each part of a slot. The map shows these
        # beside the hovered slot so the picture leads back into the code.
        "anchors": {
            "kind": find_item("Kind", "ironhorse-vm/src/value.rs"),
            "slot": find_item("Slot", "ironhorse-vm/src/value.rs"),
            "payload": find_item("Payload", "ironhorse-vm/src/value.rs"),
            "slot_index": find_item("SlotIndex", "ironhorse-vm/src/value.rs"),
            "chunk_offset": find_item("ChunkOffset", "ironhorse-vm/src/value.rs"),
            "codec": {"file": rel(ENGINE / "ironhorse-snapshot/src/slot_codec.rs"), "line": None},
            "gc": find_item("GcHooks", "ironhorse-vm/src/gc.rs"),
        },
    }


def snapshot_layout():
    return {
        "container": {
            "envelope": "XS_M",
            "magic": byte_string(const_value(FORMAT_SRC, "IRONHORSE_MAGIC")),
            "format_version": const_value(FORMAT_SRC, "IRONHORSE_FORMAT_VERSION"),
            "min_read": const_value(FORMAT_SRC, "IRONHORSE_FORMAT_VERSION_MIN_READ"),
            "slot_record_bytes": const_value(
                "ironhorse-snapshot/src/slot_codec.rs", "SLOT_RECORD_BYTES"),
            "atoms": container_layout(),
        },
        "store": {
            "schema_version": const_value(STORE_SRC, "STORE_SCHEMA_VERSION"),
            "slots_per_page": const_value("ironhorse-vm/src/value.rs", "SLOTS_PER_PAGE"),
            "chunk_extent_bytes": product(const_value(
                "ironhorse-vm/src/value.rs", "CHUNK_EXTENT_BYTES")),
            "leaf_tags": byte_tags(STORE_SRC, "LEAF"),
            "tree_tags": byte_tags(STORE_SRC, "TREE"),
        },
        "sqlite": sqlite_schema(),
        "heap": heap_sample(),
    }


def acceptance():
    """The README's per-stage acceptance verdicts.

    A newcomer's costliest wrong assumption is that a subsystem present in the
    tree is a subsystem accepted, so the map carries the repository's own
    verdicts rather than implying completeness from file counts.
    """
    path = ENGINE / "README.md"
    if not path.is_file():
        return []
    rows, in_table = [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("| Stage "):
            in_table = True
            continue
        if in_table:
            if not line.startswith("|"):
                break
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) < 5 or set(cells[0]) <= set("- "):
                continue
            verdict = cells[2].replace("**", "")
            rows.append({
                "stage": cells[0],
                "bar": cells[1],
                "verdict": verdict,
                "evidence": cells[4],
                # Three states drive the map's colour, and the distinction the
                # README draws between "open" and "not met" is preserved.
                "state": ("blocked" if "NOT MET" in cells[2].upper()
                          else "partial" if ("Partial" in verdict or "not" in verdict.lower())
                          else "landed"),
            })
    return rows


def consumers():
    entries = []
    for path, role in CONSUMERS:
        target = ROOT / path
        if not target.exists():
            continue
        if target.is_dir():
            files = [p for p in target.rglob("*.rs") if "target" not in p.parts]
            lines = sum(p.read_text(encoding="utf-8", errors="replace").count("\n") for p in files)
        else:
            lines = target.read_text(encoding="utf-8", errors="replace").count("\n")
        entries.append({"path": path, "role": role, "lines": lines})
    return entries


def commit():
    try:
        return run(["git", "rev-parse", "HEAD"], ROOT).strip()
    except subprocess.CalledProcessError:
        return ""


def build(data):
    members = set(data["workspace_members"])
    packages = sorted((p for p in data["packages"] if p["id"] in members), key=lambda p: p["name"])
    crates = [crate_model(p, packages) for p in packages]
    return {
        "commit": commit(),
        "workspace": rel(ENGINE),
        "crates": crates,
        "totals": {
            "crates": len(crates),
            "lines": sum(c["lines"] for c in crates),
            "modules": sum(c["module_count"] for c in crates),
            "tests": sum(c["tests"]["count"] for c in crates),
        },
        "seams": seam_model(),
        "constants": constants(packages),
        "hazards": hazards(),
        "consumers": consumers(),
        "recipes": recipes(),
        "checks": checks(),
        # How a crank can stop. Newcomers reliably assume a guest `catch` sees
        # all of these; the taxonomy is where that assumption breaks.
        "halts": halts(),
        "acceptance": acceptance(),
        "snapshot": snapshot_layout(),
    }


def render(model):
    return json.dumps(model, indent=2, sort_keys=True) + "\n"


COMMIT_RE = re.compile(r"\b[0-9a-f]{40}\b")


def without_provenance(text):
    """Blank the recorded commit so `--check` compares structure only.

    The model records the commit its links point at, and that changes with
    every commit to the repository. Comparing it would fail this gate on
    unrelated work, while ignoring it still catches any change to the
    structures the map describes.
    """
    return COMMIT_RE.sub("0" * 40, text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="fail when the checked-in model has drifted from source")
    args = parser.parse_args()
    expected = render(build(metadata()))
    if args.check:
        actual = OUTPUT.read_text() if OUTPUT.exists() else ""
        if without_provenance(actual) != without_provenance(expected):
            print("".join(difflib.unified_diff(
                without_provenance(actual).splitlines(True),
                without_provenance(expected).splitlines(True),
                fromfile=str(OUTPUT), tofile="generated")))
            return 1
    else:
        OUTPUT.write_text(expected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
