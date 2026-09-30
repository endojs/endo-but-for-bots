#!/usr/bin/env python3
"""Lane A: the corpus under Wasmtime at a fixed wasm stack, against native.

STACK-DEPTH-REFACTOR.md §5, "CI lane A, gating". Every case runs on the native
probe (the reference, produced in the same job) and on the wasm32-wasip1 probe
under the Wasmtime CLI with `-W max-wasm-stack=N`. The two output lines must be
byte-identical; a Wasmtime trap is allowed only for a case on the expected-trap
list, and that list may only shrink: a listed case that no longer traps fails
the check until it is removed (`--update-expected` removes it).

Start at 2,097,152 B and lower the stack toward 524,288 B as phases land.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import common  # noqa: E402

DEFAULT_STACK = 2 * 1024 * 1024
EXPECTED = common.LANES / "expected-traps/wasmtime.json"
# Its own shard: 50-200 s on wasm (§5).
SLOW_CASES = ("regexp-backtrack",)


def classify(name, native, wasm, expected):
    """One case's verdict: pass, expected-trap, or a failure string."""
    if native.timed_out or wasm.timed_out:
        return f"timeout: native {native.trap}, wasm {wasm.trap}"
    if native.trapped:
        return f"native trapped: {native.trap}"
    if wasm.trapped:
        if name in expected:
            return "expected-trap"
        return f"unexpected trap: {wasm.trap}"
    if name in expected:
        return "listed as an expected trap but passed; remove it from the list (--update-expected)"
    if wasm.line != native.line:
        return f"mismatch: native {native.line!r}, wasm {wasm.line!r}"
    return "pass"


def resolved_by_update(problem, allow_grow):
    """Whether rewriting the expected-trap list answers this problem."""
    verdict = problem.split(": ", 1)[1]
    if "remove it from the list" in verdict:
        return True
    return allow_grow and verdict.startswith("unexpected trap")


def summarize(results):
    """Problems (failures) and the set of cases that trapped, from classify() verdicts."""
    problems = []
    trapped = set()
    for name, verdict in results.items():
        if verdict == "pass":
            continue
        if verdict == "expected-trap":
            trapped.add(name)
            continue
        if verdict.startswith("unexpected trap"):
            trapped.add(name)
        problems.append(f"{name}: {verdict}")
    return problems, trapped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-wasm-stack", type=int, default=DEFAULT_STACK)
    parser.add_argument("--expected", type=Path, default=EXPECTED)
    parser.add_argument("--update-expected", action="store_true",
                        help="rewrite the expected-trap list from this run (it may only shrink unless --allow-grow)")
    parser.add_argument("--allow-grow", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--case", action="append", help="run only these cases")
    parser.add_argument("--shard", choices=("fast", "slow", "all"), default="fast",
                        help="fast: everything but the slow cases; slow: only them")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--wasmtime", default=common.wasmtime_binary())
    args = parser.parse_args()

    if args.no_build:
        native, wasm = build_probe.artifact(), build_probe.artifact(build_probe.WASM_TARGET)
    else:
        native = build_probe.build(quiet=True)
        wasm = build_probe.build(build_probe.WASM_TARGET, quiet=True)
    cases = common.dump_cases(native)
    names = {case["name"] for case in cases}
    for name in args.case or ():
        if name not in names:
            parser.error(f"unknown case: {name}")
    selected = []
    for case in cases:
        slow = case["name"] in SLOW_CASES
        if args.shard == "fast" and slow or args.shard == "slow" and not slow:
            continue
        if args.case and case["name"] not in args.case:
            continue
        selected.append(case)
    if not selected:
        print(f"FAIL: no cases in shard {args.shard}; a lane that runs nothing proves nothing")
        return 1
    listed = common.load_json(args.expected, {"expected_traps": [], "max_wasm_stack": args.max_wasm_stack})
    expected = set(listed["expected_traps"])
    if listed.get("max_wasm_stack") != args.max_wasm_stack:
        if not args.update_expected:
            parser.error(f"{args.expected} was recorded at max_wasm_stack={listed.get('max_wasm_stack')}, "
                         f"not {args.max_wasm_stack}; pass --update-expected to re-record it")
        if args.case or args.shard != "all":
            parser.error("re-recording the list at a new max_wasm_stack needs the whole corpus: "
                         "--shard all and no --case")

    results = {}
    records = {}
    width = max(len(c["name"]) for c in selected)
    for case in selected:
        probe_args = ["case", case["name"]]
        t0 = time.monotonic()
        try:
            ref = common.run_native(native, probe_args)
            wt = common.run_wasmtime(args.wasmtime, wasm, probe_args, args.max_wasm_stack)
        except common.HarnessError as error:
            raise SystemExit(f"lane A cannot run {case['name']}: {error}") from None
        verdict = classify(case["name"], ref, wt, expected)
        results[case["name"]] = verdict
        records[case["name"]] = {"native": ref.as_dict(), "wasmtime": wt.as_dict(), "verdict": verdict,
                                 "seconds": round(time.monotonic() - t0, 3)}
        print(f"{case['name']:{width}s}  {verdict}", flush=True)

    problems, trapped = summarize(results)
    if args.update_expected:
        # Cases outside this run keep their listing; the run decides the rest.
        untested = expected - {case["name"] for case in selected}
        grew = trapped - expected
        if grew and not args.allow_grow:
            problems.append(f"expected-trap list may only shrink; new traps: {sorted(grew)} "
                            f"(--allow-grow to record them)")
        else:
            common.write_json(args.expected, {"max_wasm_stack": args.max_wasm_stack,
                                              "expected_traps": sorted(untested | trapped)})
            print(f"wrote {args.expected} ({len(untested | trapped)} expected traps)")
            problems = [p for p in problems if not resolved_by_update(p, args.allow_grow)]
    if args.output:
        common.write_json(args.output, {"max_wasm_stack": args.max_wasm_stack, "shard": args.shard,
                                        "cases": records, "problems": problems})
    for problem in problems:
        print(f"FAIL: {problem}")
    passed = sum(1 for v in results.values() if v == "pass")
    print(f"lane A: {passed} pass, {len(trapped)} trap ({len(trapped & expected)} expected) of "
          f"{len(results)} at max_wasm_stack={args.max_wasm_stack}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
