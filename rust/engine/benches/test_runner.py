"""Fail-closed regression tests for benchmark report validation."""
import unittest
from pathlib import Path
import tempfile
from run import TARGETS, compare, fixture_digest, read_metrics, validate_reference


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

    def test_reference_requires_same_fixtures_and_environment(self):
        reference = dict(platform="host", machine="arm64", cpu="cpu", rustc="rustc",
                         fixture_sha256="fixtures", build_environment={"RUSTFLAGS": None})
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
