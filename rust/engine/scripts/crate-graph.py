#!/usr/bin/env python3
"""Generate the workspace dependency diagram from Cargo's manifest model."""

import argparse
import difflib
import json
from pathlib import Path
import subprocess

ENGINE = Path(__file__).resolve().parents[1]
OUTPUT = ENGINE / "CRATE-GRAPH.md"


def metadata():
    return json.loads(subprocess.check_output([
        "cargo", "metadata", "--locked", "--no-deps", "--format-version", "1",
        "--manifest-path", str(ENGINE / "Cargo.toml"),
    ], text=True))


def render(data):
    members = set(data["workspace_members"])
    packages = sorted((p for p in data["packages"] if p["id"] in members),
                      key=lambda p: p["name"])
    # Labels use package names even when a dependency is renamed at its import site.
    names = {p["name"]: p["name"].replace("-", "_") for p in packages}
    lines = [
        "# Engine crate dependencies", "",
        "Generated from Cargo metadata; do not edit this diagram by hand.",
        "Regenerate: `python3 rust/engine/scripts/crate-graph.py` from the repository root.",
        "CI checks drift with the same command plus `--check`.",
        "Arrows point from dependent to dependency.",
        "Solid edges are normal dependencies; dashed edges are development dependencies.",
        "Optional dependencies are labeled: their presence does not mean the default build links them.",
        "", "```mermaid", "flowchart TD",
    ]
    for package in packages:
        name = package["name"]
        lines.append(f'    {names[name]}["{name}"]')
    for package in packages:
        for dep in sorted(package["dependencies"],
                          key=lambda d: (d["name"], d["kind"] or "", d.get("target") or "")):
            # Only local path edges into this workspace belong in this graph.
            target = next((p for p in packages if p["name"] == dep["name"]
                           and dep.get("path") is not None
                           and Path(p["manifest_path"]).parent == Path(dep["path"])), None)
            if target is None:
                continue
            kind = dep["kind"] or "normal"
            label = kind + (" optional" if dep["optional"] else "")
            if dep.get("target"):
                label += " " + dep["target"].replace('"', "&quot;")
            edge = "-.->" if kind == "dev" else "-->"
            lines.append(f'    {names[package["name"]]} {edge}|"{label}"| {names[target["name"]]}')
    lines += [
        "```", "",
        "This graph includes optional oracle dependencies and the self development edge used",
        "to enable snapshot tooling in tests.",
        "External dependencies and outer-workspace consumers are described in",
        "[ARCHITECTURE.md](ARCHITECTURE.md), not represented as workspace members.",
    ]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = render(metadata())
    if args.check:
        actual = OUTPUT.read_text() if OUTPUT.exists() else ""
        if actual != expected:
            print("".join(difflib.unified_diff(actual.splitlines(True), expected.splitlines(True),
                                             fromfile=str(OUTPUT), tofile="generated")))
            return 1
    else:
        OUTPUT.write_text(expected)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
