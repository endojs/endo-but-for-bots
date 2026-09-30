#!/usr/bin/env python3
"""Lane B, Node: the corpus under Node's V8 with each tier pinned, against native.

STACK-DEPTH-REFACTOR.md §5, "CI lane B". The wasm32-wasip1 probe runs under
node:wasi (node/run.cjs) in three configurations:

  425-liftoff   --stack-size=425 --liftoff-only        (500 KiB less the tier-mix
  425-turbofan  --stack-size=425 --no-liftoff           headroom, common.py)
  500-eager     --stack-size=500 --wasm-tiering-budget=2000000000
                --wasm-eager-tier-up-function=<index>, once per function whose
                TurboFan frame exceeds its Liftoff frame (lane C's list)

Each output line must match the native reference byte for byte; a trap is
allowed only for a case on that configuration's expected-trap list, which may
only shrink. With --paint, the shadow stack's high-water mark is recorded for
every case and the run fails when any mark exceeds the linked shadow stack
less a margin.
"""
import argparse
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import common  # noqa: E402

PINNED_STACK = common.lane_b_stack(common.CHROMIUM_WORKER_STACK_KB)
CONFIGS = {
    f"{PINNED_STACK}-liftoff": (f"--stack-size={PINNED_STACK}", "--liftoff-only"),
    f"{PINNED_STACK}-turbofan": (f"--stack-size={PINNED_STACK}", "--no-liftoff"),
    "500-eager": (f"--stack-size={common.CHROMIUM_WORKER_STACK_KB}", "--wasm-tiering-budget=2000000000"),
}
PINNED_CONFIGS = [f"{PINNED_STACK}-liftoff", f"{PINNED_STACK}-turbofan"]
SHADOW_MARGIN = 64 * 1024


def expected_path(config, function=None):
    suffix = f"-fn{function}" if function is not None else ""
    return common.LANES / f"expected-traps/node-{config}{suffix}.json"


def run_config(config, flags, selected, native, wasm, args, function=None):
    """One configuration over the selected cases: verdicts, records and problems."""
    label = config if function is None else f"{config} fn{function}"
    cfg = {"v8_flags": list(flags), "shadow_stack": args.shadow_stack}
    expected = common.ExpectedTraps(expected_path(config, function), cfg)
    if not expected.config_matches():
        if not args.update_expected:
            raise SystemExit(f"{expected.path} was recorded with {expected.recorded_config}, not {cfg}; "
                             "pass --update-expected to re-record it")
        if args.case or args.shard != "all":
            raise SystemExit(f"re-recording {expected.path} under a new configuration needs the whole "
                             "corpus: --shard all and no --case")
    results, records, marks = {}, {}, {}
    width = max(len(c["name"]) for c in selected)
    for case in selected:
        probe_args = ["case", case["name"]]
        t0 = time.monotonic()
        try:
            ref = args.reference[case["name"]]
            host = common.run_node(wasm, probe_args, v8_flags=flags, paint=args.paint)
        except common.HarnessError as error:
            raise SystemExit(f"lane B ({label}) cannot run {case['name']}: {error}") from None
        verdict = common.classify(case["name"], ref, host, expected.names)
        results[case["name"]] = verdict
        records[case["name"]] = {"host": host.as_dict(), "verdict": verdict,
                                 "seconds": round(time.monotonic() - t0, 3)}
        if host.shadow_stack is not None:
            marks[case["name"]] = host.shadow_stack
        if host.shadow_stack_top is not None and host.shadow_stack_top != args.shadow_stack:
            raise SystemExit(f"the probe was linked with a {host.shadow_stack_top} B shadow stack, not "
                             f"{args.shadow_stack}; pass --shadow-stack {host.shadow_stack_top}")
        print(f"{label:22s} {case['name']:{width}s}  {verdict}", flush=True)
    problems, trapped, undecided = common.summarize(results)
    if args.update_expected:
        problems, wrote = expected.update([c["name"] for c in selected], trapped, problems,
                                          args.allow_grow, undecided)
        if wrote:
            print(f"wrote {expected.path} ({len(expected.names)} expected traps)")
    limit = args.shadow_stack - SHADOW_MARGIN
    for name, mark in sorted(marks.items(), key=lambda kv: -kv[1]):
        if mark > limit:
            problems.append(f"{name}: shadow stack {mark} B exceeds the linked {args.shadow_stack} B less "
                            f"the {SHADOW_MARGIN} B margin ({label})")
    passed = sum(1 for v in results.values() if v == "pass")
    print(f"lane B {label}: {passed} pass, {len(trapped)} trap ({len(trapped & expected.names)} expected) "
          f"of {len(results)}" + (f"; shadow stack peak {max(marks.values())} B" if marks else ""))
    return {"config": cfg, "cases": records, "problems": problems, "shadow_stack": marks}, problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", action="append", choices=sorted(CONFIGS),
                        help=f"run only these configurations (default: {' and '.join(PINNED_CONFIGS)})")
    parser.add_argument("--eager-function", action="append", type=int,
                        help="function index for 500-eager (repeatable; from lane C)")
    parser.add_argument("--paint", action="store_true", help="record shadow-stack high-water marks")
    parser.add_argument("--shadow-stack", type=int, default=build_probe.DEFAULT_SHADOW_STACK,
                        help="the shadow stack the probe was linked with (bytes)")
    parser.add_argument("--update-expected", action="store_true")
    parser.add_argument("--allow-grow", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--case", action="append")
    parser.add_argument("--shard", choices=("fast", "slow", "all"), default="fast")
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()

    configs = args.config or PINNED_CONFIGS
    if "500-eager" in configs and not args.eager_function:
        parser.error("500-eager needs --eager-function <index> (from lane C's frame report)")
    if args.no_build:
        native, wasm = build_probe.artifact(), build_probe.artifact(build_probe.WASM_TARGET)
    else:
        native = build_probe.build(quiet=True)
        wasm = build_probe.build(build_probe.WASM_TARGET, args.shadow_stack, quiet=True)
    cases = common.dump_cases(native)
    names = {case["name"] for case in cases}
    for name in args.case or ():
        if name not in names:
            parser.error(f"unknown case: {name}")
    selected = common.select_cases(cases, args.case, args.shard, common.SLOW_CASES)
    if not selected:
        print(f"FAIL: no cases in shard {args.shard}; a lane that runs nothing proves nothing")
        return 1
    # The native reference, once per case, produced in the same job.
    args.reference = {}
    for case in selected:
        try:
            args.reference[case["name"]] = common.run_native(native, ["case", case["name"]])
        except common.HarnessError as error:
            raise SystemExit(f"lane B cannot run {case['name']} natively: {error}") from None

    report = {"configs": {}}
    all_problems = []
    for config in configs:
        flags = CONFIGS[config]
        if config == "500-eager":
            for function in args.eager_function:
                result, problems = run_config(config, flags + (f"--wasm-eager-tier-up-function={function}",),
                                              selected, native, wasm, args, function)
                report["configs"][f"{config}-fn{function}"] = result
                all_problems += problems
        else:
            result, problems = run_config(config, flags, selected, native, wasm, args)
            report["configs"][config] = result
            all_problems += problems
    if args.output:
        common.write_json(args.output, report)
    for problem in all_problems:
        print(f"FAIL: {problem}")
    return 1 if all_problems else 0


if __name__ == "__main__":
    sys.exit(main())
