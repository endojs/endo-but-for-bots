"""Keep empty selections and untrusted names from widening CI test scope."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("run-ci-task.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TaskSelection(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for name, scripts in {
            "real": {"test": "ava", "test:types": "tsc"},
            "noop": {"test": "exit 0"},
            "absent": {},
        }.items():
            path = self.root / "packages" / name / "package.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"name": f"@endo/{name}", "scripts": scripts}))

    def test_empty_selection_never_runs_all_packages(self):
        self.assertIsNone(runner.command("test", [], self.root))
        self.assertIsNone(runner.command("test", ["@endo/noop", "@endo/absent"], self.root))

    def test_only_exact_selected_package_runs(self):
        self.assertEqual(runner.command("test", ["@endo/real", "@endo/real"], self.root),
                         ["corepack", "yarn", "turbo", "run", "test", "--filter=@endo/real"])

    def test_type_contracts_keep_collecting_failures(self):
        self.assertIn("--continue=always", runner.command("test:types", ["@endo/real"], self.root))

    def test_malformed_or_unknown_selection_fails(self):
        for selected in ["@endo/real", [None], ["@endo/missing"], ["*"], ["...@endo/real"],
                         ["@endo/real[HEAD]"], ["$(touch /tmp/unwanted)"]]:
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                runner.command("test", selected, self.root)


if __name__ == "__main__":
    unittest.main()
