import unittest

import common
import lane_a


def outcome(line=None, trap=None, timed_out=False):
    return common.Outcome(line=line, trap=trap, timed_out=timed_out)


class Classify(unittest.TestCase):
    def test_identical_lines_pass(self):
        self.assertEqual(lane_a.classify("a", outcome("halt=Return result=\"1\" meter=5"),
                                         outcome("halt=Return result=\"1\" meter=5"), set()), "pass")

    def test_mismatch_fails(self):
        v = lane_a.classify("a", outcome("halt=Return meter=5"), outcome("halt=Return meter=6"), set())
        self.assertTrue(v.startswith("mismatch"))

    def test_listed_trap_is_expected(self):
        v = lane_a.classify("a", outcome("x"), outcome(trap="wasm trap: call stack exhausted"), {"a"})
        self.assertEqual(v, "expected-trap")

    def test_unlisted_trap_fails(self):
        v = lane_a.classify("a", outcome("x"), outcome(trap="wasm trap: call stack exhausted"), set())
        self.assertTrue(v.startswith("unexpected trap"))

    def test_listed_case_that_passes_must_be_removed(self):
        v = lane_a.classify("a", outcome("x"), outcome("x"), {"a"})
        self.assertIn("remove it from the list", v)

    def test_native_trap_is_a_failure(self):
        v = lane_a.classify("a", outcome(trap="has overflowed its stack"), outcome("x"), set())
        self.assertTrue(v.startswith("native trapped"))


class Timeouts(unittest.TestCase):
    def test_a_timeout_is_a_problem_and_never_an_expected_trap(self):
        v = lane_a.classify("a", outcome("x"), outcome(trap="timeout after 9s", timed_out=True), {"a"})
        self.assertTrue(v.startswith("timeout"))
        problems, trapped = lane_a.summarize({"a": v})
        self.assertEqual(trapped, set())
        self.assertEqual(len(problems), 1)
        self.assertFalse(lane_a.resolved_by_update(problems[0], True))


class ResolvedByUpdate(unittest.TestCase):
    def test_stale_listing_is_resolved(self):
        self.assertTrue(lane_a.resolved_by_update("a: listed as an expected trap but passed; remove it from the list", False))

    def test_new_trap_needs_allow_grow(self):
        self.assertFalse(lane_a.resolved_by_update("a: unexpected trap: x", False))
        self.assertTrue(lane_a.resolved_by_update("a: unexpected trap: x", True))

    def test_mismatch_is_never_resolved(self):
        self.assertFalse(lane_a.resolved_by_update("a: mismatch: y", True))


class Summarize(unittest.TestCase):
    def test_traps_and_problems(self):
        problems, trapped = lane_a.summarize({
            "a": "pass", "b": "expected-trap", "c": "unexpected trap: x", "d": "mismatch: y"})
        self.assertEqual(trapped, {"b", "c"})
        self.assertEqual(problems, ["c: unexpected trap: x", "d: mismatch: y"])


if __name__ == "__main__":
    unittest.main()
