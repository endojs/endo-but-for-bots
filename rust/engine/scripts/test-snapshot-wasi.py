#!/usr/bin/env python3
"""Run the snapshot's 32-bit overflow tests without compiler dev dependencies.

Requires Node.js with WASI preview1 and a Rust wasm32-wasip1 standard library:
    rustup target add --toolchain 1.91.1 wasm32-wasip1
    python3 rust/engine/scripts/test-snapshot-wasi.py

The ordinary snapshot test graph includes ironhorse-compile, whose required
panic unwinding is unavailable on this target. This temporary standalone test
package uses the production snapshot library and the checked-in test file.
"""

import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", default="1.91.1")
    args = parser.parse_args()
    engine = pathlib.Path(__file__).resolve().parent.parent
    snapshot = engine / "ironhorse-snapshot"
    with tempfile.TemporaryDirectory(prefix="snapshot-wasi-") as scratch:
        root = pathlib.Path(scratch)
        manifest = root / "Cargo.toml"
        manifest.write_text(
            '[package]\nname = "snapshot-wasi-check"\nversion = "0.0.0"\n'
            'edition = "2021"\n[workspace]\n[dependencies]\n'
            f'ironhorse-snapshot = {{ path = {json.dumps(str(snapshot))}, '
            'features = ["unchecked-tooling"] }\n'
            f'ironhorse-vm = {{ path = {json.dumps(str(engine / "ironhorse-vm"))} }}\n'
            '[[test]]\nname = "record_count_overflow"\n'
            f'path = {json.dumps(str(snapshot / "tests/record_count_overflow.rs"))}\n',
            encoding="utf-8",
        )
        # Retain the workspace's resolved dependency versions. Cargo updates
        # only this disposable copy for the small harness dependency graph.
        shutil.copyfile(engine / "Cargo.lock", root / "Cargo.lock")
        runner = root / "run.cjs"
        runner.write_text(
            "const { WASI } = require('node:wasi');\n"
            "const fs = require('node:fs');\n"
            "const wasi = new WASI({version: 'preview1', "
            "args: process.argv.slice(2), env: process.env, preopens: {}});\n"
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
        )


if __name__ == "__main__":
    main()
