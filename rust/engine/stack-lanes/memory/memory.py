#!/usr/bin/env python3
"""Measure the engine's memory against its ceilings, per heap shape, on the
wasm build under Wasmtime (`rust/engine/WASM-MEMORY.md`).

Every program in `programs/` grows one kind of heap with a size `__N__`. For
each shape this script finds, with the native probe, the largest N that
completes under the ceilings and the point where the ceiling halts it, then
runs the wasm probe under the Wasmtime CLI:

  fill        N past the ceiling: the running footprint when the ceiling halts it;
  run         N at 95% of the largest completing N: the running footprint;
  snapshot    the same, then a whole-heap snapshot (`write_snapshot`), saved;
  restore     that snapshot resumed in a fresh instance, then `1 + 1`;
  checkpoint  the same program as one crank of a fresh store session, then
              `checkpoint_to_store` into a store that discards rows.

Array items and Map and Set entries are charged against the chunk ceiling,
so those shapes find it the way the string shapes do, and their per-chunk-byte
coefficients count the side storage charged beside the chunks.

  python3 memory.py                          # build both probes, then the whole matrix
  python3 memory.py --no-build --shape strings --ceilings default
  python3 memory.py --no-build --host-halt   # the capped-host check (exits 1 on failure)
  python3 memory.py --no-build --recycle     # what re-instantiating an instance costs
  python3 memory.py --summarize results/matrix.json   # saved results as the report's tables

The Wasmtime CLI is `$WASMTIME` or `wasmtime` on PATH. Results are printed as
a table and, with `--output`, written as JSON.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import build_probe  # noqa: E402

PROBE = HERE / "probe"
NAME = "ih-memory-probe"
PROGRAMS = HERE / "programs"
MIB = 1024 * 1024
PAGE = 65536
DEFAULT_SLOTS = 1_000_000
DEFAULT_CHUNKS = 256 * MIB
# The Wasmtime stack for wasm frames; these programs recurse shallowly.
MAX_WASM_STACK = 1024 * 1024
# The cap of WASM-BLOCKERS.md B8's capped-host run.
HOST_CAP = 128 * MIB

# Ceiling profiles: the defaults, and a small one near what a 128 MB isolate
# can afford, to see whether the ratios hold at a smaller scale.
CEILINGS = {
    "default": (DEFAULT_SLOTS, DEFAULT_CHUNKS),
    "small": (250_000, 32 * MIB),
}

# shape: (program, binding ceiling, fill N, fixed sizes for a shape no ceiling
# binds)
SHAPES = {
    "strings": ("strings.js", "chunk", 4096, None),
    "string-doubling": ("string-doubling.js", "chunk", 24, None),
    "small-strings": ("small-strings.js", "chunk", 50_000_000, None),
    "objects": ("objects.js", "slot", 50_000_000, None),
    "mixed": ("mixed.js", "slot", 50_000_000, None),
    "arrays": ("arrays.js", "chunk", 50_000_000, None),
    "maps": ("maps.js", "chunk", 50_000_000, None),
    "sets": ("sets.js", "chunk", 50_000_000, None),
}


def build(target=None):
    """Build the memory probe natively, or for wasm32-wasip1 with the stack
    probe's recipe (`../build_probe.py`: std rebuilt with unwinding, exnref,
    a 4 MiB shadow stack), and return its path. Like the stack probe it is a
    standalone cargo root that resolves the workspace's Cargo.lock."""
    shutil.copyfile(build_probe.ROOT / "Cargo.lock", PROBE / "Cargo.lock")
    env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_TARGET_DIR=str(PROBE / "target"))
    command = ["cargo", "build", "--release", "--quiet"]
    if target == build_probe.WASM_TARGET:
        env["RUSTC_BOOTSTRAP"] = "1"
        env["RUSTFLAGS"] = build_probe.wasm_rustflags(build_probe.DEFAULT_SHADOW_STACK)
        command += ["-Zbuild-std=std,panic_unwind", "--target", target]
    subprocess.run(command, cwd=PROBE, env=env, check=True)
    path = artifact(target)
    if not path.exists():
        raise SystemExit(f"build produced no artifact at {path}")
    return path


def artifact(target=None):
    if target is None:
        return PROBE / "target/release" / NAME
    return PROBE / "target" / target / "release" / f"{NAME}.wasm"


