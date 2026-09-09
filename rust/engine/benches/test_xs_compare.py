import json
import unittest

from xs_compare import FIXTURES, summarize


def output(ratio=1.0):
    return "\n".join(f"XS_SAMPLES {name} xs={json.dumps([10] * 7)} ironhorse={json.dumps([10 * ratio] * 7)}"
                     for name in FIXTURES)


class XsReport(unittest.TestCase):
    def test_limit_is_computed_from_samples(self):
        self.assertTrue(summarize(output(2.0))["within_microbenchmark_limit"])
        self.assertFalse(summarize(output(2.01))["within_microbenchmark_limit"])
        self.assertAlmostEqual(summarize(output(1.25))["geometric_mean"], 1.25)

    def test_missing_duplicate_and_unknown_fixtures_fail(self):
        for text in ("", "\n".join(output().splitlines()[1:]),
                     output() + "\n" + output().splitlines()[0],
                     output().replace("XS_SAMPLES parse", "XS_SAMPLES unknown")):
            with self.assertRaises(ValueError):
                summarize(text)

    def test_invalid_and_incomplete_samples_fail(self):
        for value in (0, -1, float("inf"), float("nan"), True, "bad"):
            text = output().replace(json.dumps([10] * 7), json.dumps([value] * 7), 1)
            with self.assertRaises(ValueError):
                summarize(text)
        with self.assertRaises(ValueError):
            summarize(output().replace(json.dumps([10] * 7), "[10]", 1))


if __name__ == "__main__":
    unittest.main()
