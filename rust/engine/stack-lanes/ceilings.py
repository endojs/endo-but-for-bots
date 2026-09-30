#!/usr/bin/env python3
"""Derive and verify the native ceilings recorded in cases.rs.

For every heavy family, walker and chain the corpus knows, find the largest
depth the native probe accepts (a run that returns; a compile that is accepted)
and compare it with the ceiling cases.rs records. `--check` (the default) fails
on any difference, so the recorded ceilings are always the measured ones;
`--table` prints the measured table in cases.rs's form for pasting.

The search assumes acceptance is monotone in the depth, which holds for these
shapes: each adds one charged level or one tree level.
"""
import argparse
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import common  # noqa: E402

CASES_RS = common.LANES / "cases.rs"
KINDS = {"heavy": "HEAVY", "walker": "WALKERS", "chain": "CHAINS"}
MAX_DEPTH = 1 << 15


def recorded(kind):
    """The (name, ceiling) table cases.rs records for a kind."""
    text = CASES_RS.read_text()
    block = re.search(rf"pub const {KINDS[kind]}: &\[\(&str, usize\)\] = &\[(.*?)\];", text, re.S)
    if not block:
        raise SystemExit(f"cases.rs has no {KINDS[kind]} table")
    return [(m.group(1), int(m.group(2))) for m in re.finditer(r'\("([^"]+)", (\d+)\)', block.group(1))]


def accepted(probe, kind, name, n):
    """Whether the family at depth n is accepted natively: returns, or compiles."""
    outcome = common.run_native(probe, ["family", kind, name, str(n)])
    if outcome.timed_out:
        raise SystemExit(f"{kind} {name} at {n} timed out")
    if outcome.trapped:
        raise SystemExit(f"{kind} {name} at {n} overflowed the native stack: {outcome.trap}")
    line = outcome.line or ""
    if kind == "chain":
        return line.startswith("compile=ok")
    return line.startswith("halt=Return ")


def halt_at(probe, kind, name, n):
    return (common.run_native(probe, ["family", kind, name, str(n)]).line or "")[:60]


def ceiling(probe, kind, name, hint):
    """Largest accepted depth: exponential search from the hint, then bisection."""
    if not accepted(probe, kind, name, 1):
        return 0
    low = 1  # accepted
    high = None  # rejected
    step = max(hint, 1)
    while high is None:
        if step > MAX_DEPTH:
            raise SystemExit(f"{kind} {name}: still accepted at {MAX_DEPTH}; no ceiling")
        if accepted(probe, kind, name, step):
            low = step
            step *= 2
        else:
            high = step
    while high - low > 1:
        mid = (low + high) // 2
        if accepted(probe, kind, name, mid):
            low = mid
        else:
            high = mid
    return low


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=sorted(KINDS), action="append")
    parser.add_argument("--name", action="append")
    parser.add_argument("--table", action="store_true", help="print the measured tables")
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()
    probe = build_probe.artifact() if args.no_build else build_probe.build(quiet=True)
    problems = []
    for kind in args.kind or sorted(KINDS):
        measured = []
        for name, hint in recorded(kind):
            if args.name and name not in args.name:
                continue
            found = ceiling(probe, kind, name, hint)
            measured.append((name, found))
            mark = "" if found == hint else f"  (recorded {hint})"
            print(f"{kind:6s} {name:22s} ceiling {found:6d}  past: {halt_at(probe, kind, name, found + 1)}{mark}",
                  flush=True)
            if found != hint:
                problems.append(f"{kind} {name}: measured {found}, cases.rs records {hint}")
        if args.table:
            print(f"pub const {KINDS[kind]}: &[(&str, usize)] = &[")
            for name, found in measured:
                print(f'    ("{name}", {found}),')
            print("];")
    for problem in problems:
        print(f"FAIL: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
