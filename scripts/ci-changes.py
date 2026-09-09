#!/usr/bin/env python3
"""Select CI jobs using the changed range and both revisions' dependency graphs.

No package manager, third-party Python modules, network metadata service, or
changed-files API is needed. Invalid ranges/manifests fail the detector rather
than reporting a successful run with missing checks. Call with --all for local
inspection, or use GitHub's event environment. --paths accepts paths for audits.
"""

import argparse
import json
import os
from pathlib import PurePosixPath
import posixpath
import re
import subprocess
import tomllib


JOBS = (
    "test", "cover", "lint", "familiar-bundle", "sandbox-drivers",
    "test-async-hooks", "test-hermes", "test-xs", "build-xsnap",
    "test-thixotrope-ironhorse", "format-ironhorse", "test-ironhorse",
    "test-ironhorse-calibration", "compare-ironhorse-math",
    "test-ironhorse-oracle", "oracle-sanitizers", "test-ocapn-python",
    "build-wasm", "browser-tests", "guile-interop", "viable-release",
    "depcheck", "check-action-pins", "package-uniformity", "filter-tests",
)
JS_JOBS = {
    "test", "cover", "lint", "familiar-bundle", "sandbox-drivers",
    "test-async-hooks", "test-hermes", "test-xs", "build-xsnap",
    "test-thixotrope-ironhorse", "test-ocapn-python", "browser-tests",
    "guile-interop", "viable-release", "depcheck", "check-action-pins", "package-uniformity",
}
RUST_JOBS = {
    "build-xsnap", "test-thixotrope-ironhorse", "format-ironhorse",
    "test-ironhorse", "test-ironhorse-calibration", "compare-ironhorse-math",
    "test-ironhorse-oracle", "oracle-sanitizers", "build-wasm",
}
WORKFLOWS = {
    ".github/workflows/browser-test.yml": {"browser-tests"},
    ".github/workflows/ocapn-guile-interop.yml": {"guile-interop"},
    ".github/workflows/depcheck.yml": {"depcheck"},
    ".github/workflows/ironhorse-sanitizers.yml": {"oracle-sanitizers"},
}
CORE = {
    "ironhorse-meter", "ironhorse-vm", "ironhorse-snapshot",
    "ironhorse-compile", "ironhorse-regexp", "ironhorse-store-sqlite",
}


def git(*args):
    return subprocess.check_output(["git", *args])


