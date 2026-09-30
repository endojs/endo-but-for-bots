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


if __name__ == "__main__":
    unittest.main()
