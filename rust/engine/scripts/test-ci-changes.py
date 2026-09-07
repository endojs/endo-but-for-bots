"""Exercise job selection against real PR/push commit graphs."""

import importlib.util
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


class Paths(unittest.TestCase):
    def test_unrelated_code_and_designs_skip(self):
        self.assertEqual(changes.classify([
            b"packages/ses/src/index.js", b"designs/ironhorse-engine.md",
            b"rust/engine/README.md",
        ]), {"engine": False, "oracle": False})

    def test_engine_worker_and_build_inputs_run(self):
        for path in [b"rust/engine/ironhorse-vm/src/lib.rs",
                     b"rust/endo/ironhorse-store-sqlite/src/lib.rs",
                     b"rust/endo/src/ironhorse_engine.rs", b"rust/endo/Cargo.toml",
                     b"Cargo.lock", b"rust-toolchain.toml",
                     b".github/workflows/ironhorse-changes.yml"]:
            with self.subTest(path=path):
                self.assertEqual(changes.classify([path]), {"engine": True, "oracle": True})

    def test_oracle_inputs_only_run_oracle(self):
        for path in [b"c/moddable", b"rust/endo/xsnap/xsnap-platform.c",
                     b".github/workflows/ironhorse-sanitizers.yml"]:
            self.assertEqual(changes.classify([path]), {"engine": False, "oracle": True})


class Ranges(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        previous = os.getcwd()
        os.chdir(directory.name)
        self.addCleanup(os.chdir, previous)
        self.git("init", "-q")
        self.git("config", "user.name", "CI filter test")
        self.git("config", "user.email", "ci-filter@example.invalid")
        self.initial = self.commit("unrelated.txt")

    def git(self, *args):
        return subprocess.check_output(["git", *args], stderr=subprocess.PIPE).decode().strip()

    def commit(self, path):
        file = Path(path)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("fixture", encoding="utf-8")
        self.git("add", "--all")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def selected(self, before, after):
        return changes.classify(changes.changed_paths({"before": before, "after": after}))

    def test_push_includes_earlier_commits(self):
        self.commit("rust/engine/changed.rs")
        head = self.commit("packages/elsewhere.js")
        self.assertTrue(self.selected(self.initial, head)["engine"])

    def test_unrelated_push_skips(self):
        self.assertFalse(self.selected(self.initial, self.commit("elsewhere.js"))["engine"])

    def test_move_out_of_engine_still_runs(self):
        base = self.commit("rust/engine/moved.rs")
        self.git("mv", "rust/engine/moved.rs", "moved.rs")
        head = self.commit("elsewhere.js")
        self.assertTrue(self.selected(base, head)["engine"])

    def test_pr_ignores_changes_only_on_base(self):
        base = self.commit("rust/engine/base-only.rs")
        self.git("checkout", "-q", "-b", "feature", self.initial)
        head = self.commit("unrelated.js")
        event = {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}
        self.assertEqual(changes.classify(changes.changed_paths(event)),
                         {"engine": False, "oracle": False})

    def test_new_branch_checks_complete_tree(self):
        head = self.commit("rust/engine/existing.rs")
        self.assertTrue(self.selected("0" * 40, head)["engine"])

    def test_deleted_branch_skips(self):
        self.assertEqual(changes.changed_paths({"deleted": True}), [])


if __name__ == "__main__":
    unittest.main()
