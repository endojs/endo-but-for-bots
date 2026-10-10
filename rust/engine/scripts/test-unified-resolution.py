#!/usr/bin/env python3
"""Self-test for `check-unified-resolution.py` (architecture finding F070).

The checker's value is entirely in what it BUILDS: a workspace that really
unions both member lists, really carries the inheritance tables the engine
crates need, and really resolves fresh. A builder that quietly produced a
workspace containing only the engine's members would pass every run while
measuring nothing — the same shape of defect the finding is about.

These tests exercise the builder, not the cargo run it drives, so they are
fast enough for any lane.
"""
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

# The module name has hyphens, so load it by path rather than by import.
import importlib.util

SPEC = importlib.util.spec_from_file_location(
    "check_unified_resolution",
    Path(__file__).with_name("check-unified-resolution.py"),
)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class Builder(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="unified-selftest-")
        self.addCleanup(self.scratch.cleanup)
        self.manifest = checker.build_unified_workspace(Path(self.scratch.name))
        with self.manifest.open("rb") as handle:
            self.parsed = tomllib.load(handle)

    def test_the_workspace_unions_both_member_lists(self):
        members = set(self.parsed["workspace"]["members"])
        root = set(checker.members(checker.REPO / "Cargo.toml"))
        engine = {
            f"rust/engine/{m}"
            for m in checker.members(checker.ENGINE / "Cargo.toml")
        }
        # The point of the exercise: BOTH sides present, so the resolution is
        # the unified one rather than either workspace's own.
        self.assertTrue(root <= members, f"missing root members: {root - members}")
        self.assertTrue(
            engine <= members, f"missing engine members: {engine - members}"
        )
        self.assertGreater(len(members), len(engine), "no root members at all")

    def test_the_inheritance_tables_are_carried(self):
        # Engine crates use `version.workspace = true` and friends; without
        # these tables the members do not parse, which is a failure mode the
        # builder hit for real.
        self.assertIn("package", self.parsed["workspace"])
        self.assertIn("edition", self.parsed["workspace"]["package"])
        self.assertIn("lints", self.parsed["workspace"])

    def test_the_nested_engine_workspace_is_removed(self):
        # Left in place, cargo refuses the members as belonging to the wrong
        # workspace.
        staged = Path(self.scratch.name) / "rust" / "engine" / "Cargo.toml"
        self.assertFalse(staged.exists())

    def test_the_engine_lockfile_is_removed_so_the_resolve_is_fresh(self):
        # Keeping it would reproduce the engine workspace's own resolution,
        # which is the thing this check exists NOT to measure.
        lock = Path(self.scratch.name) / "rust" / "engine" / "Cargo.lock"
        self.assertFalse(lock.exists())

    def test_the_staged_tree_reaches_what_the_crates_reach_for(self):
        # Several crates reach out of `rust/` by relative path: the oracle's
        # build script to `c/moddable`, the compile and 262 suites to the
        # converted corpus. A stage that drops either fails the run for a
        # reason that has nothing to do with resolution, which is exactly
        # how this check would come to be disbelieved and then deleted.
        crate = Path(self.scratch.name) / "rust" / "engine" / "xs-oracle"
        for relative in (
            Path("..") / ".." / ".." / "c" / "moddable",
            Path("..") / ".." / ".." / "packages" / "test262-runner",
        ):
            reached = (crate / relative).resolve()
            self.assertTrue(
                reached.exists(),
                f"the staged tree does not reach {relative} at {reached}",
            )

    def test_cargo_accepts_the_generated_workspace(self):
        # The strongest cheap check: cargo parses the manifest and resolves
        # the graph. Metadata only — no build.
        result = subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--no-deps",
             "--manifest-path", str(self.manifest)],
            check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(
            result.returncode, 0,
            f"cargo rejected the unified workspace:\n{result.stderr}",
        )

    def test_nothing_was_written_inside_the_repository(self):
        """The builder copies; it must not touch either real workspace.

        Compared BEFORE against AFTER rather than against a clean tree: the
        working tree may legitimately carry unrelated edits, and a test that
        demanded a clean one would fail for the wrong reason and then be
        deleted by whoever hit it.
        """
        watched = [
            "Cargo.toml",
            "Cargo.lock",
            "rust/engine/Cargo.toml",
            "rust/engine/Cargo.lock",
        ]

        def status():
            return subprocess.run(
                ["git", "status", "--porcelain", "--"] + watched,
                cwd=checker.REPO, check=True, text=True, stdout=subprocess.PIPE,
            ).stdout

        before = status()
        with tempfile.TemporaryDirectory(prefix="unified-noedit-") as scratch:
            checker.build_unified_workspace(Path(scratch))
        self.assertEqual(
            status(), before, "the builder edited a real workspace manifest"
        )


if __name__ == "__main__":
    unittest.main()
