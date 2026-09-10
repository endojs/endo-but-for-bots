#!/usr/bin/env python3
"""Regression tests for ICU profile drift detection, using the actual lock graph."""
import copy
import importlib.util
import tomllib
import unittest

spec = importlib.util.spec_from_file_location("intl_profile", __file__.replace("test-intl-profile", "intl-profile"))
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.packages = tomllib.loads((profile.REPO / "rust/engine/Cargo.lock").read_text())["package"]
        self.dependencies = tomllib.loads((profile.REPO / "rust/engine/ironhorse-vm/Cargo.toml").read_text())["dependencies"]
        self.baseline = profile.fingerprint(self.packages, self.dependencies)

    def changed(self, field, value):
        packages = copy.deepcopy(self.packages)
        package = next(p for p in packages if p["name"] == "icu_normalizer_data")
        package[field] = value
        digest = profile.fingerprint(packages, self.dependencies)
        self.assertNotEqual(digest, self.baseline)
        self.assertNotEqual(profile.identity(digest), profile.identity(self.baseline))

    def test_current_graph_preserves_immutable_legacy_alias(self):
        # Intentionally fails on an upgrade: replace this assertion with the new
        # reviewed identity, NEVER change profile.BASELINE to preserve the alias.
        self.assertEqual(self.baseline, profile.BASELINE)
        self.assertEqual(profile.identity(self.baseline), "ironhorse-intl-2026a")

    def test_data_version_changes_identity(self):
        self.changed("version", "99.0.0")

    def test_data_checksum_changes_identity(self):
        self.changed("checksum", "0" * 64)

    def test_dependency_edge_changes_identity(self):
        self.changed("dependencies", ["tinystr"])

    def test_root_features_change_identity(self):
        dependencies = copy.deepcopy(self.dependencies)
        dependencies["icu_normalizer"] = {"version": "=2.2.0", "default-features": False}
        self.assertNotEqual(profile.fingerprint(self.packages, dependencies), self.baseline)

    def test_unrelated_dependency_does_not_change_identity(self):
        packages = copy.deepcopy(self.packages)
        packages.append({"name": "unrelated", "version": "1.0.0", "checksum": "0" * 64})
        self.assertEqual(profile.fingerprint(packages, self.dependencies), self.baseline)

    def test_missing_data_dependency_is_rejected(self):
        packages = [p for p in self.packages if p["name"] != "icu_normalizer_data"]
        with self.assertRaisesRegex(ValueError, "Missing or ambiguous"):
            profile.fingerprint(packages, self.dependencies)


if __name__ == "__main__":
    unittest.main()
