"""Shared pieces of the stack lanes: the probe's hosts and its output format.

Every lane runs the same probe (`probe/`) on the same corpus (`cases.rs`) and
compares each case's output line byte for byte against the native reference.
A host that traps is recorded as a trap, never as an output.
"""
import json
import os
from pathlib import Path
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

    @property
    def trapped(self):
        return self.trap is not None and not self.timed_out

    def as_dict(self):
        return {"line": self.line, "trap": self.trap, "timed_out": self.timed_out}


class HarnessError(Exception):
    """The host could not run the probe at all: a CLI error, a missing file. Not
    a verdict on the case, so a lane stops instead of recording a trap."""


# What a genuine trap looks like on each host's stderr: a prefix the host or
# our launcher owns, never words a guest result or an engine panic could carry.
NATIVE_TRAP = ("has overflowed its stack",)
WASMTIME_TRAP = ("wasm trap:",)
NODE_TRAP = ("TRAP: ",)  # node/run.cjs, for RangeError and WebAssembly.RuntimeError only


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


def _run(command, stdin, timeout):
    try:
        return subprocess.run(command, input=stdin, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout)
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


def run_node(wasm, args, v8_flags=(), stdin=None, timeout=900, node="node"):
    """Node's WASI preview1 through node/run.cjs, with exnref enabled."""
    command = [node, "--experimental-wasm-exnref", *v8_flags, str(NODE_RUNNER), str(wasm), *args]
    completed = _run(command, stdin, timeout)
    if completed is None:
        return Outcome(trap=f"timeout after {timeout}s", timed_out=True)
    return _outcome(completed, NODE_TRAP, signal_is_trap=False)


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
