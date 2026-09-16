#!/usr/bin/env python3
"""Render the IronHorse onboarding map from the extracted architecture model.

Reads `architecture-map.json` and writes `architecture-map.html`: a single
self-contained technical report a new contributor reads before their first
change. Every region, count, edge and code link is drawn from the model, so the
map cannot describe a structure the tree does not have.

The page is rendered complete and then enhanced: filtering, crate selection and
the halt filter operate on markup that is already present, so the report reads
end to end with scripting unavailable.

Regenerate:  python3 rust/engine/scripts/engine-map-model.py
             python3 rust/engine/scripts/engine-map.py
Drift check: the same two commands with --check.
"""

import argparse
import difflib
import html
import json
from pathlib import Path
import re

ENGINE = Path(__file__).resolve().parents[1]
MODEL = ENGINE / "architecture-map.json"
OUTPUT = ENGINE / "architecture-map.html"
REPO = "https://github.com/endojs/endo-but-for-bots"

# Plate order is the map's zoom sequence: the position of the engine, its
# parts, its interfaces, its execution, and its persistent data. The numbering
# records that sequence, so it is not decoration.
#
# All text that this script writes uses Simplified Technical English: short
# sentences, the active voice, the present tense, and one term for one thing.
# Sentences that the model extracts from the guides stay verbatim, because the
# map presents them as evidence.
PLATES = [
    ("orientation", "Orientation", "What this map shows"),
    ("context", "Position", "The engine and the programs that use it"),
    ("crates", "Crates", "Eleven crates and their dependencies"),
    ("seams", "Seams", "The four interfaces in the engine"),
    ("crank", "Execution", "From source to result with one budget"),
    ("persist", "Persistence", "Classification and the restore gates"),
    ("layout", "Snapshot layout", "The container, the paged store, and SQLite"),
    ("hazards", "Hazards", "Wrong conclusions that the guides correct"),
    ("recipes", "First change", "Steps for the usual tasks"),
    ("checks", "Verification", "The checks that CI does on your branch"),
    ("status", "Acceptance", "Accepted, partial, and not accepted"),
]


COMMIT_RE = re.compile(r"\b[0-9a-f]{12,40}\b")


def strip_commit(text):
    """Blank commit hashes so a drift check compares content, not provenance."""
    return COMMIT_RE.sub("0" * 12, text)


def plate_no(key):
    """The printed number of a plate, so a cross-reference cannot go stale."""
    return f"{[k for k, _, _ in PLATES].index(key):02d}"


def esc(text):
    return html.escape(str(text), quote=True)


CODE_SPAN_RE = re.compile(r"`([^`]+)`")


def rich(text):
    """Escaped text with backticked spans rendered as code.

    Sentences extracted from Rust comments and Markdown guides mark identifiers
    with backticks. Escaping happens first, so the substitution can only wrap
    text that is already inert.
    """
    return CODE_SPAN_RE.sub(r"<code>\1</code>", esc(text))


def link(model, path, line=None, label=None):
    """A code reference that opens the real file at the pinned commit."""
    commit = model.get("commit") or "llm"
    anchor = f"#L{line}" if line else ""
    shown = label if label is not None else path.split("/")[-1]
    return (f'<a class="ref" href="{REPO}/blob/{commit}/{esc(path)}{anchor}" '
            f'title="{esc(path)}">{esc(shown)}</a>')


def layered(crates):
    """Assign each crate a depth from its normal dependency edges.

    Foundations land at depth 0 and sit at the base of the drawing; a crate
    sits one level above the deepest crate it links against. Development edges
    are excluded: the map's claim is about what the production build links, and
    the VM's test-only use of the compiler is exactly the edge that misleads.
    """
    edges = {c["name"]: [d["name"] for d in c["deps"] if d["kind"] == "normal"] for c in crates}
    depth = {}

    def resolve(name, seen=()):
        if name in depth:
            return depth[name]
        if name in seen:
            return 0
        children = [resolve(d, seen + (name,)) for d in edges.get(name, [])]
        depth[name] = 1 + max(children) if children else 0
        return depth[name]

    for name in edges:
        resolve(name)
    return depth


def crate_graph(model):
    """Layered, selectable SVG of the workspace, positioned from its own edges."""
    crates = model["crates"]
    depth = layered(crates)
    levels = {}
    for crate in crates:
        levels.setdefault(depth[crate["name"]], []).append(crate["name"])

    box_w, box_h, gap_x, gap_y, pad = 150, 48, 22, 76, 26
    top = max(levels)
    width = pad * 2 + max(len(n) for n in levels.values()) * (box_w + gap_x) - gap_x
    height = pad * 2 + (top + 1) * (box_h + gap_y) - gap_y

    # Order each level so edges run as vertically as possible, sweeping up from
    # the foundations. Fewer crossings is most of what makes a generated graph
    # readable at a glance.
    edges = {c["name"]: [d for d in c["deps"] if d["name"] in depth] for c in crates}
    pos = {}
    for level in sorted(levels):
        names = levels[level]
        if level:
            names.sort(key=lambda n: (
                sum(pos.get(d["name"], (0,))[0] for d in edges[n] if d["name"] in pos)
                / max(1, len([d for d in edges[n] if d["name"] in pos])), n))
        else:
            names.sort()
        row_w = len(names) * (box_w + gap_x) - gap_x
        start = (width - row_w) / 2
        for index, name in enumerate(names):
            x = start + index * (box_w + gap_x)
            pos[name] = (x + box_w / 2, pad + (top - level) * (box_h + gap_y))

    parts = [
        f'<svg viewBox="0 0 {int(width)} {int(height)}" class="graph" id="crate-graph" '
        f'role="img" aria-label="Dependency graph of the eleven engine crates. The base crates '
        f'are at the bottom. The test harnesses are at the top. Select a crate to see '
        f'its details.">',
        '<defs><marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" '
        'markerHeight="6" orient="auto-start-reverse">'
        '<path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker></defs>',
        '<g class="edges">',
    ]
    for crate in crates:
        x1, y1 = pos[crate["name"]]
        for dep in edges[crate["name"]]:
            x2, y2 = pos[dep["name"]]
            start_y, end_y = y1 + box_h, y2
            mid = (start_y + end_y) / 2
            classes = "edge" + (" edge-dev" if dep["kind"] == "dev" else "")
            classes += " edge-optional" if dep["optional"] else ""
            parts.append(
                f'<path class="{classes}" data-from="{esc(crate["name"])}" '
                f'data-to="{esc(dep["name"])}" '
                f'd="M{x1:.0f} {start_y:.0f} C{x1:.0f} {mid:.0f} {x2:.0f} {mid:.0f} '
                f'{x2:.0f} {end_y:.0f}" marker-end="url(#dep-arrow)"/>')
    parts.append('</g><g class="nodes">')
    for crate in crates:
        name = crate["name"]
        x, y = pos[name]
        short = name.replace("ironhorse-", "")
        oracle = ' node-oracle' if name == "xs-oracle" else ""
        parts.append(
            f'<g class="node{oracle}" data-crate="{esc(name)}" tabindex="0" role="button" '
            f'aria-label="{esc(name)}, {crate["lines"]:,} lines">'
            f'<rect x="{x - box_w / 2:.0f}" y="{y:.0f}" width="{box_w}" height="{box_h}" rx="2"/>'
            f'<text x="{x:.0f}" y="{y + 20:.0f}" text-anchor="middle" class="node-name">'
            f'{esc(short)}</text>'
            f'<text x="{x:.0f}" y="{y + 35:.0f}" text-anchor="middle" class="node-meta">'
            f'{crate["lines"]:,} lines</text></g>')
    parts.append("</g></svg>")
    return "\n".join(parts)


def context_figure():
    return """
<svg viewBox="0 0 880 296" class="figure-svg" role="img" aria-label="The engine
compiles and runs guest JavaScript for the Endo daemon. It writes checkpoints to a heap
store. Only the tests compare it with the XS oracle.">
  <defs><marker id="ctx-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6"
    markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker></defs>

  <rect class="box" x="22" y="28" width="192" height="72" rx="2"/>
  <text x="118" y="58" text-anchor="middle" class="node-name">Guest JavaScript</text>
  <text x="118" y="77" text-anchor="middle" class="node-meta">untrusted source</text>

  <rect class="box box-focus" x="330" y="16" width="240" height="176" rx="2"/>
  <text x="450" y="45" text-anchor="middle" class="node-name">IronHorse</text>
  <text x="450" y="64" text-anchor="middle" class="node-meta">eleven crates, no unsafe Rust</text>
  <line class="hair" x1="352" y1="80" x2="548" y2="80"/>
  <text x="450" y="102" text-anchor="middle" class="node-meta">compile · execute · meter</text>
  <text x="450" y="121" text-anchor="middle" class="node-meta">collect · checkpoint</text>
  <text x="450" y="152" text-anchor="middle" class="node-meta">one Machine,</text>
  <text x="450" y="171" text-anchor="middle" class="node-meta">frozen intrinsics</text>

  <rect class="box" x="680" y="28" width="178" height="72" rx="2"/>
  <text x="769" y="58" text-anchor="middle" class="node-name">Endo daemon</text>
  <text x="769" y="77" text-anchor="middle" class="node-meta">thixotrope worker</text>

  <rect class="box" x="680" y="196" width="178" height="70" rx="2"/>
  <text x="769" y="225" text-anchor="middle" class="node-name">Heap store</text>
  <text x="769" y="244" text-anchor="middle" class="node-meta">SQLite · file · memory</text>

  <rect class="box box-oracle" x="22" y="196" width="192" height="70" rx="2"/>
  <text x="118" y="225" text-anchor="middle" class="node-name">XS oracle</text>
  <text x="118" y="244" text-anchor="middle" class="node-meta">C reference for tests</text>

  <path class="flow" d="M214 64 L326 64" marker-end="url(#ctx-arrow)"/>
  <text x="270" y="55" text-anchor="middle" class="edge-label">source</text>
  <path class="flow" d="M570 62 L676 62" marker-end="url(#ctx-arrow)"/>
  <text x="623" y="53" text-anchor="middle" class="edge-label">result</text>
  <path class="flow" d="M676 90 L570 90" marker-end="url(#ctx-arrow)"/>
  <text x="623" y="106" text-anchor="middle" class="edge-label">budget</text>

  <path class="flow" d="M545 192 L745 192" marker-end="url(#ctx-arrow)"/>
  <text x="648" y="183" text-anchor="middle" class="edge-label">checkpoint</text>
  <path class="flow flow-dashed" d="M700 212 L575 212" marker-end="url(#ctx-arrow)"/>
  <text x="640" y="228" text-anchor="middle" class="edge-label">restore</text>

  <path class="flow flow-oxide flow-dashed" d="M216 214 L330 182" marker-end="url(#ctx-arrow)"/>
  <text x="248" y="180" class="edge-label">differential</text>
</svg>"""


def crank_figure():
    return """
<svg viewBox="0 0 880 330" class="figure-svg" role="img" aria-label="One budget
covers compilation and execution. A resource stop leaves the crank, and guest code
cannot catch it. A throw stays in the crank.">
  <defs><marker id="crank-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6"
    markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker>
    <marker id="crank-stop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6"
    markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0 L8 4 L0 8 z" class="oxide-fill"/></marker></defs>

  <rect class="budget" x="20" y="24" width="786" height="38" rx="2"/>
  <text x="413" y="48" text-anchor="middle" class="node-accent">one meter budget, charged in steps</text>
  <line class="hair-accent" x1="95" y1="62" x2="95" y2="90"/>
  <line class="hair-accent" x1="731" y1="62" x2="731" y2="90"/>

  <rect class="box" x="20" y="92" width="150" height="60" rx="2"/>
  <text x="95" y="118" text-anchor="middle" class="node-name">lex · parse</text>
  <text x="95" y="136" text-anchor="middle" class="node-meta">scope · code</text>

  <rect class="box" x="232" y="92" width="150" height="60" rx="2"/>
  <text x="307" y="118" text-anchor="middle" class="node-name">bytecode</text>
  <text x="307" y="136" text-anchor="middle" class="node-meta">+ symbol atom</text>

  <rect class="box" x="444" y="92" width="150" height="60" rx="2"/>
  <text x="519" y="118" text-anchor="middle" class="node-name">link names</text>
  <text x="519" y="136" text-anchor="middle" class="node-meta">into the realm</text>

  <rect class="box box-focus" x="656" y="92" width="150" height="60" rx="2"/>
  <text x="731" y="118" text-anchor="middle" class="node-name">dispatch loop</text>
  <text x="731" y="136" text-anchor="middle" class="node-meta">opcodes · MOP</text>

  <path class="flow" d="M170 122 L228 122" marker-end="url(#crank-arrow)"/>
  <path class="flow" d="M382 122 L440 122" marker-end="url(#crank-arrow)"/>
  <path class="flow" d="M594 122 L652 122" marker-end="url(#crank-arrow)"/>

  <path class="flow flow-oxide" d="M95 152 L95 208" marker-end="url(#crank-stop)"/>
  <path class="flow flow-oxide" d="M731 152 L731 208" marker-end="url(#crank-stop)"/>

  <rect class="box box-oracle" x="20" y="212" width="786" height="46" rx="2"/>
  <text x="413" y="234" text-anchor="middle" class="node-oxide">host stop — MeterAbort · HeapExhausted · StackOverflow · Panic</text>
  <text x="413" y="251" text-anchor="middle" class="node-meta">goes through all guest handlers; the crank cannot commit</text>

  <path class="flow" d="M806 122 C848 122 848 292 520 292 L474 292" marker-end="url(#crank-arrow)"/>
  <text x="640" y="309" text-anchor="middle" class="edge-label">Throw — a guest handler catches it, or the host receives it</text>
</svg>"""


