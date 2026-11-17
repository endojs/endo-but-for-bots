#!/usr/bin/env python3
"""The wasm recipe's invariants, and that its consumers agree with it."""

import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPTS = Path(__file__).resolve().parent
ENGINE = SCRIPTS.parent
build_wasm = load("build_wasm", SCRIPTS / "build-wasm.py")
build_probe = load("build_probe", ENGINE / "stack-lanes/build_probe.py")
changes = load("changes", ENGINE.parents[1] / "scripts/ci-changes.py")

PROBE_EXPORT = "-C link-arg=--export=__stack_pointer"


class Recipe(unittest.TestCase):
    def test_unwinding_over_exnref_with_the_shadow_stack(self):
        flags = build_wasm.rustflags()
        self.assertIn("-C panic=unwind", flags)
        self.assertIn("-C target-feature=+exception-handling", flags)
        # B2: in RUSTFLAGS, so that -Zbuild-std compiles std with the same encoding.
        self.assertIn("-C llvm-args=-wasm-use-legacy-eh=false", flags)
        self.assertIn("-C link-arg=-zstack-size=4194304", flags)
        self.assertEqual(build_wasm.DEFAULT_SHADOW_STACK, 4 * 1024 * 1024)

    def test_shadow_stack_and_extra_flags(self):
        flags = build_wasm.rustflags(2 * 1024 * 1024, [PROBE_EXPORT])
        self.assertIn("-C link-arg=-zstack-size=2097152", flags)
        self.assertNotIn("-C link-arg=-zstack-size=4194304", flags)
        self.assertEqual(flags[-1], PROBE_EXPORT)

    def test_environment_stands_in_for_nightly(self):
        base = {"PATH": "/bin", "CARGO_ENCODED_RUSTFLAGS": "-Cpanic=abort", "RUSTFLAGS": "-Cpanic=abort"}
        env = build_wasm.environment(base=base)
        self.assertEqual(env["RUSTC_BOOTSTRAP"], "1")
        self.assertEqual(env["RUSTFLAGS"], " ".join(build_wasm.rustflags()))
        self.assertNotIn("CARGO_ENCODED_RUSTFLAGS", env)
        self.assertEqual(env["PATH"], "/bin")
        self.assertEqual(base["RUSTFLAGS"], "-Cpanic=abort", "the base is not written")

    def test_build_std_with_unwinding(self):
        self.assertEqual(build_wasm.build_arguments("wasm32-wasip1"), [
            "cargo", "build", "-Zbuild-std=std,panic_unwind", "--target", "wasm32-wasip1", "--release",
        ])
        self.assertEqual(build_wasm.build_arguments("wasm32-unknown-unknown", "dev")[-2:],
                         ["--target", "wasm32-unknown-unknown"])
        self.assertEqual(build_wasm.build_arguments("wasm32-wasip1", "bench")[-2:], ["--profile", "bench"])

    def test_every_wasm_capable_member_with_consensus(self):
        self.assertEqual(set(build_wasm.CRATES), {
            "ironhorse-meter", "ironhorse-text", "ironhorse-unicode", "ironhorse-regexp",
            "ironhorse-vm", "ironhorse-compile", "ironhorse-runtime", "ironhorse-snapshot",
        })
        arguments = build_wasm.crate_arguments()
        self.assertEqual(arguments.count("-p"), len(build_wasm.CRATES))
        self.assertEqual(arguments[-2:], ["--features", "ironhorse-vm/consensus"])
        # A build that leaves ironhorse-vm out asks for no feature of it.
        self.assertNotIn("--features", build_wasm.crate_arguments(["ironhorse-meter"]))

    def test_artifact_paths_follow_the_profile(self):
        release = build_wasm.artifact("ironhorse-vm", "wasm32-wasip1")
        self.assertEqual(release.parts[-4:], ("target", "wasm32-wasip1", "release", "libironhorse_vm.rlib"))
        debug = build_wasm.artifact("ironhorse-vm", "wasm32-unknown-unknown", "dev")
        self.assertEqual(debug.parts[-3:], ("wasm32-unknown-unknown", "debug", "libironhorse_vm.rlib"))


class Consumers(unittest.TestCase):
    def test_probe_adds_only_its_stack_pointer_export(self):
        shared = " ".join(build_wasm.rustflags(build_probe.DEFAULT_SHADOW_STACK))
        self.assertEqual(build_probe.wasm_rustflags(build_probe.DEFAULT_SHADOW_STACK),
                         shared + " " + PROBE_EXPORT)
        self.assertEqual(build_probe.WASM_TARGET, build_wasm.WASIP1)
        self.assertEqual(build_probe.DEFAULT_SHADOW_STACK, build_wasm.DEFAULT_SHADOW_STACK)

    def test_ci_selects_the_job_for_the_crates_the_script_builds(self):
        self.assertEqual(changes.WASM_CRATES, set(build_wasm.CRATES))


if __name__ == "__main__":
    unittest.main()
