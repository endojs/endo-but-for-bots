import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import stack_height


class ParseMetrics(unittest.TestCase):
    def test_parses_compile_and_run_lines(self):
        output = (
            "running 1 test\n"
            "STACK_METRIC floor.compile 8192 compiled\n"
            "STACK_METRIC floor.run 12288 completed result=\"1\"\n"
            "STACK_METRIC proxy-get-10k.run 516096 ReentryLimit result=\"\"\n"
            "test native_stack_high_water_marks ... ok\n"
        )
        self.assertEqual(
            stack_height.parse_metrics(output),
            {
                "floor.compile": {"bytes": 8192, "outcome": "compiled"},
                "floor.run": {"bytes": 12288, "outcome": "completed"},
                "proxy-get-10k.run": {"bytes": 516096, "outcome": "ReentryLimit"},
            },
        )

    def test_rejects_duplicates_and_malformed_lines(self):
        with self.assertRaises(ValueError):
            stack_height.parse_metrics("STACK_METRIC a.run 1 ok\nSTACK_METRIC a.run 2 ok\n")
        with self.assertRaises(ValueError):
            stack_height.parse_metrics("STACK_METRIC a.run\n")


class Compare(unittest.TestCase):
    baseline = {
        "a.run": {"bytes": 100000, "outcome": "completed"},
        "b.run": {"bytes": 200000, "outcome": "ReentryLimit"},
    }

    def test_within_slack_passes(self):
        actual = {
            "a.run": {"bytes": 101000, "outcome": "completed"},
            "b.run": {"bytes": 199000, "outcome": "ReentryLimit"},
        }
        problems, notes = stack_height.compare(actual, self.baseline, 0.02)
        self.assertEqual(problems, [])
        self.assertEqual(notes, [])

    def test_growth_past_slack_fails(self):
        actual = {
            "a.run": {"bytes": 103000, "outcome": "completed"},
            "b.run": {"bytes": 200000, "outcome": "ReentryLimit"},
        }
        problems, _ = stack_height.compare(actual, self.baseline, 0.02)
        self.assertEqual(len(problems), 1)
        self.assertIn("a.run: 103000 B > 102000 B", problems[0])

    def test_outcome_change_fails(self):
        actual = {
            "a.run": {"bytes": 100000, "outcome": "completed"},
            "b.run": {"bytes": 150000, "outcome": "completed"},
        }
        problems, _ = stack_height.compare(actual, self.baseline, 0.02)
        self.assertEqual(problems, ["b.run: outcome completed (baseline ReentryLimit)"])

    def test_roster_difference_fails(self):
        actual = {"a.run": {"bytes": 100000, "outcome": "completed"}}
        problems, _ = stack_height.compare(actual, self.baseline, 0.02)
        self.assertEqual(problems, ["case roster differs: missing=['b.run'], unexpected=[]"])

    def test_large_reduction_is_noted(self):
        actual = {
            "a.run": {"bytes": 50000, "outcome": "completed"},
            "b.run": {"bytes": 200000, "outcome": "ReentryLimit"},
        }
        problems, notes = stack_height.compare(actual, self.baseline, 0.02)
        self.assertEqual(problems, [])
        self.assertEqual(len(notes), 1)
        self.assertIn("a.run: 50000 B, 0.500x", notes[0])


class Provenance(unittest.TestCase):
    def test_mismatch_is_refused(self):
        reference = {"target": "x86_64-unknown-linux-gnu", "rustc": "rustc 1.91.1", "profile": "release"}
        candidate = dict(reference, rustc="rustc 1.92.0")
        with self.assertRaises(ValueError):
            stack_height.validate_provenance(reference, candidate)
        stack_height.validate_provenance(reference, dict(reference, commit="other"))

    def test_a_dirty_tree_refuses_a_baseline_unless_allowed(self):
        self.assertIsNone(stack_height.refuse_dirty([], allow_dirty=False))
        self.assertIsNone(stack_height.refuse_dirty(["ironhorse-vm/src/lib.rs"], allow_dirty=True))
        reason = stack_height.refuse_dirty(["ironhorse-vm/src/lib.rs"], allow_dirty=False)
        self.assertIn("ironhorse-vm/src/lib.rs", reason)
        self.assertIn("--allow-dirty", reason)
        many = [f"f{i}.rs" for i in range(12)]
        self.assertIn("and 2 more", stack_height.refuse_dirty(many, allow_dirty=False))