def wasmtime_cli(explicit=None):
    found = explicit or os.environ.get("WASMTIME") or shutil.which("wasmtime")
    if not found:
        raise SystemExit("set $WASMTIME or put the Wasmtime CLI on PATH")
    return found


def program(name, n):
    return (PROGRAMS / name).read_text().replace("__N__", str(n))


def parse(line):
    fields = {}
    for part in line.split(" "):
        key, _, value = part.partition("=")
        fields[key] = value
    for key, value in list(fields.items()):
        if value.isdigit():
            fields[key] = int(value)
        elif value.startswith('"') and value.endswith('"'):
            fields[key] = json.loads(value)
    return fields


class Trap(Exception):
    pass


def probe_args(command, ceilings, extra=()):
    slots, chunks = ceilings
    return [command, "--slot-ceiling", str(slots), "--chunk-ceiling", str(chunks), *extra]


def run_native(native, args, stdin):
    done = subprocess.run([str(native), *args], input=stdin, text=True, capture_output=True)
    lines = [l for l in done.stdout.splitlines() if l.startswith("command=")]
    if not lines:
        raise Trap(done.stderr.strip() or f"exit {done.returncode}")
    return parse(lines[-1])


def run_wasm(wasmtime, wasm, args, stdin, cap=None, dirs=()):
    command = [wasmtime, "run", "-W", f"max-wasm-stack={MAX_WASM_STACK}", "-W", "exceptions=y"]
    if cap is not None:
        command += ["-W", f"max-memory-size={cap}"]
    for d in dirs:
        command += ["--dir", f"{d}::{d}"]
    command += [str(wasm), *args]
    started = time.monotonic()
    done = subprocess.run(command, input=stdin, text=True, capture_output=True)
    elapsed = time.monotonic() - started
    lines = [l for l in done.stdout.splitlines() if l.startswith("command=")]
    if not lines:
        trap = next((l for l in done.stderr.splitlines() if "wasm trap" in l or "error" in l.lower()),
                    done.stderr.strip() or f"exit {done.returncode}")
        raise Trap(trap.strip())
    fields = parse(lines[-1])
    fields["wall_s"] = round(elapsed, 3)
    return fields


def completes(native, shape, n, ceilings):
    fields = run_native(native, probe_args("run", ceilings), program(SHAPES[shape][0], n))
    return fields["halt"] == "Return"