def gates_figure(model):
    constants = {c["name"]: c for c in model["constants"]}

    def value(name):
        entry = constants.get(name)
        return esc(entry["value"]) if entry else "?"

    # Keep this in step with the box width below.
    label_budget = 19
    gates = [
        ("Container", f'format {value("IRONHORSE_FORMAT_VERSION")}'),
        ("Store", f'schema {value("STORE_SCHEMA_VERSION")}'),
        ("Rows", f'rows {value("ROW_SCHEMA_VERSION")}'),
        ("Meter", value("COST_TABLE_VERSION")),
        ("Boot", "layout + providers"),
    ]
    parts = [
        '<svg viewBox="0 0 880 200" class="figure-svg" role="img" aria-label="Five '
        'separate identities control a restore. If one identity refuses, the restore '
        'stops. Therefore a container that a reader accepts can still refuse to run.">',
        '<defs><marker id="gate-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" '
        'markerHeight="6" orient="auto-start-reverse">'
        '<path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker>'
        '<marker id="gate-stop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" '
        'markerHeight="6" orient="auto-start-reverse">'
        '<path d="M0 0 L8 4 L0 8 z" class="oxide-fill"/></marker></defs>',
        '<text x="12" y="46" class="node-meta">stored bytes</text>',
    ]
    x = 104
    for label, detail in gates:
        if len(detail) > label_budget:
            raise ValueError(
                f"gate label {detail!r} is {len(detail)} characters; the box fits "
                f"{label_budget}. Shorten it or widen the figure.")
        parts.append(
            f'<rect class="box" x="{x}" y="22" width="124" height="54" rx="2"/>'
            f'<text x="{x + 62}" y="46" text-anchor="middle" class="node-name">{esc(label)}</text>'
            f'<text x="{x + 62}" y="64" text-anchor="middle" class="node-meta">{detail}</text>'
            f'<path class="flow" d="M{x + 124} 49 L{x + 144} 49" marker-end="url(#gate-arrow)"/>'
            f'<path class="flow flow-oxide" d="M{x + 62} 76 L{x + 62} 120" '
            f'marker-end="url(#gate-stop)"/>')
        x += 144
    parts.append(
        f'<text x="{x + 2}" y="46" class="node-accent">adopt</text>'
        '<rect class="box box-oracle" x="104" y="124" width="692" height="44" rx="2"/>'
        '<text x="450" y="144" text-anchor="middle" class="node-oxide">'
        'refuse — the engine adopts nothing</text>'
        '<text x="450" y="161" text-anchor="middle" class="node-meta">'
        'there is no general heap translator across meter releases</text></svg>')
    return "\n".join(parts)


def seams_figure(model):
    seams = {s["name"]: s for s in model["seams"]}
    rows = [
        ("SourceCompiler", "the VM owns the trait", "the embedder installs a compiler",
         "this prevents a dependency cycle"),
        ("HeapStore", "the snapshot layer owns the codec", "the backend supplies bytes",
         "a backend must not make its own codec"),
        ("GcHooks", "the collector reads the arenas", "the machine reports external references",
         "a side-table edge is not a root"),
        ("SideTable", "the ledger classifies each field", "each field has a classification",
         "the engine does not store unclassified data"),
    ]
    parts = [
        '<svg viewBox="0 0 880 312" class="figure-svg" role="img" aria-label="Four '
        'seams. The engine owns one side of each seam. An embedder, a backend, or the '
        'machine owns the other side.">',
        '<line class="seam-line" x1="438" y1="14" x2="438" y2="300"/>',
        '<text x="210" y="14" text-anchor="middle" class="edge-label">ENGINE SIDE</text>',
        '<text x="666" y="14" text-anchor="middle" class="edge-label">OTHER SIDE</text>',
    ]
    y = 32
    for name, engine_side, other_side, note in rows:
        seam = seams.get(name, {})
        count = len(seam.get("production_implementors", []))
        tally = (f"{count} production impl{'s' if count != 1 else ''}"
                 if seam.get("kind") == "trait"
                 else f"{len(seam.get('classification', []))} classes")
        parts.append(
            f'<rect class="box box-focus" x="22" y="{y}" width="390" height="52" rx="2"/>'
            f'<text x="38" y="{y + 22}" class="node-name">{esc(name)}</text>'
            f'<text x="38" y="{y + 40}" class="node-meta">{esc(engine_side)}</text>'
            f'<text x="396" y="{y + 22}" text-anchor="end" class="edge-label">{esc(tally)}</text>'
            f'<rect class="box" x="464" y="{y}" width="392" height="52" rx="2"/>'
            f'<text x="480" y="{y + 22}" class="node-name">{esc(other_side)}</text>'
            f'<text x="480" y="{y + 40}" class="node-meta">{esc(note)}</text>')
        y += 70
    parts.append("</svg>")
    return "\n".join(parts)


def figure(svg, caption):
    return f'<figure class="figure">{svg}<figcaption>{caption}</figcaption></figure>'


def plate(index, key, title, kicker, body):
    return f"""<section class="plate" id="{key}">
  <header class="plate-head">
    <span class="plate-no">{index:02d}</span>
    <div>
      <h2>{esc(title)}</h2>
      <p class="kicker">{esc(kicker)}</p>
    </div>
  </header>
  {body}
</section>"""


def orientation_plate(model):
    totals = model["totals"]
    vm = next(c for c in model["crates"] if c["name"] == "ironhorse-vm")
    return f"""
<p class="abstract">IronHorse is a copy of the XS JavaScript engine in Rust. XS is a C
engine from Moddable. The Rust code does not permit <code>unsafe</code>. The Endo daemon
uses IronHorse for four functions. The engine runs untrusted JavaScript and gives
deterministic results. The engine charges the guest code for the work that it does. The
engine stops the guest code during execution. The engine writes the full machine to
disk, and then starts the machine again with the same object graph. These four functions
control almost all of the structure in this map.</p>

<div class="stats">
  <div class="stat"><span class="stat-n">{totals['crates']}</span><span class="stat-l">workspace crates</span></div>
  <div class="stat"><span class="stat-n">{totals['lines']:,}</span><span class="stat-l">lines of engine source</span></div>
  <div class="stat"><span class="stat-n">{vm['lines']:,}</span><span class="stat-l">lines in the VM crate</span></div>
  <div class="stat"><span class="stat-n">{totals['tests']}</span><span class="stat-l">integration test files</span></div>
</div>

<div class="split">
  <div>
    <h3>Read these documents in this sequence</h3>
    <ol class="route">
      <li>Read all of <strong>this map</strong> first. It is the only document for a
        person who has not seen the source tree.</li>
      <li>Read {link(model, 'rust/engine/ARCHITECTURE.md', label='ARCHITECTURE.md')}. It
        is the approved guide to the current engine. Plate {plate_no("hazards")} quotes it.</li>
      <li>Read {link(model, 'rust/engine/README.md', label='README.md')}. It gives the
        acceptance status, the determinism limits, and the oracle build steps.</li>
      <li>Read {link(model, 'designs/ironhorse-engine.md', label='designs/ironhorse-engine.md')}.
        It is the plan that plate {plate_no("status")} measures.</li>
    </ol>
  </div>
  <div>
    <h3>Use this rule from the start</h3>
    <p>The guides in this repository give many negative statements. A negative statement
    tells you which conclusion you must not make. Two examples follow. A subsystem in the
    source tree is not an accepted subsystem. A kernel test that passes is not a
    guarantee about production.</p>
    <p>Plate {plate_no("hazards")} shows the most important of these statements. The tool extracts each
    statement from a guide. It does not change the words.</p>
  </div>
</div>"""


def context_plate(model):
    rows = "".join(
        f'<tr><td>{link(model, c["path"], label=c["path"])}</td>'
        f'<td>{esc(c["role"])}</td><td class="num">{c["lines"]:,}</td></tr>'
        for c in model["consumers"])
    return f"""
{figure(context_figure(),
        "The engine receives source code and a budget. It returns a result. It writes a "
        "checkpoint to a store, and it reads the store to build the machine again. Only "
        "the test harness links the XS oracle. Production code does not link it.")}

<p>The engine has its own Cargo workspace. The outer workspace of this repository
excludes it. Therefore the engine builds in the repository, and it does not change the
dependency graph of the daemon. The table shows each program that crosses this
boundary.</p>

<div class="table-wrap">
<table>
  <caption>Programs that use the engine from outside the engine workspace</caption>
  <thead><tr><th>Path</th><th>Function</th><th class="num">Lines</th></tr></thead>
  <tbody>{rows}</tbody>
</table>
</div>"""


def crates_plate(model):
    crates = sorted(model["crates"], key=lambda c: -c["lines"])
    rows = []
    for crate in crates:
        unsafe = ("" if crate["forbids_unsafe"]
                  else '<span class="tag tag-oxide">links C</span>')
        rows.append(
            f'<tr class="filterable" data-crate="{esc(crate["name"])}" '
            f'data-text="{esc(crate["name"] + " " + crate["description"])}">'
            f'<td><button class="crate-pick" data-crate="{esc(crate["name"])}" type="button">'
            f'{esc(crate["name"])}</button> {unsafe}'
            f'<span class="cell-note">{esc(crate["description"])}</span></td>'
            f'<td class="num">{crate["lines"]:,}</td>'
            f'<td class="num">{crate["module_count"]}</td>'
            f'<td class="num">{crate["tests"]["count"]}</td></tr>')

    panels = []
    for crate in model["crates"]:
        dependents = sorted(c["name"] for c in model["crates"]
                            if any(d["name"] == crate["name"] and d["kind"] == "normal"
                                   for d in c["deps"]))
        deps = [d for d in crate["deps"] if d["kind"] == "normal"]
        dev = [d for d in crate["deps"] if d["kind"] == "dev"]
        largest = crate["modules"][0]["lines"] if crate["modules"] else 1
        entries = []
        for module in crate["modules"]:
            share = max(2, round(100 * module["lines"] / largest))
            doc = f'<span class="cell-note">{esc(module["doc"])}</span>' if module["doc"] else ""
            entries.append(
                f'<li class="filterable" data-text="{esc(module["module"] + " " + module["doc"])}">'
                f'<span class="mod-bar" style="--w:{share}%"></span>'
                f'{link(model, module["path"], label=module["module"])}'
                f'<span class="mod-n">{module["lines"]:,}</span>{doc}</li>')
        modules = "".join(entries)
        groups = ", ".join(f'{esc(k)} ({v})' for k, v in crate["tests"]["groups"].items())
        parts = []
        if deps:
            parts.append('<div><h4>Dependencies</h4><p class="inline-list">'
                         + ", ".join(f'<code>{esc(d["name"])}</code>'
                                     + (' <span class="tag">optional</span>' if d["optional"] else "")
                                     for d in deps) + "</p></div>")
        if dev:
            parts.append('<div><h4>Test dependencies</h4><p class="inline-list">'
                         + ", ".join(f'<code>{esc(d["name"])}</code>' for d in dev)
                         + ' <span class="tag tag-oxide">not used in production</span></p></div>')
        if dependents:
            parts.append('<div><h4>Used by</h4><p class="inline-list">'
                         + ", ".join(f'<code>{esc(n)}</code>' for n in dependents) + "</p></div>")
        if groups:
            parts.append(f'<div><h4>Test suites</h4><p class="inline-list">{groups}</p></div>')
        panels.append(
            f'<article class="panel" data-panel="{esc(crate["name"])}" hidden>'
            f'<header><h3>{esc(crate["name"])}</h3>'
            f'{link(model, crate["lib_root"], label=crate["lib_root"]) if crate["lib_root"] else ""}'
            f'</header>'
            f'<p class="panel-doc">{esc(crate["doc"] or crate["description"])}</p>'
            f'<div class="panel-facts">{"".join(parts)}</div>'
            f'<h4>Modules, largest first ({crate["module_count"]})</h4>'
            f'<ul class="modules">{modules}</ul></article>')

    return f"""
{figure(crate_graph(model),
        "The tool reads the dependencies from Cargo and draws them. The base crates are "
        "at the bottom. The test harnesses are at the top. A dashed line is a test "
        "dependency. A red line is an optional dependency. Select a crate to see its "
        "details below the table.")}

<p class="note"><strong>Caution: a test dependency is not a production dependency.</strong>
The file <code>ironhorse-vm/Cargo.toml</code> shows a dependency on the compiler. This
dependency applies only to tests. In production, the VM receives dynamic compilation
through the <a href="#seams">SourceCompiler seam</a>. This is the reason for the
seam.</p>

<div class="table-wrap">
<table>
  <caption>The eleven crates. The largest crate is first. Select a crate name to see its
    details.</caption>
  <thead><tr><th>Crate</th><th class="num">Lines</th><th class="num">Modules</th>
    <th class="num">Tests</th></tr></thead>
  <tbody id="crate-rows">{"".join(rows)}</tbody>
</table>
</div>

<div class="panels" id="crate-panels">{"".join(panels)}</div>"""


