"""Fail-closed regression tests for benchmark report validation."""
import unittest
from run import compare, read_metrics


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


if __name__ == "__main__":
    unittest.main()
