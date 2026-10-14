#!/usr/bin/env python3
"""Run the snapshot's target-independence tests on 32-bit WASI.

These are the refusals and portability checks of WASM-BLOCKERS.md B7 that need
no compiler: oversized counts and chunk lengths, duplicate Intl bound-function
owners, temporary names without a process id, and the consensus ceiling caps.

Requires Node.js with WASI preview1 and a Rust wasm32-wasip1 standard library:
    rustup target add --toolchain 1.91.1 wasm32-wasip1
    python3 rust/engine/scripts/test-snapshot-wasi.py

The ordinary snapshot test graph includes ironhorse-compile, whose required
panic unwinding is unavailable on this target. This temporary standalone test
package uses the production snapshot library and the checked-in test files,
with the VM's `consensus` feature on, as the shipping worker builds it. The
tests that touch the filesystem find a preopened scratch directory through
IRONHORSE_TEST_SCRATCH.
"""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile


# (test name, path relative to the engine root)
TESTS = (
    ("record_count_overflow", "ironhorse-snapshot/tests/record_count_overflow.rs"),
    ("chunk_length_refusal", "ironhorse-snapshot/tests/chunk_length_refusal.rs"),
    ("intl_bound_owner_refusal", "ironhorse-snapshot/tests/intl_bound_owner_refusal.rs"),
    ("temporary_names", "ironhorse-snapshot/tests/temporary_names.rs"),
    ("consensus_ceiling_caps", "ironhorse-vm/tests/consensus_ceiling_caps.rs"),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", default="1.91.1")
    args = parser.parse_args()
    engine = pathlib.Path(__file__).resolve().parent.parent
    snapshot = engine / "ironhorse-snapshot"
    with tempfile.TemporaryDirectory(prefix="snapshot-wasi-") as scratch:
        root = pathlib.Path(scratch)
        manifest = root / "Cargo.toml"
        # The tests' `cfg(feature = "consensus")` names this package's
        # feature, which turns the VM's on.
        manifest.write_text(
            '[package]\nname = "snapshot-wasi-check"\nversion = "0.0.0"\n'
            'edition = "2021"\n[workspace]\n[dependencies]\n'
            f'ironhorse-snapshot = {{ path = {json.dumps(str(snapshot))}, '
            'features = ["unchecked-tooling"] }\n'
            f'ironhorse-vm = {{ path = {json.dumps(str(engine / "ironhorse-vm"))} }}\n'
            '[features]\ndefault = ["consensus"]\nconsensus = ["ironhorse-vm/consensus"]\n'
            + "".join(
                f'[[test]]\nname = "{name}"\npath = {json.dumps(str(engine / path))}\n'
                for name, path in TESTS
            ),
            encoding="utf-8",
        )
        files = root / "scratch"
        files.mkdir()
        # Retain the workspace's resolved dependency versions. Cargo updates
        # only this disposable copy for the small harness dependency graph.
        shutil.copyfile(engine / "Cargo.lock", root / "Cargo.lock")
        runner = root / "run.cjs"
        runner.write_text(
            "const { WASI } = require('node:wasi');\n"
            "const fs = require('node:fs');\n"
            "const wasi = new WASI({version: 'preview1', args: process.argv.slice(2), "
            "env: {...process.env, IRONHORSE_TEST_SCRATCH: '/scratch'}, "
            "preopens: {'/scratch': process.env.SNAPSHOT_WASI_SCRATCH}});\n"
            "(async () => {\n"
            "  const module = await WebAssembly.compile(fs.readFileSync(process.argv[2]));\n"
            "  const instance = await WebAssembly.instantiate(module, "
            "{wasi_snapshot_preview1: wasi.wasiImport});\n"
            "  wasi.start(instance);\n"
            "})();\n",
            encoding="utf-8",
        )
        subprocess.run(
            [
                "cargo", f"+{args.toolchain}", "test",
                "--manifest-path", str(manifest),
                "--target", "wasm32-wasip1",
                "--target-dir", str(engine / "target"),
                "--config", "target.wasm32-wasip1.runner=" + json.dumps(["node", str(runner)]),
                "--", "--test-threads=1",
            ],
            check=True,
            env=dict(os.environ, SNAPSHOT_WASI_SCRATCH=str(files)),
        )


if __name__ == "__main__":
    main()
