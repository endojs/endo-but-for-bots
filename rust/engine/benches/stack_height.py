#!/usr/bin/env python3
"""Measure native stack high-water marks and gate them against a baseline.

Runs `ironhorse-vm/tests/stack_height.rs` in release mode, parses its
`STACK_METRIC` lines and compares each case against `stack-height-baseline.json`.
A case fails the check when it uses more stack than the baseline allows or
when its outcome (completed, ReentryLimit, ...) changes. The marks are
deterministic for one compiler, target and profile, so the baseline records
that provenance and the check refuses a mismatch unless told otherwise.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "benches/stack-height-baseline.json"
DEFAULT_SLACK = 0.02
PROVENANCE_KEYS = ("target", "rustc", "profile")


def parse_metrics(output):
    """`STACK_METRIC <case>.<stage> <bytes> <outcome> [result=...]` lines to a dict."""
    metrics = {}
    for line in output.splitlines():
        if not line.startswith("STACK_METRIC "):
            continue
        fields = line.split(maxsplit=4)
        if len(fields) < 4:
            raise ValueError(f"malformed metric line: {line!r}")
        _, name, raw, outcome = fields[:4]
        value = int(raw)
        if name in metrics or value < 0:
            raise ValueError(f"duplicate or invalid metric: {name}")
        metrics[name] = {"bytes": value, "outcome": outcome}
    return metrics


def compare(actual, baseline, slack):
    """Problems (a list of strings) and notes for cases well under the baseline."""
    problems = []
    notes = []
    if actual.keys() != baseline.keys():
        missing = sorted(baseline.keys() - actual.keys())
        unexpected = sorted(actual.keys() - baseline.keys())
        problems.append(f"case roster differs: missing={missing}, unexpected={unexpected}")
    for name, expected in baseline.items():
        if name not in actual:
            continue
        limit = int(expected["bytes"] * (1 + slack))
        measured = actual[name]
        if measured["outcome"] != expected["outcome"]:
            problems.append(
                f"{name}: outcome {measured['outcome']} (baseline {expected['outcome']})"
            )
        if measured["bytes"] > limit:
            problems.append(
                f"{name}: {measured['bytes']} B > {limit} B "
                f"({measured['bytes'] / expected['bytes']:.3f}x of baseline {expected['bytes']} B)"
            )
        elif expected["bytes"] and measured["bytes"] < expected["bytes"] * (1 - slack):
            notes.append(
                f"{name}: {measured['bytes']} B, {measured['bytes'] / expected['bytes']:.3f}x of "
                f"baseline {expected['bytes']} B; lower the baseline with --write-baseline"
            )
    return problems, notes


def validate_provenance(reference, candidate):
    for key in PROVENANCE_KEYS:
        if reference.get(key) != candidate.get(key):
            raise ValueError(
                f"baseline provenance differs: {key} is {candidate.get(key)!r}, "
                f"baseline has {reference.get(key)!r}"
            )


def provenance():
    verbose = subprocess.check_output(["rustc", "-vV"], cwd=ROOT, text=True)
    host = next(line.split(": ", 1)[1] for line in verbose.splitlines() if line.startswith("host: "))
    return {
        "target": host,
        "rustc": verbose.splitlines()[0].strip(),
        "profile": "release",
        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
    }


def measure():
    env = dict(os.environ, CARGO_INCREMENTAL="0")
    result = subprocess.run(
        ["cargo", "test", "--locked", "--release", "-p", "ironhorse-vm", "--test", "stack_height",
         "--", "--ignored", "--nocapture", "--test-threads=1"],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    print(result.stdout, end="", flush=True)
    if result.returncode:
        raise SystemExit(f"stack_height failed: exit={result.returncode}")
    metrics = parse_metrics(result.stdout)
    if not metrics:
        raise SystemExit("stack_height printed no STACK_METRIC lines")
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--output", type=Path, help="write the measurements and comparison as JSON")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="compare against the baseline (default)")
    mode.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--slack", type=float, help="allowed growth over the baseline (default: the baseline's)")
    parser.add_argument("--ignore-provenance", action="store_true",
                        help="compare even when compiler, target or profile differ from the baseline")
    args = parser.parse_args()

    current = provenance()
    metrics = measure()
    report = {"provenance": current, "cases": metrics}

    if args.write_baseline:
        baseline = {
            "provenance": current,
            "slack": DEFAULT_SLACK if args.slack is None else args.slack,
            "cases": metrics,
        }
        args.baseline.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"wrote {args.baseline} ({len(metrics)} cases)")
        if args.output:
            args.output.write_text(json.dumps(report, indent=2) + "\n")
        return 0

    baseline = json.loads(args.baseline.read_text())
    slack = baseline["slack"] if args.slack is None else args.slack
    if not args.ignore_provenance:
        validate_provenance(baseline["provenance"], current)
    problems, notes = compare(metrics, baseline["cases"], slack)
    report.update({"baseline": baseline["provenance"], "slack": slack,
                   "problems": problems, "notes": notes})
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    width = max(len(name) for name in metrics)
    for name in sorted(metrics):
        measured = metrics[name]
        expected = baseline["cases"].get(name)
        ratio = f"{measured['bytes'] / expected['bytes']:.3f}x" if expected and expected["bytes"] else "new"
        print(f"{name:{width}s} {measured['bytes']:>9d} B  {ratio:>7s}  {measured['outcome']}")
    for note in notes:
        print(f"note: {note}")
    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        return 1
    print(f"stack height: {len(metrics)} cases within {slack:.0%} of the baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