class EngineRepository(unittest.TestCase):
    """A throwaway repository laid out like this one: an engine directory
    holding the baseline and a source file, and a file outside the engine. The
    scenarios make their own changes, so they mean the same on a clean
    checkout, which is what CI has, as on a working one."""

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.repo = Path(scratch.name).resolve()
        self.engine = self.repo / "rust/engine"
        self.baseline = self.engine / "benches/stack-height-baseline.json"
        self.source = self.engine / "ironhorse-vm/src/lib.rs"
        self.outside = self.repo / "README.md"
        for path, text in ((self.baseline, "{}\n"), (self.source, "// v1\n"), (self.outside, "v1\n")):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.git("init", "--quiet", "--initial-branch=main")
        self.commit("the measured tree")

    def git(self, *args):
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                   GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@example.invalid",
                   GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@example.invalid")
        return subprocess.check_output(["git", *args], cwd=self.repo, env=env, text=True).strip()

    def commit(self, message):
        self.git("add", "--all")
        self.git("commit", "--quiet", "--allow-empty", "--message", message)

    def changes(self):
        return stack_height.uncommitted_changes(self.baseline, root=self.engine)


class UncommittedChanges(EngineRepository):
    def test_a_clean_tree_has_none(self):
        self.assertEqual(self.changes(), [])

    def test_an_engine_change_refuses_a_baseline(self):
        self.source.write_text("// v2\n")
        changed = self.changes()
        self.assertEqual(changed, ["rust/engine/ironhorse-vm/src/lib.rs"])
        self.assertIn("rust/engine/ironhorse-vm/src/lib.rs",
                      stack_height.refuse_dirty(changed, allow_dirty=False))
        self.git("add", str(self.source))
        self.assertEqual(self.changes(), changed, "a staged change is still uncommitted")

    def test_the_baseline_file_is_not_a_change(self):
        self.baseline.write_text('{"cases": {}}\n')
        self.assertEqual(self.changes(), [])
        self.assertIsNone(stack_height.refuse_dirty(self.changes(), allow_dirty=False))
        self.git("add", str(self.baseline))
        self.assertEqual(self.changes(), [], "nor is it once staged")
        self.source.write_text("// v2\n")
        self.assertEqual(self.changes(), ["rust/engine/ironhorse-vm/src/lib.rs"],
                         "leaving the baseline out does not hide an engine change beside it")

    def test_changes_outside_the_engine_and_untracked_files_are_not_changes(self):
        self.outside.write_text("v2\n")
        (self.engine / "notes.txt").write_text("untracked\n")
        self.assertEqual(self.changes(), [])


