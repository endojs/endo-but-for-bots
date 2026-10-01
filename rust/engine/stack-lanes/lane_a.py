#!/usr/bin/env python3
"""Lane A: the corpus under Wasmtime at a fixed wasm stack, against native.

STACK-DEPTH-REFACTOR.md §5, "CI lane A, gating". Every case runs on the native
probe (the reference, produced in the same job) and on the wasm32-wasip1 probe
under the Wasmtime CLI with `-W max-wasm-stack=N`. The two output lines must be
byte-identical; a Wasmtime trap is allowed only for a case on the expected-trap
list, and that list may only shrink: a listed case that no longer traps fails
the check until it is removed (`--update-expected` removes it).

The stack started at 2,097,152 B and is lowered toward 524,288 B as phases land:
Phase 1 of the report took it to 1,048,576 B.
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

DEFAULT_STACK = 1024 * 1024
EXPECTED = common.LANES / "expected-traps/wasmtime.json"


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
    selected = common.select_cases(cases, args.case, args.shard, common.SLOW_CASES)
    if not selected:
        print(f"FAIL: no cases in shard {args.shard}; a lane that runs nothing proves nothing")
        return 1
    config = {"max_wasm_stack": args.max_wasm_stack}
    expected = common.ExpectedTraps(args.expected, config)
    if not expected.config_matches():
        if not args.update_expected:
            parser.error(f"{args.expected} was recorded at {expected.recorded_config}, not {config}; "
                         "pass --update-expected to re-record it")
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
        verdict = common.classify(case["name"], ref, wt, expected.names)
        results[case["name"]] = verdict
        records[case["name"]] = {"native": ref.as_dict(), "wasmtime": wt.as_dict(), "verdict": verdict,
                                 "seconds": round(time.monotonic() - t0, 3)}
        print(f"{case['name']:{width}s}  {verdict}", flush=True)

    problems, trapped, undecided = common.summarize(results)
    if args.update_expected:
        problems, wrote = expected.update([c["name"] for c in selected], trapped, problems,
                                          args.allow_grow, undecided)
        if wrote:
            print(f"wrote {args.expected} ({len(expected.names)} expected traps)")
    if args.output:
        common.write_json(args.output, {"max_wasm_stack": args.max_wasm_stack, "shard": args.shard,
                                        "cases": records, "problems": problems})
    for problem in problems:
        print(f"FAIL: {problem}")
    passed = sum(1 for v in results.values() if v == "pass")
    print(f"lane A: {passed} pass, {len(trapped)} trap ({len(trapped & expected.names)} expected) of "
          f"{len(results)} at max_wasm_stack={args.max_wasm_stack}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