def seams_plate(model):
    cards = []
    for seam in model["seams"]:
        impls = seam.get("production_implementors", [])
        if seam.get("kind") == "trait":
            listed = "".join(
                f'<li>{link(model, i["file"], i["line"], label=i["type"])}'
                f'<span class="cell-note">{esc(i["file"])}</span></li>' for i in impls[:4])
            stubs = len(seam["implementors"]) - len(impls)
            surface = (f'<h4>Production implementations</h4><ul class="impl-list">{listed}</ul>'
                       f'<p class="cell-note">The tests contain {stubs} more '
                       f'implementations. A test can replace this seam easily. This is '
                       f'one purpose of the seam.</p>')
        else:
            listed = "".join(
                f'<li><strong>{esc(c["name"])}</strong> {esc(c["doc"])}</li>'
                for c in seam.get("classification", []))
            surface = ('<h4>Each field receives one classification</h4>'
                       f'<ul class="verdict-list">{listed}</ul>')
        cards.append(f"""
<article class="card">
  <header>
    <h3>{esc(seam["name"])}</h3>
    <span class="tag">{esc(seam.get("kind", "trait"))}</span>
    {link(model, seam["file"], seam["line"], label=seam["file"].split("/")[-1])}
  </header>
  <p>{esc(seam["why"])}</p>
  {surface}
</article>""")
    return f"""
<p class="abstract">Four seams give the engine almost all of its modularity. A seam is
an interface. The engine owns one side of each seam. Another program owns the other
side. Before you change the code, find the seam and the side that contains your change.
The side controls your permitted assumptions about the other side.</p>

{figure(seams_figure(model),
        "Each seam has an owner and a second party. The engine keeps the part that must "
        "stay constant. The host controls the other part.")}

<div class="cards">{"".join(cards)}</div>"""


def crank_plate(model):
    rows = "".join(
        f'<tr class="halt-row filterable" data-kind="{esc(h["kind"])}" '
        f'data-text="{esc(h["name"] + " " + h["doc"])}">'
        f'<td><code>{esc(h["name"])}</code></td>'
        f'<td><span class="verdict verdict-{"landed" if h["kind"] == "guest" else "blocked"}">'
        f'{"guest" if h["kind"] == "guest" else "host stop"}</span></td>'
        f'<td>{esc(h["doc"])}</td></tr>' for h in model["halts"])
    guest = sum(1 for h in model["halts"] if h["kind"] == "guest")
    host = len(model["halts"]) - guest
    return f"""
<p class="abstract">A <em>crank</em> is one complete unit of guest execution. The host
starts each crank. Learn this rule first: the compiler and the interpreter use the
<strong>same budget</strong>. An empty budget does not cause a JavaScript error. It
causes a host stop.</p>

{figure(crank_figure(),
        "The engine charges compilation and execution to one budget. It charges the "
        "budget in steps. A resource stop goes through all guest handlers, and the "
        "crank cannot commit. Only a Throw stays in the language.")}

<p class="note"><strong>The reason for this design.</strong> A caller can send a very
large program that never runs. If compilation had no cost, this program could stop the
host. Therefore the parser charges the budget before it parses. It also charges for the
work before a syntax error. A guest handler cannot catch this refusal, because the
budget stop uses a private unwind. For this reason, the workspace does not build with
<code>panic=abort</code>.</p>

<div class="table-wrap">
<div class="table-tools">
  <span class="tools-label">Show</span>
  <div class="segmented" role="group" aria-label="Filter the halts by observer">
    <button type="button" data-halt="all" class="on">All {len(model["halts"])}</button>
    <button type="button" data-halt="guest">Guest sees {guest}</button>
    <button type="button" data-halt="host">Host stops {host}</button>
  </div>
</div>
<table>
  <caption>Each way that a crank stops, from
    {link(model, 'rust/engine/ironhorse-vm/src/interp.rs', label='interp.rs')}.
    A guest <code>catch</code> receives only the results that the guest sees.</caption>
  <thead><tr><th>Halt</th><th>Observer</th><th>Description</th></tr></thead>
  <tbody id="halt-rows">{rows}</tbody>
</table>
</div>"""


def persist_plate(model):
    rows = []
    for const in model["constants"]:
        drift = ('<span class="tag tag-oxide">guide says '
                 f'{esc(const["documented"])}</span>' if const["drift"] else "")
        rows.append(
            f'<tr><td><code>{esc(const["name"])}</code> {drift}</td>'
            f'<td class="num"><strong>{esc(const["value"])}</strong></td>'
            f'<td>{link(model, const["file"], const["line"], label=const["file"].split("/")[-1])}</td></tr>')
    drifted = [c for c in model["constants"] if c["drift"]]
    warning = ""
    if drifted:
        names = ", ".join(f'<code>{esc(c["name"])}</code>' for c in drifted)
        warning = f"""
<p class="hazard-note"><strong>Caution: the guide does not agree with the source.</strong>
The tool found this difference when it made this map. The values of {names} increased in
the source code. The identifier table in <code>ARCHITECTURE.md</code> still shows the
older values. The table above shows the values from the source code. A written document
becomes incorrect in this way. This map is generated for this reason.</p>"""
    return f"""
<p class="abstract">The engine writes a machine to disk while the machine runs. Later it
reads the disk and builds the same object graph. This is correct only if the two sides
agree about more than the byte format. Therefore several separate identities control
the restore operation.</p>

{figure(gates_figure(model),
        "Each identity refuses the restore independently. A reader can accept a "
        "container, but the machine can still refuse to run it, because the meter "
        "release or the boot fingerprint is different.")}

{warning}

<div class="table-wrap">
<table>
  <caption>Compatibility identifiers. The tool reads each value from the source at the
    pinned commit.</caption>
  <thead><tr><th>Identifier</th><th class="num">Value</th><th>Declared in</th></tr></thead>
  <tbody>{"".join(rows)}</tbody>
</table>
</div>

<p class="note"><strong>Caution: the meter digest is not sufficient.</strong> Meter
releases 3, 4 and 5 use the same weights. They use different charging rules and
different admission rules. Therefore their digests are equal. You must compare the
release <em>name</em> and the digest. If you compare only the digests, the engine
accepts a heap that is not compatible.</p>"""


def cuts_figure(model):
    """One state, cut two ways: a single container, or addressable store rows."""
    store = model["snapshot"]["store"]
    atoms = model["snapshot"]["container"]["atoms"]
    payloads = sum(1 for a in atoms if a["section"] == "payload")
    slots = store["slots_per_page"]
    extent = int(store["chunk_extent_bytes"]) // 1024
    bands = [
        ("VERS · SIGN · CREA", "stamps and creation parameters", "meta", "one row"),
        ("BLOC", "chunk arena bytes", "chunk_exts", f"one row per {extent} KiB extent"),
        ("HEAP", "slot records and free list", "slot_pages", f"one row per {slots} slots"),
        (f"{payloads} payload atoms", "side tables and machine state", "small_sections",
         "one row per section"),
    ]
    parts = [
        '<svg viewBox="0 0 880 300" class="figure-svg" role="img" aria-label="The same '
        'machine state in two forms. The container holds all atoms in one blob. The '
        'paged store holds the same state as addressable rows.">',
        '<defs><marker id="cut-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" '
        'markerHeight="6" orient="auto-start-reverse">'
        '<path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker></defs>',
        '<text x="140" y="16" text-anchor="middle" class="edge-label">CONTAINER — ONE BLOB</text>',
        '<text x="700" y="16" text-anchor="middle" class="edge-label">PAGED STORE — ROWS</text>',
    ]
    y = 30
    for atom, what, table, how in bands:
        parts.append(
            f'<rect class="box" x="20" y="{y}" width="240" height="54" rx="2"/>'
            f'<text x="36" y="{y + 22}" class="node-name">{esc(atom)}</text>'
            f'<text x="36" y="{y + 40}" class="node-meta">{esc(what)}</text>'
            f'<path class="flow" d="M264 {y + 27} L{"436" if table else "436"} {y + 27}" '
            f'marker-end="url(#cut-arrow)"/>'
            f'<text x="350" y="{y + 20}" text-anchor="middle" class="edge-label">{esc(how)}</text>'
            f'<rect class="box box-focus" x="440" y="{y}" width="240" height="54" rx="2"/>'
            f'<text x="456" y="{y + 32}" class="node-name">{esc(table)}</text>')
        y += 64
    parts.append(
        '<rect class="box" x="700" y="30" width="160" height="246" rx="2"/>'
        '<text x="780" y="54" text-anchor="middle" class="node-name">derived</text>'
        '<line class="hair" x1="716" y1="66" x2="844" y2="66"/>'
        '<text x="780" y="90" text-anchor="middle" class="node-meta">leaf_hashes</text>'
        '<text x="780" y="112" text-anchor="middle" class="node-meta">page_edges</text>'
        '<text x="780" y="134" text-anchor="middle" class="node-meta">free_segs</text>'
        '<text x="780" y="156" text-anchor="middle" class="node-meta">edge_pairs</text>'
        '<text x="780" y="186" text-anchor="middle" class="node-meta">rebuilt from</text>'
        '<text x="780" y="204" text-anchor="middle" class="node-meta">the rows;</text>'
        '<text x="780" y="222" text-anchor="middle" class="node-meta">edge_pairs is</text>'
        '<text x="780" y="240" text-anchor="middle" class="node-meta">never sealed</text>'
        '<path class="flow flow-dashed" d="M684 150 L696 150" marker-end="url(#cut-arrow)"/>'
        '</svg>')
    return "\n".join(parts)


