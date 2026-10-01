#!/usr/bin/env python3
"""Lane C: per-function frame sizes, per-family slopes and the tier-mix model.

STACK-DEPTH-REFACTOR.md §5, "Lane C, trend only":

  frames   the frame each function reserves, per compiler: native (rustc with
           -Z emit-stack-sizes, read from the rlibs with llvm-readobj), the wasm
           shadow stack (the prologue in the wasm binary), Cranelift (Wasmtime's
           compiled artifact, read with objdump), and V8's Liftoff and TurboFan
           (node --print-wasm-code with the tier pinned);
  slopes   for each heavy family, bytes of stack per level and per budget unit
           at two depths: native (the probe's --stack painter) and the shadow
           stack (node/run.cjs painting, under a host stack large enough for
           every family's ceiling);
  chains   for each heavy family, the functions of one recursion level, from
           the stack trace of a trap under Node at a host stack too small for
           the ceiling, cut at the repeating period;
  model    per chain and compiler, one level as the sum of its frames, printed
           next to the measured slopes for the heavy families: the check of the
           chains and the frame tables against the painters;
  tier-mix per chain, the sum of max(Liftoff, TurboFan) frames over one level
           against each pure tier: the excess a per-function tier mix can cost,
           checked against the headroom lane B leaves (§1.7, common.py). An
           excess past it is the report's cue to widen that headroom, not a
           failure.

The lane is trend only: it fails only when a collector reads nothing.
`--output report.json` records everything; `--diff old.json` prints the largest
per-function changes against an earlier report, for posting on a PR.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import ceilings  # noqa: E402
import common  # noqa: E402
import wasmbin  # noqa: E402

TIER_MIX_MARGIN = common.TIER_MIX_HEADROOM
STACK_SIZES_TARGET_DIR = build_probe.PROBE / "target/stack-sizes"
# x86-64: what a call and a frame-pointer push occupy above a function's own
# reservation. Every compiler's figure below counts them, so that the frames
# of one recursion level sum to what the painters measure per level.
RETURN_ADDRESS = 8
FRAME_POINTER = 8


# ---- names -----------------------------------------------------------------

def demangle_legacy(name):
    """Rust's legacy mangling (`_ZN...E`) to a `::` path, escapes kept."""
    if not name.startswith("_ZN"):
        return name
    pos, parts = 3, []
    while pos < len(name) and name[pos] != "E":
        m = re.match(r"\d+", name[pos:])
        if not m:
            return name
        length = int(m.group())
        pos += len(m.group())
        parts.append(name[pos:pos + length])
        pos += length
    return "::".join(parts)


ESCAPES = (("$LT$", "<"), ("$GT$", ">"), ("$LP$", "("), ("$RP$", ")"), ("$u20$", " "), ("$C$", ","),
           ("$RF$", "&"), ("$BP$", "*"), ("$u7b$", "{"), ("$u7d$", "}"), ("$u5b$", "["), ("$u5d$", "]"),
           ("$u27$", "'"), ("$u3b$", ";"), ("$u21$", "!"), ("$u3d$", "="), ("..", "::"))


def unescape(text):
    """The `$..$` escapes of a legacy-mangled path, as llvm-readobj and the
    wasm name section spell it, to the text rustc-demangle prints."""
    parts = []
    for part in text.split("::"):
        # An identifier that starts with a `$` escape carries a leading `_`.
        parts.append(part[1:] if part.startswith("_$") else part)
    text = "::".join(parts)
    for token, char in ESCAPES:
        text = text.replace(token, char)
    return text


def canonical(name):
    """One spelling for a function across the compilers' reports: the wasm name
    section carries `_ZN...E`, llvm-readobj a `::` path with `$` escapes; both
    keep the hash and may mark an internalized copy (`.llvm.N`, or
    ` (.llvm.N)` after the hash), which drop, since the number changes with
    any code change."""
    name = re.sub(r"\s*\(\.llvm\.\d+\)$|\.llvm\.\d+$", "", name)
    name = unescape(demangle_legacy(name))
    return re.sub(r"::h[0-9a-f]{16}$", "", name)


# ---- frames ----------------------------------------------------------------

