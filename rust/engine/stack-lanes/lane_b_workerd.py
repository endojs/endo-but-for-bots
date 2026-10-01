#!/usr/bin/env python3
"""Lane B, workerd: the corpus under Cloudflare's workerd with V8 flags pinned.

STACK-DEPTH-REFACTOR.md §5, "CI lane B": workerd with `v8Flags` pinned to
`--liftoff-only` and to `--no-liftoff`, at the default stack and at
`--stack-size=836` (984 KiB less the tier-mix headroom, common.py), since
workerd's V8 traps a different set than Node's.
The wasm32-wasip1 probe is bundled into a Worker (workerd/worker.js, which
shims the eight WASI imports the probe uses) and each case is one request to
a fresh instance. Outputs must match the native reference byte for byte; a
trap is allowed only for a case on that configuration's expected-trap list,
which may only shrink. With --paint, shadow-stack high-water marks are
recorded as in the Node lane.

Needs the `workerd` binary: $WORKERD, or `workerd` on PATH (`npm install workerd`).
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import common  # noqa: E402

HERE = common.LANES / "workerd"
TIERS = {"liftoff": ["--liftoff-only"], "turbofan": ["--no-liftoff"], "default": []}
REDUCED_STACK = str(common.lane_b_stack(common.WORKERD_STACK_KB))
STACKS = {"default": [], REDUCED_STACK: [f"--stack-size={REDUCED_STACK}"]}


def config_name(tier, stack):
    return f"{tier}-{stack}"


def expected_path(tier, stack):
    return common.LANES / f"expected-traps/workerd-{config_name(tier, stack)}.json"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Workerd:
    """One workerd process serving the probe with a fixed set of V8 flags."""

    def __init__(self, binary, wasm, v8_flags):
        self.dir = tempfile.mkdtemp(prefix="stack-lanes-workerd-")
        shutil.copyfile(HERE / "worker.js", Path(self.dir) / "worker.js")
        shutil.copyfile(common.LANES / "shadow-paint.mjs", Path(self.dir) / "shadow-paint.mjs")
        shutil.copyfile(wasm, Path(self.dir) / "probe.wasm")
        self.port = free_port()
        flags = ", ".join(json.dumps(f) for f in v8_flags)
        config = (HERE / "config.capnp.in").read_text()
        config = config.replace("@ADDRESS@", f"127.0.0.1:{self.port}").replace("@V8_FLAGS@", flags)
        (Path(self.dir) / "config.capnp").write_text(config)
        # workerd's output goes to a file: a pipe nobody drains would block it
        # once it has logged 64 KiB.
        self.log_path = Path(self.dir) / "workerd.log"
        self.log = open(self.log_path, "w")
        self.process = subprocess.Popen([str(binary), "serve", "config.capnp"], cwd=self.dir,
                                        stdout=self.log, stderr=subprocess.STDOUT, text=True)
        self.url = f"http://127.0.0.1:{self.port}/"
        self.wait_ready()

    def log_tail(self):
        try:
            return self.log_path.read_text()[-2000:]
        except OSError:
            return ""

    def wait_ready(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise common.HarnessError(f"workerd exited {self.process.returncode}: {self.log_tail()}")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    return
            except OSError:
                time.sleep(0.1)
        raise common.HarnessError("workerd did not start listening")

    def run(self, name, paint, timeout=900):
        query = f"?case={urllib.parse.quote(name)}" + ("&paint=1" if paint else "")
        try:
            with urllib.request.urlopen(self.url + query, timeout=timeout) as response:
                body = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise common.HarnessError(f"workerd answered {error.code}: {error.read().decode()[:500]}")
        except (urllib.error.URLError, http.client.HTTPException, OSError):
            if self.process.poll() is not None:
                raise common.HarnessError(f"workerd died: {self.log_tail()}")
            # The isolate is still inside the case; nothing later would run, so
            # the caller must replace this server.
            return common.Outcome(trap=f"timeout after {timeout}s", timed_out=True)
        lines = [l for l in body["stdout"].splitlines() if l.startswith(("halt=", "compile="))]
        outcome = common.Outcome(line=lines[-1] if lines else None,
                                 trap=f"TRAP: {body['trap']}" if body["trap"] else None,
                                 stderr=body["stderr"])
        if outcome.line is None and outcome.trap is None:
            raise common.HarnessError(f"no probe output for {name}: exit {body['exit']}, "
                                      f"stderr {body['stderr'][:300]!r}")
        outcome.shadow_stack = body.get("shadowStack")
        outcome.shadow_stack_top = body.get("shadowStackTop")
        return outcome

    def close(self):
        self.process.kill()
        self.process.wait()
        self.log.close()
        shutil.rmtree(self.dir, ignore_errors=True)


def run_config(tier, stack, selected, reference, wasm, args):
    """One configuration over the selected cases on one workerd process,
    replaced when a case times out: its report and problems."""
    # workerd's V8 has exnref on by default and rejects the Node-era flag.
    v8_flags = [*TIERS[tier], *STACKS[stack]]
    label = config_name(tier, stack)
    cfg = {"v8_flags": v8_flags, "shadow_stack": args.shadow_stack}
    expected = common.lane_b_expected(expected_path(tier, stack), cfg, args)
    try:
        server = Workerd(args.workerd, wasm, v8_flags)
    except common.HarnessError as error:
        raise SystemExit(f"lane B workerd ({label}) cannot start: {error}") from None

    def run_case(name):
        nonlocal server
        host = server.run(name, args.paint)
        if host.timed_out:
            # The stuck isolate would queue every later case behind it.
            server.close()
            server = Workerd(args.workerd, wasm, v8_flags)
        return host

    try:
        return common.run_lane_b("lane B workerd", label, f"workerd {label:16s}", expected, selected,
                                 reference, run_case, args)
    finally:
        server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", action="append", choices=sorted(TIERS),
                        help="default: liftoff and turbofan")
    parser.add_argument("--stack", action="append", choices=sorted(STACKS), help="default: both")
    parser.add_argument("--paint", action="store_true")
    parser.add_argument("--shadow-stack", type=int, default=build_probe.DEFAULT_SHADOW_STACK)
    parser.add_argument("--update-expected", action="store_true")
    parser.add_argument("--allow-grow", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--case", action="append")
    parser.add_argument("--shard", choices=("fast", "slow", "all"), default="fast")
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--workerd", default=os.environ.get("WORKERD", "workerd"))
    args = parser.parse_args()
    if shutil.which(args.workerd) is None and not Path(args.workerd).exists():
        parser.error(f"workerd binary not found: {args.workerd} (set $WORKERD or install workerd)")
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
    reference = {}
    for case in selected:
        try:
            reference[case["name"]] = common.run_native(native, ["case", case["name"]])
        except common.HarnessError as error:
            raise SystemExit(f"lane B cannot run {case['name']} natively: {error}") from None
    report = {"configs": {}}
    all_problems = []
    for tier in args.tier or ["liftoff", "turbofan"]:
        for stack in args.stack or ["default", REDUCED_STACK]:
            result, problems = run_config(tier, stack, selected, reference, wasm, args)
            report["configs"][config_name(tier, stack)] = result
            all_problems += problems
    if args.output:
        common.write_json(args.output, report)
    for problem in all_problems:
        print(f"FAIL: {problem}")
    return 1 if all_problems else 0


if __name__ == "__main__":
    sys.exit(main())
