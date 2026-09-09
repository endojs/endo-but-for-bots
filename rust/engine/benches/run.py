#!/usr/bin/env python3
"""Run the release benchmark corpus serially and compare measured medians."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("dispatch_bench", "attached_bench", "gc_bench", "wake_latency_bench")


def fixture_digest(root=ROOT):
    """Identify the exact common fixtures measured on both revisions."""
    files = [root / f"ironhorse-snapshot/tests/{target}.rs" for target in TARGETS]
    files += sorted((root / "ironhorse-snapshot/tests/bench_support").rglob("*.rs"))
    files += [root / "rust-toolchain.toml"]
    digest = hashlib.sha256()
    for path in sorted(files):
        name = path.relative_to(root).as_posix().encode()
        content = path.read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def validate_reference(reference, candidate):
    """A portable ratio requires common fixtures and measurement environment."""
    for key in ("platform", "machine", "cpu", "rustc", "fixture_sha256", "build_environment"):
        if key not in reference or key not in candidate or reference[key] != candidate[key]:
            raise ValueError(f"reference provenance differs: {key}")


def read_metrics(output):
    metrics = {}
    for line in output.splitlines():
        if not line.startswith("BENCH_METRIC "):
            continue
        _, name, raw = line.split()
        value = float(raw)
        if name in metrics or not math.isfinite(value) or value <= 0:
            raise ValueError(f"duplicate or invalid metric: {name}")
        metrics[name] = value
    return metrics


def compare(actual, baseline, maximum):
    problems = []
    if actual.keys() != baseline.keys():
        problems.append(f"metric roster differs: missing={sorted(baseline.keys() - actual.keys())}, unexpected={sorted(actual.keys() - baseline.keys())}")
    for name, value in baseline.items():
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"invalid baseline: {name}")
        if name in actual and actual[name] / value > maximum:
            problems.append(f"{name}: {actual[name] / value:.3f}x > {maximum:.3f}x")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=ROOT / "benches/baseline.json")
    parser.add_argument("--output", type=Path, default=ROOT / "benchmark-report.json")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-baseline", action="store_true")
    mode.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--reference-baseline", action="store_true",
                        help="remeasure the pinned revision on this host (automatic with --check-baseline)")
    args = parser.parse_args()
    baseline = None if args.write_baseline else json.loads(args.baseline.read_text())
    maximum = 1.25 if baseline is None else baseline["maximum_ratio"]
    if isinstance(maximum, bool) or not isinstance(maximum, (float, int)) or not math.isfinite(maximum) or maximum < 1:
        parser.error("invalid maximum_ratio")
    if baseline is not None:
        compare({}, baseline["medians"], maximum)
    reference_provenance = None
    if args.reference_baseline or args.check_baseline:
        if baseline is None:
            parser.error("--reference-baseline requires an existing baseline")
        # Use the same fixtures and compiler on both revisions. Absolute timings
        # committed on another CPU are useful provenance, not a portable CI gate.
        with tempfile.TemporaryDirectory(prefix="ironhorse-reference-") as temp:
            reference = Path(temp)
            revision = baseline["provenance"]["commit"]
            archive = subprocess.check_output(["git", "archive", revision], cwd=ROOT.parents[1])
            subprocess.run(["tar", "-xf", "-", "-C", temp], input=archive, check=True)
            ref_engine = reference / "rust/engine"
            shutil.copy2(ROOT / "rust-toolchain.toml", ref_engine / "rust-toolchain.toml")
            for target in TARGETS:
                shutil.copy2(ROOT / f"ironhorse-snapshot/tests/{target}.rs",
                             ref_engine / f"ironhorse-snapshot/tests/{target}.rs")
            shutil.copytree(ROOT / "ironhorse-snapshot/tests/bench_support",
                            ref_engine / "ironhorse-snapshot/tests/bench_support", dirs_exist_ok=True)
            shutil.copytree(ROOT / "benches", ref_engine / "benches", dirs_exist_ok=True)
            reference_report = reference / "report.json"
            reference_env = os.environ.copy()
            reference_env["IRONHORSE_REFERENCE_COMMIT"] = revision
            # Keep archived-reference builds isolated from an inherited target
            # directory while retaining the same compilation settings.
            reference_env["CARGO_TARGET_DIR"] = str(reference / "target")
            subprocess.run([sys.executable, str(ref_engine / "benches/run.py"),
                            "--write-baseline", "--output", str(reference_report)],
                           check=True, env=reference_env)
            measured_reference = json.loads(reference_report.read_text())
            roster_errors = compare(measured_reference["medians"], baseline["medians"], float("inf"))
            if roster_errors:
                raise ValueError(roster_errors)
            baseline["medians"] = measured_reference["medians"]
            reference_provenance = measured_reference["provenance"]
    env = os.environ.copy()
    if baseline is not None:
        compare({}, baseline["medians"], baseline["maximum_ratio"])
        env.update({f"IRONHORSE_BASELINE_{name}": str(value) for name, value in baseline["medians"].items()})
    metrics = {}
    failures = []
    for target in TARGETS:
        result = subprocess.run(
            ["cargo", "test", "--locked", "--release", "-p", "ironhorse-snapshot", "--test", target,
             "--", "--ignored", "--nocapture", "--test-threads=1"],
            cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        print(result.stdout, end="", flush=True)
        samples = read_metrics(result.stdout)
        if metrics.keys() & samples.keys():
            raise ValueError("duplicate metrics across targets")
        metrics.update(samples)
        if result.returncode or not samples:
            failures.append(f"{target}: exit={result.returncode}, metrics={len(samples)}")
    provenance = {
        "commit": os.environ.get("IRONHORSE_REFERENCE_COMMIT") or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "rustc": subprocess.check_output(["rustc", "--version"], cwd=ROOT, text=True).strip(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu": platform.processor(),
        "fixture_sha256": fixture_digest(),
        "build_environment": {name: os.environ.get(name) for name in
                              ("CARGO_INCREMENTAL", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
                               "RUST_MIN_STACK", "RUSTUP_TOOLCHAIN", "CARGO_BUILD_TARGET")},
    }
    if args.check_baseline:
        try:
            validate_reference(reference_provenance, provenance)
        except ValueError as error:
            failures.append(str(error))
        else:
            failures.extend(compare(metrics, baseline["medians"], maximum))
    report = {"provenance": provenance, "medians": metrics, "maximum_ratio": maximum, "failures": failures, "reference_provenance": reference_provenance,
              "reference_medians": None if baseline is None else baseline["medians"],
              "comparison_kind": "same-host-reference" if reference_provenance else "historical-context-only"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    if args.write_baseline and not failures:
        args.baseline.write_text(json.dumps(report, indent=2) + "\n")
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