def commit_figure(model):
    """How row bytes become one sealed root inside one SQLite transaction."""
    store = model["snapshot"]["store"]
    classes = " · ".join(t["char"] for t in store["tree_tags"])
    leaves = " · ".join(t["char"] for t in store["leaf_tags"])
    return f"""
<svg viewBox="0 0 880 250" class="figure-svg" role="img" aria-label="Row bytes become
a leaf hash, then a per-class tree root, then one manifest root and seal. The seal
chains to the previous seal. All of it happens in one SQLite IMMEDIATE transaction.">
  <defs><marker id="seal-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6"
    markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0 L8 4 L0 8 z" fill="currentColor"/></marker></defs>

  <rect class="budget" x="18" y="20" width="844" height="152" rx="2"/>
  <text x="440" y="40" text-anchor="middle" class="node-accent">one SQLite IMMEDIATE transaction</text>

  <rect class="box" x="34" y="58" width="150" height="58" rx="2"/>
  <text x="109" y="84" text-anchor="middle" class="node-name">changed rows</text>
  <text x="109" y="102" text-anchor="middle" class="node-meta">only the dirty ones</text>

  <rect class="box" x="230" y="58" width="164" height="58" rx="2"/>
  <text x="312" y="84" text-anchor="middle" class="node-name">leaf hash</text>
  <text x="312" y="102" text-anchor="middle" class="node-meta">tag + index + bytes</text>

  <rect class="box" x="440" y="58" width="164" height="58" rx="2"/>
  <text x="522" y="84" text-anchor="middle" class="node-name">class tree</text>
  <text x="522" y="102" text-anchor="middle" class="node-meta">only the dirty paths</text>

  <rect class="box box-focus" x="650" y="58" width="196" height="58" rx="2"/>
  <text x="748" y="84" text-anchor="middle" class="node-name">manifest root and seal</text>
  <text x="748" y="102" text-anchor="middle" class="node-meta">chained to the last seal</text>

  <path class="flow" d="M184 87 L226 87" marker-end="url(#seal-arrow)"/>
  <path class="flow" d="M394 87 L436 87" marker-end="url(#seal-arrow)"/>
  <path class="flow" d="M604 87 L646 87" marker-end="url(#seal-arrow)"/>

  <text x="109" y="140" text-anchor="middle" class="node-meta">SHA-256 for each row</text>
  <text x="312" y="140" text-anchor="middle" class="node-meta">domains {esc(leaves)}</text>
  <text x="522" y="140" text-anchor="middle" class="node-meta">classes {esc(classes)}</text>
  <text x="748" y="140" text-anchor="middle" class="node-meta">verified before the write</text>

  <path class="flow flow-oxide" d="M440 172 L440 200" marker-end="url(#seal-arrow)"/>
  <text x="440" y="222" text-anchor="middle" class="node-oxide">any refusal rolls the transaction back and the store keeps the last epoch</text>
</svg>"""


# Colour on the heap grid encodes what a slot points at, because that is what
# decides whether the collector must follow it and whether its bytes live in
# the chunk arena. Fifteen arbitrary hues would carry no information.
HEAP_COLS = 64

KIND_ROLES = {
    "Instance": "structure", "Property": "structure", "Closure": "structure",
    "EnvReference": "structure",
    "Reference": "reference", "Symbol": "reference", "At": "reference",
    "String": "chunk", "BigInt": "chunk",
    "Undefined": "value", "Null": "value", "Boolean": "value",
    "Integer": "value", "Number": "value",
    "Uninitialized": "unset",
}
ROLE_MEANING = {
    "structure": "Holds the object graph. The collector follows these.",
    "reference": "Points at another slot by index.",
    "chunk": "Points at bytes in the chunk arena. Compaction moves the bytes.",
    "value": "Holds its value in the record. Nothing to follow.",
    "unset": "Declared but not yet given a value.",
}


def heap_explorer(model):
    """A real slot arena, drawn cell by cell, with a panel for the hovered slot."""
    heap = model["snapshot"].get("heap")
    if not heap:
        return ""
    kinds = {k["value"]: k for k in heap["kinds"]}
    tags = {t["id"]: t["name"] for t in heap["payload_tags"]}
    payload_docs = {p["name"]: p["doc"] for p in heap["payloads"]}
    null = heap["null"]
    columns = heap["columns"].split(",")

    cells, roles_used = [], {}
    for index, row in enumerate(heap["slots"]):
        fields = dict(zip(columns, (int(v) for v in row.split(","))))
        kind = kinds.get(fields["kind"], {"name": f"?{fields['kind']}", "doc": ""})
        role = KIND_ROLES.get(kind["name"], "value")
        roles_used[kind["name"]] = roles_used.get(kind["name"], 0) + 1
        tag = tags.get(fields["ptag"], str(fields["ptag"]))
        # A native tooltip keeps the grid informative when scripting is off.
        summary = f'[{index}] {kind["name"]} · payload {tag}'
        if fields["str"] >= 0:
            summary += f' · "{heap["strings"][fields["str"]]}"'
        if index and index % heap["slots_per_page"] == 0:
            cells.append(
                f'<div class="hpage">page {index // heap["slots_per_page"]}</div>')
        cells.append(
            f'<button type="button" class="hcell role-{role}" data-i="{index}" '
            f'title="{esc(summary)}" tabindex="-1"></button>')

    legend = "".join(
        f'<button type="button" class="hkey role-{KIND_ROLES.get(name, "value")}" '
        f'data-kind="{esc(name)}"><span class="hswatch"></span>{esc(name)}'
        f'<span class="hcount">{count}</span></button>'
        for name, count in sorted(heap["histogram"].items(), key=lambda kv: -kv[1]))

    roles = "".join(
        f'<li><span class="hswatch role-{role}"></span><strong>{esc(role)}</strong> '
        f'{esc(meaning)}</li>' for role, meaning in ROLE_MEANING.items())

    # The 20-byte record, as the fields the codec's own layout table names.
    layout_cells = []
    for field in heap["record_layout"]:
        width = field["end"] - field["offset"]
        label = field["field"].split("(")[0].strip().strip("`")
        layout_cells.append(
            f'<button type="button" class="rfield" style="--span:{width}" '
            f'data-field="{esc(field["field"])}" '
            f'data-range="bytes {field["offset"]}–{field["end"] - 1}">'
            f'<span class="roff">{field["offset"]}</span>'
            f'<span class="rname">{esc(label)}</span></button>')

    counter = heap.get("counter")
    counter_block = ""
    if counter:
        steps = "".join(
            f'<button type="button" class="cstep{" on" if n == counter["canonical"] else ""}" '
            f'data-count="{n}">{n}</button>' for n in counter["counts"])
        watched = "".join(
            f'<li><button type="button" class="cjump" data-slot="{s["slot"]}">'
            f'slot {s["slot"]}</button>'
            f'<span class="cval" data-slot="{s["slot"]}">'
            f'{s["values"][counter["counts"].index(counter["canonical"])]}</span>'
            f'<span class="cell-note">{rich(s["role"])}</span></li>'
            for s in counter["slots"])
        counter_block = f"""
<h4>Where the counter's value lives</h4>
<div class="counter">
  <div>
    <p class="cprog-label">Setup, once</p>
    <pre><code>{esc(counter["setup"])}</code></pre>
    <p class="cprog-label">Then this crank, once per step</p>
    <pre><code>{esc(counter["increment"])}</code></pre>
  </div>
  <div>
    <p class="cprog-label">Increments taken</p>
    <div class="csteps" role="group" aria-label="Number of increments">{steps}</div>
    <ul class="cwatch">{watched}</ul>

    <p class="cprog-label" id="cio-label">What that checkpoint wrote</p>
    <dl class="cio" id="cio">
      <dt>changed</dt><dd><b data-io="changed_bytes"></b><span data-io="changed_note"></span></dd>
      <dt>slot pages</dt><dd><b data-io="slot_bytes"></b><span data-io="pages_note"></span></dd>
      <dt>chunk arena</dt><dd><b data-io="extent_bytes"></b><span data-io="extent_note"></span></dd>
      <dt>small state</dt><dd><b data-io="small_bytes"></b><span data-io="sections_note"></span></dd>
      <dt class="cio-total">written</dt>
      <dd class="cio-total"><b data-io="written"></b><span data-io="ratio_note"></span></dd>
    </dl>
    <p class="cnote">Select a count to read each slot at that step, and what the
    checkpoint after it wrote. Select a slot to find it in the arena below. The
    drawn heap is the capture at {counter["canonical"]} increments. A cold resume
    reads {counter["resume"]["total"]:,} bytes: {counter["resume"]["slot_bytes"]:,}
    of slots, {counter["resume"]["chunk_bytes"]:,} of chunks and
    {counter["resume"]["small_bytes"]:,} of small state.</p>
  </div>
</div>

<p class="note"><strong>How the map knows which slots these are.</strong> It does not
read the code and guess. The example boots one machine, takes the increment as its own
crank, and captures the heap after each one. A slot whose value equals the number of
increments at every step holds the count. A second series calls the counter and throws
the result away: the closure's cell still advances, the global does not, which is what
separates the two.</p>

<p class="note"><strong>Why the write is so much larger than the change.</strong> The
store's unit is a page of {counter["slots_per_page"]} slots. Both counter slots sit in
the same page, so one increment dirties one page and the store rewrites all of it. The
cost of a crank follows the number of pages it touches, not the number of bytes it
changes. Two notes on reading these figures. The page here is the arena's last page,
which is short; a full page is
{counter["slots_per_page"] * counter["slot_record_bytes"]:,} bytes. And the chunk arena
is untouched, because the count is an integer held in the record itself. A program that
built a string each crank would dirty an extent as well.</p>"""

    anchors = heap["anchors"]

    def anchor(key, label):
        entry = anchors.get(key)
        if not entry:
            return ""
        return link(model, entry["file"], entry.get("line"), label=label)

    payload_help = "".join(
        f'<li><code>{esc(name)}</code> {esc(payload_docs.get(name, ""))}</li>'
        for name in (t["name"] for t in heap["payload_tags"]) if payload_docs.get(name))

    data = json.dumps({
        "columns": columns,
        "slots": heap["slots"],
        "strings": heap["strings"],
        "kinds": {str(k["value"]): {"n": k["name"], "d": k["doc"],
                                    "r": KIND_ROLES.get(k["name"], "value")}
                  for k in heap["kinds"]},
        "tags": {str(t["id"]): t["name"] for t in heap["payload_tags"]},
        "payloadDocs": payload_docs,
        "null": null,
        "perPage": heap["slots_per_page"],
        "roleMeaning": ROLE_MEANING,
        "cols": HEAP_COLS,
        "counter": (dict(counter, section_count=max(
            (row["sections"] for row in counter["io"]), default=0))
            if counter else None),
    }, separators=(",", ":"))

    return f"""
<h3>The slot arena, from a real container</h3>

<p>Every cell below is one slot in a real heap, at
<strong>format {heap["format_version"]}</strong>, which is the format the current
writer emits. The example
{link(model, heap["capture"], label="capture-map-heap.rs")} boots a machine, runs a
short program, and writes
{link(model, heap["source"], label=heap["source"].split("/")[-1])}. The map decodes that
container. The program is a counter held in a closure. It is short enough that you can
find its value in the arena, and the next section shows you where. Point at a slot to
read it.</p>

<div class="hstats">
  <span><b>{heap["slot_count"]:,}</b> slots</span>
  <span><b>{heap["live"]:,}</b> live</span>
  <span><b>{heap["chunk_bytes"]:,}</b> chunk bytes</span>
  <span><b>{len(heap["strings"])}</b> strings resolved</span>
  <span><b>{heap["slots_per_page"]}</b> slots per page</span>
</div>

{counter_block}

<h4>One slot record</h4>
<div class="rlayout" id="record-layout">{"".join(layout_cells)}</div>
<p class="rnote" id="record-note">Point at a field. The layout comes from the codec's
own table in {anchor("codec", "slot_codec.rs")}.</p>

<h4>Colour shows what a slot points at</h4>
<ul class="hroles">{roles}</ul>

<div class="hlegend">{legend}</div>

<div class="heap" id="heap">
  <div class="hgrid" id="hgrid" role="application" tabindex="0" style="--cols:{HEAP_COLS}"
    aria-label="Slot arena. Use the arrow keys to move between slots."><div class="hpage">page 0</div>{"".join(cells)}</div>
  <aside class="hpanel" id="hpanel">
    <p class="hpanel-empty">Point at a slot.</p>
  </aside>
</div>

<p class="note"><strong>What the page rule means.</strong> The heavier line every
{heap["slots_per_page"]} slots is a page boundary. The paged store writes one
<code>slot_pages</code> row for each page, so a crank that changes one slot makes the
store rewrite that whole page and no other.</p>

<details class="hdetails">
  <summary>Payload arms</summary>
  <ul class="verdict-list">{payload_help}</ul>
  <p class="cell-note">Defined in {anchor("payload", "Payload")}, beside
  {anchor("kind", "Kind")} and {anchor("slot", "Slot")}. Handles are
  {anchor("slot_index", "SlotIndex")} and {anchor("chunk_offset", "ChunkOffset")};
  <code>{null}</code> is the null sentinel for both.</p>
</details>

<script type="application/json" id="heap-data">{data}</script>"""


