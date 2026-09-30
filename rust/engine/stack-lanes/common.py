"""Shared pieces of the stack lanes: the probe's hosts and its output format.

Every lane runs the same probe (`probe/`) on the same corpus (`cases.rs`) and
compares each case's output line byte for byte against the native reference.
A host that traps is recorded as a trap, never as an output.
"""
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LANES = ROOT / "stack-lanes"
NODE_RUNNER = LANES / "node/run.cjs"

class Outcome:
    """One probe invocation on one host."""

    def __init__(self, line=None, trap=None, stderr="", timed_out=False):
        self.line = line
        self.trap = trap
        self.stderr = stderr
        self.timed_out = timed_out
        self.shadow_stack = None
        # The shadow stack's size as linked, read from the module by a painting host.
        self.shadow_stack_top = None
        # A trap's wasm frames as function indices, innermost first, when asked for.
        self.trap_frames = None

    @property
    def trapped(self):
        return self.trap is not None and not self.timed_out

    def as_dict(self):
        d = {"line": self.line, "trap": self.trap, "timed_out": self.timed_out}
        if self.shadow_stack is not None:
            d["shadow_stack"] = self.shadow_stack
        return d


class HarnessError(Exception):
    """The host could not run the probe at all: a CLI error, a missing file. Not
    a verdict on the case, so a lane stops instead of recording a trap."""


# What a genuine trap looks like on each host's stderr: a prefix the host or
# our launcher owns, never words a guest result or an engine panic could carry.
NATIVE_TRAP = ("has overflowed its stack",)
WASMTIME_TRAP = ("wasm trap:",)
NODE_TRAP = ("TRAP: ",)  # node/run.cjs, for RangeError and WebAssembly.RuntimeError only
# A wasm frame in V8's stack trace names its function by index.
WASM_FRAME = re.compile(r"wasm-function\[(\d+)\]")


def _outcome(completed, trap_markers, signal_is_trap):
    stdout = completed.stdout
    stderr = completed.stderr
    lines = [l for l in stdout.splitlines() if l.startswith(("halt=", "compile="))]
    if "panicked at" in stderr:
        # An engine panic is a bug, not a verdict on the case's stack use.
        raise HarnessError(f"the probe panicked: {stderr.strip()}")
    trap = None
    for line in stderr.splitlines():
        if any(marker in line for marker in trap_markers):
            trap = line.strip()
            break
    if trap is None and signal_is_trap and completed.returncode < 0:
        trap = f"signal {-completed.returncode}"
    if trap is None and not lines:
        detail = stderr.strip() or f"exit {completed.returncode} with no output"
        raise HarnessError(detail)
    return Outcome(line=lines[-1] if lines else None, trap=trap, stderr=stderr)