class EngineTree(EngineRepository):
    def tree(self, revision="HEAD"):
        return stack_height.engine_tree(self.baseline, root=self.engine, revision=revision)

    def record_baseline(self, tree):
        self.baseline.write_text(json.dumps({"provenance": {"engine_tree": tree}}) + "\n")
        self.commit("record the baseline")

    def assert_git_writes_the_tree_without_the_baseline(self):
        measured = self.tree()
        self.assertNotEqual(measured, self.git("rev-parse", "HEAD:rust/engine"))
        self.git("rm", "--quiet", str(self.baseline))
        self.commit("remove the baseline")
        self.assertEqual(measured, self.git("rev-parse", "HEAD:rust/engine"))

    def test_the_tree_is_the_one_git_writes_without_the_baseline(self):
        # Entries that exercise the tree format: an executable, a symlink, a
        # name with a space and a non-ASCII letter, and names that sort
        # around `benches` only once a tree's name is read with its slash.
        script = self.engine / "benches/run me é.sh"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        (self.engine / "benches/link").symlink_to("run me é.sh")
        (self.engine / "benches-notes").write_text("a file\n")
        (self.engine / "benches.d").mkdir()
        (self.engine / "benches.d/x").write_text("a tree\n")
        self.commit("more kinds of entry")
        self.assert_git_writes_the_tree_without_the_baseline()

    def test_a_directory_left_empty_is_left_out(self):
        self.assertEqual(sorted(path.name for path in self.baseline.parent.iterdir()),
                         [self.baseline.name])
        self.assert_git_writes_the_tree_without_the_baseline()

    def test_recording_the_baseline_leaves_the_tree_where_it_was(self):
        measured = self.tree()
        self.record_baseline(measured)
        self.assertEqual(self.tree(), measured, "the baseline's own commit holds the tree it names")
        self.assertEqual(self.tree("HEAD~1"), measured)

    def test_an_engine_change_moves_the_tree(self):
        measured = self.tree()
        self.source.write_text("// v2\n")
        self.commit("change the engine")
        self.assertNotEqual(self.tree(), measured)

    def test_a_change_outside_the_engine_does_not_move_the_tree(self):
        measured = self.tree()
        self.outside.write_text("v2\n")
        self.commit("change something else")
        self.assertEqual(self.tree(), measured)

    def test_the_tree_survives_a_rebase_merge(self):
        self.git("checkout", "--quiet", "-b", "topic")
        self.source.write_text("// v2\n")
        self.commit("change the engine")
        measured_commit = self.git("rev-parse", "HEAD")
        measured = self.tree()
        self.record_baseline(measured)
        self.git("checkout", "--quiet", "main")
        self.outside.write_text("v2\n")
        self.commit("change something else")
        self.git("rebase", "--quiet", "main", "topic")
        self.assertNotEqual(self.git("rev-parse", "HEAD~1"), measured_commit,
                            "the rebase rewrote the measured commit")
        self.assertEqual(self.tree(), measured)
        self.assertEqual(self.tree("HEAD~1"), measured)

    def test_a_baseline_outside_the_engine_leaves_the_tree_whole(self):
        elsewhere = self.repo / "elsewhere.json"
        self.assertEqual(stack_height.engine_tree(elsewhere, root=self.engine),
                         self.git("rev-parse", "HEAD:rust/engine"))


class DescribeTree(unittest.TestCase):
    measured = {"engine_tree": "a" * 40}

    def test_the_same_clean_tree(self):
        self.assertEqual(stack_height.describe_tree(self.measured, self.measured),
                         f"the baseline was measured at this engine tree, {'a' * 12}")

    def test_another_tree(self):
        self.assertEqual(stack_height.describe_tree(self.measured, {"engine_tree": "b" * 40}),
                         f"the baseline was measured at engine tree {'a' * 12}; this one is {'b' * 12}")

    def test_uncommitted_changes_on_either_side_are_not_the_same_tree(self):
        dirty = dict(self.measured, dirty=True)
        for baseline, current in ((self.measured, dirty), (dirty, self.measured), (dirty, dirty)):
            description = stack_height.describe_tree(baseline, current)
            self.assertNotIn("this engine tree", description)
            self.assertIn("with uncommitted changes", description)

    def test_a_baseline_without_a_tree(self):
        self.assertEqual(stack_height.describe_tree({"commit": "c" * 40}, self.measured),
                         "the baseline records no engine tree")


class CommittedBaseline(unittest.TestCase):
    def test_it_names_an_engine_tree_rather_than_a_commit(self):
        recorded = json.loads(stack_height.BASELINE.read_text())["provenance"]
        self.assertNotIn("commit", recorded)
        self.assertRegex(recorded["engine_tree"], r"^[0-9a-f]{40}([0-9a-f]{24})?$")


if __name__ == "__main__":
    unittest.main()
