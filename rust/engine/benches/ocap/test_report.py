"""Fail-closed tests for object-capability report generation and schema."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

from generate import rendered_files
from run import PHASES, ROSTER, SIZES, fixture_digest, parse_samples, validate_report


def valid_report():
    phases = {
        phase: {"samples_ns": [1] * 7, "median_ns": 1}
        for phase in PHASES
    }
    xs_phases = copy.deepcopy(phases)
    for phase in ("setup", "link", "collection", "checkpoint"):
        xs_phases[phase] = {"samples_ns": [None] * 7, "median_ns": None}
    measurements = []
    for name in ROSTER:
        for size in SIZES:
            expected = f"{name}:{size}"
            arm = {
                "result": expected,
                "computrons": 1,
                "meter_raw": 1,
                "dispatched": 1,
                "allocations": {"slot_allocations": 0},
                "phases": copy.deepcopy(phases),
            }
            xs = copy.deepcopy(arm)
            xs["dispatched"] = None
            xs["allocations"] = None
            xs["phases"] = xs_phases
            measurements.append(
                {
                    "fixture": name,
                    "size": size,
                    "expected": expected,
                    "arms": {"parent": copy.deepcopy(arm), "candidate": copy.deepcopy(arm), "xs": xs},
                }
            )
    return {
        "schema_version": 1,
        "provenance": {
            "parent_commit": "a",
            "candidate_commit": "b",
            "xs_commit": "c",
            "rustc": "rustc",
            "cargo": "cargo",
            "platform": "platform",
            "machine": "machine",
            "cpu": "cpu",
            "hostname": "host",
            "build_environment": {},
        },
        "corpus": {"fixture_sha256": "digest", "roster": list(ROSTER), "sizes": list(SIZES)},
        "methodology": {"samples": 7, "warmups": 1},
        "measurements": measurements,
        "validation": {"failures": []},
    }


class Generation(unittest.TestCase):
    def test_checked_in_generation_is_current(self):
        for path, content in rendered_files().items():
            self.assertEqual(path.read_text(), content, path)

    def test_digest_changes_with_source_name_and_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "fixtures").mkdir()
            manifest = {"fixtures": [{"source": "fixtures/a.js"}]}
            (root / "manifest.json").write_text(json.dumps(manifest))
            source = root / "fixtures/a.js"
            source.write_text("one")
            original = fixture_digest(root)
            source.write_text("two")
            self.assertNotEqual(original, fixture_digest(root))
            (root / "fixtures/b.js").write_text("one")
            manifest["fixtures"][0]["source"] = "fixtures/b.js"
            (root / "manifest.json").write_text(json.dumps(manifest))
            self.assertNotEqual(original, fixture_digest(root))


class DriverOutput(unittest.TestCase):
    def test_missing_duplicate_and_unexpected_samples_fail(self):
        manifest = {"fixtures": [{"name": "one", "size": "small"}]}
        line = 'OCAP_SAMPLE {"fixture":"one","size":"small"}'
        self.assertEqual(list(parse_samples(line, manifest)), [("one", "small")])
        self.assertEqual(
            list(parse_samples(f"test ocap_workload ... {line}", manifest)),
            [("one", "small")],
        )
        with self.assertRaisesRegex(ValueError, "duplicate"):
            parse_samples(f"{line}\n{line}", manifest)
        with self.assertRaisesRegex(ValueError, "roster differs"):
            parse_samples("", manifest)


class Schema(unittest.TestCase):
    def test_valid_report(self):
        self.assertTrue(validate_report(valid_report()))

    def test_roster_sample_count_result_and_computron_drift_fail(self):
        mutations = []
        report = valid_report()
        report["measurements"].pop()
        mutations.append(report)
        report = valid_report()
        report["methodology"]["samples"] = 6
        mutations.append(report)
        report = valid_report()
        report["measurements"][0]["arms"]["xs"]["result"] = "wrong"
        mutations.append(report)
        report = valid_report()
        report["measurements"][0]["arms"]["candidate"]["computrons"] = 2
        mutations.append(report)
        for report in mutations:
            with self.subTest(report=report):
                with self.assertRaises(ValueError):
                    validate_report(report)

    def test_unavailable_xs_counters_and_phases_stay_null(self):
        report = valid_report()
        report["measurements"][0]["arms"]["xs"]["allocations"] = {}
        with self.assertRaisesRegex(ValueError, "XS allocations"):
            validate_report(report)
        report = valid_report()
        report["measurements"][0]["arms"]["xs"]["phases"]["setup"] = {
            "samples_ns": [1] * 7,
            "median_ns": 1,
        }
        with self.assertRaisesRegex(ValueError, "XS phase"):
            validate_report(report)


if __name__ == "__main__":
    unittest.main()
