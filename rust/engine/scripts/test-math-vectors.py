"""The differential must detect one-ULP changes, signed zero, and missing cases."""
import importlib.util
import unittest
import sys
from pathlib import Path

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "comparison", Path(__file__).with_name("compare-math-vectors.py")
)
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class MathVectorTests(unittest.TestCase):
    def test_identical(self):
        values = {("sin", "input"): 0x3FE0000000000000}
        self.assertEqual(len(comparison.compare(values, values)), 1)

    def test_last_bit(self):
        lines = comparison.compare(
            {("sin", "input"): 0x3FE0000000000000},
            {("sin", "input"): 0x3FE0000000000001},
        )
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[1].endswith("\t1"))

    def test_signed_zero(self):
        self.assertEqual(len(comparison.compare(
            {("sin", "zero"): 0}, {("sin", "zero"): 1 << 63}
        )), 2)

    def test_missing_case(self):
        with self.assertRaisesRegex(ValueError, "case sets differ"):
            comparison.compare({("sin", "input"): 0}, {})


if __name__ == "__main__":
    unittest.main()
