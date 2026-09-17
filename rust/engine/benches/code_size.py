#!/usr/bin/env python3
"""Measure the engine's code size against XS's, the stage-8 envelope's second bar.

The design states the footprint half of the envelope as "heap within 1.1x, code
size within 2x of `libxs.a`". Until this script the code-size clause had no
instrument at all, so it was not merely unmet but unmeasured, and the XS
microbenchmark report listed "engine code size" among the things that keep the
full envelope unavailable (architecture findings F106/F122).

**What is compared.** Static library text against static library text, which is
what the bar names. The XS side is the `.text` of the Moddable XS translation
units inside `libxsoracle.a`, with this repository's own `xs_shim` object
excluded — the shim is the oracle harness, not XS. The engine side is the
`.text` of the release rlibs of the crates that make up the engine proper.

**What that measurement is and is not.** An rlib carries every monomorphized
instantiation the crate emitted, including ones a linker would discard from a
final binary, so this number is an upper bound on what the engine contributes
to a linked artifact. It is still the honest like-for-like reading of the bar
as written, and an upper bound is the right side to be conservative on for a
ceiling. A linked-binary comparison would need an XS host binary to link
against, which this repository does not build.

Run:

    python3 rust/engine/benches/code_size.py --check-code-size
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# The crates that are the engine. `xs-oracle`, `ironhorse-262` and
# `ironhorse-fuzz` are harness, not engine, and `ironhorse-snapshot` is the
# persistence seam rather than the interpreter — included, because a shipped
# engine carries it.
ENGINE_CRATES = (
    "ironhorse_vm",
    "ironhorse_compile",
    "ironhorse_regexp",
    "ironhorse_snapshot",
    "ironhorse_text",
    "ironhorse_unicode",
    "ironhorse_meter",
)

# The design's bar, as written.
CODE_SIZE_LIMIT = 2.0


def text_bytes(archive: Path, exclude: tuple[str, ...] = ()) -> int:
    """Total `.text` across the object files in `archive`."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["ar", "x", str(archive)], cwd=tmp, check=True)
        objects = [p for p in Path(tmp).iterdir() if p.suffix == ".o"]
        objects = [p for p in objects if not any(m in p.name for m in exclude)]
        if not objects:
            raise ValueError(f"no object files in {archive}")
        out = subprocess.run(
            ["size", "-A"] + [str(p) for p in objects],
            check=True, text=True, stdout=subprocess.PIPE,
        ).stdout
    total = 0
    for line in out.splitlines():
        # Both sides are built with `-ffunction-sections` / Rust's equivalent,
        # so the code lives in per-symbol `.text.<name>` sections and the bare
        # `.text` section is empty. Summing only `.text` would report zero for
        # every object; the prefix match is the measurement.
        match = re.match(r"^\.text\S*\s+(\d+)", line)
        if match:
            total += int(match.group(1))
    if total <= 0:
        raise ValueError(f"no .text measured in {archive}")
    return total


def newest(pattern: str, where: Path) -> Path:
    matches = sorted(where.glob(pattern), key=lambda p: p.stat().st_mtime)
    if not matches:
        raise FileNotFoundError(f"no {pattern} under {where}; build --release first")
    return matches[-1]


def measure() -> dict:
    target = ROOT / "target" / "release"
    xs_archive = newest("build/xs-oracle-*/out/libxsoracle.a", target)
    # `xs_shim` is this repository's oracle harness, not XS.
    xs = text_bytes(xs_archive, exclude=("xs_shim",))

    engine = {}
    for crate in ENGINE_CRATES:
        rlib = newest(f"deps/lib{crate}-*.rlib", target)
        engine[crate] = text_bytes(rlib)
    engine_total = sum(engine.values())

    ratio = engine_total / xs
    return {
        "xs_text_bytes": xs,
        "xs_archive": str(
            xs_archive.relative_to(ROOT) if xs_archive.is_relative_to(ROOT) else xs_archive
        ),
        "engine_text_bytes": engine_total,
        "engine_by_crate": engine,
        "ratio": ratio,
        "limit": CODE_SIZE_LIMIT,
        "within_code_size_limit": ratio <= CODE_SIZE_LIMIT,
        "measurement": "static-library .text, an upper bound on a linked artifact",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument(
        "--check-code-size",
        action="store_true",
        help="exit nonzero when the engine exceeds the design's 2x bar",
    )
    args = parser.parse_args()

    for tool in ("ar", "size"):
        if shutil.which(tool) is None:
            print(f"error: {tool} is not on PATH", file=sys.stderr)
            return 2

    report = measure()
    text = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(text + "\n")
    print(text)

    if args.check_code_size and not report["within_code_size_limit"]:
        print(
            f"::error::engine code size is {report['ratio']:.2f}x XS, above the "
            f"design's {CODE_SIZE_LIMIT}x bar",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
