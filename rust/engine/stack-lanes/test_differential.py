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

    def test_a_name_line_names_the_program(self):
        text = "// name: first\n1\n// ---\n2\n// ---\n// flags: --eval-compiler\n// name: third-1.x\neval('3')\n"
        programs = differential.parse_snippets(text, "n.js")
        self.assertEqual([name for name, _, _ in programs], ["n.js#first", "n.js#2", "n.js#third-1.x"])
        self.assertEqual(programs[2][2], ["--eval-compiler"])
        self.assertEqual(programs[0][1], "// name: first\n1\n")

    def test_names_are_words_unique_in_their_file_and_open_the_program(self):
        for text in ("// name: 1st\nx\n", "// name: a b\nx\n", "// name: a\nx\n// ---\n// name: a\ny\n",
                     "x\n// name: late\n", "// name: a\n// name: b\nx\n",
                     "// flags: --compile-only\n// flags: --eval-compiler\nx\n"):
            with self.subTest(text=text):
                with self.assertRaises(differential.SnippetError):
                    differential.parse_snippets(text, "m.js")

    def test_ceiling_flags_take_a_number(self):
        (_, _, flags), = differential.parse_snippets(
            "// flags: --chunk-ceiling=1073741824 --slot-ceiling=44739242\nx\n", "c.js")
        self.assertEqual(flags, ["--chunk-ceiling=1073741824", "--slot-ceiling=44739242"])
        for flag in ("--chunk-ceiling", "--chunk-ceiling=", "--chunk-ceiling=1e9", "--slot-ceiling=-1"):
            with self.subTest(flag=flag):
                with self.assertRaises(differential.SnippetError):
                    differential.parse_snippets(f"// flags: {flag}\nx\n", "c.js")


class Shards(unittest.TestCase):
    def test_slow_programs_belong_to_the_slow_shard_only(self):
        self.assertTrue(differential.in_shard(False, "fast"))
        self.assertFalse(differential.in_shard(True, "fast"))
        self.assertTrue(differential.in_shard(True, "slow"))
        self.assertFalse(differential.in_shard(False, "slow"))
        self.assertTrue(differential.in_shard(True, "all") and differential.in_shard(False, "all"))

    def test_the_checked_in_snippets_parse_and_slow_files_are_slow(self):
        programs = differential.snippet_inputs()
        self.assertTrue(programs)
        for program in programs:
            self.assertEqual(program.slow, ".slow.js#" in program.label, program.label)
        labels = [program.label for program in programs]
        self.assertEqual(len(labels), len(set(labels)))


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
