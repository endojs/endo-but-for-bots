#!/usr/bin/env python3
"""Measure the XS microbenchmark slice; the full stage-8 envelope remains separate."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess

from code_size import measure as code_size_report

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ("parse", "properties", "calls", "allocation_churn", "strings")

# The design's heap bar. Reported, not gated — see `summarize_footprint`.
HEAP_LIMIT = 1.1


def summarize(output):
    samples = {}
    for line in output.splitlines():
        if not line.startswith("XS_SAMPLES "):
            continue
        match = re.fullmatch(r"XS_SAMPLES (\w+) xs=(\[.*?\]) ironhorse=(\[.*?\])", line)
        if not match:
            raise ValueError("malformed XS samples")
        name, xs, ironhorse = match.groups()
        if name not in FIXTURES or name in samples:
            raise ValueError(f"unexpected or duplicate fixture: {name}")
        arms = {"xs": json.loads(xs), "ironhorse": json.loads(ironhorse)}
        for values in arms.values():
            if len(values) != 7 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                                      or not math.isfinite(v) or v <= 0 for v in values):
                raise ValueError(f"invalid samples: {name}")
        ratio = statistics.median(arms["ironhorse"]) / statistics.median(arms["xs"])
        if not math.isfinite(ratio) or ratio <= 0:
            raise ValueError(f"invalid ratio: {name}")
        samples[name] = {"phase": "compile" if name == "parse" else "execute",
                         "samples_ns": arms, "ratio": ratio}
    if set(samples) != set(FIXTURES):
        raise ValueError("incomplete XS fixture roster")
    geometric_mean = math.exp(sum(math.log(s["ratio"]) for s in samples.values()) / len(samples))
    return {"fixtures": samples, "geometric_mean": geometric_mean,
            "maximum_ratio": 2.0, "within_microbenchmark_limit": geometric_mean <= 2.0}


def summarize_footprint(output):
    """Parse the footprint benchmark's lines, if the run carried them.

    The heap half of the envelope's footprint bar has an XS side for the
    first time (the oracle shim reports `currentHeapCount` and
    `currentChunksSize`), so this clause stops being listed as unmeasured.
    Two ratios per fixture: `accounted` reads the bar as the design writes
    it, in XS's own 32-byte slot unit, and `resident` is what the process
    actually holds — the number the design's "identical by construction"
    parenthesis assumed away.
    """
    fixtures = {}
    for line in output.splitlines():
        match = re.fullmatch(
            r"XS_FOOTPRINT (\w+) xs_bytes=(\d+) ironhorse_xs_accounted_bytes=(\d+) "
            r"ironhorse_resident_bytes=(\d+) accounted_ratio=([\d.]+) resident_ratio=([\d.]+)",
            line,
        )
        if not match:
            continue
        name, xs_bytes, accounted, resident, accounted_ratio, resident_ratio = match.groups()
        if name in fixtures:
            raise ValueError(f"duplicate footprint fixture: {name}")
        fixtures[name] = {
            "xs_bytes": int(xs_bytes),
            "ironhorse_xs_accounted_bytes": int(accounted),
            "ironhorse_resident_bytes": int(resident),
            "accounted_ratio": float(accounted_ratio),
            "resident_ratio": float(resident_ratio),
        }
    if not fixtures:
        return None
    worst = max(f["accounted_ratio"] for f in fixtures.values())
    return {
        "fixtures": fixtures,
        "worst_accounted_ratio": worst,
        "limit": HEAP_LIMIT,
        "within_heap_limit": worst <= HEAP_LIMIT,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "xs-microbenchmarks.json")
    parser.add_argument("--check-micro", action="store_true",
                        help="fail if the measured microbenchmark slice exceeds 2.0x")
    args = parser.parse_args()
    command = ["cargo", "test", "--locked", "--release", "-p", "ironhorse-262",
               "--test", "xs_performance_bench", "--", "--ignored", "--nocapture", "--test-threads=1"]
    result = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False)
    print(result.stdout, end="", flush=True)
    failures = []
    # The code-size half of the envelope's footprint bar is measured here
    # rather than listed as unmeasured (F106/F122). It is a static
    # measurement, so it does not need the benchmark run; a tree without a
    # release build reports why instead of dropping the clause.
    try:
        code_size = code_size_report()
    except (OSError, ValueError) as error:
        code_size = {"unavailable": str(error)}
    # The footprint benchmark runs alongside the throughput one, so its
    # lines arrive in the same output.
    footprint = subprocess.run(
        ["cargo", "test", "--locked", "--release", "-p", "ironhorse-262",
         "--test", "xs_footprint_bench", "--", "--ignored", "--nocapture",
         "--test-threads=1"],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        check=False,
    )
    heap = summarize_footprint(footprint.stdout)
    unmeasured = ["four-variant daemon benchmark"]
    if heap is None:
        unmeasured.append("comparable heap footprint")
    if "unavailable" in code_size:
        unmeasured.append("engine code size")
    report = {"stage8_envelope": "unavailable",
              "unmeasured": unmeasured,
              "code_size": code_size,
              "heap_footprint": heap,
              "command": command, "log": result.stdout}
    try:
        report.update(summarize(result.stdout))
    except ValueError as error:
        failures.append(str(error))
    if result.returncode:
        failures.append(f"benchmark exit={result.returncode}")
    if args.check_micro and report.get("within_microbenchmark_limit") is False:
        failures.append("XS microbenchmark geometric mean exceeds 2.0x")
    # Reported, NOT gated. The measurement is new and the engine is a long
    # way outside the bar; turning it into a failure today would make every
    # run red without telling anyone anything the number does not already
    # say. `code_size.py --check-code-size` is the gate, for when the bar is
    # something the tree can hold.
    if heap is not None and not heap["within_heap_limit"]:
        report["heap_footprint_note"] = (
            f"worst heap ratio is {heap['worst_accounted_ratio']:.2f}x XS, above "
            f"the design's {HEAP_LIMIT}x bar: reported, not gated"
        )
    if code_size.get("within_code_size_limit") is False:
        report["code_size_note"] = (
            f"engine code size is {code_size['ratio']:.2f}x XS, above the "
            f"design's {code_size['limit']}x bar: reported, not gated"
        )
    files = ["ironhorse-262/tests/xs_performance_bench.rs", "xs-oracle/csrc/xs_shim.c",
             "xs-oracle/src/lib.rs", "xs-oracle/build.rs", "rust-toolchain.toml", "Cargo.lock"]
    report["provenance"] = {
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "xs_commit": subprocess.check_output(["git", "-C", "c/moddable", "rev-parse", "HEAD"],
                                               cwd=ROOT.parents[1], text=True).strip(),
        "rustc": subprocess.check_output(["rustc", "--version"], cwd=ROOT, text=True).strip(),
        "platform": platform.platform(),
        "source_sha256": {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in files},
        "environment": {key: os.environ.get(key) for key in
                        ("CC", "CFLAGS", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_INCREMENTAL", "RUST_MIN_STACK")},
    }
    report["failures"] = failures
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
