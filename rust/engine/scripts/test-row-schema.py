"""Adversarial transitions for the base-revision row schema guard."""
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("schema", Path(__file__).with_name("check-row-schema.py"))
schema = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema)


class Transitions(unittest.TestCase):
    old = "1\t20\t31\told\n"
    next = old + "2\t23\t35\tnew\n"

    def test_unchanged_rows_allow_encoding_only_releases(self):
        schema.verify(self.old, self.old, (20, 31), (22, 34), 1)

    def test_new_row_requires_new_wire_versions(self):
        schema.verify(self.old, self.next, (22, 34), (23, 35), 2)
        for wire in [(22, 35), (23, 34), (22, 34)]:
            with self.assertRaisesRegex(ValueError, "advance both"):
                schema.verify(self.old, self.next, (22, 34), wire, 2)

    def test_cannot_repin_or_remove_history(self):
        for rows in ["1\t20\t31\trepinned\n", "", "2\t23\t35\tnew\n"]:
            with self.assertRaisesRegex(ValueError, "history"):
                schema.verify(self.old, rows, (20, 31), (23, 35), 2)

    def test_cannot_reuse_a_previously_shipped_encoding_release(self):
        with self.assertRaisesRegex(ValueError, "newly advanced"):
            schema.verify(self.old, self.old + "2\t21\t32\tnew\n", (22, 34), (23, 35), 2)

    def test_initial_release_preserves_existing_encoding(self):
        schema.verify("", self.old, (20, 31), (20, 31), 1)


if __name__ == "__main__":
    unittest.main()
