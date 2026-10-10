"""Regression tests for dependency drift and Cargo.lock ID resolution."""

import importlib.util
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "agreement", Path(__file__).with_name("check-lockfile-agreement.py")
)
agreement = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agreement)


def package(name, version="1.0.0", dependencies=(), source=None, checksum=None):
    result = {"name": name, "version": version, "dependencies": list(dependencies)}
    if source is not None:
        result["source"] = source
    if checksum is not None:
        result["checksum"] = checksum
    return result


def lock(*dependencies):
    return [
        package("ironhorse-vm", dependencies=["icu 1.0.0"]),
        package("ironhorse-snapshot", dependencies=["ironhorse-vm"]),
        *dependencies,
    ]


class AgreementTests(unittest.TestCase):
    def test_unrelated_root_versions_are_not_ironhorse_dependencies(self):
        shared = package("icu", source="registry+example", checksum="abc")
        root = lock(shared, package("icu", version="2.0.0"))
        self.assertEqual(agreement.disagreements(root, lock(shared)), [])

    def test_transitive_version_drift_is_rejected(self):
        root = lock(package("icu", dependencies=["data"]), package("data"))
        engine = lock(package("icu", dependencies=["data"]), package("data", "1.1.0"))
        self.assertIn("data:", agreement.disagreements(root, engine)[0])

    def test_source_and_checksum_drift_are_rejected(self):
        root = lock(package("icu", source="registry+one", checksum="abc"))
        for source, checksum in [("registry+two", "abc"), ("registry+one", "def")]:
            with self.subTest(source=source, checksum=checksum):
                engine = lock(package("icu", source=source, checksum=checksum))
                self.assertIn("icu:", agreement.disagreements(root, engine)[0])

    def test_source_qualified_edges_select_the_correct_package(self):
        packages = [
            package("ironhorse-vm", dependencies=["icu 1.0.0 (registry+one)"]),
            package("icu", source="registry+one"),
            package("icu", source="registry+two"),
        ]
        resolutions, _ = agreement.shared_dependencies(packages, {"ironhorse-vm"})
        self.assertEqual(resolutions["icu"], {("1.0.0", "registry+one", "")})

    def test_swapped_edges_fail_even_when_version_sets_agree(self):
        shared = [package("data", "1.0.0"), package("data", "2.0.0")]
        root = lock(package("icu", dependencies=["a", "b"]),
                    package("a", dependencies=["data 1.0.0"]),
                    package("b", dependencies=["data 2.0.0"]), *shared)
        engine = lock(package("icu", dependencies=["a", "b"]),
                      package("a", dependencies=["data 2.0.0"]),
                      package("b", dependencies=["data 1.0.0"]), *shared)
        errors = agreement.disagreements(root, engine)
        self.assertEqual(len(errors), 2)
        self.assertTrue(all("-> data:" in error for error in errors))

    def test_broken_edges_and_missing_roots_fail_closed(self):
        with self.assertRaises(ValueError):
            agreement.disagreements(lock(), lock())
        with self.assertRaises(ValueError):
            agreement.disagreements([], [])
        with self.assertRaises(ValueError):
            agreement.shared_dependencies(
                [package("ironhorse-vm", dependencies=["icu"]),
                 package("icu"), package("icu", "2.0.0")],
                {"ironhorse-vm"},
            )


if __name__ == "__main__":
    unittest.main()
