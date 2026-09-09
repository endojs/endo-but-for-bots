"""Adversarial dependency and Git-range regressions for the CI selector."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("changes", Path(__file__).with_name("ci-changes.py"))
changes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changes)


def js(name, dependencies=None, **extra):
    return json.dumps({"name": name, "dependencies": dependencies or {},
                       "scripts": {"test": "ava", "test:c8": "c8 ava"}, **extra})


def graph(*, removed=False):
    return changes.Graph({
        "packages/leaf/package.json": js("leaf"),
        "packages/middle/package.json": js("middle", {} if removed else {"leaf": "workspace:^"}),
        "packages/root/package.json": js("root", devDependencies={"middle": "workspace:^"}),
        "packages/other/package.json": js("other"),
    })


class Dependencies(unittest.TestCase):
    def test_transitive_development_dependencies(self):
        result = changes.classify(["packages/leaf/a.js"], [graph()])
        self.assertEqual(result["packages"], ["leaf", "middle", "root"])
        self.assertTrue(result["jobs"]["test"])

    def test_removed_edges_still_select_consumers(self):
        result = changes.classify(["packages/leaf/a.js"], [graph(), graph(removed=True)])
        self.assertEqual(result["packages"], ["leaf", "middle", "root"])

    def test_deleted_workspace_selects_remaining_consumer(self):
        before = changes.Graph({"packages/a/package.json": js("a"),
                                "packages/b/package.json": js("b", {"a": "workspace:^"})})
        after = changes.Graph({"packages/b/package.json": js("b")})
        self.assertEqual(changes.classify(["packages/a/a.js"], [before, after])["packages"], ["b"])

    def test_peer_optional_and_cycles(self):
        g = changes.Graph({
            "packages/a/package.json": js("a", peerDependencies={"b": "workspace:^"}),
            "packages/b/package.json": js("b", optionalDependencies={"c": "workspace:^"}),
            "packages/c/package.json": js("c", {"a": "workspace:^"}),
        })
        self.assertEqual(changes.classify(["packages/c/c.js"], [g])["packages"], ["a", "b", "c"])

    def test_unresolved_workspace_fails(self):
        with self.assertRaisesRegex(ValueError, "Missing workspace"):
            changes.Graph({"packages/a/package.json": js("a", {"missing": "workspace:^"})})

    def test_rust_target_build_dev_and_workspace_path_dependencies(self):
        g = changes.Graph({
            "Cargo.toml": '[workspace]\nmembers=["rust/a","rust/b","rust/c"]\n[workspace.dependencies]\nb={path="rust/b"}\n',
            "rust/a/Cargo.toml": '[package]\nname="a"\n[target.\'cfg(unix)\'.build-dependencies]\nb={workspace=true}\n',
            "rust/b/Cargo.toml": '[package]\nname="b"\n[dev-dependencies]\nc={path="../c"}\n',
            "rust/c/Cargo.toml": '[package]\nname="c"\n',
        })
        self.assertEqual(g.crates(g.affected(["rust/c/src/lib.rs"])), {"a", "b", "c"})

    def test_missing_rust_path_fails(self):
        with self.assertRaisesRegex(ValueError, "Missing local crate"):
            changes.Graph({"rust/a/Cargo.toml": '[package]\nname="a"\n[dependencies]\nb={path="../b"}'})

    def test_nested_crate_does_not_change_parent(self):
        g = changes.Graph({"rust/a/Cargo.toml": '[package]\nname="a"',
                           "rust/a/fuzz/Cargo.toml": '[package]\nname="fuzz"'})
        self.assertEqual(g.crates(g.affected(["rust/a/fuzz/src/a.rs"])), {"fuzz"})

    def test_docs_select_lint_only(self):
        result = changes.classify(["docs/test.md"], [graph()])
        self.assertEqual([n for n, value in result["jobs"].items() if value], ["lint"])
        self.assertEqual(result["packages"], [])

    def test_documentation_assets_select_lint_only(self):
        result = changes.classify(["docs/assets/custom.css"], [graph()])
        self.assertEqual([n for n, value in result["jobs"].items() if value], ["lint"])
        self.assertEqual(result["packages"], [])

    def test_shared_tooling_selects_packages(self):
        result = changes.classify(["yarn.lock"], [graph()])
        self.assertEqual(result["packages"], sorted(graph().js))
        self.assertTrue(result["jobs"]["test"])
        self.assertFalse(result["jobs"]["test-ironhorse"])

    def test_workflow_selects_its_own_jobs(self):
        result = changes.classify([".github/workflows/browser-test.yml"], [graph()])
        self.assertTrue(result["jobs"]["browser-tests"])
        self.assertFalse(result["jobs"]["test-ironhorse"])

    def test_detector_changes_and_scheduled_runs_select_all(self):
        for paths, force in [(["scripts/ci-changes.py"], False), ([], True)]:
            result = changes.classify(paths, [graph()], force)
            self.assertTrue(all(result["jobs"].values()))
            self.assertEqual(result["packages"], sorted(graph().js))


class Repository(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = changes.Graph(changes.manifests("HEAD"))

    def selected(self, path):
        return changes.classify([path], [self.graph])["jobs"]

    def test_cbor_reaches_guile_and_browser_chat(self):
        selected = self.selected("packages/cbor/src/encode.js")
        self.assertTrue(selected["guile-interop"])
        self.assertTrue(selected["browser-tests"])
        self.assertFalse(selected["test-ironhorse"])

    def test_oracle_source_does_not_select_core_matrix(self):
        selected = self.selected("rust/engine/xs-oracle/src/lib.rs")
        self.assertTrue(selected["test-ironhorse-oracle"])
        self.assertFalse(selected["test-ironhorse"])
        self.assertFalse(selected["test-ironhorse-calibration"])

    def test_nightly_scripts_and_expectations_do_not_select_core(self):
        for path in ["rust/engine/scripts/bench.sh", "rust/engine/ironhorse-262/expectations/nightly.txt"]:
            with self.subTest(path=path):
                selected = self.selected(path)
                self.assertFalse(selected["test-ironhorse"])
                self.assertFalse(selected["test-ironhorse-calibration"])

    def test_recursive_rust_dependency_selects_matrix_and_worker(self):
        selected = self.selected("rust/engine/ironhorse-text/src/lib.rs")
        self.assertTrue(selected["test-ironhorse"])
        self.assertTrue(selected["test-thixotrope-ironhorse"])
        self.assertTrue(selected["build-xsnap"])

    def test_nonmanifest_bundle_inputs(self):
        self.assertTrue(self.selected("packages/lal/agent.js")["familiar-bundle"])
        self.assertTrue(self.selected("scripts/pack-all.mjs")["viable-release"])
        self.assertTrue(self.selected("scripts/graph.sh")["depcheck"])

    def test_rust_config_and_xs_bridge_select_task_packages(self):
        for path in ["Cargo.lock", "rust/engine/Cargo.lock", "rust/endo/xsnap/xsnap-platform.c"]:
            with self.subTest(path=path):
                result = changes.classify([path], [self.graph])
                self.assertTrue(result["jobs"]["test-xs"])
                self.assertIn("@endo/hardened262", result["packages"])

    def test_wasm_selects_js_consumers(self):
        result = changes.classify(["rust/ocapn_noise/src/lib.rs"], [self.graph])
        self.assertTrue(result["jobs"]["build-wasm"])
        self.assertIn("@endo/ocapn-noise", result["packages"])
        self.assertTrue(result["jobs"]["test"])

    def test_sanitizer_inputs_and_wasm_verification_target(self):
        for path in ["rust/engine/scripts/test-oracle-sanitizer-scope.sh",
                     "rust/engine/scripts/oracle-sanitizer-ignorelist.txt"]:
            self.assertTrue(self.selected(path)["oracle-sanitizers"])
        self.assertTrue(self.selected("packages/ocapn-noise/gen/ocapn-noise.wasm")["build-wasm"])

    def test_core_corpus_and_workflow_lint_inputs(self):
        self.assertTrue(self.selected("packages/test262-runner/test262/test/ironhorse/regression.js")["test-ironhorse"])
        self.assertTrue(self.selected(".github/workflows/browser-test.yml")["lint"])
        self.assertTrue(self.selected("typedoc.json")["lint"])

    def test_format_helper_inputs(self):
        self.assertTrue(self.selected("rust/engine/scripts/generate-compiler-opcodes.py")["format-ironhorse"])

    def test_deleted_type_target_selects_uniformity(self):
        self.assertTrue(self.selected("packages/cbor/types-index.d.ts")["package-uniformity"])

    def test_math_comparator_selects_artifact_producers(self):
        selected = self.selected("rust/engine/scripts/compare-math-vectors.py")
        self.assertTrue(selected["test-ironhorse"])
        self.assertTrue(selected["compare-ironhorse-math"])


class Ranges(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "CI fixture")
        self.git("config", "user.email", "ci@example.invalid")
        self.base = self.save("initial", "initial")

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.DEVNULL).decode().strip()

    def save(self, path, value):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(value)
        self.git("add", "-A")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def test_push_uses_before_not_tracking_branch(self):
        head = self.save("changed", "content")
        base, after, paths = changes.change_range({"before": self.base, "after": head})
        self.assertEqual((base, after, paths), (self.base, head, ["changed"]))

    def test_pr_excludes_base_branch_changes(self):
        self.git("checkout", "-qb", "feature")
        head = self.save("feature", "content")
        self.git("checkout", "-q", "--detach", self.base)
        target = self.save("target-only", "content")
        base, _, paths = changes.change_range({"pull_request": {
            "base": {"sha": target}, "head": {"sha": head}}})
        self.assertEqual(base, self.base)
        self.assertEqual(paths, ["feature"])

    def test_new_branch_has_all_files(self):
        _, _, paths = changes.change_range({"before": "0" * 40, "after": self.base})
        self.assertEqual(paths, ["initial"])

    def test_rename_and_delete_include_old_paths(self):
        self.git("mv", "initial", "renamed")
        head = self.save("new", "content")
        _, _, paths = changes.change_range({"before": self.base, "after": head})
        self.assertEqual(set(paths), {"initial", "renamed", "new"})

    def test_no_files_api_limit(self):
        for n in range(350):
            Path(f"file{n}").write_text("content")
        head = self.save("last", "content")
        self.assertEqual(len(changes.change_range({"before": self.base, "after": head})[2]), 351)

    def test_merge_checkout_adds_target_branch_consumers(self):
        base = self.save("packages/leaf/package.json", js("leaf"))
        self.git("checkout", "-qb", "feature")
        head = self.save("packages/leaf/source.js", "changed")
        self.git("checkout", "-qb", "target", base)
        target = self.save("packages/consumer/package.json", js("consumer", {"leaf": "workspace:^"}))
        self.git("merge", "--no-edit", "feature")
        event = Path("event.json")
        event.write_text(json.dumps({"pull_request": {
            "base": {"sha": target}, "head": {"sha": head}}}))
        output = subprocess.check_output(
            [sys.executable, changes.__file__],
            env={**os.environ, "GITHUB_EVENT_PATH": str(event.resolve()),
                 "GITHUB_EVENT_NAME": "pull_request", "GITHUB_OUTPUT": str(Path("output").resolve())},
        )
        self.assertEqual(json.loads(output)["packages"], ["consumer", "leaf"])

    def test_invalid_range_is_an_error(self):
        with self.assertRaises(ValueError):
            changes.change_range({"before": "HEAD~1", "after": self.base})


if __name__ == "__main__":
    unittest.main()
