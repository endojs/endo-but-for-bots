#!/usr/bin/env python3
"""Unit tests for verify.py's Kani-output parser and manifest rules.

The fixtures under verification/selftest/fixtures are real Kani 0.68 output
(--export-json and the regular text) captured from the deliberately bad
harnesses in verification/selftest and from the meter proofs, so these tests
need no Kani installation.
"""

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tomllib
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("verify.py"))
verify = importlib.util.module_from_spec(spec)
sys.modules["verify"] = verify
spec.loader.exec_module(verify)

FIXTURES = verify.ENGINE / "verification" / "selftest" / "fixtures"


def fixture(name):
    return (json.loads((FIXTURES / f"{name}.json").read_text()),
            verify.parse_regular((FIXTURES / f"{name}.txt").read_text()))


def harness(name, **overrides):
    entry = dict(guarantee="SELF-1", crate="selftest", name=name, tier="pr",
                 statement="s", domain="d", unwind=0, flags=[], time_budget_s=60,
                 memory_budget_gb=1, unreachable=0, mutants=["SELF-1-a"], expect="pass",
                 canary=False)
    entry.update(overrides)
    return entry


class JudgeTests(unittest.TestCase):
    def judge(self, fixture_name, name, **overrides):
        export, regular = fixture(fixture_name)
        return verify.judge(harness(name, **overrides), export, regular)

    def test_pass(self):
        v = self.judge("selftest", "proofs::good")
        self.assertEqual(v.result, "pass")
        self.assertEqual(v.violations, [])
        self.assertEqual(v.covers, (1, 1))

    def test_failed_check_is_a_failure(self):
        v = self.judge("selftest", "proofs::fails")
        self.assertEqual(v.result, "fail")
        self.assertTrue(any("manifest expects pass" in m for m in v.violations))

    def test_expected_failure_passes_the_rules(self):
        v = self.judge("selftest", "proofs::fails", expect="fail", canary=True)
        self.assertEqual(v.violations, [])

    def test_unsatisfiable_cover_fails_although_kani_says_successful(self):
        export, regular = fixture("selftest")
        self.assertEqual(regular["proofs::unsat_cover"], "SUCCESSFUL")
        v = verify.judge(harness("proofs::unsat_cover"), export, regular)
        self.assertEqual(v.result, "pass")
        self.assertIn("cover not satisfied (Unsatisfiable): impossible", v.violations)

    def test_contradictory_assume_is_unreachable_harness_code(self):
        v = self.judge("selftest", "proofs::vacuous_assume")
        self.assertTrue(any(m.startswith("harness check unreachable") for m in v.violations))
        self.assertTrue(any("cover not satisfied (Unreachable)" in m for m in v.violations))

    def test_excluded_library_branch_is_clean(self):
        # Measured: Kani reports the excluded panic branch as SUCCESS.
        v = self.judge("selftest", "proofs::library_branch_excluded")
        self.assertEqual(v.violations, [])
        self.assertEqual(v.library_unreachable, 0)

    def test_out_of_memory_is_a_resource_error(self):
        export, regular = fixture("out-of-memory")
        self.assertEqual(regular["proofs::exhausts_memory"], "FAILED")
        v = verify.judge(harness("proofs::exhausts_memory"), export, regular)
        self.assertEqual(v.result, "error")
        self.assertEqual(v.violations,
                         ["solver/resource error: exit_code_6 (verification_failure)"])

    def test_timeout_is_a_resource_error(self):
        v = self.judge("timeout", "proofs::exhausts_memory")
        self.assertEqual(v.result, "error")
        self.assertTrue(v.violations[0].startswith("solver/resource error: timeout"))

    def test_no_checks_is_a_solver_error(self):
        export, regular = fixture("out-of-memory")
        export = copy.deepcopy(export)
        export["error_details"] = []
        v = verify.judge(harness("proofs::exhausts_memory"), export, regular)
        self.assertEqual(v.violations, ["no checks reported (solver error)"])

    def test_missing_result_and_missing_export(self):
        export, regular = fixture("selftest")
        v = verify.judge(harness("proofs::not_there"), export, regular)
        self.assertEqual(v.violations, ["missing per-harness result"])
        v = verify.judge(harness("proofs::good"), None, regular)
        self.assertEqual(v.result, "error")

    def test_undetermined_and_unknown_statuses_fail(self):
        export, regular = fixture("selftest")
        for status, message in [("Undetermined", "undetermined"), ("Weird", "unknown check")]:
            changed = copy.deepcopy(export)
            for r in changed["verification_results"]["results"]:
                if r["harness_id"] == "proofs::good":
                    r["checks"][0]["status"] = status
            v = verify.judge(harness("proofs::good"), changed, regular)
            self.assertTrue(any(message in m for m in v.violations), (status, v.violations))

    def test_regular_output_must_agree(self):
        export, regular = fixture("selftest")
        regular = dict(regular, **{"proofs::good": "FAILED"})
        v = verify.judge(harness("proofs::good"), export, regular)
        self.assertIn("regular output says FAILED, JSON says Success", v.violations)
        del regular["proofs::good"]
        v = verify.judge(harness("proofs::good"), export, regular)
        self.assertIn("missing from the regular output", v.violations)

    def test_missing_cover_fails(self):
        export, regular = fixture("selftest")
        export = copy.deepcopy(export)
        for r in export["verification_results"]["results"]:
            if r["harness_id"] == "proofs::good":
                r["checks"] = [c for c in r["checks"] if c["category"] != "cover"]
        v = verify.judge(harness("proofs::good"), export, regular)
        self.assertIn("no kani::cover! in the harness (R3 witness rule)", v.violations)

    def test_library_unreachable_count_is_pinned(self):
        name = "meter::proofs::mtr1_checks_and_charges"
        v = self.judge("meter-mtr1", name, crate="ironhorse-vm")
        self.assertEqual(v.library_unreachable, 3)
        self.assertIn("library unreachable count 3, manifest pins 0", v.violations)
        v = self.judge("meter-mtr1", name, crate="ironhorse-vm", unreachable=3)
        self.assertEqual(v.violations, [])
        v = self.judge("meter-mtr1", name, crate="ironhorse-vm", unreachable=4)
        self.assertIn("library unreachable count 3, manifest pins 4", v.violations)

    def test_harness_helpers_count_as_library(self):
        self.assertTrue(verify.is_harness_code("m::proofs::h", "m::proofs::h"))
        self.assertTrue(verify.is_harness_code("m::proofs::h::{closure#0}", "m::proofs::h"))
        self.assertFalse(verify.is_harness_code("m::proofs::Host::consult", "m::proofs::h"))
        self.assertFalse(verify.is_harness_code("m::proofs::h2", "m::proofs::h"))

    def test_time_budget(self):
        v = self.judge("meter-mtr1", "meter::proofs::mtr1_sequence_of_four",
                       crate="ironhorse-vm", unreachable=1)
        self.assertEqual(v.violations, [])
        seconds = v.seconds
        v = self.judge("meter-mtr1", "meter::proofs::mtr1_sequence_of_four",
                       crate="ironhorse-vm", unreachable=1, time_budget_s=seconds / 1.7)
        self.assertEqual(v.violations, [])
        self.assertIn("warning", v.note)
        v = self.judge("meter-mtr1", "meter::proofs::mtr1_sequence_of_four",
                       crate="ironhorse-vm", unreachable=1, time_budget_s=seconds / 2.5)
        self.assertTrue(any("exceeds 2.0x budget" in m for m in v.violations))

    def test_parse_regular(self):
        text = ("Checking harness a::b...\nVERIFICATION:- SUCCESSFUL\n"
                "Checking harness a::c...\nCBMC failed\nVERIFICATION:- FAILED\n")
        self.assertEqual(verify.parse_regular(text), {"a::b": "SUCCESSFUL", "a::c": "FAILED"})