def layout_plate(model):
    snapshot = model["snapshot"]
    container, store, sqlite = snapshot["container"], snapshot["store"], snapshot["sqlite"]
    atoms = container["atoms"]
    always = [a for a in atoms if a["always"]]
    optional = [a for a in atoms if not a["always"]]

    stamps = [
        ("Envelope", container["envelope"], "The outer container tag, from XS."),
        ("Magic", container["magic"], "The discriminator at the head of VERS."),
        ("Format version", container["format_version"],
         f'The reader accepts {container["min_read"]} up to this number and refuses newer.'),
        ("Slot record", f'{container["slot_record_bytes"]} bytes',
         "The width of one serialized slot. It is not the in-memory width."),
        ("Store schema", store["schema_version"], "Page geometry and manifest layout."),
        ("Slots per page", store["slots_per_page"], "One slot_pages row holds this many."),
        ("Chunk extent", f'{int(store["chunk_extent_bytes"]) // 1024} KiB',
         "One chunk_exts row holds this many bytes."),
    ]
    stamp_rows = "".join(
        f'<tr><td>{esc(name)}</td><td class="num"><strong>{esc(value)}</strong></td>'
        f'<td class="cell-note">{esc(note)}</td></tr>' for name, value, note in stamps)

    atom_cells = "".join(
        f'<li class="filterable atom{"" if a["always"] else " atom-opt"}" '
        f'data-text="{esc(a["tag"] + " " + a["role"] + (" optional" if not a["always"] else " always"))}">'
        f'<span class="atom-tag">{esc(a["tag"])}</span>'
        f'<span class="atom-n">{esc(str(index))}</span>'
        f'<span class="cell-note">{rich(a["role"]) or "—"}</span></li>'
        for index, a in enumerate(atoms))

    table_rows = "".join(
        f'<tr class="filterable" data-text="{esc(t["name"] + " " + t["note"])}">'
        f'<td><code>{esc(t["name"])}</code>'
        f'{" <span class=tag>without rowid</span>" if t["option"] else ""}'
        f'<span class="cell-note">{rich(t["note"])}</span></td>'
        f'<td class="cols">{"".join(f"<code>{esc(c)}</code>" for c in t["columns"])}</td></tr>'
        for t in sqlite["tables"])

    pragmas = "".join(f'<code>{esc(p)}</code>' for p in sqlite["pragmas"])

    return f"""
<p class="abstract">The engine keeps one machine state in two forms. The
<strong>container</strong> is one blob of tagged atoms, and the engine writes it
whole. The <strong>paged store</strong> holds the same state as rows, and the engine
writes only the rows that changed. The container gives a stable identity for a
complete image. The store gives a cheap checkpoint after each crank.</p>

{figure(cuts_figure(model),
        "The two forms hold the same state and cut it differently. The store cut is "
        "what makes an incremental commit possible, because a crank touches few "
        "pages.")}

<div class="table-wrap">
<table>
  <caption>Stamps and geometry, read from
    {link(model, 'rust/engine/ironhorse-snapshot/src/format.rs', label='format.rs')},
    {link(model, 'rust/engine/ironhorse-snapshot/src/store.rs', label='store.rs')} and
    {link(model, 'rust/engine/ironhorse-vm/src/value.rs', label='value.rs')}.</caption>
  <thead><tr><th>Item</th><th class="num">Value</th><th>Description</th></tr></thead>
  <tbody>{stamp_rows}</tbody>
</table>
</div>

{heap_explorer(model)}

<h3>Container atoms, in write order</h3>
<p>The writer emits the first five atoms, and then walks the payload roster in
declaration order. {len(always)} atoms are always present. The other {len(optional)}
atoms are written only when they hold data.</p>

<ul class="atoms">{atom_cells}</ul>

<p class="note"><strong>The reason for the optional atoms.</strong> An empty atom is
not written. Therefore a machine that never used a feature keeps the same container
bytes as before that feature existed. The bytes give the content hash, and the content
hash is the identity that the stored images and the golden vectors use.</p>

<h3>How a commit reaches the disk</h3>

{figure(commit_figure(model),
        "A commit hashes each changed row, updates only the dirty paths of the class "
        "trees, and binds the combined root into the manifest with a seal. The seal "
        "chains to the previous seal.")}

<p>The backend takes the writer lock at the start with an <code>IMMEDIATE</code>
transaction. A second writer then waits, and it does not fail in the middle of a
read-to-write upgrade. The shared verifier runs inside this transaction, so every
backend meets the same admission rules.</p>

<div class="table-wrap">
<table>
  <caption>SQLite tables, parsed from the DDL in
    {link(model, 'rust/endo/ironhorse-store-sqlite/src/lib.rs', label='ironhorse-store-sqlite')}.
    Transaction behaviour: <code>{esc(sqlite["transaction"])}</code>. Pragmas: {pragmas}</caption>
  <thead><tr><th>Table</th><th>Columns</th></tr></thead>
  <tbody>{table_rows}</tbody>
</table>
</div>

<p class="note"><strong>Two properties to remember.</strong> First,
<code>edge_pairs</code> is derived from <code>page_edges</code> and is never sealed.
It exists so that reachability runs as a recursive query inside SQLite, and the backend
can rebuild it. Second, <code>journal_mode=WAL</code> with
<code>synchronous=FULL</code> is the durability contract that the machine layer
assumes. The backend reads both values back after it sets them, and it refuses the
store if either value is wrong.</p>

<p class="hazard-note"><strong>Caution: the container and the store are different
representations.</strong> They hold the same machine state, and they carry separate
version numbers. A change to one does not update the other. Plate
{plate_no("persist")} lists the identities that a restore checks.</p>"""


def hazards_plate(model):
    items = []
    for hazard in model["hazards"]:
        context = (f'<p class="hazard-context">{rich(hazard["context"])}</p>'
                   if hazard["context"] else "")
        items.append(f"""
<li class="hazard filterable" data-text="{esc(hazard['text'] + ' ' + hazard['section'])}">
  <p class="hazard-where">{esc(hazard["section"])}</p>
  {context}
  <p class="hazard-text">{rich(hazard["text"])}</p>
  {link(model, f'rust/engine/{hazard["source"]}', hazard["line"],
        label=f'{hazard["source"]}:{hazard["line"]}')}
</li>""")
    return f"""
<p class="abstract">The tool extracts these sentences from the engine guides. Each
sentence prevents one wrong conclusion. The source tree suggests the wrong conclusion,
and the sentence corrects it. The words are unchanged, and each sentence is not in
Simplified Technical English. The italic line above a sentence is the sentence before
it in the guide. Select the reference to read the full section.</p>

<ul class="hazards">{"".join(items)}</ul>

<p class="note">The tool gives a score to each sentence. A high score shows that the
sentence prevents a specific conclusion. The tool also limits the number of sentences
from one section. Therefore one section cannot fill the list. Read the guides to see the
other sentences.</p>"""


def recipes_plate(model):
    cards = []
    for recipe in model["recipes"]:
        steps = "".join(
            f'<li>{link(model, w["path"], label=w["path"].replace("rust/engine/", ""))}'
            f'<span class="cell-note">{esc(w["why"])}</span></li>'
            for w in recipe["waypoints"])
        cards.append(f"""
<article class="card filterable" data-text="{esc(recipe['goal'] + ' ' + recipe['note'])}">
  <h3>{esc(recipe["goal"])}</h3>
  <p>{esc(recipe["note"])}</p>
  <ol class="waypoints">{steps}</ol>
</article>""")
    return f"""
<p class="abstract">These are the steps for the usual first tasks. Each step gives one
file or one directory. The tool makes this map, and at the same time it checks that each
file is in the source tree. Therefore no step points to a file that moved.</p>

<div class="cards">{"".join(cards)}</div>"""


def checks_plate(model):
    by_workflow = {}
    for check in model["checks"]:
        by_workflow.setdefault(check["workflow"], []).append(check)
    blocks = []
    for workflow in sorted(by_workflow):
        steps = "".join(
            f'<li class="filterable" data-text="{esc(c["step"] + " " + " ".join(c["commands"]))}">'
            f'<span class="step-name">{esc(c["step"])}</span>'
            f'<pre><code>{esc(chr(10).join(c["commands"]))}</code></pre></li>'
            for c in by_workflow[workflow])
        blocks.append(f"""
<div class="workflow">
  <h3>{link(model, f'.github/workflows/{workflow}', label=workflow)}</h3>
  <ol class="steps">{steps}</ol>
</div>""")
    return f"""
<p class="abstract">CI does these steps on your branch. The tool reads the steps from the
workflow files. Some steps check generated files. If you change a dependency, a row
declaration, or an opcode table, you must generate the files again. If you do not, CI
reports a difference in the generated file, and not an error in your code.</p>

<div class="workflows">{"".join(blocks)}</div>

<p class="note"><strong>Caution: CI does not run the fuzzers on a pull request.</strong>
The fuzzers run on a separate schedule. Therefore a new crash does not fail a different
pull request. It also does not give you a warning.</p>"""


def status_plate(model):
    rows = "".join(
        f'<tr><td>{esc(a["stage"])}</td><td>{esc(a["bar"])}</td>'
        f'<td><span class="verdict verdict-{a["state"]}">{esc(a["verdict"])}</span></td>'
        f'<td class="cell-note">{esc(a["evidence"])}</td></tr>'
        for a in model["acceptance"])
    return f"""
<p class="abstract">Code in the source tree is not accepted code. Intl, Temporal,
promises, generators, and a complete garbage collector are all in the tree. Each one has
an open acceptance item. Read this table before you make a conclusion about a
subsystem.</p>

<div class="table-wrap">
<table>
  <caption>Plan stages and their status, from
    {link(model, 'rust/engine/README.md', label='README.md')}</caption>
  <thead><tr><th>Stage</th><th>Requirement</th><th>Status</th><th>Evidence and open work</th></tr></thead>
  <tbody>{rows}</tbody>
</table>
</div>

<p class="note"><strong>Two examples.</strong> First, the exact garbage collector is in
the tree, but production does not use it. Production persistence uses paged collection,
and the consumer selects the schedule. Second, the tree contains no debugger crate. Some
old documents use the words &ldquo;stage-7 child&rdquo;. These words do not refer to
stage 7 of this plan.</p>"""


