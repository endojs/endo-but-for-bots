"""Independent fixture checks for dependency kind, optionality and membership drift."""

import copy
import importlib.util
from pathlib import Path
import sys
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


if __name__ == "__main__":
    unittest.main()
