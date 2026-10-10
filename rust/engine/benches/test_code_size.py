"""Checker tests for the code-size instrument (F106/F122).

The instrument's own measurement needs a release build, so these tests cover
the parts that decide what the measurement MEANS: which sections are summed,
which objects are excluded, and how the bar is applied. A measurement whose
section filter is wrong reports zero and passes any bar, which is the failure
mode worth a test.
"""
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from code_size import CODE_SIZE_LIMIT, ENGINE_CRATES, measure, text_bytes

# Real `size -A` output: both sides build with per-function sections, so the
# bare `.text` section is EMPTY and the code lives in `.text.<symbol>`.
FUNCTION_SECTIONS = """/tmp/x.o  :
section                                   size   addr
.text                                        0      0
.data                                        0      0
.bss                                         0      0
.rodata.fx_JSON_isRawJSON.str1.1             8      0
.text.fx_JSON_isRawJSON                     98      0
.text.fxToJSONKeys                         404      0
Total                                      510
"""


class SectionSumming(unittest.TestCase):
    def measured(self, output, names=("a.o",)):
        with mock.patch("code_size.subprocess.run") as run, mock.patch(
            "code_size.Path.iterdir"
        ) as iterdir:
            iterdir.return_value = [Path(f"/tmp/{n}") for n in names]
            run.side_effect = [
                mock.Mock(),  # ar x
                mock.Mock(stdout=output),  # size -A
            ]
            return text_bytes(Path("/tmp/fake.a"))

    def test_per_function_sections_are_counted(self):
        # The defect this guards: summing only the bare `.text` section
        # reports 0 for every object built with -ffunction-sections, and a
        # ratio of 0 passes any bar.
        self.assertEqual(self.measured(FUNCTION_SECTIONS), 98 + 404)

    def test_non_text_sections_are_not_counted(self):
        self.assertNotIn(8, [self.measured(FUNCTION_SECTIONS)])

    def test_an_archive_with_no_text_is_an_error(self):
        empty = "/tmp/x.o  :\nsection    size   addr\n.data        16      0\n"
        with self.assertRaises(ValueError):
            self.measured(empty)

    def test_an_archive_with_no_objects_is_an_error(self):
        with self.assertRaises(ValueError):
            self.measured(FUNCTION_SECTIONS, names=())


class Bar(unittest.TestCase):
    def test_the_bar_is_the_designs_and_is_applied_as_a_ceiling(self):
        self.assertEqual(CODE_SIZE_LIMIT, 2.0)

    def test_the_report_names_every_engine_crate(self):
        # The roster is what the ratio means; a crate dropped from it
        # silently shrinks the engine side.
        with mock.patch("code_size.text_bytes", return_value=100), mock.patch(
            "code_size.newest", return_value=Path("/tmp/fake")
        ):
            report = measure()
        self.assertEqual(set(report["engine_by_crate"]), set(ENGINE_CRATES))
        self.assertEqual(report["engine_text_bytes"], 100 * len(ENGINE_CRATES))
        self.assertEqual(report["ratio"], len(ENGINE_CRATES))
        self.assertFalse(report["within_code_size_limit"])

    def test_within_the_bar_is_reported_as_within(self):
        with mock.patch("code_size.text_bytes", side_effect=[1000] + [100] * len(ENGINE_CRATES)), mock.patch(
            "code_size.newest", return_value=Path("/tmp/fake")
        ):
            report = measure()
        self.assertTrue(report["within_code_size_limit"])


class RealMeasurement(unittest.TestCase):
    """The instrument against the real tree, when a release build exists."""

    def test_the_measurement_runs_and_is_self_consistent(self):
        root = Path(__file__).resolve().parents[1]
        if not list((root / "target" / "release").glob("build/xs-oracle-*/out/libxsoracle.a")):
            self.skipTest("no release build of the XS oracle in this tree")
        result = subprocess.run(
            ["python3", str(Path(__file__).with_name("code_size.py"))],
            check=True, text=True, stdout=subprocess.PIPE, cwd=root,
        )
        import json

        report = json.loads(result.stdout)
        self.assertGreater(report["xs_text_bytes"], 100_000, "XS is not a small library")
        self.assertGreater(report["engine_text_bytes"], 100_000)
        self.assertEqual(
            report["engine_text_bytes"], sum(report["engine_by_crate"].values())
        )
        self.assertAlmostEqual(
            report["ratio"],
            report["engine_text_bytes"] / report["xs_text_bytes"],
        )
        self.assertEqual(
            report["within_code_size_limit"], report["ratio"] <= CODE_SIZE_LIMIT
        )


if __name__ == "__main__":
    unittest.main()