STYLE = """
:root {
  --paper: #f3f3f0;
  --panel: #fbfbf9;
  --box: #ffffff;
  --oxide-wash: #f8ece8;
  --ink: #1a1d1b;
  --muted: #666c68;
  --rule: #dcded9;
  --hair: #e8eae5;
  --accent: #2c5b50;
  --accent-wash: #e4ede9;
  --oxide: #a2381e;
  --brass: #856016;
  --good: #2e6a45;
  color-scheme: light;
}
:root:not([data-theme="light"]) {
  @media (prefers-color-scheme: dark) {
    --paper: #101412;
    --panel: #161b18;
    --box: #1b2220;
    --oxide-wash: #2a1c17;
    --ink: #e2e7e2;
    --muted: #949d96;
    --rule: #2a322d;
    --hair: #222a26;
    --accent: #73bca8;
    --accent-wash: #16302a;
    --oxide: #e3775b;
    --brass: #d5a446;
    --good: #6dbf8c;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #101412;
  --panel: #161b18;
  --box: #1b2220;
  --oxide-wash: #2a1c17;
  --ink: #e2e7e2;
  --muted: #949d96;
  --rule: #2a322d;
  --hair: #222a26;
  --accent: #73bca8;
  --accent-wash: #16302a;
  --oxide: #e3775b;
  --brass: #d5a446;
  --good: #6dbf8c;
  color-scheme: dark;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 400 15.5px/1.6 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
}
img { max-width: 100%; }
[hidden] { display: none !important; }
h1, h2, h3, h4 { text-wrap: balance; }

.shell {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 44px;
  max-width: 1180px;
  margin: 0 auto;
  padding-inline: 24px;
  padding-block: 0 88px;
}

/* masthead ------------------------------------------------------------- */
.masthead {
  grid-column: 1 / -1;
  border-bottom: 1.5px solid var(--ink);
  padding-block: 44px 20px;
}
.eyebrow {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  font: 500 11px/1 "IBM Plex Mono", ui-monospace, monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 20px;
}
.masthead h1 {
  font: 600 clamp(30px, 4.4vw, 44px)/1.05 "IBM Plex Sans", sans-serif;
  letter-spacing: -.022em;
  margin: 0;
}
.masthead .sub {
  max-width: 64ch;
  margin: 12px 0 0;
  font: 400 16px/1.55 "IBM Plex Serif", Georgia, serif;
  color: var(--muted);
}
.provenance {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  margin-top: 18px;
  font: 400 11.5px/1.5 "IBM Plex Mono", ui-monospace, monospace;
  color: var(--muted);
}
.provenance b { color: var(--ink); font-weight: 500; }

/* controls ------------------------------------------------------------- */
.controls { display: flex; gap: 8px; align-items: center; }
.search {
  font: 400 12px/1 "IBM Plex Mono", ui-monospace, monospace;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 6px 9px;
  width: 190px;
}
.search::placeholder { color: var(--muted); }
.ghost {
  font: 500 11px/1 "IBM Plex Mono", ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 7px 10px;
  cursor: pointer;
}
.ghost:hover { color: var(--ink); border-color: var(--muted); }
.match-count { font: 400 11px "IBM Plex Mono", monospace; color: var(--oxide); }

/* rail ----------------------------------------------------------------- */
.rail {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  align-self: start;
  padding-block: 28px;
  max-height: 100vh;
  overflow-y: auto;
}
.rail nav { display: flex; flex-direction: column; }
.rail a {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 6px 9px;
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
  border-left: 1.5px solid var(--hair);
}
.rail a:hover, .rail a.here { color: var(--ink); border-left-color: var(--accent); background: var(--panel); }
.nav-no { font: 500 10px/1 "IBM Plex Mono", monospace; color: var(--accent); }

/* plates --------------------------------------------------------------- */
main { min-width: 0; display: flex; flex-direction: column; gap: 68px; padding-top: 28px; }
.plate { scroll-margin-top: 20px; min-width: 0; }
.plate-head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  border-top: 1px solid var(--rule);
  padding-top: 16px;
  margin-bottom: 22px;
}
.plate-no { font: 500 12px/1.6 "IBM Plex Mono", monospace; color: var(--accent); padding-top: 3px; }
.plate h2 { font: 600 clamp(21px, 2.6vw, 26px)/1.2 "IBM Plex Sans", sans-serif; letter-spacing: -.015em; margin: 0; }
.kicker { margin: 3px 0 0; color: var(--muted); font-size: 13.5px; }
.plate h3 { font: 600 16px/1.35 "IBM Plex Sans", sans-serif; margin: 0 0 7px; }
.plate h4 {
  font: 500 10.5px/1 "IBM Plex Mono", monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 16px 0 7px;
}
.plate p { max-width: 70ch; }
.abstract {
  font: 400 16.5px/1.6 "IBM Plex Serif", Georgia, serif;
  border-left: 1.5px solid var(--accent);
  padding-left: 18px;
  margin: 0 0 22px;
}
.split { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 28px; margin-top: 26px; }
.route { margin: 0; padding-left: 18px; font-size: 14.5px; }
.route li { margin-bottom: 6px; }

/* figures -------------------------------------------------------------- */
.figure { margin: 24px 0; min-width: 0; }
.figure-svg, .graph {
  display: block;
  width: 100%;
  height: auto;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 12px;
}
figcaption { margin-top: 9px; font-size: 13px; line-height: 1.55; color: var(--muted); max-width: 74ch; }
.box { fill: var(--box); stroke: var(--muted); stroke-width: 1.1; }
.box-focus { fill: var(--box); stroke: var(--accent); stroke-width: 1.7; }
.box-oracle { fill: var(--oxide-wash); stroke: var(--oxide); stroke-width: 1.3; }
.budget { fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-dasharray: 6 4; }
.hair { stroke: var(--rule); stroke-width: 1; }
.hair-accent { stroke: var(--accent); stroke-width: 1.1; opacity: .55; }
.seam-line { stroke: var(--oxide); stroke-width: 1.4; stroke-dasharray: 7 5; opacity: .8; }
.flow { fill: none; stroke: currentColor; stroke-width: 1.3; }
.flow-dashed { stroke-dasharray: 4 4; }
.flow-oxide { stroke: var(--oxide); }
.oxide-fill { fill: var(--oxide); }
.node-name { font: 500 12.5px "IBM Plex Sans", sans-serif; fill: var(--ink); }
.node-accent { font: 500 12.5px "IBM Plex Sans", sans-serif; fill: var(--accent); }
.node-oxide { font: 500 12.5px "IBM Plex Sans", sans-serif; fill: var(--oxide); }
.node-meta { font: 400 10.5px "IBM Plex Mono", monospace; fill: var(--muted); }
.edge-label { font: 500 9.5px "IBM Plex Mono", monospace; fill: var(--muted); letter-spacing: .06em; }

/* interactive graph ---------------------------------------------------- */
.graph .edge { fill: none; stroke: currentColor; stroke-width: 1.3; opacity: .55; }
.graph .edge-dev { stroke-dasharray: 4 4; opacity: .3; }
.graph .edge-optional { stroke: var(--oxide); opacity: .5; }
.graph .node rect { fill: var(--box); stroke: var(--accent); stroke-width: 1.3; }
.graph .node-oracle rect { fill: var(--oxide-wash); stroke: var(--oxide); }
.graph .node { cursor: pointer; }
.graph .node:hover rect { stroke-width: 2.2; }
.graph .node:focus-visible { outline: none; }
.graph .node:focus-visible rect { stroke-width: 2.4; }
.graph.has-selection .edge { opacity: .08; }
.graph.has-selection .edge.lit { opacity: .95; stroke-width: 1.8; }
.graph.has-selection .node { opacity: .32; }
.graph.has-selection .node.lit, .graph.has-selection .node.chosen { opacity: 1; }
.graph .node.chosen rect { stroke-width: 2.6; fill: var(--accent-wash); }

/* stats ---------------------------------------------------------------- */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(146px, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  border-radius: 2px;
  margin: 24px 0;
  overflow: hidden;
}
.stat { background: var(--panel); padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
.stat-n { font: 600 23px/1.1 "IBM Plex Sans", sans-serif; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.stat-l { font-size: 12px; color: var(--muted); }

/* notes ---------------------------------------------------------------- */
.note, .hazard-note {
  border: 1px solid var(--rule);
  border-left: 2px solid var(--muted);
  border-radius: 2px;
  padding: 13px 16px;
  margin: 22px 0;
  font-size: 14px;
  max-width: 74ch;
  background: var(--panel);
}
.hazard-note { background: var(--oxide-wash); border-color: var(--oxide); border-left-width: 2.5px; }
.hazards { list-style: none; margin: 24px 0 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.hazard { background: var(--panel); border: 1px solid var(--rule); border-left: 2.5px solid var(--oxide); padding: 14px 16px; }
.hazard-where {
  font: 500 10px/1 "IBM Plex Mono", monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--oxide);
  margin: 0 0 8px;
}
.hazard-context { margin: 0 0 3px; color: var(--muted); font-size: 13.5px; font-style: italic; }
.hazard-text { margin: 0 0 8px; font-size: 15px; font-weight: 500; }

/* tables --------------------------------------------------------------- */
/* The wrapper scrolls so a wide table never pushes the page sideways, while
   the table itself keeps normal table layout. */
.table-wrap { margin: 22px 0; border: 1px solid var(--rule); border-radius: 2px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; background: var(--panel); }
/* Below this width the prose column shreds into one word per line, so the
   wrapper scrolls instead of the columns collapsing. */
.table-wrap table { min-width: 580px; }
caption { caption-side: top; text-align: left; padding: 11px 15px; font-size: 12.5px; color: var(--muted); background: var(--paper); border-bottom: 1px solid var(--rule); }
th {
  text-align: left;
  font: 500 10.5px/1.4 "IBM Plex Mono", monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 9px 15px;
  border-bottom: 1px solid var(--rule);
  white-space: nowrap;
}
td { padding: 11px 15px; border-bottom: 1px solid var(--hair); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr.on { background: var(--accent-wash); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
th.num { text-align: right; }
.cell-note { display: block; color: var(--muted); font-size: 12px; margin: 2px 0 0; line-height: 1.45; }
.table-tools { display: flex; gap: 12px; align-items: center; padding: 10px 15px; border-bottom: 1px solid var(--rule); background: var(--paper); flex-wrap: wrap; }
.tools-label { font: 500 10.5px "IBM Plex Mono", monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.segmented { display: flex; border: 1px solid var(--rule); border-radius: 2px; overflow: hidden; }
.segmented button {
  font: 400 12px/1 "IBM Plex Mono", monospace;
  color: var(--muted);
  background: var(--panel);
  border: 0;
  border-right: 1px solid var(--rule);
  padding: 6px 11px;
  cursor: pointer;
}
.segmented button:last-child { border-right: 0; }
.segmented button:hover { color: var(--ink); }
.segmented button.on { background: var(--accent); color: var(--paper); }

.crate-pick {
  font: 500 13.5px "IBM Plex Mono", monospace;
  color: var(--accent);
  background: none;
  border: 0;
  border-bottom: 1px solid var(--accent-wash);
  padding: 0;
  cursor: pointer;
}
.crate-pick:hover { border-bottom-color: var(--accent); }

/* panels --------------------------------------------------------------- */
.panels { margin-top: 18px; }
.panel { background: var(--panel); border: 1px solid var(--rule); border-top: 2px solid var(--accent); border-radius: 2px; padding: 18px 20px 20px; }
.panel header { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; margin-bottom: 6px; }
.panel header h3 { margin: 0; font-family: "IBM Plex Mono", monospace; font-size: 15px; }
.panel-doc { color: var(--muted); font-size: 14px; margin: 0; }
.panel-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 4px 24px; margin-top: 6px; }
.inline-list { font-size: 13px; margin: 0; color: var(--muted); line-height: 1.9; }
/* The VM alone carries 105 modules; the list scrolls in place so a crate's
   detail never buries the rest of the report. */
.modules {
  list-style: none;
  margin: 0;
  padding: 0 4px 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(232px, 1fr));
  gap: 2px 20px;
  max-height: 440px;
  overflow-y: auto;
}
.modules li { position: relative; padding: 4px 0 4px 8px; font-size: 13px; border-bottom: 1px solid var(--hair); }
.mod-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); opacity: .45; height: var(--w, 4%); min-height: 3px; }
.mod-n { float: right; font: 400 11.5px "IBM Plex Mono", monospace; color: var(--muted); font-variant-numeric: tabular-nums; }

/* counter ---------------------------------------------------------------- */
.counter { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 20px; margin: 10px 0 4px; align-items: start; }
.cprog-label { font: 500 10px "IBM Plex Mono", monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 0 0 4px; }
.counter pre { margin: 0 0 12px; }
.csteps { display: flex; gap: 3px; margin-bottom: 12px; }
.cstep {
  font: 500 12px "IBM Plex Mono", monospace;
  min-width: 30px;
  color: var(--ink); background: var(--panel);
  border: 1px solid var(--rule); border-radius: 2px;
  padding: 5px 0; cursor: pointer;
}
.cstep:hover { border-color: var(--accent); }
.cstep.on { background: var(--accent); color: var(--paper); border-color: var(--accent); }
.cwatch { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.cwatch li { display: grid; grid-template-columns: auto auto 1fr; gap: 4px 10px; align-items: baseline; }
.cjump {
  font: 400 12px "IBM Plex Mono", monospace;
  color: var(--accent); background: none;
  border: 0; border-bottom: 1px solid var(--accent-wash);
  padding: 0; cursor: pointer;
}
.cjump:hover { border-bottom-color: var(--accent); }
.cval {
  font: 500 15px "IBM Plex Mono", monospace;
  font-variant-numeric: tabular-nums;
  color: var(--oxide);
  min-width: 2ch;
}
#cio-label { margin-top: 16px; }
.cio { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 12px; margin: 6px 0 0; font-size: 12.5px; }
.cio dt { font: 400 11px/1.7 "IBM Plex Mono", monospace; color: var(--muted); }
.cio dd { margin: 0; display: flex; gap: 8px; align-items: baseline; }
.cio b { font: 500 12.5px "IBM Plex Mono", monospace; font-variant-numeric: tabular-nums; min-width: 8ch; text-align: right; }
.cio span { color: var(--muted); font-size: 12px; }
.cio .cio-total { border-top: 1px solid var(--rule); padding-top: 5px; margin-top: 2px; }
.cio .cio-total b { color: var(--oxide); }

.cwatch .cell-note { grid-column: 1 / -1; margin: 0; }
.cnote { color: var(--muted); font-size: 12.5px; line-height: 1.5; margin: 14px 0 0; }
.hcell.watch { outline: 1.5px dashed var(--oxide); outline-offset: 1px; opacity: 1; z-index: 2; }

@media (max-width: 760px) {
  .counter { grid-template-columns: minmax(0, 1fr); }
}

/* heap explorer --------------------------------------------------------- */
.hstats { display: flex; flex-wrap: wrap; gap: 5px 18px; margin: 12px 0 6px; font: 400 11.5px "IBM Plex Mono", monospace; color: var(--muted); }
.hstats b { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; }

.rlayout { display: flex; gap: 2px; margin: 8px 0 6px; }
.rfield {
  flex: var(--span) 1 0;
  /* A one-byte field would otherwise be too narrow to show its own name. */
  min-width: 68px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-top: 2px solid var(--accent);
  border-radius: 2px;
  padding: 5px 7px;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.rfield:hover, .rfield.on { background: var(--accent-wash); border-color: var(--accent); }
.roff { display: block; font: 400 9px "IBM Plex Mono", monospace; color: var(--muted); }
.rname { display: block; font: 500 11px "IBM Plex Mono", monospace; }
.rnote { font-size: 13px; color: var(--muted); min-height: 2.6em; margin: 0 0 6px; }

.hroles { list-style: none; margin: 8px 0 12px; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2px 16px; font-size: 12.5px; }
.hroles li { display: flex; gap: 7px; align-items: baseline; color: var(--muted); }
.hroles strong { color: var(--ink); font-weight: 500; }

.hswatch { flex: none; display: inline-block; width: 8px; height: 8px; border-radius: 1px; background: var(--role); border: 1px solid var(--rule); }
.role-structure { --role: var(--accent); }
.role-reference { --role: var(--brass); }
.role-chunk { --role: var(--oxide); }
.role-value { --role: var(--muted); }
.role-unset { --role: var(--rule); }

.hlegend { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.hkey {
  display: inline-flex; align-items: center; gap: 6px;
  font: 400 11px "IBM Plex Mono", monospace;
  background: var(--panel); color: var(--ink);
  border: 1px solid var(--rule); border-radius: 2px;
  padding: 3px 7px; cursor: pointer;
}
.hkey:hover, .hkey.on { border-color: var(--accent); background: var(--accent-wash); }
.hcount { color: var(--muted); font-variant-numeric: tabular-nums; }

.heap { display: grid; grid-template-columns: minmax(0, 1fr) 256px; gap: 14px; align-items: start; }
.hgrid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 32), 1fr);
  gap: 1px;
  padding: 8px;
  background: var(--panel);
  border: 1px solid var(--rule);
  border-radius: 2px;
  min-width: 0;
}
.hgrid:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hcell {
  aspect-ratio: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 1px;
  background: var(--role);
  opacity: .72;
  cursor: pointer;
}
.hcell:hover { opacity: 1; }
/* A page boundary is a labelled rule across the grid, not a mark on one cell. */
.hpage {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 3px 0 1px;
  font: 500 9.5px "IBM Plex Mono", monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--muted);
}
.hpage::after { content: ""; flex: 1; height: 1px; background: var(--ink); opacity: .35; }
.hgrid.dimmed .hcell { opacity: .13; }
.hgrid.dimmed .hcell.match { opacity: 1; }
.hcell.sel { outline: 1.5px solid var(--ink); outline-offset: 1px; opacity: 1; z-index: 1; }
.hcell.tnext { outline: 1.5px solid var(--brass); outline-offset: 1px; opacity: 1; z-index: 1; }
.hcell.tref { outline: 1.5px solid var(--accent); outline-offset: 1px; opacity: 1; z-index: 1; }

.hpanel { background: var(--panel); border: 1px solid var(--rule); border-top: 2px solid var(--accent); border-radius: 2px; padding: 14px 16px; position: sticky; top: 16px; }
.hpanel-empty { color: var(--muted); font-size: 13.5px; margin: 0; }
.hpanel h5 { margin: 0 0 2px; font: 500 15px "IBM Plex Mono", monospace; }
.hpanel .hrole { font-size: 12px; line-height: 1.45; color: var(--muted); margin: 4px 0 0; }
.hpanel .hrole span { font: 500 10px "IBM Plex Mono", monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--ink); margin-right: 4px; }
.hpanel dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 9px; margin: 10px 0 0; font-size: 12px; }
.hpanel dt { font: 400 11px/1.6 "IBM Plex Mono", monospace; color: var(--muted); }
.hpanel dd { margin: 0; font: 400 12px/1.6 "IBM Plex Mono", monospace; overflow-wrap: anywhere; }
.hpanel .hdoc { font-size: 13px; color: var(--muted); margin: 8px 0 0; line-height: 1.5; }
.hpanel .hstr { color: var(--oxide); }
.hdetails { margin-top: 20px; font-size: 14px; }
.hdetails summary { cursor: pointer; font-weight: 500; }
.hdetails ul { margin-top: 10px; }

@media (max-width: 760px) {
  .heap { grid-template-columns: minmax(0, 1fr); }
  .hpanel { position: static; }
  .hgrid { --cols: 32; }
}

/* atoms ---------------------------------------------------------------- */
.atoms {
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(238px, 1fr));
  gap: 2px 18px;
}
.atom { position: relative; padding: 6px 0 6px 10px; border-bottom: 1px solid var(--hair); border-left: 2px solid var(--accent); }
.atom-opt { border-left-style: dotted; border-left-color: var(--muted); }
.atom-tag { font: 500 13px "IBM Plex Mono", monospace; }
.atom-n { float: right; font: 400 11px "IBM Plex Mono", monospace; color: var(--muted); font-variant-numeric: tabular-nums; }
.cols { line-height: 2; }
.cols code { margin-right: 4px; }

/* cards ---------------------------------------------------------------- */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(288px, 1fr)); gap: 16px; margin-top: 24px; }
.card { background: var(--panel); border: 1px solid var(--rule); border-top: 2px solid var(--accent); border-radius: 2px; padding: 16px 18px 18px; }
.card header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.card header h3 { margin: 0; font-family: "IBM Plex Mono", monospace; font-size: 14.5px; }
.card > p { font-size: 14px; color: var(--muted); margin: 0; }
.impl-list, .verdict-list, .waypoints { margin: 0; padding-left: 17px; font-size: 13.5px; }
.impl-list { list-style: none; padding-left: 0; }
.impl-list li { margin-bottom: 8px; }
.verdict-list li { margin-bottom: 6px; }
.verdict-list strong { font-family: "IBM Plex Mono", monospace; font-size: 12.5px; }
.waypoints { margin-top: 12px; }
.waypoints li { margin-bottom: 9px; }

/* workflows ------------------------------------------------------------ */
.workflows { display: flex; flex-direction: column; gap: 20px; margin-top: 24px; }
.workflow h3 { font-family: "IBM Plex Mono", monospace; font-size: 14px; margin-bottom: 10px; }
.steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 11px; }
.step-name { font-size: 13.5px; font-weight: 500; }
pre { margin: 5px 0 0; padding: 9px 11px; background: var(--paper); border: 1px solid var(--rule); border-radius: 2px; overflow-x: auto; }
pre code { background: none; border: 0; padding: 0; font-size: 11.5px; line-height: 1.6; }

/* inline ---------------------------------------------------------------- */
code { font: 400 .89em/1.5 "IBM Plex Mono", ui-monospace, monospace; background: var(--paper); border: 1px solid var(--hair); border-radius: 2px; padding: 0 4px; }
.ref {
  font: 400 12px/1.5 "IBM Plex Mono", ui-monospace, monospace;
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--accent-wash);
  word-break: break-word;
}
.ref:hover { border-bottom-color: var(--accent); background: var(--accent-wash); }
.tag {
  display: inline-block;
  font: 500 10px/1.7 "IBM Plex Mono", monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--muted);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 0 5px;
  white-space: nowrap;
}
.tag-oxide { color: var(--oxide); border-color: var(--oxide); }
.verdict { display: inline-block; font: 500 10.5px/1.7 "IBM Plex Mono", monospace; border-radius: 2px; padding: 1px 6px; white-space: nowrap; }
.verdict-landed { color: var(--good); border: 1px solid var(--good); }
.verdict-partial { color: var(--brass); border: 1px solid var(--brass); }
.verdict-blocked { color: var(--oxide); border: 1px solid var(--oxide); }

footer { grid-column: 1 / -1; border-top: 1px solid var(--rule); margin-top: 64px; padding-top: 20px; font-size: 12.5px; color: var(--muted); }
footer p { max-width: 82ch; }
a:focus-visible, button:focus-visible, input:focus-visible, .node:focus-visible rect { outline: 2px solid var(--accent); outline-offset: 2px; }

@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .rail {
    position: sticky;
    top: env(safe-area-inset-top, 0px);
    z-index: 5;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
    padding-block: 8px;
    max-height: none;
  }
  .rail nav { flex-direction: row; overflow-x: auto; }
  .rail a { white-space: nowrap; border-left: 0; border-bottom: 1.5px solid transparent; }
  .rail a:hover, .rail a.here { border-left: 0; border-bottom-color: var(--accent); }
  main { gap: 56px; }
  .search { width: 132px; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
"""