def largest_completing(native, shape, ceilings):
    """The largest N whose run completes natively, by doubling then bisection."""
    lo, hi = 0, 1
    while completes(native, shape, hi, ceilings):
        lo, hi = hi, hi * 2
        if hi > SHAPES[shape][2]:
            raise SystemExit(f"{shape} completes past its fill size {SHAPES[shape][2]}")
    while hi - lo > max(1, lo // 200):
        mid = (lo + hi) // 2
        if completes(native, shape, mid, ceilings):
            lo = mid
        else:
            hi = mid
    return lo


def measure_shape(native, wasm, wasmtime, shape, ceilings_name):
    """`wasm` is the module to run under `wasmtime`, or None to run the native
    probe instead (its `linear` is then the process's peak RSS)."""
    ceilings = CEILINGS[ceilings_name]
    if wasm is None:
        def run_wasm(_wasmtime, _wasm, args, source, dirs=()):  # noqa: F811
            return run_native(native, args, source)
    else:
        run_wasm = globals()["run_wasm"]
    source_name, binding, fill, fixed = SHAPES[shape]
    rows = []

    def row(phase, n, fields):
        fields.update(shape=shape, phase=phase, n=n, ceilings=ceilings_name)
        rows.append(fields)
        print(summary(fields), flush=True)

    if fixed is None:
        keep = largest_completing(native, shape, ceilings)
        print(f"# {shape} under {ceilings_name}: largest completing N = {keep}", flush=True)
        row("fill", fill, run_wasm(wasmtime, wasm, probe_args("run", ceilings), program(source_name, fill)))
        n = keep if shape == "string-doubling" else max(1, keep * 95 // 100)
        sizes = [n]
    else:
        sizes = list(fixed)
    work = Path(tempfile.mkdtemp(prefix="ih-memory-"))
    try:
        for n in sizes:
            source = program(source_name, n)
            saved = work / "heap.snapshot"
            for phase in ("run", "snapshot", "restore", "checkpoint"):
                try:
                    if phase == "snapshot":
                        args = probe_args(phase, ceilings, ["--save", str(saved)])
                        row(phase, n, run_wasm(wasmtime, wasm, args, source, dirs=[work]))
                    elif phase == "restore":
                        args = probe_args("restore", ceilings, [str(saved)])
                        row(phase, n, run_wasm(wasmtime, wasm, args, "", dirs=[work]))
                        saved.unlink()
                    else:
                        row(phase, n, run_wasm(wasmtime, wasm, probe_args(phase, ceilings), source))
                except Trap as trap:
                    rows.append(dict(shape=shape, phase=phase, n=n, ceilings=ceilings_name, trap=str(trap)))
                    print(f"{shape:16} {phase:10} N={n:<10} trap: {trap}", flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return rows


def summary(f):
    if f["phase"] == "restore":
        return (f"{f['shape']:16} {'restore':10} N={f['n']:<10} {f.get('halt', '?'):22} "
                f"chunks={f.get('chunk_bytes', 0) / MIB:8.1f} MiB slots={f.get('slots', 0):>9} "
                f"linear={f['restore_linear'] / MIB:8.1f} MiB resume={f['resume_us'] / 1000:.0f} ms "
                f"heap_peak={f['restore_heap_peak'] / MIB:8.1f} MiB")
    linear = f.get("checkpoint_linear") or f.get("snapshot_linear") or f.get("run_linear")
    chunk_ceiling = f.get("chunk_ceiling") or 1
    return (f"{f['shape']:16} {f['phase']:10} N={f['n']:<10} {f.get('halt', '?'):22} "
            f"chunks={f.get('chunk_bytes', 0) / MIB:8.1f} MiB slots={f.get('slots', 0):>9} "
            f"linear={linear / MIB:8.1f} MiB ({linear / chunk_ceiling:5.2f}x chunk ceiling) "
            f"heap_peak={max(f.get(k, 0) for k in ('run_heap_peak', 'snapshot_heap_peak', 'checkpoint_heap_peak')) / MIB:8.1f} MiB")


def baseline(wasm, wasmtime, ceilings_name):
    fields = run_wasm(wasmtime, wasm, probe_args("snapshot", CEILINGS[ceilings_name]), "0")
    fields.update(shape="empty", phase="snapshot", n=0, ceilings=ceilings_name)
    print(summary(fields), flush=True)
    return fields


def host_halt(native, wasm, wasmtime):
    """WASM-BLOCKERS.md B8's capped run: under a 128 MiB Wasmtime cap, forty
    kept strings of 2^20 units must end in HostAllocationFailed, where
    uncapped they complete. Then every shape, capped: a capped host may halt
    with HostAllocationFailed or trap, but never report HeapExhausted where
    the uncapped run does not."""
    ok = True
    rows = []
    source = (PROGRAMS / "forty-strings.js").read_text()
    args = probe_args("run", CEILINGS["default"])
    native_line = run_native(native, args, source)
    uncapped = run_wasm(wasmtime, wasm, args, source)
    capped = run_wasm(wasmtime, wasm, args, source, cap=HOST_CAP)
    for label, f in (("native", native_line), ("wasm uncapped", uncapped), ("wasm 128 MiB", capped)):
        print(f"forty-strings {label:14} halt={f['halt']} result={f['result']!r} meter={f['meter']} "
              f"computrons={f['meter'] >> 16} linear={f['run_linear']}")
        rows.append(dict(f, shape="forty-strings", host=label))
    if native_line["halt"] != "Return" or uncapped["halt"] != "Return":
        print("FAIL: the uncapped runs must complete")
        ok = False
    if capped["halt"] != "HostAllocationFailed":
        print(f"FAIL: the capped run must halt with HostAllocationFailed, not {capped['halt']}")
        ok = False
    cases = [("strings", 120), ("string-doubling", 8), ("objects", 300_000), ("mixed", 150_000),
             ("arrays", 4_000_000), ("maps", 4_000_000), ("sets", 4_000_000)]
    for shape, n in cases:
        source = program(SHAPES[shape][0], n)
        reference = run_wasm(wasmtime, wasm, args, source)
        try:
            f = run_wasm(wasmtime, wasm, args, source, cap=HOST_CAP)
            outcome = f["halt"]
        except Trap as trap:
            f, outcome = {}, f"trap: {trap}"
        print(f"{shape:16} N={n:<9} uncapped={reference['halt']:16} capped={outcome}")
        rows.append(dict(f, shape=shape, n=n, host="wasm 128 MiB", outcome=outcome,
                         uncapped=reference["halt"]))
        if outcome == "HeapExhausted" and reference["halt"] != "HeapExhausted":
            print(f"FAIL: {shape} reports the ceiling's halt under a host cap")
            ok = False
    return ok, rows


def recycle(wasm, wasmtime, node):
    """What dropping an instance and restoring the vat into a fresh one costs:
    compiling and instantiating the module, resuming a snapshot of the heap,
    and the first crank, for heaps of the sizes WASM-BLOCKERS.md cites."""
    rows = []
    work = Path(tempfile.mkdtemp(prefix="ih-memory-recycle-"))
    try:
        cwasm = work / "probe.cwasm"
        subprocess.run([wasmtime, "compile", "-W", "exceptions=y", str(wasm), "-o", str(cwasm)], check=True)
        # Mixed heaps whose snapshots are near the two Thixotrope heaps the
        # Cloudflare verification imported (7.65 MB and 17.27 MB).
        for n in (12_000, 28_000, 60_000):
            saved = work / f"mixed-{n}.snapshot"
            made = run_wasm(wasmtime, wasm, probe_args("snapshot", CEILINGS["default"], ["--save", str(saved)]),
                            program("mixed.js", n), dirs=[work])
            for host, module in (("wasmtime", wasm), ("wasmtime precompiled", cwasm)):
                command = [wasmtime, "run", "-W", f"max-wasm-stack={MAX_WASM_STACK}", "-W", "exceptions=y"]
                if module == cwasm:
                    command.append("--allow-precompiled")
                command += ["--dir", f"{work}::{work}", str(module), "restore", str(saved)]
                walls = []
                for _ in range(5):
                    started = time.monotonic()
                    done = subprocess.run(command, capture_output=True, text=True, check=True)
                    walls.append(time.monotonic() - started)
                fields = parse(done.stdout.strip().splitlines()[-1])
                fields.update(host=host, n=n, snapshot_bytes=made["snapshot_bytes"],
                              wall_ms=sorted(walls)[len(walls) // 2] * 1000)
                rows.append(fields)
                print(f"{host:22} snapshot={made['snapshot_bytes'] / 1e6:6.2f} MB "
                      f"wall={fields['wall_ms']:7.1f} ms resume={fields['resume_us'] / 1000:7.1f} ms "
                      f"first_crank={fields['first_crank_us'] / 1000:6.1f} ms "
                      f"linear={fields['crank_linear'] / 1e6:6.1f} MB", flush=True)
            if node:
                done = subprocess.run([node, "--liftoff-only", "--experimental-wasm-exnref",
                                       str(HERE / "recycle.cjs"), str(wasm), str(saved)],
                                      capture_output=True, text=True)
                if done.returncode != 0:
                    # A negative code is the signal that killed Node, which a
                    # guest program cannot cause in a correct host.
                    rows.append(dict(host="node liftoff", n=n, snapshot_bytes=made["snapshot_bytes"],
                                     exit=done.returncode, stderr=done.stderr.strip()[-2000:]))
                    print(f"node failed with exit {done.returncode}: {done.stderr.strip()}")
                    continue
                fields = json.loads(done.stdout.strip().splitlines()[-1])
                fields.update(host="node liftoff", n=n, snapshot_bytes=made["snapshot_bytes"])
                rows.append(fields)
                print(f"{'node liftoff':22} snapshot={made['snapshot_bytes'] / 1e6:6.2f} MB "
                      f"compile={fields['compile_ms']:7.1f} ms instantiate={fields['instantiate_ms']:6.1f} ms "
                      f"restore_and_crank={fields['run_ms']:7.1f} ms rss={fields['rss_mb']:6.1f} MB", flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return rows


PHASES = ("run", "checkpoint", "snapshot", "restore")


def summarize(paths):
    """Print saved `--output` files as the report's two Markdown tables: the
    linear memory each phase reached per shape, and the same as coefficients,
    linear memory above the empty instance per unit the heap holds (per byte
    charged against the chunk ceiling, chunks and side storage, for the shapes
    it binds, bytes per slot for slot-bound shapes, bytes per element for a
    shape no ceiling binds)."""
    rows = []
    for path in paths:
        rows += [r for r in json.loads(Path(path).read_text()).get("rows", []) if "trap" not in r]
    empty = {r["ceilings"]: r["run_linear"] for r in rows if r["shape"] == "empty"}
    merged = {}
    for r in rows:
        if r["shape"] == "empty":
            continue
        key = (r["ceilings"], r["shape"], r["n"], r["phase"] == "fill")
        m = merged.setdefault(key, dict(r))
        m.update({k: v for k, v in r.items() if k.startswith(tuple(f"{p}_" for p in PHASES[1:]))})
    print("| Shape | Slot ceiling | Chunk ceiling (MiB) | N | Halt | Chunks (MiB) | Slots | "
          "Running | Checkpoint | Snapshot | Restore | Snapshot size (MB) |")
    print("|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|")
    for (_, shape, n, fill), r in merged.items():
        peaks = " | ".join(f"{r[f'{p}_linear'] / MIB:,.1f}" if f"{p}_linear" in r else "" for p in PHASES)
        size = f"{r['snapshot_bytes'] / 1e6:,.2f}" if "snapshot_bytes" in r else ""
        print(f"| {shape}{' (at the ceiling)' if fill else ''} | {r['slot_ceiling']:,} | "
              f"{r['chunk_ceiling'] / MIB:g} | {n:,} | {r['halt']} | {r['chunk_bytes'] / MIB:,.1f} | "
              f"{r['slots']:,} | {peaks} | {size} |")
    print()
    print("| Shape | Slot ceiling | Chunk ceiling (MiB) | N | Unit | Running | Checkpoint | Snapshot | Restore |")
    print("|---|---:|---:|---:|---|---:|---:|---:|---:|")
    for (ceilings, shape, n, fill), r in merged.items():
        base = empty.get(ceilings, 0)
        binding = SHAPES.get(shape, (None, None))[1]
        if binding == "chunk":
            unit, per, fmt = "bytes per chunk byte", r["chunk_bytes"] + r.get("side_bytes", 0), "{:.2f}"
        elif binding == "slot":
            unit, per, fmt = "bytes per slot", r["slots"], "{:,.0f}"
        else:
            unit, per, fmt = "bytes per element", n, "{:,.0f}"
        cells = []
        for p in PHASES:
            key = f"{p}_linear"
            cells.append(fmt.format((r[key] - base) / per) if key in r and per else "")
        print(f"| {shape}{' (at the ceiling)' if fill else ''} | {r['slot_ceiling']:,} | "
              f"{r['chunk_ceiling'] / MIB:g} | {n:,} | {unit} | {' | '.join(cells)} |")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--wasmtime")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--shape", action="append", choices=sorted(SHAPES))
    parser.add_argument("--ceilings", action="append", choices=sorted(CEILINGS))
    parser.add_argument("--ceiling", nargs=2, type=int, metavar=("SLOTS", "CHUNK_BYTES"),
                        help="measure under these ceilings instead of the named profiles")
    parser.add_argument("--host-halt", action="store_true", help="only the capped-host check")
    parser.add_argument("--recycle", action="store_true", help="only the re-instantiation cost")
    parser.add_argument("--native", action="store_true",
                        help="run the matrix on the native probe (peak RSS) instead of Wasmtime")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summarize", nargs="+", type=Path, metavar="RESULTS",
                        help="print saved --output files as a Markdown table, and run nothing")
    args = parser.parse_args()
    if args.summarize:
        summarize(args.summarize)
        return 0
    wasmtime = wasmtime_cli(args.wasmtime)
    if args.ceiling:
        CEILINGS["custom"] = tuple(args.ceiling)
        args.ceilings = ["custom"]
    if args.no_build:
        native, wasm = artifact(), artifact(build_probe.WASM_TARGET)
    else:
        native, wasm = build(), build(build_probe.WASM_TARGET)
    report = {"wasmtime": subprocess.check_output([wasmtime, "--version"], text=True).strip()}
    ok = True
    if args.host_halt:
        ok, report["host_halt"] = host_halt(native, wasm, wasmtime)
    elif args.recycle:
        report["recycle"] = recycle(wasm, wasmtime, args.node)
    else:
        rows = []
        for ceilings_name in args.ceilings or sorted(CEILINGS):
            if not args.native:
                rows.append(baseline(wasm, wasmtime, ceilings_name))
            for shape in args.shape or list(SHAPES):
                if SHAPES[shape][3] is not None and ceilings_name not in ("default", "custom"):
                    continue  # no ceiling binds it, so a profile adds nothing
                rows += measure_shape(native, None if args.native else wasm, wasmtime, shape,
                                      ceilings_name)
        report["rows"] = rows
    if args.output:
        args.output.write_text(json.dumps(report, indent=1) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