def commit(revision):
    # Events contain commit object IDs, never arbitrary Git revision syntax.
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", revision):
        raise ValueError(f"Invalid commit object ID: {revision!r}")
    if subprocess.run(
        ["git", "cat-file", "-e", f"{revision}^{{commit}}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode:
        # A force push can remove the old tip from all fetched refs.
        git("fetch", "--no-tags", "origin", revision)
    return revision


def change_range(event):
    """Return (base, head, paths); base is the PR merge base or push before."""
    if "pull_request" in event:
        pr = event["pull_request"]
        base, head = commit(pr["base"]["sha"]), commit(pr["head"]["sha"])
        base = git("merge-base", base, head).decode().strip()
    else:
        if event.get("deleted"):
            raise ValueError("A deleted branch has no checkout to test")
        head = commit(event["after"])
        before = event["before"]
        if before and set(before) == {"0"}:
            paths = git("ls-tree", "-r", "--name-only", "-z", head)
            return None, head, decode_paths(paths)
        base = commit(before)
    # Disable rename detection: both the old and new owner must be selected.
    paths = git("diff", "--no-renames", "--name-only", "-z", base, head, "--")
    return base, head, decode_paths(paths)


def decode_paths(data):
    return [os.fsdecode(path) for path in data.split(b"\0") if path]


def manifests(revision):
    paths = decode_paths(git("ls-tree", "-r", "--name-only", "-z", revision))
    return {
        path: git("show", f"{revision}:{path}").decode()
        for path in paths
        if re.fullmatch(r"packages/[^/]+/package.json", path)
        or path == "Cargo.toml" or path.endswith("/Cargo.toml")
    }


class Graph:
    def __init__(self, files):
        self.js = {}
        self.rust = {}
        self.edges = {}
        self.owners = {}
        self.crate_names = {}
        self.workspaces = {}
        for path, source in files.items():
            directory = str(PurePosixPath(path).parent)
            if path.endswith("package.json"):
                manifest = json.loads(source)
                name = manifest["name"]
                if name in self.js:
                    raise ValueError(f"Duplicate workspace name {name}")
                self.js[name] = manifest
                node = f"js:{name}"
            else:
                manifest = tomllib.loads(source)
                if "workspace" in manifest:
                    self.workspaces[directory] = manifest["workspace"]
                if "package" not in manifest:
                    continue
                self.rust[directory] = manifest
                self.crate_names[directory] = manifest["package"]["name"]
                node = f"rust:{directory}"
            self.owners[directory] = node
            self.edges[node] = set()
        for name, manifest in self.js.items():
            for kind in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
                for dep, version in manifest.get(kind, {}).items():
                    if dep in self.js:
                        self.edges[f"js:{name}"].add(f"js:{dep}")
                    elif version.startswith("workspace:"):
                        raise ValueError(f"Missing workspace dependency {name} -> {dep}")
        for directory, manifest in self.rust.items():
            tables = [manifest, *manifest.get("target", {}).values()]
            for table in tables:
                for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
                    for name, dependency in table.get(kind, {}).items():
                        origin = directory
                        if not isinstance(dependency, dict):
                            continue
                        if dependency.get("workspace"):
                            parents = [p for p in self.workspaces if under(directory, p)]
                            if not parents:
                                raise ValueError(f"No workspace for {directory}")
                            origin = max(parents, key=len)
                            dependency = self.workspaces[origin]["dependencies"][name]
                        if isinstance(dependency, dict) and "path" in dependency:
                            target = posixpath.normpath(posixpath.join(origin, dependency["path"]))
                            if target not in self.rust:
                                raise ValueError(f"Missing local crate {directory} -> {target}")
                            self.edges[f"rust:{directory}"].add(f"rust:{target}")

    def affected(self, paths, oracle=True):
        changed = set()
        for path in paths:
            owners = [p for p in self.owners if under(path, p)]
            if owners:
                changed.add(self.owners[max(owners, key=len)])
        return self.propagate(changed, oracle)

    def propagate(self, changed, oracle=True):
        changed = set(changed)
        while True:
            more = {
                node for node, deps in self.edges.items()
                if any(dep in changed and (oracle or not dep.endswith("/xs-oracle")) for dep in deps)
            } - changed
            if not more:
                return changed
            changed.update(more)

    def crates(self, nodes):
        return {self.crate_names[node[5:]] for node in nodes if node.startswith("rust:")}


def under(path, directory):
    return directory == "." or path == directory or path.startswith(f"{directory}/")


def shared_js(path):
    return (
        path in {"package.json", "yarn.lock", ".node-version", ".yarnrc.yml", ".npmrc", "turbo.json"}
        or path.startswith((".yarn/", ".github/actions/"))
        or ("/" not in path and path.startswith(("ava", "tsconfig", "eslint", ".eslint", ".prettier")))
    )


def classify(paths, graphs, all_jobs=False):
    """Use the union of dependency closures, preserving removed edges/owners."""
    jobs = dict.fromkeys(JOBS, False)
    current = graphs[-1]
    package_names = set()
    if all_jobs or any(path in {
        "scripts/ci-changes.py", "scripts/test-ci-changes.py",
        "scripts/run-ci-task.py", "scripts/test-run-ci-task.py",
        ".github/workflows/ci-changes.yml", ".github/workflows/ironhorse-changes.yml",
        ".github/workflows/ci.yml",
    } for path in paths):
        return {"jobs": dict.fromkeys(JOBS, True), "packages": sorted(current.js)}

    # Benchmarks, design notes and nightly expectation baselines are not inputs
    # to cargo test/build/clippy. The two PR-gated expectation files are inputs.
    rust_paths = [p for p in paths if not (
        p.endswith(".md") or "/benches/" in p
        or ("/expectations/" in p and p not in {
            "rust/engine/ironhorse-262/expectations/try.txt",
            "rust/engine/ironhorse-262/expectations/ironhorse.txt",
        })
    )]
    for graph in graphs:
        affected = graph.affected(paths)
        rust_affected = graph.affected(rust_paths)
        core_affected = graph.affected(rust_paths, oracle=False)
        root_rust_config = any(p in {
            "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain",
        } or p.startswith(".cargo/") for p in paths)
        engine_config = any(p in {"rust/engine/Cargo.toml", "rust/engine/Cargo.lock"}
                            or p.startswith("rust/engine/.cargo/") for p in paths)
        # Non-manifest edges: bundles and externally built engines loaded by
        # these packages. Seed them before propagation so consumers also run.
        bridge = set()
        if root_rust_config or engine_config or "ironhorse-262" in graph.crates(core_affected):
            bridge.add("js:@endo/hardened262")
        if root_rust_config or engine_config or any(under(p, "rust/thixotrope-ironhorse-worker") or under(p, "rust/thixotrope-xs-worker")
               for p in rust_paths) or "thixotrope-ironhorse-worker" in graph.crates(core_affected):
            bridge.add("js:@endo/thixotrope")
        if root_rust_config or engine_config or "endo" in graph.crates(core_affected):
            bridge.add("js:@endo/daemon")
        if root_rust_config or "ocapn_noise_protocol_facilities" in graph.crates(rust_affected):
            bridge.add("js:@endo/ocapn-noise")
        if any(under(p, "c/moddable") or p in {
            ".gitmodules", "rust/endo/xsnap/xsnap-platform.c", "rust/endo/xsnap/xsnap-platform.h",
        } for p in paths):
            bridge.update({"js:@endo/hardened262", "js:@endo/thixotrope", "js:@endo/daemon"})
        affected = graph.propagate(affected | bridge)
        packages = {n[3:] for n in affected if n.startswith("js:")}
        package_names.update(packages & current.js.keys())
        crates = graph.crates(rust_affected)
        core_crates = graph.crates(core_affected)
        jobs["test"] |= any("test" in graph.js.get(n, {}).get("scripts", {}) for n in packages)
        jobs["cover"] |= any("test:c8" in graph.js.get(n, {}).get("scripts", {}) for n in packages)
        jobs["lint"] |= bool(packages)
        jobs["viable-release"] |= any(not graph.js.get(n, {}).get("private", False) for n in packages)
        for job, roots in {
            "familiar-bundle": {"@endo/familiar", "@endo/cli", "@endo/daemon", "@endo/lal"}, "sandbox-drivers": {"@endo/sandbox"},
            "test-async-hooks": {"@endo/init"}, "test-hermes": {"ses"},
            "test-ocapn-python": {"@endo/ocapn"},
            "browser-tests": {"ses", "@endo/chat"},
            "guile-interop": {"@endo/goblin-chat", "@endo/ocapn"},
            "test-thixotrope-ironhorse": {"@endo/thixotrope"},
            "build-xsnap": {"@endo/thixotrope", "@endo/daemon"},
        }.items():
            jobs[job] |= bool(packages & roots)
        jobs["test-xs"] |= any(
            manifest.get("scripts", {}).get("test:xs", "exit 0").strip() != "exit 0"
            for name, manifest in graph.js.items() if name in packages
        )
        jobs["build-xsnap"] |= bool(core_crates & {"endo", "xsnap"})
        jobs["test-thixotrope-ironhorse"] |= "thixotrope-ironhorse-worker" in core_crates
        jobs["test-ironhorse"] |= bool(core_crates & CORE)
        jobs["test-ironhorse-calibration"] |= "ironhorse-vm" in core_crates
        jobs["test-ironhorse-oracle"] |= any(
            n.startswith("rust:rust/engine/") for n in rust_affected
        )
        jobs["oracle-sanitizers"] |= bool(crates & {
            "xs-oracle", "ironhorse-compile", "ironhorse-regexp", "ironhorse-262", "ironhorse-fuzz",
        })
        jobs["build-wasm"] |= "ocapn_noise_protocol_facilities" in crates

    for path in paths:
        if shared_js(path):
            for job in JS_JOBS:
                jobs[job] = True
            package_names.update(current.js)
        if path in {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain"} or path.startswith(".cargo/"):
            for job in RUST_JOBS:
                jobs[job] = True
        if path in {"rust/engine/Cargo.toml", "rust/engine/Cargo.lock"} or path.startswith("rust/engine/.cargo/"):
            for job in RUST_JOBS - {"build-wasm"}:
                jobs[job] = True
        if path.startswith(".github/workflows/"):
            jobs["check-action-pins"] = jobs["lint"] = True
        for job in WORKFLOWS.get(path, ()):
            jobs[job] = True
        if under(path, "browser-test"):
            jobs["browser-tests"] = True
        if path.endswith("/package.json") or path in {"scripts/check-dependency-cycles.sh", "scripts/check-packages.sh", "scripts/graph.sh"}:
            jobs["depcheck"] = True
            jobs["package-uniformity"] = True
        if path.startswith("packages/") or path in {
            ".gitignore", "scripts/check-package-uniformity.mjs", "scripts/test/check-package-uniformity.test.mjs",
        }:
            jobs["package-uniformity"] = True
        if path.startswith("scripts/"):
            jobs["lint"] = True
        if path in {"scripts/smoketest-publishing.sh", "scripts/compare-pack.mjs", "scripts/release-npm.mjs", "scripts/pack-all.mjs"}:
            jobs["viable-release"] = True
        if path == "scripts/update-action-pins.mjs":
            jobs["check-action-pins"] = True
        if path.endswith(".rs") and (under(path, "rust/engine") or under(path, "rust/endo/ironhorse-store-sqlite")):
            jobs["format-ironhorse"] = True
        if path in {
            "c/moddable", ".gitmodules", "rust/endo/xsnap/xsnap-platform.c",
            "rust/endo/xsnap/xsnap-platform.h",
        } or under(path, "packages/test262-runner/test262"):
            jobs["test-ironhorse-oracle"] = jobs["oracle-sanitizers"] = True
            jobs["test-xs"] = True
            if not under(path, "packages/test262-runner/test262"):
                jobs["build-xsnap"] = True
        if path in {
            "rust/engine/scripts/test-math-vectors.py", "rust/engine/scripts/compare-math-vectors.py",
            "rust/engine/scripts/test-lockfile-agreement.py", "rust/engine/scripts/check-lockfile-agreement.py",
            "rust/engine/scripts/test-compiler-opcodes.py", "rust/engine/scripts/generate-compiler-opcodes.py",
        }:
            jobs["format-ironhorse"] = True
        if path in {
            "rust/engine/scripts/test-oracle-sanitizers.sh",
            "rust/engine/scripts/test-oracle-sanitizer-scope.sh",
            "rust/engine/scripts/oracle-sanitizer-ignorelist.txt",
        }:
            jobs["oracle-sanitizers"] = True
        if under(path, "packages/test262-runner/test262/test/ironhorse"):
            # ironhorse-compile integration tests include these files directly.
            jobs["test-ironhorse"] = True
        if path == "packages/ocapn-noise/gen/ocapn-noise.wasm":
            jobs["build-wasm"] = True
        if path == "rust/engine/scripts/compare-math-vectors.py":
            jobs["test-ironhorse"] = True
        if under(path, "docs") or path.endswith((".md", ".sh")) or PurePosixPath(path).name.startswith("typedoc") or path in {".shellcheckrc", "SECURITY.md"}:
            jobs["lint"] = True
    jobs["lint"] |= jobs["package-uniformity"]
    # This job consumes artifacts from every matrix entry.
    jobs["compare-ironhorse-math"] = jobs["test-ironhorse"]
    return {"jobs": jobs, "packages": sorted(package_names)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--paths", nargs="*")
    args = parser.parse_args()
    all_jobs = args.all or os.environ.get("GITHUB_EVENT_NAME") in {"schedule", "workflow_dispatch"}
    if all_jobs or args.paths is not None:
        head = git("rev-parse", "HEAD").decode().strip()
        base, paths = None, args.paths or []
    else:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
            base, head, paths = change_range(json.load(stream))
    # PR jobs execute the synthetic merge checkout. Include its manifest graph
    # so dependencies added on the target branch since the fork are covered;
    # use its package inventory for the tasks that will actually execute.
    checkout = git("rev-parse", "HEAD").decode().strip()
    revisions = list(dict.fromkeys(ref for ref in (base, head) if ref and ref != checkout))
    revisions.append(checkout)
    graphs = [Graph(manifests(ref)) for ref in revisions]
    selected = classify(paths, graphs, all_jobs)
    print(json.dumps(selected, sort_keys=True))
    if "GITHUB_OUTPUT" in os.environ:
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            for name, value in selected.items():
                print(f"{name}={json.dumps(value, separators=(',', ':'))}", file=stream)
            for name, value in selected["jobs"].items():
                print(f"{name}={str(value).lower()}", file=stream)


if __name__ == "__main__":
    main()
