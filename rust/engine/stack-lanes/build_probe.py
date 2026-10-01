#!/usr/bin/env python3
"""Build the stack-lanes probe for the host and for wasm32-wasip1.

The wasm build is the verified workaround of WASM-BLOCKERS.md B1: the engine
needs panic=unwind, which stable Rust cannot link on wasm, so std is rebuilt
with unwinding under RUSTC_BOOTSTRAP. It emits the standard exnref exception
encoding (B2), which Wasmtime requires and V8 accepts behind a flag, links the
shadow stack STACK-DEPTH-REFACTOR.md §5 lane A asks for (4 MiB by default),
and exports __stack_pointer so a host can paint the shadow stack.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "stack-lanes/probe"
WASM_TARGET = "wasm32-wasip1"
DEFAULT_SHADOW_STACK = 4 * 1024 * 1024


def artifact(target=None):
    if target is None:
        return PROBE / "target/release/ih-stack-probe"
    return PROBE / "target" / target / "release/ih-stack-probe.wasm"


def wasm_rustflags(shadow_stack):
    return " ".join([
        "-C panic=unwind",
        "-C target-feature=+exception-handling",
        "-C llvm-args=-wasm-use-legacy-eh=false",
        f"-C link-arg=-zstack-size={shadow_stack}",
        "-C link-arg=--export=__stack_pointer",
    ])


def build(target=None, shadow_stack=DEFAULT_SHADOW_STACK, quiet=False):
    """Build one probe and return its path. The workspace lockfile pins every
    dependency; cargo adds only the probe's own entry to the copy."""
    shutil.copyfile(ROOT / "Cargo.lock", PROBE / "Cargo.lock")
    # The artifact is looked for under the probe's own target directory, so
    # an inherited CARGO_TARGET_DIR must not send the build elsewhere.
    env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_TARGET_DIR=str(PROBE / "target"))
    command = ["cargo", "build", "--release"]
    if target == WASM_TARGET:
        env["RUSTC_BOOTSTRAP"] = "1"
        env["RUSTFLAGS"] = wasm_rustflags(shadow_stack)
        command += ["-Zbuild-std=std,panic_unwind", "--target", WASM_TARGET]
    elif target is not None:
        raise ValueError(f"unsupported target: {target}")
    if quiet:
        command.append("--quiet")
    subprocess.run(command, cwd=PROBE, env=env, check=True)
    path = artifact(target)
    if not path.exists():
        raise SystemExit(f"build produced no artifact at {path}")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-only", action="store_true")
    parser.add_argument("--wasm-only", action="store_true")
    parser.add_argument("--shadow-stack", type=int, default=DEFAULT_SHADOW_STACK,
                        help="wasm shadow stack in bytes (default %(default)s)")
    args = parser.parse_args()
    if not args.wasm_only:
        print(build())
    if not args.native_only:
        print(build(WASM_TARGET, args.shadow_stack))


if __name__ == "__main__":
    main()
