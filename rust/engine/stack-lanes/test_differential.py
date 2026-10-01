import unittest

import differential


class Snippets(unittest.TestCase):
    def test_a_file_splits_on_separator_lines_and_reads_flags(self):
        text = "1 + 1\n// ---\n// flags: --eval-compiler\neval('2')\n  // ---  \n\n// ---\nx\n"
        programs = differential.parse_snippets(text, "f.js")
        self.assertEqual([name for name, _, _ in programs], ["f.js#1", "f.js#2", "f.js#3"])
        self.assertEqual(programs[0][1:], ("1 + 1\n", []))
        self.assertEqual(programs[1][2], ["--eval-compiler"])
        self.assertEqual(programs[2][1], "x\n")

    def test_a_program_without_a_flags_line_has_none(self):
        (_, source, flags), = differential.parse_snippets("// a comment\nf()\n", "g.js")
        self.assertEqual(flags, [])
        self.assertEqual(source, "// a comment\nf()\n")

    def test_the_flags_line_may_follow_blank_lines_and_a_byte_order_mark(self):
        (_, _, flags), = differential.parse_snippets("﻿\n\n// flags: --compile-only\nx\n", "h.js")
        self.assertEqual(flags, ["--compile-only"])

    def test_carriage_returns_do_not_hide_a_separator(self):
        programs = differential.parse_snippets("a\r\n// ---\r\nb\r\n", "i.js")
        self.assertEqual(len(programs), 2)

    def test_unknown_or_misplaced_flags_are_refused(self):
        with self.assertRaises(differential.SnippetError):
            differential.parse_snippets("// flags: --stack\nx\n", "j.js")
        with self.assertRaises(differential.SnippetError):
            differential.parse_snippets("x\n// flags: --eval-compiler\n", "k.js")


class Depths(unittest.TestCase):
    def test_depths_surround_the_ceiling(self):
        self.assertEqual(differential.depths(63), [0, 1, 2, 31, 62, 63, 64, 65])

    def test_small_ceilings_do_not_repeat_or_go_negative(self):
        self.assertEqual(differential.depths(1), [0, 1, 2, 3])
        self.assertEqual(differential.depths(0), [0, 1, 2])


class Classify(unittest.TestCase):
    OVERFLOW = "trap: thread '<unnamed>' has overflowed its stack"

    def test_verdicts(self):
        self.assertEqual(differential.classify("halt=Return", "halt=Return"), "same")
        self.assertEqual(differential.classify("halt=Return meter=1", "halt=Return meter=2"), "differs")
        self.assertEqual(differential.classify("halt=Return", self.OVERFLOW), "differs")

    def test_only_a_repaired_stack_overflow_is_fixed(self):
        self.assertEqual(differential.classify(self.OVERFLOW, "halt=Return"), "fixed")
        self.assertEqual(differential.classify("trap: signal 9", "halt=Return"), "differs")
        self.assertEqual(differential.classify(self.OVERFLOW, "trap: signal 6"), "differs")

    def test_a_timeout_in_either_build_fails(self):
        self.assertEqual(differential.classify("timeout", "timeout"), "timeout")
        self.assertEqual(differential.classify(self.OVERFLOW, "timeout"), "timeout")
        self.assertIn("timeout", differential.FAILING)


class Flags(unittest.TestCase):
    def test_source_flags(self):
        self.assertEqual(differential.source_flags(False, False), [])
        self.assertEqual(differential.source_flags(True, True), ["--compile-only", "--eval-compiler"])


if __name__ == "__main__":
    unittest.main()