def _run(command, stdin, timeout, env=None):
    try:
        return subprocess.run(command, input=stdin, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return None


def run_native(probe, args, stdin=None, timeout=600):
    """The native probe. A stack overflow aborts its thread's process (SIGABRT)."""
    completed = _run([str(probe), *args], stdin, timeout)
    if completed is None:
        return Outcome(trap=f"timeout after {timeout}s", timed_out=True)
    return _outcome(completed, NATIVE_TRAP, signal_is_trap=True)


def run_wasmtime(wasmtime, wasm, args, max_wasm_stack, stdin=None, timeout=900):
    """The Wasmtime CLI with a fixed max_wasm_stack; `-W exceptions` is on for exnref."""
    command = [str(wasmtime), "run", "-W", f"max-wasm-stack={max_wasm_stack}", "-W", "exceptions=y",
               str(wasm), *args]
    completed = _run(command, stdin, timeout)
    if completed is None:
        return Outcome(trap=f"timeout after {timeout}s", timed_out=True)
    return _outcome(completed, WASMTIME_TRAP, signal_is_trap=False)


def run_node(wasm, args, v8_flags=(), stdin=None, timeout=900, node="node", paint=False, trap_frames=0):
    """Node's WASI preview1 through node/run.cjs, with exnref enabled. With
    `paint`, the outcome carries the shadow stack's high-water mark in bytes;
    with `trap_frames`, the innermost that many wasm frames of a trap."""
    command = [node, "--experimental-wasm-exnref", *v8_flags, str(NODE_RUNNER), str(wasm), *args]
    env = dict(os.environ)
    if paint:
        env["PAINT_SHADOW_STACK"] = "1"
    if trap_frames:
        env["TRAP_STACK_FRAMES"] = str(trap_frames)
    completed = _run(command, stdin, timeout, env=env)
    if completed is None:
        return Outcome(trap=f"timeout after {timeout}s", timed_out=True)
    outcome = _outcome(completed, NODE_TRAP, signal_is_trap=False)
    for line in completed.stderr.splitlines():
        if line.startswith("SHADOW_STACK: "):
            outcome.shadow_stack = int(line.split(": ", 1)[1])
        elif line.startswith("SHADOW_STACK_TOP: "):
            outcome.shadow_stack_top = int(line.split(": ", 1)[1])
    if trap_frames:
        outcome.trap_frames = trap_frames_from(completed.stderr)
    return outcome


def trap_frames_from(stderr):
    """The wasm function indices of a trap's `TRAP FRAME:` lines, innermost
    first; frames that are not wasm (the launcher's own) are skipped."""
    frames = []
    for line in stderr.splitlines():
        if line.startswith("TRAP FRAME: "):
            m = WASM_FRAME.search(line)
            if m:
                frames.append(int(m.group(1)))
    return frames


def dump_cases(probe):
    """The corpus as the probe defines it: a list of dicts with name, run, source."""
    out = subprocess.check_output([str(probe), "dump-cases"], text=True)
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def load_json(path, default):
    path = Path(path)
    if not path.exists():
        return default
    return json.loads(path.read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def wasmtime_binary():
    """The Wasmtime CLI: $WASMTIME, else `wasmtime` on PATH."""
    return os.environ.get("WASMTIME", "wasmtime")


# ---- verdicts and expected-trap lists, shared by every lane ----

def classify(name, native, host, expected):
    """One case's verdict on one host: pass, expected-trap, or a failure string."""
    if native.timed_out or host.timed_out:
        return f"timeout: native {native.trap}, host {host.trap}"
    if native.trapped:
        return f"native trapped: {native.trap}"
    if host.trapped:
        if name in expected:
            return "expected-trap"
        return f"unexpected trap: {host.trap}"
    if host.line != native.line:
        return f"mismatch: native {native.line!r}, host {host.line!r}"
    if name in expected:
        return "listed as an expected trap but passed; remove it from the list (--update-expected)"
    return "pass"


def resolved_by_update(problem, allow_grow):
    """Whether rewriting the expected-trap list answers this problem."""
    verdict = problem.split(": ", 1)[1]
    if "remove it from the list" in verdict:
        return True
    return allow_grow and verdict.startswith("unexpected trap")


def summarize(results):
    """From classify() verdicts: the problems (failures), the cases that trapped,
    and the cases the run could not decide (timeouts, native traps), whose
    listing an update must keep."""
    problems = []
    trapped = set()
    undecided = set()
    for name, verdict in results.items():
        if verdict == "pass":
            continue
        if verdict == "expected-trap":
            trapped.add(name)
            continue
        if verdict.startswith("unexpected trap"):
            trapped.add(name)
        if verdict.startswith(("timeout", "native trapped")):
            undecided.add(name)
        problems.append(f"{name}: {verdict}")
    return problems, trapped, undecided


class ExpectedTraps:
    """An expected-trap list for one lane configuration. It may only shrink: a
    listed case that passes fails the check until it is removed, and a new trap
    is recorded only with allow_grow. The `config` dict (stack size, flags) is
    recorded with the list and must match on a check."""

    def __init__(self, path, config):
        self.path = Path(path)
        self.config = config
        listed = load_json(self.path, {"config": config, "expected_traps": []})
        self.recorded_config = listed.get("config")
        self.names = set(listed["expected_traps"])

    def config_matches(self):
        return self.recorded_config == self.config

    def update(self, selected_names, trapped, problems, allow_grow, undecided=frozenset()):
        """Rewrite the list from a run; cases outside the run, and cases the run
        could not decide, keep their listing. Returns the problems the rewrite
        does not answer and whether the list was written."""
        untested = self.names - (set(selected_names) - set(undecided))
        grew = trapped - self.names
        if grew and not allow_grow:
            return problems + [f"expected-trap list may only shrink; new traps: {sorted(grew)} "
                               f"(--allow-grow to record them)"], False
        self.names = untested | trapped
        write_json(self.path, {"config": self.config, "expected_traps": sorted(self.names)})
        return [p for p in problems if not resolved_by_update(p, allow_grow)], True


def select_cases(cases, names, shard, slow_cases):
    """The corpus filtered by --case names and a fast|slow|all shard."""
    selected = []
    for case in cases:
        slow = case["name"] in slow_cases
        if shard == "fast" and slow or shard == "slow" and not slow:
            continue
        if names and case["name"] not in names:
            continue
        selected.append(case)
    return selected


# Its own shard: the RegExp matcher's backtracking is slow on wasm (§5).
SLOW_CASES = ("regexp-backtrack",)
