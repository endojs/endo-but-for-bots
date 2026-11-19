"""Independent fixture checks for dependency kind, optionality and membership drift."""

import copy
import importlib.util
from pathlib import Path
import re
import sys
import tomllib
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("crate_graph", Path(__file__).with_name("crate-graph.py"))
graph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(graph)


def fixture():
    return {
        "workspace_members": ["vm-id", "compiler-id"],
        "packages": [
            {"id": "vm-id", "name": "vm", "manifest_path": "/workspace/vm/Cargo.toml",
             "dependencies": [{"name": "compiler", "path": "/workspace/compiler", "kind": "dev", "optional": False}]},
            {"id": "compiler-id", "name": "compiler", "manifest_path": "/workspace/compiler/Cargo.toml", "dependencies": []},
            {"id": "external-id", "name": "external", "manifest_path": "/registry/external/Cargo.toml", "dependencies": []},
        ],
    }


class GraphTests(unittest.TestCase):
    def test_direction_and_membership(self):
        result = graph.render(fixture())
        self.assertIn('vm -.->|"dev"| compiler', result)
        self.assertNotIn('external[', result)
        self.assertNotIn('compiler -.->', result)

    def test_dependency_and_member_changes_affect_output(self):
        original = fixture()
        for edit in ["optional", "kind", "removed_edge", "member"]:
            changed = copy.deepcopy(original)
            dep = changed["packages"][0]["dependencies"][0]
            if edit == "optional":
                dep["optional"] = True
            elif edit == "kind":
                dep["kind"] = None
            elif edit == "removed_edge":
                changed["packages"][0]["dependencies"] = []
            else:
                changed["workspace_members"].remove("compiler-id")
            self.assertNotEqual(graph.render(original), graph.render(changed), edit)

    def test_target_quotes_are_escaped(self):
        data = fixture()
        data["packages"][0]["dependencies"][0]["target"] = 'cfg(target_os = "linux")'
        self.assertIn('cfg(target_os = &quot;linux&quot;)', graph.render(data))

    def test_registry_dependency_with_same_name_is_not_local(self):
        data = fixture()
        data["packages"][0]["dependencies"][0].pop("path")
        self.assertNotIn('vm -.->', graph.render(data))

    def test_workspace_library_roots_forbid_unsafe(self):
        data = graph.metadata()
        members = set(data["workspace_members"])
        for package in data["packages"]:
            if package["id"] not in members or package["name"] == "xs-oracle":
                continue
            for target in package["targets"]:
                if "lib" in target["kind"]:
                    source = Path(target["src_path"]).read_text()
                    self.assertRegex(source, r"(?m)^#!\[forbid\(unsafe_code\)\]$", target["src_path"])

    def test_workspace_denies_unsafe_for_every_member_target(self):
        # The workspace level covers every target (bins, tests, examples,
        # build scripts) of every member that inherits it, so a new harness
        # root cannot lack the policy.
        manifest = tomllib.loads((graph.ENGINE / "Cargo.toml").read_text())
        level = manifest["workspace"]["lints"]["rust"]["unsafe_code"]
        self.assertIn(level, ("deny", "forbid"))
        data = graph.metadata()
        members = set(data["workspace_members"])
        for package in data["packages"]:
            if package["id"] in members:
                own = tomllib.loads(Path(package["manifest_path"]).read_text())
                self.assertEqual(own.get("lints"), {"workspace": True}, package["manifest_path"])

    def test_unsafe_exemptions_are_enumerated(self):
        found = set()
        for path in graph.ENGINE.rglob("*.rs"):
            relative = path.relative_to(graph.ENGINE).as_posix()
            if any(part == "target" for part in path.parts) or relative.startswith(UNBUILT_PREFIXES):
                continue
            for line in path.read_text().splitlines():
                stripped = line.strip()
                if re.match(r"#!?\[allow\([^)]*\bunsafe_code\b", stripped):
                    found.add((relative, stripped))
        self.assertEqual(found, UNSAFE_EXEMPTIONS)

    def test_standalone_roots_state_unsafe_policy(self):
        members = {Path(p["manifest_path"]).resolve() for p in graph.metadata()["packages"]}
        roots = set()
        for manifest in graph.ENGINE.rglob("Cargo.toml"):
            relative = manifest.relative_to(graph.ENGINE).as_posix()
            if any(part == "target" for part in manifest.parts) or manifest.resolve() in members:
                continue
            if relative == "Cargo.toml":
                continue
            roots.add(relative)
            if relative in STANDALONE_UNSAFE_ROOTS:
                continue
            lints = tomllib.loads(manifest.read_text()).get("lints", {})
            self.assertIn(lints.get("rust", {}).get("unsafe_code"), ("deny", "forbid"), relative)
        self.assertLessEqual(set(STANDALONE_UNSAFE_ROOTS), roots)


# Every `allow(unsafe_code)` in buildable engine sources, with the reason:
# - xs-oracle is the audited FFI seam (design § Minimizing `unsafe`);
# - `GlobalAlloc` cannot be implemented without `unsafe impl`;
# - the stack painter (stack-lanes/paint.rs) reads and writes raw stack memory.
UNSAFE_EXEMPTIONS = {
    ("xs-oracle/src/lib.rs", "#![allow(unsafe_code)]"),
    ("ironhorse-vm/tests/teardown_allocation.rs", "#[allow(unsafe_code)]"),
    ("ironhorse-vm/tests/host_allocation_failure.rs", "#[allow(unsafe_code)]"),
    ("ironhorse-vm/tests/stack_height.rs", "#[allow(unsafe_code)]"),
    ("stack-lanes/probe/src/main.rs", "#[allow(unsafe_code)]"),
    ("stack-lanes/memory/probe/src/main.rs", "#[allow(unsafe_code)]"),
}

# Standalone cargo roots that legitimately use `unsafe` throughout and so state
# no crate-wide policy: the wasm worker spike exports a C ABI to its host.
STANDALONE_UNSAFE_ROOTS = {"wasm-worker-spike/Cargo.toml"}

# Review snapshots of throwaway probes; no cargo root builds them.
UNBUILT_PREFIXES = ("architecture-review/",)


if __name__ == "__main__":
    unittest.main()