def llvm_tool(name):
    """A tool from rustup's llvm-tools for the pinned toolchain, else PATH."""
    sysroot = subprocess.check_output(["rustc", "--print", "sysroot"], text=True, cwd=common.ROOT).strip()
    candidate = Path(sysroot) / "lib/rustlib" / subprocess.check_output(
        ["rustc", "-vV"], text=True, cwd=common.ROOT).split("host: ")[1].split()[0] / "bin" / name
    return str(candidate) if candidate.exists() else name


def native_frames(quiet=True):
    """Static frame sizes of the native build: rustc's -Z emit-stack-sizes
    section, read from every engine rlib. Generic code instantiated in the
    probe crate itself is not in an rlib and is not reported."""
    shutil.copyfile(common.ROOT / "Cargo.lock", build_probe.PROBE / "Cargo.lock")
    env = dict(os.environ, CARGO_INCREMENTAL="0", RUSTC_BOOTSTRAP="1",
               RUSTFLAGS="-Z emit-stack-sizes", CARGO_TARGET_DIR=str(STACK_SIZES_TARGET_DIR))
    subprocess.run(["cargo", "build", "--release"] + (["--quiet"] if quiet else []),
                   cwd=build_probe.PROBE, env=env, check=True)
    readobj = llvm_tool("llvm-readobj")
    frames = {}
    for rlib in sorted((STACK_SIZES_TARGET_DIR / "release/deps").glob("libironhorse_*.rlib")):
        out = subprocess.run([readobj, "--stack-sizes", "--demangle", str(rlib)], text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
        frames.update(parse_stack_sizes(out))
    return frames


def parse_stack_sizes(text):
    """llvm-readobj's `StackSizes` entries (`Functions: [a, b]` then `Size: 0xN`).
    The size is the frame below the return address, so 8 bytes are added to
    make the figure what one activation occupies, as the other compilers'
    figures are. Aliased functions (several names, one body) each get the size;
    a name seen in several objects keeps its largest."""
    frames = {}
    functions = []
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r"Functions: \[(.*)\]$", line)
        if m:
            functions = [canonical(f.strip()) for f in m.group(1).split(",") if f.strip()]
        elif line.startswith("Size:"):
            size = int(line.split(":", 1)[1].strip(), 0) + RETURN_ADDRESS
            for f in functions:
                frames[f] = max(frames.get(f, 0), size)
            functions = []
    return frames


def shadow_frames(wasm):
    """Index -> bytes from the prologues, and the name section."""
    names, _, frames = wasmbin.read(wasm)
    return frames, names


