#!/usr/bin/env python3
"""Compare regexp code identity and timing against a repository revision."""
import argparse
import hashlib
import io
import json
import math
import platform
import statistics
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENGINE = REPO / "rust/engine"
DRIVER = ENGINE / "benches/regexp_validation.rs"
FLAGS = ["--edition=2021", "-C", "opt-level=3", "-C", "overflow-checks=yes"]


def run(*args):
    return subprocess.check_output(args, cwd=REPO, text=True).strip()


def build(folder, regexp_src, meter, validation):
    library = folder / "libironhorse_regexp.rlib"
    run("rustc", *FLAGS, "--crate-type", "rlib", "--crate-name", "ironhorse_regexp",
        "--extern", f"ironhorse_meter={meter}", regexp_src / "lib.rs", "-o", library)
    probe = folder / "probe"
    run("rustc", *FLAGS, *(["--cfg", "validation_api"] if validation else []),
        "-L", f"dependency={meter.parent}", "--extern", f"ironhorse_regexp={library}",
        DRIVER, "-o", probe)
    return probe


def candidate_hashes():
    sources = sorted((ENGINE / "ironhorse-regexp/src").rglob("*.rs"))
    sources += sorted((ENGINE / "ironhorse-meter/src").rglob("*.rs"))
    sources += [DRIVER, Path(__file__).resolve(), ENGINE / "ironhorse-compile/src/lexer.rs",
                ENGINE / "ironhorse-vm/src/lib.rs"]
    return {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sources}


def measure(args):
    baseline = run("git", "rev-parse", args.baseline)
    candidate_parent = run("git", "rev-parse", "HEAD")
    inputs = candidate_hashes()
    with tempfile.TemporaryDirectory(prefix="ironhorse-regexp-validation-") as temporary:
        root = Path(temporary)
        before, after = root / "before", root / "after"
        before.mkdir()
        after.mkdir()
        archive = subprocess.check_output([
            "git", "archive", baseline, "rust/engine/ironhorse-regexp/src",
            "rust/engine/ironhorse-meter/src"], cwd=REPO)
        with tarfile.open(fileobj=io.BytesIO(archive)) as files:
            files.extractall(before, filter="data")
        meter_source = before / "rust/engine/ironhorse-meter/src"
        baseline_meter = {str(path.relative_to(meter_source)): path.read_bytes()
                          for path in meter_source.rglob("*.rs")}
        current_meter_source = ENGINE / "ironhorse-meter/src"
        current_meter = {str(path.relative_to(current_meter_source)): path.read_bytes()
                         for path in current_meter_source.rglob("*.rs")}
        if baseline_meter != current_meter:
            raise RuntimeError("This comparison requires identical meter sources")
        meter = before / "libironhorse_meter.rlib"
        run("rustc", *FLAGS, "--crate-type", "rlib", "--crate-name", "ironhorse_meter",
            before / "rust/engine/ironhorse-meter/src/lib.rs", "-o", meter)
        old = build(before, before / "rust/engine/ironhorse-regexp/src", meter, False)
        new = build(after, ENGINE / "ironhorse-regexp/src", meter, True)
        old_snapshot = run(old, "snapshot")
        new_snapshot = run(new, "snapshot")
        if old_snapshot != new_snapshot:
            raise RuntimeError("Compiled programs, metadata, errors, or raw totals changed")
        names = run(old, "cases").splitlines()
        modes = [("before_compile", old, "compile"),
                 ("after_compile", new, "compile"),
                 ("after_validate", new, "validate")]
        results = {}
        for name in names:
            single = int(run(old, "compile", name, "1"))
            iterations = max(20, min(10000, math.ceil(args.target_ms * 1_000_000 / single)))
            samples = {mode: [] for mode, _, _ in modes}
            for sample in range(args.samples):
                # Rotate order so no mode always receives the warmest CPU.
                start = sample % len(modes)
                for mode, binary, operation in modes[start:] + modes[:start]:
                    elapsed = int(run(binary, operation, name, str(iterations)))
                    samples[mode].append(elapsed / iterations)
            medians = {mode: statistics.median(values) for mode, values in samples.items()}
            results[name] = {
                "iterations_per_sample": iterations,
                "nanoseconds_per_operation": samples,
                "median_nanoseconds": medians,
                "compile_ratio": medians["after_compile"] / medians["before_compile"],
                "validate_ratio": medians["after_validate"] / medians["before_compile"],
            }
        if inputs != candidate_hashes() or candidate_parent != run("git", "rev-parse", "HEAD"):
            raise RuntimeError("Candidate inputs changed during compilation or measurement")
        return {
            "scope": "F152 validation only; does not replace the full 1A performance gate",
            "baseline_commit": baseline,
            "candidate_parent": candidate_parent,
            "candidate_source_sha256": inputs,
            "input_hashes_verified_unchanged": True,
            "meter_sources_identical": True,
            "utc": datetime.now(timezone.utc).isoformat(),
            "platform": platform.platform(), "machine": platform.machine(),
            "rustc": run("rustc", "--version"), "rustc_flags": FLAGS,
            "samples_per_mode": args.samples, "target_milliseconds_requested": args.target_ms,
            "minimum_iterations": 20, "maximum_iterations": 10000,
            "warmups_per_process": 5,
            "program_snapshot_equal": True,
            "program_snapshot_sha256": hashlib.sha256(old_snapshot.encode()).hexdigest(),
            "program_snapshot_bytes": len(old_snapshot.encode()),
            "results": results,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=11)
    parser.add_argument("--target-ms", type=int, default=30)
    args = parser.parse_args()
    if args.samples < 1 or args.target_ms < 1:
        parser.error("samples and target-ms must be positive")
    report = measure(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    for name, result in report["results"].items():
        print(f"{name}: compile {result['compile_ratio']:.3f}x; validate {result['validate_ratio']:.3f}x")


if __name__ == "__main__":
    main()
