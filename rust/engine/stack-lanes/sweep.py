#!/usr/bin/env python3
"""The grammar sweep of STACK-DEPTH-REFACTOR.md §5, lane C: every production
whose parser loop folds operands into a deep tree, and every right-nested
production, bisected natively to the largest depth the compiler accepts.

Each shape is compiled by the native probe (`source --compile-only`). The
report names the shapes the corpus already pins (`cases.rs` CHAINS); this
sweep covers the rest of the grammar so that any production without a
ceiling, or with one that a host stack could not hold, is found before it
is hit. A shape with no ceiling below MAX_DEPTH is a finding: recursion the
compiler does not bound.

A shape with no ceiling is measured for stack growth with the probe's
`--stack` painter: a flat list costs no stack per operand and is not a
finding; growing stack without a ceiling is.

Output: one line per shape with its ceiling and the refusal past it, and a
JSON report with `--output`. `--check` fails when a shape's ceiling differs
from the one recorded in sweep-pins.json (write it with `--write-pins`).
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import common  # noqa: E402

PINS = common.LANES / "sweep-pins.json"
MAX_DEPTH = 8192


def wrapped(open_, core, close, n):
    return f"{open_ * n}{core}{close * n}"


# name -> (kind, template). kind: "fold" (a loop folds operands into a deep
# left-nested tree) or "nest" (right-nested or wrapped).
SHAPES = {
    # Binary operators by precedence class, each folded into a left spine.
    "subtract": ("fold", lambda n: "1" + "-1" * n),
    "multiply": ("fold", lambda n: "1" + "*1" * n),
    "divide": ("fold", lambda n: "1" + "/1" * n),
    "modulo": ("fold", lambda n: "1" + "%1" * n),
    "exponent": ("nest", lambda n: "1" + "**1" * n),
    "bit-and": ("fold", lambda n: "1" + "&1" * n),
    "bit-or": ("fold", lambda n: "1" + "|1" * n),
    "bit-xor": ("fold", lambda n: "1" + "^1" * n),
    "shift-left": ("fold", lambda n: "1" + "<<1" * n),
    "shift-right": ("fold", lambda n: "1" + ">>1" * n),
    "shift-right-unsigned": ("fold", lambda n: "1" + ">>>1" * n),
    "greater": ("fold", lambda n: "a" + " > a" * n),
    "less-equal": ("fold", lambda n: "a" + " <= a" * n),
    "equal": ("fold", lambda n: "a" + " == a" * n),
    "strict-equal": ("fold", lambda n: "a" + " === a" * n),
    "not-equal": ("fold", lambda n: "a" + " != a" * n),
    "in": ("fold", lambda n: "a" + " in a" * n),
    "instanceof": ("fold", lambda n: "a" + " instanceof a" * n),
    "comma": ("fold", lambda n: "1" + ",1" * n),
    "compound-assign": ("nest", lambda n: "a" + " += a" * n),
    "logical-assign": ("nest", lambda n: "a" + " ||= a" * n),
    # Unary and prefix chains.
    "not": ("nest", lambda n: "!" * n + "a"),
    "negate": ("nest", lambda n: "- " * n + "a"),
    "plus": ("nest", lambda n: "+ " * n + "a"),
    "bit-not": ("nest", lambda n: "~" * n + "a"),
    "void": ("nest", lambda n: "void " * n + "a"),
    "delete": ("nest", lambda n: "delete " * n + "a"),
    "await": ("nest", lambda n: "async function f() { return " + "await " * n + "a; }"),
    "yield": ("nest", lambda n: "function* f() { return " + "yield " * n + "a; }"),
    # Member, call and template shapes not in the pinned set.
    "optional-call": ("fold", lambda n: "a" + "?.()" * n),
    "call-then-member": ("fold", lambda n: "a" + ".b()" * n),
    "new-with-args": ("nest", lambda n: wrapped("new f(", "1", ")", n)),
    "template-nested": ("nest", lambda n: wrapped("`${", "1", "}`", n)),
    "tagged-with-substitution": ("fold", lambda n: "f" + "`${1}`" * n),
    "spread-array": ("nest", lambda n: wrapped("[...", "a", "]", n)),
    "spread-call": ("nest", lambda n: wrapped("f(...", "a", ")", n)),
    "arrow-chain": ("nest", lambda n: "a => " * n + "1"),
    "arrow-block": ("nest", lambda n: wrapped("() => { return ", "1", "; }", n)),
    "function-in-call": ("nest", lambda n: wrapped("f(function () { return ", "1", "; })", n)),
    "class-extends": ("nest", lambda n: "(" + wrapped("class extends (", "Object", ") {}", n) + ")"),
    "object-pattern": ("nest", lambda n: "var " + wrapped("{a:", "a", "}", n) + " = x"),
    "default-params": ("nest", lambda n: "function f(a = " + wrapped("(function (b = ", "1", ") {})", n) + ") {}"),
    # Statement nesting not in the pinned set.
    "try": ("nest", lambda n: wrapped("try { ", "", " } catch (e) {}", n)),
    "switch": ("nest", lambda n: wrapped("switch (a) { case 1: ", "", " }", n)),
    "for": ("nest", lambda n: wrapped("for (;;) { ", "break;", " }", n)),
    "while": ("nest", lambda n: wrapped("while (a) { ", "", " }", n)),
    "do-while": ("nest", lambda n: wrapped("do { ", "", " } while (a);", n)),
    "with": ("nest", lambda n: wrapped("with (a) { ", "", " }", n)),
    "if-no-block": ("nest", lambda n: "if (a) " * n + "x;"),
    "labeled-block": ("nest", lambda n: "".join(f"l{i}: {{ " for i in range(n)) + " }" * n),
    "class-static-block": ("nest", lambda n: wrapped("(class { static { ", "", " } })", n)),
    "object-getter": ("nest", lambda n: "(" + wrapped("{ get a() { return ", "1", "; } }", n) + ")"),
    "async-arrow": ("nest", lambda n: "async () => " * n + "1"),
    "regexp-groups": ("nest", lambda n: "/" + wrapped("(", "a", ")", n) + "/"),
    "regexp-class-v": ("nest", lambda n: "/" + wrapped("[", "a", "]", n) + "/v"),
}


def accepted(probe, shape, n):
    source = SHAPES[shape][1](n)
    outcome = common.run_native(probe, ["source", "--compile-only"], stdin=source)
    if outcome.trapped or outcome.timed_out:
        raise SystemExit(f"{shape} at {n}: the native probe did not answer: {outcome.trap}")
    return outcome.line.startswith("compile=ok"), outcome.line


def compile_stack(probe, shape, n):
    """The compile stage's native high-water mark at depth n, in bytes."""
    source = SHAPES[shape][1](n)
    outcome = common.run_native(probe, ["source", "--compile-only", "--stack"], stdin=source)
    return int(outcome.line.rsplit("stack=", 1)[1])