SCRIPT = """
(function () {
  'use strict';

  // --- theme -----------------------------------------------------------
  var root = document.documentElement;
  var themeBtn = document.getElementById('theme');
  var stored = null;
  try { stored = localStorage.getItem('ih-map-theme'); } catch (e) { stored = null; }
  if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var dark = root.getAttribute('data-theme') === 'dark' ||
        (!root.hasAttribute('data-theme') &&
         window.matchMedia('(prefers-color-scheme: dark)').matches);
      var next = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('ih-map-theme', next); } catch (e) {}
    });
  }

  // --- crate graph selection -------------------------------------------
  var graph = document.getElementById('crate-graph');
  var panels = document.getElementById('crate-panels');
  var rows = document.getElementById('crate-rows');
  var edges = graph ? Array.prototype.slice.call(graph.querySelectorAll('.edge')) : [];
  var nodes = graph ? Array.prototype.slice.call(graph.querySelectorAll('.node')) : [];

  function select(name) {
    if (!graph) return;
    graph.classList.add('has-selection');
    var neighbours = {};
    edges.forEach(function (edge) {
      var from = edge.getAttribute('data-from');
      var to = edge.getAttribute('data-to');
      var lit = from === name || to === name;
      edge.classList.toggle('lit', lit);
      if (lit) { neighbours[from] = true; neighbours[to] = true; }
    });
    nodes.forEach(function (node) {
      var id = node.getAttribute('data-crate');
      node.classList.toggle('chosen', id === name);
      node.classList.toggle('lit', !!neighbours[id]);
    });
    if (panels) {
      Array.prototype.forEach.call(panels.children, function (panel) {
        panel.hidden = panel.getAttribute('data-panel') !== name;
      });
    }
    if (rows) {
      Array.prototype.forEach.call(rows.children, function (row) {
        row.classList.toggle('on', row.getAttribute('data-crate') === name);
      });
    }
  }

  nodes.forEach(function (node) {
    var name = node.getAttribute('data-crate');
    node.addEventListener('click', function () { select(name); });
    node.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(name); }
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.crate-pick'), function (button) {
    button.addEventListener('click', function () {
      select(button.getAttribute('data-crate'));
      if (graph) graph.scrollIntoView({ block: 'nearest' });
    });
  });
  // The VM is where nearly every task starts, so the panel opens on it.
  if (nodes.length) select('ironhorse-vm');

  // --- halt filter ------------------------------------------------------
  var haltRows = document.querySelectorAll('#halt-rows .halt-row');
  Array.prototype.forEach.call(document.querySelectorAll('[data-halt]'), function (button) {
    button.addEventListener('click', function () {
      var want = button.getAttribute('data-halt');
      Array.prototype.forEach.call(document.querySelectorAll('[data-halt]'), function (other) {
        other.classList.toggle('on', other === button);
      });
      Array.prototype.forEach.call(haltRows, function (row) {
        row.hidden = want !== 'all' && row.getAttribute('data-kind') !== want;
      });
    });
  });

  // --- search -----------------------------------------------------------
  var search = document.getElementById('search');
  var count = document.getElementById('match-count');
  var targets = Array.prototype.slice.call(document.querySelectorAll('.filterable'));
  targets.forEach(function (node) {
    node.dataset.haystack = (node.getAttribute('data-text') || node.textContent).toLowerCase();
  });

  function applySearch(term) {
    var query = term.trim().toLowerCase();
    var hits = 0;
    targets.forEach(function (node) {
      var match = !query || node.dataset.haystack.indexOf(query) !== -1;
      node.hidden = !match;
      if (query && match) hits += 1;
    });
    if (count) count.textContent = query ? hits + ' matches' : '';
  }

  if (search) {
    search.addEventListener('input', function () { applySearch(search.value); });
    search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { search.value = ''; applySearch(''); search.blur(); }
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === '/' && search && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });


  // --- heap explorer ----------------------------------------------------
  var heapEl = document.getElementById('heap-data');
  var grid = document.getElementById('hgrid');
  if (heapEl && grid) {
    var H = JSON.parse(heapEl.textContent);
    var panel = document.getElementById('hpanel');
    var cells = Array.prototype.slice.call(grid.querySelectorAll('.hcell'));
    var COLS = H.cols;
    var selected = -1;
    var isolated = null;

    function slotAt(i) {
      if (i < 0 || i >= H.slots.length) return null;
      var parts = H.slots[i].split(',');
      var out = {};
      H.columns.forEach(function (name, n) { out[name] = parseInt(parts[n], 10); });
      return out;
    }

    function esc(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }

    function handle(v) { return v === H.null ? 'NULL' : String(v); }

    function describe(i) {
      var s = slotAt(i);
      if (!s) return;
      var kind = H.kinds[String(s.kind)] || { n: '?' + s.kind, d: '', r: 'value' };
      var tag = H.tags[String(s.ptag)] || String(s.ptag);
      var rows = [
        ['index', String(i)],
        ['page', String(Math.floor(i / H.perPage)) + ' · offset ' + (i % H.perPage)],
        ['flag', '0x' + s.flag.toString(16).padStart(2, '0')],
        ['id', String(s.id)],
        ['next', handle(s.next)],
        ['payload', tag],
      ];
      if (s.ptag === 5) rows.push(['→ slot', handle(s.value)]);
      if (s.ptag === 4 || s.ptag === 7) rows.push(['→ chunk', handle(s.value)]);
      if (s.ptag === 2) rows.push(['value', String(s.value)]);
      if (s.ptag === 1) rows.push(['value', s.value ? 'true' : 'false']);
      var text = s.str >= 0 ? H.strings[s.str] : null;
      var html = '<h5>' + esc(kind.n) + '</h5>' +
        '<p class="hrole"><span>' + esc(kind.r) + '</span> ' +
          esc(H.roleMeaning[kind.r] || '') + '</p>' +
        '<dl>' + rows.map(function (r) {
          return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
        }).join('') + '</dl>';
      if (text !== null) {
        html += '<dl><dt>text</dt><dd class="hstr">' + esc(JSON.stringify(text)) + '</dd></dl>';
      }
      if (kind.d) html += '<p class="hdoc">' + esc(kind.d) + '</p>';
      var doc = H.payloadDocs[tag];
      if (doc) html += '<p class="hdoc">' + esc(doc) + '</p>';
      panel.innerHTML = html;

      cells.forEach(function (c) { c.classList.remove('sel', 'tnext', 'tref'); });
      cells[i].classList.add('sel');
      if (s.next !== H.null && cells[s.next]) cells[s.next].classList.add('tnext');
      if (s.ptag === 5 && s.value !== H.null && cells[s.value]) {
        cells[s.value].classList.add('tref');
      }
      selected = i;
    }

    grid.addEventListener('mouseover', function (event) {
      var cell = event.target.closest('.hcell');
      if (cell) describe(parseInt(cell.getAttribute('data-i'), 10));
    });
    grid.addEventListener('click', function (event) {
      var cell = event.target.closest('.hcell');
      if (cell) { describe(parseInt(cell.getAttribute('data-i'), 10)); grid.focus(); }
    });
    grid.addEventListener('keydown', function (event) {
      var step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[event.key];
      if (!step) return;
      event.preventDefault();
      var next = Math.max(0, Math.min(H.slots.length - 1, (selected < 0 ? 0 : selected) + step));
      describe(next);
      cells[next].scrollIntoView({ block: 'nearest' });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.hkey'), function (key) {
      key.addEventListener('click', function () {
        var name = key.getAttribute('data-kind');
        isolated = isolated === name ? null : name;
        Array.prototype.forEach.call(document.querySelectorAll('.hkey'), function (other) {
          other.classList.toggle('on', other.getAttribute('data-kind') === isolated);
        });
        grid.classList.toggle('dimmed', !!isolated);
        cells.forEach(function (cell, i) {
          var s = slotAt(i);
          var kind = H.kinds[String(s.kind)];
          cell.classList.toggle('match', !!isolated && kind && kind.n === isolated);
        });
      });
    });


    // --- counter stepper and landmarks ----------------------------------
    var counter = H.counter;
    if (counter) {
      var watched = counter.slots.map(function (s) { return s.slot; });
      watched.forEach(function (index) {
        if (cells[index]) cells[index].classList.add('watch');
      });

      var showCount = function (count) {
        var step = counter.counts.indexOf(count);
        if (step < 0) return;
        Array.prototype.forEach.call(document.querySelectorAll('.cstep'), function (b) {
          b.classList.toggle('on', parseInt(b.getAttribute('data-count'), 10) === count);
        });
        counter.slots.forEach(function (s) {
          var out = document.querySelector('.cval[data-slot="' + s.slot + '"]');
          if (out) out.textContent = s.values[step];
        });

        var io = counter.io[step];
        if (!io) return;
        var bytes = function (n) { return n.toLocaleString() + ' B'; };
        var plural = function (n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); };
        var first = io.count === 0;
        var label = document.getElementById('cio-label');
        if (label) {
          label.textContent = first
            ? 'What the first checkpoint wrote'
            : 'What that checkpoint wrote';
        }
        var fill = function (key, value) {
          var node = document.querySelector('[data-io="' + key + '"]');
          if (node) node.textContent = value;
        };
        fill('changed_bytes', first ? '—' : bytes(io.changed_bytes));
        fill('changed_note', first
          ? 'the whole arena, not a dirty subset'
          : plural(io.changed_slots, 'slot record'));
        fill('slot_bytes', bytes(io.slot_bytes));
        fill('pages_note', plural(io.pages, 'page'));
        fill('extent_bytes', bytes(io.extent_bytes));
        fill('extent_note', io.extent_rows
          ? plural(io.extent_rows, 'extent')
          : 'no extent touched');
        fill('small_bytes', bytes(io.small_bytes));
        fill('sections_note', io.sections + ' of ' + counter.section_count + ' sections');
        fill('written', bytes(io.written));
        fill('ratio_note', io.changed_bytes
          ? Math.round(io.written / io.changed_bytes) + '\u00d7 the change'
          : 'the initial write');
      };

      Array.prototype.forEach.call(document.querySelectorAll('.cstep'), function (b) {
        b.addEventListener('click', function () {
          showCount(parseInt(b.getAttribute('data-count'), 10));
        });
      });
      // Fill it for the drawn capture, so the section reads correctly before
      // anyone touches the stepper.
      showCount(counter.canonical);

      Array.prototype.forEach.call(document.querySelectorAll('.cjump'), function (b) {
        b.addEventListener('click', function () {
          var index = parseInt(b.getAttribute('data-slot'), 10);
          describe(index);
          cells[index].scrollIntoView({ block: 'center' });
        });
      });
    }

    // Open on the slot holding the count, which is what this section is
    // about, so the panel is never blank and starts somewhere meaningful.
    describe(counter && counter.slots.length
      ? counter.slots[counter.slots.length - 1].slot
      : 0);
  }

  // --- slot record layout -----------------------------------------------
  var recordNote = document.getElementById('record-note');
  var recordDefault = recordNote ? recordNote.innerHTML : '';
  Array.prototype.forEach.call(document.querySelectorAll('.rfield'), function (field) {
    function show() {
      Array.prototype.forEach.call(document.querySelectorAll('.rfield'), function (other) {
        other.classList.toggle('on', other === field);
      });
      if (recordNote) {
        var raw = field.getAttribute('data-range') + ' \u2014 ' +
          field.getAttribute('data-field');
        recordNote.innerHTML = raw
          .replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
          })
          .replace(/`([^`]+)`/g, '<code>$1</code>');
      }
    }
    field.addEventListener('mouseenter', show);
    field.addEventListener('focus', show);
    field.addEventListener('click', show);
  });
  var layoutEl = document.getElementById('record-layout');
  if (layoutEl && recordNote) {
    layoutEl.addEventListener('mouseleave', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.rfield'), function (other) {
        other.classList.remove('on');
      });
      recordNote.innerHTML = recordDefault;
    });
  }

  // --- rail position ----------------------------------------------------
  var links = {};
  Array.prototype.forEach.call(document.querySelectorAll('.rail a'), function (anchor) {
    links[anchor.getAttribute('href').slice(1)] = anchor;
  });
  if (window.IntersectionObserver) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var anchor = links[entry.target.id];
        if (anchor && entry.isIntersecting) {
          Object.keys(links).forEach(function (id) { links[id].classList.remove('here'); });
          anchor.classList.add('here');
        }
      });
    }, { rootMargin: '-10% 0px -75% 0px' });
    Array.prototype.forEach.call(document.querySelectorAll('.plate'), function (plate) {
      observer.observe(plate);
    });
  }
})();
"""


