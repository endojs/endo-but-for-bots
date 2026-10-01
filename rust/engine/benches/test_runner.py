"""Fail-closed regression tests for benchmark report validation."""
import unittest
from pathlib import Path
import tempfile
import contextlib
import io
import subprocess
from unittest import mock

import run
from run import RUNS, TARGETS, compare, fixture_digest, median_across_runs, read_metrics, validate_reference


class Reports(unittest.TestCase):
    def test_missing_and_unexpected_measurements_fail(self):
        self.assertTrue(compare({"other": 1}, {"expected": 1}, 1.25))

    def test_regression_fails(self):
        self.assertTrue(compare({"work": 1.26}, {"work": 1}, 1.25))
        self.assertFalse(compare({"work": 1.24}, {"work": 1}, 1.25))

    def test_nonfinite_zero_negative_and_duplicate_fail(self):
        for value in ("nan", "inf", "0", "-1"):
            with self.assertRaises(ValueError):
                read_metrics(f"BENCH_METRIC work {value}")
        with self.assertRaises(ValueError):
            read_metrics("BENCH_METRIC work 1\nBENCH_METRIC work 2")

    def test_invalid_baseline_fails(self):
        for value in (0, -1, float("nan"), True, "1"):
            with self.assertRaises(ValueError):
                compare({"work": 1}, {"work": value}, 1.25)

    def test_ignores_human_output(self):
        self.assertEqual(read_metrics("BENCH_METRIC work 1.25\nfinished"), {"work": 1.25})

    def test_repeated_runs_report_each_metrics_median(self):
        runs = [{"gc": 3.0, "free": 1.0}, {"gc": 1.0, "free": 9.0}, {"gc": 2.0, "free": 2.0}]
        self.assertEqual(median_across_runs(runs), {"gc": 2.0, "free": 2.0})
        self.assertEqual(median_across_runs([{"work": 4.0}]), {"work": 4.0})
        # A run cut short by a failure contributes the metrics it reported.
        self.assertEqual(median_across_runs([{"a": 1.0}, {"a": 3.0, "b": 5.0}]), {"a": 2.0, "b": 5.0})

    def test_run_count_is_a_positive_integer(self):
        self.assertIs(type(RUNS), int)
        self.assertGreaterEqual(RUNS, 1)

    def test_measure_alternates_sides_and_keeps_medians(self):
        order = []
        values = iter(range(1, 1000))

        def fake(root, env, *arguments):
            target = arguments[1]
            order.append((root, target))
            return subprocess.CompletedProcess([], 0, f"BENCH_METRIC {target}_ms {next(values)}\n")

        with mock.patch.object(run, "cargo_test", fake), contextlib.redirect_stdout(io.StringIO()):
            medians, failures = run.measure({"reference": ("ref", {}), "candidate": ("cand", {})})
        self.assertEqual(failures, [])
        first = [root for root, target in order if target == TARGETS[0]]
        self.assertEqual(first, ["ref", "cand", "cand", "ref", "ref", "cand"][:2 * RUNS])
        self.assertEqual(set(medians), {"reference", "candidate"})
        self.assertEqual(set(medians["candidate"]), {f"{target}_ms" for target in TARGETS})

    def test_measure_reports_failed_runs_and_roster_changes(self):
        outputs = iter(["BENCH_METRIC a 1\nBENCH_METRIC b 1\n", "BENCH_METRIC a 1\n", ""] * 1000)

        def fake(root, env, *arguments):
            text = next(outputs)
            return subprocess.CompletedProcess([], 0 if text else 101, text)

        with mock.patch.object(run, "TARGETS", ("only",)), mock.patch.object(run, "RUNS", 3), \
                mock.patch.object(run, "cargo_test", fake), contextlib.redirect_stdout(io.StringIO()):
            _, failures = run.measure({"candidate": ("cand", {})})
        self.assertEqual(failures, ["candidate only run 2: metric roster differs",
                                    "candidate only run 3: exit=101, metrics=0"])

    def test_reference_requires_same_fixtures_and_environment(self):
        reference = dict(platform="host", machine="arm64", cpu="cpu", rustc="rustc",
                         fixture_sha256="fixtures", build_environment={"RUSTFLAGS": None}, runs=3)
        validate_reference(reference, reference.copy())
        for key in reference:
            with self.subTest(key=key):
                candidate = reference.copy()
                candidate[key] = "different"
                with self.assertRaisesRegex(ValueError, key):
                    validate_reference(reference, candidate)
                del candidate[key]
                with self.assertRaisesRegex(ValueError, key):
                    validate_reference(reference, candidate)

    def test_fixture_digest_covers_shared_helpers_and_toolchain(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tests = root / "ironhorse-snapshot/tests"
            support = tests / "bench_support"
            support.mkdir(parents=True)
            for target in TARGETS:
                (tests / f"{target}.rs").write_text(target)
            helper = support / "mod.rs"
            helper.write_text("original helper")
            toolchain = root / "rust-toolchain.toml"
            toolchain.write_text("original compiler")
            original = fixture_digest(root)
            self.assertEqual(original, fixture_digest(root))
            for path in (helper, toolchain, tests / f"{TARGETS[0]}.rs"):
                before = path.read_text()
                path.write_text("changed input")
                self.assertNotEqual(original, fixture_digest(root), path)
                path.write_text(before)


if __name__ == "__main__":
    unittest.main()
