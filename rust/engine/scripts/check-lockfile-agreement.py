#!/usr/bin/env python3
"""Require identical resolutions for shared IronHorse dependencies (Python 3.11+).

Walk both lockfiles from the IronHorse path crates present in both workspaces.
Compare version, source, and checksum sets for dependency names in both walks,
and resolved dependency edges of shared parent packages. Equal version sets
alone would miss two parents exchanging their dependency versions.
Unrelated root-workspace crates may legitimately need other major versions of
the same dependency; those versions are not part of the shared subset. Cargo
lockfiles include optional and target-specific edges, so this does not depend
on the platform or features enabled on the machine running the check.

Run from any directory: python3 rust/engine/scripts/check-lockfile-agreement.py
To reconcile drift, use cargo update --package NAME --precise VERSION in the
workspace being updated, then commit that workspace's Cargo.lock.
"""

import sys
import tomllib
from collections import defaultdict
from pathlib import Path


def package_id(package):
    return package["name"], package["version"], package.get("source", "")


def shared_dependencies(packages, roots):
    """Resolve Cargo's unqualified, version-qualified, and source-qualified IDs."""
    by_name = defaultdict(list)
    for package in packages:
        by_name[package["name"]].append(package)
    pending = [p for p in packages if p["name"] in roots and "source" not in p]
    visited = set()
    resolutions = defaultdict(set)
    edges = {}
    while pending:
        package = pending.pop()
        identity = package_id(package)
        if identity in visited:
            continue
        visited.add(identity)
        resolutions[package["name"]].add(
            (package["version"], package.get("source", ""), package.get("checksum", ""))
        )
        edges[identity] = defaultdict(set)
        for dependency in package.get("dependencies", []):
            parts = dependency.split(" ", 2)
            matches = [
                candidate
                for candidate in by_name[parts[0]]
                if (len(parts) < 2 or candidate["version"] == parts[1])
                and (len(parts) < 3 or f"({candidate.get('source', '')})" == parts[2])
            ]
            if len(matches) != 1:
                raise ValueError(f"{identity}: dependency {dependency!r} is missing or ambiguous")
            edges[identity][parts[0]].add(package_id(matches[0]))
            pending.append(matches[0])
    return resolutions, edges


def disagreements(root_packages, engine_packages):
    path_names = lambda packages: {
        p["name"] for p in packages
        if p["name"].startswith("ironhorse-") and "source" not in p
    }
    roots = path_names(root_packages) & path_names(engine_packages)
    if not {"ironhorse-vm", "ironhorse-snapshot"} <= roots:
        raise ValueError("Both lockfiles must contain the IronHorse VM and snapshot crates")
    root, root_edges = shared_dependencies(root_packages, roots)
    engine, engine_edges = shared_dependencies(engine_packages, roots)
    errors = [
        f"{name}: root={sorted(root[name])!r}; engine={sorted(engine[name])!r}"
        for name in sorted(root.keys() & engine.keys())
        if root[name] != engine[name]
    ]
    for parent in sorted(root_edges.keys() & engine_edges.keys()):
        root_deps, engine_deps = root_edges[parent], engine_edges[parent]
        # Features may activate an optional dependency in only one workspace.
        # Every dependency name used by the same parent in both must resolve
        # identically, even when both lockfiles contain multiple versions.
        for name in sorted(root_deps.keys() & engine_deps.keys()):
            if root_deps[name] != engine_deps[name]:
                errors.append(
                    f"{parent} -> {name}: root={sorted(root_deps[name])!r}; "
                    f"engine={sorted(engine_deps[name])!r}"
                )
    return errors


def main():
    repository = Path(__file__).resolve().parents[3]
    try:
        with (repository / "Cargo.lock").open("rb") as stream:
            root = tomllib.load(stream)["package"]
        with (repository / "rust/engine/Cargo.lock").open("rb") as stream:
            engine = tomllib.load(stream)["package"]
        errors = disagreements(root, engine)
    except (OSError, ValueError, KeyError) as error:
        print(f"Lockfile agreement check failed: {error}", file=sys.stderr)
        return 1
    if errors:
        print("IronHorse dependency resolutions disagree:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print("Shared IronHorse dependency resolutions agree.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
