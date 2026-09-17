import json
import unittest

from xs_compare import FIXTURES, summarize, summarize_footprint


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


FOOTPRINT = """XS_FOOTPRINT properties xs_bytes=164928 ironhorse_xs_accounted_bytes=40574 ironhorse_resident_bytes=38702 accounted_ratio=0.2460 resident_ratio=0.2347
XS_FOOTPRINT allocation_churn xs_bytes=391448 ironhorse_xs_accounted_bytes=1000542 ironhorse_resident_bytes=864286 accounted_ratio=2.5560 resident_ratio=2.2079
XS_FOOTPRINT_LIMIT 1.1 within=false
"""


class FootprintReport(unittest.TestCase):
    """The heap half of the envelope's footprint bar (F106/F122)."""

    def test_the_worst_ratio_decides_the_bar(self):
        report = summarize_footprint(FOOTPRINT)
        self.assertEqual(set(report["fixtures"]), {"properties", "allocation_churn"})
        self.assertAlmostEqual(report["worst_accounted_ratio"], 2.556)
        self.assertFalse(report["within_heap_limit"])

    def test_a_run_within_the_bar_is_reported_as_within(self):
        within = FOOTPRINT.replace("accounted_ratio=2.5560", "accounted_ratio=1.0500")
        self.assertTrue(summarize_footprint(within)["within_heap_limit"])

    def test_output_without_footprint_lines_is_absent_not_empty(self):
        # An absent measurement must stay on the `unmeasured` list rather
        # than reporting a vacuous pass.
        self.assertIsNone(summarize_footprint("no footprint here\n"))

    def test_a_duplicate_fixture_is_an_error(self):
        with self.assertRaises(ValueError):
            summarize_footprint(FOOTPRINT + FOOTPRINT.splitlines()[0])
