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

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ("parse", "properties", "calls", "allocation_churn", "strings")


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
    report = {"stage8_envelope": "unavailable",
              "unmeasured": ["four-variant daemon benchmark", "comparable heap footprint", "engine code size"],
              "command": command, "log": result.stdout}
    try:
        report.update(summarize(result.stdout))
    except ValueError as error:
        failures.append(str(error))
    if result.returncode:
        failures.append(f"benchmark exit={result.returncode}")
    if args.check_micro and report.get("within_microbenchmark_limit") is False:
        failures.append("XS microbenchmark geometric mean exceeds 2.0x")
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