def slope(probe, shape, low=MAX_DEPTH // 2, high=MAX_DEPTH):
    """Bytes of compile stack per level between two depths: zero for a shape
    the parser folds into a flat list, positive for one it recurses over."""
    return (compile_stack(probe, shape, high) - compile_stack(probe, shape, low)) / (high - low)


def ceiling(probe, shape):
    """Largest accepted depth below MAX_DEPTH, or None when MAX_DEPTH is accepted."""
    ok, _ = accepted(probe, shape, 1)
    if not ok:
        return 0, accepted(probe, shape, 1)[1]
    low, step = 1, 64
    high = None
    while high is None:
        if step > MAX_DEPTH:
            ok, _ = accepted(probe, shape, MAX_DEPTH)
            if ok:
                return None, "accepted at MAX_DEPTH"
            high = MAX_DEPTH
            break
        ok, _ = accepted(probe, shape, step)
        if ok:
            low, step = step, step * 2
        else:
            high = step
    while high - low > 1:
        mid = (low + high) // 2
        ok, _ = accepted(probe, shape, mid)
        if ok:
            low = mid
        else:
            high = mid
    return low, accepted(probe, shape, low + 1)[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shape", action="append")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--write-pins", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--no-build", action="store_true")
    args = parser.parse_args()
    for shape in args.shape or ():
        if shape not in SHAPES:
            parser.error(f"unknown shape: {shape}")
    probe = build_probe.artifact() if args.no_build else build_probe.build(quiet=True)
    pins = common.load_json(PINS, {"pins": {}})["pins"]
    results = {}
    problems = []
    for shape, (kind, _) in SHAPES.items():
        if args.shape and shape not in args.shape:
            continue
        found, past = ceiling(probe, shape)
        results[shape] = {"kind": kind, "ceiling": found, "past": past}
        if "stack overflow" in past:
            note = "  parser guard"
        elif "RegExp" in past or "Lex(" in past:
            note = "  regexp guard"
        else:
            note = "  UNGUARDED refusal"
        if found == 0:
            problems.append(f"{shape}: refused at depth 1 ({past[:80]}); the template is not valid JS")
        if found is None:
            per_level = slope(probe, shape)
            results[shape]["bytes_per_level"] = per_level
            if per_level < 1:
                note = f"  no ceiling; flat ({per_level:.2f} B per level): a list, not recursion"
            else:
                note = f"  NO CEILING and {per_level:.0f} B per level: unbounded recursion"
                problems.append(f"{shape}: accepted at {MAX_DEPTH} with {per_level:.0f} B of stack per level; "
                                "the compiler does not bound it")
        print(f"{shape:26s} {kind:4s} ceiling {str(found):>6s}  past: {past[:70]}{note}", flush=True)
        if args.check and shape in pins and pins[shape] != found:
            problems.append(f"{shape}: ceiling {found}, sweep-pins.json records {pins[shape]}")
        if args.check and shape not in pins:
            problems.append(f"{shape}: not in sweep-pins.json; run --write-pins")
    if args.write_pins:
        common.write_json(PINS, {"pins": {**pins, **{s: r["ceiling"] for s, r in results.items()}}})
        print(f"wrote {PINS}")
    if args.output:
        common.write_json(args.output, {"max_depth": MAX_DEPTH, "shapes": results, "problems": problems})
    for problem in problems:
        print(f"FAIL: {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
