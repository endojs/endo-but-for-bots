#!/usr/bin/env python3
"""Guard the opcode generator against incomplete or inconsistent source tables."""
import pathlib
import runpy
import unittest

GENERATOR = runpy.run_path(str(pathlib.Path(__file__).with_name("generate-compiler-opcodes.py")))
SOURCE = GENERATOR["SOURCE"].read_text()


class GeneratorTests(unittest.TestCase):
    def test_reproduces_checked_in_output(self):
        self.assertEqual(GENERATOR["generate"](SOURCE), GENERATOR["TARGET"].read_text())

    def test_duplicate_or_missing_ordinal_is_rejected(self):
        for replacement in ["XS_CODE_ADD = 2,", "XS_CODE_ADD = 255,"]:
            with self.assertRaises(ValueError):
                GENERATOR["generate"](SOURCE.replace("XS_CODE_ADD = 1,", replacement, 1))

    def test_size_row_drift_is_rejected(self):
        with self.assertRaises(ValueError):
            GENERATOR["generate"](SOURCE.replace("// XS_CODE_ADD", "// XS_CODE_UNKNOWN", 1))

    def test_id_width_is_generated_from_the_vm(self):
        changed = SOURCE.replace("pub const ID_SIZE: usize = 2;", "pub const ID_SIZE: usize = 4;")
        self.assertIn("pub const ID_SIZE: i32 = 4;", GENERATOR["generate"](changed))


if __name__ == "__main__":
    unittest.main()
