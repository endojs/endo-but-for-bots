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
import statistics
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("dispatch_bench", "reentry_bench", "attached_bench", "gc_bench", "wake_latency_bench")
# Process runs per target and side. One run's median moves between runs of one binary
# on a shared host by more than the 1.25x floor, most of all for the short GC, slide,
# placeholder, attached-store and wake timings, so every metric is its median across
# three runs, and a check alternates the reference and candidate runs (`measure`).
RUNS = 3


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
    for key in ("platform", "machine", "cpu", "rustc", "fixture_sha256", "build_environment", "runs"):
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


def median_across_runs(runs):
    """Each metric's median across the process runs that reported it."""
    names = sorted({name for run in runs for name in run})
    return {name: statistics.median(run[name] for run in runs if name in run) for name in names}


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


def build_environment():
    return {name: os.environ.get(name) for name in
            ("CARGO_INCREMENTAL", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
             "RUST_MIN_STACK", "RUSTUP_TOOLCHAIN", "CARGO_BUILD_TARGET")}


def provenance_of(root, commit):
    return {
        "commit": commit,
        "rustc": subprocess.check_output(["rustc", "--version"], cwd=root, text=True).strip(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu": platform.processor(),
        "fixture_sha256": fixture_digest(root),
        "build_environment": build_environment(),
        "runs": RUNS,
    }


def cargo_test(root, env, *arguments):
    return subprocess.run(
        ["cargo", "test", "--locked", "--release", "-p", "ironhorse-snapshot", *arguments],
        cwd=root, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def build(root, env):
    """Build every target before anything is timed, so no compile overlaps a measurement."""
    tests = [argument for target in TARGETS for argument in ("--test", target)]
    result = cargo_test(root, env, *tests, "--no-run")
    if result.returncode:
        print(result.stdout, end="", flush=True)
    return result.returncode == 0


def measure(sides):
    """Run every target RUNS times on each side and keep each metric's median.

    Each round runs one target on every side, alternating which side goes first, so load
    that changes during a check moves both sides alike; measuring one side whole and then
    the other put the halves minutes apart. Returns each side's medians and the failures.
    """
    runs = {label: {} for label in sides}
    failures = []
    for target in TARGETS:
        for index in range(RUNS):
            order = list(sides) if index % 2 == 0 else list(reversed(sides))
            for label in order:
                root, env = sides[label]
                result = cargo_test(root, env, "--test", target,
                                    "--", "--ignored", "--nocapture", "--test-threads=1")
                print(result.stdout, end="", flush=True)
                run = read_metrics(result.stdout)
                earlier = runs[label].setdefault(target, [])
                if result.returncode or not run:
                    failures.append(f"{label} {target} run {index + 1}: "
                                    f"exit={result.returncode}, metrics={len(run)}")
                elif earlier and run.keys() != earlier[0].keys():
                    failures.append(f"{label} {target} run {index + 1}: metric roster differs")
                earlier.append(run)
    medians = {}
    for label, targets in runs.items():
        medians[label] = {}
        for target_runs in targets.values():
            samples = median_across_runs(target_runs)
            if medians[label].keys() & samples.keys():
                raise ValueError("duplicate metrics across targets")
            medians[label].update(samples)
    return medians, failures


def prepare_reference(revision, temp):
    """The pinned revision with today's fixtures, benches and toolchain pin copied in."""
    archive = subprocess.check_output(["git", "archive", revision], cwd=ROOT.parents[1])
    subprocess.run(["tar", "-xf", "-", "-C", str(temp)], input=archive, check=True)
    ref_engine = temp / "rust/engine"
    shutil.copy2(ROOT / "rust-toolchain.toml", ref_engine / "rust-toolchain.toml")
    for target in TARGETS:
        shutil.copy2(ROOT / f"ironhorse-snapshot/tests/{target}.rs",
                     ref_engine / f"ironhorse-snapshot/tests/{target}.rs")
    shutil.copytree(ROOT / "ironhorse-snapshot/tests/bench_support",
                    ref_engine / "ironhorse-snapshot/tests/bench_support", dirs_exist_ok=True)
    shutil.copytree(ROOT / "benches", ref_engine / "benches", dirs_exist_ok=True)
    return ref_engine


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
    candidate_commit = (os.environ.get("IRONHORSE_REFERENCE_COMMIT")
                        or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip())
    env = os.environ.copy()
    reference_provenance = None
    reference_medians = None if baseline is None else baseline["medians"]
    failures = []
    metrics = {}
    with tempfile.TemporaryDirectory(prefix="ironhorse-reference-") as temp:
        sides = {"candidate": (ROOT, env)}
        if args.reference_baseline or args.check_baseline:
            if baseline is None:
                parser.error("--reference-baseline requires an existing baseline")
            # Use the same fixtures and compiler on both revisions. Absolute timings
            # committed on another CPU are useful provenance, not a portable CI gate.
            revision = baseline["provenance"]["commit"]
            ref_engine = prepare_reference(revision, Path(temp))
            # Keep archived-reference builds isolated from an inherited target
            # directory while retaining the same compilation settings.
            reference_env = dict(env, CARGO_TARGET_DIR=str(Path(temp) / "target"))
            if build(ref_engine, reference_env):
                sides["reference"] = (ref_engine, reference_env)
                reference_provenance = provenance_of(ref_engine, revision)
            else:
                failures.append(f"reference {revision} cannot build today's fixtures; "
                                "re-pin baseline.json (benches/README.md)")
        elif baseline is not None:
            # Without a remeasured reference, the fixtures print ratios against the
            # committed medians, which may come from another host.
            env.update({f"IRONHORSE_BASELINE_{name}": str(value) for name, value in baseline["medians"].items()})
        if not build(ROOT, env):
            failures.append("candidate cannot build the fixtures")
        if not failures:
            measured, measure_failures = measure(sides)
            failures.extend(measure_failures)
            metrics = measured["candidate"]
            if "reference" in measured:
                reference_medians = measured["reference"]
                failures.extend(compare(reference_medians, baseline["medians"], float("inf")))
    provenance = provenance_of(ROOT, candidate_commit)
    if args.check_baseline and reference_provenance is not None:
        try:
            validate_reference(reference_provenance, provenance)
        except ValueError as error:
            failures.append(str(error))
        else:
            failures.extend(compare(metrics, reference_medians, maximum))
            for name in sorted(reference_medians):
                if name in metrics:
                    print(f"BENCH_CHECK {name} reference={reference_medians[name]:.6f} "
                          f"candidate={metrics[name]:.6f} ratio={metrics[name] / reference_medians[name]:.3f}")
    report = {"provenance": provenance, "medians": metrics, "maximum_ratio": maximum, "failures": failures, "reference_provenance": reference_provenance,
              "reference_medians": reference_medians,
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