def cranelift_frames(wasmtime, wasm):
    """Index -> bytes from Wasmtime's compiled artifact, disassembled with objdump."""
    cwasm = Path(wasm).with_suffix(".cwasm")
    subprocess.run([str(wasmtime), "compile", "-W", "exceptions=y", "-o", str(cwasm), str(wasm)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    out = subprocess.run(["objdump", "-d", "--no-show-raw-insn", str(cwasm)], text=True,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    return parse_cranelift(out)


def parse_cranelift(text):
    """Per wasm function index, the bytes one activation occupies. Cranelift's
    prologue checks the frame against the stack limit before reserving it
    (`add $N,%r10; cmp %rsp,%r10`), and that N counts the return address, the
    pushed frame pointer and the reservation, including what the stack-probe
    loop touches page by page. A function with no check is a leaf that
    reserves nothing beyond the pushed frame pointer: the `sub`s of %rsp in
    its prologue, before its first branch or call, are summed, if any."""
    frames = {}
    index = None
    in_prologue = False
    for line in text.splitlines():
        m = re.match(r"[0-9a-f]+ <wasm\[0\]::function\[(\d+)\]", line)
        if m:
            index = int(m.group(1))
            frames[index] = RETURN_ADDRESS + FRAME_POINTER
            in_prologue = True
            continue
        if re.match(r"[0-9a-f]+ <", line):  # a trampoline or other symbol
            index = None
            continue
        if index is None or not in_prologue:
            continue
        m = re.search(r"\badd\s+\$0x([0-9a-f]+),%r10$", line)
        if m:
            frames[index] = int(m.group(1), 16)
            in_prologue = False
            continue
        m = re.search(r"\bsub\s+\$0x([0-9a-f]+),%rsp$", line)
        if m:
            frames[index] += int(m.group(1), 16)
        elif re.search(r"\b(call|ret[lq]?|jmp|j[a-z]+)\b", line):
            in_prologue = False
    return frames


V8_TIER = {"liftoff": ("--liftoff-only", "Liftoff"), "turbofan": ("--no-liftoff", "TurboFan")}


def v8_frames(wasm, tier):
    """Index -> bytes from V8's code for every function, compiled up front
    (`--no-wasm-lazy-compilation`) by the tier pinned, printed with
    `--print-wasm-code`."""
    flag, compiler = V8_TIER[tier]
    command = ["node", "--experimental-wasm-exnref", flag, "--no-wasm-lazy-compilation",
               "--print-wasm-code", str(common.NODE_RUNNER), str(wasm), "case", "floor"]
    out = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    frames, other = parse_v8(out, compiler)
    if other:
        print(f"WARNING: {len(other)} functions were compiled by a tier other than {compiler}; skipped",
              file=sys.stderr)
    return frames


def parse_v8(text, compiler):
    """Per wasm function index, the bytes one activation occupies: the return
    address, the frame-pointer and marker pushes before the prologue's first
    branch, and the first `subq rsp,N` anywhere in the function's code. The
    reservation is not always the next instruction: Liftoff reserves a frame
    of 4 KiB or more in out-of-line code reached by a `jmp`, and TurboFan
    checks such a frame against the stack limit, with a `call` on the
    overflow path, before reserving it. Functions another tier compiled are
    returned apart."""
    frames, other = {}, {}
    index = seen = None
    pushed = 0
    counting = reserved = False

    def finish():
        if index is not None and seen is not None and not reserved:
            target = frames if seen == compiler else other
            target[index] = RETURN_ADDRESS + 8 * pushed

    for line in text.splitlines():
        if line.startswith("--- WebAssembly code"):
            finish()
            index = seen = None
            pushed = 0
            counting = reserved = False
        elif line.startswith("index:"):
            index = int(line.split(":", 1)[1])
        elif line.startswith("compiler:"):
            seen = line.split(":", 1)[1].strip()
            counting = True
        elif line.startswith("--- End code"):
            finish()
            index = seen = None
        elif index is not None and seen is not None and not reserved:
            if counting and re.search(r"\bpush\b", line):
                pushed += 1
            m = re.search(r"\bsubq rsp,0x([0-9a-f]+)$", line)
            if m:
                target = frames if seen == compiler else other
                target[index] = RETURN_ADDRESS + 8 * pushed + int(m.group(1), 16)
                reserved = True
            elif re.search(r"\b(call|ret[lq]?|jmp|j[a-z]+)\b", line):
                counting = False
    finish()
    return frames, other


def by_name(names, frames):
    """Frames keyed by canonical name, the form the report and `--diff` use
    since indices shift between builds. LLVM's internalized copies of one
    function (`name.llvm.N`) and a generic's instantiations share a name, and
    the largest frame is kept; the chain arithmetic below uses the exact
    per-index tables instead."""
    result = {}
    for index, size in frames.items():
        if size is None:
            continue
        name = canonical(names.get(index, f"function[{index}]"))
        result[name] = max(result.get(name, 0), size)
    return result


def function_name(names, index):
    return canonical(names.get(index, f"function[{index}]"))


# ---- slopes ----------------------------------------------------------------

def units_per_level(ceiling):
    """Budget units one level costs, estimated from the ceiling: the budget is
    2,048 units and level ceiling+1 halts. The estimate is one unit high for
    a family whose entry costs a frame more than each level (the generator
    families: ceiling 62, 32 units per level; `species`, 41, 48 units),
    which the report's §2.1 table, from the code, resolves; the report
    names the field as the estimate it is."""
    return round(2048 / (ceiling + 1))


def native_stack(native, family, n):
    line = common.run_native(native, ["family", "heavy", family, str(n), "--stack"]).line or ""
    return int(line.rsplit("stack=", 1)[1]) if "stack=" in line else None


# The host stack the shadow painter runs under: room for every heavy family at
# its ceiling under V8's default tiering, which needs more than V8's default
# and more than lane B's limits (lane B's expected traps). The painter
# measures; a family that does not fit has no mark to give.
SLOPE_STACK_KB = 16 * 1024


def shadow_stack(wasm, family, n, stack_kb=SLOPE_STACK_KB):
    """The painted shadow mark of a run that returned. A trap's mark is where
    it trapped, not what the family needs, so a trap is a HarnessError: the
    collector read nothing for the family."""
    outcome = common.run_node(wasm, ["family", "heavy", family, str(n)], paint=True, stack_kb=stack_kb)
    if outcome.trapped:
        raise common.HarnessError(f"the shadow painter trapped at depth {n} under a {stack_kb} KiB "
                                  f"host stack: {outcome.trap}")
    return outcome.shadow_stack


def slopes(native, wasm, problems):
    """Per heavy family: bytes per level and per unit, native and shadow, from
    two depths (half the ceiling and the ceiling). A host that cannot run a
    family is a problem, recorded and skipped, not the end of the run."""
    result = {}
    for family, ceiling in ceilings.recorded("heavy"):
        low, high = max(ceiling // 2, 1), ceiling
        if high <= low:
            continue
        units = units_per_level(ceiling)
        entry = {"ceiling": ceiling, "units_per_level_estimated": units, "depths": [low, high]}
        try:
            n1, n2 = native_stack(native, family, low), native_stack(native, family, high)
            if n1 is not None and n2 is not None:
                per_level = (n2 - n1) / (high - low)
                entry["native"] = {"bytes_per_level": round(per_level), "bytes_per_unit": round(per_level / units)}
            s1, s2 = shadow_stack(wasm, family, low), shadow_stack(wasm, family, high)
            if s1 is not None and s2 is not None:
                per_level = (s2 - s1) / (high - low)
                entry["shadow"] = {"bytes_per_level": round(per_level), "bytes_per_unit": round(per_level / units)}
        except common.HarnessError as error:
            problems.append(f"slope {family}: {error}")
        result[family] = entry
        print(f"slope {family:18s} units/level {units:3d}  native {entry.get('native', {}).get('bytes_per_level', '?'):>7} B/level"
              f"  shadow {entry.get('shadow', {}).get('bytes_per_level', '?'):>7} B/level", flush=True)
    return result


# ---- chains ----------------------------------------------------------------

def one_level(frames, min_repeats=4, name=lambda f: f):
    """One period of a repeating stack trace, rotated to start at the dispatch
    loop when it is part of the level, or None when the frames do not repeat.
    The trap lands anywhere in a level, in leaves below it too, and the
    program's entry frames end the trace, so the period is looked for from
    each start in turn over the `min_repeats` levels that follow it."""
    p = None
    for skip in range(len(frames)):
        rest = frames[skip:]
        for candidate in range(1, len(rest) // min_repeats + 1):
            if all(rest[i] == rest[i + candidate] for i in range((min_repeats - 1) * candidate)):
                p = candidate
                break
        if p:
            break
    if not p:
        return None
    level = rest[:p]
    for i, f in enumerate(level):
        if name(f).endswith("::dispatch_at_inner"):
            return level[i:] + level[:i]
    return level


CHAIN_STACK_KB = 120
CHAIN_FRAMES = 300
CHAIN_KINDS = ("heavy", "walker", "chain")


def chains(wasm, names, problems, stack_kb=CHAIN_STACK_KB):
    """Per kind and family, the functions of one level of the recursion that
    is deepest in bytes at the family's ceiling: run the family under Node
    with a host stack too small for it (Liftoff, whose frames are the
    largest, so the shallowest stack traps) and cut the trap's stack trace at
    its period. For the heavy families that is the interpreter's re-entry
    chain and for the walkers the native's own recursion, the chains whose
    budget sets the ceiling. For the chain kinds it is whichever compiler
    pass recurses deepest over the tree, which is not always the counted
    one: the folding productions are parsed by a loop, and the post-parse
    `duplicate_proto_setter_line` walk recurses once per level of the
    left-nested tree they build. A level is a list of wasm function indices,
    exact where names are not (a generic's instantiations share a name). A
    family whose trace does not repeat, or that fits the stack, reports
    None; a host that cannot run one is a problem, recorded and skipped."""
    result = {}
    for kind in CHAIN_KINDS:
        result[kind] = {}
        for family, ceiling in ceilings.recorded(kind):
            try:
                outcome = common.run_node(wasm, ["family", kind, family, str(ceiling)],
                                          v8_flags=("--liftoff-only", f"--stack-size={stack_kb}"),
                                          trap_frames=CHAIN_FRAMES)
            except common.HarnessError as error:
                problems.append(f"chain {kind}/{family}: {error}")
                result[kind][family] = None
                continue
            level = one_level(outcome.trap_frames or [], name=lambda i: function_name(names, i)) \
                if outcome.trapped else None
            result[kind][family] = level
            shown = ", ".join(function_name(names, i).split("::")[-1] for i in level) if level else (
                "no period found" if outcome.trapped else "no trap at this stack")
            print(f"chain {kind:6s} {family:18s} {len(level) if level else '-':>2} {shown}"[:200], flush=True)
    return result


def tier_mix(chain_levels, liftoff, turbofan):
    """Per chain: the per-level sum under each pure tier and under the worst
    per-function mix, and the excess of the mix over the larger pure tier.
    The chains and the tables are keyed by wasm function index."""
    result = {}
    for family, level in chain_levels.items():
        if not level:
            continue
        lo = sum(liftoff.get(i, 0) for i in level)
        tf = sum(turbofan.get(i, 0) for i in level)
        mix = sum(max(liftoff.get(i, 0), turbofan.get(i, 0)) for i in level)
        larger = max(lo, tf)
        excess = (mix - larger) / larger if larger else 0.0
        result[family] = {"liftoff": lo, "turbofan": tf, "worst_mix": mix, "excess": round(excess, 4)}
    return result


def model(chain_levels, indexed, native, names):
    """Per chain and compiler, one level as the sum of the chain's frames: the
    prediction the slopes measure. The wasm compilers' tables are by index;
    native has names only, and its table lacks generic code instantiated in
    the probe crate, so it reports the sum of what it has and the names it
    lacks."""
    result = {}
    for family, level in chain_levels.items():
        if not level:
            continue
        entry = {compiler: {"bytes_per_level": sum(table.get(i, 0) for i in level)}
                 for compiler, table in indexed.items()}
        if native is not None:
            functions = [function_name(names, i) for i in level]
            entry["native"] = {"bytes_per_level": sum(native.get(f, 0) for f in functions)}
            missing = [f for f in functions if f not in native]
            if missing:
                entry["native"]["missing"] = missing
        result[family] = entry
    return result


# ---- report ----------------------------------------------------------------

def top(frames, n):
    return sorted(frames.items(), key=lambda kv: -kv[1])[:n]


def diff(old, new, n=20):
    lines = []
    for compiler in sorted(set(old.get("frames", {})) | set(new.get("frames", {}))):
        a, b = old.get("frames", {}).get(compiler, {}), new.get("frames", {}).get(compiler, {})
        changes = [(b.get(f, 0) - a.get(f, 0), f) for f in set(a) | set(b) if a.get(f, 0) != b.get(f, 0)]
        changes.sort(key=lambda kv: -abs(kv[0]))
        for delta, f in changes[:n]:
            lines.append(f"{compiler:9s} {delta:+8d} B  {f[:110]}  ({a.get(f, 0)} -> {b.get(f, 0)})")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--diff", type=Path, help="an earlier report to compare frames against")
    parser.add_argument("--top", type=int, default=15)
    parser.add_argument("--skip", action="append", default=[],
                        choices=("native", "cranelift", "liftoff", "turbofan", "slopes", "chains"))
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--wasmtime", default=common.wasmtime_binary())
    args = parser.parse_args()
    if args.no_build:
        native, wasm = build_probe.artifact(), build_probe.artifact(build_probe.WASM_TARGET)
    else:
        native = build_probe.build(quiet=True)
        wasm = build_probe.build(build_probe.WASM_TARGET, quiet=True)
    report = {"frames": {}, "slopes": {}, "chains": {}, "model": {}, "tier_mix": {}, "over_margin": [],
              "problems": []}
    shadow, names = shadow_frames(wasm)
    indexed = {"shadow": shadow}  # the wasm compilers, by function index
    if "cranelift" not in args.skip:
        indexed["cranelift"] = cranelift_frames(args.wasmtime, wasm)
    for tier in ("liftoff", "turbofan"):
        if tier not in args.skip:
            indexed[tier] = v8_frames(wasm, tier)
    native_table = native_frames() if "native" not in args.skip else None
    report["frames"] = {compiler: by_name(names, table) for compiler, table in indexed.items()}
    if native_table is not None:
        report["frames"]["native"] = native_table
    for compiler, frames in report["frames"].items():
        print(f"--- {compiler}: {len(frames)} functions, largest frames")
        for f, n in top(frames, args.top):
            print(f"  {n:7d}  {f[:110]}")
        if not frames:
            report["problems"].append(f"{compiler}: no frames were read")
    unread = sorted(i for i, n in shadow.items() if n is None)
    if unread:
        report["problems"].append(f"shadow: {len(unread)} bodies move the stack pointer in a way wasmbin.py "
                                  f"does not read: {', '.join(function_name(names, i) for i in unread[:5])}")
    if "slopes" not in args.skip:
        report["slopes"] = slopes(native, wasm, report["problems"])
    if "chains" not in args.skip:
        levels = chains(wasm, names, report["problems"])
        report["chains"] = {kind: {family: [function_name(names, i) for i in level] if level else None
                                   for family, level in found.items()}
                            for kind, found in levels.items()}
        for kind, found in levels.items():
            report["model"][kind] = model(found, indexed, native_table, names)
        # The model against the measurement: one heavy level as the sum of
        # its frames, next to the painted bytes per level, native and shadow.
        for family, entry in report["slopes"].items():
            modelled = report["model"].get("heavy", {}).get(family)
            if not modelled:
                continue
            parts = []
            for painter in ("native", "shadow"):
                measured = entry.get(painter, {}).get("bytes_per_level")
                predicted = modelled.get(painter, {})
                if measured and predicted and predicted["bytes_per_level"]:
                    note = " (partial)" if predicted.get("missing") else ""
                    parts.append(f"{painter} {predicted['bytes_per_level']:6d} of {measured:6d} B/level{note}")
            # A period that is a fraction of a level (function-call: one
            # segment crossing, two per level) shows as a whole ratio.
            shadow_measured = entry.get("shadow", {}).get("bytes_per_level")
            shadow_predicted = modelled.get("shadow", {}).get("bytes_per_level")
            if shadow_measured and shadow_predicted:
                ratio = shadow_measured / shadow_predicted
                if round(ratio) > 1 and abs(ratio - round(ratio)) < 0.05:
                    modelled["periods_per_level"] = round(ratio)
                    parts.append(f"{round(ratio)} periods per level")
            print(f"model {family:18s} " + "   ".join(parts), flush=True)
        if "liftoff" in indexed and "turbofan" in indexed:
            for kind, found in levels.items():
                report["tier_mix"][kind] = tier_mix(found, indexed["liftoff"], indexed["turbofan"])
                for family, mix in report["tier_mix"][kind].items():
                    over = mix["excess"] > TIER_MIX_MARGIN
                    print(f"tier-mix {kind:6s} {family:18s} liftoff {mix['liftoff']:6d}  turbofan {mix['turbofan']:6d}  "
                          f"worst mix {mix['worst_mix']:6d}  excess {mix['excess']:.1%}"
                          f"{'  past the lane B margin' if over else ''}")
                    if over:
                        report["over_margin"].append(f"{kind}/{family}: {mix['excess']:.1%}")
            if report["over_margin"]:
                # The report's instruction (§5, lane C): the margin by which
                # lane B's stacks sit under the real limits must cover the
                # worst mix, so a larger excess means widening that margin.
                print(f"WIDEN MARGIN: the worst per-function tier mix exceeds the {TIER_MIX_MARGIN:.1%} "
                      f"headroom of lane B's stacks for {', '.join(report['over_margin'])}")
    if args.diff:
        old = json.loads(args.diff.read_text())
        print(f"--- frame changes against {args.diff}")
        for line in diff(old, report, args.top):
            print(line)
    if args.output:
        common.write_json(args.output, report)
    for problem in report["problems"]:
        print(f"FAIL: {problem}")
    # Trend only: the numbers are the deliverable. Only a collector that read
    # nothing fails the run.
    return 1 if report["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