def render(model):
    commit = model.get("commit", "")
    short = commit[:12] if commit else "working tree"
    nav = "".join(
        f'<a href="#{key}"><span class="nav-no">{index:02d}</span>{esc(title)}</a>'
        for index, (key, title, _) in enumerate(PLATES))
    builders = {
        "orientation": orientation_plate, "context": context_plate,
        "crates": crates_plate, "seams": seams_plate, "crank": crank_plate,
        "persist": persist_plate, "layout": layout_plate,
        "hazards": hazards_plate,
        "recipes": recipes_plate, "checks": checks_plate, "status": status_plate,
    }
    plates = "\n".join(
        plate(index, key, title, kicker, builders[key](model))
        for index, (key, title, kicker) in enumerate(PLATES))
    head = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>IronHorse Engine Map</title>
<meta name="description" content="An onboarding map of the IronHorse JavaScript engine: crates, seams, the crank, persistence gates, and the inferences the code refuses.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Serif:wght@400&display=swap">
<style>{STYLE}</style>
</head>
<body>
<div class="shell">

<header class="masthead">
  <p class="eyebrow">
    <span>Engine map &middot; rust/engine</span>
    <span class="controls">
      <span class="match-count" id="match-count"></span>
      <input class="search" id="search" type="search" placeholder="filter  /"
        aria-label="Filter the crates, modules, hazards, and checks">
      <button class="ghost" id="theme" type="button">Theme</button>
    </span>
  </p>
  <h1>IronHorse</h1>
  <p class="sub">This map is for developers who must change the engine. It shows the
  crates, the four seams, one unit of execution, the data that survives a restart, and
  the conclusions that the code does not permit.</p>
  <div class="provenance">
    <span>commit <b>{esc(short)}</b></span>
    <span>crates <b>{model['totals']['crates']}</b></span>
    <span>source lines <b>{model['totals']['lines']:,}</b></span>
    <span>modules <b>{model['totals']['modules']}</b></span>
    <span>generated by <b>scripts/engine-map.py</b></span>
  </div>
</header>

<aside class="rail"><nav aria-label="Report sections">{nav}</nav></aside>

<main>
{plates}
</main>

<footer>
  <p>The script <code>rust/engine/scripts/engine-map-model.py</code> reads the Cargo
  metadata, the Rust sources, and the guides. It writes
  <code>architecture-map.json</code>. The script
  <code>rust/engine/scripts/engine-map.py</code> reads that file and writes this page.
  Each count, line, constant, and link on this page comes from the model. Therefore this
  map cannot show a structure that the source tree does not contain. Run both scripts
  again after you change the source tree. If you do not, CI reports the difference. The
  code links use commit <code>{esc(short)}</code>, so the line numbers are correct for
  that commit. In a later revision, find the symbol by name instead of the line
  number.</p>
  <p>All text on this page uses Simplified Technical English, except the quoted
  sentences in plate {esc(plate_no("hazards"))} and the descriptions that the tool copies from source
  comments.</p>
</footer>

</div>
<script>{SCRIPT}</script>
</body>
</html>
"""
    return head


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="fail when the checked-in page has drifted from the model")
    args = parser.parse_args()
    if not MODEL.is_file():
        print(f"missing {MODEL}; run engine-map-model.py first")
        return 1
    expected = render(json.loads(MODEL.read_text()))
    if args.check:
        actual = OUTPUT.read_text() if OUTPUT.exists() else ""
        # The page carries the commit its links point at, in short and long
        # form, and that changes with every commit to the repository. The
        # check ignores it so unrelated work does not fail this gate.
        if strip_commit(actual) != strip_commit(expected):
            print("".join(difflib.unified_diff(
                strip_commit(actual).splitlines(True),
                strip_commit(expected).splitlines(True),
                fromfile=str(OUTPUT), tofile="generated")))
            return 1
    else:
        OUTPUT.write_text(expected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
