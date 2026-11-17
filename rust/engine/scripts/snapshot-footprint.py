#!/usr/bin/env python3
"""Measure what a whole-heap snapshot and a per-crank checkpoint add to a
running machine's memory, natively and on wasm32 (WASM-BLOCKERS.md B7 and B8).

Builds `ironhorse-snapshot/footprint` (a standalone cargo root, like the
stack-lanes probe) for the host and, with the B1 unwinding workaround, for
wasm32-wasip1, then runs each case on both and prints one line per stage:
`FOOTPRINT stage=... memory=... peak=...` (bytes). Natively `memory` is the
resident set size and `peak` its high-water mark (`VmRSS`/`VmHWM`); on wasm32
both are `memory.size`, which never shrinks. The cases are the audit's:

  map        16,000,000 Map entries, whose container is 640 MB
  strings    125,000 strings of 1,000 units, a 254 MB container
  map1m      1,000,000 Map entries, for the throughput ratio
  array-ckpt checkpoint_to_store after a crank on 500,000 kept array items
  map-ckpt   checkpoint_to_store after a crank on 500,000 Map entries

Requires the pinned Rust with `rust-src` and `wasm32-wasip1` (see
stack-lanes/README.md) and the Wasmtime CLI (`$WASMTIME`, else `wasmtime`).

    python3 rust/engine/scripts/snapshot-footprint.py --native-only
    python3 rust/engine/scripts/snapshot-footprint.py --case strings --case map1m
"""
import argparse
import os
import pathlib
import shutil
import subprocess
import sys

ENGINE = pathlib.Path(__file__).resolve().parent.parent
HARNESS = ENGINE / "ironhorse-snapshot/footprint"
WASM_TARGET = "wasm32-wasip1"
TOOLCHAIN = "1.91.1"

CASES = {
    "map": ["snapshot", "map", "count=16000000"],
    "strings": ["snapshot", "strings", "count=125000", "units=1000"],
    "map1m": ["snapshot", "map", "count=1000000"],
    "array-ckpt": ["checkpoint", "array", "count=500000", "crank=a[0]=1;0"],
    "map-ckpt": ["checkpoint", "map", "count=500000", "crank=m.set(0,1);0"],
}


def build(target=None):
    """Build the harness and return the artifact. The workspace lockfile pins
    every dependency; cargo adds only the harness's own entry to the copy."""
    shutil.copyfile(ENGINE / "Cargo.lock", HARNESS / "Cargo.lock")
    env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_TARGET_DIR=str(HARNESS / "target"))
    command = ["cargo", f"+{TOOLCHAIN}", "build", "--release"]
    if target == WASM_TARGET:
        # The verified B1 workaround of stack-lanes/build_probe.py: std rebuilt
        # with unwinding, the exnref encoding, a 4 MiB shadow stack.
        env["RUSTC_BOOTSTRAP"] = "1"
        env["RUSTFLAGS"] = " ".join([
            "-C panic=unwind",
            "-C target-feature=+exception-handling",
            "-C llvm-args=-wasm-use-legacy-eh=false",
            "-C link-arg=-zstack-size=4194304",
            "-C link-arg=--export=__stack_pointer",
        ])
        command += ["-Zbuild-std=std,panic_unwind", "--target", WASM_TARGET]
        artifact = HARNESS / "target" / WASM_TARGET / "release/ih-snapshot-footprint.wasm"
    elif target is None:
        artifact = HARNESS / "target/release/ih-snapshot-footprint"
    else:
        raise ValueError(f"unsupported target: {target}")
    subprocess.run(command, cwd=HARNESS, env=env, check=True)
    if not artifact.exists():
        raise SystemExit(f"build produced no artifact at {artifact}")
    return artifact


def run(label, command, timeout):
    print(f"== {label}: {' '.join(str(c) for c in command)}", flush=True)
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    for line in completed.stdout.splitlines():
        if line.startswith("FOOTPRINT"):
            print(line, flush=True)
    if completed.returncode != 0:
        tail = (completed.stderr.strip().splitlines() or ["(no stderr)"])[-3:]
        print(f"exit={completed.returncode}: {' | '.join(tail)}", flush=True)
    return completed.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--native-only", action="store_true")
    parser.add_argument("--wasm-only", action="store_true")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--case", action="append", choices=sorted(CASES), default=None,
                        help="a case to run (default: all)")
    parser.add_argument("--wasmtime", default=os.environ.get("WASMTIME", "wasmtime"))
    parser.add_argument("--timeout", type=int, default=3600, help="seconds per run")
    args = parser.parse_args()
    cases = args.case or list(CASES)
    status = 0
    if not args.wasm_only:
        native = HARNESS / "target/release/ih-snapshot-footprint" if args.no_build else build()
        for case in cases:
            status |= run(f"native {case}", [str(native), *CASES[case]], args.timeout)
    if not args.native_only:
        wasm = (HARNESS / "target" / WASM_TARGET / "release/ih-snapshot-footprint.wasm"
                if args.no_build else build(WASM_TARGET))
        for case in cases:
            command = [args.wasmtime, "run", "-W", "exceptions=y", str(wasm), *CASES[case]]
            status |= run(f"wasm32 {case}", command, args.timeout)
    return 1 if status else 0


if __name__ == "__main__":
    sys.exit(main())