class ManifestTests(unittest.TestCase):
    def manifest(self):
        return verify.load_manifest()

    def test_checked_in_manifest_is_valid(self):
        self.assertEqual(verify.validate_manifest(self.manifest(), verify.mutant_files()), [])

    def test_rule_violations_are_reported(self):
        cases = [
            (lambda d: d["harness"][0].update(tier="weekly"), "tier must be one of"),
            (lambda d: d["harness"][0].pop("domain"), "missing domain"),
            (lambda d: d["harness"][0].update(flags=["--no-overflow-checks"]), "flags_reason"),
            (lambda d: d["harness"][0].update(unreachable=2), "unreachable_reason"),
            (lambda d: d["harness"][0].update(expect="fail"), "only a canary may expect failure"),
            (lambda d: d["harness"][0].update(guarantee="NOPE-1"), "unknown guarantee"),
            (lambda d: d["harness"][0].update(mutants=["MTR-9-z"]), "has no verification/mutants"),
            (lambda d: d["harness"][0].update(colour="red"), "unknown keys"),
            (lambda d: d["harness"].append(copy.deepcopy(d["harness"][0])), "listed twice"),
            (lambda d: d.pop("kani_version"), "kani_version"),
            (lambda d: d["guarantee"].append(dict(d["guarantee"][0], id="MTR-99")), "no harness"),
        ]
        for edit, message in cases:
            data = self.manifest()
            edit(data)
            errors = verify.validate_manifest(data, verify.mutant_files())
            self.assertTrue(any(message in e for e in errors), (message, errors))

    def test_guarantee_without_mutant_is_rejected(self):
        data = self.manifest()
        for h in data["harness"]:
            if h["guarantee"] == "MTR-5":
                h["mutants"] = []
        errors = verify.validate_manifest(data, verify.mutant_files())
        self.assertIn("guarantee MTR-5: no mutant (R4)", errors)

    def test_unreferenced_mutant_is_rejected(self):
        errors = verify.validate_manifest(self.manifest(), verify.mutant_files() | {"MTR-1-zz"})
        self.assertIn("mutant MTR-1-zz.patch is referenced by no harness", errors)

    def test_every_mtr_guarantee_has_two_mutants(self):
        data = self.manifest()
        for g in data["guarantee"]:
            if g["id"].startswith("MTR-"):
                mutants = {m for h in data["harness"] if h["guarantee"] == g["id"]
                           for m in h["mutants"]}
                self.assertGreaterEqual(len(mutants), 2, g["id"])

    def test_mutants_apply_to_the_tree(self):
        for name in sorted(verify.mutant_files()):
            ok, out = verify.patch_applies(verify.MUTANTS / f"{name}.patch", verify.ENGINE)
            self.assertTrue(ok, f"{name}: {out}")

    def test_unwind_attribute_is_read(self):
        self.assertEqual(verify.unwind_attribute(
            "ironhorse-vm", "meter::proofs::mtr1_sequence_of_four"), 5)
        self.assertEqual(verify.unwind_attribute("ironhorse-vm", "meter::proofs::mtr1_tick_code"), 0)
        self.assertIsNone(verify.unwind_attribute("ironhorse-vm", "meter::proofs::absent"))

    def test_source_grep_finds_the_harness_crates(self):
        counts = verify.source_harnesses()
        data = self.manifest()
        for crate, n in counts.items():
            self.assertEqual(n, sum(h["crate"] == crate for h in data["harness"]), crate)

    def test_batches_group_by_crate_and_flags(self):
        hs = [harness("a"), harness("b"), harness("c", flags=["--no-overflow-checks"]),
              harness("d", crate="other")]
        groups = [(c, f, [h["name"] for h in g]) for c, f, g in verify.batches(hs)]
        self.assertEqual(groups, [("other", (), ["d"]), ("selftest", (), ["a", "b"]),
                                  ("selftest", ("--no-overflow-checks",), ["c"])])

    def test_z_flags(self):
        self.assertEqual(verify.z_flags(["--no-overflow-checks", "-Z", "stubbing", "-Zfoo"]),
                         ["-Z", "stubbing", "-Zfoo"])


class LedgerTests(unittest.TestCase):
    def test_checked_in_ledger_is_current(self):
        data = verify.load_manifest()
        actual = verify.LEDGER.read_text()
        self.assertEqual(verify.splice(actual, verify.render_ledger(data)), actual)

    def test_ledger_tracks_the_manifest(self):
        data = verify.load_manifest()
        before = verify.render_ledger(data)
        data["harness"][0]["domain"] = "something else | with a pipe"
        after = verify.render_ledger(data)
        self.assertNotEqual(before, after)
        self.assertIn("something else \\| with a pipe", after)

    def test_splice_requires_markers(self):
        with self.assertRaises(verify.ManifestError):
            verify.splice("no markers", "x")


if __name__ == "__main__":
    unittest.main()
